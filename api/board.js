'use strict';

const { Redis } = require('@upstash/redis');
const { list } = require('@vercel/blob');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// Clave principal del tablero (eventos serializados)
const EVENTS_KEY = 'rifa:board:events';

/*
  El tablero se guarda como una lista de "eventos" (apartar, editar, liberar),
  serializados como un arreglo JSON en una sola clave de Redis (Upstash).

  Antes cada cambio reescribía un único archivo con el tablero completo; si dos
  personas lo usaban a la vez, una lectura un poco vieja hacía que un apartado
  borrara a los demás. Con eventos eso no puede pasar: el estado se arma
  leyendo todos los eventos en orden.
*/

const EVENTS = 'ev/';
const LEGACY = 'snap/';
const MAX = 1000;
const TOTAL = 100;
const NAME_MAX = 40;
const PHONE_MAX = 20;

function send(res, code, data) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function unb64(value) {
  try { return Buffer.from(value, 'base64url').toString('utf8'); }
  catch (e) { return ''; }
}

// ev/1795047972570.c.27.eyJuIjoiSmFpbWUiLCJwIjoiIn0.json
function eventName(action, num, name, phone, ts, paid) {
  let payload;
  if (action === 'release') payload = b64(JSON.stringify({}));
  else if (action === 'paid') payload = b64(JSON.stringify({ v: !!paid }));
  else payload = b64(JSON.stringify({ n: name, p: phone }));

  const code = action === 'claim' ? 'c' : action === 'edit' ? 'e' : action === 'paid' ? 'p' : 'r';
  return EVENTS + ts + '.' + code + '.' + num + '.' + payload + '.json';
}

function parseEvent(pathname) {
  const parts = pathname.slice(EVENTS.length).split('.');
  const ts = Number(parts[0]) || 0;
  const code = parts[1];
  const action = code === 'c' ? 'claim' : code === 'e' ? 'edit' : code === 'p' ? 'paid' : 'release';
  const num = parts[2] || '';
  let name = '';
  let phone = '';
  let paid = false;

  if (action !== 'release') {
    try {
      const data = JSON.parse(unb64(parts[3] || ''));
      name = String(data.n || '');
      phone = String(data.p || '');
      paid = !!data.v;
    } catch (e) { /* evento ilegible */ }
  }

  return { ts, action, num, name, phone, paid, sort: pathname };
}

async function readEvents() {
  const raw = await redis.get(EVENTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* se rehidrata desde el store anterior */ }
  }

  // Si aún no existe en la nueva tienda, hidrata desde el store anterior
  // (ese se sigue leyendo aunque esté suspendido; solo se escriben eventos nuevos).
  const seeded = await seedFromBlobs().catch(function (e) { return []; });
  if (seeded.length) {
    try { await redis.set(EVENTS_KEY, JSON.stringify(seeded)); } catch (e) { /* se reintenta al leer */ }
  }
  return seeded;
}

async function seedFromBlobs() {
  const { blobs } = await list({ prefix: EVENTS, limit: MAX });
  const found = (blobs || [])
    .filter(function (b) { return String(b.pathname || '').indexOf(EVENTS) === 0; })
    .map(function (b) { return parseEvent(b.pathname); })
    .filter(function (e) { return /^\d{2}$/.test(e.num) && e.ts > 0; })
    .sort(function (a, b) { return a.ts - b.ts || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0); });
  return found;
}

async function eventList(attempt) {
  attempt = attempt || 1;
  const events = await readEvents();
  const found = events
    .filter(function (e) { return /^\d{2}$/.test(e.num) && e.ts > 0; })
    .sort(function (a, b) { return a.ts - b.ts || (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0); });

  if (!found.length && attempt < 3) {
    await new Promise(function (done) { setTimeout(done, 250); });
    return eventList(attempt + 1);
  }
  return found;
}

function replay(events) {
  const sold = {};

  events.forEach(function (e) {
    if (e.action === 'claim') {
      // El primero que apartó el número es el que queda
      if (!sold[e.num] && e.name) {
        sold[e.num] = { name: e.name, phone: e.phone, ts: e.ts, paid: false };
      }
    } else if (e.action === 'edit') {
      if (sold[e.num] && e.name) {
        sold[e.num] = { name: e.name, phone: e.phone, ts: sold[e.num].ts, paid: !!sold[e.num].paid };
      }
    } else if (e.action === 'paid') {
      if (sold[e.num]) sold[e.num].paid = e.paid;
    } else if (sold[e.num]) {
      delete sold[e.num];
    }
  });

  return { sold, updatedAt: events.length ? events[events.length - 1].ts : 0 };
}

// Solo por si el tablero aún no tiene eventos (versión anterior)
async function readLegacy() {
  try {
    const { blobs } = await list({ prefix: LEGACY, limit: MAX });
    if (!blobs.length) return { sold: {}, updatedAt: 0 };

    const newest = blobs.sort(function (a, b) {
      return Number(b.pathname.slice(LEGACY.length).split('-')[0]) - Number(a.pathname.slice(LEGACY.length).split('-')[0]);
    })[0];

    const response = await fetch(newest.url, { cache: 'no-store' });
    if (!response.ok) return { sold: {}, updatedAt: 0 };
    const data = await response.json();
    return {
      sold: data && data.sold && typeof data.sold === 'object' ? data.sold : {},
      updatedAt: Number(data && data.updatedAt) || 0
    };
  } catch (e) {
    return { sold: {}, updatedAt: 0 };
  }
}

async function readBoard() {
  const events = await eventList();
  if (!events.length) return { sold: {}, updatedAt: 0 };
  return replay(events);
}

async function writeEvent(action, num, name, phone, paid) {
  const ts = Date.now();
  const cleanNum = String(num == null ? '' : num).trim().padStart(2, '0');
  const cleanAction = action === 'claim' ? 'c' : action === 'edit' ? 'e' : action === 'paid' ? 'p' : 'r';
  const sort = EVENTS + ts + '.' + cleanAction + '.' + cleanNum;

  const events = await readEvents();
  events.push({
    ts: ts,
    action: action,
    num: cleanNum,
    name: String(name == null ? '' : name),
    phone: String(phone == null ? '' : phone),
    paid: !!paid,
    sort: sort
  });
  await redis.set(EVENTS_KEY, JSON.stringify(events));

  return { action: action, num: cleanNum, name: String(name == null ? '' : name), phone: String(phone == null ? '' : phone), paid: !!paid, ts: ts, sort: sort };
}

// El estado de pago solo lo ve el administrador
function isAdmin(pin) {
  const expected = clean(process.env.ADMIN_PIN, 30);
  if (!expected) return false;
  const given = clean(pin, 30);
  return given.length > 0 && given === expected;
}

function publicBoard(board, admin) {
  if (admin) return board;

  const sold = {};
  Object.keys(board.sold || {}).forEach(function (num) {
    const item = board.sold[num] || {};
    sold[num] = { name: item.name, phone: item.phone, ts: item.ts };
  });

  return { sold, updatedAt: board.updatedAt };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const board = await readBoard();
      const admin = isAdmin(req.query && req.query.pin);
      return send(res, 200, { ok: true, admin, board: publicBoard(board, admin) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { ok: false, error: 'method' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body && typeof body === 'object' ? body : {};

    const action = clean(body.action, 12);
    const num = String(body.num == null ? '' : body.num).trim().padStart(2, '0');

    if (!/^\d{2}$/.test(num) || Number(num) >= TOTAL) {
      return send(res, 400, { ok: false, error: 'number' });
    }
    if (!['claim', 'edit', 'release', 'paid'].includes(action)) {
      return send(res, 400, { ok: false, error: 'action' });
    }
    if ((action === 'release' || action === 'paid' || action === 'edit') && !isAdmin(body.pin)) {
      return send(res, 401, { ok: false, error: 'admin' });
    }

    const sold = (await readBoard()).sold;

    if (action === 'claim' && sold[num]) {
      return send(res, 409, { ok: false, error: 'taken', board: { sold, updatedAt: Date.now() } });
    }
    if (action !== 'claim' && !sold[num]) {
      return send(res, 404, { ok: false, error: 'missing' });
    }

    const name = action === 'release' || action === 'paid'
      ? ''
      : clean(body.name, NAME_MAX).replace(/\s+/g, ' ');
    if (action !== 'release' && action !== 'paid' && name.length < 2) {
      return send(res, 400, { ok: false, error: 'name' });
    }

    const paid = !!body.paid;
    const event = await writeEvent(
      action,
      num,
      name,
      action === 'release' || action === 'paid' ? '' : clean(body.phone, PHONE_MAX),
      paid
    );

    // Si otra persona apartó el mismo número primero, manda el más antiguo
    if (action === 'claim') {
      const after = await readBoard();
      const owner = after.sold[num];
      if (owner && owner.ts !== event.ts) {
        return send(res, 409, { ok: false, error: 'taken', board: publicBoard(after, false) });
      }
    }

    // Se responde con el estado ya aplicado
    if (event.action === 'claim') {
      sold[num] = { name: event.name, phone: event.phone, ts: event.ts, paid: false };
    } else if (event.action === 'edit') {
      sold[num] = { name: event.name, phone: event.phone, ts: sold[num].ts, paid: !!sold[num].paid };
    } else if (event.action === 'paid') {
      if (sold[num]) sold[num].paid = event.paid;
    } else {
      delete sold[num];
    }

    const admin = isAdmin(body.pin);
    return send(res, 200, { ok: true, admin, board: publicBoard({ sold, updatedAt: event.ts }, admin) });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'server', message: String((err && err.message) || err) });
  }
};

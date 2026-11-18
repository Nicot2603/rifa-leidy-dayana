'use strict';

const { put, list } = require('@vercel/blob');

// El tablero se guarda como "snapshots" inmutables: cada cambio escribe un
// archivo nuevo con nombre único. Así nunca se lee una versión vieja desde el
// CDN (Vercel Blob cachea las URLs públicas durante 60 s y al sobrescribir un
// archivo se seguía viendo el contenido anterior).
const PREFIX = 'snap/';
const LEGACY = 'board.json';
const MAX_SNAPSHOTS = 1000;
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

function normalize(data) {
  return {
    sold: data && typeof data.sold === 'object' && data.sold ? data.sold : {},
    updatedAt: Number(data && data.updatedAt) || 0
  };
}

function snapshotTime(blob) {
  const name = blob.pathname.slice(PREFIX.length);
  return Number(name.split('-')[0]) || 0;
}

// Devuelve los snapshots del más nuevo al más viejo
async function snapshots() {
  const { blobs } = await list({ prefix: PREFIX, limit: MAX_SNAPSHOTS });
  return blobs
    .map(function (b) { return { url: b.url, at: snapshotTime(b) }; })
    .sort(function (a, b) { return b.at - a.at; });
}

async function readUrl(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return null;
  return normalize(await response.json());
}

async function readBoard() {
  const found = await snapshots();

  for (const snap of found.slice(0, 3)) {
    const board = await readUrl(snap.url);
    if (board) return board;
  }

  return readLegacy();
}

// Compatibilidad con el primer formato (un solo archivo sobrescrito)
async function readLegacy() {
  try {
    const { blobs } = await list({ prefix: LEGACY, limit: 10 });
    const found = blobs.find(function (b) { return b.pathname === LEGACY; });
    if (!found) return { sold: {}, updatedAt: 0 };
    const board = await readUrl(found.url);
    return board || { sold: {}, updatedAt: 0 };
  } catch (e) {
    return { sold: {}, updatedAt: 0 };
  }
}

async function writeBoard(sold) {
  const board = { sold, updatedAt: Date.now() };
  const name = PREFIX + board.updatedAt + '-' + Math.random().toString(36).slice(2, 8) + '.json';

  await put(name, JSON.stringify(board), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json'
  });

  return board;
}

// Serializa las escrituras dentro de la misma instancia
let chain = Promise.resolve();
function lock(task) {
  const next = chain.then(task, task);
  chain = next.then(function () {}, function () {});
  return next;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const board = await readBoard();
      return send(res, 200, { ok: true, board });
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
    if (!['claim', 'edit', 'release'].includes(action)) {
      return send(res, 400, { ok: false, error: 'action' });
    }

    return await lock(async () => {
      const sold = (await readBoard()).sold;

      if (action === 'claim') {
        if (sold[num]) {
          return send(res, 409, { ok: false, error: 'taken', board: { sold, updatedAt: Date.now() } });
        }
        const name = clean(body.name, NAME_MAX).replace(/\s+/g, ' ');
        if (name.length < 2) return send(res, 400, { ok: false, error: 'name' });
        sold[num] = { name, phone: clean(body.phone, PHONE_MAX), ts: Date.now() };
      } else if (action === 'edit') {
        if (!sold[num]) return send(res, 404, { ok: false, error: 'missing' });
        const name = clean(body.name, NAME_MAX).replace(/\s+/g, ' ');
        if (name.length < 2) return send(res, 400, { ok: false, error: 'name' });
        sold[num] = { name, phone: clean(body.phone, PHONE_MAX), ts: sold[num].ts || Date.now() };
      } else {
        if (!sold[num]) return send(res, 404, { ok: false, error: 'missing' });
        delete sold[num];
      }

      const board = await writeBoard(sold);
      return send(res, 200, { ok: true, board });
    });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'server', message: String((err && err.message) || err) });
  }
};

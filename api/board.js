'use strict';

const { put, list } = require('@vercel/blob');

const PATHNAME = 'board.json';
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

async function readBoard() {
  const { blobs } = await list({ prefix: PATHNAME, limit: 10 });
  const found = blobs.find((b) => b.pathname === PATHNAME);
  if (!found) return { sold: {}, updatedAt: 0 };

  const url = found.url + (found.url.includes('?') ? '&' : '?') + 'v=' + Date.now();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('No se pudo leer el tablero');

  const data = await response.json();
  return {
    sold: data && typeof data.sold === 'object' && data.sold ? data.sold : {},
    updatedAt: Number(data && data.updatedAt) || 0
  };
}

async function writeBoard(sold) {
  const board = { sold, updatedAt: Date.now() };
  await put(PATHNAME, JSON.stringify(board), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
  return board;
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
    } else if (action === 'release') {
      if (!sold[num]) return send(res, 404, { ok: false, error: 'missing' });
      delete sold[num];
    } else {
      return send(res, 400, { ok: false, error: 'action' });
    }

    const board = await writeBoard(sold);
    return send(res, 200, { ok: true, board });
  } catch (err) {
    return send(res, 500, { ok: false, error: 'server', message: String((err && err.message) || err) });
  }
};

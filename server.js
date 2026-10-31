// Boobo – minimal breastfeeding tracker backend.
// Node.js >= 22.13 (built for 24), ESM, no npm dependencies.
// Contract: docs/API.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = readVersion();

const SIDES = new Set(['left', 'right', 'both', 'bottle']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const INTERVAL_MIN = 30;
const INTERVAL_MAX = 720;
const FEEDS_LIMIT_DEFAULT = 50;
const FEEDS_LIMIT_MAX = 500;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// Parse a client-supplied date string; returns normalized ISO UTC string or throws 400.
function parseAt(value, fieldName = 'at') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${fieldName} must be an ISO-8601 date string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new HttpError(400, `${fieldName} is not a valid date`);
  }
  if (ms > Date.now() + MAX_FUTURE_MS) {
    throw new HttpError(400, `${fieldName} must not be more than 5 minutes in the future`);
  }
  return new Date(ms).toISOString();
}

const dtfCache = new Map();
function dateTimeFormat(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

// Wall-clock components of `date` in `timeZone`.
function wallClockParts(date, timeZone) {
  const out = {};
  for (const { type, value } of dateTimeFormat(timeZone).formatToParts(date)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

// Offset (ms) of timeZone relative to UTC at the given instant.
function tzOffsetMs(instantMs, timeZone) {
  const p = wallClockParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instantMs;
}

// Instant of the most recent local midnight in timeZone, as a Date (UTC).
function localMidnight(now, timeZone) {
  const p = wallClockParts(now, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let midnight = guess - tzOffsetMs(guess, timeZone);
  // Re-check in case a DST transition lies between the guess and the result.
  const offset2 = tzOffsetMs(midnight, timeZone);
  if (midnight !== guess - offset2) midnight = guess - offset2;
  return new Date(midnight);
}

function resolveTimeZone() {
  const tz = process.env.TZ || 'Europe/Berlin';
  try {
    dateTimeFormat(tz);
    return tz;
  } catch {
    return 'Europe/Berlin';
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDatabase(dataDir, defaultIntervalMinutes) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'boobo.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feeds_at ON feeds(at);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run('interval_minutes', String(defaultIntervalMinutes));
  return db;
}

function createRepo(db) {
  const stmts = {
    insert: db.prepare(
      'INSERT INTO feeds (side, at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    byId: db.prepare('SELECT * FROM feeds WHERE id = ?'),
    list: db.prepare('SELECT * FROM feeds ORDER BY at DESC, id DESC LIMIT ?'),
    listBefore: db.prepare('SELECT * FROM feeds WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?'),
    all: db.prepare('SELECT id, side, at, note FROM feeds ORDER BY at ASC, id ASC'),
    update: db.prepare('UPDATE feeds SET side = ?, at = ?, note = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM feeds WHERE id = ?'),
    last: db.prepare('SELECT * FROM feeds ORDER BY at DESC, id DESC LIMIT 1'),
    lastBreast: db.prepare(
      "SELECT side FROM feeds WHERE side != 'bottle' ORDER BY at DESC, id DESC LIMIT 1",
    ),
    countSince: db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE at >= ? AND at <= ?'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
  };

  return {
    insert(side, at, note) {
      const ts = nowIso();
      const { lastInsertRowid } = stmts.insert.run(side, at, note, ts, ts);
      return stmts.byId.get(Number(lastInsertRowid));
    },
    byId(id) {
      return stmts.byId.get(id) ?? null;
    },
    list(limit, before) {
      return before ? stmts.listBefore.all(before, limit) : stmts.list.all(limit);
    },
    all() {
      return stmts.all.all();
    },
    update(id, { side, at, note }) {
      stmts.update.run(side, at, note, nowIso(), id);
      return stmts.byId.get(id);
    },
    remove(id) {
      return stmts.remove.run(id).changes > 0;
    },
    last() {
      return stmts.last.get() ?? null;
    },
    lastBreastSide() {
      return stmts.lastBreast.get()?.side ?? null;
    },
    countBetween(fromIso, toIso) {
      return Number(stmts.countSince.get(fromIso, toIso).n);
    },
    getInterval() {
      const row = stmts.getSetting.get('interval_minutes');
      const n = Number.parseInt(row?.value ?? '', 10);
      return Number.isFinite(n) ? n : 180;
    },
    setInterval(minutes) {
      stmts.setSetting.run('interval_minutes', String(minutes));
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, extraHeaders);
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, drain the rest so the 413 response can be delivered.
        chunks.length = 0;
        req.resume();
        fail(new HttpError(413, 'Request body too large (max 64 KB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => fail(new HttpError(400, `Failed to read body: ${err.message}`)));
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return reject(new HttpError(400, 'Invalid JSON body'));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, 'JSON body must be an object'));
      }
      resolve(parsed);
    });
  });
}

function validateSide(value) {
  if (typeof value !== 'string' || !SIDES.has(value)) {
    throw new HttpError(400, `side must be one of: ${[...SIDES].join(', ')}`);
  }
  return value;
}

function validateNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'note must be a string or null');
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new HttpError(400, `note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed === '' ? null : trimmed;
}

function validateInterval(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new HttpError(400, 'interval_minutes must be an integer');
  }
  if (value < INTERVAL_MIN || value > INTERVAL_MAX) {
    throw new HttpError(400, `interval_minutes must be between ${INTERVAL_MIN} and ${INTERVAL_MAX}`);
  }
  return value;
}

function parseLimit(raw) {
  if (raw === null || raw === '') return FEEDS_LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'limit must be a positive integer');
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new HttpError(400, 'limit must be a positive integer');
  return Math.min(n, FEEDS_LIMIT_MAX);
}

function parseFeedId(raw) {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, 'Feed not found');
  return Number.parseInt(raw, 10);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function oppositeSide(side) {
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  return 'left'; // both or unknown
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function buildState(repo, timeZone) {
  const now = new Date();
  const interval = repo.getInterval();
  const last = repo.last();

  let minutesSinceLast = null;
  let nextDueAt = null;
  let minutesUntilDue = null;
  let overdue = false;

  if (last) {
    const lastMs = Date.parse(last.at);
    minutesSinceLast = Math.floor((now.getTime() - lastMs) / 60000);
    const dueMs = lastMs + interval * 60000;
    nextDueAt = new Date(dueMs).toISOString();
    minutesUntilDue = Math.floor((dueMs - now.getTime()) / 60000);
    overdue = dueMs < now.getTime();
  }

  const lastBreast = repo.lastBreastSide();
  const suggestedSide = lastBreast ? oppositeSide(lastBreast) : 'left';

  const nowIsoStr = now.toISOString();
  const midnight = localMidnight(now, timeZone).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  return {
    now: nowIsoStr,
    interval_minutes: interval,
    last: last ? { id: last.id, side: last.side, at: last.at, note: last.note } : null,
    minutes_since_last: minutesSinceLast,
    next_due_at: nextDueAt,
    minutes_until_due: minutesUntilDue,
    overdue,
    suggested_side: suggestedSide,
    today_count: repo.countBetween(midnight, nowIsoStr),
    last_24h_count: repo.countBetween(dayAgo, nowIsoStr),
  };
}

async function handleApi(req, res, url, ctx) {
  const { repo, timeZone } = ctx;
  const { method } = req;
  const p = url.pathname;

  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: VERSION, time: nowIso() });
  }

  if (p === '/api/state' && method === 'GET') {
    return sendJson(res, 200, buildState(repo, timeZone));
  }

  if (p === '/api/feeds') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const beforeRaw = url.searchParams.get('before');
      let before = null;
      if (beforeRaw !== null && beforeRaw !== '') {
        const ms = Date.parse(beforeRaw);
        if (Number.isNaN(ms)) throw new HttpError(400, 'before is not a valid date');
        before = new Date(ms).toISOString();
      }
      return sendJson(res, 200, { feeds: repo.list(limit, before) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const side = validateSide(body.side);
      const at = body.at === undefined || body.at === null ? nowIso() : parseAt(body.at);
      const note = validateNote(body.note);
      return sendJson(res, 201, { feed: repo.insert(side, at, note) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const feedMatch = /^\/api\/feeds\/([^/]+)$/.exec(p);
  if (feedMatch) {
    const id = parseFeedId(feedMatch[1]);
    if (method === 'GET') {
      const feed = repo.byId(id);
      if (!feed) throw new HttpError(404, 'Feed not found');
      return sendJson(res, 200, { feed });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const existing = repo.byId(id);
      if (!existing) throw new HttpError(404, 'Feed not found');
      const hasField = ['side', 'at', 'note'].some((k) => k in body);
      if (!hasField) throw new HttpError(400, 'Body must contain at least one of: side, at, note');
      const next = {
        side: 'side' in body ? validateSide(body.side) : existing.side,
        at: 'at' in body ? parseAt(body.at) : existing.at,
        note: 'note' in body ? validateNote(body.note) : existing.note,
      };
      return sendJson(res, 200, { feed: repo.update(id, next) });
    }
    if (method === 'DELETE') {
      if (!repo.remove(id)) throw new HttpError(404, 'Feed not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/settings') {
    if (method === 'GET') {
      return sendJson(res, 200, { interval_minutes: repo.getInterval() });
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const minutes = validateInterval(body.interval_minutes);
      repo.setInterval(minutes);
      return sendJson(res, 200, { interval_minutes: minutes });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/export.csv' && method === 'GET') {
    const lines = ['id,side,at,note'];
    for (const row of repo.all()) {
      lines.push([row.id, row.side, row.at, csvEscape(row.note)].join(','));
    }
    const csv = lines.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="boobo-export.csv"',
      'Content-Length': Buffer.byteLength(csv),
      'Cache-Control': 'no-cache',
    });
    return res.end(csv);
  }

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function cacheControlFor(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  // App-Shell immer neu prüfen, damit Updates nach einem Redeploy sofort ankommen (LAN, kleine Dateien).
  if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest') return 'no-cache';
  return 'public, max-age=86400';
}

function sendFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControlFor(filePath),
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

function statFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function handleStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Bad request path');
  }
  if (pathname.includes('\0')) throw new HttpError(400, 'Bad request path');

  const publicRoot = path.resolve(publicDir);
  const indexPath = path.join(publicRoot, 'index.html');

  // Resolve inside public/; anything escaping the root is rejected.
  const relative = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = path.resolve(publicRoot, '.' + path.sep + relative);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    throw new HttpError(403, 'Forbidden');
  }

  if (pathname === '/' || filePath === publicRoot) filePath = indexPath;

  let stat = statFile(filePath);
  if (!stat) {
    // SPA fallback: unknown extension-less paths serve index.html.
    if (path.extname(filePath) === '') {
      filePath = indexPath;
      stat = statFile(filePath);
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
  }

  sendFile(req, res, filePath, stat);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function createServer({
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  intervalMinutes = Number.parseInt(process.env.FEED_INTERVAL_MINUTES || '180', 10) || 180,
  publicDir = PUBLIC_DIR,
  log = (line) => console.log(line),
} = {}) {
  const timeZone = resolveTimeZone();
  const db = openDatabase(dataDir, intervalMinutes);
  const repo = createRepo(db);
  const ctx = { repo, timeZone };

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log(`${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });

    try {
      if (isApi) {
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') return sendEmpty(res, 204);
        await handleApi(req, res, url, ctx);
      } else {
        handleStatic(req, res, url, publicDir);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      if (status === 413) res.setHeader('Connection', 'close');
      if (isApi || status !== 404) {
        sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
    }
  });

  server.keepAliveTimeout = 5000;

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        resolve();
      });
      server.closeAllConnections?.();
    });
  }

  return { server, db, repo, timeZone, dataDir, close };
}

// ---------------------------------------------------------------------------
// Entry point (only when executed directly: `node server.js`)
// ---------------------------------------------------------------------------

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  let entry = path.resolve(process.argv[1]);
  if (entry !== self && path.extname(entry) === '' && entry + '.js' === self) entry = self;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return entry === self;
  }
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.PORT || '8099', 10) || 8099;
  const app = createServer();

  app.server.listen(port, '0.0.0.0', () => {
    console.log(
      `Boobo ${VERSION} listening on http://0.0.0.0:${port} | DATA_DIR=${path.resolve(app.dataDir)} ` +
        `| interval=${app.repo.getInterval()}min | tz=${app.timeZone}`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    const timer = setTimeout(() => {
      console.error('Forced exit after timeout');
      process.exit(1);
    }, 5000);
    timer.unref();
    app.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

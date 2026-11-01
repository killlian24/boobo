// Boobo – minimal breastfeeding tracker backend.
// Node.js >= 22.13 (built for 24), ESM, no npm dependencies.
// Contract: docs/API.md

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const DIAPER_KINDS = new Set(['wet', 'dirty']);
const DUPLICATE_MODES = new Set(['ask', 'force', 'skip']);
const DUPLICATE_MINUTES_DEFAULT = 10;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MED_DUE_WINDOW_MS = 36 * 3600 * 1000;
const MED_NAME_MAX = 60;
const MED_DOSE_MAX = 40;
const MED_MAX_PER_DAY_MIN = 1;
const MED_MAX_PER_DAY_MAX = 24;
const MED_GAP_MAX = 10080;
const MED_SEEDS = [
  { name: 'Paracetamol', dose: '1 g', max_per_day: 4, min_gap_minutes: 360 },
  { name: 'Ibuprofen', dose: '400 mg', max_per_day: 4, min_gap_minutes: 360 },
  { name: 'Magenschutz (PPI)', dose: '1 Tablette', max_per_day: 1, min_gap_minutes: 1200 },
];

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
  // Erweiterung 2: additive tables only (safe on databases that contain just feeds + settings).
  db.exec(`
    CREATE TABLE IF NOT EXISTS diapers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diapers_at ON diapers(at);
    CREATE TABLE IF NOT EXISTS medications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dose TEXT,
      max_per_day INTEGER,
      min_gap_minutes INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS med_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_med_intakes_med_at ON med_intakes(medication_id, at);
    CREATE INDEX IF NOT EXISTS idx_med_intakes_at ON med_intakes(at);
  `);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run('interval_minutes', String(defaultIntervalMinutes));
  seedMedications(db);
  return db;
}

// One-time seed of the default medications, guarded by settings.meds_seeded.
// Deleting the seeded medications later does not bring them back.
function seedMedications(db) {
  const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get('meds_seeded');
  if (marker) return;
  const ts = nowIso();
  const insert = db.prepare(
    'INSERT INTO medications (name, dose, max_per_day, min_gap_minutes, active, sort_order, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    MED_SEEDS.forEach((m, i) => {
      insert.run(m.name, m.dose, m.max_per_day, m.min_gap_minutes, i + 1, ts, ts);
    });
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('meds_seeded', '1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
    feedsNear: db.prepare('SELECT * FROM feeds WHERE at > ? AND at < ? ORDER BY at DESC, id DESC'),
    feedsAfter: db.prepare('SELECT id, side, at FROM feeds WHERE at > ? ORDER BY at ASC, id ASC'),

    diaperInsert: db.prepare(
      'INSERT INTO diapers (kind, at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    diaperById: db.prepare('SELECT * FROM diapers WHERE id = ?'),
    diaperList: db.prepare('SELECT * FROM diapers ORDER BY at DESC, id DESC LIMIT ?'),
    diaperListBefore: db.prepare(
      'SELECT * FROM diapers WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?',
    ),
    diaperAll: db.prepare('SELECT id, kind, at, note FROM diapers ORDER BY at ASC, id ASC'),
    diaperUpdate: db.prepare(
      'UPDATE diapers SET kind = ?, at = ?, note = ?, updated_at = ? WHERE id = ?',
    ),
    diaperRemove: db.prepare('DELETE FROM diapers WHERE id = ?'),
    diaperCountsAfter: db.prepare(
      'SELECT kind, COUNT(*) AS n FROM diapers WHERE at > ? GROUP BY kind',
    ),

    medAll: db.prepare('SELECT * FROM medications ORDER BY sort_order ASC, id ASC'),
    medById: db.prepare('SELECT * FROM medications WHERE id = ?'),
    medInsert: db.prepare(
      'INSERT INTO medications (name, dose, max_per_day, min_gap_minutes, active, sort_order, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM medications), ?, ?)',
    ),
    medUpdate: db.prepare(
      'UPDATE medications SET name = ?, dose = ?, max_per_day = ?, min_gap_minutes = ?, active = ?, ' +
        'sort_order = ?, updated_at = ? WHERE id = ?',
    ),
    medRemove: db.prepare('DELETE FROM medications WHERE id = ?'),
    medStats: db.prepare(
      'SELECT (SELECT MAX(at) FROM med_intakes WHERE medication_id = ?) AS last_at, ' +
        'COUNT(*) AS taken, MIN(at) AS oldest FROM med_intakes WHERE medication_id = ? AND at > ?',
    ),

    intakeInsert: db.prepare(
      'INSERT INTO med_intakes (medication_id, at, note, created_at) VALUES (?, ?, ?, ?)',
    ),
    intakeById: db.prepare(
      'SELECT id, medication_id, at, note, created_at FROM med_intakes WHERE id = ?',
    ),
    intakesNear: db.prepare(
      'SELECT id, medication_id, at, note, created_at FROM med_intakes ' +
        'WHERE medication_id = ? AND at > ? AND at < ? ORDER BY at DESC, id DESC',
    ),
    intakeList: db.prepare(
      'SELECT i.id, i.medication_id, m.name, m.dose, i.at, i.note, i.created_at ' +
        'FROM med_intakes i JOIN medications m ON m.id = i.medication_id ' +
        'WHERE (?1 IS NULL OR i.medication_id = ?1) AND (?2 IS NULL OR i.at < ?2) ' +
        'ORDER BY i.at DESC, i.id DESC LIMIT ?3',
    ),
    intakeAll: db.prepare(
      'SELECT i.id, m.name AS medication, m.dose, i.at, i.note ' +
        'FROM med_intakes i JOIN medications m ON m.id = i.medication_id ORDER BY i.at ASC, i.id ASC',
    ),
    intakeRemove: db.prepare('DELETE FROM med_intakes WHERE id = ?'),

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
    // Feed closest to `at` with |feed.at - at| < windowMinutes, or null.
    findDuplicateFeed(at, windowMinutes) {
      return nearestDuplicate(at, windowMinutes, (lo, hi) => stmts.feedsNear.all(lo, hi));
    },
    feedsAfter(fromIso) {
      return stmts.feedsAfter.all(fromIso);
    },

    // --- diapers ---
    insertDiaper(kind, at, note) {
      const ts = nowIso();
      const { lastInsertRowid } = stmts.diaperInsert.run(kind, at, note, ts, ts);
      return stmts.diaperById.get(Number(lastInsertRowid));
    },
    diaperById(id) {
      return stmts.diaperById.get(id) ?? null;
    },
    listDiapers(limit, before) {
      return before ? stmts.diaperListBefore.all(before, limit) : stmts.diaperList.all(limit);
    },
    allDiapers() {
      return stmts.diaperAll.all();
    },
    updateDiaper(id, { kind, at, note }) {
      stmts.diaperUpdate.run(kind, at, note, nowIso(), id);
      return stmts.diaperById.get(id);
    },
    removeDiaper(id) {
      return stmts.diaperRemove.run(id).changes > 0;
    },
    diaperCountsAfter(fromIso) {
      const out = { wet: 0, dirty: 0 };
      for (const row of stmts.diaperCountsAfter.all(fromIso)) {
        if (row.kind in out) out[row.kind] = Number(row.n);
      }
      return out;
    },

    // --- medications ---
    allMedications() {
      return stmts.medAll.all();
    },
    medicationById(id) {
      return stmts.medById.get(id) ?? null;
    },
    insertMedication({ name, dose, max_per_day, min_gap_minutes }) {
      const ts = nowIso();
      const { lastInsertRowid } = stmts.medInsert.run(name, dose, max_per_day, min_gap_minutes, ts, ts);
      return stmts.medById.get(Number(lastInsertRowid));
    },
    updateMedication(id, m) {
      stmts.medUpdate.run(
        m.name, m.dose, m.max_per_day, m.min_gap_minutes, m.active, m.sort_order, nowIso(), id,
      );
      return stmts.medById.get(id);
    },
    removeMedication(id) {
      return stmts.medRemove.run(id).changes > 0;
    },
    medicationStats(id, dayAgoIso) {
      return stmts.medStats.get(id, id, dayAgoIso);
    },

    // --- medication intakes ---
    insertIntake(medicationId, at, note) {
      const { lastInsertRowid } = stmts.intakeInsert.run(medicationId, at, note, nowIso());
      return stmts.intakeById.get(Number(lastInsertRowid));
    },
    findDuplicateIntake(medicationId, at, windowMinutes) {
      return nearestDuplicate(at, windowMinutes, (lo, hi) =>
        stmts.intakesNear.all(medicationId, lo, hi),
      );
    },
    listIntakes(limit, before, medicationId) {
      return stmts.intakeList.all(medicationId ?? null, before ?? null, limit);
    },
    allIntakes() {
      return stmts.intakeAll.all();
    },
    removeIntake(id) {
      return stmts.intakeRemove.run(id).changes > 0;
    },
  };
}

// Returns the row (from candidates in the open interval at ± window) whose `at` is closest to `at`.
function nearestDuplicate(at, windowMinutes, fetchBetween) {
  if (!(windowMinutes > 0)) return null;
  const t = Date.parse(at);
  const w = windowMinutes * MINUTE_MS;
  const rows = fetchBetween(new Date(t - w).toISOString(), new Date(t + w).toISOString());
  let best = null;
  let bestDiff = Infinity;
  for (const row of rows) {
    const diff = Math.abs(Date.parse(row.at) - t);
    if (diff < w && diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }
  return best;
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

function validateKind(value) {
  if (typeof value !== 'string' || !DIAPER_KINDS.has(value)) {
    throw new HttpError(400, `kind must be one of: ${[...DIAPER_KINDS].join(', ')}`);
  }
  return value;
}

function validateOnDuplicate(value) {
  if (value === undefined || value === null) return 'ask';
  if (typeof value !== 'string' || !DUPLICATE_MODES.has(value)) {
    throw new HttpError(400, `on_duplicate must be one of: ${[...DUPLICATE_MODES].join(', ')}`);
  }
  return value;
}

// `at` from a request body: missing/null → now, otherwise parseAt rules.
function bodyAt(body) {
  return body.at === undefined || body.at === null ? nowIso() : parseAt(body.at);
}

function validateMedName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'name must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MED_NAME_MAX) {
    throw new HttpError(400, `name must be 1 to ${MED_NAME_MAX} characters`);
  }
  return trimmed;
}

function validateDose(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'dose must be a string or null');
  const trimmed = value.trim();
  if (trimmed.length > MED_DOSE_MAX) {
    throw new HttpError(400, `dose must be at most ${MED_DOSE_MAX} characters`);
  }
  return trimmed === '' ? null : trimmed;
}

function validateMaxPerDay(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MED_MAX_PER_DAY_MIN ||
    value > MED_MAX_PER_DAY_MAX
  ) {
    throw new HttpError(
      400,
      `max_per_day must be an integer between ${MED_MAX_PER_DAY_MIN} and ${MED_MAX_PER_DAY_MAX} or null`,
    );
  }
  return value;
}

function validateMinGap(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MED_GAP_MAX) {
    throw new HttpError(400, `min_gap_minutes must be an integer between 0 and ${MED_GAP_MAX}`);
  }
  return value;
}

function validateActive(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new HttpError(400, 'active must be a boolean');
}

function validateSortOrder(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'sort_order must be an integer');
  }
  return value;
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
  return parseId(raw, 'Feed not found');
}

function parseId(raw, notFoundMessage) {
  if (!/^\d+$/.test(raw)) throw new HttpError(404, notFoundMessage);
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) throw new HttpError(404, notFoundMessage);
  return n;
}

function parseBefore(raw) {
  if (raw === null || raw === '') return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new HttpError(400, 'before is not a valid date');
  return new Date(ms).toISOString();
}

function parseDuplicateMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DUPLICATE_MINUTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DUPLICATE_MINUTES_DEFAULT;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(header.map((k) => csvEscape(row[k])).join(','));
  const csv = lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(csv),
    'Cache-Control': 'no-cache',
  });
  return res.end(csv);
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

  const medications = medicationViews(repo, now.getTime()).filter((m) => m.active);

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
    summary_24h: buildSummary24h(repo, now.getTime(), dayAgo),
    medications: medications.map((m) => ({
      id: m.id,
      name: m.name,
      dose: m.dose,
      taken_24h: m.taken_24h,
      remaining_24h: m.remaining_24h,
      possible_now: m.possible_now,
      next_possible_at: m.next_possible_at,
      due: m.due,
    })),
    medications_due: medications.filter((m) => m.due).map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name)),
  };
}

// Rolling 24 h summary of feeds and diapers (docs/API.md, Erweiterung 2 §3).
function buildSummary24h(repo, nowMs, dayAgoIso) {
  const feeds = repo.feedsAfter(dayAgoIso);
  const bottle = feeds.filter((f) => f.side === 'bottle').length;
  let longestMs = null;
  let gapSumMs = 0;
  for (let i = 1; i < feeds.length; i++) {
    const gap = Date.parse(feeds[i].at) - Date.parse(feeds[i - 1].at);
    gapSumMs += gap;
    if (longestMs === null || gap > longestMs) longestMs = gap;
  }
  if (feeds.length > 0) {
    // Running gap since the latest entry (0 if that entry lies slightly in the future).
    const running = Math.max(0, nowMs - Date.parse(feeds.at(-1).at));
    if (longestMs === null || running > longestMs) longestMs = running;
  }
  const diapers = repo.diaperCountsAfter(dayAgoIso);
  return {
    feeds: feeds.length,
    breast: feeds.length - bottle,
    bottle,
    longest_gap_minutes: longestMs === null ? null : Math.floor(longestMs / MINUTE_MS),
    avg_gap_minutes:
      feeds.length < 2 ? null : Math.round(gapSumMs / (feeds.length - 1) / MINUTE_MS),
    diapers_wet: diapers.wet,
    diapers_dirty: diapers.dirty,
  };
}

// Medication with its status, see docs/API.md, Erweiterung 2 §4 „Statusberechnung“.
function medicationView(repo, med, nowMs) {
  const stats = repo.medicationStats(med.id, new Date(nowMs - DAY_MS).toISOString());
  const lastAt = stats.last_at ?? null;
  const lastMs = lastAt === null ? null : Date.parse(lastAt);
  const taken = Number(stats.taken ?? 0);
  const maxPerDay = med.max_per_day === null ? null : Number(med.max_per_day);
  const remaining = maxPerDay === null ? null : Math.max(0, maxPerDay - taken);

  let nextMs = null;
  if (lastMs !== null) nextMs = lastMs + Number(med.min_gap_minutes) * MINUTE_MS;
  if (remaining === 0 && stats.oldest) {
    const windowFreesAt = Date.parse(stats.oldest) + DAY_MS;
    nextMs = nextMs === null ? windowFreesAt : Math.max(nextMs, windowFreesAt);
  }
  if (nextMs !== null && nextMs <= nowMs) nextMs = null;
  const possibleNow = nextMs === null;
  const active = Number(med.active) !== 0;

  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    max_per_day: maxPerDay,
    min_gap_minutes: Number(med.min_gap_minutes),
    active,
    sort_order: Number(med.sort_order),
    last_at: lastAt,
    taken_24h: taken,
    remaining_24h: remaining,
    possible_now: possibleNow,
    next_possible_at: possibleNow ? null : new Date(nextMs).toISOString(),
    minutes_until_possible: possibleNow ? null : Math.ceil((nextMs - nowMs) / MINUTE_MS),
    due: active && possibleNow && lastMs !== null && nowMs - lastMs < MED_DUE_WINDOW_MS,
  };
}

function medicationViews(repo, nowMs) {
  return repo.allMedications().map((med) => medicationView(repo, med, nowMs));
}

async function handleApi(req, res, url, ctx) {
  const { repo, timeZone, duplicateMinutes } = ctx;
  const { method } = req;
  const p = url.pathname;

  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: VERSION, time: nowIso(), https: ctx.https });
  }

  if (p === '/api/state' && method === 'GET') {
    return sendJson(res, 200, buildState(repo, timeZone));
  }

  if (p === '/api/feeds') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      return sendJson(res, 200, { feeds: repo.list(limit, before) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const side = validateSide(body.side);
      const at = bodyAt(body);
      const note = validateNote(body.note);
      const onDuplicate = validateOnDuplicate(body.on_duplicate);
      if (onDuplicate !== 'force') {
        const existing = repo.findDuplicateFeed(at, duplicateMinutes);
        if (existing) {
          if (onDuplicate === 'skip') {
            return sendJson(res, 200, { feed: null, skipped: true, existing });
          }
          return sendJson(res, 409, { error: 'duplicate', existing });
        }
      }
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

  if (p === '/api/diapers') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      return sendJson(res, 200, { diapers: repo.listDiapers(limit, before) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const kind = validateKind(body.kind);
      const at = bodyAt(body);
      const note = validateNote(body.note);
      return sendJson(res, 201, { diaper: repo.insertDiaper(kind, at, note) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const diaperMatch = /^\/api\/diapers\/([^/]+)$/.exec(p);
  if (diaperMatch) {
    const id = parseId(diaperMatch[1], 'Diaper not found');
    if (method === 'GET') {
      const diaper = repo.diaperById(id);
      if (!diaper) throw new HttpError(404, 'Diaper not found');
      return sendJson(res, 200, { diaper });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const existing = repo.diaperById(id);
      if (!existing) throw new HttpError(404, 'Diaper not found');
      const hasField = ['kind', 'at', 'note'].some((k) => k in body);
      if (!hasField) throw new HttpError(400, 'Body must contain at least one of: kind, at, note');
      const next = {
        kind: 'kind' in body ? validateKind(body.kind) : existing.kind,
        at: 'at' in body ? parseAt(body.at) : existing.at,
        note: 'note' in body ? validateNote(body.note) : existing.note,
      };
      return sendJson(res, 200, { diaper: repo.updateDiaper(id, next) });
    }
    if (method === 'DELETE') {
      if (!repo.removeDiaper(id)) throw new HttpError(404, 'Diaper not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/medications') {
    if (method === 'GET') {
      const nowMs = Date.now();
      return sendJson(res, 200, {
        now: new Date(nowMs).toISOString(),
        medications: medicationViews(repo, nowMs),
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const med = repo.insertMedication({
        name: validateMedName(body.name),
        dose: validateDose(body.dose),
        max_per_day: validateMaxPerDay(body.max_per_day),
        min_gap_minutes:
          body.min_gap_minutes === undefined || body.min_gap_minutes === null
            ? 0
            : validateMinGap(body.min_gap_minutes),
      });
      return sendJson(res, 201, { medication: medicationView(repo, med, Date.now()) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const medIntakesMatch = /^\/api\/medications\/([^/]+)\/intakes$/.exec(p);
  if (medIntakesMatch) {
    const id = parseId(medIntakesMatch[1], 'Medication not found');
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!repo.medicationById(id)) throw new HttpError(404, 'Medication not found');
      const at = bodyAt(body);
      const note = validateNote(body.note);
      const onDuplicate = validateOnDuplicate(body.on_duplicate);
      if (onDuplicate !== 'force') {
        const existing = repo.findDuplicateIntake(id, at, duplicateMinutes);
        if (existing) {
          if (onDuplicate === 'skip') {
            const medication = medicationView(repo, repo.medicationById(id), Date.now());
            return sendJson(res, 200, { intake: null, skipped: true, existing, medication });
          }
          return sendJson(res, 409, { error: 'duplicate', existing });
        }
      }
      const intake = repo.insertIntake(id, at, note);
      const medication = medicationView(repo, repo.medicationById(id), Date.now());
      return sendJson(res, 201, { intake, medication });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const medMatch = /^\/api\/medications\/([^/]+)$/.exec(p);
  if (medMatch) {
    const id = parseId(medMatch[1], 'Medication not found');
    if (method === 'GET') {
      const med = repo.medicationById(id);
      if (!med) throw new HttpError(404, 'Medication not found');
      return sendJson(res, 200, { medication: medicationView(repo, med, Date.now()) });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const existing = repo.medicationById(id);
      if (!existing) throw new HttpError(404, 'Medication not found');
      const fields = ['name', 'dose', 'max_per_day', 'min_gap_minutes', 'active', 'sort_order'];
      if (!fields.some((k) => k in body)) {
        throw new HttpError(400, `Body must contain at least one of: ${fields.join(', ')}`);
      }
      const next = {
        name: 'name' in body ? validateMedName(body.name) : existing.name,
        dose: 'dose' in body ? validateDose(body.dose) : existing.dose,
        max_per_day: 'max_per_day' in body ? validateMaxPerDay(body.max_per_day) : existing.max_per_day,
        min_gap_minutes:
          'min_gap_minutes' in body ? validateMinGap(body.min_gap_minutes) : existing.min_gap_minutes,
        active: 'active' in body ? validateActive(body.active) : existing.active,
        sort_order: 'sort_order' in body ? validateSortOrder(body.sort_order) : existing.sort_order,
      };
      const med = repo.updateMedication(id, next);
      return sendJson(res, 200, { medication: medicationView(repo, med, Date.now()) });
    }
    if (method === 'DELETE') {
      if (!repo.removeMedication(id)) throw new HttpError(404, 'Medication not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/med-intakes') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      const medRaw = url.searchParams.get('medication_id');
      let medicationId = null;
      if (medRaw !== null && medRaw !== '') {
        if (!/^\d+$/.test(medRaw)) throw new HttpError(400, 'medication_id must be a positive integer');
        medicationId = Number.parseInt(medRaw, 10);
      }
      return sendJson(res, 200, { intakes: repo.listIntakes(limit, before, medicationId) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const intakeMatch = /^\/api\/med-intakes\/([^/]+)$/.exec(p);
  if (intakeMatch) {
    const id = parseId(intakeMatch[1], 'Intake not found');
    if (method === 'DELETE') {
      if (!repo.removeIntake(id)) throw new HttpError(404, 'Intake not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/export.csv' && method === 'GET') {
    const what = url.searchParams.get('what');
    if (what === null || what === '' || what === 'feeds') {
      return sendCsv(res, 'boobo-export.csv', ['id', 'side', 'at', 'note'], repo.all());
    }
    if (what === 'diapers') {
      return sendCsv(res, 'boobo-windeln.csv', ['id', 'kind', 'at', 'note'], repo.allDiapers());
    }
    if (what === 'intakes') {
      return sendCsv(
        res,
        'boobo-medikamente.csv',
        ['id', 'medication', 'dose', 'at', 'note'],
        repo.allIntakes(),
      );
    }
    throw new HttpError(400, 'what must be one of: feeds, diapers, intakes');
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

// ---------------------------------------------------------------------------
// HTTPS mit eigener Zertifizierungsstelle (docs/API.md, Erweiterung 3)
// ---------------------------------------------------------------------------

const CA_NAME = 'Boobo Zuhause CA';
const CA_DAYS = 3650;
const CERT_DAYS = 820; // Apple akzeptiert höchstens 825 Tage
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

function parseHttpsPort(raw) {
  if (raw === undefined || raw === null || raw === '') return 8443;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 8443;
  return n;
}

function parseTlsHosts(raw) {
  const set = new Set(['localhost', '127.0.0.1']);
  for (const h of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)) set.add(h);
  return [...set];
}

function tlsSan(hosts) {
  return hosts.map((h) => (net.isIP(h) ? 'IP:' : 'DNS:') + h).join(',');
}

function openssl(args, cwd) {
  return execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Legt CA und Serverzertifikat in tlsDir an bzw. erneuert das Serverzertifikat, wenn sich die
// Adressen geändert haben oder es in < 30 Tagen abläuft. Die CA bleibt dabei stabil, damit die
// Handys nichts neu installieren müssen. Gibt { cert, key, ca, expiresAt } zurück.
function ensureTls(tlsDir, hosts, log) {
  fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const f = (name) => path.join(tlsDir, name);
  const hostsLine = hosts.join(',');

  if (!fs.existsSync(f('ca.key')) || !fs.existsSync(f('ca.crt'))) {
    fs.writeFileSync(
      f('ca.cnf'),
      [
        '[req]', 'distinguished_name = dn', 'x509_extensions = v3_ca', 'prompt = no',
        '[dn]', `CN = ${CA_NAME}`,
        '[v3_ca]', 'basicConstraints = critical, CA:TRUE', 'keyUsage = critical, keyCertSign, cRLSign',
        'subjectKeyIdentifier = hash', '',
      ].join('\n'),
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('ca.key')]);
    openssl(['req', '-x509', '-new', '-key', f('ca.key'), '-out', f('ca.crt'), '-days', String(CA_DAYS), '-sha256', '-config', f('ca.cnf')]);
    fs.chmodSync(f('ca.key'), 0o600);
    for (const name of ['server.key', 'server.crt', 'hosts.txt']) fs.rmSync(f(name), { force: true });
    log(`TLS: neue Zertifizierungsstelle „${CA_NAME}“ in ${tlsDir} erzeugt`);
  }

  let needServer = !fs.existsSync(f('server.key')) || !fs.existsSync(f('server.crt'));
  if (!needServer) {
    const prev = fs.existsSync(f('hosts.txt')) ? fs.readFileSync(f('hosts.txt'), 'utf8').trim() : '';
    if (prev !== hostsLine) needServer = true;
    else {
      const x = new crypto.X509Certificate(fs.readFileSync(f('server.crt')));
      if (new Date(x.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) needServer = true;
    }
  }
  if (needServer) {
    fs.writeFileSync(
      f('server.ext'),
      [
        `subjectAltName = ${tlsSan(hosts)}`, 'basicConstraints = CA:FALSE',
        'keyUsage = critical, digitalSignature, keyEncipherment', 'extendedKeyUsage = serverAuth',
        'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid, issuer', '',
      ].join('\n'),
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('server.key')]);
    openssl(['req', '-new', '-key', f('server.key'), '-out', f('server.csr'), '-subj', '/CN=Boobo', '-sha256']);
    openssl([
      'x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
      '-out', f('server.crt'), '-days', String(CERT_DAYS), '-sha256', '-extfile', f('server.ext'),
    ]);
    fs.chmodSync(f('server.key'), 0o600);
    fs.writeFileSync(f('hosts.txt'), hostsLine + '\n');
    fs.rmSync(f('server.csr'), { force: true });
    log(`TLS: Serverzertifikat für ${hostsLine} erzeugt (${CERT_DAYS} Tage)`);
  }

  const cert = fs.readFileSync(f('server.crt'));
  const key = fs.readFileSync(f('server.key'));
  const ca = fs.readFileSync(f('ca.crt'));
  const x = new crypto.X509Certificate(cert);
  return { cert, key, ca, expiresAt: new Date(x.validTo).toISOString() };
}

function sendCaCert(req, res, tls) {
  const body = tls.ca;
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="boobo-ca.crt"',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

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
  duplicateMinutes = parseDuplicateMinutes(process.env.FEED_DUPLICATE_MINUTES),
  httpsPort = parseHttpsPort(process.env.HTTPS_PORT),
  tlsDir = process.env.TLS_DIR || path.join(dataDir, 'tls'),
  tlsHosts = parseTlsHosts(process.env.TLS_HOSTS),
  log = (line) => console.log(line),
} = {}) {
  const timeZone = resolveTimeZone();
  const db = openDatabase(dataDir, intervalMinutes);
  const repo = createRepo(db);

  // HTTPS vorbereiten (optional). Scheitert die Zertifikatserzeugung, läuft http trotzdem.
  let tls = null;
  let httpsInfo = { enabled: false };
  if (httpsPort > 0) {
    try {
      tls = ensureTls(tlsDir, tlsHosts, log);
      httpsInfo = {
        enabled: true,
        port: httpsPort,
        hosts: tlsHosts.filter((h) => h !== 'localhost' && h !== '127.0.0.1'),
        ca_url: '/boobo-ca.crt',
        ca_name: CA_NAME,
        cert_expires_at: tls.expiresAt,
      };
    } catch (err) {
      console.error(`TLS: HTTPS bleibt aus – ${err && err.message ? err.message : err}`);
      tls = null;
    }
  }

  const ctx = { repo, timeZone, duplicateMinutes, https: httpsInfo };

  const handler = async (req, res) => {
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
      } else if (url.pathname === '/boobo-ca.crt' && tls && (req.method === 'GET' || req.method === 'HEAD')) {
        sendCaCert(req, res, tls);
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
  };

  const server = http.createServer(handler);
  server.keepAliveTimeout = 5000;
  const httpsServer = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : null;
  if (httpsServer) httpsServer.keepAliveTimeout = 5000;

  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    const closeOne = (srv) =>
      new Promise((resolve) => {
        if (!srv || !srv.listening) return resolve();
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    return Promise.all([closeOne(server), closeOne(httpsServer)]).then(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    });
  }

  return { server, httpsServer, https: httpsInfo, httpsPort, db, repo, timeZone, dataDir, duplicateMinutes, close };
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
        `| interval=${app.repo.getInterval()}min | duplicate=${app.duplicateMinutes}min | tz=${app.timeZone}`,
    );
  });
  if (app.httpsServer) {
    app.httpsServer.listen(app.httpsPort, '0.0.0.0', () => {
      const hosts = app.https.hosts.length ? app.https.hosts.join(', ') : 'localhost';
      console.log(`Boobo HTTPS on https://0.0.0.0:${app.httpsPort} (Zertifikat für ${hosts}, gültig bis ${app.https.cert_expires_at})`);
    });
  }

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

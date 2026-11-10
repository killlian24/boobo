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
import * as growth from './lib/growth.js';
import * as reminders from './lib/reminders.js';
import * as webpush from './lib/webpush.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const GROWTH_DIR = path.join(__dirname, 'growth');
const VERSION = readVersion();

const SIDES = new Set(['left', 'right', 'both', 'bottle']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REF_BODY_BYTES = 4 * 1024 * 1024;
const MAX_NOTE_LENGTH = 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const INTERVAL_MIN = 30;
const INTERVAL_MAX = 720;
const FEEDS_LIMIT_DEFAULT = 50;
const FEEDS_LIMIT_MAX = 500;
const STATS_DAYS_DEFAULT = 14;
const STATS_DAYS_MAX = 90;
const NIGHT_FROM_HOUR = 22; // Nacht = 22:00 bis 06:59 Ortszeit (wie der Nachtmodus)
const NIGHT_TO_HOUR = 7;
const GAP_BUCKETS_MINUTES = [60, 120, 180, 240]; // < 1 h, 1-2 h, 2-3 h, 3-4 h, ab 4 h
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
// Erweiterung 7: Erinnerungen und Push
const REMINDER_TIMES_MAX = 12;
const REMINDER_AFTER_MAX = 10080;
const REMINDER_REPEAT_MAX = 720;
const REMINDER_SNOOZE_DEFAULT = 15;
const REMINDER_SNOOZE_MAX = 720;
const REMINDER_FIELDS = ['reminder_mode', 'reminder_times', 'reminder_after_minutes', 'reminder_repeat_minutes'];
const PUSH_SUBSCRIPTIONS_MAX = 20;
const PUSH_TICK_MS = 30 * 1000;
const PUSH_LABEL_MAX = 60;
const MED_SEEDS = [
  { name: 'Paracetamol', dose: '1 g', max_per_day: 4, min_gap_minutes: 360 },
  { name: 'Ibuprofen', dose: '400 mg', max_per_day: 4, min_gap_minutes: 360 },
  { name: 'Magenschutz (PPI)', dose: '1 Tablette', max_per_day: 1, min_gap_minutes: 1200 },
];

const MEASURE_SOURCES = new Set(['nurse', 'doctor', 'home', 'hospital']);
const GROWTH_RANGE_MAX = 1826;
const REF_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROFILE_KEYS = [
  'name', 'sex', 'birth_date', 'gestation_weeks', 'gestation_days', 'birth_weight_g', 'birth_length_cm',
  'birth_hc_cm', 'mother_height_cm', 'father_height_cm', 'ref',
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
  // Erweiterung 7: Erinnerungen (Spalten an medications nachrüsten) und Push-Anmeldungen
  const medColumns = new Set(db.prepare('PRAGMA table_info(medications)').all().map((c) => c.name));
  const addMedColumn = (name, decl) => {
    if (!medColumns.has(name)) db.exec(`ALTER TABLE medications ADD COLUMN ${name} ${decl}`);
  };
  addMedColumn('reminder_mode', "TEXT NOT NULL DEFAULT 'off'");
  addMedColumn('reminder_times', 'TEXT');
  addMedColumn('reminder_after_minutes', 'INTEGER');
  addMedColumn('reminder_repeat_minutes', 'INTEGER NOT NULL DEFAULT 0');
  addMedColumn('reminder_since', 'TEXT');
  addMedColumn('reminder_snoozed_until', 'TEXT');
  addMedColumn('reminder_skipped_slot', 'TEXT');
  addMedColumn('reminder_sent_ping', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_ok_at TEXT,
      failures INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Erweiterung 4: Wachstum (Messungen und importierte Referenzkurven)
  db.exec(`
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      weight_g INTEGER,
      length_cm REAL,
      hc_cm REAL,
      source TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_measurements_date ON measurements(date);
    CREATE TABLE IF NOT EXISTS growth_refs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
    listBefore: db.prepare(
      'SELECT * FROM feeds WHERE at < ?1 OR (at = ?1 AND id < ?2) ORDER BY at DESC, id DESC LIMIT ?3',
    ),
    all: db.prepare('SELECT id, side, at, note FROM feeds ORDER BY at ASC, id ASC'),
    update: db.prepare('UPDATE feeds SET side = ?, at = ?, note = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM feeds WHERE id = ?'),
    last: db.prepare('SELECT * FROM feeds ORDER BY at DESC, id DESC LIMIT 1'),
    lastBreast: db.prepare(
      "SELECT side FROM feeds WHERE side != 'bottle' ORDER BY at DESC, id DESC LIMIT 1",
    ),
    countSince: db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE at >= ? AND at <= ?'),
    feedsNear: db.prepare('SELECT * FROM feeds WHERE at > ? AND at < ? ORDER BY at DESC, id DESC'),
    feedsBetween: db.prepare(
      'SELECT id, side, at FROM feeds WHERE at > ? AND at <= ? ORDER BY at ASC, id ASC',
    ),
    feedsFrom: db.prepare('SELECT id, side, at FROM feeds WHERE at >= ? ORDER BY at ASC, id ASC'),
    feedBefore: db.prepare('SELECT id, side, at FROM feeds WHERE at < ? ORDER BY at DESC, id DESC LIMIT 1'),

    diaperInsert: db.prepare(
      'INSERT INTO diapers (kind, at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    diaperById: db.prepare('SELECT * FROM diapers WHERE id = ?'),
    diaperList: db.prepare('SELECT * FROM diapers ORDER BY at DESC, id DESC LIMIT ?'),
    diaperListBefore: db.prepare(
      'SELECT * FROM diapers WHERE at < ?1 OR (at = ?1 AND id < ?2) ORDER BY at DESC, id DESC LIMIT ?3',
    ),
    diaperAll: db.prepare('SELECT id, kind, at, note FROM diapers ORDER BY at ASC, id ASC'),
    diaperUpdate: db.prepare(
      'UPDATE diapers SET kind = ?, at = ?, note = ?, updated_at = ? WHERE id = ?',
    ),
    diaperRemove: db.prepare('DELETE FROM diapers WHERE id = ?'),
    diaperCountsBetween: db.prepare(
      'SELECT kind, COUNT(*) AS n FROM diapers WHERE at > ? AND at <= ? GROUP BY kind',
    ),
    diapersFrom: db.prepare('SELECT kind, at FROM diapers WHERE at >= ? ORDER BY at ASC, id ASC'),

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
    medNthOldest: db.prepare(
      'SELECT at FROM med_intakes WHERE medication_id = ? AND at > ? ORDER BY at ASC, id ASC LIMIT 1 OFFSET ?',
    ),
    medReminderUpdate: db.prepare(
      'UPDATE medications SET reminder_mode = ?, reminder_times = ?, reminder_after_minutes = ?, ' +
        'reminder_repeat_minutes = ?, reminder_since = ?, reminder_snoozed_until = NULL, reminder_skipped_slot = NULL, ' +
        'reminder_sent_ping = NULL, updated_at = ? WHERE id = ?',
    ),
    medSnooze: db.prepare('UPDATE medications SET reminder_snoozed_until = ?, updated_at = ? WHERE id = ?'),
    medSkip: db.prepare(
      'UPDATE medications SET reminder_skipped_slot = ?, reminder_snoozed_until = NULL, updated_at = ? WHERE id = ?',
    ),
    medResume: db.prepare(
      'UPDATE medications SET reminder_skipped_slot = NULL, reminder_snoozed_until = NULL, updated_at = ? WHERE id = ?',
    ),
    medSentPing: db.prepare('UPDATE medications SET reminder_sent_ping = ? WHERE id = ?'),

    pushAll: db.prepare('SELECT * FROM push_subscriptions ORDER BY id ASC'),
    pushCount: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions'),
    pushByEndpoint: db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?'),
    pushUpsert: db.prepare(
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ' +
        'label = COALESCE(excluded.label, push_subscriptions.label), updated_at = excluded.updated_at, failures = 0',
    ),
    pushRemove: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    pushOk: db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?'),
    pushFail: db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?'),

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
        'WHERE (?1 IS NULL OR i.medication_id = ?1) AND (?2 IS NULL OR i.at < ?2 OR (i.at = ?2 AND i.id < ?4)) ' +
        'ORDER BY i.at DESC, i.id DESC LIMIT ?3',
    ),
    intakeAll: db.prepare(
      'SELECT i.id, m.name AS medication, m.dose, i.at, i.note ' +
        'FROM med_intakes i JOIN medications m ON m.id = i.medication_id ORDER BY i.at ASC, i.id ASC',
    ),
    intakeUpdate: db.prepare('UPDATE med_intakes SET at = ?, note = ? WHERE id = ?'),
    intakeRemove: db.prepare('DELETE FROM med_intakes WHERE id = ?'),

    measAll: db.prepare('SELECT * FROM measurements ORDER BY date ASC, id ASC'),
    measById: db.prepare('SELECT * FROM measurements WHERE id = ?'),
    measInsert: db.prepare(
      'INSERT INTO measurements (date, weight_g, length_cm, hc_cm, source, note, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    measUpdate: db.prepare(
      'UPDATE measurements SET date = ?, weight_g = ?, length_cm = ?, hc_cm = ?, source = ?, note = ?, updated_at = ? WHERE id = ?',
    ),
    measRemove: db.prepare('DELETE FROM measurements WHERE id = ?'),
    refAll: db.prepare('SELECT id, data FROM growth_refs ORDER BY created_at ASC, id ASC'),
    refUpsert: db.prepare(
      'INSERT INTO growth_refs (id, data, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    ),
    refRemove: db.prepare('DELETE FROM growth_refs WHERE id = ?'),

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
    // Cursor: alles vor `before`; bei gleichem Zeitstempel nur kleinere IDs als `beforeId`
    // (ohne beforeId bleiben zeitgleiche Datensätze außen vor, wie bisher).
    list(limit, before, beforeId = 0) {
      return before ? stmts.listBefore.all(before, beforeId, limit) : stmts.list.all(limit);
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
    feedsBetween(fromIso, toIso) {
      return stmts.feedsBetween.all(fromIso, toIso);
    },
    feedsFrom(fromIso) {
      return stmts.feedsFrom.all(fromIso);
    },
    feedBefore(iso) {
      return stmts.feedBefore.get(iso) ?? null;
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
    listDiapers(limit, before, beforeId = 0) {
      return before ? stmts.diaperListBefore.all(before, beforeId, limit) : stmts.diaperList.all(limit);
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
    diaperCountsBetween(fromIso, toIso) {
      const out = { wet: 0, dirty: 0 };
      for (const row of stmts.diaperCountsBetween.all(fromIso, toIso)) {
        if (row.kind in out) out[row.kind] = Number(row.n);
      }
      return out;
    },
    diapersFrom(fromIso) {
      return stmts.diapersFrom.all(fromIso);
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
    // Einnahme im Fenster, nach der (von alt nach neu gezählt) `skip` weitere liegen.
    medicationNthOldest(id, dayAgoIso, skip) {
      return stmts.medNthOldest.get(id, dayAgoIso, skip)?.at ?? null;
    },

    // --- reminders (Erweiterung 7) ---
    updateReminder(id, r, sinceIso) {
      stmts.medReminderUpdate.run(
        r.reminder_mode,
        r.reminder_times.length ? JSON.stringify(r.reminder_times) : null,
        r.reminder_after_minutes,
        r.reminder_repeat_minutes,
        sinceIso,
        nowIso(),
        id,
      );
      return stmts.medById.get(id);
    },
    snoozeReminder(id, untilIso) {
      stmts.medSnooze.run(untilIso, nowIso(), id);
      return stmts.medById.get(id);
    },
    skipReminder(id, slotIso) {
      stmts.medSkip.run(slotIso, nowIso(), id);
      return stmts.medById.get(id);
    },
    resumeReminder(id) {
      stmts.medResume.run(nowIso(), id);
      return stmts.medById.get(id);
    },
    setReminderSentPing(id, ping) {
      stmts.medSentPing.run(ping, id);
    },
    getReminderQuiet() {
      const row = stmts.getSetting.get('reminder_quiet');
      if (!row) return null;
      try {
        const q = JSON.parse(row.value);
        return q && typeof q.from === 'string' && typeof q.to === 'string' ? { from: q.from, to: q.to } : null;
      } catch {
        return null;
      }
    },
    setReminderQuiet(quiet) {
      stmts.setSetting.run('reminder_quiet', JSON.stringify(quiet ? { from: quiet.from, to: quiet.to } : null));
    },
    getVapidKeys() {
      const row = stmts.getSetting.get('vapid_keys');
      if (!row) return null;
      try {
        const k = JSON.parse(row.value);
        return k && typeof k.publicKey === 'string' && typeof k.privateKey === 'string' ? k : null;
      } catch {
        return null;
      }
    },
    setVapidKeys(keys) {
      stmts.setSetting.run('vapid_keys', JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }));
    },

    // --- push subscriptions ---
    allPushSubscriptions() {
      return stmts.pushAll.all();
    },
    countPushSubscriptions() {
      return Number(stmts.pushCount.get().n);
    },
    pushSubscriptionByEndpoint(endpoint) {
      return stmts.pushByEndpoint.get(endpoint) ?? null;
    },
    upsertPushSubscription({ endpoint, p256dh, auth, label }) {
      const ts = nowIso();
      stmts.pushUpsert.run(endpoint, p256dh, auth, label, ts, ts);
      return stmts.pushByEndpoint.get(endpoint);
    },
    removePushSubscription(endpoint) {
      return stmts.pushRemove.run(endpoint).changes > 0;
    },
    touchPushSubscription(id, ok) {
      if (ok) stmts.pushOk.run(nowIso(), id);
      else stmts.pushFail.run(id);
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
    listIntakes(limit, before, medicationId, beforeId = 0) {
      return stmts.intakeList.all(medicationId ?? null, before ?? null, limit, beforeId);
    },
    allIntakes() {
      return stmts.intakeAll.all();
    },
    intakeById(id) {
      return stmts.intakeById.get(id);
    },
    updateIntake(id, { at, note }) {
      stmts.intakeUpdate.run(at, note, id);
      return stmts.intakeById.get(id);
    },
    removeIntake(id) {
      return stmts.intakeRemove.run(id).changes > 0;
    },

    // --- growth ---
    getProfile() {
      const row = stmts.getSetting.get('growth_profile');
      if (!row) return {};
      try {
        const p = JSON.parse(row.value);
        return p && typeof p === 'object' ? p : {};
      } catch {
        return {};
      }
    },
    setProfile(profile) {
      stmts.setSetting.run('growth_profile', JSON.stringify(profile));
    },
    allMeasurements() {
      return stmts.measAll.all().map(measurementRow);
    },
    measurementById(id) {
      const row = stmts.measById.get(id);
      return row ? measurementRow(row) : null;
    },
    insertMeasurement(m) {
      const ts = nowIso();
      const { lastInsertRowid } = stmts.measInsert.run(
        m.date, m.weight_g, m.length_cm, m.hc_cm, m.source, m.note, ts, ts,
      );
      return measurementRow(stmts.measById.get(Number(lastInsertRowid)));
    },
    updateMeasurement(id, m) {
      stmts.measUpdate.run(m.date, m.weight_g, m.length_cm, m.hc_cm, m.source, m.note, nowIso(), id);
      return measurementRow(stmts.measById.get(id));
    },
    removeMeasurement(id) {
      return stmts.measRemove.run(id).changes > 0;
    },
    importedRefs() {
      return stmts.refAll.all();
    },
    saveRef(id, data) {
      const ts = nowIso();
      stmts.refUpsert.run(id, JSON.stringify(data), ts, ts);
    },
    removeRef(id) {
      return stmts.refRemove.run(id).changes > 0;
    },
  };
}

function measurementRow(row) {
  return {
    id: Number(row.id),
    date: row.date,
    weight_g: row.weight_g === null ? null : Number(row.weight_g),
    length_cm: row.length_cm === null ? null : Number(row.length_cm),
    hc_cm: row.hc_cm === null ? null : Number(row.hc_cm),
    source: row.source ?? null,
    note: row.note ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
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

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
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
      if (size > maxBytes) {
        // Stop buffering, drain the rest so the 413 response can be delivered.
        chunks.length = 0;
        req.resume();
        fail(new HttpError(413, `Request body too large (max ${Math.round(maxBytes / 1024)} KB)`));
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

// --- Erweiterung 7: Erinnerungen und Push ---

function validateReminderMode(value) {
  if (typeof value !== 'string' || !reminders.REMINDER_MODES.has(value)) {
    throw new HttpError(400, 'reminder_mode must be one of: off, times, after_last');
  }
  return value;
}

function validateReminderTimes(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > REMINDER_TIMES_MAX) {
    throw new HttpError(400, `reminder_times must be an array of at most ${REMINDER_TIMES_MAX} "HH:MM" strings`);
  }
  const out = [];
  for (const v of value) {
    const n = reminders.normalizeHHMM(v);
    if (!n) throw new HttpError(400, 'reminder_times entries must be "HH:MM"');
    if (!out.includes(n)) out.push(n);
  }
  return out.sort();
}

function validateReminderAfter(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > REMINDER_AFTER_MAX) {
    throw new HttpError(400, `reminder_after_minutes must be an integer between 1 and ${REMINDER_AFTER_MAX}, or null`);
  }
  return value;
}

function validateReminderRepeat(value) {
  if (value === null || value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > REMINDER_REPEAT_MAX) {
    throw new HttpError(400, `reminder_repeat_minutes must be an integer between 0 and ${REMINDER_REPEAT_MAX}`);
  }
  return value;
}

function reminderOf(med) {
  return {
    reminder_mode: med.reminder_mode || 'off',
    reminder_times: parseTimesJson(med.reminder_times),
    reminder_after_minutes: med.reminder_after_minutes === undefined ? null : med.reminder_after_minutes,
    reminder_repeat_minutes: Number(med.reminder_repeat_minutes) || 0,
  };
}

// Erinnerungsfelder aus einem Body, fehlende Felder bleiben wie in `current`.
function reminderFromBody(body, current, minGapMinutes) {
  const next = {
    reminder_mode: 'reminder_mode' in body ? validateReminderMode(body.reminder_mode) : current.reminder_mode,
    reminder_times: 'reminder_times' in body ? validateReminderTimes(body.reminder_times) : current.reminder_times,
    reminder_after_minutes:
      'reminder_after_minutes' in body ? validateReminderAfter(body.reminder_after_minutes) : current.reminder_after_minutes,
    reminder_repeat_minutes:
      'reminder_repeat_minutes' in body ? validateReminderRepeat(body.reminder_repeat_minutes) : current.reminder_repeat_minutes,
  };
  if (next.reminder_mode === 'times' && !next.reminder_times.length) {
    throw new HttpError(400, 'reminder_times must not be empty when reminder_mode is "times"');
  }
  if (next.reminder_mode === 'after_last' && !(next.reminder_after_minutes > 0) && !(minGapMinutes > 0)) {
    throw new HttpError(400, 'reminder_after_minutes or min_gap_minutes must be set when reminder_mode is "after_last"');
  }
  return next;
}

function sameReminder(a, b) {
  return a.reminder_mode === b.reminder_mode &&
    a.reminder_after_minutes === b.reminder_after_minutes &&
    a.reminder_repeat_minutes === b.reminder_repeat_minutes &&
    JSON.stringify(a.reminder_times) === JSON.stringify(b.reminder_times);
}

function validateQuietTime(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const n = reminders.normalizeHHMM(value);
  if (!n) throw new HttpError(400, `${field} must be "HH:MM" or null`);
  return n;
}

function validateSnoozeMinutes(value) {
  if (value === null || value === undefined) return REMINDER_SNOOZE_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > REMINDER_SNOOZE_MAX) {
    throw new HttpError(400, `minutes must be an integer between 1 and ${REMINDER_SNOOZE_MAX}`);
  }
  return value;
}

function validatePushSubscription(body) {
  const endpoint = body.endpoint;
  let parsed;
  try {
    parsed = typeof endpoint === 'string' && endpoint.length <= 2048 ? new URL(endpoint) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) throw new HttpError(400, 'endpoint must be a URL string');
  const localHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !localHttp) throw new HttpError(400, 'endpoint must be an https URL');
  const keys = body.keys;
  if (!keys || typeof keys !== 'object') throw new HttpError(400, 'keys.p256dh and keys.auth are required');
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || Buffer.from(p256dh, 'base64url').length !== 65) {
    throw new HttpError(400, 'keys.p256dh must be a base64url P-256 public key (65 bytes)');
  }
  if (typeof auth !== 'string' || Buffer.from(auth, 'base64url').length !== 16) {
    throw new HttpError(400, 'keys.auth must be 16 base64url bytes');
  }
  let label = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string') throw new HttpError(400, 'label must be a string');
    label = body.label.trim().slice(0, PUSH_LABEL_MAX) || null;
  }
  return { endpoint, p256dh, auth, label };
}

function pushSubscriptionView(row) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    label: row.label,
    created_at: row.created_at,
    last_ok_at: row.last_ok_at,
    failures: Number(row.failures) || 0,
  };
}

function settingsView(repo) {
  const quiet = repo.getReminderQuiet();
  return {
    interval_minutes: repo.getInterval(),
    reminder_quiet_from: quiet ? quiet.from : null,
    reminder_quiet_to: quiet ? quiet.to : null,
  };
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

function parseDays(raw) {
  if (raw === null || raw === '') return STATS_DAYS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `days must be an integer between 1 and ${STATS_DAYS_MAX}`);
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > STATS_DAYS_MAX) {
    throw new HttpError(400, `days must be an integer between 1 and ${STATS_DAYS_MAX}`);
  }
  return n;
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

// Zweiter Teil des Cursors (docs/API.md): ID des ältesten bereits geladenen Datensatzes,
// damit zeitgleiche Datensätze an Seitengrenzen nicht übersprungen werden.
function parseBeforeId(raw) {
  if (raw === null || raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'before_id must be a positive integer');
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, 'before_id must be a positive integer');
  return n;
}

function parseDuplicateMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DUPLICATE_MINUTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DUPLICATE_MINUTES_DEFAULT;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Freitext, der wie eine Formel beginnt (=, +, -, @, Tab), wird in Tabellenprogrammen sonst ausgeführt.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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

// Origin-Header gesetzt und passt nicht zum angesprochenen Host → fremde Webseite im Browser.
function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const host = req.headers.host;
  if (!host) return true;
  try {
    return new URL(origin).host.toLowerCase() !== String(host).toLowerCase();
  } catch {
    return true;
  }
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

  const medications = medicationViews(repo, now.getTime(), timeZone).filter((m) => m.active);
  const pendingReminders = medications.filter((m) => m.reminder.status === 'pending');

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
    summary_24h: buildSummary24h(repo, now.getTime(), dayAgo, nowIsoStr),
    medications: medications.map((m) => ({
      id: m.id,
      name: m.name,
      dose: m.dose,
      taken_24h: m.taken_24h,
      remaining_24h: m.remaining_24h,
      possible_now: m.possible_now,
      next_possible_at: m.next_possible_at,
      due: m.due,
      reminder: {
        status: m.reminder.status,
        slot_at: m.reminder.slot_at,
        ping_at: m.reminder.ping_at,
        next_at: m.reminder.next_at,
      },
    })),
    medications_due: medications.filter((m) => m.due).map(medLabel),
    // Erweiterung 7: aktive Erinnerungen („Zeit für …“), für Popup und Home Assistant
    reminders: pendingReminders.map((m) => ({
      id: m.id,
      name: m.name,
      dose: m.dose,
      slot_at: m.reminder.slot_at,
      ping_at: m.reminder.ping_at,
    })),
    reminders_text: pendingReminders.map(medLabel).join(', '),
    reminder_ping: pendingReminders.reduce((acc, m) => (acc === null || m.reminder.ping_at > acc ? m.reminder.ping_at : acc), null),
  };
}

// Rolling 24 h summary of feeds and diapers (docs/API.md, Erweiterung 2 §3).
// Gleiches Fenster wie last_24h_count: bis jetzt, nicht darüber hinaus (at darf 5 min in der Zukunft liegen).
function buildSummary24h(repo, nowMs, dayAgoIso, nowIsoStr) {
  const feeds = repo.feedsBetween(dayAgoIso, nowIsoStr);
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
  const diapers = repo.diaperCountsBetween(dayAgoIso, nowIsoStr);
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

// ---------------------------------------------------------------------------
// Statistik (docs/API.md, Erweiterung 4): Tage, Tageszeiten, Abstände, Seiten
// ---------------------------------------------------------------------------

function isNightHour(hour) {
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_TO_HOUR;
}

function dateKey(p) {
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

function minutes(ms) {
  return Math.round(ms / MINUTE_MS);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(n) {
  return n === null ? null : Math.round(n * 10) / 10;
}

// Lokale Mitternacht des Tages, der `offsetDays` nach dem Tag von `midnight` liegt (DST-sicher:
// über den Mittag des Zieltags gehen, dann auf dessen Mitternacht runden).
function shiftMidnight(midnight, offsetDays, timeZone) {
  return localMidnight(new Date(midnight.getTime() + offsetDays * DAY_MS + DAY_MS / 2), timeZone);
}

function buildStats(repo, timeZone, rangeDays) {
  const now = new Date();
  const nowMs = now.getTime();
  const todayMidnight = localMidnight(now, timeZone);
  const start = shiftMidnight(todayMidnight, -(rangeDays - 1), timeZone);
  const startIso = start.toISOString();
  const todayKey = dateKey(wallClockParts(now, timeZone));

  // Ein Eintrag pro Kalendertag des Zeitraums, auch ohne Einträge (durchgehende Achse).
  const days = [];
  const byKey = new Map();
  for (let i = 0; i < rangeDays; i++) {
    const dayStart = shiftMidnight(start, i, timeZone);
    const parts = wallClockParts(dayStart, timeZone);
    const key = dateKey(parts);
    const entry = {
      date: key,
      start: dayStart.toISOString(),
      weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
      today: key === todayKey,
      feeds: 0,
      left: 0,
      right: 0,
      both: 0,
      bottle: 0,
      night_feeds: 0,
      diapers_wet: 0,
      diapers_dirty: 0,
      avg_gap_minutes: null,
      longest_gap_minutes: null,
      hours: new Array(24).fill(0),
      _gaps: [],
    };
    days.push(entry);
    byKey.set(key, entry);
  }

  const hours = new Array(24).fill(0);
  const gaps = [];
  let longest = null; // { minutes, at }
  let shortest = null;
  const totals = { feeds: 0, left: 0, right: 0, both: 0, bottle: 0, night_feeds: 0, diapers_wet: 0, diapers_dirty: 0 };

  let prev = repo.feedBefore(startIso);
  for (const feed of repo.feedsFrom(startIso)) {
    const at = new Date(feed.at);
    const parts = wallClockParts(at, timeZone);
    const entry = byKey.get(dateKey(parts));
    if (!entry) {
      // Minuten in der Zukunft (bis 5 min erlaubt) können knapp hinter Mitternacht liegen
      prev = feed;
      continue;
    }
    entry.feeds++;
    totals.feeds++;
    if (feed.side in totals) {
      entry[feed.side]++;
      totals[feed.side]++;
    }
    entry.hours[parts.hour]++;
    hours[parts.hour]++;
    if (isNightHour(parts.hour)) {
      entry.night_feeds++;
      totals.night_feeds++;
    }
    if (prev) {
      const gapMin = minutes(at.getTime() - Date.parse(prev.at));
      if (gapMin >= 0) {
        entry._gaps.push(gapMin);
        gaps.push(gapMin);
        if (!longest || gapMin > longest.minutes) longest = { minutes: gapMin, at: feed.at };
        if (!shortest || gapMin < shortest.minutes) shortest = { minutes: gapMin, at: feed.at };
      }
    }
    prev = feed;
  }

  for (const d of repo.diapersFrom(startIso)) {
    const entry = byKey.get(dateKey(wallClockParts(new Date(d.at), timeZone)));
    if (!entry) continue;
    if (d.kind === 'wet') {
      entry.diapers_wet++;
      totals.diapers_wet++;
    } else if (d.kind === 'dirty') {
      entry.diapers_dirty++;
      totals.diapers_dirty++;
    }
  }

  for (const entry of days) {
    entry.avg_gap_minutes = entry._gaps.length ? Math.round(mean(entry._gaps)) : null;
    entry.longest_gap_minutes = entry._gaps.length ? Math.max(...entry._gaps) : null;
    delete entry._gaps;
  }

  // Mittelwerte „pro Tag“ nur über vollständige Tage ab dem ersten Tag mit Eintrag im Zeitraum.
  const firstIdx = days.findIndex((d) => d.feeds > 0);
  const fullDays = firstIdx < 0 ? [] : days.slice(firstIdx).filter((d) => !d.today);
  const daysCounted = fullDays.length;
  const sum = (key) => fullDays.reduce((a, d) => a + d[key], 0);
  const perDay = (key) => (daysCounted ? round1(sum(key) / daysCounted) : null);

  const gapBuckets = [];
  let lower = 0;
  for (const upper of GAP_BUCKETS_MINUTES) {
    gapBuckets.push({ from_minutes: lower, to_minutes: upper, n: gaps.filter((g) => g >= lower && g < upper).length });
    lower = upper;
  }
  gapBuckets.push({ from_minutes: lower, to_minutes: null, n: gaps.filter((g) => g >= lower).length });

  return {
    now: now.toISOString(),
    time_zone: timeZone,
    range_days: rangeDays,
    from: startIso,
    days,
    hours,
    gaps: {
      count: gaps.length,
      avg_minutes: gaps.length ? Math.round(mean(gaps)) : null,
      median_minutes: gaps.length ? Math.round(median(gaps)) : null,
      longest_minutes: longest ? longest.minutes : null,
      longest_at: longest ? longest.at : null,
      shortest_minutes: shortest ? shortest.minutes : null,
      shortest_at: shortest ? shortest.at : null,
      histogram: gapBuckets,
    },
    totals: {
      ...totals,
      days_with_feeds: days.filter((d) => d.feeds > 0).length,
      days_counted: daysCounted,
      feeds_per_day: perDay('feeds'),
      bottle_per_day: perDay('bottle'),
      night_feeds_per_day: perDay('night_feeds'),
      diapers_per_day: daysCounted ? round1((sum('diapers_wet') + sum('diapers_dirty')) / daysCounted) : null,
    },
  };
}

// Medication with its status, see docs/API.md, Erweiterung 2 §4 „Statusberechnung“.
function medicationView(repo, med, nowMs, timeZone = resolveTimeZone()) {
  const dayAgoIso = new Date(nowMs - DAY_MS).toISOString();
  const stats = repo.medicationStats(med.id, dayAgoIso);
  const lastAt = stats.last_at ?? null;
  const lastMs = lastAt === null ? null : Date.parse(lastAt);
  const taken = Number(stats.taken ?? 0);
  const maxPerDay = med.max_per_day === null ? null : Number(med.max_per_day);
  const remaining = maxPerDay === null ? null : Math.max(0, maxPerDay - taken);

  let nextMs = null;
  if (lastMs !== null) nextMs = lastMs + Number(med.min_gap_minutes) * MINUTE_MS;
  if (remaining === 0 && stats.oldest) {
    // Platz gibt es erst, wenn so viele Einnahmen aus dem Fenster gefallen sind, dass wieder
    // weniger als max_per_day darin liegen. Bei mehr Einnahmen als erlaubt (nachträglich gesenkte
    // Höchstzahl, bewusst trotzdem genommen) ist das nicht die älteste, sondern die (taken − max + 1)-te.
    const frees = repo.medicationNthOldest(med.id, dayAgoIso, taken - maxPerDay) ?? stats.oldest;
    const windowFreesAt = Date.parse(frees) + DAY_MS;
    nextMs = nextMs === null ? windowFreesAt : Math.max(nextMs, windowFreesAt);
  }
  if (nextMs !== null && nextMs <= nowMs) nextMs = null;
  const possibleNow = nextMs === null;
  const active = Number(med.active) !== 0;
  const nextPossibleAt = possibleNow ? null : new Date(nextMs).toISOString();

  // Erweiterung 7: Erinnerung (lib/reminders.js)
  const reminder = reminders.computeReminder({
    mode: med.reminder_mode || 'off',
    times: parseTimesJson(med.reminder_times),
    afterMinutes: med.reminder_after_minutes === null || med.reminder_after_minutes === undefined
      ? null
      : Number(med.reminder_after_minutes),
    gapMinutes: Number(med.min_gap_minutes),
    repeatMinutes: Number(med.reminder_repeat_minutes) || 0,
    since: med.reminder_since,
    snoozedUntil: med.reminder_snoozed_until,
    skippedSlot: med.reminder_skipped_slot,
    lastAt,
    nextPossibleAt,
    active,
    nowMs,
    timeZone,
    quiet: repo.getReminderQuiet(),
  });

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
    next_possible_at: nextPossibleAt,
    minutes_until_possible: possibleNow ? null : Math.ceil((nextMs - nowMs) / MINUTE_MS),
    due: active && possibleNow && lastMs !== null && nowMs - lastMs < MED_DUE_WINDOW_MS,
    reminder,
  };
}

function medicationViews(repo, nowMs, timeZone) {
  return repo.allMedications().map((med) => medicationView(repo, med, nowMs, timeZone));
}

function parseTimesJson(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function medLabel(m) {
  return m.dose ? `${m.name} ${m.dose}` : m.name;
}

// „A“, „A und B“, „A, B und C“
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

function hhmmInZone(ms, timeZone) {
  const p = reminders.wallClock(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// Text der Push-Nachricht: beim ersten Mal „Zeit für …“, bei Wiederholungen „… wartet noch“.
function reminderPayload(fresh, pending, timeZone) {
  const names = joinNames(pending.map(medLabel));
  const firstTime = fresh.some((v) => v.reminder.ping_at === v.reminder.slot_at);
  const earliestSlot = pending.reduce((acc, v) => (acc === null || v.reminder.slot_at < acc ? v.reminder.slot_at : acc), null);
  const since = earliestSlot ? hhmmInZone(Date.parse(earliestSlot), timeZone) : null;
  const body = firstTime
    ? `Zeit für ${names}.`
    : `${names} ${pending.length > 1 ? 'warten' : 'wartet'} noch${since ? ` · seit ${since}` : ''}.`;
  return {
    type: 'reminder',
    title: 'Kurz an dich denken',
    body,
    tag: 'boobo-mama',
    url: '/',
    ping: pending.reduce((acc, v) => (acc === null || v.reminder.ping_at > acc ? v.reminder.ping_at : acc), null),
    medications: pending.map((v) => ({ id: v.id, name: v.name, dose: v.dose, slot_at: v.reminder.slot_at, ping_at: v.reminder.ping_at })),
  };
}

// Schickt Erinnerungen per Web Push an alle angemeldeten Handys (docs/API.md, Erweiterung 7 §3).
function createPushSender({ repo, timeZone, log, subject, fetchImpl }) {
  let keys = repo.getVapidKeys();
  if (!keys) {
    keys = webpush.generateVapidKeys();
    repo.setVapidKeys(keys);
    log('Push: neues VAPID-Schlüsselpaar erzeugt');
  }
  let ticking = false;

  async function send(subs, payload) {
    let sent = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        const r = await webpush.sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { subject, publicKey: keys.publicKey, privateKey: keys.privateKey, fetchImpl },
        );
        if (r.ok) {
          sent++;
          repo.touchPushSubscription(sub.id, true);
        } else if (r.gone) {
          failed++;
          repo.removePushSubscription(sub.endpoint);
          log(`Push: Anmeldung ${sub.id} (${sub.label || 'ohne Namen'}) abgemeldet, Dienst meldet ${r.status}`);
        } else {
          failed++;
          repo.touchPushSubscription(sub.id, false);
          log(`Push: Anmeldung ${sub.id} antwortet ${r.status}`);
        }
      } catch (err) {
        failed++;
        repo.touchPushSubscription(sub.id, false);
        log(`Push: Anmeldung ${sub.id} fehlgeschlagen – ${err && err.message ? err.message : err}`);
      }
    }
    return { sent, failed };
  }

  // Alle 30 s: Welche Erinnerung hat einen neuen Ping, der noch nicht verschickt wurde?
  async function tick(nowMs = Date.now()) {
    if (ticking) return null;
    ticking = true;
    try {
      const pending = [];
      const fresh = [];
      for (const med of repo.allMedications()) {
        const view = medicationView(repo, med, nowMs, timeZone);
        if (view.reminder.status !== 'pending') continue;
        pending.push(view);
        if (med.reminder_sent_ping !== view.reminder.ping_at) fresh.push(view);
      }
      if (!fresh.length) return { sent: 0, failed: 0, medications: [], payload: null };
      // Erst merken, dann schicken: ein langsamer Push-Dienst darf nicht zu Doppelmeldungen führen
      for (const v of fresh) repo.setReminderSentPing(v.id, v.reminder.ping_at);
      const payload = reminderPayload(fresh, pending, timeZone);
      const subs = repo.allPushSubscriptions();
      const result = subs.length ? await send(subs, payload) : { sent: 0, failed: 0 };
      return { ...result, medications: fresh.map((v) => v.id), payload };
    } finally {
      ticking = false;
    }
  }

  return { publicKey: keys.publicKey, send, tick };
}

// ---------------------------------------------------------------------------
// Wachstum (docs/API.md, Erweiterung 4)
// ---------------------------------------------------------------------------

function localYmd(timeZone, date = new Date()) {
  const p = wallClockParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function shiftYmd(ymd, days) {
  const d = new Date((growth.dayNumber(ymd) + days) * DAY_MS);
  return d.toISOString().slice(0, 10);
}

function validateYmd(value, field, todayYmd) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} must be a date YYYY-MM-DD`);
  }
  const n = growth.dayNumber(value);
  if (!Number.isFinite(n) || new Date(n * DAY_MS).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} is not a valid date`);
  }
  if (value < '2000-01-01') throw new HttpError(400, `${field} must not be before 2000-01-01`);
  if (value > todayYmd) throw new HttpError(400, `${field} must not be in the future`);
  return value;
}

function validateRange(value, field, min, max, { integer = false, digits = 1 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${field} must be a number or null`);
  if (integer && !Number.isInteger(value)) throw new HttpError(400, `${field} must be an integer`);
  if (value < min || value > max) throw new HttpError(400, `${field} must be between ${min} and ${max}`);
  return integer ? value : Number(value.toFixed(digits));
}

function validateProfilePatch(body, current, refs, todayYmd) {
  const keys = PROFILE_KEYS.filter((k) => k in body);
  if (!keys.length) throw new HttpError(400, `Body must contain at least one of: ${PROFILE_KEYS.join(', ')}`);
  const next = { ...current };
  for (const k of keys) {
    const v = body[k];
    switch (k) {
      case 'name':
        if (v === null || v === '') next.name = null;
        else if (typeof v !== 'string' || v.trim().length > 40) throw new HttpError(400, 'name must be a string of at most 40 characters');
        else next.name = v.trim() || null;
        break;
      case 'sex':
        if (v !== null && v !== 'male' && v !== 'female') throw new HttpError(400, 'sex must be male, female or null');
        next.sex = v;
        break;
      case 'birth_date':
        next.birth_date = v === null ? null : validateYmd(v, 'birth_date', todayYmd);
        break;
      case 'gestation_weeks':
        next.gestation_weeks = validateRange(v, k, 22, 44, { integer: true });
        break;
      case 'gestation_days':
        next.gestation_days = validateRange(v, k, 0, 6, { integer: true });
        break;
      case 'birth_weight_g':
        next.birth_weight_g = validateRange(v, k, 300, 7000, { integer: true });
        break;
      case 'birth_length_cm':
        next.birth_length_cm = validateRange(v, k, 25, 65);
        break;
      case 'birth_hc_cm':
        next.birth_hc_cm = validateRange(v, k, 18, 45);
        break;
      case 'mother_height_cm':
      case 'father_height_cm':
        next[k] = validateRange(v, k, 120, 230);
        break;
      case 'ref':
        if (v === null) next.ref = null;
        else if (typeof v !== 'string' || !refs.has(v)) throw new HttpError(400, 'ref must be the id of a growth reference');
        else next.ref = v;
        break;
      default:
        break;
    }
  }
  return next;
}

function validateMeasurement(body, existing, todayYmd) {
  const pick = (k, fn) => (k in body ? fn(body[k]) : existing ? existing[k] : null);
  const m = {
    date: 'date' in body || !existing ? validateYmd(body.date, 'date', todayYmd) : existing.date,
    weight_g: pick('weight_g', (v) => validateRange(v, 'weight_g', 300, 30000, { integer: true })),
    length_cm: pick('length_cm', (v) => validateRange(v, 'length_cm', 25, 130)),
    hc_cm: pick('hc_cm', (v) => validateRange(v, 'hc_cm', 18, 60)),
    source: pick('source', (v) => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v !== 'string' || !MEASURE_SOURCES.has(v)) {
        throw new HttpError(400, `source must be one of: ${[...MEASURE_SOURCES].join(', ')} or null`);
      }
      return v;
    }),
    note: pick('note', validateNote),
  };
  if (m.weight_g === null && m.length_cm === null && m.hc_cm === null) {
    throw new HttpError(400, 'At least one of weight_g, length_cm, hc_cm is required');
  }
  return m;
}

// Eingebaute Kurven (growth/*.json) plus importierte (SQLite), dänischer Platzhalter bis zum Import.
function createRefRegistry(repo, dir) {
  const builtin = growth.loadBuiltinRefs(dir);
  let imported = null;
  function load() {
    if (imported) return imported;
    imported = new Map();
    for (const row of repo.importedRefs()) {
      try {
        const ref = growth.normalizeRef(JSON.parse(row.data));
        ref.id = row.id;
        ref.builtin = false;
        imported.set(row.id, ref);
      } catch (err) {
        console.error(`Wachstum: importierte Kurve ${row.id} defekt – ${err.message}`);
      }
    }
    return imported;
  }
  return {
    get(id) {
      return builtin.get(id) ?? load().get(id) ?? null;
    },
    has(id) {
      return !!this.get(id);
    },
    imported(id) {
      return load().get(id) ?? null;
    },
    list() {
      const out = [...builtin.values()].map((r) => growth.refSummary(r));
      const imp = load();
      if (!builtin.has('dk') && !imp.has('dk')) out.push(growth.refSummary(growth.DK_PLACEHOLDER, false));
      for (const r of imp.values()) out.push(growth.refSummary(r));
      return out;
    },
    save(ref) {
      const { builtin: _b, ...data } = ref;
      repo.saveRef(ref.id, data);
      imported = null;
    },
    remove(id) {
      const ok = repo.removeRef(id);
      imported = null;
      return ok;
    },
    isBuiltin(id) {
      return builtin.has(id);
    },
  };
}

function nextCustomRefId(refs) {
  for (let i = 1; i < 1000; i++) {
    const id = `eigene-${i}`;
    if (!refs.has(id)) return id;
  }
  throw new HttpError(409, 'Too many imported references');
}

function buildImportedRef(body, refs) {
  let id = body.id;
  if (id === undefined || id === null || id === '') {
    // gleicher Name wie eine schon importierte Kurve → diese ergänzen
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
    const same = name ? refs.list().find((r) => !r.builtin && r.available && r.name.toLowerCase() === name) : null;
    id = same ? same.id : nextCustomRefId(refs);
  }
  if (typeof id !== 'string' || !REF_ID_RE.test(id)) throw new HttpError(400, 'id must match [a-z0-9-], max 32 characters');
  if (refs.isBuiltin(id)) throw new HttpError(400, `${id} is a built-in reference and cannot be replaced`);
  const isDk = id === 'dk';
  const base = isDk ? growth.DK_PLACEHOLDER : {};
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  let incoming;
  try {
    if (body.data && typeof body.data === 'object') {
      incoming = growth.normalizeRef({ ...base, ...body.data, id });
    } else if (typeof body.csv === 'string') {
      const parsed = growth.parseCsvRef(body.csv, {
        age_unit: body.age_unit, measure: body.measure, sex: body.sex,
      });
      incoming = growth.normalizeRef({ ...base, id, measures: parsed.measures });
    } else {
      throw new HttpError(400, 'Body must contain csv (text) or data (reference object)');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err.message);
  }

  // Bestehende importierte Kurve gleicher Kennung ergänzen (z. B. Gewicht und Länge getrennt importiert)
  const existing = body.replace === true ? null : refs.imported(id);
  const measures = existing ? structuredClone(existing.measures) : {};
  for (const [m, entry] of Object.entries(incoming.measures)) {
    measures[m] = { ...(measures[m] || {}), ...entry };
  }
  const merged = growth.normalizeRef({
    ...(existing || base),
    id,
    name: text(body.name, 40) ?? existing?.name ?? base.name ?? 'Eigene Kurve',
    title: text(body.title, 120) ?? existing?.title ?? base.title ?? null,
    description: text(body.description, 400) ?? existing?.description ?? base.description ?? null,
    source: text(body.source, 600) ?? existing?.source ?? base.source ?? null,
    kind: 'reference',
    lines: incoming.lines !== growth.SD_LINES ? incoming.lines : existing?.lines ?? base.lines ?? growth.SD_LINES,
    measures,
    adult_height: body.data?.adult_height ?? null,
  });
  return merged;
}

function growthContext(repo, refs, url) {
  const profile = repo.getProfile();
  const wanted = url?.searchParams.get('ref') || profile.ref || 'who';
  const ref = refs.get(wanted) ?? refs.get('who');
  return { profile, wanted, ref };
}

function buildGrowth(repo, refs, timeZone, url) {
  const { profile, wanted, ref } = growthContext(repo, refs, url);
  const rawRange = url.searchParams.get('range_days');
  let rangeDays = null;
  if (rawRange !== null && rawRange !== '') {
    if (!/^\d+$/.test(rawRange)) throw new HttpError(400, 'range_days must be a positive integer');
    rangeDays = Math.min(GROWTH_RANGE_MAX, Math.max(28, Number.parseInt(rawRange, 10)));
  }
  const analysis = growth.analyze({
    profile, measurements: repo.allMeasurements(), ref, todayYmd: localYmd(timeZone), rangeDays,
  });
  return {
    profile: profileView(profile),
    ref: ref ? growth.refSummary(ref) : null,
    ref_requested: wanted,
    ref_unavailable: ref && ref.id !== wanted ? wanted : null,
    refs: refs.list(),
    today: localYmd(timeZone),
    ...analysis,
  };
}

function profileView(p) {
  const out = {};
  for (const k of PROFILE_KEYS) out[k] = p[k] ?? null;
  return out;
}

// Kurzfassung für /api/state und Home Assistant
function growthBrief(repo, refs, timeZone) {
  const { profile, ref } = growthContext(repo, refs, null);
  if (!profile.birth_date) return null;
  const a = growth.analyze({
    profile, measurements: repo.allMeasurements(), ref, todayYmd: localYmd(timeZone), rangeDays: 28,
  });
  const lw = a.latest.weight;
  const lastGain = a.gains.at(-1) ?? null;
  return {
    ref: ref ? ref.id : null,
    age_days: a.age_days,
    corrected_age_days: a.corrected_age_days,
    weight_g: lw ? lw.value : null,
    weight_date: lw ? lw.date : null,
    weight_percentile: lw?.p ?? null,
    length_cm: a.latest.length?.value ?? null,
    length_percentile: a.latest.length?.p ?? null,
    hc_cm: a.latest.hc?.value ?? null,
    hc_percentile: a.latest.hc?.p ?? null,
    gain_g_per_week: lastGain ? lastGain.g_per_week : null,
  };
}

async function handleGrowth(req, res, url, ctx) {
  const { repo, timeZone, refs } = ctx;
  const { method } = req;
  const p = url.pathname;

  if (p === '/api/growth') {
    if (method === 'GET') return sendJson(res, 200, buildGrowth(repo, refs, timeZone, url));
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/growth/profile') {
    if (method === 'GET') return sendJson(res, 200, { profile: profileView(repo.getProfile()) });
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJsonBody(req);
      const next = validateProfilePatch(body, repo.getProfile(), refs, localYmd(timeZone));
      repo.setProfile(next);
      return sendJson(res, 200, { profile: profileView(next) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/growth/measurements') {
    if (method === 'GET') return sendJson(res, 200, { measurements: repo.allMeasurements() });
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const m = validateMeasurement(body, null, localYmd(timeZone));
      return sendJson(res, 201, { measurement: repo.insertMeasurement(m) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const measMatch = /^\/api\/growth\/measurements\/([^/]+)$/.exec(p);
  if (measMatch) {
    const id = parseId(measMatch[1], 'Measurement not found');
    if (method === 'GET') {
      const existing = repo.measurementById(id);
      if (!existing) throw new HttpError(404, 'Measurement not found');
      return sendJson(res, 200, { measurement: existing });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      // Erst nach dem Body lesen: während des Wartens kann das andere Handy ein anderes Feld geändert haben.
      const existing = repo.measurementById(id);
      if (!existing) throw new HttpError(404, 'Measurement not found');
      const fields = ['date', 'weight_g', 'length_cm', 'hc_cm', 'source', 'note'];
      if (!fields.some((k) => k in body)) throw new HttpError(400, `Body must contain at least one of: ${fields.join(', ')}`);
      const m = validateMeasurement(body, existing, localYmd(timeZone));
      return sendJson(res, 200, { measurement: repo.updateMeasurement(id, m) });
    }
    if (method === 'DELETE') {
      if (!repo.removeMeasurement(id)) throw new HttpError(404, 'Measurement not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (p === '/api/growth/refs') {
    if (method === 'GET') return sendJson(res, 200, { refs: refs.list() });
    if (method === 'POST') {
      const body = await readJsonBody(req, MAX_REF_BODY_BYTES);
      const ref = buildImportedRef(body, refs);
      refs.save(ref);
      return sendJson(res, 201, { ref: growth.refSummary(refs.get(ref.id)) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const refMatch = /^\/api\/growth\/refs\/([^/]+)$/.exec(p);
  if (refMatch) {
    const id = refMatch[1];
    if (method === 'GET') {
      const ref = refs.get(id);
      if (!ref) throw new HttpError(404, 'Reference not found');
      return sendJson(res, 200, { ref });
    }
    if (method === 'DELETE') {
      if (refs.isBuiltin(id)) throw new HttpError(400, 'Built-in references cannot be deleted');
      if (!refs.remove(id)) throw new HttpError(404, 'Reference not found');
      const profile = repo.getProfile();
      if (profile.ref === id) repo.setProfile({ ...profile, ref: null });
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  throw new HttpError(404, 'Not found');
}

async function handleApi(req, res, url, ctx) {
  const { repo, timeZone, duplicateMinutes } = ctx;
  const { method } = req;
  const p = url.pathname;

  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: VERSION, time: nowIso(), https: ctx.https, push: { enabled: true, subscriptions: repo.countPushSubscriptions() } });
  }

  if (p === '/api/state' && method === 'GET') {
    const st = buildState(repo, timeZone);
    st.growth = growthBrief(repo, ctx.refs, timeZone);
    return sendJson(res, 200, st);
  }

  if (p === '/api/growth' || p.startsWith('/api/growth/')) {
    return handleGrowth(req, res, url, ctx);
  }

  if (p === '/api/stats') {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return sendJson(res, 200, buildStats(repo, timeZone, parseDays(url.searchParams.get('days'))));
  }

  if (p === '/api/feeds') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      const beforeId = parseBeforeId(url.searchParams.get('before_id'));
      return sendJson(res, 200, { feeds: repo.list(limit, before, beforeId) });
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
      return sendJson(res, 200, settingsView(repo));
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const keys = ['interval_minutes', 'reminder_quiet_from', 'reminder_quiet_to'];
      if (!keys.some((k) => k in body)) throw new HttpError(400, `Body must contain at least one of: ${keys.join(', ')}`);
      if ('interval_minutes' in body) repo.setInterval(validateInterval(body.interval_minutes));
      if ('reminder_quiet_from' in body || 'reminder_quiet_to' in body) {
        const cur = repo.getReminderQuiet();
        const from = 'reminder_quiet_from' in body ? validateQuietTime(body.reminder_quiet_from, 'reminder_quiet_from') : (cur ? cur.from : null);
        const to = 'reminder_quiet_to' in body ? validateQuietTime(body.reminder_quiet_to, 'reminder_quiet_to') : (cur ? cur.to : null);
        repo.setReminderQuiet(from && to ? { from, to } : null);
      }
      return sendJson(res, 200, settingsView(repo));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // --- Erweiterung 7: Push-Anmeldungen ---
  if (p === '/api/push/key' && method === 'GET') {
    return sendJson(res, 200, { enabled: true, public_key: ctx.push.publicKey, subscriptions: repo.countPushSubscriptions() });
  }
  if (p === '/api/push/subscriptions') {
    if (method === 'GET') {
      return sendJson(res, 200, { subscriptions: repo.allPushSubscriptions().map(pushSubscriptionView) });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const sub = validatePushSubscription(body);
      const existing = repo.pushSubscriptionByEndpoint(sub.endpoint);
      if (!existing && repo.countPushSubscriptions() >= PUSH_SUBSCRIPTIONS_MAX) {
        throw new HttpError(409, `At most ${PUSH_SUBSCRIPTIONS_MAX} push subscriptions`);
      }
      const row = repo.upsertPushSubscription(sub);
      return sendJson(res, existing ? 200 : 201, { subscription: pushSubscriptionView(row) });
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req);
      if (typeof body.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
      if (!repo.removePushSubscription(body.endpoint)) throw new HttpError(404, 'Subscription not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (p === '/api/push/test' && method === 'POST') {
    const body = await readJsonBody(req);
    let subs = repo.allPushSubscriptions();
    if (typeof body.endpoint === 'string') subs = subs.filter((s) => s.endpoint === body.endpoint);
    if (!subs.length) throw new HttpError(404, 'No push subscription');
    const result = await ctx.push.send(subs, {
      type: 'test',
      title: 'Boobo',
      body: 'Benachrichtigungen funktionieren. Schön, dass du da bist.',
      tag: 'boobo-test',
      url: '/',
    });
    return sendJson(res, 200, result);
  }

  if (p === '/api/diapers') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      const beforeId = parseBeforeId(url.searchParams.get('before_id'));
      return sendJson(res, 200, { diapers: repo.listDiapers(limit, before, beforeId) });
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
        medications: medicationViews(repo, nowMs, timeZone),
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const minGap =
        body.min_gap_minutes === undefined || body.min_gap_minutes === null ? 0 : validateMinGap(body.min_gap_minutes);
      const reminder = REMINDER_FIELDS.some((k) => k in body)
        ? reminderFromBody(body, { reminder_mode: 'off', reminder_times: [], reminder_after_minutes: null, reminder_repeat_minutes: 0 }, minGap)
        : null;
      let med = repo.insertMedication({
        name: validateMedName(body.name),
        dose: validateDose(body.dose),
        max_per_day: validateMaxPerDay(body.max_per_day),
        min_gap_minutes: minGap,
      });
      if (reminder) med = repo.updateReminder(med.id, reminder, nowIso());
      return sendJson(res, 201, { medication: medicationView(repo, med, Date.now(), timeZone) });
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
            const medication = medicationView(repo, repo.medicationById(id), Date.now(), timeZone);
            return sendJson(res, 200, { intake: null, skipped: true, existing, medication });
          }
          return sendJson(res, 409, { error: 'duplicate', existing });
        }
      }
      const intake = repo.insertIntake(id, at, note);
      const medication = medicationView(repo, repo.medicationById(id), Date.now(), timeZone);
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
      return sendJson(res, 200, { medication: medicationView(repo, med, Date.now(), timeZone) });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const existing = repo.medicationById(id);
      if (!existing) throw new HttpError(404, 'Medication not found');
      const fields = ['name', 'dose', 'max_per_day', 'min_gap_minutes', 'active', 'sort_order', ...REMINDER_FIELDS];
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
      // Erinnerung vorab prüfen, damit bei einem Fehler nichts halb gespeichert ist
      const current = reminderOf(existing);
      const reminder = REMINDER_FIELDS.some((k) => k in body) ? reminderFromBody(body, current, next.min_gap_minutes) : null;
      let med = repo.updateMedication(id, next);
      // Nur bei echter Änderung neu ab jetzt gelten lassen (sonst würde ein Snooze oder Überspringen verloren gehen)
      if (reminder && !sameReminder(reminder, current)) med = repo.updateReminder(id, reminder, nowIso());
      return sendJson(res, 200, { medication: medicationView(repo, med, Date.now(), timeZone) });
    }
    if (method === 'DELETE') {
      if (!repo.removeMedication(id)) throw new HttpError(404, 'Medication not found');
      return sendEmpty(res, 204);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // Erweiterung 7: Erinnerung verschieben („In 15 Minuten“), überspringen, zurücksetzen
  const medReminderMatch = /^\/api\/medications\/([^/]+)\/reminder$/.exec(p);
  if (medReminderMatch) {
    const id = parseId(medReminderMatch[1], 'Medication not found');
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await readJsonBody(req);
    let med = repo.medicationById(id);
    if (!med) throw new HttpError(404, 'Medication not found');
    if (body.action === 'snooze') {
      const minutes = validateSnoozeMinutes(body.minutes);
      med = repo.snoozeReminder(id, new Date(Date.now() + minutes * MINUTE_MS).toISOString());
    } else if (body.action === 'skip') {
      const view = medicationView(repo, med, Date.now(), timeZone);
      if (view.reminder.slot_at) med = repo.skipReminder(id, view.reminder.slot_at);
    } else if (body.action === 'resume') {
      med = repo.resumeReminder(id);
    } else {
      throw new HttpError(400, 'action must be one of: snooze, skip, resume');
    }
    return sendJson(res, 200, { medication: medicationView(repo, med, Date.now(), timeZone) });
  }

  if (p === '/api/med-intakes') {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const before = parseBefore(url.searchParams.get('before'));
      const beforeId = parseBeforeId(url.searchParams.get('before_id'));
      const medRaw = url.searchParams.get('medication_id');
      let medicationId = null;
      if (medRaw !== null && medRaw !== '') {
        if (!/^\d+$/.test(medRaw)) throw new HttpError(400, 'medication_id must be a positive integer');
        medicationId = Number.parseInt(medRaw, 10);
      }
      return sendJson(res, 200, { intakes: repo.listIntakes(limit, before, medicationId, beforeId) });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const intakeMatch = /^\/api\/med-intakes\/([^/]+)$/.exec(p);
  if (intakeMatch) {
    const id = parseId(intakeMatch[1], 'Intake not found');
    if (method === 'GET') {
      const intake = repo.intakeById(id);
      if (!intake) throw new HttpError(404, 'Intake not found');
      return sendJson(res, 200, { intake });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const existing = repo.intakeById(id);
      if (!existing) throw new HttpError(404, 'Intake not found');
      if (!['at', 'note'].some((k) => k in body)) {
        throw new HttpError(400, 'Body must contain at least one of: at, note');
      }
      const intake = repo.updateIntake(id, {
        at: 'at' in body ? parseAt(body.at) : existing.at,
        note: 'note' in body ? validateNote(body.note) : existing.note,
      });
      const medication = medicationView(repo, repo.medicationById(intake.medication_id), Date.now(), timeZone);
      return sendJson(res, 200, { intake, medication });
    }
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
    if (what === 'measurements') {
      return sendCsv(
        res,
        'boobo-wachstum.csv',
        ['id', 'date', 'weight_g', 'length_cm', 'hc_cm', 'source', 'note'],
        repo.allMeasurements(),
      );
    }
    throw new HttpError(400, 'what must be one of: feeds, diapers, intakes, measurements');
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

// Der Service Worker bekommt seine Cache-Version aus dem Inhalt der App-Shell: ändert sich beim Deploy
// irgendeine Shell-Datei, ändert sich sw.js mit, der Browser installiert ihn neu und wirft den alten Cache weg.
const SHELL_FILES = ['index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const shellVersionCache = new Map(); // publicRoot → { key, version }
function shellVersion(publicRoot) {
  const stats = SHELL_FILES.map((f) => statFile(path.join(publicRoot, f)));
  const key = stats.map((st) => (st ? `${st.size}:${st.mtimeMs}` : '-')).join('|');
  const cached = shellVersionCache.get(publicRoot);
  if (cached && cached.key === key) return cached.version;
  const hash = crypto.createHash('sha1');
  SHELL_FILES.forEach((f, i) => {
    if (stats[i]) hash.update(fs.readFileSync(path.join(publicRoot, f)));
    hash.update('\0');
  });
  const version = `${VERSION}-${hash.digest('hex').slice(0, 12)}`;
  shellVersionCache.set(publicRoot, { key, version });
  return version;
}

function sendServiceWorker(req, res, filePath, publicRoot) {
  const body = fs
    .readFileSync(filePath, 'utf8')
    .replace('__SHELL_VERSION__', shellVersion(publicRoot));
  res.writeHead(200, {
    'Content-Type': MIME_TYPES['.js'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
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

  if (filePath === path.join(publicRoot, 'sw.js')) return sendServiceWorker(req, res, filePath, publicRoot);
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

// Lesen darf jede Seite (Dashboards, Kiosk-Anzeigen); Schreiben nur die App selbst oder Clients ohne Origin
// (Home Assistant, curl). Browser schicken bei POST/PATCH/PUT/DELETE immer einen Origin-Header mit.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function createServer({
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  intervalMinutes = Number.parseInt(process.env.FEED_INTERVAL_MINUTES || '180', 10) || 180,
  publicDir = PUBLIC_DIR,
  growthDir = GROWTH_DIR,
  duplicateMinutes = parseDuplicateMinutes(process.env.FEED_DUPLICATE_MINUTES),
  httpsPort = parseHttpsPort(process.env.HTTPS_PORT),
  tlsDir = process.env.TLS_DIR || path.join(dataDir, 'tls'),
  tlsHosts = parseTlsHosts(process.env.TLS_HOSTS),
  log = (line) => console.log(line),
  pushSubject = process.env.PUSH_SUBJECT || 'mailto:boobo@example.com',
  pushFetch = fetch,
  pushTickMs = PUSH_TICK_MS,
} = {}) {
  const timeZone = resolveTimeZone();
  const db = openDatabase(dataDir, intervalMinutes);
  const repo = createRepo(db);
  // Erweiterung 7: Erinnerungen per Web Push, alle 30 s geprüft (pushTickMs = 0: nur von Hand, für Tests)
  const push = createPushSender({ repo, timeZone, log, subject: pushSubject, fetchImpl: pushFetch });
  const pushTimer = pushTickMs > 0
    ? setInterval(() => push.tick().catch((err) => log(`Push: ${err && err.message ? err.message : err}`)), pushTickMs)
    : null;
  if (pushTimer && typeof pushTimer.unref === 'function') pushTimer.unref();

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

  const refs = createRefRegistry(repo, growthDir);
  const ctx = { repo, timeZone, duplicateMinutes, https: httpsInfo, refs, push };

  const handler = async (req, res) => {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // z. B. „GET //“ – darf den Prozess nicht beenden
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      return res.end('Bad request');
    }
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
        if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossOrigin(req)) {
          throw new HttpError(403, 'Cross-origin write requests are not allowed');
        }
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
    if (pushTimer) clearInterval(pushTimer);
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

  return { server, httpsServer, https: httpsInfo, httpsPort, db, repo, timeZone, dataDir, duplicateMinutes, push, close };
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

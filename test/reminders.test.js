// Tests for docs/API.md „Erweiterung 7“: Erinnerungen (lib/reminders.js), Web Push (lib/webpush.js) und die API.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../server.js';
import { computeReminder, inQuiet, quietEndsAt, localInstant, normalizeHHMM, wallClock } from '../lib/reminders.js';
import { generateVapidKeys, vapidAuthorization, verifyVapidToken, encryptPayload, decryptPayload, sendPush } from '../lib/webpush.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const TZ = 'Europe/Berlin';
const iso = (ms) => new Date(ms).toISOString();

// 2026-11-10 10:00 Ortszeit Berlin (Winterzeit, UTC+1)
const NOW = localInstant(2026, 11, 10, 10, 0, TZ);

// ---------------------------------------------------------------------------
describe('lib/reminders: Uhrzeiten', () => {
  test('normalizeHHMM', () => {
    assert.equal(normalizeHHMM('8:00'), '08:00');
    assert.equal(normalizeHHMM(' 20:30 '), '20:30');
    assert.equal(normalizeHHMM('24:00'), null);
    assert.equal(normalizeHHMM('8'), null);
    assert.equal(normalizeHHMM(8), null);
  });

  test('localInstant und wallClock sind Umkehrungen, auch am Ende der Sommerzeit', () => {
    const ms = localInstant(2026, 10, 25, 4, 30, TZ); // nach dem Wechsel
    const p = wallClock(ms, TZ);
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 10, 25, 4, 30]);
    assert.equal(NOW, Date.parse('2026-11-10T09:00:00.000Z'));
  });

  test('mode times: vor der Uhrzeit idle mit next_at, danach pending mit ping = Uhrzeit', () => {
    const base = { mode: 'times', times: ['08:00', '20:00'], since: iso(NOW - 2 * 24 * HOUR), timeZone: TZ };
    // 07:30, gestern 20:05 genommen: nichts steht an, nächste 08:00
    let r = computeReminder({ ...base, nowMs: NOW - 2.5 * HOUR, lastAt: iso(localInstant(2026, 11, 9, 20, 5, TZ)) });
    assert.equal(r.status, 'idle');
    assert.equal(r.next_at, iso(localInstant(2026, 11, 10, 8, 0, TZ)));
    // 07:30 ohne Einnahme: gestern 20:00 wartet noch
    r = computeReminder({ ...base, nowMs: NOW - 2.5 * HOUR });
    assert.equal(r.status, 'pending');
    assert.equal(r.slot_at, iso(localInstant(2026, 11, 9, 20, 0, TZ)));
    // 10:00: 08:00 steht an
    r = computeReminder({ ...base, nowMs: NOW });
    assert.equal(r.status, 'pending');
    assert.equal(r.slot_at, iso(localInstant(2026, 11, 10, 8, 0, TZ)));
    assert.equal(r.ping_at, r.slot_at);
    assert.equal(r.next_at, iso(localInstant(2026, 11, 10, 20, 0, TZ)));
  });

  test('mode times: Einnahme bis 60 min vor der Uhrzeit zählt, danach erledigt', () => {
    const base = { mode: 'times', times: ['08:00'], since: iso(NOW - 2 * 24 * HOUR), timeZone: TZ, nowMs: NOW };
    const slot = localInstant(2026, 11, 10, 8, 0, TZ);
    assert.equal(computeReminder({ ...base, lastAt: iso(slot - 59 * MIN) }).status, 'idle');
    assert.equal(computeReminder({ ...base, lastAt: iso(slot + 5 * MIN) }).status, 'idle');
    assert.equal(computeReminder({ ...base, lastAt: iso(slot - 61 * MIN) }).status, 'pending');
    // gestern genommen → heute wieder dran
    assert.equal(computeReminder({ ...base, lastAt: iso(slot - 24 * HOUR) }).status, 'pending');
  });

  test('mode times: Uhrzeiten vor der Einstellung werden nicht nachgeholt', () => {
    const r = computeReminder({ mode: 'times', times: ['08:00'], since: iso(NOW - 30 * MIN), timeZone: TZ, nowMs: NOW });
    assert.equal(r.status, 'idle');
    assert.equal(r.next_at, iso(localInstant(2026, 11, 11, 8, 0, TZ)));
  });

  test('mode times: Wiederholung alle 30 min → ping springt, slot bleibt', () => {
    const base = { mode: 'times', times: ['08:00'], repeatMinutes: 30, since: iso(NOW - 24 * HOUR), timeZone: TZ };
    const slot = localInstant(2026, 11, 10, 8, 0, TZ);
    let r = computeReminder({ ...base, nowMs: slot + 29 * MIN });
    assert.equal(r.ping_at, iso(slot));
    r = computeReminder({ ...base, nowMs: slot + 31 * MIN });
    assert.equal(r.ping_at, iso(slot + 30 * MIN));
    r = computeReminder({ ...base, nowMs: slot + 125 * MIN });
    assert.equal(r.ping_at, iso(slot + 120 * MIN));
    assert.equal(r.slot_at, iso(slot));
  });

  test('snooze, skip und Mindestabstand', () => {
    const slot = localInstant(2026, 11, 10, 8, 0, TZ);
    const base = { mode: 'times', times: ['08:00'], since: iso(NOW - 24 * HOUR), timeZone: TZ, nowMs: NOW };
    let r = computeReminder({ ...base, snoozedUntil: iso(NOW + 10 * MIN) });
    assert.equal(r.status, 'snoozed');
    assert.equal(r.next_at, iso(NOW + 10 * MIN));
    r = computeReminder({ ...base, snoozedUntil: iso(NOW - 10 * MIN) });
    assert.equal(r.status, 'pending');
    assert.equal(r.ping_at, iso(NOW - 10 * MIN), 'nach dem Snooze beginnt die Zählung neu');
    r = computeReminder({ ...base, skippedSlot: iso(slot) });
    assert.equal(r.status, 'skipped');
    r = computeReminder({ ...base, skippedSlot: iso(slot - 24 * HOUR) });
    assert.equal(r.status, 'pending', 'ein alter Skip gilt nicht für die heutige Uhrzeit');
    r = computeReminder({ ...base, nextPossibleAt: iso(NOW + 20 * MIN) });
    assert.equal(r.status, 'idle');
    assert.equal(r.next_at, iso(NOW + 20 * MIN));
  });

  test('mode after_last: nach Stunden pending, 36 h lang, dann Ruhe', () => {
    const base = { mode: 'after_last', afterMinutes: 480, gapMinutes: 360, since: iso(NOW - 48 * HOUR), timeZone: TZ };
    assert.equal(computeReminder({ ...base, nowMs: NOW }).status, 'idle', 'ohne Einnahme nichts');
    let r = computeReminder({ ...base, nowMs: NOW, lastAt: iso(NOW - 7 * HOUR) });
    assert.equal(r.status, 'idle');
    assert.equal(r.next_at, iso(NOW + 1 * HOUR));
    r = computeReminder({ ...base, nowMs: NOW, lastAt: iso(NOW - 9 * HOUR) });
    assert.equal(r.status, 'pending');
    assert.equal(r.slot_at, iso(NOW - 1 * HOUR));
    r = computeReminder({ ...base, nowMs: NOW, lastAt: iso(NOW - 50 * HOUR) });
    assert.equal(r.status, 'idle', 'nach 36 h gilt das Mittel als abgesetzt');
    // ohne afterMinutes gilt der Abstand
    r = computeReminder({ ...base, afterMinutes: null, nowMs: NOW, lastAt: iso(NOW - 7 * HOUR) });
    assert.equal(r.status, 'pending');
    assert.equal(r.slot_at, iso(NOW - 1 * HOUR));
    // Einstellung erst nach dem Zeitpunkt gesetzt → erst ab der nächsten Einnahme
    r = computeReminder({ ...base, since: iso(NOW - 30 * MIN), nowMs: NOW, lastAt: iso(NOW - 9 * HOUR) });
    assert.equal(r.status, 'idle');
  });

  test('Nachtruhe über Mitternacht, quiet_until', () => {
    const quiet = { from: '23:00', to: '06:30' };
    assert.equal(inQuiet(localInstant(2026, 11, 10, 23, 30, TZ), quiet, TZ), true);
    assert.equal(inQuiet(localInstant(2026, 11, 10, 3, 0, TZ), quiet, TZ), true);
    assert.equal(inQuiet(localInstant(2026, 11, 10, 6, 30, TZ), quiet, TZ), false);
    assert.equal(inQuiet(localInstant(2026, 11, 10, 12, 0, TZ), quiet, TZ), false);
    assert.equal(inQuiet(NOW, { from: '08:00', to: '08:00' }, TZ), false, 'gleiche Zeiten = aus');
    assert.equal(inQuiet(NOW, null, TZ), false);
    const at3 = localInstant(2026, 11, 10, 3, 0, TZ);
    assert.equal(quietEndsAt(at3, quiet, TZ), localInstant(2026, 11, 10, 6, 30, TZ));
    const at23 = localInstant(2026, 11, 10, 23, 30, TZ);
    assert.equal(quietEndsAt(at23, quiet, TZ), localInstant(2026, 11, 11, 6, 30, TZ));

    const r = computeReminder({
      mode: 'times', times: ['22:00'], since: iso(NOW - 24 * HOUR), timeZone: TZ, nowMs: at23, quiet,
    });
    assert.equal(r.status, 'quiet');
    assert.equal(r.quiet_until, iso(localInstant(2026, 11, 11, 6, 30, TZ)));
  });

  test('pausiert oder aus → off', () => {
    assert.equal(computeReminder({ mode: 'times', times: ['08:00'], active: false, nowMs: NOW, timeZone: TZ }).status, 'off');
    assert.equal(computeReminder({ mode: 'off', nowMs: NOW, timeZone: TZ }).status, 'off');
    assert.equal(computeReminder({ mode: 'times', times: [], nowMs: NOW, timeZone: TZ }).status, 'off');
  });
});

// ---------------------------------------------------------------------------
describe('lib/webpush', () => {
  test('VAPID: Schlüssel, signiertes Token, Prüfung', () => {
    const keys = generateVapidKeys();
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    const auth = vapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc', subject: 'mailto:test@example.com', ...keys,
    });
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    assert.ok(m);
    assert.equal(m[2], keys.publicKey);
    assert.equal(verifyVapidToken(m[1], keys.publicKey), true);
    const claims = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:test@example.com');
    const other = generateVapidKeys();
    assert.equal(verifyVapidToken(m[1], other.publicKey), false);
  });

  test('aes128gcm: verschlüsseln und als Browser wieder entschlüsseln', () => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };
    const text = JSON.stringify({ title: 'Kurz an dich denken', body: 'Zeit für Paracetamol 1 g.' });
    const body = encryptPayload(sub, text);
    assert.equal(body.readUInt32BE(16), 4096);
    assert.equal(body[20], 65);
    const plain = decryptPayload(body, { privateKey: ua.getPrivateKey(), auth: sub.auth });
    assert.equal(plain.toString(), text);
    assert.throws(() => encryptPayload({ p256dh: 'AAAA', auth: sub.auth }, text));
  });

  test('RFC 8291 Beispielvektor', () => {
    // Appendix A von RFC 8291: bekannte Schlüssel, Salt und erwartete Bytes
    const sub = {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    };
    const salt = Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url');
    const asPrivate = Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url');
    const body = encryptPayload(sub, 'When I grow up, I want to be a watermelon', { salt, localPrivateKey: asPrivate });
    assert.equal(
      body.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  test('sendPush: Header und Ergebnis', async () => {
    const keys = generateVapidKeys();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const sub = {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    };
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { status: 201 };
    };
    const r = await sendPush(sub, { hello: 'world' }, { subject: 'mailto:x@example.com', ...keys, fetchImpl });
    assert.deepEqual(r, { ok: true, status: 201, gone: false });
    assert.equal(seen.url, sub.endpoint);
    assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(seen.init.headers.TTL, '3600');
    assert.ok(seen.init.headers.Authorization.startsWith('vapid t='));
    const plain = decryptPayload(seen.init.body, { privateKey: ua.getPrivateKey(), auth: sub.keys.auth });
    assert.deepEqual(JSON.parse(plain.toString()), { hello: 'world' });
    const gone = await sendPush(sub, 'x', { subject: 'mailto:x@example.com', ...keys, fetchImpl: async () => ({ status: 410 }) });
    assert.deepEqual(gone, { ok: false, status: 410, gone: true });
  });
});

// ---------------------------------------------------------------------------
async function startApp(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-rem-'));
  const app = createServer({ intervalMinutes: 180, log: () => {}, pushTickMs: 0, ...options, dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(method, pathname, body) {
    const res = await fetch(base + pathname, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    if (res.headers.get('content-type')?.includes('application/json') && text) json = JSON.parse(text);
    return { status: res.status, json, text };
  }
  async function stop() {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return { app, api, stop, dataDir };
}

function hhmm(ms, tz) {
  const p = wallClock(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function fakeSubscription(endpoint) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    privateKey: ua.getPrivateKey(),
  };
}

describe('API: Erinnerungen und Push', () => {
  let ctx;
  const sent = [];
  before(async () => {
    ctx = await startApp({
      pushFetch: async (url, init) => {
        sent.push({ url, init });
        return { status: url.endsWith('/gone') ? 410 : 201 };
      },
    });
  });
  after(() => ctx.stop());

  test('PATCH reminder_*: Validierung und Ansicht', async () => {
    const { api } = ctx;
    let r = await api('PATCH', '/api/medications/1', { reminder_mode: 'daily' });
    assert.equal(r.status, 400);
    r = await api('PATCH', '/api/medications/1', { reminder_mode: 'times' });
    assert.equal(r.status, 400, 'times ohne Uhrzeiten');
    r = await api('PATCH', '/api/medications/1', { reminder_mode: 'times', reminder_times: ['25:00'] });
    assert.equal(r.status, 400);
    r = await api('PATCH', '/api/medications/1', { reminder_mode: 'times', reminder_times: ['20:00', '8:00', '08:00'], reminder_repeat_minutes: 30 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.medication.reminder.times, ['08:00', '20:00']);
    assert.equal(r.json.medication.reminder.mode, 'times');
    assert.equal(r.json.medication.reminder.repeat_minutes, 30);
    assert.equal(r.json.medication.reminder.status, 'idle', 'frisch eingestellt: keine vergangene Uhrzeit nachholen');
    assert.ok(r.json.medication.reminder.next_at);

    // after_last braucht Stunden oder Abstand
    r = await api('POST', '/api/medications', { name: 'Eisen', reminder_mode: 'after_last' });
    assert.equal(r.status, 400);
    r = await api('POST', '/api/medications', { name: 'Eisen', reminder_mode: 'after_last', reminder_after_minutes: 480 });
    assert.equal(r.status, 201);
    assert.equal(r.json.medication.reminder.after_minutes, 480);
    assert.equal(r.json.medication.reminder.status, 'idle');
    r = await api('PATCH', `/api/medications/${r.json.medication.id}`, { reminder_mode: 'off' });
    assert.equal(r.json.medication.reminder.status, 'off');
    await api('DELETE', `/api/medications/${r.json.medication.id}`);
  });

  test('Uhrzeit vorbei → pending, Popup-Daten in /api/state, Push genau einmal pro Ping', async () => {
    const { api, app } = ctx;
    const tz = app.timeZone;
    const now = Date.now();
    // Uhrzeit vor 20 Minuten; „since“ liegt davor, weil wir die Spalte direkt setzen
    const slotTime = hhmm(now - 20 * MIN, tz);
    let r = await api('PATCH', '/api/medications/1', { reminder_mode: 'times', reminder_times: [slotTime], reminder_repeat_minutes: 10 });
    assert.equal(r.status, 200);
    app.db.prepare('UPDATE medications SET reminder_since = ? WHERE id = 1').run(iso(now - 2 * HOUR));

    r = await api('GET', '/api/medications/1');
    const rem = r.json.medication.reminder;
    assert.equal(rem.status, 'pending');
    assert.equal(hhmm(Date.parse(rem.slot_at), tz), slotTime);
    // 20 min nach der Uhrzeit, Wiederholung alle 10 → ping = slot + 20 min (Minutenrundung der Uhrzeit beachten)
    const slotMs = Date.parse(rem.slot_at);
    assert.equal(Date.parse(rem.ping_at), slotMs + 10 * MIN * Math.floor((now - slotMs) / (10 * MIN)));

    const state = (await api('GET', '/api/state')).json;
    assert.equal(state.reminders.length, 1);
    assert.equal(state.reminders[0].id, 1);
    assert.equal(state.reminders_text, 'Paracetamol 1 g');
    assert.equal(state.reminder_ping, rem.ping_at);
    assert.equal(state.medications[0].reminder.status, 'pending');

    // Push-Anmeldungen
    const s1 = fakeSubscription('https://push.example.com/one');
    const s2 = fakeSubscription('https://push.example.com/gone');
    r = await api('POST', '/api/push/subscriptions', { endpoint: s1.endpoint, keys: s1.keys, label: 'Mamas Handy' });
    assert.equal(r.status, 201);
    assert.equal(r.json.subscription.label, 'Mamas Handy');
    r = await api('POST', '/api/push/subscriptions', { endpoint: s1.endpoint, keys: s1.keys });
    assert.equal(r.status, 200, 'gleiche Anmeldung erneut → 200');
    assert.equal(r.json.subscription.label, 'Mamas Handy', 'Name bleibt');
    r = await api('POST', '/api/push/subscriptions', { endpoint: s2.endpoint, keys: s2.keys });
    assert.equal(r.status, 201);
    r = await api('POST', '/api/push/subscriptions', { endpoint: 'ftp://x', keys: s1.keys });
    assert.equal(r.status, 400);
    r = await api('POST', '/api/push/subscriptions', { endpoint: s1.endpoint, keys: { p256dh: 'abc', auth: s1.keys.auth } });
    assert.equal(r.status, 400);
    r = await api('GET', '/api/push/key');
    assert.equal(r.json.subscriptions, 2);
    assert.equal(Buffer.from(r.json.public_key, 'base64url').length, 65);

    sent.length = 0;
    let t = await app.push.tick();
    assert.deepEqual(t.medications, [1]);
    assert.equal(t.sent, 1);
    assert.equal(t.failed, 1);
    assert.equal(sent.length, 2);
    const plain = JSON.parse(decryptPayload(sent[0].init.body, { privateKey: s1.privateKey, auth: s1.keys.auth }).toString());
    assert.equal(plain.type, 'reminder');
    assert.equal(plain.title, 'Kurz an dich denken');
    assert.match(plain.body, /Paracetamol 1 g/);
    assert.equal(plain.medications[0].id, 1);
    assert.equal(plain.ping, rem.ping_at);
    // 410 → Anmeldung weg
    r = await api('GET', '/api/push/subscriptions');
    assert.deepEqual(r.json.subscriptions.map((s) => s.endpoint), [s1.endpoint]);

    // Gleicher Ping → kein zweiter Push
    t = await app.push.tick();
    assert.deepEqual(t.medications, []);
    assert.equal(sent.length, 2);

    // Snooze → snoozed, danach kein Push; Resume → pending wieder mit neuem Ping (= Snooze-Zeit, in der Zukunft → idle? nein: resume löscht)
    r = await api('POST', '/api/medications/1/reminder', { action: 'snooze', minutes: 5 });
    assert.equal(r.json.medication.reminder.status, 'snoozed');
    t = await app.push.tick();
    assert.deepEqual(t.medications, []);
    r = await api('POST', '/api/medications/1/reminder', { action: 'resume' });
    assert.equal(r.json.medication.reminder.status, 'pending');
    r = await api('POST', '/api/medications/1/reminder', { action: 'snooze', minutes: 0 });
    assert.equal(r.status, 400);
    r = await api('POST', '/api/medications/1/reminder', { action: 'later' });
    assert.equal(r.status, 400);

    // Überspringen → skipped, nichts im State
    r = await api('POST', '/api/medications/1/reminder', { action: 'skip' });
    assert.equal(r.json.medication.reminder.status, 'skipped');
    assert.equal((await api('GET', '/api/state')).json.reminders.length, 0);
    r = await api('POST', '/api/medications/1/reminder', { action: 'resume' });
    assert.equal(r.json.medication.reminder.status, 'pending');

    // Genommen → erledigt
    r = await api('POST', '/api/medications/1/intakes', {});
    assert.equal(r.status, 201);
    assert.equal(r.json.medication.reminder.status, 'idle');
    t = await app.push.tick();
    assert.deepEqual(t.medications, []);

    // Test-Push
    sent.length = 0;
    r = await api('POST', '/api/push/test', { endpoint: s1.endpoint });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { sent: 1, failed: 0 });
    r = await api('POST', '/api/push/test', { endpoint: 'https://push.example.com/nope' });
    assert.equal(r.status, 404);

    // Abmelden
    r = await api('DELETE', '/api/push/subscriptions', { endpoint: s1.endpoint });
    assert.equal(r.status, 204);
    r = await api('DELETE', '/api/push/subscriptions', { endpoint: s1.endpoint });
    assert.equal(r.status, 404);
  });

  test('Nachtruhe in den Einstellungen', async () => {
    const { api, app } = ctx;
    let r = await api('PUT', '/api/settings', { reminder_quiet_from: '23:00', reminder_quiet_to: '6:30' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { interval_minutes: 180, reminder_quiet_from: '23:00', reminder_quiet_to: '06:30' });
    r = await api('PUT', '/api/settings', { reminder_quiet_from: 'abends' });
    assert.equal(r.status, 400);
    // Ruhe rund um die Uhr bis auf eine Minute → jede Erinnerung ist „quiet“
    const now = Date.now();
    const from = hhmm(now + 2 * MIN, app.timeZone);
    const to = hhmm(now + 1 * MIN, app.timeZone);
    await api('PUT', '/api/settings', { reminder_quiet_from: from, reminder_quiet_to: to });
    r = await api('PATCH', '/api/medications/2', { reminder_mode: 'times', reminder_times: [hhmm(now - 30 * MIN, app.timeZone)] });
    app.db.prepare('UPDATE medications SET reminder_since = ? WHERE id = 2').run(iso(now - 2 * HOUR));
    r = await api('GET', '/api/medications/2');
    assert.equal(r.json.medication.reminder.status, 'quiet');
    assert.ok(r.json.medication.reminder.quiet_until);
    assert.equal((await api('GET', '/api/state')).json.reminders.length, 0);
    r = await api('PUT', '/api/settings', { reminder_quiet_from: null, reminder_quiet_to: null });
    assert.deepEqual(r.json, { interval_minutes: 180, reminder_quiet_from: null, reminder_quiet_to: null });
    r = await api('GET', '/api/medications/2');
    assert.equal(r.json.medication.reminder.status, 'pending');
  });

  test('Erinnerung unverändert speichern löscht Snooze nicht; Änderung setzt neu', async () => {
    const { api, app } = ctx;
    let r = await api('POST', '/api/medications/2/reminder', { action: 'snooze', minutes: 30 });
    assert.equal(r.json.medication.reminder.status, 'snoozed');
    const times = r.json.medication.reminder.times;
    r = await api('PATCH', '/api/medications/2', { name: 'Ibuprofen', reminder_mode: 'times', reminder_times: times, reminder_repeat_minutes: 0 });
    assert.equal(r.json.medication.reminder.status, 'snoozed');
    r = await api('PATCH', '/api/medications/2', { reminder_repeat_minutes: 15 });
    assert.equal(r.json.medication.reminder.status, 'idle', 'neu ab jetzt: die alte Uhrzeit wird nicht nachgeholt');
    assert.equal(app.db.prepare('SELECT reminder_snoozed_until AS s FROM medications WHERE id = 2').get().s, null);
  });
});

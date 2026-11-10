import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createServer } from '../server.js';

const INTERVAL = 180;

let app;
let base;
let dataDir;

async function api(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (res.headers.get('content-type')?.includes('application/json') && text) {
    json = JSON.parse(text);
  }
  return { status: res.status, headers: res.headers, json, text };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

describe('Boobo API', () => {
  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-test-'));
    app = createServer({ dataDir, intervalMinutes: INTERVAL, log: () => {} });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });

  after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('GET /api/health', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.version, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.json.time)));
  });

  test('OPTIONS /api/feeds answers CORS preflight', async () => {
    const r = await api('OPTIONS', '/api/feeds');
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-methods'), /GET/);
    assert.doesNotMatch(r.headers.get('access-control-allow-methods'), /PATCH|POST|DELETE/);
  });

  test('writes from a foreign origin are rejected, same origin and no origin pass', async () => {
    const post = (origin) => fetch(base + '/api/diapers', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ kind: 'wet', at: minutesAgo(5) }),
    });
    const foreign = await post('http://evil.example');
    assert.equal(foreign.status, 403);
    const same = await post(base);
    assert.equal(same.status, 201);
    const none = await post(null);
    assert.equal(none.status, 201);
    // Lesen bleibt für jede Herkunft erlaubt (Dashboards)
    const read = await fetch(base + '/api/state', { headers: { Origin: 'http://evil.example' } });
    assert.equal(read.status, 200);
    for (const r of [same, none]) await api('DELETE', `/api/diapers/${(await r.json()).diaper.id}`);
  });

  test('an invalid request URL answers 400 and does not kill the server', async () => {
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(app.server.address().port, '127.0.0.1', () => {
        sock.write('GET // HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.equal((await api('GET', '/api/health')).status, 200);
  });

  test('before_id pages past entries with identical timestamps', async () => {
    const at = minutesAgo(900);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await api('POST', '/api/feeds', { side: 'left', at, on_duplicate: 'force' })).json.feed.id);
    const page1 = (await api('GET', '/api/feeds?limit=2')).json.feeds;
    assert.deepEqual(page1.map((f) => f.id), [ids[2], ids[1]]);
    const oldest = page1.at(-1);
    const withoutId = (await api('GET', `/api/feeds?limit=2&before=${encodeURIComponent(oldest.at)}`)).json.feeds;
    assert.ok(!withoutId.some((f) => f.id === ids[0]), 'ohne before_id bleibt der zeitgleiche Datensatz außen vor (altes Verhalten)');
    const page2 = (await api('GET', `/api/feeds?limit=2&before=${encodeURIComponent(oldest.at)}&before_id=${oldest.id}`)).json.feeds;
    assert.equal(page2[0].id, ids[0]);
    assert.equal((await api('GET', '/api/feeds?before_id=x')).status, 400);
    for (const id of ids) await api('DELETE', `/api/feeds/${id}`);
  });

  test('summary_24h and last_24h_count use the same window (not beyond now)', async () => {
    const future = await api('POST', '/api/feeds', { side: 'right', at: new Date(Date.now() + 4 * 60000).toISOString(), on_duplicate: 'force' });
    assert.equal(future.status, 201);
    const s = (await api('GET', '/api/state')).json;
    assert.equal(s.summary_24h.feeds, s.last_24h_count);
    await api('DELETE', `/api/feeds/${future.json.feed.id}`);
  });

  test('sw.js carries a cache version derived from the shell files', async () => {
    const res = await fetch(base + '/sw.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const body = await res.text();
    assert.ok(!body.includes('__SHELL_VERSION__'));
    assert.match(body, /CACHE_VERSION = 'boobo-shell-\d+\.\d+\.\d+-[0-9a-f]{12}'/);
  });

  test('GET /api/state without entries', async () => {
    const r = await api('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.last, null);
    assert.equal(r.json.minutes_since_last, null);
    assert.equal(r.json.next_due_at, null);
    assert.equal(r.json.minutes_until_due, null);
    assert.equal(r.json.overdue, false);
    assert.equal(r.json.suggested_side, 'left');
    assert.equal(r.json.interval_minutes, INTERVAL);
    assert.equal(r.json.today_count, 0);
    assert.equal(r.json.last_24h_count, 0);
  });

  test('GET /api/feeds without entries', async () => {
    const r = await api('GET', '/api/feeds');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { feeds: [] });
  });

  test('POST /api/feeds validation', async () => {
    let r = await api('POST', '/api/feeds', { side: 'middle' });
    assert.equal(r.status, 400);
    assert.equal(typeof r.json.error, 'string');

    r = await api('POST', '/api/feeds', {});
    assert.equal(r.status, 400);

    r = await api('POST', '/api/feeds', { side: 'left', at: 'not-a-date' });
    assert.equal(r.status, 400);

    // more than 5 minutes in the future
    r = await api('POST', '/api/feeds', { side: 'left', at: minutesAgo(-10) });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /future/i);

    r = await api('POST', '/api/feeds', '{not json');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /json/i);

    r = await api('POST', '/api/feeds', { side: 'left', note: 42 });
    assert.equal(r.status, 400);

    r = await api('POST', '/api/feeds', '"a string"');
    assert.equal(r.status, 400);
  });

  test('POST /api/feeds with at within 5 minutes in the future is accepted', async () => {
    const r = await api('POST', '/api/feeds', { side: 'left', at: minutesAgo(-2) });
    assert.equal(r.status, 201);
    const del = await api('DELETE', `/api/feeds/${r.json.feed.id}`);
    assert.equal(del.status, 204);
  });

  test('POST /api/feeds creates entries', async () => {
    const at1 = minutesAgo(200);
    let r = await api('POST', '/api/feeds', { side: 'left', at: at1, note: ' erste  ' });
    assert.equal(r.status, 201);
    assert.equal(r.json.feed.side, 'left');
    assert.equal(r.json.feed.at, at1);
    assert.equal(r.json.feed.note, 'erste');
    assert.equal(typeof r.json.feed.id, 'number');
    assert.ok(r.json.feed.created_at.endsWith('Z'));
    assert.ok(r.json.feed.updated_at.endsWith('Z'));

    // at with a timezone offset is normalized to UTC "Z"
    r = await api('POST', '/api/feeds', { side: 'right', at: '2026-10-30T10:00:00+02:00' });
    assert.equal(r.status, 201);
    assert.equal(r.json.feed.at, '2026-10-30T08:00:00.000Z');
    assert.equal(r.json.feed.note, null);
  });

  test('GET /api/state with overdue last entry', async () => {
    const r = await api('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.json.last.side, 'left');
    assert.equal(r.json.last.note, 'erste');
    assert.ok(r.json.minutes_since_last >= 200 && r.json.minutes_since_last <= 201);
    assert.equal(
      r.json.next_due_at,
      new Date(Date.parse(r.json.last.at) + INTERVAL * 60000).toISOString(),
    );
    assert.ok(r.json.minutes_until_due <= -20 && r.json.minutes_until_due >= -21);
    assert.equal(r.json.overdue, true);
    assert.equal(r.json.suggested_side, 'right');
    assert.equal(r.json.last_24h_count, 1);
    assert.ok(r.json.today_count >= 0 && r.json.today_count <= 1);
  });

  test('suggested_side alternates and handles both/bottle', async () => {
    let r = await api('POST', '/api/feeds', { side: 'right', at: minutesAgo(60) });
    assert.equal(r.status, 201);
    let s = await api('GET', '/api/state');
    assert.equal(s.json.suggested_side, 'left');
    assert.equal(s.json.overdue, false);
    assert.ok(s.json.minutes_since_last >= 60 && s.json.minutes_since_last <= 61);
    assert.ok(s.json.minutes_until_due >= 119 && s.json.minutes_until_due <= 120);

    r = await api('POST', '/api/feeds', { side: 'both', at: minutesAgo(40) });
    s = await api('GET', '/api/state');
    assert.equal(s.json.suggested_side, 'left');

    r = await api('POST', '/api/feeds', { side: 'left', at: minutesAgo(30) });
    s = await api('GET', '/api/state');
    assert.equal(s.json.suggested_side, 'right');

    // bottle does not change the suggestion (opposite of last breast side)
    r = await api('POST', '/api/feeds', { side: 'bottle', at: minutesAgo(10) });
    s = await api('GET', '/api/state');
    assert.equal(s.json.last.side, 'bottle');
    assert.equal(s.json.suggested_side, 'right');
    assert.equal(s.json.last_24h_count, 5);
    assert.equal(typeof s.json.today_count, 'number');
    assert.ok(s.json.today_count <= 6);
  });

  test('GET /api/feeds ordering, limit and before', async () => {
    let r = await api('GET', '/api/feeds');
    assert.equal(r.status, 200);
    assert.equal(r.json.feeds.length, 6);
    const ats = r.json.feeds.map((f) => f.at);
    const sorted = [...ats].sort().reverse();
    assert.deepEqual(ats, sorted);
    for (const f of r.json.feeds) {
      assert.deepEqual(Object.keys(f).sort(), ['at', 'created_at', 'id', 'note', 'side', 'updated_at']);
    }

    r = await api('GET', '/api/feeds?limit=2');
    assert.equal(r.json.feeds.length, 2);
    assert.equal(r.json.feeds[0].side, 'bottle');

    r = await api('GET', '/api/feeds?limit=5000');
    assert.equal(r.status, 200);
    assert.equal(r.json.feeds.length, 6);

    r = await api('GET', '/api/feeds?limit=abc');
    assert.equal(r.status, 400);

    r = await api('GET', `/api/feeds?before=${encodeURIComponent(minutesAgo(35))}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.feeds.every((f) => Date.parse(f.at) < Date.now() - 35 * 60000));
    assert.equal(r.json.feeds.length, 4);

    r = await api('GET', '/api/feeds?before=garbage');
    assert.equal(r.status, 400);
  });

  test('PATCH /api/feeds/:id', async () => {
    const list = await api('GET', '/api/feeds?limit=1');
    const feed = list.json.feeds[0];
    const newAt = minutesAgo(5);

    let r = await api('PATCH', `/api/feeds/${feed.id}`, { side: 'right', note: 'geändert' });
    assert.equal(r.status, 200);
    assert.equal(r.json.feed.id, feed.id);
    assert.equal(r.json.feed.side, 'right');
    assert.equal(r.json.feed.note, 'geändert');
    assert.equal(r.json.feed.at, feed.at);
    assert.ok(r.json.feed.updated_at >= feed.updated_at);

    r = await api('PATCH', `/api/feeds/${feed.id}`, { at: newAt, note: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.feed.at, newAt);
    assert.equal(r.json.feed.note, null);
    assert.equal(r.json.feed.side, 'right');

    r = await api('PATCH', `/api/feeds/${feed.id}`, { side: 'nope' });
    assert.equal(r.status, 400);

    r = await api('PATCH', `/api/feeds/${feed.id}`, { at: minutesAgo(-60) });
    assert.equal(r.status, 400);

    r = await api('PATCH', `/api/feeds/${feed.id}`, {});
    assert.equal(r.status, 400);

    r = await api('PATCH', '/api/feeds/999999', { side: 'left' });
    assert.equal(r.status, 404);
    assert.equal(typeof r.json.error, 'string');

    // restore side so later assertions are predictable
    await api('PATCH', `/api/feeds/${feed.id}`, { side: 'bottle' });
  });

  test('DELETE /api/feeds/:id', async () => {
    const created = await api('POST', '/api/feeds', { side: 'left', at: minutesAgo(500) });
    assert.equal(created.status, 201);
    const id = created.json.feed.id;

    let r = await api('DELETE', `/api/feeds/${id}`);
    assert.equal(r.status, 204);
    assert.equal(r.text, '');

    r = await api('DELETE', `/api/feeds/${id}`);
    assert.equal(r.status, 404);
    assert.equal(typeof r.json.error, 'string');

    r = await api('DELETE', '/api/feeds/abc');
    assert.equal(r.status, 404);

    r = await api('GET', `/api/feeds/${id}`);
    assert.equal(r.status, 404);
  });

  test('settings GET/PUT with bounds', async () => {
    let r = await api('GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { interval_minutes: INTERVAL, reminder_quiet_from: null, reminder_quiet_to: null });

    r = await api('PUT', '/api/settings', { interval_minutes: 150 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { interval_minutes: 150, reminder_quiet_from: null, reminder_quiet_to: null });

    r = await api('GET', '/api/settings');
    assert.deepEqual(r.json, { interval_minutes: 150, reminder_quiet_from: null, reminder_quiet_to: null });

    const s = await api('GET', '/api/state');
    assert.equal(s.json.interval_minutes, 150);
    assert.equal(
      s.json.next_due_at,
      new Date(Date.parse(s.json.last.at) + 150 * 60000).toISOString(),
    );

    for (const bad of [29, 721, 0, -5, 100.5, '150', null]) {
      r = await api('PUT', '/api/settings', { interval_minutes: bad });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    r = await api('PUT', '/api/settings', {});
    assert.equal(r.status, 400);

    r = await api('PUT', '/api/settings', { interval_minutes: 30 });
    assert.equal(r.status, 200);
    r = await api('PUT', '/api/settings', { interval_minutes: 720 });
    assert.equal(r.status, 200);

    r = await api('PUT', '/api/settings', { interval_minutes: INTERVAL });
    assert.equal(r.status, 200);
  });

  test('GET /api/export.csv', async () => {
    const withNote = await api('POST', '/api/feeds', {
      side: 'left',
      at: minutesAgo(600),
      note: 'Komma, "Zitat"\nZeile 2',
    });
    assert.equal(withNote.status, 201);

    const r = await api('GET', '/api/export.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="boobo-export.csv"');
    const lines = r.text.split('\r\n');
    assert.equal(lines[0], 'id,side,at,note');
    assert.ok(r.text.includes(`${withNote.json.feed.id},left,${withNote.json.feed.at},"Komma, ""Zitat""\nZeile 2"`));
    assert.equal(lines.at(-1), '');

    // Freitext, der wie eine Formel beginnt, wird entschärft
    const formula = await api('POST', '/api/feeds', { side: 'right', at: minutesAgo(590), note: '=1+1' });
    const r2 = await api('GET', '/api/export.csv');
    assert.ok(r2.text.includes(`${formula.json.feed.id},right,${formula.json.feed.at},'=1+1`));

    await api('DELETE', `/api/feeds/${withNote.json.feed.id}`);
    await api('DELETE', `/api/feeds/${formula.json.feed.id}`);
  });

  test('unknown /api path returns 404 JSON', async () => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(typeof r.json.error, 'string');
  });

  test('oversized body is rejected', async () => {
    const big = JSON.stringify({ side: 'left', note: 'x'.repeat(70 * 1024) });
    const r = await api('POST', '/api/feeds', big);
    assert.ok(r.status === 413 || r.status === 400);
  });

  test('path traversal outside public/ is blocked', async () => {
    const res = await fetch(base + '/..%2F..%2Fpackage.json');
    assert.ok([403, 404].includes(res.status));
    assert.ok(!(await res.text()).includes('"name": "boobo"'));
  });
});

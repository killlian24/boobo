import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
    assert.match(r.headers.get('access-control-allow-methods'), /PATCH/);
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
    assert.deepEqual(r.json, { interval_minutes: INTERVAL });

    r = await api('PUT', '/api/settings', { interval_minutes: 150 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { interval_minutes: 150 });

    r = await api('GET', '/api/settings');
    assert.deepEqual(r.json, { interval_minutes: 150 });

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

    await api('DELETE', `/api/feeds/${withNote.json.feed.id}`);
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

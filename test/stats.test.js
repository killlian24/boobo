// Tests for docs/API.md „Erweiterung 4“: GET /api/stats (Tage, Tageszeiten, Abstände, Seiten).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function startApp(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-stats-'));
  const app = createServer({ intervalMinutes: 180, log: () => {}, httpsPort: 0, ...options, dataDir });
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

  return { app, api, stop };
}

const iso = (ms) => new Date(ms).toISOString();

// Wall clock of `ms` in the server's time zone.
function wall(ms, timeZone) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(ms))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return { key: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`, hour: parts.hour };
}

describe('GET /api/stats', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('empty database → zeros, one entry per day, today marked', async () => {
    const r = await ctx.api('GET', '/api/stats?days=3');
    assert.equal(r.status, 200);
    const s = r.json;
    assert.equal(s.range_days, 3);
    assert.equal(s.time_zone, ctx.app.timeZone);
    assert.equal(s.days.length, 3);
    assert.equal(s.days.at(-1).today, true);
    assert.equal(s.days.filter((d) => d.today).length, 1);
    assert.deepEqual(s.hours, new Array(24).fill(0));
    assert.equal(s.totals.feeds, 0);
    assert.equal(s.totals.feeds_per_day, null);
    assert.equal(s.gaps.count, 0);
    assert.equal(s.gaps.avg_minutes, null);
    assert.equal(s.gaps.histogram.length, 5);
    assert.equal(s.gaps.histogram.at(-1).to_minutes, null);
    // days are consecutive calendar days ending today
    for (let i = 1; i < s.days.length; i++) {
      assert.ok(Date.parse(s.days[i].start) > Date.parse(s.days[i - 1].start));
    }
    assert.equal(s.days[0].start, s.from);
  });

  test('default range is 14 days, bounds are validated', async () => {
    const r = await ctx.api('GET', '/api/stats');
    assert.equal(r.status, 200);
    assert.equal(r.json.range_days, 14);
    assert.equal(r.json.days.length, 14);
    for (const q of ['days=0', 'days=91', 'days=abc', 'days=-1', 'days=1.5']) {
      const bad = await ctx.api('GET', '/api/stats?' + q);
      assert.equal(bad.status, 400, q);
    }
    const max = await ctx.api('GET', '/api/stats?days=90');
    assert.equal(max.json.days.length, 90);
    const post = await ctx.api('POST', '/api/stats', {});
    assert.equal(post.status, 405);
  });

  test('counts per day, per hour, per side; gaps; night; diapers', async () => {
    const { api, app } = ctx;
    const tz = app.timeZone;
    const now = Date.now();
    // Yesterday: 4 feeds 3 h apart, ending 2 h before "now - 1 day"; plus a feed 2 days before range start
    const base = now - DAY - 2 * HOUR;
    const feeds = [
      { side: 'left', at: base - 9 * HOUR },
      { side: 'right', at: base - 6 * HOUR },
      { side: 'both', at: base - 3 * HOUR },
      { side: 'bottle', at: base },
      { side: 'left', at: now - 30 * MIN }, // today
    ];
    for (const f of feeds) {
      const r = await api('POST', '/api/feeds', { side: f.side, at: iso(f.at), on_duplicate: 'force' });
      assert.equal(r.status, 201);
    }
    // outside the range: not counted, but it is the "previous feed" for the first gap inside the range
    const before = now - 40 * DAY;
    await api('POST', '/api/feeds', { side: 'left', at: iso(before), on_duplicate: 'force' });
    await api('POST', '/api/diapers', { kind: 'wet', at: iso(base - 1 * HOUR) });
    await api('POST', '/api/diapers', { kind: 'dirty', at: iso(now - 10 * MIN) });

    const r = await api('GET', '/api/stats?days=7');
    assert.equal(r.status, 200);
    const s = r.json;

    assert.equal(s.totals.feeds, 5);
    assert.equal(s.totals.left, 2);
    assert.equal(s.totals.right, 1);
    assert.equal(s.totals.both, 1);
    assert.equal(s.totals.bottle, 1);
    assert.equal(s.totals.diapers_wet, 1);
    assert.equal(s.totals.diapers_dirty, 1);
    assert.equal(s.hours.reduce((a, b) => a + b, 0), 5);

    // every feed lands in the day/hour of its wall clock
    const byKey = new Map(s.days.map((d) => [d.date, d]));
    const expectedHours = new Array(24).fill(0);
    let expectedNight = 0;
    for (const f of feeds) {
      const w = wall(f.at, tz);
      assert.ok(byKey.has(w.key), `day ${w.key} present`);
      assert.ok(byKey.get(w.key).hours[w.hour] >= 1);
      expectedHours[w.hour]++;
      if (w.hour >= 22 || w.hour < 7) expectedNight++;
    }
    assert.deepEqual(s.hours, expectedHours);
    assert.equal(s.totals.night_feeds, expectedNight);
    const dayFeeds = s.days.reduce((a, d) => a + d.feeds, 0);
    assert.equal(dayFeeds, 5);
    for (const d of s.days) {
      assert.equal(d.feeds, d.left + d.right + d.both + d.bottle);
      assert.equal(d.hours.reduce((a, b) => a + b, 0), d.feeds);
    }

    // gaps: from the feed before the range to the first one inside, 3 × 180 min, and (today − base)
    const firstGap = Math.round((base - 9 * HOUR - before) / MIN);
    const lastGap = Math.round((now - 30 * MIN - base) / MIN);
    assert.equal(s.gaps.count, 5);
    assert.equal(s.gaps.shortest_minutes, 180);
    assert.equal(s.gaps.shortest_at, iso(base - 6 * HOUR));
    assert.equal(s.gaps.longest_minutes, firstGap);
    assert.equal(s.gaps.longest_at, iso(base - 9 * HOUR));
    assert.equal(s.gaps.median_minutes, 180);
    assert.equal(s.gaps.avg_minutes, Math.round((3 * 180 + lastGap + firstGap) / 5));
    const hist = s.gaps.histogram;
    assert.equal(hist[3].n, 3, '3-4 h bucket (180 min is the lower bound)');
    assert.equal(hist[4].n, 2, 'over 4 h bucket');
    assert.equal(hist.reduce((a, b) => a + b.n, 0), 5);

    // today partial: today row has 1 feed and 1 dirty diaper
    const today = s.days.at(-1);
    assert.equal(today.today, true);
    assert.equal(today.feeds, 1);
    assert.equal(today.diapers_dirty, 1);

    // per-day averages: only full days from the first day with a feed up to yesterday
    const firstIdx = s.days.findIndex((d) => d.feeds > 0);
    const full = s.days.slice(firstIdx).filter((d) => !d.today);
    assert.equal(s.totals.days_counted, full.length);
    const fullFeeds = full.reduce((a, d) => a + d.feeds, 0);
    assert.equal(s.totals.feeds_per_day, Math.round((fullFeeds / full.length) * 10) / 10);
    assert.equal(s.totals.days_with_feeds, s.days.filter((d) => d.feeds > 0).length);
  });

  test('a feed before the range provides the gap of the first feed inside', async () => {
    const other = await startApp();
    try {
      const now = Date.now();
      const todayStart = Date.parse((await other.api('GET', '/api/stats?days=1')).json.from);
      // feed 2 h before today's local midnight, feed 1 h after midnight → gap 180 min, counted in the 1-day range
      await other.api('POST', '/api/feeds', { side: 'left', at: iso(todayStart - 2 * HOUR), on_duplicate: 'force' });
      if (todayStart + HOUR < now + 4 * MIN) {
        await other.api('POST', '/api/feeds', { side: 'right', at: iso(todayStart + HOUR), on_duplicate: 'force' });
        const s = (await other.api('GET', '/api/stats?days=1')).json;
        assert.equal(s.totals.feeds, 1);
        assert.equal(s.gaps.count, 1);
        assert.equal(s.gaps.avg_minutes, 180);
        assert.equal(s.days[0].avg_gap_minutes, 180);
        assert.equal(s.days[0].longest_gap_minutes, 180);
      } else {
        // Shortly after midnight the second feed would lie in the future; the range then holds no feed.
        const s = (await other.api('GET', '/api/stats?days=1')).json;
        assert.equal(s.totals.feeds, 0);
      }
    } finally {
      await other.stop();
    }
  });
});

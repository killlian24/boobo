// Tests for docs/API.md „Erweiterung 2“: Doppelschutz, Windeln, Tagesbilanz, Medikamente.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.js';

const MIN = 60000;
const HOUR = 60 * MIN;

async function startApp(options = {}) {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-r2-'));
  const app = createServer({ intervalMinutes: 180, log: () => {}, ...options, dataDir });
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
    return { status: res.status, headers: res.headers, json, text };
  }

  async function stop() {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, api, stop, dataDir };
}

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
describe('Doppelschutz POST /api/feeds', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('ask (default) → 409, force → 201, skip → 200, outside window → 201', async () => {
    const { api } = ctx;
    const t0 = Date.now();
    const first = await api('POST', '/api/feeds', { side: 'left', at: iso(t0 - 30 * MIN) });
    assert.equal(first.status, 201);

    // default = ask, 9 min away → duplicate
    let r = await api('POST', '/api/feeds', { side: 'right', at: iso(t0 - 21 * MIN) });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'duplicate');
    assert.deepEqual(r.json.existing, first.json.feed);

    r = await api('POST', '/api/feeds', { side: 'right', at: iso(t0 - 39 * MIN), on_duplicate: 'ask' });
    assert.equal(r.status, 409);
    assert.equal(r.json.existing.id, first.json.feed.id);

    r = await api('POST', '/api/feeds', { side: 'right', at: iso(t0 - 25 * MIN), on_duplicate: 'skip' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { feed: null, skipped: true, existing: first.json.feed });

    let list = await api('GET', '/api/feeds');
    assert.equal(list.json.feeds.length, 1, 'ask/skip must not store anything');

    r = await api('POST', '/api/feeds', { side: 'right', at: iso(t0 - 25 * MIN), on_duplicate: 'force' });
    assert.equal(r.status, 201);
    assert.equal(r.json.feed.side, 'right');

    // exactly 10 min away is not a duplicate (|Δ| < 10 min)
    r = await api('POST', '/api/feeds', { side: 'both', at: iso(t0 - 40 * MIN) });
    assert.equal(r.status, 201);
    // far outside the window
    r = await api('POST', '/api/feeds', { side: 'bottle', at: iso(t0 - 120 * MIN) });
    assert.equal(r.status, 201);

    list = await api('GET', '/api/feeds');
    assert.equal(list.json.feeds.length, 4);
  });

  test('duplicate check uses "now" when at is omitted and reports the closest entry', async () => {
    const { api } = ctx;
    const near = await api('POST', '/api/feeds', { side: 'left', at: iso(Date.now() - 3 * MIN) });
    assert.equal(near.status, 201);
    const r = await api('POST', '/api/feeds', { side: 'right' });
    assert.equal(r.status, 409);
    assert.equal(r.json.existing.id, near.json.feed.id);
  });

  test('invalid on_duplicate → 400; PATCH is not affected', async () => {
    const { api } = ctx;
    let r = await api('POST', '/api/feeds', { side: 'left', at: iso(Date.now() - 500 * MIN), on_duplicate: 'maybe' });
    assert.equal(r.status, 400);
    assert.equal(typeof r.json.error, 'string');

    const list = await api('GET', '/api/feeds?limit=2');
    const [a, b] = list.json.feeds;
    r = await api('PATCH', `/api/feeds/${b.id}`, { at: iso(Date.parse(a.at) - MIN) });
    assert.equal(r.status, 200);
  });

  test('window comes from FEED_DUPLICATE_MINUTES', async () => {
    const prev = process.env.FEED_DUPLICATE_MINUTES;
    process.env.FEED_DUPLICATE_MINUTES = '2';
    let other;
    try {
      other = await startApp();
    } finally {
      if (prev === undefined) delete process.env.FEED_DUPLICATE_MINUTES;
      else process.env.FEED_DUPLICATE_MINUTES = prev;
    }
    try {
      assert.equal(other.app.duplicateMinutes, 2);
      const t0 = Date.now();
      assert.equal((await other.api('POST', '/api/feeds', { side: 'left', at: iso(t0 - 10 * MIN) })).status, 201);
      assert.equal((await other.api('POST', '/api/feeds', { side: 'left', at: iso(t0 - 7 * MIN) })).status, 201);
      assert.equal((await other.api('POST', '/api/feeds', { side: 'left', at: iso(t0 - 6 * MIN) })).status, 409);
    } finally {
      await other.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('Windeln /api/diapers', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('POST validation', async () => {
    const { api } = ctx;
    for (const body of [{}, { kind: 'poop' }, { kind: 'wet', at: 'nope' }, { kind: 'wet', at: iso(Date.now() + 10 * MIN) }, { kind: 'wet', note: 5 }]) {
      const r = await api('POST', '/api/diapers', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.json.error, 'string');
    }
  });

  test('CRUD, ordering, no duplicate protection, CSV', async () => {
    const { api } = ctx;
    const t0 = Date.now();
    const a = await api('POST', '/api/diapers', { kind: 'wet', at: iso(t0 - 60 * MIN), note: ' nass ' });
    assert.equal(a.status, 201);
    assert.equal(a.json.diaper.kind, 'wet');
    assert.equal(a.json.diaper.note, 'nass');
    assert.deepEqual(Object.keys(a.json.diaper).sort(), ['at', 'created_at', 'id', 'kind', 'note', 'updated_at']);

    // two diapers one minute apart are fine
    const b = await api('POST', '/api/diapers', { kind: 'dirty', at: iso(t0 - 59 * MIN) });
    assert.equal(b.status, 201);
    const c = await api('POST', '/api/diapers', { kind: 'wet' });
    assert.equal(c.status, 201);
    assert.ok(Math.abs(Date.parse(c.json.diaper.at) - Date.now()) < 5000);

    let r = await api('GET', '/api/diapers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.diapers.map((d) => d.id), [c.json.diaper.id, b.json.diaper.id, a.json.diaper.id]);

    r = await api('GET', '/api/diapers?limit=1');
    assert.equal(r.json.diapers.length, 1);
    r = await api('GET', `/api/diapers?before=${encodeURIComponent(iso(t0 - 59 * MIN))}`);
    assert.deepEqual(r.json.diapers.map((d) => d.id), [a.json.diaper.id]);
    assert.equal((await api('GET', '/api/diapers?before=garbage')).status, 400);
    assert.equal((await api('GET', '/api/diapers?limit=x')).status, 400);

    r = await api('PATCH', `/api/diapers/${b.json.diaper.id}`, { kind: 'wet', note: 'Komma, "Zitat"' });
    assert.equal(r.status, 200);
    assert.equal(r.json.diaper.kind, 'wet');
    assert.equal(r.json.diaper.at, b.json.diaper.at);
    assert.equal((await api('PATCH', `/api/diapers/${b.json.diaper.id}`, { kind: 'x' })).status, 400);
    assert.equal((await api('PATCH', `/api/diapers/${b.json.diaper.id}`, {})).status, 400);
    assert.equal((await api('PATCH', '/api/diapers/99999', { kind: 'wet' })).status, 404);
    r = await api('PATCH', `/api/diapers/${b.json.diaper.id}`, { kind: 'dirty' });
    assert.equal(r.json.diaper.kind, 'dirty');

    const csv = await api('GET', '/api/export.csv?what=diapers');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="boobo-windeln.csv"');
    const lines = csv.text.split('\r\n');
    assert.equal(lines[0], 'id,kind,at,note');
    assert.equal(lines[1], `${a.json.diaper.id},wet,${a.json.diaper.at},nass`);
    assert.equal(lines[2], `${b.json.diaper.id},dirty,${b.json.diaper.at},"Komma, ""Zitat"""`);
    assert.equal(lines.length, 5); // header + 3 rows + trailing empty

    // feeds export unchanged without `what`; unknown `what` → 400
    const feedsCsv = await api('GET', '/api/export.csv');
    assert.equal(feedsCsv.headers.get('content-disposition'), 'attachment; filename="boobo-export.csv"');
    assert.equal(feedsCsv.text.split('\r\n')[0], 'id,side,at,note');
    assert.equal((await api('GET', '/api/export.csv?what=nope')).status, 400);

    r = await api('DELETE', `/api/diapers/${c.json.diaper.id}`);
    assert.equal(r.status, 204);
    assert.equal((await api('DELETE', `/api/diapers/${c.json.diaper.id}`)).status, 404);
    assert.equal((await api('DELETE', '/api/diapers/abc')).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('summary_24h in GET /api/state', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  test('empty → null gaps and zero counts; existing fields still there', async () => {
    const r = await ctx.api('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.summary_24h, {
      feeds: 0,
      breast: 0,
      bottle: 0,
      longest_gap_minutes: null,
      avg_gap_minutes: null,
      diapers_wet: 0,
      diapers_dirty: 0,
    });
    for (const k of ['now', 'interval_minutes', 'last', 'minutes_since_last', 'next_due_at', 'minutes_until_due', 'overdue', 'suggested_side', 'today_count', 'last_24h_count']) {
      assert.ok(k in r.json, k);
    }
  });

  test('single entry: longest = running gap, avg null', async () => {
    const { api } = ctx;
    const t0 = Date.now();
    const f = await api('POST', '/api/feeds', { side: 'left', at: iso(t0 - 50 * MIN) });
    const s = (await api('GET', '/api/state')).json.summary_24h;
    assert.equal(s.feeds, 1);
    assert.equal(s.longest_gap_minutes, 50);
    assert.equal(s.avg_gap_minutes, null);
    await api('DELETE', `/api/feeds/${f.json.feed.id}`);
  });

  test('longest gap includes the running gap, avg excludes it, window is 24 h', async () => {
    const { api } = ctx;
    const t0 = Date.now();
    const post = async (side, minutesAgo) => {
      const r = await api('POST', '/api/feeds', { side, at: iso(t0 - minutesAgo * MIN), on_duplicate: 'force' });
      assert.equal(r.status, 201);
    };
    // outside the window (must be ignored, also for gaps)
    await post('left', 25 * 60);
    // inside: gaps 60, 220, 60 → avg ≈ 113.33 → 113, longest 220 (running gap is only 60)
    await post('right', 400);
    await post('bottle', 340);
    await post('left', 120);
    await post('both', 60);
    let s = (await api('GET', '/api/state')).json.summary_24h;
    assert.equal(s.feeds, 4);
    assert.equal(s.breast, 3);
    assert.equal(s.bottle, 1);
    assert.equal(s.longest_gap_minutes, 220);
    assert.equal(s.avg_gap_minutes, Math.round((60 + 220 + 60) / 3));

    // make the running gap the longest: delete the last two entries → running gap since 340 min ago
    const feeds = (await api('GET', '/api/feeds?limit=2')).json.feeds;
    for (const f of feeds) await api('DELETE', `/api/feeds/${f.id}`);
    s = (await api('GET', '/api/state')).json.summary_24h;
    assert.equal(s.feeds, 2);
    assert.equal(s.longest_gap_minutes, 340);
    assert.equal(s.avg_gap_minutes, 60);

    // diapers in/out of the window
    await api('POST', '/api/diapers', { kind: 'wet', at: iso(t0 - 30 * MIN) });
    await api('POST', '/api/diapers', { kind: 'wet', at: iso(t0 - 90 * MIN) });
    await api('POST', '/api/diapers', { kind: 'dirty', at: iso(t0 - 100 * MIN) });
    await api('POST', '/api/diapers', { kind: 'dirty', at: iso(t0 - 25 * HOUR) });
    s = (await api('GET', '/api/state')).json.summary_24h;
    assert.equal(s.diapers_wet, 2);
    assert.equal(s.diapers_dirty, 1);
  });
});

// ---------------------------------------------------------------------------
describe('Medikamente', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.stop());

  const byName = async (name) => {
    const r = await ctx.api('GET', '/api/medications');
    return r.json.medications.find((m) => m.name === name);
  };

  test('seeds and initial status', async () => {
    const r = await ctx.api('GET', '/api/medications');
    assert.equal(r.status, 200);
    assert.ok(!Number.isNaN(Date.parse(r.json.now)));
    const meds = r.json.medications;
    assert.deepEqual(
      meds.map((m) => [m.name, m.dose, m.max_per_day, m.min_gap_minutes, m.sort_order]),
      [
        ['Paracetamol', '1 g', 4, 360, 1],
        ['Ibuprofen', '400 mg', 4, 360, 2],
        ['Magenschutz (PPI)', '1 Tablette', 1, 1200, 3],
      ],
    );
    for (const m of meds) {
      assert.deepEqual(Object.keys(m).sort(), [
        'active', 'dose', 'due', 'id', 'last_at', 'max_per_day', 'min_gap_minutes', 'minutes_until_possible',
        'name', 'next_possible_at', 'possible_now', 'remaining_24h', 'reminder', 'sort_order', 'taken_24h',
      ].sort());
      assert.equal(m.active, true);
      assert.equal(m.last_at, null);
      assert.equal(m.taken_24h, 0);
      assert.equal(m.remaining_24h, m.max_per_day);
      assert.equal(m.possible_now, true);
      assert.equal(m.next_possible_at, null);
      assert.equal(m.minutes_until_possible, null);
      assert.equal(m.due, false, 'first intake is never reminded');
    }
    const state = (await ctx.api('GET', '/api/state')).json;
    assert.equal(state.medications.length, 3);
    assert.deepEqual(state.medications_due, []);
  });

  test('seeds only once (marker), also after deleting all and reopening', async () => {
    const meds = (await ctx.api('GET', '/api/medications')).json.medications;
    const tmp = await startApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-r2-')) });
    try {
      for (const m of (await tmp.api('GET', '/api/medications')).json.medications) {
        assert.equal((await tmp.api('DELETE', `/api/medications/${m.id}`)).status, 204);
      }
      await tmp.app.close();
      const reopened = await startApp({ dataDir: tmp.dataDir });
      try {
        assert.deepEqual((await reopened.api('GET', '/api/medications')).json.medications, []);
      } finally {
        await reopened.app.close();
      }
    } finally {
      fs.rmSync(tmp.dataDir, { recursive: true, force: true });
    }
    assert.equal(meds.length, 3);
  });

  test('possible_now after the gap, due, next_possible_at during the gap', async () => {
    const { api } = ctx;
    const para = await byName('Paracetamol');
    const t0 = Date.now();
    let r = await api('POST', `/api/medications/${para.id}/intakes`, { at: iso(t0 - 400 * MIN), note: 'früh' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json.intake).sort(), ['at', 'created_at', 'id', 'medication_id', 'note']);
    assert.equal(r.json.intake.medication_id, para.id);
    assert.equal(r.json.intake.note, 'früh');
    let m = r.json.medication;
    assert.equal(m.taken_24h, 1);
    assert.equal(m.remaining_24h, 3);
    assert.equal(m.possible_now, true);
    assert.equal(m.next_possible_at, null);
    assert.equal(m.minutes_until_possible, null);
    assert.equal(m.due, true);
    assert.equal(m.last_at, iso(t0 - 400 * MIN));

    let state = (await api('GET', '/api/state')).json;
    assert.deepEqual(state.medications_due, ['Paracetamol 1 g']);
    const sp = state.medications.find((x) => x.id === para.id);
    assert.deepEqual(Object.keys(sp).sort(), ['dose', 'due', 'id', 'name', 'next_possible_at', 'possible_now', 'remaining_24h', 'reminder', 'taken_24h'].sort());
    assert.equal(sp.due, true);

    const second = iso(t0 - 100 * MIN);
    r = await api('POST', `/api/medications/${para.id}/intakes`, { at: second });
    assert.equal(r.status, 201);
    m = r.json.medication;
    assert.equal(m.taken_24h, 2);
    assert.equal(m.remaining_24h, 2);
    assert.equal(m.possible_now, false);
    assert.equal(m.next_possible_at, iso(Date.parse(second) + 360 * MIN));
    assert.ok(m.minutes_until_possible >= 259 && m.minutes_until_possible <= 260, String(m.minutes_until_possible));
    assert.equal(m.due, false);

    state = (await api('GET', '/api/state')).json;
    assert.deepEqual(state.medications_due, []);
  });

  test('remaining_24h = 0 → next_possible_at = oldest intake in window + 24 h', async () => {
    const { api } = ctx;
    const r0 = await api('POST', '/api/medications', { name: '  Testmittel ', max_per_day: 2, min_gap_minutes: 60 });
    assert.equal(r0.status, 201);
    const med = r0.json.medication;
    assert.equal(med.name, 'Testmittel');
    assert.equal(med.dose, null);
    assert.equal(med.sort_order, 4);
    assert.equal(med.active, true);

    const t0 = Date.now();
    // an intake older than 24 h does not count
    assert.equal((await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t0 - 30 * HOUR) })).status, 201);
    const oldest = iso(t0 - 300 * MIN);
    assert.equal((await api('POST', `/api/medications/${med.id}/intakes`, { at: oldest })).status, 201);
    const r = await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t0 - 120 * MIN) });
    assert.equal(r.status, 201);
    const m = r.json.medication;
    assert.equal(m.taken_24h, 2);
    assert.equal(m.remaining_24h, 0);
    assert.equal(m.possible_now, false);
    assert.equal(m.next_possible_at, iso(Date.parse(oldest) + 24 * HOUR));
    const expectedMinutes = Math.ceil((Date.parse(oldest) + 24 * HOUR - Date.now()) / MIN);
    assert.ok(Math.abs(m.minutes_until_possible - expectedMinutes) <= 1);
    assert.equal(m.due, false);

    // unlimited medication: remaining null, only the gap counts
    const free = (await api('POST', '/api/medications', { name: 'Globuli', dose: '3 Stück' })).json.medication;
    assert.equal(free.max_per_day, null);
    assert.equal(free.min_gap_minutes, 0);
    assert.equal(free.remaining_24h, null);
    const fr = await api('POST', `/api/medications/${free.id}/intakes`, { at: iso(t0 - 1 * MIN) });
    assert.equal(fr.json.medication.remaining_24h, null);
    assert.equal(fr.json.medication.possible_now, true);
    assert.equal(fr.json.medication.due, true);
  });

  test('due rule: 36 h boundary and paused medications', async () => {
    const { api } = ctx;
    const ibu = await byName('Ibuprofen');
    const t0 = Date.now();
    let r = await api('POST', `/api/medications/${ibu.id}/intakes`, { at: iso(t0 - 36 * HOUR + 2 * MIN) });
    assert.equal(r.status, 201);
    assert.equal(r.json.medication.possible_now, true);
    assert.equal(r.json.medication.taken_24h, 0);
    assert.equal(r.json.medication.due, true, 'just under 36 h → still due');

    const intakeId = r.json.intake.id;
    assert.equal((await api('DELETE', `/api/med-intakes/${intakeId}`)).status, 204);
    r = await api('POST', `/api/medications/${ibu.id}/intakes`, { at: iso(t0 - 36 * HOUR - 1 * MIN) });
    assert.equal(r.json.medication.possible_now, true);
    assert.equal(r.json.medication.due, false, 'over 36 h → considered discontinued');

    // a recent intake again → due; then pause → not due, not in state
    r = await api('POST', `/api/medications/${ibu.id}/intakes`, { at: iso(t0 - 7 * HOUR) });
    assert.equal(r.json.medication.due, true);
    let state = (await api('GET', '/api/state')).json;
    assert.ok(state.medications_due.includes('Ibuprofen 400 mg'));

    r = await api('PATCH', `/api/medications/${ibu.id}`, { active: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.medication.active, false);
    assert.equal(r.json.medication.possible_now, true);
    assert.equal(r.json.medication.due, false);
    state = (await api('GET', '/api/state')).json;
    assert.ok(!state.medications.some((m) => m.id === ibu.id));
    assert.ok(!state.medications_due.includes('Ibuprofen 400 mg'));
    // GET /api/medications still lists paused ones
    assert.ok((await api('GET', '/api/medications')).json.medications.some((m) => m.id === ibu.id));

    r = await api('PATCH', `/api/medications/${ibu.id}`, { active: true });
    assert.equal(r.json.medication.due, true);
  });

  test('PATCH /api/med-intakes/:id moves the time and recomputes the medication status', async () => {
    const { api } = ctx;
    const med = (await api('POST', '/api/medications', { name: 'Zink', max_per_day: 2, min_gap_minutes: 360 })).json.medication;
    const t0 = Date.now();
    // "Genommen" pressed late: logged now, actually taken 7 h ago
    let r = await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t0 - 1 * MIN) });
    assert.equal(r.status, 201);
    assert.equal(r.json.medication.possible_now, false);
    const intake = r.json.intake;

    r = await api('GET', `/api/med-intakes/${intake.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.intake, intake);

    r = await api('PATCH', `/api/med-intakes/${intake.id}`, { at: iso(t0 - 7 * HOUR) });
    assert.equal(r.status, 200);
    assert.equal(r.json.intake.id, intake.id);
    assert.equal(r.json.intake.at, iso(t0 - 7 * HOUR));
    assert.equal(r.json.intake.created_at, intake.created_at, 'created_at stays');
    assert.equal(r.json.medication.id, med.id);
    assert.equal(r.json.medication.possible_now, true, 'gap of 6 h is over after moving the intake back');
    assert.equal(r.json.medication.taken_24h, 1);

    // note only, time untouched
    r = await api('PATCH', `/api/med-intakes/${intake.id}`, { note: 'nachgetragen' });
    assert.equal(r.status, 200);
    assert.equal(r.json.intake.note, 'nachgetragen');
    assert.equal(r.json.intake.at, iso(t0 - 7 * HOUR));
    const listed = (await api('GET', `/api/med-intakes?medication_id=${med.id}`)).json.intakes;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].at, iso(t0 - 7 * HOUR));

    // validation
    assert.equal((await api('PATCH', `/api/med-intakes/${intake.id}`, {})).status, 400);
    assert.equal((await api('PATCH', `/api/med-intakes/${intake.id}`, { at: 'gestern' })).status, 400);
    assert.equal((await api('PATCH', `/api/med-intakes/${intake.id}`, { at: iso(t0 + HOUR) })).status, 400, 'future');
    assert.equal((await api('PATCH', '/api/med-intakes/999999', { at: iso(t0) })).status, 404);
    assert.equal((await api('GET', '/api/med-intakes/999999')).status, 404);
    assert.equal((await api('DELETE', `/api/medications/${med.id}`)).status, 204);
  });

  test('intake duplicate protection: ask 409, skip 200, force 201, per medication', async () => {
    const { api } = ctx;
    const ppi = await byName('Magenschutz (PPI)');
    const para = await byName('Paracetamol');
    const t0 = Date.now();
    const first = await api('POST', `/api/medications/${ppi.id}/intakes`, { at: iso(t0 - 20 * MIN) });
    assert.equal(first.status, 201);

    let r = await api('POST', `/api/medications/${ppi.id}/intakes`, { at: iso(t0 - 15 * MIN) });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'duplicate');
    assert.deepEqual(r.json.existing, first.json.intake);

    r = await api('POST', `/api/medications/${ppi.id}/intakes`, { at: iso(t0 - 15 * MIN), on_duplicate: 'skip' });
    assert.equal(r.status, 200);
    assert.equal(r.json.intake, null);
    assert.equal(r.json.skipped, true);
    assert.deepEqual(r.json.existing, first.json.intake);

    let list = await api('GET', `/api/med-intakes?medication_id=${ppi.id}`);
    assert.equal(list.json.intakes.length, 1);

    // taking before next_possible_at is not blocked by the server (with force)
    r = await api('POST', `/api/medications/${ppi.id}/intakes`, { at: iso(t0 - 15 * MIN), on_duplicate: 'force' });
    assert.equal(r.status, 201);
    assert.equal(r.json.medication.taken_24h, 2);
    assert.equal(r.json.medication.remaining_24h, 0);

    // other medication at the same time is not a duplicate
    r = await api('POST', `/api/medications/${para.id}/intakes`, { at: iso(t0 - 15 * MIN), on_duplicate: 'force' });
    assert.equal(r.status, 201);

    // validation and 404
    assert.equal((await api('POST', `/api/medications/${ppi.id}/intakes`, { on_duplicate: 'x' })).status, 400);
    assert.equal((await api('POST', `/api/medications/${ppi.id}/intakes`, { at: iso(Date.now() + 10 * MIN) })).status, 400);
    assert.equal((await api('POST', `/api/medications/${ppi.id}/intakes`, { at: 'bad' })).status, 400);
    assert.equal((await api('POST', '/api/medications/99999/intakes', {})).status, 404);
    list = await api('GET', `/api/med-intakes?medication_id=${ppi.id}`);
    assert.equal(list.json.intakes.length, 2);
  });

  test('GET /api/med-intakes list, filters, limit, before; DELETE', async () => {
    const { api } = ctx;
    let r = await api('GET', '/api/med-intakes');
    assert.equal(r.status, 200);
    const all = r.json.intakes;
    assert.ok(all.length >= 8);
    const ats = all.map((i) => i.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    for (const i of all) {
      assert.deepEqual(Object.keys(i).sort(), ['at', 'created_at', 'dose', 'id', 'medication_id', 'name', 'note']);
    }
    const para = await byName('Paracetamol');
    r = await api('GET', `/api/med-intakes?medication_id=${para.id}`);
    assert.ok(r.json.intakes.length >= 2);
    assert.ok(r.json.intakes.every((i) => i.medication_id === para.id && i.name === 'Paracetamol' && i.dose === '1 g'));

    r = await api('GET', '/api/med-intakes?limit=2');
    assert.equal(r.json.intakes.length, 2);
    assert.deepEqual(r.json.intakes, all.slice(0, 2));

    const cut = all[2].at;
    r = await api('GET', `/api/med-intakes?before=${encodeURIComponent(cut)}`);
    assert.ok(r.json.intakes.every((i) => i.at < cut));
    r = await api('GET', `/api/med-intakes?before=${encodeURIComponent(cut)}&medication_id=${para.id}&limit=1`);
    assert.ok(r.json.intakes.length <= 1);
    assert.ok(r.json.intakes.every((i) => i.at < cut && i.medication_id === para.id));

    assert.equal((await api('GET', '/api/med-intakes?medication_id=abc')).status, 400);
    assert.equal((await api('GET', '/api/med-intakes?before=garbage')).status, 400);
    assert.equal((await api('GET', '/api/med-intakes?limit=0')).status, 400);

    const victim = all[0];
    assert.equal((await api('DELETE', `/api/med-intakes/${victim.id}`)).status, 204);
    assert.equal((await api('DELETE', `/api/med-intakes/${victim.id}`)).status, 404);
    assert.equal((await api('DELETE', '/api/med-intakes/abc')).status, 404);
    r = await api('GET', '/api/med-intakes');
    assert.equal(r.json.intakes.length, all.length - 1);
  });

  test('CSV ?what=intakes', async () => {
    const { api } = ctx;
    const ppi = await byName('Magenschutz (PPI)');
    const noted = await api('POST', `/api/medications/${ppi.id}/intakes`, {
      at: iso(Date.now() - 50 * HOUR),
      note: 'mit "Wasser", viel',
    });
    assert.equal(noted.status, 201);
    const r = await api('GET', '/api/export.csv?what=intakes');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="boobo-medikamente.csv"');
    const lines = r.text.split('\r\n');
    assert.equal(lines[0], 'id,medication,dose,at,note');
    // oldest first → the 50 h old intake is the first data row
    assert.equal(lines[1], `${noted.json.intake.id},Magenschutz (PPI),1 Tablette,${noted.json.intake.at},"mit ""Wasser"", viel"`);
    assert.equal(lines.at(-1), '');
  });

  test('POST/PATCH validation', async () => {
    const { api } = ctx;
    const bad = [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(61) },
      { name: 42 },
      { name: 'A', dose: 'x'.repeat(41) },
      { name: 'A', dose: 3 },
      { name: 'A', max_per_day: 0 },
      { name: 'A', max_per_day: 25 },
      { name: 'A', max_per_day: 1.5 },
      { name: 'A', max_per_day: '2' },
      { name: 'A', min_gap_minutes: -1 },
      { name: 'A', min_gap_minutes: 10081 },
      { name: 'A', min_gap_minutes: 30.5 },
    ];
    for (const body of bad) {
      const r = await api('POST', '/api/medications', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.json.error, 'string');
    }
    let r = await api('POST', '/api/medications', { name: 'x'.repeat(60), dose: 'y'.repeat(40), max_per_day: 24, min_gap_minutes: 10080 });
    assert.equal(r.status, 201);
    const id = r.json.medication.id;

    r = await api('PATCH', `/api/medications/${id}`, { name: 'Eisen', dose: null, max_per_day: null, min_gap_minutes: 0, sort_order: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.medication.name, 'Eisen');
    assert.equal(r.json.medication.dose, null);
    assert.equal(r.json.medication.max_per_day, null);
    assert.equal(r.json.medication.min_gap_minutes, 0);
    assert.equal(r.json.medication.sort_order, -1);
    // sort_order moves it to the front
    const list = (await api('GET', '/api/medications')).json.medications;
    assert.equal(list[0].id, id);

    for (const body of [{}, { name: '' }, { min_gap_minutes: null }, { active: 'yes' }, { sort_order: 1.5 }, { max_per_day: 30 }]) {
      r = await api('PATCH', `/api/medications/${id}`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await api('PATCH', '/api/medications/99999', { name: 'X' })).status, 404);
    assert.equal((await api('DELETE', '/api/medications/99999')).status, 404);
    assert.equal((await api('DELETE', `/api/medications/${id}`)).status, 204);
  });

  test('more intakes than max_per_day → next_possible_at waits until enough have left the window', async () => {
    const { api } = ctx;
    const med = (await api('POST', '/api/medications', { name: 'Vielnehmer', max_per_day: 2, min_gap_minutes: 0 })).json.medication;
    const t0 = Date.now();
    const times = [t0 - 20 * HOUR, t0 - 18 * HOUR, t0 - 16 * HOUR];
    for (const t of times) assert.equal((await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t), on_duplicate: 'force' })).status, 201);
    const m = (await api('GET', '/api/medications')).json.medications.find((x) => x.id === med.id);
    assert.equal(m.taken_24h, 3);
    assert.equal(m.remaining_24h, 0);
    // Erst wenn zwei Einnahmen aus dem Fenster gefallen sind, ist wieder eine erlaubt: zweitälteste + 24 h
    assert.equal(m.next_possible_at, iso(times[1] + 24 * HOUR));
    assert.equal((await api('DELETE', `/api/medications/${med.id}`)).status, 204);
  });

  test('DELETE medication cascades to its intakes', async () => {
    const { api } = ctx;
    const med = (await api('POST', '/api/medications', { name: 'Kurzzeit', min_gap_minutes: 30 })).json.medication;
    const t0 = Date.now();
    await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t0 - 100 * MIN) });
    await api('POST', `/api/medications/${med.id}/intakes`, { at: iso(t0 - 50 * MIN) });
    assert.equal((await api('GET', `/api/med-intakes?medication_id=${med.id}`)).json.intakes.length, 2);
    const before = (await api('GET', '/api/med-intakes?limit=500')).json.intakes.length;

    assert.equal((await api('DELETE', `/api/medications/${med.id}`)).status, 204);
    assert.equal((await api('GET', `/api/med-intakes?medication_id=${med.id}`)).json.intakes.length, 0);
    assert.equal((await api('GET', '/api/med-intakes?limit=500')).json.intakes.length, before - 2);
    const left = ctx.app.db.prepare('SELECT COUNT(*) AS n FROM med_intakes WHERE medication_id = ?').get(med.id);
    assert.equal(Number(left.n), 0);
    assert.equal((await api('POST', `/api/medications/${med.id}/intakes`, {})).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('Migration from a round-1 database (feeds + settings only)', () => {
  test('opens cleanly, keeps data, adds tables and seeds', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-r2-mig-'));
    const old = new DatabaseSync(path.join(dataDir, 'boobo.db'));
    old.exec(`
      CREATE TABLE feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, at TEXT NOT NULL, note TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_feeds_at ON feeds(at);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const at = new Date(Date.now() - 90 * MIN).toISOString();
    old.prepare('INSERT INTO feeds (side, at, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('left', at, 'alt', at, at);
    old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('interval_minutes', '150');
    old.close();

    const ctx = await startApp({ dataDir });
    try {
      const state = (await ctx.api('GET', '/api/state')).json;
      assert.equal(state.interval_minutes, 150);
      assert.equal(state.last.note, 'alt');
      assert.equal(state.summary_24h.feeds, 1);
      assert.equal(state.medications.length, 3);
      assert.equal((await ctx.api('GET', '/api/feeds')).json.feeds.length, 1);
      assert.equal((await ctx.api('POST', '/api/diapers', { kind: 'wet' })).status, 201);
      const tables = ctx.app.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((r) => r.name);
      assert.deepEqual(tables, ['diapers', 'feeds', 'growth_refs', 'measurements', 'med_intakes', 'medications', 'push_subscriptions', 'settings']);
      assert.equal(ctx.app.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(ctx.app.db.prepare("SELECT value FROM settings WHERE key = 'meds_seeded'").get().value, '1');
    } finally {
      await ctx.stop();
    }
  });
});

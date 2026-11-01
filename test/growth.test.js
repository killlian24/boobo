// Tests for docs/API.md „Erweiterung 4“: Wachstum, Perzentilen, Zielgröße, Kurven-Import.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server.js';
import * as growth from '../lib/growth.js';

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boobo-growth-'));
  const app = createServer({ intervalMinutes: 180, log: () => {}, dataDir, httpsPort: 0 });
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
  return {
    app, api,
    stop: async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

const ymd = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

describe('lib/growth: LMS-Rechnung gegen WHO-Tabellen', () => {
  const refs = growth.loadBuiltinRefs(path.join(import.meta.dirname, '..', 'growth'));
  const who = refs.get('who');

  test('WHO Jungen bei Geburt: P3 2,5 kg, P50 3,3 kg, P97 4,3 kg (WHO-Perzentiltabelle)', () => {
    const lms = growth.lmsAt(who.measures.weight.male, 0);
    assert.equal(growth.valueAtZ(-1.880794, lms).toFixed(1), '2.5');
    assert.equal(growth.valueAtZ(0, lms).toFixed(1), '3.3');
    assert.equal(growth.valueAtZ(1.880794, lms).toFixed(1), '4.3');
  });

  test('z-Score und Perzentile sind konsistent', () => {
    const lms = growth.lmsAt(who.measures.length.female, 365);
    assert.equal(growth.zScore(lms.M, lms), 0);
    assert.ok(Math.abs(growth.normCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(growth.normCdf(1.959964) - 0.975) < 1e-6);
    const x = growth.valueAtZ(1.2, lms);
    assert.ok(Math.abs(growth.zScore(x, lms) - 1.2) < 1e-9);
  });

  test('WHO-Regel jenseits ±3 SD ist stetig und umkehrbar', () => {
    const lms = growth.lmsAt(who.measures.weight.female, 120);
    for (const z of [-4, -3.5, 3.5, 4.2]) {
      assert.ok(Math.abs(growth.zScore(growth.valueAtZ(z, lms), lms) - z) < 1e-9, `z=${z}`);
    }
  });

  test('Tanner und Hermanussen-Cole', () => {
    const t = growth.targetHeight({ sex: 'male', mother_height_cm: 168, father_height_cm: 185 }, who);
    assert.deepEqual(t.tanner, { cm: 183, min_cm: 174.5, max_cm: 191.5 });
    assert.ok(t.sds.sds > 0 && t.sds.cm > 176 && t.sds.cm < 183);
    const g = growth.targetHeight({ sex: 'female', mother_height_cm: 160, father_height_cm: 170 }, who);
    assert.equal(g.tanner.cm, 158.5);
    assert.equal(growth.targetHeight({ sex: 'female' }, who), null);
  });

  test('Dänemark: Werte der Supplement-Tabellen S2, S3, S6 und glatte Interpolation', () => {
    const dk = refs.get('dk');
    const w0 = growth.lmsAt(dk.measures.weight.male, 0);
    assert.deepEqual([w0.L, w0.M, w0.S], [0.8076, 3.2987, 0.1373]);
    const l1 = growth.lmsAt(dk.measures.length.female, 365.25);
    assert.deepEqual([l1.L, l1.M, l1.S], [1, 75.0056, 0.0346]);
    const hc = growth.lmsAt(dk.measures.hc.male, 0);
    assert.equal(hc.M, 34.65);
    // gedruckte +2 SD Gewicht Mädchen bei 6 Monaten: 9,70 kg
    assert.equal(growth.valueAtZ(2, growth.lmsAt(dk.measures.weight.female, 0.5 * 365.25)).toFixed(2), '9.70');
    // zwischen den Stützstellen monoton und oberhalb der Geraden (Wachstum flacht ab)
    const m = [0, 15, 30, 45, 60, 91.31].map((d) => growth.lmsAt(dk.measures.weight.male, d).M);
    for (let i = 1; i < m.length; i++) assert.ok(m[i] > m[i - 1]);
    assert.ok(m[2] > 3.2987 + (6.4513 - 3.2987) * 30 / 91.31);
    assert.deepEqual(dk.adult_height.male, [1, 181.1975, 0.0356]);
  });

  test('korrigiertes Alter bei Geburt vor 37+0', () => {
    assert.equal(growth.correctionDays({ gestation_weeks: 34, gestation_days: 2 }), 280 - 240);
    assert.equal(growth.correctionDays({ gestation_weeks: 38, gestation_days: 0 }), 0);
    assert.equal(growth.plotAge({ gestation_weeks: 34, gestation_days: 2 }, 100), 60);
    assert.equal(growth.plotAge({ gestation_weeks: 34, gestation_days: 2 }, 800), 800);
  });

  test('CSV-Import: deutsche/dänische Kopfzeilen, Semikolon, Dezimalkomma, Monate', () => {
    const csv = [
      'måling;køn;alder_mdr;nu;mu;sigma',
      'vægt;dreng;0;0,35;3,50;0,14',
      'vægt;dreng;1;0,30;4,60;0,13',
      'vægt;pige;0;0,38;3,40;0,14',
      'vægt;pige;1;0,33;4,30;0,13',
      'unbekannt;dreng;1;1;2;0,1',
    ].join('\n');
    const r = growth.parseCsvRef(csv);
    assert.equal(r.rows, 4);
    assert.deepEqual(r.measures.weight.male[1], [30.44, 0.3, 4.6, 0.13]);
    assert.throws(() => growth.parseCsvRef('a,b\n1,2\n3,4'), /Spalte/);
  });
});

describe('API /api/growth', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(() => ctx.stop());

  test('ohne Profil: leere Auswertung, Referenzen WHO, DE und DK gelistet', async () => {
    const r = await ctx.api('GET', '/api/growth');
    assert.equal(r.status, 200);
    assert.equal(r.json.ref.id, 'who');
    assert.equal(r.json.age_days, null);
    const ids = r.json.refs.map((x) => [x.id, x.available]);
    assert.deepEqual(ids, [['who', true], ['de', true], ['dk', true]]);
    assert.equal((await ctx.api('GET', '/api/state')).json.growth, null);
  });

  test('Profil anlegen, prüfen, teilweise ändern', async () => {
    let r = await ctx.api('PUT', '/api/growth/profile', { sex: 'girl' });
    assert.equal(r.status, 400);
    r = await ctx.api('PUT', '/api/growth/profile', { birth_date: '2099-01-01' });
    assert.equal(r.status, 400);
    r = await ctx.api('PUT', '/api/growth/profile', { ref: 'gibtsnicht' });
    assert.equal(r.status, 400, 'unbekannte Kurve');
    r = await ctx.api('PUT', '/api/growth/profile', {
      name: 'Bobo', sex: 'female', birth_date: ymd(30), gestation_weeks: 40, gestation_days: 1,
      birth_weight_g: 3400, birth_length_cm: 51, birth_hc_cm: 35, mother_height_cm: 168, father_height_cm: 185,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.profile.name, 'Bobo');
    r = await ctx.api('PATCH', '/api/growth/profile', { ref: 'de' });
    assert.equal(r.json.profile.ref, 'de');
    assert.equal(r.json.profile.birth_weight_g, 3400);
    r = await ctx.api('PATCH', '/api/growth/profile', { ref: null });
    assert.equal(r.json.profile.ref, null);
  });

  test('Messungen: anlegen, Validierung, ändern, löschen, Auswertung', async () => {
    assert.equal((await ctx.api('POST', '/api/growth/measurements', { date: ymd(27) })).status, 400);
    assert.equal((await ctx.api('POST', '/api/growth/measurements', { date: ymd(27), weight_g: 99 })).status, 400);
    assert.equal((await ctx.api('POST', '/api/growth/measurements', { date: ymd(27), weight_g: 3150, source: 'x' })).status, 400);
    const a = await ctx.api('POST', '/api/growth/measurements', { date: ymd(27), weight_g: 3150, source: 'nurse' });
    assert.equal(a.status, 201);
    const b = await ctx.api('POST', '/api/growth/measurements', { date: ymd(19), weight_g: 3420 });
    const c = await ctx.api('POST', '/api/growth/measurements', {
      date: ymd(2), weight_g: 4100, length_cm: 54.53, hc_cm: 37, source: 'nurse', note: 'Hausbesuch',
    });
    assert.equal(c.json.measurement.length_cm, 54.5);
    let r = await ctx.api('PATCH', `/api/growth/measurements/${b.json.measurement.id}`, { weight_g: 3430 });
    assert.equal(r.status, 200);
    assert.equal(r.json.measurement.weight_g, 3430);
    assert.equal((await ctx.api('PATCH', `/api/growth/measurements/${b.json.measurement.id}`, { weight_g: null })).status, 400);

    r = await ctx.api('GET', '/api/growth');
    const g = r.json;
    assert.equal(g.age_days, 30);
    assert.equal(g.measurements.length, 4, 'Geburt + 3 Messungen');
    assert.equal(g.measurements[0].id, 'birth');
    assert.ok(g.latest.weight.p > 0 && g.latest.weight.p < 100);
    assert.equal(g.latest.weight.value, 4100);
    assert.equal(g.gains.length, 3);
    assert.equal(g.gains[0].diff_g, -250);
    assert.equal(g.early.loss_pct, 7.4);
    assert.equal(g.early.regained_day, 11);
    assert.equal(g.velocity.length, 1, 'WHO 0-4 Wochen berechenbar');
    assert.equal(g.velocity[0].label, '0 - 4 wks');
    assert.ok(g.target.sds && g.target.tanner.cm === 170);
    assert.ok(g.curves.weight.lines.length === 5);
    assert.equal(g.range_days, 91);

    const de = (await ctx.api('GET', '/api/growth?ref=de&range_days=365')).json;
    assert.equal(de.ref.id, 'de');
    assert.equal(de.range_days, 365);
    assert.equal(de.velocity.length, 0);
    assert.equal(de.latest.hc.p, undefined, 'KiGGS-Kopfumfang erst ab 4 Monaten');

    const st = (await ctx.api('GET', '/api/state')).json.growth;
    assert.equal(st.weight_g, 4100);
    assert.equal(st.ref, 'who');

    const csv = await ctx.api('GET', '/api/export.csv?what=measurements');
    assert.match(csv.text, /^id,date,weight_g,length_cm,hc_cm,source,note\r\n/);
    assert.match(csv.text, /Hausbesuch/);

    assert.equal((await ctx.api('DELETE', `/api/growth/measurements/${a.json.measurement.id}`)).status, 204);
    assert.equal((await ctx.api('DELETE', `/api/growth/measurements/${a.json.measurement.id}`)).status, 404);
  });

  test('Dänische Kurven eingebaut: SD-Linien, Zielgröße mit 20 Jahren', async () => {
    const g = (await ctx.api('GET', '/api/growth?ref=dk')).json;
    assert.equal(g.ref.id, 'dk');
    assert.equal(g.ref.builtin, true);
    assert.deepEqual(g.ref.measures, ['weight', 'length', 'hc']);
    assert.equal(g.lines[0].label, '−2 SD');
    assert.ok(g.latest.weight.p > 0 && g.latest.hc.p > 0);
    assert.equal(g.target.sds.adult_age_years, 20);
    assert.equal((await ctx.api('POST', '/api/growth/refs', { id: 'dk', csv: 'a,b\n1,2\n3,4' })).status, 400, 'eingebaut');
  });

  test('Import eigener Kurven per CSV, Ergänzen, Auswahl, Löschen', async () => {
    const rows = ['measure,sex,age_days,L,M,S'];
    for (const sex of ['male', 'female']) {
      for (let d = 0; d <= 730; d += 30) rows.push(`weight,${sex},${d},0.2,${(3.5 + d * 0.01).toFixed(3)},0.12`);
    }
    let r = await ctx.api('POST', '/api/growth/refs', { id: 'meine', name: 'Meine Kurve', csv: rows.join('\n') });
    assert.equal(r.status, 201);
    assert.equal(r.json.ref.available, true);
    assert.deepEqual(r.json.ref.measures, ['weight']);
    assert.equal(r.json.ref.name, 'Meine Kurve');

    const len = ['measure,sex,age_years,L,M,S'];
    for (const sex of ['male', 'female']) for (let y = 0; y <= 20; y++) len.push(`length,${sex},${y},1,${50 + y * 6},0.04`);
    r = await ctx.api('POST', '/api/growth/refs', { id: 'meine', csv: len.join('\n') });
    assert.deepEqual(r.json.ref.measures, ['weight', 'length'], 'Länge ergänzt, Gewicht bleibt');
    assert.equal(r.json.ref.has_adult_height, true);

    assert.equal((await ctx.api('PATCH', '/api/growth/profile', { ref: 'meine' })).status, 200);
    const g = (await ctx.api('GET', '/api/growth')).json;
    assert.equal(g.ref.id, 'meine');
    assert.equal(g.lines[0].label, '−2 SD');
    assert.ok(g.latest.weight.p !== undefined);

    assert.equal((await ctx.api('POST', '/api/growth/refs', { id: 'who', csv: rows.join('\n') })).status, 400);
    assert.equal((await ctx.api('POST', '/api/growth/refs', { csv: 'foo,bar\n1,2\n3,4' })).status, 400);
    const own = await ctx.api('POST', '/api/growth/refs', { name: 'Test', csv: rows.join('\n') });
    assert.equal(own.json.ref.id, 'eigene-1');
    const again = await ctx.api('POST', '/api/growth/refs', { name: 'test', csv: len.join('\n') });
    assert.equal(again.json.ref.id, 'eigene-1', 'gleicher Name ergänzt dieselbe Kurve');
    assert.deepEqual(again.json.ref.measures, ['weight', 'length']);

    assert.equal((await ctx.api('DELETE', '/api/growth/refs/who')).status, 400);
    assert.equal((await ctx.api('DELETE', '/api/growth/refs/meine')).status, 204);
    assert.equal((await ctx.api('GET', '/api/growth/profile')).json.profile.ref, null);
    const after = (await ctx.api('GET', '/api/growth?ref=meine')).json;
    assert.equal(after.ref.id, 'who');
    assert.equal(after.ref_unavailable, 'meine');
  });
});

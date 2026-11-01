// Boobo – Wachstum: Perzentilen (LMS), Zunahme, Zielgröße, Import eigener Referenzkurven.
// Reine Funktionen ohne Abhängigkeiten. Vertrag: docs/API.md, Erweiterung 4.

import fs from 'node:fs';
import path from 'node:path';

export const MEASURES = ['weight', 'length', 'hc'];
export const SEXES = ['male', 'female'];
const DAY_MS = 24 * 3600 * 1000;
const TERM_DAYS = 280; // 40+0 SSW
const PRETERM_LIMIT_DAYS = 259; // < 37+0 SSW → korrigiertes Alter
const CORRECT_UNTIL_DAYS = 730; // korrigiertes Alter bis 2 Jahre (chronologisch)
const MONTH_DAYS = 30.4375;

// Perzentilen-Linien für importierte Kurven ohne eigene Angabe: Mittelwert ± 1 und 2 SD
export const SD_LINES = [
  { z: -2, label: '−2 SD' }, { z: -1, label: '−1 SD' }, { z: 0, label: '0' },
  { z: 1, label: '+1 SD' }, { z: 2, label: '+2 SD' },
];

// Platzhalter für die dänischen Kurven: Die LMS-Werte (Tinggaard et al. 2014) sind nicht frei
// verfügbar und werden über den Import eingespielt (Kennung "dk").
export const DK_PLACEHOLDER = {
  id: 'dk',
  name: 'Dänemark',
  title: 'Dänische Referenz 2014 (Tinggaard et al.)',
  kind: 'reference',
  description: 'Die Kurven, auf denen die Sundhedsplejerske einträgt. Die LMS-Tabelle steht im Online-Supplement von Acta Paediatrica und muss einmal importiert werden.',
  source: 'Tinggaard J, Aksglaede L, Sørensen K, et al. The 2014 Danish references from birth to 20 years for height, weight and body mass index. Acta Paediatr 2014;103:214-24. doi:10.1111/apa.12468',
  lines: SD_LINES,
};

// ---------------------------------------------------------------------------
// Statistik
// ---------------------------------------------------------------------------

// Standardnormalverteilung, Abramowitz & Stegun 26.2.17 (Fehler < 7.5e-8)
export function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

function lmsValue(z, { L, M, S }) {
  if (Math.abs(L) < 1e-9) return M * Math.exp(S * z);
  const base = 1 + L * S * z;
  if (base <= 0) return NaN;
  return M * Math.pow(base, 1 / L);
}

function lmsZ(x, { L, M, S }) {
  if (Math.abs(L) < 1e-9) return Math.log(x / M) / S;
  return (Math.pow(x / M, L) - 1) / (L * S);
}

// z-Score mit der WHO-Regel für |z| > 3 (lineare Fortsetzung über den Abstand der 2- und 3-SD-Linie),
// damit stark schiefe Verteilungen an den Rändern nicht verzerren.
export function zScore(x, lms) {
  if (!(x > 0) || !lms) return null;
  const z = lmsZ(x, lms);
  if (!Number.isFinite(z)) return null;
  if (Math.abs(lms.L - 1) < 1e-9 || Math.abs(z) <= 3) return z;
  if (z > 3) {
    const sd3 = lmsValue(3, lms);
    const sd23 = sd3 - lmsValue(2, lms);
    return 3 + (x - sd3) / sd23;
  }
  const sd3 = lmsValue(-3, lms);
  const sd23 = lmsValue(-2, lms) - sd3;
  return -3 + (x - sd3) / sd23;
}

export function valueAtZ(z, lms) {
  if (!lms) return null;
  if (Math.abs(lms.L - 1) < 1e-9 || Math.abs(z) <= 3) {
    const v = lmsValue(z, lms);
    return Number.isFinite(v) ? v : null;
  }
  const s = Math.sign(z);
  const sd3 = lmsValue(3 * s, lms);
  const sd2 = lmsValue(2 * s, lms);
  return sd3 + (z - 3 * s) * (sd3 - sd2) * s;
}

// LMS an einem Alter (Tage) linear zwischen den Tabellenzeilen [Tag, L, M, S]; außerhalb → null
export function lmsAt(rows, day) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isFinite(day)) return null;
  if (day < rows[0][0] - 1e-9 || day > rows[rows.length - 1][0] + 1e-9) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= day) lo = mid; else hi = mid;
  }
  const a = rows[lo];
  const b = rows[hi];
  if (day <= a[0] || b[0] === a[0]) return { L: a[1], M: a[2], S: a[3] };
  if (day >= b[0]) return { L: b[1], M: b[2], S: b[3] };
  const f = (day - a[0]) / (b[0] - a[0]);
  return { L: a[1] + f * (b[1] - a[1]), M: a[2] + f * (b[2] - a[2]), S: a[3] + f * (b[3] - a[3]) };
}

const round = (v, digits) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits)));

// ---------------------------------------------------------------------------
// Referenzen laden und prüfen
// ---------------------------------------------------------------------------

export function loadBuiltinRefs(dir) {
  const refs = new Map();
  for (const id of ['who', 'de']) {
    const file = path.join(dir, `${id}.json`);
    try {
      const ref = normalizeRef(JSON.parse(fs.readFileSync(file, 'utf8')));
      ref.builtin = true;
      refs.set(ref.id, ref);
    } catch (err) {
      console.error(`Wachstum: ${file} nicht lesbar – ${err.message}`);
    }
  }
  return refs;
}

// Bringt eine Referenz in die interne Form (sortierte Zeilen, Einheiten kg/cm) und prüft sie.
export function normalizeRef(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Referenz muss ein Objekt sein');
  const measures = {};
  for (const m of MEASURES) {
    const src = raw.measures && raw.measures[m];
    if (!src) continue;
    const entry = { unit: m === 'weight' ? 'kg' : 'cm' };
    for (const sex of SEXES) {
      const rows = (Array.isArray(src[sex]) ? src[sex] : [])
        .map((r) => r.map(Number))
        .filter((r) => r.length >= 4 && r.every(Number.isFinite) && r[0] >= 0 && r[2] > 0 && r[3] > 0)
        .sort((a, b) => a[0] - b[0]);
      if (m === 'weight' && rows.length && rows[0][2] > 100) for (const r of rows) r[2] /= 1000; // Gramm → kg
      if (rows.length >= 2) entry[sex] = rows;
    }
    if (entry.male || entry.female) measures[m] = entry;
  }
  if (!Object.keys(measures).length) throw new Error('Keine gültigen LMS-Zeilen gefunden');
  const adult = raw.adult_height && SEXES.every((s) => Array.isArray(raw.adult_height[s]))
    ? {
        age_years: Number(raw.adult_height.age_years) || null,
        male: raw.adult_height.male.map(Number),
        female: raw.adult_height.female.map(Number),
      }
    : deriveAdultHeight(measures);
  return {
    id: String(raw.id || ''),
    name: String(raw.name || raw.id || 'Eigene Kurve'),
    title: raw.title ? String(raw.title) : null,
    kind: raw.kind === 'standard' ? 'standard' : 'reference',
    description: raw.description ? String(raw.description) : null,
    source: raw.source ? String(raw.source) : null,
    lines: Array.isArray(raw.lines) && raw.lines.length ? raw.lines.map((l) => ({ z: Number(l.z), label: String(l.label) })) : SD_LINES,
    measures,
    adult_height: adult,
    velocity: raw.velocity || null,
  };
}

// Erwachsenengröße aus der Längen-/Größenkurve, wenn sie mindestens bis 18 Jahre reicht
function deriveAdultHeight(measures) {
  const len = measures.length;
  if (!len || !len.male || !len.female) return null;
  const out = { age_years: null };
  for (const sex of SEXES) {
    const last = len[sex][len[sex].length - 1];
    if (last[0] < 18 * 365.25 - 1) return null;
    out[sex] = [last[1], last[2], last[3]];
    out.age_years = Math.round((last[0] / 365.25) * 10) / 10;
  }
  return out;
}

export function refSummary(ref, available = true) {
  return {
    id: ref.id,
    name: ref.name,
    title: ref.title || null,
    kind: ref.kind || 'reference',
    description: ref.description || null,
    source: ref.source || null,
    builtin: !!ref.builtin,
    available,
    measures: ref.measures ? MEASURES.filter((m) => ref.measures[m]) : [],
    max_age_days: ref.measures
      ? Math.max(...MEASURES.flatMap((m) => SEXES.map((s) => ref.measures[m]?.[s]?.at(-1)?.[0] ?? 0)))
      : 0,
    has_velocity: !!(ref.velocity && ref.velocity.weight_1mon),
    has_adult_height: !!ref.adult_height,
  };
}

// ---------------------------------------------------------------------------
// Import (CSV oder JSON)
// ---------------------------------------------------------------------------

const MEASURE_ALIASES = {
  weight: 'weight', gewicht: 'weight', vaegt: 'weight', 'vægt': 'weight', wt: 'weight', wfa: 'weight',
  length: 'length', height: 'length', laenge: 'length', 'länge': 'length', groesse: 'length', 'größe': 'length',
  hoejde: 'length', 'højde': 'length', laengde: 'length', 'længde': 'length', ht: 'length', lfa: 'length', hfa: 'length',
  hc: 'hc', head: 'hc', kopfumfang: 'hc', kopf: 'hc', hovedomfang: 'hc', hoved: 'hc', hcfa: 'hc', ofc: 'hc',
};
const SEX_ALIASES = {
  m: 'male', male: 'male', boy: 'male', boys: 'male', junge: 'male', jungen: 'male', dreng: 'male', drenge: 'male', 1: 'male',
  f: 'female', w: 'female', female: 'female', girl: 'female', girls: 'female', 'mädchen': 'female', maedchen: 'female',
  pige: 'female', piger: 'female', k: 'female', 2: 'female',
};

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/^"|"$/g, '');
}

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function toNumber(raw, decimalComma) {
  let s = String(raw ?? '').trim().replace(/\s/g, '').replace('−', '-');
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
  if (s === '') return NaN;
  return Number(s);
}

// CSV: eine Zeile pro Alter, Spalten measure, sex, age (+ Einheit), L, M, S.
// Kopfzeilen dürfen deutsch, dänisch oder GAMLSS-Namen (nu/mu/sigma) tragen.
// Fehlen measure/sex als Spalten, können sie als Vorgabe (defaults) mitgegeben werden.
export function parseCsvRef(text, defaults = {}) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  if (lines.length < 3) throw new Error('Zu wenige Zeilen: Kopfzeile plus mindestens zwei Altersstufen');
  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const header = splitLine(first, delim).map(norm);
  const find = (...names) => header.findIndex((h) => names.includes(h));
  const col = {
    measure: find('measure', 'messung', 'messgröße', 'mass', 'maß', 'item', 'parameter', 'maal', 'mål', 'måling', 'maaling', 'variable'),
    sex: find('sex', 'geschlecht', 'gender', 'koen', 'køn'),
    L: find('l', 'nu', 'lambda'),
    M: find('m', 'mu', 'median'),
    S: find('s', 'sigma'),
  };
  let ageCol = -1;
  let ageFactor = 1;
  const ageNames = [
    [['age_days', 'days', 'tage', 'dage', 'alter_tage', 'alder_dage', 'day', 'tag'], 1],
    [['age_weeks', 'weeks', 'wochen', 'uger', 'alter_wochen', 'alder_uger'], 7],
    [['age_months', 'months', 'monate', 'maaneder', 'måneder', 'alter_monate', 'alder_mdr', 'mdr', 'month'], MONTH_DAYS],
    [['age_years', 'years', 'jahre', 'aar', 'år', 'alter_jahre', 'alder_aar', 'alder_år', 'age', 'alter', 'alder', 'year'], 365.25],
  ];
  for (const [names, factor] of ageNames) {
    const i = find(...names);
    if (i >= 0) { ageCol = i; ageFactor = factor; break; }
  }
  if (defaults.age_unit === 'days') ageFactor = 1;
  else if (defaults.age_unit === 'weeks') ageFactor = 7;
  else if (defaults.age_unit === 'months') ageFactor = MONTH_DAYS;
  else if (defaults.age_unit === 'years') ageFactor = 365.25;
  const missing = ['L', 'M', 'S'].filter((k) => col[k] < 0);
  if (ageCol < 0) missing.unshift('Alter');
  if (missing.length) throw new Error(`Spalte(n) fehlen: ${missing.join(', ')}`);
  const decimalComma = delim === ';' || (delim === '\t' && lines.slice(1, 4).some((l) => /\d,\d/.test(l)));

  const measures = {};
  let used = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const measure = MEASURE_ALIASES[norm(col.measure >= 0 ? cells[col.measure] : defaults.measure)];
    const sex = SEX_ALIASES[norm(col.sex >= 0 ? cells[col.sex] : defaults.sex)];
    if (!measure || !sex) continue;
    const age = toNumber(cells[ageCol], decimalComma) * ageFactor;
    const L = toNumber(cells[col.L], decimalComma);
    const M = toNumber(cells[col.M], decimalComma);
    const S = toNumber(cells[col.S], decimalComma);
    if (![age, L, M, S].every(Number.isFinite) || age < 0 || M <= 0 || S <= 0) continue;
    measures[measure] ??= {};
    (measures[measure][sex] ??= []).push([Math.round(age * 100) / 100, L, M, S]);
    used++;
  }
  if (!used) throw new Error('Keine Zeile erkannt. Erwartet: measure, sex, age, L, M, S');
  return { measures, rows: used };
}

// ---------------------------------------------------------------------------
// Alter
// ---------------------------------------------------------------------------

export function dayNumber(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

export function ageDays(birthDate, date) {
  return dayNumber(date) - dayNumber(birthDate);
}

export function gestationDays(profile) {
  if (!Number.isInteger(profile?.gestation_weeks)) return null;
  return profile.gestation_weeks * 7 + (Number.isInteger(profile.gestation_days) ? profile.gestation_days : 0);
}

// Tage, um die korrigiert wird (0 bei Geburt ab 37+0)
export function correctionDays(profile) {
  const ga = gestationDays(profile);
  return ga !== null && ga < PRETERM_LIMIT_DAYS ? TERM_DAYS - ga : 0;
}

export function plotAge(profile, chronoDays) {
  const c = correctionDays(profile);
  return c > 0 && chronoDays < CORRECT_UNTIL_DAYS ? chronoDays - c : chronoDays;
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------

function measurePoints(profile, measurements) {
  const points = [];
  if (profile.birth_date) {
    points.push({
      id: 'birth', date: profile.birth_date, source: 'birth', note: null,
      weight_g: profile.birth_weight_g ?? null, length_cm: profile.birth_length_cm ?? null, hc_cm: profile.birth_hc_cm ?? null,
    });
  }
  for (const m of measurements) {
    points.push({
      id: m.id, date: m.date, source: m.source, note: m.note,
      weight_g: m.weight_g ?? null, length_cm: m.length_cm ?? null, hc_cm: m.hc_cm ?? null,
    });
  }
  return points
    .map((p) => {
      const chrono = profile.birth_date ? ageDays(profile.birth_date, p.date) : null;
      return { ...p, age_days: chrono, plot_age_days: chrono === null ? null : plotAge(profile, chrono) };
    })
    .sort((a, b) => (a.age_days - b.age_days) || (a.id === 'birth' ? -1 : b.id === 'birth' ? 1 : a.id - b.id));
}

const FIELD = { weight: 'weight_g', length: 'length_cm', hc: 'hc_cm' };
const toRefUnit = (measure, v) => (measure === 'weight' ? v / 1000 : v);

function scoreFor(ref, sex, measure, day, value) {
  const rows = ref?.measures?.[measure]?.[sex];
  if (!rows || value === null || value === undefined || day === null) return null;
  const lms = lmsAt(rows, day);
  if (!lms) return null;
  const z = zScore(toRefUnit(measure, value), lms);
  if (z === null) return null;
  return { z: round(z, 2), p: round(normCdf(z) * 100, 1) };
}

// Gewicht an einem Alterstag: exakt, linear zwischen Messungen mit ≤ 14 Tagen Abstand,
// sonst die nächste Messung, wenn sie höchstens 3 Tage entfernt ist.
function weightAt(points, day) {
  const w = points.filter((p) => p.weight_g !== null && p.plot_age_days !== null);
  const exact = w.find((p) => p.plot_age_days === day);
  if (exact) return exact.weight_g;
  let prev = null;
  let next = null;
  for (const p of w) {
    if (p.plot_age_days < day) prev = p;
    else if (p.plot_age_days > day && !next) next = p;
  }
  if (prev && next && next.plot_age_days - prev.plot_age_days <= 14) {
    const f = (day - prev.plot_age_days) / (next.plot_age_days - prev.plot_age_days);
    return prev.weight_g + f * (next.weight_g - prev.weight_g);
  }
  const near = [prev, next].filter((p) => p && Math.abs(p.plot_age_days - day) <= 3)
    .sort((a, b) => Math.abs(a.plot_age_days - day) - Math.abs(b.plot_age_days - day))[0];
  return near ? near.weight_g : null;
}

function velocity(ref, sex, points) {
  const table = ref?.velocity?.weight_1mon?.[sex];
  if (!table) return [];
  const out = [];
  for (const iv of table) {
    const a = weightAt(points, iv.from_day);
    const b = weightAt(points, iv.to_day);
    if (a === null || b === null) continue;
    const inc = b - a;
    const x = inc + iv.delta;
    if (x <= 0) continue;
    const z = lmsZ(x, { L: iv.L, M: iv.M, S: iv.S });
    out.push({
      label: iv.label, from_day: iv.from_day, to_day: iv.to_day,
      increment_g: Math.round(inc), median_g: Math.round(iv.M - iv.delta),
      z: round(z, 2), p: round(normCdf(z) * 100, 1),
    });
  }
  return out;
}

function gains(points) {
  const w = points.filter((p) => p.weight_g !== null && p.age_days !== null);
  const out = [];
  for (let i = 1; i < w.length; i++) {
    const days = w[i].age_days - w[i - 1].age_days;
    if (days < 1) continue;
    const diff = w[i].weight_g - w[i - 1].weight_g;
    out.push({
      from: w[i - 1].date, to: w[i].date, days, diff_g: diff,
      g_per_day: round(diff / days, 1), g_per_week: Math.round((diff / days) * 7),
    });
  }
  return out;
}

function earlyWeeks(profile, points) {
  const bw = profile.birth_weight_g;
  if (!bw) return null;
  const w = points.filter((p) => p.weight_g !== null && p.age_days !== null && p.age_days > 0);
  const first = w.filter((p) => p.age_days <= 21);
  let min = null;
  for (const p of first) if (!min || p.weight_g < min.weight_g) min = p;
  const lowest = min && min.weight_g < bw ? min : null;
  const regained = lowest ? w.find((p) => p.age_days > lowest.age_days && p.weight_g >= bw) : null;
  return {
    birth_weight_g: bw,
    lowest_g: lowest ? lowest.weight_g : null,
    lowest_day: lowest ? lowest.age_days : null,
    loss_pct: lowest ? round(((bw - lowest.weight_g) / bw) * 100, 1) : null,
    regained_day: regained ? regained.age_days : null,
    regained: lowest ? !!regained : w.length > 0,
  };
}

// Zielgröße: Tanner (Mittelwert der Eltern ± 6,5 cm, Zielbereich ± 8,5 cm) und
// SDS-Methode nach Hermanussen & Cole 2003 (0,72 × mittlerer Eltern-SDS, Zielbereich ± 1,6 SDS).
export function targetHeight(profile, ref) {
  const mother = profile.mother_height_cm;
  const father = profile.father_height_cm;
  const sex = profile.sex;
  if (!mother || !father || !SEXES.includes(sex)) return null;
  const mid = (mother + father) / 2 + (sex === 'male' ? 6.5 : -6.5);
  const out = {
    tanner: { cm: round(mid, 1), min_cm: round(mid - 8.5, 1), max_cm: round(mid + 8.5, 1) },
    sds: null,
  };
  const ad = ref?.adult_height;
  if (ad) {
    const lm = (a) => ({ L: a[0], M: a[1], S: a[2] });
    const sdsMother = zScore(mother, lm(ad.female));
    const sdsFather = zScore(father, lm(ad.male));
    const th = 0.72 * ((sdsMother + sdsFather) / 2);
    const own = lm(ad[sex]);
    out.sds = {
      mother_sds: round(sdsMother, 2), father_sds: round(sdsFather, 2),
      sds: round(th, 2), p: round(normCdf(th) * 100, 1),
      cm: round(valueAtZ(th, own), 1), min_cm: round(valueAtZ(th - 1.6, own), 1), max_cm: round(valueAtZ(th + 1.6, own), 1),
      adult_age_years: ad.age_years,
    };
  }
  return out;
}

const RANGES = [91, 183, 365, 730, 1096, 1826];

// Kurven für das Diagramm: Linien je z an Stützstellen (wöchentlich bis 1 Jahr, danach monatlich)
export function curves(ref, sex, maxDay, targetZ = null) {
  const out = {};
  for (const m of MEASURES) {
    const rows = ref?.measures?.[m]?.[sex];
    if (!rows) continue;
    const first = rows[0][0];
    const last = Math.min(rows[rows.length - 1][0], maxDay);
    if (last <= first) continue;
    const days = [];
    const step = maxDay <= 183 ? 3 : maxDay <= 400 ? 7 : 14;
    for (let d = Math.ceil(first); d < last; d += step) days.push(d);
    days.push(last);
    const at = (z) => days.map((d) => [d, round((m === 'weight' ? 1000 : 1) * valueAtZ(z, lmsAt(rows, d)), m === 'weight' ? 0 : 2)]);
    out[m] = {
      from_day: first,
      lines: ref.lines.map((line) => ({ z: line.z, label: line.label, points: at(line.z) })),
      // Zielkanal: Kurve auf Höhe des Ziel-SDS (nur Länge)
      target: m === 'length' && Number.isFinite(targetZ) ? { z: targetZ, points: at(targetZ) } : null,
    };
  }
  return out;
}

export function analyze({ profile, measurements, ref, todayYmd, rangeDays }) {
  const sex = SEXES.includes(profile.sex) ? profile.sex : null;
  const points = measurePoints(profile, measurements);
  const nowChrono = profile.birth_date ? ageDays(profile.birth_date, todayYmd) : null;
  const nowPlot = nowChrono === null ? null : plotAge(profile, nowChrono);
  const prevZ = {};
  const items = points.map((p) => {
    const scores = {};
    for (const m of MEASURES) {
      const v = p[FIELD[m]];
      if (v === null || v === undefined) continue;
      const s = sex && ref ? scoreFor(ref, sex, m, p.plot_age_days, v) : null;
      if (s && prevZ[m] !== undefined) s.dz = round(s.z - prevZ[m], 2);
      if (s) prevZ[m] = s.z;
      scores[m] = s;
    }
    return { ...p, scores };
  });

  const maxPointDay = Math.max(0, ...points.map((p) => p.plot_age_days ?? 0));
  const want = Number.isFinite(rangeDays) && rangeDays > 0
    ? rangeDays
    : RANGES.find((r) => r >= Math.max(maxPointDay, nowPlot ?? 0) + 21) ?? 1826;

  const latest = {};
  for (const m of MEASURES) {
    const last = [...items].reverse().find((p) => p[FIELD[m]] !== null && p[FIELD[m]] !== undefined);
    if (last) latest[m] = { date: last.date, value: last[FIELD[m]], age_days: last.age_days, ...(last.scores[m] || {}) };
  }

  const target = targetHeight(profile, ref);
  return {
    sex,
    age_days: nowChrono,
    corrected_age_days: nowChrono !== null && nowPlot !== nowChrono ? nowPlot : null,
    correction_days: correctionDays(profile),
    range_days: want,
    measurements: items,
    latest,
    gains: gains(points),
    early: earlyWeeks(profile, points),
    velocity: sex ? velocity(ref, sex, points) : [],
    target,
    curves: sex && ref ? curves(ref, sex, want, target?.sds?.sds ?? null) : {},
    lines: ref ? ref.lines : [],
  };
}

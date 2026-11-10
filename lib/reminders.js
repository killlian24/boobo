// Boobo – Erinnerungen für Mamas Medikamente (docs/API.md, Erweiterung 7).
// Reine Rechnung ohne Datenbank: Der Server reicht Medikament, letzte Einnahme und „jetzt“ herein,
// heraus kommt, ob gerade erinnert werden soll und zu welchem „Ping“ (Zeitpunkt der aktuellen Meldung).
// Beide Handys und Home Assistant sehen so dasselbe, ohne dass jemand etwas speichern muss.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export const REMINDER_MODES = new Set(['off', 'times', 'after_last']);
// Einnahme bis zu so lange VOR einer festen Uhrzeit gilt schon für diese Uhrzeit (07:30 genommen → 08:00 erledigt)
export const TIMES_GRACE_MS = 60 * MINUTE_MS;
// „Nach der Einnahme“: so lange nach dem Zeitpunkt wird höchstens erinnert, danach gilt das Mittel als abgesetzt
export const AFTER_LAST_WINDOW_MS = 36 * 3600 * 1000;

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

// "8:00" / "08:00" → "08:00", sonst null
export function normalizeHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = HHMM_RE.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Zeitzone (dieselbe Rechnung wie in server.js, hier ohne Abhängigkeit dorthin)
// ---------------------------------------------------------------------------

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

export function wallClock(ms, timeZone) {
  const out = {};
  for (const { type, value } of dateTimeFormat(timeZone).formatToParts(new Date(ms))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

function tzOffsetMs(instantMs, timeZone) {
  const p = wallClock(instantMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

// Zeitpunkt (ms UTC) von „Jahr-Monat-Tag hh:mm“ Ortszeit in timeZone, Sommerzeitwechsel inklusive.
export function localInstant(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = guess - tzOffsetMs(guess, timeZone);
  const offset2 = tzOffsetMs(instant, timeZone);
  if (instant !== guess - offset2) instant = guess - offset2;
  return instant;
}

// Alle Uhrzeiten von gestern, heute und morgen als Zeitpunkte, aufsteigend.
function slotsAround(times, nowMs, timeZone) {
  const out = [];
  for (const dayOffset of [-1, 0, 1]) {
    const p = wallClock(nowMs + dayOffset * DAY_MS, timeZone);
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      out.push(localInstant(p.year, p.month, p.day, h, m, timeZone));
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Nachtruhe
// ---------------------------------------------------------------------------

// quiet = { from: "23:00", to: "06:30" } oder null. from == to → aus. Fenster über Mitternacht erlaubt.
export function inQuiet(nowMs, quiet, timeZone) {
  if (!quiet || !quiet.from || !quiet.to || quiet.from === quiet.to) return false;
  const p = wallClock(nowMs, timeZone);
  const now = p.hour * 60 + p.minute;
  const from = hhmmToMinutes(quiet.from);
  const to = hhmmToMinutes(quiet.to);
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;
}

// Nächstes Ende der Nachtruhe (ms), nur sinnvoll, wenn inQuiet gerade true ist.
export function quietEndsAt(nowMs, quiet, timeZone) {
  const [h, m] = quiet.to.split(':').map(Number);
  const today = wallClock(nowMs, timeZone);
  let end = localInstant(today.year, today.month, today.day, h, m, timeZone);
  if (end <= nowMs) {
    const tomorrow = wallClock(nowMs + DAY_MS, timeZone);
    end = localInstant(tomorrow.year, tomorrow.month, tomorrow.day, h, m, timeZone);
  }
  return end;
}

// ---------------------------------------------------------------------------
// Statusrechnung
// ---------------------------------------------------------------------------

function parseMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Erinnerungsstatus eines Medikaments.
 *
 * @param {object} input
 *   mode            'off' | 'times' | 'after_last'
 *   times           ["08:00", "20:00"] (bei 'times')
 *   afterMinutes    Minuten nach der letzten Einnahme (bei 'after_last'); null → gapMinutes
 *   gapMinutes      Mindestabstand des Medikaments (min_gap_minutes)
 *   repeatMinutes   0 = einmal erinnern, sonst alle n Minuten erneut, bis genommen/übersprungen
 *   since           ISO: ab wann die Einstellung gilt (ältere Uhrzeiten werden nicht nachgeholt)
 *   snoozedUntil    ISO oder null
 *   skippedSlot     ISO des übersprungenen Zeitpunkts oder null
 *   lastAt          ISO der letzten Einnahme oder null
 *   nextPossibleAt  ISO oder null (vom Medikamentenstatus: Mindestabstand/Höchstzahl)
 *   active          Medikament nicht pausiert
 *   nowMs, timeZone, quiet ({from,to} | null)
 *
 * @returns {{ mode, times, after_minutes, repeat_minutes, status, slot_at, ping_at, snoozed_until, next_at, quiet_until }}
 *   status: 'off' | 'idle' | 'pending' | 'snoozed' | 'skipped' | 'quiet'
 *   slot_at: Zeitpunkt, um den es gerade geht (die Uhrzeit bzw. letzte Einnahme + Stunden)
 *   ping_at: Zeitpunkt der aktuellen Meldung (nur bei 'pending'); ändert sich bei jeder Wiederholung
 *   next_at: nächste Erinnerung in der Zukunft, nur zur Anzeige
 */
export function computeReminder(input) {
  const {
    mode = 'off', times = [], afterMinutes = null, gapMinutes = 0, repeatMinutes = 0,
    since = null, snoozedUntil = null, skippedSlot = null, lastAt = null, nextPossibleAt = null,
    active = true, nowMs = Date.now(), timeZone = 'UTC', quiet = null,
  } = input;

  const out = {
    mode: REMINDER_MODES.has(mode) ? mode : 'off',
    times: Array.isArray(times) ? times.slice() : [],
    after_minutes: afterMinutes === null || afterMinutes === undefined ? null : Number(afterMinutes),
    repeat_minutes: Number(repeatMinutes) || 0,
    status: 'off',
    slot_at: null,
    ping_at: null,
    snoozed_until: null,
    next_at: null,
    quiet_until: null,
  };
  if (!active || out.mode === 'off') return out;

  const lastMs = parseMs(lastAt);
  const sinceMs = parseMs(since) ?? 0;
  let slotMs = null;
  let nextMs = null;

  if (out.mode === 'times') {
    if (!out.times.length) return out;
    const slots = slotsAround(out.times, nowMs, timeZone);
    for (const s of slots) {
      if (s <= nowMs) {
        if (s >= sinceMs) slotMs = s; // jüngste vergangene Uhrzeit seit der Einstellung
      } else if (nextMs === null) {
        nextMs = s;
      }
    }
    // Schon genommen (auch bis zu einer Stunde vorher) → diese Uhrzeit ist erledigt
    if (slotMs !== null && lastMs !== null && lastMs >= slotMs - TIMES_GRACE_MS) slotMs = null;
  } else {
    const after = out.after_minutes !== null && out.after_minutes > 0 ? out.after_minutes : Number(gapMinutes) || 0;
    if (!after || lastMs === null) {
      out.status = 'idle';
      return out;
    }
    const s = lastMs + after * MINUTE_MS;
    if (s > nowMs) {
      nextMs = s;
    } else if (s >= sinceMs && nowMs < s + AFTER_LAST_WINDOW_MS) {
      slotMs = s;
    }
  }

  out.next_at = nextMs === null ? null : iso(nextMs);
  if (slotMs === null) {
    out.status = 'idle';
    return out;
  }
  out.slot_at = iso(slotMs);

  const skippedMs = parseMs(skippedSlot);
  if (skippedMs !== null && skippedMs === slotMs) {
    out.status = 'skipped';
    return out;
  }

  let pingBase = slotMs;
  const snoozeMs = parseMs(snoozedUntil);
  if (snoozeMs !== null && snoozeMs > slotMs) {
    out.snoozed_until = iso(snoozeMs);
    if (snoozeMs > nowMs) {
      out.status = 'snoozed';
      out.next_at = out.snoozed_until;
      return out;
    }
    pingBase = Math.max(pingBase, snoozeMs);
  }

  // Erst erinnern, wenn das Mittel auch genommen werden darf (Mindestabstand, Höchstzahl)
  const possibleMs = parseMs(nextPossibleAt);
  if (possibleMs !== null && possibleMs > nowMs) {
    out.status = 'idle';
    out.next_at = iso(possibleMs);
    return out;
  }
  const gap = Number(gapMinutes) || 0;
  if (lastMs !== null && gap > 0) pingBase = Math.max(pingBase, lastMs + gap * MINUTE_MS);

  if (inQuiet(nowMs, quiet, timeZone)) {
    out.status = 'quiet';
    out.quiet_until = iso(quietEndsAt(nowMs, quiet, timeZone));
    out.next_at = out.quiet_until;
    return out;
  }

  const rep = out.repeat_minutes > 0 ? out.repeat_minutes * MINUTE_MS : 0;
  const ping = rep ? pingBase + Math.floor((nowMs - pingBase) / rep) * rep : pingBase;
  out.status = 'pending';
  out.ping_at = iso(ping);
  return out;
}

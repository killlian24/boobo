/* Boobo – Frontend (Vanilla JS) */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';
  var REFRESH_MS = 30000;
  var TICK_MS = 60000;
  var TOAST_MS = 10000;
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_MOVE_PX = 10;
  var HISTORY_LIMIT = 100;
  var LS_THEME = 'boobo.theme';
  var LS_NIGHT = 'boobo.night';

  var SIDE_NAMES = { left: 'Links', right: 'Rechts', both: 'Beide', bottle: 'Flasche' };
  var SIDE_LETTERS = { left: 'L', right: 'R', both: 'B', bottle: 'F' };
  var DIAPER_NAMES = { wet: 'Nass', dirty: 'Voll' };
  var DIAPER_TOAST_SUB = { wet: 'Alles im Fluss.', dirty: 'Volle Leistung, Bobo.' };

  // diapers/meds: null = Endpunkt (noch) nicht verfügbar → Abschnitt ausblenden
  var state = { state: null, feeds: [], diapers: [], meds: null, busy: false, online: true };
  var medBusy = {};

  var DROP_PATH = 'M12 3.5C9.6 7 6.5 10.6 6.5 14.3a5.5 5.5 0 0 0 11 0c0-3.7-3.1-7.3-5.5-10.8Z';

  var fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  var fmtDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  var fmtDateLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---------- Helpers ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toLocalInputValue(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function fromLocalInputValue(value) {
    // "YYYY-MM-DDTHH:MM" interpreted as local time
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function formatDuration(minutes, style) {
    // style 'rel' → "1 h 12 min" / "45 min"; style 'gap' → "2 h 50" / "45 min"
    minutes = Math.max(0, Math.round(minutes));
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h === 0) return m + ' min';
    if (style === 'gap') return h + ' h ' + pad2(m);
    if (m === 0) return h + ' h';
    return h + ' h ' + pad2(m) + ' min';
  }

  function relativeSince(date, now) {
    var mins = Math.floor((now - date) / 60000);
    if (mins < 1) return 'gerade eben';
    return 'vor ' + formatDuration(mins, 'rel');
  }

  function sameDay(a, b) { return dayKey(a) === dayKey(b); }

  // "" für heute, "gestern " / "morgen " / "Sa., 1. Nov. " sonst – als Präfix vor einer Uhrzeit
  function dayPrefix(date, now) {
    if (sameDay(date, now)) return '';
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (sameDay(date, y)) return 'gestern ';
    var t = new Date(now); t.setDate(t.getDate() + 1);
    if (sameDay(date, t)) return 'morgen ';
    return fmtDate.format(date) + ' ';
  }

  function toDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // Stunden mit höchstens einer Nachkommastelle, deutsch: 6 → "6", 1.5 → "1,5"
  function formatHours(minutes) {
    var h = Math.round((minutes / 60) * 10) / 10;
    return String(h).replace('.', ',');
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function dropSvg(filled, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'drop');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', DROP_PATH);
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function trashSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } catch (e) { /* privater Modus o. ä. */ }
  }

  function dayKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function dayLabel(date, now) {
    var today = dayKey(now);
    var y = new Date(now); y.setDate(y.getDate() - 1);
    var k = dayKey(date);
    if (k === today) return 'Heute';
    if (k === dayKey(y)) return 'Gestern';
    var sameYear = date.getFullYear() === now.getFullYear();
    return sameYear ? fmtDateLong.format(date) : fmtDate.format(date) + ' ' + date.getFullYear();
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('data-') === 0 || k.indexOf('aria-') === 0) node.setAttribute(k, attrs[k]);
        else node[k] = attrs[k];
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // ---------- API ----------

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Accept': 'application/json' }, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : ('Fehler ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function setOnline(ok) {
    state.online = ok;
    $('#offline').hidden = ok;
  }

  var refreshing = null;
  var refreshAgain = false;
  function refresh() {
    if (refreshing) {
      // Läuft bereits – danach noch einmal laden, damit keine veralteten Daten gewinnen
      refreshAgain = true;
      return refreshing.then(function () { return refreshing || Promise.resolve(); });
    }
    refreshing = Promise.all([
      api('GET', '/api/state'),
      api('GET', '/api/feeds?limit=' + HISTORY_LIMIT),
      // Neue Endpunkte defensiv: fehlen sie, bleibt der Rest der App heil
      api('GET', '/api/diapers?limit=' + HISTORY_LIMIT).catch(optionalFailure),
      api('GET', '/api/medications').catch(optionalFailure)
    ]).then(function (res) {
      state.state = res[0];
      state.feeds = (res[1] && Array.isArray(res[1].feeds)) ? res[1].feeds : [];
      applyOptional('diapers', res[2], 'diapers');
      applyOptional('meds', res[3], 'medications');
      setOnline(true);
      render();
    }).catch(function (err) {
      // Netzwerkfehler (TypeError) oder Serverfehler → Banner
      setOnline(false);
      if (!state.state) renderStatus();
      console.warn('refresh failed', err);
    }).then(function () {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; return refresh(); }
    });
    return refreshing;
  }

  var KEEP = {};
  function optionalFailure(err) {
    // 404/405 = Server kennt den Endpunkt nicht → ausblenden; sonst alten Stand behalten
    if (err && (err.status === 404 || err.status === 405)) return null;
    if (err instanceof TypeError) throw err;
    return KEEP;
  }
  function applyOptional(key, res, field) {
    if (res === KEEP) return;
    if (res && Array.isArray(res[field])) state[key] = res[field];
    else state[key] = null;
  }

  function refreshMeds() {
    return api('GET', '/api/medications').then(function (res) {
      if (res && Array.isArray(res.medications)) state.meds = res.medications;
      renderMeds();
      renderMedAdmin();
    }).catch(function (err) {
      if (err && (err.status === 404 || err.status === 405)) { state.meds = null; renderMeds(); renderMedAdmin(); }
    });
  }

  // ---------- Rendering ----------

  function render() {
    renderStatus();
    renderDiaperButtons();
    renderMeds();
    renderSummary();
    renderHistory();
  }

  function renderDiaperButtons() {
    // Nur ausblenden, wenn der Server Windeln sicher nicht kennt
    $('#diapers').hidden = state.diapers === null;
  }

  function renderSummary() {
    var box = $('#summary');
    var s = state.state && state.state.summary_24h;
    if (!s || !isNum(s.feeds) || s.feeds <= 0) { box.hidden = true; return; }
    var line = s.feeds + ' Mal gestillt';
    if (isNum(s.longest_gap_minutes)) line += ' · längste Pause ' + formatDuration(s.longest_gap_minutes, 'gap');
    $('#summary-feeds').textContent = line;
    var wet = isNum(s.diapers_wet) ? s.diapers_wet : 0;
    var dirty = isNum(s.diapers_dirty) ? s.diapers_dirty : 0;
    var dl = $('#summary-diapers');
    if (wet > 0 || dirty > 0) {
      dl.textContent = 'Windeln: ' + wet + ' nass, ' + dirty + ' voll';
      dl.hidden = false;
    } else {
      dl.hidden = true;
    }
    box.hidden = false;
  }

  var RING_LEN = 2 * Math.PI * 52;

  function renderStatus() {
    var s = state.state;
    var box = $('#status');
    var ring = $('#ring-progress');
    var timeEl = $('#status-time');
    var sideEl = $('#status-side');
    var relEl = $('#status-rel');
    var nextEl = $('#status-next');
    var sugEl = $('#status-suggest');

    box.classList.remove('overdue', 'warn', 'empty');

    if (!s) {
      timeEl.textContent = '–:–';
      sideEl.textContent = '';
      relEl.textContent = state.online ? 'Lade …' : 'Keine Daten';
      nextEl.textContent = '';
      sugEl.textContent = '';
      ring.style.strokeDashoffset = RING_LEN;
      highlightSuggested(null);
      return;
    }

    var now = new Date();
    var interval = s.interval_minutes || 180;

    if (!s.last) {
      box.classList.add('empty');
      timeEl.textContent = '';
      sideEl.textContent = '';
      relEl.textContent = 'Noch nichts notiert';
      nextEl.textContent = '';
      nextEl.appendChild(el('span', { class: 'line main', text: 'Beim ersten Stillen einfach auf eine Seite tippen.' }));
      ring.style.strokeDashoffset = RING_LEN;
    } else {
      var last = new Date(s.last.at);
      var due = s.next_due_at ? new Date(s.next_due_at) : new Date(last.getTime() + interval * 60000);
      var sinceMin = (now - last) / 60000;
      var untilMin = (due - now) / 60000;
      var pct = Math.min(1, Math.max(0, sinceMin / interval));

      timeEl.textContent = fmtTime.format(last);
      sideEl.textContent = SIDE_NAMES[s.last.side] || s.last.side;

      nextEl.textContent = '';
      relEl.textContent = relativeSince(last, now);
      if (untilMin < 0) {
        box.classList.add('overdue');
        nextEl.appendChild(el('span', { class: 'line main', text: 'Bobo hat bestimmt Hunger' }));
        nextEl.appendChild(el('span', { class: 'line sub', text: 'seit ' + formatDuration(-untilMin, 'rel') }));
      } else {
        if (pct > 0.85) box.classList.add('warn');
        nextEl.appendChild(el('span', { class: 'line main', text: 'Bobo meldet sich wohl gegen ' + fmtTime.format(due) }));
        nextEl.appendChild(el('span', { class: 'line sub', text: pct > 0.8 ? 'Bobo wird langsam hungrig' : (pct < 0.5 ? 'Noch Zeit zum Kuscheln' : 'noch etwa ' + formatDuration(untilMin, 'rel')) }));
      }
      ring.style.strokeDashoffset = RING_LEN * (1 - pct);
    }

    // Akzentregel: Ring, Vorschlagszeile und hervorgehobener Button tragen die Farbe der Seite, die dran ist.
    var sug = s.suggested_side;
    box.className = box.className.replace(/\bside-\w+/g, '').trim();
    sugEl.textContent = '';
    if (sug && sug !== 'bottle' && s.last) {
      box.classList.add('side-' + sug);
      sugEl.appendChild(el('span', { class: 'dot', text: SIDE_LETTERS[sug] }));
      sugEl.appendChild(el('span', { text: 'Diesmal ist ' + SIDE_NAMES[sug] + ' dran' }));
      sugEl.hidden = false;
    } else {
      sugEl.hidden = true;
    }
    highlightSuggested(s.last ? sug : null);
  }

  function highlightSuggested(side) {
    $$('.feed-btn').forEach(function (b) {
      b.classList.toggle('suggested', !!side && side !== 'bottle' && b.getAttribute('data-side') === side);
    });
  }

  // Still-Einträge und Windeln chronologisch gemischt. Beide Listen sind auf HISTORY_LIMIT begrenzt;
  // damit keine Lücke entsteht, nur bis zum älteren der beiden „abgeschnittenen“ Enden zeigen.
  function historyItems() {
    var feeds = state.feeds || [];
    var diapers = state.diapers || [];
    var cutoff = -Infinity;
    if (feeds.length >= HISTORY_LIMIT) cutoff = Math.max(cutoff, new Date(feeds[feeds.length - 1].at).getTime());
    if (diapers.length >= HISTORY_LIMIT) cutoff = Math.max(cutoff, new Date(diapers[diapers.length - 1].at).getTime());

    var items = [];
    // Abstand „2 h 50 später“ nur zwischen Still-Einträgen: zum nächstälteren Still-Eintrag
    feeds.forEach(function (f, i) {
      var d = toDate(f.at);
      if (!d) return;
      var older = feeds[i + 1] ? toDate(feeds[i + 1].at) : null;
      items.push({ type: 'feed', data: f, date: d, gapMin: older ? (d - older) / 60000 : null });
    });
    diapers.forEach(function (w) {
      var d = toDate(w.at);
      if (d) items.push({ type: 'diaper', data: w, date: d, gapMin: null });
    });
    items = items.filter(function (it) { return it.date.getTime() >= cutoff; });
    items.sort(function (a, b) {
      var dt = b.date - a.date;
      if (dt) return dt;
      if (a.type !== b.type) return a.type === 'feed' ? -1 : 1;
      return (b.data.id || 0) - (a.data.id || 0);
    });
    return items;
  }

  function renderHistory() {
    var root = $('#history');
    root.textContent = '';
    var items = historyItems();
    if (!items.length) {
      root.appendChild(el('p', { class: 'empty-hint', text: 'Hier sammelt sich, was war. Bobo gibt den Takt vor.' }));
      return;
    }
    var now = new Date();
    var groups = [];
    var map = {};
    items.forEach(function (it) {
      var k = dayKey(it.date);
      if (!map[k]) {
        map[k] = { key: k, label: dayLabel(it.date, now), items: [], feeds: 0, diapers: 0 };
        groups.push(map[k]);
      }
      map[k].items.push(it);
      if (it.type === 'feed') map[k].feeds++; else map[k].diapers++;
    });

    groups.forEach(function (g) {
      var parts = [];
      if (g.feeds) parts.push(g.feeds + ' Mal');
      if (g.diapers) parts.push(plural(g.diapers, 'Windel', 'Windeln'));
      var head = el('div', { class: 'day-head' }, [
        el('span', { text: g.label }),
        el('span', { class: 'count', text: parts.join(' · ') })
      ]);
      var list = el('ul', { class: 'day-list' });
      g.items.forEach(function (it) {
        list.appendChild(el('li', null, [it.type === 'feed' ? feedRow(it) : diaperRow(it)]));
      });
      root.appendChild(el('section', { class: 'day' }, [head, list]));
    });
  }

  function feedRow(it) {
    var f = it.data;
    var row = el('button', {
      class: 'row side-' + f.side, type: 'button', 'data-id': String(f.id),
      'aria-label': fmtTime.format(it.date) + ' ' + (SIDE_NAMES[f.side] || f.side) + (f.note ? ', ' + f.note : '') + ' – bearbeiten'
    }, [
      el('span', { class: 'dot', text: SIDE_LETTERS[f.side] || '?' }),
      el('span', { class: 'time', text: fmtTime.format(it.date) }),
      el('span', { class: 'body' }, [
        el('span', { class: 'side-name', text: SIDE_NAMES[f.side] || f.side }),
        f.note ? el('span', { class: 'note', text: f.note }) : null
      ]),
      el('span', { class: 'gap', text: it.gapMin != null ? formatDuration(it.gapMin, 'gap') + ' später' : '' })
    ]);
    row.addEventListener('click', function () { openEdit(f); });
    return row;
  }

  function diaperRow(it) {
    var w = it.data;
    var kindText = w.kind === 'dirty' ? 'voll' : 'nass';
    var dot = el('span', { class: 'dot' });
    dot.appendChild(dropSvg(w.kind === 'dirty', 16));
    var row = el('button', {
      class: 'row row-diaper', type: 'button', 'data-id': String(w.id),
      'aria-label': fmtTime.format(it.date) + ' Windel ' + kindText + (w.note ? ', ' + w.note : '') + ' – bearbeiten'
    }, [
      dot,
      el('span', { class: 'time', text: fmtTime.format(it.date) }),
      el('span', { class: 'body' }, [
        el('span', { class: 'side-name', text: 'Windel · ' + kindText }),
        w.note ? el('span', { class: 'note', text: w.note }) : null
      ]),
      el('span', { class: 'gap', text: '' })
    ]);
    row.addEventListener('click', function () { openDiaperEdit(w); });
    return row;
  }

  // ---------- Für Mama ----------

  function isActiveMed(m) { return !!m && m.active !== false && m.active !== 0; }

  function medPossibleNow(m, now) {
    if (m.possible_now === true) return true;
    var next = toDate(m.next_possible_at);
    // zwischen zwei Refreshes lokal nachziehen
    return !!next && next <= now;
  }

  function medStatusText(m, now) {
    var last = toDate(m.last_at);
    var max = isNum(m.max_per_day) ? m.max_per_day : null;
    var taken = isNum(m.taken_24h) ? m.taken_24h : 0;
    var count = max != null ? ' · ' + taken + ' von ' + max : '';
    if (!last) return 'Noch nichts genommen';
    if (medPossibleNow(m, now)) {
      return (m.due ? 'Geht jetzt' : 'Geht wieder') + ' · zuletzt ' + dayPrefix(last, now) + fmtTime.format(last);
    }
    if (m.remaining_24h === 0) return 'Für heute komplett' + count;
    var next = toDate(m.next_possible_at);
    if (!next) return 'Zuletzt ' + dayPrefix(last, now) + fmtTime.format(last);
    return 'Wieder ab ' + dayPrefix(next, now) + fmtTime.format(next) + count;
  }

  function renderMeds() {
    var box = $('#meds');
    var list = $('#meds-list');
    var meds = Array.isArray(state.meds) ? state.meds.filter(isActiveMed) : [];
    if (!meds.length) { box.hidden = true; list.textContent = ''; return; }
    var now = new Date();
    list.textContent = '';
    meds.forEach(function (m) {
      var due = !!m.due && medPossibleNow(m, now);
      var title = el('div', { class: 'med-name' }, [
        m.name || 'Medikament',
        m.dose ? el('span', { class: 'med-dose', text: ' ' + m.dose }) : null
      ]);
      var btn = el('button', {
        class: 'med-take', type: 'button', text: 'Genommen',
        'aria-label': (m.name || 'Medikament') + ' genommen'
      });
      btn.disabled = !!medBusy[m.id];
      btn.addEventListener('click', function () { takeMed(m); });
      list.appendChild(el('li', { class: 'med-row' + (due ? ' due' : '') }, [
        el('div', { class: 'med-info' }, [title, el('div', { class: 'med-status', text: medStatusText(m, now) })]),
        btn
      ]));
    });
    box.hidden = false;
  }

  // ---------- Toast ----------

  var toastTimer = null;
  function showToast(text, opts) {
    opts = opts || {};
    var t = $('#toast');
    var btn = $('#toast-action');
    clearTimeout(toastTimer);
    $('#toast-text').textContent = text;
    $('#toast-sub').textContent = opts.sub || '';
    $('#toast-sub').hidden = !opts.sub;
    t.classList.toggle('error', !!opts.error);
    // Modale Dialoge liegen in der Top-Layer: Toast dort einhängen, sonst verschwindet er hinter dem Backdrop
    var host = dialogStack.length ? dialogStack[dialogStack.length - 1] : document.body;
    if (t.parentNode !== host) host.appendChild(t);
    btn.hidden = !opts.action;
    btn.onclick = null;
    if (opts.action) {
      btn.textContent = opts.actionLabel || 'Rückgängig';
      btn.onclick = function () {
        hideToast();
        opts.action();
      };
    }
    t.hidden = false;
    toastTimer = setTimeout(hideToast, opts.duration || TOAST_MS);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
  }

  // ---------- Actions ----------

  function setBusy(busy) {
    state.busy = busy;
    $$('.feed-btn, #btn-backfill, .diaper-btn').forEach(function (b) { b.disabled = busy; });
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }

  function copyBody(body) {
    var b = {};
    Object.keys(body || {}).forEach(function (k) { b[k] = body[k]; });
    return b;
  }

  // POST mit Doppelschutz: 409 {error:"duplicate"} → Rückfrage → erneut mit on_duplicate "force".
  // Ergebnis { cancelled: true }, wenn „Nein, passt“.
  function postGuarded(path, body) {
    return api('POST', path, body).catch(function (err) {
      if (!err || err.status !== 409 || !err.data || err.data.error !== 'duplicate') throw err;
      var ex = err.data.existing;
      var at = ex ? toDate(ex.at) : null;
      var now = new Date();
      var title = at ? 'Um ' + dayPrefix(at, now) + fmtTime.format(at) + ' schon notiert.' : 'Gerade eben schon notiert.';
      return askConfirm({ title: title, text: 'Trotzdem eintragen?', yes: 'Ja, trotzdem', no: 'Nein, passt' })
        .then(function (ok) {
          if (!ok) return { cancelled: true };
          var b = copyBody(body);
          b.on_duplicate = 'force';
          return api('POST', path, b);
        });
    });
  }

  function quickLog(side) {
    if (state.busy) return;
    setBusy(true);
    vibrate(15);
    postGuarded('/api/feeds', { side: side }).then(function (res) {
      if (res && res.cancelled) return refresh();
      var feed = res && res.feed;
      return refresh().then(function () {
        var when = feed ? fmtTime.format(new Date(feed.at)) : fmtTime.format(new Date());
        showToast(SIDE_NAMES[side] + ', ' + when + '. Notiert.', {
          sub: 'Ihr macht das toll.',
          action: feed ? function () { undoFeed(feed.id); } : null
        });
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { setBusy(false); });
  }

  function quickDiaper(kind) {
    if (state.busy) return;
    setBusy(true);
    vibrate(15);
    api('POST', '/api/diapers', { kind: kind }).then(function (res) {
      var diaper = res && res.diaper;
      return refresh().then(function () {
        var when = diaper && toDate(diaper.at) ? fmtTime.format(toDate(diaper.at)) : fmtTime.format(new Date());
        showToast(DIAPER_NAMES[kind] + ', ' + when + '. Notiert.', {
          sub: DIAPER_TOAST_SUB[kind],
          action: diaper ? function () { undoDelete('/api/diapers/' + diaper.id); } : null
        });
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { setBusy(false); });
  }

  function undoDelete(path, after) {
    api('DELETE', path).then(function () {
      showToast('Weg damit, nichts passiert.', { duration: 3000 });
      return after ? after() : refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    });
  }

  function takeMed(m) {
    if (!m || medBusy[m.id]) return;
    var now = new Date();
    var next = toDate(m.next_possible_at);
    var early = !medPossibleNow(m, now) && next && next > now;
    var ask = early
      ? askConfirm({
          title: 'Eigentlich erst ab ' + dayPrefix(next, now) + fmtTime.format(next) + '.',
          text: 'Trotzdem notieren?', yes: 'Ja, trotzdem', no: 'Lieber warten'
        })
      : Promise.resolve(true);
    ask.then(function (ok) {
      if (!ok) return;
      medBusy[m.id] = true;
      renderMeds();
      vibrate(15);
      return postGuarded('/api/medications/' + m.id + '/intakes', {}).then(function (res) {
        if (res && res.cancelled) return refresh();
        var intake = res && res.intake;
        var at = intake ? toDate(intake.at) : null;
        return refresh().then(function () {
          showToast((m.name || 'Medikament') + ', ' + fmtTime.format(at || new Date()) + '. Notiert.', {
            sub: 'Gut auf dich aufgepasst.',
            action: intake ? function () { undoDelete('/api/med-intakes/' + intake.id); } : null
          });
        });
      }).catch(function (err) {
        showToast(errorText(err), { error: true, duration: 6000 });
      }).then(function () {
        delete medBusy[m.id];
        renderMeds();
      });
    });
  }

  function undoFeed(id) {
    api('DELETE', '/api/feeds/' + id).then(function () {
      showToast('Weg damit, nichts passiert.', { duration: 3000 });
      return refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    });
  }

  function errorText(err) {
    if (err instanceof TypeError) return 'Gerade keine Verbindung zum Zuhause-Server';
    return err && err.message ? err.message : 'Unbekannter Fehler';
  }

  // ---------- Segmented control ----------

  function segSet(group, value) {
    $$('.seg', group).forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-value') === value ? 'true' : 'false');
    });
    group.dataset.value = value;
  }
  function segGet(group) { return group.dataset.value || ''; }
  function segInit(group) {
    group.addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (b) segSet(group, b.getAttribute('data-value'));
    });
  }

  // ---------- Dialoge ----------

  var dialogStack = [];
  function openDialog(dlg) {
    if (dlg.open) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    var i = dialogStack.indexOf(dlg);
    if (i >= 0) dialogStack.splice(i, 1);
    dialogStack.push(dlg);
  }
  function closeDialog(dlg) {
    if (!dlg.open) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    onDialogClosed(dlg);
  }
  function onDialogClosed(dlg) {
    if (dlg.open) return; // verspätetes close-Event eines inzwischen wieder geöffneten Dialogs
    var i = dialogStack.indexOf(dlg);
    if (i >= 0) dialogStack.splice(i, 1);
    // Toast nicht mit dem Dialog verschwinden lassen
    var t = $('#toast');
    if (t && dlg.contains(t)) {
      var host = dialogStack.length ? dialogStack[dialogStack.length - 1] : document.body;
      host.appendChild(t);
    }
  }

  // Wiederverwendbare Rückfrage. opts: { title, text, yes, no, danger } → Promise<boolean>
  var confirmResolve = null;
  function askConfirm(opts) {
    var dlg = $('#dlg-confirm');
    if (confirmResolve) settleConfirm(false);
    $('#confirm-title').textContent = opts.title || '';
    var txt = $('#confirm-text');
    txt.textContent = opts.text || '';
    txt.hidden = !opts.text;
    var yes = $('#confirm-yes');
    yes.textContent = opts.yes || 'Ja';
    yes.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    $('#confirm-no').textContent = opts.no || 'Abbrechen';
    return new Promise(function (resolve) {
      confirmResolve = resolve;
      openDialog(dlg);
      try { $('#confirm-no').focus(); } catch (e) { /* egal */ }
    });
  }
  function settleConfirm(value) {
    var r = confirmResolve;
    confirmResolve = null;
    closeDialog($('#dlg-confirm'));
    if (r) r(value);
  }
  function initConfirm() {
    var dlg = $('#dlg-confirm');
    $('#confirm-yes').addEventListener('click', function () { settleConfirm(true); });
    $('#confirm-no').addEventListener('click', function () { settleConfirm(false); });
    // Escape / Backdrop → wie „Nein“
    dlg.addEventListener('close', function () { if (confirmResolve && !dlg.open) settleConfirm(false); });
  }

  function initDialogs() {
    $$('dialog').forEach(function (dlg) {
      dlg.addEventListener('close', function () { onDialogClosed(dlg); });
      $$('[data-close]', dlg).forEach(function (b) {
        b.addEventListener('click', function () { closeDialog(dlg); });
      });
      // Tipp auf den Backdrop schließt
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) closeDialog(dlg);
      });
    });
    $$('.segmented').forEach(segInit);
  }

  // Nachtragen
  function openAdd(side) {
    var dlg = $('#dlg-add');
    var form = $('#form-add');
    var now = new Date();
    form.at.value = toLocalInputValue(now);
    form.at.max = toLocalInputValue(new Date(now.getTime() + 5 * 60000));
    form.note.value = '';
    setChip(null);
    var pick = SIDE_NAMES[side] ? side : ((state.state && state.state.suggested_side) || 'left');
    segSet($('.segmented', form), pick);
    openDialog(dlg);
  }

  function setChip(minutes) {
    $$('#add-chips .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(c.getAttribute('data-min')) === String(minutes) ? 'true' : 'false');
    });
  }

  function initChips() {
    var form = $('#form-add');
    $('#add-chips').addEventListener('click', function (e) {
      var c = e.target.closest('.chip');
      if (!c) return;
      var min = parseInt(c.getAttribute('data-min'), 10);
      if (isNaN(min)) return;
      form.at.value = toLocalInputValue(new Date(Date.now() - min * 60000));
      setChip(min);
    });
    form.at.addEventListener('input', function () { setChip(null); });
  }

  function submitAdd(e) {
    e.preventDefault();
    var form = $('#form-add');
    var side = segGet($('.segmented', form));
    var atIso = fromLocalInputValue(form.at.value);
    if (!side) { showToast('Bitte eine Seite wählen', { error: true, duration: 4000 }); return; }
    if (!atIso) { showToast('Ungültige Zeit', { error: true, duration: 4000 }); return; }
    var body = { side: side, at: atIso };
    var note = form.note.value.trim();
    if (note) body.note = note;
    var submit = $('button[type=submit]', form);
    submit.disabled = true;
    postGuarded('/api/feeds', body).then(function (res) {
      closeDialog($('#dlg-add'));
      if (res && res.cancelled) return refresh();
      var feed = res && res.feed;
      return refresh().then(function () {
        showToast(SIDE_NAMES[side] + ' nachgetragen · ' + fmtTime.format(new Date(atIso)), {
          action: feed ? function () { undoFeed(feed.id); } : null
        });
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  // Bearbeiten
  var editing = null;
  function openEdit(feed) {
    editing = feed;
    var dlg = $('#dlg-edit');
    var form = $('#form-edit');
    form.id.value = feed.id;
    form.at.value = toLocalInputValue(new Date(feed.at));
    form.at.max = toLocalInputValue(new Date(Date.now() + 5 * 60000));
    form.note.value = feed.note || '';
    segSet($('.segmented', form), feed.side);
    $('#confirm-delete').hidden = true;
    $('#btn-delete').hidden = false;
    openDialog(dlg);
  }

  function submitEdit(e) {
    e.preventDefault();
    if (!editing) return;
    var form = $('#form-edit');
    var side = segGet($('.segmented', form));
    var atIso = fromLocalInputValue(form.at.value);
    if (!atIso) { showToast('Ungültige Zeit', { error: true, duration: 4000 }); return; }
    var note = form.note.value.trim();
    var patch = {};
    if (side !== editing.side) patch.side = side;
    // Feld hat Minutengenauigkeit: nur senden, wenn die Minute wirklich geändert wurde (sonst gehen Sekunden verloren)
    if (form.at.value !== toLocalInputValue(new Date(editing.at))) patch.at = atIso;
    if ((editing.note || '') !== note) patch.note = note || null;
    if (!Object.keys(patch).length) { closeDialog($('#dlg-edit')); return; }
    var submit = $('button[type=submit]', form);
    submit.disabled = true;
    api('PATCH', '/api/feeds/' + editing.id, patch).then(function () {
      closeDialog($('#dlg-edit'));
      showToast('Gespeichert.', { duration: 3000 });
      return refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  function deleteEditing() {
    if (!editing) return;
    var id = editing.id;
    var btn = $('#btn-delete-confirm');
    btn.disabled = true;
    api('DELETE', '/api/feeds/' + id).then(function () {
      closeDialog($('#dlg-edit'));
      showToast('Gelöscht.', { duration: 3000 });
      return refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { btn.disabled = false; });
  }

  // Einstellungen
  function openSettings() {
    var form = $('#form-settings');
    var cur = state.state ? state.state.interval_minutes : null;
    form.interval_minutes.value = cur || '';
    updateIntervalHint();
    $('#settings-meta').textContent = 'Boobo · Version ' + APP_VERSION + ' · ' + location.host;
    segSet($('#theme-seg'), getTheme());
    $('#night-toggle').checked = nightEnabled();
    renderInstallHelp();
    renderMedAdmin();
    refreshMeds();
    api('GET', '/api/health').then(function (h) {
      if (h && h.version) {
        $('#settings-meta').textContent = 'Boobo · Server ' + h.version + ' · App ' + APP_VERSION + ' · ' + location.host;
      }
    }).catch(function () { /* egal */ });
    if (cur == null) {
      api('GET', '/api/settings').then(function (s) {
        if (s && s.interval_minutes) { form.interval_minutes.value = s.interval_minutes; updateIntervalHint(); }
      }).catch(function () { /* egal */ });
    }
    openDialog($('#dlg-settings'));
  }

  function updateIntervalHint() {
    var v = parseInt($('#form-settings').interval_minutes.value, 10);
    $('#interval-hint').textContent = isNaN(v) ? '30 bis 720 Minuten' : ('= ' + formatDuration(v, 'rel') + ' zwischen zwei Mahlzeiten');
  }

  function submitSettings(e) {
    e.preventDefault();
    var form = $('#form-settings');
    var v = parseInt(form.interval_minutes.value, 10);
    if (isNaN(v) || v < 30 || v > 720) {
      showToast('Der Abstand muss zwischen 30 Minuten und 12 Stunden liegen.', { error: true, duration: 5000 });
      return;
    }
    var submit = $('button[type=submit]', form);
    submit.disabled = true;
    api('PUT', '/api/settings', { interval_minutes: v }).then(function () {
      closeDialog($('#dlg-settings'));
      showToast('Abstand gespeichert: ' + formatDuration(v, 'rel'), { duration: 3000 });
      return refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  // ---------- Erscheinungsbild / Nachtmodus ----------

  function getTheme() {
    var t = lsGet(LS_THEME);
    return t === 'light' || t === 'dark' ? t : 'system';
  }
  function nightEnabled() { return lsGet(LS_NIGHT) !== '0'; }
  function isNightHour(d) { var h = d.getHours(); return h >= 22 || h < 7; }

  function applyTheme() {
    var root = document.documentElement;
    var t = getTheme();
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    root.classList.toggle('night', nightEnabled() && isNightHour(new Date()));
    var bg = '';
    try { bg = getComputedStyle(root).getPropertyValue('--bg').trim(); } catch (e) { bg = ''; }
    if (bg) {
      $$('meta[name="theme-color"]').forEach(function (m) { m.setAttribute('content', bg); });
    }
  }

  function initTheme() {
    applyTheme();
    $('#theme-seg').addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b) return;
      var v = b.getAttribute('data-value');
      segSet($('#theme-seg'), v);
      lsSet(LS_THEME, v === 'light' || v === 'dark' ? v : null);
      applyTheme();
    });
    $('#night-toggle').addEventListener('change', function () {
      lsSet(LS_NIGHT, this.checked ? '1' : '0');
      applyTheme();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
      else if (mq.addListener) mq.addListener(applyTheme);
    }
  }

  // ---------- Langes Drücken auf Still-Buttons ----------

  var swallowClick = false;
  var swallowTimer = null;
  function armSwallow(ms) {
    swallowClick = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(function () { swallowClick = false; }, ms);
  }

  function initLongPress(btn, onLong) {
    var timer = null;
    var sx = 0;
    var sy = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    btn.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancel();
      sx = e.clientX;
      sy = e.clientY;
      timer = setTimeout(function () {
        timer = null;
        armSwallow(5000); // bis zum Loslassen; danach kurz (siehe pointerup unten)
        vibrate(25);
        onLong();
      }, LONG_PRESS_MS);
    });
    btn.addEventListener('pointermove', function (e) {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > LONG_PRESS_MOVE_PX || Math.abs(e.clientY - sy) > LONG_PRESS_MOVE_PX) cancel();
    });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function initClickSwallow() {
    // Der click nach einem langen Druck darf weder eintragen noch den frisch geöffneten Dialog schließen
    function release() { if (swallowClick) armSwallow(400); }
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    document.addEventListener('click', function (e) {
      if (!swallowClick) return;
      swallowClick = false;
      clearTimeout(swallowTimer);
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  // ---------- Windel bearbeiten ----------

  var editingDiaper = null;
  function openDiaperEdit(w) {
    editingDiaper = w;
    var form = $('#form-diaper');
    var d = toDate(w.at) || new Date();
    form.at.value = toLocalInputValue(d);
    form.at.max = toLocalInputValue(new Date(Date.now() + 5 * 60000));
    segSet($('.segmented', form), w.kind === 'dirty' ? 'dirty' : 'wet');
    openDialog($('#dlg-diaper'));
  }

  function submitDiaper(e) {
    e.preventDefault();
    if (!editingDiaper) return;
    var form = $('#form-diaper');
    var kind = segGet($('.segmented', form));
    var atIso = fromLocalInputValue(form.at.value);
    if (!atIso) { showToast('Ungültige Zeit', { error: true, duration: 4000 }); return; }
    var patch = {};
    if (kind && kind !== editingDiaper.kind) patch.kind = kind;
    if (form.at.value !== toLocalInputValue(new Date(editingDiaper.at))) patch.at = atIso;
    if (!Object.keys(patch).length) { closeDialog($('#dlg-diaper')); return; }
    var submit = $('button[type=submit]', form);
    submit.disabled = true;
    api('PATCH', '/api/diapers/' + editingDiaper.id, patch).then(function () {
      closeDialog($('#dlg-diaper'));
      showToast('Gespeichert.', { duration: 3000 });
      return refresh();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  function deleteDiaper() {
    if (!editingDiaper) return;
    var w = editingDiaper;
    askConfirm({ title: 'Windel löschen?', yes: 'Ja, löschen', no: 'Behalten', danger: true }).then(function (ok) {
      if (!ok) return;
      return api('DELETE', '/api/diapers/' + w.id).then(function () {
        closeDialog($('#dlg-diaper'));
        showToast('Gelöscht.', { duration: 3000 });
        return refresh();
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    });
  }

  // ---------- Alle Einnahmen ----------

  function openIntakes() {
    var list = $('#intakes-list');
    list.textContent = '';
    list.appendChild(el('p', { class: 'empty-hint', text: 'Lade …' }));
    openDialog($('#dlg-intakes'));
    loadIntakes();
  }

  function loadIntakes() {
    return api('GET', '/api/med-intakes?limit=50').then(function (res) {
      renderIntakes(res && Array.isArray(res.intakes) ? res.intakes : []);
    }).catch(function (err) {
      var list = $('#intakes-list');
      list.textContent = '';
      list.appendChild(el('p', { class: 'empty-hint', text: errorText(err) }));
    });
  }

  function renderIntakes(intakes) {
    var list = $('#intakes-list');
    list.textContent = '';
    if (!intakes.length) {
      list.appendChild(el('p', { class: 'empty-hint', text: 'Hier stehen später Mamas Einnahmen.' }));
      return;
    }
    var now = new Date();
    var lastKey = null;
    var ul = null;
    intakes.forEach(function (it) {
      var d = toDate(it.at);
      if (!d) return;
      var k = dayKey(d);
      if (k !== lastKey) {
        lastKey = k;
        list.appendChild(el('div', { class: 'day-head' }, [el('span', { text: dayLabel(d, now) })]));
        ul = el('ul', { class: 'day-list' });
        list.appendChild(ul);
      }
      var label = (it.name || 'Medikament') + (it.dose ? ' ' + it.dose : '');
      var del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': label + ', ' + fmtTime.format(d) + ' löschen' });
      del.appendChild(trashSvg());
      del.addEventListener('click', function () { deleteIntake(it, label, d); });
      ul.appendChild(el('li', { class: 'intake-row' }, [
        el('span', { class: 'time', text: fmtTime.format(d) }),
        el('span', { class: 'body', text: label }),
        del
      ]));
    });
  }

  function deleteIntake(it, label, d) {
    askConfirm({
      title: 'Einnahme löschen?', text: label + ', ' + dayPrefix(d, new Date()) + fmtTime.format(d),
      yes: 'Ja, löschen', no: 'Behalten', danger: true
    }).then(function (ok) {
      if (!ok) return;
      return api('DELETE', '/api/med-intakes/' + it.id).then(function () {
        showToast('Gelöscht.', { duration: 3000 });
        loadIntakes();
        return refresh();
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    });
  }

  // ---------- Medikamente verwalten (Einstellungen) ----------

  function medRuleText(m) {
    var parts = [];
    if (isNum(m.max_per_day)) parts.push('max. ' + m.max_per_day + ' pro Tag');
    if (isNum(m.min_gap_minutes) && m.min_gap_minutes > 0) parts.push('Abstand ' + formatHours(m.min_gap_minutes) + ' h');
    if (!parts.length) parts.push('ohne Vorgaben');
    if (!isActiveMed(m)) parts.push('pausiert');
    return parts.join(' · ');
  }

  function renderMedAdmin() {
    var wrap = $('#med-admin-wrap');
    var list = $('#med-admin');
    if (!Array.isArray(state.meds)) { wrap.hidden = true; return; }
    list.textContent = '';
    state.meds.forEach(function (m) {
      var paused = !isActiveMed(m);
      var main = el('button', { class: 'admin-main', type: 'button', 'aria-label': (m.name || 'Medikament') + ' bearbeiten' }, [
        el('span', { class: 'admin-name', text: (m.name || 'Medikament') + (m.dose ? ' · ' + m.dose : '') }),
        el('span', { class: 'admin-sub', text: medRuleText(m) })
      ]);
      main.addEventListener('click', function () { openMedEdit(m); });
      var sw = el('input', { type: 'checkbox', class: 'switch', 'aria-label': (m.name || 'Medikament') + ' pausieren' });
      sw.setAttribute('role', 'switch');
      sw.checked = paused;
      sw.addEventListener('change', function () { setMedPaused(m, sw); });
      var toggle = el('label', { class: 'pause-toggle' }, [el('span', { text: 'Pause' }), sw]);
      list.appendChild(el('li', { class: 'admin-row' + (paused ? ' paused' : '') }, [main, toggle]));
    });
    wrap.hidden = false;
  }

  function setMedPaused(m, sw) {
    sw.disabled = true;
    api('PATCH', '/api/medications/' + m.id, { active: !sw.checked }).then(function () {
      return refreshMeds();
    }).catch(function (err) {
      sw.checked = !sw.checked;
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { sw.disabled = false; });
  }

  var editingMed = null; // null = neu
  function openMedEdit(m) {
    editingMed = m || null;
    var form = $('#form-med');
    var f = form.elements;
    $('#med-dlg-title').textContent = m ? 'Bearbeiten' : 'Hinzufügen';
    f.med_name.value = m ? (m.name || '') : '';
    f.med_dose.value = m ? (m.dose || '') : '';
    f.med_max.value = m && isNum(m.max_per_day) ? String(m.max_per_day) : '';
    f.med_gap.value = m && isNum(m.min_gap_minutes) && m.min_gap_minutes > 0 ? formatHours(m.min_gap_minutes) : '';
    $('#btn-med-delete').hidden = !m;
    updateMedHint();
    openDialog($('#dlg-med'));
  }

  function parseGapHours(raw) {
    raw = String(raw || '').trim().replace(',', '.');
    if (raw === '') return 0;
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(raw)) return NaN;
    return parseFloat(raw);
  }

  function updateMedHint() {
    var f = $('#form-med').elements;
    var h = parseGapHours(f.med_gap.value);
    var max = f.med_max.value.trim();
    var parts = [];
    if (!isNaN(h) && h > 0) parts.push('Frühestens alle ' + formatDuration(Math.round(h * 60), 'rel'));
    else if (!isNaN(h)) parts.push('Ohne Mindestabstand');
    parts.push(max === '' ? 'ohne Höchstzahl in 24 Stunden' : 'höchstens ' + max + '× in 24 Stunden');
    $('#med-hint').textContent = parts.join(', ') + '.';
  }

  function submitMed(e) {
    e.preventDefault();
    var form = $('#form-med');
    var f = form.elements;
    var name = f.med_name.value.trim();
    var dose = f.med_dose.value.trim();
    var maxRaw = f.med_max.value.trim();
    var max = maxRaw === '' ? null : Number(maxRaw);
    var gapH = parseGapHours(f.med_gap.value);
    if (!name) { showToast('Bitte einen Namen eingeben.', { error: true, duration: 4000 }); return; }
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > 24)) {
      showToast('„max. pro Tag“ bitte zwischen 1 und 24 – oder leer lassen.', { error: true, duration: 5000 });
      return;
    }
    if (isNaN(gapH) || gapH < 0 || gapH > 168) {
      showToast('Abstand bitte in Stunden, zwischen 0 und 168.', { error: true, duration: 5000 });
      return;
    }
    var body = { name: name, dose: dose || null, max_per_day: max, min_gap_minutes: Math.round(gapH * 60) };
    var isNew = !editingMed;
    if (isNew) {
      if (!body.dose) delete body.dose;
      if (body.max_per_day === null) delete body.max_per_day;
    }
    var submit = $('button[type=submit]', form);
    submit.disabled = true;
    var req = isNew ? api('POST', '/api/medications', body) : api('PATCH', '/api/medications/' + editingMed.id, body);
    req.then(function () {
      closeDialog($('#dlg-med'));
      showToast(isNew ? name + ' ist dabei.' : 'Gespeichert.', { duration: 3000 });
      return refreshMeds();
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  function deleteMed() {
    var m = editingMed;
    if (!m) return;
    askConfirm({
      title: (m.name || 'Medikament') + ' löschen?',
      text: 'Die notierten Einnahmen verschwinden mit.',
      yes: 'Ja, löschen', no: 'Behalten', danger: true
    }).then(function (ok) {
      if (!ok) return;
      return api('DELETE', '/api/medications/' + m.id).then(function () {
        closeDialog($('#dlg-med'));
        showToast('Gelöscht.', { duration: 3000 });
        return refreshMeds();
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    });
  }

  // ---------- Startbildschirm-Hilfe ----------

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* egal */ }
    return window.navigator.standalone === true;
  }

  function renderInstallHelp() {
    var box = $('#install-help');
    box.hidden = isStandalone();
    $('#install-origin').textContent = location.origin;
  }

  function copyText(text, host) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      // Im modalen Dialog muss das Hilfsfeld im Dialog liegen, sonst ist es inert
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      (host || document.body).appendChild(ta);
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) { /* egal */ }
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.parentNode.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function initCopyButtons() {
    $$('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var src = document.getElementById(b.getAttribute('data-copy'));
        if (!src) return;
        copyText(src.textContent, b.closest('dialog')).then(function () {
          showToast('Kopiert.', { duration: 2500 });
        }).catch(function () {
          // Fallback: Text markieren, damit man ihn selbst kopieren kann
          try {
            var r = document.createRange();
            r.selectNodeContents(src);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          } catch (e) { /* egal */ }
          showToast('Markiert – bitte lange drücken und kopieren.', { duration: 4000 });
        });
      });
    });
  }

  // ---------- Init ----------

  function init() {
    initTheme();
    initDialogs();
    initConfirm();
    initChips();
    initClickSwallow();
    initCopyButtons();

    $$('.feed-btn').forEach(function (b) {
      var side = b.getAttribute('data-side');
      b.addEventListener('click', function () { quickLog(side); });
      initLongPress(b, function () { if (!state.busy) openAdd(side); });
    });
    $$('.diaper-btn').forEach(function (b) {
      b.addEventListener('click', function () { quickDiaper(b.getAttribute('data-kind')); });
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
    $('#btn-backfill').addEventListener('click', function () { openAdd(); });
    $('#btn-intakes').addEventListener('click', openIntakes);
    $('#btn-med-add').addEventListener('click', function () { openMedEdit(null); });
    $('#form-diaper').addEventListener('submit', submitDiaper);
    $('#btn-diaper-delete').addEventListener('click', deleteDiaper);
    $('#form-med').addEventListener('submit', submitMed);
    $('#btn-med-delete').addEventListener('click', deleteMed);
    $('#form-med').elements.med_gap.addEventListener('input', updateMedHint);
    $('#form-med').elements.med_max.addEventListener('input', updateMedHint);
    $('#btn-settings').addEventListener('click', openSettings);

    $('#form-add').addEventListener('submit', submitAdd);
    $('#form-edit').addEventListener('submit', submitEdit);
    $('#form-settings').addEventListener('submit', submitSettings);
    $('#form-settings').interval_minutes.addEventListener('input', updateIntervalHint);

    $('#btn-delete').addEventListener('click', function () {
      $('#confirm-delete').hidden = false;
      $('#btn-delete').hidden = true;
    });
    $('#btn-delete-cancel').addEventListener('click', function () {
      $('#confirm-delete').hidden = true;
      $('#btn-delete').hidden = false;
    });
    $('#btn-delete-confirm').addEventListener('click', deleteEditing);

    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(function () {
      applyTheme();      // Nachtmodus 22–7 Uhr minütlich prüfen
      renderStatus();
      renderMeds();      // „Wieder ab …“ → „Geht wieder“ ohne auf den Refresh zu warten
    }, TICK_MS);
    // Relative Zeiten im Verlauf hängen nicht von "jetzt" ab (nur Tageslabels) – alle 5 Minuten reicht
    setInterval(function () { if (state.feeds.length || (state.diapers && state.diapers.length)) renderHistory(); }, TICK_MS * 5);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', function () { setOnline(false); });

    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function (err) {
        console.warn('SW registration failed', err);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

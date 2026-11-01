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
      initLongPress(btn, function () { if (!medBusy[m.id]) openIntakeNew(m); });
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
  var lastHealth = null;

  function openSettings() {
    var form = $('#form-settings');
    var cur = state.state ? state.state.interval_minutes : null;
    form.interval_minutes.value = cur || '';
    updateIntervalHint();
    $('#settings-meta').textContent = 'Boobo · Version ' + APP_VERSION + ' · ' + location.host;
    segSet($('#theme-seg'), getTheme());
    $('#night-toggle').checked = nightEnabled();
    renderInstallHelp(lastHealth);
    renderMedAdmin();
    refreshMeds();
    api('GET', '/api/health').then(function (h) {
      lastHealth = h || null;
      renderInstallHelp(lastHealth);
      if (h && h.version) {
        $('#settings-meta').textContent = 'Boobo · Server ' + h.version + ' · App ' + APP_VERSION + ' · ' + location.host;
      }
    }).catch(function () {
      lastHealth = null;
      renderInstallHelp(null);
    });
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
      var label = intakeLabel(it);
      var row = el('button', {
        class: 'intake-row', type: 'button',
        'aria-label': label + ', ' + fmtTime.format(d) + ' – bearbeiten'
      }, [
        el('span', { class: 'time', text: fmtTime.format(d) }),
        el('span', { class: 'body', text: label }),
        el('span', { class: 'chev', 'aria-hidden': 'true' }, [chevronSvg()])
      ]);
      row.addEventListener('click', function () { openIntakeEdit(it); });
      ul.appendChild(el('li', null, [row]));
    });
  }

  function intakeLabel(x) {
    return (x.name || 'Medikament') + (x.dose ? ' ' + x.dose : '');
  }

  function chevronSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    var pth = document.createElementNS(ns, 'path');
    pth.setAttribute('d', 'M9 6l6 6-6 6');
    svg.appendChild(pth);
    return svg;
  }

  // ---------- Einnahme nachtragen / bearbeiten ----------
  // editingIntake: vorhandene Einnahme (Bearbeiten) oder null (Nachtragen für intakeMed)
  var editingIntake = null;
  var intakeMed = null;

  function openIntakeDialog() {
    var form = $('#form-intake');
    form.at.max = toLocalInputValue(new Date(Date.now() + 5 * 60000));
    openDialog($('#dlg-intake'));
  }

  function openIntakeEdit(it) {
    editingIntake = it;
    intakeMed = null;
    var form = $('#form-intake');
    $('#intake-title').textContent = 'Einnahme';
    $('#intake-med').textContent = intakeLabel(it);
    form.at.value = toLocalInputValue(toDate(it.at) || new Date());
    $('#btn-intake-save').textContent = 'Speichern';
    $('#btn-intake-delete').hidden = false;
    openIntakeDialog();
  }

  function openIntakeNew(m) {
    editingIntake = null;
    intakeMed = m;
    var form = $('#form-intake');
    $('#intake-title').textContent = 'Nachtragen';
    $('#intake-med').textContent = intakeLabel(m);
    form.at.value = toLocalInputValue(new Date());
    $('#btn-intake-save').textContent = 'Notieren';
    $('#btn-intake-delete').hidden = true;
    openIntakeDialog();
  }

  function afterIntakeChange() {
    if ($('#dlg-intakes').open) loadIntakes();
    return refresh();
  }

  function submitIntake(e) {
    e.preventDefault();
    var form = $('#form-intake');
    var atIso = fromLocalInputValue(form.at.value);
    if (!atIso) { showToast('Ungültige Zeit', { error: true, duration: 4000 }); return; }
    var submit = $('#btn-intake-save');
    var done;
    if (editingIntake) {
      var it = editingIntake;
      if (form.at.value === toLocalInputValue(new Date(it.at))) { closeDialog($('#dlg-intake')); return; }
      submit.disabled = true;
      done = api('PATCH', '/api/med-intakes/' + it.id, { at: atIso }).then(function () {
        closeDialog($('#dlg-intake'));
        showToast('Gespeichert.', { duration: 3000 });
        return afterIntakeChange();
      });
    } else if (intakeMed) {
      var m = intakeMed;
      submit.disabled = true;
      done = postGuarded('/api/medications/' + m.id + '/intakes', { at: atIso }).then(function (res) {
        closeDialog($('#dlg-intake'));
        if (res && res.cancelled) return afterIntakeChange();
        var intake = res && res.intake;
        var at = intake ? toDate(intake.at) : null;
        return afterIntakeChange().then(function () {
          showToast((m.name || 'Medikament') + ', ' + (at ? dayPrefix(at, new Date()) + fmtTime.format(at) : '') + '. Notiert.', {
            sub: 'Gut auf dich aufgepasst.',
            action: intake ? function () { undoDelete('/api/med-intakes/' + intake.id, afterIntakeChange); } : null
          });
        });
      });
    } else {
      closeDialog($('#dlg-intake'));
      return;
    }
    done.catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { submit.disabled = false; });
  }

  function deleteIntakeEditing() {
    var it = editingIntake;
    if (!it) return;
    var d = toDate(it.at) || new Date();
    askConfirm({
      title: 'Einnahme löschen?', text: intakeLabel(it) + ', ' + dayPrefix(d, new Date()) + fmtTime.format(d),
      yes: 'Ja, löschen', no: 'Behalten', danger: true
    }).then(function (ok) {
      if (!ok) return;
      return api('DELETE', '/api/med-intakes/' + it.id).then(function () {
        closeDialog($('#dlg-intake'));
        showToast('Gelöscht.', { duration: 3000 });
        return afterIntakeChange();
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

  // ---------- Statistik („Bobos Takt“) ----------
  // Daten kommen fertig aggregiert von GET /api/stats?days=N (docs/API.md, Erweiterung 4).
  // Diagramme sind schlichtes SVG: eine Farbe (--ink-l) für Mengen, Seitenfarben nur bei der Seitenverteilung.

  var LS_STATS_DAYS = 'boobo.stats_days';
  var STATS_RANGES = [7, 14, 30];
  var STATS_DAYS_DEFAULT = 14;
  var WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BAR_MAX = 24;      // dickster Balken (px)
  var BAR_GAP = 2;       // Lücke in Flächenfarbe zwischen Nachbarn (px)
  var GAP_LABELS = ['unter 1 h', '1 bis 2 h', '2 bis 3 h', '3 bis 4 h', 'über 4 h'];

  var stats = { days: STATS_DAYS_DEFAULT, data: null, loading: null, seq: 0 };

  function svgEl(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null) return;
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, String(attrs[k]));
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Säule: unten eckig an der Grundlinie, oben 4 px gerundet
  function columnPath(x, yTop, w, h) {
    if (h <= 0) return '';
    var r = Math.min(4, w / 2, h);
    var yb = yTop + h;
    return 'M' + x + ' ' + yb + 'V' + (yTop + r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r +
      'h' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'V' + yb + 'Z';
  }

  // Balkenbreite im Band: höchstens 24 px, sonst etwa 70 % des Bands, mindestens 2 px Lücke
  function barWidth(band) {
    return Math.max(3, Math.min(BAR_MAX, band - Math.max(BAR_GAP, band * 0.3)));
  }

  function fmt1(n) {
    if (!isNum(n)) return '–';
    return String(Math.round(n * 10) / 10).replace('.', ',');
  }

  function niceStep(max) {
    if (max <= 5) return 1;
    if (max <= 10) return 2;
    if (max <= 25) return 5;
    return 10;
  }

  // "2026-10-28" → lokales Date (nur für Beschriftungen)
  function dateFromKey(key) {
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function statsDayLabel(d, now) {
    var date = dateFromKey(d.date);
    var k = dayKey(date);
    if (k === dayKey(now)) return 'Heute';
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (k === dayKey(y)) return 'Gestern';
    return fmtDate.format(date);
  }

  function hourRangeText(h) { return h + '–' + ((h + 1) % 24) + ' Uhr'; }

  function getStatsDays() {
    var v = parseInt(lsGet(LS_STATS_DAYS), 10);
    return STATS_RANGES.indexOf(v) >= 0 ? v : STATS_DAYS_DEFAULT;
  }

  function openStats() {
    stats.days = getStatsDays();
    segSet($('#stats-range'), String(stats.days));
    if (!stats.data) {
      var body = $('#stats-body');
      body.textContent = '';
      body.appendChild(el('p', { class: 'empty-hint', text: 'Lade …' }));
    }
    openDialog($('#dlg-stats'));
    loadStats();
  }

  function loadStats() {
    var days = stats.days;
    var seq = ++stats.seq;
    var body = $('#stats-body');
    body.classList.add('loading');
    return api('GET', '/api/stats?days=' + days).then(function (res) {
      if (seq !== stats.seq) return;
      stats.data = res;
      renderStats();
    }).catch(function (err) {
      if (seq !== stats.seq) return;
      if (!stats.data) {
        body.textContent = '';
        body.appendChild(el('p', { class: 'empty-hint', text: errorText(err) }));
      } else {
        showToast(errorText(err), { error: true, duration: 5000 });
      }
    }).then(function () {
      if (seq === stats.seq) body.classList.remove('loading');
    });
  }

  function setStatsRange(days) {
    if (STATS_RANGES.indexOf(days) < 0 || days === stats.days) return;
    stats.days = days;
    lsSet(LS_STATS_DAYS, String(days));
    segSet($('#stats-range'), String(days));
    loadStats();
  }

  function renderStats() {
    var body = $('#stats-body');
    var d = stats.data;
    var tableOpen = !!(body.querySelector('.stats-details') && body.querySelector('.stats-details').open);
    // Offene Erklärungen beim Neuzeichnen (z. B. Drehen des Handys) offen lassen
    openInfos = {};
    $$('.stats-section', body).forEach(function (sec) {
      var panel = $('.stats-info', sec);
      if (panel && !panel.hidden) openInfos[$('.section-title', sec).textContent] = true;
    });
    body.textContent = '';
    if (!d || !Array.isArray(d.days)) return;
    if (!d.totals || !d.totals.feeds) {
      body.appendChild(el('p', { class: 'empty-hint', text: 'Noch nichts zu sehen. Nach ein paar Tagen zeigt sich hier, wann Bobo kommt.' }));
      return;
    }
    var width = Math.max(240, body.clientWidth || 320);
    body.appendChild(renderStatsTiles(d));
    body.appendChild(renderDayChart(d, width));
    body.appendChild(renderHourChart(d, width));
    body.appendChild(renderPatternGrid(d, width));
    body.appendChild(renderSides(d));
    body.appendChild(renderGapBars(d));
    body.appendChild(renderStatsTable(d, tableOpen));
  }

  // Abschnitt mit Titel; `sub` ist ein Befund (bleibt sichtbar), `info` eine Erklärung hinter dem kleinen „i“
  var infoSeq = 0;
  var openInfos = {};
  function statsSection(title, sub, info, children) {
    var head = el('div', { class: 'stats-head' }, [el('h3', { class: 'section-title', text: title })]);
    var kids = [head];
    if (info) {
      var id = 'stats-info-' + (++infoSeq);
      var panel = el('p', { class: 'stats-info', id: id, text: info });
      panel.hidden = !openInfos[title];
      var btn = el('button', { class: 'info-btn', type: 'button', 'aria-label': 'Erklärung zu „' + title + '“', 'aria-expanded': panel.hidden ? 'false' : 'true', 'aria-controls': id }, [infoSvg()]);
      btn.addEventListener('click', function () {
        panel.hidden = !panel.hidden;
        btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
      });
      head.appendChild(btn);
      kids.push(panel);
    }
    if (sub) kids.push(el('p', { class: 'stats-sub', text: sub }));
    return el('section', { class: 'stats-section' }, kids.concat(children || []));
  }

  function infoSvg() {
    var svg = svgEl('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' });
    svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }));
    svg.appendChild(svgEl('path', { d: 'M12 11v5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    svg.appendChild(svgEl('circle', { cx: 12, cy: 8, r: 1.2, fill: 'currentColor' }));
    return svg;
  }

  function tile(label, value, sub) {
    return el('div', { class: 'tile' }, [
      el('span', { class: 'tile-label', text: label }),
      el('span', { class: 'tile-value', text: value }),
      sub ? el('span', { class: 'tile-sub', text: sub }) : null
    ]);
  }

  function renderStatsTiles(d) {
    var t = d.totals;
    var g = d.gaps || {};
    var now = new Date();
    var counted = isNum(t.days_counted) ? t.days_counted : 0;
    var perDaySub = counted ? plural(counted, 'voller Tag', 'volle Tage') : 'noch kein voller Tag';
    var gapSub = isNum(g.median_minutes) ? 'meist ' + formatDuration(g.median_minutes, 'gap') : '';
    var longestAt = toDate(g.longest_at);
    var longestSub = longestAt ? 'bis ' + dayPrefix(longestAt, now) + fmtTime.format(longestAt) : '';
    var tiles = el('div', { class: 'stats-tiles' }, [
      tile('Pro Tag', fmt1(t.feeds_per_day), perDaySub),
      tile('Abstand', isNum(g.avg_minutes) ? formatDuration(g.avg_minutes, 'gap') : '–', gapSub),
      tile('Nachts', fmt1(t.night_feeds_per_day), 'pro Nacht'),
      tile('Längste Pause', isNum(g.longest_minutes) ? formatDuration(g.longest_minutes, 'gap') : '–', longestSub)
    ]);
    var info = 'Pro Tag und Nachts sind Mittelwerte über vollständige Tage, heute zählt noch nicht mit. ' +
      'Nacht heißt 22 bis 7 Uhr. Abstand ist der Mittelwert von einer Mahlzeit zur nächsten, „meist“ der Median.';
    return statsSection('Auf einen Blick', null, info, [tiles]);
  }

  // Detailzeile unter einem Diagramm: Antippen eines Balkens/Felds schreibt hier hinein
  function detailLine(hint) {
    var p = el('p', { class: 'chart-detail', text: hint || '' });
    p.setAttribute('role', 'status');
    return p;
  }

  function pickable(node, onPick) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.addEventListener('click', onPick);
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
    });
  }

  function selectMark(svg, mark) {
    $$('.mark.active', svg).forEach(function (m) { m.classList.remove('active'); });
    if (mark) mark.classList.add('active');
  }

  function dayDetailText(day, now) {
    var parts = [day.feeds + ' Mal gestillt'];
    if (day.bottle) parts[0] += ', davon ' + day.bottle + ' Flasche';
    if (isNum(day.avg_gap_minutes)) parts.push('Ø Abstand ' + formatDuration(day.avg_gap_minutes, 'gap'));
    if (day.night_feeds) parts.push(day.night_feeds + ' nachts');
    var w = (day.diapers_wet || 0) + (day.diapers_dirty || 0);
    if (w) parts.push(plural(w, 'Windel', 'Windeln'));
    return statsDayLabel(day, now) + (day.today ? ' (bis jetzt)' : '') + ': ' + parts.join(' · ');
  }

  // Säulen pro Tag
  function renderDayChart(d, width) {
    var days = d.days;
    var n = days.length;
    var now = new Date();
    var padL = 26, padR = 6, padT = 20, plotH = 132, axisH = 22;
    var H = padT + plotH + axisH;
    var innerW = width - padL - padR;
    var band = innerW / n;
    var barW = barWidth(band);
    var max = 0;
    days.forEach(function (x) { if (x.feeds > max) max = x.feeds; });
    var step = niceStep(max);
    var yMax = Math.max(step, Math.ceil(max / step) * step);
    var y = function (v) { return padT + plotH - (v / yMax) * plotH; };

    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + H, width: '100%', height: H, class: 'chart', role: 'img',
      'aria-label': 'Stillen pro Tag, ' + n + ' Tage' });
    // Gitter
    for (var v = 0; v <= yMax; v += step) {
      svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: width - padR, y1: y(v), y2: y(v) }));
      svg.appendChild(svgEl('text', { class: 'tick', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', text: v }));
    }
    var labelEvery = n <= 7 ? 1 : (n <= 14 ? 2 : 5);
    // Beschriftung: jeder labelEvery-te Tag plus „heute“; ein direkt daneben liegendes Datum weicht
    var labelAt = {};
    for (var li = 0; li < n; li += labelEvery) labelAt[li] = true;
    labelAt[n - 1] = true;
    if (n > 7 && labelAt[n - 2] && band < 30) delete labelAt[n - 2];
    var maxIdx = -1;
    days.forEach(function (day, i) { if (day.feeds === max && maxIdx < 0) maxIdx = i; });
    var detail = detailLine();
    days.forEach(function (day, i) {
      var cx = padL + band * i + band / 2;
      var x0 = cx - barW / 2;
      var g = svgEl('g', { class: 'mark' + (day.today ? ' partial' : '') });
      g.appendChild(svgEl('title', { text: dayDetailText(day, now) }));
      g.appendChild(svgEl('rect', { class: 'hit', x: padL + band * i, y: padT, width: band, height: plotH + axisH }));
      if (day.feeds > 0) g.appendChild(svgEl('path', { class: 'bar', d: columnPath(x0, y(day.feeds), barW, plotH - (y(day.feeds) - padT)) }));
      if (i === maxIdx || day.today) {
        g.appendChild(svgEl('text', { class: 'value', x: cx, y: y(day.feeds) - 5, 'text-anchor': 'middle', text: day.feeds }));
      }
      var date = dateFromKey(day.date);
      if (labelAt[i]) {
        var lbl = n <= 7 ? WEEKDAYS[day.weekday] : String(date.getDate()) + '.';
        svg.appendChild(svgEl('text', { class: 'tick' + (day.today ? ' today' : ''), x: cx, y: H - 6, 'text-anchor': 'middle', text: day.today ? 'heute' : lbl }));
      }
      pickable(g, function () { selectMark(svg, g); detail.textContent = dayDetailText(day, now); });
      svg.appendChild(g);
    });
    svg.appendChild(svgEl('line', { class: 'axis', x1: padL, x2: width - padR, y1: y(0), y2: y(0) }));
    var info = 'Der helle Balken ist heute, der Tag ist noch nicht vorbei. Einen Tag antippen zeigt seine Zahlen.';
    return statsSection('Wie oft pro Tag', null, info, [svg, detail]);
  }

  // Säulen pro Tagesstunde (alle Tage zusammen)
  function renderHourChart(d, width) {
    var hours = d.hours || [];
    var padL = 26, padR = 6, padT = 20, plotH = 110, axisH = 22;
    var H = padT + plotH + axisH;
    var innerW = width - padL - padR;
    var band = innerW / 24;
    var barW = barWidth(band);
    var max = 0, peak = -1;
    hours.forEach(function (v, h) { if (v > max) { max = v; peak = h; } });
    var step = niceStep(max);
    var yMax = Math.max(step, Math.ceil(max / step) * step);
    var y = function (v) { return padT + plotH - (v / yMax) * plotH; };
    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + H, width: '100%', height: H, class: 'chart', role: 'img',
      'aria-label': 'Stillen nach Tageszeit' });
    // Nachtband 22–7 Uhr
    svg.appendChild(svgEl('rect', { class: 'night-band', x: padL, y: padT, width: band * 7, height: plotH }));
    svg.appendChild(svgEl('rect', { class: 'night-band', x: padL + band * 22, y: padT, width: band * 2, height: plotH }));
    for (var v = 0; v <= yMax; v += step) {
      svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: width - padR, y1: y(v), y2: y(v) }));
      svg.appendChild(svgEl('text', { class: 'tick', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end', text: v }));
    }
    var detail = detailLine();
    hours.forEach(function (v, h) {
      var cx = padL + band * h + band / 2;
      var text = hourRangeText(h) + ': ' + v + ' Mal in ' + d.range_days + ' Tagen';
      var g = svgEl('g', { class: 'mark' });
      g.appendChild(svgEl('title', { text: text }));
      g.appendChild(svgEl('rect', { class: 'hit', x: padL + band * h, y: padT, width: band, height: plotH + axisH }));
      if (v > 0) g.appendChild(svgEl('path', { class: 'bar', d: columnPath(cx - barW / 2, y(v), barW, plotH - (y(v) - padT)) }));
      if (h === peak && v > 0) g.appendChild(svgEl('text', { class: 'value', x: cx, y: y(v) - 5, 'text-anchor': 'middle', text: v }));
      pickable(g, function () { selectMark(svg, g); detail.textContent = text; });
      svg.appendChild(g);
    });
    [0, 6, 12, 18].forEach(function (h) {
      svg.appendChild(svgEl('text', { class: 'tick', x: padL + band * h + band / 2, y: H - 6, 'text-anchor': 'middle', text: h === 0 ? '0 Uhr' : String(h) }));
    });
    svg.appendChild(svgEl('line', { class: 'axis', x1: padL, x2: width - padR, y1: y(0), y2: y(0) }));
    var sub = peak >= 0 && max > 0 ? 'Am häufigsten zwischen ' + peak + ' und ' + ((peak + 1) % 24) + ' Uhr.' : '';
    var info = 'Alle Tage des Zeitraums zusammengezählt, je Stunde. Grau hinterlegt ist die Nacht von 22 bis 7 Uhr. ' +
      'Eine Stunde antippen zeigt ihre Zahl.';
    return statsSection('Zu welcher Zeit', sub, info, [svg, detail]);
  }

  // Raster Tag × Stunde: jede Zelle eine Stunde, dunkler = öfter
  function renderPatternGrid(d, width) {
    var days = d.days;
    var n = days.length;
    var now = new Date();
    var nowHour = now.getHours();
    var padL = 44, padR = 2, padT = 18;
    var rowH = n <= 7 ? 22 : (n <= 14 ? 16 : 11);
    var innerW = width - padL - padR;
    var colW = innerW / 24;
    var H = padT + rowH * n + 2;
    var labelEvery = rowH >= 13 ? 1 : 2;
    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + H, width: '100%', height: H, class: 'chart grid-chart', role: 'img',
      'aria-label': 'Muster: Tage und Stunden' });
    svg.appendChild(svgEl('rect', { class: 'night-band', x: padL, y: padT, width: colW * 7, height: rowH * n }));
    svg.appendChild(svgEl('rect', { class: 'night-band', x: padL + colW * 22, y: padT, width: colW * 2, height: rowH * n }));
    [0, 6, 12, 18].forEach(function (h) {
      svg.appendChild(svgEl('text', { class: 'tick', x: padL + colW * h + colW / 2, y: padT - 6, 'text-anchor': 'middle', text: h === 0 ? '0 Uhr' : String(h) }));
    });
    var detail = detailLine();
    days.forEach(function (day, r) {
      var yTop = padT + rowH * r;
      var date = dateFromKey(day.date);
      if (r % labelEvery === 0 || day.today) {
        var lbl = day.today ? 'heute' : WEEKDAYS[day.weekday] + ' ' + date.getDate() + '.';
        svg.appendChild(svgEl('text', { class: 'tick' + (day.today ? ' today' : ''), x: padL - 6, y: yTop + rowH / 2 + 3.5, 'text-anchor': 'end', text: lbl }));
      }
      for (var h = 0; h < 24; h++) {
        var v = day.hours[h] || 0;
        var future = day.today && h > nowHour;
        var cls = 'cell' + (v >= 2 ? ' c2' : (v === 1 ? ' c1' : (future ? ' c-' : ' c0')));
        var g = svgEl('g', { class: 'mark ' + cls });
        var text = statsDayLabel(day, now) + ', ' + hourRangeText(h) + ': ' + (future ? 'noch nicht' : v + ' Mal');
        g.appendChild(svgEl('title', { text: text }));
        g.appendChild(svgEl('rect', { class: 'hit', x: padL + colW * h, y: yTop, width: colW, height: rowH }));
        g.appendChild(svgEl('rect', { class: 'box', x: padL + colW * h + 1, y: yTop + 1, width: Math.max(1, colW - 2), height: Math.max(1, rowH - 2), rx: 2 }));
        (function (gg, t) { pickable(gg, function () { selectMark(svg, gg); detail.textContent = t; }); })(g, text);
        svg.appendChild(g);
      }
    });
    var info = 'Jede Zeile ein Tag, jedes Feld eine Stunde. Rosa: da kam Bobo, kräftiger bei mehr als einem Mal. ' +
      'Grau hinterlegt ist die Nacht. Ein Feld antippen zeigt, was da war.';
    return statsSection('Das Muster', null, info, [svg, detail]);
  }

  // Seitenverteilung: schmaler Segmentbalken plus Liste mit Zahlen
  function renderSides(d) {
    var t = d.totals;
    var total = t.feeds || 0;
    var order = ['left', 'right', 'both', 'bottle'];
    var bar = el('div', { class: 'seg-bar', 'aria-hidden': 'true' });
    var list = el('ul', { class: 'side-list' });
    order.forEach(function (side) {
      var n = t[side] || 0;
      if (!n) return;
      var pct = Math.round((n / total) * 100);
      bar.appendChild(el('span', { class: 'seg-part side-' + side, style: 'flex-grow:' + n }));
      list.appendChild(el('li', { class: 'side-row side-' + side }, [
        el('span', { class: 'dot', text: SIDE_LETTERS[side] }),
        el('span', { class: 'side-label', text: SIDE_NAMES[side] }),
        el('span', { class: 'side-n', text: n + ' Mal' }),
        el('span', { class: 'side-pct', text: pct + ' %' })
      ]));
    });
    var breast = (t.left || 0) + (t.right || 0) + (t.both || 0);
    var sub = total + ' Mal in ' + d.range_days + ' Tagen' + (t.bottle ? ', davon ' + t.bottle + ' Flasche' : '');
    if (t.left && t.right) {
      var lr = Math.round((t.left / (t.left + t.right)) * 100);
      sub += ' · Links ' + lr + ' %, Rechts ' + (100 - lr) + ' %';
    }
    var info = 'Das Verhältnis Links zu Rechts zählt nur Mahlzeiten mit einer Seite, nicht Beide und nicht Flasche.';
    return statsSection('Welche Seite', sub, info, [bar, list]);
  }

  // Abstände zwischen zwei Mahlzeiten: waagrechte Balken je Klasse
  function renderGapBars(d) {
    var hist = (d.gaps && d.gaps.histogram) || [];
    var max = 0;
    hist.forEach(function (b) { if (b.n > max) max = b.n; });
    var rows = el('div', { class: 'hbar-list' });
    hist.forEach(function (b, i) {
      var pct = max ? (b.n / max) * 100 : 0;
      rows.appendChild(el('div', { class: 'hbar-row' }, [
        el('span', { class: 'hbar-label', text: GAP_LABELS[i] || '' }),
        el('span', { class: 'hbar-track' }, [el('span', { class: 'hbar', style: 'width:' + pct + '%' })]),
        el('span', { class: 'hbar-n', text: String(b.n) })
      ]));
    });
    var g = d.gaps || {};
    var sub = isNum(g.count) && g.count ? plural(g.count, 'Abstand', 'Abstände') + (isNum(g.shortest_minutes) ? ' · kürzester ' + formatDuration(g.shortest_minutes, 'gap') : '') : '';
    var info = 'Abstand von einer Mahlzeit zur nächsten, eingeteilt in Stunden. Genau 3 Stunden zählen zu „3 bis 4 h“.';
    return statsSection('Wie lange dazwischen', sub, info, [rows]);
  }

  // Tabellenansicht: alle Zahlen noch einmal zum Nachlesen
  function renderStatsTable(d, open) {
    var now = new Date();
    var firstIdx = -1;
    d.days.forEach(function (day, i) { if (firstIdx < 0 && day.feeds > 0) firstIdx = i; });
    var rows = d.days.slice(Math.max(0, firstIdx)).reverse();
    var thead = el('thead', null, [el('tr', null, ['Tag', 'Mal', 'Flasche', 'Nachts', 'Ø Abstand', 'Windeln'].map(function (h, i) {
      return el('th', { text: h, class: i ? 'num' : '' });
    }))]);
    var tbody = el('tbody');
    rows.forEach(function (day) {
      tbody.appendChild(el('tr', { class: day.today ? 'today' : '' }, [
        el('td', { text: day.today ? 'Heute' : WEEKDAYS[day.weekday] + ' ' + dateFromKey(day.date).getDate() + '.' }),
        el('td', { class: 'num', text: String(day.feeds) }),
        el('td', { class: 'num', text: day.bottle ? String(day.bottle) : '–' }),
        el('td', { class: 'num', text: day.night_feeds ? String(day.night_feeds) : '–' }),
        el('td', { class: 'num', text: isNum(day.avg_gap_minutes) ? formatDuration(day.avg_gap_minutes, 'gap') : '–' }),
        el('td', { class: 'num', text: (day.diapers_wet || day.diapers_dirty) ? (day.diapers_wet + ' / ' + day.diapers_dirty) : '–' })
      ]));
    });
    var table = el('table', { class: 'stats-table' }, [thead, tbody]);
    var details = el('details', { class: 'stats-details', open: !!open }, [
      el('summary', { text: 'Alle Tage als Tabelle' }),
      el('div', { class: 'table-wrap' }, [table]),
      el('p', { class: 'hint', text: 'Windeln als nass / voll.' })
    ]);
    return el('section', { class: 'stats-section' }, [details]);
  }

  var statsResizeTimer = null;
  function initStats() {
    $('#btn-stats').addEventListener('click', openStats);
    $('#btn-stats-more').addEventListener('click', openStats);
    $('#stats-range').addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (b) setStatsRange(parseInt(b.getAttribute('data-value'), 10));
    });
    window.addEventListener('resize', function () {
      if (!$('#dlg-stats').open || !stats.data) return;
      clearTimeout(statsResizeTimer);
      statsResizeTimer = setTimeout(renderStats, 150);
    });
  }

  // ---------- Startbildschirm-Hilfe ----------

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* egal */ }
    return window.navigator.standalone === true;
  }

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // <strong>-Teile per **...** markieren
  function richText(parent, text) {
    text.split('**').forEach(function (part, i) {
      if (!part) return;
      if (i % 2) parent.appendChild(mk('strong', null, part));
      else parent.appendChild(document.createTextNode(part));
    });
    return parent;
  }

  function stepList(items) {
    var ol = mk('ol');
    items.forEach(function (t) { ol.appendChild(richText(mk('li'), t)); });
    return ol;
  }

  function installHttpsUrl(https) {
    var hosts = (https.hosts && https.hosts.length) ? https.hosts : [location.hostname];
    var host = hosts.indexOf(location.hostname) !== -1 ? location.hostname : hosts[0];
    if (host.indexOf(':') !== -1 && host.charAt(0) !== '[') host = '[' + host + ']';
    return 'https://' + host + ':' + https.port + '/';
  }

  function renderInstallHelp(health) {
    var box = $('#install-help');
    var body = $('#install-body');
    var standalone = isStandalone();
    box.hidden = standalone;
    body.textContent = '';
    if (standalone) return;

    var https = health && health.https;

    if (location.protocol === 'https:') {
      body.appendChild(mk('h3', null, 'Android'));
      body.appendChild(stepList(['Oben rechts Menü **⋮** öffnen.', '**„App installieren“** wählen.']));
      body.appendChild(mk('h3', null, 'iPhone'));
      body.appendChild(stepList(['In **Safari** unten auf **Teilen** tippen (Quadrat mit Pfeil).', '**„Zum Home-Bildschirm“** wählen.']));
      return;
    }

    if (!(https && https.enabled)) {
      body.appendChild(mk('p', 'hint', 'Für die Installation als App braucht Boobo HTTPS. Anleitung: README im Repo.'));
      return;
    }

    // http, HTTPS vorhanden: einmalig Zertifikat installieren
    body.appendChild(mk('h3', null, 'Als echte App installieren (einmalig)'));

    body.appendChild(mk('p', 'hint', 'Schritt 1'));
    var dl = mk('a', 'btn ghost link-btn install-btn', 'Zertifikat laden');
    dl.href = https.ca_url || '/boobo-ca.crt';
    dl.setAttribute('download', 'boobo-ca.crt');
    body.appendChild(dl);

    body.appendChild(mk('p', 'hint install-step', 'Schritt 2: Zertifikat installieren'));
    body.appendChild(mk('h3', null, 'Android'));
    body.appendChild(stepList([
      'Einstellungen öffnen → **„Sicherheit und Datenschutz“** → **„Weitere Sicherheitseinstellungen“** → **„Von Gerätespeicher installieren“** → **„CA-Zertifikat“** → **„Trotzdem installieren“**.',
      'Die Datei **boobo-ca.crt** aus den Downloads wählen.'
    ]));
    body.appendChild(mk('p', 'hint', 'Bei anderen Handys: Einstellungen → Sicherheit → „Verschlüsselung & Anmeldedaten“ → „Zertifikat installieren“ → „CA-Zertifikat“.'));
    body.appendChild(mk('h3', null, 'iPhone'));
    body.appendChild(stepList([
      'Zertifikat in **Safari** laden und **„Erlauben“** tippen.',
      'Einstellungen öffnen, oben **„Profil geladen“** → **Installieren**.',
      'Dann Einstellungen → Allgemein → Info → **„Zertifikatsvertrauenseinstellungen“** → **„Boobo Zuhause CA“** einschalten.'
    ]));

    body.appendChild(mk('p', 'hint install-step', 'Schritt 3'));
    var openBtn = mk('a', 'btn primary link-btn install-btn', 'Boobo verschlüsselt öffnen');
    openBtn.href = installHttpsUrl(https);
    body.appendChild(openBtn);
    body.appendChild(richText(mk('p', 'hint'), 'Dort dann Android: **Menü ⋮ → App installieren**, iPhone: **Teilen → Zum Home-Bildschirm**.'));
    body.appendChild(mk('p', 'hint', 'Die alte Verknüpfung könnt ihr löschen. Der Hinweis zum Chrome-Schalter von früher gilt nicht mehr.'));
  }

  // ---------- Init ----------

  function init() {
    initTheme();
    initDialogs();
    initConfirm();
    initChips();
    initClickSwallow();
    initStats();

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
    $('#form-intake').addEventListener('submit', submitIntake);
    $('#btn-intake-delete').addEventListener('click', deleteIntakeEditing);
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

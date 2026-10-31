/* Boobo – Frontend (Vanilla JS) */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';
  var REFRESH_MS = 30000;
  var TICK_MS = 60000;
  var TOAST_MS = 10000;

  var SIDE_NAMES = { left: 'Links', right: 'Rechts', both: 'Beide', bottle: 'Flasche' };
  var SIDE_LETTERS = { left: 'L', right: 'R', both: 'B', bottle: 'F' };

  var state = { state: null, feeds: [], busy: false, online: true };

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
      api('GET', '/api/feeds?limit=100')
    ]).then(function (res) {
      state.state = res[0];
      state.feeds = (res[1] && res[1].feeds) || [];
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

  // ---------- Rendering ----------

  function render() {
    renderStatus();
    renderHistory();
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
      timeEl.textContent = 'Noch nichts notiert';
      sideEl.textContent = '';
      relEl.textContent = 'Beim ersten Stillen einfach unten auf eine Seite tippen.';
      nextEl.textContent = '';
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
      if (untilMin < 0) {
        box.classList.add('overdue');
        relEl.textContent = '';
        relEl.appendChild(el('span', { class: 'line', text: 'Bobo hat bestimmt Hunger' }));
        relEl.appendChild(el('span', { class: 'line sub', text: 'seit ' + formatDuration(-untilMin, 'rel') }));
        nextEl.appendChild(el('span', { class: 'line', text: 'Zuletzt ' + relativeSince(last, now) }));
        nextEl.appendChild(el('span', { class: 'line', text: 'Die ' + formatDuration(interval, 'rel') + ' sind um' }));
      } else {
        if (pct > 0.85) box.classList.add('warn');
        relEl.textContent = relativeSince(last, now);
        nextEl.appendChild(el('span', { class: 'line', text: 'Bobo meldet sich wohl gegen ' + fmtTime.format(due) }));
        nextEl.appendChild(el('span', { class: 'line', text: pct > 0.8 ? 'Bobo wird langsam hungrig' : (pct < 0.5 ? 'Noch Zeit zum Kuscheln' : 'noch etwa ' + formatDuration(untilMin, 'rel')) }));
      }
      ring.style.strokeDashoffset = RING_LEN * (1 - pct);
    }

    var sug = s.suggested_side;
    sugEl.textContent = '';
    if (sug && sug !== 'bottle') {
      sugEl.appendChild(document.createTextNode('Diesmal ist '));
      sugEl.appendChild(el('span', { class: 'chip side-' + sug, text: SIDE_NAMES[sug] }));
      sugEl.lastChild.style.background = 'var(--' + sug + ')';
      sugEl.appendChild(document.createTextNode(' dran'));
    }
    highlightSuggested(sug);
  }

  function highlightSuggested(side) {
    $$('.feed-btn').forEach(function (b) {
      b.classList.toggle('suggested', !!side && side !== 'bottle' && b.getAttribute('data-side') === side);
    });
  }

  function renderHistory() {
    var root = $('#history');
    root.textContent = '';
    var feeds = state.feeds;
    if (!feeds.length) {
      root.appendChild(el('p', { class: 'empty-hint', text: 'Hier erscheint, was ihr notiert habt.' }));
      return;
    }
    var now = new Date();
    // feeds sortiert nach at absteigend; Abstand = zum nächstälteren Eintrag
    var groups = [];
    var map = {};
    feeds.forEach(function (f, i) {
      var d = new Date(f.at);
      var k = dayKey(d);
      if (!map[k]) {
        map[k] = { key: k, label: dayLabel(d, now), items: [] };
        groups.push(map[k]);
      }
      var older = feeds[i + 1];
      map[k].items.push({ feed: f, date: d, gapMin: older ? (d - new Date(older.at)) / 60000 : null });
    });

    groups.forEach(function (g) {
      var head = el('div', { class: 'day-head' }, [
        el('span', { text: g.label }),
        el('span', { class: 'count', text: g.items.length + (g.items.length === 1 ? ' Mal' : ' Mal') })
      ]);
      var list = el('ul', { class: 'day-list' });
      g.items.forEach(function (it) {
        var f = it.feed;
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
        list.appendChild(el('li', null, [row]));
      });
      root.appendChild(el('section', { class: 'day' }, [head, list]));
    });
  }

  // ---------- Toast ----------

  var toastTimer = null;
  function showToast(text, opts) {
    opts = opts || {};
    var t = $('#toast');
    var btn = $('#toast-action');
    clearTimeout(toastTimer);
    $('#toast-text').textContent = text;
    t.classList.toggle('error', !!opts.error);
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
    $$('.feed-btn, #btn-backfill').forEach(function (b) { b.disabled = busy; });
  }

  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }

  function quickLog(side) {
    if (state.busy) return;
    setBusy(true);
    vibrate(15);
    api('POST', '/api/feeds', { side: side }).then(function (res) {
      var feed = res && res.feed;
      return refresh().then(function () {
        var when = feed ? fmtTime.format(new Date(feed.at)) : fmtTime.format(new Date());
        showToast(SIDE_NAMES[side] + ', ' + when + ' – notiert. Ihr macht das toll.', {
          action: feed ? function () { undoFeed(feed.id); } : null
        });
      });
    }).catch(function (err) {
      showToast(errorText(err), { error: true, duration: 6000 });
    }).then(function () { setBusy(false); });
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

  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeDialog(dlg) {
    if (dlg.open) dlg.close();
  }

  function initDialogs() {
    $$('dialog').forEach(function (dlg) {
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
  function openAdd() {
    var dlg = $('#dlg-add');
    var form = $('#form-add');
    var now = new Date();
    form.at.value = toLocalInputValue(now);
    form.at.max = toLocalInputValue(new Date(now.getTime() + 5 * 60000));
    form.note.value = '';
    var sug = (state.state && state.state.suggested_side) || 'left';
    segSet($('.segmented', form), sug);
    openDialog(dlg);
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
    api('POST', '/api/feeds', body).then(function (res) {
      closeDialog($('#dlg-add'));
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
    if (new Date(atIso).getTime() !== new Date(editing.at).getTime()) patch.at = atIso;
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

  // ---------- Init ----------

  function init() {
    initDialogs();

    $$('.feed-btn').forEach(function (b) {
      b.addEventListener('click', function () { quickLog(b.getAttribute('data-side')); });
    });
    $('#btn-backfill').addEventListener('click', openAdd);
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
    setInterval(renderStatus, TICK_MS);
    // Relative Zeiten im Verlauf hängen nicht von "jetzt" ab (nur Tageslabels) – einmal pro Minute reicht
    setInterval(function () { if (state.feeds.length) renderHistory(); }, TICK_MS * 5);

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

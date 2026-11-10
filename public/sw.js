/* Boobo Service Worker – Cache-first für App-Shell, Network-only für /api/ */
// Der Server setzt die Version aus Paketversion und Prüfsumme der Shell-Dateien ein (server.js,
// sendServiceWorker). Ändert sich beim Deploy irgendeine Shell-Datei, ist dieser Worker neu und
// ersetzt den alten Cache – ohne dass hier jemand eine Zahl hochzählen muss.
var CACHE_VERSION = 'boobo-shell-__SHELL_VERSION__';
// Ohne diese Dateien läuft nichts: schlägt ein Download fehl, bleibt der alte Worker samt Cache aktiv.
var SHELL_REQUIRED = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.webmanifest'
];
// Icons sind schön, aber kein Grund, die Installation abzubrechen.
var SHELL_OPTIONAL = [
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // Frisch vom Server, nicht aus dem HTTP-Cache, damit nach einem Deploy nicht die alte Datei landet
      var fresh = function (url) { return new Request(url, { cache: 'reload' }); };
      return Promise.all(SHELL_REQUIRED.map(function (url) {
        return cache.add(fresh(url));
      }).concat(SHELL_OPTIONAL.map(function (url) {
        return cache.add(fresh(url)).catch(function () { /* optional */ });
      })));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return; // Network-only

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});

// ---------------------------------------------------------------------------
// Push: Erinnerungen für Mama (docs/API.md, Erweiterung 7). Der Server schickt { type, title, body, tag, url,
// medications: [{ id, name, dose }] }. Bei genau einem Medikament gibt es die Knöpfe „Genommen“ und „In 15 Minuten“.
// ---------------------------------------------------------------------------

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  var isReminder = data.type === 'reminder';
  var meds = Array.isArray(data.medications) ? data.medications : [];
  var options = {
    body: data.body || '',
    tag: data.tag || 'boobo',
    renotify: true,
    requireInteraction: isReminder,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: data,
    actions: []
  };
  if (isReminder && meds.length === 1) {
    options.actions = [
      { action: 'taken', title: 'Genommen' },
      { action: 'snooze', title: 'In 15 Minuten' }
    ];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Boobo', options));
});

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body || {})
  }).catch(function () { /* offline – die App holt es nach */ });
}

function focusApp(url) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) return list[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url || '/');
    return null;
  });
}

self.addEventListener('notificationclick', function (event) {
  var data = (event.notification && event.notification.data) || {};
  var med = Array.isArray(data.medications) && data.medications.length === 1 ? data.medications[0] : null;
  event.notification.close();
  if (event.action === 'taken' && med) {
    // Doppelschutz „skip“: hat das andere Handy schon notiert, passiert nichts Falsches
    event.waitUntil(postJson('/api/medications/' + med.id + '/intakes', { on_duplicate: 'skip' }));
    return;
  }
  if (event.action === 'snooze' && med) {
    event.waitUntil(postJson('/api/medications/' + med.id + '/reminder', { action: 'snooze', minutes: 15 }));
    return;
  }
  event.waitUntil(focusApp(data.url || '/'));
});

// Der Browser hat die Anmeldung erneuert (passiert selten): neu anmelden und dem Server sagen
self.addEventListener('pushsubscriptionchange', function (event) {
  var old = event.oldSubscription;
  var p = fetch('/api/push/key', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (k) {
    var raw = atob((k.public_key + '===').slice(0, k.public_key.length + (4 - k.public_key.length % 4) % 4).replace(/-/g, '+').replace(/_/g, '/'));
    var key = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }).then(function (sub) {
    var body = sub.toJSON();
    if (old && old.endpoint) body.old_endpoint = old.endpoint;
    return postJson('/api/push/subscriptions', body);
  }).catch(function () { /* beim nächsten App-Start erneut */ });
  event.waitUntil(p);
});

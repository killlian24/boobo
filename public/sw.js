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

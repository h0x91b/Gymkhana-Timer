// Minimal offline cache. Bump CACHE_VERSION on every deploy to invalidate.
const CACHE_VERSION = 'gymkhana-v13';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './camera.js',
  './detector.js',
  './roi.js',
  './timer.js',
  './storage.js',
  './viewport.js',
  './version.js',
  './i18n/index.js',
  './i18n/interpolate.js',
  './i18n/translations/en.js',
  './i18n/translations/ru.js',
  './i18n/translations/es.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Do NOT skipWaiting() here — we want new versions to sit in `waiting`
  // until the client explicitly asks us to take over (see 'message' handler
  // below). That lets app.js decide whether to auto-apply the update (safe
  // states like IDLE / FINISHED) or defer until the user presses the
  // "Update" button (mid-run, where a reload would be disruptive).
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Client-initiated activation. app.js posts { type: 'SKIP_WAITING' } when it
// has decided the moment is right to apply a pending update; this triggers
// install → activating → activated and fires `controllerchange` on clients,
// which app.js uses to reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

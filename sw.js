// Minimal offline cache. Bump CACHE_VERSION on every deploy to invalidate.
const CACHE_VERSION = 'gymkhana-v1';
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
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

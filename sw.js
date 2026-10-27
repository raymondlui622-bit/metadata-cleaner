// Service worker: caches the APP ONLY so it works offline. User files are never fetched,
// so they can never enter this cache. Nothing is ever added to the cache at runtime.
const VERSION = 'mc-v3'; // bump on every release so phones fetch the new app files
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'lib/common.js', 'lib/engine.js', 'lib/heic.js', 'lib/jpeg.js', 'lib/pdf.js', 'lib/png.js', 'lib/tiff.js', 'lib/zip.js',
  'vendor/pdf-lib.esm.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // let the browser handle it (CSP blocks it anyway)
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() =>
      e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});

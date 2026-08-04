/* Trainer App service worker — cache-first shell, network-first for everything else */
const CACHE = 'trainer-v53';
const SHELL = [
  '.', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/vic.js', 'js/score.js', 'js/ui.js',
  'js/plan.js', 'js/sync.js', 'js/fuel.js', 'js/strava.js', 'js/health.js', 'js/onboarding.js', 'js/vic-avatar.js', 'js/exercise-art.js', 'js/vic-sprite.js', 'img/vic-idle.png',
  'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
/* NETWORK-FIRST for same-origin (cookbook pattern): updates land on reload,
   cache is only the offline fallback. Cache-first kept serving stale UI. */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // API + fonts go straight to network
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html')))
  );
});

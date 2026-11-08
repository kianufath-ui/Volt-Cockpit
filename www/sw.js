/* Volt — offline shell + map tile cache */
const SHELL_CACHE = 'scd-shell-v26';
const TILE_CACHE = 'scd-tiles-v4';
const TILE_LIMIT = 900;

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/i18n.js',
  './js/jkbms.js',
  './js/alertEngine.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) {
    const remove = keys.length - max;
    for (let i = 0; i < remove; i++) await cache.delete(keys[i]);
  }
}

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) { await cache.put(req, res.clone()); if (name === TILE_CACHE) trimCache(TILE_CACHE, TILE_LIMIT); }
  return res;
}

// Network-first so code updates apply immediately when online, while the
// cached copy keeps the dashboard usable with no signal.
async function networkFirst(name, req) {
  const cache = await caches.open(name);
  try {
    // no-cache = revalidate with the server, so edits show up immediately.
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first, so the last area still renders without signal.
  if (url.hostname.endsWith('basemaps.cartocdn.com') ||
      url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(TILE_CACHE, req));
    return;
  }

  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      networkFirst(SHELL_CACHE, req)
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(networkFirst(SHELL_CACHE, req));
});

// Service worker: makes the app installable and lets it open without
// internet. Pages/scripts: newest version from the network, cached copy when
// offline. Map tiles and libraries: cached as they're viewed, so maps of
// areas you've already looked at still show offline. /api data is never
// cached here — the app keeps its own copy of the user's data on the device.
const CACHE = 'derech-v7';
const STATIC = 'derech-static-v1';
const TILES = 'derech-tiles-v1';
const MAX_TILES = 3000;
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    const s = await caches.open(STATIC);
    await Promise.all(LIBS.map((u) => fetch(u, { mode: 'no-cors' }).then((r) => s.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![CACHE, STATIC, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => c.delete(k)));
}

// cache first (for things that never change: tiles, versioned libraries, fonts)
async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      const c = await caches.open(cacheName);
      c.put(req, res.clone());
      if (cacheName === TILES) trimTiles();
    }
    return res;
  } catch (e) {
    return hit || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (/tile\.openstreetmap\.org$/.test(url.hostname)) return e.respondWith(cacheFirst(req, TILES));
    if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      return e.respondWith(cacheFirst(req, STATIC));
    }
    return; // everything else (Google Maps, navigation links…) goes straight to the network
  }
  if (url.pathname.startsWith('/api/')) return;

  // Network first (always the newest version), cache as fallback when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/index.html')))
  );
});

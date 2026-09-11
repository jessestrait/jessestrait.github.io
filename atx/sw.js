/* ATX Layers service worker.
 *
 * The rule that matters here: this page is a window onto live city data, so
 * nothing live is ever served from a cache. Only the shell and the prebuilt
 * geometry — the things that change when I deploy, not when Austin does —
 * are stored. Everything else falls through untouched to the network.
 *
 * Bump VERSION to ship a new shell; activate() drops every older cache.
 */
const VERSION = 'atx-v3';
const SHELL = VERSION + '-shell';
const GEO = VERSION + '-geo';
const FONTS = VERSION + '-fonts';
const KEEP = [SHELL, GEO, FONTS];

// The map is unusable without these, so they are fetched up front.
const PRECACHE = [
  './',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one unreachable CDN file can't fail the whole install.
    await Promise.all(PRECACHE.map(u => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Cache first, then network — for things that only change on deploy.
async function fromCache(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // The document itself: network first, so a deploy is visible immediately,
  // with the cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // cache:'reload' rather than a plain fetch, because GitHub Pages serves
        // the HTML with max-age=600 and the browser's own HTTP cache sits in
        // front of this worker — without it, "network first" can still hand
        // back a ten-minute-old document and a deploy appears not to have
        // landed. Fetched by URL, not by passing req: a navigate-mode Request
        // cannot be reconstructed with a different init.
        const res = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' });
        if (res && res.ok) (await caches.open(SHELL)).put('./', res.clone());
        return res;
      } catch (err) {
        const cache = await caches.open(SHELL);
        return (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Prebuilt geometry: ~6.9 MB that is identical until tools/build_atx_geo.py
  // runs again. This is the whole reason for the worker.
  // news.json used to live here and needed an exemption, being a live feed
  // rather than geometry. It is on the `data` branch now and arrives
  // cross-origin from raw.githubusercontent, so it never reaches any of the
  // same-origin rules below and needs no rule of its own.

  if (sameOrigin && url.pathname.startsWith('/atx/data/')) {
    e.respondWith(fromCache(req, GEO));
    return;
  }

  if (sameOrigin && url.pathname.startsWith('/atx/icons/')) {
    e.respondWith(fromCache(req, SHELL));
    return;
  }

  if (url.origin === 'https://unpkg.com') {
    e.respondWith(fromCache(req, SHELL));
    return;
  }

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(fromCache(req, FONTS));
    return;
  }

  // Everything else — Socrata, ArcGIS, api.weather.gov, TomTom flow tiles,
  // Esri basemap tiles, GoatCounter — goes straight to the network, every
  // time. A stale incident is worse than no incident.
});

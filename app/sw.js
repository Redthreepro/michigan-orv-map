// Bump SHELL when app files change so phones pick up the new version.
const SHELL = 'orv-shell-v11';
const DATA = 'orv-data';
const TILES = 'orv-tiles';
const SHELL_FILES = [
  './', 'index.html', 'app.js', 'tracks.js', 'routing.js', 'places.js', 'plan.js', 'offline.js', 'gpx.js', 'weather.js', 'style.css', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png',
];
const DATA_FILES = ['data/trails.geojson', 'data/roads.geojson', 'data/graph.json', 'data/pois.json', 'data/camping_land.geojson', 'data/meta.json'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    await (await caches.open(DATA)).addAll(DATA_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('orv-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The Offline panel asks which files are saved, and can ask to (re)download them.
self.addEventListener('message', (e) => {
  const reply = (m) => e.ports[0] && e.ports[0].postMessage(m);
  const t = e.data && e.data.type;
  if (t === 'status') {
    e.waitUntil((async () => {
      const missing = [];
      const shell = await caches.open(SHELL), data = await caches.open(DATA);
      for (const f of SHELL_FILES) if (!(await shell.match(f, { ignoreSearch: true }))) missing.push(f);
      for (const f of DATA_FILES) if (!(await data.match(f, { ignoreSearch: true }))) missing.push(f);
      reply({ missing, version: SHELL });
    })());
  }
  if (t === 'repair') {
    e.waitUntil((async () => {
      try {
        await (await caches.open(SHELL)).addAll(SHELL_FILES);
        await (await caches.open(DATA)).addAll(DATA_FILES);
        reply({ ok: true });
      } catch { reply({ ok: false }); }
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: saved copy first; otherwise fetch and keep it, so anywhere you've browsed works offline later.
  if (url.hostname === 'basemap.nationalmap.gov') {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req.url, { mode: 'cors' });
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Trail data: try for fresh closures (4s), fall back to the saved copy.
  if (url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const res = await Promise.race([
          fetch(req, { cache: 'no-cache' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000)),
        ]);
        if (res.ok) { cache.put(req, res.clone()); return res; }
        throw new Error('bad');
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || new Response('{}', { status: 504 });
      }
    })());
    return;
  }

  // App shell: serve the saved copy instantly, refresh it in the background for next launch.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || new Response('Offline', { status: 504 });
  })());
});

// Bump SHELL when app files change so phones pick up the new version.
const SHELL = 'orv-shell-v64';
const DATA = 'orv-data';
const TILES = 'orv-tiles';
const SHELL_FILES = [
  'rideview.js',
  './', 'index.html', 'app.js', 'tracks.js', 'routing.js', 'places.js', 'plan.js', 'nav.js', 'offline.js', 'gpx.js', 'weather.js', 'progress.js', 'edit.js', 'select.js', 'updates.js', 'laws.js', 'safety.js', 'merge.js', 'spots.js', 'cloud.js', 'colors.js', 'loops.js', 'conditions.js', 'stats.js', 'watch.html', 'privacy.html', 'details.js', 'style.css', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet-rotate.js', 'vendor/firebase-app-compat.js', 'vendor/firebase-auth-compat.js', 'vendor/firebase-firestore-compat.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png',
];
const fresh = (url) => new Request(url, { cache: 'reload' });
const DATA_FILES = ['data/trails.geojson', 'data/roads.geojson', 'data/graph.json', 'data/pois.json', 'data/camping_land.geojson', 'data/coverage.geojson', 'data/meta.json', 'data/changes.json', 'data/counties.geojson'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // bypass the browser's HTTP cache so a new version never installs yesterday's files
    await (await caches.open(SHELL)).addAll(SHELL_FILES.map(fresh));
    await (await caches.open(DATA)).addAll(DATA_FILES.map(fresh));
    // Keep the active version intact until the rider chooses to reload.
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
  if (t === 'activate-update') { self.skipWaiting(); return; }
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
        // Never overwrite installed code with files from a newer deployment.
        const shell = await caches.open(SHELL);
        for (const f of SHELL_FILES) if (!(await shell.match(f, { ignoreSearch: true }))) {
          reply({ ok: false }); return;
        }
        await (await caches.open(DATA)).addAll(DATA_FILES.map(fresh));
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

  // App shell is immutable within a version. New code installs in a new cache.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // A missing installed script must not be replaced by another release's code.
    if (SHELL_FILES.some((file) => new URL(file, self.location.href).pathname === url.pathname)) {
      return new Response('Installed app files are missing. Reconnect and install the current app version.', { status: 503 });
    }
    try { return await fetch(req, { cache: 'no-cache' }); }
    catch { return new Response('Offline', { status: 504 }); }
  })());
});

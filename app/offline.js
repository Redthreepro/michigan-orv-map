'use strict';
// "Offline ready" checklist + downloading map tiles for the planned trip or the area on screen.

const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const IS_MOBILE = IS_IOS || /Android/.test(navigator.userAgent);
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const MAX_TILES = 30000;
const TRIP_BUFFER_M = 1609;       // map 1 mile each side of the route
const CAMP_BUFFER_M = 4828;       // 3 miles around overnight stops and the ends

// ---------- tile math ----------
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
const tileUrl = (base, z, x, y) => BASES[base].replace('{z}', z).replace('{x}', x).replace('{y}', y);
const tileMeters = (lat, z) => (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

function areaTiles(bounds, maxZ, bases) {
  const urls = [];
  for (const base of bases) {
    for (let z = 6; z <= maxZ; z++) {
      const x0 = lon2x(bounds.getWest(), z), x1 = lon2x(bounds.getEast(), z);
      const y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(tileUrl(base, z, x, y));
      if (urls.length > MAX_TILES) return urls;
    }
  }
  return urls;
}

// Every line you'd follow on the trip: stop → route → stop, including off-trail and gap stretches.
function tripLines() {
  if (!plan || !planLegs.length) return [];
  return planLegs.map((r) => {
    const line = [[r.from.lat, r.from.lng]];
    if (r.path && r.path.length) line.push(...r.path);
    if (r.gap) line.push(r.gap.to);
    line.push([r.to.lat, r.to.lng]);
    return line;
  });
}

function tripTiles(maxZ, bases) {
  const lines = tripLines();
  if (!lines.length) return [];
  const keys = new Set();
  const add = (base, z, x, y) => keys.add(`${base}/${z}/${x}/${y}`);
  const circle = (base, lat, lng, radiusM, z) => {
    const r = Math.ceil(radiusM / tileMeters(lat, z));
    const cx = lon2x(lng, z), cy = lat2y(lat, z);
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) add(base, z, x, y);
  };
  const all = lines.flat();
  const bounds = L.latLngBounds(all);
  for (const base of bases) {
    // overview zooms: the whole trip box
    for (let z = 6; z <= 10; z++) {
      for (let x = lon2x(bounds.getWest(), z); x <= lon2x(bounds.getEast(), z); x++) {
        for (let y = lat2y(bounds.getNorth(), z); y <= lat2y(bounds.getSouth(), z); y++) add(base, z, x, y);
      }
    }
    // detail zooms: a corridor along every line, sampled every ~quarter tile
    for (let z = 11; z <= maxZ; z++) {
      for (const line of lines) {
        for (let i = 0; i < line.length; i++) {
          const [lat, lng] = line[i];
          circle(base, lat, lng, TRIP_BUFFER_M, z);
          if (i < line.length - 1) {
            const [lat2, lng2] = line[i + 1];
            const step = tileMeters(lat, z) / 4;
            const n = Math.floor(hav(lat, lng, lat2, lng2) / step);
            for (let k = 1; k < n; k++) circle(base, lat + ((lat2 - lat) * k) / n, lng + ((lng2 - lng) * k) / n, TRIP_BUFFER_M, z);
          }
        }
      }
      // more room to look around camp and at the ends
      plan.stops.forEach((s, i) => {
        if (s.night || i === 0 || i === plan.stops.length - 1) circle(base, s.lat, s.lng, CAMP_BUFFER_M, z);
      });
      if (keys.size > MAX_TILES) break;
    }
  }
  return [...keys].map((k) => { const [b, z, x, y] = k.split('/'); return tileUrl(b, +z, +x, +y); });
}

const estMB = (urls) => Math.max(1, Math.round(urls.reduce((a, u) => a + (u.includes('Imagery') ? TILE_KB.sat : TILE_KB.topo), 0) / 1024));

async function savedSet() {
  try { return new Set((await (await caches.open(TILE_CACHE)).keys()).map((r) => r.url)); } catch { return new Set(); }
}

// ---------- downloading ----------
let downloading = false;
async function download(urls, label) {
  if (downloading) return;
  if (!navigator.onLine) return toast('You need signal to download. Do this before you head out.');
  downloading = true;
  document.querySelectorAll('.dl-btn').forEach((b) => { b.disabled = true; });
  const prog = $('#save-progress');
  prog.hidden = false;
  const bar = prog.querySelector('.bar span');
  const status = $('#save-status');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const cache = await caches.open(TILE_CACHE);
  const have = await savedSet();
  const todo = urls.filter((u) => !have.has(u));
  let done = urls.length - todo.length, failed = 0, i = 0;
  const show = () => {
    bar.style.width = (100 * done / urls.length).toFixed(1) + '%';
    status.textContent = `${label}: ${done.toLocaleString()} / ${urls.length.toLocaleString()} tiles` + (failed ? ` · ${failed} failed` : '');
  };
  show();
  async function worker() {
    while (i < todo.length) {
      const url = todo[i++];
      try {
        const r = await fetch(url, { mode: 'cors' });
        if (r.ok) await cache.put(url, r); else failed++;
      } catch { failed++; }
      done++;
      if (done % 10 === 0 || done === urls.length) show();
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  downloading = false;
  document.querySelectorAll('.dl-btn').forEach((b) => { b.disabled = false; });
  status.textContent = failed ? `Done, but ${failed} tiles failed. Tap download again to retry them.` : `${label}: saved. Works with no signal.`;
  toast(failed ? 'Saved with some gaps' : `${label} saved for offline`);
  refreshOffline();
}

// ---------- readiness checks ----------
function askWorker(msg, timeout = 4000) {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return resolve(null);
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), timeout);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    sw.postMessage(msg, [ch.port2]);
  });
}

async function checks() {
  const out = [];
  // 1. running as the home-screen app
  if (IS_MOBILE) {
    out.push(isStandalone()
      ? { ok: true, text: 'Opened from your home-screen icon.' }
      : { ok: false, text: 'You\'re in a browser tab. Saved maps here won\'t be in the home-screen app.', fix: IS_IOS
        ? 'In Chrome: tap Share (square with arrow, in the address bar) → Add to Home Screen. Then always open it from that icon and save your maps there.'
        : 'Browser menu → Add to Home screen / Install app. Then open it from that icon.' });
  }
  // 2. app + data files saved
  const st = await askWorker({ type: 'status' });
  if (!st) out.push({ ok: false, text: 'The app isn\'t saved for offline yet. Keep it open with signal for a minute.', action: 'reload', label: 'Retry' });
  else if (st.missing.length) out.push({ ok: false, text: `${st.missing.length} app file(s) missing for offline use.`, action: 'repair', label: 'Download now' });
  else out.push({ ok: true, text: 'App, trails, forest roads, routing, gas & campgrounds saved on this phone.' });
  // 3. trail data age
  const built = $('#data-info').dataset.built;
  if (built) {
    const days = Math.floor((Date.now() - new Date(built.replace(' ', 'T')).getTime()) / 86400000);
    out.push(days <= 7
      ? { ok: true, text: `Closures current as of ${built}.` }
      : { ok: false, text: `Closure info is ${days} days old (${built}). Open the app with signal to refresh.` });
  }
  // 4. storage protected
  if (navigator.storage && navigator.storage.persisted) {
    const p = await navigator.storage.persisted().catch(() => false);
    out.push(p ? { ok: true, text: 'Storage protected, so the phone won\'t clear it.' }
      : { ok: false, soft: true, text: 'Storage not marked protected. The phone could clear it if space runs low.', action: 'persist', label: 'Protect' });
  }
  // 5. location
  if (navigator.permissions && navigator.permissions.query) {
    const perm = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null);
    if (perm) out.push(perm.state === 'granted' ? { ok: true, text: 'Location allowed.' }
      : perm.state === 'denied' ? { ok: false, text: 'Location is blocked.', fix: 'Settings → Privacy & Security → Location Services → allow the entry for web apps (may be named "Safari Websites"), While Using + Precise Location.' }
      : { ok: false, soft: true, text: 'Location not allowed yet.', action: 'locate', label: 'Allow' });
  }
  // 6. map for the planned trip
  if (plan && planLegs.length) {
    const urls = tripTiles(+$('#trip-zoom').value, [baseKey]);
    const have = await savedSet();
    const pct = urls.length ? Math.floor((100 * urls.filter((u) => have.has(u)).length) / urls.length) : 0;
    out.push(pct >= 99 ? { ok: true, text: 'Map saved along your whole trip.' }
      : { ok: false, text: `Map along your trip: ${pct}% saved.`, action: 'trip', label: 'Get ready' });
  } else {
    out.push({ ok: true, soft: true, info: true, text: 'No trip planned. Save the areas you\'ll ride below, or plan a trip first.' });
  }
  // rides / waypoints backup
  const rides = (await allTracks().catch(() => [])).filter((t) => t.done).length;
  const wpsN = ((await tx('readonly', (s) => s.count(), 'waypoints').catch(() => 0)) || 0);
  if (rides + wpsN > 0) {
    let last = 0;
    try { last = +localStorage.getItem('orv.lastBackup') || 0; } catch {}
    const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
    out.push(last && days <= 30 ? { ok: true, text: `Rides & waypoints backed up ${days === 0 ? 'today' : days + ' days ago'}.` }
      : { ok: false, soft: true, text: last ? `Last backup was ${days} days ago.` : `${rides} ride(s) and ${wpsN} waypoint(s) aren't backed up anywhere.`, action: 'backup', label: 'Back up' });
  }
  if (IS_IOS) out.push({ info: true, text: 'Ride days on iPhone: set Settings → Display & Brightness → Auto-Lock → Never. GPS pauses when the screen locks.' });
  return out;
}

async function refreshOffline() {
  const list = await checks();
  const bad = list.filter((c) => c.ok === false && !c.soft).length;
  const warn = list.filter((c) => c.ok === false && c.soft).length;
  $('#ready-summary').className = 'ready ' + (bad ? 'bad' : warn ? 'warn' : 'good');
  $('#ready-summary').textContent = bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix before losing signal` : warn ? 'Almost ready for no signal' : 'Ready for no signal';
  $('#ready-list').innerHTML = list.map((c, i) => `<li class="${c.info ? 'info' : c.ok ? 'ok' : c.soft ? 'soft' : 'bad'}">
      <i>${c.info ? 'i' : c.ok ? '&#10003;' : '!'}</i><div>${esc(c.text)}${c.fix ? `<small>${esc(c.fix)}</small>` : ''}</div>
      ${c.action ? `<button class="ghost small" data-i="${i}">${esc(c.label)}</button>` : ''}</li>`).join('');
  $('#ready-list')._checks = list;
  $('#btn-save').classList.toggle('alert', bad > 0);
  // trip section
  const hasTrip = !!(plan && planLegs.length);
  $('#trip-dl').hidden = !hasTrip;
  if (hasTrip) updateTripEstimate();
  updateAreaEstimate();
  try {
    const n = (await savedSet()).size;
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    $('#storage-info').textContent = `${n.toLocaleString()} map tiles saved` + (est ? ` · ${(est.usage / 1e6).toFixed(0)} MB used` : '');
  } catch {}
}
window.refreshOffline = refreshOffline;

$('#ready-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const c = $('#ready-list')._checks[+btn.dataset.i];
  if (c.action === 'reload') location.reload();
  if (c.action === 'repair') { btn.disabled = true; btn.textContent = 'Downloading…'; const r = await askWorker({ type: 'repair' }, 120000); toast(r && r.ok ? 'App saved for offline' : 'Download failed. Try again with better signal.'); }
  if (c.action === 'persist') { const ok = await navigator.storage.persist().catch(() => false); toast(ok ? 'Storage protected' : 'The phone declined. It usually allows this for home-screen apps you use often.'); }
  if (c.action === 'locate') { ensureGpsFix(); setTimeout(refreshOffline, 4000); return; }
  if (c.action === 'trip') return downloadTrip();
  if (c.action === 'backup') return backupAll();
  refreshOffline();
});

// ---------- trip + area sections ----------
function tripBases() { return $('#trip-sat').checked ? ['topo', 'sat'] : [baseKey]; }
function updateTripEstimate() {
  const urls = tripTiles(+$('#trip-zoom').value, tripBases());
  $('#trip-est').textContent = urls.length > MAX_TILES
    ? 'This trip is very long for that detail. Pick Normal detail, or download it in parts.'
    : `${urls.length.toLocaleString()} tiles · about ${estMB(urls)} MB · 1 mile each side of the route, 3 miles around camps and ends`;
}
function downloadTrip() {
  const urls = tripTiles(+$('#trip-zoom').value, tripBases());
  if (urls.length > MAX_TILES) return toast('Too many tiles. Pick Normal detail.');
  download(urls, 'Trip map');
}
$('#trip-zoom').addEventListener('change', updateTripEstimate);
$('#trip-sat').addEventListener('change', updateTripEstimate);
$('#btn-trip-dl').addEventListener('click', downloadTrip);

function areaUrls() { return areaTiles(map.getBounds(), +$('#save-zoom').value, $('#save-sat').checked ? ['topo', 'sat'] : [baseKey]); }
function updateAreaEstimate() {
  const urls = areaUrls();
  const big = urls.length > MAX_TILES;
  $('#save-est').textContent = big ? 'Too big at this detail. Zoom in, or pick lower detail.' : `${urls.length.toLocaleString()} tiles · about ${estMB(urls)} MB`;
  $('#btn-save-go').disabled = big || downloading;
}
window.updateAreaEstimate = updateAreaEstimate;
$('#save-zoom').addEventListener('change', updateAreaEstimate);
$('#save-sat').addEventListener('change', updateAreaEstimate);
$('#btn-save-go').addEventListener('click', () => { const u = areaUrls(); if (u.length <= MAX_TILES) download(u, 'This area'); });

$('#btn-save').addEventListener('click', () => {
  if (!downloading) $('#save-progress').hidden = true;
  openSheet('#panel-save');
  refreshOffline();
});

// ---------- first open ----------
function showWelcome() {
  document.querySelectorAll('#welcome-rig button').forEach((b) => b.classList.toggle('on', +b.dataset.rig === rig));
  $('#welcome-range').value = store.get('range', '') || '';
  const inst = $('#welcome-install');
  inst.hidden = !(IS_MOBILE && !isStandalone());
  inst.textContent = IS_IOS
    ? 'To use it with no signal: in Chrome tap Share (square with arrow) → Add to Home Screen, then always open it from that icon.'
    : 'To use it with no signal: browser menu → Add to Home screen, then open it from that icon.';
  openSheet('#panel-welcome');
}
document.querySelectorAll('#welcome-rig button').forEach((b) => b.addEventListener('click', () => {
  setRig(+b.dataset.rig);
  document.querySelectorAll('#welcome-rig button').forEach((x) => x.classList.toggle('on', x === b));
}));
function finishWelcome() {
  const v = Math.round(+$('#welcome-range').value);
  if (v > 0) { store.set('range', v); $('#fuel-range').value = v; }
  store.set('welcomed', 1);
  try { localStorage.setItem('orv.installTip', '1'); } catch {}  // the welcome already covered installing
  $('#install-tip').hidden = true;
  closeSheets();
}
$('#btn-welcome-go').addEventListener('click', finishWelcome);
$('#panel-welcome .close').addEventListener('click', () => store.set('welcomed', 1));
$('#btn-help').addEventListener('click', showWelcome);
if (!store.get('welcomed', 0)) setTimeout(showWelcome, 600);

if (IS_MOBILE && !isStandalone() && store.get('welcomed', 0)) {
  let seen = false;
  try { seen = localStorage.getItem('orv.installTip') === '1'; } catch {}
  if (!seen) {
    setTimeout(() => {
      $('#install-tip').hidden = false;
    }, 1500);
  }
}
$('#install-tip').addEventListener('click', (e) => {
  if (e.target.closest('.x')) { try { localStorage.setItem('orv.installTip', '1'); } catch {} $('#install-tip').hidden = true; }
});
$('#install-tip-text').textContent = IS_IOS
  ? 'To use this with no signal: in Chrome tap Share (square with arrow) → Add to Home Screen, then always open it from that icon.'
  : 'To use this with no signal: browser menu → Add to Home screen, then open it from that icon.';

// ask the phone to protect storage once we're the installed app
if (isStandalone() && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// quick background check so the download button can show a warning dot
setTimeout(refreshOffline, 4000);
navigator.serviceWorker && navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(refreshOffline, 1000));

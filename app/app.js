'use strict';

const BASES = {
  topo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  sat: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
};
const TILE_KB = { topo: 20, sat: 28 };
const TILE_CACHE = 'orv-tiles';
const MAX_SAVE_TILES = 20000;

const KIND = {
  route:    { label: 'ORV route',        color: '#f28c28' },
  trail:    { label: 'ORV / ATV trail',  color: '#2fbf4a' },
  mc:       { label: 'Motorcycle trail', color: '#2b8cff' },
  mccct:    { label: 'Cross Country Cycle Trail', color: '#b05cff' },
  closure:  { label: 'Temporary closure', color: '#ff2d2d' },
  reroute:  { label: 'Temporary reroute', color: '#ffd400' },
  scramble: { label: 'Scramble area',    color: '#f28c28' },
  road:     { label: 'State forest road', color: '#12a89d' },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('orv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('orv.' + k, JSON.stringify(v)); } catch {} },
};

// ---------- map ----------
const view = store.get('view', { c: [44.6, -85.4], z: 7 });
const map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 18, minZoom: 5 })
  .setView(view.c, view.z);
const renderer = L.canvas({ tolerance: 14 });
// fixed stacking: camping land (350) < forest roads (380) < trails (overlay, 400) < planned route (450) < markers
map.createPane('roads').style.zIndex = 380;
const roadRenderer = L.canvas({ pane: 'roads', tolerance: 10 });
map.createPane('plan').style.zIndex = 450;
const planRenderer = L.canvas({ pane: 'plan' });
map.attributionControl.setPrefix('');

let baseKey = store.get('base', 'topo');
let baseLayer;
function setBase(key) {
  baseKey = key;
  store.set('base', key);
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(BASES[key], {
    maxNativeZoom: 16, maxZoom: 18, crossOrigin: true,
    attribution: 'USGS The National Map · Trails: Michigan DNR · Gas &amp; campgrounds: © OpenStreetMap contributors',
  }).addTo(map);
  baseLayer.bringToBack();
  document.querySelectorAll('#base-seg button').forEach((b) => b.classList.toggle('on', b.dataset.base === key));
}
setBase(baseKey);

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('view', { c: [+c.lat.toFixed(5), +c.lng.toFixed(5)], z: map.getZoom() });
  if (!$('#panel-save').hidden && window.updateAreaEstimate) updateAreaEstimate();
});

// ---------- width fit ----------
let rig = store.get('rig', 0);
if (![0, 50, 64, 72].includes(rig)) rig = 0; // old "Full-size" option was removed

// p.lim = widest machine (inches) the DNR trail class legally allows; set by build.py
function fits(p) { return !rig || p.t === 'scramble' || (p.lim || 0) >= rig; }
function isClosed(p) { return /closed/i.test(p.s || ''); }

// ---------- trail layers ----------
const layers = {};
const shown = store.get('shown', { route: 1, trail: 1, mc: 1, mccct: 1, scramble: 1, closed: 1 });
if (shown.road === undefined) shown.road = 1;
const ROAD_MIN_ZOOM = 10; // 38k forest roads: only draw once zoomed in
let highlight = null;

function lineWeight() {
  const z = map.getZoom();
  return z <= 8 ? 2 : z <= 10 ? 3 : z <= 13 ? 4 : 6;
}

function styleFor(f) {
  const p = f.properties;
  if (p.t === 'scramble') return { color: KIND.scramble.color, weight: 2, fillOpacity: 0.25 };
  const w = lineWeight();
  if (p.t === 'closure') return { color: KIND.closure.color, weight: w + 1, dashArray: '8 6', opacity: 1 };
  if (p.t === 'road') return { color: KIND.road.color, weight: Math.max(2, w - 1), opacity: 0.9, dashArray: p.sea || p.mil ? '6 5' : null };
  if (p.t === 'reroute') return { color: KIND.reroute.color, weight: w + 1, dashArray: '8 6', opacity: 1 };
  return {
    color: isClosed(p) ? KIND.closure.color : KIND[p.t].color,
    weight: w,
    opacity: 0.95,
    dashArray: p.t === 'mc' || p.t === 'mccct' ? '1 0' : null,
  };
}

const DRAW_ORDER = ['scramble', 'road', 'route', 'trail', 'mc', 'mccct', 'closure', 'reroute'];
const nameIndex = new Map();
const allByKind = {};

async function loadTrails() {
  const [res, meta] = await Promise.all([
    fetch('data/trails.geojson'),
    fetch('data/meta.json').then((r) => r.json()).catch(() => null),
  ]);
  const fc = await res.json();
  for (const f of fc.features) (allByKind[f.properties.t] ||= []).push(f);

  for (const kind of DRAW_ORDER) {
    if (kind === 'road') { layers.road = L.featureGroup(); continue; }
    layers[kind] = L.geoJSON(null, {
      renderer, style: styleFor, filter: (f) => fits(f.properties),
      onEachFeature: (f, l) => l.on('click', (e) => { L.DomEvent.stop(e); showDetail(f, l, e.latlng); }),
    });
  }
  fillLayers();
  applyVisibility();
  // forest roads are big; load them after the trails are already on screen
  fetch('data/roads.geojson').then((r) => r.json()).then((roads) => {
    buildRoadCells(roads.features);
    applyVisibility();
  }).catch(() => toast('Could not load forest roads'));
  if (meta) {
    $('#data-info').textContent = `Trail data: Michigan DNR, checked ${meta.built} · ${meta.closures} ORV closure segments.`;
    $('#data-info').dataset.built = meta.built;
  }
}

// (re)load only what the selected machine may legally ride
function fillLayers() {
  for (const [kind, layer] of Object.entries(layers)) {
    if (kind === 'road') continue; // forest roads are open to every ORV size
    layer.clearLayers();
    layer.addData({ type: 'FeatureCollection', features: allByKind[kind] || [] });
  }
  buildIndex();
}

function buildIndex() {
  nameIndex.clear();
  // search index: unique names -> bounds
  const seen = new Set();
  for (const kind of ['route', 'trail', 'mc', 'scramble', 'mccct']) {
    layers[kind].eachLayer((l) => {
      const n = l.feature.properties.n;
      if (!n) return;
      // MCCCT segments reuse names from the route/trail they share; list those once
      if (kind === 'mccct' && seen.has(n)) return;
      if (kind !== 'mccct') seen.add(n);
      const key = kind + '|' + n;
      const b = l.getBounds();
      const cur = nameIndex.get(key);
      if (cur) cur.b.extend(b); else nameIndex.set(key, { n, kind, b: L.latLngBounds(b.getSouthWest(), b.getNorthEast()), co: l.feature.properties.co });
    });
  }
}

function applyVisibility() {
  let added = false;
  for (const kind of DRAW_ORDER) {
    const layer = layers[kind];
    if (!layer) continue;
    const key = kind === 'closure' || kind === 'reroute' ? 'closed' : kind;
    const on = shown[key] && (kind !== 'road' || map.getZoom() >= ROAD_MIN_ZOOM);
    if (on && !map.hasLayer(layer)) { layer.addTo(map); added = true; } else if (!on) map.removeLayer(layer);
  }
  // canvas draws in add order; re-stack so roads stay under trails and closures on top
  updateRoads();
  if (added) for (const kind of DRAW_ORDER) if (kind !== 'road' && map.hasLayer(layers[kind])) layers[kind].bringToFront();
  if (highlight) highlight.bringToBack();
}
map.on('zoomend', applyVisibility);

// Forest roads are bucketed into ~17-mile squares; only squares near the view are on the map,
// so zooming/panning projects a few thousand lines instead of 38k.
const ROAD_CELL = 0.25;
const roadCells = [];
function buildRoadCells(features) {
  const buckets = new Map();
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates[0];
    const key = Math.floor(lng / ROAD_CELL) + ',' + Math.floor(lat / ROAD_CELL);
    (buckets.get(key) || buckets.set(key, []).get(key)).push(f);
  }
  for (const feats of buckets.values()) {
    const layer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      renderer: roadRenderer, style: styleFor,
      onEachFeature: (f, l) => l.on('click', (e) => { L.DomEvent.stop(e); showDetail(f, l, e.latlng); }),
    });
    roadCells.push({ layer, bounds: layer.getBounds() });
  }
}
function updateRoads() {
  if (!map.hasLayer(layers.road)) return;
  const view = map.getBounds().pad(0.25);
  for (const c of roadCells) {
    const want = view.intersects(c.bounds);
    const has = layers.road.hasLayer(c.layer);
    if (want && !has) { c.layer.setStyle(styleFor); layers.road.addLayer(c.layer); } else if (!want && has) layers.road.removeLayer(c.layer);
  }
}
map.on('moveend', updateRoads);

function restyle() {
  for (const layer of Object.values(layers)) layer.setStyle(styleFor);
}
map.on('zoomend', restyle);

// ---------- detail sheet ----------
function showDetail(f, clicked, latlng) {
  const p = f.properties;
  const status = p.s || (p.t === 'closure' ? 'Temporarily Closed' : p.t === 'reroute' ? 'Temporary reroute'
    : p.t === 'road' ? (p.sea || p.mil ? 'Seasonally closed to ORVs' : 'Open to ORVs') : null);
  const cls = /closed/i.test(status || '') ? 'closed' : /reroute/i.test(status || '') ? 'reroute' : 'open';
  let total = 0;
  if (p.n && layers[p.t] && !['closure', 'reroute', 'road'].includes(p.t)) {
    layers[p.t].eachLayer((l) => { if (l.feature.properties.n === p.n) total += l.feature.properties.mi || 0; });
  } else total = p.mi || 0;
  const rows = [
    ['Allowed', p.lim === 24 ? 'Motorcycles only' : p.lim ? `Machines up to ${p.lim}" wide` : null], ['Trail width', p.w], ['Surface', p.sf], ['Length', total ? total.toFixed(1) + ' mi' : null],
    ['County', p.co], ['Runs on', p.rd],
  ].filter(([, v]) => v);
  let html = `<h3>${esc(p.n || KIND[p.t].label)}</h3>
    <span class="tag kind">${esc(KIND[p.t].label)}</span>${status ? `<span class="tag ${cls}">${esc(status)}</span>` : ''}${p.hc === 2 ? '<span class="tag reroute">4x4 + high clearance</span>' : p.hc === 1 ? '<span class="tag reroute">High clearance</span>' : ''}`;
  if (rows.length) html += '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
  if (p.r) html += `<div class="note restrict">${esc(p.r)}</div>`;
  if (p.t === 'road' && p.od) html += `<div class="note restrict">DNR ORV dates for this road: opening ${esc(p.od)}, closing ${esc(p.cd || '?')}.</div>`;
  if (p.mil) html += `<div class="note restrict">Camp Grayling military road. May close without notice for training. Check Camp Grayling's Facebook page before riding.</div>`;
  if (p.c) html += `<div class="note">${esc(p.c)}</div>`;
  html += `<div class="rec-row"><button class="primary" id="btn-detail-route">Route here</button><button class="ghost" id="btn-detail-trip">Add to trip</button></div>`;
  $('#sheet-body').onclick = null;
  $('#sheet-body').innerHTML = html;
  const target = latlng || (clicked.getCenter ? clicked.getCenter() : clicked.getBounds().getCenter());
  const label = p.n || KIND[p.t].label;
  $('#btn-detail-route').addEventListener('click', () => window.routeHere && window.routeHere(target, label));
  $('#btn-detail-trip').addEventListener('click', () => window.addToTrip && window.addToTrip(target, label));
  openSheet('#sheet');
  highlightName(p, clicked);
}

function highlightName(p, clicked) {
  if (highlight) map.removeLayer(highlight);
  const feats = [];
  if (p.n && layers[p.t] && !['closure', 'reroute', 'road'].includes(p.t)) {
    layers[p.t].eachLayer((l) => { if (l.feature.properties.n === p.n) feats.push(l.feature); });
  } else feats.push(clicked.feature);
  highlight = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
    renderer, interactive: false,
    style: { color: '#fff', weight: lineWeight() + 6, opacity: 0.55, fillOpacity: 0.1 },
  }).addTo(map);
  // halo goes under the colored lines
  highlight.bringToBack();
}

// ---------- sheets ----------
function openSheet(sel) {
  document.querySelectorAll('.sheet').forEach((s) => { s.hidden = s !== document.querySelector(sel); });
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
  if (highlight) { map.removeLayer(highlight); highlight = null; }
}
document.querySelectorAll('.sheet .close').forEach((b) => b.addEventListener('click', closeSheets));
map.on('click', () => { closeSheets(); $('#results').hidden = true; });

// ---------- layers panel ----------
$('#btn-layers').addEventListener('click', () => openSheet('#panel-layers'));
document.querySelectorAll('#base-seg button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
document.querySelectorAll('[data-kind]').forEach((cb) => {
  cb.checked = !!shown[cb.dataset.kind];
  cb.addEventListener('change', () => { shown[cb.dataset.kind] = cb.checked ? 1 : 0; store.set('shown', shown); applyVisibility(); });
});
function setRig(v) {
  const changed = v !== rig;
  rig = v; store.set('rig', v);
  document.querySelectorAll('#rig-seg button').forEach((b) => b.classList.toggle('on', +b.dataset.rig === v));
  if (changed && layers.route) {
    if (highlight) { map.removeLayer(highlight); highlight = null; }
    fillLayers();
    applyVisibility();
  }
}
document.querySelectorAll('#rig-seg button').forEach((b) => b.addEventListener('click', () => setRig(+b.dataset.rig)));
setRig(rig);

$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('Delete all saved map tiles? Trails stay saved.')) return;
  await caches.delete(TILE_CACHE);
  if (window.refreshOffline) refreshOffline();
  toast('Saved tiles deleted');
});

// ---------- search ----------
const search = $('#search');
const results = $('#results');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  if (q.length < 2) { results.hidden = true; return; }
  const hits = [...nameIndex.values()].filter((e) => e.n.toLowerCase().includes(q)).slice(0, 25);
  for (const p of window.POIS || []) {
    if (p.t === 'th' && p.n.toLowerCase().includes(q) && hits.length < 30) hits.push({ n: p.n, kind: 'th', poi: p });
  }
  results.innerHTML = hits.length
    ? hits.map((e, i) => `<li data-i="${i}">${esc(e.n)}<small>${e.poi ? 'ORV trailhead / parking' : KIND[e.kind].label}${e.co ? ' · ' + esc(e.co) + ' County' : ''}</small></li>`).join('')
    : '<li>No matches</li>';
  results.hidden = false;
  results.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const e = hits[+li.dataset.i];
    if (e.poi) { results.hidden = true; search.blur(); map.setView([e.poi.lat, e.poi.lng], 14); return showPlace(e.poi); }
    map.fitBounds(e.b, { padding: [40, 40], maxZoom: 15 });
    results.hidden = true; search.blur();
    let first = null;
    layers[e.kind].eachLayer((l) => { if (!first && l.feature.properties.n === e.n) first = l; });
    if (first) showDetail(first.feature, first);
  }));
});

// ---------- GPS ----------
let watchId = null, follow = false, meMarker = null, meCircle = null;
const locBtn = $('#btn-locate');
const meIcon = () => L.divIcon({ className: 'me-wrap', html: '<div class="me-head" hidden></div><div class="me"></div>', iconSize: [20, 20] });

function setLocState() {
  locBtn.classList.toggle('on', watchId !== null && !follow);
  locBtn.classList.toggle('follow', watchId !== null && follow);
}
function onPos(pos) {
  const { latitude: lat, longitude: lng, accuracy, heading, speed, altitude } = pos.coords;
  const ll = [lat, lng];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: meIcon(), interactive: false, zIndexOffset: 1000 }).addTo(map);
    meCircle = L.circle(ll, { radius: accuracy, renderer, interactive: false, color: '#1f6fe5', weight: 1, fillOpacity: 0.12 }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 14));
  } else {
    meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(accuracy);
    if (follow) map.panTo(ll, { animate: true });
  }
  const head = meMarker.getElement()?.querySelector('.me-head');
  if (head) {
    const moving = heading != null && !isNaN(heading) && speed > 1;
    head.hidden = !moving;
    if (moving) head.style.transform = `rotate(${heading}deg)`;
  }
  const bits = [`${lat.toFixed(5)}, ${lng.toFixed(5)}`, `±${Math.round(accuracy * 3.281)} ft`];
  if (altitude != null) bits.push(`${Math.round(altitude * 3.281)} ft elev`);
  if (speed != null && speed > 0.5) bits.push(`${Math.round(speed * 2.237)} mph`);
  $('#scale-info').textContent = bits.join(' · ');
  if (window.onTrackPos) window.onTrackPos(pos);
  if (window.onPlanPos) window.onPlanPos(pos);
}
function onPosErr(err) {
  toast(err.code === 1 ? 'Location permission denied — allow it in your browser settings.' : 'No GPS fix yet…');
  if (err.code === 1) stopLocate();
}
function stopLocate() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; follow = false;
  if (meMarker) { map.removeLayer(meMarker); map.removeLayer(meCircle); meMarker = meCircle = null; }
  $('#scale-info').textContent = '';
  setLocState();
}
locBtn.addEventListener('click', () => {
  if (watchId === null) {
    if (!navigator.geolocation) return toast('No GPS in this browser');
    follow = true;
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  } else if (!follow) {
    follow = true;
    if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 14));
  } else if (window.isRecording && window.isRecording()) {
    follow = false;
    toast('GPS stays on while a ride is recording');
  } else {
    stopLocate();
  }
  setLocState();
});
map.on('dragstart', () => { if (follow) { follow = false; setLocState(); } });

// ---------- misc ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500);
}
function netState() { $('#net').hidden = navigator.onLine; }
addEventListener('online', netState); addEventListener('offline', netState); netState();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadTrails().catch(() => toast('Could not load trail data'));

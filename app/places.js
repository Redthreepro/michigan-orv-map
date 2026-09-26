'use strict';
// Gas stations, campgrounds, free (dispersed) camping land, and your own saved waypoints.

window.POIS = null;
let LAND = null;               // [{ bbox, rings }] for point-in-polygon checks
let landLayer = null;
let waypoints = [];
const poiLayer = L.layerGroup().addTo(map);
const wpLayer = L.layerGroup().addTo(map);
const POI_MIN_ZOOM = { gas: 11, camp: 9, th: 7 };
const MAX_MARKERS = 400;
for (const k of ['gas', 'camp', 'land', 'wp', 'th']) if (shown[k] === undefined) shown[k] = 1;

// camping land sits under everything else
map.createPane('land').style.zIndex = 350;
const landRenderer = L.canvas({ pane: 'land' });

const GLYPH = {
  gas: '<svg viewBox="0 0 24 24"><path d="M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M7 8h5M14 10h2a1 1 0 0 1 1 1v5a1.5 1.5 0 0 0 3 0V8l-3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  camp: '<svg viewBox="0 0 24 24"><path d="M3 20 12 5l9 15M12 20l-3-5M12 20l3-5M2 20h20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trailhead: '<svg viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-3 4 3 4H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  th: '<svg viewBox="0 0 24 24"><path d="M8 20V4h5.5a4.5 4.5 0 0 1 0 9H8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="3" fill="currentColor"/></svg>',
};
const WP_TYPES = { camp: 'Camp spot', gas: 'Gas', trailhead: 'Trailhead', pin: 'Other' };

function poiIcon(kind) { return L.divIcon({ className: 'poi poi-' + kind, html: GLYPH[kind], iconSize: [24, 24] }); }
function wpIcon(type) { return L.divIcon({ className: 'wp wp-' + type, html: GLYPH[type] || GLYPH.pin, iconSize: [30, 30], iconAnchor: [15, 30] }); }

// ---------- load ----------
fetch('data/pois.json').then((r) => r.json()).then((p) => { window.POIS = p; updatePois(); }).catch(() => {});
fetch('data/camping_land.geojson').then((r) => r.json()).then((fc) => {
  LAND = fc.features.map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let minx = 180, maxx = -180, miny = 90, maxy = -90;
    for (const poly of polys) for (const [x, y] of poly[0]) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    return { bbox: [minx, miny, maxx, maxy], polys };
  });
  landLayer = L.geoJSON(fc, {
    renderer: landRenderer, interactive: false,
    style: { stroke: false, fillColor: '#4caf50', fillOpacity: 0.2 },
  });
  applyPlaces();
}).catch(() => {});

// ---------- dispersed camping check ----------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
window.campingAt = (lat, lng) => {
  if (!LAND) return { ok: false, text: 'Camping land still loading…' };
  for (const f of LAND) {
    const [a, b, c, d] = f.bbox;
    if (lng < a || lng > c || lat < b || lat > d) continue;
    for (const poly of f.polys) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h))) {
        return { ok: true, text: 'Free camping allowed: state forest land, more than 1 mile from a state forest campground. Post a camp registration card. Obey any "No Camping" signs.' };
      }
    }
  }
  return { ok: false, text: 'Not a free camping spot (not state forest land, or within 1 mile of a state forest campground). Use a campground.' };
};

// ---------- markers ----------
function applyPlaces() {
  if (landLayer) {
    const on = shown.land && map.getZoom() >= 8;
    if (on && !map.hasLayer(landLayer)) landLayer.addTo(map); else if (!on) map.removeLayer(landLayer);
  }
  if (shown.wp) wpLayer.addTo(map); else map.removeLayer(wpLayer);
  updatePois();
}
function updatePois() {
  poiLayer.clearLayers();
  if (!window.POIS) return;
  const z = map.getZoom();
  const view = map.getBounds().pad(0.2);
  let n = 0;
  for (const p of POIS) {
    if (!shown[p.t] || z < POI_MIN_ZOOM[p.t] || !view.contains([p.lat, p.lng])) continue;
    if (p.t === 'th' && rig && p.lim && p.lim < rig) continue;
    L.marker([p.lat, p.lng], { icon: poiIcon(p.t) }).on('click', (e) => { L.DomEvent.stop(e); showPlace(p); }).addTo(poiLayer);
    if (++n >= MAX_MARKERS) break;
  }
}
map.on('moveend', updatePois);
map.on('zoomend', applyPlaces);

// ---------- place sheet (gas / campground / waypoint) ----------
function showPlace(p, wp) {
  if (!wp && p.t === 'th') return showTrailhead(p);
  const kind = wp ? WP_TYPES[wp.type] || 'Waypoint' : p.t === 'gas' ? 'Gas station' : p.sub || 'Campground';
  const rows = wp ? [['Note', wp.note]] : [
    ['City', p.city], ['Hours', p.h], ['Phone', p.ph], ['Fee', p.fee === 'yes' ? 'Yes' : p.fee === 'no' ? 'Free' : p.fee],
  ];
  let html = `<h3>${esc((wp || p).n || (wp || p).name)}</h3><span class="tag kind">${esc(kind)}</span>`;
  const r = rows.filter(([, v]) => v);
  if (r.length) html += '<dl>' + r.map(([k, v]) => k === 'Phone' ? `<dt>${k}</dt><dd><a href="tel:${esc(v)}">${esc(v)}</a></dd>` : `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
  if (p.web && /^https?:\/\//i.test(p.web)) html += `<p class="hint"><a href="${esc(p.web)}" target="_blank" rel="noopener">Website</a></p>`;
  if ((wp && wp.type === 'camp') || p.t === 'camp') {
    const c = campingAt(p.lat, p.lng);
    if (wp) html += `<div class="note ${c.ok ? '' : 'restrict'}">${esc(c.text)}</div>`;
  }
  html += `<div class="rec-row"><button class="primary" data-a="route">Route here</button><button class="ghost" data-a="trip">Add to trip</button></div>`;
  html += DIR_BTNS;
  html += wp
    ? `<div class="rec-row"><button class="ghost" data-a="edit">Edit</button><button class="ghost danger" data-a="del">Delete</button></div>`
    : `<button class="ghost" data-a="save">Save as waypoint</button>`;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    const ll = L.latLng(p.lat, p.lng), name = (wp || p).n || (wp || p).name;
    if (a === 'route') routeHere(ll, name);
    if (a === 'trip') addToTrip(ll, name);
    if (a === 'save') editWaypoint({ lat: p.lat, lng: p.lng, name, type: p.t === 'gas' ? 'gas' : 'camp' });
    if (a === 'drive') driveTo(p.lat, p.lng);
    if (a === 'send') sendDirections(p.lat, p.lng, name);
    if (a === 'edit') editWaypoint(wp);
    if (a === 'del' && confirm(`Delete waypoint "${wp.name}"?`)) { await tx('readwrite', (s) => s.delete(wp.id), 'waypoints'); closeSheets(); loadWaypoints(); }
  };
  openSheet('#sheet');
}
window.showPlace = showPlace;

// ---------- driving directions in Google Maps ----------
const gmapsUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${(+lat).toFixed(6)},${(+lng).toFixed(6)}&travelmode=driving`;
function driveTo(lat, lng) { window.open(gmapsUrl(lat, lng), '_blank', 'noopener'); }
async function sendDirections(lat, lng, name) {
  const url = gmapsUrl(lat, lng);
  if (navigator.share) {
    try { await navigator.share({ title: name, text: `Directions to ${name}`, url }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Directions link copied. Paste it in a text to yourself.'); }
  catch { prompt('Copy this directions link:', url); }
}
window.driveTo = driveTo;
window.sendDirections = sendDirections;
const DIR_BTNS = `<div class="rec-row"><button class="ghost" data-a="drive">Drive here (Google Maps)</button><button class="ghost" data-a="send">Send directions</button></div>`;

// ---------- trailheads / ORV parking ----------
const limLabel = (lim) => (lim === 24 ? 'motorcycles only' : lim ? `up to ${lim}"` : '');
function showTrailhead(p) {
  let html = `<h3>${esc(p.n)}</h3><span class="tag kind">${esc(p.sub === 'Trailhead' ? 'ORV trailhead' : 'ORV parking')}</span>`;
  const rows = [['Where', p.note], ['Surface', p.sf]].filter(([, v]) => v);
  if (rows.length) html += '<dl>' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
  if (p.near && p.near.length) {
    html += '<h2>Connects to</h2><ul class="along">' + p.near.map(([n, lim, d]) => {
      const no = rig && lim < rig;
      return `<li class="${no ? 'muted' : ''}"><b>${esc(n)}</b><small>${esc(limLabel(lim))} · ${d < 160 ? 'right here' : fmtMi(d) + ' away'}${no ? ' · too narrow for your machine' : ''}</small></li>`;
    }).join('') + '</ul>';
  } else html += '<p class="hint warn">No DNR route or trail within about half a mile.</p>';
  html += '<p class="hint">DNR data doesn\'t list lot size. Check that it fits your trailer before you commit.</p>';
  html += `<div class="rec-row"><button class="primary" data-a="drive">Drive here (Google Maps)</button><button class="ghost" data-a="send">Send directions</button></div>
    <button class="primary alt" data-a="start">Start a trip from here</button>
    <div class="rec-row"><button class="ghost" data-a="route">Route here</button><button class="ghost" data-a="trip">Add to trip</button></div>
    <button class="ghost" data-a="save">Save as waypoint</button>`;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    const ll = L.latLng(p.lat, p.lng);
    if (a === 'start') startHere(ll, p.n);
    if (a === 'route') routeHere(ll, p.n);
    if (a === 'trip') addToTrip(ll, p.n);
    if (a === 'save') editWaypoint({ lat: p.lat, lng: p.lng, name: p.n, type: 'trailhead' });
    if (a === 'drive') driveTo(p.lat, p.lng);
    if (a === 'send') sendDirections(p.lat, p.lng, p.n);
  };
  openSheet('#sheet');
}

// nearest ORV parking to a point that serves your machine (for trip checks)
window.nearestTrailhead = (lat, lng) => {
  let best = null;
  for (const p of window.POIS || []) {
    if (p.t !== 'th' || (rig && p.lim && p.lim < rig)) continue;
    const d = hav(lat, lng, p.lat, p.lng);
    if (!best || d < best.d) best = { p, d };
  }
  return best;
};

// ---------- waypoints ----------
let editing = null;
function editWaypoint(wp) {
  editing = { id: wp.id || 'w' + Date.now(), lat: wp.lat, lng: wp.lng, name: wp.name || '', type: wp.type || 'pin', note: wp.note || '' };
  $('#wp-name').value = editing.name;
  $('#wp-note').value = editing.note;
  document.querySelectorAll('#wp-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === editing.type));
  const c = campingAt(editing.lat, editing.lng);
  $('#wp-camp').textContent = c.text;
  $('#wp-camp').className = 'hint ' + (c.ok ? 'ok' : 'warn');
  openSheet('#panel-wp');
  setTimeout(() => $('#wp-name').focus(), 50);
}
window.editWaypoint = editWaypoint;
document.querySelectorAll('#wp-type button').forEach((b) => b.addEventListener('click', () => {
  editing.type = b.dataset.type;
  document.querySelectorAll('#wp-type button').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#btn-wp-save').addEventListener('click', async () => {
  editing.name = $('#wp-name').value.trim().slice(0, 80) || WP_TYPES[editing.type];
  editing.note = $('#wp-note').value.trim().slice(0, 500);
  await tx('readwrite', (s) => s.put(editing), 'waypoints');
  closeSheets();
  await loadWaypoints();
  toast('Waypoint saved');
});

async function loadWaypoints() {
  waypoints = (await tx('readonly', (s) => s.getAll(), 'waypoints').catch(() => [])) || [];
  wpLayer.clearLayers();
  for (const w of waypoints) {
    L.marker([w.lat, w.lng], { icon: wpIcon(w.type), zIndexOffset: 800 })
      .on('click', (e) => { L.DomEvent.stop(e); showPlace({ lat: w.lat, lng: w.lng, n: w.name }, w); })
      .addTo(wpLayer);
  }
  $('#wp-count').textContent = waypoints.length ? `(${waypoints.length})` : '';
}
loadWaypoints();

// waypoint list (from the Layers panel)
$('#btn-wp-list').addEventListener('click', () => {
  const list = $('#wp-list');
  list.innerHTML = waypoints.length
    ? waypoints.slice().sort((a, b) => a.name.localeCompare(b.name)).map((w) => `<div class="ride" data-id="${esc(w.id)}">
        <div class="ride-top"><b>${esc(w.name)}</b><small>${esc(WP_TYPES[w.type] || '')}${w.note ? ' · ' + esc(w.note) : ''}</small></div>
        <div class="ride-btns"><button data-a="show">Show</button><button data-a="route">Route</button><button data-a="trip">Add to trip</button></div></div>`).join('')
    : '<p class="hint">No waypoints yet. Long-press the map and choose "Save as waypoint".</p>';
  openSheet('#panel-wps');
});
$('#wp-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const w = waypoints.find((x) => x.id === btn.closest('.ride').dataset.id);
  const ll = L.latLng(w.lat, w.lng);
  if (btn.dataset.a === 'show') { closeSheets(); map.setView(ll, Math.max(map.getZoom(), 14)); }
  if (btn.dataset.a === 'route') routeHere(ll, w.name);
  if (btn.dataset.a === 'trip') addToTrip(ll, w.name);
});
$('#btn-wp-gpx').addEventListener('click', () => {
  const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const body = waypoints.map((w) => `<wpt lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}"><name>${x(w.name)}</name>${w.note ? `<desc>${x(w.note)}</desc>` : ''}<type>${x(WP_TYPES[w.type] || '')}</type></wpt>`).join('\n');
  shareGpx('ORV waypoints', `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Michigan ORV Map" xmlns="http://www.topografix.com/GPX/1/1">\n${body}\n</gpx>`);
});

// layer toggles for the new kinds
document.querySelectorAll('[data-kind="gas"],[data-kind="camp"],[data-kind="land"],[data-kind="wp"],[data-kind="th"]').forEach((cb) => {
  cb.checked = !!shown[cb.dataset.kind];
  cb.addEventListener('change', applyPlaces);
});
applyPlaces();

document.querySelectorAll('#rig-seg button').forEach((b) => b.addEventListener('click', updatePois));

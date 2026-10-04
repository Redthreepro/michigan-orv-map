'use strict';
// "Ride every trail in Michigan": match all saved rides against the DNR routes/trails and track progress.
// Rides keep their raw GPS points, so coverage is simply recomputed whenever rides or trail data change.

const COVER_STEP_M = 50;   // check each trail every 50 m
const COVER_TOL_M = 35;    // a ride within 35 m of that spot counts (GPS + DNR line accuracy)
const GOAL_KINDS = ['route', 'trail', 'mc']; // MCCCT segments duplicate these, so they aren't counted twice
const CELL_LAT = 0.0004, CELL_LNG = 0.00055; // ~45 m grid for the ride-point lookup

map.createPane('ridden', ROT).style.zIndex = 420;
map.getPane('ridden').style.pointerEvents = 'none';
const riddenRenderer = L.canvas({ pane: 'ridden' });
const riddenLayer = L.layerGroup();
const allRidesLayer = L.layerGroup();
for (const k of ['ridden', 'allrides']) if (shown[k] === undefined) shown[k] = k === 'ridden' ? 1 : 0;

let goal = null;     // [{ f, samples: [[lat,lng],...], stepM, lenM }]
let progress = null; // latest result

// ---------- sampling the trails ----------
function sampleLine(coords) {
  // coords: [[lng,lat],...] -> points every COVER_STEP_M along the line, with the real length
  const out = [[coords[0][1], coords[0][0]]];
  let carry = 0, len = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const d = hav(y1, x1, y2, x2);
    len += d;
    let pos = COVER_STEP_M - carry;
    while (pos <= d) {
      const t = pos / d;
      out.push([y1 + (y2 - y1) * t, x1 + (x2 - x1) * t]);
      pos += COVER_STEP_M;
    }
    carry = d - (pos - COVER_STEP_M);
  }
  const last = coords[coords.length - 1];
  if (carry > COVER_STEP_M / 3) out.push([last[1], last[0]]);
  return { samples: out, lenM: len };
}
function prepGoal() {
  if (goal) return goal;
  goal = [];
  for (const kind of GOAL_KINDS) {
    for (const f of allByKind[kind] || []) {
      const g = f.geometry;
      for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
        if (line.length < 2) continue;
        const { samples, lenM } = sampleLine(line);
        let a = 90, b = 180, c = -90, d = -180;
        for (const [lat, lng] of samples) { a = Math.min(a, lat); b = Math.min(b, lng); c = Math.max(c, lat); d = Math.max(d, lng); }
        goal.push({ f, samples, lenM, bbox: [a, b, c, d] });
      }
    }
  }
  return goal;
}

// ---------- matching ----------
const FILL_STEP_M = 15;   // fill in the ride line between GPS points this often
const FILL_MAX_M = 250;   // ...but don't bridge longer gaps (signal lost; we don't know where you went)
function rideIndex(rides) {
  const grid = new Map();
  let a = 90, b = 180, c = -90, d = -180;
  const add = (lat, lng) => {
    const key = Math.floor(lat / CELL_LAT) * 1e6 + Math.floor(lng / CELL_LNG);
    const cell = grid.get(key);
    if (cell) { if (cell.length < 12) cell.push([lat, lng]); } else grid.set(key, [[lat, lng]]);
    a = Math.min(a, lat); b = Math.min(b, lng); c = Math.max(c, lat); d = Math.max(d, lng);
  };
  for (const r of rides) for (const seg of r.segs) {
    for (let i = 0; i < seg.length; i++) {
      const p = seg[i];
      add(p[0], p[1]);
      if (i === 0) continue;
      const q = seg[i - 1];
      const dist = hav(q[0], q[1], p[0], p[1]);
      if (dist <= FILL_STEP_M || dist > FILL_MAX_M) continue;
      const n = Math.ceil(dist / FILL_STEP_M);
      for (let k = 1; k < n; k++) add(q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n);
    }
  }
  return { grid, bbox: [a, b, c, d] };
}
function nearRide(idx, lat, lng) {
  const cy = Math.floor(lat / CELL_LAT), cx = Math.floor(lng / CELL_LNG);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cell = idx.grid.get((cy + dy) * 1e6 + cx + dx);
    if (cell) for (const p of cell) if (hav(lat, lng, p[0], p[1]) <= COVER_TOL_M) return true;
  }
  return false;
}

// Which parts of `items` the rides in `idx` covered. Only runs of 2+ samples in a row count
// (just crossing a trail isn't riding it).
function coverItems(items, idx) {
  const pad = 0.001;
  const covered = [];
  for (const it of items) {
    const [a, b, c, d] = it.bbox;
    if (c < idx.bbox[0] - pad || a > idx.bbox[2] + pad || d < idx.bbox[1] - pad || b > idx.bbox[3] + pad) continue;
    const runs = [];
    let start = -1;
    for (let i = 0; i <= it.samples.length; i++) {
      const hit = i < it.samples.length && nearRide(idx, it.samples[i][0], it.samples[i][1]);
      if (hit && start < 0) start = i;
      if (!hit && start >= 0) { if (i - start >= 2) runs.push([start, i - 1]); start = -1; }
    }
    if (!runs.length) continue;
    const n = runs.reduce((sum, [x, y]) => sum + (y - x + 1), 0);
    covered.push({ item: it, runs, riddenM: Math.min(it.lenM, (n / it.samples.length) * it.lenM) });
  }
  return covered;
}

// ---------- forest roads (bonus goal) ----------
// 46k road lines are too many to pre-sample on a phone; only roads near your rides get sampled.
const ROAD_GOAL_KINDS = ['road', 'nf'];
function roadMeta(f) {
  if (f._meta) return f._meta;
  const c = f.geometry.coordinates;
  let a = 90, b = 180, cc = -90, d = -180, len = 0;
  for (let i = 0; i < c.length; i++) {
    const [x, y] = c[i];
    a = Math.min(a, y); b = Math.min(b, x); cc = Math.max(cc, y); d = Math.max(d, x);
    if (i) len += hav(c[i - 1][1], c[i - 1][0], y, x);
  }
  f._meta = { bbox: [a, b, cc, d], lenM: len };
  return f._meta;
}
function roadItems(idx) {
  const pad = 0.001, out = [];
  for (const f of window.roadFeatures || []) {
    if (!ROAD_GOAL_KINDS.includes(f.properties.t)) continue;
    const m = roadMeta(f);
    const [a, b, c, d] = m.bbox;
    if (c < idx.bbox[0] - pad || a > idx.bbox[2] + pad || d < idx.bbox[1] - pad || b > idx.bbox[3] + pad) continue;
    if (!f._item) { const { samples, lenM } = sampleLine(f.geometry.coordinates); f._item = { f, samples, lenM, bbox: m.bbox }; }
    out.push(f._item);
  }
  return out;
}

async function computeProgress() {
  if (!allByKind.route) return null;
  const rides = (await allTracks().catch(() => [])).filter((t) => t.done && t.segs && t.segs.length);
  const idx = rideIndex(rides);
  const covered = rides.length ? coverItems(prepGoal(), idx) : [];
  const roadCovered = rides.length ? coverItems(roadItems(idx), idx) : [];
  progress = { rides, covered, roadCovered, at: Date.now() };
  return progress;
}

// What one ride covered (for its details sheet): trail and road miles by name.
window.rideCoverage = (ride) => {
  const idx = rideIndex([ride]);
  const byName = new Map();
  for (const c of [...coverItems(prepGoal(), idx), ...coverItems(roadItems(idx), idx)]) {
    const p = c.item.f.properties;
    if (!fits(p)) continue; // a parallel trail your machine can't use isn't one you rode
    const label = p.n || (KIND[p.t] ? KIND[p.t].label : 'trail');
    const key = p.t + '|' + label;
    const row = byName.get(key) || { name: label, kind: p.t, m: 0 };
    row.m += c.riddenM;
    byName.set(key, row);
  }
  return [...byName.values()].filter((r) => r.m > 80).sort((a, b) => b.m - a.m);
};

// totals for what your machine may ride, grouped by trail name
function goalSummary() {
  const systems = new Map();
  let totalM = 0, riddenM = 0;
  const coveredBy = new Map((progress ? progress.covered : []).map((c) => [c.item, c]));
  for (const it of prepGoal()) {
    const p = it.f.properties;
    if (!fits(p)) continue;
    const key = p.t + '|' + (p.n || KIND[p.t].label);
    const sys = systems.get(key) || { name: p.n || KIND[p.t].label, kind: p.t, totalM: 0, riddenM: 0, items: [] };
    const c = coveredBy.get(it);
    sys.totalM += it.lenM; sys.riddenM += c ? c.riddenM : 0; sys.items.push(it);
    systems.set(key, sys);
    totalM += it.lenM; riddenM += c ? c.riddenM : 0;
  }
  const list = [...systems.values()];
  return { totalM, riddenM, list, started: list.filter((x) => x.riddenM > 50), done: list.filter((x) => x.riddenM >= x.totalM * 0.9) };
}

// bonus: forest roads your machine may ride, state vs national
let roadTotalsCache = null;
function roadSummary() {
  const key = rig + ':' + (window.roadFeatures || []).length;
  if (!roadTotalsCache || roadTotalsCache.key !== key) {
    const tot = { road: 0, nf: 0 };
    for (const f of window.roadFeatures || []) {
      if (ROAD_GOAL_KINDS.includes(f.properties.t) && fits(f.properties)) tot[f.properties.t] += roadMeta(f).lenM;
    }
    roadTotalsCache = { key, tot };
  }
  const rid = { road: 0, nf: 0 };
  for (const c of (progress && progress.roadCovered) || []) {
    const p = c.item.f.properties;
    if (fits(p)) rid[p.t] += c.riddenM;
  }
  const t = roadTotalsCache.tot;
  return { state: { totalM: t.road, riddenM: rid.road }, national: { totalM: t.nf, riddenM: rid.nf },
    totalM: t.road + t.nf, riddenM: rid.road + rid.nf, loaded: (window.roadFeatures || []).length > 0 };
}

// ---------- map layers ----------
function drawProgress() {
  riddenLayer.clearLayers();
  allRidesLayer.clearLayers();
  if (!progress) return;
  const lines = [];
  for (const c of progress.covered) {
    if (!fits(c.item.f.properties)) continue;
    for (const [x, y] of c.runs) lines.push(c.item.samples.slice(x, y + 1));
  }
  if (lines.length) {
    L.polyline(lines, { renderer: riddenRenderer, color: '#3b2a00', weight: 9, opacity: 0.35, interactive: false }).addTo(riddenLayer);
    L.polyline(lines, { renderer: riddenRenderer, color: '#ffc400', weight: 5, opacity: 0.95, interactive: false }).addTo(riddenLayer);
  }
  const roadLines = [];
  for (const c of progress.roadCovered || []) {
    if (!fits(c.item.f.properties)) continue;
    for (const [x, y] of c.runs) roadLines.push(c.item.samples.slice(x, y + 1));
  }
  if (roadLines.length) L.polyline(roadLines, { renderer: riddenRenderer, color: '#ffc400', weight: 3, opacity: 0.85, dashArray: '1 0', interactive: false }).addTo(riddenLayer);
  const tracks = progress.rides.flatMap((r) => r.segs.map((s) => s.map((p) => [p[0], p[1]])));
  if (tracks.length) L.polyline(tracks, { renderer: riddenRenderer, color: '#ff2fd0', weight: 3, opacity: 0.75, interactive: false }).addTo(allRidesLayer);
  applyProgressLayers();
}
function applyProgressLayers() {
  if (shown.ridden) riddenLayer.addTo(map); else map.removeLayer(riddenLayer);
  if (shown.allrides) allRidesLayer.addTo(map); else map.removeLayer(allRidesLayer);
}
document.querySelectorAll('[data-kind="ridden"],[data-kind="allrides"]').forEach((cb) => {
  cb.checked = !!shown[cb.dataset.kind];
  cb.addEventListener('change', applyProgressLayers);
});

// ---------- goal card + panel ----------
const pct = (a, b) => (b ? Math.min(100, (100 * a) / b) : 0);
const fmtPct = (v) => (v > 0 && v < 1 ? '<1' : Math.round(v)) + '%';
function renderGoalCard() {
  const el = $('#goal-card');
  if (!el) return;
  const s = goalSummary();
  const p = pct(s.riddenM, s.totalM);
  el.innerHTML = `<div class="goal-top"><b>Ride every trail in Michigan</b><span>${fmtPct(p)}</span></div>
    <div class="goal-bar"><span style="width:${p.toFixed(2)}%"></span></div>
    <small>${fmtMi(s.riddenM)} of ${fmtMi(s.totalM)} ridden · ${s.started.length} of ${s.list.length} trails &amp; routes started${rig ? ` · for machines up to ${rig}"` : ''}</small>
    ${(() => { const r = roadSummary(); return r.loaded ? `<small class="goal-bonus">Bonus: ${fmtMi(r.riddenM)} of ${fmtMi(r.totalM)} of forest roads</small>` : ''; })()}`;
}
function showGoal() {
  const s = goalSummary();
  const p = pct(s.riddenM, s.totalM);
  const started = s.started.slice().sort((a, b) => pct(b.riddenM, b.totalM) - pct(a.riddenM, a.totalM) || a.name.localeCompare(b.name));
  const notYet = s.list.filter((x) => x.riddenM <= 50).sort((a, b) => a.name.localeCompare(b.name));
  window.__goalRows = { started, notYet };
  let html = `<h3>Ride every trail in Michigan</h3>
    <div class="goal-big">${fmtPct(p)}</div>
    <div class="goal-bar big"><span style="width:${p.toFixed(2)}%"></span></div>
    <p class="hint">${fmtMi(s.riddenM)} of ${fmtMi(s.totalM)} of DNR ORV routes and trails${rig ? ` your ${rig === 50 ? '50"' : rig + '"'} machine can ride` : ''}.
      ${s.done.length} done, ${s.started.length} started, ${notYet.length} to go. Built from ${progress ? progress.rides.length : 0} saved ride${progress && progress.rides.length === 1 ? '' : 's'}.</p>`;
  if (started.length) {
    html += '<h2>Started</h2><ul class="goal-list">' + started.map((x, i) => {
      const v = pct(x.riddenM, x.totalM);
      return `<li data-g="s${i}"><div><b>${esc(x.name)}</b><small>${esc(KIND[x.kind].label)} · ${fmtMi(x.riddenM)} of ${fmtMi(x.totalM)}</small></div>
        <span class="goal-pct ${v >= 90 ? 'done' : ''}">${fmtPct(v)}</span><div class="goal-bar"><span style="width:${v.toFixed(1)}%"></span></div></li>`;
    }).join('') + '</ul>';
  } else html += '<p class="hint">Record a ride (the red button) and the trails you ride light up here and on the map in gold.</p>';
  html += `<details class="grp"><summary>Not ridden yet <small>${notYet.length}</small></summary><ul class="goal-list">` +
    notYet.map((x, i) => `<li data-g="n${i}"><div><b>${esc(x.name)}</b><small>${esc(KIND[x.kind].label)} · ${fmtMi(x.totalM)}</small></div></li>`).join('') + '</ul></details>';
  const rs = roadSummary();
  if (rs.loaded) {
    const row = (label, x) => { const v = pct(x.riddenM, x.totalM); return `<li><div><b>${label}</b><small>${fmtMi(x.riddenM)} of ${fmtMi(x.totalM)}</small></div>
      <span class="goal-pct">${fmtPct(v)}</span><div class="goal-bar"><span style="width:${v.toFixed(2)}%"></span></div></li>`; };
    html += `<h2>Bonus: forest roads</h2><p class="hint">Not part of the trail goal above. Roads open to ORVs, counted separately.</p>
      <ul class="goal-list bonus">${row('State forest roads', rs.state)}${row('National forest roads &amp; trails', rs.national)}</ul>`;
  }
  html += `<div class="rec-row"><button class="ghost" id="btn-all-gpx">Share all rides as one GPX</button></div>`;
  $('#goal-body').innerHTML = html;
  openSheet('#panel-goal');
}
$('#goal-body').addEventListener('click', (e) => {
  if (e.target.closest('#btn-all-gpx')) return shareAllRides();
  const li = e.target.closest('li[data-g]');
  if (!li) return;
  const id = li.dataset.g;
  const sys = (id[0] === 's' ? window.__goalRows.started : window.__goalRows.notYet)[+id.slice(1)];
  const pts = sys.items.flatMap((it) => it.samples);
  closeSheets();
  if (!shown.ridden) { shown.ridden = 1; applyProgressLayers(); }
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
});

function shareAllRides() {
  const rides = progress ? progress.rides : [];
  if (!rides.length) return toast('No saved rides yet');
  const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const trks = rides.map((t) => `<trk><name>${x(t.name)}</name>` + t.segs.map((seg) => '<trkseg>' + seg.map((p) =>
    `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}${p[3] ? `<time>${new Date(p[3]).toISOString()}</time>` : ''}</trkpt>`).join('') + '</trkseg>').join('') + '</trk>').join('\n');
  shareGpx('All ORV rides', `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Michigan ORV Map" xmlns="http://www.topografix.com/GPX/1/1">\n${trks}\n</gpx>`);
}

// ---------- refresh ----------
let refreshT = null;
window.refreshProgress = () => {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    await computeProgress();
    drawProgress();
    renderGoalCard();
    if (!$('#panel-goal').hidden) showGoal();
  }, 300);
};
$('#goal-card').addEventListener('click', showGoal);
document.querySelectorAll('#rig-seg button').forEach((b) => b.addEventListener('click', () => { drawProgress(); renderGoalCard(); }));
// first run once the trail data is in
const waitTrails = setInterval(() => { if (allByKind.route) { clearInterval(waitTrails); refreshProgress(); } }, 500);

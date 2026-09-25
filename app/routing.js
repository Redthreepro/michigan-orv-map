'use strict';
// Offline tap-to-route: A* over the DNR route/trail/forest-road network built by graph.py.

// m/s (~15/12/10/14/5 mph). Routes often run on top of forest roads; the slightly slower road
// speed makes the named route win so directions read "North Missaukee Route" instead of flip-flopping.
const SPEED = { route: 6.7, trail: 5.4, mc: 4.5, mccct: 4.5, road: 6.26, connector: 2.2 };
const MAX_SPEED = 6.7;
const MIN_STEP_M = 650; // fold blips shorter than this into the surrounding step
const CELL = 0.02;                 // edge grid for snapping, ~1.5 km
const MAX_SNAP_M = 25000;          // don't snap to trails more than ~15 mi away
const FLAG = { closed: 1, seasonal: 2, military: 4, connector: 8 };

let G = null;          // loaded graph
let loading = null;
let route = null;      // { from, to, result }
let routeLayer = null;
let fromMarker = null;
let manualStart = null;

// ---------- geometry ----------
function hav(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function edgeCoords(e) {
  const c = G.geom[e], out = [];
  let x = c[0], y = c[1];
  out.push([y / 1e5, x / 1e5]);
  for (let i = 2; i < c.length; i += 2) { x += c[i]; y += c[i + 1]; out.push([y / 1e5, x / 1e5]); }
  return out; // [lat, lng]
}

// ---------- load ----------
function loadGraph() {
  if (G) return Promise.resolve(G);
  if (loading) return loading;
  toast('Loading trail network…');
  loading = fetch('data/graph.json').then((r) => r.json()).then((raw) => {
    const n = raw.edges.length;
    const eu = new Int32Array(n), ev = new Int32Array(n), elen = new Float32Array(n), eattr = new Int32Array(n);
    const nodeId = new Map(), nx = [], ny = [], adj = [];
    const node = (x, y) => {
      const k = (x + 20000000) * 1e8 + y;
      let id = nodeId.get(k);
      if (id === undefined) { id = nx.length; nodeId.set(k, id); nx.push(x / 1e5); ny.push(y / 1e5); adj.push([]); }
      return id;
    };
    const grid = new Map();
    const geom = new Array(n);
    raw.edges.forEach(([a, len, c], i) => {
      let x = c[0], y = c[1], minx = x, maxx = x, miny = y, maxy = y;
      for (let k = 2; k < c.length; k += 2) {
        x += c[k]; y += c[k + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      const u = node(c[0], c[1]), v = node(x, y);
      eu[i] = u; ev[i] = v; elen[i] = len; eattr[i] = a; geom[i] = c;
      adj[u].push(i); if (v !== u) adj[v].push(i);
      for (let gx = Math.floor(minx / 1e5 / CELL); gx <= Math.floor(maxx / 1e5 / CELL); gx++) {
        for (let gy = Math.floor(miny / 1e5 / CELL); gy <= Math.floor(maxy / 1e5 / CELL); gy++) {
          const k = gx * 100000 + gy;
          (grid.get(k) || grid.set(k, []).get(k)).push(i);
        }
      }
    });
    G = { attrs: raw.attrs, eu, ev, elen, eattr, geom, nx, ny, adj, grid };
    return G;
  }).catch((err) => { loading = null; throw err; });
  return loading;
}

// ---------- rules ----------
function allowed(e) {
  const [, lim, , flags] = G.attrs[G.eattr[e]];
  if (flags & FLAG.closed) return false;
  if (rig && lim < rig) return false;
  return true;
}
function cost(e, meters) {
  return meters / (SPEED[G.attrs[G.eattr[e]][0]] || 5);
}

// ---------- snapping ----------
// Candidate attach points near (lat, lng): best point per allowed edge, nearest first.
// Each: { e, lat, lng, along (m from u, in stored-length units), d (m off-network) }
function candidates(lat, lng, extraM) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
  const cellM = CELL * kx;
  const found = new Map();
  let nearest = Infinity;
  for (let ring = 0; ring <= 150; ring++) {
    for (let gx = cx - ring; gx <= cx + ring; gx++) for (let gy = cy - ring; gy <= cy + ring; gy++) {
      if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue; // only the new outer ring
      for (const e of G.grid.get(gx * 100000 + gy) || []) {
        if (found.has(e) || !allowed(e)) continue;
        const pts = edgeCoords(e);
        let along = 0, total = 0, best = null;
        for (let k = 0; k < pts.length - 1; k++) {
          const [ay, ax] = pts[k], [by, bx] = pts[k + 1];
          const dx = (bx - ax) * kx, dy = (by - ay) * ky;
          const px = (lng - ax) * kx, py = (lat - ay) * ky;
          const L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
          const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t;
          const d = hav(lat, lng, qy, qx);
          const segLen = hav(ay, ax, by, bx);
          if (!best || d < best.d) best = { e, lat: qy, lng: qx, along: along + segLen * t, d };
          along += segLen;
        }
        total = along;
        if (total > 0) best.along *= G.elen[e] / total;
        found.set(e, best);
        if (best.d < nearest) nearest = best.d;
      }
    }
    // everything inside (nearest + extra) has been seen once the ring passes that radius
    if ((ring - 1) * cellM > Math.min(nearest + extraM, MAX_SNAP_M)) break;
  }
  return [...found.values()].filter((c) => c.d <= Math.min(nearest + extraM, MAX_SNAP_M)).sort((a, b) => a.d - b.d);
}

// Connected pieces of the network for the current machine width (cached per width).
const compCache = new Map();
function components() {
  if (compCache.has(rig)) return compCache.get(rig);
  const N = G.nx.length, comp = new Int32Array(N).fill(-1);
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = s;
    const q = [s];
    while (q.length) {
      const n = q.pop();
      for (const e of G.adj[n]) {
        if (!allowed(e)) continue;
        const m = G.eu[e] === n ? G.ev[e] : G.eu[e];
        if (comp[m] < 0) { comp[m] = s; q.push(m); }
      }
    }
  }
  compCache.set(rig, comp);
  return comp;
}

// Pick start/end attach points that are on the same connected network when one exists within
// a few extra miles; otherwise fall back to the nearest points (and report the gap).
const EXTRA_SNAP_M = 5000;
function snapPair(from, to) {
  const A = candidates(from.lat, from.lng, EXTRA_SNAP_M);
  const B = candidates(to.lat, to.lng, EXTRA_SNAP_M);
  if (!A.length || !B.length) return { S: A[0] || null, T: B[0] || null };
  const comp = components();
  const bestB = new Map();
  for (const c of B) { const k = comp[G.eu[c.e]]; if (!bestB.has(k)) bestB.set(k, c); }
  let pick = null;
  for (const a of A) {
    const b = bestB.get(comp[G.eu[a.e]]);
    if (b && (!pick || a.d + b.d < pick.S.d + pick.T.d)) pick = { S: a, T: b };
  }
  if (pick) return pick;
  // No shared network: offer a few distinct nearby networks as starts; runRoute keeps whichever
  // gets closest to the destination.
  const alts = [], seen = new Set();
  for (const a of A) { const k = comp[G.eu[a.e]]; if (!seen.has(k)) { seen.add(k); alts.push(a); } if (alts.length >= 6) break; }
  return { S: A[0], T: B[0], alts };
}

// ---------- A* ----------
function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  }
  return top;
}

function solve(S, T) {
  const N = G.nx.length, START = N, END = N + 1;
  const g = new Map(), prev = new Map();
  const h = (n) => hav(G.ny[n], G.nx[n], T.lat, T.lng) / MAX_SPEED;
  const heap = [];
  const sLen = G.elen[S.e];
  // leave the start point toward either end of its edge
  const starts = [[G.eu[S.e], S.along], [G.ev[S.e], sLen - S.along]];
  for (const [n, m] of starts) {
    const c = cost(S.e, m);
    if (!g.has(n) || c < g.get(n)) { g.set(n, c); prev.set(n, { from: START, e: S.e, part: 'start' }); heapPush(heap, [c + h(n), n]); }
  }
  // same edge: ride straight along it
  let bestEnd = S.e === T.e ? cost(S.e, Math.abs(S.along - T.along)) : Infinity;
  let endVia = S.e === T.e ? { from: START, e: S.e, part: 'direct' } : null;
  let closest = null, closestD = Infinity;
  const tU = G.eu[T.e], tV = G.ev[T.e], tLen = G.elen[T.e];

  while (heap.length) {
    const [f, n] = heapPop(heap);
    if (f >= bestEnd) break;
    const gn = g.get(n);
    if (f - h(n) > gn + 1e-6) continue; // stale
    const dT = hav(G.ny[n], G.nx[n], T.lat, T.lng);
    if (dT < closestD) { closestD = dT; closest = n; }
    if (n === tU || n === tV) {
      const c = gn + cost(T.e, n === tU ? T.along : tLen - T.along);
      if (c < bestEnd) { bestEnd = c; endVia = { from: n, e: T.e, part: 'end' }; }
    }
    for (const e of G.adj[n]) {
      if (!allowed(e)) continue;
      const m = G.eu[e] === n ? G.ev[e] : G.eu[e];
      const c = gn + cost(e, G.elen[e]);
      if (!g.has(m) || c < g.get(m)) { g.set(m, c); prev.set(m, { from: n, e }); heapPush(heap, [c + h(m), m]); }
    }
  }
  return { endVia, prev, closest, closestD, bestEnd };
}

// ---------- path assembly ----------
// Polyline along edge e from distance a to distance b (meters from its u end; b < a runs backwards).
function sliceEdge(e, a, b) {
  const pts = edgeCoords(e);
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + hav(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  const k = cum[cum.length - 1] ? G.elen[e] / cum[cum.length - 1] : 1;
  const at = (d) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const s0 = cum[i] * k, s1 = cum[i + 1] * k;
      if (d <= s1 || i === pts.length - 2) {
        const t = s1 > s0 ? Math.max(0, Math.min(1, (d - s0) / (s1 - s0))) : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      }
    }
    return pts[0];
  };
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const inner = pts.filter((_, i) => cum[i] * k > lo && cum[i] * k < hi);
  const out = [at(lo), ...inner, at(hi)];
  return a <= b ? out : out.reverse();
}

function assemble(S, T, sol, reachedNode) {
  const N = G.nx.length;
  const legs = [];
  let n, tail = null;
  if (reachedNode === undefined) {
    const v = sol.endVia;
    if (v.part === 'direct') return [{ e: S.e, coords: sliceEdge(S.e, S.along, T.along), meters: Math.abs(T.along - S.along) }];
    n = v.from;
    const fromU = n === G.eu[T.e];
    const endAt = fromU ? 0 : G.elen[T.e];
    tail = { e: T.e, coords: sliceEdge(T.e, endAt, T.along), meters: Math.abs(T.along - endAt) };
  } else {
    n = reachedNode;
  }
  for (;;) {
    const p = sol.prev.get(n);
    if (!p) break;
    if (p.from === N) {
      const to = n === G.eu[S.e] ? 0 : G.elen[S.e];
      legs.unshift({ e: S.e, coords: sliceEdge(S.e, S.along, to), meters: Math.abs(to - S.along) });
      break;
    }
    let coords = edgeCoords(p.e);
    if (G.eu[p.e] !== p.from) coords = coords.reverse();
    legs.unshift({ e: p.e, coords, meters: G.elen[p.e] });
    n = p.from;
  }
  if (tail) legs.push(tail);
  return legs;
}

// ---------- public ----------
async function routeTo(to) {
  let from = manualStart;
  if (!from) {
    if (!meMarker) {
      ensureGpsFix();
      toast('Getting your GPS location… or long-press the map and pick "Route from here".');
      from = await waitForFix(20000);
      if (!from) return toast('No GPS fix. Long-press a start point and choose "Route from here".');
    } else from = meMarker.getLatLng();
  }
  try { await loadGraph(); } catch { return toast('Could not load the trail network'); }
  route = { from: L.latLng(from), to: L.latLng(to) };
  runRoute();
}

function runRoute() {
  if (!route) return;
  let { S, T, alts } = snapPair(route.from, route.to);
  if (!S) return toast('No trail you can ride within 15 miles of the start.');
  if (!T) return toast('No trail you can ride within 15 miles of that spot.');
  let sol = solve(S, T);
  if (!sol.endVia && alts) {
    // score = off-network to reach the start + straight-line gap left at the end
    let best = { S, sol, score: S.d + (sol.closestD ?? Infinity) };
    for (const a of alts) {
      const s2 = solve(a, T);
      const score = a.d + (s2.endVia ? 0 : s2.closestD);
      if (score < best.score) best = { S: a, sol: s2, score };
    }
    S = best.S; sol = best.sol;
  }
  let legs, gap = null;
  if (sol.endVia) legs = assemble(S, T, sol);
  else {
    legs = sol.closest != null ? assemble(S, T, sol, sol.closest) : [];
    const last = legs.length ? legs[legs.length - 1].coords.slice(-1)[0] : [S.lat, S.lng];
    gap = { from: last, to: [T.lat, T.lng], meters: hav(last[0], last[1], T.lat, T.lng) };
  }
  route.result = summarize(legs, S, T, gap);
  drawRoute();
  showRouteSheet();
}

function summarize(legs, S, T, gap) {
  let meters = 0, secs = 0;
  const byKind = {}, steps = [];
  let seasonal = 0, military = 0;
  for (const leg of legs) {
    const [kind, , name, flags] = G.attrs[G.eattr[leg.e]];
    meters += leg.meters; secs += leg.meters / (SPEED[kind] || 5);
    byKind[kind] = (byKind[kind] || 0) + leg.meters;
    if (flags & FLAG.seasonal) seasonal += leg.meters;
    if (flags & FLAG.military) military += leg.meters;
    const label = kind === 'connector' ? null : (name || KIND[kind].label);
    const last = steps[steps.length - 1];
    if (!label || (last && last.label === label)) { if (last) last.meters += leg.meters; }
    else steps.push({ label, kind, meters: leg.meters, at: leg.coords[0] });
  }
  // fold short blips (a few hundred feet of road between two stretches of the same route) into neighbors
  const folded = [];
  for (const st of steps) {
    const last = folded[folded.length - 1];
    if (last && (st.meters < MIN_STEP_M || last.label === st.label)) last.meters += st.meters;
    else if (last && last.meters < MIN_STEP_M && folded.length > 1) { folded.pop(); folded[folded.length - 1].meters += last.meters; folded.push(st); }
    else folded.push({ ...st });
  }
  if (folded.length > 1 && folded[0].meters < MIN_STEP_M) { folded[1].meters += folded[0].meters; folded[1].at = folded[0].at; folded.shift(); }
  for (let i = folded.length - 1; i > 0; i--) {
    if (folded[i].label === folded[i - 1].label) { folded[i - 1].meters += folded[i].meters; folded.splice(i, 1); }
  }
  return {
    legs, meters, secs, byKind, steps: folded, seasonal, military, gap,
    offStart: S.d, offEnd: T.d, startPt: [S.lat, S.lng], endPt: [T.lat, T.lng],
  };
}

function drawRoute() {
  clearRouteLayer();
  const r = route.result;
  const lines = r.legs.map((l) => l.coords);
  routeLayer = L.layerGroup().addTo(map);
  L.polyline(lines, { renderer, color: '#fff', weight: 11, opacity: 0.9, interactive: false }).addTo(routeLayer);
  L.polyline(lines, { renderer, color: '#1e6bff', weight: 6, opacity: 1, interactive: false }).addTo(routeLayer);
  const dash = { renderer, color: '#1e6bff', weight: 3, dashArray: '2 8', interactive: false };
  if (r.offStart > 30) L.polyline([route.from, r.startPt], dash).addTo(routeLayer);
  if (r.offEnd > 30) L.polyline([r.endPt, route.to], dash).addTo(routeLayer);
  if (r.gap) L.polyline([r.gap.from, r.gap.to], { ...dash, color: '#ff2d2d', weight: 4, dashArray: '6 8' }).addTo(routeLayer);
  L.circleMarker(route.from, { renderer, radius: 8, color: '#fff', weight: 3, fillColor: '#2fbf4a', fillOpacity: 1, interactive: false }).addTo(routeLayer);
  L.circleMarker(route.to, { renderer, radius: 8, color: '#fff', weight: 3, fillColor: '#ff2d2d', fillOpacity: 1, interactive: false }).addTo(routeLayer);
  const all = [route.from, route.to, ...lines.flat()];
  map.fitBounds(L.latLngBounds(all), { padding: [60, 60], maxZoom: 15 });
}
function clearRouteLayer() { if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; } }

const fmtMi = (m) => (m / 1609.344).toFixed(m < 16093 ? 1 : 0) + ' mi';
const fmtTime = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function showRouteSheet() {
  const r = route.result;
  const bar = $('#route-bar');
  bar.hidden = false;
  bar.querySelector('span').textContent = r.gap ? `${fmtMi(r.meters)} · doesn't connect` : `${fmtMi(r.meters)} · ~${fmtTime(r.secs)}`;
  const kinds = Object.entries(r.byKind).filter(([k]) => k !== 'connector').sort((a, b) => b[1] - a[1])
    .map(([k, m]) => `${fmtMi(m)} ${KIND[k].label.toLowerCase()}`).join(', ');
  let html = `<h3>${r.gap ? 'Partial route' : 'Route'}: ${fmtMi(r.meters)}</h3>
    <p class="hint">About ${fmtTime(r.secs)} of riding${kinds ? ' · ' + esc(kinds) : ''}${rig ? ` · for machines up to ${rig}"` : ''}</p>`;
  if (r.gap) html += `<div class="note">The trail network doesn't connect all the way. The last <b>${fmtMi(r.gap.meters)}</b> (red dashes, straight line) has no DNR route, trail, or forest road you can ride. Trail systems are often linked by county roads. Check that county's ORV ordinance before riding them.</div>`;
  if (r.offStart > 400) html += `<div class="note">Your start is ${fmtMi(r.offStart)} from the nearest trail you can ride. The route starts there.</div>`;
  if (r.offEnd > 400) html += `<div class="note">That spot is ${fmtMi(r.offEnd)} from the nearest trail you can ride. The route ends there.</div>`;
  if (r.seasonal > 50) html += `<div class="note restrict">Uses ${fmtMi(r.seasonal)} of forest road that is closed to ORVs part of the year. Tap the dashed teal roads to see the dates.</div>`;
  if (r.military > 50) html += `<div class="note restrict">Crosses Camp Grayling military roads, which can close for training.</div>`;
  html += '<ol class="steps">' + r.steps.map((s, i) => `<li data-i="${i}"><b>${esc(s.label)}</b><small>${fmtMi(s.meters)}</small></li>`).join('') + '</ol>';
  html += `<p class="hint">Routes use DNR data only and skip closed segments. Always follow posted signs.</p>`;
  $('#route-body').innerHTML = html;
  $('#route-body').querySelectorAll('.steps li').forEach((li) => li.addEventListener('click', () => {
    map.setView(r.steps[+li.dataset.i].at, Math.max(map.getZoom(), 14));
  }));
  openSheet('#panel-route');
}

function clearRoute() {
  route = null; manualStart = null;
  clearRouteLayer();
  if (fromMarker) { map.removeLayer(fromMarker); fromMarker = null; }
  $('#route-bar').hidden = true;
  closeSheets();
}
$('#btn-route-clear').addEventListener('click', clearRoute);
$('#route-bar').addEventListener('click', (e) => {
  if (e.target.closest('.x')) return clearRoute();
  if (route && route.result) showRouteSheet();
});

// Re-run with the same ends when the machine width changes.
document.querySelectorAll('#rig-seg button').forEach((b) => b.addEventListener('click', () => { if (route && G) runRoute(); }));

// ---------- GPS helpers ----------
function ensureGpsFix() { if (watchId === null) locBtn.click(); }
function waitForFix(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (meMarker) { clearInterval(iv); resolve(meMarker.getLatLng()); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
    }, 300);
  });
}

// ---------- entry points ----------
// long-press (or right-click) anywhere
let pressed = null;
map.on('contextmenu', (e) => {
  pressed = e.latlng;
  $('#point-coords').textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  openSheet('#panel-point');
});
$('#btn-route-here').addEventListener('click', () => { closeSheets(); routeTo(pressed); });
$('#btn-route-from').addEventListener('click', () => {
  manualStart = pressed;
  if (fromMarker) map.removeLayer(fromMarker);
  fromMarker = L.circleMarker(pressed, { renderer, radius: 8, color: '#fff', weight: 3, fillColor: '#2fbf4a', fillOpacity: 1, interactive: false }).addTo(map);
  closeSheets();
  if (route) { route.from = L.latLng(pressed); runRoute(); }
  else toast('Start set. Now long-press where you want to go and choose "Route here".');
});
// "Route here" from a trail's detail sheet
window.routeHere = (latlng) => { closeSheets(); routeTo(latlng); };

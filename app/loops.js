'use strict';
// "Find me a loop": from a start point and a length, build loops your machine can legally ride that
// cover as much trail you HAVEN'T ridden as possible, without riding the same stretch twice.
// How: try loops in 8 directions (start -> A -> B -> start, a rough triangle), routing each leg with
// extra cost on trail you've ridden and on trail this loop already uses; score by new miles, then
// how close to the length you asked for. Also: "Back to the truck".

const LOOP_DIRS = 8;
const LOOP_WIND = 1.35;      // trails wander: a loop's trail miles run ~35% over its straight-line triangle
const RIDDEN_COST = 3;       // a ridden mile "costs" like 3 new ones
const REUSE_COST = 8;        // and riding the same stretch twice like 8
const CONNECTOR_COST = 1.5;  // short gap connectors (road bits between trails): use, but not by choice
let loopState = null;        // { start, name, results, layer, pick }

// how much of each graph edge you've ridden (0..1), from your saved rides
function riddenLookup() {
  const rides = (typeof progress !== 'undefined' && progress && progress.rides) || [];
  if (!rides.length) return () => 0;
  const idx = rideIndex(rides), memo = new Map();
  return (e) => {
    if (memo.has(e)) return memo.get(e);
    const pts = edgeCoords(e);
    let hit = 0, n = 0;
    const step = Math.max(1, Math.floor(pts.length / 6)); // a few points per edge is plenty
    for (let i = 0; i < pts.length; i += step) { n++; if (nearRide(idx, pts[i][0], pts[i][1])) hit++; }
    const v = n ? hit / n : 0;
    memo.set(e, v);
    return v;
  };
}
// a point dist meters from (lat, lng) toward bearing deg
function offsetPt(lat, lng, dist, deg) {
  const r = deg * Math.PI / 180;
  return [lat + (dist * Math.cos(r)) / 110540, lng + (dist * Math.sin(r)) / (111320 * Math.cos(lat * Math.PI / 180))];
}
const legsMeters = (legs) => legs.reduce((s, l) => s + l.meters, 0);
const tick = () => new Promise((r) => setTimeout(r, 0)); // let the screen update between tries

async function findLoops(start, targetMi, preferNew) {
  await loadGraph();
  if (typeof computeProgress === 'function' && (!progress || !progress.rides)) await computeProgress();
  const target = targetMi * 1609.344;
  // start on the biggest network within about a mile, not just the closest scrap of trail
  const compAll = components();
  if (!findLoops.size || findLoops.size.c !== compAll) {
    const m = new Map();
    for (let e = 0; e < G.eu.length; e++) if (allowed(e)) m.set(compAll[G.eu[e]], (m.get(compAll[G.eu[e]]) || 0) + G.elen[e]);
    findLoops.size = { c: compAll, m };
  }
  const near = candidates(start.lat, start.lng, 1600);
  if (!near.length || near[0].d > 3000) return { fail: 'No trail your machine can ride within 2 miles of here.' };
  const S = near.reduce((b, c) => ((findLoops.size.m.get(compAll[G.eu[c.e]]) || 0) / (1 + c.d / 800) > (findLoops.size.m.get(compAll[G.eu[b.e]]) || 0) / (1 + b.d / 800) ? c : b));
  const ridden = preferNew ? riddenLookup() : () => 0;
  // Turn points are trail junctions you can actually reach from the start (the nearest bit of trail
  // to some spot on the map may be an isolated piece).
  const kindOf = (e) => G.attrs[G.eattr[e]][0];
  const out = [];
  const comp = components(), home = comp[G.eu[S.e]];
  const nodes = [];
  let netM = 0;
  for (let e = 0; e < G.eu.length; e++) if (allowed(e) && comp[G.eu[e]] === home) netM += G.elen[e];
  for (let n = 0; n < G.nx.length; n++) {
    if (comp[n] !== home) continue;
    const e = G.adj[n].find(allowed);
    if (e === undefined) continue;
    const d = hav(S.lat, S.lng, G.ny[n], G.nx[n]);
    const y = Math.sin((G.nx[n] - S.lng) * Math.PI / 180) * Math.cos(G.ny[n] * Math.PI / 180);
    const x = Math.cos(S.lat * Math.PI / 180) * Math.sin(G.ny[n] * Math.PI / 180) - Math.sin(S.lat * Math.PI / 180) * Math.cos(G.ny[n] * Math.PI / 180) * Math.cos((G.nx[n] - S.lng) * Math.PI / 180);
    nodes.push({ n, e, d, brg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 });
  }
  const apart = (a, b) => Math.abs(((a - b + 540) % 360) - 180); // degrees between two headings
  // the reachable junction closest to a wanted distance and heading
  const pick = (dist, deg) => {
    let best = null, bs = Infinity;
    for (const v of nodes) {
      const off = apart(v.brg, deg);
      if (off > 40 || v.d < 300) continue;
      const sc = Math.abs(v.d - dist) / dist + off / 90;
      if (sc < bs) { bs = sc; best = v; }
    }
    return best && { e: best.e, lat: G.ny[best.n], lng: G.nx[best.n], along: G.eu[best.e] === best.n ? 0 : G.elen[best.e], d: 0 };
  };
  const tryLoop = (via, deg) => {
    const used = new Set();
    LOOP_COST = (e) => (1 + RIDDEN_COST * ridden(e)) * (used.has(e) ? REUSE_COST : 1) * (kindOf(e) === 'connector' ? CONNECTOR_COST : 1);
    const legs = [];
    try {
      const stops = [S, ...via, S];
      for (let i = 0; i + 1 < stops.length; i++) {
        const sol = solve(stops[i], stops[i + 1]);
        if (!sol.endVia) return;
        const part = assemble(stops[i], stops[i + 1], sol);
        for (const l of part) used.add(l.e);
        legs.push(...part);
      }
    } finally { LOOP_COST = null; }
    const total = legsMeters(legs);
    if (total < target * 0.6 || total > target * 1.4) return;
    // new miles (each edge counted once), and how much of the loop doubles back on itself
    const seen = new Set();
    let fresh = 0, repeat = 0;
    for (const l of legs) {
      if (seen.has(l.e)) { repeat += l.meters; continue; }
      seen.add(l.e);
      fresh += l.meters * (1 - ridden(l.e));
    }
    const score = (preferNew ? fresh : total) - 1.2 * repeat - 0.6 * Math.abs(total - target);
    out.push({ deg, legs, total, fresh, repeat, score, path: legs.flatMap((l) => l.coords), names: loopNames(legs) });
  };
  const r = target / (3 * LOOP_WIND); // equilateral-ish triangle with sides r
  for (let k = 0; k < LOOP_DIRS; k++) {
    const deg = (360 / LOOP_DIRS) * k;
    for (const scale of [1, 0.75, 0.55]) {
      await tick();
      const A = pick(r * scale, deg - 30), B = pick(r * scale, deg + 30);
      if (A && B && (A.e !== B.e)) tryLoop([A, B], deg);
    }
    // lollipop: out to one far point and back a different way
    for (const scale of [1, 0.7]) {
      await tick();
      const F = pick((scale * target) / (2 * LOOP_WIND), deg);
      if (F) tryLoop([F], deg);
    }
  }
  if (!out.length) {
    const net = netM / 1609.344;
    return { fail: net < targetMi * 0.6
      ? `The trails your machine can reach from here only add up to about ${Math.round(net)} mi. Try a shorter loop or another start spot.`
      : 'Couldn\'t make a loop that size from here. Try a different length or start spot.' };
  }
  out.sort((a, b) => b.score - a.score);
  // keep loops that head different ways, not three versions of the same one
  const picks = [];
  for (const o of out) if (picks.every((p) => apart(o.deg, p.deg) >= 60)) { picks.push(o); if (picks.length === 3) break; }
  return { loops: picks };
}
function loopNames(legs) {
  const by = new Map();
  for (const l of legs) {
    const [kind, , name] = G.attrs[G.eattr[l.e]];
    if (kind === 'connector') continue;
    const label = name || (KIND[kind] ? KIND[kind].label : 'trail');
    by.set(label, (by.get(label) || 0) + l.meters);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}

// ---------- the sheet ----------
const LOOP_COLORS = ['#ff2fd0', '#1e6bff', '#ffd400'];
function showLoopSheet(start, name) {
  loopState = { start, name: name || 'this spot', results: null };
  drawLoopForm();
  openSheet('#sheet');
}
window.showLoopSheet = showLoopSheet;
function drawLoopForm(msg) {
  const lenMi = store.get('loopMi', 30);
  const rides = (typeof progress !== 'undefined' && progress && progress.rides) || [];
  $('#sheet-body').innerHTML = `<h3>Find a loop</h3>
    <p class="hint">From ${esc(loopState.name)}. Only trails your ${rig ? esc(machineName()) : 'machine'} can ride.</p>
    <h2>How far</h2>
    <div class="seg" id="loop-len">${[10, 20, 30, 45, 60, 80].map((m) => `<button data-mi="${m}" class="${m === lenMi ? 'on' : ''}">${m} mi</button>`).join('')}</div>
    <p class="hint">About ${rideTimeText(lenMi)} at ${RIDE_MPH[0]}–${RIDE_MPH[1]} mph.</p>
    <label class="row"><input type="checkbox" id="loop-new" ${store.get('loopNew', 1) ? 'checked' : ''}> Favor trails I haven't ridden${rides.length ? '' : ' (no rides saved yet, so everything is new)'}</label>
    <button class="primary" data-a="find">Find loops</button>
    ${msg ? `<p class="hint warn">${esc(msg)}</p>` : ''}`;
  $('#sheet-body').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mi) { store.set('loopMi', +b.dataset.mi); drawLoopForm(); return; }
    if (b.dataset.a === 'find') {
      store.set('loopNew', $('#loop-new').checked ? 1 : 0);
      b.disabled = true; b.textContent = 'Looking for loops…';
      let res;
      try { res = await findLoops(loopState.start, store.get('loopMi', 30), $('#loop-new').checked); }
      catch { res = { fail: 'Could not load the trail network' }; }
      if (res.fail) return drawLoopForm(res.fail);
      loopState.results = res.loops;
      showLoopResults();
    }
  };
}
function clearLoopPreview() { if (loopState && loopState.layer) { map.removeLayer(loopState.layer); loopState.layer = null; } }
function showLoopResults(pick = 0) {
  const L0 = loopState.results;
  clearLoopPreview();
  loopState.layer = L.layerGroup().addTo(map);
  // the picked loop on top, the others faint underneath
  L0.forEach((o, i) => {
    if (i === pick) return;
    L.polyline(o.path, { renderer: planRenderer, color: LOOP_COLORS[i], weight: 4, opacity: 0.45, dashArray: '6 6', interactive: false }).addTo(loopState.layer);
  });
  const o = L0[pick];
  L.polyline(o.path, { renderer: planRenderer, color: '#fff', weight: 10, opacity: 0.9, interactive: false }).addTo(loopState.layer);
  L.polyline(o.path, { renderer: planRenderer, color: LOOP_COLORS[pick], weight: 6, interactive: false }).addTo(loopState.layer);
  L.circleMarker([loopState.start.lat, loopState.start.lng], { renderer: planRenderer, radius: 8, color: '#fff', weight: 3, fillColor: '#2fbf4a', fillOpacity: 1, interactive: false }).addTo(loopState.layer);
  map.fitBounds(L.latLngBounds(o.path), { padding: [30, 30], paddingBottomRight: [30, Math.round(window.innerHeight * 0.45)] });
  const mi = (m) => (m / 1609.344).toFixed(1);
  $('#sheet-body').innerHTML = `<h3>Loops from ${esc(loopState.name)}</h3>
    <ul class="along loop-list">${L0.map((x, i) => `<li data-i="${i}" class="${i === pick ? 'on' : ''}"><i class="loop-sw" style="background:${LOOP_COLORS[i]}"></i>
      <div><b>Loop ${i + 1}: ${mi(x.total)} mi · ${rideTimeText(x.total / 1609.344, true)}</b>
      <small>${mi(x.fresh)} mi new to you (${Math.round((100 * x.fresh) / x.total)}%)${x.repeat > 300 ? ` · ${mi(x.repeat)} mi doubles back` : ''}</small>
      <small>${esc(x.names.join(', '))}</small></div></li>`).join('')}</ul>
    <div class="rec-row"><button class="primary" data-a="use">Ride loop ${pick + 1}</button><button class="ghost" data-a="again">Change length</button></div>
    <p class="hint">"Ride" puts it on the map as your picked ride: miles, time, and Make it a trip for navigation.</p>`;
  $('#sheet-body').onclick = (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) return showLoopResults(+li.dataset.i);
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'again') { clearLoopPreview(); drawLoopForm(); }
    if (a === 'use') useLoop(o);
  };
}
// the chosen loop becomes a picked ride (dots about every 1.5 mi so it can be edited or made a trip)
function useLoop(o) {
  clearLoopPreview();
  const path = o.path.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]);
  const dots = [path[0]];
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    run += hav(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (run > 2400 && i < path.length - 1) { dots.push(path[i]); run = 0; }
  }
  dots.push(path[path.length - 1]);
  selItems = [{ key: 'c' + Date.now(), name: `${(o.total / 1609.344).toFixed(0)} mi loop from ${loopState.name}`.slice(0, 80), kind: 'custom', mi: +(o.total / 1609.344).toFixed(2), lines: [path], dots }];
  drawSel();
  showSel();
}
map.on('click', () => { if (loopState && loopState.layer && $('#sheet').hidden) clearLoopPreview(); });

// ---------- where to find it ----------
$('#btn-loop-here').addEventListener('click', () => { closeSheets(); showLoopSheet(L.latLng(pressed), 'this spot'); });
$('#btn-loop').addEventListener('click', () => {
  const at = meMarker ? meMarker.getLatLng() : map.getCenter();
  showLoopSheet(at, meMarker ? 'your location' : 'the middle of the map');
});
window.loopFromTrailhead = (p) => showLoopSheet(L.latLng(p.lat, p.lng), p.n);

// ---------- back to the truck ----------
// The truck is where you said you parked (long-press → "Truck is parked here"), else where this ride started.
window.truckPoint = () => {
  const t = store.get('truck', null);
  if (t && Date.now() - t.t < 3 * 86400000) return [t.lat, t.lng];
  return window.rideStartPoint ? rideStartPoint() : null;
};
$('#btn-truck-here').addEventListener('click', () => {
  store.set('truck', { lat: +pressed.lat.toFixed(6), lng: +pressed.lng.toFixed(6), t: Date.now() });
  closeSheets();
  toast('Truck spot saved. "Back to the truck" will route here for the next 3 days.');
});
window.backToTruck = () => {
  const t = truckPoint();
  if (!t) return toast('No truck spot yet. Start recording at the truck, or long-press where you parked and choose "Truck is parked here".');
  if (plan && plan.stops.length > 1 && !confirm('Replace your planned trip with a route back to the truck?')) return;
  plan = { stops: [{ name: 'My location', mine: true, lat: 0, lng: 0 }, { lat: t[0], lng: t[1], name: 'Truck', night: false }] };
  savePlan();
  closeSheets();
  computePlan();
};

'use strict';
// Fix a ride by hand: trace a missed section (forgot to start, phone died) or a whole ride, following the trails.
// Sections added this way count toward miles and the ride-every-trail goal, but not toward ride time.

const trace = { on: false, ride: null, pts: [], legs: [], layer: null };
window.traceMode = () => trace.on;

// ---------- edit sheet for one ride ----------
function editRide(t) {
  const manual = (t.manual || []).filter((i) => t.segs[i]);
  const addedM = manual.reduce((s, i) => s + segMeters(t.segs[i]), 0);
  $('#ride-edit-body').innerHTML = `<h3>${esc(t.name)}</h3>
    <p class="hint">Forgot to start recording, or your phone died? Trace the missing part on the map. It follows the trails between your taps and gets added to this ride.</p>
    <button class="primary" data-a="add">Add a missed section</button>
    ${manual.length ? `<button class="ghost" data-a="remove">Remove ${manual.length} section${manual.length > 1 ? 's' : ''} added by hand (${fmtMi(addedM)})</button>` : ''}`;
  $('#ride-edit-body').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'add') startTrace(t);
    if (a === 'remove') {
      if (!confirm('Remove the sections you added by hand? The recorded part stays.')) return;
      t.segs = t.segs.filter((_, i) => !manual.includes(i));
      t.manual = [];
      await putTrack(t);
      refreshShownTrack(t);
      closeSheets();
      renderList();
      toast('Added sections removed');
    }
  };
  openSheet('#panel-ride-edit');
}
window.editRide = editRide;
window.traceNewRide = () => startTrace(null);

function segMeters(seg) {
  let m = 0;
  for (let i = 1; i < seg.length; i++) m += hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
  return m;
}
function refreshShownTrack(t) {
  if (shownTracks.has(t.id)) { hideTrack(t.id); showTrack(t, false); }
}

// ---------- tracing ----------
async function startTrace(ride) {
  try { await loadGraph(); } catch { return toast('Could not load the trail network'); }
  trace.on = true; trace.ride = ride; trace.pts = []; trace.legs = [];
  if (trace.layer) map.removeLayer(trace.layer);
  trace.layer = L.layerGroup().addTo(map);
  if (ride) showTrack(ride, true); // see what was recorded, so you can trace up to where it starts or ends
  closeSheets();
  document.body.classList.add('tracing');
  $('#trace-bar').hidden = false;
  updateTraceBar();
}
function endTrace() {
  trace.on = false;
  if (trace.layer) { map.removeLayer(trace.layer); trace.layer = null; }
  document.body.classList.remove('tracing');
  $('#trace-bar').hidden = true;
}

// One leg between two taps. Only snaps to a trail/road right where you tapped (~250 ft); follows the
// network only when it connects without a big detour; otherwise a straight line between your taps.
const TRACE_SNAP_M = 75;
const TRACE_DETOUR = 2.5;   // a trail path longer than 2.5x the straight distance (+~1/2 mi) is a wrong guess
function traceLeg(a, b) {
  const straight = { coords: [a, b], straight: true };
  const direct = hav(a[0], a[1], b[0], b[1]);
  ROUTE_ANY = true;
  try {
    const S = candidates(a[0], a[1], 0)[0], T = candidates(b[0], b[1], 0)[0];
    if (!S || !T || S.d > TRACE_SNAP_M || T.d > TRACE_SNAP_M) return straight;
    const sol = solve(S, T);
    if (!sol.endVia) return straight;
    const path = assemble(S, T, sol).flatMap((l) => l.coords);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += hav(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (len > direct * TRACE_DETOUR + 800) return straight;
    return { coords: [a, ...path, b] };
  } finally {
    ROUTE_ANY = false;
  }
}
window.traceAdd = (latlng) => {
  const p = [latlng.lat, latlng.lng];
  if (trace.pts.length) trace.legs.push(traceLeg(trace.pts[trace.pts.length - 1], p));
  trace.pts.push(p);
  drawTrace();
};
function drawTrace() {
  trace.layer.clearLayers();
  for (const leg of trace.legs) {
    L.polyline(leg.coords, { renderer: planRenderer, color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(trace.layer);
    L.polyline(leg.coords, { renderer: planRenderer, color: '#ff2fd0', weight: 5, dashArray: leg.straight ? '6 6' : null, interactive: false }).addTo(trace.layer);
  }
  trace.pts.forEach((p, i) => L.circleMarker(p, { renderer: planRenderer, radius: i === 0 ? 8 : 6, color: '#fff', weight: 3,
    fillColor: i === 0 ? '#2fbf4a' : '#ff2fd0', fillOpacity: 1, interactive: false }).addTo(trace.layer));
  updateTraceBar();
}
function traceMeters() { return trace.legs.reduce((s, l) => s + segMeters(l.coords), 0); }
function updateTraceBar() {
  const n = trace.pts.length;
  // keep these short: a taller bar covers more map
  $('#trace-text').textContent = n === 0 ? 'Tap where this section starts'
    : n === 1 ? 'Tap where it ends'
      : `${fmtMi(traceMeters())} traced · tap more or Save`;
  $('#trace-sub').textContent = n === 1 ? 'It follows the trails between your taps'
    : trace.ride ? `Adding to "${trace.ride.name}"` : 'Tracing a new ride';
  $('#btn-trace-undo').disabled = !n;
  $('#btn-trace-save').disabled = n < 2;
}
$('#btn-trace-undo').addEventListener('click', () => { trace.pts.pop(); trace.legs.pop(); drawTrace(); });
$('#btn-trace-cancel').addEventListener('click', endTrace);
$('#btn-trace-save').addEventListener('click', async () => {
  if (trace.pts.length < 2) return;
  // one continuous line; every point gets the same time so it adds miles but no ride time
  const pts = [];
  for (const leg of trace.legs) for (const c of leg.coords) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) pts.push(c);
  }
  let ride = trace.ride;
  const now = Date.now();
  if (!ride) {
    const name = prompt('Name this ride', 'Ride ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    if (name === null) return;
    ride = { id: 't' + now, name: (name.trim() || 'Ride').slice(0, 80), start: now, end: now, segs: [], done: true, manual: [] };
  }
  const stamp = ride.start || now;
  ride.segs.push(pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6), null, stamp]));
  ride.manual = [...(ride.manual || []), ride.segs.length - 1];
  await putTrack(ride);
  const added = traceMeters();
  endTrace();
  refreshShownTrack(ride);
  renderList();
  toast(`Added ${fmtMi(added)} to "${ride.name}"`);
});

$('#btn-trace-new').addEventListener('click', () => startTrace(null));

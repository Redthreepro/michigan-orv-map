'use strict';
// Fix a ride by hand: trace a missed section (forgot to start, phone died) or a whole ride, following the trails.
// Sections added this way count toward miles and the ride-every-trail goal, but not toward ride time.
// ride.manual = indexes of segs added by hand; ride.taps[i] = the dots that seg was traced from, so it can be fixed later.

// mode 'pick' reuses all of this to pick the part of the trails you plan to ride (select.js); only legal trails count there.
const trace = { on: false, mode: 'ride', pick: null, ride: null, fix: null, pts: [], legs: [], hist: [], layer: null };
window.traceMode = () => trace.on;

// ---------- edit sheet for one ride ----------
function editRide(t) {
  const manual = (t.manual || []).filter((i) => t.segs[i]);
  const rows = manual.map((i, n) => `<div class="edit-sec"><span>Section ${n + 1} · ${fmtMi(segMeters(t.segs[i]))}</span>
      <button class="ghost" data-a="fix" data-i="${i}">Fix</button><button class="ghost danger" data-a="del" data-i="${i}">Delete</button></div>`).join('');
  $('#ride-edit-body').innerHTML = `<h3>${esc(t.name)}</h3>
    <p class="hint">Forgot to start recording, or your phone died? Trace the missing part on the map. It follows the trails between your taps and gets added to this ride.</p>
    <button class="primary" data-a="add">Add a missed section</button>
    ${manual.length ? `<h4>Added by hand</h4>${rows}<p class="hint">Fix lets you drag the dots to move the line onto the right trail.</p>` : ''}
    ${window.mergeEditHtml ? mergeEditHtml(t) : ''}`;
  $('#ride-edit-body').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a, i = +b.dataset.i;
    if (window.mergeEditClick && await mergeEditClick(t, a, i)) return;
    if (a === 'add') startTrace(t);
    if (a === 'fix') startTrace(t, i);
    if (a === 'del') {
      if (!confirm(`Delete this ${fmtMi(segMeters(t.segs[i]))} section? The recorded part stays.`)) return;
      dropSeg(t, i);
      // a ride traced entirely by hand has nothing left: remove the empty ride
      if (!t.segs.length) {
        hideTrack(t.id); await delTrack(t.id); closeSheets(); renderList(); toast('Ride deleted (nothing left in it)');
        return;
      }
      await putTrack(t);
      refreshShownTrack(t);
      renderList();
      toast('Section deleted');
      editRide(t);
    }
  };
  openSheet('#panel-ride-edit');
}
window.editRide = editRide;
window.traceNewRide = () => startTrace(null);

// remove one seg and shift the hand-added indexes (and their dots) after it
function dropSeg(t, i) {
  t.segs.splice(i, 1);
  t.manual = (t.manual || []).filter((m) => m !== i).map((m) => (m > i ? m - 1 : m));
  const taps = {};
  for (const [k, v] of Object.entries(t.taps || {})) if (+k !== i) taps[+k > i ? +k - 1 : k] = v;
  t.taps = taps;
  // a merged ride's part ranges shift down past the removed seg
  for (const p of t.parts || []) { if (p.from > i) p.from--; if (p.to > i) p.to--; }
}

function segMeters(seg) {
  let m = 0;
  for (let i = 1; i < seg.length; i++) m += hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
  return m;
}
function refreshShownTrack(t) {
  if (shownTracks.has(t.id)) { hideTrack(t.id); showTrack(t, false); }
}

// Sections saved before dots were kept: rebuild dots along the line (ends + about every 0.6 mi).
function dotsFromSeg(seg) {
  const out = [[seg[0][0], seg[0][1]]];
  let run = 0;
  for (let i = 1; i < seg.length; i++) {
    run += hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
    if (run >= 1000 && i < seg.length - 1) { out.push([seg[i][0], seg[i][1]]); run = 0; }
  }
  const last = seg[seg.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

// ---------- tracing ----------
async function startTrace(ride, fix = null, pick = null) {
  try { await loadGraph(); } catch { return toast('Could not load the trail network'); }
  trace.on = true; trace.ride = ride; trace.fix = fix; trace.pts = []; trace.legs = []; trace.hist = [];
  trace.mode = pick ? 'pick' : 'ride';
  trace.pick = pick && pick !== true ? pick : null; // editing a ride picked earlier
  if (trace.layer) map.removeLayer(trace.layer);
  trace.layer = L.layerGroup().addTo(map);
  closeSheets();
  document.body.classList.add('tracing');
  $('#trace-bar').hidden = false;
  if (ride && fix != null) {
    // show the ride without the section being fixed; the section comes back as draggable dots
    hideTrack(ride.id);
    showTrack({ ...ride, segs: ride.segs.filter((_, i) => i !== fix) }, false);
    // a copy: dragging dots must not touch the saved ones unless you tap Save
    trace.pts = ((ride.taps && ride.taps[fix]) || dotsFromSeg(ride.segs[fix])).map((p) => p.slice());
    for (let i = 1; i < trace.pts.length; i++) trace.legs.push(traceLeg(trace.pts[i - 1], trace.pts[i]));
    map.fitBounds(L.latLngBounds(ride.segs[fix].map((p) => [p[0], p[1]])), { padding: [60, 60] });
  } else if (ride) {
    showTrack(ride, true); // see what was recorded, so you can trace up to where it starts or ends
  } else if (trace.pick) {
    trace.pts = trace.pick.dots.slice();
    for (let i = 1; i < trace.pts.length; i++) trace.legs.push(traceLeg(trace.pts[i - 1], trace.pts[i]));
  }
  drawTrace();
}
function endTrace() {
  trace.on = false;
  if (trace.layer) { map.removeLayer(trace.layer); trace.layer = null; }
  if (trace.ride && trace.fix != null) { hideTrack(trace.ride.id); showTrack(trace.ride, false); }
  document.body.classList.remove('tracing');
  $('#trace-bar').hidden = true;
}

// One leg between two dots. Snaps to a trail/road within a fingertip of the dot (scales with zoom,
// so a sloppy tap zoomed out still works, but never jumps to a trail miles away); follows the
// network only when it connects without a big detour; otherwise a straight line between the dots.
const TRACE_SNAP_PX = 35;
const TRACE_DETOUR = 4;     // a trail path longer than 4x the straight distance (+~1 mi) is a wrong guess
function traceSnapM() {
  const mpp = 40075016 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  return Math.min(800, Math.max(60, TRACE_SNAP_PX * mpp));
}
function traceLeg(a, b) {
  const straight = { coords: [a, b], straight: true };
  const direct = hav(a[0], a[1], b[0], b[1]);
  const snap = traceSnapM();
  ROUTE_ANY = trace.mode === 'ride';
  try {
    const S = candidates(a[0], a[1], 0)[0], T = candidates(b[0], b[1], 0)[0];
    if (!S || !T || S.d > snap || T.d > snap) return straight;
    const sol = solve(S, T);
    if (!sol.endVia) return straight;
    const path = assemble(S, T, sol).flatMap((l) => l.coords);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += hav(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (len > direct * TRACE_DETOUR + 1600) return straight;
    return { coords: path }; // starts and ends on the trail, not out where your finger landed
  } finally {
    ROUTE_ANY = false;
  }
}
function remember() { trace.hist.push({ pts: trace.pts.slice(), legs: trace.legs.slice() }); }
function warnStraight(legs) {
  if (legs.some((l) => l && l.straight)) toast(trace.mode === 'pick' ? 'No trail your machine can ride there, so it drew a straight line. Undo, or drag the dot onto a trail.'
    : 'No trail there, so it drew a straight line. Undo, or drag the dot right onto the trail.');
}
window.traceAdd = (latlng) => {
  remember();
  const p = [latlng.lat, latlng.lng];
  if (trace.pts.length) {
    const leg = traceLeg(trace.pts[trace.pts.length - 1], p);
    trace.legs.push(leg);
    warnStraight([leg]);
  }
  trace.pts.push(p);
  drawTrace();
};
// a dot moved: re-trace the legs on both sides of it
function moveDot(i, p) {
  remember();
  trace.pts[i] = p;
  const changed = [];
  if (i > 0) changed.push(trace.legs[i - 1] = traceLeg(trace.pts[i - 1], p));
  if (i < trace.pts.length - 1) changed.push(trace.legs[i] = traceLeg(p, trace.pts[i + 1]));
  warnStraight(changed);
  drawTrace();
}
// a middle handle dragged: it becomes a new dot that splits the leg in two
function insertDot(leg, p) {
  remember();
  trace.pts.splice(leg + 1, 0, p);
  const a = traceLeg(trace.pts[leg], p), b = traceLeg(p, trace.pts[leg + 2]);
  trace.legs.splice(leg, 1, a, b);
  warnStraight([a, b]);
  drawTrace();
}
function removeDot(i) {
  remember();
  const n = trace.pts.length;
  trace.pts.splice(i, 1);
  if (i === 0) trace.legs.shift();
  else if (i === n - 1) trace.legs.pop();
  else {
    const leg = traceLeg(trace.pts[i - 1], trace.pts[i]);
    trace.legs.splice(i - 1, 2, leg);
    warnStraight([leg]);
  }
  drawTrace();
}

const dotIcon = (cls) => L.divIcon({ className: 'trace-dot ' + cls, iconSize: [34, 34] });
function drawTrace() {
  trace.layer.clearLayers();
  for (const leg of trace.legs) {
    L.polyline(leg.coords, { renderer: planRenderer, color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(trace.layer);
    L.polyline(leg.coords, { renderer: planRenderer, color: '#ff2fd0', weight: 5, dashArray: leg.straight ? '6 6' : null, interactive: false }).addTo(trace.layer);
  }
  // hollow handle halfway along each leg; drag it to bend the line onto another trail.
  // Skipped on legs too short on screen, where it would sit on top of a dot (zoom in to get it).
  trace.legs.forEach((leg, k) => {
    const c = leg.coords;
    if (map.latLngToContainerPoint(trace.pts[k]).distanceTo(map.latLngToContainerPoint(trace.pts[k + 1])) < 64) return;
    let half = segMeters(c) / 2, mid = c[0];
    for (let i = 1; i < c.length && half > 0; i++) { half -= hav(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]); mid = c[i]; }
    L.marker(mid, { icon: dotIcon('mid'), draggable: true, keyboard: false, zIndexOffset: -10 })
      .on('dragend', (e) => { const ll = e.target.getLatLng(); insertDot(k, [ll.lat, ll.lng]); })
      .addTo(trace.layer);
  });
  trace.pts.forEach((p, i) => {
    L.marker(p, { icon: dotIcon(i === 0 ? 'first' : ''), draggable: true, keyboard: false })
      .on('dragend', (e) => { const ll = e.target.getLatLng(); moveDot(i, [ll.lat, ll.lng]); })
      .on('click', (e) => { L.DomEvent.stop(e); removeDot(i); })
      .addTo(trace.layer);
  });
  updateTraceBar();
}
map.on('zoomend', () => { if (trace.on) drawTrace(); });
function traceMeters() { return trace.legs.reduce((s, l) => s + segMeters(l.coords), 0); }
function updateTraceBar() {
  const n = trace.pts.length;
  $('#btn-trace-save').textContent = trace.mode === 'pick' ? 'Done' : 'Save';
  if (trace.mode === 'pick') {
    const mi = traceMeters() / 1609.344;
    $('#trace-text').textContent = n === 0 ? "Tap where you'll start" : n === 1 ? "Tap where you'll end"
      : `${mi.toFixed(1)} mi · about ${rideTimeText(mi, true)}`;
    $('#trace-sub').textContent = n === 0 ? 'It follows the trails your machine can ride'
      : n === 1 ? 'Tap points along the way to steer it onto the loop you want'
        : 'Drag a dot to move it · tap a dot to remove it';
    $('#btn-trace-undo').disabled = !trace.hist.length;
    $('#btn-trace-save').disabled = n < 2;
    return;
  }
  // keep these short: a taller bar covers more map
  $('#trace-text').textContent = n === 0 ? 'Tap where this section starts'
    : n === 1 ? 'Tap where it ends'
      : `${fmtMi(traceMeters())} traced · tap more or Save`;
  $('#trace-sub').textContent = n === 1 ? 'It follows the trails between your taps'
    : n >= 2 ? 'Drag a dot to move it · tap a dot to remove it'
      : trace.ride ? `Adding to "${trace.ride.name}"` : 'Tracing a new ride';
  $('#btn-trace-undo').disabled = !trace.hist.length;
  $('#btn-trace-save').disabled = n < 2;
}
$('#btn-trace-undo').addEventListener('click', () => {
  const h = trace.hist.pop();
  if (!h) return;
  trace.pts = h.pts; trace.legs = h.legs;
  drawTrace();
});
$('#btn-trace-cancel').addEventListener('click', endTrace);
$('#btn-trace-save').addEventListener('click', async () => {
  if (trace.pts.length < 2) return;
  // one continuous line; every point gets the same time so it adds miles but no ride time
  const pts = [];
  for (const leg of trace.legs) for (const c of leg.coords) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) pts.push(c);
  }
  if (trace.mode === 'pick') {
    const dots = trace.pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]), item = trace.pick;
    endTrace();
    return pickDone(pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]), dots, item);
  }
  let ride = trace.ride;
  const now = Date.now();
  if (!ride) {
    const name = prompt('Name this ride', 'Ride ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    if (name === null) return;
    ride = { id: 't' + now, name: (name.trim() || 'Ride').slice(0, 80), start: now, end: now, segs: [], done: true, manual: [] };
  }
  const stamp = ride.start || now;
  const seg = pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6), null, stamp]);
  const fixing = ride === trace.ride && trace.fix != null;
  const idx = fixing ? trace.fix : ride.segs.length;
  ride.segs[idx] = seg;
  if (!fixing) ride.manual = [...(ride.manual || []), idx];
  ride.taps = { ...(ride.taps || {}), [idx]: trace.pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]) };
  await putTrack(ride);
  const added = traceMeters();
  endTrace();
  refreshShownTrack(ride);
  renderList();
  toast(fixing ? `Section fixed (${fmtMi(added)})` : `Added ${fmtMi(added)} to "${ride.name}"`);
});

$('#btn-trace-new').addEventListener('click', () => startTrace(null));

'use strict';
// Fix a ride by hand: trace a missed section (forgot to start, phone died) or a whole ride, following the trails.
// Sections added this way count toward miles and the ride-every-trail goal, but not toward ride time.
// ride.manual = indexes of segs added by hand; ride.taps[i] = the dots that seg was traced from, so it can be fixed later.

// mode 'pick' reuses all of this to pick the part of the trails you plan to ride (select.js); only legal trails count there.
const trace = { on: false, mode: 'ride', method: 'trails', pick: null, ride: null, fix: null, gap: null, pts: [], legs: [], hist: [], layer: null, saving: false };
window.traceMode = () => trace.on;

// Candidate gaps, not guesses about where the rider went. Include both a long
// interruption inside a segment and a jump between recorded segments.
function recordingGaps(t) {
  const gaps = [], manual = new Set(t.manual || []);
  const repairs = [...manual].map((k) => t.segs[k]).filter((seg) => seg && seg.length >= 2);
  const samePoint = (a, b) => hav(a[0], a[1], b[0], b[1]) <= 35;
  let previous = null, previousSeg = null;
  t.segs.forEach((seg, k) => {
    if (manual.has(k)) return;
    for (const [pointIndex, p] of seg.entries()) {
      if (previous) {
        const distance = hav(previous[0], previous[1], p[0], p[1]);
        const elapsed = p[3] - previous[3];
        const candidate = distance > 250 || (elapsed > 60000 && distance > 50);
        const repaired = candidate && repairs.some((seg) => (samePoint(seg[0], previous) && samePoint(seg[seg.length - 1], p))
          || (samePoint(seg[0], p) && samePoint(seg[seg.length - 1], previous)));
        if (candidate && !repaired) {
          gaps.push({ start: previous.slice(0, 2), end: p.slice(0, 2), distance, elapsed, startSeg: previousSeg, endSeg: k, endIndex: pointIndex });
        }
      }
      previous = p; previousSeg = k;
    }
  });
  return gaps;
}
function splitTraceGap(ride, gap) {
  if (!gap || gap.startSeg !== gap.endSeg) return;
  const k = gap.endSeg, i = gap.endIndex, seg = ride.segs[k];
  if (!seg || i <= 0 || i >= seg.length) return;
  // Remove only the invented connecting edge, retaining every GPS point/time.
  ride.segs.splice(k, 1, seg.slice(0, i), seg.slice(i));
  ride.manual = (ride.manual || []).map((index) => index > k ? index + 1 : index);
  for (const field of ['taps', 'traceMethods']) if (ride[field]) {
    const shifted = {};
    for (const [index, value] of Object.entries(ride[field])) shifted[+index > k ? +index + 1 : index] = value;
    ride[field] = shifted;
  }
  for (const part of ride.parts || []) { if (part.from > k) part.from++; if (part.to > k) part.to++; }
}

// ---------- edit sheet for one ride ----------
function editRide(t) {
  const manual = (t.manual || []).filter((i) => t.segs[i]);
  const gaps = recordingGaps(t);
  const rows = manual.map((i, n) => `<div class="edit-sec"><span>Section ${n + 1} · ${fmtMi(segMeters(t.segs[i]))}</span>
      <button class="ghost" data-a="fix" data-i="${i}">Fix</button><button class="ghost danger" data-a="del" data-i="${i}">Delete</button></div>`).join('');
  $('#ride-edit-body').innerHTML = `<h3>${esc(t.name)}</h3>
    <p class="hint">Fill a missed section with the path you actually rode. Follow mapped trails, or draw by hand if the trail is missing. Preview the whole line before saving. Added sections count toward distance and trail progress, but do not invent GPS times or speed.</p>
    <button class="primary" data-a="add">Add a missed section</button>
    ${gaps.length ? `<h4>Possible recording gaps</h4><p class="hint">These endpoints are recorded positions, not a known route. Pick a gap, then adjust the preview to match where you rode.</p>${gaps.map((gap, i) => `<button class="ghost" data-a="gap" data-i="${i}">Fill gap ${i + 1} · ${fmtMi(gap.distance)} between endpoints</button>`).join('')}` : ''}
    ${manual.length ? `<h4>Added by hand</h4>${rows}<p class="hint">Fix lets you drag the dots to move the line onto the right trail.</p>` : ''}
    ${window.mergeEditHtml ? mergeEditHtml(t) : ''}`;
  $('#ride-edit-body').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const a = b.dataset.a, i = +b.dataset.i;
    if (window.mergeEditClick && await mergeEditClick(t, a, i)) return;
    if (a === 'add') startTrace(t);
    if (a === 'gap' && gaps[i]) startTrace(t, null, null, gaps[i]);
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
  if (t.traceMethods) {
    const methods = {};
    for (const [k, v] of Object.entries(t.traceMethods)) if (+k !== i) methods[+k > i ? +k - 1 : k] = v;
    t.traceMethods = methods;
  }
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
async function startTrace(ride, fix = null, pick = null, gap = null) {
  if (trace.saving) return toast('Wait for this section to finish saving.');
  let graphReady = true;
  try { await loadGraph(); } catch {
    if (pick) return toast('Could not load the trail network');
    graphReady = false; toast('Trail network unavailable. Draw the missing path by hand.');
  }
  trace.on = true; trace.ride = ride; trace.fix = fix; trace.pts = []; trace.legs = []; trace.hist = [];
  trace.mode = pick ? 'pick' : 'ride';
  trace.method = graphReady ? (ride && fix != null && ride.traceMethods && ride.traceMethods[fix]) || 'trails' : 'draw';
  trace.gap = gap;
  trace.saving = false;
  trace.pick = pick && pick !== true ? pick : null; // editing a ride picked earlier
  if (trace.layer) map.removeLayer(trace.layer);
  trace.layer = L.layerGroup().addTo(map);
  closeSheets();
  document.body.classList.add('tracing');
  $('#trace-bar').hidden = false;
  let fitPoints = null;
  if (ride && fix != null) {
    // show the ride without the section being fixed; the section comes back as draggable dots
    hideTrack(ride.id);
    showTrack({ ...ride, segs: ride.segs.filter((_, i) => i !== fix) }, false);
    // a copy: dragging dots must not touch the saved ones unless you tap Save
    trace.pts = ((ride.taps && ride.taps[fix]) || dotsFromSeg(ride.segs[fix])).map((p) => p.slice());
    for (let i = 1; i < trace.pts.length; i++) trace.legs.push(traceLeg(trace.pts[i - 1], trace.pts[i]));
    fitPoints = ride.segs[fix].map((p) => [p[0], p[1]]);
  } else if (gap && ride) {
    showTrack(ride, false);
    trace.pts = [gap.start.slice(), gap.end.slice()];
    trace.legs = [traceLeg(...trace.pts)];
    fitPoints = trace.pts;
  } else if (ride) {
    showTrack(ride, true); // see what was recorded, so you can trace up to where it starts or ends
  } else if (trace.pick) {
    trace.pts = trace.pick.dots.slice();
    for (let i = 1; i < trace.pts.length; i++) trace.legs.push(traceLeg(trace.pts[i - 1], trace.pts[i]));
  }
  drawTrace();
  if (fitPoints && fitPoints.length) map.fitBounds(L.latLngBounds(fitPoints), {
    paddingTopLeft: [35, ($('#trace-bar').offsetHeight || 160) + 30], paddingBottomRight: [85, 50], maxZoom: 15,
  });
}
function endTrace() {
  if (trace.saving) return;
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
  if (trace.mode === 'ride' && trace.method === 'draw') return { ...straight, manual: true };
  const direct = hav(a[0], a[1], b[0], b[1]);
  const snap = traceSnapM();
  const previousRouteAny = ROUTE_ANY;
  ROUTE_ANY = trace.mode === 'ride';
  try {
    // At overlapping trails, the closest edge can be an isolated fragment.
    // Consider nearby connected edges, while keeping both taps within reach.
    let S, T;
    if (trace.mode === 'ride') {
      const A = candidates(a[0], a[1], snap).filter((p) => p.d <= snap);
      const B = candidates(b[0], b[1], snap).filter((p) => p.d <= snap);
      const comp = components();
      let best = Infinity;
      for (const from of A) for (const to of B) {
        if (comp[G.eu[from.e]] === comp[G.eu[to.e]] && from.d + to.d < best) {
          S = from; T = to; best = from.d + to.d;
        }
      }
    } else {
      S = candidates(a[0], a[1], 0)[0]; T = candidates(b[0], b[1], 0)[0];
    }
    const unresolved = trace.mode === 'ride' ? { ...straight, unresolved: true } : straight;
    if (!S || !T || S.d > snap || T.d > snap) return unresolved;
    const sol = solve(S, T);
    if (!sol.endVia) return unresolved;
    const path = assemble(S, T, sol).flatMap((l) => l.coords);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += hav(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (!path.length) return unresolved;
    // A long loop can be the actual path ridden: show it for review rather than
    // silently replacing it with a shortcut. Keep conservative planning behavior.
    if (trace.mode === 'pick' && len > direct * TRACE_DETOUR + 1600) return straight;
    return { coords: trace.mode === 'ride' ? [a, ...path, b] : path };
  } finally {
    ROUTE_ANY = previousRouteAny;
  }
}
function remember() { trace.hist.push({ pts: trace.pts.map((p) => p.slice()), legs: trace.legs.slice(), method: trace.method }); }
function warnStraight(legs) {
  if (trace.mode === 'ride') {
    if (legs.some((leg) => leg.unresolved)) toast('No connected trail between these points. Add points closer to the trail, or choose Draw by hand.');
    return;
  }
  if (legs.some((l) => l && l.straight)) toast(trace.mode === 'pick' ? 'No trail your machine can ride there, so it drew a straight line. Undo, or drag the dot onto a trail.'
    : 'No trail there, so it drew a straight line. Undo, or drag the dot right onto the trail.');
}
window.traceAdd = (latlng) => {
  if (trace.saving) return;
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
  if (trace.saving) return;
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
  if (trace.saving) return;
  remember();
  trace.pts.splice(leg + 1, 0, p);
  const a = traceLeg(trace.pts[leg], p), b = traceLeg(p, trace.pts[leg + 2]);
  trace.legs.splice(leg, 1, a, b);
  warnStraight([a, b]);
  drawTrace();
}
function removeDot(i) {
  if (trace.saving) return;
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
function traceMidpoint(coords) {
  let remaining = segMeters(coords) / 2;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i], length = hav(a[0], a[1], b[0], b[1]);
    if (length > 0 && remaining <= length) {
      const f = remaining / length;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    remaining -= length;
  }
  return coords[0];
}
function drawTrace() {
  trace.layer.clearLayers();
  for (const leg of trace.legs) {
    L.polyline(leg.coords, { renderer: planRenderer, color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(trace.layer);
    L.polyline(leg.coords, { renderer: planRenderer, color: leg.unresolved ? '#ff6b6b' : '#ff2fd0', weight: 5, dashArray: leg.straight ? '6 6' : null, interactive: false }).addTo(trace.layer);
  }
  // hollow handle halfway along each leg; drag it to bend the line onto another trail.
  // Skipped on legs too short on screen, where it would sit on top of a dot (zoom in to get it).
  trace.legs.forEach((leg, k) => {
    const c = leg.coords;
    if (map.latLngToContainerPoint(trace.pts[k]).distanceTo(map.latLngToContainerPoint(trace.pts[k + 1])) < 64) return;
    const mid = traceMidpoint(c);
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
  const unresolved = trace.legs.filter((leg) => leg.unresolved).length;
  $('#trace-method').hidden = trace.mode === 'pick';
  $('#btn-trace-trails').setAttribute('aria-pressed', trace.method === 'trails');
  $('#btn-trace-draw').setAttribute('aria-pressed', trace.method === 'draw');
  $('#btn-trace-save').textContent = trace.mode === 'pick' ? 'Done' : trace.saving ? 'Saving…' : 'Save full section';
  ['#btn-trace-trails', '#btn-trace-draw', '#btn-trace-cancel'].forEach((id) => { $(id).disabled = trace.saving; });
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
      : unresolved ? `${fmtMi(traceMeters())} between points · path not connected`
        : `${fmtMi(traceMeters())} preview · Save full section`;
  $('#trace-sub').textContent = unresolved ? `${unresolved} unconnected stretch(es) in red. Add points or switch to Draw by hand.`
    : trace.method === 'draw' ? 'Draw the actual path with more taps · dashed pink is added by hand'
    : n === 1 ? 'It follows the trails between your taps'
    : n >= 2 ? 'Drag a dot to move it · tap a dot to remove it'
      : trace.ride ? `Adding to "${trace.ride.name}"` : 'Tracing a new ride';
  $('#btn-trace-undo').disabled = !trace.hist.length || trace.saving;
  $('#btn-trace-save').disabled = n < 2 || unresolved > 0 || trace.saving;
}
function setTraceMethod(method) {
  if (!trace.on || trace.mode !== 'ride' || trace.saving || method === trace.method) return;
  if (method === 'trails' && !G) return toast('Trail network unavailable. Keep drawing by hand, or reconnect and reopen the editor.');
  remember(); trace.method = method;
  trace.legs = trace.pts.slice(1).map((p, i) => traceLeg(trace.pts[i], p));
  warnStraight(trace.legs); drawTrace();
}
$('#btn-trace-trails').addEventListener('click', () => setTraceMethod('trails'));
$('#btn-trace-draw').addEventListener('click', () => setTraceMethod('draw'));
$('#btn-trace-undo').addEventListener('click', () => {
  if (trace.saving) return;
  const h = trace.hist.pop();
  if (!h) return;
  trace.pts = h.pts; trace.legs = h.legs; trace.method = h.method;
  drawTrace();
});
$('#btn-trace-cancel').addEventListener('click', endTrace);
$('#btn-trace-save').addEventListener('click', async () => {
  if (trace.pts.length < 2 || trace.saving || trace.legs.some((leg) => leg.unresolved)) return;
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
  // Work on a copy: a failed save must not mutate the displayed/saved ride.
  let ride = trace.ride ? JSON.parse(JSON.stringify(trace.ride)) : null;
  const now = Date.now();
  if (!ride) {
    const name = prompt('Name this ride', 'Ride ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    if (name === null) return;
    ride = { id: 't' + now, name: (name.trim() || 'Ride').slice(0, 80), start: now, end: now, segs: [], done: true, manual: [] };
  }
  const stamp = ride.start || now;
  if (trace.gap) splitTraceGap(ride, trace.gap);
  const seg = pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6), null, stamp]);
  const fixing = !!trace.ride && trace.fix != null;
  const idx = fixing ? trace.fix : ride.segs.length;
  ride.segs[idx] = seg;
  if (!fixing) ride.manual = [...(ride.manual || []), idx];
  ride.taps = { ...(ride.taps || {}), [idx]: trace.pts.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)]) };
  ride.traceMethods = { ...(ride.traceMethods || {}), [idx]: trace.method };
  trace.saving = true; updateTraceBar();
  try { await putTrack(ride); }
  catch { trace.saving = false; updateTraceBar(); toast('Could not save this section. Your preview and original ride are still here. Free space and retry.'); return; }
  trace.saving = false;
  if (trace.ride) { Object.assign(trace.ride, ride); ride = trace.ride; }
  const added = traceMeters();
  endTrace();
  refreshShownTrack(ride);
  renderList();
  toast(fixing ? `Section fixed (${fmtMi(added)})` : `Added ${fmtMi(added)} to "${ride.name}"`);
});

$('#btn-trace-new').addEventListener('click', () => startTrace(null));

'use strict';
// Ride recording: shares the GPS watch from app.js, stores rides in IndexedDB, exports GPX.

const TRACK_COLOR = '#ff2fd0';
const MIN_MOVE_M = 4;       // ignore GPS jitter smaller than this
const MAX_ACC_M = 40;       // ignore fixes worse than this

// ---------- storage ----------
const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('orv', 3);
  req.onupgradeneeded = () => {
    for (const name of ['tracks', 'waypoints', 'photos']) {
      if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn, store = 'tracks') {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const putTrack = (t) => tx('readwrite', (s) => s.put(t));
const delTrack = (id) => tx('readwrite', (s) => s.delete(id));
const allTracks = () => tx('readonly', (s) => s.getAll());

// ---------- math ----------
function meters(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function stats(t) {
  let m = 0, ms = 0, recM = 0, addedM = 0;
  const manual = new Set(t.manual || []);
  t.segs.forEach((seg, k) => {
    let segM = 0;
    for (let i = 1; i < seg.length; i++) segM += meters(seg[i - 1], seg[i]);
    m += segM;
    if (manual.has(k)) { addedM += segM; return; } // traced by hand: miles, but no time
    recM += segM;
    if (seg.length > 1) ms += seg[seg.length - 1][3] - seg[0][3];
  });
  return { mi: m / 1609.344, ms, mph: ms > 0 ? (recM / 1609.344) / (ms / 3600000) : 0, addedMi: addedM / 1609.344 };
}
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// ---------- recording ----------
let rec = null;          // { id, name, start, segs, done:false, paused }
let recLine = null;
let wakeLock = null;
let saveT = null;
let tickT = null;

window.isRecording = () => !!rec;
// first recorded point of this ride (where the truck is, usually)
window.rideStartPoint = () => { const p = rec && rec.segs.find((s) => s.length); return p ? p[0] : null; };

function recLatLngs() { return rec.segs.map((s) => s.map((p) => [p[0], p[1]])); }
function drawRec() {
  if (!rec) { if (recLine) { map.removeLayer(recLine); recLine = null; } return; }
  if (!recLine) recLine = L.polyline([], { renderer, color: TRACK_COLOR, weight: 5, opacity: 0.9, interactive: false }).addTo(map);
  recLine.setLatLngs(recLatLngs());
  recLine.bringToFront();
}
function saveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (rec) putTrack(rec).catch(() => {}); }, 3000);
}

// live speed for the dashboard: the phone's own GPS speed when it gives one, else from the last two fixes
const MOVING_MS = 0.9; // slower than this counts as stopped (same as ride details)
let live = { mph: null, at: 0, prev: null };
window.onTrackPos = (pos) => {
  const { latitude: la, longitude: ln, speed } = pos.coords;
  const prev = live.prev;
  let mps = speed != null && speed >= 0 ? speed : null;
  if (mps == null && prev && pos.timestamp - prev.t > 0) mps = meters([prev.lat, prev.lng], [la, ln]) / ((pos.timestamp - prev.t) / 1000);
  live = { mph: mps == null ? null : mps * 2.23694, at: Date.now(), prev: { lat: la, lng: ln, t: pos.timestamp } };
  if (!rec || rec.paused) return;
  const { latitude, longitude, accuracy, altitude } = pos.coords;
  if (accuracy > MAX_ACC_M) return;
  const p = [+latitude.toFixed(6), +longitude.toFixed(6), altitude == null ? null : Math.round(altitude * 10) / 10, pos.timestamp];
  const seg = rec.segs[rec.segs.length - 1];
  const last = seg[seg.length - 1];
  if (last && meters(last, p) < MIN_MOVE_M) return;
  if (last && p[3] - last[3] < 60000 && meters(last, p) / ((p[3] - last[3]) / 1000) > MOVING_MS) rec.moveMs = (rec.moveMs || 0) + (p[3] - last[3]);
  seg.push(p);
  if (recLine) recLine.addLatLng([p[0], p[1]]); else drawRec();
  saveSoon();
};

async function lockScreen() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
function unlockScreen() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec && !rec.paused) lockScreen();
  if (document.visibilityState === 'hidden' && rec) putTrack(rec).catch(() => {});
});

function startRec() {
  const now = Date.now();
  rec = { id: 't' + now, name: 'Ride ' + fmtDate(now), start: now, segs: [[]], done: false, paused: false };
  putTrack(rec);
  ensureGps();
  lockScreen();
  refreshRecUi();
  toast('Recording. Keep the app open. The screen will stay on.');
  if (window.offerStartPhoto) offerStartPhoto();
}
function pauseRec() {
  rec.paused = true; putTrack(rec); unlockScreen(); refreshRecUi();
}
function resumeRec() {
  rec.paused = false; rec.segs.push([]); putTrack(rec); ensureGps(); lockScreen(); refreshRecUi();
}
async function stopRec() {
  const s = stats(rec);
  rec.segs = rec.segs.filter((seg) => seg.length);
  rec.paused = false;
  if (!rec.segs.length || s.mi < 0.01) {
    if (!confirm('This ride has almost no distance. Save it anyway?')) {
      $('#photo-bar').hidden = true;
      await delTrack(rec.id); rec = null; drawRec(); unlockScreen(); refreshRecUi(); renderList(); return;
    }
  }
  rec.done = true; rec.end = Date.now();
  await putTrack(rec);
  const saved = rec;
  rec = null; drawRec(); unlockScreen();
  showTrack(saved, false);
  refreshRecUi(); renderList();
  $('#photo-bar').hidden = true;
  if (window.offerEndPhoto) offerEndPhoto(saved, s.mi); else toast(`Saved: ${s.mi.toFixed(1)} mi`);
}

function ensureGps() {
  if (watchId === null) locBtn.click();
}

// ---------- UI ----------
const recBtn = $('#btn-rec');
const recBar = $('#rec-bar');

function refreshRecUi() {
  refreshRideActions();
  recBtn.classList.toggle('rec', !!rec && !rec.paused);
  recBtn.classList.toggle('paused', !!rec && rec.paused);
  recBar.hidden = !rec;
  const c = $('#rec-controls');
  if (!rec) {
    c.innerHTML = '<button class="primary" data-a="start">Start recording</button>';
  } else {
    c.innerHTML = `<div class="rec-row">
      <button class="ghost" data-a="${rec.paused ? 'resume' : 'pause'}">${rec.paused ? 'Resume' : 'Pause'}</button>
      <button class="primary stop" data-a="stop">Stop &amp; save</button></div>`;
  }
  tickRec();
  clearInterval(tickT);
  if (rec) tickT = setInterval(tickRec, 1000);
}
const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function drawDash(s) {
  const dash = $('#ride-dash');
  dash.hidden = !rec;
  if (!rec) return;
  const fresh = live.mph != null && Date.now() - live.at < 8000 && !rec.paused;
  $('#dash-speed').textContent = rec.paused ? '–' : fresh ? Math.round(live.mph < 1 ? 0 : live.mph) : '–';
  $('#dash-mi').textContent = s.mi < 100 ? s.mi.toFixed(1) : s.mi.toFixed(0);
  const mm = Math.floor((rec.moveMs || 0) / 60000);
  $('#dash-time').textContent = mm < 60 ? `${mm}m` : `${Math.floor(mm / 60)}h ${mm % 60}m`;
  const start = window.rideStartPoint && rideStartPoint(), here = meMarker && meMarker.getLatLng();
  if (start && here) {
    const mi = meters(start, [here.lat, here.lng]) / 1609.344;
    const y = Math.sin((start[1] - here.lng) * Math.PI / 180) * Math.cos(start[0] * Math.PI / 180);
    const x = Math.cos(here.lat * Math.PI / 180) * Math.sin(start[0] * Math.PI / 180) - Math.sin(here.lat * Math.PI / 180) * Math.cos(start[0] * Math.PI / 180) * Math.cos((start[1] - here.lng) * Math.PI / 180);
    const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    $('#dash-truck').textContent = mi < 0.1 ? 'here' : mi < 10 ? mi.toFixed(1) : mi.toFixed(0);
    $('#dash-truck-dir').textContent = mi < 0.1 ? 'truck' : `mi ${DIRS8[Math.round(brg / 45) % 8]} to truck`;
  } else { $('#dash-truck').textContent = '–'; $('#dash-truck-dir').textContent = 'to truck'; }
}
// moving time for a ride already in progress (after the app reopens)
function movingMs(t) {
  let ms = 0;
  for (const seg of t.segs) for (let i = 1; i < seg.length; i++) {
    const dt = seg[i][3] - seg[i - 1][3];
    if (dt > 0 && dt < 60000 && meters(seg[i - 1], seg[i]) / (dt / 1000) > MOVING_MS) ms += dt;
  }
  return ms;
}
function tickRec() {
  if (!rec) { $('#rec-live').textContent = ''; drawDash(); return; }
  const s = stats(rec);
  // include time since the last fix so the clock keeps moving while stopped
  const seg = rec.segs[rec.segs.length - 1];
  const live = !rec.paused && seg.length ? Date.now() - seg[seg.length - 1][3] : 0;
  const txt = `${s.mi.toFixed(2)} mi · ${fmtDur(s.ms + Math.max(0, live))}`;
  recBar.querySelector('span').textContent = txt + (rec.paused ? ' · paused' : '');
  drawDash(s);
  recBar.classList.toggle('paused', rec.paused);
  $('#rec-live').textContent = (rec.paused ? 'Paused. ' : 'Recording. ') + txt;
}
$('#rec-controls').addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.a;
  if (a === 'start') startRec();
  if (a === 'pause') pauseRec();
  if (a === 'resume') resumeRec();
  if (a === 'stop') stopRec();
});
recBtn.addEventListener('click', () => { renderList(); openSheet('#panel-rides'); });

// ---------- action buttons on the map while riding ----------
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
function refreshRideActions() {
  const bar = $('#ride-actions');
  bar.hidden = !rec;
  document.body.classList.toggle('recording', !!rec);
  if (!rec) return;
  const b = bar.querySelector('.ra-pause');
  b.classList.toggle('resume', rec.paused);
  b.innerHTML = (rec.paused ? PLAY_SVG : PAUSE_SVG) + `<span>${rec.paused ? 'Resume' : 'Pause'}</span>`;
}
function hereNow() {
  if (meMarker) return meMarker.getLatLng();
  const seg = rec && rec.segs.flat();
  const p = seg && seg[seg.length - 1];
  return p ? L.latLng(p[0], p[1]) : null;
}
const timeNow = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
async function dropWaypoint(type, name, extra) {
  const at = hereNow();
  if (!at) { ensureGps(); toast('Waiting for GPS. Try again in a few seconds.'); return null; }
  const wp = { id: 'w' + Date.now(), lat: +at.lat.toFixed(6), lng: +at.lng.toFixed(6), name, type, note: rec ? `On ${rec.name}` : '', ...(rec ? { rideId: rec.id } : {}), ...(extra || {}) };
  await tx('readwrite', (s) => s.put(wp), 'waypoints');
  if (window.loadWaypoints) await loadWaypoints();
  return wp;
}
// Pause/Resume needs a short hold (about half a second) so a bump doesn't flip it; the button fills while held.
const HOLD_MS = 500;
let holdT = null, holdDone = false;
const pauseBtn = $('#ride-actions .ra-pause');
function holdEnd() { clearTimeout(holdT); holdT = null; pauseBtn.classList.remove('holding'); }
pauseBtn.addEventListener('pointerdown', (e) => {
  if (!rec) return;
  holdDone = false;
  pauseBtn.classList.add('holding');
  holdT = setTimeout(() => {
    holdEnd();
    holdDone = true;
    if (navigator.vibrate) navigator.vibrate(40);
    if (rec.paused) { resumeRec(); toast('Recording again'); } else { pauseRec(); toast('Paused. Hold Resume when you ride again.'); }
  }, HOLD_MS);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) pauseBtn.addEventListener(ev, () => { if (holdT) holdEnd(); });
pauseBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // a held finger shouldn't open the phone's menu
$('#ride-actions').addEventListener('click', async (e) => {
  const a = e.target.closest('button')?.dataset.a;
  if (!a || !rec) return;
  if (a === 'pause' && !holdDone) toast(`Hold the button to ${rec.paused ? 'resume' : 'pause'}`);
  if (a === 'mark') showMarkMenu();
  if (a === 'camp') {
    if (!confirm('Stop for the night? This pauses the ride and saves a camp spot here. Tap Resume in the morning, even if the app was closed.')) return;
    const wp = await dropWaypoint('camp', 'Camp ' + fmtDate(Date.now()));
    if (!wp) return;
    rec.camps = [...(rec.camps || []), { lat: wp.lat, lng: wp.lng, t: Date.now() }];
    if (!rec.paused) pauseRec(); else putTrack(rec);
    toast('Camp saved and ride paused. Sleep well.');
  }
  if (a === 'sos') showSOS();
});
recBar.addEventListener('click', () => { renderList(); openSheet('#panel-rides'); });

// ---------- saved rides ----------
const shownTracks = new Map();

function showTrack(t, fit = true) {
  if (!shownTracks.has(t.id)) {
    const line = L.polyline(t.segs.map((s) => s.map((p) => [p[0], p[1]])), { renderer, color: TRACK_COLOR, weight: 5, opacity: 0.85 })
      .on('click', (e) => { L.DomEvent.stop(e); if (window.traceMode && traceMode()) return traceAdd(e.latlng); renderList(); openSheet('#panel-rides'); });
    const group = L.featureGroup([line]);
    // a merged ride: a white dot where each original ride starts, so you can see where they join
    (t.parts || []).slice(1).forEach((p) => {
      const s = t.segs[p.from], pt = s && s[0];
      if (pt) L.circleMarker([pt[0], pt[1]], { renderer, radius: 6, color: TRACK_COLOR, weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(group);
    });
    group.addTo(map);
    shownTracks.set(t.id, group);
  }
  const b = shownTracks.get(t.id).getBounds();
  if (fit && b.isValid()) map.fitBounds(b, { padding: [40, 40] });
}
function hideTrack(id) {
  const l = shownTracks.get(id);
  if (l) { map.removeLayer(l); shownTracks.delete(id); }
}

async function renderList() {
  const list = $('#ride-list');
  const rides = (await allTracks().catch(() => [])).filter((t) => t.done).sort((a, b) => b.start - a.start);
  if (!rides.length) { list.innerHTML = '<p class="hint">No saved rides yet.</p>'; return; }
  list.innerHTML = rides.map((t) => {
    const s = stats(t);
    const on = shownTracks.has(t.id);
    return `<div class="ride" data-id="${esc(t.id)}">
      <div class="ride-top" data-a="details"><b>${esc(t.name)}</b><small>${s.mi.toFixed(1)} mi · ${fmtDur(s.ms)}${s.mph ? ' · ' + s.mph.toFixed(0) + ' mph avg' : ''}${s.addedMi > 0.05 ? ` · ${s.addedMi.toFixed(1)} mi added by hand` : ''}</small></div>
      <div class="ride-btns">
        <button data-a="${on ? 'hide' : 'show'}">${on ? 'Hide' : 'Show'}</button>
        <button data-a="gpx">GPX</button>
        <button data-a="edit">Edit</button>
        <button data-a="rename">Rename</button>
        <button data-a="del" class="danger">Delete</button>
      </div></div>`;
  }).join('');
  list._rides = rides;
  if (window.refreshProgress) refreshProgress(); // ride list changed: update ride-every-trail progress
}
$('#btn-merge').addEventListener('click', () => window.showMergePicker && showMergePicker());
$('#ride-list').addEventListener('click', async (e) => {
  const top = e.target.closest('.ride-top');
  if (top) {
    const r = $('#ride-list')._rides.find((x) => x.id === top.closest('.ride').dataset.id);
    if (r && window.showRideDetails) showRideDetails(r);
    return;
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.ride').dataset.id;
  const t = $('#ride-list')._rides.find((r) => r.id === id);
  const a = btn.dataset.a;
  if (a === 'show') { showTrack(t); closeSheetsKeepTracks(); }
  if (a === 'hide') { hideTrack(id); renderList(); }
  if (a === 'gpx') exportGpx(t);
  if (a === 'edit') window.editRide && editRide(t);
  if (a === 'rename') {
    const n = prompt('Name this ride', t.name);
    if (n && n.trim()) { t.name = n.trim().slice(0, 80); await putTrack(t); renderList(); }
  }
  if (a === 'del') {
    if (!confirm(`Delete "${t.name}"? This can't be undone.`)) return;
    hideTrack(id); await delTrack(id); renderList();
  }
});
function closeSheetsKeepTracks() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }

// ---------- GPX ----------
function gpx(t) {
  const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const manual = new Set(t.manual || []);
  // sections traced by hand have no real timestamps, so they're written without times
  const segs = t.segs.map((seg, k) => '<trkseg>' + seg.map((p) =>
    `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}${manual.has(k) ? '' : `<time>${new Date(p[3]).toISOString()}</time>`}</trkpt>`
  ).join('') + '</trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Michigan ORV Map" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${x(t.name)}</name><time>${new Date(t.start).toISOString()}</time></metadata>
<trk><name>${x(t.name)}</name>
${segs}
</trk></gpx>`;
}
async function exportGpx(t) { return shareGpx(t.name, gpx(t)); }
async function shareGpx(title, xml) {
  const name = title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx';
  const file = new File([xml], name, { type: 'application/gpx+xml' });
  // Phones: open the share sheet (Drive, email, text, other map apps). Desktop: plain download.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- resume after the app was closed mid-ride ----------
(async () => {
  const open = (await allTracks().catch(() => [])).find((t) => !t.done);
  if (open) {
    rec = open;
    rec.paused = true;
    rec.moveMs = movingMs(rec);
    drawRec();
    toast('Your last ride is still here, paused. Hold Resume at the bottom to keep riding, or open Rides to save it.');
  }
  refreshRecUi();
})();

'use strict';
// Ride recording: shares the GPS watch from app.js, stores rides in IndexedDB, exports GPX.

const TRACK_COLOR = '#ff2fd0';
const MIN_MOVE_M = 4;       // ignore GPS jitter smaller than this
const MAX_ACC_M = 40;       // ignore fixes worse than this

// ---------- storage ----------
const db = new Promise((resolve, reject) => {
  const req = indexedDB.open('orv', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction('tracks', mode);
    const r = fn(t.objectStore('tracks'));
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
  let m = 0, ms = 0;
  for (const seg of t.segs) {
    for (let i = 1; i < seg.length; i++) m += meters(seg[i - 1], seg[i]);
    if (seg.length > 1) ms += seg[seg.length - 1][3] - seg[0][3];
  }
  return { mi: m / 1609.344, ms, mph: ms > 0 ? (m / 1609.344) / (ms / 3600000) : 0 };
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

window.onTrackPos = (pos) => {
  if (!rec || rec.paused) return;
  const { latitude, longitude, accuracy, altitude } = pos.coords;
  if (accuracy > MAX_ACC_M) return;
  const p = [+latitude.toFixed(6), +longitude.toFixed(6), altitude == null ? null : Math.round(altitude * 10) / 10, pos.timestamp];
  const seg = rec.segs[rec.segs.length - 1];
  const last = seg[seg.length - 1];
  if (last && meters(last, p) < MIN_MOVE_M) return;
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
      await delTrack(rec.id); rec = null; drawRec(); unlockScreen(); refreshRecUi(); renderList(); return;
    }
  }
  rec.done = true; rec.end = Date.now();
  await putTrack(rec);
  const saved = rec;
  rec = null; drawRec(); unlockScreen();
  showTrack(saved, false);
  refreshRecUi(); renderList();
  toast(`Saved: ${s.mi.toFixed(1)} mi`);
}

function ensureGps() {
  if (watchId === null) locBtn.click();
}

// ---------- UI ----------
const recBtn = $('#btn-rec');
const recBar = $('#rec-bar');

function refreshRecUi() {
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
function tickRec() {
  if (!rec) { $('#rec-live').textContent = ''; return; }
  const s = stats(rec);
  // include time since the last fix so the clock keeps moving while stopped
  const seg = rec.segs[rec.segs.length - 1];
  const live = !rec.paused && seg.length ? Date.now() - seg[seg.length - 1][3] : 0;
  const txt = `${s.mi.toFixed(2)} mi · ${fmtDur(s.ms + Math.max(0, live))}`;
  recBar.querySelector('span').textContent = txt + (rec.paused ? ' · paused' : '');
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
recBar.addEventListener('click', () => { renderList(); openSheet('#panel-rides'); });

// ---------- saved rides ----------
const shownTracks = new Map();

function showTrack(t, fit = true) {
  if (!shownTracks.has(t.id)) {
    const line = L.polyline(t.segs.map((s) => s.map((p) => [p[0], p[1]])), { renderer, color: TRACK_COLOR, weight: 5, opacity: 0.85 })
      .addTo(map)
      .on('click', (e) => { L.DomEvent.stop(e); renderList(); openSheet('#panel-rides'); });
    shownTracks.set(t.id, line);
  }
  if (fit) map.fitBounds(shownTracks.get(t.id).getBounds(), { padding: [40, 40] });
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
      <div class="ride-top"><b>${esc(t.name)}</b><small>${s.mi.toFixed(1)} mi · ${fmtDur(s.ms)}${s.mph ? ' · ' + s.mph.toFixed(0) + ' mph avg' : ''}</small></div>
      <div class="ride-btns">
        <button data-a="${on ? 'hide' : 'show'}">${on ? 'Hide' : 'Show'}</button>
        <button data-a="gpx">GPX</button>
        <button data-a="rename">Rename</button>
        <button data-a="del" class="danger">Delete</button>
      </div></div>`;
  }).join('');
  list._rides = rides;
}
$('#ride-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.ride').dataset.id;
  const t = $('#ride-list')._rides.find((r) => r.id === id);
  const a = btn.dataset.a;
  if (a === 'show') { showTrack(t); closeSheetsKeepTracks(); }
  if (a === 'hide') { hideTrack(id); renderList(); }
  if (a === 'gpx') exportGpx(t);
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
  const segs = t.segs.map((seg) => '<trkseg>' + seg.map((p) =>
    `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`
  ).join('') + '</trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Michigan ORV Map" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${x(t.name)}</name><time>${new Date(t.start).toISOString()}</time></metadata>
<trk><name>${x(t.name)}</name>
${segs}
</trk></gpx>`;
}
async function exportGpx(t) {
  const name = t.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.gpx';
  const file = new File([gpx(t)], name, { type: 'application/gpx+xml' });
  // Phones: open the share sheet (Drive, email, text, other map apps). Desktop: plain download.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: t.name }); return; } catch (err) { if (err.name === 'AbortError') return; }
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
    drawRec();
    toast('Your last ride was still recording. It is paused. Open Rides to resume or save it.');
  }
  refreshRecUi();
})();

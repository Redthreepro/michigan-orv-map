'use strict';
// Import GPX (trips, waypoints, rides a buddy AirDropped you) and back up / restore everything to a file.

// ---------- sharing a file ----------
async function shareFile(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (err) { if (err.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ---------- GPX import ----------
const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
const WP_TYPE_FROM = { 'camp spot': 'camp', campground: 'camp', gas: 'gas', 'gas station': 'gas', trailhead: 'trailhead', other: 'pin' };

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.nodeName !== 'gpx') return null;
  const wpts = [...doc.getElementsByTagName('wpt')].map((w) => ({
    lat: +w.getAttribute('lat'), lng: +w.getAttribute('lon'),
    name: txt(w, 'name'), note: txt(w, 'desc'), sym: txt(w, 'sym'), type: txt(w, 'type'),
  })).filter((w) => isFinite(w.lat) && isFinite(w.lng));
  const tracks = [];
  const pts = (list) => [...list].map((p) => {
    const t = Date.parse(txt(p, 'time'));
    const ele = parseFloat(txt(p, 'ele'));
    return [+(+p.getAttribute('lat')).toFixed(6), +(+p.getAttribute('lon')).toFixed(6), isFinite(ele) ? ele : null, isFinite(t) ? t : null];
  }).filter((p) => isFinite(p[0]) && isFinite(p[1]));
  for (const t of doc.getElementsByTagName('trk')) {
    const segs = [...t.getElementsByTagName('trkseg')].map((s) => pts(s.getElementsByTagName('trkpt'))).filter((s) => s.length > 1);
    if (segs.length) tracks.push({ name: txt(t, 'name'), segs });
  }
  for (const r of doc.getElementsByTagName('rte')) {
    const seg = pts(r.getElementsByTagName('rtept'));
    if (seg.length > 1) tracks.push({ name: txt(r, 'name'), segs: [seg] });
  }
  // a trip shared from this app: numbered stops + "Planned route"
  const isTrip = doc.documentElement.getAttribute('creator') === 'Michigan ORV Map'
    && tracks.some((t) => t.name === 'Planned route') && wpts.length >= 2 && wpts.every((w) => /^\d+\.\s/.test(w.name));
  return { wpts, tracks: tracks.filter((t) => !isTrip || t.name !== 'Planned route'), isTrip };
}

let pendingImport = null;
async function importGpx() {
  const file = await pickFile('.gpx,application/gpx+xml,application/octet-stream,text/xml');
  if (!file) return;
  const g = parseGpx(await file.text());
  if (!g) return toast('That file isn\'t a GPX file this app can read.');
  pendingImport = g;
  const opts = [];
  if (g.isTrip) opts.push(`<button class="primary" data-a="trip">Open as trip (${g.wpts.length} stops)</button>`);
  if (g.wpts.length && !g.isTrip) opts.push(`<button class="primary" data-a="wps">Add ${g.wpts.length} waypoint${g.wpts.length > 1 ? 's' : ''}</button>`);
  if (g.tracks.length) opts.push(`<button class="ghost" data-a="rides">Add ${g.tracks.length} ride${g.tracks.length > 1 ? 's' : ''} / track${g.tracks.length > 1 ? 's' : ''}</button>`);
  if (g.wpts.length >= 2 && !g.isTrip) opts.push(`<button class="ghost" data-a="trip">Use the ${g.wpts.length} waypoints as trip stops</button>`);
  if (!opts.length) return toast('No waypoints, tracks, or routes in that file.');
  $('#import-body').innerHTML = `<p class="hint">${esc(file.name)}</p>` + opts.join('');
  openSheet('#panel-import');
}
window.importGpx = importGpx;

$('#import-body').addEventListener('click', async (e) => {
  const a = e.target.closest('button')?.dataset.a;
  const g = pendingImport;
  if (!a || !g) return;
  if (a === 'trip') {
    if (plan && plan.stops.length > 1 && !confirm('Replace your current trip?')) return;
    plan = { stops: g.wpts.map((w) => ({ lat: w.lat, lng: w.lng, name: w.name.replace(/^\d+\.\s*/, '') || 'Stop', night: /camp/i.test(w.sym) })) };
    savePlan();
    closeSheets();
    computePlan();
    toast('Trip imported');
  }
  if (a === 'wps') {
    const now = Date.now();
    await Promise.all(g.wpts.map((w, i) => tx('readwrite', (s) => s.put({
      id: `w${now}_${i}`, lat: w.lat, lng: w.lng, name: w.name || 'Imported point', note: w.note,
      type: WP_TYPE_FROM[(w.type || w.sym).toLowerCase()] || 'pin',
    }), 'waypoints')));
    await loadWaypoints();
    closeSheets();
    toast(`${g.wpts.length} waypoint${g.wpts.length > 1 ? 's' : ''} added`);
  }
  if (a === 'rides') {
    const now = Date.now();
    for (const [i, t] of g.tracks.entries()) {
      const first = t.segs[0][0];
      const start = first[3] || now;
      // tracks without timestamps get evenly spaced fake times so distance still shows
      const segs = t.segs.map((s) => s.map((p, k) => [p[0], p[1], p[2], p[3] || start + k * 1000]));
      await putTrack({ id: `t${now}_${i}`, name: t.name || 'Imported ride', start, segs, done: true, end: now, imported: true });
    }
    closeSheets();
    renderList();
    toast(`${g.tracks.length} ride${g.tracks.length > 1 ? 's' : ''} added. See Record → Saved rides`);
  }
  pendingImport = null;
});

// ---------- backup / restore ----------
async function backupAll() {
  const rides = (await allTracks().catch(() => [])).filter((t) => t.done);
  const wps = (await tx('readonly', (s) => s.getAll(), 'waypoints').catch(() => [])) || [];
  const data = { app: 'michigan-orv-map', version: 1, made: new Date().toISOString(), rides, waypoints: wps, trip: plan,
    settings: { rig, base: baseKey, shown } };
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ok = await shareFile(`orv-map-backup-${day}.json`, JSON.stringify(data), 'application/json');
  if (ok) {
    try { localStorage.setItem('orv.lastBackup', String(Date.now())); } catch {}
    toast(`Backed up ${rides.length} ride${rides.length === 1 ? '' : 's'} and ${wps.length} waypoint${wps.length === 1 ? '' : 's'}`);
    if (window.refreshOffline) refreshOffline();
  }
}
window.backupAll = backupAll;

async function restoreAll() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That isn\'t a backup file from this app.'); }
  if (!data || data.app !== 'michigan-orv-map') return toast('That isn\'t a backup file from this app.');
  const rides = data.rides || [], wps = data.waypoints || [];
  if (!confirm(`Restore ${rides.length} ride(s) and ${wps.length} waypoint(s)? Anything with the same name/ID is replaced; nothing else is deleted.`)) return;
  for (const r of rides) await putTrack(r);
  for (const w of wps) await tx('readwrite', (s) => s.put(w), 'waypoints');
  if (data.trip && (!plan || !plan.stops.length)) { plan = data.trip; savePlan(); computePlan({ show: false }); }
  if (data.settings && [0, 50, 64, 72].includes(data.settings.rig)) setRig(data.settings.rig);
  await loadWaypoints();
  renderList();
  toast('Restored');
}

$('#btn-backup').addEventListener('click', backupAll);
$('#btn-restore').addEventListener('click', restoreAll);
document.querySelectorAll('.btn-import').forEach((b) => b.addEventListener('click', importGpx));

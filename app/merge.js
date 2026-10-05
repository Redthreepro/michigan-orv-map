'use strict';
// Merge rides into one (e.g. a weekend, or a ride recorded in pieces) and separate them again later.
// A merged ride keeps parts: [{ meta (the original ride minus its line), from, to }] = which segs came from
// which ride, so "Separate" restores the originals. Any ride can also be split at a long stop (lunch, camp night).

const LONG_STOP_MS = 45 * 60000;

// ---------- merge ----------
function showMergePicker() {
  const rides = ($('#ride-list')._rides || []).slice().sort((a, b) => a.start - b.start);
  if (rides.length < 2) return toast('You need at least two saved rides to merge.');
  $('#sheet-body').innerHTML = `<h3>Merge rides</h3>
    <p class="hint">Pick the rides to join into one, like a weekend trip. You can separate them again any time from Edit.</p>
    <div class="merge-list">${rides.map((t) => `<label class="row merge-row"><input type="checkbox" value="${esc(t.id)}">
      <span><b>${esc(t.name)}</b><small>${fmtDate(t.start)} · ${stats(t).mi.toFixed(1)} mi${t.parts ? ` · ${t.parts.length} rides joined` : ''}</small></span></label>`).join('')}</div>
    <button class="primary" data-a="merge" disabled>Merge</button>`;
  const btn = $('#sheet-body [data-a="merge"]');
  $('#sheet-body').onchange = () => {
    const n = $('#sheet-body').querySelectorAll('input:checked').length;
    btn.disabled = n < 2;
    btn.textContent = n >= 2 ? `Merge ${n} rides` : 'Merge';
  };
  $('#sheet-body').onclick = async (e) => {
    if (e.target.closest('button')?.dataset.a !== 'merge') return;
    const ids = [...$('#sheet-body').querySelectorAll('input:checked')].map((i) => i.value);
    await mergeRides(rides.filter((t) => ids.includes(t.id)));
  };
  openSheet('#sheet');
}
window.showMergePicker = showMergePicker;

async function mergeRides(list) {
  list = list.slice().sort((a, b) => a.start - b.start);
  const segs = [], manual = [], taps = {}, camps = [], parts = [];
  for (const r of list) {
    const from = segs.length;
    r.segs.forEach((s, i) => {
      segs.push(s);
      if ((r.manual || []).includes(i)) manual.push(from + i);
      if (r.taps && r.taps[i]) taps[from + i] = r.taps[i];
    });
    camps.push(...(r.camps || []));
    if (r.parts) for (const p of r.parts) parts.push({ meta: p.meta, from: from + p.from, to: from + p.to }); // merging a merged ride: keep the originals
    else {
      const { segs: _s, manual: _m, taps: _t, parts: _p, ...meta } = r;
      parts.push({ meta, from, to: segs.length });
    }
  }
  const name = prompt('Name the merged ride', list[0].name + (list.length > 1 ? ` + ${list.length - 1} more` : ''));
  if (name === null) return;
  const now = Date.now();
  const merged = { id: 't' + now, name: (name.trim() || list[0].name).slice(0, 80), start: Math.min(...list.map((r) => r.start)),
    end: Math.max(...list.map((r) => r.end || r.start)), done: true, segs, manual, taps, camps, parts };
  await putTrack(merged);
  for (const r of list) { hideTrack(r.id); await delTrack(r.id); }
  closeSheets();
  await renderList();
  showTrack(merged, true);
  toast(`Merged ${list.length} rides: ${stats(merged).mi.toFixed(1)} mi`);
}

// ---------- separate a merged ride ----------
async function separateRide(t) {
  const parts = t.parts || [];
  if (parts.length < 2) return;
  // segs added after merging (traced by hand) belong to the part whose time they fall in, else the first
  const owner = t.segs.map((s, i) => {
    const k = parts.findIndex((p) => i >= p.from && i < p.to);
    if (k >= 0) return k;
    const ts = s[0] && s[0][3];
    const j = parts.findIndex((p) => ts >= p.meta.start && ts <= (p.meta.end || p.meta.start));
    return j >= 0 ? j : 0;
  });
  const out = parts.map((p) => ({ ...p.meta, segs: [], manual: [], taps: {}, camps: [] }));
  t.segs.forEach((s, i) => {
    const r = out[owner[i]];
    if ((t.manual || []).includes(i)) r.manual.push(r.segs.length);
    if (t.taps && t.taps[i]) r.taps[r.segs.length] = t.taps[i];
    r.segs.push(s);
  });
  for (const c of t.camps || []) {
    const k = parts.findIndex((p) => c.t >= p.meta.start && c.t <= (p.meta.end || p.meta.start) + 12 * 3600000);
    out[k >= 0 ? k : out.length - 1].camps.push(c);
  }
  hideTrack(t.id);
  for (const r of out) {
    if (!r.camps.length) delete r.camps;
    if (!Object.keys(r.taps).length) delete r.taps;
    if (r.segs.length) await putTrack(r);
  }
  await delTrack(t.id);
  closeSheets();
  await renderList();
  toast(`Separated into ${out.filter((r) => r.segs.length).length} rides`);
}

// ---------- split at a long stop ----------
// long stops between recorded points (a pause, lunch, a camp night): [{ seg, idx, from, to }]
function longStops(t) {
  const manual = new Set(t.manual || []);
  const pts = [];
  t.segs.forEach((s, k) => { if (!manual.has(k)) s.forEach((p, i) => pts.push({ k, i, t: p[3] })); });
  pts.sort((a, b) => a.t - b.t);
  const out = [];
  for (let j = 1; j < pts.length; j++) if (pts[j].t - pts[j - 1].t >= LONG_STOP_MS) out.push({ at: pts[j], from: pts[j - 1].t, to: pts[j].t });
  return out;
}
const durText = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
function stopLabel(s) {
  const a = new Date(s.from), b = new Date(s.to);
  const overnight = a.toDateString() !== b.toDateString();
  const time = a.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return overnight ? `Overnight stop (${a.toLocaleDateString(undefined, { weekday: 'short' })} ${time})` : `${durText(s.to - s.from)} stop at ${time}`;
}
async function splitAt(t, cutTime) {
  const a = { ...t, id: t.id, segs: [], manual: [], taps: {} }, b = { ...t, id: 't' + Date.now(), segs: [], manual: [], taps: {} };
  delete a.parts; delete b.parts; // splitting a merged ride by time: its part list no longer applies
  t.segs.forEach((s, k) => {
    const isManual = (t.manual || []).includes(k);
    const before = s.filter((p) => p[3] < cutTime), after = s.filter((p) => p[3] >= cutTime);
    for (const [r, part] of [[a, before], [b, after]]) {
      if (!part.length) continue;
      if (isManual) r.manual.push(r.segs.length);
      if (isManual && t.taps && t.taps[k] && part.length === s.length) r.taps[r.segs.length] = t.taps[k];
      r.segs.push(part);
    }
  });
  const first = (r) => Math.min(...r.segs.flat().map((p) => p[3]));
  const last = (r) => Math.max(...r.segs.flat().map((p) => p[3]));
  a.end = last(a); b.start = first(b); b.end = t.end;
  const overnight = new Date(a.end).toDateString() !== new Date(b.start).toDateString();
  a.name = `${t.name} (${overnight ? 'day 1' : 'part 1'})`.slice(0, 80);
  b.name = `${t.name} (${overnight ? 'day 2' : 'part 2'})`.slice(0, 80);
  a.camps = (t.camps || []).filter((c) => c.t < cutTime); b.camps = (t.camps || []).filter((c) => c.t >= cutTime);
  for (const r of [a, b]) { if (!r.camps.length) delete r.camps; if (!Object.keys(r.taps).length) delete r.taps; }
  hideTrack(t.id);
  await putTrack(a); await putTrack(b);
  closeSheets();
  await renderList();
  toast(`Split into "${a.name}" and "${b.name}". Merge them back any time.`);
}

// ---------- in the ride's Edit sheet ----------
// Extra rows for edit.js: the rides a merged ride is made of, and long stops to split at.
function mergeEditHtml(t) {
  let html = '';
  if (t.parts && t.parts.length > 1) {
    html += `<h4>Joined from ${t.parts.length} rides</h4>` + t.parts.map((p) => {
      let m = 0;
      for (let i = p.from; i < p.to && i < t.segs.length; i++) for (let j = 1; j < t.segs[i].length; j++) m += meters(t.segs[i][j - 1], t.segs[i][j]);
      return `<div class="edit-sec"><span>${esc(p.meta.name)} · ${fmtDate(p.meta.start)} · ${(m / 1609.344).toFixed(1)} mi</span></div>`;
    }).join('') + '<button class="ghost" data-a="separate">Separate them again</button>';
  }
  const stops = longStops(t);
  if (stops.length) {
    html += '<h4>Split at a long stop</h4>' + stops.map((s, i) => `<div class="edit-sec"><span>${esc(stopLabel(s))}</span>
      <button class="ghost" data-a="split" data-i="${i}">Split here</button></div>`).join('');
  }
  return html;
}
async function mergeEditClick(t, a, i) {
  if (a === 'separate') {
    if (confirm(`Separate "${t.name}" back into ${t.parts.length} rides?`)) await separateRide(t);
    return true;
  }
  if (a === 'split') {
    const s = longStops(t)[i];
    if (s && confirm(`Split "${t.name}" into two rides at the ${stopLabel(s).toLowerCase()}?`)) await splitAt(t, s.to);
    return true;
  }
  return false;
}
window.mergeEditHtml = mergeEditHtml;
window.mergeEditClick = mergeEditClick;

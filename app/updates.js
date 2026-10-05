'use strict';
// DNR trail updates: the nightly data build compares tonight's DNR trails to last night's and keeps
// 60 days of changes in data/changes.json (closed, reopened, new, removed, reroutes, status/width changes).
// New ones show as a chip at the top; ones that touch your trip or selected trails are called out.

let updates = [];
const UPD_LABEL = {
  closed: ['Closed', 'closed'], reopened: ['Reopened', 'open'], new: ['New trail', 'open'], removed: ['Removed from DNR map', 'kind'],
  reroute: ['Reroute', 'reroute'], 'reroute-end': ['Reroute ended', 'open'], status: ['Status changed', 'reroute'],
  width: ['Width rule changed', 'reroute'], bulk: ['DNR data refresh', 'kind'],
};
const HURTS = new Set(['closed', 'removed', 'reroute', 'status', 'width']);

async function loadUpdates() {
  try {
    const r = await fetch('data/changes.json');
    updates = r.ok ? await r.json() : [];
  } catch { updates = []; }
  if (!Array.isArray(updates)) updates = [];
  updates.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  const newest = updates[0] ? updates[0].d : '';
  // first time: start counting from now, rather than calling 60 days of history "new"
  if (store.get('updSeen', null) === null) store.set('updSeen', newest);
  refreshUpdChip();
}

// bounds of what you're planning: the trip on the map and the selected trails / picked rides
function myPlanBounds() {
  const out = [];
  if (typeof planLegs !== 'undefined') for (const r of planLegs) if (r.path && r.path.length) out.push(['Your trip', L.latLngBounds(r.path)]);
  for (const it of (typeof selItems !== 'undefined' ? selItems : [])) {
    const b = it.lines ? L.latLngBounds(it.lines.flat()) : (() => { const fs = featsFor(it); return fs.length ? L.geoJSON({ type: 'FeatureCollection', features: fs }).getBounds() : null; })();
    if (b && b.isValid()) out.push([it.dots ? 'Your picked ride' : 'Your selection', b]);
  }
  return out;
}
function touches(c, mine) {
  if (!c.b || !HURTS.has(c.k)) return null;
  const cb = L.latLngBounds([c.b[0], c.b[1]], [c.b[2], c.b[3]]).pad(0.2);
  const hit = mine.find(([, b]) => b.intersects(cb));
  return hit ? hit[0] : null;
}

function refreshUpdChip() {
  const seen = store.get('updSeen', '');
  const fresh = updates.filter((c) => c.d > seen);
  const bar = $('#upd-bar');
  bar.hidden = !fresh.length;
  if (!fresh.length) return;
  const mine = myPlanBounds();
  const hit = fresh.find((c) => touches(c, mine));
  bar.classList.toggle('alert', !!hit);
  bar.querySelector('span').textContent = hit ? `${touches(hit, mine)}: ${hit.n} ${UPD_LABEL[hit.k][0].toLowerCase()}`
    : `${fresh.length} DNR trail update${fresh.length > 1 ? 's' : ''}`;
}
$('#upd-bar').addEventListener('click', showUpdates);

function updRow(c, i, mine) {
  const [label, cls] = UPD_LABEL[c.k] || [c.k, 'kind'];
  const lim = (v) => (v == null ? '?' : limLabel(v) || v);
  const detail = c.k === 'status' ? `${esc(c.from || '?')} → ${esc(c.to || '?')}`
    : c.k === 'width' ? `${esc(lim(c.from))} → ${esc(lim(c.to))}` : '';
  const near = touches(c, mine);
  const sub = [c.co ? esc(c.co) + ' County' : '', c.mi ? c.mi + ' mi' : '', detail].filter(Boolean).join(' · ');
  return `<li class="upd" data-i="${i}"><span class="tag ${cls}">${label}</span>${near ? `<span class="tag closed">${esc(near)}</span>` : ''}
    <b>${esc(c.n)}</b>${sub ? `<small>${sub}</small>` : ''}</li>`;
}
function showUpdates() {
  const mine = myPlanBounds();
  const fmtDay = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  let html = '<h3>DNR trail updates</h3>';
  if (!updates.length) html += '<p class="hint">No changes in the last 60 days. The map checks the DNR every night.</p>';
  const hits = updates.map((c, i) => [c, i]).filter(([c]) => touches(c, mine));
  if (hits.length) html += '<h2>Affects your plans</h2><ul class="along upd-list">' + hits.map(([c, i]) => updRow(c, i, mine)).join('') + '</ul>';
  let day = null, open = false;
  updates.forEach((c, i) => {
    if (c.d !== day) {
      if (open) html += '</ul>';
      html += `<h2>${fmtDay(c.d)}</h2><ul class="along upd-list">`;
      day = c.d; open = true;
    }
    html += updRow(c, i, mine);
  });
  if (open) html += '</ul>';
  html += '<p class="hint">Tap one to see where it is. Closed trails show red on the map and trip routes avoid them.</p>';
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = (e) => {
    const li = e.target.closest('.upd');
    if (!li) return;
    const c = updates[+li.dataset.i];
    if (!c || !c.b) return;
    const b = L.latLngBounds([c.b[0], c.b[1]], [c.b[2], c.b[3]]);
    closeSheets();
    map.fitBounds(b.pad(0.5), { maxZoom: 14 });
    // a box around it for a few seconds so it's easy to spot
    const box = L.rectangle(b.pad(0.15), { renderer: planRenderer, color: '#ffd400', weight: 3, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    setTimeout(() => map.removeLayer(box), 8000);
  };
  openSheet('#sheet');
  if (updates[0]) store.set('updSeen', updates[0].d);
  refreshUpdChip();
}
window.showUpdates = showUpdates;
window.refreshUpdChip = refreshUpdChip;
$('#btn-updates').addEventListener('click', showUpdates);

loadUpdates();

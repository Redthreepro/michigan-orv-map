'use strict';
// Selected trails stay highlighted after you close their info, so you can plan with them on the map.
// Select several to see each one's miles and the total, or pick just the part you'll ride (tap points;
// it follows the trails between them, so which loop or cross-over you take is your call).
// Ride times assume 17-20 mph.

const RIDE_MPH = [17, 20];
let selItems = store.get('sel', []); // { key, name, kind, mi, p?, lines? (not a whole named trail), dots? (picked ride) }
let selAdding = false;

const isNamed = (p) => p.n && layers[p.t] && !['closure', 'reroute', 'road'].includes(p.t);
function featLines(f) {
  const g = f.geometry;
  const ls = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  return ls.map((l) => l.map(([x, y]) => [y, x]));
}
function linesMeters(lines) {
  let m = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) m += hav(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]);
  return m;
}
function kindLabelOf(p) { return p.t === 'nf' && p.sub === 'trail' ? 'National forest trail' : KIND[p.t].label; }

// a tap selects the whole named trail (every piece with that name), or just the one road/segment
function itemFor(f) {
  const p = f.properties;
  if (isNamed(p)) {
    let mi = 0;
    layers[p.t].eachLayer((l) => { if (l.feature.properties.n === p.n) mi += l.feature.properties.mi || 0; });
    return { key: p.t + '|' + p.n, name: p.n, kind: kindLabelOf(p), mi: +mi.toFixed(2) };
  }
  const lines = featLines(f);
  return { key: 'f|' + (lines[0] && lines[0][0].join(',')), name: p.n || kindLabelOf(p), kind: kindLabelOf(p), p,
    mi: +((p.mi || linesMeters(lines) / 1609.344)).toFixed(2), lines };
}
function featsFor(it) {
  const [t, ...rest] = it.key.split('|');
  const n = rest.join('|'), out = [];
  if (layers[t]) layers[t].eachLayer((l) => { if (l.feature.properties.n === n) out.push(l.feature); });
  return out;
}

// ---------- ride time ----------
function rideMinutes(mi) {
  const r5 = (h) => Math.max(5, Math.round(h * 60 / 5) * 5);
  return [r5(mi / RIDE_MPH[1]), r5(mi / RIDE_MPH[0])];
}
function rideTimeText(mi, short) {
  const [lo, hi] = rideMinutes(mi);
  const f = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const s = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const g = short ? s : f;
  if (lo === hi) return g(lo);
  if (hi < 60) return `${lo}–${hi} min`;
  return `${g(lo)} – ${g(hi)}`;
}
const selMiles = () => selItems.reduce((s, it) => s + (it.mi || 0), 0);

// ---------- drawing ----------
function drawSel() {
  if (highlight) map.removeLayer(highlight);
  highlight = null;
  if (selItems.length) {
    highlight = L.featureGroup().addTo(map);
    const halo = { renderer, interactive: false, color: '#fff', weight: lineWeight() + 6, opacity: 0.6, fillOpacity: 0.1 };
    for (const it of selItems) {
      if (it.dots) {
        L.polyline(it.lines, { renderer: planRenderer, color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(highlight);
        L.polyline(it.lines, { renderer: planRenderer, color: '#ff2fd0', weight: 5, interactive: false }).addTo(highlight);
      } else {
        // halo goes under the colored lines
        const l = it.lines ? L.polyline(it.lines, halo) : L.geoJSON({ type: 'FeatureCollection', features: featsFor(it) }, { ...halo, style: halo });
        l.addTo(highlight).bringToBack();
      }
    }
  }
  store.set('sel', selItems);
  updateSelBar();
  if (window.refreshUpdChip) refreshUpdChip();
}
map.on('zoomend', () => { if (selItems.length) drawSel(); });
// after trails load or the machine width changes: drop trails that are no longer on the map
window.refreshSel = () => {
  selItems = selItems.filter((it) => it.lines || featsFor(it).length);
  drawSel();
};

function updateSelBar() {
  const bar = $('#sel-bar');
  bar.hidden = !selItems.length && !selAdding;
  bar.classList.toggle('adding', selAdding);
  const n = selItems.length, mi = selMiles();
  const what = n === 1 ? selItems[0].name : `${n} selected`;
  bar.querySelector('span').textContent = selAdding
    ? `Tap trails to add · ${n ? `${n} · ${mi.toFixed(1)} mi · ` : ''}Done`
    : `${what} · ${mi.toFixed(1)} mi · ${rideTimeText(mi, true)}`;
}
$('#sel-bar').addEventListener('click', (e) => {
  if (e.target.closest('.x')) return clearSel();
  if (selAdding) { selAdding = false; updateSelBar(); }
  if (selItems.length) showSel();
});

// ---------- actions ----------
// Called by a trail's info sheet. With several trails (or a picked ride) selected, looking at another
// trail doesn't wipe that out; its sheet offers "Add to selection" instead.
function selDetail(f) {
  const it = itemFor(f);
  const keep = selItems.length > 1 || selItems.some((s) => s.dots);
  const inSel = selItems.some((s) => s.key === it.key);
  if (!keep) { selItems = [it]; drawSel(); }
  const html = keep && !inSel
    ? '<div class="rec-row"><button class="ghost" id="btn-sel-add">Add to selection</button><button class="ghost" id="btn-sel-show">See selection</button></div>'
    : '<div class="rec-row"><button class="ghost" id="btn-sel-more">+ Add another trail</button><button class="ghost" id="btn-sel-part">Ride just part of it</button></div>';
  const wire = () => {
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('btn-sel-add', () => { toggleSel(f); showSel(); });
    on('btn-sel-show', showSel);
    on('btn-sel-more', startAdding);
    on('btn-sel-part', () => startPick());
  };
  return { html, wire };
}
function toggleSel(f) {
  const it = itemFor(f);
  const i = selItems.findIndex((s) => s.key === it.key);
  if (i >= 0) selItems.splice(i, 1); else selItems.push(it);
  drawSel();
}
function clearSel() { selItems = []; selAdding = false; drawSel(); closeSheets(); }
function startAdding() {
  closeSheets();
  selAdding = true;
  updateSelBar();
  toast('Tap other trails to add them. Tap the bar at the top when done.');
}
function startPick(item) { startTrace(null, null, item || true); }
// the picked ride replaces the whole-trail selection; other picked rides stay
window.pickDone = (coords, dots, item) => {
  const mi = +(linesMeters([coords]) / 1609.344).toFixed(2);
  if (item) Object.assign(item, { mi, lines: [coords], dots });
  else {
    const picks = selItems.filter((s) => s.dots);
    selItems = [...picks, { key: 'c' + Date.now(), name: picks.length ? `Picked ride ${picks.length + 1}` : 'Picked ride', kind: 'custom', mi, lines: [coords], dots }];
  }
  drawSel();
  showSel();
};

function selToTrip() {
  const dots = selItems.filter((s) => s.dots).flatMap((s) => s.dots);
  if (dots.length < 2) return;
  if (plan && plan.stops.length > 1 && !confirm('Replace your planned trip with this ride?')) return;
  plan = { stops: dots.map((d, i) => stopFrom(L.latLng(d[0], d[1]), i === 0 ? 'Start' : i === dots.length - 1 ? 'End' : `Point ${i + 1}`)) };
  savePlan();
  closeSheets();
  computePlan();
}

// ---------- saved ride plans ----------
// A named copy of the selection (whole trails and/or picked rides), kept on this phone and in backups.
function saveRidePlan() {
  if (!selItems.length) return;
  const name = prompt('Name this ride plan', selItems.length === 1 ? selItems[0].name : `${selItems[0].name} + ${selItems.length - 1} more`);
  if (name === null) return;
  const plans = store.get('plans', []);
  const items = selItems.map(({ key, name: n, kind, mi, p, lines, dots }) => ({ key, name: n, kind, mi, p, lines, dots }));
  plans.push({ id: 'r' + Date.now(), name: (name.trim() || 'Ride plan').slice(0, 80), items, mi: +selMiles().toFixed(1), made: Date.now() });
  store.set('plans', plans);
  toast(`Saved "${plans[plans.length - 1].name}"`);
  showSel();
}
function selBounds(items) {
  const b = L.latLngBounds([]);
  for (const it of items) {
    if (it.lines) b.extend(L.latLngBounds(it.lines.flat()));
    else { const fs = featsFor(it); if (fs.length) b.extend(L.geoJSON({ type: 'FeatureCollection', features: fs }).getBounds()); }
  }
  return b;
}
function showRidePlans() {
  const plans = store.get('plans', []).slice().sort((a, b) => b.made - a.made);
  let html = '<h3>My saved ride plans</h3>';
  html += plans.length ? plans.map((p) => `<div class="ride" data-id="${esc(p.id)}">
      <div class="ride-top" data-a="load"><b>${esc(p.name)}</b><small>${p.mi.toFixed(1)} mi · about ${rideTimeText(p.mi)} · ${p.items.length} part${p.items.length > 1 ? 's' : ''}</small></div>
      <div class="ride-btns"><button data-a="load">Show</button>${p.items.some((i) => i.dots) ? '<button data-a="trip">Trip</button>' : ''}<button data-a="rename">Rename</button><button data-a="del" class="danger">Delete</button></div></div>`).join('')
    : '<p class="hint">No saved ride plans yet. Select trails or pick the part you\'ll ride, then tap "Save this ride plan".</p>';
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = (e) => {
    const el = e.target.closest('[data-a]');
    const row = e.target.closest('.ride');
    if (!el || !row) return;
    const all = store.get('plans', []);
    const p = all.find((x) => x.id === row.dataset.id);
    if (!p) return;
    const a = el.dataset.a;
    if (a === 'load' || a === 'trip') {
      selItems = JSON.parse(JSON.stringify(p.items)).filter((it) => it.lines || featsFor(it).length);
      drawSel();
      const b = selBounds(selItems);
      if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
      if (a === 'trip') selToTrip(); else showSel();
    }
    if (a === 'rename') {
      const n = prompt('Name this ride plan', p.name);
      if (n && n.trim()) { p.name = n.trim().slice(0, 80); store.set('plans', all); showRidePlans(); }
    }
    if (a === 'del' && confirm(`Delete the ride plan "${p.name}"?`)) { store.set('plans', all.filter((x) => x !== p)); showRidePlans(); }
  };
  openSheet('#sheet');
}
window.showRidePlans = showRidePlans;
$('#btn-plans').addEventListener('click', showRidePlans);

// one whole trail: its own info sheet; anything else: the list with each one's miles and the total
function showSel() {
  if (selItems.length === 1 && !selItems[0].dots) {
    const it = selItems[0];
    const f = it.lines ? { type: 'Feature', properties: it.p, geometry: { type: 'MultiLineString', coordinates: it.lines.map((l) => l.map(([y, x]) => [x, y])) } }
      : featsFor(it)[0];
    if (f) return showDetail(f, L.geoJSON(f));
  }
  const mi = selMiles();
  const picks = selItems.some((s) => s.dots);
  let html = `<h3>${selItems.length} selected</h3><div class="sel-list">`;
  html += selItems.map((it, i) => `<div class="sel-row"><div class="sel-name"><b>${esc(it.name)}</b><small>${esc(it.dots ? 'The part you picked' : it.kind)}</small></div>
    <span class="sel-mi">${it.mi.toFixed(1)} mi</span>${it.dots ? `<button class="ghost" data-a="edit" data-i="${i}">Edit</button>` : ''}
    <button class="ghost sel-x" data-a="drop" data-i="${i}" aria-label="Remove">&times;</button></div>`).join('');
  html += `</div><dl><dt>${selItems.length > 1 ? 'Combined' : 'Length'}</dt><dd>${mi.toFixed(1)} mi</dd>
    <dt>Ride time</dt><dd>About ${rideTimeText(mi)} at ${RIDE_MPH[0]}–${RIDE_MPH[1]} mph</dd></dl>`;
  if (!picks && selItems.length > 1) html += '<p class="hint">Whole trails, every branch and loop. To add up only the part you\'ll ride, tap "Pick the part you\'ll ride".</p>';
  html += `<div class="rec-row"><button class="ghost" data-a="add">+ Add another trail</button><button class="ghost" data-a="pick">Pick the part you'll ride</button></div>`;
  if (picks) html += '<button class="primary" data-a="trip">Make it a trip (for navigation)</button>';
  html += '<div class="rec-row"><button class="ghost" data-a="save">Save this ride plan</button><button class="ghost" data-a="clear">Clear selection</button></div>';
  const saved = store.get('plans', []).length;
  if (saved) html += `<button class="ghost" data-a="plans">My saved ride plans (${saved})</button>`;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.a) return;
    const a = b.dataset.a, it = selItems[+b.dataset.i];
    if (a === 'drop') { selItems.splice(+b.dataset.i, 1); drawSel(); if (selItems.length) showSel(); else closeSheets(); }
    if (a === 'edit') startPick(it);
    if (a === 'add') startAdding();
    if (a === 'pick') startPick();
    if (a === 'trip') selToTrip();
    if (a === 'clear') clearSel();
    if (a === 'save') saveRidePlan();
    if (a === 'plans') showRidePlans();
  };
  openSheet('#sheet');
}

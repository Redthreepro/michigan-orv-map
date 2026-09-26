'use strict';
// Trips: an ordered list of stops, routed leg by leg. A plain "Route here" is just a two-stop trip.
// Also: overnight stops split the trip into days, gas/camps along the way, live off-route rerouting.

let plan = store.get('trip', null);   // { stops: [{ lat, lng, name, night, mine }] }
let planLegs = [];                     // one planLeg() result per pair of stops
let planLayer = null;
let pressed = null;
const nav = { off: 0, last: 0 };
const OFF_ROUTE_M = 80;
const GAS_NEAR_M = 3219;   // 2 mi
const CAMP_NEAR_M = 3219;

const savePlan = () => store.set('trip', plan);

// ---------- routing one leg ----------
function planLeg(from, to) {
  let { S, T, alts } = snapPair(from, to);
  if (!S || !T) return { fail: S ? 'end' : 'start', legs: [], steps: [], byKind: {}, meters: 0, secs: 0, from, to };
  let sol = solve(S, T);
  if (!sol.endVia && alts) {
    let best = { S, sol, score: S.d + (sol.closestD ?? Infinity) };
    for (const a of alts) {
      const s2 = solve(a, T);
      const score = a.d + (s2.endVia ? 0 : s2.closestD);
      if (score < best.score) best = { S: a, sol: s2, score };
    }
    S = best.S; sol = best.sol;
  }
  let legs, gap = null;
  if (sol.endVia) legs = assemble(S, T, sol);
  else {
    legs = sol.closest != null ? assemble(S, T, sol, sol.closest) : [];
    const last = legs.length ? legs[legs.length - 1].coords.slice(-1)[0] : [S.lat, S.lng];
    gap = { from: last, to: [T.lat, T.lng], meters: hav(last[0], last[1], T.lat, T.lng) };
  }
  const r = summarize(legs, S, T, gap);
  r.from = from; r.to = to;
  // one continuous line with cumulative meters, for progress/gas lookups
  r.path = legs.flatMap((l) => l.coords);
  r.cum = [0];
  for (let i = 1; i < r.path.length; i++) r.cum.push(r.cum[i - 1] + hav(r.path[i - 1][0], r.path[i - 1][1], r.path[i][0], r.path[i][1]));
  return r;
}

async function computePlan({ fit = true, show = true } = {}) {
  if (!plan || !plan.stops.length) return;
  const first = plan.stops[0];
  if (first.mine) {
    let here = meMarker ? meMarker.getLatLng() : null;
    if (!here) {
      ensureGpsFix();
      toast('Getting your GPS location…');
      here = await waitForFix(20000);
      if (!here) { toast('No GPS fix. Long-press a start point and choose "Start trip here".'); return; }
    }
    first.lat = here.lat; first.lng = here.lng;
  }
  planLegs = [];
  if (plan.stops.length >= 2) {
    try { await loadGraph(); } catch { return toast('Could not load the trail network'); }
    for (let i = 0; i < plan.stops.length - 1; i++) {
      planLegs.push(planLeg(L.latLng(plan.stops[i]), L.latLng(plan.stops[i + 1])));
    }
  }
  drawPlan(fit);
  updateBar();
  if (show) showPlan();
  if (window.refreshOffline) setTimeout(refreshOffline, 500);
}

// ---------- drawing ----------
function stopIcon(i, s) {
  const cls = s.night ? 'night' : i === 0 ? 'first' : i === plan.stops.length - 1 ? 'last' : '';
  return L.divIcon({ className: 'stop-pin ' + cls, html: `<span>${i + 1}</span>`, iconSize: [26, 26] });
}
function drawPlan(fit) {
  if (planLayer) map.removeLayer(planLayer);
  planLayer = L.layerGroup().addTo(map);
  const lines = planLegs.map((r) => r.path).filter((p) => p.length);
  if (lines.length) {
    L.polyline(lines, { renderer: planRenderer, color: '#fff', weight: 11, opacity: 0.9, interactive: false }).addTo(planLayer);
    L.polyline(lines, { renderer: planRenderer, color: '#1e6bff', weight: 6, interactive: false }).addTo(planLayer);
  }
  const dash = { renderer: planRenderer, color: '#1e6bff', weight: 3, dashArray: '2 8', interactive: false };
  for (const r of planLegs) {
    if (r.fail) { L.polyline([r.from, r.to], { ...dash, color: '#ff2d2d', weight: 4, dashArray: '6 8' }).addTo(planLayer); continue; }
    if (r.offStart > 30) L.polyline([r.from, r.startPt], dash).addTo(planLayer);
    if (r.offEnd > 30) L.polyline([r.endPt, r.to], dash).addTo(planLayer);
    if (r.gap) L.polyline([r.gap.from, r.gap.to], { ...dash, color: '#ff2d2d', weight: 4, dashArray: '6 8' }).addTo(planLayer);
  }
  plan.stops.forEach((s, i) => {
    L.marker([s.lat, s.lng], { icon: stopIcon(i, s), zIndexOffset: 900 })
      .on('click', () => showPlan())
      .addTo(planLayer);
  });
  if (fit) {
    const pts = [...plan.stops.map((s) => [s.lat, s.lng]), ...lines.flat()];
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 15 });
    else map.setView(pts[0], Math.max(map.getZoom(), 12));
  }
}

// ---------- summary ----------
const fmtMi = (m) => (m / 1609.344).toFixed(m < 16093 ? 1 : 0) + ' mi';
const fmtTime = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const totals = (legs) => legs.reduce((a, r) => ({ m: a.m + r.meters, s: a.s + r.secs }), { m: 0, s: 0 });

function days() {
  // overnight stops (not the last stop) end a day
  const out = [];
  let startIdx = 0;
  plan.stops.forEach((s, i) => {
    if (i === plan.stops.length - 1 || (i > 0 && s.night)) {
      const legs = planLegs.slice(startIdx, i);
      out.push({ from: startIdx, to: i, ...totals(legs) });
      startIdx = i;
    }
  });
  return out;
}

// For each item, where the trip passes closest to it: [{ item, off (m), at (trip meters) }] within maxOff.
// pointsOf(item) -> [[lat, lng], ...] (one point for a place, many for a line).
function passes(items, maxOff, pointsOf) {
  const best = new Map();
  let offset = 0;
  const pad = maxOff / 111000 + 0.002;
  for (const r of planLegs) {
    if (r.path.length > 1) {
      const lats = r.path.map((p) => p[0]), lngs = r.path.map((p) => p[1]);
      const box = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad * 1.4, Math.max(...lngs) + pad * 1.4];
      for (const it of items) {
        for (const [lat, lng] of pointsOf(it)) {
          if (lat < box[0] || lat > box[1] || lng < box[2] || lng > box[3]) continue;
          const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
          for (let i = 0; i < r.path.length - 1; i++) {
            const [ay, ax] = r.path[i], [by, bx] = r.path[i + 1];
            const dx = (bx - ax) * kx, dy = (by - ay) * ky, px = (lng - ax) * kx, py = (lat - ay) * ky;
            const L2 = dx * dx + dy * dy;
            const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
            const d = Math.hypot(px - dx * t, py - dy * t);
            const cur = best.get(it);
            if (d <= maxOff && (!cur || d < cur.off)) best.set(it, { item: it, off: d, at: offset + r.cum[i] + (r.cum[i + 1] - r.cum[i]) * t });
          }
        }
      }
    }
    offset += r.cum[r.cum.length - 1] || r.meters;
  }
  return [...best.values()].sort((a, b) => a.at - b.at);
}

// Points of a kind within `maxOff` of the whole trip, with the trip mile where you pass them.
function alongTrip(kind, maxOff) {
  if (!window.POIS || !planLegs.length) return [];
  return passes(POIS.filter((p) => p.t === kind), maxOff, (p) => [[p.lat, p.lng]]).map((h) => ({ p: h.item, off: h.off, at: h.at }));
}

function pointAtTrip(at) {
  let offset = 0;
  for (const r of planLegs) {
    const len = r.cum[r.cum.length - 1] || 0;
    if (at <= offset + len && r.path.length) {
      const i = Math.max(0, r.cum.findIndex((c) => c >= at - offset));
      return r.path[i] || r.path[r.path.length - 1];
    }
    offset += len;
  }
  const last = planLegs[planLegs.length - 1];
  return last && last.path.length ? last.path[last.path.length - 1] : null;
}

const NO_GAS_WARN_M = 40 * 1609.344;
const LONG_DAY_S = 8 * 3600;
const mile = (m) => Math.max(0, Math.round(m / 1609.344));

// Everything worth knowing before you go, worst first. { level: bad|warn|info, text, at?, poi? }
function tripWarnings(gas) {
  const w = [];
  const t = totals(planLegs);
  planLegs.forEach((r, i) => {
    const a = plan.stops[i].name, b = plan.stops[i + 1].name;
    if (r.fail) w.push({ level: 'bad', text: `${r.fail === 'start' ? a : b}: no trail your machine can ride within 15 miles.`, at: r.fail === 'start' ? [r.from.lat, r.from.lng] : [r.to.lat, r.to.lng] });
    else if (r.gap) w.push({ level: 'bad', text: `${a} → ${b} doesn't connect: ${fmtMi(r.gap.meters)} with no DNR trail or forest road (red dashes). You'd need county roads. Check that county's ORV rules.`, at: r.gap.from });
  });

  // closures and reroutes on or near the route
  for (const [k, label] of [['closure', 'Temporary closure'], ['reroute', 'Temporary reroute']]) {
    const feats = (allByKind[k] || []).filter((f) => fits(f.properties));
    const pts = (f) => {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      return lines.flat().map(([x, y]) => [y, x]);
    };
    // one closure is often many DNR segments: group by name + notice
    const groups = new Map();
    for (const h of passes(feats, 400, pts)) {
      const p = h.item.properties;
      const key = (p.n || '') + '|' + (p.c || '');
      const g = groups.get(key) || { p, from: h.at, to: h.at, on: false };
      g.from = Math.min(g.from, h.at); g.to = Math.max(g.to, h.at); g.on = g.on || h.off < 40;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const note = g.p.c ? ' ' + (g.p.c.length > 140 ? g.p.c.slice(0, 140) + '…' : g.p.c) : '';
      const where = mile(g.from) === mile(g.to) ? `mile ${mile(g.from)}` : `miles ${mile(g.from)}–${mile(g.to)}`;
      w.push({ level: g.on && k === 'closure' ? 'bad' : 'warn',
        text: `${label} ${g.on ? 'on' : 'near'} your route at ${where}${g.p.n ? ': ' + g.p.n : ''}.${note}`, at: pointAtTrip(g.from) });
    }
  }

  // gas
  if (t.m > 0) {
    const marks = [0, ...gas.map((g) => g.at), t.m];
    let worst = { len: 0, a: 0 };
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > worst.len) worst = { len: marks[i] - marks[i - 1], a: marks[i - 1] };
    // gas stops are 2 mi off route at most: count the detour both ways against your range
    const range = (+store.get('range', 0) || 0) * 1609.344;
    const stretch = worst.len + (gas.length ? 2 * 3219 : 0);
    const where = `(mile ${mile(worst.a)} to ${mile(worst.a + worst.len)})`;
    const at = pointAtTrip(worst.a + worst.len / 2);
    if (range) {
      if (!gas.length && t.m > range) w.push({ level: 'bad', text: `No gas within 2 miles of this ${fmtMi(t.m)} route, and your range is ${fmtMi(range)}. Carry extra fuel.` });
      else if (stretch > range) w.push({ level: 'bad', text: `${fmtMi(worst.len)} with no gas nearby ${where}, more than your ${fmtMi(range)} fuel range.`, at });
      else if (stretch > range * 0.8) w.push({ level: 'warn', text: `${fmtMi(worst.len)} with no gas nearby ${where}, close to your ${fmtMi(range)} fuel range.`, at });
    } else if (!gas.length && t.m > 16093) w.push({ level: 'warn', text: `No gas within 2 miles of the whole ${fmtMi(t.m)} route. Carry enough fuel. (Set your fuel range in Layers for exact warnings.)` });
    else if (worst.len > NO_GAS_WARN_M) w.push({ level: 'warn', text: `${fmtMi(worst.len)} with no gas nearby ${where}. Set your fuel range in Layers to check it.`, at });
  }

  // camping at overnight stops
  plan.stops.forEach((s, i) => {
    if (!s.night || i === 0 || i === plan.stops.length - 1) return;
    const cg = (window.POIS || []).find((p) => p.t === 'camp' && hav(p.lat, p.lng, s.lat, s.lng) < 400);
    if (!cg && window.campingAt && !campingAt(s.lat, s.lng).ok) w.push({ level: 'warn', text: `Overnight at "${s.name}" isn't a campground or free-camping land.`, at: [s.lat, s.lng] });
  });

  // overnight stops with no AT&T signal (only once the coverage file has been loaded)
  if (window.signalAt) plan.stops.forEach((s, i) => {
    if (!s.night || i === 0 || i === plan.stops.length - 1) return;
    const sig = signalAt(s.lat, s.lng);
    if (sig === 'none') w.push({ level: 'info', text: `No AT&T signal at "${s.name}" per the FCC map. Tell someone your plan before you lose service.`, at: [s.lat, s.lng] });
  });

  // long days
  const ds = days();
  if (ds.length > 1) ds.forEach((d, i) => { if (d.s > LONG_DAY_S) w.push({ level: 'warn', text: `Day ${i + 1} is about ${fmtTime(d.s)} of riding. Consider another overnight stop.` }); });
  else if (t.s > LONG_DAY_S) w.push({ level: 'warn', text: `About ${fmtTime(t.s)} of riding. Consider an overnight stop.` });

  // difficulty the DNR flags on the route
  const x4 = planLegs.reduce((a, r) => a + (r.x4 || 0), 0), hc = planLegs.reduce((a, r) => a + (r.hc || 0), 0);
  if (x4 > 50) w.push({ level: 'warn', text: `${fmtMi(x4)} is marked "4x4 and high clearance required" by the DNR.` });
  if (hc > 50) w.push({ level: 'warn', text: `${fmtMi(hc)} is marked "high clearance required" by the DNR.` });

  // seasonal / military
  const sea = planLegs.reduce((a, r) => a + (r.seasonal || 0), 0);
  if (sea > 50) w.push({ level: 'warn', text: `${fmtMi(sea)} on roads or connectors that are closed to ORVs part of the year. Tap the dashed lines for the dates.` });
  if (planLegs.some((r) => r.military > 50)) w.push({ level: 'warn', text: 'Crosses Camp Grayling military roads, which can close for training without notice.' });

  // where to unload
  const first = plan.stops[0];
  if (!first.mine && window.nearestTrailhead) {
    const th = nearestTrailhead(first.lat, first.lng);
    if (th && th.d > 1609) w.push({ level: 'info', text: `Nearest ORV parking for your machine: ${th.p.n}, ${fmtMi(th.d)} from your start.`, poi: th.p });
  }

  // data age
  const built = $('#data-info').dataset.built;
  if (built) {
    const age = Math.floor((Date.now() - new Date(built.replace(' ', 'T')).getTime()) / 86400000);
    if (age > 7) w.push({ level: 'warn', text: `Closure info is ${age} days old. Open the app with signal before you go.` });
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return w.sort((a, b) => order[a.level] - order[b.level]);
}

function showPlan() {
  if (!plan) return;
  // camps get a "no signal" note once coverage is loaded; try loading it once per session
  if (!window.__covTried && window.signalAt && signalAt(0, 0) === null && plan.stops.some((s) => s.night)) {
    window.__covTried = true;
    loadCoverage().then(() => { if (window.signalAt(0, 0) !== null && !$('#panel-route').hidden) showPlan(); });
  }
  const n = plan.stops.length;
  const t = totals(planLegs);
  const isTrip = n > 2 || plan.stops.some((s) => s.night);
  let html = `<h3>${n < 2 ? 'Trip' : isTrip ? 'Trip' : 'Route'}${n >= 2 ? ': ' + fmtMi(t.m) : ''}</h3>`;
  if (n < 2) html += `<p class="hint">Add another stop: long-press the map, or tap a gas station, campground, waypoint, or trail and choose "Add to trip".</p>`;
  else html += `<p class="hint">About ${fmtTime(t.s)} of riding${rig ? ` · for machines up to ${rig}"` : ''}</p>`;

  const gasList = planLegs.length ? alongTrip('gas', GAS_NEAR_M) : [];
  const warns = planLegs.length ? tripWarnings(gasList) : [];
  window.__warns = warns;
  if (warns.length) {
    html += '<div class="warns"><b>Heads up</b>' + warns.map((x, i) => `<div class="w ${x.level}" data-w="${i}">${esc(x.text)}</div>`).join('') + '</div>';
  } else if (planLegs.length) html += '<div class="warns ok"><b>No problems found</b> on this route.</div>';

  if (n >= 1 && !plan.stops[0].mine) html += `<div class="rec-row"><button class="ghost" id="btn-plan-drive">Drive to the start (Google Maps)</button><button class="ghost" id="btn-plan-send">Send directions</button></div>`;

  const ds = n >= 2 ? days() : [];
  if (ds.length > 1) {
    html += '<div class="days">' + ds.map((d, i) => `<div><b>Day ${i + 1}</b> · ${fmtMi(d.m)} · ~${fmtTime(d.s)}<small>${esc(plan.stops[d.from].name)} → ${esc(plan.stops[d.to].name)}</small></div>`).join('') + '</div>';
  }

  html += '<ol class="stops">';
  plan.stops.forEach((s, i) => {
    let camp = '';
    if (s.night && window.campingAt) {
      const cg = (window.POIS || []).find((p) => p.t === 'camp' && hav(p.lat, p.lng, s.lat, s.lng) < 400);
      if (cg) camp = `<small class="ok">Campground: ${esc(cg.sub || 'campground')}${cg.ph ? ' · ' + esc(cg.ph) : ''}</small>`;
      else {
        const c = campingAt(s.lat, s.lng);
        camp = `<small class="${c.ok ? 'ok' : 'warn'}">${esc(c.short || c.text)}</small>`;
      }
    }
    html += `<li class="stop" data-i="${i}">
      <span class="num ${s.night ? 'night' : ''}">${i + 1}</span>
      <div class="stop-main"><b>${esc(s.name)}</b>${camp}</div>
      <div class="stop-btns">
        ${i > 0 && i < n - 1 ? `<button data-a="night" class="${s.night ? 'on' : ''}" title="Camp here overnight">Overnight</button>` : ''}
        ${i > 0 ? '<button data-a="up" aria-label="Move up">&uarr;</button>' : ''}
        ${i < n - 1 ? '<button data-a="down" aria-label="Move down">&darr;</button>' : ''}
        <button data-a="del" aria-label="Remove">&times;</button>
      </div></li>`;
    const r = planLegs[i];
    if (r) {
      const via = r.steps.slice().sort((a, b) => b.meters - a.meters).slice(0, 2).map((x) => x.label).join(', ');
      html += `<li class="leg" data-leg="${i}">${r.fail ? '<b>No trail you can ride within 15 mi of this stop</b>'
        : `${fmtMi(r.meters)} · ~${fmtTime(r.secs)}${via ? ' · via ' + esc(via) : ''}`}
        ${r.gap ? `<small class="warn">Doesn't connect: last ${fmtMi(r.gap.meters)} has no DNR trail or forest road (red dashes). Check county road rules.</small>` : ''}
        ${r.seasonal > 50 ? `<small class="warn">${fmtMi(r.seasonal)} on seasonally closed forest road. Check dates.</small>` : ''}
        ${r.military > 50 ? '<small class="warn">Crosses Camp Grayling military roads.</small>' : ''}</li>`;
    }
  });
  html += '</ol>';

  if (planLegs.length) {
    const gas = gasList;
    const total = t.m;
    const marks = [0, ...gas.map((g) => g.at), total];
    let worst = { len: 0, a: 0, b: 0 };
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > worst.len) worst = { len: marks[i] - marks[i - 1], a: marks[i - 1], b: marks[i] };
    html += `<h2>Gas within 2 mi of the route</h2>`;
    html += gas.length
      ? `<p class="hint">Longest stretch with no gas nearby: <b>${fmtMi(worst.len)}</b> (mile ${Math.round(worst.a / 1609.344)} to ${Math.round(worst.b / 1609.344)}).</p>`
        + '<ul class="along">' + gas.map((g, i) => `<li data-gas="${i}"><span>mile ${Math.round(g.at / 1609.344)}</span><b>${esc(g.p.n)}</b>${g.p.city ? ' · ' + esc(g.p.city) : ''}<small>${fmtMi(g.off)} off route${g.p.h ? ' · ' + esc(g.p.h) : ''}</small></li>`).join('') + '</ul>'
      : `<p class="hint warn">No gas stations within 2 miles of this whole route (${fmtMi(total)}). Carry enough fuel.</p>`;
    const camps = alongTrip('camp', CAMP_NEAR_M);
    if (camps.length) {
      html += `<h2>Campgrounds within 2 mi</h2><ul class="along">` + camps.map((c, i) => `<li data-camp="${i}"><span>mile ${Math.round(c.at / 1609.344)}</span><b>${esc(c.p.n)}</b><small>${esc(c.p.sub || '')} · ${fmtMi(c.off)} off route</small></li>`).join('') + '</ul>';
    }
    window.__along = { gas, camps };
  }
  html += '<div id="trip-weather"></div>';
  html += `<p class="hint">Routes use DNR data only and skip closed segments. Always follow posted signs.</p>`;
  html += `<div class="rec-row"><button class="ghost" id="btn-plan-gpx">Share GPX</button><button class="ghost" id="btn-plan-clear">Clear</button></div>`;
  $('#route-body').innerHTML = html;
  openSheet('#panel-route');
  if (window.fillTripWeather && n >= 2) fillTripWeather();
}

$('#route-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  const li = e.target.closest('li');
  if (btn && btn.id === 'btn-plan-clear') {
    if (plan && plan.stops.length > 2 && !confirm('Clear this whole trip?')) return;
    return clearPlan();
  }
  if (btn && btn.id === 'btn-plan-drive') return driveTo(plan.stops[0].lat, plan.stops[0].lng);
  if (btn && btn.id === 'btn-plan-send') return sendDirections(plan.stops[0].lat, plan.stops[0].lng, plan.stops[0].name);
  if (btn && btn.id === 'btn-plan-gpx') return shareGpx(plan.stops.some((s) => s.night) ? 'ORV trip' : 'ORV route', planGpx());
  if (btn && li && li.classList.contains('stop')) {
    const i = +li.dataset.i, a = btn.dataset.a, st = plan.stops;
    if (a === 'night') st[i].night = !st[i].night;
    if (a === 'up') [st[i - 1], st[i]] = [st[i], st[i - 1]];
    if (a === 'down') [st[i + 1], st[i]] = [st[i], st[i + 1]];
    if (a === 'del') st.splice(i, 1);
    if (!st.length) return clearPlan();
    savePlan();
    if (a === 'night') { drawPlan(false); return showPlan(); }
    return computePlan({ fit: false });
  }
  if (li && li.classList.contains('stop')) { const s = plan.stops[+li.dataset.i]; map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13)); }
  if (li && li.dataset.leg) { const r = planLegs[+li.dataset.leg]; if (r.path.length) map.fitBounds(L.latLngBounds(r.path), { padding: [40, 40] }); }
  const wEl = e.target.closest('[data-w]');
  if (wEl) {
    const x = window.__warns[+wEl.dataset.w];
    if (x.poi) return showPlace(x.poi);
    if (x.at) { map.setView(x.at, Math.max(map.getZoom(), 14)); closeSheets(); }
    return;
  }
  if (li && li.dataset.gas) { const g = window.__along.gas[+li.dataset.gas]; showPlace(g.p); }
  if (li && li.dataset.camp) { const c = window.__along.camps[+li.dataset.camp]; showPlace(c.p); }
});

window.updateBar = updateBar;
function updateBar() {
  const bar = $('#route-bar');
  if (!plan) { bar.hidden = true; return; }
  bar.hidden = false;
  const n = plan.stops.length;
  const t = totals(planLegs);
  const gap = planLegs.some((r) => r.gap || r.fail);
  const nw = planLegs.length ? tripWarnings(alongTrip('gas', GAS_NEAR_M)).filter((x) => x.level !== 'info').length : 0;
  bar.querySelector('span').textContent = n < 2 ? '1 stop · add more'
    : `${fmtMi(t.m)}${gap ? ' · has gaps' : ' · ~' + fmtTime(t.s)}${n > 2 ? ` · ${n} stops` : ''}${nw ? ` · ${nw} warning${nw > 1 ? 's' : ''}` : ''}`;
}

function clearPlan() {
  plan = null; planLegs = []; savePlan();
  if (planLayer) { map.removeLayer(planLayer); planLayer = null; }
  updateBar();
  closeSheets();
}
$('#route-bar').addEventListener('click', (e) => {
  if (e.target.closest('.x')) {
    if (plan && plan.stops.length > 2 && !confirm('Clear this whole trip?')) return;
    return clearPlan();
  }
  showPlan();
});

// ---------- GPX ----------
function planGpx() {
  const x = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const wpts = plan.stops.map((s, i) => `<wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}"><name>${x(`${i + 1}. ${s.name}`)}</name>${s.night ? '<sym>Campground</sym>' : ''}</wpt>`).join('\n');
  const trk = planLegs.filter((r) => r.path.length).map((r) => '<trkseg>' + r.path.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join('') + '</trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Michigan ORV Map" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
<trk><name>Planned route</name>
${trk}
</trk></gpx>`;
}

// ---------- adding stops ----------
function stopFrom(latlng, name) { return { lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6), name: name || 'Dropped pin', night: false }; }

// "Route here": from my location (or the chosen start) straight to this spot
function routeHere(latlng, name) {
  if (plan && plan.stops.length > 2 && !confirm('Replace your planned trip with a route to this spot?')) return;
  const start = plan && plan.stops.length && !plan.stops[0].mine && plan.stops.length === 1 ? plan.stops[0] : { name: 'My location', mine: true, lat: 0, lng: 0 };
  plan = { stops: [start, stopFrom(latlng, name)] };
  savePlan();
  closeSheets();
  computePlan();
}
function addToTrip(latlng, name) {
  if (!plan) plan = { stops: [] };
  plan.stops.push(stopFrom(latlng, name));
  savePlan();
  closeSheets();
  if (plan.stops.length === 1) { drawPlan(false); updateBar(); toast('Added. Add another stop to route between them.'); }
  else computePlan({ fit: false });
}
function startHere(latlng, name) {
  const s = stopFrom(latlng, name || 'Start');
  if (!plan) plan = { stops: [s] };
  else if (plan.stops[0].mine) plan.stops[0] = s;
  else plan.stops.unshift(s);
  savePlan();
  closeSheets();
  if (plan.stops.length === 1) { drawPlan(false); updateBar(); toast('Start set. Now add stops or a destination.'); }
  else computePlan({ fit: false });
}
window.routeHere = routeHere;
window.addToTrip = addToTrip;

// long-press (or right-click) anywhere
map.on('contextmenu', (e) => {
  pressed = e.latlng;
  $('#point-coords').textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  const c = window.campingAt ? campingAt(e.latlng.lat, e.latlng.lng) : null;
  const el = $('#point-camp');
  el.hidden = !c;
  if (c) { el.textContent = c.text; el.className = 'hint ' + (c.ok ? 'ok' : 'warn'); }
  const sig = $('#point-signal');
  const showSignal = () => {
    const s = window.signalAt ? signalAt(pressed.lat, pressed.lng) : null;
    sig.hidden = !s;
    if (s) sig.textContent = s === 'good' ? 'AT&T signal here: good (FCC map)' : s === 'weak' ? 'AT&T signal here: weak (FCC map)' : 'AT&T signal here: none (FCC map)';
  };
  showSignal();
  if (window.loadCoverage && window.signalAt && signalAt(0, 0) === null) loadCoverage().then(showSignal);
  openSheet('#panel-point');
});
$('#btn-route-here').addEventListener('click', () => routeHere(pressed));
$('#btn-add-trip').addEventListener('click', () => addToTrip(pressed));
$('#btn-route-from').addEventListener('click', () => startHere(pressed));
$('#btn-save-wp').addEventListener('click', () => editWaypoint({ lat: pressed.lat, lng: pressed.lng }));
$('#btn-drive').addEventListener('click', () => driveTo(pressed.lat, pressed.lng));
$('#btn-send-dir').addEventListener('click', () => sendDirections(pressed.lat, pressed.lng, 'this spot'));

// ---------- live progress + rerouting ----------
function nearestOnPlan(lat, lng) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  let best = { d: Infinity };
  planLegs.forEach((r, li) => {
    for (let i = 0; i < r.path.length - 1; i++) {
      const [ay, ax] = r.path[i], [by, bx] = r.path[i + 1];
      const dx = (bx - ax) * kx, dy = (by - ay) * ky, px = (lng - ax) * kx, py = (lat - ay) * ky;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
      const d = Math.hypot(px - dx * t, py - dy * t);
      if (d < best.d) best = { d, leg: li, at: r.cum[i] + (r.cum[i + 1] - r.cum[i]) * t };
    }
  });
  return best;
}

window.onPlanPos = (pos) => {
  if (!plan || !planLegs.length || !G) return;
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  if (accuracy > 50) return;
  const near = nearestOnPlan(lat, lng);
  if (near.d === Infinity) return;
  const leg = planLegs[near.leg];
  const legLeft = (leg.cum[leg.cum.length - 1] || 0) - near.at;
  const after = planLegs.slice(near.leg + 1).reduce((a, r) => a + r.meters, 0);
  const next = plan.stops[near.leg + 1];
  const bar = $('#route-bar');
  bar.hidden = false;
  bar.querySelector('span').textContent = `${fmtMi(legLeft)} to ${next.name}` + (after > 0 ? ` · ${fmtMi(legLeft + after)} total` : '');

  nav.off = near.d > OFF_ROUTE_M ? nav.off + 1 : 0;
  if (nav.off >= 3 && Date.now() - nav.last > 20000) {
    nav.off = 0; nav.last = Date.now();
    const redo = planLeg(L.latLng(lat, lng), L.latLng(next));
    if (!redo.fail) {
      planLegs[near.leg] = redo;
      drawPlan(false);
      toast(`Off route. New route to ${next.name}: ${fmtMi(redo.meters)}`);
    }
  }
};

// Re-run when the machine width changes
document.querySelectorAll('#rig-seg button').forEach((b) => b.addEventListener('click', () => { if (plan && plan.stops.length >= 2 && G) computePlan({ fit: false, show: false }); }));

// ---------- GPS helpers ----------
function ensureGpsFix() { if (watchId === null) locBtn.click(); }
function waitForFix(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (meMarker) { clearInterval(iv); resolve(meMarker.getLatLng()); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
    }, 300);
  });
}

// restore a saved trip; a "My location" start becomes a fixed point where you were when you planned it
if (plan && plan.stops.length) {
  const first = plan.stops[0];
  if (first.mine) {
    if (!first.lat) plan.stops.shift();
    else { first.mine = false; first.name = 'Start'; }
  }
  if (!plan.stops.length) plan = null;
  savePlan();
  updateBar();
  if (plan && plan.stops.length >= 2) computePlan({ fit: false, show: false });
  else if (plan) drawPlan(false);
}

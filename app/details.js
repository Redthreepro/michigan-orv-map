'use strict';
// Ride details: distance, moving time, top speed, climbing, elevation & speed charts, trails covered.

const MOVING_MPS = 0.9;     // slower than ~2 mph counts as stopped
const SPEED_WINDOW_MS = 5000;  // top speed over 5 s, so one GPS jump doesn't count
const MAX_SANE_MPH = 90;
const CLIMB_STEP_M = 3;     // ignore elevation wobble smaller than ~10 ft
const M_TO_FT = 3.281, MPS_TO_MPH = 2.237;

function rideMetrics(t) {
  const manual = new Set(t.manual || []);
  let distM = 0, movingMs = 0, totalMs = 0, topMps = 0, gain = 0, loss = 0, minE = Infinity, maxE = -Infinity;
  const prof = []; // [mile, elevation ft | null, mph | null] about every 50 m, recorded parts only
  t.segs.forEach((seg, k) => {
    if (manual.has(k)) { for (let i = 1; i < seg.length; i++) distM += hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]); return; }
    if (seg.length < 2) return;
    totalMs += seg[seg.length - 1][3] - seg[0][3];
    const cum = [0];
    for (let i = 1; i < seg.length; i++) cum.push(cum[i - 1] + hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]));
    let ref = null, j = 0, lastProf = -Infinity;
    for (let i = 0; i < seg.length; i++) {
      const [, , ele, ts] = seg[i];
      if (i) {
        const dt = ts - seg[i - 1][3], d = cum[i] - cum[i - 1];
        if (dt > 0 && dt < 60000 && d / (dt / 1000) > MOVING_MPS) movingMs += dt;
      }
      while (j < i && ts - seg[j][3] > SPEED_WINDOW_MS) j++;
      const win = ts - seg[Math.max(0, j - 1)][3];
      const mps = win >= SPEED_WINDOW_MS / 2 ? (cum[i] - cum[Math.max(0, j - 1)]) / (win / 1000) : null;
      if (mps != null && mps * MPS_TO_MPH < MAX_SANE_MPH) topMps = Math.max(topMps, mps);
      if (ele != null) {
        minE = Math.min(minE, ele); maxE = Math.max(maxE, ele);
        if (ref == null) ref = ele;
        else if (ele - ref >= CLIMB_STEP_M) { gain += ele - ref; ref = ele; }
        else if (ref - ele >= CLIMB_STEP_M) { loss += ref - ele; ref = ele; }
      }
      const atM = distM + cum[i];
      if (atM - lastProf >= 50) {
        prof.push([atM / 1609.344, ele != null ? ele * M_TO_FT : null, mps != null && mps * MPS_TO_MPH < MAX_SANE_MPH ? mps * MPS_TO_MPH : null]);
        lastProf = atM;
      }
    }
    distM += cum[cum.length - 1];
  });
  const s = stats(t);
  return { mi: distM / 1609.344, movingMs, totalMs, avgMph: movingMs ? (s.mi - s.addedMi) / (movingMs / 3600000) : 0,
    topMph: topMps * MPS_TO_MPH, gainFt: gain * M_TO_FT, lossFt: loss * M_TO_FT,
    minFt: isFinite(minE) ? minE * M_TO_FT : null, maxFt: isFinite(maxE) ? maxE * M_TO_FT : null, prof, addedMi: s.addedMi };
}

// ---------- charts (one measure each, one axis, hover/drag for values) ----------
const CH = { w: 320, h: 120, l: 38, r: 8, t: 10, b: 22 };
function lineChart(points, { unit, color, fmt }) {
  const pts = points.filter((p) => p[1] != null);
  if (pts.length < 3) return '';
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = xs[0], x1 = xs[xs.length - 1] || 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const X = (v) => CH.l + ((v - x0) / (x1 - x0 || 1)) * (CH.w - CH.l - CH.r);
  const Y = (v) => CH.t + (1 - (v - y0) / (y1 - y0)) * (CH.h - CH.t - CH.b);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const area = `${d}L${X(x1).toFixed(1)},${Y(y0).toFixed(1)}L${X(x0).toFixed(1)},${Y(y0).toFixed(1)}Z`;
  const gy = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  const grid = gy.map((v) => `<line x1="${CH.l}" x2="${CH.w - CH.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="ch-grid"/>
      <text x="${CH.l - 5}" y="${(Y(v) + 3.5).toFixed(1)}" class="ch-tick" text-anchor="end">${fmt(v)}</text>`).join('');
  const xt = [x0, (x0 + x1) / 2, x1].map((v, i) => `<text x="${X(v).toFixed(1)}" y="${CH.h - 6}" class="ch-tick" text-anchor="${['start', 'middle', 'end'][i]}">${v.toFixed(v < 10 ? 1 : 0)} mi</text>`).join('');
  const data = esc(JSON.stringify(pts.map((p) => [+p[0].toFixed(3), +p[1].toFixed(1)])));
  return `<svg class="ride-chart" viewBox="0 0 ${CH.w} ${CH.h}" data-pts="${data}" data-unit="${esc(unit)}" style="--c:${color}">
    ${grid}${xt}
    <path d="${area}" class="ch-area"/><path d="${d}" class="ch-line"/>
    <line class="ch-cross" y1="${CH.t}" y2="${CH.h - CH.b}" x1="-10" x2="-10"/><circle class="ch-dot" r="4" cx="-10" cy="-10"/>
    <rect class="ch-hit" x="${CH.l}" y="0" width="${CH.w - CH.l - CH.r}" height="${CH.h}"/>
  </svg><div class="ch-tip" hidden></div>`;
}
function wireCharts(root) {
  root.querySelectorAll('.ride-chart').forEach((svg) => {
    const pts = JSON.parse(svg.dataset.pts), unit = svg.dataset.unit;
    const tip = svg.nextElementSibling;
    const xs = pts.map((p) => p[0]);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    const X = (v) => CH.l + ((v - x0) / (x1 - x0 || 1)) * (CH.w - CH.l - CH.r);
    const Y = (v) => CH.t + (1 - (v - y0) / (y1 - y0)) * (CH.h - CH.t - CH.b);
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * CH.w;
      const mi = x0 + ((vx - CH.l) / (CH.w - CH.l - CH.r)) * (x1 - x0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - mi) < Math.abs(best[0] - mi)) best = p;
      svg.querySelector('.ch-cross').setAttribute('x1', X(best[0])); svg.querySelector('.ch-cross').setAttribute('x2', X(best[0]));
      svg.querySelector('.ch-dot').setAttribute('cx', X(best[0])); svg.querySelector('.ch-dot').setAttribute('cy', Y(best[1]));
      tip.hidden = false;
      tip.textContent = `${best[0].toFixed(1)} mi · ${Math.round(best[1]).toLocaleString()} ${unit}`;
      tip.style.left = `${Math.min(r.width - 110, Math.max(0, (X(best[0]) / CH.w) * r.width - 55))}px`;
    };
    const hit = svg.querySelector('.ch-hit');
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

// ---------- sheet ----------
const ft = (v) => `${Math.round(v).toLocaleString()} ft`;
function showRideDetails(t) {
  const m = rideMetrics(t);
  const date = new Date(t.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const tiles = [
    ['Distance', `${m.mi.toFixed(1)} mi`], ['Moving time', fmtDur(m.movingMs)],
    ['Avg moving', m.avgMph ? `${m.avgMph.toFixed(0)} mph` : '–'], ['Top speed', m.topMph ? `${m.topMph.toFixed(0)} mph` : '–'],
    ['Climbed', m.maxFt != null ? ft(m.gainFt) : '–'], ['Total time', fmtDur(m.totalMs)],
  ];
  let html = `<h3>${esc(t.name)}</h3><p class="hint">${esc(date)}${m.addedMi > 0.05 ? ` · includes ${m.addedMi.toFixed(1)} mi added by hand` : ''}${t.parts && t.parts.length > 1 ? ` · joined from ${t.parts.length} rides (Edit to separate)` : ''}</p>
    <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><small>${k}</small><b>${v}</b></div>`).join('')}</div>`;
  const elev = lineChart(m.prof.map((p) => [p[0], p[1]]), { unit: 'ft', color: '#7bd88f', fmt: (v) => Math.round(v).toLocaleString() });
  if (elev) html += `<h2>Elevation (ft)</h2><div class="chart-wrap">${elev}</div><p class="hint">${ft(m.minFt)} to ${ft(m.maxFt)} · down ${ft(m.lossFt)}</p>`;
  const speed = lineChart(m.prof.map((p) => [p[0], p[2]]), { unit: 'mph', color: '#6fa8ff', fmt: (v) => Math.round(v) });
  if (speed) html += `<h2>Speed (mph)</h2><div class="chart-wrap">${speed}</div>`;
  if (!elev && !speed) html += '<p class="hint">No speed or elevation data on this ride (traced by hand or imported without times).</p>';
  const cov = window.rideCoverage ? rideCoverage(t) : [];
  if (cov.length) {
    html += '<h2>Trails on this ride</h2><ul class="goal-list">' + cov.map((c) => {
      const kind = KIND[c.kind] ? KIND[c.kind].label : '';
      return `<li><div><b>${esc(c.name)}</b>${kind && kind !== c.name ? `<small>${esc(kind)}</small>` : ''}</div><span class="goal-pct">${fmtMi(c.m)}</span></li>`;
    }).join('') + '</ul>';
  }
  html += `<div class="rec-row"><button class="ghost" data-a="show">Show on map</button><button class="ghost" data-a="edit">Edit</button><button class="ghost" data-a="gpx">GPX</button></div>`;
  const body = $('#ride-detail-body');
  body.innerHTML = html;
  wireCharts(body);
  body.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'show') { showTrack(t); closeSheets(); }
    if (a === 'edit') editRide(t);
    if (a === 'gpx') exportGpx(t);
  };
  openSheet('#panel-ride-detail');
}
window.showRideDetails = showRideDetails;

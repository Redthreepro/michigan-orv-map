'use strict';
// Ride summary card (a shareable picture of one ride) and season stats + milestones.

// ---------- shared helpers ----------
const doneRides = async () => (await allTracks().catch(() => [])).filter((t) => t.done && t.segs && t.segs.length).sort((a, b) => a.start - b.start);
// goal miles your machine can ride that these rides covered
function goalMilesCovered(rides) {
  if (!rides.length) return 0;
  return coverItems(prepGoal(), rideIndex(rides)).filter((c) => fits(c.item.f.properties)).reduce((s, c) => s + c.riddenM, 0);
}
// trail miles this ride added that no earlier ride had covered
async function newTrailMiles(t) {
  const before = (await doneRides()).filter((r) => r.start < t.start && r.id !== t.id);
  return Math.max(0, goalMilesCovered([...before, t]) - goalMilesCovered(before)) / 1609.344;
}
// counties a ride passed through (cached per ride; checks a point about every 1 km)
const countyCache = store.get('rideCounties', {});
function rideCounties(t) {
  if (countyCache[t.id]) return countyCache[t.id];
  if (!window.countyAt) return [];
  const found = new Set();
  let run = Infinity;
  for (const seg of t.segs) for (let i = 0; i < seg.length; i++) {
    if (i) run += hav(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
    if (run < 1000) continue;
    run = 0;
    const c = countyAt(seg[i][0], seg[i][1]);
    if (c) found.add(c.n);
  }
  const list = [...found];
  if (list.length || typeof COUNTIES !== 'undefined' && COUNTIES) { countyCache[t.id] = list; store.set('rideCounties', countyCache); }
  return list;
}

// ---------- ride card ----------
const CARD_W = 1080, CARD_H = 1350, MAP_H = 820;
function lonX(lon, z) { return ((lon + 180) / 360) * 256 * 2 ** z; }
function latY(lat, z) { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; }
function loadImg(src) {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => res(null), 7000);
    img.onload = () => { clearTimeout(t); res(img); };
    img.onerror = () => { clearTimeout(t); res(null); };
    img.src = src;
  });
}
async function drawCardMap(ctx, t) {
  const pts = t.segs.flat();
  let a = 90, b = 180, c = -90, d = -180;
  for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
  // the closest zoom where the whole ride fits with a margin
  let z = 16;
  for (; z > 4; z--) if (lonX(d, z) - lonX(b, z) < CARD_W * 0.8 && latY(a, z) - latY(c, z) < MAP_H * 0.8) break;
  const cx = (lonX(b, z) + lonX(d, z)) / 2, cy = (latY(a, z) + latY(c, z)) / 2;
  const ox = cx - CARD_W / 2, oy = cy - MAP_H / 2;
  ctx.fillStyle = '#2a3027'; ctx.fillRect(0, 0, CARD_W, MAP_H);
  const tiles = [];
  for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + CARD_W) / 256); tx++) for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + MAP_H) / 256); ty++) {
    tiles.push(loadImg(BASES.topo.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)).then((img) => img && ctx.drawImage(img, tx * 256 - ox, ty * 256 - oy, 256, 256)));
  }
  await Promise.all(tiles);
  // soften the map a touch so the ride line pops
  ctx.fillStyle = 'rgba(20,24,18,0.18)'; ctx.fillRect(0, 0, CARD_W, MAP_H);
  const xy = (p) => [lonX(p[1], z) - ox, latY(p[0], z) - oy];
  const manual = new Set(t.manual || []);
  for (const [w, col] of [[14, '#ffffff'], [8, (window.COLORS && COLORS.track) || '#ff2fd0']]) {
    ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    t.segs.forEach((seg, k) => {
      ctx.setLineDash(manual.has(k) ? [18, 14] : []);
      ctx.beginPath();
      seg.forEach((p, i) => { const [x, y] = xy(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    });
  }
  ctx.setLineDash([]);
  const dot = (p, fill) => { const [x, y] = xy(p); ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke(); };
  dot(pts[0], '#2fbf4a');
  dot(pts[pts.length - 1], '#e53935');
}
async function rideCardBlob(t) {
  const m = rideMetrics(t);
  const [fresh, trails] = [await newTrailMiles(t), window.rideCoverage ? rideCoverage(t) : []];
  const cv = document.createElement('canvas');
  cv.width = CARD_W; cv.height = CARD_H;
  const ctx = cv.getContext('2d');
  await drawCardMap(ctx, t);
  // bottom panel
  ctx.fillStyle = '#1b1f1a'; ctx.fillRect(0, MAP_H, CARD_W, CARD_H - MAP_H);
  ctx.fillStyle = '#f28c28'; ctx.fillRect(0, MAP_H, CARD_W, 8);
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.fillStyle = '#eef1ea'; ctx.font = font(800, 54);
  ctx.fillText(t.name.length > 30 ? t.name.slice(0, 29) + '…' : t.name, 48, MAP_H + 84);
  ctx.fillStyle = '#a3ab9f'; ctx.font = font(500, 32);
  ctx.fillText(new Date(t.start).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), 48, MAP_H + 130);
  const hrs = (ms) => { const mm = Math.round(ms / 60000); return mm < 60 ? `${mm} min` : `${Math.floor(mm / 60)}h ${mm % 60}m`; };
  const cells = [
    [m.mi.toFixed(1), 'miles'], [hrs(m.movingMs), 'moving'], [m.avgMph ? Math.round(m.avgMph) + '' : '–', 'avg mph'],
    [m.topMph ? Math.round(m.topMph) + '' : '–', 'top mph'], [m.gainFt ? Math.round(m.gainFt).toLocaleString() : '–', 'ft climbed'], [fresh.toFixed(1), 'mi of new trail'],
  ];
  cells.forEach(([v, l], i) => {
    const x = 48 + (i % 3) * 336, y = MAP_H + 220 + Math.floor(i / 3) * 120;
    ctx.fillStyle = i === 5 ? ((window.COLORS && COLORS.ridden) || '#00e676') : '#eef1ea'; ctx.font = font(800, 58); ctx.fillText(v, x, y);
    ctx.fillStyle = '#a3ab9f'; ctx.font = font(500, 28); ctx.fillText(l, x, y + 38);
  });
  const names = trails.slice(0, 3).map((r) => r.name).join(' · ');
  if (names) { ctx.fillStyle = '#d6dccf'; ctx.font = font(600, 30); ctx.fillText(names.length > 58 ? names.slice(0, 57) + '…' : names, 48, CARD_H - 70); }
  ctx.fillStyle = '#f28c28'; ctx.font = font(800, 28); ctx.fillText('Michigan ORV Map', 48, CARD_H - 26);
  ctx.fillStyle = '#6f776b'; ctx.font = font(500, 22); ctx.fillText('Map: USGS The National Map', CARD_W - 330, CARD_H - 26);
  return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9)); // ~4x smaller than PNG: easy to text
}
async function shareRideCard(t) {
  toast('Making your ride card…');
  const blob = await rideCardBlob(t);
  const name = t.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.jpg';
  const file = new File([blob], name, { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  // the phone only opens its share sheet straight from a tap, so the picture is made first, then you tap Share
  $('#sheet-body').innerHTML = `<h3>Ride card</h3><img class="card-preview" src="${url}" alt="Ride card for ${esc(t.name)}">
    <button class="primary" data-a="share">Share</button>
    <p class="hint">Or press and hold the picture to save it to your photos.</p>`;
  $('#sheet-body').onclick = async (e) => {
    if (e.target.closest('button')?.dataset.a !== 'share') return;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: t.name }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  openSheet('#sheet');
}
window.shareRideCard = shareRideCard;
window.rideCardBlob = rideCardBlob;

// ---------- season stats ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function summarizeRides(rides) {
  const s = { rides: rides.length, mi: 0, movingMs: 0, days: new Set(), longest: null, topMph: 0, gainFt: 0, months: Array(12).fill(0), counties: new Map(), camps: 0 };
  for (const t of rides) {
    const m = rideMetrics(t);
    s.mi += m.mi; s.movingMs += m.movingMs; s.gainFt += m.gainFt || 0;
    if (m.topMph > s.topMph) s.topMph = m.topMph;
    if (!s.longest || m.mi > s.longest.mi) s.longest = { mi: m.mi, name: t.name, at: t.start };
    for (const seg of t.segs) for (const p of seg) if (p[3]) s.days.add(new Date(p[3]).toDateString());
    s.months[new Date(t.start).getMonth()] += m.mi;
    for (const c of rideCounties(t)) s.counties.set(c, (s.counties.get(c) || 0) + 1);
    s.camps += (t.camps || []).length;
  }
  return s;
}
// milestones: [key, label, value(stats), target]
function milestoneDefs(season, all, goal) {
  const L = [];
  L.push(['first', 'First ride logged', all.rides, 1]);
  for (const n of [50, 100, 250, 500, 1000, 2500]) L.push(['season' + n, `${n.toLocaleString()} miles this season`, season.mi, n]);
  for (const n of [100, 500, 1000, 2500, 5000]) L.push(['all' + n, `${n.toLocaleString()} miles all time`, all.mi, n]);
  for (const n of [50, 100]) L.push(['day' + n, `A ${n}-mile ride`, all.longest ? all.longest.mi : 0, n]);
  for (const n of [5, 10, 20, 40]) L.push(['county' + n, `Rode in ${n} counties`, all.counties.size, n]);
  for (const n of [1, 5, 10, 25]) L.push(['sys' + n, `Finished ${n} trail system${n > 1 ? 's' : ''}`, goal.done, n]);
  for (const n of [1, 5, 10, 25, 50, 75, 100]) L.push(['goal' + n, `${n}% of every Michigan trail`, goal.pct, n]);
  L.push(['camp', 'A camp night on a ride', all.camps, 1]);
  return L;
}
function goalNow() {
  const g = goalSummary();
  return { done: g.done.length, pct: g.totalM ? (100 * g.riddenM) / g.totalM : 0, near: g.list.filter((x) => x.riddenM >= x.totalM * 0.5 && x.riddenM < x.totalM * 0.9), doneList: g.done };
}
// the trail-goal numbers for just these rides (for "what did this ride unlock")
function goalFor(rides) {
  const cov = new Map((rides.length ? coverItems(prepGoal(), rideIndex(rides)) : []).map((c) => [c.item, c.riddenM]));
  const sys = new Map();
  let total = 0, ridden = 0;
  for (const it of prepGoal()) {
    const p = it.f.properties;
    if (!fits(p)) continue;
    const key = p.t + '|' + (p.n || p.t);
    const s = sys.get(key) || { t: 0, r: 0 };
    const m = cov.get(it) || 0;
    s.t += it.lenM; s.r += m; total += it.lenM; ridden += m;
    sys.set(key, s);
  }
  return { done: [...sys.values()].filter((s) => s.r >= s.t * 0.9).length, pct: total ? (100 * ridden) / total : 0 };
}
function earnedKeys(rides) {
  const year = new Date().getFullYear();
  const all = summarizeRides(rides), season = summarizeRides(rides.filter((t) => new Date(t.start).getFullYear() === year));
  return new Set(milestoneDefs(season, all, goalFor(rides)).filter(([, , v, n]) => v >= n).map(([k]) => k));
}

let statsYear = null;
async function showStats() {
  const rides = await doneRides();
  const years = [...new Set(rides.map((t) => new Date(t.start).getFullYear()))].sort((a, b) => b - a);
  const nowYear = new Date().getFullYear();
  if (!years.includes(nowYear)) years.unshift(nowYear);
  if (statsYear === null) statsYear = nowYear;
  const pick = statsYear === 'all' ? rides : rides.filter((t) => new Date(t.start).getFullYear() === statsYear);
  const s = summarizeRides(pick), all = statsYear === 'all' ? s : summarizeRides(rides);
  const season = summarizeRides(rides.filter((t) => new Date(t.start).getFullYear() === nowYear));
  const goal = goalNow();
  const hrs = (ms) => (ms / 3600000).toFixed(ms < 36000000 ? 1 : 0);
  const maxMonth = Math.max(1, ...s.months);
  let html = `<h3>My stats</h3>
    <div class="seg" id="stats-years">${years.map((y) => `<button data-y="${y}" class="${statsYear === y ? 'on' : ''}">${y}</button>`).join('')}<button data-y="all" class="${statsYear === 'all' ? 'on' : ''}">All time</button></div>
    <div class="stat-grid">
      <div><b>${s.mi.toFixed(0)}</b><small>miles</small></div><div><b>${s.rides}</b><small>rides</small></div><div><b>${s.days.size}</b><small>days out</small></div>
      <div><b>${hrs(s.movingMs)}</b><small>hours moving</small></div><div><b>${s.longest ? s.longest.mi.toFixed(0) : 0}</b><small>longest ride (mi)</small></div><div><b>${s.topMph ? Math.round(s.topMph) : 0}</b><small>top mph</small></div>
    </div>`;
  if (s.rides) {
    html += `<h2>Miles by month</h2><div class="month-bars">${s.months.map((v, i) => `<div><span style="height:${Math.round((70 * v) / maxMonth)}px"></span><small>${MONTHS[i][0]}</small></div>`).join('')}</div>`;
    const cs = [...s.counties.keys()].sort();
    html += `<h2>Counties ridden: ${cs.length}</h2>${cs.length ? `<p class="county-chips">${cs.map((c) => `<span>${esc(c)}</span>`).join('')}</p>` : '<p class="hint">Counties show up once the county map has loaded.</p>'}`;
  }
  html += `<h2>Trail systems finished: ${goal.done}</h2>`;
  html += goal.doneList.length ? `<p class="county-chips">${goal.doneList.map((x) => `<span class="done">${esc(x.name)}</span>`).join('')}</p>` : '<p class="hint">Ride 90% of a trail system (like the Little Manistee Route) to finish it.</p>';
  if (goal.near.length) html += `<p class="hint">Over halfway: ${goal.near.slice(0, 6).map((x) => `${esc(x.name)} (${Math.round((100 * x.riddenM) / x.totalM)}%)`).join(', ')}</p>`;
  // milestones: earned, then the next few to go for
  const defs = milestoneDefs(season, all, goal);
  const earned = defs.filter(([, , v, n]) => v >= n), next = [];
  const seenGroup = new Set();
  for (const d of defs) {
    const group = d[0].replace(/\d+$/, '');
    if (d[2] >= d[3] || seenGroup.has(group)) continue;
    seenGroup.add(group); next.push(d);
  }
  html += `<h2>Milestones: ${earned.length} of ${defs.length}</h2><ul class="along milestones">`;
  html += earned.map(([, l]) => `<li class="got"><b>✓ ${esc(l)}</b></li>`).join('');
  html += next.slice(0, 5).map(([, l, v, n]) => { const p = Math.min(100, (100 * v) / n); return `<li><b>${esc(l)}</b><small>${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} of ${n}</small><div class="goal-bar"><span style="width:${p.toFixed(1)}%"></span></div></li>`; }).join('');
  html += '</ul>';
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = (e) => {
    const b = e.target.closest('[data-y]');
    if (b) { statsYear = b.dataset.y === 'all' ? 'all' : +b.dataset.y; showStats(); }
  };
  openSheet('#sheet');
}
window.showStats = showStats;
$('#btn-stats').addEventListener('click', showStats);

// a ride just saved: which milestones did it unlock?
window.newMilestonesHtml = async (ride) => {
  const rides = await doneRides();
  const before = earnedKeys(rides.filter((t) => t.id !== ride.id));
  const after = earnedKeys(rides);
  const year = new Date().getFullYear();
  const all = summarizeRides(rides), season = summarizeRides(rides.filter((t) => new Date(t.start).getFullYear() === year));
  const fresh = milestoneDefs(season, all, goalFor(rides)).filter(([k]) => after.has(k) && !before.has(k));
  return fresh.length ? `<div class="milestone-new">${fresh.map(([, l]) => `<b>New milestone: ${esc(l)}!</b>`).join('')}</div>` : '';
};

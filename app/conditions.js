'use strict';
// Trail conditions: (1) county roads open to ORVs, by county (reported status, see build_counties.py),
// and (2) a mud forecast: rain over the last 3 days along a trip (Open-Meteo, free, no key) plus crew
// and your own trail reports along the route.

// ---------- county roads ----------
let COUNTIES = null;
const COUNTY_STYLE = {
  open: { label: 'open to ORVs', color: '#2fbf4a', fill: 0.16 },
  mostly: { label: 'mostly open to ORVs', color: '#9ccc65', fill: 0.14 },
  partial: { label: 'partly open to ORVs (some roads or townships)', color: '#ffd400', fill: 0.14 },
  none: { label: 'not open to ORVs (no county ordinance reported)', color: '#9e9e9e', fill: 0.06 },
};
map.createPane('county', map.getPane('rotatePane') || map.getPane('mapPane')).style.zIndex = 340;
map.getPane('county').style.pointerEvents = 'none';
const countyLayer = L.layerGroup();
fetch('data/counties.geojson').then((r) => r.json()).then((fc) => {
  COUNTIES = fc.features;
  L.geoJSON(fc, {
    pane: 'county', interactive: false,
    style: (f) => { const s = COUNTY_STYLE[f.properties.st] || COUNTY_STYLE.none; return { color: s.color, weight: 1.5, opacity: 0.7, fillColor: s.color, fillOpacity: s.fill, dashArray: f.properties.st === 'none' ? '4 4' : null }; },
  }).addTo(countyLayer);
  applyCounty();
}).catch(() => {});
function applyCounty() { if (shown.county) countyLayer.addTo(map); else map.removeLayer(countyLayer); }
const countyBox = document.querySelector('[data-kind="county"]');
if (countyBox) { countyBox.checked = !!shown.county; countyBox.addEventListener('change', applyCounty); }

// inRing(x=lng, y=lat, ring) lives in places.js
function countyAt(lat, lng) {
  for (const f of COUNTIES || []) {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)))) return f.properties;
  }
  return null;
}
const countyByName = (n) => (COUNTIES || []).map((f) => f.properties).find((p) => p.n === n) || null;
function countyLine(c, long) {
  if (!c) return '';
  const s = COUNTY_STYLE[c.st] || COUNTY_STYLE.none;
  const when = c.upd ? (c.ok ? ` (county ordinance, ${c.upd})` : ` (reported ${c.upd})`) : '';
  return `${c.n} County roads: ${s.label}${c.note && c.st !== 'none' ? '. ' + c.note : ''}${when}.${long ? ' Confirm with the county sheriff before riding a road.' : ''}`;
}
window.countyAt = countyAt;
window.countyRoadShort = (name) => { const c = countyByName(name); return c ? (COUNTY_STYLE[c.st] || COUNTY_STYLE.none).label + (c.upd ? ` (${c.ok ? 'ordinance' : 'reported'} ${c.upd})` : '') : null; };
window.countyRoadText = (lat, lng) => countyLine(countyAt(lat, lng), true);
window.countySource = (lat, lng) => { const c = countyAt(lat, lng); return c ? c.src : null; };

// ---------- mud forecast ----------
// rain over the last 3 days (and tomorrow's forecast) at points along a trip
const rainCache = new Map();
async function rainAt(points) {
  const key = points.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(';') + '|' + new Date().getHours();
  if (rainCache.has(key)) return rainCache.get(key);
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: points.map((p) => p[0].toFixed(3)).join(','), longitude: points.map((p) => p[1].toFixed(3)).join(','),
    daily: 'precipitation_sum', past_days: '3', forecast_days: '2', timezone: 'America/Detroit', precipitation_unit: 'inch',
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('rain');
  let j = await r.json();
  if (!Array.isArray(j)) j = [j];
  const out = j.map((x, i) => {
    const d = (x.daily && x.daily.precipitation_sum) || [];
    const past = (d[0] || 0) + (d[1] || 0) + (d[2] || 0);
    return { at: points[i], past, today: d[3] || 0, tomorrow: d[4] || 0 };
  });
  rainCache.set(key, out);
  return out;
}
function mudLevel(x) {
  const wet = x.past + x.today * 0.5;
  return wet >= 1 ? 3 : wet >= 0.4 ? 2 : wet >= 0.15 ? 1 : 0;
}
const inches = (v) => (v < 0.05 ? 'no' : v.toFixed(v < 1 ? 2 : 1) + ' in of');
// points about every 8 miles along the planned trip (start and end included, at most 8)
function tripSamplePts() {
  const path = (typeof planLegs !== 'undefined' ? planLegs : []).flatMap((r) => r.path || []);
  if (path.length < 2) return [];
  const out = [path[0]];
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    run += hav(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (run > 12875) { out.push(path[i]); run = 0; }
  }
  out.push(path[path.length - 1]);
  const step = Math.ceil(out.length / 8);
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}
window.fillTripMud = async () => {
  const box = document.getElementById('trip-mud');
  if (!box) return;
  const pts = tripSamplePts();
  if (!pts.length) return;
  if (!navigator.onLine) { box.innerHTML = '<p class="hint">Rain and mud check needs signal. Open the trip once with signal before you go.</p>'; return; }
  try {
    const rain = await rainAt(pts);
    const worst = rain.reduce((a, b) => (mudLevel(b) > mudLevel(a) || (mudLevel(b) === mudLevel(a) && b.past > a.past) ? b : a));
    const wetTomorrow = rain.reduce((a, b) => (b.tomorrow > a.tomorrow ? b : a));
    const lvl = mudLevel(worst);
    const where = window.placeNear ? placeNear(worst.at[0], worst.at[1]) : '';
    const text = lvl === 3 ? `Expect mud: ${inches(worst.past)} rain in the last 3 days${where ? ' ' + where : ''}. Watch for standing water and washouts; low spots and clay will be slick.`
      : lvl === 2 ? `Some mud likely: ${inches(worst.past)} rain in the last 3 days${where ? ' ' + where : ''}. Low areas may be wet.`
        : lvl === 1 ? `Mostly dry: a little rain lately (${worst.past.toFixed(2)} in over 3 days).`
          : 'Dry: no real rain along the route in the last 3 days.';
    const tom = wetTomorrow.tomorrow >= 0.25 ? ` Rain is forecast tomorrow (${wetTomorrow.tomorrow.toFixed(2)} in).` : '';
    box.className = 'mud mud-' + lvl;
    box.innerHTML = `<b>Trail conditions</b><span>${esc(text + tom)}</span>`;
  } catch {
    box.innerHTML = '<p class="hint">Couldn\'t check recent rain right now.</p>';
  }
};
// one spot (a trail's info sheet)
window.fillRainAt = async (lat, lng) => {
  const el = document.getElementById('trail-rain');
  if (!el || !navigator.onLine) return;
  try {
    const [x] = await rainAt([[lat, lng]]);
    const lvl = mudLevel(x);
    el.textContent = `Rain here, last 3 days: ${x.past < 0.05 ? 'none' : x.past.toFixed(2) + ' in'}${lvl >= 2 ? ' (expect mud)' : ''}${x.tomorrow >= 0.25 ? ` · ${x.tomorrow.toFixed(2)} in forecast tomorrow` : ''}`;
    el.className = 'hint' + (lvl >= 2 ? ' warn' : '');
  } catch {}
};

// trail reports (yours and your crew's) near the planned route, newest first
const ROUTE_REPORT_M = 300;
const REPORT_DAYS = 21;
window.reportsAlongTrip = () => {
  const path = (typeof planLegs !== 'undefined' ? planLegs : []).flatMap((r) => r.path || []);
  if (path.length < 2) return [];
  const mine = (typeof waypoints !== 'undefined' ? waypoints : []).filter((w) => w.type === 'report').map((w) => ({ ...w, byName: 'you' }));
  const crew = (window.crewReportsList ? crewReportsList() : []);
  const all = [...mine, ...crew].filter((r) => Date.now() - (r.at || 0) < REPORT_DAYS * 86400000);
  const step = Math.max(1, Math.floor(path.length / 2000)); // plenty of points to check against, kept cheap
  const out = [];
  for (const r of all) {
    let best = Infinity;
    for (let i = 0; i < path.length; i += step) { const d = hav(r.lat, r.lng, path[i][0], path[i][1]); if (d < best) best = d; if (best < ROUTE_REPORT_M) break; }
    if (best < ROUTE_REPORT_M) out.push(r);
  }
  return out.sort((a, b) => b.at - a.at);
};

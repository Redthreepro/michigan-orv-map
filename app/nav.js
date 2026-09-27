'use strict';
// Riding a planned route: next-turn banner, heading-up map, auto zoom, arrival. No voice.

const ride = { on: false, headingUp: store.get('headingUp', true), lastUserZoom: 0, autoZoom: false, heading: null };
const TURN_SAMPLE_M = 25;   // look this far back/ahead to measure a turn
const MIN_RUN_M = 300;      // a trail stretch shorter than this isn't worth its own instruction
const JUNCTION_TURN_DEG = 60;  // only real turns at junctions when you stay on the same trail
const GENERIC_MAX_M = 1600;   // unnamed forest-road stretches shorter than this are just the route running on the road
const GENERIC = /^(State forest road|National forest road|trail)$/;

// ---------- turn list ----------
function bearingDeg(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function turnAt(r, i) {
  let j = i, k = i;
  while (j > 0 && r.cum[i] - r.cum[j] < TURN_SAMPLE_M) j--;
  while (k < r.path.length - 1 && r.cum[k] - r.cum[i] < TURN_SAMPLE_M) k++;
  if (j === i || k === i) return 0;
  const d = bearingDeg(r.path[i], r.path[k]) - bearingDeg(r.path[j], r.path[i]);
  return ((d + 540) % 360) - 180; // negative = left
}
function turnWords(d) {
  const a = Math.abs(d), side = d < 0 ? 'left' : 'right';
  return a < 25 ? 'Continue' : a < 60 ? `Bear ${side}` : a < 140 ? `Turn ${side}` : `Sharp ${side}`;
}
function nodeAtLegStart(leg) {
  const c = G.geom[leg.e];
  const [lat, lng] = leg.coords[0];
  return Math.abs(c[1] / 1e5 - lat) < 1e-5 && Math.abs(c[0] / 1e5 - lng) < 1e-5 ? G.eu[leg.e] : G.ev[leg.e];
}

function maneuvers(r, dest) {
  const out = [];
  const total = r.cum[r.cum.length - 1] || 0;
  if (r.legs.length) {
    // stretches of the same trail/road name
    const runs = [];
    let idx = 0;
    r.legs.forEach((leg, k) => {
      const [kind, , name] = G.attrs[G.eattr[leg.e]];
      const label = kind === 'connector' ? null : (name || (KIND[kind] ? KIND[kind].label : 'trail'));
      const start = idx;
      idx += leg.coords.length;
      const last = runs[runs.length - 1];
      if (last && (!label || last.label === label)) { last.endIdx = idx - 1; last.legs.push(k); }
      else runs.push({ label: label || 'trail', startIdx: start, endIdx: idx - 1, legs: [k] });
    });
    // short blips (a few hundred feet of road between two stretches of the same route) aren't instructions
    for (let i = runs.length - 2; i > 0; i--) {
      if (r.cum[runs[i].endIdx] - r.cum[runs[i].startIdx] < MIN_RUN_M) { runs[i - 1].endIdx = runs[i].endIdx; runs[i - 1].legs.push(...runs[i].legs); runs.splice(i, 1); }
    }
    // routes often run on top of unnamed forest roads; a short unnamed stretch isn't a real change of trail
    for (let i = runs.length - 1; i > 0; i--) {
      if (GENERIC.test(runs[i].label) && r.cum[runs[i].endIdx] - r.cum[runs[i].startIdx] < GENERIC_MAX_M && i < runs.length - 1) {
        runs[i - 1].endIdx = runs[i].endIdx; runs[i - 1].legs.push(...runs[i].legs); runs.splice(i, 1);
      }
    }
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].label === runs[i - 1].label) { runs[i - 1].endIdx = runs[i].endIdx; runs[i - 1].legs.push(...runs[i].legs); runs.splice(i, 1); }
    }
    runs.forEach((run, i) => {
      if (i > 0) {
        const d = turnAt(r, run.startIdx);
        out.push({ at: r.cum[run.startIdx], deg: d, text: `${turnWords(d)} onto ${run.label}` });
      }
      // real junctions inside a stretch where you turn to stay on the same trail
      let pos = run.startIdx;
      for (const k of run.legs) {
        const leg = r.legs[k];
        if (pos > run.startIdx && k > 0) {
          const node = nodeAtLegStart(leg);
          const branches = G.adj[node].filter(allowed).length;
          const d = turnAt(r, pos);
          if (branches >= 3 && Math.abs(d) >= JUNCTION_TURN_DEG && !out.some((m) => Math.abs(m.at - r.cum[pos]) < 60)) {
            out.push({ at: r.cum[pos], deg: d, text: `${turnWords(d)} to stay on ${run.label}` });
          }
        }
        pos += leg.coords.length;
      }
    });
  }
  out.push(r.gap
    ? { at: total, type: 'gap', text: `Mapped trail ends. ${fmtMi(r.gap.meters)} to ${dest} has no DNR trail` }
    : { at: total, type: 'arrive', text: `Arrive at ${dest}` });
  return tidy(out.sort((a, b) => a.at - b.at));
}

// Drop noise: turns in the first few yards, a right-then-left jog across a road, and two prompts for one spot.
function tidy(list) {
  const out = [];
  const end = list.length ? list[list.length - 1].at : 0;
  // skip turns in the first few yards and right on top of the arrival
  for (const m of list.filter((x) => x.type || (x.at > 30 && end - x.at > 60))) {
    const prev = out[out.length - 1];
    // a right-then-left (or left-then-right) jog across a road within ~500 ft cancels out
    if (prev && !m.type && !prev.type && m.at - prev.at < 160 && Math.abs(prev.deg + m.deg) < 30
        && /stay on/.test(prev.text) && /stay on/.test(m.text)) { out.pop(); continue; }
    if (prev && !m.type && !prev.type && m.at - prev.at < 80) {
      if (/onto/.test(m.text) || (!/onto/.test(prev.text) && Math.abs(m.deg) > Math.abs(prev.deg))) out[out.length - 1] = m;
      continue;
    }
    // "Continue onto X" at a gentle bend is only worth saying when X is a named trail
    if (!m.type && Math.abs(m.deg) < 25 && GENERIC.test(m.text.replace(/^Continue onto /, ''))) continue;
    out.push(m);
  }
  return out;
}

// ---------- banner ----------
const fmtNavDist = (m) => (m < 150 ? `${Math.max(50, Math.round(m * 3.281 / 50) * 50)} ft` : `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`);
const ARROW_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2 4.5 10H10v12h4V10h5.5z" fill="currentColor"/></svg>';
const FLAG_SVG = '<svg viewBox="0 0 24 24"><path d="M6 22V3h12l-3 4.5L18 12H8v10z" fill="currentColor"/></svg>';

function setBanner({ icon, deg = 0, dist, text, sub }) {
  const b = $('#nav-banner');
  b.querySelector('.nav-arrow').innerHTML = icon === 'flag' ? FLAG_SVG : ARROW_SVG;
  b.querySelector('.nav-arrow').style.transform = icon === 'flag' ? '' : `rotate(${Math.max(-150, Math.min(150, deg))}deg)`;
  b.querySelector('.nav-dist').textContent = dist || '';
  b.querySelector('.nav-text').textContent = text;
  b.querySelector('.nav-sub').textContent = sub || '';
}

window.onNavPos = (near, pos) => {
  if (!ride.on) return;
  const r = planLegs[near.leg];
  if (!r || !r.path.length) return;
  const dest = plan.stops[near.leg + 1].name;
  if (!r.man) r.man = maneuvers(r, dest);
  const legLen = r.cum[r.cum.length - 1] || 0;
  const next = r.man.find((m) => m.at > near.at + 10) || r.man[r.man.length - 1];
  const dist = Math.max(0, next.at - near.at);
  const off = near.d > OFF_ROUTE_M;

  if (next.type !== 'gap' && legLen - near.at < 40) {
    const more = planLegs[near.leg + 1];
    setBanner({ icon: 'flag', text: `Arrived at ${dest}`,
      sub: more ? `Next: ${fmtMi(more.meters)} to ${plan.stops[near.leg + 2].name}` : 'End of your route' });
  } else {
    const after = r.man[r.man.indexOf(next) + 1];
    setBanner({
      icon: next.type ? 'flag' : 'arrow', deg: next.deg, dist: fmtNavDist(dist), text: next.text,
      sub: off && near.at < 30 ? `The route starts at the nearest trail you can ride, ${fmtNavDist(near.d)} away.`
        : off ? 'Off route. Head back to the blue line; a new route comes if you keep going.'
        : after && after.at - next.at < 300 ? `Then ${after.text.charAt(0).toLowerCase()}${after.text.slice(1)}`
          : `${fmtMi(legLen - near.at)} to ${dest}`,
    });
  }

  // zoom in as a turn gets close, unless you zoomed yourself in the last 20 s
  if (follow && Date.now() - ride.lastUserZoom > 20000) {
    const want = dist < 400 ? 16 : dist < 1600 ? 15 : 14;
    if (map.getZoom() !== want) { ride.autoZoom = true; map.setZoom(want); }
  }

  // heading-up: turn the map so your direction of travel points up (only when moving)
  const { heading, speed } = pos.coords;
  if (heading != null && !isNaN(heading) && speed > 1.5) ride.heading = heading;
  if (ride.headingUp && follow && ride.heading != null && map.setBearing) map.setBearing(-ride.heading);
  updateCompass();
};

map.on('zoomstart', () => { if (!ride.autoZoom) ride.lastUserZoom = Date.now(); ride.autoZoom = false; });

// ---------- start / stop ----------
function startNav() {
  if (!plan || !planLegs.length) return toast('Plan a route first');
  ride.on = true;
  for (const r of planLegs) r.man = null;
  document.body.classList.add('navigating');
  $('#nav-banner').hidden = false;
  setBanner({ icon: 'arrow', text: 'Waiting for GPS…', sub: 'Keep the screen on while you ride. Set Auto-Lock to Never.' });
  closeSheets();
  ensureGpsFix();
  follow = true;
  setLocState();
  // our own zooms (plan fit, this one) aren't "you zoomed", so auto zoom starts right away
  if (meMarker) { ride.autoZoom = true; map.setView(meMarker.getLatLng(), 15); }
  ride.lastUserZoom = 0;
  updateCompass();
}
function stopNav() {
  ride.on = false;
  document.body.classList.remove('navigating');
  $('#nav-banner').hidden = true;
  if (map.setBearing) map.setBearing(0);
  updateCompass();
}
window.startNav = startNav;
$('#nav-banner .nav-end').addEventListener('click', (e) => { e.stopPropagation(); stopNav(); });
$('#nav-banner').addEventListener('click', () => showPlan());

// ---------- compass: heading-up / north-up ----------
function updateCompass() {
  const btn = $('#btn-compass');
  const bearing = map.getBearing ? map.getBearing() : 0;
  btn.hidden = !ride.on && Math.abs(bearing) < 0.5;
  btn.classList.toggle('on', ride.on && ride.headingUp);
  btn.querySelector('svg').style.transform = `rotate(${bearing}deg)`; // needle keeps pointing north
}
$('#btn-compass').addEventListener('click', () => {
  if (!ride.on) { if (map.setBearing) map.setBearing(0); return updateCompass(); }
  ride.headingUp = !ride.headingUp;
  store.set('headingUp', ride.headingUp);
  if (!ride.headingUp && map.setBearing) map.setBearing(0);
  else if (ride.heading != null && map.setBearing) map.setBearing(-ride.heading);
  toast(ride.headingUp ? 'Heading up: the map turns as you ride' : 'North up');
  updateCompass();
});
map.on('rotate', updateCompass);

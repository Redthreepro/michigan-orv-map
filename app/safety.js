'use strict';
// Safety pack: SOS card, "tell someone your plan" check-in, sunset warnings while riding,
// and Michigan deer-season rules (no ORVs 7-11 a.m. and 2-5 p.m. on public hunting land, Nov 15-30).

// ---------- sun ----------
// Sunrise/sunset (standard solar position math, accurate to a minute or two).
const SUN_RAD = Math.PI / 180, J1970 = 2440588, J2000 = 2451545, DAY_MS = 864e5, OBLIQ = SUN_RAD * 23.4397;
function sunTimes(date, lat, lng) {
  const noon = new Date(date); noon.setHours(12, 0, 0, 0);
  const lw = SUN_RAD * -lng, phi = SUN_RAD * lat;
  const d = noon.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const transit = (ht) => 0.0009 + (ht + lw) / (2 * Math.PI) + n;
  const ds = transit(0);
  const M = SUN_RAD * (357.5291 + 0.98560028 * ds);
  const L = M + SUN_RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + SUN_RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(OBLIQ));
  const jt = (a) => J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const w = Math.acos((Math.sin(SUN_RAD * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const jnoon = jt(ds), jset = jt(transit(w));
  const toDate = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
  return { rise: toDate(jnoon - (jset - jnoon)), set: toDate(jset) };
}
const clock = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function whereNow() {
  if (meMarker) return meMarker.getLatLng();
  return map.getCenter();
}
function sunsetToday() { const p = whereNow(); return sunTimes(new Date(), p.lat, p.lng).set; }
window.sunsetText = () => clock(sunsetToday());

// While recording or navigating: heads-up an hour and half an hour before sunset, and when lights become required.
const sunSaid = store.get('sunSaid', {});
function sunCheck() {
  const bar = $('#sun-bar');
  const riding = (window.isRecording && isRecording()) || document.body.classList.contains('navigating');
  const set = sunsetToday(), lights = new Date(set.getTime() + 30 * 60000);
  const mins = Math.round((set - Date.now()) / 60000);
  if (!riding || mins > 60 || Date.now() > lights.getTime() + 30 * 60000) { bar.hidden = true; return; }
  const back = truckBack();
  const late = back && back.mins > (lights - Date.now()) / 60000;
  bar.hidden = false;
  bar.classList.toggle('alert', !!late || mins <= 0);
  bar.querySelector('span').textContent = mins > 0
    ? `Sunset ${clock(set)} · ${mins} min${back ? ` · truck ~${back.mi.toFixed(0)} mi` : ''}`
    : `Lights on${Date.now() >= lights ? '' : ` by ${clock(lights)}`} · it's getting dark`;
  const day = new Date().toDateString();
  const say = (key, text) => { if (sunSaid[key] !== day) { sunSaid[key] = day; store.set('sunSaid', sunSaid); toast(text); } };
  if (mins <= 60 && mins > 30) say('60', `Sunset in ${mins} min (${clock(set)}).${late ? ' Head back soon to beat dark.' : ''}`);
  if (mins <= 30 && mins > 0) say('30', `Sunset in ${mins} min. Lights are required from ${clock(lights)}.`);
  if (Date.now() >= lights) say('lights', 'Lights are required now: headlight and taillight on.');
}
// straight-line distance back to where this ride started, and a rough time for it on the trails
function truckBack() {
  if (!(window.isRecording && isRecording())) return null;
  const start = window.rideStartPoint && rideStartPoint();
  const here = meMarker && meMarker.getLatLng();
  if (!start || !here) return null;
  const mi = hav(start[0], start[1], here.lat, here.lng) / 1609.344;
  return { mi, mins: (mi * 1.4) / RIDE_MPH[0] * 60 }; // trails wander: ~1.4x the straight line, at the slow end
}
$('#sun-bar').addEventListener('click', () => {
  const set = sunsetToday(), back = truckBack();
  toast(`Sunset ${clock(set)}. Lights required from ${clock(new Date(set.getTime() + 30 * 60000))}.${back ? ` Truck is ${back.mi.toFixed(1)} mi away in a straight line, roughly ${Math.round(back.mins)} min of trail.` : ''}`);
});

// ---------- deer season ----------
// Regular firearm deer season is Nov 15-30 every year (set in law). Bow season Oct 1-Nov 14 and Dec 1-Jan 1;
// December also has short firearm/muzzleloader and late antlerless hunts.
function huntSeason(d = new Date()) {
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  if (md >= 1115 && md <= 1130) return 'firearm';
  if ((md >= 1001 && md <= 1114) || md >= 1201 || md <= 101) return 'other';
  return null;
}
function huntQuiet(d = new Date()) { const h = d.getHours() + d.getMinutes() / 60; return (h >= 7 && h < 11) || (h >= 14 && h < 17); }
window.huntSeason = huntSeason;
function huntCheck() {
  const bar = $('#hunt-bar');
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
  if (huntSeason(now) !== 'firearm' || h >= 17) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.classList.toggle('alert', huntQuiet(now));
  bar.querySelector('span').textContent = h < 7 ? 'Deer season: no riding on public land 7–11 AM'
    : h < 11 ? 'Deer season: no riding on public land until 11 AM'
      : h < 14 ? 'Deer season: no riding on public land 2–5 PM'
        : 'Deer season: no riding on public land until 5 PM';
}
function showHunting() {
  const s = huntSeason();
  $('#sheet-body').onclick = null;
  $('#sheet-body').innerHTML = `<h3>Hunting season</h3>
    <p><b>Nov 15–30 (firearm deer season):</b> state law bans riding ORVs from <b>7–11 a.m. and 2–5 p.m.</b> on land open to public hunting.
    That's state forest, state game areas, national forest and Commercial Forest land: most of the trail system.</p>
    <p class="hint">Exceptions include emergencies, getting to your home or a hunting camp you can't reach by car, hauling out a legally taken deer at 5 mph or less,
    riding on your own land, and ORV-legal county roads.</p>
    <p>${s === 'firearm' ? 'It\'s firearm season now. ' : s ? 'Hunting season is open now: hunters are in the woods. ' : ''}Turn on <b>Public hunting land</b> in Layers → Trails &amp; roads to outline the trails the hours apply to.</p>
    <p class="hint">Bow season runs Oct 1–Nov 14 and Dec 1–Jan 1, with short firearm hunts in early December. Riding is allowed then, but wear bright colors and ride slow near hunting spots.</p>
    <button class="ghost" data-a="laws">All rules &amp; permits</button>`;
  $('#sheet-body').onclick = (e) => { if (e.target.closest('[data-a="laws"]')) showLaws(); };
  openSheet('#sheet');
}
window.showHunting = showHunting;
$('#hunt-bar').addEventListener('click', showHunting);

// Layer: orange glow under trails on public hunting land (tagged by the nightly build)
let huntLayer = null;
function drawHunt(quiet) {
  if (huntLayer) { map.removeLayer(huntLayer); huntLayer = null; }
  if (!shown.hunt || typeof allByKind === 'undefined') return;
  const feats = [];
  for (const k of ['route', 'trail', 'mc', 'mccct']) for (const f of allByKind[k] || []) if (f.properties.hl && fits(f.properties)) feats.push(f);
  if (!feats.length) { if (!quiet) toast('Hunting-land trail data arrives with the next nightly update.'); return; }
  huntLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
    renderer, interactive: false, style: { color: '#ff8c00', weight: lineWeight() + 8, opacity: 0.45 },
  }).addTo(map);
  huntLayer.bringToBack();
}
window.drawHunt = drawHunt;
map.on('zoomend', () => { if (huntLayer) drawHunt(true); });
// default the layer on during firearm season
if (shown.hunt === undefined) shown.hunt = huntSeason() === 'firearm' ? 1 : 0;
const huntBox = document.querySelector('[data-kind="hunt"]');
huntBox.checked = !!shown.hunt;
huntBox.addEventListener('change', () => drawHunt());

// ---------- SOS ----------
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function nearestTown(lat, lng) {
  let best = null;
  for (const p of window.POIS || []) {
    if (p.t !== 'town') continue;
    const d = hav(lat, lng, p.lat, p.lng);
    // a bigger town a bit farther away is easier for a dispatcher to place
    const score = d / (1 + Math.log10(1 + (p.pop || 0)) / 3);
    if (!best || score < best.score) best = { p, d, score };
  }
  if (!best) return null;
  const y = Math.sin((lng - best.p.lng) * SUN_RAD) * Math.cos(lat * SUN_RAD);
  const x = Math.cos(best.p.lat * SUN_RAD) * Math.sin(lat * SUN_RAD) - Math.sin(best.p.lat * SUN_RAD) * Math.cos(lat * SUN_RAD) * Math.cos((lng - best.p.lng) * SUN_RAD);
  const brg = (Math.atan2(y, x) / SUN_RAD + 360) % 360;
  return { name: best.p.n, mi: best.d / 1609.344, dir: COMPASS[Math.round(brg / 45) % 8] };
}
function nearestHospital(lat, lng) {
  let best = null;
  for (const p of window.POIS || []) {
    if (p.t !== 'hosp') continue;
    const d = hav(lat, lng, p.lat, p.lng) * (p.er ? 1 : 1.5); // prefer ones with an emergency room
    if (!best || d < best.d) best = { p, d };
  }
  return best && { ...best, mi: hav(lat, lng, best.p.lat, best.p.lng) / 1609.344 };
}
function placeText(lat, lng) {
  const t = nearestTown(lat, lng);
  return t ? (t.mi < 1 ? `in ${t.name}` : `${t.mi.toFixed(0)} mi ${t.dir} of ${t.name}`) : '';
}
function showSOS() {
  const gps = !!meMarker;
  if (!gps) ensureGpsFix && ensureGpsFix();
  const at = whereNow();
  const ll = `${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`;
  const near = placeText(at.lat, at.lng);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${at.lat.toFixed(5)},${at.lng.toFixed(5)}`;
  const msg = `Emergency. I'm at ${ll}${near ? ` (${near})` : ''}. ${mapUrl}`;
  const hosp = nearestHospital(at.lat, at.lng);
  let html = `<h3>Emergency</h3>
    <div class="sos-loc"><b>${ll}</b><small>${near ? esc(near[0].toUpperCase() + near.slice(1)) : ''}${gps ? '' : `${near ? '. ' : ''}No GPS fix yet, so this is the middle of the map.`}</small></div>
    <button class="primary" data-a="share">Share my location</button>
    <div class="rec-row"><a class="btn danger" href="tel:911">Call 911</a><a class="btn danger" href="sms:911?&body=${encodeURIComponent(msg)}">Text 911</a></div>
    <p class="hint">No signal for a call? A text can still get through. Read the numbers above to the dispatcher.</p>`;
  if (hosp) {
    html += `<h2>Nearest hospital</h2><div class="sos-hosp"><b>${esc(hosp.p.n)}</b><small>${hosp.mi.toFixed(0)} mi away${hosp.p.city ? ` · ${esc(hosp.p.city)}` : ''}${hosp.p.er ? ' · emergency room' : ''}</small></div>
      <div class="rec-row"><button class="ghost" data-a="hosp-go">Directions</button>${hosp.p.ph ? `<a class="btn ghost" href="tel:${esc(hosp.p.ph.replace(/[^\d+]/g, ''))}">Call</a>` : ''}</div>`;
  }
  if (window.watchShared && watchShared()) html += window.cloudSOSActive && cloudSOSActive()
    ? '<button class="primary alt" data-a="family-ok">I\'m OK now: cancel the family alert</button>'
    : '<button class="primary sos-family" data-a="family">Alert my family (Ride Watch link)</button>';
  html += `<h2>Before you lose signal</h2><button class="ghost" data-a="checkin">Tell someone your plan</button>`;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'share') {
      if (navigator.share) { try { await navigator.share({ title: 'My location', text: msg }); return; } catch (err) { if (err.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(msg); toast('Location copied. Paste it in a text.'); } catch { prompt('Copy your location:', msg); }
    }
    if (a === 'hosp-go') driveTo(hosp.p.lat, hosp.p.lng);
    if (a === 'checkin') showCheckin();
    if (a === 'family') { const ok = window.cloudSOS && await cloudSOS(at.lat, at.lng); toast(ok ? 'Alert sent to your family link. With no signal it sends as soon as you get one.' : 'Sign in under Crew & Ride Watch first.'); if (ok) showSOS(); }
    if (a === 'family-ok') { await cloudSOSClear(); toast('Alert cancelled. Your family link shows you\'re OK.'); showSOS(); }
  };
  openSheet('#sheet');
}
window.showSOS = showSOS;

// ---------- tell someone your plan ----------
function planSummary() {
  if (typeof plan !== 'undefined' && plan && plan.stops.length >= 2 && planLegs.length) {
    const t = planLegs.reduce((s, r) => s + r.meters, 0);
    return `${fmtMi(t)} trip: ${plan.stops.map((s) => s.mine ? 'my location' : s.name).join(' → ')}`;
  }
  if (typeof selItems !== 'undefined' && selItems.length) return `riding ${selItems.map((s) => s.name).join(', ')}`;
  return '';
}
function showCheckin() {
  const at = whereNow();
  const near = placeText(at.lat, at.lng);
  const def = new Date(Date.now() + 4 * 3600000);
  def.setMinutes(Math.ceil(def.getMinutes() / 15) * 15, 0, 0);
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#sheet-body').innerHTML = `<h3>Tell someone your plan</h3>
    <p class="hint">Sends a text with where you're riding and when you'll be back, so someone knows when to worry.</p>
    <label class="row field-row">Back by <input id="ci-time" class="field" type="time" value="${hhmm(def)}"></label>
    <label class="row field-row">Call for help after <select id="ci-grace" class="field"><option value="60">1 hour late</option><option value="120" selected>2 hours late</option><option value="240">4 hours late</option></select></label>
    <textarea id="ci-note" class="field" rows="2" placeholder="Who's riding, what machines (optional)"></textarea>
    <button class="primary" data-a="send">Send plan</button>`;
  $('#sheet-body').onclick = async (e) => {
    if (e.target.closest('button')?.dataset.a !== 'send') return;
    const [h, m] = $('#ci-time').value.split(':').map(Number);
    const back = new Date(); back.setHours(h, m, 0, 0);
    if (back < Date.now()) back.setDate(back.getDate() + 1); // a time earlier than now means tomorrow
    const worry = new Date(back.getTime() + +$('#ci-grace').value * 60000);
    const when = (d) => `${clock(d)}${d.toDateString() === new Date().toDateString() ? '' : ' ' + d.toLocaleDateString(undefined, { weekday: 'short' })}`;
    const what = planSummary();
    const note = $('#ci-note').value.trim();
    const text = `ORV ride plan: ${what ? what + '. ' : ''}Starting near ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}${near ? ` (${near})` : ''}.${note ? ' ' + note + '.' : ''}
Back by ${when(back)}. If you haven't heard from me by ${when(worry)}, call 911 and give them this location: https://www.google.com/maps/search/?api=1&query=${at.lat.toFixed(5)},${at.lng.toFixed(5)}`;
    let sent = false;
    if (navigator.share) {
      try { await navigator.share({ title: 'My ride plan', text }); sent = true; } catch (err) { if (err.name === 'AbortError') return; }
    }
    if (!sent) {
      try { await navigator.clipboard.writeText(text); } catch { if (prompt('Copy your plan, then paste it in a text:', text) === null) return; }
    }
    store.set('checkin', { back: back.getTime() });
    closeSheets();
    toast(sent ? `Got it. I'll remind you at ${when(back)} to check in.` : `Plan copied: paste it in a text to them. I'll remind you at ${when(back)} to check in.`);
    checkinCheck();
  };
  openSheet('#sheet');
}
window.showCheckin = showCheckin;
// past your back-by time: a reminder to tell them you're OK
function checkinCheck() {
  const c = store.get('checkin', null), bar = $('#checkin-bar');
  bar.hidden = !(c && Date.now() >= c.back);
  if (!bar.hidden) bar.querySelector('span').textContent = `Back by ${clock(new Date(c.back))}: tell them you're OK`;
}
$('#checkin-bar').addEventListener('click', async (e) => {
  if (e.target.closest('.x')) { store.set('checkin', null); checkinCheck(); return; }
  const text = "I'm back from my ride and OK.";
  if (navigator.share) { try { await navigator.share({ text }); } catch (err) { if (err.name === 'AbortError') return; } }
  store.set('checkin', null);
  checkinCheck();
});

$('#btn-sos').addEventListener('click', showSOS);
function safetyTick() { sunCheck(); huntCheck(); checkinCheck(); }
setInterval(safetyTick, 60000);
setTimeout(safetyTick, 1500);

'use strict';
// Shared ride view for recording without a route and turn-by-turn navigation.
const rideView = { previous: null, travel: null, compass: null, compassState: 'off', compassListening: false, dragging: false };
const FOLLOW_RESUME_MS = 15000;
const VIEW_HEADING_MS = 5000;
const VIEW_CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const wrapHeading = (degrees) => ((degrees % 360) + 360) % 360;
function rideViewActive() { return !!(window.isRecording && isRecording()) || document.body.classList.contains('navigating'); }
function rideViewRunning() {
  const recording = window.currentRec && currentRec();
  return !!(recording && !recording.paused) || document.body.classList.contains('navigating');
}
function rideDirection() {
  const now = Date.now(), fix = currentGpsFix();
  if (!fix) return null;
  if (rideView.travel && rideView.travel.moving && now - rideView.travel.at <= VIEW_HEADING_MS) return { ...rideView.travel, source: 'travel' };
  if (rideView.compass && now - rideView.compass.at <= VIEW_HEADING_MS) return { ...rideView.compass, source: 'phone' };
  if (rideView.travel && now - rideView.travel.at <= 30000) return { ...rideView.travel, source: 'last travel' };
  return null;
}
function headingBetween(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return wrapHeading(Math.atan2(y, x) / rad);
}
window.onRideFix = (pos) => {
  const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: pos.timestamp };
  const c = pos.coords, previous = rideView.previous;
  const moving = Number.isFinite(c.speed) && c.speed >= 0.8;
  if (c.accuracy <= 50 && moving && Number.isFinite(c.heading) && c.heading >= 0 && c.heading <= 360) {
    rideView.travel = { heading: wrapHeading(c.heading), at: pos.timestamp, moving: true };
  } else if (c.accuracy <= 35 && previous && previous.accuracy <= 35 && p.at > previous.at && p.at - previous.at <= 15000
      && hav(p.lat, p.lng, previous.lat, previous.lng) >= Math.max(10, p.accuracy + previous.accuracy)) {
    rideView.travel = { heading: headingBetween(previous, p), at: pos.timestamp, moving: true };
  } else if (!moving && rideView.travel) rideView.travel.moving = false;
  rideView.previous = p;
  refreshRideView();
};
function screenHeadingOffset() {
  if (window.screen && screen.orientation && Number.isFinite(screen.orientation.angle)) return screen.orientation.angle;
  return Number.isFinite(window.orientation) ? window.orientation : 0;
}
function onRideOrientation(event) {
  // iPhone reports heading relative to the device's portrait top, including tilt
  // compensation. Screen orientation supplies the displayed top in landscape.
  const heading = event.webkitCompassHeading, accuracy = event.webkitCompassAccuracy;
  if (!Number.isFinite(heading) || heading < 0 || heading > 360 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 25) {
    rideView.compass = null; rideView.compassState = 'calibrate'; refreshRideView(); return;
  }
  rideView.compass = { heading: wrapHeading(heading + screenHeadingOffset()), accuracy, at: Date.now() };
  rideView.compassState = 'on'; refreshRideView();
}
async function enableRideCompass() {
  if (!window.DeviceOrientationEvent) { toast('Phone compass unavailable. GPS travel direction appears when you move.'); return; }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function' && await DeviceOrientationEvent.requestPermission() !== 'granted') {
      rideView.compassState = 'denied'; toast('Compass permission declined. GPS travel direction still works.'); refreshRideView(); return;
    }
    if (!rideView.compassListening) { window.addEventListener('deviceorientation', onRideOrientation); rideView.compassListening = true; }
    rideView.compassState = 'waiting'; toast('Compass enabled. Keep the phone away from magnetic mounts if the direction looks wrong.');
    refreshRideView();
  } catch { rideView.compassState = 'denied'; toast('Could not enable the phone compass. GPS travel direction still works.'); refreshRideView(); }
}
window.resumeRideFollow = () => {
  ensureGpsFix(); follow = true; followPausedAt = 0;
  const fix = currentGpsFix();
  if (fix) map.panTo([fix.lat, fix.lng], { animate: false });
  setLocState(); refreshRideView();
};
function refreshRideView() {
  const active = rideViewActive(), fix = currentGpsFix(), direction = rideDirection();
  const wasActive = document.body.classList.contains('riding');
  document.body.classList.toggle('riding', active);
  $('#ride-status').hidden = !active;
  $('#btn-ride-tools').hidden = !active;
  if (!active) { if (wasActive && map.setBearing) map.setBearing(0); return; }
  const cardinal = direction ? VIEW_CARDINALS[Math.round(direction.heading / 45) % 8] : '';
  $('#ride-heading').textContent = !fix ? 'GPS signal lost · waiting for a fix'
    : direction ? `${direction.source === 'phone' ? 'Phone compass' : direction.source === 'last travel' ? 'Last travel' : 'Travel'} ${cardinal} · ${Math.round(direction.heading)}°`
      : rideView.compassState === 'calibrate' ? 'Compass needs calibration · move or retry' : 'Direction unknown · move or enable compass';
  const recording = window.currentRec && currentRec();
  const recordingState = recording ? recording.paused ? 'Recording paused · ' : 'Recording · ' : 'Navigation · ';
  $('#ride-follow-state').textContent = recordingState + (!follow ? 'Browsing · tap Follow to recenter' : fix ? `Following · GPS ±${Math.round(fix.accuracy)} m` : 'Waiting for GPS');
  $('#btn-enable-compass').hidden = !!rideView.compass && Date.now() - rideView.compass.at <= VIEW_HEADING_MS;
  $('#btn-enable-compass').textContent = rideView.compassState === 'calibrate' ? 'Check compass' : 'Enable compass';
  // Preserve the last travel orientation at a stop so the map doesn't suddenly
  // flip north-up at a junction. Its label/arrow distinguish it from a compass.
  if (follow && map.setBearing) {
    const headingUp = store.get('headingUp', true);
    map.setBearing(headingUp && direction ? -direction.heading : 0);
  }
  const head = meMarker && meMarker.getElement()?.querySelector('.me-head');
  if (head) {
    head.hidden = !direction;
    head.classList.toggle('last-heading', !!direction && direction.source === 'last travel');
    if (direction) head.style.transform = `rotate(${direction.heading + (map.getBearing ? map.getBearing() : 0)}deg)`;
  }
  const banner = $('#nav-banner');
  document.body.style.setProperty('--ride-banner-h', `${banner.hidden ? 0 : banner.offsetHeight + 12}px`);
}
function rideViewTick() {
  if (!rideViewActive()) return;
  const browsingTask = document.querySelector('.sheet:not([hidden])') || (window.traceMode && traceMode());
  if (!follow && followPausedAt && Date.now() - followPausedAt >= FOLLOW_RESUME_MS && rideViewRunning() && !rideView.dragging && !browsingTask && currentGpsFix()) {
    resumeRideFollow();
  } else refreshRideView();
}
$('#btn-enable-compass').addEventListener('click', enableRideCompass);
$('#btn-ride-tools').addEventListener('click', () => {
  const recording = window.currentRec && currentRec();
  $('#sheet-body').innerHTML = `<h3>Ride tools</h3>
    ${recording ? `<button class="primary" data-a="pause">${recording.paused ? 'Resume recording' : 'Pause recording'}</button>` : ''}
    <button class="ghost" data-a="rides">Recording &amp; saved rides</button>
    <button class="ghost" data-a="mark">Mark this spot</button>
    <button class="ghost" data-a="layers">Map layers &amp; machine</button>
    <button class="ghost" data-a="offline">Offline maps</button>
    <button class="ghost" data-a="compass">Enable phone compass</button>`;
  $('#sheet-body').onclick = (event) => {
    const action = event.target.closest('[data-a]')?.dataset.a;
    if (action === 'pause') { closeSheets(); recording.paused ? resumeRec() : pauseRec(); }
    if (action === 'rides') $('#btn-rec').click();
    if (action === 'mark') showMarkMenu();
    if (action === 'layers') $('#btn-layers').click();
    if (action === 'offline') $('#btn-save').click();
    if (action === 'compass') { closeSheets(); enableRideCompass(); }
  };
  openSheet('#sheet');
});
setInterval(rideViewTick, 1000);
map.on('dragstart', () => { rideView.dragging = true; });
map.on('dragend', () => { rideView.dragging = false; if (!follow && followPausedAt) followPausedAt = Date.now(); });
window.addEventListener('orientationchange', () => { rideView.compass = null; map.invalidateSize(); refreshRideView(); });
window.addEventListener('resize', () => { map.invalidateSize(); refreshRideView(); });

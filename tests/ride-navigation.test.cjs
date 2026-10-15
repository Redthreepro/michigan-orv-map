const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = (file) => fs.readFileSync(path.join(__dirname, '../app', file), 'utf8').replace(/\r\n/g, '\n');

function riding() {
  let now = 1800000000000, bearing = 0;
  const elements = new Map(), mapEvents = new Map(), events = new Map(), saved = new Map(), pans = [], messages = [];
  function classes() {
    const names = new Set();
    return { contains: (key) => names.has(key), add: (key) => names.add(key), remove: (key) => names.delete(key),
      toggle: (key, force) => { if (force === undefined ? !names.has(key) : force) names.add(key); else names.delete(key); } };
  }
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', innerHTML: '', disabled: false, offsetHeight: 90,
      style: { setProperty() {} }, classList: classes(), setAttribute(key, value) { this[key] = value; },
      addEventListener(name, fn) { this[name] = fn; }, querySelector: (selector) => node(id + ' ' + selector) });
    return elements.get(id);
  };
  const layer = (point) => ({ addTo() { return this; }, setLatLng(p) { point = p; return this; }, setRadius() { return this; },
    getLatLng: () => Array.isArray(point) ? { lat: point[0], lng: point[1] } : point,
    getElement: () => ({ querySelector: () => node('head') }) });
  const c = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    navigator: { geolocation: { watchPosition: () => 1, clearWatch() {} } },
    document: { body: node('body'), visibilityState: 'visible', querySelector: (selector) => selector === '.sheet:not([hidden])' ? null : node(selector) },
    map: { on: (name, fn) => { (mapEvents.get(name) || mapEvents.set(name, []).get(name)).push(fn); },
      setView() {}, getZoom: () => 15, setZoom() {}, panTo: (p) => pans.push(p), removeLayer() {}, invalidateSize() {},
      setBearing: (b) => { bearing = b; for (const fn of mapEvents.get('rotate') || []) fn(); }, getBearing: () => bearing },
    L: { marker: layer, circle: layer, divIcon: () => ({}) }, renderer: {}, $: node,
    store: { get: (k, fallback) => saved.has(k) ? saved.get(k) : fallback, set: (k, v) => saved.set(k, v) },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    toast: (m) => messages.push(m), ensureGpsFix() {}, lockScreen() {}, unlockScreen() {}, closeSheets() {}, showPlan() {},
    plan: null, planLegs: [], OFF_ROUTE_M: 80, fmtMi: (m) => `${m} m`,
    currentRec: () => ({ paused: false }), isRecording: () => true,
    screen: { orientation: { angle: 0 } },
  });
  c.window = c;
  c.addEventListener = (name, fn) => { (events.get(name) || events.set(name, []).get(name)).push(fn); };
  c.dispatchEvent = (event) => { for (const fn of events.get(event.type) || []) fn(event); };
  c.Event = class { constructor(type) { this.type = type; } };
  const run = (code) => vm.runInContext(code, c);
  run(src('app.js').split('// ---------- GPS ----------')[1].split('// ---------- misc ----------')[0]);
  node('#btn-locate').clickHandler = node('#btn-locate').click;
  node('#btn-locate').click = () => node('#btn-locate').clickHandler();
  run('ensureGpsFix = () => { if (watchId === null) locBtn.click(); };');
  run(src('routing.js')); run(src('rideview.js')); run(src('nav.js'));
  const fix = (lat = 44, lng = -85, heading = 90, speed = 5, accuracy = 5) => {
    c.onPos({ coords: { latitude: lat, longitude: lng, heading, speed, accuracy, altitude: null }, timestamp: now });
  };
  const mapEvent = (name) => { for (const fn of mapEvents.get(name) || []) fn(); };
  return { c, run, node, saved, messages, pans, mapEvent, fix, advance: (ms) => { now += ms; }, bearing: () => bearing };
}

test('recording resumes follow and the location control never toggles it off mid-ride', () => {
  const h = riding(); h.fix(); h.c.resumeRideFollow();
  assert.equal(h.run('follow'), true);
  h.node('#btn-locate').click(); assert.equal(h.run('follow'), true);
  assert.ok(h.pans.length >= 2); assert.equal(h.node('#ride-status').hidden, false);
});

test('dragging temporarily pauses follow and automatically recenters 15 seconds after releasing', () => {
  const h = riding(); h.fix(); h.c.resumeRideFollow(); h.mapEvent('dragstart');
  assert.equal(h.run('follow'), false);
  h.advance(16000); h.fix(); h.c.rideViewTick(); assert.equal(h.run('follow'), false);
  h.mapEvent('dragend'); h.advance(14000); h.c.rideViewTick(); assert.equal(h.run('follow'), false);
  h.advance(1000); h.fix(); h.c.rideViewTick(); assert.equal(h.run('follow'), true);
});

test('follow does not snap back while inspecting an open sheet or paused recording', () => {
  const h = riding(); h.fix(); h.c.resumeRideFollow(); h.mapEvent('dragstart'); h.mapEvent('dragend'); h.advance(16000); h.fix();
  h.c.document.querySelector = () => ({}); h.c.rideViewTick(); assert.equal(h.run('follow'), false);
  h.c.document.querySelector = () => null; h.c.currentRec = () => ({ paused: true });
  h.c.rideViewTick(); assert.equal(h.run('follow'), false);
});

test('heading-up works while recording without a route; north-up remains selectable', () => {
  const h = riding(); h.c.resumeRideFollow(); h.fix(44, -85, 90);
  assert.equal(h.bearing(), -90); assert.match(h.node('#ride-heading').textContent, /Travel E/);
  h.node('#btn-compass').click(); assert.equal(h.bearing(), 0); assert.equal(h.saved.get('headingUp'), false);
});

test('when GPS heading is absent, sufficient accurate displacement supplies direction of travel', () => {
  const h = riding(); h.fix(44, -85, null, null); h.advance(3000); h.fix(44, -84.999, null, null);
  assert.match(h.node('#ride-heading').textContent, /Travel E/);
  const small = riding(); small.fix(44, -85, null, null, 20); small.advance(3000); small.fix(44.00001, -85, null, null, 20);
  assert.match(small.node('#ride-heading').textContent, /Direction unknown/);
});

test('stopped GPS course is labeled last travel, not phone direction', () => {
  const h = riding(); h.c.resumeRideFollow(); h.fix(); h.advance(1000); h.fix(44, -85, null, 0);
  assert.match(h.node('#ride-heading').textContent, /Last travel E/); assert.equal(h.bearing(), -90);
});

test('iPhone compass handles zero/north and both landscape orientations', () => {
  const h = riding(); h.fix(44, -85, null, 0);
  for (const [angle, expected] of [[0, 0], [90, 90], [270, 270]]) {
    h.c.screen.orientation.angle = angle;
    h.c.onRideOrientation({ webkitCompassHeading: 0, webkitCompassAccuracy: 10 });
    assert.equal(h.c.rideDirection().heading, expected); assert.equal(h.c.rideDirection().source, 'phone');
  }
});

test('uncalibrated, inaccurate and stale compass readings cannot indicate a live heading', () => {
  const h = riding(); h.fix(44, -85, null, 0);
  for (const accuracy of [-1, 60, NaN]) {
    h.c.onRideOrientation({ webkitCompassHeading: 80, webkitCompassAccuracy: accuracy });
    assert.equal(h.c.rideDirection(), null);
  }
  h.c.onRideOrientation({ webkitCompassHeading: 80, webkitCompassAccuracy: 5 }); h.advance(5001);
  assert.equal(h.c.rideDirection(), null);
  h.advance(30000); h.c.refreshRideView(); assert.match(h.node('#ride-heading').textContent, /GPS signal lost/);
});

test('declining compass permission leaves GPS following and course available', async () => {
  const h = riding(); h.fix(); h.c.resumeRideFollow(); h.c.DeviceOrientationEvent = { requestPermission: async () => 'denied' };
  await h.c.enableRideCompass(); assert.equal(h.run('follow'), true); assert.equal(h.c.rideDirection().source, 'travel');
  assert.match(h.messages.at(-1), /permission declined/);
});

test('turn filtering preserves close junction decisions and straight-through instructions', () => {
  const h = riding();
  const turns = [{ at: 10, deg: 0, junction: true, text: 'Continue at junction' },
    { at: 40, deg: 35, junction: true, text: 'Bear right at junction' }, { at: 80, type: 'arrive' }];
  assert.equal(h.c.tidy(turns).length, 3);
});

test('same-name 4-way intersection gives an explicit straight-through maneuver', () => {
  const h = riding();
  h.run(`G = { eu:[0,1,1,1], ev:[1,2,3,4], eattr:[0,0,0,0], attrs:[['road',72,'Forest road',0]],
    adj:[[0],[0,1,2,3],[1],[2],[3]], geom:[[-8500000,4400000,0,100],[-8500000,4400100,0,100],[-8500000,4400100,100,0],[-8500000,4400100,-100,0]] }; rig=50;`);
  const route = { legs: [{ e: 0, coords: [[44, -85], [44.001, -85]] }, { e: 1, coords: [[44.001, -85], [44.002, -85]] }],
    path: [[44, -85], [44.001, -85], [44.001, -85], [44.002, -85]], cum: [0, 111, 111, 222] };
  const result = h.c.maneuvers(route, 'End');
  assert.ok(result.some((m) => m.junction && m.deg === 0 && /Continue at junction/.test(m.text)));
});

test('a turn is still shown when stopped five meters before the junction', () => {
  const h = riding(); h.run('ride.on=true;');
  h.c.plan = { stops: [{}, { name: 'End', lat: 44.01, lng: -85 }] };
  h.c.planLegs = [{ path: [[44, -85], [44.01, -85]], cum: [0, 1110], man: [{ at: 100, deg: -45, junction: true, text: 'Bear left at junction' }, { at: 1110, type: 'arrive', text: 'Arrive at End' }] }];
  h.c.onNavPos({ d: 0, leg: 0, at: 95 }, { coords: { latitude: 44, longitude: -85 } });
  assert.match(h.node('#nav-banner .nav-text').textContent, /Bear left/);
});

test('projecting onto a route endpoint from far away never announces arrival', () => {
  const h = riding(); h.run('ride.on=true;');
  h.c.plan = { stops: [{}, { name: 'End', lat: 44.01, lng: -85 }] };
  h.c.planLegs = [{ path: [[44, -85], [44.01, -85]], cum: [0, 1110], man: [{ at: 1110, type: 'arrive', text: 'Arrive at End' }] }];
  h.c.onNavPos({ d: 500, leg: 0, at: 1110 }, { coords: { latitude: 44.01, longitude: -84.99 } });
  assert.match(h.node('#nav-banner .nav-text').textContent, /Off route/);
  assert.doesNotMatch(h.node('#nav-banner .nav-text').textContent, /Arrived/);
});

test('reliable GPS travel opposite the route gets a direction warning instead of a misleading turn', () => {
  const h = riding(); h.fix(44, -85, 180, 5, 5); h.run('ride.on=true;');
  h.c.plan = { stops: [{}, { name: 'End', lat: 44.01, lng: -85 }] };
  h.c.planLegs = [{ path: [[44, -85], [44.01, -85]], cum: [0, 1110], man: [{ at: 100, deg: -45, junction: true, text: 'Bear left at junction' }, { at: 1110, type: 'arrive', text: 'Arrive at End' }] }];
  h.c.onNavPos({ d: 0, leg: 0, segment: 0, at: 95 }, { coords: { latitude: 44, longitude: -85, accuracy: 5 } });
  assert.match(h.node('#nav-banner .nav-text').textContent, /route runs behind you/);
});

test('paused recording is explicitly visible even when the compact controls hide the recording panel', () => {
  const h = riding(); h.fix(); h.c.currentRec = () => ({ paused: true }); h.c.refreshRideView();
  assert.match(h.node('#ride-follow-state').textContent, /Recording paused/);
});

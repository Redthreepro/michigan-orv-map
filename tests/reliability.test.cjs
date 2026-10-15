const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (file) => fs.readFileSync(path.join(__dirname, '../app', file), 'utf8').replace(/\r\n/g, '\n');
const section = (file, from, to) => source(file).split(from)[1].split(to)[0];

function harness() {
  let now = 1800000000000;
  const nodes = new Map(), saved = new Map(), events = new Map(), timers = [];
  const node = (key) => {
    if (!nodes.has(key)) nodes.set(key, {
      innerHTML: '', textContent: '', hidden: true, disabled: false, style: {}, dataset: {},
      classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
      addEventListener(name, fn) { this[name] = fn; },
      setAttribute(key, value) { this[key] = value; },
      querySelector: (selector) => node(key + ' ' + selector),
    });
    return nodes.get(key);
  };
  function layer(ll = [0, 0]) {
    return { addTo() { return this; }, setLatLng(p) { ll = p; return this; },
      getLatLng: () => Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll,
      setRadius() { return this; }, getElement: () => null };
  }
  const messages = [], shares = [], copies = [], writes = [];
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    Event: class { constructor(type) { this.type = type; } },
    navigator: { onLine: false, geolocation: { watchPosition: () => 1, clearWatch() {} },
      clipboard: { writeText: async (text) => copies.push(text) }, share: async (data) => shares.push(data) },
    document: { querySelector: node, querySelectorAll: () => [], body: node('body'),
      getElementById: (id) => node('#sheet-body').innerHTML.includes(`id="${id}"`) ? node('#' + id) : null },
    map: { getCenter: () => ({ lat: 44.12345, lng: -85.54321 }), on() {}, setView() {}, panTo() {}, getZoom: () => 10,
      removeLayer() {}, createPane: () => ({ style: {} }), getPane: () => ({ style: {} }) },
    L: { marker: layer, circle: layer, divIcon: () => ({}), canvas: () => ({}), layerGroup: () => layer(), latLng: (lat, lng) => ({ lat, lng }) },
    store: { get: (k, fallback) => saved.has(k) ? saved.get(k) : fallback, set: (k, v) => saved.set(k, v) },
    $: node, esc: String, shown: {}, renderer: {}, hav: () => 0, POIS: [],
    toast: (m) => messages.push(m), ensureGpsFix: () => node('#btn-locate').click?.(),
    openSheet: () => { node('#sheet').hidden = false; }, closeSheets() {},
    confirm: () => false, prompt: () => null,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {},
    location: { hostname: 'localhost', search: '', href: 'http://localhost/' },
  });
  context.window = context;
  context.addEventListener = (name, fn) => { (events.get(name) || events.set(name, []).get(name)).push(fn); };
  context.dispatchEvent = (event) => { for (const fn of events.get(event.type) || []) fn(event); };
  const run = (code) => vm.runInContext(code, context);
  run(section('app.js', '// ---------- GPS ----------', '// ---------- misc ----------'));
  // Keep the registered click handler separate from the DOM click method.
  node('#btn-locate').clickHandler = node('#btn-locate').click;
  node('#btn-locate').click = () => node('#btn-locate').clickHandler?.();
  // GPS startup isn't required to deliver a fix: tests feed real callback payloads below.
  context.ensureGpsFix = () => {};
  run(source('safety.js'));
  run(source('cloud.js'));
  context.writeMock = (data) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    writes.push({ data, resolve, reject }); return promise;
  };
  run("fb = { db: { collection: () => ({ doc: () => ({ update: writeMock }) }) }, FV: { delete: () => 'DELETE' } }; me = { uid: 'rider' }; W.id = 'family'; cloud = async () => fb;");
  const click = async (a, extra = {}) => {
    const target = { dataset: { a }, ...extra };
    await node('#sheet-body').onclick({ target: { closest: () => target } });
    return target;
  };
  const fix = (age = 0, accuracy = 12) => {
    context.onPos({ coords: { latitude: 45.5, longitude: -84.25, accuracy, heading: null, speed: 0, altitude: null }, timestamp: now - age });
  };
  return { context, run, node, saved, messages, shares, copies, writes, click, fix, timers,
    advance: (ms) => { now += ms; }, html: () => node('#sheet-body').innerHTML };
}

test('no GPS: SOS never renders or shares map-center coordinates, all emergency paths remain available', async () => {
  const h = harness(); h.context.showSOS();
  assert.match(h.html(), /Current location unavailable/);
  assert.doesNotMatch(h.html(), /44\.12345|-85\.54321|google\.com\/maps/);
  assert.match(h.html(), /tel:911/); assert.match(h.html(), /sms:911/);
  await h.click('share'); assert.match(h.shares[0].text, /location is unavailable/);
  await h.click('family'); assert.equal(h.writes[0].data.sos, null);
  assert.equal('last' in h.writes[0].data, false);
  assert.match(h.html(), /delivery is not confirmed/);
});

test('delayed GPS refreshes the open card with measured accuracy and timestamp', () => {
  const h = harness(); h.context.showSOS(); h.fix();
  assert.match(h.html(), /45\.50000, -84\.25000/);
  assert.match(h.html(), /GPS fix · accuracy ±12 m/);
  assert.match(decodeURIComponent(h.html()), /GPS location/);
});

test('stale markers, old fixes, invalid fixes, and stopped GPS cannot become current emergency locations', () => {
  const h = harness(); h.fix(60000); h.context.showSOS();
  assert.match(h.html(), /Current location unavailable/);
  h.fix(); h.advance(30001); h.context.refreshSOS();
  assert.match(h.html(), /Current location unavailable/);
  h.fix(0, NaN); assert.equal(h.context.currentGpsFix(), null);
  h.fix(); h.context.stopLocate(); assert.equal(h.context.currentGpsFix(), null);
});

test('SMS, share, and family revalidate a fix at action time', async () => {
  const h = harness(); h.fix(); h.context.showSOS(); h.advance(30001);
  const link = await h.click('text'); assert.doesNotMatch(decodeURIComponent(link.href), /45\.50000|google/);
  await h.click('share'); assert.doesNotMatch(h.shares[0].text, /45\.50000|google/);
  await h.click('family'); assert.equal(h.writes[0].data.sos, null);
});

test('manual selection requires explicit confirmation and remains labeled throughout sharing', async () => {
  const h = harness(); h.context.showSOS(); await h.click('manual');
  assert.doesNotMatch(h.html(), /44\.12345/);
  h.context.confirm = () => true; await h.click('manual');
  assert.match(h.html(), /Manually selected location — not GPS/);
  await h.click('share'); assert.match(h.shares[0].text, /Manually selected location \(not GPS\)/);
  await h.click('family'); assert.equal(h.writes[0].data.sos.source, 'manual');
  assert.equal('last' in h.writes[0].data, false);
});

test('queued alerts only become confirmed after server acknowledgement; rejections report failure', async () => {
  const h = harness(); await h.context.cloudSOS(null);
  assert.equal(h.context.cloudSOSStatus(), 'pending');
  h.writes[0].resolve(); await new Promise(setImmediate);
  assert.equal(h.context.cloudSOSStatus(), 'confirmed');
  assert.match(h.context.alertStatusText(), /does not confirm anyone has seen it/);
  await h.context.cloudSOS(null); h.writes[1].reject(new Error('permission-denied')); await new Promise(setImmediate);
  assert.equal(h.context.cloudSOSStatus(), 'failed');
});

test('offline cancellation stays pending and preserves active alert until acknowledged', async () => {
  const h = harness(); await h.context.cloudSOS(null); h.writes[0].resolve(); await new Promise(setImmediate);
  await h.context.cloudSOSClear(); assert.equal(h.context.cloudSOSStatus(), 'pending-clear');
  assert.equal(h.context.cloudSOSActive(), true);
  h.writes[1].reject(new Error('denied')); await new Promise(setImmediate);
  assert.equal(h.context.cloudSOSStatus(), 'clear-failed'); assert.equal(h.context.cloudSOSActive(), true);
  await h.context.cloudSOSClear(); h.writes[2].resolve(); await new Promise(setImmediate);
  assert.equal(h.context.cloudSOSStatus(), 'cleared'); assert.equal(h.context.cloudSOSActive(), false);
});

test('older alert acknowledgement cannot overwrite a newer pending cancellation', async () => {
  const h = harness(); await h.context.cloudSOS(null); await h.context.cloudSOSClear();
  h.writes[0].resolve(); await new Promise(setImmediate); assert.equal(h.context.cloudSOSStatus(), 'pending-clear');
});

test('cloud boundary rejects unverified, invalid, future, and stale coordinates', async () => {
  const h = harness();
  for (const at of [{ lat: 44, lng: -85 }, { lat: 91, lng: 0, source: 'manual', t: 1800000000000 },
    { lat: 44, lng: -85, source: 'gps', accuracy: 5, t: 1799999900000 },
    { lat: 44, lng: -85, source: 'gps', accuracy: 5, t: 1800000000001 }]) {
    await assert.rejects(h.context.cloudSOS(at));
  }
  assert.equal(h.writes.length, 0);
});

test('SDK initialization cannot cause a GPS fix to be transmitted after it expires', async () => {
  const h = harness(); h.fix(); const at = h.context.currentGpsFix();
  h.context.cloud = async () => { h.advance(31000); };
  await h.context.cloudSOS(at); assert.equal(h.writes[0].data.sos, null);
});

test('share cancellation sends nothing and clipboard fallback keeps location unavailable', async () => {
  const h = harness(); h.context.showSOS();
  h.context.navigator.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); };
  await h.click('share'); assert.equal(h.copies.length, 0);
  h.context.navigator.share = undefined; await h.click('share');
  assert.match(h.copies[0], /location is unavailable/); assert.doesNotMatch(h.copies[0], /44\.12345/);
});

test('check-in plan does not treat map center as the starting point or live rescue location', async () => {
  const h = harness(); h.context.showCheckin(); h.node('#ci-time').value = '17:00';
  h.node('#ci-grace').value = '120'; h.node('#ci-note').value = '';
  await h.click('send'); assert.doesNotMatch(h.shares[0].text, /44\.12345|google/);
  assert.match(h.shares[0].text, /Starting location unavailable/);
});

test('return check-in without Web Share copies the message instead of silently clearing the reminder', async () => {
  const h = harness(); h.context.navigator.share = undefined; h.saved.set('checkin', { back: 1 });
  await h.node('#checkin-bar').click({ target: { closest: () => null } });
  assert.equal(h.copies[0], "I'm back from my ride and OK.");
});

test('an unchanged SOS card preserves its DOM and focused controls', () => {
  const h = harness(); h.context.showSOS(); h.node('#sheet-body').innerHTML += '<i>focus sentinel</i>';
  h.context.refreshSOS(); assert.match(h.html(), /focus sentinel/);
});

test('app shell cache hit stays immutable and worker activation requires an update request', async () => {
  const handlers = {}, calls = [];
  const cached = { version: 'installed' };
  const context = vm.createContext({ self: { location: { origin: 'https://test.local' },
    addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: () => calls.push('activate') },
    caches: { open: async () => ({ match: async () => cached }) },
    fetch: async () => { calls.push('fetch'); }, URL, Response, Request });
  vm.runInContext(source('sw.js'), context);
  let result; handlers.fetch({ request: { method: 'GET', url: 'https://test.local/safety.js?v=55' }, respondWith: (p) => { result = p; } });
  assert.equal(await result, cached); assert.deepEqual(calls, []);
  handlers.message({ data: { type: 'activate-update' }, ports: [] }); assert.deepEqual(calls, ['activate']);
});

test('missing installed app files never fall through to a newer release on the network', async () => {
  const handlers = {};
  let fetched = false, result;
  const c = vm.createContext({ self: { location: { origin: 'https://test.local', href: 'https://test.local/app/sw.js' },
    addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { open: async () => ({ match: async () => undefined }) },
    fetch: async () => { fetched = true; }, URL, Response, Request });
  vm.runInContext(source('sw.js'), c);
  handlers.fetch({ request: { method: 'GET', url: 'https://test.local/app/safety.js?v=old' }, respondWith: (p) => { result = p; } });
  assert.equal((await result).status, 503); assert.equal(fetched, false);
});

test('backup read failure never exports an empty successful backup', async () => {
  const h = harness(); let exports = 0;
  h.context.allTracks = async () => { throw new Error('storage unavailable'); };
  h.context.shareFile = async () => { exports++; };
  h.run('async function backupAll() {' + section('gpx.js', 'async function backupAll() {', 'window.backupAll = backupAll;'));
  await h.context.backupAll(); assert.equal(exports, 0);
  assert.match(h.messages.at(-1), /Backup failed/); assert.equal(h.saved.has('lastBackup'), false);
});

test('map download storage failure re-enables retry controls', async () => {
  const h = harness(), button = { disabled: false };
  h.context.document.querySelectorAll = () => [button];
  h.context.caches = { open: async () => { throw new Error('quota'); } };
  h.context.navigator.onLine = true;
  h.context.refreshOffline = () => {};
  h.context.TILE_CACHE = 'orv-tiles';
  h.run(section('offline.js', '// ---------- downloading ----------', '// ---------- readiness checks ----------'));
  await h.context.download(['https://tiles/1'], 'Trip');
  assert.equal(button.disabled, false); assert.equal(h.run('downloading'), false);
  assert.match(h.messages.at(-1), /download failed/);
});

test('GPS cannot be switched off by the location button during navigation', () => {
  const h = harness(); h.run('watchId = 1; follow = true;');
  h.context.document.body.classList.contains = (name) => name === 'navigating';
  h.node('#btn-locate').clickHandler();
  assert.equal(h.run('watchId'), 1); assert.equal(h.run('follow'), true);
});

test('storage rejection prevents recording from claiming it started', async () => {
  const h = harness();
  h.run('let rec = null;');
  h.context.putTrack = async () => { throw new Error('quota'); };
  h.context.fmtDate = () => 'Today';
  h.run('let recStarting = false; async function startRec() {' + section('tracks.js', 'async function startRec() {', 'function pauseRec()'));
  await h.context.startRec(); assert.equal(h.run('rec'), null);
  assert.match(h.messages.at(-1), /Recording could not start/);
});

test('pending SOS is confirmed after reopening only by an acknowledged matching server snapshot', () => {
  const h = harness(); let snapshot;
  h.run("fb.db.collection = () => ({ doc: () => ({ onSnapshot: (_, fn) => { captureSnapshot(fn); return () => {}; } }) });");
  h.context.captureSnapshot = (fn) => { snapshot = fn; };
  h.saved.set('sosWriteAt', 123); h.saved.set('sosWriteState', 'pending'); h.context.observeSOSWrite();
  const data = { status: 'sos', statusAt: 123 };
  snapshot({ exists: true, metadata: { fromCache: true, hasPendingWrites: false }, data: () => data });
  assert.equal(h.context.cloudSOSStatus(), 'pending');
  snapshot({ exists: true, metadata: { fromCache: false, hasPendingWrites: true }, data: () => data });
  assert.equal(h.context.cloudSOSStatus(), 'pending');
  snapshot({ exists: true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => ({ status: 'sos', statusAt: 122 }) });
  assert.equal(h.context.cloudSOSStatus(), 'pending');
  snapshot({ exists: true, metadata: { fromCache: false, hasPendingWrites: false }, data: () => data });
  assert.equal(h.context.cloudSOSStatus(), 'confirmed');
});

test('Ride Watch does not turn a last ride fix into a missing emergency location; manual and legacy locations are labeled', () => {
  const nodes = new Map();
  const node = (key) => { if (!nodes.has(key)) nodes.set(key, { style: {}, textContent: '', innerHTML: '' }); return nodes.get(key); };
  const layer = { setLatLngs() {}, setLatLng() { return this; }, addTo() {}, getLatLngs: () => [] };
  const c = vm.createContext({ Date, Math, Number, $: node, esc: String, clock: () => '12:00', day: () => '', ago: () => 'now',
    watchLocationValid: (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng),
    pairs: () => [], estimate: () => null, doc: null, follow: false, pathLine: layer, planLine: layer,
    estLine: layer, estDot: layer, realDot: layer, sosDot: layer, estArea: layer,
    map: { removeLayer() {}, invalidateSize() {} } });
  vm.runInContext('function render() {' + section('watch.html', 'function render() {', 'function watchPoints(key)'), c);
  c.doc = { status: 'sos', last: { lat: 44.12345, lng: -85.54321 } }; c.render();
  assert.match(node('#sos').innerHTML, /Current emergency location unavailable/);
  assert.doesNotMatch(node('#sos').innerHTML, /44\.12345/);
  c.doc.sos = { lat: 45, lng: -84, source: 'manual' }; c.render();
  assert.match(node('#sos').innerHTML, /Manually selected location \(not GPS\)/);
  delete c.doc.sos.source; c.render(); assert.match(node('#sos').innerHTML, /Unverified location/);
});

test('first-open welcome cannot replace an emergency sheet the rider already opened', () => {
  let welcome = 0, delayed;
  const c = vm.createContext({ store: { get: () => 0 }, setTimeout: (fn) => { delayed = fn; },
    showWelcome: () => { welcome++; }, document: { querySelectorAll: () => [{ hidden: false }] } });
  const code = "if (!store.get('welcomed', 0)) setTimeout(" + section('offline.js', "if (!store.get('welcomed', 0)) setTimeout(", '\n\nif (IS_MOBILE');
  vm.runInContext(code, c); delayed(); assert.equal(welcome, 0);
  c.document.querySelectorAll = () => [{ hidden: true }]; delayed(); assert.equal(welcome, 1);
});

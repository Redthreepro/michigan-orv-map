const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tracks = fs.readFileSync(path.join(__dirname, '../app/tracks.js'), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise(setImmediate);

function awake() {
  const warning = { hidden: true, addEventListener(name, fn) { this[name] = fn; } };
  const delayed = [], events = {}, sentinels = [];
  let requests = 0;
  const c = vm.createContext({
    navigator: { wakeLock: { request: async () => {
      requests++;
      const listeners = {}, sentinel = { released: false, addEventListener: (name, fn) => { listeners[name] = fn; },
        release: async () => { sentinel.released = true; listeners.release?.(); } };
      sentinels.push(sentinel); return sentinel;
    } } },
    document: { visibilityState: 'visible', body: { classList: { contains: () => false } }, addEventListener: (name, fn) => { events[name] = fn; } },
    $: () => warning, setTimeout: (fn) => { delayed.push(fn); }, setInterval() {}, putTrack: async () => {}, toast() {},
  });
  const run = (text) => vm.runInContext(text, c);
  run("let wakeLock = null, rec = {paused:false};");
  run('let screenLockRequest = ' + tracks.split('let screenLockRequest = ')[1].split('let recStarting = false;')[0]);
  return { c, run, warning, delayed, events, sentinels, requests: () => requests };
}

test('screen wake lock is reacquired after the phone releases it without hiding the app', async () => {
  const h = awake(); await h.c.lockScreen(); assert.equal(h.warning.hidden, true);
  await h.sentinels[0].release(); assert.equal(h.warning.hidden, false); assert.equal(h.delayed.length, 1);
  h.delayed[0](); await flush(); assert.equal(h.requests(), 2); assert.equal(h.warning.hidden, true);
});

test('returning from a hidden screen reacquires the lock', async () => {
  const h = awake(); await h.c.lockScreen();
  h.c.document.visibilityState = 'hidden'; await h.sentinels[0].release();
  assert.equal(h.delayed.length, 0);
  h.c.document.visibilityState = 'visible'; h.events.visibilitychange(); await flush();
  assert.equal(h.requests(), 2); assert.equal(h.warning.hidden, true);
});

test('unsupported or denied wake lock leaves a visible warning while recording', async () => {
  const h = awake(); h.c.navigator.wakeLock = undefined; await h.c.lockScreen();
  assert.equal(h.warning.hidden, false); assert.match(h.warning.textContent, /pause GPS/);
  h.c.navigator.wakeLock = { request: async () => { throw new Error('denied'); } };
  await h.c.lockScreen(); assert.equal(h.warning.hidden, false); assert.equal(h.run('screenLockRequest'), null);
  h.c.navigator.wakeLock.request = () => { throw new Error('synchronous failure'); };
  await h.c.lockScreen(); assert.equal(h.warning.hidden, false);
});

test('overlapping wake-lock attempts share a single request', async () => {
  const h = awake(); let resolve, count = 0;
  h.c.navigator.wakeLock.request = () => { count++; return new Promise((yes) => { resolve = yes; }); };
  const pending = h.c.lockScreen(); await h.c.lockScreen(); assert.equal(count, 1);
  resolve({ released: false, addEventListener() {}, release: async () => {} }); await pending;
  assert.equal(h.warning.hidden, true);
});

test('a delayed request cannot keep the screen awake after recording stops', async () => {
  const h = awake(); let resolve, released = 0;
  h.c.navigator.wakeLock.request = () => new Promise((yes) => { resolve = yes; });
  const pending = h.c.lockScreen(); h.run('rec = null'); h.c.unlockScreen();
  resolve({ addEventListener() {}, release: async () => { released++; } }); await pending;
  assert.equal(released, 1); assert.equal(h.run('wakeLock'), null); assert.equal(h.warning.hidden, true);
});

test('navigation keeps the screen awake even when recording is paused', async () => {
  const h = awake(); h.run('rec.paused = true'); h.c.document.body.classList.contains = () => true;
  await h.c.lockScreen(); h.c.unlockScreen(); assert.equal(h.sentinels[0].released, false);
  h.c.document.body.classList.contains = () => false; h.c.unlockScreen();
  assert.equal(h.sentinels[0].released, true); assert.equal(h.warning.hidden, true);
});

test('a long GPS interruption creates separate recorded segments instead of an invented connecting line', () => {
  const c = vm.createContext({ Date, Math, window: null, rec: { paused: false, segs: [[[44, -85, null, 1000]]] },
    meters: () => 1000, MAX_ACC_M: 40, MIN_MOVE_M: 4, recLine: null, drawRec() {}, saveSoon() {} });
  c.window = c;
  vm.runInContext('const MOVING_MS = ' + tracks.split('const MOVING_MS = ')[1].split('let screenLockRequest = ')[0], c);
  c.onTrackPos({ coords: { latitude: 44, longitude: -84.99, accuracy: 10, altitude: 12, speed: null }, timestamp: 120000 });
  assert.equal(c.rec.segs.length, 2); assert.equal(c.rec.segs[0].length, 1); assert.equal(c.rec.segs[1].length, 1);
  assert.equal(c.rec.moveMs || 0, 0);
});

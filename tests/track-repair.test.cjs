const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (file) => fs.readFileSync(path.join(__dirname, '../app', file), 'utf8').replace(/\r\n/g, '\n');
const between = (file, start, end) => source(file).split(start)[1].split(end)[0];
const plain = (value) => JSON.parse(JSON.stringify(value));

function editor() {
  const nodes = new Map(), messages = [], saved = [], classes = new Set();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: '', innerHTML: '',
      setAttribute(key, value) { this[key] = value; }, addEventListener(name, fn) { this[name] = fn; } });
    return nodes.get(id);
  };
  const layer = () => ({ addTo() { return this; }, on() { return this; }, clearLayers() {} });
  const c = vm.createContext({ $, window: null, Date, Math, Number, Set, Map, JSON,
    document: { body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) } } },
    map: { on() {}, getCenter: () => ({ lat: 44 }), getZoom: () => 15, removeLayer() {}, fitBounds() {},
      latLngToContainerPoint: () => ({ distanceTo: () => 0 }) },
    L: { layerGroup: layer, marker: layer, polyline: layer, divIcon: () => ({}), latLngBounds: (p) => p },
    planRenderer: {}, shownTracks: new Map(), showTrack() {}, hideTrack() {}, closeSheets() {}, openSheet() {}, renderList() {},
    esc: String, fmtMi: (m) => `${(m / 1609.344).toFixed(1)} mi`,
    toast: (text) => messages.push(text), fetch: async () => ({ json: async () => ({ edges: [], attrs: [] }) }),
    rig: 50, prompt: () => 'Repaired ride', putTrack: async (ride) => saved.push(plain(ride)),
  });
  function $(id) { return node(id); }
  c.window = c;
  const run = (text) => vm.runInContext(text, c);
  run(source('routing.js')); run(source('edit.js'));
  run('trace.layer = L.layerGroup();');
  return { c, run, node, saved, messages, classes };
}

test('hand-added sparse geometry covers the entire section; real GPS gaps stay unfilled', () => {
  const h = editor();
  h.run('const COVER_STEP_M = 50, COVER_TOL_M = 35, CELL_LAT = 0.0004, CELL_LNG = 0.00055;');
  h.run('function sampleLine(coords) {' + between('progress.js', 'function sampleLine(coords) {', 'function prepGoal()'));
  h.run('const FILL_STEP_M = ' + between('progress.js', 'const FILL_STEP_M = ', '// ---------- forest roads'));
  const seg = [[44, -85, null, 1], [44, -84.98, null, 1]];
  const sampled = h.c.sampleLine(seg.map(([lat, lng]) => [lng, lat]));
  const item = { ...sampled, bbox: [44, -85, 44, -84.98] };
  const manualIndex = h.c.rideIndex([{ segs: [seg], manual: [0] }]);
  const gpsIndex = h.c.rideIndex([{ segs: [seg] }]);
  assert.equal(h.c.nearRide(manualIndex, 44, -84.99), true);
  assert.equal(h.c.nearRide(gpsIndex, 44, -84.99), false);
  const covered = h.c.coverItems([item], manualIndex);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].runs.length, 1);
  assert.ok(covered[0].riddenM > sampled.lenM * 0.95);
});

test('manual repair keeps a long mapped loop instead of discarding it as a detour', () => {
  const h = editor();
  h.run("trace.method = 'trails'; G = { eu: [0, 1] }; components = () => [0, 0];");
  h.c.candidates = (lat, lng) => [{ e: lng === -85 ? 0 : 1, lat, lng, d: 0 }];
  h.c.solve = () => ({ endVia: {} });
  const path = [[44, -85], [44.1, -85], [44.1, -84.999], [44, -84.999]];
  h.c.assemble = () => [{ coords: path }];
  const leg = h.c.traceLeg(path[0], path.at(-1));
  assert.equal(leg.straight, undefined);
  assert.ok(leg.coords.some((p) => p[0] === 44.1));
  h.run("trace.mode = 'pick'");
  assert.equal(h.c.traceLeg(path[0], path.at(-1)).straight, true);
});

test('nearby connected edges are chosen when the nearest edge is an isolated fragment', () => {
  const h = editor();
  h.run('G = { eu: [0, 1, 2] }; components = () => [0, 1, 1];');
  h.c.candidates = (lat, lng) => lng === -85
    ? [{ e: 0, d: 0 }, { e: 1, d: 15 }] : [{ e: 2, d: 0 }];
  let chosen;
  h.c.solve = (start, end) => { chosen = [start.e, end.e]; return { endVia: {} }; };
  h.c.assemble = () => [{ coords: [[44, -85], [44, -84.99]] }];
  h.c.traceLeg([44, -85], [44, -84.99]);
  assert.deepEqual(chosen, [1, 2]); assert.equal(h.run('ROUTE_ANY'), false);
});

test('unconnected trail preview blocks saving until drawing is explicitly selected', async () => {
  const h = editor();
  h.run("G = { eu: [] }; components = () => []; candidates = () => []; trace.on = true; trace.pts = [[44,-85],[44,-84.99]]; trace.legs = [traceLeg(...trace.pts)];");
  h.c.updateTraceBar(); assert.equal(h.node('#btn-trace-save').disabled, true);
  await h.node('#btn-trace-save').click(); assert.equal(h.saved.length, 0);
  h.c.setTraceMethod('draw'); assert.equal(h.node('#btn-trace-save').disabled, false);
  await h.node('#btn-trace-save').click();
  assert.equal(h.saved.length, 1); assert.deepEqual(h.saved[0].manual, [0]);
  assert.deepEqual(h.saved[0].segs[0].map((p) => p.slice(0, 2)), [[44, -85], [44, -84.99]]);
  assert.equal(h.saved[0].traceMethods[0], 'draw');
});

test('saving preserves every preview point and repeated waypoint without altering recorded GPS', async () => {
  const h = editor();
  const recorded = [[44, -85, 100, 1000], [44.001, -85, 105, 2000]];
  h.c.ride = { id: 'today', start: 1000, segs: [recorded], done: true };
  h.run("trace.on = true; trace.ride = ride; trace.method = 'draw'; trace.pts = [[44,-85],[44.02,-85],[44,-85]]; trace.legs = [{coords:[[44,-85],[44.01,-85],[44.02,-85]]},{coords:[[44.02,-85],[44.01,-85],[44,-85]]}];");
  await h.node('#btn-trace-save').click();
  assert.deepEqual(h.saved[0].segs[0], recorded);
  assert.deepEqual(h.saved[0].segs[1].map((p) => p.slice(0, 2)), [[44, -85], [44.01, -85], [44.02, -85], [44.01, -85], [44, -85]]);
  assert.ok(h.saved[0].segs[1].every((p) => p[2] === null && p[3] === 1000));
});

test('failed save retains the complete editable preview and leaves the original ride untouched', async () => {
  const h = editor();
  h.c.ride = { id: 'today', start: 1000, segs: [[[44, -85, 1, 1000]]], done: true };
  const before = plain(h.c.ride);
  h.run("trace.on = true; trace.ride = ride; trace.method = 'draw'; trace.pts = [[44,-85],[44.02,-85]]; trace.legs = [traceLeg(...trace.pts)];");
  h.c.putTrack = async () => { throw new Error('quota'); };
  await h.node('#btn-trace-save').click();
  assert.deepEqual(plain(h.c.ride), before);
  assert.equal(h.run('trace.on'), true); assert.equal(h.run('trace.saving'), false);
  assert.equal(h.run('trace.pts.length'), 2); assert.match(h.messages.at(-1), /original ride are still here/);
});

test('double Save while storage is pending cannot append duplicate sections', async () => {
  const h = editor(); let resolve, writes = 0;
  h.run("trace.on = true; trace.method = 'draw'; trace.pts = [[44,-85],[44.02,-85]]; trace.legs = [traceLeg(...trace.pts)];");
  h.c.putTrack = () => { writes++; return new Promise((yes) => { resolve = yes; }); };
  const pending = h.node('#btn-trace-save').click();
  await h.node('#btn-trace-save').click(); assert.equal(writes, 1);
  h.c.endTrace(); assert.equal(h.run('trace.on'), true);
  resolve(); await pending; assert.equal(h.run('trace.on'), false);
});

test('Undo restores both the previous method and complete preview', () => {
  const h = editor();
  h.run("G = { eu: [] }; trace.on = true; trace.pts = [[44,-85],[44.02,-85]]; trace.legs = [{coords:trace.pts,unresolved:true}];");
  h.c.setTraceMethod('draw'); assert.equal(h.run('trace.method'), 'draw');
  h.node('#btn-trace-undo').click();
  assert.equal(h.run('trace.method'), 'trails'); assert.equal(h.run('trace.legs[0].unresolved'), true);
});

test('gap detection ignores manual segments; filling an old gap removes only its invented GPS edge', () => {
  const h = editor();
  const points = [[44, -85, 1, 1000], [44, -84.99, 2, 200000], [44, -84.9899, 3, 201000]];
  const ride = { segs: [points, [[45, -85, null, 1000], [45, -84, null, 1000]]], manual: [1],
    taps: { 1: [[45, -85], [45, -84]] }, traceMethods: { 1: 'draw' }, parts: [{ from: 0, to: 2 }] };
  const gaps = h.c.recordingGaps(ride); assert.equal(gaps.length, 1);
  h.c.splitTraceGap(ride, gaps[0]);
  assert.deepEqual(ride.segs.slice(0, 2).flat(), points); assert.deepEqual(ride.manual, [2]);
  assert.equal(ride.traceMethods[2], 'draw'); assert.equal(ride.parts[0].to, 3);
});

test('repairing a selected recording gap preserves GPS points and saves the full added route', async () => {
  const h = editor();
  h.c.ride = { id: 'today', start: 1000, done: true, segs: [[[44, -85, 10, 1000], [44, -84.99, 20, 200000]]] };
  h.run("trace.on = true; trace.ride = ride; trace.gap = recordingGaps(ride)[0]; trace.method = 'draw'; trace.pts = [trace.gap.start, [44.01,-85], trace.gap.end]; trace.legs = trace.pts.slice(1).map((p,i) => traceLeg(trace.pts[i],p));");
  await h.node('#btn-trace-save').click();
  assert.equal(h.saved[0].segs.length, 3); assert.deepEqual(h.saved[0].manual, [2]);
  assert.deepEqual(h.saved[0].segs.slice(0, 2).flat(), [[44, -85, 10, 1000], [44, -84.99, 20, 200000]]);
  assert.deepEqual(h.saved[0].segs[2].map((p) => p.slice(0, 2)), [[44, -85], [44.01, -85], [44, -84.99]]);
  assert.equal(h.c.recordingGaps(h.saved[0]).length, 0);
  h.c.dropSeg(h.saved[0], 2);
  assert.equal(h.c.recordingGaps(h.saved[0]).length, 1);
});

test('real offline routing keeps all geometry on a long U-shaped repair', async () => {
  const h = editor();
  h.c.fetch = async () => ({ json: async () => ({ attrs: [['road', 72, 'Loop', 0]], edges: [
    [0, 11120, [-8500000, 4400000, 0, 10000]],
    [0, 80, [-8500000, 4410000, 100, 0]],
    [0, 11120, [-8499900, 4410000, 0, -10000]],
  ] }) });
  await h.c.loadGraph();
  const leg = h.c.traceLeg([44, -85], [44, -84.999]);
  assert.equal(leg.unresolved, undefined); assert.equal(leg.straight, undefined);
  assert.ok(leg.coords.some((p) => p[0] === 44.1));
  assert.deepEqual(plain(leg.coords[0]), [44, -85]); assert.deepEqual(plain(leg.coords.at(-1)), [44, -84.999]);
});

test('merge and separate keep hand-drawing mode attached to the right section', async () => {
  const h = editor(); h.c.delTrack = async () => {}; h.c.fmtDate = () => 'Today'; h.c.stats = () => ({ mi: 1 });
  h.run(source('merge.js'));
  const first = { id: 'first', name: 'First', start: 1000, end: 2000, done: true,
    segs: [[[44, -85, null, 1000], [44, -84.99, null, 1000]]], manual: [0], traceMethods: { 0: 'draw' } };
  const second = { id: 'second', name: 'Second', start: 3000, end: 4000, done: true,
    segs: [[[44.1, -85, null, 3000], [44.1, -84.99, null, 3000]]], manual: [0], traceMethods: { 0: 'trails' } };
  await h.c.mergeRides([first, second]);
  const merged = h.saved[0]; assert.deepEqual(merged.traceMethods, { 0: 'draw', 1: 'trails' });
  await h.c.separateRide(merged);
  assert.deepEqual(h.saved[1].traceMethods, { 0: 'draw' }); assert.deepEqual(h.saved[2].traceMethods, { 0: 'trails' });
});

test('a sparse two-point repair has a draggable handle halfway along the line, not over its endpoint', () => {
  const h = editor();
  for (const coords of [[[44, -85], [44, -84.98]], [[44, -85], [44, -85], [44, -84.98]]]) {
    const mid = h.c.traceMidpoint(coords);
    assert.equal(mid[0], 44); assert.ok(Math.abs(mid[1] + 84.99) < 1e-9);
  }
});

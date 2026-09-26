'use strict';
// Offline tap-to-route: A* over the DNR route/trail/forest-road network built by graph.py.

// m/s (~15/12/10/14/5 mph). Routes often run on top of forest roads; the slightly slower road
// speed makes the named route win so directions read "North Missaukee Route" instead of flip-flopping.
const SPEED = { route: 6.7, trail: 5.4, mc: 4.5, mccct: 4.5, road: 6.26, connector: 2.2 };
const MAX_SPEED = 6.7;
const MIN_STEP_M = 650; // fold blips shorter than this into the surrounding step
const CELL = 0.02;                 // edge grid for snapping, ~1.5 km
const MAX_SNAP_M = 25000;          // don't snap to trails more than ~15 mi away
const FLAG = { closed: 1, seasonal: 2, military: 4, connector: 8, hc: 16, x4: 32 };

let G = null;          // loaded graph
let loading = null;

// ---------- geometry ----------
function hav(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
function edgeCoords(e) {
  const c = G.geom[e], out = [];
  let x = c[0], y = c[1];
  out.push([y / 1e5, x / 1e5]);
  for (let i = 2; i < c.length; i += 2) { x += c[i]; y += c[i + 1]; out.push([y / 1e5, x / 1e5]); }
  return out; // [lat, lng]
}

// ---------- load ----------
function loadGraph() {
  if (G) return Promise.resolve(G);
  if (loading) return loading;
  toast('Loading trail network…');
  loading = fetch('data/graph.json').then((r) => r.json()).then((raw) => {
    const n = raw.edges.length;
    const eu = new Int32Array(n), ev = new Int32Array(n), elen = new Float32Array(n), eattr = new Int32Array(n);
    const nodeId = new Map(), nx = [], ny = [], adj = [];
    const node = (x, y) => {
      const k = (x + 20000000) * 1e8 + y;
      let id = nodeId.get(k);
      if (id === undefined) { id = nx.length; nodeId.set(k, id); nx.push(x / 1e5); ny.push(y / 1e5); adj.push([]); }
      return id;
    };
    const grid = new Map();
    const geom = new Array(n);
    raw.edges.forEach(([a, len, c], i) => {
      let x = c[0], y = c[1], minx = x, maxx = x, miny = y, maxy = y;
      for (let k = 2; k < c.length; k += 2) {
        x += c[k]; y += c[k + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      const u = node(c[0], c[1]), v = node(x, y);
      eu[i] = u; ev[i] = v; elen[i] = len; eattr[i] = a; geom[i] = c;
      adj[u].push(i); if (v !== u) adj[v].push(i);
      for (let gx = Math.floor(minx / 1e5 / CELL); gx <= Math.floor(maxx / 1e5 / CELL); gx++) {
        for (let gy = Math.floor(miny / 1e5 / CELL); gy <= Math.floor(maxy / 1e5 / CELL); gy++) {
          const k = gx * 100000 + gy;
          (grid.get(k) || grid.set(k, []).get(k)).push(i);
        }
      }
    });
    G = { attrs: raw.attrs, eu, ev, elen, eattr, geom, nx, ny, adj, grid };
    return G;
  }).catch((err) => { loading = null; throw err; });
  return loading;
}

// ---------- rules ----------
function allowed(e) {
  const [, lim, , flags] = G.attrs[G.eattr[e]];
  if (flags & FLAG.closed) return false;
  if (rig && lim < rig) return false;
  return true;
}
function cost(e, meters) {
  return meters / (SPEED[G.attrs[G.eattr[e]][0]] || 5);
}

// ---------- snapping ----------
// Candidate attach points near (lat, lng): best point per allowed edge, nearest first.
// Each: { e, lat, lng, along (m from u, in stored-length units), d (m off-network) }
function candidates(lat, lng, extraM) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
  const cellM = CELL * kx;
  const found = new Map();
  let nearest = Infinity;
  for (let ring = 0; ring <= 150; ring++) {
    for (let gx = cx - ring; gx <= cx + ring; gx++) for (let gy = cy - ring; gy <= cy + ring; gy++) {
      if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue; // only the new outer ring
      for (const e of G.grid.get(gx * 100000 + gy) || []) {
        if (found.has(e) || !allowed(e)) continue;
        const pts = edgeCoords(e);
        let along = 0, total = 0, best = null;
        for (let k = 0; k < pts.length - 1; k++) {
          const [ay, ax] = pts[k], [by, bx] = pts[k + 1];
          const dx = (bx - ax) * kx, dy = (by - ay) * ky;
          const px = (lng - ax) * kx, py = (lat - ay) * ky;
          const L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
          const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t;
          const d = hav(lat, lng, qy, qx);
          const segLen = hav(ay, ax, by, bx);
          if (!best || d < best.d) best = { e, lat: qy, lng: qx, along: along + segLen * t, d };
          along += segLen;
        }
        total = along;
        if (total > 0) best.along *= G.elen[e] / total;
        found.set(e, best);
        if (best.d < nearest) nearest = best.d;
      }
    }
    // everything inside (nearest + extra) has been seen once the ring passes that radius
    if ((ring - 1) * cellM > Math.min(nearest + extraM, MAX_SNAP_M)) break;
  }
  return [...found.values()].filter((c) => c.d <= Math.min(nearest + extraM, MAX_SNAP_M)).sort((a, b) => a.d - b.d);
}

// Connected pieces of the network for the current machine width (cached per width).
const compCache = new Map();
function components() {
  if (compCache.has(rig)) return compCache.get(rig);
  const N = G.nx.length, comp = new Int32Array(N).fill(-1);
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = s;
    const q = [s];
    while (q.length) {
      const n = q.pop();
      for (const e of G.adj[n]) {
        if (!allowed(e)) continue;
        const m = G.eu[e] === n ? G.ev[e] : G.eu[e];
        if (comp[m] < 0) { comp[m] = s; q.push(m); }
      }
    }
  }
  compCache.set(rig, comp);
  return comp;
}

// Pick start/end attach points that are on the same connected network when one exists within
// a few extra miles; otherwise fall back to the nearest points (and report the gap).
const EXTRA_SNAP_M = 5000;
function snapPair(from, to) {
  const A = candidates(from.lat, from.lng, EXTRA_SNAP_M);
  const B = candidates(to.lat, to.lng, EXTRA_SNAP_M);
  if (!A.length || !B.length) return { S: A[0] || null, T: B[0] || null };
  const comp = components();
  const bestB = new Map();
  for (const c of B) { const k = comp[G.eu[c.e]]; if (!bestB.has(k)) bestB.set(k, c); }
  let pick = null;
  for (const a of A) {
    const b = bestB.get(comp[G.eu[a.e]]);
    if (b && (!pick || a.d + b.d < pick.S.d + pick.T.d)) pick = { S: a, T: b };
  }
  if (pick) return pick;
  // No shared network: offer a few distinct nearby networks as starts; runRoute keeps whichever
  // gets closest to the destination.
  const alts = [], seen = new Set();
  for (const a of A) { const k = comp[G.eu[a.e]]; if (!seen.has(k)) { seen.add(k); alts.push(a); } if (alts.length >= 6) break; }
  return { S: A[0], T: B[0], alts };
}

// ---------- A* ----------
function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  }
  return top;
}

function solve(S, T) {
  const N = G.nx.length, START = N, END = N + 1;
  const g = new Map(), prev = new Map();
  const h = (n) => hav(G.ny[n], G.nx[n], T.lat, T.lng) / MAX_SPEED;
  const heap = [];
  const sLen = G.elen[S.e];
  // leave the start point toward either end of its edge
  const starts = [[G.eu[S.e], S.along], [G.ev[S.e], sLen - S.along]];
  for (const [n, m] of starts) {
    const c = cost(S.e, m);
    if (!g.has(n) || c < g.get(n)) { g.set(n, c); prev.set(n, { from: START, e: S.e, part: 'start' }); heapPush(heap, [c + h(n), n]); }
  }
  // same edge: ride straight along it
  let bestEnd = S.e === T.e ? cost(S.e, Math.abs(S.along - T.along)) : Infinity;
  let endVia = S.e === T.e ? { from: START, e: S.e, part: 'direct' } : null;
  let closest = null, closestD = Infinity;
  const tU = G.eu[T.e], tV = G.ev[T.e], tLen = G.elen[T.e];

  while (heap.length) {
    const [f, n] = heapPop(heap);
    if (f >= bestEnd) break;
    const gn = g.get(n);
    if (f - h(n) > gn + 1e-6) continue; // stale
    const dT = hav(G.ny[n], G.nx[n], T.lat, T.lng);
    if (dT < closestD) { closestD = dT; closest = n; }
    if (n === tU || n === tV) {
      const c = gn + cost(T.e, n === tU ? T.along : tLen - T.along);
      if (c < bestEnd) { bestEnd = c; endVia = { from: n, e: T.e, part: 'end' }; }
    }
    for (const e of G.adj[n]) {
      if (!allowed(e)) continue;
      const m = G.eu[e] === n ? G.ev[e] : G.eu[e];
      const c = gn + cost(e, G.elen[e]);
      if (!g.has(m) || c < g.get(m)) { g.set(m, c); prev.set(m, { from: n, e }); heapPush(heap, [c + h(m), m]); }
    }
  }
  return { endVia, prev, closest, closestD, bestEnd };
}

// ---------- path assembly ----------
// Polyline along edge e from distance a to distance b (meters from its u end; b < a runs backwards).
function sliceEdge(e, a, b) {
  const pts = edgeCoords(e);
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + hav(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  const k = cum[cum.length - 1] ? G.elen[e] / cum[cum.length - 1] : 1;
  const at = (d) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const s0 = cum[i] * k, s1 = cum[i + 1] * k;
      if (d <= s1 || i === pts.length - 2) {
        const t = s1 > s0 ? Math.max(0, Math.min(1, (d - s0) / (s1 - s0))) : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      }
    }
    return pts[0];
  };
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const inner = pts.filter((_, i) => cum[i] * k > lo && cum[i] * k < hi);
  const out = [at(lo), ...inner, at(hi)];
  return a <= b ? out : out.reverse();
}

function assemble(S, T, sol, reachedNode) {
  const N = G.nx.length;
  const legs = [];
  let n, tail = null;
  if (reachedNode === undefined) {
    const v = sol.endVia;
    if (v.part === 'direct') return [{ e: S.e, coords: sliceEdge(S.e, S.along, T.along), meters: Math.abs(T.along - S.along) }];
    n = v.from;
    const fromU = n === G.eu[T.e];
    const endAt = fromU ? 0 : G.elen[T.e];
    tail = { e: T.e, coords: sliceEdge(T.e, endAt, T.along), meters: Math.abs(T.along - endAt) };
  } else {
    n = reachedNode;
  }
  for (;;) {
    const p = sol.prev.get(n);
    if (!p) break;
    if (p.from === N) {
      const to = n === G.eu[S.e] ? 0 : G.elen[S.e];
      legs.unshift({ e: S.e, coords: sliceEdge(S.e, S.along, to), meters: Math.abs(to - S.along) });
      break;
    }
    let coords = edgeCoords(p.e);
    if (G.eu[p.e] !== p.from) coords = coords.reverse();
    legs.unshift({ e: p.e, coords, meters: G.elen[p.e] });
    n = p.from;
  }
  if (tail) legs.push(tail);
  return legs;
}


// ---------- per-leg summary ----------
function summarize(legs, S, T, gap) {
  let meters = 0, secs = 0;
  const byKind = {}, steps = [];
  let seasonal = 0, military = 0, hc = 0, x4 = 0;
  for (const leg of legs) {
    const [kind, , name, flags] = G.attrs[G.eattr[leg.e]];
    meters += leg.meters; secs += leg.meters / (SPEED[kind] || 5);
    byKind[kind] = (byKind[kind] || 0) + leg.meters;
    if (flags & FLAG.seasonal) seasonal += leg.meters;
    if (flags & FLAG.military) military += leg.meters;
    if (flags & FLAG.hc) hc += leg.meters;
    if (flags & FLAG.x4) x4 += leg.meters;
    const label = kind === 'connector' ? null : (name || KIND[kind].label);
    const last = steps[steps.length - 1];
    if (!label || (last && last.label === label)) { if (last) last.meters += leg.meters; }
    else steps.push({ label, kind, meters: leg.meters, at: leg.coords[0] });
  }
  // fold short blips (a few hundred feet of road between two stretches of the same route) into neighbors
  const folded = [];
  for (const st of steps) {
    const last = folded[folded.length - 1];
    if (last && (st.meters < MIN_STEP_M || last.label === st.label)) last.meters += st.meters;
    else if (last && last.meters < MIN_STEP_M && folded.length > 1) { folded.pop(); folded[folded.length - 1].meters += last.meters; folded.push(st); }
    else folded.push({ ...st });
  }
  if (folded.length > 1 && folded[0].meters < MIN_STEP_M) { folded[1].meters += folded[0].meters; folded[1].at = folded[0].at; folded.shift(); }
  for (let i = folded.length - 1; i > 0; i--) {
    if (folded[i].label === folded[i - 1].label) { folded[i - 1].meters += folded[i].meters; folded.splice(i, 1); }
  }
  return {
    legs, meters, secs, byKind, steps: folded, seasonal, military, hc, x4, gap,
    offStart: S.d, offEnd: T.d, startPt: [S.lat, S.lng], endPt: [T.lat, T.lng],
  };
}

"""Build the offline routing network from the trail + forest-road features.

Every line is split wherever it touches or crosses another line, and dangling ends that stop
just short of another line (DNR digitizing gaps) get a short connector. The phone runs A* on it.

Output (graph.json):
  attrs: [[kind, lim, name, flags], ...]   flags: 1 closed, 2 seasonal, 4 military, 8 connector
  edges: [[attr_index, length_m, [x0, y0, dx1, dy1, ...]], ...]   coords are lng/lat * 1e5, delta-encoded
"""
import json
import math
from collections import defaultdict

import numpy as np
import shapely
import shapely.prepared
from shapely.geometry import LineString, Point
from shapely.ops import substring

SNAP_DEG = 0.0004        # ~30-45 m: close gaps where a trail stops just short of another line
SCALE = 100000           # 1e-5 deg ~ 1 m
CLOSURE_BUFFER_DEG = 0.00015  # ~12-15 m either side of a closure line


def meters(line):
    c = list(line.coords)
    total = 0.0
    for (x1, y1), (x2, y2) in zip(c, c[1:]):
        r = math.pi / 180
        h = math.sin((y2 - y1) * r / 2) ** 2 + math.cos(y1 * r) * math.cos(y2 * r) * math.sin((x2 - x1) * r / 2) ** 2
        total += 2 * 6371000 * math.asin(math.sqrt(h))
    return total


def build_graph(trail_features, road_features, out_path):
    lines, attrs = [], []
    attr_index = {}

    def attr_id(a):
        if a not in attr_index:
            attr_index[a] = len(attrs)
            attrs.append(list(a))
        return attr_index[a]

    for f in trail_features + road_features:
        p = f["properties"]
        if p["t"] not in ("route", "trail", "mc", "mccct", "road"):
            continue
        flags = (1 if "closed" in (p.get("s") or "").lower() else 0) | (2 if p.get("sea") else 0) | (4 if p.get("mil") else 0)
        a = attr_id((p["t"], p.get("lim") or 999, p.get("n") or "", flags))
        g = f["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for coords in parts:
            if len(coords) >= 2:
                lines.append((LineString(coords), a))

    geoms = np.array([l for l, _ in lines], dtype=object)
    tree = shapely.STRtree(geoms)
    cuts = defaultdict(set)     # line index -> distances (in degrees along line) to split at

    # 1. touches and crossings
    left, right = tree.query(geoms, predicate="intersects")
    for i, j in zip(left, right):
        if i >= j:
            continue
        inter = geoms[i].intersection(geoms[j])
        pts = []
        for part in getattr(inter, "geoms", [inter]):
            if part.is_empty:
                continue
            if part.geom_type == "Point":
                pts.append(part)
            else:  # overlapping stretch (e.g. MCCCT on a route): split at its ends
                pts += [Point(part.coords[0]), Point(part.coords[-1])]
        for pt in pts:
            cuts[i].add(geoms[i].project(pt))
            cuts[j].add(geoms[j].project(pt))

    # 2. near-miss ends -> connectors
    connectors = []
    conn_attr = attr_id(("connector", 999, "", 8))
    for i, g in enumerate(geoms):
        for end in (Point(g.coords[0]), Point(g.coords[-1])):
            near = tree.query(end, predicate="dwithin", distance=SNAP_DEG)
            best, best_d = None, SNAP_DEG
            for j in near:
                if j == i:
                    continue
                d = geoms[j].distance(end)
                if 0 < d < best_d:
                    best, best_d = j, d
            if best is None:
                continue
            # skip if this end already touches something
            if any(j != i and geoms[j].distance(end) == 0 for j in near):
                continue
            dist = geoms[best].project(end)
            cuts[best].add(dist)
            target = geoms[best].interpolate(dist)
            connectors.append(LineString([end.coords[0], target.coords[0]]))

    # 3. split and emit edges
    edges = []

    def emit(line, a):
        c = [(round(x * SCALE), round(y * SCALE)) for x, y in line.coords]
        dedup = [c[0]] + [q for p, q in zip(c, c[1:]) if q != p]
        if len(dedup) < 2:
            return
        flat = [dedup[0][0], dedup[0][1]]
        for (x0, y0), (x1, y1) in zip(dedup, dedup[1:]):
            flat += [x1 - x0, y1 - y0]
        edges.append([a, round(meters(line), 1), flat])

    # A temporary closure blocks the ground, not just the DNR line: close any road or trail piece that
    # mostly lies along a closure (e.g. a forest road under a closed ORV route).
    closure_zone = None
    closure_lines = [LineString(c) for f in trail_features if f["properties"]["t"] == "closure"
                     for c in ([f["geometry"]["coordinates"]] if f["geometry"]["type"] == "LineString"
                               else f["geometry"]["coordinates"]) if len(c) >= 2]
    if closure_lines:
        closure_zone = shapely.prepared.prep(shapely.union_all(closure_lines).buffer(CLOSURE_BUFFER_DEG))
        zone_geom = shapely.union_all(closure_lines).buffer(CLOSURE_BUFFER_DEG)

    closed_extra = 0
    for i, (g, a) in enumerate(lines):
        stops = sorted(d for d in cuts[i] if 0 < d < g.length)
        bounds = [0.0] + stops + [g.length]
        for s, e in zip(bounds, bounds[1:]):
            if e - s > 1e-9:
                piece = substring(g, s, e)
                use = a
                if closure_zone is not None and not attrs[a][3] & 1 and closure_zone.intersects(piece)                         and piece.length > 0 and piece.intersection(zone_geom).length / piece.length > 0.6:
                    kind, lim, name, flags = attrs[a]
                    use = attr_id((kind, lim, name, flags | 1))
                    closed_extra += 1
                emit(piece, use)
    print(f"  graph: {closed_extra} road/trail pieces closed because they run along a temporary closure")
    for c in connectors:
        emit(c, conn_attr)

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"attrs": attrs, "edges": edges}, fh, separators=(",", ":"))
    return len(edges), len(connectors)

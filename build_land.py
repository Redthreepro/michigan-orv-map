"""Where dispersed camping is allowed: state forest land more than 1 mile from a state forest campground.

Land ownership changes slowly, so this is run by hand (not nightly):  python build_land.py
Writes app/data/camping_land.geojson.
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import math

import shapely
import shapely.affinity
from shapely.geometry import mapping, shape, Point

PARCELS = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNRLOTSParcelsOPENDATA/FeatureServer/2"
SF_CAMPGROUNDS = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/ArcGIS/rest/services/dnrParksAndRecreation/FeatureServer/3"
OUT = Path(__file__).parent / "app" / "data" / "camping_land.geojson"
MILE_DEG_LAT = 1 / 69.0


def fetch_all(url, where, extra):
    feats, offset = [], 0
    while True:
        q = {"where": where, "outSR": "4326", "f": "geojson", "resultOffset": str(offset),
             "resultRecordCount": "1000", **extra}
        for attempt in range(4):
            try:
                with urllib.request.urlopen(f"{url}/query?{urllib.parse.urlencode(q)}", timeout=180) as r:
                    got = json.load(r).get("features", [])
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(5)
        feats += got
        if len(got) < 1000:
            return feats
        offset += len(got)
        if offset % 10000 == 0:
            print(f"  {offset} parcels…")


def main():
    parcels = fetch_all(PARCELS, "ProjectUseType='Forests'",
                        {"outFields": "ObjectID", "maxAllowableOffset": "0.0003", "geometryPrecision": "5"})
    print(f"state forest parcels: {len(parcels)}")
    geoms = [shape(f["geometry"]).buffer(0) for f in parcels if f.get("geometry")]
    # tiny gaps between neighboring parcels would leave slivers; close them while merging
    land = shapely.union_all([g.buffer(0.0002) for g in geoms]).buffer(-0.0002)

    camps = fetch_all(SF_CAMPGROUNDS, "1=1", {"outFields": "Name"})
    circles = []
    for c in camps:
        x, y = c["geometry"]["coordinates"][:2]
        # 1 mile, stretched in longitude for latitude
        circles.append(shapely.affinity.scale(Point(x, y).buffer(MILE_DEG_LAT, 32),
                                              xfact=1 / max(0.3, math.cos(math.radians(y)))))
    allowed = land.difference(shapely.union_all(circles)).simplify(0.0003, preserve_topology=True)
    parts = list(getattr(allowed, "geoms", [allowed]))
    parts = [p for p in parts if p.area > 2e-6]  # drop specks under ~5 acres
    feats = [{"type": "Feature", "properties": {"t": "campland"},
              "geometry": json.loads(json.dumps(mapping(p), default=list))} for p in parts]

    def rnd(o):
        if isinstance(o, float):
            return round(o, 5)
        if isinstance(o, (list, tuple)):
            return [rnd(v) for v in o]
        if isinstance(o, dict):
            return {k: rnd(v) for k, v in o.items()}
        return o
    OUT.write_text(json.dumps(rnd({"type": "FeatureCollection", "features": feats}), separators=(",", ":")),
                   encoding="utf-8")
    print(f"camping land: {len(feats)} polygons, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

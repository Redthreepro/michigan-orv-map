"""Public hunting land, so the map knows which trails fall under the November firearm deer season
riding hours (MCL 324.81133(1)(i): no ORVs 7-11 a.m. and 2-5 p.m. where public hunting is allowed).

Counted: state forest, state game & wildlife areas, national forest, and Commercial Forest land
(private, but open to public hunting by law). Not counted: state parks and recreation areas, where
hunting is allowed only in some parts; and private land.

Land changes slowly, so this is run by hand (not nightly):  python build_hunt.py
Writes land/hunt_land.geojson, which build.py uses every night to tag trails and roads.
"""
import json
from pathlib import Path

import shapely
from shapely.geometry import mapping, shape

from build_land import fetch_all, PARCELS, NF_OWNERSHIP, MI_FORESTS

CFA = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/ArcGIS/rest/services/CommercialForestOPENDATA/FeatureServer/0"
OUT = Path(__file__).parent / "land" / "hunt_land.geojson"
SIMPLE = {"maxAllowableOffset": "0.0003", "geometryPrecision": "5"}


def merged(feats):
    geoms = [shape(f["geometry"]).buffer(0) for f in feats if f.get("geometry")]
    # close hairline gaps between neighboring parcels while merging
    return shapely.union_all([g.buffer(0.0002) for g in geoms]).buffer(-0.0002)


def main():
    parts = {}
    state = fetch_all(PARCELS, "ProjectUseType IN ('Forests','Wildlife Game Areas')", {"outFields": "ProjectUseType", **SIMPLE})
    print(f"state forest + game area parcels: {len(state)}")
    parts["state"] = merged(state)
    forests = ",".join(f"'{f}'" for f in MI_FORESTS)
    nf = fetch_all(NF_OWNERSHIP, f"ownerclassification='USDA FOREST SERVICE' AND forestname IN ({forests})", {"outFields": "forestname", **SIMPLE})
    print(f"national forest polygons: {len(nf)}")
    parts["nf"] = merged(nf)
    cfa = fetch_all(CFA, "1=1", {"outFields": "OBJECTID", **SIMPLE})
    print(f"commercial forest parcels: {len(cfa)}")
    parts["cfa"] = merged(cfa)

    feats = []
    for own, g in parts.items():
        g = g.simplify(0.0003, preserve_topology=True)
        for p in getattr(g, "geoms", [g]):
            if p.area > 2e-6:  # drop specks under ~5 acres
                feats.append({"type": "Feature", "properties": {"own": own},
                              "geometry": json.loads(json.dumps(mapping(p), default=list))})

    def rnd(o):
        if isinstance(o, float):
            return round(o, 5)
        if isinstance(o, (list, tuple)):
            return [rnd(v) for v in o]
        if isinstance(o, dict):
            return {k: rnd(v) for k, v in o.items()}
        return o
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(rnd({"type": "FeatureCollection", "features": feats}), separators=(",", ":")), encoding="utf-8")
    print(f"hunting land: {len(feats)} polygons, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

"""Pull Michigan DNR ORV data and write trimmed GeoJSON for the PWA.

Run again any time to refresh closures/reroutes:  python build.py
"""
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DNR = "https://gisagodnr.state.mi.us/arcgis/rest/services/DNR/DNRTrailsOPENDATA/FeatureServer"
SCRAMBLE = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNR_ORV_Scramble_Areas/FeatureServer/1"

# layer id -> (type key, name field)
LAYERS = {
    11: ("route", "ORVRouteName"),
    12: ("trail", "ATVTrailName"),
    13: ("mc", "MotorcycleName"),
    14: ("mccct", "MotorcycleName"),
    0: ("closure", "TrailNamePrimary"),
    1: ("reroute", "TrailNamePrimary"),
}

OUT = Path(__file__).parent / "app" / "data"


def fetch(url, extra=None):
    feats, offset = [], 0
    while True:
        q = {
            "where": "1=1", "outFields": "*", "outSR": "4326", "f": "geojson",
            "geometryPrecision": "5", "maxAllowableOffset": "0.00003",
            "resultOffset": str(offset), "resultRecordCount": "1000",
        }
        q.update(extra or {})
        with urllib.request.urlopen(f"{url}/query?{urllib.parse.urlencode(q)}", timeout=120) as r:
            page = json.load(r)
        got = page.get("features", [])
        feats += got
        if len(got) < 1000:
            return feats
        offset += len(got)
        time.sleep(0.3)


def clean(v):
    if v in (None, "", "-1", -1, "None"):
        return None
    return v.strip() if isinstance(v, str) else v


def slim(p, kind, name_field):
    name = clean(p.get(name_field)) or clean(p.get("TrailNamePrimary")) or ""
    out = {
        "t": kind,
        "n": re.sub(r"\s+", " ", re.sub(r"[()]", "", name.removeprefix("ORV "))).strip(),
        "s": clean(p.get("OpenClosedStatusORV")),
        "w": clean(p.get("TrailWidthFeet")),
        "r": clean(p.get("SpecialRestrictionType")),
        "sf": clean(p.get("SurfaceType")),
        "c": clean(p.get("PublicComments")),
        "mi": round(p["SegmentLengthMiles"], 2) if p.get("SegmentLengthMiles") else None,
        "co": clean(p.get("County")),
        "lic": clean(p.get("LicenseType")),
        "rd": {"No": "Trail", "1": None, "-2": None}.get(clean(p.get("TrailOnRoad")), clean(p.get("TrailOnRoad"))),
    }
    # comments that just repeat the name are noise
    if out["c"] and re.sub(r"[()]", "", out["c"].removeprefix("ORV ")).strip() == out["n"]:
        out["c"] = None
    return {k: v for k, v in out.items() if v is not None}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    features = []
    for layer, (kind, name_field) in LAYERS.items():
        raw = fetch(f"{DNR}/{layer}")
        for f in raw:
            if not f.get("geometry"):
                continue
            features.append({"type": "Feature", "geometry": f["geometry"],
                             "properties": slim(f["properties"], kind, name_field)})
        print(f"layer {layer:>2} {kind:<8} {len(raw):>5} segments")

    areas = []
    for f in fetch(SCRAMBLE, {"maxAllowableOffset": "0.0001"}):
        p = f["properties"]
        name = next((p[k] for k in p if "name" in k.lower() and clean(p[k])), "Scramble area")
        areas.append({"type": "Feature", "geometry": f["geometry"],
                      "properties": {"t": "scramble", "n": name}})
    print(f"scramble areas     {len(areas):>5}")

    fc = {"type": "FeatureCollection", "features": areas + features}
    (OUT / "trails.geojson").write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    try:
        now = datetime.now(ZoneInfo("America/Detroit"))
    except Exception:  # Windows without tzdata: local clock is Michigan anyway
        now = datetime.now()
    meta = {"built": now.strftime("%Y-%m-%d %H:%M"), "segments": len(features),
            "closures": sum(1 for f in features if f["properties"]["t"] == "closure")}
    (OUT / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    size = (OUT / "trails.geojson").stat().st_size / 1e6
    print(f"wrote trails.geojson {size:.1f} MB  {meta}")


if __name__ == "__main__":
    main()

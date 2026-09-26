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

from graph import build_graph

DNR = "https://gisagodnr.state.mi.us/arcgis/rest/services/DNR/DNRTrailsOPENDATA/FeatureServer"
ROADS = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNR_ROADS/FeatureServer/0"
ROADS_WHERE = ("RoadORVUse IN ('DNR Roads Open to ORVs','DNR Roads Seasonally Closed to ORVs',"
               "'Military Roads Open to ORVs','Military Roads Seasonally Closed to ORVs')")
PARKS = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/ArcGIS/rest/services/dnrParksAndRecreation/FeatureServer"
TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer"
MVUM = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_02/MapServer"
MI_FORESTS = ("Huron-Manistee National Forest", "Hiawatha National Forest", "Ottawa National Forest")
ASSETS = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/DNRReferenceAssetsOPENDATA/FeatureServer"
ORV_WHERE = "DESCRIP LIKE '%ORV%' OR COMMENTS LIKE '%ORV%'"
OVERPASS = "https://overpass-api.de/api/interpreter"
OSM_QUERY = ('[out:json][timeout:150];area["ISO3166-2"="US-MI"]->.mi;'
             '(nwr["amenity"="fuel"](area.mi);nwr["tourism"="camp_site"](area.mi););out center tags;')
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


def fetch(url, extra=None, page=1000):
    feats, offset = [], 0
    while True:
        q = {
            "where": "1=1", "outFields": "*", "outSR": "4326", "f": "geojson",
            "geometryPrecision": "5", "maxAllowableOffset": "0.00003",
            "resultOffset": str(offset), "resultRecordCount": str(page),
        }
        q.update(extra or {})
        with urllib.request.urlopen(f"{url}/query?{urllib.parse.urlencode(q)}", timeout=120) as r:
            resp = json.load(r)
        got = resp.get("features", [])
        feats += got
        if len(got) < page:
            return feats
        offset += len(got)
        time.sleep(0.3)


def clean(v):
    if v in (None, "", "-1", -1, "None"):
        return None
    return v.strip() if isinstance(v, str) else v


def legal_limit(p, kind):
    """Widest machine (inches) the DNR designation allows, from the legal class fields.

    None means no ORV class at all (snowmobile/hiking-only), which the map drops.
    """
    lims = []
    route = p.get("ORVRoute") or ""
    if "72" in route:
        lims.append(72)
    elif "65" in route:
        lims.append(64)  # "65 Inch" routes are posted as less than 65 inches
    if "50" in (p.get("ATVTrail") or ""):
        lims.append(50)
    if (p.get("Motorcycle") or "No") != "No":
        lims.append(24)
    if lims:
        return max(lims)
    # layers 12/13 always carry their class field; this is just a fallback
    return {"trail": 50, "mc": 24, "mccct": 24}.get(kind)


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
        "lim": legal_limit(p, kind),
        # difficulty/season flags the DNR puts in the restriction text
        "hc": 2 if "4x4" in (p.get("SpecialRestrictionType") or "") else
              1 if "High Clearance" in (p.get("SpecialRestrictionType") or "") else None,
        "sea": 1 if re.search(r"Seasonal|Season ", p.get("SpecialRestrictionType") or "") else None,
        "rd": {"No": "Trail", "1": None, "-2": None}.get(clean(p.get("TrailOnRoad")), clean(p.get("TrailOnRoad"))),
    }
    # comments that just repeat the name are noise
    if out["c"] and re.sub(r"[()]", "", out["c"].removeprefix("ORV ")).strip() == out["n"]:
        out["c"] = None
    return {k: v for k, v in out.items() if v is not None}


def build_roads():
    """State forest roads open to ORVs, merged into longer lines to keep the phone map fast."""
    from collections import defaultdict
    from shapely.geometry import shape
    from shapely.ops import linemerge

    raw = fetch(ROADS, {"where": ROADS_WHERE, "maxAllowableOffset": "0.00005",
                        "outFields": "RoadPrimary,RoadORVUse,ORVOpeningDate,ORVClosingDate"})
    groups = defaultdict(list)
    for f in raw:
        if not f.get("geometry"):
            continue
        p = f["properties"]
        use = p["RoadORVUse"]
        seasonal, military = "Seasonally" in use, "Military" in use
        key = (clean(p.get("RoadPrimary")), seasonal, military,
               clean(p.get("ORVOpeningDate")) if seasonal and not military else None,
               clean(p.get("ORVClosingDate")) if seasonal and not military else None)
        g = shape(f["geometry"])
        groups[key] += list(g.geoms) if g.geom_type == "MultiLineString" else [g]

    # boat launches, access sites, parking lots: DNR tags their driveways "open", but they aren't riding
    junk = re.compile(r"\b(BAS|Access|Boat|Launch|Parking)\b", re.I)
    feats, dropped = [], 0
    for (name, seasonal, military, od, cd), lines in groups.items():
        props = {"t": "road", "n": name, "sea": 1 if seasonal else None, "mil": 1 if military else None,
                 "od": od, "cd": cd}
        props = {k: v for k, v in props.items() if v is not None}
        merged = linemerge(lines)
        for part in (merged.geoms if merged.geom_type == "MultiLineString" else [merged]):
            if name and junk.search(name) and part.length < 0.015:  # ~1 mile
                dropped += 1
                continue
            coords = [[round(x, 5), round(y, 5)] for x, y in part.coords]
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                          "properties": props})
    (OUT / "roads.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                  separators=(",", ":")), encoding="utf-8")
    print(f"forest roads  {len(raw):>6} segments -> {len(feats)} lines ({dropped} access-site stubs dropped), "
          f"{(OUT / 'roads.geojson').stat().st_size / 1e6:.1f} MB")
    return feats


def build_nf():
    """National forest roads and trails open to ORVs (USFS Motor Vehicle Use Map), Michigan forests only."""
    from collections import defaultdict
    import shapely
    from shapely.geometry import shape
    from shapely.ops import linemerge

    forests = ",".join(f"'{f}'" for f in MI_FORESTS)
    where = (f"forestname IN ({forests}) AND (atv='open' OR other_ohv_gt50inches='open' "
             "OR other_ohv_lt50inches='open' OR motorcycle='open')")
    fields = ("id,name,forestname,atv,atv_datesopen,other_ohv_gt50inches,"
              "other_ohv_gt50_datesopen,other_ohv_lt50inches,other_ohv_lt50_datesopen,motorcycle,motorcycle_datesopen")
    groups = defaultdict(list)
    total = 0
    for layer, sub in ((1, "road"), (2, "trail")):
        extra = ",surfacetype,operationalmaintlevel" if sub == "road" else ",trailclass"  # trails lack road fields
        raw = fetch(f"{MVUM}/{layer}", {"where": where, "outFields": fields + extra, "maxAllowableOffset": "0.00005"})
        total += len(raw)
        for f in raw:
            if not f.get("geometry"):
                continue
            p = f["properties"]
            is_open = lambda k: (p.get(k) or "").lower() == "open"
            # widest ORV class the Forest Service allows here, and the dates for it
            if is_open("other_ohv_gt50inches"):
                lim, dates = 999, p.get("other_ohv_gt50_datesopen")
            elif is_open("atv") or is_open("other_ohv_lt50inches"):
                lim, dates = 50, p.get("atv_datesopen") or p.get("other_ohv_lt50_datesopen")
            else:
                lim, dates = 24, p.get("motorcycle_datesopen")
            dates = clean(dates)
            ident = clean(p.get("id")) or ""
            nm = clean(p.get("name")) or ""
            label = nm if nm and nm != ident else (f"FR {ident}" if sub == "road" else f"Trail {ident}")
            key = (label, sub, lim, None if dates in (None, "01/01-12/31") else dates,
                   1 if (p.get("operationalmaintlevel") or "").startswith("2") else None,
                   (p.get("forestname") or "").replace(" National Forest", ""),
                   (clean(p.get("surfacetype")) or "").split(" - ")[-1].title() or None)
            g = shape(f["geometry"])
            groups[key] += list(g.geoms) if g.geom_type == "MultiLineString" else [g]
    feats = []
    for (label, sub, lim, dates, hc, forest, sf), lines in groups.items():
        props = {"t": "nf", "sub": sub, "n": label, "lim": lim, "dates": dates, "sea": 1 if dates else None,
                 "hc": hc, "forest": forest, "sf": sf}
        props = {k: v for k, v in props.items() if v is not None}
        merged = linemerge(lines)
        for part in shapely.get_parts(merged):
            if part.geom_type != "LineString" or len(part.coords) < 2:
                continue
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "LineString", "coordinates": [[round(x, 5), round(y, 5)] for x, y in part.coords]}})
    print(f"national forest {total:>6} segments -> {len(feats)} lines")
    return feats


def build_towns():
    """Michigan cities, villages and census places (for search), from the Census Bureau."""
    towns = []
    for layer in (4, 5):  # incorporated places, census designated places
        q = urllib.parse.urlencode({"where": "STATE='26'", "outFields": "BASENAME,INTPTLAT,INTPTLON",
                                    "returnGeometry": "false", "f": "json"})
        with urllib.request.urlopen(f"{TIGER_PLACES}/{layer}/query?{q}", timeout=120) as r:
            for f in json.load(r).get("features", []):
                a = f["attributes"]
                towns.append({"t": "town", "n": a["BASENAME"], "lat": round(float(a["INTPTLAT"]), 4),
                              "lng": round(float(a["INTPTLON"]), 4)})
    return towns


def orv_part(text):
    """'Snowmobile Trail LP 35 / ORV Lincoln Hills / ORV Little Manistee' -> 'ORV Lincoln Hills / ORV Little Manistee'."""
    parts = [p.strip(" .") for p in re.split(r"\s*/\s*|\s*\.\s+", text or "") if p.strip(" .")]
    orv = [p for p in parts if "ORV" in p or "Trail" in p and "Snowmobile" not in p]
    return " / ".join(orv or parts)


def trailhead_note(comments):
    c = (comments or "").strip()
    if not c or c.lower() == "null" or c.startswith("Source:"):
        return None
    # drop the leading "Snowmobile Parking / ORV Parking" labels, keep the directions
    c = re.sub(r"^(?:[A-Za-z ]+ Parking\s*/?\s*)+", "", c).strip(" ./")
    if re.fullmatch(r"(?:ORV|Snowmobile|Trail)(?:[\s,/&]+(?:ORV|Snowmobile|Trail))*", c, re.I):
        return None  # just a list of uses
    return c or None


def build_trailheads(trail_features):
    """DNR ORV trailheads and ORV parking lots, each tagged with the rideable trails within ~1 km."""
    from shapely.geometry import Point, shape
    import shapely

    lines, info = [], []
    for f in trail_features:
        p = f["properties"]
        if p["t"] in ("route", "trail", "mc", "mccct") and f.get("geometry"):
            lines.append(shape(f["geometry"]))
            info.append((p.get("n") or "", p.get("lim") or 0))
    tree = shapely.STRtree(lines)

    out = []
    for layer, kind in ((10, "Trailhead"), (6, "ORV parking")):
        for f in fetch(f"{ASSETS}/{layer}", {"where": ORV_WHERE, "maxAllowableOffset": "0",
                                             "outFields": "ASSETDETAILTYPE,DESCRIP,SURFMATERIAL,COMMENTS"}):
            if not f.get("geometry"):
                continue
            x, y = f["geometry"]["coordinates"][:2]
            if any(abs(o["lat"] - y) < 0.001 and abs(o["lng"] - x) < 0.0013 for o in out):
                continue  # same lot listed twice
            p = f["properties"]
            pt = Point(x, y)
            near = {}
            for i in tree.query(pt, predicate="dwithin", distance=0.012):
                name, lim = info[i]
                d = round(lines[i].distance(pt) * 111000)
                if name and (name not in near or d < near[name][1]):
                    near[name] = (lim, d)
            # "LP 35" / "UP 431" are snowmobile trail numbers riding along an ORV route; not useful here
            nearby = sorted(([n, lim, d] for n, (lim, d) in near.items() if not re.fullmatch(r"[LU]P \d+", n)),
                            key=lambda r: r[2])[:5]
            name = re.sub(r"\s+", " ", orv_part(p.get("DESCRIP")) or kind)
            if re.search(r"Sn\w*mobile", name) and "ORV" not in name and nearby:
                name = f"ORV parking · {nearby[0][0]}"
            out.append({"t": "th", "n": name, "sub": kind,
                        "note": trailhead_note(p.get("COMMENTS")), "sf": clean(p.get("SURFMATERIAL")),
                        "near": nearby, "lim": max((r[1] for r in nearby), default=0),
                        "lat": round(y, 5), "lng": round(x, 5)})
    return [{k: v for k, v in o.items() if v not in (None, "Unspecified")} for o in out]


def build_pois(trail_features):
    """Gas stations (OpenStreetMap) and campgrounds (DNR state forest + state park, plus OSM for the rest)."""
    pois = build_trailheads(trail_features)
    for layer, sub in ((3, "State forest campground"), (2, "State park campground")):
        for f in fetch(f"{PARKS}/{layer}", {"outFields": "Name,MainPhone", "maxAllowableOffset": "0"}):
            x, y = f["geometry"]["coordinates"][:2]
            p = f["properties"]
            pois.append({"t": "camp", "n": (p.get("Name") or "").strip(), "sub": sub,
                         "ph": clean(p.get("MainPhone")), "lat": round(y, 5), "lng": round(x, 5)})
    dnr = [(p["lat"], p["lng"]) for p in pois]

    dnr_subs = ("State forest campground", "State park campground")
    try:
        req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": OSM_QUERY}).encode(),
                                     headers={"User-Agent": "MichiganORVMap/1.0 (github.com/Redthreepro/michigan-orv-map)"})
        with urllib.request.urlopen(req, timeout=200) as r:
            osm = json.load(r)["elements"]
    except Exception as err:
        # Overpass is sometimes busy: reuse last run's OpenStreetMap gas/campgrounds, keep the fresh DNR data
        print(f"OpenStreetMap fetch failed ({err}); reusing previous gas stations and OSM campgrounds")
        osm = []
        try:
            old = json.loads((OUT / "pois.json").read_text(encoding="utf-8"))
            pois += [p for p in old if p["t"] == "gas" or (p["t"] == "camp" and p.get("sub") not in dnr_subs)]
        except FileNotFoundError:
            pass
    for e in osm:
        tags = e.get("tags", {})
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lng = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        if tags.get("amenity") == "fuel":
            name = tags.get("name") or tags.get("brand") or "Gas station"
            pois.append({"t": "gas", "n": name, "lat": round(lat, 5), "lng": round(lng, 5),
                         "h": tags.get("opening_hours"), "city": tags.get("addr:city")})
        else:
            # skip OSM copies of the DNR campgrounds already listed (within ~300 m)
            if any(abs(lat - a) < 0.003 and abs(lng - b) < 0.004 for a, b in dnr):
                continue
            op = tags.get("operator", "")
            sub = ("National forest campground" if "Forest Service" in op else
                   "Backcountry campsite" if tags.get("backcountry") == "yes" else "Campground")
            pois.append({"t": "camp", "n": tags.get("name") or sub, "sub": sub, "lat": round(lat, 5),
                         "lng": round(lng, 5), "ph": tags.get("phone"), "fee": tags.get("fee"),
                         "web": tags.get("website")})
    try:
        pois += build_towns()
    except Exception as err:
        print(f"town list fetch failed ({err}); search will skip towns this run")
    pois = [{k: v for k, v in p.items() if v is not None} for p in pois]
    (OUT / "pois.json").write_text(json.dumps(pois, separators=(",", ":")), encoding="utf-8")
    print(f"pois          {sum(p['t'] == 'gas' for p in pois)} gas, {sum(p['t'] == 'camp' for p in pois)} campgrounds, "
          f"{sum(p['t'] == 'th' for p in pois)} ORV trailheads/parking, {sum(p['t'] == 'town' for p in pois)} towns")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    features = []
    for layer, (kind, name_field) in LAYERS.items():
        raw = fetch(f"{DNR}/{layer}")
        for f in raw:
            if not f.get("geometry"):
                continue
            props = slim(f["properties"], kind, name_field)
            if "lim" not in props:
                continue  # hiking/snowmobile-only closure, not an ORV concern
            features.append({"type": "Feature", "geometry": f["geometry"], "properties": props})
        print(f"layer {layer:>2} {kind:<8} {len(raw):>5} segments")

    areas = []
    for f in fetch(SCRAMBLE, {"maxAllowableOffset": "0.0001"}):
        p = f["properties"]
        name = next((p[k] for k in p if "name" in k.lower() and clean(p[k])), "Scramble area")
        areas.append({"type": "Feature", "geometry": f["geometry"],
                      "properties": {"t": "scramble", "n": name}})
    print(f"scramble areas     {len(areas):>5}")

    # read last run's national forest roads before build_roads() overwrites the file (fallback below)
    try:
        prev_nf = [f for f in json.loads((OUT / "roads.geojson").read_text(encoding="utf-8"))["features"]
                   if f["properties"].get("t") == "nf"]
    except FileNotFoundError:
        prev_nf = []
    road_feats = build_roads()
    try:
        nf_feats = build_nf()
    except Exception as err:
        # Forest Service server down: keep last run's national forest roads rather than failing the whole update
        print(f"national forest fetch failed ({err}); reusing {len(prev_nf)} previous national forest roads")
        nf_feats = prev_nf
    road_feats = road_feats + nf_feats
    (OUT / "roads.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": road_feats},
                                                  separators=(",", ":")), encoding="utf-8")
    print(f"roads.geojson {(OUT / 'roads.geojson').stat().st_size / 1e6:.1f} MB (state + national forest)")
    build_pois(features)

    n_edges, n_conn = build_graph(features, road_feats, OUT / "graph.json")
    print(f"routing graph {n_edges} edges ({n_conn} gap connectors), "
          f"{(OUT / 'graph.json').stat().st_size / 1e6:.1f} MB")

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

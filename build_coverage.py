"""AT&T 4G coverage layer from the FCC National Broadband Map.

The FCC site blocks automated downloads, so the file is downloaded by hand:
  broadbandmap.fcc.gov/data-download -> Data by Provider -> AT&T -> Michigan -> Mobile Broadband 4G LTE (GeoPackage)
Save the zip into raw/, then run:  python build_coverage.py
Writes app/data/coverage.geojson with two areas: any signal, and good signal (-100 dBm or better).
"""
import glob
import json
import sqlite3
import zipfile
from pathlib import Path

import h3
import shapely
from shapely.geometry import mapping, shape

ROOT = Path(__file__).parent
OUT = ROOT / "app" / "data" / "coverage.geojson"
GOOD_DBM = -100
SIMPLIFY_DEG = 0.003  # ~250 m; the hexes themselves are ~350 m across
MIN_AREA_DEG2 = 1.2e-4  # ~1 km^2 at Michigan latitudes


def load_cells():
    zips = sorted(glob.glob(str(ROOT / "raw" / "bdc_26_130077_4GLTE_*.zip")))
    if not zips:
        raise SystemExit("No AT&T file in raw/. See the instructions at the top of this script.")
    with zipfile.ZipFile(zips[-1]) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        z.extract(name, ROOT / "raw" / "fcc")
    db = sqlite3.connect(ROOT / "raw" / "fcc" / name)
    table = db.execute("select table_name from gpkg_contents where data_type='features'").fetchone()[0]
    any_cells, good_cells = set(), set()
    for cell, dbm in db.execute(f"select h3_res9_id, minsignal from '{table}'"):
        any_cells.add(cell)
        if dbm is not None and dbm >= GOOD_DBM:
            good_cells.add(cell)
    return any_cells, good_cells, zips[-1]


def cells_to_geometry(cells):
    # h3 outlines the whole set of same-size hexes in C; then simplify for the phone
    geo = h3.cells_to_geo(list(cells))
    g = shape(geo).buffer(0)
    # drop specks and pinholes smaller than ~1 km^2: noise at riding scale, and most of the file size
    parts = []
    for p in getattr(g, "geoms", [g]):
        if p.area < MIN_AREA_DEG2:
            continue
        holes = [h for h in p.interiors if shapely.Polygon(h).area >= MIN_AREA_DEG2]
        parts.append(shapely.Polygon(p.exterior, holes))
    return shapely.MultiPolygon(parts).simplify(SIMPLIFY_DEG, preserve_topology=True)


def rounded(o):
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, (list, tuple)):
        return [rounded(v) for v in o]
    if isinstance(o, dict):
        return {k: rounded(v) for k, v in o.items()}
    return o


def main():
    any_cells, good_cells, src = load_cells()
    print(f"{len(any_cells):,} hexes with any AT&T 4G, {len(good_cells):,} with good signal")
    feats = []
    for level, cells in (("any", any_cells), ("good", good_cells)):
        g = cells_to_geometry(cells)
        feats.append({"type": "Feature", "properties": {"t": "coverage", "carrier": "AT&T", "level": level},
                      "geometry": rounded(mapping(g))})
    src_date = Path(src).stem.rsplit("_", 1)[-1]
    fc = {"type": "FeatureCollection", "features": feats, "source": f"FCC National Broadband Map, AT&T 4G LTE ({src_date})"}
    OUT.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.name}: {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

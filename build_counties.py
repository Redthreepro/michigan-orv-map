"""Michigan counties and whether their county roads are open to ORVs (county ordinances, MCL 324.81131).

There's no official statewide list, so status comes from a public compiled list (vvmapping.com, entries
dated 2009-2020) plus county ordinances checked directly (VERIFIED). The app always says "reported" with
the date and tells riders to confirm with the county sheriff. Update STATUS / VERIFIED as you learn more.

Run by hand (not nightly):  python build_counties.py   ->  app/data/counties.geojson
"""
import json
import urllib.parse
import urllib.request
from pathlib import Path

TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1"
OUT = Path(__file__).parent / "app" / "data" / "counties.geojson"
LIST_SRC = "https://www.vvmapping.com/trails/MICounties/MICounties.html"

# county: (status, note, date reported)   status: open | mostly | partial
STATUS = {
    "Alcona": ("open", "", "2014"), "Alger": ("open", "", "2014"), "Alpena": ("open", "", "2014"),
    "Antrim": ("partial", "Some roads only", "2014"), "Arenac": ("open", "", "2014"), "Baraga": ("open", "", "2014"),
    "Barry": ("mostly", "Mirror required", "2016"), "Bay": ("partial", "Some townships only (each township sets its own rules)", "2014"),
    "Benzie": ("partial", "Some roads only; 30 min before sunrise to 11 PM", "2014"), "Charlevoix": ("open", "", "2016"),
    "Cheboygan": ("open", "", "2014"), "Chippewa": ("open", "", "2014"), "Clare": ("mostly", "", "2014"),
    "Crawford": ("partial", "Some roads only", "2016"), "Delta": ("mostly", "", "2014"), "Dickinson": ("open", "", "2014"),
    "Emmet": ("partial", "Some roads only", "2014"), "Genesee": ("partial", "Some roads only; driver's license required", "2020"),
    "Gladwin": ("open", "", "2016"), "Gogebic": ("open", "", "2014"), "Grand Traverse": ("partial", "Some roads only", "2014"),
    "Gratiot": ("open", "", "2014"), "Hillsdale": ("partial", "Some roads only; driver's license required; 16 and older", "2015"),
    "Houghton": ("open", "Primary roads mostly closed", "2014"), "Huron": ("open", "14 and older", "2014"), "Ionia": ("mostly", "", "2015"),
    "Iosco": ("partial", "Some roads only", "2014"), "Iron": ("open", "", "2014"), "Isabella": ("open", "", "2014"),
    "Kalkaska": ("open", "", "2014"), "Keweenaw": ("open", "16 and older; 6 AM to midnight", "2014"),
    "Lapeer": ("mostly", "Driver's license required; 16 and older", "2014"), "Leelanau": ("open", "", "2014"),
    "Luce": ("mostly", "", "2014"), "Mackinac": ("open", "", "2014"),
    "Manistee": ("partial", "Some townships only; April 1 to November 30", "2014"),
    "Mason": ("partial", "Some townships only; 6 AM to 11 PM", "2014"), "Marquette": ("partial", "Some roads only", "2014"),
    "Mecosta": ("open", "", "2014"), "Menominee": ("partial", "Some roads only", "2014"), "Midland": ("open", "", "2014"),
    "Missaukee": ("open", "", "2014"), "Montcalm": ("open", "", "2014"), "Montmorency": ("mostly", "", "2014"),
    "Oceana": ("partial", "Some townships only (each township sets its own rules)", "2014"),
    "Ogemaw": ("partial", "Some roads only; 20 mph", "2014"), "Ontonagon": ("mostly", "", "2014"), "Osceola": ("open", "", "2014"),
    "Oscoda": ("open", "20 mph; 12 and older", "2014"), "Otsego": ("partial", "Some roads only; 16 and older", "2014"),
    "Presque Isle": ("open", "", "2014"), "Roscommon": ("open", "", "2014"), "Saginaw": ("open", "", "2014"),
    "Sanilac": ("mostly", "Primary roads for access only", "2014"), "Schoolcraft": ("open", "", "2014"),
    "Shiawassee": ("open", "16 and older", "2018"), "St. Clair": ("partial", "Some townships only (each township sets its own rules)", "2014"),
    "St. Joseph": ("open", "", "2019"), "Tuscola": ("open", "16 and older", "2014"),
    "Van Buren": ("partial", "Some townships only; 16 and older", "2019"), "Wexford": ("open", "", "2009"),
    "Lake": ("mostly", "", "2020"), "Newaygo": ("open", "", "2014"),
}
# checked against the county's own ordinance or page: (status, note, date, link)
VERIFIED = {
    "Lake": ("partial", "Designated county roads only (listed in the ordinance), year-round, far right of the road. Never on M-37, US-10 or other state/federal highways.",
             "Feb 2026", "https://lakecountymi.gov/wp-content/uploads/2026/02/Lake-County-2026-ORV-Ordinance-and-Map.pdf"),
    "Newaygo": ("open", "County ordinance: far right of the maintained portion of the road.", "2026",
                "https://www.newaygocountymi.gov/departments/county-sherrif/county-orv-ordinance/"),
    "Oceana": ("partial", "Township-by-township; see the county's ordinance list.", "2026", "https://oceana.mi.us/courts-sheriff/orv-ordinances/"),
    "Wexford": ("open", "Unpaved county roads (far right); on paved ones only the gravel/dirt shoulder. Not in Buckley, Cadillac, Harrietta, Manton or Mesick unless the town allows it. 25 mph, lights on, 12 and older.",
                "Apr 2009", "https://wexfordcounty.org/wp-content/uploads/2018/02/ORV-Ordinance-41.pdf"),
    "Osceola": ("open", "Far right of any county road; never on state or federal highways. 25 mph, lights on, 12 and older; townships may close roads.",
                "Nov 2008", "https://www.vvmapping.com/trails/MICounties/ordinances/Osceola_ORV_Ordinance.pdf"),
    "Manistee": ("partial", "Township by township: Arcadia, Bear Lake, Brown, Cleon, Dickson, Filer, Manistee, Maple Grove, Norman, Onekama, Pleasanton, Springdale (and Marilla), plus Copemish, Kaleva and Onekama villages. Mostly daylight hours, 20-25 mph, some roads closed or seasonal.",
                 "Oct 2023", "https://manisteecountymi.gov/DocumentCenter/View/2153/ORV-Road-Allowance-Manual-as-of-October-23-2023-PDF"),
    "Mecosta": ("open", "Far right of county roads; never on state or federal highways. 25 mph, lights on, 12 and older; under 18 needs a license or certificate plus an adult.",
                "Sep 2011", "https://www.mecostacounty.org/sheriff/Forms/MC-ORVOrdinance.pdf"),
    "Missaukee": ("open", "Far right of county roads; never on state or federal highways. 25 mph, lights on, 12 and older.", "Oct 2008",
                  "https://www.missaukee.org/Document_center/How%20do%20i/County%20Ordinances/2008-1_ORV_ORDINANCE.pdf"),
    "Kalkaska": ("open", "Far right of county roads; never on state or federal highways. 25 mph, lights on, 12 and older.", "Apr 2009",
                 "https://www.kalkaskasheriff.net/Document_Center/Laws%20and%20Ordinances/Kalkaska_ORV_Ord.pdf"),
    "Clare": ("open", "Far right of county roads; never on state or federal highways. 25 mph, lights on, 12 and older. Some local roads may be closed by townships.",
              "Sep 2012", "https://clareco.net/wp-content/uploads/2025/05/ORV-Ordinance-22A.pdf"),
    "Crawford": ("mostly", "All county roads in Beaver Creek, Frederic, Grayling and Maple Forest townships; South Branch except about 13 roads; Lovells only on 19 listed roads. Never on M-18, M-72, M-93, I-75, US-127 or parts of Hartwick Pines Rd / W. Federal Hwy. 25 mph, 12 and older.",
                 "Sep 2015", "https://crawfordco.org/wp-content/uploads/2017/02/ORV-ordinance-Final-09242015-revised.pdf"),
    "Roscommon": ("open", "All county roads and streets, far right; never on M-18, M-55, US-127 or I-75. 25 mph, 12 and older. A residential-area curfew was under review in 2026.",
                  "2020", "https://www.roscommoncounty.net/DocumentCenter/View/789"),
    "Montcalm": ("open", "County roads, far right; not on state trunklines or city/village streets unless the town allows it. 25 mph, 12 and older. The county ordinance does not cover motorcycles (dirt bikes) or 3-wheelers.",
                 "Oct 2025", "https://www.montcalm.us/DocumentCenter/View/5559/ORV-Ordinance-Updated-101325"),
    "Grand Traverse": ("mostly", "Open countywide except state/federal roads, all of Garfield and Acme townships, and a few listed roads (e.g. Peninsula Dr, East Shore Rd, part of Bluff Rd, Garfield Rd). 25 mph, 12 and older.",
                       "Oct 2025", "https://www.gtcountymi.gov/DocumentCenter/View/17768/Off-Road-Vehicle-Ordinance-_6"),
}
# reported from news coverage, not an official page (shown as "reported", not "ordinance")
REPORTED = {
    "Mason": ("mostly", "No county ordinance; every city, village and township has its own. Usually daylight only, 25 mph, far right of the paved lane. Never on US-10, US-31, M-116 or S. Pere Marquette Hwy (crossing is OK).",
              "Jul 2024", "https://www.masoncountypress.com/?p=90313"),
}
NO_BIKES = {"Montcalm"}  # ordinance covers 4-wheel ORVs only



def main():
    q = {"where": "STATE='26'", "outFields": "NAME,BASENAME", "outSR": "4326", "f": "geojson",
         "maxAllowableOffset": "0.004", "geometryPrecision": "4"}
    with urllib.request.urlopen(f"{TIGER}/query?{urllib.parse.urlencode(q)}", timeout=120) as r:
        fc = json.load(r)
    feats = []
    for f in fc["features"]:
        name = f["properties"].get("BASENAME") or f["properties"]["NAME"].replace(" County", "")
        st, note, upd, src = "none", "No county-wide ORV ordinance reported", "", LIST_SRC
        if name in STATUS:
            st, note, upd = STATUS[name]; src = LIST_SRC
        if name in REPORTED:
            st, note, upd, src = REPORTED[name]
        if name in VERIFIED:
            st, note, upd, src = VERIFIED[name]
        props = {"n": name, "st": st, "note": note, "upd": upd, "src": src, "ok": 1 if name in VERIFIED else 0}
        if name in NO_BIKES:
            props["nobike"] = 1
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": props})
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")
    counts = {}
    for f in feats:
        counts[f["properties"]["st"]] = counts.get(f["properties"]["st"], 0) + 1
    print(f"{len(feats)} counties -> {OUT} ({OUT.stat().st_size / 1e3:.0f} KB) {counts}")


if __name__ == "__main__":
    main()

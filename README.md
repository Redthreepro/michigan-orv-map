# Michigan ORV Map

Offline-capable phone map (PWA) of every Michigan DNR ORV route, ORV/ATV trail, motorcycle trail,
MCCCT segment, scramble area, current temporary closure/reroute, and the ~11,800 miles of state forest
roads open to ORVs (shown from zoom 10 in).

- **Trails** ship with the app (~3 MB) and work with no signal once installed.
- **Map background** (USGS topo / satellite, public domain) caches automatically wherever you browse,
  or use the download button to save a whole area before you ride.
- **GPS**: blue dot, follow mode, heading, speed, elevation — works offline.
- **Ride recording**: record button tracks your ride (distance, time, avg mph), survives the app being
  closed mid-ride, saves rides on the phone, exports GPX via the share sheet. Keep the app on screen
  while recording — phones pause GPS for web apps in the background.
- **Tap-to-route**: long-press the map (or "Route here" on any trail) for the best legal path for your
  machine over routes, trails, and forest roads — computed on the phone, works offline. Where the DNR
  network doesn't connect, it routes as close as it can and shows the gap.
- **Trips**: add stops (long-press, or any trail/gas/campground/waypoint → "Add to trip"), mark overnight
  stops to split the ride into days, see gas and campgrounds within 2 mi of the route and the longest
  stretch with no gas. Share the trip as GPX. Auto-reroutes if you leave the route with GPS on.
- **Gas & campgrounds**: OpenStreetMap gas stations; DNR state forest + state park campgrounds plus OSM.
- **Dispersed camping**: green-shaded state forest land more than 1 mile from a state forest campground
  (DNR rule). Long-press any spot to check it. Rebuild with `python build_land.py` (not nightly).
- **Waypoints**: save your own spots, route to them, add them to trips, share as GPX.
- **Offline panel** (download button): a ready-for-no-signal checklist (home-screen app vs browser tab,
  app files saved, closure data age, storage protected, location allowed, trip map saved) plus
  one-tap "Download trip map" for a 1-mile corridor along the planned trip (3 mi around camps/ends).
- **My machine** filter fades trails too narrow for your rig (50" / 64" / 72").

## Refresh trail data (closures change often)

```
pip install shapely
python build.py
```

This runs automatically every night at ~6am (GitHub Actions) and redeploys. Run it by hand only if you want a refresh right now, then commit and push `app/data/`.

Data: Michigan DNR Trails Open Data (`DNRTrailsOPENDATA` FeatureServer). Basemap: USGS The National Map.

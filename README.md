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
- **My machine** filter fades trails too narrow for your rig (50" / 64" / 72").

## Refresh trail data (closures change often)

```
pip install shapely
python build.py
```

This runs automatically every night at ~6am (GitHub Actions) and redeploys. Run it by hand only if you want a refresh right now, then commit and push `app/data/`.

Data: Michigan DNR Trails Open Data (`DNRTrailsOPENDATA` FeatureServer). Basemap: USGS The National Map.

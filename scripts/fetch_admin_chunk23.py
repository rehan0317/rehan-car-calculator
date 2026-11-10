#!/usr/bin/env python3
"""One-off: fetch admin geom chunk 23 relations ONE BY ONE.
The 8-relation chunk query kept 502/timeout-ing on all mirrors (one of the
relations — likely Multan District / Lahore City Tehsil — makes the combined
query too heavy). Single-relation queries are light and succeed.
Saves data/raw/places-v2-admin-geom-23-<relid>.json per relation, which
load_admin_polys() in fetch_places_v2.py already picks up by glob.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_places_v2 as f

IDS = ["16108433", "16108434", "16117504", "16117505",
       "16117507", "16117646", "16117647", "16117648"]
for rid in IDS:
    path = os.path.join(f.RAW, f"places-v2-admin-geom-23-{rid}.json")
    if os.path.exists(path):
        print(rid, "exists — skip", flush=True)
        continue
    q = f'[out:json][timeout:120];relation(id:{rid}); out geom;'
    d = f.overpass_query(q, f"admin-23-{rid}", attempts=4)
    if d is None:
        print(rid, "FAILED — will stay missing (tehsil/district null for "
              "its places)", flush=True)
        continue
    json.dump(d, open(path, "w"), indent=1, ensure_ascii=False)
    print(rid, "SAVED", len(d.get("elements", [])), "relations", flush=True)
    time.sleep(3)
print("chunk-23 one-off done", flush=True)

#!/usr/bin/env python3
"""Fetch villages/hamlets/suburbs around Chichawatni + hubs from Overpass
(place=city|town|village|hamlet|suburb), then OSRM road distances:
Chichawatni -> every village, and each hub -> its nearby villages.
Merges into public/data/places.json + routes-seed.json (never invents data:
every place/km comes from Overpass/OSRM responses, with source + date).
Retries Overpass on 502 (server at capacity) with exponential backoff.
Uses curl via subprocess (Python urllib hangs on this VM with proxy env).
"""
import json, math, os, subprocess, sys, time
from datetime import date

UA = "CarAppBuild/1.0 (offline rent-a-car calculator, Chichawatni; low-volume build script)"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw")
TODAY = date.today().isoformat()

CENTERS = [  # (place_id, lat, lon, radius_m, cap)
    ("chichawatni", 30.5354804, 72.6903375, 25000, 60),
    ("lahore", 31.5656822, 74.3141829, 20000, 40),
    ("islamabad", 33.6938118, 73.0651511, 20000, 40),
    ("multan", 30.197838, 71.4719683, 15000, 30),
    ("sahiwal", 30.6715098, 73.1110572, 15000, 30),
    ("okara", 30.8087231, 73.4453171, 15000, 30),
    ("pakpattan", 30.3411574, 73.3866981, 15000, 30),
    ("faisalabad", 31.4187, 73.0791, 15000, 30),
    ("lahore-airport", 31.5194982, 74.4010236, 10000, 20),
]

def curl_text(url, method="GET", data=None, timeout=90):
    cmd = ["curl", "-s", "-m", str(timeout), "-A", UA, url]
    if method == "POST":
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "--data", data]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    return r.returncode, r.stdout

def overpass(center_id, lat, lon, radius):
    q = (f'[out:json][timeout:60];'
         f'(node[place~"^(city|town|village|hamlet|suburb)$"](around:{radius},{lat},{lon}););'
         f'out body;')
    for attempt in range(5):
        import urllib.parse
        url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(q)
        code, out = curl_text(url, timeout=90)
        if code == 0 and out.startswith("{"):
            d = json.loads(out)
            return d.get("elements", [])
        print(f"overpass {center_id} attempt {attempt+1} failed (curl {code}, {out[:80]!r}); backing off", flush=True)
        time.sleep(30 * (2 ** attempt))
    return []

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlmb/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def osrm_km(a, b):
    url = (f"https://router.project-osrm.org/route/v1/driving/"
           f"{a[1]},{a[0]};{b[1]},{b[0]}?overview=false")
    code, out = curl_text(url, timeout=30)
    d = json.loads(out)
    if d.get("code") != "Ok" or not d.get("routes"):
        raise RuntimeError(f"OSRM failed: {d}")
    r = d["routes"][0]
    return round(r["distance"] / 1000, 2), round(r["duration"] / 60, 1)

def valhalla_km(a, b):
    payload = json.dumps({"locations": [{"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}],
                          "costing": "auto", "units": "kilometers"})
    code, out = curl_text("https://valhalla1.openstreetmap.de/route", method="POST", data=payload, timeout=30)
    d = json.loads(out)
    return round(float(d["trip"]["summary"]["length"]), 2)

def main():
    existing_places = json.load(open(os.path.join(RAW, "places-nominatim.json")))
    existing_routes = json.load(open(os.path.join(RAW, "routes-osrm.json")))
    known_ids = {p["id"] for p in existing_places}
    known_route_ids = {r["id"] for r in existing_routes}
    coords = {p["id"]: (p["lat"], p["lon"]) for p in existing_places}
    # Okara/Faisalabad coords were not in Nominatim list? they were; verify.
    villages = []  # (osm_id, name, place, lat, lon, near_hub)
    seen_osm = set()
    for hub, lat, lon, radius, cap in CENTERS:
        els = overpass(hub, lat, lon, radius)
        print(f"{hub}: overpass returned {len(els)} elements", flush=True)
        els.sort(key=lambda e: haversine_km(lat, lon, e["lat"], e["lon"]))
        n = 0
        for e in els:
            tags = e.get("tags", {})
            name = tags.get("name")
            if not name or e["id"] in seen_osm:
                continue
            seen_osm.add(e["id"])
            villages.append({"osm_id": e["id"], "name": name, "place": tags.get("place", "village"),
                             "lat": e["lat"], "lon": e["lon"], "near": hub})
            n += 1
            if n >= cap:
                break
        time.sleep(2)
    json.dump(villages, open(os.path.join(RAW, "villages-overpass.json"), "w"), indent=2, ensure_ascii=False)
    print(f"villages collected: {len(villages)}", flush=True)

    new_places = []
    for v in villages:
        pid = f"osm-{v['osm_id']}"
        if pid in known_ids:
            continue
        known_ids.add(pid)
        new_places.append({"id": pid, "name": v["name"], "aliases": [], "category": v["place"],
                           "lat": v["lat"], "lon": v["lon"], "source": "Overpass/OSM",
                           "fetched_at": TODAY, "near_hub": v["near"]})
        coords[pid] = (v["lat"], v["lon"])
    print(f"new places: {len(new_places)}", flush=True)

    new_routes = []
    chi = coords["chichawatni"]
    # Chichawatni -> every new village (verify a sample of 10 with Valhalla)
    chi_villages = [p for p in new_places]
    for i, p in enumerate(chi_villages):
        rid = f"chichawatni--{p['id']}"
        if rid in known_route_ids:
            continue
        try:
            km, mins = osrm_km(chi, coords[p["id"]])
        except Exception as e:
            print("OSRM fail", rid, e, flush=True)
            continue
        straight = round(haversine_km(chi[0], chi[1], p["lat"], p["lon"]), 2)
        rec = {"id": rid, "from": "chichawatni", "to": p["id"], "km": km,
               "duration_min": mins, "straight_km": straight,
               "road_straight_ratio": round(km / straight, 2) if straight else None,
               "source": "OSRM", "engine": "OSRM demo server (router.project-osrm.org)",
               "profile": "driving", "fetched_at": TODAY, "verified_km": None,
               "verified_source": None, "deviation_pct": None}
        if i < 10:
            try:
                vk = valhalla_km(chi, coords[p["id"]])
                rec["verified_km"] = vk
                rec["verified_source"] = "Valhalla demo (valhalla1.openstreetmap.de)"
                rec["deviation_pct"] = round(abs(vk - km) / km * 100, 2)
                if rec["deviation_pct"] > 10:
                    rec["flag"] = f"VERIFY WITH ODOMETER: second source (Valhalla) says {vk} km, {rec['deviation_pct']}% different from OSRM {km} km"
            except Exception as e:
                rec["verify_error"] = str(e)[:200]
            time.sleep(0.3)
        new_routes.append(rec)
        known_route_ids.add(rid)
        print(f"route {rid}: {km} km verified {rec['verified_km']} dev {rec['deviation_pct']}%", flush=True)
        time.sleep(0.15)
    # hub -> its nearby villages (cap 10 per hub, no Valhalla verify)
    from collections import defaultdict
    by_hub = defaultdict(list)
    for p in new_places:
        by_hub[p["near_hub"]].append(p)
    for hub, plist in by_hub.items():
        if hub == "chichawatni" or hub not in coords:
            continue
        for p in sorted(plist, key=lambda x: haversine_km(coords[hub][0], coords[hub][1], x["lat"], x["lon"]))[:10]:
            rid = f"{hub}--{p['id']}"
            if rid in known_route_ids:
                continue
            try:
                km, mins = osrm_km(coords[hub], coords[p["id"]])
            except Exception as e:
                print("OSRM fail", rid, e, flush=True)
                continue
            straight = round(haversine_km(coords[hub][0], coords[hub][1], p["lat"], p["lon"]), 2)
            new_routes.append({"id": rid, "from": hub, "to": p["id"], "km": km,
                               "duration_min": mins, "straight_km": straight,
                               "road_straight_ratio": round(km / straight, 2) if straight else None,
                               "source": "OSRM", "engine": "OSRM demo server (router.project-osrm.org)",
                               "profile": "driving", "fetched_at": TODAY, "verified_km": None,
                               "verified_source": None, "deviation_pct": None})
            known_route_ids.add(rid)
            time.sleep(0.15)
    print(f"DONE new_places={len(new_places)} new_routes={len(new_routes)}", flush=True)
    all_places = existing_places + new_places
    all_routes = existing_routes + new_routes
    json.dump(all_places, open(os.path.join(RAW, "places-all.json"), "w"), indent=2, ensure_ascii=False)
    json.dump(all_routes, open(os.path.join(RAW, "routes-all.json"), "w"), indent=2, ensure_ascii=False)
    # publish to public/data
    json.dump(all_places, open(os.path.join(BASE, "public", "data", "places.json"), "w"), indent=2, ensure_ascii=False)
    json.dump(all_routes, open(os.path.join(BASE, "public", "data", "routes-seed.json"), "w"), indent=2, ensure_ascii=False)

if __name__ == "__main__":
    main()

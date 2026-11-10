#!/usr/bin/env python3
"""Trimmed village fetch (replaces the full fetch_villages.py run, which stalled
on Islamabad: the Overpass server kept returning 502 at capacity for its
20 km query). Scope: the places a Chichawatni rental business actually serves —
Chichawatni 25 km + the three nearest hubs (Sahiwal, Okara, Pakpattan) 12 km.
Saves progress after EVERY center, so a kill never loses fetched data.
Merges into public/data/places.json + routes-seed.json (OSRM, Valhalla sample).
"""
import json, math, os, subprocess, sys, time, urllib.parse
from datetime import date

UA = "CarAppBuild/1.0 (offline rent-a-car calculator, Chichawatni; low-volume build script)"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw")
TODAY = date.today().isoformat()
CENTERS = [
    ("chichawatni", 30.5354804, 72.6903375, 25000, 60),
    ("sahiwal", 30.6715098, 73.1110572, 12000, 25),
    ("okara", 30.8087231, 73.4453171, 12000, 25),
    ("pakpattan", 30.3411574, 73.3866981, 12000, 25),
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
    for attempt in range(4):
        url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(q)
        code, out = curl_text(url, timeout=90)
        if code == 0 and out.startswith("{"):
            return json.loads(out).get("elements", [])
        print(f"overpass {center_id} attempt {attempt+1} failed; backing off {15*(2**attempt)}s", flush=True)
        time.sleep(15 * (2 ** attempt))
    print(f"overpass {center_id}: GIVING UP after 4 attempts (server at capacity) — skipped, not invented", flush=True)
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
    return round(float(json.loads(out)["trip"]["summary"]["length"]), 2)

def main():
    # Base = the PUBLISHED files (they carry the Valhalla dev>10% flags);
    # data/raw/routes-osrm.json does NOT have the flags.
    existing_places = json.load(open(os.path.join(BASE, "public", "data", "places.json")))
    existing_routes = json.load(open(os.path.join(BASE, "public", "data", "routes-seed.json")))
    known_ids = {p["id"] for p in existing_places}
    known_route_ids = {r["id"] for r in existing_routes}
    coords = {p["id"]: (p["lat"], p["lon"]) for p in existing_places}
    all_places, all_routes = list(existing_places), list(existing_routes)
    seen_osm = set()
    chi = coords["chichawatni"]
    verify_left = 10
    for hub, lat, lon, radius, cap in CENTERS:
        els = overpass(hub, lat, lon, radius)
        print(f"{hub}: {len(els)} elements", flush=True)
        els.sort(key=lambda e: haversine_km(lat, lon, e["lat"], e["lon"]))
        new_here = []
        for e in els[:cap * 2]:
            tags = e.get("tags", {})
            name = tags.get("name")
            if not name or e["id"] in seen_osm:
                continue
            seen_osm.add(e["id"])
            pid = f"osm-{e['id']}"
            if pid in known_ids:
                continue
            known_ids.add(pid)
            p = {"id": pid, "name": name, "aliases": [], "category": tags.get("place", "village"),
                 "lat": e["lat"], "lon": e["lon"], "source": "Overpass/OSM",
                 "fetched_at": TODAY, "near_hub": hub}
            new_here.append(p)
            coords[pid] = (e["lat"], e["lon"])
            if len(new_here) >= cap:
                break
        # routes: Chichawatni -> each new place; hub -> its new places (cap 10)
        for p in new_here:
            for frm, a in (("chichawatni", chi), (hub, (lat, lon)) if hub != "chichawatni" else (None, None)):
                if frm is None:
                    continue
                rid = f"{frm}--{p['id']}"
                if rid in known_route_ids:
                    continue
                try:
                    km, mins = osrm_km(a, coords[p["id"]])
                except Exception as ex:
                    print("OSRM fail", rid, ex, flush=True)
                    continue
                straight = round(haversine_km(a[0], a[1], p["lat"], p["lon"]), 2)
                rec = {"id": rid, "from": frm, "to": p["id"], "km": km, "duration_min": mins,
                       "straight_km": straight,
                       "road_straight_ratio": round(km / straight, 2) if straight else None,
                       "source": "OSRM", "engine": "OSRM demo server (router.project-osrm.org)",
                       "profile": "driving", "fetched_at": TODAY, "verified_km": None,
                       "verified_source": None, "deviation_pct": None}
                if frm == "chichawatni" and verify_left > 0:
                    verify_left -= 1
                    try:
                        vk = valhalla_km(a, coords[p["id"]])
                        rec["verified_km"] = vk
                        rec["verified_source"] = "Valhalla demo (valhalla1.openstreetmap.de)"
                        rec["deviation_pct"] = round(abs(vk - km) / km * 100, 2)
                        if rec["deviation_pct"] > 10:
                            rec["flag"] = f"VERIFY WITH ODOMETER: second source (Valhalla) says {vk} km, {rec['deviation_pct']}% different from OSRM {km} km"
                    except Exception as ex:
                        rec["verify_error"] = str(ex)[:200]
                    time.sleep(0.3)
                all_routes.append(rec)
                known_route_ids.add(rid)
                time.sleep(0.15)
        all_places.extend(new_here)
        # INCREMENTAL SAVE after every center
        json.dump(all_places, open(os.path.join(RAW, "places-all.json"), "w"), indent=2, ensure_ascii=False)
        json.dump(all_routes, open(os.path.join(RAW, "routes-all.json"), "w"), indent=2, ensure_ascii=False)
        json.dump(all_places, open(os.path.join(BASE, "public", "data", "places.json"), "w"), indent=2, ensure_ascii=False)
        json.dump(all_routes, open(os.path.join(BASE, "public", "data", "routes-seed.json"), "w"), indent=2, ensure_ascii=False)
        print(f"SAVED after {hub}: places={len(all_places)} routes={len(all_routes)}", flush=True)
        time.sleep(2)
    print(f"DONE places={len(all_places)} routes={len(all_routes)}", flush=True)

if __name__ == "__main__":
    main()

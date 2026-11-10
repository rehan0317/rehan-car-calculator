#!/usr/bin/env python3
"""Fetch real place coords (Nominatim, 1 req/s, UA per policy) + road distances
(OSRM demo server) + second-source check (Valhalla demo). No invented data:
every km in the output comes from a routing-engine response, with source+date.
Uses curl via subprocess (Python urllib hangs on this VM with proxy env).
Overpass villages: attempted separately; if the server is at capacity the
script records that and ships cities/hubs only (see coverage report).
"""
import json, math, os, subprocess, sys, time
from datetime import date

UA = "CarAppBuild/1.0 (offline rent-a-car calculator, Chichawatni; low-volume build script)"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw")
os.makedirs(RAW, exist_ok=True)
TODAY = date.today().isoformat()

def curl_json(url, method="GET", data=None, timeout=60):
    cmd = ["curl", "-s", "-m", str(timeout), "-A", UA, url]
    if method == "POST":
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "--data", data]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    if r.returncode != 0:
        raise RuntimeError(f"curl exit {r.returncode} for {url}: {r.stderr[:300]}")
    return json.loads(r.stdout)

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlmb/2)**2
    return 2 * R * math.asin(math.sqrt(a))

# (id, display name, nominatim query, category, aliases)
PLACES_Q = [
    ("chichawatni", "Chichawatni", "Chichawatni, Sahiwal, Punjab, Pakistan", "town", ["Chicha Watni", "ChichaWatni"]),
    ("lahore", "Lahore", "Lahore, Punjab, Pakistan", "city", []),
    ("lahore-airport", "Lahore Airport", "Allama Iqbal International Airport, Lahore, Pakistan", "airport", ["Lahore Airport", "Allama Iqbal Airport", "LHE"]),
    ("islamabad", "Islamabad", "Islamabad, Pakistan", "city", []),
    ("multan", "Multan", "Multan, Punjab, Pakistan", "city", []),
    ("sahiwal", "Sahiwal", "Sahiwal, Punjab, Pakistan", "city", []),
    ("okara", "Okara", "Okara, Punjab, Pakistan", "city", []),
    ("pakpattan", "Pakpattan", "Pakpattan, Punjab, Pakistan", "city", []),
    ("faisalabad", "Faisalabad", "Faisalabad, Punjab, Pakistan", "city", []),
    ("rawalpindi", "Rawalpindi", "Rawalpindi, Punjab, Pakistan", "city", ["Pindi"]),
    ("gujranwala", "Gujranwala", "Gujranwala, Punjab, Pakistan", "city", []),
    ("sargodha", "Sargodha", "Sargodha, Punjab, Pakistan", "city", []),
    ("bahawalpur", "Bahawalpur", "Bahawalpur, Punjab, Pakistan", "city", []),
    ("arifwala", "Arifwala", "Arifwala, Punjab, Pakistan", "town", []),
    ("mian-channu", "Mian Channu", "Mian Channu, Punjab, Pakistan", "town", []),
    ("burewala", "Burewala", "Burewala, Punjab, Pakistan", "town", []),
    ("vehari", "Vehari", "Vehari, Punjab, Pakistan", "city", []),
    ("khanewal", "Khanewal", "Khanewal, Punjab, Pakistan", "city", []),
    ("toba-tek-singh", "Toba Tek Singh", "Toba Tek Singh, Punjab, Pakistan", "city", ["Toba"]),
    ("jhang", "Jhang", "Jhang, Punjab, Pakistan", "city", []),
    ("kasur", "Kasur", "Kasur, Punjab, Pakistan", "city", []),
    ("sheikhupura", "Sheikhupura", "Sheikhupura, Punjab, Pakistan", "city", []),
    ("harappa", "Harappa", "Harappa, Sahiwal, Punjab, Pakistan", "town", []),
]

def nominatim(q):
    from urllib.parse import quote
    url = f"https://nominatim.openstreetmap.org/search?q={quote(q)}&format=json&limit=1"
    d = curl_json(url)
    if not d:
        raise RuntimeError(f"Nominatim: no result for {q}")
    return float(d[0]["lat"]), float(d[0]["lon"]), d[0].get("display_name", "")

def osrm_km(a, b):
    url = (f"https://router.project-osrm.org/route/v1/driving/"
           f"{a[1]},{a[0]};{b[1]},{b[0]}?overview=false")
    d = curl_json(url)
    if d.get("code") != "Ok" or not d.get("routes"):
        raise RuntimeError(f"OSRM failed: {d}")
    r = d["routes"][0]
    return round(r["distance"] / 1000, 2), round(r["duration"] / 60, 1)

def valhalla_km(a, b):
    payload = json.dumps({"locations": [{"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}],
                          "costing": "auto", "units": "kilometers"})
    d = curl_json("https://valhalla1.openstreetmap.de/route", method="POST", data=payload)
    return round(float(d["trip"]["summary"]["length"]), 2)

def main():
    places, coords = [], {}
    for pid, name, q, cat, aliases in PLACES_Q:
        lat, lon, disp = nominatim(q)
        coords[pid] = (lat, lon)
        places.append({"id": pid, "name": name, "aliases": aliases, "category": cat,
                       "lat": lat, "lon": lon, "source": "Nominatim/OSM", "fetched_at": TODAY})
        print(f"place {pid}: {lat:.5f},{lon:.5f}  {name}", flush=True)
        time.sleep(1.2)  # Nominatim usage policy: max 1 req/s
    json.dump(places, open(os.path.join(RAW, "places-nominatim.json"), "w"), indent=2, ensure_ascii=False)

    origin = "chichawatni"
    dests = [p["id"] for p in places if p["id"] != origin]
    routes = []
    def add_route(frm, to, verify=True):
        a, b = coords[frm], coords[to]
        km, mins = osrm_km(a, b)
        straight = round(haversine_km(a[0], a[1], b[0], b[1]), 2)
        ratio = round(km / straight, 2) if straight else None
        rec = {"id": f"{frm}--{to}", "from": frm, "to": to, "km": km,
               "duration_min": mins, "straight_km": straight, "road_straight_ratio": ratio,
               "source": "OSRM", "engine": "OSRM demo server (router.project-osrm.org)",
               "profile": "driving", "fetched_at": TODAY, "verified_km": None,
               "verified_source": None, "deviation_pct": None}
        if ratio and ratio > 2.0:
            rec["flag"] = "ratio>2.0 needs review"
        if verify:
            try:
                vk = valhalla_km(a, b)
                rec["verified_km"] = vk
                rec["verified_source"] = "Valhalla demo (valhalla1.openstreetmap.de)"
                rec["deviation_pct"] = round(abs(vk - km) / km * 100, 2)
            except Exception as e:
                rec["verify_error"] = str(e)[:200]
            time.sleep(0.3)
        routes.append(rec)
        print(f"route {frm}->{to}: OSRM {km} km straight {straight} ratio {ratio} verified {rec['verified_km']} dev {rec['deviation_pct']}%", flush=True)
        time.sleep(0.2)

    for d in dests:
        add_route(origin, d, verify=True)
    # hub <-> hub for main hubs (one direction each pair)
    hubs = ["lahore", "lahore-airport", "islamabad", "multan", "sahiwal", "okara", "pakpattan", "faisalabad"]
    for i in range(len(hubs)):
        for j in range(i + 1, len(hubs)):
            add_route(hubs[i], hubs[j], verify=False)
    json.dump(routes, open(os.path.join(RAW, "routes-osrm.json"), "w"), indent=2)
    over10 = [r for r in routes if r.get("deviation_pct") is not None and r["deviation_pct"] > 10]
    print(f"DONE places={len(places)} routes={len(routes)} verified={sum(1 for r in routes if r['verified_km'])} dev>10%={len(over10)}")
    for r in over10:
        print("DEV>10%:", r["id"], r["km"], r["verified_km"], r["deviation_pct"])

if __name__ == "__main__":
    main()

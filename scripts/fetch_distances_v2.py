#!/usr/bin/env python3
"""Fetch road distances for Car Calculator REVISION v2 (sections D + toll geometry E).

Stages (run in order; every stage resumes from files already on disk):
  table      OSRM TABLE: Chichawatni -> every place (batches of 100 dests)
             + hub<->hub (one table call per hub source, dests = all 147 hubs).
  crosscheck Valhalla (valhalla1.openstreetmap.de) second-source check for
             48 routes: the 9 known-deviation routes + 15 cities + 24 villages.
  tollmap    Toll-plaza mapping: corridor pre-filter (plaza within 25 km of the
             straight from->to segment) -> candidate routes only get a full
             OSRM route geometry fetch (overview=full, geojson) and a precise
             point-to-line intersection (plaza within 60 m of the route
             LineString = crossed). Non-candidates get zero plazas by method.
  build      Assemble public/data/routes-seed.json in the v1 schema, run
             sanity checks, write CROSSCHECK-v2.md + COVERAGE.md section.

Hard rules (do not weaken):
  * HTTP via curl subprocess ONLY - Python urllib hangs on this VM (proxy env).
  * NEVER straight-line km as a route value; NEVER invent a km, fare or plaza.
  * The 9 v1 "VERIFY WITH ODOMETER" routes keep their stored v1 OSRM km and
    v1 verified values even if a re-fetch differs; differences are flagged.
  * Toll FARES come from data/tolls.json as written by the fare-verification
    agent (read FRESH at build time; never hardcode nulls, never fill a fare
    from memory or from the reported Rs 100 figure yourself). A plaza with
    no verified fare in tolls.json ships fareOut/fareBack null.
  * v1 rows (202) are preserved verbatim; only a `tolls` field is added.

Usage:
  python3 scripts/fetch_distances_v2.py table [--limit N]
  python3 scripts/fetch_distances_v2.py crosscheck
  python3 scripts/fetch_distances_v2.py tollmap [--workers 6] [--limit N]
  python3 scripts/fetch_distances_v2.py build
  python3 scripts/fetch_distances_v2.py all
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time
from datetime import date
from multiprocessing import Pool

UA = "CarAppBuild/2.0 (offline rent-a-car calculator, Chichawatni; low-volume build script)"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw")
DATA = os.path.join(BASE, "data")
PUBLIC = os.path.join(BASE, "public", "data")
TODAY = date.today().isoformat()
os.makedirs(RAW, exist_ok=True)

OSRM_TABLE = "https://router.project-osrm.org/table/v1/driving/"
OSRM_ROUTE = "https://router.project-osrm.org/route/v1/driving/"
VALHALLA = "https://valhalla1.openstreetmap.de/route"

CHI_ID = "chichawatni"
CORRIDOR_KM = 25.0      # plaza within this of the straight from->to segment = candidate
CROSS_M = 60.0          # plaza within this of the route LineString = crossed
BATCH = 100             # destinations per OSRM table call (101 coords incl. source)
TOLLMAP_BATCH = 50      # routes per tollmap result file

# The 9 v1 routes flagged VERIFY WITH ODOMETER (kept at stored v1 values).
KNOWN_DEVIATIONS = [
    "chichawatni--sargodha", "chichawatni--jhang", "chichawatni--lahore-airport",
    "chichawatni--rawalpindi", "chichawatni--islamabad", "chichawatni--multan",
    "chichawatni--arifwala", "chichawatni--sheikhupura", "chichawatni--osm-4427361667",
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def curl_json(url, method="GET", data=None, timeout=90, attempts=5):
    """GET/POST JSON via curl. Retries with exponential backoff on any failure.
    Returns (parsed_json, attempts_used, error_or_None)."""
    sleeps = [2, 8, 30, 90]
    last_err = None
    for att in range(attempts):
        cmd = ["curl", "-s", "-m", str(timeout), "-A", UA, url]
        if method == "POST":
            cmd += ["-X", "POST", "-H", "Content-Type: application/json", "--data", data]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
        except subprocess.TimeoutExpired as e:
            last_err = f"curl timeout: {e}"
            if att < attempts - 1:
                time.sleep(sleeps[min(att, len(sleeps) - 1)])
            continue
        if r.returncode != 0:
            last_err = f"curl exit {r.returncode}: {r.stderr[:200]}"
        else:
            try:
                return json.loads(r.stdout), att + 1, None
            except Exception as e:
                last_err = f"bad JSON ({str(e)[:100]}): {r.stdout[:200]}"
        if att < attempts - 1:
            time.sleep(sleeps[min(att, len(sleeps) - 1)])
    return None, attempts, last_err


def haversine_km(lat1, lon1, lat2, lon2):
    """Same formula as src/lib/calc.ts haversineKm (R=6371). Sanity only."""
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def load_places():
    places = json.load(open(os.path.join(PUBLIC, "places.json")))
    by_id = {p["id"]: p for p in places}
    return places, by_id


def load_v1_routes():
    """The FROZEN v1 seed (202 rows, from git HEAD) - never read the live
    routes-seed.json here: after build #1 overwrote it, reading it back
    would treat built rows as v1 (this exact mistake happened once)."""
    v1 = json.load(open(os.path.join(RAW, "routes-seed-v1.json")))
    assert len(v1) == 202, f"frozen v1 must have 202 rows, has {len(v1)}"
    return v1


def load_tolls():
    return json.load(open(os.path.join(DATA, "tolls.json")))["plazas"]


def load_state():
    p = os.path.join(RAW, "routes-v2-state.json")
    if os.path.exists(p):
        return json.load(open(p))
    return {"table_chi_batches": [], "table_hub_sources": [], "table_failures": {},
            "table_unreachable": [], "crosscheck_done": False, "tollmap_batches": [],
            "tollmap_failures": {}, "build_done": False}


def save_state(state):
    json.dump(state, open(os.path.join(RAW, "routes-v2-state.json"), "w"), indent=2)


# ---------------------------------------------------------------- table stage
def stage_table(limit=None):
    places, by_id = load_places()
    state = load_state()
    chi = by_id[CHI_ID]
    dests = [p for p in places if p["id"] != CHI_ID]
    log(f"table: {len(dests)} destinations from Chichawatni in batches of {BATCH}")
    n_batches = math.ceil(len(dests) / BATCH)
    done = set(state["table_chi_batches"])
    failures = state["table_failures"]
    for bi in range(n_batches):
        if limit is not None and bi >= limit:
            break
        if bi in done:
            continue
        chunk = dests[bi * BATCH:(bi + 1) * BATCH]
        coords = ";".join([f"{chi['lon']},{chi['lat']}"] +
                          [f"{p['lon']},{p['lat']}" for p in chunk])
        url = f"{OSRM_TABLE}{coords}?sources=0&annotations=distance,duration"
        d, used, err = curl_json(url, timeout=120)
        if err or not d or d.get("code") != "Ok":
            failures[f"chi-batch-{bi}"] = (err or f"code={d.get('code') if d else None}")[:300]
            save_state(state)
            log(f"table chi batch {bi}: FAILED ({failures[f'chi-batch-{bi}'][:120]}) - recorded, continuing")
            time.sleep(5)
            continue
        raw_path = os.path.join(RAW, f"routes-v2-table-chi-{bi:03d}.json")
        json.dump({"batch": bi, "dest_ids": [p["id"] for p in chunk],
                   "response": d}, open(raw_path, "w"))
        done.add(bi)
        state["table_chi_batches"] = sorted(done)
        save_state(state)
        row = d["distances"][0]
        n_null = sum(1 for v in row[1:] if v is None)
        log(f"table chi batch {bi}/{n_batches - 1}: ok ({len(chunk)} dests, {n_null} null) attempts={used}")
        time.sleep(2.0)
    # hub <-> hub: one table call per hub source, destinations = all hubs
    hubs = [p for p in places if p["type"] in ("city", "town", "airport")]
    hub_ids = [h["id"] for h in hubs]
    hub_idx = {h["id"]: i for i, h in enumerate(hubs)}
    log(f"table: hub<->hub for {len(hubs)} hubs (one call per source hub)")
    done_h = set(state["table_hub_sources"])
    for h in hubs:
        if h["id"] == CHI_ID:
            continue  # Chichawatni->hub rows already covered by chi batches
        if h["id"] in done_h:
            continue
        coords = ";".join(f"{x['lon']},{x['lat']}" for x in hubs)
        url = (f"{OSRM_TABLE}{coords}?sources={hub_idx[h['id']]}"
               f"&annotations=distance,duration")
        d, used, err = curl_json(url, timeout=120)
        if err or not d or d.get("code") != "Ok":
            failures[f"hub-{h['id']}"] = (err or f"code={d.get('code') if d else None}")[:300]
            save_state(state)
            log(f"table hub {h['id']}: FAILED - recorded, continuing")
            time.sleep(5)
            continue
        raw_path = os.path.join(RAW, f"routes-v2-table-hub-{h['id']}.json")
        json.dump({"source": h["id"], "hub_ids": hub_ids, "response": d},
                  open(raw_path, "w"))
        done_h.add(h["id"])
        state["table_hub_sources"] = sorted(done_h)
        save_state(state)
        log(f"table hub {h['id']}: ok attempts={used}")
        time.sleep(2.0)
    # unreachable pairs: retry once via single route API, else record as missing
    unreachable = collect_null_pairs()
    if unreachable:
        log(f"table: {len(unreachable)} null pairs - retrying once via route API")
        still = []
        for frm, to in unreachable:
            a, b = by_id[frm], by_id[to]
            url = (f"{OSRM_ROUTE}{a['lon']},{a['lat']};{b['lon']},{b['lat']}"
                   f"?overview=false")
            d, used, err = curl_json(url, timeout=60, attempts=3)
            if d and d.get("code") == "Ok" and d.get("routes"):
                rr = d["routes"][0]
                json.dump({"from": frm, "to": to, "km": round(rr["distance"] / 1000, 2),
                           "duration_min": round(rr["duration"] / 60, 1), "via": "route-retry"},
                          open(os.path.join(RAW, f"routes-v2-retry-{frm}--{to}.json"), "w"))
                log(f"  retry {frm}--{to}: recovered {round(rr['distance'] / 1000, 2)} km")
            else:
                still.append([frm, to])
            time.sleep(0.3)
        state["table_unreachable"] = still
        save_state(state)
        log(f"table: unreachable after retry: {len(still)} {still[:10]}")
    log(f"table DONE: chi batches {len(state['table_chi_batches'])}/{n_batches}, "
        f"hub sources {len(state['table_hub_sources'])}/{len(hubs) - 1}, "
        f"failures {len(failures)}")
    return state


def collect_null_pairs():
    """Scan saved table raw files for null distances; return [(from,to)] pairs."""
    import glob
    places, by_id = load_places()
    nulls = []
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-table-chi-*.json"))):
        d = json.load(open(path))
        resp, dests = d["response"], d["dest_ids"]
        row = resp["distances"][0]
        for j, dest in enumerate(dests):
            if row[j + 1] is None:
                nulls.append([CHI_ID, dest])
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-table-hub-*.json"))):
        d = json.load(open(path))
        resp, hubs = d["response"], d["hub_ids"]
        row = resp["distances"][0]
        for j, dest in enumerate(hubs):
            if row[j] is None and dest != d["source"]:
                nulls.append([d["source"], dest])
    return nulls


def parse_table_results():
    """Read saved table raw files -> {(from,to): (km, duration_min)} + nulls."""
    import glob
    results, nulls = {}, []
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-table-chi-*.json"))):
        d = json.load(open(path))
        resp, dests = d["response"], d["dest_ids"]
        dists, durs = resp["distances"][0], resp.get("durations", [[]])[0]
        for j, dest in enumerate(dests):
            v = dists[j + 1]
            if v is None:
                nulls.append((CHI_ID, dest))
            else:
                results[(CHI_ID, dest)] = (
                    round(v / 1000, 2),
                    round(durs[j + 1] / 60, 1) if durs and durs[j + 1] is not None else None)
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-table-hub-*.json"))):
        d = json.load(open(path))
        resp, hubs = d["response"], d["hub_ids"]
        dists, durs = resp["distances"][0], resp.get("durations", [[]])[0]
        for j, dest in enumerate(hubs):
            if dest == d["source"]:
                continue
            v = dists[j]
            if v is None:
                nulls.append((d["source"], dest))
            else:
                results[(d["source"], dest)] = (
                    round(v / 1000, 2),
                    round(durs[j] / 60, 1) if durs and durs[j] is not None else None)
    # single-route retries recovered after a null
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-retry-*.json"))):
        d = json.load(open(path))
        results[(d["from"], d["to"])] = (d["km"], d["duration_min"])
        if (d["from"], d["to"]) in nulls:
            nulls.remove((d["from"], d["to"]))
    return results, nulls

# ------------------------------------------------------------ crosscheck stage
def valhalla_km(a, b):
    payload = json.dumps({"locations": [{"lat": a[0], "lon": a[1]},
                                        {"lat": b[0], "lon": b[1]}],
                          "costing": "auto", "units": "kilometers"})
    d, used, err = curl_json(VALHALLA, method="POST", data=payload, timeout=60)
    if err or not d or "trip" not in d:
        raise RuntimeError(err or f"valhalla bad response: {str(d)[:200]}")
    return round(float(d["trip"]["summary"]["length"]), 2)


def select_crosscheck_routes():
    """48 routes: 9 known deviations + 15 cities + 24 stratified villages."""
    places, by_id = load_places()
    v1 = {r["id"]: r for r in load_v1_routes()}
    table, _ = parse_table_results()
    chi = by_id[CHI_ID]
    chosen = []  # (route_id, osrm_km)

    def osrm_km(frm, to):
        if (frm, to) in table:
            return table[(frm, to)][0]
        r = v1.get(f"{frm}--{to}")
        return r["km"] if r else None

    for rid in KNOWN_DEVIATIONS:
        frm, to = rid.split("--")
        chosen.append((rid, osrm_km(frm, to)))
    # 15 cities/hubs (not already chosen), alphabetical by id for determinism
    city_ids = sorted(p["id"] for p in places
                      if p["type"] in ("city", "town", "airport")
                      and p["id"] != CHI_ID
                      and f"{CHI_ID}--{p['id']}" not in [c[0] for c in chosen])
    for pid in city_ids[:15]:
        chosen.append((f"{CHI_ID}--{pid}", osrm_km(CHI_ID, pid)))
    # 24 villages stratified by straight-line distance band from Chichawatni
    villages = [p for p in places if p["type"] == "village"]
    bands = [(0, 10), (10, 25), (25, 50), (50, 100), (100, 1e9)]
    per_band = [3, 5, 6, 5, 5]
    picked = set()
    for (lo, hi), n in zip(bands, per_band):
        cands = sorted(
            [p for p in villages
             if lo <= haversine_km(chi["lat"], chi["lon"], p["lat"], p["lon"]) < hi
             and p["id"] not in picked],
            key=lambda p: p["id"])
        if not cands:
            continue
        step = max(1, len(cands) // n)
        for k in range(n):
            p = cands[min(k * step, len(cands) - 1)]
            if p["id"] in picked:
                continue
            picked.add(p["id"])
            chosen.append((f"{CHI_ID}--{p['id']}", osrm_km(CHI_ID, p["id"])))
    chosen = [(rid, km) for rid, km in chosen if km is not None]
    return chosen


def stage_crosscheck():
    places, by_id = load_places()
    state = load_state()
    chosen = select_crosscheck_routes()
    log(f"crosscheck: {len(chosen)} routes selected "
        f"(9 known + 15 cities + {len(chosen) - 24} villages)")
    rows, failures = [], {}
    for rid, okm in chosen:
        frm, to = rid.split("--")
        a, b = by_id[frm], by_id[to]
        try:
            vk = valhalla_km((a["lat"], a["lon"]), (b["lat"], b["lon"]))
            dev = round(abs(vk - okm) / okm * 100, 2) if okm else None
            rows.append({"route": rid, "from": frm, "to": to, "osrm_km": okm,
                         "valhalla_km": vk, "deviation_pct": dev,
                         "type": by_id[to]["type"]})
            log(f"  {rid}: OSRM {okm} Valhalla {vk} dev {dev}%")
        except Exception as e:
            failures[rid] = str(e)[:200]
            rows.append({"route": rid, "from": frm, "to": to, "osrm_km": okm,
                         "valhalla_km": None, "deviation_pct": None,
                         "type": by_id[to]["type"], "error": str(e)[:200]})
            log(f"  {rid}: VALHALLA FAILED {str(e)[:120]}")
        time.sleep(0.3)
    json.dump({"fetched_at": TODAY, "engine": "Valhalla demo (valhalla1.openstreetmap.de)",
               "rows": rows, "failures": failures},
              open(os.path.join(RAW, "routes-v2-crosscheck.json"), "w"), indent=2)
    state["crosscheck_done"] = True
    state["crosscheck_failures"] = failures
    save_state(state)
    over = [r for r in rows if r["deviation_pct"] is not None and r["deviation_pct"] > 10]
    log(f"crosscheck DONE: {len(rows)} routes, {len(over)} deviate >10%, "
        f"{len(failures)} Valhalla failures")
    return rows


# -------------------------------------------------------------- tollmap stage
def _xy(lat, lon, lat0_rad):
    """Equirectangular local metres (good for short distances; used for both
    the 25 km corridor pre-filter and the 60 m precise intersection)."""
    R = 6371.0
    return (math.radians(lon) * math.cos(lat0_rad) * R * 1000,
            math.radians(lat) * R * 1000)


def pt_seg_dist_m(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def corridor_candidates(pairs, places_by_id, plazas):
    """pairs: [(from_id, to_id)]. Returns {route_id: [plaza, ...]} for routes
    with >=1 plaza within CORRIDOR_KM of the straight from->to segment."""
    cands = {}
    for frm, to in pairs:
        a, b = places_by_id[frm], places_by_id[to]
        lat0 = math.radians((a["lat"] + b["lat"]) / 2)
        ax, ay = _xy(a["lat"], a["lon"], lat0)
        bx, by = _xy(b["lat"], b["lon"], lat0)
        near = []
        for pl in plazas:
            px, py = _xy(pl["lat"], pl["lon"], lat0)
            if pt_seg_dist_m(px, py, ax, ay, bx, by) <= CORRIDOR_KM * 1000:
                near.append(pl)
        if near:
            cands[f"{frm}--{to}"] = near
    return cands


def route_pairs_all():
    """Full stored-route pair list: v1 pairs + new Chi->place + new hub<->hub.
    Hub pairs: one direction per unordered pair, from = alphabetically-first
    place id (places.json is alphabetical by id). Chichawatni pairs live only
    in the Chi->place set (no duplicate hub rows for Chichawatni)."""
    places, by_id = load_places()
    v1 = load_v1_routes()
    pairs = [(r["from"], r["to"]) for r in v1]
    # Unordered seen-set: v1 directions are kept verbatim, so a v1 pair
    # (lahore->islamabad) must NOT gain a reverse alphabetical row
    # (islamabad->lahore). One row per unordered pair.
    seen = {frozenset((f, t)) for f, t in pairs}
    for p in places:
        if p["id"] != CHI_ID and frozenset((CHI_ID, p["id"])) not in seen:
            pairs.append((CHI_ID, p["id"]))
            seen.add(frozenset((CHI_ID, p["id"])))
    hubs = sorted([p["id"] for p in places if p["type"] in ("city", "town", "airport")])
    for i, a in enumerate(hubs):
        for b in hubs[i + 1:]:
            if a == CHI_ID or b == CHI_ID:
                continue
            if frozenset((a, b)) not in seen:
                pairs.append((a, b))
                seen.add(frozenset((a, b)))
    return pairs


def crossed_plazas_for_route(frm, to, places_by_id, plazas):
    """Fetch OSRM route geometry; return crossed plazas [{id,name,min_dist_m}].
    Raises on fetch failure (caller retries / records)."""
    a, b = places_by_id[frm], places_by_id[to]
    url = (f"{OSRM_ROUTE}{a['lon']},{a['lat']};{b['lon']},{b['lat']}"
           f"?overview=full&geometries=geojson")
    d, used, err = curl_json(url, timeout=120, attempts=4)
    if err or not d or d.get("code") != "Ok" or not d.get("routes"):
        raise RuntimeError(err or f"osrm route code={d.get('code') if d else None}")
    coords = d["routes"][0]["geometry"]["coordinates"]  # [lon, lat]
    osrm_km = round(d["routes"][0]["distance"] / 1000, 2)
    dur = round(d["routes"][0]["duration"] / 60, 1)
    lat0 = math.radians((a["lat"] + b["lat"]) / 2)
    segs = []
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        x1, y1 = _xy(lat1, lon1, lat0)
        x2, y2 = _xy(lat2, lon2, lat0)
        segs.append((x1, y1, x2, y2, min(x1, x2) - CROSS_M, max(x1, x2) + CROSS_M,
                     min(y1, y2) - CROSS_M, max(y1, y2) + CROSS_M))
    crossed = []
    for pl in plazas:
        px, py = _xy(pl["lat"], pl["lon"], lat0)
        best = None
        for (x1, y1, x2, y2, xmin, xmax, ymin, ymax) in segs:
            if px < xmin or px > xmax or py < ymin or py > ymax:
                continue  # segment bbox (expanded by 60 m) cannot contain it
            dist = pt_seg_dist_m(px, py, x1, y1, x2, y2)
            if best is None or dist < best:
                best = dist
        if best is not None and best <= CROSS_M:
            crossed.append({"id": pl["id"], "name": pl.get("name"),
                            "min_dist_m": round(best, 1)})
    return {"route": f"{frm}--{to}", "osrm_km": osrm_km, "duration_min": dur,
            "crossed": crossed}


def _tollmap_worker(job):
    """Multiprocessing worker: one candidate route -> crossed-plaza result."""
    frm, to, cand_plazas = job
    places, by_id = load_places()
    # cand_plazas already carries lat/lon/name; do NOT re-read tolls.json
    # here (a concurrent write by the fare agent could torn-read and crash
    # the worker). Fares are read fresh at BUILD time, never here.
    plazas = cand_plazas
    for attempt in range(3):
        try:
            return crossed_plazas_for_route(frm, to, by_id, plazas)
        except Exception as e:
            if attempt == 2:
                return {"route": f"{frm}--{to}", "error": str(e)[:200], "crossed": None}
            time.sleep([3, 15][attempt])
    return {"route": f"{frm}--{to}", "error": "unreachable", "crossed": None}


def stage_tollmap(workers=6, limit=None):
    import glob
    places, by_id = load_places()
    state = load_state()
    pairs = route_pairs_all()
    log(f"tollmap: {len(pairs)} stored routes; corridor pre-filter "
        f"(plaza within {CORRIDOR_KM} km of straight segment)...")
    plazas = load_tolls()
    cands = corridor_candidates(pairs, by_id, plazas)
    json.dump({"fetched_at": TODAY, "corridor_km": CORRIDOR_KM, "cross_m": CROSS_M,
               "routes_total": len(pairs), "candidates": len(cands),
               "candidate_routes": {rid: [p["id"] for p in ps]
                                    for rid, ps in cands.items()}},
              open(os.path.join(RAW, "routes-v2-tollmap-candidates.json"), "w"))
    log(f"tollmap: {len(cands)} candidate routes of {len(pairs)} "
        f"({len(pairs) - len(cands)} get zero plazas by corridor method)")
    # resume: routes already in saved tollmap batch files
    done = {}
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-tollmap-*.json"))):
        if "candidates" in path:
            continue
        d = json.load(open(path))
        for r in d["results"]:
            done[r["route"]] = r
    todo = [(rid, cands[rid]) for rid in sorted(cands) if rid not in done]
    # Order matters for partial progress: Chichawatni->place routes first
    # (the app quotes from Chichawatni), hub<->hub pairs after.
    todo.sort(key=lambda kv: (0 if kv[0].startswith(CHI_ID + "--") else 1, kv[0]))
    if limit is not None:
        todo = todo[:limit]
    log(f"tollmap: {len(done)} already done, {len(todo)} to fetch "
        f"({workers} workers)")
    jobs = []
    for rid, cand_plazas in todo:
        frm, to = rid.split("--")
        jobs.append((frm, to, cand_plazas))
    batch_no = len([p for p in glob.glob(os.path.join(RAW, "routes-v2-tollmap-*.json"))
                    if "candidates" not in p])
    buf, failures = [], state.get("tollmap_failures", {})
    t0 = time.time()
    with Pool(workers) as pool:
        for i, res in enumerate(pool.imap_unordered(_tollmap_worker, jobs, chunksize=4)):
            buf.append(res)
            if res.get("crossed") is None:
                failures[res["route"]] = res.get("error", "?")[:200]
            if len(buf) >= TOLLMAP_BATCH:
                json.dump({"batch": batch_no, "results": buf},
                          open(os.path.join(RAW, f"routes-v2-tollmap-{batch_no:03d}.json"), "w"))
                batch_no += 1
                buf = []
                state["tollmap_batches"] = sorted(
                    set(state.get("tollmap_batches", [])) | {batch_no - 1})
                state["tollmap_failures"] = failures
                save_state(state)
                el = time.time() - t0
                log(f"tollmap: {i + 1}/{len(jobs)} done "
                    f"({(i + 1) / max(el, 1):.2f}/s, failures {len(failures)})")
    if buf:
        json.dump({"batch": batch_no, "results": buf},
                  open(os.path.join(RAW, f"routes-v2-tollmap-{batch_no:03d}.json"), "w"))
        state["tollmap_batches"] = sorted(set(state.get("tollmap_batches", [])) | {batch_no})
    state["tollmap_failures"] = failures
    save_state(state)
    n_with = sum(1 for r in done.values() if r.get("crossed"))
    log(f"tollmap DONE: {len(done) + len(jobs)} routes processed, "
        f"{len(failures)} failures, {n_with} already-done routes with >=1 plaza")
    return cands

# --------------------------------------------------------------- build stage
def tolls_field(crossed, plaza_by_id):
    """crossed: [{id, name, min_dist_m}] from the precise geometry intersection.
    Fare values are read FRESH from data/tolls.json (plaza_by_id) at build
    time, exactly as the fare-verification agent wrote them - never filled
    from memory or from the reported Rs 100 figure. A plaza with no verified
    fare in tolls.json ships fareOut/fareBack null.
    Totals: 0 when the route crosses no plaza (no toll is due); the sum when
    EVERY crossed plaza has a known fare; null otherwise (a partial sum
    would understate the toll). asOf/source are set ONLY when the totals are
    fully known (a date next to an unverified total would mislead); they are
    the single distinct effective_date/source_url across crossed plazas,
    else null."""
    plazas = []
    for c in (crossed or []):
        rec = plaza_by_id.get(c["id"], {})
        plazas.append({"id": c["id"], "name": c.get("name"),
                       "fareOut": rec.get("fare_out"),
                       "fareBack": rec.get("fare_back"),
                       "verified": bool(rec.get("verified"))})
    if not plazas:
        total_out, total_back = 0, 0
    elif all(p["fareOut"] is not None for p in plazas):
        total_out = sum(p["fareOut"] for p in plazas)
    else:
        total_out = None
    if not plazas:
        total_back = 0
    elif all(p["fareBack"] is not None for p in plazas):
        total_back = sum(p["fareBack"] for p in plazas)
    else:
        total_back = None
    totals_known = bool(plazas) and total_out is not None and total_back is not None
    effs = {plaza_by_id.get(c["id"], {}).get("effective_date")
            for c in (crossed or [])}
    effs.discard(None)
    srcs = {plaza_by_id.get(c["id"], {}).get("source_url")
            for c in (crossed or [])}
    srcs.discard(None)
    return {"plazas": plazas, "totalOut": total_out, "totalBack": total_back,
            "asOf": effs.pop() if (totals_known and len(effs) == 1) else None,
            "source": srcs.pop() if (totals_known and len(srcs) == 1) else None}


def load_tollmap_results():
    """-> ({route_id: crossed_list_or_None}, {route_id: [candidate plaza ids]})"""
    import glob
    results = {}
    for path in sorted(glob.glob(os.path.join(RAW, "routes-v2-tollmap-*.json"))):
        if "candidates" in path:
            continue
        for r in json.load(open(path))["results"]:
            results[r["route"]] = r.get("crossed")  # None = geometry fetch failed
    cand = json.load(open(os.path.join(RAW, "routes-v2-tollmap-candidates.json")))
    return results, cand["candidate_routes"]


def stage_build():
    import glob
    places, by_id = load_places()
    v1 = load_v1_routes()
    v1_by_id = {r["id"]: r for r in v1}
    table, table_nulls = parse_table_results()
    tollmap, cand_routes = load_tollmap_results()
    # Fares: read data/tolls.json FRESH here (the fare agent may have written
    # verified fares after the tollmap stage ran). Never hardcode nulls.
    plaza_by_id = {p["id"]: p for p in load_tolls()}
    n_verified = sum(1 for p in plaza_by_id.values() if p.get("verified"))
    log(f"build: tolls.json has {len(plaza_by_id)} plazas, "
        f"{n_verified} with verified fares")
    state = load_state()
    build_log = {"fetched_at": TODAY, "notes": []}

    # --- crosscheck: apply >10% deviations (except the 9, which keep v1 values)
    cc_path = os.path.join(RAW, "routes-v2-crosscheck.json")
    cc_rows = json.load(open(cc_path))["rows"] if os.path.exists(cc_path) else []
    cc_by_route = {r["route"]: r for r in cc_rows}
    over10_new = []
    for r in cc_rows:
        if r["deviation_pct"] is None or r["deviation_pct"] <= 10:
            continue
        if r["route"] in KNOWN_DEVIATIONS:
            continue  # already flagged in v1, values kept
        over10_new.append(r)

    # --- assemble rows: v1 preserved verbatim (+ tolls), then new chi, then hub
    out = []
    for r in v1:
        row = dict(r)
        crossed = tollmap.get(r["id"], [])  # None (failed fetch) -> [] + logged
        if r["id"] in cand_routes and crossed is None:
            build_log.setdefault("tollmap_failed_routes", []).append(r["id"])
        row["tolls"] = tolls_field(crossed if crossed else [], plaza_by_id)
        # apply fresh crosscheck deviation to v1 rows (only non-9 routes)
        cc = cc_by_route.get(r["id"])
        if cc and cc["deviation_pct"] is not None and cc["deviation_pct"] > 10 \
                and r["id"] not in KNOWN_DEVIATIONS:
            row["verified_km"] = cc["valhalla_km"]
            row["verified_source"] = "Valhalla demo (valhalla1.openstreetmap.de)"
            row["deviation_pct"] = cc["deviation_pct"]
            row["flag"] = (f"VERIFY WITH ODOMETER: second source (Valhalla) says "
                           f"{cc['valhalla_km']} km, {cc['deviation_pct']}% different "
                           f"from OSRM {cc['osrm_km']} km")
        out.append(row)

    v1_ids = set(v1_by_id)
    new_chi, new_hub, missing = [], [], []
    for p in places:
        if p["id"] == CHI_ID:
            continue
        rid = f"{CHI_ID}--{p['id']}"
        if rid in v1_ids:
            continue
        if (CHI_ID, p["id"]) not in table:
            missing.append(rid)
            continue
        km, dur = table[(CHI_ID, p["id"])]
        straight = round(haversine_km(by_id[CHI_ID]["lat"], by_id[CHI_ID]["lon"],
                                      p["lat"], p["lon"]), 2)
        ratio = round(km / straight, 2) if straight else None
        row = {"id": rid, "from": CHI_ID, "to": p["id"], "km": km,
               "duration_min": dur, "straight_km": straight,
               "road_straight_ratio": ratio, "source": "OSRM",
               "engine": "OSRM demo server (router.project-osrm.org)",
               "profile": "driving", "fetched_at": TODAY,
               "verified_km": None, "verified_source": None, "deviation_pct": None}
        if ratio and ratio > 2.0:
            row["flag"] = "ratio>2.0 needs review"
        cc = cc_by_route.get(rid)
        if cc and cc["deviation_pct"] is not None and cc["deviation_pct"] > 10:
            row["verified_km"] = cc["valhalla_km"]
            row["verified_source"] = "Valhalla demo (valhalla1.openstreetmap.de)"
            row["deviation_pct"] = cc["deviation_pct"]
            row["flag"] = (f"VERIFY WITH ODOMETER: second source (Valhalla) says "
                           f"{cc['valhalla_km']} km, {cc['deviation_pct']}% different "
                           f"from OSRM {cc['osrm_km']} km")
        crossed = tollmap.get(rid, [])
        if rid in cand_routes and crossed is None:
            build_log.setdefault("tollmap_failed_routes", []).append(rid)
        row["tolls"] = tolls_field(crossed if crossed else [], plaza_by_id)
        new_chi.append(row)

    hubs = sorted([p["id"] for p in places if p["type"] in ("city", "town", "airport")])
    # Unordered v1 pairs: a v1 row (lahore->islamabad) must NOT gain a reverse
    # alphabetical row (islamabad->lahore). One row per unordered pair.
    v1_unordered = {frozenset((r["from"], r["to"])) for r in v1}
    for i, a in enumerate(hubs):
        for b in hubs[i + 1:]:
            if a == CHI_ID or b == CHI_ID:
                continue
            rid = f"{a}--{b}"
            if frozenset((a, b)) in v1_unordered:
                continue
            if (a, b) not in table:
                missing.append(rid)
                continue
            km, dur = table[(a, b)]
            straight = round(haversine_km(by_id[a]["lat"], by_id[a]["lon"],
                                          by_id[b]["lat"], by_id[b]["lon"]), 2)
            ratio = round(km / straight, 2) if straight else None
            row = {"id": rid, "from": a, "to": b, "km": km,
                   "duration_min": dur, "straight_km": straight,
                   "road_straight_ratio": ratio, "source": "OSRM",
                   "engine": "OSRM demo server (router.project-osrm.org)",
                   "profile": "driving", "fetched_at": TODAY,
                   "verified_km": None, "verified_source": None,
                   "deviation_pct": None}
            if ratio and ratio > 2.0:
                row["flag"] = "ratio>2.0 needs review"
            crossed = tollmap.get(rid, [])
            if rid in cand_routes and crossed is None:
                build_log.setdefault("tollmap_failed_routes", []).append(rid)
            row["tolls"] = tolls_field(crossed if crossed else [], plaza_by_id)
            new_hub.append(row)

    out.extend(new_chi)
    out.extend(new_hub)

    # --- sanity checks
    checks = {}
    ids = [r["id"] for r in out]
    checks["total_rows"] = len(out)
    checks["v1_preserved"] = sum(1 for r in v1 if r["id"] in set(ids))
    checks["new_chi_rows"] = len(new_chi)
    checks["new_hub_rows"] = len(new_hub)
    checks["duplicate_pairs"] = len(ids) - len(set(ids))
    checks["missing_routes"] = missing
    # every v2 place has exactly one Chichawatni->place route
    chi_tos = [r["to"] for r in out if r["from"] == CHI_ID]
    checks["chi_places_covered"] = len(set(chi_tos))
    checks["chi_places_expected"] = len(places) - 1
    checks["chi_tos_missing"] = sorted(
        set(p["id"] for p in places if p["id"] != CHI_ID) - set(chi_tos))
    # km must never be below straight-line (tolerance 0.05 km for snap/rounding)
    checks["km_below_straight"] = [
        r["id"] for r in out
        if r["straight_km"] and r["km"] + 0.05 < r["straight_km"]]
    # km must not be a copy of straight_km (except the preserved v1 0.0 km row)
    checks["km_equals_straight"] = [
        r["id"] for r in out
        if r["km"] == r["straight_km"] and r["id"] not in v1_ids]
    checks["ratio_over_2"] = [r["id"] for r in out
                              if r.get("road_straight_ratio") and
                              r["road_straight_ratio"] > 2.0]
    checks["km_zero"] = [r["id"] for r in out if r["km"] == 0]
    # the 9 known-deviation routes keep their v1 km
    checks["nine_keep_v1_km"] = all(
        next(r for r in out if r["id"] == rid)["km"] == v1_by_id[rid]["km"]
        for rid in KNOWN_DEVIATIONS)
    checks["nine_flags_intact"] = all(
        "VERIFY WITH ODOMETER" in (next(r for r in out if r["id"] == rid).get("flag") or "")
        for rid in KNOWN_DEVIATIONS)
    # tolls field present everywhere; fares all null
    checks["rows_with_tolls_field"] = sum(1 for r in out if "tolls" in r)
    checks["routes_with_ge_1_plaza"] = sum(
        1 for r in out if r["tolls"]["plazas"])
    checks["routes_with_plazas_names"] = sorted(
        {p["name"] for r in out for p in r["tolls"]["plazas"] if p.get("name")})
    checks["plaza_assignments_total"] = sum(
        len(r["tolls"]["plazas"]) for r in out)
    # Fare coverage (from data/tolls.json as read fresh at build time)
    checks["tolls_verified_plazas"] = n_verified
    checks["routes_zero_plazas"] = sum(
        1 for r in out if not r["tolls"]["plazas"])
    checks["routes_all_fares_known"] = sum(
        1 for r in out if r["tolls"]["plazas"]
        and all(p["fareOut"] is not None for p in r["tolls"]["plazas"]))
    checks["routes_partial_fares"] = sum(
        1 for r in out if r["tolls"]["plazas"]
        and any(p["fareOut"] is None for p in r["tolls"]["plazas"])
        and any(p["fareOut"] is not None for p in r["tolls"]["plazas"]))
    checks["routes_no_fare_known"] = sum(
        1 for r in out if r["tolls"]["plazas"]
        and all(p["fareOut"] is None for p in r["tolls"]["plazas"]))
    checks["routes_totalOut_known"] = sum(
        1 for r in out if r["tolls"]["totalOut"] is not None)
    checks["tollmap_failed_routes"] = build_log.get("tollmap_failed_routes", [])
    checks["table_nulls_remaining"] = [list(x) for x in table_nulls]
    checks["over10_new_crosscheck"] = [r["route"] for r in over10_new]
    build_log["checks"] = checks

    seed_path = os.path.join(PUBLIC, "routes-seed.json")
    json.dump(out, open(seed_path, "w"), indent=2, ensure_ascii=False)
    json.dump(build_log, open(os.path.join(RAW, "routes-v2-build-log.json"), "w"),
              indent=2, ensure_ascii=False)
    write_crosscheck_md(cc_rows)
    log(f"build DONE: {len(out)} rows "
        f"(v1 {checks['v1_preserved']} + new chi {len(new_chi)} + "
        f"new hub {len(new_hub)}), missing {len(missing)}, "
        f"routes with >=1 plaza {checks['routes_with_ge_1_plaza']}, "
        f"plaza assignments {checks['plaza_assignments_total']}")
    for k in ("duplicate_pairs", "km_below_straight", "km_equals_straight",
              "nine_keep_v1_km", "nine_flags_intact"):
        log(f"  check {k}: {checks[k]}")
    log(f"  fares: verified plazas {checks['tolls_verified_plazas']}, "
        f"routes all-fares-known {checks['routes_all_fares_known']}, "
        f"partial {checks['routes_partial_fares']}, "
        f"no-fare-known {checks['routes_no_fare_known']}, "
        f"zero-plaza {checks['routes_zero_plazas']}")
    if checks["chi_tos_missing"]:
        log(f"  WARNING chi places missing routes: {checks['chi_tos_missing'][:20]}")
    state["build_done"] = True
    save_state(state)
    return build_log


def write_crosscheck_md(cc_rows):
    over = [r for r in cc_rows if r["deviation_pct"] is not None
            and r["deviation_pct"] > 10]
    lines = [
        "# Valhalla cross-check — REVISION v2",
        "",
        f"Fetched {TODAY}. OSRM = OSRM demo server (router.project-osrm.org, "
        "table service, same values as in `routes-seed.json`). Valhalla = "
        "Valhalla demo (valhalla1.openstreetmap.de, costing auto). "
        "Deviation % = |Valhalla − OSRM| / OSRM × 100. OSRM stays the seed "
        "source; every route deviating >10% is flagged VERIFY WITH ODOMETER.",
        "",
        "## The 9 known-deviation routes (v1, re-checked)",
        "",
        "These 9 keep their stored v1 OSRM km and their v1 verified values in "
        "`routes-seed.json` — a re-fetch never silently replaces them. The table "
        "below shows the FRESH Valhalla re-check from this run next to the stored "
        "v1 Valhalla value, so any drift is visible.",
        "",
        "| Route | OSRM km (seed) | Valhalla km (v1 stored) | Valhalla km (fresh v2) | Deviation % (fresh) |",
        "|---|---|---|---|---|",
    ]
    v1 = {r["id"]: r for r in load_v1_routes()}
    for r in cc_rows:
        if r["route"] not in KNOWN_DEVIATIONS:
            continue
        stored = v1.get(r["route"], {})
        lines.append(f"| {r['route']} | {r['osrm_km']} | "
                     f"{stored.get('verified_km')} | {r['valhalla_km']} | "
                     f"{r['deviation_pct']} |")
    lines += [
        "",
        "## Full cross-check table (48 routes)",
        "",
        "| Route | Type | OSRM km | Valhalla km | Deviation % | >10% |",
        "|---|---|---|---|---|---|",
    ]
    for r in cc_rows:
        dev = r["deviation_pct"]
        lines.append(f"| {r['route']} | {r['type']} | {r['osrm_km']} | "
                     f"{r['valhalla_km']} | {dev} | "
                     f"{'YES' if dev is not None and dev > 10 else ''} |")
    failed = [r for r in cc_rows if r.get("valhalla_km") is None]
    lines += [
        "",
        "## Summary",
        "",
        f"- Routes cross-checked: {len(cc_rows)} "
        f"(9 known deviations + 15 cities/hubs + {len(cc_rows) - 24} villages)",
        f"- Deviating >10%: {len(over)} — "
        + (", ".join(r["route"] for r in over) if over else "none"),
        f"- Valhalla failures (no second-source value): {len(failed)} — "
        + (", ".join(r["route"] for r in failed) if failed else "none"),
        "- Routes flagged VERIFY WITH ODOMETER in `routes-seed.json`: the 9 "
        "known ones (v1 values kept) plus every new >10% route above.",
        "- Raw responses: `data/raw/routes-v2-crosscheck.json`.",
        "",
    ]
    open(os.path.join(DATA, "CROSSCHECK-v2.md"), "w").write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["table", "crosscheck", "tollmap", "build", "all"])
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    if a.stage in ("table", "all"):
        stage_table(limit=a.limit)
    if a.stage in ("crosscheck", "all"):
        stage_crosscheck()
    if a.stage in ("tollmap", "all"):
        stage_tollmap(workers=a.workers, limit=a.limit)
    if a.stage in ("build", "all"):
        stage_build()
    log("ALL DONE")


if __name__ == "__main__":
    main()

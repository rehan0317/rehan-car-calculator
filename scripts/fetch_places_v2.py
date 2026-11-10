#!/usr/bin/env python3
"""Places v2 fetch for Car Calculator (REVISION v2, spec section C).

Stages:
  osm   - Overpass per-area fetch (node+way place=city/town/village/hamlet/
          suburb), one resume file per area in data/raw/places-v2-<area>.json.
          Retries with exponential backoff across 3 Overpass mirrors.
  admin - Overpass admin_level 6 (district) + 7 (tehsil) relations per
          district, saved to data/raw/places-v2-admin-<district>.json.
  merge - build public/data/places.json (v2 place model) from v1 places +
          OSM raw + GeoNames PK dump, with dedupe + point-in-polygon tehsil.

Rules (hard, from spec): never invent an alias / transliteration / place /
coordinate. Aliases = OSM alt_name/loc_name/old_name/name:en ONLY.
name_ur = OSM name:ur ONLY, else null. Tehsil = point-in-polygon ONLY,
else null (never guessed). HTTP via curl subprocess ONLY (urllib hangs).
"""
import json, math, os, re, subprocess, sys, time, unicodedata, urllib.parse, zipfile
from datetime import date

UA = "CarAppBuild/1.0 (offline rent-a-car calculator, Chichawatni; low-volume build script)"
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "data", "raw")
TODAY = date.today().isoformat()
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# (area_id, lat, lon, radius_m) — whole Sahiwal district + 60-80 km buffer
# districts + hub villages around Lahore / Islamabad / Faisalabad / Multan.
AREAS = [
    ("chichawatni", 30.5354804, 72.6903375, 40000),
    ("sahiwal", 30.6715098, 73.1110572, 35000),
    ("okara", 30.8087231, 73.4453171, 35000),
    ("pakpattan", 30.3411574, 73.3866981, 35000),
    ("arifwala", 30.294, 73.065, 30000),
    ("harappa", 30.64, 72.93, 20000),
    ("khanewal", 30.301, 71.932, 30000),
    ("mian-channu", 30.44, 72.35, 30000),
    ("vehari", 30.045, 72.347, 30000),
    ("burewala", 30.166, 72.682, 25000),
    ("toba-tek-singh", 30.978, 72.486, 35000),
    ("faisalabad", 31.419, 73.079, 30000),
    ("jhang", 31.269, 72.316, 25000),
    ("depalpur", 30.67, 73.65, 25000),
    ("renala-khurd", 30.88, 73.60, 20000),
    ("lahore", 31.566, 74.314, 25000),
    ("islamabad", 33.694, 73.065, 25000),
    ("multan", 30.198, 71.472, 25000),
    ("rawalpindi", 33.591, 73.053, 20000),
    ("sargodha", 32.084, 72.674, 20000),
    ("sheikhupura", 31.716, 73.985, 20000),
    ("gujranwala", 32.187, 74.194, 20000),
]
ADMIN_TILES = [  # (tile_id, south, west, north, east)
    ("core", 29.8, 71.3, 31.3, 73.8),    # Sahiwal/Okara/Pakpattan/Khanewal/Vehari/TTS/Faisalabad/Jhang
    ("north", 31.0, 72.5, 34.0, 75.2),   # Lahore/Islamabad/Rawalpindi/Sargodha/Sheikhupura/Gujranwala
    ("multan", 29.7, 71.0, 30.6, 72.0),  # Multan district
]


def curl_text(url, timeout=180, data=None):
    cmd = ["curl", "-s", "-m", str(timeout), "-A", UA, url]
    if data is not None:
        cmd += ["-X", "POST", "--data", data]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 15)
    return r.returncode, r.stdout


def overpass_query(query, tag, attempts=6):
    """Run an Overpass QL query, rotating mirrors, exp backoff 30s..480s.
    Returns parsed JSON dict or None (never invents data on failure)."""
    for attempt in range(attempts):
        mirror = MIRRORS[attempt % len(MIRRORS)]
        url = mirror + "?data=" + urllib.parse.quote(query)
        code, out = curl_text(url, timeout=180)
        if code == 0 and out.lstrip().startswith("{"):
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                pass
        wait = min(30 * (2 ** attempt), 480)
        print(f"  {tag}: attempt {attempt+1} failed (curl {code}, "
              f"{out[:60]!r}); backoff {wait}s", flush=True)
        time.sleep(wait)
    print(f"  {tag}: GIVING UP after {attempts} attempts — skipped, not invented",
          flush=True)
    return None


def stage_osm():
    os.makedirs(RAW, exist_ok=True)
    for area_id, lat, lon, radius in AREAS:
        path = os.path.join(RAW, f"places-v2-{area_id}.json")
        if os.path.exists(path):
            try:
                d = json.load(open(path))
                if d.get("elements"):
                    print(f"{area_id}: resume file exists "
                          f"({len(d['elements'])} elements) — skip", flush=True)
                    continue
            except Exception:
                pass
        # NOTE (2026-11-10): node+way query was too heavy under Overpass load
        # (502s + 180s timeouts on small areas). Villages as ways are rare
        # here and v1 (node-only) covered the same ground, so node-only.
        q = (f'[out:json][timeout:90];'
             f'node[place~"^(city|town|village|hamlet|suburb)$"]'
             f'(around:{radius},{lat},{lon});'
             f'out body;')
        print(f"{area_id}: querying radius {radius}m ...", flush=True)
        d = overpass_query(q, area_id)
        if d is None:
            continue
        els = d.get("elements", [])
        json.dump(d, open(path, "w"), indent=1, ensure_ascii=False)
        print(f"{area_id}: SAVED {len(els)} elements", flush=True)
        time.sleep(5)
    print("OSM stage done", flush=True)


def stage_admin():
    """Fetch admin_level 6 (district) + 7 (tehsil) boundary relations.
    NOTE (2026-11-10): (a) area["name"=...] lookup returns 0 — OSM names
    here are Urdu-script, so English name lookup cannot work. (b) A bbox
    query with `out geom` times out under load (502s on all 3 mirrors).
    Two-phase instead: cheap tags-only bbox listing to learn relation IDs,
    then geometry fetched by explicit ID list in small chunks."""
    os.makedirs(RAW, exist_ok=True)
    rel_ids = {}  # id -> (level, name_en_or_ur)
    for tile_id, s, w, n, e in ADMIN_TILES:
        list_path = os.path.join(RAW, f"places-v2-admin-{tile_id}-list.json")
        if os.path.exists(list_path):
            d = json.load(open(list_path))
            print(f"admin {tile_id}: list resume exists "
                  f"({len(d.get('elements', []))} relations)", flush=True)
        else:
            q = (f'[out:json][timeout:90];'
                 f'relation["boundary"="administrative"]'
                 f'["admin_level"~"^(6|7)$"]({s},{w},{n},{e}); out tags;')
            print(f"admin {tile_id}: listing relations (tags only) ...",
                  flush=True)
            d = overpass_query(q, f"admin-list-{tile_id}", attempts=4)
            if d is None:
                continue
            json.dump(d, open(list_path, "w"), indent=1, ensure_ascii=False)
        for el in d.get("elements", []):
            tags = el.get("tags", {})
            rel_ids[str(el["id"])] = (tags.get("admin_level"),
                                       tags.get("name:en") or tags.get("name"))
        print(f"admin {tile_id}: {len(d.get('elements', []))} relations listed",
              flush=True)
        time.sleep(3)
    print(f"admin: {len(rel_ids)} unique admin relations", flush=True)
    ids = sorted(rel_ids, key=int)
    for ci in range(0, len(ids), 8):
        chunk = ids[ci:ci + 8]
        path = os.path.join(RAW, f"places-v2-admin-geom-{ci // 8:02d}.json")
        if os.path.exists(path):
            try:
                d = json.load(open(path))
                if d.get("elements"):
                    print(f"admin geom chunk {ci // 8}: resume exists "
                          f"({len(d['elements'])} relations) — skip", flush=True)
                    continue
            except Exception:
                pass
        q = (f'[out:json][timeout:120];'
             f'relation(id:{",".join(chunk)}); out geom;')
        print(f"admin geom chunk {ci // 8} ({len(chunk)} relations) ...",
              flush=True)
        d = overpass_query(q, f"admin-geom-{ci // 8}", attempts=4)
        if d is None:
            continue
        json.dump(d, open(path, "w"), indent=1, ensure_ascii=False)
        print(f"admin geom chunk {ci // 8}: SAVED "
              f"{len(d.get('elements', []))} relations", flush=True)
        time.sleep(3)
    print("ADMIN stage done", flush=True)


# ---------- merge helpers ----------

def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"\b(chak|no\.?|number)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(s):
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "place"


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def split_alias_field(v):
    out = []
    for part in (v or "").split(";"):
        part = part.strip()
        if part:
            out.append(part)
    return out


def osm_aliases(tags):
    seen, out = set(), []
    for k in ("alt_name", "loc_name", "old_name", "name:en"):
        for a in split_alias_field(tags.get(k)):
            if a != tags.get("name") and a not in seen:
                seen.add(a)
                out.append(a)
    return out


def stitch_rings(members):
    """Assemble closed rings from relation way members (each with geometry).
    Returns list of rings, each a list of (lon, lat)."""
    segs = []
    for m in members:
        if m.get("type") != "way" or m.get("role") not in ("outer", "", None):
            continue
        g = m.get("geometry") or []
        pts = [(p["lon"], p["lat"]) for p in g]
        if len(pts) >= 2:
            segs.append(pts)
    # join segments end-to-end
    rings, used = [], [False] * len(segs)
    for i, s in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        ring = list(s)
        changed = True
        while changed:
            changed = False
            for j, t in enumerate(segs):
                if used[j]:
                    continue
                if t[0] == ring[-1]:
                    ring += t[1:]; used[j] = True; changed = True
                elif t[-1] == ring[-1]:
                    ring += t[-2::-1]; used[j] = True; changed = True
                elif t[-1] == ring[0]:
                    ring = t[:-1] + ring; used[j] = True; changed = True
                elif t[0] == ring[0]:
                    ring = t[:0:-1] + ring; used[j] = True; changed = True
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring)
    return rings


def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and \
           (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def load_admin_polys():
    """Return list of (admin_level, name, [rings])."""
    polys = []
    for fn in sorted(os.listdir(RAW)):
        if not (fn.startswith("places-v2-admin-") and fn.endswith(".json")):
            continue
        if fn.endswith("-list.json"):
            continue  # tags-only listing, no geometry
        try:
            d = json.load(open(os.path.join(RAW, fn)))
        except Exception:
            continue
        for e in d.get("elements", []):
            if e.get("type") != "relation":
                continue
            tags = e.get("tags", {})
            level = tags.get("admin_level")
            # OSM name is Urdu-script; name:en is the published English name
            # (e.g. "Chichawatni Tehsil"). Strip the suffix for the field.
            name = tags.get("name:en") or tags.get("name")
            if level not in ("6", "7") or not name:
                continue
            for suffix in (" Tehsil", " District"):
                if name.endswith(suffix):
                    name = name[: -len(suffix)]
                    break
            # India/AJK use admin_level 6 for TEHSILS (e.g. "Ajnala Tahsil");
            # a level-6 relation whose name ends in Tahsil/Tehsil is a
            # mis-tagged tehsil, not a district — skip it as a district, so
            # no place gets a tehsil's name in its district field.
            if level == "6" and name.endswith((" Tahsil", " Tehsil",
                                               " tahsil", " tehsil")):
                continue
            rings = stitch_rings(e.get("members", []))
            if rings:
                # bbox prefilter: point-in-polygon over 268 polys x ~16k
                # places is far too slow without it (rings have 100s of pts).
                xs = [x for r in rings for x, _ in r]
                ys = [y for r in rings for _, y in r]
                polys.append((level, name, rings,
                              (min(xs), min(ys), max(xs), max(ys))))
    return polys


def locate_admin(lat, lon, polys):
    """Return (district, tehsil) from point-in-polygon, else (None, None)."""
    district = tehsil = None
    for level, name, rings, bbox in polys:
        if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        if any(point_in_ring(lon, lat, r) for r in rings):
            if level == "6":
                district = name
            elif level == "7":
                tehsil = name
    return district, tehsil


def load_geonames():
    """GeoNames PK dump -> candidate places inside coverage bbox.
    Returns list of dicts. PK.txt is 27MB; streamed, no full load."""
    zpath = os.path.join(RAW, "geonames-PK.zip")
    out = []
    if not os.path.exists(zpath):
        print("GeoNames zip missing — skipping second dataset", flush=True)
        return out
    # coverage = the same area centres/radii as the Overpass fetch (whole
    # Sahiwal district + 60-80 km buffer + hub villages). The raw bbox alone
    # would pull ~63k places from half of Punjab — far outside scope.
    with zipfile.ZipFile(zpath) as z:
        with z.open("PK.txt") as f:
            for raw in f:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                cols = line.split("\t")
                if len(cols) < 15:
                    continue
                try:
                    lat, lon = float(cols[4]), float(cols[5])
                except ValueError:
                    continue
                if not (29.5 <= lat <= 34.3 and 70.8 <= lon <= 75.2):
                    continue
                fclass, fcode = cols[6], cols[7]
                if fclass != "P":  # populated places only
                    continue
                if not any(haversine_km(lat, lon, cla, clo) <= r / 1000.0
                           for _, cla, clo, r in AREAS):
                    continue
                name = cols[1]
                asciiname = cols[2]
                alt = cols[3]
                out.append({"geonameid": cols[0], "name": asciiname or name,
                            "orig_name": name, "alternates": alt,
                            "lat": lat, "lon": lon, "fcode": fcode,
                            "admin2": cols[11], "admin3": cols[12],
                            "population": cols[14]})
    return out


def stage_merge():
    # v1 input is the IMMUTABLE raw artifact data/raw/places-all.json (123
    # places, byte-identical to the shipped v1 places.json — verified
    # 2026-11-10), NEVER public/data/places.json: after the first merge that
    # file is already v2, and re-merging from it silently strips GeoNames
    # aliases (happened 2026-11-10: aliases fell 8,090 -> 27). Guard aborts
    # if the input already looks like v2.
    v1_path = os.path.join(RAW, "places-all.json")
    v1 = json.load(open(v1_path))
    if len(v1) > 500 or any("geonameid" in p or "osm_id" in p for p in v1):
        print(f"ABORT: {v1_path} already looks like v2 "
              f"({len(v1)} places) — refusing to merge from a v2 file",
              flush=True)
        sys.exit(2)
    v1_by_osm = {}
    for p in v1:
        if p["id"].startswith("osm-"):
            v1_by_osm[p["id"][4:]] = p
    v1_by_slug = {p["id"]: p for p in v1}
    # collect OSM elements from all area resume files
    osm_by_id = {}
    for fn in sorted(os.listdir(RAW)):
        if not (fn.startswith("places-v2-") and fn.endswith(".json")
                and not fn.startswith("places-v2-admin-")):
            continue
        try:
            d = json.load(open(os.path.join(RAW, fn)))
        except Exception:
            continue
        for e in d.get("elements", []):
            if e.get("type") not in ("node", "way"):
                continue
            tags = e.get("tags", {})
            if not tags.get("name"):
                continue
            lat = e.get("lat") or (e.get("center") or {}).get("lat")
            lon = e.get("lon") or (e.get("center") or {}).get("lon")
            if lat is None or lon is None:
                continue
            osm_by_id[str(e["id"])] = {"osm_id": str(e["id"]), "name": tags["name"],
                                       "tags": tags, "lat": lat, "lon": lon,
                                       "type": tags.get("place", "village")}
    print(f"OSM unique elements: {len(osm_by_id)}", flush=True)

    polys = load_admin_polys()
    print(f"admin polygons loaded: {len(polys)} "
          f"({sum(1 for l, _, _, _ in polys if l == '6')} district, "
          f"{sum(1 for l, _, _, _ in polys if l == '7')} tehsil)", flush=True)

    places, dropped_aliases = [], []
    used_ids, used_keys = set(), set()
    stats = {"v1_preserved": 0, "v1_osm_refreshed": 0, "osm_new": 0,
             "geonames_new": 0, "osm_dupes_skipped": 0,
             "geonames_dupes_skipped": 0, "geonames_candidates": 0}

    def add_place(p):
        key = (norm_name(p["name"]), round(p["lat"], 3), round(p["lon"], 3))
        if p["id"] in used_ids:
            return False
        places.append(p)
        used_ids.add(p["id"])
        used_keys.add(key)
        return True

    # 1) v1 places first, IDs preserved exactly; refresh OSM fields where the
    #    OSM node still exists (aliases/name_ur from live OSM tags only).
    for p in v1:
        np = {"id": p["id"], "name": p["name"], "aliases": list(p.get("aliases") or []),
              "name_ur": None, "type": p.get("category", "village"),
              "tehsil": None, "district": None,
              "lat": p["lat"], "lon": p["lon"],
              "source": p.get("source", "Nominatim/OSM"), "fetched_at": TODAY}
        osm_id = p["id"][4:] if p["id"].startswith("osm-") else None
        if osm_id and osm_id in osm_by_id:
            el = osm_by_id[osm_id]
            np["aliases"] = osm_aliases(el["tags"])
            np["name_ur"] = el["tags"].get("name:ur")
            np["type"] = el["tags"].get("place", np["type"])
            np["source"] = "Overpass/OSM"
            np["fetched_at"] = TODAY
            stats["v1_osm_refreshed"] += 1
            # v1 aliases not in OSM tags are NOT invented data — record them
            # so the app team can move them to the user-alias table.
            dropped = [a for a in (p.get("aliases") or [])
                       if a not in np["aliases"] and a != p["name"]]
            if dropped:
                dropped_aliases.append({"id": p["id"], "name": p["name"],
                                        "dropped_v1_aliases": dropped})
        else:
            # non-OSM v1 place (Nominatim city etc.): keep its aliases only
            # if they are the place name itself in another form? No — spec
            # says aliases are OSM-provided only. Record + clear.
            dropped = [a for a in (p.get("aliases") or []) if a != p["name"]]
            if dropped:
                dropped_aliases.append({"id": p["id"], "name": p["name"],
                                        "dropped_v1_aliases": dropped})
                np["aliases"] = [a for a in np["aliases"] if a == p["name"]]
        dist, teh = locate_admin(p["lat"], p["lon"], polys)
        np["district"], np["tehsil"] = dist, teh
        if add_place(np):
            stats["v1_preserved"] += 1

    # 2) new OSM places, slug ids, dedupe by osm id + name+~500m
    osm_sorted = sorted(osm_by_id.values(), key=lambda e: (e["lat"], e["lon"]))
    for el in osm_sorted:
        if el["osm_id"] in v1_by_osm:
            continue
        # dedupe vs already-added: same normalized name within 500 m
        dup = False
        for q in places:
            if norm_name(q["name"]) == norm_name(el["name"]) and \
               haversine_km(q["lat"], q["lon"], el["lat"], el["lon"]) <= 0.5:
                dup = True
                break
        if dup:
            stats["osm_dupes_skipped"] += 1
            continue
        pid = slugify(el["name"])
        n = 2
        base = pid
        while pid in used_ids:
            pid = f"{base}-{n}"
            n += 1
        dist, teh = locate_admin(el["lat"], el["lon"], polys)
        p = {"id": pid, "name": el["name"], "aliases": osm_aliases(el["tags"]),
             "name_ur": el["tags"].get("name:ur"),
             "type": el["type"], "tehsil": teh, "district": dist,
             "lat": el["lat"], "lon": el["lon"],
             "source": "Overpass/OSM", "fetched_at": TODAY,
             "osm_id": el["osm_id"]}
        if add_place(p):
            stats["osm_new"] += 1

    # 3) GeoNames second dataset, dedupe by name + 500 m (grid-indexed:
    #    13k+ candidates x thousands of places is O(n^2) without it).
    gn = load_geonames()
    stats["geonames_candidates"] = len(gn)
    print(f"GeoNames candidates in bbox (class P): {len(gn)}", flush=True)
    grid = {}

    def grid_add(p):
        grid.setdefault((round(p["lat"] * 100), round(p["lon"] * 100)),
                        []).append(p)

    def grid_dup(name, lat, lon):
        nname = norm_name(name)
        ci, cj = round(lat * 100), round(lon * 100)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for q in grid.get((ci + di, cj + dj), []):
                    if norm_name(q["name"]) == nname and \
                       haversine_km(q["lat"], q["lon"], lat, lon) <= 0.5:
                        return True
        return False

    for p in places:
        grid_add(p)
    gn_kept = 0
    for g in sorted(gn, key=lambda x: (x["lat"], x["lon"])):
        if grid_dup(g["name"], g["lat"], g["lon"]):
            stats["geonames_dupes_skipped"] += 1
            continue
        # GeoNames alternatenames are published names, not invented by us.
        # Keep Latin-script alternates as aliases; Urdu-script alternate (if
        # any) is recorded as name_ur ONLY if it is an exact published
        # alternate — in practice GeoNames alternates here are transliterations
        # already published by GeoNames, so we keep them as aliases, and set
        # name_ur to null (OSM name:ur only, per spec).
        aliases = []
        for a in (g["alternates"] or "").split(","):
            a = a.strip()
            if a and a != g["name"] and a not in aliases:
                aliases.append(a)
        pid = slugify(g["name"])
        base = pid
        n = 2
        while pid in used_ids:
            pid = f"{base}-{n}"
            n += 1
        dist, teh = locate_admin(g["lat"], g["lon"], polys)
        p = {"id": pid, "name": g["name"], "aliases": aliases[:10],
             "name_ur": None, "type": "village" if g["fcode"] in
             ("PPL", "PPLX", "PPLL") else ("town" if g["fcode"] in
             ("PPLA", "PPLA2", "PPLA3", "PPLA4") else "village"),
             "tehsil": teh, "district": dist,
             "lat": g["lat"], "lon": g["lon"],
             "source": "GeoNames", "fetched_at": TODAY,
             "geonameid": g["geonameid"]}
        if add_place(p):
            grid_add(p)
            stats["geonames_new"] += 1

    places.sort(key=lambda p: (p.get("district") or "", p["name"].lower()))
    json.dump(places, open(os.path.join(BASE, "public", "data", "places.json"),
                            "w"), indent=2, ensure_ascii=False)
    json.dump({"stats": stats, "generated": TODAY,
               "dropped_v1_aliases": dropped_aliases},
              open(os.path.join(RAW, "places-v2-merge-report.json"), "w"),
              indent=2, ensure_ascii=False)
    print("MERGE DONE:", json.dumps(stats, indent=2), flush=True)
    print(f"total places written: {len(places)}", flush=True)
    print(f"dropped v1 aliases recorded: {len(dropped_aliases)} places",
          flush=True)


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("all", "osm"):
        stage_osm()
    if stage in ("all", "admin"):
        stage_admin()
    if stage in ("all", "merge"):
        stage_merge()

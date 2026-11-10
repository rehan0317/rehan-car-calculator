# Route coverage report — generated 2026-11-09

Sources: Nominatim (place coordinates), Overpass API (villages/hamlets/suburbs),
OSRM demo server (road km, primary), Valhalla demo server (second source).
Scripts: `scripts/fetch_routes.py`, `scripts/fetch_villages_trimmed.py`.
Raw responses: `data/raw/`. Shipped seed: `public/data/places.json`,
`public/data/routes-seed.json`. Fetched 2026-11-09.

**We do NOT claim "all villages included".** This is what is actually in the
seed; anything missing shows "Not found — add as custom place" in the app,
then manual km entry.

## Counts

| | Count |
|---|---|
| Places total | 123 |
| — city | 21 |
| — town | 7 |
| — village | 89 |
| — hamlet | 2 |
| — suburb | 3 |
| — airport | 1 (Lahore Airport) |
| Routes total | 202 |
| — Chichawatni → every place | 122 |
| — hub ↔ hub (cities) | 28 |
| — hub → its nearby villages | 52 |
| Routes verified vs Valhalla | 32 |
| Routes with Valhalla deviation > 10% | 9 (listed below) |
| Routes with road/straight ratio > 2.0 | 2 (listed below) |

Places by area (Overpass `near_hub`): Chichawatni 49, Okara 25, Pakpattan 15,
Sahiwal 12. The 23 Nominatim cities/towns/airport have no `near_hub`.

## Valhalla deviations > 10% (second source disagrees — VERIFY WITH ODOMETER)

OSRM is kept as the seed source: its road/straight ratios are sane (1.04–1.35
on city routes) and its durations are sane (e.g. Sargodha 202 km in 201 min).
Valhalla's demo server routes some destinations via long detours (its
Sargodha/Jhang figures imply ~2x the straight-line distance). The app shows
"VERIFY WITH ODOMETER" on these routes in Saved Routes.

| Route | OSRM km | Valhalla km | Deviation |
|---|---|---|---|
| Chichawatni → Lahore Airport | 218.51 | 263.19 | 20.45% |
| Chichawatni → Islamabad | 454.70 | 528.17 | 16.16% |
| Chichawatni → Multan | 132.48 | 153.57 | 15.92% |
| Chichawatni → Rawalpindi | 443.86 | 527.10 | 18.75% |
| Chichawatni → Sargodha | 202.72 | 339.28 | 67.36% |
| Chichawatni → Arifwala | 57.62 | 66.61 | 15.60% |
| Chichawatni → Jhang | 92.81 | 159.01 | 71.33% |
| Chichawatni → Sheikhupura | 230.21 | 259.59 | 12.76% |
| Chichawatni → Chak No 110/12.L | 7.10 | 9.30 | 30.99% |

14 of the 22 verified city routes agree within 3%. The 8 city deviations above
are the full list; no other city route deviates by more than 10%.

## Road/straight ratio > 2.0 (haversine sanity check)

| Route | Road km | Straight km | Ratio | Note |
|---|---|---|---|---|
| Chichawatni → Chak No 40/12.L | 6.67 | 3.05 | 2.19 | Short hop across town roads; app warns before quoting |
| Chichawatni → Chak No 109/12.L | 7.54 | 3.53 | 2.14 | Same — app warns before quoting |

A duplicate Chichawatni node (OSM id 251321140, Urdu name, 0.43 km from the
origin) was removed from the seed — it was the same town, not a destination.

## What is NOT covered (routing failures / gaps)

- **Lahore + Islamabad villages: NOT included.** The full village script
  (`scripts/fetch_villages.py`) fetched 367 Lahore elements, but the run was
  killed by a sandbox service restart before saving; Islamabad's Overpass
  query failed 4 times with 502 "server at capacity" and was skipped.
  The trimmed script covers Chichawatni + Sahiwal + Okara + Pakpattan only.
  Re-run `scripts/fetch_villages.py` when Overpass is quiet to add them.
- **Faisalabad / Multan / other hub villages: NOT included** (same reason —
  trimmed scope). Their cities ARE included with road distances.
- **Overpass flakiness:** the main server returned 502 "at capacity" for
  about an hour during the build, then recovered. All Overpass calls in the
  scripts retry with exponential backoff and give up cleanly (skip, never invent).
- **No routing failures on the shipped routes:** every OSRM call for the 202
  routes returned `code: Ok`. Zero routes failed to route.
- **Chak coverage is partial:** 89 villages within 25 km of Chichawatni and
  12 km of Sahiwal/Okara/Pakpattan. Chaks farther out, or with no OSM node,
  are missing — use "add as custom place" + manual km.

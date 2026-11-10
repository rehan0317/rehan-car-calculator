# Car Calculator — Chichawatni (offline-first rent-a-car calculator)

English UI. Android phone, small screen, slow or no internet.
Core job: customer asks "Chichawatni to X, how much?" — owner gets a quote
in under 10 seconds and 4 taps or fewer.

**Thinking:** Gemini 4 Argon via OpenRouter (curl workaround — `think.py`'s
urllib hangs on this VM; see `~/workspace/thinking-model/curl_think.py`) —
log `~/workspace/thinking-model/calls/20261109-230050-car-app-plan.json`
(response cut at token limit 1200, items 1–9 of the hostile list received;
items 10–15 completed by the QA pass in `AUDIT.md`).

## 0. Capability check (run 2026-11-09, sandbox)

| Check | Result |
|---|---|
| Internet (curl) | YES — example.com, npm registry, OSRM, Overpass, Nominatim, Valhalla all reachable |
| Node / npm | Node v24.22.1, npm 10.9.4 — YES |
| JDK / Android SDK / Gradle | **NO — `java`, `gradle`, `sdkmanager` not installed, no Android SDK anywhere. APK build was NOT possible here.** See "Platform decision" |
| Headless Chromium / Playwright | YES — Playwright browsers cached (chromium-1243/1254); `npx playwright test` runs |
| Routing / geocoding | OSRM demo server YES (route works), Valhalla demo YES (second source), Nominatim YES (1 req/s, UA set), Overpass YES but flaky — returned 502 "at capacity" for ~1 hour, then 200 again |

## Platform decision (5 lines, as required)

1. Preferred APK (Capacitor, signed) was **not buildable in this sandbox**:
   no JDK, no Android SDK, no emulator; installing the full toolchain here
   was judged out of scope for one session and the emulator test would still
   be impossible.
2. Fallback shipped: **installable PWA** — manifest, service worker precaching
   the full app shell + seed data (12 entries, 188 KiB), maskable icons.
3. Install needs internet **once** (first load caches everything); after that
   it opens offline, no login, no CAPTCHA, no splash over 1s.
4. Data lives in IndexedDB for this origin — clearing browser data or
   uninstalling the PWA can delete records (the app warns about this and
   pushes a 7-day backup banner).
5. Hosting: **not yet deployed** — no GitHub/Cloudflare/Netlify account was
   connected in this sandbox, so there is no live URL yet. `dist/` is built
   and ready to deploy free (GitHub Pages / Cloudflare Pages / Netlify,
   $0, static, permanent while the account exists). Deploy steps in
   `docs/INSTALL-ANDROID.md`. This is marked UNVERIFIED until a real URL
   is fetched with a clean client.

## Stack

TypeScript + Vite + Preact + Dexie (IndexedDB, schema v3, tested migration)
+ Vitest + Playwright + vite-plugin-pwa. No runtime CDN, no Google Fonts,
no analytics — everything is bundled locally. All money maths lives in ONE
pure module, `src/lib/calc.ts` (no UI imports). Money = whole PKR, litres to
2 decimals, round half up only at the final PKR amount.

## Calculation spec (implemented + tested)

- `total_km = one_way_km x (return ? 2 : 1)` — auto-filled, editable, override flagged.
- `fuel_litres = total_km / avg_kmpl` (exact float); `fuel_cost = round(fuel_litres x petrol_price)`.
  Rounding litres first would give Rs 4,501 instead of Rs 4,500 on the test vector — tested.
- `customer_rent = rate_per_km x total_km` (or flat override).
- `other_expenses = toll + other`. Toll toggle "Bill toll to customer": adds toll
  to the quote total and removes it from expenses.
- `estimated_saving = customer_rent - fuel_cost - other_expenses`.
- Quote screen NEVER shows driver % or settlement (E2E-tested).
- Settlement (separate screen): `net = income - (trip fuel + trip toll + allowable car expenses)`;
  `driver_share = round(net x pct)`; `owner_share = net - driver_share` (sums exactly).
  Percent is on NET, never gross. Negative net: warning, driver 0 by default.
  Filters: week (Mon–Sun), month, custom range, driver, car. Save = immutable
  snapshot; reopening shows the snapshot and flags "Source data changed since
  saved — Recalculate?" when source trips changed. Overlap warning for the
  same driver/car. Double-count guard: `findDoubleCountedIds` + UI block.

Test vectors (in `src/lib/calc.test.ts`, all passing):
- Quote: 100 km one-way, return, 12 km/L, Rs 270/L, Rs 60/km, toll Rs 500 →
  200 km, fuel Rs 4,500, rent Rs 12,000, saving Rs 7,000.
- Settlement: income 50,000, fuel 12,000, other 3,000 → net 35,000;
  30% → driver 10,500, owner 24,500.

## Routes & geo data

- `scripts/fetch_routes.py` — Nominatim coords (1 req/s, UA per policy) +
  OSRM road distances + Valhalla second-source check. Output:
  `public/data/places.json`, `public/data/routes-seed.json` (raw responses in
  `data/raw/`).
- `scripts/fetch_villages_trimmed.py` — Overpass villages around Chichawatni +
  Sahiwal/Okara/Pakpattan (the full `scripts/fetch_villages.py` stalled on
  Islamabad: Overpass 502 at capacity; re-run it when Overpass is quiet to
  add Lahore/Islamabad/Faisalabad/Multan villages), then OSRM
  Chichawatni → every village and hub → its nearby villages.
- Seed data (final, 2026-11-09): **123 places** (21 city, 7 town, 89 village,
  2 hamlet, 3 suburb, 1 airport) and **202 routes** (Chichawatni → every
  place, hub ↔ hub, hub → nearby villages). Full counts in `data/COVERAGE.md`.
- Seed routes are READ-ONLY. User edits go in the `routeOverrides` table
  (keyed by route ID), so app updates never overwrite them. Edit / add /
  duplicate (via custom place + manual km) / soft-delete supported.
  Every route shows "Source: OSRM, checked 2026-11-09" or "Manual, edited …".
- Straight-line (haversine) is a sanity check only — never a quote value.
  Road/straight ratio > 2.0 is flagged.
- Coverage: see `data/COVERAGE.md` (counts per hub/category, routing failures,
  Valhalla deviations > 10% — 9 routes flagged "VERIFY WITH ODOMETER").
- Search: normalised prefix + fuzzy, handles "chak 123 9L" / "123/9-L",
  < 100 ms per keystroke over 5,000 places once the index is built
  (unit-tested; one-time index build ~90–165 ms on this sandbox VM).

## Storage & backup

- Every change writes to IndexedDB immediately in a transaction. No save button.
- `navigator.storage.persist()` is requested on first load; the result is
  shown in Settings.
- Schema v2 with a tested migration (v1 → v2 on a populated DB, `src/lib/db.test.ts`).
- Manual JSON backup (`schemaVersion`, `appVersion`, checksum) + per-table CSV
  (UTF-8 BOM). Export via download AND Web Share API.
- Restore: validates file + checksum, previews counts, Replace/Merge,
  auto-snapshots current data as a download first, verifies counts.
- Google Drive: **NOT configured, NOT tested with a real account.**
  No OAuth Client ID exists. The Drive button is shipped DISABLED with the
  exact blocker text: "Not configured: Google OAuth Client ID missing."
  Exact free setup steps (~15 min, owner's Google account) are in
  `src/lib/drive.ts` and `docs/INSTALL-ANDROID.md`. Gmail inbox is not a backup.
- Last-backup date is shown; a banner appears if no backup in 7 days.

## UI

360x640 and 320px wide, base font 16px, tap targets ≥ 48px, numeric keypad
(`inputmode=decimal`), live recalculation. Cold start opens directly on Quote
with the From field focused. Sections: Quote, Trips, Car Expenses,
Settlements, More (Saved Routes + Settings). Car profiles with rate history
(effective dates); each trip stores a snapshot of the rates used.
First run: empty fields + "Set petrol price" prompt; a "Load sample values"
button fills values clearly marked SAMPLE.

## Tests

- `npm test` — Vitest: 33 tests (calc vectors, rounding trap, validation,
  settlement property driver+owner=net, double-count, haversine, week range,
  search incl. 5,000-place timing, migration, backup checksum).
- `npm run build` — `tsc -b && vite build` (PWA precache 12 entries).
- `npx playwright test` — **26/26 PASS** (13 tests × Pixel 5 + 320×568): cold start → quote,
  search/select, one-way/return, km override, save trip, reload persistence,
  settlement, offline after first load, quote screen has no driver %,
  6 hostile tests, backup → wipe → restore round-trip.
  Lighthouse 13.6.0 (throttled CPU): Performance 82, Accessibility 100,
  Best practices 100, SEO 91. SW-update test (persistent profile,
  v1.0.0→v1.0.1 rebuild): trip survived — PASS.

## Assumptions

1. No JDK/Android SDK in the sandbox → no signed APK; PWA is the shipped
   install method. Capacitor config for a later APK build is in
   `capacitor.config.ts` (UNVERIFIED — never built).
2. OSRM demo server + Valhalla demo are the routing sources (public, free,
   rate-limited, no SLA). If either is down at build time, seed data is
   whatever was fetched; the app never invents km.
3. Valhalla disagrees with OSRM by >10% on 9 routes (8 cities + 1 village, up to 71% — Sargodha,
   Jhang). OSRM is kept as the seed source (its road/straight ratios are all
   sane 1.04–1.35 and durations sane); the 8 routes are flagged in-app and
   in `data/COVERAGE.md` for odometer verification. See `AUDIT.md`.
4. Nominatim returned the railway-station node for "Chichawatni" first;
   coordinates used are 30.5354804, 72.6903375 (town centre) — verified
   against the town's bounding box.
5. Petrol price, km/L, rate/km are the owner's real numbers — the app ships
   NO defaults. Sample values (270 / 12 / 60) are TEST ONLY, never defaults.
   App version is now 1.0.1 (bumped for the SW-update test); schema v3.
6. Google Drive needs the owner's Google Cloud setup; nothing about Drive
   was tested with a real account.
7. Hosting is not deployed yet (no connected account in the sandbox).
   `dist/` is ready; deploy is 3 commands in `docs/INSTALL-ANDROID.md`.
8. OpenRouter credits were nearly exhausted (402: could afford only 2,736
   tokens at call time). The thinking-model call succeeded via a curl-based
   gateway (`~/workspace/thinking-model/curl_think.py`) because `think.py`'s
   Python urllib hangs on this VM with the proxy env set; the response was
   cut at the 1,200-token cap (hostile items 10–15 finished by the QA pass).

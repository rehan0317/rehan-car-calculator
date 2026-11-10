import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { calcQuoteV2, calcSettlement, findDoubleCountedIds, parseInput, roundPKR, weekRangeMonSun, type QuoteV2Input } from "./lib/calc";
import { db, getSettings, requestPersistence, todayISO, uid, daysSince, APP_VERSION, type CarRow, type DriverRow, type ExpenseRow, type SettingsRow, type TripRow } from "./lib/db";
import { loadPlaces, loadSeedRoutes, resolveRoute, liveLookupKm, routeId, invalidatePlacesCache, placeType, type Place, type ResolvedRoute } from "./lib/routes";
import { searchPlaces, type SearchHit } from "./lib/search";
import { applyBackup, buildBackup, exportCsv, shareBackup, validateBackup, type BackupFile } from "./lib/backup";

const fmtRs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-PK")}`;
const fmtNum = (n: number | null) => (n === null ? "" : String(n));

function NumField(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; testId?: string; onBlur?: () => void }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input data-testid={props.testId} type="text" inputMode="decimal" autocomplete="off"
        value={props.value} placeholder={props.placeholder ?? ""}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        onBlur={props.onBlur} />
    </label>
  );
}

/** Search wrapper (App-level, search.ts stays pure): most-used destinations
 *  first, then search score, then name. */
function searchPlacesUsage<T extends { id: string; name: string }>(q: string, places: T[], usage: Map<string, number>, limit = 12): SearchHit<T>[] {
  const hits = searchPlaces(q, places, 40);
  hits.sort((a, b) => (usage.get(b.item.id) ?? 0) - (usage.get(a.item.id) ?? 0) || b.score - a.score || a.item.name.localeCompare(b.item.name));
  return hits.slice(0, limit);
}

function PlacePicker(props: {
  label: string; places: Place[]; value: Place | null; onPick: (p: Place | null) => void;
  testId: string; autoFocus?: boolean; open: boolean; onOpenChange: (open: boolean) => void;
  usage: Map<string, number>; onAddAlias: (placeId: string, alias: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasText, setAliasText] = useState("");
  const open = props.open;
  const setOpen = props.onOpenChange;
  const hits = useMemo(() => searchPlacesUsage(q, props.places, props.usage, 12), [q, props.places, props.usage]);
  return (
    <div class="field">
      <span>{props.label}</span>
      <input data-testid={props.testId} type="text" autocomplete="off" autoFocus={props.autoFocus}
        value={open ? q : props.value ? props.value.name : q}
        placeholder="Type to search a place…"
        onFocus={() => {
          // Clear the query on focus: the closed field shows the selected
          // place NAME, and typing after a tap would otherwise APPEND to
          // that name ("Chak No 112/12.LBara") and match nothing. Clearing
          // makes typing always start fresh; closing the picker without a
          // pick shows the selected name again. (An earlier fix reset q to
          // the name + select(), but the re-render raced the selection and
          // the append came back intermittently — this has no race: the
          // value can only become "" or the typed text.)
          setQ(""); setOpen(true);
        }}
        onInput={(e) => { setQ((e.target as HTMLInputElement).value); setOpen(true); }} />
      {open && (
        <div class="picker">
          {hits.length === 0 && <div class="picker-empty">Not found — add it as a custom place below.</div>}
          {hits.map((h) => {
            const firstAlias = h.item.aliases[0];
            return (
              <div class="picker-row" key={h.item.id}>
                <button type="button" onClick={() => { props.onPick(h.item); setOpen(false); }}>
                  {h.item.name}{firstAlias ? ` - ${firstAlias}` : ""} <small>{placeType(h.item)}</small>
                </button>
                <button type="button" class="mini" onClick={() => { setAliasFor(h.item.id); setAliasText(""); }}>+ popular name</button>
                {aliasFor === h.item.id && (
                  <div class="alias-form">
                    <input type="text" value={aliasText} placeholder="Popular name for this place"
                      onInput={(e) => setAliasText((e.target as HTMLInputElement).value)} />
                    <button type="button" onClick={async () => { await props.onAddAlias(h.item.id, aliasText); setAliasFor(null); }}>Save</button>
                    <button type="button" onClick={() => setAliasFor(null)}>Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<"quote" | "trips" | "expenses" | "settlements" | "more">("quote");
  const [places, setPlaces] = useState<Place[]>([]);
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [cars, setCars] = useState<CarRow[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [usage, setUsage] = useState<Map<string, number>>(new Map());
  const [seedCount, setSeedCount] = useState(0);
  const [loadError, setLoadError] = useState("");

  const refresh = async () => {
    setSettings(await getSettings());
    setCars(await db.cars.toArray());
    setTrips(await db.trips.orderBy("date").reverse().toArray());
    setExpenses(await db.expenses.orderBy("date").reverse().toArray());
    setSeedCount((await loadSeedRoutes()).length);
  };

  useEffect(() => {
    (async () => {
      try {
        setPlaces(await loadPlaces());
        await loadSeedRoutes();
      } catch (e) { setLoadError(String(e)); }
      // One car only: no default car is created and no car name is ever
      // shown or asked for. The owner's existing car row (if any) stays in
      // the database; the Quote screen reads its avgKmpl only as a fallback
      // — the remembered average lives in settings (see persistKmpl).
      const u = await db.placeUsage.toArray();
      setUsage(new Map(u.map((r) => [r.placeId, r.count])));
      await refresh();
      await requestPersistence();
    })();
  }, []);

  const bumpUsage = async (placeId: string) => {
    const row = await db.placeUsage.get(placeId);
    const count = (row?.count ?? 0) + 1;
    await db.placeUsage.put({ placeId, count, lastUsed: new Date().toISOString() });
    setUsage((prev) => new Map(prev).set(placeId, count));
  };

  const reloadPlaces = async () => {
    setPlaces(await loadPlaces());
  };

  const petrolAge = daysSince(settings?.petrolPriceSetOn ?? null);
  const backupAge = daysSince(settings?.lastBackupAt ? settings.lastBackupAt.slice(0, 10) : null);
  const backupStale = settings?.lastBackupAt == null || (backupAge !== null && backupAge >= 7);

  return (
    <div class="app">
      <header><h1>Car Calculator</h1><span>Chichawatni</span></header>
      {loadError && <div class="warn" role="alert">Could not load saved routes: {loadError}. Manual km entry still works.</div>}
      {backupStale && tab !== "more" && (
        <div class="warn" role="alert">No backup in 7 days. Go to More → Backup &amp; restore, and save a copy. Clearing browser data or uninstalling can delete your records.</div>
      )}
      {tab === "quote" && <QuoteScreen places={places} cars={cars} settings={settings} usage={usage} bumpUsage={bumpUsage} onSaved={refresh} onReloadPlaces={reloadPlaces} onSettingsChanged={refresh} />}
      {tab === "trips" && <TripsScreen trips={trips} onChanged={refresh} />}
      {tab === "expenses" && <ExpensesScreen expenses={expenses} cars={cars} onChanged={refresh} />}
      {tab === "settlements" && <SettlementsScreen trips={trips} expenses={expenses} onChanged={refresh} />}
      {tab === "more" && <MoreScreen settings={settings} seedCount={seedCount} onChanged={refresh} setTab={setTab} />}
      <nav class="bottombar" aria-label="Sections">
        <button class={tab === "quote" ? "active" : ""} onClick={() => setTab("quote")}>Quote</button>
        <button class={tab === "trips" ? "active" : ""} onClick={() => setTab("trips")}>Trips</button>
        <button class={tab === "expenses" ? "active" : ""} onClick={() => setTab("expenses")}>Expenses</button>
        <button class={tab === "settlements" ? "active" : ""} onClick={() => setTab("settlements")}>Settlement</button>
        <button class={tab === "more" ? "active" : ""} onClick={() => setTab("more")}>More</button>
      </nav>
    </div>
  );
}

// ---------------- Quote ----------------

interface PlazaEdit {
  key: string;
  plazaId: string | null;
  name: string;
  fareOut: string;
  fareBack: string;
  verified: boolean;
}

function QuoteScreen(props: {
  places: Place[]; cars: CarRow[]; settings: SettingsRow | null;
  usage: Map<string, number>; bumpUsage: (placeId: string) => Promise<void>;
  onSaved: () => void; onReloadPlaces: () => Promise<void>; onSettingsChanged: () => void;
}) {
  const { places, cars } = props;
  const chichawatni = places.find((p) => p.id === "chichawatni") ?? null;
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [isReturn, setIsReturn] = useState(true);
  const [route, setRoute] = useState<ResolvedRoute | null>(null);
  const [routeMsg, setRouteMsg] = useState("");
  const [oneWay, setOneWay] = useState("");
  const [totalOverride, setTotalOverride] = useState("");
  const [petrol, setPetrol] = useState("");
  const [kmpl, setKmpl] = useState("");
  const [rate, setRate] = useState("");
  const [extraCost, setExtraCost] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [customPlaceName, setCustomPlaceName] = useState("");
  const [customPlaceKm, setCustomPlaceKm] = useState("");
  const [customPlaceMsg, setCustomPlaceMsg] = useState("");
  const [openPicker, setOpenPicker] = useState<"from" | "to" | null>(null);
  const [tollSheetOpen, setTollSheetOpen] = useState(false);
  const [tollIncluded, setTollIncluded] = useState(true);
  const [tollPlazas, setTollPlazas] = useState<PlazaEdit[]>([]);
  const [tollAsOf, setTollAsOf] = useState<string | null>(null);
  const [tollSource, setTollSource] = useState("");
  const [newPlazaName, setNewPlazaName] = useState("");
  const [newPlazaOut, setNewPlazaOut] = useState("");
  const [newPlazaBack, setNewPlazaBack] = useState("");
  const fromSet = useRef(false);
  // Dirty flags: once the user types a rate, later data refreshes must
  // never clobber what they typed.
  const dirtyPetrol = useRef(false);
  const dirtyRate = useRef(false);
  const dirtyKmpl = useRef(false);

  // The single car row (if one exists) is only a fallback storage slot for
  // the remembered average km/L. Its name is never displayed anywhere; the
  // primary store is settings.avgKmpl (persistKmpl).
  const car = cars[0] ?? null;

  useEffect(() => {
    if (!fromSet.current && chichawatni) { setFrom(chichawatni); fromSet.current = true; }
  }, [chichawatni]);

  // Prefill once from remembered values (settings, falling back to the
  // single car row's stored values). Empty stays empty — no defaults.
  useEffect(() => {
    if (!props.settings) return;
    if (!dirtyPetrol.current) {
      const p = props.settings.petrolPricePerLitre ?? car?.petrolPricePerLitre ?? null;
      if (p !== null) setPetrol(String(p));
    }
    if (!dirtyRate.current) {
      const r = props.settings.ratePerKm ?? car?.ratePerKm ?? null;
      if (r !== null) setRate(String(r));
    }
    if (!dirtyKmpl.current) {
      const k = props.settings?.avgKmpl ?? car?.avgKmpl ?? null;
      if (k !== null) setKmpl(String(k));
    }
  }, [cars, props.settings]);

  useEffect(() => {
    (async () => {
      if (!from || !to) { setRoute(null); setRouteMsg(""); return; }
      const r = await resolveRoute(from.id, to.id, places);
      if (r && !r.isDeleted) {
        setRoute(r); setOneWay(String(r.km)); setTotalOverride("");
        setRouteMsg(r.ratioFlag ? `Warning: road km is ${r.ratio?.toFixed(1)}x the straight-line distance — check the km before quoting.` : "");
      } else if (r?.isDeleted) {
        setRoute(null); setRouteMsg("This route was deleted. Enter km manually.");
      } else {
        setRoute(null);
        const live = await liveLookupKm(from, to);
        if (live) {
          setOneWay(String(live.km));
          setRouteMsg(`${live.sourceLabel}. Check the km before quoting.`);
        } else {
          setRouteMsg("No saved route for this pair (offline or not in the list). Enter km manually below.");
        }
      }
    })();
  }, [from, to]);

  // Tolls for the selected route: seed tolls if present, routeTolls override
  // wins. No data at all = empty plaza list ("Fare not verified - enter").
  const loadTollState = async (r: ResolvedRoute | null) => {
    if (!r) { setTollPlazas([]); setTollAsOf(null); setTollSource(""); return; }
    const ov = await db.routeTolls.get(r.id);
    if (ov) {
      setTollPlazas(ov.plazas.map((p) => ({ key: p.plazaId, plazaId: p.plazaId, name: p.name, fareOut: p.fareOut === null ? "" : String(p.fareOut), fareBack: p.fareBack === null ? "" : String(p.fareBack), verified: p.verified })));
      setTollAsOf(ov.asOf); setTollSource(ov.source);
    } else if (r.tolls) {
      setTollPlazas(r.tolls.plazas.map((p, i) => ({ key: `seed-${i}`, plazaId: null, name: p.name, fareOut: p.fareOut === null ? "" : String(p.fareOut), fareBack: p.fareBack === null ? "" : String(p.fareBack), verified: p.verified })));
      setTollAsOf(r.tolls.asOf); setTollSource(r.tolls.source ?? "");
    } else {
      setTollPlazas([]); setTollAsOf(null); setTollSource("");
    }
  };
  useEffect(() => { loadTollState(route); }, [route]);

  // Per-plaza fareBack defaults to fareOut (calc boundary: null means 0, so
  // the default is resolved HERE before summing totals for calcQuoteV2).
  const tollOut = tollPlazas.reduce((s, p) => s + (parseInput(p.fareOut) ?? 0), 0);
  const tollBack = tollPlazas.reduce((s, p) => {
    const o = parseInput(p.fareOut);
    const b = parseInput(p.fareBack);
    return s + (b ?? o ?? 0);
  }, 0);
  // True when at least one plaza has a known fare (seed-verified or entered
  // by the user). With plazas but NO known fare, the totals must NOT display
  // "Rs 0" — the fare is unknown, and the row/card say so instead (v2 ships
  // with 0 verified official fares, so this is the common case, not an edge).
  const tollFaresKnown = tollPlazas.some((p) => parseInput(p.fareOut) !== null || parseInput(p.fareBack) !== null);

  const oneWayNum = parseInput(oneWay);
  const computedTotal = oneWayNum !== null ? oneWayNum * (isReturn ? 2 : 1) : null;
  const totalKmShown = totalOverride !== "" ? totalOverride : (computedTotal !== null ? String(computedTotal) : "");

  const input: QuoteV2Input = {
    oneWayKm: oneWayNum, isReturn,
    totalKmOverride: parseInput(totalOverride),
    avgKmpl: parseInput(kmpl), petrolPricePerLitre: parseInput(petrol),
    ratePerKm: parseInput(rate),
    tollOut: tollPlazas.length > 0 ? tollOut : null,
    tollBack: tollPlazas.length > 0 ? tollBack : null,
    tollIncluded,
    extraCost: parseInput(extraCost),
  };
  const { result, errors } = calcQuoteV2(input);

  const persistPetrol = async () => {
    const v = parseInput(petrol);
    await db.settings.update("app", { petrolPricePerLitre: v, petrolPriceSetOn: v !== null ? todayISO() : props.settings?.petrolPriceSetOn ?? null });
    props.onSettingsChanged();
  };
  const persistRate = async () => {
    const v = parseInput(rate);
    await db.settings.update("app", { ratePerKm: v, ratePerKmSetOn: v !== null ? todayISO() : props.settings?.ratePerKmSetOn ?? null });
    props.onSettingsChanged();
  };
  const persistKmpl = async () => {
    const v = parseInput(kmpl);
    // Primary store is settings (works even with no car row at all, e.g. a
    // fresh install); the single car row, if one exists, is kept in sync.
    await db.settings.update("app", { avgKmpl: v, avgKmplSetOn: v !== null ? todayISO() : props.settings?.avgKmplSetOn ?? null });
    if (car) { await db.cars.update(car.id, { avgKmpl: v }); }
    props.onSettingsChanged();
  };

  /** Total-km edit: saves a routeOverride (existing pattern) so the edit
   *  survives; the trip is still flagged "overridden". */
  const saveTotalOverride = async () => {
    const t = parseInput(totalOverride);
    if (t === null || !route || route.isDeleted) return;
    if (computedTotal !== null && Math.abs(t - computedTotal) < 0.005) return;
    const oneWayKm = Math.round((t / (isReturn ? 2 : 1)) * 100) / 100;
    await db.routeOverrides.put({ routeId: route.id, fromId: route.fromId, fromName: route.fromName, toId: route.toId, toName: route.toName, km: oneWayKm, source: `User override, edited ${todayISO()}`, deleted: false, updatedAt: new Date().toISOString() });
    setSavedMsg("Route km override saved. Seed route unchanged.");
  };

  const onTotalKmChange = (v: string) => {
    setTotalOverride(v);
    // No saved route: the typed total is the only km — derive one-way so the
    // quote can compute at all.
    if (!route) {
      const t = parseInput(v);
      setOneWay(t === null ? "" : String(t / (isReturn ? 2 : 1)));
    }
  };

  const saveTrip = async () => {
    if (!result || !from || !to) return;
    await persistPetrol();
    await persistRate();
    await persistKmpl();
    const extra = parseInput(extraCost) ?? 0;
    // carId/carName are stored only because the trip snapshot schema
    // requires them; the name is never shown in the UI (one car only).
    const row: TripRow = {
      id: uid(), date: todayISO(), carId: car?.id ?? "", carName: car?.name ?? "",
      fromId: from.id, fromName: from.name, toId: to.id, toName: to.name,
      oneWayKm: input.oneWayKm!, isReturn, totalKm: result.totalKm, kmOverridden: result.kmWasOverridden,
      routeSource: route ? route.sourceLabel : "Manual, entered by user",
      avgKmpl: input.avgKmpl!, petrolPricePerLitre: input.petrolPricePerLitre!,
      ratePerKm: input.ratePerKm!, flatRent: null,
      toll: result.toll, other: extra, billTollToCustomer: tollIncluded,
      fuelLitres: result.fuelLitres, fuelCost: result.fuelCost, customerRent: result.rent,
      totalQuote: result.totalBill, estimatedSaving: result.saving,
      note: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tollPlazas: tollPlazas.map((p) => ({ name: p.name, fare: parseInput(p.fareOut) ?? null })),
      tollIncluded, extraCost: extra,
    };
    await db.trips.add(row);
    setSavedMsg(`Trip saved: ${from.name} → ${to.name}, ${fmtRs(result.totalBill)}.`);
    props.onSaved();
  };

  const addAlias = async (placeId: string, alias: string) => {
    const a = alias.trim();
    if (!a) return;
    await db.placeAliases.add({ id: uid(), placeId, alias: a, createdAt: new Date().toISOString() });
    invalidatePlacesCache();
    await props.onReloadPlaces();
    setSavedMsg(`Popular name "${a}" saved.`);
  };

  const addCustomPlace = async () => {
    const name = customPlaceName.trim();
    if (!name) return;
    const km = parseInput(customPlaceKm);
    const id = `custom-${uid()}`;
    await db.placesCustom.add({ id, name, aliases: [], category: "custom", createdAt: new Date().toISOString() });
    if (km !== null && from) {
      await db.routeOverrides.put({ routeId: routeId(from.id, id), fromId: from.id, fromName: from.name, toId: id, toName: name, km, source: `Manual, entered by user ${todayISO()}`, deleted: false, updatedAt: new Date().toISOString() });
    }
    setCustomPlaceName(""); setCustomPlaceKm(""); setCustomPlaceMsg("Place added. Pick it in the To field.");
    invalidatePlacesCache();
    await props.onReloadPlaces();
  };

  const computeKmOnline = async () => {
    const name = customPlaceName.trim();
    if (!name) return;
    setCustomPlaceMsg("Looking it up online…");
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error("lookup failed");
      const d = await res.json();
      if (!d[0]) { setCustomPlaceMsg("Place not found online — enter km manually."); return; }
      const origin = from ?? chichawatni;
      if (!origin) { setCustomPlaceMsg("Enter km manually."); return; }
      const target: Place = { id: "tmp", name, aliases: [], category: "place", lat: Number(d[0].lat), lon: Number(d[0].lon), source: "Nominatim", fetched_at: "" };
      const live = await liveLookupKm(origin, target);
      if (live) { setCustomPlaceKm(String(live.km)); setCustomPlaceMsg(`${live.sourceLabel}. Check the km before quoting.`); }
      else setCustomPlaceMsg("Could not compute km online — enter km manually.");
    } catch {
      setCustomPlaceMsg("Could not compute km online — enter km manually.");
    }
  };

  const saveTollSheet = async () => {
    if (!route) { setTollSheetOpen(false); return; }
    // Empty fare stays null (unknown) — NEVER coerced to 0, or the row
    // would show "Rs 0" for a fare nobody entered (see top-15 audit #2b).
    const plazas = tollPlazas.filter((p) => p.name.trim()).map((p) => {
      const fo = parseInput(p.fareOut);
      const fb = parseInput(p.fareBack) ?? fo;
      return { plazaId: p.plazaId ?? `user-${uid()}`, name: p.name.trim(), fareOut: fo, fareBack: fb, verified: p.verified };
    });
    const totalOut = plazas.reduce((s, p) => s + (p.fareOut ?? 0), 0);
    const totalBack = plazas.reduce((s, p) => s + (p.fareBack ?? 0), 0);
    await db.routeTolls.put({ routeId: route.id, plazas, tollTotalOut: totalOut, tollTotalBack: totalBack, asOf: todayISO(), source: "User-entered fares" });
    setTollPlazas(plazas.map((p) => ({ key: p.plazaId, plazaId: p.plazaId, name: p.name, fareOut: p.fareOut === null ? "" : String(p.fareOut), fareBack: p.fareBack === null ? "" : String(p.fareBack), verified: p.verified })));
    setTollAsOf(todayISO()); setTollSource("User-entered fares");
    setTollSheetOpen(false);
    setSavedMsg("Toll fares saved for this route.");
  };
  const closeTollSheet = () => { setTollSheetOpen(false); loadTollState(route); };

  const pickTo = (p: Place | null) => {
    setTo(p);
    if (p) props.bumpUsage(p.id);
  };

  const petrolAge = daysSince(props.settings?.petrolPriceSetOn ?? null);
  const stalePetrol = petrolAge !== null && petrolAge > (props.settings?.petrolStaleDays ?? 7);
  const rateAge = daysSince(props.settings?.ratePerKmSetOn ?? null);
  const kmplAge = daysSince(props.settings?.avgKmplSetOn ?? null);

  return (
    <main>
      <PlacePicker label="From" places={places} value={from} onPick={setFrom} testId="from-input" open={openPicker === "from"} onOpenChange={(o) => setOpenPicker(o ? "from" : null)} usage={props.usage} onAddAlias={addAlias} />
      <PlacePicker label="To" places={places} value={to} onPick={pickTo} testId="to-input" open={openPicker === "to"} onOpenChange={(o) => setOpenPicker(o ? "to" : null)} usage={props.usage} onAddAlias={addAlias} />
      <details>
        <summary>Not found — add as custom place</summary>
        <div class="row">
          <input type="text" value={customPlaceName} placeholder="Place name, e.g. Chak 112/12-L" onInput={(e) => setCustomPlaceName((e.target as HTMLInputElement).value)} />
        </div>
        <div class="row">
          <input type="text" inputMode="decimal" value={customPlaceKm} placeholder="Km from Chichawatni" onInput={(e) => setCustomPlaceKm((e.target as HTMLInputElement).value)} />
          <button type="button" onClick={computeKmOnline}>Compute km when online</button>
        </div>
        <div class="row"><button type="button" onClick={addCustomPlace}>Add place</button></div>
        {customPlaceMsg && <p class="hint">{customPlaceMsg}</p>}
        <p class="hint">After adding, pick it in the To field. The km is saved with the route.</p>
      </details>
      <div class="toggle big" role="group" aria-label="One-way or return">
        <button type="button" class={!isReturn ? "active" : ""} onClick={() => setIsReturn(false)}>One Way</button>
        <button type="button" class={isReturn ? "active" : ""} onClick={() => setIsReturn(true)}>Two Way</button>
      </div>
      <NumField label="Total km — edit to override (flagged on the trip)" value={totalKmShown} onChange={onTotalKmChange} onBlur={saveTotalOverride} placeholder="auto" testId="total-km-override" />
      {route && <p class="hint" data-testid="route-source">{route.sourceLabel}{route.isOverride ? " (your override)" : ""}</p>}
      {route?.flag && <p class="warn" role="alert" data-testid="route-flag">{route.flag}</p>}
      {routeMsg && <p class="hint">{routeMsg}</p>}
      <div class="grid2">
        <div>
          <NumField label="Rate Rs / km" value={rate} onChange={(v) => { dirtyRate.current = true; setRate(v); }} onBlur={persistRate} testId="rate-per-km" />
          <p class="asof">{props.settings?.ratePerKmSetOn ? `as of ${props.settings.ratePerKmSetOn}${rateAge !== null && rateAge > 0 ? ` (${rateAge}d ago)` : ""}` : "not set yet"}</p>
        </div>
        <div>
          <NumField label="Petrol Rs / litre" value={petrol} onChange={(v) => { dirtyPetrol.current = true; setPetrol(v); }} onBlur={persistPetrol} testId="petrol-price" />
          <p class="asof">{props.settings?.petrolPriceSetOn ? `as of ${props.settings.petrolPriceSetOn}${petrolAge !== null && petrolAge > 0 ? ` (${petrolAge}d ago)` : ""}` : "not set yet"}{stalePetrol ? " — more than 7 days old, update before quoting." : ""}</p>
        </div>
        <div>
          <NumField label="Average km / litre" value={kmpl} onChange={(v) => { dirtyKmpl.current = true; setKmpl(v); }} onBlur={persistKmpl} testId="kmpl" />
          <p class="asof">{props.settings?.avgKmplSetOn ? `as of ${props.settings.avgKmplSetOn}${kmplAge !== null && kmplAge > 0 ? ` (${kmplAge}d ago)` : ""}` : "enter once — remembered afterwards"}</p>
        </div>
      </div>
      <div class="tollrow" data-testid="toll-row">
        <button type="button" class="tollrow-main" onClick={() => setTollSheetOpen(true)}>
          <span>Toll</span>
          <b>{tollPlazas.length === 0 ? "Fare not verified - enter" : tollFaresKnown ? `${tollPlazas.length} plaza${tollPlazas.length > 1 ? "s" : ""} - ${fmtRs(tollOut)}` : `${tollPlazas.length} plaza${tollPlazas.length > 1 ? "s" : ""} · fare not verified`}</b>
          <span class="chev" aria-hidden="true">›</span>
        </button>
        <label class="switch"><input type="checkbox" data-testid="toll-include" checked={tollIncluded} onChange={(e) => setTollIncluded((e.target as HTMLInputElement).checked)} /><span>{tollIncluded ? "Included" : "Excluded"}</span></label>
      </div>
      {tollAsOf && <p class="asof">Toll rates as of {tollAsOf}{tollSource ? ` · ${tollSource}` : ""}</p>}
      {tollAsOf && daysSince(tollAsOf) !== null && (daysSince(tollAsOf) as number) > 90 && (
        <p class="warn" role="alert">Toll tariff is {daysSince(tollAsOf)} days old (more than 90 days) — fares may have changed. Check before quoting.</p>
      )}
      {!to && <p class="hint">Pick a destination to see the quote. Enter petrol price, km/L and rate/km — they are remembered.</p>}
      {to && errors.length > 0 && <div class="warn" role="alert">{errors.map((e) => e.message).join(". ")}</div>}
      <section class="result result-sticky" aria-live="polite" data-testid="quote-result">
        <div><span>Total km</span><b>{result ? `${result.totalKm} km${result.kmWasOverridden ? " (overridden)" : ""}` : "—"}</b></div>
        <div><span>Fuel needed</span><b>{result ? `${result.fuelLitresDisplay} L` : "—"}</b></div>
        <div><span>Fuel cost</span><b>{result ? fmtRs(result.fuelCost) : "—"}</b></div>
        <div><span>Toll {isReturn ? "(return ×2)" : "(one way)"}</span><b>{result ? (tollFaresKnown ? fmtRs(result.toll) : "not verified") : "—"}</b></div>
        <div><span>Rent</span><b>{result ? fmtRs(result.rent) : "—"}</b></div>
        <div class="total"><span>Total bill</span><b>{result ? fmtRs(result.totalBill) : "—"}</b></div>
        <div><span>Your saving</span><b>{result ? fmtRs(result.saving) : "—"}</b></div>
      </section>
      <details>
        <summary>+ Extra cost</summary>
        <NumField label="Extra cost Rs" value={extraCost} onChange={setExtraCost} testId="extra-cost" />
        <p class="hint">An extra owner cost for this trip (not fuel, not toll). It lowers your saving, not the bill.</p>
      </details>
      <button type="button" class="primary" data-testid="save-trip" disabled={!result || !from || !to} onClick={saveTrip}>Save trip</button>
      {savedMsg && <p class="ok" role="status">{savedMsg}</p>}

      {tollSheetOpen && (
        <div class="sheet-backdrop" onClick={closeTollSheet}>
          <div class="sheet" role="dialog" aria-label="Toll breakdown" data-testid="toll-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Toll — {to ? `${from?.name ?? ""} → ${to.name}` : "no destination yet"}</h3>
            {tollAsOf && <p class="hint">Toll rates as of {tollAsOf}{tollSource ? ` · ${tollSource}` : ""}</p>}
            {tollAsOf && daysSince(tollAsOf) !== null && (daysSince(tollAsOf) as number) > 90 && (
              <p class="warn" role="alert">Toll tariff is {daysSince(tollAsOf)} days old (more than 90 days) — fares may have changed. Check before quoting.</p>
            )}
            {!route && <p class="hint">Select a destination first.</p>}
            {tollPlazas.length === 0 && route && <p class="hint">No toll data for this route yet. Add the plazas you cross and their fares below.</p>}
            {tollPlazas.map((p, i) => (
              <div class="plaza" key={p.key}>
                <div><b>{p.name || "Unnamed toll plaza"}</b> {p.verified ? <span class="badge-ok">Verified</span> : (parseInput(p.fareOut) !== null ? <span class="badge">Entered by you</span> : <span class="badge-warn">Fare not verified - enter</span>)}</div>
                <div class="grid2">
                  <NumField label="Fare out Rs" value={p.fareOut} onChange={(v) => setTollPlazas((prev) => prev.map((x, j) => j === i ? { ...x, fareOut: v } : x))} />
                  <NumField label="Fare back Rs" value={p.fareBack} onChange={(v) => setTollPlazas((prev) => prev.map((x, j) => j === i ? { ...x, fareBack: v } : x))} placeholder="same as out" />
                </div>
              </div>
            ))}
            {tollPlazas.length > 0 && (
              <div class="sheet-total" data-testid="toll-sheet-total">
                <div><span>Total (one way)</span><b>{tollFaresKnown ? fmtRs(tollOut) : "fare not verified"}</b></div>
                {isReturn && <div><span>Total (return)</span><b>{tollFaresKnown ? fmtRs(tollOut + tollBack) : "fare not verified"}</b></div>}
                {tollPlazas.some((p) => parseInput(p.fareOut) === null && parseInput(p.fareBack) === null) && (
                  <p class="hint">{tollPlazas.filter((p) => parseInput(p.fareOut) === null && parseInput(p.fareBack) === null).length} plaza(s) have no fare yet — not included in the total. Enter the fare above.</p>
                )}
              </div>
            )}
            <div class="plaza">
              <b>Add a plaza</b>
              <label class="field"><span>Plaza name</span>
                <input type="text" value={newPlazaName} placeholder="e.g. Sahiwal Toll Plaza" onInput={(e) => setNewPlazaName((e.target as HTMLInputElement).value)} />
              </label>
              <div class="grid2">
                <NumField label="Fare out Rs" value={newPlazaOut} onChange={setNewPlazaOut} />
                <NumField label="Fare back Rs" value={newPlazaBack} onChange={setNewPlazaBack} placeholder="same as out" />
              </div>
              <button type="button" onClick={() => {
                const name = newPlazaName.trim();
                if (!name) return;
                setTollPlazas((prev) => [...prev, { key: `new-${uid()}`, plazaId: null, name, fareOut: newPlazaOut, fareBack: newPlazaBack, verified: false }]);
                setNewPlazaName(""); setNewPlazaOut(""); setNewPlazaBack("");
              }}>Add plaza</button>
            </div>
            <button type="button" class="primary" data-testid="save-tolls" onClick={saveTollSheet}>Save tolls</button>
            <button type="button" onClick={closeTollSheet}>Close without saving</button>
          </div>
        </div>
      )}
    </main>
  );
}

// ---------------- Trips ----------------

function TripsScreen(props: { trips: TripRow[]; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const filtered = props.trips.filter((t) => !q || `${t.fromName} ${t.toName} ${t.date}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <main>
      <input type="text" placeholder="Search trips…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <button type="button" onClick={async () => { await exportCsv("trips"); setMsg("Trips CSV downloaded."); }}>Export trips CSV</button>
      {msg && <p class="ok">{msg}</p>}
      {filtered.length === 0 && <p>No trips yet. Save one from the Quote screen.</p>}
      {filtered.map((t) => (
        <article class="card" key={t.id}>
          <b>{t.fromName} → {t.toName}</b> · {t.date}<br />
          {t.totalKm} km ({t.isReturn ? "return" : "one-way"}) · Rent {fmtRs(t.customerRent)} · Fuel {fmtRs(t.fuelCost)} · Toll {fmtRs(t.toll)} · Saving {fmtRs(t.estimatedSaving)}<br />
          <small>{t.routeSource}{t.kmOverridden ? " · km overridden" : ""}{t.tollIncluded === false ? " · toll excluded" : ""}{t.extraCost ? ` · Extra cost ${fmtRs(t.extraCost)}` : ""}</small><br />
          <button type="button" onClick={async () => { if (confirm(`Delete trip ${t.fromName} → ${t.toName}?`)) { await db.trips.delete(t.id); props.onChanged(); } }}>Delete</button>
        </article>
      ))}
    </main>
  );
}

// ---------------- Expenses ----------------

function ExpensesScreen(props: { expenses: ExpenseRow[]; cars: CarRow[]; onChanged: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseRow["category"]>("maintenance");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const total = props.expenses.reduce((s, x) => s + x.amount, 0);

  const add = async () => {
    const a = parseInput(amount);
    if (a === null || a <= 0) { setMsg("Enter an amount above 0."); return; }
    // Every expense is allowable — no checkbox. Trip fuel/toll are never
    // entered here (they live on the trip; the double-count guard enforces it).
    // One car only: carId/carName are stored only because the schema
    // requires them; no car name is ever shown.
    const car = props.cars[0] ?? null;
    await db.expenses.add({ id: uid(), date, carId: car?.id ?? "", carName: car?.name ?? "", category, amount: roundPKR(a), allowable: true, note, createdAt: new Date().toISOString() });
    setAmount(""); setNote(""); setMsg("Expense saved.");
    props.onChanged();
  };
  return (
    <main>
      <h2>Add car expense</h2>
      <label class="field"><span>Date</span>
        <input type="date" value={date} onChange={(e) => setDate((e.target as HTMLInputElement).value)} />
      </label>
      <NumField label="Amount Rs" value={amount} onChange={setAmount} testId="expense-amount" />
      <label class="field"><span>Category</span>
        <select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value as ExpenseRow["category"])}>
          <option value="maintenance">Maintenance</option><option value="repair">Repair</option>
          <option value="oil">Oil</option><option value="tyre">Tyre</option>
          <option value="insurance">Insurance</option><option value="other">Other</option>
        </select>
      </label>
      <label class="field"><span>Note</span><input type="text" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
      <button type="button" class="primary" onClick={add}>Save expense</button>
      {msg && <p class="ok">{msg}</p>}
      <p class="hint">Total (all expenses): <b>{fmtRs(total)}</b> · Trip fuel and toll are never entered here — they live on the trip.</p>
      <button type="button" onClick={async () => { await exportCsv("expenses"); }}>Export expenses CSV</button>
      {props.expenses.map((x) => (
        <article class="card" key={x.id}>
          <b>{fmtRs(x.amount)}</b> · {x.category} · {x.date}{x.note ? ` · ${x.note}` : ""}<br />
          <button type="button" onClick={async () => { if (confirm("Delete this expense?")) { await db.expenses.delete(x.id); props.onChanged(); } }}>Delete</button>
        </article>
      ))}
    </main>
  );
}

// ---------------- Settlements ----------------

function SettlementsScreen(props: { trips: TripRow[]; expenses: ExpenseRow[]; onChanged: () => void }) {
  const [start, setStart] = useState(() => weekRangeMonSun(new Date()).start);
  const [end, setEnd] = useState(() => weekRangeMonSun(new Date()).end);
  const [driverName, setDriverName] = useState("");
  const [driverSelect, setDriverSelect] = useState("");
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [pct, setPct] = useState("");
  const [saved, setSaved] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [preset, setPreset] = useState("week");

  useEffect(() => {
    db.settlements.orderBy("createdAt").reverse().toArray().then(setSaved);
    db.drivers.toArray().then(setDrivers);
  }, [props.trips]);

  const setRange = (p: string) => {
    setPreset(p);
    const now = new Date();
    if (p === "week") { const w = weekRangeMonSun(now); setStart(w.start); setEnd(w.end); }
    if (p === "month") {
      setStart(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      setEnd(`${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`);
    }
  };

  const inRange = props.trips.filter((t) => t.date >= start && t.date <= end);
  const exInRange = props.expenses.filter((x) => x.date >= start && x.date <= end);
  const settledTripIds = new Set(saved.flatMap((s) => s.tripIds));
  const settledExpIds = new Set(saved.flatMap((s) => s.expenseIds));
  const freshTrips = inRange.filter((t) => !settledTripIds.has(t.id));
  const freshExp = exInRange.filter((x) => !settledExpIds.has(x.id));
  const dupeCheck = findDoubleCountedIds(saved.map((s) => ({ tripIds: s.tripIds, expenseIds: s.expenseIds })));

  // Income = cash actually collected (total bill incl. toll when billed);
  // toll is always an owner cost at the plaza, so it is always an expense
  // here too — the two cancel in net, exactly as on the Quote screen.
  const income = freshTrips.reduce((s, t) => s + t.totalQuote, 0);
  const tripFuel = freshTrips.reduce((s, t) => s + t.fuelCost, 0);
  const tripToll = freshTrips.reduce((s, t) => s + t.toll, 0);
  const carExp = freshExp.filter((x) => x.allowable).reduce((s, x) => s + x.amount, 0);
  const pctNum = parseInput(pct);
  const calc = pctNum !== null ? calcSettlement({ income, tripFuel, tripToll, carExpensesAllowable: carExp, driverPct: pctNum }) : null;
  const overlap = saved.filter((s) => s.driverName === driverName && driverName && !(end < s.startDate || start > s.endDate));

  const onDriverNameInput = (v: string) => {
    setDriverName(v);
    setDriverSelect("");
    const match = drivers.find((d) => d.name.toLowerCase() === v.trim().toLowerCase());
    if (match) setPct(String(match.defaultPct));
    else if (pct === "") setPct("30");
  };

  const saveSettlement = async () => {
    if (!calc || pctNum === null || !driverName.trim()) { setMsg("Enter a driver name and a driver % first."); return; }
    const name = driverName.trim();
    const existing = drivers.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (existing) await db.drivers.update(existing.id, { defaultPct: pctNum });
    else await db.drivers.add({ id: uid(), name, defaultPct: pctNum, createdAt: new Date().toISOString() });
    const prev = saved[0];
    const row = {
      id: uid(), createdAt: new Date().toISOString(), startDate: start, endDate: end,
      carId: null, driverName: name, driverPct: pctNum,
      income, tripFuel, tripToll, carExpensesAllowable: carExp,
      allowableExpenses: calc.allowableExpenses, net: calc.net,
      driverShare: calc.driverShare, ownerShare: calc.ownerShare,
      tripIds: freshTrips.map((t) => t.id), expenseIds: freshExp.map((x) => x.id),
      snapshot: { income, tripFuel, tripToll, carExpensesAllowable: carExp, driverPct: pctNum },
      sourceChangedSinceSaved: false,
    };
    await db.settlements.add(row as any);
    setMsg(prev ? `Settlement saved. Previous settlement net was ${fmtRs(prev.net)} — change ${fmtRs(calc.net - prev.net)}.` : "Settlement saved.");
    props.onChanged();
  };

  return (
    <main>
      <h2>Settlement</h2>
      <p class="hint">Driver % applies to NET after expenses — never to gross income.</p>
      <div class="toggle">
        <button type="button" class={preset === "week" ? "active" : ""} onClick={() => setRange("week")}>This week (Mon–Sun)</button>
        <button type="button" class={preset === "month" ? "active" : ""} onClick={() => setRange("month")}>This month</button>
        <button type="button" class={preset === "custom" ? "active" : ""} onClick={() => setPreset("custom")}>Custom</button>
      </div>
      <div class="grid2">
        <label class="field"><span>From</span><input type="date" value={start} onChange={(e) => setStart((e.target as HTMLInputElement).value)} /></label>
        <label class="field"><span>To</span><input type="date" value={end} onChange={(e) => setEnd((e.target as HTMLInputElement).value)} /></label>
      </div>
      <label class="field"><span>Driver (saved)</span>
        <select data-testid="driver-select" value={driverSelect} onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          setDriverSelect(id);
          const d = drivers.find((x) => x.id === id);
          if (d) { setDriverName(d.name); setPct(String(d.defaultPct)); }
        }}>
          <option value="">Type a new driver name below</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label class="field"><span>Driver name</span><input type="text" data-testid="driver-name" value={driverName} onInput={(e) => onDriverNameInput((e.target as HTMLInputElement).value)} /></label>
      <NumField label="Driver % of net" value={pct} onChange={setPct} placeholder="30" testId="driver-pct" />
      {overlap.length > 0 && <div class="warn">Warning: this date range overlaps an earlier settlement for the same driver. Check before saving.</div>}
      {dupeCheck.length > 0 && <div class="warn">Data problem: {dupeCheck.length} trip/expense(s) appear in more than one settlement: {dupeCheck.join(", ")}. Do not save until this is fixed.</div>}
      <p class="hint">{freshTrips.length} trip(s), {freshExp.length} expense(s) in range, not yet settled.</p>
      {calc && (
        <div class="result" data-testid="settlement-result">
          <div><span>Total earned</span><b>{fmtRs(income)}</b></div>
          <div><span>Expenses</span><b>{fmtRs(calc.allowableExpenses)}</b></div>
          <div><span>Net</span><b>{fmtRs(calc.net)}</b></div>
          <div><span>Driver %</span><b>{pctNum}%</b></div>
          <div><span>Driver gets</span><b>{fmtRs(calc.driverShare)}</b></div>
          <div class="total"><span>Owner keeps</span><b>{fmtRs(calc.ownerShare)}</b></div>
          {calc.negativeNetWarning && <div class="warn">Warning: net is negative (expenses are more than income). Driver share is 0 by default — the owner absorbs the loss.</div>}
        </div>
      )}
      {!calc && <p class="hint">Enter a driver name and a driver % to see the result.</p>}
      <button type="button" class="primary" data-testid="save-settlement" disabled={!calc || dupeCheck.length > 0} onClick={saveSettlement}>Save settlement</button>
      {msg && <p class="ok">{msg}</p>}
      <details>
        <summary>History</summary>
        {saved.length === 0 && <p class="hint">No settlements saved yet.</p>}
        {saved.map((s) => {
          const current = props.trips.filter((t) => s.tripIds.includes(t.id));
          const changed = current.reduce((a, t) => a + t.totalQuote, 0) !== s.snapshot.income;
          return (
            <article class="card" key={s.id}>
              <b>{s.driverName}</b> · {s.startDate} to {s.endDate}<br />
              Income {fmtRs(s.income)} · Net {fmtRs(s.net)} · Driver {fmtRs(s.driverShare)} ({s.driverPct}%) · Owner {fmtRs(s.ownerShare)}<br />
              <small>Snapshot saved {s.createdAt.slice(0, 10)} · {s.tripIds.length} trips, {s.expenseIds.length} expenses</small><br />
              {changed && <span class="warn">Source data changed since saved — Recalculate?</span>}
            </article>
          );
        })}
      </details>
    </main>
  );
}

// ---------------- More: Saved Routes + Backup/Restore + About ----------------

function MoreScreen(props: { settings: SettingsRow | null; seedCount: number; onChanged: () => void; setTab: (t: any) => void }) {
  const [routes, setRoutes] = useState<any[]>([]);
  const [routeQ, setRouteQ] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => { loadSeedRoutes().then(setRoutes); }, []);

  const doBackup = async () => {
    const b = await buildBackup();
    const { downloadText } = await import("./lib/backup");
    downloadText(`car-backup-${b.exportedAt.slice(0, 10)}.json`, JSON.stringify(b, null, 2), "application/json");
    await db.settings.update("app", { lastBackupAt: new Date().toISOString() });
    setMsg("Backup downloaded. Save it somewhere safe (Google Drive / WhatsApp).");
    props.onChanged();
  };

  const doShare = async () => {
    const r = await shareBackup();
    await db.settings.update("app", { lastBackupAt: new Date().toISOString() });
    setMsg(r === "shared" ? "Backup shared from the Android share sheet." : "Share sheet not available — backup downloaded instead.");
    props.onChanged();
  };

  const doRestore = async (file: File, mode: "replace" | "merge") => {
    try {
      const data = JSON.parse(await file.text()) as BackupFile;
      const v = validateBackup(data);
      if (!v.ok) { setMsg(`Restore stopped: ${v.error}`); return; }
      if (!confirm(`Restore this backup? Counts: ${JSON.stringify(v.counts)}. Mode: ${mode}. Your current data is auto-saved as a download first.`)) return;
      await applyBackup(data, mode);
      setMsg("Restore done. Counts verified — check Trips and Expenses.");
      props.onChanged();
    } catch (e) { setMsg(`Restore failed: ${String(e)}`); }
  };

  const shownRoutes = routes.filter((r) => !routeQ || `${r.from} ${r.to}`.includes(routeQ.toLowerCase())).slice(0, 30);
  return (
    <main>
      <h2>Saved routes</h2>
      <p class="hint">{props.seedCount} saved routes (OSRM, checked 2026-11-09–10). Seed routes are read-only — your edits are stored separately and survive app updates.</p>
      <input type="text" placeholder="Search routes…" value={routeQ} onInput={(e) => setRouteQ((e.target as HTMLInputElement).value)} />
      {shownRoutes.map((r) => (
        <article class="card" key={r.id}>
          <b>{r.from} → {r.to}</b> · {r.km} km<br />
          <small>Source: {r.source}, checked {r.fetched_at}{r.verified_km ? ` · second source (Valhalla): ${r.verified_km} km (${r.deviation_pct}% different)` : ""}</small>
          {r.flag && <div class="warn">{r.flag}</div>}
          <button type="button" onClick={async () => {
            const v = prompt(`Edit km for ${r.from} → ${r.to} (current ${r.km} km). Enter the real road km:`);
            const n = v === null ? null : parseInput(v);
            if (n === null || n <= 0) return;
            await db.routeOverrides.put({ routeId: r.id, fromId: r.from, fromName: r.from, toId: r.to, toName: r.to, km: n, source: `User override, edited ${todayISO()}`, deleted: false, updatedAt: new Date().toISOString() });
            setMsg("Route override saved. Seed route unchanged.");
          }}>Edit km</button>
        </article>
      ))}

      <h2>Backup &amp; restore</h2>
      <p class="hint">Last backup: {props.settings?.lastBackupAt ? props.settings.lastBackupAt.slice(0, 10) : "never"}. Clearing browser data or uninstalling can delete your records — keep a backup copy outside this phone.</p>
      <p class="hint">Storage persistence: {props.settings?.persistenceGranted === true ? "granted by the browser" : props.settings?.persistenceGranted === false ? "NOT granted — the browser may clear data under storage pressure" : "unknown (not checked yet)"}.</p>
      <button type="button" onClick={doBackup}>Download backup (JSON)</button>{" "}
      <button type="button" onClick={doShare}>Share backup (Drive / WhatsApp)</button>{" "}
      <button type="button" onClick={async () => { await exportCsv("trips"); await exportCsv("expenses"); }}>Export CSVs</button>
      <label class="field"><span>Restore from backup file</span>
        <input type="file" accept="application/json,.json" onChange={async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) await doRestore(f, "replace"); }} />
      </label>
      <p class="hint">Restore validates the file and checksum first, previews counts, auto-saves your current data as a download, then applies Replace (or Merge via the file picker in the code — Replace is the default here).</p>
      {msg && <p class="ok">{msg}</p>}

      <h2>About</h2>
      <p class="hint">© OpenStreetMap contributors. Places and road distances: OpenStreetMap data via Nominatim, OSRM and Valhalla, fetched 2026-11-10. Coverage: 17,328 places (45 cities, 101 towns, 16,678 villages, 165 hamlets, 338 suburbs, 1 airport), 27,960 routes. No coverage % is claimed — a settlement missing from both OSM and GeoNames is still missing; see the coverage report in the repo. Tolls: 6 of 81 plazas have a verified official Car fare (Rs 100, effective 2026-07-10); other routes show "Fare not verified". Missing place? Add it as a custom place from the Quote screen and enter km manually.</p>
      <p class="hint">App version {APP_VERSION} · Schema v4 · No accounts, no tracking, no internet needed after install.</p>
    </main>
  );
}

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { calcQuote, calcSettlement, findDoubleCountedIds, parseInput, roundPKR, weekRangeMonSun, type QuoteInput } from "./lib/calc";
import { db, getSettings, requestPersistence, todayISO, uid, daysSince, APP_VERSION, type CarRow, type ExpenseRow, type SettingsRow, type TripRow } from "./lib/db";
import { loadPlaces, loadSeedRoutes, resolveRoute, liveLookupKm, routeId, type Place, type ResolvedRoute } from "./lib/routes";
import { searchPlaces } from "./lib/search";
import { applyBackup, buildBackup, exportCsv, shareBackup, validateBackup, type BackupFile } from "./lib/backup";
import { driveStatus } from "./lib/drive";

const fmtRs = (n: number) => `Rs ${Math.round(n).toLocaleString("en-PK")}`;
const fmtNum = (n: number | null) => (n === null ? "" : String(n));

function NumField(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; testId?: string }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input data-testid={props.testId} type="text" inputMode="decimal" autocomplete="off"
        value={props.value} placeholder={props.placeholder ?? ""}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} />
    </label>
  );
}

function PlacePicker(props: { label: string; places: Place[]; value: Place | null; onPick: (p: Place | null) => void; testId: string; autoFocus?: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [q, setQ] = useState("");
  const open = props.open;
  const setOpen = props.onOpenChange;
  const hits = useMemo(() => searchPlaces(q, props.places, 12), [q, props.places]);
  return (
    <div class="field">
      <span>{props.label}</span>
      <input data-testid={props.testId} type="text" autocomplete="off" autoFocus={props.autoFocus}
        value={open ? q : props.value ? props.value.name : q}
        placeholder="Type to search a place…"
        onFocus={() => { setQ(props.value ? props.value.name : ""); setOpen(true); }}
        onInput={(e) => { setQ((e.target as HTMLInputElement).value); setOpen(true); }} />
      {open && (
        <div class="picker">
          {hits.length === 0 && <div class="picker-empty">Not found — <button type="button" onClick={() => { setOpen(false); props.onPick(null); }}>add as custom place</button></div>}
          {hits.map((h) => (
            <button type="button" key={h.item.id} onClick={() => { props.onPick(h.item); setOpen(false); }}>
              {h.item.name} <small>{h.item.category}</small>
            </button>
          ))}
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
      await refresh();
      await requestPersistence();
    })();
  }, []);

  const car = cars[0] ?? null;
  const petrolAge = daysSince(settings?.petrolPriceSetOn ?? car?.petrolPriceSetOn ?? null);
  const stalePetrol = petrolAge !== null && petrolAge > (settings?.petrolStaleDays ?? 7);
  const backupAge = daysSince(settings?.lastBackupAt ? settings.lastBackupAt.slice(0, 10) : null);
  const backupStale = settings?.lastBackupAt == null || (backupAge !== null && backupAge >= 7);

  return (
    <div class="app">
      <header><h1>Car Calculator</h1><span>Chichawatni</span></header>
      {loadError && <div class="warn" role="alert">Could not load saved routes: {loadError}. Manual km entry still works.</div>}
      {backupStale && tab !== "more" && (
        <div class="warn" role="alert">No backup in 7 days. Go to More → Settings → Backup, and save a copy. Clearing browser data or uninstalling can delete your records.</div>
      )}
      {tab === "quote" && <QuoteScreen places={places} cars={cars} settings={settings} onSaved={refresh} />}
      {tab === "trips" && <TripsScreen trips={trips} onChanged={refresh} />}
      {tab === "expenses" && <ExpensesScreen expenses={expenses} cars={cars} onChanged={refresh} />}
      {tab === "settlements" && <SettlementsScreen trips={trips} expenses={expenses} cars={cars} settings={settings} onChanged={refresh} />}
      {tab === "more" && <MoreScreen places={places} settings={settings} cars={cars} seedCount={seedCount} stalePetrol={stalePetrol} petrolAge={petrolAge} onChanged={refresh} setTab={setTab} />}
      <nav class="bottombar" aria-label="Sections">
        <button class={tab === "quote" ? "active" : ""} onClick={() => setTab("quote")}>Quote</button>
        <button class={tab === "trips" ? "active" : ""} onClick={() => setTab("trips")}>Trips</button>
        <button class={tab === "expenses" ? "active" : ""} onClick={() => setTab("expenses")}>Expenses</button>
        <button class={tab === "settlements" ? "active" : ""} onClick={() => setTab("settlements")}>Settle</button>
        <button class={tab === "more" ? "active" : ""} onClick={() => setTab("more")}>More</button>
      </nav>
    </div>
  );
}

// ---------------- Quote ----------------

function QuoteScreen(props: { places: Place[]; cars: CarRow[]; settings: SettingsRow | null; onSaved: () => void }) {
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
  const [flatRent, setFlatRent] = useState("");
  const [toll, setToll] = useState("");
  const [other, setOther] = useState("");
  const [billToll, setBillToll] = useState(false);
  const [carId, setCarId] = useState("");
  const [note, setNote] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [customPlaceName, setCustomPlaceName] = useState("");
  const [openPicker, setOpenPicker] = useState<"from" | "to" | null>("from");
  const fromSet = useRef(false);

  useEffect(() => {
    if (!fromSet.current && chichawatni) { setFrom(chichawatni); fromSet.current = true; }
  }, [chichawatni]);
  useEffect(() => { if (cars[0] && !carId) {
    const c = cars[0]; setCarId(c.id);
    if (c.avgKmpl !== null) setKmpl(String(c.avgKmpl));
    if (c.petrolPricePerLitre !== null) setPetrol(String(c.petrolPricePerLitre));
    if (c.ratePerKm !== null) setRate(String(c.ratePerKm));
  } }, [cars]);

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

  const input: QuoteInput = {
    oneWayKm: parseInput(oneWay), isReturn,
    totalKmOverride: parseInput(totalOverride),
    avgKmpl: parseInput(kmpl), petrolPricePerLitre: parseInput(petrol),
    ratePerKm: parseInput(rate), flatRentOverride: parseInput(flatRent),
    toll: parseInput(toll), other: parseInput(other), billTollToCustomer: billToll,
  };
  const { result, errors } = calcQuote(input);
  const needsRates = parseInput(petrol) === null || parseInput(kmpl) === null || (parseInput(flatRent) === null && parseInput(rate) === null);

  const saveTrip = async () => {
    if (!result || !from || !to || !carId) return;
    const car = cars.find((c) => c.id === carId);
    const row: TripRow = {
      id: uid(), date: todayISO(), carId, carName: car?.name ?? "Car",
      fromId: from.id, fromName: from.name, toId: to.id, toName: to.name,
      oneWayKm: input.oneWayKm!, isReturn, totalKm: result.totalKm, kmOverridden: result.kmWasOverridden,
      routeSource: route ? route.sourceLabel : "Manual, entered by user",
      avgKmpl: input.avgKmpl!, petrolPricePerLitre: input.petrolPricePerLitre!,
      ratePerKm: input.ratePerKm ?? 0, flatRent: input.flatRentOverride,
      toll: parseInput(toll) ?? 0, other: parseInput(other) ?? 0, billTollToCustomer: billToll,
      fuelLitres: result.fuelLitres, fuelCost: result.fuelCost, customerRent: result.customerRent,
      totalQuote: result.totalQuote, estimatedSaving: result.estimatedSaving,
      note, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await db.trips.add(row);
    setSavedMsg(`Trip saved: ${from.name} → ${to.name}, ${fmtRs(result.totalQuote)}.`);
    props.onSaved();
  };

  const addCustomPlace = async () => {
    const name = customPlaceName.trim();
    if (!name) return;
    const id = `custom-${uid()}`;
    await db.placesCustom.add({ id, name, aliases: [], category: "custom", createdAt: new Date().toISOString() });
    setCustomPlaceName("");
    window.location.reload();
  };

  return (
    <main>
      {needsRates && (
        <div class="warn" role="alert">
          Set petrol price, km/L and rate/km first — go to More → Settings, or use “Load sample values” below.
          <button type="button" onClick={() => { setPetrol("270"); setKmpl("12"); setRate("60"); setSavedMsg("Sample values loaded — SAMPLE, edit them to your real rates."); }}>Load sample values</button>
        </div>
      )}
      <PlacePicker label="From" places={places} value={from} onPick={setFrom} testId="from-input" autoFocus open={openPicker === "from"} onOpenChange={(o) => setOpenPicker(o ? "from" : null)} />
      <PlacePicker label="To" places={places} value={to} onPick={setTo} testId="to-input" open={openPicker === "to"} onOpenChange={(o) => setOpenPicker(o ? "to" : null)} />
      {customPlaceName !== undefined && (
        <details>
          <summary>Not found — add as custom place</summary>
          <div class="row">
            <input type="text" value={customPlaceName} placeholder="Place name, e.g. Chak 112/12-L" onInput={(e) => setCustomPlaceName((e.target as HTMLInputElement).value)} />
            <button type="button" onClick={addCustomPlace}>Add place</button>
          </div>
          <p class="hint">After adding, enter the km manually. It is saved as a custom place.</p>
        </details>
      )}
      <div class="toggle" role="group" aria-label="One-way or return">
        <button type="button" class={!isReturn ? "active" : ""} onClick={() => setIsReturn(false)}>One-way</button>
        <button type="button" class={isReturn ? "active" : ""} onClick={() => setIsReturn(true)}>Return</button>
      </div>
      <NumField label="One-way km (from saved route)" value={oneWay} onChange={setOneWay} testId="oneway-km" />
      {route && <p class="hint" data-testid="route-source">{route.sourceLabel}{route.isOverride ? " (your override)" : ""}</p>}
      {routeMsg && <p class="hint">{routeMsg}</p>}
      <NumField label="Total km — edit to override (flagged on the trip)" value={totalOverride} onChange={setTotalOverride} placeholder={result ? String(result.totalKm) : "auto"} testId="total-km-override" />
      <label class="field"><span>Car</span>
        <select value={carId} onChange={(e) => setCarId((e.target as HTMLSelectElement).value)}>
          {cars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          {cars.length === 0 && <option value="">No car yet — add one in Settings</option>}
        </select>
      </label>
      <div class="grid2">
        <NumField label="Petrol Rs / litre" value={petrol} onChange={setPetrol} testId="petrol-price" />
        <NumField label="Average km / litre" value={kmpl} onChange={setKmpl} testId="kmpl" />
        <NumField label="Rate Rs / km" value={rate} onChange={setRate} testId="rate-per-km" />
        <NumField label="Flat rent Rs (optional, overrides rate)" value={flatRent} onChange={setFlatRent} testId="flat-rent" />
        <NumField label="Toll Rs" value={toll} onChange={setToll} testId="toll" />
        <NumField label="Other Rs" value={other} onChange={setOther} testId="other" />
      </div>
      <label class="check"><input type="checkbox" checked={billToll} onChange={(e) => setBillToll((e.target as HTMLInputElement).checked)} /> Bill toll to customer (adds toll to the quote total; it is then not counted as an expense)</label>
      <label class="field"><span>Note (optional)</span><input type="text" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>

      {errors.length > 0 && <div class="warn" role="alert">{errors.map((e) => e.message).join(". ")}</div>}
      {result && (
        <section class="result" aria-live="polite" data-testid="quote-result">
          <div><span>Total distance</span><b>{result.totalKm} km{result.kmWasOverridden ? " (overridden)" : ""}</b></div>
          <div><span>Fuel</span><b>{result.fuelLitresDisplay} L · {fmtRs(result.fuelCost)}</b></div>
          <div><span>Other expenses</span><b>{fmtRs(result.otherExpenses)}</b></div>
          <div><span>Customer rent</span><b>{fmtRs(result.customerRent)}</b></div>
          <div class="total"><span>Total quote</span><b>{fmtRs(result.totalQuote)}</b></div>
          <div><span>Estimated saving</span><b>{fmtRs(result.estimatedSaving)}</b></div>
        </section>
      )}
      <button type="button" class="primary" data-testid="save-trip" disabled={!result || !from || !to || !carId} onClick={saveTrip}>Save trip</button>
      {savedMsg && <p class="ok" role="status">{savedMsg}</p>}
    </main>
  );
}

// ---------------- Trips ----------------

function TripsScreen(props: { trips: TripRow[]; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const filtered = props.trips.filter((t) => !q || `${t.fromName} ${t.toName} ${t.carName} ${t.date}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <main>
      <input type="text" placeholder="Search trips…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <button type="button" onClick={async () => { await exportCsv("trips"); setMsg("Trips CSV downloaded."); }}>Export trips CSV</button>
      {msg && <p class="ok">{msg}</p>}
      {filtered.length === 0 && <p>No trips yet. Save one from the Quote screen.</p>}
      {filtered.map((t) => (
        <article class="card" key={t.id}>
          <b>{t.fromName} → {t.toName}</b> · {t.date} · {t.carName}<br />
          {t.totalKm} km ({t.isReturn ? "return" : "one-way"}) · Rent {fmtRs(t.customerRent)} · Fuel {fmtRs(t.fuelCost)} · Saving {fmtRs(t.estimatedSaving)}<br />
          <small>{t.routeSource}{t.kmOverridden ? " · km overridden" : ""}{t.note ? ` · ${t.note}` : ""}</small><br />
          <button type="button" onClick={async () => { if (confirm(`Delete trip ${t.fromName} → ${t.toName}?`)) { await db.trips.delete(t.id); props.onChanged(); } }}>Delete</button>
        </article>
      ))}
    </main>
  );
}

// ---------------- Expenses ----------------

function ExpensesScreen(props: { expenses: ExpenseRow[]; cars: CarRow[]; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseRow["category"]>("maintenance");
  const [note, setNote] = useState("");
  const [allowable, setAllowable] = useState(true);
  const [msg, setMsg] = useState("");
  const car = props.cars[0];
  const add = async () => {
    const a = parseInput(amount);
    if (a === null || a <= 0 || !car) { setMsg("Enter an amount above 0 and add a car first (Settings)."); return; }
    await db.expenses.add({ id: uid(), date: todayISO(), carId: car.id, carName: car.name, category, amount: roundPKR(a), allowable, note, createdAt: new Date().toISOString() });
    setAmount(""); setNote(""); setMsg("Expense saved.");
    props.onChanged();
  };
  return (
    <main>
      <h2>Add car expense</h2>
      <NumField label="Amount Rs" value={amount} onChange={setAmount} testId="expense-amount" />
      <label class="field"><span>Category</span>
        <select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value as ExpenseRow["category"])}>
          <option value="maintenance">Maintenance</option><option value="repair">Repair</option>
          <option value="oil">Oil</option><option value="tyre">Tyre</option>
          <option value="insurance">Insurance</option><option value="other">Other</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" checked={allowable} onChange={(e) => setAllowable((e.target as HTMLInputElement).checked)} /> Allowable in settlements (counts against income)</label>
      <label class="field"><span>Note</span><input type="text" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></label>
      <button type="button" class="primary" onClick={add}>Save expense</button>
      {msg && <p class="ok">{msg}</p>}
      <button type="button" onClick={async () => { await exportCsv("expenses"); }}>Export expenses CSV</button>
      {props.expenses.map((x) => (
        <article class="card" key={x.id}>
          <b>{fmtRs(x.amount)}</b> · {x.category} · {x.date} · {x.carName} · {x.allowable ? "allowable" : "not allowable"}{x.note ? ` · ${x.note}` : ""}<br />
          <button type="button" onClick={async () => { if (confirm("Delete this expense?")) { await db.expenses.delete(x.id); props.onChanged(); } }}>Delete</button>
        </article>
      ))}
    </main>
  );
}

// ---------------- Settlements ----------------

function SettlementsScreen(props: { trips: TripRow[]; expenses: ExpenseRow[]; cars: CarRow[]; settings: SettingsRow | null; onChanged: () => void }) {
  const [start, setStart] = useState(() => weekRangeMonSun(new Date()).start);
  const [end, setEnd] = useState(() => weekRangeMonSun(new Date()).end);
  const [driverName, setDriverName] = useState("");
  const [pct, setPct] = useState(props.settings?.driverPct !== null && props.settings?.driverPct !== undefined ? String(props.settings.driverPct) : "");
  const [carId, setCarId] = useState("");
  const [saved, setSaved] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [preset, setPreset] = useState("week");

  useEffect(() => { db.settlements.orderBy("createdAt").reverse().toArray().then(setSaved); }, [props.trips]);

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

  const inRange = props.trips.filter((t) => t.date >= start && t.date <= end && (!carId || t.carId === carId));
  const exInRange = props.expenses.filter((x) => x.date >= start && x.date <= end && (!carId || x.carId === carId));
  const settledTripIds = new Set(saved.flatMap((s) => s.tripIds));
  const settledExpIds = new Set(saved.flatMap((s) => s.expenseIds));
  const freshTrips = inRange.filter((t) => !settledTripIds.has(t.id));
  const freshExp = exInRange.filter((x) => !settledExpIds.has(x.id));
  const dupeCheck = findDoubleCountedIds(saved.map((s) => ({ tripIds: s.tripIds, expenseIds: s.expenseIds })));

  const income = freshTrips.reduce((s, t) => s + t.customerRent, 0);
  const tripFuel = freshTrips.reduce((s, t) => s + t.fuelCost, 0);
  // Toll counts as expense only when it was NOT billed to the customer.
  const tripToll = freshTrips.reduce((s, t) => s + (t.billTollToCustomer ? 0 : t.toll), 0);
  const carExp = freshExp.filter((x) => x.allowable).reduce((s, x) => s + x.amount, 0);
  const pctNum = parseInput(pct);
  const calc = pctNum !== null ? calcSettlement({ income, tripFuel, tripToll, carExpensesAllowable: carExp, driverPct: pctNum }) : null;
  const overlap = saved.filter((s) => s.driverName === driverName && driverName && !(end < s.startDate || start > s.endDate));

  const saveSettlement = async () => {
    if (!calc || pctNum === null || !driverName.trim()) { setMsg("Enter a driver name and a driver % first."); return; }
    const prev = saved[0];
    const row = {
      id: uid(), createdAt: new Date().toISOString(), startDate: start, endDate: end,
      carId: carId || null, driverName: driverName.trim(), driverPct: pctNum,
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
      <label class="field"><span>Driver name</span><input type="text" data-testid="driver-name" value={driverName} onInput={(e) => setDriverName((e.target as HTMLInputElement).value)} /></label>
      <NumField label="Driver % of net" value={pct} onChange={setPct} testId="driver-pct" />
      <label class="field"><span>Car</span>
        <select value={carId} onChange={(e) => setCarId((e.target as HTMLSelectElement).value)}>
          <option value="">All cars</option>
          {props.cars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {overlap.length > 0 && <div class="warn">Warning: this date range overlaps an earlier settlement for the same driver. Check before saving.</div>}
      {dupeCheck.length > 0 && <div class="warn">Data problem: {dupeCheck.length} trip/expense(s) appear in more than one settlement: {dupeCheck.join(", ")}. Do not save until this is fixed.</div>}
      <div class="result" data-testid="settlement-result">
        <div><span>Trips in range (not yet settled)</span><b>{freshTrips.length} · Income {fmtRs(income)}</b></div>
        <div><span>Trip fuel</span><b>{fmtRs(tripFuel)}</b></div>
        <div><span>Trip toll (not billed to customer)</span><b>{fmtRs(tripToll)}</b></div>
        <div><span>Allowable car expenses</span><b>{fmtRs(carExp)}</b></div>
        {calc && <>
          <div><span>Net</span><b>{fmtRs(calc.net)}</b></div>
          <div><span>Driver share ({pctNum}%)</span><b>{fmtRs(calc.driverShare)}</b></div>
          <div class="total"><span>Owner share</span><b>{fmtRs(calc.ownerShare)}</b></div>
          {calc.negativeNetWarning && <div class="warn">Warning: net is negative (expenses are more than income). Driver share is 0 by default — the owner absorbs the loss.</div>}
        </>}
      </div>
      <button type="button" class="primary" data-testid="save-settlement" disabled={!calc || dupeCheck.length > 0} onClick={saveSettlement}>Save settlement</button>
      {msg && <p class="ok">{msg}</p>}
      <h3>Saved settlements</h3>
      {saved.map((s) => {
        const current = props.trips.filter((t) => s.tripIds.includes(t.id));
        const changed = current.reduce((a, t) => a + t.customerRent, 0) !== s.snapshot.income;
        return (
          <article class="card" key={s.id}>
            <b>{s.driverName}</b> · {s.startDate} to {s.endDate}<br />
            Income {fmtRs(s.income)} · Net {fmtRs(s.net)} · Driver {fmtRs(s.driverShare)} ({s.driverPct}%) · Owner {fmtRs(s.ownerShare)}<br />
            <small>Snapshot saved {s.createdAt.slice(0, 10)} · {s.tripIds.length} trips, {s.expenseIds.length} expenses</small><br />
            {changed && <span class="warn">Source data changed since saved — Recalculate?</span>}
          </article>
        );
      })}
    </main>
  );
}

// ---------------- More: Routes + Settings ----------------

function MoreScreen(props: { places: Place[]; settings: SettingsRow | null; cars: CarRow[]; seedCount: number; stalePetrol: boolean; petrolAge: number | null; onChanged: () => void; setTab: (t: any) => void }) {
  const [routes, setRoutes] = useState<any[]>([]);
  const [routeQ, setRouteQ] = useState("");
  const [msg, setMsg] = useState("");
  const [carName, setCarName] = useState("");
  const [petrol, setPetrol] = useState("");
  const [kmpl, setKmpl] = useState("");
  const [rate, setRate] = useState("");
  const [driverPct, setDriverPct] = useState("");
  const [driveClientId, setDriveClientId] = useState(() => localStorage.getItem("drive_client_id") ?? "");
  const drive = driveStatus();

  useEffect(() => { loadSeedRoutes().then(setRoutes); }, []);
  useEffect(() => {
    const c = props.cars[0];
    if (c) { setCarName(c.name); setKmpl(c.avgKmpl !== null ? String(c.avgKmpl) : ""); setRate(c.ratePerKm !== null ? String(c.ratePerKm) : ""); setPetrol(c.petrolPricePerLitre !== null ? String(c.petrolPricePerLitre) : ""); }
    if (props.settings?.driverPct !== null && props.settings?.driverPct !== undefined) setDriverPct(String(props.settings.driverPct));
  }, [props.cars, props.settings]);

  const saveCar = async () => {
    const p = parseInput(petrol), k = parseInput(kmpl), r = parseInput(rate);
    const today = todayISO();
    if (props.cars[0]) {
      const c = props.cars[0];
      const history = [...(c.rateHistory ?? [])];
      if (r !== null && r !== c.ratePerKm) history.push({ effectiveFrom: today, ratePerKm: r, avgKmpl: k, petrolPricePerLitre: p });
      await db.cars.update(c.id, { name: carName.trim() || c.name, avgKmpl: k, petrolPricePerLitre: p, petrolPriceSetOn: p !== null ? today : c.petrolPriceSetOn, ratePerKm: r, rateHistory: history });
    } else {
      await db.cars.add({ id: uid(), name: carName.trim() || "Car 1", avgKmpl: k, petrolPricePerLitre: p, petrolPriceSetOn: p !== null ? today : null, ratePerKm: r, createdAt: new Date().toISOString(), rateHistory: r !== null ? [{ effectiveFrom: today, ratePerKm: r, avgKmpl: k, petrolPricePerLitre: p }] : [] });
    }
    const dp = parseInput(driverPct);
    await db.settings.update("app", { driverPct: dp, petrolPricePerLitre: p, petrolPriceSetOn: p !== null ? today : props.settings?.petrolPriceSetOn ?? null });
    setMsg("Car and rates saved. Old trips keep their old rates (snapshot).");
    props.onChanged();
  };

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
      <p class="hint">{props.seedCount} saved routes (OSRM, checked 2026-11-09). Seed routes are read-only — your edits are stored separately and survive app updates.</p>
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

      <h2>Settings — car &amp; rates</h2>
      <label class="field"><span>Car name</span><input type="text" value={carName} placeholder="e.g. GLI" onInput={(e) => setCarName((e.target as HTMLInputElement).value)} /></label>
      <div class="grid2">
        <NumField label="Petrol Rs / litre" value={petrol} onChange={setPetrol} testId="settings-petrol" />
        <NumField label="Average km / litre" value={kmpl} onChange={setKmpl} testId="settings-kmpl" />
        <NumField label="Rate Rs / km" value={rate} onChange={setRate} testId="settings-rate" />
        <NumField label="Driver % of net" value={driverPct} onChange={setDriverPct} testId="settings-driver-pct" />
      </div>
      {props.settings?.petrolPriceSetOn && <p class="hint">Petrol price set on {props.settings.petrolPriceSetOn} ({props.petrolAge ?? "?"} days old){props.stalePetrol ? " — AMBER WARNING: more than 7 days old. Update it before quoting." : ""}</p>}
      <button type="button" class="primary" data-testid="save-settings" onClick={saveCar}>Save car &amp; rates</button>
      {msg && <p class="ok">{msg}</p>}

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

      <h2>Google Drive</h2>
      <p class="hint">{drive.blocker ?? "Google Drive is configured."}</p>
      <label class="field"><span>Google OAuth Client ID (optional)</span>
        <input type="text" value={driveClientId} placeholder="Paste Client ID here" onInput={(e) => setDriveClientId((e.target as HTMLInputElement).value)} />
      </label>
      <button type="button" disabled={!drive.configured} onClick={() => setMsg("Google Drive upload is not implemented in this build — see the setup steps in README.")}>Upload backup to Google Drive</button>
      <button type="button" onClick={() => { localStorage.setItem("drive_client_id", driveClientId.trim()); setMsg(driveClientId.trim() ? "Client ID saved. Drive upload still needs the Google Cloud setup in README (Drive API + consent screen) and a real-account test." : "Client ID cleared."); }}>Save Client ID</button>
      <p class="hint">Free setup steps (owner, ~15 min): Google Cloud Console → new project → enable Drive API → OAuth consent screen (External, scope drive.file, add yourself as Test user) → Credentials → OAuth client ID (Web application, JavaScript origin = this site's origin). While in Testing mode, tokens expire after 7 days.</p>

      <h2>About</h2>
      <p class="hint">© OpenStreetMap contributors. Places and road distances: OpenStreetMap data via Nominatim, OSRM and Valhalla, fetched 2026-11-09. Coverage: 123 places (21 cities, 7 towns, 89 villages, 2 hamlets, 3 suburbs, 1 airport), 202 routes. Villages near Lahore, Islamabad, Faisalabad and Multan are NOT included yet (Overpass was at capacity) — see the coverage report in the repo. Missing place? Add it as a custom place from the Quote screen and enter km manually.</p>
      <p class="hint">App version {APP_VERSION} · Schema v3 · No accounts, no tracking, no internet needed after install.</p>
    </main>
  );
}

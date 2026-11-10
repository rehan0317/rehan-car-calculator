/** Dexie schema, versioned with tested migrations.
 *  Tables:
 *  - settings: single row (id='app'): petrol price + as-of date, driver %, stale-days, car defaults
 *  - cars: car profiles with rate history (effective dates)
 *  - trips: each row stores a SNAPSHOT of the rates used, so old trips never
 *    change when rates change. sourceId links to a route or 'manual'.
 *  - expenses: car expenses; `allowable` flags whether it counts in settlements
 *  - settlements: IMMUTABLE snapshots (inputs, percent, totals, trip/expense IDs)
 *  - settlementEdits: change log for settlement edits
 *  - routeOverrides: user edits, keyed by route ID — seed routes are read-only
 *    and live in the bundled JSON, never in this table, so app updates never
 *    overwrite user edits.
 *  - placesCustom: user-added places ("Not found - add as custom place")
 *  - meta: schema/app version + last backup info
 *  v4 adds (all start empty; v3 rows are left byte-identical by the migration):
 *  - drivers: saved driver names + per-driver default settlement %
 *  - placeAliases: user-added popular names for places (survive app updates)
 *  - tollPlazas: toll plazas with official Car-class fares (or unverified)
 *  - routeTolls: per-route plaza list + toll totals, keyed by routeId
 *  - placeUsage: most-used counts for search ordering
 *  v4 also adds settings.ratePerKm + ratePerKmSetOn (remembered from last
 *  use, with "as of <date>"), and TripRow gains optional tollPlazas /
 *  tollIncluded / extraCost. Old trips keep their stored v1 numbers: trips
 *  are snapshots by design and are never recomputed.
 */
import Dexie, { type Table } from "dexie";

export const SCHEMA_VERSION = 4;
export const APP_VERSION = "1.0.1";

export interface SettingsRow {
  id: string; // 'app'
  petrolPricePerLitre: number | null;
  petrolPriceSetOn: string | null; // YYYY-MM-DD
  petrolStaleDays: number; // default 7
  driverPct: number | null;
  defaultCarId: string | null;
  lastBackupAt: string | null; // ISO
  persistenceGranted: boolean | null;
  /** v4: rate/km remembered from last use (Quote screen), with its as-of date. */
  ratePerKm: number | null;
  ratePerKmSetOn: string | null; // YYYY-MM-DD
  /** v4: average km/L remembered from last use (Quote screen), with its
   *  as-of date. Stored in settings (not the car row) so it is remembered
   *  even on a fresh install with no car row at all. Optional: rows written
   *  before v2 (and the v3 migration fixture) simply lack these keys. */
  avgKmpl?: number | null;
  avgKmplSetOn?: string | null; // YYYY-MM-DD
}

export interface CarRow {
  id: string;
  name: string;
  avgKmpl: number | null;
  petrolPricePerLitre: number | null;
  petrolPriceSetOn: string | null;
  ratePerKm: number | null;
  createdAt: string;
  /** Rate history: { effectiveFrom: YYYY-MM-DD, ratePerKm, avgKmpl, petrolPricePerLitre } */
  rateHistory: Array<{ effectiveFrom: string; ratePerKm: number | null; avgKmpl: number | null; petrolPricePerLitre: number | null }>;
}

export interface TripRow {
  id: string;
  date: string; // YYYY-MM-DD
  carId: string;
  carName: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  oneWayKm: number;
  isReturn: boolean;
  totalKm: number;
  kmOverridden: boolean;
  routeSource: string; // e.g. "OSRM, checked 2026-11-09" | "Manual, edited 2026-11-09"
  avgKmpl: number;
  petrolPricePerLitre: number;
  ratePerKm: number;
  flatRent: number | null;
  toll: number;
  other: number;
  billTollToCustomer: boolean;
  fuelLitres: number;
  fuelCost: number;
  customerRent: number;
  totalQuote: number;
  estimatedSaving: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** v4 (optional — old trips are snapshots and never gain these fields):
   *  per-plaza toll breakdown as charged, whether toll was included in the
   *  bill, and any extra owner cost added at quote time. A plaza fare is
   *  null when it was unknown at save time — never 0 for an unknown fare. */
  tollPlazas?: Array<{ name: string; fare: number | null }>;
  tollIncluded?: boolean;
  extraCost?: number;
}

export type ExpenseCategory = "maintenance" | "repair" | "oil" | "tyre" | "insurance" | "other";

export interface ExpenseRow {
  id: string;
  date: string;
  carId: string;
  carName: string;
  category: ExpenseCategory;
  amount: number; // whole PKR
  allowable: boolean; // counts in settlements when true
  note: string;
  createdAt: string;
}

export interface SettlementRow {
  id: string;
  createdAt: string;
  startDate: string;
  endDate: string;
  carId: string | null; // null = all cars
  driverName: string;
  driverPct: number;
  income: number;
  tripFuel: number;
  tripToll: number;
  carExpensesAllowable: number;
  allowableExpenses: number;
  net: number;
  driverShare: number;
  ownerShare: number;
  tripIds: string[];
  expenseIds: string[];
  /** Snapshot inputs, so reopening shows exactly what was saved. */
  snapshot: { income: number; tripFuel: number; tripToll: number; carExpensesAllowable: number; driverPct: number };
  sourceChangedSinceSaved: boolean;
}

export interface SettlementEditRow {
  id: string;
  settlementId: string;
  at: string;
  change: string;
}

export interface RouteOverrideRow {
  routeId: string; // e.g. "chichawatni--lahore" or "custom:<uuid>"
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  km: number;
  source: string; // "Manual, edited <date>" | "User override, edited <date>"
  deleted: boolean; // soft-delete
  updatedAt: string;
}

export interface CustomPlaceRow {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  createdAt: string;
}

/** v4: drivers, saved by name (typed once). defaultPct is the per-driver
 *  settlement percent (default 30); settings.driverPct stays for migration
 *  compat only — the UI no longer uses the global value. */
export interface DriverRow {
  id: string;
  name: string;
  defaultPct: number; // default 30
  createdAt: string;
}

/** v4: user-added popular names for a place. Stored separately from the
 *  bundled seed so app updates never overwrite them. */
export interface PlaceAliasRow {
  id: string;
  placeId: string;
  alias: string;
  createdAt: string;
}

/** v4: a toll plaza with its official Car-class fares. fareBack defaults to
 *  fareOut; it differs only when the official tariff has a return-ticket
 *  fare. Null fare / verified=false = "Fare not verified — enter", never a guess. */
export interface TollPlazaRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  fareOut: number | null;
  fareBack: number | null;
  effectiveDate: string | null; // tariff effective date, YYYY-MM-DD
  sourceUrl: string | null;
  verified: boolean;
}

/** v4: tolls for one stored route (keyed by routeId). Km and toll belong to
 *  the same path; plazas are the ones actually crossed on that route.
 *  fareOut/fareBack are null when the fare is NOT verified/entered — never
 *  0: saving an empty fare as 0 would make the UI show "Rs 0" for an
 *  unknown fare. tollTotalOut/Back sum KNOWN fares only; the UI recomputes
 *  from the plaza list and shows "fare not verified" when any fare is null. */
export interface RouteTollRow {
  routeId: string; // key, e.g. "chichawatni--lahore"
  plazas: Array<{ plazaId: string; name: string; fareOut: number | null; fareBack: number | null; verified: boolean }>;
  tollTotalOut: number;
  tollTotalBack: number;
  asOf: string; // YYYY-MM-DD
  source: string;
}

/** v4: usage counts driving most-used-first search ordering. */
export interface PlaceUsageRow {
  placeId: string; // key
  count: number;
  lastUsed: string; // ISO
}

export interface MetaRow {
  id: string;
  value: string;
}

export class CarDB extends Dexie {
  settings!: Table<SettingsRow, string>;
  cars!: Table<CarRow, string>;
  trips!: Table<TripRow, string>;
  expenses!: Table<ExpenseRow, string>;
  settlements!: Table<SettlementRow, string>;
  settlementEdits!: Table<SettlementEditRow, string>;
  routeOverrides!: Table<RouteOverrideRow, string>;
  placesCustom!: Table<CustomPlaceRow, string>;
  meta!: Table<MetaRow, string>;
  drivers!: Table<DriverRow, string>;
  placeAliases!: Table<PlaceAliasRow, string>;
  tollPlazas!: Table<TollPlazaRow, string>;
  routeTolls!: Table<RouteTollRow, string>;
  placeUsage!: Table<PlaceUsageRow, string>;

  constructor(name = "car-calculator") {
    super(name);
    // v1: base schema
    this.version(1).stores({
      settings: "id",
      cars: "id, name",
      trips: "id, date, carId",
      expenses: "id, date, carId",
      settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId",
      routeOverrides: "routeId",
      placesCustom: "id, name",
      meta: "id",
    });
    // v2: index trips/expenses by date+car for settlement filters; add updatedAt
    this.version(2).stores({
      settings: "id",
      cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId",
      routeOverrides: "routeId",
      placesCustom: "id, name",
      meta: "id",
    }).upgrade(async (tx) => {
      // v1 -> v2: backfill updatedAt on trips that lack it (populated-DB migration)
      const trips = await tx.table("trips").toArray();
      for (const t of trips) {
        if (!t.updatedAt) await tx.table("trips").update(t.id, { updatedAt: t.createdAt ?? new Date().toISOString() });
      }
    });
    // v3: index settlements.createdAt (H7 hostile test caught orderBy on a
    // non-indexed field throwing, so the saved-settlements list never loaded
    // and settled trips looked "not yet settled" — a double-settle risk).
    this.version(3).stores({
      settings: "id",
      cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId, createdAt",
      settlementEdits: "id, settlementId",
      routeOverrides: "routeId",
      placesCustom: "id, name",
      meta: "id",
    });
    // v4: NEW tables only — drivers, placeAliases, tollPlazas, routeTolls,
    // placeUsage. Every v3 table keeps its exact v3 schema. The upgrade
    // deliberately touches NO v3 row: new tables start empty, old rows stay
    // byte-identical (trips are snapshots; old stored numbers are never
    // recomputed). Settings rows keep driverPct for compat; ratePerKm /
    // ratePerKmSetOn / avgKmpl / avgKmplSetOn are only set on fresh rows
    // or by the UI going forward (never by the migration itself).
    this.version(4).stores({
      settings: "id",
      cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId, createdAt",
      settlementEdits: "id, settlementId",
      routeOverrides: "routeId",
      placesCustom: "id, name",
      meta: "id",
      drivers: "id, name",
      placeAliases: "id, placeId",
      tollPlazas: "id, name",
      routeTolls: "routeId",
      placeUsage: "placeId",
    }).upgrade(async () => {
      // No-op by design: Dexie creates the new (empty) tables from the
      // stores() definition above. No v3 row is read, written, or deleted.
    });
  }
}

export const db = new CarDB();

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function getSettings(): Promise<SettingsRow> {
  const s = await db.settings.get("app");
  if (s) return s;
  const fresh: SettingsRow = {
    id: "app", petrolPricePerLitre: null, petrolPriceSetOn: null, petrolStaleDays: 7,
    driverPct: null, defaultCarId: null, lastBackupAt: null, persistenceGranted: null,
    ratePerKm: null, ratePerKmSetOn: null,
    avgKmpl: null, avgKmplSetOn: null,
  };
  await db.settings.put(fresh);
  return fresh;
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    const granted = await navigator.storage.persist();
    await db.settings.update("app", { persistenceGranted: granted });
    return granted;
  } catch {
    return null;
  }
}

/** Days since a YYYY-MM-DD date (null when no date). */
export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const then = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

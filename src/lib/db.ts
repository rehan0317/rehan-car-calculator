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
 */
import Dexie, { type Table } from "dexie";

export const SCHEMA_VERSION = 3;
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

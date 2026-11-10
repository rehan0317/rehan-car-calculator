import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { CarDB, SCHEMA_VERSION, db, getSettings } from "./db";
import { validateBackup, checksumOf, applyBackup, type BackupFile } from "./backup";

/** Real DB migration test: create a v1-only DB, populate it, close it, then
 *  open the same name with CarDB (v1+v2) — Dexie must run the v2 upgrade,
 *  keep the trips, and backfill updatedAt. */

class V1DB extends Dexie {
  trips!: Dexie.Table<any, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      settings: "id", cars: "id, name", trips: "id, date, carId",
      expenses: "id, date, carId", settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
  }
}

describe("schema migration v1 -> v2 on a populated DB", () => {
  it("keeps existing trips and backfills updatedAt", async () => {
    const name = "mig-test-v1";
    await CarDB.delete(name).catch(() => undefined);
    const v1 = new V1DB(name);
    await v1.open();
    await v1.trips.add({
      id: "t-old", date: "2026-11-01", carId: "c1", carName: "Car 1",
      fromId: "chichawatni", fromName: "Chichawatni", toId: "lahore", toName: "Lahore",
      oneWayKm: 236.35, isReturn: true, totalKm: 472.7, kmOverridden: false,
      routeSource: "OSRM, checked 2026-11-09", avgKmpl: 12, petrolPricePerLitre: 270,
      ratePerKm: 60, flatRent: null, toll: 500, other: 0, billTollToCustomer: false,
      fuelLitres: 39.39, fuelCost: 10636, customerRent: 28362, totalQuote: 28362,
      estimatedSaving: 17226, note: "", createdAt: "2026-11-01T10:00:00.000Z",
      // NOTE: no updatedAt field at all — v1 had no such column.
    });
    v1.close();

    const v2 = new CarDB(name);
    await v2.open();
    const after = await v2.trips.get("t-old");
    expect(after?.customerRent).toBe(28362);
    expect(after?.updatedAt).toBeTruthy();
    expect(v2.verno).toBe(SCHEMA_VERSION);
    v2.close();
    await CarDB.delete(name);
  });
});

describe("backup validation", () => {
  it("checksum matches a good file; a tampered amount fails validation", () => {
    const tables: Record<string, unknown[]> = {
      trips: [{ id: "t1", customerRent: 2834 }],
      settings: [], cars: [], expenses: [], settlements: [],
      settlementEdits: [], routeOverrides: [], placesCustom: [], meta: [],
    };
    const file = {
      app: "chichawatni-car-calculator", appVersion: "1.0.0",
      schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(),
      checksum: checksumOf(tables), tables,
    };
    expect(validateBackup(file).ok).toBe(true);
    expect(validateBackup(file).counts?.trips).toBe(1);
    const tampered = JSON.parse(JSON.stringify(file));
    tampered.tables.trips[0].customerRent = 999999;
    expect(validateBackup(tampered).ok).toBe(false);
    expect(validateBackup(tampered).error).toMatch(/Checksum mismatch/);
    const wrongApp = { ...file, app: "something-else" };
    expect(validateBackup(wrongApp).ok).toBe(false);
  });
});

/** Real DB migration test v3 -> v4: create a v3-only DB, populate EVERY v3
 *  table with several realistic rows, close it, then open the same name
 *  with CarDB (v4) — Dexie must run the v4 upgrade, lose ZERO rows, change
 *  NO v3 field value, and create the five new tables empty. */

class V3DB extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      settings: "id", cars: "id, name", trips: "id, date, carId",
      expenses: "id, date, carId", settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
    this.version(2).stores({
      settings: "id", cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    }).upgrade(async (tx) => {
      const trips = await tx.table("trips").toArray();
      for (const t of trips) {
        if (!t.updatedAt) await tx.table("trips").update(t.id, { updatedAt: t.createdAt ?? new Date().toISOString() });
      }
    });
    this.version(3).stores({
      settings: "id", cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId, createdAt",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
  }
}

/** Populated v3 fixture — v3 SHAPE only: no ratePerKm on settings, no
 *  tollPlazas/tollIncluded/extraCost on trips, no v4 tables. */
function v3Fixture(): Record<string, unknown[]> {
  return {
    settings: [{
      id: "app", petrolPricePerLitre: 270, petrolPriceSetOn: "2026-11-09",
      petrolStaleDays: 7, driverPct: 30, defaultCarId: "c-gli",
      lastBackupAt: null, persistenceGranted: true,
    }],
    cars: [
      { id: "c-gli", name: "GLI", avgKmpl: 12, petrolPricePerLitre: 270, petrolPriceSetOn: "2026-11-09", ratePerKm: 60, createdAt: "2026-11-01T09:00:00.000Z", rateHistory: [{ effectiveFrom: "2026-11-01", ratePerKm: 60, avgKmpl: 12, petrolPricePerLitre: 270 }] },
      { id: "c-xli", name: "XLI", avgKmpl: 11, petrolPricePerLitre: 265, petrolPriceSetOn: "2026-11-05", ratePerKm: 55, createdAt: "2026-11-05T09:00:00.000Z", rateHistory: [] },
    ],
    trips: [
      { id: "t-1", date: "2026-11-02", carId: "c-gli", carName: "GLI", fromId: "chichawatni", fromName: "Chichawatni", toId: "lahore", toName: "Lahore", oneWayKm: 236.35, isReturn: true, totalKm: 472.7, kmOverridden: false, routeSource: "OSRM, checked 2026-11-09", avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60, flatRent: null, toll: 500, other: 0, billTollToCustomer: true, fuelLitres: 39.39, fuelCost: 10636, customerRent: 28362, totalQuote: 28862, estimatedSaving: 17226, note: "Airport drop", createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" },
      { id: "t-2", date: "2026-11-03", carId: "c-gli", carName: "GLI", fromId: "chichawatni", fromName: "Chichawatni", toId: "sahiwal", toName: "Sahiwal", oneWayKm: 32.1, isReturn: false, totalKm: 32.1, kmOverridden: false, routeSource: "OSRM, checked 2026-11-09", avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60, flatRent: null, toll: 0, other: 200, billTollToCustomer: false, fuelLitres: 2.675, fuelCost: 722, customerRent: 1926, totalQuote: 1926, estimatedSaving: 1004, note: "", createdAt: "2026-11-03T11:00:00.000Z", updatedAt: "2026-11-03T11:00:00.000Z" },
      { id: "t-3", date: "2026-11-04", carId: "c-xli", carName: "XLI", fromId: "chichawatni", fromName: "Chichawatni", toId: "okara", toName: "Okara", oneWayKm: 48.7, isReturn: true, totalKm: 97.4, kmOverridden: true, routeSource: "Manual, edited 2026-11-04", avgKmpl: 11, petrolPricePerLitre: 265, ratePerKm: 55, flatRent: 6000, toll: 0, other: 0, billTollToCustomer: false, fuelLitres: 8.85, fuelCost: 2346, customerRent: 6000, totalQuote: 6000, estimatedSaving: 3654, note: "Flat rent", createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z" },
    ],
    expenses: [
      { id: "e-1", date: "2026-11-02", carId: "c-gli", carName: "GLI", category: "oil", amount: 4500, allowable: true, note: "Engine oil", createdAt: "2026-11-02T18:00:00.000Z" },
      { id: "e-2", date: "2026-11-03", carId: "c-gli", carName: "GLI", category: "tyre", amount: 12000, allowable: true, note: "Puncture + tube", createdAt: "2026-11-03T18:00:00.000Z" },
      { id: "e-3", date: "2026-11-05", carId: "c-xli", carName: "XLI", category: "other", amount: 800, allowable: false, note: "Car wash", createdAt: "2026-11-05T18:00:00.000Z" },
    ],
    settlements: [{
      id: "s-1", createdAt: "2026-11-08T10:00:00.000Z", startDate: "2026-11-02", endDate: "2026-11-08",
      carId: null, driverName: "Ahmed", driverPct: 30, income: 50000, tripFuel: 12000, tripToll: 500,
      carExpensesAllowable: 3000, allowableExpenses: 15500, net: 34500, driverShare: 10350, ownerShare: 24150,
      tripIds: ["t-1", "t-2"], expenseIds: ["e-1"],
      snapshot: { income: 50000, tripFuel: 12000, tripToll: 500, carExpensesAllowable: 3000, driverPct: 30 },
      sourceChangedSinceSaved: false,
    }],
    settlementEdits: [
      { id: "se-1", settlementId: "s-1", at: "2026-11-08T11:00:00.000Z", change: "driverPct 25 -> 30" },
      { id: "se-2", settlementId: "s-1", at: "2026-11-08T11:05:00.000Z", change: "note added" },
    ],
    routeOverrides: [
      { routeId: "chichawatni--sahiwal", fromId: "chichawatni", fromName: "Chichawatni", toId: "sahiwal", toName: "Sahiwal", km: 33, source: "Manual, edited 2026-11-03", deleted: false, updatedAt: "2026-11-03T12:00:00.000Z" },
      { routeId: "chichawatni--old-place", fromId: "chichawatni", fromName: "Chichawatni", toId: "old-place", toName: "Old Place", km: 10, source: "Manual, edited 2026-11-01", deleted: true, updatedAt: "2026-11-01T12:00:00.000Z" },
    ],
    placesCustom: [
      { id: "custom-1", name: "Chak 112/12-L", aliases: ["112 wala chak"], category: "custom", createdAt: "2026-11-06T09:00:00.000Z" },
      { id: "custom-2", name: "Basti Noor Shah", aliases: [], category: "custom", createdAt: "2026-11-07T09:00:00.000Z" },
    ],
    meta: [{ id: "installedAt", value: "2026-11-01T09:00:00.000Z" }],
  };
}

const V3_TABLES = ["settings", "cars", "trips", "expenses", "settlements", "settlementEdits", "routeOverrides", "placesCustom", "meta"] as const;
const V4_TABLES = ["drivers", "placeAliases", "tollPlazas", "routeTolls", "placeUsage"] as const;

async function populateV3(name: string, fixture: Record<string, unknown[]>): Promise<void> {
  const v3 = new V3DB(name);
  await v3.open();
  for (const t of V3_TABLES) {
    if (fixture[t].length) await (v3 as any)[t].bulkAdd(fixture[t]);
  }
  v3.close();
}

describe("schema migration v3 -> v4 on a populated DB", () => {
  it("keeps every v3 row byte-identical and creates the new tables empty", async () => {
    const name = "mig-test-v3";
    const fixture = v3Fixture();
    await CarDB.delete(name).catch(() => undefined);
    await populateV3(name, fixture);

    const v4 = new CarDB(name);
    await v4.open();
    expect(v4.verno).toBe(4);
    expect(v4.verno).toBe(SCHEMA_VERSION);

    // Zero row loss: identical counts in every v3 table...
    for (const t of V3_TABLES) {
      expect(await (v4 as any)[t].count(), `${t} count changed`).toBe(fixture[t].length);
    }
    // ...and identical field values (deep-equal against the fixture rows).
    for (const t of V3_TABLES) {
      const after = await (v4 as any)[t].toArray();
      const before = [...fixture[t]].sort((a: any, b: any) => String(a.id ?? a.routeId).localeCompare(String(b.id ?? b.routeId)));
      const sortedAfter = [...after].sort((a: any, b: any) => String(a.id ?? a.routeId).localeCompare(String(b.id ?? b.routeId)));
      expect(sortedAfter).toEqual(before);
    }
    // Old trips keep their v1 stored numbers (snapshots, never recomputed)
    // and gain NO v4 fields.
    const trip1 = await v4.trips.get("t-1");
    expect(trip1?.totalQuote).toBe(28862);
    expect(trip1?.estimatedSaving).toBe(17226);
    expect("tollPlazas" in trip1!).toBe(false);
    expect("tollIncluded" in trip1!).toBe(false);
    expect("extraCost" in trip1!).toBe(false);
    // Settings row gains NO ratePerKm key from the migration itself.
    const settings = await v4.settings.get("app");
    expect(settings?.petrolPricePerLitre).toBe(270);
    expect(settings?.driverPct).toBe(30);
    expect("ratePerKm" in settings!).toBe(false);
    expect("ratePerKmSetOn" in settings!).toBe(false);
    // New tables exist and start empty.
    for (const t of V4_TABLES) {
      expect(await (v4 as any)[t].count(), `${t} should start empty`).toBe(0);
    }
    v4.close();
    await CarDB.delete(name);
  });
});

describe("backup v3 -> v4 restore", () => {
  it("a v3 backup validates and restores cleanly into the v4 app; new tables stay empty", async () => {
    const fixture = v3Fixture();
    const file: BackupFile = {
      app: "chichawatni-car-calculator", appVersion: "1.0.1",
      schemaVersion: 3, exportedAt: "2026-11-09T10:00:00.000Z",
      checksum: checksumOf(fixture), tables: fixture,
    };
    // validateBackup ACCEPTS schema v3 (only newer-than-app is rejected).
    const v = validateBackup(file);
    expect(v.ok).toBe(true);
    expect(v.counts?.trips).toBe(3);
    expect(v.counts?.drivers).toBe(0); // v3 file has no v4 tables
    expect(v.counts?.routeTolls).toBe(0);

    // Restore into the v4 app (replace mode): all v3 rows land, v4 tables empty.
    await CarDB.delete("car-calculator").catch(() => undefined);
    await applyBackup(file, "replace");
    for (const t of V3_TABLES) {
      expect(await (db as any)[t].count(), `${t} count after restore`).toBe(fixture[t].length);
    }
    for (const t of V4_TABLES) {
      expect(await (db as any)[t].count(), `${t} should stay empty after v3 restore`).toBe(0);
    }
    const trip = await db.trips.get("t-1");
    expect(trip?.totalQuote).toBe(28862);
    expect(trip?.customerRent).toBe(28362);
    const settings = await db.settings.get("app");
    expect(settings?.petrolPricePerLitre).toBe(270);
    db.close();
    await CarDB.delete("car-calculator").catch(() => undefined);
  });
});

describe("settings remember avg km/L (v2, no car row needed)", () => {
  // Runs LAST in this file: it closes the shared singleton db, so no later
  // test in this file may use it (the backup-restore test above needs it).
  it("fresh settings row has avgKmpl null; a UI-style update persists it with its as-of date", async () => {
    await CarDB.delete("car-calculator").catch(() => undefined);
    await db.open(); // the backup-restore test above closes the shared singleton
    const fresh = await getSettings();
    expect(fresh.avgKmpl).toBe(null);
    expect(fresh.avgKmplSetOn).toBe(null);
    // Same update persistKmpl in App.tsx does (settings first, no car row).
    await db.settings.update("app", { avgKmpl: 12, avgKmplSetOn: "2026-11-10" });
    const after = await getSettings();
    expect(after.avgKmpl).toBe(12);
    expect(after.avgKmplSetOn).toBe("2026-11-10");
    db.close();
    await CarDB.delete("car-calculator").catch(() => undefined);
  });
});

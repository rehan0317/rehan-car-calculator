import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { CarDB, SCHEMA_VERSION } from "./db";
import { validateBackup, checksumOf } from "./backup";

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

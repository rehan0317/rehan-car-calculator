import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gotoClean, pickTo, setRates, openTollSheet, expectNoHorizontalScroll, expectResultCardVisible } from "./helpers";

/** v2 flows: toll sheet, alias search, add place, settlement vector,
 *  expenses guard, stale-price / tariff-age warnings, VERIFY flags,
 *  v3->v4 migration in real Chromium, search timing. */

test.beforeEach(async ({ page }, testInfo) => {
  // The migration test seeds its own v3 DB from a blank page — the shared
  // clean-load would create a v4 DB first and block the seed.
  if (testInfo.title.includes("migration v3")) return;
  await gotoClean(page);
});

test("(d) toll sheet: Multan verified plaza + Lahore unverified plazas + chevron", async ({ page }) => {
  // Multan: 1 verified plaza, Rs 100, asOf 2026-07-10.
  await pickTo(page, "Multan");
  await setRates(page);
  await expect(page.getByTestId("toll-row")).toContainText("1 plaza - Rs 100");
  await expect(page.locator(".tollrow-main .chev")).toBeVisible();
  await openTollSheet(page);
  await expect(page.getByTestId("toll-sheet")).toContainText("Unnamed toll plaza");
  await expect(page.getByTestId("toll-sheet")).toContainText("Verified");
  await expect(page.getByTestId("toll-sheet-total")).toContainText("Rs 100");
  await expect(page.getByTestId("toll-sheet-total")).toContainText("Rs 200"); // return total
  await page.getByRole("button", { name: "Close without saving" }).click();

  // Lahore: 5 plazas, none verified — per-plaza "Fare not verified", no Rs 0.
  await pickTo(page, "Lahore");
  await openTollSheet(page);
  const sheet = page.getByTestId("toll-sheet");
  await expect(sheet).toContainText("Fare not verified - enter");
  await expect(sheet).not.toContainText("Rs 0");
  await expect(page.getByTestId("toll-sheet-total")).toContainText("fare not verified");
  await expect(page.getByTestId("toll-sheet-total")).toContainText("have no fare yet");
  await expectNoHorizontalScroll(page);
});

test("(d2) saving tolls with NO fares entered keeps 'Fare not verified', never Rs 0", async ({ page }) => {
  await pickTo(page, "Lahore");
  await setRates(page);
  await openTollSheet(page);
  await page.getByTestId("save-tolls").click();
  await expect(page.getByTestId("toll-row")).toContainText("fare not verified");
  await expect(page.getByTestId("toll-row")).not.toContainText("Rs 0");
  await expect(page.getByTestId("quote-result")).toContainText("not verified");
  // The override is persisted with null fares — reload must not turn it to Rs 0.
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await pickTo(page, "Lahore");
  await expect(page.getByTestId("toll-row")).toContainText("fare not verified");
  await expect(page.getByTestId("toll-row")).not.toContainText("Rs 0");
});

test("(e) alias search: '112' finds Chak 112/12L; 'Add popular name' works", async ({ page }) => {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("112");
  await expect(page.locator(".picker", { hasText: "Chak No 112/12.L" })).toBeVisible();
  await page.locator(".picker button", { hasText: "Chak No 112/12.L" }).first().click();
  await expect(page.getByTestId("total-km-override")).toHaveValue("18.4", { timeout: 10_000 }); // 9.2 km x 2 (seed route chichawatni--osm-4427361666)

  // Add a popular name for it, then find it by that name.
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("112");
  await page.locator(".picker-row", { hasText: "Chak No 112/12.L" }).locator(".mini").click();
  await page.locator(".alias-form input").fill("Bara Chak");
  await page.locator(".alias-form button", { hasText: "Save" }).click();
  await expect(page.getByText(/Popular name "Bara Chak" saved/)).toBeVisible();
  await page.getByTestId("to-input").fill("Bara");
  await expect(page.locator(".picker", { hasText: "Chak No 112/12.L" })).toBeVisible();
});

test("(l) Add place: name + km, then it quotes", async ({ page }) => {
  await page.getByText("Not found — add as custom place").click();
  await page.getByPlaceholder("Place name, e.g. Chak 112/12-L").fill("Test Chak 999");
  await page.getByPlaceholder("Km from Chichawatni").fill("25");
  await page.getByRole("button", { name: "Add place" }).click();
  await expect(page.getByText("Place added. Pick it in the To field.")).toBeVisible();
  await pickTo(page, "Test Chak 999");
  await expect(page.getByTestId("total-km-override")).toHaveValue("50", { timeout: 10_000 }); // 25 km x 2
});

test("(j) settlement spec vector: 50000 / 12000 / 3000 -> driver 10500, owner 24500", async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  await page.evaluate((date) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("car-calculator");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(["trips", "expenses"], "readwrite");
        tx.objectStore("trips").put({
          id: "sv-trip", date, carId: "", carName: "", fromId: "chichawatni", fromName: "Chichawatni",
          toId: "lahore", toName: "Lahore", oneWayKm: 236.35, isReturn: true, totalKm: 472.7,
          kmOverridden: false, routeSource: "Seeded vector", avgKmpl: 12, petrolPricePerLitre: 270,
          ratePerKm: 60, flatRent: null, toll: 0, other: 0, billTollToCustomer: true,
          fuelLitres: 39.39, fuelCost: 12000, customerRent: 50000, totalQuote: 50000,
          estimatedSaving: 38000, note: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        tx.objectStore("expenses").put({
          id: "sv-exp", date, carId: "", carName: "", category: "other", amount: 3000,
          allowable: true, note: "Vector expense", createdAt: new Date().toISOString(),
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, today);
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await page.getByRole("button", { name: "Settlement", exact: true }).click();
  await page.getByTestId("driver-name").fill("Vector Driver");
  await page.getByTestId("driver-pct").fill("30");
  const s = page.getByTestId("settlement-result");
  await expect(s).toContainText("Rs 50,000"); // total earned
  await expect(s).toContainText("Rs 15,000"); // expenses 12000 + 3000
  await expect(s).toContainText("Rs 35,000"); // net
  await expect(s).toContainText("Rs 10,500"); // driver gets
  await expect(s).toContainText("Rs 24,500"); // owner keeps
  // driver + owner === net exactly (10500 + 24500 = 35000).
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
  await page.getByText("History").click();
  await expect(page.locator("main")).toContainText("Vector Driver");
  await expect(page.locator("main")).toContainText("Rs 10,500");
});

test("(k) expenses double-count guard: no fuel/toll category exists", async ({ page }) => {
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  const options = await page.locator("select option").allTextContents();
  expect(options).toEqual(["Maintenance", "Repair", "Oil", "Tyre", "Insurance", "Other"]);
  await expect(page.locator("main")).toContainText("Trip fuel and toll are never entered here");
  await page.getByTestId("expense-amount").fill("4500");
  await page.locator("select").selectOption("oil");
  await page.getByRole("button", { name: "Save expense" }).click();
  await expect(page.getByText("Expense saved.")).toBeVisible();
  await expect(page.locator("main")).toContainText("Rs 4,500");
});

test("stale petrol price (30 days old) shows age + warning", async ({ page }) => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const old = d.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  await page.evaluate(({ oldDate, todayDate }) => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("car-calculator");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("settings", "readwrite");
        tx.objectStore("settings").put({
          id: "app", petrolPricePerLitre: 250, petrolPriceSetOn: oldDate, petrolStaleDays: 7,
          driverPct: null, defaultCarId: null, lastBackupAt: null, persistenceGranted: null,
          ratePerKm: 60, ratePerKmSetOn: todayDate, avgKmpl: 12, avgKmplSetOn: todayDate,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, { oldDate: old, todayDate: today });
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await expect(page.getByTestId("petrol-price")).toHaveValue("250");
  await expect(page.locator("main")).toContainText(`as of ${old}`);
  await expect(page.locator("main")).toContainText("more than 7 days old");
});

test("tariff date shown, amber when older than 90 days (Multan, eff. 2026-07-10)", async ({ page }) => {
  await pickTo(page, "Multan");
  await expect(page.locator("main")).toContainText("Toll rates as of 2026-07-10");
  await expect(page.locator("main")).toContainText("more than 90 days");
  await openTollSheet(page);
  await expect(page.getByTestId("toll-sheet")).toContainText("Toll rates as of 2026-07-10");
  await expect(page.getByTestId("toll-sheet")).toContainText("more than 90 days");
});

test("flagged routes show VERIFY WITH ODOMETER on Quote and in More", async ({ page }) => {
  await pickTo(page, "Sargodha");
  await expect(page.getByTestId("route-flag")).toContainText("VERIFY WITH ODOMETER");
  await expect(page.getByTestId("route-flag")).toContainText("339.28 km");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByPlaceholder("Search routes…").fill("sargodha");
  await expect(page.locator(".card", { hasText: "chichawatni → sargodha" })).toContainText("VERIFY WITH ODOMETER");
});

test("no car name anywhere in the rendered UI", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("GLI");
  expect(bodyText).not.toContain("XLI");
  expect(bodyText).not.toContain("Mehran");
  expect(bodyText).not.toContain("Cultus");
});

test("search '112' over 17,328 places is fast (timed)", async ({ page }) => {
  const t0 = Date.now();
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("112");
  await expect(page.locator(".picker-row").first()).toBeVisible({ timeout: 10_000 });
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: "search-112-ms", description: `${ms} ms (type 112 -> first picker row)` });
  console.log(`search "112": ${ms} ms`);
  expect(ms).toBeLessThan(2000);
});

test("(h) migration v3 -> v4 in real Chromium: 0 row loss, old trips NOT recomputed", async ({ page, context }) => {
  // Seed a populated v3 DB from a blank same-origin page (JS blocked so the
  // app never opens the DB first), then load the app and let Dexie migrate.
  const pageB = await context.newPage();
  await pageB.route("**/*.js", (route) => route.abort());
  await pageB.goto("/");
  await pageB.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("car-calculator");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("delete blocked"));
    });
  });
  const dexieSrc = readFileSync("node_modules/dexie/dist/dexie.min.js", "utf-8");
  await pageB.evaluate((src) => {
    (0, eval)(src);
    return typeof (window as any).Dexie;
  }, dexieSrc);
  await pageB.evaluate(async () => {
    const Dexie = (window as any).Dexie;
    const v3 = new Dexie("car-calculator");
    v3.version(1).stores({
      settings: "id", cars: "id, name", trips: "id, date, carId",
      expenses: "id, date, carId", settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
    v3.version(2).stores({
      settings: "id", cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
    v3.version(3).stores({
      settings: "id", cars: "id, name",
      trips: "id, date, carId, [date+carId]",
      expenses: "id, date, carId, [date+carId]",
      settlements: "id, startDate, endDate, carId, createdAt",
      settlementEdits: "id, settlementId", routeOverrides: "routeId",
      placesCustom: "id, name", meta: "id",
    });
    await v3.open();
    // v3 SHAPE only: no ratePerKm on settings, no v4 fields on trips.
    await v3.table("settings").put({
      id: "app", petrolPricePerLitre: 270, petrolPriceSetOn: "2026-11-09",
      petrolStaleDays: 7, driverPct: 30, defaultCarId: "c-gli",
      lastBackupAt: null, persistenceGranted: true,
    });
    await v3.table("cars").put({
      id: "c-gli", name: "GLI", avgKmpl: 12, petrolPricePerLitre: 270,
      petrolPriceSetOn: "2026-11-09", ratePerKm: 60, createdAt: "2026-11-01T09:00:00.000Z",
      rateHistory: [{ effectiveFrom: "2026-11-01", ratePerKm: 60, avgKmpl: 12, petrolPricePerLitre: 270 }],
    });
    await v3.table("trips").bulkAdd([
      { id: "t-1", date: "2026-11-02", carId: "c-gli", carName: "GLI", fromId: "chichawatni", fromName: "Chichawatni", toId: "lahore", toName: "Lahore", oneWayKm: 236.35, isReturn: true, totalKm: 472.7, kmOverridden: false, routeSource: "OSRM, checked 2026-11-09", avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60, flatRent: null, toll: 500, other: 0, billTollToCustomer: true, fuelLitres: 39.39, fuelCost: 10636, customerRent: 28362, totalQuote: 28862, estimatedSaving: 17226, note: "Airport drop", createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" },
      { id: "t-2", date: "2026-11-03", carId: "c-gli", carName: "GLI", fromId: "chichawatni", fromName: "Chichawatni", toId: "sahiwal", toName: "Sahiwal", oneWayKm: 32.1, isReturn: false, totalKm: 32.1, kmOverridden: false, routeSource: "OSRM, checked 2026-11-09", avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60, flatRent: null, toll: 0, other: 200, billTollToCustomer: false, fuelLitres: 2.675, fuelCost: 722, customerRent: 1926, totalQuote: 1926, estimatedSaving: 1004, note: "", createdAt: "2026-11-03T11:00:00.000Z", updatedAt: "2026-11-03T11:00:00.000Z" },
    ]);
    await v3.table("expenses").bulkAdd([
      { id: "e-1", date: "2026-11-02", carId: "c-gli", carName: "GLI", category: "oil", amount: 4500, allowable: true, note: "Engine oil", createdAt: "2026-11-02T18:00:00.000Z" },
      { id: "e-2", date: "2026-11-03", carId: "c-gli", carName: "GLI", category: "tyre", amount: 12000, allowable: true, note: "Puncture + tube", createdAt: "2026-11-03T18:00:00.000Z" },
    ]);
    await v3.table("settlements").put({
      id: "s-1", createdAt: "2026-11-08T10:00:00.000Z", startDate: "2026-11-02", endDate: "2026-11-08",
      carId: null, driverName: "Ahmed", driverPct: 30, income: 50000, tripFuel: 12000, tripToll: 500,
      carExpensesAllowable: 3000, allowableExpenses: 15500, net: 34500, driverShare: 10350, ownerShare: 24150,
      tripIds: ["t-1", "t-2"], expenseIds: ["e-1"],
      snapshot: { income: 50000, tripFuel: 12000, tripToll: 500, carExpensesAllowable: 3000, driverPct: 30 },
      sourceChangedSinceSaved: false,
    });
    await v3.table("routeOverrides").put({
      routeId: "chichawatni--sahiwal", fromId: "chichawatni", fromName: "Chichawatni",
      toId: "sahiwal", toName: "Sahiwal", km: 33, source: "Manual, edited 2026-11-03",
      deleted: false, updatedAt: "2026-11-03T12:00:00.000Z",
    });
    await v3.table("placesCustom").put({
      id: "custom-1", name: "Chak 112/12-L", aliases: ["112 wala chak"],
      category: "custom", createdAt: "2026-11-06T09:00:00.000Z",
    });
    v3.close();
  });
  await pageB.unrouteAll();
  await pageB.close();

  // Now load the app: Dexie must migrate v3 -> v4.
  await page.goto("/");
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });

  // Zero row loss (counts read straight from IndexedDB).
  const counts = await page.evaluate(() => {
    return new Promise<Record<string, number>>((resolve, reject) => {
      const req = indexedDB.open("car-calculator");
      req.onsuccess = () => {
        const db = req.result;
        const tables = ["settings", "cars", "trips", "expenses", "settlements", "settlementEdits", "routeOverrides", "placesCustom", "meta", "drivers", "placeAliases", "tollPlazas", "routeTolls", "placeUsage"];
        const tx = db.transaction(tables, "readonly");
        const out: Record<string, number> = {};
        let done = 0;
        for (const t of tables) {
          const c = tx.objectStore(t).count();
          c.onsuccess = () => { out[t] = c.result; if (++done === tables.length) { db.close(); resolve(out); } };
          c.onerror = () => reject(c.error);
        }
      };
      req.onerror = () => reject(req.error);
    });
  });
  expect(counts.trips).toBe(2);
  expect(counts.expenses).toBe(2);
  expect(counts.settlements).toBe(1);
  expect(counts.routeOverrides).toBe(1);
  expect(counts.placesCustom).toBe(1);
  expect(counts.cars).toBe(1);
  expect(counts.drivers).toBe(0);
  expect(counts.placeAliases).toBe(0);
  expect(counts.routeTolls).toBe(0);

  // Old trips NOT recomputed: v1 stored numbers still shown exactly.
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page.getByText("Chichawatni → Lahore")).toBeVisible();
  await expect(page.getByText("Rs 28,362")).toBeVisible(); // t-1 rent, unchanged
  await expect(page.getByText("Rs 17,226")).toBeVisible(); // t-1 saving, unchanged
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
  // Saved settlement survived and is listed in History.
  await page.getByRole("button", { name: "Settlement", exact: true }).click();
  await page.getByText("History").click();
  await expect(page.locator("main")).toContainText("Ahmed");
  await expect(page.locator("main")).toContainText("Rs 10,350");
  // The old car NAME lives in the DB rows but must never render in the UI.
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("GLI");
});

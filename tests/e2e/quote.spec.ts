import { test, expect } from "@playwright/test";
import { gotoClean, pickTo, setRates, setTotalKm, openTollSheet, expectNoHorizontalScroll, expectResultCardVisible } from "./helpers";

/** E2E v2: cold start -> quote -> save trip -> reload persistence -> settlement.
 *  Runs on Pixel 5, 360x640 and 320x568. No car-settings screen exists in v2:
 *  rates live on the Quote screen; toll lives in the toll row + sheet. */

test.beforeEach(async ({ page }) => {
  await gotoClean(page);
});

test("cold start opens on Quote, From is Chichawatni, Lahore quote fills km + toll row", async ({ page }) => {
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni");
  await pickTo(page, "Lahore");
  await setRates(page);
  const result = page.getByTestId("quote-result");
  await expect(result).toContainText("472.7 km"); // 236.35 one-way x 2
  await expect(result).toContainText("Rs 28,362"); // rent 472.7 x 60
  await expect(result).toContainText("Rs 10,636"); // fuel 472.7/12 x 270
  await expect(result).toContainText("not verified"); // Lahore: 5 plazas, no verified fare
  // NOTE (audit): with the toll unknown the bill is rent + 0 — the toll line
  // says "not verified" so the gap is visible, but the bill number itself
  // excludes the unknown toll. See top-15 audit #2.
  await expect(result).toContainText("Rs 28,362"); // total bill (rent + 0 toll)
  await expect(page.getByTestId("route-source")).toContainText("Source: OSRM, checked 2026-11-09");
  await expect(page.getByTestId("toll-row")).toContainText("5 plazas");
  await expect(page.getByTestId("toll-row")).toContainText("fare not verified");
  await expectResultCardVisible(page);
  await expectNoHorizontalScroll(page);
});

test("route select fills km instantly (timed, cache warm)", async ({ page }) => {
  // Warm the route cache with one selection first.
  await pickTo(page, "Lahore");
  await expect(page.getByTestId("total-km-override")).toHaveValue("472.7", { timeout: 10_000 });
  // Now measure a second selection: click -> total km value appears.
  const t0 = Date.now();
  await pickTo(page, "Sahiwal");
  await expect(page.getByTestId("total-km-override")).toHaveValue("94.46", { timeout: 10_000 });
  const ms = Date.now() - t0;
  test.info().annotations.push({ type: "route-select-ms", description: `${ms} ms (click -> 94.46 km shown)` });
  console.log(`route-select Sahiwal: ${ms} ms`);
  expect(ms).toBeLessThan(2000);
});

test("spec vector B via the toll sheet: 100 km, 2 plazas Rs 100 + Rs 150", async ({ page }) => {
  await pickTo(page, "Sahiwal"); // 0 plazas: clean slate for the vector
  await setRates(page);
  await page.getByText("One Way", { exact: true }).click();
  await setTotalKm(page, "100");
  // Add the two vector plazas through the toll sheet.
  await openTollSheet(page);
  const addBox = page.locator(".sheet .plaza").last();
  await addBox.getByPlaceholder("e.g. Sahiwal Toll Plaza").fill("Plaza A");
  await addBox.locator('input[inputmode="decimal"]').nth(0).fill("100");
  await addBox.getByRole("button", { name: "Add plaza" }).click();
  await addBox.getByPlaceholder("e.g. Sahiwal Toll Plaza").fill("Plaza B");
  await addBox.locator('input[inputmode="decimal"]').nth(0).fill("150");
  await addBox.getByRole("button", { name: "Add plaza" }).click();
  await expect(page.getByTestId("toll-sheet-total")).toContainText("Rs 250");
  await page.getByTestId("save-tolls").click();
  await expect(page.getByTestId("toll-row")).toContainText("2 plazas - Rs 250");

  // One way: fuel 2250, rent 6000, toll 250, bill 6250, saving 3750.
  const result = page.getByTestId("quote-result");
  await expect(result).toContainText("100 km");
  await expect(result).toContainText("Rs 2,250");
  await expect(result).toContainText("Rs 6,000");
  await expect(result).toContainText("Rs 250");
  await expect(result).toContainText("Rs 6,250");
  await expect(result).toContainText("Rs 3,750");

  // Two way (override 200): fuel 4500, rent 12000, toll 500, bill 12500, saving 7500.
  await page.getByText("Two Way", { exact: true }).click();
  await setTotalKm(page, "200");
  await expect(result).toContainText("200 km");
  await expect(result).toContainText("Rs 4,500");
  await expect(result).toContainText("Rs 12,000");
  await expect(result).toContainText("Rs 500");
  await expect(result).toContainText("Rs 12,500");
  await expect(result).toContainText("Rs 7,500");

  // Toll excluded, one way: toll 0, bill 6000, saving 3750.
  await page.getByText("One Way", { exact: true }).click();
  await setTotalKm(page, "100");
  await page.getByTestId("toll-include").uncheck();
  await expect(result).toContainText("Rs 0");
  await expect(result).toContainText("Rs 6,000");
  await expect(result).toContainText("Rs 3,750");
  await expect(page.getByTestId("toll-row")).toContainText("Excluded");
});

test("km override is used and flagged; one-way/return toggle changes total", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await page.getByText("One Way", { exact: true }).click();
  await expect(page.getByTestId("quote-result")).toContainText("47.23 km");
  await setTotalKm(page, "80");
  await expect(page.getByTestId("quote-result")).toContainText("80 km (overridden)");
});

test("save trip, reload, trip persists and rates are remembered; settlement sums it", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  // Rates remembered after reload (persisted on blur).
  await expect(page.getByTestId("petrol-price")).toHaveValue("270");
  await expect(page.getByTestId("kmpl")).toHaveValue("12");
  await expect(page.getByTestId("rate-per-km")).toHaveValue("60");
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
  await expect(page.getByText("Rs 5,668")).toBeVisible(); // 94.46 km return x 60 = 5667.6 -> 5668
  // Settlement: this week, driver 30%
  await page.getByRole("button", { name: "Settlement", exact: true }).click();
  await page.getByTestId("driver-name").fill("Test Driver");
  await page.getByTestId("driver-pct").fill("30");
  const s = page.getByTestId("settlement-result");
  await expect(s).toContainText("Rs 5,668"); // income (return trip)
  await expect(s).toContainText("Rs 2,125"); // fuel 94.46/12*270 = 2125.35 -> 2125
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
});

test("offline after first load: app still opens and quotes from seed data", async ({ page, context }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await context.setOffline(false);
});

test("quote screen never shows driver % or a car name", async ({ page }) => {
  await expect(page.locator("main")).not.toContainText("Driver %");
  await expect(page.locator("main")).not.toContainText("driver share", { ignoreCase: true });
  await expect(page.locator("body")).not.toContainText("GLI");
});

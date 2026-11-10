import { test, expect } from "@playwright/test";

/** E2E: cold start -> quote -> save trip -> reload persistence -> settlement.
 *  Runs on Pixel 5 and 320x568. The app must work with no login, no splash. */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("car-calculator"));
  await page.goto("/");
  await expect(page.getByTestId("from-input")).toBeVisible();
});

async function setRates(page) {
  await page.getByTestId("petrol-price").fill("270");
  await page.getByTestId("kmpl").fill("12");
  await page.getByTestId("rate-per-km").fill("60");
}

test("cold start opens on Quote, From is Chichawatni, quote in under 4 taps", async ({ page }) => {
  // Tap 1: To field, type Lahore, tap result. Tap 2: Return is default on.
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Lah");
  await page.locator(".picker button", { hasText: "Lahore" }).first().click();
  await setRates(page);
  await page.getByTestId("toll").fill("500");
  const result = page.getByTestId("quote-result");
  await expect(result).toContainText("472.7 km"); // 236.35 one-way x 2
  await expect(result).toContainText("Rs 28,362"); // rent 472.7 x 60
  await expect(result).toContainText("Rs 10,636"); // fuel 472.7/12 x 270
  await expect(result).toContainText("Rs 17,226"); // saving 28362-10636-500
  await expect(page.getByTestId("route-source")).toContainText("Source: OSRM, checked 2026-11-09");
});

test("quote test vector via manual km: 100 km return = fuel 4500, rent 12000, saving 7000", async ({ page }) => {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await page.getByTestId("oneway-km").fill("100");
  await setRates(page);
  await page.getByTestId("toll").fill("500");
  const result = page.getByTestId("quote-result");
  await expect(result).toContainText("200 km");
  await expect(result).toContainText("Rs 4,500");
  await expect(result).toContainText("Rs 12,000");
  await expect(result).toContainText("Rs 7,000");
});

test("km override is used and flagged; one-way/return toggle changes total", async ({ page }) => {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await page.getByText("One-way", { exact: true }).click();
  await expect(page.getByTestId("quote-result")).toContainText("47.23 km");
  await page.getByTestId("total-km-override").fill("80");
  await expect(page.getByTestId("quote-result")).toContainText("80 km (overridden)");
});

test("save trip, reload, trip persists; settlement sums it", async ({ page }) => {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await setRates(page);
  // Save needs a car: add one in More -> Settings first.
  await page.getByText("More", { exact: true }).click();
  await page.getByPlaceholder("e.g. GLI").fill("GLI");
  await page.getByTestId("settings-petrol").fill("270");
  await page.getByTestId("settings-kmpl").fill("12");
  await page.getByTestId("settings-rate").fill("60");
  await page.getByTestId("settings-driver-pct").fill("30");
  await page.getByTestId("save-settings").click();
  await page.getByText("Quote", { exact: true }).click();
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();
  await page.reload();
  await page.getByText("Trips", { exact: true }).click();
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
  await expect(page.getByText("Rs 5,668")).toBeVisible(); // 94.46 km return x 60 = 5667.6 -> 5668
  // Settlement: this week, driver 30%
  await page.getByText("Settle", { exact: true }).click();
  await page.getByTestId("driver-name").fill("Test Driver");
  await page.getByTestId("driver-pct").fill("30");
  const s = page.getByTestId("settlement-result");
  await expect(s).toContainText("Rs 5,668"); // income (return trip)
  await expect(s).toContainText("Rs 2,125"); // fuel 94.46/12*270 = 2125.35 -> 2125
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
});

test("offline after first load: app still opens and quotes from seed data", async ({ page, context }) => {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("from-input")).toBeVisible();
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await context.setOffline(false);
});

test("quote screen never shows driver % or settlement", async ({ page }) => {
  await expect(page.locator("main")).not.toContainText("driver share", { ignoreCase: true });
  await expect(page.locator("main")).not.toContainText("Driver %");
});

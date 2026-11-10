import { test, expect } from "@playwright/test";
import { gotoClean, pickTo, setRates, openTollSheet, expectNoHorizontalScroll, expectResultCardVisible } from "./helpers";

/** Screenshot QA: EVERY screen at both required sizes (360x640, 320x568).
 *  Saved under docs/screenshots-v2/<WxH>/ — inspect each one by eye for
 *  clipped text, overlap, horizontal scroll, result card above the fold.
 *  Run: npx playwright test tests/e2e/screenshots.spec.ts --project small360 --project small320 */

async function shot(page, name: string, fullPage = false) {
  const vp = page.viewportSize()!;
  const dir = `docs/screenshots-v2/${vp.width}x${vp.height}`;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage });
}

test.beforeEach(async ({ page }) => {
  await gotoClean(page);
});

test("quote screen (Sahiwal, rates set, result card + toll row)", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await expect(page.getByTestId("quote-result")).toContainText("94.46 km");
  await expectResultCardVisible(page);
  await expectNoHorizontalScroll(page);
  await shot(page, "01-quote");
});

test("toll breakdown sheet OPEN (Lahore, 5 unverified plazas)", async ({ page }) => {
  await pickTo(page, "Lahore");
  await setRates(page);
  await openTollSheet(page);
  await expect(page.getByTestId("toll-sheet")).toContainText("Fare not verified - enter");
  await expectNoHorizontalScroll(page);
  await shot(page, "02-toll-sheet");
});

test("trips screen (one saved trip)", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "03-trips");
});

test("expenses screen (one expense)", async ({ page }) => {
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  await page.getByTestId("expense-amount").fill("4500");
  await page.locator("select").selectOption("oil");
  await page.getByRole("button", { name: "Save expense" }).click();
  await expect(page.getByText("Expense saved.")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, "04-expenses");
});

test("settlement screen (vector result + history open)", async ({ page }) => {
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
  await expect(page.getByTestId("settlement-result")).toContainText("Rs 10,500");
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
  await page.getByText("History").click();
  await expect(page.locator("main")).toContainText("Vector Driver");
  await expectNoHorizontalScroll(page);
  await shot(page, "05-settlement", true);
});

test("more screen (saved routes + backup/restore + about, full page)", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.locator("main")).toContainText("Saved routes");
  await expect(page.locator("main")).toContainText("Backup & restore");
  await expect(page.locator("main")).toContainText("About");
  await expectNoHorizontalScroll(page);
  await shot(page, "06-more", true);
});

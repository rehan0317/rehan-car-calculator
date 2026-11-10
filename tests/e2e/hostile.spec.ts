import { test, expect } from "@playwright/test";
import { gotoClean, pickTo, setRates } from "./helpers";

/** Hostile QA pass v2 (Argon items 1-9 + auditor items 10-15, re-based on the
 *  v2 UI: no car-settings screen, no manual toll box, toll in the sheet). */

test.beforeEach(async ({ page }) => {
  await gotoClean(page);
});

async function saveOneTrip(page) {
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();
}

// H6: retroactive rate mutation — changing the rate must NOT change an old trip.
test("H6 old trip keeps its snapshot when the rate changes", async ({ page }) => {
  await saveOneTrip(page);
  // Change the remembered rate on the Quote screen (persisted on blur).
  await page.getByTestId("rate-per-km").fill("100");
  await page.getByTestId("rate-per-km").blur();
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page.getByText("Rs 5,668")).toBeVisible(); // 94.46 km x 60, NOT x 100
  await expect(page.getByText("Rs 9,446")).not.toBeVisible();
});

// H7: double-settling — a settled trip must not appear in the next settlement.
test("H7 settled trips disappear from the next settlement", async ({ page }) => {
  await saveOneTrip(page);
  await page.getByRole("button", { name: "Settlement", exact: true }).click();
  await page.getByTestId("driver-name").fill("Driver A");
  await page.getByTestId("driver-pct").fill("30");
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await page.getByRole("button", { name: "Settlement", exact: true }).click();
  await expect(page.locator("main")).toContainText("0 trip(s), 0 expense(s) in range, not yet settled");
  await page.getByTestId("driver-name").fill("Driver A");
  await page.getByTestId("driver-pct").fill("30");
  await expect(page.getByTestId("settlement-result")).toContainText("Rs 0");
});

// H8: divide-by-zero / NaN — km/L = 0 must show an error, never Infinity/NaN money.
test("H8 km/L 0 shows an error and no quote", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await page.getByTestId("petrol-price").fill("270");
  await page.getByTestId("kmpl").fill("0");
  await page.getByTestId("rate-per-km").fill("60");
  await expect(page.getByTestId("quote-result")).toContainText("—");
  await expect(page.locator("main")).toContainText("Average km per litre must be more than 0");
  await expect(page.locator("main")).not.toContainText("Infinity");
  await expect(page.locator("main")).not.toContainText("NaN");
});

// H13: stale petrol price must never look current.
test("H13 petrol price set 30 days ago shows an amber warning", async ({ page }) => {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("car-calculator");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("settings", "readwrite");
        tx.objectStore("settings").put({
          id: "app", petrolPricePerLitre: 250, petrolPriceSetOn: "2026-10-10",
          petrolStaleDays: 7, driverPct: null, defaultCarId: null, lastBackupAt: null,
          persistenceGranted: null, ratePerKm: 60, ratePerKmSetOn: "2026-11-10",
          avgKmpl: 12, avgKmplSetOn: "2026-11-10",
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await expect(page.locator("main")).toContainText("as of 2026-10-10");
  await expect(page.locator("main")).toContainText("more than 7 days old");
});

// H14: route override survives reload (seed is read-only, override is separate).
test("H14 edited km survives reload and is labelled as an override", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByPlaceholder("Search routes…").fill("sahiwal");
  page.once("dialog", (d) => d.accept("50"));
  await page.locator(".card", { hasText: "chichawatni → sahiwal" }).first().locator("button", { hasText: "Edit km" }).click();
  await expect(page.getByText("Route override saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  await pickTo(page, "Sahiwal");
  await expect(page.getByTestId("total-km-override")).toHaveValue("100", { timeout: 10_000 }); // 50 km x 2 (return)
  await expect(page.getByTestId("route-source")).toContainText("User override");
});

// H15: offline + unknown pair — no invented km, no quote until the user types km.
// v2 change: hub↔hub routes now exist, so Kasur→Vehari HAS a route. The
// genuinely unknown pair is two non-hub villages (no hub↔hub row, no
// Chichawatni origin): pick two villages and check manual entry.
test("H15 offline unknown pair shows manual entry, never a guessed km", async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
  // From = a village (not Chichawatni, not a hub), To = another village.
  await page.getByTestId("from-input").click();
  await page.getByTestId("from-input").fill("Chak 112/12");
  await page.locator(".picker button", { hasText: "Chak No 112/12.L" }).first().click();
  await pickTo(page, "Harappa");
  await expect(page.locator("main")).toContainText("Enter km manually");
  await expect(page.getByTestId("quote-result")).toContainText("—");
  await context.setOffline(false);
});

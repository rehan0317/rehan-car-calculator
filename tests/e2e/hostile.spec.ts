import { test, expect } from "@playwright/test";

/** Hostile QA pass (Argon items 1-9 + auditor items 10-15).
 *  Each test tries to make the app silently show wrong money or lose data. */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("car-calculator"));
  await page.goto("/");
  await expect(page.getByTestId("from-input")).toBeVisible();
});

async function addCar(page, rate = "60") {
  await page.getByText("More", { exact: true }).click();
  await page.getByPlaceholder("e.g. GLI").fill("GLI");
  await page.getByTestId("settings-petrol").fill("270");
  await page.getByTestId("settings-kmpl").fill("12");
  await page.getByTestId("settings-rate").fill(rate);
  await page.getByTestId("settings-driver-pct").fill("30");
  await page.getByTestId("save-settings").click();
  await page.getByText("Quote", { exact: true }).click();
}

async function pickTo(page, name: string) {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill(name);
  await page.locator(".picker button", { hasText: name }).first().click();
}

async function saveOneTrip(page) {
  await pickTo(page, "Sahiwal");
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();
}

// H6: retroactive rate mutation — changing the rate must NOT change an old trip.
test("H6 old trip keeps its snapshot when the rate changes", async ({ page }) => {
  await addCar(page, "60");
  await saveOneTrip(page);
  await page.getByText("More", { exact: true }).click();
  await page.getByTestId("settings-rate").fill("100");
  await page.getByTestId("save-settings").click();
  await page.getByText("Trips", { exact: true }).click();
  await expect(page.getByText("Rs 5,668")).toBeVisible(); // 94.46 km x 60, NOT x 100
  await expect(page.getByText("Rs 9,446")).not.toBeVisible();
});

// H7: double-settling — a settled trip must not appear in the next settlement.
test("H7 settled trips disappear from the next settlement", async ({ page }) => {
  await addCar(page, "60");
  await saveOneTrip(page);
  await page.getByText("Settle", { exact: true }).click();
  await page.getByTestId("driver-name").fill("Driver A");
  await page.getByTestId("driver-pct").fill("30");
  await page.getByTestId("save-settlement").click();
  await expect(page.getByText(/Settlement saved/)).toBeVisible();
  await page.reload();
  await page.getByText("Settle", { exact: true }).click();
  await expect(page.getByTestId("settlement-result")).toContainText("0 · Income Rs 0");
});

// H8: divide-by-zero / NaN — km/L = 0 must show an error, never Infinity/NaN money.
test("H8 km/L 0 shows an error and no quote", async ({ page }) => {
  await pickTo(page, "Sahiwal");
  await page.getByTestId("petrol-price").fill("270");
  await page.getByTestId("kmpl").fill("0");
  await page.getByTestId("rate-per-km").fill("60");
  await expect(page.getByTestId("quote-result")).not.toBeVisible();
  await expect(page.locator("main")).toContainText("Average km per litre must be more than 0");
  await expect(page.locator("main")).not.toContainText("Infinity");
  await expect(page.locator("main")).not.toContainText("NaN");
});

// H13: stale petrol price must never look current.
test("H13 petrol price set 30 days ago shows an amber warning", async ({ page }) => {
  await page.evaluate(() => {
    const req = indexedDB.open("car-calculator");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({
        id: "app", petrolPricePerLitre: 250, petrolPriceSetOn: "2026-10-10",
        petrolStaleDays: 7, driverPct: 30, defaultCarId: null, lastBackupAt: null, persistenceGranted: null,
      });
    };
  });
  await page.reload();
  await page.getByText("More", { exact: true }).click();
  await expect(page.locator("main")).toContainText("Petrol price set on 2026-10-10");
  await expect(page.locator("main")).toContainText("more than 7 days old");
});

// H14: route override survives reload (seed is read-only, override is separate).
test("H14 edited km survives reload and is labelled as an override", async ({ page }) => {
  await page.getByText("More", { exact: true }).click();
  page.once("dialog", (d) => d.accept("50"));
  await page.locator(".card", { hasText: "chichawatni → sahiwal" }).first().locator("button", { hasText: "Edit km" }).click();
  await expect(page.getByText("Route override saved")).toBeVisible();
  await page.reload();
  await page.getByText("Quote", { exact: true }).click();
  await pickTo(page, "Sahiwal");
  await expect(page.getByTestId("oneway-km")).toHaveValue("50");
  await expect(page.getByTestId("route-source")).toContainText("User override");
});

// H15: offline + unknown pair — no invented km, no quote until the user types km.
test("H15 offline unknown pair shows manual entry, never a guessed km", async ({ page, context }) => {
  // Wait for the service worker to finish precaching, or the offline reload
  // races the install and the browser reports "no internet" instead of the app.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId("from-input").click();
  await page.getByTestId("from-input").fill("Kasur");
  await page.locator(".picker button", { hasText: "Kasur" }).first().click();
  await pickTo(page, "Vehari");
  await expect(page.locator("main")).toContainText("Enter km manually");
  await expect(page.getByTestId("quote-result")).not.toBeVisible();
  await context.setOffline(false);
});

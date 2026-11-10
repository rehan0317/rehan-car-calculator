import { expect, type Page } from "@playwright/test";

/** Shared helpers for the v2 E2E suite (Quote screen is the v2 rebuild:
 *  no car-settings screen, no manual toll box, toll lives in the toll row
 *  + bottom sheet; rates live on the Quote screen and are remembered). */

export async function gotoClean(page: Page) {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("car-calculator"));
  await page.goto("/");
  await expect(page.getByTestId("from-input")).toBeVisible();
  // Seed data (places.json 5.87 MB + routes-seed.json 26.8 MB) loads async;
  // wait until the From field is actually filled with Chichawatni.
  await expect(page.getByTestId("from-input")).toHaveValue("Chichawatni", { timeout: 30_000 });
}

export async function pickTo(page: Page, name: string) {
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill(name);
  await page.locator(".picker button", { hasText: name }).first().click();
}

export async function setRates(page: Page, petrol = "270", kmpl = "12", rate = "60") {
  await page.getByTestId("petrol-price").fill(petrol);
  await page.getByTestId("kmpl").fill(kmpl);
  await page.getByTestId("rate-per-km").fill(rate);
  // Blur persists each value to settings (persist on blur).
  await page.getByTestId("rate-per-km").blur();
  await page.getByTestId("petrol-price").blur();
  await page.getByTestId("kmpl").blur();
}

/** Sahiwal has 0 toll plazas (genuinely Rs 0 toll) — exact-number checks. */
export async function quoteSahiwal(page: Page) {
  await pickTo(page, "Sahiwal");
  await setRates(page);
}

/** Fill the total-km override (inline edit on the Quote screen). */
export async function setTotalKm(page: Page, km: string) {
  await page.getByTestId("total-km-override").fill(km);
}

/** Open the toll breakdown sheet by tapping the toll row. */
export async function openTollSheet(page: Page) {
  await page.locator(".tollrow-main").click();
  await expect(page.getByTestId("toll-sheet")).toBeVisible();
}

/** No horizontal overflow anywhere on the current screen. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow (px)").toBeLessThanOrEqual(0);
}

/** The sticky result card must be visible without scrolling. */
export async function expectResultCardVisible(page: Page) {
  const box = await page.getByTestId("quote-result").boundingBox();
  expect(box, "result card missing").not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.y + box!.height, "result card bottom below viewport").toBeLessThanOrEqual(vp.height + 1);
  expect(box!.y, "result card top above viewport").toBeGreaterThanOrEqual(-1);
}

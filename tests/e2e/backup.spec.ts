import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { validateBackup } from "../../src/lib/backup";

/** H11/H12 + backup -> wipe -> restore round-trip, end to end. */

test("backup downloads as valid JSON, wipe, restore brings the trip back", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("car-calculator"));
  await page.goto("/");
  await expect(page.getByTestId("from-input")).toBeVisible();

  // Add a car + one trip.
  await page.getByText("More", { exact: true }).click();
  await page.getByPlaceholder("e.g. GLI").fill("GLI");
  await page.getByTestId("settings-petrol").fill("270");
  await page.getByTestId("settings-kmpl").fill("12");
  await page.getByTestId("settings-rate").fill("60");
  await page.getByTestId("save-settings").click();
  await page.getByText("Quote", { exact: true }).click();
  await page.getByTestId("to-input").click();
  await page.getByTestId("to-input").fill("Sahiwal");
  await page.locator(".picker button", { hasText: "Sahiwal" }).first().click();
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();

  // Download the backup and validate it in Node.
  await page.getByText("More", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByText("Download backup (JSON)", { exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const parsed = JSON.parse(await readFile(path!, "utf-8"));
  const v = validateBackup(parsed);
  expect(v.ok).toBe(true);
  expect(v.counts?.trips).toBe(1);

  // Wipe: delete the trip, then restore from the downloaded file (Replace).
  await page.getByText("Trips", { exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByText("Delete", { exact: true }).click();
  await expect(page.getByText("No trips yet")).toBeVisible();
  await page.getByText("More", { exact: true }).click();
  page.once("dialog", (d) => d.accept()); // restore confirm
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path!);
  await expect(page.getByText("Restore done")).toBeVisible();
  await page.getByText("Trips", { exact: true }).click();
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
});

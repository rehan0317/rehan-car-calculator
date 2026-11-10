import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { validateBackup } from "../../src/lib/backup";
import { gotoClean, pickTo, setRates } from "./helpers";

/** H11/H12 + backup -> wipe -> restore round-trip, end to end (v2: no car
 *  setup needed — rates live on the Quote screen). */

test("backup downloads as valid JSON, wipe, restore brings the trip back", async ({ page }) => {
  await gotoClean(page);

  // One trip, straight from the Quote screen.
  await pickTo(page, "Sahiwal");
  await setRates(page);
  await page.getByTestId("save-trip").click();
  await expect(page.getByText(/Trip saved/)).toBeVisible();

  // Download the backup and validate it in Node.
  await page.getByRole("button", { name: "More", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByText("Download backup (JSON)", { exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const parsed = JSON.parse(await readFile(path!, "utf-8"));
  const v = validateBackup(parsed);
  expect(v.ok).toBe(true);
  expect(v.counts?.trips).toBe(1);
  expect(parsed.schemaVersion).toBe(4);

  // Wipe: delete the trip, then restore from the downloaded file (Replace).
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByText("Delete", { exact: true }).click();
  await expect(page.getByText("No trips yet")).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  page.once("dialog", (d) => d.accept()); // restore confirm
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path!);
  await expect(page.getByText("Restore done")).toBeVisible();
  await page.getByRole("button", { name: "Trips", exact: true }).click();
  await expect(page.getByText("Chichawatni → Sahiwal")).toBeVisible();
  await expect(page.getByText("Rs 5,668")).toBeVisible();
});

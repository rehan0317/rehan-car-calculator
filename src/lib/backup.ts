/** Backup / restore: manual JSON (schemaVersion, appVersion, checksum) +
 *  per-table CSV (UTF-8 BOM so Excel opens it). Export via download AND the
 *  Web Share API. Restore validates, previews counts, Replace/Merge, and
 *  auto-snapshots current data first. */
import { APP_VERSION, SCHEMA_VERSION, db } from "./db";

export interface BackupFile {
  app: string;
  appVersion: string;
  schemaVersion: number;
  exportedAt: string;
  checksum: string;
  tables: Record<string, unknown[]>;
}

const TABLES = ["settings", "cars", "trips", "expenses", "settlements", "settlementEdits", "routeOverrides", "placesCustom", "meta"] as const;

/** FNV-1a 32-bit checksum over the canonical JSON of the tables (not crypto-grade,
 *  a corruption tripwire — the file is a local backup, not a signed document). */
export function checksumOf(tables: Record<string, unknown[]>): string {
  const s = JSON.stringify(tables);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export async function buildBackup(): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = await (db as any)[t].toArray();
  return {
    app: "chichawatni-car-calculator", appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(), checksum: checksumOf(tables), tables,
  };
}

export function validateBackup(data: unknown): { ok: boolean; error?: string; counts?: Record<string, number> } {
  if (!data || typeof data !== "object") return { ok: false, error: "Not a JSON object" };
  const b = data as Partial<BackupFile>;
  if (b.app !== "chichawatni-car-calculator") return { ok: false, error: "Not a car-calculator backup file" };
  if (typeof b.schemaVersion !== "number" || b.schemaVersion > SCHEMA_VERSION)
    return { ok: false, error: `Backup schema v${b.schemaVersion} is newer than this app (v${SCHEMA_VERSION}). Update the app first.` };
  if (!b.tables || typeof b.tables !== "object") return { ok: false, error: "Backup has no tables" };
  if (b.checksum !== checksumOf(b.tables as Record<string, unknown[]>))
    return { ok: false, error: "Checksum mismatch — file may be corrupted. Restore stopped." };
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = Array.isArray((b.tables as any)[t]) ? (b.tables as any)[t].length : 0;
  return { ok: true, counts };
}

export async function applyBackup(b: BackupFile, mode: "replace" | "merge"): Promise<void> {
  // Auto-snapshot current data first (as a downloadable file the user keeps).
  const snapshot = await buildBackup();
  downloadText(`car-backup-before-restore-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(snapshot, null, 2), "application/json");
  await db.transaction("rw", [db.settings, db.cars, db.trips, db.expenses, db.settlements, db.settlementEdits, db.routeOverrides, db.placesCustom, db.meta], async () => {
    if (mode === "replace") {
      for (const t of TABLES) await (db as any)[t].clear();
    }
    for (const t of TABLES) {
      const rows = (b.tables as any)[t];
      if (Array.isArray(rows) && rows.length) await (db as any)[t].bulkPut(rows);
    }
  });
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function shareBackup(): Promise<"shared" | "downloaded" | "unsupported"> {
  const b = await buildBackup();
  const file = new File([JSON.stringify(b, null, 2)], `car-backup-${b.exportedAt.slice(0, 10)}.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Car calculator backup" }); return "shared"; } catch { return "downloaded"; }
  }
  downloadText(file.name, JSON.stringify(b, null, 2), "application/json");
  return "unsupported";
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tableToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  // UTF-8 BOM so Excel opens it correctly.
  return "\uFEFF" + lines.join("\r\n");
}

export async function exportCsv(table: (typeof TABLES)[number]): Promise<void> {
  const rows = await (db as any)[table].toArray();
  downloadText(`${table}-${new Date().toISOString().slice(0, 10)}.csv`, tableToCsv(rows), "text/csv");
}

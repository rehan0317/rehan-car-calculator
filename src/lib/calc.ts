/**
 * calc.ts — ALL money maths for the car calculator lives here, and ONLY here.
 * Pure module: no UI imports, no Dexie, no Date, no network.
 * Money is whole PKR (integer). Litres are kept exact until the final
 * PKR rounding; round half up only at the final display/stored amount.
 * Empty is NOT 0: every numeric input is `number | null`. NaN is rejected.
 */

// ---------- validation ----------

export type ValidationError = { field: string; message: string };

export function isValidNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse a text input strictly. "" / whitespace / garbage -> null (empty, not 0). */
export function parseInput(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Round half up to whole PKR. JS Math.round is half-up for positives;
 *  for negatives we round the magnitude (symmetric half-up). */
export function roundPKR(n: number): number {
  if (!Number.isFinite(n)) throw new Error("roundPKR: non-finite input");
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Round half up to 2 decimals (litres display only). */
export function round2(n: number): number {
  if (!Number.isFinite(n)) throw new Error("round2: non-finite input");
  return Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;
}

// ---------- quote ----------

export interface QuoteInput {
  oneWayKm: number | null;
  isReturn: boolean;
  /** User-typed total km override. Null = use computed oneWay x (return?2:1). */
  totalKmOverride: number | null;
  avgKmpl: number | null;
  petrolPricePerLitre: number | null;
  ratePerKm: number | null;
  /** Flat rent override (Rs). Null = use ratePerKm x totalKm. */
  flatRentOverride: number | null;
  toll: number | null;
  other: number | null;
  /** true = toll is billed to the customer (added to quote total, not an expense). */
  billTollToCustomer: boolean;
}

export interface QuoteResult {
  totalKm: number;
  kmWasOverridden: boolean;
  fuelLitres: number; // exact, unrounded (display with round2)
  fuelLitresDisplay: number;
  fuelCost: number; // whole PKR
  customerRent: number; // whole PKR (rate x km, or flat override)
  otherExpenses: number; // whole PKR: toll (if NOT billed) + other
  tollBilledToCustomer: number; // whole PKR, 0 when toggle off
  totalQuote: number; // whole PKR: customerRent + tollBilledToCustomer
  estimatedSaving: number; // whole PKR: customerRent - fuelCost - otherExpenses
}

export function calcQuote(input: QuoteInput): { result: QuoteResult | null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const req = (v: number | null, field: string, label: string): number | null => {
    if (v === null) { errors.push({ field, message: `${label} is required` }); return null; }
    if (v <= 0) { errors.push({ field, message: `${label} must be more than 0` }); return null; }
    return v;
  };
  const opt = (v: number | null, field: string, label: string): number => {
    if (v === null) return 0;
    if (v < 0) { errors.push({ field, message: `${label} cannot be negative` }); return 0; }
    return v;
  };

  const oneWay = req(input.oneWayKm, "oneWayKm", "One-way km");
  const kmpl = req(input.avgKmpl, "avgKmpl", "Average km per litre");
  const price = req(input.petrolPricePerLitre, "petrolPricePerLitre", "Petrol price per litre");
  const rate = input.flatRentOverride === null ? req(input.ratePerKm, "ratePerKm", "Rate per km") : null;
  if (input.totalKmOverride !== null && input.totalKmOverride <= 0)
    errors.push({ field: "totalKmOverride", message: "Total km must be more than 0" });
  if (input.flatRentOverride !== null && input.flatRentOverride < 0)
    errors.push({ field: "flatRentOverride", message: "Flat rent cannot be negative" });
  if (errors.length > 0 || oneWay === null || kmpl === null || price === null) return { result: null, errors };

  const kmWasOverridden = input.totalKmOverride !== null;
  const totalKm = kmWasOverridden ? (input.totalKmOverride as number) : oneWay * (input.isReturn ? 2 : 1);
  const toll = opt(input.toll, "toll", "Toll");
  const other = opt(input.other, "other", "Other expenses");
  if (errors.length > 0) return { result: null, errors };

  // Fuel: keep litres exact, round ONLY the PKR cost at the end.
  // 200 km / 12 km/L = 16.666... L x Rs 270 = Rs 4,500 exactly.
  // Rounding litres to 16.67 first would give Rs 4,501 — wrong by Rs 1.
  const fuelLitres = totalKm / kmpl;
  const fuelCost = roundPKR(fuelLitres * price);
  const customerRent =
    input.flatRentOverride !== null ? roundPKR(input.flatRentOverride) : roundPKR(rate! * totalKm);
  const tollBilledToCustomer = input.billTollToCustomer ? roundPKR(toll) : 0;
  const otherExpenses = roundPKR((input.billTollToCustomer ? 0 : toll) + other);
  const totalQuote = customerRent + tollBilledToCustomer;
  const estimatedSaving = customerRent - fuelCost - otherExpenses;

  return {
    result: {
      totalKm, kmWasOverridden, fuelLitres, fuelLitresDisplay: round2(fuelLitres),
      fuelCost, customerRent, otherExpenses, tollBilledToCustomer, totalQuote, estimatedSaving,
    },
    errors: [],
  };
}

// ---------- settlement ----------

export interface SettlementInput {
  income: number; // sum of rent collected in period (whole PKR)
  tripFuel: number; // sum of trip fuel costs (whole PKR)
  tripToll: number; // sum of trip tolls counted as expense (whole PKR)
  carExpensesAllowable: number; // sum of car expenses flagged allowable (whole PKR)
  driverPct: number; // 0..100
  /** When net < 0, driver share is 0 by default (owner absorbs the loss). */
  shareLossWithDriver?: boolean;
}

export interface SettlementResult {
  allowableExpenses: number;
  net: number;
  driverShare: number;
  ownerShare: number;
  negativeNetWarning: boolean;
}

export function calcSettlement(input: SettlementInput): SettlementResult {
  const allowableExpenses = input.tripFuel + input.tripToll + input.carExpensesAllowable;
  const net = input.income - allowableExpenses;
  let driverShare: number;
  if (net <= 0 && !input.shareLossWithDriver) {
    driverShare = 0;
  } else {
    driverShare = roundPKR((net * input.driverPct) / 100);
  }
  // Owner is ALWAYS the remainder, so driver + owner === net exactly.
  const ownerShare = net - driverShare;
  return { allowableExpenses, net, driverShare, ownerShare, negativeNetWarning: net < 0 };
}

/** Double-count guard: every source row may appear in at most one settlement.
 *  Returns the duplicated IDs (empty = clean). Trip fuel/toll live ONLY on the
 *  trip; car expenses live ONLY in the car-expense table. */
export function findDoubleCountedIds(settlements: Array<{ tripIds: string[]; expenseIds: string[] }>): string[] {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const s of settlements) {
    for (const id of [...s.tripIds, ...s.expenseIds]) {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n === 2) dupes.push(id);
    }
  }
  return dupes;
}

/** Haversine (straight-line) distance — SANITY CHECK ONLY, never a quote value.
 *  Road km must be >= straight-line km; flag road/straight ratio above 2.0. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180, dlmb = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function roadStraightRatio(roadKm: number, straightKm: number): number | null {
  if (!isValidNumber(roadKm) || !isValidNumber(straightKm) || straightKm <= 0) return null;
  return roadKm / straightKm;
}

/** Week Mon–Sun containing the given date (local), as YYYY-MM-DD strings. */
export function weekRangeMonSun(d: Date): { start: string; end: string } {
  const day = (d.getDay() + 6) % 7; // Mon=0
  const start = new Date(d); start.setDate(d.getDate() - day);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const fmt = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: fmt(start), end: fmt(end) };
}

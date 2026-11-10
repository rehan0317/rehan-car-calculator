import { describe, expect, it } from "vitest";
import {
  calcQuote, calcQuoteV2, calcSettlement, findDoubleCountedIds, haversineKm, parseInput,
  roadStraightRatio, round2, roundPKR, weekRangeMonSun, type QuoteInput, type QuoteV2Input,
} from "./calc";

const base: QuoteInput = {
  oneWayKm: 100, isReturn: true, totalKmOverride: null,
  avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60, flatRentOverride: null,
  toll: 500, other: 0, billTollToCustomer: false,
};

describe("quote test vector (spec)", () => {
  it("100 km one-way, return, 12 km/L, Rs 270/L, Rs 60/km, toll Rs 500", () => {
    const { result, errors } = calcQuote(base);
    expect(errors).toEqual([]);
    expect(result!.totalKm).toBe(200);
    expect(result!.fuelLitresDisplay).toBe(16.67);
    expect(result!.fuelCost).toBe(4500);
    expect(result!.customerRent).toBe(12000);
    expect(result!.otherExpenses).toBe(500);
    expect(result!.estimatedSaving).toBe(7000);
    expect(result!.totalQuote).toBe(12000);
  });

  it("toll billed to customer: toll moves from expenses to quote total", () => {
    const { result } = calcQuote({ ...base, billTollToCustomer: true });
    expect(result!.otherExpenses).toBe(0);
    expect(result!.tollBilledToCustomer).toBe(500);
    expect(result!.totalQuote).toBe(12500);
    expect(result!.estimatedSaving).toBe(7500); // rent - fuel - 0 other
  });

  it("one-way does not double the km; toll/other are NOT doubled on return", () => {
    const { result } = calcQuote({ ...base, isReturn: false });
    expect(result!.totalKm).toBe(100);
    expect(result!.fuelCost).toBe(2250);
    expect(result!.otherExpenses).toBe(500); // toll counted once
  });

  it("km override is flagged and used", () => {
    const { result } = calcQuote({ ...base, totalKmOverride: 180 });
    expect(result!.totalKm).toBe(180);
    expect(result!.kmWasOverridden).toBe(true);
  });

  it("flat rent override replaces rate x km", () => {
    const { result } = calcQuote({ ...base, flatRentOverride: 10000 });
    expect(result!.customerRent).toBe(10000);
  });
});

describe("quote v2 test vectors (spec B — TEST-ONLY values, never defaults)", () => {
  // 100 km one-way, 12 km/L, Rs 270/L, Rs 60/km, 2 plazas Rs 100 + Rs 150.
  const v2base: QuoteV2Input = {
    oneWayKm: 100, isReturn: false, totalKmOverride: null,
    avgKmpl: 12, petrolPricePerLitre: 270, ratePerKm: 60,
    tollOut: 250, tollBack: 250, tollIncluded: true, extraCost: 0,
  };

  it("one-way, toll included: fuel 2250, rent 6000, toll 250, bill 6250, saving 3750", () => {
    const { result, errors } = calcQuoteV2(v2base);
    expect(errors).toEqual([]);
    expect(result!.totalKm).toBe(100);
    expect(result!.fuelLitresDisplay).toBe(8.33);
    expect(result!.fuelCost).toBe(2250);
    expect(result!.rent).toBe(6000);
    expect(result!.toll).toBe(250);
    expect(result!.totalBill).toBe(6250);
    expect(result!.myCost).toBe(2500); // fuel 2250 + toll 250
    expect(result!.saving).toBe(3750);
    expect(result!.extraCost).toBe(0);
  });

  it("two-way, toll included: 200 km, fuel 4500, rent 12000, toll 500, bill 12500, saving 7500", () => {
    const { result } = calcQuoteV2({ ...v2base, isReturn: true });
    expect(result!.totalKm).toBe(200);
    expect(result!.fuelLitresDisplay).toBe(16.67);
    expect(result!.fuelCost).toBe(4500);
    expect(result!.rent).toBe(12000);
    expect(result!.toll).toBe(500); // out 250 + back 250
    expect(result!.totalBill).toBe(12500);
    expect(result!.myCost).toBe(5000);
    expect(result!.saving).toBe(7500);
  });

  it("toll excluded one-way: toll 0, bill 6000, saving 3750 (unchanged)", () => {
    const { result } = calcQuoteV2({ ...v2base, tollIncluded: false });
    expect(result!.toll).toBe(0);
    expect(result!.totalBill).toBe(6000);
    expect(result!.myCost).toBe(2250); // fuel only
    expect(result!.saving).toBe(3750);
  });

  it("toll excluded two-way: toll 0, bill 12000, saving 7500 (unchanged)", () => {
    const { result } = calcQuoteV2({ ...v2base, isReturn: true, tollIncluded: false });
    expect(result!.toll).toBe(0);
    expect(result!.totalBill).toBe(12000);
    expect(result!.myCost).toBe(4500);
    expect(result!.saving).toBe(7500);
  });

  it("saving is toll-invariant: include/exclude toggle never changes saving", () => {
    for (const isReturn of [false, true]) {
      const inc = calcQuoteV2({ ...v2base, isReturn, tollIncluded: true }).result!;
      const exc = calcQuoteV2({ ...v2base, isReturn, tollIncluded: false }).result!;
      expect(inc.saving).toBe(exc.saving);
    }
  });

  it("total-km override is flagged and used (150 km one-way)", () => {
    const { result } = calcQuoteV2({ ...v2base, totalKmOverride: 150 });
    expect(result!.totalKm).toBe(150);
    expect(result!.kmWasOverridden).toBe(true);
    expect(result!.fuelCost).toBe(3375); // 150/12 x 270
    expect(result!.rent).toBe(9000);
    expect(result!.toll).toBe(250);
    expect(result!.totalBill).toBe(9250);
    expect(result!.saving).toBe(5625); // 9250 - (3375 + 250)
  });

  it("extra cost adds to myCost and reduces saving; total bill unchanged", () => {
    const { result } = calcQuoteV2({ ...v2base, extraCost: 500 });
    expect(result!.totalBill).toBe(6250);
    expect(result!.myCost).toBe(3000); // 2250 + 250 + 500
    expect(result!.saving).toBe(3250);
    expect(result!.extraCost).toBe(500);
  });

  it("no plazas: tollOut/tollBack null -> toll 0, bill is rent alone", () => {
    const { result } = calcQuoteV2({ ...v2base, tollOut: null, tollBack: null });
    expect(result!.toll).toBe(0);
    expect(result!.totalBill).toBe(6000);
    expect(result!.saving).toBe(3750);
  });

  it("tollBack null on return: only tollOut is doubled in km, toll charged once", () => {
    const { result } = calcQuoteV2({ ...v2base, isReturn: true, tollBack: null });
    expect(result!.toll).toBe(250);
    expect(result!.totalBill).toBe(12250);
  });

  it("validation: missing rate / kmpl / price -> errors, no result; negative toll rejected", () => {
    expect(calcQuoteV2({ ...v2base, ratePerKm: null }).result).toBeNull();
    expect(calcQuoteV2({ ...v2base, avgKmpl: null }).errors.length).toBeGreaterThan(0);
    expect(calcQuoteV2({ ...v2base, petrolPricePerLitre: null }).result).toBeNull();
    expect(calcQuoteV2({ ...v2base, tollOut: -100 }).result).toBeNull();
    expect(calcQuoteV2({ ...v2base, extraCost: -50 }).result).toBeNull();
    expect(calcQuoteV2({ ...v2base, totalKmOverride: 0 }).result).toBeNull();
  });
});

describe("rounding — the Rs 1 trap", () => {
  it("does NOT round litres first: 200/12 x 270 = 4500, not 4501", () => {
    // 16.67 (rounded litres) x 270 = 4500.9 -> 4501. Exact litres give 4500.
    expect(round2(200 / 12)).toBe(16.67);
    expect(calcQuote(base).result!.fuelCost).toBe(4500);
  });
  it("roundPKR is half-up: 0.5 -> 1, 2.5 -> 3", () => {
    expect(roundPKR(0.5)).toBe(1);
    expect(roundPKR(2.5)).toBe(3);
    expect(roundPKR(4500.4)).toBe(4500);
  });
});

describe("validation: empty is not 0", () => {
  it("parseInput: '' -> null, 'abc' -> null, '0' -> 0, ' 270 ' -> 270", () => {
    expect(parseInput("")).toBeNull();
    expect(parseInput("   ")).toBeNull();
    expect(parseInput("abc")).toBeNull();
    expect(parseInput("12a")).toBeNull();
    expect(parseInput("0")).toBe(0);
    expect(parseInput(" 270 ")).toBe(270);
  });
  it("missing km / kmpl / price / rate -> errors, no result", () => {
    expect(calcQuote({ ...base, oneWayKm: null }).result).toBeNull();
    expect(calcQuote({ ...base, avgKmpl: null }).errors.length).toBeGreaterThan(0);
    expect(calcQuote({ ...base, petrolPricePerLitre: null }).result).toBeNull();
  });
  it("zero / negative inputs are rejected, never silently used", () => {
    expect(calcQuote({ ...base, oneWayKm: 0 }).result).toBeNull();
    expect(calcQuote({ ...base, avgKmpl: -5 }).result).toBeNull();
    expect(calcQuote({ ...base, petrolPricePerLitre: 0 }).result).toBeNull();
    expect(calcQuote({ ...base, toll: -100 }).result).toBeNull();
  });
  it("huge inputs do not crash and stay finite", () => {
    const { result } = calcQuote({ ...base, oneWayKm: 100000, ratePerKm: 100000 });
    expect(Number.isFinite(result!.customerRent)).toBe(true);
    expect(result!.customerRent).toBe(100000 * 200000);
  });
});

describe("settlement test vector (spec)", () => {
  it("income 50000, fuel 12000, other 3000 -> net 35000; 30% -> driver 10500, owner 24500", () => {
    const r = calcSettlement({ income: 50000, tripFuel: 12000, tripToll: 0, carExpensesAllowable: 3000, driverPct: 30 });
    expect(r.allowableExpenses).toBe(15000);
    expect(r.net).toBe(35000);
    expect(r.driverShare).toBe(10500);
    expect(r.ownerShare).toBe(24500);
  });
  it("percent applies to NET, never gross: 30% of 50000 would be 15000 (wrong)", () => {
    const r = calcSettlement({ income: 50000, tripFuel: 12000, tripToll: 3000, carExpensesAllowable: 0, driverPct: 30 });
    expect(r.driverShare).toBe(10500); // 30% of 35000 net, not 15000
  });
  it("driver + owner === net exactly (property test, 200 random nets/pcts)", () => {
    for (let i = 0; i < 200; i++) {
      const net = Math.floor(Math.random() * 200001) - 50000;
      const pct = Math.floor(Math.random() * 101);
      const r = calcSettlement({ income: Math.max(net, 0) + 10000, tripFuel: 10000, tripToll: 0, carExpensesAllowable: 0, driverPct: pct });
      // rebuild the same net via income-fuel: net = income-10000
      expect(r.driverShare + r.ownerShare).toBe(r.net);
    }
  });
  it("negative net: warning, driver share 0 by default, owner absorbs loss", () => {
    const r = calcSettlement({ income: 5000, tripFuel: 12000, tripToll: 0, carExpensesAllowable: 0, driverPct: 30 });
    expect(r.net).toBe(-7000);
    expect(r.negativeNetWarning).toBe(true);
    expect(r.driverShare).toBe(0);
    expect(r.ownerShare).toBe(-7000);
  });
  it("odd-rupee split never leaks 1 PKR: net 35001 at 30% -> 10500 + 24501", () => {
    const r = calcSettlement({ income: 45001, tripFuel: 10000, tripToll: 0, carExpensesAllowable: 0, driverPct: 30 });
    expect(r.net).toBe(35001);
    expect(r.driverShare).toBe(10500); // round(10500.3)
    expect(r.ownerShare).toBe(24501);
    expect(r.driverShare + r.ownerShare).toBe(35001);
  });
});

describe("double-count guard", () => {
  it("same trip in two settlements is flagged", () => {
    const dupes = findDoubleCountedIds([
      { tripIds: ["t1", "t2"], expenseIds: ["e1"] },
      { tripIds: ["t2", "t3"], expenseIds: ["e2"] },
    ]);
    expect(dupes).toEqual(["t2"]);
  });
  it("clean settlements return no dupes", () => {
    expect(findDoubleCountedIds([
      { tripIds: ["t1"], expenseIds: ["e1"] },
      { tripIds: ["t2"], expenseIds: ["e2"] },
    ])).toEqual([]);
  });
});

describe("haversine sanity check (never a quote value)", () => {
  it("Chichawatni -> Lahore straight line is ~192 km (OSRM road 236 km)", () => {
    const s = haversineKm(30.5354804, 72.6903375, 31.5656822, 74.3141829);
    expect(s).toBeGreaterThan(185);
    expect(s).toBeLessThan(200);
    expect(roadStraightRatio(236.35, s)).toBeGreaterThan(1);
    expect(roadStraightRatio(236.35, s)).toBeLessThan(2);
  });
  it("road km below straight-line km is impossible (ratio < 1)", () => {
    expect(roadStraightRatio(100, 192.48)).toBeLessThan(1);
  });
});

describe("week range Mon-Sun", () => {
  it("2026-11-09 is a Monday -> week is 2026-11-09..2026-11-15", () => {
    const w = weekRangeMonSun(new Date(2026, 10, 9));
    expect(w).toEqual({ start: "2026-11-09", end: "2026-11-15" });
  });
  it("2026-11-15 is a Sunday -> same week", () => {
    const w = weekRangeMonSun(new Date(2026, 10, 15));
    expect(w).toEqual({ start: "2026-11-09", end: "2026-11-15" });
  });
});

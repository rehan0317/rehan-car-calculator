import { describe, expect, it } from "vitest";
import { normalise, searchPlaces, tokenise } from "./search";

const places = [
  { id: "chichawatni", name: "Chichawatni", aliases: ["Chicha Watni"], category: "town" },
  { id: "chak-112-12l", name: "Chak 112/12-L", aliases: ["Chak 112 12L"], category: "village" },
  { id: "chak-123-9l", name: "Chak 123/9-L", aliases: [], category: "village" },
  { id: "lahore", name: "Lahore", aliases: [], category: "city" },
  { id: "sahiwal", name: "Sahiwal", aliases: [], category: "city" },
];

describe("normalise", () => {
  it("handles chak spellings", () => {
    expect(normalise("Chak 123 9L")).toBe("chak 123 9l");
    expect(normalise("123/9-L")).toBe("123 9 l");
    expect(normalise("Chicha Watni")).toBe("chicha watni");
  });
  it("tokenise splits digit/letter runs", () => {
    expect(tokenise("123 9l")).toEqual(["123", "9", "l"]);
    expect(tokenise("chak 123 9 l")).toEqual(["chak", "123", "9", "l"]);
  });
});

describe("searchPlaces", () => {
  it("prefix: 'lah' finds Lahore first", () => {
    const hits = searchPlaces("lah", places);
    expect(hits[0].item.id).toBe("lahore");
  });
  it("'chak 123 9L' finds Chak 123/9-L", () => {
    const hits = searchPlaces("chak 123 9L", places);
    expect(hits[0].item.id).toBe("chak-123-9l");
  });
  it("'123/9-L' (different spelling) finds the same place", () => {
    const hits = searchPlaces("123/9-L", places);
    expect(hits[0].item.id).toBe("chak-123-9l");
  });
  it("alias 'Chicha Watni' finds Chichawatni", () => {
    const hits = searchPlaces("chicha watni", places);
    expect(hits[0].item.id).toBe("chichawatni");
  });
  it("fuzzy typo 'lahor' still finds Lahore", () => {
    const hits = searchPlaces("lahor", places);
    expect(hits[0].item.id).toBe("lahore");
  });
  it("unknown place returns nothing (caller offers manual add)", () => {
    expect(searchPlaces("zzzzqqq", places)).toEqual([]);
  });
  it("fast over the real v2 seed: 17,328 places, '112' finds Chak 112/12L", async () => {
    const raw = (await import("../../public/data/places.json")).default as any[];
    expect(raw.length).toBe(17_328);
    const seed = raw.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases ?? [], category: p.type ?? "place" }));
    // One-time index build over the full seed (measured, not guessed).
    const tBuild = performance.now();
    searchPlaces("chak", seed);
    const buildMs = performance.now() - tBuild;
    console.log(`search index build over 17,328 places: ${buildMs.toFixed(1)} ms`);
    expect(buildMs).toBeLessThan(2000);
    // Per-keystroke after the index is built: <100 ms (spec C).
    const t0 = performance.now();
    const hits = searchPlaces("112", seed, 40);
    const dt = performance.now() - t0;
    console.log(`search "112" over 17,328 places: ${dt.toFixed(1)} ms, ${hits.length} hits`);
    expect(dt).toBeLessThan(100);
    expect(hits.some((h) => h.item.id === "osm-4427361666")).toBe(true); // Chak No 112/12.L
    expect(hits[0].item.name).toContain("112");
  });
  it("fast over 5,000 places (<100 ms per keystroke once the index is built)", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, name: `Chak ${i}/7-L`, aliases: [], category: "village" }));
    // First keystroke builds the index (one-time cost, ~90-165 ms on this
    // throttled sandbox VM); every keystroke after that reuses it.
    const tWarm = performance.now();
    searchPlaces("chak", big);
    const warmMs = performance.now() - tWarm;
    expect(warmMs).toBeLessThan(300);
    const t0 = performance.now();
    const hits = searchPlaces("chak 4321 7l", big);
    const dt = performance.now() - t0;
    expect(hits[0].item.id).toBe("p4321");
    expect(dt).toBeLessThan(100);
  });
});

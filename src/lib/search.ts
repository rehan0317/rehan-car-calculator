/** Search: normalised prefix + fuzzy, handles "chak 123 9L" / "123/9-L".
 *  Pure module, no UI imports. Target: <100 ms over 5,000+ places. */

export interface SearchablePlace {
  id: string;
  name: string;
  aliases?: string[];
  category?: string;
}

/** Normalise: lowercase, strip diacritics, collapse separators, expand chak forms.
 *  "Chak 123 9L" -> "chak 123 9l"; "123/9-L" -> "123 9 l"; "Chicha Watni" -> "chicha watni". */
export function normalise(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(chak|chk)\b/g, "chak")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a normalised string into tokens, splitting digit/letter runs too:
 *  "1239l" -> ["123", "9", "l"]; "9l" -> ["9", "l"]. */
export function tokenise(norm: string): string[] {
  const out: string[] = [];
  for (const part of norm.split(" ")) {
    if (!part) continue;
    // split letter/digit boundaries: "1239l" -> 123, 9, l
    const pieces = part.match(/[a-z]+|[0-9]+/g);
    if (pieces) out.push(...pieces);
    else out.push(part);
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface SearchHit<T> { item: T; score: number }

/** Precomputed index per places array (WeakMap: same array reused across
 *  keystrokes, so normalise/tokenise run once, not once per query). */
interface IndexedPlace<T> { item: T; names: string[]; tokens: string[][] }
const indexCache = new WeakMap<object, IndexedPlace<any>[]>();

function indexPlaces<T extends SearchablePlace>(places: T[]): IndexedPlace<T>[] {
  const hit = indexCache.get(places);
  if (hit) return hit as IndexedPlace<T>[];
  const indexed: IndexedPlace<T>[] = places.map((p) => {
    const names = [p.name, ...(p.aliases ?? [])].map(normalise);
    return { item: p, names, tokens: names.map(tokenise) };
  });
  indexCache.set(places, indexed);
  return indexed;
}

export function searchPlaces<T extends SearchablePlace>(query: string, places: T[], limit = 20): SearchHit<T>[] {
  const q = normalise(query);
  if (!q) return places.slice(0, limit).map((item) => ({ item, score: 0 }));
  const qtokens = tokenise(q);
  const hits: SearchHit<T>[] = [];
  for (const p of indexPlaces(places)) {
    let best = -1;
    for (let ni = 0; ni < p.names.length; ni++) {
      const nn = p.names[ni];
      let score = -1;
      if (nn === q) score = 100;
      else if (nn.startsWith(q)) score = 90;
      else if (nn.includes(q)) score = 70;
      else {
        const ntokens = p.tokens[ni];
        const allPrefix = qtokens.every((qt) => ntokens.some((nt) => nt.startsWith(qt)));
        if (allPrefix) score = 80;
        else {
          // Fuzzy is the expensive step: gate it hard. Only alphabetic
          // query tokens length >= 3, and only when a name token shares
          // the first 2 letters (cheap pre-filter before Levenshtein).
          const fuzzyOk = qtokens.every(
            (qt) =>
              /^[a-z]{3,}$/.test(qt) &&
              ntokens.some((nt) => nt.slice(0, 2) === qt.slice(0, 2) && levenshtein(qt, nt) <= (qt.length <= 4 ? 1 : 2)),
          );
          if (fuzzyOk) score = 50;
        }
      }
      if (score > best) best = score;
    }
    if (best >= 0) hits.push({ item: p.item, score: best });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return hits.slice(0, limit);
}

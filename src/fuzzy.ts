// Vendored high-power fuzzy matcher (uFuzzy-class behavior, zero deps).
// Operates on already-normalized strings; caller limits candidate set.
//
// Power features:
//  - exact / prefix / infix fast paths with position bonuses
//  - subsequence contiguity + word-boundary bonuses
//  - typo tolerance: Damerau-Levenshtein <= 2 on a sliding window (handles
//    substitution, omission, insertion, adjacent transposition — e.g.
//    `gpt-6-sol` ~ `gpt6sol`, `models` ~ `modles`)
//  - returns match spans so the UI can <mark> exactly what matched,
//    even when the match is fuzzy (not a plain substring).

export interface FuzzyHit { score: number; spans?: Array<[number, number]> }

/** Score needle against haystack (both pre-normalized). Returns 0 when no match. */
export function fuzzyScore(needle: string, hay: string): number {
  return fuzzyMatch(needle, hay).score;
}

/** Full match with spans (spans are [start,end) in *normalized hay* coords). */
export function fuzzyMatch(needle: string, hay: string): FuzzyHit {
  if (!needle || !hay) return { score: 0 };
  if (hay === needle) return { score: 1, spans: [[0, hay.length]] };
  const nl = needle.length, hl = hay.length;
  if (nl > hl) return { score: 0 };
  if (nl <= 1) {
    const at = hay.indexOf(needle);
    return at >= 0 ? { score: 0.4, spans: [[at, at + 1]] } : { score: 0 };
  }

  // Fast: contiguous substring of normalized haystack ranks very high.
  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    const atStart = idx === 0 ? 0.06 : 0;
    const boundary = idx > 0 && isBoundary(hay[idx - 1]) ? 0.02 : 0;
    const shortBonus = Math.max(0, 0.08 - hl * 0.0002);
    return { score: Math.min(0.99, 0.85 + atStart + boundary + shortBonus), spans: [[idx, idx + nl]] };
  }

  // Prefix-of-token: needle is a prefix of a longer token in hay
  // (gpt6 ~ gpt6astra). Cheap scan for `needle` at a token start.
  {
    let from = 0;
    while (from < hl) {
      const at = hay.indexOf(needle[0], from);
      if (at < 0) break;
      if (at === 0 || isBoundary(hay[at - 1])) {
        let k = 0;
        while (k < nl && at + k < hl && hay[at + k] === needle[k]) k++;
        // allow 1 typo inside the prefix window
        if (k >= nl - 1 && k >= 2) {
          const typo = k === nl ? 0 : 1;
          const cov = nl / hl;
          const s = Math.min(0.88, 0.72 + cov * 0.1 + (at === 0 ? 0.05 : 0) - typo * 0.12);
          return { score: s, spans: [[at, Math.min(hl, at + nl + 1)]] };
        }
      }
      from = at + 1;
      if (from > hl - 1) break;
    }
  }

  // Typo-tolerant sliding window (Damerau-Levenshtein <= 2).
  // Window sizes: nl-2 .. nl+2, step through hay. Bounded: O(hl) windows,
  // each O(nl * w) with nl<=64 — fast for the reduced candidate set.
  const typo = typoWindowScore(needle, hay);
  // Subsequence scan with bonuses for contiguity + boundaries.
  const sub = subsequenceScore(needle, hay);

  if (typo.score >= sub.score && typo.score > 0) return typo;
  return sub;
}

function isBoundary(ch: string | undefined): boolean {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  // normalized strings are mostly [a-z0-9]; treat digit<->letter transitions as boundaries too
  return !((c >= 97 && c <= 122) || (c >= 48 && c <= 57));
}

function subsequenceScore(needle: string, hay: string): FuzzyHit {
  const nl = needle.length, hl = hay.length;
  let ni = 0, hi = 0, score = 0, consec = 0, firstPos = -1;
  const spans: Array<[number, number]> = [];
  let runStart = -1;
  while (ni < nl && hi < hl) {
    if (needle.charCodeAt(ni) === hay.charCodeAt(hi)) {
      if (firstPos < 0) firstPos = hi;
      if (runStart < 0) runStart = hi;
      consec++;
      const boundary = hi === 0 || isBoundary(hay[hi - 1]) ? 3 : 0;
      score += 6 + consec * 3 + boundary;
      ni++;
    } else {
      if (runStart >= 0) { spans.push([runStart, hi]); runStart = -1; }
      consec = 0;
      score -= 0.4; // gap penalty
      if (hl - hi < nl - ni) return { score: 0 };
    }
    hi++;
  }
  if (ni < nl) return { score: 0 };
  if (runStart >= 0) spans.push([runStart, hi]);
  const coverage = nl / hl;
  const posPenalty = firstPos > 40 ? 0.82 : firstPos > 10 ? 0.92 : 1;
  const raw = (score / (hl * 0.9 + nl * 6)) * (0.35 + 0.65 * Math.min(1, coverage * 4));
  const s = Math.max(0.01, Math.min(0.84, raw * posPenalty));
  return { score: s, spans: mergeSpans(spans).slice(0, 8) };
}

function typoWindowScore(needle: string, hay: string): FuzzyHit {
  const nl = needle.length, hl = hay.length;
  if (nl < 3 || nl > 64) return { score: 0 };
  // Max dist scales with query length: short queries get 1, longer get 2.
  const maxDist = nl <= 5 ? 1 : 2;
  const winSizes = [nl];
  if (nl + 1 <= hl) winSizes.push(nl + 1);
  if (nl - 1 >= 3) winSizes.push(nl - 1);
  if (nl + 2 <= hl && nl >= 6) winSizes.push(nl + 2);
  let best = -1, bestDist = 99, bestW = 0;
  // Stride 1 but cap windows scanned for very long hays (records are <=320 chars).
  const maxWindows = Math.min(hl, 320);
  for (const w of winSizes) {
    for (let s = 0; s + w <= Math.min(hl, maxWindows); s++) {
      // quick first-char filter: window must share first char (or 1-off)
      // to avoid full DP on hopeless windows.
      let hint = 0;
      if (hay[s] !== needle[0]) {
        // allow if second char matches (transposition/omission at pos 0)
        if (hay[s] !== needle[1] && (w < 2 || hay[s + 1] !== needle[0])) continue;
        hint = 1;
      }
      void hint;
      const d = damerauBounded(needle, hay, s, w, maxDist);
      if (d <= maxDist && (d < bestDist || (d === bestDist && s < best))) {
        bestDist = d; best = s; bestW = w;
        if (d === 0) break;
      }
    }
    if (bestDist === 0) break;
  }
  if (best < 0) return { score: 0 };
  const atStart = best === 0 ? 0.06 : 0;
  const cov = nl / hl;
  const base = 0.78 - bestDist * 0.13;
  const s = Math.max(0.3, Math.min(0.84, base + atStart + Math.min(0.06, cov * 0.2)));
  return { score: s, spans: [[best, best + bestW]] };
}

/** Damerau-Levenshtein (adjacent transposition) between needle and hay[s:s+w], early-exit > maxDist. */
function damerauBounded(needle: string, hay: string, s: number, w: number, maxDist: number): number {
  const n = needle.length;
  // prev rows for DP with transposition (optimal string alignment variant)
  let prev2 = new Array<number>(w + 1);
  let prev = new Array<number>(w + 1);
  let cur = new Array<number>(w + 1);
  for (let j = 0; j <= w; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const nc = needle.charCodeAt(i - 1);
    for (let j = 1; j <= w; j++) {
      const hc = hay.charCodeAt(s + j - 1);
      const cost = nc === hc ? 0 : 1;
      let v = prev[j - 1] + cost;
      const del = prev[j] + 1;
      if (del < v) v = del;
      const ins = cur[j - 1] + 1;
      if (ins < v) v = ins;
      // adjacent transposition
      if (i > 1 && j > 1 && nc === hay.charCodeAt(s + j - 2) && needle.charCodeAt(i - 2) === hc) {
        const tr = prev2[j - 2] + 1;
        if (tr < v) v = tr;
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1; // early exit
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[w];
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  if (spans.length <= 1) return spans;
  spans.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = out[out.length - 1];
    if (spans[i][0] <= last[1] + 1) last[1] = Math.max(last[1], spans[i][1]);
    else out.push(spans[i]);
  }
  return out;
}

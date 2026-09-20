// Normalization: fold case + separators, preserve original elsewhere.
// gpt-6, gpt6, GPT_6, gpt.6  ->  "gpt6"

export function normalize(s: string): string {
  // Fast path: short strings
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // ASCII uppercase -> lowercase
    if (c >= 65 && c <= 90) { out += String.fromCharCode(c + 32); continue; }
    // separators dropped entirely (so gpt-6 == gpt6)
    if (
      c === 45 || c === 95 || c === 46 || c === 47 || c === 92 || c === 58 ||
      c === 59 || c === 124 || c === 43 || c === 126 || c === 42 || c === 37 || c === 32
    ) continue;
    out += s[i];
  }
  return out;
}

/**
 * Normalize + keep a map from normalized index -> original index so fuzzy
 * spans (computed in normalized space) can be highlighted in the ORIGINAL
 * string exactly as found.
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) { norm += String.fromCharCode(c + 32); map.push(i); continue; }
    if (
      c === 45 || c === 95 || c === 46 || c === 47 || c === 92 || c === 58 ||
      c === 59 || c === 124 || c === 43 || c === 126 || c === 42 || c === 37 || c === 32
    ) continue;
    norm += s[i];
    map.push(i);
  }
  return { norm, map };
}

/** Char trigrams of a normalized string — used for the typo-tolerant prefilter. */
export function trigrams(norm: string): string[] {
  if (norm.length < 3) return norm.length ? [norm] : [];
  const out: string[] = [];
  for (let i = 0; i + 3 <= norm.length && out.length < 64; i++) out.push(norm.slice(i, i + 3));
  return out;
}

export function hashStr(s: string): number {
  // FNV-1a 32-bit, fast + compact for dedupe maps
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function snippet(text: string, start: number, len: number, radius = 60): { context: string; matchStart: number; matchLen: number } {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, start + len + radius);
  return { context: text.slice(a, b), matchStart: start - a, matchLen: len };
}

/**
 * Build a ~120-char context window around norm-space spans, mapped back to
 * ORIGINAL offsets so <mark> highlights the exact found text.
 * spansNorm: [start,end) in normalized coords; normMap: norm idx -> orig idx.
 */
export function snippetWithSpans(
  text: string,
  normMap: number[],
  spansNorm: Array<[number, number]>,
  radius = 60,
): { context: string; marks: Array<[number, number]> } {
  if (!spansNorm.length || !normMap.length) {
    return { context: text.slice(0, 140), marks: [[0, Math.min(text.length, 24)]] };
  }
  // Map to original offsets (inclusive start, exclusive end).
  const spansOrig: Array<[number, number]> = [];
  for (const [ns, ne] of spansNorm) {
    const os = normMap[Math.max(0, ns)] ?? 0;
    const oeIdx = Math.min(normMap.length - 1, Math.max(ns, ne - 1));
    const oe = (normMap[oeIdx] ?? text.length - 1) + 1;
    if (oe > os) spansOrig.push([os, Math.min(text.length, oe)]);
  }
  if (!spansOrig.length) return { context: text.slice(0, 140), marks: [] };
  spansOrig.sort((a, b) => a[0] - b[0]);
  const first = spansOrig[0][0];
  const last = spansOrig[spansOrig.length - 1][1];
  const a = Math.max(0, first - radius);
  const b = Math.min(text.length, last + radius);
  const marks = spansOrig
    .map(([s, e]) => [Math.max(0, s - a), Math.min(b - a, e - a)] as [number, number])
    .filter(([s, e]) => e > s);
  return { context: text.slice(a, b), marks };
}

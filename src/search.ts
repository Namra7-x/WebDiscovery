// Staged search pipeline (v1.2 — most efficient + most powerful):
//  1. exact/substring candidate lookup (token index + prefix sweep + trigram union)
//  2. normalized matching
//  3. fuzzy ranking ONLY on reduced candidate set (typo-tolerant, spans kept)
//  4. regex as separate explicit mode (bounded scan)
import { fuzzyMatch } from './fuzzy.js';
import { normalize, normalizeWithMap, snippet, snippetWithSpans } from './normalize.js';
import type { SearchMode, SearchResult, SearchScope, TextRecord } from './types.js';
import { scopeAllows } from './types.js';
import type { RamIndex } from './indexer.js';

export interface SearchOptions {
  mode: SearchMode;
  scope: SearchScope;
  limit?: number;
  fuzzyThreshold?: number;
}

function inScope(r: TextRecord, scope: SearchScope): boolean {
  return scopeAllows(r.prov.resourceKind, scope);
}

export function searchIndex(index: RamIndex, rawQuery: string, opts: SearchOptions): SearchResult[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  const q = rawQuery;
  if (!q) return [];
  const qNorm = normalize(q);
  const out: SearchResult[] = [];

  if (opts.mode === 'regex') {
    let re: RegExp;
    try { re = new RegExp(q, 'g'); } catch { return []; }
    // Bounded newest-first scan so regex over huge indexes stays interactive.
    const recs = index.records;
    for (let i = recs.length - 1; i >= 0 && out.length < limit; i--) {
      const r = recs[i];
      if (!inScope(r, opts.scope)) continue;
      re.lastIndex = 0;
      const m = re.exec(r.text);
      if (m && m[0]) {
        const s = snippet(r.text, m.index, m[0].length);
        out.push({
          recordId: r.id, text: r.text, score: 0.95, mode: 'regex', prov: r.prov,
          context: s.context, matchStart: s.matchStart, matchLen: s.matchLen,
          marks: [[s.matchStart, s.matchStart + s.matchLen]],
        });
      }
      if (recs.length - i > 60000) break;
    }
    return out;
  }

  const candIds = index.candidatesFor(qNorm, opts.mode === 'fuzzy' ? 4000 : 2500);
  const recs = index.records;

  if (opts.mode === 'exact') {
    for (const i of candIds) {
      const r = recs[i];
      if (!r || !inScope(r, opts.scope)) continue;
      const at = r.text.indexOf(q);
      if (at >= 0) {
        const s = snippet(r.text, at, q.length);
        out.push({
          recordId: r.id, text: r.text, score: 1, mode: 'exact', prov: r.prov,
          context: s.context, matchStart: s.matchStart, matchLen: s.matchLen,
          marks: [[s.matchStart, s.matchStart + s.matchLen]],
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  if (opts.mode === 'substring' || opts.mode === 'normalized') {
    const caseFolded = q.toLowerCase();
    for (const i of candIds) {
      const r = recs[i];
      if (!r || !inScope(r, opts.scope)) continue;
      let at = -1, mlen = q.length, score = 0.9;
      if (opts.mode === 'substring') {
        at = r.text.toLowerCase().indexOf(caseFolded);
        if (at < 0) continue;
        score = r.text.includes(q) ? 1 : 0.92;
      } else {
        at = r.norm.indexOf(qNorm);
        if (at < 0) continue;
        // Map normalized hit back to original approx: highlight whole string window
        score = 0.88;
        // Prefer true original hits
        if (r.text.toLowerCase().includes(caseFolded)) score = 0.95;
        // Locate original position best-effort for context highlight
        const origAt = r.text.toLowerCase().indexOf(caseFolded);
        const s = origAt >= 0
          ? snippet(r.text, origAt, q.length)
          : { context: r.text.slice(0, 140), matchStart: 0, matchLen: Math.min(r.text.length, q.length) };
        out.push({
          recordId: r.id, text: r.text, score, mode: opts.mode, prov: r.prov,
          context: s.context, matchStart: s.matchStart, matchLen: s.matchLen,
          marks: [[s.matchStart, s.matchStart + s.matchLen]],
        });
        if (out.length >= limit) break;
        continue;
      }
      const s = snippet(r.text, at, mlen);
      out.push({
        recordId: r.id, text: r.text, score, mode: opts.mode, prov: r.prov,
        context: s.context, matchStart: s.matchStart, matchLen: s.matchLen,
        marks: [[s.matchStart, s.matchStart + s.matchLen]],
      });
      if (out.length >= limit) break;
    }
    // Normalized mode: also accept fuzzy-adjacent separator variants still in candidates
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // fuzzy: score reduced candidate set only (typo-tolerant, spans preserved)
  const threshold = opts.fuzzyThreshold ?? 0.12;
  const scored: Array<{ r: TextRecord; s: number; spans: Array<[number, number]> }> = [];
  for (const i of candIds) {
    const r = recs[i];
    if (!r || !inScope(r, opts.scope)) continue;
    const hit = fuzzyMatch(qNorm, r.norm);
    if (hit.score < threshold) continue;
    let s = hit.score;
    if (r.text.includes(q)) s = Math.min(1, s + 0.15);
    else if (r.text.toLowerCase().includes(q.toLowerCase())) s = Math.min(1, s + 0.08);
    // Prefix/infix bonus: record STARTS WITH the query (clean names rank first).
    if (r.norm.startsWith(qNorm)) s = Math.min(1, s + 0.05);
    scored.push({ r, s, spans: hit.spans ?? [] });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const { r, s, spans } of scored.slice(0, limit)) {
    // Map normalized spans back to ORIGINAL offsets for exact <mark> highlight.
    const { map } = normalizeWithMap(r.text);
    const snip = spans.length
      ? snippetWithSpans(r.text, map, spans)
      : { context: r.text.slice(0, 140), marks: [[0, Math.min(r.text.length, 24)] as [number, number]] };
    const first = snip.marks[0] ?? [0, Math.min(snip.context.length, q.length)];
    out.push({
      recordId: r.id, text: r.text, score: Math.round(s * 1000) / 1000, mode: 'fuzzy',
      prov: r.prov, context: snip.context,
      matchStart: first[0], matchLen: Math.max(1, first[1] - first[0]),
      marks: snip.marks,
    });
  }
  return out;
}

/**
 * Clean display name for a hit: the original string, trimmed to a readable
 * single line (result title). Provenance (where it came from) is rendered
 * separately via formatProvenance().
 */
export function displayNameFor(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatProvenance(r: Pick<SearchResult, 'prov' | 'text'>): string {
  const p = r.prov;
  const loc = p.line && p.line > 0 ? ` → line ${p.line}${p.column && p.column > 0 ? `:${p.column}` : ''}` : '';
  const jp = p.jsonPath ? ` → JSON ${p.jsonPath}` : '';
  const init = p.initiator ? ` (initiator ${shortUrl(p.initiator)})` : '';
  return `${shortUrl(p.resourceUrl)} → route ${p.route} → via ${p.method}${loc}${jp}${init}`;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 60 ? `…${x.pathname.slice(-59)}` : x.pathname;
    return `${x.host}${p}`;
  } catch { return u.length > 80 ? `…${u.slice(-79)}` : u; }
}

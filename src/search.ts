// Staged search pipeline (v1.2 — most efficient + most powerful):
//  1. exact/substring candidate lookup (token index + prefix sweep + trigram union)
//  2. normalized matching
//  3. fuzzy ranking ONLY on reduced candidate set (typo-tolerant, spans kept)
//  4. regex as separate explicit mode (bounded scan)
//  5. Universal Multi-Surface Search: response bodies, request payloads, headers,
//     source maps, client state stores, and AST tokens.
import { fuzzyMatch } from './fuzzy.js';
import { normalize, normalizeWithMap, snippet, snippetWithSpans } from './normalize.js';
export { snippet };
import type { DiscoveryMethod, NetEntry, Provenance, ResourceKind, SearchMode, SearchResult, SearchScope, Severity, TextRecord } from './types.js';
import { scopeAllows } from './types.js';
import type { RamIndex } from './indexer.js';
import type { SourceMapFile } from './sourcemap.js';

export interface SearchOptions {
  mode: SearchMode;
  scope: SearchScope;
  limit?: number;
  fuzzyThreshold?: number;
}

export interface MultiSurfaceSearchInputs {
  index: RamIndex;
  rawBodies?: Map<string, string>;
  netEntries?: NetEntry[];
  reconstructedSourceFiles?: Map<string, SourceMapFile>;
  routes?: Map<string, { method: DiscoveryMethod | string; count: number }>;
  harvestData?: {
    identities?: Array<{ key: string; val: string; source: string }>;
    tokens?: Array<{ key: string; val: string; source: string }>;
    endpoints?: Array<{ url: string; source: string }>;
    stores?: Array<{ name: string; keys: string[] }>;
  } | null;
  secFindings?: Array<{ text: string; prov: Provenance; rule: string; sev: Severity; label: string }>;
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
 * Fast search helper that finds match offsets and scores inside arbitrary text.
 */
function findMatchesInText(
  text: string,
  query: string,
  mode: SearchMode,
  maxMatches = 5,
): Array<{ at: number; len: number; score: number }> {
  if (!text || !query) return [];
  const results: Array<{ at: number; len: number; score: number }> = [];

  if (mode === 'exact') {
    let pos = 0;
    while ((pos = text.indexOf(query, pos)) !== -1) {
      results.push({ at: pos, len: query.length, score: 1.0 });
      pos += Math.max(1, query.length);
      if (results.length >= maxMatches) break;
    }
  } else if (mode === 'regex') {
    try {
      const re = new RegExp(query, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        results.push({ at: m.index, len: m[0].length, score: 0.95 });
        if (results.length >= maxMatches) break;
      }
    } catch { /* invalid regex */ }
  } else {
    // Zero-allocation case-insensitive search via native V8 RegExp engine
    try {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const score = m[0] === query ? 1.0 : 0.92;
        results.push({ at: m.index, len: m[0].length, score });
        if (results.length >= maxMatches) break;
      }
    } catch {
      // Fallback if RegExp construction fails
      const lowerQuery = query.toLowerCase();
      const lowerText = text.toLowerCase();
      let pos = 0;
      while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
        const score = text.slice(pos, pos + query.length) === query ? 1.0 : 0.92;
        results.push({ at: pos, len: query.length, score });
        pos += Math.max(1, query.length);
        if (results.length >= maxMatches) break;
      }
    }
  }
  return results;
}

/**
 * Universal Multi-Surface Search:
 * Scans across Response Bodies, Request Payloads, Headers, Source Code,
 * Client Memory Stores, and AST Tokens with 0 duplicate RAM overhead.
 */
export function searchAllSurfaces(
  inputs: MultiSurfaceSearchInputs,
  rawQuery: string,
  opts: SearchOptions,
): SearchResult[] {
  const limit = Math.min(opts.limit ?? 200, 500);
  let q = (rawQuery || '').trim();
  if (!q) return [];

  let targetSurface: 'all' | 'body' | 'req' | 'source' | 'state' | 'header' | 'url' | 'route' = 'all';
  const prefixMatch = /^(?:in|scope|surface):(body|res|response|req|request|source|code|state|store|header|url|route)\s+/i.exec(q);
  if (prefixMatch) {
    const p = prefixMatch[1].toLowerCase();
    if (p === 'body' || p === 'res' || p === 'response') targetSurface = 'body';
    else if (p === 'req' || p === 'request') targetSurface = 'req';
    else if (p === 'source' || p === 'code') targetSurface = 'source';
    else if (p === 'state' || p === 'store') targetSurface = 'state';
    else if (p === 'header') targetSurface = 'header';
    else if (p === 'url') targetSurface = 'url';
    else if (p === 'route') targetSurface = 'route';
    q = q.slice(prefixMatch[0].length).trim();
  }
  if (!q) return [];

  const out: SearchResult[] = [];
  let syntheticId = -1;

  // 1. Search Response Bodies (rawBodies: HTML home page, API JSON, scripts, text)
  if ((targetSurface === 'all' || targetSurface === 'body') && opts.scope.resBody !== false && inputs.rawBodies) {
    let bodyHits = 0;
    for (const [url, bodyText] of inputs.rawBodies) {
      if (bodyHits >= 100 || out.length >= limit) break;
      if (!bodyText || typeof bodyText !== 'string') continue;
      const matches = findMatchesInText(bodyText, q, opts.mode, 3);
      for (const m of matches) {
        const snip = snippet(bodyText, m.at, m.len);
        let line = 1;
        for (let j = 0; j < m.at; j++) if (bodyText.charCodeAt(j) === 10) line++;

        const isJs = url.includes('.js') || url.includes('.mjs');
        const isHtml = url.includes('.html') || (!url.includes('.') && !url.includes('/api/'));
        const isCss = url.includes('.css');
        const kind: ResourceKind = isJs ? 'script' : (isCss ? 'stylesheet' : (isHtml ? 'document' : 'api-json'));

        out.push({
          recordId: syntheticId--,
          text: snip.context,
          score: m.score,
          mode: opts.mode,
          prov: {
            resourceUrl: url,
            resourceKind: kind,
            route: '/',
            method: 'devtools-network',
            detail: 'response-body',
            line,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
        bodyHits++;
        if (bodyHits >= 100 || out.length >= limit) break;
      }
    }
  }

  // 2. Search Request Payloads (netEntries.reqBody: sent POST/PUT/PATCH data)
  if ((targetSurface === 'all' || targetSurface === 'req') && opts.scope.reqBody !== false && inputs.netEntries) {
    let reqHits = 0;
    for (const entry of inputs.netEntries) {
      if (reqHits >= 50 || out.length >= limit) break;
      if (!entry.reqBody) continue;
      const matches = findMatchesInText(entry.reqBody, q, opts.mode, 2);
      for (const m of matches) {
        const snip = snippet(entry.reqBody, m.at, m.len);
        out.push({
          recordId: syntheticId--,
          text: snip.context,
          score: m.score,
          mode: opts.mode,
          prov: {
            resourceUrl: entry.url,
            resourceKind: 'api-json',
            route: entry.route || '/',
            method: 'devtools-network',
            detail: `request-body (${entry.method})`,
            initiator: entry.initiator,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
        reqHits++;
        if (reqHits >= 50 || out.length >= limit) break;
      }
    }
  }

  // 3. Search Headers & URLs
  if (inputs.netEntries) {
    let headerHits = 0;
    for (const entry of inputs.netEntries) {
      if (headerHits >= 40 || out.length >= limit) break;
      if ((targetSurface === 'all' || targetSurface === 'url') && opts.scope.urls !== false) {
        const uMatches = findMatchesInText(entry.url, q, opts.mode, 1);
        if (uMatches.length) {
          const snip = snippet(entry.url, uMatches[0].at, uMatches[0].len);
          out.push({
            recordId: syntheticId--,
            text: entry.url,
            score: 0.98,
            mode: opts.mode,
            prov: {
              resourceUrl: entry.url,
              resourceKind: 'url',
              route: entry.route || '/',
              method: 'devtools-network',
              detail: `url (${entry.method})`,
            },
            context: snip.context,
            matchStart: snip.matchStart,
            matchLen: snip.matchLen,
            marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
          });
          headerHits++;
        }
      }
      if ((targetSurface === 'all' || targetSurface === 'header') && (opts.scope.reqHeaders !== false || opts.scope.resHeaders !== false)) {
        const checkHeaders = (hdrs: Record<string, string> | undefined, isRes: boolean): void => {
          if (!hdrs) return;
          for (const [k, v] of Object.entries(hdrs)) {
            const hLine = `${k}: ${v}`;
            const hMatches = findMatchesInText(hLine, q, opts.mode, 1);
            if (hMatches.length) {
              const snip = snippet(hLine, hMatches[0].at, hMatches[0].len);
              out.push({
                recordId: syntheticId--,
                text: hLine,
                score: 0.92,
                mode: opts.mode,
                prov: {
                  resourceUrl: entry.url,
                  resourceKind: 'header',
                  route: entry.route || '/',
                  method: 'devtools-network',
                  detail: isRes ? 'response-header' : 'request-header',
                },
                context: snip.context,
                matchStart: snip.matchStart,
                matchLen: snip.matchLen,
                marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
              });
              headerHits++;
              if (headerHits >= 40 || out.length >= limit) break;
            }
          }
        };
        if (opts.scope.reqHeaders !== false) checkHeaders(entry.reqHeaders, false);
        if (opts.scope.resHeaders !== false) checkHeaders(entry.resHeaders, true);
      }
    }
  }

  // 3b. Search Discovered Routes
  if ((targetSurface === 'all' || targetSurface === 'url' || targetSurface === 'route') && opts.scope.routes !== false && inputs.routes) {
    let routeHits = 0;
    for (const [rUrl, rInfo] of inputs.routes) {
      if (routeHits >= 40 || out.length >= limit) break;
      const rMatches = findMatchesInText(rUrl, q, opts.mode, 1);
      if (rMatches.length) {
        const snip = snippet(rUrl, rMatches[0].at, rMatches[0].len);
        out.push({
          recordId: syntheticId--,
          text: rUrl,
          score: 0.99,
          mode: opts.mode,
          prov: {
            resourceUrl: rUrl,
            resourceKind: 'route',
            route: rUrl,
            method: (rInfo.method as DiscoveryMethod) || 'router',
            detail: 'discovered-route',
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
        routeHits++;
      }
    }
  }

  // 4. Search Reconstructed Source Code (original unminified .ts/.tsx files)
  if ((targetSurface === 'all' || targetSurface === 'source') && opts.scope.sourcemaps !== false && inputs.reconstructedSourceFiles) {
    let srcHits = 0;
    for (const [path, sf] of inputs.reconstructedSourceFiles) {
      if (srcHits >= 60 || out.length >= limit) break;
      if (!sf.content) continue;
      const matches = findMatchesInText(sf.content, q, opts.mode, 2);
      for (const m of matches) {
        const snip = snippet(sf.content, m.at, m.len);
        let line = 1;
        for (let j = 0; j < m.at; j++) if (sf.content.charCodeAt(j) === 10) line++;
        out.push({
          recordId: syntheticId--,
          text: snip.context,
          score: m.score,
          mode: opts.mode,
          prov: {
            resourceUrl: `#${path}`,
            resourceKind: 'source-map',
            route: '/',
            method: 'sourcemap-ref',
            detail: `source-code (${path})`,
            line,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
        srcHits++;
        if (srcHits >= 60 || out.length >= limit) break;
      }
    }
  }

  // 5. Search Client State (Zustand, Redux, Pinia, Identities, Tokens)
  if ((targetSurface === 'all' || targetSurface === 'state') && inputs.harvestData) {
    const hd = inputs.harvestData;
    for (const s of (hd.stores || [])) {
      const storeStr = `${s.name}: ${s.keys.join(', ')}`;
      const sMatches = findMatchesInText(storeStr, q, opts.mode, 1);
      if (sMatches.length) {
        const snip = snippet(storeStr, sMatches[0].at, sMatches[0].len);
        out.push({
          recordId: syntheticId--,
          text: storeStr,
          score: 0.95,
          mode: opts.mode,
          prov: {
            resourceUrl: `[state:${s.name}]`,
            resourceKind: 'other-text',
            route: '/',
            method: 'live-fetch',
            detail: `client-store (${s.name})`,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
      }
    }
    for (const id of (hd.identities || [])) {
      const idStr = `${id.key}: ${id.val}`;
      const idMatches = findMatchesInText(idStr, q, opts.mode, 1);
      if (idMatches.length) {
        const snip = snippet(idStr, idMatches[0].at, idMatches[0].len);
        out.push({
          recordId: syntheticId--,
          text: idStr,
          score: 0.96,
          mode: opts.mode,
          prov: {
            resourceUrl: `[state:${id.source}]`,
            resourceKind: 'other-text',
            route: '/',
            method: 'live-fetch',
            detail: `user-identity (${id.key})`,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
      }
    }
    for (const tok of (hd.tokens || [])) {
      const tokStr = `${tok.key}: ${tok.val}`;
      const tokMatches = findMatchesInText(tokStr, q, opts.mode, 1);
      if (tokMatches.length) {
        const snip = snippet(tokStr, tokMatches[0].at, tokMatches[0].len);
        out.push({
          recordId: syntheticId--,
          text: tokStr,
          score: 0.96,
          mode: opts.mode,
          prov: {
            resourceUrl: `[state:${tok.source}]`,
            resourceKind: 'other-text',
            route: '/',
            method: 'live-fetch',
            detail: `token-credential (${tok.key})`,
          },
          context: snip.context,
          matchStart: snip.matchStart,
          matchLen: snip.matchLen,
          marks: [[snip.matchStart, snip.matchStart + snip.matchLen]],
        });
      }
    }
  }

  // 6. Pre-indexed AST tokens (RamIndex)
  if (targetSurface === 'all' && inputs.index && out.length < limit) {
    const idxHits = searchIndex(inputs.index, q, opts);
    for (const h of idxHits) {
      out.push(h);
      if (out.length >= limit) break;
    }
  }

  // Deduplicate by text + resourceUrl
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of out) {
    const key = `${r.prov.resourceUrl}::${r.context}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  deduped.sort((a, b) => b.score - a.score);
  return deduped.slice(0, limit);
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

// Lightweight regex + state-machine extractors — no heavy compiler in default path.
// Goal: turn MB-scale JS/CSS/HTML/JSON into compact searchable units with
// provenance-friendly offsets, without fuzzy-scanning the whole blob.
//
// v1.2: two-pass JS literal scan so NO route/API hides in chunks/assets/bundles:
//   pass 1 — state-machine collects every string/template literal (+ `+`-joined
//            fragments like "/api/" + "models" resolved into one candidate)
//   pass 2 — every literal is classified as route / endpoint / asset / url and
//            emitted with the right kind, so the graph + Deep Scan queue sees it.

export interface Extracted {
  text: string;
  line: number;
  column: number;
  kind: string;       // e.g. 'string-literal' | 'url' | 'route' | 'endpoint' | 'import' ...
  extra?: string;     // jsonPath / import target / etc.
}

const MAX_UNITS_PER_RESOURCE = 6000;
const MAX_UNIT_LEN = 320;

function push(out: Extracted[], text: string, line: number, col: number, kind: string, extra?: string): void {
  if (!text || text.length < 2 || text.length > MAX_UNIT_LEN) return;
  if (out.length >= MAX_UNITS_PER_RESOURCE) return;
  out.push({ text, line, column: col, kind, extra });
}

function lineColFallback(src: string, idx: number): [number, number] {
  const prev = src.lastIndexOf('\n', idx - 1);
  if (prev >= 0) return [1, idx - prev];
  return [1, idx + 1];
}

/** Precise line/col via precomputed line starts (use for files < ~2MB). */
export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function offsetToLineCol(starts: number[], idx: number): [number, number] {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= idx) lo = m; else hi = m - 1; }
  return [lo + 1, idx - starts[lo] + 1];
}

const URL_RE = /https?:\/\/[^\s"'`<>(){}[\]]{4,200}|wss?:\/\/[^\s"'`<>(){}[\]]{4,200}|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{2,220}/g;
const IMPORT_RE = /(?:import\s*\(\s*['"]([^'"]{1,220})['"]\s*\)|import\s+[^'"]*?from\s*['"]([^'"]{1,220})['"]|require\(\s*['"]([^'"]{1,220})['"]\s*\)|export\s+[^'"]*?from\s*['"]([^'"]{1,220})['"])/g;
const FETCH_RE = /\b(?:fetch|axios\.(?:get|post|put|delete|patch)|XMLHttpRequest|\.ajax|api\.(?:get|post|put|delete))\s*\(\s*['"`]([^'"`]{1,220})['"`]/g;
const SRC_MAP_RE = /\/\/#\s*sourceMappingURL\s*=\s*(\S{1,220})/;
const STRING_RE = /(['"`])((?:\\\1|(?!\1)[^\\\n]){2,200})\1/g;
const IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$]{3,80}\b/g;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]{1,220})\1\s*\)|@import\s+(?:url\()?['"]([^'"]{1,220})['"]/g;

// ---------- generic path / API classification (the core of v1.2) ----------

/** Any site can expose any path — do NOT restrict to a hardcoded prefix list. */
const GENERIC_PATH_RE = /^\/[A-Za-z0-9_\-.~/{}$:@!$&'()*+,;=%?#[\]]{1,220}$/;
// Structural API markers only (NOT domain words like /models — those are routes).
// /api/*, /v1/*, /graphql, /trpc, /rest/* are endpoints on ANY site.
const API_HINT_RE = /(^|\/)(api|apis|rest|graphql|gql|trpc|v\d{1,3})(\/|$|[?#])/i;
const ASSET_EXT_RE = /\.(m?js|css|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|txt|xml)(\?|#|$)/i;

export function isApiEndpoint(s: string): boolean {
  if (s.length < 2 || s.length > 260) return false;
  // Absolute URLs: test the pathname.
  let path = s;
  try {
    if (/^https?:\/\//i.test(s) || /^wss?:\/\//i.test(s)) path = new URL(s).pathname + new URL(s).search;
  } catch { /* keep raw */ }
  if (!path.startsWith('/')) {
    // Bare relative like "api/models" — still an endpoint candidate.
    if (/^(api|rest|graphql|gql|trpc|v\d{1,3})\//i.test(path)) return true;
    return false;
  }
  if (API_HINT_RE.test(path)) return true;
  return false;
}

export function looksLikeRoutePath(s: string): boolean {
  if (s.length < 2 || s.length > 220) return false;
  if (/\s/.test(s)) return false;
  if (!s.startsWith('/')) return false;
  if (s.startsWith('//')) return false; // protocol-relative, not a route
  if (!GENERIC_PATH_RE.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false; // need at least one letter (skip "/123")
  if (/^\/[0-9.,;:\s]+$/.test(s)) return false;
  return true;
}

export function classifyPath(s: string): 'endpoint' | 'route' | 'asset' | null {
  const t = s.trim().slice(0, 260);
  if (!looksLikeRoutePath(t) && !isApiEndpoint(t)) return null;
  if (ASSET_EXT_RE.test(t) && !isApiEndpoint(t)) return 'asset';
  if (isApiEndpoint(t)) return 'endpoint';
  return 'route';
}

interface Lit { value: string; index: number; quote: string }

/**
 * Pass 1: collect every string/template literal via a single O(n) scan.
 * Handles ', ", ` (splitting ${...} into separate fragments), escapes.
 * Bounded: stops collecting after 4000 literals to cap RAM.
 */
export function collectLiterals(src: string, cap = 4000): Lit[] {
  const out: Lit[] = [];
  const n = src.length;
  let i = 0;
  while (i < n && out.length < cap) {
    const c = src.charCodeAt(i);
    // quote chars: ' " `
    if (c !== 39 && c !== 34 && c !== 96) { i++; continue; }
    const quote = src[i];
    const start = i;
    i++;
    let buf = '';
    let closed = false;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        // keep escaped char literally (one step) so \" doesn't terminate
        if (i + 1 < n) { buf += src[i + 1]; i += 2; continue; }
        i++;
        continue;
      }
      if (quote === '`' && ch === '$' && src[i + 1] === '{') {
        // template placeholder: flush current fragment, skip balanced braces
        if (buf.length >= 2) out.push({ value: buf, index: start, quote });
        buf = '';
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        if (out.length >= cap) return out;
        continue;
      }
      if (ch === quote) { closed = true; i++; break; }
      if (ch === '\n' && quote !== '`') break; // unterminated single-line string
      buf += ch;
      if (buf.length > MAX_UNIT_LEN + 40) {
        // too long — skip to closing quote without storing
        while (i < n && src[i] !== quote && src[i] !== '\n') i++;
        if (src[i] === quote) i++;
        buf = '';
        closed = false;
        break;
      }
      i++;
      // bound template literal length (multiline ok, cap at ~4k chars scanned)
      if (quote === '`' && buf.length > 4000) break;
    }
    if (closed && buf.length >= 2 && buf.length <= MAX_UNIT_LEN) {
      out.push({ value: buf, index: start, quote });
    }
  }
  return out;
}

/**
 * Resolve `"a" + "b"` / `'/api/' + name` style concatenations into joined
 * candidates. Scans the raw source for 2-3 adjacent quoted fragments joined
 * by `+` and joins their values. Bounded to 800 joins.
 */
function collectConcatenated(src: string, starts: number[], lc: (i: number) => [number, number], out: Extracted[]): void {
  const JOIN_RE = /(['"`])((?:\\\1|(?!\1)[^\\\n]){1,120})\1\s*\+\s*(['"`])((?:\\\3|(?!\3)[^\\\n]){1,120})\3(?:\s*\+\s*(['"`])((?:\\\5|(?!\5)[^\\\n]){1,120})\5)?/g;
  let m: RegExpExecArray | null;
  let joins = 0;
  JOIN_RE.lastIndex = 0;
  while ((m = JOIN_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE && joins < 800) {
    joins++;
    const parts = [m[2], m[4], m[6]].filter(Boolean) as string[];
    const joined = parts.join('');
    if (joined.length < 2 || joined.length > MAX_UNIT_LEN) continue;
    const cls = classifyPath(joined);
    if (!cls) continue;
    const [l, col] = lc(m.index);
    const kind = cls === 'endpoint' ? 'endpoint' : cls === 'route' ? 'route' : 'asset-ref';
    push(out, joined, l, col, kind, `concat:${parts.length}`);
  }
}

export function extractJs(src: string, starts?: number[]): Extracted[] {
  const out: Extracted[] = [];
  const ownStarts = starts ?? lineStarts(src.slice(0, 2_000_000));
  const usePrecise = !!starts || src.length < 2_000_000;
  const lc = (i: number): [number, number] => (usePrecise && i < ownStarts[ownStarts.length - 1] + 200000
    ? offsetToLineCol(ownStarts, Math.min(i, src.length - 1))
    : lineColFallback(src, i));

  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE) {
    if (looksLikeNoise(m[0])) continue;
    const [l, c] = lc(m.index);
    // Absolute URLs that carry an API pathname become endpoints, not plain urls.
    const k = isApiEndpoint(m[0]) ? 'endpoint' : 'url';
    push(out, m[0].slice(0, MAX_UNIT_LEN), l, c, k);
  }
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE) {
    const target = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!target) continue;
    const [l, c] = lc(m.index);
    const dyn = m[1] ? 'dynamic-import' : 'static-import';
    push(out, target, l, c, dyn, target);
  }
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE) {
    const [l, c] = lc(m.index);
    push(out, m[1], l, c, 'fetch-target', m[1]);
  }
  const sm = SRC_MAP_RE.exec(src.slice(-4000));
  if (sm) push(out, sm[1], -1, -1, 'sourcemap-ref', sm[1]);

  // ---- PASS 1+2: every literal, generically classified ----
  // This is what finds /api, /api/models, /v1/chat, /graphql … on ANY site,
  // plus SPA routes (/models, /dashboard/…, /settings/…) hiding in bundles.
  const lits = collectLiterals(src);
  const seenPath = new Set<string>();
  for (const lit of lits) {
    if (out.length >= MAX_UNITS_PER_RESOURCE) break;
    const v = lit.value.trim();
    if (v.length < 2 || v.length > 220) continue;
    // Skip obvious non-paths fast: must contain a slash to be route/endpoint/asset.
    if (!v.includes('/')) continue;
    // Absolute URL inside a literal: index full URL + its pathname separately.
    if (/^https?:\/\//i.test(v) || /^wss?:\/\//i.test(v)) {
      try {
        const u = new URL(v);
        const p = u.pathname + u.search;
        const cls = classifyPath(p);
        if (cls && !seenPath.has(p)) {
          seenPath.add(p);
          const [l, c] = lc(lit.index);
          push(out, p.slice(0, MAX_UNIT_LEN), l, c, cls === 'endpoint' ? 'endpoint' : 'route', `from-url:${v.slice(0, 120)}`);
        }
      } catch { /* ignore */ }
      continue; // full URL already covered by URL_RE pass
    }
    const cls = classifyPath(v);
    if (!cls) continue;
    if (seenPath.has(v)) continue;
    seenPath.add(v);
    const [l, c] = lc(lit.index);
    const kind = cls === 'endpoint' ? 'endpoint' : cls === 'route' ? 'route' : 'asset-ref';
    push(out, v.slice(0, MAX_UNIT_LEN), l, c, kind);
    if (seenPath.size > 2500) break;
  }

  // Concatenated fragments: "/api/" + "models", "/assets/" + hash + ".js", …
  collectConcatenated(src, ownStarts, lc, out);

  // String literals + identifiers: cap aggressively to bound RAM.
  STRING_RE.lastIndex = 0;
  let strCount = 0;
  while ((m = STRING_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE && strCount < 2500) {
    const v = m[2];
    if (v.length < 3 || v.length > MAX_UNIT_LEN || looksLikeNoise(v)) continue;
    if (v.includes('/') && (looksLikeRoutePath(v.trim()) || isApiEndpoint(v.trim()))) continue; // already emitted
    const [l, c] = lc(m.index);
    push(out, v, l, c, 'string-literal');
    strCount++;
  }
  IDENT_RE.lastIndex = 0;
  let idCount = 0;
  const seenIds = new Set<string>();
  while ((m = IDENT_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE && idCount < 1200) {
    const v = m[0];
    if (seenIds.has(v) || isJsKeyword(v)) continue;
    seenIds.add(v);
    const [l, c] = lc(m.index);
    push(out, v, l, c, 'identifier');
    idCount++;
  }
  return out;
}

export function extractCss(src: string): Extracted[] {
  const out: Extracted[] = [];
  let m: RegExpExecArray | null;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE) {
    const v = m[2] ?? m[3];
    if (!v || looksLikeNoise(v)) continue;
    const [l, c] = lineColFallback(src, m.index);
    push(out, v, l, c, m[3] ? 'css-import' : 'css-reference', v);
  }
  // class/id selectors as searchable units (bounded)
  const SEL_RE = /[.#][A-Za-z_][A-Za-z0-9_-]{2,60}/g;
  let n = 0;
  SEL_RE.lastIndex = 0;
  while ((m = SEL_RE.exec(src)) && out.length < MAX_UNITS_PER_RESOURCE && n < 1500) {
    const [l, c] = lineColFallback(src, m.index);
    push(out, m[0], l, c, 'css-selector');
    n++;
  }
  return out;
}

export interface HtmlFindings {
  units: Extracted[];
  links: string[];
  scripts: string[];
  forms: string[];
  iframes: string[];
  routes: string[];
}

const HREF_RE = /(?:href|src|action|data-src)\s*=\s*["']([^"']{1,300})["']/gi;
const FORM_RE = /<form\b[^>]*>/gi;
const IFRAME_RE = /<iframe\b[^>]*src\s*=\s*["']([^"']{1,300})["'][^>]*>/gi;
const SCRIPT_RE = /<script\b[^>]*src\s*=\s*["']([^"']{1,300})["'][^>]*>/gi;

export function extractHtml(src: string, pageUrl: string): HtmlFindings {
  const units: Extracted[] = [];
  const links: string[] = [], scripts: string[] = [], forms: string[] = [], iframes: string[] = [], routes: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(src)) && units.length < MAX_UNITS_PER_RESOURCE) {
    const v = m[1];
    if (!v || v.startsWith('data:') || v.startsWith('javascript:')) continue;
    const [l, c] = lineColFallback(src, m.index);
    const abs = resolveUrl(pageUrl, v);
    units.push({ text: v.slice(0, MAX_UNIT_LEN), line: l, column: c, kind: 'dom-link', extra: abs });
    links.push(abs);
    if (v.startsWith('/') && v.length > 1) routes.push(v);
  }
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(src))) scripts.push(resolveUrl(pageUrl, m[1]));
  IFRAME_RE.lastIndex = 0;
  while ((m = IFRAME_RE.exec(src))) iframes.push(resolveUrl(pageUrl, m[1]));
  FORM_RE.lastIndex = 0;
  while ((m = FORM_RE.exec(src)) && forms.length < 200) forms.push(m[0].slice(0, 220));
  // Visible text nodes: strip tags, chunk into units
  const textOnly = src.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (let i = 0; i < textOnly.length && units.length < MAX_UNITS_PER_RESOURCE; i += 180) {
    const chunk = textOnly.slice(i, i + 180).trim();
    if (chunk.length > 8 && /[A-Za-z0-9]{3,}/.test(chunk)) units.push({ text: chunk, line: -1, column: -1, kind: 'dom-text' });
  }
  return { units, links, scripts, forms, iframes, routes };
}

/** Flatten JSON with paths: {a:{b:1}} -> ["a.b = 1"...]. Bounded. */
export function extractJson(text: string): Extracted[] {
  const out: Extracted[] = [];
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return out; }
  const stack: Array<{ v: unknown; path: string }> = [{ v: obj, path: '$' }];
  let count = 0;
  while (stack.length && count < 4000) {
    const { v, path } = stack.pop()!;
    if (typeof v === 'string') {
      if (v.length >= 2 && v.length <= MAX_UNIT_LEN) push(out, v, -1, -1, 'json-string', path);
      // Strings that LOOK like routes/endpoints get a second searchable facet
      // so `/api/models` inside JSON is found as an endpoint too.
      if (typeof v === 'string' && v.includes('/') && v.length <= 220) {
        const cls = classifyPath(v.trim());
        if (cls === 'endpoint' || cls === 'route') push(out, v.trim(), -1, -1, cls === 'endpoint' ? 'endpoint' : 'route', path);
      }
      count++;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      push(out, String(v), -1, -1, 'json-scalar', path);
      count++;
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0 && i >= v.length - 60; i--) stack.push({ v: v[i], path: `${path}[${i}]` });
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).slice(0, 80);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, val] = entries[i];
        const p = path === '$' ? k : `${path}.${k}`;
        push(out, k, -1, -1, 'json-key', p);
        stack.push({ v: val, path: p });
        count++;
        if (count >= 4000) break;
      }
    }
  }
  return out;
}

export function resolveUrl(base: string, rel: string): string {
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

const NOISE_RE = /^[0-9.,;:\s]+$|^#[0-9a-fA-F]{1,8}$/;
function looksLikeNoise(s: string): boolean {
  return s.length < 2 || NOISE_RE.test(s);
}

const JS_KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements package protected interface private public'.split(' '));
function isJsKeyword(s: string): boolean { return JS_KEYWORDS.has(s); }

/** Best-effort AST-lite: find dynamic import + fetch targets missed by regex. Runs only when advanced analysis is on. */
export function extractJsAdvanced(src: string): Extracted[] {
  // Deliberately no acorn dependency bundled: implement a small state-machine
  // scanner for string arguments of import()/fetch() to avoid a heavy dep.
  const out: Extracted[] = [];
  const targets = ['import(', 'fetch(', 'open('];
  for (const t of targets) {
    let idx = 0;
    while (out.length < 800 && (idx = src.indexOf(t, idx)) >= 0) {
      const q = src.indexOf('"', idx);
      const q2 = src.indexOf("'", idx);
      const q3 = src.indexOf('`', idx);
      let qs = -1;
      for (const c of [q, q2, q3]) if (c > idx && c < idx + 60 && (qs < 0 || c < qs)) qs = c;
      if (qs > 0) {
        const quote = src[qs];
        const end = src.indexOf(quote, qs + 1);
        if (end > qs && end - qs < 240) {
          const v = src.slice(qs + 1, end);
          const [l, c] = lineColFallback(src, idx);
          push(out, v, l, c, t.startsWith('import') ? 'dynamic-import' : 'fetch-target', v);
        }
      }
      idx += t.length;
    }
  }
  return out;
}

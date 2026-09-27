// DeepScope filter DSL — pure, RAM-only, zero deps.
// `method:POST status:>=400 host:api.* has:auth -mime:image`
// Unknown `field:` tokens degrade to plain substrings, so existing filter
// boxes keep working character-for-character when no DSL is used.
// Unit-tested via verify.mjs; the panel adapts rows to DslRecord.

export interface DslTerm {
  /** Known field, or null for a bare substring token. */
  field: string | null;
  value: string;
  negate: boolean;
}

/** Fields the DSL understands (per-tab adapters fill what applies). */
const KNOWN_FIELDS = new Set([
  'method', 'status', 'host', 'mime', 'url', 'route', 'kind', 'has', 'seen',
]);

export const FILTER_DSL_HELP =
  'filter: method:POST status:>=400 host:api.* mime:json has:auth -mime:image — unknown fields stay plain text';

/** Split on whitespace, honoring double quotes. Pure. */
export function parseFilterDsl(input: string): DslTerm[] {
  const terms: DslTerm[] = [];
  if (typeof input !== 'string') return terms;
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  for (let raw of tokens) {
    if (!raw) continue;
    // Strip surrounding quotes (quoted whole-token).
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    if (!raw) continue;
    let negate = false;
    if (raw.startsWith('-') && raw.length > 1) { negate = true; raw = raw.slice(1); }
    const ci = raw.indexOf(':');
    if (ci > 0) {
      const field = raw.slice(0, ci).toLowerCase();
      let value = raw.slice(ci + 1);
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (KNOWN_FIELDS.has(field) && value) {
        terms.push({ field, value, negate });
        continue;
      }
    }
    terms.push({ field: null, value: raw, negate });
  }
  return terms;
}

/** Case-insensitive wildcard (`*`) match. Pure. */
export function wildcardMatch(text: string, pattern: string): boolean {
  const t = typeof text === 'string' ? text : '';
  const p = typeof pattern === 'string' ? pattern : '';
  if (!p) return false;
  if (!p.includes('*')) return t.toLowerCase().includes(p.toLowerCase());
  const rx = p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try {
    return new RegExp(`^${rx}$`, 'i').test(t);
  } catch {
    return false;
  }
}

function numCompare(actual: number | undefined, expr: string): boolean {
  if (actual === undefined || !Number.isFinite(actual)) return false;
  const m = /^(>=|<=|>|<|=)?\s*(\d+)\s*$/.exec(expr);
  if (!m) return false;
  const want = parseInt(m[2], 10);
  switch (m[1] ?? '=') {
    case '>=': return actual >= want;
    case '<=': return actual <= want;
    case '>': return actual > want;
    case '<': return actual < want;
    default: return actual === want;
  }
}

/** Flat record adapters fill from NetEntry / ResourceMeta / routes. */
export interface DslRecord {
  method?: string;
  status?: number;
  host?: string;
  mime?: string;
  url?: string;
  route?: string;
  kind?: string;
  hasAuth?: boolean;
  hasBody?: boolean;
  isError?: boolean;
  seen?: number;
}

function termMatch(t: DslTerm, rec: DslRecord, haystack: string): boolean {
  if (t.field === null) {
    return haystack.toLowerCase().includes(t.value.toLowerCase());
  }
  switch (t.field) {
    case 'method': return wildcardMatch(rec.method ?? '', t.value);
    case 'status': return numCompare(rec.status, t.value);
    case 'seen': return numCompare(rec.seen, t.value);
    case 'host': return wildcardMatch(rec.host ?? '', t.value);
    case 'mime': return wildcardMatch(rec.mime ?? '', t.value);
    case 'url': return wildcardMatch(rec.url ?? '', t.value);
    case 'route': return wildcardMatch(rec.route ?? '', t.value);
    case 'kind': return wildcardMatch(rec.kind ?? '', t.value);
    case 'has': {
      const v = t.value.toLowerCase();
      if (v === 'auth') return rec.hasAuth === true;
      if (v === 'body') return rec.hasBody === true;
      if (v === 'error') return rec.isError === true;
      return false; // unknown has: value never matches
    }
    default: return false;
  }
}

/** All terms must hold (AND); negated terms must not. Pure. */
export function matchDslAll(terms: DslTerm[], rec: DslRecord, haystack: string): boolean {
  const hay = typeof haystack === 'string' ? haystack : '';
  for (const t of terms) {
    const hit = termMatch(t, rec, hay);
    if (t.negate ? hit : !hit) return false;
  }
  return true;
}

// DeepScope OpenAPI export — pure, RAM-only, zero deps.
// Turns observed endpoints (method + URL + status + real JSON samples) into a
// valid OpenAPI 3.0 document. Unit-tested via verify.mjs; the panel assembles
// the records and owns the download.

export interface OpenApiEndpoint {
  method: string;
  url: string;
  status?: number;
  /** Observed request body sample (sent), sliced by the caller. */
  reqSample?: string;
  /** Observed response body sample (retained), sliced by the caller. */
  resSample?: string;
  /** True for code-seen-never-called routes (listed, not operations). */
  uncalled?: boolean;
}

export const OPENAPI_MAX_PATHS = 300;
const OPENAPI_MAX_PROPS = 50;
const OPENAPI_MAX_DEPTH = 4;

interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  example?: unknown;
}

function safeJsonParse(text: string): unknown {
  try {
    const v = JSON.parse(text);
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

/** Infer a JSON Schema from an observed value (bounded depth/width). Pure. */
export function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (value === null || value === undefined) return { type: 'string', example: null };
  if (Array.isArray(value)) {
    if (!value.length || depth >= OPENAPI_MAX_DEPTH) return { type: 'array', items: { type: 'string' } };
    return { type: 'array', items: inferSchema(value[0], depth + 1) };
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    const s: JsonSchema = { type: t === 'number' && Number.isInteger(value) ? 'integer' : t };
    if (t === 'string' && (value as string).length <= 120) s.example = value;
    return s;
  }
  if (t === 'object' && depth < OPENAPI_MAX_DEPTH) {
    const props: Record<string, JsonSchema> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= OPENAPI_MAX_PROPS) break;
      if (typeof k !== 'string' || !k) continue;
      props[k] = inferSchema(v, depth + 1);
    }
    return { type: 'object', properties: props };
  }
  return { type: 'string' };
}

const ID_SEG = /^(\d{2,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|0x[0-9a-fA-F]+|[0-9a-fA-F]{16,})$/;

/** `/users/123` → `/users/{id}` (mirrors panel templatePath, pure + tested). */
export function templateOpenApiPath(pathname: string): string {
  const out = String(pathname ?? '').split('/').map((seg) => {
    if (!seg) return seg;
    if (ID_SEG.test(seg)) return '{id}';
    return seg;
  }).join('/');
  return out || '/';
}

function pathParamsOf(tpl: string, rawUrl: string): Array<{ name: string; in: string; required: boolean; schema: { type: string }; example?: string }> {
  const out: Array<{ name: string; in: string; required: boolean; schema: { type: string }; example?: string }> = [];
  let rawSegs: string[] = [];
  try { rawSegs = new URL(rawUrl).pathname.split('/'); } catch { rawSegs = String(rawUrl).split('/'); }
  const tplSegs = tpl.split('/');
  for (let i = 0; i < tplSegs.length; i++) {
    const m = /^\{(.+)\}$/.exec(tplSegs[i]);
    if (!m) continue;
    const p: { name: string; in: string; required: boolean; schema: { type: string }; example?: string } = {
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    };
    const raw = rawSegs[i];
    if (typeof raw === 'string' && raw && raw.length <= 120) p.example = raw;
    out.push(p);
  }
  return out;
}

function queryParamsOf(rawUrl: string): Array<{ name: string; in: string; required: boolean; schema: { type: string }; example?: string }> {
  const out: Array<{ name: string; in: string; required: boolean; schema: { type: string }; example?: string }> = [];
  try {
    const u = new URL(rawUrl);
    let n = 0;
    u.searchParams.forEach((v, k) => {
      if (n++ >= 30 || !k) return;
      const p: { name: string; in: string; required: boolean; schema: { type: string }; example?: string } = {
        name: k, in: 'query', required: false, schema: { type: 'string' },
      };
      if (v && v.length <= 120) p.example = v;
      out.push(p);
    });
  } catch { /* relative URL — no query params */ }
  return out;
}

/** Build an OpenAPI 3.0 document from observed endpoints. Pure. */
export function buildOpenApiDoc(origin: string, endpoints: OpenApiEndpoint[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const uncalled: string[] = [];
  let nPaths = 0;
  const list = Array.isArray(endpoints) ? endpoints : [];
  for (const e of list) {
    try {
      if (!e || typeof e.url !== 'string') continue;
      if (!/^https?:/i.test(e.url)) continue;
      let pathname = '/';
      try { pathname = new URL(e.url).pathname || '/'; } catch { continue; }
      const tpl = templateOpenApiPath(pathname);
      if (e.uncalled === true) {
        if (uncalled.length < 200 && !uncalled.includes(e.url)) uncalled.push(e.url);
        continue;
      }
      if (!paths[tpl]) {
        if (nPaths >= OPENAPI_MAX_PATHS) continue;
        paths[tpl] = {};
        nPaths++;
      }
      const m = (typeof e.method === 'string' && e.method ? e.method : 'GET').toLowerCase();
      if (!/^(get|post|put|patch|delete|head|options|trace)$/.test(m)) continue;
      if (paths[tpl][m]) continue; // first observation wins per method
      const op: Record<string, unknown> = {
        summary: `${e.method.toUpperCase()} ${tpl} (observed)`,
        parameters: [...pathParamsOf(tpl, e.url), ...queryParamsOf(e.url)],
        responses: {} as Record<string, unknown>,
      };
      const statusKey = typeof e.status === 'number' && e.status >= 100 && e.status <= 999 ? String(e.status) : 'default';
      const resp: Record<string, unknown> = { description: `observed ${statusKey}` };
      if (typeof e.resSample === 'string' && e.resSample.length) {
        const v = safeJsonParse(e.resSample);
        if (v !== null && typeof v === 'object') {
          resp['content'] = { 'application/json': { schema: inferSchema(v) } };
        }
      }
      (op['responses'] as Record<string, unknown>)[statusKey] = resp;
      if (typeof e.reqSample === 'string' && e.reqSample.length && (m === 'post' || m === 'put' || m === 'patch')) {
        const v = safeJsonParse(e.reqSample);
        if (v !== null && typeof v === 'object') {
          op['requestBody'] = { required: false, content: { 'application/json': { schema: inferSchema(v) } } };
        }
      }
      paths[tpl][m] = op;
    } catch { /* one bad endpoint never breaks the doc */ }
  }
  const doc: Record<string, unknown> = {
    openapi: '3.0.0',
    info: {
      title: `DeepScope observed API${origin ? ` — ${origin}` : ''}`,
      version: '1.0.0',
      description: 'Generated from traffic observed by DeepScope. Schemas are inferred from real samples — verify before publishing.',
    },
    servers: origin ? [{ url: origin }] : [],
    paths,
  };
  if (uncalled.length) doc['x-deepscope-uncalled'] = uncalled;
  return doc;
}

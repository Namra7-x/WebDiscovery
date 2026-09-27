// DeepScope request replay — background service-worker executor.
// Resends a captured request with real cookies: SW-initiated fetch() to a
// permitted host bypasses CORS and includes that origin's cookies, so the
// replay is faithful without any new manifest permissions. Text-only v1
// (binary bodies replay as truncated text with a note). Nothing is retained:
// the response goes straight back to the panel and is never stored.

export interface ReplayRequest {
  type: 'replay-request';
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  bodyText?: string;
}

export interface ReplayResponse {
  type: 'replay-response';
  id: string;
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  truncated?: boolean;
  ms?: number;
  error?: string;
}

/** Interception rule (mock/block). Stored in chrome.storage.session (cleared
 *  with the browser session — interception never survives a restart). */
export interface InterceptRule {
  id: string;
  kind: 'mock' | 'block';
  /** Substring match by default; regex when `useRegex` is true. */
  match: string;
  useRegex?: boolean;
  /** Uppercase method or 'ANY'. */
  method?: string;
  /** Mock response status (default 200). */
  status?: number;
  /** Mock response body text. */
  body?: string;
  enabled?: boolean;
}

/**
 * Panel-side matcher (rule validation, list filtering, tests). The MAIN-world
 * script in intercept-main.ts carries a mirror of this logic (classic script,
 * no imports) — keep the two in sync.
 */
export function matchInterceptRule(url: string, method: string, r: InterceptRule): boolean {
  try {
    if (!r || typeof r.match !== 'string' || !r.match.length) return false;
    if (r.method && r.method !== 'ANY' && r.method.toUpperCase() !== String(method).toUpperCase()) return false;
    if (r.useRegex) return new RegExp(r.match, 'i').test(url);
    return url.toLowerCase().indexOf(r.match.toLowerCase()) !== -1;
  } catch {
    return false; // bad regex never matches
  }
}

/** Safest request size for a panel-driven replay (RAM guard). */
export const REPLAY_MAX_REQ_CHARS = 262_144; // 256 KB/** Safest response size returned to the panel (RAM guard). */
export const REPLAY_MAX_RES_CHARS = 524_288; // 512 KB
/** Wall-clock ceiling per replay so a hung server can't wedge the worker. */
export const REPLAY_TIMEOUT_MS = 30_000;

/** Hop-by-hop / forbidden headers the fetch layer owns — never replay verbatim. */
const STRIP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

/** Drop headers that fetch forbids or owns; pure + unit-tested. */
export function sanitizeReplayHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const name = k.trim();
    if (!name || name.length > 256 || v.length > 16_384) continue;
    if (STRIP_HEADERS.has(name.toLowerCase())) continue;
    out[name] = v;
  }
  return out;
}

/** Clamp a replay body to the RAM budget; pure + unit-tested. */
export function truncateReplayBody(text: unknown, cap = REPLAY_MAX_RES_CHARS): { text: string; truncated: boolean } {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

function errRes(id: string, error: string): ReplayResponse {
  return { type: 'replay-response', id, ok: false, error };
}

/** Execute one replay. Never throws — failures come back as `{ok:false}`. */
export async function executeReplay(req: ReplayRequest): Promise<ReplayResponse> {
  const id = typeof req.id === 'string' ? req.id : 'replay';
  try {
    const method = (typeof req.method === 'string' && req.method ? req.method : 'GET').toUpperCase();
    if (!/^[A-Z-]{1,16}$/.test(method)) return errRes(id, 'invalid method');
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return errRes(id, 'invalid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return errRes(id, 'only http(s) URLs can be replayed');
    }
    const headers = sanitizeReplayHeaders(req.headers);
    let body: string | undefined;
    if (typeof req.bodyText === 'string' && req.bodyText.length && method !== 'GET' && method !== 'HEAD') {
      const t = truncateReplayBody(req.bodyText, REPLAY_MAX_REQ_CHARS);
      body = t.text;
      if (t.truncated) headers['x-deepscope-note'] = 'request body truncated to 256 KB';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REPLAY_TIMEOUT_MS);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body,
        credentials: 'include',
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    const resHeaders: Record<string, string> = {};
    try {
      res.headers.forEach((v, k) => {
        if (resHeaders[k] === undefined && v.length <= 16_384) resHeaders[k] = v;
      });
    } catch { /* headers unreadable — report without them */ }
    let bodyText = '';
    let truncated = false;
    try {
      const t = truncateReplayBody(await res.text());
      bodyText = t.text;
      truncated = t.truncated;
    } catch {
      bodyText = '(response body unreadable — binary or stream)';
    }
    return {
      type: 'replay-response', id, ok: true,
      status: res.status, statusText: res.statusText,
      headers: resHeaders, bodyText, truncated, ms,
    };
  } catch (e) {
    const m = e instanceof Error && e.name === 'AbortError' ? 'timed out after 30s' : String(e).slice(0, 200);
    return errRes(id, `replay failed: ${m}`);
  }
}

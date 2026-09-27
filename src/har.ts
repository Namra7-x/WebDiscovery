// DeepScope HAR import/export — pure, RAM-only, zero deps.
// Export: observed NetEntries → HAR 1.2 (opens in Chrome, Charles, Burp).
// Import: foreign HAR (Burp/Charles/Chrome) → NetEntries + evidence + bodies.
// Unit-tested via verify.mjs; the panel owns downloads + file pickers.

export interface HarLikeEntry {
  method?: unknown;
  url?: unknown;
  status?: unknown;
  mime?: unknown;
  route?: unknown;
  initiator?: unknown;
  reqHeaders?: unknown;
  resHeaders?: unknown;
  reqBody?: unknown;
  /** Retained response body text (exported) / decoded body (imported). */
  resBody?: unknown;
  ts?: unknown;
  timingMs?: unknown;
}

export const HAR_MAX_ENTRIES = 2000;
const HAR_MAX_HEADERS = 60;
const HAR_MAX_BODY = 50_000;

function headersToHar(h: unknown): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (typeof h !== 'object' || h === null) return out;
  for (const [name, value] of Object.entries(h as Record<string, unknown>)) {
    if (out.length >= HAR_MAX_HEADERS) break;
    if (typeof name !== 'string' || typeof value !== 'string' || !name) continue;
    out.push({ name, value: value.slice(0, 16_384) });
  }
  return out;
}

function harToHeaders(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const h of list.slice(0, HAR_MAX_HEADERS)) {
    if (typeof h !== 'object' || h === null) continue;
    const name = (h as { name?: unknown }).name;
    const value = (h as { value?: unknown }).value;
    if (typeof name === 'string' && typeof value === 'string' && name && out[name] === undefined) {
      out[name] = value.slice(0, 16_384);
    }
  }
  return out;
}

function str(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

/** Build a HAR 1.2 document from observed entries. Pure. */
export function buildHarDoc(origin: string, entries: HarLikeEntry[]): Record<string, unknown> {
  const list = Array.isArray(entries) ? entries.slice(0, HAR_MAX_ENTRIES) : [];
  const harEntries = [];
  for (const e of list) {
    try {
      const url = str(e.url, 2000);
      if (!/^https?:/i.test(url)) continue;
      const method = (str(e.method, 16) || 'GET').toUpperCase();
      const status = typeof e.status === 'number' && e.status >= 100 && e.status <= 999 ? e.status : 0;
      const mime = str(e.mime, 128);
      const reqText = str(e.reqBody, 20_000);
      const resText = str(e.resBody, HAR_MAX_BODY);
      const started = new Date(typeof e.ts === 'number' ? e.ts : Date.now()).toISOString();
      harEntries.push({
        startedDateTime: started,
        time: typeof e.timingMs === 'number' && e.timingMs >= 0 ? Math.round(e.timingMs) : 0,
        request: {
          method, url, httpVersion: 'HTTP/1.1',
          headers: headersToHar(e.reqHeaders),
          queryString: [],
          postData: reqText ? { mimeType: 'text/plain', text: reqText } : undefined,
          headersSize: -1, bodySize: reqText.length,
        },
        response: {
          status, statusText: status ? String(status) : '',
          httpVersion: 'HTTP/1.1',
          headers: headersToHar(e.resHeaders),
          content: { size: resText.length, mimeType: mime || 'text/plain', text: resText },
          redirectURL: '', headersSize: -1, bodySize: resText.length,
        },
        timings: { send: 0, wait: 0, receive: 0 },
        _deepscope: { route: str(e.route, 500), initiator: str(e.initiator, 500) },
      });
    } catch { /* one bad entry never breaks the doc */ }
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'DeepScope', version: '1.7.0' },
      pages: origin ? [{ startedDateTime: new Date().toISOString(), id: 'page_1', title: origin }] : [],
      entries: harEntries,
    },
  };
}

export interface HarValidate { ok: boolean; entries?: Array<Record<string, unknown>>; error?: string }

/** Validate a foreign HAR before the panel restores a single byte. Pure. */
export function validateHar(json: unknown): HarValidate {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not a JSON object' };
  const log = (json as Record<string, unknown>)['log'] as Record<string, unknown> | undefined;
  if (!log || !Array.isArray(log['entries'])) return { ok: false, error: 'not a HAR file (missing log.entries)' };
  const entries = log['entries'] as unknown[];
  if (entries.length > 10_000) return { ok: false, error: 'HAR exceeds safe entry limits (10k)' };
  return { ok: true, entries: entries as Array<Record<string, unknown>> };
}

export interface HarImportEntry {
  method: string;
  url: string;
  status?: number;
  mime?: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqText: string;
  resText: string;
  ts: number;
  timingMs?: number;
}

/** Normalize one foreign HAR entry to panel shape (base64-aware). Pure. */
export function normalizeHarEntry(raw: unknown): HarImportEntry | null {
  try {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const req = (o['request'] ?? {}) as Record<string, unknown>;
    const res = (o['response'] ?? {}) as Record<string, unknown>;
    const url = typeof req['url'] === 'string' ? req['url'] : '';
    if (!/^https?:/i.test(url) || url.length > 2000) return null;
    const method = (typeof req['method'] === 'string' && req['method'] ? req['method'] : 'GET').toUpperCase().slice(0, 16);
    const status = typeof res['status'] === 'number' && res['status'] >= 100 && res['status'] <= 999 ? res['status'] : undefined;
    const content = (res['content'] ?? {}) as Record<string, unknown>;
    const mime = typeof content['mimeType'] === 'string' ? content['mimeType'].slice(0, 128) : undefined;
    let resText = typeof content['text'] === 'string' ? content['text'] : '';
    if (resText && content['encoding'] === 'base64') {
      try { resText = atob(resText).slice(0, HAR_MAX_BODY); }
      catch { resText = ''; }
    } else {
      resText = resText.slice(0, HAR_MAX_BODY);
    }
    const post = (req['postData'] ?? {}) as Record<string, unknown>;
    const reqText = typeof post['text'] === 'string' ? post['text'].slice(0, 20_000) : '';
    let ts = Date.now();
    try {
      const t = Date.parse(String(o['startedDateTime'] ?? ''));
      if (Number.isFinite(t)) ts = t;
    } catch { /* keep now */ }
    const time = (o['time'] as number | undefined);
    return {
      method, url, status, mime,
      reqHeaders: harToHeaders(req['headers']),
      resHeaders: harToHeaders(res['headers']),
      reqText, resText, ts,
      timingMs: typeof time === 'number' && time >= 0 ? Math.round(time) : undefined,
    };
  } catch {
    return null;
  }
}

// Shared Deep Capture (CDP) contract: imported by background AND panel for types.
// Zero deps. Bodies cross as plain text in `cdp-body` port messages (bounded,
// truncated); raw CDP payloads never touch the panel's stores directly.

export type CdpWorkerKind = 'page' | 'iframe' | 'worker' | 'serviceworker' | 'unknown';

export interface CdpTargetInfo {
  targetId: string;
  kind: CdpWorkerKind;
  url: string;
  parentId?: string;
}

export interface CdpNetEvent {
  ev: 'req' | 'res' | 'fail' | 'redirect' | 'ws-frame';
  reqId: string;
  url: string;
  method?: string;
  status?: number;
  mime?: string;
  frameId?: string;
  targetId?: string;
  loaderId?: string;
  initiatorUrl?: string;
  protocol?: string;
  timingMs?: number;
  fromServiceWorker?: boolean;
  fromCache?: boolean;
  redirectUrl?: string;
  wsDir?: 'sent' | 'received';
  wsOpcode?: string;
  wsPayload?: string;
}

export function cdpTargetKind(type: string): CdpWorkerKind {
  switch (type) {
    case 'page':
      return 'page';
    case 'iframe':
      return 'iframe';
    case 'worker':
    case 'shared_worker':
      return 'worker';
    case 'service_worker':
      return 'serviceworker';
    default:
      return 'unknown';
  }
}

// ---- Deep Capture response bodies (Phase 2) --------------------------------
// The panel owns retention settings; the background only fetches what these
// pure gates allow. Unit-tested via verify.mjs; mirrored nowhere else.

/** Body-fetch prefs, shipped inside the panel's `cdp-start` opts. */
export interface CdpBodyPrefs {
  retainRaw: boolean;
  retainBinary: boolean;
  /** Hard char cap per body (background truncates; panel re-caps to its own budget). */
  maxBodyChars: number;
}

export const CDP_BODY_DEFAULT_CAP = 262_144; // 256 KB chars
/** Max concurrent getResponseBody calls — the debugger is a shared channel. */
export const CDP_BODY_MAX_INFLIGHT = 3;

const CDP_BINARY_URL = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|woff2?|ttf|otf|eot)(\?|$)/i;
const CDP_BINARY_MIME = /^(image|video|audio|font)\//i;

/** Gate: fetch this response body, or stay metadata-only? */
export function shouldFetchCdpBody(url: string, mime: string | undefined, prefs: CdpBodyPrefs): boolean {
  if (!prefs || prefs.retainRaw !== true) return false;
  if (typeof url !== 'string' || !/^https?:/.test(url)) return false;
  if (prefs.retainBinary === true) return true;
  if (mime && CDP_BINARY_MIME.test(mime)) return false;
  if (CDP_BINARY_URL.test(url)) return false;
  return true;
}

/**
 * Decode a getResponseBody payload (base64 or plain) and clamp to `cap`.
 * Returns null when the payload is missing/undecodable — caller stays silent
 * (cache/redirect bodies routinely unavailable; not an error worth a diag).
 */
export function decodeCdpBody(
  body: unknown, base64: unknown, cap: number,
): { text: string; truncated: boolean } | null {
  if (typeof body !== 'string' || !body.length) return null;
  const limit = typeof cap === 'number' && cap > 0 ? Math.min(cap, 1_048_576) : CDP_BODY_DEFAULT_CAP;
  let text = body;
  if (base64 === true) {
    try {
      // atob exists in service workers, pages, panels — and node (tests).
      const bin = atob(body);
      const n = Math.min(bin.length, limit);
      const chars = new Array<string>(n);
      for (let i = 0; i < n; i++) chars[i] = bin[i];
      text = chars.join('');
      return { text, truncated: bin.length > limit };
    } catch {
      return null;
    }
  }
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

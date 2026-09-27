// Minimal service-worker coordinator. RAM-only: keeps NO bodies, only tiny
// metadata counters + forwards events to the open DevTools panel port.
// Suspend-safe: all authoritative capture state lives in the panel.

import { cdpTargetKind, shouldFetchCdpBody, decodeCdpBody, CDP_BODY_MAX_INFLIGHT } from './cdp.js';
import type { CdpBodyPrefs, CdpNetEvent, CdpTargetInfo } from './cdp.js';
import { executeReplay } from './replay.js';
import type { ReplayRequest } from './replay.js';

interface PanelPort { tabId: number; port: chrome.runtime.Port }

const panelPorts = new Map<number, chrome.runtime.Port>();
let paused = false;
let deepCapture = false; // reserved for future CDP opt-in; reported in diagnostics

type NavInfo = { url: string; frameId: number; ts: number };
const lastNav = new Map<number, NavInfo>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'deepscope-panel') return;
  let tabId = -1;
  const cdpTabs = new Set<number>();
  port.onMessage.addListener((msg: { type: string; tabId?: number; paused?: boolean; opts?: { captureWs?: boolean } }) => {
    if (msg.type === 'hello' && typeof msg.tabId === 'number') {
      tabId = msg.tabId;
      panelPorts.set(tabId, port);
    } else if (msg.type === 'pause') {
      paused = !!msg.paused;
    } else if (msg.type === 'cdp-start') {
      const targetTab = typeof msg.tabId === 'number' ? msg.tabId : tabId;
      if (targetTab >= 0) {
        panelPorts.set(targetTab, port);
        cdpTabs.add(targetTab);
        const o = asObj(msg.opts);
        void cdpStart(targetTab, {
          captureWs: o['captureWs'] === true,
          retainRaw: o['retainRaw'] === true,
          retainBinary: o['retainBinary'] === true,
          maxBodyChars: typeof o['maxBodyChars'] === 'number' && o['maxBodyChars'] > 0 ? o['maxBodyChars'] : 262_144,
        });
      }
    } else if (msg.type === 'cdp-stop') {
      const targetTab = typeof msg.tabId === 'number' ? msg.tabId : tabId;
      if (targetTab >= 0) {
        cdpTabs.delete(targetTab);
        void cdpDetach(targetTab);
      }
    }
  });
  port.onDisconnect.addListener(() => { if (tabId >= 0) panelPorts.delete(tabId); });
  // Separate listener so the mapping cleanup above stays exactly as before:
  // detach the debugger for every tab this port started Deep Capture on.
  port.onDisconnect.addListener(() => {
    for (const t of cdpTabs) {
      if (panelPorts.get(t) === port) panelPorts.delete(t);
      void cdpDetach(t);
    }
    cdpTabs.clear();
  });
});

function forward(tabId: number, msg: unknown): void {
  if (paused && (msg as { type?: string }).type !== 'diag') return;
  panelPorts.get(tabId)?.postMessage(msg);
}

// ---- Deep Capture (CDP, opt-in only) -------------------------------------
// Tiny per-tab sessions: metadata only, no bodies ever. The debugger is NEVER
// attached unless the panel sends 'cdp-start' for a tab.

const CDP_PROTOCOL_VERSION = '1.3';
const CDP_MAX_TARGETS = 25;
const CDP_MAX_WS_FRAMES = 500;
const CDP_WS_PAYLOAD_CHARS = 4000;
const CDP_MAX_REQ_URLS = 400;

interface CdpSession {
  sessionId?: string;
  targets: Map<string, CdpTargetInfo>;
  lastTargetsSig: string;
  frameCount: number;
  wsFrames: number;
  captureWs: boolean;
  targetsCappedNoted: boolean;
  wsCappedNoted: boolean;
  urlByReqId: Map<string, string>;
  /** mimeType per requestId (from responseReceived) for the body gate. */
  mimeByReqId: Map<string, string>;
  /** requestIds already body-fetched (loadingFinished can repeat on redirects). */
  bodiesFetched: Set<string>;
  bodyInflight: number;
  bodyPrefs: CdpBodyPrefs;
}

const cdpSessions = new Map<number, CdpSession>();

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj {
  if (typeof v === 'object' && v !== null) return v as JsonObj;
  return {};
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function diagFor(tabId: number, note: string, url?: string): void {
  if (url === undefined) {
    forward(tabId, { type: 'diag', level: 'warn', note, ts: Date.now() });
  } else {
    forward(tabId, { type: 'diag', level: 'warn', note, url, ts: Date.now() });
  }
}

function broadcastDiag(note: string): void {
  const msg = { type: 'diag', level: 'warn', note, ts: Date.now() };
  for (const port of panelPorts.values()) {
    try {
      port.postMessage(msg);
    } catch {
      // best-effort: the port may already be gone
    }
  }
}

// Control-plane delivery bypasses the passive `paused` gate (like 'diag'):
// attach state and tab-closed must always reach the panel.
function cdpState(tabId: number, attached: boolean, note?: string): void {
  try {
    if (note === undefined) {
      panelPorts.get(tabId)?.postMessage({ type: 'cdp-state', tabId, attached });
    } else {
      panelPorts.get(tabId)?.postMessage({ type: 'cdp-state', tabId, attached, note });
    }
  } catch {
    // best-effort: the port may already be gone
  }
}

function tabClosed(tabId: number): void {
  try {
    panelPorts.get(tabId)?.postMessage({ type: 'tab-closed', tabId });
  } catch {
    // best-effort: the port may already be gone
  }
}

// requestId -> url cache (metadata only, bounded): loadingFailed and
// webSocketFrame* params carry no URL, so we recall it from requestWillBeSent.
function rememberReqUrl(tabId: number, reqId: string, url: string): void {
  const s = cdpSessions.get(tabId);
  if (!s || reqId === '' || url === '') return;
  if (!s.urlByReqId.has(reqId) && s.urlByReqId.size >= CDP_MAX_REQ_URLS) {
    const first = s.urlByReqId.keys().next().value as string | undefined;
    if (first !== undefined) s.urlByReqId.delete(first);
  }
  s.urlByReqId.set(reqId, url);
}

function cachedReqUrl(tabId: number, reqId: string): string {
  return cdpSessions.get(tabId)?.urlByReqId.get(reqId) ?? '';
}

// mimeType cache for the body gate (same bounded eviction as URLs).
function rememberReqMime(tabId: number, reqId: string, mime: string): void {
  const s = cdpSessions.get(tabId);
  if (!s || reqId === '' || mime === '') return;
  if (!s.mimeByReqId.has(reqId) && s.mimeByReqId.size >= CDP_MAX_REQ_URLS) {
    const first = s.mimeByReqId.keys().next().value as string | undefined;
    if (first !== undefined) s.mimeByReqId.delete(first);
  }
  s.mimeByReqId.set(reqId, mime);
}

function targetsSig(targets: Map<string, CdpTargetInfo>): string {
  const keys = [...targets.keys()].sort();
  const parts: string[] = [];
  for (const k of keys) {
    const t = targets.get(k);
    parts.push(`${k}|${t?.kind ?? ''}|${t?.url ?? ''}`);
  }
  return parts.join(';');
}

function publishTargets(tabId: number): void {
  const s = cdpSessions.get(tabId);
  if (!s) return;
  const sig = targetsSig(s.targets);
  if (sig === s.lastTargetsSig) return; // throttle: forward only when the set changes
  s.lastTargetsSig = sig;
  forward(tabId, { type: 'cdp-targets', tabId, targets: [...s.targets.values()] });
}

function trackTarget(tabId: number, raw: unknown): void {
  const s = cdpSessions.get(tabId);
  if (!s) return;
  const info = asObj(raw);
  const targetId = asStr(info['targetId']) ?? asStr(info['id']) ?? '';
  if (targetId === '') return;
  if (!s.targets.has(targetId) && s.targets.size >= CDP_MAX_TARGETS) {
    if (!s.targetsCappedNoted) {
      s.targetsCappedNoted = true;
      diagFor(tabId, `Deep Capture: target cap reached (${CDP_MAX_TARGETS}); dropping extras`);
    }
    return;
  }
  const entry: CdpTargetInfo = {
    targetId,
    kind: cdpTargetKind(asStr(info['type']) ?? ''),
    url: asStr(info['url']) ?? '',
  };
  const parentId = asStr(info['parentId']) ?? asStr(info['openerId']);
  if (parentId !== undefined) entry.parentId = parentId;
  s.targets.set(targetId, entry);
  publishTargets(tabId);
}

function emitCdp(tabId: number, ev: CdpNetEvent): void {
  const s = cdpSessions.get(tabId);
  if (s) s.frameCount++;
  forward(tabId, { type: 'cdp', tabId, ev });
}

/**
 * Best-effort response-body pull for one finished request. Gated by the
 * panel's retention prefs, bounded to CDP_BODY_MAX_INFLIGHT concurrent calls,
 * each body truncated — failures stay silent (cache/redirect/sub-target
 * bodies are routinely unavailable; the metadata event already landed).
 */
async function fetchCdpBody(tabId: number, reqId: string): Promise<void> {
  const s = cdpSessions.get(tabId);
  if (!s || s.bodiesFetched.has(reqId) || s.bodyInflight >= CDP_BODY_MAX_INFLIGHT) return;
  const url = s.urlByReqId.get(reqId) ?? '';
  const mime = s.mimeByReqId.get(reqId);
  if (!shouldFetchCdpBody(url, mime, s.bodyPrefs)) return;
  s.bodiesFetched.add(reqId);
  if (s.bodiesFetched.size > CDP_MAX_REQ_URLS * 2) {
    const first = s.bodiesFetched.values().next().value as string | undefined;
    if (first !== undefined) s.bodiesFetched.delete(first);
  }
  s.bodyInflight++;
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: reqId }) as { body?: unknown; base64Encoded?: unknown } | undefined;
    const decoded = decodeCdpBody(res?.body, res?.base64Encoded, s.bodyPrefs.maxBodyChars);
    if (!decoded) return;
    const port = panelPorts.get(tabId);
    if (!port) return;
    try {
      port.postMessage({
        type: 'cdp-body', tabId, reqId, url,
        mime: mime ?? '', text: decoded.text, truncated: decoded.truncated,
      });
    } catch { /* panel gone — drop */ }
  } catch {
    // getResponseBody fails for cached, redirected, and cross-session bodies.
  } finally {
    const cur = cdpSessions.get(tabId);
    if (cur) cur.bodyInflight = Math.max(0, cur.bodyInflight - 1);
  }
}

async function cdpDetach(tabId: number, note?: string): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // best-effort: already detached, or the tab is gone
  }
  cdpSessions.delete(tabId);
  // Never leave the debugger attached silently: always report state.
  cdpState(tabId, false, note);
}

interface CdpStartOpts {
  captureWs: boolean;
  retainRaw: boolean;
  retainBinary: boolean;
  maxBodyChars: number;
}

async function cdpStart(tabId: number, opts: CdpStartOpts): Promise<void> {
  const existing = cdpSessions.get(tabId);
  if (existing) {
    existing.captureWs = opts.captureWs;
    existing.bodyPrefs = { retainRaw: opts.retainRaw, retainBinary: opts.retainBinary, maxBodyChars: opts.maxBodyChars };
    cdpState(tabId, true, 'already attached');
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
  } catch (e) {
    const note = `Deep Capture attach failed: ${String(e).slice(0, 160)}`;
    diagFor(tabId, note);
    cdpState(tabId, false, note);
    return;
  }
  cdpSessions.set(tabId, {
    targets: new Map(),
    lastTargetsSig: '',
    frameCount: 0,
    wsFrames: 0,
    captureWs: opts.captureWs,
    targetsCappedNoted: false,
    wsCappedNoted: false,
    urlByReqId: new Map(),
    mimeByReqId: new Map(),
    bodiesFetched: new Set(),
    bodyInflight: 0,
    bodyPrefs: { retainRaw: opts.retainRaw, retainBinary: opts.retainBinary, maxBodyChars: opts.maxBodyChars },
  });
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  } catch (e) {
    const note = `Deep Capture Network.enable failed: ${String(e).slice(0, 160)}`;
    diagFor(tabId, note);
    await cdpDetach(tabId, note);
    return;
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (e) {
    // Non-fatal: Network capture still works; only the target list stays partial.
    diagFor(tabId, `Deep Capture Target.setAutoAttach failed: ${String(e).slice(0, 160)}`);
  }
  cdpState(tabId, true);
}

function handleDebuggerEvent(tabId: number | undefined, method: string, params: unknown): void {
  if (typeof tabId !== 'number') return;
  const s = cdpSessions.get(tabId);
  if (!s) return;
  const p = asObj(params);

  if (method === 'Target.targetCreated' || method === 'Target.attachedToTarget' || method === 'Target.targetInfoChanged') {
    if (method === 'Target.attachedToTarget') {
      const sid = asStr(p['sessionId']);
      if (sid !== undefined) s.sessionId = sid;
    }
    trackTarget(tabId, p['targetInfo']);
    return;
  }
  if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
    const id = asStr(p['targetId']);
    if (id !== undefined && s.targets.delete(id)) publishTargets(tabId);
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const req = asObj(p['request']);
    const reqId = asStr(p['requestId']) ?? '';
    const url = asStr(req['url']) ?? '';
    rememberReqUrl(tabId, reqId, url);
    const hasRedirect = typeof p['redirectResponse'] === 'object' && p['redirectResponse'] !== null;
    const ev: CdpNetEvent = hasRedirect
      ? { ev: 'redirect', reqId, url, redirectUrl: asStr(asObj(p['redirectResponse'])['url']) ?? '' }
      : { ev: 'req', reqId, url };
    const m = asStr(req['method']);
    if (m !== undefined) ev.method = m;
    const frameId = asStr(p['frameId']);
    if (frameId !== undefined) ev.frameId = frameId;
    const loaderId = asStr(p['loaderId']);
    if (loaderId !== undefined) ev.loaderId = loaderId;
    const targetId = asStr(p['targetId']);
    if (targetId !== undefined) ev.targetId = targetId;
    const initiatorUrl = asStr(asObj(p['initiator'])['url']) ?? asStr(p['documentURL']);
    if (initiatorUrl !== undefined) ev.initiatorUrl = initiatorUrl;
    emitCdp(tabId, ev);
    return;
  }

  if (method === 'Network.responseReceived') {
    const resp = asObj(p['response']);
    const reqId = asStr(p['requestId']) ?? '';
    const url = asStr(resp['url']) ?? '';
    rememberReqUrl(tabId, reqId, url);
    const mime = asStr(resp['mimeType']);
    if (mime !== undefined) rememberReqMime(tabId, reqId, mime);
    const ev: CdpNetEvent = { ev: 'res', reqId, url };
    const status = resp['status'];
    if (typeof status === 'number') ev.status = status;
    if (mime !== undefined) ev.mime = mime;
    const protocol = asStr(resp['protocol']);
    if (protocol !== undefined) ev.protocol = protocol;
    const fromSw = resp['fromServiceWorker'];
    if (typeof fromSw === 'boolean') ev.fromServiceWorker = fromSw;
    const fromDisk = resp['fromDiskCache'];
    if (typeof fromDisk === 'boolean') ev.fromCache = fromDisk;
    const loaderId = asStr(p['loaderId']);
    if (loaderId !== undefined) ev.loaderId = loaderId;
    const frameId = asStr(p['frameId']);
    if (frameId !== undefined) ev.frameId = frameId;
    const targetId = asStr(p['targetId']);
    if (targetId !== undefined) ev.targetId = targetId;
    const recvEnd = asObj(resp['timing'])['receiveHeadersEnd'];
    if (typeof recvEnd === 'number') ev.timingMs = recvEnd;
    emitCdp(tabId, ev);
    return;
  }

  if (method === 'Network.loadingFailed') {
    const reqId = asStr(p['requestId']) ?? '';
    const ev: CdpNetEvent = { ev: 'fail', reqId, url: cachedReqUrl(tabId, reqId) };
    const targetId = asStr(p['targetId']);
    if (targetId !== undefined) ev.targetId = targetId;
    emitCdp(tabId, ev);
    return;
  }

  if (method === 'Network.loadingFinished') {
    // Phase 2: pull the response body so worker/SW/iframe traffic lands in the
    // index too — not just metadata. Best-effort: cache/redirect bodies and
    // sub-target requests routinely fail here and are skipped silently.
    const reqId = asStr(p['requestId']) ?? '';
    if (reqId !== '') void fetchCdpBody(tabId, reqId);
    return;
  }

  if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    if (!s.captureWs) return;
    if (s.wsFrames >= CDP_MAX_WS_FRAMES) {
      if (!s.wsCappedNoted) {
        s.wsCappedNoted = true;
        diagFor(tabId, `Deep Capture: WebSocket frame cap reached (${CDP_MAX_WS_FRAMES}); dropping further frames`);
      }
      return;
    }
    s.wsFrames++;
    const reqId = asStr(p['requestId']) ?? '';
    const frame = asObj(p['response']);
    const ev: CdpNetEvent = {
      ev: 'ws-frame',
      reqId,
      url: cachedReqUrl(tabId, reqId),
      wsDir: method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
    };
    const opcode = frame['opcode'];
    if (typeof opcode === 'number' || typeof opcode === 'string') ev.wsOpcode = String(opcode);
    const payload = asStr(frame['payloadData']);
    if (payload !== undefined) ev.wsPayload = payload.slice(0, CDP_WS_PAYLOAD_CHARS);
    emitCdp(tabId, ev);
    return;
  }
}

// Navigation / frame / route tracking (metadata only).
chrome.webNavigation.onCommitted.addListener((d) => {
  lastNav.set(d.tabId, { url: d.url, frameId: d.frameId, ts: Date.now() });
  forward(d.tabId, { type: 'nav', url: d.url, frameId: d.frameId, kind: 'committed', ts: Date.now() });
});
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  // SPA route transition
  forward(d.tabId, { type: 'nav', url: d.url, frameId: d.frameId, kind: 'spa', ts: Date.now() });
});
chrome.webNavigation.onCompleted.addListener((d) => {
  forward(d.tabId, { type: 'nav', url: d.url, frameId: d.frameId, kind: 'completed', ts: Date.now() });
});

// Broader request observation — metadata only, bodies stay in panel via
// devtools.network. Requires host permission; without it we emit a diagnostic.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.url.startsWith('chrome-extension://') || d.url.startsWith('devtools://')) return;
    forward(d.tabId, {
      type: 'req-meta', id: String(d.requestId), url: d.url, method: d.method,
      frameId: d.frameId, initiator: d.initiator, ts: Date.now(),
    });
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0) return;
    forward(d.tabId, {
      type: 'res-meta', id: String(d.requestId), url: d.url, method: d.method,
      status: d.statusCode, ip: d.ip, ts: Date.now(),
    });
  },
  { urls: ['http://*/*', 'https://*/*'] },
);

chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (d.tabId < 0) return;
  forward(d.tabId, { type: 'diag', level: 'warn', url: d.url, note: `request error: ${d.error}`, ts: Date.now() });
},
  { urls: ['http://*/*', 'https://*/*'] },
);

// Messages from content scripts / panel (deep-scan coordination, diagnostics).
chrome.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (msg.type === 'content-batch' && typeof tabId === 'number') {
    forward(tabId, msg);
  } else if (msg.type === 'get-state') {
    sendResponse({ paused, deepCapture, hasPanel: tabId != null && panelPorts.has(tabId) });
    return true;
  } else if (msg.type === 'set-paused') {
    paused = !!(msg as { paused?: boolean }).paused;
  } else if (msg.type === 'replay-request') {
    // Requestly-style replay: executed here so target cookies attach and CORS
    // is bypassed for permitted hosts. Async — keep the channel open.
    void executeReplay(msg as unknown as ReplayRequest).then((res) => {
      try { sendResponse(res); } catch { /* panel gone */ }
    }).catch((e) => {
      try { sendResponse({ type: 'replay-response', id: (msg as { id?: string }).id ?? 'replay', ok: false, error: String(e).slice(0, 200) }); } catch { /* panel gone */ }
    });
    return true;
  }
});

// ---- Deep Capture wiring (opt-in only; the passive path above is untouched) --
try {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    handleDebuggerEvent(source?.tabId, method, params);
  });
} catch {
  // debugger API unavailable — cdp-start will diag-forward on failure
}
try {
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source?.tabId;
    if (typeof tabId !== 'number') return;
    cdpSessions.delete(tabId);
    cdpState(tabId, false, reason ? `debugger detached: ${reason}` : 'debugger detached');
  });
} catch {
  // debugger API unavailable — cdp-start will diag-forward on failure
}

// Best-effort tab-closed signals for the panel. Guarded: without the tabs API
// this stays disabled and capture itself is unaffected.
try {
  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((closedTabId) => {
      cdpSessions.delete(closedTabId);
      tabClosed(closedTabId);
    });
  } else {
    broadcastDiag('Deep Capture: tabs API unavailable; tab-closed events disabled');
  }
  if (chrome.tabs?.onReplaced) {
    chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
      cdpSessions.delete(removedTabId);
      tabClosed(removedTabId);
    });
  }
} catch {
  // tabs API unavailable — skip silently
}

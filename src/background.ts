// Minimal service-worker coordinator. RAM-only: keeps NO bodies, only tiny
// metadata counters + forwards events to the open DevTools panel port.
// Suspend-safe: all authoritative capture state lives in the panel.

interface PanelPort { tabId: number; port: chrome.runtime.Port }

const panelPorts = new Map<number, chrome.runtime.Port>();
let paused = false;
let deepCapture = false; // reserved for future CDP opt-in; reported in diagnostics

type NavInfo = { url: string; frameId: number; ts: number };
const lastNav = new Map<number, NavInfo>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'deepscope-panel') return;
  let tabId = -1;
  port.onMessage.addListener((msg: { type: string; tabId?: number; paused?: boolean }) => {
    if (msg.type === 'hello' && typeof msg.tabId === 'number') {
      tabId = msg.tabId;
      panelPorts.set(tabId, port);
    } else if (msg.type === 'pause') {
      paused = !!msg.paused;
    }
  });
  port.onDisconnect.addListener(() => { if (tabId >= 0) panelPorts.delete(tabId); });
});

function forward(tabId: number, msg: unknown): void {
  if (paused && (msg as { type?: string }).type !== 'diag') return;
  panelPorts.get(tabId)?.postMessage(msg);
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
  }
});

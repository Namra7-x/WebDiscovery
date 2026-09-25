// Content script — injected on demand (programmatic registration per-origin).
// Passive observer: DOM snapshot + MutationObserver + SPA hooks + lazy-load
// watcher. Batches findings to the panel via background relay. No persistence.

interface DomBatch {
  type: 'content-batch';
  tabId?: number;
  url: string;
  route: string;
  htmlLen: number;
  links: string[];
  scripts: string[];
  forms: string[];
  iframes: Array<{ src: string }>;
  routes: string[];
  manifest?: string | null;
  manifests: string[];
  chunks: string[];
  apis: string[];
  textSample: string;
  ts: number;
  /** Opt-in runtime-hook findings drained into this batch (cap 200). The
   *  background already forwards content-batch untouched, so piggybacking
   *  here needs zero new plumbing. */
  runtime?: RuntimeHit[];
}

interface RuntimeHit { t: string; method: string; url: string; ts: number }

let sentInitial = false;
let batchTimer = 0;
const seen = new Set<string>();

function routeOf(): string {
  try { return location.pathname + location.search; } catch { return '/'; }
}

function collectLinks(root: ParentNode, out: { links: string[]; scripts: string[]; iframes: Array<{ src: string }>; routes: string[] }): void {
  const anchors = root.querySelectorAll?.('a[href], link[href], area[href]') ?? [];
  anchors.forEach((el) => {
    const h = (el as HTMLAnchorElement).getAttribute('href');
    if (!h || h.startsWith('javascript:') || h.startsWith('data:') || h.startsWith('#')) return;
    try {
      const abs = new URL(h, location.href).toString();
      if (abs.length < 600) { out.links.push(abs); if (new URL(abs).origin === location.origin) out.routes.push(new URL(abs).pathname); }
    } catch { /* ignore */ }
  });
  root.querySelectorAll?.('script[src]').forEach((el) => {
    const s = (el as HTMLScriptElement).src;
    if (s) out.scripts.push(s);
  });
  root.querySelectorAll?.('iframe[src]').forEach((el) => {
    const s = (el as HTMLIFrameElement).src;
    if (s) out.iframes.push({ src: s });
  });
}

function scanJsStrings(): { chunks: string[]; apis: string[] } {
  // Runtime-visible surface: performance entries + inline script text.
  const chunks: string[] = [];
  const apis: string[] = [];
  try {
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      const n = e.name;
      if (!n || seen.has('r' + n)) continue;
      if (/\.js($|\?)/.test(n) && /chunk|lazy|async|assets\//.test(n)) chunks.push(n);
      if (/\/api\//.test(n)) apis.push(n);
      seen.add('r' + n);
    }
  } catch { /* ignore */ }
  try {
    document.querySelectorAll('script:not([src])').forEach((el) => {
      const t = el.textContent ?? '';
      const re = /(https?:\/\/[^\s"'`]{4,160}|\/[a-z][A-Za-z0-9/_.~-]{2,120})/g;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(t)) && n < 60) {
        const v = m[1];
        if (/\/api\//.test(v)) apis.push(v);
        else if (/\.js(\?|$)/.test(v) || /chunk|assets\//.test(v)) chunks.push(v);
        n++;
      }
    });
  } catch { /* ignore */ }
  return { chunks: chunks.slice(0, 80), apis: apis.slice(0, 80) };
}

/** Next.js build/ssg manifests: script srcs whose filename contains
 *  'buildmanifest' or 'ssgmanifest' (case-insensitive, absolute URLs, cap 8). */
function collectManifests(): string[] {
  const out: string[] = [];
  try {
    document.querySelectorAll?.('script[src]').forEach((el) => {
      if (out.length >= 8) return;
      const s = (el as HTMLScriptElement).src;
      if (!s) return;
      const low = s.toLowerCase();
      if (low.includes('buildmanifest') || low.includes('ssgmanifest')) {
        try {
          const abs = new URL(s, location.href).toString();
          if (abs.length < 600) out.push(abs);
        } catch { /* ignore */ }
      }
    });
  } catch { /* ignore */ }
  return out.slice(0, 8);
}

/** Importmap blocks: JSON.parse tolerant, take .imports values that are
 *  http(s) or start with '/' → resolve via new URL(v, location.href) (cap 20). */
function collectImportmapLinks(): string[] {
  const out: string[] = [];
  try {
    document.querySelectorAll?.('script[type="importmap"]').forEach((el) => {
      if (out.length >= 20) return;
      const raw = el.textContent ?? '';
      if (!raw.trim()) return;
      let parsed: { imports?: unknown };
      try { parsed = JSON.parse(raw.slice(0, 20000)); } catch { return; }
      const imports = (parsed as { imports?: Record<string, unknown> })?.imports;
      if (!imports || typeof imports !== 'object') return;
      for (const v of Object.values(imports)) {
        if (out.length >= 20) break;
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (!t) continue;
        if (/^https?:\/\//i.test(t) || t.startsWith('/')) {
          try {
            const abs = new URL(t, location.href).toString();
            if (abs.length < 600) out.push(abs);
          } catch { /* ignore */ }
        }
      }
    });
  } catch { /* ignore */ }
  return out.slice(0, 20);
}

function snapshot(reason: string): void {
  try {
    const out = { links: [] as string[], scripts: [] as string[], iframes: [] as Array<{ src: string }>, routes: [] as string[] };
    collectLinks(document, out);
    const { chunks, apis } = scanJsStrings();
    const forms: string[] = [];
    document.querySelectorAll('form').forEach((f, i) => {
      if (i < 40) forms.push(`${(f as HTMLFormElement).action || location.href} [${(f as HTMLFormElement).method || 'get'}]`);
    });
    const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null;
    const manifests = collectManifests();
    const importmapLinks = collectImportmapLinks();
    const textSample = (document.body?.innerText ?? '').slice(0, 4000);
    const batch: DomBatch = {
      type: 'content-batch', url: location.href, route: routeOf(),
      htmlLen: document.documentElement?.outerHTML?.length ?? 0,
      links: [...new Set([...out.links, ...importmapLinks])].slice(0, 300),
      scripts: [...new Set(out.scripts)].slice(0, 120),
      forms, iframes: out.iframes.slice(0, 40),
      routes: [...new Set(out.routes)].slice(0, 200),
      manifest, manifests, chunks: [...new Set(chunks)], apis: [...new Set(apis)],
      textSample, ts: Date.now(),
    };
    const rt = drainRuntime(200);
    if (rt.length) batch.runtime = rt;
    try {
      void Promise.resolve(chrome.runtime.sendMessage(batch)).catch(() => undefined);
    } catch { /* extension context unavailable; panel eval fallback still works */ }
  } catch { /* page context may restrict; diagnostics surface in panel */ }
}

function schedule(): void {
  if (batchTimer) return;
  batchTimer = window.setTimeout(() => { batchTimer = 0; snapshot('mut'); }, 1200);
}

// Passive hooks
if (!sentInitial) {
  sentInitial = true;
  snapshot('init');
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: false });
  } catch { /* ignore */ }
  // SPA transition monitoring: history API + hash + performance lazy chunks
  try {
    const push = history.pushState.bind(history);
    history.pushState = (...a: Parameters<typeof push>) => { const r = push(...a); try { rtPush('history', 'GET', location.href); } catch { /* ignore */ } schedule(); return r; };
    const repl = history.replaceState.bind(history);
    history.replaceState = (...a: Parameters<typeof repl>) => { const r = repl(...a); try { rtPush('history', 'GET', location.href); } catch { /* ignore */ } schedule(); return r; };
    window.addEventListener('popstate', schedule);
    window.addEventListener('hashchange', schedule);
  } catch { /* ignore */ }
  // Lazy-load observation
  try {
    new PerformanceObserver(schedule).observe({ type: 'resource', buffered: true });
  } catch { /* ignore */ }
}

// Deep-scan helper: panel evals `window.__deepscope_crawl()` when present.
(window as unknown as { __deepscope_crawl?: () => string[] }).__deepscope_crawl = () => {
  const found = new Set<string>();
  document.querySelectorAll('a[href]').forEach((el) => {
    const h = (el as HTMLAnchorElement).getAttribute('href');
    if (!h) return;
    try {
      const u = new URL(h, location.href);
      if (u.origin === location.origin) found.add(u.pathname + u.search);
    } catch { /* ignore */ }
  });
  // Next/Nuxt-style router hints
  document.querySelectorAll('[data-route, [href^="/"]').forEach((el) => {
    const r = el.getAttribute('data-route');
    if (r) found.add(r);
  });
  try {
    for (const k of Object.keys((window as unknown as Record<string, unknown>).__NEXT_DATA__ as object ?? {})) void k;
    const nd = (window as unknown as { __NEXT_DATA__?: { page?: string } }).__NEXT_DATA__;
    if (nd?.page) found.add(nd.page);
  } catch { /* ignore */ }
  return [...found].slice(0, 200);
};

// ----- Opt-in runtime hook (armed by the panel, never automatic) -----
// The panel sets `window.__deepscope_hook = true` via inspectedWindow.eval
// only when Deep Capture is attached AND settings.deep.runtimeHook is on.
// This script polls that DOM flag every 2s (cheap) to arm/disarm; wrappers
// stay installed once created but no-op while disarmed. Findings batch
// {t,method,url,ts} (cap 200/batch, 1s throttle) piggybacked on the existing
// content-batch channel, so no new messaging or permissions are needed.
//
// NOTE: content.ts is standalone (no imports by design). The helper below
// mirrors types.ts isSubdomainOf() with identical semantics (strict
// dot-boundary; www-folded). The existing === origin checks above were kept
// as-is: swapping them for subdomain matching would broaden route collection
// (behavior change), so only the new runtime path uses subdomain awareness.
function isSubdomainOf(host: string, base: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const b = base.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h || !b) return false;
  const hh = h.replace(/^www\./, '');
  return hh === b || hh.endsWith(`.${b}`);
}

const rtBuf: RuntimeHit[] = [];
let hookArmed = false;
let hooksInstalled = false;

function rtPush(t: string, method: string, url: string): void {
  if (!hookArmed) return;
  try {
    const u = String(url ?? '').slice(0, 600);
    if (!u || /^(data|blob|javascript):/i.test(u)) return;
    rtBuf.push({ t, method: String(method ?? 'GET').toUpperCase().slice(0, 12) || 'GET', url: u, ts: Date.now() });
    if (rtBuf.length > 1000) rtBuf.splice(0, rtBuf.length - 1000);
  } catch { /* ignore */ }
}

function drainRuntime(n: number): RuntimeHit[] {
  if (!rtBuf.length) return [];
  return rtBuf.splice(0, Math.min(n, rtBuf.length));
}

function flushRuntime(): void {
  const runtime = drainRuntime(200);
  if (!runtime.length) return;
  try {
    const batch: DomBatch = {
      type: 'content-batch', url: location.href, route: routeOf(), htmlLen: 0,
      links: [], scripts: [], forms: [], iframes: [], routes: [],
      manifest: null, manifests: [], chunks: [], apis: [], textSample: '',
      ts: Date.now(), runtime,
    };
    void Promise.resolve(chrome.runtime.sendMessage(batch)).catch(() => undefined);
  } catch { /* ignore */ }
}

/** Ultra-light wrappers: fetch/XHR/WebSocket/EventSource/sendBeacon/history.
 *  Passive unless hookArmed; each install guarded so page breakage is impossible. */
function installRuntimeHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  try {
    const origFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      try {
        let u = '';
        let m = init?.method ?? 'GET';
        if (typeof input === 'string') u = input;
        else if (input instanceof URL) u = input.toString();
        else { u = (input as Request).url; if (!init?.method) m = (input as Request).method ?? 'GET'; }
        rtPush('fetch', m, u);
      } catch { /* ignore */ }
      return origFetch(input, init);
    }) as typeof window.fetch;
  } catch { /* ignore */ }
  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;
    (XP as unknown as { open: (...a: unknown[]) => unknown }).open = function (...a: unknown[]): unknown {
      try {
        const o = this as unknown as { __dsc?: { m: string; u: string } };
        if (typeof a[0] === 'string' && (typeof a[1] === 'string' || a[1] instanceof URL)) o.__dsc = { m: a[0], u: String(a[1]) };
      } catch { /* ignore */ }
      return (origOpen as (...a: unknown[]) => unknown).apply(this, a);
    };
    (XP as unknown as { send: (...a: unknown[]) => unknown }).send = function (...a: unknown[]): unknown {
      try {
        const d = (this as unknown as { __dsc?: { m: string; u: string } }).__dsc;
        if (d) rtPush('xhr', d.m, new URL(d.u, location.href).toString());
      } catch { /* ignore */ }
      return (origSend as (...a: unknown[]) => unknown).apply(this, a);
    };
  } catch { /* ignore */ }
  try {
    const WS = window.WebSocket;
    function WrappedWS(url: string | URL, protocols?: string | string[]): WebSocket {
      try { rtPush('ws', 'GET', url.toString()); } catch { /* ignore */ }
      return new WS(url, protocols);
    }
    WrappedWS.prototype = WS.prototype;
    Object.setPrototypeOf(WrappedWS, WS);
    window.WebSocket = WrappedWS as unknown as typeof WebSocket;
  } catch { /* ignore */ }
  try {
    const ES = window.EventSource;
    if (typeof ES === 'function') {
      function WrappedES(url: string | URL, init?: EventSourceInit): EventSource {
        try { rtPush('sse', 'GET', url.toString()); } catch { /* ignore */ }
        return new ES(url, init);
      }
      WrappedES.prototype = ES.prototype;
      Object.setPrototypeOf(WrappedES, ES);
      (window as unknown as { EventSource: unknown }).EventSource = WrappedES;
    }
  } catch { /* ignore */ }
  try {
    const origBeacon = navigator.sendBeacon.bind(navigator) as (url: string | URL, data?: BodyInit | null) => boolean;
    navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null): boolean => {
      try { rtPush('beacon', 'POST', url.toString()); } catch { /* ignore */ }
      return origBeacon(url, data);
    }) as typeof navigator.sendBeacon;
  } catch { /* ignore */ }
}

try {
  window.setInterval(() => {
    try {
      hookArmed = (window as unknown as { __deepscope_hook?: unknown }).__deepscope_hook === true;
      if (hookArmed) installRuntimeHooks();
    } catch { /* ignore */ }
  }, 2000);
} catch { /* ignore */ }
try {
  window.setInterval(() => {
    try { if (hookArmed && rtBuf.length) flushRuntime(); } catch { /* ignore */ }
  }, 1000);
} catch { /* ignore */ }

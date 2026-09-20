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
  chunks: string[];
  apis: string[];
  textSample: string;
  ts: number;
}

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
    const textSample = (document.body?.innerText ?? '').slice(0, 4000);
    const batch: DomBatch = {
      type: 'content-batch', url: location.href, route: routeOf(),
      htmlLen: document.documentElement?.outerHTML?.length ?? 0,
      links: [...new Set(out.links)].slice(0, 300),
      scripts: [...new Set(out.scripts)].slice(0, 120),
      forms, iframes: out.iframes.slice(0, 40),
      routes: [...new Set(out.routes)].slice(0, 200),
      manifest, chunks: [...new Set(chunks)], apis: [...new Set(apis)],
      textSample, ts: Date.now(),
    };
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
    history.pushState = (...a: Parameters<typeof push>) => { const r = push(...a); schedule(); return r; };
    const repl = history.replaceState.bind(history);
    history.replaceState = (...a: Parameters<typeof repl>) => { const r = repl(...a); schedule(); return r; };
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

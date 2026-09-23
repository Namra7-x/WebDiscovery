// DeepScope DevTools panel — session owner. All capture state is RAM-only here
// and destroyed when DevTools closes. Heavy extraction runs in worker-indexer.

import { DiscoveryGraph } from './graph.js';
import { RamIndex } from './indexer.js';
import { MemoryLedger, formatBytes } from './memory.js';
import { displayNameFor, searchIndex } from './search.js';
import { extractHtml, resolveUrl } from './extractors.js';
import { scanTextForSecrets } from './rules.js';
import { buildCurl, groupMime, netGroupCounts, netMethodCounts, optionsHtml, resourceKindCounts } from './tables.js';
import type { SearchResult, Severity, TextRecord } from './types.js';
import {
  DEFAULT_SETTINGS, defaultScope,
  type DiscoveryMethod, type NetEntry, type ResourceKind, type ResourceMeta,
  type SearchMode, type SearchScope, type SessionSettings,
} from './types.js';

const tabId = chrome.devtools.inspectedWindow.tabId;
let settings: SessionSettings = structuredClone(DEFAULT_SETTINGS);
let scope: SearchScope = defaultScope();
let paused = false;
let sessionOrigin = '';
let sessionRoute = '/';

const index = new RamIndex();
const graph = new DiscoveryGraph();
const ledger = new MemoryLedger();
const resources = new Map<string, ResourceMeta>();
const rawBodies = new Map<string, string>();
const rawOrder: string[] = [];
const contentHash = new Map<string, number>();
const netEntries: NetEntry[] = [];
const routes = new Map<string, { method: DiscoveryMethod; count: number }>();
const reqMetaByUrl = new Map<string, { method: string; initiator?: string }>();
const diags: Array<{ ts: number; note: string; url?: string }> = [];
// Secret findings (Analyze tab): snapshots of indexed units that arrived with
// a worker/fallback `sec` hit attached. Bounded; drops counted + diag-once.
interface SecFinding { text: string; prov: TextRecord['prov']; rule: string; sev: Severity; label: string }
const secFindings: SecFinding[] = [];
let secDropped = 0;
let secDiagOnce = false;
/** Last rendered Analyze slice (backs Open/Copy buttons by index). */
const renderedSec: SecFinding[] = [];
/** Units arriving at commitUnits() / the worker 'units' message. `sec` is the
 *  first secret hit attached by the worker/fallback via scanTextForSecrets. */
interface IndexUnit { text: string; line: number; column: number; kind: string; extra?: string; sec?: { rule: string; sev: Severity; label: string } }
let worker: Worker | null = null;
let workerSeq = 0;
const workerPending = new Map<number, { url: string; route: string; kind: ResourceKind; mime: string; prov: Omit<import('./types.js').Provenance, 'resourceUrl' | 'resourceKind' | 'route'> & { method: DiscoveryMethod; initiator?: string; parentUrl?: string; detail?: string } }>();
let searchTimer = 0;
let renderTimer = 0;
let netMethod = 'ALL';
let netKind = 'ALL';
let resType = 'ALL';
// Cached option signatures — skip DOM writes when live counts are unchanged.
let resTypeSig = '';
let netMethodSig = '';
let netKindSig = '';
let viewerUrl = '';

// ---------- dom ----------
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Null-safe listener: one missing/stale element must never kill the whole wiring. */
function on(id: string, ev: string, fn: (e: Event) => void): void {
  try { document.getElementById(id)?.addEventListener(ev, fn); } catch { /* ignore */ }
}
/** Dismiss the content preview (Close / ✕ / backdrop / Esc all funnel here). */
function closeViewer(): void {
  try { document.getElementById('viewer')?.classList.add('hidden'); } catch { /* ignore */ }
  viewerUrl = '';
}

function diag(note: string, url?: string): void {
  diags.unshift({ ts: Date.now(), note, url });
  if (diags.length > 120) diags.pop();
  renderDiags();
}

function evalInPage<T>(expr: string): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.devtools.inspectedWindow.eval(expr, (res: unknown, err: unknown) => {
        if (err) reject(new Error(String((err as { value?: string }).value ?? err)));
        else resolve(res as T);
      });
    } catch (e) { reject(e); }
  });
}

// ---------- worker ----------
function initWorker(): void {
  try {
    worker = new Worker(chrome.runtime.getURL('dist/worker-indexer.js'), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ type: string; id: number; units: IndexUnit[]; error?: string }>) => {
      const m = ev.data;
      if (!m || m.type !== 'units') return;
      const p = workerPending.get(m.id);
      workerPending.delete(m.id);
      if (!p) return;
      if (m.error) { diag(`indexer worker: ${m.error}`, p.url); return; }
      commitUnits(p.url, p.route, p.kind, p.mime, p.prov, m.units);
    };
    worker.onerror = () => { diag('indexer worker failed; using main-thread fallback'); worker = null; };
  } catch { worker = null; }
}

// ---------- memory ----------
function enforceBudget(context: string): void {
  ledger.setBudget(settings.budgetMB);
  const st = ledger.checkWarn();
  const warn = $('budgetWarn');
  if (st === 'over' || ledger.over()) {
    if (settings.onBudget === 'stop-capture' && !paused) { paused = true; syncPause(); diag(`memory budget exceeded — capture stopped (${context})`); }
    else if (settings.onBudget === 'discard-oldest-raw') {
      let freed = 0;
      while (ledger.over() && rawOrder.length) {
        const u = rawOrder.shift()!;
        const b = rawBodies.get(u);
        if (b) { freed += b.length; rawBodies.delete(u); }
        ledger.rawBytes = Math.max(0, ledger.rawBytes - freed);
        freed = 0;
      }
      diag(`memory budget exceeded — discarded oldest raw bodies, kept index (${context})`);
    } else if (settings.onBudget === 'stop-deep-analysis') {
      stopDeepScan('memory budget');
      diag(`memory budget exceeded — deep analysis stopped (${context})`);
    }
    warn.classList.remove('hidden');
    warn.textContent = `Memory budget exceeded (${formatBytes(ledger.usedBytes)} / ${settings.budgetMB} MB). Policy applied: ${settings.onBudget}. Raw bodies were dropped first; the search index is preserved.`;
  } else if (st === 'warn') {
    warn.classList.remove('hidden');
    warn.textContent = `Approaching memory budget: ${formatBytes(ledger.usedBytes)} / ${settings.budgetMB} MB (${ledger.pct.toFixed(0)}%). Policy on exceed: ${settings.onBudget}.`;
  } else if (ledger.pct < 85) {
    warn.classList.add('hidden');
  }
  renderMem();
}

// ---------- ingest ----------
function kindFor(url: string, mime: string): ResourceKind {
  const u = url.toLowerCase();
  if (/\.map($|\?)|source-?map|application\/json\+sourcemap/.test(u + mime)) return 'source-map';
  if (/json/.test(mime) || /\/api\//.test(u) && !/\.(js|css|png|jpg|woff)/.test(u)) return 'api-json';
  if (/javascript|ecmascript/.test(mime) || /\.m?js($|\?)/.test(u)) return /chunk|lazy|async|assets\//.test(u) ? 'chunk' : 'script';
  if (/css/.test(mime) || /\.css($|\?)/.test(u)) return 'stylesheet';
  if (/html/.test(mime) || u === sessionOrigin + '/' || !/\.\w{2,4}($|\?)/.test(u)) return 'document';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3)($|\?)/.test(u)) return 'media-meta';
  if (/\.(woff2?|ttf|otf|eot)($|\?)/.test(u)) return 'font-meta';
  if (/text|xml|csv/.test(mime)) return 'other-text';
  return 'other-text';
}

function isBinaryKind(k: ResourceKind): boolean { return k === 'media-meta' || k === 'font-meta'; }

async function ingestText(
  url: string, text: string, opts: {
    kind?: ResourceKind; mime?: string; route?: string; method?: DiscoveryMethod;
    initiator?: string; parentUrl?: string; status?: number; detail?: string; jsonPath?: string;
  } = {},
): Promise<void> {
  if (paused || !text) return;
  const route = opts.route ?? sessionRoute;
  const mime = opts.mime ?? '';
  const kind = opts.kind ?? kindFor(url, mime);
  if (isBinaryKind(kind) && !settings.includeBinaryMeta) return;
  if (isBinaryKind(kind)) {
    upsertResource(url, { url, kind, route, method: opts.method ?? 'devtools-network', status: opts.status, mime, size: text.length, indexed: false, hasSourceMap: false, indexedStrings: 0, ts: Date.now() });
    return; // metadata only — never index binary bytes
  }
  const capKey = opts.method ?? 'devtools-network';
  if (!captureAllowed(kind)) { diag(`skipped by capture toggle: ${kind}`, url); return; }
  if (resources.size >= settings.maxResources) { diag(`resource cap reached (${settings.maxResources}); skipping`, url); return; }
  // Dedupe identical URL+content
  let h = 0;
  for (let i = 0; i < text.length; i += 7) h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0;
  if (contentHash.get(url) === h) return;
  contentHash.set(url, h);

  const capped = text.length > settings.maxResponseBytes
    ? text.slice(0, settings.maxResponseBytes)
    : text;
  const truncated = capped.length < text.length;
  if (truncated) diag(`truncated to maxResponseBytes (${formatBytes(settings.maxResponseBytes)})`, url);

  const indexedSlice = capped.slice(0, settings.maxIndexedChars);
  const meta: ResourceMeta = {
    url, kind, route, method: capKey, initiator: opts.initiator, status: opts.status, mime,
    size: capped.length, indexed: false, hasSourceMap: false, indexedStrings: 0, ts: Date.now(),
  };
  if (truncated) meta.error = 'truncated: exceeded maxResponseBytes';
  const isNewResource = !resources.has(url);
  resources.set(url, meta);
  ledger.resources = resources.size;
  if (isNewResource && kind === 'chunk') ledger.chunks++;

  // Route + graph bookkeeping
  touchRoute(route, capKey);
  graph.addNode(graph.routeNode(route), route, 'route', route);
  graph.addNode(url, shortLabel(url), kind === 'chunk' ? 'chunk' : url.includes('/api/') ? 'endpoint' : 'resource', url);
  graph.link(graph.routeNode(route), url, capKey);

  if (settings.retainRaw) {
    rawBodies.set(url, capped);
    rawOrder.push(url);
    ledger.rawBytes += capped.length;
  }
  enforceBudget(`ingest ${kind}`);

  // Source-map discovery for JS
  if (settings.analyzeSourceMaps && (kind === 'script' || kind === 'chunk')) {
    const sm = /\/\/#\s*sourceMappingURL\s*=\s*(\S+)/.exec(capped.slice(-6000));
    if (sm?.[1] && !sm[1].startsWith('data:')) {
      const smUrl = resolveUrl(url, sm[1]);
      meta.hasSourceMap = true; meta.sourceMapUrl = smUrl;
      graph.addNode(smUrl, shortLabel(smUrl), 'resource', smUrl);
      graph.link(url, smUrl, 'sourcemap-ref');
      void fetchSourceMap(url, smUrl, route);
    }
  }

  // Extract units in worker (or inline fallback)
  const prov = { method: capKey, initiator: opts.initiator, parentUrl: opts.parentUrl, detail: opts.detail, jsonPath: opts.jsonPath };
  if (worker) {
    const id = ++workerSeq;
    workerPending.set(id, { url, route, kind, mime, prov });
    worker.postMessage({ type: 'index-text', id, text: indexedSlice, url, route, mime, kind, advancedJs: settings.advancedJsAnalysis, scanSecrets: settings.analyzeSecrets });
  } else {
    const { extractCss, extractJs, extractJsAdvanced, extractJson } = await import('./extractors.js');
    const rawUnits = kind === 'api-json' ? extractJson(indexedSlice)
      : (kind === 'script' || kind === 'chunk') ? extractJs(indexedSlice).concat(settings.advancedJsAnalysis ? extractJsAdvanced(indexedSlice) : [])
      : kind === 'stylesheet' ? extractCss(indexedSlice)
      : kind === 'document' || kind === 'dom' ? extractHtml(indexedSlice, url).units
      : extractJson(indexedSlice);
    // No-worker fallback: attach the same first-hit `sec` the worker would add.
    const units: IndexUnit[] = rawUnits.map((u) => ({ text: u.text, line: u.line, column: u.column, kind: u.kind, extra: u.extra }));
    if (settings.analyzeSecrets) {
      for (const u of units) {
        const hits = scanTextForSecrets(u.text, 1);
        if (hits.length) u.sec = { rule: hits[0].rule, sev: hits[0].sev, label: hits[0].label };
      }
    }
    commitUnits(url, route, kind, mime, prov, units);
  }

  // Follow-up discovery: imports / fetch targets / links (bounded, same-origin default)
  scheduleRender();
}

function commitUnits(
  url: string, route: string, kind: ResourceKind, mime: string,
  provBase: { method: DiscoveryMethod; initiator?: string; parentUrl?: string; detail?: string; jsonPath?: string },
  units: IndexUnit[],
): void {
  let added = 0;
  for (const u of units) {
    const prov = {
      resourceUrl: url, resourceKind: kind, route,
      method: provBase.method, initiator: provBase.initiator, parentUrl: provBase.parentUrl,
      line: u.line > 0 ? u.line : undefined, column: u.column > 0 ? u.column : undefined,
      jsonPath: u.kind.startsWith('json-') ? u.extra : (u.kind === 'endpoint' || u.kind === 'route' ? u.extra?.startsWith('models') || u.extra?.includes('.') ? u.extra : undefined : undefined),
      detail: u.kind,
    };
    // URL-kind units also feed the discovery queue — v1.2 includes the
    // two-pass route/endpoint/asset facets so NOTHING hides in bundles.
    if ((u.kind === 'url' || u.kind === 'endpoint' || u.kind === 'route' || u.kind === 'asset-ref' || u.kind === 'fetch-target' || u.kind.endsWith('-import') || u.kind === 'importmap' || u.kind === 'dom-data-url' || u.kind === 'dom-link' || u.kind === 'css-reference' || u.kind === 'css-import') && u.text) {
      considerDiscoveredUrl(url, u.text, route, u.kind);
    }
    if (index.add(u.text, prov) !== null) {
      added++;
      if (u.sec) {
        if (secFindings.length < 2000) {
          secFindings.push({ text: u.text, prov, rule: u.sec.rule, sev: u.sec.sev, label: u.sec.label });
        } else {
          secDropped++;
          if (!secDiagOnce) { secDiagOnce = true; diag('secret findings cap reached (2000 kept); further hits dropped — use Copy findings promptly'); }
        }
      }
    }
    void mime;
  }
  const meta = resources.get(url);
  if (meta) { meta.indexed = true; meta.indexedStrings = added; }
  ledger.records = index.size;
  ledger.indexedChars = index.indexedChars;
  ledger.indexBytes = Math.round(index.indexBytes);
  if (!settings.retainRaw) {
    // raw was never stored in non-retain mode; account only transiently
  }
  enforceBudget('index-commit');
  scheduleRender();
}

function upsertResource(url: string, m: ResourceMeta): void {
  resources.set(url, m);
  ledger.resources = resources.size;
}

function touchRoute(route: string, method: DiscoveryMethod): void {
  const r = routes.get(route);
  if (r) r.count++;
  else { routes.set(route, { method, count: 1 }); ledger.routes = routes.size; }
}

function captureAllowed(kind: ResourceKind): boolean {
  const c = settings.capture;
  if (kind === 'document' || kind === 'dom') return c.dom;
  if (kind === 'script' || kind === 'chunk') return c.js;
  if (kind === 'stylesheet') return c.css;
  if (kind === 'api-json' || kind === 'api-text' || kind === 'xhr' || kind === 'fetch') return c.json;
  return true;
}

// Discovered-URL queue (feeds Deep Scan; in passive mode only indexes the string).
const discoveredUrls: Array<{ from: string; url: string; route: string; kind: string }> = [];
function considerDiscoveredUrl(from: string, raw: string, route: string, kind: string): void {
  // Route/endpoint facets are bare paths ("/api/models"); register them as
  // first-class routes immediately so the Routes tab + graph show them even
  // before Deep Scan fetches them.
  if ((kind === 'route' || kind === 'endpoint') && raw.startsWith('/')) {
    touchRoute(raw.split('?')[0].split('#')[0] || '/', kind === 'endpoint' ? 'fetch-target' : 'router');
    graph.addNode(graph.routeNode(raw.split('?')[0]), raw.split('?')[0], 'route', raw.split('?')[0]);
    graph.link(graph.routeNode(route), graph.routeNode(raw.split('?')[0]), kind === 'endpoint' ? 'fetch-target' : 'router', kind);
  }
  let abs: string;
  try { abs = new URL(raw, from).toString(); } catch { return; }
  if (!/^https?:/.test(abs) || abs.length > 500) return;
  if (discoveredUrls.length < 2000) discoveredUrls.push({ from, url: abs, route, kind });
  // Graph edge for provenance
  const isEndpoint = abs.includes('/api/') || kind === 'endpoint' || kind === 'fetch-target';
  graph.addNode(abs, shortLabel(abs), isEndpoint ? 'endpoint' : 'resource', abs);
  const via: DiscoveryMethod = kind === 'dynamic-import' ? 'dynamic-import' : kind === 'static-import' || kind === 'importmap' ? 'static-import'
    : kind === 'fetch-target' || kind === 'endpoint' ? 'fetch-target' : kind === 'route' ? 'router' : kind === 'dom-link' ? 'dom-link'
    : kind === 'css-reference' || kind === 'css-import' ? 'css-reference' : kind === 'asset-ref' ? 'js-string' : 'js-string';
  graph.link(from, abs, via, kind);
}

async function fetchSourceMap(minUrl: string, smUrl: string, route: string): Promise<void> {
  try {
    const text = await evalInPage<string>(`(async()=>{try{const r=await fetch(${JSON.stringify(smUrl)},{credentials:'same-origin'});if(!r.ok)return '__ERR__:HTTP '+r.status;const t=await r.text();return t.slice(0,3000000);}catch(e){return '__ERR__:'+String(e)}})()`);
    if (!text || text.startsWith('__ERR__')) { diag(`source map unavailable (${text?.slice(0, 80) ?? 'fetch failed'}). Cross-origin maps need site access grant.`, smUrl); return; }
    let map: { sources?: string[]; sourcesContent?: Array<string | null> };
    try { map = JSON.parse(text); } catch { diag('source map malformed JSON', smUrl); return; }
    const sources = map.sources ?? [];
    const contents = map.sourcesContent ?? [];
    let n = 0;
    for (let i = 0; i < sources.length && n < 400; i++) {
      const srcName = sources[i];
      const content = contents[i];
      if (typeof content === 'string' && content.length > 10) {
        await ingestText(`${smUrl}#${srcName}`, content.slice(0, 200000), {
          kind: 'source-map', mime: 'x-sourcemap', route, method: 'sourcemap-ref',
          parentUrl: minUrl, detail: `original source ${srcName} (compiled: ${shortLabel(minUrl)})`,
        });
        n++;
      } else {
        if (index.add(srcName, { resourceUrl: smUrl, resourceKind: 'source-map', route, method: 'sourcemap-ref', parentUrl: minUrl, detail: `original path (compiled: ${shortLabel(minUrl)})` }) !== null) n++;
      }
    }
    diag(`source map: ${n} original sources indexed from ${shortLabel(smUrl)}`);
  } catch (e) { diag(`source map fetch failed: ${String(e).slice(0, 120)}`, smUrl); }
}

// ---------- capture wiring ----------
function connectBackground(): void {
  try {
    const port = chrome.runtime.connect({ name: 'deepscope-panel' });
    port.postMessage({ type: 'hello', tabId });
    port.onMessage.addListener((msg: { type: string; url?: string; kind?: string; route?: string; [k: string]: unknown }) => {
      if (msg.type === 'nav' && msg.url) {
        try {
          const u = new URL(String(msg.url));
          if (!sessionOrigin) { sessionOrigin = u.origin; $('scopeLabel').textContent = `scope: ${sessionOrigin}`; }
          sessionRoute = u.pathname + u.search;
          touchRoute(sessionRoute, msg.kind === 'spa' ? 'history-api' : 'unknown');
          scheduleRender();
        } catch { /* ignore */ }
      } else if (msg.type === 'req-meta' && msg.url) {
        reqMetaByUrl.set(String(msg.url), { method: String(msg.method ?? 'GET'), initiator: (msg.initiator as string) ?? undefined });
        if (reqMetaByUrl.size > 2000) reqMetaByUrl.clear();
      } else if (msg.type === 'content-batch') {
        void handleContentBatch(msg as unknown as ContentBatch);
      } else if (msg.type === 'diag') {
        diag(String(msg.note ?? 'background notice'), msg.url);
      }
    });
  } catch { diag('background relay unavailable; devtools.network capture still works'); }
}

interface ContentBatch {
  type: string; url: string; route: string; htmlLen: number;
  links: string[]; scripts: string[]; forms: string[]; iframes: Array<{ src: string }>;
  routes: string[]; manifest?: string | null; manifests?: string[]; chunks: string[]; apis: string[]; textSample: string;
}

async function handleContentBatch(b: ContentBatch): Promise<void> {
  if (paused) return;
  if (!sessionOrigin) { try { sessionOrigin = new URL(b.url).origin; $('scopeLabel').textContent = `scope: ${sessionOrigin}`; } catch { /* ignore */ } }
  sessionRoute = b.route || sessionRoute;
  touchRoute(sessionRoute, 'dom-link');
  graph.addNode(graph.routeNode(sessionRoute), sessionRoute, 'route', sessionRoute);
  for (const r of b.routes.slice(0, 200)) touchRoute(r, 'router');
  // Index visible text sample as DOM units
  if (b.textSample && settings.capture.dom) {
    const prov = { resourceUrl: b.url, resourceKind: 'dom' as ResourceKind, route: sessionRoute, method: 'dom-link' as DiscoveryMethod };
    for (const chunk of b.textSample.match(/.{1,160}/g) ?? []) index.add(chunk.trim(), prov);
  }
  for (const s of b.scripts.slice(0, 60)) {
    graph.addNode(s, shortLabel(s), 'resource', s);
    graph.link(b.url, s, 'dom-script');
  }
  for (const f of b.iframes.slice(0, 20)) {
    graph.addNode(f.src, shortLabel(f.src), 'frame', f.src);
    graph.link(b.url, f.src, 'iframe');
  }
  if (b.manifest) {
    const mUrl = resolveUrl(b.url, b.manifest);
    graph.addNode(mUrl, shortLabel(mUrl), 'resource', mUrl);
    graph.link(b.url, mUrl, 'manifest-ref');
    if (settings.capture.dom) void fetchViaPage(mUrl, sessionRoute, 'manifest-ref');
  }
  // Next.js build/ssg manifests spotted by the content script (absolute URLs).
  for (const m of (b.manifests ?? []).slice(0, 8)) {
    let mUrl = '';
    try { mUrl = new URL(m, b.url).toString(); } catch { continue; }
    try { if (new URL(mUrl).origin !== new URL(b.url).origin) continue; } catch { continue; }
    graph.addNode(mUrl, shortLabel(mUrl), 'resource', mUrl);
    graph.link(b.url, mUrl, 'manifest-ref');
    if (settings.capture.dom) void fetchViaPage(mUrl, sessionRoute, 'manifest-ref');
  }
  ledger.records = index.size; ledger.indexedChars = index.indexedChars; ledger.indexBytes = Math.round(index.indexBytes);
  scheduleRender();
}

async function fetchViaPage(url: string, route: string, method: DiscoveryMethod): Promise<void> {
  if (!sameOriginOk(url)) { diag('cross-origin fetch skipped (grant site access to include)', url); return; }
  try {
    const text = await evalInPage<string>(`(async()=>{try{const r=await fetch(${JSON.stringify(url)},{credentials:'same-origin'});if(!r.ok)return '__ERR__:HTTP '+r.status;const t=await r.text();return t.slice(0,2500000);}catch(e){return '__ERR__:'+String(e).slice(0,160)}})()`);
    if (!text || text.startsWith('__ERR__')) { diag(`fetch failed: ${text?.slice(0, 100) ?? 'unknown'}`, url); return; }
    await ingestText(url, text, { route, method });
  } catch (e) { diag(`fetch failed: ${String(e).slice(0, 120)}`, url); }
}

function sameOriginOk(url: string): boolean {
  try {
    if (!sessionOrigin) return true;
    const u = new URL(url, sessionOrigin);
    if (u.origin === sessionOrigin) return true;
    if (settings.deepScan.includeSubdomains && u.hostname.endsWith(new URL(sessionOrigin).hostname.replace(/^www\./, ''))) return true;
    return settings.deepScan.includeThirdParty;
  } catch { return false; }
}

function hookDevtoolsNetwork(): void {
  try {
    chrome.devtools.network.onRequestFinished.addListener((req) => {
      if (paused) return;
      const url: string = req.request.url;
      if (url.startsWith('chrome-extension://') || url.startsWith('devtools://') || url.startsWith('data:')) return;
      const mime: string = req.response.content?.mimeType ?? '';
      const status: number = req.response.status;
      const initiator = reqMetaByUrl.get(url)?.initiator;
      const entry: NetEntry = {
        id: `${Date.now()}-${netEntries.length}`, url, method: req.request.method, status, mime,
        route: sessionRoute, initiator, reqHeaders: headersToObj(req.request.headers),
        resHeaders: headersToObj(req.response.headers), bodyKept: false, bodyTruncated: false,
        bodyChars: req.response.content?.size ?? 0, ts: Date.now(),
      };
      // Binary/media/fonts: metadata only
      if (/\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|woff2?|ttf|otf)(\?|$)/i.test(url) || /^(image|video|audio|font)\//.test(mime)) {
        if (settings.includeBinaryMeta) {
          upsertResource(url, { url, kind: kindFor(url, mime), route: sessionRoute, method: 'devtools-network', initiator, status, mime, size: req.response.content?.size, indexed: false, hasSourceMap: false, indexedStrings: 0, ts: Date.now() });
          netEntries.unshift(entry);
          ledger.requests++;
          scheduleRender();
        }
        return;
      }
      req.getContent((content, encoding) => {
        if (paused) return;
        if (content == null) { diag('empty body (browser did not expose content)', url); netEntries.unshift(entry); scheduleRender(); return; }
        let text = content;
        if (encoding === 'base64') {
          try { text = atob(content).slice(0, settings.maxResponseBytes); } catch { diag('base64 body undecodable; kept metadata only', url); netEntries.unshift(entry); scheduleRender(); return; }
        }
        entry.bodyKept = settings.retainRaw;
        entry.bodyChars = text.length;
        netEntries.unshift(entry);
        if (netEntries.length > 800) netEntries.pop();
        ledger.requests++;
        // Index the URL itself + headers so URL/header scopes actually match.
        indexUrlAndHeaders(url, entry);
        void ingestText(url, text, { mime, route: sessionRoute, method: 'devtools-network', initiator, status });
      });
    });
    chrome.devtools.network.getHAR((har) => {
      try {
        for (const e of (har.entries ?? []).slice(-120)) {
          const url = e.request.url;
          if (/^(chrome-extension|devtools|data):/.test(url)) continue;
          netEntries.unshift({ id: `har-${netEntries.length}`, url, method: e.request.method, status: e.response.status, mime: e.response.content?.mimeType, route: sessionRoute, bodyKept: false, bodyTruncated: false, bodyChars: e.response.content?.size ?? 0, ts: Date.now(), note: 'from HAR snapshot' });
        }
        scheduleRender();
      } catch { /* ignore */ }
    });
  } catch { diag('devtools.network unavailable in this context'); }
}

function headersToObj(h: Array<{ name: string; value: string }>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const { name, value } of h.slice(0, 60)) o[name] = value;
  return o;
}

/** Index URL + request/response headers as compact searchable units (bounded). */
function indexUrlAndHeaders(url: string, entry: NetEntry): void {
  if (!settings.capture.headers && !settings.capture.json) return;
  const base = { resourceUrl: url, route: entry.route, method: 'devtools-network' as DiscoveryMethod, initiator: entry.initiator };
  // The URL itself is searchable (scope: urls/routes).
  index.add(url, { ...base, resourceKind: 'url' });
  if (!settings.capture.headers) { ledger.records = index.size; return; }
  let n = 0;
  const pushH = (name: string, value: string, res: boolean): void => {
    if (n >= 40 || !value || value.length > 320) return;
    n++;
    index.add(`${name}: ${value}`.slice(0, 320), { ...base, resourceKind: 'header', detail: res ? 'response-header' : 'request-header' });
    // Header VALUES that look like paths/URLs are also worth finding.
    if (value.includes('/') && value.length <= 220) {
      const v = value.trim();
      if (v.startsWith('/') || /^https?:\/\//i.test(v)) index.add(v.slice(0, 220), { ...base, resourceKind: 'header', detail: 'header-value-url' });
    }
  };
  for (const [k, v] of Object.entries(entry.reqHeaders ?? {})) pushH(k, v, false);
  for (const [k, v] of Object.entries(entry.resHeaders ?? {})) pushH(k, v, true);
  ledger.records = index.size;
  ledger.indexedChars = index.indexedChars;
  ledger.indexBytes = Math.round(index.indexBytes);
}

// ---------- deep scan ----------
let scanning = false;
let scanVisited = new Set<string>();
let scanQueue: Array<{ route: string; depth: number }> = [];
let scanFetched = 0;

async function startDeepScan(): Promise<void> {
  if (scanning) return;
  if (!sessionOrigin) {
    try {
      const href = await evalInPage<string>('location.href');
      sessionOrigin = new URL(href).origin;
      $('scopeLabel').textContent = `scope: ${sessionOrigin}`;
    } catch { diag('deep scan: cannot determine page origin'); return; }
  }
  scanning = true;
  scanVisited = new Set();
  scanQueue = [];
  scanFetched = 0;
  const seeds = new Set<string>([sessionRoute, ...[...routes.keys()].slice(0, 30)]);
  try {
    const extra = await evalInPage<string[]>('window.__deepscope_crawl?window.__deepscope_crawl():[]');
    for (const r of (extra ?? []).slice(0, 100)) seeds.add(r);
  } catch { /* content helper absent; link parsing still works */ }
  for (const r of seeds) scanQueue.push({ route: r, depth: 0 });
  for (const r of seeds) touchRoute(r, 'router'); // Routes tab fills immediately
  scheduleRender();
  $('btnDeep').textContent = 'Stop Scan';
  ($('btnDeep2') as HTMLButtonElement).disabled = true;
  diag(`deep scan started: origin ${sessionOrigin}, depth≤${settings.deepScan.maxDepth}, pages≤${settings.deepScan.maxPages}`);
  void pumpScan();
  updateDeepStatus();
}

function stopDeepScan(reason = 'user'): void {
  scanning = false;
  scanQueue = [];
  $('btnDeep').textContent = 'Deep Scan';
  ($('btnDeep2') as HTMLButtonElement).disabled = false;
  updateDeepStatus(`stopped (${reason})`);
}

async function pumpScan(): Promise<void> {
  const ds = settings.deepScan;
  while (scanning && scanQueue.length && scanVisited.size < ds.maxPages) {
    const job = scanQueue.shift()!;
    if (scanVisited.has(job.route) || job.depth > ds.maxDepth) continue;
    scanVisited.add(job.route);
    updateDeepStatus();
    try {
      // eslint-disable-next-line no-await-in-loop
      const html = await evalInPage<string>(`(async()=>{try{const r=await fetch(${JSON.stringify(job.route)},{credentials:'same-origin',headers:{'x-deepscope':'1'}});if(!r.ok)return '__ERR__:HTTP '+r.status;const t=await r.text();return t.slice(0,1500000);}catch(e){return '__ERR__:'+String(e).slice(0,160)}})()`);
      if (!html || html.startsWith('__ERR__')) { diag(`deep scan page failed: ${html?.slice(0, 100)}`, sessionOrigin + job.route); continue; }
      scanFetched++;
      // eslint-disable-next-line no-await-in-loop
      await ingestText(sessionOrigin + job.route, html, { kind: 'document', mime: 'text/html', route: job.route, method: 'deep-scan' });
      const found = extractHtml(html, sessionOrigin + job.route);
      touchRoute(job.route, 'deep-scan');
      let perPage = 0;
      const consider = (u: string): void => {
        if (perPage >= ds.maxRequestsPerPage || scanQueue.length + scanVisited.size >= ds.maxPages) return;
        try {
          const abs = new URL(u, sessionOrigin);
          if (ds.sameOriginOnly && abs.origin !== sessionOrigin && !ds.includeSubdomains && !ds.includeThirdParty) return;
          if (!sameOriginOk(abs.toString())) return;
          if (abs.origin === sessionOrigin && ds.followRoutes && (job.depth < ds.maxDepth)) {
            const rt = abs.pathname + abs.search;
            if (!scanVisited.has(rt)) { scanQueue.push({ route: rt, depth: job.depth + 1 }); perPage++; }
          } else if (ds.followImports && /\.(m?js|css)($|\?)/.test(abs.pathname)) {
            perPage++;
            void fetchViaPage(abs.toString(), job.route, 'deep-scan');
          } else if (ds.captureApis && abs.pathname.includes('/api/')) {
            perPage++;
            void fetchViaPage(abs.toString(), job.route, 'deep-scan');
          }
        } catch { /* ignore */ }
      };
      for (const l of [...found.links, ...found.scripts].slice(0, 120)) consider(l);
      if (ds.scanIframes) for (const f of found.iframes.slice(0, 10)) consider(f);
      if (perPage === 0 && found.routes.length && ds.followRoutes && job.depth < ds.maxDepth) {
        for (const r of found.routes.slice(0, 12)) if (!scanVisited.has(r)) scanQueue.push({ route: r, depth: job.depth + 1 });
      }
      // Drain JS-discovered candidates (two-pass bundle scan): routes,
      // endpoints (/api/…), chunks and assets found inside fetched bundles.
      // This is what makes Deep Scan follow what chunks/assets reveal.
      if (discoveredUrls.length) {
        const batch = discoveredUrls.splice(0, 200);
        for (const d of batch) {
          if (perPage >= ds.maxRequestsPerPage || scanQueue.length + scanVisited.size >= ds.maxPages) break;
          try {
            const abs = new URL(d.url);
            if (ds.sameOriginOnly && abs.origin !== sessionOrigin && !ds.includeSubdomains && !ds.includeThirdParty) continue;
            if (!sameOriginOk(d.url)) continue;
            const isApi = abs.pathname.includes('/api/') || d.kind === 'endpoint' || d.kind === 'fetch-target';
            const isJsCss = /\.(m?js|css)($|\?)/.test(abs.pathname);
            if (abs.origin === sessionOrigin && (d.kind === 'route' || d.kind === 'endpoint' || d.kind === 'dom-link') && ds.followRoutes && job.depth < ds.maxDepth) {
              const rt = abs.pathname + abs.search;
              if (!scanVisited.has(rt) && rt !== job.route) { scanQueue.push({ route: rt, depth: job.depth + 1 }); perPage++; }
            } else if (isJsCss && ds.followImports) {
              perPage++;
              void fetchViaPage(d.url, job.route, 'deep-scan');
            } else if (isApi && ds.captureApis) {
              perPage++;
              void fetchViaPage(d.url, job.route, 'deep-scan');
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      diag(`deep scan error: ${String(e).slice(0, 120)}`, sessionOrigin + job.route);
    }
    // yield to UI
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 60));
  }
  if (scanning) stopDeepScan('limits reached');
}

function updateDeepStatus(extra = ''): void {
  $('deepStatus').textContent = scanning
    ? `scanning… visited ${scanVisited.size}/${settings.deepScan.maxPages} pages, fetched ${scanFetched}, queued ${scanQueue.length} ${extra}`
    : `idle — visited ${scanVisited.size} pages, fetched ${scanFetched} ${extra}`;
}

// ---------- search UI ----------
function buildScopeRow(): void {
  const defs: Array<[keyof SearchScope, string]> = [
    ['dom', 'DOM'], ['js', 'JS'], ['chunks', 'chunks'], ['css', 'CSS'], ['json', 'JSON'],
    ['sourcemaps', 'maps'], ['routes', 'routes'], ['urls', 'URLs'], ['reqHeaders', 'reqHd'],
    ['reqBody', 'reqBd'], ['resHeaders', 'resHd'], ['resBody', 'resBd'], ['frames', 'frames'], ['meta', 'meta'],
  ];
  $('scopeRow').innerHTML = defs.map(([k, l]) => `<label><input type="checkbox" data-scope="${k}" ${scope[k] ? 'checked' : ''}/> ${l}</label>`).join('');
  $('scopeRow').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    scope[(el as HTMLInputElement).dataset.scope as keyof SearchScope] = (el as HTMLInputElement).checked;
    runSearch();
  }));
}

let lastResults: SearchResult[] = [];
const lastResultsById = new Map<number, SearchResult>();

function runSearch(): void {
  const q = ($('q') as HTMLInputElement).value;
  const mode = ($('mode') as HTMLSelectElement).value as SearchMode;
  const t0 = performance.now();
  const res = searchIndex(index, q, { mode, scope, limit: 200 });
  const dt = performance.now() - t0;
  lastResults = res;
  lastResultsById.clear();
  for (const r of res) lastResultsById.set(r.recordId, r);
  $('resultMeta').textContent = q ? `${res.length} results in ${dt.toFixed(1)} ms · ${mode} · indexed ${index.size} strings` : `indexed ${index.size} strings — type to search`;
  const box = $('results');
  box.innerHTML = res.map((r) => {
    const p = r.prov;
    const loc = p.line && p.line > 0 ? `L${p.line}${p.column ? ':' + p.column : ''}` : '';
    const jp = p.jsonPath ? `<span class="badge" title="JSON path">${esc(p.jsonPath)}</span>` : '';
    const kindBadge = `<span class="badge kind">${esc(p.detail && p.detail !== p.resourceKind ? `${p.resourceKind}/${p.detail}` : p.resourceKind)}</span>`;
    const name = esc(displayNameFor(r.text, 120));
    const from = esc(sourceLabel(p.resourceUrl));
    const hl = renderHighlighted(r.context, r.marks ?? [[r.matchStart, r.matchStart + Math.max(1, r.matchLen)]]);
    const sub = `${kindBadge} <span title="${esc(p.resourceUrl)}">${from}</span> · route ${esc(p.route)} · via ${esc(p.method)}${loc ? ` · ${loc}` : ''}${p.initiator ? ` · init ${esc(shortLabel(p.initiator))}` : ''}`;
    return `<div class="res" data-rid="${r.recordId}">`
      + `<div class="head"><span class="score">${r.score.toFixed(3)}</span><span class="orig" title="${esc(r.text.slice(0, 400))}">${name}</span>`
      + `<button class="open" data-open="${r.recordId}" title="Open source: ${esc(p.resourceUrl)}${loc ? ' @ ' + loc : ''}">Open ↗</button></div>`
      + `<div class="ctx-line">${hl}</div>`
      + `<div class="prov">${sub} ${jp}</div></div>`;
  }).join('');
}

/** Render escaped context with ALL fuzzy spans wrapped in <mark>. */
function renderHighlighted(context: string, marks: Array<[number, number]>): string {
  const sorted = [...marks].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]).slice(0, 8);
  if (!sorted.length) return `<span class="ctx">${esc(context)}</span>`;
  let html = '';
  let cur = 0;
  for (const [s, e] of sorted) {
    const a = Math.max(0, Math.min(context.length, s));
    const b = Math.max(a + 1, Math.min(context.length, e));
    if (a > cur) html += esc(context.slice(cur, a));
    html += `<mark>${esc(context.slice(a, b)) || '…'}</mark>`;
    cur = b;
  }
  if (cur < context.length) html += esc(context.slice(cur));
  return `<span class="ctx">${html}</span>`;
}

/** "where it came from": host + short path (keeps query string when short). */
function sourceLabel(u: string): string {
  try {
    const x = new URL(u);
    const hash = x.hash && x.hash.length < 40 ? x.hash : '';
    const p = (x.pathname + x.search + hash) || '/';
    const short = p.length > 70 ? `…${p.slice(-69)}` : p;
    return `${x.host}${short}`;
  } catch {
    return u.length > 90 ? `…${u.slice(-89)}` : u;
  }
}

/**
 * Click-to-open: jump to the exact source of a hit.
 * 1) chrome.devtools.panels.openResource (Sources panel, line-accurate,
 *    works for round-tripped http(s) URLs incl. source-mapped origins),
 * 2) fallback: open the resource URL in a new tab.
 */
async function openSource(recordId: number): Promise<void> {
  const r = lastResultsById.get(recordId);
  if (!r) return;
  const raw = r.prov.resourceUrl;
  const base = raw.split('#')[0]; // sourcemap `#original.ts` -> compiled URL for openResource
  const line = r.prov.line && r.prov.line > 0 ? r.prov.line : 0;
  try {
    const panels = (chrome.devtools as unknown as { panels?: { openResource?: (url: string, line: number, cb?: () => void) => void } })?.panels;
    if (panels?.openResource) {
      panels.openResource(base, Math.max(0, line - 1), () => {
        if (chrome.runtime.lastError) window.open(base, '_blank');
      });
      return;
    }
  } catch { /* fall through */ }
  try {
    window.open(base, '_blank');
  } catch {
    diag(`cannot open source (popup blocked?)`, base);
  }
}

// ---------- renders ----------
function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = window.setTimeout(() => { renderTimer = 0; renderAll(); }, 400);
}

function renderAll(): void {
  renderMem(); renderOverview(); renderRoutes(); renderResources(); renderNetwork(); renderAnalyze(); renderGraph();
}

function renderMem(): void {
  $('memText').textContent = `${formatBytes(ledger.usedBytes)} / ${settings.budgetMB} MB`;
  $('memDetail').textContent = `idx ${formatBytes(ledger.indexBytes)} · raw ${formatBytes(ledger.rawBytes)} · ${ledger.resources} res · ${ledger.routes} routes · ${ledger.requests} req`;
  const f = $('memFill');
  f.style.width = `${Math.min(100, ledger.pct)}%`;
  f.style.background = ledger.pct >= 95 ? 'var(--bad)' : ledger.pct >= 80 ? 'var(--warn)' : 'var(--ok)';
  $('cRoutes').textContent = String(routes.size);
  $('cRes').textContent = String(resources.size);
  $('cNet').textContent = String(netEntries.length);
}

function renderOverview(): void {
  const chunks = [...resources.values()].filter((r) => r.kind === 'chunk').length;
  const apis = [...resources.values()].filter((r) => r.kind === 'api-json').length;
  const maps = [...resources.values()].filter((r) => r.hasSourceMap).length;
  const stats: Array<[string, string]> = [
    [String(routes.size), 'routes'], [String(resources.size), 'resources'],
    [String(chunks), 'chunks'], [String(apis), 'APIs'], [String(netEntries.length), 'requests'],
    [String(maps), 'source maps'], [String(index.size), 'strings'], [formatBytes(ledger.usedBytes), 'RAM'],
  ];
  $('statGrid').innerHTML = stats.map(([b, l]) => `<div class="stat"><b>${esc(b)}</b><span>${l}</span></div>`).join('');
  $('sessionInfo').innerHTML = `origin <b>${esc(sessionOrigin || '—')}</b><br/>route ${esc(sessionRoute)}<br/>mode ${scanning ? '<b>DEEP SCAN</b>' : 'passive'}${paused ? ' · <b>PAUSED</b>' : ''}<br/>raw bodies ${settings.retainRaw ? `kept (${rawBodies.size})` : 'dropped after indexing'}`;
}

function renderDiags(): void {
  $('diagList').innerHTML = diags.slice(0, 40).map((d) => `<div><span class="muted">${new Date(d.ts).toLocaleTimeString()}</span> ${esc(d.note)}${d.url ? `<br/><span class="muted">${esc(shortLabel(d.url))}</span>` : ''}</div>`).join('') || '<span class="muted">no issues</span>';
}

/** Full URL for a route key: sessionOrigin + route for '/…' routes,
 *  hash-routes as-is, absolute URLs untouched, relative fallback when origin
 *  is still unknown. */
function routeFullUrl(r: string): string {
  if (/^https?:\/\//i.test(r) || r.startsWith('#')) return r;
  if (!sessionOrigin) return r;
  if (r.startsWith('/')) return sessionOrigin + r;
  return `${sessionOrigin}/${r.replace(/^\/*/, '')}`;
}

function routeDisplay(r: string): string {
  const full = routeFullUrl(r);
  return full.length > 110 ? `…${full.slice(-109)}` : full;
}

function filteredRoutes(): Array<[string, { method: DiscoveryMethod; count: number }]> {
  const f = ((document.getElementById('routeFilter') as HTMLInputElement | null)?.value ?? '').toLowerCase();
  const out: Array<[string, { method: DiscoveryMethod; count: number }]> = [];
  for (const [r, v] of routes) {
    if (f && !r.toLowerCase().includes(f)) continue;
    out.push([r, v]);
    if (out.length >= 1200) break;
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

function renderRoutes(): void {
  // Hierarchical indent by path segments; each row links the full URL and
  // reuses tableClick('route') for Open/Copy delegation.
  const all = filteredRoutes();
  const rows = all.slice(0, 300);
  $('routeTree').innerHTML = rows.map(([r, v]) => {
    const depth = r.split('/').filter(Boolean).length;
    const full = routeFullUrl(r);
    const indent = '&nbsp;'.repeat(Math.min(depth, 8) * 3);
    return `<div>${indent}├ <a href="#" data-act="open" data-url="${esc(full)}" title="${esc(full)}">${esc(routeDisplay(r))}</a> `
      + `<span class="muted">×${v.count}</span> <span class="badge kind">${esc(v.method)}</span> `
      + `<button data-act="open" data-url="${esc(full)}" title="Open ${esc(full)}">Open</button>`
      + `<button data-act="copy" data-url="${esc(full)}" title="Copy URL">Copy</button></div>`;
  }).join('') || '<span class="muted">no routes yet — browse the page or run Deep Scan</span>';
  const rc = document.getElementById('routeCount');
  if (rc) rc.textContent = `${all.length} shown${routes.size > all.length ? ` of ${routes.size}` : ''}`;
}

async function copyFilteredRouteUrls(): Promise<void> {
  const urls = filteredRoutes().slice(0, 1000).map(([r]) => routeFullUrl(r));
  if (!urls.length) { diag('nothing to copy — route filter matches zero routes'); return; }
  await copyText(urls.join('\n'), `${urls.length} route URLs`);
}

function filteredResources(): ResourceMeta[] {
  const input = ($('resFilter') as HTMLInputElement).value ?? '';
  const f = input.toLowerCase();
  const out: ResourceMeta[] = [];
  // Single pass over live values — no intermediate arrays until the cap.
  for (const r of resources.values()) {
    if (resType !== 'ALL' && r.kind !== resType) continue;
    if (f && !r.url.toLowerCase().includes(f) && !r.kind.includes(f)) continue;
    out.push(r);
    if (out.length >= 1200) break;
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function syncResTypeOptions(): void {
  const kinds: string[] = [];
  for (const r of resources.values()) kinds.push(r.kind);
  const rows = resourceKindCounts(kinds);
  const { html, sig } = optionsHtml(rows, resType, 'all types');
  if (sig === resTypeSig) return; // unchanged — skip DOM churn
  if (resType !== 'ALL' && !rows.some((r) => r.value === resType)) resType = 'ALL';
  resTypeSig = sig;
  ($('resType') as HTMLSelectElement).innerHTML = optionsHtml(rows, resType, 'all types').html;
}

function renderResources(): void {
  syncResTypeOptions();
  const all = filteredResources();
  const rows = all.slice(0, 300);
  ($('resTable').querySelector('tbody')!).innerHTML = rows.map((r) =>
    `<tr><td class="url"><a href="#" data-act="open" data-url="${esc(r.url)}" title="${esc(r.url)}">${esc(shortLabel(r.url))}</a></td>`
    + `<td>${r.kind}</td><td>${r.status ?? '—'}</td><td>${r.size != null ? formatBytes(r.size) : '—'}</td>`
    + `<td>${esc(r.route)}</td><td>${esc(r.method)}</td><td>${r.hasSourceMap ? 'yes' : '—'}</td>`
    + `<td>${r.indexed ? r.indexedStrings : '—'}${r.error ? `<br/><span class="muted">${esc(r.error)}</span>` : ''}</td>`
    + `<td class="acts"><button data-act="open" data-url="${esc(r.url)}" title="Open ${esc(shortLabel(r.url))}">Open</button>`
    + `<button data-act="copy" data-url="${esc(r.url)}" title="Copy URL">Copy</button>`
    + `<button data-act="view" data-url="${esc(r.url)}" title="Preview captured content">View</button></td></tr>`).join('')
    || '<tr><td colspan="9" class="muted">no resources match — browse the page, or clear the filters</td></tr>';
  $('resCount').textContent = `${all.length} shown${resources.size > all.length ? ` of ${resources.size}` : ''} · ${resType === 'ALL' ? 'all types' : resType}`;
}

function syncNetOptions(): void {
  const methods: string[] = [];
  for (const n of netEntries) methods.push(n.method);
  const mRows = netMethodCounts(methods);
  const m = optionsHtml(mRows, netMethod, 'all methods');
  if (m.sig !== netMethodSig) {
    if (netMethod !== 'ALL' && !mRows.some((r) => r.value === netMethod)) netMethod = 'ALL';
    netMethodSig = m.sig;
    ($('netMethod') as HTMLSelectElement).innerHTML = optionsHtml(mRows, netMethod, 'all methods').html;
  }
  const gRows = netGroupCounts(netEntries);
  const g = optionsHtml(gRows, netKind, 'all types');
  if (g.sig !== netKindSig) {
    if (netKind !== 'ALL' && !gRows.some((r) => r.value === netKind)) netKind = 'ALL';
    netKindSig = g.sig;
    ($('netKind') as HTMLSelectElement).innerHTML = optionsHtml(gRows, netKind, 'all types').html;
  }
}

function filteredNetEntries(): NetEntry[] {
  const input = (($('netFilter') as HTMLInputElement)?.value) ?? '';
  const f = input.toLowerCase();
  const out: NetEntry[] = [];
  for (const n of netEntries) {
    if (netMethod !== 'ALL' && n.method !== netMethod) continue;
    if (netKind !== 'ALL' && groupMime(n.mime, n.url) !== netKind) continue;
    if (f && !n.url.toLowerCase().includes(f) && !(n.mime ?? '').toLowerCase().includes(f)) continue;
    out.push(n);
    if (out.length >= 1200) break;
  }
  return out; // already newest-first
}

function renderNetwork(): void {
  syncNetOptions();
  const all = filteredNetEntries();
  const rows = all.slice(0, 250);
  ($('netTable').querySelector('tbody')!).innerHTML = rows.map((n) =>
    `<tr><td>${esc(n.method)}</td><td class="url"><a href="#" data-act="open" data-url="${esc(n.url)}" title="${esc(n.url)}">${esc(shortLabel(n.url))}</a></td>`
    + `<td>${n.status ?? '—'}</td><td>${esc(n.mime ?? '')}</td><td>${esc(n.route)}</td>`
    + `<td>${n.bodyKept ? formatBytes(n.bodyChars) : n.bodyChars ? `${formatBytes(n.bodyChars)} (indexed)` : 'meta'}</td>`
    + `<td class="muted">${esc(n.note ?? '')}</td>`
    + `<td class="acts"><button data-act="open" data-url="${esc(n.url)}" title="Open ${esc(shortLabel(n.url))}">Open</button>`
    + `<button data-act="copy" data-url="${esc(n.url)}" title="Copy URL">Copy</button>`
    + `<button data-act="view" data-url="${esc(n.url)}" title="Preview captured content">View</button>`
    + `<button data-act="curl" data-url="${esc(n.url)}" title="Copy as cURL">cURL</button></td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">no requests match — browse the page, or clear the filters</td></tr>';
  $('netCount').textContent = `${all.length} shown${netEntries.length > all.length ? ` of ${netEntries.length}` : ''}`;
}

// ---------- shared URL actions (open / copy / view) ----------
async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    diag(`${label} copied (${formatBytes(text.length)})`);
  } catch {
    // Fallback for clipboard denial: show a selectable prompt via diagnostics.
    diag(`${label} copy blocked by clipboard permission — select manually`, text.slice(0, 200));
  }
}

/** Open any captured URL: Sources-panel jump when possible, else a new tab. */
function openUrl(url: string): void {
  try {
    const panels = (chrome.devtools as unknown as { panels?: { openResource?: (u: string, line: number, cb?: () => void) => void } })?.panels;
    if (panels?.openResource && /^https?:/.test(url)) {
      panels.openResource(url.split('#')[0], 0, () => {
        if (chrome.runtime.lastError) window.open(url, '_blank');
      });
      return;
    }
  } catch { /* fall through */ }
  window.open(url, '_blank');
}

/** Resolve previewable content for a URL: retained raw body, else on-demand same-origin fetch. */
async function resolveContent(url: string): Promise<{ text: string; meta: string; truncated: boolean }> {
  const kept = rawBodies.get(url);
  if (kept != null) {
    const cap = 20_000;
    return {
      text: kept.length > cap ? kept.slice(0, cap) : kept,
      meta: `retained raw body · ${formatBytes(kept.length)}${kept.length > cap ? ` · showing first ${formatBytes(cap)}` : ''}`,
      truncated: kept.length > cap,
    };
  }
  const meta0 = resources.get(url);
  if (meta0 && (meta0.kind === 'media-meta' || meta0.kind === 'font-meta')) {
    return { text: '(binary/media/font — metadata only, never copied into the index)', meta: `${meta0.kind} · ${meta0.mime ?? ''}`, truncated: false };
  }
  if (!sameOriginOk(url)) {
    return { text: '(cross-origin — grant site access, then recapture to preview content)', meta: 'no body retained', truncated: false };
  }
  try {
    const text = await evalInPage<string>(`(async()=>{try{const r=await fetch(${JSON.stringify(url)},{credentials:'same-origin'});if(!r.ok)return '__ERR__:HTTP '+r.status;const t=await r.text();return t.slice(0,20000);}catch(e){return '__ERR__:'+String(e).slice(0,160)}})()`);
    if (!text || text.startsWith('__ERR__')) return { text: `(unavailable: ${text?.slice(0, 120) ?? 'fetch failed'})`, meta: 'fetch failed', truncated: false };
    return { text, meta: `fetched on demand · showing up to 20 KB · ${text.length >= 20000 ? 'truncated' : `${formatBytes(text.length)}`}`, truncated: text.length >= 20000 };
  } catch (e) { return { text: `(preview failed: ${String(e).slice(0, 120)})`, meta: 'error', truncated: false }; }
}

async function viewUrl(url: string): Promise<void> {
  viewerUrl = url;
  $('viewerTitle').textContent = shortLabel(url);
  $('viewerMeta').textContent = 'loading…';
  ($('viewerBody') as HTMLElement).textContent = '';
  $('viewer').classList.remove('hidden');
  const { text, meta } = await resolveContent(url);
  if (viewerUrl !== url) return; // superseded by a newer View click
  $('viewerMeta').textContent = meta;
  ($('viewerBody') as HTMLElement).textContent = text;
}

function tableClick(e: Event, kind: 'res' | 'net' | 'route'): void {
  const t = (e.target as HTMLElement).closest?.('[data-act]') as HTMLElement | null;
  if (!t) return;
  e.preventDefault();
  const url = t.dataset.url ?? '';
  if (!url) return;
  const act = t.dataset.act;
  if (act === 'open') openUrl(url);
  else if (act === 'copy') void copyText(url, kind === 'res' ? 'resource URL' : kind === 'net' ? 'request URL' : 'route URL');
  else if (act === 'view') void viewUrl(url);
  else if (act === 'curl' && kind === 'net') {
    const n = netEntries.find((x) => x.url === url);
    if (!n) { diag('cURL: request no longer in buffer', url); return; }
    try { void copyText(buildCurl(n.method, n.url, n.reqHeaders ?? {}), 'cURL'); }
    catch (err) { diag(`cURL copy failed: ${String(err).slice(0, 120)}`, url); }
  }
}

async function copyFilteredResUrls(): Promise<void> {
  const urls = filteredResources().slice(0, 1000).map((r) => r.url);
  if (!urls.length) { diag('nothing to copy — filters match zero resources'); return; }
  await copyText(urls.join('\n'), `${urls.length} resource URLs`);
}

async function copyFilteredResAll(): Promise<void> {
  // Bounded: 30 items × 10 KB each so one click can't blow the clipboard/heap.
  const items = filteredResources().slice(0, 30);
  if (!items.length) { diag('nothing to copy — filters match zero resources'); return; }
  const parts: string[] = [];
  for (const r of items) {
    const { text } = await resolveContent(r.url);
    parts.push(`## ${r.url}\n[${r.kind}${r.status != null ? ` · ${r.status}` : ''}${r.mime ? ` · ${r.mime}` : ''} · route ${r.route} · via ${r.method}]\n${text.slice(0, 10_000)}`);
    if (parts.join('\n\n').length > 400_000) break;
  }
  await copyText(parts.join('\n\n'), `${items.length} resources with contents (bounded)`);
}

async function copyFilteredNetUrls(): Promise<void> {
  const urls = filteredNetEntries().slice(0, 1000).map((n) => `${n.method} ${n.url}`);
  if (!urls.length) { diag('nothing to copy — filters match zero requests'); return; }
  await copyText(urls.join('\n'), `${urls.length} request URLs`);
}

async function copyFilteredNetAll(): Promise<void> {
  const items = filteredNetEntries().slice(0, 30);
  if (!items.length) { diag('nothing to copy — filters match zero requests'); return; }
  const parts: string[] = [];
  for (const n of items) {
    const { text } = await resolveContent(n.url);
    parts.push(`## ${n.method} ${n.url}\n[${n.status ?? '—'} · ${n.mime ?? ''} · route ${n.route}]${n.note ? ` · ${n.note}` : ''}\n${text.slice(0, 10_000)}`);
    if (parts.join('\n\n').length > 400_000) break;
  }
  await copyText(parts.join('\n\n'), `${items.length} requests with contents (bounded)`);
}

// ---------- analyze (secret findings) ----------
const SEC_BLURB: Record<Severity, string> = {
  critical: 'critical — likely live credentials or private keys; rotate immediately if exposed',
  high: 'high — sensitive tokens or session secrets; verify and revoke if leaked',
  medium: 'medium — internal endpoints or keys worth reviewing',
  info: 'info — interesting but low-risk strings; review for context',
};

function renderAnalyze(): void {
  const pill = document.getElementById('cAnalyze');
  if (pill) pill.textContent = String(secFindings.length);
  const box = document.getElementById('secList');
  if (!box) return;
  const total = secFindings.length;
  renderedSec.length = 0;
  let html = '';
  for (const sev of ['critical', 'high', 'medium', 'info'] as Severity[]) {
    const items = secFindings.filter((f) => f.sev === sev);
    if (!items.length) continue;
    html += `<div><span class="badge sev-${sev}">${sev}</span> <span class="muted small">${esc(SEC_BLURB[sev])} (${items.length})</span></div>`;
    for (const f of items) {
      if (renderedSec.length >= 150) break;
      const i = renderedSec.length;
      renderedSec.push(f);
      const p = f.prov;
      const loc = p.line && p.line > 0 ? ` · L${p.line}${p.column ? ':' + p.column : ''}` : '';
      const rule = f.label && f.label !== f.rule ? `${f.rule} · ${f.label}` : f.rule;
      html += `<div class="res"><div class="head"><span class="badge sev-${f.sev}">${esc(f.sev)}</span>`
        + `<span class="badge" title="rule">${esc(rule)}</span>`
        + `<span class="orig" title="${esc(f.text.slice(0, 400))}">${esc(displayNameFor(f.text, 120))}</span>`
        + `<span class="open"><button data-act="open" data-i="${i}" title="Open source">Open</button> <button data-act="copy" data-i="${i}" title="Copy finding">Copy</button></span></div>`
        + `<div class="prov">${esc(sourceLabel(p.resourceUrl))} · route ${esc(p.route)} · via ${esc(p.method)}${loc}</div></div>`;
    }
    if (renderedSec.length >= 150) break;
  }
  if (!html) html = '<span class="muted">no secret findings — enable “scan for exposed secrets” in Settings, then browse or Deep Scan</span>';
  else if (total > renderedSec.length) html += `<div class="muted small">showing ${renderedSec.length} of ${total} findings (bounded render) — Copy findings exports up to 100</div>`;
  box.innerHTML = html;
  const sc = document.getElementById('secCount');
  if (sc) sc.textContent = `${total} findings${secDropped ? ` · ${secDropped} dropped at cap` : ''}`;
}

/** Delegated Open/Copy for Analyze rows (indexes into the last rendered slice). */
function secClick(e: Event): void {
  const t = (e.target as HTMLElement).closest?.('[data-act]') as HTMLElement | null;
  if (!t) return;
  e.preventDefault();
  const f = renderedSec[Number(t.dataset.i)];
  if (!f) return;
  if (t.dataset.act === 'open') openUrl(f.prov.resourceUrl);
  else if (t.dataset.act === 'copy') void copyText(f.text, 'secret finding');
}

async function copySecFindings(): Promise<void> {
  if (!secFindings.length) { diag('nothing to copy — no secret findings'); return; }
  const items = secFindings.slice(0, 100);
  const parts = items.map((f) => `[${f.sev}] ${f.rule}${f.label && f.label !== f.rule ? ` (${f.label})` : ''}\n${f.text}\n— ${f.prov.resourceUrl} · route ${f.prov.route} · via ${f.prov.method}`);
  await copyText(parts.join('\n\n'), `${items.length} secret findings`);
}

function renderGraph(): void {
  $('graphStats').textContent = `${graph.nodes.size} nodes · ${graph.edges.length} edges`;
  $('graphList').innerHTML = graph.summarize(250).map((s) => `<div>${esc(s)}</div>`).join('') || '<span class="muted">graph is empty — relationships appear as discovery proceeds</span>';
}

function shortLabel(u: string): string {
  try {
    const x = new URL(u);
    const p = x.pathname + x.search;
    const s = `${x.host}${p}`;
    return s.length > 90 ? `…${s.slice(-89)}` : s;
  } catch { return u.length > 90 ? `…${u.slice(-89)}` : u; }
}

// ---------- settings UI ----------
function buildSettings(): void {
  const budgets: Array<SessionSettings['budgetMB']> = [64, 128, 256, 512, 1024];
  $('budgetRow').innerHTML = budgets.map((b) => `<button data-b="${b}" class="${settings.budgetMB === b ? 'primary' : ''}">${b} MB</button>`).join('');
  $('budgetRow').querySelectorAll('button').forEach((el) => el.addEventListener('click', () => {
    settings.budgetMB = Number((el as HTMLElement).dataset.b) as SessionSettings['budgetMB'];
    buildSettings(); enforceBudget('budget-change');
  }));
  ($('setMaxResp') as HTMLInputElement).value = String(settings.maxResponseBytes);
  ($('setMaxIdx') as HTMLInputElement).value = String(settings.maxIndexedChars);
  ($('setMaxRes') as HTMLInputElement).value = String(settings.maxResources);
  ($('setRetainRaw') as HTMLInputElement).checked = settings.retainRaw;
  ($('setSrcMap') as HTMLInputElement).checked = settings.analyzeSourceMaps;
  ($('setAdvJs') as HTMLInputElement).checked = settings.advancedJsAnalysis;
  ($('setSecrets') as HTMLInputElement).checked = settings.analyzeSecrets;
  ($('setBinMeta') as HTMLInputElement).checked = settings.includeBinaryMeta;
  ($('setOnBudget') as HTMLSelectElement).value = settings.onBudget;
  ($('setDepth') as HTMLInputElement).value = String(settings.deepScan.maxDepth);
  ($('setPages') as HTMLInputElement).value = String(settings.deepScan.maxPages);
  ($('setPerPage') as HTMLInputElement).value = String(settings.deepScan.maxRequestsPerPage);
  const caps: Array<[keyof SessionSettings['capture'], string]> = [['dom', 'DOM/HTML'], ['js', 'JavaScript'], ['css', 'CSS'], ['json', 'JSON/API'], ['headers', 'headers'], ['frames', 'frames']];
  $('capRow').innerHTML = caps.map(([k, l]) => `<label><input type="checkbox" data-cap="${k}" ${settings.capture[k] ? 'checked' : ''}/> ${l}</label>`).join('');
  $('capRow').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    settings.capture[(el as HTMLInputElement).dataset.cap as keyof SessionSettings['capture']] = (el as HTMLInputElement).checked;
  }));
  const ds: Array<[string, string]> = [
    ['sameOriginOnly', 'same-origin only'], ['includeSubdomains', 'include subdomains'], ['includeThirdParty', 'third-party'],
    ['followRoutes', 'follow routes'], ['followImports', 'follow imports'], ['followSourceMaps', 'follow source maps'],
    ['scanIframes', 'scan iframes'], ['captureApis', 'capture APIs'], ['watchSpaTransitions', 'watch SPA'],
  ];
  $('deepRow').innerHTML = ds.map(([k, l]) => `<label><input type="checkbox" data-deep="${k}" ${(settings.deepScan as unknown as Record<string, boolean>)[k] ? 'checked' : ''}/> ${l}</label>`).join('');
  $('deepRow').querySelectorAll('input').forEach((el) => el.addEventListener('change', () => {
    (settings.deepScan as unknown as Record<string, boolean>)[(el as HTMLInputElement).dataset.deep ?? ''] = (el as HTMLInputElement).checked;
  }));
  for (const [id, fn] of [
    ['setMaxResp', (v: string) => settings.maxResponseBytes = Math.max(1024, Number(v) || 2000000)],
    ['setMaxIdx', (v: string) => settings.maxIndexedChars = Math.max(1024, Number(v) || 400000)],
    ['setMaxRes', (v: string) => settings.maxResources = Math.max(10, Number(v) || 3000)],
    ['setDepth', (v: string) => settings.deepScan.maxDepth = Math.min(5, Math.max(0, Number(v) || 0))],
    ['setPages', (v: string) => settings.deepScan.maxPages = Math.min(200, Math.max(1, Number(v) || 25))],
    ['setPerPage', (v: string) => settings.deepScan.maxRequestsPerPage = Math.min(200, Math.max(1, Number(v) || 60))],
  ] as Array<[string, (v: string) => void]>) {
    ($(id) as HTMLInputElement).addEventListener('change', (e) => fn((e.target as HTMLInputElement).value));
  }
  ($('setRetainRaw') as HTMLInputElement).addEventListener('change', (e) => settings.retainRaw = (e.target as HTMLInputElement).checked);
  ($('setSrcMap') as HTMLInputElement).addEventListener('change', (e) => settings.analyzeSourceMaps = (e.target as HTMLInputElement).checked);
  ($('setAdvJs') as HTMLInputElement).addEventListener('change', (e) => settings.advancedJsAnalysis = (e.target as HTMLInputElement).checked);
  ($('setSecrets') as HTMLInputElement).addEventListener('change', (e) => settings.analyzeSecrets = (e.target as HTMLInputElement).checked);
  ($('setBinMeta') as HTMLInputElement).addEventListener('change', (e) => settings.includeBinaryMeta = (e.target as HTMLInputElement).checked);
  ($('setOnBudget') as HTMLSelectElement).addEventListener('change', (e) => settings.onBudget = (e.target as HTMLSelectElement).value as SessionSettings['onBudget']);
  $('permInfo').innerHTML = `base: activeTab · scripting · webNavigation · webRequest · storage<br/>optional: <b>&lt;all_urls&gt;</b> (site access, on demand) · <b>debugger</b> (Deep Capture, on demand)<br/>processing: <b>100% local</b> · storage: <b>RAM only</b> (settings use chrome.storage.local; captures never touch disk)`;
}

// ---------- actions ----------
// ---------- routes ----------
// One-click route discovery: collects same-origin links from the live page
// (no navigation, no crawl) so the Routes tab is useful instantly.
async function discoverRoutesNow(): Promise<void> {
  const status = $('routeStatus');
  status.textContent = 'collecting links…';
  try {
    const found = await evalInPage<string[]>(`(()=>{const out=new Set();try{if(window.__deepscope_crawl)for(const r of window.__deepscope_crawl())out.add(r);}catch(e){}document.querySelectorAll('a[href]').forEach(a=>{const h=a.getAttribute('href');if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('data:'))return;try{const u=new URL(h,location.href);if(u.origin===location.origin)out.add(u.pathname+u.search);}catch(e){}});return [...out].slice(0,300);})()`);
    let n = 0;
    for (const r of found ?? []) { touchRoute(r, 'dom-link'); n++; }
    status.textContent = n
      ? `${n} same-origin routes discovered on this page — run Deep Scan to fetch them all`
      : 'no same-origin links found on this page (SPA with no <a> tags? try Deep Scan)';
    diag(`route discovery: ${n} routes collected from current page links`);
  } catch {
    status.textContent = 'route discovery failed — reload the inspected page and retry';
  }
  scheduleRender();
}

function applyTheme(): void {
  const light = settings.theme === 'light';
  document.body.dataset.theme = light ? 'light' : 'dark';
  $('btnTheme').textContent = light ? '◐ Dark' : '◐ Light';
}

function syncPause(): void {
  $('btnPause').textContent = paused ? 'Resume' : 'Pause';
  try { chrome.runtime.sendMessage({ type: 'set-paused', paused }); } catch { /* ignore */ }
  renderOverview();
}

function wire(): void {
  // Preview dismissal FIRST + null-safe: closing must work even if a stale
  // panel.html is missing newer controls (wiring must never half-attach).
  on('viewerClose', 'click', closeViewer);
  on('viewerX', 'click', closeViewer);
  on('viewer', 'click', (e) => { if ((e.target as HTMLElement).id === 'viewer') closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
  on('viewerCopy', 'click', () => void copyText((document.getElementById('viewerBody') as HTMLElement)?.textContent ?? '', 'preview content'));
  on('viewerOpen', 'click', () => { if (viewerUrl) openUrl(viewerUrl); });
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`tab-${(b as HTMLElement).dataset.tab}`).classList.add('active');
  }));
  ($('q') as HTMLInputElement).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(runSearch, 160); });
  $('btnSearch').addEventListener('click', runSearch);
  ($('mode') as HTMLSelectElement).addEventListener('change', runSearch);
  // Click-to-open: event delegation for result "Open ↗" buttons + row click.
  $('results').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest?.('[data-open]') as HTMLElement | null;
    if (t?.dataset.open) { void openSource(Number(t.dataset.open)); return; }
    const row = (e.target as HTMLElement).closest?.('.res') as HTMLElement | null;
    if (row?.dataset.rid) {
      const sel = window.getSelection()?.toString();
      if (!sel) void openSource(Number(row.dataset.rid)); // don't hijack text selection
    }
  });
  ($('resFilter') as HTMLInputElement).addEventListener('input', renderResources);
  ($('resType') as HTMLSelectElement).addEventListener('change', (e) => { resType = (e.target as HTMLSelectElement).value; renderResources(); });
  ($('resTable').querySelector('tbody')!).addEventListener('click', (e) => tableClick(e, 'res'));
  $('btnResCopyUrls').addEventListener('click', () => void copyFilteredResUrls());
  $('btnResCopyAll').addEventListener('click', () => void copyFilteredResAll());
  ($('netMethod') as HTMLSelectElement).addEventListener('change', (e) => { netMethod = (e.target as HTMLSelectElement).value; renderNetwork(); });
  ($('netKind') as HTMLSelectElement).addEventListener('change', (e) => { netKind = (e.target as HTMLSelectElement).value; renderNetwork(); });
  ($('netFilter') as HTMLInputElement).addEventListener('input', renderNetwork);
  ($('netTable').querySelector('tbody')!).addEventListener('click', (e) => tableClick(e, 'net'));
  $('btnNetCopyUrls').addEventListener('click', () => void copyFilteredNetUrls());
  $('btnNetCopyAll').addEventListener('click', () => void copyFilteredNetAll());
  $('btnDiscoverRoutes').addEventListener('click', () => void discoverRoutesNow());
  on('routeFilter', 'input', () => renderRoutes());
  on('btnRoutesCopy', 'click', () => void copyFilteredRouteUrls());
  on('routeTree', 'click', (e) => tableClick(e, 'route'));
  on('btnSecCopy', 'click', () => void copySecFindings());
  on('secList', 'click', secClick);
  $('btnTheme').addEventListener('click', () => {
    settings.theme = settings.theme === 'light' ? 'dark' : 'light';
    applyTheme();
  });
  $('btnPause').addEventListener('click', () => { paused = !paused; syncPause(); });
  $('btnClear').addEventListener('click', clearSession);
  $('btnRecapture').addEventListener('click', () => { try { chrome.devtools.inspectedWindow.reload(); } catch { diag('reload failed'); } });
  $('btnReindex').addEventListener('click', reindex);
  $('btnMemClean').addEventListener('click', () => {
    rawBodies.clear(); rawOrder.length = 0; ledger.rawBytes = 0;
    diag('memory cleanup: raw bodies dropped, index preserved');
    enforceBudget('manual-cleanup'); scheduleRender();
  });
  $('btnExport').addEventListener('click', exportSession);
  const deep = (): void => { if (scanning) stopDeepScan(); else void startDeepScan(); };
  $('btnDeep').addEventListener('click', deep);
  $('btnDeep2').addEventListener('click', () => void startDeepScan());
  $('btnDeepStop').addEventListener('click', () => stopDeepScan());
  $('btnGraphClear').addEventListener('click', () => { graph.clear(); renderGraph(); });
  $('btnGrant').addEventListener('click', grantSite);
  $('btnDebugger').addEventListener('click', enableDebugger);
}

function clearSession(): void {
  index.clear(); graph.clear(); resources.clear(); rawBodies.clear(); rawOrder.length = 0;
  contentHash.clear(); netEntries.length = 0; routes.clear(); diags.length = 0;
  secFindings.length = 0; secDropped = 0; secDiagOnce = false; renderedSec.length = 0;
  scanVisited = new Set(); scanQueue = []; scanFetched = 0; discoveredUrls.length = 0;
  lastResults = []; lastResultsById.clear();
  resType = 'ALL'; netMethod = 'ALL'; netKind = 'ALL';
  resTypeSig = ''; netMethodSig = ''; netKindSig = '';
  closeViewer();
  ledger.rawBytes = 0; ledger.indexedChars = 0; ledger.indexBytes = 0;
  ledger.records = 0; ledger.resources = 0; ledger.routes = 0; ledger.requests = 0; ledger.warned90 = false;
  $('budgetWarn').classList.add('hidden');
  $('results').innerHTML = ''; $('resultMeta').textContent = '';
  diag('session cleared (RAM released)');
  renderAll();
}

async function reindex(): Promise<void> {
  if (!settings.retainRaw || rawBodies.size === 0) {
    diag(`reindex: no raw bodies retained (retainRaw=${settings.retainRaw}, kept=${rawBodies.size}). Enable “retain raw” then recapture, or use Recapture/reload.`);
    return;
  }
  index.clear();
  diag(`reindexing ${rawBodies.size} retained resources…`);
  for (const [url, text] of rawBodies) {
    const m = resources.get(url);
    // eslint-disable-next-line no-await-in-loop
    await ingestText(url, text, { kind: m?.kind, mime: m?.mime, route: m?.route ?? sessionRoute, method: m?.method ?? 'manual', status: m?.status });
    contentHash.delete(url); // allow re-ingest (ingestText dedupes otherwise)
  }
}

function exportSession(): void {
  // Explicit user action only.
  const payload = {
    tool: 'DeepScope 1.4.0', exportedAt: new Date().toISOString(), origin: sessionOrigin,
    counts: { routes: routes.size, resources: resources.size, requests: netEntries.length, strings: index.size },
    routes: [...routes.entries()].map(([route, v]) => ({ route, ...v })),
    resources: [...resources.values()],
    network: netEntries.slice(0, 500),
    graph: { nodes: [...graph.nodes.values()].slice(0, 1000), edges: graph.edges.slice(0, 2000) },
    memory: ledger.stats(),
    note: 'Provenance included per record in-app; raw bodies included only if retainRaw was on.',
    bodies: settings.retainRaw ? Object.fromEntries([...rawBodies.entries()].slice(0, 100).map(([u, t]) => [u, t.slice(0, 50000)])) : undefined,
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deepscope-${(sessionOrigin || 'session').replace(/[^a-z0-9]+/gi, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  diag('session exported (explicit user request)');
}

async function grantSite(): Promise<void> {
  try {
    if (!sessionOrigin) { diag('open a page first, then grant access'); return; }
    const ok = await chrome.permissions.request({ origins: [`${sessionOrigin}/*`] });
    diag(ok ? `site access granted for ${sessionOrigin}: registering content observer` : 'site access declined — eval-based capture continues');
    if (ok) {
      try {
        await chrome.scripting.registerContentScripts([{
          id: 'deepscope-observer', matches: [`${sessionOrigin}/*`], js: ['dist/content.js'],
          runAt: 'document_idle', allFrames: true, persistAcrossSessions: false,
        }]);
      } catch (e) { diag(`content-script registration: ${String(e).slice(0, 140)}`); }
    }
  } catch (e) { diag(`grant failed: ${String(e).slice(0, 140)}`); }
}

async function enableDebugger(): Promise<void> {
  try {
    const ok = await chrome.permissions.request({ permissions: ['debugger'] });
    if (!ok) { diag('Deep Capture declined — base capture continues'); return; }
    diag('Deep Capture (CDP) permission granted. Full debugger attach is intentionally NOT auto-enabled: it shows a banner and can interfere with the page. Current build uses devtools.network + webRequest + page-context fetch, which covers the browser-visible surface without CDP. CDP attach will be added per-target in a follow-up behind this same opt-in.');
  } catch (e) { diag(`debugger opt-in failed: ${String(e).slice(0, 140)}`); }
}

// ---------- boot ----------
async function boot(): Promise<void> {
  buildScopeRow(); buildSettings(); wire(); initWorker();
  connectBackground(); hookDevtoolsNetwork();
  ledger.setBudget(settings.budgetMB);
  try {
    const href = await evalInPage<string>('location.href');
    sessionOrigin = new URL(href).origin;
    sessionRoute = new URL(href).pathname + new URL(href).search;
    $('scopeLabel').textContent = `scope: ${sessionOrigin}`;
    touchRoute(sessionRoute, 'unknown');
    // Seed DOM snapshot via eval (works with zero extra grants)
    const seed = await evalInPage<{ html: number; text: string }>('({html:(document.documentElement?.outerHTML?.length??0),text:(document.body?.innerText??"").slice(0,4000)})');
    if (seed?.text && settings.capture.dom) {
      for (const chunk of seed.text.match(/.{1,160}/g) ?? []) {
        index.add(chunk.trim(), { resourceUrl: href, resourceKind: 'dom', route: sessionRoute, method: 'dom-link' });
      }
    }
    if (seed?.html) diag(`seeded DOM snapshot (${formatBytes(seed.html)} HTML visible to browser)`);
    // Populate Routes immediately from the live page's links (read-only eval).
    void discoverRoutesNow();
  } catch { diag('inspected page not ready — browse or reload the tab'); }
  try {
    const stored = await chrome.storage.local.get('deepscope-settings') as Record<string, unknown>;
    const saved = stored['deepscope-settings'] as Partial<SessionSettings> | undefined;
    if (saved) { settings = { ...settings, ...saved }; buildSettings(); ledger.setBudget(settings.budgetMB); }
  } catch { /* storage unavailable; session-only settings */ }
  // Persist only SETTINGS (never captures) — best effort.
  window.addEventListener('beforeunload', () => {
    try { void chrome.storage.local.set({ 'deepscope-settings': settings }); } catch { /* ignore */ }
  });
  renderAll(); runSearch();
  applyTheme();
  updateDeepStatus();
}

void boot();

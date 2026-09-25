// Shared types — kept compact for RAM efficiency.

export type ResourceKind =
  | 'document' | 'dom' | 'script' | 'chunk' | 'stylesheet' | 'source-map'
  | 'manifest' | 'frame' | 'xhr' | 'fetch' | 'api-json' | 'api-text'
  | 'media-meta' | 'font-meta' | 'other-text' | 'route' | 'url' | 'header';

export type DiscoveryMethod =
  | 'devtools-network' | 'webrequest' | 'dom-link' | 'dom-script' | 'dom-form'
  | 'router' | 'history-api' | 'js-string' | 'dynamic-import' | 'static-import'
  | 'fetch-target' | 'css-reference' | 'css-import' | 'sourcemap-ref'
  | 'manifest-ref' | 'iframe' | 'sitemap' | 'deep-scan' | 'manual' | 'unknown';

export interface Provenance {
  resourceUrl: string;
  resourceKind: ResourceKind;
  route: string;               // route/page where found, e.g. "/models"
  method: DiscoveryMethod;     // how it was discovered
  initiator?: string;          // initiator URL when known
  parentUrl?: string;          // parent resource (chunk -> bundle, endpoint -> page)
  line?: number;
  column?: number;
  jsonPath?: string;           // e.g. models[4].name
  detail?: string;             // free-form, e.g. "dynamic import target"
}

export interface TextRecord {
  id: number;
  text: string;                // ORIGINAL text preserved exactly
  norm: string;                // normalized form (case/separator folded)
  prov: Provenance;
  len: number;
  hash: number;
}

export interface ResourceMeta {
  url: string;
  kind: ResourceKind;
  route: string;
  method: DiscoveryMethod;
  initiator?: string;
  status?: number;
  mime?: string;
  size?: number;               // bytes of raw body when captured
  indexed: boolean;
  hasSourceMap: boolean;
  sourceMapUrl?: string;
  indexedStrings: number;
  error?: string;              // diagnostics when capture/analysis failed
  ts: number;
  // Request identity / target awareness (filled when known; never required).
  reqId?: string;              // CDP requestId or devtools request id
  frameId?: string;            // frame the resource belongs to
  targetId?: string;           // CDP target (page/iframe/worker) when Deep Capture is on
  workerKind?: WorkerKind;      // where it was observed
  fromCache?: boolean;         // served from cache (disk/memory) rather than network
  fromServiceWorker?: boolean; // served via a service worker
}

export interface NetEntry {
  id: string;
  url: string;
  method: string;
  status?: number;
  mime?: string;
  route: string;
  initiator?: string;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  bodyKept: boolean;
  bodyTruncated: boolean;
  bodyChars: number;
  ts: number;
  note?: string;
  reqBody?: string; // sent request body text, sliced to 2000 chars at capture (only when capture.json on)
  // Request identity / correlation (filled when known; URL alone never identifies a request).
  reqId?: string;              // CDP requestId or devtools request id (unique per actual request)
  frameId?: string;            // frame that issued the request
  targetId?: string;           // CDP target (page/iframe/worker) when Deep Capture is on
  workerKind?: WorkerKind;      // where it was observed
  loaderId?: string;           // CDP loaderId (navigation/document lifecycle)
  redirects?: string[];        // redirect chain URLs (bounded, oldest-first)
  protocol?: string;           // e.g. h2, http/1.1, websocket
  timingMs?: number;           // wall-time duration when known
  fromServiceWorker?: boolean; // handled by a service worker
  fromCache?: boolean;         // served from cache rather than network
}

export interface GraphNode {
  id: string;                  // usually URL or route:URL
  label: string;
  kind: 'route' | 'resource' | 'chunk' | 'endpoint' | 'frame';
  url: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  via: DiscoveryMethod;
  label?: string;
}

export interface SearchScope {
  dom: boolean; js: boolean; chunks: boolean; css: boolean; json: boolean;
  sourcemaps: boolean; routes: boolean; urls: boolean;
  reqHeaders: boolean; reqBody: boolean; resHeaders: boolean; resBody: boolean;
  frames: boolean; meta: boolean;
}

export type SearchMode = 'exact' | 'substring' | 'normalized' | 'regex' | 'fuzzy';

/** Finding severity for the Analyze tab (rules.ts maps every rule to one). */
export type Severity = 'critical' | 'high' | 'medium' | 'info';

/** Where a request/resource was observed: page, iframe, worker, or service worker. */
export type WorkerKind = 'page' | 'iframe' | 'worker' | 'serviceworker' | 'unknown';

export interface SearchResult {
  recordId: number;
  text: string;                // original
  score: number;               // 0..1 (1 = best)
  mode: SearchMode;
  prov: Provenance;
  context: string;             // surrounding snippet (original text window)
  matchStart: number;
  matchLen: number;
  /** All highlight spans relative to `context` (fuzzy matches need >1). */
  marks?: Array<[number, number]>;
}

export interface SessionSettings {
  budgetMB: 64 | 128 | 256 | 512 | 1024;
  theme: 'dark' | 'light';
  maxResponseBytes: number;    // per-resource cap
  maxIndexedChars: number;     // per-resource indexed text cap
  maxResources: number;
  retainRaw: boolean;
  analyzeSourceMaps: boolean;
  advancedJsAnalysis: boolean;
  analyzeSecrets: boolean;   // rules.ts engine over indexed units (Analyze tab)
  includeBinaryMeta: boolean;
  onBudget: 'stop-capture' | 'discard-oldest-raw' | 'stop-deep-analysis';
  // Unified hard retention budget (RAM + temporary IndexedDB, enforced by store.ts).
  storageMB: number;           // max retained capture data (presets 60/100/250/500/1024 or custom)
  maxBodyBytes: number;        // max single retained body (text); larger bodies stay metadata-only
  retainBinary: boolean;       // retain image/video/audio bodies (default false: metadata only)
  // Deep Capture behavior (all default-cheap; expensive modes are opt-in).
  deep: {
    concurrency: number;       // max simultaneous deep fetches / parser jobs
    captureWsFrames: boolean;  // retain WebSocket frame payloads when Deep Capture is on
    runtimeHook: boolean;      // instrument fetch/XHR/WS/EventSource/history in page (opt-in)
  };
  deepScan: {
    maxDepth: number;
    maxPages: number;
    maxRequestsPerPage: number;
    sameOriginOnly: boolean;
    includeSubdomains: boolean;
    includeThirdParty: boolean;
    followRoutes: boolean;
    followImports: boolean;
    followSourceMaps: boolean;
    scanIframes: boolean;
    captureApis: boolean;
    watchSpaTransitions: boolean;
  };
  capture: {
    dom: boolean; js: boolean; css: boolean; json: boolean; headers: boolean; frames: boolean;
  };
}

export const DEFAULT_SETTINGS: SessionSettings = {
  budgetMB: 64,
  theme: 'dark',
  maxResponseBytes: 2_000_000,
  maxIndexedChars: 400_000,
  maxResources: 3000,
  retainRaw: true,
  analyzeSourceMaps: true,
  advancedJsAnalysis: true,
  analyzeSecrets: true,
  includeBinaryMeta: true,
  onBudget: 'discard-oldest-raw',
  storageMB: 60,
  maxBodyBytes: 524288,
  retainBinary: false,
  deep: { concurrency: 3, captureWsFrames: true, runtimeHook: true },
  deepScan: {
    maxDepth: 2,
    maxPages: 25,
    maxRequestsPerPage: 60,
    sameOriginOnly: true,
    includeSubdomains: false,
    includeThirdParty: false,
    followRoutes: true,
    followImports: true,
    followSourceMaps: true,
    scanIframes: true,
    captureApis: true,
    watchSpaTransitions: true,
  },
  capture: { dom: true, js: true, css: true, json: true, headers: true, frames: true },
};

export function defaultScope(): SearchScope {
  return {
    dom: true, js: true, chunks: true, css: true, json: true,
    sourcemaps: true, routes: true, urls: true,
    reqHeaders: true, reqBody: true, resHeaders: true, resBody: true,
    frames: true, meta: true,
  };
}

// Map a resource kind to the scope flags that gate it.
export function scopeAllows(kind: ResourceKind, s: SearchScope): boolean {  switch (kind) {
    case 'dom': case 'document': return s.dom;
    case 'script': return s.js;
    case 'chunk': return s.chunks;
    case 'stylesheet': return s.css;
    case 'api-json': case 'api-text': case 'xhr': case 'fetch': return s.json || s.resBody;
    case 'source-map': return s.sourcemaps;
    case 'route': case 'url': return s.routes || s.urls;
    case 'frame': return s.frames;
    case 'manifest': case 'header': case 'other-text': case 'media-meta': case 'font-meta': return s.meta;
    default: return true;
  }
}

/**
 * Strict subdomain check: host is the base host itself or ends with '.' + base.
 * Prevents evil-example.com matching example.com. Lowercases + strips one
 * trailing dot before comparing. Pure — safe to use in panel, worker, content.
 */
export function isSubdomainOf(host: string, base: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const b = base.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h || !b) return false;
  const hh = h.replace(/^www\./, '');
  return hh === b || hh.endsWith(`.${b}`);
}

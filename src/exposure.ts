// Exposure analysis — pure, RAM-only, zero deps.
// Classifies API kinds (REST/GraphQL/tRPC/...) and derives bounded,
// high-signal exposure findings (sourcemaps, sensitive endpoints,
// auth-in-URL, interesting params, internal/staging domains).

import type { Severity } from './types.js';

export type ApiKind = 'REST' | 'GraphQL' | 'tRPC' | 'gRPC-Web' | 'JSON-RPC' | 'SOAP' | 'SSE' | 'WebSocket' | 'Other';

function splitPathQuery(url: string): { path: string; query: string } {
  try {
    const u = new URL(url, 'http://localhost/');
    return { path: u.pathname.toLowerCase(), query: u.search.toLowerCase() };
  } catch {
    const s = url.toLowerCase();
    const q = s.indexOf('?');
    return q >= 0 ? { path: s.slice(0, q), query: s.slice(q) } : { path: s, query: '' };
  }
}

/**
 * Classify an endpoint into an API kind. Rules evaluated in order:
 * WebSocket scheme > gRPC mime > SSE mime > GraphQL > tRPC > JSON-RPC
 * > SOAP > REST > Other. `bodyStart` = first ~300 chars of body (optional).
 */
export function classifyApiKind(url: string, mime?: string, method?: string, bodyStart?: string): ApiKind {
  void method;
  const u = (url ?? '').toLowerCase();
  if (u.startsWith('ws:') || u.startsWith('wss:')) return 'WebSocket';
  const m = (mime ?? '').toLowerCase();
  if (m.includes('grpc')) return 'gRPC-Web';
  if (m.includes('event-stream')) return 'SSE';
  const { path, query } = splitPathQuery(url ?? '');
  const body = bodyStart ?? '';
  if (path.includes('/graphql') || body.includes('"query"')) return 'GraphQL';
  if (path.includes('/trpc/') || query.includes('batch=')) return 'tRPC';
  if (body.includes('"method"')) return 'JSON-RPC';
  if (body.includes('Envelope') || m.includes('soap')) return 'SOAP';
  if (/\/api\/|\/rest\/|\/v\d+\//.test(path) || /query=|input=/.test(query)) return 'REST';
  return 'Other';
}

export interface ExposureInput {
  routes: Array<{ route: string; method: string; count: number }>;
  resources: Array<{ url: string; kind: string; hasSourceMap: boolean }>;
  urls: string[];
  params: string[];
}

export interface ExposureFinding {
  sev: Severity;
  label: string;
  text: string;
  url: string;
  route: string;
  kind: string;
  rule: string;
}

function filenameOf(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : url;
  } catch {
    const base = url.split(/[?#]/)[0];
    const segs = base.split('/');
    return segs.pop() || url;
  }
}

function queryOf(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return '';
  const h = url.indexOf('#', q);
  return h >= 0 ? url.slice(q + 1, h) : url.slice(q + 1);
}

const AUTH_IN_URL = /(token|api_?key|sessionid|auth|access_token|secret|password)/i;
const INTERESTING_PARAM = /^(redirect|redirect_uri|debug|url|next|return|returnto|callback|file|path|dest|destination)$/i;
const SENSITIVE_ROUTE = /\/(debug|admin|console|internal|actuator|phpmyadmin|wp-admin|server-status)/i;
const INTERNAL_HOST = /localhost|^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.test$|\.invalid$|staging|internal|dev\.|\.dev$/;

/**
 * Derive bounded exposure findings from discovered routes/resources/urls/params.
 * Every category is capped (200) so output stays small on huge sessions.
 */
export function findExposures(input: ExposureInput): ExposureFinding[] {
  const out: ExposureFinding[] = [];
  let nMap = 0, nEndpoint = 0, nAuthUrl = 0, nParam = 0, nDomain = 0;

  for (const r of input.resources ?? []) {
    if (nMap >= 200) break;
    if (!r || !r.hasSourceMap) continue;
    nMap++;
    out.push({
      sev: 'high',
      label: 'Exposed source map (original source leak)',
      text: filenameOf(r.url),
      url: r.url,
      route: '',
      kind: 'source-map',
      rule: 'expo-sourcemap',
    });
  }

  for (const r of input.routes ?? []) {
    if (nEndpoint >= 200) break;
    if (!r || !SENSITIVE_ROUTE.test(r.route)) continue;
    nEndpoint++;
    out.push({
      sev: 'high',
      label: 'Sensitive endpoint exposed',
      text: r.route,
      url: '',
      route: r.route,
      kind: 'route',
      rule: 'expo-sensitive-endpoint',
    });
  }

  for (const u of input.urls ?? []) {
    if (nAuthUrl >= 200) break;
    if (typeof u !== 'string' || !u) continue;
    const q = queryOf(u);
    if (!q) continue;
    let hit: string | null = null;
    for (const pair of q.split('&')) {
      if (!pair) continue;
      const name = pair.split('=')[0];
      if (AUTH_IN_URL.test(name)) { hit = pair; break; }
    }
    if (hit === null) continue;
    nAuthUrl++;
    out.push({
      sev: 'high',
      label: 'Auth material in URL',
      text: hit.slice(0, 120),
      url: u,
      route: '',
      kind: 'url',
      rule: 'expo-auth-in-url',
    });
  }

  for (const p of input.params ?? []) {
    if (nParam >= 200) break;
    if (typeof p !== 'string' || !INTERESTING_PARAM.test(p)) continue;
    nParam++;
    out.push({
      sev: 'medium',
      label: 'Interesting parameter (redirect/debug/file?)',
      text: p,
      url: '',
      route: '',
      kind: 'param',
      rule: 'expo-param',
    });
  }

  const seenHosts = new Set<string>();
  for (const u of input.urls ?? []) {
    if (nDomain >= 200) break;
    if (typeof u !== 'string' || !u) continue;
    let host = '';
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || seenHosts.has(host) || !INTERNAL_HOST.test(host)) continue;
    seenHosts.add(host);
    nDomain++;
    out.push({
      sev: 'medium',
      label: 'Internal/staging domain',
      text: host,
      url: u,
      route: '',
      kind: 'url',
      rule: 'expo-internal-domain',
    });
  }

  return out;
}

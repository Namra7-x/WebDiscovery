// DeepScope AI Dossier Generator
// Formats complete target discovery context (endpoints, schemas, sanitized
// request/response bodies, cloud BaaS, CSP, leaks) into a structured JSON file
// for feeding into LLMs (Claude, GPT-4o, Gemini, DeepSeek, etc.).
//
// PRIVACY-FIRST GUARANTEE:
// Automatically sanitizes and redacts personal cookies, login bearer tokens,
// Google session tokens, and user email addresses before export.

import { normalizeDynamicPath, diffEndpointFields } from './extractors.js';

export interface AiDossierInput {
  origin: string;
  frameworks?: string[];
  routes?: string[];
  netEntries: Array<{
    method: string;
    url: string;
    status?: number;
    mime?: string;
    reqHeaders?: Record<string, string>;
    resHeaders?: Record<string, string>;
    reqBody?: string;
  }>;
  rawBodies?: Map<string, string>;
  apiSchemas?: Map<string, { method?: string; params?: string[]; bodyKeys?: string[] }>;
  serverActions?: Array<{ id: string; name?: string; source?: string }>;
  graphqlOps?: Array<{ name: string; type?: string; query?: string; hash?: string }>;
  cloudConfigs?: Array<{ provider: string; details: Record<string, string> }>;
  cspReport?: { domains: string[]; internalDomains: string[]; cloudBuckets: string[] };
  findings?: Array<{ rule: string; sev: string; label?: string; text: string; prov?: { resourceUrl?: string; route?: string; method?: string } }>;
}

export interface AiDossierEndpoint {
  method: string;
  url: string;
  normalizedPath: string;
  status: number | string;
  mime: string;
  callCount: number;
  parameters?: {
    queryParams?: string[];
    schemaKeys?: string[];
  };
  schemaDiff?: {
    responseOnlyFields: string[];
    sharedFields: string[];
    requestOnlyFields: string[];
  };
  requestSample?: {
    headers: Record<string, string>;
    bodyText?: string;
    bodyJson?: unknown;
  };
  responseSample?: {
    status: number | string;
    headers: Record<string, string>;
    bodyText?: string;
    bodyJson?: unknown;
  };
}

export interface AiDossierOutput {
  $schema: string;
  generator: string;
  meta: {
    targetOrigin: string;
    exportedAt: string;
    frameworks: string[];
    privacyNotice: string;
  };
  summary: {
    totalEndpoints: number;
    calledEndpoints: number;
    uncalledEndpoints: number;
    serverActionsCount: number;
    graphqlOperationsCount: number;
    securityFindingsCount: number;
    cloudConfigsCount: number;
  };
  securityFindings: Array<{
    severity: string;
    rule: string;
    label: string;
    finding: string;
    sourceUrl?: string;
  }>;
  endpoints: AiDossierEndpoint[];
  serverActions: Array<{ id: string; name?: string; source?: string }>;
  graphqlOperations: Array<{ name: string; type?: string; query?: string; hash?: string }>;
  cloudBaaS: Array<{ provider: string; details: Record<string, string> }>;
  infrastructure: {
    internalDomains: string[];
    cloudBuckets: string[];
    allDiscoveredDomains: string[];
  };
}

/**
 * Strips personal emails, session cookies, passwords, and sensitive auth tokens
 * from arbitrary strings before they are exported to an AI agent.
 */
export function sanitizeForAi(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    // 1. Redact emails (including Google logins, personal emails)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[USER_EMAIL_REDACTED]')
    // 2. Redact Google SID, HSID, SSID, APISID, SAPISID, __Secure-* cookies
    .replace(/(?:SID|HSID|SSID|APISID|SAPISID|__Secure-[a-zA-Z0-9_-]+|sessionid|connect\.sid)=[a-zA-Z0-9_\-\.]{10,}/gi, '$1=[REDACTED_SESSION]')
    // 3. Redact Bearer tokens in text
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED_BEARER_TOKEN]')
    // 4. Redact JWTs in text
    .replace(/eyJ[a-zA-Z0-9_-]{4,}\.eyJ[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]*/g, '[REDACTED_JWT]')
    // 5. Redact passwords and secrets in text/json/urls
    .replace(/(["']?(?:password|passwd|secret|client_secret|api_secret)["']?\s*[:=]\s*)["']?[^"'\s,;]+["']?/gi, '$1"[REDACTED_SECRET]"');
}

/**
 * Strips Cookie and Authorization headers, redacting sensitive session state.
 */
export function sanitizeHeadersForAi(headers?: Record<string, string>): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'set-cookie') {
      out[k] = '[REDACTED_COOKIES]';
    } else if (lk === 'authorization' || lk === 'proxy-authorization') {
      out[k] = v.toLowerCase().startsWith('bearer ') ? 'Bearer [REDACTED_AUTH_TOKEN]' : '[REDACTED_AUTH_TOKEN]';
    } else {
      out[k] = sanitizeForAi(v);
    }
  }
  return out;
}

/**
 * Builds the complete, structured, lightweight AI Dossier.
 */
export function buildAiDossier(input: AiDossierInput): AiDossierOutput {
  const origin = input.origin || 'https://target.local';
  const calledMap = new Map<string, { entry: typeof input.netEntries[0]; count: number }>();
  const calledUrls = new Set<string>();

  for (const n of input.netEntries) {
    if (!n.url || n.url.startsWith('chrome-extension://') || n.url.startsWith('devtools://')) continue;
    const key = `${n.method || 'GET'} ${n.url}`;
    const existing = calledMap.get(key);
    if (existing) {
      existing.count++;
      if (n.status && (!existing.entry.status || existing.entry.status === 0)) existing.entry.status = n.status;
    } else {
      calledMap.set(key, { entry: n, count: 1 });
      calledUrls.add(n.url);
      try {
        const u = new URL(n.url);
        calledUrls.add(u.pathname);
      } catch { /* ignore */ }
    }
  }

  const endpointList: AiDossierEndpoint[] = [];

  // 1. Process Called Endpoints
  for (const [, { entry: n, count }] of calledMap) {
    if (endpointList.length >= 300) break;
    let norm = '';
    const queryParams: string[] = [];
    try {
      const u = new URL(n.url, origin);
      norm = normalizeDynamicPath(u.pathname);
      u.searchParams.forEach((_, k) => { if (k && !queryParams.includes(k)) queryParams.push(k); });
    } catch { norm = n.url; }

    const schema = input.apiSchemas?.get(n.url);
    const retainedResBody = input.rawBodies?.get(n.url);

    let schemaDiff: AiDossierEndpoint['schemaDiff'] = undefined;
    if (n.reqBody && retainedResBody) {
      try {
        const diff = diffEndpointFields(retainedResBody, n.reqBody);
        if (diff.responseOnlyFields.length || diff.requestOnlyFields.length) {
          schemaDiff = diff;
        }
      } catch { /* ignore */ }
    }

    let reqBodyParsed: unknown = undefined;
    let reqBodyText = '';
    if (n.reqBody) {
      const sanitized = sanitizeForAi(n.reqBody.slice(0, 4000));
      try { reqBodyParsed = JSON.parse(sanitized); }
      catch { reqBodyText = sanitized; }
    }

    let resBodyParsed: unknown = undefined;
    let resBodyText = '';
    if (retainedResBody) {
      const sanitized = sanitizeForAi(retainedResBody.slice(0, 8000));
      try { resBodyParsed = JSON.parse(sanitized); }
      catch { resBodyText = sanitized; }
    }

    endpointList.push({
      method: n.method || 'GET',
      url: sanitizeForAi(n.url),
      normalizedPath: norm,
      status: n.status ?? '—',
      mime: n.mime || 'application/json',
      callCount: count,
      parameters: {
        queryParams: queryParams.length ? queryParams : (schema?.params || undefined),
        schemaKeys: schema?.bodyKeys || undefined,
      },
      schemaDiff,
      requestSample: (n.reqBody || n.reqHeaders) ? {
        headers: sanitizeHeadersForAi(n.reqHeaders),
        ...(reqBodyParsed !== undefined ? { bodyJson: reqBodyParsed } : {}),
        ...(reqBodyText ? { bodyText: reqBodyText } : {}),
      } : undefined,
      responseSample: (retainedResBody || n.resHeaders) ? {
        status: n.status ?? 200,
        headers: sanitizeHeadersForAi(n.resHeaders),
        ...(resBodyParsed !== undefined ? { bodyJson: resBodyParsed } : {}),
        ...(resBodyText ? { bodyText: resBodyText } : {}),
      } : undefined,
    });
  }

  // 2. Process Uncalled Discovered Routes/APIs
  const apiRouteRe = /\/api(\/|$|[?#])|\/graphql|\/trpc|\/rest\/|v\d+\/|\/ajax\/|\/rpc\b|\/query\b|\/gateway\//i;
  let uncalledCount = 0;
  for (const r of (input.routes || [])) {
    if (uncalledCount >= 150) break;
    if (!apiRouteRe.test(r)) continue;
    let full = r.startsWith('http') ? r : `${origin.replace(/\/$/, '')}/${r.replace(/^\//, '')}`;
    if (calledUrls.has(r) || calledUrls.has(full)) continue;
    calledUrls.add(r);
    calledUrls.add(full);
    uncalledCount++;

    let norm = '';
    try { norm = normalizeDynamicPath(new URL(full, origin).pathname); } catch { norm = r; }

    endpointList.push({
      method: '—',
      url: full,
      normalizedPath: norm,
      status: 'uncalled',
      mime: '',
      callCount: 0,
    });
  }

  // 3. Process Security Findings (Redacted)
  const safeFindings = (input.findings || []).map((f) => ({
    severity: f.sev,
    rule: f.rule,
    label: f.label || f.rule,
    finding: sanitizeForAi(f.text).slice(0, 500),
    sourceUrl: f.prov?.resourceUrl ? sanitizeForAi(f.prov.resourceUrl) : undefined,
  }));

  // 4. Return Output
  return {
    $schema: 'DeepScope-AI-Dossier-v1',
    generator: 'DeepScope Chromium DevTools Extension (v3.12.0)',
    meta: {
      targetOrigin: origin,
      exportedAt: new Date().toISOString(),
      frameworks: input.frameworks || [],
      privacyNotice: 'All personal cookies, login bearer tokens, Google session cookies, and user email addresses were automatically stripped or redacted before export.',
    },
    summary: {
      totalEndpoints: endpointList.length,
      calledEndpoints: calledMap.size,
      uncalledEndpoints: uncalledCount,
      serverActionsCount: input.serverActions?.length ?? 0,
      graphqlOperationsCount: input.graphqlOps?.length ?? 0,
      securityFindingsCount: safeFindings.length,
      cloudConfigsCount: input.cloudConfigs?.length ?? 0,
    },
    securityFindings: safeFindings,
    endpoints: endpointList,
    serverActions: input.serverActions || [],
    graphqlOperations: input.graphqlOps || [],
    cloudBaaS: input.cloudConfigs || [],
    infrastructure: {
      internalDomains: input.cspReport?.internalDomains || [],
      cloudBuckets: input.cspReport?.cloudBuckets || [],
      allDiscoveredDomains: input.cspReport?.domains || [],
    },
  };
}

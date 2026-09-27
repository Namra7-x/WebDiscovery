// DeepScope page-world interceptor (MAIN world, classic script — NO imports or
// exports; tsc must emit this as a plain script). Patches fetch + XHR only
// while ≥1 rule is active; with zero rules it installs listeners and returns,
// so page overhead is effectively nil. Rules arrive via window.postMessage
// from the ISOLATED content observer (which reads chrome.storage.session).
//
// Rule shape: {id, kind:'mock'|'block', match, useRegex, method, status, body, enabled}
// Matcher mirrors matchInterceptRule() in replay.ts — keep the two in sync.

interface InterceptRule {
  id: string;
  kind: 'mock' | 'block';
  match: string;
  useRegex?: boolean;
  method?: string;
  status?: number;
  body?: string;
  enabled?: boolean;
}

(function () {
  const w = window as unknown as Record<string, unknown>;
  if (w.__deepscopeInstalled === true) return;
  w.__deepscopeInstalled = true;
  w.__deepscopeRules = [];

  function activeRules(): InterceptRule[] {
    const all = w.__deepscopeRules as unknown;
    if (!Array.isArray(all)) return [];
    return (all as InterceptRule[]).filter((r) => r && r.enabled !== false && typeof r.match === 'string' && r.match.length > 0);
  }

  function matchRule(url: string, method: string, r: InterceptRule): boolean {
    try {
      if (r.method && r.method !== 'ANY' && r.method.toUpperCase() !== method.toUpperCase()) return false;
      if (r.useRegex) {
        const re = new RegExp(r.match, 'i');
        return re.test(url);
      }
      return url.toLowerCase().indexOf(r.match.toLowerCase()) !== -1;
    } catch {
      return false; // bad regex never matches — never breaks the page
    }
  }

  function firstMatch(url: string, method: string): InterceptRule | null {
    const rules = activeRules();
    for (let i = 0; i < rules.length; i++) {
      if (matchRule(url, method, rules[i])) return rules[i];
    }
    return null;
  }

  function mockBody(rule: InterceptRule): string {
    return typeof rule.body === 'string' ? rule.body : '';
  }

  function mockStatus(rule: InterceptRule): number {
    const s = typeof rule.status === 'number' ? rule.status : 200;
    return s >= 100 && s <= 999 ? s : 200;
  }

  // ---- fetch patch ----
  try {
    const origFetch = window.fetch.bind(window);
    const patched = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const method = (init && init.method) || (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : 'GET') || 'GET';
        const hit = firstMatch(String(url), String(method));
        if (!hit) return origFetch(input as RequestInfo, init);
        if (hit.kind === 'block') {
          return Promise.reject(new TypeError('net::ERR_BLOCKED_BY_CLIENT (DeepScope rule)'));
        }
        return Promise.resolve(new Response(mockBody(hit), {
          status: mockStatus(hit),
          headers: { 'content-type': 'application/json', 'x-deepscope-mock': hit.id },
        }));
      } catch {
        return origFetch(input as RequestInfo, init);
      }
    };
    (window as unknown as { fetch: typeof fetch }).fetch = patched as typeof fetch;
  } catch { /* fetch unpatchable — page keeps native behavior */ }

  // ---- XHR patch ----
  try {
    const OrigXHR = window.XMLHttpRequest;
    const proto = OrigXHR.prototype as unknown as Record<string, unknown>;
    const origOpen = proto.open as Function;
    const origSend = proto.send as Function;
    (proto.open as unknown) = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]): void {
      try {
        (this as unknown as Record<string, unknown>).__dsUrl = String(url);
        (this as unknown as Record<string, unknown>).__dsMethod = String(method);
      } catch { /* ignore */ }
      (origOpen as Function).apply(this, [method, url, ...rest] as unknown as [string, string]);
    };
    (proto.send as unknown) = function (this: XMLHttpRequest, ...args: unknown[]): void {
      let hit: InterceptRule | null = null;
      try {
        const rec = this as unknown as Record<string, unknown>;
        hit = firstMatch(String(rec.__dsUrl ?? ''), String(rec.__dsMethod ?? 'GET'));
      } catch { hit = null; }
      if (!hit) {
        (origSend as Function).apply(this, args as unknown as []);
        return;
      }
      const self = this as unknown as Record<string, unknown>;
      const fire = (type: string): void => {
        try {
          (self.dispatchEvent as Function).call(self, new Event(type));
          const handler = self['on' + type];
          if (typeof handler === 'function') (handler as Function).call(self, new Event(type));
        } catch { /* ignore */ }
      };
      if (hit.kind === 'block') {
        setTimeout(() => {
          try {
            Object.defineProperties(self, {
              readyState: { value: 4, configurable: true },
              status: { value: 0, configurable: true },
            });
          } catch { /* ignore */ }
          fire('error');
          fire('loadend');
        }, 0);
        return;
      }
      const body = mockBody(hit);
      const status = mockStatus(hit);
      setTimeout(() => {
        try {
          Object.defineProperties(self, {
            readyState: { value: 4, configurable: true },
            status: { value: status, configurable: true },
            statusText: { value: status === 200 ? 'OK' : 'Mock', configurable: true },
            responseText: { value: body, configurable: true },
            response: { value: body, configurable: true },
          });
          const getResp = self.getResponseHeader;
          void getResp;
          (self.getAllResponseHeaders as unknown) = () => 'content-type: application/json\r\nx-deepscope-mock: ' + String(hit && (hit as InterceptRule).id) + '\r\n';
          (self.getResponseHeader as unknown) = (name: string) =>
            String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
        } catch { /* ignore */ }
        fire('readystatechange');
        fire('load');
        fire('loadend');
      }, 0);
    };
    void OrigXHR;
  } catch { /* XHR unpatchable — page keeps native behavior */ }

  // ---- rules intake (from the ISOLATED observer via postMessage) ----
  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window) return;
      const d = e.data as { source?: string; rules?: unknown } | null;
      if (!d || d.source !== 'deepscope-rules' || !Array.isArray(d.rules)) return;
      w.__deepscopeRules = (d.rules as InterceptRule[]).slice(0, 200);
    } catch { /* ignore malformed rule pushes */ }
  });
})();

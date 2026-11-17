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
  kind: 'mock' | 'block' | 'tamper-flags';
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
  w.__deepscopeTamperFlags = false;

  function isFlagUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    const u = url.toLowerCase();
    return (
      u.indexOf('launchdarkly') !== -1 ||
      u.indexOf('featuregates') !== -1 ||
      u.indexOf('statsig') !== -1 ||
      u.indexOf('flagsmith') !== -1 ||
      u.indexOf('unleash') !== -1 ||
      u.indexOf('/decide') !== -1 ||
      u.indexOf('/feature-flags') !== -1 ||
      u.indexOf('/flags') !== -1 ||
      u.indexOf('/entitlements') !== -1 ||
      u.indexOf('/toggles') !== -1 ||
      u.indexOf('/experiments') !== -1
    );
  }

  function tamperFlagJson(text: string): string {
    try {
      if (!text || text.length < 2) return text;
      const obj = JSON.parse(text) as unknown;
      let mutated = false;

      function walk(val: unknown): unknown {
        if (val === false) {
          mutated = true;
          return true;
        }
        if (Array.isArray(val)) {
          return val.map(walk);
        }
        if (val && typeof val === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            if (v === false) {
              out[k] = true;
              mutated = true;
            } else if (k === 'enabled' && v === false) {
              out[k] = true;
              mutated = true;
            } else {
              out[k] = walk(v);
            }
          }
          return out;
        }
        return val;
      }

      const res = walk(obj);
      return mutated ? JSON.stringify(res) : text;
    } catch {
      return text;
    }
  }

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
        const shouldTamper = (hit && hit.kind === 'tamper-flags') || (w.__deepscopeTamperFlags === true && isFlagUrl(String(url)));
        if (shouldTamper) {
          return origFetch(input as RequestInfo, init).then((res) => {
            return res.text().then((txt) => {
              const tampered = tamperFlagJson(txt);
              const hdrs = new Headers(res.headers);
              hdrs.set('x-deepscope-tampered', 'flags');
              return new Response(tampered, {
                status: res.status,
                statusText: res.statusText,
                headers: hdrs,
              });
            }).catch(() => res);
          }).catch(() => origFetch(input as RequestInfo, init));
        }
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
      let reqUrl = '';
      let reqMethod = 'GET';
      try {
        const rec = this as unknown as Record<string, unknown>;
        reqUrl = String(rec.__dsUrl ?? '');
        reqMethod = String(rec.__dsMethod ?? 'GET');
        hit = firstMatch(reqUrl, reqMethod);
      } catch { hit = null; }
      const shouldTamper = (hit && hit.kind === 'tamper-flags') || (w.__deepscopeTamperFlags === true && isFlagUrl(reqUrl));
      if (shouldTamper) {
        const origOnReady = (this as XMLHttpRequest).onreadystatechange;
        (this as XMLHttpRequest).onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
          if (this.readyState === 4 && this.responseText) {
            try {
              const tampered = tamperFlagJson(this.responseText);
              Object.defineProperty(this, 'responseText', { value: tampered, configurable: true });
              Object.defineProperty(this, 'response', { value: tampered, configurable: true });
            } catch { /* ignore */ }
          }
          if (typeof origOnReady === 'function') origOnReady.call(this, ev);
        };
        (origSend as Function).apply(this, args as unknown as []);
        return;
      }
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
      const d = e.data as { source?: string; rules?: unknown; tamperFlags?: boolean; action?: string } | null;
      if (!d) return;
      if (d.source === 'deepscope-rules') {
        if (Array.isArray(d.rules)) {
          w.__deepscopeRules = (d.rules as InterceptRule[]).slice(0, 200);
        }
        if (typeof d.tamperFlags === 'boolean') {
          w.__deepscopeTamperFlags = d.tamperFlags;
        }
      } else if (d.source === 'deepscope-query' && d.action === 'get-shadow-data') {
        const sRoots = (w.__deepscope_shadowRoots as ShadowRoot[]) || [];
        const shadowLinks: string[] = [];
        const shadowForms: string[] = [];
        for (const sr of sRoots.slice(0, 100)) {
          try {
            sr.querySelectorAll?.('a[href], link[href]').forEach((el) => {
              const h = el.getAttribute('href');
              if (h && !h.startsWith('javascript:') && shadowLinks.length < 200) shadowLinks.push(h);
            });
            sr.querySelectorAll?.('form').forEach((f) => {
              const action = f.getAttribute('action') || '';
              if (shadowForms.length < 50) shadowForms.push(`${action} [${f.method || 'get'}]`);
            });
          } catch { /* ignore */ }
        }
        window.postMessage({ source: 'deepscope-shadow-data', links: shadowLinks, forms: shadowForms }, '*');
      }
    } catch { /* ignore malformed rule pushes */ }
  });

  // ---- Closed Shadow-DOM Piercing (tracks all attachShadow calls) ----
  try {
    const origAttach = Element.prototype.attachShadow;
    const shadowRoots: ShadowRoot[] = [];
    w.__deepscope_shadowRoots = shadowRoots;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      const root = origAttach.call(this, init);
      try {
        if (shadowRoots.length < 500) shadowRoots.push(root);
      } catch { /* ignore */ }
      return root;
    };
  } catch { /* ignore */ }

  // ---- Client-Side Crypto Tap (crypto.subtle encrypt / decrypt / importKey) ----
  try {
    const c = window.crypto;
    if (c && c.subtle) {
      const subtle = c.subtle;
      const origEncrypt = subtle.encrypt.bind(subtle);
      const origDecrypt = subtle.decrypt.bind(subtle);
      const origImportKey = subtle.importKey.bind(subtle);

      subtle.encrypt = async function (algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams, key: CryptoKey, data: BufferSource) {
        try {
          const algoName = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: string }).name || 'unknown';
          let preview = '';
          try {
            const u8 = new Uint8Array(data as ArrayBuffer);
            preview = new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(0, 500));
          } catch { /* ignore */ }
          window.postMessage({
            source: 'deepscope-crypto-event',
            op: 'encrypt',
            algo: algoName,
            keyAlgo: key?.algorithm?.name || 'unknown',
            preview: preview.slice(0, 200),
            byteLength: (data as ArrayBuffer).byteLength || 0,
            ts: Date.now(),
          }, '*');
        } catch { /* ignore */ }
        return origEncrypt(algorithm, key, data);
      };

      subtle.decrypt = async function (algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams, key: CryptoKey, data: BufferSource) {
        const result = await origDecrypt(algorithm, key, data);
        try {
          const algoName = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: string }).name || 'unknown';
          let preview = '';
          try {
            const u8 = new Uint8Array(result);
            preview = new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(0, 500));
          } catch { /* ignore */ }
          window.postMessage({
            source: 'deepscope-crypto-event',
            op: 'decrypt',
            algo: algoName,
            preview: preview.slice(0, 200),
            byteLength: result.byteLength || 0,
            ts: Date.now(),
          }, '*');
        } catch { /* ignore */ }
        return result;
      };

      subtle.importKey = async function (format: KeyFormat, keyData: BufferSource | JsonWebKey, algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyGenParams, extractable: boolean, keyUsages: KeyUsage[]) {
        try {
          const algoName = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: string }).name || 'unknown';
          let jwkSample = '';
          if (format === 'jwk' && typeof keyData === 'object') {
            jwkSample = JSON.stringify(keyData).slice(0, 200);
          }
          window.postMessage({
            source: 'deepscope-crypto-event',
            op: 'importKey',
            algo: algoName,
            format,
            jwk: jwkSample || undefined,
            usages: keyUsages,
            ts: Date.now(),
          }, '*');
        } catch { /* ignore */ }
        return (origImportKey as Function)(format, keyData, algorithm, extractable, keyUsages);
      };
    }
  } catch { /* ignore */ }

  // ---- postMessage Listener Auditor & Packet Tap ----
  try {
    const origAddEventListener = window.addEventListener;
    window.addEventListener = function (type: string, listener: any, options?: any) {
      if (type === 'message' && typeof listener === 'function') {
        try {
          const fnStr = Function.prototype.toString.call(listener);
          const hasOriginCheck = /(?:origin\s*===|\.origin\s*!==|origin\.indexOf|===?\s*e(?:vent)?\.origin|\.match\(|origin\s*==|\.includes\()/.test(fnStr);
          window.postMessage({
            source: 'deepscope-listener-audit',
            hasOriginCheck,
            preview: fnStr.slice(0, 300),
            ts: Date.now(),
          }, '*');
        } catch { /* ignore */ }
      }
      return origAddEventListener.call(this, type, listener, options);
    };

    origAddEventListener.call(window, 'message', (ev: any) => {
      try {
        if (!ev || !ev.data) return;
        if (typeof ev.data === 'object' && ev.data && (ev.data as Record<string, unknown>).source && String((ev.data as Record<string, unknown>).source).startsWith('deepscope-')) return;
        let sample = '';
        if (typeof ev.data === 'string') sample = ev.data.slice(0, 300);
        else sample = JSON.stringify(ev.data).slice(0, 300);
        window.postMessage({
          source: 'deepscope-postmessage-packet',
          origin: ev.origin || '',
          sample,
          ts: Date.now(),
        }, '*');
      } catch { /* ignore */ }
    }, true);
  } catch { /* ignore */ }
})();

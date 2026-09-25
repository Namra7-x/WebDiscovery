// DeepScope TEMPORARY session overflow (never a permanent DB; panel deletes per lifecycle).
// RAM-first: every export never throws so capture can continue RAM-only when IDB is unavailable.
// Zero deps, no DOM, no chrome.* — only standard IndexedDB via guarded globalThis access.

const DB_NAME = 'deepscope-tmp';
const DB_VERSION = 1;
const STORE = 'kv';
const MAX_PUT_BYTES = 5 * 1024 * 1024;

function bodyKey(session: string, url: string): string {
  return 's:' + session + '\n' + url;
}

function lenKey(session: string, url: string): string {
  return 'len:' + session + '\n' + url;
}

function tsKey(session: string, url: string): string {
  return 'ts:' + session + '\n' + url;
}

function bodyPrefix(session: string): string {
  return 's:' + session + '\n';
}

function lenPrefix(session: string): string {
  return 'len:' + session + '\n';
}

function tsPrefix(session: string): string {
  return 'ts:' + session + '\n';
}

function validSession(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validUrl(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function byteLength(text: string): number {
  try {
    const g = globalThis as unknown as {
      TextEncoder?: new () => { encode(s: string): { length: number } };
    };
    if (typeof g.TextEncoder === 'function') {
      return new g.TextEncoder().encode(text).length;
    }
  } catch {
    // fall through to length-based estimate
  }
  return text.length;
}

// Monotonic insertion marker so idbOldestUrls ordering is stable even within one ms.
let lastTs = 0;
function nextTs(): number {
  try {
    const now = Date.now();
    if (now > lastTs) lastTs = now;
    else lastTs += 1;
    return lastTs;
  } catch {
    lastTs += 1;
    return lastTs;
  }
}

type IdxDBFactory = {
  open(name: string, version?: number): {
    onupgradeneeded: ((ev: unknown) => void) | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onblocked: (() => void) | null;
    result: {
      objectStoreNames: { contains(n: string): boolean };
      createObjectStore(n: string): unknown;
      transaction(
        names: string | string[],
        mode?: string,
      ): {
        objectStore(n: string): {
          put(v: unknown, k: string): { onsuccess: (() => void) | null; onerror: (() => void) | null };
          get(k: string): {
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            result: unknown;
            error?: unknown;
          };
          delete(k: string): { onsuccess: (() => void) | null; onerror: (() => void) | null };
          getAllKeys(): {
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            result: unknown;
            error?: unknown;
          };
          openCursor(): {
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            result: {
              key: unknown;
              value: unknown;
              continue(): void;
            } | null;
            error?: unknown;
          };
        };
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error?: unknown;
      };
      close(): void;
    };
    error?: unknown;
  };
};

function getFactory(): IdxDBFactory | undefined {
  try {
    const g = globalThis as unknown as { indexedDB?: unknown };
    const idb = g.indexedDB as IdxDBFactory | undefined;
    if (!idb) return undefined;
    if (typeof (idb as unknown as { open?: unknown }).open !== 'function') return undefined;
    return idb;
  } catch {
    return undefined;
  }
}

function openDb(): Promise<
  | {
      tx(
        mode: string,
        fn: (store: {
          put(v: unknown, k: string): Promise<void>;
          get(k: string): Promise<unknown>;
          del(k: string): Promise<void>;
          scanKeys(): Promise<string[]>;
          scanEntries(): Promise<Array<{ key: string; value: unknown }>>;
        }) => void,
      ): Promise<void>;
      close(): void;
    }
  | undefined
> {
  let factory: IdxDBFactory | undefined;
  try {
    factory = getFactory();
  } catch {
    return Promise.resolve(undefined);
  }
  if (!factory) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const done = (
      v:
        | {
            tx(mode: string, fn: (store: never) => void): Promise<void>;
            close(): void;
          }
        | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      resolve(v as never);
    };
    try {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (): void => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        } catch {
          // ignore — open will fail/succeed without the store; callers degrade to RAM-only
        }
      };
      req.onsuccess = (): void => {
        try {
          const db = req.result;
          const handle = {
            tx(
              mode: string,
              fn: (store: {
                put(v: unknown, k: string): Promise<void>;
                get(k: string): Promise<unknown>;
                del(k: string): Promise<void>;
                scanKeys(): Promise<string[]>;
                scanEntries(): Promise<Array<{ key: string; value: unknown }>>;
              }) => void,
            ): Promise<void> {
              return new Promise<void>((res, rej) => {
                let txObj:
                  | {
                      objectStore(n: string): never;
                      oncomplete: (() => void) | null;
                      onerror: (() => void) | null;
                      onabort: (() => void) | null;
                      error?: unknown;
                    }
                  | undefined;
                try {
                  const raw = db.transaction(STORE, mode) as unknown as {
                    objectStore(n: string): {
                      put(
                        v: unknown,
                        k: string,
                      ): { onsuccess: (() => void) | null; onerror: (() => void) | null };
                      get(k: string): {
                        onsuccess: (() => void) | null;
                        onerror: (() => void) | null;
                        result: unknown;
                        error?: unknown;
                      };
                      delete(k: string): {
                        onsuccess: (() => void) | null;
                        onerror: (() => void) | null;
                      };
                      getAllKeys?: () => {
                        onsuccess: (() => void) | null;
                        onerror: (() => void) | null;
                        result: unknown;
                        error?: unknown;
                      };
                      openCursor(): {
                        onsuccess: (() => void) | null;
                        onerror: (() => void) | null;
                        result: { key: unknown; value: unknown; continue(): void } | null;
                        error?: unknown;
                      };
                    };
                    oncomplete: (() => void) | null;
                    onerror: (() => void) | null;
                    onabort: (() => void) | null;
                    error?: unknown;
                  };
                  txObj = raw as never;
                  const os = raw.objectStore(STORE);
                  const wrapPut = (v: unknown, k: string): Promise<void> =>
                    new Promise<void>((rs, rj) => {
                      try {
                        const r = os.put(v, k);
                        r.onsuccess = (): void => rs();
                        r.onerror = (): void => rj(new Error('put failed'));
                      } catch (e) {
                        rj(e);
                      }
                    });
                  const wrapGet = (k: string): Promise<unknown> =>
                    new Promise<unknown>((rs, rj) => {
                      try {
                        const r = os.get(k);
                        r.onsuccess = (): void => rs(r.result);
                        r.onerror = (): void => rj(r.error ?? new Error('get failed'));
                      } catch (e) {
                        rj(e);
                      }
                    });
                  const wrapDel = (k: string): Promise<void> =>
                    new Promise<void>((rs, rj) => {
                      try {
                        const r = os.delete(k);
                        r.onsuccess = (): void => rs();
                        r.onerror = (): void => rj(new Error('delete failed'));
                      } catch (e) {
                        rj(e);
                      }
                    });
                  const scanKeys = (): Promise<string[]> =>
                    new Promise<string[]>((rs, rj) => {
                      try {
                        if (typeof os.getAllKeys === 'function') {
                          const r = (os.getAllKeys as () => {
                            onsuccess: (() => void) | null;
                            onerror: (() => void) | null;
                            result: unknown;
                            error?: unknown;
                          })();
                          r.onsuccess = (): void => {
                            try {
                              const out: string[] = [];
                              const rawKeys = r.result as unknown;
                              if (Array.isArray(rawKeys)) {
                                for (const k of rawKeys) if (typeof k === 'string') out.push(k);
                              }
                              rs(out);
                            } catch (e) {
                              rj(e);
                            }
                          };
                          r.onerror = (): void => rj(r.error ?? new Error('getAllKeys failed'));
                        } else {
                          const out: string[] = [];
                          const cur = os.openCursor();
                          cur.onsuccess = (): void => {
                            try {
                              const c = cur.result;
                              if (!c) {
                                rs(out);
                                return;
                              }
                              if (typeof c.key === 'string') out.push(c.key);
                              c.continue();
                            } catch (e) {
                              rj(e);
                            }
                          };
                          cur.onerror = (): void => rj(cur.error ?? new Error('cursor failed'));
                        }
                      } catch (e) {
                        rj(e);
                      }
                    });
                  const scanEntries = (): Promise<Array<{ key: string; value: unknown }>> =>
                    new Promise<Array<{ key: string; value: unknown }>>((rs, rj) => {
                      try {
                        const out: Array<{ key: string; value: unknown }> = [];
                        const cur = os.openCursor();
                        cur.onsuccess = (): void => {
                          try {
                            const c = cur.result;
                            if (!c) {
                              rs(out);
                              return;
                            }
                            if (typeof c.key === 'string') out.push({ key: c.key, value: c.value });
                            c.continue();
                          } catch (e) {
                            rj(e);
                          }
                        };
                        cur.onerror = (): void => rj(cur.error ?? new Error('cursor failed'));
                      } catch (e) {
                        rj(e);
                      }
                    });
                  raw.oncomplete = (): void => res();
                  raw.onerror = (): void => rej(raw.error ?? new Error('tx failed'));
                  raw.onabort = (): void => rej(raw.error ?? new Error('tx aborted'));
                  fn({
                    put: wrapPut,
                    get: wrapGet,
                    del: wrapDel,
                    scanKeys,
                    scanEntries,
                  });
                } catch (e) {
                  try {
                    void txObj;
                  } catch {
                    // ignore
                  }
                  rej(e);
                }
              });
            },
            close(): void {
              try {
                db.close();
              } catch {
                // ignore
              }
            },
          };
          done(handle as never);
        } catch {
          done(undefined);
        }
      };
      req.onerror = (): void => {
        done(undefined);
      };
      req.onblocked = (): void => {
        // Do not hang forever; success may still arrive. Leave pending.
      };
    } catch {
      done(undefined);
    }
  });
}

/** crypto.randomUUID() with Math.random fallback, never throws. */
export function newSessionId(): string {
  try {
    const g = globalThis as unknown as { crypto?: { randomUUID?: unknown } };
    const c = g.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try {
        const id = (c.randomUUID as () => unknown)();
        if (typeof id === 'string' && id.length > 0) return id;
      } catch {
        // fall through to Math.random fallback
      }
    }
  } catch {
    // fall through
  }
  try {
    const tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    let out = '';
    for (let i = 0; i < tpl.length; i++) {
      const ch = tpl[i];
      if (ch === 'x' || ch === 'y') {
        const r = Math.floor(Math.random() * 16);
        const v = ch === 'x' ? r : (r & 0x3) | 0x8;
        out += v.toString(16);
      } else {
        out += ch;
      }
    }
    return out;
  } catch {
    try {
      lastTs += 1;
      return 's-fallback-' + String(Date.now()) + '-' + String(lastTs);
    } catch {
      return 's-fallback';
    }
  }
}

export async function idbPutBody(session: string, url: string, text: string): Promise<void> {
  try {
    if (!validSession(session) || !validUrl(url) || typeof text !== 'string') return;
    if (byteLength(text) > MAX_PUT_BYTES) return;
    const len = byteLength(text);
    const ts = nextTs();
    const db = await openDb();
    if (!db) return;
    try {
      await db.tx('readwrite', (s) => {
        void s.put(text, bodyKey(session, url));
        void s.put(len, lenKey(session, url));
        void s.put(ts, tsKey(session, url));
      });
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // never throw — capture continues RAM-only
  }
}

export async function idbGetBody(session: string, url: string): Promise<string | undefined> {
  try {
    if (!validSession(session) || !validUrl(url)) return undefined;
    const db = await openDb();
    if (!db) return undefined;
    try {
      let out: unknown;
      await db.tx('readonly', (s) => {
        void s.get(bodyKey(session, url)).then(
          (v) => {
            out = v;
          },
          () => {
            out = undefined;
          },
        );
      });
      return typeof out === 'string' ? out : undefined;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    return undefined;
  }
}

export async function idbDeleteBody(session: string, url: string): Promise<void> {
  try {
    if (!validSession(session) || !validUrl(url)) return;
    const db = await openDb();
    if (!db) return;
    try {
      await db.tx('readwrite', (s) => {
        void s.del(bodyKey(session, url));
        void s.del(lenKey(session, url));
        void s.del(tsKey(session, url));
      });
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // never throw
  }
}

export async function idbOldestUrls(session: string, limit: number): Promise<string[]> {
  try {
    if (!validSession(session)) return [];
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return [];
    const n = Math.floor(limit);
    if (n <= 0) return [];
    const db = await openDb();
    if (!db) return [];
    try {
      const prefix = tsPrefix(session);
      let entries: Array<{ key: string; value: unknown }> = [];
      await db.tx('readonly', (s) => {
        void s.scanEntries().then(
          (rows) => {
            entries = rows;
          },
          () => {
            entries = [];
          },
        );
      });
      const rows: Array<{ url: string; ts: number }> = [];
      for (const e of entries) {
        try {
          if (typeof e.key !== 'string') continue;
          if (e.key.slice(0, prefix.length) !== prefix) continue;
          if (typeof e.value !== 'number' || !Number.isFinite(e.value)) continue;
          const url = e.key.slice(prefix.length);
          if (url.length === 0) continue;
          rows.push({ url, ts: e.value });
        } catch {
          // skip bad entry
        }
      }
      rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      const out: string[] = [];
      for (let i = 0; i < rows.length && out.length < n; i++) out.push(rows[i].url);
      return out;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    return [];
  }
}

export async function idbDeleteSession(session: string): Promise<void> {
  try {
    if (!validSession(session)) return;
    const db = await openDb();
    if (!db) return;
    try {
      const bp = bodyPrefix(session);
      const lp = lenPrefix(session);
      const tp = tsPrefix(session);
      let keys: string[] = [];
      // First collect keys in a readonly tx, then delete in a readwrite tx
      // (avoids cursor+delete in one pass complexities).
      await db.tx('readonly', (s) => {
        void s.scanKeys().then(
          (ks) => {
            keys = ks;
          },
          () => {
            keys = [];
          },
        );
      });
      const doomed: string[] = [];
      for (const k of keys) {
        if (
          k.slice(0, bp.length) === bp ||
          k.slice(0, lp.length) === lp ||
          k.slice(0, tp.length) === tp
        ) {
          doomed.push(k);
        }
      }
      if (doomed.length === 0) return;
      await db.tx('readwrite', (s) => {
        for (const k of doomed) void s.del(k);
      });
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // never throw
  }
}

export async function idbListSessions(): Promise<string[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    try {
      let keys: string[] = [];
      await db.tx('readonly', (s) => {
        void s.scanKeys().then(
          (ks) => {
            keys = ks;
          },
          () => {
            keys = [];
          },
        );
      });
      const found: string[] = [];
      const seen: Record<string, boolean> = {};
      for (const k of keys) {
        try {
          if (typeof k !== 'string') continue;
          const nl = k.indexOf('\n');
          if (nl < 0) continue;
          const head = k.slice(0, nl);
          const ci = head.indexOf(':');
          if (ci < 0) continue;
          const kind = head.slice(0, ci);
          if (kind !== 's' && kind !== 'len' && kind !== 'ts') continue;
          const sess = head.slice(ci + 1);
          if (sess.length === 0) continue;
          if (!seen[sess]) {
            seen[sess] = true;
            found.push(sess);
          }
        } catch {
          // skip bad key
        }
      }
      return found;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    return [];
  }
}

export async function idbSessionBytes(session: string): Promise<number> {
  try {
    if (!validSession(session)) return 0;
    const db = await openDb();
    if (!db) return 0;
    try {
      const prefix = lenPrefix(session);
      let entries: Array<{ key: string; value: unknown }> = [];
      await db.tx('readonly', (s) => {
        void s.scanEntries().then(
          (rows) => {
            entries = rows;
          },
          () => {
            entries = [];
          },
        );
      });
      let sum = 0;
      for (const e of entries) {
        try {
          if (typeof e.key !== 'string') continue;
          if (e.key.slice(0, prefix.length) !== prefix) continue;
          if (typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value <= 0) continue;
          sum += e.value;
          if (!Number.isFinite(sum) || sum < 0) {
            sum = Math.max(0, sum);
            break;
          }
        } catch {
          // skip bad entry
        }
      }
      return Math.max(0, sum);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    return 0;
  }
}

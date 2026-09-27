// DeepScope session files (.dsz = gzipped JSON, single file, explicit only).
// RAM-only default is untouched: nothing auto-saves; Save/Open are buttons.
// This module is pure (build + validate) so verify.mjs can unit-test it; the
// panel owns gzip + file pickers + the actual state restore.

export const DSZ_MAGIC = 'DeepScope';
export const DSZ_VERSION = 1;
/** Hard caps so a hostile or ancient file can't wedge the panel. */
export const DSZ_MAX_ENTRIES = 2000;
export const DSZ_MAX_BODIES = 300;
export const DSZ_MAX_BODY_CHARS = 50_000;
export const DSZ_MAX_BODIES_TOTAL = 12_000_000; // ~12 MB

export interface DszRoute { route: string; method?: unknown; count?: unknown }

export interface SessionFile {
  tool: string;
  format: number;
  exportedAt: string;
  origin: string;
  counts: { routes: number; resources: number; requests: number; bodies: number };
  routes: DszRoute[];
  /** Opaque records (ResourceMeta / NetEntry shapes) — validated loosely, restored field-by-field. */
  resources: object[];
  network: object[];
  bodies: Record<string, string>;
}

export interface SessionSnapshot {
  origin: string;
  routes: DszRoute[];
  resources: object[];
  network: object[];
  bodies: Record<string, string>;
}

/** Build a bounded, self-describing snapshot from live state. Pure. */
export function buildSessionFile(snap: SessionSnapshot): SessionFile {
  const routes = Array.isArray(snap.routes) ? snap.routes.slice(0, DSZ_MAX_ENTRIES) : [];
  const resources = Array.isArray(snap.resources) ? snap.resources.slice(0, DSZ_MAX_ENTRIES) : [];
  const network = Array.isArray(snap.network) ? snap.network.slice(0, DSZ_MAX_ENTRIES) : [];
  const bodies: Record<string, string> = {};
  let total = 0;
  let kept = 0;
  const src = snap.bodies && typeof snap.bodies === 'object' ? snap.bodies : {};
  for (const [u, t] of Object.entries(src)) {
    if (kept >= DSZ_MAX_BODIES || total >= DSZ_MAX_BODIES_TOTAL) break;
    if (typeof u !== 'string' || typeof t !== 'string' || !u || !t) continue;
    const slice = t.length > DSZ_MAX_BODY_CHARS ? t.slice(0, DSZ_MAX_BODY_CHARS) : t;
    bodies[u] = slice;
    total += slice.length;
    kept++;
  }
  return {
    tool: DSZ_MAGIC,
    format: DSZ_VERSION,
    exportedAt: new Date().toISOString(),
    origin: typeof snap.origin === 'string' ? snap.origin : '',
    counts: { routes: routes.length, resources: resources.length, requests: network.length, bodies: kept },
    routes, resources, network, bodies,
  };
}

export interface DszValidate { ok: boolean; file?: SessionFile; error?: string }

/** Validate a parsed file before the panel restores a single byte. Pure. */
export function validateSessionFile(json: unknown): DszValidate {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not a JSON object' };
  const o = json as Record<string, unknown>;
  if (o['tool'] !== DSZ_MAGIC) return { ok: false, error: 'not a DeepScope session file (bad magic)' };
  if (o['format'] !== DSZ_VERSION) return { ok: false, error: `unsupported session format (want ${DSZ_VERSION})` };
  if (!Array.isArray(o['resources']) || !Array.isArray(o['network']) || !Array.isArray(o['routes'])) {
    return { ok: false, error: 'session file missing routes/resources/network' };
  }
  if (o['bodies'] !== undefined && (typeof o['bodies'] !== 'object' || o['bodies'] === null)) {
    return { ok: false, error: 'session file has a corrupt bodies block' };
  }
  if ((o['resources'] as unknown[]).length > DSZ_MAX_ENTRIES * 2 || (o['network'] as unknown[]).length > DSZ_MAX_ENTRIES * 2) {
    return { ok: false, error: 'session file exceeds safe entry limits' };
  }
  return { ok: true, file: json as SessionFile };
}

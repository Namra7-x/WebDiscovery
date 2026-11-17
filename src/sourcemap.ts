// Pure, zero-dependency source-map reconstruction for a RAM-capped panel.
// No imports. Never throws.

export interface SourceMapFile {
  path: string;
  content: string;
}

export interface ParsedSourceMap {
  files: SourceMapFile[];
  truncated: boolean;
}

/** Max reconstructed files kept per map. */
export const MAX_SOURCEMAP_FILES = 400;
/** Max chars kept per reconstructed file. */
export const MAX_SOURCEMAP_CHARS_PER_FILE = 200_000;
/** Minimum content length kept (filters nulls, empties, stubs). */
const MIN_CONTENT_LEN = 10;

/**
 * Safe-parse a raw source-map JSON string and pair `sources` with
 * `sourcesContent` by index. Keeps entries whose content is a string longer
 * than 10 chars. Caps at 400 files / 200_000 chars per file (sets
 * `truncated` when either cap bites). Returns `{ files: [], truncated: false }`
 * on any malformed input. Never throws.
 */
export function parseSourceMap(text: string): ParsedSourceMap {
  try {
    if (typeof text !== 'string' || text.length === 0) return { files: [], truncated: false };
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { files: [], truncated: false };
    }
    const rec = parsed as Record<string, unknown>;
    const sources = rec['sources'];
    const sourcesContent = rec['sourcesContent'];
    if (!Array.isArray(sources) || !Array.isArray(sourcesContent)) {
      return { files: [], truncated: false };
    }
    const files: SourceMapFile[] = [];
    let truncated = false;
    for (let i = 0; i < sources.length; i++) {
      const p: unknown = sources[i];
      const c: unknown = sourcesContent[i];
      if (typeof p !== 'string' || p.length === 0) continue;
      if (typeof c !== 'string' || c.length <= MIN_CONTENT_LEN) continue;
      if (files.length >= MAX_SOURCEMAP_FILES) { truncated = true; break; }
      let content = c;
      if (content.length > MAX_SOURCEMAP_CHARS_PER_FILE) {
        content = content.slice(0, MAX_SOURCEMAP_CHARS_PER_FILE);
        truncated = true;
      }
      files.push({ path: p, content });
    }
    return { files, truncated };
  } catch {
    return { files: [], truncated: false };
  }
}

/** True for `scheme:...` (http:, webpack:, vite:, data:, blob:, ...). */
function hasScheme(s: string): boolean {
  if (s.length < 2) return false;
  const c0 = s.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 45 || c === 46)
    ) return false;
  }
  return false;
}

/** Normalize `./`/`../` segments of a path (no filesystem access). */
function normalizeSegments(path: string): string {
  const rooted = path.charCodeAt(0) === 47; // leading '/'
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (rooted ? '/' : '') + out.join('/');
}

/**
 * Resolve a `sources` entry against the map URL. Absolute http(s) URLs and
 * `webpack://`/`vite://`-style pseudo-schemes (any `scheme:...`) are returned
 * as-is; relative paths join against the map URL directory with `#` fragments
 * (and queries) preserved. Returns `srcPath` on any failure. Never throws.
 */
export function resolveSourceUrl(mapUrl: string, srcPath: string): string {
  try {
    if (typeof srcPath !== 'string' || srcPath.length === 0) return srcPath;
    if (typeof mapUrl !== 'string' || mapUrl.length === 0) return srcPath;
    if (hasScheme(srcPath)) return srcPath;
    try {
      return new URL(srcPath, new URL(mapUrl)).toString();
    } catch {
      // Fall through to manual directory join for non-absolute map URLs.
    }
    // Strip query/fragment from the base, keep its directory.
    let base = mapUrl;
    const hash = base.indexOf('#');
    if (hash >= 0) base = base.slice(0, hash);
    const q = base.indexOf('?');
    if (q >= 0) base = base.slice(0, q);
    // A root-absolute srcPath without a URL origin cannot be resolved.
    if (srcPath.charCodeAt(0) === 47) return srcPath;
    const slash = base.lastIndexOf('/');
    const dir = slash >= 0 ? base.slice(0, slash + 1) : '';
    // Preserve src fragment/query verbatim.
    let frag = '';
    let rel = srcPath;
    const fh = rel.indexOf('#');
    if (fh >= 0) { frag = rel.slice(fh); rel = rel.slice(0, fh); }
    const joined = normalizeSegments(dir + rel);
    return joined + frag;
  } catch {
    return srcPath;
  }
}

// ---- Source Map Project ZIP Exporter (Zero external deps, PKZIP 2.0) ----

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(buf: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function sanitizeZipPath(raw: string): string {
  if (typeof raw !== 'string') return 'file.txt';
  let p = raw.replace(/^[a-zA-Z0-9_+.-]+:\/\/?/, ''); // strip webpack://, etc.
  p = p.replace(/^(\/_N_E\/|\/)+/, ''); // strip Next.js _N_E prefix
  p = p.replace(/^\.\/+/, '');
  p = p.replace(/\.\.\//g, ''); // prevent directory traversal
  p = p.replace(/[\\:]/g, '/');
  p = p.replace(/\/+/g, '/').replace(/^\/+/, '');
  return p.trim() || 'file.txt';
}

/**
 * Builds a valid PKZIP 2.0 archive from reconstructed source-map files.
 * Zero external dependencies, single flat Uint8Array memory-efficient layout.
 */
export function buildSourceMapZip(files: SourceMapFile[]): Uint8Array {
  if (!Array.isArray(files) || files.length === 0) {
    const emptyZip = new Uint8Array(22);
    const view = new DataView(emptyZip.buffer);
    view.setUint32(0, 0x06054b50, true);
    return emptyZip;
  }

  const encoder = new TextEncoder();
  const fileRecords: Array<{
    nameBytes: Uint8Array;
    dataBytes: Uint8Array;
    crc: number;
    offset: number;
  }> = [];

  let offset = 0;
  let cdSize = 0;

  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    const cleanPath = sanitizeZipPath(f.path);
    const nameBytes = encoder.encode(cleanPath);
    const dataBytes = encoder.encode(typeof f.content === 'string' ? f.content : '');
    const crc = crc32(dataBytes);

    fileRecords.push({ nameBytes, dataBytes, crc, offset });
    offset += 30 + nameBytes.length + dataBytes.length;
    cdSize += 46 + nameBytes.length;
  }

  const totalSize = offset + cdSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let ptr = 0;
  // 1. Write Local File Headers + File Data
  for (const r of fileRecords) {
    view.setUint32(ptr, 0x04034b50, true);
    view.setUint16(ptr + 4, 20, true);       // version needed (2.0)
    view.setUint16(ptr + 6, 0x0800, true);   // flag: UTF-8
    view.setUint16(ptr + 8, 0, true);        // method: 0 (stored)
    view.setUint16(ptr + 10, 0, true);       // mod time
    view.setUint16(ptr + 12, 0, true);       // mod date
    view.setUint32(ptr + 14, r.crc, true);   // crc-32
    view.setUint32(ptr + 18, r.dataBytes.length, true); // comp size
    view.setUint32(ptr + 22, r.dataBytes.length, true); // uncomp size
    view.setUint16(ptr + 26, r.nameBytes.length, true); // name length
    view.setUint16(ptr + 28, 0, true);       // extra length
    ptr += 30;

    out.set(r.nameBytes, ptr);
    ptr += r.nameBytes.length;

    out.set(r.dataBytes, ptr);
    ptr += r.dataBytes.length;
  }

  const cdStart = ptr;
  // 2. Write Central Directory Headers
  for (const r of fileRecords) {
    view.setUint32(ptr, 0x02014b50, true);
    view.setUint16(ptr + 4, 20, true);       // version made by (2.0)
    view.setUint16(ptr + 6, 20, true);       // version needed (2.0)
    view.setUint16(ptr + 8, 0x0800, true);   // flag: UTF-8
    view.setUint16(ptr + 10, 0, true);      // method: 0
    view.setUint16(ptr + 12, 0, true);      // mod time
    view.setUint16(ptr + 14, 0, true);      // mod date
    view.setUint32(ptr + 16, r.crc, true);  // crc-32
    view.setUint32(ptr + 20, r.dataBytes.length, true); // comp size
    view.setUint32(ptr + 24, r.dataBytes.length, true); // uncomp size
    view.setUint16(ptr + 28, r.nameBytes.length, true); // name length
    view.setUint16(ptr + 30, 0, true);      // extra length
    view.setUint16(ptr + 32, 0, true);      // comment length
    view.setUint16(ptr + 34, 0, true);      // disk start
    view.setUint16(ptr + 36, 0, true);      // internal attr
    view.setUint32(ptr + 38, 0, true);      // external attr
    view.setUint32(ptr + 42, r.offset, true); // local header offset
    ptr += 46;

    out.set(r.nameBytes, ptr);
    ptr += r.nameBytes.length;
  }

  // 3. Write End of Central Directory Record (EOCD)
  view.setUint32(ptr, 0x06054b50, true);
  view.setUint16(ptr + 4, 0, true);         // disk num
  view.setUint16(ptr + 6, 0, true);         // cd disk
  view.setUint16(ptr + 8, fileRecords.length, true);  // records on disk
  view.setUint16(ptr + 10, fileRecords.length, true); // total records
  view.setUint32(ptr + 12, cdSize, true);             // cd size
  view.setUint32(ptr + 16, cdStart, true);            // cd offset
  view.setUint16(ptr + 20, 0, true);        // comment len

  return out;
}

/**
 * Generates potential unlinked source-map URLs for scripts that stripped //# sourceMappingURL.
 * Checks <script>.js.map, <script>.map, and paths with query params handled.
 */
export function probeOrphanSourceMapCandidates(scriptUrl: string): string[] {
  if (!scriptUrl || scriptUrl.length < 5 || scriptUrl.startsWith('data:') || scriptUrl.startsWith('blob:')) return [];
  const candidates: string[] = [];
  try {
    const u = new URL(scriptUrl);
    const path = u.pathname;
    if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
      const base = `${u.origin}${path}.map`;
      candidates.push(base);
      const dotJsMap = `${u.origin}${path.replace(/\.[cm]?js$/, '')}.js.map`;
      if (!candidates.includes(dotJsMap)) candidates.push(dotJsMap);
    } else {
      candidates.push(`${u.origin}${path}.map`);
    }
  } catch {
    const clean = scriptUrl.split('?')[0].split('#')[0];
    candidates.push(`${clean}.map`);
  }
  return candidates;
}

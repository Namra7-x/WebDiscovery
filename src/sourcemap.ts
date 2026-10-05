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

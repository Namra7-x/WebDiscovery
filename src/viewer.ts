// DeepScope Universal Viewer engine — pure, zero runtime deps, lightweight.
// Detects, beautifies, deobfuscates, decompresses, hex-dumps, and renders
// all resource types (code, JSON, media, archives, pure binary) with zero failure states.

export type ContentCategory =
  | 'image'
  | 'audio'
  | 'video'
  | 'svg'
  | 'json'
  | 'javascript'
  | 'css'
  | 'html'
  | 'xml'
  | 'gzip'
  | 'zip'
  | 'binary'
  | 'text';

export interface DetectResult {
  category: ContentCategory;
  mime: string;
  isMedia: boolean;
  isBinary: boolean;
  canDecompress: boolean;
  canBeautify: boolean;
  label: string;
}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/** Check if text or buffer starts with magic bytes. */
function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** Convert string to Uint8Array safely (handles binary/latin1 strings). */
export function toUint8Array(data: Uint8Array | string): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const len = data.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    buf[i] = data.charCodeAt(i) & 0xff;
  }
  return buf;
}

/** Sniff category from URL, MIME type, and optional sample content/bytes. */
export function detectContentCategory(
  url: string,
  rawMime = '',
  sampleText = '',
  rawBytes?: Uint8Array,
): DetectResult {
  const u = (url || '').toLowerCase().split('#')[0].split('?')[0];
  const mime = (rawMime || '').toLowerCase();
  const bytes = rawBytes ?? (sampleText ? toUint8Array(sampleText.slice(0, 32)) : new Uint8Array(0));

  // 1. Magic bytes sniff (most authoritative)
  if (hasMagic(bytes, [0x1f, 0x8b])) {
    return { category: 'gzip', mime: mime || 'application/gzip', isMedia: false, isBinary: true, canDecompress: true, canBeautify: false, label: 'Gzip archive' };
  }
  if (hasMagic(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { category: 'zip', mime: mime || 'application/zip', isMedia: false, isBinary: true, canDecompress: true, canBeautify: false, label: 'ZIP archive' };
  }
  if (hasMagic(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return { category: 'image', mime: mime || 'image/png', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'PNG image' };
  }
  if (hasMagic(bytes, [0xff, 0xd8, 0xff])) {
    return { category: 'image', mime: mime || 'image/jpeg', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'JPEG image' };
  }
  if (hasMagic(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { category: 'image', mime: mime || 'image/gif', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'GIF image' };
  }
  if (hasMagic(bytes, [0x00, 0x61, 0x73, 0x6d])) {
    return { category: 'binary', mime: mime || 'application/wasm', isMedia: false, isBinary: true, canDecompress: false, canBeautify: false, label: 'WebAssembly binary' };
  }

  // 2. MIME type & extension matching
  if (mime.includes('image/svg') || u.endsWith('.svg')) {
    return { category: 'svg', mime: 'image/svg+xml', isMedia: true, isBinary: false, canDecompress: false, canBeautify: true, label: 'SVG vector image' };
  }
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?)($|\?)/.test(u)) {
    return { category: 'image', mime: mime || 'image/png', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'Image' };
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|weba)($|\?)/.test(u)) {
    return { category: 'audio', mime: mime || 'audio/mpeg', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'Audio recording' };
  }
  if (mime.startsWith('video/') || /\.(mp4|webm|ogv|mov|m4v)($|\?)/.test(u)) {
    return { category: 'video', mime: mime || 'video/mp4', isMedia: true, isBinary: true, canDecompress: false, canBeautify: false, label: 'Video stream' };
  }
  if (mime.includes('json') || u.endsWith('.json') || u.endsWith('.map')) {
    return { category: 'json', mime: mime || 'application/json', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'JSON data' };
  }
  if (mime.includes('javascript') || mime.includes('ecmascript') || /\.(m?js|cjs|jsx|ts|tsx)($|\?)/.test(u)) {
    return { category: 'javascript', mime: mime || 'application/javascript', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'JavaScript code' };
  }
  if (mime.includes('css') || u.endsWith('.css')) {
    return { category: 'css', mime: mime || 'text/css', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'CSS stylesheet' };
  }
  if (mime.includes('html') || u.endsWith('.html') || u.endsWith('.htm')) {
    return { category: 'html', mime: mime || 'text/html', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'HTML document' };
  }
  if (mime.includes('xml') || u.endsWith('.xml')) {
    return { category: 'xml', mime: mime || 'application/xml', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'XML document' };
  }
  if (mime.includes('gzip') || u.endsWith('.gz') || u.endsWith('.tgz')) {
    return { category: 'gzip', mime: mime || 'application/gzip', isMedia: false, isBinary: true, canDecompress: true, canBeautify: false, label: 'Gzip archive' };
  }
  if (mime.includes('zip') || u.endsWith('.zip')) {
    return { category: 'zip', mime: mime || 'application/zip', isMedia: false, isBinary: true, canDecompress: true, canBeautify: false, label: 'ZIP archive' };
  }

  // 3. Content Sniff (for responses with missing or generic text/plain headers)
  const trimmed = sampleText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(sampleText);
      return { category: 'json', mime: 'application/json', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'JSON data' };
    } catch { /* keep checking */ }
  }
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return { category: 'html', mime: 'text/html', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'HTML document' };
  }
  if (/^<svg[\s>]/i.test(trimmed)) {
    return { category: 'svg', mime: 'image/svg+xml', isMedia: true, isBinary: false, canDecompress: false, canBeautify: true, label: 'SVG vector image' };
  }

  // 4. Pure Binary Detection
  if (isNonPrintableBinary(sampleText)) {
    return { category: 'binary', mime: mime || 'application/octet-stream', isMedia: false, isBinary: true, canDecompress: false, canBeautify: false, label: 'Binary payload' };
  }

  return { category: 'text', mime: mime || 'text/plain', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'Plain text' };
}

/** Check if sample string contains predominantly non-printable binary bytes. */
export function isNonPrintableBinary(text: string): boolean {
  if (!text || text.length < 8) return false;
  const sample = text.slice(0, 1024);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // null byte or control chars outside tab/lf/cr
    if (c === 0 || (c < 9 && c >= 0) || (c > 13 && c < 32)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.15;
}

/** Add clean line numbers to formatted text. */
export function addLineNumbers(code: string): string {
  const lines = code.split('\n');
  const padLen = Math.max(3, String(lines.length).length);
  return lines.map((ln, idx) => {
    const num = String(idx + 1).padStart(padLen, ' ');
    return `${num} | ${ln}`;
  }).join('\n');
}

/** Lightweight, zero-dependency JavaScript code beautifier / de-obfuscator. */
export function beautifyJs(code: string, maxLen = 250_000): string {
  if (!code) return '';
  const src = code.length > maxLen ? code.slice(0, maxLen) : code;
  const n = src.length;
  let out = '';
  let indent = 0;
  let inParen = 0;
  let forParenDepth = -1;
  let i = 0;

  const getIndent = (): string => '  '.repeat(Math.max(0, indent));

  while (i < n) {
    const ch = src[i];

    // 1. String literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += quote;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === '\\') {
          if (i + 1 < n) { out += src[i + 1]; i++; }
        } else if (c === quote) {
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // 2. Line comment
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += src[i];
        i++;
      }
      if (i < n) {
        out += '\n' + getIndent();
        i++;
      }
      continue;
    }

    // 3. Block comment
    if (ch === '/' && src[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i];
        i++;
      }
      if (i < n) { out += '*/'; i += 2; }
      continue;
    }

    // 4. Detect for-loop statement (semicolons in for headers shouldn't break line)
    if (ch === 'f' && src.slice(i, i + 4) === 'for(') {
      out += 'for (';
      i += 4;
      inParen++;
      forParenDepth = inParen;
      continue;
    }

    // 5. Parentheses
    if (ch === '(') {
      inParen++;
      out += '(';
      i++;
      continue;
    }
    if (ch === ')') {
      if (inParen === forParenDepth) forParenDepth = -1;
      if (inParen > 0) inParen--;
      out += ')';
      i++;
      continue;
    }

    // 6. Block Open
    if (ch === '{') {
      indent++;
      out += ' {\n' + getIndent();
      i++;
      // skip following whitespace
      while (i < n && /\s/.test(src[i])) i++;
      continue;
    }

    // 7. Block Close
    if (ch === '}') {
      if (indent > 0) indent--;
      // Trim trailing whitespace on the current line
      out = out.replace(/[ \t]+$/, '');
      if (!out.endsWith('\n')) out += '\n';
      out += getIndent() + '}';
      i++;
      // If followed by semicolon, else, catch, finally
      if (src.slice(i, i + 4) === 'else') {
        out += ' ';
      } else if (src[i] === ';') {
        out += ';';
        i++;
        out += '\n' + getIndent();
      } else {
        out += '\n' + getIndent();
      }
      while (i < n && /\s/.test(src[i])) i++;
      continue;
    }

    // 8. Statement separator (semicolon)
    if (ch === ';') {
      out += ';';
      i++;
      if (inParen === 0) {
        out += '\n' + getIndent();
        while (i < n && /\s/.test(src[i])) i++;
      } else {
        out += ' ';
      }
      continue;
    }

    // 9. Comma
    if (ch === ',') {
      out += ', ';
      i++;
      while (i < n && src[i] === ' ') i++;
      continue;
    }

    // 10. Normal character
    out += ch;
    i++;
  }

  // Clean up any double blank lines
  const cleaned = out.replace(/\n{3,}/g, '\n\n').trim();
  return addLineNumbers(cleaned);
}

/** Lightweight JSON formatter. */
export function beautifyJson(text: string, maxLen = 250_000): string {
  if (!text) return '';
  const src = text.length > maxLen ? text.slice(0, maxLen) : text;
  try {
    const parsed = JSON.parse(src);
    return addLineNumbers(JSON.stringify(parsed, null, 2));
  } catch {
    // If not strict JSON (e.g. truncated), try line-based indent
    let indent = 0;
    let out = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '{' || c === '[') {
        indent++;
        out += c + '\n' + '  '.repeat(indent);
      } else if (c === '}' || c === ']') {
        if (indent > 0) indent--;
        out += '\n' + '  '.repeat(indent) + c;
      } else if (c === ',') {
        out += ',\n' + '  '.repeat(indent);
      } else {
        out += c;
      }
    }
    return addLineNumbers(out.trim());
  }
}

/** Lightweight CSS formatter. */
export function beautifyCss(css: string, maxLen = 250_000): string {
  if (!css) return '';
  const src = css.length > maxLen ? css.slice(0, maxLen) : css;
  let out = '';
  let indent = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      indent++;
      out += ' {\n' + '  '.repeat(indent);
    } else if (c === '}') {
      if (indent > 0) indent--;
      out += '\n' + '  '.repeat(indent) + '}\n' + '  '.repeat(indent);
    } else if (c === ';') {
      out += ';\n' + '  '.repeat(indent);
    } else {
      out += c;
    }
  }
  return addLineNumbers(out.replace(/\n{3,}/g, '\n\n').trim());
}

/** Lightweight HTML/XML formatter. */
export function beautifyHtml(html: string, maxLen = 250_000): string {
  if (!html) return '';
  const src = html.length > maxLen ? html.slice(0, maxLen) : html;
  // Simple tag-based indent
  let indent = 0;
  let out = '';
  const tokens = src.split(/(<[^>]+>)/g);
  for (const t of tokens) {
    const s = t.trim();
    if (!s) continue;
    if (s.startsWith('</')) {
      if (indent > 0) indent--;
      out += '\n' + '  '.repeat(indent) + s;
    } else if (s.startsWith('<') && !s.endsWith('/>') && !s.startsWith('<!') && !s.startsWith('<?')) {
      out += '\n' + '  '.repeat(indent) + s;
      indent++;
    } else {
      out += (s.startsWith('<') ? '\n' + '  '.repeat(indent) : ' ') + s;
    }
  }
  return addLineNumbers(out.trim());
}

/** Format any binary buffer or string into a classic Hex Dump. */
export function formatHexDump(data: Uint8Array | string, maxBytes = 32_768): string {
  const bytes = toUint8Array(data);
  const total = bytes.length;
  const limit = Math.min(total, maxBytes);
  const lines: string[] = [];

  lines.push('Offset (h)  00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F  Decoded Text');
  lines.push('-------------------------------------------------------------------------');

  for (let offset = 0; offset < limit; offset += 16) {
    const chunk = bytes.slice(offset, Math.min(offset + 16, limit));
    const hex1: string[] = [];
    const hex2: string[] = [];
    let ascii = '';

    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const b = chunk[i];
        const h = b.toString(16).padStart(2, '0').toUpperCase();
        if (i < 8) hex1.push(h);
        else hex2.push(h);
        // Printable ASCII (32..126)
        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      } else {
        if (i < 8) hex1.push('  ');
        else hex2.push('  ');
      }
    }

    const offHex = offset.toString(16).padStart(8, '0').toUpperCase();
    const h1 = hex1.join(' ').padEnd(23, ' ');
    const h2 = hex2.join(' ').padEnd(23, ' ');
    lines.push(`${offHex}  ${h1}  ${h2}  |${ascii}|`);
  }

  if (total > limit) {
    lines.push(`... [truncated: showing first ${limit} of ${total} bytes]`);
  }

  return lines.join('\n');
}

/** Native browser Gzip / Deflate decompressor using DecompressionStream. */
export async function decompressPayload(
  data: Uint8Array | string,
): Promise<{ text?: string; bytes?: Uint8Array; format: string; error?: string }> {
  const bytes = toUint8Array(data);
  const isGzip = hasMagic(bytes, [0x1f, 0x8b]);
  const format = isGzip ? 'gzip' : 'deflate';

  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream }).DecompressionStream;
  if (!DS) {
    return { format, error: 'DecompressionStream unavailable in this environment' };
  }

  try {
    const raw = bytes.buffer.byteLength === bytes.length
      ? bytes.buffer
      : bytes.slice().buffer;
    const stream = new Blob([raw as ArrayBuffer]).stream().pipeThrough(new DS(format));
    const buf = await new Response(stream).arrayBuffer();
    const unpacked = new Uint8Array(buf);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(unpacked);
    return { text, bytes: unpacked, format };
  } catch (err) {
    return { format, error: String(err) };
  }
}

/** Parse ZIP central directory / local headers to list files in archive. */
export function parseZipListing(data: Uint8Array | string): ZipEntry[] {
  const bytes = toUint8Array(data);
  const entries: ZipEntry[] = [];
  const n = bytes.length;
  let i = 0;

  // Scan local file headers: signature 0x04034b50 (PK\x03\x04)
  while (i + 30 <= n && entries.length < 500) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
      const compSize = bytes[i + 18] | (bytes[i + 19] << 8) | (bytes[i + 20] << 16) | (bytes[i + 21] << 24);
      const uncompSize = bytes[i + 22] | (bytes[i + 23] << 8) | (bytes[i + 24] << 16) | (bytes[i + 25] << 24);
      const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
      const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);

      const nameBytes = bytes.slice(i + 30, i + 30 + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      if (name) {
        entries.push({
          name,
          compressedSize: compSize >>> 0,
          uncompressedSize: uncompSize >>> 0,
        });
      }
      i += 30 + nameLen + extraLen + (compSize >>> 0);
    } else {
      i++;
    }
  }

  return entries;
}

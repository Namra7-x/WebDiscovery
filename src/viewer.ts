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
  | 'protobuf'
  | 'msgpack'
  | 'rsc'
  | 'wasm'
  | 'ai-stream'
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
  if (hasMagic(bytes, [0x00, 0x61, 0x73, 0x6d]) || mime.includes('wasm') || u.endsWith('.wasm')) {
    return { category: 'wasm', mime: 'application/wasm', isMedia: false, isBinary: true, canDecompress: false, canBeautify: true, label: 'WebAssembly binary' };
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
  if (mime.includes('protobuf') || mime.includes('grpc-web') || mime.includes('connect+proto') || u.endsWith('.pb') || u.endsWith('.proto')) {
    return { category: 'protobuf', mime: mime || 'application/x-protobuf', isMedia: false, isBinary: true, canDecompress: false, canBeautify: true, label: 'Protobuf / gRPC wire payload' };
  }
  if (mime.includes('msgpack') || mime.includes('x-msgpack') || mime.includes('cbor') || u.endsWith('.msgpack') || u.endsWith('.mpk')) {
    return { category: 'msgpack', mime: mime || 'application/msgpack', isMedia: false, isBinary: true, canDecompress: false, canBeautify: true, label: 'MessagePack binary' };
  }
  if (mime.includes('text/x-component') || mime.includes('text/x-rsc') || u.includes('_rsc=') || u.endsWith('.rsc')) {
    return { category: 'rsc', mime: mime || 'text/x-component', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'Next.js RSC Wire Stream' };
  }
  if (mime.includes('text/event-stream') || sampleText.includes('data: {"choices"') || sampleText.includes('data: {"delta"') || (sampleText.includes('data: {') && sampleText.includes('[DONE]'))) {
    return { category: 'ai-stream', mime: 'text/event-stream', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'AI LLM Event Stream' };
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
  if (trimmed.includes('self.__next_f.push') || /^\d+:[IHLDS$]?[\[{]/.test(trimmed)) {
    return { category: 'rsc', mime: 'text/x-component', isMedia: false, isBinary: false, canDecompress: false, canBeautify: true, label: 'Next.js RSC Wire Stream' };
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

export interface ProtobufField {
  fieldNumber: number;
  wireType: number;
  wireTypeName: string;
  value: any;
  subMessage?: ProtobufField[];
}

/** Zero-dependency raw Protobuf & gRPC-Web wire decoder. */
export function decodeRawProtobuf(data: Uint8Array | string): {
  fields: ProtobufField[];
  formatted: string;
  isGrpcWeb: boolean;
} {
  const bytes = toUint8Array(data);
  let offset = 0;
  let isGrpcWeb = false;

  // Check gRPC-Web frame (5 byte header: 1 byte flag, 4 bytes big-endian length)
  if (bytes.length >= 5) {
    const flag = bytes[0];
    const len = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
    if ((flag === 0 || flag === 0x80) && len === bytes.length - 5) {
      isGrpcWeb = true;
      offset = 5;
    }
  }

  function readVarint(pos: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    let p = pos;
    while (p < bytes.length) {
      const b = BigInt(bytes[p++]);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) break;
      shift += 7n;
      if (shift > 70n) break;
    }
    return [result, p];
  }

  function parseFields(start: number, end: number, depth = 0): ProtobufField[] {
    if (depth > 6) return [];
    const fields: ProtobufField[] = [];
    let p = start;
    while (p < end && fields.length < 500) {
      const [tag, nextP] = readVarint(p);
      if (nextP === p) break;
      p = nextP;
      const wireType = Number(tag & 0x07n);
      const fieldNum = Number(tag >> 3n);
      if (fieldNum === 0) break;

      if (wireType === 0) { // Varint
        const [val, vP] = readVarint(p);
        p = vP;
        const numVal = val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : val.toString();
        fields.push({ fieldNumber: fieldNum, wireType, wireTypeName: 'varint', value: numVal });
      } else if (wireType === 1) { // 64-bit
        if (p + 8 > end) break;
        const view = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
        const floatVal = view.getFloat64(0, true);
        const intVal = view.getBigUint64(0, true);
        p += 8;
        fields.push({
          fieldNumber: fieldNum,
          wireType,
          wireTypeName: 'fixed64',
          value: isFinite(floatVal) && Math.abs(floatVal) < 1e12 && Math.abs(floatVal) > 1e-6 ? floatVal : intVal.toString(),
        });
      } else if (wireType === 2) { // Length-delimited
        const [lenBig, lP] = readVarint(p);
        p = lP;
        const len = Number(lenBig);
        if (p + len > end || len < 0) break;
        const slice = bytes.slice(p, p + len);
        p += len;

        let sub: ProtobufField[] | null = null;
        if (len > 1) {
          try {
            const parsedSub = parseFields(0, slice.length, depth + 1);
            if (parsedSub.length > 0) sub = parsedSub;
          } catch { /* not a sub-message */ }
        }

        let strVal: string | null = null;
        try {
          const dec = new TextDecoder('utf-8', { fatal: true }).decode(slice);
          if (!/[\x00-\x08\x0E-\x1F]/.test(dec)) strVal = dec;
        } catch { /* not utf-8 */ }

        fields.push({
          fieldNumber: fieldNum,
          wireType,
          wireTypeName: 'length-delimited',
          value: strVal ?? (sub ? undefined : Array.from(slice.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(' ')),
          subMessage: sub || undefined,
        });
      } else if (wireType === 5) { // 32-bit
        if (p + 4 > end) break;
        const view = new DataView(bytes.buffer, bytes.byteOffset + p, 4);
        const floatVal = view.getFloat32(0, true);
        const intVal = view.getUint32(0, true);
        p += 4;
        fields.push({
          fieldNumber: fieldNum,
          wireType,
          wireTypeName: 'fixed32',
          value: isFinite(floatVal) && Math.abs(floatVal) < 1e6 && Math.abs(floatVal) > 1e-4 ? floatVal : intVal,
        });
      } else {
        break; // Unsupported or invalid wire type
      }
    }
    return fields;
  }

  const fields = parseFields(offset, bytes.length);

  function formatProto(flist: ProtobufField[], indent = '  '): string {
    let out = '';
    for (const f of flist) {
      if (f.subMessage && f.subMessage.length) {
        out += `${indent}message field_${f.fieldNumber} {\n`;
        out += formatProto(f.subMessage, indent + '  ');
        out += `${indent}}\n`;
      } else if (typeof f.value === 'string' && f.wireType === 2) {
        out += `${indent}string field_${f.fieldNumber} = ${JSON.stringify(f.value)};\n`;
      } else {
        out += `${indent}${f.wireTypeName} field_${f.fieldNumber} = ${f.value};\n`;
      }
    }
    return out;
  }

  let formatted = `// DeepScope Protobuf Wire Decoder${isGrpcWeb ? ' (gRPC-Web framing stripped)' : ''}\n// Discovered Fields: ${fields.length}\n\nmessage ReconstructedMessage {\n`;
  formatted += formatProto(fields, '  ');
  formatted += '}\n';

  return { fields, formatted: addLineNumbers(formatted), isGrpcWeb };
}

/** Zero-dependency MessagePack wire decoder. */
export function decodeMsgPack(data: Uint8Array | string): { value: any; formatted: string } {
  const bytes = toUint8Array(data);
  let pos = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function decodeNext(): any {
    if (pos >= bytes.length) return undefined;
    const b = bytes[pos++];

    // positive fixint
    if (b <= 0x7f) return b;
    // fixmap
    if (b >= 0x80 && b <= 0x8f) {
      const size = b & 0x0f;
      const obj: Record<string, any> = {};
      for (let i = 0; i < size; i++) {
        const k = String(decodeNext() ?? '');
        obj[k] = decodeNext();
      }
      return obj;
    }
    // fixarray
    if (b >= 0x90 && b <= 0x9f) {
      const size = b & 0x0f;
      const arr: any[] = [];
      for (let i = 0; i < size; i++) arr.push(decodeNext());
      return arr;
    }
    // fixstr
    if (b >= 0xa0 && b <= 0xbf) {
      const len = b & 0x1f;
      const s = new TextDecoder().decode(bytes.slice(pos, pos + len));
      pos += len;
      return s;
    }
    // nil
    if (b === 0xc0) return null;
    // bool
    if (b === 0xc2) return false;
    if (b === 0xc3) return true;
    // bin 8/16/32
    if (b === 0xc4) { const len = bytes[pos++]; const s = bytes.slice(pos, pos + len); pos += len; return s; }
    if (b === 0xc5) { const len = view.getUint16(pos); pos += 2; const s = bytes.slice(pos, pos + len); pos += len; return s; }
    if (b === 0xc6) { const len = view.getUint32(pos); pos += 4; const s = bytes.slice(pos, pos + len); pos += len; return s; }
    // float 32 / 64
    if (b === 0xca) { const v = view.getFloat32(pos); pos += 4; return v; }
    if (b === 0xcb) { const v = view.getFloat64(pos); pos += 8; return v; }
    // uint 8/16/32/64
    if (b === 0xcc) return bytes[pos++];
    if (b === 0xcd) { const v = view.getUint16(pos); pos += 2; return v; }
    if (b === 0xce) { const v = view.getUint32(pos); pos += 4; return v; }
    if (b === 0xcf) { const v = view.getBigUint64(pos); pos += 8; return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
    // int 8/16/32/64
    if (b === 0xd0) return view.getInt8(pos++);
    if (b === 0xd1) { const v = view.getInt16(pos); pos += 2; return v; }
    if (b === 0xd2) { const v = view.getInt32(pos); pos += 4; return v; }
    if (b === 0xd3) { const v = view.getBigInt64(pos); pos += 8; return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
    // str 8/16/32
    if (b === 0xd9) { const len = bytes[pos++]; const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; }
    if (b === 0xda) { const len = view.getUint16(pos); pos += 2; const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; }
    if (b === 0xdb) { const len = view.getUint32(pos); pos += 4; const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; }
    // array 16/32
    if (b === 0xdc) {
      const len = view.getUint16(pos); pos += 2;
      const arr: any[] = [];
      for (let i = 0; i < len; i++) arr.push(decodeNext());
      return arr;
    }
    if (b === 0xdd) {
      const len = view.getUint32(pos); pos += 4;
      const arr: any[] = [];
      for (let i = 0; i < len; i++) arr.push(decodeNext());
      return arr;
    }
    // map 16/32
    if (b === 0xde) {
      const len = view.getUint16(pos); pos += 2;
      const obj: Record<string, any> = {};
      for (let i = 0; i < len; i++) {
        const k = String(decodeNext() ?? '');
        obj[k] = decodeNext();
      }
      return obj;
    }
    if (b === 0xdf) {
      const len = view.getUint32(pos); pos += 4;
      const obj: Record<string, any> = {};
      for (let i = 0; i < len; i++) {
        const k = String(decodeNext() ?? '');
        obj[k] = decodeNext();
      }
      return obj;
    }
    // negative fixint (0xe0 - 0xff) -> -32 to -1
    if (b >= 0xe0) return b - 0x100;

    return null;
  }

  let value: any = null;
  try {
    value = decodeNext();
  } catch {
    value = '(MessagePack decoding error)';
  }
  const formatted = addLineNumbers(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return { value, formatted };
}

export interface RscEntry {
  id: string;
  tag: string;
  data: any;
  raw: string;
}

/** Zero-dependency Next.js App Router RSC flight stream decoder. */
export function decodeRscStream(text: string): {
  entries: RscEntry[];
  formatted: string;
  serverActions: string[];
  sensitiveProps: Array<{ key: string; sample: string }>;
} {
  if (typeof text !== 'string') return { entries: [], formatted: '', serverActions: [], sensitiveProps: [] };

  const pushChunks: string[] = [];
  const PUSH_RE = /self\.__next_f\.push\s*\(\s*\[\s*\d+\s*,\s*(["'])([\s\S]*?)\1\s*\]\s*\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = PUSH_RE.exec(text))) {
    try {
      const rawStr = JSON.parse(`"${pm[2].replace(/"/g, '\\"')}"`);
      pushChunks.push(rawStr);
    } catch {
      pushChunks.push(pm[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
  }

  const rawLines = pushChunks.length ? pushChunks.join('\n').split('\n') : text.split('\n');
  const entries: RscEntry[] = [];
  const serverActions = new Set<string>();
  const sensitiveProps: Array<{ key: string; sample: string }> = [];

  const SENSITIVE_KEY_RE = /(password|token|secret|auth|admin|role|credit|stripe|session|hash|key|email|private)/i;
  const ACTION_HASH_RE = /^[0-9a-fA-F]{40,42}$/;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const id = trimmed.slice(0, colonIdx);
    const rest = trimmed.slice(colonIdx + 1);
    let tag = '';
    let payload = rest;

    if (/^[IHLDS$]/.test(rest)) {
      tag = rest[0];
      payload = rest.slice(1);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = payload;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      if (typeof parsed.id === 'string' && ACTION_HASH_RE.test(parsed.id)) {
        serverActions.add(parsed.id);
      }
      try {
        const str = JSON.stringify(parsed);
        const matches = str.match(/"([^"]+)":\s*(?:("[^"]*")|(\d+)|(true|false)|null)/g);
        if (matches) {
          for (const m of matches) {
            const k = m.split(':')[0].replace(/"/g, '');
            if (SENSITIVE_KEY_RE.test(k) && !sensitiveProps.some((s) => s.key === k)) {
              sensitiveProps.push({ key: k, sample: m.slice(0, 100) });
            }
          }
        }
      } catch { /* ignore */ }
    }

    entries.push({ id, tag, data: parsed, raw: trimmed });
  }

  let formatted = `// DeepScope React Server Components (RSC) Wire Inspector\n// Parsed Lines: ${entries.length} · Server Actions: ${serverActions.size} · Sensitive Props: ${sensitiveProps.length}\n`;
  if (serverActions.size > 0) {
    formatted += `\n// Discovered Server Action Hashes (Next-Action):\n`;
    for (const a of serverActions) formatted += `//   - ${a}\n`;
  }
  if (sensitiveProps.length > 0) {
    formatted += `\n// Surface-Exposed Server Props in Client Boundary:\n`;
    for (const p of sensitiveProps) formatted += `//   - ${p.key}: ${p.sample}\n`;
  }
  formatted += '\n' + '='.repeat(70) + '\n\n';

  for (const entry of entries) {
    const tagDesc = entry.tag === 'I' ? ' [Client Reference / Module Import]'
      : entry.tag === 'H' ? ' [Resource Hint]'
      : entry.tag === 'S' ? ' [Symbol / Server Action]'
      : '';
    formatted += `[Chunk ${entry.id}]${tagDesc}\n`;
    formatted += (typeof entry.data === 'object' ? JSON.stringify(entry.data, null, 2) : entry.data) + '\n\n';
  }

  return { entries, formatted: addLineNumbers(formatted), serverActions: [...serverActions], sensitiveProps };
}

/** Zero-dependency WebSocket frame inspector & unframer (Socket.IO / Phoenix / GraphQL-WS). */
export function decodeWsFrame(payload: string): { protocol: string; event?: string; data: any; formatted: string } {
  if (typeof payload !== 'string' || !payload.trim()) {
    return { protocol: 'raw', data: payload, formatted: payload };
  }

  const s = payload.trim();

  // 1. Socket.IO engine.io frame (e.g. 42["event", {...}])
  if (/^4[0-9]/.test(s)) {
    const rest = s.slice(2);
    try {
      const arr = JSON.parse(rest);
      if (Array.isArray(arr) && arr.length >= 1) {
        const event = String(arr[0]);
        const data = arr.length > 1 ? arr[1] : null;
        const formatted = addLineNumbers(`// Socket.IO Frame · Event: "${event}"\n` + JSON.stringify(data ?? arr, null, 2));
        return { protocol: 'socket.io', event, data, formatted };
      }
    } catch { /* keep checking */ }
  }

  // 2. GraphQL-WS / subscriptions-transport-ws ({"type":"subscribe", ...})
  if (s.startsWith('{') && (s.includes('"type"') || s.includes('"payload"'))) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj.type === 'string') {
        const formatted = addLineNumbers(`// GraphQL-WS Message · Type: "${obj.type}"\n` + JSON.stringify(obj, null, 2));
        return { protocol: 'graphql-ws', event: obj.type, data: obj, formatted };
      }
    } catch { /* keep checking */ }
  }

  // 3. Generic JSON WS frame
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const obj = JSON.parse(s);
      const formatted = addLineNumbers('// WebSocket JSON Frame\n' + JSON.stringify(obj, null, 2));
      return { protocol: 'json', data: obj, formatted };
    } catch { /* raw */ }
  }

  return { protocol: 'raw', data: s, formatted: addLineNumbers(s) };
}

export interface AiStreamResult {
  fullText: string;
  toolCalls: Array<{ name: string; args: string }>;
  systemPrompts: string[];
  chunksCount: number;
  formatted: string;
}

/**
 * Unchunks streaming SSE LLM responses (OpenAI, Anthropic, Ollama, LangChain).
 * Reconstructs complete conversation responses, tool invocations, and system messages.
 */
export function decodeAiStream(text: string): AiStreamResult {
  if (typeof text !== 'string' || !text.trim()) {
    return { fullText: '', toolCalls: [], systemPrompts: [], chunksCount: 0, formatted: '' };
  }

  const lines = text.split('\n');
  let fullText = '';
  const toolMap = new Map<string, { name: string; args: string }>();
  const systemPrompts: string[] = [];
  let chunksCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (raw === '[DONE]' || !raw.startsWith('{')) continue;

    try {
      const obj = JSON.parse(raw);
      chunksCount++;

      // 1. OpenAI / generic chat completion choices
      if (Array.isArray(obj.choices)) {
        for (const ch of obj.choices) {
          const delta = ch.delta || ch.message;
          if (delta) {
            if (delta.role === 'system' && typeof delta.content === 'string') {
              if (!systemPrompts.includes(delta.content)) systemPrompts.push(delta.content);
            } else if (typeof delta.content === 'string') {
              fullText += delta.content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const id = String(tc.id || tc.index || 'default');
                const fn = tc.function || {};
                const existing = toolMap.get(id) || { name: '', args: '' };
                if (fn.name) existing.name = fn.name;
                if (fn.arguments) existing.args += fn.arguments;
                toolMap.set(id, existing);
              }
            }
          }
        }
      }

      // 2. Anthropic style stream
      if (obj.type === 'content_block_delta' && obj.delta?.text) {
        fullText += obj.delta.text;
      }

      // 3. Ollama style stream
      if (typeof obj.response === 'string') {
        fullText += obj.response;
      }
    } catch { /* skip malformed line */ }
  }

  const toolCalls = [...toolMap.values()];

  let formatted = `// DeepScope AI / LLM Stream Inspector\n// Chunks Unpacked: ${chunksCount} · Reconstructed Length: ${fullText.length} chars · Tool Calls: ${toolCalls.length}\n`;
  if (systemPrompts.length) {
    formatted += `\n// --- DETECTED SYSTEM PROMPTS (${systemPrompts.length}) ---\n`;
    for (const sp of systemPrompts) {
      formatted += `/* ${sp} */\n`;
    }
  }
  if (toolCalls.length) {
    formatted += `\n// --- DETECTED AGENT TOOL INVOCATIONS (${toolCalls.length}) ---\n`;
    for (const tc of toolCalls) {
      formatted += `tool: ${tc.name || 'unnamed'}(${tc.args})\n`;
    }
  }
  formatted += '\n' + '='.repeat(70) + '\n\n';
  formatted += fullText ? fullText : '(No text payload reconstructed)';

  return {
    fullText,
    toolCalls,
    systemPrompts,
    chunksCount,
    formatted: addLineNumbers(formatted),
  };
}

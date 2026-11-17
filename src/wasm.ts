// DeepScope WebAssembly (WASM) Binary Dissector — pure, zero runtime deps.
// Parses WASM modules (magic \0asm), extracts imported host APIs, exported functions,
// memory tables, custom debug names, and linear memory string literals/secrets.

export interface WasmImport {
  module: string;
  field: string;
  kind: 'func' | 'table' | 'memory' | 'global' | 'unknown';
  typeIndex?: number;
}

export interface WasmExport {
  name: string;
  kind: 'func' | 'table' | 'memory' | 'global' | 'unknown';
  index: number;
}

export interface WasmDissection {
  version: number;
  imports: WasmImport[];
  exports: WasmExport[];
  strings: string[];
  endpoints: string[];
  totalSections: number;
  hasMemory: boolean;
  formatted: string;
}

/** Reads an unsigned LEB128 integer from a Uint8Array. */
function readVarUint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift >= 35) break;
  }
  return [result, pos];
}

/** Reads a UTF-8 string with LEB128 length prefix. */
function readString(bytes: Uint8Array, offset: number): [string, number] {
  const [len, pos] = readVarUint(bytes, offset);
  if (pos + len > bytes.length || len < 0) return ['', bytes.length];
  try {
    const str = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(pos, pos + len));
    return [str, pos + len];
  } catch {
    return ['', pos + len];
  }
}

const KIND_NAMES: Array<WasmImport['kind']> = ['func', 'table', 'memory', 'global'];

/**
 * Dissects a raw WebAssembly binary buffer into imports, exports, functions, and string literals.
 */
export function dissectWasmBinary(data: Uint8Array | string): WasmDissection {
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else {
    bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  }

  // Check magic \0asm (0x00, 0x61, 0x73, 0x6D)
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    return {
      version: 0, imports: [], exports: [], strings: [], endpoints: [],
      totalSections: 0, hasMemory: false, formatted: '// Not a valid WebAssembly binary (missing \\0asm magic bytes)',
    };
  }

  const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  const imports: WasmImport[] = [];
  const exportsList: WasmExport[] = [];
  const stringSet = new Set<string>();
  const endpointSet = new Set<string>();
  let totalSections = 0;
  let hasMemory = false;

  let pos = 8;
  while (pos < bytes.length && totalSections < 64) {
    const secId = bytes[pos++];
    const [secSize, nextPos] = readVarUint(bytes, pos);
    pos = nextPos;
    const secEnd = Math.min(bytes.length, pos + secSize);
    totalSections++;

    if (secId === 2) {
      // Import Section
      let [count, p] = readVarUint(bytes, pos);
      for (let i = 0; i < count && p < secEnd && imports.length < 200; i++) {
        const [mod, p1] = readString(bytes, p);
        const [field, p2] = readString(bytes, p1);
        const kindByte = bytes[p2];
        const kind = KIND_NAMES[kindByte] ?? 'unknown';
        p = p2 + 1;
        if (kind === 'func') {
          const [typeIdx, p3] = readVarUint(bytes, p);
          imports.push({ module: mod, field, kind, typeIndex: typeIdx });
          p = p3;
        } else {
          imports.push({ module: mod, field, kind });
          if (kind === 'memory') hasMemory = true;
          p++; // skip limits
        }
      }
    } else if (secId === 7) {
      // Export Section
      let [count, p] = readVarUint(bytes, pos);
      for (let i = 0; i < count && p < secEnd && exportsList.length < 300; i++) {
        const [name, p1] = readString(bytes, p);
        const kindByte = bytes[p1];
        const kind = KIND_NAMES[kindByte] ?? 'unknown';
        const [idx, p2] = readVarUint(bytes, p1 + 1);
        exportsList.push({ name, kind, index: idx });
        if (kind === 'memory') hasMemory = true;
        p = p2;
      }
    } else if (secId === 11) {
      // Data Section (linear memory initializers - richest source of embedded strings, URLs, keys)
      const dataSlice = bytes.slice(pos, secEnd);
      extractStringsFromBuffer(dataSlice, stringSet, endpointSet);
    }

    pos = secEnd;
  }

  // Scan entire WASM binary for high-value printable ASCII strings (fallback & custom sections)
  extractStringsFromBuffer(bytes, stringSet, endpointSet);

  const strings = [...stringSet].slice(0, 500);
  const endpoints = [...endpointSet].slice(0, 200);

  // Synthesize readable report
  let formatted = `// DeepScope WebAssembly Dissector\n// Module Version: ${version} · Sections: ${totalSections} · Imports: ${imports.length} · Exports: ${exportsList.length} · Strings: ${strings.length}\n\n`;

  if (imports.length) {
    formatted += `// --- IMPORTED HOST APIS & MODULES (${imports.length}) ---\n`;
    for (const imp of imports) {
      formatted += `(import "${imp.module}" "${imp.field}" (${imp.kind}${imp.typeIndex != null ? ` #type=${imp.typeIndex}` : ''}))\n`;
    }
    formatted += '\n';
  }

  if (exportsList.length) {
    formatted += `// --- EXPORTED FUNCTIONS & INTERFACES (${exportsList.length}) ---\n`;
    for (const exp of exportsList) {
      formatted += `(export "${exp.name}" (${exp.kind} #${exp.index}))\n`;
    }
    formatted += '\n';
  }

  if (endpoints.length) {
    formatted += `// --- DISCOVERED API ENDPOINTS & URLS IN WASM (${endpoints.length}) ---\n`;
    for (const ep of endpoints) {
      formatted += `//   - ${ep}\n`;
    }
    formatted += '\n';
  }

  if (strings.length) {
    formatted += `// --- EXTRACTED STATIC STRINGS & LITERALS (${strings.length}) ---\n`;
    for (const s of strings.slice(0, 150)) {
      formatted += `${JSON.stringify(s)}\n`;
    }
    if (strings.length > 150) {
      formatted += `// ... and ${strings.length - 150} more string literals\n`;
    }
  }

  return {
    version,
    imports,
    exports: exportsList,
    strings,
    endpoints,
    totalSections,
    hasMemory,
    formatted,
  };
}

/** Extracts printable strings and API paths from a byte buffer. */
function extractStringsFromBuffer(buf: Uint8Array, stringSet: Set<string>, endpointSet: Set<string>): void {
  const flush = (curr: number[]): void => {
    if (curr.length >= 4) {
      const s = String.fromCharCode(...curr).trim();
      if (s.length >= 4 && !/^[0-9.,;:+\-_/\\ ]+$/.test(s)) {
        stringSet.add(s);
        if (s.startsWith('/') || /^https?:\/\//i.test(s) || /^(api|graphql|v\d+)\//i.test(s)) {
          endpointSet.add(s);
        }
      }
    }
  };

  let curr: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // Printable ASCII chars (32..126)
    if (b >= 32 && b <= 126) {
      curr.push(b);
      if (curr.length > 256) curr.shift();
    } else {
      flush(curr);
      curr = [];
    }
  }
  flush(curr);
}

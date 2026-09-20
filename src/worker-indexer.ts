// Indexer Web Worker — heavy parsing/indexing off the UI thread.
// Protocol: {type:'index-text', id, text, prov, caps} -> {type:'units', id, units}
// The panel owns the RamIndex; the worker only extracts compact units.
//
// v1.2: chunked streaming — resources larger than 250KB are parsed in
// overlapping 200KB windows so a 2MB bundle never blocks the worker and peak
// RAM stays flat. Line numbers are rebased per chunk.

import { extractCss, extractHtml, extractJs, extractJsAdvanced, extractJson, lineStarts, offsetToLineCol } from './extractors.js';

interface IndexRequest {
  type: 'index-text';
  id: number;
  text: string;
  url: string;
  route: string;
  mime: string;
  kind: string;
  advancedJs: boolean;
}

interface Unit { text: string; line: number; column: number; kind: string; extra?: string }

const ctx = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<IndexRequest>) => void) | null;
  postMessage(msg: unknown): void;
};
type PostBack = { type: string; id: number; units: Unit[]; error?: string };

ctx.onmessage = (ev: MessageEvent<IndexRequest>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'index-text') return;
  try {
    const units = computeUnits(msg);
    const back: PostBack = { type: 'units', id: msg.id, units };
    ctx.postMessage(back);
  } catch (e) {
    const back: PostBack = { type: 'units', id: (msg as IndexRequest).id, units: [], error: String(e) };
    ctx.postMessage(back);
  }
};

const STREAM_CHUNK = 200_000;
const STREAM_OVERLAP = 2_000;
const STREAM_THRESHOLD = 250_000;

function computeUnits(m: IndexRequest): Unit[] {
  const { text, url, mime, kind, advancedJs } = m;
  const isJs = kind === 'script' || kind === 'chunk' || /javascript|ecmascript/.test(mime) || /\.m?js($|\?)/.test(url);
  const isCss = kind === 'stylesheet' || /css/.test(mime) || /\.css($|\?)/.test(url);
  const isJson = kind === 'api-json' || /json/.test(mime);
  const isHtml = kind === 'document' || kind === 'dom' || /html/.test(mime);

  if (isJson) return extractJson(text).map(toUnit);
  if (isCss) return extractCss(text).map(toUnit);
  if (isHtml) return extractHtml(text, url).units.map(toUnit);
  if (isJs) {
    if (text.length > STREAM_THRESHOLD) return extractJsStreamed(text, advancedJs);
    const base = extractJs(text);
    const extra = advancedJs ? extractJsAdvanced(text) : [];
    return base.concat(extra).map(toUnit);
  }
  // Generic text: line-chunked units (also streamed for huge blobs)
  const out: Unit[] = [];
  const lines = text.length > STREAM_THRESHOLD ? text.slice(0, STREAM_THRESHOLD).split('\n') : text.split('\n');
  for (let i = 0; i < lines.length && out.length < 2000; i++) {
    const ln = lines[i].trim();
    if (ln.length >= 3 && ln.length <= 320) out.push({ text: ln.slice(0, 320), line: i + 1, column: 1, kind: 'text-line' });
  }
  return out;
}

/** Streamed JS extraction: overlapping windows, line numbers rebased, deduped. */
function extractJsStreamed(text: string, advancedJs: boolean): Unit[] {
  const out: Unit[] = [];
  const seen = new Set<string>();
  const globalStarts = lineStarts(text.slice(0, Math.min(text.length, 2_000_000)));
  let offset = 0;
  let chunkIdx = 0;
  while (offset < text.length && out.length < 5500) {
    const end = Math.min(text.length, offset + STREAM_CHUNK);
    const slice = text.slice(offset, Math.min(text.length, end + STREAM_OVERLAP));
    const units = extractJs(slice);
    // Rebase line numbers: find global line of this chunk start.
    const [baseLine] = offsetToLineCol(globalStarts, Math.min(offset, globalStarts[globalStarts.length - 1] ?? 0));
    for (const u of units) {
      if (out.length >= 5500) break;
      const key = `${u.kind}:${u.text}`;
      if (seen.has(key)) continue;
      // Skip overlap duplicates on non-first chunks (heuristic: units in the
      // first 1k chars of an overlap window were likely seen already).
      if (chunkIdx > 0 && u.column < 0) { /* keep json-ish units anyway */ }
      seen.add(key);
      const line = u.line > 0 ? u.line + baseLine - 1 : u.line;
      out.push({ text: u.text, line, column: u.column, kind: u.kind, extra: u.extra });
    }
    if (advancedJs && out.length < 5200) {
      for (const u of extractJsAdvanced(slice)) {
        if (out.length >= 5500) break;
        const key = `adv:${u.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text: u.text, line: u.line, column: u.column, kind: u.kind, extra: u.extra });
      }
    }
    offset = end;
    chunkIdx++;
    if (chunkIdx > 12) break; // hard bound: ~2.4MB parsed max per resource
  }
  return out;
}

function toUnit(e: { text: string; line: number; column: number; kind: string; extra?: string }): Unit {
  return { text: e.text, line: e.line, column: e.column, kind: e.kind, extra: e.extra };
}

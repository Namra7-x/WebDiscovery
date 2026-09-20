// Incremental in-RAM index.
// Design: compact TextRecords + token->record postings + trigram postings +
// content-hash dedupe. Avoids duplicate raw/normalized/indexed copies: one
// `text` (original) and one `norm` per unique string; postings reference ids.

import { hashStr, normalize, trigrams } from './normalize.js';
import type { Provenance, TextRecord } from './types.js';

export interface IndexStats { records: number; tokens: number; indexBytes: number; indexedChars: number }

function tokenize(norm: string): string[] {
  // Split normalized alphanumerics into tokens len>=2; cap tokens/record.
  const toks: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.length >= 2 && cur.length <= 64) toks.push(cur);
    cur = '';
  };
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c > 127;
    if (alnum) { cur += norm[i]; if (cur.length > 64) flush(); }
    else flush();
  }
  flush();
  return toks.slice(0, 24);
}

export class RamIndex {
  records: TextRecord[] = [];
  /** token -> record ids (bounded postings) */
  postings = new Map<string, number[]>();
  /** char-trigram -> record ids (bounded; typo-tolerant prefilter) */
  triPostings = new Map<string, number[]>();
  /** dedupe: hash(norm + kind + url) -> record id */
  private seen = new Map<number, number>();
  private nextId = 0;
  indexBytes = 0;
  indexedChars = 0;

  get size(): number { return this.records.length; }

  add(text: string, prov: Provenance): number | null {
    if (!text || text.length < 2) return null;
    const t = text.length > 320 ? text.slice(0, 320) : text;
    const norm = normalize(t);
    if (norm.length < 2) return null;
    // Dedupe on the EXACT original string + resource: separator/case variants
    // (gpt-6 vs gpt6 vs GPT_6) are intentionally kept as distinct records so
    // the original is always preserved; normalized/fuzzy search reunites them.
    const key = (Math.imul(hashStr(t), 31) + hashStr(prov.resourceUrl)) >>> 0;
    const dupe = this.seen.get(key);
    if (dupe !== undefined) {
      const r = this.records[dupe];
      if (r && r.text === t) return null; // identical string from same resource
    }
    const id = this.nextId++;
    const rec: TextRecord = { id, text: t, norm, prov, len: t.length, hash: hashStr(t) };
    this.records.push(rec);
    this.seen.set(key, this.records.length - 1);
    this.indexedChars += t.length;
    // token postings
    const toks = tokenize(norm);
    for (const tok of toks) {
      let arr = this.postings.get(tok);
      if (!arr) { arr = []; this.postings.set(tok, arr); this.indexBytes += tok.length * 2 + 32; }
      if (arr.length < 500 && (arr.length === 0 || arr[arr.length - 1] !== id)) {
        arr.push(id);
        this.indexBytes += 4;
      }
    }
    // trigram postings (sampled for long norms to bound RAM)
    const tris = trigrams(norm);
    const step = tris.length > 32 ? Math.ceil(tris.length / 32) : 1;
    for (let i = 0; i < tris.length; i += step) {
      const tri = tris[i];
      let arr = this.triPostings.get(tri);
      if (!arr) { arr = []; this.triPostings.set(tri, arr); this.indexBytes += 6 + 32; }
      if (arr.length < 400 && (arr.length === 0 || arr[arr.length - 1] !== id)) {
        arr.push(id);
        this.indexBytes += 4;
      }
    }
    this.indexBytes += 96 + t.length * 1.2;
    return id;
  }

  /** Fast exact/substring candidate ids via token intersection + verification. */
  candidatesFor(queryNorm: string, cap = 4000): number[] {
    if (!queryNorm) return [];
    const qtoks = tokenize(queryNorm);
    if (qtoks.length === 0) {
      // Fall back: short query — scan tail for substring (bounded)
      return this.tailIds(cap);
    }
    // Intersect postings, rarest token first.
    const lists = qtoks.map((t) => this.postings.get(t)).filter((l): l is number[] => !!l);
    let cand: number[] = [];
    if (lists.length > 0) {
      lists.sort((a, b) => a.length - b.length);
      cand = lists[0].slice(0, cap);
      for (let i = 1; i < lists.length && cand.length > 0; i++) {
        const set = new Set(lists[i]);
        cand = cand.filter((id) => set.has(id)).slice(0, cap);
      }
    }
    // Prefix sweep: query token 'gpt6' must also match indexed tokens like
    // 'gpt6astra', so searching `gpt-6` recalls `gpt-6-astra`, `gpt6-preview`,
    // etc. Bounded (key scan + key match caps) to stay interactive per keystroke.
    if (cand.length < cap) {
      const have = new Set(cand);
      let keysScanned = 0;
      for (const qt of qtoks) {
        if (qt.length < 3 || cand.length >= cap) break;
        let matchedKeys = 0;
        for (const [key, ids] of this.postings) {
          if (++keysScanned > 30000 || matchedKeys >= 60 || cand.length >= cap) break;
          if (key.length > qt.length && key.startsWith(qt)) {
            matchedKeys++;
            for (const id of ids) {
              if (cand.length >= cap) break;
              if (!have.has(id)) { cand.push(id); have.add(id); }
            }
          }
        }
      }
    }
    // Trigram union: typo tolerance. A 1-typo query still shares most of its
    // trigrams with the true record, so union records with >=25% trigram
    // overlap. Fully bounded: posting slices + touched-id cap.
    if (cand.length < cap && queryNorm.length >= 3) {
      const have = new Set(cand);
      const qTris = trigrams(queryNorm).slice(0, 32);
      if (qTris.length >= 2) {
        const votes = new Map<number, number>();
        let touched = 0;
        for (const tri of qTris) {
          const ids = this.triPostings.get(tri);
          if (!ids) continue;
          const slice = ids.length > 200 ? ids.slice(ids.length - 200) : ids;
          for (const id of slice) {
            if (have.has(id)) continue;
            votes.set(id, (votes.get(id) ?? 0) + 1);
            if (++touched > 6000) break;
          }
          if (touched > 6000) break;
        }
        const need = Math.max(1, Math.floor(qTris.length * 0.25));
        const ranked: Array<[number, number]> = [];
        for (const [id, v] of votes) if (v >= need) ranked.push([id, v]);
        ranked.sort((a, b) => b[1] - a[1]);
        for (const [id] of ranked) {
          if (cand.length >= cap) break;
          cand.push(id);
          have.add(id);
        }
      }
    }
    if (cand.length < 20) {
      // widen with tail to let fuzzy stage find separator variants
      const have = new Set(cand);
      for (let i = this.records.length - 1; i >= 0 && cand.length < cap; i--) {
        if (!have.has(i)) { cand.push(i); have.add(i); }
        if (this.records.length - i > cap) break;
      }
    }
    return cand;
  }

  private tailIds(cap: number): number[] {
    const out: number[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < cap; i--) out.push(i);
    return out;
  }

  stats(): IndexStats {
    return { records: this.records.length, tokens: this.postings.size, indexBytes: Math.round(this.indexBytes), indexedChars: this.indexedChars };
  }

  clear(): void {
    this.records = []; this.postings.clear(); this.triPostings.clear(); this.seen.clear();
    this.nextId = 0; this.indexBytes = 0; this.indexedChars = 0;
  }
}

// DeepScope RAM-only retention budget.
// Unified hard budget across categories. Pure in-memory accounting; no I/O.

export type StoreCategory =
  | 'raw-bodies'
  | 'metadata'
  | 'index'
  | 'graph'
  | 'network'
  | 'pending'
  | 'buffers';

export type Pressure = 'ok' | 'tight' | 'full';

export interface StoreSnapshot {
  limit: number;
  total: number;
  byCategory: Record<StoreCategory, number>;
  pressure: Pressure;
  metadataOnly: boolean;
}

const CATEGORIES: readonly StoreCategory[] = [
  'raw-bodies',
  'metadata',
  'index',
  'graph',
  'network',
  'pending',
  'buffers',
];

function isCategory(cat: unknown): cat is StoreCategory {
  return (
    cat === 'raw-bodies' ||
    cat === 'metadata' ||
    cat === 'index' ||
    cat === 'graph' ||
    cat === 'network' ||
    cat === 'pending' ||
    cat === 'buffers'
  );
}

/** Tiny, prioritized categories that must never block discovery. */
function isAlwaysRetain(cat: StoreCategory): boolean {
  return (
    cat === 'metadata' ||
    cat === 'index' ||
    cat === 'graph' ||
    cat === 'network'
  );
}

function emptyByCategory(): Record<StoreCategory, number> {
  return {
    'raw-bodies': 0,
    metadata: 0,
    index: 0,
    graph: 0,
    network: 0,
    pending: 0,
    buffers: 0,
  };
}

/** Sanitize a byte count to a saturating non-negative finite number. */
function satBytes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export class CaptureStore {
  private limitBytes: number;
  private totalBytes: number;
  private byCat: Record<StoreCategory, number>;

  constructor(limitBytes: number) {
    this.limitBytes =
      typeof limitBytes === 'number' &&
      Number.isFinite(limitBytes) &&
      limitBytes > 0
        ? limitBytes
        : 0;
    this.totalBytes = 0;
    this.byCat = emptyByCategory();
  }

  setLimit(bytes: number): void {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
      return;
    }
    this.limitBytes = bytes;
  }

  /** Bodies/pending/buffers gated by remaining budget; metadata/index/graph/network ALWAYS true (tiny, prioritized — never block discovery). */
  canRetain(bytes: number, cat: StoreCategory): boolean {
    if (!isCategory(cat)) return false;
    if (isAlwaysRetain(cat)) return true;
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) return this.totalBytes <= this.limitBytes;
    if (bytes <= 0) return this.totalBytes <= this.limitBytes;
    if (!Number.isFinite(bytes)) return false;
    return this.totalBytes + bytes <= this.limitBytes;
  }

  add(cat: StoreCategory, bytes: number): void {
    if (!isCategory(cat)) return;
    const n = satBytes(bytes);
    if (n <= 0) return;
    this.byCat[cat] += n;
    if (!Number.isFinite(this.byCat[cat]) || this.byCat[cat] < 0) {
      this.byCat[cat] = Math.max(0, satBytes(this.byCat[cat]));
    }
    this.totalBytes += n;
    if (!Number.isFinite(this.totalBytes) || this.totalBytes < 0) {
      this.totalBytes = Math.max(0, satBytes(this.totalBytes));
    }
    // Clamp defensively (saturating, never negative).
    if (this.byCat[cat] < 0) this.byCat[cat] = 0;
    if (this.totalBytes < 0) this.totalBytes = 0;
  }

  release(cat: StoreCategory, bytes: number): void {
    if (!isCategory(cat)) return;
    const n = satBytes(bytes);
    if (n <= 0) return;
    const cur = this.byCat[cat];
    const dec = Math.min(cur, n);
    this.byCat[cat] = Math.max(0, cur - dec);
    this.totalBytes = Math.max(0, this.totalBytes - dec);
  }

  /** Absolute set for derived categories (index/graph/network/metadata), whose
   *  sizes are recomputed from live structures rather than added incrementally. */
  setCategory(cat: StoreCategory, bytes: number): void {
    if (!isCategory(cat)) return;
    const n = satBytes(bytes);
    const cur = this.byCat[cat];
    this.byCat[cat] = n;
    this.totalBytes = Math.max(0, this.totalBytes - cur + n);
  }

  snapshot(): StoreSnapshot {
    const limit = this.limitBytes;
    const total = this.totalBytes;
    let pressure: Pressure = 'ok';
    if (total >= limit) {
      pressure = 'full';
    } else if (limit > 0 && total >= limit * 0.8) {
      pressure = 'tight';
    }
    const byCategory: Record<StoreCategory, number> = {
      'raw-bodies': this.byCat['raw-bodies'],
      metadata: this.byCat.metadata,
      index: this.byCat.index,
      graph: this.byCat.graph,
      network: this.byCat.network,
      pending: this.byCat.pending,
      buffers: this.byCat.buffers,
    };
    // Keep unused-const guard meaningful without touching behavior.
    void CATEGORIES;
    return {
      limit,
      total,
      byCategory,
      pressure,
      metadataOnly: pressure === 'full',
    };
  }
}

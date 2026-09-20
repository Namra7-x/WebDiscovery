// RAM budgeting: estimate bytes, enforce caps, emit warnings.
// Everything is in-memory only; nothing here touches disk/storage.

export type BudgetAction = 'stop-capture' | 'discard-oldest-raw' | 'stop-deep-analysis';

export interface MemoryStats {
  rawBytes: number;
  indexedChars: number;
  indexBytes: number;
  records: number;
  resources: number;
  routes: number;
  requests: number;
  chunks: number;
  budgetMB: number;
  pct: number;
}

export class MemoryLedger {
  rawBytes = 0;
  indexedChars = 0;
  indexBytes = 0;
  records = 0;
  resources = 0;
  routes = 0;
  requests = 0;
  chunks = 0;
  budgetMB = 256;
  warned90 = false;

  setBudget(mb: number): void { this.budgetMB = mb; this.warned90 = false; }

  get budgetBytes(): number { return this.budgetMB * 1024 * 1024; }
  get usedBytes(): number { return this.rawBytes + this.indexBytes; }
  get pct(): number { return Math.min(999, (this.usedBytes / Math.max(1, this.budgetBytes)) * 100); }

  over(): boolean { return this.usedBytes >= this.budgetBytes; }
  nearLimit(): boolean { return this.pct >= 90; }

  /** Call after growth; returns 'warn' once when crossing 90%. */
  checkWarn(): 'warn' | 'over' | 'ok' {
    if (this.over()) return 'over';
    if (this.nearLimit() && !this.warned90) { this.warned90 = true; return 'warn'; }
    return 'ok';
  }

  stats(): MemoryStats {
    return {
      rawBytes: this.rawBytes, indexedChars: this.indexedChars, indexBytes: this.indexBytes,
      records: this.records, resources: this.resources, routes: this.routes,
      requests: this.requests, chunks: this.chunks,
      budgetMB: this.budgetMB, pct: Math.round(this.pct * 10) / 10,
    };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

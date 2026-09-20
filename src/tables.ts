// Pure table helpers for Resources / Network tabs — no DOM, no chrome APIs,
// so they stay tiny, testable, and cheap to call on every render.
// Dynamic filters are derived from LIVE data (never a hardcoded type list).

export type CountRow = { value: string; count: number };

/** Count occurrences of a derived key in one pass. Returns sorted desc rows. */
export function countBy<T>(items: Iterable<T>, keyFn: (t: T) => string): CountRow[] {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = keyFn(it) || 'other';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
}

/** Collapse a MIME type (+ URL fallback) into a small dynamic group. */
export function groupMime(mime: string | undefined, url: string): string {
  const m = (mime ?? '').toLowerCase();
  if (/json/.test(m)) return 'json';
  if (/javascript|ecmascript/.test(m) || /\.m?js($|\?)/i.test(url)) return 'js';
  if (/css/.test(m) || /\.css($|\?)/i.test(url)) return 'css';
  if (/html/.test(m)) return 'html';
  if (/image\/|png|jpe?g|gif|webp|avif|svg|ico/i.test(m + ' ' + url)) return 'img';
  if (/video\/|audio\/|mp4|webm|mp3|wav/i.test(m + ' ' + url)) return 'media';
  if (/font\/|woff2?|ttf|otf|eot/i.test(m + ' ' + url)) return 'font';
  if (/xml|csv|text\//.test(m)) return 'text';
  if (!m) return 'unknown';
  const slash = m.indexOf('/');
  return slash > 0 ? m.slice(0, slash) : m.slice(0, 24);
}

/** Distinct resource kinds present, with counts — drives the kind dropdown. */
export function resourceKindCounts(kinds: Iterable<string>): CountRow[] {
  return countBy(kinds, (k) => k);
}

/** Distinct MIME groups present in network entries, with counts. */
export function netGroupCounts(entries: Iterable<{ mime?: string; url: string }>): CountRow[] {
  return countBy(entries, (e) => groupMime(e.mime, e.url));
}

/** Distinct HTTP methods present, with counts — drives the method dropdown. */
export function netMethodCounts(methods: Iterable<string>): CountRow[] {
  return countBy(methods, (m) => (m || 'GET').toUpperCase());
}

/**
 * Build `<select>` options HTML from live counts. The `sig` lets the caller
 * skip DOM writes when nothing changed (keeps big-session renders smooth).
 */
export function optionsHtml(rows: CountRow[], current: string, allLabel: string): { html: string; sig: string } {
  const sig = rows.map((r) => `${r.value}:${r.count}`).join('|');
  const opts = [`<option value="ALL">${allLabel}</option>`];
  for (const r of rows) {
    const sel = r.value === current ? ' selected' : '';
    opts.push(`<option value="${escapeAttr(r.value)}"${sel}>${escapeHtml(r.value)} (${r.count})</option>`);
  }
  return { html: opts.join(''), sig };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

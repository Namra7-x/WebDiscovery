# Changelog

All notable changes to DeepScope. Dates are release dates (UTC).

## [3.8.2] — 2026-09-27

- Fixed universal replay failure (`TypeError: Failed to fetch`): the background fetch is CORS-unblocked only for granted origins, but nothing asked. Send now requests the origin grant with the click gesture and explains a decline inline; residual network failures name the likely causes (grant, certificate, VPN, offline host).

## [3.8.1] — 2026-09-27

- Fixed the APIs tab staying empty while other tabs filled: no capture path ever scheduled the APIs section for re-render (only full renders did), so the tab kept its initial empty state while on-demand export worked. All 15 data-arrival sites now schedule it.

## [3.8.0] — 2026-09-27

- Global fuzzy URL finder in the topbar: one query filters Routes, Resources, Network, and APIs together (substring fast path, trigram-fuzzy fallback). Composes with per-tab filters; Esc clears.

## [3.7.2] — 2026-09-27

- Copy URLs now prefixes the entry type on every tab (`kind url` for resources, `METHOD url` for called APIs, `kind url` for uncalled APIs), matching Network's long-standing format.

## [3.7.1] — 2026-09-27

- Wrap mode: the active table switches to full-width auto layout with the URL column claiming leftover space; meta columns stay capped one-liners.

## [3.7.0] — 2026-09-27

- Analyze shows finding values in full (no masking).
- Wrap mode hides Route/Body/Note columns so wrapped URLs own the width; toggle off restores them.
- Fixed clipped overflow-menu buttons in wide action columns.

## [3.6.0] — 2026-09-27

- Per-table Wrap toggles (Routes, Resources, Network, APIs): dense one-line rows by default, full wrapped text on demand.
- API inline detail opens with a full-URL header line.

## [3.5.0] — 2026-09-27

- Deeper API recall: responses that parse as JSON count as APIs even with a mislabeled mime type (bounded sniffing); wider uncalled-route markers (`/rest/`, `/ajax/`, `/rpc`, `/query`, `/gateway/`, bare `/api`).

## [3.4.0] — 2026-09-27

- `apiLike` accepts body-carrying writes (POST/PUT/PATCH/DELETE with a request body) without path markers.
- The APIs empty state diagnoses itself (request count, top mimes, marker mismatch, active filters).
- Per-row render guards so one malformed record can't stale the table.

## [3.3.0] — 2026-09-27

- Dense one-line table rows: fixed layout, ellipsis on data cells, fixed action columns, tighter padding. Full text remains in tooltips and opens on click.

## [3.2.0] — 2026-09-27

- Uncalled API rows support Replay (prefilled from discovery, explicitly labeled) and bare `curl` fallback. Routes renderer hardened per-row.

## [3.1.0] — 2026-09-27

- API detail restructured as a spec sheet: verdict strip with consolidated copy actions, sent/preview bodies and request/response headers side by side as definition rows.
- Replay modal grid and response command bar refinements.

## [3.0.0] — 2026-09-27

- New visual system (Strip Bay): sector status band with clearance lamp and live budget meter, ruled strip tables with end-label groups, gauge stats, capture timeline, full keyboard support for dialogs (focus take/trap/return). Zero functionality change.

## [2.1.0] — 2026-09-27

- Inline Replay on Network/API rows; labeled detail expanders; topbar live status; clickable filter chips writing DSL; confirmations on destructive actions; 80% budget pre-warning.

## [1.8.0] — 2026-09-27

- Row overflow menus and collapsible domain groups across Resources/Network/APIs; render-proof floating menu; 40px touch targets; full light/dark themes.

## [1.7.0] — 2026-09-26

- Per-request Replay (edit & resend), Mock responses, and Block rules.
- Deep Capture response bodies (opt-in CDP).
- Saved sessions (`.dsz`), OpenAPI 3.0 export, HAR 1.2 export/import.
- Filter DSL (`method:`, `status:`, `host:`, `mime:`, `has:`, `seen:`, wildcards) on all filter boxes.
- Requestly-style replay editor (params/headers/body tabs, key/value tables, pretty JSON responses).

## [1.6.0] — 2026-09-24

- Deep Capture engine (opt-in `chrome.debugger`, frames/workers/sockets), unified hard RAM retention budget with temporary session overflow, request identity/correlation, per-section rendering, storage budgets.

## [1.5.0] — 2026-09-23

- APIs tab (called + uncalled endpoints, kind classification, detail view, OpenAPI source data), domain grouping, sent-body capture, secret + exposure analysis.

## [1.4.0] — 2026-09-23

- Generic two-pass discovery (routes/endpoints/assets on any site), GraphQL/baseURL/param facets, Analyze tab with secret engine, rebuilt Routes tab.

## [1.3.0] — 2026-09-20

- Clickable resources with Sources-panel jump, content preview, traffic-driven filter dropdowns, clean `release/deepscope/` packaging.

## [1.2.0] / [1.1.0] — 2026-09-16…19

- Foundation: vendored zero-dependency search engine (exact/substring/normalized/regex/fuzzy), RAM index, worker extraction, provenance on findings, network filters.

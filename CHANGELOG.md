# Changelog

All notable changes to DeepScope. Dates are release dates (UTC).

## [3.12.0] — 2026-11-16

- **Framework Manifest Mining & Chunk De-anonymizer**:
  - Automatically parses Next.js `_buildManifest.js` (`self.__BUILD_MANIFEST`) and `_ssgManifest.js` (`self.__SSG_MANIFEST`), extracting 100% of routes and lazy-loaded chunk URLs.
  - Automatically parses Webpack runtime chunk-loading mappings (`__webpack_require__.u = function(e){...}`) to map every lazy-loaded `.chunk.js` file without requiring user navigation.
  - Supports Remix and Nuxt route trees; discovered routes and chunks are fed directly into the Routes tab, Discovery Graph, and Deep Scan queue.
- **AST Parameter & Payload Schema Mining**:
  - Analyzes client-side JavaScript calls (`fetch`, `axios.get/post/put/delete`, `$.ajax`) to extract expected query parameters, URL path variables, and JSON body keys.
  - The APIs tab detail card now displays an **Extracted AST Parameter Schema** showing exact query parameters and pre-formatted JSON payload templates.
  - The Replay modal automatically pre-populates request bodies using the extracted schema template for uncalled and discovered endpoints.
- **1-Click Source Map Project Decompiler & ZIP Exporter**:
  - Adds a 1-click **"Export Source ZIP"** button in the Resources tab.
  - Encodes all reconstructed `.map` source files into a standard PKZIP 2.0 archive with clean relative paths (`src/components/...`), standard CRC-32 checksums, and zero external dependencies.
  - Streams directly to disk via browser object URLs without persistent RAM overhead.
- **Client-Side Runtime State & Memory Harvester**:
  - Added an on-demand **"Harvest State"** engine in the Overview tab.
  - Deeply inspects in-memory state stores: Apollo Client cache (`__APOLLO_CLIENT__.extract()`), React Query / TanStack Query cache (`queryCache.getAll()`), Redux store (`store.getState()`), Next.js `__NEXT_DATA__`, and browser web storage.
  - Extracts user identities, roles (`isAdmin`, `role`), cached query endpoints, and auth tokens, automatically feeding secrets into the Analyze tab and routes into the APIs tab.
- **Client-Side Feature Flag & Entitlement Tamperer**:
  - Added a **"Tamper Feature Flags"** toggle in the Overview Interception card.
  - Intercepts client-side feature flag and experimentation responses (LaunchDarkly, Statsig, PostHog, Flagsmith, Unleash, and custom `/flags` / `/entitlements` endpoints).
  - Deep-traverses JSON responses on the fly to rewrite boolean `false` and `{ enabled: false, value: false }` flags to `true`, unlocking hidden admin panels and beta features in the live page.
- **GraphQL Operation Registry & Schema Synthesizer**:
  - Extracts all client-side GraphQL operations (`query`, `mutation`, `subscription`, `fragment`) and variable signatures from bundled JS code.
  - Added an **"Export GraphQL"** button in the APIs tab to download a clean, consolidated `deepscope-operations.graphql` file.
- **Ultra-Lightweight & Zero-Load Performance**:
  - Zero external runtime npm dependencies added.
  - All features strictly adhere to DeepScope's bounded `MemoryLedger` and `CaptureStore` retention budgets.
  - Package size remains ultra-compact (~600 KB total).
  - 56/56 automated smoke verification checks passed.

- **On-Demand Live Endpoint Response Output Fetching**:
  - When clicking "View" on any route or endpoint (from Routes, APIs, Network, or Search tabs), the Universal Viewer now actively retrieves and displays the **real response payload output** (e.g. live JSON, text, HTML) instead of falling back to empty cards or hex dumps of metadata.
  - Automatically resolves relative routes (e.g. `/api/v1/users`) against the session origin.
  - Executes live queries in the page context (`evalInPage`) with active cookies and credentials, preserving response payloads regardless of HTTP status (e.g. capturing 400/401/404/500 JSON error bodies).
  - Automatically falls back to background service-worker replay execution to bypass page CORS restrictions for third-party or sub-domain APIs.
  - Retrieved response bodies are automatically formatted in `[Formatted]`, exposed verbatim in `[Raw]`, hex-dumped in `[Hex Dump]`, and indexed into the universal search engine on the fly.
  - Added dedicated "Fetch Live" action button in the Viewer head bar and "Headers & Info" tab to re-query live endpoints at any time.
- **Universal Multi-Format Human-Readable Viewer**:
  - Multi-format preview modal with interactive tabs (`[Formatted]`, `[Raw]`, `[Preview]`, `[Hex Dump]`, and `[Headers & Info]`).
  - Supports all resource types with zero error messages: minified JS chunks, JSON/API payloads, compressed archives (Gzip streaming decompression, ZIP file table listing), HTML/XML/SVG, Audio player, Video player, Image previews (with transparency checkerboard), and pure binary/WASM hex dumps.
  - Lightweight, AST-less beautifier for JavaScript, JSON, CSS, and HTML with line numbering.
  - Graceful inspection cards for network endpoints with request/response headers, cURL generator, and Replay actions.
  - Object URL lifecycle management with automatic cleanup (`revokeObjectURL`) to eliminate RAM leaks.
- **Full-Spectrum API Response & Network Body Search Indexing**:
  - Universal search tab indexes reachable API response bodies, including JSON keys, strings, numeric/boolean scalars, JSON paths, composite `json-pair` units (e.g. `status: active`, `id: 101`), and NDJSON / Server-Sent Events (SSE) data streams.
  - Direct "View" button added to universal search result cards to jump straight into the Universal Viewer.
  - Automatic JSON structural sniffing in worker indexer for responses missing MIME types or mislabelled as `text/plain`.
  - Expanded API recognition covering GraphQL, RPC, REST, and versioned `/v\d+/` endpoints.
- **Lightweight & High Performance**:
  - Zero runtime dependencies, powered by native browser Web APIs.
  - Heavy parsing stays in the background Web Worker; release bundle remains ~560 KB.
  - 51/51 smoke verification checks passed.

## [3.10.0] — 2026-09-27

- Source-map reconstruction: original sources behind `.map` files are unpacked and indexed whether the map arrives via `sourceMappingURL` comment or is captured directly (once-guarded, recursion-proof, capped). Search now matches original names, comments, and config keys; the Resources Map column shows rebuilt counts (`yes·N`). Search pipeline itself unchanged.
- Verified: tsc clean, `verify.mjs` 46/46, manifest clean.

## [3.9.1] — 2026-09-27

- Analyze family filter: a Show dropdown (all findings / secrets / frameworks / security & headers) with live counts isolates each family; copy actions follow the visible view.

## [3.9.0] — 2026-09-27

- Framework fingerprinting: detects Next.js (incl. RSC/Flight + Server Actions), WordPress, Django, Rails, Laravel, Nuxt, SvelteKit, Astro, Firebase, Supabase, Stripe.js and more, with conditional CVE guidance (e.g. Next.js Flight RCE) that never asserts an unseen version.
- Security hygiene audit: missing/weak CSP, clickjacking, HSTS, open CORS with credentials, cookie flags, and info-disclosing headers.
- Fewer false-positive secrets: high-entropy fallback requires length, entropy, and mixed character classes; generic assignments reject short hex IDs; wider placeholder vocabulary. Real keys still fire.
- Verified: tsc clean, `verify.mjs` 45/45, manifest clean.

## [3.8.3] — 2026-09-27

- Routes rows carry the full action set (Open, View, inline Replay, overflow menu with Mock/Block/Copy/cURL). Replay prefills any discovered URL as a GET when no captured exchange exists.

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

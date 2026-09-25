# DeepScope — Memory / Change Log

> Session-scoped, RAM-only design — this file is the only on-disk history for tracking decisions across installs. Capture data itself is never written to disk.

---

## v1.6.3 — 2026-09-24 (Deep Capture attach fix + truthful meter)

- **Deep Capture ON fixed**: the error `Only permissions specified in the manifest may be requested` is a Chrome platform rule — `debugger` cannot be requested at runtime via `permissions.request`. Moved `debugger` to required manifest `permissions` (install-granted); the button now toggles the attach directly with busy label + inline status. NOTE: Edge will flag the permission change on reload — re-enable if prompted.
- **Meter fixed (was stuck at 0)**: two causes — (1) index/graph/network/metadata categories were never fed to the store (only raw bodies were), so with raw retention off the total was always 0; added `store.setCategory()` + `syncStoreDerived()` (index actual bytes, graph/nodes-edges and network/records estimates) so the meter is alive in every mode. (2) Stored old settings (`retainRaw:false`) override new defaults — bodies need the Settings toggle ON to be retained.
- Verified: tsc clean, `verify.mjs` 33/33 (new setCategory check), manifest clean, release ≈ 343KB.

---

## v1.6.2 — 2026-09-24 (home budget + unbreakable buttons)

- **Storage budget moved to Overview (home)**: preset dropdown (60/100/250/500/1024) + always-visible custom MB box + live `Retained X / Y MB · Remaining Z` line. Removed from Settings (hint left behind). Applies live, announced in diagnostics.
- **Grant + Deep Capture buttons fixed properly**: (1) all `wire()`/`buildSettings()` listener attachments converted to null-safe wiring — one stale/missing control can no longer kill every button after it; (2) busy labels (`Requesting…`, disabled) during async permission prompts; (3) results now appear INLINE in the Permissions card (`#permStatus`: granted/declined/failed + live ON state) instead of only as Overview diagnostics on another tab; (4) grant button reflects the real held permission on boot (`Site access: ON`); (5) render loop guarded so a render hiccup can never freeze the panel.
- Verified: tsc clean, 32/32, release ≈ 342KB, zero deps.

---

## v1.6.1 — 2026-09-24 (maximum sensible defaults)

- Defaults flipped to full power where Chrome allows: storageMB 250→**60**, retainRaw →**on**, advancedJsAnalysis →**on**, runtimeHook →**on** (arms automatically once site access is granted). Storage presets now 60/100/250/500/1024.
- Kept OFF (browser-forced): Deep Capture debugger attach + site-access grant — both need your click. Settings → Permissions card now carries a plain "For maximum discovery, 2 manual steps" notice naming exactly those two.
- retainBinary stays OFF (bytes, no discovery value). Verified: tsc clean, 32/32, release ≈ 336KB.

---

## v1.6.0 — 2026-09-24 (Deep Capture engine: CDP, budgets, correlation, evidence)

Built by 4 parallel subagents, zero file overlaps (S: store+idb · C: background+cdp · E: extractors/exposure/graph/worker/verify · P: panel+html+css+content), contracts fixed up-front in types.ts. All assumed shapes matched; full tsc clean, 32/32 verify, manifest clean, release ≈ 336KB, zero deps.

### Real Deep Capture (was permission-only, now works)
- `background.ts` + new `cdp.ts`: opt-in `chrome.debugger` attach (protocol 1.3) with ONLY Network domain + Target auto-attach (flatten); ≤25 tracked targets (page/iframe/worker/service-worker); compact event relay (req/res/fail/redirect/ws-frame) to the panel port; WS payloads sliced 4KB, 500/session cap; detach on stop/disconnect/tab-close with state events. Passive path never attaches. `btnDebugger` now toggles a real ON/OFF session with target counts in UI.

### Identity + correlation (URL never identifies a request)
- NetEntry/ResourceMeta carry reqId, frameId, targetId, workerKind, loaderId, redirects (≤5), protocol, timing, fromServiceWorker/fromCache. CDP events upsert by reqId (30s url+method fallback); devtools entries keep stable ids; WS handshakes + frame counts (32KB/url cap).
- Endpoint evidence map keyed `METHOD + path-template` ({id} for digits/UUIDs): static (file/line/via) + runtime (hook) + network (calls/methods/status) + source-map + worker sets. API rows show S/R/N×n/U badges; Called = calls>0 (known quirk: with Deep Capture on, devtools+CDP can double-count calls — Called status unaffected).

### Unified budget + temp IndexedDB (hard limit, no permanent DB)
- New `store.ts` CaptureStore: hard retention budget (settings.storageMB default 250; presets 50/100/250/500/1024 + custom 10–2048), categories raw-bodies/metadata/index/graph/network/pending/buffers; bodies gated, metadata always allowed; tight≥80%, full→metadata-only + one clear notice.
- New `idb.ts`: `deepscope-tmp` session overflow (bodies >64KB), never-throw, 5MB/put cap, recorded-length accounting; sessionId per boot; boot crash-GC of abandoned sessions; beforeunload + tab-close deletion. No chrome.storage/localStorage/cloud for captures.
- Storage UI: membar `Live ●/○ | Retained X / L MB · N req · M apis` + native expandable details (RAM/temp-disk/total/limit/remaining + per-category + temp-disk explainer), updated in existing render throttle. Settings: storage presets + max body KB + retainBinary + Advanced (concurrency 1–8, WS frames, runtime hook). Capture/render limits separated: budgets bound retention, Show All/Load More only render.

### Workers, backpressure, generations, rendering
- Deep Scan pool (settings.deep.concurrency, default 3) with per-job AbortController; worker in-flight cap 4 FIFO; source-map cap 8; sessionGen on worker posts/fetches/sourcemaps with stale-result drops; per-section dirty rendering (400ms) instead of render-all.
- Runtime hook (content.ts, opt-in via page flag): fetch/XHR/WS/EventSource/sendBeacon/history wrapped, batched findings piggyback existing content-batch (zero background changes).
- Extraction: priority tiers (endpoints/routes/imports first, identifiers last), OpenAPI/Swagger declared-endpoint parsing (`openapi:METHOD path declared`), AST-lite socket/router patterns, graph edgeKeys rebuilt on overflow, `isSubdomainOf` strict dot-boundary fix (evil-example.com no longer matches).

---

## v1.5.2 — 2026-09-23 (show-all everywhere rows were capped)

- **API tab**: per-group `Show all (N)` / `Show less` reusing the shared `grpShowAll` set (100 → 1000 rows); overflow rows point at it.
- **Analyze**: toolbar `Show all` toggle lifts the 150-row render cap → full bounded list (≤2000); subheaders + per-group copy keep working on the full slice.
- **Routes**: toolbar `Show all (N)` / `Show less` lifts the 300-row cap → 1200; count text states the cap.
- Search's 200-result limit deliberately untouched (per-keystroke path). Verified: tsc clean, 28/28, release ≈ 243KB.

---

## v1.5.1 — 2026-09-23 (group show-all, Analyze host sections, sent bodies)

Built by 2 parallel agents, no overlap (UI: panel.ts/html/css · core: types.ts/tables.ts/verify). All assumed shapes matched on landing.
- **Per-group Show-all** in Resources/Network: `Show all (N)` / `Show less` per domain section lifts the 100-row cap → 1000 (hard cap stays); default view unchanged and fast.
- **Analyze host sections**: findings subgrouped per website inside each severity group (collapsible, per-group Copy ≤100); severity order, caps, pill, counts unchanged.
- **Sent bodies**: `NetEntry.reqBody` captures POST `postData.text` (≤2000 chars, only when JSON capture on; ≈1.6MB worst case); API detail shows a "Sent body" block + Copy-sent; `snippetBody()` helper (tested) with guarded fallback.
- Verified: tsc clean, `verify.mjs` **28/28**, manifest clean, `release/deepscope/` ≈ 241KB, zero deps.

---

## v1.5.0 — 2026-09-23 (API tab + domain grouping + exposure engine)

Built by 3 parallel subagents, zero file overlaps (A: extractors.ts · B: rules.ts/exposure.ts/tables.ts/verify/check-manifest · C: panel.ts/panel.html/panel.css). Contracts fixed up-front; all assumed shapes matched on landing — zero integration conflicts.

### API tab (new, separate)
- `panel.ts/html/css`: **APIs** tab after Analyze — called API rows (method, URL, kind badge, status·mime) + uncalled API-like routes (`in code, not called`); expandable detail rows (req/res headers ≤12, auth/token badges, body preview ≤1500, lazy-rendered + cached); per-row Open/Copy/View/cURL; dynamic kind filter + counts + `cApis` pill.
- API kinds (`exposure.ts` `classifyApiKind`): REST, GraphQL, tRPC, gRPC-Web, JSON-RPC, SOAP, SSE, WebSocket, Other — ordered detection over URL+mime+body-start.

### API-type capture completeness
- `extractors.ts`: JSON-RPC `method` facets (JSON bodies + JS literals), SOAP actions/envelopes, SSE `event:` names, 6-pattern **sink** facets (`sink:eval` etc., cap 200, deduped) — all index-only facets sharing existing caps.
- Honest boundaries kept: gRPC-Web bodies stay metadata-only (protobuf binary); WebSocket *frames* still need the opt-in hook phase.

### Domain-grouped Resources/Network
- `tables.ts` `hostOf`/`groupByHost`; panel renders per-host collapsible sections (first-party first + expanded, third-party collapsed, toggles persist); header rows with counts, sizes, per-group **Copy URLs / Copy URLs+contents** (same 30×10KB/400KB bounds); 100 items/group cap; global buttons/filters/counts unchanged.

### Stronger secrets + exposure findings
- `rules.ts` 41→**50 rules**: `sk-proj-`, `ASIA`, Stripe test, Slack app tokens, password/private-token assignments, `x-api-key`, npm auth, **generic credential-assignment** (medium, FP-guarded) + **Shannon entropy** heuristic (≥4.7, medium) + **JWT `alg:none` → critical** via `decodeJwtAlg()`. Worker flow picks it all up automatically.
- New `exposure.ts` `findExposures()` (all from existing RAM data): exposed source maps (high), debug/admin endpoints (high), auth-in-URL (high), interesting params (medium), internal/staging domains (medium) — deduplicated, capped, rendered through existing Analyze severity groups.
- `verify.mjs` 21→**26 checks**. Release ≈ **232KB**, runtime deps still 0. `check-manifest.mjs` asserts `dist/exposure.js`.

---

## v1.4.2 — 2026-09-23 (flat Routes, fixed table columns)

- **Routes tab flat + full URLs**: indent removed entirely (was pushing nested routes right on route-heavy sites); first cell shows the complete URL, wrapping in place — entire URL always visible, full value also in tooltip.
- **Fixed table layouts** (`table-layout: fixed; width: 100%` on all three tables): Route column in Resources/Network capped at 130px with `…` ellipsis (was stretching the whole table even for `/`); small columns pinned (Type 92, Status 62, Actions 158/196, etc.); hover any truncated cell for the full text via new `title` tooltips on Type/Route/Via/Indexed/MIME/Note. `.table-wrap` scroll kept as narrow-panel fallback. Built by 2 parallel agents (CSS-only × renders-only, no overlap).
- Verified: tsc clean, `verify.mjs` 21/21, `release/deepscope/` ≈ 198KB.

## v1.4.1 — 2026-09-23 (table row fixes: ellipsis URLs, aligned Routes)

- **Resources/Network URL cells**: single-line with `…` ellipsis (`max-width` + `nowrap` + `text-overflow`), full URL kept in hover tooltip — rows no longer grow vertically. Applies to both tables.
- **Routes tab rebuilt as a real table**: Route | Seen | Via | Actions columns; hierarchy indent via cell padding (no more ragged `&nbsp;`); `×N` ("Seen") = times that route was observed this session, now explained in the tab header; full URL in link + tooltip; Open/Copy per row kept via existing delegation. Removed now-unused `routeDisplay()`.
- Verified: tsc clean, `verify.mjs` 21/21, manifest check clean, `release/deepscope/` ≈ 194KB.
- Plus (from user screenshots): W3C XML namespaces (`/1999/xhtml`, `/2000/svg`, `/1998/Math/MathML`) rejected in `looksLikeRoutePath()` — they polluted Routes on real sites (seen on arena.ai). Screenshots kept out of the repo.

## v1.4.0 — 2026-09-23 (64MB default + universal discovery batch + Analyze panel)

Built by 3 parallel subagents with strict file ownership (A: extractors.ts · B: rules.ts/tables.ts/verify/check-manifest · C: content.ts/panel.ts/panel.html/panel.css), contracts fixed up-front in types.ts, integrated + verified by lead. No file overlaps, no conflicts.

### 64MB budget (new default)
- `types.ts`: `budgetMB` union + `DEFAULT_SETTINGS` now **64MB** (was 256). UI list `panel.ts` → 64/128/256/512/1024. Ledger untouched (works in bytes) — same warn/stop policies.

### Universal discovery (all 9 MUST gaps)
- `extractors.ts`: `extractGraphql()` (named/anonymous ops, persisted sha256 hashes → `graphql-op` facet) · axios-style **baseURL join** (base path preserved, `via-base:` — fixed post-agent `new URL()` path-drop bug) · **param facets** from query strings · meta-tag/form-input/data-* URL facets · **tRPC** proc segments + input keys · **importmap** resolve (`HtmlFindings.importmap`) · inline JSON script blocks · `extractFrameworkRoutes()` (build/ssg manifests, `__NEXT_DATA__` pages, `__NUXT__` flag).
- `content.ts`: `manifests[]` (build/ssg manifest srcs → fetched as `manifest-ref`) + importmap links merged into discovery.
- `tables.ts` + rows: **Copy-as-cURL** per network row (pure `buildCurl`, quoted/escaped, capped).
- Routes tab rebuilt: full absolute links, Open/Copy per row, Copy-all (≤1000), text filter, `shown` counter.
- `verify.mjs` 13→**20 checks** (graphql, baseURL, params, importmap/meta, tRPC, curl+severity, secrets).

### Analyze tab (security/criticality)
- New `rules.ts`: **41 high-precision secret rules** (cloud keys, tokens, JWT, private keys, connection strings) + `isPlaceholder()` FP guard + `scanTextForSecrets()` (len-gated, capped). Runs in **worker** at ingest (first hit attached as `sec`), panel fallback covered too.
- Panel: `secFindings` snapshots (text+prov, cap 2000, drop-counted) grouped critical/high/medium/info with plain-language blurbs, Open/Copy per finding, Copy-findings (≤100), `cAnalyze` pill, Settings `setSecrets` toggle (`analyzeSecrets`, default on).
- RAM impact: findings ≈32B each (IDs, no text dup); rules static ~6KB; new facets share the existing 6000-unit cap. Release `release/deepscope/` ≈ **194KB**, runtime deps still 0.
- Deliberately NOT built: bulk active probing, 1600-rule dragnet, dataflow analysis, WS/replay (opt-in phase).

### UI legibility pass
- One-line muted explainers atop Search/Routes/Resources/Network/Analyze tabs; severity badge colors; viewer hotfix lineage kept. `manifest.json`/`package.json`/export stamp → 1.4.0. `check-manifest.mjs` asserts `dist/rules.js`.

---

## v1.3.0 — 2026-09-20 (Resources/Network URL flexibility + dynamic filters)

### Hotfix (same day): preview modal couldn't be dismissed- Root cause: CSS specificity — `.viewer { display:flex }` is defined AFTER `.hidden { display:none }` with equal specificity, so the hide rule never won. The overlay stayed on screen and Close appeared dead.
- Fix: `panel.css` `.viewer.hidden { display:none; }` (0,2,0 beats 0,1,0); added explicit `✕` button (`#viewerX`); all dismiss paths (Close / ✕ / backdrop / Esc) funnel through one `closeViewer()` helper; viewer wiring moved to the TOP of `wire()` via null-safe `on()` helper so a stale `panel.html` can never half-attach listeners and kill dismissal; `clearSession()` now closes the modal too. Rebuilt + repackaged (`release/deepscope/` ≈ 154.5 KB).

### What changed
- **Resources URLs are links**: URL cell is a clickable `<a>` (Sources-panel `openResource` jump, new-tab fallback) plus per-row **Open / Copy / View** buttons (event-delegated, one listener per table).
- **Content preview**: shared `#viewer` modal — shows retained raw body when present, else on-demand same-origin fetch via page eval (20 KB truncation), with Open/Copy/Close + Esc/backdrop close. Binary/media/fonts and cross-origin show an honest note instead of pretending.
- **Bulk copy**: `Copy URLs` (filtered, ≤1000 lines) and `Copy URLs + contents` (filtered, ≤30 items × 10 KB, ≤400 KB total) on both tabs; clipboard-denial falls back to a diagnostic.
- **Dynamic filters, never hardcoded**: new pure `src/tables.ts` (`countBy`, `groupMime`, `resourceKindCounts`, `netGroupCounts`, `netMethodCounts`, `optionsHtml` with change-signature). Resources kind dropdown + Network method/MIME-group dropdowns rebuild from LIVE counts only when the signature changes (no DOM churn). Method list is now observed-traffic-driven too.
- **Efficiency kept**: single-pass filters with 1200-item pre-cap, 300/250 row render caps, `shown X of Y` counters, zero new deps.
- **Edge 25 MB story**: verified `release/deepscope/` = 25 files ≈ 154 KB (`node_modules` typescript dev-only, never shipped). Added `.gitignore` (`node_modules/`, `dist/`, `release/`) and ran `git init` (no commits yet — say the word and I'll commit). Load unpacked → `release/deepscope/`, never repo root.
- `manifest.json` + `package.json` → 1.3.0; `panel.ts` export stamp → 1.3.0; `scripts/verify.mjs` 13/13 (new #13 covers tables helpers); `scripts/check-manifest.mjs` now asserts `dist/tables.js`.

### Files touched
- new `src/tables.ts`; `panel.html` (dynamic selects, copy buttons, counts, Actions cols, `#viewer` modal); `panel.css` (link/buttons/viewer + light theme); `src/panel.ts` (state `resType/netKind` + sigs, filtered/sync/render fns, open/copy/view actions, viewer wiring, clearSession reset); `scripts/verify.mjs` (#13); `scripts/check-manifest.mjs` (`dist/tables.js`); `.gitignore` (new).

---

## v1.2.0 — 2026-09-19 (this session — all v1.1 pending items DONE)

### Build
- `manifest.json` 1.2.0. `npm run build` clean, `scripts/verify.mjs` 12/12, `scripts/check-manifest.mjs` no external refs. Dev deps only: `typescript 5.6.3`, `@types/chrome 0.0.280`. Runtime deps = 0 (nothing to remove).
- Verified release payload: `node scripts/package.mjs` → `release/deepscope/` ≈ 0.14 MB (manifest + html/css + `dist/` + `icons/`). `dist/panel.js` ~50 KB. The "25 MB" was repo-folder total (`node_modules` typescript dev compiler, never shipped).

### 1. Bundle size — FIXED
- Reality confirmed: `typescript` 22.5 MB in `node_modules` is dev-only. Installed payload was always ~0.12 MB.
- Fix: new `scripts/package.mjs` builds a clean `release/deepscope/` folder (only runtime files). README + memory updated: **Load unpacked → `release/deepscope/`**, never repo root. No code bloat, no new deps.

### 2. Route/API discovery in chunks/assets/bundles — FIXED (two-pass scan)
- `src/extractors.ts`: new `collectLiterals()` O(n) state-machine (all `'`, `"`, `` ` `` incl. `${}` splits) + `collectConcatenated()` (`"/api/"+"models"` joins) + generic `classifyPath()` / `isApiEndpoint()` / `looksLikeRoutePath()`. NO hardcoded prefix list — any `/…` path on any site is classified; `/api/*`, `/v1/*`, `/graphql`, `/trpc`, `/rest/*` → `endpoint`, everything else path-like → `route`, asset extensions → `asset-ref`. Absolute URLs also contribute their pathname. `extractJson` double-emits route/endpoint facets for path-like JSON strings.
- `src/panel.ts` `commitUnits()`: feeds `url|endpoint|route|asset-ref|fetch-target|*-import|dom-link|css-*` into `considerDiscoveredUrl()`; `considerDiscoveredUrl()` registers bare `/…` route/endpoint facets as first-class `route:` graph nodes + `routes` entries immediately. Deep Scan `pumpScan()` drains the `discoveredUrls` queue each page (routes → queue, js/css → `fetchViaPage`, `/api/` → `fetchViaPage` when `captureApis`).
- Regression: `scripts/verify.mjs` #9 asserts `/api`, `/api/models`, `/v1/chat/completions`, `/graphql`, `/dashboard/settings`, concat + template routes all found.

### 3. Search — MUCH MORE POWERFUL (vendored, zero-dep, uFuzzy-class)
- `src/fuzzy.ts`: rewritten — exact/prefix/infix fast paths + boundary bonuses + subsequence contiguity + **Damerau-Levenshtein ≤2 sliding-window typo tolerance** (substitution/omission/insertion/transposition) + `fuzzyMatch()` returning **spans**. Removed dead `rankFuzzy`.
- `src/normalize.ts`: removed dead `normalizeLoose`; added `normalizeWithMap()` (norm→orig index map for exact highlight), `trigrams()`, `snippetWithSpans()` (orig-space multi-`<mark>` context).
- `src/indexer.ts`: added bounded `triPostings` (char-trigram → ids, 400/posting, sampled 32/record) + trigram-union stage in `candidatesFor()` (≥25% trigram overlap, touched-cap 6000) for typo recall at scale. Token postings + prefix sweep kept.
- `src/search.ts`: fuzzy stage uses `fuzzyMatch` + `snippetWithSpans` so highlights are exact even on fuzzy/typo matches; `marks: [start,end][]` added to `SearchResult` (`types.ts`); `displayNameFor()` clean-title helper; exact/substring/normalized/regex kept as explicit modes with single-span marks.
- `src/panel.ts` `indexUrlAndHeaders()`: URL + req/res headers now indexed (header scopes previously matched nothing). `src/worker-indexer.ts`: chunked streaming (200 KB windows + 2 KB overlap, line rebased, ~2.4 MB hard bound) so huge bundles never block.
- Regression: `scripts/verify.mjs` #10 (transposition/typo scores + spans), #11 (typo `gpt-6-atsra` recalls `gpt-6-astra-model` under 3k noise + marks/context), #12 (`displayNameFor`).

### 4. Results UX — clean name + provenance + highlight + click-to-open — DONE
- `src/panel.ts` `runSearch()`: each hit = score badge + clean single-line title (`displayNameFor`, full text in tooltip) + **Open ↗** button + multi-`<mark>` context (`renderHighlighted`) + provenance subtitle `kind/detail badge • host/path • route • via method • L:line:col • initiator • JSON-path badge`. `sourceLabel()` = host + short path. Row click (without text selection) also opens.
- `openSource()`: `chrome.devtools.panels.openResource(baseUrl, line)` (Sources panel, line-accurate; `#frag` stripped for sourcemap `#orig.ts` records) with `window.open` fallback. Wired via delegation in `wire()`. `panel.css`: `.badge`, `.open`, `.ctx-line`, hover border, light-theme badge colors.

### 5. Optimization — DONE
- Kept: compact records, token cap 500/id (trigram 400), `contentHash` dedupe, incremental indexing, 60 ms Deep Scan yield, no raw/norm duplicate copies, binary meta-only. Added: worker chunked streaming, trigram sampling, bounded votes/touched caps, `discoveredUrls` batch drain (200/page), result limit 200/500.
- Removed dead code: `normalizeLoose`, `rankFuzzy`, `MemoryLedger.estimateRecordBytes`. No new npm deps (vendored matcher is hand-rolled in `fuzzy.ts`, no CDN, no `acorn` needed — state-machine covers the surface; `advancedJsAnalysis` toggle kept).

### 6. Dependencies — DONE
- Runtime deps still 0. No React/Redux/Next/Express/Electron/Playwright/Puppeteer. No external fetches. Powerful search is vendored locally per prompt allowance; unused modules removed.

---

## v1.1.0 — 2026-09-16

### Build
- `manifest.json:2` bumped to 1.1.0. Local `npm run build` via `./node_modules/typescript/bin/tsc -p tsconfig.json` → `dist/` (14 files, 94 KB). `scripts/gen-icons.mjs` generates `icons/icon{16,32,48,128}.png` with no CDN.
- Verified: `npm run build` clean, `scripts/verify.mjs` 7/7, `scripts/check-manifest.mjs` no external refs. Dev deps only: `typescript 5.6.3`, `@types/chrome 0.0.280`.

### Features shipped
- **Theme**: `panel.html:8` top-bar `◐ Light` toggle, `panel.css:22` `body[data-theme="light"]`, `panel.ts:412` `applyTheme()`, persisted as `types.ts:34` `SessionSettings.theme`.
- **Network filters**: `panel.html:41` method dropdown (ALL/GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) + URL/MIME text filter, wired in `panel.ts:220` `renderNetwork()`.
- **Graph explainer**: `panel.html:54` provenance map description (route → chunk → endpoint, edge = DiscoveryMethod).
- **Routes visibility fix**: `panel.ts:245` `discoverRoutesNow()` eval collects same-origin `<a href>` + `window.__deepscope_crawl` on open; `panel.ts:358` seeds Deep Scan queue routes into `routes` immediately; `panel.html:38` `Discover page links` button + `routeStatus` line.

### Search
- Staged pipeline `search.ts:18` (token postings → normalized → `fuzzy.ts:8` `fuzzyScore` → regex bounded 60k).
- Fix: `indexer.ts:48` prefix-token sweep so `gpt-6` fuzzy recalls `gpt-6-astra` beyond 4k tail. `indexer.ts:18` dedupe now on exact original `text + url` so `gpt-6`/`gpt6`/`GPT_6` are distinct searchable records (original preserved). Regression at `scripts/verify.mjs:66`.

### Memory / capture model (unchanged)
- `MemoryLedger:16` budgets 128/256/512/1024 MB, `indexer.ts:18` compact `TextRecord` + postings, `worker-indexer.ts:1` off-thread extraction, `contentHash` dedupe, `maxResponseBytes/maxIndexedChars` caps. `background.ts:14` metadata-only relay (no bodies). Raw/index lives in `panel.ts:122` heap, cleared with `panel.ts:320` Clear.

### Permissions
- Base: `activeTab, scripting, webNavigation, webRequest, storage`. Optional: `debugger`, `<all_urls>` (Grant site access per-origin via `panel.ts:440`).

---

## How to reload in Edge (unpacked)
1. `edge://extensions` → Developer mode → DeepScope card → Reload ⟳ (point it at `release/deepscope/` once; Resolved from v1.2 packaging fix)
2. Reload inspected site tab → F12 → DeepScope panel
3. Re-select folder only if extension was removed or folder moved.

---

## GitHub — pushed 2026-09-20- Remote `origin` = `https://github.com/Namra7-x/WebDiscovery.git` (was empty; pushed `master` → `25110bc`, 36 files, source only — `node_modules/`, `dist/`, `release/` gitignored and rebuilt via `npm install` + `npm run build` + `node scripts/package.mjs`).
- README made GitHub-ready: clone URL, project structure map, consistent ~0.15 MB payload note.

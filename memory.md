# DeepScope — Memory / Change Log

> Session-scoped, RAM-only design — this file is the only on-disk history for tracking decisions across installs. Capture data itself is never written to disk.

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

## GitHub — pushed 2026-09-20
- Remote `origin` = `https://github.com/Namra7-x/WebDiscovery.git` (was empty; pushed `master` → `25110bc`, 36 files, source only — `node_modules/`, `dist/`, `release/` gitignored and rebuilt via `npm install` + `npm run build` + `node scripts/package.mjs`).
- README made GitHub-ready: clone URL, project structure map, consistent ~0.15 MB payload note.

# DeepScope — RAM-only Web App Discovery & Universal Fuzzy Search

Production-quality Chromium (MV3) extension, no backend, no database, no persistent
capture storage, zero runtime dependencies. TypeScript + native extension APIs +
plain HTML/CSS UI + a Web Worker for heavy parsing/indexing.

## What it does

Open a site, open DevTools → **DeepScope**, and it indexes the browser-visible
surface: DOM text, links/forms/scripts, JS bundles + lazy chunks, CSS + asset refs,
source maps (minified → original provenance), manifests, iframes, SPA routes and
transitions, XHR/fetch, request/response metadata, API JSON (with JSON paths), and
other textual resources. Every finding keeps provenance, e.g.

- `gpt6cb% → assets/asse099r9.js → route /models → via dynamic-import → line 18421`
- `gpt_6_model → GET /api/models → JSON path models[4].name`

Search modes: **exact · substring · normalized · regex · fuzzy**. Normalization
folds case/separators (`gpt-6` matches `gpt6`, `GPT_6`, `gpt6cb%`, …) while the
original string + location are always preserved. Fuzzy mode is typo-tolerant
(transposition/omission/substitution ≤2, e.g. `modles` ~ `models`) with exact
`<mark>` highlights even on fuzzy matches.

Click any result (or its **Open ↗** button) to jump to the exact source —
Sources-panel `openResource` when available, new tab otherwise.

## Architecture

```
DevTools panel (panel.ts) ......... SESSION OWNER, all state in RAM
 ├─ chrome.devtools.network ....... primary body capture (getContent/HAR)
 ├─ inspectedWindow.eval ........... DOM/route snapshot + same-origin fetch (no extra perms)
 ├─ background port ................ nav/route + webRequest metadata relay
 ├─ content script (content.ts) .... passive DOM/Mutation/SPA observer (per-origin, on grant)
 ├─ worker-indexer ................. chunked-streaming extraction off UI thread
 ├─ RamIndex / search ............... token + trigram postings → staged exact→norm→fuzzy→regex
 ├─ MemoryLedger .................... budgets, live accounting, on-budget policies
 └─ DiscoveryGraph .................. route→resource→chunk→endpoint edges + method
background.ts ...................... metadata-only relay (NO bodies; suspend-safe)
content.ts ......................... passive observer, batches to panel via relay
```

Staged search: token-index candidates (+ prefix sweep + trigram union for typos)
→ normalized match → typo-tolerant fuzzy rank on the reduced set only → regex as
an explicit bounded mode. JS/CSS/HTML/JSON are reduced to compact searchable
units (URLs, generic routes, endpoints, imports, fetch targets, string literals,
identifiers, CSS refs, JSON key/value+path) instead of fuzzy-scanning MB blobs.
JS bundles get a **two-pass literal scan**: every string/template literal plus
`"a"+"b"` concatenations are classified as route/endpoint/asset, so `/api`,
`/api/models`, `/v1/…`, `/graphql` and SPA routes on ANY site are found even
when hidden in minified chunks. AST parsing stays regex/state-machine by
default; a deeper scanner runs only with **Advanced JS analysis** on.

## Permissions (minimal, sensitive = opt-in)

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | programmatic per-origin content observer after **your** grant |
| `webNavigation` | navigation/frame/SPA-route tracking (metadata) |
| `webRequest` | broader request metadata (no bodies in SW); needs host grant to see traffic |
| `storage` | **settings only** (`deepscope-settings`); captures never touch storage |
| `debugger` (optional) | reserved for CDP Deep Capture, explicit opt-in, shows Chrome banner |
| `<all_urls>` (optional host) | requested per-origin via **Grant site access**; base capture works without it |

Privacy: 100% local processing, no network exfiltration, no telemetry.
Session data lives in the panel's JS heap and dies with DevTools. Export writes a
file only when you click **Export JSON**.

## Getting started (clone → build → load)

```powershell
git clone https://github.com/Namra7-x/WebDiscovery.git
cd WebDiscovery
npm install                  # dev-only tooling (typescript + chrome types), never shipped
node scripts/gen-icons.mjs   # generate icons/ locally (no CDN)
npm run build                # tsc src/ -> dist/
node scripts/package.mjs     # -> release/deepscope/ (~0.15 MB, the ONLY folder Chrome loads)
```

Requirements: Node 18+. No global `npm i -g`, no CDN, no bundler;
`tsc` compiles `src/` → `dist/` as native ES modules. Runtime deps = 0.

## Package size (the "25 MB" note)

`node_modules` (~23 MB, `typescript` dev compiler only) is NOT part of the
extension. Installed payload is `release/deepscope/` = manifest + html/css +
`dist/` + `icons/` ≈ **0.15 MB**. Always **Load unpacked → `release/deepscope/`**,
never the repo root. `scripts/package.mjs` builds that clean folder; there is
no CDN, no bundler, no framework.

## Load in Chromium

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `release/deepscope/`.
2. Open any site → `F12` → **DeepScope** tab.
3. Browse (passive capture) or click **Deep Scan** (bounded, same-origin default;
   follows JS-discovered routes/endpoints/chunks too).

## Resources / Network flexibility

- Every URL is a **clickable link** (Sources-panel jump when possible, new tab otherwise).
- Per-row **Open / Copy / View**: copy a single URL or preview its content (retained
  body first, on-demand same-origin fetch otherwise, 20 KB truncation; binary and
  cross-origin cases say so honestly).
- Toolbar **Copy URLs** (filtered, ≤1000) and **Copy URLs + contents** (filtered,
  ≤30 items × 10 KB) on both tabs.
- **Dynamic filters**: resource-kind, request-method, and content-type dropdowns are
  built live from captured traffic with counts — never a fixed list. Renders stay
  capped (300/250 rows) with `shown X of Y` counters.

## Project structure

```
manifest.json ......... MV3 manifest (minimal perms, sensitive caps opt-in)
panel.html / panel.css  DevTools panel UI (Overview, Search, Routes, Resources, Network, Graph, Settings)
src/panel.ts .......... session owner — capture state, search UI, Deep Scan (RAM-only)
src/extractors.ts ..... two-pass JS literal scan (routes/endpoints/assets in bundles)
src/indexer.ts ........ compact RamIndex (token + trigram postings, hash dedupe)
src/search.ts ......... staged pipeline: exact → normalized → typo-tolerant fuzzy → regex
src/fuzzy.ts .......... vendored zero-dep matcher (Damerau-Levenshtein ≤2 + spans)
src/tables.ts ......... pure Resources/Network helpers (dynamic filters, mime groups)
src/worker-indexer.ts . chunked-streaming extraction off the UI thread
src/background.ts ..... metadata-only relay (no bodies, suspend-safe)
src/content.ts ........ opt-in per-origin DOM/SPA observer
scripts/ .............. verify.mjs (13 checks) · check-manifest.mjs · package.mjs · gen-icons.mjs
memory.md ............. session change log (decisions across installs)
```

## Controls

Pause/Resume · Clear session · Recapture/reload · Deep Scan start/stop · Reindex ·
Memory cleanup · Export JSON (explicit) · per-category capture toggles · budgets
128/256/512/1024 MB · max response/indexed size · max resources · retain-raw ·
source-map + advanced-JS + binary-meta switches · on-budget policy
(stop-capture / discard-oldest-raw / stop-deep-analysis) · light/dark theme toggle ·
Network method (GET/POST/…) + text filters · one-click Routes discovery from page links.

## Limitations (reported in-app, not hidden)

- Only what the browser actually received is searchable — never server-side code.
- Cross-origin bodies/maps need **Grant site access**; failures get diagnostics.
- `chrome.storage` holds settings only; with *retain raw* off, **Reindex** needs recapture.
- SW suspension: background keeps counters/metadata only; the panel is the source of truth.
- Regex over huge indexes scans newest-first with a 60k-record bound for interactivity.
- Binary/media/fonts are metadata-only by default (never copied into the index).

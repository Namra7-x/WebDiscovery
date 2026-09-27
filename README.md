# DeepScope — RAM-only Web Discovery, Search & Replay

A production-quality Chromium (MV3) DevTools extension for mapping a site's real attack surface: routes, resources, network traffic, API endpoints, and leaked secrets. No backend, no database, no persistent capture storage, **zero runtime dependencies**. TypeScript + native extension APIs + plain HTML/CSS UI + a Web Worker for heavy parsing/indexing.

## What it does

Open a site, open DevTools → **DeepScope**, and it indexes the browser-visible surface: DOM text, links/forms/scripts, JS bundles + lazy chunks, CSS + asset refs, source maps (minified → original provenance), manifests, iframes, SPA routes and transitions, XHR/fetch, request/response metadata, API JSON (with JSON paths), and other textual resources. Every finding keeps provenance, e.g. `GET /api/models → JSON path models[4].name → via devtools-network`.

**Discover** — generic two-pass scan finds routes, endpoints, and assets on any site (no prefix lists): string literals, templates, concatenation, GraphQL ops, baseURL joins, params, import maps, tRPC facets. Called endpoints are classified (REST, GraphQL, tRPC, gRPC-Web, JSON-RPC, SOAP, SSE, WebSocket); API-like routes seen in code but never requested are listed as uncalled.

**Search** — exact · substring · normalized · regex · fuzzy. Normalization folds case/separators (`gpt-6` matches `gpt6`, `GPT_6`, …) while the original string + location are always preserved. Fuzzy mode is typo-tolerant with exact `<mark>` highlights. A topbar finder filters Routes, Resources, Network, and APIs by URL simultaneously.

**Act** — every Network/API row offers **Replay** (edit & resend with real cookies), **Mock** (canned responses), and **Block** rules, plus copy-as-cURL. Deep Capture pulls response bodies so worker/service-worker/iframe traffic is searchable too.

**Keep & share** — explicit **Save/Open session** (single `.dsz` file, RAM-only by default), **openapi.json** generation from observed traffic, and standard **HAR 1.2** export/import (Burp/Charles/Chrome-compatible).

**Filter** — all filter boxes accept a small DSL: `method:POST status:>=400 host:api.* has:auth -mime:image`. Plain text keeps working as substring search. Clickable chips write the syntax for you.

## Privacy

100% local processing, no network exfiltration, no telemetry. Session data lives in the panel's JS heap and dies with DevTools. Files are written only when you click export (JSON / `.dsz` / openapi.json / HAR). Interception rules live in `chrome.storage.session` and vanish when the browser closes. Settings only in `chrome.storage` — captures never touch it.

## Permissions (minimal, sensitive = opt-in)

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | per-origin content observer, only after your grant |
| `webNavigation` | navigation/frame/SPA-route tracking (metadata) |
| `webRequest` | broader request metadata (no bodies in the worker); needs host grant to see traffic |
| `storage` | **settings only**; captures never touch storage |
| `debugger` (required) | Deep Capture attach, strictly toggled by you — shows a tab banner while ON. Chrome forbids requesting `debugger` at runtime, so it is install-granted; the button only toggles capture, never auto-attaches |
| `<all_urls>` (optional host) | requested per-origin via **Grant site access**; base capture works without it |

## Getting started (clone → build → load)

```powershell
git clone https://github.com/Namra7-x/WebDiscovery.git
cd WebDiscovery
npm install                # dev-only tooling (typescript + chrome types), never shipped
npm run build              # tsc src/ -> dist/
npm run verify             # 42-check test suite
node scripts/package.mjs   # -> release/deepscope/ (the ONLY folder the browser loads)
```

Requirements: Node 18+. No global installs, no CDN, no bundler — `tsc` compiles `src/` → `dist/` as native ES modules. Runtime dependencies: **0**.

## Package size

`node_modules` (~23 MB, the `typescript` dev compiler + type definitions) is **not** part of the extension. The installed payload is `release/deepscope/` — manifest + HTML/CSS + `dist/` + `icons/` ≈ **0.45 MB**. Always **Load unpacked → `release/deepscope/`**, never the repo root. `scripts/package.mjs` builds that clean folder deterministically (it refuses to finish without `dist/panel.js`).

## Load in Chromium

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `release/deepscope/`.
2. Open any site → `F12` → **DeepScope** tab.
3. Browse (passive capture), grant **site access** for cross-origin bodies, toggle **Deep Capture** for frame/worker/socket detail, or run **Deep Scan** (bounded, same-origin default).

## Features

- **Overview** — live storage meter, capture timeline, session controls (Recapture, Reindex, Memory cleanup), interception rule list, diagnostics.
- **Search** — universal fuzzy search with scope chips and exact highlights.
- **Routes** — every observed route with seen-counts, filters, copy/export.
- **Resources / Network** — per-host collapsible sections, Open/View/Replay/⋯ actions, typed copy lines, traffic-driven filters, Wrap mode for full URLs.
- **APIs** — called + uncalled endpoints with spec-sheet detail (auth, sent body, headers, preview); Replay/Mock/Block per row; OpenAPI export.
- **Analyze** — secret engine (credential assignments, entropy heuristic, JWT `none`-algorithm detection) + exposure findings (open source maps, sensitive endpoints, auth-in-URL, risky params, internal domains).
- **Graph** — provenance map: route → chunk → endpoint edges with discovery method.
- **Settings** — capture toggles, budgets, retention, Deep Scan bounds, theme.

## Project structure

```
manifest.json ......... MV3 manifest (minimal perms, sensitive actions opt-in)
panel.html / panel.css  DevTools panel UI (all tabs, modals, light/dark themes)
src/panel.ts .......... session owner — capture state, search UI, Deep Scan (RAM-only)
src/extractors.ts ..... two-pass JS literal scan (routes/endpoints/assets in bundles)
src/indexer.ts ........ compact RamIndex (token + trigram postings, hash dedupe)
src/search.ts ......... staged pipeline: exact → normalized → fuzzy → regex
src/fuzzy.ts .......... vendored zero-dep matcher (Damerau-Levenshtein + spans)
src/tables.ts ......... pure Resources/Network helpers (filters, mime groups, snippets)
src/rules.ts .......... secret rules + entropy + JWT decoding
src/exposure.ts ....... API-kind classification + exposure findings
src/worker-indexer.ts . chunked-streaming extraction off the UI thread
src/background.ts ..... metadata relay + replay executor + opt-in CDP Deep Capture
src/content.ts ........ opt-in per-origin DOM/SPA observer + rule relay
src/cdp.ts ............ Deep Capture contract (events, body gate, payload decode)
src/store.ts .......... hard RAM retention budget (CaptureStore)
src/idb.ts ............ temporary session overflow (auto-deleted, never permanent)
src/replay.ts ......... replay executor + interception rule matcher
src/intercept-main.ts . page-world fetch/XHR mock/block patch (classic script)
src/session-file.ts ... .dsz snapshot build + validation
src/openapi.ts ........ OpenAPI 3.0 generation from observed endpoints
src/har.ts ............ HAR 1.2 export + foreign-HAR import
src/filter-dsl.ts ..... filter DSL (parse + match)
scripts/ .............. verify.mjs (42 checks) · check-manifest.mjs · package.mjs · gen-icons.mjs
CHANGELOG.md .......... release history
```

## Limitations (reported in-app, not hidden)

- Only what the browser actually received is searchable — never server-side code.
- Cross-origin bodies/maps need **Grant site access**; failures get diagnostics.
- With *retain raw* off, bodies are metadata-only and **Reindex** needs recapture.
- Replay/Mock/Block need site access (rules apply after a page reload).
- Deep Capture body prefs apply at attach time — re-toggle after changing retention.
- Binary/media/fonts are metadata-only by default (never copied into the index).
- Regex over huge indexes scans newest-first with a 60k-record bound for interactivity.

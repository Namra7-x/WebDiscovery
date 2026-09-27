# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Security engineers and web developers using Chrome/Edge DevTools to discover routes, APIs, and secrets on a site they are testing.
- Primary job: capture traffic on a page, find an endpoint or leak, act on it (replay, mock, block, export). Session-paced work, repeated many times a day.

## Product Purpose

DeepScope is a RAM-efficient universal discovery instrument: it passively captures everything a page loads and requests, indexes it for fuzzy search, and lets the user act per request. It exists because the site's real attack surface (routes, hidden APIs, leaked secrets) is scattered across bundles, traffic, and DOM. Success: user goes capture → find → act in seconds, with bounded memory and nothing leaving the machine.

## Positioning

Passive-first discovery with hard RAM budgets and provenance for every finding (each route/endpoint/secret records how it was found), plus per-request action (replay, mock, block) and session sharing — a combination neighboring inspectors do not truthfully copy.

## Operating Context

- Runs as a `chrome.devtools` panel: narrow widths, light and dark DevTools themes, keyboard-heavy users, offline (MV3, zero runtime deps, no CDN).
- Workflows: browse → capture → search/filter → inspect → replay/mock/block/export → clear. Deep Scan (bounded crawl) and Deep Capture (opt-in CDP) are advanced paths.
- Rituals: export HAR/OpenAPI/`.dsz` sessions for sharing; copy cURL for terminal replay.

## Capabilities and Constraints

- Capabilities: two-pass discovery, trigram fuzzy search + DSL filters, grouped tables, secret/exposure analysis, replay/mock/block interception, `.dsz` sessions, HAR/OpenAPI export, discovery graph.
- Constraints: RAM-only capture with hard budgets (metadata survives, bodies drop first); no cloud/telemetry; passive default; CDP strictly opt-in with banner; site access requires explicit grant; all rendering bounded (row caps + show-all).
- Terminology: routes, resources, network requests, APIs (called/uncalled), findings, budget, Deep Scan, Deep Capture.
- Open decisions: secret display policy (reveal-fast vs redact-by-default); whether tabs stay the top-level structure.

## Brand Commitments

- Name DeepScope. Voice: plain, honest, instrument-grade; states limits and policies explicitly (eviction, caps, opt-ins).
- Pinned by user behavior: top-tab layout paradigm (a sidebar-chrome rebuild was tried and rejected); Strip Bay visual system in `design.md` is the committed visual authority.
- No personal or site names in user-facing docs.

## Evidence on Hand

- Working panel: `panel.html`, `panel.css`, `src/panel.ts` (+ engine in `src/`); 42-check `scripts/verify.mjs`; critique snapshot `.impeccable/critique/2026-09-27T14-32-30Z__panel-html.md` (25/40).
- No staged screenshots; no browser automation in this environment.

## Product Principles

1. Evidence over assertion: every finding carries provenance and limits.
2. Bounded by default: caps, budgets, and explicit opt-ins — never silent growth.
3. RAM-only unless the user exports: nothing persists without a click.
4. Recognition over recall: the tool teaches its own filters and actions inline.
5. Reversible exploration: destructive acts confirm; nothing important is one misclick away.

## Accessibility & Inclusion

- WCAG AA: visible focus, landmarks, live regions, keyboard-operable menus and modals, no color-alone meaning. Narrow-panel density must not break 200% zoom or keyboard flow.

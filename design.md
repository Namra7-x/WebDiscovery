# DeepScope — STRIP BAY

The world is an **ATC strip bay for requests**: the panel is the Operate surface where every captured route, resource, request, API, and finding is a paper flight-progress strip racked in bays (tabs), ruled, stamped, and handed off. Cool-gray bay paper, radar ink, one signal-green accent. Amber/red are lamps for state only — never decoration.

Contract (as built): cool-gray bay paper + radar ink ground, one signal-green accent, amber/red lamps for state only, condensed strip labels, mono data, tabular numerals, ruled strips, end-label bay headers, placard gauges, torn-timeline session strip. Pinned: top-tab chrome, offline MV3 zero-deps, light + dark themes.

## Color strategy

Restrained instrument palette. Paper/ink carry all structure; signal green marks the single "live / go / selected" meaning (active bay tab, primary buttons, focus, memory fill, clearance lamp, group detail rule); amber/red appear only as text+wash lamps on states that need them (budget warnings, mid/error status, severity badges, torn-strip warn/over). The sector band (`--band`) stays near-black in both themes so the top chrome reads as a separate radar scope. No gradients, no glow, no color-alone meaning (every lamp pairs with text/symbol).

### Full token table (as built in `panel.css`)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#e5e8eb` | `#0e1319` | bay paper ground (`body` bg, search input, ctx blocks, viewer body) |
| `--strip` | `#f7f8f9` | `#18202d` | strip face (rows, buttons, inputs, cards, tables) |
| `--strip-2` | `#eef1f4` | `#1e2837` | recessed strip (tabs rail, hover fill, `tr.grp`, `tr.det`) |
| `--ink` | `#1b1e26` | `#e9e7de` | radar ink (headings, body text in dark, menu borders, table top rule) |
| `--body` | `#33363f` | `#d4d2c8` | running body text |
| `--mut` | `#565b66` | `#a2a8b4` | secondary text, ghost buttons |
| `--faint` | `#848a95` | `#767c88` | faintest text, line numbers, scrollbars, idle lamp |
| `--line` | `#d0d5db` | `#2b3546` | hard rules (borders, row dividers) |
| `--line-soft` | `#dde1e6` | `#232c3a` | soft rules (in-row dividers, tab separators) |
| `--acc` | `#0f7a3d` | `#3ddc74` | signal green — the one accent (active tab bar, primary, focus, lamps, granted/deep) |
| `--acc-soft` | `#ddefe2` | `#122a1d` | green wash (chip hover, menu hover, sev-medium bg) |
| `--acc-deep` | `#0a5c2e` | `#8becab` | green text on wash (kind badges, pills, `st-ok`) |
| `--amber-t` | `#96590a` | `#e8a33d` | amber lamp text/border (`st-mid`, sev-high, torn warn, base lamp) |
| `--amber-soft` | `#f7ead0` | `#33240e` | amber wash (warn banner, sev-high bg) |
| `--red-t` | `#b3261e` | `#ff7b70` | red lamp text/border (`st-err`, sev-critical, torn over) |
| `--red-soft` | `#f9e2df` | `#3a1713` | red wash (sev-critical bg) |
| `--band` | `#1b1e26` | `#05080d` | sector-band ground (`#topbar`) |
| `--band-ink` | `#f2efe6` | `#ece9df` | band text (brand, mem numbers) |
| `--band-mut` | `#b9b4a6` | `#8f96a3` | band secondary (scope label, mem detail) |
| `--band-line` | `#3a3e4a` | `#232c3a` | band hairlines (top-action buttons, mem track) |
| `--ph` | `#5b5b53` | `#8b918d` | placeholder text only |

Theme switch: `:root` = light; `body[data-theme="dark"]` overrides every token above. Selection is always `var(--acc)` bg / `#fff`; caret is `var(--acc)`.

## Type system

- **Condensed labels** — `var(--cond)`: `"Arial Narrow", "Helvetica Neue Condensed", system-ui, sans-serif`. All strip/placard/tab chrome: brand `h1` (700 15px, 2.5px tracking, uppercase), bay tabs (600 12.5px, 1.5px, uppercase; active 700), `thead th` (700 11px, 1.5px, uppercase), `.stat span` (600 10.5px, 1.5px, uppercase), `.card h3` / `.rp-resp-head strong` (700 13px, 1.5px, uppercase), `.tab h2` (700 19px, 1.5px, uppercase), top-action buttons (600 12.5px, 1.2px, uppercase).
- **Mono data** — `var(--mono)`: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. URLs, bodies, provenance, timelines, counts, headers, graph, session info, replay fields (`.mono`, `.url`, `.orig`, `.ctx`, `.viewer-body`, `.rp-code`, `.rp-k/.rp-v`, `.torn-strip`, `.topstatus`, `#memText`, `.stat b` at 700 22px, `tr.grp b` at 700 12.5px, tab `.pill` at 700 11px).
- **Tabular numerals** — `font-variant-numeric: tabular-nums` on `#memText`, `.topstatus`, `td.num`, `.stat b`, `.torn-strip`, `.graph div`. Memory, seen-counts, gauges, and timelines never jitter.
- **Sans body** — `var(--sans)`: `-apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. Base `14px/1.45`; `.small` 12.5px; table cells 13px; ghost/menu buttons 12.5–13px 550–600.
- Scale is flat and dense: 10.5 (placard eyebrow) / 11 (pills, thead, badges at 11.5) / 12–12.5 (data, chips, controls) / 13 (cells) / 14 (body) / 15 (brand) / 16 (search input) / 19 (tab title) / 22 (placard numerals).

## Component catalog

- **Sector band** (`#topbar`, `src/panel.ts` topbar wiring): dark `--band` bar with 3px `--acc` underline. `.brand` (green `.dot` + clearance `.lamp` + condensed `h1` + mono `.scope`), `.membar` (mono `#memText` tabular + `#memDetail` + 5px `.mem-track/.mem-fill` green gauge), `.top-actions` (transparent condensed uppercase buttons, 34px min-height; `.primary` green fill; `[aria-pressed=true]` green inset ring). Amber `.warn` banner (`--amber-soft` bg, 2px `--amber-t` underline) for budget states.
- **Bay tabs** (`#tabs`, `nav#tabs[role=tablist]`): rail on `--strip-2` with bottom `--line` rule; buttons separated by `--line-soft` dividers, green-dot `::before` + `inset 0 3px 0 var(--acc)` on `.active`, mono `.pill` counts (green-bordered when active). Resources/Graph offset `margin-left: 12px` as the evidence/map breaks. Panels are `.tab`/`.active` with condensed `h2` + 13px lede.
- **Strip rows** (`.table-wrap` + `table`, `rowActsHtml` in `src/panel.ts:2283`): bay frame = 1px `--line` border with 3px `--ink` top rule. Condensed uppercase `thead th`, 1px `--line-soft` ruled `tbody td` on `--strip`, `tr:hover td` → `--strip-2`. `td.num` right/tabular; `td.callsign`/`td:first-child.method` condensed; `td.acts` right-aligned compact cell: visible `Open` + `View` (+ `Replay` on Network/API rows) ghost buttons, overflow behind 40×40 `⋯` (`data-act="menu"`). Routes variant: full-URL link + `×N` seen count + `.badge.kind` via-method.
- **End-label groups** (`tr.grp`, `#secList .grp`, `apiRowHtml` in `src/panel.ts:2671`): group headers read like strip-bay end labels — `▸/▾` toggle (`gtoggle`/`atoggle`, 36px targets, `aria-expanded`), bold host (`tr.grp b` mono 12.5px / Analyze `b` 13px ink), muted `N items · NN KB` summary, inline `Copy URLs`/`Copy` + `⋯` (`gmenu`) overflow. Collapsed children hide (`tr.det td` gets 2px green top rule when expanded detail). First-party host expanded, rest collapsed by default; per-group Show-all lifts 100→1000; overflow rows print `… +N more …`.
- **Placard gauges** (`.stat-grid/.stat`, `.card`, `statGrid` in `src/panel.ts:1638`): sector board is a zero-gap grid of bordered placards on `--strip` (right/bottom `--line-soft` dividers): mono 22px tabular `b` with 6px green pip `::after`, condensed 10.5px label. `.card` placards carry a 3px green top rule + condensed `h3`. Overview cards: Storage budget, Session, Interception, Diagnostics (`.diag` ruled rows).
- **Torn strip** (`.torn-strip`, `#sessionStrip`, `src/panel.ts:1641`): dashed top/bottom `--line` tear with mono 12px tabular timeline (`first seen … → last seen … · N requests · M bodies kept`). `data-state="live"` muted, `"warn"` amber text+edge, `"over"` red text+edge.
- **Chips** (`.chips`, `data-dsl-for` buttons): mono 12px DSL shortcuts (`seen:>5`, `kind:script`, …) bordered `--line` with `--acc-deep` text; hover fills `--acc-soft` with green border. `data-clear-for` reset chips fall back to sans/muted.
- **Menu** (`.actmenu`/`#actmenu`, `toggleActMenu`): one floating handoff menu, body-level fixed, 1px `--ink` border, hard `6px 6px 16px rgba(0,0,0,.25)` shadow (no blur-glow), 40px rows; hover/focus fills `--acc-soft` with 2px green inset outline. Row overflow (`ROW_MENU_ITEMS`: Replay / Mock / Block / Copy URL / Copy as cURL) and group overflow (`gcopyall`/`gcopycurl`/`gshowall`) share it; Esc returns focus to the `⋯` trigger (or its re-rendered successor).
- **Handoff viewer / modals** (`.viewer/.viewer-card`, `#viewer`/`#replayModal`/`#mockModal`): dim `rgba(0,0,0,.55)` scrim; card `min(700px,94vw)`, 1px `--ink` border with 3px green top rule, hard `8px 8px 24px` shadow. `.viewer-head` (ellipsis mono title + ghost actions), `.viewer-body` (paper ground, 1px line, mono pre-wrap break-all). Replay bay: `.rp-bar` mono URL field, `.rp-tabs` (active = green `inset 0 -3px 0`), `.rp-kv` 1fr/2fr/auto key-value grid, `.rp-resp-head` condensed label, `.rp-code` paper response well. Mock bay reuses viewer-card with match/method/status/body rows.
- **Badges / severity** (`.badge`, `secList` findings in `src/panel.ts:2970`): 11.5px mono bordered stamps (`--r-strip`, `--strip` ground). `.kind` = green-bordered `--acc-deep`, clickable (API Kind toggles `apiDetailHtml`: auth stamps, sent body, request/response headers, body preview). Severity: `sev-critical` red text/border on red wash, `sev-high` amber on amber wash, `sev-medium` green-deep on green wash, `sev-low`/`sev-info` line/muted. Status shorthands `.st-ok` green-deep, `.st-mid` amber, `.st-err` red. Evidence stamps `S`/`R`/`N×calls`/`U` ride in the API Detail cell. Analyze findings are masked (`•`) until `Reveal` (`aria-pressed`), grouped by severity then `sev|host`.
- **Focus / disabled / empty states**: focus is always `2px solid var(--acc)` + 2px offset (`:focus-visible` on buttons, inputs, links, `summary`, `[tabindex]`; menu items use inset outline; skip-link slides in on focus). Disabled is native `disabled` (Deep Scan arm, grant buttons `Requesting…`) — no faux-disabled styling dialect. Empty states are muted single rows/wells, never blank: `no routes yet …`, `no resources match …`, `no requests match …`, `no secret findings …`, `graph is empty …`, `no issues`, `.rp-empty` (`--faint` 12.5px), replay `no response yet`.

## Spacing / radius rules

- Radii: `--r-strip: 3px` on everything strip-grade (buttons, inputs, badges, pills, tables, menus); `--r-md: 6px` and `--r-lg: 10px` reserved for larger components (scroll thumbs approximate). Lamps/dots/pips are the only circles (50%).
- Grid is 8px: outer `main` padding `0 16px`, band/tabs `10–16px`, cards `12px 14px`, cells `7px 12px`, control gaps `8px`, chip gaps `6px`. Min-heights enforce touch/keyboard targets: 32px ghost, 34px controls/inputs, 36px badges-in-cells, 40px menu rows / `⋯` buttons / show-all.
- Rules carry hierarchy, not shadows: 3px top rules (`--ink` on bays, `--acc` on cards/ctx/menu-detail), 2px bottom on `thead th`/`tr.grp`, 1px soft row rules, 1px dashed tears, 3px green band under the sector bar. Only two shadows exist, both hard/off-axis menu and viewer cards.

## Motion

Stillness is the aesthetic: an instrument at rest. The only transitions are the memory `.mem-fill` width (0.3s) and the `button:active translateY(0.5px)` press. `@media (prefers-reduced-motion: reduce)` kills all animation/transition. Live regions (`mem-numbers`, counts, findings, diagnostics) update text, never flash or pulse.

## What was deliberately refused and why

- **No sidebar chrome** — pinned by behavior and tried/rejected (see `PRODUCT.md`): the surface is a top-tab strip bay (`#tabs` rail under the sector band). A sidebar would steal narrow-panel width from the strips themselves.
- **No card dashboard** — `.card`s are placard gauges and settings slabs, never a widget dashboard. The Operate surface is dense ruled tables; dashboard cards would hide the per-request handoff actions (View/Replay/Mock/Block/cURL) that are the product's job.
- **No glow** — no neon, blur-glow, or gradient flair. State travels on flat lamps, washes, and hard off-axis shadows; glow would read as decoration on an instrument that must stay legible in both DevTools themes.
- **No left-rule dialects** — rows never signal severity/importance with a colored left border. Meaning lives in bordered `.badge` stamps, lamps, band underlines, and the green detail/top rules, so state survives `prefers-reduced-motion`, zoom, and narrow widths without a second visual language.

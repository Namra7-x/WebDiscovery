# DeepScope — What This Project Does (Plain-English Definition)

## One-line definition

**DeepScope is a browser extension that shows you everything a website loads behind the scenes — and lets you search through all of it instantly.**

## The problem it solves

When you open a website, your browser quietly downloads many things: JavaScript files,
data files, images, settings, and messages the page exchanges with its server
(called API calls). Normally this hidden activity is hard to see. Developers must
click through many confusing browser panels, and even then some things stay hidden
inside large code files.

DeepScope collects all of that hidden activity into one clean window and makes it
searchable — like a search engine for a single website.

## What it actually does (in simple words)

1. **Watches** — While you browse, it quietly notes every file, page, data message,
   and connection the website uses. Nothing is sent anywhere; everything stays in
   your computer's short-term memory (RAM) and disappears when you close the tools.
2. **Discovers** — With one click ("Deep Scan"), it follows the website's own pages,
   code files, and data links to find parts you never even opened: hidden pages,
   extra code pieces, server addresses (`/api/...`), and data formats.
3. **Searches** — One search box looks through *everything* at once, even if you
   mistype or only remember part of a word (for example, searching `gpt-6` also
   finds `gpt6`, `GPT_6`, or `gpt6-preview`). Every result tells you exactly where
   it was found: which file, which page, which line — and one click opens that file.
4. **Organizes** — Separate tabs show Pages (Routes), Files (Resources), data
   traffic (Network), a map of how everything connects (Graph), and safety
   findings (Analyze — for example leaked keys or exposed settings).
5. **Protects your memory** — You choose a memory limit (starting at just 64 MB).
   A live meter always shows usage, and the tool cleans up after itself instead of
   slowing your browser.

## Who is it for?

- **Web developers** — understand how a site (yours or anyone's) is built, find an
  API address, or debug why something fails to load.
- **Security learners and testers** — spot exposed keys, open data doors, and
  debug pages without installing heavy professional software.
- **Curious minds** — anyone who ever asked "what is this website actually doing?"

## What it is NOT

- Not a hacking tool — it can only see what the website already sent to *your own*
  browser. It can never see server secrets or other people's data.
- Not a spy tool — it has no server, no account, no tracking. There is nowhere for
  your data to go even if it wanted to.
- Not a heavy app — the installed extension is under 200 KB with zero extra
  libraries. The "25 MB" you may see in the project folder is only the developer's
  build tooling, which is never installed into the browser.

## How to use it (30 seconds)

1. Open any website in Chrome or Edge.
2. Press `F12` and click the **DeepScope** tab.
3. Browse normally (it records passively) or press **Deep Scan** to explore deeper.
4. Type anything in the **Search** box and click a result to jump to its source.
5. Open **Analyze** to see safety findings grouped by importance.

## Technical definition (one paragraph, for developers)

DeepScope is a Manifest V3 Chromium extension (TypeScript, zero runtime
dependencies) that implements a RAM-only DevTools panel combining passive
network/DOM observation, bounded same-origin deep scanning, two-pass JavaScript
literal extraction (routes, endpoints, GraphQL operations, parameters, secrets),
a compact token+trigram in-memory index with typo-tolerant fuzzy search,
provenance tracking for every finding, and configurable memory budgets —
packaged as a ~194 KB loadable payload built from `src/` via `tsc`.

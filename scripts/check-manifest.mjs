// Validates manifest + entry points resolve to local files (no CDN, no missing refs).
import { existsSync, readFileSync } from 'node:fs';

const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const refs = [
  m.background.service_worker, m.devtools_page, m.action.default_popup,
  ...Object.values(m.icons),
  'dist/panel.js', 'dist/content.js', 'dist/worker-indexer.js',
  'dist/devtools.js', 'dist/popup.js', 'dist/extractors.js', 'dist/tables.js', 'dist/rules.js',
  'panel.html', 'panel.css', 'popup.html', 'devtools.html',
];
let fail = 0;
for (const f of refs) {
  const ok = existsSync(new URL(`../${f}`, import.meta.url));
  console.log(`${ok ? 'present -' : 'MISSING -'} ${f}`);
  if (!ok) fail++;
}
// No runtime external loads: extension pages must not reference http(s) assets.
const pages = ['panel.html', 'popup.html', 'devtools.html'].map((f) =>
  readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const ext = pages.filter((p) => /src\s*=\s*['"]https?:|href\s*=\s*['"]https?:|from\s+['"]https?:/.test(p));
if (ext.length) { console.error('EXTERNAL REFERENCES FOUND in extension pages'); fail++; }
else console.log('no external (CDN) references in extension pages');
if (fail) process.exit(1);
console.log('manifest check passed.');

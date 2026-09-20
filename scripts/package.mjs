// DeepScope clean packager — solves the "25MB" confusion.
// Reality: repo folder is ~23MB because dev-only typescript lives in node_modules.
// Installed payload is only dist + html/css + manifest + icons (~0.12MB).
// This script builds a minimal `release/deepscope/` folder that you load unpacked.
// Usage: npm run package   (runs tsc + copies only runtime files)
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'deepscope');

const RUNTIME_FILES = [
  'manifest.json',
  'panel.html',
  'panel.css',
  'popup.html',
  'devtools.html',
];
const RUNTIME_DIRS = ['dist', 'icons'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of RUNTIME_FILES) cpSync(join(root, f), join(out, f));
for (const d of RUNTIME_DIRS) cpSync(join(root, d), join(out, d), { recursive: true });

function bytes(p) {
  try {
    const s = statSync(p);
    if (s.isFile()) return s.size;
    let n = 0;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      n += bytes(join(p, e.name));
    }
    return n;
  } catch { return 0; }
}
const total = RUNTIME_FILES.reduce((a, f) => a + bytes(join(out, f)), 0)
  + RUNTIME_DIRS.reduce((a, d) => a + bytes(join(out, d)), 0);
console.log(`release written to release/deepscope/ — ${(total / 1024).toFixed(1)} KB total`);
console.log('Load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> select release/deepscope/');
console.log('Do NOT load the repo root (it contains node_modules dev tooling, never shipped).');
if (!existsSync(join(out, 'dist', 'panel.js'))) {
  console.error('MISSING dist/panel.js — run `npm run build` first.');
  process.exit(1);
}

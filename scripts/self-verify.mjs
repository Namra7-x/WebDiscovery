import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseBuildManifest, parseWebpackChunkMap, extractApiCallSchemas, extractGraphQLOperations, formatGraphQLRegistry } from '../dist/extractors.js';
import { buildSourceMapZip, crc32 } from '../dist/sourcemap.js';

console.log('--- DEEPSCOPE SELF-VERIFICATION RUNNER ---');

// 1. DOM ID Check
const html = fs.readFileSync('panel.html', 'utf8');
const ts = fs.readFileSync('src/panel.ts', 'utf8');

const idMatchesInHtml = new Set([...html.matchAll(/id=["']([a-zA-Z0-9_-]+)["']/g)].map(m => m[1]));
const dynamicIdsInTs = new Set([...ts.matchAll(/id=["']([a-zA-Z0-9_-]+)["']/g)].map(m => m[1]));
const idMatchesInTs = [...ts.matchAll(/(?:getElementById|\$|on)\(['"]([a-zA-Z0-9_-]+)['"]/g)].map(m => m[1]);

const missing = [];
for (const id of idMatchesInTs) {
  if (!idMatchesInHtml.has(id) && !dynamicIdsInTs.has(id)) {
    missing.push(id);
  }
}
const uniqueMissing = [...new Set(missing)];
console.log(`DOM ID check: ${idMatchesInTs.length} references checked.`);
if (uniqueMissing.length > 0) {
  console.error('Missing IDs in panel.html / dynamic templates:', uniqueMissing);
  process.exit(1);
} else {
  console.log('✓ All DOM element IDs referenced in src/panel.ts exist in panel.html or dynamic templates.');
}

// 2. Intercept Main Syntax Check
const interceptCode = fs.readFileSync('dist/intercept-main.js', 'utf8');
assert.ok(!/^\s*(?:export|import)\b/m.test(interceptCode), 'intercept-main.js must not contain export or import keywords');
console.log('✓ dist/intercept-main.js is a valid classic page-world script with zero export/import.');

// 3. ZIP File Parsing Verification (Simulate standard unzip tool)
const sampleFiles = [
  { path: 'src/index.ts', content: 'console.log("DeepScope v3.12.0");' },
  { path: 'src/components/Modal.tsx', content: 'export const Modal = () => <div>Hello</div>;' },
  { path: 'nested/dir/deep/file.json', content: JSON.stringify({ ok: true, version: '3.12.0' }) }
];
const zip = buildSourceMapZip(sampleFiles);
assert.ok(zip.length > 0, 'zip length > 0');

// Verify Local File Headers
let cursor = 0;
for (let i = 0; i < sampleFiles.length; i++) {
  const view = new DataView(zip.buffer, zip.byteOffset + cursor);
  const sig = view.getUint32(0, true);
  assert.equal(sig, 0x04034b50, `File ${i} local header signature valid`);
  const nameLen = view.getUint16(26, true);
  const dataLen = view.getUint32(18, true);
  const crc = view.getUint32(14, true);

  const nameBytes = zip.subarray(cursor + 30, cursor + 30 + nameLen);
  const dataBytes = zip.subarray(cursor + 30 + nameLen, cursor + 30 + nameLen + dataLen);
  const name = new TextDecoder().decode(nameBytes);
  const data = new TextDecoder().decode(dataBytes);

  assert.equal(name, sampleFiles[i].path, 'filename matches');
  assert.equal(data, sampleFiles[i].content, 'file content matches');
  assert.equal(crc32(dataBytes), crc, 'CRC-32 checksum valid');

  cursor += 30 + nameLen + dataLen;
}
console.log('✓ buildSourceMapZip output passed binary PKZIP 2.0 structure & CRC verification.');

// 4. Check Release Directory
const releaseDir = 'release/deepscope';
assert.ok(fs.existsSync(releaseDir), 'release/deepscope exists');
const manifest = JSON.parse(fs.readFileSync(`${releaseDir}/manifest.json`, 'utf8'));
assert.equal(manifest.version, '3.12.0', 'manifest version is 3.12.0');
console.log('✓ Release package manifest.json is valid v3.12.0.');

console.log('--- ALL SELF-VERIFICATION CHECKS PASSED ---');

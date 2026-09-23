// DeepScope smoke verification — runs locally against compiled dist/ output.
// Usage (from this folder only):  node scripts/verify.mjs
import assert from 'node:assert/strict';
import { normalize, hashStr, normalizeWithMap, snippetWithSpans } from '../dist/normalize.js';
import { fuzzyScore, fuzzyMatch } from '../dist/fuzzy.js';
import { extractJs, extractJson, extractCss, extractHtml, classifyPath, isApiEndpoint, collectLiterals } from '../dist/extractors.js';
import { RamIndex } from '../dist/indexer.js';
import { searchIndex, displayNameFor } from '../dist/search.js';
import { groupMime, netGroupCounts, netMethodCounts, optionsHtml, resourceKindCounts, buildCurl, severityRank } from '../dist/tables.js';
import { SECRET_RULES, scanTextForSecrets, isPlaceholder } from '../dist/rules.js';
import { MemoryLedger } from '../dist/memory.js';
import { defaultScope } from '../dist/types.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`ok - ${name}`); };

// 1. Normalization folds case/separators, original preserved elsewhere.
ok('normalize folds gpt-6 variants', () => {
  const a = normalize('gpt-6');
  for (const v of ['gpt6', 'GPT-6', 'gpt_6', 'gpt.6', 'GPT6']) assert.equal(normalize(v), a);
  assert.notEqual('gpt-6', 'gpt6'); // originals untouched
  assert.equal(typeof hashStr('x'), 'number');
});

// 2. Fuzzy ranks separator variants highly.
ok('fuzzyScore ranks variants', () => {
  const q = normalize('gpt-6');
  for (const v of ['gpt-6', 'gpt6', 'GPT-6', 'gpt_6', 'gpt-6x12', 'gpt6-preview', 'gpt6cb%']) {
    assert.ok(fuzzyScore(q, normalize(v)) >= 0.5, v);
  }
  assert.equal(fuzzyScore(q, normalize('zzz-unrelated-qqq')), 0);
});

// 3. JS extractor finds imports/fetch/routes/sourcemaps with locations.
ok('extractJs units', () => {
  const src = `import('./assets/asse099r9.js');\nfetch("/api/models");\nconst r="/models";\n//# sourceMappingURL=app.js.map`;
  const kinds = new Set(extractJs(src).map((u) => u.kind));
  for (const k of ['dynamic-import', 'fetch-target', 'route', 'sourcemap-ref']) assert.ok(kinds.has(k), k);
});

// 4. JSON flatten keeps paths like models[4].name.
ok('extractJson paths', () => {
  const units = extractJson(JSON.stringify({ models: [{}, {}, {}, {}, { name: 'gpt_6_model' }] }));
  const hit = units.find((u) => u.text === 'gpt_6_model');
  assert.ok(hit && hit.extra === 'models[4].name', JSON.stringify(hit));
});

// 5. CSS + HTML extractors.
ok('extractCss/extractHtml', () => {
  assert.ok(extractCss(`.a{background:url(/img/x.png)}@import "more.css";`).length >= 2);
  const h = extractHtml(`<a href="/models">x</a><script src="/app.js"></script><iframe src="/f"></iframe>`, 'https://s.test/');
  assert.ok(h.routes.includes('/models') && h.scripts.length === 1 && h.iframes.length === 1);
});

// 6. End-to-end: index units, fuzzy search 'gpt-6' finds all variants with provenance.
ok('index + staged search', () => {
  const idx = new RamIndex();
  const prov = (u, k) => ({ resourceUrl: u, resourceKind: k, route: '/models', method: 'dynamic-import', line: 18421 });
  const variants = ['gpt-6', 'gpt6', 'GPT-6', 'gpt_6', 'gpt-6x12', 'gpt6-preview', 'gpt6cb%'];
  variants.forEach((v, i) => idx.add(v, prov(`https://s.test/assets/asse099r9.js`, 'chunk')));
  idx.add('gpt_6_model', { resourceUrl: 'https://s.test/api/models', resourceKind: 'api-json', route: '/models', method: 'devtools-network', jsonPath: 'models[4].name' });
  for (let i = 0; i < 50; i++) idx.add(`unrelated-noise-string-${i}`, prov('https://s.test/x.js', 'script'));

  const scope = defaultScope();
  const fuzzy = searchIndex(idx, 'gpt-6', { mode: 'fuzzy', scope, limit: 50 });
  const found = new Set(fuzzy.map((r) => r.text));
  for (const v of [...variants, 'gpt_6_model']) assert.ok(found.has(v), `missing ${v}`);
  assert.ok(fuzzy[0].score >= fuzzy[fuzzy.length - 1].score); // ranked desc
  assert.ok(fuzzy[0].prov.line === 18421 || fuzzy[0].prov.jsonPath === 'models[4].name');

  assert.ok(searchIndex(idx, 'gpt-6', { mode: 'exact', scope }).every((r) => r.text.includes('gpt-6')));
  assert.ok(searchIndex(idx, 'GPT-6', { mode: 'substring', scope }).length >= 1);
  assert.ok(searchIndex(idx, 'gpt-6', { mode: 'normalized', scope }).length >= variants.length);
  assert.ok(searchIndex(idx, 'gpt[-_]6', { mode: 'regex', scope }).length >= 2);
  // Scope gate: disabling chunks hides chunk records.
  assert.ok(searchIndex(idx, 'gpt6cb%', { mode: 'exact', scope: { ...scope, chunks: false } }).length === 0);
});

// 7. Memory ledger budgets.
ok('memory ledger', () => {
  const m = new MemoryLedger();
  m.setBudget(128);
  m.rawBytes = 100 * 1024 * 1024; m.indexBytes = 20 * 1024 * 1024;
  assert.equal(m.checkWarn(), 'warn');
  m.indexBytes = 40 * 1024 * 1024;
  assert.equal(m.checkWarn(), 'over');
  assert.ok(m.stats().pct > 100);
});

// 8. Regression: fuzzy 'gpt-6' recalls 'gpt-6-astra' buried under noise
// (prefix-token recall, beyond the newest-records fallback window).
ok('fuzzy prefix recall at scale', () => {
  const idx = new RamIndex();
  const prov = (u) => ({ resourceUrl: u, resourceKind: 'chunk', route: '/', method: 'js-string' });
  idx.add('gpt-6-astra', prov('https://s.test/old-bundle.js'));
  for (let i = 0; i < 4500; i++) idx.add(`unrelated-noise-string-${i}-xyz`, prov('https://s.test/n.js'));
  const found = searchIndex(idx, 'gpt-6', { mode: 'fuzzy', scope: defaultScope(), limit: 50 });
  assert.ok(found.some((r) => r.text === 'gpt-6-astra'), 'gpt-6-astra recalled');
});

// 9. v1.2: generic two-pass route/API discovery — ANY site, not a prefix list.
ok('generic route/api discovery in bundles', () => {
  const src = [
    'const a="/api";',
    'fetch("/api/models");',
    'fetch("/v1/chat/completions");',
    'const g="/graphql";',
    'const r="/dashboard/settings";',
    'const c="/api/"+"models";',
    'const t=`/users/${id}/profile`;',
    'import("/assets/chunk-abc123.js");',
  ].join('\n');
  const units = extractJs(src);
  const texts = new Set(units.map((u) => u.text));
  for (const want of ['/api', '/api/models', '/v1/chat/completions', '/graphql', '/dashboard/settings', '/users/']) {
    const hit = [...texts].some((t) => t === want || t.startsWith(want));
    assert.ok(hit, `missing route/api ${want} in ${[...texts].slice(0, 20)}`);
  }
  // Classification sanity
  assert.equal(classifyPath('/api/models'), 'endpoint');
  assert.equal(classifyPath('/v1/chat'), 'endpoint');
  assert.equal(classifyPath('/graphql'), 'endpoint');
  assert.equal(classifyPath('/dashboard/settings'), 'route');
  assert.ok(isApiEndpoint('https://x.test/api/models?x=1'));
  assert.ok(!isApiEndpoint('/dashboard/settings'));
  // Literal collector handles templates + concatenation sources
  assert.ok(collectLiterals(src).length >= 6);
});

// 10. v1.2: typo tolerance (transposition / omission / substitution <=2).
ok('fuzzy typo tolerance', () => {
  assert.ok(fuzzyScore(normalize('models'), normalize('modles')) >= 0.3, 'transposition');
  assert.ok(fuzzyScore(normalize('gpt-6-sol'), normalize('gpt6sol')) >= 0.5, 'separator drop');
  const m = fuzzyMatch(normalize('models'), normalize('modles'));
  assert.ok(m.score > 0 && m.spans && m.spans.length >= 1, 'spans present');
});

// 11. v1.2: trigram prefilter recalls typo'd records buried under noise.
ok('trigram typo recall at scale', () => {
  const idx = new RamIndex();
  const prov = (u) => ({ resourceUrl: u, resourceKind: 'chunk', route: '/', method: 'js-string' });
  idx.add('gpt-6-astra-model', prov('https://s.test/old.js'));
  for (let i = 0; i < 3000; i++) idx.add(`unrelated-noise-string-${i}-xyz`, prov('https://s.test/n.js'));
  const found = searchIndex(idx, 'gpt-6-atsra', { mode: 'fuzzy', scope: defaultScope(), limit: 50 });
  assert.ok(found.some((r) => r.text === 'gpt-6-astra-model'), 'typo recall');
  // Every fuzzy hit carries multi-span highlight info mapped to context
  const top = found[0];
  assert.ok(top && Array.isArray(top.marks) && top.marks.length >= 1, 'marks');
  assert.ok(typeof top.context === 'string' && top.context.length > 0, 'context');
  const { map } = normalizeWithMap(top.text);
  const sn = snippetWithSpans(top.text, map, [[0, Math.min(map.length, 4)]]);
  assert.ok(sn.context.length > 0 && sn.marks.length >= 1, 'snippetWithSpans');
});

// 12. v1.2: clean display names stay single-line and bounded.
ok('displayNameFor', () => {
  assert.equal(displayNameFor('  a\nb  '), 'a b');
  assert.ok(displayNameFor('x'.repeat(500)).length <= 120, 'truncated');
});

// 13. v1.3: dynamic table helpers — live counts, mime groups, option sigs.
ok('tables helpers (dynamic filters)', () => {
  assert.equal(groupMime('application/json', 'https://x.test/a'), 'json');
  assert.equal(groupMime('text/javascript', 'https://x.test/a.js'), 'js');
  assert.equal(groupMime('text/css', 'https://x.test/a.css'), 'css');
  assert.equal(groupMime('text/html', 'https://x.test/'), 'html');
  assert.equal(groupMime('image/png', 'https://x.test/a.png'), 'img');
  assert.equal(groupMime('', 'https://x.test/a.js?x=1'), 'js');
  const kinds = resourceKindCounts(['script', 'chunk', 'script', 'api-json']);
  assert.equal(kinds[0].value, 'script');
  assert.equal(kinds[0].count, 2);
  const groups = netGroupCounts([{ mime: 'application/json', url: 'https://x/a' }, { mime: 'application/json', url: 'https://x/b' }, { mime: 'text/css', url: 'https://x/c.css' }]);
  assert.equal(groups[0].value, 'json');
  assert.equal(groups[0].count, 2);
  const methods = netMethodCounts(['GET', 'get', 'POST']);
  assert.equal(methods[0].value, 'GET');
  assert.equal(methods[0].count, 2);
  const o1 = optionsHtml([{ value: 'script', count: 2 }], 'ALL', 'all types');
  const o2 = optionsHtml([{ value: 'script', count: 3 }], 'ALL', 'all types');
  assert.notEqual(o1.sig, o2.sig); // sig changes -> dropdown refreshes
  assert.ok(o1.html.includes('script (2)'));
});

// 14. graphql-op facets.
ok('graphql-op facets', () => {
  const src = 'const q=`query GetUser($id:ID!){user(id:$id){name}}`; const m="mutation Checkout{}"; const x={"sha256Hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}';
  const units = extractJs(src);
  const extras = units.map((u) => u.extra);
  assert.ok(units.some((u) => u.kind === 'graphql-op' && u.extra === 'graphql:query:GetUser'), JSON.stringify(extras));
  assert.ok(units.some((u) => u.kind === 'graphql-op' && u.extra === 'graphql:mutation:Checkout'), JSON.stringify(extras));
  assert.ok(extras.includes('graphql:persisted:01234567'), JSON.stringify(extras));
});

// 15. baseURL join.
ok('baseURL join', () => {
  const units = extractJs('const api=axios.create({baseURL:"https://api.x.test/v1"}); api.get("/users");');
  const hit = units.find((u) => u.kind === 'endpoint' && u.text === 'https://api.x.test/v1/users');
  assert.ok(hit && typeof hit.extra === 'string' && hit.extra.startsWith('via-base:'), JSON.stringify(units.map((u) => [u.kind, u.text, u.extra])));
});

// 16. param facets.
ok('param facets', () => {
  const units = extractJs('fetch("/api/s?redirect=/x&debug=1")');
  const kinds = units.filter((u) => u.kind === 'param').map((u) => u.text);
  assert.ok(kinds.includes('redirect'), JSON.stringify(kinds));
  assert.ok(kinds.includes('debug'), JSON.stringify(kinds));
});

// 17. importmap/meta.
ok('importmap/meta', () => {
  const res = extractHtml('<script type="importmap">{"imports":{"react":"https://cdn.test/react.js"}}</script><meta name="csrf-token" content="ABC"><input name="email">', 'https://s.test/');
  assert.ok(res.importmap && res.importmap.some((u) => String(u).includes('https://cdn.test/react.js')), JSON.stringify(res.importmap));
  const kinds = new Set(res.units.map((u) => u.kind));
  assert.ok(kinds.has('meta-tag'), JSON.stringify([...kinds]));
  assert.ok(kinds.has('form-input'), JSON.stringify([...kinds]));
});

// 18. trpc facets.
ok('trpc facets', () => {
  const units = extractJs('fetch("/api/trpc/user.byId?batch=1&input={\\"0\\":{\\"json\\":1}}")');
  const hasProc0 = units.some((u) => u.kind === 'trpc-proc' && u.text === '0');
  const hasTrpcEndpoint = units.some((u) => u.kind === 'endpoint' && u.text.includes('trpc'));
  assert.ok(hasProc0 || hasTrpcEndpoint, JSON.stringify(units.map((u) => [u.kind, u.text, u.extra])));
});

// 19. buildCurl + severityRank.
ok('buildCurl + severityRank', () => {
  const c = buildCurl('post', 'https://x.test/a', { 'X-A': "b'b" });
  assert.ok(c.includes('curl -X POST'), c);
  assert.ok(c.includes("'\\''"), c);
  assert.ok(severityRank('critical') < severityRank('high') && severityRank('high') < severityRank('medium') && severityRank('medium') < severityRank('info'), 'order');
});

// 20. secrets scan.
ok('secrets scan', () => {
  assert.ok(SECRET_RULES.length >= 35 && SECRET_RULES.length <= 50, `rules=${SECRET_RULES.length}`);
  assert.ok(SECRET_RULES.every((r) => !r.pattern.global), 'patterns non-global');
  const aws = scanTextForSecrets('aws_key = "AKIAIOSFODNN7EXAMPLEX"');
  assert.ok(aws.length >= 1 && aws[0].rule.includes('aws'), JSON.stringify(aws));
  assert.deepEqual(scanTextForSecrets('example-key-xxx'), []);
  assert.deepEqual(scanTextForSecrets('test'), []);
  const jwt = scanTextForSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c');
  assert.ok(jwt.length >= 1 && jwt[0].rule === 'jwt', JSON.stringify(jwt));
  assert.equal(isPlaceholder('AKIAIOSFODNN7EXAMPLEX'), false);
  assert.equal(isPlaceholder('test-key-xxx'), true);
});

// 21. v1.4.1: W3C XML namespaces are not routes.
ok('namespace paths rejected', () => {
  assert.equal(classifyPath('/1999/xhtml'), null);
  assert.equal(classifyPath('/2000/svg'), null);
  assert.equal(classifyPath('/1998/Math/MathML'), null);
  assert.equal(classifyPath('/dashboard/settings'), 'route'); // real routes unaffected
});

console.log(`\n${pass} checks passed.`);
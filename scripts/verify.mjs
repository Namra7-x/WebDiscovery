// DeepScope smoke verification — runs locally against compiled dist/ output.
// Usage (from this folder only):  node scripts/verify.mjs
import assert from 'node:assert/strict';
import { normalize, hashStr, normalizeWithMap, snippetWithSpans } from '../dist/normalize.js';
import { fuzzyScore, fuzzyMatch } from '../dist/fuzzy.js';
import {
  extractJs, extractJson, extractCss, extractHtml, classifyPath, isApiEndpoint,
  collectLiterals, extractJsAdvanced, parseBuildManifest, parseWebpackChunkMap,
  extractApiCallSchemas, extractGraphQLOperations, formatGraphQLRegistry,
  extractServerActions, extractValidationSchemas, extractPersistedQueries,
  extractModernBundlerManifests, deobfuscateJsStrings,
  parseCspDomains, diffEndpointFields, normalizeDynamicPath, extractCloudConfigs
} from '../dist/extractors.js';
import { RamIndex } from '../dist/indexer.js';
import { searchIndex, displayNameFor } from '../dist/search.js';
import { groupMime, netGroupCounts, netMethodCounts, optionsHtml, resourceKindCounts, buildCurl, severityRank, hostOf, groupByHost, snippetBody, isBinaryText } from '../dist/tables.js';
import { SECRET_RULES, scanTextForSecrets, isPlaceholder, decodeJwtAlg, shannon } from '../dist/rules.js';
import { classifyApiKind, findExposures } from '../dist/exposure.js';
import { findFrameworkFindings } from '../dist/framework.js';
import { findHygieneFindings } from '../dist/hygiene.js';
import { parseSourceMap, resolveSourceUrl, buildSourceMapZip, crc32, probeOrphanSourceMapCandidates } from '../dist/sourcemap.js';
import { dissectWasmBinary } from '../dist/wasm.js';
import { buildAiDossier, sanitizeForAi, sanitizeHeadersForAi } from '../dist/ai-dossier.js';
import { MemoryLedger } from '../dist/memory.js';
import { CaptureStore } from '../dist/store.js';
import { sanitizeReplayHeaders, truncateReplayBody, matchInterceptRule } from '../dist/replay.js';
import { shouldFetchCdpBody, decodeCdpBody } from '../dist/cdp.js';
import { buildSessionFile, validateSessionFile } from '../dist/session-file.js';
import { inferSchema, templateOpenApiPath, buildOpenApiDoc } from '../dist/openapi.js';
import { buildHarDoc, validateHar, normalizeHarEntry } from '../dist/har.js';
import { parseFilterDsl, wildcardMatch, matchDslAll } from '../dist/filter-dsl.js';
import { DiscoveryGraph } from '../dist/graph.js';
import { defaultScope } from '../dist/types.js';
import {
  detectContentCategory, beautifyJs, beautifyJson, beautifyCss, beautifyHtml,
  formatHexDump, parseZipListing, isNonPrintableBinary, addLineNumbers,
  decodeRawProtobuf, decodeMsgPack, decodeRscStream, decodeWsFrame, decodeAiStream
} from '../dist/viewer.js';

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

// 22. classifyApiKind — ordered kind detection.
ok('classifyApiKind', () => {
  assert.equal(classifyApiKind('/graphql'), 'GraphQL');
  assert.equal(classifyApiKind('/api/trpc/user.byId?batch=1&input=%7B%7D'), 'tRPC');
  assert.equal(classifyApiKind('https://x.example/grpc', 'application/grpc'), 'gRPC-Web');
  assert.equal(classifyApiKind('ws://x.example/socket'), 'WebSocket');
  assert.equal(classifyApiKind('https://x.example/events', 'text/event-stream'), 'SSE');
  assert.equal(classifyApiKind('https://x.example/api/models'), 'REST');
  assert.equal(classifyApiKind('https://x.example/rpc', 'application/json', 'POST', '{"method":"getUser"}'), 'JSON-RPC');
  assert.equal(classifyApiKind('https://x.example/soap', 'text/xml', 'POST', '<Envelope><Body/>'), 'SOAP');
  assert.equal(classifyApiKind('https://x.example/img/a.png', 'image/png'), 'Other');
});

// 23. findExposures — one finding per category, right rules/sevs.
ok('findExposures', () => {
  const findings = findExposures({
    routes: [{ route: '/admin/users', method: 'GET', count: 3 }],
    resources: [{ url: 'https://x.example/app.js', kind: 'script', hasSourceMap: true }],
    urls: ['https://x.example/api/s?token=abc123', 'https://staging.example.com/home'],
    params: ['redirect'],
  });
  assert.equal(findings.length, 5, JSON.stringify(findings));
  const byRule = new Map(findings.map((f) => [f.rule, f]));
  assert.equal(byRule.get('expo-sourcemap').sev, 'high');
  assert.equal(byRule.get('expo-sensitive-endpoint').sev, 'high');
  assert.equal(byRule.get('expo-auth-in-url').sev, 'high');
  assert.equal(byRule.get('expo-param').sev, 'medium');
  assert.equal(byRule.get('expo-internal-domain').sev, 'medium');
});

// 24. generic assignment + entropy + jwt-none + new vendor shapes.
ok('generic secrets: assignment, entropy, jwt-none', () => {
  const g = scanTextForSecrets('api_key = "aB3xK9pQ2mZ7vL4qWeRt6"');
  assert.ok(g.some((h) => h.rule === 'generic_secret_assignment' && h.sev === 'medium'), JSON.stringify(g));
  assert.ok(shannon('aaaaaaaa') < shannon('aB3xK9pQ2mZ7vL4qWeRt6'), 'entropy sanity');
  const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const noneJwt = `${b64u('{"alg":"none"}')}.${b64u('{"sub":"1"}')}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c`;
  assert.equal(decodeJwtAlg(noneJwt), 'none');
  const j = scanTextForSecrets(noneJwt);
  assert.ok(j.some((h) => h.rule === 'jwt' && h.sev === 'high'), JSON.stringify(j));
  assert.ok(j.some((h) => h.rule === 'jwt_none_alg' && h.sev === 'critical'), JSON.stringify(j));
  const proj = scanTextForSecrets('key = "sk-proj-aB3xK9pQ2mZ7vL4qWeRt7GhY8"');
  assert.ok(proj.some((h) => h.rule === 'openai_project' && h.sev === 'critical'), JSON.stringify(proj));
  const asia = scanTextForSecrets('token ASIAIOSFODNN7EXAMPLE12345 here');
  assert.ok(asia.some((h) => h.rule === 'aws_session_token' && h.sev === 'critical'), JSON.stringify(asia));
});

// 25. sinks + new facets (extractors agent owns these kinds).
ok('sinks + new facets', () => {
  const s = extractJs('if(x){eval(y)}; el.innerHTML = z; document.write(w);');
  const sinks = s.filter((u) => u.kind === 'sink');
  assert.equal(sinks.length, 3, JSON.stringify(sinks.map((u) => [u.kind, u.text, u.extra])));
  for (const e of ['sink:eval', 'sink:innerHTML', 'sink:document.write']) {
    assert.ok(sinks.some((u) => u.extra === e), `missing ${e} in ${JSON.stringify(sinks.map((u) => u.extra))}`);
  }
  assert.ok(extractJs('"method":"getUser"').some((u) => u.kind === 'jsonrpc-method'), 'jsonrpc-method');
  assert.ok(extractJs('event: priceUpdate').some((u) => u.kind === 'sse-event'), 'sse-event');
  assert.ok(extractJs('soapaction: "urn:X"').some((u) => u.kind === 'soap-op'), 'soap-op');
});

// 26. hostOf + groupByHost.
ok('hostOf + groupByHost', () => {
  assert.equal(hostOf('https://API.X.example:8080/a'), 'api.x.example');
  assert.equal(hostOf('/relative/path'), '');
  const groups = groupByHost(
    [{ u: 'https://b.example/x' }, { u: 'https://a.example/x' }, { u: 'https://a.example/y' }, { u: '/rel' }],
    (t) => t.u,
  );
  assert.equal(groups[0].host, 'a.example');
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[groups.length - 1].host, '(relative)');
});

// 27. NetEntry reqBody optional + snippetBody basics.
ok('NetEntry reqBody optional + snippetBody', () => {
  const entry = { id: '1', url: 'https://x.test/a', method: 'POST', route: '/', bodyKept: false, bodyTruncated: false, bodyChars: 0, ts: 1 };
  assert.equal(entry.reqBody, undefined);
  assert.ok(snippetBody(undefined).includes('not captured'));
  assert.ok(snippetBody('').includes('not captured'));
  assert.equal(snippetBody('hello'), 'hello');
  const long = 'x'.repeat(2000);
  const out = snippetBody(long, 100);
  assert.ok(out.includes('truncated'));
  assert.ok(out.length <= 140, `len=${out.length}`);
});

// 28. snippetBody default cap 1500.
ok('snippetBody default cap 1500', () => {
  const input = 'y'.repeat(1600);
  const out = snippetBody(input);
  assert.ok(out.includes('truncated'));
  assert.ok(out.includes('100 chars'));
});

// 29. priority-aware extraction caps — endpoints survive identifier floods.
ok('priority caps: endpoints survive 4500+ identifiers', () => {
  let blob = 'fetch("/api/keep1"); fetch("/api/keep2");\n';
  for (let i = 0; i < 4600; i++) blob += `var ident${i}=${i};\n`;
  const units = extractJs(blob);
  assert.ok(units.length <= 6000, `out.length=${units.length}`);
  assert.ok(units.some((u) => u.text.includes('/api/keep1')), 'keep1 present');
  assert.ok(units.some((u) => u.text.includes('/api/keep2')), 'keep2 present');
  assert.ok(units.filter((u) => u.kind === 'identifier').length <= 1200, 'identifiers bounded');
});

// 30. OpenAPI/Swagger declared endpoints.
ok('openapi declared endpoints', () => {
  const units = extractJson(JSON.stringify({ openapi: '3.0.0', paths: { '/pets': { get: {}, post: {} } } }));
  const eps = units.filter((u) => u.kind === 'endpoint' && u.text === '/pets');
  assert.ok(eps.some((u) => u.extra === 'openapi:GET /pets declared'), JSON.stringify(eps));
  assert.ok(eps.some((u) => u.extra === 'openapi:POST /pets declared'), JSON.stringify(eps));
});

// 31. graph edge-key rebuild on overflow (no leak, no wrong dedupe).
ok('graph edgeKeys rebuild on overflow', () => {
  const g = new DiscoveryGraph();
  for (let i = 0; i < 8200; i++) g.link(`a${i}`, `b${i}`, 'js-string');
  assert.ok(g.edges.length <= 8000, `edges=${g.edges.length}`);
  const before = g.edges.length;
  g.link('a0', 'b0', 'js-string'); // dropped by overflow splice -> must NOT be wrongly deduped
  assert.equal(g.edges.length, before + 1, 'dropped triple re-added');
});

// NOTE: worker gen echo (msg.gen ?? 0 -> PostBack.gen in both success + error
// branches) is NOT tested here — Workers can't run in node; verified by
// inspection of src/worker-indexer.ts.

// 32. advanced socket/router/URL patterns (advancedJsAnalysis gate).
ok('extractJsAdvanced socket/router patterns', () => {
  const units = extractJsAdvanced('new WebSocket("wss://x/s"); el path:"/dash"');
  assert.ok(units.some((u) => u.kind === 'fetch-target' && u.text === 'wss://x/s'), JSON.stringify(units));
  assert.ok(units.some((u) => u.kind === 'route' && u.text === '/dash'), JSON.stringify(units));
});

// 33. v1.6.3: absolute setCategory for derived meter categories.
ok('store setCategory', () => {
  const s = new CaptureStore(1000);
  s.setCategory('index', 400);
  s.setCategory('graph', 100);
  assert.equal(s.snapshot().total, 500);
  s.setCategory('index', 100); // absolute replace, not accumulate
  assert.equal(s.snapshot().total, 200);
  s.add('raw-bodies', 300);
  assert.equal(s.snapshot().total, 500);
  s.setCategory('bogus', 999); // unknown category ignored
  assert.equal(s.snapshot().total, 500);
});

// 34. v1.7.0: replay guards + interception rule matcher.
ok('replay header sanitize + body clamp', () => {
  const h = sanitizeReplayHeaders({
    Authorization: 'Bearer x',
    Host: 'evil',
    'Content-Length': '5',
    Connection: 'keep-alive',
    ':authority': 'arena.ai',
    ':method': 'GET',
    ':path': '/nextjs-api/model-catalog',
    Cookie: 'session=123',
    'Sec-Fetch-Mode': 'cors',
    ok: 'yes',
  });
  assert.deepEqual(h, { Authorization: 'Bearer x', ok: 'yes' });
  assert.deepEqual(sanitizeReplayHeaders(null), {});
  const t = truncateReplayBody('abcdef', 4);
  assert.equal(t.text, 'abcd');
  assert.equal(t.truncated, true);
  assert.equal(truncateReplayBody('ab', 4).truncated, false);
});
ok('intercept rule matcher', () => {
  const mock = { id: 'r1', kind: 'mock', match: '/api/users', method: 'GET' };
  assert.equal(matchInterceptRule('https://x.com/api/users?page=1', 'GET', mock), true);
  assert.equal(matchInterceptRule('https://x.com/api/users', 'POST', mock), false);
  assert.equal(matchInterceptRule('https://x.com/other', 'GET', mock), false);
  const any = { id: 'r2', kind: 'block', match: 'track', method: 'ANY' };
  assert.equal(matchInterceptRule('https://t.com/track.js', 'GET', any), true);
  const rx = { id: 'r3', kind: 'block', match: '\\.png(\\?|$)', method: 'ANY', useRegex: true };
  assert.equal(matchInterceptRule('https://x.com/a.png?v=1', 'GET', rx), true);
  assert.equal(matchInterceptRule('https://x.com/a.pngx', 'GET', rx), false);
  const bad = { id: 'r4', kind: 'block', match: '([', method: 'ANY', useRegex: true };
  assert.equal(matchInterceptRule('https://x.com/([', 'GET', bad), false); // bad regex never matches
  assert.equal(matchInterceptRule('https://x.com/a', 'GET', { id: 'r5', kind: 'block', match: '' }), false);
});

// 35. v1.7.0 Phase 2: Deep Capture body gate + payload decode.
ok('cdp body gate', () => {
  const on = { retainRaw: true, retainBinary: false, maxBodyChars: 100 };
  assert.equal(shouldFetchCdpBody('https://x.com/api/u', 'application/json', on), true);
  assert.equal(shouldFetchCdpBody('https://x.com/a.png', 'image/png', on), false);
  assert.equal(shouldFetchCdpBody('https://x.com/a.js', '', on), true);
  assert.equal(shouldFetchCdpBody('https://x.com/a.png', 'image/png', { ...on, retainBinary: true }), true);
  assert.equal(shouldFetchCdpBody('https://x.com/api', 'application/json', { ...on, retainRaw: false }), false);
  assert.equal(shouldFetchCdpBody('ws://x.com/s', '', on), false);
});
ok('cdp body decode', () => {
  const b64 = Buffer.from('hello world').toString('base64');
  const d = decodeCdpBody(b64, true, 100);
  assert.equal(d.text, 'hello world');
  assert.equal(d.truncated, false);
  const t = decodeCdpBody('abcdef', false, 4);
  assert.equal(t.text, 'abcd');
  assert.equal(t.truncated, true);
  assert.equal(decodeCdpBody('', false, 100), null);
  assert.equal(decodeCdpBody('!!!', true, 100), null);
});

// 36. v1.7.0 Phase 3: session file build + validate.
ok('session file round-trip', () => {
  const big = 'x'.repeat(60_000);
  const f = buildSessionFile({
    origin: 'https://x.com',
    routes: [{ route: '/a' }],
    resources: [{ url: 'https://x.com/a' }],
    network: [{ url: 'https://x.com/a', method: 'GET' }],
    bodies: { 'https://x.com/a': big, '': 'skip', 'https://x.com/b': '' },
  });
  assert.equal(f.tool, 'DeepScope');
  assert.equal(f.format, 1);
  assert.equal(f.bodies['https://x.com/a'].length, 50_000); // per-body cap
  assert.equal('' in f.bodies, false);
  assert.equal('https://x.com/b' in f.bodies, false);
  const v = validateSessionFile(JSON.parse(JSON.stringify(f)));
  assert.equal(v.ok, true);
  assert.equal(validateSessionFile({}).ok, false);
  assert.equal(validateSessionFile({ tool: 'DeepScope', format: 999, routes: [], resources: [], network: [] }).ok, false);
  assert.equal(validateSessionFile({ tool: 'Other', format: 1, routes: [], resources: [], network: [] }).ok, false);
});

// 37. v1.7.0 Phase 4: OpenAPI schema inference + doc build.
ok('openapi schema + paths', () => {
  assert.deepEqual(inferSchema('a'), { type: 'string', example: 'a' });
  assert.deepEqual(inferSchema(3).type, 'integer');
  assert.equal(inferSchema([1, 2]).type, 'array');
  const o = inferSchema({ id: 1, tags: ['x'], nested: { deep: true } });
  assert.equal(o.type, 'object');
  assert.equal(o.properties.tags.type, 'array');
  assert.equal(templateOpenApiPath('/users/123/posts'), '/users/{id}/posts');
  assert.equal(templateOpenApiPath('/api/v1/items/550e8400-e29b-41d4-a716-446655440000'), '/api/v1/items/{id}');
  const doc = buildOpenApiDoc('https://x.com', [
    { method: 'GET', url: 'https://x.com/api/users/42?role=admin', status: 200, resSample: '{"id":1,"name":"n"}' },
    { method: 'POST', url: 'https://x.com/api/users', status: 201, reqSample: '{"name":"n"}' },
    { method: 'GET', url: 'https://x.com/api/old', uncalled: true },
    { method: 'GET', url: 'ws://x.com/sock' },
  ]);
  assert.equal(doc.openapi, '3.0.0');
  assert.ok(doc.paths['/api/users/{id}'].get);
  assert.ok(doc.paths['/api/users'].post.requestBody);
  assert.deepEqual(doc['x-deepscope-uncalled'], ['https://x.com/api/old']);
  assert.equal('ws://x.com/sock' in doc.paths, false);
});

// 38. v1.7.0 Phase 5: HAR build + validate + normalize.
ok('har round-trip', () => {
  const doc = buildHarDoc('https://x.com', [
    { method: 'POST', url: 'https://x.com/api/u', status: 200, mime: 'application/json', reqHeaders: { a: 'b' }, reqBody: '{"n":1}', resBody: '{"id":2}', ts: 1700000000000, timingMs: 12 },
    { method: 'GET', url: 'ws://x.com/s' },
  ]);
  assert.equal(doc.log.entries.length, 1);
  assert.equal(doc.log.entries[0].request.method, 'POST');
  assert.equal(doc.log.entries[0].response.content.text, '{"id":2}');
  const v = validateHar(JSON.parse(JSON.stringify(doc)));
  assert.equal(v.ok, true);
  assert.equal(validateHar({}).ok, false);
  const b64 = Buffer.from('hi').toString('base64');
  const n = normalizeHarEntry({
    startedDateTime: '2024-01-01T00:00:00.000Z', time: 5,
    request: { method: 'get', url: 'https://y.com/a?b=c', headers: [{ name: 'h', value: 'v' }], postData: { text: 'q=1' } },
    response: { status: 201, content: { mimeType: 'application/json', text: b64, encoding: 'base64' } },
  });
  assert.equal(n.method, 'GET');
  assert.equal(n.resText, 'hi');
  assert.equal(n.reqText, 'q=1');
  assert.equal(normalizeHarEntry({}), null);
});

// 39. v1.7.0 Phase 6: filter DSL parse + match.
ok('filter dsl', () => {
  const t = parseFilterDsl('method:POST status:>=400 host:api.* has:auth -mime:image "quoted str"');
  assert.equal(t.length, 6);
  assert.deepEqual(t[0], { field: 'method', value: 'POST', negate: false });
  assert.deepEqual(t[3], { field: 'has', value: 'auth', negate: false });
  assert.deepEqual(t[4], { field: 'mime', value: 'image', negate: true });
  assert.deepEqual(t[5], { field: null, value: 'quoted str', negate: false });
  // Unknown fields degrade to substrings (existing filters keep working).
  assert.deepEqual(parseFilterDsl('https://x.com/a?b=c'), [{ field: null, value: 'https://x.com/a?b=c', negate: false }]);
  assert.equal(wildcardMatch('api.example.com', 'api.*'), true);
  assert.equal(wildcardMatch('cdn.x.com', 'api.*'), false);
  const rec = { method: 'POST', status: 500, host: 'api.x.com', mime: 'application/json', url: 'https://api.x.com/u', route: '/u', kind: 'api', hasAuth: true, hasBody: true, isError: true };
  const hay = 'https://api.x.com/u application/json';
  assert.equal(matchDslAll(parseFilterDsl('method:POST status:>=400 has:error -mime:image'), rec, hay), true);
  assert.equal(matchDslAll(parseFilterDsl('status:<400'), rec, hay), false);
  assert.equal(matchDslAll(parseFilterDsl('host:api.* has:auth'), rec, hay), true);
  assert.equal(matchDslAll(parseFilterDsl('u'), rec, hay), true);
  assert.equal(matchDslAll(parseFilterDsl('-u'), rec, hay), false);
  assert.equal(matchDslAll(parseFilterDsl('has:body'), rec, hay), true);
  assert.equal(matchDslAll(parseFilterDsl('status:500'), { ...rec, status: undefined }, hay), false);
  assert.equal(matchDslAll([], rec, hay), true);
});

// 40. Screenshot fixes: binary/compressed bodies never render as mojibake.
ok('binary body guard', () => {
  assert.equal(isBinaryText('{"id":1,"name":"n"}'), false);
  assert.equal(isBinaryText('hello world'), false);
  assert.equal(isBinaryText(undefined), false);
  assert.equal(isBinaryText('function min(){return 0}'), false); // minified JS stays text
  assert.equal(isBinaryText('{"a":"你好世界"}'), false); // CJK JSON stays text
  const gzipLike = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 2000))).join('');
  assert.equal(isBinaryText(gzipLike), true);
  assert.ok(snippetBody(gzipLike).includes('binary'));
  assert.equal(snippetBody('hello'), 'hello');
});

// 41. v3.9.0: framework fingerprint (conditional CVEs, never invented versions).
ok('framework fingerprint', () => {
  const f = findFrameworkFindings({
    routes: [{ route: '/_next/static/chunks/app.js', method: 'script', count: 3 }],
    resources: [{ url: 'https://x.com/_next/static/a.js', kind: 'script', hasSourceMap: false }],
    urls: ['https://x.com/_next/static/a.js', 'https://x.com/wp-json/wp/v2/posts'],
    params: [],
    reqHeaders: [{ url: 'https://x.com/', headers: { 'next-action': 'abc' } }],
    resHeaders: [{ url: 'https://x.com/', mime: 'text/x-component', headers: {} }],
  });
  const rules = new Set(f.map((x) => x.rule));
  assert.ok(rules.has('fw-nextjs'), [...rules].join(','));
  assert.ok(rules.has('fw-wordpress'), [...rules].join(','));
  assert.ok(rules.has('fw-cve-next-flight'), [...rules].join(','));
  assert.ok(f.length <= 60, `cap len=${f.length}`);
});

// 42. v3.9.0: security headers + cookie audit.
ok('hygiene audit', () => {
  const h = findHygieneFindings({
    routes: [], resources: [], urls: [], params: [],
    resHeaders: [{
      url: 'https://x.com/', mime: 'text/html',
      headers: {
        'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true',
        'set-cookie': 'sess=abc; Path=/',
      },
    }],
  });
  const rules = new Set(h.map((x) => x.rule));
  for (const r of ['hyg-csp-missing', 'hyg-cors-creds', 'hyg-cookie-httponly', 'hyg-cookie-secure']) {
    assert.ok(rules.has(r), `missing ${r} in ${[...rules].join(',')}`);
  }
});

// 43. v3.9.0: secret false positives tightened (hashes/IDs stay silent, real keys fire).
ok('secret FP tightening', () => {
  assert.deepEqual(scanTextForSecrets('api_key = "a1b2c3d4"'), []); // 8-hex id
  assert.deepEqual(scanTextForSecrets('deadbeefcafe1234deadbeefcafe1234'), []); // 32-hex digest
  assert.deepEqual(scanTextForSecrets('550e8400-e29b-41d4-a716-446655440000'), []); // uuid
  assert.ok(scanTextForSecrets('api_key = "aB3xK9pQ2mZ7vL4qWeRt6"').some((x) => x.rule === 'generic_secret_assignment'));
});

// 44. v3.10.0: source-map reconstruction (pure, capped, never throws).
ok('sourcemap parse', () => {
  const good = JSON.stringify({
    sources: ['src/a.ts', 'src/b.ts', 'empty'],
    sourcesContent: ['const getUserToken=1', null, 'x'],
  });
  const p = parseSourceMap(good);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, 'src/a.ts');
  assert.equal(p.truncated, false);
  assert.deepEqual(parseSourceMap('nope{').files, []);
  assert.deepEqual(parseSourceMap('').files, []);
  assert.equal(resolveSourceUrl('https://x.com/a/app.js.map', '../src/a.ts'), 'https://x.com/a/../src/a.ts'.replace('/a/../', '/'));
  assert.equal(resolveSourceUrl('https://x.com/a.map', 'webpack://app/./src/a.ts'), 'webpack://app/./src/a.ts');
});

// 45. Universal Viewer: category sniff (magic bytes, MIME, extensions)
ok('Universal Viewer: category detection', () => {
  // Gzip magic bytes 1f 8b
  assert.equal(detectContentCategory('blob', '', '', new Uint8Array([0x1f, 0x8b, 0x08])).category, 'gzip');
  // Zip magic bytes 50 4b 03 04
  assert.equal(detectContentCategory('archive.bin', '', '', new Uint8Array([0x50, 0x4b, 0x03, 0x04])).category, 'zip');
  // PNG magic bytes 89 50 4e 47
  assert.equal(detectContentCategory('test', '', '', new Uint8Array([0x89, 0x50, 0x4e, 0x47])).category, 'image');
  // WASM magic bytes 00 61 73 6d
  assert.equal(detectContentCategory('module', '', '', new Uint8Array([0x00, 0x61, 0x73, 0x6d])).category, 'wasm');
  // Extensions & MIME
  assert.equal(detectContentCategory('https://example.com/audio.mp3', 'audio/mpeg').category, 'audio');
  assert.equal(detectContentCategory('https://example.com/video.mp4', 'video/mp4').category, 'video');
  assert.equal(detectContentCategory('https://example.com/logo.svg', 'image/svg+xml').category, 'svg');
  assert.equal(detectContentCategory('https://example.com/app.js', 'application/javascript').category, 'javascript');
  assert.equal(detectContentCategory('https://example.com/api/v1/user', 'application/json').category, 'json');
  assert.equal(detectContentCategory('https://example.com/styles.css', 'text/css').category, 'css');
  assert.equal(detectContentCategory('https://example.com/page', 'text/html').category, 'html');
  assert.equal(detectContentCategory('https://example.com/feed', 'application/xml').category, 'xml');
  // JSON content sniff with generic text/plain
  assert.equal(detectContentCategory('https://example.com/unknown', 'text/plain', '{"foo":"bar"}').category, 'json');
});

// 46. Universal Viewer: beautify code & hex dump
ok('Universal Viewer: beautification and hex dump', () => {
  // Beautify minified JS
  const minJs = 'function hello(){const a=1;if(a){return a;}else{return 0;}}';
  const prettyJs = beautifyJs(minJs);
  assert.ok(prettyJs.includes('1 | function hello() {'));
  assert.ok(prettyJs.includes('return a;'));

  // Beautify compact JSON
  const compactJson = '{"name":"Alice","age":30,"roles":["admin","editor"]}';
  const prettyJson = beautifyJson(compactJson);
  assert.ok(prettyJson.includes('"name": "Alice"'));
  assert.ok(prettyJson.includes('1 | {'));

  // Hex Dump
  const sampleBytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21]);
  const dump = formatHexDump(sampleBytes);
  assert.ok(dump.includes('00000000'));
  assert.ok(dump.includes('48 65 6C 6C 6F 2C 20 57'));
  assert.ok(dump.includes('|Hello, World!|'));
});

// 47. Universal Viewer: ZIP archive listing
ok('Universal Viewer: ZIP listing', () => {
  // Construct a minimal valid ZIP local file header in memory
  // Signature (4) PK\x03\x04 + Version (2) + Flags (2) + Method (2) + Time (2) + Date (2) + CRC (4)
  // + CompSize (4) + UncompSize (4) + NameLen (2) + ExtraLen (2) + Name
  const name = 'test.json';
  const nameBytes = Buffer.from(name, 'utf-8');
  const zipBuf = new Uint8Array(30 + nameBytes.length);
  zipBuf[0] = 0x50; zipBuf[1] = 0x4b; zipBuf[2] = 0x03; zipBuf[3] = 0x04;
  zipBuf[18] = 42; zipBuf[19] = 0; // comp size = 42
  zipBuf[22] = 100; zipBuf[23] = 0; // uncomp size = 100
  zipBuf[26] = nameBytes.length; zipBuf[27] = 0;
  zipBuf[28] = 0; zipBuf[29] = 0; // extra len = 0
  zipBuf.set(nameBytes, 30);

  const list = parseZipListing(zipBuf);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'test.json');
  assert.equal(list[0].compressedSize, 42);
  assert.equal(list[0].uncompressedSize, 100);
});

// 48. Full-Spectrum API Response & NDJSON/SSE Indexing
ok('Universal Indexing: NDJSON/SSE & API responses', () => {
  // NDJSON streaming response with key-value pairs
  const ndjson = '{"user":"alice","status":"active","code":200}\n{"user":"bob","status":"pending","code":202}';
  const units = extractJson(ndjson);
  const texts = new Set(units.map((u) => u.text));

  assert.ok(texts.has('alice'), 'indexes string value');
  assert.ok(texts.has('bob'), 'indexes string value');
  assert.ok(texts.has('status: active'), 'indexes composite json-pair');
  assert.ok(texts.has('user: alice'), 'indexes composite json-pair');
  assert.ok(texts.has('code: 200'), 'indexes scalar json-pair');

  // SSE stream
  const sse = 'data: {"event":"message","id":"msg_101"}\ndata: {"event":"done","count":1}';
  const sseUnits = extractJson(sse);
  const sseTexts = new Set(sseUnits.map((u) => u.text));
  assert.ok(sseTexts.has('msg_101'), 'indexes SSE string value');
  assert.ok(sseTexts.has('id: msg_101'), 'indexes SSE composite json-pair');
  assert.ok(sseTexts.has('event: message'), 'indexes SSE event pair');
});

// 51. Live Endpoint Response Inspection & Indexing
ok('Live Endpoint Data: beautification of endpoint JSON responses & error payloads', () => {
  // Live endpoint error response (e.g. 401/404 JSON)
  const errPayload = '{"status":401,"error":"Unauthorized","message":"API token missing or expired"}';
  const det = detectContentCategory('https://test.com/api/v1/user', 'application/json', errPayload);
  assert.equal(det.category, 'json');
  const beautified = beautifyJson(errPayload);
  assert.ok(beautified.includes('"status": 401'));
  assert.ok(beautified.includes('"error": "Unauthorized"'));

  // Live fetch indexing into RamIndex with method 'live-fetch'
  const idx = new RamIndex();
  const units = extractJson(errPayload);
  for (const u of units) {
    idx.add(u.text, {
      resourceUrl: 'https://test.com/api/v1/user',
      resourceKind: 'api-json',
      route: '/api/v1/user',
      method: 'live-fetch',
      jsonPath: u.extra,
    });
  }
  const scope = defaultScope();
  const hits = searchIndex(idx, 'Unauthorized', { mode: 'exact', scope });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].prov.method, 'live-fetch');
  assert.equal(hits[0].prov.route, '/api/v1/user');
});

// 52. Framework Manifest Mining: Next.js __BUILD_MANIFEST & Webpack chunk maps
ok('Reverse Engineering: Framework Manifest Mining', () => {
  const nextManifest = `
    self.__BUILD_MANIFEST = {
      __rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      "/": ["static/chunks/pages/index-abc.js"],
      "/admin/dashboard": ["static/chunks/pages/admin/dashboard-123.js", "static/chunks/684-xyz.js"],
      "/api/auth/login": ["static/chunks/pages/api/auth-456.js"],
      "/blog/[slug]": ["static/chunks/pages/blog/[slug]-789.js"],
      sortedPages: ["/", "/admin/dashboard", "/api/auth/login", "/blog/[slug]", "/billing/invoices"]
    };
    self.__SSG_MANIFEST = new Set(["/about", "/pricing", "/features"]);
  `;
  const parsed = parseBuildManifest(nextManifest);
  assert.ok(parsed.routes.includes('/'), 'includes root route');
  assert.ok(parsed.routes.includes('/admin/dashboard'), 'includes hidden admin route');
  assert.ok(parsed.routes.includes('/api/auth/login'), 'includes api auth route');
  assert.ok(parsed.routes.includes('/blog/[slug]'), 'includes dynamic bracket route');
  assert.ok(parsed.routes.includes('/billing/invoices'), 'includes route from sortedPages');
  assert.ok(parsed.routes.includes('/about'), 'includes SSG route');
  assert.ok(parsed.chunks.some((c) => c.includes('admin/dashboard')), 'includes admin chunk');
  assert.ok(parsed.chunks.some((c) => c.includes('684-xyz.js')), 'includes shared chunk');

  // Next.js App Router (RSC & app chunk patterns)
  const appRouterHtml = `
    <script src="/_next/static/chunks/app/account/page-999.js" async=""></script>
    <script src="/_next/static/chunks/app/api/webhook/route-888.js" async=""></script>
    <script>self.__next_f.push([1, "1:{\\"segmentPath\\":[\\"children\\",\\"secret-vault\\",\\"children\\"]}"])</script>
  `;
  const parsedApp = parseBuildManifest(appRouterHtml);
  assert.ok(parsedApp.routes.includes('/account'), 'mines App Router /account page');
  assert.ok(parsedApp.routes.includes('/api/webhook'), 'mines App Router /api/webhook route');
  assert.ok(parsedApp.routes.includes('/secret-vault'), 'mines App Router flight segment');

  // Webpack runtime chunk mapping
  const webpackRuntime = `
    __webpack_require__.u = function(chunkId) {
      return "" + chunkId + "." + {
        102: "a1b2c3d4",
        404: "e5f6g7h8",
        999: "adminpanel"
      }[chunkId] + ".js";
    };
  `;
  const wp = parseWebpackChunkMap(webpackRuntime);
  assert.equal(wp.chunkMap['102'], 'a1b2c3d4');
  assert.equal(wp.chunkMap['999'], 'adminpanel');
  assert.ok(wp.chunks.includes('102.a1b2c3d4.js'));
  assert.ok(wp.chunks.includes('999.adminpanel.js'));
});

// 53. AST Parameter & Payload Schema Mining
ok('Reverse Engineering: AST Parameter & Payload Schema Mining', () => {
  const jsCode = `
    async function login(user, pass) {
      const res = await fetch("/api/v1/auth/login?client=web&redirect=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: user,
          password: pass,
          rememberMe: true,
          mfaCode: null
        })
      });
      return res.json();
    }
    function getOrders(page, limit) {
      return axios.get("/api/v1/orders", {
        params: { page, limit, status: 'active', sort: 'desc' }
      });
    }
  `;
  const schemas = extractApiCallSchemas(jsCode);
  assert.ok(schemas.length >= 2, 'extracts both fetch and axios calls');

  const loginSchema = schemas.find((s) => s.url.includes('/login'));
  assert.ok(loginSchema, 'found login endpoint schema');
  assert.equal(loginSchema.method, 'POST');
  assert.ok(loginSchema.params.includes('client'), 'found query param client');
  assert.ok(loginSchema.params.includes('redirect'), 'found query param redirect');
  assert.ok(loginSchema.bodyKeys.includes('username'), 'found body field username');
  assert.ok(loginSchema.bodyKeys.includes('password'), 'found body field password');
  assert.ok(loginSchema.bodyKeys.includes('rememberMe'), 'found body field rememberMe');
  assert.ok(loginSchema.bodyKeys.includes('mfaCode'), 'found body field mfaCode');

  const ordersSchema = schemas.find((s) => s.url.includes('/orders'));
  assert.ok(ordersSchema, 'found orders endpoint schema');
  assert.equal(ordersSchema.method, 'GET');
  assert.ok(ordersSchema.params.includes('page'), 'found query param page');
  assert.ok(ordersSchema.params.includes('limit'), 'found query param limit');
  assert.ok(ordersSchema.params.includes('status'), 'found query param status');
});

// 54. 1-Click Source Map Project ZIP Exporter
ok('Reverse Engineering: 1-Click Source Map Project ZIP Exporter', () => {
  const mockFiles = [
    { path: 'webpack://_N_E/src/components/AdminPanel.tsx', content: 'export const AdminPanel = () => <div>Admin</div>;' },
    { path: 'webpack://_N_E/src/api/auth.ts', content: 'export async function login() { return true; }' },
    { path: 'src/utils/config.ts', content: 'export const API_HOST = "https://api.internal.com";' }
  ];

  const zipBytes = buildSourceMapZip(mockFiles);
  assert.ok(zipBytes instanceof Uint8Array, 'returns Uint8Array');
  assert.ok(zipBytes.length > 200, 'zip has content bytes');

  // Verify PKZIP magic bytes (PK\x03\x04 = 0x04034b50)
  const view = new DataView(zipBytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50, 'valid ZIP local header signature');

  // Verify CRC32 calculation
  const enc = new TextEncoder();
  const c1 = crc32(enc.encode('hello world'));
  assert.equal(typeof c1, 'number');
  assert.equal(c1, 0x0d4a1185, 'accurate standard CRC-32 for hello world');

  // Empty zip returns valid End of Central Directory (22 bytes)
  const emptyZip = buildSourceMapZip([]);
  assert.equal(emptyZip.length, 22);
  const emptyView = new DataView(emptyZip.buffer);
  assert.equal(emptyView.getUint32(0, true), 0x06054b50, 'valid EOCD signature');
});

// 55. GraphQL Operation Registry & Schema Synthesizer
ok('Reverse Engineering: GraphQL Operation Registry & Schema Synthesizer', () => {
  const bundleJs = `
    const GET_USER = gql\`
      query GetUserProfile($id: ID!, $includeHistory: Boolean) {
        user(id: $id) {
          id
          email
          role
          permissions
        }
      }
    \`;
    const MUTATION_UPDATE = \`
      mutation UpdateUserRole($userId: ID!, $newRole: String!) {
        updateUserRole(id: $userId, role: $newRole) {
          success
          message
        }
      }
    \`;
    const USER_FRAG = \`
      fragment CoreUser on User {
        id
        username
      }
    \`;
  `;
  const ops = extractGraphQLOperations(bundleJs);
  assert.ok(ops.length >= 3, 'extracted queries, mutations and fragments');

  const queryOp = ops.find((o) => o.name === 'GetUserProfile');
  assert.ok(queryOp, 'found query');
  assert.equal(queryOp.type, 'query');
  assert.ok(queryOp.variables.some((v) => v.includes('$id: ID!')));

  const mutOp = ops.find((o) => o.name === 'UpdateUserRole');
  assert.ok(mutOp, 'found mutation');
  assert.equal(mutOp.type, 'mutation');
  assert.ok(mutOp.variables.some((v) => v.includes('$userId: ID!')));

  const fragOp = ops.find((o) => o.name === 'CoreUser');
  assert.ok(fragOp, 'found fragment');
  assert.equal(fragOp.type, 'fragment');

  const synthesized = formatGraphQLRegistry(ops);
  assert.ok(synthesized.includes('# DeepScope Synthesized GraphQL Operation Registry'));
  assert.ok(synthesized.includes('query GetUserProfile'));
  assert.ok(synthesized.includes('mutation UpdateUserRole'));
  assert.ok(synthesized.includes('fragment CoreUser on User'));
});

// 56. Client-Side Feature Flag Tampering
ok('Reverse Engineering: Feature Flag Tampering Rewriter', () => {
  // Test flag response JSON tampering logic (from intercept-main)
  const ldResponse = JSON.stringify({
    "flags": {
      "beta-feature": { "value": false, "enabled": false },
      "admin-access": { "value": false },
      "dark-mode": { "value": true }
    },
    "userCanAdminister": false
  });

  // Mirror the tamperFlagJson pure function
  function tamperTest(text) {
    const obj = JSON.parse(text);
    function walk(val) {
      if (val === false) return true;
      if (Array.isArray(val)) return val.map(walk);
      if (val && typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) {
          if (v === false || (k === 'enabled' && v === false)) out[k] = true;
          else out[k] = walk(v);
        }
        return out;
      }
      return val;
    }
    return JSON.stringify(walk(obj));
  }

  const tampered = JSON.parse(tamperTest(ldResponse));
  assert.equal(tampered.flags['beta-feature'].value, true, 'flipped beta-feature to true');
  assert.equal(tampered.flags['beta-feature'].enabled, true, 'flipped enabled to true');
  assert.equal(tampered.flags['admin-access'].value, true, 'flipped admin-access to true');
  assert.equal(tampered.flags['dark-mode'].value, true, 'kept dark-mode true');
  assert.equal(tampered.userCanAdminister, true, 'flipped userCanAdminister to true');
});

// 57. Protobuf & gRPC-Web Wire Decoder
ok('Reverse Engineering: Protobuf & gRPC-Web Wire Decoder', () => {
  const pbBytes = new Uint8Array([0x0A, 5, 0x61, 0x64, 0x6d, 0x69, 0x6e, 0x10, 42]);
  const pb = decodeRawProtobuf(pbBytes);
  assert.equal(pb.fields.length, 2);
  assert.equal(pb.fields[0].value, 'admin');
  assert.equal(pb.fields[1].value, 42);
  assert.ok(pb.formatted.includes('string field_1 = "admin";'));
  assert.ok(pb.formatted.includes('varint field_2 = 42;'));

  // Test gRPC-Web 5-byte header stripping
  const grpcHeader = [0x00, 0x00, 0x00, 0x00, pbBytes.length];
  const grpcBytes = new Uint8Array([...grpcHeader, ...pbBytes]);
  const grpcRes = decodeRawProtobuf(grpcBytes);
  assert.equal(grpcRes.isGrpcWeb, true);
  assert.equal(grpcRes.fields.length, 2);
});

// 58. MessagePack Wire Decoder
ok('Reverse Engineering: MessagePack Wire Decoder', () => {
  const mpBytes = new Uint8Array([
    0x83,
    0xa2, 0x69, 0x64, 0x01,
    0xa4, 0x72, 0x6f, 0x6c, 0x65, 0xa5, 0x61, 0x64, 0x6d, 0x69, 0x6e,
    0xa6, 0x61, 0x63, 0x74, 0x69, 0x76, 0x65, 0xc3
  ]);
  const mp = decodeMsgPack(mpBytes);
  assert.equal(mp.value.id, 1);
  assert.equal(mp.value.role, 'admin');
  assert.equal(mp.value.active, true);
  assert.ok(mp.formatted.includes('"admin"'));
});

// 59. Next.js App Router RSC Flight Stream Decoder
ok('Reverse Engineering: Next.js RSC Flight Stream Decoder', () => {
  const rscStream = `1:I["(app-pages-browser)/./src/Header.tsx",["Header.js"],"default"]\n2:{"id":"7c4e58f001c9053fa28965c7198bb4b067d025ea","bound":null}\n3:{"user":{"id":42,"email":"admin@target.io","role":"superadmin"}}\n4:["$","div",null,{"children":"Welcome Admin"}]`;
  const rsc = decodeRscStream(rscStream);
  assert.equal(rsc.entries.length, 4);
  assert.ok(rsc.serverActions.includes('7c4e58f001c9053fa28965c7198bb4b067d025ea'));
  assert.ok(rsc.sensitiveProps.some((p) => p.key === 'email'));
  assert.ok(rsc.sensitiveProps.some((p) => p.key === 'role'));
  assert.ok(rsc.formatted.includes('Discovered Server Action Hashes'));
  assert.ok(rsc.formatted.includes('admin@target.io'));
});

// 60. Next.js Server Actions Extractor
ok('Reverse Engineering: Next.js Server Actions Extractor', () => {
  const bundle = `
    var $$ACTION_0 = createServerReference("7c4e58f001c9053fa28965c7198bb4b067d025ea", $$ACTION_0_NAME, "updateUserRole");
    var $$ACTION_1 = createServerReference("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", null, "deleteOrg");
    const h = { "next-action": "88776655443322110099887766554433221100aa" };
  `;
  const actions = extractServerActions(bundle);
  assert.equal(actions.length, 3);
  assert.equal(actions[0].id, '7c4e58f001c9053fa28965c7198bb4b067d025ea');
  assert.equal(actions[0].name, 'updateUserRole');
  assert.equal(actions[1].id, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(actions[2].id, '88776655443322110099887766554433221100aa');
});

// 61. Client-Side Validator Schema Miner (Zod & Yup)
ok('Reverse Engineering: Client-Side Validator Schema Miner', () => {
  const code = `
    const userSchema = z.object({
      username: z.string().min(3).max(20),
      email: z.string().email(),
      role: z.enum(["admin", "user", "editor"]),
      isActive: z.boolean().optional()
    });
    const orgSchema = yup.object({
      orgName: yup.string().required(),
      orgEmail: yup.string().email()
    });
  `;
  const schemas = extractValidationSchemas(code);
  assert.equal(schemas.length, 2);
  const zod = schemas.find((s) => s.kind === 'zod');
  assert.ok(zod);
  assert.equal(zod.fields.length, 4);
  assert.equal(zod.fields[0].field, 'username');
  assert.ok(zod.fields[2].rules.includes('enum(admin|user|editor)'));

  const yup = schemas.find((s) => s.kind === 'yup');
  assert.ok(yup);
  assert.equal(yup.fields.length, 2);
  assert.equal(yup.fields[0].field, 'orgName');
});

// 62. Modern Bundlers & De-obfuscation
ok('Reverse Engineering: Modern Bundlers & String De-obfuscation', () => {
  const obf = 'const path = "/api/" + "v1/" + "users"; const hex = "\\x2f\\x61\\x70\\x69";';
  const deobf = deobfuscateJsStrings(obf);
  assert.ok(deobf.includes('"/api/v1/users"'));
  assert.ok(deobf.includes('"/api"'));

  const bmfCode = `
    globalThis.TURBOPACK = ["static/chunks/app_dashboard.js", "static/chunks/vendor.js"];
    const remotes = { "billingApp": "https://billing.internal.net/remoteEntry.js" };
    __vite__mapDeps(["assets/vendor.hash.js"]);
  `;
  const manifests = extractModernBundlerManifests(bmfCode);
  assert.equal(manifests.turbopackChunks.length, 2);
  assert.equal(manifests.turbopackChunks[0], 'static/chunks/app_dashboard.js');
  assert.equal(manifests.federationRemotes.length, 1);
  assert.equal(manifests.federationRemotes[0].name, 'billingApp');
  assert.equal(manifests.vitePreloads.length, 1);

  const relayCode = 'const op = { doc_id: "839201928374659102938475", name: "UserBillingQuery" };';
  const pqs = extractPersistedQueries(relayCode);
  assert.equal(pqs.length, 1);
  assert.equal(pqs[0].id, '839201928374659102938475');
  assert.equal(pqs[0].name, 'UserBillingQuery');
});

// 63. WebAssembly Binary Dissector
ok('Reverse Engineering: WebAssembly Binary Dissector', () => {
  // Construct minimal valid WASM with Export section and Data strings
  // Magic: \0asm (0x00, 0x61, 0x73, 0x6d), Version: 1 (0x01, 0x00, 0x00, 0x00)
  // Section 7 (Export): id=7, size=10
  // count=1, name="authFunc" (len=8), kind=0 (func), index=0
  const exportName = Buffer.from('authFunc');
  const exportPayload = [1, exportName.length, ...exportName, 0, 0];
  const sec7 = [7, exportPayload.length, ...exportPayload];

  // Embedded data string: "/api/v2/secure"
  const dataStr = Buffer.from('/api/v2/secure');
  const wasmHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const testWasm = new Uint8Array([...wasmHeader, ...sec7, ...dataStr]);

  const dis = dissectWasmBinary(testWasm);
  assert.equal(dis.version, 1);
  assert.equal(dis.exports.length, 1);
  assert.equal(dis.exports[0].name, 'authFunc');
  assert.ok(dis.endpoints.includes('/api/v2/secure'));
  assert.ok(dis.formatted.includes('(export "authFunc" (func #0))'));
  assert.ok(dis.formatted.includes('/api/v2/secure'));
});

// 64. Orphan Source-Map Resolver Candidate Generator
ok('Reverse Engineering: Orphan Source-Map Resolver Candidates', () => {
  const url = 'https://app.target.com/assets/chunks/main.a8f92b.js?v=2';
  const candidates = probeOrphanSourceMapCandidates(url);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some((c) => c === 'https://app.target.com/assets/chunks/main.a8f92b.js.map'));
});

// 65. Ephemeral Token & OAuth URL Capture
ok('Storage & Memory: Ephemeral OAuth Token Capture', () => {
  const oauthRedirect = 'https://app.target.com/callback#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c&token_type=Bearer&state=xyz123';
  const TOKEN_PARAM_RE = /(?:code|access_token|id_token|session_token|token|api_key|auth_token|refresh_token)=([a-zA-Z0-9_\-\.]{8,})/gi;
  const captured = [];
  let m;
  while ((m = TOKEN_PARAM_RE.exec(oauthRedirect))) {
    captured.push({ param: m[0].split('=')[0], val: m[1] });
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].param, 'access_token');
  assert.ok(captured[0].val.startsWith('eyJhbGci'));
});

// 66. Streaming LLM SSE Unchunker
ok('Modern Protocols: Streaming LLM SSE Unchunker', () => {
  const ssePayload = [
    'data: {"choices":[{"delta":{"role":"system","content":"You are an internal admin agent."}}]}',
    'data: {"choices":[{"delta":{"content":"Hello "}}]}',
    'data: {"choices":[{"delta":{"content":"world! "}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"queryDatabase","arguments":"{\\"id\\": 42}"}}]}}]}',
    'data: [DONE]'
  ].join('\n\n');

  const decoded = decodeAiStream(ssePayload);
  assert.equal(decoded.chunksCount, 4);
  assert.equal(decoded.fullText, 'Hello world! ');
  assert.equal(decoded.systemPrompts.length, 1);
  assert.equal(decoded.systemPrompts[0], 'You are an internal admin agent.');
  assert.equal(decoded.toolCalls.length, 1);
  assert.equal(decoded.toolCalls[0].name, 'queryDatabase');
  assert.ok(decoded.toolCalls[0].args.includes('42'));
  assert.ok(decoded.formatted.includes('queryDatabase'));
});

// 67. Infrastructure & CSP Domain Parser
ok('Access & Infrastructure: CSP Domain & Bucket Parser', () => {
  const csp = "default-src 'self'; connect-src https://api.target.com https://backend.internal https://vault.corp http://localhost:8080 https://my-bucket.s3.amazonaws.com; script-src 'self' 'unsafe-inline'";
  const rep = parseCspDomains(csp);
  assert.ok(rep.domains.includes('api.target.com'));
  assert.ok(rep.domains.includes('backend.internal'));
  assert.ok(rep.internalDomains.includes('backend.internal'));
  assert.ok(rep.internalDomains.includes('vault.corp'));
  assert.ok(rep.internalDomains.includes('localhost'));
  assert.ok(rep.cloudBuckets.includes('my-bucket.s3.amazonaws.com'));
  assert.ok(rep.directives['connect-src'].length >= 5);
});

// 68. API Payload Schema Diff
ok('Reverse Engineering: API Payload Schema Diff', () => {
  const reqJson = JSON.stringify({ email: 'user@example.com', name: 'Alice' });
  const resJson = JSON.stringify({ id: 101, email: 'user@example.com', name: 'Alice', is_admin: true, password_hash: 'abc', role: 'user' });
  const diff = diffEndpointFields(resJson, reqJson);

  assert.deepEqual(diff.sharedFields, ['email', 'name']);
  assert.ok(diff.responseOnlyFields.includes('is_admin'));
  assert.ok(diff.responseOnlyFields.includes('password_hash'));
  assert.ok(diff.responseOnlyFields.includes('role'));
  assert.equal(diff.requestOnlyFields.length, 0);
});

// 69. Path Parameter Normalizer
ok('Access & Routing: Path Parameter Normalizer', () => {
  assert.equal(normalizeDynamicPath('/users/12345/profile'), '/users/{id}/profile');
  assert.equal(normalizeDynamicPath('/orders/550e8400-e29b-41d4-a716-446655440000/items'), '/orders/{uuid}/items');
  assert.equal(normalizeDynamicPath('/posts/64a7f2e5c8e1a2b3c4d5e6f7/comments'), '/posts/{hash}/comments');
  assert.equal(normalizeDynamicPath('/static/path'), '/static/path');
});

// 70. Cloud BaaS Configuration Extractor
ok('Cloud BaaS: Extract Firebase, Supabase, and Sentry Configs', () => {
  const jsSrc = `
    const firebaseConfig = {
      apiKey: "AIzaSyD-TEST1234567890abcdefghijklmnop",
      authDomain: "target-prod.firebaseapp.com",
      projectId: "target-prod",
      storageBucket: "target-prod.appspot.com"
    };
    const client = createClient("https://xyzcompany.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abcdef");
    Sentry.init({ dsn: "https://abc1234@o123456.ingest.sentry.io/456789" });
  `;
  const configs = extractCloudConfigs(jsSrc);
  assert.equal(configs.length, 3);
  const fb = configs.find(c => c.provider === 'firebase');
  const supa = configs.find(c => c.provider === 'supabase');
  const sentry = configs.find(c => c.provider === 'sentry');

  assert.ok(fb);
  assert.equal(fb.details.apiKey, 'AIzaSyD-TEST1234567890abcdefghijklmnop');
  assert.equal(fb.details.projectId, 'target-prod');
  assert.ok(supa);
  assert.equal(supa.details.url, 'https://xyzcompany.supabase.co');
  assert.ok(sentry);
  assert.ok(sentry.details.dsn.includes('sentry.io'));
});

// 71. AI Dossier Privacy & Sanitization Engine
ok('AI Export: Privacy & Sensitive Data Redaction Engine', () => {
  const sensitiveText = 'User logged in: alice.smith+dev@gmail.com with password: "superSecretPassword123!" and token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.xyz';
  const clean = sanitizeForAi(sensitiveText);
  assert.ok(!clean.includes('alice.smith+dev@gmail.com'));
  assert.ok(clean.includes('[USER_EMAIL_REDACTED]'));
  assert.ok(!clean.includes('superSecretPassword123!'));
  assert.ok(clean.includes('[REDACTED_SECRET]'));
  assert.ok(!clean.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(clean.includes('[REDACTED_JWT]'));

  const headers = {
    'Cookie': 'SID=googleSessionToken123456789; HSID=secretHsid; user_id=42',
    'Set-Cookie': '__Secure-3PSID=xyzToken987654321; Path=/',
    'Authorization': 'Bearer ya29.a0AfH6SM-personalGoogleAccessToken123456789',
    'Content-Type': 'application/json',
  };
  const cleanHeaders = sanitizeHeadersForAi(headers);
  assert.equal(cleanHeaders['Cookie'], '[REDACTED_COOKIES]');
  assert.equal(cleanHeaders['Set-Cookie'], '[REDACTED_COOKIES]');
  assert.equal(cleanHeaders['Authorization'], 'Bearer [REDACTED_AUTH_TOKEN]');
  assert.equal(cleanHeaders['Content-Type'], 'application/json');
});

// 72. Full AI Dossier JSON Generation
ok('AI Export: Build Structured AI Dossier with Endpoints & Leaks', () => {
  const dossier = buildAiDossier({
    origin: 'https://api.target.com',
    frameworks: ['Next.js 15'],
    routes: ['/api/v1/users', '/api/v1/admin/uncalled', '/about'],
    netEntries: [
      {
        method: 'POST',
        url: 'https://api.target.com/api/v1/users/123',
        status: 200,
        mime: 'application/json',
        reqHeaders: { 'Authorization': 'Bearer secret123456789012345', 'Content-Type': 'application/json' },
        resHeaders: { 'Content-Type': 'application/json' },
        reqBody: JSON.stringify({ email: 'target.user@company.com', name: 'Bob' }),
      }
    ],
    rawBodies: new Map([
      ['https://api.target.com/api/v1/users/123', JSON.stringify({ id: 123, email: 'target.user@company.com', name: 'Bob', internal_hash: 'abc', role: 'admin' })]
    ]),
    serverActions: [{ id: 'action_hash_1234', name: 'updateProfile' }],
    graphqlOps: [{ name: 'GetUser', type: 'query' }],
    persistedQueries: [{ id: 'query_hash_abc', name: 'ViewerQuery' }],
    validationSchemas: [{ name: 'UserSchema', fields: [{ field: 'role', type: 'string' }] }],
    stateStores: [{ name: 'zustand/authStore', keys: ['currentUser', 'authToken'] }],
    resources: [{ url: 'https://api.target.com/static/js/bundle.js', kind: 'script', mime: 'application/javascript', size: 45000 }],
    sourceFiles: [{ path: 'src/lib/api.ts', size: 1200 }],
    webSockets: [{ url: 'wss://api.target.com/ws', frames: 42, bytes: 2048 }],
    cloudConfigs: [{ provider: 'firebase', details: { apiKey: 'AIzaSyD-123' } }],
    cspReport: {
      domains: ['api.target.com', 'vault.internal'],
      internalDomains: ['vault.internal'],
      cloudBuckets: ['data.s3.amazonaws.com'],
    },
    findings: [
      { rule: 'jwt', sev: 'high', label: 'Exposed JWT', text: 'token for admin@gmail.com' }
    ]
  });

  assert.equal(dossier.$schema, 'DeepScope-AI-Dossier-v1');
  assert.equal(dossier.meta.targetOrigin, 'https://api.target.com');
  assert.equal(dossier.summary.calledEndpoints, 1);
  assert.equal(dossier.summary.uncalledEndpoints, 2); // /api/v1/users and /api/v1/admin/uncalled (not /about)
  assert.equal(dossier.pageRoutes.length, 1);
  assert.equal(dossier.pageRoutes[0].route, '/about');
  assert.equal(dossier.resources.length, 1);
  assert.equal(dossier.resources[0].kind, 'script');
  assert.equal(dossier.sourceFiles.length, 1);
  assert.equal(dossier.sourceFiles[0].path, 'src/lib/api.ts');
  assert.equal(dossier.webSockets.length, 1);
  assert.equal(dossier.persistedQueries.length, 1);
  assert.equal(dossier.serverActions.length, 1);
  assert.equal(dossier.validationSchemas.length, 1);
  assert.equal(dossier.clientStateStores.length, 1);
  assert.equal(dossier.summary.resourcesCount, 1);
  assert.equal(dossier.summary.pageRoutesCount, 1);
  assert.equal(dossier.summary.validationSchemasCount, 1);
  assert.equal(dossier.summary.clientStateStoresCount, 1);
  assert.equal(dossier.cloudBaaS.length, 1);
  assert.equal(dossier.infrastructure.internalDomains[0], 'vault.internal');

  // Verify personal email was redacted from body & finding
  const ep = dossier.endpoints.find(e => e.method === 'POST');
  assert.ok(ep);
  assert.equal(ep.normalizedPath, '/api/v1/users/{id}');
  assert.ok(ep.schemaDiff);
  assert.ok(ep.schemaDiff.responseOnlyFields.includes('internal_hash'));
  assert.ok(!JSON.stringify(ep.requestSample).includes('target.user@company.com'));
  assert.ok(JSON.stringify(ep.requestSample).includes('[USER_EMAIL_REDACTED]'));
  assert.ok(!JSON.stringify(dossier.securityFindings).includes('admin@gmail.com'));
});

console.log(`\n${pass} checks passed.`);
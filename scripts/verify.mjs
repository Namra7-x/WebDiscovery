// DeepScope smoke verification — runs locally against compiled dist/ output.
// Usage (from this folder only):  node scripts/verify.mjs
import assert from 'node:assert/strict';
import { normalize, hashStr, normalizeWithMap, snippetWithSpans } from '../dist/normalize.js';
import { fuzzyScore, fuzzyMatch } from '../dist/fuzzy.js';
import { extractJs, extractJson, extractCss, extractHtml, classifyPath, isApiEndpoint, collectLiterals, extractJsAdvanced } from '../dist/extractors.js';
import { RamIndex } from '../dist/indexer.js';
import { searchIndex, displayNameFor } from '../dist/search.js';
import { groupMime, netGroupCounts, netMethodCounts, optionsHtml, resourceKindCounts, buildCurl, severityRank, hostOf, groupByHost, snippetBody } from '../dist/tables.js';
import { SECRET_RULES, scanTextForSecrets, isPlaceholder, decodeJwtAlg, shannon } from '../dist/rules.js';
import { classifyApiKind, findExposures } from '../dist/exposure.js';
import { MemoryLedger } from '../dist/memory.js';
import { CaptureStore } from '../dist/store.js';
import { DiscoveryGraph } from '../dist/graph.js';
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

console.log(`\n${pass} checks passed.`);
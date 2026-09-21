import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { generateExamples } from '../../dashboard-ui/app/api-tools/examples.js';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { config, document, credential, jsonResponse } from './fixtures.js';
const base = { method: 'GET', url: 'https://backend.example/api/health', headers: {}, authentication: 'none', body: null, bodyKind: 'none' };

test('cURL quotes hostile literal data, uses runtime auth only, and never follows redirects', () => {
  const input = { ...base, method: 'POST', authentication: 'bearer', headers: { authorization: '[REDACTED]', 'content-type': 'text/plain', 'idempotency-key': "a'$(touch /tmp/not-actually-run)" }, bodyKind: 'text', body: "@/etc/passwd\n'$(whoami)" };
  const { curl } = generateExamples(input);
  assert.match(curl, /API_TOKEN:\?Set API_TOKEN/); assert.match(curl, /--globoff/); assert.match(curl, /--data-raw/);
  assert.doesNotMatch(curl, /--location|--verbose|Bearer \[REDACTED\]/);
  execFileSync('bash', ['-n'], { input: curl }); // Parse shell syntax; do NOT execute the snippet.
  // Replace curl with a local printf function: inspect argument quoting without network or expansion.
  const output = execFileSync('bash', ['-c', `curl() { printf '%s\\0' "$@"; }; export API_TOKEN=test-runtime-token;\n${curl}`], { encoding: 'utf8' }).split('\0');
  assert.ok(output.includes(input.body)); assert.ok(output.includes(`idempotency-key: ${input.headers['idempotency-key']}`));
  assert.ok(output.includes('Authorization: Bearer test-runtime-token'));
});

test('generated JavaScript is inert until called; correct fetch options/body and runtime auth', async () => {
  const calls = [], expected = { title: '"</script>\n${throw new Error()}', password: '[REDACTED]' };
  const { javascript } = generateExamples({ ...base, method: 'POST', authentication: 'bearer', headers: { 'content-type': 'application/json', authorization: '[REDACTED]' }, bodyKind: 'json', body: expected });
  const context = vm.createContext({ fetch: async (...args) => { calls.push(args); return { status: 201 }; } });
  vm.runInContext(javascript, context); assert.equal(calls.length, 0);
  await assert.rejects(context.sendRequest(), /runtime API token/);
  assert.equal((await context.sendRequest({ apiToken: 'runtime-only' })).status, 201);
  const [url, init] = calls[0]; assert.equal(url, base.url); assert.equal(init.headers.Authorization, 'Bearer runtime-only');
  assert.deepEqual(JSON.parse(init.body), expected); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(javascript, /console\.|localStorage|runtime-only/);
});

test('public, HEAD and binary examples use the appropriate runtime inputs', async () => {
  const publicExamples = generateExamples(base); assert.doesNotMatch(publicExamples.curl, /Authorization|API_TOKEN/); assert.doesNotMatch(publicExamples.javascript, /apiToken/);
  const head = generateExamples({ ...base, method: 'HEAD' }); assert.match(head.curl, /--head/); assert.doesNotMatch(head.curl, /--data/);
  const binary = generateExamples({ ...base, method: 'PUT', bodyKind: 'binary', body: { size: 3 } });
  assert.match(binary.curl, /--data-binary '@\/path\/to\/upload.bin'/); assert.match(binary.javascript, /body: bodyFile/);
  const calls = [], file = new Blob(['abc']); const context = vm.createContext({ fetch: (...args) => calls.push(args) });
  vm.runInContext(binary.javascript, context); await context.sendRequest({ bodyFile: file }); assert.equal(calls[0][1].body, file);
});

test('real connector preview to both generators never exports active or body credentials', async () => {
  const api = createTelegraphConnection(config, { fetchImpl: async () => jsonResponse(document) }).api;
  const preview = await api.previewRequest({ endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { password: 'another-secret-fixture', echoed: credential } });
  const examples = generateExamples(preview);
  assert.doesNotMatch(JSON.stringify(examples), new RegExp(`${credential}|another-secret-fixture`));
  assert.match(examples.curl, /\[REDACTED\]/); assert.match(examples.javascript, /\[REDACTED\]/);
  for (const url of ['http://example.org/', 'https://user:pass@example.org/', 'javascript:alert(1)']) assert.throws(() => generateExamples({ ...base, url }), /Unsafe/);
  assert.throws(() => generateExamples({ ...base, authentication: 'awsSigV4' }), /compatible connector/);
});

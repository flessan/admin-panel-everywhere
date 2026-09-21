import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiController } from '../../dashboard-ui/app/api-tools/controller.js';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { config, document, credential, jsonResponse, deferred, parameter, flush } from './fixtures.js';
function setup(handler = () => jsonResponse({ message: 'yes' }), options) {
  const calls = [];
  const connection = createTelegraphConnection(config, { fetchImpl: async (url, init) => { calls.push({ url, ...init }); return new URL(url).pathname === '/openapi.json' ? jsonResponse(document) : handler(url, init); } });
  const controller = createApiController(options); controller.connect(connection);
  return { controller, connection, calls };
}
const select = async (controller, id = 'GET /api/health') => { await controller.load(); controller.select(id); };

test('catalog is lazy; preview has no operation call; explicit execution records a redacted result', async () => {
  const { controller, calls } = setup(() => jsonResponse({ echo: credential, access_token: 'issued-opaque-fixture-value' }, 401));
  assert.equal(calls.length, 0); await select(controller);
  await controller.preview({}); assert.equal(calls.length, 1); assert.equal(controller.snapshot().history.length, 0);
  await controller.execute({}); assert.equal(calls.length, 2);
  const state = controller.snapshot(); assert.equal(state.response.status, 401); assert.equal(state.history.length, 1);
  assert.equal(state.history[0].response.data.access_token, '[REDACTED]'); assert.doesNotMatch(JSON.stringify(state), new RegExp(credential));
  state.history[0].operation = 'mutated copy'; assert.notEqual(controller.snapshot().history[0].operation, 'mutated copy');
});

test('mutation acknowledgement, schema inputs, errors and repeated submission are controlled', async () => {
  const late = deferred(), { controller, calls } = setup(() => late.promise);
  await select(controller, 'POST /api/db/{collection}');
  const input = { parameters: [parameter('collection', 'notes')], contentType: 'application/json', bodyText: '{"title":"yes"}' };
  await controller.execute(input); assert.equal(calls.length, 1); assert.match(controller.snapshot().error, /Confirm execution/);
  const pending = controller.execute({ ...input, allowMutation: true }); await flush();
  await controller.execute({ ...input, allowMutation: true }); controller.select('GET /api/health');
  assert.equal(controller.snapshot().selected, 'POST /api/db/{collection}'); assert.equal(calls.length, 2);
  late.resolve(jsonResponse({ id: 'one' }, 201)); await pending;
  assert.equal(controller.snapshot().history.length, 1); assert.equal(controller.snapshot().running, false);
});

test('history is bounded, selectable, clearable, never resurrected by an in-flight request', async () => {
  const { controller } = setup(undefined, { historyLimit: 2 }); await select(controller);
  for (let i = 0; i < 3; i++) await controller.execute({});
  assert.equal(controller.snapshot().history.length, 2);
  controller.selectHistory(controller.snapshot().history[0].id); assert.ok(controller.snapshot().historySelected);
  controller.clearHistory(); assert.equal(controller.snapshot().history.length, 0); assert.equal(controller.snapshot().historySelected, null);
  const late = deferred(); const fixture = setup(() => late.promise); await select(fixture.controller);
  const pending = fixture.controller.execute({}); await flush(); fixture.controller.clearHistory(); late.resolve(jsonResponse({ ok: true })); await pending;
  assert.equal(fixture.controller.snapshot().history.length, 0);
});

test('disconnect discards late responses and clears catalog, examples, response and history', async () => {
  const late = deferred(), { controller } = setup(() => late.promise); await select(controller);
  const pending = controller.execute({}); await flush(); controller.connect(null);
  late.resolve(jsonResponse({ access_token: 'never-display-me' })); await pending;
  const state = controller.snapshot(); assert.equal(state.connected, false); assert.equal(state.document, null); assert.deepEqual(state.operations, []);
  assert.equal(state.response, null); assert.equal(state.examples, null); assert.deepEqual(state.history, []);
});

test('late discovery from a prior connection cannot overwrite the new catalog', async () => {
  const late = deferred(), controller = createApiController();
  const old = createTelegraphConnection(config, { fetchImpl: async () => late.promise });
  controller.connect(old); const pending = controller.load();
  const fresh = createTelegraphConnection(config, { fetchImpl: async () => jsonResponse({ ...document, info: { title: 'New connection', version: '2' } }) });
  controller.connect(fresh); await controller.load(); late.resolve(jsonResponse(document)); await pending;
  assert.equal(controller.snapshot().document.info.title, 'New connection');
});

test('network and cancellation errors are safe and do not retry; stale response is cleared', async () => {
  let fail = false; const { controller, calls } = setup(() => { if (fail) throw new Error(credential); return jsonResponse({ ok: true }); });
  await select(controller); await controller.execute({}); fail = true; await controller.execute({});
  assert.equal(controller.snapshot().response, null); assert.match(controller.snapshot().error, /connectivity/);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), new RegExp(credential)); assert.equal(calls.length, 3);
  const late = deferred(), fixture = setup(() => late.promise); await select(fixture.controller);
  const pending = fixture.controller.execute({}); await flush(); fixture.controller.cancel(); late.resolve(jsonResponse({ unsafe: true })); await pending;
  assert.equal(fixture.controller.snapshot().response, null); assert.match(fixture.controller.snapshot().error, /cancelled/);
});

test('documentation-only selection cannot preview/execute; a new selection clears old examples', async () => {
  const { controller, calls } = setup(); await select(controller); await controller.preview({});
  controller.select('GET /s3/{bucket}'); assert.equal(controller.snapshot().examples, null);
  await controller.execute({}); assert.match(controller.snapshot().error, /documentation-only/); assert.equal(calls.length, 1);
  controller.select('GET /invented'); assert.equal(controller.snapshot().selected, 'GET /s3/{bucket}');
});

test('same controller supports a non-Telegraph OpenAPI backend without UI route knowledge', async () => {
  const { createOpenApiClient } = await import('../../dashboard-ui/app/connection/openapi.js');
  const requests = [];
  const api = createOpenApiClient({ assertOpen() {}, load: async () => ({ openapi: '3.0.3', info: { title: 'Widget backend' }, paths: { '/widgets/{id}': { get: { tags: ['Widgets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } } } }), routes: {
    supports: id => id === 'GET /widgets/{id}',
    describe: (_id, request) => ({ method: 'GET', url: `https://widgets.example/widgets/${encodeURIComponent(request.pathParameters.id)}`, headers: {}, authentication: 'none', body: null, bodyKind: 'none' }),
    request: async (id, options) => { requests.push({ id, options }); return { status: 200, ok: true, headers: {}, data: { label: 'Widget' }, bodyKind: 'json', omitted: false }; },
  } });
  const controller = createApiController(); controller.connect({ api, metadata: { baseUrl: 'https://widgets.example' } });
  await controller.load(); controller.select('GET /widgets/{id}'); await controller.execute({ parameters: [parameter('id', 'two words')] });
  assert.equal(requests.length, 1); assert.equal(requests[0].options.inspection, true);
  assert.match(controller.snapshot().examples.javascript, /https:\/\/widgets.example\/widgets\/two%20words/);
  assert.equal(controller.snapshot().response.data.label, 'Widget');
});

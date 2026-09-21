import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { document, credential, config, jsonResponse, deferred } from './fixtures.js';
import { PREVIEW_BYTES } from '../../dashboard-ui/app/connection/inspection.js';

function setup(handler = () => jsonResponse({ ok: true }), options = {}) {
  const calls = [], logs = [];
  const connection = createTelegraphConnection(config, { logger: event => logs.push(event), ...options, fetchImpl: async (url, init) => {
    calls.push({ url, ...init }); return new URL(url).pathname === '/openapi.json' ? jsonResponse(document) : handler(url, init);
  } });
  return { connection, calls, logs, api: connection.api };
}

test('inspection retains HTTP error status/headers/body while existing execute still rejects errors', async () => {
  const { api, calls, logs } = setup(() => jsonResponse({ error: { code: 'version_conflict', message: 'Changed' } }, 409, { ETag: '"v2"' }));
  const result = await api.inspect({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' } });
  assert.equal(result.status, 409); assert.equal(result.ok, false); assert.equal(result.headers.etag, '"v2"');
  assert.equal(result.data.error.code, 'version_conflict');
  assert.equal(calls[0].headers.has('authorization'), false);
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${credential}`);
  assert.equal(new URL(calls[1].url).origin, 'https://backend.example');
  assert.equal(calls[1].redirect, 'error'); assert.equal(calls[1].credentials, 'omit');
  assert.equal(JSON.stringify(logs).includes(credential), false);
  await assert.rejects(api.execute({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' } }), { status: 409 });
});

test('undocumented/unsupported endpoints and mutations without consent never execute', async () => {
  const { api, calls } = setup();
  for (const endpointId of ['GET /invented', 'GET /s3/{bucket}', 'GET /not-approved']) await assert.rejects(api.inspect({ endpointId }), { code: 'unsupported_operation' });
  await assert.rejects(api.inspect({ endpointId: 'POST /api/auth/token' }), { code: 'invalid_request' });
  assert.equal(calls.length, 1);
  await api.inspect({ endpointId: 'POST /api/auth/token', allowMutation: true, json: { expires_in: 120 } });
  assert.equal(calls.length, 2); assert.equal(calls[1].body, '{"expires_in":120}');
});

test('request preview is redacted, uses configured origin, encodes paths, and never performs the operation', async () => {
  const { api, calls } = setup();
  const result = await api.previewRequest({ endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { title: 'yes', password: 'private-body-value', echoed: credential } });
  assert.equal(calls.length, 1); assert.equal(result.authentication, 'bearer'); assert.equal(result.headers.authorization, '[REDACTED]');
  assert.equal(result.body.password, '[REDACTED]'); assert.equal(result.body.echoed, '[REDACTED]');
  assert.equal(result.url, 'https://backend.example/api/db/notes');
  const storage = await api.previewRequest({ endpointId: 'PUT /api/storage/{bucket}/{key}', pathParameters: { bucket: 'media', key: 'folder/a b.txt' }, body: new Blob(['abc']) });
  assert.match(storage.url, /folder\/a%20b.txt$/); assert.equal(storage.bodyKind, 'binary'); assert.equal(storage.body.size, 3);
  assert.equal(JSON.stringify(storage).includes('abc'), false);
});

test('credentials cannot enter URLs or override auth; remote server entries cannot redirect keys', async () => {
  const { api, calls } = setup();
  for (const options of [{ query: { token: 'test' } }, { query: { title: credential } }, { headers: { authorization: 'evil' } }, { pathParameters: { collection: credential } }]) {
    await assert.rejects(api.inspect({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' }, ...options }));
  }
  assert.equal(calls.length, 1);
});

test('response redaction handles credentials, issued tokens, echoed aliases, headers and safe document schemas', async () => {
  const issued = 'newly-issued-opaque-fixture-value';
  const { api } = setup(() => jsonResponse({ access_token: issued, alias: issued, echo: credential, nested: { Authorization: `Bearer ${credential}`, password: 'swordfish-fixture' } }, 200,
    { 'X-Echo': credential, Location: `https://example.invalid/?token=${issued}`, Authorization: `Bearer ${credential}` }));
  const result = await api.inspect({ endpointId: 'POST /api/auth/token', allowMutation: true });
  const text = JSON.stringify(result);
  for (const secret of [credential, issued, 'swordfish-fixture']) assert.equal(text.includes(secret), false);
  assert.equal(result.data.access_token, '[REDACTED]'); assert.equal(result.data.alias, '[REDACTED]');
  const safeDoc = api.sanitizeDocument(await api.discoverOpenApi());
  assert.equal(safeDoc.components.schemas.Document.properties.password.type, 'string');
  assert.equal(safeDoc.components.schemas.Document.properties.password.example, '[REDACTED]');
});

test('text/HTML is inert data; binary and oversized bodies are omitted; HEAD/204 are empty', async () => {
  let response = new Response('<script>alert(1)</script> password=not-for-display', { headers: { 'Content-Type': 'text/html' } });
  const { api } = setup(() => response);
  let result = await api.inspect({ endpointId: 'GET /api/health' });
  assert.equal(result.bodyKind, 'text'); assert.match(result.data, /<script>/); assert.doesNotMatch(result.data, /not-for-display/);
  response = new Response(new Uint8Array([255, 0, 1]), { headers: { 'Content-Type': 'application/octet-stream' } });
  result = await api.inspect({ endpointId: 'GET /api/health' }); assert.equal(result.bodyKind, 'binary');
  response = new Response('x'.repeat(PREVIEW_BYTES + 1), { headers: { 'Content-Type': 'text/plain' } });
  result = await api.inspect({ endpointId: 'GET /api/health' }); assert.equal(result.omitted, true); assert.equal(result.bodyKind, 'omitted'); assert.ok(JSON.stringify(result).length < 500);
  response = new Response(null, { status: 204 });
  result = await api.inspect({ endpointId: 'GET /api/health' }); assert.equal(result.data, null);
  response = new Response(null, { headers: { 'Content-Length': '100', ETag: '"head"' } });
  result = await api.inspect({ endpointId: 'HEAD /api/storage/{bucket}/{key}', pathParameters: { bucket: 'media', key: 'a' } }); assert.equal(result.data, null); assert.equal(result.headers.etag, '"head"');
});

test('connection close and abort reject late inspection without exposing response data', async () => {
  const late = deferred(); const { connection, api } = setup(() => late.promise);
  await api.discoverOpenApi();
  const pending = api.inspect({ endpointId: 'GET /api/health' });
  await new Promise(resolve => setTimeout(resolve, 0)); connection.disconnect(); late.resolve(jsonResponse({ echo: credential }));
  await assert.rejects(pending, { code: 'request_aborted' });
});

test('preview bounds request history bodies, preserves JSON media types, and rejects detected URL secrets', async () => {
  const { api } = setup();
  const request = { endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { title: 'x'.repeat(PREVIEW_BYTES) } };
  const preview = await api.previewRequest(request); assert.equal(preview.bodyOmitted, true); assert.ok(JSON.stringify(preview).length < 500);
  const typed = await api.previewRequest({ ...request, json: { title: 'x' }, headers: { 'Content-Type': 'application/vnd.fixture+json' } });
  assert.equal(typed.headers['content-type'], 'application/vnd.fixture+json');
  await assert.rejects(api.previewRequest({ endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { password: 'notes' } }), { code: 'invalid_request' });
});

test('unknown binary encoding is omitted and document redaction preserves schema property definitions', async () => {
  const { api } = setup(() => new Response(new Uint8Array([255, 0, 1])));
  assert.equal((await api.inspect({ endpointId: 'GET /api/health' })).bodyKind, 'binary');
  const sanitized = api.sanitizeDocument({ components: { schemas: { default: { type: 'object', properties: { default: { type: 'string', default: 'sensitive-default' }, example: { type: 'string' } } } } } });
  assert.equal(sanitized.components.schemas.default.properties.default.type, 'string');
  assert.equal(sanitized.components.schemas.default.properties.example.type, 'string');
  assert.equal(sanitized.components.schemas.default.properties.default.default, '[REDACTED]');
});

test('secret values matching protocol words cannot erase fixed inspector/preview metadata', async () => {
  const { api } = setup(() => jsonResponse({ password: 'status', secret: 'json' }));
  const result = await api.inspect({ endpointId: 'GET /api/health' });
  assert.equal(result.status, 200); assert.equal(result.bodyKind, 'json'); assert.equal(result.data.password, '[REDACTED]');
  const preview = await api.previewRequest({ endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { password: 'POST', secret: 'bodyKind' } });
  assert.equal(preview.method, 'POST'); assert.equal(preview.bodyKind, 'json'); assert.equal(preview.body.password, '[REDACTED]');
  for (const headers of [{ Authorization: 'unsafe' }, { 'X-Arbitrary': 'not-permitted' }]) {
    await assert.rejects(api.previewRequest({ endpointId: 'GET /api/health', headers }), { code: 'invalid_request' });
  }
});

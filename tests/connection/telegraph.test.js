import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { defineConnection } from '../../dashboard-ui/app/connection/contract.js';
import { config, record, spec, json, mockFetch } from './fixtures.js';

const code = expected => error => {
  assert.equal(error.code, expected);
  assert.ok(!inspect(error).includes(config.TELEGRAPH_API_KEY));
  return true;
};
function setup(respond, options = {}) {
  const mock = mockFetch(respond);
  return { ...mock, connection: createTelegraphConnection(config, { ...mock, ...options }) };
}

test('initialization exposes the complete contract without requests or public credentials', () => {
  const { connection, calls } = setup();
  assert.equal(defineConnection(connection), connection);
  assert.equal(connection.metadata.connector, 'telegraph');
  assert.equal(connection.metadata.project, 'prj_test');
  assert.equal(connection.metadata.projectAuthorization, 'credential');
  assert.equal(connection.authentication.configured, true);
  assert.ok(Object.isFrozen(connection));
  assert.ok(Object.isFrozen(connection.metadata.capabilities));
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(connection).includes(config.TELEGRAPH_API_KEY));
  assert.ok(!inspect(connection, { getters: true }).includes(config.TELEGRAPH_API_KEY));
});

for (const key of Object.keys(config)) {
  for (const value of [undefined, '', ' ']) {
    test(`initialization rejects missing/blank ${key}: ${String(value)}`, () => {
      assert.throws(() => createTelegraphConnection({ ...config, [key]: value }), code('invalid_configuration'));
    });
  }
}
for (const url of ['http://telegraph.example', 'not a URL', 'https://user:secret@example.com',
  'https://example.com?api_key=secret', 'https://example.com/#secret', 'https://example.com/api']) {
  test(`initialization rejects unsafe base URL: ${url}`, () => {
    assert.throws(() => createTelegraphConnection({ ...config, TELEGRAPH_URL: url }), code('invalid_configuration'));
  });
}

test('credential header injection and invalid project context are rejected', () => {
  assert.throws(() => createTelegraphConnection({ ...config, TELEGRAPH_API_KEY: 'test\r\nX-Injected: yes' }), code('invalid_configuration'));
  assert.throws(() => createTelegraphConnection({ ...config, TELEGRAPH_PROJECT: '../other' }), code('invalid_configuration'));
});

test('collections and schemas are explicit configured hints, not fabricated network discovery', async () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };
  const { connection, calls } = setup(undefined, { collections: ['notes', { name: 'products', schema }] });
  schema.properties.title.type = 'number';
  const list = await connection.database.listCollections();
  assert.equal(list.source, 'configured');
  assert.equal(list.complete, false);
  assert.equal(list.items.length, 2);
  assert.equal((await connection.database.getCollectionSchema('products')).schema.properties.title.type, 'string');
  assert.deepEqual(await connection.database.getCollectionSchema('unknown'), { schema: null, source: 'unavailable' });
  list.items[0].name = 'changed';
  assert.equal((await connection.database.listCollections()).items[0].name, 'notes');
  assert.equal(calls.length, 0);
  assert.equal(connection.metadata.capabilities.collectionManagement, false);
});

test('list constructs Bearer request with filters/cursor and does not send project context', async () => {
  const { connection, calls } = setup(() => json({ data: [record], has_more: true, next_cursor: 'next' }));
  const page = await connection.database.listRecords('notes', { limit: 7, cursor: 'a+b/=', filters: { title: 'hello world' } });
  const request = calls[0];
  const url = new URL(request.url);
  assert.equal(url.pathname, '/api/db/notes');
  assert.equal(url.searchParams.get('limit'), '7');
  assert.equal(url.searchParams.get('cursor'), 'a+b/=');
  assert.equal(url.searchParams.get('title'), 'hello world');
  assert.equal(request.headers.get('Authorization'), `Bearer ${config.TELEGRAPH_API_KEY}`);
  assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.body, undefined);
  assert.ok(!request.url.includes(config.TELEGRAPH_PROJECT));
  assert.ok(!request.url.includes(config.TELEGRAPH_API_KEY));
  assert.equal(page.items[0].id, 'rec_one');
  assert.equal(page.items[0].data.done, false);
  assert.equal(page.items[0].data.count, 0);
  assert.equal(page.nextCursor, 'next');
  assert.equal(page.hasMore, true);
});

test('get accepts top-level ID form without losing the document', async () => {
  const { connection, calls } = setup(() => json({ ...record, id: 'rec_one' }));
  const result = await connection.database.getRecord('notes', 'rec_one');
  assert.equal(result.id, 'rec_one');
  assert.equal(calls[0].url, 'https://telegraph.example/api/db/notes/rec_one');
});

test('create handles 201, JSON and an idempotency key without project authorization fields', async () => {
  const { connection, calls } = setup(() => json(record, 201), { createIdempotencyKey: () => 'test-attempt-1' });
  await connection.database.createRecord('notes', { title: 'hello', done: false });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.equal(calls[0].headers.get('idempotency-key'), 'test-attempt-1');
  assert.deepEqual(JSON.parse(calls[0].body), { title: 'hello', done: false });
  await connection.database.createRecord('notes', { title: 'hello' }, { idempotencyKey: 'same-attempt' });
  assert.equal(calls[1].headers.get('idempotency-key'), 'same-attempt');
});

test('update and delete use stable IDs and required expected-version bodies', async () => {
  const { connection, calls } = setup();
  await connection.database.updateRecord('notes', 'rec_one', { done: true }, { expectedVersion: 2 });
  await connection.database.deleteRecord('notes', 'rec_one', { expectedVersion: 3 });
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].body), { done: true, _expected_version: 2 });
  assert.equal(calls[1].method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].body), { _expected_version: 3 });
  assert.ok(calls.every(call => call.url.endsWith('/rec_one')));
  await assert.rejects(connection.database.updateRecord('notes', 'rec_one', { done: true }), code('invalid_request'));
  await assert.rejects(connection.database.deleteRecord('notes', 'rec_one', { expectedVersion: 0 }), code('invalid_request'));
  assert.equal(calls.length, 2);
});

test('managed fields, invalid pagination/filter values and path traversal fail before fetch', async () => {
  const { connection, calls } = setup();
  await assert.rejects(connection.database.createRecord('notes', { id: 'mine' }), code('invalid_request'));
  await assert.rejects(connection.database.listRecords('../notes'), code('invalid_request'));
  await assert.rejects(connection.database.getRecord('notes', '..'), code('invalid_request'));
  await assert.rejects(connection.database.listRecords('notes', { limit: 101 }), code('invalid_request'));
  await assert.rejects(connection.database.listRecords('notes', { filters: { done: false } }), code('invalid_request'));
  await assert.rejects(connection.database.listRecords('notes', { filters: { api_key: 'secret' } }), code('invalid_request'));
  await assert.rejects(connection.database.listRecords('notes', { cursor: config.TELEGRAPH_API_KEY }), code('invalid_request'));
  assert.equal(calls.length, 0);
});

test('conflicts preserve stable error code/version/status but not arbitrary upstream messages', async () => {
  const { connection, calls } = setup(() => json({ error: 'version_conflict', current_version: 8, message: config.TELEGRAPH_API_KEY }, 409));
  await assert.rejects(connection.database.updateRecord('notes', 'rec_one', { done: true }, { expectedVersion: 2 }), error => {
    code('version_conflict')(error);
    assert.equal(error.currentVersion, 8);
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(calls.length, 1); // no automatic mutation retry
});

test('no-secret logging: safe diagnostics and errors for hostile errors and responses', async () => {
  const logs = [];
  for (const respond of [
    () => { throw new Error(`Authorization: Bearer ${config.TELEGRAPH_API_KEY}`); },
    () => json({ error: config.TELEGRAPH_API_KEY, headers: config }, 500),
    () => new Response(config.TELEGRAPH_API_KEY, { status: 500 }),
  ]) {
    const { connection } = setup(respond, { logger: entry => logs.push(entry) });
    await assert.rejects(connection.database.getRecord('notes', 'rec_one'), error => {
      assert.ok(!inspect(error).includes(config.TELEGRAPH_API_KEY));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(logs.length, 6);
  assert.ok(!JSON.stringify(logs).includes(config.TELEGRAPH_API_KEY));
  assert.ok(logs.every(entry => Object.keys(entry).every(key => ['event', 'method', 'status'].includes(key))));
});

test('disconnect clears credentials and prevents cached discovery/resource reuse and new requests', async () => {
  const { connection, calls } = setup(() => json(spec));
  await connection.discovery.discoverOpenApi();
  connection.disconnect();
  assert.equal(connection.authentication.configured, false);
  await assert.rejects(connection.database.listRecords('notes'), code('connection_closed'));
  await assert.rejects(connection.database.listCollections(), code('connection_closed'));
  await assert.rejects(connection.discovery.discoverOpenApi(), code('connection_closed'));
  assert.equal(calls.length, 1);
});

test('authentication clear prevents Bearer requests without introducing a persistent store', async () => {
  const { connection, calls } = setup();
  connection.authentication.clear();
  await assert.rejects(connection.database.getRecord('notes', 'rec_one'), code('not_connected'));
  assert.equal(calls.length, 0);
});

test('discovery is public, cached, immutable to callers and has no implicit API executions', async () => {
  const { connection, calls } = setup(() => json(spec));
  const document = await connection.api.discoverOpenApi();
  document.paths = {};
  const endpoints = await connection.discovery.listEndpoints();
  assert.ok(endpoints.some(endpoint => endpoint.id === 'GET /api/db/{collection}' && endpoint.executable));
  assert.ok(endpoints.some(endpoint => endpoint.id === 'GET /s3/{bucket}' && !endpoint.executable));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://telegraph.example/openapi.json');
  assert.equal(calls[0].headers.has('authorization'), false);
  await connection.api.discoverOpenApi({ refresh: true });
  assert.equal(calls.length, 2);
});

test('API execution uses documented endpoint IDs and ignores remote servers as destinations', async () => {
  const { connection, calls } = setup(url => json(url.endsWith('/openapi.json') ? spec : { data: [record], has_more: false }));
  const result = await connection.api.execute({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' }, query: { limit: 5 } });
  assert.equal(result.status, 200);
  assert.equal(calls[1].url, 'https://telegraph.example/api/db/notes?limit=5');
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${config.TELEGRAPH_API_KEY}`);
  assert.equal(calls.length, 2);
});

for (const endpointId of ['GET https://untrusted.example/exfiltrate', 'GET /s3/{bucket}', 'POST /api/auth/keys/rotate', 'GET /undocumented']) {
  test(`API policy blocks ${endpointId}`, async () => {
    const { connection, calls } = setup(() => json(spec));
    await assert.rejects(connection.api.execute({ endpointId, allowMutation: true }), code('unsupported_operation'));
    assert.equal(calls.length, 1); // only public discovery
  });
}

test('API mutations require explicit opt-in and caller headers cannot override authentication', async () => {
  const { connection, calls } = setup(url => json(url.endsWith('/openapi.json') ? spec : record, url.endsWith('/openapi.json') ? 200 : 201));
  const request = { endpointId: 'POST /api/db/{collection}', pathParameters: { collection: 'notes' }, json: { title: 'hello' } };
  await assert.rejects(connection.api.execute(request), code('invalid_request'));
  for (const headers of [{ Authorization: 'Bearer wrong' }, { authorization: '' }, { Cookie: 'session=value' }, { 'X-Api-Key': 'wrong' }]) {
    await assert.rejects(connection.api.execute({ ...request, allowMutation: true, headers }), code('invalid_request'));
  }
  assert.equal(calls.length, 1);
  await connection.api.execute({ ...request, allowMutation: true });
  assert.equal(calls.length, 2);
});

test('malformed OpenAPI fails without executing external references', async () => {
  const { connection, calls } = setup(() => json({ openapi: '3.1.0', paths: null, $ref: 'https://untrusted.example' }));
  await assert.rejects(connection.discovery.discoverOpenApi(), code('invalid_openapi'));
  assert.equal(calls.length, 1);
});

test('storage list encodes query and returns paginated objects/prefixes', async () => {
  const { connection, calls } = setup(() => json({ data: [{ bucket: 'media', key: 'photos/a.jpg', size: 3, content_type: 'image/jpeg' }], common_prefixes: ['photos/'], has_more: false, next_cursor: null }));
  const page = await connection.storage.listObjects('media', { prefix: 'photos/a b', delimiter: '/' });
  assert.equal(new URL(calls[0].url).searchParams.get('prefix'), 'photos/a b');
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '50');
  assert.deepEqual(page.commonPrefixes, ['photos/']);
});

test('storage HEAD, download, binary upload and delete use shared authenticated transport', async () => {
  const { connection, calls } = setup((url, options) => {
    if (options.method === 'HEAD') return new Response(null, { headers: { ETag: '"4"', 'Content-Length': '3', 'x-amz-meta-label': 'demo' } });
    if (options.method === 'GET') return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
    return json({ data: { bucket: 'media', key: 'photos/a b#.png', size: 3, content_type: 'image/png' } });
  });
  const metadata = await connection.storage.getObjectMetadata('media', 'photos/a b#.png');
  assert.equal(metadata.size, 3);
  assert.equal(metadata.etag, '"4"');
  assert.equal(metadata.custom.label, 'demo');
  const download = await connection.storage.downloadObject('media', 'photos/a b#.png', { range: 'bytes=0-2' });
  assert.equal(download.status, 206);
  assert.deepEqual([...new Uint8Array(await download.data.arrayBuffer())], [1, 2, 3]);
  const body = new Uint8Array([1, 2, 3]);
  const upload = await connection.storage.uploadObject('media', 'photos/a b#.png', body, { contentType: 'image/png', metadata: { label: 'demo' } });
  assert.equal(upload.size, 3);
  await connection.storage.deleteObject('media', 'photos/a b#.png');
  assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET', 'PUT', 'DELETE']);
  assert.equal(calls[2].body, body);
  assert.ok(calls.every(call => call.url === 'https://telegraph.example/api/storage/media/photos/a%20b%23.png'));
  assert.ok(calls.every(call => call.headers.get('authorization') === `Bearer ${config.TELEGRAPH_API_KEY}`));
  assert.equal(calls[1].headers.get('range'), 'bytes=0-2');
});

test('storage rejects oversized uploads and key traversal without sending bytes', async () => {
  const { connection, calls } = setup();
  await assert.rejects(connection.storage.downloadObject('media', '../secret'), code('invalid_request'));
  await assert.rejects(connection.storage.uploadObject('media', 'large', new Uint8Array(20971521)), code('invalid_request'));
  assert.equal(calls.length, 0);
});

test('different project context does not change authenticated request authorization', async () => {
  const mock = mockFetch(() => json(record));
  const a = createTelegraphConnection(config, mock);
  const b = createTelegraphConnection({ ...config, TELEGRAPH_PROJECT: 'prj_other_context' }, mock);
  await a.database.getRecord('notes', 'rec_one');
  await b.database.getRecord('notes', 'rec_one');
  assert.equal(mock.calls[0].url, mock.calls[1].url);
  assert.deepEqual([...mock.calls[0].headers], [...mock.calls[1].headers]);
});

test('connector emits no console logging on success, discovery, or failure', async t => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(name => t.mock.method(console, name, () => {}));
  const good = setup(url => json(url.endsWith('/openapi.json') ? spec : record));
  await good.connection.database.getRecord('notes', 'rec_one');
  await good.connection.discovery.discoverOpenApi();
  const bad = setup(() => json({ error: config.TELEGRAPH_API_KEY }, 401));
  await assert.rejects(bad.connection.database.getRecord('notes', 'rec_one'));
  assert.ok(spies.every(spy => spy.mock.callCount() === 0));
});

test('OpenAPI security claims cannot remove Bearer auth from developer operations', async () => {
  const untrusted = structuredClone(spec);
  untrusted.paths['/api/db/{collection}'].get.security = [];
  const { connection, calls } = setup(url => json(url.endsWith('/openapi.json') ? untrusted : {}));
  await connection.api.execute({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' } });
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${config.TELEGRAPH_API_KEY}`);
});

test('pagination rejects has_more without a usable opaque cursor', async () => {
  const { connection } = setup(() => json({ data: [record], has_more: true }));
  await assert.rejects(connection.database.listRecords('notes'), code('invalid_response'));
});

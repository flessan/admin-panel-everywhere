import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { config, json, mockFetch } from '../connection/fixtures.js';
const object = { bucket: 'media', key: 'photos/a #?.txt', size: 3, content_type: 'text/plain', etag: 'opaque-etag', version: 6 };
function setup(respond, options = {}) {
  const mock = mockFetch(respond);
  return { ...mock, c: createTelegraphConnection(config, { ...mock, ...options }) };
}

test('bucket catalog is configured, incomplete and never guesses an enumeration endpoint', async () => {
  const { c, calls } = setup(undefined, { buckets: ['media', 'backups', 'media'] });
  assert.deepEqual(await c.storage.listBuckets(), { items: [{ name: 'media' }, { name: 'backups' }], source: 'configured', complete: false });
  assert.equal(calls.length, 0); assert.equal(c.metadata.limits.objectBytes, 20971520);
  c.disconnect(); await assert.rejects(c.storage.listBuckets(), { code: 'connection_closed' });
});

test('listing normalizes metadata and constructs prefix/delimiter/cursor query without S3', async () => {
  const { c, calls } = setup(() => json({ data: [object], common_prefixes: ['photos/'], has_more: true, next_cursor: 'x+/=' }));
  const page = await c.storage.listObjects('media', { prefix: 'photos/a #', delimiter: '/', cursor: 'opaque+/=', limit: 100 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/storage/media'); assert.equal(url.searchParams.get('prefix'), 'photos/a #');
  assert.equal(url.searchParams.get('delimiter'), '/'); assert.equal(url.searchParams.get('cursor'), 'opaque+/=');
  assert.equal(page.items[0].contentType, 'text/plain'); assert.equal(page.items[0].etag, 'opaque-etag'); assert.equal(page.items[0].version, 6);
  assert.deepEqual(page.commonPrefixes, ['photos/']); assert.equal(page.nextCursor, 'x+/=');
  assert.equal(calls[0].headers.get('Authorization'), `Bearer ${config.TELEGRAPH_API_KEY}`);
});

test('HEAD preserves exact ETag, version, size, MIME and custom metadata without JSON decoding', async () => {
  const { c, calls } = setup(() => new Response(null, { headers: { ETag: '"opaque-6"', 'Content-Length': '0',
    'Content-Type': 'image/png', 'X-Telegraph-Cloud-Object-Version': '6', 'Last-Modified': 'Mon, 21 Sep 2026 00:00:00 GMT', 'Accept-Ranges': 'bytes', 'x-amz-meta-label': 'sample' } }));
  const meta = await c.storage.getObjectMetadata('media', object.key);
  assert.equal(meta.size, 0); assert.equal(meta.version, 6); assert.equal(meta.etag, '"opaque-6"'); assert.equal(meta.contentType, 'image/png');
  assert.equal(meta.acceptRanges, 'bytes'); assert.deepEqual(meta.custom, { label: 'sample' }); assert.equal(calls[0].method, 'HEAD');
});

test('missing or malformed CORS metadata is unknown, not zero/NaN or invented versions', async () => {
  const { c } = setup(() => new Response(null, { headers: { 'Content-Length': 'bad', 'X-Telegraph-Cloud-Object-Version': '' } }));
  const meta = await c.storage.getObjectMetadata('media', 'key');
  assert.equal(meta.size, null); assert.equal(meta.version, null); assert.equal(meta.etag, null);
});

test('upload sends raw bytes, content type and metadata; limit boundary is exact', async () => {
  const { c, calls } = setup(() => json({ data: object }));
  const bytes = new Uint8Array([0, 1, 255]);
  await c.storage.uploadObject('media', object.key, bytes, { contentType: 'text/plain; charset=utf-8', metadata: { label: 'sample' } });
  assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].body, bytes);
  assert.equal(calls[0].headers.get('content-type'), 'text/plain; charset=utf-8'); assert.equal(calls[0].headers.get('x-amz-meta-label'), 'sample');
  assert.equal(calls[0].headers.has('if-match'), false);
  await c.storage.uploadObject('media', 'max', new Blob([new Uint8Array(20971520)]));
  await assert.rejects(c.storage.uploadObject('media', 'large', new Blob([new Uint8Array(20971521)])), { code: 'invalid_request' });
  assert.equal(calls.length, 2);
});

test('zero-byte objects, wrapped/unwrapped metadata and directory marker keys are supported', async () => {
  const { c, calls } = setup(() => json({ ...object, size: 0 }));
  const result = await c.storage.uploadObject('media', 'folder//', new Blob([]));
  assert.equal(result.size, 0); assert.equal(calls[0].url, 'https://telegraph.example/api/storage/media/folder//');
});

test('invalid upload metadata and header injection fail before requests', async () => {
  const { c, calls } = setup();
  for (const metadata of [[], null, { title: 12 }, { title: 'x\r\ny' }, { Label: 'a', label: 'b' }, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`key${i}`, 'x']))]) {
    await assert.rejects(c.storage.uploadObject('media', 'key', new Blob([]), { metadata }), { code: 'invalid_request' });
  }
  await assert.rejects(c.storage.uploadObject('media', 'key', new Blob([]), { contentType: 'text/plain\r\nX-Secret: x' }), { code: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('download supports binary ranges and exact ETag preconditions', async () => {
  const { c, calls } = setup(() => new Response(new Uint8Array([10, 11, 12]), { status: 206, headers: { 'Content-Range': 'bytes 10-12/100', ETag: '"opaque-6"' } }));
  const response = await c.storage.downloadObject('media', object.key, { range: 'bytes=10-12', ifMatch: '"opaque-6"' });
  assert.equal(response.status, 206); assert.equal(response.data.size, 3); assert.equal(response.headers.get('content-range'), 'bytes 10-12/100');
  assert.equal(calls[0].headers.get('range'), 'bytes=10-12'); assert.equal(calls[0].headers.get('if-match'), '"opaque-6"');
});

test('If-None-Match handles 304 without reading nonexistent bytes', async () => {
  const { c, calls } = setup(() => new Response(null, { status: 304, headers: { ETag: '"6"' } }));
  const response = await c.storage.downloadObject('media', 'key', { ifNoneMatch: '"6"' });
  assert.equal(response.data, null); assert.equal(response.status, 304);
  assert.equal(calls[0].headers.get('if-none-match'), '"6"');
});

for (const range of ['bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,2-3', 'items=1-2', 'bytes=9007199254740992-']) {
  test(`invalid range is rejected: ${range}`, async () => {
    const { c, calls } = setup();
    await assert.rejects(c.storage.downloadObject('media', 'key', { range }), { code: 'invalid_request' }); assert.equal(calls.length, 0);
  });
}

test('delete uses documented DELETE without borrowing document version semantics', async () => {
  const { c, calls } = setup(() => json({ deleted: true }));
  assert.deepEqual(await c.storage.deleteObject('media', object.key), { deleted: true });
  assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].body, undefined); assert.equal(calls[0].headers.has('if-match'), false);
  assert.equal(calls[0].url, 'https://telegraph.example/api/storage/media/photos/a%20%23%3F.txt');
});

for (const status of [401, 403, 404, 412, 413, 416, 429, 500]) {
  test(`storage failure preserves status ${status}, logs no credentials and does not retry`, async () => {
    const logs = []; const { c, calls } = setup(() => json({ error: config.TELEGRAPH_API_KEY }, status), { logger: value => logs.push(value) });
    await assert.rejects(c.storage.downloadObject('media', 'key'), error => {
      assert.equal(error.status, status); assert.ok(!JSON.stringify(error).includes(config.TELEGRAPH_API_KEY)); return true;
    });
    assert.equal(calls.length, 1); assert.ok(!JSON.stringify(logs).includes(config.TELEGRAPH_API_KEY));
  });
}

test('copyable address is connector-built, credential-free, authenticated and never presigned', () => {
  const { c, calls } = setup();
  const info = c.storage.getObjectUrl('media', 'folder/雪 #?.png');
  assert.equal(info.requiresAuthentication, true);
  assert.equal(info.url, 'https://telegraph.example/api/storage/media/folder/%E9%9B%AA%20%23%3F.png');
  assert.equal(new URL(info.url).search, ''); assert.equal(calls.length, 0);
  assert.throws(() => c.storage.getObjectUrl('media', config.TELEGRAPH_API_KEY), { code: 'invalid_request' });
  c.disconnect(); assert.throws(() => c.storage.getObjectUrl('media', 'key'), { code: 'connection_closed' });
});

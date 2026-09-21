import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilesController } from '../../dashboard-ui/app/files/controller.js';
import { ConnectionError } from '../../dashboard-ui/app/connection/errors.js';
import { fakeStorage, object, meta, page, deferred } from './helpers.js';
async function setup(overrides) {
  const fake = fakeStorage(overrides), controller = createFilesController();
  await controller.connect(fake.connection); await controller.openBucket('media');
  return { ...fake, c: controller };
}

test('bucket loading and known names do not imply remote enumeration; failed names are not registered', async () => {
  const pending = deferred(), c = createFilesController();
  const fake = fakeStorage({ listBuckets: async () => pending.promise, listObjects: async () => { throw new ConnectionError('bucket_not_found', { status: 404 }); } });
  const load = c.connect(fake.connection); assert.equal(c.snapshot().buckets.status, 'loading');
  pending.resolve({ items: [], source: 'configured', complete: false }); await load;
  assert.equal(c.snapshot().buckets.status, 'empty'); assert.equal(fake.calls.length, 1);
  await c.openBucket('unknown'); assert.equal(c.snapshot().objects.status, 'error'); assert.equal(c.snapshot().buckets.items.length, 0);
});

test('prefix navigation, delimiter, opaque cursors and refresh reset correctly', async () => {
  const { c, calls } = await setup({ listObjects: async () => page([], { hasMore: true, nextCursor: 'opaque+/=', commonPrefixes: ['photos/'] }) });
  assert.equal(c.snapshot().objects.status, 'ready');
  await c.page('next'); assert.equal(calls.at(-1).args[1].cursor, 'opaque+/=');
  await c.page('previous'); assert.equal(c.snapshot().objects.page, 0);
  await c.navigate({ prefix: 'photos/a b', delimiter: '', limit: 100 });
  const options = calls.at(-1).args[1]; assert.equal(options.delimiter, undefined); assert.equal(options.prefix, 'photos/a b'); assert.equal(options.limit, 100);
  await c.page('next'); await c.refresh(); assert.equal(c.snapshot().objects.page, 0); assert.deepEqual(c.snapshot().objects.cursors, [null]);
});

test('listing and details expose loading, empty and error with recovery', async () => {
  const pending = deferred(); let fail = false;
  const fake = fakeStorage({ listObjects: async () => pending.promise, getObjectMetadata: async () => { if (fail) throw new ConnectionError('request_failed', { status: 403 }); return meta; } });
  const c = createFilesController(); await c.connect(fake.connection);
  const load = c.openBucket('media'); assert.equal(c.snapshot().objects.status, 'loading'); pending.resolve(page([])); await load;
  assert.equal(c.snapshot().objects.status, 'empty');
  fail = true; await c.openObject('key'); assert.equal(c.snapshot().details.status, 'error'); assert.match(c.snapshot().details.error, /credential/);
  fail = false; await c.openObject('key'); assert.equal(c.snapshot().details.status, 'ready');
});

test('upload validates acknowledgement, size and file; success is separate from refresh errors', async () => {
  let uploaded = false;
  const { c, calls } = await setup({ uploadObject: async () => { uploaded = true; return object; }, listObjects: async () => { if (uploaded) throw new ConnectionError('request_failed', { status: 403 }); return page(); } });
  const input = { bucket: 'media', key: 'photo.txt', body: new Blob(['abc']), contentType: 'text/plain' };
  assert.equal(await c.upload(input), false); assert.match(c.snapshot().operation.error, /Acknowledge/);
  assert.equal(await c.upload({ ...input, body: { size: 20971521 }, acknowledgeOverwrite: true }), false);
  assert.equal(calls.some(call => call.method === 'uploadObject'), false);
  assert.equal(await c.upload({ ...input, acknowledgeOverwrite: true }), true);
  assert.equal(c.snapshot().operation.status, 'success'); assert.match(c.snapshot().notice, /uploaded/);
  assert.equal(c.snapshot().objects.status, 'error');
});

test('upload failure is visible; no automatic replay and no duplicate submit while pending', async () => {
  const pending = deferred(); const { c, calls } = await setup({ uploadObject: async () => pending.promise });
  const input = { bucket: 'media', key: 'key', body: new Blob(['abc']), acknowledgeOverwrite: true };
  const write = c.upload(input); assert.equal(c.snapshot().operation.status, 'busy'); await c.upload(input);
  pending.reject(new ConnectionError('request_failed', { status: 413 })); await write;
  assert.equal(c.snapshot().operation.status, 'error'); assert.match(c.snapshot().operation.error, /20 MiB/);
  assert.equal(calls.filter(call => call.method === 'uploadObject').length, 1);
});

test('delete requires a selected metadata snapshot and explicit confirmation; it has no DB preconditions', async () => {
  const { c, calls } = await setup(); c.requestDelete(); assert.equal(c.snapshot().pendingDelete, null);
  await c.openObject(object.key); c.requestDelete(); assert.equal(c.snapshot().pendingDelete.metadata.version, 4);
  await c.confirmDelete(false); assert.equal(calls.some(call => call.method === 'deleteObject'), false);
  await c.confirmDelete(true); assert.equal(c.snapshot().pendingDelete, null); assert.match(c.snapshot().notice, /deleted/);
  const call = calls.find(call => call.method === 'deleteObject'); assert.deepEqual(call.args.slice(0, 2), ['media', object.key]);
  assert.equal(call.args[2].expectedVersion, undefined); assert.equal(call.args[2].ifMatch, undefined);
});

test('failed delete preserves the target for explicit retry or cancellation', async () => {
  const { c, calls } = await setup({ deleteObject: async () => { throw new ConnectionError('request_failed', { status: 500 }); } });
  await c.openObject(object.key); c.requestDelete(); await c.confirmDelete(true);
  assert.ok(c.snapshot().pendingDelete); assert.equal(c.snapshot().operation.status, 'error');
  assert.equal(calls.filter(call => call.method === 'deleteObject').length, 1); c.cancelDelete(); assert.equal(c.snapshot().pendingDelete, null);
});

test('download uses HEAD ETag verbatim; partial output is identified and version is not an ETag substitute', async () => {
  const { c, calls } = await setup({ downloadObject: async () => ({ data: new Blob(['abc']), status: 206, headers: new Headers({ 'Content-Range': 'bytes 0-2/10', 'X-Telegraph-Cloud-Object-Version': '4' }) }) });
  await c.openObject(object.key); const result = await c.download({ range: 'bytes=0-2' });
  assert.equal(result.partial, true); assert.equal(calls.at(-1).args[2].ifMatch, meta.etag);
  assert.equal(c.snapshot().transfer.version, '4'); assert.equal(c.snapshot().transfer.contentRange, 'bytes 0-2/10');
});

for (const status of [412, 416, 429, 500]) {
  test(`failed download ${status} returns no file and does not retry`, async () => {
    const { c, calls } = await setup({ downloadObject: async () => { throw new ConnectionError('request_failed', { status }); } });
    await c.openObject(object.key); assert.equal(await c.download(), null);
    assert.equal(c.snapshot().operation.status, 'error'); assert.equal(calls.filter(call => call.method === 'downloadObject').length, 1);
  });
}

test('304 never creates a download, and ignored range requests are not silently saved as fragments', async () => {
  const { c } = await setup({ downloadObject: async () => ({ data: null, status: 304, headers: new Headers() }) });
  await c.openObject(object.key); assert.equal(await c.download({ ifNoneMatch: '"4"' }), null); assert.match(c.snapshot().notice, /not modified/);
  const normal = await setup(); await normal.c.openObject(object.key);
  assert.equal(await normal.c.download({ range: 'bytes=0-1' }), null); assert.match(normal.c.snapshot().operation.error, /honor the range/);
});

test('late listing, metadata and downloads cannot overwrite another connection', async () => {
  const pending = deferred();
  const { c, connection } = await setup({ getObjectMetadata: async () => pending.promise });
  const request = c.openObject('old'); await c.connect(null); pending.resolve(meta); await request;
  assert.equal(c.snapshot().details.key, null); assert.equal(c.snapshot().buckets.items.length, 0);
  const download = deferred(); connection.storage.getObjectMetadata = async () => meta; connection.storage.downloadObject = async () => download.promise;
  await c.connect(connection); await c.openBucket('media'); await c.openObject('key'); const transfer = c.download();
  await c.connect(null); download.resolve({ data: new Blob(['abc']), status: 200, headers: new Headers() });
  assert.equal(await transfer, null); assert.equal(c.snapshot().transfer, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataController } from '../../dashboard-ui/app/data/controller.js';
import { ConnectionError } from '../../dashboard-ui/app/connection/errors.js';
import { fakeConnection, record, pageOf, deferred } from './helpers.js';

async function setup(overrides) {
  const fake = fakeConnection(overrides), controller = createDataController({ createKey: () => 'attempt-test' });
  await controller.connect(fake.connection);
  await controller.openCollection('operator_chosen');
  return { ...fake, controller };
}

test('collections expose loading, empty, ready and error without guessing a name', async () => {
  const pending = deferred(), c = createDataController();
  const fake = fakeConnection({ listCollections: () => pending.promise });
  const request = c.connect(fake.connection);
  assert.equal(c.snapshot().collections.status, 'loading');
  assert.equal(fake.calls.filter(call => call.method === 'listRecords').length, 0);
  pending.resolve({ items: [], source: 'configured', complete: false }); await request;
  assert.equal(c.snapshot().collections.status, 'empty');
  assert.equal(c.snapshot().collections.complete, false);
  await c.openCollection('operator_chosen');
  assert.equal(c.snapshot().collections.status, 'ready');
  assert.deepEqual(c.snapshot().collections.items.map(item => item.name), ['operator_chosen']);
  const failed = fakeConnection({ listCollections: async () => { throw new ConnectionError('api_key_scope_forbidden'); } });
  await c.connect(failed.connection);
  assert.equal(c.snapshot().collections.status, 'error');
  assert.match(c.snapshot().collections.error, /credential/);
});

test('invalid/absent collection is not added to the session list on read failure', async () => {
  const { controller } = await setup({ listRecords: async () => { throw new ConnectionError('collection_not_found'); } });
  assert.equal(controller.snapshot().records.status, 'error');
  assert.equal(controller.snapshot().collections.items.length, 0);
});

test('record states include loading, empty, error and retry success', async () => {
  const pending = deferred(); let first = true;
  const { connection } = fakeConnection({ listRecords: async () => first ? pending.promise : pageOf() });
  const c = createDataController(); await c.connect(connection);
  const request = c.openCollection('known');
  assert.equal(c.snapshot().records.status, 'loading');
  pending.resolve(pageOf([])); await request;
  assert.equal(c.snapshot().records.status, 'empty');
  first = false; await c.refresh();
  assert.equal(c.snapshot().records.status, 'ready');
});

test('cursor pagination, filters and refresh keep backend ordering and reset cursor history', async () => {
  const { controller: c, calls } = await setup({ listRecords: async (name, options) => pageOf([record()], { hasMore: true, nextCursor: options.cursor ? 'cursor_2' : 'cursor_1' }) });
  await c.page('next');
  assert.equal(c.snapshot().records.page, 1);
  assert.equal(calls.filter(call => call.method === 'listRecords').at(-1).args[1].cursor, 'cursor_1');
  await c.page('previous'); assert.equal(c.snapshot().records.page, 0);
  await c.setQuery({ filters: { title: 'Exact value' }, limit: 50 });
  const options = calls.filter(call => call.method === 'listRecords').at(-1).args[1];
  assert.deepEqual(options.filters, { title: 'Exact value' }); assert.equal(options.limit, 50); assert.equal(options.cursor, null);
  await c.page('next'); await c.refresh(); assert.equal(c.snapshot().records.page, 0);
  await assert.rejects(c.setQuery({ filters: { active: false } }), /string filters/);
});

test('create, edit and delete call the connector using IDs and snapshot versions', async () => {
  const { controller: c, calls } = await setup();
  await c.openEditor('create'); c.setDraft('{"title":"New","flag":false,"nested":[null,0]}'); await c.save();
  const create = calls.find(call => call.method === 'createRecord');
  assert.deepEqual(create.args[1], { title: 'New', flag: false, nested: [null, 0] });
  assert.equal(create.args[2].idempotencyKey, 'attempt-test');
  assert.equal(c.snapshot().editor, null);
  await c.openEditor('edit', 'rec_one');
  c.setDraft(JSON.stringify({ ...JSON.parse(c.snapshot().editor.draft), title: 'Edited' })); await c.save();
  const patch = calls.find(call => call.method === 'updateRecord');
  assert.equal(patch.args[1], 'rec_one'); assert.deepEqual(patch.args[2], { title: 'Edited' }); assert.equal(patch.args[3].expectedVersion, 1);
  await c.openEditor('delete', 'rec_one');
  assert.equal(calls.some(call => call.method === 'deleteRecord'), false); // explicit confirmation required
  await c.save();
  const deletion = calls.find(call => call.method === 'deleteRecord'); assert.equal(deletion.args[2].expectedVersion, 1);
});

test('duplicate strips managed metadata and creates only after review', async () => {
  const { controller: c, calls } = await setup();
  await c.openEditor('duplicate', 'rec_one');
  assert.equal(c.snapshot().editor.mode, 'duplicate'); assert.equal(JSON.parse(c.snapshot().editor.draft).id, undefined);
  assert.equal(calls.some(call => call.method === 'createRecord'), false);
  await c.save(); assert.equal(calls.filter(call => call.method === 'createRecord').length, 1);
});

for (const mode of ['edit', 'delete']) {
  test(`${mode} 409 preserves snapshot/draft, requires compare and explicit latest review`, async () => {
    let latest = false;
    const { controller: c, calls } = await setup({
      getRecord: async (name, id) => record(id, latest ? 7 : 1),
      [mode === 'edit' ? 'updateRecord' : 'deleteRecord']: async () => { throw new ConnectionError('version_conflict', { status: 409, currentVersion: 7 }); },
    });
    await c.openEditor(mode, 'rec_one');
    if (mode === 'edit') c.setDraft(JSON.stringify({ ...JSON.parse(c.snapshot().editor.draft), title: 'My draft' }));
    const draft = c.snapshot().editor.draft;
    await c.save(); assert.equal(c.snapshot().editor.conflict.currentVersion, 7); assert.equal(c.snapshot().editor.draft, draft);
    const count = calls.length; await c.save(); assert.equal(calls.length, count);
    latest = true; await c.compareLatest();
    assert.equal(c.snapshot().editor.record.version, 1); assert.equal(c.snapshot().editor.draft, draft);
    assert.equal(c.snapshot().editor.latest.version, 7);
    c.useLatest(); assert.equal(c.snapshot().editor.record.version, 7); assert.equal(c.snapshot().editor.conflict, null);
    assert.equal(calls.filter(call => call.method === (mode === 'edit' ? 'updateRecord' : 'deleteRecord')).length, 1);
  });
}

test('API errors are visible, drafts survive and uncertain create retries reuse the key', async () => {
  let succeed = false;
  const { controller: c, calls } = await setup({ createRecord: async () => { if (!succeed) throw new ConnectionError('network_error'); return record('rec_new'); } });
  await c.openEditor('create'); c.setDraft('{"x":false}'); await c.save();
  assert.equal(c.snapshot().editor.status, 'ready'); assert.match(c.snapshot().editor.error, /CORS/);
  c.setDraft('{"x":true}'); await c.save(); assert.match(c.snapshot().editor.error, /previous create/);
  assert.equal(calls.filter(call => call.method === 'createRecord').length, 1);
  c.setDraft('{"x":false}'); succeed = true; await c.save();
  const attempts = calls.filter(call => call.method === 'createRecord');
  assert.equal(attempts[0].args[2].idempotencyKey, attempts[1].args[2].idempotencyKey);
});

test('schema hints generate defaults without touching backend schemas; invalid values block save', async () => {
  const { controller: c, calls } = await setup();
  c.applySchema([{ name: 'price', type: 'number', default: 0, required: true }]);
  assert.equal(c.snapshot().schema.source, 'session');
  await c.openEditor('create'); assert.deepEqual(JSON.parse(c.snapshot().editor.draft), { price: 0 });
  c.setDraft('{"price":"wrong"}'); await c.save();
  assert.match(c.snapshot().editor.error, /number/); assert.equal(calls.some(call => call.method === 'createRecord'), false);
});

test('stale reads and writes cannot populate another connection or collection', async () => {
  const pending = deferred();
  const fake = fakeConnection({ listRecords: async name => name === 'slow' ? pending.promise : pageOf([record('fast')]) });
  const c = createDataController(); await c.connect(fake.connection);
  const slow = c.openCollection('slow'); await c.openCollection('fast'); pending.resolve(pageOf([record('slow')])); await slow;
  assert.equal(c.snapshot().records.items[0].id, 'fast');
  await c.openEditor('edit', 'fast'); await c.connect(null);
  assert.equal(c.snapshot().editor, null); assert.equal(c.snapshot().records.items.length, 0);
});

test('raw view retrieves the current envelope but never mutates', async () => {
  const { controller: c, calls } = await setup(); await c.openEditor('raw', 'rec_one'); await c.save();
  assert.equal(c.snapshot().editor.record.version, 1);
  assert.equal(calls.filter(call => /createRecord|updateRecord|deleteRecord/.test(call.method)).length, 0);
});

test('double submit is prevented while saving and a disconnected view ignores late completion', async () => {
  const pending = deferred();
  const { controller: c, calls } = await setup({ createRecord: async () => pending.promise });
  await c.openEditor('create'); c.setDraft('{"title":"Draft"}'); const save = c.save();
  assert.equal(c.snapshot().editor.status, 'saving'); await c.save(); c.closeEditor();
  assert.equal(c.snapshot().editor.status, 'saving');
  await c.connect(null); pending.resolve(record('rec_created')); await save;
  assert.equal(c.snapshot().connected, false); assert.equal(c.snapshot().notice, '');
  assert.equal(calls.filter(call => call.method === 'createRecord').length, 1);
});

test('a create 409 is not mistaken for an editable-record version conflict', async () => {
  const { controller: c } = await setup({ createRecord: async () => { throw new ConnectionError('request_failed', { status: 409 }); } });
  await c.openEditor('create'); c.setDraft('{"title":"Draft"}'); await c.save();
  assert.equal(c.snapshot().editor.conflict, null); assert.ok(c.snapshot().editor.error);
});

test('schema failure does not block document reads, and mutation success is not hidden by refresh failure', async () => {
  let created = false;
  const { controller: c } = await setup({
    getCollectionSchema: async () => { throw new ConnectionError('network_error'); },
    createRecord: async () => { created = true; return record('rec_created'); },
    listRecords: async () => { if (created) throw new ConnectionError('network_error'); return pageOf(); },
  });
  assert.equal(c.snapshot().schema.status, 'error'); assert.equal(c.snapshot().records.status, 'ready');
  await c.openEditor('create'); c.setDraft('{}'); await c.save();
  assert.equal(c.snapshot().notice, 'Record saved.'); assert.equal(c.snapshot().records.status, 'error');
  assert.equal(c.snapshot().editor, null);
});

for (const mode of ['edit', 'delete']) {
  test(`${mode} uses a newly reviewed version only after explicit conflict resolution`, async () => {
    let writes = 0, reads = 0;
    const method = mode === 'edit' ? 'updateRecord' : 'deleteRecord';
    const { controller: c, calls } = await setup({
      getRecord: async () => record('rec_one', ++reads === 1 ? 1 : 9),
      [method]: async () => { if (++writes === 1) throw new ConnectionError('version_conflict', { status: 409, currentVersion: 9 }); return record('rec_one', 10); },
    });
    await c.openEditor(mode, 'rec_one');
    if (mode === 'edit') c.setDraft(JSON.stringify({ ...JSON.parse(c.snapshot().editor.draft), title: 'First edit' }));
    await c.save(); await c.compareLatest(); c.useLatest();
    assert.equal(writes, 1);
    if (mode === 'edit') c.setDraft(JSON.stringify({ ...JSON.parse(c.snapshot().editor.draft), title: 'Reviewed edit' }));
    await c.save();
    const request = calls.filter(call => call.method === method).at(-1);
    assert.equal(request.args.at(-1).expectedVersion, 9); assert.equal(writes, 2);
    assert.equal(c.snapshot().editor, null);
  });
}

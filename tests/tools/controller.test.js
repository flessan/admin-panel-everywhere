import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsController } from '../../dashboard-ui/app/tools/controller.js';
import { fakeConnection, pageOf, record, deferred } from '../data/helpers.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(overrides = {}, options = {}) {
  const { connection, calls } = fakeConnection({ listRecords: async () => pageOf([record('a', 3), record('b', 8)]), ...overrides });
  let key = 0; const controller = createToolsController({ spacingMs: 0, createKey: () => `key-${++key}`, ...options });
  controller.connect(connection); await controller.load('notes'); controller.selectAll(true);
  return { controller, connection, calls };
}
const execute = (controller, retry = false) => controller.run({ confirmed: true, collection: 'notes', retry });
const writes = calls => calls.filter(call => ['updateRecord', 'deleteRecord', 'createRecord'].includes(call.method));

test('bulk preview is side-effect-free; exact confirmation and reviewed versions are mandatory', async () => {
  const { controller: c, calls } = await fixture(); c.prepareBulk('update', '{"active":true}');
  assert.equal(writes(calls).length, 0); assert.equal(c.snapshot().plan.jobs[0].diff[0].before, false);
  await assert.rejects(c.run({ confirmed: true, collection: 'wrong' }), /Confirm/); await assert.rejects(c.run({ collection: 'notes' }), /Confirm/);
  await execute(c); assert.equal(writes(calls).length, 2);
  assert.deepEqual(writes(calls).map(call => call.args[3].expectedVersion), [3, 8]);
  assert.deepEqual(writes(calls)[0].args[2], { active: true });
  assert.ok(c.snapshot().plan.jobs.every(job => job.status === 'succeeded')); assert.equal(c.snapshot().needsReload, true);
  assert.throws(() => c.exportData('json'), /reload/);
  assert.throws(() => c.select('a', false), /Discard/);
});

test('delete iterates per record; partial conflict does not overwrite or retry, while other records can finish', async () => {
  const { controller: c, calls } = await fixture({ deleteRecord: async (_, id) => { if (id === 'a') throw { code: 'version_conflict', status: 409, message: 'unsafe fixture secret' }; return { deleted: true }; } });
  c.prepareBulk('delete'); await execute(c);
  assert.equal(writes(calls).length, 2); assert.deepEqual(writes(calls).map(call => call.args[2].expectedVersion), [3, 8]);
  assert.equal(c.snapshot().plan.jobs[0].error.retryable, false); assert.doesNotMatch(JSON.stringify(c.report()), /unsafe fixture secret/);
  const report = c.report(); report.jobs[0].error.retryable = true;
  await execute(c, true); assert.equal(writes(calls).length, 2);
  assert.deepEqual(c.snapshot().records.map(record => record.id), ['a']);
});

test('duplicate/import use immutable payloads and per-row idempotency keys; explicit retries never replay successes', async () => {
  let failed = false;
  const { controller: c, calls } = await fixture({ createRecord: async (_, data) => { if (!failed) { failed = true; throw { code: 'network_error' }; } return record('created', 1, data); } });
  c.prepareImport('[{"title":"one"},{"title":"two"}]', 'json'); await execute(c);
  assert.deepEqual(c.snapshot().plan.jobs.map(job => job.status), ['failed', 'pending']);
  assert.throws(() => c.prepareImport('[{"title":"changed"}]', 'json'), /Discard/);
  await execute(c, true); await execute(c); await execute(c, true);
  assert.equal(writes(calls).length, 3);
  assert.equal(writes(calls)[0].args[2].idempotencyKey, writes(calls)[1].args[2].idempotencyKey);
  assert.notEqual(writes(calls)[1].args[2].idempotencyKey, writes(calls)[2].args[2].idempotencyKey);
  assert.deepEqual(writes(calls)[0].args[1], writes(calls)[1].args[1]);
  assert.throws(() => c.discard(), /Confirm discarding/); c.discard(true); await c.load('notes'); c.selectAll(true); c.prepareBulk('duplicate');
  assert.ok(c.snapshot().plan.jobs.every(job => !Object.hasOwn(job.data, 'id')));
});

test('all import rows and all merged bulk documents validate before any mutation', async () => {
  const { controller: c, calls } = await fixture(); c.applySchema([{ name: 'title', type: 'text', required: true }]);
  assert.throws(() => c.prepareImport('[{"title":"ok"},{"title":3}]', 'json'), /Row 2/);
  assert.equal(c.snapshot().plan, null); assert.equal(writes(calls).length, 0);
  assert.throws(() => c.prepareBulk('update', '{"title":false}'), /Invalid text/);
  assert.throws(() => c.prepareBulk('update', '{"_expected_version":5}'), /managed/);
  c.prepareBulk('update', '{"active":false}'); await execute(c); assert.equal(writes(calls).length, 0); assert.ok(c.snapshot().plan.jobs.every(job => job.status === 'skipped'));
});

test('stop waits for active mutation, leaves queued jobs pending, and resuming does not repeat success', async () => {
  const late = deferred(); let index = 0;
  const { controller: c, calls } = await fixture({ deleteRecord: async () => ++index === 1 ? late.promise : { deleted: true } });
  c.prepareBulk('delete'); const pending = execute(c); await tick(); await execute(c); c.cancel();
  assert.equal(c.snapshot().stopping, true); assert.equal(c.snapshot().running, true);
  late.resolve({ deleted: true }); await pending;
  assert.deepEqual(c.snapshot().plan.jobs.map(job => job.status), ['succeeded', 'pending']);
  await execute(c); assert.equal(writes(calls).length, 2);
});

test('rate limits pause the batch and enforce a cooldown for both retries and queued requests', async () => {
  let now = 0, fail = true;
  const { controller: c, calls } = await fixture({ deleteRecord: async () => { if (fail) { fail = false; throw { status: 429, code: 'rate_limited' }; } return { deleted: true }; } }, { clock: () => now });
  c.prepareBulk('delete'); await execute(c); assert.equal(writes(calls).length, 1);
  await assert.rejects(execute(c), /cooldown/); await assert.rejects(execute(c, true), /cooldown/);
  now = 60000; await execute(c, true); await execute(c); assert.equal(writes(calls).length, 3);
});

test('writes are paced and stop during a pacing delay issues no extra mutation', async () => {
  const started = deferred(), delay = deferred();
  const { controller: c, calls } = await fixture({}, { spacingMs: 3100, clock: () => 0, wait: async (ms, signal) => {
    assert.equal(ms, 3100); signal.addEventListener('abort', () => delay.resolve()); started.resolve(); await delay.promise;
  } });
  c.prepareBulk('delete'); const running = execute(c); await started.promise; c.cancel(); await running;
  assert.equal(writes(calls).length, 1); assert.equal(c.snapshot().plan.jobs[1].status, 'pending');
});

test('JSON editor reloads one current version, formats/validates and requires a staged diff before saving', async () => {
  const { controller: c, calls } = await fixture({ getRecord: async (_, id) => record(id, 12) });
  c.selectAll(false); c.select('a', true); await c.openJson(); c.setDraft('{"title":"changed","active":false,"count":0}'); c.formatJson();
  assert.match(c.snapshot().editor.draft, /\n/); c.prepareJson(); assert.equal(c.snapshot().plan.jobs[0].version, 12);
  await execute(c); assert.equal(writes(calls)[0].args[3].expectedVersion, 12); assert.deepEqual(writes(calls)[0].args[2], { title: 'changed' });
});

test('disconnect discards late reads/writes, and snapshot mutation cannot change the execution plan', async () => {
  const late = deferred(); const { controller: c, calls } = await fixture({ updateRecord: async () => late.promise });
  c.prepareBulk('update', '{"active":true}'); const copy = c.snapshot(); copy.plan.jobs[0].version = 999;
  const pending = execute(c); await tick(); c.connect(null); late.resolve(record('a', 4)); await pending;
  assert.equal(writes(calls)[0].args[3].expectedVersion, 3); assert.equal(writes(calls).length, 1);
  assert.equal(c.snapshot().plan, null); assert.deepEqual(c.snapshot().records, []);
  const read = deferred(); const other = fakeConnection({ listRecords: async () => read.promise });
  c.connect(other.connection); const load = c.load('notes'); await tick(); c.connect(null); read.resolve(pageOf()); await load;
  assert.equal(c.snapshot().collection, null);
});

test('pagination preserves reviewed selections, detects repeated cursors, and does not silently export an entire collection', async () => {
  let count = 0;
  const { controller: c } = await fixture({ listRecords: async () => ++count === 1 ? pageOf([record('a')], { hasMore: true, nextCursor: 'next' }) : pageOf([record('b')], { hasMore: false, nextCursor: null }) });
  await c.load('notes', { more: true }); assert.deepEqual(c.snapshot().selected, ['a']);
  assert.equal(JSON.parse(c.exportData('json', 'selected').text).length, 1); assert.equal(JSON.parse(c.exportData('json', 'loaded').text).length, 2);
  const bad = await fixture({ listRecords: async () => pageOf([record()], { hasMore: true, nextCursor: 'repeat' }) });
  await bad.controller.load('notes', { more: true }); assert.match(bad.controller.snapshot().error, /advance/);
});

test('authentication failures pause; validation failures are reported without retry; a new plan requires reloading', async () => {
  const auth = await fixture({ deleteRecord: async () => { throw { code: 'invalid_api_key', status: 401 }; } });
  auth.controller.prepareBulk('delete'); await execute(auth.controller);
  assert.equal(writes(auth.calls).length, 1); assert.deepEqual(auth.controller.snapshot().plan.jobs.map(job => job.status), ['failed', 'pending']);
  assert.equal(auth.controller.snapshot().plan.jobs[0].error.retryable, false);
  auth.controller.discard(true); assert.throws(() => auth.controller.prepareBulk('duplicate'), /Reload/);
  const validation = await fixture({ updateRecord: async () => { throw { code: 'schema_validation_failed', status: 400 }; } });
  validation.controller.prepareBulk('update', '{"active":true}'); await execute(validation.controller);
  assert.equal(writes(validation.calls).length, 2); assert.ok(validation.controller.snapshot().plan.jobs.every(job => !job.error.retryable));
});

test('a connector cannot mutate the retained retry payload through its request argument', async () => {
  let count = 0; const payloads = [];
  const { controller: c } = await fixture({ createRecord: async (_, data) => {
    payloads.push(structuredClone(data)); data.title = 'mutated argument';
    if (!count++) throw { code: 'network_error' }; return record('new');
  } });
  c.prepareImport('[{"title":"fixed"}]', 'json'); await execute(c); await execute(c, true);
  assert.deepEqual(payloads, [{ title: 'fixed' }, { title: 'fixed' }]);
});

test('current Data page handoff preserves filtered/later-page records and versions without guessing pagination or refetching', async () => {
  const { controller: c, calls } = await fixture(); const before = calls.length;
  c.useDataPage({ connected: true, collection: 'notes', editor: null,
    records: { status: 'ready', page: 4, items: [record('later-page', 27)], hasMore: true, nextCursor: 'filtered-cursor', filters: { title: 'match' } },
    schema: { schema: [{ name: 'title', type: 'text' }], source: 'session' } });
  assert.equal(calls.length, before); assert.equal(c.snapshot().schemaSource, 'session'); assert.equal(c.snapshot().hasMore, false);
  c.selectAll(true); c.prepareBulk('delete'); await execute(c);
  assert.equal(writes(calls)[0].args[1], 'later-page'); assert.equal(writes(calls)[0].args[2].expectedVersion, 27);
});

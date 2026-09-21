import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { createToolsController } from '../../dashboard-ui/app/tools/controller.js';
const config = { TELEGRAPH_URL: 'https://backend.example', TELEGRAPH_PROJECT: 'prj_fixture', TELEGRAPH_API_KEY: 'synthetic-tools-runtime-key' };
const record = (id, version, data = { title: 'original' }) => ({ id, version, data });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('real Telegraph bulk update/delete uses only documented per-record routes, auth and expected versions', async () => {
  const calls = [], records = [record('a', 2), record('b', 9)];
  const connection = createTelegraphConnection(config, { fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); const id = new URL(url).pathname.split('/').at(-1);
    if (options.method === 'GET') return response({ data: records, has_more: false });
    if (options.method === 'PATCH') {
      if (id === 'a') return response({ error: 'version_conflict', current_version: 4 }, 409);
      return response(record(id, 10, { title: 'updated' }));
    }
    return response({ deleted: true });
  } });
  const c = createToolsController({ spacingMs: 0 }); c.connect(connection); assert.equal(calls.length, 0);
  await c.load('notes'); c.selectAll(true); c.prepareBulk('update', '{"title":"updated"}'); await c.run({ confirmed: true, collection: 'notes' });
  const patches = calls.filter(call => call.method === 'PATCH'); assert.equal(patches.length, 2);
  assert.deepEqual(patches.map(call => JSON.parse(call.body)._expected_version), [2, 9]);
  assert.equal(c.snapshot().plan.jobs[0].error.code, 'version_conflict');
  c.discard(true); await c.load('notes'); c.selectAll(true); c.select('b', false); c.prepareBulk('delete'); await c.run({ confirmed: true, collection: 'notes' });
  const deletion = calls.find(call => call.method === 'DELETE'); assert.equal(JSON.parse(deletion.body)._expected_version, 2);
  assert.ok(calls.every(call => call.headers.get('authorization') === `Bearer ${config.TELEGRAPH_API_KEY}`));
  assert.ok(calls.every(call => /^\/api\/db\/notes(?:\/[ab])?$/.test(new URL(call.url).pathname)));
  assert.ok(calls.every(call => !call.url.includes(config.TELEGRAPH_API_KEY))); assert.ok(calls.every(call => call.redirect === 'error'));
});

test('real connector create retries reuse Idempotency-Key and byte-identical body, without a bulk endpoint', async () => {
  const calls = []; let attempts = 0;
  const connection = createTelegraphConnection(config, { fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'GET') return response({ data: [], has_more: false });
    if (++attempts === 1) throw new Error('synthetic-tools-runtime-key');
    return response(record('created', 1, JSON.parse(options.body)), 201);
  } });
  const c = createToolsController({ spacingMs: 0 }); c.connect(connection); await c.load('notes');
  c.prepareImport('[{"title":"one"}]', 'json'); await c.run({ confirmed: true, collection: 'notes' });
  await c.run({ confirmed: true, collection: 'notes', retry: true });
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 2);
  assert.equal(posts[0].headers.get('idempotency-key'), posts[1].headers.get('idempotency-key')); assert.equal(posts[0].body, posts[1].body);
  assert.doesNotMatch(JSON.stringify(c.report()), /synthetic-tools-runtime-key/);
  assert.ok(posts.every(call => new URL(call.url).pathname === '/api/db/notes'));
});

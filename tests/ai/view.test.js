import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountAiView } from '../../dashboard-ui/app/ai/view.js';
import { mountToolsView } from '../../dashboard-ui/app/tools/view.js';
import { createToolsController } from '../../dashboard-ui/app/tools/controller.js';
import { mountApiView } from '../../dashboard-ui/app/api-tools/view.js';
import { createApiController } from '../../dashboard-ui/app/api-tools/controller.js';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { config, document as spec, jsonResponse } from '../api/fixtures.js';
import { setup, tick } from './fixtures.js';
const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');

test('AI DOM uses explicit packet/proposal acknowledgements, resets consent on edits, copies exact packet, text-only output and clears on disconnect', async t => {
  const dom = new JSDOM(html), { controller, registry } = setup(); t.after(() => dom.window.close());
  const $ = id => dom.window.document.getElementById(id), event = (id, kind) => $(id).dispatchEvent(new dom.window.Event(kind)); let copied;
  dom.window.navigator.clipboard = { writeText: async text => { copied = text; } };
  mountAiView(dom.window.document, controller, { registry });
  $('ai-task').value = 'prepare-bulk'; event('ai-task', 'change'); $('ai-prepare').click(); await tick();
  assert.equal($('ai-copy').disabled, true); $('ai-share-ack').checked = true; event('ai-share-ack', 'change'); $('ai-copy').click(); await tick(); assert.equal(copied, $('ai-packet').value);
  $('ai-response').value = '{"kind":"bulk-edit","changes":{"title":"<script>evil()</script>"}}'; event('ai-response', 'input'); $('ai-import-response').click(); await tick(); assert.equal($('ai-proposal').querySelector('script'), null);
  $('ai-stage-ack').checked = true; event('ai-stage-ack', 'change'); assert.equal($('ai-stage').disabled, false);
  $('ai-response').value = '{}'; event('ai-response', 'input'); assert.equal($('ai-stage').disabled, true); assert.ok($('ai-packet').value);
  $('ai-instructions').value = 'Different'; event('ai-instructions', 'input'); assert.equal($('ai-share-ack').checked, false); assert.equal($('ai-packet').value, '');
  registry.register({ id: 'test', label: '<img src=x>', generate: async () => '{"kind":"explanation","text":"Hello"}' }); assert.equal($('ai-provider').querySelector('img'), null); assert.equal($('ai-provider').options.length, 2);
  controller.connect(null); assert.equal($('ai-instructions').value, ''); assert.equal($('ai-response').value, ''); assert.equal($('ai-prepare').disabled, true);
});

test('Tools handoff does not overwrite pending manual drafts/plans and retains trusted originals until final connector validation', async t => {
  const dom = new JSDOM(html), { connection, sources } = setup(); t.after(() => dom.window.close());
  const tools = createToolsController({ createKey: () => 'synthetic-key' }); tools.connect(connection); tools.useDataPage(sources.data); tools.select('one', true);
  const view = mountToolsView(dom.window.document, tools), $ = id => dom.window.document.getElementById(id);
  const proposal = { kind: 'bulk-edit', changes: { title: 'After' } };
  $('tools-import-text').value = '[{"title":"Unfinished"}]'; assert.throws(() => view.stageAi(proposal), /overwrite/); $('tools-import-text').value = '';
  view.stageAi(proposal); const job = tools.snapshot().plan.jobs[0]; assert.equal(job.version, 7); assert.deepEqual(job.data, { title: 'After' }); assert.equal(job.attempts, 0);
  assert.throws(() => view.stageAi(proposal), /overwrite/); assert.equal($('tools-confirm').checked, false); assert.equal($('tools-confirm-collection').value, '');
  await assert.rejects(tools.run({ confirmed: true, collection: 'wrong' }), /collection/);
});

test('API handoff fills documented inputs without network, refuses dirty/busy drafts and resets explicitly', async t => {
  const dom = new JSDOM(html), calls = []; t.after(() => dom.window.close());
  const connection = createTelegraphConnection(config, { fetchImpl: async (...args) => { calls.push(args); return jsonResponse(spec); } });
  const api = createApiController(), view = mountApiView(dom.window.document, api); api.connect(connection); await api.load();
  const proposal = { kind: 'api-request', endpointId: 'GET /api/db/{collection}', parameters: [{ in: 'path', name: 'collection', value: 'notes' }, { in: 'query', name: 'limit', value: 10 }] };
  view.stageRequest(proposal); assert.equal(calls.length, 1); assert.equal(dom.window.document.querySelector('[data-parameter="collection"]').value, 'notes');
  assert.throws(() => view.stageRequest(proposal), /Reset/); dom.window.document.getElementById('api-reset-draft').click(); view.stageRequest(proposal); assert.equal(calls.length, 1);
});

test('AI-generated creates keep application-owned idempotency and backend permission/validation gates', async t => {
  for (const status of [400, 403]) {
    const dom = new JSDOM(html); t.after(() => dom.window.close()); const calls = [];
    const connection = createTelegraphConnection(config, { fetchImpl: async (url, init) => { calls.push({ url, ...init }); return jsonResponse({ error: status === 403 ? 'api_key_scope_forbidden' : 'validation_error' }, status); } });
    const { sources } = setup();
    const tools = createToolsController({ createKey: () => 'application-owned-idempotency' }); tools.connect(connection); tools.useDataPage(sources.data);
    const view = mountToolsView(dom.window.document, tools);
    const { controller, prepare } = setup({ getSources: () => ({ ...sources, tools: tools.snapshot() }), handoff: ({ proposal }) => view.stageAi(proposal) });
    controller.connect(connection); prepare('generate-records');
    controller.importResponse('{"kind":"create-records","documents":[{"title":"Synthetic example"}]}'); controller.stage(true);
    assert.equal(calls.length, 0); assert.equal(tools.snapshot().plan.jobs[0].key, 'application-owned-idempotency');
    await tools.run({ confirmed: true, collection: 'notes' }); assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${config.TELEGRAPH_API_KEY}`);
    assert.equal(calls[0].headers.get('idempotency-key'), 'application-owned-idempotency');
    assert.deepEqual(JSON.parse(calls[0].body), { title: 'Synthetic example' });
    assert.equal(tools.snapshot().plan.jobs[0].status, 'failed'); assert.equal(tools.snapshot().plan.jobs[0].error.retryable, false);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setActiveConnection } from '../../dashboard-ui/app/connection/active.js';
import { document as spec, jsonResponse, flush } from '../api/fixtures.js';

test('real app: AI drafts never execute; typed Tools keeps auth/version/409 gates, API and filters require explicit execution', async t => {
  const dom = new JSDOM(await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8'), { url: 'https://admin.example' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }, calls = [];
  const record = { id: 'one', version: 6, data: { title: 'Before', unchanged: { nested: [null, false] } } };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: async (url, options) => {
    calls.push({ url, ...options }); const path = new URL(url).pathname;
    if (path === '/openapi.json') return jsonResponse(spec);
    if (options.method === 'PATCH') return jsonResponse({ error: 'version_conflict', current_version: 7 }, 409);
    if (path === '/api/health') return jsonResponse({ ok: true });
    return jsonResponse({ data: [record], has_more: false });
  } });
  t.after(() => { setActiveConnection(null); Object.assign(globalThis, previous); dom.window.close(); });
  await import('../../dashboard-ui/app/index.js');
  const $ = id => dom.window.document.getElementById(id);
  const event = (id, kind) => $(id).dispatchEvent(new dom.window.Event(kind, { bubbles: true, cancelable: true }));
  const task = (name, source = 'tools') => { $('ai-workspace-tab').click(); $('ai-task').value = name; event('ai-task', 'change'); $('ai-source').value = source; event('ai-source', 'change'); };
  const proposal = async value => { $('ai-response').value = JSON.stringify(value); event('ai-response', 'input'); $('ai-import-response').click(); await flush(); assert.equal($('ai-error').textContent, ''); };
  const stage = async () => { $('ai-stage-ack').checked = true; event('ai-stage-ack', 'change'); $('ai-stage').click(); await flush(); };

  $('connection-key').value = 'synthetic-ai-bootstrap-key'; event('connection-form', 'submit'); await flush();
  $('collection-input').value = 'notes'; event('open-collection-form', 'submit'); await flush(); assert.equal(calls.length, 1);
  $('schema-input').value = JSON.stringify({ fields: [{ name: 'title', type: 'text', required: true, indexed: true }] }); event('schema-form', 'submit'); await flush();
  $('data-tools').click(); await flush(); const checkbox = $('tools-records').querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event('change'));
  task('prepare-bulk'); $('ai-include-records').checked = true; event('ai-include-records', 'change'); $('ai-prepare').click(); await flush();
  assert.equal(calls.length, 1); assert.equal($('ai-error').textContent, ''); assert.ok($('ai-packet').value.includes('Before')); assert.ok(!$('ai-packet').value.includes('synthetic-ai-bootstrap-key'));
  await proposal({ kind: 'bulk-edit', changes: { title: '<img src=x onerror=alert(1)>' } }); assert.equal($('ai-proposal').querySelector('img'), null);
  assert.equal($('ai-stage').disabled, true); await stage(); assert.equal(calls.length, 1); assert.equal($('tools-workspace').hidden, false); assert.equal($('tools-plan').hidden, false);
  assert.match($('tools-diff').textContent, /Before/); assert.match($('tools-diff').textContent, /img/);
  $('tools-run').click(); await flush(); assert.equal(calls.length, 1);
  $('tools-confirm-collection').value = 'notes'; $('tools-confirm').checked = true; $('tools-run').click(); await flush();
  const patch = calls.find(call => call.method === 'PATCH'); assert.deepEqual(JSON.parse(patch.body), { title: '<img src=x onerror=alert(1)>', _expected_version: 6 });
  assert.equal(patch.headers.get('authorization'), 'Bearer synthetic-ai-bootstrap-key'); assert.match($('tools-results').textContent, /Version conflict/); assert.equal($('tools-retry').disabled, true);

  // API draft handoff neither previews nor calls inspect until the user acts.
  $('api-workspace-tab').click(); await flush(); const loaded = calls.length;
  task('generate-request'); $('ai-prepare').click(); await flush(); await proposal({ kind: 'api-request', endpointId: 'GET /api/health', parameters: [] }); await stage();
  assert.equal(calls.length, loaded); assert.equal($('api-workspace').hidden, false); assert.equal($('api-editor').hidden, false);
  event('api-request-form', 'submit'); await flush(); assert.equal(calls.length, loaded + 1); assert.equal(new URL(calls.at(-1).url).pathname, '/api/health');

  task('build-filters', 'data'); $('ai-prepare').click(); await flush(); await proposal({ kind: 'filters', filters: { title: 'Exact' }, limit: 10 });
  const beforeFilter = calls.length; await stage(); assert.equal(calls.length, beforeFilter); assert.equal($('data-ai-filters').hidden, false);
  $('data-ai-apply-filters').click(); await flush(); assert.equal(calls.length, beforeFilter + 1); assert.equal(new URL(calls.at(-1).url).searchParams.get('title'), 'Exact');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('limit'), '10');
  $('disconnect').click(); assert.equal($('ai-packet').value, ''); assert.equal($('ai-response').value, ''); assert.equal($('ai-instructions').value, ''); assert.equal($('ai-stage').disabled, true);
});

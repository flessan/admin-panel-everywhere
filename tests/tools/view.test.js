import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createToolsController } from '../../dashboard-ui/app/tools/controller.js';
import { mountToolsView } from '../../dashboard-ui/app/tools/view.js';
import { inspectFile, MAX_INSPECT_BYTES } from '../../dashboard-ui/app/tools/media.js';
import { fakeConnection, pageOf, record, deferred } from '../data/helpers.js';
const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(t, overrides = {}) {
  const dom = new JSDOM(html, { url: 'https://admin.example' }), { connection, calls } = fakeConnection({ listRecords: async () => pageOf([record('a', 3), record('b', 7)]), ...overrides });
  const controller = createToolsController({ spacingMs: 0 }), saved = [], destinations = [];
  const view = mountToolsView(dom.window.document, controller, { navigate: name => destinations.push(name), downloads: { clear() {}, save(value) { saved.push(value); } } });
  controller.connect(connection); await controller.load('notes');
  t.after(() => { controller.connect(null); view.dispose(); dom.window.close(); });
  const $ = id => dom.window.document.getElementById(id);
  const selectAll = () => { $('tools-select-all').checked = true; $('tools-select-all').dispatchEvent(new dom.window.Event('change')); };
  const event = (id, type) => $(id).dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
  return { dom, $, event, selectAll, controller, calls, saved, destinations };
}

test('Tools has all seven sections, multi-selection and reviewed confirmation before destructive writes', async t => {
  const { $, event, selectAll, calls } = await fixture(t);
  assert.equal($('tools-workspace').querySelectorAll('[role=tab]').length, 7); selectAll();
  assert.match($('tools-state').textContent, /2 selected/);
  $('tools-bulk-tab').click(); assert.equal($('tools-bulk-panel').hidden, false); assert.equal($('tools-import-panel').hidden, true);
  $('tools-prepare-delete').click(); await tick(); assert.equal($('tools-plan').hidden, false);
  assert.match($('tools-diff').textContent, /expected version 3/); assert.match($('tools-diff').textContent, /expected version 7/);
  $('tools-run').click(); await tick(); assert.match($('tools-local-error').textContent, /Confirm/); assert.equal(calls.filter(call => call.method === 'deleteRecord').length, 0);
  $('tools-confirm-collection').value = 'notes'; $('tools-confirm').checked = true; $('tools-run').click(); await tick();
  assert.equal(calls.filter(call => call.method === 'deleteRecord').length, 2); assert.match($('tools-progress').textContent, /2\/2 processed/);
  assert.equal($('tools-confirm').checked, false); assert.equal($('tools-more').disabled, true);
  $('tools-report-download').click(); await tick();
  $('tools-discard-ack').checked = true; $('tools-discard').click(); await tick(); assert.equal($('tools-plan').hidden, true);
});

test('import validation, input changes invalidating review, and precise export scope work through the UI', async t => {
  const { $, event, selectAll, saved } = await fixture(t); selectAll();
  $('tools-import-text').value = '[{"title":"new"}]'; $('tools-prepare-import').click(); await tick(); assert.match($('tools-plan-title').textContent, /import · 1 records/);
  $('tools-confirm').checked = true; $('tools-import-text').value = '[{"title":"changed"}]'; event('tools-import-text', 'input'); await tick();
  assert.equal($('tools-plan').hidden, true); assert.equal($('tools-confirm').checked, false);
  $('tools-import-text').value = '[{"id":"unsafe"}]'; $('tools-prepare-import').click(); await tick(); assert.match($('tools-local-error').textContent, /managed/);
  $('tools-export-tab').click(); $('tools-export-download').click(); await tick(); assert.equal(saved.length, 1);
  const documents = JSON.parse(await saved[0].data.text()); assert.equal(documents.length, 2); assert.ok(documents.every(data => !Object.hasOwn(data, 'id')));
  assert.match($('tools-export-notice').textContent, /2 loaded records/);
});

test('JSON formatting, diff rendering and hostile content remain inert; schema validation precedes save', async t => {
  const { $, event, controller } = await fixture(t);
  controller.select('a', true); $('tools-json-tab').click(); $('tools-load-json').click(); await tick();
  $('tools-json-input').value = '{"title":"<img src=x onerror=alert(1)>","active":false,"count":0}'; event('tools-json-input', 'input');
  $('tools-format-json').click(); await tick(); assert.match($('tools-json-input').value, /\n/);
  $('tools-prepare-json').click(); await tick(); assert.match($('tools-diff').textContent, /<img/); assert.equal($('tools-diff').querySelector('img'), null);
  assert.match($('tools-diff').textContent, /"before": "Hello"/); assert.equal($('tools-diff').querySelector('details').open, true);
  $('tools-json-input').value = '{'; event('tools-json-input', 'input'); $('tools-prepare-json').click(); await tick();
  assert.equal($('tools-plan').hidden, true); assert.match($('tools-local-error').textContent, /valid JSON/);
});

test('API and media tools reuse existing workspaces; file checksums never require a remote request', async t => {
  const { $, event, destinations, calls } = await fixture(t);
  $('tools-api-tab').click(); $('tools-open-api').click(); $('tools-media-tab').click(); $('tools-open-files').click();
  assert.deepEqual(destinations, ['api', 'files']);
  const before = calls.length, file = new File(['abc'], '<img>.txt', { type: 'text/plain' });
  Object.defineProperty($('tools-media-file'), 'files', { value: [file], configurable: true }); await $('tools-media-file').onchange();
  assert.match($('tools-media-result').textContent, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
  assert.equal($('tools-media-result').querySelector('img'), null); assert.equal(calls.length, before);
  await assert.rejects(inspectFile({ size: MAX_INSPECT_BYTES + 1 }), /20 MiB/);
});

test('late file reads cannot restore drafts after disconnect or override newer manually entered content', async t => {
  const { $, event, controller } = await fixture(t); const first = deferred();
  Object.defineProperty($('tools-import-file'), 'files', { value: [{ name: 'a.json', size: 2, arrayBuffer: () => first.promise }], configurable: true });
  event('tools-import-file', 'change'); $('tools-import-text').value = '[{"new":true}]'; event('tools-import-text', 'input');
  first.resolve(new TextEncoder().encode('[]').buffer); await tick(); assert.equal($('tools-import-text').value, '[{"new":true}]');
  const late = deferred(); Object.defineProperty($('tools-import-file'), 'files', { value: [{ name: 'a.json', size: 2, arrayBuffer: () => late.promise }], configurable: true });
  event('tools-import-file', 'change'); controller.connect(null); late.resolve(new TextEncoder().encode('[]').buffer); await tick();
  assert.equal($('tools-import-text').value, ''); assert.equal($('tools-json-input').value, ''); assert.equal($('tools-confirm-collection').value, '');
  assert.equal($('tools-inputs').disabled, true);
});

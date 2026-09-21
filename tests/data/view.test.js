import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createDataController } from '../../dashboard-ui/app/data/controller.js';
import { mountDataView } from '../../dashboard-ui/app/data/view.js';
import { ConnectionError } from '../../dashboard-ui/app/connection/errors.js';
import { fakeConnection, deferred, pageOf, record } from './helpers.js';

const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(overrides = {}) {
  const dom = new JSDOM(html, { url: 'https://admin.example' });
  const controller = createDataController({ createKey: () => 'view-attempt' });
  mountDataView(dom.window.document, controller);
  const fake = fakeConnection(overrides);
  await controller.connect(fake.connection);
  const $ = id => dom.window.document.getElementById(id);
  const submit = id => $(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const change = id => $(id).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  return { dom, controller, $, submit, change, ...fake };
}

test('collection UI has explicit unavailable-discovery/empty state and does not assume names', async () => {
  const { $, calls } = await setup();
  assert.match($('collection-state').textContent, /No collection names/);
  assert.match($('collection-limit').textContent, /does not enumerate/);
  assert.equal($('collection-input').value, '');
  assert.equal(calls.filter(call => call.method === 'listRecords').length, 0);
  assert.equal($('create-record').disabled, true);
});

test('operator-entered collection uses read API; grid preserves falsy/nested values and escapes content', async () => {
  const { $, submit, controller, dom } = await setup({ listRecords: async () => pageOf([record('rec_safe', 3, { title: '<img src=x onerror=alert(1)>', nested: { a: null } })]) });
  $('collection-input').value = 'exact_collection'; submit('open-collection-form'); await flush();
  assert.equal(controller.snapshot().collection, 'exact_collection');
  assert.equal(dom.window.document.querySelectorAll('table img,table script').length, 0);
  const text = $('record-table').textContent;
  assert.match(text, /false/); assert.match(text, /0/); assert.match(text, /\{"a":null\}/);
  assert.equal($('create-record').disabled, false);
});

test('record loading/empty/error states and refresh recovery are visible and actionable', async () => {
  const pending = deferred(); let step = 0;
  const { $, controller } = await setup({ listRecords: async () => {
    if (step === 0) return pending.promise;
    if (step === 1) throw new ConnectionError('api_key_scope_forbidden');
    return pageOf();
  } });
  const load = controller.openCollection('known');
  assert.match($('records-state').textContent, /Loading/); assert.equal($('record-table').getAttribute('aria-busy'), 'true');
  pending.resolve(pageOf([])); await load;
  assert.match($('records-state').textContent, /No records/);
  step = 1; await controller.refresh();
  assert.equal($('records-state').getAttribute('role'), 'alert'); assert.match($('records-state').textContent, /credential/);
  assert.equal($('refresh-records').disabled, false);
  step = 2; $('refresh-records').click(); await flush(); assert.match($('records-state').textContent, /1 records/);
});

test('schema-less create and edit work through real DOM submit handlers, not scraped table cells', async () => {
  const { $, submit, controller, calls } = await setup();
  await controller.openCollection('known'); $('create-record').click(); await flush();
  assert.ok($('record-dialog').open);
  assert.equal($('editor-mode').value, 'json');
  $('json-editor').value = '{"enabled":false,"count":0,"nested":[null,1]}'; submit('record-editor'); await flush();
  assert.deepEqual(calls.find(call => call.method === 'createRecord').args[1], { enabled: false, count: 0, nested: [null, 1] });
  assert.equal($('record-dialog').open, false);
  await controller.openEditor('edit', 'rec_one');
  $('json-editor').value = JSON.stringify({ title: 'Updated', active: false, count: 0 }); submit('record-editor'); await flush();
  assert.deepEqual(calls.find(call => call.method === 'updateRecord').args[2], { title: 'Updated' });
});

test('schema-aware controls serialize typed input and retain exact field names', async () => {
  const schema = [{ name: 'price', type: 'number', default: 0 }, { name: 'Live now', type: 'boolean', default: false }];
  const { $, dom, submit, controller, calls } = await setup({ getCollectionSchema: async () => ({ schema, source: 'configured' }) });
  await controller.openCollection('known'); await controller.openEditor('create');
  assert.equal($('editor-mode').value, 'form');
  const price = dom.window.document.querySelector('[data-field=price]'); price.value = '12.5';
  submit('record-editor'); await flush();
  assert.deepEqual(calls.find(call => call.method === 'createRecord').args[1], { price: 12.5, 'Live now': false });
});

test('JSON-mode validation errors do not silently reset the mode to generated form', async () => {
  const { $, submit, change, controller } = await setup({ getCollectionSchema: async () => ({ schema: [{ name: 'price', type: 'number', default: 0 }], source: 'configured' }) });
  await controller.openCollection('known'); await controller.openEditor('create');
  $('editor-mode').value = 'json'; change('editor-mode');
  $('json-editor').value = '{"price":"not a number"}'; submit('record-editor'); await flush();
  assert.equal($('editor-mode').value, 'json'); assert.equal($('json-editor').value, '{"price":"not a number"}');
  assert.match($('editor-error').textContent, /number/);
});

test('duplicate and delete require a separate explicit submit', async () => {
  const { $, submit, controller, calls } = await setup(); await controller.openCollection('known');
  await controller.openEditor('duplicate', 'rec_one');
  assert.equal(JSON.parse($('json-editor').value).id, undefined);
  assert.equal(calls.some(call => call.method === 'createRecord'), false);
  submit('record-editor'); await flush();
  await controller.openEditor('delete', 'rec_one');
  assert.match($('editor-content').textContent, /Delete this record/);
  assert.equal(calls.some(call => call.method === 'deleteRecord'), false);
  submit('record-editor'); await flush(); assert.equal(calls.filter(call => call.method === 'deleteRecord').length, 1);
});

test('conflict UI blocks save, keeps the draft and exposes latest comparison without auto-overwrite', async () => {
  let latest = false;
  const { $, submit, controller, calls } = await setup({
    updateRecord: async () => { throw new ConnectionError('version_conflict', { status: 409, currentVersion: 2 }); },
    getRecord: async () => record('rec_one', latest ? 2 : 1, { title: latest ? 'Remote title' : 'Original' }),
  });
  await controller.openCollection('known'); await controller.openEditor('edit', 'rec_one');
  $('json-editor').value = JSON.stringify({ title: 'My draft', active: false, count: 0 }); submit('record-editor'); await flush();
  assert.match($('conflict-panel').textContent, /My draft/); assert.equal($('save-record').disabled, true);
  latest = true; $('conflict-panel').querySelector('button').click(); await flush();
  assert.match($('conflict-panel').textContent, /Remote title/);
  assert.equal(calls.filter(call => call.method === 'updateRecord').length, 1);
});

test('schema error does not make legacy JSON collections unusable', async () => {
  const { $, controller } = await setup({ getCollectionSchema: async () => { throw new ConnectionError('network_error'); } });
  await controller.openCollection('legacy');
  assert.equal($('schema-state').getAttribute('role'), 'alert');
  await controller.openEditor('edit', 'rec_one'); assert.equal($('editor-mode').value, 'json');
});

test('session schema import shows provenance and never writes to the backend', async () => {
  const { $, submit, controller, calls } = await setup(); await controller.openCollection('known');
  $('schema-input').value = JSON.stringify([{ name: 'amount', type: 'number' }]); submit('schema-form');
  assert.match($('schema-state').textContent, /session/);
  assert.equal(calls.some(call => /createRecord|updateRecord/.test(call.method)), false);
});

test('record identity opens full JSON and closing restores the live row action after table rerenders', async () => {
  const { controller, $, dom } = await setup(); await controller.openCollection('known');
  const action = [...$('record-table').querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Open JSON rec_one');
  action.focus(); action.click(); await flush(); assert.equal(controller.snapshot().editor.mode, 'raw');
  $('close-editor').click(); await flush();
  assert.equal(dom.window.document.activeElement.getAttribute('aria-label'), 'Open JSON rec_one');
  assert.notEqual(dom.window.document.activeElement, action); // original button was replaced, not focused while detached
});

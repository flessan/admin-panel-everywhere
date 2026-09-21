import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createApiController } from '../../dashboard-ui/app/api-tools/controller.js';
import { mountApiView } from '../../dashboard-ui/app/api-tools/view.js';
import { createTelegraphConnection } from '../../dashboard-ui/app/connectors/telegraph/index.js';
import { config, document as spec, credential, jsonResponse, flush } from './fixtures.js';
const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
async function fixture(t, handler = () => jsonResponse({ ok: true }), document = spec) {
  const dom = new JSDOM(html, { url: 'https://admin.example' }); t.after(() => dom.window.close());
  const controller = createApiController(), calls = [];
  const connection = createTelegraphConnection(config, { fetchImpl: async (url, init) => { calls.push({ url, ...init }); return new URL(url).pathname === '/openapi.json' ? jsonResponse(document) : handler(url, init); } });
  const view = mountApiView(dom.window.document, controller); controller.connect(connection); view.enter(); await flush();
  const $ = id => dom.window.document.getElementById(id);
  const pick = id => { $('api-explorer-tab').click(); [...$('api-operation-list').querySelectorAll('button')].find(button => button.dataset.operation === id).click(); };
  const submit = () => { $('api-request-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); };
  return { dom, controller, calls, view, $, pick, submit };
}

test('API sections and tag-grouped operations render only the catalog; search never creates an endpoint', async t => {
  const { $, calls, dom } = await fixture(t);
  assert.equal(calls.length, 1); assert.match($('api-overview-summary').textContent, /10 documented, 8 executable, 2 documentation-only/);
  assert.deepEqual([...$('api-operation-list').querySelectorAll('h3')].map(node => node.textContent), ['Platform', 'Database', 'Storage', 'S3', 'Future']);
  assert.equal($('api-operation-list').querySelectorAll('[data-operation]').length, 10);
  $('api-search').value = 'S3'; $('api-search').dispatchEvent(new dom.window.Event('input'));
  assert.equal($('api-operation-list').querySelectorAll('[data-operation]').length, 1);
  $('api-search').value = '/invented'; $('api-search').dispatchEvent(new dom.window.Event('input'));
  assert.equal($('api-operation-list').querySelectorAll('[data-operation]').length, 0);
});

test('operation details render inherited/ref schemas, parameters, body editors and auth requirements', async t => {
  const { $, pick } = await fixture(t); pick('POST /api/db/{collection}');
  assert.match($('api-operation-details').textContent, /bearerApi/); assert.match($('api-operation-details').textContent, /Authentication requirements/);
  assert.ok($('api-parameters').querySelector('[data-parameter="collection"][data-location="path"]'));
  assert.ok($('api-parameters').querySelector('[data-parameter="Idempotency-Key"][data-location="header"]'));
  assert.equal($('api-content-type').value, 'application/json'); assert.match($('api-body-schema').textContent, /"title"/); assert.match($('api-body-schema').textContent, /"type": "string"/);
  assert.equal($('api-body-text').value, ''); assert.doesNotMatch($('api-body-schema').textContent, /do-not-import-this-value/);
  pick('PUT /api/storage/{bucket}/{key}'); assert.equal($('api-body-file-label').hidden, false); assert.equal($('api-body-text-label').hidden, true);
  pick('GET /s3/{bucket}'); assert.equal($('api-request-controls').disabled, true); assert.match($('api-operation-details').textContent, /Documentation only/);
  assert.match($('api-operation-details').textContent, /awsSigV4/);
});

test('UI builds parameters and JSON requests; preview makes no operation call and execution resets acknowledgement', async t => {
  const { $, pick, calls, submit } = await fixture(t, () => jsonResponse({ id: 'one' }, 201));
  pick('POST /api/db/{collection}'); $('api-parameters').querySelector('[data-parameter="collection"]').value = 'notes';
  $('api-body-text').value = '{"title":"hello", "password":"private-form-value"}';
  $('api-preview').click(); await flush(); assert.equal(calls.length, 1);
  assert.match($('api-curl').value, /--request 'POST'/); assert.doesNotMatch($('api-curl').value, /private-form-value/);
  submit(); await flush(); assert.equal(calls.length, 1); assert.match($('api-error').textContent, /Confirm execution/);
  $('api-mutation-ack').checked = true; submit(); await flush(); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].body), { title: 'hello', password: 'private-form-value' }); assert.equal($('api-mutation-ack').checked, false);
  assert.match($('api-response-status').textContent, /HTTP 201/); assert.match($('api-response-body').textContent, /one/);
  $('api-history-tab').click(); assert.equal($('api-history-panel').hidden, false); assert.equal($('api-explorer-panel').hidden, true);
  $('api-history-list').querySelector('button').click(); assert.doesNotMatch($('api-history-details').textContent, /private-form-value/);
  assert.match($('api-history-details').textContent, /\[REDACTED\]/);
});

test('untrusted summaries/response HTML render as text; returned credentials are absent from all outputs', async t => {
  const malicious = structuredClone(spec); malicious.paths['/api/health'].get.summary = '<img src=x onerror=alert(1)>';
  const { $, pick, submit, dom } = await fixture(t, () => new Response(`<script>alert(1)</script> ${credential}`, { status: 403, headers: { 'Content-Type': 'text/html', 'X-Echo': credential } }), malicious);
  pick('GET /api/health'); assert.equal($('api-operation-details').querySelector('img'), null);
  assert.match($('api-operation-details').textContent, /<img/); submit(); await flush();
  assert.match($('api-response-status').textContent, /HTTP 403/); assert.match($('api-response-body').textContent, /<script>/);
  assert.equal($('api-response-body').querySelector('script'), null);
  assert.doesNotMatch($('api-workspace').textContent, new RegExp(credential)); assert.doesNotMatch($('api-curl').value + $('api-javascript').value, new RegExp(credential));
  assert.equal(dom.window.alert.toString().includes('alert(1)'), false);
});

test('OpenAPI view is read-only/redacted, clipboard success and selectable failure fallback work', async t => {
  const { $, pick, dom } = await fixture(t); $('api-openapi-tab').click();
  assert.equal($('api-openapi-panel').hidden, false); assert.match($('api-spec').textContent, /"openapi": "3.1.0"/);
  assert.doesNotMatch($('api-spec').textContent, /do-not-import-this-value/);
  pick('GET /api/health'); $('api-preview').click(); await flush();
  const copied = []; Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { async writeText(value) { copied.push(value); } } });
  $('api-copy-curl').click(); await flush(); assert.equal(copied[0], $('api-curl').value); assert.match($('api-copy-status').textContent, /Copied/);
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { async writeText() { throw Error('denied'); } } });
  $('api-copy-javascript').click(); await flush(); assert.match($('api-copy-status').textContent, /manually/);
  assert.equal($('api-javascript').selectionEnd, $('api-javascript').value.length);
});

test('clear history/disconnect erase all request outputs and editors; invalid and empty specs have explicit states', async t => {
  const { $, pick, submit, controller } = await fixture(t); pick('GET /api/health'); submit(); await flush();
  assert.equal($('api-history-list').children.length, 1); $('api-history-clear').click(); assert.equal($('api-history-list').children.length, 0);
  controller.connect(null); assert.equal($('api-curl').value, ''); assert.equal($('api-javascript').value, ''); assert.equal($('api-body-text').value, ''); assert.equal($('api-body-file').value, '');
  assert.equal($('api-response-body').textContent, ''); assert.equal($('api-editor').hidden, true); assert.match($('api-state').textContent, /Connect/);
  const empty = await fixture(t, undefined, { openapi: '3.1.0', paths: {} }); assert.match(empty.$('api-state').textContent, /No operations/);
  const invalid = await fixture(t, undefined, { openapi: 'invalid', paths: {} }); assert.match(invalid.$('api-error').textContent, /supported OpenAPI/);
});

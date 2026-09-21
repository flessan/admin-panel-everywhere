import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setActiveConnection } from '../../dashboard-ui/app/connection/active.js';
import { document as spec, credential, jsonResponse, flush } from './fixtures.js';

test('real entry wires lazy API discovery, safe preview/execution, history and disconnect without touching Data/Files', async t => {
  const dom = new JSDOM(await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8'), { url: 'https://admin.example' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }, calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: async (url, options) => {
    calls.push({ url, ...options }); return new URL(url).pathname === '/openapi.json' ? jsonResponse(spec) : jsonResponse({ access_token: 'issued-token-fixture', echo: credential }, 201);
  } });
  t.after(() => { setActiveConnection(null); Object.assign(globalThis, previous); dom.window.close(); });
  await import('../../dashboard-ui/app/index.js');
  const $ = id => dom.window.document.getElementById(id);
  const submit = id => $(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  $('connection-key').value = credential; submit('connection-form'); await flush(); assert.equal(calls.length, 0);
  $('api-workspace-tab').click(); await flush(); assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).pathname, '/openapi.json');
  assert.equal(calls[0].headers.has('authorization'), false);
  assert.equal($('api-workspace').hidden, false); assert.equal($('data-workspace').hidden, true); assert.equal($('files-workspace').hidden, true);
  $('api-explorer-tab').click(); [...$('api-operation-list').querySelectorAll('button')].find(button => button.dataset.operation === 'POST /api/auth/token').click();
  $('api-body-text').value = '{"expires_in":120}'; $('api-preview').click(); await flush(); assert.equal(calls.length, 1);
  $('api-mutation-ack').checked = true; submit('api-request-form'); await flush(); assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get('authorization'), `Bearer ${credential}`); assert.equal(new URL(calls[1].url).pathname, '/api/auth/token');
  assert.match($('api-response-status').textContent, /201/); assert.doesNotMatch($('api-response-body').textContent, /issued-token-fixture/);
  $('api-history-tab').click(); $('api-history-list').querySelector('button').click(); assert.doesNotMatch($('api-history-details').textContent, new RegExp(credential));
  $('disconnect').click(); assert.equal($('api-history-list').children.length, 0); assert.equal($('api-curl').value, ''); assert.equal($('api-body-text').value, ''); assert.equal($('connection-key').value, '');
});

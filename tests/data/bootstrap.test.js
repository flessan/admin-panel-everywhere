import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { setActiveConnection } from '../../dashboard-ui/app/connection/active.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('static entry connects in memory, loads operator-selected data, creates through Telegraph and disconnects', async t => {
  const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://admin.example' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const calls = [];
  const record = { data: { id: 'rec_wire', title: 'Actual connector fixture', active: false }, version: 4 };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(options.method === 'POST' ? record : { data: [record], has_more: false, next_cursor: null }), {
      status: options.method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    setActiveConnection(null);
    Object.assign(globalThis, previous);
    dom.window.close();
  });
  const storage = t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Persistence forbidden'); });
  await import('../../dashboard-ui/app/index.js');
  const $ = id => dom.window.document.getElementById(id);
  const submit = id => $(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls.length, 0);
  const key = 'test-key-not-a-real-secret';
  $('connection-key').value = key; submit('connection-form'); await flush();
  assert.equal($('connection-key').value, '');
  assert.equal(calls.length, 0); // no invented collection-list endpoint or name probe
  $('collection-input').value = 'operator_chosen'; submit('open-collection-form'); await flush();
  assert.equal(new URL(calls[0].url).pathname, '/api/db/operator_chosen');
  assert.equal(calls[0].headers.get('Authorization'), `Bearer ${key}`);
  assert.ok(!calls[0].url.includes(key));
  assert.match($('record-table').textContent, /Actual connector fixture/);
  $('create-record').click(); await flush();
  $('json-editor').value = '{"title":"New","active":false}'; submit('record-editor'); await flush();
  const create = calls.find(call => call.method === 'POST');
  assert.equal(new URL(create.url).pathname, '/api/db/operator_chosen');
  assert.deepEqual(JSON.parse(create.body), { title: 'New', active: false });
  assert.ok(create.headers.get('Idempotency-Key'));
  assert.match($('notice').textContent, /saved/);
  $('disconnect').click();
  assert.equal($('record-table').textContent, '');
  assert.equal($('collection-list').textContent, '');
  assert.equal(storage.mock.callCount(), 0);
});

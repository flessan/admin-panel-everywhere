import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from '../../scripts/build.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test('built entry starts disconnected with public deployment defaults; only runtime credentials reach Telegraph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'admin-production-entry-')), output = join(root, 'dist');
  const privateBuildKey = 'synthetic-private-deployment-key-never-public';
  await build({ output, environment: { TELEGRAPH_URL: 'https://deployment-backend.example', TELEGRAPH_PROJECT: 'prj_deployment', TELEGRAPH_API_KEY: privateBuildKey } });
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://admin.example.pages.dev' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }, calls = [];
  const { setActiveConnection, getActiveConnection } = await import(pathToFileURL(join(output, 'app/connection/index.js')));
  t.after(async () => { setActiveConnection(null); Object.assign(globalThis, previous); dom.window.close(); await rm(root, { recursive: true, force: true }); });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(new URL(url).pathname === '/openapi.json'
      ? { openapi: '3.1.0', paths: { '/api/db/{collection}': { get: {} } } }
      : { data: [], has_more: false }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await import(pathToFileURL(join(output, 'app/index.js')));
  const $ = id => dom.window.document.getElementById(id);
  assert.equal($('connection-url').value, 'https://deployment-backend.example');
  assert.equal($('connection-project').value, 'prj_deployment'); assert.equal($('connection-key').value, '');
  assert.equal($('connection-state').textContent, 'Not connected'); assert.equal(calls.length, 0);
  assert.doesNotMatch(dom.serialize(), new RegExp(privateBuildKey));
  $('connection-key').value = 'synthetic-runtime-session-key';
  $('connection-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await flush();
  assert.equal(calls.length, 0); assert.equal($('connection-key').value, '');
  await getActiveConnection().api.execute({ endpointId: 'GET /api/db/{collection}', pathParameters: { collection: 'notes' } });
  assert.equal(calls.length, 2); assert.ok(calls.every(call => new URL(call.url).origin === 'https://deployment-backend.example'));
  assert.equal(calls[0].headers.has('authorization'), false);
  assert.equal(calls[1].headers.get('authorization'), 'Bearer synthetic-runtime-session-key');
  assert.ok(calls.every(call => !call.url.includes('synthetic-runtime-session-key')));
  $('disconnect').click(); assert.equal($('connection-state').textContent, 'Not connected');
});

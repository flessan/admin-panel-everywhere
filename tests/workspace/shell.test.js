import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountWorkspace, DESTINATIONS } from '../../dashboard-ui/app/workspace/shell.js';
import { createDataController } from '../../dashboard-ui/app/data/controller.js';
import { createFilesController } from '../../dashboard-ui/app/files/controller.js';
import { createApiController } from '../../dashboard-ui/app/api-tools/controller.js';
import { createToolsController } from '../../dashboard-ui/app/tools/controller.js';
import { mountDataView } from '../../dashboard-ui/app/data/view.js';
import { mountFilesView } from '../../dashboard-ui/app/files/view.js';
import { mountApiView } from '../../dashboard-ui/app/api-tools/view.js';
import { mountToolsView } from '../../dashboard-ui/app/tools/view.js';
import { createRedactor } from '../../dashboard-ui/app/connection/redaction.js';
const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(t, { width = 1440, hash = '' } = {}) {
  const dom = new JSDOM(html, { url: `https://workspace.example/${hash}` });
  Object.defineProperty(dom.window, 'innerWidth', { value: width, writable: true });
  const document = dom.window.document, $ = id => document.getElementById(id);
  const data = createDataController(), files = createFilesController(), api = createApiController(), tools = createToolsController();
  mountDataView(document, data); mountFilesView(document, files); mountApiView(document, api); mountToolsView(document, tools);
  let entered = 0; const shell = mountWorkspace(document, { data, files, api, enterApi: () => { entered++; } });
  const event = (id, kind) => $(id).dispatchEvent(new dom.window.Event(kind, { bubbles: true, cancelable: true }));
  const key = (target, key, extra = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }));
  t.after(() => { shell.dispose(); dom.window.close(); });
  return { dom, document, $, shell, data, files, api, event, key, entered: () => entered };
}

test('overview defaults to honest empty session metrics; all requested destinations are present and navigation does not connect', t => {
  const { $, shell, entered } = setup(t);
  assert.equal(shell.snapshot().route, 'overview'); assert.equal($('overview-workspace').hidden, false);
  assert.equal($('data-workspace').hidden, true); assert.equal($('overview-collections').textContent, '—'); assert.equal($('overview-requests').textContent, '0'); assert.equal(entered(), 0);
  for (const route of ['data/collections', 'data/records', 'data/schema', 'files/objects', 'files/buckets', 'api/explorer', 'api/openapi', 'api/history', 'tools/import', 'tools/export', 'tools/bulk', 'tools/json', 'connections/telegraph', 'connections/other', 'settings', 'ai']) assert.ok(DESTINATIONS.some(([id]) => id === route));
  $('data-workspace-tab').click(); assert.equal($('data-workspace').hidden, false); assert.equal($('overview-workspace').hidden, true); assert.equal($('data-workspace-tab').getAttribute('aria-expanded'), 'true');
  shell.navigate('data/schema'); assert.equal($('schema-panel').hidden, false); assert.equal($('records-panel').hidden, true);
  shell.navigate('connections/other'); assert.equal($('connections-other-panel').hidden, false); assert.equal($('connections-telegraph-panel').hidden, true); assert.equal($('connection-key').value, '');
});

test('deep links/back-forward stay allowlisted and subnavigation tracks actual view tabs', async t => {
  const { $, shell, dom } = setup(t, { hash: '#/tools/json' });
  assert.equal($('tools-json-panel').hidden, false); assert.equal(shell.snapshot().route, 'tools/json');
  $('tools-bulk-tab').click(); await tick(); assert.equal(shell.snapshot().route, 'tools/bulk'); assert.equal(dom.window.location.hash, '#/tools/bulk');
  shell.navigate('https://untrusted.example'); assert.equal(shell.snapshot().route, 'overview');
  dom.window.location.hash = '#/files/buckets'; await tick(); assert.equal(shell.snapshot().route, 'files/buckets'); assert.equal($('bucket-input'), dom.window.document.activeElement);
});

test('tabs have roving tabindex and arrow/Home/End navigation without intercepting text input', async t => {
  const { $, shell, key, document } = setup(t); shell.navigate('data'); await tick();
  assert.equal($('records-tab').tabIndex, 0); assert.equal($('schema-tab').tabIndex, -1);
  $('records-tab').focus(); key($('records-tab'), 'ArrowRight'); await tick();
  assert.equal(document.activeElement, $('schema-tab')); assert.equal($('schema-tab').tabIndex, 0); assert.equal(shell.snapshot().route, 'data/schema');
  key($('schema-tab'), 'Home'); await tick(); assert.equal($('records-panel').hidden, false);
  shell.navigate('connections'); $('connection-project').focus(); key($('connection-project'), 'ArrowRight'); assert.equal(document.activeElement, $('connection-project'));
});

test('quick navigation works with Ctrl/Meta K, query, arrows and Enter; Escape restores focus and unknown queries have an empty state', async t => {
  const { $, document, key, event, shell } = setup(t); $('command-open').focus(); key(document.body, 'k', { ctrlKey: true });
  assert.equal($('command-dialog').open, true); assert.equal(document.activeElement, $('command-search'));
  $('command-search').value = 'not a destination'; event('command-search', 'input'); assert.equal($('command-empty').hidden, false);
  $('command-search').value = 'json'; event('command-search', 'input'); assert.equal($('command-results').querySelectorAll('button').length, 1);
  key($('command-search'), 'ArrowDown'); assert.match(document.activeElement.textContent, /JSON/); document.activeElement.click(); await tick();
  assert.equal(shell.snapshot().route, 'tools/json'); assert.equal($('command-dialog').open, false);
  $('command-open').focus(); key(document.body, 'k', { metaKey: true }); event('command-dialog', 'cancel'); assert.equal(document.activeElement, $('command-open'));
  $('ai-instructions').focus(); key($('ai-instructions'), '?'); assert.equal($('shortcuts-dialog').open, false);
});

test('mobile navigation keeps closed sidebar inert, traps focus while open, restores focus, and clears inertness on desktop', t => {
  const { $, shell, dom, document, key } = setup(t, { width: 390 });
  assert.equal($('app-sidebar').inert, true); $('open-navigation').click(); assert.equal(shell.snapshot().drawerOpen, true); assert.equal($('main-content').inert, true);
  assert.equal($('navigation-scrim').hidden, false); assert.equal(document.activeElement, $('close-navigation'));
  const last = $('app-sidebar').querySelector('.sidebar-session'); last.focus(); key(last, 'Tab'); assert.equal(document.activeElement, document.querySelector('.brand'));
  key(document.activeElement, 'Escape'); assert.equal(shell.snapshot().drawerOpen, false); assert.equal(document.activeElement, $('open-navigation'));
  dom.window.innerWidth = 1400; dom.window.dispatchEvent(new dom.window.Event('resize')); assert.equal($('app-sidebar').inert, false); assert.equal($('main-content').inert, false);
});

test('modal record operations are not interrupted by global navigation or command shortcuts', t => {
  const { $, shell, key, document } = setup(t); shell.navigate('data'); $('record-dialog').setAttribute('open', '');
  assert.equal(shell.navigate('settings'), false); key(document.body, 'k', { ctrlKey: true }); assert.equal($('command-dialog').open, false);
  assert.equal(shell.snapshot().route, 'data/records');
});

test('theme, density and wrapping affect presentation only and never touch browser storage', t => {
  const { $, document, dom, event } = setup(t);
  const storage = t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('No persistence'); });
  $('setting-theme').value = 'dark'; event('setting-theme', 'change'); $('setting-density').value = 'compact'; event('setting-density', 'change'); $('setting-wrap').checked = true; event('setting-wrap', 'change');
  assert.equal(document.documentElement.dataset.theme, 'dark'); assert.equal(document.documentElement.dataset.density, 'compact'); assert.equal(document.documentElement.dataset.wrap, 'true'); assert.equal(storage.mock.callCount(), 0);
});

test('configured metadata is sanitized, not called verified; copy is explicit and disconnect clears session chrome', async t => {
  const { $, shell, dom } = setup(t); const secret = 'synthetic-secret-project';
  const sanitize = createRedactor(() => secret);
  shell.setConnection({ metadata: { connector: 'telegraph', project: secret, baseUrl: 'https://fixture.example' }, api: { sanitize } });
  assert.equal($('overview-project').textContent, '[REDACTED]'); assert.equal($('overview-status').textContent, 'Configured');
  let copied; dom.window.navigator.clipboard = { writeText: async text => { copied = text; } };
  $('api-spec').textContent = '{"redacted":true}'; dom.window.document.querySelector('[data-copy-target=api-spec]').click(); await tick(); assert.equal(copied, '{"redacted":true}');
  shell.setConnection(null); assert.equal($('overview-origin').textContent, 'Not configured'); assert.equal($('sidebar-connection').textContent, 'Not connected'); assert.equal($('workspace-feedback').hidden, true);
});

test('programmatic Tools handoffs retain the staged tab instead of switching bulk proposals to Import', async t => {
  const { $, shell } = setup(t); shell.navigate('overview'); $('tools-bulk-tab').click();
  shell.navigate('tools', { activate: false }); await tick(); assert.equal(shell.snapshot().route, 'tools/bulk'); assert.equal($('tools-bulk-panel').hidden, false);
});

test('DOM has unique IDs, labeled native dialogs, no hardcoded demo records or network-dependent decorative assets', t => {
  const { document } = setup(t); const ids = [...document.querySelectorAll('[id]')].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const dialog of document.querySelectorAll('dialog')) assert.ok(document.getElementById(dialog.getAttribute('aria-labelledby')));
  assert.equal(document.querySelectorAll('img[src^="https"],script[src^="https"],link[href^="https"]').length, 0);
  assert.ok(document.querySelector('.skip-link')); assert.ok(document.querySelector('main#main-content'));
});

test('returning to a parent workspace retains its last section without changing drafts', async t => {
  const { $, shell } = setup(t);
  shell.navigate('tools/json'); $('tools-json-input').value = '{"unfinished":true}';
  shell.navigate('settings'); $('tools-workspace-tab').click(); await tick();
  assert.equal(shell.snapshot().route, 'tools/json'); assert.equal($('tools-json-input').value, '{"unfinished":true}');
  shell.navigate('data/schema'); shell.navigate('overview'); $('data-workspace-tab').click(); await tick();
  assert.equal($('schema-panel').hidden, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createFilesController } from '../../dashboard-ui/app/files/controller.js';
import { mountFilesView } from '../../dashboard-ui/app/files/view.js';
import { createDownloadManager } from '../../dashboard-ui/app/files/download.js';
import { ConnectionError } from '../../dashboard-ui/app/connection/errors.js';
import { fakeStorage, object, meta, page, deferred } from './helpers.js';
const html = await readFile(new URL('../../dashboard-ui/index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(overrides, clipboard) {
  const dom = new JSDOM(html, { url: 'https://admin.example' }), c = createFilesController();
  const downloads = { saved: [], cleared: 0, save(result) { this.saved.push(result); }, clear() { this.cleared++; } };
  mountFilesView(dom.window.document, c, { downloads, clipboard });
  const fake = fakeStorage(overrides); await c.connect(fake.connection);
  const $ = id => dom.window.document.getElementById(id);
  const submit = id => $(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, c, downloads, $, submit, ...fake };
}

test('bucket and object browsing show honest empty states and prefix navigation', async () => {
  const { $, submit, c, calls } = await setup({ listObjects: async () => page([], { commonPrefixes: ['photos/'] }) });
  assert.match($('bucket-limit').textContent, /does not enumerate/); assert.equal($('bucket-input').value, '');
  assert.match($('bucket-state').textContent, /No bucket names/);
  $('bucket-input').value = 'media'; submit('open-bucket-form'); await flush();
  assert.equal(c.snapshot().bucket, 'media'); assert.match($('objects-state').textContent, /1 prefixes/);
  $('objects-table').querySelector('button').click(); await flush();
  assert.equal(calls.at(-1).args[1].prefix, 'photos/');
  $('files-up').click(); await flush(); assert.equal(c.snapshot().prefix, '');
});

test('metadata details show size, MIME, exact ETag/version and safely render hostile object names', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { $, c, dom } = await setup({ listObjects: async () => page([{ ...object, key: hostile }]), getObjectMetadata: async () => ({ ...meta, key: hostile, custom: { x: '<script>oops</script>' } }) });
  await c.openBucket('media'); $('objects-table').querySelector('button').click(); await flush();
  assert.equal(dom.window.document.querySelectorAll('#files-workspace img, #object-metadata script').length, 0);
  const text = $('object-metadata').textContent;
  assert.match(text, /3 B/); assert.match(text, /text\/plain/); assert.match(text, /opaque-head-tag/); assert.match(text, /Object version4/);
  assert.match($('etag-note').textContent, /If-Match/);
});

test('upload form sends file, key, content type and custom metadata only after acknowledgement', async () => {
  const { $, submit, dom, c, calls } = await setup(); await c.openBucket('media');
  const file = new Blob(['abc'], { type: 'text/plain' }); Object.defineProperty(file, 'name', { value: 'sample.txt' });
  Object.defineProperty($('upload-file'), 'files', { value: [file], configurable: true });
  $('upload-file').dispatchEvent(new dom.window.Event('change'));
  assert.equal($('upload-key').value, 'sample.txt'); assert.equal($('upload-type').value, 'text/plain');
  submit('upload-form'); await flush(); assert.equal(calls.some(call => call.method === 'uploadObject'), false);
  $('upload-ack').checked = true; $('upload-metadata').value = '{"label":"sample"}'; submit('upload-form'); await flush();
  const call = calls.find(call => call.method === 'uploadObject');
  assert.equal(call.args[2], file); assert.equal(call.args[1], 'sample.txt'); assert.deepEqual(call.args[3].metadata, { label: 'sample' });
  assert.match($('files-notice').textContent, /uploaded/);
});

test('download submit saves binary output, not an authenticated URL or inline content', async () => {
  const { $, c, submit, downloads, calls } = await setup(); await c.openBucket('media'); await c.openObject(object.key);
  submit('download-form'); await flush();
  assert.equal(downloads.saved.length, 1); assert.equal(await downloads.saved[0].data.text(), 'abc');
  assert.equal(calls.at(-1).args[2].ifMatch, meta.etag);
  await c.connect(null); assert.equal($('object-metadata').textContent, ''); assert.ok(downloads.cleared >= 3);
});

test('failed download shows an actionable error and does not save a blob', async () => {
  const { $, c, submit, downloads } = await setup({ downloadObject: async () => { throw new ConnectionError('request_failed', { status: 412 }); } });
  await c.openBucket('media'); await c.openObject(object.key); submit('download-form'); await flush();
  assert.match($('files-error').textContent, /ETag changed/); assert.equal(downloads.saved.length, 0);
  assert.equal($('object-refresh').disabled, false);
});

test('delete dialog identifies target, warns about concurrency, and requires a second submit', async () => {
  const { $, c, submit, calls } = await setup(); await c.openBucket('media'); await c.openObject(object.key);
  $('delete-object').click(); assert.equal($('object-delete-dialog').open, true);
  assert.match($('object-delete-target').textContent, /photos\/test.txt/);
  assert.match($('object-delete-dialog').textContent, /does not document atomic/);
  submit('delete-object-form'); await flush(); assert.equal(calls.some(call => call.method === 'deleteObject'), false);
  $('delete-object-ack').checked = true; submit('delete-object-form'); await flush();
  assert.equal(calls.filter(call => call.method === 'deleteObject').length, 1); assert.equal($('object-delete-dialog').open, false);
});

test('copy uses a credential-free connector address, labels auth requirement and offers manual fallback', async () => {
  const copied = [];
  const { $, c } = await setup({}, { async writeText(value) { copied.push(value); } });
  await c.openBucket('media'); await c.openObject(object.key); $('copy-object-url').click(); await flush();
  assert.equal(copied[0], 'https://storage.example/api/storage/media/photos/test.txt'); assert.match($('copy-result').textContent, /Bearer credential/);
  const manual = await setup({}, { async writeText() { throw new Error('denied'); } });
  await manual.c.openBucket('media'); await manual.c.openObject(object.key); manual.$('copy-object-url').click(); await flush();
  assert.match(manual.$('copy-result').textContent, /manually/); assert.equal(manual.$('object-url').readOnly, true);
});

test('object listing loading/empty/error and metadata failure do not leave unsafe actions enabled', async () => {
  const pending = deferred(); let fail = false;
  const { $, c } = await setup({ listObjects: async () => { if (fail) throw new ConnectionError('request_failed', { status: 403 }); return pending.promise; },
    getObjectMetadata: async () => { throw new ConnectionError('request_failed', { status: 404 }); } });
  const load = c.openBucket('media'); assert.match($('objects-state').textContent, /Loading/);
  pending.resolve(page([])); await load; assert.match($('objects-state').textContent, /No objects/);
  fail = true; await c.refresh(); assert.equal($('objects-state').getAttribute('role'), 'alert');
  await c.openObject('missing'); assert.equal($('object-state').getAttribute('role'), 'alert'); assert.equal($('delete-object').disabled, true);
});

test('download manager forces attachment, marks partial files and revokes URLs on timeout/disconnect', () => {
  const { window } = new JSDOM('<body></body>'); const created = [], revoked = [], callbacks = [], clicked = [];
  window.HTMLAnchorElement.prototype.click = function () { clicked.push({ href: this.href, name: this.download }); };
  const downloads = createDownloadManager(window.document, {
    urls: { createObjectURL(blob) { created.push(blob); return `blob:fixture-${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    schedule(callback) { callbacks.push(callback); return callbacks.length; }, cancel() {},
  });
  downloads.save({ data: new Blob(['<script>bad()</script>'], { type: 'text/html' }), key: 'folder/report.html', partial: true });
  assert.equal(created[0].type, 'application/octet-stream'); assert.equal(clicked[0].name, 'report.html.part');
  assert.equal(window.document.querySelectorAll('a,iframe,img,script').length, 0);
  callbacks[0](); assert.deepEqual(revoked, ['blob:fixture-1']);
  downloads.save({ data: new Blob([]), key: 'empty' }); downloads.clear(); assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2']);
});

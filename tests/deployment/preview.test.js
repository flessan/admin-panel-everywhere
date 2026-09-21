import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build } from '../../scripts/build.mjs';
import { createPreviewServer } from '../../scripts/serve.mjs';

async function fixture(t, allowEmbedding = false) {
  const directory = await mkdtemp(join(tmpdir(), 'admin-preview-test-')), output = join(directory, 'dist');
  const artifact = await build({ output, environment: {} });
  const server = await createPreviewServer({ root: output, allowEmbedding }); server.listen(0, '0.0.0.0'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { output, artifact, request: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}

test('local preview serves production HTML/modules/CSS and security headers for proxied hosts', async t => {
  const { request } = await fixture(t);
  const page = await request('/', { headers: { host: '3214-sandbox.e2b.app' } }); assert.equal(page.status, 200);
  assert.match(await page.text(), /connection-form/); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  for (const path of ['/app/index.js', '/app/public-config.js', '/assets/styles.css']) {
    const response = await request(path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript|css/);
  }
  const head = await request('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('preview is read-only: no old API, config, traversal, metadata or filesystem persistence', async t => {
  const { request, artifact, output } = await fixture(t);
  const before = await Promise.all(artifact.files.map(name => readFile(join(output, name), 'utf8')));
  await symlink(new URL('../../package.json', import.meta.url), join(output, 'outside.js'));
  for (const path of ['/api/db/notes', '/.env', '/.git/config', '/package.json', '/_headers', '/server/db.js', '/outside.js', '/%2e%2e%2f.env', '/missing']) {
    const response = await request(path); assert.equal(response.status, 404); assert.match(await response.text(), /no local database or backend API/);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request('/api/db/notes', { method, body: '{}' })).status, 405);
  assert.deepEqual(await Promise.all(artifact.files.map(name => readFile(join(output, name), 'utf8'))), before);
});

test('explicit local embedding opt-in does not alter the production security artifact', async t => {
  const { request, output } = await fixture(t, true);
  const response = await request('/'); assert.doesNotMatch(response.headers.get('content-security-policy'), /frame-ancestors/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await readFile(join(output, '_headers'), 'utf8'), /frame-ancestors 'none'/);
});

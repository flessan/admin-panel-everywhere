import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const root = new URL('../../', import.meta.url);

test('Pages configuration is static-only and package commands never start the retired server', async () => {
  const config = JSON.parse((await readFile(new URL('wrangler.jsonc', root), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.pages_build_output_dir, './dist');
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'compatibility_date', 'name', 'pages_build_output_dir']);
  for (const path of ['functions', 'dist/_worker.js', 'server', 'index.js']) await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' });
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}); assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
  assert.equal(pkg.scripts.start, 'npm run preview'); assert.equal(pkg.scripts['pages:preview'], 'node scripts/pages-preview.mjs');
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /lowdb|express|DB_FILE_ABS_PATH|node index\.js/);
});

test('Wrangler development launchers cannot implicitly bind .env or process secrets', async () => {
  for (const script of ['scripts/pages-preview.mjs', 'scripts/verify-pages.mjs']) {
    const code = await readFile(new URL(script, root), 'utf8');
    assert.match(code, /CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false'/);
    assert.match(code, /CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false'/);
    assert.match(code, /--env-file/);
  }
  const empty = await readFile(new URL('deployment/preview.env', root), 'utf8');
  assert.equal(empty.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).length, 0);
});

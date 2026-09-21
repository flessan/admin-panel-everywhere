import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, publicEnvironment } from '../../scripts/build.mjs';
const repository = new URL('../../', import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'admin-build-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'dist');
}

test('build emits only the reachable browser graph and explicit Pages assets, with no backend runtime', async t => {
  const output = await fixture(t), result = await build({ output, environment: {} });
  for (const name of ['index.html', '404.html', '_headers', 'app/index.js', 'app/public-config.js', 'assets/styles.css']) assert.ok(result.files.includes(name));
  assert.ok(result.files.every(name => ['index.html', '404.html', '_headers', 'assets/styles.css'].includes(name) || /^app\/.+\.js$/.test(name)));
  assert.ok(!result.files.some(name => /server\/|node_modules|\.env|package|\.map$|\.d\.ts$|icons|services|functions|_worker/.test(name)));
  for (const name of result.files) {
    const contents = await readFile(join(output, name), 'utf8');
    assert.doesNotMatch(contents, /DB_FILE_ABS_PATH|from\s+['"](?:node:|express|lowdb)|require\s*\(/);
    if (name.endsWith('.js')) for (const [, dependency] of contents.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)) assert.ok(dependency.startsWith('.'));
  }
  assert.equal((await readFile(new URL('../../package.json', import.meta.url), 'utf8')).includes('"dependencies"'), false);
});

test('environment allowlist supports public defaults and excludes every private build variable', async t => {
  const output = await fixture(t), secret = 'synthetic-deployment-credential-do-not-publish';
  const result = await build({ output, environment: { TELEGRAPH_URL: 'https://service.example/', TELEGRAPH_PROJECT: 'prj_production', TELEGRAPH_API_KEY: secret,
    DB_FILE_ABS_PATH: '/should-never-be-read/database.json', UNRELATED_SECRET: 'unrelated-private-test-value' } });
  assert.deepEqual(result.config, { TELEGRAPH_URL: 'https://service.example', TELEGRAPH_PROJECT: 'prj_production' });
  const module = await readFile(join(output, 'app/public-config.js'), 'utf8');
  assert.match(module, /https:\/\/service.example/); assert.match(module, /prj_production/); assert.doesNotMatch(module, /TELEGRAPH_API_KEY/);
  for (const name of result.files) assert.doesNotMatch(await readFile(join(output, name), 'utf8'), /synthetic-deployment-credential|unrelated-private-test-value|should-never-be-read/);
});

test('bad public environment is rejected without echoing values; private key in a public default fails closed', async t => {
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://example.com/#x', ' https://example.com', '']) {
    assert.throws(() => publicEnvironment({ TELEGRAPH_URL: value }), /HTTPS origin/);
  }
  for (const value of ['bad', '', 'prj_<script>', 'prj_hello\n']) assert.throws(() => publicEnvironment({ TELEGRAPH_PROJECT: value }), /project identifier/);
  const output = await fixture(t);
  await assert.rejects(build({ output, environment: { TELEGRAPH_PROJECT: 'prj_privateexample', TELEGRAPH_API_KEY: 'privateexample' } }), /private deployment credential/);
  assert.deepEqual(await readdir(join(output, '..')), []);
});

test('rebuild is deterministic and removes stale output instead of shipping old server/config files', async t => {
  const output = await fixture(t), initial = await build({ output, environment: {} });
  const before = await Promise.all(initial.files.map(name => readFile(join(output, name), 'utf8')));
  await writeFile(join(output, '.env'), 'do-not-ship'); await writeFile(join(output, 'old-backend.js'), 'legacy');
  const next = await build({ output, environment: {} });
  assert.deepEqual(await Promise.all(next.files.map(name => readFile(join(output, name), 'utf8'))), before);
  assert.ok(!(await readdir(output)).includes('.env')); assert.ok(!(await readdir(output)).includes('old-backend.js'));
});

test('build output cannot target the repository root, source tree or git metadata', async () => {
  for (const path of ['.', 'dashboard-ui', '.git']) await assert.rejects(build({ output: new URL(path, repository).pathname, environment: {} }), /Unsafe build output/);
});

test('build CLI never prints a private credential on configuration failure', () => {
  const secret = 'synthetic-no-build-log-credential';
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: repository, encoding: 'utf8', env: { ...process.env, TELEGRAPH_URL: `https://user:${secret}@invalid.example`, TELEGRAPH_API_KEY: secret } });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

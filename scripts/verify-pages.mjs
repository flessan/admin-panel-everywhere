// Bounded, unauthenticated local integration check against Cloudflare's actual
// Pages emulator. Nothing is deployed; no Telegraph requests or app writes occur.
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build, outputDirectory } from './build.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'admin-pages-check-'));
let child, exited, stage = 'build', diagnostic = '';
try {
  await build();
  await cp(outputDirectory, join(temporary, 'dist'), { recursive: true });
  await cp(join(repository, 'wrangler.jsonc'), join(temporary, 'wrangler.jsonc'));
  await cp(join(repository, 'deployment/preview.env'), join(temporary, 'preview.env'));
  // Do not inherit deployment credentials or read the repository's legacy .env.
  const environment = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary,
    CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', BROWSER: 'none', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };
  stage = 'emulator startup';
  child = spawn(process.execPath, [join(repository, 'node_modules/wrangler/bin/wrangler.js'), 'pages', 'dev', 'dist',
    '--cwd', temporary, '--env-file', join(temporary, 'preview.env'), '--ip', '0.0.0.0', '--port', '0', '--inspector-port', '0'], {
    cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  exited = new Promise(resolve => child.once('exit', resolve));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Pages emulator startup timed out.')), 60000);
    let output = '';
    const consume = chunk => {
      output = (output + chunk.toString()).slice(-16000); diagnostic = output;
      const match = output.match(/Ready on http:\/\/[^\s:]+:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Pages emulator could not start.')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Pages emulator exited before becoming ready.')); });
  });
  const request = path => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  stage = 'static page and headers';
  const page = await request('/');
  assert.equal(page.status, 200); assert.match(await page.text(), /api-workspace-tab/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  for (const path of ['/app/index.js', '/app/public-config.js', '/app/connectors/telegraph/index.js', '/assets/styles.css']) {
    stage = `asset check ${path}`;
    const response = await request(path); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript|css/); await response.arrayBuffer();
  }
  for (const path of ['/.env', '/.git/config', '/package.json', '/server/db.js', '/api/db/notes', '/missing']) {
    stage = `asset check ${path}`;
    const response = await request(path);
    if (response.status !== 404) console.error(`Expected missing static path returned HTTP ${response.status}.`);
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  stage = 'reserved Pages metadata';
  const metadata = await request('/_headers');
  const metadataBody = await metadata.text();
  // Wrangler 4.135.0 probes _headers/index.html and reports ENOTDIR (502).
  // Pages does not upload this metadata as an asset. Accept only that known
  // emulator error or a real 404, never successful delivery of the header file.
  assert.ok(metadata.status === 404 || (metadata.status === 502 && /ENOTDIR/.test(metadataBody)));
  assert.ok(!metadataBody.includes("script-src 'self'"));
  if (metadata.status === 502) console.log('Note: reserved /_headers is withheld; Wrangler reports its known ENOTDIR/502 emulator quirk instead of 404.');
  assert.ok(!diagnostic.includes('env.DB_FILE_ABS_PATH'));
  assert.ok(!diagnostic.includes('env.TELEGRAPH_API_KEY'));
  stage = 'missing local API POST';
  const mutation = await fetch(`http://127.0.0.1:${port}/api/db/notes`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) });
  assert.ok([404, 405].includes(mutation.status)); await mutation.arrayBuffer();
  console.log('Cloudflare Pages emulator verified: assets, security headers, real 404s, no local API, no secrets/configuration files served. No deployment or Telegraph request performed.');
} catch {
  console.error(`Cloudflare Pages compatibility check failed at ${stage}.`);
  // Child runs in an isolated directory with no credentials/bindings or inherited secrets.
  if (stage === 'emulator startup') console.error(diagnostic);
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    const terminate = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Already stopped. */ } };
    terminate('SIGTERM');
    const timer = setTimeout(() => terminate('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  }
  await rm(temporary, { recursive: true, force: true });
}

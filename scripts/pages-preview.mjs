// Development-only Wrangler launcher. Never import legacy .env/.dev.vars or
// mirror shell secrets into the emulator's Worker shim as application bindings.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'pages', 'dev', 'dist', '--ip', '0.0.0.0', '--port', '8788',
  '--env-file', fileURLToPath(new URL('../deployment/preview.env', import.meta.url))], {
  cwd: repository, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false' },
});
child.on('error', () => { console.error('Wrangler preview could not start. Install development dependencies first.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

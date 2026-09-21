// Build-time tooling only; never copied to the Pages artifact.
import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicConfig as defaults } from '../dashboard-ui/app/public-config.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(repository, 'dashboard-ui');
export const outputDirectory = resolve(repository, 'dist');
const inside = (parent, path) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

export function publicEnvironment(environment = {}) {
  const urlValue = environment.TELEGRAPH_URL ?? defaults.TELEGRAPH_URL;
  const project = environment.TELEGRAPH_PROJECT ?? defaults.TELEGRAPH_PROJECT;
  let url;
  try {
    url = new URL(urlValue);
    if (typeof urlValue !== 'string' || urlValue !== urlValue.trim() || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
  } catch { throw new Error('TELEGRAPH_URL must be an HTTPS origin without credentials, path, query or fragment.'); }
  if (typeof project !== 'string' || !/^prj_[A-Za-z0-9_-]+$/.test(project)) throw new Error('TELEGRAPH_PROJECT must be a non-secret prj_ project identifier.');
  // Do not spread environment, serialize bindings, or substitute API_KEY here.
  return { TELEGRAPH_URL: url.origin, TELEGRAPH_PROJECT: project };
}

async function safeRead(root, name) {
  const path = resolve(root, name);
  if (!inside(root, path)) throw new Error('A static asset escaped its source directory.');
  let current = root;
  for (const part of relative(root, path).split('/')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Static asset symlinks are not supported.');
  }
  return readFile(path, 'utf8');
}

/** A small explicit static build: reachable browser modules, CSS, HTML, headers. */
export async function build({ environment = process.env, output = outputDirectory } = {}) {
  output = resolve(output);
  if (inside(output, repository) || inside(source, output) || inside(resolve(repository, '.git'), output)) throw new Error('Unsafe build output directory.');
  try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Build output must not be a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = publicEnvironment(environment);
  const files = new Map();
  async function visit(name) {
    if (files.has(name)) return;
    if (!name.startsWith('app/') || !name.endsWith('.js')) throw new Error('Only local browser ES modules may enter the production graph.');
    const contents = name === 'app/public-config.js'
      ? `// Public deployment defaults; no credentials.\nexport const publicConfig = Object.freeze(${JSON.stringify(config, null, 2)});\n`
      : await safeRead(source, name);
    const code = contents.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    if (/\b(?:require\s*\(|process\s*\.|import\s*\(|import\.meta\.env|DB_FILE_ABS_PATH\b)|(?:localStorage|sessionStorage|indexedDB)\s*\./.test(code)) throw new Error('A non-static or persistent runtime dependency entered the browser graph.');
    files.set(name, contents);
    const dependencies = [...code.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g), ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)];
    for (const [, dependency] of dependencies) {
      if (!dependency.startsWith('.')) throw new Error('Production modules must use relative browser imports, not Node or package imports.');
      const path = resolve(source, dirname(name), dependency);
      if (!inside(source, path)) throw new Error('A browser import escaped the static application.');
      await visit(relative(source, path).split('\\').join('/'));
    }
  }
  await visit('app/index.js');
  files.set('index.html', await safeRead(source, 'index.html'));
  files.set('assets/styles.css', await safeRead(source, 'assets/styles.css'));
  for (const name of ['404.html', '_headers']) files.set(name, await safeRead(resolve(repository, 'deployment'), name));

  // Defense against accidentally putting the build environment's private key in
  // a public URL/project or a checked-in asset. Never include its value in errors.
  const key = environment.TELEGRAPH_API_KEY;
  if (typeof key === 'string' && key) {
    const forbidden = [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1), Buffer.from(key).toString('base64')];
    if ([...files.values()].some(text => forbidden.some(secret => text.includes(secret)))) throw new Error('Build refused: a private deployment credential would be published in a static asset.');
  }
  // All validation completes before replacing the artifact. No app data is read
  // or written: only reproducible static build products are created here.
  await rm(output, { recursive: true, force: true });
  for (const [name, contents] of files) {
    const path = resolve(output, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents);
  }
  return { files: [...files.keys()].sort(), config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await build();
    if (process.env.TELEGRAPH_API_KEY) console.warn('TELEGRAPH_API_KEY is not exported. Supply the browser credential through the runtime session form.');
    console.log(`Built ${result.files.length} static assets in dist/. No server runtime or Functions required.`);
  } catch {
    // No arbitrary error, path, environment value, stack or cause in build logs.
    console.error('Production build failed. Check public TELEGRAPH_URL / TELEGRAPH_PROJECT configuration, credential isolation and static asset imports.');
    process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = new URL('../../dashboard-ui/app/', import.meta.url);

async function moduleGraph(entry, seen = new Map()) {
  if (seen.has(entry.href)) return seen;
  const source = await readFile(entry, 'utf8');
  seen.set(entry.href, source);
  for (const [, dependency] of source.matchAll(/(?:import|export)\s[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
    assert.ok(dependency.startsWith('.'), `Non-static runtime dependency in ${entry.pathname}`);
    const resolved = new URL(dependency, entry);
    assert.ok(resolved.href.startsWith(app.href), 'Runtime import escaped the static application');
    await moduleGraph(resolved, seen);
  }
  return seen;
}

test('active shell and Telegraph connector are a self-contained static ES-module graph', async () => {
  const graph = await moduleGraph(new URL('index.js', app));
  await moduleGraph(new URL('connectors/telegraph/index.js', app), graph);
  assert.ok(graph.size >= 12);
  for (const [file, source] of graph) {
    const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /(?:localStorage|sessionStorage|indexedDB)\s*\.|process\.env|import\.meta\.env/);
    // Only this exact inert source-code template is exempt, not the generator module.
    const networkCode = file.endsWith('/api-tools/examples.js')
      ? code.replace('`  return fetch(${JSON.stringify(preview.url)}, {`,', '') : code;
    if (!file.endsWith('/request-client.js')) assert.doesNotMatch(networkCode, /\bfetch\s*\(/);
  }
  assert.ok(![...graph.keys()].some(file => file.endsWith('/actions.js')), 'Unsafe positional editor must remain disconnected');
});

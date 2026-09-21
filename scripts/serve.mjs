// Local-only read-only preview. Cloudflare Pages serves dist/ directly in production.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, extname, isAbsolute } from 'node:path';
export const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const inside = (root, file) => { const path = relative(root, file); return !path.startsWith('..') && !isAbsolute(path); };

export async function createPreviewServer({ root = defaultRoot, allowEmbedding = false } = {}) {
  root = await realpath(root);
  await stat(resolve(root, 'index.html'));
  // The production header file has a single all-path rule. Keep local behavior
  // aligned; only the explicit embedding option relaxes frame-ancestors locally.
  const headers = {};
  for (const line of (await readFile(resolve(root, '_headers'), 'utf8')).split('\n')) {
    const match = line.match(/^\s+([\w-]+):\s*(.*)$/); if (match) headers[match[1]] = match[2];
  }
  if (allowEmbedding) headers['Content-Security-Policy'] = headers['Content-Security-Policy']?.replace(/;?\s*frame-ancestors[^;]*/g, '');
  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    // Local assets may change on rebuild. This isn't a data/cache persistence API.
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://static.invalid').pathname);
      if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.') || part.startsWith('_'))) throw new Error();
      let file = resolve(root, `.${pathname}`);
      if (!inside(root, file)) throw new Error();
      file = await realpath(file); if (!inside(root, file)) throw new Error();
      if ((await stat(file)).isDirectory()) { file = await realpath(resolve(file, 'index.html')); if (!inside(root, file)) throw new Error(); }
      if (!types[extname(file)]) throw new Error();
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      const data = await readFile(resolve(root, '404.html')).catch(() => 'Not found');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : data);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await createPreviewServer({ allowEmbedding: process.env.PREVIEW_ALLOW_EMBEDDING === '1' });
    const port = Number(process.env.PORT || 3214);
    server.on('error', () => { console.error('Local preview could not start. Check PORT availability.'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log(`Static local preview on port ${server.address().port}. Production runs on Cloudflare Pages, not this server.`));
  } catch { console.error('Preview artifact unavailable. Run npm run build first.'); process.exitCode = 1; }
}

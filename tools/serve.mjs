/** Static file server for the browser tests. No dependencies, no config. */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8931);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
};

createServer((req, res) => {
  const path = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    return void res.writeHead(404).end('not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // The decode path is same-origin only, but a worker test loads from a blob.
    'cross-origin-resource-policy': 'cross-origin',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));

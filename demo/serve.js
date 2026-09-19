// Static server for the checkout page. Loopback only, no dependencies.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('./', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.env.PORT || 5174);

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://localhost:${port}`);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(base, relative);
    // Never serve outside the demo folder.
    if (path.relative(base, file).startsWith('..')) { res.writeHead(403).end('Forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Checkout demo: http://127.0.0.1:${port}`));

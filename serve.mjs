// Tiny static server for local development — serves ./public with correct
// MIME types (Windows Python http.server serves .mjs as text/plain, which
// breaks module scripts). Usage: node serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// repo root = site root (trailing separator stripped so the guard below
// compares clean prefixes)
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const PORT = Number(process.argv[2]) || 8788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
      throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    }
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT + sep) && path !== ROOT) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    if (url.pathname.endsWith('/')) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403');
    }
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fast·md dev server → http://localhost:${PORT}`);
});

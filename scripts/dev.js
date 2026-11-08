// Zero-dependency static server for the web shell. ES modules cannot load from
// file://, so the page has to be served even though nothing is compiled.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const ENTRY = '/apps/web/';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Only the page and the code it loads are served, and only to this machine:
// a request naming another host (a web page rebinding its DNS to 127.0.0.1)
// gets nothing.
const SERVED = ['/apps/web/', '/packages/'];
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

const server = createServer(async (req, res) => {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) {
    res.writeHead(403).end();
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (relative === '/') {
    res.writeHead(302, { Location: ENTRY }).end();
    return;
  }
  const target = normalize(join(ROOT, relative));
  const path = `/${target.slice(ROOT.length + 1).split(sep).join('/')}`;
  const allowed = target.startsWith(ROOT + sep) && SERVED.some((prefix) => `${path}/`.startsWith(prefix)) && !/\/(?:\.|node_modules\/)/.test(path);
  if (!allowed) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

let port = Number(process.env.PORT ?? 5173);
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT) {
    port += 1;
    server.listen(port, '127.0.0.1');
  } else {
    throw error;
  }
});
server.on('listening', () => console.log(`Archslate: http://localhost:${port}${ENTRY}`));
server.listen(port, '127.0.0.1');

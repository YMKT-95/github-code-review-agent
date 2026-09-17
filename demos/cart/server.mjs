import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only public demo assets; never expose the repository or its .env file.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/pricing.js', ['pricing.js', 'text/javascript; charset=utf-8']],
  ['/tote.svg', ['tote.svg', 'image/svg+xml']],
]);
const port = Number(process.env.DEMO_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEMO_PORT.');
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const asset = assets.get(path);
  if (!asset || !['GET', 'HEAD'].includes(request.method ?? '')) {
    response.writeHead(404); response.end('Not found'); return;
  }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, {
      'Content-Type': asset[1], 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(500); response.end('Unable to load demo asset');
  }
});
server.on('error', (error) => { console.error(`Cart demo could not start: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Cart demo: http://127.0.0.1:${port}\nPress Ctrl+C to stop.`));

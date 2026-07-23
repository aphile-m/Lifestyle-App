// Tiny static server for previewing www/ during development
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'www');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = 'index.html';
  const p = path.join(root, rel);
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(d);
  });
}).listen(8123, () => console.log('Trainer App dev server on http://localhost:8123'));

'use strict';
/* static-server.js - serve the NSO site's files to the desktop window.

   The app is static files that fetch() their fixtures, so it needs http, not
   file://. This serves one folder on the loopback address only. It refuses
   anything outside that folder, dotfiles, and the folders that are not the
   site (desktop/, node_modules/, tools/ output is harmless but .git is not). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.stl': 'model/stl', '.3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.b64': 'text/plain; charset=utf-8', '.gcode': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};
const DENY_TOP = ['desktop', 'node_modules'];

function resolveInside(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch (e) { return null; }
  if (rel.indexOf('\0') >= 0) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p[0] === '.')) return null;
  if (DENY_TOP.indexOf(parts[0]) >= 0) return null;
  const full = path.join(root, ...parts);
  const back = path.relative(root, full);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  return full;
}

/** Start serving `root`. Resolves { url, port, close }. */
function start(root, opts) {
  opts = opts || {};
  root = path.resolve(root);
  const host = opts.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const port = server.address().port;
      const allowed = ['127.0.0.1:' + port, 'localhost:' + port];
      // A page on another site must not reach this server by pointing a name at 127.0.0.1.
      if (allowed.indexOf(String(req.headers.host || '')) < 0) { res.writeHead(403); return res.end('Forbidden'); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
      const file = resolveInside(root, req.url || '/');
      if (!file) { res.writeHead(404); return res.end('Not found'); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(opts.port || 0, host, () => {
      const port = server.address().port;
      resolve({ url: 'http://' + host + ':' + port, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
module.exports = { start, resolveInside };

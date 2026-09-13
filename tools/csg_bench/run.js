#!/usr/bin/env node
/* Drives tools/csg_bench/bench.html in real Chromium.
 *
 * The point of the exercise is that the page loads manifold from CLASSIC
 * <script> tags with no bundler, so the adapter under test is spliced out of
 * app-join.js verbatim rather than reimplemented here. Only NSO_CSG_URL is
 * rewritten, to point at the vendored copy instead of the CDN.
 *
 * Usage: node tools/csg_bench/run.js [--out DIR] [--url URL]
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(argOf('--out', path.join(REPO, 'out', 'csg')));
const CSG_URL = argOf('--url', '/vendor/manifold/manifold.js');

// ---- splice the real adapter out of app-join.js ---------------------------
function adapterSource() {
  const src = fs.readFileSync(path.join(REPO, 'app-join.js'), 'utf8').split('\n');
  const start = src.findIndex(l => /^var NSO_CSG_URL\s*=/.test(l));
  if (start < 0) throw new Error('NSO_CSG_URL not found in app-join.js');
  let end = -1;
  for (let i = start; i < src.length; i++) {
    if (/^\}\)\(\);\s*$/.test(src[i])) { end = i; break; }
  }
  if (end < 0) throw new Error('end of NSO_CSG IIFE not found');
  const body = src.slice(start, end + 1).join('\n');
  const patched = body.replace(/^var NSO_CSG_URL\s*=.*$/m,
    `var NSO_CSG_URL = ${JSON.stringify(CSG_URL)};`);
  return { text: patched, lines: [start + 1, end + 1] };
}

// ---- static server --------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
               '.stl': 'application/octet-stream', '.json': 'application/json' };

function serve(adapter) {
  return http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/adapter.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(adapter);
    }
    const rel = url === '/' ? '/tools/csg_bench/bench.html' : url;
    const file = path.join(REPO, rel);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---- binary STL writer ----------------------------------------------------
function writeStl(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('nso csg bench', 0);
  buf.writeUInt32LE(n, 80);
  let off = 84;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = soup[o], ay = soup[o+1], az = soup[o+2];
    const bx = soup[o+3], by = soup[o+4], bz = soup[o+5];
    const cx = soup[o+6], cy = soup[o+7], cz = soup[o+8];
    // recompute the facet normal rather than trusting a stored one
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx/=len; ny/=len; nz/=len;
    for (const f of [nx,ny,nz,ax,ay,az,bx,by,bz,cx,cy,cz]) { buf.writeFloatLE(f, off); off += 4; }
    buf.writeUInt16LE(0, off); off += 2;
  }
  fs.writeFileSync(file, buf);
  return n;
}

(async () => {
  const { chromium } = require(path.join(
    process.env.BENCH_NODE_MODULES || path.join(__dirname, 'node_modules'), 'playwright'));

  const plan = JSON.parse(fs.readFileSync(argOf('--plan', path.join(__dirname, 'plan.json')), 'utf8'));
  const ad = adapterSource();
  console.log(`[run] adapter spliced from app-join.js lines ${ad.lines[0]}-${ad.lines[1]} (${ad.text.length} bytes)`);
  console.log(`[run] NSO_CSG_URL -> ${CSG_URL}`);

  fs.mkdirSync(OUT, { recursive: true });
  const server = serve(ad.text);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: process.env.BENCH_CHROMIUM || undefined,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => consoleLines.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  const report = await page.evaluate(p => window.NSO_BENCH(p), plan);

  for (const c of report.cases) {
    if (c.soup && c.soup.length) {
      const file = path.join(OUT, `${c.name}.stl`);
      writeStl(file, c.soup);
      c.stlPath = path.relative(REPO, file);
    }
    delete c.soup;
  }
  report.consoleLines = consoleLines;
  report.adapterLines = ad.lines;
  report.csgUrl = CSG_URL;

  const jf = path.join(OUT, 'report.json');
  fs.writeFileSync(jf, JSON.stringify(report, null, 2));
  console.log(`[run] wrote ${path.relative(REPO, jf)}`);
  console.log(JSON.stringify({ load: report.load, console: consoleLines }, null, 2));

  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });

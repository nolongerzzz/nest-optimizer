/* Headless harness that drives the REAL app (index.html + every app-*.js)
   in Chromium. The three CDN script tags are served from the local
   three@0.147.0 install because the sandbox has no outbound CDN access;
   nothing else about the page is altered.

   Usage:  node tools/nso_app_harness.js            (self-check)
   Import: const { withApp } = require('./nso_app_harness');            */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/* The sandbox ships a pinned Chromium that may not match this playwright
   build's expected revision, so prefer whatever is actually on disk. */
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (e) { return undefined; }
  for (const d of dirs.filter(x => /^chromium-/.test(x)).sort().reverse()) {
    const c = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

const ROOT = path.resolve(__dirname, '..');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const CDN_MAP = {
  'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js':
    path.join(THREE_DIR, 'build', 'three.min.js'),
  'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js':
    path.join(THREE_DIR, 'examples', 'js', 'controls', 'OrbitControls.js'),
  'https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/loaders/STLLoader.js':
    path.join(THREE_DIR, 'examples', 'js', 'loaders', 'STLLoader.js')
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.stl': 'application/octet-stream', '.json': 'application/json',
  '.wasm': 'application/wasm', '.md': 'text/plain'
};

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* Boots the app, hands `page` to fn, always tears down. */
async function withApp(fn, opts) {
  opts = opts || {};
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

  for (const url of Object.keys(CDN_MAP)) {
    await page.route(url, r =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CDN_MAP[url], 'utf8') }));
  }

  try {
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
    // the app is up once its own state object exists and the scene is built
    await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true,
      null, { timeout: 30000 });
    return await fn(page, logs);
  } finally {
    await browser.close();
    srv.close();
  }
}

/* Loads an STL through the app's real file input and returns its model id. */
async function loadSTL(page, stlPath) {
  const before = await page.evaluate(() => state.models.length);
  await page.setInputFiles('#file-input', stlPath);
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
  return await page.evaluate(() => state.models[state.models.length - 1].id);
}

/* Selects a piece the way a click would, so getActiveModel() sees it. */
async function selectModel(page, id) {
  await page.evaluate(i => { state.editId = i; }, id);
}

const statusOf = page => page.evaluate(() => {
  const el = document.getElementById('status');
  return el ? el.textContent : null;
});

module.exports = { withApp, loadSTL, selectModel, statusOf, ROOT };

if (require.main === module) {
  withApp(async (page, logs) => {
    const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await selectModel(page, id);
    const info = await page.evaluate(() => {
      const m = getActiveModel();
      return {
        name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : null, rawAxis: m.rawAxis,
        modules: {
          NSO_Repair: typeof window.NSO_Repair,
          NSO_findSharedFace: typeof NSO_findSharedFace,
          NSO_smoothSelectedModel: typeof NSO_smoothSelectedModel
        }
      };
    });
    console.log('harness ok:', JSON.stringify(info, null, 2));
    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    if (errs.length) { console.log('page errors:\n' + errs.join('\n')); process.exit(1); }
  }).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
}

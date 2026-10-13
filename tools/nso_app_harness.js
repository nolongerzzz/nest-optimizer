/* Headless harness that drives the REAL app (index.html + every app-*.js)
   in Chromium. The three CDN script tags are served from the local
   three@0.147.0 install because the sandbox has no outbound CDN access;
   nothing else about the page is altered.

   Usage:  node tools/nso_app_harness.js            (self-check)
   Import: const { withApp } = require('./nso_app_harness');
   APP_URL=https://nolongerzzz.github.io/nest-wip/  drives that deployment
   instead of the local tree (the three.js CDN tags are still served
   locally, so the check stays hermetic).                                  */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const LIB = require('./nso_library_dir');

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

/* The sidebar is gone (UI shell): every control lives in a drop-down, and a
   shut <details> hides its contents from page.click. A drive check asserts
   what a control DOES, not which drop-down it sits in, so before every
   Playwright action on a selector the harness opens the drop-downs that hold
   it, the way a user would - the same walk as openMenuFor below.

   Two things are left alone. The menu whose OWN summary is the target is
   not pre-opened, so a click on a summary still toggles that menu exactly
   as before. And a selector querySelector cannot read (Playwright's text=
   and >> forms) passes straight through. */
const AUTO_OPEN_ACTIONS = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'setChecked',
                           'selectOption', 'hover', 'tap', 'type', 'press', 'focus'];
function openDropdownsHolding(sel) {          // runs in the page
  let el = null;
  try { el = document.querySelector(sel); } catch (e) { return; }
  if (!el) return;
  const ownSummary = el.closest('summary');
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (n.tagName !== 'DETAILS' || n.open) continue;
    if (ownSummary && ownSummary.parentElement === n) continue;
    n.open = true;
  }
}
function installAutoOpen(page) {
  for (const name of AUTO_OPEN_ACTIONS) {
    const act = page[name].bind(page);
    page[name] = async function (selector, ...rest) {
      if (typeof selector === 'string') {
        try { await page.evaluate(openDropdownsHolding, selector); } catch (e) { /* page busy: act as before */ }
      }
      return act(selector, ...rest);
    };
  }
}

/* Boots the app, hands `page` to fn, always tears down. */
async function withApp(fn, opts) {
  opts = opts || {};
  const srv = await serve();
  const port = srv.address().port;
  const live = !!(opts.liveLibrary || process.env.NSO_LIBRARY_LIVE === '1');
  /* A live run is the one run whose page really goes out to the network, so
     it is the one that must honour an egress proxy when the box has one.
     Every other run is answered locally and gets no proxy at all. And https
     ONLY: the app itself is served over plain http from 127.0.0.1, which
     Playwright's own proxy option would send through the proxy too. */
  const proxyUrl = live && (process.env.HTTPS_PROXY || process.env.https_proxy);
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
      .concat(proxyUrl ? ['--proxy-server=https=' + proxyUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')] : [])
  });
  /* 900 tall, not Playwright's 720. Below about 830 px the shell's left
     column sits on top of the bottom-left tools (Undo, Frame, X-ray,
     G-scope, Watch) - a known collision, flagged and not yet fixed, and
     measured where it starts by tools/nso_ui_shell_drive_check.js. A check
     that clicks Undo is asserting what Undo does, so it gets a window tall
     enough to reach it. Checks that set their own size are unaffected. */
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  installAutoOpen(page);
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

  for (const url of Object.keys(CDN_MAP)) {
    await page.route(url, r =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(CDN_MAP[url], 'utf8') }));
  }

  // The CSG kernel is fetched from a CDN the sandbox cannot reach. A copy is
  // vendored in the repo, so point the loader at it; this makes Join's kernel
  // route reachable here, which the fallback assertions depend on.
  await page.route('https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.js', r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                body: fs.readFileSync(path.join(ROOT, 'vendor', 'manifold', 'manifold.js'), 'utf8') }));
  await page.route('https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.wasm', r =>
    r.fulfill({ status: 200, contentType: 'application/wasm',
                body: fs.readFileSync(path.join(ROOT, 'vendor', 'manifold', 'manifold.wasm')) }));

  /* The Library catalog's rows fetch from nest-library on
     raw.githubusercontent.com. Answered here from disk, like the CDN above:
     the nest-library checkout when there is one, else this repo's library/
     copy for the fixtures kept here (nso_library_dir.catalogFile), else a
     404 - which the page reports as "Library load failed", exactly as it
     would a file missing from the live repo. Every request is recorded on
     page.__libraryServed so a check can prove where its bytes came from.

     opts.liveLibrary (or NSO_LIBRARY_LIVE=1) leaves these requests alone and
     lets them go to the real repository - tools/nso_library_live_check.js. */
  page.__libraryServed = [];
  if (!live) {
    await page.route(LIB.RAW_BASE + '**', r => {
      const name = decodeURIComponent(r.request().url().slice(LIB.RAW_BASE.length).split('?')[0]);
      const file = /^[^/\\]+$/.test(name) ? LIB.catalogFile(name) : null;
      page.__libraryServed.push({ name, file });
      if (!file) return r.fulfill({ status: 404, contentType: 'text/plain', body: '404: Not Found' });
      return r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8',
                         headers: { 'access-control-allow-origin': '*' },
                         body: fs.readFileSync(file) });
    });
  }

  // APP_URL (or opts.url) points the same drive at a deployed copy, e.g. the
  // wip preview site, instead of the local tree. CDN routes still apply.
  const url = opts.url || process.env.APP_URL || ('http://127.0.0.1:' + port + '/index.html');
  try {
    await page.goto(url, { waitUntil: 'load' });
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

/* Opens the viewport's Finish menu (a <details>) by clicking its summary, the
   way a user does, so the controls inside it - Paint, Skin face, Cap open
   faces, Soften... - are visible to page.click. Idempotent.

   The menu's rows live in six collapsible groups, all but Shape shut when the
   page loads, so opening the menu alone no longer makes every control
   clickable. Every group is opened here too: a drive check is asserting what
   a control DOES, not which fold the user found it in, and a check that had
   to name its group would have to be edited again the next time a row moves
   between them. Clicking a control the user would first have to unfold is the
   one thing this hides, and no check in the suite is making that claim. */
async function openFinishMenu(page) {
  const open = await page.evaluate(() => { const d = document.querySelector('.vp-finish-menu'); return !!(d && d.open); });
  if (!open) await page.click('.vp-finish-menu > summary');
  await page.waitForFunction(() => { const d = document.querySelector('.vp-finish-menu'); return !!(d && d.open); }, null, { timeout: 5000 });
  await openFinishSections(page);
}

/* Unfolds every group inside the Finish menu. Separate from the above so a
   check that opens the menu its own way can still reach the rows. */
async function openFinishSections(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.vp-finish-menu .vp-sec')].every(d => d.open),
    null, { timeout: 5000 });
}

/* Opens whatever menus a control is buried in: walks up from the element and
   opens every <details> on the way, which is the idiom the wire checks already
   use for the Finish menu.

   Needed because every control lives in a drop-down - the top row, the left
   column, Finish - and a <details> that is shut hides its contents from
   page.click. (Actions through `page` now do this walk themselves, see
   installAutoOpen; this stays for checks that need the panel open first.)

   One menu at a time, not all of them: app-join makes .vp-menu an exclusive
   accordion, so opening every menu would leave exactly one open anyway, and
   an open panel hangs over the top of the viewport where the paint, brush and
   measure checks click. Ask for the control you are about to use. */
async function openMenuFor(page, selector) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('openMenuFor: no ' + sel);
    for (let n = el; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  }, selector);
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, selector, { timeout: 5000 });
}

/* Shuts the bar's menus again, for a check that needs the canvas clear. */
async function closeTopMenus(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; });
  });
}

module.exports = { withApp, loadSTL, selectModel, statusOf, openFinishMenu, openFinishSections,
                   openMenuFor, closeTopMenus, ROOT };

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

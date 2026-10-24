#!/usr/bin/env node
/* perf-bisect: which merges made the app slower, by how much, on which operations, and what grows
   as a session goes on. MEASURES ONLY. It changes no product file and has no pass/fail; it is not in the
   test chain (npm run perf:bisect).

     node tools/perf-bisect.mjs --plan                       print the pass-1 commit list and stop
     node tools/perf-bisect.mjs --pass1                      measure the pass-1 commits (resumes: a commit already in the out dir is skipped)
     node tools/perf-bisect.mjs --pass2                      bisect every probe that moved between neighbouring pass-1 commits
     node tools/perf-bisect.mjs --selfcheck                  bba1993 and 1b45aec twice each; every probe must repeat within 10 %
     node tools/perf-bisect.mjs --commits bba1993,1b45aec    measure these (any rev git understands)
     node tools/perf-bisect.mjs --bisect GOOD BAD --metric drag.vase.moveMs
     node tools/perf-bisect.mjs --report                     rebuild perf-bisect.md from what is in the out dir

   OPTIONS
     --probes load,click,drag,lift,idle,orbit,leaks   which probes (default: all; load always runs, it is the set-up)
     --runs 5          timing runs per probe (median is the figure, worst is kept)
     --cycles 10       leak cycles per cycle kind
     --vase FILE       a vase to use instead of tools/fixtures-local/boolean-vase.3mf / the stand-in
     --out DIR         default tools/perf-bisect-out (git-ignored)
     --scratch DIR     where the worktrees go (default: the OS temp dir)
     --head REV        the newer end (default 1b45aec);  --base REV the older end (default bba1993)
     --force           measure again even if the out dir already has it
     --bake seal|solidify   which bake the bake+Undo leak cycle uses (default seal)

   HOW. Each commit's tree is checked out into a scratch git worktree, served from 127.0.0.1, and driven in headless
   Chromium (software GL, --enable-precise-memory-info). The probe code lives in this file and is the same for every
   commit: it reaches the app only through globals that exist at bba1993 (state, THREE, applyPlacedXZ, the render loop,
   #file-input) and ids that exist there, plus real mouse events for every press, drag and orbit. Where a commit has
   no such thing to drive (Lift is a verb on the selected piece only from #221 on), the probe says n/a and why; a
   number is never guessed.

   APP JS vs FRAME. "app JS" is Chromium's own ScriptDuration for the page (CDP Performance.getMetrics) over the
   window, or the listener bracket for an event; "to next frame" is wall clock to the second requestAnimationFrame
   after. Headless Chromium draws with SOFTWARE GL, where a frame costs ~0.4 s per million triangles of main-thread
   "(program)" time however little JS runs. That inflates every frame figure here and the idle fps; it is the
   machine, not the app. Compare commits on the same machine, and read the app-JS columns for the app's own cost. */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const BM = require(path.join(HERE, 'nso_big_mesh_lib.js'));

// ----------------------------------------------------------------------------------------------- command line
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BASE = opt('base', 'bba1993'), HEAD = opt('head', '1b45aec');
const RUNS = +opt('runs', 5), CYCLES = +opt('cycles', 10);
const OUT = path.resolve(opt('out', path.join(HERE, 'perf-bisect-out')));
const SCRATCH = path.resolve(opt('scratch', path.join(os.tmpdir(), 'perf-bisect-wt')));
const FORCE = flag('force');
const BAKE = opt('bake', 'seal');
const ALL_PROBES = ['load', 'click', 'drag', 'lift', 'idle', 'orbit', 'leaks'];
const PROBES = opt('probes', ALL_PROBES.join(',')).split(',').filter(Boolean);
const PASS1_PRS = [189, 190, 220, 232];
const VASE_CYCLE_WAIT_MS = 600000;

// ----------------------------------------------------------------------------------------------- small helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sorted = a => a.slice().sort((x, y) => x - y);
const med = a => { const s = sorted(a); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const p95 = a => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : NaN; };
const fx = (x, d) => (x == null || !Number.isFinite(x) ? 'n/a' : (+x).toFixed(d == null ? 1 : d));
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ----------------------------------------------------------------------------------------------- commits
function chain() {
  const rows = git('log', '--first-parent', '--reverse', '--format=%H%x09%P%x09%s', BASE + '^..' + HEAD).split('\n').filter(Boolean);
  return rows.map((l, i) => {
    const [sha, parents, subject] = l.split('\t');
    return { sha, short: sha.slice(0, 7), pos: i, parents: parents.split(' ').filter(Boolean), merge: parents.split(' ').filter(Boolean).length > 1, subject,
             prs: (subject.match(/#(\d+)/g) || []).map(s => +s.slice(1)) };
  });
}
const label = c => c.short + (c.merge && c.prs.length ? ' (PR ' + c.prs.map(n => '#' + n).join(' + ') + ')' : '');

function pass1Plan(ch) {
  const pick = new Map();
  const add = (c, why) => { if (c && !pick.has(c.sha)) pick.set(c.sha, { c, why: [] }); if (c) pick.get(c.sha).why.push(why); };
  add(ch[0], 'base'); add(ch[ch.length - 1], 'head');
  const merges = ch.filter(c => c.merge);
  merges.forEach((c, i) => { if ((i + 1) % 10 === 0) add(c, 'merge #' + (i + 1)); });
  PASS1_PRS.forEach(n => {
    const m = ch.find(c => c.merge && new RegExp('\\bPRs? #' + n + '\\b').test(c.subject));
    if (!m) { log('pass-1: no first-parent merge names #' + n); return; }
    add(ch.find(c => c.sha === m.parents[0]) || { sha: m.parents[0], short: m.parents[0].slice(0, 7), parents: [], merge: false, subject: '(first parent of #' + n + ')', prs: [], pos: m.pos - 1 }, 'before #' + n);
    add(m, 'after #' + n);
  });
  return [...pick.values()].map(x => Object.assign({ why: x.why }, x.c)).sort((a, b) => a.pos - b.pos);
}

function resolve(rev, ch) {
  const sha = git('rev-parse', '--verify', rev + '^{commit}');
  return ch.find(c => c.sha === sha) || (() => { throw new Error(rev + ' is not on the first-parent chain ' + BASE + '..' + HEAD); })();
}

// ----------------------------------------------------------------------------------------------- the pieces
const BOX = path.join(ROOT, 'library', 'box_closed.stl');
function vaseFile() {
  const given = opt('vase', null);
  const real = path.join(HERE, 'fixtures-local', 'boolean-vase.3mf');
  if (given) return { file: path.resolve(given), label: 'vase', real: true };
  if (fs.existsSync(real)) return { file: real, label: 'vase', real: true };
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, 'vase-standin.stl');
  if (!fs.existsSync(f) || fs.statSync(f).size !== 84 + 50 * 1000000) BM.writeSphereSTL(f, 1000, 501, 30, true);
  return { file: f, label: 'vase (stand-in: 1,000,000-triangle sphere)', real: false };
}

// ----------------------------------------------------------------------------------------------- the page-side scripts
/* Runs before the app on every page: counts live intervals and document / window listeners. Wrapping only observes.
   A listener is "live" from addEventListener to the matching removeEventListener (same type, function, capture flag);
   a once:true listener is counted apart (it removes itself when it fires, which cannot be seen from here), and a
   listener with an AbortSignal leaves the count when the signal aborts. */
function initScript() {
  if (window !== window.top) return;
  const P = window.__perf = { intervals: new Set(), listeners: { document: new Map(), window: new Map() }, once: 0, setCalls: 0, clearCalls: 0, raf: 0 };
  const si = window.setInterval, ci = window.clearInterval, ct = window.clearTimeout;
  window.setInterval = function (fn, ms) { const id = si.apply(this, arguments); P.intervals.add(id); P.setCalls++; return id; };
  window.clearInterval = function (id) { P.intervals.delete(id); P.clearCalls++; return ci.apply(this, arguments); };
  window.clearTimeout = function (id) { P.intervals.delete(id); return ct.apply(this, arguments); };
  const ae = EventTarget.prototype.addEventListener, re = EventTarget.prototype.removeEventListener;
  const which = t => (t === document ? 'document' : t === window ? 'window' : null);
  const capOf = o => (typeof o === 'boolean' ? o : !!(o && o.capture));
  const bucket = (w, type, o) => { const k = type + (capOf(o) ? '/c' : '/b'); let s = P.listeners[w].get(k); if (!s) P.listeners[w].set(k, s = new Set()); return s; };
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    const w = which(this);
    if (w && fn) {
      if (o && typeof o === 'object' && o.once) P.once++;
      else {
        const s = bucket(w, type, o); s.add(fn);
        if (o && typeof o === 'object' && o.signal) o.signal.addEventListener('abort', () => s.delete(fn), { once: true });
      }
    }
    return ae.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    const w = which(this);
    if (w && fn) bucket(w, type, o).delete(fn);
    return re.apply(this, arguments);
  };
  const size = m => { let n = 0; m.forEach(s => { n += s.size; }); return n; };
  P.counts = () => ({ intervals: P.intervals.size, docListeners: size(P.listeners.document), winListeners: size(P.listeners.window), onceListeners: P.once });
}

/* Installed once the app is up. Everything the probes need inside the page. */
function kit() {
  const K = window.__pk = {};
  K.raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));
  K.fcOn = false; K.fc = 0;
  K.fcStart = () => { K.fc = 0; K.fcOn = true; (function t() { if (!K.fcOn) return; K.fc++; requestAnimationFrame(t); })(); };
  K.fcStop = () => { K.fcOn = false; return K.fc; };
  K.placedOf = id => state.placed.find(q => q && q.sourceId === id);
  /* Where a press lands on a piece. First choice is the piece's top, projected (what nso_move_flat_bench.js presses); if a
     ray through that point does not hit the piece first (a vase's top is its opening), the nearest point of a grid over
     the piece's screen box that does. `a` is the press, `e` the same point carried 40 mm toward the front of the plate. */
  K.top = id => {
    const p = K.placedOf(id); p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    const r = state.renderer.domElement.getBoundingClientRect();
    const toScreen = v => { const q = v.clone().project(state.camera); return { x: r.left + (q.x * 0.5 + 0.5) * r.width, y: r.top + (-q.y * 0.5 + 0.5) * r.height }; };
    const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const ownerOf = o => { while (o && (!o.userData || o.userData.placedIndex == null) && o.parent) o = o.parent; return o && o.userData && o.userData.placedIndex != null ? state.placed[o.userData.placedIndex] : null; };
    const hitAt = pt => {
      ndc.set(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(ndc, state.camera);
      const hs = rc.intersectObjects(state.modelGroup.children, true);
      for (let i = 0; i < hs.length; i++) if (hs[i].faceIndex != null) return ownerOf(hs[i].object) === p ? hs[i].point.clone() : null;
      return null;
    };
    const first = toScreen(new THREE.Vector3(c.x, b.max.y, c.z));
    const cands = [first];
    const xs = [], ys = [];
    for (let i = 0; i < 8; i++) { const q = toScreen(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)); xs.push(q.x); ys.push(q.y); }
    const x0 = Math.max(r.left + 2, Math.min.apply(null, xs)), x1 = Math.min(r.right - 2, Math.max.apply(null, xs)), y0 = Math.max(r.top + 2, Math.min.apply(null, ys)), y1 = Math.min(r.bottom - 2, Math.max.apply(null, ys)), N = 11;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) cands.push({ x: x0 + (x1 - x0) * (i + 0.5) / N, y: y0 + (y1 - y0) * (j + 0.5) / N });
    const rest = cands.slice(1).sort((u, v) => Math.hypot(u.x - first.x, u.y - first.y) - Math.hypot(v.x - first.x, v.y - first.y));
    let a = null, P = null;
    const onCanvas = pt => pt.x > r.left && pt.x < r.right && pt.y > r.top && pt.y < r.bottom && document.elementFromPoint(pt.x, pt.y) === state.renderer.domElement;   // not under the top row or a card
    for (const pt of [first].concat(rest).filter(onCanvas)) { P = hitAt(pt); if (P) { a = pt; break; } }
    if (!a) return { a: first, e: first, x0: p.x, z0: p.z, undo: state.undoStack.length, missed: true };
    return { a, e: toScreen(P.clone().add(new THREE.Vector3(0, 0, 40))), x0: p.x, z0: p.z, undo: state.undoStack.length };
  };
  K.plateSpot = (x, z) => {
    const r = state.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(x, 0, z).project(state.camera);
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  };
  /* The camera stands at (0, 190, 150) x k, looking at the plate's centre. k is 1 for anything up to 100 mm across (the
     stand-in is 60) and grows with the piece, so a 180 mm vase is in frame and not above the camera. */
  K.k = 1;
  K.fit = id => { const b = new THREE.Box3().setFromObject(K.placedOf(id).mesh), d = b.getSize(new THREE.Vector3()); K.k = Math.max(1, Math.max(d.x, d.y, d.z) / 100); return K.k; };
  K.view = () => {
    state.controls.target.set(0, 0, 0); state.camera.position.set(0, 190 * K.k, 150 * K.k); state.camera.lookAt(0, 0, 0);
    state.controls.update(); state.camera.updateMatrixWorld(true);
  };
  K.setXZ = (id, x, z) => { const p = K.placedOf(id); applyPlacedXZ(p, x, z); p.mesh.updateMatrixWorld(true); };
  K.closeMenus = () => document.querySelectorAll('details[open]').forEach(d => { d.open = false; });
  K.openAround = sel => {
    const el = document.querySelector(sel); if (!el) return false;
    const own = el.closest('summary');
    for (let n = el.parentElement; n; n = n.parentElement) { if (n.tagName !== 'DETAILS' || n.open) continue; if (own && own.parentElement === n) continue; n.open = true; }
    return true;
  };
  K.sample = () => {
    const r = state.renderer, info = r.info; let objs = 0; state.scene.traverse(() => { objs++; });
    return Object.assign({
      geometries: info.memory.geometries, textures: info.memory.textures, calls: info.render.calls, triangles: info.render.triangles,
      objects: objs, undo: state.undoStack.length, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null
    }, window.__perf ? window.__perf.counts() : {});
  };
  /* Event brackets. A capture listener on window stamps when an event starts and, for a click or a button press, starts
     the clock there: the app stops pointerdown / click from bubbling when it takes a press, so nothing in the bubble
     phase can be relied on. For a drag, a bubble listener added after the app's reads when its handlers returned (the
     way tools/nso_move_flat_bench.js does), which is the app's own JS for that event. */
  const stamp = {};
  K.cur = null;
  ['pointerdown', 'pointermove', 'pointerup', 'click'].forEach(ty => {
    window.addEventListener(ty, () => {
      stamp[ty] = performance.now();
      const c = K.cur; if (!c) return;
      if (c.kind === 'click') {
        if (ty === 'pointerdown' && c.t0 == null) c.t0 = stamp[ty];
        if (ty === 'click' && c.frame == null) K.raf2().then(t => { c.frame = t - c.t0; });
      } else if (c.kind === 'btn') {
        if (ty === 'click' && c.t0 == null) c.t0 = stamp[ty];
      }
    }, true);
    window.addEventListener(ty, () => {
      const c = K.cur; if (!c || c.kind !== 'drag') return;
      const dt = performance.now() - stamp[ty];
      if (ty === 'pointermove') c.move.push(dt);
      else if (ty === 'pointerup') { c.up = dt; const t0 = stamp[ty]; requestAnimationFrame(() => requestAnimationFrame(() => { c.upFrame = performance.now() - t0; })); }
    }, false);
  });
}

/* Watches a file load: from the input's change event to the new piece (every new model has a mesh on the plate,
   unchanged for 300 ms) and to the second animation frame after that. Polls on a short timer chain. */
function loadWatch(n0) {
  const K = window.__pk, ld = K.ld = { t0: null, cand: null, count: -1, candFrame: null, done: null, frame: null, ids: [] };
  const inp = document.getElementById('file-input');
  const onChange = () => { if (ld.t0 == null) ld.t0 = performance.now(); inp.removeEventListener('change', onChange, true); };
  inp.addEventListener('change', onChange, true);
  (function poll() {
    if (ld.frame != null) return;
    const now = performance.now(), fresh = state.models.slice(n0);
    const ok = ld.t0 != null && fresh.length > 0 && fresh.every(m => state.placed.some(p => p && p.sourceId === m.id && p.mesh && p.mesh.parent));
    if (ok && (ld.cand == null || fresh.length !== ld.count)) {
      const mine = ld.cand = now; ld.count = fresh.length; ld.ids = fresh.map(m => m.id); ld.candFrame = null;
      K.raf2().then(t => { if (ld.cand === mine) ld.candFrame = t; });
    } else if (!ok) { ld.cand = null; ld.candFrame = null; }
    if (ld.cand != null && ld.candFrame != null && now - ld.cand > 300) { ld.done = ld.cand; ld.frame = ld.candFrame; return; }
    setTimeout(poll, 0);
  })();
}

/* Watches a button's readout until it says something other than `idle`. */
function readyWatch(args) {
  const K = window.__pk, w = K.rw = { t0: null, ready: null, frame: null, text: null };
  const sel = args.sel, idle = args.idle;
  (function poll() {
    if (w.frame != null) return;
    const el = document.querySelector(sel), t = el ? el.textContent.trim() : null;
    if (K.cur && K.cur.t0 != null && t != null && t !== idle) { w.t0 = K.cur.t0; w.ready = performance.now(); w.text = t; K.raf2().then(x => { w.frame = x; }); return; }
    setTimeout(poll, 0);
  })();
}

// ----------------------------------------------------------------------------------------------- browser, server, worktree
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = []; try { dirs = fs.readdirSync(base); } catch (e) { return undefined; }
  for (const d of dirs.filter(x => /^chromium-\d/.test(x)).sort().reverse())
    for (const sub of ['chrome-linux64', 'chrome-linux']) { const c = path.join(base, d, sub, 'chrome'); if (fs.existsSync(c)) return c; }
  return undefined;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.stl': 'application/octet-stream', '.json': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve(root) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function checkout(sha) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = path.join(SCRATCH, sha.slice(0, 10));
  if (fs.existsSync(dir)) { try { git('worktree', 'remove', '--force', dir); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); } }
  git('worktree', 'prune');
  git('worktree', 'add', '--detach', '--force', dir, sha);
  return dir;
}
function release(dir) { try { git('worktree', 'remove', '--force', dir); } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); try { git('worktree', 'prune'); } catch (e2) { /* nothing */ } } }

/* The sandbox has no CDN: three comes from node_modules, the CSG kernel from the commit's own vendor/, the Library
   catalog (raw.githubusercontent.com) is answered 404. Anything else off-box is refused and counted. */
async function openContext(browser, root, port) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blocked = [];
  const T = path.join(ROOT, 'node_modules', 'three');
  await ctx.route(u => !/^http:\/\/127\.0\.0\.1[:/]/.test(u.toString()) && !/^(data|blob):/.test(u.toString()), r => {
    const u = r.request().url();
    let m = u.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.147\.0\/(.*)$/);
    if (m && fs.existsSync(path.join(T, m[1]))) return r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(T, m[1])) });
    m = u.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/manifold-3d@[\d.]+\/(manifold\.(?:js|wasm))$/);
    if (m && fs.existsSync(path.join(root, 'vendor', 'manifold', m[1])))
      return r.fulfill({ status: 200, contentType: m[1].endsWith('wasm') ? 'application/wasm' : 'text/javascript', body: fs.readFileSync(path.join(root, 'vendor', 'manifold', m[1])) });
    if (/^https:\/\/raw\.githubusercontent\.com\//.test(u)) return r.fulfill({ status: 404, contentType: 'text/plain', body: '404: Not Found' });
    blocked.push(u); return r.abort();
  });
  await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 60000 });
  await page.evaluate(kit);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  return { ctx, page, cdp, blocked, errors };
}

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics'), o = {};
  metrics.forEach(m => { o[m.name] = m.value; });
  return o;
}
const dMs = (a, b, k) => (b[k] - a[k]) * 1000;
async function gc(cdp) { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); }
const frames = (page, n) => page.evaluate(n => new Promise(r => { let i = 0; (function t() { if (++i >= n) r(); else requestAnimationFrame(t); })(); }), n);

/* A real click on a control: its drop-downs opened first (the way a user would), then the mouse. The click returns
   only once the page has taken the events, so a control that bakes for 100 s needs a timeout longer than that. */
async function uiClick(page, sel, timeout) {
  const found = await page.evaluate(s => window.__pk.openAround(s), sel);
  if (!found) throw new Error('no ' + sel);
  await page.click(sel, { timeout: timeout || 60000 });
}

/* A real press on a control with the clock read right before the mouse goes down: the drop-downs holding it opened,
   it is scrolled into view and the page left to settle first, so nothing but the press itself is inside the window. */
async function pressButton(page, sel, before) {
  if (!(await page.evaluate(s => window.__pk.openAround(s), sel))) throw new Error('no ' + sel);
  await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
  await quiet(page);
  const r = await page.evaluate(s => { const el = document.querySelector(s), b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, disabled: !!el.disabled }; }, sel);
  if (r.disabled) throw new Error(sel + ' is disabled');
  await page.mouse.move(r.x, r.y);
  if (before) await before();
  await page.mouse.down(); await page.mouse.up();
}

/* Waits until the page is calm: three runs of two frames in a row that each take under 3 s (a software-GL frame of
   the 1M-triangle piece is ~0.5 s), so whatever a press set going has finished before the next step starts. */
async function quiet(page, tries) {
  let calm = 0;
  for (let i = 0; i < (tries || 120) && calm < 3; i++) {
    const t = Date.now(); await frames(page, 2);
    calm = Date.now() - t < 3000 ? calm + 1 : 0;
  }
  return calm >= 3;
}

// ----------------------------------------------------------------------------------------------- the timing probes (one app lifecycle per run)
const NA = (probe, reason) => ({ na: probe, reason });

async function loadOne(S, file, what) {
  const { page, cdp } = S;
  const n0 = await page.evaluate(() => state.models.length);
  await page.evaluate(loadWatch, n0);
  const m0 = await cdpMetrics(cdp);
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => window.__pk.ld.frame != null, null, { timeout: 900000, polling: 100 });
  const m1 = await cdpMetrics(cdp), ld = await page.evaluate(() => window.__pk.ld);
  const id = await page.evaluate(n => state.models.slice(n).sort((a, b) => (b.rawTris ? b.rawTris.length : 0) - (a.rawTris ? a.rawTris.length : 0))[0].id, n0);
  const tris = await page.evaluate(id => { const m = state.models.find(x => x.id === id); return m && m.rawTris ? m.rawTris.length / 9 : null; }, id);
  return { id, tris, ms: ld.done - ld.t0, frameMs: ld.frame - ld.t0, jsMs: dMs(m0, m1, 'ScriptDuration'), mainMs: dMs(m0, m1, 'TaskDuration') };
}

async function arrange(S, ids) {
  await S.page.evaluate(([v, b]) => { window.__pk.setXZ(v, -50, -20); window.__pk.setXZ(b, 50, -20); window.__pk.fit(v); window.__pk.view(); }, ids);
  await sleep(2500);
}

async function selectedIs(page, id) {
  return page.evaluate(id => { const p = state.placed[state.selectedIndex]; return !!p && p.sourceId === id; }, id);
}

async function idleProbe(S) {
  const { page, cdp } = S;
  await page.evaluate(() => window.__pk.fcStart());
  const m0 = await cdpMetrics(cdp);
  await sleep(5000);
  const m1 = await cdpMetrics(cdp), n = await page.evaluate(() => window.__pk.fcStop());
  if (!n) throw new Error('no frame in 5 s');
  return { jsMsPerFrame: dMs(m0, m1, 'ScriptDuration') / n, mainMsPerFrame: dMs(m0, m1, 'TaskDuration') / n,
           layoutMsPerFrame: (dMs(m0, m1, 'LayoutDuration') + dMs(m0, m1, 'RecalcStyleDuration')) / n, fps: n / 5, frames: n };
}

async function orbitProbe(S) {
  const { page, cdp } = S;
  const spot = await page.evaluate(() => window.__pk.plateSpot(0, 85));
  const cam0 = await page.evaluate(() => state.camera.position.toArray());
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.evaluate(() => window.__pk.fcStart());
  const m0 = await cdpMetrics(cdp), t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < 3000) {
    const ph = (Date.now() - t0) / 3000 * 2 * Math.PI;
    await page.mouse.move(spot.x + 160 * Math.sin(ph), spot.y + 40 * (1 - Math.cos(ph)));
    k++;
  }
  const el = Date.now() - t0, m1 = await cdpMetrics(cdp), n = await page.evaluate(() => window.__pk.fcStop());
  await page.mouse.up();
  const cam1 = await page.evaluate(() => state.camera.position.toArray());
  const moved = Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]);
  if (moved < 1) return NA('orbit', 'a left drag on bare plate did not move the camera (' + k + ' moves)');
  if (!n) throw new Error('no frame while orbiting');
  return { msPerFrame: el / n, jsMsPerFrame: dMs(m0, m1, 'ScriptDuration') / n, mainMsPerFrame: dMs(m0, m1, 'TaskDuration') / n, fps: n / (el / 1000), frames: n, moves: k, cameraMoved: moved };
}

async function clickProbe(S, vaseId) {
  const { page, cdp } = S;
  const pt = await page.evaluate(id => window.__pk.top(id), vaseId);
  // the pointer goes onto the vase first and the page is left to settle (a user hovers before pressing); the move is timed apart
  const h0 = await cdpMetrics(cdp);
  await page.mouse.move(pt.a.x, pt.a.y);
  await quiet(page);
  const h1 = await cdpMetrics(cdp);
  await page.evaluate(() => { window.__pk.cur = { kind: 'click', t0: null, frame: null }; });
  const m0 = await cdpMetrics(cdp);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => window.__pk.cur.frame != null, null, { timeout: 600000, polling: 50 });
  // ScriptDuration is read after the frame: it covers press, release, the click and the frame callbacks up to the frame
  const m1 = await cdpMetrics(cdp), c = await page.evaluate(() => window.__pk.cur);
  await page.evaluate(() => { window.__pk.cur = null; });
  if (!(await selectedIs(page, vaseId))) {
    const d = await page.evaluate(id => ({ sel: state.selectedIndex, ids: state.placed.map(p => p.sourceId), id }), vaseId);
    return NA('click', 'the press at (' + pt.a.x.toFixed(0) + ', ' + pt.a.y.toFixed(0) + ')' + (pt.missed ? ' (no ray hit the vase first)' : '') + ' did not select the vase (selectedIndex ' + d.sel + ', pieces ' + d.ids.join(',') + ', vase ' + d.id + ')');
  }
  return { frameMs: c.frame, jsMs: dMs(m0, m1, 'ScriptDuration'), mainMs: dMs(m0, m1, 'TaskDuration'), hoverJsMs: dMs(h0, h1, 'ScriptDuration') };
}

async function liftProbe(S, vaseId) {
  const { page, cdp } = S;
  const has = await page.evaluate(() => !!document.getElementById('btn-lift') && !!document.getElementById('lift-count'));
  if (!has) return NA('lift', 'no #btn-lift at this commit: Lift is not a verb on the selected piece here (it is G-scope\'s Pick / Strip mode, armed in a different panel); nothing comparable to arm');
  if (!(await selectedIs(page, vaseId))) return NA('lift', 'the vase was not selected');
  await page.evaluate(() => { window.__pk.cur = { kind: 'btn', t0: null }; });
  await page.evaluate(readyWatch, { sel: '#lift-count', idle: '—' });
  let m0;
  await pressButton(page, '#btn-lift', async () => { m0 = await cdpMetrics(cdp); });
  const ok = await page.waitForFunction(() => window.__pk.rw.frame != null, null, { timeout: 600000, polling: 100 }).then(() => true, () => false);
  const m1 = await cdpMetrics(cdp), w = await page.evaluate(() => window.__pk.rw);
  await page.evaluate(() => { window.__pk.cur = null; });
  const armed = await page.evaluate(() => document.getElementById('btn-lift').getAttribute('aria-pressed'));
  // put it back: disarm with the same button
  if (armed === 'true') { await uiClick(page, '#btn-lift', 60000).catch(() => {}); await quiet(page); }
  await page.evaluate(() => window.__pk.closeMenus());
  if (!ok) return NA('lift', 'Lift armed but its count never left "—" in 600 s (censored: more than 600000 ms)');
  return { armMs: w.ready - w.t0, frameMs: w.frame - w.t0, jsMs: dMs(m0, m1, 'ScriptDuration'), mainMs: dMs(m0, m1, 'TaskDuration'), readout: w.text };
}

async function dragProbe(S, id, label) {
  const { page } = S;
  const route = await page.evaluate(id => window.__pk.top(id), id);
  await page.evaluate(() => { window.__pk.cur = { kind: 'drag', move: [], up: NaN, upFrame: NaN }; });
  const MOVES = 40;
  await page.mouse.move(route.a.x, route.a.y);
  await page.mouse.down();
  await page.mouse.move(route.a.x + 1, route.a.y + 1);                 // inside the slop: nothing yet
  for (let k = 1; k <= MOVES; k++) await page.mouse.move(route.a.x + (route.e.x - route.a.x) * k / MOVES, route.a.y + (route.e.y - route.a.y) * k / MOVES);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForFunction(() => Number.isFinite(window.__pk.cur.upFrame), null, { timeout: 600000, polling: 100 });
  const t = await page.evaluate(() => { const c = window.__pk.cur; window.__pk.cur = null; return c; });
  const dz = await page.evaluate(([id, z0]) => window.__pk.placedOf(id).z - z0, [id, route.z0]);
  if (Math.abs(dz) < 5) return NA('drag', 'the piece did not follow the pointer (moved ' + dz.toFixed(2) + ' mm of 40) on the ' + label);
  return { moveMs: mean(t.move), moveMedMs: med(t.move), moveP95Ms: p95(t.move), moveMaxMs: Math.max.apply(null, t.move), moves: t.move.length, upMs: t.up, upFrameMs: t.upFrame };
}

/* One full lifecycle on a fresh page: set-up (load both pieces, timed), then the probes in a fixed order. */
async function timingRun(browser, root, port, vase, want) {
  const S = await openContext(browser, root, port);
  const out = { values: {}, na: {}, notes: {}, steps: {} };
  let tlast = Date.now();
  const lap = name => { out.steps[name] = Date.now() - tlast; tlast = Date.now(); };
  const put = (probe, key, r) => {
    if (r && r.na) { out.na[probe] = r.reason; return; }
    Object.keys(r).forEach(k => { if (typeof r[k] === 'number') out.values[key + '.' + k] = r[k]; else if (r[k] != null) out.notes[key + '.' + k] = r[k]; });
  };
  const guard = async (probe, fn) => { try { return await fn(); } catch (e) { out.na[probe] = 'error: ' + String(e && e.message || e).split('\n')[0]; return null; } };
  try {
    lap('boot');
    const box = await loadOne(S, BOX, 'box');
    put('load', 'load.box', { ms: box.ms, frameMs: box.frameMs, jsMs: box.jsMs, mainMs: box.mainMs });
    const v = await loadOne(S, vase.file, 'vase');
    put('load', 'load.vase', { ms: v.ms, frameMs: v.frameMs, jsMs: v.jsMs, mainMs: v.mainMs });
    out.notes.vaseTriangles = v.tris;
    lap('load'); await arrange(S, [v.id, box.id]); lap('arrange');
    if (want.has('idle')) put('idle', 'idle', await guard('idle', () => idleProbe(S)) || NA('idle', out.na.idle || 'failed'));
    if (want.has('orbit')) {
      const r = await guard('orbit', () => orbitProbe(S));
      if (r) put('orbit', 'orbit', r);
      await S.page.evaluate(() => window.__pk.view()); await sleep(1500);
    }
    lap('idle+orbit');
    if (want.has('click') || want.has('lift') || want.has('drag')) {
      // the press that selects the vase is always made, so Lift and the drag start from the same state at every commit
      const r = await guard('click', () => clickProbe(S, v.id));
      if (want.has('click') && r) put('click', 'click', r);
      if (want.has('lift')) {
        if (r && r.na) out.na.lift = 'the vase could not be selected for Lift (' + r.reason + ')';
        else { const l = await guard('lift', () => liftProbe(S, v.id)); if (l) put('lift', 'lift', l); }
      }
    }
    lap('click+lift');
    if (want.has('drag')) {
      await S.page.evaluate(() => window.__pk.closeMenus());
      const dv = await guard('drag', () => dragProbe(S, v.id, 'vase'));
      if (dv) put('drag', 'drag.vase', dv);
    }
    lap('drag');
    out.blocked = S.blocked; out.pageErrors = S.errors.slice(0, 5);
  } finally { await S.ctx.close().catch(() => {}); }
  return out;
}

// ----------------------------------------------------------------------------------------------- the leak cycles
const CYCLE_KINDS = ['yaw+undo', 'bake+undo', 'cut-preview', 'select'];

async function waitUndo(page, n, ms) {
  return page.waitForFunction(n => state.undoStack.length === n, n, { timeout: ms, polling: 100 }).then(() => true, () => false);
}

async function oneCycle(S, kind, ids) {
  const { page } = S, vaseId = ids.vase;
  const undoN = () => page.evaluate(() => state.undoStack.length);
  const press = async id => {                        // a real press on the top of a piece
    const pt = await page.evaluate(id => window.__pk.top(id), id);
    await page.mouse.click(pt.a.x, pt.a.y);
    await quiet(page);
    return selectedIs(page, id);
  };
  if (kind === 'yaw+undo') {
    const u = await undoN();
    await uiClick(page, '#btn-rot-left', 300000);
    if (!(await waitUndo(page, u + 1, 120000))) return NA(kind, 'Yaw pushed no undo step (#btn-rot-left disabled or did nothing)');
    await quiet(page);
    await page.evaluate(() => window.__pk.closeMenus());
    await page.click('#btn-undo', { timeout: 300000 });
    if (!(await waitUndo(page, u, 120000))) return NA(kind, 'Undo did not take the Yaw back');
  } else if (kind === 'bake+undo') {
    const id = BAKE === 'solidify' ? '#btn-solidify' : '#btn-seal';
    const u = await undoN();
    await uiClick(page, id, VASE_CYCLE_WAIT_MS);
    if (!(await waitUndo(page, u + 1, 20000)))
      return NA(kind, BAKE + ' pushed no undo step on this piece: "' + (await page.evaluate(() => (document.getElementById('status') || {}).textContent || '')).slice(0, 120) + '"');
    await quiet(page);
    await page.evaluate(() => window.__pk.closeMenus());
    await page.click('#btn-undo', { timeout: 300000 });
    if (!(await waitUndo(page, u, 120000))) return NA(kind, 'Undo did not take the ' + BAKE + ' back');
  } else if (kind === 'cut-preview') {
    if (!(await selectedIs(page, vaseId)) && !(await press(vaseId))) return NA(kind, 'the vase could not be selected for the Cut preview');
    const has = await page.evaluate(() => !!document.querySelector('#menu-cut > summary'));
    const how = has ? 'ui' : await page.evaluate(() => (typeof openCutter === 'function' && typeof closeCutter === 'function') ? 'fn' : null);
    if (!how) return NA(kind, 'no #menu-cut and no openCutter() / closeCutter() at this commit');
    if (how === 'ui') await page.click('#menu-cut > summary', { timeout: 120000 });
    else await page.evaluate(() => openCutter('cut'));
    await page.waitForFunction(() => state.cutterOpen === true && !!state.cutHelper, null, { timeout: 120000, polling: 50 }).catch(() => {});
    await quiet(page);
    if (!(await page.evaluate(() => state.cutterOpen === true && !!state.cutHelper))) return NA(kind, 'opening the Cut card did not arm the cutter on the vase (no blade)');
    if (how === 'ui') await page.click('#menu-cut > summary', { timeout: 120000 });
    else await page.evaluate(() => closeCutter());
    await page.waitForFunction(() => !state.cutterOpen, null, { timeout: 120000, polling: 50 }).catch(() => {});
  } else if (kind === 'select') {
    /* This app has no press-on-empty-plate-to-deselect (a bare press orbits), so a piece is un-selected by selecting
       another: the vase, then the box, and round again. */
    if (!(await press(vaseId))) return NA(kind, 'the press at the top of the vase did not select it');
    if (!(await press(ids.box))) return NA(kind, 'the press at the top of the box did not select it');
  }
  await page.evaluate(() => window.__pk.closeMenus());
  await quiet(page);
  return { ok: true };
}

async function sampleNow(S) {
  await quiet(S.page);
  await gc(S.cdp);
  return S.page.evaluate(() => window.__pk.sample());
}

async function leakRun(browser, root, port, vase, kind) {
  const S = await openContext(browser, root, port);
  try {
    const ids = {};
    if (kind === 'select') ids.box = (await loadOne(S, BOX, 'box')).id;
    const v = await loadOne(S, vase.file, 'vase');
    ids.vase = v.id;
    await S.page.evaluate(([v, b]) => { window.__pk.setXZ(v, b == null ? 0 : -50, -20); if (b != null) window.__pk.setXZ(b, 50, -20); window.__pk.fit(v); window.__pk.view(); }, [v.id, ids.box == null ? null : ids.box]);
    await sleep(2500);
    // the cycles that act on the selected piece start with it selected, by a real press
    if (kind !== 'select') {
      const pt = await S.page.evaluate(id => window.__pk.top(id), v.id);
      await S.page.mouse.click(pt.a.x, pt.a.y); await quiet(S.page);
      if (!(await selectedIs(S.page, v.id))) {
        const d = await S.page.evaluate(() => ({ sel: state.selectedIndex, k: window.__pk.k, cam: state.camera.position.toArray().map(Math.round) }));
        return NA(kind, 'the press at (' + pt.a.x.toFixed(0) + ', ' + pt.a.y.toFixed(0) + ')' + (pt.missed ? ' (no ray hit the vase first)' : '') + ' did not select the vase (selectedIndex ' + d.sel + ', k ' + d.k + ', camera ' + d.cam + ')');
      }
    }
    const samples = [Object.assign({ cycle: 0, wallMs: 0 }, await sampleNow(S))];
    for (let c = 1; c <= CYCLES; c++) {
      const t0 = Date.now();
      const r = await oneCycle(S, kind, ids);
      if (r.na) return samples.length > 1 ? { partial: true, why: 'cycle ' + c + ': ' + r.reason, samples } : NA(kind, r.reason);
      const wall = Date.now() - t0;
      samples.push(Object.assign({ cycle: c, wallMs: wall }, await sampleNow(S)));
      log('   ', kind, 'cycle', c, 'geom', samples[c].geometries, 'tex', samples[c].textures, 'obj', samples[c].objects, 'heap', samples[c].heapMB.toFixed(1), 'undo', samples[c].undo, 'int', samples[c].intervals, 'listeners', samples[c].docListeners + '/' + samples[c].winListeners, wall + ' ms');
    }
    return { samples };
  } finally { await S.ctx.close().catch(() => {}); }
}

const LEAK_KEYS = ['geometries', 'textures', 'calls', 'triangles', 'objects', 'heapMB', 'undo', 'intervals', 'docListeners', 'winListeners'];
function leakGrowth(samples) {
  const g = {};
  const slope = (xs, ys) => { const n = xs.length, mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); } return sxx ? sxy / sxx : 0; };
  LEAK_KEYS.forEach(k => {
    const ys = samples.map(s => s[k]), xs = samples.map(s => s.cycle);
    if (ys.some(y => y == null)) return;
    const steps = ys.slice(1).map((y, i) => y - ys[i]);
    g[k] = { first: ys[0], last: ys[ys.length - 1], total: ys[ys.length - 1] - ys[0], perCycle: slope(xs, ys), perCycleAfterFirst: ys.length > 2 ? slope(xs.slice(1), ys.slice(1)) : null,
             risesEveryCycle: steps.length > 0 && steps.every(d => d > (k === 'heapMB' ? 0.05 : 0)), risesAfterWarmup: steps.length > 1 && steps.slice(1).every(d => d > (k === 'heapMB' ? 0.05 : 0)) };
  });
  return g;
}

// ----------------------------------------------------------------------------------------------- one commit
function aggregate(runs) {
  const keys = new Set(); runs.forEach(r => Object.keys(r.values).forEach(k => keys.add(k)));
  const m = {};
  const lowIsBad = k => /\.fps$/.test(k);
  keys.forEach(k => {
    const v = runs.map(r => r.values[k]).filter(x => Number.isFinite(x));
    if (!v.length) return;
    m[k] = { median: med(v), worst: lowIsBad(k) ? Math.min.apply(null, v) : Math.max.apply(null, v), runs: v, n: v.length };
  });
  const na = {};
  runs.forEach(r => Object.keys(r.na).forEach(p => { (na[p] = na[p] || []).push(r.na[p]); }));
  Object.keys(na).forEach(p => { na[p] = { runs: na[p].length, reason: na[p][0] }; });
  return { metrics: m, na };
}

const outFile = (c, dir) => path.join(dir || OUT, c.sha.slice(0, 10) + '.json');
function loadResult(c, dir) { try { return JSON.parse(fs.readFileSync(outFile(c, dir), 'utf8')); } catch (e) { return null; } }
function saveResult(c, res, dir) { fs.mkdirSync(dir || OUT, { recursive: true }); fs.writeFileSync(outFile(c, dir), JSON.stringify(res, null, 1)); }

async function measureCommit(c, wantProbes, dir) {
  const vase = vaseFile();
  const want = new Set(wantProbes);
  const prev = loadResult(c, dir) || {};
  // what is already there is kept unless --force, so a resumed or widened run does only the missing probes
  const have = pr => !FORCE && prev.timing && prev.timing.probesDone && prev.timing.probesDone.includes(pr);
  const needTiming = ['click', 'drag', 'lift', 'idle', 'orbit'].some(p => want.has(p) && !have(p)) || (want.has('load') && !have('load'));
  const needLeaks = want.has('leaks') && !(!FORCE && prev.leaks && prev.leaks.done);
  if (!needTiming && !needLeaks) { log(label(c), 'already measured'); return prev; }
  log('==', label(c), '-', c.subject);
  const wt = checkout(c.sha);
  const srv = await serve(wt);
  const port = srv.address().port;
  const browser = await chromium.launch({ executablePath: chromiumPath(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--enable-precise-memory-info'] });
  const res = Object.assign({}, prev, {
    sha: c.sha, short: c.short, pos: c.pos, subject: c.subject, prs: c.prs, merge: c.merge,
    vase: vase.label, vaseReal: vase.real, vaseFile: vase.real ? path.basename(vase.file) : 'tools/perf-bisect-out/vase-standin.stl (1000 x 501 UV sphere, r 30 mm)',
    env: { chromium: browser.version(), node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0].model, platform: process.platform + ' ' + os.release(),
           flags: '--use-gl=swiftshader --enable-unsafe-swiftshader --no-sandbox --enable-precise-memory-info', viewport: '1280x800' },
    measuredAt: new Date().toISOString()
  });
  try {
    if (needTiming) {
      const todo = ['load', 'click', 'drag', 'lift', 'idle', 'orbit'].filter(p => (p === 'load' || want.has(p)) && !have(p));
      const wantSet = new Set(todo);
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = Date.now();
        try { runs.push(await timingRun(browser, wt, port, vase, wantSet)); }
        catch (e) { runs.push({ values: {}, na: { load: 'run failed: ' + String(e && e.message || e).split('\n')[0] }, notes: {} }); log('   run', i + 1, 'FAILED', String(e && e.message || e).split('\n')[0]); }
        log('   run', i + 1 + '/' + RUNS, ((Date.now() - t0) / 1000).toFixed(0) + ' s');
      }
      const agg = aggregate(runs);
      const old = prev.timing || { metrics: {}, na: {}, probesDone: [], runsRaw: [] };
      // replace only the probes measured now
      const mine = k => todo.some(p => k.startsWith(p + '.'));
      const metrics = Object.assign({}, FORCE ? {} : old.metrics);
      Object.keys(metrics).forEach(k => { if (mine(k)) delete metrics[k]; });
      Object.assign(metrics, agg.metrics);
      const na = Object.assign({}, FORCE ? {} : old.na);
      todo.forEach(p => { delete na[p]; });
      Object.assign(na, agg.na);
      res.timing = { runs: RUNS, metrics, na, probesDone: [...new Set([...(old.probesDone || []), ...todo])], notes: runs.map(r => r.notes), blocked: [...new Set([].concat(...runs.map(r => r.blocked || [])))], stepsMs: runs.map(r => r.steps || {}), pageErrors: [...new Set([].concat(...runs.map(r => r.pageErrors || [])))], runsRaw: runs.map(r => r.values) };
      saveResult(c, res, dir);
    }
    if (needLeaks) {
      const leaks = { cycles: CYCLES, bake: BAKE, byKind: {}, done: false };
      for (const kind of CYCLE_KINDS) {
        log('  leaks:', kind);
        try {
          const r = await leakRun(browser, wt, port, vase, kind);
          if (r.na) leaks.byKind[kind] = { na: r.reason };
          else leaks.byKind[kind] = { samples: r.samples, growth: leakGrowth(r.samples), partial: r.partial ? r.why : undefined };
        } catch (e) { leaks.byKind[kind] = { na: 'error: ' + String(e && e.message || e).split('\n')[0] }; }
        saveResult(c, Object.assign({}, res, { leaks }), dir);
      }
      leaks.done = true;
      res.leaks = leaks;
      saveResult(c, res, dir);
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
    release(wt);
  }
  return res;
}

// ----------------------------------------------------------------------------------------------- comparing, flagging
const TIMING_LABELS = [
  ['load.box.ms', 'Load box: file given -> on plate', 'ms'], ['load.vase.ms', 'Load vase: file given -> on plate', 'ms'], ['load.vase.frameMs', 'Load vase: -> next frame', 'ms'], ['load.vase.jsMs', 'Load vase: app JS', 'ms'], ['load.vase.mainMs', 'Load vase: main-thread busy', 'ms'],
  ['click.frameMs', 'First click on vase -> next frame', 'ms'], ['click.jsMs', 'First click: app JS', 'ms'], ['click.mainMs', 'First click: main-thread busy', 'ms'], ['click.hoverJsMs', 'Pointer onto the vase: app JS (before the click)', 'ms'],
  ['drag.vase.moveMs', 'Drag vase: ms / pointer move (mean)', 'ms'], ['drag.vase.moveMedMs', 'Drag vase: ms / pointer move (median)', 'ms'], ['drag.vase.upMs', 'Drag vase: release handlers', 'ms'], ['drag.vase.upFrameMs', 'Drag vase: release -> next frame', 'ms'],
  ['lift.armMs', 'Lift: arm -> ready', 'ms'], ['lift.frameMs', 'Lift: arm -> ready + next frame', 'ms'], ['lift.jsMs', 'Lift: app JS', 'ms'], ['lift.mainMs', 'Lift: main-thread busy', 'ms'],
  ['idle.jsMsPerFrame', 'Idle: app JS ms / frame', 'ms'], ['idle.layoutMsPerFrame', 'Idle: style + layout ms / frame', 'ms'], ['idle.mainMsPerFrame', 'Idle: main-thread ms / frame', 'ms'], ['idle.fps', 'Idle: frames / s', 'fps'],
  ['orbit.msPerFrame', 'Orbit: ms / frame', 'ms'], ['orbit.jsMsPerFrame', 'Orbit: app JS ms / frame', 'ms'], ['orbit.fps', 'Orbit: frames / s', 'fps']
];
// the metrics the 20 % and 5 ms rule reads in pass 2 (fps is the same fact as ms / frame, so it is not a second trigger)
const TRIGGER_KEYS = TIMING_LABELS.filter(l => l[2] === 'ms' && !/medMs$/.test(l[0])).map(l => l[0]);

function metricOf(res, key) {
  if (!res) return undefined;
  if (key.startsWith('leaks.')) {
    const [, kind, count] = key.split('.');
    const k = res.leaks && res.leaks.byKind && res.leaks.byKind[kind];
    const g = k && k.growth && k.growth[count];
    return g ? (g.perCycleAfterFirst != null ? g.perCycleAfterFirst : g.perCycle) : undefined;
  }
  const m = res.timing && res.timing.metrics[key];
  return m ? m.median : undefined;
}

function moved(a, b, key) {
  if (a == null || b == null) return false;
  if (key.startsWith('leaks.')) return Math.abs(a - b) >= (key.endsWith('.heapMB') ? Math.max(0.5, 0.2 * Math.abs(a)) : 0.1);
  return Math.abs(b - a) > 5 && Math.abs(b - a) > 0.2 * Math.abs(a);
}

function leakKeysOf(res) {
  const ks = [];
  const bk = res && res.leaks && res.leaks.byKind || {};
  Object.keys(bk).forEach(kind => { if (bk[kind].growth) Object.keys(bk[kind].growth).forEach(c => ks.push('leaks.' + kind + '.' + c)); });
  return ks;
}

// ----------------------------------------------------------------------------------------------- bisect
async function bisect(good, bad, metric, ch) {
  const trail = [];
  const probe = metric.startsWith('leaks.') ? 'leaks' : metric.split('.')[0];
  const measure = async c => { const r = await measureCommit(c, probe === 'leaks' ? ['leaks'] : ['load', probe]); return metricOf(r, metric); };
  const g = await measure(good), b = await measure(bad);
  if (g == null || b == null) return { metric, good: good.short, bad: bad.short, error: 'endpoint has no value for ' + metric + ' (good ' + g + ', bad ' + b + ')', trail };
  const thr = (g + b) / 2, badIsHigher = b > g;
  let lo = good.pos, hi = bad.pos;                 // lo is on the good side, hi on the bad side
  trail.push({ commit: good.short, value: g, side: 'good' }, { commit: bad.short, value: b, side: 'bad' });
  while (hi - lo > 1) {
    const mid = ch[(lo + hi) >> 1], v = await measure(mid);
    if (v == null) { trail.push({ commit: mid.short, value: null, side: 'skipped (n/a)' }); lo = mid.pos; continue; }
    const isBad = badIsHigher ? v > thr : v < thr;
    trail.push({ commit: mid.short, subject: mid.subject, value: v, side: isBad ? 'bad' : 'good' });
    if (isBad) hi = mid.pos; else lo = mid.pos;
  }
  const culprit = ch[hi], before = ch[lo];
  const cv = metricOf(loadResult(culprit), metric), bv = metricOf(loadResult(before), metric);
  return { metric, good: good.short, bad: bad.short, threshold: thr, culprit: culprit.short, culpritSubject: culprit.subject, prs: culprit.prs, merge: culprit.merge,
           before: before.short, beforeValue: bv, afterValue: cv, trail };
}

// ----------------------------------------------------------------------------------------------- report
function medOf(res, k) { const m = res && res.timing && res.timing.metrics[k]; return m ? m.median : null; }
function worstOf(res, k) { const m = res && res.timing && res.timing.metrics[k]; return m ? m.worst : null; }
function naOf(res, probe) { return res && res.timing && res.timing.na && res.timing.na[probe] ? res.timing.na[probe].reason : null; }
const probeOfKey = k => k.split('.')[0];
const cellNum = (x, unit) => fx(x, unit === 'fps' ? 2 : x != null && Math.abs(x) < 10 ? 2 : x != null && Math.abs(x) < 100 ? 1 : 0);
const prName = c => (c.prs && c.prs.length ? 'PR ' + c.prs.map(n => '#' + n).join(' + ') : c.short + ' (a direct commit: ' + (c.subject || '').slice(0, 60) + ')');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };

function report(plan, ch) {
  const rs = plan.map(c => ({ c, r: loadResult(c) }));
  const have = rs.filter(x => x.r);
  const L = [];
  const anyStand = have.some(x => !x.r.vaseReal);
  const tag = anyStand ? ' (stand-in)' : '';
  const col = x => x.c.short + (x.c.merge && x.c.prs.length ? '<br>#' + x.c.prs.join('+#') : '');
  L.push('# perf-bisect results', '');
  L.push('Vase: ' + (anyStand ? '**stand-in** - the 1,000,000-triangle UV sphere of `nso_big_mesh_lib.js` (the real `tools/fixtures-local/boolean-vase.3mf` was not on this box). Every vase figure is marked "stand-in".' : 'the real boolean-vase.3mf.'), '');
  if (have[0]) L.push('Machine: ' + have[0].r.env.cpu + ' x' + have[0].r.env.cpus + ', ' + have[0].r.env.platform + ', Chromium ' + have[0].r.env.chromium + ', headless, flags `' + have[0].r.env.flags + '`, viewport ' + have[0].r.env.viewport + '. **Software GL** (swiftshader): a frame costs ~0.4 s per million triangles of main-thread time whatever the app does, so every "to next frame" and frames-per-second figure is inflated by the machine; compare commits to each other and read the app-JS rows for the app\'s own cost.', '');

  L.push('## 1. Pass 1: probe x commit' + tag + ' - median of ' + RUNS + ' runs (worst run in brackets)', '');
  L.push('| probe | ' + have.map(col).join(' | ') + ' |', '|---|' + have.map(() => '---').join('|') + '|');
  TIMING_LABELS.forEach(([k, lab, unit]) => {
    const cells = have.map(x => {
      const m = x.r.timing && x.r.timing.metrics[k];
      if (m) return cellNum(m.median, unit) + ' (' + cellNum(m.worst, unit) + ')';
      return naOf(x.r, probeOfKey(k)) ? 'n/a' : '-';
    });
    if (cells.every(c => c === '-')) return;
    L.push('| ' + lab + ' [' + unit + '] | ' + cells.join(' | ') + ' |');
  });
  L.push('', 'n/a reasons:', '');
  const reasons = new Map();
  have.forEach(x => { const na = x.r.timing && x.r.timing.na || {}; Object.keys(na).forEach(p => { const k = p + ': ' + na[p].reason; if (!reasons.has(k)) reasons.set(k, []); reasons.get(k).push(x.c.short); }); });
  reasons.forEach((cs, k) => L.push('- ' + k + ' - at ' + cs.join(', ')));
  if (!reasons.size) L.push('- none');
  L.push('');

  const p2 = readJson(path.join(OUT, 'pass2.json')) || [];
  L.push('## 2. Pass 2: regressions pinned to a single merge' + tag, '');
  if (!p2.length) L.push('(no pass-2 results yet)', '');
  else {
    L.push('| merge | probe | before -> after | worst run before -> after | bisect trail |', '|---|---|---|---|---|');
    p2.forEach(r => {
      const cul = ch.find(c => c.short === r.culprit), bef = ch.find(c => c.short === r.before) || ch.find(c => c.pos === (cul ? cul.pos - 1 : -1));
      const isLeak = r.metric.startsWith('leaks.');
      const rc = cul && loadResult(cul), rb = bef && loadResult(bef);
      const unit = isLeak ? (r.metric.endsWith('heapMB') ? ' MB/cycle' : ' /cycle') : ' ms';
      const wr = isLeak ? 'n/a' : fx(worstOf(rb, r.metric), 2) + ' -> ' + fx(worstOf(rc, r.metric), 2);
      if (r.error) { L.push('| - | ' + r.metric + ' | ' + r.error + ' | | |'); return; }
      L.push('| ' + (cul ? prName(cul) + ' (' + cul.short + ')' : r.culprit) + ' | ' + r.metric + ' | ' + fx(r.beforeValue, 2) + ' -> ' + fx(r.afterValue, 2) + unit + ' | ' + wr + ' | ' + (r.trail || []).map(t => t.commit + ':' + (t.value == null ? 'n/a' : fx(t.value, 1)) + ' ' + t.side).join(', ') + ' |');
    });
    L.push('');
  }

  L.push('## 3. Leaks: growth per cycle after the first (least-squares over cycles 1..' + CYCLES + ')' + tag, '');
  L.push('`F` = rises in every one of the ' + CYCLES + ' cycles; `w` = rises in every cycle after the first (the first is warm-up). Heap is after a forced GC, in MB.', '');
  CYCLE_KINDS.forEach(kind => {
    L.push('### ' + kind, '');
    L.push('| per cycle | ' + have.map(col).join(' | ') + ' |', '|---|' + have.map(() => '---').join('|') + '|');
    LEAK_KEYS.forEach(k => {
      const cells = have.map(x => {
        const e = x.r.leaks && x.r.leaks.byKind && x.r.leaks.byKind[kind];
        if (!e) return '-';
        if (e.na) return 'n/a';
        const g = e.growth[k];
        if (!g) return '-';
        const v = g.perCycleAfterFirst != null ? g.perCycleAfterFirst : g.perCycle;
        return fx(v, 2) + (g.risesEveryCycle ? ' F' : g.risesAfterWarmup ? ' w' : '');
      });
      L.push('| ' + k + ' | ' + cells.join(' | ') + ' |');
    });
    const nas = have.filter(x => { const e = x.r.leaks && x.r.leaks.byKind && x.r.leaks.byKind[kind]; return e && (e.na || e.partial); });
    nas.forEach(x => { const e = x.r.leaks.byKind[kind]; L.push('', '- ' + x.c.short + ': ' + (e.na || ('stopped early - ' + e.partial))); });
    L.push('');
  });

  const b = have.find(x => x.c.sha === ch[0].sha), h = have.find(x => x.c.sha === ch[ch.length - 1].sha);
  if (b && h) {
    L.push('## 4. Idle-frame cost, ' + h.c.short + ' vs ' + b.c.short + tag, '');
    L.push('Nothing happening for 5 s, vase and box on the plate. This sizes drawing only when something changes: every idle frame is a frame the app draws for nothing.', '');
    L.push('| per frame | ' + b.c.short + ' | ' + h.c.short + ' | change |', '|---|---|---|---|');
    ['idle.jsMsPerFrame', 'idle.layoutMsPerFrame', 'idle.mainMsPerFrame', 'idle.fps', 'orbit.jsMsPerFrame', 'orbit.msPerFrame'].forEach(k => {
      const lab = (TIMING_LABELS.find(l => l[0] === k) || [])[1], x = medOf(b.r, k), y = medOf(h.r, k);
      L.push('| ' + lab + ' | ' + fx(x, 2) + ' | ' + fx(y, 2) + ' | ' + (x && y ? (y >= x ? '+' : '') + (100 * (y - x) / x).toFixed(0) + ' %' : 'n/a') + ' |');
    });
    L.push('');
  }

  L.push('## 5. The vase', '');
  if (anyStand) {
    const shas = [...new Set([BASE, ...p2.filter(r => !r.error).map(r => r.culprit), ...p2.filter(r => !r.error).map(r => r.before), HEAD].filter(Boolean))];
    L.push('The **stand-in** was used (a 1,000,000-triangle UV sphere). To rerun the flagged commits with the real vase, put it at `tools/fixtures-local/boolean-vase.3mf` and run:', '',
           '    npm run perf:bisect -- --commits ' + shas.join(',') + ' --out tools/perf-bisect-out/real', '');
  } else L.push('The real vase was used.', '');
  const self = path.join(OUT, 'selfcheck.md');
  if (fs.existsSync(self)) L.push('## 6. Self-check', '', fs.readFileSync(self, 'utf8').split('\n').slice(0, 4).join('\n'), '(full table: selfcheck.md)', '');
  return L.join('\n');
}

// ----------------------------------------------------------------------------------------------- main
async function main() {
  const ch = chain();
  const plan = pass1Plan(ch);
  const vase = vaseFile();
  if (flag('plan')) {
    console.log('first-parent chain ' + BASE + '..' + HEAD + ': ' + ch.length + ' commits, ' + ch.filter(c => c.merge).length + ' merges');
    plan.forEach(c => console.log(String(c.pos).padStart(3), label(c).padEnd(26), '[' + c.why.join(', ') + ']', c.subject.slice(0, 70)));
    console.log('vase: ' + vase.label + (vase.real ? ' (' + vase.file + ')' : ''));
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  if (flag('report')) {
    const md = report(plan, ch);
    fs.writeFileSync(path.join(OUT, 'perf-bisect.md'), md);
    console.log(md);
    return;
  }
  if (flag('commits')) {
    const list = opt('commits', '').split(',').filter(Boolean).map(r => resolve(r, ch));
    for (const c of list) await measureCommit(c, PROBES);
    return;
  }
  if (flag('pass1')) {
    for (const c of plan) await measureCommit(c, PROBES);
    log('pass 1 done: ' + plan.length + ' commits in ' + OUT);
    return;
  }
  if (flag('selfcheck')) {
    /* Run 1 is the pass-1 measurement in the out dir (taken first if it is missing); run 2 is a second, independent
       measurement of the same commit, kept in selfcheck/. */
    const ends = [ch[0], ch[ch.length - 1]];
    const runs = {};
    for (const c of ends) {
      await measureCommit(c, PROBES);
      await measureCommit(c, PROBES, path.join(OUT, 'selfcheck'));
      runs[c.short] = [loadResult(c), loadResult(c, path.join(OUT, 'selfcheck'))];
    }
    const lines = ['| commit | metric | run 1 | run 2 | difference |', '|---|---|---|---|---|'], bad = [];
    ends.forEach(c => {
      const [r1, r2] = runs[c.short];
      const keys = new Set([...Object.keys(r1.timing.metrics), ...Object.keys(r2.timing.metrics)]);
      keys.forEach(k => {
        const a = medOf(r1, k), b = medOf(r2, k);
        if (a == null || b == null) { lines.push('| ' + c.short + ' | ' + k + ' | ' + fx(a, 2) + ' | ' + fx(b, 2) + ' | one run n/a |'); bad.push([c.short, k, 'n/a in one run']); return; }
        const d = Math.abs(b - a) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
        lines.push('| ' + c.short + ' | ' + k + ' | ' + fx(a, 3) + ' | ' + fx(b, 3) + ' | ' + (100 * d).toFixed(1) + ' %' + (d > 0.1 ? ' **>10 %**' : '') + ' |');
        if (d > 0.1) bad.push([c.short, k, (100 * d).toFixed(1) + ' %', a, b]);
      });
      const k1 = r1.leaks && r1.leaks.byKind, k2 = r2.leaks && r2.leaks.byKind;
      CYCLE_KINDS.forEach(kind => {
        const g1 = k1 && k1[kind] && k1[kind].growth, g2 = k2 && k2[kind] && k2[kind].growth;
        if (!g1 || !g2) return;
        LEAK_KEYS.forEach(kk => {
          if (!g1[kk] || !g2[kk]) return;
          const a = g1[kk].perCycle, b = g2[kk].perCycle, d = Math.abs(b - a);
          lines.push('| ' + c.short + ' | leaks.' + kind + '.' + kk + ' (per cycle) | ' + fx(a, 2) + ' | ' + fx(b, 2) + ' | ' + (kk === 'heapMB' ? d.toFixed(2) + ' MB' : d.toFixed(2)) + ' |');
        });
      });
    });
    const md = '# perf-bisect self-check\n\n' + (bad.length ? 'These probes did NOT repeat within 10 %:\n\n' + bad.map(b => '- ' + b.join(' ')).join('\n') + '\n\n' : 'Every probe repeated within 10 %.\n\n') + lines.join('\n') + '\n';
    fs.writeFileSync(path.join(OUT, 'selfcheck.md'), md);
    console.log(md);
    return;
  }
  if (flag('bisect')) {
    const i = argv.indexOf('--bisect');
    const good = resolve(argv[i + 1], ch), bad = resolve(argv[i + 2], ch), metric = opt('metric', null);
    if (!metric) throw new Error('--bisect needs --metric');
    const r = await bisect(good, bad, metric, ch);
    fs.writeFileSync(path.join(OUT, 'bisect-' + metric + '-' + good.short + '-' + bad.short + '.json'), JSON.stringify(r, null, 1));
    console.log(JSON.stringify(r, null, 1));
    return;
  }
  if (flag('pass2')) {
    const flagged = [];
    for (let i = 1; i < plan.length; i++) {
      const a = loadResult(plan[i - 1]), b = loadResult(plan[i]);
      if (!a || !b) continue;
      const keys = [...TRIGGER_KEYS, ...new Set([...leakKeysOf(a), ...leakKeysOf(b)])];
      keys.forEach(k => { const x = metricOf(a, k), y = metricOf(b, k); if (moved(x, y, k)) flagged.push({ from: plan[i - 1], to: plan[i], key: k, a: x, b: y }); });
    }
    log('pass 2: ' + flagged.length + ' neighbour movements flagged');
    const results = [];
    for (const f of flagged) {
      if (f.to.pos - f.from.pos <= 1) { results.push({ metric: f.key, good: f.from.short, bad: f.to.short, culprit: f.to.short, culpritSubject: f.to.subject, prs: f.to.prs, merge: f.to.merge, beforeValue: f.a, afterValue: f.b, trail: [] }); continue; }
      log('bisect', f.key, f.from.short, '->', f.to.short, fx(f.a, 2), '->', fx(f.b, 2));
      const r = await bisect(f.from, f.to, f.key, ch);
      results.push(r);
      fs.writeFileSync(path.join(OUT, 'pass2.json'), JSON.stringify(results, null, 1));
    }
    fs.writeFileSync(path.join(OUT, 'pass2.json'), JSON.stringify(results, null, 1));
    return;
  }
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
}

main().catch(e => { console.error(e); process.exit(1); });

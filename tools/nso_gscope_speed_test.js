#!/usr/bin/env node
/* G-scope's speed (docs/GSCOPE.md, item 10).

   G-scope is driven at 1280 x 800 with a real mouse, and every number the
   contract names is measured:

     orbit        a 60-event left drag on bare canvas: the frame rate (a plain
                  requestAnimationFrame clock), the main thread's time per
                  pointermove and per frame, and how often the MAIN viewport
                  rendered behind G-scope (it is covered, so never)
     selection    the pick - what a press or a hover would take under the
                  pointer (pressTarget) - a hover's time per pointermove, and a
                  click (select and isolate)
     pull         a press on plate 1's piece carried across plate 1 and over
                  plate 2: mousedown to the first frame the copy is drawn under
                  the pointer, the main thread's time on the move that makes the
                  copy and on every move after, the share of moves the copy
                  followed, and the release
     plate 2      the copy, now on plate 2, dragged across its bed

   A move "followed" when the carried piece stands somewhere else after the
   pointermove than before it.

   Two files. THE FILE - tools/fixtures-local/baseline.gcode.3mf when it is
   there (the user's, git-ignored), else NSO_GSCOPE_SPEED_FILE, else the
   committed fixtures/3mf/tabletop.gcode.3mf (202,877 moves) - gives every
   main-thread number; its pull and plate 2 drag are 10 moves each. THE SMALL
   SLICE (fixtures/3mf/supportwithinsupport.gcode.3mf) gives the 60-move drags
   and the frame rate. Why: this box draws on SwiftShader, a software GPU, and a
   copy of tabletop is 2.4 million triangles - about two seconds a frame, and
   every real mouse move waits for one, so a 60-move drag of it is many minutes
   whatever the code does. --full (or the user's file) drives the 60-move drags
   on the file as well, for the measurement.

   GATES
     1. drag follows the mouse: the piece moved on >= 90 % of a 60-move pull
        (across plate 1, then over to plate 2) and of a 60-move drag on plate
        2; on the file, every move after the first of its shorter drags
     2. orbit >= 30 fps: (a) on the file, the main thread's work per frame
        <= 33 ms - the frame rate there is SwiftShader's, ~6 fps on tabletop's
        200,000 lines whatever the code does; (b) on the small slice, where the
        software GPU is not the limit, the frame rate itself
     3. the selection pass (the pick) <= 16 ms
     4. the main viewport does not render while G-scope covers it
     5. once a piece is in hand no move holds the main thread past a frame
        (33 ms), and neither does a press on plate 2
     6. the move that makes a pull's copy at most half d7abbea's: <= 7.2 ms
        per thousand moves copied (d7abbea 14.4, 346bc38 13.6)

   NSO_GSCOPE_SPEED_ROOT=<a checkout> measures that tree with this script
   (an older commit, for the before / after).

     node tools/nso_gscope_speed_test.js [--full]    exit 0 = every gate held */

const path = require('path');
const fs = require('fs');

const ROOT_HERE = path.resolve(__dirname, '..');
const TREE = path.resolve(process.env.NSO_GSCOPE_SPEED_ROOT || ROOT_HERE);
const { withApp } = require(path.join(TREE, 'tools', 'nso_app_harness'));
const LOCAL = path.join(ROOT_HERE, 'tools', 'fixtures-local', 'baseline.gcode.3mf');
const FILE = path.resolve(fs.existsSync(LOCAL) ? LOCAL
  : process.env.NSO_GSCOPE_SPEED_FILE || path.join(ROOT_HERE, 'fixtures', '3mf', 'tabletop.gcode.3mf'));
const SMALL = path.join(ROOT_HERE, 'fixtures', '3mf', 'supportwithinsupport.gcode.3mf');
const OUT = path.join(ROOT_HERE, 'tools', 'gscope-speed-out');
const JSON_ONLY = process.argv.includes('--json');
const FULL = process.argv.includes('--full') || !!process.env.NSO_GSCOPE_SPEED_FULL || FILE === LOCAL;

let fails = 0;
const check = (name, cond, detail) => {
  if (!JSON_ONLY) console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const say = s => { if (!JSON_ONLY) console.log(s); };
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const p90 = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN; };
const r1 = x => Math.round(x * 10) / 10;
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/* Before the app's scripts: each pointer listener timed, its time added to the
   event it ran for. Nothing else about the page changes. */
const TIMING = `
(function () {
  const TYPES = ['pointermove', 'pointerdown', 'pointerup', 'click'];
  const wrapped = new WeakMap();
  window.__cpu = { on: false, evs: [] };
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    if (TYPES.indexOf(type) < 0 || !fn) return add.call(this, type, fn, o);
    let w = wrapped.get(fn);
    if (!w) {
      w = function (e) {
        const t = performance.now();
        try { return typeof fn === 'function' ? fn.call(this, e) : fn.handleEvent(e); }
        finally {
          if (window.__cpu.on) {
            if (e.__cpu == null) { e.__cpu = 0; window.__cpu.evs.push(e); }
            e.__cpu += performance.now() - t;
          }
        }
      };
      wrapped.set(fn, w);
    }
    return add.call(this, type, w, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { return rem.call(this, type, (fn && wrapped.get(fn)) || fn, o); };
})();
`;

/* In the page, once G-scope is open. */
const HELPERS = `
window.__s = (function () {
  const M = () => window.NSO_MICROSCOPE, V = () => M().getView();
  let clock = null;
  const tick = ts => { if (!clock) return; clock.ts.push(ts); requestAnimationFrame(tick); };
  /* both renderers' render(), timed and counted */
  const timeRender = (r, key) => {
    if (r.__timed) return;
    const orig = r.render;
    r.render = function (s, c) { const t = performance.now(); orig.call(this, s, c); if (clock) clock[key].push(performance.now() - t); };
    r.__timed = true;
  };
  const canvas = () => V().renderer.domElement;
  const onCanvas = (x, y) => document.elementFromPoint(x, y) === canvas();
  return {
    start() {
      timeRender(V().renderer, 'gs');
      if (window.state && state.renderer) timeRender(state.renderer, 'main');
      clock = { ts: [], gs: [], main: [] };
      window.__cpu.evs = []; window.__cpu.on = true;
      requestAnimationFrame(tick);
    },
    stop() {
      const c = clock; clock = null; window.__cpu.on = false;
      c.ev = {};
      window.__cpu.evs.forEach(e => { (c.ev[e.type] = c.ev[e.type] || []).push(e.__cpu); });
      return c;
    },
    /* the piece being carried (a pull's copy, or the plate 2 piece grabbed): where it stands */
    carried() {
      const d = M().getDoc();
      if (!d || !d.objects || !(window.nsoGrab && nsoGrab.active())) return null;
      const o = d.objects.find(x => x.pulling) || d.objects.find(x => x.name === window.__grabbed);
      const m = o && V().overviewMeshes[o.name];
      return m && m.parent ? m.position.toArray().map(x => +x.toFixed(4)) : null;
    },
    /* a canvas pixel a press would take as the piece (piece mode) */
    piecePx() {
      const r = canvas().getBoundingClientRect();
      for (let fy = 0.35; fy < 0.8; fy += 0.04) for (let fx = 0.2; fx < 0.5; fx += 0.025) {
        const x = r.left + fx * r.width, y = r.top + fy * r.height;
        if (!onCanvas(x, y)) continue;
        const t = M().pressTargetAt(x, y);
        if (t && (t.source === 'pick' || t.source === 'piece')) return [x, y];
      }
      return null;
    },
    /* a canvas pixel over nothing a press takes (an orbit starts there) */
    emptyPx() {
      const r = canvas().getBoundingClientRect();
      for (let fy = 0.08; fy < 0.3; fy += 0.03) for (let fx = 0.4; fx < 0.65; fx += 0.03) {
        const x = r.left + fx * r.width, y = r.top + fy * r.height;
        if (onCanvas(x, y) && !M().pressTargetAt(x, y)) return [x, y];
      }
      return null;
    },
    pick(x, y, n) { const out = []; for (let i = 0; i < n; i++) { const t = performance.now(); M().pressTargetAt(x + (i % 3), y + (i % 2)); out.push(performance.now() - t); } return out; },
    /* a view-space point as a screen pixel */
    px(x, y, z) { const p = new THREE.Vector3(x, y, z).project(V().camera), r = canvas().getBoundingClientRect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; },
    /* the top of the active plate's first piece, in the middle */
    topPx(i) {
      const d = M().getDoc(), o = d.objects[i || 0], b = o.bounds;
      return this.px((b.minX + b.maxX) / 2 - d.cx, b.maxZ, -((b.minY + b.maxY) / 2 - d.cy));
    },
    takeOffset() { return M().plateOffset ? M().plateOffset('take') : 0; }
  };
})();
`;

function clockSummary(c) {
  const iv = [];
  for (let i = 1; i < c.ts.length; i++) iv.push(c.ts[i] - c.ts[i - 1]);
  const span = c.ts.length > 1 ? c.ts[c.ts.length - 1] - c.ts[0] : 0;
  const ev = {};
  Object.keys(c.ev).forEach(k => { const a = c.ev[k]; ev[k] = { n: a.length, med: r1(med(a)), p90: r1(p90(a)), max: r1(Math.max(...a)) }; });
  return {
    fps: r1(span ? (c.ts.length - 1) / span * 1000 : 0), frameMs: r1(med(iv)),
    gsRenderMs: r1(med(c.gs)), mainRenders: c.main.length, mainRenderMs: r1(med(c.main)), frames: c.ts.length, ev
  };
}

/* 60 moves, each awaited; after each, did the carried piece move? */
async function drive(page, pts, follow) {
  const moved = [];
  let prev = follow ? await page.evaluate(() => window.__s.carried()) : null;
  for (const p of pts) {
    await page.mouse.move(p[0], p[1]);
    if (!follow) continue;
    const c = await page.evaluate(() => window.__s.carried());
    moved.push(!!c && JSON.stringify(c) !== JSON.stringify(prev));
    prev = c;
  }
  return moved;
}

/* Open a sliced file in G-scope (whole visit fresh). */
async function openSlice(page, file) {
  await page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
  const bytes = Array.from(fs.readFileSync(file));
  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, path.basename(file)]);
  await page.waitForFunction(n => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath' &&
    NSO_MICROSCOPE.getDoc().name === n, path.basename(file), { timeout: 120000 });
  if (!(await page.evaluate(() => !!window.__s))) await page.evaluate(HELPERS);      // once: its render() timers stay on the renderer
  await page.waitForTimeout(400);
  await frames(page);
  return page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.length);
}

/* A 60-event (or n-event) left drag on bare canvas. */
async function orbit(page, n) {
  const e0 = await page.evaluate(() => window.__s.emptyPx());
  const pts = [];
  for (let i = 1; i <= n; i++) pts.push([e0[0] + i * 4, e0[1] + Math.sin(i / 8) * 20]);
  await page.mouse.move(e0[0], e0[1]);
  await page.mouse.down();
  await page.evaluate(() => window.__s.start());
  await drive(page, pts, false);
  const o = clockSummary(await page.evaluate(() => window.__s.stop()));
  await page.mouse.up();
  if (await page.evaluate(() => !!NSO_MICROSCOPE.frame)) await page.evaluate(() => NSO_MICROSCOPE.frame());
  await frames(page);
  const pm = o.ev.pointermove || { n: 0, med: 0 };
  // the main thread's share of a frame: G-scope's render() call, the main viewport's (none, now), and the pointermoves
  o.cpuPerFrame = r1(o.gsRenderMs + (o.mainRenders ? o.mainRenderMs * o.mainRenders / Math.max(1, o.frames) : 0) + pm.med * pm.n / Math.max(1, o.frames));
  return o;
}

/* The pull: a press on plate 1's piece, carried n/2 moves across plate 1, then n/2 over plate 2, let go there. */
async function pullDrive(page, n) {
  const p1 = await page.evaluate(() => window.__s.piecePx());
  if (!p1) return null;
  const off = await page.evaluate(() => window.__s.takeOffset());
  const to = off ? await page.evaluate(o => window.__s.px(o, 0, 0), off) : [p1[0] + 160, p1[1] + 40];
  const h = n / 2, pts = [];
  for (let i = 1; i <= h; i++) pts.push([p1[0] + i * 45 / h, p1[1] + i * 30 / h]);
  const mid = pts[pts.length - 1];
  for (let i = 1; i <= h; i++) pts.push([mid[0] + (to[0] - mid[0]) * i / h, mid[1] + (to[1] - mid[1]) * i / h]);
  await page.mouse.move(p1[0], p1[1]);
  await page.evaluate(() => {
    window.__down = null; window.__shown = null;
    // on the window, in the capture phase: G-scope's own press handler stops the event at the canvas
    window.addEventListener('pointerdown', () => { window.__down = performance.now(); }, { capture: true, once: true });
    const watch = ts => { if (window.__shown != null) return; if (window.__down != null && window.__s.carried()) { window.__shown = ts; return; } requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
  });
  await page.evaluate(() => window.__s.start());
  await page.mouse.down();
  const moved = await drive(page, pts, true);
  await page.mouse.up();
  await frames(page);
  const c = await page.evaluate(() => window.__s.stop());
  const pm = c.ev.pointermove || [];
  const live = moved.indexOf(true);
  const r = Object.assign(clockSummary(c), {
    n: n,
    downToFirstFrameMs: await page.evaluate(() => window.__shown != null && window.__down != null ? Math.round(window.__shown - window.__down) : null),
    startMoveMs: live >= 0 ? r1(pm[live] || 0) : null,
    followedOn1: moved.slice(live + 1, h).filter(Boolean).length + '/' + (h - live - 1),
    followedTo2: moved.slice(h).filter(Boolean).length + '/' + h,
    followed: moved.filter(Boolean).length,
    moveMaxAfterStart: r1(Math.max(0, ...pm.slice(live + 1))),
    slowest: pm.map((t, i) => [i, r1(t)]).slice(live + 1).sort((x, y) => y[1] - x[1]).slice(0, 3),
    releaseMs: r1(Math.max(0, ...(c.ev.pointerup || [0])))
  });
  r.landed = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: NSO_MICROSCOPE.takePieces().length }));
  r.copied = await page.evaluate(() => { const o = NSO_MICROSCOPE.getDoc().objects[0]; return o && o.moves ? o.moves.length : 0; });
  return r;
}

/* Plate 2: the piece just pulled, pressed and dragged n moves across its bed. */
async function plate2Drive(page, n) {
  await page.evaluate(() => { window.__grabbed = NSO_MICROSCOPE.getDoc().objects[0].name; if (NSO_MICROSCOPE.isIsolated()) NSO_MICROSCOPE.back(); });
  await frames(page);
  const p2 = await page.evaluate(() => window.__s.topPx(0));
  const pts = [];
  for (let i = 1; i <= n; i++) pts.push([p2[0] - i * 72 / n, p2[1] + i * 36 / n]);
  await page.mouse.move(p2[0], p2[1]);
  await page.evaluate(() => window.__s.start());
  await page.mouse.down();
  const moved = await drive(page, pts, true);
  await page.mouse.up();
  await frames(page);
  const c = await page.evaluate(() => window.__s.stop());
  const live = moved.indexOf(true);
  return Object.assign(clockSummary(c), {
    n: n,
    pressMs: r1((c.ev.pointerdown || [0])[0]),
    followed: moved.filter(Boolean).length,
    moveMax: r1(Math.max(0, ...(c.ev.pointermove || []).slice(live + 1))),
    releaseMs: r1(Math.max(0, ...(c.ev.pointerup || [0])))
  });
}

withApp(async (page, logs) => {
  await page.addInitScript(TIMING);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  fs.mkdirSync(OUT, { recursive: true });
  const R = { tree: TREE === ROOT_HERE ? 'this tree' : TREE, file: path.relative(ROOT_HERE, FILE), full: FULL };

  /* ---------------------------------------------------- the file: every main-thread number */
  R.moves = await openSlice(page, FILE);
  say('\n' + R.file + ' - ' + R.moves + ' moves, on ' + R.tree + (FULL ? ' (full: 60-move drags here too)' : ''));
  await page.evaluate(() => window.__s.start());
  await page.waitForTimeout(1500);
  R.idle = clockSummary(await page.evaluate(() => window.__s.stop()));
  R.orbit = await orbit(page, 60);

  /* the selection pass: the pick, a hover, a click */
  const pp = await page.evaluate(() => window.__s.piecePx());
  R.piecePx = pp && pp.map(Math.round);
  if (pp) {
    await page.evaluate(([x, y]) => window.__s.pick(x, y, 3), pp);           // warm
    const t = await page.evaluate(([x, y]) => window.__s.pick(x, y, 12), pp);
    R.pick = { med: r1(med(t)), max: r1(Math.max(...t)) };
    await page.mouse.move(pp[0] - 40, pp[1]);
    await page.evaluate(() => window.__s.start());
    for (let i = 0; i < 20; i++) { await page.mouse.move(pp[0] - 20 + i * 2, pp[1] + (i % 3)); await page.waitForTimeout(45); }
    R.hover = clockSummary(await page.evaluate(() => window.__s.stop())).ev.pointermove;
    await page.evaluate(() => window.__s.start());
    await page.mouse.click(pp[0], pp[1]);
    await frames(page);
    const ck = clockSummary(await page.evaluate(() => window.__s.stop())).ev;
    R.click = r1(['pointerdown', 'pointerup', 'click'].reduce((a, k) => a + (ck[k] ? ck[k].max : 0), 0));
    await page.evaluate(() => { NSO_MICROSCOPE.back(); if (NSO_MICROSCOPE.frame) NSO_MICROSCOPE.frame(); });
    await frames(page);
  }
  R.pull = await pullDrive(page, FULL ? 60 : 10);
  if (R.pull && R.pull.landed.pieces) R.plate2 = await plate2Drive(page, FULL ? 60 : 10);
  await page.screenshot({ path: path.join(OUT, 'speed-file.png') });

  /* ---------------------------------------------------- the small committed slice: 60-move drags, the frame rate */
  R.small = { file: path.basename(SMALL), moves: await openSlice(page, SMALL) };
  R.small.orbit = await orbit(page, 60);
  R.small.pull = await pullDrive(page, 60);
  if (R.small.pull && R.small.pull.landed.pieces) R.small.plate2 = await plate2Drive(page, 60);
  await page.screenshot({ path: path.join(OUT, 'speed-small.png') });
  R.pageErrors = logs.filter(l => /^\[pageerror\]/.test(l)).slice(0, 3);
  fs.writeFileSync(path.join(OUT, 'speed.json'), JSON.stringify(R, null, 1));
  if (JSON_ONLY) { console.log(JSON.stringify(R)); return; }

  const pullLine = (p) => 'mousedown -> first frame drawn ' + p.downToFirstFrameMs + ' ms; the move that starts it ' + p.startMoveMs + ' ms (' + p.copied +
    ' moves copied); later moves max ' + p.moveMaxAfterStart + ' ms; followed ' + p.followedOn1 + ' on plate 1, ' + p.followedTo2 + ' to plate 2; release ' + p.releaseMs + ' ms';
  const p2Line = (q) => 'press ' + q.pressMs + ' ms; followed ' + q.followed + '/' + q.n + '; moves max ' + q.moveMax + ' ms; release ' + q.releaseMs + ' ms';
  say('  idle   ' + R.idle.fps + ' fps; main viewport rendered ' + R.idle.mainRenders + 'x');
  say('  orbit  ' + R.orbit.fps + ' fps on the box\'s software GPU (' + R.orbit.frameMs + ' ms/frame); main thread ' + R.orbit.cpuPerFrame + ' ms a frame; per pointermove ' +
      JSON.stringify(R.orbit.ev.pointermove) + ' ms; main viewport rendered ' + R.orbit.mainRenders + 'x');
  say('  pick   ' + JSON.stringify(R.pick) + ' ms; hover per pointermove ' + JSON.stringify(R.hover) + ' ms; click (select + isolate) ' + R.click + ' ms');
  if (R.pull) say('  pull   ' + pullLine(R.pull));
  if (R.plate2) say('  plate2 ' + p2Line(R.plate2));
  say('\n' + R.small.file + ' - ' + R.small.moves + ' moves');
  say('  orbit  ' + R.small.orbit.fps + ' fps; main thread ' + R.small.orbit.cpuPerFrame + ' ms a frame; main viewport rendered ' + R.small.orbit.mainRenders + 'x');
  if (R.small.pull) say('  pull   ' + pullLine(R.small.pull));
  if (R.small.plate2) say('  plate2 ' + p2Line(R.small.plate2));

  say('\n=== gates ===');
  const follows = [['the small slice', R.small.pull, R.small.plate2]].concat(FULL ? [[path.basename(FILE), R.pull, R.plate2]] : []);
  follows.forEach(([nm, p, q]) => {
    check('1. drag follows the mouse (' + nm + '): the copy moved on >= 90 % of the 60 moves of the pull (plate 1, then across to plate 2)',
      p && p.followed >= 54, p && p.followed + '/60');
    check('1. ...and it landed on plate 2', p && p.landed.plate === 'take' && p.landed.pieces === 1, p && JSON.stringify(p.landed));
    check('1. ...and dragged on plate 2 it moved on >= 90 % of 60 moves', q && q.followed >= 54, q && q.followed + '/60');
  });
  if (!FULL) check('1. on ' + path.basename(FILE) + ' too, every move of the ' + (R.pull ? R.pull.n : '?') + '-move pull and plate 2 drag after the first moved the piece',
    R.pull && R.plate2 && R.pull.followed >= R.pull.n - 1 && R.plate2.followed >= R.plate2.n - 1, R.pull && R.plate2 && (R.pull.followed + '/' + R.pull.n + ', ' + R.plate2.followed + '/' + R.plate2.n));
  check('2a. orbit: the main thread\'s work per frame <= 33 ms (30 fps) on ' + path.basename(FILE), R.orbit.cpuPerFrame <= 33,
    R.orbit.cpuPerFrame + ' ms; the frame rate here is the software GPU\'s, ' + R.orbit.fps + ' fps');
  check('2b. orbit >= 30 fps where the software GPU is not the limit (' + R.small.file + ')', R.small.orbit.fps >= 30, R.small.orbit.fps + ' fps');
  check('3. the selection pass (the pick under the pointer) <= 16 ms', R.pick && R.pick.max <= 16, JSON.stringify(R.pick));
  const renders = R.idle.mainRenders + R.orbit.mainRenders + R.small.orbit.mainRenders;
  check('4. the main viewport does not render while G-scope covers it', renders === 0, renders + ' renders');
  const worst = Math.max(R.orbit.ev.pointermove.max, R.pull ? R.pull.moveMaxAfterStart : 99, R.plate2 ? R.plate2.pressMs : 99, R.plate2 ? R.plate2.moveMax : 99);
  check('5. once a piece is in hand no move holds the main thread past a frame (33 ms) - nor does a press on plate 2', worst <= 33, worst + ' ms at worst');
  const perK = R.pull && R.pull.startMoveMs != null && R.pull.copied ? r1(R.pull.startMoveMs / (R.pull.copied / 1000)) : null;
  check('6. the move that makes the copy (12 triangles a move, built and drawn) at most half d7abbea\'s: <= 7.2 ms per thousand moves copied (d7abbea: 14.4)',
    perK != null && perK <= 7.2, R.pull && (R.pull.startMoveMs + ' ms for ' + R.pull.copied + ' moves - ' + perK + ' ms per thousand'));
  check('no page error', !R.pageErrors.length, R.pageErrors.join(' | '));
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nevery gate held');
  process.exitCode = fails ? 1 : 0;
});

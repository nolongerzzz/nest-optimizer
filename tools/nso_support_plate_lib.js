/* The Supports card, run in Node: the card's own file (app-supports-card.js) and the app code it stands on
   (app-core.js, app-sel-outline.js, app-join.js), lifted into a vm with three.js and the planner's real engine files.
   Only what draws, lists or measures the screen is stubbed. Used by tools/nso_support_plate_test.js.

     const lib = require('./nso_support_plate_lib.js');
     const app = lib.makeApp({ card: 'path/to/app-supports-card.js' });   // fresh vm: a new page
     app.load(['Support Base.stl', ...]);     // the fixture's parts, laid out by the app's own placeModelMovable
     app.openCard();                          // the card's <details> opened, as a click does
     app.click('btn-sup-all');                // GENERATE
     app.frame();                             // one animation frame: the card's tick
     await app.settle();                      // the page's turn (timers)

   The planner runs in-thread (no Worker in a vm: planAway's own fallback) - the same planTree, parts and shells. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const THREE = require('three');
const NSO3MFRead = require(path.join(ROOT, 'nso-3mf-read.js'));

function fnSource(src, name, file) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('no function ' + name + ' in ' + (file || 'source'));
  let i = src.indexOf('{', a), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* app-core.js: the undo / redo lines and the geometry lifecycle (what pushUndo and the supportSwap branch of
   undoLastStep, whole, lean on), a piece's coming onto the plate, and the selection. */
const CORE = ['updateUndoBtn', 'pushUndo', 'clearUndo', 'clearRedo', 'undoLast', 'undoLastDiscard', 'undoLastStep', 'redoLast',
  'nsoGeometriesNamed', 'nsoReleaseGeometries', 'nsoPoseBakeGeometries', 'nsoLeavingGeometries', 'nsoDropRedo',
  'nsoCopyFields', 'nsoRestoreFields', 'nsoWorldFingerprint', 'nsoWorldSnapshot', 'nsoDropOutline', 'nsoWorldRestore', 'nsoUndoPoseBake',
  'addModel', 'addModelFromZUpGeometry', 'zUpToYUp', 'placeNewModel', 'placeModelMovable',
  'clearSelectionOutline', 'selectPlaced'];
const ENGINE = ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
  'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js'];

/* A page element: the properties and methods the card touches, and the listeners it adds. */
function makeDom() {
  const els = {};
  class El {
    constructor(id, tag) {
      this.id = id; this.tagName = (tag || 'DIV').toUpperCase(); this.hidden = false; this.disabled = false; this.textContent = '';
      this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.title = ''; this.open = false; this.className = '';
      this.attrs = {}; this.on = {}; this.children = []; this.firstElementChild = null; this._cls = new Set();
      const self = this;
      this.classList = {
        toggle(c, force) { const on = force === undefined ? !self._cls.has(c) : !!force; if (on) self._cls.add(c); else self._cls.delete(c); return on; },
        add(c) { self._cls.add(c); }, remove(c) { self._cls.delete(c); }, contains(c) { return self._cls.has(c); }
      };
    }
    /* a canvas the card draws its marker sprite on: every call is a no-op */
    getContext() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.on[t] = this.on[t] || []).push(fn); }
    removeEventListener(t, fn) { this.on[t] = (this.on[t] || []).filter(f => f !== fn); }
    appendChild(c) { this.children.push(c); return c; }
    set textContent(v) { this._t = v; if (v === '') this.children = []; }
    get textContent() { return this._t === undefined ? '' : this._t; }
    fire(t, ev) { (this.on[t] || []).slice().forEach(fn => fn(ev || { target: this, preventDefault() {}, stopImmediatePropagation() {} })); }
  }
  const el = id => els[id] || (els[id] = new El(id));
  for (const id of ['sup-count', 'supports-card', 'sup-progress', 'btn-sup-all', 'btn-sup-none', 'btn-sup-remove', 'sup-angle', 'sup-angle-note',
    'sup-style', 'sup-size', 'sup-rest', 'sup-rows', 'sup-hint', 'sup-tools', 'sup-tune', 'sup-tune-note', 'sup-tune-count', 'sup-tune-defaults',
    'sup-knob-tip', 'sup-knob-growth', 'sup-knob-lean', 'sup-knob-node', 'sup-plate', 'sup-plate-row', 'status', 'menu-supports',
    'sup-mode-auto', 'sup-mode-assisted', 'sup-mode-custom', 'sup-tool-tips', 'sup-tool-circles', 'sup-tool-erase']) el(id);
  els['sup-progress'].firstElementChild = new El('sup-progress-fill');
  els['sup-progress'].hidden = true;
  els['sup-angle'].value = '35'; els['sup-style'].value = 'tree'; els['sup-size'].value = '1.2';
  els['sup-plate-row'].hidden = true; els['sup-rows'].hidden = true;
  els['btn-sup-all'].disabled = true;
  const doc = {
    readyState: 'complete', activeElement: null,
    body: new El('body', 'body'),
    getElementById: id => els[id] || null,
    createElement: tag => new El(null, tag),
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {}
  };
  return { doc, el, els };
}

function makeApp(opts) {
  opts = opts || {};
  const cardFile = opts.card || path.join(ROOT, 'app-supports-card.js');
  const dom = makeDom();
  const status = [];
  const winListeners = {};
  const ticks = [];
  /* the card's clocks are Date.now(); a test that has to show a ten-minute ceiling is not waited for ten minutes: it moves the page's clock */
  const RealDate = Date, clock = { skew: 0 };
  class SkewDate extends RealDate { static now() { return RealDate.now() + clock.skew; } }
  const errors = [];                    // what the card logs with console.error (a planner that throws): kept, not printed
  const quiet = Object.assign(Object.create(console), { error: (...a) => { errors.push(a); } });
  const ctx = {
    THREE, Math, console: quiet, Object, Array, Map, Set, WeakMap, WeakSet, Number, String, JSON, Date: SkewDate, Promise, isFinite, parseFloat, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer,
    document: dom.doc, state: null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    /* the card's tick is the only animation frame the test steps by hand; every other frame (a build's first) is a turn of the page */
    requestAnimationFrame: cb => { if (cb.name === 'tick') { ticks.push(cb); return ticks.length; } return setTimeout(cb, 0); },
    cancelAnimationFrame: () => { ticks.length = 0; },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter(f => f !== fn); },
    setStatus: t => { status.push(t); dom.el('status').textContent = t; },
    performance: { now: () => Date.now() }
  };
  ctx.window = ctx;
  ['renderModelList', 'updateOptimizeButton', 'updateEditSize', 'updateAdjustUI', 'updateCutterUI', 'removeCutHelper', 'buildCutHelper', 'updateJoinUI']
    .forEach(n => { ctx[n] = () => {}; });
  const scene = new THREE.Scene(), group = new THREE.Group();
  scene.add(group);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  camera.position.set(80, 80, 120);
  ctx.state = {
    scene, modelGroup: group, camera, controls: { target: new THREE.Vector3(), update() {} }, renderer: null,
    models: [], placed: [], undoStack: [], redoStack: [], selectedIndex: -1, editId: null, plateLock: false, cutterOpen: false, cutT: 0.5
  };
  vm.createContext(ctx);

  const core = read('app-core.js'), selOutline = read('app-sel-outline.js'), join = read('app-join.js');
  vm.runInContext([
    'let nextId = 1; const UNDO_MAX = 40; const REDO_LABEL = {}, UNDO_REPLACE_LABEL = {};',
    ...CORE.map(n => fnSource(core, n, 'app-core.js')),
    fnSource(join, 'meshToWorldSoup', 'app-join.js'),
    'this.__core = { addModelFromZUpGeometry, placeModelMovable, selectPlaced, clearSelectionOutline, pushUndo, undoLast, redoLast };'
  ].join('\n'), ctx, { filename: 'app-core.js + app-join.js (lifted)' });
  /* the selection outline is app-sel-outline.js itself: it wraps selectPlaced and puts refreshOutline on window */
  vm.runInContext(selOutline, ctx, { filename: 'app-sel-outline.js' });
  for (const f of ENGINE) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext(fs.readFileSync(cardFile, 'utf8'), ctx, { filename: path.basename(cardFile) });
  const card = ctx.NSO_SUPPORTS_CARD;

  const app = {
    ctx, card, state: ctx.state, dom, status, THREE, clock, errors,
    el: dom.el,
    /* the fixture's parts, loaded the way an import loads them: addModelFromZUpGeometry, which places each beside the last */
    load(objects) {
      objects.forEach(o => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(o.positions), 3));
        const id = ctx.addModelFromZUpGeometry(o.name, g);
        if (!id) throw new Error('could not add ' + o.name);
      });
      return ctx.state.placed.map(p => p.sourceId);
    },
    realIds: () => ctx.state.placed.filter(p => p.mesh && !(ctx.state.models.find(m => m.id === p.sourceId) || {}).nsoSupport).map(p => p.sourceId),
    supportsOf: id => ctx.state.models.filter(m => m.nsoSupport && m.nsoSupport.hostSourceId === id),
    allSupports: () => ctx.state.models.filter(m => m.nsoSupport),
    modelOf: id => ctx.state.models.find(m => m.id === id),
    placedOf: id => ctx.state.placed.find(p => p.sourceId === id),
    /* a piece's soup in the card's frame (millimetres, Z up) - the one the planner and the gaps are measured in */
    soupOf(id) {
      const p = app.placedOf(id), s = ctx.meshToWorldSoup(p.mesh), out = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 3) { out[i] = s[i]; out[i + 1] = -s[i + 2]; out[i + 2] = s[i + 1]; }
      return out;
    },
    openCard() { dom.el('menu-supports').open = true; dom.el('menu-supports').fire('toggle'); },
    closeCard() { dom.el('menu-supports').open = false; dom.el('menu-supports').fire('toggle'); },
    click(id) { dom.el(id).fire('click'); },
    setPlateBox(on) { dom.el('sup-plate').checked = !!on; dom.el('sup-plate').fire('change'); },
    key(k) {
      (winListeners.keydown || []).slice().forEach(fn => fn({ key: k, target: { tagName: 'BODY' }, preventDefault() {}, stopImmediatePropagation() {} }));
    },
    /* one animation frame of the card: its tick */
    frame() { const cbs = ticks.splice(0); cbs.forEach(cb => cb()); },
    select(idx) { ctx.selectPlaced(idx); },
    undo() { ctx.undoLast(); },
    head: () => dom.el('sup-count').textContent,
    rows: () => dom.el('sup-rows').children.map(li => li.children[0]).map(b => ({ text: b.textContent, piece: b.dataset.piece, area: b.dataset.area, cls: b.className, click: () => b.fire('click') })),
    /* every selection outline in the scene, and how many each piece's mesh holds */
    outlines() {
      const per = ctx.state.placed.map(p => p.mesh ? p.mesh.children.filter(c => c.name === 'selOutline').length : 0);
      let all = 0;
      ctx.state.scene.traverse(o => { if (o.name === 'selOutline') all++; });
      return { per, all };
    },
    emissive: () => ctx.state.placed.map(p => p.mesh ? p.mesh.material.emissiveIntensity : 0),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    /* a turn of the page, until `fn` is true (or `ms` pass) */
    async until(fn, ms) {
      const t0 = Date.now();
      while (!fn()) { if (Date.now() - t0 > (ms || 600000)) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 5)); }
    },
    hashSupports(ids) {
      const h = crypto.createHash('sha256');
      let n = 0;
      (ids || app.allSupports().map(m => m.id)).forEach(id => { const s = app.soupOf(id); h.update(Buffer.from(s.buffer, s.byteOffset, s.byteLength)); n += s.length / 9; });
      return { sha: h.digest('hex'), triangles: n };
    }
  };
  return app;
}

/* the fixture's parts, as the 3MF reader hands them back */
async function readFixture(file) {
  const bytes = new Uint8Array(fs.readFileSync(file || path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf')));
  const r = await NSO3MFRead.parse3MF(bytes, { name: 'supp_ref.3mf' });
  return r.objects;
}

/* ------------------------------------------------------------------ small shapes
   For the gates that are about what the card does with a piece the planner has nothing to say about (no overhang) or
   cannot reach, not about the fixture: closed, consistently wound triangle soups in the file's own frame (Z up). */
function quad(a, b, c, d) { return [].concat(a, b, c, a, c, d); }       // a, b, c, d counter-clockwise seen from outside
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const P = (x, y, z) => [x, y, z];
  const v = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
  return [].concat(quad(v[0], v[3], v[2], v[1]), quad(v[4], v[5], v[6], v[7]), quad(v[0], v[1], v[5], v[4]),
    quad(v[1], v[2], v[6], v[5]), quad(v[2], v[3], v[7], v[6]), quad(v[3], v[0], v[4], v[7]));
}
/* a square tube along X: outer y 0..w, z 0..h; the bore inset by t. The bore's ceiling hangs over its own floor, and the
   plate cannot reach it from below. */
function tubeSoup(L, w, h, t) {
  const P = (x, y, z) => [x, y, z];
  const o = x => [P(x, 0, 0), P(x, w, 0), P(x, w, h), P(x, 0, h)], i = x => [P(x, t, t), P(x, w - t, t), P(x, w - t, h - t), P(x, t, h - t)];
  const O0 = o(0), O1 = o(L), I0 = i(0), I1 = i(L), tris = [];
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    tris.push(...quad(O0[k], O1[k], O1[n], O0[n]));        // outer wall k, seen from outside
    tris.push(...quad(I0[k], I0[n], I1[n], I1[k]));        // bore wall k, seen from inside the bore
    tris.push(...quad(O0[k], O0[n], I0[n], I0[k]));        // the frame at x = 0, facing -x
    tris.push(...quad(O1[k], I1[k], I1[n], O1[n]));        // the frame at x = L, facing +x
  }
  return tris;
}
/* a block with a closed void in it: the void's ceiling hangs, and no support can come from the plate to it */
function voidSoup(w, h, wall, voidH) {
  const out = boxSoup(0, 0, 0, w, w, h), z0 = (h - voidH) / 2, inner = boxSoup(wall, wall, z0, w - wall, w - wall, z0 + voidH);
  for (let t = 0; t < inner.length; t += 9) out.push(...inner.slice(t, t + 3), ...inner.slice(t + 6, t + 9), ...inner.slice(t + 3, t + 6));   // reversed: it faces into the void
  return out;
}
/* a slab on two legs: a bridge with a flat underside the plate reaches */
function benchSoup(L, w, h, leg) {
  return [].concat(boxSoup(0, 0, 0, leg, w, h - 2), boxSoup(L - leg, 0, 0, L, w, h - 2)).concat(boxSoup(0, 0, h - 2, L, w, h));
}
/* a closed mesh has every edge twice, once each way */
function closedAndWound(tris) {
  const edge = new Map(), key = (a, b) => a.join(',') + '>' + b.join(',');
  for (let t = 0; t < tris.length; t += 9) {
    const v = [0, 1, 2].map(k => [tris[t + 3 * k], tris[t + 3 * k + 1], tris[t + 3 * k + 2]]);
    for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3]; edge.set(key(a, b), (edge.get(key(a, b)) || 0) + 1); }
  }
  for (const [e, n] of edge) {
    const [a, b] = e.split('>');
    if (n !== 1 || edge.get(b + '>' + a) !== 1) return false;
  }
  return true;
}
const shape = (name, tris) => ({ name, positions: Float32Array.from(tris) });

module.exports = { makeApp, readFixture, fnSource, ROOT, boxSoup, tubeSoup, voidSoup, benchSoup, closedAndWound, shape };

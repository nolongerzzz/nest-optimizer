#!/usr/bin/env node
/* Bridge, driven through the real app: real index.html, real script tags, the
   real Split button, real mouse presses, drags and releases on the canvas,
   real Set and real Undo.
     node tools/nso_bridge_drive_check.js              exit 0 = every gate held
     node tools/nso_bridge_drive_check.js --shots DIR  also writes DIR/*.png
                                                       (scratch; nothing committed)

   The geometry is proven headless in tools/nso_bridge_test.js. What this file
   proves is the card on it:
     1. the button sits in Shape beside Extend, wired, its card shut;
     2. the ring: MINI_TPU_TEST split through its axis by Split, the halves set
        20 mm apart, both gaps bridged face to face by press-drag-release ->
        hover lights the face, the drag draws a line, the ghost is the soup Set
        welds, Set makes one piece, the second Set closes it into the oval;
        one Undo per Set, and two put both halves back exactly;
     3. two spheres, point to point: the string, its Ø field, one piece, Undo;
     4. two bars, edge to edge: a press near an edge lights the whole edge,
        the thickness field (its hint the default), one piece, Undo;
     5. a guard in the app: refused in words, no ghost, Set stays off;
     6. Cancel drops the pending web and keeps the card; again, closes it.
   Fixtures other than MINI_TPU_TEST are generated here into a temp directory. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
const LIBDIR = require('./nso_library_dir.js');
const L = require('./nso_bridge_testlib.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bridge-drive-'));

/* ---- in-page helpers, installed once ---- */
function installHelpers() {
  window.__br = {
    placed(id) { return state.placed.find(p => p && p.sourceId === id); },
    up(id) {
      const p = this.placed(id); p.mesh.updateMatrixWorld(true);
      const s = meshToWorldSoup(p.mesh), o = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 3) { o[i] = s[i]; o[i + 1] = -s[i + 2]; o[i + 2] = s[i + 1]; }
      return o;
    },
    bounds(s) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
      return { lo, hi };
    },
    // Move a placed piece by (dx, dz) on the plate, the way a drag does.
    nudge(id, dx, dz) {
      const p = this.placed(id);
      p.x += dx; p.z += dz; p.mesh.position.x += dx; p.mesh.position.z += dz;
      p.mesh.updateMatrixWorld(true);
    },
    look(from, at) {
      state.controls.target.set(at[0], at[1], at[2]);
      state.camera.position.set(from[0], from[1], from[2]);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
    },
    // A Z-up world point -> client pixels.
    screen(q) {
      const w = new THREE.Vector3(q[0], q[2], -q[1]).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (w.x + 1) / 2 * r.width, y: r.top + (1 - w.y) / 2 * r.height };
    },
    // Cut faces of a piece at x = X (Z up): centroid of each connected cap, by side of y.
    capCentres(id, X) {
      const s = this.up(id), byY = {};
      for (let t = 0; t < s.length / 9; t++) {
        const o = t * 9;
        if (Math.abs(s[o] - X) > 1e-3 || Math.abs(s[o + 3] - X) > 1e-3 || Math.abs(s[o + 6] - X) > 1e-3) continue;
        const cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3, cz = (s[o + 2] + s[o + 5] + s[o + 8]) / 3, k = cy > this.cyOf(id) ? 'hi' : 'lo';
        (byY[k] = byY[k] || []).push([X, cy, cz]);
      }
      const out = {};
      for (const k in byY) out[k] = byY[k].reduce((a, p) => [a[0] + p[0] / byY[k].length, a[1] + p[1] / byY[k].length, a[2] + p[2] / byY[k].length], [0, 0, 0]);
      return out;
    },
    /* Put the camera where every point lands on bare canvas (the open
       drop-down hangs over the left of it) and reads as the kind wanted: the
       look target slides left so the scene sits right of the menu. */
    frame(pts, kinds, from, at) {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (const k of [0, 4, 8, 12, 16, 20, 26, 32, 40]) for (const back of [1, 1.4, 1.9, 2.5]) {
        const f = [at[0] + (from[0] - at[0]) * back, at[1] + (from[1] - at[1]) * back, at[2] + (from[2] - at[2]) * back];
        this.look(f, at);
        const right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-k);
        this.look([f[0] + right.x, f[1] + right.y, f[2] + right.z], [at[0] + right.x, at[1] + right.y, at[2] + right.z]);
        const ok = pts.every((q, i) => {
          const s = this.screen(q);
          if (s.x < r.left + 380 || s.x > r.right - 20 || s.y < r.top + 60 || s.y > r.bottom - 20) return false;
          if (document.elementFromPoint(s.x, s.y) !== state.renderer.domElement) return false;
          const t = NSO_bridgeTargetAt({ clientX: s.x, clientY: s.y });
          return t && t.target.kind === kinds[i];
        });
        if (ok) return { k, back };
      }
      return null;
    },
    cyOf(id) { const b = this.bounds(this.up(id)); return (b.lo[1] + b.hi[1]) / 2; },
    panel() {
      const B = state.bridge || {}, el = id => document.getElementById(id);
      const kids = B.overlay ? B.overlay.children.map(c => c.userData.role + ':' + c.userData.kind) : [];
      return {
        open: !!B.open, hidden: el('bridge-panel').hidden, readout: el('bridge-readout').textContent,
        bad: el('bridge-readout').classList.contains('is-bad'), goDisabled: el('btn-bridge-go').disabled,
        diaShown: !el('bridge-dia-row').hidden, thickShown: !el('bridge-thick-row').hidden,
        thickHint: el('inp-bridge-thick').placeholder, overlay: kids, line: !!(B.line && B.line.parent),
        ghost: !!(B.ghost && B.ghost.parent), ghostTris: B.ghost ? B.ghost.geometry.attributes.position.count / 3 : 0,
        planTris: B.plan && B.plan.ok ? B.plan.web.length / 9 : 0, kind: B.plan ? B.plan.kind : null,
        planOk: !!(B.plan && B.plan.ok), reason: B.plan && !B.plan.ok ? B.plan.reason : '',
        a: B.a ? B.a.target.kind : null, b: B.b ? B.b.target.kind : null, dragging: !!B.dragging,
        ghostMat: B.ghost ? { color: B.ghost.material.color.getHex(), opacity: B.ghost.material.opacity } : null
      };
    },
    topo(id) { return NSO_Bridge.topology(this.up(id)); },
    snapshot() {
      return state.placed.filter(p => p && p.mesh).map(p => {
        const m = state.models.find(x => x.id === p.sourceId);
        return { id: p.sourceId, x: p.x, z: p.z, pos: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z],
                 raw: m && m.rawTris ? Array.from(m.rawTris).join(',') : null };
      });
    }
  };
}

const SP = (page, q) => page.evaluate(q => window.__br.screen(q), q);
// Press at a, drag in steps to b, release. Returns the panel mid-drag.
async function drag(page, a, b) {
  const A = await SP(page, a), Bp = await SP(page, b);
  await page.mouse.move(A.x, A.y);
  await page.mouse.down();
  let mid = null;
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(A.x + (Bp.x - A.x) * i / 6, A.y + (Bp.y - A.y) * i / 6);
    if (i === 3) mid = await page.evaluate(() => window.__br.panel());
  }
  await page.mouse.up();
  await page.waitForTimeout(50);
  return mid;
}
async function setAndWait(page) {
  const before = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-bridge-go');
  await page.waitForFunction(n => state.undoStack.length > n || (state.bridge && !state.bridge.busy &&
    document.getElementById('bridge-readout').classList.contains('is-bad')), before, { timeout: 60000 });
  return page.evaluate(n => state.undoStack.length > n, before);
}
const undo = page => page.evaluate(() => undoLast());
const openCard = async page => {
  await page.click('#btn-bridge');
  await page.waitForFunction(() => state.bridge && state.bridge.open, null, { timeout: 5000 });
};

withApp(async (page, logs) => {
  await page.evaluate(installHelpers);

  console.log('\n=== 1. the button: in Add (shell v3), right after Extend ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-bridge'), e = document.getElementById('btn-extend');
    const menu = b && b.closest('details');
    const rows = [...menu.querySelectorAll('.vp-row')];
    return { btn: !!b, menu: menu && menu.id, wired: b && b.dataset.nsoWired === '1', panelHidden: document.getElementById('bridge-panel').hidden,
             nearExtend: rows.indexOf(b.closest('.vp-row')) - rows.indexOf(e.closest('.vp-row')) };
  });
  check('#btn-bridge is in the Add drop-down', ui.btn && ui.menu === 'menu-add', ui.menu);
  check('...in the row under Extend', ui.nearExtend === 1, 'rows from Extend: ' + ui.nearExtend);
  check('...wired at load, its card shut', ui.wired && ui.panelHidden);

  console.log('\n=== 2. the ring: Split, halves 20 mm apart, both gaps bridged, Undo ===');
  const tpuFile = LIBDIR.libraryDir() && LIBDIR.catalogFile('MINI_TPU_TEST.stl');
  if (!tpuFile) {
    LIBDIR.skip('section 2: MINI_TPU_TEST.stl (nest-library), the ring -> oval in the app');
  } else {
    const ringId = await loadSTL(page, tpuFile);
    // The real Split: the red line at the middle along X, then #btn-cut.
    await page.evaluate(() => {
      const e = document.getElementById('cutter-tools');
      for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    });
    if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
    const cut = await page.evaluate(id => {
      const idx = state.placed.findIndex(p => p && p.sourceId === id);
      selectPlaced(idx);
      state.cutAxis = 'x';
      buildCutHelper();
      const before = state.models.map(m => m.id);
      document.getElementById('btn-cut').click();
      return { status: document.getElementById('status').textContent, halves: state.models.filter(m => !before.includes(m.id)).map(m => m.id),
               sourceGone: !state.models.some(m => m.id === id) };
    }, ringId);
    check('Split cuts the ring through its axis into two halves', cut.halves.length === 2 && cut.sourceGone, cut.status);
    if (await page.evaluate(() => typeof closeCutter === 'function' && state.cutterOpen)) await page.evaluate(() => closeCutter(false));
    // Which half is low on X; park the other with its cut faces 20 mm off the low one's.
    const lay = await page.evaluate(ids => {
      const b = ids.map(id => window.__br.bounds(window.__br.up(id)));
      const lowI = b[0].lo[0] <= b[1].lo[0] ? 0 : 1, low = ids[lowI], high = ids[1 - lowI], bl = b[lowI], bh = b[1 - lowI];
      // view z is -y: line the high half's Y centre up with the low one's
      window.__br.nudge(high, (bl.hi[0] + 20) - bh.lo[0], -(((bl.lo[1] + bl.hi[1]) / 2) - ((bh.lo[1] + bh.hi[1]) / 2)));
      const bh2 = window.__br.bounds(window.__br.up(high));
      return { low, high, cutLow: bl.hi[0], cutHigh: bh2.lo[0], dy: ((bh2.lo[1] + bh2.hi[1]) - (bl.lo[1] + bl.hi[1])) / 2,
               dz: bh2.lo[2] - bl.lo[2], ringLen: bl.hi[0] - bl.lo[0] + bh2.hi[0] - bh2.lo[0] };
    }, cut.halves);
    check('the halves stand with their cut faces 20 mm apart, lined up', Math.abs(lay.cutHigh - lay.cutLow - 20) < 1e-4 &&
      Math.abs(lay.dy) < 1e-4 && Math.abs(lay.dz) < 1e-4, 'gap ' + (lay.cutHigh - lay.cutLow).toFixed(5));
    const inputs = await page.evaluate(() => window.__br.snapshot());

    await openCard(page);
    let P = await page.evaluate(() => window.__br.panel());
    check('Bridge opens its card, the readout says what to do', P.open && !P.hidden && /Press on a face, an edge or a point/.test(P.readout), P.readout);

    for (const [gi, side] of [[1, 'hi'], [2, 'lo']]) {
      const ids = gi === 1 ? [lay.low, lay.high] : await page.evaluate(() => [state.placed[state.placed.length - 1].sourceId]);
      const capsA = await page.evaluate(([id, X]) => window.__br.capCentres(id, X), [ids[0], lay.cutLow]);
      const capsB = await page.evaluate(([id, X]) => window.__br.capCentres(id, X), [ids[ids.length - 1], lay.cutHigh]);
      const fa = capsA[side], fb = capsB[side];
      // Stand in front of the gap, 20 mm off it, so both faces are seen well.
      const mid = [(fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2, (fa[2] + fb[2]) / 2];
      const out = side === 'hi' ? 1 : -1;
      const fr = await page.evaluate(([m, out, fa, fb]) => window.__br.frame([fa, fb], ['face', 'face'], [m[0], m[2] + 6, -(m[1] + out * 20)], [m[0], m[2], -m[1]]), [mid, out, fa, fb]);
      check('gap ' + gi + ': a view with both cut faces on bare canvas', !!fr, JSON.stringify(fr));
      // Hover.
      const sA = await SP(page, fa);
      await page.mouse.move(sA.x, sA.y);
      await page.waitForTimeout(30);
      P = await page.evaluate(() => window.__br.panel());
      check('gap ' + gi + ': hovering the cut face lights it as a face and names it', P.overlay.includes('hover:face') &&
        /Under the pointer: face, 8\.0 × 1\.0 mm rectangle/.test(P.readout), P.overlay.join(',') + ' | ' + P.readout);
      await shot(page, 'ring-gap' + gi + '-hover');
      const midDrag = await drag(page, fa, fb);
      check('gap ' + gi + ': the press picks the face and the drag draws a line', midDrag && midDrag.a === 'face' && midDrag.line && midDrag.dragging,
        midDrag ? 'a ' + midDrag.a + ', line ' + midDrag.line : '');
      P = await page.evaluate(() => window.__br.panel());
      check('gap ' + gi + ': released on the other face - a band, previewed', P.planOk && P.kind === 'band' && P.a === 'face' && P.b === 'face' && !P.bad &&
        /^Band 20\.0 mm, 8\.0 × 1\.0 mm rectangle both ends/.test(P.readout), P.readout);
      check('gap ' + gi + ': the ghost is the very web Set welds, drawn as Bend\'s (amber, 0.75)', P.ghost && P.ghostTris === P.planTris && P.ghostTris === 8 &&
        P.ghostMat.color === 0xf59e0b && P.ghostMat.opacity === 0.75, P.ghostTris + ' triangles');
      check('gap ' + gi + ': Set is on; the band takes no Ø or thickness', !P.goDisabled && !P.diaShown && !P.thickShown);
      await shot(page, 'ring-gap' + gi + '-ghost');
      const nBefore = await page.evaluate(() => state.models.length);
      const did = await setAndWait(page);
      const after = await page.evaluate(() => {
        const p = state.placed[state.placed.length - 1];
        return { n: state.models.length, id: p.sourceId, name: state.models.find(m => m.id === p.sourceId).name,
                 status: document.getElementById('status').textContent, open: state.bridge.open, ghost: !!state.bridge.ghost,
                 sel: state.editId === p.sourceId };
      });
      const topo = await page.evaluate(id => window.__br.topo(id), after.id);
      check('gap ' + gi + ': Set welds - ' + (gi === 1 ? 'two pieces are one' : 'the piece closes on itself'), did &&
        after.n === nBefore - (gi === 1 ? 1 : 0) && /Bridge done/.test(after.status), after.status);
      check('gap ' + gi + ': one closed solid, ' + (gi === 1 ? 'a C (Euler 2)' : 'a ring again (Euler 0)'), topo.shells === 1 && topo.open === 0 &&
        topo.nm === 0 && topo.badWinding === 0 && topo.euler === (gi === 1 ? 2 : 0), JSON.stringify(topo));
      check('gap ' + gi + ': the card stays open for the next one, the ghost gone, the new piece selected', after.open && !after.ghost && after.sel, after.name);
    }
    const oval = await page.evaluate(() => {
      const id = state.placed[state.placed.length - 1].sourceId, s = window.__br.up(id), b = window.__br.bounds(s);
      const zm = (b.lo[2] + b.hi[2]) / 2 + 0.123;
      const loops = NSO_PathSweep.sectionLoops(s, [0, 0, zm], [0, 0, 1]);
      const per = l => { let t = 0; for (let i = 0; i < l.length; i++) { const a = l[i], c = l[(i + 1) % l.length]; t += Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]); } return t; };
      return { span: [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]], per: loops ? loops.map(per).sort((x, y) => y - x) : [] };
    });
    // The ring's own perimeters, from the headless copy of the same file.
    const ctx = L.bridgeContext(), tpu = require('./nso_stl_io.js').readSTL(tpuFile);
    const ref = ctx.NSO_PathSweep.sectionLoops(tpu, [0, 0, 0.123], [0, 0, 1]).map(l => { let t = 0; for (let i = 0; i < l.length; i++) { const a = l[i], c = l[(i + 1) % l.length]; t += Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]); } return t; }).sort((x, y) => y - x);
    check('the oval: 40 mm longer all round (outer and bore), 20 mm longer along the gap', oval.per.length === 2 &&
      Math.abs(oval.per[0] - ref[0] - 40) <= 0.02 && Math.abs(oval.per[1] - ref[1] - 40) <= 0.02 && Math.abs(oval.span[0] - 40) < 1e-3,
      'outer ' + ref[0].toFixed(3) + ' -> ' + (oval.per[0] || 0).toFixed(3) + ', bore ' + ref[1].toFixed(3) + ' -> ' + (oval.per[1] || 0).toFixed(3) +
      ', ' + oval.span.map(v => v.toFixed(3)).join(' × '));
    // the screenshot: the oval from above at an angle
    await page.evaluate(() => {
      const p = state.placed[state.placed.length - 1]; const c = p.mesh.position;
      window.__br.look([c.x + 25, c.y + 45, c.z + 45], [c.x, c.y, c.z]);
    });
    await page.mouse.move(1270, 890);
    await page.evaluate(() => { state.bridge.hover = null; NSO_bridgeDrawPicks(); });
    await shot(page, 'ring-oval');
    // Undo, twice: the second bridge, then the first - every input back.
    await undo(page);
    const mid = await page.evaluate(() => ({ n: state.models.length, status: document.getElementById('status').textContent }));
    check('one Undo takes the second bridge off (the C is back)', /Undo: Bridge reverted/.test(mid.status), mid.status);
    await undo(page);
    const back = await page.evaluate(() => window.__br.snapshot());
    const same = back.length === inputs.length && inputs.every(a => back.some(b => b.id === a.id && b.raw === a.raw && b.x === a.x && b.z === a.z &&
      b.pos.every((v, k) => v === a.pos[k])));
    check('two Undos put both halves back exactly: same pieces, same soups bit for bit, same places', same,
      back.length + ' piece(s) on the plate');
    // clear the plate for the next section
    await page.evaluate(() => { if (typeof clearPlateOnly === 'function') clearPlateOnly(); state.models = []; state.placed = []; clearUndo(); });
  }

  console.log('\n=== 3. two spheres, point to point: a string ===');
  {
    const ids = [];
    for (const [nm, c] of [['sphA', [0, 0, 8]], ['sphB', [30, 0, 8]]]) ids.push(await loadSTL(page, L.writeSTL(path.join(TMP, nm + '.stl'), L.sphere(c, 8, 32, 16))));
    await page.evaluate(ids => {
      const b = ids.map(id => window.__br.bounds(window.__br.up(id)));
      window.__br.nudge(ids[1], (b[0].lo[0] + 30) - b[1].lo[0], -(b[0].lo[1] - b[1].lo[1]));
    }, ids);
    if (!(await page.evaluate(() => state.bridge && state.bridge.open))) await openCard(page);
    const pts = await page.evaluate(ids => ids.map(id => { const b = window.__br.bounds(window.__br.up(id)); return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2]; }), ids);
    const pa = [pts[0][0] + 7.6, pts[0][1] + 0.3, pts[0][2] + 1.2], pb = [pts[1][0] - 7.6, pts[1][1] + 0.3, pts[1][2] + 1.2];
    const m = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    const fr = await page.evaluate(([m, pa, pb]) => window.__br.frame([pa, pb], ['point', 'point'], [m[0], m[2] + 30, -m[1] + 35], [m[0], m[2], -m[1]]), [m, pa, pb]);
    check('a view with both sphere points on bare canvas', !!fr, JSON.stringify(fr));
    await drag(page, pa, pb);
    let P = await page.evaluate(() => window.__br.panel());
    check('two sphere points make a string, its Ø field shown at 2', P.planOk && P.kind === 'string' && P.diaShown && !P.thickShown &&
      /^String Ø2\.0/.test(P.readout), P.readout || P.reason);
    await page.evaluate(() => { const e = document.getElementById('inp-bridge-dia'); e.value = '3'; e.dispatchEvent(new Event('change')); });
    P = await page.evaluate(() => window.__br.panel());
    check('...a new Ø re-plans it at once', P.planOk && /^String Ø3\.0/.test(P.readout), P.readout);
    await shot(page, 'spheres-string-ghost');
    const ok = await setAndWait(page);
    const r = await page.evaluate(() => {
      const id = state.placed[state.placed.length - 1].sourceId;
      return { n: state.models.length, topo: window.__br.topo(id), status: document.getElementById('status').textContent };
    });
    check('Set welds the string: two spheres are one closed solid', ok && r.n === 1 && r.topo.shells === 1 && r.topo.open === 0 && r.topo.nm === 0,
      r.status + ' ' + JSON.stringify(r.topo));
    await shot(page, 'spheres-string');
    await undo(page);
    check('Undo: both spheres back', await page.evaluate(() => state.models.length === 2 && state.placed.length === 2));
    await page.evaluate(() => { state.models = []; state.placed = []; clearDisplayMeshes(); clearUndo(); });
  }

  console.log('\n=== 4. two bars, edge to edge: a sheet ===');
  {
    const ids = [];
    ids.push(await loadSTL(page, L.writeSTL(path.join(TMP, 'barA.stl'), L.box(0, 0, 0, 60, 5, 5))));
    ids.push(await loadSTL(page, L.writeSTL(path.join(TMP, 'barB.stl'), L.box(0, 0, 0, 60, 5, 5))));
    await page.evaluate(ids => {
      const b = ids.map(id => window.__br.bounds(window.__br.up(id)));
      // B 10 mm across from A in Y (view -z), level with it in X
      window.__br.nudge(ids[1], b[0].lo[0] - b[1].lo[0], -((b[0].hi[1] + 10) - b[1].lo[1]));
    }, ids);
    if (!(await page.evaluate(() => state.bridge && state.bridge.open))) await openCard(page);
    const eg = await page.evaluate(ids => ids.map(id => window.__br.bounds(window.__br.up(id))), ids);
    const xm = (eg[0].lo[0] + eg[0].hi[0]) / 2;
    const pa = [xm, eg[0].hi[1] - 0.15, eg[0].hi[2]], pb = [xm, eg[1].lo[1] + 0.15, eg[1].hi[2]];
    const m = [xm, (pa[1] + pb[1]) / 2, pa[2]];
    const fr = await page.evaluate(([m, pa, pb]) => window.__br.frame([pa, pb], ['edge', 'edge'], [m[0] - 40, m[2] + 45, -m[1] + 25], [m[0], m[2], -m[1]]), [m, pa, pb]);
    check('a view with both bar edges on bare canvas', !!fr, JSON.stringify(fr));
    const sA = await SP(page, pa);
    await page.mouse.move(sA.x, sA.y);
    await page.waitForTimeout(30);
    let P = await page.evaluate(() => window.__br.panel());
    check('a pointer near a bar\'s top edge lights the whole edge', P.overlay.includes('hover:edge') && /Under the pointer: edge 60\.0 mm/.test(P.readout),
      P.overlay.join(',') + ' | ' + P.readout);
    await shot(page, 'bars-edge-hover');
    await drag(page, pa, pb);
    P = await page.evaluate(() => window.__br.panel());
    check('edge to edge makes a sheet, the thickness field shown, its hint the default (5 mm bars: auto 5.0)', P.planOk && P.kind === 'sheet' &&
      P.thickShown && !P.diaShown && P.thickHint === 'auto 5.0', P.readout + ' | hint ' + P.thickHint);
    await page.evaluate(() => { const e = document.getElementById('inp-bridge-thick'); e.value = '2'; e.dispatchEvent(new Event('change')); });
    P = await page.evaluate(() => window.__br.panel());
    check('...set to 2 mm, re-planned flush with the tops', P.planOk && /^Sheet 2\.0 mm thick, flush with the faces/.test(P.readout), P.readout);
    await shot(page, 'bars-sheet-ghost');
    const ok = await setAndWait(page);
    const r = await page.evaluate(() => {
      const id = state.placed[state.placed.length - 1].sourceId, s = window.__br.up(id), b = window.__br.bounds(s);
      const loops = NSO_PathSweep.sectionLoops(s, [(b.lo[0] + b.hi[0]) / 2, 0, 0], [1, 0, 0]);
      const ym = (b.lo[1] + b.hi[1]) / 2 + 0.37, zs = [];
      if (loops && loops.length === 1) {
        const l = loops[0];
        for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; if ((p[1] - ym) * (q[1] - ym) < 0) zs.push(p[2] + (q[2] - p[2]) * (ym - p[1]) / (q[1] - p[1])); }
      }
      return { n: state.models.length, topo: window.__br.topo(id), th: zs.length === 2 ? Math.abs(zs[0] - zs[1]) : NaN, top: Math.max(...zs) - b.lo[2] };
    });
    check('Set welds the sheet along both edges: one closed solid, 2.000 mm thick, its top flush with the bars\'', ok && r.n === 1 &&
      r.topo.shells === 1 && r.topo.open === 0 && Math.abs(r.th - 2) < 1e-3 && Math.abs(r.top - 5) < 1e-3,
      'thickness ' + r.th.toFixed(4) + ', top ' + r.top.toFixed(4) + ', ' + JSON.stringify(r.topo));
    await shot(page, 'bars-sheet');
    await undo(page);
    check('Undo: both bars back', await page.evaluate(() => state.models.length === 2 && state.placed.length === 2));

    console.log('\n=== 5. a guard in the app ===');
    // From A's top face (a face) to B's top edge: refused in words.
    const pf = [xm, eg[0].lo[1] + 2.5, eg[0].hi[2]];
    await drag(page, pf, pb);
    P = await page.evaluate(() => window.__br.panel());
    check('a face to an edge is refused in words, no ghost, Set off', !P.planOk && P.bad && !P.ghost && P.goDisabled &&
      /one end is an edge and the other a face/.test(P.readout), P.readout);

    console.log('\n=== 6. Cancel ===');
    await page.click('#btn-bridge-cancel');
    P = await page.evaluate(() => window.__br.panel());
    check('Cancel drops the pending web and keeps the card', P.open && !P.a && !P.b && !P.ghost && P.goDisabled);
    await page.click('#btn-bridge-cancel');
    P = await page.evaluate(() => window.__br.panel());
    check('...pressed again with nothing pending, it closes the card', !P.open && P.hidden && P.overlay.length === 0);
  }

  const errs = logs.filter(l => /\[pageerror\]|\[error\]/.test(l) && !/favicon/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });

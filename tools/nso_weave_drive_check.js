#!/usr/bin/env node
/* Weave's card (app-weave.js), driven in the real page. docs/WEAVE.md.
     node tools/nso_weave_drive_check.js        exit 0 = every gate held

   A scan-like slab (tools/nso_weave_fixture.js: a jittered grid under a spherical cap, strokes and a ring engraved 0.6 mm
   in it) looked down on. Every press is a real mouse event on the canvas, every field a real fill, every button a real
   click. X-ray is on for most of it: the card has to work through the wireframe.

     1. WEAVE sits in the left column between TEXT and PAINT; opening it arms the card (no gate); the card holds the
        Circle / Lasso switch, Radius, Grow / Shrink / Clear, Smooth / Follow, Pitch, the readout, WEAVE, REATTACH, Cancel
     2. a click cuts a circle of the Radius round the spot: the plate, its rim and the rim's corners are drawn, the
        readout says what is cut, WEAVE is on and REATTACH is off
     3. a drag sets the size by hand; Shift adds a second circle, Alt takes one away; Grow and Shrink move the edge
     4. WEAVE draws the new patch (green, wireframe) and changes nothing: not the piece, not the Undo stack
     5. REATTACH: one Undo step (weaveReplace); the app's checker finds the piece as closed as it was; the engraving is
        gone (the cap's surface at the strokes within 0.01 mm); the volume is the unengraved slab's; X-ray is still on, the
        mesh in it; one Undo puts the piece back byte for byte
     6. a lasso drawn round the slab cuts what faces the camera, through X-ray, and weaves
     7. a refusal in words, in red, the corners that stand on the work counted: a crop whose edge runs through a stroke
     8. a painted piece stands WEAVE down by name; Clear paint lets it through
     9. Escape lets go of the cut, then closes the card; another menu opened over Weave closes it; Carve armed over it
        puts it away; no page errors */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel } = require('./nso_app_harness');
const build = require('./nso_weave_fixture');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-weave-drive-'));
const fx = build({ W: 36, H: 28, cell: 0.3 }), fxPlain = build({ W: 36, H: 28, cell: 0.3, ink: false });

function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[9 * i + k], 84 + i * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}

const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const S = page => page.evaluate(() => nsoWeaveState());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const fingerprint = page => page.evaluate(() => { const s = getActiveModel().rawTris; let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a.toFixed(3); });
const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris));
const screenOf = (page, raw) => page.evaluate(r => { const p = NSO_textScreen(getActiveModel(), r); return { x: p.x, y: p.y }; }, raw);
const click = async (page, s, mods) => {
  await page.mouse.move(s.x - 3, s.y - 3);
  await page.mouse.move(s.x, s.y);
  for (const k of mods || []) await page.keyboard.down(k);
  await page.mouse.down(); await page.mouse.up();
  for (const k of mods || []) await page.keyboard.up(k);
  await page.waitForTimeout(250);
};
const drag = async (page, path_, mods) => {
  await page.mouse.move(path_[0].x, path_[0].y);
  for (const k of mods || []) await page.keyboard.down(k);
  await page.mouse.down();
  for (let i = 1; i < path_.length; i++) await page.mouse.move(path_[i].x, path_[i].y);
  await page.mouse.up();
  for (const k of mods || []) await page.keyboard.up(k);
  await page.waitForTimeout(300);
};

/* Look down on the piece, a little tilted, its middle right of the open card. */
async function lookDown(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q && q.sourceId === m.id);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    state.controls.target.copy(c);
    state.camera.position.set(c.x + 3, c.y + 78, c.z + 30);
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    const card = document.getElementById('weave-card'), menu = card && card.closest('.vp-menu-body');
    const r = menu && menu.getBoundingClientRect(), cv = state.renderer.domElement.getBoundingClientRect();
    if (r && r.width) {
      const at = () => { const v = new THREE.Vector3(b.min.x, c.y, c.z).project(state.camera); return cv.left + (v.x + 1) / 2 * cv.width; };
      for (let k = 0; k < 40 && at() < r.right + 30; k++) {
        const d = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-2);
        state.controls.target.add(d); state.camera.position.add(d); state.controls.update(); state.camera.updateMatrixWorld(true);
      }
    }
  });
  await frames(page, 2);
}
function topAt(soup, x, y) {
  let best = -Infinity;
  for (let t = 0; t < soup.length; t += 9) {
    const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    best = Math.max(best, a * A[2] + b * B[2] + c * C[2]);
  }
  return best;
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  return v / 6;
}
const defects = (page) => page.evaluate(() => { const r = NSO_Defects.locate(getActiveModel().rawTris, {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris, pierce: r.pierce }; });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 880 });
  const id = await loadSTL(page, writeSTL('engraved.stl', fx.soup));
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p && p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  const MID = [0, 0, 0];
  MID[2] = fx.base(0, 0);

  console.log('\n=== 1. the WEAVE button, and the card it opens ===');
  const place = await page.evaluate(() => {
    const t = document.getElementById('menu-weave'), sum = t && t.querySelector('summary');
    const prev = t && t.previousElementSibling, next = t && t.nextElementSibling;
    const y = el => el.querySelector('summary').getBoundingClientRect();
    return t ? { label: sum.textContent.trim(), col: t.classList.contains('vp-col-menu'), prev: prev.id, next: next.id,
      order: y(prev).top < y(t).top && y(t).top < y(next).top, sameX: Math.abs(y(prev).left - y(t).left) < 1 } : null;
  });
  check('WEAVE is a column button between TEXT and PAINT, in line with them', place && place.label === 'Weave' && place.col && place.prev === 'menu-text' && place.next === 'menu-paint' && place.order && place.sameX, JSON.stringify(place));
  await page.click('#menu-weave > summary');
  await page.waitForFunction(() => nsoWeaveState().open, null, { timeout: 5000 });
  const ids = ['btn-weave-circle', 'btn-weave-lasso', 'inp-weave-radius', 'btn-weave-grow', 'btn-weave-shrink', 'btn-weave-clear', 'btn-weave-smooth', 'btn-weave-follow',
               'inp-weave-pitch', 'weave-readout', 'btn-weave-go', 'btn-weave-attach', 'btn-weave-cancel'];
  const have = await page.evaluate(ids => ids.filter(i => !document.getElementById(i)), ids);
  let st = await S(page);
  check('opening it arms the card; it holds Circle / Lasso, Radius, Grow / Shrink / Clear, Smooth / Follow, Pitch, the readout, WEAVE, REATTACH, Cancel',
    st.open && st.mode === 'circle' && st.fit === 'smooth' && have.length === 0 && !st.go && !st.attach, 'missing ' + have.join(',') + ' ' + st.readout);
  await lookDown(page);
  await page.click('#btn-xray');
  await frames(page, 2);

  console.log('\n=== 2. a click cuts a circle of the Radius ===');
  await page.fill('#inp-weave-radius', '13');
  await click(page, await screenOf(page, [-1, 0, fx.base(-1, 0)]));
  st = await S(page);
  check('the cut is read: a patch of the surface, its outline one loop of the mesh’s own corners, drawn through X-ray (plate fill, rim lines, rim points)',
    st.patch && st.patch.ok && st.cut > 8000 && st.patch.rim > 200 && st.patch.holes === 0 && st.drawn === 3 && st.fills === 1 && /^Cut: [\d,]+ triangles/.test(st.readout), st.readout + ' · drawn ' + st.drawn);
  check('WEAVE is on, REATTACH is off', st.go && !st.attach, JSON.stringify({ go: st.go, attach: st.attach }));
  const cut13 = st.cut;

  console.log('\n=== 3. drag, add, take away, grow, shrink ===');
  await click(page, await screenOf(page, [0, 0, fx.base(0, 0)]));          // the same circle at the middle: still one cut
  const c0 = await screenOf(page, [-1, 0, fx.base(-1, 0)]), c1 = await screenOf(page, [-1 + 8, 0, fx.base(7, 0)]);
  const path_ = []; for (let i = 0; i <= 10; i++) path_.push({ x: c0.x + (c1.x - c0.x) * i / 10, y: c0.y + (c1.y - c0.y) * i / 10 });
  await drag(page, path_);
  st = await S(page);
  const r8 = st.cut;
  check('a drag out 8 mm sets the circle by hand (a cut about a third the area of the 13 mm one, replacing it)', r8 > 3000 && r8 < cut13 * 0.6 && st.patch && st.patch.ok, 'dragged ' + r8 + ' triangles, clicked ' + cut13);
  await page.fill('#inp-weave-radius', '5');
  await click(page, await screenOf(page, [-1 + 7, 0, fx.base(6, 0)]), ['Shift']);
  const added = (await S(page)).cut;
  check('Shift adds a circle that overlaps it: the cut grows (one piece)', added > r8 && (await S(page)).patch.ok, r8 + ' -> ' + added);
  await page.fill('#inp-weave-radius', '3');
  await click(page, await screenOf(page, [-1 + 11, 0, fx.base(10, 0)]), ['Alt']);
  const sub = (await S(page)).cut;
  check('Alt takes a bite off the edge', sub < added, added + ' -> ' + sub);
  await click(page, await screenOf(page, [-1 + 2, 0, fx.base(1, 0)]), ['Alt']);
  const holed = await S(page);
  check('Alt inside the cut leaves a hole (close() does not fill what was cut on purpose): two outlines', holed.cut < sub && holed.patch.ok && holed.patch.holes === 1, sub + ' -> ' + holed.cut + ', holes ' + holed.patch.holes);
  await page.click('#btn-weave-clear');
  await page.fill('#inp-weave-radius', '8');
  await click(page, await screenOf(page, [-1, 0, fx.base(-1, 0)]));
  const base8 = (await S(page)).cut;
  await page.click('#btn-weave-grow'); await frames(page, 2);
  const grown = (await S(page)).cut;
  await page.click('#btn-weave-shrink'); await frames(page, 2);
  const shrunk = (await S(page)).cut;
  check('Grow cuts a ring of triangles wider, Shrink a ring narrower', grown > base8 && shrunk < grown && shrunk >= base8 * 0.9, base8 + ' -> ' + grown + ' -> ' + shrunk);
  await page.click('#btn-weave-clear');
  st = await S(page);
  check('Clear lets go of the cut (and its drawing)', st.cut === 0 && st.drawn === 0 && !st.go, JSON.stringify({ cut: st.cut, drawn: st.drawn }));

  console.log('\n=== 4. WEAVE draws the new patch and changes nothing ===');
  await page.fill('#inp-weave-radius', '13');
  await click(page, await screenOf(page, [-1, 0, fx.base(-1, 0)]));
  const fp0 = await fingerprint(page), d0 = await undoDepth(page), soup0 = await soupOf(page);
  await page.click('#btn-weave-go');
  await page.waitForFunction(() => !nsoWeaveState().busy && nsoWeaveState().plan, null, { timeout: 60000 });
  st = await S(page);
  check('the plan is ok, drawn as a green wireframe over the plate; REATTACH is on', st.plan && st.plan.ok && st.wires === 1 && st.fills === 1 && st.attach && /^Woven:/.test(st.readout), st.readout);
  check('the weave is even, the plate’s own size and the rim kept corner for corner', st.plan.stats.angleP1 > 35 && st.plan.stats.flipped === 0 && Math.abs(st.plan.stats.edgeP50 / st.plan.stats.plateEdge - 1) < 0.1 && st.plan.stats.rimCorners === st.patch.rim,
    'p1 ' + st.plan.stats.angleP1.toFixed(1) + '°, edge ' + st.plan.stats.edgeP50.toFixed(3) + ' vs ' + st.plan.stats.plateEdge.toFixed(3));
  check('nothing is changed yet: the piece is byte for byte, the Undo stack the same', (await fingerprint(page)) === fp0 && (await undoDepth(page)) === d0);

  console.log('\n=== 5. REATTACH ===');
  const v0 = volume(soup0), vPlain = volume(fxPlain.soup);
  await page.click('#btn-weave-attach');
  await page.waitForFunction(d => state.undoStack.length > d, d0, { timeout: 20000 }).catch(() => {});
  const soup1 = await soupOf(page), dep = await defects(page);
  check('one Undo step, type weaveReplace', (await undoDepth(page)) === d0 + 1 && (await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type)) === 'weaveReplace');
  const dep0 = await page.evaluate(src => { const r = NSO_Defects.locate(new Float32Array(src), {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris, pierce: r.pierce }; }, Array.from(fx.soup));
  check('the app’s checker finds the piece exactly as closed as it was (open, non-manifold, odd, flipped, degenerate: 0; piercing unchanged)',
    dep.open === 0 && dep.nm === 0 && dep.odd === 0 && dep.flip === 0 && dep.degen === 0 && dep.pierce === dep0.pierce, JSON.stringify(dep));
  const spots = [[-8.3, 0], [-1.8, 0], [1.7, 0], [5.7, 2], [7.5, 0], [0, 9 + 2.6], [-6.5, -3.3], [-6.5, 3.3]], spotErr = spots.map(([x, y]) => Math.abs(topAt(soup1, x, y) - fx.base(x, y)));
  check('the engraving is gone: the surface at the strokes and the ring is the cap again (all ' + spots.length + ' spots within 0.01 mm)', Math.max.apply(null, spotErr) < 0.01, 'worst ' + Math.max.apply(null, spotErr).toFixed(4) + ' (was ' + Math.abs(topAt(soup0, -8.3, 0) - fx.base(-8.3, 0)).toFixed(2) + ' at the first)');
  check('the volume is the unengraved slab’s (0.5%)', Math.abs(volume(soup1) - vPlain) < 0.005 * vPlain, volume(soup1).toFixed(2) + ' vs ' + vPlain.toFixed(2) + ' (engraved ' + v0.toFixed(2) + ')');
  const xr = await page.evaluate(() => { const m = state.placed[state.placed.findIndex(p => p && p.sourceId === getActiveModel().id)].mesh; return { xray: state.xray, wire: m.material.wireframe }; });
  check('X-ray is still on and the new mesh is in it', xr.xray && xr.wire, JSON.stringify(xr));
  await page.click('#btn-undo');
  await frames(page, 3);
  check('one Undo puts the piece back byte for byte', (await fingerprint(page)) === fp0 && (await undoDepth(page)) === d0);

  console.log('\n=== 6. a lasso, through X-ray ===');
  await page.click('#btn-weave-lasso');
  // a loop that follows the surface, as a hand drawing round it does: its edges sampled on the cap, then projected
  const corners = [[-16, -13.3], [16, -13.3], [16, 13.5], [-16, 13.5]], lasso = [];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    for (let i = 0; i < 16; i++) {
      const x = a[0] + (b[0] - a[0]) * i / 16, y = a[1] + (b[1] - a[1]) * i / 16;
      lasso.push(await screenOf(page, [x, y, fx.base(x, y)]));
    }
  }
  lasso.push(lasso[0]);
  await drag(page, lasso);
  st = await S(page);
  check('a loop drawn round the slab cuts the surface facing the camera: one patch, ok, well over the 13 mm circle’s, the engraving walls taken in', st.mode === 'lasso' && st.patch && st.patch.ok && st.cut > cut13 && st.drawn === 3, st.readout + ' · cut ' + st.cut);
  await page.click('#btn-weave-go');
  await page.waitForFunction(() => !nsoWeaveState().busy && (nsoWeaveState().plan || /^Weave:/.test(nsoWeaveState().readout)), null, { timeout: 90000 });
  st = await S(page);
  check('and it weaves (the whole top, rim to rim)', st.plan && st.plan.ok && st.attach, st.readout);
  await page.click('#btn-weave-circle');
  await page.click('#btn-weave-clear');

  console.log('\n=== 7. a refusal in words: the crop’s edge through the work ===');
  await page.fill('#inp-weave-radius', '6');
  await click(page, await screenOf(page, [-4, 0, fx.base(-4, 0)]));
  await page.click('#btn-weave-go');
  await page.waitForFunction(() => !nsoWeaveState().busy, null, { timeout: 60000 });
  st = await S(page);
  check('WEAVE is refused in red, saying the crop’s edge cuts through the work and how to fix it; the corners on the work are counted; REATTACH stays off',
    !st.plan && st.bad_readout && /edge cuts through the work/.test(st.readout) && /Widen the crop/.test(st.readout) && st.bad > 0 && !st.attach, st.readout + ' · bad ' + st.bad);
  check('and the piece is untouched', (await fingerprint(page)) === fp0 && (await undoDepth(page)) === d0);
  await page.click('#btn-weave-clear');

  console.log('\n=== 8. a painted piece stands WEAVE down ===');
  await page.click('#btn-weave-cancel');
  await frames(page, 2);
  await page.click('#btn-mask-paint');
  await frames(page, 2);
  await click(page, await screenOf(page, [14, 10, fx.base(14, 10)]));
  await page.click('#btn-mask-paint');
  const painted = await page.evaluate(() => nsoMaskCount(getActiveModel()));
  await page.click('#menu-weave > summary');
  await page.waitForFunction(() => nsoWeaveState().open, null, { timeout: 5000 });
  await lookDown(page);
  await page.fill('#inp-weave-radius', '13');
  await click(page, await screenOf(page, [-1, 0, fx.base(-1, 0)]));
  const d8 = await undoDepth(page);
  await page.evaluate(() => NSO_weaveGo());
  await frames(page, 2);
  const stood = await page.evaluate(() => ({ plan: !!nsoWeaveState().plan, status: document.getElementById('status').textContent, readout: nsoWeaveState().readout }));
  check('with a face painted, WEAVE stands down and names the count; nothing is woven', painted > 0 && !stood.plan && /Weave stood down - \d+ painted face/.test(stood.status) && (await undoDepth(page)) === d8, 'painted ' + painted + ' · ' + stood.status);
  await page.click('#btn-mask-clear');
  await frames(page, 2);
  await page.click('#menu-weave > summary');
  await page.waitForFunction(() => nsoWeaveState().open, null, { timeout: 5000 });
  await lookDown(page);
  await click(page, await screenOf(page, [-1, 0, fx.base(-1, 0)]));
  await page.click('#btn-weave-go');
  await page.waitForFunction(() => !nsoWeaveState().busy && nsoWeaveState().plan, null, { timeout: 60000 }).catch(() => {});
  st = await S(page);
  check('Clear paint lets it through', st.plan && st.plan.ok, st.readout);

  console.log('\n=== 9. Escape, other menus, Carve ===');
  await page.keyboard.press('Escape');
  await frames(page, 2);
  const e1s = await S(page);
  await page.keyboard.press('Escape');
  await frames(page, 2);
  const closed = await page.evaluate(() => ({ open: nsoWeaveState().open, menu: document.getElementById('menu-weave').open, drawn: nsoWeaveState().drawn }));
  check('the first Escape lets go of the cut, the second closes the card (menu shut, nothing drawn)', e1s.open && e1s.cut === 0 && !closed.open && !closed.menu && closed.drawn === 0, JSON.stringify({ afterFirst: e1s.cut, closed }));
  await page.click('#menu-weave > summary');
  await page.waitForFunction(() => nsoWeaveState().open, null, { timeout: 5000 });
  await page.click('#menu-paint > summary');
  await frames(page, 3);
  const other = await page.evaluate(() => ({ open: nsoWeaveState().open, menu: document.getElementById('menu-weave').open }));
  check('opening Paint over Weave closes it', !other.open && !other.menu, JSON.stringify(other));
  await page.click('#menu-weave > summary');
  await page.waitForFunction(() => nsoWeaveState().open, null, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('menu-weave').open = true; });
  await page.click('#btn-carve');
  await frames(page, 4);
  const carveOver = await page.evaluate(() => ({ weave: nsoWeaveState().open, carve: !!state.carveArmed }));
  check('Carve armed over Weave puts Weave away (one click-owning tool at a time)', !carveOver.weave && carveOver.carve, JSON.stringify(carveOver));
  await page.click('#btn-carve');
  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});

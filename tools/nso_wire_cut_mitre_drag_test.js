/* The blade drag at every mitre, driven through the real app with a real mouse.
     node tools/nso_wire_cut_mitre_drag_test.js    exit 0 = every gate held

   THE BUG. A square cut drags fine; turn the mitre dial to 90 and the blade
   could barely be moved by the drag (it did not move at all at exactly 90).
   The cut position was `mm`, where the plane crosses the piece's centre line,
   and the plane's place on its own travel axis was cos(mitre) x that, so the
   pointer's travel was scaled by cos(mitre) on the way in: divided back out
   above a mitre of about 78 degrees and not at all inside it, and at 90 the
   plane crosses the centre line nowhere. It came in with the mitre dial
   (#166), not with #196 (mitre-steps) or #201 (camera-leash): this gate
   fails the same way at 6ca7251, d6d3627 and 38cf015.

   THE FIX (app-cut.js cutFrame, app-core.js cutTFromPointer). `mm` is the
   plane's distance from the low end of the piece's extent along the BLADE'S
   OWN TRAVEL AXIS (the plane's normal), and `span` that extent; square, that
   is the piece's length as before. The pointer is read on that axis with
   nothing to divide by, and turning the dial still turns the plane about the
   point where it crossed the centre line (setCutMiter).

   GATES
     1. a 100 px drag along the blade's travel axis, seen from straight above
        (equal mm per px in every direction on the plate), moves the blade
        along that axis by the square cut's travel, within 5 %, at 0, 45, 90
        and 135 degrees.
     2. the same drag from an oblique camera (40 px: 100 would run the blade
        off the end of a 70 mm width) keeps the blade point that was under
        the pointer under the pointer: screen-space correct at every mitre,
        90 included.
     3. at 90 the card's own controls move the blade too: the - / + arrows
        step it 0.1 mm along its axis, and the readout's two lengths add to
        the piece's width, the extent the blade now travels over.
     4. turning the dial keeps the plane crossing the centre line where it
        did (30 mm on the 120 mm bar), 0 -> 30 -> 60 -> 0.
     5. Cut at 90 splits the bar across its width where the blade stands.  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function box(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-mitre-drag-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const BAR = [120, 70, 12];          // long along X, 70 across: room to travel at 90
const MITRES = [0, 45, 90, 135];
const DRAG_PX = 100;
const OBLIQUE_DRAG_PX = 40;           // oblique, 100 px is more travel than the bar's width allows

const PAGE = `
window.__piece = id => (state.placed.find(p => p && p.sourceId === id) || {}).mesh || null;
/* The blade as it stands: its normal (the travel axis) and centre, world space. */
window.__blade = function () {
  if (!state.cutHelper) return null;
  const b = state.cutHelper.children.find(c => c.userData.cutBlade);
  b.updateMatrixWorld(true);
  return { n: new THREE.Vector3(0, 0, 1).transformDirection(b.matrixWorld).toArray(),
           p: new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray(),
           M: b.matrixWorld.toArray() };
};
window.__proj = function (p) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
};
/* The world point where the pixel's ray meets the blade's plane. */
window.__rayOnBlade = function (px, py) {
  const b = __blade(), r = state.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2((px - r.left) / r.width * 2 - 1, -((py - r.top) / r.height * 2 - 1));
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, state.camera);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3().fromArray(b.n), new THREE.Vector3().fromArray(b.p));
  const hit = new THREE.Vector3();
  return rc.ray.intersectPlane(plane, hit) ? hit.toArray() : null;
};
/* A world point carried with the blade: its blade-local place, then back. */
window.__toBlade = function (w) {
  const M = new THREE.Matrix4().fromArray(__blade().M);
  return new THREE.Vector3().fromArray(w).applyMatrix4(M.invert()).toArray();
};
window.__fromBlade = function (l) {
  const M = new THREE.Matrix4().fromArray(__blade().M);
  return new THREE.Vector3().fromArray(l).applyMatrix4(M).toArray();
};
window.__topDown = function () {
  const c = state.camera, t = state.controls.target;
  c.position.set(t.x, 190, t.z + 0.001);
  c.lookAt(t);
  state.controls.update();
};
/* Where the blade plane meets the piece's centre line, in mm from the low
   end of the long axis. */
window.__crossing = function (id) {
  const m = state.models.find(x => x.id === id), mesh = __piece(id);
  const bb = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const s = bb.getSize(new THREE.Vector3());
  let a = 'x'; if (s.z > s[a]) a = 'z'; if (s.y > s[a]) a = 'y';
  mesh.updateMatrixWorld(true);
  const e = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0).transformDirection(mesh.matrixWorld);
  const C = bb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  const b = __blade(), n = new THREE.Vector3().fromArray(b.n), p = new THREE.Vector3().fromArray(b.p);
  const lam = n.dot(p.clone().sub(C)) / n.dot(e);
  return s[a] / 2 + lam;
};
window.__sizes = function (ids) {
  return state.models.filter(x => ids.indexOf(x.id) >= 0).map(x => {
    x.geometry.computeBoundingBox();
    return x.geometry.boundingBox.getSize(new THREE.Vector3()).toArray();
  });
};
`;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const id = await loadSTL(page, stl('bar.stl', box(...BAR)));
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(50);
  // The first click on the piece drops the blade.
  const c0 = await page.evaluate(id => {
    const c = new THREE.Box3().setFromObject(__piece(id)).getCenter(new THREE.Vector3());
    return __proj([c.x, c.y, c.z]);
  }, id);
  await page.mouse.click(c0.x, c0.y);
  await page.waitForTimeout(50);
  check('a click on the piece drops the blade', !!(await page.evaluate(() => __blade())));

  const setMitre = async deg => {
    await page.$eval('#cut-miter-deg', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change')); }, deg);
    await page.waitForTimeout(30);
  };
  /* Blade square and back mid-piece, then the mitre typed in. */
  const reset = async deg => {
    await page.click('#btn-cut-square');
    await page.evaluate(() => { state.cutT = 0.5; setCutMiter(0); });
    await setMitre(deg);
  };
  /* A real press on the piece at the blade centre's pixel, then a real drag
     of DRAG_PX along the blade's travel axis as it looks on screen. Returns
     the blade before / after and the pixels. */
  const drag = async (px) => {
    px = px || DRAG_PX;
    const b0 = await page.evaluate(() => __blade());
    const s0 = await page.evaluate(p => __proj(p), b0.p);
    await page.mouse.move(s0.x, s0.y);
    await page.mouse.down();
    await page.waitForTimeout(30);
    const pressed = await page.evaluate(() => __blade());
    // The blade point the pointer holds at the press (carried with the blade),
    // and which way the travel axis runs on screen from THERE: perspective
    // bends it from place to place, so it is read at the held point.
    const grab = await page.evaluate(([x, y]) => {
      const q = __rayOnBlade(x, y), n = __blade().n;
      const a = __proj(q), b = __proj([q[0] + n[0] * 10, q[1] + n[1] * 10, q[2] + n[2] * 10]);
      return { hold: __toBlade(q), dx: b.x - a.x, dy: b.y - a.y };
    }, [s0.x, s0.y]);
    const l = Math.hypot(grab.dx, grab.dy), ux = grab.dx / l, uy = grab.dy / l;
    const steps = 20;
    for (let i = 1; i <= steps; i++) await page.mouse.move(s0.x + ux * px * i / steps, s0.y + uy * px * i / steps);
    const end = { x: s0.x + ux * px, y: s0.y + uy * px };
    const after = await page.evaluate(() => __blade());
    const held = await page.evaluate(l => __proj(__fromBlade(l)), grab.hold);
    await page.mouse.up();
    return { b0, pressed, after, end, held };
  };

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. ' + DRAG_PX + ' px along the travel axis, from straight above: the same travel at every mitre ===');
  await page.evaluate(() => __topDown());
  await page.waitForTimeout(100);
  const travel = {};
  for (const deg of MITRES) {
    await reset(deg);
    const r = await drag();
    const d = sub(r.after.p, r.pressed.p);
    const along = dot(d, r.pressed.n);
    travel[deg] = Math.abs(along);
    check(deg + ' deg: the drag moved the blade along its normal (' + along.toFixed(2) + ' mm of ' + len(d).toFixed(2) + ' mm)',
      len(d) > 1 && Math.abs(Math.abs(along) - len(d)) < 0.02 * len(d));
  }
  for (const deg of MITRES.slice(1)) {
    check(deg + ' deg: blade travel ' + travel[deg].toFixed(2) + ' mm is within 5% of the square cut\'s ' + travel[0].toFixed(2) + ' mm',
      travel[0] > 1 && Math.abs(travel[deg] - travel[0]) <= 0.05 * travel[0]);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. an oblique camera, ' + OBLIQUE_DRAG_PX + ' px: the blade point under the pointer stays under it ===');
  await page.evaluate(() => { state.controls.reset && state.controls.reset(); });
  await page.evaluate(() => { const c = state.camera, t = state.controls.target; c.position.set(t.x + 90, 110, t.z + 160); c.lookAt(t); state.controls.update(); });
  await page.waitForTimeout(100);
  for (const deg of MITRES) {
    await reset(deg);
    const r = await drag(OBLIQUE_DRAG_PX);
    const moved = len(sub(r.after.p, r.pressed.p));
    const off = Math.hypot(r.held.x - r.end.x, r.held.y - r.end.y);
    check(deg + ' deg: the blade moved (' + moved.toFixed(1) + ' mm) and the held point is ' + off.toFixed(2) + ' px from the pointer',
      moved > 1 && off <= 2);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. at 90 the arrows and the readout work on the blade\'s axis ===');
  await reset(90);
  const before = await page.evaluate(() => ({ b: __blade(), mm: getCutMm(), span: getCutSpan(getActiveModel()) }));
  await page.click('#btn-cut-nudge-p');
  const after = await page.evaluate(() => ({ b: __blade(), mm: getCutMm(), readout: document.getElementById('cut-readout').textContent }));
  const step = sub(after.b.p, before.b.p);
  check('the span the blade travels is the bar\'s width (' + BAR[1] + ' mm): ' + before.span.toFixed(2), Math.abs(before.span - BAR[1]) < 0.01);
  check('the blade starts mid-width: ' + before.mm + ' mm', Math.abs(before.mm - BAR[1] / 2) < 0.06);
  check('one arrow press moved the blade 0.1 mm along its axis (' + len(step).toFixed(3) + ' mm)',
    Math.abs(len(step) - 0.1) < 0.005 && Math.abs(Math.abs(dot(step, after.b.n)) - len(step)) < 1e-6);
  check('the readout\'s two lengths add to the width: ' + after.readout,
    after.readout.indexOf(after.mm.toFixed(1) + ' mm | ' + (BAR[1] - after.mm).toFixed(1) + ' mm') >= 0);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. turning the dial keeps the crossing on the centre line ===');
  await reset(0);
  await page.$eval('#cut-mm', el => { el.value = '30'; el.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(30);
  const at0 = await page.evaluate(id => __crossing(id), id);
  check('square, the blade stands at 30 mm: ' + at0.toFixed(2), Math.abs(at0 - 30) < 0.06);
  for (const deg of [30, 60, 0]) {
    await setMitre(deg);
    const x = await page.evaluate(id => __crossing(id), id);
    check(deg + ' deg: the plane crosses the centre line at ' + x.toFixed(2) + ' mm (30)', Math.abs(x - 30) < 0.1);
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. Cut at 90 splits the bar across its width where the blade is ===');
  await reset(90);
  await page.$eval('#cut-mm', el => { el.value = '25'; el.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(30);
  const mm5 = await page.evaluate(() => getCutMm());
  const ids0 = await page.evaluate(() => state.models.map(m => m.id));
  await page.click('#btn-cut');
  await page.waitForTimeout(200);
  const fresh = await page.evaluate(ids0 => state.models.map(m => m.id).filter(i => ids0.indexOf(i) < 0), ids0);
  check('Cut made two pieces', fresh.length === 2, await page.evaluate(() => document.getElementById('status').textContent));
  if (fresh.length === 2) {
    const sz = await page.evaluate(ids => __sizes(ids), fresh);
    // Display frame: x along the bar, y up, z across.
    check('both keep the bar\'s length and thickness',
      sz.every(s => Math.abs(s[0] - BAR[0]) < 0.01 && Math.abs(s[1] - BAR[2]) < 0.01), JSON.stringify(sz.map(s => s.map(v => +v.toFixed(2)))));
    const widths = sz.map(s => s[2]).sort((a, b) => a - b);
    check('the widths add to the bar\'s ' + BAR[1] + ' mm and split at the blade (' + mm5 + ' mm)',
      Math.abs(widths[0] + widths[1] - BAR[1]) < 0.01 && Math.abs(Math.min(mm5, BAR[1] - mm5) - widths[0]) < 0.06,
      widths.map(v => v.toFixed(2)).join(' + '));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

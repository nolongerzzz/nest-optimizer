#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_blockers_drive_check.mjs   (npm run support:blockers-drive)
 *
 * SUPPORTS BLOCKERS (app-support-blockers.js, docs/SUPPORT-BLOCKERS.md) and SLICE AND PREVIEW (the Supports card's last button),
 * driven in headless Chromium at 1280 x 800 with real clicks, drags and keys on the page. The piece is a bridge: a 60 x 30 slab
 * on two 8 mm legs, its flat underside at 18 mm. (support:blockers holds what the card does with the boxes, in Node.)
 *
 *   1  THE BUTTON. SUPPORTS BLOCKER is on the card; pressed, it puts a box on the plate - round the selected piece's middle, a third of
 *      its size - and picks it (six handles, one on each face), says how many and how big, and is one Undo step. The boxes are drawn
 *      only while the card is open, and are there when it is opened again.
 *   2  THE RIGHT-CLICK MENU. "Add Supports Blocker..." is in the menu, enabled on the bare plate and on a piece. On the plate it opens
 *      the card and stands a box on the plate where the click was; on the piece it centres the box on the point of the piece clicked.
 *   3  MOVE. A real drag on the box moves it across the plate (its height is kept); Shift moves it up and down; Escape in the middle
 *      puts it back; the card is told once, at the release. One Undo each, however long the drag.
 *   4  STRETCH. A real drag on a face's handle moves that face and leaves the opposite one where it is; a box does not go under 1 mm.
 *   5  MANY, OVERLAPPING. A second box over the first is one area with it ("2 blockers - 1 area"); a far one is another.
 *   6  WHAT THE BOXES DO. A box across the underside: the card says "N spots blocked", GENERATE builds, no support vertex is inside any
 *      box (the sheet and the trunks keep out of it). A box moved off it gives the spots back.
 *   7  DELETE, CLEAR, UNDO. Delete (the key, with a box picked, and the button) takes the box and not the piece; Clear takes all; Undo
 *      puts each back. A click on nothing puts the pick away.
 *   8  SLICE AND PREVIEW. The button at the bottom of the card slices the plate (the Slice card's slice: its stage line on the card's
 *      own) and opens the slice in G-scope on the Slice side; the Slice card is as it was (its four controls, its readout holding
 *      the same slice, Export enabled); the supports card is put away. A plate with nothing on it is refused in words.
 *   9  G-SCOPE'S EXPORT after Slice and Preview. The Export button is live; its card has "This slice - whole plate" (Export .gcode.3mf, Export
 *      .3mf) and, with something selected, "This slice - selected" (Selected .gcode.3mf, Selected .3mf). Real downloads, taken apart: the plate's
 *      .gcode.3mf is the file G-scope shows, its .3mf holds every object (the part, its support, a second piece); a selection of the second piece
 *      alone is a .3mf of that one object and a .gcode.3mf sliced again without the support.
 *  10  No page errors.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'ok     ' : 'FAILED ') + name + (!ok && detail !== undefined ? '  (' + detail + ')' : ''));
}
const SHOTS = join(ROOT, 'tools', 'supports-blockers-out');
const W = 1280, H = 800;

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return o;
}
function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return Array.from(b);
}
/* the bridge: legs 8 wide, 18 tall, a slab 2 thick on them: 60 x 30 x 20 */
const BENCH = stl([].concat(box([0, 0, 0], [8, 30, 18]), box([52, 0, 0], [60, 30, 18]), box([0, 0, 18], [60, 30, 20])));

const CUBE = stl(box([0, 0, 0], [12, 12, 12]));
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  let cdn = [];

  async function freshPage() {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    cdn = cdn.concat(routeCdn(page));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD && !!window.NSO_SUPPORT_BLOCKERS, null, { timeout: 30000 });
    await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [['bridge.stl', BENCH]]);
    await page.waitForFunction(() => state.models.length === 1 && state.placed.length === 1, null, { timeout: 30000 });
    return page;
  }

  const page = await freshPage();
  const B = () => page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.list());
  const VIEW = () => page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.view());
  const depth = () => page.evaluate(() => state.undoStack.length);
  const line = () => page.evaluate(() => document.getElementById('sup-count').textContent);
  const readout = () => page.evaluate(() => document.getElementById('sup-blocker-read').textContent);
  const pieces = () => page.evaluate(() => state.placed.filter((p) => p.mesh && !state.models.find((m) => m.id === p.sourceId).nsoSupport).length);
  const idle = () => page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
  const shot = async (file) => { await frames(page); await page.screenshot({ path: join(SHOTS, file) }); console.log('       ' + file); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  /** Look at world point `at` (Z up) from direction `d` at `dist`: a view where the bridge, the plate and the boxes are in the clear. */
  async function look(at, d, dist) {
    await page.evaluate(([at, d, dist]) => {
      const L = Math.hypot(d[0], d[1], d[2]), c = new THREE.Vector3(at[0], at[2], -at[1]);
      state.controls.target.copy(c);
      state.camera.position.set(c.x + d[0] / L * dist, c.y + d[2] / L * dist, c.z - d[1] / L * dist);
      state.camera.updateProjectionMatrix(); state.controls.update(); state.camera.updateMatrixWorld();
    }, [at, d, dist]);
    await frames(page);
  }
  const bounds = await page.evaluate(() => { const b = new THREE.Box3().setFromObject(state.placed[0].mesh); return { lo: [b.min.x, -b.max.z, b.min.y], hi: [b.max.x, -b.min.z, b.max.y] }; });
  const cx = (bounds.lo[0] + bounds.hi[0]) / 2, cy = (bounds.lo[1] + bounds.hi[1]) / 2;
  await look([cx, cy, 10], [0.3, -1, 1.1], 150);
  const screenOf = (id, face) => page.evaluate(([id, face]) => window.NSO_SUPPORT_BLOCKERS.screenOf(id, face), [id, face]);
  const plateXY = (x, y, z = 0) => page.evaluate(([x, y, z]) => {
    const v = new THREE.Vector3(x, z, -y).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, [x, y, z]);
  const drag = async (a, b, { steps = 8, shift = false, keep = false } = {}) => {
    await page.mouse.move(a.x, a.y);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    if (!keep) { await page.mouse.up(); if (shift) await page.keyboard.up('Shift'); }
    await frames(page);
  };

  /* ---------------------------------------------------------------- 1 */
  console.log('\n--- 1 the button');
  await page.click('#menu-supports > summary');
  await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD.view().host, null, { timeout: 30000 });
  await frames(page);
  check('the card has SUPPORTS BLOCKER, Delete and Clear; Delete and Clear are off with none', await page.evaluate(() => {
    const t = (id) => document.getElementById(id);
    return t('sup-blocker-add').textContent === 'Supports Blocker' && t('sup-blocker-delete').disabled && t('sup-blocker-clear').disabled && !t('sup-blocker-add').disabled;
  }));
  check('...and Slice and Preview is its last button', await page.evaluate(() => {
    const card = document.getElementById('supports-card'), btns = [...card.querySelectorAll('button')].filter((b) => !b.hidden);
    return btns[btns.length - 1].id === 'btn-sup-slice' && btns[btns.length - 1].textContent === 'Slice and Preview';
  }));
  check('the card is open on the piece: one area, nothing blocked', (await line()) === '1 hanging area at 35° on bridge', await line());
  const d0 = await depth();
  await page.click('#sup-blocker-add');
  await frames(page);
  let boxes = await B();
  check('one box', boxes.length === 1, JSON.stringify(boxes));
  const b1 = boxes[0];
  check('...round the piece\'s middle, a third of its size (20 mm)', b1 && near(b1.c[0], cx, 0.6) && near(b1.c[1], cy, 0.6) && near(b1.c[2], 10, 0.6) && b1.h.every((h) => near(h, 10, 0.01)), JSON.stringify(b1));
  check('...drawn, picked, with a handle on each of its six faces', JSON.stringify(await VIEW()) === JSON.stringify({ drawn: true, boxes: 1, handles: 6, picked: b1.id, dragging: false }), JSON.stringify(await VIEW()));
  check('...the card says so: how many, how big, where', (await readout()) === '1 blocker · picked 20 × 20 × 20 mm at x ' + Math.round(b1.c[0] * 10) / 10 + ', y ' + Math.round(b1.c[1] * 10) / 10 + ', z ' + Math.round(b1.c[2] * 10) / 10, await readout());
  check('...and it is one Undo step; Delete is on now', (await depth()) === d0 + 1 && !(await page.evaluate(() => document.getElementById('sup-blocker-delete').disabled)));
  await shot('01-button.png');
  await page.click('#menu-supports > summary');
  await frames(page);
  check('shut, the card draws no box; the box is still on the plate', !(await VIEW()).drawn && (await B()).length === 1);
  await page.click('#menu-supports > summary');
  await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD.view().host, null, { timeout: 30000 });
  await frames(page);
  check('opened again, it is drawn again', (await VIEW()).drawn && (await VIEW()).boxes === 1);

  /* ---------------------------------------------------------------- 2 */
  console.log('\n--- 2 the right-click menu');
  // a spot of bare plate, in front of the bridge
  const bare = await plateXY(cx, bounds.lo[1] - 25);
  await page.mouse.click(bare.x, bare.y, { button: 'right' });
  await frames(page);
  const item = await page.evaluate(() => { const e = document.getElementById('ctx-support-blocker'); return e ? { text: e.textContent, disabled: e.disabled, shown: !document.getElementById('ctx-menu').classList.contains('hidden') } : null; });
  check('the menu has "Add Supports Blocker...", enabled, on the bare plate', item && item.text === 'Add Supports Blocker...' && !item.disabled && item.shown, JSON.stringify(item));
  const d1 = await depth();
  await page.click('#ctx-support-blocker');
  await frames(page);
  boxes = await B();
  check('...pressed, a second box stands on the plate where the click was', boxes.length === 2 && near(boxes[1].c[0], cx, 3) && near(boxes[1].c[1], bounds.lo[1] - 25, 3) && near(boxes[1].c[2] - boxes[1].h[2], 0, 0.01), JSON.stringify(boxes[1]));
  check('...the card is open and it is picked, one Undo', (await page.evaluate(() => document.getElementById('menu-supports').open)) && (await VIEW()).picked === boxes[1].id && (await depth()) === d1 + 1);
  // on the piece: a point on the slab's top
  const top = await plateXY(cx, cy, 20);
  await page.mouse.click(top.x, top.y, { button: 'right' });
  await frames(page);
  await page.click('#ctx-support-blocker');
  await frames(page);
  boxes = await B();
  check('on the piece it is centred on the point clicked (the slab\'s top, z = 20)', boxes.length === 3 && near(boxes[2].c[2], 20, 0.8) && near(boxes[2].c[0], cx, 3), JSON.stringify(boxes[2]));
  await shot('02-menu.png');
  for (let k = 0; k < 2; k++) await page.evaluate(() => undoLast());
  await frames(page);
  check('two Undos take those two away', (await B()).length === 1);

  /* ---------------------------------------------------------------- 3 */
  console.log('\n--- 3 move');
  // drag the first box by its middle across the plate
  const id1 = (await B())[0].id;
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.select(id), id1);
  await frames(page);
  const was = (await B())[0];
  const from = await screenOf(id1);
  const d2 = await depth();
  await drag(from, { x: from.x + 90, y: from.y });
  let now = (await B())[0];
  check('a drag on the box moves it across the plate: x changed, y about the same, height kept', now.c[0] > was.c[0] + 5 && near(now.c[2], was.c[2], 1e-6) && near(now.h[0], was.h[0], 1e-9), JSON.stringify([was.c, now.c]));
  check('...one Undo step for the whole drag', (await depth()) === d2 + 1);
  await page.evaluate(() => undoLast());
  await frames(page);
  now = (await B())[0];
  check('...Undo puts it back where it was', near(now.c[0], was.c[0], 1e-6) && near(now.c[1], was.c[1], 1e-6));
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.select(id), id1);
  const f2 = await screenOf(id1);
  await drag(f2, { x: f2.x, y: f2.y - 60 }, { shift: true });
  now = (await B())[0];
  check('Shift moves it up and down: z changed, x and y kept', now.c[2] > was.c[2] + 3 && near(now.c[0], was.c[0], 1e-6) && near(now.c[1], was.c[1], 1e-6), JSON.stringify(now.c));
  await page.evaluate(() => undoLast());
  const f3 = await screenOf(id1);
  const dS = await depth();
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.select(id), id1);
  await drag(f3, { x: f3.x + 70, y: f3.y + 10 }, { keep: true });
  const mid = (await B())[0];
  check('mid-drag the card is not asked: the box on the plate is where the press found it (the draft is the view\'s)', near(mid.c[0], was.c[0], 1e-6) && (await VIEW()).dragging);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await frames(page);
  now = (await B())[0];
  check('Escape in the middle puts it back, and there is no Undo step', near(now.c[0], was.c[0], 1e-6) && (await depth()) === dS && !(await VIEW()).dragging);
  await page.mouse.move(10, 10);

  /* ---------------------------------------------------------------- 4 */
  console.log('\n--- 4 stretch');
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.select(id), id1);
  await frames(page);
  const w0 = (await B())[0], hx = await screenOf(id1, 'x+');
  const d3 = await depth();
  await drag(hx, { x: hx.x + 60, y: hx.y });
  now = (await B())[0];
  check('the x+ handle dragged out stretches the box that way: x half-size grew, the x- face stayed', now.h[0] > w0.h[0] + 2 && near(now.c[0] - now.h[0], w0.c[0] - w0.h[0], 1e-6) && near(now.h[1], w0.h[1], 1e-9) && near(now.h[2], w0.h[2], 1e-9), JSON.stringify([w0, now]));
  check('...one Undo step', (await depth()) === d3 + 1);
  const hz = await screenOf(id1, 'z+');
  await drag(hz, { x: hz.x, y: hz.y - 40 });
  const t1 = (await B())[0];
  check('the z+ handle dragged up makes it taller, its floor staying', t1.h[2] > now.h[2] + 2 && near(t1.c[2] - t1.h[2], now.c[2] - now.h[2], 1e-6), JSON.stringify([now.c, t1.c, t1.h]));
  // push the x+ handle through the other side: not under 1 mm
  const hxx = await screenOf(id1, 'x+'), hxm = await screenOf(id1, 'x-');
  await drag(hxx, { x: hxm.x - 200, y: hxm.y });
  const tiny = (await B())[0];
  check('pulled past the opposite face it stops at 1 mm', near(2 * tiny.h[0], 1, 1e-6), JSON.stringify(tiny.h));
  await page.evaluate(() => { for (let k = 0; k < 3; k++) undoLast(); });
  await frames(page);
  check('three Undos give the first box back', near((await B())[0].h[0], 10, 1e-6) && near((await B())[0].h[2], 10, 1e-6));
  await shot('04-stretch.png');

  /* ---------------------------------------------------------------- 5 */
  console.log('\n--- 5 many, overlapping');
  await page.evaluate((id) => { window.NSO_SUPPORT_BLOCKERS.set(id, { c: [0, 0, 5], h: [5, 5, 5] }); }, id1);
  await page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.add({ at: [4, 0, 5], size: 10 }));
  await frames(page);
  check('two boxes that overlap read as one area', (await readout()).startsWith('2 blockers · 1 area'), await readout());
  await page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.add({ at: [80, 80, 5], size: 10 }));
  await frames(page);
  check('...a far one is another area', (await readout()).startsWith('3 blockers · 2 areas'), await readout());
  check('...and the module says the same', (await page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.areas().map((g) => g.length))).join() === '2,1');
  await page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.clear());
  await frames(page);
  check('Clear takes them all', (await B()).length === 0 && (await readout()) === '');
  await page.evaluate(() => undoLast());
  await frames(page);
  check('...and one Undo puts all three back', (await B()).length === 3);
  await page.evaluate(() => { while (window.NSO_SUPPORT_BLOCKERS.list().length) window.NSO_SUPPORT_BLOCKERS.remove(window.NSO_SUPPORT_BLOCKERS.list()[0].id); });

  /* ---------------------------------------------------------------- 6 */
  console.log('\n--- 6 what the boxes do');
  const base = await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().beacons.length);
  // a box across the middle of the underside, the whole depth of the bridge
  const mid2 = (await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().beacons[0].p[2]));
  const X = [cx - 6, cx + 6];
  const added = await page.evaluate(([x0, x1, z, y0, y1]) => window.NSO_SUPPORT_BLOCKERS.add({ at: [(x0 + x1) / 2, (y0 + y1) / 2, z], size: [x1 - x0, y1 - y0, 6] }), [X[0], X[1], mid2, bounds.lo[1] - 5, bounds.hi[1] + 5]);
  await frames(page); await frames(page);
  const blockedN = await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().beacons.length);
  check('the spots inside are not on the card; the line says how many are blocked', blockedN < base && (await line()) === '1 hanging area at 35° on bridge · ' + (base - blockedN) + ' spots blocked', (await line()) + ' / ' + base + ' -> ' + blockedN);
  await shot('06-box-across.png');
  await page.click('#btn-sup-all');
  await idle();
  await frames(page);
  check('GENERATE builds', /^Built: 1 support/.test(await line()), await line());
  const inside = await page.evaluate(() => {
    const out = []; let n = 0;
    for (const m of state.models.filter((q) => q.nsoSupport)) {
      const p = state.placed.find((q) => q.sourceId === m.id), s = meshToWorldSoup(p.mesh);
      for (let i = 0; i < s.length; i += 3) {
        const x = s[i], y = -s[i + 2], z = s[i + 1]; n++;
        for (const b of window.NSO_SUPPORT_BLOCKERS.list()) {
          if (Math.abs(x - b.c[0]) < b.h[0] - 1e-3 && Math.abs(y - b.c[1]) < b.h[1] - 1e-3 && Math.abs(z - b.c[2]) < b.h[2] - 1e-3) out.push([x, y, z]);
        }
      }
    }
    return { n, inside: out.length };
  });
  check('no vertex of any support is inside the box', inside.n > 1000 && inside.inside === 0, JSON.stringify(inside));
  await shot('06-built.png');
  const dB = await depth();
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.set(id, { c: [500, 500, 5] }), added.id);
  await frames(page); await frames(page);
  check('the box moved off the piece gives the spots back (and blocks none)', (await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().beacons.length)) === base && !/blocked/.test(await line()), await line());
  void dB;

  /* ---------------------------------------------------------------- 7 */
  console.log('\n--- 7 delete, clear, undo');
  const keep = await pieces();
  await page.evaluate(() => window.NSO_SUPPORT_BLOCKERS.add({ at: [0, 0, 5], size: 10 }));
  const n0 = (await B()).length;
  const d4 = await depth();
  await page.keyboard.press('Delete');
  await frames(page);
  check('Delete, with a box picked, takes the box and not the piece', (await B()).length === n0 - 1 && (await pieces()) === keep, (await B()).length + ' boxes, ' + (await pieces()) + ' pieces');
  check('...one Undo step', (await depth()) === d4 + 1);
  await page.evaluate(() => undoLast());
  await frames(page);
  check('...Undo puts the box back', (await B()).length === n0);
  await page.click('#sup-blocker-delete');
  await frames(page);
  check('the Delete button does the same', (await B()).length === n0 - 1);
  await page.evaluate(() => undoLast());
  await page.evaluate((id) => window.NSO_SUPPORT_BLOCKERS.select(id), (await B())[0].id);
  const quiet = await page.evaluate(() => { const r = state.renderer.domElement.getBoundingClientRect(); return { x: r.right - 50, y: r.top + r.height * 0.4 }; });
  await page.mouse.click(quiet.x, quiet.y);       // a click on bare view, away from the piece and the boxes
  await frames(page);
  check('a click on nothing puts the pick away (Delete is off)', (await VIEW()).picked === null && (await page.evaluate(() => document.getElementById('sup-blocker-delete').disabled)));
  await page.click('#sup-blocker-clear');
  await frames(page);
  check('Clear takes every box off in one step', (await B()).length === 0);

  /* ---------------------------------------------------------------- 8 */
  console.log('\n--- 8 slice and preview');
  // the bridge's supports, to slice with it
  await page.click('#btn-sup-all');
  await idle();
  // a second, plain piece: so that a selection is not the whole plate
  await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [['cube.stl', CUBE]]);
  await page.waitForFunction(() => state.placed.filter((p) => !state.models.find((m) => m.id === p.sourceId).nsoSupport).length === 2, null, { timeout: 30000 });
  const cubeAt = await page.evaluate(() => { const p = state.placed.find((q) => state.models.find((m) => m.id === q.sourceId).name === 'cube'); const b = new THREE.Box3().setFromObject(p.mesh); return { x: (b.min.x + b.max.x) / 2, y: -(b.min.z + b.max.z) / 2, z: (b.min.y + b.max.y) / 2 }; });
  const sliceUi = await page.evaluate(() => ({ go: document.getElementById('btn-slice-go').textContent, exp: document.getElementById('btn-slice-export').disabled, prev: document.getElementById('btn-slice-preview').disabled }));
  check('before: the Slice card has not been used (Export and Preview are off)', sliceUi.exp && sliceUi.prev && sliceUi.go === 'Slice');
  await page.click('#btn-sup-slice');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.sliceBusy(), null, { timeout: 5000 });
  await frames(page);
  const during = await page.evaluate(() => ({
    text: document.getElementById('btn-sup-slice').textContent, off: document.getElementById('btn-sup-slice').disabled,
    cancel: !document.getElementById('btn-sup-slice-cancel').hidden, line: document.getElementById('sup-slice-line').textContent,
    gen: document.getElementById('btn-sup-all').disabled
  }));
  check('slicing: the button says so and is off, Cancel shows, the line is the Slice card\'s stage line, Generate is off',
    during.text === 'Slicing…' && during.off && during.cancel && /^(Loading the|Slicing|Writing)/.test(during.line) && during.gen, JSON.stringify(during));
  await shot('08-slicing.png');
  await page.waitForFunction(() => window.NSO_MICROSCOPE && window.NSO_MICROSCOPE.isOpen() && !window.NSO_SUPPORTS_CARD.sliceBusy(), null, { timeout: 240000 });
  await frames(page);
  const after = await page.evaluate(() => ({
    side: window.NSO_MICROSCOPE.cardSide(), card: document.getElementById('menu-supports').open,
    exp: document.getElementById('btn-slice-export').disabled, prev: document.getElementById('btn-slice-preview').disabled,
    readout: document.getElementById('slice-readout').textContent, cancel: document.getElementById('btn-slice-cancel').hidden,
    buttons: ['btn-slice-go', 'btn-slice-cancel', 'btn-slice-export', 'btn-slice-preview'].map((i) => !!document.getElementById(i)),
    pieces: state.placed.length
  }));
  check('G-scope opened on the Slice side with the slice loaded', after.side === 'slice', JSON.stringify(after));
  check('...the supports card is put away', !after.card);
  check('...the Slice card is as it was: its four controls, its readout holding this slice, Export and Preview on', after.buttons.every(Boolean) && !after.exp && !after.prev && /layers/.test(after.readout) && /support/.test(after.readout) && after.cancel, after.readout);
  check('...nothing was added to the plate (the bridge, its support, the cube)', after.pieces === 3, String(after.pieces));
  await shot('08-gscope.png');

  /* ---------------------------------------------------------------- 9 */
  console.log('\n--- 9 G-scope export');
  const exp0 = await page.evaluate(() => { const b = document.getElementById('ms-nav-export'); return { off: b.disabled }; });
  check('the Export button is live on the slice', exp0.off === false, JSON.stringify(exp0));
  await page.click('#ms-nav-export');
  await frames(page);
  const rows = () => page.evaluate(() => ['ms-plate-export-row', 'ms-sel-export-row'].map((i) => getComputedStyle(document.getElementById(i)).display !== 'none' && getComputedStyle(document.getElementById(i).parentElement).display !== 'none'));
  check('its card shows "whole plate" with .gcode.3mf and .3mf, and no "selected" row with nothing selected', JSON.stringify(await rows()) === '[true,false]', JSON.stringify(await rows()));
  const save = async (sel) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click(sel)]);
    const path = join(SHOTS, 'dl-' + dl.suggestedFilename().replace(/[^\w.-]+/g, '_'));
    await dl.saveAs(path);
    const { readFile } = await import('node:fs/promises');
    return { name: dl.suggestedFilename(), bytes: Array.from(await readFile(path)) };
  };
  const inspect = (bytes) => page.evaluate(async (bytes) => {
    const zip = NSO3MFRead.openZip(new Uint8Array(bytes)), names = zip.names();
    const out = { sliced: NSO_MICROSCOPE.isSliced(new Uint8Array(bytes)), objects: 0, ids: [], support: false };
    const model = names.find((n) => /3dmodel\.model$/i.test(n));
    if (model) { const t = new TextDecoder().decode(await zip.read(model)); out.objects = (t.match(/<object /g) || []).length; out.names = [...t.matchAll(/<object [^>]*name="([^"]*)"/g)].map((m) => m[1]); }
    const g = names.find((n) => /plate_\d+\.gcode$/i.test(n));
    if (g) { const t = new TextDecoder().decode(await zip.read(g)); out.ids = [...new Set([...t.matchAll(/OBJECT_ID:\s*(\d+)/g)].map((m) => m[1]))]; out.support = /; FEATURE: Support/.test(t); }
    return out;
  }, bytes);
  const whole = await save('#ms-btn-plate-gcode3mf');
  const wi = await inspect(whole.bytes);
  check('Export .gcode.3mf downloads the slice as made: a .gcode.3mf with the three objects and the support', /\.gcode\.3mf$/.test(whole.name) && wi.sliced && wi.ids.length === 3 && wi.support, whole.name + ' ' + JSON.stringify(wi));
  const w3 = await save('#ms-btn-plate-3mf');
  const w3i = await inspect(w3.bytes);
  check('Export .3mf downloads the plate as a project: a .3mf, not sliced, one object each for the bridge, its support, the cube', /\.3mf$/.test(w3.name) && !/gcode/.test(w3.name) && !w3i.sliced && w3i.objects === 3, w3.name + ' ' + JSON.stringify(w3i));
  // select the cube: a capture box round it
  await page.evaluate(([c]) => { NSO_MICROSCOPE.clearBoxes(); NSO_MICROSCOPE.addBoxAt(90 + c.x, 90 + c.y, c.z, 5, 5); }, [cubeAt]);
  await frames(page); await frames(page);
  const selIds = await page.evaluate(() => NSO_MICROSCOPE.selectedObjectIds());
  check('a box round the cube selects one object', selIds.length === 1, JSON.stringify(selIds));
  check('the "selected" row shows', JSON.stringify(await rows()) === '[true,true]', JSON.stringify(await rows()));
  await shot('09-export-card.png');
  const s3 = await save('#ms-btn-sel-3mf');
  const s3i = await inspect(s3.bytes);
  check('Selected .3mf is the cube alone: one object', !s3i.sliced && s3i.objects === 1, s3.name + ' ' + JSON.stringify(s3i));
  const sg = await save('#ms-btn-sel-gcode3mf');
  const sgi = await inspect(sg.bytes);
  check('Selected .gcode.3mf is the cube sliced again alone: one object, no support', /\.gcode\.3mf$/.test(sg.name) && sgi.sliced && sgi.ids.length <= 1 && !sgi.support, sg.name + ' ' + JSON.stringify(sgi));
  const stillWhole = await save('#ms-btn-plate-3mf');
  check('the whole plate is still the whole plate afterwards', (await inspect(stillWhole.bytes)).objects === 3);

  /* ---------------------------------------------------------------- the plate with nothing on it */
  const empty = await browser.newPage({ viewport: { width: W, height: H } });
  cdn = cdn.concat(routeCdn(empty));
  empty.on('pageerror', (e) => errors.push(String(e)));
  await empty.goto(served.base + '/index.html', { waitUntil: 'load' });
  await empty.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await empty.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
  await empty.click('#menu-supports > summary');
  await empty.click('#btn-sup-slice');
  await empty.waitForFunction(() => document.getElementById('sup-slice-line').textContent !== '', null, { timeout: 10000 });
  const nothing = await empty.evaluate(() => ({ text: document.getElementById('sup-slice-line').textContent, bad: document.getElementById('sup-slice-line').classList.contains('is-bad'), open: window.NSO_MICROSCOPE.isOpen() }));
  check('an empty plate is refused in words, in red, and G-scope stays shut', nothing.text === 'Nothing on the plate to slice.' && nothing.bad && !nothing.open, JSON.stringify(nothing));

  check('nothing hit the CDN unrouted', cdn.filter((x) => x.startsWith('UNROUTED')).length === 0, cdn.filter((x) => x.startsWith('UNROUTED')).join(' '));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  served.srv.close();
  console.log('\nscreenshots: ' + SHOTS);
  console.log('\n' + passed + '/' + (passed + failed) + ' checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

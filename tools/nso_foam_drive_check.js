#!/usr/bin/env node
/* Foam - driven through the REAL app in headless Chromium.

     node tools/nso_foam_drive_check.js        exit 0 = every gate held

   tools/nso_foam_test.js proves the geometry. This proves the button, the
   view and the hand: click Foam, HOLD the mouse on the piece, let go, Set -
   the way a person does it, with real pointer events on the canvas.

     1. the button: in the Fill & fix card, in Fill / Densify's row, wired
     2. box_cavity_30.stl: Foam on - the ghost (translucent, depth-write off,
        not wireframe), the void, the list "Hollow 1 - 17,576 mm³" chosen
     3. hold on the piece for 1.5 s: the level rises at about a third of the
        hollow a second; the readout says so in words and matches the module;
        let go and it stays put
     4. the slider lowers it; Set: one undo entry, the piece closed, one
        hollow left the size the readout said, the ghost gone, the outer
        surface untouched; Undo puts the piece back bit for bit
     5. Fill it all + Set = Fill / Densify's own soup, bit for bit; Undo
     6. Cancel: nothing changed, no undo entry
     7. two hollows: neither chosen; a click on one in the ghost view chooses
        it, a click on the other's row chooses that
     8. refusals, in words: a painted wall of the hollow, a non-solid piece,
        a solid piece, an open cup
     9. Cut still runs on the foamed piece (rawCut in the page, closed)

   FOAM'S BOX MODE (docs/FOAM.md section 11, the box that was the gun's), sections 10-15:
    10. Foam shows the box: Crop's Box on the selected piece with its six handles
    11. the handles size it, with a real mouse: a face moves, the opposite stays
    12. hold fills, release sets, Undo restores: the level rises in the view while
        held, the readout is the engine's volume and nothing else, one undo entry
    13. a second spray stacks: more foam, a second entry, Undo steps back one
    14. Escape (and Cancel) clear the box; Box, Hollows and GUN swap; the hollow mode alone is as it was
    15. box_closed.stl (overlapping shells) fills, with no refusal and no flag
   THE GUN (docs/FOAM-GUN.md), section 16: armed with no box; a press on the
   top face is refused in words; a spray into fixtures/welded_gaps.stl's long
   slot fills it plate to face, one Undo, closed; Escape puts it away.
   FLOAT, section 17: armed with the crosshair; a click drops a point, Escape
   drops it; fixtures/welded_step.stl's seam floats, one Undo, closed; the
   card closing puts it away.
   Screenshots (box placed, mid-spray, set) go to tools/foam-gun-out/.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_foam_fixtures.js');
const SHOTS = path.join(ROOT, 'tools', 'foam-gun-out');
fs.mkdirSync(SHOTS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-foam-drive-'));
let fails = 0, passes = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
}

const BOX2 = path.join(TMP, 'foam-box2.stl'); writeSTL(BOX2, FX.box2().soup);
const CUP = path.join(TMP, 'foam-cup.stl'); writeSTL(CUP, FX.cup().soup);

/* The screen point of a raw point on the active piece, through its mesh. */
const screenOfRaw = (page, p) => page.evaluate(pt => {
  const m = getActiveModel(), ms = cutMeshOf(m), f = nsoRawFrameOf(m);
  const q = nsoLocalPointFromRaw(f, pt);
  ms.updateMatrixWorld(true);
  const v = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(ms.matrixWorld).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);

/* Look at the active piece square on, from the front and a little above, so
   it fills the middle of the canvas, and put the Finish menu's panel out of
   the way of the press. */
async function frameOn(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), ms = cutMeshOf(m);
    ms.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(ms), c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3()).length();
    state.controls.target.copy(c);
    state.camera.position.set(c.x + s * 0.25, c.y + s * 0.6, c.z + s * 1.6);
    state.controls.update();
  });
  await page.waitForTimeout(200);
}

const info = page => page.evaluate(() => window.nsoFoam.info());
const raw = page => page.evaluate(() => Array.from(getActiveModel().rawTris));
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const census = (page, arr) => page.evaluate(a => NSO_Foam.census(new Float32Array(a)), arr);

/* Press on the piece: a real mouse down, held, up. A spot clear of the
   viewport's own overlays is picked off the piece's projected centre. */
async function hold(page, ms, at) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function pieceSpot(page) {
  return page.evaluate(() => {
    const m = getActiveModel(), ms = cutMeshOf(m);
    const c = new THREE.Box3().setFromObject(ms).getCenter(new THREE.Vector3()).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  });
}

/* Foam's sealed-hollow mode: FOAM opens the box (its default mode), and the
   box panel's Hollows switches to the hollow mode. */
async function startFoam(page) {
  await openFinishMenu(page);
  await page.click('#btn-foam');
  await page.waitForTimeout(100);
  await page.click('#btn-foam-mode-hollow');
  await page.waitForTimeout(100);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the button ===');
  const b = await page.evaluate(() => {
    const f = document.getElementById('btn-foam'), fill = document.getElementById('btn-fill');
    // Shell v3: Foam is in the column's Add card, beside Fill / Densify.
    const sec = f && f.closest('[data-sec]');
    return { present: !!f, text: f && f.textContent.trim(), wired: !!f && f.dataset.nsoWired === '1',
             besideFill: !!f && !!fill && f.parentElement === fill.parentElement,
             group: sec && sec.dataset.sec, inAdd: !!f && !!f.closest('#menu-fillfix'),
             panelHidden: document.getElementById('foam-panel').hidden };
  });
  check('#btn-foam present, labelled "Foam"', b.present && b.text === 'Foam', b.text);
  check('...in the Fill & fix card (out of Add, 2026-11-16), in Fill / Densify\'s row', b.inAdd && b.group === 'fillfix' && b.besideFill,
        'group ' + b.group);
  check('...wired at load; its panel hidden until it is on', b.wired && b.panelHidden);

  console.log('\n=== 2. Foam on: the ghost and the hollow ===');
  const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  await frameOn(page);
  const orig = await raw(page);
  const depth0 = await undoDepth(page);
  await startFoam(page);
  const v = await page.evaluate(() => {
    const o = window.nsoFoam.objects(), mt = o.mesh.material;
    return { on: window.nsoFoam.on(), transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
             wireframe: mt.wireframe, voids: o.voids.length, voidChild: !!o.group && o.group.parent === o.mesh,
             list: [...document.querySelectorAll('#foam-hollows .foam-hollow')].map(e => ({ t: e.textContent, on: e.classList.contains('is-on') })),
             panel: !document.getElementById('foam-panel').hidden, read: document.getElementById('foam-readout').textContent };
  });
  check('Foam is on, its panel showing', v.on && v.panel, await statusOf(page));
  check('the piece is a ghost: translucent, depth-write off, not wireframe',
        v.transparent && v.opacity < 0.5 && v.depthWrite === false && v.wireframe === false, 'opacity ' + v.opacity);
  check('the hollow is drawn as a dark void inside it', v.voids === 1 && v.voidChild);
  check('the list reads "Hollow 1 - 17,576 mm³", and it is chosen', v.list.length === 1 &&
        v.list[0].t === 'Hollow 1 - 17,576 mm³' && v.list[0].on, JSON.stringify(v.list));
  check('the readout starts at 0%', v.read === 'Foam: 0% of the hollow, 0 mm³', v.read);

  console.log('\n=== 3. hold to spray, let go to pause ===');
  const spot = await pieceSpot(page);
  /* The fill advances once a frame by the frame's own time (each step capped
     at 0.5 s), so its speed is read off the frames: the level at every
     animation frame of the hold, and its rise over the frames' own time. That
     is the app's rate however many frames the runner managed - the old gate
     held the level against this check's wall-clock hold, which also counts
     the frames a starved runner drops (red on Tests #277, #284, and #289 even
     at half the rate). The gate is the total rise over the total time of the
     frames measured, not each frame's: this sampler reads the clock after the
     app's tick and redraw, so one frame's time is off by the change in the
     redraw's cost, and that cancels over the run where it would not frame by
     frame. The per-frame spread and the wall-clock reading are logged. */
  await page.evaluate(() => {
    const S = window.__foamFrames = { on: true, rows: [] };
    (function sample() {
      const i = window.nsoFoam.info();
      S.rows.push([performance.now(), i.height || 0, !!i.spraying]);
      if (S.on) requestAnimationFrame(sample);
    })();
  });
  const t0 = Date.now();
  await hold(page, 1500, spot);
  const held = Date.now() - t0;
  const rows = await page.evaluate(() => { window.__foamFrames.on = false; return window.__foamFrames.rows; });
  const i1 = await info(page);
  const want = 26 / 3 * held / 1000, RATE = 26 / 3;        // mm a second: the 26 mm hollow in 3 s
  /* frames where it was spraying on both ends and the step was not capped (0.45 s, under the app's 0.5) */
  const rates = [];
  let rise = 0, span = 0;
  for (let k = 1; k < rows.length; k++) {
    const dt = (rows[k][0] - rows[k - 1][0]) / 1000;
    if (!(rows[k][2] && rows[k - 1][2] && dt > 0 && dt < 0.45)) continue;
    rates.push((rows[k][1] - rows[k - 1][1]) / dt);
    rise += rows[k][1] - rows[k - 1][1];
    span += dt;
  }
  const rate = span > 0 ? rise / span : 0;
  rates.sort((a, b) => a - b);
  console.log('  FINDING the hold: ' + i1.height.toFixed(2) + ' mm in ' + held + ' ms on the clock (' + want.toFixed(2) +
              ' at the full rate); ' + rows.length + ' frames, ' + rates.length + ' measured while spraying, ' +
              (rates.length ? rates[0].toFixed(2) + ' - ' + rates[rates.length - 1].toFixed(2) + ' mm/s frame by frame' : 'none'));
  check('holding the mouse on the piece raised the level', i1.height > 0, i1.height.toFixed(2) + ' mm');
  check('...at a steady speed that fills the hollow in about 3 s: ' + RATE.toFixed(2) + ' mm/s within 5 %, over the frames\' own time',
        rates.length >= 3 && Math.abs(rate / RATE - 1) <= 0.05,
        rate.toFixed(3) + ' mm/s: ' + rise.toFixed(2) + ' mm over ' + span.toFixed(3) + ' s of ' + rates.length + ' frames');
  await page.waitForTimeout(500);
  const i2 = await info(page);
  check('let go: the level stays where it is', Math.abs(i2.height - i1.height) < 1e-9 && !i2.spraying);
  const mod = await page.evaluate(h => NSO_Foam.preview(getActiveModel().rawTris, NSO_Foam.analyse(getActiveModel().rawTris, {}), 0, h, { rawCut }).reason, i2.height);
  check('the readout reads in words and matches the module at that level', /^Foam: \d+% of the hollow, [\d,]+ mm³$/.test(i2.readout) &&
        i2.readout === mod, i2.readout);
  check('...and it is visible foam: an orange mesh and a ring at the level', await page.evaluate(() => {
    const o = window.nsoFoam.objects();
    return !!o.foam && !!o.ring && o.foam.material.color.r > 0.9 && o.foam.material.transparent;
  }));
  check('holding did not move the piece or orbit the view', await page.evaluate(() => /Moved model/.test(document.getElementById('status').textContent)) === false);

  console.log('\n=== 4. the slider lowers it; Set; Undo ===');
  await page.evaluate(() => { const s = document.getElementById('inp-foam-level'); s.value = '5'; s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(150);
  const i3 = await info(page);
  check('the slider sets the level directly, and lower', Math.abs(i3.height - 5) < 1e-9 && i3.readout === 'Foam: 19% of the hollow, 3,380 mm³', i3.readout);
  await page.click('#btn-foam-set');
  await page.waitForTimeout(700);
  const st = await statusOf(page);
  const after = await raw(page);
  const cs = await census(page, after);
  check('Set: "Foam set", the piece changed, one undo entry', /^Foam set in hollow 1 - 3,380 mm³ now solid/.test(st) &&
        after.length !== orig.length && (await undoDepth(page)) === depth0 + 1, st);
  check('...the piece is closed and 2-manifold', cs.closed && !cs.degen, JSON.stringify(cs));
  const left = await page.evaluate(() => NSO_Foam.analyse(getActiveModel().rawTris, {}).cavities.map(c => c.volume));
  check('...one hollow left, the size the readout implied (17,576 - 3,380)', left.length === 1 && Math.abs(left[0] - 14196) < 1e-3, left.join(', '));
  check('...the outer surface untouched, bit for bit', after.slice(0, 108).every((x, i) => Object.is(x, orig[i])));
  const norm = await page.evaluate(() => { const mt = cutMeshOf(getActiveModel()).material;
    return { on: window.nsoFoam.on(), op: mt.opacity, dw: mt.depthWrite, panel: document.getElementById('foam-panel').hidden,
             groups: (() => { let n = 0; state.scene.traverse(o => { if (o.userData.nsoFoamGroup) n++; }); return n; })() }; });
  check('...and the piece is back to normal: Foam off, no ghost, no foam left in the scene',
        !norm.on && norm.op === 1 && norm.dw === true && norm.panel && norm.groups === 0, JSON.stringify(norm));
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  const undone = await raw(page);
  check('Undo: "Undo: Foam reverted"', /Undo: Foam reverted/.test(await statusOf(page)), await statusOf(page));
  check('...the piece is bit for bit what it was', undone.length === orig.length && undone.every((x, i) => Object.is(x, orig[i])));

  console.log('\n=== 5. Fill it all + Set = Fill / Densify ===');
  await startFoam(page);
  await page.click('#btn-foam-all');
  await page.waitForTimeout(100);
  check('Fill it all: 100%', (await info(page)).readout === 'Foam: 100% of the hollow, 17,576 mm³', (await info(page)).readout);
  await page.click('#btn-foam-set');
  await page.waitForTimeout(600);
  const same = await page.evaluate(o => {
    const f = NSO_Hollow.fill(new Float32Array(o), {}).soup, r = getActiveModel().rawTris;
    return f.length === r.length && Array.from(f).every((x, i) => Object.is(x, r[i]));
  }, orig);
  check('the foamed piece is Fill / Densify\'s own soup, bit for bit', same, await statusOf(page));
  await page.click('#btn-undo');
  await page.waitForTimeout(300);

  console.log('\n=== 6. Cancel ===');
  const d6 = await undoDepth(page);
  await startFoam(page);
  await hold(page, 600, await pieceSpot(page));
  await page.click('#btn-foam-cancel');
  await page.waitForTimeout(150);
  const r6 = await raw(page);
  check('Cancel: Foam off, "nothing changed", the piece as it was, no undo entry',
        !(await page.evaluate(() => window.nsoFoam.on())) && /Foam cancelled - nothing changed/.test(await statusOf(page)) &&
        r6.every((x, i) => Object.is(x, orig[i])) && (await undoDepth(page)) === d6);
  const ghostBack = await page.evaluate(() => { const mt = cutMeshOf(getActiveModel()).material; return mt.opacity === 1 && mt.depthWrite; });
  check('...and the ghost is gone', ghostBack);

  console.log('\n=== 7. two hollows: choosing ===');
  const id2 = await loadSTL(page, BOX2);
  await selectModel(page, id2);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, id2);
  await frameOn(page);
  await startFoam(page);
  const i7 = await info(page);
  check('two hollows listed, neither chosen yet', i7.hollows.length === 2 && i7.chosen === null &&
        /Click a hollow to choose it/.test(i7.readout), i7.readout);
  const hollows = await page.evaluate(() => { const A = NSO_Foam.analyse(getActiveModel().rawTris, {});
    return A.cavities.map(c => { const s = getActiveModel().rawTris; let x = 0, y = 0, z = 0;
      c.faces.forEach(f => { for (let k = 0; k < 3; k++) { x += s[f * 9 + k * 3]; y += s[f * 9 + k * 3 + 1]; z += s[f * 9 + k * 3 + 2]; } });
      const n = c.faces.length * 3; return [x / n, y / n, z / n]; }); });
  const at = await screenOfRaw(page, hollows[1]);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(150);
  check('a click on hollow 2 in the ghost view chooses it', (await info(page)).chosen === 1, await statusOf(page));
  await page.click('#foam-hollows .foam-hollow[data-hollow="0"]');
  await page.waitForTimeout(100);
  check('a click on Hollow 1 in the list chooses that', (await info(page)).chosen === 0);
  await page.click('#btn-foam-cancel');

  console.log('\n=== 8. refusals, in words ===');
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  await page.evaluate(() => {
    const m = getActiveModel();
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: -13, axisIdx: 2, keepMin: false, inner: true, dispAxis: 1, dispSign: 1, dispPlane: -13 }], select: [] };
  });
  await startFoam(page);
  await page.evaluate(() => window.nsoFoam.setHeight(8));
  await page.click('#btn-foam-set');
  await page.waitForTimeout(150);
  const s8 = await statusOf(page);
  check('a painted floor of the hollow: stood down, the face named, nothing changed',
        /^Foam stood down - the inner Y\+ face at -13\.00 is painted/.test(s8) && (await raw(page)).every((x, i) => Object.is(x, orig[i])), s8);
  await page.click('#btn-foam-cancel');
  await page.evaluate(() => {
    const m = getActiveModel();
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: 15, axisIdx: 2, keepMin: false, inner: false, dispAxis: 1, dispSign: 1 }], select: [] };
  });
  await startFoam(page);
  await page.evaluate(() => window.nsoFoam.setHeight(8));
  await page.click('#btn-foam-set');
  await page.waitForTimeout(600);
  check('a painted OUTER face does not stop it (sub-region)', /^Foam set/.test(await statusOf(page)), await statusOf(page));
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  await page.evaluate(() => { getActiveModel().faceMask = { exclude: [], select: [] }; });

  await page.evaluate(() => nsoNonSolidSet(getActiveModel(), true, { noUndo: true, silent: true }));
  await startFoam(page);
  check('a non-solid piece: "Foam does not apply", Foam stays off',
        /Foam does not apply/.test(await statusOf(page)) && !(await page.evaluate(() => window.nsoFoam.on())), await statusOf(page));
  await page.evaluate(() => nsoNonSolidSet(getActiveModel(), false, { noUndo: true, silent: true }));

  const id3 = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await selectModel(page, id3);
  await startFoam(page);
  check('a solid piece: "no enclosed hollow", Foam stays off',
        /no enclosed hollow/.test(await statusOf(page)) && !(await page.evaluate(() => window.nsoFoam.on())), await statusOf(page));
  const id4 = await loadSTL(page, CUP);
  await selectModel(page, id4);
  await startFoam(page);
  check('an open cup: "open to the outside ... open vessels come later", Foam stays off',
        /open to the outside/.test(await statusOf(page)) && /open vessels come later/.test(await statusOf(page)) &&
        !(await page.evaluate(() => window.nsoFoam.on())), await statusOf(page));

  console.log('\n=== 9. Cut still runs on the foamed piece ===');
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  await startFoam(page);
  await page.evaluate(() => window.nsoFoam.setHeight(12));
  await page.click('#btn-foam-set');
  await page.waitForTimeout(600);
  const cut = await page.evaluate(() => {
    const r = getActiveModel().rawTris;
    return [[2, 0, true], [0, 3, false]].map(([ax, at, k]) => NSO_Foam.census(rawCut(r, ax, at, k)));
  });
  check('rawCut through the foamed piece gives closed halves', cut.every(c => c.closed && !c.degen), JSON.stringify(cut));


  console.log('\n=== 10. Foam shows the box ===');
  const idG = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));   // fresh: sections 2-9 foamed the first
  await selectModel(page, idG);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, idG);
  await frameOn(page);
  const g0 = await page.evaluate(() => {
    const b = document.getElementById('btn-foam'), h = document.getElementById('btn-foam-mode-hollow');
    return { present: !!b, text: b && b.textContent.trim(), wired: !!b && b.dataset.nsoWired === '1', inAdd: !!b && !!b.closest('#menu-fillfix'),
             hollowSwitch: !!h && !!h.closest('#foam-box-panel'), panelHidden: document.getElementById('foam-box-panel').hidden };
  });
  check('#btn-foam "Foam" in the Fill & fix card, wired, its box panel hidden, with a Hollows switch in it', g0.present && g0.text === 'Foam' && g0.inAdd && g0.wired && g0.panelHidden && g0.hollowSwitch, JSON.stringify(g0));
  const depthG = await undoDepth(page), rawG = await raw(page);
  await page.click('#btn-foam');
  await page.waitForTimeout(250);
  const g1 = await page.evaluate(() => {
    const c = window.NSO_CropCard, S = c.state(), gi = window.nsoFoamBox.info();
    const grp = state.scene.getObjectByName('foamGunBox');
    const b = new THREE.Box3().setFromObject(cutMeshOf(getActiveModel()));
    const pc = [(b.min.x + b.max.x) / 2, -(b.min.z + b.max.z) / 2, (b.min.y + b.max.y) / 2];
    return { lent: c.lent(), shape: S.shape, handles: c.handles(), box: c.box(), grp: !!grp && !!grp.parent, on: window.nsoFoamBox.on(),
             panel: !document.getElementById('foam-box-panel').hidden, foamPanel: !document.getElementById('foam-panel').hidden,
             read: document.getElementById('foam-box-readout').textContent, pc, size: [b.max.x - b.min.x, b.max.z - b.min.z, b.max.y - b.min.y],
             pressed: document.getElementById('btn-foam').getAttribute('aria-pressed'), cropCardLive: !!(state.cutterOpen && state.cutTool === 'crop'), gi };
  });
  check('Foam: Crop\'s Box is on the selected piece, with its six handles', g1.on && g1.lent && g1.shape === 'box' && g1.grp &&
        g1.handles.length === 6 && ['x+', 'x-', 'y+', 'y-', 'z+', 'z-'].every(h => g1.handles.includes(h)), JSON.stringify(g1.handles));
  check('...centred on the piece at half its size, like Crop\'s Box', g1.box.c.every((v, i) => Math.abs(v - g1.pc[i]) < 1e-3) &&
        g1.box.h.every((v, i) => Math.abs(v - g1.size[i] / 4) < 1e-3), JSON.stringify(g1.box));
  check('...its panel is up, Foam\'s is not, and the readout has nothing to say yet', g1.panel && !g1.foamPanel && g1.read === '—' && g1.pressed === 'true');
  check('...the Crop card is not opened by it, and the piece is untouched', !g1.cropCardLive && (await undoDepth(page)) === depthG &&
        (await raw(page)).every((x, i) => Object.is(x, rawG[i])));
  await page.screenshot({ path: path.join(SHOTS, '1-box-placed.png') });

  console.log('\n=== 11. the handles size it ===');
  const boxOf = () => page.evaluate(() => window.nsoFoamBox.info().box);
  const camOf = () => page.evaluate(() => state.camera.position.toArray());
  const drag = async (handle, dx, dy) => {
    const at = await page.evaluate(h => window.NSO_CropCard.handleScreen(h), handle);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + dx / 2, at.y + dy / 2, { steps: 4 });
    await page.mouse.move(at.x + dx, at.y + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const b0 = await boxOf(), cam0 = await camOf();
  const hx = await page.evaluate(() => window.NSO_CropCard.handleScreen('x+')), hxm = await page.evaluate(() => window.NSO_CropCard.handleScreen('x-'));
  await drag('x+', hx.x > hxm.x ? 30 : -30, 0);
  const b1 = await boxOf();
  check('dragging the x+ handle grows the box along x and the opposite face stays where it is',
        b1.h[0] > b0.h[0] + 0.5 && Math.abs((b1.c[0] - b1.h[0]) - (b0.c[0] - b0.h[0])) < 1e-6 && b1.h[1] === b0.h[1] && b1.h[2] === b0.h[2],
        JSON.stringify(b0.h) + ' -> ' + JSON.stringify(b1.h));
  check('...the press took the handle: the view did not orbit and the piece did not move', (await camOf()).every((v, i) => Math.abs(v - cam0[i]) < 1e-6) &&
        !/Moved model/.test(await statusOf(page)));
  const hz = await page.evaluate(() => window.NSO_CropCard.handleScreen('z+')), hzm = await page.evaluate(() => window.NSO_CropCard.handleScreen('z-'));
  await drag('z+', 0, hz.y < hzm.y ? -40 : 40);
  const b2 = await boxOf();
  check('...the z+ handle sizes the height the same way', b2.h[2] > b1.h[2] + 0.5 && Math.abs((b2.c[2] - b2.h[2]) - (b1.c[2] - b1.h[2])) < 1e-6,
        b1.h[2].toFixed(2) + ' -> ' + b2.h[2].toFixed(2));
  // then bring it back to where this section's spray tests want it: inside the hollow
  await page.evaluate(([c, h]) => window.NSO_CropCard.setBox(c, h), [b0.c, b0.h]);
  const bBack = await boxOf();
  check('...and the box the gun uses is the box the card holds', bBack.h.every((v, i) => v === b0.h[i]) && bBack.c.every((v, i) => v === b0.c[i]));

  console.log('\n=== 12. hold fills, release sets, Undo restores ===');
  const levelOf = () => page.evaluate(() => {
    const o = window.nsoFoamBox.objects();
    if (!o.foam) return null;
    const pl = o.foam.material.clippingPlanes, lv = pl[pl.length - 1];
    return { level: lv.constant - 0.03, amount: window.nsoFoamBox.info().amount, read: document.getElementById('foam-box-readout').textContent,
             ghost: o.mesh.material.opacity };
  });
  const bw = await page.evaluate(() => {
    const b = window.NSO_CropCard.box();
    return { floor: b.c[2] - b.h[2], top: b.c[2] + b.h[2] };
  });
  const spot12 = await pieceSpot(page);
  await page.mouse.move(spot12.x, spot12.y);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const s1 = await levelOf();
  await page.waitForTimeout(350);
  const s2 = await levelOf();
  await page.screenshot({ path: path.join(SHOTS, '2-mid-spray.png') });   // the shot itself takes about a second: it lands near the middle
  const heldG = await page.evaluate(() => window.nsoFoamBox.info());
  check('holding sprays: the foam is drawn, the piece a ghost, and the controls are off', !!s1 && !!s2 && s1.ghost < 0.3 && heldG.spraying &&
        (await page.evaluate(() => state.controls.enabled)) === false, JSON.stringify(s1));
  check('...the level rises in the view from the box\'s floor while the mouse is held', s1.level >= bw.floor - 0.05 && s2.level > s1.level + 0.3 && s2.level < bw.top,
        bw.floor.toFixed(2) + ' < ' + s1.level.toFixed(2) + ' < ' + s2.level.toFixed(2) + ' < ' + bw.top.toFixed(2));
  check('...the amount rises with the clock (100 in 3 s)', s2.amount > s1.amount + 2 && s2.amount - s1.amount < 30 && s2.amount < 100, s1.amount.toFixed(1) + ' -> ' + s2.amount.toFixed(1));
  check('...the readout is the engine\'s volume and nothing else', /^\+[\d,]+ mm³$/.test(s2.read), s2.read);
  const depthHeld = await undoDepth(page);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after12 = await raw(page), gi12 = await page.evaluate(() => window.nsoFoamBox.info());
  const cs12 = await census(page, after12);
  const vol = async arr => page.evaluate(a => NSO_Foam.signedVolume(new Float32Array(a)), arr);
  const added12 = (await vol(after12)) - (await vol(rawG));
  check('letting go sets it: one undo entry, the piece changed, closed and 2-manifold', (await undoDepth(page)) === depthG + 1 && depthHeld === depthG &&
        after12.length !== rawG.length && cs12.closed && !cs12.degen && /^Foam set/.test(await statusOf(page)), await statusOf(page));
  const readNum = t => Number(t.replace(/[^\d]/g, ''));
  check('...the readout is the volume the engine added, and it is what the mesh gained', /^\+[\d,]+ mm³$/.test(gi12.readout) &&
        Math.abs(readNum(gi12.readout) - added12) <= 1, gi12.readout + ' vs ' + added12.toFixed(2));
  check('...the ghost, the foam and the controls are back; the box is still there', await page.evaluate(() => {
    const mt = cutMeshOf(getActiveModel()).material;
    return mt.opacity === 1 && mt.depthWrite && !window.nsoFoamBox.objects().foam && state.controls.enabled && window.NSO_CropCard.lent() &&
           !!state.scene.getObjectByName('foamGunBox');
  }));
  await page.screenshot({ path: path.join(SHOTS, '3-set.png') });
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  const undone12 = await raw(page);
  check('Undo puts the piece back bit for bit, one entry for the spray', undone12.length === rawG.length && undone12.every((x, i) => Object.is(x, rawG[i])) &&
        (await undoDepth(page)) === depthG && /Undo: Foam reverted/.test(await statusOf(page)), await statusOf(page));
  check('...and the box is still out', await page.evaluate(() => window.nsoFoamBox.on() && window.NSO_CropCard.lent() && !!state.scene.getObjectByName('foamGunBox')));

  console.log('\n=== 13. a second spray stacks ===');
  const fullBox = await page.evaluate(() => {   // the box's own volume within the 26 mm hollow, from the box and the piece
    const b = window.NSO_CropCard.box(), m = getActiveModel(), bb = new THREE.Box3().setFromObject(cutMeshOf(m));
    const pc = [(bb.min.x + bb.max.x) / 2, -(bb.min.z + bb.max.z) / 2, (bb.min.y + bb.max.y) / 2];
    return [0, 1, 2].reduce((v, k) => v * Math.max(0, Math.min(b.c[k] + b.h[k], pc[k] + 13) - Math.max(b.c[k] - b.h[k], pc[k] - 13)), 1);
  });
  await hold(page, 1300, spot12);
  await page.waitForTimeout(900);
  const sp1 = await raw(page), v1 = (await vol(sp1)) - (await vol(rawG));
  await hold(page, 3600, spot12);
  await page.waitForTimeout(900);
  const sp2 = await raw(page), v2 = (await vol(sp2)) - (await vol(sp1));
  check('two sprays, two undo entries', (await undoDepth(page)) === depthG + 2, String(await undoDepth(page) - depthG));
  check('...the second adds more on top of the first', v1 > 1 && v2 > 1 && sp2.length !== sp1.length, v1.toFixed(1) + ' then ' + v2.toFixed(1));
  check('...a full second spray fills the rest of the box: the two add up to what the box holds', Math.abs(v1 + v2 - fullBox) < 0.5, (v1 + v2).toFixed(2) + ' vs ' + fullBox.toFixed(2));
  check('...the readout is the second spray\'s volume alone', Math.abs(readNum(await page.evaluate(() => window.nsoFoamBox.info().readout)) - v2) <= 1);
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  const u1 = await raw(page);
  check('Undo takes back the second spray only', u1.length === sp1.length && u1.every((x, i) => Object.is(x, sp1[i])) && (await undoDepth(page)) === depthG + 1);
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  check('...and the next takes back the first', (await raw(page)).every((x, i) => Object.is(x, rawG[i])) && (await undoDepth(page)) === depthG);

  console.log('\n=== 14. Escape and Cancel clear the box; Box, Hollows and GUN swap ===');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Escape: the box is gone, nothing changed, no undo entry', await page.evaluate(() =>
        !window.nsoFoamBox.on() && !window.NSO_CropCard.lent() && !state.scene.getObjectByName('foamGunBox') && document.getElementById('foam-box-panel').hidden &&
        state.controls.enabled) && (await undoDepth(page)) === depthG && (await raw(page)).every((x, i) => Object.is(x, rawG[i])));
  await page.click('#btn-foam');
  await page.waitForTimeout(150);
  await page.click('#btn-foam-box-cancel');
  await page.waitForTimeout(150);
  check('Cancel does the same', await page.evaluate(() => !window.nsoFoamBox.on() && !window.NSO_CropCard.lent() && !state.scene.getObjectByName('foamGunBox')) &&
        (await undoDepth(page)) === depthG);
  await page.click('#btn-foam');
  await page.waitForTimeout(100);
  await page.mouse.move(spot12.x, spot12.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(500);
  check('Escape in the middle of a spray: nothing set, ghost off, box gone', await page.evaluate(() => {
        const mt = cutMeshOf(getActiveModel()).material;
        return !window.nsoFoamBox.on() && mt.opacity === 1 && mt.depthWrite && state.controls.enabled && !state.scene.getObjectByName('foamGunBox');
      }) && (await undoDepth(page)) === depthG && (await raw(page)).every((x, i) => Object.is(x, rawG[i])));
  await page.click('#btn-foam');
  await page.waitForTimeout(100);
  await page.click('#btn-foam-mode-hollow');
  await page.waitForTimeout(200);
  check('Hollows while the box is out: the box goes and the sealed-hollow Foam runs as ever', await page.evaluate(() => !window.nsoFoamBox.on() && !window.NSO_CropCard.lent() && window.nsoFoam.on() &&
        !document.getElementById('foam-panel').hidden && document.getElementById('foam-box-panel').hidden));
  await page.click('#btn-foam-mode-box');
  await page.waitForTimeout(200);
  check('Box while the hollow mode is on: it steps aside and the box comes', await page.evaluate(() => window.nsoFoamBox.on() && !window.nsoFoam.on() && window.NSO_CropCard.lent() &&
        document.getElementById('foam-panel').hidden && cutMeshOf(getActiveModel()).material.opacity === 1));
  await page.click('#btn-foam-gun');
  await page.waitForTimeout(200);
  check('GUN while the box is out: the box goes and the gun is armed, no box', await page.evaluate(() => window.nsoFoamGun.on() && !window.nsoFoamBox.on() &&
        !window.NSO_CropCard.lent() && !document.getElementById('foam-gun-panel').hidden && document.getElementById('foam-box-panel').hidden));
  await page.click('#btn-foam-gun-cancel');

  console.log('\n=== 15. box_closed fills, with no false flag ===');
  const idBC = await loadSTL(page, path.join(ROOT, 'library', 'box_closed.stl'));
  await selectModel(page, idBC);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, idBC);
  await frameOn(page);
  const rawBC = await raw(page), depthBC = await undoDepth(page);
  await page.click('#btn-foam');
  await page.waitForTimeout(250);
  await page.evaluate(() => {   // a box over the whole piece, the way the handles would put it
    const m = getActiveModel(), bb = new THREE.Box3().setFromObject(cutMeshOf(m)), s = bb.getSize(new THREE.Vector3());
    window.NSO_CropCard.setBox([(bb.min.x + bb.max.x) / 2, -(bb.min.z + bb.max.z) / 2, (bb.min.y + bb.max.y) / 2], [s.x / 2 + 2, s.z / 2 + 2, s.y / 2 + 2]);
  });
  await hold(page, 3800, await pieceSpot(page));
  await page.waitForTimeout(1500);
  const stBC = await statusOf(page), giBC = await page.evaluate(() => window.nsoFoamBox.info());
  const afterBC = await raw(page);
  check('box_closed: the spray sets, with the engine\'s own words', /^Foam set - 46,166 mm³ of buried space filled \(100% of what the box holds/.test(stBC), stBC);
  check('...the readout is the volume, +46,166 mm³', giBC.readout === '+46,166 mm³', giBC.readout);
  check('...no refusal, no "open to the outside", no flag on the piece', !/open to the outside|stood down|cannot|not a closed|Nothing changed/.test(stBC) &&
        !(await page.evaluate(() => nsoNonSolid(getActiveModel()))) && !/open to the outside/.test(giBC.readout));
  check('...one undo entry, closed', (await undoDepth(page)) === depthBC + 1 && (await census(page, afterBC)).closed);
  await page.click('#btn-undo');
  await page.waitForTimeout(400);
  check('...Undo puts box_closed back bit for bit', (await raw(page)).every((x, i) => Object.is(x, rawBC[i])));
  await page.keyboard.press('Escape');

  console.log('\n=== 16. the GUN: no box, point into a gap, it fills plate to face ===');
  const idW = await loadSTL(page, path.join(ROOT, 'fixtures', 'welded_gaps.stl'));
  await selectModel(page, idW);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, idW);
  await frameOn(page);
  const rawW = await raw(page), depthW = await undoDepth(page);
  await page.click('#btn-foam-gun');
  await page.waitForTimeout(200);
  check('GUN: armed, its panel up, no box anywhere', await page.evaluate(() => window.nsoFoamGun.on() && !window.NSO_CropCard.lent() &&
        !document.getElementById('foam-gun-panel').hidden && document.getElementById('foam-box-panel').hidden &&
        document.getElementById('btn-foam-gun').getAttribute('aria-pressed') === 'true'));
  await page.waitForFunction(() => !window.nsoFoamGun.info().preparing, null, { timeout: 30000 });
  const cur0 = await page.evaluate(() => ({ kind: window.nsoFoamGun.cursor(), css: state.renderer.domElement.style.cursor }));
  check('...the piece is read on arming, and the cursor is the foam gun (an SVG cursor, nozzle tip at the hotspot)',
        cur0.kind === 'plain' && /^url\("data:image\/svg\+xml;utf8,.*"\) 1 10, crosshair$/.test(cur0.css), cur0.kind + ' ' + cur0.css.slice(0, 40));
  const offPiece = await page.evaluate(() => { const r = state.renderer.domElement.getBoundingClientRect(); return [r.left + 8, r.top + 8]; });
  check('...off the piece the cursor is the plain gun (a press there orbits)', (await page.evaluate(p => window.nsoFoamGun.hoverAt(p[0], p[1]), offPiece)) === 'plain');
  const topSpot = await screenOfRaw(page, [-16, -5, 13.55]);   // the left body's top face, 4 mm from any gap
  check('...over the top face, not into a gap, it shows the red bar', (await page.evaluate(p => window.nsoFoamGun.hoverAt(p.x, p.y), topSpot)) === 'no');
  /* A real press on the piece's top face, well clear of any gap. */
  await hold(page, 600, topSpot);
  await page.waitForTimeout(1500);
  const giTop = await page.evaluate(() => window.nsoFoamGun.info());
  check('a press on the top face, not into a gap: refused in words, nothing changed, no undo entry',
        /^GUN: /.test(giTop.readout) && /Nothing changed/.test(giTop.readout) && (await undoDepth(page)) === depthW &&
        (await raw(page)).every((x, i) => Object.is(x, rawW[i])), giTop.readout);
  /* Into the long slot, at its wall, held to the end. */
  const rW = await page.evaluate(() => window.nsoFoamGun.sprayAt({ point: [-9.7081, -3.4119, 0], dir: [-1, 0, 0] }, 100)
    .then(r => ({ ok: r.ok, changed: r.changed, reason: r.reason, added: r.addedVolume, glow: window.nsoFoamGun.info().glow })));
  await page.waitForTimeout(300);
  const afterW = await raw(page), stW = await statusOf(page);
  check('the long slot: filled plate to face, in the engine\'s words', rW.ok && rW.changed && /^Foam sprayed - 1,044 mm³ into the gap, from the plate to the face/.test(stW), stW);
  check('...one undo entry, the piece closed', (await undoDepth(page)) === depthW + 1 && (await census(page, afterW)).closed);
  const giW = await page.evaluate(() => window.nsoFoamGun.info());
  check('...the readout says what went in', giW.readout === '+1,044 mm³ set - the gap is filled', giW.readout);
  check('...and the foam that went in glows over the piece for a moment', rW.glow);
  await page.waitForTimeout(1600);
  check('...then fades away', !(await page.evaluate(() => window.nsoFoamGun.info().glow)));
  check('...the gun stays armed for the next gap, the piece no longer a ghost', await page.evaluate(() => window.nsoFoamGun.on() &&
        cutMeshOf(getActiveModel()).material.opacity === 1 && !window.nsoFoamGun.objects().foam && state.controls.enabled));
  await page.click('#btn-undo');
  await page.waitForTimeout(400);
  check('...Undo puts the piece back bit for bit', (await raw(page)).every((x, i) => Object.is(x, rawW[i])));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Escape puts the gun away', await page.evaluate(() => !window.nsoFoamGun.on() && document.getElementById('foam-gun-panel').hidden));

  /* The card closing puts it away: the gun does not follow you to another card. */
  await openFinishMenu(page);
  await page.evaluate(() => { document.getElementById('menu-fillfix').open = true; });
  await page.click('#btn-foam-gun');
  await page.waitForFunction(() => window.nsoFoamGun.on() && !window.nsoFoamGun.info().preparing, null, { timeout: 30000 });
  await page.click('#menu-fillfix > summary');
  await page.waitForTimeout(200);
  const shut = await page.evaluate(() => ({ open: document.getElementById('menu-fillfix').open, on: window.nsoFoamGun.on(),
    cursor: state.renderer.domElement.style.cursor, controls: state.controls.enabled }));
  check('closing the Fill & fix card puts the gun away: disarmed, the cursor back to the page\'s own, the orbit back',
        !shut.open && !shut.on && shut.cursor === '' && shut.controls, JSON.stringify(shut));
  check('...and says so', /GUN put away - the Fill & fix card was closed/.test(await statusOf(page)), await statusOf(page));
  await page.evaluate(() => { document.getElementById('menu-fillfix').open = true; });
  await page.click('#btn-foam');
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.getElementById('menu-add').open = true; document.getElementById('menu-fillfix').open = false; });
  await page.waitForTimeout(200);
  check('another card opening puts Foam\'s box away too', await page.evaluate(() => !window.nsoFoamBox.on() && !window.NSO_CropCard.lent()));
  await page.evaluate(() => { document.getElementById('menu-add').open = false; });

  console.log('\n=== 17. FLOAT: two points, the dip between them floated ===');
  const idF = await loadSTL(page, path.join(ROOT, 'fixtures', 'welded_step.stl'));
  await selectModel(page, idF);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k >= 0) selectPlaced(k); }, idF);
  await frameOn(page);
  await openFinishMenu(page);
  await page.evaluate(() => { document.getElementById('menu-fillfix').open = true; });
  const rawF = await raw(page), depthF = await undoDepth(page);
  await page.click('#btn-foam-float');
  await page.waitForTimeout(150);
  check('Float: armed, its panel up, the crosshair, the other Foam tools away', await page.evaluate(() => window.nsoFoamFloat.on() &&
        !document.getElementById('foam-float-panel').hidden && state.renderer.domElement.style.cursor === 'crosshair' &&
        !window.nsoFoamGun.on() && !window.nsoFoamBox.on() && !window.nsoFoam.on()));
  const spotF = await screenOfRaw(page, [-6, -15.09, 19.24]);
  await page.mouse.click(spotF.x, spotF.y);
  await page.waitForTimeout(150);
  check('...a click on the piece puts the first point down, and says to click the second', await page.evaluate(() =>
        window.nsoFoamFloat.info().pointDown && /click the second/.test(window.nsoFoamFloat.info().readout)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('...Escape drops the point, and Float stays armed', await page.evaluate(() => window.nsoFoamFloat.on() && !window.nsoFoamFloat.info().pointDown));
  /* Two points on an even face: nothing to float - no foam on screen, no undo entry. */
  const rEven = await page.evaluate(() => window.nsoFoamFloat.floatAt({ point: [-8, -15.09, 5], normal: [0, -1, 0] }, { point: [-4, -15.09, -2], normal: [0, -1, 0] })
    .then(r => ({ ok: r.ok, kind: r.kind, reason: r.reason, fill: !!window.nsoFoamFloat.objects().fill })));
  check('two points on an even face: nothing to float, in words - no foam shown, no undo entry', !rEven.ok && rEven.kind === 'flat' && !rEven.fill &&
        (await undoDepth(page)) === depthF && /nothing to float/.test(await page.evaluate(() => window.nsoFoamFloat.info().readout)), rEven.reason);
  /* The seam: the foam fills along it on screen, inside the piece, then it is set. */
  await page.evaluate(() => {
    window.__fl = { seen: 0, inside: true };
    const go = window.nsoFoamFloat.floatAt({ point: [-12, -15.036, 5], normal: [0, -1, 0] }, { point: [-8, -15.09, -3], normal: [0, -1, 0] });
    (function watch() {
      const o = window.nsoFoamFloat.objects();
      if (o.fill && o.mesh) {
        window.__fl.seen++;
        const fb = new THREE.Box3().setFromObject(o.fill), mb = new THREE.Box3().setFromObject(o.mesh).expandByScalar(0.2);
        if (!mb.containsBox(fb)) window.__fl.inside = false;
      }
      if (!window.__fl.done) requestAnimationFrame(watch);
    })();
    window.__flp = go.then(r => { window.__fl.done = true; window.__fl.r = { ok: r.ok, changed: r.changed, reason: r.reason }; });
  });
  await page.evaluate(() => window.__flp);
  const fw = await page.evaluate(() => window.__fl);
  const rF = fw.r;
  check('the foam is shown filling along the seam, ghosted, before it is set - and it is on the piece, not somewhere else',
        fw.seen >= 2 && fw.inside, JSON.stringify({ frames: fw.seen, inside: fw.inside }));
  const afterF = await raw(page), stF = await statusOf(page);
  check('the seam between the two welded fronts floats, in the engine\'s words', rF.ok && rF.changed && /^Floated - 1\.9 mm³ .* along the dip\./.test(stF), stF);
  check('...one undo entry, the piece closed, the readout the volume, the ghost gone', (await undoDepth(page)) === depthF + 1 && (await census(page, afterF)).closed &&
        (await page.evaluate(() => window.nsoFoamFloat.info().readout)) === '+1.9 mm³ floated' &&
        (await page.evaluate(() => cutMeshOf(getActiveModel()).material.opacity === 1 && !window.nsoFoamFloat.objects().fill)));
  await page.click('#btn-undo');
  await page.waitForTimeout(400);
  check('...Undo puts the piece back bit for bit', (await raw(page)).every((x, i) => Object.is(x, rawF[i])));
  await page.click('#menu-fillfix > summary');
  await page.waitForTimeout(200);
  check('closing the Fill & fix card puts Float away, the cursor back', await page.evaluate(() => !window.nsoFoamFloat.on() &&
        state.renderer.domElement.style.cursor === '' && document.getElementById('foam-float-panel').hidden));

  const errs = logs.filter(l => /pageerror|Uncaught|TypeError|ReferenceError/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('FAILED:\n  ' + FAILED.join('\n  ')); process.exit(1); }
}).catch(e => { console.error(e); process.exit(1); });

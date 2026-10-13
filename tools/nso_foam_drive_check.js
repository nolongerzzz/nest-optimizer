#!/usr/bin/env node
/* Foam - driven through the REAL app in headless Chromium.

     node tools/nso_foam_drive_check.js        exit 0 = every gate held

   tools/nso_foam_test.js proves the geometry. This proves the button, the
   view and the hand: click Foam, HOLD the mouse on the piece, let go, Set -
   the way a person does it, with real pointer events on the canvas.

     1. the button: in Finish > Shape, in Fill / Densify's row, wired
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
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_foam_fixtures.js');

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

async function startFoam(page) {
  await openFinishMenu(page);
  await page.click('#btn-foam');
  await page.waitForTimeout(100);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the button ===');
  const b = await page.evaluate(() => {
    const f = document.getElementById('btn-foam'), fill = document.getElementById('btn-fill');
    let sec = f; while (sec && !(sec.classList && sec.classList.contains('vp-sec'))) sec = sec.parentElement;
    return { present: !!f, text: f && f.textContent.trim(), wired: !!f && f.dataset.nsoWired === '1',
             besideFill: !!f && !!fill && f.parentElement === fill.parentElement,
             group: sec && sec.dataset.sec, inFinish: !!f && !!f.closest('.vp-finish-menu'),
             panelHidden: document.getElementById('foam-panel').hidden };
  });
  check('#btn-foam present, labelled "Foam"', b.present && b.text === 'Foam', b.text);
  check('...in Finish, in the Shape group, in Fill / Densify\'s row', b.inFinish && b.group === 'shape' && b.besideFill,
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
  const t0 = Date.now();
  await hold(page, 1500, spot);
  const held = Date.now() - t0;
  const i1 = await info(page);
  const want = 26 / 3 * held / 1000;
  check('holding the mouse on the piece raised the level', i1.height > 0, i1.height.toFixed(2) + ' mm');
  check('...at a steady speed that fills the hollow in about 3 s', i1.height > want * 0.6 && i1.height < want * 1.15,
        i1.height.toFixed(2) + ' mm in ' + held + ' ms (' + want.toFixed(2) + ' expected)');
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

  const errs = logs.filter(l => /pageerror|Uncaught|TypeError|ReferenceError/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('FAILED:\n  ' + FAILED.join('\n  ')); process.exit(1); }
}).catch(e => { console.error(e); process.exit(1); });

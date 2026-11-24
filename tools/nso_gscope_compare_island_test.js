#!/usr/bin/env node
/* G-scope COMPARE, Pieces: a click on a plate whose slicer printed many bodies under ONE OBJECT_ID takes the body clicked, with its
   supports - not the whole plate. Bambu's slice of supp_ref_2x is one merged STL: six heads and every tree under OBJECT_ID 318.

   GATES
     1. On plate 2 (supp_ref_2x.gcode.3mf), a real click on a tree during a Pieces pick sets ONE island on plate 3: a share of the
        plate's lines near a sixth of them (not all), the clicked line among them, its footprint a fraction of the plate's.
     2. ...the same with only Support switched on (the owner's view when it was found): one tree, not all six.
     3. Outside a Compare pick a click still takes the whole OBJECT_ID (nothing else changed).

     node tools/nso_gscope_compare_island_test.js        exit 0 = every gate held */
'use strict';
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const SLICE_A = 'fixtures/3mf/toolpath-ground-truth.gcode.3mf';
const SLICE_B = 'fixtures/supports/supp_ref_2x.gcode.3mf';
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const J = JSON.stringify;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // fetched by the page from the harness's own server: the bytes do not go through a JSON array
  const open = (url, n) => page.evaluate(async ([u, nm]) => { NSO_MICROSCOPE.openFile(nm, await (await fetch('/' + u)).arrayBuffer()); }, [url, n]);
  await open(SLICE_A, 'a.gcode.3mf');
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 60000 });
  await page.evaluate(() => { NSO_MICROSCOPE.showPlate('take'); });
  await open(SLICE_B, 'supp_ref_2x.gcode.3mf');
  await page.waitForFunction(() => NSO_MICROSCOPE.plate() === 'take' && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 60000 });
  await frames(page);

  /* A real click (pointer events on the canvas) on the middle of a shown Support line of the active plate, near the front-left one if asked. */
  const clickSupport = () => page.evaluate(async () => {
    const M = NSO_MICROSCOPE, d = M.getDoc(), v = M.getView(), c = document.querySelector('#microscope canvas'), r = c.getBoundingClientRect();
    const off = new Set(M.plateState(M.plate()).featuresOff || []);
    const cand = d.segments.filter(s => s.feature === 'Support' && !off.has(s.feature) && s.z > 2 && s.z < 6);
    if (!cand.length) return false;
    v.camera.updateMatrixWorld(true);
    const fire = (type, x, y, t) => (t || c).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    const want = M.comparePicking();
    for (let i = 0; i < cand.length; i += Math.max(1, Math.floor(cand.length / 60))) {
      const s = cand[i];
      const p = new THREE.Vector3((s.x0 + s.x1) / 2 - d.cx, s.z, -((s.y0 + s.y1) / 2 - d.cy)).project(v.camera);
      if (!(Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9)) continue;
      const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
      fire('pointermove', x, y); fire('pointerdown', x, y); fire('pointerup', x, y, window);
      await new Promise(res => setTimeout(res, 50));
      if (M.comparePicking() !== want || M.plateDoc('cmp')) return true;
    }
    return false;
  });

  const run = async (label, supportOnly) => {
    console.log('\n=== ' + label + ' ===');
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareClear(); ['take', 'lens'].forEach(n => { M.showPlate(n); M.clearBoxes(); M.back(); }); M.showPlate('lens'); });
    if (supportOnly) {
      await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('take'); const fs = Array.from(new Set(M.getDoc().segments.map(s => s.feature))); fs.forEach(f => M.setFeatureDisplay(f, f === 'Support')); M.showPlate('lens'); });
    }
    // DOM clicks: plate 2 is 360k lines under swiftshader, too slow a page for Playwright's stable-element wait
    await page.evaluate(() => { const b = document.getElementById('ms-compare-body'); if (b && b.hidden) document.getElementById('ms-compare-toggle').click(); document.getElementById('ms-compare-pieces').click(); });
    await frames(page);
    await page.evaluate(() => { NSO_MICROSCOPE.pickPiece(0); });   // nothing back: the selection is far too big to send to node
    await new Promise(r => setTimeout(r, 200)); await frames(page);
    const st1 = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate() }));
    check('plate 1 picked, on to plate 2', st1.pick === 'take' && st1.plate === 'take', J(st1));
    const plate = await page.evaluate(() => { const d = NSO_MICROSCOPE.getDoc(), off = new Set(NSO_MICROSCOPE.plateState(NSO_MICROSCOPE.plate()).featuresOff || []); const sh = d.segments.filter(s => !off.has(s.feature));
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; sh.forEach(s => { x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x0); y0 = Math.min(y0, s.y0); y1 = Math.max(y1, s.y0); });
      return { shown: sh.length, ids: Array.from(new Set(d.segments.map(s => s.obj))), span: Math.max(x1 - x0, y1 - y0) }; });
    const t0 = Date.now();
    const clicked = await clickSupport();
    await new Promise(r => setTimeout(r, 400)); await frames(page);
    const r = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp'); if (!d) return null;
      const b = d.objects[1]; return { plate: M.plate(), n: d.objects.length, moves: b.moves.length, w: b.bounds.maxX - b.bounds.minX, dp: b.bounds.maxZ - b.bounds.minZ, name: b.name }; });
    check('the reference is one OBJECT_ID (the case this guards)', plate.ids.length === 1, J(plate.ids));
    check('a click on a tree of plate 2 sets two pieces on plate 3', clicked && r && r.plate === 'cmp' && r.n === 2, J({ clicked, r, ms: Date.now() - t0 }));
    check('...plate 2\'s is ONE body with its supports: about a sixth of the plate\'s lines, not all', r && r.moves > plate.shown * 0.08 && r.moves < plate.shown * 0.3, J({ moves: r && r.moves, shown: plate.shown }));
    check('...its footprint a fraction of the plate\'s', r && Math.max(r.w, r.dp) < plate.span * 0.5, J({ w: r && r.w, d: r && r.dp, span: plate.span }));
    await page.evaluate(() => { NSO_MICROSCOPE.compareClear(); });
    if (supportOnly) await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('take'); M.checkAll(); M.showPlate('lens'); });
  };

  await run('1. Pieces on a one-object plate: everything shown', false);
  await run('2. Pieces on a one-object plate: only Support shown', true);

  console.log('\n=== 3. outside Compare a click takes the whole OBJECT_ID ===');
  {
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareClear(); M.showPlate('take'); M.clearBoxes(); M.back(); });
    const n = await page.evaluate(() => { const M = NSO_MICROSCOPE; const sel = M.pickPiece(0).length; const all = M.getDoc().segments.length; M.back(); return { sel, all }; });
    check('pickPiece outside Compare still takes the whole id', n.sel === n.all, J(n));
  }

  check('no page errors', logs.filter(l => /^\[pageerror\]/.test(l)).length === 0, logs.filter(l => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});

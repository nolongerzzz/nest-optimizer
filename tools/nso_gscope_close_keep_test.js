#!/usr/bin/env node
/* G-scope: a close KEEPS the plates - the owner goes back and forth between the main view and G-scope.

   GATES
     1. Plate 1 a read of the main plate, plate 2 a slice, plate 2 showing with a piece isolated: Close, then the G-scope
        button - plate 2 is the same document, still isolated, and is the plate showing; plate 1 is there too.
     2. A piece added on the main plate while G-scope was put away: plate 1 (the main plate's read) has it on the next
        open; plate 2 is untouched.
     3. A compare on plate 3 survives too: the same two pieces, Compare still live (a nudge moves the blue piece).
     4. A file opened from the main view while G-scope is put away (openFile) lands on plate 1, as it always has; plate 2
        is untouched.
     5. With every plate empty a close is the old end of the visit (nothing kept, the next open reads the plate).

     node tools/nso_gscope_close_keep_test.js        exit 0 = every gate held */
'use strict';
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const J = JSON.stringify;
const SLICE = 'fixtures/3mf/toolpath-ground-truth.gcode.3mf';
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const addBox = (x) => page.evaluate((x) => {
    const g = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    g.rotateX(Math.PI / 2);
    const id = addModelFromZUpGeometry('box' + x, g);
    return id;
  }, x);
  await addBox(1);
  await page.waitForFunction(() => state.placed.length >= 1, null, { timeout: 30000 });
  const railOpen = async () => { await page.click('#btn-microscope'); await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 }); await frames(page); };
  const railClose = async () => { await page.click('#ms-close'); await page.waitForFunction(() => !NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 }); };

  console.log('\n=== 1. plate 1 the main plate, plate 2 a slice, isolated: Close, open ===');
  await railOpen();
  check('plate 1 is a read of the main plate', await page.evaluate(() => { const d = NSO_MICROSCOPE.plateDoc('lens'); return !!d && d.source === 'plate'; }));
  await page.evaluate(async (u) => { NSO_MICROSCOPE.showPlate('take'); const b = await (await fetch('/' + u)).arrayBuffer(); await NSO_MICROSCOPE.openFile('slice.gcode.3mf', b); }, SLICE);
  await page.waitForFunction(() => NSO_MICROSCOPE.plate() === 'take' && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 60000 });
  await page.evaluate(() => { NSO_MICROSCOPE.pickPiece(0); });   // a click on a piece: it is isolated
  await frames(page);
  const before = await page.evaluate(() => { const M = NSO_MICROSCOPE; window.__take = M.plateDoc('take'); return { iso: M.plateState('take').isolated, sel: M.plateState('take').selection.length, lens: M.plateDoc('lens').objects.length }; });
  await railClose();
  check('closed: plate 1 is the active plate while G-scope is put away', await page.evaluate(() => NSO_MICROSCOPE.plate() === 'lens'));
  await railOpen();
  const after = await page.evaluate(() => { const M = NSO_MICROSCOPE; return { plate: M.plate(), same: M.plateDoc('take') === window.__take, iso: M.plateState('take').isolated, sel: M.plateState('take').selection.length, lens: M.plateDoc('lens') && M.plateDoc('lens').objects.length }; });
  check('open again: plate 2 is the same slice, still isolated, the plate showing', after.plate === 'take' && after.same && after.iso === before.iso && after.iso && after.sel === before.sel, J({ before, after }));
  check('...and plate 1 is there (the main plate read again: ' + after.lens + ' piece)', after.lens === 1, J(after));

  console.log('\n=== 2. a piece added on the main plate meanwhile ===');
  await railClose();
  await addBox(2);
  await page.waitForFunction(() => state.placed.length >= 2, null, { timeout: 30000 });
  await railOpen();
  const two = await page.evaluate(() => { const M = NSO_MICROSCOPE; return { plate: M.plate(), lens: M.plateDoc('lens').objects.length, same: M.plateDoc('take') === window.__take }; });
  check('plate 1 has the new piece (2), plate 2 untouched, plate 2 showing', two.lens === 2 && two.same && two.plate === 'take', J(two));

  console.log('\n=== 3. a compare on plate 3 ===');
  await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('take'); M.back(); M.showPlate('lens'); });
  await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('lens'); M.pickPiece(0); M.showPlate('take'); M.selectLayer(2); M.isolate(); M.showPlate('lens'); });
  const started = await page.evaluate(() => !!NSO_MICROSCOPE.compareStart());
  await frames(page);
  const cmp0 = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp'); window.__cmp = d; return d ? d.objects.map((o) => o.name) : null; });
  await railClose();
  await railOpen();
  const cmp1 = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp'); return { plate: M.plate(), same: d === window.__cmp, names: d ? d.objects.map((o) => o.name) : null, st: M.compareState() }; });
  check('plate 3 is the same compare, its two pieces, on plate 3', started && cmp1.same && J(cmp1.names) === J(cmp0) && cmp1.plate === 'cmp' && !!cmp1.st, J({ cmp0, cmp1 }));
  // (Overlay lines two toolpaths up; plate 1's piece here is a mesh, so the nudge is the live control to try)
  const nudged = await page.evaluate(() => NSO_MICROSCOPE.compareNudge(0.5, 0, 0));
  check('...and Compare is still live: a nudge moves the blue piece', !!nudged && Math.abs(nudged.dx - 0.5) < 1e-9, J(nudged));

  console.log('\n=== 4. a file opened from the main view while G-scope is put away ===');
  await railClose();
  await page.evaluate(async (u) => { const b = await (await fetch('/' + u)).arrayBuffer(); await NSO_MICROSCOPE.openFile('again.gcode.3mf', b); }, SLICE);
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.plateDoc('lens') && NSO_MICROSCOPE.plateDoc('lens').kind === 'toolpath', null, { timeout: 60000 });
  const four = await page.evaluate(() => { const M = NSO_MICROSCOPE; return { plate: M.plate(), lens: M.plateDoc('lens').name, same: M.plateDoc('take') === window.__take, cmp: M.plateDoc('cmp') === window.__cmp }; });
  check('it lands on plate 1; plates 2 and 3 untouched', four.plate === 'lens' && /again/.test(four.lens) && four.same && four.cmp, J(four));

  console.log('\n=== 5. every plate empty: the old end of the visit ===');
  await page.evaluate(() => { NSO_MICROSCOPE.reset(); });
  await railClose().catch(() => {});
  await railOpen();
  const five = await page.evaluate(() => { const M = NSO_MICROSCOPE; return { plate: M.plate(), lens: M.plateDoc('lens') && M.plateDoc('lens').source, take: M.plateDoc('take'), cmp: M.plateDoc('cmp') }; });
  check('nothing kept: the next open reads the main plate onto plate 1, plates 2 and 3 empty', five.plate === 'lens' && five.lens === 'plate' && !five.take && !five.cmp, J(five));

  check('no page errors', logs.filter((l) => /^\[pageerror\]/.test(l)).length === 0, logs.filter((l) => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});

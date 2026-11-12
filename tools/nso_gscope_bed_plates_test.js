#!/usr/bin/env node
/* G-scope: MULTI-PLATE PREVIEW - a bed's Preview lands on G-scope's plate of the same number (the owner: "ran supports generate on
   plate 1, preview in g-scope ... ran a separate supports generate on plate 2, preview in g-scope. It replaced the preview I had on
   plate 1 ... can we allow multi plate preview, since we have up to 6 plates").

   GATES (a box on each bed, the Slice card's slice, its Preview - the route Generate's and Supports' Preview take)
     1. One bed: Preview lands on the active G-scope plate (plate 1), as it always has.
     2. Two beds: bed 2's Preview lands on G-scope plate 2; plate 1 keeps bed 1's slice (the same document).
     3. Bed 1 previewed again (G-scope on plate 2): it lands on plate 1 again, plate 2 untouched.
     4. Bed 3: G-scope plate 3 stands (labelled "Plate 3") right of plate 2; plates 1 and 2 untouched.
     5. Compare (Plates) on plates 1 and 2 still works: its plate is labelled "Compare" and stands last, after plate 3.
     6. CLEAR on plate 3 takes it away; plates 1 and 2 stand as they were.

     node tools/nso_gscope_bed_plates_test.js        exit 0 = every gate held */
'use strict';
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const J = JSON.stringify;

withApp(async (page, logs) => {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.setViewportSize({ width: 1280, height: 800 });
  /* a printer the Slice card slices for */
  const pick = await page.evaluate(() => {
    const sel = document.getElementById('plate-select');
    if (NSO_Print.card.canSlice() || !sel) return NSO_Print.card.canSlice();
    for (const o of Array.from(sel.options)) {
      sel.value = o.value; sel.dispatchEvent(new Event('change'));
      if (NSO_Print.card.canSlice()) return true;
    }
    return false;
  });
  check('a printer the Slice card slices for', pick);
  const addBox = (name, size) => page.evaluate(([name, size]) => {
    const g = new THREE.BoxGeometry(size, size, size).toNonIndexed();
    g.rotateX(Math.PI / 2);
    return addModelFromZUpGeometry(name, g);
  }, [name, size]);
  const preview = () => page.evaluate(() => NSO_Print.card.sliceAndPreview().then((r) => ({ ok: r.ok, reason: r.reason })));
  const toolpathOn = (plate) => page.waitForFunction((p) => { const d = NSO_MICROSCOPE.plateDoc(p); return d && d.kind === 'toolpath' && d.nsoPlateSlice; }, plate, { timeout: 180000 });
  const close = async () => { if (await page.evaluate(() => NSO_MICROSCOPE.isOpen())) await page.evaluate(() => NSO_MICROSCOPE.close()); };
  const read = () => page.evaluate(() => {
    const M = NSO_MICROSCOPE, out = { plate: M.plate(), live: M.livePlates(), docs: {} };
    out.live.forEach((n) => { const d = M.plateDoc(n); out.docs[n] = d ? { kind: d.kind, pieces: d.nsoPlateSlice ? d.nsoPlateSlice.pieces.map((p) => p.name) : null } : null; });
    return out;
  });

  console.log('\n=== 1. one bed ===');
  await addBox('bed1box', 12);
  await page.waitForFunction(() => state.placed.length >= 1, null, { timeout: 30000 });
  const p1 = await preview();
  await toolpathOn('lens');
  const one = await read();
  check('one bed: Preview lands on plate 1', p1.ok && one.plate === 'lens' && one.docs.lens && J(one.docs.lens.pieces) === J(['bed1box']), J({ p1, one }));
  const lens1 = await page.evaluate(() => { window.__lens1 = NSO_MICROSCOPE.plateDoc('lens'); return true; });

  console.log('\n=== 2. bed 2 ===');
  await close();
  await page.evaluate(() => NSO_BEDS.add());
  check('bed 2 is active', await page.evaluate(() => NSO_BEDS.count() === 2 && NSO_BEDS.activeNumber() === 2));
  await addBox('bed2box', 16);
  await page.waitForFunction(() => state.placed.length >= 1, null, { timeout: 30000 });
  const p2 = await preview();
  await toolpathOn('take');
  const two = await read();
  const kept1 = await page.evaluate(() => NSO_MICROSCOPE.plateDoc('lens') === window.__lens1);
  check('bed 2\'s Preview lands on G-scope plate 2, the active one', p2.ok && two.plate === 'take' && J(two.docs.take.pieces) === J(['bed2box']), J({ p2, two }));
  check('...and plate 1 keeps bed 1\'s slice (the same document)', lens1 && kept1 && J(two.docs.lens.pieces) === J(['bed1box']), J(two.docs.lens));
  await page.evaluate(() => { window.__take2 = NSO_MICROSCOPE.plateDoc('take'); });

  console.log('\n=== 3. bed 1 again, G-scope left on plate 2 ===');
  await close();
  await page.evaluate(() => NSO_BEDS.activate(0));
  check('bed 1 is active', await page.evaluate(() => NSO_BEDS.activeNumber() === 1));
  const p1b = await preview();
  await page.waitForFunction(() => NSO_MICROSCOPE.plateDoc('lens') && NSO_MICROSCOPE.plateDoc('lens') !== window.__lens1 && NSO_MICROSCOPE.plateDoc('lens').nsoPlateSlice, null, { timeout: 180000 });
  const three = await read();
  const kept2 = await page.evaluate(() => NSO_MICROSCOPE.plateDoc('take') === window.__take2);
  check('bed 1\'s Preview lands on plate 1 again', p1b.ok && three.plate === 'lens' && J(three.docs.lens.pieces) === J(['bed1box']), J({ p1b, three }));
  check('...plate 2 untouched', kept2);
  await page.evaluate(() => { window.__lens1 = NSO_MICROSCOPE.plateDoc('lens'); });

  console.log('\n=== 4. bed 3 ===');
  await close();
  await page.evaluate(() => NSO_BEDS.add());
  await addBox('bed3box', 10);
  await page.waitForFunction(() => state.placed.length >= 1, null, { timeout: 30000 });
  const p3 = await preview();
  await toolpathOn('p3');
  const four = await read();
  const geo = await page.evaluate(() => { const M = NSO_MICROSCOPE; return { title: M.plateTitle('p3'), x: ['lens', 'take', 'p3'].map((n) => +M.plateOffset(n).toFixed(3)), side: M.plateSide() }; });
  check('bed 3\'s Preview lands on G-scope plate 3, which now stands', p3.ok && four.plate === 'p3' && J(four.live) === J(['lens', 'take', 'p3']) && J(four.docs.p3.pieces) === J(['bed3box']), J({ p3, four }));
  check('...labelled "Plate 3", right of plate 2 (plates a step apart, plate 3 active at the origin)', geo.title === 'Plate 3' && geo.x[2] === 0 && geo.x[1] < 0 && geo.x[0] < geo.x[1] && Math.abs((geo.x[1] - geo.x[0]) - (geo.x[2] - geo.x[1])) < 1e-6, J(geo));
  check('...plates 1 and 2 untouched', await page.evaluate(() => NSO_MICROSCOPE.plateDoc('lens') === window.__lens1 && NSO_MICROSCOPE.plateDoc('take') === window.__take2));

  console.log('\n=== 5. Compare plates 1 and 2 ===');
  const cmp = await page.evaluate(() => {
    const M = NSO_MICROSCOPE, r = M.compareStartPlates();
    return { ok: !!r, plate: M.plate(), live: M.livePlates(), title: M.plateTitle('cmp'), n: M.plateDoc('cmp') ? M.plateDoc('cmp').objects.length : 0,
             xs: M.livePlates().map((n) => +M.plateOffset(n).toFixed(3)) };
  });
  check('Compare sets plates 1 and 2 down on its own plate, labelled "Compare", standing last', cmp.ok && cmp.plate === 'cmp' && cmp.title === 'Compare' && J(cmp.live) === J(['lens', 'take', 'p3', 'cmp']) && cmp.n === 2 && cmp.xs[3] === 0 && cmp.xs[2] < 0, J(cmp));
  await page.evaluate(() => NSO_MICROSCOPE.compareClear && NSO_MICROSCOPE.compareClear());

  console.log('\n=== 6. CLEAR on plate 3 ===');
  const six = await page.evaluate(() => {
    const M = NSO_MICROSCOPE;
    M.showPlate('p3');
    document.getElementById('ms-btn-take-clear').click();
    M.showPlate('lens');
    return { live: M.livePlates(), lens: M.plateDoc('lens') === window.__lens1, take: M.plateDoc('take') === window.__take2, p3: M.plateDoc('p3') };
  });
  check('plate 3 is gone once emptied and left; plates 1 and 2 as they were', J(six.live) === J(['lens', 'take']) && six.lens && six.take && !six.p3, J(six));

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exitCode = fails ? 1 : 0;
});

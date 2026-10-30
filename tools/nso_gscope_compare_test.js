#!/usr/bin/env node
/* G-scope COMPARE (docs/GSCOPE.md item 13): what is isolated on each plate, set down together on plate 2, overlaid, nudged, and plate 2 restored.

   GATES
     1. Side by side: with a slice on each plate and something isolated on each (a layer on plate 1, everything shown on plate 2), the
        Side by side button sets both down on plate 3 - a plate of two pieces, plate 1's at the left, plate 2's at the right, a gap between,
        each at the height it came from, each in its own colour - and plates 1 and 2 are as they were. Plate 3 stands right of plate 2 only
        while it holds a compare.
     2. Overlay lines the second piece up with the first by their parts' outlines (XY only, the height unchanged) and draws both see-through.
     3. The nudge arrows move the second piece by the step chosen, and only it.
     4. Colours off puts the line types' own colours back; on, the tints.
     5. Clear compare takes plate 3 away (plates 1 and 2 as they were), and Side by side works again.
     6. Nothing to compare (a plate empty, nothing isolated) is refused, saying why, and changes nothing.

     node tools/nso_gscope_compare_test.js        exit 0 = every gate held */
'use strict';
const path = require('path');
const fs = require('fs');
const { withApp, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const SHOTS = path.join(ROOT, 'tools', 'gscope-compare-out');
const SLICE = process.env.COMPARE_A || path.join(ROOT, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');
const SLICE_B = process.env.COMPARE_B || SLICE;
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const J = JSON.stringify;

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  const bytesA = Array.from(fs.readFileSync(SLICE)), bytesB = Array.from(fs.readFileSync(SLICE_B));
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const status = () => page.evaluate(() => (document.getElementById('status') || {}).textContent || '');
  const partCentre = (which) => page.evaluate((w) => {
    const d = NSO_MICROSCOPE.getDoc();
    const o = d.objects[w];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9;
    o.moves.forEach(m => {
      if (/^(Support|Travel|Skirt|Brim|Custom|Prime|Wipe)/i.test(m.feature || '') || !m.feature) return;
      x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1); z0 = Math.min(z0, m.z);
    });
    return [(x0 + x1) / 2, (y0 + y1) / 2, z0, x1 - x0];
  }, which);

  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytesA, 'a.gcode.3mf']);
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
  await page.evaluate(() => NSO_MICROSCOPE.showPlate('take'));
  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytesB, 'b.gcode.3mf']);
  await page.waitForFunction(() => NSO_MICROSCOPE.plate() === 'take' && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
  await frames(page);

  console.log('\n=== 6. nothing isolated: refused ===');
  {
    await page.evaluate(() => NSO_MICROSCOPE.showPlate('lens'));
    await frames(page);
    const r = await page.evaluate(() => ({ r: NSO_MICROSCOPE.compareStart(), s: NSO_MICROSCOPE.compareState(), plate: NSO_MICROSCOPE.plate(), kind: NSO_MICROSCOPE.plateDoc('take').kind }));
    check('Side by side with nothing isolated does nothing and says what to do', r.r === null && r.s === null && r.kind === 'toolpath' && /isolate something/i.test(await status()), J(r) + ' ' + await status());
  }

  console.log('\n=== 1. side by side ===');
  let ref;
  {
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('lens'); M.selectLayer(Math.min(3, M.layerCount() - 1)); M.isolate(); });
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('take'); M.selectVisible(); M.isolate(); });
    await page.evaluate(() => NSO_MICROSCOPE.showPlate('lens'));
    await frames(page);
    ref = await page.evaluate(() => { const M = NSO_MICROSCOPE, s = M.plateState('lens'), s2 = M.plateState('take'); delete s.camera; delete s2.camera; return { lens: JSON.stringify(s), take: JSON.stringify(s2), takeName: M.plateDoc('take').name, takeMoves: M.plateDoc('take').parsed.moves.length, floors: Object.keys(M.getView().floors).filter(n => M.getView().floors[n].group.visible) }; });
    check('before a compare only plates 1 and 2 stand', J(ref.floors) === J(['lens', 'take']), J(ref.floors));
    const rowShown = await page.evaluate(() => { const r = document.getElementById('ms-compare-row'); return r && getComputedStyle(r).display !== 'none'; });
    check('the Compare plates row shows with a file on each plate, folded', rowShown && await page.evaluate(() => document.getElementById('ms-compare-body').hidden));
    await page.click('#ms-compare-toggle');
    const btn = await page.evaluate(() => { const b = document.getElementById('ms-compare-start'); return { there: !!b, off: b && b.disabled, vis: b && getComputedStyle(b).display !== 'none' && b.offsetParent !== null }; });
    check('the Side by side button is on the card and enabled with a file on each plate', btn.there && !btn.off && btn.vis, J(btn));
    await page.click('#ms-compare-start');
    await frames(page);
    const r = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, d = M.plateDoc('cmp');
      return { plate: M.plate(), floors: Object.keys(M.getView().floors).filter(n => M.getView().floors[n].group.visible), kind: d.kind, src: d.source, names: d.objects.map(o => o.name), tint: d.objects.map(o => o.tint), st: M.compareState(),
               boxes: d.objects.map(o => [o.bounds.minX, o.bounds.maxX, o.bounds.minZ, o.bounds.maxZ]) };
    });
    check('plate 3 stands now, a plate of two pieces, active', r.plate === 'cmp' && r.src === 'take' && r.names.length === 2 && J(r.floors) === J(['lens', 'take', 'cmp']), J([r.plate, r.names, r.floors]));
    check('...named for the plate they came from, each with its own colour', /^Plate 1: /.test(r.names[0]) && /^Plate 2: /.test(r.names[1]) && r.tint[0] !== r.tint[1] && r.tint.every(Boolean), J(r.tint));
    check('...plate 1\'s at the left, plate 2\'s at the right, with a gap between', r.boxes[0][1] < r.boxes[1][0], J(r.boxes));
    const lensNow = await page.evaluate(() => { const s = NSO_MICROSCOPE.plateState('lens'); delete s.camera; return JSON.stringify(s); });
    const takeNow = await page.evaluate(() => { const s = NSO_MICROSCOPE.plateState('take'); delete s.camera; return JSON.stringify(s); });
    check('plates 1 and 2 are as they were (byte for byte)', lensNow === ref.lens && takeNow === ref.take);
    check('the compare state reads the two pieces', r.st && !r.st.overlaid && r.st.tinted, J(r.st));
    check('the colour tints are in the drawn geometry (orange and blue meshes differ)', await page.evaluate(() => {
      const v = NSO_MICROSCOPE.getView(), ms = Object.keys(v.overviewMeshes).map(k => v.overviewMeshes[k]).filter(m => m.geometry.attributes.color);
      if (ms.length < 2) return false;
      const c = m => { const a = m.geometry.attributes.color.array; let r = 0, b = 0; for (let i = 0; i < a.length; i += 3) { r += a[i]; b += a[i + 2]; } return r > b; };
      return c(ms[0]) !== c(ms[1]);
    }));
    await shot('01-side-by-side');
  }

  console.log('\n=== 2. overlay ===');
  {
    const before = [await partCentre(0), await partCentre(1)];
    await page.click('#ms-compare-overlay');
    await frames(page);
    const after = [await partCentre(0), await partCentre(1)];
    const st = await page.evaluate(() => NSO_MICROSCOPE.compareState());
    check('the parts\' outlines now coincide in X and Y', Math.abs(after[0][0] - after[1][0]) < 1e-3 && Math.abs(after[0][1] - after[1][1]) < 1e-3, J({ before, after }));
    check('the first piece did not move; the second moved only in XY (its height is its own)', J(after[0]) === J(before[0]) && Math.abs(after[1][2] - before[1][2]) < 1e-9, J({ b0: before[0], a0: after[0], z: [before[1][2], after[1][2]] }));
    check('both are drawn see-through', await page.evaluate(() => { const o = NSO_MICROSCOPE.getDoc().objects; return o.every(x => x.alpha > 0 && x.alpha < 1); }) && st.overlaid, J(st));
    await shot('02-overlay');
  }

  console.log('\n=== 3. nudge ===');
  {
    const a0 = await partCentre(0), b0 = await partCentre(1);
    await page.selectOption('#ms-compare-step', '0.5');
    await page.click('#ms-compare-nx\\+');
    await page.click('#ms-compare-ny-');
    await page.click('#ms-compare-nz\\+');
    await frames(page);
    const a1 = await partCentre(0), b1 = await partCentre(1);
    const st = await page.evaluate(() => NSO_MICROSCOPE.compareState());
    check('the arrows moved the second piece by the step (+0.5 X, -0.5 Y, +0.5 Z)', Math.abs(b1[0] - b0[0] - 0.5) < 1e-3 && Math.abs(b1[1] - b0[1] + 0.5) < 1e-3 && Math.abs(b1[2] - b0[2] - 0.5) < 1e-3, J([b0, b1]));
    check('...and the first piece not at all', J(a1) === J(a0));
    check('...the readout counts the nudge', st && Math.abs(st.dx - 0.5) < 1e-9 && Math.abs(st.dy + 0.5) < 1e-9 && Math.abs(st.dz - 0.5) < 1e-9, J(st));
    await page.click('#ms-compare-nx-'); await page.click('#ms-compare-ny\\+'); await page.click('#ms-compare-nz-');
    const b2 = await partCentre(1);
    check('...and the opposite arrows bring it back', Math.abs(b2[0] - b0[0]) < 1e-3 && Math.abs(b2[1] - b0[1]) < 1e-3 && Math.abs(b2[2] - b0[2]) < 1e-3, J(b2));
  }

  console.log('\n=== 4. colours ===');
  {
    const sig = () => page.evaluate(() => {
      const v = NSO_MICROSCOPE.getView(), ms = Object.keys(v.overviewMeshes).map(k => v.overviewMeshes[k]).filter(m => m.geometry.attributes.color);
      return ms.map(m => { const a = m.geometry.attributes.color.array; let s = 0; for (let i = 0; i < a.length; i += 97) s += a[i] * 3 + a[i + 1] * 5 + a[i + 2] * 7; return s; });
    });
    const on = await sig();
    await page.click('#ms-compare-tint');
    await frames(page);
    const off = await sig();
    await page.click('#ms-compare-tint');
    await frames(page);
    const on2 = await sig();
    check('Colours off changes the colours, and on puts the tints back exactly', J(on) !== J(off) && J(on) === J(on2), J({ on, off, on2 }));
  }

  console.log('\n=== 5. clear compare ===');
  {
    await page.click('#ms-compare-restore');
    await frames(page);
    const r = await page.evaluate(() => { const M = NSO_MICROSCOPE, s = M.plateState('lens'), s2 = M.plateState('take'); delete s.camera; delete s2.camera;
      return { plate: M.plate(), cmp: M.plateDoc('cmp'), st: M.compareState(), floors: Object.keys(M.getView().floors).filter(n => M.getView().floors[n].group.visible), lens: JSON.stringify(s), take: JSON.stringify(s2) }; });
    check('plate 3 is gone, plate 1 active, plates 1 and 2 as they were', r.plate === 'lens' && r.cmp === null && r.st === null && J(r.floors) === J(['lens', 'take']) && r.lens === ref.lens && r.take === ref.take, J({ plate: r.plate, floors: r.floors }));
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('take'); M.selectVisible(); M.isolate(); M.showPlate('lens'); });
    await page.click('#ms-compare-start');
    await frames(page);
    check('...and Side by side works again', await page.evaluate(() => !!NSO_MICROSCOPE.compareState()));
    const again = await page.evaluate(() => { const M = NSO_MICROSCOPE; return !!M.compareStart() && M.plateDoc('cmp').objects.length === 2; });
    check('...and a second Side by side replaces the compare on plate 3', again);
  }

  console.log('\n=== 7. a solo line type, and a capture box ===');
  {
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    const r = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, out = {};
      M.showPlate('lens'); const f = Object.keys(M.getDoc().groups).find(g => g !== 'Travel');
      M.soloGroups([f]); M.showPlate('take'); M.soloGroups([f]); M.showPlate('lens');
      out.feature = f; out.start = !!M.compareStart();
      const d = M.plateDoc('cmp');
      out.feats = d.objects.map(o => Array.from(new Set(o.moves.filter(m => m.feature).map(m => m.feature))));
      out.ok = d.objects.length === 2;
      return out;
    });
    check('one line type isolated on each plate: both set down, each holding only that line type', r.start && r.ok && r.feats.every(fs => fs.length === 1 && fs[0] === r.feature), J(r));
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    const box = await page.evaluate(() => {
      const M = NSO_MICROSCOPE;
      M.showPlate('lens'); M.checkAll(); M.clearBoxes();
      const d = M.getDoc(), mv = d.parsed.moves.filter(m => m.feature && !/^travel/i.test(m.feature));
      const xs = mv.map(m => m.x0), ys = mv.map(m => m.y0), zs = mv.map(m => m.z);
      const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
      M.addBoxAt(c[0], c[1], c[2], Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), Math.max(...zs) - Math.min(...zs) + 2, 0, 0);
      M.isolate();
      const sel = M.selection().length;
      M.showPlate('take'); M.checkAll(); M.selectVisible(); M.isolate(); M.showPlate('lens');
      return { sel, st: !!M.compareStart() };
    });
    check('a capture box over a model (everything it holds, supports with it) is carried the same way', box.sel > 0 && box.st, J(box));
  }

  console.log('\n=== 8. the measurement ===');
  {
    await page.selectOption('#ms-compare-step', '0.1');
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareClear(); ['lens', 'take'].forEach(n => { M.showPlate(n); M.checkAll(); M.setZRangeMm(-1, 999); M.flushView(); M.selectVisible(); M.isolate(); }); M.showPlate('lens'); M.compareStart(); });
    const pre = await page.evaluate(() => ({ dis: document.getElementById('ms-compare-diff').disabled, copy: document.getElementById('ms-compare-diff-copy').disabled }));
    check('Measure is on once there is a compare; Copy JSON waits for a measurement', pre.dis === false && pre.copy === true, J(pre));
    await page.click('#ms-compare-overlay');
    await page.click('#ms-compare-diff');
    await frames(page);
    const r = await page.evaluate(() => { const M = NSO_MICROSCOPE, rep = M.compareReport(), rd = document.getElementById('ms-compare-diff-read');
      return { has: !!rep, layers: rep && rep.meta.layers, shown: !rd.hidden, text: rd.textContent.slice(0, 120), offset: rep && rep.meta.blueOffsetMm, partOnly: rep && [rep.classes.part.onlyAMm2, rep.classes.part.onlyBMm2], both: rep && rep.classes.part.bothMm2, copy: document.getElementById('ms-compare-diff-copy').disabled }; });
    check('Measure reads the overlaid pair: a report, shown as text, Copy JSON on', r.has && r.shown && r.layers > 0 && r.copy === false && /^A = Plate 1/.test(r.text), J(r));
    check('...the same file on both plates, overlaid: what plate 1 holds is wholly in plate 2\'s (none only A\'s), and they share material', r.partOnly[0] < 0.5 && r.both > 5, J([r.partOnly, r.both]));
    await page.click('#ms-compare-nx\\+');
    const stale = await page.evaluate(() => ({ rep: NSO_MICROSCOPE.compareReport(), txt: document.getElementById('ms-compare-diff-read').textContent }));
    check('a nudge makes the measurement out of date, and says so', stale.rep === null && /Measure again/.test(stale.txt), J(stale));
    await page.click('#ms-compare-diff');
    const shifted = await page.evaluate(() => { const rep = NSO_MICROSCOPE.compareReport(); return { only: [rep.classes.part.onlyAMm2, rep.classes.part.onlyBMm2], off: rep.meta.blueOffsetMm }; });
    check('...measured again after a 0.1 mm nudge, an edge of material is only in each, and the offset is in the report', shifted.only[0] > 0.2 && shifted.only[1] > 0.2 && Math.abs(shifted.off[0] - 0.1) < 1e-9, J(shifted));
    await shot('03-measure');
  }

  check('no page errors', logs.filter(l => /^\[pageerror\]/.test(l)).length === 0, logs.filter(l => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});

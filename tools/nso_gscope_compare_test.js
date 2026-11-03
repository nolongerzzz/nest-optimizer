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

  console.log('\n=== stops beside the slider: a click puts the range on one layer, whole ===');
  {
    const st0 = await page.evaluate(() => { const h = document.getElementById('ms-zr-stops'); const b = h ? Array.from(h.querySelectorAll('.ms-zr-stop')) : []; return { has: !!h, shown: h && !h.hidden, n: b.length, kinds: Array.from(new Set(b.map(x => x.className.replace('ms-zr-stop ', '').replace(/ on/, '')))), steps: NSO_MICROSCOPE.getZRange ? null : null }; });
    check('the slider has stops: one tick per plate layer, in its own colour', st0.has && st0.shown && st0.n > 0, J(st0));
    const pick = await page.evaluate(() => { const b = document.querySelectorAll('#ms-zr-stops .ms-zr-stop'); const k = b[Math.floor(b.length / 2)]; k.click(); const r = NSO_MICROSCOPE.zRange ? NSO_MICROSCOPE.zRange() : null; return { r: r && { lo: r.lo, hi: r.hi, part: r.part, steps: r.steps }, on: document.querySelectorAll('#ms-zr-stops .ms-zr-stop.on').length }; });
    await frames(page); await shot('zr-stops');
    check('a click on a stop puts both handles on that layer, whole (no part-way nozzle)', pick.r && pick.r.lo === pick.r.hi && pick.r.part === 1 && pick.on >= 1, J(pick));
    const ext = await page.evaluate(() => { const b = document.querySelectorAll('#ms-zr-stops .ms-zr-stop'); b[b.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); const r = NSO_MICROSCOPE.zRange(); return { lo: r.lo, hi: r.hi }; });
    check('Shift-click takes the range out to another stop', ext.hi > ext.lo, J(ext));
    await page.evaluate(() => document.getElementById('ms-zr-all').click());
  }

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
    // SPLIT STACK: a view on plate 3 - the pair's interface layers laid out next to each other, ours in a back row and the reference in a front row
    const splitPre = await page.evaluate(() => { const b = document.getElementById('ms-compare-stacks'); const lay = o => new Set(o.moves.filter(m => m.feature && /interface/i.test(m.feature)).map(m => Math.round(m.z * 1000))).size;
      const c = NSO_MICROSCOPE.getDoc(); return { dis: b.disabled, label: b.textContent, n: c.objects.length, la: lay(c.objects[0]), lb: lay(c.objects[1]) }; });
    check('Split stack is on from Side by side, with no Overlay and no Measure', splitPre.dis === false && splitPre.label === 'Split stack' && splitPre.n === 2, J(splitPre));
    await page.click('#ms-compare-stacks');
    await frames(page); await shot('split-stack');
    const split = await page.evaluate(() => { const d = NSO_MICROSCOPE.getDoc(), b = document.getElementById('ms-compare-stacks'); const cen = o => { let y = 0, n = 0, z = 1e9; o.moves.forEach(m => { y += m.y0 + m.y1; n += 2; z = Math.min(z, m.z); }); return [y / n, z]; };
      const ours = d.objects.filter(o => /^Ours /.test(o.name)), ref = d.objects.filter(o => /^Reference /.test(o.name));
      return { n: d.objects.length, ours: ours.length, ref: ref.length, label: b.textContent, back: ours.length && ref.length ? cen(ours[0])[0] > cen(ref[0])[0] ? 'ours-back' : 'ours-front' : '-', zs: Array.from(new Set(d.objects.filter(o => /^(Ours|Reference) /.test(o.name)).map(o => cen(o)[1].toFixed(3)))).length, hiddenPair: d.objects.slice(0, 2).every(o => NSO_MICROSCOPE.isHidden ? NSO_MICROSCOPE.isHidden(o.name) : true), overlayOff: document.getElementById('ms-compare-overlay').disabled, measureOff: document.getElementById('ms-compare-diff').disabled }; });
    check('Split stack lays the pair\'s interface layers out as pieces on plate 3: one per layer, ours and the reference, all at one height', split.ours === splitPre.la && split.ref === splitPre.lb && split.n === 2 + splitPre.la + splitPre.lb && split.zs === 1, J({ splitPre, split }));
    check('...ours in the back row, the reference in front; the button turns into Join stack, and Overlay / Measure wait', split.back === 'ours-back' && split.label === 'Join stack' && split.overlayOff && split.measureOff, J(split));
    await page.click('#ms-compare-stacks');
    const joined = await page.evaluate(() => ({ n: NSO_MICROSCOPE.getDoc().objects.length, label: document.getElementById('ms-compare-stacks').textContent, overlay: document.getElementById('ms-compare-overlay').disabled }));
    check('Join stack puts the pair back as it was', joined.n === 2 && joined.label === 'Split stack' && joined.overlay === false, J(joined));
    await page.click('#ms-compare-overlay');
    await frames(page);
    const after = [await partCentre(0), await partCentre(1)];
    const st = await page.evaluate(() => NSO_MICROSCOPE.compareState());
    check('the parts\' outlines now coincide in X and Y', Math.abs(after[0][0] - after[1][0]) < 1e-3 && Math.abs(after[0][1] - after[1][1]) < 1e-3, J({ before, after }));
    check('the first piece did not move; the second moved only in XY (its height is its own)', J(after[0]) === J(before[0]) && Math.abs(after[1][2] - before[1][2]) < 1e-9, J({ b0: before[0], a0: after[0], z: [before[1][2], after[1][2]] }));
    check('both are drawn see-through', await page.evaluate(() => { const o = NSO_MICROSCOPE.getDoc().objects; return o.every(x => x.alpha > 0 && x.alpha < 1); }) && st.overlaid, J(st));
    await shot('02-overlay');
    // ...and back: Side by side takes plate 2's piece back beside plate 1's, and so does the Back button
    check('Side by side is on after Overlay', await page.evaluate(() => !document.getElementById('ms-compare-side').disabled));
    await page.click('#ms-compare-side');
    await frames(page);
    const sbs = [await partCentre(0), await partCentre(1)];
    const st2 = await page.evaluate(() => ({ s: NSO_MICROSCOPE.compareState(), alpha: NSO_MICROSCOPE.getDoc().objects.map(x => x.alpha || 0), off: document.getElementById('ms-compare-side').disabled }));
    check('Side by side: both pieces are where Compare set them down, opaque again', J(sbs[0]) === J(before[0]) && J(sbs[1].map(v => +v.toFixed(6))) === J(before[1].map(v => +v.toFixed(6))) && !st2.s.overlaid && st2.alpha.every(a => !a) && st2.off, J({ before, sbs, st2 }));
    await page.click('#ms-compare-overlay');
    await frames(page);
    check('Overlay again, and Back (the top button) is on and undoes it', await page.evaluate(() => !document.getElementById('ms-btn-step-back').disabled));
    await page.click('#ms-btn-step-back');
    await frames(page);
    check('Back puts them side by side', await page.evaluate(() => !NSO_MICROSCOPE.compareState().overlaid) && J(await partCentre(1)).length > 0 && Math.abs((await partCentre(1))[0] - before[1][0]) < 1e-3);
    await page.click('#ms-compare-overlay');
    await frames(page);
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
    const fold = async () => page.evaluate(() => { const b = document.getElementById('ms-compare-diff-fold'), box = document.getElementById('ms-compare-results'); return { btn: b.textContent, exp: b.getAttribute('aria-expanded'), off: b.disabled, hidden: box.hidden, rep: !!NSO_MICROSCOPE.compareReport() }; });
    const f0 = await fold();
    check('a measurement opens its results: the fold button reads Hide, on, and the results show', f0.btn === 'Hide' && f0.exp === 'true' && !f0.off && !f0.hidden && f0.rep, J(f0));
    await page.click('#ms-compare-diff-fold');
    const f1 = await fold();
    check('Hide folds the tables and the worst layers away (so Features is in reach) and keeps the report', f1.btn === 'Show' && f1.exp === 'false' && f1.hidden && f1.rep, J(f1));
    await page.click('#ms-compare-diff-fold');
    const f2 = await fold();
    check('Show opens them again', f2.btn === 'Hide' && !f2.hidden, J(f2));
    await page.click('#ms-compare-diff-fold'); await page.click('#ms-compare-diff');
    const f3 = await fold();
    check('a new Measure opens the results even if they were folded', f3.btn === 'Hide' && !f3.hidden, J(f3));
    await shot('03-measure');
  }

  console.log('\n=== 9. Plates: both whole plates, one click ===');
  {
    const snap = () => page.evaluate(() => { const M = NSO_MICROSCOPE, a = M.plateState('lens'), b = M.plateState('take'); delete a.camera; delete b.camera; return JSON.stringify([a, b]); });
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareClear(); ['lens', 'take'].forEach(n => { M.showPlate(n); }); M.showPlate('lens'); });
    await frames(page);
    const before = await snap();
    const btn = await page.evaluate(() => { const b = document.getElementById('ms-compare-plates'); return { there: !!b, off: b && b.disabled }; });
    check('the Plates button is on the card and enabled with a file on each plate', btn.there && !btn.off, J(btn));
    await page.click('#ms-compare-plates');
    await frames(page);
    const r = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp');
      return { plate: M.plate(), n: d && d.objects.length, names: d && d.objects.map(o => o.name), st: M.compareState(), box: d && d.objects.map(o => [o.bounds.minX, o.bounds.maxX]) }; });
    check('no isolating needed: both whole plates stand on plate 3, side by side', r.plate === 'cmp' && r.n === 2 && /^Plate 1: /.test(r.names[0]) && /^Plate 2: /.test(r.names[1]) && r.box[0][1] < r.box[1][0], J(r));
    check('...as a compare, ready to overlay', r.st && !r.st.overlaid && r.st.tinted, J(r.st));
    check('...and plates 1 and 2 are as they were', await snap() === before);
    await page.click('#ms-compare-overlay');
    await frames(page);
    check('Overlay works from there', await page.evaluate(() => NSO_MICROSCOPE.compareState().overlaid));
  }

  console.log('\n=== 10. Pieces: click a piece on each plate ===');
  {
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    // two whole plates, nothing isolated or selected (earlier sections left some isolated)
    await page.evaluate(() => { const M = NSO_MICROSCOPE; ['take', 'lens'].forEach(n => { M.showPlate(n); M.clearBoxes(); M.back(); }); M.showPlate('take'); });
    await frames(page);
    const snap10 = () => page.evaluate(() => { const M = NSO_MICROSCOPE, a = M.plateState('lens'), b = M.plateState('take'); delete a.camera; delete b.camera; return JSON.stringify([a, b]); });
    const before10 = await snap10();
    await page.click('#ms-compare-pieces');
    await frames(page);
    let r = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate(), st: NSO_MICROSCOPE.compareState() }));
    check('Pieces asks for a click on plate 1 first (and shows it)', r.pick === 'lens' && r.plate === 'lens' && r.st === null, J(r));
    await page.evaluate(() => NSO_MICROSCOPE.pickPiece(0));
    await frames(page);
    r = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate(), st: NSO_MICROSCOPE.compareState() }));
    check('a click on plate 1 moves on to plate 2', r.pick === 'take' && r.plate === 'take' && r.st === null, J(r));
    const placed = await page.evaluate(() => { const v = NSO_MICROSCOPE.getView(); return { x: v.overviewGroup.position.x, lit: v.floors.take.outline.material.color.getHex() !== v.floors.lens.outline.material.color.getHex() }; });
    check('...with plate 2 placed as the active plate (its scene at the origin, its floor lit), not just swapped in behind plate 1', Math.abs(placed.x) < 1e-6 && placed.lit, J(placed));
    await page.evaluate(() => NSO_MICROSCOPE.pickPiece(0));
    await frames(page);
    r = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp');
      return { pick: M.comparePicking(), plate: M.plate(), n: d && d.objects.length, names: d && d.objects.map(o => o.name), st: M.compareState(), box: d && d.objects.map(o => [o.bounds.minX, o.bounds.maxX]) }; });
    check('the click on plate 2 sets both pieces on plate 3, side by side', r.pick === null && r.plate === 'cmp' && r.n === 2 && /^Plate 1: /.test(r.names[0]) && /^Plate 2: /.test(r.names[1]) && r.box[0][1] < r.box[1][0] && r.st && !r.st.overlaid, J(r));
    const after10 = await snap10();
    check('...with no piece left selected or isolated on plates 1 and 2', after10.replace(/"selectionSource":"[a-z]+"/g, '') === before10.replace(/"selectionSource":"[a-z]+"/g, '') && await page.evaluate(() => { const M = NSO_MICROSCOPE; return ['lens', 'take'].every(n => { const s = M.plateState(n); return !s.isolated && !(s.selection && s.selection.length); }); }), after10 === before10 ? '' : J({ before: before10, after: after10 }));
    await page.click('#ms-compare-overlay');
    await frames(page);
    check('...and Overlay works from there', await page.evaluate(() => NSO_MICROSCOPE.compareState().overlaid));
    await page.click('#ms-compare-restore');
    await frames(page);
    const back10 = await page.evaluate(() => { const M = NSO_MICROSCOPE, v = M.getView(), q = new THREE.Vector3(0, 0, 0).project(v.camera); return { plate: M.plate(), cmp: M.plateDoc('cmp'), sel: M.selection().length, onScreen: Math.abs(q.x) < 1 && Math.abs(q.y) < 1 }; });
    check('Clear compare: back to plates 1 and 2 as they were, plate 3 gone, nothing selected, in view', back10.plate === 'lens' && back10.cmp === null && back10.sel === 0 && back10.onScreen && (await snap10()).replace(/"selectionSource":"[a-z]+"/g, '') === before10.replace(/"selectionSource":"[a-z]+"/g, ''), J(back10));
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    await page.evaluate(() => NSO_MICROSCOPE.showPlate('lens'));
    await page.click('#ms-compare-pieces');
    const on = await page.evaluate(() => NSO_MICROSCOPE.comparePicking());
    await page.click('#ms-compare-pieces');
    const off = await page.evaluate(() => NSO_MICROSCOPE.comparePicking());
    check('Pieces again leaves the pick', on === 'lens' && off === null, J([on, off]));
    // Each plate keeps its own mode and isolation: left isolated, or in REGION, a click isolates or places a box and never picks.
    await page.evaluate(() => { const M = NSO_MICROSCOPE; ['take', 'lens'].forEach(n => { M.showPlate(n); M.selectVisible(); M.isolate(); M.setMode('select'); }); });
    await frames(page);
    await page.click('#ms-compare-pieces');
    await frames(page);
    const d1 = await page.evaluate(() => ({ mode: NSO_MICROSCOPE.mode(), iso: NSO_MICROSCOPE.plateState('lens').isolated, sel: NSO_MICROSCOPE.selection().length, pick: NSO_MICROSCOPE.comparePicking() }));
    await page.evaluate(() => NSO_MICROSCOPE.pickPiece(0));
    await frames(page);
    const d2 = await page.evaluate(() => ({ mode: NSO_MICROSCOPE.mode(), iso: NSO_MICROSCOPE.plateState('take').isolated, sel: NSO_MICROSCOPE.selection().length, pick: NSO_MICROSCOPE.comparePicking() }));
    check('Pieces on plates left isolated / in REGION: each plate is made whole and in piece mode to be clicked',
      d1.mode === 'piece' && !d1.iso && d1.sel === 0 && d1.pick === 'lens' && d2.mode === 'piece' && !d2.iso && d2.sel === 0 && d2.pick === 'take', J([d1, d2]));
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    // A real hand moves a few pixels between press and release: that is still a click (it used to start a copy, switch plates, and pick nothing).
    await page.evaluate(() => { const M = NSO_MICROSCOPE; ['take', 'lens'].forEach(n => { M.showPlate(n); M.clearBoxes(); M.back(); }); M.showPlate('lens'); });
    await page.click('#ms-compare-pieces');
    await frames(page);
    const jitterClick = () => page.evaluate(async () => {
      const M = NSO_MICROSCOPE, c = document.querySelector('#microscope canvas'), r = c.getBoundingClientRect(), want = M.comparePicking();
      const fire = (type, x, y, t) => (t || c).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      for (let fy = 0.2; fy <= 0.85; fy += 0.04) for (let fx = 0.2; fx <= 0.85; fx += 0.04) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        fire('pointermove', x, y); fire('pointerdown', x, y); fire('pointermove', x + 5, y + 1, window); fire('pointerup', x + 5, y + 1, window);
        await new Promise(res => setTimeout(res, 30));          // the pick is taken on the next tick
        if (M.comparePicking() !== want || M.plateDoc('cmp')) return true;
      }
      return false;
    });
    const j1 = await jitterClick();
    await new Promise(r => setTimeout(r, 400)); await frames(page);
    const j1s = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate() }));
    const j2 = await jitterClick();
    await new Promise(r => setTimeout(r, 400)); await frames(page);
    const j2s = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate(), cmp: !!NSO_MICROSCOPE.plateDoc('cmp') }));
    check('Pieces: a click that moves five pixels still picks (plate 1, then plate 2, then plate 3)',
      j1 && j1s.pick === 'take' && j1s.plate === 'take' && j2 && j2s.pick === null && j2s.plate === 'cmp' && j2s.cmp, J([j1, j1s, j2, j2s]));
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
  }

  console.log('\n=== 11. Lasso: a loop drawn round a piece on each plate ===');
  {
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    // what the whole plates hold, by the Plates button
    const whole = await page.evaluate(() => { const M = NSO_MICROSCOPE; M.compareStartPlates(); const d = M.plateDoc('cmp'); const n = d.objects.map(o => o.moves.length); M.compareClear(); return n; });
    // a loop dragged on the canvas: its corners are ground points on the active plate (file mm), mapped to the screen
    const draw = async (poly) => {
      await page.waitForTimeout(500); await frames(page);        // the camera has settled: the loop is drawn round what is on screen
      const pts = await page.evaluate((poly) => {
        const M = NSO_MICROSCOPE, v = M.getView(), rect = v.renderer.domElement.getBoundingClientRect();
        return poly.map(([x, y]) => { const p = M.toView(x, y, 0); const q = new THREE.Vector3(p.x, 0, p.z).project(v.camera); return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height]; });
      }, poly);
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      let mid = '';
      for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps: 5 });
      mid = await page.evaluate(() => document.getElementById('ms-compare-read').textContent);
      await page.mouse.up();
      await page.waitForTimeout(80);
      await frames(page);
      return mid;
    };
    // a square (and, for the odd shape, an L) round a box
    const sq = (cx, cy, h) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
    const box = () => page.evaluate(() => {
      const d = NSO_MICROSCOPE.getDoc(); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      d.segments.forEach(s => { x0 = Math.min(x0, s.x0, s.x1); x1 = Math.max(x1, s.x0, s.x1); y0 = Math.min(y0, s.y0, s.y1); y1 = Math.max(y1, s.y0, s.y1); });
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: Math.max(x1 - x0, y1 - y0) / 2 + 3 };
    });
    await page.evaluate(() => NSO_MICROSCOPE.showPlate('lens'));
    await frames(page);
    const btn = await page.evaluate(() => { const b = document.getElementById('ms-compare-lasso'); return { there: !!b, off: b && b.disabled }; });
    check('the Lasso button is on the card and enabled with a file on each plate', btn.there && !btn.off, J(btn));
    await page.click('#ms-compare-lasso');
    let r = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate(), on: document.getElementById('ms-compare-lasso').getAttribute('aria-pressed'), say: document.getElementById('ms-compare-read').textContent }));
    check('Lasso asks for a loop on plate 1 first', r.pick === 'lens' && r.plate === 'lens' && r.on === 'true' && /lasso/i.test(r.say), J(r));
    // an empty spot first: nothing in the loop, still on plate 1
    const b1 = await box();
    await draw(sq(b1.cx + b1.h + 12, b1.cy + b1.h + 12, 4));
    r = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate() }));
    check('a loop round nothing takes nothing and stays on plate 1', r.pick === 'lens' && r.plate === 'lens', J(r));
    { const rt = await page.evaluate(() => document.getElementById('ms-compare-read').textContent); check('...and the readout says so (not the prompt again, as if the loop had not been seen)', /nothing inside/i.test(rt), rt + ' | status: ' + await page.evaluate(() => (document.getElementById('status') || {}).textContent)); }
    const mid = await draw(sq(b1.cx, b1.cy, b1.h));
    r = await page.evaluate(() => ({ pick: NSO_MICROSCOPE.comparePicking(), plate: NSO_MICROSCOPE.plate(), st: NSO_MICROSCOPE.compareState() }));
    check('the read-out counts the loop\'s points while it is drawn', /points/i.test(mid) && /lasso/i.test(mid), mid);
    check('a square drawn round plate 1\'s piece moves on to plate 2', r.pick === 'take' && r.plate === 'take' && r.st === null, J(r));
    const b2 = await box();
    // plate 2: an L-shaped loop that still holds the whole piece (its notch is a corner of the box's margin)
    const L = (cx, cy, h) => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h - 2], [cx + h - 2, cy + h - 2], [cx + h - 2, cy + h], [cx - h, cy + h]];      // a square with a corner notched out: not a circle, not a rectangle
    await draw(L(b2.cx, b2.cy, b2.h));
    r = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.plateDoc('cmp');
      return { pick: M.comparePicking(), plate: M.plate(), n: d && d.objects.length, names: d && d.objects.map(o => o.name), moves: d && d.objects.map(o => o.moves.length), st: M.compareState(), box: d && d.objects.map(o => [o.bounds.minX, o.bounds.maxX]) }; });
    check('the loop on plate 2 sets both on plate 3, side by side', r.pick === null && r.plate === 'cmp' && r.n === 2 && r.box[0][1] < r.box[1][0] && r.st && !r.st.overlaid, J(r));
    check('...each holding everything the loop held, every layer and line type (the same as the whole plate)', J(r.moves) === J(whole), J({ loop: r.moves, whole }));
    await page.click('#ms-compare-overlay');
    await frames(page);
    check('...and Overlay works from there', await page.evaluate(() => NSO_MICROSCOPE.compareState().overlaid));
    await page.click('#ms-compare-restore');
    await frames(page);
    const back11 = await page.evaluate(() => { const M = NSO_MICROSCOPE, v = M.getView(), q = new THREE.Vector3(0, 0, 0).project(v.camera);
      return { plate: M.plate(), cmp: M.plateDoc('cmp'), sel: ['lens', 'take'].map(n => { const s = M.plateState(n); return [s.selection.length, s.isolated]; }), onScreen: Math.abs(q.x) < 1 && Math.abs(q.y) < 1 }; });
    check('Clear compare after a lasso: back on plates 1 and 2, plate 3 gone, nothing selected or isolated, in view', back11.plate === 'lens' && back11.cmp === null && J(back11.sel) === J([[0, false], [0, false]]) && back11.onScreen, J(back11));
    // a small loop takes only what is inside it
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    await page.click('#ms-compare-lasso');
    await draw(sq(b1.cx, b1.cy, Math.max(2, b1.h / 4)));
    await draw(sq(b2.cx, b2.cy, Math.max(2, b2.h / 4)));
    r = await page.evaluate(() => { const d = NSO_MICROSCOPE.plateDoc('cmp'); return d && d.objects.map(o => o.moves.length); });
    check('a small loop takes only the part inside its cylinder', r && r.every((n, i) => n > 0 && n < whole[i]), J({ small: r, whole }));
    // a loop that is not a shape (a line out and back) takes nothing and stays
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    await page.click('#ms-compare-lasso');
    await draw([[b1.cx - 5, b1.cy], [b1.cx + 5, b1.cy]]);
    check('a stroke that does not enclose anything takes nothing', await page.evaluate(() => NSO_MICROSCOPE.comparePicking() === 'lens'));
    // Esc leaves the pick
    await page.evaluate(() => NSO_MICROSCOPE.compareClear());
    await page.click('#ms-compare-lasso');
    await page.keyboard.press('Escape');
    check('Escape leaves the pick', await page.evaluate(() => NSO_MICROSCOPE.comparePicking() === null));
  }

  check('no page errors', logs.filter(l => /^\[pageerror\]/.test(l)).length === 0, logs.filter(l => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});

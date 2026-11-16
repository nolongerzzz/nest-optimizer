#!/usr/bin/env node
/* The card regroup (2026-11-16), driven through the REAL app in headless Chromium.

     node tools/nso_card_regroup_drive.js [outdir]     exit 0 = every gate held

   1. The row ends Lock position, Lock plate, PRINT; Gen+ is gone from it.
   2. The column: GENERATE, SCALE, CUT / CROP, PUNCH, DRAW, ADD, SUBTRACT | SHAPE, TEXT, PAINT,
      SURFACE & EDGES, SCULPT, ASSEMBLE | G-SCOPE, FILL & FIX, CHECK & REPAIR. Crop has no
      slab of its own; Weave has no column slab.
   3. CUT / CROP: the Cut slab opens Cut with the switch on Cut; the switch's Crop opens the
      Crop card at the same spot (Cut shut, the cutter tool is 'crop', the Cut slab still lit);
      its Cut goes back; the Cut slab pressed while Crop is open shuts the card.
   4. COOKIE-CUTTER: the Crop card's Cookie-Cutter shape takes another piece as the cutter
      (the piece being cropped is refused in words) and CROP adds the overlap as a new piece.
   5. FILL & FIX holds Fill / Densify, Foam, GUN, Patch and Weave; Add no longer does; opening
      its Weave section arms Weave, shutting the card disarms it.
   6. PUNCH is its own card, Subtract no longer holds it; opening the card arms Punch, Escape
      puts Punch away and shuts the card.
   7. PRINT opens from the row at the one panel spot; GENERATE from the column.        */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const OUTDIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'nso-card-regroup-' + process.pid);
fs.mkdirSync(OUTDIR, { recursive: true });
const HINGE = path.join(ROOT, 'library', 'hinge_knuckle_box.stl');
const TUBE = path.join(ROOT, 'library', 'soften_test_03_thinwall_tube.stl');

const label = (page, sel) => page.evaluate(s => {
  const e = document.querySelector(s); if (!e) return null;
  const t = e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
  return t.textContent.trim().toUpperCase();
}, sel);
const panelBox = (page, id) => page.evaluate(i => {
  const b = document.querySelector('#' + i + ' > .vp-menu-body'); if (!b) return null;
  const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), vis: r.width > 0 && getComputedStyle(b).display !== 'none' };
}, id);
const isOpen = (page, id) => page.evaluate(i => !!document.getElementById(i).open, id);
const switchOn = (page, id) => page.evaluate(i => {
  const b = document.querySelector('#' + i + ' .cutcrop-toggle .is-on'); return b ? b.getAttribute('data-cutcrop') : null;
}, id);
const lit = (page, sel) => page.evaluate(s => getComputedStyle(document.querySelector(s)).borderColor, sel);

withApp(async page => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(500);

  console.log('\n=== 1. the row ===');
  const row = await page.evaluate(() => Array.from(document.querySelector('.vp-shell-row').children)
    .filter(e => e.offsetParent !== null || e.tagName === 'DETAILS').map(e => e.id).filter(Boolean));
  const iLock = row.indexOf('btn-plate-lock');
  check('PRINT sits right after Lock plate', row[iLock + 1] === 'menu-supports', row.join(','));
  check('...and is labelled PRINT', (await label(page, '#menu-supports')) === 'PRINT');
  check('Gen+ is not in the row', !row.includes('menu-gen'));
  const geo = await page.evaluate(() => {
    const r = id => document.querySelector('#' + id + (document.getElementById(id).tagName === 'DETAILS' ? ' > summary' : '')).getBoundingClientRect();
    return { lock: r('btn-plate-lock'), print: r('menu-supports'), undo: r('btn-undo') };
  });
  check('PRINT is on the row, right of Lock plate and left of Undo',
    Math.abs(geo.print.top - geo.lock.top) < 2 && geo.print.left > geo.lock.right && geo.print.right < geo.undo.left, JSON.stringify(geo.print));

  console.log('\n=== 2. the column ===');
  const col = await page.evaluate(() => Array.from(document.querySelector('.vp-shell-col').children).filter(e => {
    if (e.matches('input, .vp-shell-view')) return false;
    const s = e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
    return s && s.getBoundingClientRect().height > 0;
  }).map(e => (e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e).textContent.trim().toUpperCase()));
  const WANT = ['GENERATE', 'SCALE', 'CUT / CROP', 'PUNCH', 'DRAW', 'ADD', 'SUBTRACT', 'SHAPE', 'TEXT', 'PAINT', 'SURFACE & EDGES', 'SCULPT', 'ASSEMBLE', 'G-SCOPE', 'FILL & FIX', 'CHECK & REPAIR'];
  check('the column, top to bottom', col.join('|') === WANT.join('|'), col.join('|'));
  const gaps = await page.evaluate(() => {
    const r = id => document.querySelector('#' + id + ' > summary, #' + id + '.vp-bar-btn').getBoundingClientRect();
    return { genUnderImport: r('menu-gen').top - r('menu-import').bottom, scaleUnderGen: r('menu-scale').top - r('menu-gen').bottom,
             punchUnderCut: r('menu-punch').top - r('menu-cut').bottom, asmUnderSculpt: r('menu-assemble').top - r('menu-sculpt').bottom,
             fixUnderScope: r('menu-fillfix').top - r('btn-microscope').bottom, repairUnderFix: r('menu-repair').top - r('menu-fillfix').bottom,
             colBottom: document.getElementById('btn-xray').getBoundingClientRect().bottom, vh: innerHeight };
  });
  check('GENERATE right under Import, SCALE right under it', gaps.genUnderImport > 0 && gaps.genUnderImport < 14 && gaps.scaleUnderGen >= 0 && gaps.scaleUnderGen < 8, JSON.stringify(gaps));
  check('PUNCH right under CUT (Crop takes no room)', gaps.punchUnderCut >= 0 && gaps.punchUnderCut < 8, String(gaps.punchUnderCut));
  check('ASSEMBLE right under SCULPT', gaps.asmUnderSculpt >= 0 && gaps.asmUnderSculpt < 8, String(gaps.asmUnderSculpt));
  check('FILL & FIX under G-SCOPE, CHECK & REPAIR right under it', gaps.fixUnderScope > 0 && gaps.repairUnderFix >= 0 && gaps.repairUnderFix < 8, JSON.stringify(gaps));
  check('the column fits the window', gaps.colBottom <= gaps.vh, gaps.colBottom + ' / ' + gaps.vh);
  for (const vh of [800, 720]) {
    await page.setViewportSize({ width: 1280, height: vh });
    await page.waitForTimeout(150);
    const b = await page.evaluate(() => document.getElementById('btn-xray').getBoundingClientRect().bottom);
    const ov = await page.evaluate(() => { const a = document.querySelector('#menu-assemble > summary').getBoundingClientRect(), g = document.getElementById('btn-microscope').getBoundingClientRect(); return g.top - a.bottom; });
    check('at 1280 x ' + vh + ' the column fits and Assemble clears G-scope', b <= vh && ov >= 0, 'bottom ' + b + ', gap ' + ov);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(OUTDIR, '1-shell.png') });

  console.log('\n=== 3. CUT / CROP ===');
  const hid = await loadSTL(page, HINGE);
  const tid = await loadSTL(page, TUBE);
  await page.evaluate(h => selectPlaced(state.placed.findIndex(q => q.sourceId === h)), hid);
  await page.click('#menu-cut > summary');
  check('the Cut slab opens Cut, the switch on Cut', await isOpen(page, 'menu-cut') && (await switchOn(page, 'menu-cut')) === 'cut');
  check('...and the cutter is the Cut tool', await page.evaluate(() => state.cutterOpen && (state.cutTool || 'cut') === 'cut'));
  const cutSpot = await panelBox(page, 'menu-cut');
  await page.screenshot({ path: path.join(OUTDIR, '2-cut.png') });
  await page.click('#menu-cut .cutcrop-opt[data-cutcrop="crop"]');
  await page.waitForTimeout(100);
  const cropSpot = await panelBox(page, 'menu-crop');
  check('the switch\'s Crop opens the Crop card and shuts Cut', await isOpen(page, 'menu-crop') && !(await isOpen(page, 'menu-cut')));
  check('...at the same spot', cropSpot.vis && cropSpot.x === cutSpot.x && cropSpot.y === cutSpot.y, JSON.stringify([cutSpot, cropSpot]));
  check('...the switch there is on Crop', (await switchOn(page, 'menu-crop')) === 'crop');
  check('...the cutter tool is Crop', await page.evaluate(() => state.cutterOpen && state.cutTool === 'crop'));
  check('...the Cut slab stays lit', /125, 211, 252/.test(await lit(page, '#menu-cut > summary')), await lit(page, '#menu-cut > summary'));
  check('...and the piece is still picked', await page.evaluate(h => state.placed[state.selectedIndex] && state.placed[state.selectedIndex].sourceId === h, hid));
  await page.screenshot({ path: path.join(OUTDIR, '3-crop.png') });
  await page.click('#menu-crop .cutcrop-opt[data-cutcrop="cut"]');
  await page.waitForTimeout(100);
  check('its Cut goes back to the Cut card', await isOpen(page, 'menu-cut') && !(await isOpen(page, 'menu-crop')) && await page.evaluate(() => (state.cutTool || 'cut') === 'cut'));
  await page.click('#menu-cut .cutcrop-opt[data-cutcrop="crop"]');
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(100);
  check('the Cut slab pressed while Crop is open shuts the card', !(await isOpen(page, 'menu-crop')) && !(await isOpen(page, 'menu-cut')) && await page.evaluate(() => !state.cutterOpen));

  console.log('\n=== 4. COOKIE-CUTTER ===');
  await page.evaluate(h => selectPlaced(state.placed.findIndex(q => q.sourceId === h)), hid);
  await page.evaluate(() => NSO_CutCrop.show('crop'));
  const shapeRow = await page.evaluate(() => Array.from(document.querySelectorAll('#crop-shape-row button')).map(b => b.textContent.trim()));
  check('the Shape row has Cookie-Cutter', shapeRow.includes('Cookie-Cutter'), shapeRow.join(','));
  await page.click('#btn-crop-shape-piece');
  const ro0 = await page.evaluate(() => document.getElementById('crop-readout').textContent);
  check('picked, it waits for another piece', /^Cookie-Cutter: click another piece/.test(ro0), ro0);
  /* The click a person makes, on each piece in turn - taken through the card's own pick, as a ray from the screen. */
  const clickOn = id => page.evaluate(i => {
    const p = state.placed.find(q => q.sourceId === i), rc = state.renderer.domElement.getBoundingClientRect();
    for (let gx = 0.05; gx < 0.95; gx += 0.01) for (let gy = 0.05; gy < 0.95; gy += 0.01) {
      const x = rc.left + gx * rc.width, y = rc.top + gy * rc.height;
      if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
      state.raycaster.setFromCamera(new THREE.Vector2(gx * 2 - 1, 1 - gy * 2), state.camera);
      let h = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(q => q.faceIndex != null);
      if (nsoHelpers.pieceHits) h = nsoHelpers.pieceHits(h);
      if (h.length && h[0].object === p.mesh) return { x, y };
    }
    return null;
  }, id);
  const own = await clickOn(hid);
  if (own) { await page.mouse.click(own.x, own.y); await page.waitForTimeout(150); }
  const said = await page.evaluate(() => document.getElementById('status').textContent);
  check('a click on the piece being cropped is refused in words', !!own && /That is the piece being cropped/.test(said)
    && await page.evaluate(() => NSO_CropCard.state().piece.id == null), JSON.stringify(own) + ' ' + said);
  /* Then the tube is stood over the hinge, so the two overlap, and clicked. */
  await page.evaluate(([m, o]) => {
    const a = state.placed.find(q => q.sourceId === m), b = state.placed.find(q => q.sourceId === o);
    a.mesh.position.x = b.mesh.position.x; a.mesh.position.z = b.mesh.position.z; a.x = b.x; a.z = b.z; a.mesh.updateMatrixWorld(true);
  }, [tid, hid]);
  const other = await clickOn(tid);
  if (other) await page.mouse.click(other.x, other.y);
  check('a click on the tube makes it the cutter', !!other && await page.evaluate(t => NSO_CropCard.state().piece.id === t, tid));
  await page.waitForFunction(() => !!NSO_CropCard.state().plan && !NSO_CropCard.state().timer, null, { timeout: 30000 }).catch(() => {});
  const ro = await page.evaluate(() => document.getElementById('crop-readout').textContent);
  check('the readout is "Cookie-Cutter <name> · holds …"', /^Cookie-Cutter soften_test_03_thinwall_tube · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
  await page.screenshot({ path: path.join(OUTDIR, '4-cookie-cutter.png') });
  const n0 = await page.evaluate(() => state.models.length);
  await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 }).catch(() => {});
  await page.click('#btn-crop');
  await page.waitForFunction(k => state.models.length > k, n0, { timeout: 60000 }).catch(() => {});
  const nm = await page.evaluate(() => state.models[state.models.length - 1].name);
  check('CROP adds the overlap as "<name> crop N"', /^hinge_knuckle_box crop \d+$/.test(nm), nm);
  await page.click('#btn-undo');
  await page.evaluate(() => NSO_CropCard.cancel(true));
  await page.evaluate(() => { document.getElementById('menu-crop').open = false; });

  console.log('\n=== 5. FILL & FIX ===');
  const fx = await page.evaluate(() => {
    const has = (c, id) => !!document.querySelector('#' + c + ' #' + id);
    return { fix: ['btn-fill', 'btn-foam', 'btn-foam-gun', 'foam-panel', 'foam-gun-panel', 'btn-patch', 'patch-readout', 'menu-weave', 'weave-card'].filter(i => !has('menu-fillfix', i)),
             add: ['btn-fill', 'btn-foam', 'btn-foam-gun', 'btn-patch', 'menu-weave'].filter(i => has('menu-add', i)),
             addKeeps: ['btn-thicken-out', 'btn-close', 'btn-bridge'].filter(i => !has('menu-add', i)) };
  });
  check('Fill & fix holds Fill / Densify, Foam, GUN, Patch and Weave', fx.fix.length === 0, 'missing ' + fx.fix.join(','));
  check('...and Add holds none of them (Thicken, Close, Bridge stay)', fx.add.length === 0 && fx.addKeeps.length === 0, JSON.stringify(fx));
  await page.click('#menu-fillfix > summary');
  check('Fill & fix opens at the panel spot', JSON.stringify(await panelBox(page, 'menu-fillfix')).includes('"x":' + cutSpot.x));
  await page.click('#menu-weave > summary');
  await page.waitForTimeout(100);
  check('opening its Weave section arms Weave', await page.evaluate(() => !!NSO_weaveUI().open) && await isOpen(page, 'menu-fillfix'));
  await page.screenshot({ path: path.join(OUTDIR, '5-fillfix.png') });
  await page.click('#menu-fillfix > summary');
  await page.waitForTimeout(100);
  check('shutting the card disarms it', await page.evaluate(() => !NSO_weaveUI().open));
  await page.click('#menu-fillfix > summary');
  await page.click('#btn-foam-gun');
  await page.waitForTimeout(150);
  check('GUN still answers from Fill & fix (its panel shows)', await page.evaluate(() => !document.getElementById('foam-gun-panel').hidden));
  await page.keyboard.press('Escape');
  await page.click('#menu-fillfix > summary').catch(() => {});

  console.log('\n=== 6. PUNCH ===');
  check('Punch is its own card; Subtract no longer holds it', await page.evaluate(() =>
    !!document.querySelector('#menu-punch #punch-card') && !document.querySelector('#menu-bit #punch-card') && !document.getElementById('btn-punch')));
  await page.evaluate(() => { document.querySelectorAll('.vp-menu[open]').forEach(d => { d.open = false; }); });
  await page.evaluate(h => selectPlaced(state.placed.findIndex(q => q.sourceId === h)), hid);
  await page.click('#menu-punch > summary');
  await page.waitForTimeout(150);
  check('opening the Punch card arms Punch', await page.evaluate(() => nsoPunchState().open && !document.getElementById('punch-card').hidden));
  await page.screenshot({ path: path.join(OUTDIR, '6-punch.png') });
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Escape puts Punch away and shuts its card', await page.evaluate(() => !nsoPunchState().open && !document.getElementById('menu-punch').open));
  await page.click('#menu-punch > summary');
  await page.waitForTimeout(100);
  await page.click('#menu-punch > summary');
  await page.waitForTimeout(150);
  check('shutting the card puts Punch away', await page.evaluate(() => !nsoPunchState().open));

  console.log('\n=== 7. PRINT, GENERATE ===');
  await page.evaluate(() => { document.querySelectorAll('.vp-menu[open]').forEach(d => { d.open = false; }); });
  await page.click('#menu-supports > summary');
  const pp = await panelBox(page, 'menu-supports');
  check('PRINT opens from the row at the panel spot', await isOpen(page, 'menu-supports') && pp.vis && pp.x === cutSpot.x && pp.y === cutSpot.y, JSON.stringify(pp));
  await page.screenshot({ path: path.join(OUTDIR, '7-print.png') });
  await page.click('#menu-gen > summary');
  const gp = await panelBox(page, 'menu-gen');
  check('GENERATE opens from the column at the panel spot, and shuts Print', await isOpen(page, 'menu-gen') && !(await isOpen(page, 'menu-supports')) && gp.x === cutSpot.x, JSON.stringify(gp));
  await page.screenshot({ path: path.join(OUTDIR, '8-generate.png') });
}).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed   (screenshots: ' + OUTDIR + ')');
  process.exit(fail ? 1 : 0);
}, e => { console.error(e); process.exit(1); });

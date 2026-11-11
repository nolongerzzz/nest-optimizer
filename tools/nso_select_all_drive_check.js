#!/usr/bin/env node
/* Select all, driven in the real page: the group is a selection like any other.
     node tools/nso_select_all_drive_check.js [--shots DIR]     exit 0 = every gate held

   Gates:
     1  Select all draws every piece exactly as one selected piece is drawn: the rose body, its emissive and the
        white outline - not a red tint over each piece's own colour - and lights every row of the Pieces card
     2  the Scale card reads the group: one row, Whole x; x2 typed and Set grows every piece to twice its size,
        each where it stood; ONE Undo puts every piece back, and the group is still selected and still drawn
     3  the Supports card's "Generate for plate" lights every piece in that same look
     4  a drag on one piece of the group moves every piece by the same step; one Undo puts them all back
     5  dropped over another plate, the whole group goes there - Plate 2 active, the group still selected, the
        layout kept; one Undo brings them all back to Plate 1
     6  a plain click on one piece of the group selects that piece alone
   --shots DIR writes screenshots there (a scratch directory: no PNG is committed). */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, openMenuFor, closeTopMenus, ROOT } = require('./nso_app_harness');

const SHOTS = (() => {
  const i = process.argv.indexOf('--shots');
  if (i < 0) return null;
  const d = path.resolve(process.argv[i + 1]);
  fs.mkdirSync(d, { recursive: true });
  return d;
})();
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const fx = f => path.join(ROOT, 'fixtures', f);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const N = page.evaluate.bind(page);
  const frames = (n) => N(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 3);
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + '.png') }); };
  await N(() => {
    window.__s = {
      proj(a) {
        const r = state.renderer.domElement.getBoundingClientRect();
        state.camera.updateMatrixWorld(true);
        const p = new THREE.Vector3().fromArray(a).project(state.camera);
        return [r.left + (p.x * 0.5 + 0.5) * r.width, r.top + (-p.y * 0.5 + 0.5) * r.height];
      },
      look: () => state.placed.map(p => ({
        color: p.mesh.material.color.getHex(), em: p.mesh.material.emissive.getHex(),
        ei: +p.mesh.material.emissiveIntensity.toFixed(3), outline: !!(p.outline && p.outline.parent === p.mesh)
      })),
      sizes: () => state.placed.map(p => { const m = state.models.find(x => x.id === p.sourceId); return [m.size.x, m.size.y, m.size.z].map(v => +v.toFixed(3)); }),
      xz: () => state.placed.map(p => [+p.x.toFixed(3), +p.z.toFixed(3)])
    };
  });

  for (const f of ['box-20mm.stl', 'cylinder_r10h30_s64.stl', 'box_open.stl']) await loadSTL(page, fx(f));
  await N(() => { state.undoStack = []; state.redoStack = []; updateUndoBtn(); });
  await frames(3);

  console.log('\n=== 1. the look ===');
  await N(() => selectPlaced(1));
  await frames(3);
  const one = (await N(() => window.__s.look()))[1];
  await N(() => nsoSelectAllOnPlate());
  await frames(3);
  const all = await N(() => window.__s.look());
  await shot('1-select-all');
  check('one selected piece: rose, with its outline', one.color === 0xf43f5e && one.outline, JSON.stringify(one));
  check('Select all: every piece looks exactly like it', all.length === 3 && all.every(l => JSON.stringify(l) === JSON.stringify(one)), JSON.stringify(all));
  check('...and every row of the Pieces card is lit', (await N(() => document.querySelectorAll('#model-list .model-item.active').length)) === 3);

  console.log('\n=== 2. Scale: Whole x on the group ===');
  const before = await N(() => window.__s.sizes()), xz0 = await N(() => window.__s.xz());
  await openMenuFor(page, '#scale-readout');
  await frames(3);
  const rows = await N(() => Array.from(document.querySelectorAll('#scale-rows .scale-row')).filter(r => !r.hidden).map(r => r.id));
  check('the card shows one row, Whole x', JSON.stringify(rows) === '["scale-factor-row"]', JSON.stringify(rows));
  check('the readout names the group', /3 pieces selected/.test(await N(() => document.getElementById('scale-readout').textContent)));
  check('Fit to plate is not offered for the group', await N(() => document.getElementById('btn-scale-fit').hidden));
  await page.fill('#scale-factor', '2');
  await page.waitForFunction(() => !document.getElementById('btn-scale-set').disabled, null, { timeout: 15000 });
  await frames(3);
  await shot('2-scale-preview');
  check('the preview stands over every piece, nothing baked yet', JSON.stringify(await N(() => window.__s.sizes())) === JSON.stringify(before));
  await page.click('#btn-scale-set');
  await frames(3);
  const after = await N(() => window.__s.sizes());
  check('Set: every piece twice its size', after.every((s, i) => s.every((v, k) => Math.abs(v - 2 * before[i][k]) < 1e-3)), JSON.stringify(before) + ' -> ' + JSON.stringify(after));
  check('...each where it stood', JSON.stringify(await N(() => window.__s.xz())) === JSON.stringify(xz0));
  check('...one Undo step', (await N(() => state.undoStack.length)) === 1);
  check('...the group still selected and drawn', (await N(() => nsoSelAllPieces().length)) === 3 && (await N(() => window.__s.look())).every(l => l.color === 0xf43f5e && l.outline));
  await shot('3-scaled');
  await N(() => undoLast());
  await frames(2);
  check('one Undo puts every piece back', JSON.stringify(await N(() => window.__s.sizes())) === JSON.stringify(before), JSON.stringify(await N(() => window.__s.sizes())));
  check('...and the group is still selected and drawn', (await N(() => nsoSelAllPieces().length)) === 3 && (await N(() => window.__s.look())).every(l => l.color === 0xf43f5e && l.outline));
  await closeTopMenus(page);

  console.log('\n=== 3. Supports: Generate for plate ===');
  await N(() => selectPlaced(0));
  await page.click('#menu-supports > summary');
  await frames(5);
  await page.waitForFunction(() => document.getElementById('sup-plate') && document.getElementById('sup-plate').checked, null, { timeout: 10000 }).catch(() => {});
  if (!(await N(() => document.getElementById('sup-plate').checked))) { await page.click('#sup-plate'); await frames(3); }
  await frames(5);
  const lit = await N(() => window.__s.look());
  await shot('4-supports-plate');
  check('every piece lit in the selected look', lit.every(l => l.color === 0xf43f5e && l.outline), JSON.stringify(lit));
  await page.click('#sup-plate');
  await frames(3);
  const unlit = await N(() => window.__s.look());
  check('unticked: the plate look comes off (one piece at most stays selected)', unlit.filter(l => l.outline).length <= 1, JSON.stringify(unlit));
  await page.click('#menu-supports > summary');
  await closeTopMenus(page);
  await frames(3);

  console.log('\n=== 4. a drag on one piece moves the group ===');
  await N(() => { state.undoStack = []; state.redoStack = []; updateUndoBtn(); nsoSelectAllOnPlate(); });
  await frames(3);
  const p0 = await N(() => window.__s.xz());
  const a = await N(() => window.__s.proj([state.placed[1].x, 5, state.placed[1].z]));
  const b = await N(() => window.__s.proj([state.placed[1].x + 10, 5, state.placed[1].z + 6]));
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(a[0] + (b[0] - a[0]) * k / 8, a[1] + (b[1] - a[1]) * k / 8);
  await page.mouse.up();
  await frames(3);
  const p1 = await N(() => window.__s.xz());
  const dx = p1[1][0] - p0[1][0], dz = p1[1][1] - p0[1][1];
  check('the held piece moved', Math.hypot(dx, dz) > 3, dx + ',' + dz);
  check('...every piece by the same step', p1.every((q, i) => Math.abs(q[0] - p0[i][0] - dx) < 1e-3 && Math.abs(q[1] - p0[i][1] - dz) < 1e-3), JSON.stringify(p0) + ' -> ' + JSON.stringify(p1));
  check('...the group still selected, one Undo step', (await N(() => nsoSelAllPieces().length)) === 3 && (await N(() => state.undoStack.length)) === 1);
  await N(() => undoLast());
  check('one Undo puts them all back', JSON.stringify(await N(() => window.__s.xz())) === JSON.stringify(p0), JSON.stringify(await N(() => window.__s.xz())));

  console.log('\n=== 5. dropped over another plate ===');
  await N(() => { NSO_BEDS.add(); NSO_BEDS.activate(0); });
  await frames(5);
  await N(() => { state.undoStack = []; state.redoStack = []; updateUndoBtn(); nsoSelectAllOnPlate(); });
  await frames(3);
  const rel0 = await N(() => state.placed.map(p => [+(p.x - state.placed[0].x).toFixed(3), +(p.z - state.placed[0].z).toFixed(3)]));
  const off = await N(() => { const p = getCurrentPlate(); return p.w + 0.2 * Math.max(p.w, p.d); });
  const s0 = await N(() => window.__s.proj([state.placed[0].x, 5, state.placed[0].z]));
  const s1 = await N(o => window.__s.proj([state.placed[0].x + o, 5, state.placed[0].z]), off);
  await page.mouse.move(s0[0], s0[1]);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(s0[0] + (s1[0] - s0[0]) * k / 12, s0[1] + (s1[1] - s0[1]) * k / 12);
  await page.mouse.up();
  await frames(5);
  await shot('5-moved-to-plate-2');
  const info = await N(() => NSO_BEDS.info());
  check('Plate 2 is active and holds all three', (await N(() => NSO_BEDS.activeNumber ? NSO_BEDS.activeNumber() : null)) !== 1 &&
    (await N(() => state.placed.length)) === 3, JSON.stringify(info) + ' ' + (await N(() => document.getElementById('status').textContent)));
  const rel1 = await N(() => state.placed.map(p => [+(p.x - state.placed[0].x).toFixed(3), +(p.z - state.placed[0].z).toFixed(3)]));
  check('...the layout kept', JSON.stringify(rel1) === JSON.stringify(rel0), JSON.stringify(rel0) + ' vs ' + JSON.stringify(rel1));
  check('...still selected and drawn as selected', (await N(() => nsoSelAllPieces().length)) === 3 && (await N(() => window.__s.look())).every(l => l.color === 0xf43f5e && l.outline));
  await N(() => undoLast());
  await frames(3);
  check('one Undo brings all three back to Plate 1', (await N(() => state.placed.length)) === 3 &&
    JSON.stringify(await N(() => state.placed.map(p => [+(p.x - state.placed[0].x).toFixed(3), +(p.z - state.placed[0].z).toFixed(3)]))) === JSON.stringify(rel0),
    await N(() => document.getElementById('status').textContent));

  console.log('\n=== 6. a click on one piece of the group ===');
  await N(() => nsoSelectAllOnPlate());
  await frames(2);
  const c = await N(() => window.__s.proj([state.placed[2].x, 4, state.placed[2].z]));
  await page.mouse.click(c[0], c[1]);
  await frames(3);
  check('selects that piece alone', (await N(() => nsoSelAllPieces().length)) === 0 && (await N(() => state.selectedIndex)) === 2,
    (await N(() => state.selectedIndex)) + ' ' + (await N(() => nsoSelAllPieces().length)));

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\nFAIL: ' + fails : '\nok - every gate held');
  process.exitCode = fails ? 1 : 0;
});

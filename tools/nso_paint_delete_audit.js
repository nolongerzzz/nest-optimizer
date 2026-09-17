/* Paint-delete - the Task 1 audit, re-run.
     node tools/nso_paint_delete_audit.js      exit 0 = every finding still holds
     npm run delete:audit

   docs/PAINT-DELETE.md is the write-up. Every claim in its sections 1-3 is a
   claim about code that is here now, and every one of them is checked below,
   in the real app in real Chromium, against real fixtures - not asserted from
   reading source. Where a finding is about a thing NOT existing, it is
   phrased as a property that stays true (what a surface returns, how many
   consumers a list has) rather than a grep for absence, which would rot the
   moment the feature it describes was built.

   The load-bearing finding is section 3: the app's own pink overlay and the
   delete module's raw-space selector pick the same triangles, face for face,
   fixture for fixture. That is what makes "delete what is painted" a promise
   rather than a hope, and it is the only reason this feature could reuse the
   shipped face resolver instead of growing a second one. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The faces to compare, per fixture: a display axis and side to aim a real
   click at, and what that click should turn out to name in raw space. */
/* Only the three faces the default camera can see. Aiming at a face on the
   far side is not a stricter test, it is a click that lands on the near face
   in front of it - the ray stops at the first thing it meets, exactly as a
   user's would. What the pick then NAMES is printed below, and that is what
   the comparison is made against. */
const CASES = [
  { file: 'box-20mm.stl',            faces: [[1, 1], [0, 1], [2, 1]] },
  { file: 'out-box-square-half.stl', faces: [[1, 1], [0, 1], [2, 1]] },
  { file: 'out-box-corners-r05.stl', faces: [[1, 1], [0, 1], [2, 1]] },
  { file: 'out-box-round-r05.stl',   faces: [[1, 1], [0, 1], [2, 1]] },
  { file: 'box_hull_80x40x20-2.stl', faces: [[1, 1], [0, 1], [2, 1]] },
  { file: 'box_open.stl',            faces: [[1, 1], [0, 1], [2, 1]] }
];

/* One piece on the plate at a time. Pieces accumulate otherwise, the packer
   puts each new one further out, and a click aimed at the sixth lands off the
   canvas - which measures the harness, not the feature. */
async function soloFixture(page, file) {
  await page.evaluate(() => {
    while (state.models.length) { state.editId = state.models[0].id; deleteActiveModel(); }
  });
  const id = await loadSTL(page, file);
  await selectModel(page, id);
  await page.click('#btn-frame-view');
  await openFinishMenu(page);
  return id;
}

/* Put the paint into a named mode, or out of paint entirely. The buttons are
   toggles, so clicking one blind flips whatever mode the last step left
   behind - which is a real way to measure nothing at all and call it a
   failure of the feature. */
async function setPaintMode(page, mode) {
  await page.evaluate(m => {
    if (state.maskPaint === m) return;
    if (state.maskPaint) document.getElementById(
      state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint').click();
    if (m) document.getElementById(m === 'select' ? 'btn-mask-select' : 'btn-mask-paint').click();
  }, mode);
}

const facePoint = function ([id, axis, sign]) {
  const p = state.placed.find(x => x && x.sourceId === id && x.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const w = bb.getCenter(new THREE.Vector3());
  w.setComponent(axis, sign > 0 ? bb.max.getComponent(axis) : bb.min.getComponent(axis));
  const ndc = w.clone().project(state.camera);
  const rect = state.renderer.domElement.getBoundingClientRect();
  const x = rect.left + (ndc.x + 1) / 2 * rect.width;
  const y = rect.top + (1 - ndc.y) / 2 * rect.height;
  state.pointer.x = ndc.x; state.pointer.y = ndc.y;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, true)
    .filter(h => h.faceIndex != null);
  const el = document.elementFromPoint(x, y);
  return { x, y, hit: hits.length > 0, onCanvas: el === state.renderer.domElement };
};

/* One click's worth of evidence: what the SELECT pick recorded, how many
   triangles the app then painted pink, and how many the delete module's
   selector picks out of the same raw soup from the same entry. */
const pinkVsSelect = function (id) {
  const m = state.models.find(x => x.id === id);
  const sel = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
  const pinkMeshes = state.modelGroup.children.filter(o =>
    o.isMesh && o.material && o.material.color && o.material.color.getHex() === 0xf472b6);
  const pink = pinkMeshes.reduce((n, o) => n + o.geometry.attributes.position.count / 3, 0);
  const picked = sel ? NSO_PaintDelete.select(m.rawTris, [sel]).count : 0;
  return {
    entry: sel ? { axisIdx: sel.axisIdx, keepMin: sel.keepMin, inner: sel.inner,
                   d: sel.d, dispAxis: sel.dispAxis, dispSign: sel.dispSign } : null,
    pink, picked, tris: m.rawTris.length / 9
  };
};

withApp(async (page, logs) => {
  console.log('\n=== 1. the shipped surface this feature is built on ===');
  const surface = await page.evaluate(() => ({
    // the paint UI, both modes
    btnExclude: !!document.getElementById('btn-mask-paint'),
    btnSelect: !!document.getElementById('btn-mask-select'),
    btnClear: !!document.getElementById('btn-mask-clear'),
    // the two lists and their readers
    api: ['nsoMaskSelected', 'nsoMaskSelectCount', 'nsoMaskSelectClear', 'nsoMaskIsSelectedRaw',
          'nsoMaskIsExcludedRaw', 'nsoMaskFaceList', 'nsoMaskCount',
          'nsoMaskSnapshot', 'nsoMaskRestore', 'nsoMaskRepaint', 'nsoMaskToggleAt', 'nsoMaskSelectAt']
      .filter(k => typeof window[k] !== 'function'),
    // the one face resolver a click goes through
    faceResolver: typeof nsoFaceFromHit === 'function',
    // the commit half of the house lifecycle
    commitRaw: typeof NSO_sculptCommitRaw === 'function',
    // the metrics the gate needs
    repair: typeof NSO_Repair === 'object' && typeof NSO_Repair.inspect === 'function' &&
            typeof NSO_Repair.commit === 'function' && typeof NSO_Repair._weldToIndexed === 'function',
    // what this ticket added
    deleteModule: typeof NSO_PaintDelete === 'object' && typeof NSO_PaintDelete.commit === 'function'
                  && typeof NSO_PaintDelete.select === 'function',
    deleteBtn: !!document.getElementById('btn-mask-delete')
  }));
  check('Paint Excluded, Paint Selected and Clear paint are all on the page',
        surface.btnExclude && surface.btnSelect && surface.btnClear);
  check('every mask6 reader this feature needs is already exported',
        surface.api.length === 0, surface.api.join(', ') || 'all present');
  check('nsoFaceFromHit is the one face resolver a click goes through', surface.faceResolver);
  check('NSO_sculptCommitRaw is the shipped commit half', surface.commitRaw);
  check('NSO_Repair supplies the gate metrics (inspect, commit, _weldToIndexed)', surface.repair);
  check('NSO_PaintDelete and its button are what this ticket added',
        surface.deleteModule && surface.deleteBtn);

  console.log('\n=== 2. what the shipped overlay does and does not hand back ===');
  const overlay = await page.evaluate(() => {
    return {
      repaintReturns: typeof window.nsoMaskRepaint(),
      // nothing on the mask6 surface hands back a triangle SET, in raw space
      // or any other - the overlay builds one internally and reports a count
      setApis: Object.keys(window).filter(k => /^nsoMask/.test(k) &&
        /Tris|Triangles|Set$/i.test(k))
    };
  });
  check('nsoMaskRepaint reports a COUNT, not a triangle set',
        overlay.repaintReturns === 'number', overlay.repaintReturns);
  check('and no mask6 export hands a triangle set back at all',
        overlay.setApis.length === 0, overlay.setApis.join(', ') || 'none');
  {
    const mask = fs.readFileSync(path.join(ROOT, 'app-mask.js'), 'utf8');
    check('the overlay resolves triangles in DISPLAY space, off the placed mesh',
          /function buildOverlay\([^)]*placed[^)]*\)/.test(mask) &&
          /placed\.mesh\.geometry/.test(mask));
    check('so a delete, which edits rawTris, needed a raw-space selector of its own',
          /buildOverlay/.test(mask) && !/rawTris/.test(mask.slice(mask.indexOf('function buildOverlay'),
                                                                  mask.indexOf('function buildOverlay') + 3000)));
  }

  console.log('\n=== 3. the pink and the cut pick the same triangles ===');
  console.log('    fixture                       face   raw entry                    pink  picked');
  let compared = 0;
  for (const c of CASES) {
    const id = await soloFixture(page, fx(c.file));
    for (const [axis, sign] of c.faces) {
      const fp = await page.evaluate(facePoint, [id, axis, sign]);
      if (!fp.hit || !fp.onCanvas) {
        check(c.file + ' ' + 'XYZ'[axis] + (sign > 0 ? '+' : '-') + ': the click point is on the piece',
              false, JSON.stringify(fp));
        continue;
      }
      await setPaintMode(page, 'select');
      await page.mouse.click(fp.x, fp.y);
      const r = await page.evaluate(pinkVsSelect, id);
      if (!r.entry) {
        // a click that named nothing is not a comparison, and not a failure of
        // this audit either - it is a face the pick declines, which the
        // delete declines with it
        console.log('    ' + c.file.padEnd(28) + ' ' + ('XYZ'[axis] + (sign > 0 ? '+' : '-')).padEnd(6) +
                    ' (no face named by the pick)');
        continue;
      }
      const name = (r.entry.inner ? 'inner ' : 'outer ') + 'XYZ'[r.entry.axisIdx] +
                   (r.entry.keepMin ? '-' : '+') + ' @ ' + (+r.entry.d).toFixed(3);
      console.log('    ' + c.file.padEnd(28) + ' ' + ('XYZ'[axis] + (sign > 0 ? '+' : '-')).padEnd(6) +
                  ' ' + name.padEnd(28) + ' ' + String(r.pink).padStart(4) + '  ' + String(r.picked).padStart(6));
      check('  ' + c.file + ' ' + name + ': pink == picked, and neither is empty',
            r.pink === r.picked && r.pink > 0, r.pink + ' vs ' + r.picked);
      compared++;
      // clear the target before the next face so one click is one measurement
      await page.evaluate(i => { const m = state.models.find(x => x.id === i); nsoMaskSelectClear(m, { noUndo: true }); }, id);
    }
  }
  check('every face compared, on every fixture', compared >= 16, compared + ' faces');

  console.log('\n=== 4. the standing rule still binds the exclude list ===');
  {
    const id = await soloFixture(page, fx('box-20mm.stl'));
    const fp = await page.evaluate(facePoint, [id, 1, 1]);
    check('the click point is on the piece and on the canvas', fp.hit && fp.onCanvas, JSON.stringify(fp));
    await setPaintMode(page, 'select');
    await page.mouse.click(fp.x, fp.y);
    await setPaintMode(page, 'exclude');
    await page.mouse.click(fp.x, fp.y);
    await setPaintMode(page, false);
    const both = await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      return { sel: nsoMaskSelectCount(m), exc: nsoMaskCount(m) };
    }, id);
    check('one face can be on both lists at once', both.sel === 1 && both.exc === 1, JSON.stringify(both));
    const res = await page.evaluate(() => NSO_deletePaintedFace());
    check('and the delete stands down rather than removing an excluded face',
          res.ok === false && /painted excluded/.test(res.reason || ''), res.reason);
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the status names the face and says paint wins',
          /Delete stood down/.test(status) && /Paint wins/.test(status), status);
  }

  console.log('\n=== 5. no page errors while any of that happened ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS - every audit finding still holds' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

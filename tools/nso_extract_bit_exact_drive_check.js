#!/usr/bin/env node
/* Extract bit, driven through the real app: the bit is the void you click, shown before it is made.
     node tools/nso_extract_bit_exact_drive_check.js        exit 0 = every gate held
   (PW_CHROMIUM=<chrome binary> where Playwright's own browser is not installed.)

   A closed tube (open-ended bore), a hex nut and a block are loaded as STL files and put on the plate:
     1. tube: a pick on the bore wall draws the void as a amber ghost BEFORE anything is made (the plate and the piece
        unchanged); Lid R is live (too small: the preview goes and says why; blank: it is back); Escape puts the preview
        away and then stops the tool; Make bit bakes the cylinder in the bore, named <piece>-bit, one Undo
     2. nut: a pick inside the thread makes a threaded rod, far from a plain cylinder of its own size
     3. block: the button arms the click, a real pointer click on its outside is refused in words, nothing is made    */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io');
const { csgContext } = require('./nso_csg_node');
const T = require('../nso_thread.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-extract-bit-'));

(async () => {
  const c = csgContext();
  const wasm = await c.NSO_CSG.load();
  const M = wasm.Manifold;
  const soupOf = m => c.NSO_CSG.manifoldToSoup(m);
  const files = {
    tube: soupOf(M.cylinder(30, 15, 15, 96, true).subtract(M.cylinder(32, 12, 12, 96, true))),
    nut: T.nut({ size: 'M6' }).soup,
    block: soupOf(M.cube([20, 20, 20], true))
  };
  for (const k of Object.keys(files)) { writeSTL(path.join(TMP, k + '.stl'), files[k]); }

  const place = (page, id) => page.evaluate(i => {
    const m = state.models.find(x => x.id === i);
    placeModelMovable(m, 0, 0);
    state.editId = i;
    state.selectedIndex = state.placed.findIndex(p => p && p.sourceId === i);
  }, id);
  const rawStats = (page, id) => page.evaluate(i => {
    const m = state.models.find(x => x.id === i), s = m.rawTris;
    let v = 0;
    for (let t = 0; t < s.length / 9; t++) {
      const o = t * 9;
      v += (s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6]) + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]));
    }
    const st = NSO_edgeStats(s);
    return { name: m.name, tris: s.length / 9, volume: v / 6, open: st.open, nm: st.nm,
             size: [m.size.x, m.size.y, m.size.z] };
  }, id);
  const hashOf = (page, id) => page.evaluate(i => {
    const s = state.models.find(x => x.id === i).rawTris; let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + Math.round(s[k] * 1e6)) | 0;
    return h + ':' + s.length;
  }, id);

  /* The world-space centre of the piece on the plate (display axes: Y up), and what the app says it is called. */
  const centre = (page, id) => page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i && q.mesh);
    p.mesh.updateMatrixWorld(true);
    const b = nsoBounds.worldBox(p.mesh), c = b.getCenter(new THREE.Vector3());
    return { index: state.placed.indexOf(p), c: [c.x, c.y, c.z], size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z],
             min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  }, id);
  const previewState = page => page.evaluate(() => ({
    armed: window.nsoExtractBit.armed(), pending: !!window.nsoExtractBit.pending(),
    shown: window.nsoExtractBit.previewShown(),
    ghostTris: (() => { let n = 0; state.scene.traverse(o => { if (o.userData && o.userData.nsoExtractPreview) o.traverse(m => { if (m.isMesh) n += m.geometry.attributes.position.count / 3; }); }); return n; })(),
    makeVisible: !document.getElementById('btn-extract-make').hidden,
    status: (document.getElementById('status') || {}).textContent
  }));

  await withApp(async (page) => {
    /* One pick, the way a click makes it: detect, preview; the piece untouched and nothing on the plate yet. */
    const pickOn = async (name, pointFor, label) => {
      const id = await loadSTL(page, path.join(TMP, name + '.stl'));
      await place(page, id);
      const before = await hashOf(page, id);
      const nModels = await page.evaluate(() => state.models.length);
      const ctr = await centre(page, id);
      const pick = Object.assign({ index: ctr.index }, pointFor(ctr));
      await page.evaluate(p => { window.nsoExtractBit.cancel(); return window.nsoExtractBit.pick(p); }, pick);
      return { id, before, nModels, ctr, pick, st: await previewState(page) };
    };

    console.log('\n=== closed tube: click on the bore wall ===');
    {
      const r = await pickOn('tube', c => ({ point: [c.c[0] + 12, c.c[1], c.c[2]], normal: [-1, 0, 0] }));
      console.log('  status: ' + r.st.status);
      if (process.env.SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: process.env.SHOT }); }
      check('the click finds a void and shows it before making anything (amber ghost, Make bit offered)',
        r.st.pending && r.st.shown && r.st.ghostTris > 100 && r.st.makeVisible, JSON.stringify({ g: r.st.ghostTris, m: r.st.makeVisible }));
      check('nothing is on the plate yet, and the tube is untouched',
        (await page.evaluate(() => state.models.length)) === r.nModels && (await hashOf(page, r.id)) === r.before);
      /* Lid R is live: a ball too small to close over the bore takes the preview away and says so; blank brings it back. */
      await page.fill('#inp-extract-r', '3');
      await page.waitForFunction(() => /does not close over/.test((document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
      let ps = await previewState(page);
      check('Lid R 3 mm (too small for a Ø24 bore): the preview goes and the status says why', !ps.shown && !ps.pending && !ps.makeVisible, ps.status);
      await page.fill('#inp-extract-r', '');
      await page.waitForFunction(() => window.nsoExtractBit.pending(), null, { timeout: 30000 });
      ps = await previewState(page);
      check('Lid R blank (automatic): the preview is back', ps.shown && ps.makeVisible);
      /* Escape puts the preview away and keeps the tool armed; a second Escape stops the tool. */
      await page.keyboard.press('Escape');
      ps = await previewState(page);
      check('Escape: the preview goes, the tool stays armed', !ps.shown && ps.armed && !ps.makeVisible);
      await page.keyboard.press('Escape');
      check('Escape again: the tool stops', !(await previewState(page)).armed);
      await page.evaluate(p => window.nsoExtractBit.pick(p), r.pick);
      ps = await previewState(page);
      check('a click again chooses the void again', ps.shown && ps.pending);
      await page.evaluate(() => window.nsoExtractBit.make());
      const st = await statusOf(page);
      console.log('  status: ' + st);
      const made = await page.evaluate(i => state.models.filter(m => m.id !== i).map(m => m.id), r.id);
      check('Make bit bakes it - one new piece, named tube-bit', /^Extract bit ok/.test(st) && made.length === 1, st);
      if (made.length === 1) {
        const s = await rawStats(page, made[0]);
        const want = Math.PI * 144 * 30;
        check('it is the cylinder in the bore (volume ' + s.volume.toFixed(0) + ' of ' + want.toFixed(0) + ')', Math.abs(s.volume - want) < want * 0.02);
        check('named <piece>-bit and closed', /-bit$/.test(s.name) && s.open === 0 && s.nm === 0, s.name + ' open ' + s.open + ' nm ' + s.nm);
        const dims = s.size.map(v => +v.toFixed(2)).sort((a, b) => a - b);
        check('Ø24 x 30', Math.abs(dims[0] - 24) < 0.1 && Math.abs(dims[1] - 24) < 0.1 && Math.abs(dims[2] - 30) < 0.1, dims.join(' x '));
      }
      const after = await previewState(page);
      check('the preview is gone and the tool is off once the bit is made', !after.shown && !after.armed && !after.makeVisible);
      check('the tube is untouched', (await hashOf(page, r.id)) === r.before);
      await page.evaluate(() => undoLast());
      const left = await page.evaluate(() => state.models.length);
      check('one Undo removes the bit', left === r.nModels, left + ' models, was ' + r.nModels);
    }

    console.log('\n=== hex nut: click inside the threaded hole ===');
    {
      const r = await pickOn('nut', c => ({ point: [c.c[0] + 2.9, c.c[1], c.c[2]], normal: [-1, 0, 0] }));
      console.log('  status: ' + r.st.status);
      check('the preview shows', r.st.pending && r.st.shown, r.st.status);
      const idsBefore = await page.evaluate(() => state.models.map(m => m.id));
      await page.evaluate(() => window.nsoExtractBit.make());
      const made = await page.evaluate(b => state.models.filter(m => b.indexOf(m.id) < 0).map(m => m.id), idsBefore);
      if (made.length === 1) {
        const s = await rawStats(page, made[0]);
        const dims = s.size.map(v => +v.toFixed(2)).sort((a, b) => a - b);
        const cyl = Math.PI * (dims[2] / 2) * (dims[2] / 2) * dims[0];
        check('it is a threaded rod, not a plain cylinder (volume ' + s.volume.toFixed(1) + ' of ' + cyl.toFixed(1) + ' for its envelope)', s.volume < 0.97 * cyl && s.volume > 0.6 * cyl);
        check('about Ø6.4 and one nut thick', Math.abs(dims[2] - 6.4) < 0.3 && Math.abs(dims[0] - 5.2) < 0.2, dims.join(' x '));
        // nm is not asserted here: the nut's own thread seam is a zero-area sliver after the STL round trip, and the bit inherits it (the node gate reads the kernel's own topology: 0 and 0).
        check('closed (no open edge)', s.open === 0, 'open ' + s.open + ' nm ' + s.nm);
        if (process.env.DUMP_BIT) fs.writeFileSync(process.env.DUMP_BIT, Buffer.from(Float32Array.from(await page.evaluate(i => Array.from(state.models.find(m => m.id === i).rawTris), made[0])).buffer));
      } else check('one new piece', false, String(made.length));
      check('the nut is untouched', (await hashOf(page, r.id)) === r.before);
    }

    console.log('\n=== solid block: a click on its outside, through the real pointer path ===');
    {
      const id = await loadSTL(page, path.join(TMP, 'block.stl'));
      await place(page, id);
      const ctr = await centre(page, id);
      await page.evaluate(() => { window.nsoExtractBit.cancel(); });
      await page.click('#btn-extract-bit');
      check('the button arms the click', (await previewState(page)).armed);
      const xy = await page.evaluate(i => {
        const p = state.placed.find(q => q && q.sourceId === i && q.mesh);
        const b = nsoBounds.worldBox(p.mesh), c = b.getCenter(new THREE.Vector3());
        const v = new THREE.Vector3(c.x, b.max.y, c.z).project(state.camera);
        const r = state.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
      }, id);
      await page.mouse.click(xy.x, xy.y);
      await page.waitForFunction(() => /Extract failed|preview/.test((document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
      const st = await previewState(page);
      console.log('  status: ' + st.status);
      check('refused in words, no preview, nothing made', /Extract failed/.test(st.status) && !st.shown && !st.pending, st.status);
      await page.evaluate(() => window.nsoExtractBit.cancel());
    }
  });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

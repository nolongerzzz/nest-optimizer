#!/usr/bin/env node
/* Extract bit, driven through the real app: the bit is the void, whatever shape it is.
     node tools/nso_extract_bit_exact_drive_check.js        exit 0 = every gate held
   (PW_CHROMIUM=<chrome binary> where Playwright's own browser is not installed.)

   A closed tube (open-ended bore) and a hex nut are loaded as STL files, put on the plate and selected, and the
   real extractBitFromSelected runs on them:
     1. tube: the status says "exact void"; the new piece is the cylinder in the bore (volume, size), named <piece>-bit
     2. nut: the new piece is a threaded rod - far from a plain cylinder of its own size
     3. both: the piece is untouched, and one Undo removes the bit
     4. a solid block: "Extract failed - no cavity found", and no piece is made                                        */
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

  await withApp(async (page) => {
    const run = async (name) => {
      const id = await loadSTL(page, path.join(TMP, name + '.stl'));
      await place(page, id);
      const before = await hashOf(page, id);
      const nModels = await page.evaluate(() => state.models.length);
      await page.evaluate(() => extractBitFromSelected());
      await page.waitForFunction(n => /^Extract/.test((document.getElementById('status') || {}).textContent || ''), 0, { timeout: 30000 }).catch(() => {});
      const status = await statusOf(page);
      const made = await page.evaluate(([n, i]) => state.models.filter(m => m.id !== i).slice(n - 1).map(m => m.id), [nModels, id]);
      return { id, before, status, made, nModels };
    };

    console.log('\n=== closed tube ===');
    {
      const r = await run('tube');
      console.log('  status: ' + r.status);
      check('status says the exact void', /^Extract bit ok - exact void/.test(r.status), r.status);
      check('one new piece, named tube-bit', r.made.length === 1);
      if (r.made.length === 1) {
        const s = await rawStats(page, r.made[0]);
        const want = Math.PI * 144 * 30;
        check('it is the cylinder in the bore (volume ' + s.volume.toFixed(0) + ' of ' + want.toFixed(0) + ')', Math.abs(s.volume - want) < want * 0.015);
        check('named <piece>-bit and closed', /-bit$/.test(s.name) && s.open === 0 && s.nm === 0, s.name + ' open ' + s.open + ' nm ' + s.nm);
        const dims = s.size.map(v => +v.toFixed(2)).sort((a, b) => a - b);
        check('Ø24 x 30', Math.abs(dims[0] - 24) < 0.1 && Math.abs(dims[1] - 24) < 0.1 && Math.abs(dims[2] - 30) < 0.1, dims.join(' x '));
      }
      check('the tube is untouched', (await hashOf(page, r.id)) === r.before);
      await page.evaluate(() => undoLast && undoLast());
      const left = await page.evaluate(() => state.models.length);
      check('one Undo removes the bit', left === r.nModels, left + ' models, was ' + r.nModels);
    }

    console.log('\n=== hex nut with a threaded hole ===');
    {
      const r = await run('nut');
      console.log('  status: ' + r.status);
      check('status says the exact void', /^Extract bit ok - exact void/.test(r.status), r.status);
      if (r.made.length === 1) {
        const s = await rawStats(page, r.made[0]);
        const dims = s.size.map(v => +v.toFixed(2)).sort((a, b) => a - b);
        const cyl = Math.PI * (dims[2] / 2) * (dims[2] / 2) * dims[0];
        check('it is a threaded rod, not a plain cylinder (volume ' + s.volume.toFixed(1) + ' of ' + cyl.toFixed(1) + ' for its envelope)', s.volume < 0.97 * cyl && s.volume > 0.6 * cyl);
        check('about Ø6.4 and one nut thick', Math.abs(dims[2] - 6.4) < 0.3 && Math.abs(dims[0] - 5.2) < 0.2, dims.join(' x '));
        check('closed', s.open === 0 && s.nm === 0, 'open ' + s.open + ' nm ' + s.nm);
      } else check('one new piece', false, String(r.made.length));
      check('the nut is untouched', (await hashOf(page, r.id)) === r.before);
    }

    console.log('\n=== solid block: nothing to extract ===');
    {
      const r = await run('block');
      console.log('  status: ' + r.status);
      check('refused in words, no piece made', /Extract failed - no cavity found/.test(r.status) && r.made.length === 0, r.status);
    }
  });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/* Drive check: Texture through the REAL controls, in real Chromium.
     node tools/nso_texture_drive_check.js          local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_texture_drive_check.js

   Same standard as tools/nso_skin_wrap_drive_check.js and
   tools/nso_carve_test.js: every step is a click on the shipped UI, and the
   file checked is the one the BROWSER downloaded.

   What this adds over tools/nso_texture_test.js, which proves the engine: it
   proves the button. The engine suite builds a soup in Node and judges it;
   this one loads a cylinder through the app's own file input, clicks
   #btn-texture, reads the status line and the scene, presses Export plate,
   and then re-runs the engine suite's own headline measurements on the
   downloaded bytes. If the wiring dropped a parameter, read the wrong input,
   committed the wrong soup or exported a different mesh than it baked, the
   numbers here stop matching the numbers there.

   Flow (fixtures/cylinder_r10h30_s64.stl):
     1. the file through the file input, the piece picked by clicking its row
     2. the Finish tab carries Texture, its pattern select and both numbers,
        wired, with the engine loaded
     3. Export plate BEFORE anything - this is the reference the measurements
        below are taken against, so they are made in the exported frame and
        not in the builder's
     4. click Texture -> the status line, the triangle count and the scene:
        21.2 across where it was 20, still 30 long, the caps unmoved
     5. Export plate -> the download through mesh_validate.py: ONE closed
        shell, Euler 2, 0 piercing / coplanar / degenerate, 30912 triangles
     6. the engine suite's headline numbers, re-measured on that download:
        every tip 0.6 mm off the ORIGINAL curved surface, contact 1057.88 mm2,
        nothing further from the axis than R + depth
     7. Undo -> the 256-triangle cylinder back, and the status names Texture
     8. a facet of the CURVED SIDE painted excluded -> Texture stands down and
        says how many; the piece is untouched
     9. a CAP painted instead -> Texture runs, because the caps are not the
        band (the sub-region rule, through the shipped button)
    10. pattern = zigzag -> bakes, exports as one closed shell
    11. fixtures/prism_r10h30_s8.stl -> refused, naming Skin wrap
   The two steps that are not clicks are the paints (8 and 9): there is no
   button for a face click, so this calls the app's own paint primitive and is
   labelled as such, the same way the Skin and Skin-wrap checks do it.        */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');
const Band = require(path.join(ROOT, 'nso_skin_band.js'));
const { readSTL } = require('./nso_stl_io.js');

const fx = f => path.join(ROOT, 'fixtures', f);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-texture-drive-'));
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const R = 10, H = 30, SEG = 64, DEPTH = 0.6;
const TAU = Math.PI * 2;
/* the engine suite's own numbers, quoted here so a drift shows up as a
   mismatch between two files rather than as a quietly updated constant */
const ENGINE = { tris: 30912, contact: 1057.8826, zigzagTris: 1900 };

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', odd ' + v.odd_edges + ', winding ' + v.inconsistent_winding_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris +
  ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
  ', bbox ' + JSON.stringify(v.bbox_size.map(x => +x.toFixed(4)));
const allClosed = v => v.open_edges === 0 && v.nonmanifold_edges === 0 && v.odd_edges === 0 &&
  v.inconsistent_winding_edges === 0 && v.euler_characteristic === 2 &&
  v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 && v.degenerate_tris === 0;

/* shells by shared edges, welded at 1e-4 - the same test the skin checks use */
function edgeShells(soup) {
  const n = soup.length / 9;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = o => Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
  const owner = new Map();
  for (let t = 0; t < n; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) uni(owner.get(ek), t); else owner.set(ek, t);
    }
  }
  return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
}
/* the ORIGINAL surface radius along the ray at angle phi - the inscribed
   polygon's chord, derived here rather than asked of the engine, exactly as
   tools/nso_texture_test.js derives it */
function chordRadius(r, facets, phi) {
  const d = TAU / facets;
  const x = ((phi % d) + d) % d - d / 2;
  return r * Math.cos(d / 2) / Math.cos(x);
}
const sortedBox = v => v.bbox_size.slice().sort((a, b) => a - b);

const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(
  src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 120000 });

/* the piece as the viewport and the list show it */
const piece = id => {
  const m = state.models.find(x => x.id === id);
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  let world = null;
  if (p) {
    p.mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(p.mesh);
    world = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  }
  return {
    tris: m.rawTris ? m.rawTris.length / 9 : null,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    world: world,
    painted: (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0,
    active: state.editId === id
  };
};

async function exportPlateSTL(page, label) {
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  check(label + ': "Export plate" downloaded an .stl (' + download.suggestedFilename() + ')',
        /\.stl$/.test(download.suggestedFilename()));
  return file;
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());

  console.log('\n=== 1. the cylinder through the file input, the piece picked by clicking its row ===');
  const id = await loadSTL(page, fx('cylinder_r10h30_s64.stl'));
  await page.click(`.model-item[data-edit-id="${id}"]`);
  let s = await page.evaluate(piece, id);
  check('the r10 x 30 cylinder is loaded, placed and active',
        s.tris === 256 && s.active && s.world && near(s.world.y, H, 1e-4), JSON.stringify(s.size));
  check('it stands 20 across and 30 long in the scene',
        near(s.world.x, 2 * R, 1e-4) && near(s.world.z, 2 * R, 1e-4), JSON.stringify(s.world));

  console.log('\n=== 2. the Finish tab carries Texture and its two numbers, wired ===');
  await openFinishMenu(page);
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-texture');
    return {
      inFinish: !!document.querySelector('.vp-finish #btn-texture'),
      label: b ? b.textContent.trim() : null,
      wired: !!(b && b.dataset && b.dataset.nsoWired === '1'),
      pattern: !!document.querySelector('.vp-finish #sel-texture-pattern'),
      pitch: (document.getElementById('inp-texture-pitch') || {}).value,
      depth: (document.getElementById('inp-texture-depth') || {}).value,
      options: [...document.querySelectorAll('#sel-texture-pattern option')].map(o => o.value),
      core: typeof NSO_SkinBand !== 'undefined' && typeof NSO_SkinBand.applyBandSkin === 'function',
      fn: typeof NSO_textureSelectedModel === 'function',
      fullWrap: !!document.getElementById('chk-full-wrap'),
      skinWrap: !!document.getElementById('btn-skin-wrap')
    };
  });
  check('Texture, its pattern select and both numbers live in the Finish tab',
        ui.inFinish && ui.pattern && ui.pitch === '1.2' && ui.depth === '0.6', JSON.stringify(ui));
  check('the button is labelled exactly "Texture"', ui.label === 'Texture', ui.label);
  check('it has its listener, and both modules are loaded', ui.wired && ui.core && ui.fn);
  check('the pattern select offers crosshatch / zigzag (ring has no height field)',
        JSON.stringify(ui.options) === '["crosshatch","zigzag"]', ui.options.join(','));
  check('Soften\'s Full wrap checkbox and Skin wrap are still their own controls',
        ui.fullWrap && ui.skinWrap);

  console.log('\n=== 3. Export plate BEFORE - the reference frame for every measurement below ===');
  const fBefore = await exportPlateSTL(page, 'cylinder-plain');
  const vBefore = meshValidate(fBefore);
  console.log('    ' + summary(vBefore));
  const soupBefore = readSTL(fBefore);
  const band = Band.findBand(soupBefore);
  check('the exported plain cylinder is a band in the EXPORTED frame',
        typeof band !== 'string', typeof band === 'string' ? band : 'r ' + band.r.toFixed(4) + ', D ' + band.D.toFixed(4) + ', ' + band.facets + ' facets');
  if (typeof band === 'string') { console.log('\nFAIL - cannot measure without the reference band'); process.exit(1); }
  check('  ...with the fixture\'s own radius, length and facet count',
        near(band.r, R, 2e-3) && near(band.D, H, 2e-3) && band.facets === SEG,
        'r ' + band.r.toFixed(4) + ', D ' + band.D.toFixed(4) + ', ' + band.facets + ' facets');

  console.log('\n=== 4. click Texture ===');
  await page.click('#btn-texture');
  await waitStatus(page, /^Textured|^Texture /);
  const st4 = await statusOf(page);
  console.log('    status: ' + st4);
  check('status: the curved side is textured, the pattern named, the snap declared',
    /^Textured the curved side - crosshatch lattice, rib 0\.42 mm, pitch 1\.2 mm, 0\.6 mm tall wrapped round a r 10\.00 x 30\.00 mm cylinder, 52 repeats around at 1\.208 mm arc pitch, tips \+0\.60mm \(pitch snapped 1\.20 → 1\.208mm so the wrap closes\)/.test(st4), st4);
  check('status: BOTH contact numbers, the curved one first',
    /contact 1058\.3mm² on the curve \(998\.4mm² unrolled\), 30912 tris - caps untouched$/.test(st4), st4);
  s = await page.evaluate(piece, id);
  check('the piece went from 256 triangles to the engine suite\'s count',
        s.tris === ENGINE.tris, s.tris + ' (engine suite: ' + ENGINE.tris + ')');
  check('the scene grew by 2 x depth across and NOT along the axis: 20 -> 21.2, still 30',
        near(s.world.x, 2 * (R + DEPTH), 1e-4) && near(s.world.z, 2 * (R + DEPTH), 1e-4) &&
        near(s.world.y, H, 1e-4), JSON.stringify(s.world));

  console.log('\n=== 5. Export plate, the download through the checker ===');
  const fAfter = await exportPlateSTL(page, 'cylinder-texture');
  const vAfter = meshValidate(fAfter);
  console.log('    ' + summary(vAfter));
  const soupAfter = readSTL(fAfter);
  check('download: ONE closed shell, Euler 2, consistent winding', allClosed(vAfter), summary(vAfter));
  check('download: exactly one edge-connected shell', edgeShells(soupAfter) === 1, String(edgeShells(soupAfter)));
  check('download: the engine suite\'s triangle count', vAfter.triangles === ENGINE.tris, vAfter.triangles);
  const box = sortedBox(vAfter);
  check('download: 21.2 x 21.2 x 30 - the caps did not move',
        near(box[0], 2 * (R + DEPTH), 1e-4) && near(box[1], 2 * (R + DEPTH), 1e-4) && near(box[2], H, 1e-4),
        JSON.stringify(box.map(x => +x.toFixed(4))));
  const boxBefore = sortedBox(vBefore);
  check('download: the axial extent is bit for bit what it was before the bake',
        near(box[2], boxBefore[2], 1e-6), box[2] + ' vs ' + boxBefore[2]);

  console.log('\n=== 6. the engine suite\'s headline numbers, re-measured on the BROWSER download ===');
  {
    let worst = 0, tips = 0, maxR = -Infinity, minSide = Infinity;
    for (let i = 0; i < soupAfter.length; i += 3) {
      const p = [soupAfter[i], soupAfter[i + 1], soupAfter[i + 2]];
      const rad = band.radiusOf(p);
      const w = p[0] * band.A[0] + p[1] * band.A[1] + p[2] * band.A[2];
      const onCap = Math.abs(w - band.wLo) < 1e-4 || Math.abs(w - band.wHi) < 1e-4;
      if (rad > maxR) maxR = rad;
      if (!onCap && rad < minSide) minSide = rad;
      if (rad < R + DEPTH / 2) continue;
      tips++;
      worst = Math.max(worst, Math.abs((rad - chordRadius(band.r, SEG, band.phiOf(p))) - DEPTH));
    }
    check('download: there are tips to measure', tips > 1000, String(tips));
    check('download: every tip stands ' + DEPTH + ' mm off the ORIGINAL curved surface',
          worst < 5e-4, 'worst error ' + worst.toExponential(2) + ' mm over ' + tips + ' tips');
    check('download: nothing reaches further than R + depth from the axis',
          near(maxR, R + DEPTH, 5e-4), 'max radius ' + maxR.toFixed(5) +
          ' (a single-normal lift would read ' + (2 * R + DEPTH) + ')');
    check('download: the floor between the ribs is still the original prism',
          minSide < R - 1e-3 && minSide > R * Math.cos(Math.PI / SEG) - 5e-4,
          'floor radius ' + minSide.toFixed(5) + ', apothem ' + (R * Math.cos(Math.PI / SEG)).toFixed(5));

    const m = Band.measureBand(soupAfter, band, band.r + DEPTH, 2e-3);
    console.log('    contact on the download: ' + m.tipArea.toFixed(4) + ' mm2' +
                '   (engine suite: ' + ENGINE.contact.toFixed(4) + ')');
    check('download: the contact area is the engine suite\'s, to 0.01 mm2',
          near(m.tipArea, ENGINE.contact, 1e-2), m.tipArea.toFixed(4));
    check('download: the status line quoted the CURVED number, not the unrolled one',
          /contact 1058\.3mm²/.test(st4) && Math.abs(m.tipArea * (R + DEPTH) / R - 1058.3) > 1,
          'status 1058.3, unrolled would be ' + (m.tipArea * R / (R + DEPTH)).toFixed(1));
  }

  console.log('\n=== 7. Undo (button) ===');
  await page.click('#btn-undo');
  s = await page.evaluate(piece, id);
  check('Undo puts the 256-triangle cylinder back, 20 across', s.tris === 256 && near(s.world.x, 2 * R, 1e-4),
        s.tris + ', ' + s.world.x.toFixed(4));
  check('Undo status names Texture', /Undo: Texture reverted/.test(await statusOf(page)), await statusOf(page));

  console.log('\n=== 8. a painted facet of the CURVED SIDE (paint set by the app primitive, NOT a click) ===');
  const painted = await page.evaluate(i => {
    const m = state.models.find(x => x.id === i);
    const b = NSO_SkinBand.findBand(m.rawTris);
    const faces = NSO_textureFacetPlanes(m.rawTris, b);
    const f = faces[7];
    nsoMaskRestore(m, [{ n: f.n, d: f.d, axisIdx: null, keepMin: null, inner: false }]);
    return { total: faces.length, n: f.n.map(x => +x.toFixed(4)), d: +f.d.toFixed(4) };
  }, id);
  check('one of the 64 side facets is painted excluded', painted.total === SEG,
        'facet normal ' + JSON.stringify(painted.n) + ', d ' + painted.d);
  await page.click('#btn-texture');
  await waitStatus(page, /stood down|^Textured/);
  const st8 = await statusOf(page);
  console.log('    status: ' + st8);
  check('status: Texture stands down and says how many facets',
        /^Texture stood down - 1 painted facet\(s\) on the curved side; the wrap is one surface all the way round/.test(st8), st8);
  check('  ...and points at the caps not blocking it', /paint on the caps does not block it/.test(st8));
  s = await page.evaluate(piece, id);
  check('the piece is untouched - still 256 triangles, still 20 across',
        s.tris === 256 && near(s.world.x, 2 * R, 1e-4), s.tris + ', ' + s.world.x.toFixed(4));

  console.log('\n=== 9. a painted CAP instead: the caps are not the band, so Texture runs ===');
  await page.evaluate(i => {
    const m = state.models.find(x => x.id === i);
    nsoMaskRestore(m, [{ n: [0, 0, 1], d: 30, axisIdx: 2, keepMin: false, inner: false }]);
  }, id);
  s = await page.evaluate(piece, id);
  check('the +Z cap is painted, and it is the only paint on the piece', s.painted === 1, String(s.painted));
  await page.click('#btn-texture');
  await waitStatus(page, /^Textured|stood down/);
  const st9 = await statusOf(page);
  console.log('    status: ' + st9);
  check('status: it textured anyway - a painted cap is not the band\'s business',
        /^Textured the curved side/.test(st9), st9);
  s = await page.evaluate(piece, id);
  check('the bake went through with the cap paint still on it',
        s.tris === ENGINE.tris && s.painted === 1, s.tris + ' tris, ' + s.painted + ' painted');
  await page.click('#btn-undo');
  await page.evaluate(i => { nsoMaskRestore(state.models.find(x => x.id === i), []); }, id);

  console.log('\n=== 10. pattern = zigzag ===');
  await page.selectOption('#sel-texture-pattern', 'zigzag');
  await page.fill('#inp-texture-pitch', '2');
  await page.click('#btn-texture');
  await waitStatus(page, /^Textured|stood down|refused/);
  const st10 = await statusOf(page);
  console.log('    status: ' + st10);
  check('status: the sawtooth is named, with its own snapped arc pitch',
        /^Textured the curved side - sawtooth ridges, base 1\.2 -> tip 0\.42 mm.*31 repeats around at 2\.027 mm arc pitch/.test(st10), st10);
  s = await page.evaluate(piece, id);
  check('the piece carries the engine suite\'s zigzag soup', s.tris === ENGINE.zigzagTris,
        s.tris + ' (engine suite: ' + ENGINE.zigzagTris + ')');
  const fZig = await exportPlateSTL(page, 'cylinder-zigzag');
  const vZig = meshValidate(fZig);
  console.log('    ' + summary(vZig));
  check('download: one closed shell, Euler 2, no self-intersection', allClosed(vZig), summary(vZig));
  check('download: exactly one edge-connected shell', edgeShells(readSTL(fZig)) === 1);
  await page.click('#btn-undo');

  console.log('\n=== 11. the prism fixture: refused through the button, naming Skin wrap ===');
  const pid = await loadSTL(page, fx('prism_r10h30_s8.stl'));
  await page.click(`.model-item[data-edit-id="${pid}"]`);
  await page.click('#btn-texture');
  await waitStatus(page, /refused|^Textured/);
  const st11 = await statusOf(page);
  console.log('    status: ' + st11);
  check('status: Texture refuses an 8-sided prism and says what it saw',
        /^Texture refused - .*an 8-sided prism, not a cylinder/.test(st11), st11);
  check('  ...and points at the engine that does cover it',
        /Skin wrap/.test(st11), st11);
  const ps = await page.evaluate(piece, pid);
  check('the prism is untouched - still 32 triangles', ps.tris === 32, ps.tris);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

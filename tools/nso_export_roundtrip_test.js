/* Export round-trip integrity, through the shipped buttons.
   node tools/nso_export_roundtrip_test.js        exit 0 = every gate held

   Four routes, one real browser download each, re-opened from disk with a
   fresh parser (a stdlib binary-STL reader here, nso-3mf-read.js for 3MF) and
   compared vertex for vertex against the scene, then re-imported through the
   app's own file input and compared again:

     Export plate STL         buildCombinedGeometry  -> geometryToBinarySTL
     Export plate 3MF         buildPlacedObjects3MF  -> nso-3mf.js archive
     Download selected STL    exportActiveModel      (app-join.js)
     Download selected 3MF    exportActiveModel3MF

   The scene truth is p.geometry pushed through p.mesh.matrixWorld - what the
   viewport draws - NOT the p.x / p.height / p.liftY bookkeeping the exporters
   read. The two must agree everywhere; the liftY bug fixed in 1cef66a was
   exactly a case where they did not (every piece exported on z = 0 whatever
   the scene showed). This suite is the general form of that check.

   Conventions the checks encode (all measured off the shipped code):
     scene -> file      (x, y, z)_Yup -> (x, -z, y)_Zup
     bed hover          settlePlacedOnBed rests a piece at scene y = 0.2 and
                        the file rests it at z = 0, so file_z = scene_y - 0.2
     3MF plate origin   the plate export adds (plate.w/2, plate.d/2) so Bambu's
                        front-left origin lands where the packer's centre was
     Download selected  exports the MODEL (the state.models entry the list has
                        selected), not the placed instance. STL: the model at
                        its own centred origin. 3MF: the model centred on the
                        plate resting on z = 0. Yaw, tilt, lift and x/z are not
                        carried on this route. That contract is pinned here so a
                        change to it shows up as a test change, not a surprise.

   Poses: two pieces, both off-centre, nothing at the origin. A (box-20mm) is
   yawed 0.7 rad and lifted 3.37 mm; B (the asymmetric pocket brick) is tilted
   15 deg about X and lifted 0.18 mm, the seat-gap value. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const NSO3MFRead = require(path.join(ROOT, 'nso-3mf-read.js'));

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const note = (name, detail) => console.log('  note ' + name + (detail !== undefined ? ' - ' + detail : ''));
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const BED_HOVER = 0.2;
/* Float32 coordinates up to |128| have a ULP of 1.5e-5; the 3MF writer prints
   six decimals. 5e-5 is well above both and far below anything a slicer sees. */
const TOL = 5e-5;

const POSE_A = { x: 23.5, z: -17.25, rotY: 0.7, liftY: 3.37 };
const POSE_B = { x: -31, z: 12.5, tiltX: 15, liftY: 0.18 };

/* ---- file readers, independent of the app ---- */
function parseBinarySTL(buf) {
  if (buf.length < 84) throw new Error('binary STL shorter than its header (' + buf.length + ' bytes)');
  const n = buf.readUInt32LE(80);
  if (buf.length !== 84 + 50 * n) {
    throw new Error('declares ' + n + ' triangles = ' + (84 + 50 * n) + ' bytes, file is ' + buf.length);
  }
  const soup = new Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) soup[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return soup;
}

async function parse3MF(file) {
  const r = await NSO3MFRead.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: path.basename(file) });
  return r.objects.map(o => ({ name: o.name, soup: Array.from(o.positions) }));
}

/* ---- soup arithmetic ---- */
/** (x, y, z)_Yup -> (x + dx, -z + dy, y + dz) */
function toZup(soup, dx, dy, dz) {
  const out = new Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    out[i] = soup[i] + dx;
    out[i + 1] = -soup[i + 2] + dy;
    out[i + 2] = soup[i + 1] + dz;
  }
  return out;
}
function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= m)) m = Number.isFinite(d) ? d : Infinity;
  }
  return m;
}
function bounds(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let k = 0; k < 3; k++) {
    if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
    if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
  }
  return { lo, hi, size: hi.map((h, k) => h - lo[k]) };
}
const fmt = v => (Number.isFinite(v) ? v.toExponential(2) : String(v));

/* ---- in-page helpers (serialised into the page by Playwright) ---- */

/* Pose a placed piece the way the app does: applyMeshRotation writes the
   rotation, the rotated size and y = h/2 + 0.2 + lift; applyPlacedXZ moves it
   and settles it on the bed, as a viewport drag or nudge does. */
const setPose = ([id, pose]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id && p.mesh);
  const p = state.placed[idx];
  state.selectedIndex = idx;
  p.rotY = pose.rotY || 0;
  p.tiltX = pose.tiltX || 0;
  p.tiltZ = pose.tiltZ || 0;
  p.liftY = pose.liftY || 0;
  applyMeshRotation(p);
  applyPlacedXZ(p, pose.x, pose.z);
  updateExportButton();
  return { name: p.name, pos: p.mesh.position.toArray(), liftY: p.liftY, height: p.height };
};

/* What the viewport draws: every vertex of every placed piece in world space. */
const sceneSoups = () => state.placed.map(p => {
  p.mesh.updateMatrixWorld(true);
  const pos = p.geometry.attributes.position;
  const v = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
    out.push(v.x, v.y, v.z);
  }
  return { name: p.name, indexed: !!p.geometry.index, soup: out };
});

/* The model as the list holds it: centred, unrotated, Y up. */
const modelSoup = id => {
  const m = state.models.find(m => m.id === id);
  return { name: m.name, soup: Array.from(m.geometry.attributes.position.array) };
};

const plateDims = () => { const pl = getCurrentPlate(); return { w: pl.w, d: pl.d, name: pl.name }; };

/* ---- drive helpers ---- */
async function download(page, selector, dir, opts) {
  opts = opts || {};
  // "Download selected" prompts for a filename; accept it as Enter would.
  // Playwright dismisses dialogs by default, which reads as "Export cancelled".
  if (opts.dialog) page.once('dialog', d => d.accept());
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click(selector)
  ]);
  const file = path.join(dir, (opts.prefix || '') + dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}

/* Re-import a file through the app's own handleFiles and hand back the raw
   soups of the models it added (rawTris: file axes, untranslated). */
async function reimport(page, file) {
  const bytes = Array.from(fs.readFileSync(file));
  const before = await page.evaluate(() => state.models.length);
  await page.evaluate(([b, n]) => { handleFiles([new File([new Uint8Array(b)], n)]); }, [bytes, path.basename(file)]);
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
  await page.waitForTimeout(100);   // a multi-object 3MF adds its models one after another
  return page.evaluate(n => state.models.slice(n).map(m => ({
    name: m.name, rawAxis: m.rawAxis, raw: m.rawTris ? Array.from(m.rawTris) : null
  })), before);
}

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-export-rt-'));
  const idA = await loadSTL(page, fx('box-20mm.stl'));
  const idB = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  check('both fixtures are placed on the plate', await page.evaluate(() => state.placed.length) === 2);

  const plate = await page.evaluate(plateDims);
  console.log('  plate ' + plate.name + ' ' + plate.w + ' x ' + plate.d);

  const pA = await page.evaluate(setPose, [idA, POSE_A]);
  const pB = await page.evaluate(setPose, [idB, POSE_B]);
  console.log('  A ' + pA.name + ' at ' + JSON.stringify(pA.pos.map(v => +v.toFixed(4))) + ' lift ' + pA.liftY);
  console.log('  B ' + pB.name + ' at ' + JSON.stringify(pB.pos.map(v => +v.toFixed(4))) + ' lift ' + pB.liftY);
  check('A sits at y = h/2 + 0.2 + lift in the scene', near(pA.pos[1], pA.height / 2 + BED_HOVER + POSE_A.liftY, 1e-9), pA.pos[1]);
  check('B sits at y = h/2 + 0.2 + lift in the scene', near(pB.pos[1], pB.height / 2 + BED_HOVER + POSE_B.liftY, 1e-9), pB.pos[1]);

  const scene = await page.evaluate(sceneSoups);
  check('placed geometry is non-indexed (the exporters walk the position attribute directly)',
    scene.every(s => !s.indexed), JSON.stringify(scene.map(s => s.indexed)));
  const sceneAll = scene.reduce((acc, s) => acc.concat(s.soup), []);
  const expectSTL = toZup(sceneAll, 0, 0, -BED_HOVER);
  const expect3MF = scene.map(s => ({ name: s.name, soup: toZup(s.soup, plate.w / 2, plate.d / 2, -BED_HOVER) }));

  const files = {};

  /* ---------- 1. Export plate, Format = STL ---------- */
  console.log('\n--- Export plate STL ---');
  await page.selectOption('#export-format', 'stl');
  files.plateSTL = await download(page, '#btn-export-stl', tmp);
  check('downloads a .stl', /\.stl$/i.test(files.plateSTL), path.basename(files.plateSTL));
  let plateSTL = null;
  try { plateSTL = parseBinarySTL(fs.readFileSync(files.plateSTL)); } catch (e) { check('binary STL parses and its length matches the declared count', false, e.message); }
  if (plateSTL) {
    check('binary STL length matches the declared triangle count', true);
    const d = maxDiff(plateSTL, expectSTL);
    check('every vertex matches the scene, (x,-z,y-0.2), in order (' + TOL + ')', d <= TOL, 'max dev ' + fmt(d) + ', ' + plateSTL.length / 9 + ' tris');
    // liftY in its general form: each piece's lowest exported point is its lift
    const nA = scene[0].soup.length;
    const bA = bounds(plateSTL.slice(0, nA)), bB = bounds(plateSTL.slice(nA));
    check('A rests at z = liftY (3.37)', near(bA.lo[2], POSE_A.liftY, 1e-4), bA.lo[2]);
    check('B rests at z = liftY (0.18) after a 15 deg tilt', near(bB.lo[2], POSE_B.liftY, 1e-4), bB.lo[2]);
    check('A is at its x / -z in the file', near((bA.lo[0] + bA.hi[0]) / 2, POSE_A.x, 1e-4) && near((bA.lo[1] + bA.hi[1]) / 2, -POSE_A.z, 1e-4),
      JSON.stringify([(bA.lo[0] + bA.hi[0]) / 2, (bA.lo[1] + bA.hi[1]) / 2]));
  }

  /* ---------- 2. Export plate, Format = 3MF ---------- */
  console.log('\n--- Export plate 3MF ---');
  await page.selectOption('#export-format', '3mf');
  files.plate3MF = await download(page, '#btn-export-stl', tmp);
  check('downloads a .3mf', /\.3mf$/i.test(files.plate3MF), path.basename(files.plate3MF));
  let plate3MF = null;
  try { plate3MF = await parse3MF(files.plate3MF); } catch (e) { check('nso-3mf-read.js opens the archive', false, e.message); }
  if (plate3MF) {
    check('one object per placed piece, in plate order, named after the pieces',
      plate3MF.length === 2 && plate3MF.every((o, i) => o.name === expect3MF[i].name),
      JSON.stringify(plate3MF.map(o => o.name)));
    plate3MF.forEach((o, i) => {
      if (!expect3MF[i]) return;
      const d = maxDiff(o.soup, expect3MF[i].soup);
      check('object ' + (i + 1) + ' (' + o.name + ') matches the scene shifted to the plate origin (' + TOL + ')', d <= TOL, 'max dev ' + fmt(d) + ', ' + o.soup.length / 9 + ' tris');
      const b = bounds(o.soup);
      const lift = i === 0 ? POSE_A.liftY : POSE_B.liftY;
      check('object ' + (i + 1) + ' rests at z = liftY (' + lift + ')', near(b.lo[2], lift, 1e-4), b.lo[2]);
    });
  }

  /* ---------- 3. Download selected, Format = STL ---------- */
  console.log('\n--- Download selected STL (model A, the yawed + lifted piece) ---');
  await selectModel(page, idA);
  const mA = await page.evaluate(modelSoup, idA);
  await page.selectOption('#export-format', 'stl');
  files.selSTL = await download(page, '#btn-export-model', tmp, { dialog: true, prefix: 'selected-' });
  check('downloads a .stl named after the model', path.basename(files.selSTL) === 'selected-' + mA.name + '.stl', path.basename(files.selSTL));
  let selSTL = null;
  try { selSTL = parseBinarySTL(fs.readFileSync(files.selSTL)); } catch (e) { check('binary STL parses and its length matches the declared count', false, e.message); }
  if (selSTL) {
    const d = maxDiff(selSTL, toZup(mA.soup, 0, 0, 0));
    check('the file is the model at its own centred origin, (x,-z,y), vertex for vertex (' + TOL + ')', d <= TOL, 'max dev ' + fmt(d));
    const dScene = maxDiff(selSTL, toZup(scene[0].soup, 0, 0, -BED_HOVER));
    check('contract: the placed pose (yaw 0.7, lift 3.37, x/z) is NOT carried on this route', dScene > 1, 'dev from scene ' + fmt(dScene));
  }

  /* ---------- 4. Download selected, Format = 3MF ---------- */
  console.log('\n--- Download selected 3MF (model A) ---');
  await page.selectOption('#export-format', '3mf');
  files.sel3MF = await download(page, '#btn-export-model', tmp, { dialog: true, prefix: 'selected-' });
  check('downloads a .3mf named after the model', path.basename(files.sel3MF) === 'selected-' + mA.name + '.3mf', path.basename(files.sel3MF));
  let sel3MF = null;
  try { sel3MF = await parse3MF(files.sel3MF); } catch (e) { check('nso-3mf-read.js opens the archive', false, e.message); }
  if (sel3MF) {
    check('exactly one object', sel3MF.length === 1, sel3MF.length);
    // the documented contract: model axes, then centred on the plate, resting on z = 0
    const raw = toZup(mA.soup, 0, 0, 0);
    const b = bounds(raw);
    const expected = toZup(mA.soup, plate.w / 2 - (b.lo[0] + b.hi[0]) / 2, plate.d / 2 - (b.lo[1] + b.hi[1]) / 2, -b.lo[2]);
    const d = maxDiff(sel3MF[0].soup, expected);
    check('the object is the model centred on the plate, resting on z = 0, vertex for vertex (' + TOL + ')', d <= TOL, 'max dev ' + fmt(d));
    const bo = bounds(sel3MF[0].soup);
    check('rests on z = 0', near(bo.lo[2], 0, TOL), bo.lo[2]);
    check('centred on the plate', near((bo.lo[0] + bo.hi[0]) / 2, plate.w / 2, TOL) && near((bo.lo[1] + bo.hi[1]) / 2, plate.d / 2, TOL),
      JSON.stringify([(bo.lo[0] + bo.hi[0]) / 2, (bo.lo[1] + bo.hi[1]) / 2]));
    const dScene = maxDiff(sel3MF[0].soup, expect3MF[0].soup);
    check('contract: the placed pose is NOT carried on this route either', dScene > 1, 'dev from scene ' + fmt(dScene));
  }

  /* ---------- 5. re-import every file through the app's own input ---------- */
  console.log('\n--- re-import through handleFiles: rawTris must be the file, untranslated ---');
  const reimports = [
    ['plate STL', files.plateSTL, plateSTL && [plateSTL]],
    ['plate 3MF', files.plate3MF, plate3MF && plate3MF.map(o => o.soup)],
    ['selected STL', files.selSTL, selSTL && [selSTL]],
    ['selected 3MF', files.sel3MF, sel3MF && sel3MF.map(o => o.soup)]
  ];
  /* All four re-imports are geometry imports, and the two 3MF ones stay that
     way on purpose. A plate 3MF now carries an NSO scene block, and re-opening
     one onto a plate that still has pieces asks first (app-core.js,
     restoreSceneFrom3MF); nothing accepts the prompt here, so the import takes
     the documented geometry-only fallback and the file soup below is still
     what lands. The selected-model route never restores placement at all. The
     scene route itself is driven end to end by
     tools/nso_scene_roundtrip_test.js. */
  for (const [label, file, soups] of reimports) {
    if (!file || !soups) { check(label + ': nothing to re-import', false); continue; }
    const models = await reimport(page, file);
    check(label + ': re-import adds ' + soups.length + ' model(s)', models.length === soups.length, models.length);
    models.forEach((m, i) => {
      if (!soups[i]) return;
      const d = maxDiff(m.raw, soups[i]);
      check(label + ' model ' + (i + 1) + ': rawTris is the file soup, Z up, untranslated (' + TOL + ')',
        m.rawAxis === 'zup' && d <= TOL, 'axis ' + m.rawAxis + ', max dev ' + fmt(d));
    });
  }
  // The app centres every model on import (geometry.center() in addModel), so a
  // re-imported piece's PLACEMENT is never the file's; only rawTris keeps it.
  // That is by design and the same for STL and 3MF; recorded, not gated.
  note('imported models are re-centred by addModel(); file placement survives only in rawTris');

  const bad = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors during the drive', bad.length === 0, bad.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' FAILED' : 'ALL GREEN') + '  (' + tmp + ')');
  process.exit(fails ? 1 : 0);
}).catch(err => {
  console.error('harness error:', err);
  process.exit(1);
});

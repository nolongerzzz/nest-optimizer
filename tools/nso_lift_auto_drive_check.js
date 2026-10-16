#!/usr/bin/env node
/* Lift 2 (auto-aim and Strip) - driven through the REAL app in headless Chromium.

     node tools/nso_lift_auto_drive_check.js                     exit 0 = every gate held
     node tools/nso_lift_auto_drive_check.js tools/lift-auto-out ...and keep the screenshots
                                                                (npm run lift:auto-shots; gitignored,
                                                                never committed)

   Fixtures are generated (tools/nso_lift_auto_fixtures.js) and go in through
   the app's own Import. Lift is worked on the plate, from the Subtract card
   (app-lift-plate.js): every hover and click is a real pointer event on the
   main canvas at the screen point of a triangle the app drew; every tick box
   and button is a real click in the card. Remove has no button any more
   (the plate's Lift lifts; lift:auto-test still holds NSO_LiftAuto.remove).

     1. the flat plate: Lift reads it - 10 features (3 lines, 1 large shape,
        6 dots); Strip's list, every group ticked, "bare plate"
     2. untick the lines: Confirm lifts 7 - seven closed pieces where they stood,
        the three lines stay, ONE undo step; Ctrl+Z puts it back bit for bit
     3. a click on the ring lifts it alone: closed, its bore open; Ctrl+Z
     4. G-scope's Features row counts the same 10, grouped, read-only
     5. the dish: Lift reads it with Lift 3 - six dots and the long squiggle,
        each cut along the dish; a click lifts a dot; Ctrl+Z
     6. the dish, Strip: 7 lift, nothing left; Ctrl+Z
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_auto_fixtures.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-auto-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const L = require('./nso_lift_plate_drive_lib.js');
const { readout, card, raw, plateState, pieceInfo, overlaps, added, sameSoup, volumeOf, frameOn, hoverTri, clickTri, ctrlZ,
        waitRead, armOn, disarm, featureOf, strip, openScopeOnPlate, features, dropPieces } = L;
const C = L.makeCheck(), check = C.check;

const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array, Int32Array, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const FL = FX.flat(ctx.rawFlatCapLoops), DS = FX.dish();
const FLAT_STL = path.join(TMP, 'lift-auto-flat.stl'), DISH_STL = path.join(TMP, 'lift-auto-dish.stl');
writeSTL(FLAT_STL, FL.soup);
writeSTL(DISH_STL, DS.soup);

function rawTriNear(s, x, y, zMin, zMax) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    const nz = (s[o + 3] - s[o]) * (s[o + 7] - s[o + 1]) - (s[o + 4] - s[o + 1]) * (s[o + 6] - s[o]);
    if (nz <= 0) continue;
    const cz = (s[o + 2] + s[o + 5] + s[o + 8]) / 3;
    if (zMin != null && (cz < zMin || cz > zMax)) continue;
    const d = Math.hypot((s[o] + s[o + 3] + s[o + 6]) / 3 - x, (s[o + 1] + s[o + 4] + s[o + 7]) / 3 - y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
const T_RING = rawTriNear(FL.soup, 13.5, 18, 3.7, 3.9);       // the ring's top
const T_DISHDOT = rawTriNear(DS.soup, 20, 40);                // the dot at (20, 40), its top

const shots = L.shooter(OUT, KEEP, ROOT);
const groupsNow = page => page.evaluate(() => NSO_LIFT_PLATE.groups(NSO_LIFT_PLATE.analysis(), NSO_LIFT_PLATE.minHeight()).list.map(G => G.key + ' ' + G.ids.length).join(', '));

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  /* ======================================================== 1. the flat plate */
  console.log('\n=== 1. the flat plate: Lift reads it ===');
  const flatId = await loadSTL(page, FLAT_STL);
  const SRC = await raw(page, flatId);
  check('the plate came in through Import', SRC.length === FL.soup.length, SRC.length / 9 + ' triangles');
  const n1 = await armOn(page, flatId), r1 = await readout(page);
  const st1 = await page.evaluate(() => NSO_LIFT_PLATE.analysis().islands.map(I => I.status));
  check('armed on the plate: the height map finds all 10, every one liftable', n1 === '10 features found' && st1.length === 10 && st1.every(s => s === 'ok'), n1);
  check('grouped: 3 lines, 1 large shape, 6 dots, in words', /10 features found on lift-auto-flat standing out more than 0\.42 mm: lines ×3 · large shape ×1 · dots ×6\./.test(r1), r1);
  await page.click('#btn-lift-strip');
  const c1 = await card(page);
  check('Strip\'s list: every group ticked, and the plate left bare', c1.strip && c1.rows.length === 3 && c1.rows.every(r => r.checked) &&
    c1.sum === 'lines ×3 · large shape ×1 · dots ×6 · bare plate' && c1.go === 'Confirm – lift 10', c1.sum + ' / ' + c1.go);
  check('the ticked features are drawn over the piece', (await page.evaluate(() => NSO_LIFT_PLATE.layer().children.length)) >= 1);
  await frameOn(page, flatId);
  await shots.plate(page, '1-strip-flat-plate');

  /* ====================================== 2. untick the lines, Confirm: 7 */
  console.log('\n=== 2. untick the lines; Confirm lifts 7 ===');
  await page.click('#lift-strip-rows input[data-group="lines"]');
  const c2 = await card(page);
  check('lines unticked: Confirm lifts 7, the plate keeps 3', c2.go === 'Confirm – lift 7' && c2.sum === 'large shape ×1 · dots ×6 · the plate keeps 3', c2.sum + ' / ' + c2.go);
  const b2 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const r2 = await readout(page), a2 = await plateState(page), add2 = added(b2, a2);
  check('Confirm says what it did, and that one Undo puts it back', /^Lifted 7 features off lift-auto-flat/.test(r2) && /One Undo \(Ctrl\+Z\) puts it all back/.test(r2), r2.slice(0, 160));
  check('seven new pieces, named after the plate', add2.length === 7 && add2.every(m => /- lifted \d+$/.test(m.name)));
  check('exactly ONE undo step', a2.undo === b2.undo + 1, b2.undo + ' -> ' + a2.undo);
  const host2 = await pieceInfo(page, flatId);
  let pv = 0, allClosed = true, allOnBed = true;
  for (const m of add2) { const p = await pieceInfo(page, m.id); pv += p.volume; if (!p.closed || p.degen) allClosed = false; if (!overlaps(p.fp, host2.fp) || !(p.yMin > host2.yMin + 1e-3)) allOnBed = false; }
  const v0 = await volumeOf(page, SRC);
  check('the plate is closed; every piece is closed and where it stood, over the plate', host2.closed && host2.degen === 0 && allClosed && allOnBed, host2.tris + ' tris');
  check('plate + pieces = the original', Math.abs(host2.volume + pv - v0) < 1e-6 * v0, host2.volume.toFixed(3) + ' + ' + pv.toFixed(3) + ' = ' + v0.toFixed(3));
  check('the card read the plate again: the 3 lines stay, nothing else', (await card(page)).count === '3 features found' && (await groupsNow(page)) === 'lines 3', await groupsNow(page));
  await shots.plate(page, '2-after-lift-7');
  await ctrlZ(page);
  const u2 = await plateState(page);
  check('one Ctrl+Z: the plate bit for bit, the seven pieces gone, the undo stack as before',
    sameSoup(await raw(page, flatId), SRC) && u2.models.length === b2.models.length && u2.undo === b2.undo);
  check('...and the card counts 10 again, said in words', (await card(page)).count === '10 features found' && /Undo: Lift reverted/.test(await readout(page)), await readout(page));

  /* ======================================================= 3. a click on the ring */
  console.log('\n=== 3. a click on the ring lifts it alone ===');
  const fRing = await featureOf(page, T_RING);
  await hoverTri(page, flatId, T_RING);
  check('hovering the ring outlines it', (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === fRing && fRing >= 0);
  const b3 = await plateState(page);
  await clickTri(page, flatId, T_RING);
  await waitRead(page, /Lifted|refused|failed/);
  const a3 = await plateState(page), add3 = added(b3, a3), pc3 = add3.length === 1 ? await pieceInfo(page, add3[0].id) : null;
  check('one piece, closed, its bore open (chi 0), where it stood; one undo step', pc3 && pc3.closed && pc3.chi === 0 && pc3.onBed && a3.undo === b3.undo + 1,
    pc3 && (pc3.tris + ' tris chi ' + pc3.chi));
  check('9 left', (await card(page)).count === '9 features found');
  await ctrlZ(page);
  check('one Ctrl+Z: the plate bit for bit', sameSoup(await raw(page, flatId), SRC) && (await plateState(page)).undo === b3.undo);
  await disarm(page);

  /* ====================================================== 4. G-scope's row */
  console.log('\n=== 4. G-scope: the Features row counts the same ===');
  await openScopeOnPlate(page);
  const f4 = await features(page);
  check('Features: the same 10, grouped, read-only', f4.title === 'Features' && f4.count === 10 && f4.controls === 0 &&
    f4.rows.join(' | ') === 'Lineslines ×3 | Large shapeslarge shape ×1 | Dotsdots ×6', f4.rows.join(' | '));
  await shots.scope(page, '3-gscope-features-flat');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  await dropPieces(page, [flatId]);

  /* ========================================================== 5. the dish */
  console.log('\n=== 5. the dish: a curved face, read from the map ===');
  const dishId = await loadSTL(page, DISH_STL);
  const DSRC = await raw(page, dishId);
  const n5 = await armOn(page, dishId), r5 = await readout(page);
  const st5 = await page.evaluate(() => { const A = NSO_LIFT_PLATE.analysis(); return { status: A.islands.map(I => I.status), fill: NSO_LIFT_PLATE.offered().map(id => A.islands[id].fill) }; });
  // Lift 3 (docs/LIFT.md section 6): the squiggle Lift 2 refused as bending
  // is cut along the dish, so all seven are offered and none refused.
  check('six dots and the squiggle found, each to be cut along the dish; nothing refused', n5 === '7 features found' &&
    st5.status.every(s => s === 'ok') && st5.fill.every(f => f === 'curved') && !/can't be lifted/.test(r5), n5 + ' / ' + r5);
  await frameOn(page, dishId);
  await shots.plate(page, '4-dish-armed');
  const b5 = await plateState(page);
  await clickTri(page, dishId, T_DISHDOT);
  await waitRead(page, /Lifted|refused|failed/);
  const r5b = await readout(page), a5 = await plateState(page), add5 = added(b5, a5);
  const host5 = await pieceInfo(page, dishId), pc5 = add5.length === 1 ? await pieceInfo(page, add5[0].id) : null;
  check('a click on a dot lifts it along the dish: the surface carried across and welded', /^Lifted 1 feature off lift-auto-dish .*: it is the surface round it carried across where it stood and welded to it at the rim/.test(r5b), r5b.slice(0, 200));
  check('the dot is one closed piece; the dish stays closed; volumes add up', pc5 && pc5.closed && host5.closed &&
    Math.abs(host5.volume + pc5.volume - await volumeOf(page, DSRC)) < 1e-6 * host5.volume);
  await ctrlZ(page);
  check('one Ctrl+Z: the dish bit for bit', sameSoup(await raw(page, dishId), DSRC) && (await plateState(page)).undo === b5.undo);

  /* ======================================================= 6. the dish, Strip */
  console.log('\n=== 6. the dish, Strip ===');
  await page.click('#btn-lift-strip');
  const c6 = await card(page);
  check('Strip on the dish: 1 line, 6 dots, nothing can\'t-lift', c6.sum === 'line ×1 · dots ×6 · bare plate' && c6.go === 'Confirm – lift 7', c6.sum);
  const b6 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const a6 = await plateState(page), add6 = added(b6, a6), host6 = await pieceInfo(page, dishId);
  let v6 = 0, c6b = true;
  for (const m of add6) { const p = await pieceInfo(page, m.id); v6 += p.volume; if (!p.closed) c6b = false; }
  check('seven closed pieces; the dish stays closed; volumes add up; one step', add6.length === 7 && c6b && host6.closed && a6.undo === b6.undo + 1 &&
    Math.abs(host6.volume + v6 - await volumeOf(page, DSRC)) < 1e-6 * host6.volume);
  check('...and nothing is left standing on the dish', (await card(page)).count === '0 features found');
  await shots.plate(page, '5-dish-after-strip');
  await ctrlZ(page);
  check('one Ctrl+Z: the dish bit for bit, the seven pieces gone', sameSoup(await raw(page, dishId), DSRC) && (await plateState(page)).models.length === b6.models.length);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });

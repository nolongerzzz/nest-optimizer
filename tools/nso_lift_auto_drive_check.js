#!/usr/bin/env node
/* Lift 2 (auto-aim and Strip) - driven through the REAL app in headless Chromium.

     node tools/nso_lift_auto_drive_check.js                     exit 0 = every gate held
     node tools/nso_lift_auto_drive_check.js tools/lift-auto-out ...and keep the screenshots
                                                                (npm run lift:auto-shots; gitignored,
                                                                never committed)

   Fixtures are generated (tools/nso_lift_auto_fixtures.js) and go in through
   the app's own Import. Every pick is a real click on G-scope's canvas, at
   the screen point of a triangle G-scope drew; every tick box and button is
   a real click in the sidebar.

     1. the flat plate, Strip: Pick base face, a click on the top - every
        detail found and grouped (6 small dots, 3 lines & squiggles, 1 large
        shape), all ticked, Lift 10 / Remove 10, coloured by group
     2. untick lines & squiggles: Lift 7; a click on the ring ticks it alone
        (Lift 8), again unticks it; Lift 7 - seven closed pieces on free plate,
        the three lines stay, ONE undo step; Ctrl+Z puts it back bit for bit
     3. Remove 10: no pieces, the plate flat and closed; Ctrl+Z bit for bit
     4. back to Pick: Phase 1 on the flat top, unchanged
     5. the dish, Pick: Phase 1 says curved, so the map reads it - six dots
        and the long squiggle offered (Lift 3: the squiggle, refused by
        Lift 2 as bending, is cut along the dish); a dot lifts; Ctrl+Z
     6. the dish, Strip: 6 small dots and 1 squiggle, none can't-lift;
        Lift 7; Ctrl+Z
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

let fails = 0, passes = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
}

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
const T_TOP = rawTriNear(FL.soup, 26, 26, 2.99, 3.01);        // free plate top, a corner
const T_RING = rawTriNear(FL.soup, 13.5, 18, 3.7, 3.9);       // the ring's top
const T_DOT = rawTriNear(FL.soup, -18, 18, 3.5, 3.7);         // the middle dot's top
const T_DISH = rawTriNear(DS.soup, 30, 35);                   // the dish, clear of every detail
const T_DISHDOT = rawTriNear(DS.soup, 20, 40);                // the dot at (20, 40), its top

/* ---- page helpers (as tools/nso_lift_drive_check.js) ---- */
const screenOfTri = (page, objName, tri) => page.evaluate(([name, t]) => {
  const MS = NSO_MICROSCOPE, d = MS.getDoc(), o = d.objects.find(x => x.name === name || x.sourceId === name);
  if (!o) return null;
  const P = o.positions, c = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (let q = 0; q < 3; q++) c[q] += P[t * 9 + k * 3 + q] / 3;
  const v = MS.getView();
  v.camera.updateMatrixWorld(true);
  const p = MS.toView(c[0], c[1], c[2]).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}, [objName, tri]);
async function clickTri(page, objName, tri, shift) {
  const at = await screenOfTri(page, objName, tri);
  if (!at) throw new Error('no screen point for ' + objName + ' #' + tri);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(at.x, at.y);
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
}
async function frame(page, sourceId, dist) {
  await page.evaluate(([sid, dist]) => {
    const MS = NSO_MICROSCOPE, d = MS.getDoc(), o = d.objects.find(x => x.sourceId === sid);
    const b = o.bounds, v = MS.getView();
    const c = MS.toView((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ);
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    v.controls.target.copy(c);
    v.camera.position.set(c.x, c.y + span * (dist || 0.8), c.z + span * 0.75);
    v.controls.update();
  }, [sourceId, dist]);
  await page.waitForTimeout(250);
}
async function shotScope(page, name) {
  await page.evaluate(() => { NSO_MICROSCOPE.flushView(); document.getElementById('ms-lift-row').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
}
const readout = page => page.evaluate(() => document.getElementById('ms-lift-read').textContent);
const raw = (page, id) => page.evaluate(id => { const m = state.models.find(q => q.id === id); return m ? Array.from(m.rawTris) : null; }, id);
const plateState = page => page.evaluate(() => ({
  models: state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : 0 })),
  placed: state.placed.map(p => ({ id: p.sourceId, x: p.x, z: p.z })),
  undo: state.undoStack.length
}));
const pieceInfo = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), p = state.placed.find(q => q && q.sourceId === id);
  if (!m) return null;
  const c = NSO_LiftAuto.census(m.rawTris), fp = p ? placedFootprint(p) : null, plate = getCurrentPlate();
  return { id, name: m.name, tris: c.tris, closed: c.closed, degen: c.degen, chi: c.chi, volume: NSO_Lift.volume(m.rawTris), fp,
           onBed: fp ? (fp.minx >= -plate.w / 2 - 1e-6 && fp.maxx <= plate.w / 2 + 1e-6 && fp.minz >= -plate.d / 2 - 1e-6 && fp.maxz <= plate.d / 2 + 1e-6) : false };
}, id);
const panel = page => page.evaluate(() => {
  const g = {};
  document.querySelectorAll('#ms-lift-groups .ms-lift-group').forEach(l => {
    const cb = l.querySelector('input');
    g[cb.getAttribute('data-group')] = { checked: cb.checked, disabled: cb.disabled, count: l.querySelector('.ms-lift-n').textContent, label: l.textContent };
  });
  const b = id => { const e = document.getElementById(id); return { text: e.textContent, disabled: e.disabled, shown: getComputedStyle(e).display !== 'none' }; };
  return { groups: g, why: Array.from(document.querySelectorAll('#ms-lift-groups .ms-lift-why')).map(p => p.textContent),
           lift: b('ms-btn-lift'), remove: b('ms-btn-lift-remove'), clear: b('ms-btn-lift-clear'),
           shown: getComputedStyle(document.getElementById('ms-lift-groups')).display !== 'none',
           tab: NSO_GSCOPE_LIFT.tab(), pick: document.getElementById('ms-lift-tab-pick').getAttribute('aria-pressed'),
           strip: document.getElementById('ms-lift-tab-strip').getAttribute('aria-pressed') };
});
const analysisInfo = page => page.evaluate(() => {
  const A = NSO_GSCOPE_LIFT.analysis();
  if (!A) return null;
  return { kind: A.kind || 'phase1', islands: A.islands.length, groups: A.groups, chosen: NSO_GSCOPE_LIFT.chosen(), offered: NSO_GSCOPE_LIFT.offered(),
           status: A.islands.map(I => I.status), group: A.islands.map(I => I.group), layer: NSO_GSCOPE_LIFT.layer().children.length };
});
async function openScopeOnPlate(page) {
  await page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
  await page.click('#btn-microscope');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
  if (await page.evaluate(() => !(NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate'))) await page.click('#ms-btn-plate');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate', null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
async function liftMode(page, wantOn) {
  if (await page.evaluate(() => NSO_GSCOPE_LIFT.isOn()) !== wantOn) await page.click('#ms-btn-lift-mode');
}
async function ctrlZ(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
}
async function waitRead(page, re) {
  await page.waitForFunction(src => new RegExp(src).test(document.getElementById('ms-lift-read').textContent), re.source, { timeout: 120000 });
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  /* ====================================================== 1. flat plate, Strip */
  console.log('\n=== 1. the flat plate, Strip ===');
  const flatId = await loadSTL(page, FLAT_STL);
  const SRC = await raw(page, flatId);
  check('the plate came in through Import', SRC.length === FL.soup.length, SRC.length / 9 + ' triangles');
  await openScopeOnPlate(page);
  const p0 = await panel(page);
  check('the section is "Lift", with a Pick | Strip switch on Pick', await page.evaluate(() =>
    document.querySelector('#ms-lift-row .ms-section-title').textContent === 'Lift') && p0.tab === 'pick' && p0.pick === 'true' && p0.strip === 'false');
  await liftMode(page, true);
  await page.click('#ms-lift-tab-strip');
  const p1 = await panel(page);
  check('Strip is on: the switch says so, Remove is shown, Clear choice is not', p1.tab === 'strip' && p1.strip === 'true' && p1.remove.shown && !p1.clear.shown);
  const flatName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, flatId);
  await frame(page, flatId);
  await clickTri(page, flatName, T_TOP);
  const A1 = await analysisInfo(page), q1 = await panel(page), r1 = await readout(page);
  check('a real click on the top: the height map finds all 10, every one liftable', A1 && A1.kind === 'map' && A1.islands === 10 && A1.status.every(s => s === 'ok'), r1);
  check('the groups, each with a count: 6 small dots, 3 lines & squiggles, 1 large shape, 0 can\'t lift',
    q1.shown && q1.groups.dots.count === '6' && q1.groups.lines.count === '3' && q1.groups.large.count === '1' && q1.groups.cant.count === '0' &&
    /Small dots/.test(q1.groups.dots.label) && /Lines & squiggles/.test(q1.groups.lines.label) && /Large shapes/.test(q1.groups.large.label) && /Can't lift/.test(q1.groups.cant.label),
    JSON.stringify(Object.keys(q1.groups).map(k => k + ' ' + q1.groups[k].count)));
  check('every liftable group starts ticked: Lift 10, Remove 10', q1.groups.dots.checked && q1.groups.lines.checked && q1.groups.large.checked &&
    q1.lift.text === 'Lift 10' && !q1.lift.disabled && q1.remove.text === 'Remove 10' && !q1.remove.disabled);
  check('the read-out says what was found, in words', /Found 6 small dots, 3 lines & squiggles, 1 large shape standing out more than 0\.42 mm/.test(r1) &&
    /10 ticked: Lift 10 makes each its own piece, Remove 10 throws them away/.test(r1), r1);
  check('the islands are drawn over the piece, coloured by group', A1.layer >= 2, A1.layer + ' overlay meshes');
  await shotScope(page, '1-strip-flat-plate');

  /* ====================================== 2. untick a group, click one, Lift 7 */
  console.log('\n=== 2. untick lines & squiggles; a click on the ring; Lift 7 ===');
  await page.click('#ms-lift-groups input[data-group="lines"]');
  await page.waitForTimeout(200);
  let q2 = await panel(page);
  check('unticking lines & squiggles: Lift 7', !q2.groups.lines.checked && q2.lift.text === 'Lift 7' && q2.remove.text === 'Remove 7', q2.lift.text);
  await clickTri(page, flatName, T_RING);
  q2 = await panel(page);
  check('a click on the ring ticks it alone: Lift 8, the row says 1 of 3', q2.lift.text === 'Lift 8' && q2.groups.lines.count === '1 of 3', q2.lift.text + ', ' + q2.groups.lines.count);
  await clickTri(page, flatName, T_RING);
  q2 = await panel(page);
  check('...a second click unticks it: Lift 7', q2.lift.text === 'Lift 7', q2.lift.text);
  await shotScope(page, '2-strip-lines-unticked');
  const b2 = await plateState(page);
  const tickedIds = await page.evaluate(() => NSO_GSCOPE_LIFT.chosen().slice());
  const tickedGroups = await page.evaluate(ids => ids.map(id => NSO_GSCOPE_LIFT.analysis().islands[id].group), tickedIds);
  check('the 7 ticked are the dots and the large shape', tickedIds.length === 7 && tickedGroups.every(g => g === 'dots' || g === 'large'));
  await page.click('#ms-btn-lift');
  await waitRead(page, /Lifted|refused|failed/);
  const r2 = await readout(page), a2 = await plateState(page);
  const added = a2.models.filter(m => !b2.models.some(b => b.id === m.id));
  check('Lift 7 says what it did, and that one Undo puts it back', /^Lifted 7 details off/.test(r2) && /One Undo \(Ctrl\+Z\) puts it all back/.test(r2), r2.slice(0, 160));
  check('seven new pieces, named after the plate', added.length === 7 && added.every(m => /- lifted \d+$/.test(m.name)));
  check('exactly ONE undo step', a2.undo === b2.undo + 1, b2.undo + ' -> ' + a2.undo);
  const host2 = await pieceInfo(page, flatId);
  let pv = 0, allClosed = true, allOnBed = true;
  for (const m of added) { const p = await pieceInfo(page, m.id); pv += p.volume; if (!p.closed || p.degen) allClosed = false; if (!p.onBed) allOnBed = false; }
  const v0 = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), SRC);
  check('the plate is closed; every piece is closed and on free plate', host2.closed && host2.degen === 0 && allClosed && allOnBed, host2.tris + ' tris');
  check('plate + pieces = the original', Math.abs(host2.volume + pv - v0) < 1e-6 * v0, host2.volume.toFixed(3) + ' + ' + pv.toFixed(3) + ' = ' + v0.toFixed(3));
  const A2 = await analysisInfo(page);
  check('G-scope re-read the plate, the base still picked: the 3 lines & squiggles stay, nothing else', A2 && A2.islands === 3 && A2.group.every(g => g === 'lines'),
    A2 && JSON.stringify(A2.groups));
  await shotScope(page, '3-strip-after-lift-7');
  await ctrlZ(page);
  const U2 = await raw(page, flatId), u2 = await plateState(page);
  check('one Ctrl+Z: the plate bit for bit, the seven pieces gone, the undo stack as before',
    U2.length === SRC.length && U2.every((v, i) => v === SRC[i]) && u2.models.length === b2.models.length && u2.undo === b2.undo);
  check('...and G-scope shows all 10 again, said in words', (await analysisInfo(page)).islands === 10 && /Undo: Lift reverted/.test(await readout(page)), await readout(page));

  /* ================================================================ 3. Remove */
  console.log('\n=== 3. Remove 10 ===');
  await page.click('#ms-lift-groups input[data-group="lines"]');
  await page.waitForTimeout(200);
  const q3 = await panel(page);
  check('ticking lines & squiggles again: Remove 10', q3.remove.text === 'Remove 10', q3.remove.text);
  const b3 = await plateState(page);
  await page.click('#ms-btn-lift-remove');
  await waitRead(page, /Removed|refused|failed/);
  const r3 = await readout(page), a3 = await plateState(page), host3 = await pieceInfo(page, flatId);
  check('Remove 10 says what it did; no piece is made; one undo step', /^Removed 10 details from/.test(r3) && a3.models.length === b3.models.length && a3.undo === b3.undo + 1, r3.slice(0, 160));
  check('the plate is closed and the bare 60 x 60 x 3 slab: 10800 mm³', host3.closed && Math.abs(host3.volume - 10800) < 1e-6, host3.volume.toFixed(3));
  const A3 = await analysisInfo(page);
  check('...flat: G-scope reads nothing standing on it', A3 && A3.islands === 0, A3 && A3.islands);
  await shotScope(page, '4-strip-after-remove');
  await ctrlZ(page);
  const U3 = await raw(page, flatId), u3 = await plateState(page);
  check('one Ctrl+Z puts every detail back, bit for bit', U3.length === SRC.length && U3.every((v, i) => v === SRC[i]) && u3.undo === b3.undo &&
    /Undo: Remove reverted/.test(await readout(page)), await readout(page));

  /* ======================================================== 4. back to Pick */
  console.log('\n=== 4. back to Pick ===');
  await page.click('#ms-lift-tab-pick');
  const A4 = await analysisInfo(page), q4 = await panel(page);
  check('Pick: the same base, read by Phase 1 as before (56-detail plate rules): 10 details, all offered', A4 && A4.kind === 'phase1' && A4.islands === 10 && A4.offered.length === 10);
  check('...the groups are hidden, Remove is hidden, Clear choice is back, "Lift" (nothing chosen)', !q4.shown && !q4.remove.shown && q4.clear.shown && q4.lift.text === 'Lift');
  check('...the read-out is Phase 1\'s', /^Base: the top face at z 3\.00/.test(await readout(page)), await readout(page));
  await clickTri(page, flatName, T_DOT);
  check('a click on a dot chooses it, as before', (await page.evaluate(() => NSO_GSCOPE_LIFT.chosen())).length === 1);

  /* ======================================================== 5. the dish, Pick */
  console.log('\n=== 5. the dish, Pick: a curved face read from the map ===');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  await page.evaluate(id => { const i = state.placed.findIndex(p => p.sourceId === id); if (i >= 0) { state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1); } state.models = state.models.filter(m => m.id !== id); state.placed.forEach((p, k) => { p.mesh.userData.placedIndex = k; }); }, flatId);
  const dishId = await loadSTL(page, DISH_STL);
  const DSRC = await raw(page, dishId);
  await openScopeOnPlate(page);
  await liftMode(page, true);
  const dishName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, dishId);
  await frame(page, dishId, 1.6);
  await clickTri(page, dishName, T_DISH);
  const A5 = await analysisInfo(page), r5 = await readout(page);
  check('Phase 1 calls the dish curved, so the map reads it: the read-out says so', A5 && A5.kind === 'map' && /This face bends, so it is read from a height map/.test(r5), r5.slice(0, 200));
  // Lift 3 (docs/LIFT.md section 6): the squiggle Lift 2 refused as bending
  // is now cut along the dish, so all seven are offered and none refused.
  check('six dots and the squiggle offered, each cut along the dish; nothing refused', A5.offered.length === 7 && A5.status.every(s => s === 'ok') &&
    /each lifted along the surface they stand on/.test(r5) && !/can't be lifted/.test(r5), r5);
  await shotScope(page, '5-pick-dish');
  await clickTri(page, dishName, T_DISHDOT);
  check('a click on a dot chooses it', (await page.evaluate(() => NSO_GSCOPE_LIFT.chosen())).length === 1, await readout(page));
  const b5 = await plateState(page);
  await page.click('#ms-btn-lift');
  await waitRead(page, /Lifted|refused|failed/);
  const a5 = await plateState(page), host5 = await pieceInfo(page, dishId);
  const new5 = a5.models.filter(m => !b5.models.some(b => b.id === m.id));
  const pc5 = new5.length === 1 ? await pieceInfo(page, new5[0].id) : null;
  check('the dot comes off the curved dish as one closed piece; the dish stays closed; volumes add up', pc5 && pc5.closed && host5.closed &&
    Math.abs(host5.volume + pc5.volume - await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), DSRC)) < 1e-6 * host5.volume, await readout(page));
  await ctrlZ(page);
  const U5 = await raw(page, dishId);
  check('one Ctrl+Z: the dish bit for bit', U5.length === DSRC.length && U5.every((v, i) => v === DSRC[i]) && (await plateState(page)).undo === b5.undo);

  /* ======================================================= 6. the dish, Strip */
  console.log('\n=== 6. the dish, Strip ===');
  await page.click('#ms-lift-tab-strip');
  const q6 = await panel(page), A6 = await analysisInfo(page);
  check('Strip on the dish: 6 small dots, 1 line or squiggle, none can\'t lift (Lift 3)', A6 && A6.kind === 'map' && q6.groups.dots.count === '6' &&
    q6.groups.lines.count === '1' && q6.groups.cant.count === '0' && q6.why.length === 0, JSON.stringify(A6 && A6.groups));
  check('Lift 7', q6.lift.text === 'Lift 7');
  await shotScope(page, '6-strip-dish');
  const b6 = await plateState(page);
  await page.click('#ms-btn-lift');
  await waitRead(page, /Lifted|refused|failed/);
  const a6 = await plateState(page), host6 = await pieceInfo(page, dishId);
  const new6 = a6.models.filter(m => !b6.models.some(b => b.id === m.id));
  let v6 = 0, c6 = true;
  for (const m of new6) { const p = await pieceInfo(page, m.id); v6 += p.volume; if (!p.closed) c6 = false; }
  check('seven closed pieces; the dish stays closed; volumes add up', new6.length === 7 && c6 && host6.closed &&
    Math.abs(host6.volume + v6 - await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), DSRC)) < 1e-6 * host6.volume);
  check('...and nothing is left standing on the dish', (await analysisInfo(page)).islands === 0);
  await shotScope(page, '7-strip-dish-after-lift');
  await ctrlZ(page);
  const U6 = await raw(page, dishId);
  check('one Ctrl+Z: the dish bit for bit, the six pieces gone', U6.length === DSRC.length && U6.every((v, i) => v === DSRC[i]) &&
    (await plateState(page)).models.length === b6.models.length);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (fails) { console.log('FAILED: ' + FAILED.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });

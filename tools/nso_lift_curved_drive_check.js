#!/usr/bin/env node
/* Lift 3 (lift off a curved base, repair to match) - driven through the REAL
   app in headless Chromium.

     node tools/nso_lift_curved_drive_check.js                       exit 0 = every gate held
     node tools/nso_lift_curved_drive_check.js tools/lift-curved-out ...and keep the screenshots
                                                                    (npm run lift:curved-shots;
                                                                    gitignored, never committed)

   Fixtures are generated (tools/nso_lift_curved_fixtures.js) and go in
   through the app's own Import. Every pick is a real click on G-scope's
   canvas, at the screen point of a triangle G-scope drew; every tick box and
   button is a real click in the sidebar.

     1. the spiky ball, Pick: Phase 1 calls it curved, the map reads it with
        Lift 3 - the spike beside the click offered, cut along the ball; the
        ones round the curve can't-lift, in words. A click on the spike, Lift:
        one closed piece on free plate, the ball closed and bare there,
        welded at the rim, ONE undo step; Ctrl+Z puts it back bit for bit.
     2. the domed plate, Strip: eight dots, the squiggle (Lift 2 refused it)
        and the plaque, all ticked: Lift 10 - ten closed pieces, the dome
        closed, the plaque's note in words, a fresh read finds nothing;
        Ctrl+Z bit for bit. Remove 10: no pieces; Ctrl+Z bit for bit.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const CF = require('./nso_lift_curved_fixtures.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-curved-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

let fails = 0, passes = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
}

const SB = CF.sphere(), DM = CF.dome();
const BALL_STL = path.join(TMP, 'lift-curved-ball.stl'), DOME_STL = path.join(TMP, 'lift-curved-dome.stl');
writeSTL(BALL_STL, SB.soup);
writeSTL(DOME_STL, DM.soup);

/* The raw triangle whose centroid is nearest p, facing along `out`. */
function rawTriAt(s, p, out) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    const u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]], v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
    const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] <= 0) continue;
    const d = Math.hypot((s[o] + s[o + 3] + s[o + 6]) / 3 - p[0], (s[o + 1] + s[o + 4] + s[o + 7]) / 3 - p[1], (s[o + 2] + s[o + 5] + s[o + 8]) / 3 - p[2]);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
const TOP = SB.truth.find(T => T.normal[2] > 0.99);                     // the spike on top
const T_BALL = rawTriAt(SB.soup, (() => { const p = [0, 3.5, 20]; const r = Math.hypot(...p); return p.map(x => x * 20 / r); })(), [0, 0.17, 1]);
const T_SPIKE = rawTriAt(SB.soup, [TOP.center[0], TOP.center[1], 21.2], [0, 0, 1]);   // on the spike, half way up
const T_DOME = rawTriAt(DM.soup, [34, 30, DM.baseZ(34, 30)], [0, 0, 1]);

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

  /* ======================================================== 1. the ball, Pick */
  console.log('\n=== 1. the spiky ball, Pick: a curved face, read and lifted along it ===');
  const ballId = await loadSTL(page, BALL_STL);
  const BSRC = await raw(page, ballId);
  check('the ball came in through Import', BSRC.length === SB.soup.length, BSRC.length / 9 + ' triangles');
  await openScopeOnPlate(page);
  await liftMode(page, true);
  const ballName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, ballId);
  await frame(page, ballId, 0.9);
  await clickTri(page, ballName, T_BALL);
  await waitRead(page, /Base:|Lift/);
  const A1 = await analysisInfo(page), r1 = await readout(page);
  check('Phase 1 calls the ball curved, so the map reads it, and says so', A1 && A1.kind === 'map' && /This face bends, so it is read from a height map/.test(r1), r1.slice(0, 160));
  const fill1 = await page.evaluate(([c, r]) => {
    const A = NSO_GSCOPE_LIFT.analysis(), off = NSO_GSCOPE_LIFT.offered();
    return { curved: A.curved, fills: off.map(id => A.islands[id].fill),
             top: off.some(id => Math.hypot(A.islands[id].center[0] - c[0], A.islands[id].center[1] - c[1], A.islands[id].center[2] - c[2]) < r) };
  }, [TOP.center, 2]);
  check('the spike beside the click is offered, to be cut along the ball - not refused', fill1.top && fill1.curved && fill1.fills.every(f => f === 'curved') &&
    /stands? out more than 0\.42 mm \([0-9.]+ - [0-9.]+ mm\), each lifted along the surface (it stands|they stand) on, the face made good where (it|they) stood/.test(r1), r1);
  check('the bumps round the curve can\'t be lifted from here, and the read-out says why', A1.status.filter(s => s === 'slant').length >= 5 &&
    /can't be lifted - \d+: it is seen too slantwise from where the face was clicked .* click the face nearer it/.test(r1));
  await shotScope(page, '1-pick-ball');
  await clickTri(page, ballName, T_SPIKE);
  check('a click on the spike chooses it', (await page.evaluate(() => NSO_GSCOPE_LIFT.chosen())).length === 1, await readout(page));
  const b1 = await plateState(page);
  await page.click('#ms-btn-lift');
  await waitRead(page, /Lifted|refused|failed/);
  const r1b = await readout(page), a1 = await plateState(page), host1 = await pieceInfo(page, ballId);
  const new1 = a1.models.filter(m => !b1.models.some(b => b.id === m.id));
  const pc1 = new1.length === 1 ? await pieceInfo(page, new1[0].id) : null;
  check('Lift says it carried the surface across and welded it, and that one Undo puts it back',
    /^Lifted 1 detail off .*: it is the surface round it carried across where it stood and welded to it at the rim, every other triangle as it was/.test(r1b) &&
    /One Undo \(Ctrl\+Z\) puts it all back/.test(r1b), r1b.slice(0, 220));
  check('one new piece, named after the ball, closed, on free plate', pc1 && /- lifted \d+$/.test(new1[0].name) && pc1.closed && pc1.degen === 0 && pc1.onBed, pc1 && pc1.tris + ' tris');
  check('the ball keeps its id and stays closed; exactly ONE undo step', host1 && host1.closed && host1.degen === 0 && a1.undo === b1.undo + 1, b1.undo + ' -> ' + a1.undo);
  const vBall = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), BSRC);
  check('ball + piece = the original', Math.abs(host1.volume + pc1.volume - vBall) < 1e-6 * vBall, host1.volume.toFixed(3) + ' + ' + pc1.volume.toFixed(3) + ' = ' + vBall.toFixed(3));
  const weld = await page.evaluate(([id, src]) => {
    // where the spike stood: every new corner within 0.05 mm of the sphere, every one of the ball's other triangles as it was
    const m = state.models.find(q => q.id === id), s = m.rawTris, S = new Float32Array(src);
    const key = (a, t) => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(q => a[t * 9 + q]).join(',');
    const old = new Set();
    for (let t = 0; t < S.length / 9; t++) old.add(key(S, t));
    let kept = 0, worst = 0;
    for (let t = 0; t < s.length / 9; t++) {
      if (old.has(key(s, t))) { kept++; continue; }
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(Math.hypot(s[t * 9 + k * 3], s[t * 9 + k * 3 + 1], s[t * 9 + k * 3 + 2]) - 20));
    }
    return { kept, added: s.length / 9 - kept, worst };
  }, [ballId, BSRC]);
  check('where the spike stood the ball is the sphere again (every new corner within 0.05 mm of it); every other triangle as it was',
    weld.added > 0 && weld.worst < 0.05 && weld.kept === host1.tris - weld.added, weld.kept + ' kept, ' + weld.added + ' new, worst ' + weld.worst.toFixed(4) + ' mm');
  const A1b = await analysisInfo(page);
  check('G-scope re-read the ball, the base still picked: the spike is gone, one fewer offered', A1b && A1b.kind === 'map' && A1b.offered.length === A1.offered.length - 1,
    A1b && JSON.stringify(A1b.status));
  await shotScope(page, '2-ball-after-lift');
  await ctrlZ(page);
  const U1 = await raw(page, ballId), u1 = await plateState(page);
  check('one Ctrl+Z: the ball bit for bit, the piece gone, the undo stack as before',
    U1.length === BSRC.length && U1.every((v, i) => v === BSRC[i]) && u1.undo === b1.undo && u1.models.length === b1.models.length);
  check('...and G-scope shows the spike again, said in words', (await analysisInfo(page)).offered.length === A1.offered.length && /Undo: Lift reverted/.test(await readout(page)), (await readout(page)).slice(0, 120));

  /* ======================================================= 2. the dome, Strip */
  console.log('\n=== 2. the domed plate, Strip: dots, the squiggle Lift 2 refused, a plaque ===');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  await page.evaluate(id => { const i = state.placed.findIndex(p => p.sourceId === id); if (i >= 0) { state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1); } state.models = state.models.filter(m => m.id !== id); state.placed.forEach((p, k) => { p.mesh.userData.placedIndex = k; }); }, ballId);
  const domeId = await loadSTL(page, DOME_STL);
  const DSRC = await raw(page, domeId);
  await openScopeOnPlate(page);
  await liftMode(page, true);
  await page.click('#ms-lift-tab-strip');
  const domeName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, domeId);
  await frame(page, domeId, 1.6);
  await clickTri(page, domeName, T_DOME);
  await waitRead(page, /Found|Base:|Lift/);
  const q2 = await panel(page), A2 = await analysisInfo(page), r2 = await readout(page);
  check('Strip on the dome: 8 small dots, 1 line or squiggle, 1 large shape, 0 can\'t lift', A2 && A2.kind === 'map' && q2.groups.dots.count === '8' &&
    q2.groups.lines.count === '1' && q2.groups.large.count === '1' && q2.groups.cant.count === '0', JSON.stringify(A2 && A2.groups));
  check('...all ticked: Lift 10 / Remove 10; the read-out says each is cut along the dome', q2.lift.text === 'Lift 10' && q2.remove.text === 'Remove 10' &&
    /each cut along the surface they stand on, the face made good where they stood/.test(r2), r2.slice(0, 260));
  await shotScope(page, '3-strip-dome');
  const b2 = await plateState(page);
  await page.click('#ms-btn-lift');
  await waitRead(page, /Lifted|refused|failed/);
  const r2b = await readout(page), a2 = await plateState(page), host2 = await pieceInfo(page, domeId);
  const new2 = a2.models.filter(m => !b2.models.some(b => b.id === m.id));
  let v2 = 0, c2 = true, bed2 = true;
  for (const m of new2) { const p = await pieceInfo(page, m.id); v2 += p.volume; if (!p.closed || p.degen) c2 = false; if (!p.onBed) bed2 = false; }
  const vDome = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), DSRC);
  check('Lift 10: ten closed pieces on free plate, the dome closed, one undo step, the volumes add up', new2.length === 10 && c2 && host2.closed &&
    a2.undo === b2.undo + 1 && Math.abs(host2.volume + v2 - vDome) < 1e-6 * vDome, host2.volume.toFixed(3) + ' + ' + v2.toFixed(3) + ' = ' + vDome.toFixed(3) + (bed2 ? '' : ' (some beside the bed)'));
  check('...and the plaque\'s lift says, in words, what the fill under it cannot know',
    /Note: detail \d+ covers [0-9.]+ mm², more than the [0-9.]+ mm² of clear surface measured round it: across its middle the surface carried under it is the base fitted to that surround/.test(r2b), r2b.slice(0, 400));
  const A2b = await analysisInfo(page);
  check('G-scope re-read the dome: nothing left to lift', A2b && A2b.offered.length === 0, A2b && JSON.stringify(A2b.status));
  await shotScope(page, '4-dome-after-lift');
  await ctrlZ(page);
  const U2 = await raw(page, domeId);
  check('one Ctrl+Z: the dome bit for bit, the ten pieces gone', U2.length === DSRC.length && U2.every((v, i) => v === DSRC[i]) &&
    (await plateState(page)).models.length === b2.models.length && (await plateState(page)).undo === b2.undo);
  const q3 = await panel(page);
  check('...all ten back, ticked again: Remove 10', q3.remove.text === 'Remove 10', q3.remove.text);
  const b3 = await plateState(page);
  await page.click('#ms-btn-lift-remove');
  await waitRead(page, /Removed|refused|failed/);
  const r3 = await readout(page), a3 = await plateState(page), host3 = await pieceInfo(page, domeId);
  check('Remove 10: no piece made, the dome closed, one undo step, and it says the surface was carried across',
    a3.models.length === b3.models.length && host3.closed && a3.undo === b3.undo + 1 &&
    /^Removed 10 details from .*: it is the surface round them carried across where they stood and welded to it at the rim/.test(r3), r3.slice(0, 200));
  await ctrlZ(page);
  const U3 = await raw(page, domeId);
  check('one Ctrl+Z: the dome bit for bit', U3.length === DSRC.length && U3.every((v, i) => v === DSRC[i]) && (await plateState(page)).undo === b3.undo);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (fails) { console.log('FAILED: ' + FAILED.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });

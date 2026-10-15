#!/usr/bin/env node
/* Lift 3 (lift off a curved base, repair to match) - driven through the REAL
   app in headless Chromium.

     node tools/nso_lift_curved_drive_check.js                       exit 0 = every gate held
     node tools/nso_lift_curved_drive_check.js tools/lift-curved-out ...and keep the screenshots
                                                                    (npm run lift:curved-shots;
                                                                    gitignored, never committed)

   Fixtures are generated (tools/nso_lift_curved_fixtures.js) and go in
   through the app's own Import. Lift is worked on the plate, from the
   Subtract card (app-lift-plate.js), looking straight down onto the piece:
   every hover and click is a real pointer event on the main canvas at the
   screen point of a triangle the app drew; every button is a real click in
   the card.

     1. the spiky ball: Lift reads it with Lift 3 - the spike on top offered,
        cut along the ball; the bumps round the curve can't-lift past 35
        degrees, in words. A click on the spike: one closed piece on free
        plate, the ball closed and bare there, welded at the rim, ONE undo
        step; Ctrl+Z puts it back bit for bit.
     2. the domed plate, Strip: eight dots, the squiggle (Lift 2 refused it)
        and the plaque, all ticked: ten closed pieces, the dome closed, the
        plaque's note in words, nothing left; Ctrl+Z bit for bit.
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

const L = require('./nso_lift_plate_drive_lib.js');
const { readout, card, raw, plateState, pieceInfo, added, sameSoup, volumeOf, frameOn, hoverTri, clickTri, ctrlZ,
        waitRead, armOn, featureOf, dropPieces } = L;
const C = L.makeCheck(), check = C.check;

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
const T_SPIKE = rawTriAt(SB.soup, [TOP.center[0], TOP.center[1], 21.2], [0, 0, 1]);   // on the spike, half way up

const shots = L.shooter(OUT, KEEP, ROOT);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  /* ============================================================ 1. the ball */
  console.log('\n=== 1. the spiky ball: read and lifted along it ===');
  const ballId = await loadSTL(page, BALL_STL);
  const BSRC = await raw(page, ballId);
  check('the ball came in through Import', BSRC.length === SB.soup.length, BSRC.length / 9 + ' triangles');
  const n1 = await armOn(page, ballId), r1 = await readout(page);
  const A1 = await page.evaluate(([c, r]) => {
    const A = NSO_LIFT_PLATE.analysis(), off = NSO_LIFT_PLATE.offered();
    return { status: A.islands.map(I => I.status), fills: off.map(id => A.islands[id].fill), curved: A.curved,
             top: off.some(id => Math.hypot(A.islands[id].center[0] - c[0], A.islands[id].center[1] - c[1], A.islands[id].center[2] - c[2]) < r) };
  }, [TOP.center, 2]);
  check('the spike on top is offered, to be cut along the ball - not refused', n1 === '1 feature found' && A1.top && A1.curved &&
    A1.fills.every(f => f === 'curved'), n1 + ' / ' + r1.slice(0, 200));
  check('the bumps round the curve can\'t be lifted from straight down, and the read-out says why', A1.status.filter(s => s === 'slant').length >= 4 &&
    /can't be lifted - \d+: it stands where the piece slopes too far away from looking up \(35° is the most Lift reads\) - turn the piece so that side faces up/.test(r1), r1);
  await frameOn(page, ballId, 1.6);
  const fSpike = await featureOf(page, T_SPIKE);
  await hoverTri(page, ballId, T_SPIKE);
  check('hovering the spike outlines it', fSpike >= 0 && (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === fSpike);
  await shots.plate(page, '1-ball-hover-spike');
  const b1 = await plateState(page);
  await clickTri(page, ballId, T_SPIKE);
  await waitRead(page, /Lifted|refused|failed/);
  const r1b = await readout(page), a1 = await plateState(page), host1 = await pieceInfo(page, ballId);
  const new1 = added(b1, a1), pc1 = new1.length === 1 ? await pieceInfo(page, new1[0].id) : null;
  check('a click lifts it: the surface carried across and welded, and one Undo puts it back',
    /^Lifted 1 feature off .*: it is the surface round it carried across where it stood and welded to it at the rim, every other triangle as it was/.test(r1b) &&
    /One Undo \(Ctrl\+Z\) puts it all back/.test(r1b), r1b.slice(0, 220));
  check('one new piece, named after the ball, closed, on free plate', pc1 && /- lifted \d+$/.test(new1[0].name) && pc1.closed && pc1.degen === 0 && pc1.onBed, pc1 && pc1.tris + ' tris');
  check('the ball keeps its id and stays closed; exactly ONE undo step', host1 && host1.closed && host1.degen === 0 && a1.undo === b1.undo + 1, b1.undo + ' -> ' + a1.undo);
  const vBall = await volumeOf(page, BSRC);
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
  check('the card read the ball again: the spike is gone, nothing left to offer', (await card(page)).count === '0 features found');
  await shots.plate(page, '2-ball-after-lift');
  await ctrlZ(page);
  const u1 = await plateState(page);
  check('one Ctrl+Z: the ball bit for bit, the piece gone, the undo stack as before',
    sameSoup(await raw(page, ballId), BSRC) && u1.undo === b1.undo && u1.models.length === b1.models.length);
  check('...and the card offers the spike again, said in words', (await card(page)).count === '1 feature found' && /Undo: Lift reverted/.test(await readout(page)), (await readout(page)).slice(0, 120));
  await dropPieces(page, [ballId]);

  /* ======================================================= 2. the dome, Strip */
  console.log('\n=== 2. the domed plate, Strip: dots, the squiggle Lift 2 refused, a plaque ===');
  const domeId = await loadSTL(page, DOME_STL);
  const DSRC = await raw(page, domeId);
  const n2 = await armOn(page, domeId);
  const A2 = await page.evaluate(() => { const A = NSO_LIFT_PLATE.analysis(); return { status: A.islands.map(I => I.status), fills: NSO_LIFT_PLATE.offered().map(id => A.islands[id].fill) }; });
  check('the dome: 10 found, none can\'t-lift', n2 === '10 features found' && A2.status.every(s => s === 'ok'), n2 + ' ' + JSON.stringify(A2.status));
  await page.click('#btn-lift-strip');
  const c2 = await card(page);
  check('Strip: 1 line, 1 large shape, 8 dots, all ticked: Confirm lifts 10', c2.sum === 'line ×1 · large shape ×1 · dots ×8 · bare plate' && c2.go === 'Confirm – lift 10', c2.sum + ' / ' + c2.go);
  await frameOn(page, domeId);
  await shots.plate(page, '3-strip-dome');
  const b2 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const r2b = await readout(page), a2 = await plateState(page), host2 = await pieceInfo(page, domeId), new2 = added(b2, a2);
  let v2 = 0, c2b = true, bed2 = true;
  for (const m of new2) { const p = await pieceInfo(page, m.id); v2 += p.volume; if (!p.closed || p.degen) c2b = false; if (!p.onBed) bed2 = false; }
  const vDome = await volumeOf(page, DSRC);
  check('ten closed pieces on free plate, the dome closed, one undo step, the volumes add up', new2.length === 10 && c2b && host2.closed &&
    a2.undo === b2.undo + 1 && Math.abs(host2.volume + v2 - vDome) < 1e-6 * vDome, host2.volume.toFixed(3) + ' + ' + v2.toFixed(3) + ' = ' + vDome.toFixed(3) + (bed2 ? '' : ' (some beside the bed)'));
  check('...and the plaque\'s lift says, in words, what the fill under it cannot know',
    /Note: detail \d+ covers [0-9.]+ mm², more than the [0-9.]+ mm² of clear surface measured round it: across its middle the surface carried under it is the base fitted to that surround/.test(r2b), r2b.slice(0, 400));
  check('the card read the dome again: nothing left to lift', (await card(page)).count === '0 features found');
  await shots.plate(page, '4-dome-after-strip');
  await ctrlZ(page);
  check('one Ctrl+Z: the dome bit for bit, the ten pieces gone', sameSoup(await raw(page, domeId), DSRC) &&
    (await plateState(page)).models.length === b2.models.length && (await plateState(page)).undo === b2.undo);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });

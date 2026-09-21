/* The oversized-washer export mode, driven through the real app.
     node tools/nso_oversized_washer_test.js     exit 0 = every gate held

   THE CASE. A 30 x 30 'sandwich' skin patch - the double-sided washer
   nso_skin_patch.js builds for a sandwich test - over library/box_bit_12x8x8
   (12 x 8 x 8). The washer overhangs its target by 9 mm in X and 11 mm in Z,
   which is the pose the corner-ray fit cannot express: all four of its rays
   leave the washer's outer face over open air.

   WHAT IS PINNED
   1. The block this mode exists for is real and is named exactly. With the
      mode off, Seat (support) refuses this placement with "corner 0 missed
      hull along punch axis" at every gap the slider can express, and moves
      nothing.
   2. Export was never the blocker. The plate exports, through the real
      "Export plate STL" button, with the two pieces in hard contact - true
      minimum surface-to-surface distance 0.000 mm - and the exported shells
      show it.
   3. Armed, the same click places the washer, at -0.18, 0, +0.30 (past the
      slider's own +0.05 end) and -1.50, and the status line's "true minimum"
      is the real one: checked against tools/nso_soup_distance.js computed
      OUTSIDE the page, on the world soups, to 1e-4.
   4. The report is honest about the rest of it too: the overhang it names
      matches the scene's own boxes, and the corner-ray verdict it downgrades
      is the verdict the shipped fit would actually have given.
   5. Center lock's work survives. XZ is unchanged by the placement, to 1e-9,
      at every gap - the mode positions along the vertical only.
   6. What comes out is what is exported. The plate STL is split into shells
      and the distance between them measured off the FILE: the same number the
      status line reported.
   7. Nothing else moved. With the mode off, the Seat-gap suite's golden flush
      pose and status hold byte for byte on the ordinary pairing, and so does
      the -0.18 gap seat; Seat flush is unaffected even with the mode ON,
      because only Seat (support) routes through it.
   8. The probes are pure and the misuse paths are loud: an empty or
      out-of-range gap field refuses by name and places nothing, and a washer
      whose centre is not over the target says so rather than guessing. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { soupMinDistance, soupShells } = require('./nso_soup_distance');

const fx = f => path.join(ROOT, 'fixtures', f);
const lib = f => path.join(ROOT, 'library', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f4 = v => Number.isFinite(v) ? v.toFixed(4) : String(v);

/* ---- binary STL -> flat soup, stdlib only ---- */
function stlSoup(buf) {
  const n = buf.readUInt32LE(80);
  const out = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return out;
}

/* ---- in-page helpers ---- */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const worldSoup = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  return Array.from(meshToWorldSoup(p.mesh));
}, id);
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { x: p.x, z: p.z, liftY: p.liftY || 0,
           pos: p.mesh.position.toArray(), quat: p.mesh.quaternion.toArray(),
           min: bb.min.toArray(), max: bb.max.toArray(),
           undoDepth: state.undoStack.length };
}, id);

async function clickSeatSupport(page) {
  await clearStatus(page);
  await page.click('#btn-seat-support');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0,
    null, { timeout: 90000 });
  return statusOf(page);
}
async function clickSeatFlush(page) {
  await clearStatus(page);
  await page.click('#btn-seat-flush');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0,
    null, { timeout: 90000 });
  return statusOf(page);
}

/* the true minimum distance between the two pieces, computed outside the
   page - the quantity a status line cannot fake */
async function trueGap(page, idA, idB) {
  return soupMinDistance(await worldSoup(page, idA), await worldSoup(page, idB)).dist;
}

/* "Export plate STL" through the real button and the browser's own download */
async function exportPlateSTL(page, out, label) {
  await page.evaluate(() => {
    const e = document.getElementById('export-format');
    for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  return file;
}

/* Parse "true minimum X.XXXmm" and "overhang A.AAmm X / B.BBmm Z" out of the
   status line. Reading the numbers the user is shown, not an internal. */
function readReport(s) {
  const tm = /true minimum (-?\d+\.\d{3})mm/.exec(s);
  const oh = /overhang (\d+\.\d\d)mm X \/ (\d+\.\d\d)mm Z/.exec(s);
  const past = /\((-?\d+\.\d{3})mm past first contact\)/.exec(s);
  const rays = /(\d+) of (\d+) rays miss the target along the punch axis/.exec(s);
  return {
    trueMin: tm ? Number(tm[1]) : NaN,
    overhangX: oh ? Number(oh[1]) : NaN,
    overhangZ: oh ? Number(oh[2]) : NaN,
    past: past ? Number(past[1]) : null,
    raysMiss: rays ? Number(rays[1]) : null,
    raysTotal: rays ? Number(rays[2]) : null,
    reportedNotBlocked: / - reported, not blocked$/.test(s)
  };
}

const MISSED_RE = /^Seat failed - corner \d missed hull along punch axis$/;

/* The Seat-gap suite's golden flush pose, unchanged by this work. */
const GOLDEN_FLUSH = {
  position: [0, 10.309999237060548, 0],
  quaternion: [0, 0, 0, 1],
  liftY: 0.10999923706054915,
  status: 'Seated - proud 0.01mm, skin error 0.00mm - Subtract'
};
const GOLDEN_GAP_STATUS = 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)';

/* the Seat-gap suite's own staging, so the regression above compares like
   with like: hull at the drop baseline, bit centred 5 mm above it */
const stage = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.liftY = 0;
  pA.mesh.position.set(pA.x, pA.height / 2 + 0.3, pA.z);
  pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.liftY = 0; pB.x = pA.x; pB.z = pA.z;
  pB.mesh.quaternion.identity();
  pB.mesh.position.set(pA.x, bbA.max.y + 5 + pB.height / 2, pA.z);
  pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
};

async function openPanels(page) {
  await page.evaluate(async () => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    await new Promise(r => setTimeout(r, 0));
  });
}

/* A fresh plate carrying the oversized pair, joined and Center locked. */
async function oversizedPair(page) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  await openPanels(page);
  const idA = await loadSTL(page, lib('box_bit_12x8x8.stl'));
  const built = await page.evaluate(() => {
    const r = NSO_skinPatchAdd({ variant: 'sandwich', pattern: 'crosshatch', W: 30, D: 30 });
    return { ok: !!r.ok, id: r.modelId, extent: r.extent };
  });
  const idB = built.id;
  await page.click('#btn-join-start');
  await page.evaluate(([a, b]) => {
    state.joinArmed = 'a'; assignJoinClick(a);
    state.joinArmed = 'b'; assignJoinClick(b);
  }, [idA, idB]);
  await page.click('#btn-center-lock');
  return { idA, idB, built };
}

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-oversize-'));

  /* ================================================================
     0. the control exists and is off
     ================================================================ */
  console.log('\n=== 0. the mode is present, off, and reads a typed gap ===');
  await openPanels(page);
  const wired = await page.evaluate(() => {
    const f = document.getElementById('chk-oversize-washer');
    const g = document.getElementById('oversize-gap');
    return {
      flag: !!f, checked: f ? f.checked : null,
      gapType: g ? g.type : null, min: g ? g.min : null, max: g ? g.max : null,
      step: g ? g.step : null, value: g ? g.value : null,
      mod: typeof window.NSO_OversizeWasher,
      armed: window.NSO_OversizeWasher ? window.NSO_OversizeWasher.armed() : null
    };
  });
  check('the Oversized washer checkbox is on the Join card', wired.flag === true);
  check('it is CLEAR by default', wired.checked === false, String(wired.checked));
  check('the gap is a typed mm field, -5 .. +5 in 0.01 steps, default 0',
    wired.gapType === 'number' && wired.min === '-5' && wired.max === '5'
    && wired.step === '0.01' && wired.value === '0', JSON.stringify(wired));
  check('the module is loaded and reports itself unarmed',
    wired.mod === 'object' && wired.armed === false, wired.mod + '/' + wired.armed);

  /* ================================================================
     1. the block this mode exists for
     ================================================================ */
  console.log('\n=== 1. the block: the corner-ray fit refuses an overhanging washer ===');
  let { idA, idB, built } = await oversizedPair(page);
  check('the washer built and is 30 x 30', built.ok && near(built.extent[0], 30, 1e-6) && near(built.extent[1], 30, 1e-6),
    JSON.stringify(built.extent));
  const a0 = await pose(page, idA), b0 = await pose(page, idB);
  const ohX = Math.max(a0.min[0] - b0.min[0], b0.max[0] - a0.max[0]);
  const ohZ = Math.max(a0.min[2] - b0.min[2], b0.max[2] - a0.max[2]);
  check('the washer really does overhang its target: 9 mm X, 11 mm Z',
    near(ohX, 9, 1e-6) && near(ohZ, 11, 1e-6), f4(ohX) + ' / ' + f4(ohZ));
  check('Center lock put the washer centre on the target centre',
    near((b0.min[0] + b0.max[0]) / 2, (a0.min[0] + a0.max[0]) / 2, 1e-9)
    && near((b0.min[2] + b0.max[2]) / 2, (a0.min[2] + a0.max[2]) / 2, 1e-9));

  for (const g of ['-0.25', '-0.18', '0', '0.05']) {
    await page.evaluate(v => {
      const el = document.getElementById('seat-gap');
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, g);
    const before = await pose(page, idB);
    const st = await clickSeatSupport(page);
    const after = await pose(page, idB);
    check('slider ' + g + ': Seat (support) refuses with the corner-ray line', MISSED_RE.test(st), st);
    check('slider ' + g + ': and the washer did not move',
      after.pos.every((v, i) => near(v, before.pos[i], 0)) && near(after.liftY, before.liftY, 0));
  }

  /* ================================================================
     2. export was never the blocker
     ================================================================ */
  console.log('\n=== 2. export never blocked: the plate exports in hard contact ===');
  await page.evaluate(([a, b]) => {
    const pa = state.placed.find(p => p && p.sourceId === a);
    const pb = state.placed.find(p => p && p.sourceId === b);
    settlePlacedOnBed(pa); pa.mesh.updateMatrixWorld(true);
    const ba = new THREE.Box3().setFromObject(pa.mesh);
    pb.liftY = Math.max(0, ba.max.y - 0.2);          /* bottoms touching tops */
    settlePlacedOnBed(pb); pb.mesh.updateMatrixWorld(true);
  }, [idA, idB]);
  const contactGap = await trueGap(page, idA, idB);
  check('hand-placed at hard contact: true minimum distance is 0', near(contactGap, 0, 1e-9), f4(contactGap));
  const contactFile = await exportPlateSTL(page, tmp, 'contact');
  const contactShells = soupShells(stlSoup(fs.readFileSync(contactFile)));
  check('"Export plate STL" wrote the file anyway', fs.statSync(contactFile).size > 84, contactFile);
  check('and it carries both pieces', contactShells.length === 2, String(contactShells.length));
  if (contactShells.length === 2) {
    const d = soupMinDistance(contactShells[0], contactShells[1]).dist;
    check('the shells in the FILE are in contact too', near(d, 0, 1e-4), f4(d));
  }

  /* ================================================================
     3 + 4 + 5. armed: it places, and the report is the truth
     ================================================================ */
  console.log('\n=== 3. armed: the same click places, at gaps the slider cannot even ask for ===');
  ({ idA, idB } = await oversizedPair(page));
  await page.check('#chk-oversize-washer');
  check('the module now reports itself armed',
    (await page.evaluate(() => window.NSO_OversizeWasher.armed())) === true);

  const lockedX = (await pose(page, idB)).x, lockedZ = (await pose(page, idB)).z;
  const cases = [-1.5, -0.18, 0, 0.3];
  for (const g of cases) {
    await page.fill('#oversize-gap', String(g));
    const st = await clickSeatSupport(page);
    const rep = readReport(st);
    const real = await trueGap(page, idA, idB);
    const p = await pose(page, idB);

    check('gap ' + g + ': placed, and says so', /^Oversized washer placed - /.test(st), st);
    check('gap ' + g + ': the reported true minimum IS the true minimum (1e-4, measured outside the page)',
      near(rep.trueMin, real, 1e-4), 'said ' + f4(rep.trueMin) + ', measured ' + f4(real));
    if (g < 0) {
      check('gap ' + g + ': and it is the air gap that was asked for', near(real, Math.abs(g), 1e-4), f4(real));
    } else {
      check('gap ' + g + ': at or past contact, so the true minimum is 0', near(real, 0, 1e-6), f4(real));
      check('gap ' + g + ': and it reports how far past first contact it sits',
        near(rep.past, g, 1e-3), String(rep.past));
    }
    check('gap ' + g + ': the overhang it names matches the scene',
      near(rep.overhangX, 9, 5e-3) && near(rep.overhangZ, 11, 5e-3),
      rep.overhangX + ' / ' + rep.overhangZ);
    check('gap ' + g + ': the corner-ray verdict it downgrades is 4 of 4 rays missing',
      rep.raysMiss === 4 && rep.raysTotal === 4, rep.raysMiss + '/' + rep.raysTotal);
    check('gap ' + g + ': and it ends the way the cut readout ends', rep.reportedNotBlocked === true);
    check('gap ' + g + ': Center lock\'s XZ survived, to 1e-9',
      near(p.x, lockedX, 1e-9) && near(p.z, lockedZ, 1e-9), p.x + ' / ' + p.z);
    check('gap ' + g + ': the washer was not turned',
      p.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-9)), JSON.stringify(p.quat));
  }

  console.log('\n=== 4. the corner-ray verdict is the shipped fit\'s own, measured and pure ===');
  const probe = await page.evaluate(([a, b]) => {
    const pa = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pb = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const before = { pos: pb.mesh.position.toArray(), quat: pb.mesh.quaternion.toArray(), lift: pb.liftY };
    const v = window.NSO_OversizeWasher.cornerRayVerdict(pa.mesh, pb.mesh, 0);
    const o = window.NSO_OversizeWasher.overhangOf(pa.mesh, pb.mesh);
    const aim = window.NSO_OversizeWasher.aimPointUnderB(pa.mesh, pb.mesh);
    const after = { pos: pb.mesh.position.toArray(), quat: pb.mesh.quaternion.toArray(), lift: pb.liftY };
    return { v: v, o: o, aim: aim, moved: JSON.stringify(before) !== JSON.stringify(after) };
  }, [idA, idB]);
  check('the probe moves nothing', probe.moved === false);
  check('it reports 4 of 4 rays missing', probe.v && probe.v.miss === 4 && probe.v.rays === 4, JSON.stringify(probe.v));
  check('it measures the overhang as 9 / 11 and calls it an overhang',
    near(probe.o.x, 9, 1e-4) && near(probe.o.z, 11, 1e-4) && probe.o.any === true, JSON.stringify(probe.o));
  check('the aim point lands on the target\'s top face', probe.aim && near(probe.aim[1], 8.2, 1e-4), JSON.stringify(probe.aim));
  const warnText = await page.evaluate(v => window.NSO_OversizeWasher.cornerRayWarning(v),
    { miss: 0, rays: 4, straddle: null });
  check('and it is silent when the fit would have been happy, as cutWarning() is',
    warnText === '', JSON.stringify(warnText));

  /* ================================================================
     6. what is exported is what was reported
     ================================================================ */
  console.log('\n=== 5. the export carries the gap the status line reported ===');
  for (const g of [-0.18, 0]) {
    await page.fill('#oversize-gap', String(g));
    const st = await clickSeatSupport(page);
    const rep = readReport(st);
    const file = await exportPlateSTL(page, tmp, 'armed' + g);
    const shells = soupShells(stlSoup(fs.readFileSync(file)));
    check('gap ' + g + ': the plate exported, two shells', shells.length === 2, String(shells.length));
    if (shells.length === 2) {
      const d = soupMinDistance(shells[0], shells[1]).dist;
      check('gap ' + g + ': the distance measured off the FILE is the one reported',
        near(d, rep.trueMin, 2e-3), 'file ' + f4(d) + ', reported ' + f4(rep.trueMin));
    }
  }

  /* ================================================================
     7. misuse, and a washer that is not over its target
     ================================================================ */
  console.log('\n=== 6. misuse is loud, and nothing is guessed ===');
  for (const bad of ['', '9']) {
    await page.fill('#oversize-gap', bad);
    const before = await pose(page, idB);
    const st = await clickSeatSupport(page);
    const after = await pose(page, idB);
    check('gap "' + bad + '": refused by name',
      st === 'Oversized washer gap is empty or out of range - nothing placed', st);
    check('gap "' + bad + '": and nothing moved',
      after.pos.every((v, i) => near(v, before.pos[i], 0)) && near(after.liftY, before.liftY, 0));
  }
  await page.fill('#oversize-gap', '-0.18');
  await page.evaluate(b => {
    const i = state.placed.findIndex(p => p && p.sourceId === b);
    selectPlaced(i);
    nudgeSelected(120 - state.placed[i].x, 0);       /* the washer off the target entirely */
  }, idB);
  {
    const before = await pose(page, idB);
    const st = await clickSeatSupport(page);
    const after = await pose(page, idB);
    check('a washer whose centre is not over the target says so rather than guessing',
      /^Oversized washer mode: nothing of the target lies under the washer's centre/.test(st), st);
    check('...and it moves nothing',
      after.pos.every((v, i) => near(v, before.pos[i], 0)) && near(after.liftY, before.liftY, 0));
  }

  /* ================================================================
     8. every other path is untouched
     ================================================================ */
  console.log('\n=== 7. the ordinary seat, with the mode OFF: byte for byte ===');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  await openPanels(page);
  const gidA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const gidB = await loadSTL(page, fx('box-20mm.stl'));
  const gids = [gidA, gidB];
  check('the mode is off again on a fresh page',
    (await page.evaluate(() => document.getElementById('chk-oversize-washer').checked)) === false);

  await page.evaluate(stage, gids);
  const flushSt = await clickSeatFlush(page);
  const fb = await pose(page, gidB);
  check('Seat flush status is the golden one', flushSt === GOLDEN_FLUSH.status, flushSt);
  check('Seat flush pose is the golden one (1e-9)',
    fb.pos.every((v, i) => near(v, GOLDEN_FLUSH.position[i], 1e-9))
    && fb.quat.every((v, i) => near(v, GOLDEN_FLUSH.quaternion[i], 1e-12))
    && near(fb.liftY, GOLDEN_FLUSH.liftY, 1e-9),
    JSON.stringify([fb.pos, fb.liftY]));

  await page.evaluate(stage, gids);
  await page.evaluate(() => {
    const el = document.getElementById('seat-gap');
    el.value = '-0.18'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const gapSt = await clickSeatSupport(page);
  check('Seat (support) at -0.18 is the golden gap seat', gapSt === GOLDEN_GAP_STATUS, gapSt);
  const gd = await trueGap(page, gidA, gidB);
  check('...and the true minimum really is 0.18', near(gd, 0.18, 1e-4), f4(gd));

  console.log('\n=== 8. with the mode ON, only Seat (support) routes through it ===');
  await page.check('#chk-oversize-washer');
  await page.evaluate(stage, gids);
  const flushSt2 = await clickSeatFlush(page);
  const fb2 = await pose(page, gidB);
  check('Seat flush is the golden flush seat even with the mode armed',
    flushSt2 === GOLDEN_FLUSH.status
    && fb2.pos.every((v, i) => near(v, GOLDEN_FLUSH.position[i], 1e-9))
    && near(fb2.liftY, GOLDEN_FLUSH.liftY, 1e-9), flushSt2);
  await page.uncheck('#chk-oversize-washer');
  await page.evaluate(stage, gids);
  const gapSt2 = await clickSeatSupport(page);
  check('unarmed again, the gap seat is the golden one once more', gapSt2 === GOLDEN_GAP_STATUS, gapSt2);

  const bad = logs.filter(l => /pageerror|\[error\]/i.test(l));
  check('no page errors', bad.length === 0, bad.slice(0, 3).join(' | '));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });

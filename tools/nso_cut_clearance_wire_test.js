/* nso_cut_clearance_wire_test.js - NSO_Thickness.cutClearance wired to the
   live cut path, as a WARNING and not a refusal.
     node tools/nso_cut_clearance_wire_test.js        exit 0 = every claim holds

   Everything here drives the REAL app through tools/nso_app_harness.js - the
   live app-join.js, the live app-carve.js, the real Chromium load order from
   index.html, the real manifold kernel from vendor/. Nothing is asserted from
   reading the source, and the status lines are read off the real #status
   element after the real button handler has run.

   WHAT IS BEING PINNED
   --------------------
   1. The known case warns. fixtures/box_open.stl (60 x 40 x 25, 2 mm walls)
      with the 12x8x8 bit parked at the top +X/+Z corner is the case
      docs/LOCAL-CARVE.md 3c measured and docs/WALL-THICKNESS.md named as the
      one its utility wanted: 48.000 mm^3 removed, a 2 mm wall severed, and the
      result still gating clean. The cut path now SAYS so.

   2. The punch axis is not a finding. That same bite severs x as well as z,
      and severing x is what a through hole IS - the bit has to come from
      somewhere. Only z is reported. A check that failed on x would fire on
      every through hole in the app.

   3. An ordinary safe cut says nothing. A pocket in a solid block leaves
      millimetres of wall, so the status line reads exactly as it did before
      this wiring existed. A warning that fires on everything is not a warning.

   4. NOTHING about the cut changes. The probe is a readout bolted alongside
      the boolean: same ok, same volume removed, same triangle count, same
      open-edge and non-manifold counts, and a byte-identical result soup,
      whether the probe runs or not. Proved by an A/B on the same pose with
      NSO_Thickness taken away, which is the only difference between the two
      runs.

   5. The warning is VISIBLE and non-blocking. Driven through the real
      Subtract handler: the status line carries it, still reports 'Subtract ok'
      ahead of it, and is NOT styled as an error - because the cut was kept.  */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ---- page helpers: the same ones tools/nso_carve_audit.js parks with, so
        case 1 below is literally the audit's pose, not a lookalike ---- */
const worldBox = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, id);

const park = (page, id, cx, cz, bottom) => page.evaluate(([id, cx, cz, bottom]) => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.liftY = 0; applyMeshRotation(p); p.mesh.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(p.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  p.x += cx - c.x; p.z += cz - c.z;
  p.liftY = bottom - 0.2;
  applyMeshRotation(p); p.mesh.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, [id, cx, cz, bottom]);

/* One cut through the shared core, with the probe on or taken away. `probe:
   false` removes window.NSO_Thickness for the duration, which is the ONLY
   difference between the two runs - so anything that differs between them is
   the probe's doing and nothing else.

   The digest is order-sensitive and coordinate-sensitive over the whole result
   soup: two runs agreeing on it agree on the geometry triangle for triangle. */
const cut = (page, idA, idB, probe) => page.evaluate(async ([idA, idB, probe]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA && p.mesh);
  const pb = state.placed.find(p => p && p.sourceId === idB && p.mesh);
  pa.mesh.updateMatrixWorld(true); pb.mesh.updateMatrixWorld(true);
  const aWorld = meshToWorldSoup(pa.mesh), bWorld = meshToWorldSoup(pb.mesh);
  if (!pa.mesh.geometry.boundingBox) pa.mesh.geometry.computeBoundingBox();
  const hc = pa.mesh.geometry.boundingBox.getCenter(new THREE.Vector3())
               .applyMatrix4(pa.mesh.matrixWorld);
  const frame = NSO_plugFrame(pb.mesh, hc, aWorld);

  const saved = window.NSO_Thickness;
  if (!probe) window.NSO_Thickness = undefined;
  let r;
  try { r = await subtractSoupBFromA(aWorld, bWorld, { plugFrame: frame, minWall: 1.0 }); }
  finally { window.NSO_Thickness = saved; }

  let removed = null, digest = null, tris = null;
  const wasm = await NSO_CSG.load();
  const mA = NSO_CSG.soupToManifold(wasm, aWorld);
  if (r && r.ok && r.soup) {
    const mR = NSO_CSG.soupToManifold(wasm, r.soup);
    removed = mA.volume() - mR.volume();
    mR.delete();
    tris = r.soup.length / 9;
    /* FNV-1a over the exact float bytes of the result soup */
    const bytes = new Uint8Array(Float32Array.from(r.soup).buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    digest = h.toString(16);
  }
  mA.delete();

  const c = r && r.clearance;
  return {
    ok: !!(r && r.ok), reason: r && r.reason, removed, tris, digest,
    openBefore: r && r.openBefore, openAfter: r && r.openAfter,
    nmBefore: r && r.nmBefore, nmAfter: r && r.nmAfter,
    punch: frame.punch.toArray(),
    hasReport: !!c,
    clearance: c ? {
      pass: c.pass, through: c.through, severed: c.severed,
      severed_fatal: c.severed_fatal, thin: c.thin, breached: c.breached,
      min_mm: c.min_mm, grazed: c.grazed, samples: c.samples,
      reason: c.reason, cut_lo: c.cut_lo, cut_hi: c.cut_hi
    } : null,
    warning: c ? NSO_Thickness.cutWarning(c) : ''
  };
}, [idA, idB, probe]);

/* Re-run the probe over the SAME measured box at a denser sweep, to tell a
   real finding from a sampling accident. */
const resweep = (page, idA, lo, hi, through, samples) => page.evaluate(([idA, lo, hi, through, samples]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA && p.mesh);
  pa.mesh.updateMatrixWorld(true);
  const rep = NSO_Thickness.cutClearance(meshToWorldSoup(pa.mesh), lo, hi, { through, samples });
  return { pass: rep.pass, severed_fatal: rep.severed_fatal, thin: rep.thin, reason: rep.reason };
}, [idA, lo, hi, through, samples]);

/* Local-Carve's own driver: the UI path and this path run the same carveAt. */
const setControls = (page, o) => page.evaluate(o => window.nsoCarveSetControls(o), o);
const carveAt = (page, id, pt) => page.evaluate(([id, pt]) => window.nsoCarveAtPoint(id, pt), [id, pt]);

/* The real Subtract button handler, then the real status element. */
const uiSubtract = (page, idA, idB) => page.evaluate(async ([idA, idB]) => {
  state.editId = idA;
  state.joinPartnerId = idB;
  state.joinSession = true;
  await subtractBFromA();
  const el = document.getElementById('status');
  return { text: el ? el.textContent : null, cls: el ? el.className : null };
}, [idA, idB]);

(async () => {
  await withApp(async (page, logs) => {
    const BIT = path.join(ROOT, 'library', 'box_bit_12x8x8.stl');
    const OPEN = path.join(ROOT, 'fixtures', 'box_open.stl');
    const CUBE = path.join(ROOT, 'fixtures', 'box-20mm.stl');

    /* ================================================================
       1-2. THE KNOWN CASE: box_open.stl, the audit's corner bite
       ================================================================ */
    console.log('\n--- 1. the box_open.stl corner bite now warns ---');
    const hOpen = await loadSTL(page, OPEN);
    const bOpen = await loadSTL(page, BIT);
    const HO = await worldBox(page, hOpen);
    const parked = await park(page, bOpen, HO.max[0], HO.max[2], HO.max[1] - 3);
    check('the audit pose: bit across the hull top +X/+Z corner',
      near(parked.max[0] - HO.max[0], 6, 1e-6) && near(parked.max[2] - HO.max[2], 4, 1e-6),
      'bit stands ' + (parked.max[0] - HO.max[0]).toFixed(2) + ' mm past +X, ' +
      (parked.max[2] - HO.max[2]).toFixed(2) + ' mm past +Z');

    const sev = await cut(page, hOpen, bOpen, true);
    check('the cut still SUCCEEDS - this is a warning, not a refusal', sev.ok === true,
      sev.ok ? 'ok' : sev.reason);
    check('and still removes the documented 48.000 mm3', near(sev.removed, 48, 1e-3),
      sev.removed === null ? 'n/a' : sev.removed.toFixed(3) + ' mm^3');
    check('a clearance report reached the caller', sev.hasReport === true);
    check('it does NOT pass - the corner bite is a finding',
      sev.clearance && sev.clearance.pass === false);
    check('the finding is a SEVERED wall across z',
      !!(sev.clearance && sev.clearance.severed_fatal.length === 1 &&
         sev.clearance.severed_fatal[0] === 'z'),
      sev.clearance ? 'severed_fatal [' + sev.clearance.severed_fatal.join(',') + ']' : 'no report');
    check('a warning string is produced for the status line',
      typeof sev.warning === 'string' && sev.warning.length > 0);
    check('  ...and it names the severance in words a user can act on',
      /^WALL SEVERED: /.test(sev.warning) && /across z/.test(sev.warning), sev.warning);
    check('  ...and it says plainly that the cut was kept',
      /reported, not blocked$/.test(sev.warning));
    check('  ...and it quotes the nozzle floor it judged against',
      /floor 0\.42 mm at a 0\.4 mm nozzle/.test(sev.warning));

    console.log('\n--- 2. the punch axis is reported, not failed ---');
    check('the bit punches along -X', near(sev.punch[0], -1, 1e-9));
    check('cutClearance was told x is the through axis',
      sev.clearance && sev.clearance.through === 'x', sev.clearance && sev.clearance.through);
    check('x IS severed by this cut...',
      !!(sev.clearance && sev.clearance.severed.indexOf('x') >= 0),
      sev.clearance ? 'severed [' + sev.clearance.severed.join(',') + ']' : 'no report');
    check('  ...and is deliberately NOT a finding - that is what a through hole is',
      !!(sev.clearance && sev.clearance.severed_fatal.indexOf('x') < 0));
    check('so the warning names z alone, not x',
      /across z/.test(sev.warning) && !/across x/.test(sev.warning), sev.warning);

    const dense = await resweep(page, hOpen, sev.clearance.cut_lo, sev.clearance.cut_hi, 'x', 11);
    check('an 11x11 sweep reaches the same verdict - not a sampling accident',
      dense.pass === false && dense.severed_fatal.length === 1 && dense.severed_fatal[0] === 'z',
      dense.reason);

    /* ================================================================
       4. THE PROBE CHANGES NOTHING
       ================================================================ */
    console.log('\n--- 4. the probe is a readout: identical cut with it taken away ---');
    const noProbe = await cut(page, hOpen, bOpen, false);
    check('with NSO_Thickness removed no report is produced', noProbe.hasReport === false);
    check('  ...and the warning is empty, so the status line is untouched',
      noProbe.warning === '');
    check('same success', noProbe.ok === sev.ok, String(noProbe.ok));
    check('same volume removed', near(noProbe.removed, sev.removed, 0),
      noProbe.removed + ' vs ' + sev.removed);
    check('same triangle count', noProbe.tris === sev.tris,
      noProbe.tris + ' vs ' + sev.tris);
    check('same open-edge counts', noProbe.openBefore === sev.openBefore &&
      noProbe.openAfter === sev.openAfter,
      sev.openBefore + '→' + sev.openAfter);
    check('same non-manifold counts', noProbe.nmBefore === sev.nmBefore &&
      noProbe.nmAfter === sev.nmAfter, sev.nmBefore + '→' + sev.nmAfter);
    check('BYTE-IDENTICAL result soup - the geometry is the same mesh',
      noProbe.digest !== null && noProbe.digest === sev.digest,
      noProbe.digest + ' vs ' + sev.digest);

    /* ================================================================
       5. THE WARNING IS VISIBLE, AND THE CUT IS KEPT
       ================================================================ */
    console.log('\n--- 5. the real Subtract handler puts it on the status line ---');
    const ui = await uiSubtract(page, hOpen, bOpen);
    check('the status line reports the cut succeeded', /^Subtract ok/.test(ui.text || ''),
      ui.text);
    check('  ...and carries the severance warning after it',
      /WALL SEVERED/.test(ui.text || '') && /reported, not blocked/.test(ui.text || ''));
    check('  ...and keeps the pre-existing readout ahead of it',
      /open edges .*non-manifold /.test(ui.text || ''));
    check('  ...and is NOT styled as an error, because the cut was kept',
      /success/.test(ui.cls || '') && !/error/.test(ui.cls || ''), ui.cls);
    check('the bit was consumed, as a successful Subtract always does',
      await page.evaluate(id => !state.models.some(m => m.id === id), bOpen));

    /* ================================================================
       3. AN ORDINARY SAFE CUT SAYS NOTHING
       ================================================================ */
    console.log('\n--- 3. an ordinary safe cut produces no warning at all ---');
    const hCube = await loadSTL(page, CUBE);
    const bCube = await loadSTL(page, BIT);
    const HC = await worldBox(page, hCube);
    await park(page, bCube, (HC.min[0] + HC.max[0]) / 2, (HC.min[2] + HC.max[2]) / 2, HC.max[1] - 3);

    const safe = await cut(page, hCube, bCube, true);
    check('the pocket cut succeeds', safe.ok === true, safe.ok ? 'ok' : safe.reason);
    check('a report WAS produced - the probe ran, it simply found nothing',
      safe.hasReport === true);
    check('it passes', safe.clearance && safe.clearance.pass === true);
    check('nothing severed, nothing thin',
      !!(safe.clearance && safe.clearance.severed_fatal.length === 0 &&
         safe.clearance.thin.length === 0));
    check('it leaves millimetres of wall standing',
      !!(safe.clearance && safe.clearance.min_mm >= 1),
      safe.clearance ? safe.clearance.min_mm.toFixed(3) + ' mm' : 'no report');
    check('THE WARNING IS EMPTY', safe.warning === '', JSON.stringify(safe.warning));

    const uiSafe = await uiSubtract(page, hCube, bCube);
    check('the real status line reads exactly as it did before this wiring',
      /^Subtract ok - open edges \d+→\d+, non-manifold \d+→\d+$/.test(uiSafe.text || ''),
      uiSafe.text);
    check('  ...with no WALL clause anywhere on it', !/WALL/.test(uiSafe.text || ''));
    check('  ...and still styled a success', /success/.test(uiSafe.cls || ''), uiSafe.cls);

    /* a breach alone is never a finding: BOTH cuts above breached, and only
       the severing one warned */
    console.log('\n--- 6. a breach on its own is not a finding ---');
    check('the safe cut breached (every cut does - the bit comes from somewhere)',
      !!(safe.clearance && safe.clearance.breached.length > 0),
      safe.clearance ? 'open to air on ' + safe.clearance.breached.join(', ') : 'no report');
    check('  ...and warned about nothing, so breaches cannot spam the status line',
      safe.warning === '');
    check('the severing cut breached too, and its breaches ride the warning as context',
      !!(sev.clearance && sev.clearance.breached.length > 0) && /open to air on /.test(sev.warning));

    /* ================================================================
       7. LOCAL-CARVE: the use case a refusal would have broken
       ================================================================ */
    console.log('\n--- 7. Local-Carve gets the same warning from the same core ---');
    await page.evaluate(() => { const d = document.querySelector('.vp-finish-menu'); if (d) d.open = true; });

    /* a small gouge that leaves the 2 mm wall standing: no warning */
    const hCarveOk = await loadSTL(page, OPEN);
    const AO = await worldBox(page, hCarveOk);
    await setControls(page, { blade: 'ball', a: 2, depth: 1.5, roll: 0 });
    const gouge = await carveAt(page, hCarveOk, [AO.max[0], AO.max[1], AO.max[2]]);
    check('a shallow corner gouge lands', gouge.ok === true, gouge.ok ? gouge.removed.toFixed(3) + ' mm^3' : gouge.reason);
    check('  ...and says nothing about walls - it left them standing',
      !/WALL/.test(gouge.status || ''), gouge.status);

    /* A 4x4 flat shave at the same corner of a PRISTINE hollow box takes both
       2 mm walls out. This is THE case the whole thread exists for, and the
       case a hard refusal would have made impossible to perform. Measured on a
       freshly loaded piece: an earlier gouge on the same corner changes the
       answer, so each carve here gets its own fixture. */
    const hCarveSev = await loadSTL(page, OPEN);
    const AS = await worldBox(page, hCarveSev);
    await setControls(page, { blade: 'flat', a: 4, b: 4, depth: 4, roll: 0 });
    const deep = await carveAt(page, hCarveSev, [AS.max[0], AS.max[1], AS.max[2]]);
    check('a corner shave that severs the 2 mm walls STILL CARVES',
      deep.ok === true && near(deep.removed, 32.552, 1e-3),
      deep.ok ? deep.removed.toFixed(3) + ' mm^3 removed' : deep.reason);
    check('  ...this is the case a hard refusal would have broken - it is not refused',
      deep.ok === true && !/refus/i.test(deep.reason || ''));
    check('  ...and the carve status line carries the warning',
      /WALL SEVERED/.test(deep.status || '') && /reported, not blocked/.test(deep.status || ''),
      deep.status);
    check('  ...naming both walls it took, not just one',
      /severs the piece across x and z/.test(deep.status || ''));
    check('  ...and no through axis is claimed - a corner punch has no single axis',
      !/punch axis is/.test(deep.status || ''));
    check('  ...after the carve\'s own report, not instead of it',
      /^Carved corner - flat shave/.test(deep.status || '') &&
      (deep.status || '').indexOf('WALL SEVERED') > (deep.status || '').indexOf('mm³ removed'));
    check('  ...and the piece really did change - the cut was committed, not reverted',
      await page.evaluate(id => {
        const m = state.models.find(x => x.id === id);
        return !!(m && m.rawTris && m.rawTris.length > 0);
      }, hCarveSev));

    /* A face carve punches along one axis, and that axis MUST still be named:
       if it were not, every deep face carve would read as severing its own
       punch axis and warn - the exact false alarm the through-axis exemption
       exists to prevent. Pinned because it is the failure mode a future change
       to the punch->axis mapping would introduce silently. */
    const hFace = await loadSTL(page, CUBE);
    const AF = await worldBox(page, hFace);
    await setControls(page, { blade: 'flat', a: 4, b: 4, depth: 19.5, roll: 0 });
    const face = await carveAt(page, hFace, [(AF.min[0] + AF.max[0]) / 2, AF.max[1], (AF.min[2] + AF.max[2]) / 2]);
    check('a deep FACE carve still names its punch axis', face.ok === true &&
      face.clearance && face.clearance.through === 'y',
      face.clearance ? 'through ' + face.clearance.through : 'no report');
    check('  ...so it warns about nothing, though it cut 19.5 mm into the piece',
      !/WALL/.test(face.status || ''), face.status);

    const errs = logs.filter(l => /pageerror/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | ') || 'none');
  });

  console.log('\n' + (fails ? fails + ' FAILED' : 'cutClearance is wired to the cut path, as a warning'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* Drive check: the defect overlay through the REAL app, end to end.
 *
 *   node tools/nso_defect_overlay_drive_check.js
 *   APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_defect_overlay_drive_check.js
 *
 * tools/nso_defect_overlay_test.js already pins that nso-defects.js finds the
 * right defects at the right RAW coordinates. This one pins the other half,
 * the half that only exists in a browser:
 *
 *   - the shipped button runs it. Every step here is a click on the real UI -
 *     the Finish menu opened by its summary, then #btn-check-defects - not a
 *     call into the module.
 *   - the marks come out ON the piece. Each mark vertex is taken from the
 *     three.js scene in WORLD space and held against the piece's own displayed
 *     triangles, also in world space: a mark that is off by the centring
 *     translation, or by the sign of the -90 degree X rotation, lands
 *     millimetres away from any surface and fails here even though it renders
 *     perfectly well.
 *   - it is on the known defect. The same region assertions as the unit test,
 *     but mapped back out of the viewport, so the whole chain - soup, check,
 *     raw -> display, parenting, pose - is proven and not just its first link.
 *   - it is a toggle, and a snapshot. Pressing again clears it; a bake that
 *     swaps the mesh clears it; moving the piece does NOT, and the marks move
 *     with it.
 *   - it never eats a click. The marks are raycast-stubbed, so a pick lands on
 *     the piece under them exactly as it does with no overlay.
 */
'use strict';
const path = require('path');
const { withApp, loadSTL, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Load a fixture, select it, press the button, and read back everything the
   assertions need - all in world space, straight off the scene graph. */
async function checkPiece(page, file, opts) {
  const id = await loadSTL(page, file);
  await selectModel(page, id);
  // Selecting the model is not selecting the PLACED piece; the overlay runs on
  // the active model, but the button's enabled state follows the selection the
  // rest of the toolbar uses, so drive both the way a click does.
  await page.evaluate(i => {
    const idx = state.placed.findIndex(p => p && p.sourceId === i);
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
  }, id);
  await openFinishMenu(page);
  if (opts && opts.nonSolid) {
    await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      window.nsoNonSolidSet(m, true);
    }, id);
  }
  await page.click('#btn-check-defects');
  await waitForCheckOn(page, id);
  return id;
}

/* Wait for THIS piece's check to be the one on screen.
   `nsoDefectsReport()` is not per piece - it is whatever check is currently
   drawn, and the overlay deliberately survives a selection change (app-defects.js:
   another piece's check stays up and running this one replaces it). So after the
   second press onwards it is already non-null, holding the PREVIOUS piece's
   report, and "wait until it is non-null" is satisfied before this press has
   computed anything: the button defers the battery by a task so the "Checking..."
   line paints first. On a fast box the read that follows wins that race and sees
   the last piece's numbers with no marks on this one - which is exactly the
   "0 piercing, 96 open" (the cup's report) and "0 triangles" this check reported
   in CI while the piece under test was the clip.
   `nsoDefectsShownFor()` is the accessor that answers WHOSE check is up, so that
   is what the wait is on. It turns over only inside nsoDefectsShow, after the
   report is stored and the marks are parented, so once it reads this id every
   part of what the assertions read is in place. */
async function waitForCheckOn(page, id) {
  await page.waitForFunction(i => window.nsoDefectsShownFor() === i, id, { timeout: 60000 });
}

/* Every mark vertex, in world space, by layer; plus the piece's own displayed
   triangles in world space, so "is this mark on the surface" can be answered
   here rather than assumed. */
async function readScene(page, id) {
  return page.evaluate(i => {
    /* Never read one piece's marks against another piece's report. checkPiece
       waits for exactly this, so a mismatch here is not a defect count to
       argue with - it means the read got ahead of the check and every number
       below belongs to the previous piece. Loud, not silently wrong. */
    if (window.nsoDefectsShownFor() !== i) {
      throw new Error('the check on screen is for model ' + window.nsoDefectsShownFor() +
                      ', not ' + i + ' - the report and the marks would not be the same piece\'s');
    }
    const p = state.placed.find(q => q && q.sourceId === i);
    const grp = p.mesh.children.find(c => c.name === 'nso-defect-marks');
    p.mesh.updateMatrixWorld(true);
    const layers = {};
    if (grp) {
      for (const child of grp.children) {
        const pos = child.geometry.attributes.position;
        const v = new THREE.Vector3();
        const out = [];
        for (let k = 0; k < pos.count; k++) {
          v.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(child.matrixWorld);
          out.push(v.x, v.y, v.z);
        }
        layers[child.name] = out;
      }
    }
    const geo = p.mesh.geometry;
    const gp = geo.attributes.position;
    const v2 = new THREE.Vector3();
    const surf = [];
    for (let k = 0; k < gp.count; k++) {
      v2.set(gp.getX(k), gp.getY(k), gp.getZ(k)).applyMatrix4(p.mesh.matrixWorld);
      surf.push(v2.x, v2.y, v2.z);
    }
    const report = window.nsoDefectsReport();
    return {
      layers: layers,
      surface: surf,
      hasGroup: !!grp,
      report: {
        verdict: report.verdict, openEdges: report.openEdges,
        nonManifoldEdges: report.nonManifoldEdges, pierce: report.pierce,
        thinFaces: report.wall.thinFaces, minWallMm: report.wall.minWallMm
      },
      // the piece's own pose, so raw coordinates can be recovered below
      meshPos: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z]
    };
  }, id);
}

function tris(flat) {
  const out = [];
  for (let i = 0; i + 8 < flat.length; i += 9) {
    out.push([[flat[i], flat[i + 1], flat[i + 2]],
              [flat[i + 3], flat[i + 4], flat[i + 5]],
              [flat[i + 6], flat[i + 7], flat[i + 8]]]);
  }
  return out;
}
function pts(flat) {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}
/* Distance from a point to the nearest vertex of the displayed mesh. Vertex
   distance rather than point-in-triangle is deliberate and is enough here:
   every mark this overlay draws is built from welded MESH VERTICES (an edge's
   two endpoints, a triangle's three corners), so a correctly placed mark is
   ON a vertex to within the weld radius, and a mark placed by a wrong
   transform is not. */
function maxVertexGap(markFlat, surfFlat) {
  const S = pts(surfFlat);
  // a coarse grid so this stays linear on a 30k-vertex piece
  const cell = 0.5, grid = new Map();
  const kk = p => Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell) + ',' + Math.floor(p[2] / cell);
  for (const s of S) {
    const k = kk(s);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  let worst = 0;
  for (const m of pts(markFlat)) {
    let best = Infinity;
    const bx = Math.floor(m[0] / cell), by = Math.floor(m[1] / cell), bz = Math.floor(m[2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = grid.get((bx + dx) + ',' + (by + dy) + ',' + (bz + dz));
      if (!b) continue;
      for (const s of b) {
        const d = Math.hypot(m[0] - s[0], m[1] - s[1], m[2] - s[2]);
        if (d < best) best = d;
      }
    }
    if (best > worst) worst = best;
  }
  return worst;
}
/* World -> the fixture's own Z-up coordinates, up to a translation: the
   display mesh is the raw soup turned by rotateX(-90 deg), so raw = (x, -z, y)
   of the display point. Translation is removed by measuring everything
   relative to the piece's own bounding box, which is what the region
   assertions below use. */
function toRawRel(flat, origin) {
  const out = [];
  for (const p of pts(flat)) out.push([p[0] - origin[0], -(p[2] - origin[2]), p[1] - origin[1]]);
  return out;
}
function bboxOf(flat) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts(flat)) for (let k = 0; k < 3; k++) {
    if (p[k] < lo[k]) lo[k] = p[k];
    if (p[k] > hi[k]) hi[k] = p[k];
  }
  return { lo, hi, mid: lo.map((v, k) => (v + hi[k]) / 2) };
}

withApp(async (page, logs) => {
  console.log('defect overlay drive check\n');

  /* ---------------------------------------------------------------- *
   * 1. the cup with one patch dented to 0.25 mm
   * ---------------------------------------------------------------- */
  console.log('1. thin_shell_cup_thin - the violet is on the dent, through the real button');
  {
    const id = await checkPiece(page, fx('open/thin_shell_cup_thin.stl'));
    const s = await readScene(page, id);
    check('the button drew a mark group on the piece', s.hasGroup);
    check('the report is the canonical one', s.report.thinFaces === 96 && s.report.openEdges === 96,
          s.report.thinFaces + ' thin, ' + s.report.openEdges + ' open');
    check('thinnest wall 0.2495 mm', Math.abs(s.report.minWallMm - 0.2494645) < 1e-5, s.report.minWallMm);

    const thin = s.layers['nso-defect-thin'] || [];
    const open = s.layers['nso-defect-open'] || [];
    check('violet layer present', thin.length > 0, (thin.length / 9) + ' triangles');
    check('red layer present', open.length > 0, (open.length / 6) + ' segments');
    check('no orange layer (the cup has no non-manifold edge)', !s.layers['nso-defect-nonmanifold']);
    check('no red patch layer (the cup has no piercing pair)', !s.layers['nso-defect-pierce']);

    /* ON the mesh, not near it. This is the assertion a wrong transform
       fails: the cup is 30 mm across, so an error of even one bounding-box
       centre shows up as millimetres here. */
    const gapT = maxVertexGap(thin, s.surface);
    const gapO = maxVertexGap(open, s.surface);
    check('every violet vertex is on a vertex of the displayed mesh', gapT < 1e-3, 'worst gap ' + gapT.toFixed(6) + ' mm');
    check('every red vertex is on a vertex of the displayed mesh', gapO < 1e-3, 'worst gap ' + gapO.toFixed(6) + ' mm');

    /* And on the RIGHT part of it. The generator dents the band 90..150
       degrees; the cup is a full circle, so painting the whole inner wall
       would also "render something" and is what this rules out. */
    const bb = bboxOf(s.surface);
    const R = toRawRel(thin, bb.mid);
    let lo = 999, hi = -999;
    for (const p of R) {
      let deg = Math.atan2(p[1], p[0]) * 180 / Math.PI;
      if (deg < 0) deg += 360;
      if (deg < lo) lo = deg;
      if (deg > hi) hi = deg;
    }
    check('violet spans the dented band 90 to 150 degrees and no more',
          lo > 89.9 && hi < 150.1, 'spans ' + lo.toFixed(1) + ' to ' + hi.toFixed(1) + ' degrees');
    const arc = (hi - lo) / 360;
    check('violet covers about a sixth of the cup, not the cup',
          arc > 0.12 && arc < 0.20, (arc * 100).toFixed(1) + '% of the circumference');

    /* The rims are the two open loops, at the top and nowhere else. */
    const rimZ = toRawRel(open, bb.mid).map(p => p[2]);
    const spread = Math.max.apply(null, rimZ) - Math.min.apply(null, rimZ);
    check('every red segment is on one plane - the open top rim', spread < 1e-3, 'z spread ' + spread.toFixed(6) + ' mm');
    check('the rim is the TOP of the cup, not the closed bottom',
          Math.min.apply(null, rimZ) > 0, 'rim at z(rel) ' + Math.min.apply(null, rimZ).toFixed(3));
  }

  /* ---------------------------------------------------------------- *
   * 2. the clip with a fin through its floor
   * ---------------------------------------------------------------- */
  console.log('\n2. open_clip_selfint - the red patch is on the fin');
  {
    const id = await checkPiece(page, fx('open/open_clip_selfint.stl'));
    const s = await readScene(page, id);
    check('the report is the canonical one', s.report.pierce === 4 && s.report.openEdges === 54,
          s.report.pierce + ' piercing, ' + s.report.openEdges + ' open');
    const pierce = s.layers['nso-defect-pierce'] || [];
    check('red patch layer present', pierce.length > 0, (pierce.length / 9) + ' triangles');
    const gap = maxVertexGap(pierce, s.surface);
    check('every red patch vertex is on a vertex of the displayed mesh', gap < 1e-3, 'worst gap ' + gap.toFixed(6) + ' mm');

    /* The clip is 16 x 20 mm of sheet and the fin is a 2 mm stub at x 1.3..3.3,
       y 0.7. Everything red must be in that corner of it. The fixture is
       centred on the plate, so the assertion is relative to the piece's own
       bounding-box centre, which for this clip is (0, 0, 3) in raw terms. */
    const bb = bboxOf(s.surface);
    const R = toRawRel(pierce, bb.mid);
    let bad = 0;
    for (const p of R) {
      // raw x -1..5, y -3..3 about the clip's centre; z is measured from the
      // bbox middle so the floor sits at -(12/2 - 0) = -3 and the fin spans it
      if (p[0] < -1.1 || p[0] > 5.1 || p[1] < -3.1 || p[1] > 3.1) bad++;
    }
    check('every red patch is at the fin, not elsewhere on the clip', bad === 0,
          bad + ' of ' + R.length + ' vertices outside the fin\'s corner');
    const px = bboxOf(pierce);
    const frac = (px.hi[0] - px.lo[0]) / (bb.hi[0] - bb.lo[0]);
    check('the red covers a fraction of the clip, not the clip',
          frac < 0.45, (frac * 100).toFixed(1) + '% of the width');
  }

  /* ---------------------------------------------------------------- *
   * 3. a clean piece paints nothing, and says so
   * ---------------------------------------------------------------- */
  console.log('\n3. box-20mm - a clean piece gets no paint');
  {
    const id = await checkPiece(page, fx('box-20mm.stl'));
    const s = await readScene(page, id);
    check('verdict PASS', s.report.verdict === 'PASS', s.report.verdict);
    check('no layers drawn at all', Object.keys(s.layers).length === 0,
          JSON.stringify(Object.keys(s.layers)));
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the status line says so rather than going quiet', /PASS/.test(status), JSON.stringify(status));
    await page.click('#btn-check-defects');   // leave the plate clean for step 4
  }

  /* ---------------------------------------------------------------- *
   * 4. it is a toggle, a snapshot, and it follows the piece
   * ---------------------------------------------------------------- */
  console.log('\n4. toggle, staleness, and the marks following the piece');
  {
    const id = await checkPiece(page, fx('open/open_clip.stl'));
    const before = await readScene(page, id);
    check('marks up after the first press', before.hasGroup);

    // moving the piece keeps them, and moves them with it
    const moved = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      p.mesh.position.x += 25;
      p.mesh.updateMatrixWorld(true);
      const grp = p.mesh.children.find(c => c.name === 'nso-defect-marks');
      const child = grp.children[0];
      const v = new THREE.Vector3(child.geometry.attributes.position.getX(0),
                                  child.geometry.attributes.position.getY(0),
                                  child.geometry.attributes.position.getZ(0));
      v.applyMatrix4(child.matrixWorld);
      return { still: !!grp, x: v.x };
    }, id);
    const firstX = (before.layers['nso-defect-open'] || [])[0];
    check('a move keeps the marks', moved.still);
    check('and carries them with the piece', Math.abs((moved.x - firstX) - 25) < 1e-3,
          'moved by ' + (moved.x - firstX).toFixed(4) + ' mm');

    // pressing again clears them
    await page.click('#btn-check-defects');
    const gone = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      return { grp: !!p.mesh.children.find(c => c.name === 'nso-defect-marks'),
               report: window.nsoDefectsReport(),
               label: document.getElementById('btn-check-defects').textContent };
    }, id);
    check('a second press clears the marks', !gone.grp);
    check('and the report with them', gone.report === null);
    check('the button goes back to offering the check', /Check piece/.test(gone.label), gone.label);

    // and a bake that swaps the mesh drops a stale overlay
    await page.click('#btn-check-defects');
    await waitForCheckOn(page, id);
    const stale = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      const had = !!p.mesh.children.find(c => c.name === 'nso-defect-marks');
      // what every bake does to a placed piece: a new mesh in the old one's place
      const geo = p.mesh.geometry.clone();
      const mesh = new THREE.Mesh(geo, p.mesh.material);
      mesh.position.copy(p.mesh.position);
      mesh.userData.placedIndex = p.mesh.userData.placedIndex;
      state.modelGroup.remove(p.mesh);
      state.modelGroup.add(mesh);
      p.mesh = mesh;
      if (typeof nsoDefectsRefresh === 'function') nsoDefectsRefresh();
      return { had: had, now: !!mesh.children.find(c => c.name === 'nso-defect-marks'),
               report: window.nsoDefectsReport(),
               hud: document.getElementById('adjust-status').textContent,
               label: document.getElementById('btn-check-defects').textContent };
    }, id);
    check('the marks were up before the bake', stale.had);
    check('a mesh swap leaves no marks on the new mesh', !stale.now);
    check('and the report is dropped rather than left stale', stale.report === null);
    check('the HUD says the check went with it', /Check cleared/.test(stale.hud), JSON.stringify(stale.hud));
    check('the button offers the check again', /Check piece/.test(stale.label), stale.label);
  }

  /* ---------------------------------------------------------------- *
   * 5. the non-solid flag: the verdict changes, the paint does not
   * ---------------------------------------------------------------- */
  console.log('\n5. the non-solid flag changes the verdict, not the drawing');
  {
    const id = await checkPiece(page, fx('open/open_clip.stl'), { nonSolid: true });
    const s = await readScene(page, id);
    check('verdict PASS with the flag set', s.report.verdict === 'PASS', s.report.verdict);
    check('the 50 open edges are still measured', s.report.openEdges === 50, s.report.openEdges);
    check('and still drawn - the user still wants to see where it is open',
          (s.layers['nso-defect-open'] || []).length / 6 === 50,
          ((s.layers['nso-defect-open'] || []).length / 6) + ' segments');
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the status line names the flag rather than hiding the edges',
          /non-solid/.test(status), JSON.stringify(status));
    await page.click('#btn-check-defects');
  }

  /* ---------------------------------------------------------------- *
   * 6. the marks are paint, not surface
   * ---------------------------------------------------------------- */
  console.log('\n6. the marks never take a click off the piece');
  {
    const id = await checkPiece(page, fx('open/thin_shell_cup_thin.stl'));
    const hit = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      // a ray straight at the dented band from outside, where the violet is
      const dir = new THREE.Vector3(Math.cos(2), Math.sin(2), 0).normalize();
      const origin = p.mesh.position.clone().add(dir.clone().multiplyScalar(80));
      const rc = new THREE.Raycaster(origin, dir.clone().negate());
      const hits = rc.intersectObjects(state.modelGroup.children, true);
      return hits.map(h => h.object.name || 'piece');
    }, id);
    check('a ray through the painted band hits something', hit.length > 0, JSON.stringify(hit.slice(0, 3)));
    check('and not one hit is a defect mark', hit.every(n => !/^nso-defect/.test(n)),
          JSON.stringify(hit.slice(0, 5)));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails += errs.length; }

  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });

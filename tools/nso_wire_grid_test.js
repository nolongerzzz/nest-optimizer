/* End-to-end evidence for the Seat / Join surface grid, driven through the
   real app in a real browser.

   tools/nso_surface_grid_test.js proves the slicer; this proves the wiring,
   and the three things that make the aid safe to ship:

     it follows the real surface   - on a curved fixture, every line point is
                                     on the piece's own skin, checked against
                                     the app's own raycaster, not against the
                                     slicer that drew it
     it is only a picture          - export, the piece's geometry, its rawTris
                                     and the mesh-picking that Join and Seat
                                     actually use are byte-for-byte the same
                                     with the grid up as with it down
     it belongs to the lower piece - it appears on A, never on B, and changes
                                     hands the moment the roles do

   node tools/nso_wire_grid_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = (f) => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* ---- what the page is asked ---- */

/** Every grid in the scene, and the piece each one says it belongs to. The
    grid stands beside its piece in modelGroup rather than under it, so this
    reads the scene, not the piece's children - and a grid that ended up on
    the wrong piece, or two on one, has nowhere to hide. */
const gridsOn = (page) => page.evaluate(() => {
  const out = [];
  (state.modelGroup ? state.modelGroup.children : []).forEach(function (c) {
    if (!c || c.name !== 'seatGrid') return;
    out.push({ sourceId: c.userData.seatGrid.sourceId, lines: c.children.length });
  });
  return out;
});

/** The grid object for a piece, and its pose, read off the scene. */
const gridFor = (page, sid) => page.evaluate((id) => {
  const g = state.modelGroup.children.filter(function (c) {
    return c.name === 'seatGrid' && c.userData.seatGrid.sourceId === id;
  })[0];
  if (!g) return null;
  const p = state.placed.find(function (x) { return x && x.sourceId === id; });
  return {
    pose: [g.position.x, g.position.y, g.position.z],
    meshPose: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z],
    parentIsModelGroup: g.parent === state.modelGroup,
    meshChildGrids: p.mesh.children.filter(function (c) { return c.name === 'seatGrid'; }).length
  };
}, sid);

/** Pick A and B the way the panel does: arm the slot, click the piece. */
const pickJoin = (page, idA, idB) => page.evaluate(([a, b]) => {
  startJoinSession();
  armJoinSlot('a');
  assignJoinClick(a, null);
  if (b != null) {
    armJoinSlot('b');
    assignJoinClick(b, null);
  }
  return { editId: state.editId, partner: state.joinPartnerId };
}, [idA, idB]);

/** A snapshot of everything the grid is forbidden to touch. */
const untouched = (page, id) => page.evaluate((sid) => {
  const p = state.placed.find(function (x) { return x && x.sourceId === sid; });
  const m = state.models.find(function (x) { return x.id === sid; });
  const geo = p.mesh.geometry;
  const pos = geo.attributes.position;
  let sum = 0;
  for (let i = 0; i < pos.count; i++) sum += pos.getX(i) + pos.getY(i) + pos.getZ(i);
  const exp = buildCombinedGeometry();
  // The measuring tape four other suites use on a piece. It walks children,
  // so anything with volume hung under the mesh changes what the piece
  // measures - which is how the grid is forbidden to be visible.
  const r6 = function (n) { return Math.round(n * 1e6) / 1e6; };
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return {
    box: [r6(bb.min.x), r6(bb.min.y), r6(bb.min.z), r6(bb.max.x), r6(bb.max.y), r6(bb.max.z)].join(','),
    geoUuid: geo.uuid,
    verts: pos.count,
    vertSum: Math.round(sum * 1e6) / 1e6,
    rawTris: m && m.rawTris ? m.rawTris.length : null,
    rawSum: m && m.rawTris
      ? Math.round(m.rawTris.reduce(function (a, v) { return a + v; }, 0) * 1e6) / 1e6 : null,
    exportVerts: exp.attributes.position.count,
    meshY: Math.round(p.mesh.position.y * 1e6) / 1e6
  };
}, id);

withApp(async (page, logs) => {
  console.log('\n=== 1. the button is there and wired ===');
  const btn = await page.evaluate(() => {
    const b = document.getElementById('btn-seat-grid');
    return b ? { text: b.textContent.trim(), bound: b._seatGridBound === true } : null;
  });
  check('#btn-seat-grid present in the DOM', !!btn, btn ? 'label "' + btn.text + '"' : 'missing');
  check('listener attached at load', !!btn && btn.bound);
  check('it starts in auto', !!btn && btn.text === 'Surface grid: auto');
  check('the page exposes its read-back', await page.evaluate(
    () => typeof window.nsoSeatGridInfo === 'function' && typeof window.nsoSeatGridRefresh === 'function'));

  console.log('\n=== 2. nothing selected, no pairing: no grid ===');
  check('the plate is bare of grids', (await gridsOn(page)).length === 0);

  console.log('\n=== 3. a curved piece as the Join target ===');
  const idDome = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  const idBox = await loadSTL(page, fx('box-20mm.stl'));
  const roles = await pickJoin(page, idDome, idBox);
  check('A is the dome, B is the box', roles.editId === idDome && roles.partner === idBox);

  let on = await gridsOn(page);
  check('exactly one piece carries a grid', on.length === 1, JSON.stringify(on));
  check('and it is A, the lower piece', on.length === 1 && on[0].sourceId === idDome);
  check('the grid is drawn as lines, plus a centre cross',
    on.length === 1 && on[0].lines === 2, on.length ? on[0].lines + ' line objects' : '-');

  const info = await page.evaluate(() => window.nsoSeatGridInfo());
  check('it reports the piece it is on', info.visible && info.onSourceId === idDome);
  check('the spacing is a round number', [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50].indexOf(info.spacing) !== -1,
    info.spacing + 'mm squares');
  check('it found a real surface to draw on', info.segments > 100 && info.faces > 50,
    info.segments + ' segments over ' + info.faces + ' up-facing tris');

  console.log('\n=== 4. the lines are ON the curved skin, by the app\'s own raycaster ===');
  const follow = await page.evaluate(() => {
    const p = state.placed.find(function (x) { return x && x.sourceId === state.editId; });
    const grid = state.modelGroup.children.filter(function (c) {
      return c.name === 'seatGrid' && c.userData.seatGrid.sourceId === p.sourceId;
    })[0];
    p.mesh.updateMatrixWorld(true);
    grid.updateMatrixWorld(true);
    // Every grid point, in world space, through the GRID's own matrix - if the
    // pose it carries were not the piece's, the rays below would land nowhere.
    const world = [];
    grid.children.forEach(function (line) {
      const pos = line.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        world.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
          .applyMatrix4(grid.matrixWorld));
      }
    });
    // Drop a ray straight down onto the piece over each one and compare. The
    // raycaster reads the MESH, so agreement means the line is on the skin -
    // it is not the slicer marking its own homework.
    const box = new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.attributes.position);
    const top = box.max.y + p.mesh.position.y + 50;
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const nm = new THREE.Matrix3().getNormalMatrix(p.mesh.matrixWorld);
    let worst = 0, sunk = 0, missed = 0, tested = 0;
    const step = Math.max(1, Math.floor(world.length / 400));
    for (let i = 0; i < world.length; i += step) {
      const q = world[i];
      rc.set(new THREE.Vector3(q.x, top, q.z), down);
      const hits = rc.intersectObject(p.mesh, true);
      tested++;
      if (!hits.length) { missed++; continue; }
      // Measured across the face, not straight up: on a steep flank a
      // vertical gap is mostly the slope, and what is being asked is how far
      // the line stands off the skin.
      const n = hits[0].face.normal.clone().applyMatrix3(nm).normalize();
      const d = q.clone().sub(hits[0].point).dot(n);
      if (d < -1e-4) sunk++;
      if (Math.abs(d) > worst) worst = Math.abs(d);
    }
    const ys = world.map(function (q) { return q.y; });
    return {
      tested: tested, missed: missed, worst: worst, sunk: sunk,
      points: world.length,
      ySpread: Math.max.apply(null, ys) - Math.min.apply(null, ys),
      height: box.max.y - box.min.y
    };
  });
  check('every sampled line point has piece under it', follow.missed === 0,
    follow.missed + ' of ' + follow.tested + ' rays missed');
  // The lines are lifted a hair off the face so they are not in a depth fight
  // with it; anything beyond that would be a line floating over the surface.
  check('and sits on the surface, not above it', follow.worst < 0.2,
    'worst gap ' + follow.worst.toFixed(3) + 'mm over ' + follow.points + ' points');
  check('and never sinks into it', follow.sunk === 0, follow.sunk + ' points below the skin');
  check('the grid is curved, so this was a real test of following it',
    follow.ySpread > follow.height * 0.25,
    'lines rise and fall ' + follow.ySpread.toFixed(2) + 'mm on a ' + follow.height.toFixed(2) + 'mm piece');

  console.log('\n=== 5. it is a picture: nothing else can see it ===');
  const withGrid = await untouched(page, idDome);
  const picks = await page.evaluate(() => {
    const p = state.placed.find(function (x) { return x && x.sourceId === state.editId; });
    p.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.attributes.position);
    const top = box.max.y + p.mesh.position.y + 50;
    const rc = new THREE.Raycaster();
    const out = { hits: 0, firstIsMesh: 0, firstHasFace: 0, gridHits: 0, tries: 0 };
    // Straight down the middle and around it - where a Join or Seat pick lands.
    for (let dx = -4; dx <= 4; dx += 2) {
      for (let dz = -4; dz <= 4; dz += 2) {
        rc.set(new THREE.Vector3(p.mesh.position.x + dx, top, p.mesh.position.z + dz),
               new THREE.Vector3(0, -1, 0));
        // recursive, exactly as app-core.js's join / soften / paint picks do
        const hits = rc.intersectObjects(state.modelGroup.children, true);
        out.tries++;
        if (!hits.length) continue;
        out.hits++;
        if (hits[0].object.isMesh) out.firstIsMesh++;
        if (hits[0].face) out.firstHasFace++;
        hits.forEach(function (h) {
          let o = h.object;
          while (o) {
            if (o.name === 'seatGrid' || o.userData.nsoHelper) { out.gridHits++; break; }
            o = o.parent;
          }
        });
      }
    }
    // and the flat statement of it: the line objects are deaf to rays
    const grid = state.modelGroup.children.filter(function (c) {
      return c.name === 'seatGrid' && c.userData.seatGrid.sourceId === p.sourceId;
    })[0];
    const sink = [];
    grid.children.forEach(function (line) { line.raycast(rc, sink); });
    out.deaf = sink.length === 0;
    return out;
  });
  check('a pick over the target still lands on the piece',
    picks.hits === picks.tries && picks.firstIsMesh === picks.hits,
    picks.hits + '/' + picks.tries + ' rays, ' + picks.firstIsMesh + ' on a mesh');
  check('and still carries the face the pick needs', picks.firstHasFace === picks.hits);
  check('no ray ever hit the grid', picks.gridHits === 0, picks.gridHits + ' grid hits');
  check('the line objects refuse rays outright', picks.deaf === true);

  console.log('\n=== 6. grid up vs grid down: the piece and the export are identical ===');
  await page.evaluate(() => window.nsoSeatGridSetMode('off'));
  check('mode off takes every grid off the plate', (await gridsOn(page)).length === 0);
  const noGrid = await untouched(page, idDome);
  await page.evaluate(() => window.nsoSeatGridSetMode('auto'));
  check('mode auto puts it back on A', (await gridsOn(page)).map((g) => g.sourceId).join() === String(idDome));
  const backOn = await untouched(page, idDome);

  check('the piece MEASURES the same with the grid up',
    withGrid.box === noGrid.box && backOn.box === noGrid.box,
    withGrid.box + ' vs ' + noGrid.box);
  check('the display geometry is the same object', withGrid.geoUuid === noGrid.geoUuid);
  check('with the same vertices', withGrid.verts === noGrid.verts && withGrid.vertSum === noGrid.vertSum,
    withGrid.verts + ' vs ' + noGrid.verts);
  check('the raw soup the exporters read is untouched',
    withGrid.rawTris === noGrid.rawTris && withGrid.rawSum === noGrid.rawSum);
  check('the plate export has the same triangle count',
    withGrid.exportVerts === noGrid.exportVerts && backOn.exportVerts === noGrid.exportVerts,
    withGrid.exportVerts + ' vs ' + noGrid.exportVerts + ' vs ' + backOn.exportVerts);
  check('the export count is the pieces\' own triangles and nothing else',
    noGrid.exportVerts === await page.evaluate(() => state.placed.reduce(
      function (n, p) { return n + p.geometry.attributes.position.count; }, 0)));
  check('the piece did not move', withGrid.meshY === noGrid.meshY);

  console.log('\n=== 6b. it stands beside the piece, and keeps up with it ===');
  const place = await gridFor(page, idDome);
  check('the grid is a child of modelGroup, not of the piece', place.parentIsModelGroup);
  check('nothing with volume hangs under the mesh', place.meshChildGrids === 0);
  check('and it wears the piece\'s pose', place.pose.join() === place.meshPose.join(),
    place.pose.join() + ' vs ' + place.meshPose.join());
  const moved = await page.evaluate((sid) => {
    const p = state.placed.find(function (x) { return x && x.sourceId === sid; });
    applyPlacedXZ(p, p.x + 17, p.z - 9);          // the path every drag and nudge takes
    const g = state.modelGroup.children.filter(function (c) {
      return c.name === 'seatGrid' && c.userData.seatGrid.sourceId === sid;
    })[0];
    return { pose: [g.position.x, g.position.y, g.position.z].join(),
             meshPose: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z].join() };
  }, idDome);
  check('a move carries the grid with it', moved.pose === moved.meshPose,
    moved.pose + ' vs ' + moved.meshPose);

  console.log('\n=== 7. it changes hands when the roles do ===');
  await pickJoin(page, idBox, idDome);
  on = await gridsOn(page);
  check('A and B swapped: the grid is on the box now',
    on.length === 1 && on[0].sourceId === idBox, JSON.stringify(on));
  check('the dome, now the upper piece, has none',
    on.every((g) => g.sourceId !== idDome));

  const selB = await page.evaluate((sid) => {
    const i = state.placed.findIndex(function (p) { return p && p.sourceId === sid; });
    selectPlaced(i);
    return { editId: state.editId, partner: state.joinPartnerId };
  }, idDome);
  check('clicking B does not make it the target', selB.partner === idDome);
  on = await gridsOn(page);
  check('so the grid stays on A', on.length === 1 && on[0].sourceId === idBox, JSON.stringify(on));

  await page.evaluate(() => clearJoinSlots());
  check('Cancel Join takes the grid away', (await gridsOn(page)).length === 0);

  console.log('\n=== 8. the on-demand half of the toggle ===');
  await page.evaluate((sid) => {
    const i = state.placed.findIndex(function (p) { return p && p.sourceId === sid; });
    selectPlaced(i);
  }, idDome);
  check('auto alone does not grid a merely selected piece', (await gridsOn(page)).length === 0);
  await page.evaluate(() => window.nsoSeatGridSetMode('on'));
  on = await gridsOn(page);
  check('mode on grids the selected piece', on.length === 1 && on[0].sourceId === idDome, JSON.stringify(on));
  await pickJoin(page, idBox, null);
  on = await gridsOn(page);
  check('a pairing still outranks the selection', on.length === 1 && on[0].sourceId === idBox, JSON.stringify(on));
  await page.evaluate(() => window.nsoSeatGridSetMode('off'));
  check('off means off, pairing or not', (await gridsOn(page)).length === 0);
  const label = await page.evaluate(() => document.getElementById('btn-seat-grid').textContent.trim());
  check('the button says which state it is in', label === 'Surface grid: off', label);
  await page.evaluate(() => { document.getElementById('btn-seat-grid').click(); });
  check('clicking it cycles back round to auto',
    await page.evaluate(() => window.nsoSeatGridInfo().mode) === 'auto');

  console.log('\n=== 9. the console stayed clean ===');
  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  const warns = logs.filter((l) => /seat-grid/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));
  check('no grid warnings', warns.length === 0, warns.join(' | '));

  console.log('');
  if (fails) { console.log(fails + ' FAILURE(S)'); process.exit(1); }
  console.log('ALL GREEN');
}).catch((e) => { console.error('DRIVE FAIL', e); process.exit(1); });

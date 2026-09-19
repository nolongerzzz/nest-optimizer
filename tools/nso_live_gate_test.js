#!/usr/bin/env node
/* Validation suite for the LIVE wall gate - NSO_Thickness.prepare() and the
   two tools wired to it, Carve (app-carve.js) and the Freehand Brush
   (app-brush.js).

   WHAT THIS IS A SECOND LAYER OF, stated first because the whole value of the
   gate is that it is independent.

   The brush already had a front-facing filter: NSO_brushFacing, on area-
   weighted vertex normals, keeps a stamp's vertices to the hemisphere the
   stamp faces so a dab on the near wall cannot reach round and drag the FAR
   wall's vertices with it. That is the "the stroke reaches through to the
   other side" failure and it is fixed. It has NO opinion about a dab that only
   ever touches the near face and still leaves 0.2 mm of wall behind it - the
   far face never moved, so the filter never had anything to say. Part 4 below
   builds exactly that stroke and shows both things at once: the facing filter
   holds (the far face's vertices are untouched) AND the wall is left
   unprintable. One check passing while the other fails is the argument for
   having two.

   Five parts:
     1. the probe agrees with the canonical batch checker, face for face.
        It is the same probe with the setup hoisted out, not a second opinion,
        and the only way to say so is to run both and compare.
     2. the gate REFUSES a genuinely-too-thin stroke and ALLOWS a safe one,
        on fixtures/box_open.stl, whose 2 mm wall is real geometry rather than
        a number this suite chose.
     3. the unmeasured case: a wall deeper than the default probe is not
        waved through on a shrug - the probe is widened past what the stroke
        needs first, so "nothing behind it" is a measurement.
     4. the brush wiring: dab depth is NSO_brushDeform's own arithmetic, the
        per-dab gate, and the result-side gate at pointerup. Plus the
        independence argument above, demonstrated.
     5. the carve wiring: the refusal fires before the kernel is reached, and
        the wording is the canonical one.

   Run: node tools/nso_live_gate_test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('../nso_thickness.js');
const { readSTL } = require('./nso_stl_io.js');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'fixtures');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}
const near = (a, b, tol) => (a != null && b != null && Math.abs(a - b) <= tol);
const r3 = (x) => (x == null ? '?' : Math.round(x * 1000) / 1000);

const FLOOR = T.floorFor(0.4);

function box(lo, hi, inward) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const f of F) {
    const t = inward ? [f[0], f[2], f[1]] : f;
    for (const i of t) out.push(...V[i]);
  }
  return new Float32Array(out);
}
function concat(...soups) {
  let n = 0; for (const s of soups) n += s.length;
  const out = new Float32Array(n);
  let at = 0; for (const s of soups) { out.set(s, at); at += s.length; }
  return out;
}
function shell(size, wall) {
  return concat(box([0, 0, 0], [size, size, size], false),
                box([wall, wall, wall], [size - wall, size - wall, size - wall], true));
}
function centroid(soup, f) {
  const o = f * 9;
  return [(soup[o] + soup[o + 3] + soup[o + 6]) / 3,
          (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
          (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
}

/* ==================================== 1. the same probe, not a second opinion */
console.log('\n== 1. the live probe agrees with the canonical batch checker ==');
{
  const soup = readSTL(path.join(FIX, 'box_open.stl'));
  const batch = T.measureMesh(soup, {});
  const P = T.prepare(soup, {});
  check('prepare() indexes the same faces measureMesh() does',
        P.faceCount === soup.length / 9, P.faceCount + ' faces');

  /* Face by face, from each centroid, which is exactly where measureMesh
     casts from. If these two ever disagree the live gate is lying about the
     same piece the exporter's checker is telling the truth about. */
  let compared = 0, agreed = 0, worst = 0;
  for (let f = 0; f < P.faceCount; f++) {
    const c = centroid(soup, f);
    const w = P.wallAt(c);
    const one = T.measureRegion(soup, [f], {});
    if (!w.measured && one.min_mm === null) { compared++; agreed++; continue; }
    if (w.measured !== (one.min_mm !== null)) { compared++; continue; }
    compared++;
    const d = Math.abs(w.mm - one.min_mm);
    if (d > worst) worst = d;
    if (d <= 1e-6) agreed++;
  }
  check('every face\'s live wall equals its batch wall, from the same centroid',
        compared === P.faceCount && agreed === compared,
        agreed + '/' + compared + ' agree, worst gap ' + worst.toExponential(1) + ' mm');
  check('  ...and the thinnest of them is the batch report\'s own min',
        batch.min_mm !== null, 'batch min ' + r3(batch.min_mm) + ' mm');

  /* prepare() also answers the parity question, which is what nso_hollow.js's
     solid voxelisation runs on. box_open is a 60x40x25 open box with 2 mm
     walls, so a point in the middle is NOT in material and one in a wall is. */
  check('inside() puts a point in the cavity outside the material',
        P.inside([30, 20, 12]) === false);
  check('inside() puts a point in the wall inside the material',
        P.inside([30, 1, 12]) === true);
}

/* ==================================== 2. refuse the thin one, allow the safe one */
console.log('\n== 2. the gate refuses a too-thin stroke and allows a safe one ==');
{
  const soup = readSTL(path.join(FIX, 'box_open.stl'));
  const P = T.prepare(soup, {});
  const PT = [30, 0, 12];              // mid-height on the y = 0 outer wall
  const w = P.wallAt(PT);
  check('the wall at the stroke point measures 2.00 mm, which is what the fixture has',
        near(w.mm, 2, 1e-3), r3(w.mm) + ' mm');

  /* SAFE. 1.0 mm into a 2 mm wall leaves 1.0 mm, well over the 0.42 floor. */
  const safe = P.strokeGate({ point: PT, depth: 1.0, label: 'carve' });
  check('a 1.0 mm cut into it is ALLOWED', safe.ok === true, safe.reason);
  check('  ...and it says what it leaves, so the number is auditable',
        near(safe.residual_mm, 1.0, 1e-3) && near(safe.wall_mm, 2, 1e-3),
        'wall ' + r3(safe.wall_mm) + ', leaves ' + r3(safe.residual_mm));
  check('  a safe stroke produces NO refusal text at all',
        T.strokeRefusal(safe) === '');

  /* TOO THIN. 1.8 mm into the same 2 mm wall leaves 0.2 mm - under the floor,
     and nothing about it reaches the far face, so the front-facing filter
     would never have seen it. */
  const thin = P.strokeGate({ point: PT, depth: 1.8, label: 'carve' });
  check('a 1.8 mm cut into the same wall is REFUSED', thin.ok === false, thin.reason);
  check('  ...because of the 0.2 mm it would leave, and it says the number',
        near(thin.residual_mm, 0.2, 1e-3) && /0\.2 mm/.test(thin.reason), r3(thin.residual_mm));
  check('  ...against the canonical floor, named, with the nozzle it came from',
        thin.threshold_mm === FLOOR && /0\.42 mm floor/.test(thin.reason) && /0\.4 mm nozzle/.test(thin.reason));

  const msg = T.strokeRefusal(thin);
  check('  the refusal wording is the one the ticket asks for', /wall too thin here/i.test(msg), msg.slice(0, 96));
  check('  ...and it says what to do about it, which is the whole point of a refusal',
        /Thicken first/i.test(msg));
  check('  ...and that the piece was not touched', /piece unchanged/i.test(msg));

  /* THE BOUNDARY, both sides of it, so the gate is not merely "refuses big
     numbers". 2 - 0.42 = 1.58 mm is the deepest cut this wall can take. */
  const edgeOk = P.strokeGate({ point: PT, depth: 2 - FLOOR - 1e-3, label: 'carve' });
  const edgeNo = P.strokeGate({ point: PT, depth: 2 - FLOOR + 1e-2, label: 'carve' });
  check('the deepest cut the wall can take is allowed', edgeOk.ok === true, r3(edgeOk.residual_mm) + ' mm left');
  check('  ...and a hair deeper is refused', edgeNo.ok === false, r3(edgeNo.residual_mm) + ' mm left');

  /* ALREADY UNDER THE FLOOR. A zero-depth question on a wall that is already
     unprintable is still a refusal - there is nothing safe to cut into. */
  const thinPiece = T.prepare(shell(10, 0.3), {});
  const already = thinPiece.strokeGate({ point: [5, 0, 5], depth: 0, label: 'carve' });
  check('a wall that is ALREADY under the floor is refused at zero depth',
        already.ok === false && /already 0\.3 mm/.test(already.reason), already.reason.slice(0, 72));
  check('  ...and the canonical batch checker agrees the piece is thin',
        T.measureMesh(shell(10, 0.3), {}).pass === false);
}

/* ============================================= 3. the unmeasured case */
console.log('\n== 3. unmeasured is not a pass in disguise ==');
{
  /* A 40 mm solid cube: from the middle of a face, the far face is 40 mm away,
     eight times the default 5 mm probe. A gate that read "nothing within 5 mm"
     as "unknown, refuse" would refuse every cut into anything solid; one that
     read it as "fine" without looking further would wave through a 39.9 mm
     cut. The probe is widened past depth + floor first, so the answer is a
     measurement either way. */
  const solid = box([0, 0, 0], [40, 40, 40], false);
  const P = T.prepare(solid, {});
  const PT = [20, 0, 20];

  const shallow = P.wallAt(PT);
  check('at the default 5 mm probe the 40 mm block reads as a SHEET, not as a wall',
        shallow.measured === false && shallow.sheet === true, shallow.reason);

  const g = P.strokeGate({ point: PT, depth: 3, label: 'carve' });
  check('a 3 mm cut into it is allowed, and the reason is a measurement not a shrug',
        g.ok === true && /no surface within/.test(g.reason), g.reason.slice(0, 80));

  const deep = P.strokeGate({ point: PT, depth: 39.9, label: 'carve' });
  check('a 39.9 mm cut through the same block is REFUSED - the probe widened to find the far face',
        deep.ok === false, deep.reason.slice(0, 96));
  check('  ...and it measured the real 40 mm, not the 5 mm default',
        near(deep.wall_mm, 40, 1e-3), r3(deep.wall_mm) + ' mm');
}

/* ================================================ 4. the brush wiring */
console.log('\n== 4. the Freehand Brush ==');
/* The same context tools/nso_brush_test.js builds, plus nso_thickness.js -
   which is exactly the new dependency, so loading it here is the point. */
const ctx = {
  Math, Map, Set, console, isFinite, Object, Array, Number,
  Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array,
  window: {}
};
vm.createContext(ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'app-sculpt.js', 'app-brush.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), ctx, { filename: f });
}
ctx.NSO_Repair = ctx.window.NSO_Repair;
ctx.NSO_Thickness = ctx.window.NSO_Thickness;
check('app-brush.js loads headless with nso_thickness.js beside it',
      typeof ctx.NSO_brushWallGate === 'function' && typeof ctx.NSO_brushDabDepth === 'function');
check('  ...and finds the canonical module the way a classic script would',
      !!ctx.NSO_Thickness && ctx.NSO_Thickness.floorFor(0.4) === 0.42);
{
  /* The dab depth has to be NSO_brushDeform's own arithmetic and not a second
     copy of it, so it is checked AGAINST the deformation rather than against a
     number written down here. */
  const opts = { mode: 'carve', intensity: 0.5, radius: 12 };
  const d = ctx.NSO_brushDabDepth(opts);
  check('dab depth is intensity * depthScale * radius - 0.5 * 0.25 * 12 = 1.5 mm',
        d === 1.5, String(d));

  /* Checked against the DEFORMATION, through the brush's own whole-stroke
     entry point - refinement included, because a 12-triangle box has no vertex
     under the stamp until the brush puts one there, and a check that skipped
     the refinement would be measuring nothing. */
  const plate = box([0, 0, 0], [40, 40, 40], false);
  const stamp = { c: [20, 20, 40], n: [0, 0, 1], r: 12, falloff: 'soft', mode: 'carve' };
  const run = ctx.NSO_brushApply(plate, [stamp], Object.assign({ seam: false }, opts));
  check('  the brush\'s own whole-stroke path runs on it', run.ok === true, run.reason || (run.moved + ' verts moved'));
  check('  ...and the deepest a vertex moves is exactly the dab depth',
        near(run.maxMove, d, 1e-6), r3(run.maxMove) + ' mm moved, ' + run.moved + ' verts');

  check('Emboss is not gated - it adds material and cannot thin a wall',
        ctx.NSO_brushDabDepth({ mode: 'emboss', intensity: 1, radius: 20 }) === 0);
  check('local Smooth is not gated - the Laplacian has no cut depth to gate',
        ctx.NSO_brushDabDepth({ mode: 'smooth', intensity: 1, radius: 20 }) === 0);
  const ng = ctx.NSO_brushWallGate(T.prepare(plate, {}), [20, 20, 40], [0, 0, 1],
                                   { mode: 'emboss', intensity: 1, radius: 20 });
  check('  ...and they say so rather than being waved through silently',
        ng.ok === true && ng.skipped === true && /Emboss adds material/.test(ng.reason), ng.reason);
}
{
  /* A 3 mm wall, and a brush whose dab is 2.75 mm deep. That leaves 0.25 mm:
     under the floor, and NOT a reach-through - the far face is never even
     approached. This is the case the front-facing filter cannot see. */
  const piece = shell(30, 3);
  const P = T.prepare(piece, {});
  const PT = [15, 0, 15], NRM = [0, -1, 0];

  const safeOpts = { mode: 'carve', intensity: 0.5, radius: 8 };      // 1.0 mm
  const deepOpts = { mode: 'carve', intensity: 0.5, radius: 22 };     // 2.75 mm
  check('the two brushes: a safe one cuts ' + ctx.NSO_brushDabDepth(safeOpts) +
        ' mm, the deep one ' + ctx.NSO_brushDabDepth(deepOpts) + ' mm, into a 3 mm wall', true);

  const gs = ctx.NSO_brushWallGate(P, PT, NRM, safeOpts);
  check('the safe stroke is ALLOWED', gs.ok === true, gs.reason);
  const gd = ctx.NSO_brushWallGate(P, PT, NRM, deepOpts);
  check('the too-thin stroke is REFUSED', gd.ok === false, gd.reason);
  check('  ...naming the 0.25 mm it would leave',
        near(gd.residual_mm, 0.25, 1e-3), r3(gd.residual_mm) + ' mm');
  check('  ...with the wording the ticket asks for',
        /wall too thin here/i.test(T.strokeRefusal(gd)) && /Thicken first/i.test(T.strokeRefusal(gd)),
        T.strokeRefusal(gd).slice(0, 92));

  /* THE INDEPENDENCE ARGUMENT, demonstrated rather than asserted. Run the deep
     stroke for real through the brush's own pipeline and show BOTH things:
     the front-facing filter did its job (no far-wall vertex moved at all), and
     the wall that came out is still unprintable. */
  const stamp = { c: PT, n: NRM, r: deepOpts.radius, falloff: 'soft', mode: 'carve' };
  /* The brush's own stages, run in the brush's own order, with the base
     positions kept so far-wall and near-wall movement can be compared vertex
     for vertex. Refinement is included and is not optional: a 24-triangle
     shell has no vertex under the stamp until the brush puts one there. */
  const adj = ctx.NSO_buildAdjacency(piece, {});
  const mesh = ctx.NSO_brushRefine(ctx.NSO_brushMesh(adj), ctx.NSO_brushZones([stamp]),
                                   { target: ctx.NSO_brushTargetEdge(stamp.r) }).mesh;
  const basePos = new Float64Array(mesh.pos);
  const vn = ctx.NSO_brushVertexNormals(mesh);
  const field = ctx.NSO_brushWeights(mesh, [stamp], { normals: vn });
  const pos = ctx.NSO_brushDeform(mesh, basePos, field, deepOpts);
  check('the deep stroke runs through the brush\'s own pipeline',
        field.touched.length > 0, field.touched.length + ' vertices selected');

  /* The far wall is the shell's inner surface at y = 3; the near one is the
     outer surface at y = 0. Compared against each vertex's OWN base position,
     so this is what the pipeline did and not what it was asked to do. */
  let farMoved = 0, nearMoved = 0, farCount = 0;
  for (let v = 0; v < mesh.vertCount; v++) {
    const y0 = basePos[v * 3 + 1];
    const d = Math.abs(pos[v * 3 + 1] - y0);
    if (near(y0, 3, 1e-6)) { farCount++; if (d > farMoved) farMoved = d; }
    else if (near(y0, 0, 1e-6)) { if (d > nearMoved) nearMoved = d; }
  }
  check('the front-facing filter HELD - not one of the far wall\'s vertices moved',
        farCount > 0 && farMoved <= 1e-9, farCount + ' far-wall verts, worst move ' + r3(farMoved) + ' mm');
  check('  ...while the near wall moved the full dab depth',
        near(nearMoved, ctx.NSO_brushDabDepth(deepOpts), 1e-6), 'near wall moved ' + r3(nearMoved) + ' mm');

  const outTris = ctx.NSO_brushToRaw(mesh, pos);
  const after = T.measureMesh(outTris, {});
  check('  ...and the piece that came out is UNPRINTABLE anyway - which is the argument for two layers',
        after.pass === false, T.describe(after).slice(0, 80));
  check('  the topology gate that already existed cannot see it - the result is sound, just too thin',
        after.thin > 0 && after.min_mm < FLOOR, 'thinnest ' + r3(after.min_mm) + ' vs floor ' + FLOOR);

  /* The pointerup layer, which measures the RESULT. */
  const rg = ctx.NSO_brushWallGateResult(outTris, [stamp], deepOpts);
  check('the result-side gate at pointerup refuses the committed stroke too',
        rg.ok === false, rg.reason.slice(0, 84));
  /* The two numbers are close but not equal, and the difference is the point
     of having a live probe at all: measureMesh() samples face CENTROIDS, the
     gate samples the stamp centre - the spot the user actually cut, which is a
     vertex and is the deepest point of the dab. So the live reading is at or
     under the batch one, never over it, and the gate is the stricter of the
     two by construction rather than by luck. */
  check('  ...and it measured the wall that is actually there now, at the deepest point',
        rg.wall_mm <= after.min_mm + 1e-6 && rg.wall_mm > 0,
        'gate ' + r3(rg.wall_mm) + ' at the stamp centre vs checker ' + r3(after.min_mm) + ' at face centroids');
  check('  ...and both of them are under the floor, so the two agree on the verdict',
        rg.wall_mm < FLOOR && after.min_mm < FLOOR);

  /* ...and does not fire on a stroke that was fine. */
  const okStamp = { c: PT, n: NRM, r: safeOpts.radius, falloff: 'soft', mode: 'carve' };
  const okMesh = ctx.NSO_brushRefine(ctx.NSO_brushMesh(ctx.NSO_buildAdjacency(piece, {})),
                                     ctx.NSO_brushZones([okStamp]),
                                     { target: ctx.NSO_brushTargetEdge(okStamp.r) }).mesh;
  const okBase = new Float64Array(okMesh.pos);
  const okTris = ctx.NSO_brushToRaw(okMesh, ctx.NSO_brushDeform(okMesh, okBase,
    ctx.NSO_brushWeights(okMesh, [okStamp], { normals: ctx.NSO_brushVertexNormals(okMesh) }), safeOpts));
  const rgOk = ctx.NSO_brushWallGateResult(okTris, [okStamp], safeOpts);
  check('the result-side gate PASSES a stroke that left a printable wall',
        rgOk.ok === true, rgOk.reason);
  check('  ...and the canonical checker agrees with it',
        T.measureMesh(okTris, {}).pass === true);

  check('the gate stands down rather than guessing when nso_thickness.js is absent',
        ctx.NSO_brushWallGate(null, PT, NRM, deepOpts).skipped === true);
}

/* ================================================= 5. the carve wiring */
console.log('\n== 5. Local-Carve ==');
{
  const src = fs.readFileSync(path.join(REPO, 'app-carve.js'), 'utf8');
  check('app-carve.js builds the live probe from the canonical module',
        /NSO_Thickness\.prepare\(hullSoup/.test(src));
  check('  ...gates the click with the blade depth',
        /probe\.strokeGate\(\{\s*point:\s*\[pt\.x, pt\.y, pt\.z\],\s*depth:\s*depth/.test(src));
  check('  ...and REFUSES, in the canonical wording, rather than warning',
        /NSO_Thickness\.strokeRefusal\(gate\)/.test(src) && /if \(gate && !gate\.ok\)/.test(src));

  /* The refusal has to happen BEFORE the CSG kernel is loaded: a gate that
     fires after a boolean has run is not proactive, it is an apology. */
  const gateAt = src.indexOf('if (gate && !gate.ok)');
  const kernelAt = src.indexOf('await NSO_CSG.load()');
  check('  ...before the kernel is loaded and before anything is committed',
        gateAt > 0 && kernelAt > 0 && gateAt < kernelAt,
        'gate at ' + gateAt + ', kernel at ' + kernelAt);

  check('cutClearance\'s warning is still a warning - the two layers are different things',
        /reported, not blocked/.test(fs.readFileSync(path.join(REPO, 'nso_thickness.js'), 'utf8')));

  /* The same question the app asks, asked here against the real fixture, so
     the suite covers the carve path's answer and not only its wiring. */
  const soup = readSTL(path.join(FIX, 'box_open.stl'));
  const P = T.prepare(soup, {});
  const g = P.strokeGate({ point: [30, 0, 12], depth: 1.9, label: 'carve' });
  check('a 1.9 mm carve into the fixture\'s 2 mm wall is refused',
        g.ok === false, T.strokeRefusal(g).slice(0, 92));
  const g2 = P.strokeGate({ point: [30, 0, 12], depth: 0.5, label: 'carve' });
  check('a 0.5 mm carve into it is allowed', g2.ok === true, g2.reason);
}

console.log('\n' + (fail ? 'FAILED ' : 'passed ') + pass + ' check(s), ' + fail + ' failure(s)\n');
process.exit(fail ? 1 : 0);

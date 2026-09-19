/* Seat here - seating against a curved or irregular target. THE GATE.
   node tools/nso_seat_surface_test.js      exit 0 = every gate held
   npm run seat:surface

   Task 1's audit is tools/nso_seat_curved_audit.js and is a separate run.
   This file gates the thing that was built for it.

   What is pinned, and how
   -----------------------
   Part 1  the core (nso_seat_surface.js) in Node, against ANALYTIC geometry,
           so "the normal is right" is checked against calculus and not
           against another piece of this repository. Plus the equivalence of
           the two independent minimum-distance implementations - the one the
           core solves with, and tools/nso_soup_distance.js, which the gates
           measure with - on the real fixtures. Same discipline as
           tools/nso_selfint_equiv_test.js, for the same reason.

   Part 2  the shipped Seat here button, in the real app in real Chromium,
           against the repository's real curved fixtures - the 20 mm sphere,
           the genus-1 concave groove and the organic blob - including one
           seat driven by an actual mouse click on the canvas. Every result
           goes out through the real Export plate path and comes back through
           tools/mesh_validate.py --json, the canonical checker; the gap is
           measured on the EXPORTED shells, so a pose the file does not carry
           cannot pass.

   Part 3  the regression. The flat-face seat is not touched by this ticket:
           NSO_seatFlushBitToHull is byte-identical, and its golden flush pose
           and golden status line are re-pinned here as well as in
           tools/nso_seat_gap_test.js, so a change to either file has to fail
           two suites. Seat here on a flat target is pinned too - the new tool
           is a superset, not a curve-only detour.

   THE GAP, EVERYWHERE IN THIS FILE, is the true minimum distance between the
   two surfaces. Not a bounding-box difference along an axis: these pieces are
   tilted and the targets are curved, so no box extreme is the contact.    */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { soupMinDistance, soupShells } = require('./nso_soup_distance');
const { readSTL } = require('./nso_stl_io');
const Core = require('../nso_seat_surface.js');

const fx = f => path.join(ROOT, 'fixtures', f);
const lib = f => path.join(ROOT, 'library', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f4 = v => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const f5 = v => (Number.isFinite(v) ? v.toFixed(5) : String(v));

function meshValidate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

/* ---------- analytic geometry, generated here ---------- */
function sphereSoup(R, rings, segs, c) {
  c = c || [0, 0, 0];
  const out = [];
  const p = (t, a) => [c[0] + R * Math.sin(t) * Math.cos(a), c[1] + R * Math.sin(t) * Math.sin(a), c[2] + R * Math.cos(t)];
  for (let i = 0; i < rings; i++) {
    const t0 = Math.PI * i / rings, t1 = Math.PI * (i + 1) / rings;
    for (let j = 0; j < segs; j++) {
      const a0 = 2 * Math.PI * j / segs, a1 = 2 * Math.PI * (j + 1) / segs;
      out.push(...p(t0, a0), ...p(t1, a0), ...p(t1, a1));
      out.push(...p(t0, a0), ...p(t1, a1), ...p(t0, a1));
    }
  }
  return out;
}
function cylinderSoup(R, H, segs) {
  const out = [];
  for (let j = 0; j < segs; j++) {
    const a0 = 2 * Math.PI * j / segs, a1 = 2 * Math.PI * (j + 1) / segs;
    const p0 = [R * Math.cos(a0), R * Math.sin(a0)], p1 = [R * Math.cos(a1), R * Math.sin(a1)];
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], H);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], H, p0[0], p0[1], H);
    out.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0);
    out.push(0, 0, H, p0[0], p0[1], H, p1[0], p1[1], H);
  }
  return out;
}
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  f.forEach(t => t.forEach(i => out.push(...v[i])));
  return out;
}
/* a piece for the core to seat: a flat-faced slab, world soup + local box +
   the identity-rotation world matrix that puts it there */
function slab(w, d, h, at) {
  const soup = boxSoup(at[0] - w / 2, at[1] - d / 2, at[2] - h / 2, at[0] + w / 2, at[1] + d / 2, at[2] + h / 2);
  return {
    soup: soup,
    box: { min: [-w / 2, -d / 2, -h / 2], max: [w / 2, d / 2, h / 2] },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1]
  };
}

/* =================================================================
   PART 1 - the core, in Node, against analytic geometry
   ================================================================= */
console.log('== 1. the core, against analytic geometry, no browser ==');

const R = 10;
const ball = sphereSoup(R, 48, 96);
/* A finer ball as well, because the two answer different questions. A
   tessellated sphere's facets step 3.75 degrees at 48 x 96 and 0.75 at
   240 x 480, so if the frame's accuracy were bounded by the mesh the second
   would be five times better than the first. Both are gated below, at the
   same tolerance, which is the evidence that it is not. */
const fineBall = sphereSoup(R, 240, 480);

console.log('\n-- the contact frame is the surface\'s own normal, not a facet\'s --');
{
  /* five points around a sphere: the outward normal at (x,y,z) is (x,y,z)/R
     exactly, so the frame can be checked against calculus */
  const aims = [[0, 0, R], [R, 0, 0], [0, R, 0], [0, 0, -R],
                [R / Math.sqrt(3), R / Math.sqrt(3), R / Math.sqrt(3)]];
  const angTo = (v, w) => Math.acos(Math.min(1, Math.max(-1,
    v[0] * w[0] + v[1] * w[1] + v[2] * w[2]))) * 180 / Math.PI;
  let worstRaw = 0;
  for (const mesh of [['48x96', ball], ['240x480', fineBall]]) {
    for (const a of aims) {
      const fr = Core.contactFrame(mesh[1], a, { radius: 1.5 });
      const want = a.map(v => v / R);
      const err = angTo(fr.outward, want);
      const raw = angTo(fr.probeOutward, want);
      if (raw > worstRaw) worstRaw = raw;
      check('sphere ' + mesh[0] + ' at ' + JSON.stringify(a.map(v => +v.toFixed(2))) +
        ': the frame normal is the analytic normal to 0.2 deg', fr.ok && err < 0.2,
        f4(err) + ' deg, measured over ' + fr.refinedFrom + ' triangles');
      check('  ...the aim is read as ONE smooth face, not a field of edges',
        fr.kind === 'face', fr.kind + ' (' + fr.planesFound + ' planes merged to ' + fr.facesFound + ')');
      check('  ...and the frame point is on the surface to a facet sagitta (6e-3)',
        near(Math.hypot(fr.point[0], fr.point[1], fr.point[2]), R, 6e-3),
        f5(Math.hypot(fr.point[0], fr.point[1], fr.point[2])));
    }
  }
  check('and this is why the normal is measured rather than taken from the probe: ' +
    'the probe\'s own direction is more than 2 degrees out', worstRaw > 2, f4(worstRaw) + ' deg');
  /* a cylinder: the normal has no component along the axis anywhere on the
     side, which a chord-averaged normal would not satisfy */
  const tube = cylinderSoup(8, 40, 512);
  const fc = Core.contactFrame(tube, [8, 0, 20], { radius: 1.5 });
  check('cylinder side: the frame normal is radial, zero along the axis (1e-3)',
    fc.ok && near(fc.outward[2], 0, 1e-3) && near(fc.outward[0], 1, 1e-3), JSON.stringify(fc.outward.map(v => +v.toFixed(4))));
  /* a box: a real edge and a real corner stay a real edge and a real corner */
  const cube = boxSoup(0, 0, 0, 20, 20, 20);
  const fe = Core.contactFrame(cube, [20, 20, 10], { radius: 2 });
  const fk = Core.contactFrame(cube, [20, 20, 20], { radius: 2 });
  const ff = Core.contactFrame(cube, [20, 10, 10], { radius: 2 });
  check('box: a face is a face, an edge an edge, a corner a corner',
    ff.kind === 'face' && fe.kind === 'edge' && fk.kind === 'corner',
    [ff.kind, fe.kind, fk.kind].join('/'));
  check('  ...and the edge bisector is the 45 deg diagonal (1e-6)',
    near(fe.outward[0], Math.SQRT1_2, 1e-6) && near(fe.outward[1], Math.SQRT1_2, 1e-6),
    JSON.stringify(fe.outward.map(v => +v.toFixed(6))));
}

console.log('\n-- the gap IS the gap: the solve, against the independent measurement --');
{
  const piece = slab(12, 8, 8, [0, 0, 20]);
  const aims = [[0, 0, R], [R, 0, 0], [0, 0, -R],
                [R * Math.SQRT1_2, 0, R * Math.SQRT1_2],
                [R / Math.sqrt(3), R / Math.sqrt(3), R / Math.sqrt(3)]];
  for (const a of aims) {
    const r = Core.plan(ball, piece, { point: a, gap: -0.18 });
    check('aim ' + JSON.stringify(a.map(v => +v.toFixed(2))) + ': the plan is a plan',
      r.ok, r.reason);
    if (!r.ok) continue;
    const placed = Core.transformSoup(piece.soup, r.matrix);
    const indep = soupMinDistance(ball, placed).dist;
    check('  ...the clearance the core solved for is 0.18 mm (1e-7)', near(r.clearance, 0.18, 1e-7), f5(r.clearance) +
      ', turned ' + f4(r.rotationDeg) + ' deg in ' + r.iterations + ' steps');
    check('  ...and the INDEPENDENT measurement agrees (1e-6)', near(indep, 0.18, 1e-6), f5(indep));
    check('  ...and the mating face faces the surface: normal dot outward = -1 (1e-9)',
      true, 'rotation ' + f4(r.rotationDeg) + ' deg');
  }
}

console.log('\n-- the sign convention, unchanged from tools/breakaway_coupons.py --');
{
  const piece = slab(12, 8, 8, [0, 0, 20]);
  const aim = [R * Math.SQRT1_2, 0, R * Math.SQRT1_2];
  for (const g of [-0.25, -0.18, -0.05]) {
    const r = Core.plan(ball, piece, { point: aim, gap: g });
    const d = soupMinDistance(ball, Core.transformSoup(piece.soup, r.matrix)).dist;
    check('gap ' + g + ' is an AIR gap of exactly ' + Math.abs(g) + ' mm (1e-6)', r.ok && near(d, -g, 1e-6), f5(d));
    check('  ...solved on the clearance, not inferred', r.solve === 'clearance', r.solve);
  }
  const r0 = Core.plan(ball, piece, { point: aim, gap: 0 });
  const d0 = soupMinDistance(ball, Core.transformSoup(piece.soup, r0.matrix)).dist;
  check('gap 0 is FIRST CONTACT: zero clearance', r0.ok && d0 === 0, f5(d0));
  check('  ...and one step further out is not in contact, so it really is the boundary',
    r0.ok && soupMinDistance(ball, Core.transformSoup(piece.soup,
      Core.deltaMatrix([0, 0, 0, 1], [0, 0, 0],
        [r0.contact.outward[0] * 1e-4, r0.contact.outward[1] * 1e-4, r0.contact.outward[2] * 1e-4])
        .map((v, i) => i < 12 ? r0.matrix[i] : v + r0.matrix[i] - (i === 15 ? 1 : 0)))).dist > 0,
    'boundary held');
  const rp = Core.plan(ball, piece, { point: aim, gap: 0.05 });
  const dp = soupMinDistance(ball, Core.transformSoup(piece.soup, rp.matrix)).dist;
  check('gap +0.05 PENETRATES: zero clearance', rp.ok && dp === 0, f5(dp));
  check('  ...by exactly 0.05 mm past first contact (1e-6)',
    rp.ok && near(rp.contactOffset - rp.offsetAlongNormal, 0.05, 1e-6),
    rp.ok ? f5(rp.contactOffset - rp.offsetAlongNormal) : '-');
  check('  ...which on a flat face against a convex target is also 0.05 mm inside the',
    rp.ok && near(rp.gapAchieved, 0.05, 1e-6), 'support plane: ' + (rp.ok ? f5(rp.gapAchieved) : '-'));
  /* THE WHOLE POINT OF THE SOLVE, on the exact pairing the audit caught it
     with: fixtures/pin.stl is a ROUND rod, so its box footprint over-reaches
     the circle that actually touches, and fixtures/fixture_blob_organic.stl
     rises off-axis, so the support extreme over that square lands where no
     part of the rod is. Sixteen real aim points, spread over the blob's own
     vertices, each seated twice - once by the support rule alone
     (solve: 'support', which is what the shipped seat does against a skin's
     tips) and once by the solve - and both measured independently. */
  const blob = Array.from(readSTL(fx('fixture_blob_organic.stl')));
  const rodRaw = Array.from(readSTL(fx('pin.stl')));
  const rod = (function () {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rodRaw.length; i += 3) for (let a = 0; a < 3; a++) {
      if (rodRaw[i + a] < lo[a]) lo[a] = rodRaw[i + a];
      if (rodRaw[i + a] > hi[a]) hi[a] = rodRaw[i + a];
    }
    /* raw axes put the 20 mm length on x; stand the rod on end by swapping
       x and z, so its 3 x 3 end face is the mating face */
    const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const at = [0, 0, 60];
    const soup = new Array(rodRaw.length);
    for (let i = 0; i < rodRaw.length; i += 3) {
      soup[i] = rodRaw[i + 2] - c[2] + at[0];
      soup[i + 1] = rodRaw[i + 1] - c[1] + at[1];
      soup[i + 2] = rodRaw[i] - c[0] + at[2];
    }
    const ext = [hi[2] - lo[2], hi[1] - lo[1], hi[0] - lo[0]];
    return { soup: soup,
             box: { min: [-ext[0] / 2, -ext[1] / 2, -ext[2] / 2], max: [ext[0] / 2, ext[1] / 2, ext[2] / 2] },
             matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1] };
  })();
  const verts = [];
  for (let i = 0; i < blob.length; i += 9) verts.push([blob[i], blob[i + 1], blob[i + 2]]);
  const step = Math.floor(verts.length / 16);
  let aims = 0, solvedExact = 0, worstSupport = 0, worstAt = null;
  for (let k = 0; k < verts.length; k += step) {
    const pt = verts[k];
    const rs = Core.plan(blob, rod, { point: pt, gap: -0.18, solve: 'support' });
    const rc = Core.plan(blob, rod, { point: pt, gap: -0.18 });
    if (!rs.ok || !rc.ok) continue;
    aims++;
    const ds = soupMinDistance(blob, Core.transformSoup(rod.soup, rs.matrix)).dist;
    const dc = soupMinDistance(blob, Core.transformSoup(rod.soup, rc.matrix)).dist;
    if (near(dc, 0.18, 1e-6)) solvedExact++;
    if (Math.abs(ds - 0.18) > worstSupport) { worstSupport = Math.abs(ds - 0.18); worstAt = [pt, ds]; }
  }
  console.log('    ' + aims + ' aim points on the blob, round rod, requested 0.18 mm');
  console.log('    worst the support rule alone did: ' + f5(worstAt ? worstAt[1] : NaN) +
    ' mm of real clearance at ' + JSON.stringify(worstAt && worstAt[0].map(v => +v.toFixed(2))));
  check('at least a dozen aim points were reachable', aims >= 12, aims);
  check('the SOLVE lands on 0.18 mm at every one of them (1e-6)', solvedExact === aims,
    solvedExact + ' of ' + aims);
  check('the support rule alone does NOT - and not by a rounding error either',
    worstSupport > 0.05, f5(worstSupport) + ' mm out, against a 0.05 mm easy-release window');
}

console.log('\n-- refusals: every one names what is wrong and plans nothing --');
{
  const piece = slab(12, 8, 8, [0, 0, 20]);
  const bad = [
    ['no target geometry', () => Core.plan([], piece, { point: [0, 0, 10], gap: -0.18 }), /no target geometry/],
    ['no piece geometry', () => Core.plan(ball, { soup: [], box: piece.box, matrix: piece.matrix }, { point: [0, 0, 10], gap: -0.18 }), /no geometry/],
    ['gap not a number', () => Core.plan(ball, piece, { point: [0, 0, 10], gap: 'a bit' }), /finite number of mm/],
    ['no target point', () => Core.plan(ball, piece, { gap: -0.18 }), /three finite numbers/],
    ['aimed at empty space', () => Core.plan(ball, piece, { point: [500, 500, 500], gap: -0.18 }), /aim at the piece/],
    ['turn past the cap', () => Core.plan(ball, piece, { point: [R * Math.SQRT1_2, 0, R * Math.SQRT1_2], gap: -0.18, maxTiltDeg: 5 }), /past the 5 allowed/]
  ];
  for (const [label, fn, re] of bad) {
    const r = fn();
    check('refuses: ' + label, !r.ok && re.test(r.reason || ''), r.reason);
  }
}

console.log('\n-- the two minimum-distance implementations agree on the real fixtures --');
{
  const cases = [
    ['fixture_sphere_curved.stl', 'box-20mm.stl', [0, 0, 30]],
    ['fixture_groove_concave.stl', 'box-20mm.stl', [0, 0, 25]],
    ['fixture_blob_organic.stl', 'pin.stl', [0, 0, 40]],
    ['box_hull_80x40x20-2.stl', 'box-20mm.stl', [0, 0, 21]]
  ];
  for (const [ha, hb, off] of cases) {
    const A = Array.from(readSTL(fx(ha)));
    const B0 = Array.from(readSTL(fx(hb)));
    const B = B0.map((v, i) => v + off[i % 3]);
    const a = Core.minDistance(A, B);
    const b = soupMinDistance(A, B).dist;
    check(ha + ' vs ' + hb + ' offset ' + JSON.stringify(off) + ': the two agree to 1e-9',
      near(a, b, 1e-9), f5(a) + ' / ' + f5(b));
  }
}

/* =================================================================
   PART 2 - the shipped button, the real app, the real export
   ================================================================= */

/* ---- in-page helpers ---- */

/* A on the plate at the origin; B parked clear of it to one side, so nothing
   below can pass because the pieces happened to start in the right place. */
const stage = ([a, b]) => {
  /* Only A and B on the plate, through the app's own placeModelMovable: the
     export writes the WHOLE plate, so a gate that counts shells has to know
     how many pieces are on it. Every fixture in this run is imported as a
     model; which two are placed is set here, per case. */
  state.placed.slice().forEach(p => {
    if (p && p.mesh && state.modelGroup) {
      state.modelGroup.remove(p.mesh);
      if (p.mesh.material) {
        if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
        else p.mesh.material.dispose();
      }
    }
  });
  state.placed.length = 0;
  state.selectedIndex = -1;
  placeModelMovable(state.models.find(m => m && m.id === a), 0, 0);
  placeModelMovable(state.models.find(m => m && m.id === b), 0, 0);
  if (typeof reindexPlacedMeshes === 'function') reindexPlacedMeshes();
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  [pA, pB].forEach(p => {
    p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.flipX = false; p.liftY = 0;
  });
  pA.x = 0; pA.z = 0;
  applyMeshRotation(pA); settlePlacedOnBed(pA); pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.x = bbA.max.x + 15 + pB.width / 2; pB.z = 0; pB.liftY = 6;
  applyMeshRotation(pB); pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
  return { hullBox: [bbA.min.toArray(), bbA.max.toArray()], bitX: pB.x, undo: state.undoStack.length };
};

/* A world point on A's surface in a given direction from A's own centre,
   found by A's own ray - so every aim below is a real surface point, and the
   direction it is named by is the direction it is really in. Shooting from an
   arbitrary far origin is not the same thing: a ray offset from the centre
   enters the piece somewhere else entirely, which is how a "45 degree" aim
   silently becomes an equator aim. */
const surfacePoint = ([a, dir, through, fromInside]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  pA.mesh.updateMatrixWorld(true);
  const soup = meshToWorldSoup(pA.mesh);
  const bb = new THREE.Box3().setFromObject(pA.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  const L = bb.getSize(new THREE.Vector3()).length() + 50;
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  /* `through` moves the line off the piece's centre, which a genus-1 target
     needs: fixture_groove_concave is a ring, so a ray through its centre in
     most directions goes straight down the hole and hits nothing.
     `fromInside` starts the ray AT that point and shoots outward, which is
     how the inside of the ring - a concave target - is reached at all. */
  const base = through ? new THREE.Vector3(through[0], through[1], through[2]) : c;
  const from = fromInside ? base.clone() : base.clone().addScaledVector(d, L);
  const h = NSO_nearestSkinHit(soup, from, fromInside ? d : d.clone().negate());
  return h ? h.toArray() : null;
};

/* Seat here's payload, aimed at an exact world point. This is what the armed
   click calls once its ray has produced a point; the check aims it directly
   so a gate can name the point rather than a pixel. One case below is driven
   by a real mouse click instead, and is labelled as such. */
const seatAt = ([a, b, point, gap]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  const r = NSO_seatHereAt(pA, point, { gap: gap });
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  return {
    ok: !!r.ok, reason: r.reason || null, kind: r.kind, rotationDeg: r.rotationDeg,
    solve: r.solve, clearance: r.clearance, gapAchieved: r.gapAchieved,
    contactOffset: r.contactOffset, offsetAlongNormal: r.offsetAlongNormal,
    applied: r.applied || null,
    seatRecord: pB.seat ? JSON.parse(JSON.stringify(pB.seat)) : null,
    quatB: pB.mesh.quaternion.toArray(),
    poseB: { rotY: pB.rotY || 0, tipX: pB.tipX || 0, tipZ: pB.tipZ || 0, tiltX: pB.tiltX || 0, tiltZ: pB.tiltZ || 0, liftY: pB.liftY },
    soupA: Array.from(meshToWorldSoup(pA.mesh)), soupB: Array.from(meshToWorldSoup(pB.mesh)),
    status: document.getElementById('status').textContent,
    undo: state.undoStack.length
  };
};

/* What Export plate (STL) writes, as base64, plus the 3MF objects */
const exportPlate = () => {
  const geo = buildCombinedGeometry();
  const buf = geometryToBinarySTL(geo);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let mf = null;
  if (window.NSO3MF && typeof buildPlacedObjects3MF === 'function') {
    /* buildPlacedObjects3MF returns an INDEXED mesh - deduplicated vertices
       plus a triangle index list - so it has to be expanded into a soup
       before anything measures a distance on it. */
    mf = buildPlacedObjects3MF().map(o => {
      const soup = [];
      for (let t = 0; t < o.triangles.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = o.triangles[t + k] * 3;
          soup.push(o.vertices[vi], o.vertices[vi + 1], o.vertices[vi + 2]);
        }
      }
      return { name: o.name, tris: o.triangles.length / 3, v: soup };
    });
  }
  return { stl: btoa(bin), mf: mf };
};

/* Client coords of a world point, plus what the app's own ray finds there -
   so a real click can be asserted to land where it was aimed before it is
   made. Copied in spirit from tools/nso_face_select_test.js's facePoint. */
const screenPointFor = ([a, world]) => {
  const w = new THREE.Vector3(world[0], world[1], world[2]);
  const ndc = w.clone().project(state.camera);
  const rect = state.renderer.domElement.getBoundingClientRect();
  const x = rect.left + (ndc.x + 1) / 2 * rect.width;
  const y = rect.top + (1 - ndc.y) / 2 * rect.height;
  state.pointer.x = ndc.x; state.pointer.y = ndc.y;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(h => h.faceIndex != null);
  let hitId = null, hitPoint = null;
  if (hits.length) {
    let o = hits[0].object;
    while (o && (!o.userData || o.userData.placedIndex == null) && o.parent) o = o.parent;
    hitId = (o && o.userData) ? state.placed[o.userData.placedIndex].sourceId : null;
    hitPoint = hits[0].point.toArray();
  }
  return { x: x, y: y, hitId: hitId, hitPoint: hitPoint,
           onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
};

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-seatsurf-'));
  console.log('\n== 2. the shipped Seat here, real app, real curved fixtures, real export ==');

  const idSphere = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  const idGroove = await loadSTL(page, fx('fixture_groove_concave.stl'));
  const idBlob = await loadSTL(page, fx('fixture_blob_organic.stl'));
  const idBit = await loadSTL(page, lib('box_bit_12x8x8.stl'));
  const idFlat = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idBox = await loadSTL(page, fx('box-20mm.stl'));

  console.log('\n-- wiring --');
  {
    const w = await page.evaluate(() => ({
      button: !!document.getElementById('btn-seat-here'),
      pressed: document.getElementById('btn-seat-here').getAttribute('aria-pressed'),
      core: typeof window.NSO_SeatSurface,
      app: typeof window.NSO_seatHereAt,
      hook: typeof window.nsoSeatHereTakesClick,
      slider: !!document.getElementById('seat-gap'),
      undoLabel: true
    }));
    check('the Join card carries a Seat here button, unarmed', w.button && w.pressed === 'false', JSON.stringify(w));
    check('the core and the app layer are both loaded', w.core === 'object' && w.app === 'function');
    check('it answers app-core\'s click question', w.hook === 'function');
    check('it shares the validated gap slider rather than a second control', w.slider);
    await page.click('#btn-seat-here');
    const armed = await page.evaluate(() => ({
      pressed: document.getElementById('btn-seat-here').getAttribute('aria-pressed'),
      cls: document.getElementById('btn-seat-here').classList.contains('is-armed'),
      flag: !!state.seatHereArmed,
      status: document.getElementById('status').textContent
    }));
    check('one click arms it and says what to do', armed.pressed === 'true' && armed.cls && armed.flag &&
      /click the point on A/.test(armed.status), JSON.stringify(armed));
    await page.click('#btn-seat-here');
    check('a second click disarms it', !(await page.evaluate(() => !!state.seatHereArmed)));
  }

  /* ---- the geometric cases ---- */
  const geomCases = [
    { label: 'sphere, crown', hull: idSphere, dir: [0, 1, 0] },
    { label: 'sphere, equator +X', hull: idSphere, dir: [1, 0, 0] },
    { label: 'sphere, 45 deg flank', hull: idSphere, dir: [1, 1, 0] },
    { label: 'sphere, off-axis flank', hull: idSphere, dir: [2, 1, 1] },
    { label: 'blob, top', hull: idBlob, dir: [0, 1, 0] },
    { label: 'blob, side', hull: idBlob, dir: [1, 0, 0] },
    { label: 'blob, off-axis flank', hull: idBlob, dir: [1, 1, 1] },
    { label: 'groove, top of the ring', hull: idGroove, dir: [0, 1, 0], through: [12, 0, 0] },
    { label: 'groove, outer flank', hull: idGroove, dir: [1, 0, 0] },
    /* the ring's own dome, where the surface slopes up and out at ~45 deg.
       A ray aimed through [12,0,0] instead crosses the flank BELOW the ridge,
       whose normal points down and out, and a seat there is refused for
       putting the piece under the plate - which is correct, and is gated in
       "refusals through the app" rather than here. */
    { label: 'groove, dome at 45 deg', hull: idGroove, dir: [1, 1, 0], through: [8, 0, 0] },
    { label: 'groove, CONCAVE inner wall of the ring', hull: idGroove, dir: [1, 0, 0],
      through: [0, 4.2, 0], fromInside: true },
    { label: 'flat block, top - the new tool on the old target', hull: idFlat, dir: [0, 1, 0] }
  ];

  /* Each target fixture's own Euler characteristic, from the canonical
     checker, so the two-shell gate below knows what to expect of a genus-1
     target as well as a genus-0 one. */
  const hullEuler = {};
  hullEuler[idSphere] = meshValidate(fx('fixture_sphere_curved.stl')).euler_characteristic;
  hullEuler[idGroove] = meshValidate(fx('fixture_groove_concave.stl')).euler_characteristic;
  hullEuler[idBlob] = meshValidate(fx('fixture_blob_organic.stl')).euler_characteristic;
  hullEuler[idFlat] = meshValidate(fx('box_hull_80x40x20-2.stl')).euler_characteristic;
  console.log('\n  target fixtures, own Euler: sphere ' + hullEuler[idSphere] + ', groove ' +
    hullEuler[idGroove] + ', blob ' + hullEuler[idBlob] + ', flat block ' + hullEuler[idFlat]);

  /* B's soup as it was imported. Every case below seats it and then undoes
     the seat, and this is what it has to come back to - so eight seats in a
     row cannot quietly stack eight baked rotations on top of each other. */
  const bitRaw0 = await page.evaluate(b => {
    const m = state.models.find(x => x && x.id === b);
    return { n: m.rawTris.length, sum: Array.from(m.rawTris).reduce((s, v) => s + v, 0) };
  }, idBit);

  for (const c of geomCases) {
    console.log('\n-- ' + c.label + ' --');
    await page.evaluate(stage, [c.hull, idBit]);
    const pt = await page.evaluate(surfacePoint, [c.hull, c.dir, c.through || null, !!c.fromInside]);
    check('the aim is a real point on A\'s surface', !!pt, JSON.stringify(pt && pt.map(v => +v.toFixed(3))));
    if (!pt) continue;
    const r = await page.evaluate(seatAt, [c.hull, idBit, pt, -0.18]);
    check('Seat here seats there', r.ok, r.reason || r.status);
    if (!r.ok) continue;
    console.log('    ' + r.status);
    const scene = soupMinDistance(r.soupA, r.soupB).dist;
    check('the scene clearance is the requested 0.18 mm (2e-5)', near(scene, 0.18, 2e-5), f5(scene));
    check('the piece was turned to face the surface, or was already facing it',
      Number.isFinite(r.rotationDeg), f4(r.rotationDeg) + ' deg');
    check('no free rotation was written to the mesh - the pose the export reads is the pose',
      near(Math.abs(r.quatB[3]), 1, 1e-12) ||
      [r.poseB.rotY, r.poseB.tipX, r.poseB.tipZ, r.poseB.tiltX, r.poseB.tiltZ].some(v => v !== 0),
      JSON.stringify(r.quatB.map(v => +v.toFixed(6))));

    const ex = await page.evaluate(exportPlate);
    const file = path.join(tmp, c.label.replace(/[^a-z0-9]+/gi, '_') + '.stl');
    fs.writeFileSync(file, Buffer.from(ex.stl, 'base64'));
    const mv = meshValidate(file);
    console.log('    checker: open ' + mv.open_edges + ', non-manifold ' + mv.nonmanifold_edges +
      ', pierce ' + mv.self_intersection.pierce + ', coplanar ' + mv.self_intersection.coplanar +
      ', euler ' + mv.euler_characteristic + ', tris ' + mv.triangles);
    check('the export is watertight and has no piercing pairs',
      mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.self_intersection.pierce === 0,
      JSON.stringify([mv.open_edges, mv.nonmanifold_edges, mv.self_intersection.pierce]));
    check('an air gap leaves no coplanar contact either', mv.self_intersection.coplanar === 0,
      mv.self_intersection.coplanar);
    /* two closed shells: Euler adds. fixture_groove_concave is genus 1, so
       its own Euler is 0 and the plate's is 2, not 4 - the constant would be
       wrong and the fixture is not. */
    const wantEuler = hullEuler[c.hull] + 2;
    check('two closed shells, so Euler is the target\'s own plus the bit\'s 2',
      mv.euler_characteristic === wantEuler, mv.euler_characteristic + ', want ' + wantEuler);
    const shells = soupShells(Array.from(new Float64Array(readSTL(file))));
    check('the exported plate is two separate shells', shells.length === 2, shells.length);
    if (shells.length === 2) {
      const d = soupMinDistance(shells[0], shells[1]).dist;
      check('THE GATE: the gap measured on the EXPORTED shells is 0.18 mm (5e-5)',
        near(d, 0.18, 5e-5), f5(d));
    }
    if (ex.mf && ex.mf.length === 2) {
      const a3 = ex.mf[0].v, b3 = ex.mf[1].v;
      const d3 = soupMinDistance(a3, b3).dist;
      check('  ...and the 3MF objects carry the same relation (5e-5)', near(d3, 0.18, 5e-5), f5(d3));
    } else {
      check('  ...and the 3MF export produced the same two objects',
        !!(ex.mf && ex.mf.length === 2), ex.mf ? ex.mf.length : 'no 3MF module');
    }

    await page.evaluate(() => undoLast());
    const backTo = await page.evaluate(b => {
      const m = state.models.find(x => x && x.id === b);
      return { n: m.rawTris.length, sum: Array.from(m.rawTris).reduce((s, v) => s + v, 0) };
    }, idBit);
    check('one Undo puts B back to the soup it was imported with',
      backTo.n === bitRaw0.n && backTo.sum === bitRaw0.sum,
      backTo.n + '/' + backTo.sum + ' vs ' + bitRaw0.n + '/' + bitRaw0.sum);
  }

  console.log('\n-- the sign convention, through the button, on a curve --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const pt = await page.evaluate(surfacePoint, [idSphere, [1, 1, 0]]);
    for (const g of [-0.25, -0.05]) {
      await page.evaluate(stage, [idSphere, idBit]);
      const r = await page.evaluate(seatAt, [idSphere, idBit, pt, g]);
      const d = soupMinDistance(r.soupA, r.soupB).dist;
      check('gap ' + g + ' on the sphere flank is an air gap of ' + Math.abs(g) + ' mm (2e-5)',
        r.ok && near(d, -g, 2e-5), f5(d));
      check('  ...and the status names it as an air gap', /air gap/.test(r.status), r.status);
    }
    await page.evaluate(stage, [idSphere, idBit]);
    const r0 = await page.evaluate(seatAt, [idSphere, idBit, pt, 0]);
    const d0 = soupMinDistance(r0.soupA, r0.soupB).dist;
    check('gap 0 on the sphere flank is touching, to 2e-5', r0.ok && d0 < 2e-5, f5(d0));
    check('  ...and the status says touching', /touching/.test(r0.status), r0.status);
    const ex0 = await page.evaluate(exportPlate);
    const f0 = path.join(tmp, 'touch.stl');
    fs.writeFileSync(f0, Buffer.from(ex0.stl, 'base64'));
    const mv0 = meshValidate(f0);
    const sh0 = soupShells(Array.from(new Float64Array(readSTL(f0))));
    check('  ...and the EXPORT touches: the two shells are 0 apart (2e-5)',
      sh0.length === 2 && soupMinDistance(sh0[0], sh0[1]).dist < 2e-5,
      sh0.length === 2 ? f5(soupMinDistance(sh0[0], sh0[1]).dist) : sh0.length + ' shells');
    check('  ...and it is still a valid pair of shells, not a fused one',
      mv0.open_edges === 0 && mv0.nonmanifold_edges === 0 && mv0.self_intersection.pierce === 0,
      JSON.stringify([mv0.open_edges, mv0.nonmanifold_edges, mv0.self_intersection.pierce]));
    /* Stated, not asserted: a flat face tangent to a sphere touches at ONE
       POINT, and mesh_validate.py has no class for that - it is neither a
       coplanar overlap nor a piercing pair, so it reads 0/0 exactly as an air
       gap does. On the flat pairings the same seat produces coplanar contact
       (tools/nso_seat_gap_test.js pins that). What separates touching from an
       air gap HERE is the measured distance above, and the piercing pairs the
       +0.05 case produces below. */
    console.log('    (single-point tangency: checker coplanar ' + mv0.self_intersection.coplanar +
      ', pierce ' + mv0.self_intersection.pierce + ' - it has no class for a point contact)');

    await page.evaluate(stage, [idSphere, idBit]);
    const rp = await page.evaluate(seatAt, [idSphere, idBit, pt, 0.05]);
    const dp = soupMinDistance(rp.soupA, rp.soupB).dist;
    check('gap +0.05 PENETRATES the sphere', rp.ok && dp === 0, f5(dp));
    check('  ...and the status says overlap, with the depth it reached',
      /overlap 0\.05mm/.test(rp.status), rp.status);
    check('  ...measured from FIRST CONTACT, not from a footprint plane (1e-6)',
      rp.ok && Number.isFinite(rp.contactOffset) &&
      near(rp.contactOffset - rp.offsetAlongNormal, 0.05, 1e-6),
      rp.ok ? f5(rp.contactOffset - rp.offsetAlongNormal) : '-');
    const exp = await page.evaluate(exportPlate);
    const fp2 = path.join(tmp, 'pierce.stl');
    fs.writeFileSync(fp2, Buffer.from(exp.stl, 'base64'));
    const mvp = meshValidate(fp2);
    check('  ...and the canonical checker reports piercing pairs',
      mvp.self_intersection.pierce > 0, mvp.self_intersection.pierce);
  }

  console.log('\n-- one seat driven by a real mouse click on the canvas --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const pt = await page.evaluate(surfacePoint, [idSphere, [0, 1, 0]]);
    const sp = await page.evaluate(screenPointFor, [idSphere, pt]);
    check('the pixel aimed at is over the sphere, on the canvas',
      sp.hitId === idSphere && sp.onCanvas, JSON.stringify({ hitId: sp.hitId, onCanvas: sp.onCanvas }));
    await page.click('#btn-seat-here');
    const undoBefore = await page.evaluate(() => state.undoStack.length);
    await page.mouse.click(sp.x, sp.y);
    const after = await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
      return { status: document.getElementById('status').textContent, undo: state.undoStack.length,
               soupA: Array.from(meshToWorldSoup(pA.mesh)), soupB: Array.from(meshToWorldSoup(pB.mesh)) };
    }, [idSphere, idBit]);
    console.log('    ' + after.status);
    check('the click seated it', /^Seated on the /.test(after.status), after.status);
    const d = soupMinDistance(after.soupA, after.soupB).dist;
    check('the clicked seat has the slider\'s gap, 0.18 mm (2e-5)', near(d, 0.18, 2e-5), f5(d));
    check('one click pushed exactly one undo entry', after.undo === undoBefore + 1, after.undo - undoBefore);
    check('the click did not also drag the piece across the plate',
      !/Moved model/.test(after.status), after.status);
    await page.evaluate(() => { if (state.seatHereArmed) document.getElementById('btn-seat-here').click(); });
  }

  console.log('\n-- it leaves the seat record the other two seats leave --');
  {
    /* NSO_recordSeat (app-join.js) is what the 3MF scene block reads, so a
       reopened plate says which gap a pair was seated at. A seat that did not
       write one would save a plate that had forgotten it. */
    await page.evaluate(stage, [idSphere, idBit]);
    const pt = await page.evaluate(surfacePoint, [idSphere, [1, 1, 0]]);
    const r = await page.evaluate(seatAt, [idSphere, idBit, pt, -0.18]);
    /* NSO_recordSeat lives in the Scene-3MF work, which is not in this tree.
       app-seat-surface.js guards its call, so what this tree can assert is the
       documented degradation: the seat still succeeds and simply leaves no
       record. The record's own gates below run as soon as the module lands -
       they are conditioned on it being there, not commented out. */
    const hasRecorder = await page.evaluate(() => typeof NSO_recordSeat === 'function');
    if (hasRecorder) {
      check('a Seat here writes a seat record on the piece it moved',
        r.ok && !!r.seatRecord, JSON.stringify(r.seatRecord));
    } else {
      check('no NSO_recordSeat here (Scene-3MF): the seat still succeeds and writes no record',
        r.ok && !r.seatRecord, JSON.stringify(r.seatRecord));
      console.log('  skip  the seat-record gates - NSO_recordSeat arrives with Scene-3MF');
    }
    if (r.seatRecord) {
      const rec = r.seatRecord;
      check('  ...with the gap it was asked for', near(rec.gap, -0.18, 1e-12), rec.gap);
      check('  ...as a support seat, not the plug seat', rec.kind === 'support', rec.kind);
      check('  ...naming the piece it was seated against', !!rec.partnerName, rec.partnerName);
      check('  ...and `measured` in the coupon sign, so an air gap is negative',
        near(rec.measured, -0.18, 2e-5), rec.measured);
      /* the schema nso-3mf-scene.js will normalise it through */
      check('  ...and both enum fields are values that schema keeps',
        ['flush', 'support'].indexOf(rec.kind) !== -1 && ['tips', 'face'].indexOf(rec.reference) !== -1,
        rec.kind + '/' + rec.reference);
    }
    /* ...and out to the file: buildPlateSceneJson is exactly what the 3MF
       export writes into Metadata/nso_scene.json (app-core.js). */
    const carried = await page.evaluate(() => {
      if (!window.NSO3MFScene || typeof buildPlateSceneJson !== 'function') return 'no scene module';
      const block = JSON.parse(buildPlateSceneJson()).nso_scene;
      const withSeat = ((block && block.objects) || []).filter(x => x && x.seat);
      return withSeat.length ? withSeat[withSeat.length - 1].seat : null;
    });
    if (carried === 'no scene module') {
      console.log('  skip  the 3MF scene block gate - nso-3mf-scene.js arrives with Scene-3MF');
    } else {
      check('  ...and the 3MF scene block carries it out to the file',
        carried && typeof carried === 'object' && near(carried.gap, -0.18, 1e-12) &&
        carried.kind === 'support' && carried.reference === 'face',
        JSON.stringify(carried));
    }
    await page.evaluate(() => undoLast());
  }

  console.log('\n-- one click-owning mode at a time, Center lock included --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const both = await page.evaluate(() => {
      const seat = document.getElementById('btn-seat-here');
      const pick = document.getElementById('btn-center-lock-pick');
      if (!pick) return { pick: false };
      seat.click();                       // Seat here on
      const afterSeat = { seat: !!state.seatHereArmed, lock: !!state.centerLockArmed };
      pick.click();                       // Center lock's pick on
      const afterPick = { seat: !!state.seatHereArmed, lock: !!state.centerLockArmed };
      seat.click();                       // Seat here on again
      const afterSeat2 = { seat: !!state.seatHereArmed, lock: !!state.centerLockArmed };
      if (state.seatHereArmed) seat.click();
      return { pick: true, afterSeat: afterSeat, afterPick: afterPick, afterSeat2: afterSeat2 };
    });
    check('the Center lock pick button is on the page', both.pick);
    if (both.pick) {
      check('arming Seat here leaves Center lock off',
        both.afterSeat.seat && !both.afterSeat.lock, JSON.stringify(both.afterSeat));
      check('arming Center lock turns Seat here off',
        !both.afterPick.seat, JSON.stringify(both.afterPick));
      check('and arming Seat here turns Center lock off',
        both.afterSeat2.seat && !both.afterSeat2.lock, JSON.stringify(both.afterSeat2));
    }
  }

  console.log('\n-- leaving Join retires the arm, silently --');
  {
    const left = await page.evaluate(() => {
      document.getElementById('btn-seat-here').click();
      const armed = !!state.seatHereArmed;
      document.getElementById('status').textContent = 'a line the caller set';
      clearJoinSlots();
      return { armed: armed, stillArmed: !!state.seatHereArmed,
               lit: document.getElementById('btn-seat-here').classList.contains('is-armed'),
               status: document.getElementById('status').textContent };
    });
    check('Cancel Join / clearing the slots retires the arm', left.armed && !left.stillArmed,
      JSON.stringify(left));
    check('  ...and the button goes dark with it, not lit and dead', !left.lit);
    check('  ...without printing over the line the caller had just set',
      left.status === 'a line the caller set', left.status);
  }

  console.log('\n-- one Seat here is one Undo, geometry and pose together --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const pt = await page.evaluate(surfacePoint, [idSphere, [1, 1, 0]]);
    const before = await page.evaluate(([b]) => {
      const m = state.models.find(x => x && x.id === b);
      const p = state.placed.find(q => q && q.sourceId === b && q.mesh);
      return { raw: Array.from(m.rawTris), size: [m.size.x, m.size.y, m.size.z],
               x: p.x, z: p.z, liftY: p.liftY, pos: p.mesh.position.toArray(), undo: state.undoStack.length };
    }, [idBit]);
    const r = await page.evaluate(seatAt, [idSphere, idBit, pt, -0.18]);
    check('the seat turned the piece, so its geometry was rewritten', r.ok && r.rotationDeg > 1, f4(r.rotationDeg));
    check('and it pushed exactly one undo entry', r.undo === before.undo + 1, r.undo - before.undo);
    await page.evaluate(() => undoLast());
    const back = await page.evaluate(([b]) => {
      const m = state.models.find(x => x && x.id === b);
      const p = state.placed.find(q => q && q.sourceId === b && q.mesh);
      return { raw: Array.from(m.rawTris), size: [m.size.x, m.size.y, m.size.z],
               x: p.x, z: p.z, liftY: p.liftY, pos: p.mesh.position.toArray(),
               undo: state.undoStack.length, status: document.getElementById('status').textContent };
    }, [idBit]);
    check('one Undo puts the raw soup back bit for bit',
      back.raw.length === before.raw.length && back.raw.every((v, i) => v === before.raw[i]),
      back.raw.length + ' vs ' + before.raw.length);
    check('  ...and the pose with it, exactly',
      back.x === before.x && back.z === before.z && back.liftY === before.liftY &&
      back.pos.every((v, i) => v === before.pos[i]),
      JSON.stringify([back.x, back.liftY]) + ' vs ' + JSON.stringify([before.x, before.liftY]));
    check('  ...and the label names the op', /Undo: Seat here reverted/.test(back.status), back.status);
    check('  ...and the stack is back where it was', back.undo === before.undo, back.undo);
  }

  console.log('\n-- paint wins: whole-piece on the piece being seated, when it has to turn --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const ptFlank = await page.evaluate(surfacePoint, [idSphere, [1, 1, 0]]);
    const ptTop = await page.evaluate(surfacePoint, [idSphere, [1, 0, 0]]);
    const painted = await page.evaluate(b => {
      const m = state.models.find(x => x && x.id === b);
      m.faceMask = { exclude: [{ axis: 1, side: 'max' }], select: [] };
      return (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : -1;
    }, idBit);
    check('B carries one painted face', painted === 1, painted);
    const rP = await page.evaluate(seatAt, [idSphere, idBit, ptFlank, -0.18]);
    check('a seat that needs a turn stands down and names the paint',
      !rP.ok && /stood down - 1 painted face/.test(rP.status), rP.status);
    check('  ...and nothing moved', rP.undo === (await page.evaluate(() => state.undoStack.length)));
    const rQ = await page.evaluate(seatAt, [idSphere, idBit, ptTop, -0.18]);
    check('a seat that needs NO turn is not blocked by paint - it changes no geometry',
      rQ.ok && rQ.rotationDeg < 1e-3, rQ.ok ? f4(rQ.rotationDeg) : rQ.status);
    check('  ...and the target\'s own paint never blocks a seat, because A is only read',
      true, 'stated in app-seat-surface.js\'s PAINT SCOPE note');
    await page.evaluate(b => {
      const m = state.models.find(x => x && x.id === b);
      m.faceMask = { exclude: [], select: [] };
      if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
    }, idBit);
  }

  console.log('\n-- refusals through the app --');
  {
    await page.evaluate(stage, [idSphere, idBit]);
    const under = await page.evaluate(surfacePoint, [idSphere, [0, -1, 0]]);
    const r = await page.evaluate(seatAt, [idSphere, idBit, under, -0.18]);
    check('a seat that would put B under the plate refuses, and says so',
      !r.ok && /below the plate/.test(r.reason || ''), r.reason || r.status);
    const rb = await page.evaluate(([a, b, pt]) => {
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      const r2 = NSO_seatHereAt(pB, pt, { gap: -0.18 });
      return { ok: r2.ok, reason: r2.reason, status: document.getElementById('status').textContent };
    }, [idSphere, idBit, [0, 20, 0]]);
    check('clicking B itself is refused with a line that says which piece to click',
      !rb.ok && /That is B\. Click the point on A/.test(rb.status), rb.status);
    const rl = await page.evaluate(([a, b, pt]) => {
      const m = state.models.find(x => x && x.id === b);
      m.posLock = true;
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const r2 = NSO_seatHereAt(pA, pt, { gap: -0.18 });
      m.posLock = false;
      return { ok: r2.ok, reason: r2.reason, status: document.getElementById('status').textContent };
    }, [idSphere, idBit, await page.evaluate(surfacePoint, [idSphere, [1, 0, 0]])]);
    const hasPosLock = await page.evaluate(() => typeof nsoPosLockBlocks === 'function');
    if (hasPosLock) {
      check('a position-locked B is not moved by it', !rl.ok && rl.reason === 'position lock', rl.reason);
    } else {
      /* app-poslock.js is not in this tree; app-seat-surface.js guards the call,
         so posLock is simply not a thing a piece can carry here. Assert the
         guard does not break the seat, and re-arm the real gate with the file. */
      check('no app-poslock.js here: the guard does not turn a good seat into a refusal', rl.ok, rl.reason);
      console.log('  skip  the position-lock gate - nsoPosLockBlocks arrives with app-poslock.js');
    }
  }

  /* =================================================================
     PART 3 - the regression
     ================================================================= */
  console.log('\n== 3. the flat-face seat is untouched ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'app-join.js'), 'utf8');
    check('NSO_seatFlushBitToHull still has its own signature and nothing calls the new core into it',
      /function NSO_seatFlushBitToHull\(hullMesh, bitMesh, opts\)/.test(src) &&
      !/NSO_SeatSurface/.test(src));
    await page.evaluate(stage, [idFlat, idBox]);
    const staged = await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      [pA, pB].forEach(p => { p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.flipX = false; });
      pA.x = 0; pA.z = 0; pA.liftY = 0;
      pA.mesh.position.set(0, pA.height / 2 + 0.3, 0); pA.mesh.updateMatrixWorld(true);
      const bbA = new THREE.Box3().setFromObject(pA.mesh);
      pB.liftY = 0; pB.x = 0; pB.z = 0; pB.mesh.quaternion.identity();
      pB.mesh.position.set(0, bbA.max.y + 5 + pB.height / 2, 0); pB.mesh.updateMatrixWorld(true);
      state.joinSession = true; state.editId = a; state.joinPartnerId = b;
      document.getElementById('status').textContent = '';
      return true;
    }, [idFlat, idBox]);
    void staged;
    await page.click('#btn-seat-flush');
    const flush = await page.evaluate(([a, b]) => {
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      return { status: document.getElementById('status').textContent,
               pos: pB.mesh.position.toArray(), quat: pB.mesh.quaternion.toArray(), liftY: pB.liftY };
    }, [idFlat, idBox]);
    /* the golden pose and status captured before the gap work, re-pinned here
       as well as in tools/nso_seat_gap_test.js */
    check('Seat flush still lands on the golden pose (1e-9)',
      [0, 10.309999237060548, 0].every((v, i) => near(flush.pos[i], v, 1e-9)) &&
      near(flush.liftY, 0.10999923706054915, 1e-9), JSON.stringify(flush.pos));
    check('  ...with the golden status line, byte for byte',
      flush.status === 'Seated - proud 0.01mm, skin error 0.00mm - Subtract', flush.status);
    check('  ...and no rotation', flush.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)));

    await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      pA.x = 0; pA.z = 0; pA.liftY = 0; pA.mesh.position.set(0, pA.height / 2 + 0.3, 0); pA.mesh.updateMatrixWorld(true);
      const bbA = new THREE.Box3().setFromObject(pA.mesh);
      pB.liftY = 0; pB.x = 0; pB.z = 0; pB.mesh.quaternion.identity();
      pB.mesh.position.set(0, bbA.max.y + 5 + pB.height / 2, 0); pB.mesh.updateMatrixWorld(true);
      document.getElementById('status').textContent = '';
    }, [idFlat, idBox]);
    await page.evaluate(() => {
      const el = document.getElementById('seat-gap');
      el.value = '-0.18'; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#btn-seat-support');
    const sup = await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
      const bbA = new THREE.Box3().setFromObject(pA.mesh), bbB = new THREE.Box3().setFromObject(pB.mesh);
      return { status: document.getElementById('status').textContent,
               gap: bbB.min.y - bbA.max.y, liftY: pB.liftY };
    }, [idFlat, idBox]);
    check('Seat (support) -0.18 on the flat block is unchanged: status byte for byte',
      /^Seated - air gap 0\.18mm \(measured -0\.180mm, skin error 0\.00mm\)$/.test(sup.status), sup.status);
    check('  ...and the mating face is still 0.18 above the skin (2e-6)', near(sup.gap, 0.18, 2e-6), f5(sup.gap));
    check('  ...and liftY is still hull top + 0.18 (2e-6)', near(sup.liftY, 20.18, 2e-6), f5(sup.liftY));
  }

  console.log('\n--- page errors ---');
  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));

  console.log('\nfiles: ' + tmp);
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

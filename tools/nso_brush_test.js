#!/usr/bin/env node
/* Headless evidence for the local brush (app-brush.js).
 *
 *   node tools/nso_brush_test.js        exit 0 = every gate held
 *
 * Loads the shipped browser files with `vm`, the way sculpt_selftest.js does,
 * so app-brush.js stays free of any node idiom. Three real cases, all repo
 * fixtures, chosen because they break the brush in three different ways:
 *
 *   flat face   fixtures/box-20mm.stl        12 triangles. A 6mm brush in the
 *                                            middle of a 20mm face has NO
 *                                            vertex to move. This is the case
 *                                            that proves refinement is load
 *                                            bearing rather than decorative.
 *   curved      fixtures/fixture_sphere_curved.stl   2208 triangles, no flat
 *                                            face anywhere, so every dab has
 *                                            a different normal and the
 *                                            per-stamp normal choice matters.
 *   thin wall   fixtures/lid_blank.stl       60 x 40 x 2.4mm. Carving deeper
 *                                            than the wall punches through
 *                                            and the far side self-intersects
 *                                            - the case the Task 4 gate is
 *                                            actually for.
 *
 * The canonical checker (tools/mesh_validate.py) runs on the real STL before
 * and after every case, and this file asserts its numbers - not its own. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-brush-'));

/* ---------- load the shipped files into one context ---------- */
const ctx = {
  Math, Map, Set, console, isFinite, Object, Array, Number,
  Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array,
  window: {}
};
vm.createContext(ctx);
for (const f of ['NSO_Repair.js', 'app-sculpt.js', 'app-brush.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
// NSO_Repair hangs itself off window the way a classic script does; app-brush
// looks for it in either place, but make the bare name work here too.
ctx.NSO_Repair = ctx.window.NSO_Repair;
if (!ctx.NSO_Repair) { console.error('NSO_Repair.js did not attach'); process.exit(1); }

const B = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(label); console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

/* The canonical checker, on a real file, exactly as the repo defines it. */
function canonical(rawTris, tag) {
  const p = path.join(TMP, tag + '.stl');
  writeSTL(p, rawTris, 'nso brush ' + tag);
  const out = execFileSync('python3', [MV, p, '--json'], { maxBuffer: 1 << 28 });
  return JSON.parse(out.toString());
}

function fx(name) { return readSTL(path.join(ROOT, 'fixtures', name)); }

/* A dab centred on the point of the piece furthest along +axis, aimed along
 * that axis. Deliberately geometric rather than hand-typed coordinates, so
 * the cases survive a fixture being re-exported. */
function faceCentreStamp(raw, axis, r, falloff) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (raw[i + k] < lo[k]) lo[k] = raw[i + k];
      if (raw[i + k] > hi[k]) hi[k] = raw[i + k];
    }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  c[axis] = hi[axis];
  const n = [0, 0, 0]; n[axis] = 1;
  return { c: c, n: n, r: r, falloff: falloff || 'soft' };
}

/* A short drag ACROSS THE SURFACE: `count` dabs stepping along a tangent, each
   one snapped to the nearest triangle and given that triangle's own normal.

   Stepping in a straight line in raw space instead is what a first draft did,
   and on a sphere it walks the dab off the surface and into the air after two
   steps - the stamps then reach nothing and the drag is indistinguishable from
   a single dab. Snapping is what the app's raycast does on every pointermove,
   so this is the honest stand-in for it. */
function surfaceDrag(raw, axis, r, count, step, falloff) {
  const n = (raw.length / 9) | 0;
  const cen = [], nrm = [];
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    cen.push([(raw[o] + raw[o + 3] + raw[o + 6]) / 3,
              (raw[o + 1] + raw[o + 4] + raw[o + 7]) / 3,
              (raw[o + 2] + raw[o + 5] + raw[o + 8]) / 3]);
    const ux = raw[o + 3] - raw[o], uy = raw[o + 4] - raw[o + 1], uz = raw[o + 5] - raw[o + 2];
    const vx = raw[o + 6] - raw[o], vy = raw[o + 7] - raw[o + 1], vz = raw[o + 8] - raw[o + 2];
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const L = Math.hypot(cx, cy, cz) || 1;
    nrm.push([cx / L, cy / L, cz / L]);
  }
  const snap = p => {
    let best = 0, bestD = Infinity;
    for (let t = 0; t < n; t++) {
      const d = (cen[t][0] - p[0]) ** 2 + (cen[t][1] - p[1]) ** 2 + (cen[t][2] - p[2]) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };
  const start = faceCentreStamp(raw, axis, r, falloff);
  const tan = [0, 0, 0];
  tan[(axis + 1) % 3] = 1;
  const out = [];
  let p = start.c.slice();
  for (let i = 0; i < count; i++) {
    const t = snap(p);
    out.push({ c: cen[t].slice(), n: nrm[t].slice(), r: r, falloff: falloff || 'soft' });
    p = [cen[t][0] + tan[0] * step, cen[t][1] + tan[1] * step, cen[t][2] + tan[2] * step];
  }
  return out;
}

const pierce = r => r.self_intersection.pierce;

function line(tag, before, after) {
  console.log('   ' + tag +
    ' tris ' + before.triangles + '→' + after.triangles +
    '  open ' + before.open_edges + '→' + after.open_edges +
    '  nm ' + before.nonmanifold_edges + '→' + after.nonmanifold_edges +
    '  slivers ' + before.sliver_tris + '→' + after.sliver_tris +
    '  worstAsp ' + before.worst_aspect_ratio.toFixed(1) + '→' + after.worst_aspect_ratio.toFixed(1) +
    '  pierce ' + pierce(before) + '→' + pierce(after) +
    '  vol ' + before.signed_volume.toFixed(2) + '→' + after.signed_volume.toFixed(2));
}

/* The numbers a stroke is never allowed to make worse, asserted against
   tools/mesh_validate.py - the canonical checker - rather than against
   app-brush.js's own opinion of itself. */
function canonicalHeld(tag, before, after) {
  ok(after.open_edges <= before.open_edges, tag + ': canonical open edges did not rise',
     before.open_edges + ' → ' + after.open_edges);
  ok(after.nonmanifold_edges <= before.nonmanifold_edges, tag + ': canonical non-manifold did not rise',
     before.nonmanifold_edges + ' → ' + after.nonmanifold_edges);
  ok(pierce(after) <= pierce(before), tag + ': canonical self-intersections did not rise',
     pierce(before) + ' → ' + pierce(after));
  ok(after.sliver_tris <= before.sliver_tris, tag + ': canonical slivers did not rise',
     before.sliver_tris + ' → ' + after.sliver_tris);
  ok(after.degenerate_tris <= before.degenerate_tris, tag + ': canonical degenerates did not rise',
     before.degenerate_tris + ' → ' + after.degenerate_tris);
  ok(after.inconsistent_winding_edges <= before.inconsistent_winding_edges,
     tag + ': canonical winding did not degrade',
     before.inconsistent_winding_edges + ' → ' + after.inconsistent_winding_edges);
}

/* =======================================================================
   1. Refinement on its own is surface-preserving and conforming

   Before any deformation is measured, this has to be true, or every later
   number is measuring two things at once. Splitting an edge at its midpoint
   puts the new vertex ON the old edge, so the SURFACE does not move: volume,
   area, open edges and self-intersections must all come back identical while
   the triangle count goes up.
   ======================================================================= */
console.log('\n== 1. refinement alone: more triangles, same surface ==');
{
  const raw = fx('box-20mm.stl');
  const adj = B.NSO_buildAdjacency(raw, {});
  const base = B.NSO_brushMesh(adj);
  const zone = [{ c: [0, 0, 10], r: 12 }];
  const ref = B.NSO_brushRefine(base, zone, { target: 2, maxPasses: 5, maxTris: 400000 });

  const b4 = canonical(B.NSO_brushToRaw(base), 'refine-before');
  const af = canonical(B.NSO_brushToRaw(ref.mesh), 'refine-after');
  line('refine', b4, af);

  ok(ref.mesh.triCount > base.triCount, 'refinement added triangles',
     base.triCount + ' → ' + ref.mesh.triCount);
  ok(Math.abs(af.signed_volume - b4.signed_volume) < 1e-6, 'volume identical',
     b4.signed_volume + ' vs ' + af.signed_volume);
  ok(Math.abs(af.surface_area - b4.surface_area) < 1e-6, 'surface area identical',
     b4.surface_area + ' vs ' + af.surface_area);
  ok(af.open_edges === 0 && af.nonmanifold_edges === 0, 'still closed and manifold',
     'open ' + af.open_edges + ', nm ' + af.nonmanifold_edges);
  ok(af.euler_characteristic === b4.euler_characteristic, 'Euler characteristic unchanged',
     b4.euler_characteristic + ' vs ' + af.euler_characteristic);
  ok(pierce(af) === pierce(b4), 'self-intersections unchanged', pierce(b4) + ' vs ' + pierce(af));

  // THE T-JUNCTION CLAIM, measured. Section 3 argues the split cannot leave a
  // hanging vertex because the midpoint is keyed on the edge and shared by
  // both triangles. This is that argument tested on a real mesh.
  const tjB = B.NSO_brushTJunctionAudit(B.NSO_brushToRaw(base), {});
  const tjA = B.NSO_brushTJunctionAudit(B.NSO_brushToRaw(ref.mesh), {});
  ok(tjA.tJunctions === 0 && !tjA.capped, 'refinement left ZERO T-junctions',
     'before ' + tjB.tJunctions + ', after ' + tjA.tJunctions + ' over ' + tjA.edges + ' edges');
}

/* =======================================================================
   2. The three real cases
   ======================================================================= */
function runCase(tag, file, opts) {
  console.log('\n== ' + tag + ' ==');
  const raw = fx(file);
  const stamps = opts.stamps(raw);
  const r = B.NSO_brushApply(raw, stamps, opts.apply || {});
  console.log('   ' + r.refine.trisBefore + ' tris in, refined to ' + r.refine.trisAfter +
              ' (target edge ' + r.refine.target.toFixed(2) + 'mm, ' + r.refine.passes +
              ' pass(es), ' + r.refine.splits + ' edge split(s)' + (r.refine.capped ? ', CAPPED' : '') + ')');
  if (!r.ok) { console.log('   refused: ' + r.reason); return r; }
  console.log('   ' + r.selected + ' vert(s) in the brush, seam band ' + r.seam.band +
              ' (' + r.seam.pinned + ' pinned as feature/boundary), max move ' + r.maxMove.toFixed(3) + 'mm');

  const b4 = canonical(B.NSO_brushToRaw(B.NSO_brushMesh(B.NSO_buildAdjacency(raw, {}))), tag + '-before');
  const af = canonical(r.tris, tag + '-after');
  line(tag, b4, af);
  canonicalHeld(tag, b4, af);

  // The deformation actually happened. A gate that passes because nothing
  // moved is not a gate that passed.
  ok(r.moved > 0, tag + ': the brush moved vertices', r.moved + ' vertex/vertices');
  ok(Math.abs(af.signed_volume - b4.signed_volume) > 1e-3, tag + ': the surface actually changed',
     'volume ' + b4.signed_volume.toFixed(3) + ' → ' + af.signed_volume.toFixed(3));

  // T-junctions, explicitly, on the deformed result - Task 3's own validation.
  const tj = B.NSO_brushTJunctionAudit(r.tris, {});
  ok(tj.tJunctions === 0 && !tj.capped, tag + ': no T-junction in the deformed zone',
     tj.tJunctions + ' over ' + tj.edges + ' edges');
  return r;
}

const flat = runCase('flat', 'box-20mm.stl', {
  stamps: raw => [faceCentreStamp(raw, 2, 6, 'soft')],
  apply: { mode: 'carve', intensity: 0.6 }
});
ok(flat.ok, 'flat: the stroke committed', flat.ok ? '' : flat.reason);
// The point of the flat case: the 12-triangle box has no vertex under the
// brush at all, so without refinement nothing could move.
ok(flat.refine.trisAfter > flat.refine.trisBefore * 4,
   'flat: refinement is load bearing - a 12-triangle box cannot be carved without it',
   flat.refine.trisBefore + ' → ' + flat.refine.trisAfter + ' triangles');
ok(flat.after.bbox.size[2] >= flat.before.bbox.size[2] - 1e-9,
   'flat: carving inward did not grow the piece on that axis');

const curved = runCase('curved', 'fixture_sphere_curved.stl', {
  stamps: raw => surfaceDrag(raw, 2, 4, 6, 2.2, 'soft'),
  apply: { mode: 'carve', intensity: 0.5 }
});
ok(curved.ok, 'curved: the stroke committed', curved.ok ? '' : curved.reason);
// A 5-dab drag has to be a GROOVE, not the same pit a single dab makes.
{
  const raw = fx('fixture_sphere_curved.stl');
  const one = B.NSO_brushApply(raw, surfaceDrag(raw, 2, 4, 1, 2.2, 'soft'),
                               { mode: 'carve', intensity: 0.5 });
  ok(curved.selected > one.selected * 1.5,
     'curved: a 6-dab drag reaches far more surface than one dab - it is a stroke, not a click',
     one.selected + ' vert(s) for one dab vs ' + curved.selected + ' for the drag');
  ok(Math.abs(curved.after.volume - curved.before.volume) >
     Math.abs(one.after.volume - one.before.volume) * 1.5,
     'curved: and removes correspondingly more material',
     Math.abs(one.after.volume - one.before.volume).toFixed(2) + 'mm3 for one dab vs ' +
     Math.abs(curved.after.volume - curved.before.volume).toFixed(2) + 'mm3 for the drag');
}

const emboss = runCase('emboss', 'fixture_sphere_curved.stl', {
  stamps: raw => [faceCentreStamp(raw, 2, 5, 'soft')],
  apply: { mode: 'emboss', intensity: 0.5 }
});
ok(emboss.ok, 'emboss: the stroke committed', emboss.ok ? '' : emboss.reason);
ok(emboss.after.volume > emboss.before.volume,
   'emboss pushes OUT where carve pushes in',
   emboss.before.volume.toFixed(3) + ' → ' + emboss.after.volume.toFixed(3));
ok(curved.after.volume < curved.before.volume,
   'carve removes volume', curved.before.volume.toFixed(3) + ' → ' + curved.after.volume.toFixed(3));

const smooth = runCase('smooth', 'fixture_sphere_curved.stl', {
  stamps: raw => [faceCentreStamp(raw, 2, 6, 'soft')],
  apply: { mode: 'smooth', intensity: 0.8, smoothPasses: 6 }
});
ok(smooth.ok, 'smooth: the stroke committed', smooth.ok ? '' : smooth.reason);

/* =======================================================================
   3. Seam integrity under the case that actually stresses it

   Hard falloff on a coarse zone is the sliver generator described in section
   5 of app-brush.js: the last ring inside the rim is dragged most of the full
   depth while its neighbour one ring out has not moved at all. Two runs, the
   only difference being whether the seam relax is allowed to run.
   ======================================================================= */
console.log('\n== 3. seam integrity: the relax is load bearing, not decoration ==');
{
  const raw = fx('box-20mm.stl');
  const stamps = [faceCentreStamp(raw, 2, 8, 'hard')];
  const common = { mode: 'carve', intensity: 1.0, samples: 4 };

  const withRelax = B.NSO_brushApply(raw, stamps, Object.assign({}, common));
  const noRelax = B.NSO_brushApply(raw, stamps, Object.assign({}, common, { seam: false, gate: false }));

  const b4 = canonical(B.NSO_brushToRaw(B.NSO_brushMesh(B.NSO_buildAdjacency(raw, {}))), 'seam-before');
  const afOn = canonical(withRelax.tris, 'seam-on');
  const afOff = canonical(noRelax.tris, 'seam-off');
  line('relax on ', b4, afOn);
  line('relax off', b4, afOff);
  console.log('   seam band ' + withRelax.seam.band + ' vertices, ' + withRelax.seam.pinned +
              ' pinned as feature/boundary, ' + withRelax.seam.passes + ' pass(es)');

  ok(withRelax.ok, 'hard falloff + coarse zone: the stroke still committed',
     withRelax.ok ? '' : withRelax.reason);
  ok(withRelax.seam.band > 0, 'the seam band is non-empty', withRelax.seam.band + ' vertices');
  ok(withRelax.seam.pinned > 0,
     'feature and boundary vertices in the band were PINNED, not relaxed - the box corners survive',
     withRelax.seam.pinned + ' of ' + withRelax.seam.band + ' pinned');
  ok(afOn.worst_aspect_ratio <= afOff.worst_aspect_ratio,
     'the relax leaves the worst triangle no worse than leaving it alone does',
     'relaxed ' + afOn.worst_aspect_ratio.toFixed(2) + ' vs unrelaxed ' + afOff.worst_aspect_ratio.toFixed(2));
  ok(afOn.sliver_tris <= b4.sliver_tris, 'canonical sliver count did not rise',
     b4.sliver_tris + ' → ' + afOn.sliver_tris);
  ok(B.NSO_brushTJunctionAudit(withRelax.tris, {}).tJunctions === 0,
     'the relaxed seam carries no T-junction');
  // The relax must not eat the carve: (1 - w) strength is what guarantees it.
  ok(withRelax.maxMove > 0.5 * noRelax.maxMove,
     'the relax softened the wall without eating the carve',
     'max move relaxed ' + withRelax.maxMove.toFixed(3) + 'mm vs unrelaxed ' + noRelax.maxMove.toFixed(3) + 'mm');
}

/* =======================================================================
   4. THIN WALL - the case the self-intersection gate is for

   lid_blank.stl is 2.4mm thick. Carve deeper than that and the dished face
   comes out the other side. The mesh stays closed and manifold the whole way
   - a mesh that has passed through itself is still a perfectly watertight
   mesh, which is exactly why open/non-manifold counts cannot be the gate and
   the canonical self-intersection count has to be.
   ======================================================================= */
console.log('\n== 4. thin wall: the gate refuses a stroke that punches through ==');
{
  const raw = fx('lid_blank.stl');
  const shallow = B.NSO_brushApply(raw, [faceCentreStamp(raw, 2, 8, 'soft')],
                                   { mode: 'carve', intensity: 0.1 });
  const b4 = canonical(B.NSO_brushToRaw(B.NSO_brushMesh(B.NSO_buildAdjacency(raw, {}))), 'thin-before');
  if (shallow.ok) {
    const af = canonical(shallow.tris, 'thin-shallow');
    line('thin ok ', b4, af);
    canonicalHeld('thin', b4, af);
  }
  ok(shallow.ok, 'thin wall: a shallow dab is allowed', shallow.ok ? '' : shallow.reason);

  // Now dig straight through the 2.4mm wall.
  const through = B.NSO_brushApply(raw, [faceCentreStamp(raw, 2, 20, 'hard')],
                                   { mode: 'carve', intensity: 1.0 });
  console.log('   through-wall stroke: ' + (through.ok ? 'COMMITTED' : 'refused - ' + through.reason));

  // What it WOULD have produced, measured with the gate off, so the refusal
  // is shown to be a real refusal of a real defect rather than a lucky guess.
  const ungated = B.NSO_brushApply(raw, [faceCentreStamp(raw, 2, 20, 'hard')],
                                   { mode: 'carve', intensity: 1.0, gate: false });
  const afBad = canonical(ungated.tris, 'thin-through');
  line('thin bad', b4, afBad);
  ok(pierce(afBad) > pierce(b4),
     'the ungated stroke really does self-intersect, per the canonical checker',
     pierce(b4) + ' → ' + pierce(afBad) + ' piercing pairs');
  ok(afBad.open_edges === b4.open_edges && afBad.nonmanifold_edges === b4.nonmanifold_edges,
     'and it stays closed and manifold - which is why edge counts cannot be the gate',
     'open ' + afBad.open_edges + ', nm ' + afBad.nonmanifold_edges);
  ok(!through.ok, 'the gate REFUSED it', through.ok ? 'it committed - gate did not hold' : through.reason);
  ok(!through.ok && /self-intersections rose|volume|sliver/.test(through.reason),
     'and the refusal names what it caught', through.reason);
  ok(through.tris === raw, 'a refused stroke hands back the ORIGINAL soup, byte for byte');
}

/* =======================================================================
   5. The gate is reached through the real entry point, not only in a test

   NSO_brushApply is what the app's pointerup calls into. Prove the gate is
   on by default - a gate that only runs when a test asks for it is not a gate.
   ======================================================================= */
console.log('\n== 5. the gate is on by default and the checker is required ==');
{
  const raw = fx('lid_blank.stl');
  const dflt = B.NSO_brushApply(raw, [faceCentreStamp(raw, 2, 20, 'hard')],
                                { mode: 'carve', intensity: 1.0 });
  ok(!dflt.ok, 'no gate:false needed - the default path refuses', dflt.reason);

  // A missing canonical checker is a refusal, not a silent skip.
  const noChecker = B.NSO_brushSelfInt(raw, { repair: {} });
  ok(!noChecker.ok, 'a missing NSO_Repair is reported, not ignored', noChecker.reason);
  const scored = B.NSO_brushScore(raw, { repair: {} });
  const g = B.NSO_brushGate(scored, scored, {});
  ok(!g.ok, 'and the gate refuses outright when the checker is unavailable', g.reason);
}

/* =======================================================================
   6. The browser checker and the canonical one agree, for THIS feature

   tools/nso_selfint_equiv_test.js already pins NSO_Repair.js against
   mesh_validate.py on every fixture in the repo. That is the general
   guarantee. This is the specific one: the number app-brush.js gates on and
   the number the canonical checker reports for the same stroke are the same
   number, on meshes this feature made, which no fixture in the repo covers
   because none of them existed until the brush produced them.
   ======================================================================= */
console.log('\n== 6. the gate\'s number is the canonical number ==');
{
  const cases = [
    ['flat', fx('box-20mm.stl'), [faceCentreStamp(fx('box-20mm.stl'), 2, 6, 'soft')], { mode: 'carve', intensity: 0.6 }],
    ['thin-through', fx('lid_blank.stl'), [faceCentreStamp(fx('lid_blank.stl'), 2, 20, 'hard')],
     { mode: 'carve', intensity: 1.0, gate: false }]
  ];
  for (const [tag, raw, stamps, opts] of cases) {
    const r = B.NSO_brushApply(raw, stamps, opts);
    const c = canonical(r.tris, 'equiv-' + tag);
    ok(r.after.pierce === pierce(c),
       tag + ': NSO_Repair and mesh_validate.py report the same piercing count',
       'js ' + r.after.pierce + ' vs python ' + pierce(c));
    ok(r.after.coplanar === c.self_intersection.coplanar,
       tag + ': ...and the same coplanar count',
       'js ' + r.after.coplanar + ' vs python ' + c.self_intersection.coplanar);
    ok(r.after.slivers === c.sliver_tris,
       tag + ': ...and the same sliver count on the same definition',
       'js ' + r.after.slivers + ' vs python ' + c.sliver_tris);
    ok(r.after.degenerate === c.degenerate_tris,
       tag + ': ...and the same degenerate count',
       'js ' + r.after.degenerate + ' vs python ' + c.degenerate_tris);
  }
}

/* =======================================================================
   7. PAINT SCOPE: SUB-REGION

   The standing rule in docs/HANDOFF.md is that a painted face stays untouched
   by ANY bake. The scoping rule says HOW a feature checks depends on its
   shape. The brush has an identifiable sub-region, so it checks only the
   faces its own stroke lands on - and that is the same rule as Smooth's
   whole-piece stand-down applied at a different scope, not a laxer reading of
   it. Both halves are asserted here: paint under the brush stops it, paint
   on the other side of the piece does not.
   ======================================================================= */
console.log('\n== 7. paint scope: sub-region, both halves ==');
{
  const raw = fx('box-20mm.stl');
  const adj = B.NSO_buildAdjacency(raw, {});
  const base = B.NSO_brushMesh(adj);
  const stamps = [faceCentreStamp(raw, 2, 6, 'soft')];   // dab on the +Z face
  const ref = B.NSO_brushRefine(base, B.NSO_brushZones(stamps), { target: 2, maxPasses: 5, maxTris: 400000 });
  const graph = B.NSO_brushGraph(ref.mesh);
  const field = B.NSO_brushWeights(ref.mesh, stamps, {});
  const pos = new Float64Array(ref.mesh.pos);
  const seam = B.NSO_brushRelaxSeam(ref.mesh, graph, pos, field, {});
  const pts = B.NSO_brushAffectedPoints(ref.mesh, field, seam);

  // Plane entries in the shape nsoMaskPlaneList hands back.
  const zPlus = { n: [0, 0, 1], d: 10, axisIdx: 2, keepMin: false, inner: false, recessed: false };
  const zMinus = { n: [0, 0, -1], d: 10, axisIdx: 2, keepMin: true, inner: false, recessed: false };
  const xPlus = { n: [1, 0, 0], d: 10, axisIdx: 0, keepMin: false, inner: false, recessed: false };

  const under = B.NSO_brushPaintCheck([zPlus], pts);
  ok(under.any, 'paint on the face under the brush STOPS it', under.painted.length + ' face(s)');

  const far = B.NSO_brushPaintCheck([zMinus], pts);
  ok(!far.any, 'paint on the opposite face does NOT stop it - that is the sub-region rule');

  const side = B.NSO_brushPaintCheck([xPlus], pts);
  ok(!side.any, 'paint on a side face the stroke never reaches does not stop it either');

  const both = B.NSO_brushPaintCheck([zMinus, zPlus, xPlus], pts);
  ok(both.any && both.painted.length === 1,
     'with paint on three faces, only the one the stroke lands on is named',
     both.painted.length + ' named');

  const txt = B.NSO_brushStandDownStatus(both.painted);
  console.log('   stand-down: ' + txt);
  ok(/^Brush stood down - 1 painted face\(s\)/.test(txt),
     'the stand-down line matches the shape the other four bakes use');
  ok(/the Z\+ face/.test(txt), 'and names the face rather than only counting it');
  ok(/paint elsewhere on the piece does not stop it/.test(txt),
     'and says out loud that it is a sub-region check');

  // The seam band is part of the affected set, not an afterthought.
  const brushOnly = B.NSO_brushAffectedPoints(ref.mesh, field, null);
  ok(pts.length > brushOnly.length,
     'the affected set includes the seam band, which reaches outside the brush',
     (brushOnly.length / 3) + ' brush vert(s) vs ' + (pts.length / 3) + ' with the band');
}

/* =======================================================================
   8. The 1 mm brush

   The Size slider on the Sculpt card goes down to 1 mm. Its floor is read
   from index.html, and a 1 mm dab is run through the same canonical gates
   as the three cases above: on the 20mm box it lands where no vertex is, so
   refinement has to go down to its edge length for it to move anything.
   ======================================================================= */
console.log('\n== 8. the 1 mm brush ==');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tag = /<input\b[^>]*\bid="inp-brush-size"[^>]*>/.exec(html);
  const attr = k => { const m = tag && new RegExp('\\b' + k + '="([^"]*)"').exec(tag[0]); return m ? m[1] : null; };
  ok(!!tag && attr('type') === 'range' && attr('min') === '1' && attr('step') === '1',
     'the Size slider is the same range slider, its floor 1 mm',
     tag ? 'min ' + attr('min') + ', max ' + attr('max') + ', step ' + attr('step') : 'no #inp-brush-size');

  const one = runCase('1mm', 'box-20mm.stl', {
    stamps: raw => [faceCentreStamp(raw, 2, 1, 'soft')],
    apply: { mode: 'carve', intensity: 0.6 }
  });
  ok(one.ok, '1mm: the stroke committed', one.ok ? '' : one.reason);
  ok(one.ok && one.refine.target <= 1, '1mm: refined to an edge no longer than the radius',
     one.ok ? 'target ' + one.refine.target.toFixed(3) + 'mm' : '');
  ok(one.ok && one.maxMove > 0 && one.maxMove <= 1 + 1e-9, '1mm: the dab moved the surface, by no more than its radius',
     one.ok ? 'max move ' + one.maxMove.toFixed(3) + 'mm' : '');
}

/* ---------------------------------------------------------------- summary */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);

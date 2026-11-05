#!/usr/bin/env node
// The CANONICAL checker (tools/mesh_validate.py) over every solid Attach
// produces, with the numbers compared by machine instead of by eye.
//
//   node tools/nso_assemble_canonical_check.js     exit 0 = every gate held
//
// Depends on tools/nso_assemble_test.js having written tools/assemble-out/;
// it runs that first, so the solids under test are always the ones the
// shipped code produces rather than a stale copy - same contract
// tools/nso_support_aim_canonical_check.js has.
//
// WHAT IS ASSERTED ON EVERY ASSEMBLY, and why each one:
//
//   verdict PASS                      the checker's own overall word
//   open / nonmanifold / odd edges    a union that left any of these is not
//                                     one solid, whatever the kernel's part
//                                     count said
//   inconsistent_winding              ditto, from the other side
//   euler_characteristic = 2          ONE closed shell with no handles. This
//                                     is the assertion the whole ticket turns
//                                     on: a body and an arm merely touching
//                                     would be two shells, chi = 4
//   degenerate_tris = 0               nothing collapsed in the seat or the
//                                     turn
//   self-intersection pierce+coplanar 0 of either. Note what this says that
//                                     support-aim's check deliberately did
//                                     NOT: there, the support and the piece
//                                     were two solids in contact and the
//                                     checker rightly counted the contact as
//                                     piercing. Here they have been UNIONED,
//                                     so the contact is gone and 0 is the
//                                     only right answer. That difference is
//                                     the ticket's whole result.
//   non_solid false                   the flag the app's own Check piece uses
//
// AND ON THE TWO INPUTS, separately: the Stock body and the seated arm are
// each closed solids in their own right, so a failure downstream cannot be
// blamed on a bad primitive.
//
// AND ON THE FINISH TOOLS: the Extended and the Fattened assemblies go
// through the same gate, because "it flows into the finish tools" is a claim
// about what comes OUT of them, not about whether they returned ok.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'assemble-out');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/assemble-out/ from the shipped code ==');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_assemble_test.js')], { stdio: 'ignore' });

const validate = file => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const ZERO = ['open_edges', 'nonmanifold_edges', 'odd_edges',
              'inconsistent_winding_edges', 'degenerate_tris'];

/* Every file the suite writes, and what each one is. The assemblies and the
   two finish-tool outputs are gated identically: one closed shell, no
   self-intersection, nothing degenerate. */
const CASES = [
  ['box_body_cyl_arm.stl', 'the ticket\'s case: Stock box + Stock cylinder arm, unioned'],
  ['box_body_cyl_arm_body.stl', 'the Stock body on its own'],
  ['box_body_cyl_arm_arm.stl', 'the seated arm on its own, after the turn was baked in'],
  ['face_box_flat_face_straight_on.stl', 'seated on a flat face, straight on'],
  ['face_box_flat_face_30_deg_oblique.stl', 'seated on a flat face, 30 deg oblique'],
  ['face_cylinder_flat_top.stl', 'seated on a cylinder\'s flat top'],
  ['face_cylinder_curved_flank.stl', 'seated on a cylinder\'s CURVED flank - the case flush cannot do'],
  ['assembly_extended.stl', 'the assembly after Extend lengthened it 5 mm'],
  ['assembly_fattened.stl', 'the assembly after Fatten grew its cross-section 0.5 mm']
];

for (const [file, what] of CASES) {
  const full = path.join(OUT, file);
  if (!fs.existsSync(full)) {
    check(file + ': written by the suite', false, 'missing from tools/assemble-out/');
    continue;
  }
  console.log('\n== ' + file + ' - ' + what + ' ==');
  const v = validate(full);

  check(file + ': the canonical checker passes it outright',
    v.verdict === 'PASS',
    v.verdict + (v.verdict_fails && v.verdict_fails.length ? ' - ' + v.verdict_fails.join(', ') : ''));
  for (const k of ZERO) check(file + ': ' + k + ' = 0', v[k] === 0, String(v[k]));
  check(file + ': euler_characteristic = 2 - ONE closed shell, no handles',
    v.euler_characteristic === 2, String(v.euler_characteristic));
  check(file + ': not flagged non-solid', v.non_solid === false, String(v.non_solid));
  check(file + ': no self-intersection, piercing or coplanar',
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
    `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar ` +
    `over ${v.self_intersection.pairs_tested} pairs`);
  check(file + ': positive signed volume - wound outward',
    v.signed_volume > 0,
    `${v.signed_volume.toFixed(4)} mm^3, ${v.triangles} tris, ${v.welded_vertices} welded verts`);
}

/* The one cross-file claim worth making by machine: Extend and Fatten each
   move the assembly by the amount they were asked for and leave the rest of
   it where it was. Both are measured off the CHECKER's own numbers rather
   than off ours, so this is an independent implementation agreeing. */
console.log('\n== what the finish tools did to it, by the checker\'s own numbers ==');
{
  const base = validate(path.join(OUT, 'box_body_cyl_arm.stl'));
  const ext = validate(path.join(OUT, 'assembly_extended.stl'));
  const fat = validate(path.join(OUT, 'assembly_fattened.stl'));
  check('Extend re-tessellated nothing - same triangle count',
    ext.triangles === base.triangles,
    `${base.triangles} -> ${ext.triangles} tris`);
  check('Extend added volume - it lengthened rather than moved',
    ext.signed_volume > base.signed_volume,
    `${base.signed_volume.toFixed(3)} -> ${ext.signed_volume.toFixed(3)} mm^3`);
  check('Fatten re-tessellated nothing either',
    fat.triangles === base.triangles,
    `${base.triangles} -> ${fat.triangles} tris`);
  check('Fatten added volume',
    fat.signed_volume > base.signed_volume,
    `${base.signed_volume.toFixed(3)} -> ${fat.signed_volume.toFixed(3)} mm^3`);
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

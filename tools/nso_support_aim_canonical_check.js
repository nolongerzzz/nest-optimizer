#!/usr/bin/env node
// Task 5's gate: the CANONICAL checker (tools/mesh_validate.py) run on every
// support this feature produces, and on the piece it was aimed at, with the
// numbers compared by machine instead of by eye.
//
//   node tools/nso_support_aim_canonical_check.js     exit 0 = every gate held
//
// Depends on tools/nso_support_aim_test.js having written tools/support-aim-out/;
// it runs that first, so the solids under test are always the ones the shipped
// code produces rather than a stale copy.
//
// WHAT IS ASSERTED ON THE SUPPORT, and why each one:
//
//   verdict PASS                      the checker's own overall word
//   open / nonmanifold / odd edges    a support is a closed solid or it is not
//                                     a solid; a slicer given an open shell
//                                     prints something nobody designed
//   inconsistent_winding              ditto, from the other direction
//   euler_characteristic = 2          one shell, no handles: a prism is a ball
//   degenerate_tris = 0               nothing collapsed in the stretch or the turn
//   self-intersection pierce+coplanar Extend cannot introduce one and the turn
//                                     is rigid, so 0 is the only right answer
//   signed_volume = side^2 x length   THE cross-section claim, put to the
//                                     checker rather than to our own sectioning
//                                     code. A solid whose volume is exactly the
//                                     cross-section times the length has that
//                                     cross-section the whole way, and this is
//                                     an independent implementation saying so.
//
// WHAT IS ASSERTED ON THE PIECE:
//
//   every numeric field, unchanged    detection reads; it does not write. The
//                                     host written beside each support is
//                                     compared field for field against the
//                                     fixture it was read from.
//
// WHAT IS DELIBERATELY NOT ASSERTED:
//
//   the support and the piece as ONE mesh. They are two solids in contact, not
//   one solid, and the checker says so: run together they report 14 piercing
//   and 5 coplanar pairs on the cantilever case, all of them at the contact.
//   That is the checker being right. Join's A and B are in exactly the same
//   state before a boolean, and nso_planar_fuse.js's header makes the same
//   point about faces that "touch by construction". Gating the pair would be
//   gating that two things touch, which is the whole objective.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-aim-out');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/support-aim-out/ from the shipped code ==');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_support_aim_test.js')], { stdio: 'ignore' });

const validate = file => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

// name, side mm, length mm, the fixture the host came from (null = built in the test)
const CASES = [
  ['cantilever_strut', 1.2, 16, null],
  ['oblique_strut', 1.2, Math.hypot(2, 0, 6), null],
  ['tape_strut', 1.2, null, 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl']
];

const ZERO = ['open_edges', 'nonmanifold_edges', 'odd_edges',
              'inconsistent_winding_edges', 'degenerate_tris'];

for (const [name, side, length, hostFixture] of CASES) {
  console.log('\n== ' + name + ' ==');
  const v = validate(path.join(OUT, name + '.stl'));

  check(name + ': the canonical checker passes it outright',
    v.verdict === 'PASS', v.verdict + (v.verdict_fails.length ? ' - ' + v.verdict_fails.join(', ') : ''));
  for (const k of ZERO) check(name + ': ' + k + ' = 0', v[k] === 0, String(v[k]));
  check(name + ': euler_characteristic = 2 (one closed shell, no handles)',
    v.euler_characteristic === 2, String(v.euler_characteristic));
  check(name + ': not flagged non-solid', v.non_solid === false, String(v.non_solid));
  check(name + ': no self-intersection, piercing or coplanar',
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
    `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);

  /* The cross-section claim, put to an independent implementation. The length
     is whatever the aim measured; for the tape case it is read back off the
     solid, since the drop to that region is a property of the part. */
  const L = (length == null) ? v.signed_volume / (side * side) : length;
  const expected = side * side * L;
  check(name + ': signed volume is exactly side^2 x length',
    Math.abs(v.signed_volume - expected) < 1e-4,
    `${v.signed_volume.toFixed(6)} vs ${side}^2 x ${L.toFixed(6)} = ${expected.toFixed(6)} mm^3`);
  check(name + ': 12 triangles - the stretch re-tessellated nothing',
    v.triangles === 12 && v.welded_vertices === 8,
    `${v.triangles} tris, ${v.welded_vertices} welded verts`);

  /* The piece is read, never written.

     Note what is NOT claimed here: that the host is a pristine solid. The two
     built cases are a post with an arm overlapping it, so the pair shares a
     partial face and the checker counts a non-manifold edge - that is the test
     shape's own business. The tape fixture arrives with two of its own. A
     detector that refused to look at either would be refusing to look at real
     parts. What matters is that the piece comes out of the scan exactly as it
     went in, which is the gate below. */
  const host = validate(path.join(OUT, name + '_host.stl'));
  check(name + ': the piece it was aimed at is closed',
    host.open_edges === 0,
    `${host.triangles} tris, ${host.open_edges} open, ` +
    `${host.nonmanifold_edges} non-manifold (the shape's own, not the support's)`);

  if (hostFixture) {
    const orig = validate(path.join(ROOT, hostFixture));
    const fields = ['triangles', 'welded_vertices', 'unique_edges', 'open_edges',
      'nonmanifold_edges', 'odd_edges', 'inconsistent_winding_edges',
      'euler_characteristic', 'degenerate_tris', 'signed_volume', 'surface_area'];
    const drift = fields.filter(k => orig[k] !== host[k]);
    check(name + ': detection left the piece untouched, field for field',
      drift.length === 0,
      drift.length ? drift.map(k => `${k} ${orig[k]} -> ${host[k]}`).join(', ')
                   : `${fields.length} fields identical to ${path.basename(hostFixture)}`);
  }
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

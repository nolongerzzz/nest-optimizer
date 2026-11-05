/* Split to parts - fixtures, generated in code (never anyone's model). Node only.

   Every soup is a Float32Array, 9 floats per triangle, outward winding unless
   it says otherwise. Boxes share exact corners, so a face of one box and a face
   of its neighbour that meet are on the same welded points.

   box(x0,y0,z0,s)      a closed cube, 12 triangles
   hollowBox()          a 20 mm cube with a 10 mm cavity (wound inward) inside it:
                        2 shells, 1 part
   looseCubes()         three 8 mm cubes, well apart: 3 parts
   touchingFace()       two 10 mm cubes set face to face on one grid: 2 parts
                        (cavityShells reads them as one shell - they share edges)
   touchingEdge()       two cubes that meet along one edge only: 2 parts
   touchingCorner()     two cubes that meet at one corner only: 2 parts
   captiveBall()        a 30 mm cube with a 20 mm cavity and a 6 mm cube (outward)
                        rattling in the cavity: 2 parts, the box one holding the cavity
   hollowInCavity()     the same, the captive cube itself hollow (a 2 mm cavity):
                        2 parts, each holding one cavity - the small cavity goes to
                        the small part and not to the box round it
   hingeLifted()        the print-in-place hinge, as Lift hands it over: fixtures/
                        features/feature-hull_hinge.stl's knuckle with its leaf, lifted
                        off the +Y wall by the real engines (nso_lift_auto.js): 2 shells */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function tri(a, p, q, r) { a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
function boxInto(a, x0, y0, z0, sx, sy, sz, inward) {
  const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  // quads, each wound outward (counter-clockwise seen from outside)
  const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  Q.forEach(q => {
    const v = q.map(i => P[i]);
    if (inward) { tri(a, v[0], v[2], v[1]); tri(a, v[0], v[3], v[2]); }
    else { tri(a, v[0], v[1], v[2]); tri(a, v[0], v[2], v[3]); }
  });
}
const f32 = a => new Float32Array(a);
const box = (x0, y0, z0, s) => { const a = []; boxInto(a, x0, y0, z0, s, s, s, false); return f32(a); };

function hollowBox() { const a = []; boxInto(a, 0, 0, 0, 20, 20, 20, false); boxInto(a, 5, 5, 5, 10, 10, 10, true); return f32(a); }
function looseCubes() { const a = []; [0, 30, 60].forEach(x => boxInto(a, x, 0, 0, 8, 8, 8, false)); return f32(a); }
function touchingFace() { const a = []; boxInto(a, 0, 0, 0, 10, 10, 10, false); boxInto(a, 10, 0, 0, 10, 10, 10, false); return f32(a); }
function touchingEdge() { const a = []; boxInto(a, 0, 0, 0, 10, 10, 10, false); boxInto(a, 10, 10, 0, 10, 10, 10, false); return f32(a); }
function touchingCorner() { const a = []; boxInto(a, 0, 0, 0, 10, 10, 10, false); boxInto(a, 10, 10, 10, 10, 10, 10, false); return f32(a); }
function captiveBall() {
  const a = [];
  boxInto(a, 0, 0, 0, 30, 30, 30, false); boxInto(a, 5, 5, 5, 20, 20, 20, true);
  boxInto(a, 12, 12, 12, 6, 6, 6, false);
  return f32(a);
}
function hollowInCavity() {
  const a = [];
  boxInto(a, 0, 0, 0, 30, 30, 30, false); boxInto(a, 5, 5, 5, 20, 20, 20, true);
  boxInto(a, 12, 12, 12, 6, 6, 6, false); boxInto(a, 14, 14, 14, 2, 2, 2, true);
  return f32(a);
}

/* The hinge, lifted by the real engines (as tools/nso_lift_assembly_drive_check.js
   does through the app): the knuckle with its leaf from the +Y wall. */
function hingeLifted() {
  const { readSTL } = require('./nso_stl_io.js');
  const LA = require(path.join(ROOT, 'nso_lift_auto.js'));
  const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array, Int32Array, Uint8Array, Error, Infinity, NaN, isFinite };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var state = {}; var THREE = {};', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
  const hull = readSTL(path.join(ROOT, 'fixtures', 'features', 'feature-hull_hinge.stl'));
  let seed = -1;
  for (let t = 0; t < hull.length / 9 && seed < 0; t++) {          // a +Y wall triangle clear of the hinge
    const o = t * 9;
    const ux = hull[o + 3] - hull[o], uy = hull[o + 4] - hull[o + 1], uz = hull[o + 5] - hull[o + 2];
    const vx = hull[o + 6] - hull[o], vy = hull[o + 7] - hull[o + 1], vz = hull[o + 8] - hull[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, l = Math.hypot(cx, cy, cz);
    if (cy / l < 0.999 || Math.abs((hull[o + 1] + hull[o + 4] + hull[o + 7]) / 3 - 35) > 0.02) continue;
    if (Math.hypot((hull[o] + hull[o + 3] + hull[o + 6]) / 3 + 45, (hull[o + 2] + hull[o + 5] + hull[o + 8]) / 3 - 20) < 6) seed = t;
  }
  if (seed < 0) throw new Error('hingeLifted: no wall triangle to read from');
  const A = LA.analyse(hull, seed, { curved: true, normal: [0, 1, 0] });
  const ids = LA.offered(A, 0.42);
  const r = LA.lift(hull, A, ids, { rawFlatCapLoops: ctx.rawFlatCapLoops });
  if (!r.ok || r.pieces.length !== 1) throw new Error('hingeLifted: ' + (r.reason || 'lifted ' + r.pieces.length));
  return { soup: r.pieces[0].soup, hull };
}

module.exports = { box, boxInto, hollowBox, looseCubes, touchingFace, touchingEdge, touchingCorner, captiveBall, hollowInCavity, hingeLifted };

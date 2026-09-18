/* The surface grid's geometry, with no browser and no THREE.

   The claim under test is the one the feature lives or dies on: every point
   of every grid line is a point of the SURFACE - so on a dome the grid bends
   over the dome, and a flat grid hung above it would be wrong by a visible
   amount. Both are measured here against soups whose exact geometry is known
   in closed form, which is what a shipped STL cannot give.

   node tools/nso_surface_grid_test.js        exit 0 = every gate held */

const {
  NSO_gridSpacing, NSO_surfaceGridBounds, NSO_surfaceGridLines
} = require('../nso-surface-grid.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* ---- soups ---- */

/** Axis-aligned box about the origin, every face wound normal-out. */
function boxSoup(hx, hy, hz) {
  const h = [hx, hy, hz];
  const out = [];
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;   // u x v = +a
    for (const sg of [1, -1]) {
      const corner = (su, sv) => {
        const p = [0, 0, 0];
        p[a] = sg * h[a]; p[u] = su * h[u]; p[v] = sv * h[v];
        return p;
      };
      // CCW seen from outside, so (b-a) x (c-a) points away from the centre
      const q = sg > 0
        ? [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
        : [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
      out.push(...q[0], ...q[1], ...q[2]);
      out.push(...q[0], ...q[2], ...q[3]);
    }
  }
  return new Float32Array(out);
}

/** UV sphere of radius R about the origin, outward wound. */
function sphereSoup(R, nu, nv) {
  const P = (i, j) => {
    const phi = (j / nv) * Math.PI;           // 0 at +y pole
    const th = (i / nu) * Math.PI * 2;
    return [R * Math.sin(phi) * Math.cos(th), R * Math.cos(phi), R * Math.sin(phi) * Math.sin(th)];
  };
  const out = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      out.push(...a, ...b, ...c);
      out.push(...a, ...c, ...d);
    }
  }
  return new Float32Array(out);
}

/** A soup of walls only - nothing faces up. */
function wallSoup(h) {
  const out = [];
  out.push(-10, 0, 0, 10, 0, 0, 10, h, 0);
  out.push(-10, 0, 0, 10, h, 0, -10, h, 0);
  return new Float32Array(out);
}

const segs = (flat) => {
  const out = [];
  for (let i = 0; i + 5 < flat.length; i += 6) {
    out.push([[flat[i], flat[i + 1], flat[i + 2]], [flat[i + 3], flat[i + 4], flat[i + 5]]]);
  }
  return out;
};
const pts = (flat) => {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const onLadder = (s, spacing, tol) => near(s / spacing - Math.round(s / spacing), 0, tol / spacing);

console.log('\n=== 1. spacing is a number a person can count in ===');
check('80mm wide -> 10mm squares', NSO_gridSpacing(80) === 10, String(NSO_gridSpacing(80)));
check('20mm wide -> 2mm squares', NSO_gridSpacing(20) === 2, String(NSO_gridSpacing(20)));
check('6mm wide -> 0.5mm squares', NSO_gridSpacing(6) === 0.5, String(NSO_gridSpacing(6)));
check('every ladder value is round', NSO_gridSpacing(1000) > 0 && NSO_gridSpacing(1e9) === 500);
check('a zero or bad extent never returns 0', NSO_gridSpacing(0) === 1 && NSO_gridSpacing(NaN) === 1);

console.log('\n=== 2. a flat top: lines lie IN the face, on the grid planes ===');
{
  const soup = boxSoup(10, 5, 10);           // 20 x 20 top at y = +5
  const res = NSO_surfaceGridLines(soup, { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], lift: 0 });
  check('the top face was found', res.faces === 2, res.faces + ' up-facing tris');
  check('spacing chosen from the top face', res.spacing === 2, String(res.spacing));
  check('lines were drawn', res.count > 15, res.count + ' segments');

  const all = pts(res.grid).concat(pts(res.axis));
  check('every point sits exactly in the top face',
    all.every((p) => near(p[1], 5, 1e-6)),
    'max |y-5| = ' + Math.max(...all.map((p) => Math.abs(p[1] - 5))).toExponential(2));
  check('no point came off a side wall or the underside',
    all.every((p) => Math.abs(p[0]) <= 10 + 1e-6 && Math.abs(p[2]) <= 10 + 1e-6));

  const bad = segs(res.grid).concat(segs(res.axis)).filter(([a, b]) => {
    const sameX = near(a[0], b[0], 1e-6) && onLadder(a[0], res.spacing, 1e-6);
    const sameZ = near(a[2], b[2], 1e-6) && onLadder(a[2], res.spacing, 1e-6);
    return !sameX && !sameZ;
  });
  check('every segment lies on a grid plane of one family', bad.length === 0, bad.length + ' strays');

  const axis = pts(res.axis);
  check('the centre cross is the two lines through the middle',
    axis.length > 0 && axis.every((p) => near(p[0], 0, 1e-6) || near(p[2], 0, 1e-6)));
  check('the centre cross is NOT in the plain grid',
    pts(res.grid).every((p) => !(near(p[0], 0, 1e-6) || near(p[2], 0, 1e-6))));
}

console.log('\n=== 3. a curved top: the grid follows the dome, it does not float ===');
{
  const R = 20;
  const soup = sphereSoup(R, 64, 32);
  const res = NSO_surfaceGridLines(soup, { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], lift: 0 });
  check('lines were drawn on the dome', res.count > 100, res.count + ' segments');

  const all = pts(res.grid).concat(pts(res.axis));
  const rad = all.map((p) => Math.hypot(p[0], p[1], p[2]));
  const worst = Math.max(...rad.map((r) => Math.abs(r - R)));
  // A point emitted by the slicer is a point of a triangle, so it is short of
  // the true sphere by at most that triangle's sagitta.
  const sagitta = R * (1 - Math.cos(Math.PI / 32));
  check('every point is ON the sphere, to within the mesh\'s own chord error',
    worst <= sagitta + 1e-6, 'worst ' + worst.toFixed(4) + 'mm, chord error ' + sagitta.toFixed(4) + 'mm');

  const ys = all.map((p) => p[1]);
  const drop = R - Math.min(...ys);
  check('the grid wraps down the dome rather than sitting on one plane',
    drop > R * 0.5, 'it descends ' + drop.toFixed(2) + 'mm from the crown');
  check('a flat grid at the crown would be wrong by millimetres, not microns',
    drop > 100 * (sagitta + 1e-6), 'flat error ' + drop.toFixed(2) + 'mm vs tolerance ' +
    (sagitta + 1e-6).toFixed(4) + 'mm');

  check('nothing was drawn on the underside',
    ys.every((y) => y > 0), 'lowest point y = ' + Math.min(...ys).toFixed(3));

  // Each line is broken into one chord per triangle it crosses; the breaks are
  // where the curvature shows. Consecutive chords must still join up.
  const one = segs(res.grid).filter(([a, b]) => near(a[0], b[0], 1e-9) && near(a[0], res.spacing, 1e-9));
  check('a single grid line is many short chords, not one straight span',
    one.length > 8, one.length + ' chords on the x = ' + res.spacing + 'mm line');
  const spread = Math.max(...one.flat().map((p) => p[1])) - Math.min(...one.flat().map((p) => p[1]));
  check('that one line is itself curved', spread > R * 0.4, 'y spread ' + spread.toFixed(2) + 'mm');
}

console.log('\n=== 4. the lift is along each face\'s own normal, and tiny ===');
{
  const R = 20;
  const soup = sphereSoup(R, 48, 24);
  const lift = 0.05;
  const a = NSO_surfaceGridLines(soup, { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], lift: 0 });
  const b = NSO_surfaceGridLines(soup, { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], lift: lift });
  check('the lift does not change which lines are drawn', a.count === b.count);
  const ra = pts(a.grid).map((p) => Math.hypot(p[0], p[1], p[2]));
  const rb = pts(b.grid).map((p) => Math.hypot(p[0], p[1], p[2]));
  const d = ra.map((r, i) => rb[i] - r);
  check('every point moved outward by the lift, not upward',
    d.every((x) => near(x, lift, 1e-3)),
    'worst ' + Math.max(...d.map((x) => Math.abs(x - lift))).toExponential(2));
}

console.log('\n=== 5. nothing to draw on is not an error ===');
{
  check('an empty soup draws nothing', NSO_surfaceGridLines(new Float32Array(0), {}).count === 0);
  check('a null soup draws nothing', NSO_surfaceGridLines(null, {}).count === 0);
  const walls = NSO_surfaceGridLines(wallSoup(10), { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] });
  check('a piece with no up-facing face draws nothing', walls.count === 0 && walls.faces === 0);
  check('bounds of nothing is null', NSO_surfaceGridBounds(wallSoup(10),
    { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }) === null);
  const one = NSO_surfaceGridLines(boxSoup(0.05, 0.05, 0.05), { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] });
  check('a piece smaller than the finest square still terminates', isFinite(one.count));
}

console.log('\n=== 6. "up" is whatever the caller says it is ===');
{
  // The same box, asked for its +x face: a piece lying on its side must get
  // the grid on the face that is actually facing the sky.
  const soup = boxSoup(5, 10, 10);
  const res = NSO_surfaceGridLines(soup, { up: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], lift: 0 });
  const all = pts(res.grid).concat(pts(res.axis));
  check('lines were drawn on the +x face', res.count > 10 && all.length > 0);
  check('all of them are in that face', all.every((p) => near(p[0], 5, 1e-6)));
}

console.log('\n=== 7. the centre cross marks the middle of the top face ===');
{
  // Top face offset from the piece's own origin: the anchor is the face, not
  // the bounding box of everything.
  const soup = boxSoup(10, 5, 10);
  const shifted = Float32Array.from(soup, (v, i) => (i % 3 === 0 ? v + 33 : v));
  const res = NSO_surfaceGridLines(shifted, { up: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], lift: 0 });
  const axis = pts(res.axis);
  check('the cross followed the face to x = 33',
    axis.length > 0 && axis.every((p) => near(p[0], 33, 1e-6) || near(p[2], 0, 1e-6)));
  check('the grid is symmetric about it',
    near(Math.max(...pts(res.grid).map((p) => p[0])) - 33,
         33 - Math.min(...pts(res.grid).map((p) => p[0])), 1e-6));
}

console.log('');
if (fails) { console.log(fails + ' FAILURE(S)'); process.exit(1); }
console.log('ALL GREEN');

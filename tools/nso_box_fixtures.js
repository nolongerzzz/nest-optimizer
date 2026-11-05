// Box and tray fixtures, built as meshes in the test that uses them - never
// a committed STL and never a file in another repository, so the checks that
// use them always run (locally and in CI) and the wall and floor figures are
// right here in the source.
//
// Built the way a CAD export builds them: every flat face is ONE quad (two
// triangles), with no vertex on it but its corners. That matters to the
// offset: a vertex in the middle of a flat edge can only move across the
// edge, never along it, so a grid-subdivided box shrinks strip by strip and
// refuses as soon as the outermost strip is narrower than the shrink - a
// fact about the tessellation, not the piece. Every coordinate is an integer
// here, so float32 holds each one exactly and a wall read off the mesh is
// the figure written below, to the bit.

/* quads: [a, b, c, d] each, counter-clockwise seen from outside the material. */
function quadSoup(quads) {
  const out = new Float32Array(quads.length * 18);
  let o = 0;
  for (const q of quads) for (const i of [0, 1, 2, 0, 2, 3]) { out[o++] = q[i][0]; out[o++] = q[i][1]; out[o++] = q[i][2]; }
  return out;
}

/* The four side walls of an axis-aligned box x0..x1 x y0..y1, z z0..z1,
   facing out (inward = false) or into the box (inward = true). */
function sides(x0, x1, y0, y1, z0, z1, inward) {
  const q = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],   // -Y
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],   // +X
    [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],   // +Y
    [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]    // -X
  ];
  return inward ? q.map(f => [f[0], f[3], f[2], f[1]]) : q;
}

/* An open tray: L along X, W along Y, H along Z, walls `wall` thick, floor
   `floor` thick, open at the top. Sixteen vertices: the outer box's eight,
   the rim's four inner corners and the floor's four. The 100 x 40 x 25 tray
   with 2 mm walls and floor is tray(100, 40, 25, 2, 2). */
function tray(L, W, H, wall, floor) {
  const a = wall, b = L - wall, c = wall, d = W - wall;
  return quadSoup([
    [[0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]],                       // bottom, facing -Z
    ...sides(0, L, 0, W, 0, H, false),                                  // outer walls
    // the rim: four trapezoids between the outer and inner rectangles at z = H
    [[0, 0, H], [L, 0, H], [b, c, H], [a, c, H]],
    [[L, 0, H], [L, W, H], [b, d, H], [b, c, H]],
    [[L, W, H], [0, W, H], [a, d, H], [b, d, H]],
    [[0, W, H], [0, 0, H], [a, c, H], [a, d, H]],
    ...sides(a, b, c, d, floor, H, true),                               // inner walls
    [[a, c, floor], [b, c, floor], [b, d, floor], [a, d, floor]]        // floor top, facing +Z
  ]);
}

/* A solid bar, L x W x H, corner at the origin: twelve triangles. */
function bar(L, W, H) {
  return quadSoup([
    [[0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]],
    [[0, 0, H], [L, 0, H], [L, W, H], [0, W, H]],
    ...sides(0, L, 0, W, 0, H, false)
  ]);
}

/* The distinct values of one coordinate, ascending: a tray's x layers are
   [0, wall, L - wall, L], so its walls are layer[1] - layer[0] and
   layer[3] - layer[2], read off the mesh itself. */
function layers(soup, axis) {
  const s = new Set();
  for (let i = axis; i < soup.length; i += 3) s.add(soup[i]);
  return Array.from(s).sort((p, q) => p - q);
}

module.exports = { quadSoup, tray, bar, layers };

/* The labelled wall probe for a bored support tree - shared by
   tools/nso_support_tree_round_check.js and tools/nso_support_slice_artifact.js.

     const labelledWalls = require('./nso_support_tree_walls.js');
     const r = labelledWalls(NSO_Thickness, soup, partSoups, floorMm);
*/
'use strict';

/* THE LABELLED WALL PROBE. Every face of the finished solid is classed:
   SKIN when a point just off it (along its outward normal) is outside every
   part, BORE when that point is inside one - a bore is inside a part by
   construction. One ray per face, from its centroid into the material, to
   the first surface; the face it lands on is the other end's class.
     skin <-> bore   a WALL to the outside: must be >= the floor
     bore <-> bore   a MEMBRANE between two bores: measured, reported
     skin <-> skin   solid material (a solid part, a crotch's wedge)
   The probe is nso_thickness.js's ray code - the JS port of mesh_validate.py's
   wall_thickness - reading the kernel's output, not the construction. */
/* opts.exclude(point) -> true skips a reading that starts or lands there -
   used to leave out a support's interface zone, whose lines are one layer
   tall by design (their floor is a line WIDTH, not a height). */
function labelledWalls(TH, soup, partSoups, FLOOR, opts) {
  const exclude = (opts && opts.exclude) || null;
  const P = TH.prepare(soup, {});
  const parts = partSoups.map(s => TH.prepare(s, {}));
  const inAny = p => parts.some(Q => p[0] >= Q.lo[0] && p[0] <= Q.hi[0] && p[1] >= Q.lo[1] && p[1] <= Q.hi[1] &&
                                     p[2] >= Q.lo[2] && p[2] <= Q.hi[2] && Q.inside(p));
  const kind = P.tris.map((T, f) => {
    const n = P.faceNormal(f); if (!n) return 'degenerate';
    const c = [0, 1, 2].map(i => (T[0][i] + T[1][i] + T[2][i]) / 3);
    return inAny([c[0] + n[0] * 1e-3, c[1] + n[1] * 1e-3, c[2] + n[2] * 1e-3]) ? 'bore' : 'skin';
  });
  const res = { faces: { skin: 0, bore: 0 }, wall: { n: 0, min: Infinity, thin: 0, ex: [] },
                membrane: { n: 0, min: Infinity, thin: 0 }, solid: { n: 0, min: Infinity } };
  for (const k of kind) if (res.faces[k] != null) res.faces[k]++;
  P.tris.forEach((T, f) => {
    if (kind[f] === 'degenerate') return;
    const n = P.faceNormal(f), d = [-n[0], -n[1], -n[2]];
    const o = [0, 1, 2].map(i => (T[0][i] + T[1][i] + T[2][i]) / 3 + d[i] * 1e-4);
    if (exclude && exclude(o)) return;
    const hits = P.hitsAlong(o, d, 8); if (!hits.length) return;
    const t = hits[0] + 1e-4, h = [0, 1, 2].map(i => o[i] + d[i] * hits[0]);
    if (exclude && exclude(h)) return;
    const nr = P.nearest(h, 0.05); if (!nr) return;
    const k2 = kind[nr.face];
    const pair = (kind[f] === 'bore' && k2 === 'bore') ? 'membrane' : (kind[f] === 'skin' && k2 === 'skin') ? 'solid' : 'wall';
    const r = res[pair]; r.n++; if (t < r.min) r.min = t;
    if (pair !== 'solid' && t < FLOOR - TH.WELD_TOL) { r.thin++; if (pair === 'wall' && r.ex.length < 4) r.ex.push({ at: o.map(v => +v.toFixed(3)), mm: +t.toFixed(4) }); }
  });
  return res;
}

module.exports = labelledWalls;

/* Lift assemblies - fixtures, generated in code (never anyone's model). Node only.

   posts(cap)   a 70 x 40 x 4 plate, top at z = 4, carrying two print-in-place
                assemblies and one stray part:
                  post A   a post 6 mm across, 14 high, fused to the plate, with a
                           10 mm head on top (the head keeps the collars on) and
                           TWO collars on it: 13 mm across, 3 high, a 0.5 mm
                           radial clearance round the post, at z 6 - 9 and 10.5 - 13.5
                           (nothing holds them but the post going through)
                  post B   the same post, 10 high, with ONE collar (z 6 - 9)
                  a stray  a 4 mm cube floating at z 8 - 12, far from both posts:
                           a shell captured by nothing
                Every collar is its own closed shell, a ring with a real bore.
   stray(cap)   the same plate with the stray cube alone: nothing to lift.

   `cap` is the cut engine's rawFlatCapLoops, which triangulates the plate's top
   round the post footprints. Every soup is a Float32Array, 9 floats per
   triangle, outward winding. `truth` says what the generator put where. */
'use strict';

const TOP = 4, W = 70, D = 40;

function circle(cx, cy, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const at = (P, z) => P.map(p => [p[0], p[1], z]);

class Soup {
  constructor() { this.a = []; }
  tri(p, q, r) { this.a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
  quad(p, q, r, s) { this.tri(p, q, r); this.tri(p, r, s); }
  wall(A, B) { for (let i = 0; i < A.length; i++) { const j = (i + 1) % A.length; this.quad(A[i], A[j], B[j], B[i]); } }
  fan(P, up) { for (let i = 1; i < P.length - 1; i++) up ? this.tri(P[0], P[i], P[i + 1]) : this.tri(P[0], P[i + 1], P[i]); }
  push(arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i]); }
  f32() { return new Float32Array(this.a); }
}

/* A ring (outer ro, bore ri) from z0 to z1: its own closed shell. */
function collar(S, cx, cy, ro, ri, z0, z1, n) {
  const O = circle(cx, cy, ro, n), I = circle(cx, cy, ri, n);
  S.wall(at(O, z0), at(O, z1));
  const Ib = at(I, z0), It = at(I, z1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; S.quad(Ib[j], Ib[i], It[i], It[j]); }      // the bore faces in
  const Ot = at(O, z1), Ob = at(O, z0);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; S.quad(Ot[i], Ot[j], It[j], It[i]); }      // top annulus, up
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; S.quad(Ob[j], Ob[i], Ib[i], Ib[j]); }      // bottom annulus, down
}

/* A post standing on the plate with a head: a shaft of radius r from TOP up to
   the head, the head (radius rh) over the last `hh` mm. Returns the footprint. */
function post(S, cx, cy, r, h, rh, hh, n) {
  const P = circle(cx, cy, r, n), H = circle(cx, cy, rh, n), z1 = TOP + h - hh;
  S.wall(at(P, TOP), at(P, z1));
  const Hb = at(H, z1), Pb = at(P, z1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; S.quad(Hb[j], Hb[i], Pb[i], Pb[j]); }       // the head's underside, down
  S.wall(at(H, z1), at(H, TOP + h));
  S.fan(at(H, TOP + h), true);
  return P;
}

function cube(S, x0, y0, z0, s) {
  const B = rect(x0, y0, x0 + s, y0 + s);
  S.wall(at(B, z0), at(B, z0 + s));
  S.fan(at(B, z0), false);
  S.fan(at(B, z0 + s), true);
}

function plateBody(S, cap, holes) {
  const sq = rect(-W / 2, -D / 2, W / 2, D / 2);
  S.fan(at(sq, 0), false);
  S.wall(at(sq, 0), at(sq, TOP));
  S.push(cap([at(sq, TOP)].concat(holes.map(h => at(h, TOP))), 2, TOP, false));
}

function posts(cap) {
  const S = new Soup(), N = 24, holes = [];
  const truth = { posts: [], collars: [], stray: null };
  [{ x: -15, h: 14, collars: [[6, 9], [10.5, 13.5]], name: 'A' }, { x: 15, h: 10, collars: [[6, 9]], name: 'B' }].forEach(p => {
    holes.push(post(S, p.x, 0, 3, p.h, 5, 3, N));
    truth.posts.push({ name: p.name, center: [p.x, 0], heightMm: p.h, collars: p.collars.length });
    p.collars.forEach(([z0, z1]) => {
      collar(S, p.x, 0, 6.5, 3.5, z0, z1, N);
      truth.collars.push({ post: p.name, z: [z0, z1], clearanceMm: 0.5 });
    });
  });
  cube(S, -2, 12, 8, 4);
  truth.stray = { x: [-2, 2], y: [12, 16], z: [8, 12] };
  plateBody(S, cap, holes);
  return { soup: S.f32(), truth, top: TOP, size: [W, D, TOP] };
}

function stray(cap) {
  const S = new Soup();
  cube(S, -2, 12, 8, 4);
  plateBody(S, cap, []);
  return { soup: S.f32(), truth: { stray: { x: [-2, 2], y: [12, 16], z: [8, 12] } }, top: TOP, size: [W, D, TOP] };
}

module.exports = { posts, stray, TOP };

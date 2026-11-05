/* Lift fixtures, generated in code (not in nest-library). Node only.

   plate(cap)          the ticket's 60 x 60 x 3 plate, top at z = 3, carrying
                       five dots (2 mm across, 0.6 high) in a dice-five grid,
                       a raised line (30 x 1 x 0.6), a ring (8 mm outer, 6 mm
                       bore, 0.8 high), a spherical-cap bump (8 mm across,
                       1.5 high) and a texture of 48 small bumps (1.2 mm
                       square frustums, 0.5 high). Every detail is a prism
                       with real vertical walls, fused into the plate's top
                       through a hole of its own footprint - the "real flat
                       faces" case. `cap` is the cut engine's rawFlatCapLoops,
                       which triangulates the top round its holes.
   cylinder(r, h, n)   a closed n-sided cylinder standing on z = 0: the curved
                       face the ticket says must be refused.
   rounded(cap)        a 60 x 40 x 6 block whose two long top edges are
                       rounded (r 2, six 15-degree strips): a big flat face
                       that meets gentle bends, which must NOT be refused.
   stepped(cap)        a block with a step: the higher half is the body, and
                       picking the lower top must not offer it.

   Every soup is a Float32Array, 9 floats per triangle, outward winding.
   `truth` lists each detail: its kind, footprint centre, height and volume
   (the prism's own, from its footprint polygon). */
'use strict';

const TOP = 3;

function polyArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function circle(cx, cy, r, n, phase) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (phase || 0) + 2 * Math.PI * i / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}
function rect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }

class Soup {
  constructor() { this.a = []; }
  tri(p, q, r) { this.a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
  quad(p, q, r, s) { this.tri(p, q, r); this.tri(p, r, s); }
  /* A wall from ring A (lower) to ring B (upper), both CCW seen from +Z:
     faces outward (away from the ring's inside). */
  wall(A, B) {
    for (let i = 0; i < A.length; i++) {
      const j = (i + 1) % A.length;
      this.quad(A[i], A[j], B[j], B[i]);
    }
  }
  /* A convex CCW polygon as a fan, facing +Z (up) or -Z. */
  fan(P, up) {
    for (let i = 1; i < P.length - 1; i++) up ? this.tri(P[0], P[i], P[i + 1]) : this.tri(P[0], P[i + 1], P[i]);
  }
  push(arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i]); }
  f32() { return new Float32Array(this.a); }
}

const at = (P, z) => P.map(p => [p[0], p[1], z]);

/* A prism standing on the plate: walls up from z = TOP, a flat top. Returns
   its footprint (the hole it needs in the plate's top). */
function prism(S, P, h) {
  S.wall(at(P, TOP), at(P, TOP + h));
  S.fan(at(P, TOP + h), true);
  return { hole: P, volume: polyArea(P) * h };
}

/* The ring: outer and inner walls, an annulus on top. The bore's floor is
   the plate itself, a disc at z = TOP inside the inner circle. */
function ring(S, cx, cy, ro, ri, h, n) {
  const O = circle(cx, cy, ro, n), I = circle(cx, cy, ri, n);
  S.wall(at(O, TOP), at(O, TOP + h));
  // inner wall faces the bore (inward): walk it the other way
  const Ib = at(I, TOP), It = at(I, TOP + h);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    S.quad(Ib[j], Ib[i], It[i], It[j]);
  }
  const Ot = at(O, TOP + h);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    S.quad(Ot[i], Ot[j], It[j], It[i]);
  }
  S.fan(at(I, TOP), true);                     // the bore's floor: plate
  return { hole: O, volume: (polyArea(O) - polyArea(I)) * h };
}

/* A spherical cap: base circle radius r (n sides), height h, `bands` rings
   up to a pole fan. */
function sphereCap(S, cx, cy, r, h, n, bands) {
  const R = (r * r + h * h) / (2 * h), zc = TOP + h - R;
  const a0 = Math.asin(r / R);                 // polar angle of the base ring
  const rings = [];
  for (let j = 0; j <= bands; j++) {
    const a = a0 * (1 - j / (bands + 1));
    const rr = R * Math.sin(a), z = j === 0 ? TOP : zc + R * Math.cos(a);
    rings.push(circle(cx, cy, j === 0 ? r : rr, n).map(p => [p[0], p[1], z]));
  }
  for (let j = 0; j < bands; j++) S.wall(rings[j], rings[j + 1]);
  const pole = [cx, cy, TOP + h], last = rings[bands];
  for (let i = 0; i < n; i++) S.tri(last[i], last[(i + 1) % n], pole);
  return { hole: circle(cx, cy, r, n), volume: null };
}

/* A small square frustum: base side b, top side t, height h. */
function frustum(S, cx, cy, b, t, h) {
  const B = rect(cx - b / 2, cy - b / 2, cx + b / 2, cy + b / 2);
  const T = rect(cx - t / 2, cy - t / 2, cx + t / 2, cy + t / 2);
  S.wall(at(B, TOP), at(T, TOP + h));
  S.fan(at(T, TOP + h), true);
  return { hole: B, volume: h / 3 * (b * b + t * t + b * t) };
}

function signedVolume(a, from, to) {
  let v = 0;
  for (let o = from; o < to; o += 9) {
    v += a[o] * (a[o + 4] * a[o + 8] - a[o + 5] * a[o + 7]) - a[o + 1] * (a[o + 3] * a[o + 8] - a[o + 5] * a[o + 6]) +
         a[o + 2] * (a[o + 3] * a[o + 7] - a[o + 4] * a[o + 6]);
  }
  return v / 6;
}

function plate(cap) {
  const S = new Soup(), holes = [], truth = [];
  function add(kind, cx, cy, h, fn) {
    const from = S.a.length;
    const r = fn();
    holes.push(r.hole);
    const to = S.a.length;
    truth.push({ kind, center: [cx, cy], heightMm: h, hole: r.hole, volume: r.volume, from, to });
  }
  // five dots, dice-five, 2 mm across, 0.6 high
  [[-22, 14], [-14, 14], [-18, 18], [-22, 22], [-14, 22]].forEach(c =>
    add('dot', c[0], c[1], 0.6, () => prism(S, circle(c[0], c[1], 1, 16), 0.6)));
  // a raised line 30 x 1 x 0.6
  add('line', 0, -20, 0.6, () => prism(S, rect(-15, -20.5, 15, -19.5), 0.6));
  // a ring 8 mm outer, 6 mm bore
  add('ring', 10, 18, 0.8, () => ring(S, 10, 18, 4, 3, 0.8, 32));
  // a spherical-cap bump, 8 mm across, 1.5 high
  add('cap', -12, -5, 1.5, () => sphereCap(S, -12, -5, 4, 1.5, 32, 6));
  // a texture of 48 small bumps, 8 x 6 at 2.5 mm
  for (let j = 0; j < 6; j++) for (let i = 0; i < 8; i++) {
    const cx = 8 + 2.5 * i, cy = -12 + 2.5 * j;
    add('texture', cx, cy, 0.5, () => frustum(S, cx, cy, 1.2, 0.6, 0.5));
  }
  // the plate: bottom, four sides, a top with every footprint as a hole
  const featTo = S.a.length;
  const sq = rect(-30, -30, 30, 30);
  S.fan(at(sq, 0), false);
  S.wall(at(sq, 0), at(sq, TOP));
  const loops = [at(sq, TOP)].concat(holes.map(h => at(h, TOP)));
  S.push(cap(loops, 2, TOP, false));
  const soup = S.f32();
  // each detail's volume: its own triangles closed by its footprint, a flat
  // disc at z = TOP facing down (the ring's bore floor, facing up, cancels
  // the disc over the bore)
  truth.forEach(t => {
    const closed = Array.from(soup.slice(t.from, t.to));
    const down = new Soup();
    down.fan(at(t.hole, TOP), false);
    t.volume = signedVolume(new Float32Array(closed.concat(down.a)), 0, closed.length + down.a.length);
    t.tris = (t.to - t.from) / 9 - (t.kind === 'ring' ? 30 : 0);
  });
  return { soup, truth, top: TOP, size: [60, 60, TOP], featureTris: featTo / 9 };
}

function cylinder(r, h, n) {
  const S = new Soup(), C = circle(0, 0, r, n);
  S.fan(at(C, 0), false);
  S.wall(at(C, 0), at(C, h));
  S.fan(at(C, h), true);
  return S.f32();
}

/* A block 60 (x) x 40 (y) x 6, its two long top edges rounded by r. The
   section (in YZ) is extruded along X; the ends are capped by `cap`. */
function rounded(cap) {
  const r = 2, steps = 6, W = 20, H = 6;
  // the section: right wall up to H - r, arc to (W - r, H), across, arc down
  const S2 = [[-W, 0], [W, 0], [W, H - r]];
  for (let i = 1; i <= steps; i++) { const a = (Math.PI / 2) * i / steps; S2.push([W - r + r * Math.cos(a), H - r + r * Math.sin(a)]); }
  for (let i = 0; i <= steps; i++) { const a = Math.PI / 2 + (Math.PI / 2) * i / steps; S2.push([-W + r + r * Math.cos(a), H - r + r * Math.sin(a)]); }
  // S2: CCW in (y, z)
  const S = new Soup(), X0 = -30, X1 = 30;
  const P = (x, q) => [x, q[0], q[1]];
  for (let i = 0; i < S2.length; i++) {
    const a = S2[i], b = S2[(i + 1) % S2.length];
    S.quad(P(X0, a), P(X0, b), P(X1, b), P(X1, a));
  }
  const L0 = S2.map(q => P(X0, q)), L1 = S2.map(q => P(X1, q));
  S.push(cap([L0], 0, X0, true));
  S.push(cap([L1], 0, X1, false));
  return S.f32();
}

/* A stepped block: 60 (x) x 40 (y), 3 high for y < 0 and 6 high for
   y >= 0. Picking the low top, the high half stands proud of it - and it
   runs down the part's own sides, so it is the body, never a detail. */
function stepped(cap) {
  const S2 = [[-20, 0], [20, 0], [20, 6], [0, 6], [0, 3], [-20, 3]];
  const S = new Soup(), X0 = -30, X1 = 30;
  const P = (x, q) => [x, q[0], q[1]];
  for (let i = 0; i < S2.length; i++) {
    const a = S2[i], b = S2[(i + 1) % S2.length];
    S.quad(P(X0, a), P(X0, b), P(X1, b), P(X1, a));
  }
  S.push(cap([S2.map(q => P(X0, q))], 0, X0, true));
  S.push(cap([S2.map(q => P(X1, q))], 0, X1, false));
  return S.f32();
}

module.exports = { plate, cylinder, rounded, stepped, TOP, polyArea, circle };

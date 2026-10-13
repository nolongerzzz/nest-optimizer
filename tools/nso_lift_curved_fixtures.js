/* Lift 3 fixtures, generated in code (never anyone's model or G-code). Node only.

   sphere()      a ball 40 mm across (an icosphere, 6 subdivisions: 81,920
                 triangles, edges about 0.35 mm) with 14 bumps pushed out of
                 it radially - the canonical "spiky ball": spikes (cones
                 2.4 mm high, 2 mm in radius) on the six axes, domes
                 (paraboloids 1.2 mm high, 3 mm in radius) on the eight
                 diagonals. The bumps are the ball's own vertices moved out,
                 so each rises out of the surface through its own triangles,
                 as a sculpted or scanned model does.
   dome()        a 60 x 60 slab whose top is a gentle dome (radius of
                 curvature 80 mm: 13 mm thick in the middle, 1.75 at the
                 corners) at 0.3 mm per sample, with eight dots (2.2 mm
                 across, 0.6 high), a 36 mm squiggle 1.2 mm wide, and a
                 plaque 10 mm across - more than the clear surface measured
                 round it, so its lift says what the fill cannot know.
   cylinder()    a closed cylinder 30 mm across and 60 long, lying along X
                 (0.4 mm facets round and along), with 8 bumps on its side:
                 spikes and domes as on the sphere, and one long ridge
                 running round it (an arc 1.2 mm wide, 16 mm long).

   `truth` lists what the generator put where: kind, centre (a point on the
   base surface under the bump's middle), the outward normal there, height,
   and `base(p)` - the true surface under any point (for the gates that ask
   how close the fill comes to it). sphere({ bumps: false }) is the bare ball. */
'use strict';

const LA_FX = require('./nso_lift_auto_fixtures.js');

function norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/* ---------------------------------------------------------------- icosphere */

function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
           [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
           [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = new Map(), F2 = [];
    const m = (a, b) => {
      const k = a < b ? a + ':' + b : b + ':' + a;
      if (!mid.has(k)) { V.push(norm([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); mid.set(k, V.length - 1); }
      return mid.get(k);
    };
    F.forEach(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); });
    F = F2;
  }
  return { V, F };
}

/* A bump's height at angular distance `ang` (radians) on a ball of radius R:
   d = R * ang along the surface. */
const PROFILE = {
  spike: (d, b) => d < b.r ? b.h * (1 - d / b.r) : 0,
  dome: (d, b) => d < b.r ? b.h * (1 - (d / b.r) * (d / b.r)) : 0
};

function sphere(opts) {
  const o = Object.assign({ R: 20, sub: 6, bumps: true }, opts || {});
  const { V, F } = icosphere(o.sub);
  const bumps = [];
  if (o.bumps) {
  [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].forEach(a => bumps.push({ kind: 'spike', dir: a, h: 2.4, r: 2 }));
  [-1, 1].forEach(x => [-1, 1].forEach(y => [-1, 1].forEach(z => bumps.push({ kind: 'dome', dir: norm([x, y, z]), h: 1.2, r: 3 }))));
  // A small turn, so no bump's axis lies on a lattice symmetry line.
  const turn = p => { const c = Math.cos(0.13), s = Math.sin(0.13); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
  bumps.forEach(b => { b.dir = norm(turn(b.dir)); });
  }
  bumps.forEach(b => { b.top = 0; });
  const P = V.map(v => {
    let h = 0;
    bumps.forEach(b => {
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(v, b.dir)))), hb = PROFILE[b.kind](o.R * ang, b);
      h = Math.max(h, hb); b.top = Math.max(b.top, hb);
    });
    const r = o.R + h;
    return [v[0] * r, v[1] * r, v[2] * r];
  });
  const soup = new Float32Array(F.length * 9);
  F.forEach((f, i) => { for (let k = 0; k < 3; k++) for (let q = 0; q < 3; q++) soup[i * 9 + k * 3 + q] = P[f[k]][q]; });
  // heightMm: the highest any of its vertices was pushed (a cone's tip falls
  // between the lattice's vertices, so it is less than the profile's h)
  const truth = bumps.map(b => ({ kind: b.kind, center: b.dir.map(x => x * o.R), normal: b.dir, heightMm: b.top, profileMm: b.h, radiusMm: b.r }));
  return { soup, truth, R: o.R, base: p => Math.hypot(p[0], p[1], p[2]) - o.R, surfaceNormal: p => norm(p) };
}

/* ---------------------------------------------------------------- the dome */

function dome() {
  const R = 80, c = 30;
  const base = (x, y) => 13 - ((x - c) * (x - c) + (y - c) * (y - c)) / (2 * R);
  const inDisc = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
  const details = [], truth = [];
  [[30, 30], [18, 42], [42, 44], [12, 12], [47, 14], [9, 50], [50, 50], [30, 12]].forEach(p => {
    details.push({ inside: inDisc(p[0], p[1], 1.1), h: 0.6 });
    truth.push({ kind: 'dot', center: p, heightMm: 0.6 });
  });
  const sq = [];
  for (let i = 0; i <= 72; i++) { const x = 12 + 36 * i / 72; sq.push([x, 22 + 3 * Math.sin(2 * Math.PI * (x - 12) / 12)]); }
  const band = (pts, w) => (x, y) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
      const px = a[0] + t * vx - x, py = a[1] + t * vy - y;
      if (px * px + py * py <= w * w / 4) return true;
    }
    return false;
  };
  details.push({ inside: band(sq, 1.2), h: 0.6 });
  truth.push({ kind: 'squiggle', center: [30, 22], heightMm: 0.6, lengthMm: 36 });
  // a plaque bigger than the clear surface measured round it: the honest ceiling
  details.push({ inside: inDisc(30, 47, 5), h: 0.6 });
  truth.push({ kind: 'plaque', center: [30, 47], heightMm: 0.6 });
  const field = (x, y) => { let h = 0; for (const d of details) if (d.inside(x, y)) h = Math.max(h, d.h); return base(x, y) + h; };
  const sl = LA_FX.slab(60, 60, 0.3, field);
  return Object.assign(sl, { truth, R, base: p => p[2] - base(p[0], p[1]), baseZ: base });
}

/* ------------------------------------------------------------- the cylinder */

function cylinder() {
  const R = 15, L = 60, nA = Math.round(2 * Math.PI * R / 0.4), nL = Math.round(L / 0.4);
  const bumps = [
    { kind: 'spike', x: 10, a: 0.3, h: 2.0, r: 2 },
    { kind: 'dome', x: 22, a: 1.4, h: 1.0, r: 2.6 },
    { kind: 'spike', x: 35, a: 2.5, h: 2.0, r: 2 },
    { kind: 'dome', x: 48, a: 3.6, h: 1.0, r: 2.6 },
    { kind: 'dome', x: 15, a: 4.7, h: 1.0, r: 2.6 },
    { kind: 'spike', x: 42, a: 5.6, h: 2.0, r: 2 },
    { kind: 'dome', x: 30, a: 0.9, h: 0.8, r: 1.8 }
  ];
  // the ridge: round the cylinder at x = 30, from angle 3.0 to 3.0 + 16/R, 1.2 wide, 0.6 high
  const ridge = { kind: 'ridge', x: 30, a0: 3.0, a1: 3.0 + 16 / R, w: 1.2, h: 0.6 };
  function height(x, a) {
    let h = 0;
    bumps.forEach(b => {
      let da = Math.abs(a - b.a); da = Math.min(da, 2 * Math.PI - da);
      const d = Math.hypot(x - b.x, R * da);
      h = Math.max(h, PROFILE[b.kind](d, b));
    });
    if (a >= ridge.a0 && a <= ridge.a1 && Math.abs(x - ridge.x) <= ridge.w / 2) h = Math.max(h, ridge.h);
    return h;
  }
  const P = (i, j) => {
    const x = L * j / nL, a = 2 * Math.PI * (i % nA) / nA, r = R + height(x, a);
    return [x, r * Math.cos(a), r * Math.sin(a)];
  };
  const out = [];
  const tri = (p, q, r) => out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  for (let j = 0; j < nL; j++) {
    for (let i = 0; i < nA; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      // outward: (x along j, angle along i) - the side faces away from the axis
      tri(a, b, c); tri(a, c, d);
    }
  }
  // the end caps: fans to the centre
  const c0 = [0, 0, 0], c1 = [L, 0, 0];
  for (let i = 0; i < nA; i++) { tri(c0, P(i + 1, 0), P(i, 0)); tri(c1, P(i, nL), P(i + 1, nL)); }
  const truth = bumps.map(b => ({ kind: b.kind, center: [b.x, R * Math.cos(b.a), R * Math.sin(b.a)], normal: [0, Math.cos(b.a), Math.sin(b.a)], heightMm: b.h, radiusMm: b.r }));
  const am = (ridge.a0 + ridge.a1) / 2;
  truth.push({ kind: 'ridge', center: [ridge.x, R * Math.cos(am), R * Math.sin(am)], normal: [0, Math.cos(am), Math.sin(am)], heightMm: ridge.h, lengthMm: 16 });
  return { soup: new Float32Array(out), truth, R, L, base: p => Math.hypot(p[1], p[2]) - R, surfaceNormal: p => norm([0, p[1], p[2]]) };
}

module.exports = { sphere, dome, cylinder, icosphere };

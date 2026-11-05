/* Lift 2 fixtures, generated in code (never anyone's model or G-code). Node only.

   flat(cap)       a 60 x 60 x 3 plate, top at z = 3, every detail a prism with
                   real vertical walls fused into the top through a hole of its
                   own footprint (Phase 1's "real flat faces" case): five dots,
                   a raised line, a letter-like squiggle (an S), a ring, two dots
                   that overlap into one body (touching details), and a
                   mushroom - a stem with a wider cap, so an undercut.
   slab(W, D, s, fn)  a closed height-field slab like Picture's: a grid of
                   samples every s mm, top at fn(x, y), bottom at z = 0, sides.
                   Details rise out of the base through one sample's slope.
   dish()          a gently curved dish (a bowl, radius of curvature 150 mm)
                   with dots and one long squiggle across it.
   noisy()         a relief whose paper is not flat: +-0.08 mm of noise, with
                   raised blobs and a bar on it.
   stepped()       a base of 0.2 mm layer steps, 5 mm terraces, with details.
   leaves()        three leaf shapes meeting at a stem (one body) and one apart.
   big(s)          a dish slab at s mm per sample, for the speed check.
   box(w, d, h)    a plain closed box (12 triangles).

   `truth` lists what the generator put where: kind, centre, height. */
'use strict';

const TOP = 3;

function polyArea(P) {
  let a = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function circle(cx, cy, r, n, phase) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = (phase || 0) + 2 * Math.PI * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
function rect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
const at = (P, z) => P.map(p => [p[0], p[1], z]);

class Soup {
  constructor() { this.a = []; }
  tri(p, q, r) { this.a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
  quad(p, q, r, s) { this.tri(p, q, r); this.tri(p, r, s); }
  wall(A, B) { for (let i = 0; i < A.length; i++) { const j = (i + 1) % A.length; this.quad(A[i], A[j], B[j], B[i]); } }
  push(arr) { for (let i = 0; i < arr.length; i++) this.a.push(arr[i]); }
  f32() { return new Float32Array(this.a); }
}

/* A prism of any simple CCW outline: walls up from z0, a flat top capped by
   the cut engine (it ear-clips non-convex outlines). */
function prism(S, cap, P, z0, h) {
  S.wall(at(P, z0), at(P, z0 + h));
  S.push(cap([at(P, z0 + h)], 2, z0 + h, false));
  return { hole: P, volume: polyArea(P) * h };
}

/* A thick polyline as one simple CCW outline. */
function band(pts, w) {
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty);
    const nx = -ty / l, ny = tx / l;
    L.push([pts[i][0] + nx * w / 2, pts[i][1] + ny * w / 2]);
    R.push([pts[i][0] - nx * w / 2, pts[i][1] - ny * w / 2]);
  }
  const P = R.concat(L.reverse());
  return polyArea(P) > 0 ? P : P.reverse();
}

/* Two overlapping circles of radius r, centres 2c apart along x: the outline
   of their union, CCW. */
function pair(cx, cy, r, c, n) {
  const th = Math.acos(c / r);                       // half-angle of the overlap, seen from each centre
  const out = [];
  // right circle: from (pi - th) round through 0 to -(pi - th)... CCW: start at -(pi - th)
  for (let i = 0; i <= n; i++) { const a = -(Math.PI - th) + 2 * (Math.PI - th) * i / n; out.push([cx + c + r * Math.cos(a), cy + r * Math.sin(a)]); }
  for (let i = 1; i < n; i++) { const a = th + 2 * (Math.PI - th) * i / n; out.push([cx - c + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

function signedVolume(a) {
  let v = 0;
  for (let o = 0; o + 8 < a.length; o += 9) {
    v += a[o] * (a[o + 4] * a[o + 8] - a[o + 5] * a[o + 7]) - a[o + 1] * (a[o + 3] * a[o + 8] - a[o + 5] * a[o + 6]) +
         a[o + 2] * (a[o + 3] * a[o + 7] - a[o + 4] * a[o + 6]);
  }
  return v / 6;
}

function flat(cap) {
  const S = new Soup(), holes = [], truth = [];
  function add(kind, cx, cy, h, fn) {
    const from = S.a.length, r = fn();
    holes.push(r.hole);
    truth.push({ kind, center: [cx, cy], heightMm: h, hole: r.hole, volume: r.volume, from, to: S.a.length });
  }
  [[-22, 14], [-14, 14], [-18, 18], [-22, 22], [-14, 22]].forEach(c =>
    add('dot', c[0], c[1], 0.6, () => prism(S, cap, circle(c[0], c[1], 1, 16), TOP, 0.6)));
  add('line', 0, -20, 0.6, () => prism(S, cap, rect(-15, -20.5, 15, -19.5), TOP, 0.6));
  const sq = [];
  for (let i = 0; i <= 48; i++) { const x = -20 + 16 * i / 48; sq.push([x, -5 + 2.5 * Math.sin(2 * Math.PI * (x + 20) / 10)]); }
  add('squiggle', -12, -5, 0.6, () => prism(S, cap, band(sq, 1), TOP, 0.6));
  add('ring', 10, 18, 0.8, () => {
    const O = circle(10, 18, 4, 32), I = circle(10, 18, 3, 32), h = 0.8;
    S.wall(at(O, TOP), at(O, TOP + h));
    const Ib = at(I, TOP), It = at(I, TOP + h), Ot = at(O, TOP + h);
    for (let i = 0; i < 32; i++) { const j = (i + 1) % 32; S.quad(Ib[j], Ib[i], It[i], It[j]); S.quad(Ot[i], Ot[j], It[j], It[i]); }
    S.push(cap([at(I, TOP)], 2, TOP, false));               // the bore's floor: plate
    return { hole: O, volume: (polyArea(O) - polyArea(I)) * h };
  });
  add('pair', 0, 8, 0.6, () => prism(S, cap, pair(0, 8, 1.2, 0.9, 16), TOP, 0.6));
  add('mushroom', 18, -6, 1.4, () => {
    const st = circle(18, -6, 1, 16), cp = circle(18, -6, 3, 32), z1 = TOP + 0.8, z2 = TOP + 1.4;
    S.wall(at(st, TOP), at(st, z1));                         // the stem
    // the cap's underside: the annulus between stem and rim at z1, facing down
    S.push(cap([at(cp, z1), at(st, z1).slice().reverse()], 2, z1, true));
    S.wall(at(cp, z1), at(cp, z2));
    S.push(cap([at(cp, z2)], 2, z2, false));
    return { hole: st, volume: polyArea(st) * 0.8 + polyArea(cp) * 0.6 };
  });
  const sqr = rect(-30, -30, 30, 30);
  const bottom = cap([at(sqr, 0)], 2, 0, true);
  S.push(bottom);
  S.wall(at(sqr, 0), at(sqr, TOP));
  S.push(cap([at(sqr, TOP)].concat(holes.map(h => at(h, TOP))), 2, TOP, false));
  const soup = S.f32();
  truth.forEach(t => {
    const own = Array.from(soup.slice(t.from, t.to));
    const down = new Soup();
    down.push(cap([at(t.hole, TOP)], 2, TOP, true));
    t.volume = signedVolume(new Float32Array(own.concat(down.a)));
    if (t.kind === 'ring') t.volume += 0;                      // its bore floor faces up and cancels the disc under the bore
  });
  return { soup, truth, top: TOP };
}

/* ------------------------------------------------------------- height fields */

function slab(W, D, s, fn) {
  const nx = Math.round(W / s), ny = Math.round(D / s), dx = W / nx, dy = D / ny;
  const z = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) z[j * (nx + 1) + i] = fn(i * dx, j * dy);
  const T = (i, j) => [i * dx, j * dy, z[j * (nx + 1) + i]];
  const Bt = (i, j) => [i * dx, j * dy, 0];
  const S = new Soup();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      S.tri(T(i, j), T(i + 1, j), T(i + 1, j + 1)); S.tri(T(i, j), T(i + 1, j + 1), T(i, j + 1));
      S.tri(Bt(i, j), Bt(i + 1, j + 1), Bt(i + 1, j)); S.tri(Bt(i, j), Bt(i, j + 1), Bt(i + 1, j + 1));
    }
  }
  // sides: the outline CCW seen from above, each edge p -> q walled q -> p
  const loop = [];
  for (let i = 0; i < nx; i++) loop.push([i, 0]);
  for (let j = 0; j < ny; j++) loop.push([nx, j]);
  for (let i = nx; i > 0; i--) loop.push([i, ny]);
  for (let j = ny; j > 0; j--) loop.push([0, j]);
  for (let q = 0; q < loop.length; q++) {
    const P = loop[q], R = loop[(q + 1) % loop.length];
    S.quad(Bt(P[0], P[1]), Bt(R[0], R[1]), T(R[0], R[1]), T(P[0], P[1]));
  }
  return { soup: S.f32(), nx, ny, dx, dy };
}

/* Masks for height-field details (1 inside, 0 outside). */
const inDisc = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
function inBand(pts, w) {
  return (x, y) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
      const px = a[0] + t * vx - x, py = a[1] + t * vy - y;
      if (px * px + py * py <= w * w / 4) return true;
    }
    return false;
  };
}
function inEllipse(cx, cy, a, b, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return (x, y) => { const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c; return (u * u) / (a * a) + (v * v) / (b * b) <= 1; };
}
function detailField(base, details) {
  return (x, y) => {
    let h = 0;
    for (const d of details) if (d.inside(x, y)) h = Math.max(h, d.h);
    return base(x, y) + h;
  };
}

/* The dish: z = 3 + r^2 / 300 (a bowl of 150 mm radius of curvature) on a
   60 x 60 slab at 0.3 mm per sample, with dots and one long squiggle. */
function dish(s) {
  s = s || 0.3;
  const base = (x, y) => 3 + ((x - 30) * (x - 30) + (y - 30) * (y - 30)) / 300;
  const truth = [], details = [];
  [[30, 30], [20, 40], [40, 42], [12, 12], [48, 15], [8, 50]].forEach(c => {
    details.push({ inside: inDisc(c[0], c[1], 1.1), h: 0.6 });
    truth.push({ kind: 'dot', center: c, heightMm: 0.6 });
  });
  const sq = [];
  for (let i = 0; i <= 80; i++) { const x = 10 + 40 * i / 80; sq.push([x, 24 + 3 * Math.sin(2 * Math.PI * (x - 10) / 13)]); }
  details.push({ inside: inBand(sq, 1.2), h: 0.6 });
  truth.push({ kind: 'squiggle', center: [30, 24], heightMm: 0.6, lengthMm: 40 });
  const sl = slab(60, 60, s, detailField(base, details));
  return Object.assign(sl, { truth, base });
}

/* A tiny deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/* Paper that is not flat: 40 x 40 at 0.4 mm, +-amp of noise per sample, with
   three blobs and a bar 1 mm high. */
function noisy(amp) {
  amp = amp == null ? 0.08 : amp;
  const R = rng(7), s = 0.4, nx = 100, noise = new Float64Array((nx + 1) * (nx + 1));
  for (let i = 0; i < noise.length; i++) noise[i] = (R() * 2 - 1) * amp;
  const base = (x, y) => 2 + noise[Math.round(y / s) * (nx + 1) + Math.round(x / s)];
  const truth = [], details = [];
  [[10, 10, 2], [28, 12, 1.5], [12, 30, 2.5]].forEach(c => {
    details.push({ inside: inDisc(c[0], c[1], c[2]), h: 1 });
    truth.push({ kind: 'blob', center: [c[0], c[1]], heightMm: 1 });
  });
  details.push({ inside: inBand([[22, 28], [34, 32]], 1.5), h: 1 });
  truth.push({ kind: 'bar', center: [28, 30], heightMm: 1 });
  const sl = slab(40, 40, s, detailField(base, details));
  return Object.assign(sl, { truth, amp });
}

/* A print's layer steps: 60 x 40 at 0.3 mm, terraces 5 mm wide rising 0.2 mm
   each, with dots on terraces, one dot across a step and a short bar across
   two steps. */
function stepped() {
  const base = (x) => 2 + 0.2 * Math.floor(x / 5);
  const truth = [], details = [];
  [[7.5, 10], [22.5, 30], [37.5, 12], [52.5, 28]].forEach(c => {
    details.push({ inside: inDisc(c[0], c[1], 1.2), h: 0.8 });
    truth.push({ kind: 'dot on a terrace', center: c, heightMm: 0.8 });
  });
  details.push({ inside: inDisc(30, 20, 1.5), h: 0.8 });
  truth.push({ kind: 'dot across a step', center: [30, 20], heightMm: 0.8 });
  details.push({ inside: inBand([[13, 22], [23, 22]], 1.2), h: 0.8 });
  truth.push({ kind: 'bar across two steps', center: [18, 22], heightMm: 0.8 });
  const sl = slab(60, 40, 0.3, detailField(base, details));
  return Object.assign(sl, { truth });
}

/* Leaves: three ellipses meeting at a stem (they overlap there, 0.3 mm: one body)
   and one leaf apart. 50 x 40 at 0.25 mm, 0.8 mm high on z = 2. */
function leaves() {
  const base = () => 2, details = [], truth = [];
  const stem = [18, 20];
  [0, 2 * Math.PI / 3, 4 * Math.PI / 3].forEach(a => {
    const cx = stem[0] + 7 * Math.cos(a), cy = stem[1] + 7 * Math.sin(a);
    details.push({ inside: inEllipse(cx, cy, 7.3, 2.6, a), h: 0.8 });
  });
  truth.push({ kind: 'three leaves at a stem', center: stem, heightMm: 0.8, parts: 3 });
  details.push({ inside: inEllipse(40, 20, 6, 2.5, 0.5), h: 0.8 });
  truth.push({ kind: 'one leaf', center: [40, 20], heightMm: 0.8, parts: 1 });
  const sl = slab(50, 40, 0.25, detailField(base, details));
  return Object.assign(sl, { truth });
}

/* Where the bend tolerance bites: a bowl of radius of curvature R (mm),
   48 x 48 at 0.3 mm, with straight bars 1.2 mm wide and 0.6 high of the
   given lengths, each in its own row across the middle. */
function dishBars(R, lengths) {
  const W = 48, c = W / 2, base = (x, y) => 3 + ((x - c) * (x - c) + (y - c) * (y - c)) / (2 * R);
  const details = [], truth = [];
  lengths.forEach((L, i) => {
    const y = c + (i - (lengths.length - 1) / 2) * 5;
    details.push({ inside: inBand([[c - L / 2, y], [c + L / 2, y]], 1.2), h: 0.6 });
    truth.push({ kind: 'bar ' + L + ' mm', center: [c, y], lengthMm: L, heightMm: 0.6 });
  });
  const sl = slab(W, W, 0.3, detailField(base, details));
  return Object.assign(sl, { truth, R });
}

/* The dish, dense: for the speed check. */
function big(s) { return dish(s); }

function box(w, d, h) {
  const S = new Soup(), B = at(rect(0, 0, w, d), 0), Tp = at(rect(0, 0, w, d), h);
  S.tri(B[0], B[2], B[1]); S.tri(B[0], B[3], B[2]);
  S.tri(Tp[0], Tp[1], Tp[2]); S.tri(Tp[0], Tp[2], Tp[3]);
  S.wall(B, Tp);
  return S.f32();
}

module.exports = { flat, slab, dish, dishBars, noisy, stepped, leaves, big, box, polyArea, circle, TOP, signedVolume };

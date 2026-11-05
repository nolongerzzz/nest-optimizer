/* nso_shells_fixtures.js - fixtures for SHELLS AS PIECES, generated in code (never anyone's model). Node only.

   vase(opts)    a thrown vase: ONE closed shell for the body (a lathe: outer wall, rim, inner
                 wall, floor), and a SECOND closed shell, the handle - a tube swept in an arc
                 off the +X side, its two ends sunk into the wall - so the handle crosses the
                 body's outer skin in two rings. opts.segs x opts.rings sets the size (the body
                 is 4 * segs * rings triangles); opts.inward winds the handle inward (a handle
                 modelled inside-out, which cavityShells reads as a hollow); opts.handle false
                 leaves the body alone. This is the stand-in for the user's vase
                 (tools/fixtures-local/, never committed): same structure, not the same mesh.
   twoBodies()   a vase body and, well clear of it, a cube: a free second shell, not touching.
   cubeShell(...) helpers re-used by the tests.

   Every soup is a Float32Array, 9 floats per triangle, outward winding (unless inward). */
'use strict';

class Soup {
  constructor() { this.a = []; }
  tri(p, q, r) { this.a.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
  quad(p, q, r, s) { this.tri(p, q, r); this.tri(p, r, s); }
  f32() { return new Float32Array(this.a); }
}

/* The vase's profile: radius at height h (0..H). A belly, a neck, a flared lip. */
function outerR(h, H) {
  const t = h / H;
  return 22 + 14 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - 9 * Math.exp(-Math.pow((t - 0.78) / 0.12, 2)) + 5 * Math.max(0, t - 0.92) * 12;
}

function body(S, segs, rings, H, wall) {
  const ring = (r, z) => { const out = []; for (let i = 0; i < segs; i++) { const a = 2 * Math.PI * i / segs; out.push([r * Math.cos(a), r * Math.sin(a), z]); } return out; };
  const O = [], I = [];
  for (let k = 0; k <= rings; k++) { const h = H * k / rings; O.push(ring(outerR(h, H), h)); I.push(ring(Math.max(0.5, outerR(h, H) - wall), h + (k === 0 ? wall : 0))); }
  for (let k = 0; k < rings; k++) for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    S.quad(O[k][i], O[k][j], O[k + 1][j], O[k + 1][i]);                 // outer wall, facing out
    S.quad(I[k][j], I[k][i], I[k + 1][i], I[k + 1][j]);                 // inner wall, facing in
  }
  // the floor underneath, the rim on top, the floor inside
  const c0 = [0, 0, 0], c1 = [0, 0, wall];
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; S.tri(c0, O[0][j], O[0][i]); S.tri(c1, I[0][i], I[0][j]); }
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; S.quad(O[rings][i], O[rings][j], I[rings][j], I[rings][i]); }
}

/* A tube along the arc from wall point to wall point, closed at both ends (inside the wall). */
function handle(S, H, wall, inward, nU, nV) {
  const r = 2.6, z0 = H * 0.30, z1 = H * 0.66, R0 = outerR(z0, H), R1 = outerR(z1, H);
  const A = [R0 - wall * 0.45, 0, z0], B = [R1 - wall * 0.45, 0, z1];
  const reach = 20;
  const path = [];
  for (let u = 0; u <= nU; u++) {
    const t = u / nU, s = Math.sin(Math.PI * t);
    path.push([A[0] + (B[0] - A[0]) * t + reach * s, 0, A[2] + (B[2] - A[2]) * t]);
  }
  const frames = path.map((p, u) => {
    const q = path[Math.min(nU, u + 1)], o = path[Math.max(0, u - 1)];
    let tx = q[0] - o[0], tz = q[2] - o[2]; const L = Math.hypot(tx, tz); tx /= L; tz /= L;
    const ring = [];
    for (let v = 0; v < nV; v++) {
      const a = 2 * Math.PI * v / nV, nx = -tz, nz = tx;                 // normal in the XZ plane, binormal along Y
      ring.push([p[0] + r * (Math.cos(a) * nx), r * Math.sin(a), p[2] + r * (Math.cos(a) * nz)]);
    }
    return { ring, p, t: [tx, 0, tz] };
  });
  const T = new Soup();
  for (let u = 0; u < nU; u++) for (let v = 0; v < nV; v++) {
    const w = (v + 1) % nV, a = frames[u].ring, b = frames[u + 1].ring;
    T.quad(a[v], b[v], b[w], a[w]);
  }
  for (let v = 0; v < nV; v++) { const w = (v + 1) % nV; T.tri(frames[0].p, frames[0].ring[v], frames[0].ring[w]); T.tri(frames[nU].p, frames[nU].ring[w], frames[nU].ring[v]); }
  const a = T.a;
  if (!inward) { for (let i = 0; i < a.length; i++) S.a.push(a[i]); return; }
  for (let o = 0; o < a.length; o += 9) S.a.push(a[o], a[o + 1], a[o + 2], a[o + 6], a[o + 7], a[o + 8], a[o + 3], a[o + 4], a[o + 5]);
}

function vase(opts) {
  opts = opts || {};
  const segs = opts.segs || 96, rings = opts.rings || 60, H = 120, wall = 3.2, S = new Soup();
  body(S, segs, rings, H, wall);
  const bodyTris = S.a.length / 9;
  if (opts.handle !== false) handle(S, H, wall, !!opts.inward, opts.nU || 40, opts.nV || 18);
  const soup = S.f32();
  return { soup, bodyTris, handleTris: soup.length / 9 - bodyTris };
}

/* A closed axis-aligned box as 12 triangles, outward (or inward) winding. */
function cubeShell(S, x0, y0, z0, x1, y1, z1, inward) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const q = (a, b, c, d) => inward ? S.quad(P[a], P[d], P[c], P[b]) : S.quad(P[a], P[b], P[c], P[d]);
  q(0, 3, 2, 1); q(4, 5, 6, 7); q(0, 1, 5, 4); q(2, 3, 7, 6); q(1, 2, 6, 5); q(3, 0, 4, 7);
}

/* A vase body and a cube far from it: a free second shell. */
function twoBodies(opts) {
  const v = vase(Object.assign({ handle: false, segs: 48, rings: 30 }, opts || {})), S = new Soup();
  for (let i = 0; i < v.soup.length; i++) S.a.push(v.soup[i]);
  cubeShell(S, 60, -8, 0, 76, 8, 16, false);
  return { soup: S.f32(), bodyTris: v.bodyTris };
}

/* A 30 mm cube with a 10 x 10 x 40 pin through it, ends out both sides: two shells that CROSS. With the pin
   wound inward (a part modelled inside-out) cavityShells reads it as a hollow - sunk in material, inward-wound -
   which is what Split to parts used to say. */
function pinThrough(inward) {
  const S = new Soup();
  cubeShell(S, 0, 0, 0, 30, 30, 30, false);
  cubeShell(S, 10, 10, -5, 20, 20, 35, !!inward);
  return S.f32();
}

module.exports = { Soup, vase, twoBodies, cubeShell, pinThrough };

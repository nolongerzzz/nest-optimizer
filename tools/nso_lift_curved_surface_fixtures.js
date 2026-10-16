/* Fixtures for lift:curved-surface - synthetic, closed, manifold, each under 20k triangles.

   cylinderBody(): a vase's worth of curved wall - a 60 mm across, 40 mm high solid cylinder on the
     z axis (lattice 1.18 x 1.0 mm), with
       - a torus handle: a tube of ~3 mm radius swept round half a torus (major radius 10 mm) from the
         wall at z = 10 to the wall at z = 30, at angle 0. Its two ends are sewn to the wall's own
         lattice vertices (a circular block of cells is left out and the tube starts on the loop it
         leaves), so the handle is welded to the cylinder, not sitting on it;
       - a sphere bump: a spherical cap 5 mm across the foot, 3.5 mm tall, on a 0.8 mm plinth, at angle
         180 degrees, z = 20, made by pushing the wall's vertices out.
   domeRing(): a 40 x 40 mm plate, 0.8 mm lattice, flat underneath, its top a dome of radius 80 mm, with a
     raised ring (r 7 - 9.4 mm, 1.2 mm high, vertical walls) pushed out of it. The bore floor inside the
     ring is the dome itself.

   Both return { soup: Float32Array, ... } with what a test needs to know about the construction. */
'use strict';

function Mesh() {
  const key = new Map(), pos = [], tris = [];
  return {
    pos, tris,
    v(x, y, z) {
      const f = new Float32Array([x, y, z]);
      const k = f[0] + ',' + f[1] + ',' + f[2];
      let id = key.get(k);
      if (id == null) { id = pos.length / 3; key.set(k, id); pos.push(f[0], f[1], f[2]); }
      return id;
    },
    t(a, b, c) { if (a !== b && b !== c && a !== c) tris.push([a, b, c]); },
    soup() {
      const s = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => t.forEach((v, k) => { s[i * 9 + k * 3] = pos[v * 3]; s[i * 9 + k * 3 + 1] = pos[v * 3 + 1]; s[i * 9 + k * 3 + 2] = pos[v * 3 + 2]; }));
      return s;
    }
  };
}

function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

function cylinderBody(o) {
  o = Object.assign({ R: 30, H: 40, Nth: 160, Nz: 40, handleRho: 3.3, handleZ1: 10, handleZ2: 30, handleRings: 48,
    bumpA: 5, bumpH: 3.5, bumpPlinth: 0.8, bumpZ: 20 }, o || {});
  const { R, H, Nth, Nz } = o, ds = 2 * Math.PI * R / Nth, dz = H / Nz;
  const M = Mesh();
  const wrap = i => ((i % Nth) + Nth) % Nth;
  // the bump: lattice vertices within bumpA of the bump's centre (arc, z) are pushed out
  const bi = Nth / 2, bj = Math.round(o.bumpZ / dz);
  const Rs = (o.bumpA * o.bumpA + o.bumpH * o.bumpH) / (2 * o.bumpH);
  function radiusAt(i, j) {
    let rr = R;
    const di = Math.min(Math.abs(i - bi), Nth - Math.abs(i - bi)) * ds, dj = (j - bj) * dz, r = Math.hypot(di, dj);
    if (r < o.bumpA) rr += o.bumpPlinth + (Math.sqrt(Rs * Rs - r * r) - (Rs - o.bumpH));
    return rr;
  }
  const vid = (i, j) => { i = wrap(i); const th = 2 * Math.PI * i / Nth, rr = radiusAt(i, j); return M.v(rr * Math.cos(th), rr * Math.sin(th), j * dz); };
  // the handle's two holes: cells whose centre is within handleRho of a root vertex (angle 0)
  const roots = [Math.round(o.handleZ1 / dz), Math.round(o.handleZ2 / dz)];
  const removed = new Set();
  roots.forEach(rj => {
    for (let i = -8; i <= 8; i++) for (let j = rj - 8; j <= rj + 7; j++) {
      if (Math.hypot((i + 0.5) * ds, (j + 0.5 - rj) * dz) <= o.handleRho) removed.add(wrap(i) + ',' + j);
    }
  });
  const gone = (i, j) => removed.has(wrap(i) + ',' + j);
  const bedge = [new Map(), new Map()];                // per root: directed boundary edge a -> b of the kept triangles next to a hole
  for (let j = 0; j < Nz; j++) {
    for (let i = 0; i < Nth; i++) {
      if (gone(i, j)) continue;
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1);
      M.t(a, b, c); M.t(a, c, d);
      const which = Math.abs(j - roots[0]) < Math.abs(j - roots[1]) ? 0 : 1;
      if (gone(i, j - 1)) bedge[which].set(a, b);
      if (gone(i + 1, j)) bedge[which].set(b, c);
      if (gone(i, j + 1)) bedge[which].set(c, d);
      if (gone(i - 1, j)) bedge[which].set(d, a);
    }
  }
  // caps
  const top = M.v(0, 0, H), bot = M.v(0, 0, 0);
  for (let i = 0; i < Nth; i++) {
    M.t(top, vid(i, Nz), vid(i + 1, Nz));
    M.t(bot, vid(i + 1, 0), vid(i, 0));
  }
  // the loops, in the kept triangles' direction, from the lowest vertex
  function chain(map) {
    const ids = [...map.keys()];
    const at = id => [M.pos[id * 3], M.pos[id * 3 + 1], M.pos[id * 3 + 2]];
    ids.sort((p, q) => { const A = at(p), B = at(q); return A[2] - B[2] || A[1] - B[1] || A[0] - B[0]; });
    const L = [ids[0]];
    for (let n = map.get(ids[0]); n !== ids[0]; n = map.get(n)) { L.push(n); if (L.length > ids.length) throw new Error('hole loop does not close'); }
    if (L.length !== ids.length) throw new Error('hole boundary is more than one loop');
    return L;
  }
  const L0 = chain(bedge[0]), L1 = chain(bedge[1]), m = L0.length;
  if (L1.length !== m) throw new Error('the two holes differ');
  const P = id => [M.pos[id * 3], M.pos[id * 3 + 1], M.pos[id * 3 + 2]];
  const z1 = roots[0] * dz, z2 = roots[1] * dz, Rm = (z2 - z1) / 2, zm = (z1 + z2) / 2;
  const C = t => [R + Rm * Math.sin(Math.PI * t), 0, zm - Rm * Math.cos(Math.PI * t)];
  const T = t => [Math.cos(Math.PI * t), 0, Math.sin(Math.PI * t)];
  const N1 = t => [-Math.sin(Math.PI * t), 0, Math.cos(Math.PI * t)];
  // offsets of the loop vertices from the root, in the tube's frame (n1, y, T)
  const off0 = L0.map(id => { const p = P(id); return { a: p[2] - z1, b: p[1], c: p[0] - R }; });
  // the far end: ring i must meet loop vertex j with offset (a, b) = (-(z - z2), y) of the same (a, b) as i's, and run the other way round
  const ends = L1.map(id => { const p = P(id); return { a: -(p[2] - z2), b: p[1], c: -(p[0] - R), id }; });
  let best = null;
  for (let s = 0; s < m; s++) {
    let err = 0;
    for (let i = 0; i < m; i++) { const e = ends[((s - i) % m + m) % m], o0 = off0[i]; err += Math.hypot(e.a - o0.a, e.b - o0.b); }
    if (!best || err < best.err) best = { s, err };
  }
  if (best.err / m > 0.05) throw new Error('the handle\'s ends do not pair up (' + (best.err / m).toFixed(3) + ' mm)');
  const end = i => ends[((best.s - i) % m + m) % m];
  const rho = off0.reduce((s, q) => s + Math.hypot(q.a, q.b), 0) / m, K = o.handleRings;
  const rings = [L0];
  for (let k = 1; k < K; k++) {
    const t = k / K, near = Math.min(t, 1 - t) * K, w = smooth(near / 6), ring = [];
    for (let i = 0; i < m; i++) {
      const q = t < 0.5 ? off0[i] : end(i), ang = Math.atan2(q.b, q.a);
      const a = (1 - w) * q.a + w * rho * Math.cos(ang), b = (1 - w) * q.b + w * rho * Math.sin(ang), c = (1 - w) * q.c;
      const Ct = C(t), n1 = N1(t), Tt = T(t);
      ring.push(M.v(Ct[0] + a * n1[0] + c * Tt[0], Ct[1] + b + a * n1[1] + c * Tt[1], Ct[2] + a * n1[2] + c * Tt[2]));
    }
    rings.push(ring);
  }
  rings.push(Array.from({ length: m }, (_, i) => end(i).id));
  for (let k = 0; k < K; k++) {
    const r0 = rings[k], r1 = rings[k + 1];
    for (let i = 0; i < m; i++) {
      const i1 = (i + 1) % m;
      M.t(r0[i1], r0[i], r1[i]);
      M.t(r0[i1], r1[i], r1[i1]);
    }
  }
  return {
    soup: M.soup(), R, H, handle: { z1, z2, theta: 0, rho, loopVerts: m }, bump: { theta: Math.PI, z: o.bumpZ, a: o.bumpA, h: o.bumpH + o.bumpPlinth },
    radialAt: (x, y) => Math.hypot(x, y)
  };
}

function domeRing(o) {
  o = Object.assign({ L: 20, N: 50, Rd: 80, T: 8, r1: 7, r2: 9.4, h: 1.2 }, o || {});
  const { L, N, Rd, T } = o, d = 2 * L / N, M = Mesh();
  const zDome = (x, y) => T - (Rd - Math.sqrt(Rd * Rd - x * x - y * y));
  const zTop = (x, y) => { const r = Math.hypot(x, y); return zDome(x, y) + (r >= o.r1 - 1e-9 && r <= o.r2 + 1e-9 ? o.h : 0); };
  const X = i => -L + i * d;
  const tv = (i, j) => M.v(X(i), X(j), zTop(X(i), X(j))), bv = (i, j) => M.v(X(i), X(j), 0);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = tv(i, j), b = tv(i + 1, j), c = tv(i + 1, j + 1), e = tv(i, j + 1);
      M.t(a, b, c); M.t(a, c, e);
      const A = bv(i, j), B = bv(i + 1, j), Cc = bv(i + 1, j + 1), E = bv(i, j + 1);
      M.t(A, Cc, B); M.t(A, E, Cc);
    }
  }
  for (let i = 0; i < N; i++) {
    M.t(bv(i, 0), bv(i + 1, 0), tv(i + 1, 0)); M.t(bv(i, 0), tv(i + 1, 0), tv(i, 0));           // y = -L, faces -y
    M.t(bv(i + 1, N), bv(i, N), tv(i, N)); M.t(bv(i + 1, N), tv(i, N), tv(i + 1, N));           // y = +L, faces +y
    M.t(bv(0, i + 1), bv(0, i), tv(0, i)); M.t(bv(0, i + 1), tv(0, i), tv(0, i + 1));           // x = -L, faces -x
    M.t(bv(N, i), bv(N, i + 1), tv(N, i + 1)); M.t(bv(N, i), tv(N, i + 1), tv(N, i));           // x = +L, faces +x
  }
  return { soup: M.soup(), Rd, T, r1: o.r1, r2: o.r2, h: o.h, domeZ: zDome, centreZ: T + 0 };
}

module.exports = { cylinderBody, domeRing };

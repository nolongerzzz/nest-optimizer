// Smoke test: outer-rim-only fillet on a solid box and a slotted cable-bar.
// Mirrors the clip + buildFilletedSide path without Three.js / the browser.
// Usage: node tools/cut_fillet_smoke.mjs
import {
  buildCornerAwareFillet,
  detectCorners,
  signedArea,
  checkWatertight,
} from '../fillet.mjs';
import fs from 'fs';

const EPS = 1e-4;

function boxTris(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const x0 = ox, x1 = ox + sx, y0 = oy, y1 = oy + sy, z0 = oz, z1 = oz + sz;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return faces.map(([a, b, c]) => [v[a], v[b], v[c]]);
}

/** Solid bar minus axis-aligned rectangular through-slots (boolean via triangle soup approx: outer box + hole walls). */
function cableBarTris() {
  // 120×20×12 bar along X, two through-slots in Y (open top-to-bottom) along Z depth.
  // Modelled as outer shell walls + slot liners so a mid-X cut yields 1 outer + 2 hole loops.
  const L = 120, W = 20, H = 12;
  const slots = [
    { x0: 30, x1: 42, z0: 4, z1: 16 },
    { x0: 70, x1: 82, z0: 4, z1: 16 },
  ];
  // Build as CSG-free: outer box, then for each slot add an inner box "cut" by
  // only emitting the slot's four vertical walls + we rely on clip edges.
  // Simpler robust approach: triangulate a frame extrusion at several X slabs.
  // Use outer box and subtract slots by not putting faces in slot regions —
  // build the solid as 3 segments between slots plus side rails.
  const tris = [];
  const addBox = (sx, sy, sz, ox, oy, oz) => {
    for (const t of boxTris(sx, sy, sz, ox, oy, oz)) tris.push(t);
  };
  // Left rail, between-slot blocks, right rail — full height/width chunks with gaps at slots.
  // Chunks along X where material exists for all Z, plus Z-side rails through slot X ranges.
  const cuts = [0, ...slots.flatMap(s => [s.x0, s.x1]), L].filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-9);
  for (let i = 0; i < cuts.length - 1; i++) {
    const x0 = cuts[i], x1 = cuts[i + 1];
    const sx = x1 - x0;
    if (sx < 1e-9) continue;
    const inSlot = slots.some(s => x0 >= s.x0 - 1e-9 && x1 <= s.x1 + 1e-9);
    if (!inSlot) {
      addBox(sx, H, W, x0, 0, 0);
    } else {
      const sl = slots.find(s => x0 >= s.x0 - 1e-9 && x1 <= s.x1 + 1e-9);
      // Side rails in Z outside the slot opening
      addBox(sx, H, sl.z0 - 0, x0, 0, 0);
      addBox(sx, H, W - sl.z1, x0, 0, sl.z1);
    }
  }
  return tris;
}

function flatFromTris(tris) {
  const out = [];
  for (const [a, b, c] of tris) out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  return out;
}

function clipFlatSide(flat, axis, plane, keepMin) {
  const out = [];
  const edges = [];
  const coord = v => axis === 'x' ? v[0] : axis === 'y' ? v[1] : v[2];
  const classify = c => c < plane - EPS ? -1 : c > plane + EPS ? 1 : 0;
  const isKept = side => keepMin ? side <= 0 : side >= 0;
  const interp = (a, b, ca, cb) => {
    const den = cb - ca;
    const t = Math.abs(den) < 1e-12 ? 0.5 : (plane - ca) / den;
    const tt = Math.min(1, Math.max(0, t));
    const p = [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt];
    if (axis === 'x') p[0] = plane; else if (axis === 'y') p[1] = plane; else p[2] = plane;
    return p;
  };
  const almostSame = (a, b) => Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;
  const pushTri = (a, b, c) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  const triCount = Math.floor(flat.length / 9);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const verts = [
      [flat[i0], flat[i0 + 1], flat[i0 + 2]],
      [flat[i0 + 3], flat[i0 + 4], flat[i0 + 5]],
      [flat[i0 + 6], flat[i0 + 7], flat[i0 + 8]],
    ];
    const cs = verts.map(coord);
    const sides = cs.map(classify);
    const kept = sides.map(isKept);
    const nKeep = (kept[0] ? 1 : 0) + (kept[1] ? 1 : 0) + (kept[2] ? 1 : 0);
    if (nKeep === 0) continue;
    if (nKeep === 3) {
      if (sides[0] === 0 && sides[1] === 0 && sides[2] === 0) continue;
      pushTri(verts[0], verts[1], verts[2]);
      continue;
    }
    const poly = [];
    const cutPts = [];
    for (let e = 0; e < 3; e++) {
      const a = verts[e], b = verts[(e + 1) % 3];
      const ca = cs[e], cb = cs[(e + 1) % 3];
      const sa = sides[e], sb = sides[(e + 1) % 3];
      const ka = kept[e], kb = kept[(e + 1) % 3];
      if (ka) poly.push(a);
      if (sa !== sb && sa * sb === -1) {
        const p = interp(a, b, ca, cb);
        poly.push(p);
        cutPts.push(p);
      } else if (sa !== sb && (sa === 0 || sb === 0)) {
        const onPt = sa === 0 ? a : b;
        if (ka !== kb) {
          if (!almostSame(poly.length ? poly[poly.length - 1] : [1e9, 0, 0], onPt)) {
            if (!ka) poly.push(onPt);
          }
          cutPts.push(onPt);
        }
      }
    }
    const clean = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      if (!clean.length || !almostSame(clean[clean.length - 1], p)) clean.push(p);
    }
    if (clean.length >= 2 && almostSame(clean[0], clean[clean.length - 1])) clean.pop();
    if (clean.length < 3) continue;
    for (let i = 1; i < clean.length - 1; i++) pushTri(clean[0], clean[i], clean[i + 1]);
    if (cutPts.length >= 2) {
      let a = cutPts[0], b = cutPts[0];
      for (let i = 1; i < cutPts.length; i++) { if (!almostSame(a, cutPts[i])) { b = cutPts[i]; break; } }
      if (!almostSame(a, b)) edges.push([a, b]);
    }
  }
  return { out, edges };
}

function walkLoops(edges, axis, plane) {
  const TOL = 1e-4;
  const keyOf = p => {
    let a, b;
    if (axis === 'x') { a = p[1]; b = p[2]; } else if (axis === 'y') { a = p[0]; b = p[2]; } else { a = p[0]; b = p[1]; }
    return (Math.round(a / TOL) * TOL) + '|' + (Math.round(b / TOL) * TOL);
  };
  const snap = p => {
    const q = [p[0], p[1], p[2]];
    if (axis === 'x') q[0] = plane; else if (axis === 'y') q[1] = plane; else q[2] = plane;
    return q;
  };
  const nodePos = new Map(), adj = new Map();
  const addNode = p => {
    const s = snap(p);
    const k = keyOf(s);
    if (!nodePos.has(k)) nodePos.set(k, s);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  };
  edges.forEach(pair => {
    if (!pair || pair.length < 2) return;
    const k0 = addNode(pair[0]), k1 = addNode(pair[1]);
    if (k0 === k1) return;
    adj.get(k0).add(k1);
    adj.get(k1).add(k0);
  });
  const visited = new Set();
  const ek = (a, b) => a < b ? a + '~' + b : b + '~' + a;
  const loops = [];
  for (const start of adj.keys()) {
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visited.has(e0)) continue;
      const loopKeys = [start];
      let prev = start, cur = nb;
      visited.add(e0);
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        loopKeys.push(cur);
        const nbs = adj.get(cur);
        if (!nbs || !nbs.size) break;
        let next = null;
        for (const cand of nbs) {
          if (cand === prev) continue;
          const e = ek(cur, cand);
          if (visited.has(e)) continue;
          next = cand;
          visited.add(e);
          break;
        }
        if (next == null) break;
        prev = cur;
        cur = next;
      }
      if (cur === start && loopKeys.length >= 3) loops.push(loopKeys.map(k => nodePos.get(k)));
    }
  }
  return loops;
}

function earClip2D(poly) {
  if (!poly || poly.length < 3) return [];
  const clean = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) clean.push([a[0], a[1]]);
  }
  if (clean.length < 3) return [];
  let area = 0;
  for (let i = 0; i < clean.length; i++) {
    const j = (i + 1) % clean.length;
    area += clean[i][0] * clean[j][1] - clean[j][0] * clean[i][1];
  }
  const pts = area < 0 ? clean.slice().reverse() : clean.slice();
  const V = pts.map(p => ({ u: p[0], v: p[1] }));
  const tris = [];
  const isInside = (a, b, c, p) => {
    const v0x = c.u - a.u, v0y = c.v - a.v;
    const v1x = b.u - a.u, v1y = b.v - a.v;
    const v2x = p.u - a.u, v2y = p.v - a.v;
    const dot00 = v0x * v0x + v0y * v0y, dot01 = v0x * v1x + v0y * v1y, dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y, dot12 = v1x * v2x + v1y * v2y;
    const inv = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-30);
    const u = (dot11 * dot02 - dot01 * dot12) * inv;
    const v = (dot00 * dot12 - dot01 * dot02) * inv;
    return u >= -1e-9 && v >= -1e-9 && (u + v) <= 1 + 1e-9;
  };
  const isConvex = (prev, curr, next) =>
    (curr.u - prev.u) * (next.v - prev.v) - (curr.v - prev.v) * (next.u - prev.u) > 1e-12;
  let guard = 0;
  while (V.length > 3 && guard++ < 10000) {
    let clipped = false;
    const n = V.length;
    for (let i = 0; i < n; i++) {
      const prev = V[(i + n - 1) % n], curr = V[i], next = V[(i + 1) % n];
      if (!isConvex(prev, curr, next)) continue;
      let empty = true;
      for (let k = 0; k < n; k++) {
        if (k === i || k === (i + n - 1) % n || k === (i + 1) % n) continue;
        if (isInside(prev, curr, next, V[k])) { empty = false; break; }
      }
      if (!empty) continue;
      tris.push([[prev.u, prev.v], [curr.u, curr.v], [next.u, next.v]]);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      for (let i = 1; i < V.length - 1; i++) tris.push([[V[0].u, V[0].v], [V[i].u, V[i].v], [V[i + 1].u, V[i + 1].v]]);
      break;
    }
  }
  if (V.length === 3) tris.push([[V[0].u, V[0].v], [V[1].u, V[1].v], [V[2].u, V[2].v]]);
  return tris;
}

function triangulateFaceWithHoles(outer, holes) {
  const orient = (loop, wantPositive) => {
    const a = signedArea(loop);
    if (wantPositive ? a < 0 : a > 0) return loop.slice().reverse();
    return loop.slice();
  };
  let poly = orient(outer, true);
  for (const hole0 of (holes || []).filter(h => h && h.length >= 3)) {
    const hole = orient(hole0, false);
    let hi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
    const hp = hole[hi];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const d = Math.hypot(poly[i][0] - hp[0], poly[i][1] - hp[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    const rotated = hole.slice(hi).concat(hole.slice(0, hi));
    const injected = [poly[best]].concat(rotated).concat([[poly[best][0], poly[best][1]]]);
    poly = poly.slice(0, best + 1).concat(injected.slice(1)).concat(poly.slice(best + 1));
  }
  return earClip2D(poly);
}

/** Port of buildFilletedSide (outer-rim only). */
function buildFilletedSide(wallPositions, edges, axis, plane, keepMin, R) {
  const outward = keepMin ? 1 : -1;
  const into = -outward;
  const planeR = plane + into * R;
  const to2 = p => axis === 'x' ? [p[1], p[2]] : axis === 'y' ? [p[0], p[2]] : [p[0], p[1]];
  const from2At = (u, v, c) => axis === 'x' ? [c, u, v] : axis === 'y' ? [u, c, v] : [u, v, c];
  const setAxis = (p, c) => { const q = [p[0], p[1], p[2]]; if (axis === 'x') q[0] = c; else if (axis === 'y') q[1] = c; else q[2] = c; return q; };

  const loops = walkLoops(edges, axis, plane);
  if (!loops.length) return { ok: false, reason: 'no-loops' };
  const loops2D = loops.map(L => L.map(to2));
  let outerIdx = 0, maxAbs = -1;
  for (let i = 0; i < loops2D.length; i++) {
    const a = Math.abs(signedArea(loops2D[i]));
    if (a > maxAbs) { maxAbs = a; outerIdx = i; }
  }
  const outer2D = loops2D[outerIdx];
  const hole2D = loops2D.filter((_, i) => i !== outerIdx);
  const trim = clipFlatSide(wallPositions, axis, planeR, keepMin);
  if (!trim || trim.out.length < 9) return { ok: false, reason: 'trim-empty' };

  const n = outer2D.length;
  const sharp = detectCorners(outer2D, 60).length > 0;
  let windowSize = sharp ? 40 : 24;
  windowSize = Math.max(1, Math.min(windowSize, Math.floor((n - 1) / 2)));
  const hasHoles = hole2D.length > 0;
  const res = buildCornerAwareFillet(outer2D, {
    radius: R, uSteps: 12, windowSize, adaptive: true, capPlanePos: 0, includeCap: !hasHoles,
  });
  const map3 = res.vertices.map(v => setAxis(from2At(v[0], v[1], plane), plane + into * v[2]));
  const pushOriented = (outArr, a, b, c) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const along = axis === 'x' ? nx : axis === 'y' ? ny : nz;
    if (along * outward < 0) outArr.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    else outArr.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  let capNormal = 0;
  for (const [ia, ib, ic] of res.triangles) {
    const a = map3[ia], b = map3[ib], c = map3[ic];
    const ac = a[0], bc = b[0], cc = c[0]; // axis===x in our tests
    if (Math.abs(ac - plane) < 1e-5 && Math.abs(bc - plane) < 1e-5 && Math.abs(cc - plane) < 1e-5) {
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      capNormal += aby * acz - abz * acy; // nx for axis x
    }
  }
  let flip = capNormal * outward < 0;
  const out = trim.out.slice();
  for (const [ia, ib, ic] of res.triangles) {
    const a = map3[ia], b = map3[flip ? ic : ib], c = map3[flip ? ib : ic];
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  if (hasHoles) {
    const innerRing2D = (res.innerRing || []).map(id => [res.vertices[id][0], res.vertices[id][1]]);
    const faceTris = triangulateFaceWithHoles(innerRing2D, hole2D);
    for (const t of faceTris) {
      pushOriented(out, from2At(t[0][0], t[0][1], plane), from2At(t[1][0], t[1][1], plane), from2At(t[2][0], t[2][1], plane));
    }
    for (const hole of hole2D) {
      for (let i = 0; i < hole.length; i++) {
        const j = (i + 1) % hole.length;
        const a0 = from2At(hole[i][0], hole[i][1], plane);
        const a1 = from2At(hole[j][0], hole[j][1], plane);
        const b0 = from2At(hole[i][0], hole[i][1], planeR);
        const b1 = from2At(hole[j][0], hole[j][1], planeR);
        out.push(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b1[0], b1[1], b1[2],
          a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2]);
      }
    }
  }
  return { ok: true, out, loopCount: loops.length, holeCount: hole2D.length, warnings: res.warnings, outerArea: maxAbs };
}

function clipKeep(flat, axis, plane, keepMin, R) {
  const first = clipFlatSide(flat, axis, plane, keepMin);
  return buildFilletedSide(first.out, first.edges, axis, plane, keepMin, R);
}

function bboxOf(flat) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flat.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], flat[i + k]);
      mx[k] = Math.max(mx[k], flat[i + k]);
    }
  }
  return { mn, mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

function writeBinaryStl(path, flat) {
  const n = Math.floor(flat.length / 9);
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = flat[i], ay = flat[i + 1], az = flat[i + 2];
    const bx = flat[i + 3], by = flat[i + 4], bz = flat[i + 5];
    const cx = flat[i + 6], cy = flat[i + 7], cz = flat[i + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8); o += 12;
    for (let k = 0; k < 9; k++, o += 4) buf.writeFloatLE(flat[i + k], o);
    o += 2;
  }
  fs.writeFileSync(path, buf);
}

function flatToTriCoords(flat) {
  const tris = [];
  for (let i = 0; i < flat.length; i += 9) {
    tris.push([
      [flat[i], flat[i + 1], flat[i + 2]],
      [flat[i + 3], flat[i + 4], flat[i + 5]],
      [flat[i + 6], flat[i + 7], flat[i + 8]],
    ]);
  }
  return tris;
}

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ', name); }
  else { failed++; console.log('  FAIL', name, detail); }
}

console.log('Box 30×20×15, R=2, cut at x=15 (keepMin)');
{
  const flat = flatFromTris(boxTris(30, 20, 15));
  const r0 = clipFlatSide(flat, 'x', 15, true);
  ok('R=0 path: single loop', walkLoops(r0.edges, 'x', 15).length === 1);
  const fil = clipKeep(flat, 'x', 15, true, 2);
  ok('R=2: fillet ok', fil.ok, fil.reason);
  ok('R=2: no holes', fil.holeCount === 0);
  const bb = bboxOf(fil.out);
  ok('R=2: kept length ≈ 15', Math.abs(bb.size[0] - 15) < 0.15, String(bb.size[0]));
  ok('R=2: Y span ≈ 20', Math.abs(bb.size[1] - 20) < 0.15, String(bb.size[1]));
  ok('R=2: Z span ≈ 15', Math.abs(bb.size[2] - 15) < 0.15, String(bb.size[2]));
  // Outer rim should reach the original silhouette at the wall seam (depth R):
  // max Y/Z extents remain 20×15; the face inset is only on the cut plane.
  ok('R=2: outer silhouette preserved', bb.size[1] > 19.5 && bb.size[2] > 14.5);
  writeBinaryStl('/tmp/samples/box_30x20x15_cut_R2.stl', fil.out);
}

console.log('\nCable-bar with 2 slots, R=2, cut through a slot bay at x=36');
{
  const flat = flatFromTris(cableBarTris());
  const plane = 36;
  const first = clipFlatSide(flat, 'x', plane, true);
  const loops = walkLoops(first.edges, 'x', plane);
  ok('cable-bar cut yields multiple loops', loops.length >= 2, 'loops=' + loops.length);
  const fil = buildFilletedSide(first.out, first.edges, 'x', plane, true, 2);
  ok('cable-bar fillet ok', fil.ok, fil.reason);
  ok('cable-bar has holes (slots not filleted as outer)', fil.holeCount >= 1, 'holes=' + fil.holeCount);
  const bb = bboxOf(fil.out);
  ok('cable-bar kept piece has size', bb.size[0] > 1 && bb.size[1] > 1 && bb.size[2] > 1, JSON.stringify(bb.size));
  writeBinaryStl('/tmp/samples/cable_bar_cut_R2.stl', fil.out);
  writeBinaryStl('/tmp/samples/cable_bar.stl', flat);
}

console.log('\nR=0 means no fillet call (caller skips) — clip edges only');
{
  const flat = flatFromTris(boxTris(30, 20, 15));
  const r0 = clipFlatSide(flat, 'x', 15, true);
  ok('R=0: walls produced', r0.out.length >= 9);
  ok('R=0: boundary edges present', r0.edges.length > 0);
}

console.log('\nincludeCap:false returns innerRing and omits solid cap tris');
{
  const sq = [[0, 0], [30, 0], [30, 20], [0, 20]];
  const withCap = buildCornerAwareFillet(sq, { radius: 2, uSteps: 8, adaptive: false, includeCap: true });
  const noCap = buildCornerAwareFillet(sq, { radius: 2, uSteps: 8, adaptive: false, includeCap: false });
  ok('innerRing present', noCap.innerRing && noCap.innerRing.length >= 3);
  ok('noCap has fewer tris than withCap', noCap.triangles.length < withCap.triangles.length);
  const wt = checkWatertight(noCap.triangles.map(t => t.map(i => noCap.vertices[i])));
  // Band-only mesh: open at outer seam AND inner ring.
  ok('noCap is open (two boundaries)', wt.boundaryEdgeCount > 0);
}

console.log('\n──────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

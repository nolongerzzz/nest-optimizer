#!/usr/bin/env node
// Headless self-test for nso_text.js (Text). docs/TEXT.md.
//
//   node tools/nso_text_test.js        exit 0 = every gate held
//
// nso_text.js and nso_punch.js (its surface probe) are required as they ship
// (THREE-free). The boolean in the stamping gates is the shipped one:
// tools/nso_csg_node.js runs nso_csg.js in a vm, so the cutter goes through the
// same NSO_subtractSoups the app calls. Every volume and depth below is measured
// on the kernel's OUTPUT soup, by rays and by the divergence theorem, never read
// back from the plan.
//
// The "text" is made here: letters built from rectangles, a disc and a ring,
// rasterised with 4 x 4 supersampling into 0..255 alpha, which is what the
// page's canvas hands the engine. Real fonts are the drive check's.
//
//   1. the contour: a disc, a ring (one hole), an "i" (two islands) and an
//      "O" with a dot in its hole (an island in a hole); sub-pixel edges read
//      back within 0.05 px; the ink is centred on its bounding box
//   2. triangulation: the triangles add up to the polygon's area for a
//      letter H, an E, a ring, a row of three holes (each bridged past the
//      one before), a star, and 40 random stars
//   3. refinement: no edge over the limit, area kept, the outline only
//      subdivided (every outline vertex is on an original edge)
//   4. stamping a flat slab: the cutter is closed, wound outward, its volume the
//      area x (depth + 0.2); the shipped subtract takes exactly area x depth
//      out, and the result is closed
//   5. angle turns the text about the click; mirror reads it backwards
//   6. a faceted cylinder: the engraving is the same depth, square to the
//      surface, all over it (measured by rays against the kernel's output)
//   7. refusals, in words with numbers: the text runs off the face, a wall
//      thinner than the floor (and how deep would fit), bad numbers, no ink
//   8. a thin stroke is said, not refused; a refusal still carries its ghost
//   9. the soup handed in is not touched; a plan on a big mask is quick
//  10. REMOVE: stamp three letters, click the floor of one, and the shipped union
//      of the fillers takes the slab back to its volume and its flat top; one
//      click fills one letter, "word" fills all three; an O's island is kept; a
//      click on the plain face, a cylinder, and a stamp thinner than the face
//      says why; a second stamp of another depth is left alone

'use strict';

const T = require('../nso_text.js');
const { csgContext } = require('./nso_csg_node.js');

let fails = 0;
function gate(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------------------------------------------------------------- fixtures */
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
/* A cylinder along X: x in [0, Lx], radius R, m facets, capped. */
function cylinder(R, Lx, m) {
  const o = [];
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  const at = (k, x) => { const a = 2 * Math.PI * k / m; return [x, R * Math.cos(a), R * Math.sin(a)]; };
  for (let k = 0; k < m; k++) {
    const a0 = at(k, 0), a1 = at(k + 1, 0), b0 = at(k, Lx), b1 = at(k + 1, Lx);
    tri(a0, a1, b1); tri(a0, b1, b0);
    tri([0, 0, 0], a1, a0);
    tri([Lx, 0, 0], b0, b1);
  }
  return new Float32Array(o);
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
         s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}
function closed(s) {
  const k = (i) => s[i].toFixed(4) + ',' + s[i + 1].toFixed(4) + ',' + s[i + 2].toFixed(4);
  const e = new Map();
  for (let t = 0; t < s.length; t += 9) {
    for (let c = 0; c < 3; c++) {
      const a = k(t + 3 * c), b = k(t + 3 * ((c + 1) % 3));
      e.set(a + '>' + b, (e.get(a + '>' + b) || 0) + 1);
    }
  }
  for (const [key, n] of e) {
    const [a, b] = key.split('>');
    if (n !== 1 || e.get(b + '>' + a) !== 1) return false;
  }
  return true;
}
const fingerprint = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a; };

/* Rasterise an ink(x, y) predicate (pixel units, y up) into alpha, 4 x 4
   supersampled, row 0 at the top. */
function raster(w, h, ink, mmPerPx) {
  const d = new Uint8Array(w * h), N = 4;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let n = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      if (ink(c - 0.5 + (i + 0.5) / N, (h - 1 - r) - 0.5 + (j + 0.5) / N)) n++;
    }
    d[r * w + c] = Math.round(255 * n / (N * N));
  }
  return { w, h, data: d, mmPerPx };
}
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const disc = (cx, cy, R) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
const any = (...f) => (x, y) => f.some(g => g(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);
const rayTop = (soup, x, y) => { // highest z of the surface at (x, y), by brute force
  let best = -Infinity;
  for (let t = 0; t < soup.length; t += 9) {
    const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    best = Math.max(best, a * A[2] + b * B[2] + c * C[2]);
  }
  return best;
};

const PX = 0.1;   // mm per pixel in the fixtures: 10 px a mm

/* "H": two stems and a bar, 10 mm tall, 6 mm wide, 1.2 mm strokes. */
const letterH = () => raster(90, 130, any(rect(10, 10, 22, 110), rect(68, 10, 80, 110), rect(10, 54, 80, 66)), PX);
/* "E": a stem and three arms. */
const letterE = () => raster(80, 130, any(rect(10, 10, 22, 110), rect(10, 10, 70, 22), rect(10, 54, 60, 66), rect(10, 98, 70, 110)), PX);
/* "O": a ring, and "o." with a dot in the hole (an island in a hole). */
const ringO = () => raster(140, 140, minus(disc(70, 70, 60), disc(70, 70, 40)), PX);
const dotInO = () => raster(140, 140, any(minus(disc(70, 70, 60), disc(70, 70, 40)), disc(70, 70, 12)), PX);
/* "i": a stem and a dot, two islands. */
const letterI = () => raster(40, 130, any(rect(14, 10, 26, 70), disc(20, 95, 8)), PX);
/* a word: H E H E, 4 letters side by side, to be a plausible load. */
function word(n) {
  const gap = 100, ink = [];
  for (let k = 0; k < n; k++) {
    const o = k * gap;
    ink.push(rect(10 + o, 10, 22 + o, 110), rect(68 + o - 8, 10, 80 + o - 8, 110), rect(10 + o, 54, 80 + o - 8, 66));
  }
  return raster(gap * n + 20, 130, any(...ink), PX);
}

/* The polygon's own area, from the shape (mm2). */
const polyArea = (sh) => sh.area;

(async function main() {
  const csg = csgContext();

  /* 1 --------------------------------------------------------------- */
  {
    const disc20 = T.shape(raster(60, 60, disc(30, 30, 20), PX));
    gate('1a a disc: one outer loop, no hole, area within 1.5% of pi r^2',
      disc20.ok && disc20.polys.length === 1 && disc20.polys[0].holes.length === 0 && near(disc20.area, Math.PI * 4, 0.015 * Math.PI * 4),
      'area ' + disc20.area.toFixed(3) + ' of ' + (Math.PI * 4).toFixed(3));
    const ring = T.shape(ringO());
    const want = Math.PI * (36 - 16);
    gate('1b a ring: one outer, one hole, area within 1.5%',
      ring.ok && ring.polys.length === 1 && ring.polys[0].holes.length === 1 && near(ring.area, want, 0.015 * want),
      'area ' + ring.area.toFixed(3) + ' of ' + want.toFixed(3));
    const i = T.shape(letterI());
    gate('1c an "i": two islands, no hole', i.ok && i.polys.length === 2 && i.polys.every(p => p.holes.length === 0), i.polys.length + ' polygons');
    const o = T.shape(dotInO());
    gate('1d a dot in an O’s hole: two polygons, the ring holding one hole and the dot none',
      o.ok && o.polys.length === 2 && o.polys.filter(p => p.holes.length === 1).length === 1 && o.polys.filter(p => p.holes.length === 0).length === 1,
      o.polys.map(p => p.holes.length).join(','));
    // sub-pixel edges: a rectangle from 5.3 to 25.6 px wide
    const sub = T.shape(raster(40, 30, rect(5.3, 5.2, 25.6, 17.7), 1));
    gate('1e sub-pixel edges read back within a fifth of a pixel (20.3 x 12.5)', near(sub.width, 20.3, 0.2) && near(sub.height, 12.5, 0.2),
      sub.width.toFixed(3) + ' x ' + sub.height.toFixed(3));
    // centred on the ink's bounding box
    const H = T.shape(letterH());
    const xs = H.polys.flatMap(p => p.outer.map(q => q[0])), ys = H.polys.flatMap(p => p.outer.map(q => q[1]));
    gate('1f the ink is centred on its bounding box', near((Math.min(...xs) + Math.max(...xs)) / 2, 0, 1e-9) && near((Math.min(...ys) + Math.max(...ys)) / 2, 0, 1e-9) &&
      near(H.width, 7, 0.05) && near(H.height, 10, 0.05), H.width.toFixed(2) + ' x ' + H.height.toFixed(2));
    // winding: outer loops counter-clockwise, holes clockwise
    const a2 = (p) => p.reduce((s, a, k) => { const b = p[(k + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0);
    gate('1g outer loops counter-clockwise, holes clockwise', ring.polys[0].outer && a2(ring.polys[0].outer) > 0 && a2(ring.polys[0].holes[0]) < 0);
  }

  /* 2 --------------------------------------------------------------- */
  {
    const check = (name, sh) => {
      const m = T._triangulate(sh);
      if (!m.V) { gate(name, false, m.reason); return; }
      const got = m.T.reduce((s, t) => {
        const a = m.V[t[0]], b = m.V[t[1]], c = m.V[t[2]];
        return s + ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      }, 0);
      gate(name, near(got, polyArea(sh), 1e-6 * Math.max(1, polyArea(sh))) && m.T.length > 0, m.T.length + ' triangles, ' + got.toFixed(4) + ' of ' + polyArea(sh).toFixed(4) + ' mm2');
    };
    check('2a an H', T.shape(letterH()));
    check('2b an E', T.shape(letterE()));
    check('2c a ring (a hole bridged out)', T.shape(ringO()));
    check('2d a dot in an O', T.shape(dotInO()));
    check('2e four letters', T.shape(word(4)));
    // three holes in a row: each bridge has to get past the hole to its right
    const slab = raster(200, 80, minus(rect(10, 10, 190, 70), any(disc(45, 40, 14), disc(100, 40, 14), disc(155, 40, 14))), PX);
    check('2f a plate with a row of three holes', T.shape(slab));
    // a star, then forty random ones
    const star = (cx, cy, n, r0, r1, rot) => {
      const p = [];
      for (let k = 0; k < 2 * n; k++) { const a = rot + Math.PI * k / n, r = k % 2 ? r0 : r1; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return p;
    };
    const inPoly = (p) => (x, y) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const a = p[i], b = p[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
    check('2g a five-point star', T.shape(raster(120, 120, inPoly(star(60, 60, 5, 20, 55, 0.3)), PX)));
    let bad = 0, total = 0, seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let n = 0; n < 40; n++) {
      const pts = star(60, 60, 3 + Math.floor(rnd() * 7), 12 + rnd() * 10, 38 + rnd() * 20, rnd() * 6);
      const hole = rnd() < 0.5 ? disc(60 + (rnd() - 0.5) * 10, 60 + (rnd() - 0.5) * 10, 4 + rnd() * 5) : () => false;
      const sh = T.shape(raster(120, 120, minus(inPoly(pts), hole), PX));
      const m = sh.ok && T._triangulate(sh);
      total++;
      if (!m || !m.V) { bad++; continue; }
      const got = m.T.reduce((s, t) => { const a = m.V[t[0]], b = m.V[t[1]], c = m.V[t[2]]; return s + ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; }, 0);
      if (!near(got, sh.area, 1e-6 * Math.max(1, sh.area))) bad++;
    }
    gate('2h forty random stars, half with a hole: every triangulation adds up', bad === 0, bad + ' of ' + total + ' failed');
  }

  /* 3 --------------------------------------------------------------- */
  {
    const sh = T.shape(letterH());
    const m = T._triangulate(sh);
    const r = T._refine(m.V, m.T, 1);
    const longest = r.T.reduce((L, t) => {
      for (let k = 0; k < 3; k++) { const a = r.V[t[k]], b = r.V[t[(k + 1) % 3]]; L = Math.max(L, Math.hypot(a[0] - b[0], a[1] - b[1])); }
      return L;
    }, 0);
    const area = (V, TT) => TT.reduce((s, t) => { const a = V[t[0]], b = V[t[1]], c = V[t[2]]; return s + ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; }, 0);
    gate('3a refined to 1 mm: no edge over it, more triangles, area kept',
      r.V && longest <= 1 + 1e-9 && r.T.length > m.T.length && near(area(r.V, r.T), area(m.V, m.T), 1e-9),
      m.T.length + ' -> ' + r.T.length + ' triangles, longest ' + longest.toFixed(3));
    const out = T._outline(r.V, r.T);
    // every outline vertex lies on an original outline edge
    const orig = T._outline(m.V, m.T);
    const onEdge = (p) => orig.some(([a, b]) => {
      const A = m.V[a], B = m.V[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
      const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / (L * L);
      return t >= -1e-9 && t <= 1 + 1e-9 && Math.hypot(A[0] + t * dx - p[0], A[1] + t * dy - p[1]) < 1e-7;
    });
    gate('3b the outline is only subdivided: every outline vertex sits on an original edge',
      out.length >= orig.length && out.every(([a]) => onEdge(r.V[a])), orig.length + ' -> ' + out.length + ' outline edges');
    // conforming: every interior edge shared by exactly two triangles, one each way
    const cnt = new Map();
    r.T.forEach(t => { for (let k = 0; k < 3; k++) { const key = t[k] + '>' + t[(k + 1) % 3]; cnt.set(key, (cnt.get(key) || 0) + 1); } });
    let dup = 0;
    cnt.forEach(n => { if (n > 1) dup++; });
    gate('3c conforming: no directed edge used twice', dup === 0, dup + ' repeated');
  }

  /* 4 --------------------------------------------------------------- */
  const SLAB = box([0, 0, 0], [60, 40, 6]);
  const CLICK = { point: [30, 20, 6], normal: [0, 0, 1] };
  {
    const sh = T.shape(letterH());
    const before = fingerprint(SLAB);
    const pl = T.plan(SLAB, CLICK, sh, { depth: 1.2 });
    gate('4a a flat slab plans: ok, flat, untouched triangulation', pl.ok && pl.stats.flat && pl.stats.tris === T._triangulate(sh).T.length, pl.reason);
    const cut = T.cutter(pl);
    const want = sh.area * (1.2 + 0.2);
    gate('4b the cutter is closed, wound outward, its volume area x (depth + 0.2)', closed(cut) && near(volume(cut), want, 1e-6 * want),
      'volume ' + volume(cut).toFixed(4) + ' of ' + want.toFixed(4) + ' (' + cut.length / 9 + ' triangles)');
    const res = await csg.NSO_subtractSoups(SLAB, cut);
    const lost = volume(SLAB) - (res.soup ? volume(res.soup) : NaN), eng = sh.area * 1.2;
    gate('4c the shipped subtract takes exactly area x depth out', res.ok && near(lost, eng, 2e-3 * eng), 'lost ' + lost.toFixed(4) + ' of ' + eng.toFixed(4) + ' mm3');
    gate('4d the engraved piece is closed', res.ok && closed(res.soup));
    gate('4e the soup handed to plan is untouched', fingerprint(SLAB) === before);
    // the engraving sits where the click was, reading along +X
    const xs = [], ys = [];
    for (let i = 0; i < cut.length; i += 3) { xs.push(cut[i]); ys.push(cut[i + 1]); }
    gate('4f centred on the click, reads along +X (7 mm wide, 10 tall)', near((Math.min(...xs) + Math.max(...xs)) / 2, 30, 0.05) && near((Math.min(...ys) + Math.max(...ys)) / 2, 20, 0.05) &&
      near(Math.max(...xs) - Math.min(...xs), 7, 0.05) && near(Math.max(...ys) - Math.min(...ys), 10, 0.05),
      (Math.max(...xs) - Math.min(...xs)).toFixed(2) + ' x ' + (Math.max(...ys) - Math.min(...ys)).toFixed(2));
    // a hole stays a hole: a ray through the middle of an O's hole meets the top, as before
    const ringSh = T.shape(ringO()), rp = T.plan(SLAB, CLICK, ringSh, { depth: 1 });
    const rr = await csg.NSO_subtractSoups(SLAB, T.cutter(rp));
    gate('4g an O: the ring is cut 1 mm down, the middle of its hole and the slab outside are not',
      near(rayTop(rr.soup, 30 + 5, 20), 5, 1e-3) && near(rayTop(rr.soup, 30, 20), 6, 1e-3) && near(rayTop(rr.soup, 30 + 8, 20), 6, 1e-3),
      [35, 30, 38].map(x => rayTop(rr.soup, x, 20).toFixed(3)).join(' / '));
    const dp = T.plan(SLAB, CLICK, T.shape(dotInO()), { depth: 1 });
    const dr = await csg.NSO_subtractSoups(SLAB, T.cutter(dp));
    gate('4h a dot in an O’s hole: ring and dot cut, the moat between them left', dr.ok && closed(dr.soup) && near(rayTop(dr.soup, 30, 20), 5, 1e-3) &&
      near(rayTop(dr.soup, 30 + 2.6, 20), 6, 1e-3) && near(rayTop(dr.soup, 30 + 5, 20), 5, 1e-3),
      [30, 32.6, 35].map(x => rayTop(dr.soup, x, 20).toFixed(3)).join(' / '));
  }

  /* 5 --------------------------------------------------------------- */
  {
    // an "L" so that the turn and the mirror can be told apart
    const L = T.shape(raster(80, 100, any(rect(10, 10, 22, 90), rect(10, 10, 70, 22)), PX));
    const bbox = (soup) => {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let i = 0; i < soup.length; i += 3) { lo[0] = Math.min(lo[0], soup[i]); lo[1] = Math.min(lo[1], soup[i + 1]); hi[0] = Math.max(hi[0], soup[i]); hi[1] = Math.max(hi[1], soup[i + 1]); }
      return { lo, hi };
    };
    // the L's stem is on the left, its foot runs right along the bottom
    const cutterOf = (o) => { const pl = T.plan(SLAB, CLICK, L, o); return { pl, soup: T.cutter(pl) }; };
    const weighted = (soup) => { // the cutter's area centroid, seen from above, from the click: where the foot is
      let sx = 0, sy = 0, A = 0;
      for (let i = 0; i < soup.length; i += 9) {
        const a2 = (soup[i + 3] - soup[i]) * (soup[i + 7] - soup[i + 1]) - (soup[i + 4] - soup[i + 1]) * (soup[i + 6] - soup[i]);   // + for a face looking up
        if (!(a2 > 0)) continue;          // the top cap only
        A += a2; sx += a2 * (soup[i] + soup[i + 3] + soup[i + 6]) / 3; sy += a2 * (soup[i + 1] + soup[i + 4] + soup[i + 7]) / 3;
      }
      return [sx / A - 30, sy / A - 20];
    };
    const a0 = cutterOf({ depth: 1 }), a90 = cutterOf({ depth: 1, angle: 90 }), m0 = cutterOf({ depth: 1, mirror: true });
    const w0 = weighted(a0.soup), w90 = weighted(a90.soup), wm = weighted(m0.soup);
    gate('5a the L at 0: its mass sits left and low of the click', a0.pl.ok && w0[0] < -0.2 && w0[1] < -0.2, w0.map(x => x.toFixed(2)).join(','));
    // turned 90 degrees counter-clockwise (seen from above), left-low becomes right-low
    gate('5b angle 90 turns it counter-clockwise: low-left becomes low-right', a90.pl.ok && w90[0] > 0.2 && w90[1] < -0.2, w90.map(x => x.toFixed(2)).join(','));
    gate('5c the turned bounding box swaps its sides', (() => { const b = bbox(a90.soup), q = bbox(a0.soup); return near(b.hi[0] - b.lo[0], q.hi[1] - q.lo[1], 0.05) && near(b.hi[1] - b.lo[1], q.hi[0] - q.lo[0], 0.05); })());
    gate('5d mirror reads it backwards: mass right of the click, still low', m0.pl.ok && wm[0] > 0.2 && wm[1] < -0.2 && near(wm[0], -w0[0], 0.05), wm.map(x => x.toFixed(2)).join(','));
    const res = await csg.NSO_subtractSoups(SLAB, m0.soup);
    gate('5e a mirrored stamp is a good solid and removes the same volume', res.ok && closed(res.soup) && near(volume(SLAB) - volume(res.soup), L.area * 1, 3e-3 * L.area), 'lost ' + (volume(SLAB) - volume(res.soup)).toFixed(4) + ' of ' + L.area.toFixed(4));
  }

  /* 6 --------------------------------------------------------------- */
  {
    const R = 15, cyl = cylinder(R, 40, 96), sh = T.shape(letterH());
    const click = { point: [20, 0, R], normal: [0, 0, 1] };
    const depth = 1;
    const pl = T.plan(cyl, click, sh, { depth, angle: 90 });   // turned so the 7 mm width runs round the cylinder
    gate('6a a faceted cylinder plans: ok, curved, refined', pl.ok && !pl.stats.flat && pl.stats.tris > T._triangulate(sh).T.length, pl.reason + '; ' + pl.stats.tris + ' triangles');
    const cut = T.cutter(pl);
    gate('6b the curved cutter is closed and wound outward', closed(cut) && volume(cut) > 0);
    const res = await csg.NSO_subtractSoups(cyl, cut);
    gate('6c the shipped subtract takes it and the piece stays one closed solid', res.ok && closed(res.soup), res.reason || '');
    // depth: along each vertical ray inside the text, the surface drops by depth / cos(lean)
    const topAt = (soup, x, y) => {
      let best = -Infinity;
      for (let t = 0; t < soup.length; t += 9) {
        const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
        const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
        if (Math.abs(d) < 1e-12) continue;
        const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, c = 1 - a - b;
        if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
        best = Math.max(best, a * A[2] + b * B[2] + c * C[2]);
      }
      return best;
    };
    // inside the H's left stem: 10 mm along X (the text's height, turned), 1.2 wide
    // angle 90: text +x -> world +Y?  the stem columns run along X after the turn; sample the mid-bar and stems
    const samples = [];
    const dp = [];
    for (let k = 0; k < 40; k++) {
      const x = 20 + (-4 + 8 * ((k * 37) % 40) / 40), y = -3 + 6 * ((k * 17) % 40) / 40;
      const z0 = topAt(cyl, x, y), z1 = topAt(res.soup, x, y);
      if (z0 - z1 > 0.05) {
        const lean = Math.atan2(Math.abs(y), Math.sqrt(R * R - y * y));       // the true radial normal's lean from +Z
        samples.push(x); dp.push((z0 - z1) * Math.cos(lean));
      }
    }
    const lo = Math.min(...dp), hi = Math.max(...dp);
    gate('6d the engraving is the same depth square to the surface, all over it (1.00 +/- 0.03)',
      dp.length >= 6 && lo > depth - 0.03 && hi < depth + 0.03, dp.length + ' rays inside the letters: ' + lo.toFixed(3) + ' .. ' + hi.toFixed(3));
    // a flat-bottomed scoop would be 1.0 at the click and ~1.4 at 3 mm out; pin the contrast
    const flat = T.plan(cyl, click, sh, { depth, angle: 90 });
    gate('6e the same click on a cylinder is not the flat plan (curved vertices differ in height)', (() => { const h = flat.data.hb; return Math.max(...h) - Math.min(...h) > 0.05; })());
  }

  /* 7 --------------------------------------------------------------- */
  {
    const big = T.shape(raster(700, 140, rect(5, 5, 695, 135), PX));         // 69 x 13 mm on a 60 x 40 slab
    const off = T.plan(SLAB, CLICK, big, { depth: 1 });
    gate('7a text wider than the face: refused, says it runs off the face with its size',
      !off.ok && /runs off the face/.test(off.reason) && /69\.0 × 13\.0 mm/.test(off.reason), off.reason);
    const thin = box([0, 0, 0], [60, 40, 1]);
    const t1 = T.plan(thin, { point: [30, 20, 1], normal: [0, 0, 1] }, T.shape(letterH()), { depth: 0.5 });
    gate('7b a 1 mm plate engraved 0.5: refused, the floor (0.8) and how deep fits (0.2)',
      !t1.ok && /1\.0 mm at its thinnest/.test(t1.reason) && /floor is 0\.8/.test(t1.reason) && /At most 0\.2 mm deep fits/.test(t1.reason), t1.reason);
    const t2 = T.plan(thin, { point: [30, 20, 1], normal: [0, 0, 1] }, T.shape(letterH()), { depth: 0.2 });
    gate('7c ...and 0.2 mm deep on it is allowed', t2.ok, t2.reason);
    const sh = T.shape(letterH());
    const bads = [[{ depth: 0 }, /depth/], [{ depth: -1 }, /depth/], [{ depth: NaN }, /depth/], [{ depth: 99 }, /more than one stamp/], [{ angle: NaN }, /angle/], [{ depth: 1, maxEdge: 0 }, /mesh edge/]];
    gate('7d bad numbers are refused in words', bads.every(([o, re]) => { const r = T.plan(SLAB, CLICK, sh, o); return !r.ok && re.test(r.reason); }));
    const empty = T.shape({ w: 20, h: 20, data: new Uint8Array(400), mmPerPx: 0.1 });
    gate('7e no ink: shape and plan say so', !empty.ok && /no ink/.test(empty.reason) && !T.plan(SLAB, CLICK, empty, { depth: 1 }).ok);
    const missing = T.plan(SLAB, { point: [500, 500, 6], normal: [0, 0, 1] }, sh, { depth: 1 });
    gate('7f a click that is not on the piece is refused', !missing.ok && /not on this piece/.test(missing.reason), missing.reason);
    const none = T.shape(null);
    gate('7g no mask at all: refused', !none.ok);
    // a step: text half over the edge of a 20 mm boss
    const step = (() => { const a = box([0, 0, 0], [60, 40, 6]), b = box([20, 10, 6], [40, 30, 12]); const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; })();
    const st = T.plan(step, { point: [30, 20, 12], normal: [0, 0, 1] }, T.shape(raster(300, 100, rect(5, 5, 295, 95), PX)), { depth: 1 });
    gate('7h text that hangs over the edge of a boss is refused, not cut into the side', !st.ok && /runs off the face/.test(st.reason), st.reason);
  }

  /* 8 --------------------------------------------------------------- */
  {
    const hair = T.shape(raster(120, 60, any(rect(10, 10, 12, 50), rect(20, 10, 22, 50), rect(30, 10, 32, 50)), PX));   // 0.2 mm strokes
    const pl = T.plan(SLAB, CLICK, hair, { depth: 0.6 });
    gate('8a 0.2 mm strokes: planned, and said to be under a nozzle width', pl.ok && pl.stats.thin && /under a nozzle width/.test(pl.reason), pl.reason);
    const big = T.shape(raster(700, 140, rect(5, 5, 695, 135), PX));
    const off = T.plan(SLAB, CLICK, big, { depth: 1 });
    const g = off.data && T.cutter(off);
    gate('8b a refusal still carries its ghost: a cutter the page can draw red', !off.ok && g && g.length > 0 && closed(g), g ? g.length / 9 + ' triangles' : 'none');
  }

  /* 9 --------------------------------------------------------------- */
  {
    const sh = T.shape(word(8));
    const t0 = Date.now();
    const cyl = cylinder(40, 100, 128);
    const pl = T.plan(cyl, { point: [50, 0, 40], normal: [0, 0, 1] }, sh, { depth: 0.8, angle: 90 });
    const ms = Date.now() - t0;
    gate('9a eight letters on a 128-facet cylinder plan in under 4 s', pl.ok && ms < 4000, ms + ' ms, ' + (pl.stats ? pl.stats.tris : 0) + ' triangles, ' + (pl.reason || ''));
    const t1 = Date.now(), again = T.plan(cyl, { point: [50, 0, 40], normal: [0, 0, 1] }, sh, { depth: 0.8, angle: 80 });
    gate('9b a second angle on the same text re-uses the mesh (faster, still ok)', again.ok && (Date.now() - t1) <= ms + 50, (Date.now() - t1) + ' ms');
  }

  /* 10 -------------------------------------------------------------- */
  {
    // the app's own checker, as the page loads it
    const vm = require('vm'), fs = require('fs'), path = require('path');
    const sb = { window: {} };
    vm.createContext(sb);
    for (const f of ['NSO_Repair.js', 'nso-defects.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f });
    const check = (soup) => { const r = sb.window.NSO_Defects.locate(soup, {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris, pierce: r.pierce }; };
    const clean = (c) => c.open === 0 && c.nm === 0 && c.odd === 0 && c.flip === 0 && c.degen === 0 && !c.pierce;
    const word3 = T.shape(word(3));
    const stampOn = async (soup, shp, depth, at, angle) => {
      const pl = T.plan(soup, { point: at, normal: [0, 0, 1] }, shp, { depth, angle: angle || 0 });
      const r = await csg.NSO_subtractSoups(soup, T.cutter(pl));
      return { pl, soup: r.soup, ok: r.ok };
    };
    const A = await stampOn(SLAB, word3, 1, [30, 20, 6]);
    const sx = A.pl.data.o[0] + A.pl.data.V.reduce((m, v) => Math.min(m, v[0]), Infinity) + 0.6;
    const floorPt = [sx, 20, 5];
    const one = T.pockets(A.soup, { point: floorPt, normal: [0, 0, 1] }, { word: false });
    gate('10a one click on a letter’s floor finds that recess alone: flat, 1 mm deep', one.ok && one.count === 1 && !one.curved && near(one.depth, 1, 0.005), one.reason);
    const all = T.pockets(A.soup, { point: floorPt, normal: [0, 0, 1] }, { word: true, reach: 5 });
    gate('10b "word" finds all three letters of the stamp', all.ok && all.count === 3, all.reason);
    const f1 = T.fill(A.soup, all);
    const v0 = volume(SLAB), v1 = volume(A.soup), v2 = f1.ok ? volume(f1.soup) : NaN;
    gate('10c filling is mesh surgery: the slab’s volume back (0.05%), and the app’s checker finds it clean (no open, non-manifold, flipped or flat triangle)',
      f1.ok && near(v2, v0, 5e-4 * v0) && clean(check(f1.soup)), 'slab ' + v0.toFixed(3) + ', stamped ' + v1.toFixed(3) + ', filled ' + v2.toFixed(3) + ' ' + JSON.stringify(f1.ok ? check(f1.soup) : f1.reason));
    const tops = [[30 - 3.2, 20], [30, 20], [30 + 3.1, 22]].map(([x, y]) => rayTop(f1.soup, x, y));
    gate('10d the face is flat again where the letters were (z = 6 at the stems and the bar)', tops.every(z => near(z, 6, 1e-4)), tops.map(z => z.toFixed(4)).join(' / '));
    const f2 = T.fill(A.soup, one);
    gate('10e one click with "word" off fills one letter: a third of the engraving comes back, still clean', f2.ok && clean(check(f2.soup)) && (volume(f2.soup) - v1) > 0.2 * (v0 - v1) && (volume(f2.soup) - v1) < 0.5 * (v0 - v1),
      'engraving ' + (v0 - v1).toFixed(3) + ', returned ' + (f2.ok ? (volume(f2.soup) - v1).toFixed(3) : f2.reason));
    const tight = T.pockets(A.soup, { point: floorPt, normal: [0, 0, 1] }, { word: true, reach: 0.1 });
    gate('10f a reach of 0.1 mm joins none of them: still one recess', tight.ok && tight.count === 1, tight.reason);
    const O = await stampOn(SLAB, T.shape(ringO()), 1, [30, 20, 6]);
    const po = T.pockets(O.soup, { point: [35, 20, 5], normal: [0, 0, 1] }, { word: true });
    const fo = T.fill(O.soup, po);
    gate('10g an O: one recess with a hole in it, filled back to the slab, clean, the island untouched',
      po.ok && po.count === 1 && fo.ok && near(volume(fo.soup), v0, 5e-4 * v0) && clean(check(fo.soup)), po.reason + ' ' + (fo.ok ? JSON.stringify(check(fo.soup)) : fo.reason));
    const plain = T.pockets(A.soup, { point: [5, 5, 6], normal: [0, 0, 1] }, {});
    gate('10h a click on the plain face is refused in words', !plain.ok && /not the inside of a recess/.test(plain.reason), plain.reason);
    const cylH = T.pockets(cylinder(15, 40, 96), { point: [20, 0, 15], normal: [0, 0, 1] }, {});
    gate('10i an unengraved cylinder is refused too', !cylH.ok);
    const B2 = await stampOn(A.soup, T.shape(letterH()), 0.5, [30, 32, 6]);
    const mixed = T.pockets(B2.soup, { point: floorPt, normal: [0, 0, 1] }, { word: true, reach: 30 });
    gate('10j a second stamp 0.5 deep, in reach, is left alone: word takes only the 1 mm ones', B2.ok && mixed.ok && mixed.count === 3 && near(mixed.depth, 1, 0.005), mixed.reason);
    const t0 = Date.now(); T.pockets(A.soup, { point: floorPt, normal: [0, 0, 1] }, { word: true });
    gate('10k finding them is quick (under 1 s)', Date.now() - t0 < 1000, (Date.now() - t0) + ' ms');
    // a piece that is not a clean solid: two shells overlapping elsewhere; the fill does not ask it to be
    const second = box([40, 10, 0], [70, 30, 8]);
    const messy = new Float32Array(A.soup.length + second.length); messy.set(A.soup); messy.set(second, A.soup.length);
    const pm = T.pockets(messy, { point: floorPt, normal: [0, 0, 1] }, { word: true, reach: 5 });
    const fm = T.fill(messy, pm);
    gate('10l a piece with another shell piercing it elsewhere is filled all the same (only the recesses change)', pm.ok && fm.ok && near(volume(fm.soup) - volume(messy), v0 - v1, 5e-4 * v0), pm.reason);
    // curved faces: stamp on a faceted cylinder, then take it back
    const cyl = cylinder(15, 40, 96), cs = T.shape(word(2));
    const cpl = T.plan(cyl, { point: [20, 0, 15], normal: [0, 0, 1] }, cs, { depth: 1, angle: 90 });
    const cut = await csg.NSO_subtractSoups(cyl, T.cutter(cpl));
    const D = cpl.data, at = (x, y) => [D.o[0] + D.ex[0] * x + D.ey[0] * y, D.o[1] + D.ex[1] * x + D.ey[1] * y];
    const stem = at(Math.min(...D.V.map(v => v[0])) + 0.6, 0);
    const cp = T.pockets(cut.soup, { point: [stem[0], stem[1], rayTop(cut.soup, stem[0], stem[1])], normal: [0, 0, 1] }, { word: true, reach: 5 });
    gate('10m a recess in a curved face is found: 2 letters, about 1 mm deep', cp.ok && cp.curved && cp.count === 2 && near(cp.depth, 1, 0.15), cp.reason);
    const cf = T.fill(cut.soup, cp);
    const vC0 = volume(cyl), vC1 = volume(cut.soup), vC2 = cf.ok ? volume(cf.soup) : NaN;
    gate('10n the curved fill takes back the volume (within 1% of what was cut) and the app’s checker finds it clean', cf.ok && Math.abs(vC2 - vC0) < 0.01 * (vC0 - vC1) && clean(check(cf.soup)),
      'cylinder ' + vC0.toFixed(2) + ', engraved ' + vC1.toFixed(2) + ', filled ' + vC2.toFixed(2) + ' ' + JSON.stringify(cf.ok ? check(cf.soup) : cf.reason));
    let worst = 0, cn = 0;
    for (const [x, y] of [[-3, -2], [0.6, 1], [2, -3], [-1, 3], [3.2, 0.5], [-3.5, 1.5]]) {
      const [wx, wy] = at(x, y);
      if (cf.ok && rayTop(cyl, wx, wy) - rayTop(cut.soup, wx, wy) > 0.3) { worst = Math.max(worst, Math.abs(rayTop(cf.soup, wx, wy) - rayTop(cyl, wx, wy))); cn++; }
    }
    gate('10o the surface is back to the cylinder’s within 0.03 mm over the letters', cn >= 2 && worst < 0.03, cn + ' points, worst ' + worst.toFixed(4) + ' mm');
  }

  console.log(fails ? '\n' + fails + ' FAILED' : '\nPASSED all gates');
  process.exit(fails ? 1 : 0);
})();

/* Contact area across a real interface between two stacked pieces.
 * Node only - a measuring instrument for the audits, not shipped.
 *
 * NSO_Skin.tipContactArea already answers "how much of A's tips plane is
 * under B's footprint", which is the right question when B's mating face is a
 * flat plate: the plate covers everything, so A's tip area IS the contact.
 * It is the WRONG question for a two-layer interface, where B is itself a
 * patterned piece and its underside is not solid everywhere. What actually
 * bonds is the INTERSECTION of the two material regions in the shared plane:
 *
 *     contact = { p in plane : A has material just below p
 *                          AND B has material just above p }
 *
 * measured here as real 2D polygon intersection, exactly, from the meshes:
 *
 *   1. A's triangles that lie in the interface plane (all three vertices
 *      within `tol` of it) and face +N  - the up-facing material of A.
 *   2. B's triangles in the same plane facing -N - the down-facing material
 *      of B.
 *   3. every (a, b) pair clipped against each other in the plane's own 2D
 *      frame (Sutherland-Hodgman; both are triangles, so both are convex and
 *      the clip is exact), and the areas summed.
 *
 * Triangles of one soup never overlap each other in a closed manifold mesh,
 * so no pair is counted twice and no inclusion-exclusion is needed.
 *
 * PATCHES. The total alone cannot tell "two hundred isolated dots" from "one
 * broad weld of the same area", which is the whole question a crossing-point
 * interface asks. So the intersection pieces are also clustered into contact
 * PATCHES: two pieces join when their bounding boxes overlap (grown by
 * `tol`). That is exact for the geometry under test - distinct crossings on
 * any of these patterns are separated by real air gaps, far wider than tol -
 * and it is reported as a count plus the per-patch areas and extents, so a
 * patch that is secretly a continuous line shows up as a patch 30 mm long
 * rather than hiding inside an average.
 */
'use strict';

/* ---------------------------------------------------------------- vectors */
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a) { return Math.sqrt(dot(a, a)); }
function unit(a) { const L = len(a); return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : [0, 0, 0]; }
function vtx(soup, t, k) { const o = t * 9 + k * 3; return [soup[o], soup[o + 1], soup[o + 2]]; }
function triCount(soup) { return (soup.length / 9) | 0; }

/* A right-handed 2D frame in the plane with normal N. */
function frameFor(N) {
  const n = unit(N);
  const seed = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const U = unit(sub(seed, [n[0] * dot(n, seed), n[1] * dot(n, seed), n[2] * dot(n, seed)]));
  return { N: n, U: U, V: cross(n, U) };
}

/* Triangles of `soup` lying in the plane n.p = offset and facing `want`
 * (+1 along N, -1 against it), as 2D polygons in the frame. */
function planarTris(soup, fr, offset, want, tol) {
  const out = [];
  for (let t = 0; t < triCount(soup); t++) {
    const p = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
    let inPlane = true;
    for (let k = 0; k < 3; k++) if (Math.abs(dot(p[k], fr.N) - offset) > tol) { inPlane = false; break; }
    if (!inPlane) continue;
    const nv = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    if (len(nv) < 1e-14) continue;                     /* degenerate: no area */
    if (dot(nv, fr.N) * want <= 0) continue;           /* faces the other way */
    const poly = p.map(q => [dot(q, fr.U), dot(q, fr.V)]);
    out.push(signedArea(poly) < 0 ? poly.reverse() : poly);   /* CCW */
  }
  return out;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    a += poly[i][0] * q[1] - q[0] * poly[i][1];
  }
  return a / 2;
}

/* Sutherland-Hodgman: `poly` clipped to the CCW convex `clip`. */
function clipConvex(poly, clip) {
  let cur = poly;
  for (let i = 0; i < clip.length && cur.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const side = p => ex * (p[1] - a[1]) - ey * (p[0] - a[0]);   /* > 0 = inside (left) */
    const next = [];
    for (let j = 0; j < cur.length; j++) {
      const p = cur[j], q = cur[(j + 1) % cur.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    cur = next;
  }
  return cur;
}

function bboxOf(poly) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of poly) {
    if (p[0] < b[0]) b[0] = p[0];
    if (p[1] < b[1]) b[1] = p[1];
    if (p[0] > b[2]) b[2] = p[0];
    if (p[1] > b[3]) b[3] = p[1];
  }
  return b;
}
function bboxHit(a, b, eps) {
  return a[0] <= b[2] + eps && b[0] <= a[2] + eps && a[1] <= b[3] + eps && b[1] <= a[3] + eps;
}

/* interfaceContact(soupA, soupB, opts) -> the numbers.
 *   normal   the interface normal, A below and B above (default +Z)
 *   plane    n.p of the interface; default = A's largest coordinate along N
 *   tol      in-plane tolerance, mm (default 1e-6 - a float32 face reads ~1e-7)
 * Returns { area, patches, patchAreas, patchExtents, trisA, trisB, plane,
 *           areaA, areaB, maxPatchArea, minPatchArea, maxPatchSpan }. */
function interfaceContact(soupA, soupB, opts) {
  const o = opts || {};
  const fr = frameFor(o.normal || [0, 0, 1]);
  const tol = o.tol == null ? 1e-6 : o.tol;
  let plane = o.plane;
  if (plane == null) {
    plane = -Infinity;
    for (let i = 0; i < soupA.length; i += 3) {
      const s = soupA[i] * fr.N[0] + soupA[i + 1] * fr.N[1] + soupA[i + 2] * fr.N[2];
      if (s > plane) plane = s;
    }
  }
  const A = planarTris(soupA, fr, plane, +1, tol);
  const B = planarTris(soupB, fr, plane, -1, tol);
  const pieces = [];
  let area = 0;
  for (const a of A) {
    const ab = bboxOf(a);
    for (const b of B) {
      if (!bboxHit(ab, bboxOf(b), tol)) continue;
      const c = clipConvex(a, b);
      if (c.length < 3) continue;
      const s = Math.abs(signedArea(c));
      if (s <= tol * tol) continue;
      area += s;
      pieces.push({ box: bboxOf(c), area: s });
    }
  }
  /* cluster the pieces into patches - union-find over bbox overlap */
  const parent = pieces.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (!bboxHit(pieces[i].box, pieces[j].box, tol)) continue;
      const a = find(i), b = find(j);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map();
  for (let i = 0; i < pieces.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { area: 0, box: pieces[i].box.slice() });
    const g = groups.get(r);
    g.area += pieces[i].area;
    g.box[0] = Math.min(g.box[0], pieces[i].box[0]);
    g.box[1] = Math.min(g.box[1], pieces[i].box[1]);
    g.box[2] = Math.max(g.box[2], pieces[i].box[2]);
    g.box[3] = Math.max(g.box[3], pieces[i].box[3]);
  }
  const patches = Array.from(groups.values()).sort((x, y) => y.area - x.area);
  const areaOf = list => list.reduce((s, p) => s + Math.abs(signedArea(p)), 0);
  return {
    plane: plane,
    trisA: A.length, trisB: B.length,
    areaA: areaOf(A), areaB: areaOf(B),
    area: area,
    patches: patches.length,
    patchAreas: patches.map(p => p.area),
    patchExtents: patches.map(p => [p.box[2] - p.box[0], p.box[3] - p.box[1]]),
    maxPatchArea: patches.length ? patches[0].area : 0,
    minPatchArea: patches.length ? patches[patches.length - 1].area : 0,
    maxPatchSpan: patches.reduce((m, p) => Math.max(m, p.box[2] - p.box[0], p.box[3] - p.box[1]), 0)
  };
}

/* ------------------------------------------------------------- transforms */

/* A copy of `soup` rotated by `deg` about the +Z axis through (cx, cy), then
 * translated by dz. The two-layer construction: the second layer is the same
 * pattern turned across the first. */
function rotateZ(soup, deg, cx, cy, dz) {
  const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i] - cx, y = soup[i + 1] - cy;
    out[i] = x * c - y * s + cx;
    out[i + 1] = x * s + y * c + cy;
    out[i + 2] = soup[i + 2] + (dz || 0);
  }
  return out;
}

function bbox(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
      if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
    }
  }
  return { lo: lo, hi: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/* Area of the soup's faces at one plane along N, facing `want`. The "how much
 * material is there at all" figure the contact is a fraction of. */
function faceAreaAt(soup, normal, offset, want, tol) {
  const fr = frameFor(normal || [0, 0, 1]);
  const tris = planarTris(soup, fr, offset, want, tol == null ? 1e-6 : tol);
  return tris.reduce((s, p) => s + Math.abs(signedArea(p)), 0);
}

module.exports = { interfaceContact, rotateZ, bbox, faceAreaAt, signedArea, clipConvex, frameFor, planarTris };

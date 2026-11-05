/* Controlled damage injection: take a mesh that is known clean and break it in
 * ONE named, parameterized way, and say in advance exactly what the canonical
 * checker (tools/mesh_validate.py) will read off the result.
 *
 * This is the pattern of tools/nso_open_make_fixtures.js (PR #82) - a clean
 * fixture plus one injected defect, deterministic, byte-stable, committed -
 * lifted out of per-fixture literals into a general tool. Node only; not
 * shipped. Every choice is a function of the input bytes, the parameters and
 * an integer seed, so the same call writes the same bytes.
 *
 *   const D = require('./nso_damage.js');
 *   const r = D.hole(soup, { severity: 'one', seed: 1 });
 *   r.soup       Float32Array, 9 floats per triangle - the damaged mesh
 *   r.expected   what mesh_validate.py --json must report on r.soup
 *   r.sites      where the damage went, in the input's coordinates
 *
 * Damage types (docs/DAMAGE.md has the whole table):
 *
 *   hole          remove a patch of triangles - by bounding sphere, by face-
 *                 index range, or by an explicit face list (a painted
 *                 selection). The real-hole case: open edges, nothing else.
 *   sever         cut a slot clean through a wall with the Manifold kernel,
 *                 capped. The cutClearance() case (nso_thickness.js): the mesh
 *                 stays a perfectly valid solid and the only thing that moves
 *                 is its topology - genus and body count.
 *   nonManifold   duplicate a patch in place (same or flipped winding), or flip
 *                 it without duplicating. Pure topology damage: not one
 *                 square millimetre of surface is removed.
 *   weld          split an edge with a new vertex a controlled distance from
 *                 one end. Geometry is unchanged; the question is only whether
 *                 the checker's 1e-4 weld collapses the pair. Under the radius
 *                 it does and the mesh reads non-manifold - the class of bug
 *                 rawCut had on Mirror-Join seams (244ae86). Over it the mesh
 *                 reads clean, which is the control.
 *
 * Severity: a number 0..1 or one of 'one' (0), 'light', 'moderate', 'heavy',
 * 'shredded' (1). It sets how many sites and how big each is; explicit
 * parameters override it.
 *
 * WHERE THE PREDICTION COMES FROM. Not from mesh_validate.py's weld: from the
 * exact float32 identity of the clean input's vertices, plus an explicit
 * merge map for the one type (weld) whose whole point is a merge. The input
 * is refused unless that exact identity and the checker's radius weld are
 * guaranteed to agree - every distinct vertex more than 2x WELD_TOL from every
 * other - so the prediction is topology the tool BUILT, and the checker reads
 * it off coordinates independently. tools/nso_damage_test.js holds the two
 * against each other. */
'use strict';

/* mesh_validate.py WELD_TOL and NSO_Repair.WELD_TOL. The canonical radius. */
const WELD_TOL = 1e-4;
/* mesh_validate.py: a triangle under this area is degenerate. */
const DEGEN_AREA = 1e-12;

const LEVELS = { one: 0, light: 0.25, moderate: 0.5, heavy: 0.75, shredded: 1 };

function level(sev) {
  if (sev == null) return 0;
  if (typeof sev === 'string') {
    if (!(sev in LEVELS)) throw new Error('unknown severity "' + sev + '" (' + Object.keys(LEVELS).join(', ') + ')');
    return LEVELS[sev];
  }
  if (!(sev >= 0 && sev <= 1)) throw new Error('severity must be 0..1, got ' + sev);
  return sev;
}

/* mulberry32 - a seeded integer PRNG, so "random" placement is a pure
   function of the seed and never of Math.random. */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------- topology */

/* Vertex identity by exact float32 value. No tolerance anywhere. By value and
   not by bit pattern because -0 and +0 are the same point: shape-sphere.stl
   has both on its equator, and a bitwise key reads that as 16 open edges. */
function exactIndex(soup) {
  const n = soup.length / 9;
  const f32 = soup instanceof Float32Array ? soup : new Float32Array(soup);
  const map = new Map();
  const verts = [];
  const index = new Int32Array(n * 3);
  for (let c = 0; c < n * 3; c++) {
    const key = f32[c * 3] + ',' + f32[c * 3 + 1] + ',' + f32[c * 3 + 2];
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length;
      map.set(key, id);
      verts.push([f32[c * 3], f32[c * 3 + 1], f32[c * 3 + 2]]);
    }
    index[c] = id;
  }
  return { verts, index, n };
}

/* The same counts mesh_validate.py's edge_report() takes, on a topology given
   as an index array - so a prediction and a measurement mean one thing. */
function census(index) {
  const n = index.length / 3;
  const und = new Map(), dir = new Map(), used = new Set();
  for (let t = 0; t < n; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    used.add(a); used.add(b); used.add(c);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? u + ',' + v : v + ',' + u;
      und.set(k, (und.get(k) || 0) + 1);
      const d = u + '>' + v;
      dir.set(d, (dir.get(d) || 0) + 1);
    }
  }
  let open = 0, nm = 0, odd = 0, wind = 0;
  for (const m of und.values()) { if (m === 1) open++; if (m > 2) nm++; if (m !== 2) odd++; }
  for (const m of dir.values()) if (m > 1) wind++;
  return {
    triangles: n,
    welded_vertices: used.size,
    unique_edges: und.size,
    open_edges: open,
    nonmanifold_edges: nm,
    odd_edges: odd,
    inconsistent_winding_edges: wind,
    euler_characteristic: used.size - und.size + n
  };
}

/* Boundary loops of an index topology: connected components of the graph of
   open edges. Not something the checker reports - it is how the tests tell
   "one hole" from "several" without trusting an edge count alone. */
function boundaryLoops(index) {
  const und = new Map();
  for (let t = 0; t < index.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const u = index[t * 3 + e], v = index[t * 3 + (e + 1) % 3];
      const k = u < v ? u + ',' + v : v + ',' + u;
      und.set(k, (und.get(k) || 0) + 1);
    }
  }
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const [k, m] of und) {
    if (m !== 1) continue;
    const [u, v] = k.split(',');
    if (!parent.has(u)) parent.set(u, u);
    if (!parent.has(v)) parent.set(v, v);
    parent.set(find(u), find(v));
  }
  const roots = new Set();
  for (const x of parent.keys()) roots.add(find(x));
  return roots.size;
}

function triArea(s, t) {
  const o = t * 9;
  const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
  const vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
function countDegenerate(soup) {
  let d = 0;
  for (let t = 0; t < soup.length / 9; t++) if (triArea(soup, t) < DEGEN_AREA) d++;
  return d;
}

/* Closest pair of DISTINCT vertices, by a grid hash at cell size `h`. Only
   pairs closer than h are guaranteed found; returns Infinity if none is. */
function closestPair(verts, h) {
  const inv = 1 / h, cells = new Map();
  let best = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const cx = Math.floor(p[0] * inv), cy = Math.floor(p[1] * inv), cz = Math.floor(p[2] * inv);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = cells.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
      if (!l) continue;
      for (const j of l) {
        const q = verts[j];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < best) best = d;
      }
    }
    const k = cx + ',' + cy + ',' + cz;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  }
  return best;
}

/* The precondition every damage type shares: the input is KNOWN clean, in a
   way that makes exact identity and the checker's radius weld the same
   topology. Throws with the reason otherwise - a damage tool that silently
   accepted a dirty input would report the input's defects as its own. */
function base(soup) {
  if (!soup || soup.length === 0 || soup.length % 9) throw new Error('not a triangle soup');
  const ex = exactIndex(soup);
  const c = census(ex.index);
  const why = [];
  if (c.open_edges) why.push(c.open_edges + ' open edges');
  if (c.nonmanifold_edges) why.push(c.nonmanifold_edges + ' non-manifold edges');
  if (c.inconsistent_winding_edges) why.push(c.inconsistent_winding_edges + ' inconsistent-winding edges');
  const dg = countDegenerate(soup);
  if (dg) why.push(dg + ' degenerate triangles');
  const gap = closestPair(ex.verts, 2 * WELD_TOL);
  if (gap <= 2 * WELD_TOL) why.push('two distinct vertices ' + gap.toExponential(3) + ' mm apart, inside 2x the weld radius');
  if (why.length) throw new Error('input is not known-clean: ' + why.join(', '));

  // Face adjacency across each undirected edge, for picking edges and growing patches.
  const edgeFaces = new Map();
  for (let t = 0; t < ex.n; t++) {
    for (let e = 0; e < 3; e++) {
      const u = ex.index[t * 3 + e], v = ex.index[t * 3 + (e + 1) % 3];
      const k = u < v ? u + ',' + v : v + ',' + u;
      if (!edgeFaces.has(k)) edgeFaces.set(k, []);
      edgeFaces.get(k).push(t);
    }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of ex.verts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return { soup, ex, census: c, edgeFaces, lo, hi, diag, minGap: gap };
}

function centroid(soup, t) {
  const o = t * 9;
  return [(soup[o] + soup[o + 3] + soup[o + 6]) / 3,
          (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
          (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
}
const r6 = x => Math.round(x * 1e6) / 1e6;

/* Faces picked by a region spec. `sphere` takes faces whose centroid is within
   the radius; `range` is [first, end) in file order; `faces` is a painted
   selection as face indices. Several specs may be given as an array. */
function selectRegion(b, region) {
  const specs = Array.isArray(region) ? region : [region];
  const out = new Set();
  for (const r of specs) {
    if (r.sphere) {
      const c = r.sphere.center, rr = r.sphere.radius;
      for (let t = 0; t < b.ex.n; t++) {
        const g = centroid(b.soup, t);
        if (Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]) <= rr) out.add(t);
      }
    } else if (r.range) {
      const [a, z] = r.range;
      if (!(a >= 0 && z <= b.ex.n && a < z)) throw new Error('face range [' + a + ', ' + z + ') outside 0..' + b.ex.n);
      for (let t = a; t < z; t++) out.add(t);
    } else if (r.faces) {
      for (const t of r.faces) {
        if (!(t >= 0 && t < b.ex.n && Number.isInteger(t))) throw new Error('face ' + t + ' outside 0..' + (b.ex.n - 1));
        out.add(t);
      }
    } else {
      throw new Error('region needs sphere, range or faces');
    }
  }
  return out;
}

/* Severity -> sphere sites: `count` seed faces drawn by the seed, each growing
   the region to every face whose centroid is within `radius` of the seed
   face's centroid. The seed face itself is always in, so a site is never empty. */
function autoSpheres(b, count, radius, seed) {
  const R = rng(seed);
  const picked = new Set(), sites = [];
  while (sites.length < count && picked.size < b.ex.n) {
    const t = Math.floor(R() * b.ex.n);
    if (picked.has(t)) continue;
    picked.add(t);
    sites.push({ sphere: { center: centroid(b.soup, t).map(r6), radius: r6(radius) }, seedFace: t });
  }
  return sites;
}

function withSeeds(b, sites) {
  const sel = selectRegion(b, sites);
  for (const s of sites) if (s.seedFace != null) sel.add(s.seedFace);
  return sel;
}

function pick(soup, faces) {
  const out = new Float32Array(faces.length * 9);
  faces.forEach((t, i) => out.set(soup.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}

function expectation(index, soup, extra) {
  const c = census(index);
  return Object.assign({
    triangles: c.triangles,
    welded_vertices: c.welded_vertices,
    open_edges: c.open_edges,
    nonmanifold_edges: c.nonmanifold_edges,
    odd_edges: c.odd_edges,
    inconsistent_winding_edges: c.inconsistent_winding_edges,
    euler_characteristic: c.euler_characteristic,
    degenerate_tris: countDegenerate(soup),
    piercing: 0
  }, extra || {});
}

/* ------------------------------------------------------------------ hole */

function hole(soup, opts) {
  opts = opts || {};
  const b = base(soup);
  const s = level(opts.severity);
  let sites;
  if (opts.region) {
    sites = Array.isArray(opts.region) ? opts.region : [opts.region];
  } else {
    const count = opts.sites || 1 + Math.round(s * 11);
    const radius = opts.radius != null ? opts.radius : b.diag * (0.03 + 0.09 * s);
    sites = autoSpheres(b, count, radius, opts.seed || 1);
  }
  const removed = withSeeds(b, sites);
  if (removed.size === 0) throw new Error('the region selects no faces');
  if (removed.size >= b.ex.n) throw new Error('the region selects every face - nothing left to be damaged');
  const keep = [];
  for (let t = 0; t < b.ex.n; t++) if (!removed.has(t)) keep.push(t);
  const out = pick(soup, keep);
  const idx = new Int32Array(keep.length * 3);
  keep.forEach((t, i) => idx.set(b.ex.index.subarray(t * 3, t * 3 + 3), i * 3));
  return {
    type: 'hole', severity: s, soup: out, sites,
    removed_faces: removed.size,
    boundary_loops: boundaryLoops(idx),
    expected: expectation(idx, out)
  };
}

/* ----------------------------------------------------------- nonManifold */

const NM_MODES = ['duplicate', 'duplicate-flipped', 'flip'];

function nonManifold(soup, opts) {
  opts = opts || {};
  const mode = opts.mode || 'duplicate';
  if (!NM_MODES.includes(mode)) throw new Error('nonManifold mode must be one of ' + NM_MODES.join(', '));
  const b = base(soup);
  const s = level(opts.severity);
  let sites;
  if (opts.region) {
    sites = Array.isArray(opts.region) ? opts.region : [opts.region];
  } else {
    const count = opts.sites || 1 + Math.round(s * 7);
    const radius = opts.radius != null ? opts.radius : b.diag * (0.02 + 0.06 * s);
    sites = autoSpheres(b, count, radius, opts.seed || 1);
  }
  const patch = [...withSeeds(b, sites)].sort((x, y) => x - y);
  if (patch.length === 0) throw new Error('the region selects no faces');
  if (mode === 'flip' && patch.length >= b.ex.n) throw new Error('flipping every face is a consistent mesh, not a defect');

  const n = b.ex.n;
  const extra = mode === 'flip' ? 0 : patch.length;
  const out = new Float32Array((n + extra) * 9);
  out.set(soup);
  const idx = new Int32Array((n + extra) * 3);
  idx.set(b.ex.index);
  const flip = (dst, di, src, si) => {             // a, c, b
    dst.set(src.subarray(si, si + 3), di);
    dst.set(src.subarray(si + 6, si + 9), di + 3);
    dst.set(src.subarray(si + 3, si + 6), di + 6);
  };
  const flipI = (dst, di, src, si) => { dst[di] = src[si]; dst[di + 1] = src[si + 2]; dst[di + 2] = src[si + 1]; };
  patch.forEach((t, i) => {
    if (mode === 'flip') {
      flip(out, t * 9, soup, t * 9);
      flipI(idx, t * 3, b.ex.index, t * 3);
    } else if (mode === 'duplicate') {
      out.set(soup.subarray(t * 9, t * 9 + 9), (n + i) * 9);
      idx.set(b.ex.index.subarray(t * 3, t * 3 + 3), (n + i) * 3);
    } else {
      flip(out, (n + i) * 9, soup, t * 9);
      flipI(idx, (n + i) * 3, b.ex.index, t * 3);
    }
  });
  return {
    type: 'nonManifold', mode, severity: s, soup: out, sites,
    patch_faces: patch.length,
    expected: expectation(idx, out)
  };
}

/* ------------------------------------------------------------------ weld */

/* Split edge (u, v) at a point `distance` from v, toward u. Both faces on the
   edge split in two, in their own plane, so the surface is not moved by a
   single ulp beyond float32 rounding of the new point. What changes is that
   two DISTINCT vertices now sit `distance` apart. At or under WELD_TOL the
   checker's radius weld makes them one: each split face's short half collapses
   onto a doubled vertex, and the edges out of v to the two opposite corners
   are then walked four times. */
function weld(soup, opts) {
  opts = opts || {};
  const b = base(soup);
  const s = level(opts.severity);
  const distance = opts.distance != null ? opts.distance : WELD_TOL / 2;
  if (!(distance > 0)) throw new Error('distance must be > 0 (0 is a coincident vertex, not a collision)');
  const count = opts.sites || 1 + Math.round(s * 31);
  const R = rng(opts.seed || 1);
  const n = b.ex.n, verts = b.ex.verts;

  const edges = [...b.edgeFaces.keys()];
  const usedFace = new Set(), usedVert = new Set();
  const sites = [];
  let tries = 0;
  while (sites.length < count && tries < edges.length * 4) {
    tries++;
    const k = edges[Math.floor(R() * edges.length)];
    const faces = b.edgeFaces.get(k);
    const [a0, b0] = k.split(',').map(Number);
    // v is the end the new vertex crowds; take the lower id, deterministically.
    const v = a0, u = b0;
    if (faces.some(f => usedFace.has(f))) continue;
    // Keep sites apart: no face of one site may touch a vertex of another,
    // so every site's prediction is local and they cannot interact.
    const touched = new Set();
    for (const f of faces) for (let e = 0; e < 3; e++) touched.add(b.ex.index[f * 3 + e]);
    if ([...touched].some(x => usedVert.has(x))) continue;
    const P = verts[v], Q = verts[u];
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]);
    if (distance >= L / 2) continue;
    const w32 = new Float32Array([P[0] + (Q[0] - P[0]) * distance / L,
                                  P[1] + (Q[1] - P[1]) * distance / L,
                                  P[2] + (Q[2] - P[2]) * distance / L]);
    const realized = Math.hypot(w32[0] - P[0], w32[1] - P[1], w32[2] - P[2]);
    if (!(realized > 0)) continue;                // float32 put it ON v - try another edge
    // Nothing else may be inside the weld radius of w, or the collision is not
    // the one we meant to make.
    let other = Infinity;
    for (const f of faces) for (let e = 0; e < 3; e++) {
      const x = b.ex.index[f * 3 + e];
      if (x === v) continue;
      const X = verts[x];
      other = Math.min(other, Math.hypot(w32[0] - X[0], w32[1] - X[1], w32[2] - X[2]));
    }
    if (other <= 2 * WELD_TOL) continue;
    for (const f of faces) usedFace.add(f);
    for (const x of touched) usedVert.add(x);
    sites.push({ edge: [v, u], faces, w: [...w32], realized_distance: realized, merges: realized <= WELD_TOL });
  }
  if (sites.length < count) throw new Error('only ' + sites.length + ' of ' + count + ' weld sites fit on this mesh');

  // Build: every untouched face as-is; each split face as its two halves.
  const out = [], idx = [];
  let nextId = verts.length;
  const splitOf = new Map();
  for (const st of sites) {
    st.wId = st.merges ? st.edge[0] : nextId++;
    for (const f of st.faces) splitOf.set(f, st);
  }
  const pushTri = (A, B, C, ia, ib, ic) => { out.push(...A, ...B, ...C); idx.push(ia, ib, ic); };
  for (let t = 0; t < n; t++) {
    const I = [b.ex.index[t * 3], b.ex.index[t * 3 + 1], b.ex.index[t * 3 + 2]];
    const V = I.map(i => verts[i]);
    const st = splitOf.get(t);
    if (!st) { pushTri(V[0], V[1], V[2], I[0], I[1], I[2]); continue; }
    // rotate so the split edge is I[0] -> I[1], whichever way this face walks it
    let r = 0;
    while (!((I[r] === st.edge[0] && I[(r + 1) % 3] === st.edge[1]) ||
             (I[r] === st.edge[1] && I[(r + 1) % 3] === st.edge[0]))) r++;
    const a = I[r], c = I[(r + 1) % 3], o = I[(r + 2) % 3];
    const A = verts[a], C = verts[c], O = verts[o];
    // a -> w -> c along the edge, both halves keep the face's winding
    pushTri(A, st.w, O, a, st.wId, o);
    pushTri(st.w, C, O, st.wId, c, o);
  }
  const soupOut = new Float32Array(out);
  return {
    type: 'weld', severity: s, soup: soupOut,
    distance, weld_tol: WELD_TOL,
    sites: sites.map(st => ({ edge: st.edge, faces: st.faces, w: st.w.map(x => +x), realized_distance: st.realized_distance, merges: st.merges })),
    expected: expectation(Int32Array.from(idx), soupOut)
  };
}

/* ----------------------------------------------------------------- sever */

/* Slots are half-slabs: from the axis through the piece's bbox centre, out
   past the far side, `width` thick, taller than the piece. On a ring wall one
   slot turns the ring into a C (genus 1 -> 0, still one body) and each slot
   after that adds a body - the "thin connecting wall" severed, capped, and
   otherwise a perfectly valid solid. Needs the Manifold kernel, so async. */
let _wasm = null;
async function kernel() {
  if (_wasm) return _wasm;
  const path = require('path');
  const mod = await import('file://' + path.join(__dirname, '..', 'vendor', 'manifold', 'manifold.js'));
  _wasm = await (mod.default || mod)();
  _wasm.setup();
  return _wasm;
}
function toManifold(w, soup) {
  const n = soup.length / 9;
  const triVerts = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) triVerts[i] = i;
  const mesh = new w.Mesh({ numProp: 3, vertProperties: Float32Array.from(soup), triVerts });
  mesh.merge();
  return new w.Manifold(mesh);
}
function toSoup(m) {
  const mesh = m.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3;
  const out = new Float32Array(tv.length * 3);
  for (let t = 0; t < tv.length; t++) {
    out[t * 3] = vp[tv[t] * np]; out[t * 3 + 1] = vp[tv[t] * np + 1]; out[t * 3 + 2] = vp[tv[t] * np + 2];
  }
  return out;
}

async function sever(soup, opts) {
  opts = opts || {};
  const b = base(soup);
  const s = level(opts.severity);
  const slots = opts.slots || 1 + Math.round(s * 7);
  const width = opts.width != null ? opts.width : 1.0;
  const axis = opts.axis || 'z';
  const phase = opts.phase != null ? opts.phase : 0;            // degrees
  const ctr = [0, 1, 2].map(i => (b.lo[i] + b.hi[i]) / 2);
  const L = b.diag + 2;
  const w = await kernel();
  const live = [];
  const own = m => (live.push(m), m);
  try {
    const A = own(toManifold(w, soup));
    if (A.status() !== 'NoError') throw new Error('kernel refused the input: ' + A.status());
    const d0 = A.decompose();
    const g0 = d0.reduce((a, p) => a + p.genus(), 0), c0 = d0.length;
    d0.forEach(p => p.delete());
    let cut = null;
    const angles = [];
    for (let k = 0; k < slots; k++) {
      const ang = phase + 360 * k / slots;
      angles.push(r6(ang));
      // along +x from the axis, `width` in y, `2L` tall; rotate about z, then to the axis.
      let m = own(w.Manifold.cube([L, width, 2 * L], true));
      m = own(m.translate([L / 2, 0, 0]));
      m = own(m.rotate([0, 0, ang]));
      if (axis === 'x') m = own(m.rotate([0, 90, 0]));
      else if (axis === 'y') m = own(m.rotate([-90, 0, 0]));
      m = own(m.translate(ctr));
      cut = cut ? own(cut.add(m)) : m;
    }
    const O = own(A.subtract(cut));
    if (O.status() !== 'NoError') throw new Error('kernel refused the cut: ' + O.status());
    if (O.isEmpty()) throw new Error('the slots removed the whole piece');
    const parts = O.decompose();
    const bodies = parts.length;
    /* Manifold's genus() is 1 - chi/2 over the WHOLE mesh, which goes negative
       with more than one body. Per body is the number that means something. */
    const genusPerBody = parts.map(p => p.genus());
    parts.forEach(p => p.delete());
    const out = toSoup(O);
    const volRemoved = A.volume() - O.volume();
    if (!(volRemoved > 0)) throw new Error('the slots missed the piece');
    /* A slot that takes material but leaves body count and genus alone has
       notched the piece, not severed anything (one slot into a sphere). */
    if (bodies === c0 && genusPerBody.reduce((a, g) => a + g, 0) === g0) {
      throw new Error('the slots notch the piece but sever nothing - body count and genus unchanged');
    }
    /* The kernel's result must itself be exactly what the checker will read:
       a clean solid, with no two distinct vertices inside 2x the weld radius.
       A slot grazing a vertex can leave a sliver whose corners the 1e-4 weld
       then collapses - non-manifold edges nobody asked for. That is not the
       defect this type promises, so it is refused rather than reported. */
    const ex = exactIndex(out);
    const c = census(ex.index);
    const gap = closestPair(ex.verts, 2 * WELD_TOL);
    const chiKernel = 2 * bodies - 2 * genusPerBody.reduce((a, g) => a + g, 0);
    if (c.open_edges || c.nonmanifold_edges || c.inconsistent_winding_edges || gap <= 2 * WELD_TOL ||
        c.euler_characteristic !== chiKernel || c.welded_vertices !== O.numVert()) {
      throw new Error('the cut came out of the kernel with more than a severed wall (' +
        (gap <= 2 * WELD_TOL ? 'two vertices ' + gap.toExponential(3) + ' mm apart' :
         'census ' + JSON.stringify(c) + ' vs kernel chi ' + chiKernel) +
        '); move the slots (phase) or change the width');
    }
    return {
      type: 'sever', severity: s, soup: out,
      sites: angles.map(a => ({ slot: { axis, angle_deg: a, width, through: ctr.map(r6) } })),
      volume_removed: volRemoved,
      before: { genus: g0, bodies: c0, euler_characteristic: b.census.euler_characteristic },
      bodies,
      genus_per_body: genusPerBody,
      /* The prediction is the exact census of the kernel's output, and it has
         just been required to equal the kernel's own chi and vertex count, so
         the topology is attested twice before the checker ever sees it. */
      expected: expectation(ex.index, out)
    };
  } finally {
    for (const m of live) { try { m.delete(); } catch (e) { /* already gone */ } }
  }
}

/* One entry point by name, for manifests. Always returns a promise. */
async function apply(type, soup, opts) {
  switch (type) {
    case 'hole': return hole(soup, opts);
    case 'nonManifold': return nonManifold(soup, opts);
    case 'weld': return weld(soup, opts);
    case 'sever': return sever(soup, opts);
    default: throw new Error('unknown damage type "' + type + '"');
  }
}

/* The keys of `expected`, as mesh_validate.py --json spells them. */
function measuredFrom(r) {
  return {
    triangles: r.triangles,
    welded_vertices: r.welded_vertices,
    open_edges: r.open_edges,
    nonmanifold_edges: r.nonmanifold_edges,
    odd_edges: r.odd_edges,
    inconsistent_winding_edges: r.inconsistent_winding_edges,
    euler_characteristic: r.euler_characteristic,
    degenerate_tris: r.degenerate_tris,
    piercing: r.self_intersection ? r.self_intersection.pierce : null
  };
}

module.exports = {
  WELD_TOL, LEVELS, level, rng, exactIndex, census, boundaryLoops, base, selectRegion,
  hole, nonManifold, weld, sever, apply, measuredFrom, NM_MODES,
  /* The machinery under the damage types, for tools that build on the same
     guarantees (tools/nso_features.js): the kernel, soup <-> Manifold, the
     sub-weld pair search and the checker-keyed expectation. */
  kernel, toManifold, toSoup, closestPair, countDegenerate, expectation
};

#!/usr/bin/env node
/* Regenerate an overlapping-shell fixture as one real boolean union.
 *
 * The early hinge / strap fixtures (hinge_knuckle_box, hinge_knuckle_lid,
 * hinge_pip, lid_strap) were written by a generator that concatenated closed
 * shells with deliberate overlap. That slices correctly - a slicer union-fills
 * the overlap - but every overlap is a real piercing pair, so any CSG route
 * (Join, Subtract) hits it. This tool splits such a file into its welded
 * shells, lifts each into the same Manifold kernel app-join.js ships, unions
 * them, and writes the result. It is not a repair: each shell must already be
 * a closed, outward-wound solid, and the tool refuses anything else.
 *
 * Usage:
 *   node tools/nso_fixture_union.mjs in.stl out.stl [--header TEXT]
 *
 * Prints, per shell and for the union: triangle count, genus, volume. The
 * union volume is cross-checked by inclusion-exclusion against the shells'
 * pairwise intersections; if the two disagree the shells overlap three-deep
 * somewhere and the printed check line says so. Validate the output with
 * tools/mesh_validate.py (expect 0 piercing, 0 coplanar, 0 open edges).
 *
 * Node prints a MODULE_TYPELESS_PACKAGE_JSON warning when it loads the vendored
 * manifold.js, because that file is ESM under a package.json with no "type".
 * It is harmless; run with --no-warnings to silence it.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readSTL, writeSTL } = require(path.join(ROOT, 'tools', 'nso_stl_io.js'));

const WELD_TOL = 1e-4; // the checker's adjacency weld (tools/mesh_validate.py, axis 2)

/* Welded connected components of a raw soup. Radius weld over a grid with
 * neighbour-cell lookup, so two vertices either side of a cell boundary still
 * merge - the bare-grid-snap failure mesh_validate.py documents. */
function shells(soup, tol) {
  const nv = soup.length / 3;
  const idx = new Int32Array(nv);
  const verts = [];
  const grid = new Map();
  const cell = v => Math.floor(v / tol);
  for (let i = 0; i < nv; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const cx = cell(x), cy = cell(y), cz = cell(z);
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!bucket) continue;
      for (const j of bucket) {
        const v = verts[j];
        if (Math.abs(v[0] - x) <= tol && Math.abs(v[1] - y) <= tol && Math.abs(v[2] - z) <= tol) { found = j; break search; }
      }
    }
    if (found < 0) {
      found = verts.length; verts.push([x, y, z]);
      const k = `${cx},${cy},${cz}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(found);
    }
    idx[i] = found;
  }
  const parent = Int32Array.from({ length: verts.length }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const nt = soup.length / 9;
  for (let t = 0; t < nt; t++) { unite(idx[t * 3], idx[t * 3 + 1]); unite(idx[t * 3], idx[t * 3 + 2]); }
  const groups = new Map();
  for (let t = 0; t < nt; t++) {
    const r = find(idx[t * 3]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map(list => {
    const s = new Float32Array(list.length * 9);
    list.forEach((t, i) => s.set(soup.subarray(t * 9, t * 9 + 9), i * 9));
    return s;
  });
}

// Same lift as NSO_CSG.soupToManifold in app-join.js: index every corner, let
// Mesh.merge() weld the coincident ones, then construct.
function soupToManifold(wasm, soup) {
  const n = soup.length / 9;
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: soup.slice(),
    triVerts: Uint32Array.from({ length: n * 3 }, (_, i) => i),
  });
  mesh.merge();
  return new wasm.Manifold(mesh);
}

function manifoldToSoup(man) {
  const mesh = man.getMesh();
  const tv = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp || 3;
  const out = new Float32Array(tv.length * 3);
  for (let t = 0; t < tv.length; t++) {
    const vi = tv[t] * np;
    out[t * 3] = vp[vi]; out[t * 3 + 1] = vp[vi + 1]; out[t * 3 + 2] = vp[vi + 2];
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const hi = args.indexOf('--header');
  const header = hi >= 0 ? args.splice(hi, 2)[1] : null;
  const [inPath, outPath] = args;
  if (!inPath || !outPath) {
    console.error('usage: node tools/nso_fixture_union.mjs in.stl out.stl [--header TEXT]');
    process.exit(2);
  }
  const Module = (await import(path.join(ROOT, 'vendor', 'manifold', 'manifold.js'))).default;
  const wasm = await Module();
  wasm.setup();

  const soup = readSTL(inPath);
  const parts = shells(soup, WELD_TOL);
  console.log(`${inPath}: ${soup.length / 9} tris, ${parts.length} welded shells`);
  const mans = [];
  let sum = 0;
  parts.forEach((p, i) => {
    const m = soupToManifold(wasm, p);
    const vol = m.volume();
    console.log(`  shell ${i}: ${p.length / 9} tris, genus ${m.genus()}, volume ${vol.toFixed(4)}`);
    if (m.isEmpty() || !(vol > 0)) {
      console.error(`  shell ${i} is not a closed outward-wound solid; refusing`);
      process.exit(1);
    }
    sum += vol;
    mans.push(m);
  });

  const union = wasm.Manifold.union(mans);
  let pairwise = 0;
  for (let i = 0; i < mans.length; i++) for (let j = i + 1; j < mans.length; j++) {
    const x = mans[i].intersect(mans[j]);
    pairwise += x.volume();
    x.delete();
  }
  const bodies = union.decompose();
  const uv = union.volume();
  const ie = sum - pairwise;
  console.log(`  union: ${union.numTri()} tris, ${bodies.length} bodies, volume ${uv.toFixed(4)}`);
  console.log(`  check: sum of shells ${sum.toFixed(4)} - pairwise overlap ${pairwise.toFixed(4)} = ${ie.toFixed(4)}` +
              (Math.abs(ie - uv) < 1e-6 * Math.max(1, uv) ? '  (matches: no triple overlaps)' : '  (DIFFERS from union: triple overlap present)'));

  const out = manifoldToSoup(union);
  writeSTL(outPath, out, header || path.basename(outPath, '.stl'));
  console.log(`  wrote ${outPath} (${out.length / 9} tris)`);
  bodies.forEach(b => b.delete()); union.delete(); mans.forEach(m => m.delete());
}

main().catch(err => { console.error(err); process.exit(1); });

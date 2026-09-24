# Damage injection: known defects on known-clean meshes

`tools/nso_damage.js` takes a mesh that is known to be clean and breaks it in
**one** named, parameterized way. It also says up front exactly what the
canonical checker, `tools/mesh_validate.py`, will read off the result. It is for
testing repair and detection code on a defect whose size you already know.

```sh
npm run damage:test       # tools/nso_damage_test.js - the tool held to the checker
npm run damage:fixtures   # tools/nso_damage_make_fixtures.js --check - byte-diff fixtures/damage/
```

## Where it comes from: PR #82's pattern, generalized

`tools/nso_open_make_fixtures.js` (PR #82) established the pattern: a clean
shape and one injected defect, every coordinate a function of literals, the
file named `<clean>_<defect>.stl` with a header that says what it is, and a
`--check` that regenerates the files and byte-diffs them against what is
committed. That is kept exactly. Two things are new:

- **The defect is a parameterized call, not hand-placed literals.** Pick a type,
  a region or a severity, and a seed.
- **Every result carries its own expected census.** The call returns
  `expected`, keyed the way `mesh_validate.py --json` spells its fields, and
  `fixtures/damage/damage.json` stores it for every committed file.

## API

```js
const D = require('./tools/nso_damage.js');
const r = D.hole(soup, { severity: 'one', seed: 1 });   // or await D.apply('hole', soup, opts)
r.soup       // Float32Array, 9 floats per triangle
r.expected   // { triangles, welded_vertices, open_edges, nonmanifold_edges, odd_edges,
             //   inconsistent_winding_edges, euler_characteristic, degenerate_tris, piercing }
r.sites      // where the damage went
```

| type | parameters | what it does | signature the checker reads |
|---|---|---|---|
| `hole` | `region`: `{sphere:{center,radius}}`, `{range:[first,end)}`, `{faces:[...]}` (a painted selection), or an array of these; or `severity` + `seed` | removes the faces | open edges only; `boundary_loops` in the result says how many holes |
| `sever` (async) | `slots`, `width` (mm, default 1), `axis` (default `z`), `phase` (deg); or `severity` | Manifold subtracts half-slab slots from the bbox axis outward. The cut is **capped**. | a valid solid (verdict PASS). Only Euler, genus and body count move. |
| `nonManifold` | `mode`: `duplicate`, `duplicate-flipped`, `flip`; `region` or `severity` + `seed` | copies a patch in place, or flips it in place. No surface is removed. | duplicate: non-manifold + winding, 0 open. flip: winding only, 0 open, 0 NM. |
| `weld` | `distance` (mm, default 5e-5), `sites` or `severity`, `seed` | splits an edge with a new vertex `distance` from one end, in the faces' own plane | at or under 1e-4: exactly 2 non-manifold edges per site. Over it: clean. |

**Severity** is a number from 0 to 1, or one of `one` (0), `light`, `moderate`,
`heavy` or `shredded` (1). It sets how many sites there are and how big each
one is. At `one` you get a single site: for `hole`, one boundary loop covering
under 2% of the faces. At `shredded`, holes cover half a sphere, 32 welds
collide and 8 slots cut a ring into 8 bodies. Explicit parameters override it.

## Why the prediction can be trusted

- **It does not come from the checker.** The tool indexes vertices by exact
  float32 value. It builds the damaged topology itself, and counts edges on
  that topology with the definitions `edge_report()` uses. The checker gets
  coordinates only, and reaches its numbers through its own 1e-4 radius weld.
- **The input has to be known clean, in a way that makes the two agree.** The
  tool refuses any input with an open, non-manifold or mis-wound edge, or a
  degenerate triangle. It also refuses any input where two distinct vertices
  are within 2× the weld radius, because there the exact identity and the
  radius weld could disagree. Damage on top of damage is refused too.
  Otherwise the tool would report the input's defects as its own.
- **The weld type states its merge.** The one place the tool relies on the
  weld is the collision itself. There the prediction comes from the *realized*
  float32 distance, compared the way the checker compares it (`d² <= tol²`).
  So the prediction holds even where float32 rounding moves a point across the
  radius. At a requested 1.0×1e-4, every site rounds to just over the radius
  and none collide. At 0.999×, two of four do. The test sweeps across that
  boundary.
- **The sever type checks the kernel twice.** The Manifold result must match
  in three ways: its exact census must equal the kernel's own χ and vertex
  count, it must be clean, and it must have no vertex pair inside 2× the weld
  radius. A slot that grazes a vertex can leave a sliver thinner than the weld.
  The checker would then read non-manifold edges nobody asked for, so the tool
  **refuses** that result instead of reporting it. The first test run caught
  exactly this (3 slots of 2 mm on the torus; vertices 9.1e-5 mm apart). A
  slot that notches a piece without severing anything is refused as well.

## The damage types and the bugs they model

- **`sever` is the `cutClearance()` case** (`nso_thickness.js`,
  `tools/nso_wall_thickness_test.js` §7). A severed wall is *removed*
  material, not thinned material. The finished mesh passes the checker, and
  it passes the wall-thickness check. Only a question asked *before* the cut
  can see it. The test runs `cutClearance()` on the clean tube for the first
  slot's box and confirms it refuses. It then confirms that the severed result
  passes both finished-mesh checks, and that genus and body count are what
  moved.
- **`weld` is the rawCut seam bug** (244ae86). Two distinct vertices inside
  the 1e-4 radius get collapsed by the weld. The faces around them then stop
  agreeing, and a mesh with no real geometric defect reads non-manifold.
  `shape-torus_weld-near.stl` is the same split at 2e-4 mm, and reads clean.
  That makes it the control.
- **`nonManifold` is topology damage with nothing missing.** It is for testing
  whether a repair can fix connectivity without inventing or losing area.
- **`hole` is the real hole.** It removes faces and leaves open edges.

## Committed fixtures

`fixtures/damage/` holds twelve files and `damage.json`. See
`fixtures/damage/README.md` for the table. Six of them are also in
[nest-library](https://github.com/nolongerzzz/nest-library), where the Library
fetches every row from, and listed under **Test Fixtures**: one per defect
class plus the shredded extreme. `npm run damage:test` holds each committed
file to its manifest through the checker. With a nest-library checkout
(`NSO_LIBRARY_DIR`, or `../nest-library`, as CI has) it also checks that each
Library row's file there is byte-identical; without one it SKIPs that, out
loud. The generator copies the six into the checkout when there is one.

Because they sit under `fixtures/`, the repo-wide scanners pick
them up on their own. `selfint:equiv` holds `NSO_Repair.js` to the checker on
them, `defects:test` holds the viewport overlay's `locate()` to it, and
`fixtures:gate` checks their format.

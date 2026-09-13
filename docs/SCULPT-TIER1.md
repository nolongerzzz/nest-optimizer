# Sculpt tier 1 — vertex adjacency + global smoothing

`app-sculpt.js`, wired into `index.html` at the existing `?v=inside3` tag.
Self-test: `node tools/sculpt_selftest.js` (no deps; loads the shipped file
through `vm` so the browser file stays free of any node idiom).

Sections 1–3 of the module are headless: no DOM, no Three.js, no app state.
Section 4 is the `commit()` half, modelled on `commitSoften`, and no-ops
wherever those helpers are absent.

## API

```
NSO_sculptWeldTol(rawTris, want)          -> tolerance
NSO_buildAdjacency(rawTris, opts)         -> indexed mesh + CSR vertex graph
NSO_adjacencyToRaw(adj, pos)              -> flat Float32Array soup
NSO_sculptMetrics(rawTris, adj)           -> bbox / volume / area / edges
NSO_smoothGlobal(rawTris, opts)           -> { ok, reason, tris, before, after }
NSO_sculptCommitRaw(m, working, type, s)  -> undo + display rebuild
NSO_smoothSelectedModel(opts)             -> smooth the selection and bake
```

`NSO_smoothGlobal` opts: `passes`, `strength` (0..1), `pinBoundary`, `tol`,
`adj`, `gate`, `maxVolumeChange`. On refusal `ok` is false and `tris` is the
**original** soup, so a caller can swap unconditionally.

## Topology is untouched

Smoothing reuses the index buffer verbatim; only `pos[]` changes. Every run
in the self-test reports identical vertex count, triangle count and edge
counts before and after. Verified on all fixtures.

## The tradeoff, stated once

Global Laplacian smoothing has **no feature preservation and no way to
protect a region**. It rounds every sharp edge it reaches and moves every
surface toward its own centre of curvature. That is the algorithm. Selective
work — "smooth here, leave that corner" — is the brush tier. Nothing in this
file should grow a feature-detection term.

## Findings

**1. The tolerance cap was broken by two slivers.** `NSO_weldEpsFor` in
`app-join.js` caps the weld tolerance at `minEdge / 3` using the strict
minimum edge in the soup. On
`fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl`, 2 edges out of
98,586 are shorter than 1e-4 (shortest 1.499e-5). The strict minimum drags
the tolerance to 5e-6, float32 rounding then keeps ~400 vertex pairs apart,
and the part reports **1402 open edges**. It is not open: at 3e-5 it welds to
V−E+F = 2, 0 open, 0 non-manifold. `NSO_sculptWeldTol` splits the two
populations — edges below the requested tolerance are what the caller asked
to weld, edges above it are the detail to protect — and takes the cap from
the longer population *unless* the short edges exceed 1% of the mesh, in
which case they are the piece's real feature scale (the wrapped-surface case
the original cap was written for) and the strict minimum is right. Tape mesh
now welds at 4.2e-5: 0 open, 0 non-manifold, V−E+F = 2. Both branches have a
test in section 0. **`NSO_weldEpsFor` still has the original behaviour and is
used by both booleans — not changed here, but it is the same bug.**

**2. Undirected edge pairing does not detect a backwards face.** A mesh with
a face wound the wrong way pairs every edge and reads 0 open / 0
non-manifold, while its volume is wrong by twice that face's contribution.
`NSO_buildAdjacency` therefore also counts directed edges (`stackedDirs`),
the way `rawCheckWatertightQuick` does, and `watertight` requires
`stackedDirs === 0`. This caught three separate winding errors in the
self-test's own fixture generators during development — a 20mm box reporting
volume 2666.67 instead of 8000, and a tube reporting 1044 instead of 3142 —
each of which passed the undirected test cleanly.

**3. Collapse is driven by tessellation, not by wall thickness.** Same
22/18 mm tube, 25 mm tall, only the axial divisions change:

| nz | verts | vol after 1 pass | vol after 5 | height after 5 |
|----|-------|------------------|-------------|----------------|
| 1  | 192   | −55.9%           | −98.3%      | 3.29 of 25     |
| 2  | 288   | −31.0%           | −84.5%      | 10.05          |
| 4  | 480   | −15.8%           | −52.5%      | 17.12          |
| 8  | 864   | −8.2%            | −27.9%      | 21.06          |
| 16 | 1632  | −4.4%            | −15.4%      | 23.03          |

The part is identically thin in every row. What changes is how many neighbour
hops separate a vertex from geometry on the far side of the thin section. The
classic "thin features collapse" is really "coarsely tessellated features
collapse": a 40×40×1.5 slab at 20×20 divisions holds its 1.5 mm thickness to
99.9% for 25 passes and shrinks *in plane* instead, because its face interiors
have no neighbours across the gap. Meanwhile the 12-triangle 20 mm cube loses
80% of its volume in **one** pass — 8 vertices, all of them corners.

**4. Smoothing can add volume.** `library/box_closed.stl` is a hollow tray
plus a lid slab. One pass at strength 0.5:

| shell | before | after 1 pass |
|-------|--------|--------------|
| tray  | 13632  | 32784 (+140.5%) |
| lid   | 5760   | 1125 (−80.5%)   |

The tray's outer skin shrinks like everything else, but its 25 mm cavity is
concave from the solid, so the cavity wall is driven into the void and the box
fills in. This is why the optional budget is `maxVolumeChange` (two-sided) and
not a shrinkage budget — a part being filled in passes a loss-only test.

**5. The gate is a topology gate, not a safety gate.** A 384-triangle
thin-wall tube smooths to 0.001 mm tall, 100% of its volume gone, and passes
every check with 0 open and 0 non-manifold edges: a wafer is a perfectly
watertight wafer. `NSO_smoothGlobal` stays unopinionated; `NSO_smoothSelectedModel`
defaults `maxVolumeChange` to 0.25 because a user with a button has no other
guard.

**6. A pass reaches exactly one graph hop.** On a 24×24 tessellated cube,
vertices further from a sharp edge than the pass count have not moved at all
(0.00e+0). A flat face stays flat in its interior; the rounding is a rim
effect eating inward one ring per pass. Pass count, not strength, is the
parameter that decides how much of a part global smoothing touches.

## Not fixed here

- `NSO_weldEpsFor` (app-join.js) carries finding 1's bug for both booleans.
- `NSO_edgeStats` / `rawCheckWatertightQuick` weld by coordinate rounding, so
  they cannot see finding 2 at all and they mis-report finding 1's mesh in the
  other direction (0 open at 1e-4 buckets). `NSO_sculptMetrics` reports the
  indexed and positional counts side by side rather than picking one.
- `tools/stl_watertight_check.py` rounds to 1e-5, which is too tight for a
  float32 STL of an 82 mm part: it reports 1406 false open edges on the tape
  fixture.

These are named, not touched — each is someone else's gate.

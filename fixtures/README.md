Test meshes for Claude / Grok. Not shipped to Pages as product files.

- box-20mm.stl — closed 20 mm cube, origin-centered, Z-up, 12 triangles.
  Soften gate: one Square split, then Corners / Round / Bevel at R=0.5. Lid must stay on the cut plane.

## Hinge and strap fixtures: real boolean unions since 2026-09-16

`hinge_knuckle_box.stl`, `hinge_knuckle_lid.stl`, `hinge_pip.stl` and
`lid_strap.stl` (identical copies in `library/`) were first written by an
early generator that concatenated closed shells with deliberate overlap. That
slices correctly (a slicer union-fills the overlap) but every overlap was a
real piercing pair, so Join / Subtract could not be run on them cleanly.

They are now the real boolean union of those shells, produced by
`tools/nso_fixture_union.mjs` through the same Manifold kernel `app-join.js`
ships. Measured with `tools/mesh_validate.py` (0 piercing, 0 coplanar, 0 open,
0 non-manifold on every one):

| file | tris before → after | shells → bodies | volume before (double-counted) → after |
|------|--------------------|-----------------|-----------------------------------------|
| hinge_knuckle_box | 780 → 730 | 4 → 1 (genus 3) | 741.084 → 636.096 mm³ |
| hinge_knuckle_lid | 524 → 460 | 3 → 1 (genus 2) | 526.056 → 456.064 mm³ |
| hinge_pip | 1468 → 1528 | 11 → 6 (5 knuckle units + the free pin) | 1295.343 → 1235.684 mm³ |
| lid_strap | 24 → 28 | 2 → 1 | 6120.000 → 6048.000 mm³ |

The "after" volume equals sum-of-shells minus pairwise overlap on each file,
so nothing overlapped three deep and nothing was lost. Bounding boxes are
unchanged and cross-section areas at five heights match the union-filled
originals to 3e-7 mm², so they slice exactly as before. `hinge_pip` stays a
multi-body file on purpose: the pin has clearance inside the knuckles.

`library/box_closed.stl` is NOT regenerated; see `library/README.md`.

## raster-lines/ — the flat-printed-line importer's inputs and outputs (2026-09-18)

Four rasters and the STL each one builds, regenerated and byte-diffed by
`npm run raster:fixtures` (`tools/nso_raster_fixtures.js`); `raster-lines.json`
carries every number. These are **inputs** as well as outputs: the `.pbm` /
`.pgm` files are what `nso_raster_lines.js` is fed, the `.stl` files are what it
builds from them.

Netpbm rather than PNG on purpose — uncompressed, stdlib-only to read, and the
one raster format a text editor can still open. The binary ones are P4 (packed
1-bit, 99 KB for 900²); `zigzag-layer-aa.pgm` is P5 grayscale because a
threshold is exactly what it exists to exercise.

**Every one is drawn with its lines at 45° to the canvas edges**, which is where
a slicer prints an interface layer. The first committed set was drawn
axis-aligned — measured at 94.03% of its wall length in the 89–91° band and
0.00% at 45° — and nothing caught it, because every other number in the suite is
invariant under a rigid turn. `npm run raster:angle` is the instrument that does
catch it, `raster-lines.json` records each fixture's measured angle, and the
canvas is 45 mm because a 30 mm pattern turned 45° needs 30·√2 = 42.43 mm.

| file | what it is |
|------|------------|
| `zigzag-layer.pbm` | the reference: one layer of the real two-layer zigzag, 15 lines at 2.0 mm pitch over 30 mm, at 45°, drawn with a 0.25 mm stroke |
| `zigzag-layer-fat.pbm` | the same centrelines drawn 0.65 mm wide, 2.3× the ink — must trace to the same line |
| `zigzag-layer-aa.pgm` | the same centrelines, anti-aliased, at half the resolution |
| `crosshatch.pbm` | 15 lines each way in one picture — 225 four-way junctions, at 45° and 135° |

Every STL: 0 open, 0 non-manifold, 0 degenerate, 0 sliver, 0 piercing, 0
coplanar, exactly 0.300 mm tall, volume = top-face area × height. The three
zigzag variants trace within 0.8% of the same 469 mm of line — not the same
triangle count any more, which was an axis-aligned artefact: Zhang–Suen chamfers
a diagonal corner more heavily the fatter the stroke. `crosshatch.stl` is Euler
−390 = genus 196 = the 14 × 14 holes in the lattice. See `docs/RASTER-LINES.md`.

`crosshatch.pbm` is a picture of a *finished* interface seen from above, and it
is a **tracer** fixture, not a printable layer: a layer with lines both ways
cannot be crossed by the layer above it. What a printable crosshatch layer looks
like is in `crosshatch/` below.

## crosshatch/ — the crosshatch as two one-direction layers (2026-09-18)

Four STLs and `crosshatch.json`, regenerated and byte-diffed by
`npm run crosshatch:fixtures` (`tools/nso_crosshatch_fixtures.js`). Built by
`nso_crosshatch.js` at the shipped crosshatch relief's **own** numbers — 1.2 mm
pitch, a 0.42 mm line, 0.3 mm per layer — so these and the shipped loose patch
the audit measures are the same pattern differing in the construction alone.

| file | what it is |
|------|------------|
| `layer1.stl` / `layer2.stl` | one printed layer on its own: a boustrophedon at 45° / 135°, 972 tris, closed, Euler 2, 0 piercing |
| `interface.stl` | the two of them, layer 2 set down on layer 1 — 1944 tris, two shells touching at z = 0.3, Euler 4 |
| `interface-45.stl` | **the re-tile**: a 45 mm target instead of 30. Same pitch, same line, same channel, 37 repeats instead of 25, and the first 25 line centres identical bit for bit |

The number they exist to hold: **110.2500 mm² of contact in 625 isolated patches,
every one exactly 0.176400 mm², none spanning more than one line width's
diagonal** — against the bidirectional lattice's 519.750 mm² in a single patch
across the whole footprint. `crosshatch.json` records both sizes' contact,
per-layer angle histograms and line centres. See `docs/CROSSHATCH.md`.

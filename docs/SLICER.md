# In-house slicer — real layers, walls, infill and overhang calls

`nso_slicer.js` (`window.NSO_Slicer`, and a Node module) · G-scope's **Slice**
action (`app-gscope-slice.js`) · checks `slicer:test`, `slicer:bambu`,
`gcode:gscope-slice`, all in `npm test`.

**What it is for:** reverse-engineering and internal iteration. It is a real
slicer: exact sections, measured offsets and real line families. You
can read its output line by line in G-scope and measure it against a real
slice.

---

## 1. The geometry foundation, and the licence chain (Task 1)

### Choice: Clipper2, through the manifold-3d build the repo already vendors

Clipper (Angus Johnson, Boost Software License 1.0) was the leading candidate.
It turned out to be **already in the stack**. `vendor/manifold/manifold.wasm`
(manifold-3d 3.5.3, Apache-2.0) compiles in **Clipper2**, Clipper's successor
by the same author under the same licence. It exposes it to JS as
`wasm.CrossSection`:

- `new CrossSection(polys, fillRule)`
- `offset(delta, 'Miter' | 'Round' | 'Square', miterLimit)`
- `add`, `subtract`, `intersect`, `CrossSection.union`
- `area`, `isEmpty`, `toPolygons`, `decompose`, `simplify`, `bounds`

All of these were probed in Node and in the page. The kernel already loads in
both places: `NSO_CSG.load()` in the app, and the vendored file in Node.

So this adds **no new dependency and no new binary**. The alternatives were
`clipper-lib` (npm, a JS port of Clipper 1, BSL-1.0) and `js-angusj-clipper`
(MIT, a WASM build of Clipper 1). Both are clean, but either would have put a
second, older Clipper next to the one already shipped.

Two binding facts the adapter (`geometry()`) exists for:

- `new CrossSection([])` throws, because its `polygons2vec` reads
  `polygons[0]`.
- A list whose first polygon has fewer than 3 points is taken for a single
  polygon.

Both are handled. Every WASM object made during a slice is freed with it.

### Audited, not assumed

| layer | what | licence | how verified |
|---|---|---|---|
| kernel | manifold-3d 3.5.3 | Apache-2.0 | `vendor/manifold/LICENSE` |
| compiled into `manifold.wasm` | Clipper2 (`Clipper2Lib`), linalg, a TBB init hook, the Emscripten runtime | BSL-1.0; Unlicense; Apache-2.0; MIT/NCSA | `strings` on the wasm. No GPL / AGPL marker found |
| npm, whole lockfile | `three` (MIT), `playwright`, `playwright-core` (Apache-2.0), `fsevents` (MIT) | permissive | `package-lock.json`, every package |
| this code | `nso_slicer.js`, `app-gscope-slice.js` | the repo's MIT | written here |

**No GPL or AGPL code anywhere in the chain.** Two things were checked and are
stated so nobody has to re-check them:

- **The rules are measured, not ported.** Every wall, infill, shell and
  top-surface rule below was fitted to real Bambu Studio *G-code output*
  (black-box) and is cited to that measurement. No source was copied or ported
  from Bambu Studio, OrcaSlicer or PrusaSlicer (all AGPL) or from Cura (LGPL).
  Triangle/plane sectioning, polygon offsetting and scanline hatching are
  textbook computational geometry.
- **AGPL data exists in the repo, not in this chain.** `fixtures/3mf/pa_pattern.3mf`
  and `flowrate-test-pass2.3mf` are Bambu Studio calibration files,
  redistributed as AGPL test data (`fixtures/3mf/README.md`). The slicer never
  loads them. The two real slices it measures against are the user's own
  projects.

---

## 2. The pipeline (Tasks 2–5)

1. **Layers.**
   - `print_z` is the top of each layer; the section is cut at mid-layer.
   - The first layer height is configurable.
   - All objects share one layer grid and one drop onto the plate.
2. **Exact sections** (`sliceMesh`, pure JS).
   - Vertices are welded at the repo's one tolerance (1e-4 mm, first
     representative, as `mesh_validate.py` does).
   - A vertex exactly on a plane counts as above it.
   - A crossing point is keyed by its **mesh edge**, so the two triangles
     sharing an edge produce bit-identical points. The loop closes by key with
     no tolerance.
   - Orientation comes from triangle winding: the segment runs from the
     edge crossing down to the edge crossing up. Outer loops come out CCW and
     holes CW (checked on a tube).
   - Inside-out meshes are detected and read reversed.
   - Open meshes: open chains are stitched end to start, then chorded shut
     within `gapCloseMm`. That value is 2 mm, **stated, not measured**. A
     non-solid piece gets 0. Anything left is dropped and counted.
3. **Regions.** Positive fill rule. Bambu's `slice_closing_radius` (0.049) and
   `resolution` (0.012) are applied, both taken from the real config blocks.
4. **Walls** (`perimeters`). The loops are:
   - outer: the section shrunk by `w/2`;
   - second: shrunk again by half of each spacing;
   - each further loop: one more spacing in.

   Spacing is `w − h(1 − π/4)`, the stadium model `nso-gcode-lines.js`
   inverts. A loop that offsets to nothing is where the part is too thin, and
   the layer gets fewer walls there.
5. **Shells.** A layer is solid wherever the next `T` layers above, or the `B`
   layers below, do not all cover it. `T = max(top_shell_layers,
   ⌈top_shell_thickness / h⌉)`.
   - Exposed from above: Top surface.
   - Exposed from below: Bottom surface on layer 0, Bridge otherwise.
   - Solid laid onto the layer below's sparse: an internal Bridge.
   - Everything else: Internal solid infill.
6. **Infill** (`scanFill` + `connect`).
   - Lines on a global grid, so a family lands on the same lines every layer.
   - Crossings are half-open, so a vertex on a line counts once.
   - Joined into paths by the nearest free end.
   - `grid`: both families on every layer, each at `2·spacing/density`.
   - `zigzag` / `lines`: one family per layer at `spacing/density`,
     alternating direction; `lines` is never joined.
   - Solid infill: zigzag at the spacing, direction alternating per layer.
7. **Overhang** (`overhangs`). This layer's section, minus the layer below
   grown by the printable step `h / tan(threshold)`.
   - Islands under one line² are dropped.
   - Islands are linked upward into 3D regions across one step plus one
     line, because a growing overhang such as a sphere's underside moves
     outward by a step each layer.
   - Each region reports the layer range, footprint, and what a support would
     stand on (`plate`, `model` or `both`, with areas).
   - Wall runs over air are tagged `Overhang wall`.
8. **Conflicts.** Two objects whose sections overlap on a layer, numbered from
   1 as Bambu numbers layers.
9. **G-code** (`toGcode`). Bambu's own tags (`; CHANGE_LAYER`, `; Z_HEIGHT`,
   `; LAYER_HEIGHT`, `; FEATURE`), M83, with E computed from the coordinates
   **as written**. `parseGcode` recovers every width to 2e-4 mm with nothing
   assumed.

---

## 3. The rules, measured on a real slice

`fixtures/3mf/supportwithinsupport.gcode.3mf` is the user's Bambu slice: 0.6 mm
nozzle, 0.62 mm lines, 0.3 mm layers. Its lower block has a footprint of
**30.000 × 30.000 mm** in `Metadata/plate_1.json`, known independently of every
move. `slicer:bambu` §1 re-measures all of this on every run:

| rule | Bambu, measured | formula | used as |
|---|---|---|---|
| outer wall centre inside the part | 0.310 / 0.310 mm (x / y) | `w/2` = 0.310 | the outer loop |
| outer → inner wall | 0.556 mm | `w − h(1−π/4)` = 0.5556 | every loop step |
| inner wall → infill line centres | 0.472 mm | 0.85 × spacing = 0.4722 (`infill_wall_overlap` 15 %) | the infill boundary |
| sparse `grid`, one family's pitch | 7.408 mm, 45° and 135° on every layer | `2 × spacing / density` = 7.408 | the grid |
| grid joins | 2.22 / 4.11 / 6.37 mm along the boundary, to the nearest line of *either* family; never the 10.48 mm hop | nearest free end | `connect` |

Three more rules were fitted where the first pass disagreed with Bambu. Each is
labelled a fit, and its evidence is stated:

- **One wall on top surfaces** (`top_one_wall_type = all top` in both files).
  - At z 8.1 of `supportwithinsupport`, 13 ribs sit on the block's top.
  - Bambu keeps **one** inner loop around the whole rib field, at
    75.204 / 79.260.
  - Rule: grow the layer above by `topWallMergeMm` (2w; this merges the
    1.125 mm rib gaps). The exposed rest loses its extra walls, and so does
    everything within `topWallKeepMm` of it (2w + 0.985 mm).
  - Result: the loop lands on Bambu's to **1 µm**. It is one data point, so
    it is a fit.
- **Narrow sparse strips print solid.**
  - Strips 0.875 mm wide (under the ribs) came out solid; strips 1.0 mm wide
    (over the tabletop's leg arms) stayed sparse.
  - The threshold is 1.7 × spacing = 0.944 mm, inside that bracket. The same
    width folds narrow solid strips between top surfaces into the top
    surface, as z 8.1 shows.
- **Internal bridges need room.**
  - Over the tabletop's 1.0 mm leg arms Bambu printed plain solid; over the
    27 mm field under the block's lid it printed a Bridge.
  - Opened by one line width. The bracket is wide.

---

## 4. The measured constants (Task 6)

`NSO_Slicer.CONSTANTS`. Each entry carries a `source` string, and `slicer:test`
§8 fails if one is missing.

| constant | value | source | drives |
|---|---|---|---|
| wall / infill line | **0.42 mm @ 0.4, 0.63 mm @ 0.6** (1.05 × nozzle) | `nso_thickness.js floorFor`, pinned by `wall:test` | the default widths |
| Bambu's own line at 0.6 | 0.62 set, 0.609 recovered from E | both real slices' config / moves | the like-for-like comparison |
| support threshold | 30° Bambu; 45° auto-aim | both real config blocks; `NSO_SupportAim` marks 45 "stated, not measured" | the default (30), and the 45 comparison |
| tree taper | d = 2 + 2 tan 5° × depth (measured eqD = 1.97 + 0.172 × depth, r² 0.988, 1,824 slices) | `docs/SUPPORT-TREE-SHAPE.md`, `tree:shape` | read back off the sliced tree, `slicer:bambu` §4 |
| tree wall | one line from 2.2 mm up | the same file, Finding 2 | the tree wall-count check |
| support gap | 0.18 designed, **0.182** measured | `GAP_MM`; commit `131c524` (`nso_tri_distance.js`) | layers 88 / 89 / 90 / 91 on the tape artifact |
| interface strands | NSO 0.42 @ 1.2 pitch, 2 layers; Bambu 0.61 @ 1.09 | `nso_support_interface.js` / `nso_crosshatch.js`; `gcode:zfilter`, `tree:reference` | read back off the sliced interface |

The line width is the one number the two sources disagree on. The repo's floor
at 0.6 is **0.63**; the real Bambu profile runs **0.62**. The slicer defaults
to the repo's 0.63. The Bambu comparison passes Bambu's 0.62 explicitly,
because it compares like with like.

---

## 5. Validation against real Bambu slices (Task 7)

`npm run slicer:bambu`: 51 checks, about 70 s. Result: **51 passed, 7 findings
recorded.**

### What there is to compare with, honestly

- **Two real slices, no meshes.** Both real Bambu slices in `fixtures/3mf/`
  carry G-code and settings but **no source mesh**: `3D/3dmodel.model` is
  empty. So each piece was **reconstructed**, from evidence independent of
  the logic under test:
  - `supportwithinsupport`: the block's footprint comes from `plate_1.json`.
    Heights come from the layers each part occupies. The ribs and the
    20.000 × 20.000 upper box come from their outer walls at the measured
    inset.
  - `tabletop`: four X-shaped legs and a 70 × 70 slab. Every reconstructed
    number came out round: 1.000 mm cards 14.000 mm long, a 70.000 mm slab.
    That is the evidence it is the part and not a fit to it.
  - Outer-wall *position* is therefore partly circular and is reported as a
    consistency check. Wall **count**, inner-wall position, shells, infill and
    every overhang call are independent.
- **The strut / tree artifact.** Its only real Bambu record is the relayed
  report: *"the tree and the piece overlapping at layer 91"*. **This repo holds
  no Bambu G-code of it**, so its wall counts can only be compared with what
  Bambu does to its *own* trees. The user's staged sources on `nest-wip` were
  not reachable from this session.

### Agreement

| | in-house | Bambu |
|---|---|---|
| object layer heights | every one | — |
| wall-loop count per layer | **48 / 48** (supportwithinsupport), **73 / 73** (tabletop) | — |
| thin X legs (1.0 mm cards) | one wall, like Bambu | one wall |
| inner wall position | Hausdorff **0.001 mm** on both pieces | — |
| outer wall position (consistency) | 0.001 / 0.010 mm | within its own `resolution` 0.012 |
| feature set per layer | same on **47 / 48** and **71 / 73** layers | — |
| solid infill length | ×1.049 and ×0.998 | — |
| sparse infill length (supportwithinsupport) | ×0.877 | — |
| tabletop slab needs support from the plate | footprint 4,671 mm² | interface there; **100 % / 100 %** coverage both ways at one 1.09 mm pitch |
| upper box needs support, on the model | 400 mm² at z 9.3 | interface printed on the block, reaching 1.4–3.1 mm past it (support expansion, not built here) |
| no other support-need region | 1 on each piece | 1 on each piece |
| tape, pre-interface | tree / piece overlap at **layer 91** (5.34 mm², the largest); the strut clear | *"overlapping at layer 91"* |
| tape, with interface | no overlap; supports end at 89; layer 90 empty; underside from 91 | — (the artifact tool's prediction) |
| sliced interface | 2 strands × **0.420 mm** at **1.200 mm** pitch, 90° apart | NSO design |
| sliced tree trunk | follows the taper law to **0.0002 mm** over 27 layers; tip 2.060 = law | the law Bambu's trees were measured to |
| tree tube walls at 0.4 | one wall on every tube layer (82 / 82) | Bambu's trees: one line |

### Disagreement, and challenges (the 7 findings)

1. **detectOverhangs vs the real slice.** Under supportwithinsupport's upper
   box, Bambu printed support interface (`support_on_build_plate_only = 0`),
   and the layer comparison calls the same region. `NSO_SupportAim.detectOverhangs`
   calls it *self-supported* at 30° and at 45°, because its downward ray meets
   the block 0.9 mm below. That is by design, since auto-aim only builds
   plate-standing struts. But **detectOverhangs is not a support-NEED detector
   for anything over the piece itself**. On the tabletop both agree.
2. **Shells above a bridge.** In both files Bambu thins the **third** layer
   over a bridge:
   - supportwithinsupport z 10.2: a solid centre with a sparse ring by the
     walls;
   - tabletop z 21.0: sparse over the legs only.

   It keeps the first two fully solid, including z 20.4 / 20.7 over the leg
   arms. The in-house rule counts plain layers, so it differs on those three
   layers. A black-box hypothesis consistent with both: bridge shells anchored
   about 1 mm into the supported area, shrinking layer by layer. It is **not
   built**, because two data points do not pin it.
3. **Tape, extra overlap layers.** The in-house slice also reports:
   - layers 87 and 88: 0.01 and 0.07 mm², a tree tip grazing a side wall (the
     0.26 mm reach commit `e50eaea` measured);
   - layer 92: 1.17 mm², the same tip as layer 91.

   Whether Bambu lists every layer is not on record, so these are neither
   confirmed nor contradicted.
4. **The artifact at the real nozzle.** The tape tree is bored at a **0.42 mm**
   wall (`floorFor(0.4)`). Sliced with the 0.6 nozzle's 0.63 mm line, **76 of
   82 tube layers get no wall at all**. This is an in-house prediction, not yet
   seen in a real 0.6 slice. For the 0.6 nozzle, build the tree at
   `hollowWallMm = 0.63`.
5. **Interface strands.** NSO builds 0.42 mm strands at a 1.2 mm pitch. Bambu's
   own interface is 0.61 mm at 1.09 mm: the same two-layer,
   one-direction-per-layer construction at 0.6-nozzle widths.
6. **Not built:**
   - `Floating vertical shell` (`ensure_vertical_shell_thickness`), skipped in
     the comparison;
   - support *generation* (detection only);
   - support expansion;
   - seams and wall ordering beyond inner-then-outer;
   - ironing, gap fill, arc fitting;
   - Arachne variable-width walls (both real files use `classic`).
7. **Sparse infill length** is 12 % short on supportwithinsupport. The
   diagonal lines agree to 3.6 %; the rest is the grid's boundary joins.

---

## 6. G-scope: the Slice action (Task 8)

Slice is the View row's **Slice view** button (`#ms-cam-slice`), the other
half of a Normal / Slice view toggle (docs/GCODE-MICROSCOPE.md, "The View
toggle"). It is offered for any mesh document: *Read the plate*, or an STL /
3MF opened into G-scope. It slices at once with whatever the **Slice
settings** hold - a disclosure in the Slice (in-house) section, collapsed by
default, whose values persist across round trips. Defaults are the real
setup: a 0.6 nozzle, 0.3 mm layers, 2 walls, 15 % grid, support below 30°.

**Slice view** does four things:

1. slices every piece in one frame;
2. writes the G-code text;
3. reads it back with `NSOGcodeLines.parseGcode`;
4. opens it with `NSO_MICROSCOPE.openToolpathResult`, **the entry a
   `.gcode.3mf` import uses**.

From the parser down, nothing can tell an in-house slice from an imported one.
The legend, Pick a line, Isolate, the layer slider, Clear from view, the solid
view, Crop and both exports work unchanged. `gcode:gscope-slice` (45 checks,
real clicks) proves:

- the document keys, segment schema and move schema equal those of
  `supportwithinsupport.gcode.3mf` opened through the import route;
- its moves are, move for move, the direct call's.

The panel reports layers, walls per layer, each support-need region (z,
footprint, and what it stands on), and any **CONFLICT** by layer. The
floating legend opens on its **Detected features** tab: walls (loops and
width), infill (density and pattern), top / bottom, and one row per overhang
call, each a click to isolate its moves. **Normal** goes back through
`backToMesh()`, which re-opens the source: the whole part as it was, nothing
selected or isolated.

**The piece stays exportable the whole time its slice is shown.** The Slice
section keeps **Export piece to plate** and **Export piece as STL** for the
piece(s) the slice was made from, with no selection needed and nothing to go
back for. They build the same geometry, use the same name and make the same
calls as G-scope's own Export to plate / Export as STL for a loaded piece.
The slice's own beads export through G-scope's Export row as for any imported
slice.

- **Paint scope: none.** Slice reads geometry and writes nothing. Export
  piece to plate adds a copy of the piece as a new piece and edits none, as
  G-scope's own Export to plate does.
- **Non-solid scope.** It reads `nsoNonSolid`. A flagged piece keeps its open
  chains open.

---

## 7. Scope and complexity, as found

- **The real work was measurement.** The textbook core is the smaller part.
  Being *trustworthy* took the reconstruction and the black-box fits in §3. Each one was a place the first pass disagreed with Bambu and the
  G-code said why.
- **Bambu's shell logic is not linear.** Its behaviour over bridges (finding 2)
  is the largest remaining gap. More real slices with their source meshes
  would settle it, and would settle the three fitted rules too. **The single
  most useful input now is a few real `.gcode.3mf` files sliced from STLs that
  are in this repo.**
- **Found in passing, not fixed here:** `parseGcode` stamps `layers[i].z` from
  the *previous* layer's `; Z_HEIGHT` tag, because the tag comes after
  `; CHANGE_LAYER`. Every move's own `z` is right; only the layer record lags
  by one.

## 8. Checks

| step | what | time |
|---|---|---|
| `slicer:test` | 52 checks: sections equal manifold's own `Manifold.slice` on 6 repo meshes (worst rel 1.3e-9); orientation; open and inside-out meshes; wall offsets and counts; grid pitch and angles; density scaling; shells; overhang on cones either side of 30° / 45°, a mushroom (area exact to the step), model vs plate; G-code round trip; conflicts; constants | ~2 s |
| `slicer:bambu` | §5 above: 51 checks, 7 findings | ~70 s |
| `gcode:gscope-slice` | 45 checks, real clicks, screenshots in `tools/gscope-slice-out/` | ~10 s |
| `gcode:gscope-slice-view` | 41 checks: Normal -> Slice view -> Normal twice, the Detected tab, settings persisted, the whole-part state restored exactly | ~15 s |

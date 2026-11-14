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

   With **Detect thin wall** on (`thinWalls`), a wall narrower than the bead
   is printed as one pass down its middle first, and only the rest gets these
   loops. See [Thin walls](#thin-walls-classic-walls-with-detect-thin-wall-on).
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

`npm run slicer:bambu`: 58 checks, about 90 s. Result: **58 passed, 8 findings
recorded.** §5, the coupon export's sheet against Bambu's own slice of it, is
described under [Thin walls](#thin-walls-classic-walls-with-detect-thin-wall-on);
its eighth finding records the run counts (Bambu 2 a layer, NSO 1).

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
footprint, and what it stands on), and any **CONFLICT** by layer - that report
line, and the status line, are where an overhang call and a conflict are
stated. The floating list is the slice's one list, **All features**: one row
per feature the slice printed, each a show / hide toggle, no tab strip. (It
used to open on a Detected features tab that mixed feature families with
per-object Overhang / Conflict rows; those belong to the Supports tool, which
marks overhangs on the mesh itself.) **Normal** goes back through
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

### Supports slice as support

Bambu's slice of an NSO export labels NSO's supports **Support** /
**Support interface** and prints them as their own line types. The in-house
slicer now does the same, and stops reporting a host as needing support
right over the sheet that holds it.

- **Roles in.** `app-gscope-slice.js` passes every piece with its id
  (`key` = `sourceId`) and a role: a piece labelled `m.nsoSupport` goes as
  `role: 'support'` with `hostKey` = its `hostSourceId`; every other piece is
  a `part`. A file opened straight into G-scope has no labels: all parts.
- **Typed from the geometry, not a tag** (`typeSupports`, `nso_slicer.js`).
  A support's TOP is the part of a layer lying under its host's section
  within gap (0.18 mm) + one layer, with nothing of the support over it.
  The layer's islands that reach under the host are closed by 0.5 mm, so a
  layer of 0.84 mm-pitch lines reads as the footprint it holds, less what
  lies within 0.5 mm of its own next layer - but outside that layer's filled
  outline, only what lies within a quarter line of it, opened by a quarter
  line, where that part runs 2 mm or more under a SLOPED underside - the
  first layer of the part over it covers under 90 % of it (a stair's band,
  below; under the coupon's flat leg ceiling the tops of two tips cut at the
  gap beside its sheet, 2.3 x 0.8 mm, read as a top without it: T T I I
  became T I I I, slicer:bambu section 5). From each top
  the sheet is followed down island by island (each layer's lines cross the
  ones above): its top 2 layers are **Support interface**, the 2 under them
  **Support transition** (`nso_support_interface.js` SHEET_ROLES), and every
  other line of the object is **Support**. A STAIR (docs/SUPPORT-INTERFACE.md
  section 7) is read by the same rule, with two allowances (each only for a
  top that runs 2 mm or more under a sloped underside, `supportSheet.stairRunMm`,
  `stairCoverShare`): a top may lie a
  layer deeper under the host (`supportSheet.stairLayers`) where it lies
  outside its next layer's outline - a band whole beads wide stands its back
  edge up to 0.55 mm under the part; a flat sheet's I1 seen through a channel of
  I2 is inside it - and past its 2 + 2 layers the transition runs on while a
  layer repeats the footprint of the one over it (a steep stair stands
  several layers alike). Grown by 0.5 mm, the next strip hid each strip's
  exposed edge. The arc's stair: every one of
  its 46 layers' bands interface or transition; the clip coupon unchanged
  (`slicer:supports` 26 of 26). No wall, infill or overhang wall
  comes out of a support object: the same beads, one type, as Bambu prints
  support.
- **A support is hollow** (`CONSTANTS.supportWalls`, supports-one-trunk sixth round). A support object is sliced with the two overrides its export
  carries (`SHEET.slicerSettings`: `wall_loops` 1, `sparse_infill_density` 0 %), as `thinWall.supportsOn` carries the third: one wall round a trunk, no
  filler inside it - as Bambu's own tree is. Its shells are none on top and the first layer underneath (`topShellLayers` 0, `bottomShellLayers` 1: the pad, and
  one layer of bridge under a branch that leans out), and no sparse island or narrow strip is printed solid (`narrowSparseMm`, `minSparseAreaMm2` 0): a trunk
  3 - 5 mm across has a sparse island of 10 mm2, under the profile's minimum, which was printed solid, and a tapering trunk has a hair-thin top ring on every
  layer - both read as a filled trunk. Before, G-scope sliced a trunk with two walls and a layer of solid fill. `support:onetrunk`: at 3 mm a trunk's lines
  are one wall (1.0 x the circle of its width, was 3.3).
- **The sheet is filled** (supports-one-trunk seventh round). The sheet's own layers - a flat sheet's, a stair's strips - are the one thing in a support that
  is solid: where `typeSupports` finds a layer's region in the sheet's zone (below), it is filled with solid lines inside the one wall, as Bambu lays its
  interface. The tree under it is not. G-scope's Slice reads the sheet's interface layers off the support (`nsoSupport.interfaceLayers`, the card's Dense: 3).
- **A stair's posts are Support** (`typeSupports`, STAIR ZONES, supports-one-trunk sixth round). A stair's tips are posts under its strips, a row of
  them one blade; at a layer a post is one island with the strip it touches, so walking the strip's zone down by islands took the whole blade for the
  sheet (the Oblique's slab hung orange fins, and its Support stopped flat under the first strip). A stair's zones now hold only where the part is over
  the line within the stack's own depth (`gap` + the interface layers - 1, + 0.25 mm for the interface; + the transition layers, + 0.35 mm for the transition), and so does every zone on a layer that holds a stair's strip: the 3 + 2 layers under the
  part are interface and transition, a column further down is Support, and a path that is part strip and part post is split where its type changes.
  A flat sheet's islands are untouched (a dome's flat sheet lies up to its reach under the part at the rim and is all sheet). The Oblique now reads,
  layer by layer, as Bambu's does: Support, transition and interface in the same layer, the Support running up beside the stair.
- **Overhang, as a slicer types a wall** (`typeSupports`, supports-stair-body).
  Each line of a support is also read against the layer under it - that
  layer as the footprint it holds (closed by 0.5 mm, as above), grown by
  half a line: the length of it over air, sampled every 0.1 mm, is the
  path's `overhangMm`, each run of it over air one of its `overhangRuns`
  (a span between what holds it), and `P.sheet.overhangPaths` / `overhangMm` count them
  by type. A line over air is what Bambu prints as an overhang wall when it
  slices a support as an object. Typing only: the G-code is the same.
- **The host is credited.** Each of the host's overhang islands is cut,
  layer by layer, by the closed tops of its supports within gap + one layer
  under it. The region carries `coveredMm2`, `coveredBy` (which support, how
  much) and `uncoveredMm2`. The uncovered part is opened by half a line and
  its islands under the overhang floor are dropped: a strip narrower than a
  line beside a sheet is bridged by the first layer. The readout lists only
  what is uncovered:
  `z 12.00: 61.2 mm² overhang, 49.0 covered by support 2.1, 12.2 uncovered`.
  A host with nothing uncovered reads
  `no support needed (2 supports cover 311.7 mm²)`.
- **A support's own line** says what it holds:
  `support for top_clip_x2: 6 tips, sheet at z 11.00–11.80` (the bottom of
  the sheet's lowest layer to its top). It never lists its own sheet as an
  overhang, because the sheet is held by design.
- **With no support in the slice, nothing changes.** The G-code is byte for
  byte what it was, and so is the report: no credit fields, the same words.
  This was checked against the pre-change slicer on the sphere, the 20 mm
  box, the coupon and the wedge at both nozzles, and on a two-object plate.
- **The sheet prints by the thin-wall pass.** The card builds the sheet for a
  0.4 mm nozzle at 0.2 mm layers, with 0.40 mm lines (0.95 of a bead), and
  every support object carries `detect_thin_wall = 1`. So a support object
  is sliced with Detect thin wall on, and each sheet layer is one pass a
  piece: the loop, then the serpentine (see Thin walls below). Sliced at the
  panel's 0.6 default, the 0.40 line is under that nozzle's thin width too
  (0.66 mm), so it prints as one pass at 0.63 mm. At 0.3 mm layers the
  sheet's 0.8 mm spans fewer slicer layers than it has, so the trunk tips
  under it take the transition rows; that is not changed. `slicer:supports`
  and `gscope:select` §10 slice at 0.4 / 0.2.

`slicer:supports` holds all of this on the clip coupon,
`fixtures/supports/top_clip_x2.stl`: a 10 x 10 x 16 post with an 8 x 8 clip
under its top on each side, and the card-default supports built for it.

### Concentric (`solidPattern` / `topPattern` / `bottomPattern` / `sparsePattern: 'concentric'`)

Rings that follow the region's outline, in place of the lines. Measured
black-box on a real slice: `concentric.gcode.3mf` (Bambu Studio 02.09.01.70,
A1 mini, 0.4 nozzle, 0.2 layers, 2 classic walls, ten flat shapes 0.8 - 1.0 mm
tall with every surface and the solid infill concentric). Seven of its shapes
(the straight-sided ones) are pinned in
`fixtures/slicer-concentric-reference.json`. A second slice of the same plate
in monotonic lines (`monotonic_3dhoneycomb.gcode.3mf`) has the same 72 wall
loops point for point, so only the fill differs between the two.

| rule | measured | here |
|---|---|---|
| ring to ring | 0.377 at 0.42 / 0.2, 0.457 at the first layer's 0.5: the bead spacing | `spacingOf(w, h)` |
| the outermost ring | 0.333 from the inner wall's centre at 0.45 / 0.42, 0.388 at 0.5 / 0.5: 0.85 x the mean of the two spacings (`infill_wall_overlap` 15 %) | `ringRoom` grows the fill region (bead centres, 0.85 x the wall's spacing) by the difference and half a spacing, along the walls only |
| the middle | beads across = width / spacing; every ring is nominal but the last, which takes the remainder: one ring 0.354 - 0.63 wide, or one line 0.55 - 0.69 wide down the middle | a piece under two spacings deep is measured (`insetDepth`) and gets 0 - 4 beads: a line under 1.5 spacings, a pair of rings under 2.75, a line between rings under 3.5 |
| order | from the middle outward, each ring starting beside the last one's start | post-order over the pieces, `ringFrom` |
| bridges | straight lines | unchanged: only Bottom surface (first layer), Top surface and Internal solid infill take the pattern |

Against the reference, on a solid layer and the top of each of the seven
shapes: the outermost ring within 0.001 mm, the same number of paths, the
innermost ring's width within 0.0012 mm, the volume laid within 0.2 %.

Where it differs, and what is stated rather than measured:

- **The reference's pentagon** ends its solid layers in a dot 0.645 wide; this
  lays a last ring 0.344 wide in the same room (1.6 spacings: one bead there,
  two here). Its rectangle has two at 1.70 and its right triangle two at 1.42,
  so the switch is not a width alone.
- **A middle whose width changes along it** (the semicircle, the ellipse):
  Bambu steps the line's width every 0.3 - 0.4 mm and may run it as a loop;
  this lays one medial line (`medialPaths`) with its width stepped by 0.04 to
  the room, or the last ring.
- **Necks.** Where a region pinches between two lobes the rings split and each
  lobe ends in its own middle; the wedge left at the pinch is not filled.
- **Sparse concentric is stated, not measured**: the reference is all shell
  (no sparse layer; the second file's 3D honeycomb never prints either). The
  first ring lies along the walls, the rest a spacing over the density apart,
  all nominal width.
- **The first layer's own width** (`initial_layer_line_width` 0.5) is not a
  setting of this slicer; its first layer is laid at the infill's width.
- A ring closes on itself; the planner leaves its own seam gap, as on a wall.

The print card and G-scope offer **concentric** on both pattern rows (see
"The two pattern rows"). A template that names concentric for one of the four
project keys alone is sliced that way (`NSOPrintPlanner.engineOptions`).

### Rectilinear (the lists' name for `zigzag`)

Bambu Studio's **Rectilinear** - `zig-zag` in its profile - is the pattern this
slicer has always called `zigzag`: lines at `infill_direction` (45), turned 90
degrees with every layer, joined at their ends. The pattern rows of the print
card and G-scope list it as **rectilinear** (the option's value stays
`zigzag`), the summaries say rectilinear, and the engine takes `rectilinear`
or `zig-zag` for any of its four pattern options.

Checked against `rectilinear.gcode.3mf` (the concentric plate cut again with
every pattern Rectilinear; its walls are the same 72 loops), pinned in
`fixtures/slicer-rectilinear-reference.json`: on two solid layers and the top
of each of the seven straight-sided shapes the lines run at Bambu's angle, as
many of them within 2, the length laid within 3.5 %. The differences: Bambu
widens the line (0.420 - 0.428) so a whole number fits across, where this
keeps the nominal spacing; and it draws every layer in one path, where this
breaks the path at some slanted edges (the hexagon's layer in 9). Like the
other two files this one is all shell, so its sparse Rectilinear never prints.

### Archimedean chords (`'archimedeanchords'`, any of the four pattern options)

One spiral from the middle outward, cut to the region. Measured black-box on
`archimedeanchords.gcode.3mf`: the concentric plate's ten shapes, 9.8 mm tall
(so the sparse infill prints: 44 layers of it), every pattern Archimedean
chords, sparse 15 % at 0.45. Seven shapes pinned in
`fixtures/slicer-archimedean-reference.json`.

| rule | measured | here |
|---|---|---|
| the curve | from the centre a straight stroke one pitch long at 135 degrees, then counter-clockwise, one pitch further out with every turn; the same on every layer | `spiralFill`: r = pitch (1 + turn), a polyline within 0.01 mm of the curve |
| the pitch | 0.377 in a solid fill (the bead spacing at 0.42 / 0.2, 0.457 on the first layer's 0.5), 2.713 in the sparse one (0.407 / 15 %) | `spacingOf(w, h)`, over the density when sparse |
| a solid fill's centre | not the box's middle on a shape without point symmetry: the middle of the fill region's box in the frame turned 45 degrees (`infill_direction`) - the triangle's 7 mm below its box's middle | `turnedBoxCentre(region, 45 deg)`, one spiral a connected piece |
| a sparse fill's centre | the middle of the object's own box (the part's, not the wall's: 0.105 above the walls' on the triangle, whose apex is mitred), the same on all 44 layers | the middle of the box of all the object's layers |
| the ends | cut where the spiral leaves the region. Sparse: where it comes back in, the two ends are joined along the wall unless an earlier join already runs there; the ends left turn 1.63 mm along the wall (4 spacings: `infill_anchor` 400 %) | `clipLine`, then joins the shorter way round (`outlineTrack`), sparse up to `sparseAnchorMaxMm` with 4-spacing hooks, solid up to 3 spacings |

Against the reference: on a solid layer of each of the seven shapes the
spiral's start within 0.005 mm, the length laid within 0.4 %, the number of
paths the same or one more; on a sparse layer (sliced at the reference's 0.45)
the start within 0.001 mm and the length within 13 % - the spiral is the same
curve, the joins and hooks along the walls are placed by a simpler rule than
Bambu's.

Not matched, or stated: Bambu writes the sparse spiral in arcs (G2 / G3), this
in short lines; the slicer has one infill width (the reference's sparse lines
are 0.45, its solid 0.42), so a sparse spiral at 0.42 is 8 % tighter than
Bambu's; a solid fill in several pieces on one layer (a top beside solid
infill) is one spiral a piece, which the reference does not show.

The pattern rows list it as **archimedean chords**, for the infill and for the surfaces.

### Hilbert curve (`'hilbertcurve'`: the surfaces and the solid infill)

One square space-filling line. Measured black-box on
`hilbertcurve_3dhoneycomb.gcode.3mf` (the concentric plate's shapes, 43.6 mm
tall; every surface and the solid infill Hilbert curve). Points on Bambu's
lines are pinned in `fixtures/slicer-hilbert-honeycomb-reference.json`.

| rule | measured | here |
|---|---|---|
| the grid | one bead spacing (0.377 at 0.42 / 0.2, 0.457 on the first layer), turned so every stroke lies at 45 or 135 degrees | `hilbertFill`, the frame at 135 degrees |
| the curve | the plain Hilbert curve of the smallest power of two that covers the region (128 across on every shape), from the low corner of the region's box in that frame; the same on every layer | `hilbertPoint`; quadrants off the box are not made |
| where the box is | Bambu's region lies 0.013 mm outside this slicer's (0.85 x half the difference of the wall's spacing and the fill's - the concentric rings' measure, found again in the grid's phase) | the box grown by that |

Against the reference, on a solid layer of all ten shapes, 100 % of Bambu's
line lies on this one (99.8 % on the square) and 96 - 99 % of this one on
Bambu's: the curve is the same, and more of the cut ends are joined along the
walls here (4 - 24 paths a layer against 59 - 97), which is the 1 - 4 % more
length.

### 3D honeycomb (`sparsePattern: '3dhoneycomb'`)

Wavy lines whose waves and direction change with height. Measured on the same
file's sparse infill (15 %, 0.45 wide, 0.2 layers, 210 layers of it). In the
frame turned 45 degrees (`infill_direction`), about the middle of the object's
own box:

| rule | measured | here |
|---|---|---|
| a layer | one family of lines D = 3.579 apart, the middle one through the centre; each a square wave with slanted flanks: flats D - 2 a long, a to one side of the line then a to the other, the flanks at 45 degrees to the line (along X or Y on the plate); the wave 2 D long; next-door lines mirror images | `honeycomb3dFill` |
| with height | a goes + D/4 -> - D/4 over 10 layers, back over the next 10 (0.179 a layer); the lines are straight every 10th layer; they run along the frame's first axis going down, along its second coming back; + D/4 on layers 5, 25, 45... | `honeycomb3dAt` |
| the ends | cut at the region, joined to the next line along the wall | `clipLine`, joins up to `sparseAnchorMaxMm` |

Against the reference: 960 points pinned on Bambu's lines (three shapes,
layers 5 - 23, both directions and both sides of straight, clear of the walls)
lie within 0.005 mm of these lines; the length laid is within 11 % (the joins
along the walls are placed differently).

**Two numbers are fitted to this one slice, and stated:** D = (1 + sqrt(3)/2)
/ sqrt(2) x spacing / density (3.5802 against the measured 3.5788), and the
quarter wave, 5 layers, taken as D / 4 over the layer height rounded up (4.47
-> 5: a flat never steps further sideways than a layer is tall). A slice at
another density or layer height would confirm or correct both.

### Octagram spiral (`'octagramspiral'`: the surfaces and the solid infill)

Eight-pointed stars, one inside the next, drawn as one line from the middle
outward. Measured on `OctogramSpiral_Gyroid.gcode.3mf` (the same plate, the
surfaces and the solid infill Octagram spiral), pinned in
`fixtures/slicer-octagram-gyroid-reference.json`. In bead spacings from the
centre, read off the circle's solid layer: the first stroke goes to (-1, 1);
star n has its sides n spacings off the two axes, its points n (1 + sqrt 2)
out and its notches n sqrt 2 out on the axes; it ends on the +Y axis, from
where the line steps out to the next star's first corner. The centre is the
Archimedean spiral's (the middle of the region's box in the 45 degree frame),
and like it the star is the same on every layer. It is `spiralFill` with
another line.

Against the reference, on a solid layer of all ten shapes: 100 % of Bambu's
line on this one, 99.6 - 100 % of this one on Bambu's, the length within
0.2 %.

### Gyroid (`sparsePattern: 'gyroid'`)

Each layer is the cut through one smooth surface. Measured on the same file's
sparse infill (15 %, 0.45 wide, 210 layers): the lines of every layer lie on

    cos X sin Y + cos Y sin Z + cos Z sin X = 0,   X, Y, Z = 2 pi / wavelength x (x, y, z)

with x and y from the middle of the object's own box and z the layer's top
from the plate. 145 000 points of four shapes over all 210 layers lie on it
within 0.03 mm at **one** wavelength for the three axes, 6.988 mm. A layer is
cut as y(x) where |sin Z| >= |cos Z| (wavy lines along X, half a wavelength
apart) and as x(y) elsewhere, so the lines turn from one axis to the other
every eighth of a wavelength up (`gyroidFill`). The ends are joined along the
walls as the 3D honeycomb's are.

Against the reference: 960 points pinned on Bambu's lines (three shapes,
layers 4 - 25) lie within 0.06 mm of these (Bambu writes the curves in arcs,
this in lines 0.15 mm long); the length laid is within 16 % (the joins along
the walls).

**One number is fitted to this one slice, and stated:** the wavelength is
2 pi / 2.44 x spacing / density (6.9881 against the measured 6.988). A slice
at another density would confirm the 2.44.

### The two pattern rows

Bambu sets the sparse infill and the surfaces apart (this file: Hilbert curve
on the surfaces, 3D honeycomb inside), so the print card and G-scope have two
rows: **infill** (grid, rectilinear, lines, concentric, archimedean chords, 3D
honeycomb, gyroid -> `sparse_infill_pattern`) and **surfaces** (rectilinear,
concentric, archimedean chords, hilbert curve, octagram spiral -> `top_surface_pattern`,
`bottom_surface_pattern`, `internal_solid_infill_pattern`, the three as one
choice). Concentric and Archimedean chords no longer set both from the infill
row. In G-scope the two selects share one cell of the settings grid (infill
first), so the card is no taller than it was.

### Thin walls (classic walls with Detect thin wall on)

Bambu Studio, with the **classic** wall generator and **Detect thin wall** on,
prints a modelled wall narrower than its bead as **one pass** down the wall's
middle, at the bead's own width. NSO's 0.40 mm support sheet prints that way:
one pass per line, E/mm 0.0307, the same as Bambu's outer wall. The owner's
breakaway print of 2026-10-20 confirmed it. Without Detect thin wall, the
classic inset (`w/2`) keeps nothing of such a wall, or keeps a sliver drawn
out and back. `nso_slicer.js` now has the same pass (`thinWalls`). It is
classic semantics, not Arachne: one fixed width, no variable bead.

- **Who has it on.**
  - Support objects (`role: 'support'`): on, because every NSO support
    carries `detect_thin_wall = 1` (`CONSTANTS.thinWall.supportsOn`).
  - Parts: off by default (`detectThinWall: false`), as in both real
    profiles (`detect_thin_wall = 0`).
  - An object's own `detectThinWall` overrides either.
- **What is thin.**
  - Shrink the layer's region by half the thin width (**1.05 x the bead**,
    0.441 mm at 0.42; STATED in `CONSTANTS.thinWall`) and grow it back. That
    is what holds a wall of its own.
  - Specks don't count. A corner or a junction of thin walls leaves a speck
    under half a bead across (an L of a 0.40 strip keeps a 0.47 mm circle, a
    T a 0.50 one).
  - The rest, opened by the thinnest wall printed (**0.13 mm**, PR #256's
    reading of Bambu's behaviour), is thin.
  - A thin piece whose centreline is a bead long or more prints as that
    centreline and nothing else. Everything else keeps its walls and infill.
  - A layer with no thin piece is sliced exactly as before.
- **The centreline** (`medialPaths`, pure JS):
  1. Rasterise the piece at 20 pixels a bead.
  2. Thin it to a one-pixel skeleton (Zhang-Suen, a textbook method).
  3. Trace it into chains between ends and junctions, and prune spurs under a
     bead. These are the medial axis's prongs into corners and line ends.
  4. Find corners on a quarter-bead simplification, and put each one where
     its two least-squares lines cross.
  5. Draw the graph as the fewest paths that draw every chain once: an Euler
     trail per pair of odd nodes.

  So a closed thin loop is one closed path, and a serpentine joined to it at
  one point continues it: the loop, then the serpentine, with no travel
  between.
- **Ends.** A free end stops half the local width short of the piece's edge,
  so the bead ends flush. An end that meets a walled part (a sheet line
  against a trunk) runs on into it, as far as the part's outer wall.
- **Typed as walls.** A part's thin pass is an `Outer wall` path at the outer
  wall's width (flow for a full bead). It is not split for overhang, so it
  stays one path. In a support object, `typeSupports` types it like any other
  line: `Support interface` for the top 2 layers, `Support transition` for the
  2 below.
- **What it does to the coupon export** (`slicer:bambu` §5):
  - Each slab sheet layer is ONE path of **408 mm** in 55 moves (I1: 36).
    Bambu's record is one run of 54 extrusions and about 434 mm.
  - Each leg layer is one path of 56.9 mm.
  - The 0.43 export gives the same path count, layer for layer.
  - Read back by `nso_slicer_audit.js`, every line is printed once, at
    1.00 x the outer wall's E/mm.
  - **Against Bambu's own slice of it**
    (`fixtures/supports/top_clip_x2_supports.gcode.3mf`, the owner's
    breakawayV1, Bambu Studio 02.08.02.61, classic walls + Detect thin wall),
    every sheet layer is one connected drawing in both and every line is
    printed in both. NSO's total is within 0.5 - 3.6 % of Bambu's: 408.0
    against 404.7 - 405.9 mm on the slab, 56.9 against 54.9 - 56.5 on the
    leg. Bambu's thin wall runs at 1.06 x its outer wall's E/mm (0.0327
    against 0.0307); NSO's at 1.00.
  - **Runs differ, by design.** Bambu draws each layer in 2 runs. On the slab
    it starts at the foot of a serpentine line, goes one way to the free end,
    travels back, then goes the other way through the bridge and round the
    loop (its 54 extrusions and 3 travels). On the leg it draws the loop
    closed, then the serpentine as a run of its own ending on the loop. NSO
    draws each layer in ONE run, the loop then the serpentine, as asked. It
    is the same connected wall; `slicer:bambu` records the run counts as a
    finding.
- **Pinned.** The repo meshes give the same G-code byte for byte with the
  flag off and on (`slicer:test` §9, 32 slices at both nozzles). None of them
  has a thin wall 0.13 mm or wider.

---

### The brim (supports-one-trunk, third round)

`brimType` ('none' by default; 'auto' | 'outer'), `brimWidthMm` 5, `brimObjectGapMm` 0.1, `brimLineWidthMm` (null: 1.25 x the nozzle,
Bambu's 0.5 first-layer line), `brimAutoRatio` 2, `brimSupportGapMm` 0.02. Read off the six heads of
`fixtures/supports/tree_slimsupports.gcode.3mf` (A1 mini, `brim_type = auto_brim`, `brim_width = 5`, `brim_object_gap = 0.1`): on the first
layer only, round the part's outer boundary, 10 loops of a 0.5 mm line at the stadium spacing 0.457, the first 0.1 mm off the wall
(centres 0.35 mm off the outline), the outermost 4.46 mm, printed outermost first and before everything else on the layer, as feature
`Brim` (G-code `; FEATURE: Brim`). Each loop is cut where it would come within half a line (+ 0.02 mm) of another object's first layer -
a support's pad - so the brim and the pad touch edge to edge (Bambu's: 0 - 0.05 mm) and never join; a run under 1 mm is dropped. Auto
brims a part that is tall for its foot (height over the root of the first layer's area at least 2: the stem of a chalice, a tower).
**A part on supports gets no auto brim** (the owner: "the box is unchecked" - Brim round the foot off is no brim): its brim is the
supports card's (Brim round the foot, a brim object of its own, below) or none. Bambu's supp_ref_v2 rings the trunks' feet in auto; NSO does not.
The brim is a tall thin part's added hold, the way the tree's pad is the support's: for these heads it is all that holds the stem
when the pad is a hand wider than the trunk. G-scope's Slice settings carry a **brim** select (auto / every part / off, auto at rest);
the print planner reads the project's own `brim_type` (`auto_brim` -> auto, `outer_only` / `outer_and_inner` -> outer, `no_brim` -> none),
`brim_width` and `brim_object_gap`. Gate: `npm run slicer:brim`. Not done: the inner brim of `outer_and_inner`, brim ears, a brim
shared between neighbouring parts (two brims may overlap each other; neither enters a pad or another part's first layer).

**A brim built with the supports** (the supports card, fourth round). `NSO_Slicer.brimFor(soup, over, wasm, avoid, zPlate)` returns the brim a part wants
(`brimWanted`: auto = tall for its foot, outer = every part) as ONE solid layer: the ring from `brimObjectGapMm` to `brimWidthMm` round the first layer's outer
boundary, less every `avoid` soup's first layer (the supports' pads, the other pieces) grown `brimSupportGapMm`, pieces under 1 mm2 dropped, extruded one
first layer thick from `zPlate` - `{ ok, needed, soup, polys, areaMm2, loops }`, `needed: false` where the part stands on a wide foot. An object of **role
'brim'** (with the part's `key` as its `hostKey`) is sliced as Brim and nothing else: its first layer's section, shrunk half a line and then a first-layer
spacing at a time (`brimLoops`; a ring 4.9 mm wide gives 5 + 5 loops, a ring cut by the pad 5 racetrack loops of the same length), feature `Brim`; no walls, infill or
supports typed on it, never a host; a part with a brim object of its own gets no `addBrims` brim.

### Supports on their own layer grid (`supportLayerMaxMm`)

Bambu's *independent support layer height* cuts supports on a grid of their own: z0 0.2, anchored at each sheet's top and the last layer, every stretch
split into equal steps of at most the limit (0.28 -> about 0.2755 over 14.6 mm of the Base; 0.2774 on the Oblique's stair), and where anchors lie
within one step of each other (a stair, a sloped top) the part's 0.2. `supportLayerMaxMm: 0.28` does the same here; the default 0 keeps every support
on the part's planes (byte for byte as before, pinned). Each support is sliced on its own `planes` (`supportGrid`), the tree, interface and
transition typing are done on those planes against the host's by height (`layersOverX`, `layersUnderX`), and `toGcode` merges the layers of all
objects by Z, a `; LAYER_HEIGHT:` per object where it differs. The print planner and other consumers of `res.planes` do not know the grid: G-scope's
Slice turns it on for a Dense sheet (`nsoSupport.sheetLayerMm`) only.
With it on, every sheet zone is typed by the part's nearness (the stair's way): interface while the part lies within the top support layer's reach (the gap + a layer, 0.4) + 2
of the support's own layers over it, transition within 2 more, cell by cell, so a slope's plate has the 3 + 2 across its ribbon (`hostEx`).

### The raft (`raftLayers`)

Bambu's raft is its own system between the plate and the first layer of everything on it - part, support or both - not a part of any support style
(the owner's circle slices, 1 - 10 layers; `fixtures/supports/raft_circle.gcode.3mf`, 8 layers under a 50 mm disc, and `supp_ref_raft.gcode.3mf`, 10
under the six heads' trees). Read off both and built as `raftPlan` / `addRaft`:

- **Layers**: N = `raft_layers`; the top ceil(N/2) are interface (`Support interface`), the rest base (`Support`) - 1: 1 interface, 2: 1 + 1, 3: 1 + 2,
  10: 5 + 5. The first at the first layer's height, every other 0.75 x the nozzle (0.2, 0.5, 0.8 ... 2.9 for 10).
- **The plate on it**: everything is lifted the raft's top + `raft_contact_distance` (0.1), and its first layer is an ordinary layer (2.3 + 0.1 + 0.16 =
  2.56 for the circle's 8, as Bambu). Each support's first layer gets a layer of its own under it that closes the 0.1 gap (Bambu's 3.0 under each
  trunk). No brim with a raft.
- **Region**: the first layer of everything, grown `raft_expansion` (1.5) under the top layer, 0.5 more under the others, 1.0 more again under the first
  (the circle: 1.5 / 2.0 / 2.9 - 3.4 past the disc).
- **Lines** (0.42): the first layer solid along Y; the base along X at `support_base_pattern_spacing` + a bead's spacing (2.5 -> 2.856, Bambu's own
  2.856); the interface at `support_interface_spacing` + a bead's spacing, along Y under supports (supp_ref: 0.45) and 45 / 135 in turn under a part
  alone (the circle: 0.886). Each layer one zig-zag joined along its edge.
- **Settings**: the Slice card and G-scope's Slice panel have *raft N layers* and *contact mm*; the .gcode.3mf records them as `raft_layers` /
  `raft_contact_distance`, and a profile's own raft keys are read (`nso-print-planner.js` engineOptions).

- **On the plate**: a slice with a raft hands its layers back (`raftToPlate`) and the plate is drawn as it prints - the bed (surface,
  grid, border, ticks; display only) lowered by the lift and the raft's layers between it and the pieces, base light green, interface dark
  (`app-print.js` showRaftView). The pieces do not move; the raft is no piece (never picked, sliced or exported) and goes when its slice is
  the plate's no more (checked once a second while drawn). With a raft the supports card builds no brim.

Not matched yet: under a tree, Bambu's first raft layer is about 0.9 mm *inside* the base layers where under the bare disc it is 1 mm outside; here it
is outside for both. Bambu's tree also prints its own Support through the raft's interface layers where the trunk stands; here the interface covers it.

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
| `slicer:test` | 63 checks: sections equal manifold's own `Manifold.slice` on 6 repo meshes (worst rel 1.3e-9); orientation; open and inside-out meshes; wall offsets and counts; grid pitch and angles; density scaling; shells; overhang on cones either side of 30° / 45°, a mushroom (area exact to the step), model vs plate; G-code round trip; conflicts; constants; thin walls (a strip, a ring, a loop with its serpentine, a fin on a block, the 1.05-bead threshold, who has it on) and the repo meshes' G-code pinned byte for byte, flag off and on | ~8 s |
| `slicer:bambu` | §5 above: 58 checks, 8 findings | ~90 s |
| `gcode:gscope-slice` | 45 checks, real clicks, screenshots in `tools/gscope-slice-out/` | ~10 s |
| `slicer:supports` | 26 checks on the clip coupon and its 2 card-default supports: every support line Support / transition / interface, interface exactly the top 2 layers' moves and transition the 2 below, the three Features rows, each clip's overhang credited to the support under it (uncovered 0 under the sheet), the readout's words, byte-identical G-code without supports | ~2 s |
| `gcode:gscope-slice-view` | 50 checks: Normal -> Slice view -> Normal twice, the one All features list and its toggles, settings persisted, the whole-part state restored exactly | ~15 s |

### Exact reach in the depth typing

`typeSupports` (own grid, `supportLayerMaxMm` > 0) asks how near the part is over each support layer's top. The part's layers answered in 0.2 mm steps, so on a slope the interface/transition edge moved in jumps against a 0.275 grid. `hostExCs` now keeps the part's layers whose middle is within the reach and adds the part cut at exactly top + reach (`makeP`'s `exactAt`, one cut pass per host and support). Plate score moves a little (foot IoU +0.01 to +0.02 on Circular, Negative Sphere2, Oblique).

What the score still shows on the Oblique ribbon (supp_ref): the generated slab is steady layer to layer (25 mm2), as Bambu's footprint is (26); what alternates is which lines of the slab are typed transition (a 0.7 mm strip holds one line or none depending on the phase of the loops). Bambu's plate is ~0.4 mm longer/wider than ours (growing the region plate uniformly by 0.3 - 0.5 mm was tried and scored worse on every piece, so it is not one uniform margin). The trunks under the plate are Bambu's merged wide ones against our thin columns (tree len 0.33 - 0.75).

### The plate laid by its regions (own grid)

Typing one fill by position left the transition strip of a sloped plate one line or none by the phase of the fill's lines (Oblique: 3 to 28 mm of transition a layer against Bambu's steady 23). On a support's own grid the plate is now laid as Bambu lays it (checked on supp_ref's Oblique, z 10.0: a transition loop, an interface loop and the interface zig-zag): the interface region (the part within the interface layers over the cell) and the transition region (within the transition layers over that) each get their loop on the slab's edge, the support's own wall run that lay in them is dropped (the loop replaces it), and the zig-zag fills the interface and the transition wherever it is wider than a line; a narrow transition strip is its loop alone. Foot IoU: Oblique 0.66 -> 0.71, Sphere 0.68 -> 0.78, Circular 0.64 -> 0.67, Negative Sphere 0.69 -> 0.73; Negative Sphere2 0.69 -> 0.62 (its plate is three crescents where Bambu's is one big C round the hole: the footprint is the generator's, not this).

Note on the fill's width test: the zig-zag fills a transition region only where it is wider than 2.4 line widths (the region opened by 1.2 line widths); at 0.6 the strip of the Oblique's ramp was filled too and the transition ran 32 - 42 mm a layer against Bambu's 23 (seen in a real export, 644 vs 468 mm), at 1.2 it is 21 - 23 a layer. Judge a change to this on the per-layer lengths of the real export, not on the score's totals alone.

### Time: the exact cuts are welded once (2026-11-10)

Generate ends with the plate's slice (acdd25e), so the slicer's time is Generate's. On supp_ref_2x (one piece, 10 supports) the slice was 70 of
Generate's 83 s, and half of it was `indexSoup`: `exactAt` (the support typing's cut of the part at heights of its own: `prepExact`, `cavSection` /
`holeAtZ`) called `sliceMesh`, which welded the whole part again on every call, and every support asked the part for the same heights again.
Now `makeP` welds an object once (`prepSoup`: the welded mesh and each triangle's z range) for its layers and every exact cut, and `exactAt`
keeps each section by its height (the same float), so a height ten supports ask is cut and closed once. Same bytes: the plate's .gcode.3mf
from the page and `support:gate --rule column --json` are identical before and after.

| headless Chromium, GENERATE pressed to idle | before | after |
|---|---|---|
| supp_ref (6 pieces) | 31 s | 25 s |
| supp_ref_2x (1 piece) | 83 s (slice 70 s) | 42 s (slice 31 s) |

What is left in the 2x slice: the exact sections' closing offsets and `unionAll` in the typing (manifold, about 18 s), and the layers themselves.

**Second round (the typing).** The slice of the page's own Generate job (captured from the worker, replayed in node, the G-code compared byte for byte):
- `geometry()`'s operations are kept by their inputs: a section is never changed once made, so `unionAll`, `union`, `offset`, `diff`, `inter`
  and `dropSmall` asked again of the same sections (by identity) and the same numbers return the first answer. The typing asks the host's layers
  the same unions and cuts for every support layer and every support (the column rule's window of host layers, `dropSmall` of each, the
  overhang of each layer, per support). Cleared by `free()`.
- `prepExact` no longer cuts all six reaches of every layer up front: a height is cut when it is first read (1,670 cuts -> 486 on the 2x).
- `topUnder` makes its `cover` (the next layer's closed, filled footprint) only when the layer reaches under the host at all.
- `indexSoup`: the weld grid is an open-addressed table on the cells' integer coordinates, not a Map of string keys (10 - 20 x; same V and T,
  checked on every object of the 2x job).
- `splitOverhang` tests its points against the layer below through `insideIndex` (edges filed by horizontal bands; every answer is `inside`'s).

| the plate's slice, node replay of the page's job | before | after |
|---|---|---|
| supp_ref (sheet typing) | 7.7 s | 4.4 s |
| supp_ref_2x (sheet typing) | 30.3 s | 14.7 s |
| supp_ref_2x (column rule) | 38.4 s | 15.1 s (`columnRule` 15.4 -> 4.0 s) |

Headless Chromium, GENERATE to idle: supp_ref 25 -> 18 s, supp_ref_2x 42 -> 26 s, supp_ref_2x with the column rule 41 -> 31 s. The G-code is
the same bytes in all three; `support:gate` and `support:gate --rule column` print the same JSON. What remains of the slice is mostly the
layers themselves (walls, infill, the sections of every object: `buildLayers` and `makeP`, about 9 s of the 2x).

**Third round (the build, before the slice).** A probe `leg(a, b, 0, 0, 0, 0)` - a bare line, no section, no clearance - built its eight
rails at radius 0: the axis itself, cast again eight times to the same answer (and, on a miss, the inside test nine times). The horns' wall
probes and `hornUnderMap` (18 maps of 101 x 101 columns, up to 12 casts each, on the 2x) are made of them. `leg` now answers a bare line from
the axis alone: the same numbers. supp_ref_2x with the column rule, the build's own time in the page 13.1 -> 8.4 s, GENERATE 31.7 -> 25.5 s;
the plate's G-code the same bytes on all three plates, both gates the same JSON. Looked for and not repeated work: the 11 crowns' meshes
(`blobSoup`) are 11 different bodies, `leg` asked the same question twice is 0.3 s of 1.8, and the thickness probes are built once a mesh.

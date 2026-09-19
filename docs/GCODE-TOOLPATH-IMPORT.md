# Sliced-G-code toolpath import

Import an **already-sliced** Bambu Studio project (`*.gcode.3mf`) and render its
real toolpath as genuine, editable NSO geometry — then isolate one layer, in true
isolation from every other layer, and pull it out as its own object.

The problem this answers: **Bambu Studio cannot scope a print job to a single
line or a single interface.** It slices a model; it does not let you say "print
only that." The way round it is not to fight the slicer but to *isolate the
geometry before it ever reaches the slicer* — import the toolpath, extract the
piece you want as a standalone object, and send that to Bambu Studio with an
empty plate. That is the whole loop, and it is what `npm run gcode:drive`
exercises end to end.

## Scope — read this first

Import and render **only**.

- It is **not** a slicer, and not a live or real-time one.
- It does **not** predict or reproduce Bambu Studio's slicing decisions.
- Input is **always** a file Bambu Studio has already sliced and saved.

Everything on screen came out of the file. Where a number did not, the reader
says so (see *Nothing is assumed* below) rather than quietly filling in a
default.

## What it reads

| Part | Used for |
| --- | --- |
| `Metadata/plate_1.gcode` … | the whole toolpath; one part per plate, lowest taken by default |

The ZIP walk is `NSO3MFRead.openZip()` — the same central-directory reader the
geometry importer uses (`nso-3mf-read.js`), which inflates entries on demand, so
nothing but the one G-code part is ever touched. A plain project with no plate
G-code is refused with a message that says to slice and save as `.gcode.3mf`.

Comment tags read, all of them Bambu Studio's own:

    ; FEATURE: <name>        grouping - one model per feature
    ; Z_HEIGHT: <mm>         the layer's printing Z
    ; LAYER_HEIGHT: <mm>     the layer's height
    ; CHANGE_LAYER           layer boundary
    ; OBJECT_ID: <n>         recorded per move
    ; filament_diameter = …  from the trailing config block

Machine state handled: `G90`/`G91`, `M82`/`M83` (Bambu writes `M83`, but it is
detected, not assumed), `G92 E0` rebases, `G0`–`G3`. `G2`/`G3` arcs, which Bambu
emits with arc fitting on, are flattened into chords carrying the extrusion by
length. Travels, primes, retractions and Z hops produce no geometry.

## Width and height are measured, not assumed

This is the load-bearing claim. Each move's cross-section comes from **that
move's own extrusion**, inverting the flow model the slicer used on the way in:

    volume = dE · π · (filament_diameter / 2)²       dE from the G-code
    A      = volume / distance                       distance from X/Y
    A      = h · (w − h) + π · h² / 4                stadium cross-section
 ⇒  w      = A / h + h · (1 − π/4)

`filament_diameter` comes from the file's own trailing config comments. `h`
comes from the file's own `; LAYER_HEIGHT:` where Bambu wrote one, otherwise
from the measured Z step between layers, otherwise (first layer) from the layer
Z itself.

### Nothing is assumed

Every move records `heightSource` (`tag` / `zstep` / `firstLayer` / `fallback`),
and `meta.assumed` is true if *anything at all* fell back to a constant. On a
real Bambu slice it must be false, and the checks assert that. When it is true
the app says so in the status line and the reasons go to the console.

## Geometry

One closed box per extrusion move — `width` across, `height` tall, swept along
the move. **The nozzle Z is the top of the bead**, so the bead hangs below it
onto the layer under it. 12 triangles per move, wound counter-clockwise seen
from outside, Z up in millimetres.

Z-up millimetres is exactly what `STLLoader` hands the app, so each feature group
goes in through `addModelFromZUpGeometry()` — **the one ingest path** STL and
plain-3MF imports already use. From that point an imported toolpath feature is
an ordinary NSO model: undo, paint, Cut, Join and both exporters treat it like
anything else, with no special-casing anywhere.

### What "watertight" means here

A toolpath is a stack of beads, and in a real print those beads touch and
overlap — that is what fuses a part together. So an exported toolpath object is
a **union of touching closed solids**, not one manifold surface, exactly like
any multi-part STL. Two properties are asserted, and they are the ones that
matter:

- **No leaks.** Zero open (count == 1) edges over the whole assembly.
- **Every bead is a solid.** Each move's shell closes on itself and has positive
  signed volume — none inside-out, none torn.

Strict two-manifoldness over the assembly is *not* asserted, and should not be.
Where one bead sits squarely on the one below, their shared face belongs to both
shells and an edge there has count 4. So:

    # the right check for these exports - leaks and degeneracy
    python3 tools/stl_watertight_check.py out.stl --degen

    # --odd will report those shared faces as non-manifold. That is two solids
    # in contact, not a defect. Do not use --odd on a toolpath export.

### Staying assembled

`addModel()` centres every geometry on its own box and `placeModelMovable()`
lays new pieces out in a row. That is right for unrelated STLs and wrong here:
five `FEATURE` groups out of one slice are five parts of **one** print. If that
stood, the walls would sit beside their own infill and the scrub highlight could
not line up with anything. So `app-toolpath.js` reseats each group at its true
offset within the toolpath, on one shared plate datum, and parks the scrub
overlay on the same datum.

The axis mapping, applied consistently in both places, is `zUpToYUp()`'s
`rotateX(-90°)`:

    (gx, gy, gz)  ->  (gx − cx,  gz − minZ + lift,  −gy + cy)

## The line slider

A layer slider tells you which layer a feature is on. It does not let you pick
the line — and a support-interface layer can be hundreds of moves. So the scrub
control steps **one move at a time** within a layer, as well as layer by layer:
the same stepping Bambu Studio's own preview does, except that here the thing
you land on is selectable geometry rather than a picture.

The **Toolpath** card appears once something is imported:

- a range input with **one step per move** across the whole toolpath;
- `−1 line` / `+1 line`, a line-number box, and `▼ layer` / `▲ layer`;
- ← / → step lines and shift + ← / → step layers while the card has focus;
- a readout naming the line globally *and within its layer*
  (`Line 15 / 51 — layer 1 / 3 (line 15 / 17 on this layer)`);
- the measured width, height, length, angle and Z **of that line**.

Stepping past the last line of a layer rolls into the first line of the next:
the toolpath is one continuous path and the control follows it.

The highlight is a **view, not geometry**. It is drawn over the imported models,
so scrubbing never edits, marks or dirties them and never touches the undo
stack — the checks assert both. The selected move is solid red and grown by
0.02 mm so it reads on top of the bead it marks; the rest of that layer is faint
blue context.

## The Z filter — the second axis

The line slider steps along the path. It does not change **what is drawn**, and
what is drawn is every layer at once: a `FEATURE` group is every move of that
feature at *every* height, so on `tabletop.gcode.3mf` the `Outer wall` model is
73 layers stacked and overlaid in one object. A single layer's construction
cannot be read off that, which is the gap the audit in
`docs/GCODE-FEATURE-AUDIT.md` found.

**Isolate Z** adds the missing axis. Feature grouping says *which feature*; the
Z window says *at what height*. Together they name one layer of one feature,
which is what "in isolation" has to mean and what neither says alone.

    Isolate Z (one layer at a time)     checkbox
    ± mm                                half-extent of the window; 0 is one layer

The window is a centre and a vertical half-extent — the same shape the reference
tool's capture box uses (`|mz − cz| ≤ h`), centred on the scrubbed line's Z. At
`± 0` it holds exactly one layer; raise it and it takes a slab of several. The
readout names what is in it:

    Z 19.500 .. 19.500 mm  -  1 layer, 359 lines of 202877  (one layer, isolated)

### It is a view, not an edit

While the filter is on, the imported feature models are **hidden** and the
window's moves are redrawn in the overlay instead, one mesh per feature in that
feature's own colour. Hiding and redrawing is the whole mechanism, and it keeps
the invariant the scrub highlight already held: no geometry is rebuilt, no model
is dirtied, nothing reaches the undo stack. `npm run gcode:drive` asserts all
three across a full on-extract-export-off round trip, and asserts that
unchecking gives every model its visibility back.

### The printing Z, not the bead's span

A move is in the window when its **printing Z** is inside it:

    mv.z >= win.zLo − Z_EPS && mv.z <= win.zHi + Z_EPS

Not its bead's span. The nozzle Z is the *top* of the bead, so a bead hangs down
into the layer below: a bead printed at 5.1 with a 0.3 mm height spans 4.8 … 5.1,
and its underside sits exactly *on* the 4.8 layer's printing Z. A span test would
therefore pull it into 4.8's window, and every layer would carry its neighbour's
beads — no isolation left to have.

`gcode:zfilter` pins that with exactly this case, and it has teeth: swapping the
printing-Z test for a span test breaks not just that check but the partition
invariant below, which then counts 85 moves across a 51-move toolpath.

### Layer index and Z are 1:1 on real output

The filter is keyed on Z, the layer table on `; CHANGE_LAYER`. On both committed
real slices those agree exactly — 73 layers / 73 distinct heights, and 50 / 50,
with no layer holding two heights and no height spanning two layers. `gcode:zfilter`
asserts it per file rather than assuming it, and also asserts that the isolated
layers *partition* the toolpath: every move in exactly one layer, none twice,
none lost.

## Extract Line

**Extract scope** decides how much the button takes:

| Scope | Takes |
| --- | --- |
| **This whole layer at one Z (all features)** | **every move at the scrubbed line's printing height, whatever feature printed it — the default** |
| This feature, at this Z | that feature, at that height: the two axes together |
| This line only | the one scrubbed move |
| This feature, on this layer | every move of that feature on that layer, by layer index |
| This whole layer | every move on that layer, by layer index |

The default is **a whole layer at one Z**, not a single move. That is the
extraction unit: the thing you send to Bambu Studio on an empty plate is a
layer, and a lone 1.5 mm strand is not a print. The narrower scopes are kept
because they are still the right answer when you want to look at one strand.

The two Z-keyed scopes are keyed on the printing height, so what Extract takes
is exactly what the Z filter shows. The two layer-index scopes are kept as they
were; on real Bambu output the two keyings agree (see above).

The selection is pulled out **exactly as imported** — same flat line solids,
same widths, nothing re-fitted — and lands in `state.models` through the
ordinary ingest path. So it is undoable, and it exports through the ordinary
**Export plate** / **Download selected** buttons in either format.

### Closing the loop

With the extracted object selected, **Download selected** writes it and nothing
else. `npm run gcode:drive` does exactly this, through the real buttons, then
re-opens the saved file from disk and checks that it holds only the extracted
feature: 36 triangles, an X span of the bare 9 mm interface run, a Y span of the
three lines plus one width, and a Z span of **one layer** — no other layer came
with it. That file, loaded fresh into Bambu Studio on an empty plate, is the
single-line print.

## Checks

    npm run gcode:lines      # 95 checks, no browser
    npm run gcode:zfilter    # 103 checks, the Z filter + the real files
    npm run gcode:drive      # 106 checks, the real app in headless Chromium
    npm run gcode:fixture    # regenerate the ground-truth fixture

All three are in `npm test`.

`gcode:lines` runs in tiers: the flow model (exact inverses, hand-computable
cases, degenerate inputs), the parser state machine (relative vs absolute E,
`G92` rebases, travels and retractions, feature grouping, height sources, arcs),
the flat-line geometry (measured width / height / length / angle, closure,
positive volume, triangle→move mapping), the ground-truth fixture end to end,
and the solidity of an extracted group.

### The ground-truth fixture

`fixtures/3mf/toolpath-ground-truth.gcode.3mf`, written by
`tools/gcode-test/make-fixture.js`.

The importer's whole claim is that it recovers a move's real printed width from
that move's own E value. The only way to prove that is to write a file whose
correct answer is known exactly, then read it back and compare. So the generator
goes the other way round the flow model: it is handed the width and height each
line should print at, computes the E the slicer would have written, and emits
that. The check asserts the importer recovers the widths and angles it started
from — worst case **3.4 × 10⁻⁶ mm** on width (the fixture rounds its E values to 5 decimals, as a
slicer does) and **exactly 0** on angle — and that
`meta.assumed` is false.

It is a correctness fixture, **not a sample of Bambu's output**. It is
deliberately shaped like a real slice (M83, `G92 E0`, the tag set, travels,
retractions, Z hops, the trailing config block) so the parser is exercised on
the same structures, but the geometry is a test pattern and no claim is made
that Bambu would slice anything this way.

### Real files — the tier that used to be skipped

Two real sliced projects are now committed, so this tier **runs by default** in
both `gcode:lines` and `gcode:zfilter`:

| file | what it brings |
| --- | --- |
| `fixtures/3mf/tabletop.gcode.3mf` | 73 layers, 202,877 moves, 9 features; a two-layer support interface over a tree-support tower |
| `fixtures/3mf/supportwithinsupport.gcode.3mf` | 50 layers, 2,895 moves, 10 features; the only one of the two with `Floating vertical shell` |

`NSO_GCODE_REAL=/path/to/a.gcode.3mf` still overrides, to point the same
measurements at another slice; several can be given, separated by `:`.

#### The hand-verified measurements

The synthetic fixture proves the importer recovers numbers *this repo computed*.
It cannot prove the importer reads a structure Bambu Studio writes and this repo
never thought to generate. So `gcode:zfilter` checks the importer's measurements
against three facts hand-verified off `tabletop.gcode.3mf` itself, independently
of any code here. All three now pass:

| hand-verified | measured | check |
| --- | --- | --- |
| support-interface strand width ≈ **0.61 mm** | **0.6089 mm** length-weighted over 8,992 mm of path; every move between 0.6072 and 0.6094 | pass |
| **exactly 2** stacked support-interface layers, zigzagging in **opposite** directions | layers 64 and 65, Z 19.500 and 19.800, one 0.300 mm layer height apart and consecutive; dominant raster **135° then 45°** — 90° apart, with >95 % of each layer's path on its own axis | pass |
| **no separate border / perimeter feature** — only branch-tip convergence at the interface edge | no feature in the file is named border, perimeter, contour, brim, raft or loop. The 4.4 % of path that is off-axis is **154 isolated single moves**, longest consecutive run **1** — zigzag turnarounds, not a contour, which would be one unbroken run round the outline | pass |

On branch-tip convergence specifically: the support layer directly below covers
the same 69.8 × 69.7 mm footprint in **6,972 short moves** (0.33 mm mean) while
the interface covers it in **311 long strokes** (14.5 mm mean). Many fine branch
tips converging into a sparse sheet, at one shared footprint — so the interface
*caps* the branches rather than outlining them, and no border is needed. The
footprint match and the mean-length inversion are both assertions.

#### What the real files caught that the fixture could not

Three things, all of them structures only a real slicer writes:

1. **`Math.min(...widths)` overflowed the stack.** The real tier had never been
   run, and its first contact with a 202,877-move file threw
   `RangeError: Maximum call stack size exceeded` — an argument-spread limit,
   not a parser bug. It folds now.
2. **Bambu rounds its own `; LAYER_HEIGHT:` tag.** `tabletop.gcode.3mf` writes
   `0.3`, `0.299999` *and* `0.300001` for what is a uniform 0.3 mm Z step, so the
   declared height and the measured step legitimately disagree at the 1e-6 level.
   The generated fixture writes exact values and would never have shown this.
3. **`Custom` is tagged but lays nothing down.** Both files tag a `Custom`
   section (start/end G-code) that produces no group, because those moves are
   purge and prime with no XY distance. See `docs/GCODE-FEATURE-AUDIT.md`.

#### Licence

Both files are the user's own sliced projects, staged on `nolongerzzz/nest-wip`
(branch `source-files`, folder `uploads`) and committed here as test data. They
are not Bambu Lab or MakerWorld content, so the licence note that keeps a
MakerWorld project out of `fixtures/3mf/` does not apply.

## Files

| File | What it is |
| --- | --- |
| `nso-gcode-lines.js` | UMD, no deps; parser, flow model, flat-line geometry. Same code in the page and under Node. |
| `app-toolpath.js` | `NSO_TOOLPATH`: import, reseating, the scrub overlay, the card, Extract Line. |
| `index.html` / `styles.css` | the Toolpath card |
| `app-core.js` | `handleFiles()` routes `*.gcode.3mf` here; everything else unchanged |
| `tools/gcode-test/` | the three suites and the fixture generator |
| `docs/GCODE-FEATURE-AUDIT.md` | the reference tool vs this importer, category by category |
| `docs/reference/joint_microscope_3d.html` | the reference inspector, parked; nothing loads it |

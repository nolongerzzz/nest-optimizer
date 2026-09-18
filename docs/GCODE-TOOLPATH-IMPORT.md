# Sliced-G-code toolpath import

Import an **already-sliced** Bambu Studio project (`*.gcode.3mf`) and render its
real toolpath as genuine, editable NSO geometry — then scrub to one line and
pull that line out as its own object.

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

## Extract Line

**Extract scope** decides how much the button takes:

| Scope | Takes |
| --- | --- |
| This line only | the one scrubbed move |
| This feature, on this layer | every move of that feature on that layer |
| This whole layer | every move on that layer |

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

    npm run gcode:lines      # 81 checks, no browser
    npm run gcode:drive      # 58 checks, the real app in headless Chromium
    npm run gcode:fixture    # regenerate the ground-truth fixture

Both are in `npm test`.

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

### Real files

    NSO_GCODE_REAL=/path/to/a.gcode.3mf npm run gcode:lines

Runs the same measurements over a real Bambu Studio slice: moves, layers and
features found, filament diameter read from the file, `meta.assumed` false, and
widths and heights inside physically plausible bounds. Several files can be
given, separated by `:`. It is **skipped, loudly**, when the variable is unset,
because it needs a file that is not in this repo — same convention as
`NSO_3MF_REAL` for the geometry importer.

**This tier has never been run.** No real sliced `.gcode.3mf` exists anywhere in
this repository or its history, and neither does a recorded hand measurement to
check against. Everything above is proven against synthetic ground truth and the
real app; the one thing no check here can reach is a file Bambu Studio actually
wrote. Point `NSO_GCODE_REAL` at one and record the outcome here — that is the
open item.

## Files

| File | What it is |
| --- | --- |
| `nso-gcode-lines.js` | UMD, no deps; parser, flow model, flat-line geometry. Same code in the page and under Node. |
| `app-toolpath.js` | `NSO_TOOLPATH`: import, reseating, the scrub overlay, the card, Extract Line. |
| `index.html` / `styles.css` | the Toolpath card |
| `app-core.js` | `handleFiles()` routes `*.gcode.3mf` here; everything else unchanged |
| `tools/gcode-test/` | the two suites and the fixture generator |

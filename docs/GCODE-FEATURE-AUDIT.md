# Feature-category audit: the reference tool vs `nso-gcode-lines.js`

An audit of `docs/reference/joint_microscope_3d.html` — a working, standalone
G-code inspector — against this repo's toolpath importer, to settle one
question: **which of the reference tool's feature categories does the importer
not have?**

Short answer: **none of the extruding ones, and it never will need to be told
one.** The one category it structurally cannot produce is `Travel`. The real gap
the audit found was not a missing category at all — it was a missing *axis*, and
that is what `docs/GCODE-TOOLPATH-IMPORT.md`'s Z filter section now covers.

## What the reference tool is

A single 4.8 MB HTML file, parked here as reference and not wired into anything.
`SEGMENTS`, one 4.78 MB line of it, is a baked snapshot of 25,976 extrusion and
travel moves out of one real slice; the ~22 KB of code around it draws them with
three.js and lets you isolate pieces.

It is reference material, not a dependency. Nothing in the app loads it, no check
reads it, and it is committed so the two things it does well can be compared
against ours rather than remembered.

## The two things it does well

### 1. Feature-level isolation

A legend of 14 entries, click to toggle:

| Reference legend entry | In a real slice? | In the importer? |
| --- | --- | --- |
| Bottom surface | yes | **yes** |
| Bridge | yes | **yes** |
| Floating vertical shell | yes | **yes** |
| Gap infill | not in either committed file | **yes**, if the file has it |
| Inner wall | yes | **yes** |
| Internal solid infill | yes | **yes** |
| Outer wall | yes | **yes** |
| Overhang wall | yes | **yes** |
| Sparse infill | yes | **yes** |
| Support | yes | **yes** |
| Support interface | yes | **yes** |
| Top surface | yes | **yes** |
| Custom | tagged, no geometry | **no group** — see below |
| Travel | yes | **no, structurally** — see below |

The reason the extruding column is solid all the way down is that **the importer
does not have a category list to be missing from.** Grouping is the tag itself:

```js
// nso-gcode-lines.js, parseGcode()
if ((m = RE_FEATURE.exec(raw)) !== null) { feature = m[1]; continue; }
```

Whatever string follows `; FEATURE:` becomes a group. So a category cannot be
"missing" — if Bambu Studio writes it, it groups, including a category that did
not exist when this was written. The reference tool, which hard-codes its legend,
is the one that has to be taught a new name; `FEATURE_COLORS` here is *only* a
colour table, and an unlisted feature still groups and draws in `OTHER_COLOR`.

Measured, not assumed — every `; FEATURE:` tag in the two committed real files
against the groups the importer returns:

```
tabletop.gcode.3mf
  FEATURE tags in file : Bridge | Custom | Inner wall | Internal solid infill |
                         Outer wall | Overhang wall | Sparse infill | Support |
                         Support interface | Top surface
  groups from importer : (the same, less Custom)
  tagged but NO group  : Custom (2 tags)

supportwithinsupport.gcode.3mf
  FEATURE tags in file : Bottom surface | Bridge | Custom | Floating vertical shell |
                         Inner wall | Internal solid infill | Outer wall |
                         Overhang wall | Sparse infill | Support interface | Top surface
  groups from importer : (the same, less Custom)
  tagged but NO group  : Custom (2 tags)
```

`gcode-zfilter-check.js` asserts the other direction too: every feature either
real file names has its own colour here, so none of them falls through to
`OTHER_COLOR`.

### Why `Travel` cannot appear, and why that is correct

`Travel` is not a slicer feature tag at all — the reference tool synthesises it
for the moves *between* extrusions, and gives them a fixed `w: 0.06` because a
travel has no width to measure.

The importer drops them, in `pushMove` and one line above it:

```js
if (havePos && dE > 0 && (g === 1 || g === 2 || g === 3)) { ... }
// and, inside:
var w = widthFromExtrusion(dE, dist, hh.h, filD);
if (!(w > 0)) return;
```

No extrusion → no cross-section → no bead → no geometry. That is not an
oversight to close. This importer's output is **printed solids**, each one the
real shape the nozzle laid down; a travel prints nothing, so a solid for it would
be a fiction, and it would be a fiction with a made-up width. The reference tool
can draw travels because it draws *lines* — a view. We build geometry, which is
held to a different standard.

If travels are ever wanted on screen, they belong in the scrub overlay (a view,
like the reference tool's) and never in a feature group or an export.

`Custom` is the start/end G-code block. It is tagged in both real files and
produces no group in either, because those sections are purge and prime moves
with no XY distance. It is in the colour table so that a file whose `Custom`
block does lay something down draws it in a known colour rather than grey.

### 2. Sphere-to-box capture-region selection

The tool's selection region started as a sphere and became a **box with two
independent extents**, and the reason is written into its own UI text:

> Drag the **small orange dot on top** to control how thick (tall) it is — keep
> it thin to avoid grabbing unrelated layers above/below.

A sphere has one radius, so reaching 5 mm across the plate also reaches 5 mm up,
which is twenty layers. The fix was to split the vertical extent from the
horizontal one:

```js
let defaultR = 5.0;
let defaultH = 1.0; // flat by default - a thin slab, not a tall cube

currentSelection = SEGMENTS.filter(s => {
  const mx = (s.x0+s.x1)/2, my = (s.y0+s.y1)/2, mz = s.z;
  return gcodeBoxes.some(b =>
    Math.abs(mx-b.gx) <= b.r && Math.abs(my-b.gy) <= b.r && Math.abs(mz-b.gz) <= b.h
  );
});
```

`|mz - b.gz| <= b.h` is the whole mechanism: a **Z window as a centre and a
vertical half-extent**, tightened until it holds one layer.

## The real gap, and what was done about it

The audit's finding is not a missing category. It is that the importer had
**one grouping axis where the reference tool has two**:

| | which feature | at what height |
| --- | --- | --- |
| reference tool | legend toggles | the capture box's `h` |
| importer, before | `; FEATURE:` groups | **nothing** |

A feature group is every move of that feature at *every* height. On
`tabletop.gcode.3mf` that means `Outer wall` arrives as 73 layers in one model,
stacked and overlaid, and a single layer's construction cannot be read off it —
which is exactly what the reference tool's thin box exists to solve.

So the second axis was added, in the same shape: `zWindowAround(z, half)`, a
centre and a vertical half-extent, tight by default. See **The Z filter** in
`docs/GCODE-TOOLPATH-IMPORT.md`.

One deliberate difference from the reference tool. A window tests a move's
**printing Z**, not its bead's span:

```js
return mv.z >= win.zLo - Z_EPS && mv.z <= win.zHi + Z_EPS;
```

A bead hangs *down* from the nozzle Z into the layer below, so a span test would
pull every layer's beads into its neighbour's window and there would be no
isolation left to have. `gcode-zfilter-check.js` pins that with a bead whose span
touches the layer above and which is still correctly excluded.

## What was not adopted

- **Drawing travels.** Reasoned above: no extrusion, no solid.
- **Lines instead of solids.** The reference tool draws `LineSegments` for the
  overview and unit cylinders for detail. Both are pictures. This importer's
  entire claim is that what you see is the real printed solid at its measured
  width, which is what makes it *extractable*; a cylinder would be neither the
  right cross-section (a bead is a stadium, not a circle) nor exportable as the
  thing that prints.
- **Click-to-place capture boxes in the viewport.** The Z window is driven from
  the scrub cursor and a thickness, which needs no new viewport interaction mode
  and composes with the line slider that was already there. The box UI is the
  better answer for grabbing a region *across* features at arbitrary XY, and it
  is not what "isolate one layer" needs.
- **`Custom` as a group.** It is in the colour table, not forced into a group;
  if a file's start G-code lays nothing down there is nothing to group.

## Provenance

All three reference files were staged on `nolongerzzz/nest-wip`, branch
`source-files`, folder `uploads`, and copied into this repo:

| staged as | landed at |
| --- | --- |
| `uploads/joint_microscope_3d.html` | `docs/reference/joint_microscope_3d.html` |
| `uploads/tabletop.gcode.3mf` | `fixtures/3mf/tabletop.gcode.3mf` |
| `uploads/supportwithinsupport.gcode.3mf` | `fixtures/3mf/supportwithinsupport.gcode.3mf` |

`nest-wip` was the staging drop-off only. It is also this repo's Pages preview
mirror (see `docs/PREVIEW-SITE.md`), and nothing here depends on it: the files
are committed, and no check, script or page fetches anything from it.

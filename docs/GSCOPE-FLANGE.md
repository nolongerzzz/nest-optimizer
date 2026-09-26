# G-scope: the Flange tab

G-scope's isolation tabs (the floating list, "click to isolate") are whatever
the file groups: a slice's `FEATURE:` tags — Outer wall, Sparse infill,
Support — or a mesh's build objects. Those are **print-process** and
**file-structure** categories. A flange is neither. It is a functional,
geometric part of *one* object, so nothing in the file names it. Until now,
taking the clamp bar's flange out meant cropping it by hand.

`nso_flange.js` names it. This page is the rule, the numbers it was validated
on (before any UI was built), and what it deliberately does not find.

## The rule: a flat, thin, wide protrusion off a thicker body

Two candidate rules were on the table:

- **a local cross-section spike** (area or perimeter jumping against the
  running average along the part), and
- **a wide, thin, flat protrusion off a narrower neck or main body.**

The spike rule was not taken. On the clamp bar the flange's layers (Z 7.53 –
10.47) are also the body's top, so a spike finds a *band*, not the flange in
it, and the keyholed ribs spike the perimeter on every layer. It also only
works along one direction (the one you slice in). The protrusion rule measures
the flange itself, along whichever direction it lies.

The rule, as `detect(soup)` runs it:

1. **Candidate axes.** Face normals are clustered to 5°. A cluster is an axis
   when it holds ≥ 3 % of the surface area *and* has area facing both ways
   along it: a slab needs a top and a bottom. An axis within 0.5° of X, Y or Z
   is that axis. The clamp bar gives Z (34 % of its area), Y (22 %) and X (6 %).
2. **Columns.** Along each axis, rays on a grid (cell `h` = diagonal / 500,
   0.38 mm on the clamp bar) give each column's solid intervals `[a, b]`.
   Entries and exits are counted by winding, and one surface met on a shared
   edge is counted once, so a seam's slivers cannot flip the parity. A column
   that does not close is marked **bad** and left out, never guessed.
3. **Slabs.** Neighbouring columns join when their intervals overlap and have
   the same thickness and the same two faces (to 3 % and a quarter-cell). A
   component is a flat plate of one thickness `t`, parallel-faced.
4. **A slab is a flange when**, on its core (the columns within 5 % of its
   median thickness):

   | test | condition | clamp bar | needed |
   |---|---|---|---|
   | attached | edges meet a *thicker* column that holds the slab's band: the root. Root length ≥ 2 t | 186.2 mm | 5.9 mm |
   | thin | body at the root (max thickness within 4 t of the edge) ≥ 2.5 t | 20.94 mm | 7.35 mm |
   | wide | sticks out ≥ 3 t (and ≥ 4 cells) from the root | 14.15 mm | 8.82 mm |
   | flat | both faces fit a plane to 0.05 t + 0.02 mm RMS | 0.007 mm | 0.167 mm |
   | straight | the root is a line: RMS ≤ max(0.75 h, 2 % of its length), nothing behind it | 0.000 mm | 3.7 mm |
   | body | from the root *into* the body along the reach direction: ≥ 2.5 t of bulk beside the band, **or** the slab carries on ≥ 2.5 t across its neck | 19.0 mm bulk | 7.35 mm |

   "Body" is what separates a flange from one leg of an L-bracket. The other
   leg is tall along the first leg's normal, so it passes "attached" and
   "thin", but it is only a plate thickness deep in the reach direction, and
   nothing carries on across the corner. A T or I section's flange carries on
   across its web into the other wing, so a web thinner than 2.5 t still
   counts. It is measured at 15 stations along the root. The upper quartile
   is taken so that the clamp bar's keyholes (a third of its root) cannot
   sink it, and one gusset between two plates cannot fake a body.

Every slab is kept with the tests it failed (`candidates`), so "why no
flange?" always has an answer. The tab puts the nearest slab's failures into
words, for example "the nearest flat plate (8 mm) does not come off anything
thicker".

### Lifting it out

`extract(soup, flange, rawCut)` makes **one cut on the root plane** with the
Cut tool's own `rawCut`, keeps the flange side, and keeps only the pieces on
that side that lie in the slab's band. The soup is turned first when the root
plane is not an axis plane.

The root from the grid is only good to half a cell, so the cut is snapped onto
the real neck wall: the faces that look toward the flange, beside the band,
within 1.5 cells of the grid root. The cut does **not** go through the wall's
mean. It goes 2 µm past its **outermost** piece. The clamp bar shows why. Its
neck wall is at y = −1.9987 between the Mirror-Join seams, and −2.0103 beyond
the −X seam. A cut at the mean leaves a 12 µm skin of neck on the flange side,
joined to the flange through the cap. Measured: that piece runs down to
Z −10.47. A piece that is mostly slab but leaves the band is **refused**
("the cut on the root takes part of the body with the flange"). It is never
handed back as the flange.

## Validation (`npm run flange:test`, 48 gates)

### The clamp bar, `library/v9_mirror_factory.stl`

| | measured | truth |
|---|---|---|
| flanges found | 1 | 1 |
| axis | Z (0, 0, 1) | the plate lies flat |
| thickness | 2.939 mm | 2.938 (Z 7.531 – 10.469) |
| root | y = −2.0123 cut, wall mean −1.9987 | neck wall −1.9987 / −2.0103 / −1.9897 |
| extracted bounds | X ±93.493, Y −17.010 … −2.012, Z 7.531 … 10.469 | the whole plate, full length |
| extracted volume | 8146.2 mm³ | 8154.1 by an independent 0.05 mm ray-parity integration (−0.10 %) |
| extracted solid | closed, manifold, consistent winding, χ = 2, one piece | |
| bad columns | 0 (seams included) | |
| time | 0.3 – 0.6 s (49,026 triangles, node) | |

**No false positives** on the regions you'd expect to fool it. 905 slab
candidates are found on the part, and every one outside the flange fails:

| region | slab candidates | pass | the closest one |
|---|---|---|---|
| ribbed (keyholed) top | 650 | 0 | tooth-top fillet strips, 0.38 mm out: 3–11 % of "wide" |
| rounded ends (\|x\| > 88) | 93 | 0 | |
| seams (±3 mm of x = 87.537, −88.565) | 128 | 0 | |

Of all 905, 28 even get past "attached". The best of those reaches 11.6 % of
the protrusion "wide" asks for.

**Pose.** The clamp bar was also run turned 90° about Z, upside down, on its
side, turned 30° about Z (an off-axis root, cut through a turned frame), and
turned 30° about Z then 20° about X. Every pose finds the one flange at
2.94 mm, and every extraction is within 0.05 % of 8146.2 mm³. The turned cuts
pass the checker too.

### Everything else in the repo (102 STLs in `library/` and `fixtures/`)

| result | files |
|---|---|
| flange found, and it is one | the clamp-bar family: `v9_mirror_factory`, `tape_on-edge-single`, `tape_on-edge-single-B101_rounded_v8_FINAL` (×2), `tape_welded_clustered`. Same 2.94 mm flange, same 20.9 mm body |
| flange found, arguably one | `fixtures/lid_strap.stl`: a 0.6 mm strap standing 8 mm off a 2.4 mm lid, along a 60 mm edge. A thin flat lip off a thicker body is what the rule describes |
| none | the other 95 (one ASCII STL was not read) |

Before the "body" test, `fixtures/repair/thingi10k/39644.stl` was flagged. It
is a bracket, and its upright is a 6 mm plate standing on a base plate. That
false positive is what the test was added for. It now fails "body" (the base is
a plate, not a body), and so does the synthetic uniform L-bracket.

### Synthetic shapes

| shape | flanges | extracted |
|---|---|---|
| T section, 2 mm wings on a 4 mm web | 2 | 2079.7 of 2080 mm³ each |
| hat section, 2 mm brims | 2 | 1559.8 of 1560 each |
| 2 mm lip on a 20 mm block | 1 | 1439.8 of 1440 |
| L-bracket, both legs 3 mm | 0 (body) | |
| thick L, 12 mm legs | 0 (wide) | |
| plain 2 mm plate | 0 (attached) | |
| thin-walled tube | 0 | |
| **round flange on a pipe** | **0 (straight)**, a known limit | |

The 0.3 mm shortfall on the synthetic volumes is the 2 µm root clearance.

## What it does not find, on purpose

- **A round flange** (a pipe's collar, a lid rim). Its root is a circle, and
  one plane cannot lift it out. The slab is found, and it fails "straight".
  This is pinned in the test so it is not mistaken for a pass. Lifting it out
  needs a revolved cut, which the Cut tool does not have.
- **A curved or drafted flange.** "Flat" is part of the definition, since
  both faces must fit a plane.
- **A flange on a slice.** Detection needs a closed surface to cast rays
  through. A `.gcode.3mf` has beads, whose overlapping boxes do not close.
  Open the part's STL or 3MF, or read the sliced plate back in G-scope (the
  plate route), to use the tab. See "On a slice" below.

## The tab

The floating list in G-scope ("Parts / Features (click to isolate)") has a
row under a rule, below the file's own tabs: **Flange**. It is kept in its
own `#ms-detected` block, not in `#ms-legend`, because those rows are exactly
the file's own groups and several checks count them as that.

| document | the row reads | a click |
|---|---|---|
| a mesh with a flange (STL, 3MF, the plate) | `Flange (2.94 mm, 2858 tri)`, in the tab's orange | selects the flange and isolates it, framed on it. The row stays lit while it is the selection |
| a mesh with none | `Flange - none detected`, dimmed. The tooltip says why, in words | nothing is selected or isolated, and the info line says no flange was found |
| a slice | `Flange - not on a slice`, dimmed | the same. The tooltip says to open the part itself |
| while it is still looking | `Flange - looking...` | runs the detection there and then |

Detection runs once per document, just after it opens, so the view comes up
first. It takes 0.7 s on the clamp bar in the page. On the plate every piece
is scanned, and a piece over 400,000 triangles is skipped by name.

**It feeds the same mechanism as any selection.** What detection hands back
is an ordinary mesh object (positions, centroids, bounds), passed through
`setSelection()`. So:

- **Isolate** draws it alone, in its colour. **Back** returns the whole part
  with the flange highlighted on it, drawn over the part.
- **Export as STL** and **Export to plate** write exactly the flange, named
  `<part> - Flange`.
- **Crop** takes a Z band out of it. A flange is not a plate piece, so Crop
  sends it the file route: it becomes a new piece, which is then cropped. The
  piece it came from is never edited, not even on the plate.

In the page: `NSO_MICROSCOPE.flange()` (status, reason, objects),
`.detectFlanges()` and `.isolateFlange()`.

### On a slice

The tab says it cannot look, and it does not guess. The rule needs a closed
surface to cast rays through, and a slice's beads are overlapping boxes. The
per-layer "area spike" variant would work on beads, but it finds a band, not
the flange (see above). And on the clamp bar the flange's top layers are
diagonal infill lines that run from the flange tip across the body top, so
isolating whole moves could not separate the two. That would take clipping
moves at the root, which is a different change.

## What proves it

- `npm run flange:test` (`tools/nso_flange_test.js`, 48 gates): the rule on
  the real clamp bar, the false-positive audit, the lifted solid against an
  independent integration and the canonical checker, five poses, library
  pieces with none, and the synthetic shapes. About 10 s.
- `npm run gcode:gscope-flange` (`tools/gcode-test/gscope-flange-drive-check.mjs`,
  47 checks, headless Chromium, the real app):
  1. the clamp bar through G-scope's own Import. The tab finds it, and the
     page's flange matches the Node one triangle for triangle and to the micron
     in bounds;
  2. a real click on the tab isolates it: alone, one solid, orange on the
     read-back pixels, framed at its middle height. Back highlights it on the
     part;
  3. Export as STL writes exactly the flange (`PASS`, 0 open, 0 non-manifold,
     χ 2). Crop takes 8.5–9.5 out as a new piece;
  4. the plate route: a click on the tab and Export to plate. The clamp bar
     itself keeps every triangle;
  5. `hinge_knuckle_box.stl` reads "none detected" and a click does nothing
     but say so. A slice says it cannot look, with all ten of its feature tabs
     intact, and a click there says "not available", not "none".

  Screenshots land in `tools/gscope-flange-out/`.

# Section reader and the Scale card

`nso_section.js` (headless) reads what shape a piece is; `app-scale.js`'s card
puts that reading in print terms on its first line and offers only the verbs
that apply. Part 1 of 3: the ring verbs (outer / bore / wall) and the bar verbs
(width / depth) are the next two tickets, and Fatten / Shrink fold in there.

```
node tools/nso_section_test.js             headless: every fixture, its truth, three quarter turns
node tools/nso_scale_card_drive_check.js   the real app: Stock tube / box / sphere, tape_on-edge-single
node tools/nso_wire_scale_test.js          Whole x, Longest, Undo, refusals, paint
```

All three are in `npm test`.

## The reading

```
NSO_sectionRead(soup, opts) -> { shape: 'round' | 'rectangular' | 'other', hollow,
                                 axis, lengthMm, outer, bore, wallMm, reason, ... }
NSO_sectionReadout(reading) -> the card's first line, minus the fit verdict
```

Nothing in it is a second copy:

| what | whose code |
|---|---|
| the straight axis | `NSO_extendDetectAxis` — same scope, same refusals. `ambiguous` (a cube, a square bar) is taken with the longest tied axis, as `nso_stock.js`'s `proportionsFrom` already does; `axisTied` lists them |
| where the section is constant | `NSO_extendBands` — Extend's clean gaps, chained into runs that break at an unclean gap or at a layer carrying a face lying in it (a step) |
| the section | `rawCutOpen` → `rawPlaneBoundaryEdges` → `rawBuildLoopsFromCutEdges`, the Cut tool's walker, at mid-length |
| the nesting | `rawNestLoops`, pulled out of `rawFlatCapLoops` so the two read "a loop inside a loop" with one piece of code |

The gates run in order; the first that fails names the answer:

1. **A straight axis** — `no straight axis: 100% of the surface is curved or tapered` / `no straight axis: 31° oblique`.
2. **A constant section over ≥ 90% of the length** — `section is constant over only 26.0 of 52.0 mm along Z (50%) - the rest is shaped` (a capsule's barrel), or `section is not constant along X at mid-length - no clean straight band anywhere along it`.
3. **The loops** — one is solid, a loop inside a loop is hollow, else `section has 3 loops` / `section has 2 loops side by side`.
4. **The fit** — outer loop round or rectangular within tolerance; a bore the same class and, if round, concentric. Else `outer loop is 0.8 mm off round (tolerance 0.10 mm)`, `outer loop is round but the bore is ...`, `bore is 1.3 mm off centre`.

### Tolerances, stated

- **Round:** the whole loop, vertices and edges measured exactly per segment,
  inside an annulus `max(0.05 mm, 1% of r)` wide about the fitted centre. The
  centre is the least-squares (Kasa) fit; `r` is the circle the vertices sit
  on, because that is the circle a tessellator put them on — a revolved 96-gon
  of radius r has every vertex at r and its chords dip inside. Since part 2 it
  is the *mean* radius of the outline's corner points (its local radius
  maxima), not the largest: identical on a regular polygon, and one noisy
  vertex no longer sets the size (`MINI_TPU_TEST`'s outer reads Ø20.0000, not
  Ø20.0012). 1% admits any
  regular tessellation of 23+ segments; the 0.05 mm floor is under a 0.4 mm
  nozzle's resolution. An 8-gon of r 10 is 0.761 mm off (its sagitta) and reads
  as an octagon.
- **Rectangular:** every point of the loop within `max(0.05 mm, 1% of the
  shorter side)` of its own axis-aligned bounding rectangle, exactly per segment
  (distance to the boundary is the min of four linear functions along a
  segment, so its maximum is at an end or a crossing).
- **Concentric:** a round bore's centre within the bore's own round tolerance.

A bar's section is reported wider side first (`widthMm ≥ depthMm`), so the
answer does not depend on which way the piece is turned; the test turns every
fixture 90° about X, Y and Z and requires the same shape, the same reason (axis
letter aside) and the same numbers to the bit.

## The card

First line: `Ring Ø… outer · Ø… bore · wall … · length …` (round hollow),
`Rod Ø… · length …` (round solid), `Bar W × D × L` (rectangular, `· bore … ·
wall …` if hollow), or `W × D × H · reason` for `other` — then ` · fits A1 Mini`
or ` · 5.0 mm too wide for A1 Mini` from `NSO_fitCheckAll`: the bed's directions
as words (wide / deep / tall), since W / D on this card are a bar's section
sides.

| verb | what it calls |
|---|---|
| **Length** `[ ] mm` | `NSO_extendSelectedModel({ length })` — longer extends, shorter shortens, cross-section held. Shown only when there is a straight axis; prefilled with the real length. On a tied axis (a cube) the reading's axis is passed so Extend does not refuse it as ambiguous |
| **Whole ×** `[ ]` | `NSO_scaleSelectedModel({ factor })`, unchanged |
| **Longest** `[ ] mm` | `NSO_scaleSelectedModel({ axis: 'longest', targetMm })`, unchanged |
| **Fit to plate** | `min(limit / size)` over the bed's three axes, from the same `nso_printer.js` fit the plate warning uses, applied as a uniform factor and stated. Already fits: says so, changes nothing |

Removed: the X / Height / Z axis menu and the `X x H x Z` readout — they spoke
the display frame, where "Height" is right and "Z" is the bed's depth.
`NSO_scaleSolve` still takes a display axis underneath.

Paint scope is unchanged: Length is Extend's (whole-piece), Whole / Longest /
Fit to plate and the ring verbs are Scale's (whole-piece). Both are in the
HANDOFF roster.

The line re-reads whenever the selected piece's soup changes, whoever changed
it: while the card is open, a per-frame identity check on `rawTris` (every bake
replaces the array). `updateEditSize` alone missed Thicken and Fatten, which
commit through their own path.

## Ring verbs (part 2) — `nso_ring.js`

```
node tools/nso_ring_test.js            headless: every verb x fixture, against truth; canonical checker
node tools/nso_ring_drive_check.js     the real app: MINI_TPU_TEST from the Library, Shrink diagnosis
node tools/nso_ring_drive_check.js --shots    also writes docs/scale-ring/*.png
```

The rule: a dimension edit moves boundary faces, never scales, and on a ring
the wall is kept unless the wall is what is being edited.

| field | faces that move | held |
|---|---|---|
| **Outer Ø** → d | outer walls by Δr = (d − outer)/2, bore walls by the same Δr | wall, length |
| **Bore Ø** → d | bore walls by Δr = (d − bore)/2 | outer, length |
| **Wall** → w | bore walls by −(w − wall) | outer, length |
| **Diameter** → d (a rod) | outer walls by Δr | length |

Δr is in the reader's terms (the vertex circle), so the number the card shows
after an apply is the number typed. Walls are the faces parallel to the axis
(`NSO_fattenCrossSectionFaces`, Extend's own per-triangle test), split outer /
bore by their normal against the reader's centre; caps and every other face are
held.

**The move is solved in the section plane**, not by `_thickenOffsetSoup`. With
Fatten's face filter, Thicken's offset moves the right faces by the right amount
but leans the walls: its vertex solve merges facets within 15° into one
area-weighted plane, and a wall quad's top and bottom rim vertices see different
triangle areas, so they land a hair apart in XY. One outer pass takes
`MINI_TPU_TEST`'s Z census from 0% to 29.7% oblique and the result no longer
reads as a ring (`nso_ring_test.js` §7 pins this). Here every distinct section
point moves once, to where its neighbouring segments' offset lines meet, and
only the two section coordinates are written: walls stay parallel, caps stay
planar, and every axial coordinate is identical bit for bit — gated on every run.

**Refusals**, in millimetres:

| ask | refusal |
|---|---|
| wall under the floor | `wall would be 0.4 mm, under the 0.42 mm floor` |
| bore at or past the outer | `bore would reach the outer - Ø20 bore against a Ø20 outer` |
| bore at or past zero | `bore would close up - Ø0 mm is at or below zero` |
| a face driven inside out | `the move is more than the wall it crosses (N face(s) would turn inside out)` |

The floor is `NSO_Thickness.floorFor(nozzle)` — nozzle × 1.05, **0.42 mm at the
default 0.4 nozzle**, the one floor this repo keeps. There is no app-wide nozzle
setting, so the card uses the default; `NSO_ringApplyRaw(..., { nozzle })` takes
another (0.6 → 0.63 mm).

**MINI_TPU_TEST.stl** (nest-library, Library → Test Fixtures) is a 48-gon — 48
points per outline, 96 wall triangles per surface. Its outer vertices sit at r
9.9995–10.0006 (mean 10.0000) and its bore vertices at r 9.0020–9.0030, so by
its own vertices the bore is Ø18.005 and the wall 0.998; the published Ø18 /
wall 1 hold to 0.01 mm and the readout's one decimal exactly. The checks read it
from the `nest-library` checkout (`tools/nso_library_dir.js`) and SKIP out loud
without one.

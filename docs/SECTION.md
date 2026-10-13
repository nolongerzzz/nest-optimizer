# Section reader and the Scale card

`nso_section.js` (headless) reads what shape a piece is; `app-scale.js`'s card
puts that reading in print terms on its first line and offers only the verbs
that apply. Part 1 the reading, Length and the card; part 2 the ring verbs;
part 3 Length / Width / Height on boxes and trays, and Fatten / Shrink folded
in as one Offset.

```
node tools/nso_section_test.js             headless: every fixture, its truth, three quarter turns
node tools/nso_box_scale_test.js           headless: the generated tray and bar, L / W / H and Offset
node tools/nso_scale_card_drive_check.js   the real app: tube, tape, the tray, box, sphere; refresh; 900 px
node tools/nso_scale_inches_drive_check.js the real app: the mm | in toggle on a box, a tube and a rod; reload
node tools/nso_wire_scale_test.js          Whole x, Longest, Undo, refusals, paint
node tools/nso_wire_offset_test.js         Offset: reachability, Undo, refusals, paint, Thicken unchanged
```

All of them are in `npm test` (`section:test`, `box:test`, `scale:card`, `scale:inches`,
`wire:scale`, `wire:offset`). The drive checks take `--shots DIR` for
screenshots; DIR is a scratch directory - no screenshot is committed.

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

The gates run in order; the first that fails names the answer, in plain words
(`reading.gate` is its key, `reading.why` the words):

1. **A straight axis** — `it is curved or tapered all over (100% of its surface)` / `its straight axis is turned 31° off its own X, Y and Z`.
2. **A constant section over ≥ 90% of the length** — `only 26.01 of its 52.02 mm along Z keeps one section - the ends are shaped` (a capsule's barrel), or `its section changes all along X - no stretch of it is the same shape`.
3. **The loops** — one is solid, a loop inside a loop is hollow, else `its section is 3 separate outlines` / `... two separate outlines side by side`.
4. **The fit** — outer loop round or rectangular within tolerance; a bore the same class and, if round, concentric. Else the section is named for what it IS: `its section along Z is a 8-sided polygon, not a circle (0.76 mm off round)`, `its section along X is a U - open at the top - not a closed rectangle`, `... an L-shape, not a plain rectangle`, `... a stepped outline with N corners`; `its outside is round but its hole is ...`, `its hole is 1.3 mm off centre`.

For `other`, the reason line then says what still applies, from the same table
the card's rows come from (`NSO_sectionVerbs`): `..., so length, width, height
and whole-piece scaling apply` (the tray), `..., so only height, an even offset
and whole-piece scaling apply` (the capsule), `..., so only an even offset and
whole-piece scaling apply` (the sphere).

**Per-axis bands.** `reading.axes[0..2]` is Extend's band scan run along each of
the piece's own X, Y and Z (`NSO_extendBands`, which always took an axis): the
widest clean constant-section band along each, or none. An axis with no band
gets no field.

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
fixture 90° about X, Y and Z and requires the same shape, the same gate and its
words (axis letters aside) and the same numbers to the bit. The reason line's
"so ... apply" tail is NOT held across turns, on purpose: it names Length /
Width / Height, the piece's axes as it lies, and a quarter turn about X makes a
Height a Length.

**One display precision** (`NSO_sectionShow`): one decimal, and two only when
the one-decimal figure is more than 0.01 mm off the real value. The header and
every field use it: `MINI_TPU_TEST`'s Ø18.0047 bore is 18.0 in both; Stock's
40.623 mm tube is 40.62 in both.

## The card

First line: `Ring Ø… outer · Ø… bore · wall … · height …` (round hollow),
`Rod Ø… · height …` (round solid) - `height`, `length` or `width` by the axis
row's own name, `Bar … L × … W × … H` (rectangular, `· bore
… · wall …` if hollow), or `… L × … W × … H · reason` for `other` — then
` · fits A1 Mini` or ` · 5.0 mm too wide for A1 Mini` from `NSO_fitCheckAll`:
the bed's directions as words (wide / deep / tall).

**L / W / H are the piece's own axes as it lies, never the plate's:** Height is
its raw Z, Length the longer of its X and Y, Width the shorter. Part 1's bar line
read `W × D × L`, naming the section's sides; part 3 uses the names the fields
use.

One compact row per field — label | field | unit or hold | Set — and only the
rows `NSO_sectionVerbs` says apply:

| row | shown when | what it calls |
|---|---|---|
| **Length** / **Width** / **Height** `[ ] mm` | that axis has a clean constant-section band. A ring or rod: its one axis, under the same names (Height when it is its own Z) | `NSO_scaleAxisApply` → `NSO_extendRaw({ axis, length })`: material goes in or comes out inside the one band, every other coordinate untouched bit for bit, so walls, floor, holes, pockets and lips keep their size. Shorter shortens; past the band it refuses with `Shorten can remove up to N mm here` |
| **Outer Ø** `[ ] wall kept` / **Wall** `[ ] outer kept` | a ring | `nso_ring.js`, below. Part 2's **Bore Ø** row is gone: Outer Ø and Wall reach every bore between them |
| **Diameter** `[ ] height kept` (the axis's own name) | a rod | `nso_ring.js` |
| **Offset** `[ ] mm, wall kept` | every piece but a ring or rod, where Outer Ø / Diameter and Length already do its job. Elsewhere it is the only way to thicken a stepped piece evenly; see lid_strap below for where it is not even. A sentence under the row says so in the unit shown: `Thin features keep their thickness: a 0.6 mm lid strap stays 0.6 mm.` (`0.024 in` with inches shown) | `NSO_scaleOffsetRaw`, below — Fatten and Shrink, folded in |
| **Whole ×** `[ ]` | always; reset to 1 on every refresh | `NSO_scaleSelectedModel({ factor })` |
| **Longest** `[ ] mm` | unless a named field already shows the same number | `NSO_scaleSelectedModel({ axis: 'longest', targetMm })`, prefilled with the longest edge. Its done line's before figure is the solver's own `spanBeforeMm`, the edge it solved on, whichever axis that is |
| **Fit to plate** | always | `min(limit / size)` over the bed's three axes, from the same `nso_printer.js` fit the plate warning uses, applied as a uniform factor and stated. Already fits: says so, changes nothing |

Every field repopulates whenever the selection, the selected piece's soup or its
pose on the plate (Yaw, Tip, Roll, Lift, position) changes, whoever changed it:
while the card is open, a per-frame check on the piece, `rawTris` identity
(every bake replaces the array) and the placed entry's pose. A refused apply
leaves what was typed. At a 900 px-tall window the card ends at 436 px (the
tray, the most rows a box gets) with no scroll; the drive check measures it.

Paint scope: every verb is whole-piece and any paint stands it down, naming the
count (`NSO_scaleCardApply`, `NSO_scaleSelectedModel`). In the HANDOFF roster.

### Offset — `NSO_scaleOffsetRaw` (app-scale.js)

The outside moves by the mm entered (positive grows, negative shrinks) and the
wall is kept: every inner face moves the same way as the outer face across the
wall from it. A ring's bore moves with its outside; a tray's inner walls and
floor top follow its outer walls and bottom. The geometry is Thicken's own
vertex solve, `_thickenOffsetSoup`, with a new `wallKept` option: outer faces
(Thicken's own hull-and-crease classification) at +mm, inner faces at −mm, and
the planes round a vertex weighted by corner angle instead of area — the
area weighting leaned a 96-segment tube's walls 0.01 mm on a 0.5 mm offset, enough
that Extend no longer found them straight; the angle a quad contributes is 90°
however its diagonal falls. Without `wallKept`, Thicken is byte-for-byte what it
was (`wire:offset` §7 re-drives both buttons).

Refusals name the limit hit:

| limit | refusal |
|---|---|
| the floor | `its Z size of 25.00 mm would drop to 0.20 mm, under the 0.42 mm floor for a 0.4 mm nozzle - the most it can shrink is 12.29 mm` (checked before anything moves); or a measured section of the result under `NSO_Thickness.floorFor(nozzle)` where the piece was not already that thin; or a section folding flat |
| the bore closing | `the bore or pocket would close - 12 mm is more than the room inside it (8 inner face(s) would turn inside out)` |
| a feature on the outside | `0.5 mm is more than a feature on the outside has room for - 128 outer face(s) would turn inside out, the narrowest 0.12 mm across` — Thicken's own inversion gate, reached on a chamfer or a strip narrower than the shrink |
| crossing | Thicken's piercing check, `NSO_Repair.inspect` |

**A stepped piece is not thickened evenly.** Which faces count as inner is
Thicken's classification: on the convex hull (or a smooth crease from it) is
outer, everything else inner. A step's riser and the ledge below it sit inside
the hull, so they are inner and *follow* the outside instead of moving out.
`fixtures/lid_strap.stl` (a 2.4 mm plate with a 0.6 mm strap along one edge) at
Offset +0.5: the plate goes 2.4 → 3.4, the strap stays 0.6 and slides down with
the plate's underside, and the step deepens by 1.0. At −0.5: plate 1.4, strap
0.6. Closed, manifold, nothing thinner than it was (`box:test` §8 records it) —
but not "every face out by t". A tray's floor top is inner by the same rule,
which is what keeps its floor; the two cases are not told apart.

### Which axis is Length

Length / Width / Height are the piece's own raw axes **as it lies in its own
frame**: Height is its raw Z, Length the longer of its raw X and Y, Width the
shorter. They are not literally X / Y / Z (a bar stood on its end reads Length
along Y if Y is its longer side), and they do not follow the plate pose: Yaw /
Tip / Roll turn the placed instance, not the soup, so a Tip X re-reads the card
but leaves Height on the same raw Z. A ring's or rod's one axis row takes the
name its axis would get on a box (`NSO_sectionAxisWord`): standing on its axis
it is Height, lying on X or Y it is Length - or Width, for a disc on edge whose
axis is the shorter of X and Y. The readout (`· height 40.62`), Diameter's hold
(`height kept`), the Outer Ø / Diameter titles (`the height is held`) and the
ring verbs' done lines (`, height held`) say the same word.

## Ring verbs (part 2) — `nso_ring.js`

```
node tools/nso_ring_test.js            headless: every verb x fixture, against truth; canonical checker
node tools/nso_ring_drive_check.js     the real app: MINI_TPU_TEST from the Library, the Shrink fix
node tools/nso_ring_drive_check.js --shots DIR    also writes DIR/*.png (scratch; nothing committed)
```

The rule: a dimension edit moves boundary faces, never scales, and on a ring
the wall is kept unless the wall is what is being edited.

| field | faces that move | held |
|---|---|---|
| **Outer Ø** → d | outer walls by Δr = (d − outer)/2, bore walls by the same Δr | wall, length |
| **Bore Ø** → d (headless only since part 3; the card has no Bore row) | bore walls by Δr = (d − bore)/2 | outer, length |
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

**Precision is in float32 ULPs at the piece's magnitude.** Every apply stores
float32 once, so a round trip of two applies is within one ULP of the largest
coordinate: 9.5e-7 mm for `MINI_TPU_TEST` on the origin (the 1e-6 round trip
holds), 7.6e-6 mm for the same ring at plate position (90, 90). The ring test
holds its exactness checks to `max(1e-6, one ULP)` and runs the ring at
(90, 90) to prove it — Extend's `lengthUlps` rule, the same lesson.

**MINI_TPU_TEST.stl** (nest-library, Library → Test Fixtures) is a 48-gon — 48
points per outline, 96 wall triangles per surface. Its outer vertices sit at r
9.9995–10.0006 (mean 10.0000) and its bore vertices at r 9.0020–9.0030, so by
its own vertices the bore is Ø18.005 and the wall 0.998; the published Ø18 /
wall 1 hold to 0.01 mm and the readout's one decimal exactly. The checks read it
from the `nest-library` checkout (`tools/nso_library_dir.js`) and SKIP out loud
without one.

**The Shrink bug, closed (part 3).** Fatten's Shrink applied with no floor
check and un-rang `MINI_TPU_TEST` at 0.1 and 0.5 mm: its face filter plus
Thicken's area-weighted solve leaned the walls. The Finish menu's Fatten /
Shrink row is gone; the card shows no Offset on a ring, because Outer Ø and
Length do that job; and the Offset itself, at −0.1 and −0.5 mm on the same
ring, reads `Ring Ø19.8 / Ø17.8, wall 1.0, length 7.8` and `Ring Ø19.0 /
Ø17.0, wall 1.0, length 7.0` (`ring:drive` §2).

## Units on the card — mm | in

The toggle at the top of the card picks what the card shows and what is typed
into it. Display and entry only: `nso_section.js`, `nso_ring.js`,
`app-extend.js` and every other engine stay in millimetres, and the card
converts at its edge (`app-scale.js`, section 1c). Typing 1 with inches shown
hands the engine exactly 25.4 mm; switching the toggle moves no vertex and
pushes no Undo step. The choice is kept in `localStorage` (`nso.scale.unit`);
with storage unavailable the card comes up in mm.

With inches shown: the readout, every length box and its unit label,
aria-label, min, max and step (the 0.1 mm step becomes 0.005 in, and each
limit moves inward onto that grid: min 0.1 mm becomes 0.005 in, ±20 mm
±0.785 in, so a box's arrows land on whole steps), the
buttons' titles, and every message a Scale verb says. Inches show to 3 places;
a number the person typed is echoed as typed. Whole × is a factor and does not
change. The Cut, Move and Finish menus, the plate and the rest of the app stay
in mm.

Engine refusals arrive as finished mm sentences, so `NSO_scaleText` rewrites
their figures: a number or a run of them (`×`, `→`, `of`, `/`) ending in `mm`,
a bare `Ø` figure, and "number of / in / many mm". The card's own lines are
composed figure by figure (`NSO_scaleLen`). `NSO_sectionReadout` and
`NSO_ringDescribe` take an optional formatter for this; without one they say
what they always have.

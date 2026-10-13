# Bend — a pipe or plate bender

`nso_bend.js` (headless geometry) and `app-bend.js` (the panel), loaded after
`nso_section.js`. The arc itself is `NSO_PathSweep.sweepArc` in
`nso_path_sweep.js`, generalised for this ticket (below).

```
node tools/nso_bend_test.js          headless: six fixtures, every gate, every refusal, timing
node tools/nso_bend_drive_check.js   the real app: panel, ghost, marker, click, Bend, Undo, Cut, paint
```

Both are in `npm test` (`bend:test`, `bend:drive`).

## The promise

Extend's: **the cross-section is held exact.** A bend carries each section
rigidly round the arc, so a plate's thickness, a tube's bore and wall and a
rod's diameter do not change. Everything before the bend is copied through bit
for bit. Everything past it turns rigidly with the arc's end. Nothing is
scaled and nothing is smoothed.

## Where it works

Only inside **one clean constant-section band** — `NSO_extendBands`, Extend's
own band finder: a gap between two consecutive layers of vertices along the
axis that every crossing triangle crosses as a wall (`n·u = 0`). No vertex lies
inside a band, so the piece there is a pure extrusion: every plane across it
cuts the same section. The section is read where the bend goes and classed with
`NSO_sectionClassLoop` (nso_section.js's fit): a **rectangular** section folds
toward one of its four sides; anything else may also be **rolled** in 15° steps.

**The axis** is the piece's own, as it lies: the **longest of X, Y and Z that
has a clean band**. Not Extend's least-oblique pick, on purpose — every plate
that has been bent once has all its normals square to its width, so its
least-oblique axis is its width, always, and a second bend along its length
could never be asked for. Extend's detector still speaks when no axis has a
band, for the refusal: turned off X/Y/Z, curved all over, or no constant
stretch anywhere. When the only band runs across a shorter extent than the
piece's longest, its long direction is checked too, so a plate turned in its
own plane is told it is turned rather than offered a bend through its
thickness. Cardinal axes only, as Extend.

## The inputs

| input | meaning |
|---|---|
| **Where** | mm along the piece from its near (low) end — the **middle** of the bend zone, where a plate bender's mark goes. Also set by clicking the piece. |
| **Angle** | 1 to 180 degrees |
| **Radius** | mm to the section's **centre line**: the middle of its span in the bend direction. Blank: 2.5 × that span. |
| **Toward** | the side the far end folds toward — the piece's four sides (Up is its own +Z). For a section that is not a rectangle, also **Roll**, 15° steps about the axis. |

The near side stays where it is; the far side swings round. The zone is
`L = radius × angle` long, centred on Where.

## How

1. Every wall crossing the band is cut at the zone's two ends,
   `a = Where − L/2` and `b = Where + L/2`. The cut point of a crossing edge
   is a pure function of the edge and the plane: its axis coordinate is the
   plane exactly, the other two run along the edge (an edge parallel to the
   axis gives its own coordinates back, untouched).
2. Everything before `a` is copied; the crossing walls keep their piece
   before `a` (a triangle or a quad, fanned).
3. The zone is the section swept round the arc by `sweepArc`: **radial
   stations**, so every station *is* the section moved by a rotation about the
   bend axis.
4. Everything after `b` — the far triangles and the crossing walls' pieces
   after `b` — goes through `arcTail`: back `L` along the axis, then a turn of
   `angle` about the bend axis. Rigid.

**The splice needs no weld.** The piece before `a` and the arc's first ring
compute the same numbers (ring 0 *is* the start loops); the arc's last ring is
`arcTail` of the very points the piece after `b` is cut at.

**The section loops** come from the band's crossing triangles. Each crosses the
gap on exactly two edges — one walked from the far side to the near ("down"),
one back ("up") — and its segment of the section runs from its down edge's
point to its up edge's point. That is already `sweepArc`'s orientation
(material on the left about +u), because the triangle's outward normal is
`(q − p) × u`. A crossing edge is down for one triangle and up for its
neighbour, so the segments chain into closed loops by edge alone: outlines,
bores, non-convex outlines, several bodies.

**A wall's diagonal crosses the section at a different place on every plane.**
So point *j* of the section is not one fixed 2D point: station *i* takes the
straight blend of its two ends, which lies on the same wall. That keeps the
splice exact at both ends, and every station is still the section — the same
polygon, with its corners where they were and a few extra points on its edges.
It costs: each diagonal adds a section point (a plate's section is 8 points,
not 4), and the arc's triangles scale with that.

**Steps.** `NSO_PathSweep.arcSteps`: the chord between stations on the
outermost radius sags at most **0.02 mm** inside the true arc, *and* — added,
see Flags — each step loses at most **0.05%** of the volume between its two
stations (a chord slab holds `A ρ sin(step)` where the arc holds `A ρ step`).

## The gates, on the output buffer

Every one reads the soup that came out, not the construction.

| gate | measured |
|---|---|
| topology | open, non-manifold, inconsistently wound edges and zero-area faces may not rise (exact-bit weld; numeric, ~1 s for 1.2M triangles) |
| every station is the section | every stored ring point, read back in its station's frame, against the section point it was meant to be: ≤ 1e-4 mm (measured ≤ 4.1e-6) |
| the far part is rigid | every pair of consecutive far vertices keeps its distance through the transform to 1e-9 mm (float64), **and** every stored far coordinate is the nearest float32 to its rigid image |
| volume | the arc holds `A × centroid travel` within 0.1% (measured −0.036% to −0.049%) |
| an arm folded into the body | far-part triangles against near-part triangles, box-pruned, `NSO_Repair`'s triangle test; piercing or lying flat against counts |

## Refusals, in words, the piece unchanged

| what | says |
|---|---|
| no clean band at Where | `there is no straight stretch at 75.0 mm - the section changes there (a taper, a step or a feature). The nearest straight stretch runs 0.0–60.0 mm (60.0 mm long), 15.0 mm away.` |
| the zone does not fit | `the bend needs 11.8 mm of straight piece (7.50 mm radius × 90°), from -2.9 to 8.9 mm; the straight stretch at 3.0 mm runs 0.0–150.0 mm (150.0 mm long), and 0.1 mm of it must stay straight at each end. Move Where 3.0 mm, to 6.0 mm.` — or the nearest band that holds it, or, if none does, the longest band and the largest radius that would fit |
| radius under half the width | `a 1.50 mm radius is tighter than half the section's 3.00 mm width toward +Z - the inside face would turn inside out. The smallest radius that works is 1.51 mm (a 0.01 mm inside radius).` |
| past 2 million triangles | `the bent piece would have 3,900,000 triangles, past the 2,000,000 limit - the arc needs 37 steps round 50000 section points` |
| section not constant | `its section is not constant anywhere along X - it tapers or changes (knuckles, steps) all along, so there is no straight stretch to bend` |
| not X, Y or Z | `its straight axis is turned 30.0° off X, Y and Z - Bend works only along X, Y or Z. Turn the piece onto an axis first.` |
| …and a plate turned in its own plane, which is still a clean extrusion through its 3 mm thickness and nowhere else | `its length runs 30.0° off X, Y and Z - …` — read off the piece's long direction (exact second moments of its surface) when the only band is across a shorter extent and that direction is distinct; a short wide ring, whose only band is its length, is not called turned |
| curved | `it has no straight axis - it is curved or tapered all over (…% of its surface) …` |
| folded into itself | `folding 180° here would put the far arm through the piece before the bend (N crossing face pairs) - bend less, use a larger radius, or bend further from the end` |
| Roll on a rectangle, off the 15° steps; angle outside 1–180; Toward along the axis; Where off the piece | each by name |

**The radius limit, exactly.** At radius = half the width the inside face
reaches the bend axis and its triangles have no area; under it the face turns
inside out. The smallest radius accepted is half the width plus a **0.01 mm**
inside radius — a crease, not a bend, and still many float32 steps wide
anywhere on a plate — and the number the refusal names is rounded *up* to
0.01 mm, so it is one that bends (tested: 1.50 and 1.509 refused, 1.51 bends,
at 90° and at 180°).

**The margin.** 0.1 mm of straight band must stay on each side of the zone —
Extend's Shorten margin — so the walls either side do not become slivers no
later tool can read.

## Can a bent piece self-intersect?

**A plain constant-section piece: no, for any angle up to 180° and any radius
the limit accepts.** The arc lies between the plane where it starts and the
plane where it ends, both through the bend axis; the near part lies behind the
first and the far part beyond the second, so each meets the arc only at its own
ring. At 180° the two arms are parallel and `2R − w > 0` apart.

**A piece with something wider than the section — a tab, a flange, a boss — can
fold its far arm into its near arm.** A plate with a 12 mm tab under its far end,
folded flat downward at radius 4 (a 5 mm gap), puts the tab through the plate.
Bend checks for exactly that — far-part triangles against near-part triangles —
and refuses by name. The same fold at radius 9 (a 15 mm gap) bends. Only the
two outer parts are checked, because only they can meet; a self-intersection the
piece already had inside one arm is not Bend's business and is not counted.

## Numbers

From `tools/nso_bend_test.js` and the drive check.

| piece | in → out triangles | steps |
|---|---|---|
| plate 3 × 60 × 150, 90° | 12 → 492 | 29 |
| plate, 180° | 12 → 956 | 58 |
| round tube Ø16 / Ø12, 48 sides, 90° | 384 → 11,904 | 29 |
| round tube, 180° (radius 20) | 384 → 23,040 | 58 |
| rod Ø10, 48 sides, 90° / 180° | 192 → 5,952 / 11,520 | 29 / 58 |
| rectangular tube 20 × 12 × 2, 90° / 180° | 32 → 992 / 1,920 | 29 / 58 |

Every one of them: closed, 2-manifold, consistently wound, Euler unchanged;
every arc station and an arm station sliced out of the output
(`NSO_PathSweep.sectionLoops`) within 4.1e-6 mm of the section; the far part an
independent Rodrigues rotation of the input (float64 to ≤ 2e-14 mm; stored, the
nearest float32, distances within 1.1 ULP); volume within −0.049% of
`A × centroid travel`; the end faces at the requested angle to 1e-4°.

**Time** for a 100,096-triangle piece (a 64-sided rod with finely gridded end
caps), 90°: **330–700 ms** for `NSO_bendRaw` in Chromium (the first run warms
the JIT), **435 ms** for bend + commit + redraw; 706 ms headless under node's
`vm`. What costs is the section, not the piece: every section point is swept
round every step. A 4,000-sided tube (32k triangles) comes out at 1.25M
triangles in ~4 s headless; a 12,500-sided one (100k triangles) would be 3.9M
and is refused.

## The panel

**Bend** in Finish → Shape, in its own row straight under Extend. It opens a
small panel: Where, Angle, Radius, Toward (and Roll for a shaped section), a
readout, **Bend** and **Cancel**. While it is open:

- a **ghost** of the result sits on the piece, drawn as Crop's lifted ghost
  (amber, 0.75) and pulled a hair forward so it does not fight the piece. It is
  the very soup Bend would commit: every change runs `NSO_bendRaw`, and Bend
  commits that result. A refusal takes the ghost away and the readout says why,
  in red;
- a flat **marker** stands across the piece at Where, built as Cut's blade
  (#151): a thin translucent sheet and an amber frame, neither depth-tested,
  so it reads through the piece;
- a **click on the piece** sets Where to the point clicked along its length
  (captured ahead of select-and-drag, so the click does not move the piece).

Bend commits through `NSO_sculptCommitRaw` (undo type `bendReplace`): **one
Undo reverses the whole bend, bit for bit**, and the piece **re-seats on the
plate** the way any bake does. A bend that rises out of the plate's plane
leaves the piece standing up, and the status line says so with the numbers:
`... re-seated on the plate, it now stands 78.1 mm tall (was 3.0 mm)`.

Not here, on purpose: multi-bend recording, a drag handle, a stock generator.
A second bend is Bend again; it works on the straight band that is left (a
bend inside an earlier bend's arc is `no straight stretch at …`).

## PAINT SCOPE: WHOLE-PIECE

Per `docs/HANDOFF.md`: a bend moves every face past the zone and rebuilds every
wall the zone crosses, so no face can be promised untouched. Any paint stands
it down, naming the count (`nsoMaskCount(m) > 0`). In the HANDOFF roster and
`tools/nso_paint_scope_test.js`.

## `nso_path_sweep.js`, generalised

| new | what |
|---|---|
| `sweepArc(opts)` | a section carried rigidly round a circular arc: **any number of loops** (outlines and bores), **convex or not**, walls only. Ring 0 is the start loops themselves; ring n is `arcTail` of `loopsEnd`. Refuses loops wound the wrong way and a radius that turns the inside out. |
| `arcFrame`, `arcPoint`, `arcTail`, `arcSteps` | the arc's frame (cos/sin exact at quarter turns, so a 90° or 180° far arm lands exactly on an axis), a point on a station, the rigid tail, the step count |
| `sectionLoops(tris, point, normal)` | every loop of a slice — a tube's outline and bore. `sectionLoop` is unchanged on top of it (one loop or null). |

`sweep` (the mitred polyline) is untouched and still takes one convex profile:
its joint rings are stretched by `1/cos(turn/2)` (CURVING-PATH F4), which is
the opposite of this ticket's promise, so Bend does not use it. See
`docs/CURVING-PATH.md` §8.

## Flags — not in the ticket, or not as the ticket said

1. **"Tail vertices rigid to 1e-9"** holds in float64, before storage. The app
   stores float32, whose grid at 75 mm is 7.6e-6 mm, so no stored rotation by
   an arbitrary angle can be rigid to 1e-9 mm. What is gated and tested
   instead: every stored far coordinate is **the nearest float32 to its exact
   rigid image**, and stored distances agree within 1.1 ULP. At 90° and 180°
   the cos/sin are exact, and the measured change is 0.
2. **A volume rule on the step count**, beside the 0.02 mm sag rule. Sag alone
   lets a tight fold lose up to 0.4% of the arc's volume (a chord slab is short
   by step²/6); the cap holds it under 0.05%, so "volume = A × centroid travel
   within 0.1%" holds for the arc on its own, not only diluted over the piece.
   It roughly doubles the steps on small radii (the plate at 90°: 29 steps
   instead of 12).
3. **The axis** is the longest with a clean band, not Extend's least-oblique
   axis (above). Extend's detector still writes the refusals.
4. **Where is the middle of the zone**, the bender's mark.
5. **Two policy numbers**: the 0.01 mm inside radius at the radius limit and
   the 0.1 mm straight margin each side of the zone.
6. **One band, not a run.** The zone must fit one clean gap. A straight stretch
   tessellated with intermediate rings reads as several bands back to back
   (`nso_section.js` chains them into a run); Bend refuses across a ring,
   naming the band. Bending across rings is a generalisation of the same cut —
   every wall in the run is a wall — but it is not this ticket.
7. **"Centre line"** is the middle of the section's span in the bend direction,
   so the limit is exactly half the width; for a section whose centroid is not
   there (an angle iron), the volume check uses the centroid's own radius.
8. **Paint**: a roster row in `docs/HANDOFF.md` and the paint-scope suite, as
   every whole-piece bake has.
9. **The ghost needs the raw frame to match the view** (Crop's Move checks the
   same); if a piece was turned in place since it was loaded, the bend still
   works and the readout says the ghost is not drawn.
10. **"Next to Extend"** is the row under it: the Finish card is 176 px wide,
    and Extend's row already holds a button and a field.

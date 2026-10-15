# Tube edge — Flare and Roll on the open end of a tube

`nso_tube_edge.js` (headless geometry) and `app-tube-edge.js` (the card),
loaded after `app-bend.js` at `?v=tube1`.

```
node tools/nso_tube_edge_test.js          headless: every fixture, every gate, every refusal, timing
node tools/nso_tube_edge_drive_check.js   the real app: card, ghost, ring, click, Set, Undo, Cancel, paint
TUBE_EDGE_SHOTS=dir node tools/nso_tube_edge_drive_check.js   ...and screenshots of a flared and a rolled tube
```

Both are in `npm test` (`tube:edges`, `tube:edges-drive`).

The card's third verb, **Neck**, is `nso_tube_neck.js` (`?v=neck1`, loaded
after `nso_tube_edge.js`): see [Neck](#neck--a-pinch-or-a-bulge-along-a-tube)
at the end.

## The promise

Bend's, for the end of a tube: **the wall's section is carried exactly.**
Bend sweeps a section along a path; here the wall's section is swept round
the tube's own axis — a surface of revolution — along a meridian curve that
starts at the end ring. The wall's thickness through the new section is the
tube's wall, the new wall shares the end ring's edges (no weld, no lip, no
step), and everything but the end face is copied bit for bit.

| verb | what it does |
|---|---|
| **Flare** | the wall turns outward over a **Length**: **Straight** (a cone) or **Trumpet** (tangent to the tube at the ring, its radius growing as the square of the length — an ease-in — to the same lip) |
| **Roll** | the wall curls outward round a bead of a given **Radius**, through an **Angle**: 90, 180, 270 or any up to 360 |

Outward only. Inward refuses in words, for now.

## The end

The end is a **flat face bounded by two concentric circles** — an annulus,
the open end of a tube. Flat faces are found as caps are: edge-connected
triangles every vertex of which lies within 1e-4 mm of the seed's plane. Each
face's boundary loops are read with the section reader's own fit,
`NSO_sectionClassLoop` / `NSO_sectionFitCircle` (`nso_section.js`), so
"circular" means here exactly what it means to Scale's ring verbs and to Bend
(within max(0.05 mm, 1% of r)). That gives the centre, the outer radius, the
bore radius and, from the face's own normal, the axis — outward, the way the
new wall will grow. Any orientation: a tube along X is read as well as one
standing on Z.

`NSO_sectionRead` itself — the mid-length reader — is not what reads it: it
needs one section over 90% of the length, which a thrown vessel does not have,
and the end is what is being read. Its fit is.

**Which end.** A click on the piece picks the round end nearest the click (a
click on the outside wall 2 mm under an end picks that end). Before any click,
the round end standing highest. A face with **one** round loop is a closed end;
a face whose loops are not round is not circular; both refuse by name.

**The wall at the ring** is read off the triangles that meet it: their normals
give the wall's direction in the meridian (the half-plane through the axis). A
tube's wall runs along the axis; a thrown vessel's rim may lean (the default
Wheel vessel's leans −0.47°). The profile is laid in the wall's own frame:
**Length runs along the wall's direction at the ring, Angle and Δr are
measured from that line.** For a tube that is the axis and the plain reading.
The wall thickness is `t = rim width × cos(lean)`. Refused: a wall more than
30° off the axis at the end (that is a chamfer, a lip or a flange meeting it),
or two faces more than 5° apart (a taper has no one thickness to carry).

## The profiles

In the wall's frame at the ring, `(v, u)`: `u` along the wall, `v` its outward
normal, the outside face's ring point at the origin, the inside face's at
`(−t, …)`. One **reference curve** is laid on the outside face (the side of the
bend's centre, for an outward turn); the inside face is its **offset by t on
the convex side**. An offset away from the centre of curvature never cusps, and
the distance between a curve and that offset is `t` everywhere — so the wall
through the new section is the tube's wall, to the tessellation.

| profile | the outside face | the inside face |
|---|---|---|
| **Straight** | one cone line from the ring, `v = u·tanθ`, to `u = L` | round the crease on an arc of radius `t` (a round join), then the cone line's offset to `u = L` |
| **Trumpet** | `v = Δr·(u/L)²` — tangent to the wall at the ring | its offset, cut by the lip plane `u = L` |
| **Roll** | an arc of radius ρ round the bead centre `(ρ, 0)`, from the ring through the Angle | the concentric arc of radius ρ + t |

**The lip.** A flare's lip is cut square to the wall at `u = L`: flat across
the top for a tube standing on Z, `t / cos(lip angle)` wide. A roll's lip is
radial, square to the wall where it stops.

**Angle and Δr are one number** said two ways over the Length: `Δr = L·tanθ`.
Edit either on the card; the other follows; a new Length keeps whichever was
typed last. The Trumpet ends at the same lip — same Length, same Δr — and so
leaves at a steeper angle, `atan(2·tanθ)`: 49.1° for 8 mm at 30°, and the
readout says so.

**Steps.** Every curved face is cut so its chords sag at most **0.01 mm** (and
turn at most 10°): the inside arc of the round join on its radius t, the
trumpet's offset at its flattest (the lip, where its radius is largest), the
roll on the bead's outer radius ρ + t. Two faces each sagging 0.01 keep the
wall within 0.02 of t. The trumpet's stations are at equal turns of its
tangent, so its discrete curvature is monotone by construction.

## The build

Every vertex of the two end loops keeps **its own radial line**: station *i* of
the new wall is that vertex moved by `(Δr, Δh)` along its own radial direction
and the axis. **Station 0 is the loop** — the same float32 bits — so the new
wall shares the end ring's edges. The bands are walked in the order the end
face walked each loop, so each first band walks every ring edge the way the end
face did and the winding is the piece's own. The lip is zipped between the two
last rings by angle (the two loops need not have the same count or the same
angles — an imported part's need not). The end face is the only thing removed;
every other triangle is copied bit for bit.

## The gates, on the output buffer

| gate | measured |
|---|---|
| topology | open, non-manifold, inconsistently wound edges and zero-area faces may not rise, Euler unchanged (Bend's exact-bit counter, `NSO_bendTopology`) |
| the wall | every station of each face against the other face's polyline: `t ± 0.02 mm` (the nearest point being the other face's lip corner or ring point is skipped: there the lip, or the old wall, is what is nearest) |
| volume | the added volume against Pappus — `π∮r²dh` of the new meridian region times the end loop's polygon factor — within 0.5% (measured: equal to 1e-6 relative) |

## Refusals, in words, the piece unchanged

| what | says |
|---|---|
| closed end (a rod, a capped face) | `that end is closed - a flat Ø12.00 face with no opening. Flare and Roll work on the open end of a tube (a ring with a bore through it)` |
| a box | `that end is closed - a flat 4-sided face with no opening, not a circular ring. Flare and Roll work on the open, circular end of a tube.` |
| a square tube | `that end is not circular - its outline is a 4-sided polygon and its bore a 4-sided polygon. …` |
| inward | `an inward flare is not supported yet - Flare turns the wall outward only (toward the axis it would close the bore; that is a later ticket)` (and the same for Roll) |
| the thin-wall rule | `the wall is too thin to roll that far - pushing a 0.80 mm wall out from Ø19.20 to Ø24.80 (mid-wall) stretches it 1.29× round its hoop, which would thin it to 0.62 mm, under 2 nozzle widths (0.80 mm at a 0.4 mm nozzle). The rule: wall × (ring radius ÷ largest radius) must stay at or above 2 nozzle widths - this wall is too thin to push out at all` |
| touching | `rolling 330° would run the new wall into the piece (3.2 mm below the end, 10.0 mm from the axis) - it may come no closer than 0.40 mm (one nozzle width). At this radius it rolls up to 300°` |
| a flare too short to turn its inside face round the crease; past 75°; a roll past 360°; the end wall leaning or tapering | each by name |

### The thin-wall rule, stated

An outward turn takes the wall's material from the ring's mid-wall radius `r`
out to `R'`, the largest mid-wall radius in the new section, and stretches it
round its hoop by `R'/r`. Sheet that stretches thins in proportion: `t·r/R'`.
**Refused when that is under 2 nozzle widths** (0.80 mm at the default 0.4 mm
nozzle, `NSO_Thickness.NOZZLE_DEFAULT`). The refusal names the most the wall
can go out to, when there is one.

### Touching, stated

The new wall may come **no closer than one nozzle width** (0.40 mm) to the
piece it is made from, or to itself — nearer than that a slicer prints them as
one. Because the new wall is a surface of revolution, the distance from any
point X to it is a 2D distance in X's own meridian half-plane; that map is
1-Lipschitz, so a triangle of the piece is cleared from its centre with a bound
and split across its longest edge until it is cleared or small enough (0.01 mm)
to call. **The ring itself** is where the new wall must meet the old: within
2.5 nozzle widths (1.0 mm) of the end ring, the distance has `(1.0 − distance to
the ring)` added, so the old wall just under the ring reads about 1.0 mm while
everything further away — the tube's wall below a roll, a flange, the body of a
vase under a flared neck — is read as it is. A refused roll names the largest
angle that clears, found by bisection.

A flare cannot come back on itself: it climbs monotonically along the wall's
direction, so every level crosses it once. A roll can, past about 270°; its
outline is checked against itself (any two stretches more than `2(t + gap)`
apart along it).

## Numbers

From `tools/nso_tube_edge_test.js`; ms are `NSO_tubeEdgeRaw` under node's `vm`.

| piece and treatment | in → out triangles | ms | wall through the new section |
|---|---|---|---|
| Stock tube Ø20 / wall 1.6, flare 8 mm 30° straight | 768 → 1,728 | 60–80 | 1.594–1.600; lip r 14.619 (10 + 8·tan30 = 14.619) |
| …the same, trumpet | 768 → 6,720 | 60–70 | 1.599–1.600; lip r 14.619, 49.1° at the lip |
| …roll 180°, r 2.5 | 768 → 9,600 | 80 | 1.596–1.600; bead centre (12.500, 40.000), faces at r 2.500 and 4.100 |
| …roll 270°, r 2.5 | 768 → 13,824 | 90 | 1.596–1.600 |
| Wheel vessel (ball 60, opened), flare 6 mm 25° straight | 28,032 → 29,184 | 170–230 | 2.992–3.000 |
| …trumpet | 28,032 → 32,448 | 150–210 | 2.999–3.000 |
| …roll 180°, r 2 | 28,032 → 37,824 | 180–210 | 2.993–3.000 |
| Extend-made pipe (the Stock tube to 60 mm), roll 180° r 2 | 768 → 9,216 | | 1.596–1.600 |
| imported Ø16 / Ø12 48-gon along X, flare 6 mm 20° at its +X end | 384 → 768 | | 1.992–2.000 |
| 2000-sided Ø60 / wall 2 tube, roll 180° r 3 | 16,000 → 216,000 | 1,400–1,950 | |

Every one: closed, 2-manifold, consistently wound, Euler unchanged,
`tools/mesh_validate.py --gate` PASS with 0 piercing pairs, the rest of the
piece copied bit for bit, the added volume Pappus's. The test measures the
wall on the **output**, by code that shares nothing with the build: the
meridian at angle 0 walked out of the output mesh's own edges, each face's
points against the other face's polyline; and in 3D, from every new vertex on
twelve meridians to the nearest face of the wall's other side. The trumpet's
outside face has monotone curvature (0.1436 at the join down to 0.0480 at the
lip, per mm). A refused roll costs about 1.5 s: it bisects for the angle that
clears.

## The card

**Tube edge** in Finish → Shape, beside Bend in its row. It opens a small card
under Bend's: Verb (Flare / Roll), Way (Out / In), then Length, Angle, Δr and
Profile for a flare or Radius and Angle (90 / 180 / 270 offered, any typed) for
a roll, a readout, **Set** and **Cancel**. Blank fields take defaults from the
wall: Length 4 walls (at least 3 mm), Angle 30°, Radius 1.5 walls (at least
1 mm), roll Angle 180°. While it is open:

- a **ghost** of the result sits on the piece, drawn as Bend's (amber, 0.75).
  It is the very soup Set would commit; a refusal takes it away and the readout
  says why, in red;
- an amber **ring** — the end's two circles, not depth-tested — marks the end
  being treated;
- a **click on the piece** picks the end nearest the click (captured ahead of
  select-and-drag, so the click does not move the piece).

Set commits through `NSO_sculptCommitRaw` (undo type `tubeEdgeReplace`): **one
Undo reverses it, bit for bit**, and the piece re-seats on the plate the way
any bake does. Bend and Tube edge share the piece and the click, so opening
one shuts the other.

## PAINT SCOPE: WHOLE-PIECE

Per `docs/HANDOFF.md`: the end face is taken out, the wall rebuilt past it and
the whole piece re-seated, so no paint can be promised to land where it was.
Any paint stands it down, naming the count (`nsoMaskCount(m) > 0`). In the
HANDOFF roster and `tools/nso_paint_scope_test.js`.

## Flags — not in the ticket, or not as the ticket said

1. **The thin-wall rule is a hoop stretch**, `t·r/R' ≥ 2 nozzle widths`. The
   ticket said "a wall thinner than 2 nozzle widths after the treatment would
   stretch it" and left the stretch to be stated. The model itself keeps the
   wall at `t` — that is the promise — so this is a guard on what forming that
   shape would do to real sheet, not a measurement of the output. Consequence:
   a wall of exactly 2 nozzle widths (0.80 mm) cannot be pushed out at all, by
   any amount; the 270° / r 1 / 0.8 mm case is refused by this rule, and so
   would a 90° roll on that wall be. Bending stretch (the outside fibre of the
   curl, `(r + t)/(r + t/2)`) is not counted: multiplied in with the hoop
   stretch, it would refuse the ticket's own roll 180° r 2.5 on a 1.6 mm wall
   (1.6 / (1.72 × 1.24) = 0.75 mm).
2. **"Touch" is one nozzle width**, and the ring's own 1.0 mm is not checked
   for touching but for crossing the new wall's outline (see Touching). A
   foreign feature within 1 mm of the end ring is the one blind spot.
3. **Trumpet is a parabola**, `r = R + Δr·(u/L)²` — the quadratic ease-in.
   Tangent to the tube at the ring (G1), curvature greatest at the join and
   falling monotonically to the lip. Not G2: a clothoid (curvature growing
   from 0 at the join) was the other reading of "ease-in", and it cannot reach
   the ticket's own case — a clothoid tangent at the ring reaches at most
   `Δr/L = S(1)/C(1) = 0.562` (Fresnel) before its lip turns past flat, i.e.
   an equivalent angle of 29.3°, under the 30° of the test.
4. **"Same end values"** for Trumpet is read as the same Length and the same
   Δr (the same lip radius) as the cone; its lip angle is steeper and stated.
5. **Length is along the wall's direction at the ring**, and Angle / Δr from
   that line, so a leaning vessel rim flares relative to its own wall. For a
   tube that is the axis.
6. **The bead's Radius is its inside** — the radius the tube's outside face
   curls round — which is what puts the bead centre at `(R + r, z_end)`.
7. **Limits**: a flare up to 75°, a roll up to 360°, the end wall within 30°
   of the axis and its faces within 5° of each other. Each refusal names its
   number.
8. **Two test steps**, as Bend has: `tube:edges` (the ticket's list, plus an
   Extend pipe, an imported tube along X, a square tube, a rod and the limits)
   and `tube:edges-drive` (the card). Screenshots are written only when
   `TUBE_EDGE_SHOTS` is set, and are not kept in the repo.
9. **Beside Bend** is in Bend's row: the row is now a pair, Bend still the row
   straight after Extend (its drive check's claim).

## Neck — a pinch or a bulge along a tube

`nso_tube_neck.js` (headless) and the third verb on this card.

```
node tools/nso_tube_neck_test.js           headless: every fixture, every gate, every refusal (npm test: tube:neck)
TUBE_NECK_SHOTS=dir node tools/nso_tube_neck_shots.js   the real app: the card's Neck, Set, Undo, and screenshots
```

**Neck** moves the wall in (Δr < 0, a pinch) or out (Δr > 0, a bulge)
anywhere along the tube, not only at an end: a band of the given **Length**
centred where the tube is clicked (blank: the middle of the tube).

| profile | the mid-wall's meridian | the two faces |
|---|---|---|
| **Smooth** | `r = r_mid + Δr·(1 − cos 2πs/L)/2`: tangent to the tube at both ends of the band, Δr at its middle (the waist) | offsets of it, t/2 either side along its normal |
| **Funnel** | straight in to the waist, straight out | at each corner the face on the inside of the bend is sharp at K and the other goes round K on an arc of radius t, as bent sheet does |

**The wall is carried exactly.** Smooth's faces are offsets of one curve, so
the distance between them is t wherever the curve turns no tighter than t/2 —
refused otherwise ("too short to move a 1.60 mm wall by −6.00 mm … it needs
9.74 mm or more"). Funnel's sharp-corner-and-arc keeps t through every corner.
The waist's bore is the tube's bore + 2Δr across, its outside the outside +
2Δr. Gated on the meridian: t ± 0.02 mm.

**The axis** is read with Tube edge's own end reader (the highest open round
end): its fitted centre and its face normal. **The wall at the band** is read
off the mesh: every triangle the band crosses must be a piece of one of two
cylinders about that axis — normal square to the axis, all its vertices at one
radius (within 0.001 mm), the outside facing out and the bore facing in. That
gives Ro, Ri and t at the neck. Anything else across the band — a neck already
there, a taper, a flange — refuses, naming the stretch where the wall is not
straight and how far to move: **necks may not overlap** (bands that just meet
end to end are fine).

**The build.** On each face, the triangles the band crosses are taken out —
a band of the cylinder between two whole rings of its vertices (for a Stock
tube, its two end rings; after a neck, that neck's own ring). The lower ring's
vertices are carried up through the stations, each along its own radial line,
so the new face shares that ring's edges bit for bit; the last station is
zipped to the upper ring by angle. A straight station is laid at each end of
the band where the ring is further off. Everything else is copied bit for bit.
A wall whose triangles do not run in rings round the tube refuses in words.

**Gates on the output**: topology (Bend's counter: nothing opened, Euler
unchanged), the volume change against Pappus (π∫r²dh of each new face against
its straight wall, times its ring's polygon factor; measured equal to 1e-6),
the wall.

### Refusals, in words, the piece unchanged

| what | says |
|---|---|
| the pinch closes the bore | `a pinch of 9.00 mm would close the bore - the Ø16.80 bore would come to nothing at the waist, under the bore limit of Ø0.80 (2 nozzle widths at a 0.4 mm nozzle). This bore pinches by 8.00 mm at most` |
| overlap | `the wall is not straight from 14.00 to 26.00 mm in from the end, where this neck would go (6.00 to 18.00 mm) - a neck already there, or the piece's own shape. Necks may not overlap, and a neck is made on a straight stretch of tube: move it 4.00 mm or more along the tube, or shorten it` |
| past the end | `a 12.0 mm neck centred 3.00 mm in would run past the end of the tube (it is 40.00 mm long) - centre it at least 6.00 mm in from either end, or shorten it` |
| Smooth too short; Funnel past a 75° taper; Δr 0; no open round end to read the axis from (a rod) | each by name |

### Numbers

From `tools/nso_tube_neck_test.js` (99 checks); ms are `NSO_tubeNeckRaw` under node's `vm`.

| piece and neck | in → out triangles | ms | measured on the output |
|---|---|---|---|
| Stock tube Ø20 / wall 1.6, pinch −4 over 12, smooth | 768 → 25,728 | 65–120 | bore Ø8.800 at the waist; wall 1.598–1.600 (3D 1.597–1.600) |
| …expand +4 over 12, smooth | 768 → 25,728 | 55–70 | bore Ø24.800; wall 1.598–1.600 |
| …pinch −4 over 12, funnel | 768 → 4,992 | 13–18 | bore Ø8.800; wall 1.595–1.600; taper 36.137° |
| …expand +4 over 12, funnel | 768 → 4,992 | 11–13 | bore Ø24.800; wall 1.595–1.600 |
| …two pinches 10 mm apart (the second on the first's output) | 25,728 → 50,688 | | both waists Ø8.800; the first copied bit for bit |
| Wheel cup Ø30 / wall 2 (128 sides), pinch −3 over 14 | 1,024 → 17,920 | | bore Ø20.000; wall 1.995–2.000 |
| Extend-made pipe (60 mm), expand +3 over 12, funnel | 768 → 4,224 | | bore Ø22.800; wall 1.595–1.600 |
| imported Ø16 / Ø12 48-gon along X, pinch −2.5 over 16 | 384 → 6,720 | | bore Ø7.000; wall 1.998–2.000 |
| 2000-sided Ø60 / wall 2 tube, pinch −6 over 30 | 16,000 → 536,000 | ~600 | |

Every one: closed, 2-manifold, consistently wound, Euler unchanged,
`tools/mesh_validate.py --gate` PASS with 0 piercing pairs, everything outside
the band copied bit for bit, the volume change Pappus's.

### The card

Verb **Neck** shows Length, Δr and Profile (Smooth / Funnel) and hides Way
(Δr's sign is the way). Blank fields take defaults from the wall at the end:
Length 7.5 walls (12 mm on a 1.6 mm wall), Δr −2.5 walls (−4). A click on the
tube centres the band where it projects onto the axis. Two amber rings mark
the band's ends. A neck's ghost lies inside the piece wherever it pinches, so
while it is up **the piece itself is hidden** — the ghost is the whole result
— and shown again when the ghost goes (a refusal, Cancel, Set). Set commits
with undo type `tubeNeckReplace` ("Undo: Neck reverted"); several necks are
several Sets, each its own Undo. Paint stands it down, as Flare and Roll.

### Flags — not in the ticket, or not as the ticket said

1. **The ticket's "bore at the waist = 12.8" is not what a −4 radial pinch
   gives**: 16.8 − 2·4 = **8.8**. 12.8 is 16.8 − 4, the bore's *diameter*
   moved by 4. Δr here is a change of radius — it is Flare's Δr, and the
   ticket's own "pinch to −9 → refusal naming the bore limit" only refuses if
   it is (a diametral −9 leaves a Ø7.8 bore). The test checks Ø8.80 ± 0.05.
2. **"Two necks 10 mm apart"** is read as 10 mm of straight tube between the
   bands (necks centred at 9 and 31 mm, 12 mm long). Centred 10 mm apart,
   two 12 mm necks overlap by 2 mm and are refused.
3. **The bore limit is across**: the bore at the waist may be no narrower than
   2 nozzle widths in diameter (Ø0.80 at 0.4 mm). A bulge has no limit here
   (Flare's hoop-stretch rule is not applied: the model keeps t either way).
4. **A neck needs a straight stretch**: on a thrown vessel with a curved wall
   it refuses. The Wheel fixture is a straight-walled cup profile revolved by
   the Wheel's own revolve.
5. **Smooth is sampled at equal steps** of the band, halved until every chord
   of both faces sags under 0.01 mm: dense (64 steps for −4 over 12) but
   simple. Funnel is 4 straight runs and the corners' arcs.
6. **One test step**, `tube:neck`, as the ticket asked; the card is driven by
   `tube:neck-shots`, which is not in `npm test`.

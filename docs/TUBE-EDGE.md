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
| an inward flare closing the bore | `that flare would close the bore - the Ø16.80 bore would come to nothing at the lip, under the bore limit of Ø0.80 (2 nozzle widths at a 0.4 mm nozzle). Use a shorter or a shallower flare` |
| an inward roll | `an inward roll is not supported yet - Roll curls the wall outward only (into the bore is a later ticket)` |
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
radius (within max(0.02 mm, 2e-4 × R) of the face's mean radius R: a 0.4 mm
nozzle cannot lay down 20 µm; stated, not measured), the outside facing out and
the bore facing in. That gives Ro, Ri (the means) and t at the neck. Anything
else across the band — a neck already there, a taper, a flange — refuses,
naming the stretch where the wall is not straight, how much the outside and
bore vary across the band, and how far to move: **necks may not overlap**
(bands that just meet end to end are fine). A wall that is square to the axis
but not round within that (an oval) refuses with its spread, e.g. "its outside
varies by 0.18 mm across the band, Ø20.00 to Ø20.18".

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

## Walls, and the inward flare (tube-walls, 2026-10-20)

`nso_tube_edge.js` and `nso_tube_neck.js` at `?v=walls1`. The card reads a
`sel-te-walls` select when it has one (`NSO_teOpts`, Both when it has not);
the UI ticket draws it.

**WALLS** (`opts.walls`) on Flare and Neck: **Both** (`'both'`, the default)
is what every verb did before - the section carried, the wall's thickness
kept, and its output is byte-identical to before Walls (pinned SHA-1s from
claude-wip `b0697c1` in both tests). **Outside only** (`'outside'`) / **Bore
only** (`'bore'`) moves that one face by Δr and leaves the other exactly as it
was - its triangles bit for bit (gated as a set: no more, no fewer) - so the
wall's thickness changes through the section. Δr is a change of radius, as
everywhere in Tube edge.

- **Neck, one face, mid-tube**: the moved face follows the Profile itself
  (Smooth: the cosine; Funnel: straight to the waist and back). No section is
  carried, so no bend can fold it; how steep it stands is held to 75°.
- **Neck, one face, at an end - the socket and the spigot**: a band that
  reaches an end (centred inside the tube or on the end ring itself; Both
  still refuses it) is laid from that end, Length in, and the face is stepped
  all the way out to the end ring and back square at Length in. Bore out is
  a counterbore (a socket); outside in is a spigot. The end ring of the moved
  face is moved along its own radial lines and the end's flat ring is laid
  again between it and the end's other ring (whose vertices are kept bit for
  bit). An end that is closed (the Wheel cup's base) refuses in words.
- **Flare, one face**: the chosen face stands Δr off its own line at the lip
  (a cone or a trumpet), the other runs on along its own line to the same lip;
  the wall goes from t at the ring to t ∓ |Δr| at the lip. The lip rule is
  unchanged: square to the wall at u = L.
- **The floor**: a one-face move may not leave a wall under the nozzle-safety
  floor, `NSO_Thickness.floorFor(nozzle)` (0.42 mm at a 0.4 mm nozzle), nor
  carry one face through the other:
  `bore +4.80 mm would leave a 0.28 mm wall at the end; the floor is 0.42 mm (nso_thickness.js: one extrusion line at a 0.4 mm nozzle). This wall lets its bore move out by 4.65 mm at most`,
  `bore +6.00 mm would carry the bore through the other face of a 5.08 mm wall - the faces would cross. …`.
  With nso_thickness.js not loaded a one-face move refuses rather than guess.
- **Readout names the walls**:
  `Bore only: Ø30.47 → Ø33.47, outside kept Ø40.62, wall 5.08 → 3.58 · stepped 10.0 mm in from the end, square shoulder - a counterbore (wall 3.576–5.076 mm through it, floor 0.42)`.

**INWARD FLARE**: a negative Δr (or angle), or Way **In**, turns the flare
toward the axis, Straight and Trumpet. Both faces: the outward construction
mirrored across the mid-wall line, so the bore leads (the cone's crease, the
trumpet's curve) and stands exactly |Δr| in at the lip, and the outside goes
round it a wall away - wall held to 0.02 as outward. The bore at the lip may
come to no less than 2 nozzle widths across (Neck's waist rule). Roll In is
still refused.

### Flags — not in the ticket, or not as the ticket said

1. **"bore only +3 … wall reads 3.58"**: with Δr a radius (Flare's and Neck's
   since they shipped, and the UI ticket's "drag out 3 → bore Ø +6"), +3 on a
   5.08 wall leaves **2.08**; the ticket's readout line `Ø30.47 → Ø33.47, …
   wall 5.08 → 3.58` is a **+1.5** step (Ø +3). The test gates both: +3 reads
   2.08 measured off the output ring, +1.5 reproduces the ticket's line
   character for character.
2. **The floor is 0.42, not 0.8**: the ticket names nso_thickness.js's floor
   and quotes 0.8 in its example. `floorFor(0.4)` is 0.42 (one extrusion line);
   0.8 is 2 nozzle widths, Flare's hoop-stretch rule and the bore limit. The
   code uses `floorFor`, as the ticket's words say.
3. **At an end the shoulder is square, whatever the Profile**: "the result
   is a counterbore", and a counterbore's floor is square. Mid-tube the
   Profile shapes the moved face as before.
4. **The hoop-stretch rule does not apply to one face**: it guards forming a
   sheet of one thickness; a one-face move models the wall it leaves
   explicitly, and that wall is held to the floor.

## The card: Walls, and Flare's lip ring (tube-end-drag, 2026-10-20)

`app-tube-edge.js?v=enddrag1`. The card gains a **Walls** select (Both ·
Outside only · Bore only, `sel-te-walls`) under Way, shown for Flare and
Neck and hidden for Roll. Δr and Angle take negative values now (below 0 is
inward); Way In stays, and for a Flare it means the same as a negative Δr.

**Flare's handle, the LIP ring** (orange, Neck's waist colour), where the
moving face's lip will be, u = L out along the wall:
- drag it toward or away from the axis: **Δr** (through 0 and inward);
- drag it along the axis: **Length**; both at once, read on the plane through
  the axis that faces the camera (Neck's waist plane);
- 0.5 mm steps, 0.1 with Shift; **Left / Right** Δr ±1, **Up / Down** the
  Length ±1 (Up the way the axis runs up the screen), Shift 0.1; Escape puts
  a drag back, then shuts the card; no drag orbits the camera;
- a drag writes **Length and Δr** (Angle follows, linked) and sets Way back to
  Out: the sign is Δr's;
- the live ghost follows, as typing does; the fields stay editable.

**Where the handle sits**: with Bore only on the bore, with Outside only on
the outside; with Both, Flare's lip ring on the wall's mid-line. Neck's rings
follow Walls the same way: on the bore with Bore only. With Both they stay
on the outside, as #241 drew them (see the flag below). A one-face neck that
reaches an end is drawn where the engine lays it, from that end; its free
end ring sets the depth, and the ring on the end stays put. **Hover names the
face**: `Bore Δr +3.0 mm, Length 10.0 mm` (lip), `Wall Δr −5.0 mm` (a
neck's waist with Both).

Gates (`tools/nso_tube_neck_drag_check.js`, sections 8–10, in `tube:neck`):
- the lip ring dragged 4 mm in reads **Δr −4.0**, and the ghost's lip bore is
  **Ø8.80**, Ø 8 under the tube's Ø16.80;
- 6 mm along the axis gives **Length 6 → 12**, with the ghost's lip at z 52;
- Shift tenths, the arrows, and Escape mid-drag;
- Bore only on a Ø40.62 / Ø30.47 pipe: the ring sits on the bore, and 3 mm
  out makes the ghost's lip bore **Ø36.47** (Ø +6), its outside Ø40.62 at
  every vertex;
- Set commits the ghost's soup, and one Undo puts the pipe back;
- Neck Bore only: its rings sit on the bore.

Flag: the ticket says Both is "on the wall's mid-line (as Neck today)". Neck
today draws its waist on the **outside** (Ro + Δr), and #241's gates grab it
there. Neck with Both is left where it was; Flare with Both is on the
mid-line, as the ticket asks.

## Run — the reducer and the expander (tube-run, 2026-10-20)

`nso_tube_edge.js?v=run1`, `app-tube-edge.js?v=run1` (option plumbing only:
`NSO_teOpts` reads an `inp-te-run` field when the card has one, and passes
no run when it has not; the UI ticket draws it).

**RUN** (`opts.runMm`, Flare only) is a straight run of tube after the flare:
fat pipe → cone → skinny pipe (a **reducer**, Way In), or the reverse (an
**expander**, Way Out). **0 or blank is no run.** The output is then
byte-identical to before: the three pinned SHA-1s from `b0697c1` and four more
from `695808a` (inward, Trumpet inward, Bore only, Outside only Trumpet), each
with `runMm` left out, `0`, `''` and `null`.

- **The run's outside Ø and bore Ø are exactly the lip's.** It runs parallel
  to the axis for Run mm, measured along the axis from the lip's plane (from
  the lip's higher corner where a leaning rim tilts that plane: 0.03 mm on
  the Wheel vessel). Its end is cut square to the axis and left open, a flat
  ring like the tube's own end.
- **No weld, no step.** The run is one more station on each face: the lip
  ring's vertices carried straight up their own lines. The run shares the
  lip ring's edges, and the lip face moves to the run's end. The test checks
  that the end ring has the lip ring's x and y bits, vertex for vertex.
- **Its wall is the lip's width**, whatever the flare left there. With
  Outside only or Bore only that is the changed wall (5.08 → 2.08 runs on at
  2.08), and the face that did not move keeps its Ø through the run. With
  Both, the lip is cut square to the axis, so it is `t / cos(lip angle)` wide.
  A Straight flare at 33.7° on a 2.54 mm wall leaves a 3.05 mm run (see the
  flag below).
- **Trumpet + Run**: the trumpet's lip is not parallel to the axis. The run
  still is, so the join is a crease at the trumpet's lip angle (49.1° for
  8 mm at 30°). The readout says so: `· joined at 49.1°, the trumpet's lip
  angle (the run is parallel to the axis)`. Straight + Run is the reducer
  case, and the crease there is the cone's own angle.
- **Readout**: `Straight flare 21.0 mm at −36.0° inward, then 30.0 mm run at
  Ø21.84 / bore Ø15.56 · wall 2.54 held (2.532–2.540 mm through the flare;
  the run's wall 3.14, the lip's width) · Ø51.15 end`. With one face, the
  Walls line gains `, then 20.0 mm run at Ø40.62 / bore Ø36.47, wall 2.08`.
- **Checks**: the flare's own wall check reads the flare's stations alone.
  The clearance, the region, Pappus's volume and the build read the run too.

### Refusals, in words, the piece unchanged

| what | says |
|---|---|
| a run whose bore would be under 2 nozzle widths (the inward-flare limit; a run's bore is the lip's), before building | `that flare would close the bore - the Ø16.80 bore would come to Ø0.60 at the lip and down its 30.0 mm run, under the bore limit of Ø0.80 (2 nozzle widths at a 0.4 mm nozzle). Use a shorter or a shallower flare` |
| Run on a Roll | `a 10.0 mm run is refused on a Roll - a Roll has no lip direction to run along (the wall curls round its bead and stops where the Angle ends). Run is a Flare's: set it to 0 to roll` |
| a negative run | `enter a run length in mm, 0 or more (0: no run past the lip)` |
| the run meeting the piece (gated: a plate 20 mm over the end, Run 30; Run 10 stops 2 mm under it and builds) | the clearance's words, `that flare and its run would bring the new wall within 0.40 mm of the piece (20.0 mm out from the end, …) - …`, then `Use a shorter run, or a shorter or shallower flare` |

### Numbers

From `tools/nso_tube_edge_test.js` section 9 (242 checks in the file, 83 of
them new).

| piece and treatment | in → out triangles | measured on the output |
|---|---|---|
| Ø40 / wall 2.54 tube, reducer: Flare In −10 over 15, Run 30 | 768 → 2,304 | the last 30 mm one cylinder: outside Ø21.025, bore Ø14.920 (each to the float); wall 3.053; flare's wall 2.532–2.540 in 3D |
| …expander: Flare Out +10 over 15, Run 20 | 768 → 2,304 | outside Ø60.000, bore Ø53.895; wall 3.053 |
| Ø51.15 / 2.54 tube, −36° over 21, Run 30 | 768 → 2,304 | the ticket's readout line, character for character |
| Stock tube Ø20 / 1.6, Trumpet 8 mm 30°, Run 10 | 768 → 7,104 | Ø29.238 / Ø24.567; last chord 47.6° into the lip, then 0° up the run |
| Ø40.62 / Ø30.47 pipe, Bore only +3 over 10, Run 20 | 768 → 1,536 | outside Ø40.620 at every vertex, foot to run's end; run bore Ø36.468, wall 2.076 |
| …Outside only −3 over 10, Trumpet, Run 20 | 768 → 3,264 | bore Ø30.468 at every vertex; run outside Ø34.620 |
| Wheel vessel, flare 6 mm 25°, Run 8 | | parallel to the axis, the end square to it |
| imported Ø16 / Ø12 tube along X, flare 6 mm 20°, Run 12 | | the run along +X to x 98 |

Every output is closed, 2-manifold and consistently wound, with Euler
unchanged. Each passes `mesh_validate --gate` with 0 piercing pairs, copies
the rest of the piece bit for bit, and adds Pappus's volume.

### Flags — not in the ticket, or not as the ticket said

1. **The reducer's outside is Ø21.03, not Ø20.** The ticket's gate says "the
   last 30 mm reads as one cylinder Ø20 bore Ø14.92". In the same ticket, the
   run's Ø is "exactly the lip's", with no step. An inward Straight flare with
   Both leads with the bore, which stands exactly |Δr| in at the lip
   (Ø34.92 → Ø14.92, as the ticket says). The outside goes round the crease a
   wall away. The lip is cut square to the axis, so it is
   `t / cos θ = 2.54 / cos 33.69° = 3.053` wide, and the outside there is
   **Ø21.03**. Ø20 would need a wall of 2.54 measured across the axis. That is
   a different construction: a second bend at the end of the cone, with the
   outside going round a crease on the bore. It would move the run's start
   `t·tan(θ/2)` past the lip plane and change the flare itself when Run > 0.
   The ticket's own readout example (`Ø21.84 / bore Ø15.56 · wall 2.54`) is
   this file's construction: 3.14 = 2.54 / cos 36°. The test gates the bore
   at the ticket's Ø14.92, and the outside at the lip's Ø21.03 ± 0.02.
   The expander is the mirror case: its outside is the ticket's Ø60.00
   exactly, and its bore is Ø53.89.
2. **"Both keeps t"**: through the flare it does, and the readout's `wall 2.54
   held` is that wall. The run's wall is the lip's width, 3.05 above, and the
   readout names it (`the run's wall 3.05, the lip's width`).
3. **"along the wall's direction at the lip"** is read as the ticket's DO
   items say: along the axis. That applies on a leaning rim too, where
   Length is along the rim's wall. The run is a cylinder about the axis.
4. **The readout example's tube** is Ø51.15 / Ø46.07 (wall 2.54). On that
   tube −36° over 21 gives the line exactly. Outward runs read `… at 33.7°
   outward, then …`.

## The card: Run, and its END ring (tube-run-card, 2026-10-20)

`app-tube-edge.js?v=runcard1`. The card gains a **Run** field (mm, `inp-te-run`,
0 by default) right under Length, in the Flare rows. Roll and Neck hide it,
and a Roll is never handed a run. The live ghost is the engine's soup, so it
shows the run as soon as Run is over 0.

**The END ring** (amber, Neck's end-ring colour) sits at the run's far end:
Run along the axis past the lip ring, at the lip ring's radius (the face the
flare moves, the mid-line with Both; the run is at the lip's outside and
bore).
- The lip ring stays the flare's handle: Δr, and Length, which carries the
  run with it.
- Drag the END ring along the axis and that is the **Run**. It is read on
  the plane through the point taken hold of, as Neck's end rings are, and it
  stops at 0. **Hover**: `Run 30.0 mm`, with a resize cursor along the axis.
- 0.5 mm steps, 0.1 with Shift. Escape puts a drag back, then shuts the card.
  No drag orbits the camera, and Escape restores the Run field with the others.
- **Arrows**: Left / Right are Δr, as before. Up / Down step the **Run**
  while the END ring is the last handle under the pointer or in hand, and the
  Length otherwise (after the lip ring, or before either). Up goes the way
  the axis runs up the screen. 1 mm, 0.1 with Shift.
- At Run 0 there is no run's end and **no END ring**: a ring there would sit
  exactly on the lip ring, and a press on it could not say which one it
  meant. Type a Run to start one. An END ring dragged down to 0 stays in hand
  until the release, then goes.

Gates (`tools/nso_tube_neck_drag_check.js` section 11, in `tube:neck`), on
the Stock tube Ø20 / 1.6, Flare 8 mm Δr +3:
- the field is under Length, 0. Run 0's ghost ends at the lip, z 48, at
  Ø26.00 / Ø22.58, with no END ring;
- **Run 30**: the ghost's top is z 78. Its end ring has the lip's outside and
  bore (Run 0's, measured off the ghost), with no vertex between the lip and
  the end. The END ring is drawn at z 78 on the lip ring's radius;
- **the END ring dragged 10 mm along the axis**: the field reads **40.0**, the
  Length and Δr are untouched, the ghost's top is at z 88, the camera has not
  moved, and the lip ring is still the handle at the lip;
- **Set** commits the ghost's soup (`Tube edge done - Straight flare 8.0 mm at
  20.6° outward, then 40.0 mm run at Ø26.00 …`), and **one Undo** puts the
  tube back bit for bit;
- Up after hovering the END ring gives Run 41.0, Shift+Down 40.9, and a
  Shift drag of 2.34 mm adds 2.3. Escape mid-drag puts it back. Up after
  hovering the lip ring is the Length again;
- dragged down past the lip, the Run stops at 0.0: the END ring goes and the
  ghost ends at the lip;
- **Roll hides the field** and draws no END ring, and the roll rolls. Neck
  hides it too. Flare shows it again, with its Run.

`styles.css` is unchanged: the END ring uses the resize cursors Neck's end
rings already have.

## Reducer — the tube defined by its result (tube-reducer, 2026-10-20)

`nso_tube_edge.js?v=reducer1`. Engine only; the card is the next ticket.

**`NSO_TubeEdge.reducer(soup, end, { od2, id2, transitionMm, runMm, profile })`**
(also `NSO_tubeEdgeReducer`, and `NSO_tubeEdgeRaw` with `verb: 'reducer'`).
`end` is a reading from `NSO_tubeEdgeRead` (reused when it is this soup's), a
point `[x, y, z]` (the end nearest it), or `null` (the top end). It returns
Flare's contract: `{ ok, reason, tris, end, wall, run, meridian, volume, … }`
plus `reducer: { od1Mm, id1Mm, od2Mm, id2Mm, transitionMm, runMm, profile,
angleOuterDeg, angleBoreDeg, wallEndMm, kind, faces }`. On a refusal `tris`
is the original soup.

The end of the tube becomes a pipe of outside **od2** and bore **id2**. A
transition of **T** mm gets it there, then it runs straight on for **R** mm.
- **Each face is built directly**, from its own ring point to its own target:
  the outside from the tube's Ø1 to od2, the bore from its bore to id2.
  **Straight** makes each a cone. **Trumpet** makes each the ease-in, tangent
  to the tube at the ring, with Flare's trumpet sampling. Then both run
  parallel to the axis for R and end square to it, open.
- **The wall at the run is (od2 − id2) / 2 exactly.** Nothing is carried and
  there is no square-cut lip, so #253's lip width cannot appear. The test
  gates the ticket's case, Ø40/30 → Ø20/14 over 15, run 30: one cylinder,
  Ø20.000 / Ø14.000. On #253's own tube (Ø40 / wall 2.54) a reducer to
  Ø20 / Ø14.92 runs at Ø20.00 / Ø14.92 with a 2.54 wall, where Flare In −10
  still reads Ø21.03 (see flag 1).
- **The wall square to the faces is measured, not assumed.** Every station of
  each face, the ring points too, is checked against the other face's whole
  polyline. The thinnest is held to `nso_thickness.js`'s floor. Two faces
  that keep their distance across the axis are closer than that square to
  their slope: Ø40/30 → Ø60/50 over 10 is 5.00 across, 3.54 square to its
  45° faces. The readout adds the thinnest when it is under both ends' walls.
- **Kinds**: od2 > Ø1 is an **expander**, od2 < Ø1 a **reducer**. id2 at the
  tube's bore is today's **Outside only**, and od2 at its Ø is **Bore only**.
  A Ø within 1e-4 mm of the tube's own counts as unchanged: that face stays
  on its line. T 0 with both Ø unchanged and a run is a plain straight tube
  on (`Straight on: …`).
- **The angles are derived**, never typed. A Straight face's is atan(Δr / T);
  a Trumpet face's is where it ends, atan(2Δr / T).
- **Readout**: `Reducer: Ø43.52 / bore Ø34.82 → Ø33.26 / bore Ø26.38 over
  12.1 mm (23.0° outside, 19.2° bore), then 7.5 mm run · wall 4.35 → 3.44`
  (then `(3.25 at the thinnest, square to the transition's faces)`). The
  heading is `Expander`, or carries ` (outside only)` / ` (bore only)`.
  Trumpet reads `over 12.0 mm, trumpet (39.8° outside, 33.7° bore where it
  ends)`.

**Flare is the reducer's wrapper.** `NSO_tubeEdgeRaw({ verb: 'flare', … })` is
`NSO_tubeEdgeFlare`. It makes Flare's own refusals in Flare's words: Walls,
Length, angle or Δr, the 0° and 75° limits, and the one-face floor. It then
converts Way / Angle / Δr / Walls / Length / Run into od2 / id2 / T / R and
calls the reducer. **The Ø are where each face's lip always was**: the
face that moves stands Δr off its own line at u0 + Length in the wall's
frame, read back as a radius.
- **Walls: Outside only / Bore only** was always two faces built directly to
  one lip plane: the reducer's direct section, unchanged.
- **Walls: Both** is the reducer's **carried** section, which only Flare
  asks for. The face on the bend's side goes to its target by the profile.
  The other is its offset a wall away, going round the cone's crease on an
  arc of radius t. Both are cut square to the wall at u0 + T: **this is the
  old path's lip cut, reproduced exactly when R = 0**, and Flare's run comes
  off it as before. The other face ends where the offset meets that plane,
  not at a target of its own.
- **Byte for byte.** The Ø → wall-frame round trip can lose a radius's last
  bit: 3 of 34 hashes moved when the reducer read Δr back off the Ø. So the
  wrapper hands over the Δr it was given (`_exact`) with the Ø it made. The
  reducer checks that the two agree to 1e-6 mm and builds from the Δr, so
  the faces come from the very numbers Flare always built them from.
  **34 output SHA-1s from claude-wip `1c4a4b8`** are pinned: Both, Walls,
  inward, Way In, Trumpet, Run, the Wheel vessel's leaning rim, the tube along
  X, and four Rolls. Every one is unchanged. The test also shows that a typed
  reducer equals Flare's Walls through it vertex for vertex, within 1e-5 mm.
  That is not to the bit, because Ø36 typed is not the fitted bore's
  15.000000x + 3.

### Refusals, in words, the piece unchanged, nothing built

| what | says |
|---|---|
| the wall at the end (the run's) under the floor | `the wall at the end would be 0.30 mm (Ø20.00 outside, bore Ø19.40), and down its 10.0 mm run; the floor is 0.42 mm (nso_thickness.js: one extrusion line at a 0.4 mm nozzle). With this outside the bore may be Ø19.16 at most` |
| the wall under the floor in the transition (square to the faces) | `the wall would thin to 0.37 mm in the transition, 0.0 mm out from the end (measured square to its faces, at 68.2° outside and 68.2° bore); the floor is 0.42 mm (…). Use a longer transition` |
| od2 < id2 | `the faces would cross - the new outside Ø20.00 is inside the new bore Ø22.00; the outside must be larger than the bore` |
| od2 = id2 | `a new Ø20.00 with a bore of Ø20.00 leaves no wall - …` |
| T negative / R negative | `a transition of −2.0 mm is refused - …` / `a run of −5.0 mm is refused - …` |
| T 0 with a Ø changed (outside or bore) | `transition 0: use Scale's ring rows for a step - Ø40.00 / bore Ø30.00 → Ø20.00 / bore Ø14.00 with no length between them is a step, not a reducer. …` |
| T 0, R 0, both Ø the tube's | `nothing to make - …` |
| a bore under 2 nozzle widths | `that reducer would close the bore - a new bore of Ø0.60 is under the bore limit of Ø0.80 (2 nozzle widths at a 0.4 mm nozzle)` |
| the new wall meeting the piece | the clearance's words, `that reducer and its run would …`, then `Use a shorter run, or a smaller change of Ø` |

### Numbers

From `tools/nso_tube_edge_test.js` section 11 (326 checks in the file, 84 of
them new). Every output is closed, 2-manifold and consistently wound, with
Euler unchanged. Each passes `mesh_validate --gate`, copies the rest of the
piece bit for bit and adds Pappus's volume.

| piece and treatment | in → out | measured on the output |
|---|---|---|
| Ø40 / 30 pipe, reducer → Ø20 / 14 over 15, run 30 | 768 → 1,536 | run one cylinder Ø20.000 / Ø14.000, wall 3.000; cones −33.69° / −28.07° off the mesh; thinnest 2.65 square to the faces |
| …expander → Ø60 / 50 over 10, run 20 | 768 → 1,536 | Ø60.000 / Ø50.000, wall 5.00 (3.54 square to the 45° faces) |
| …bore only → Ø40 / 36 over 10, run 10 | 768 → 1,536 | outside untouched bit for bit; = Flare Bore only +3, run 10 within 1e-5 |
| …outside only, Trumpet → Ø34 / 30 | 768 → 3,264 | bore untouched; = Flare Outside only −3 Trumpet within 1e-5 |
| …Trumpet both faces → Ø30 / 22 over 12, run 10 | 768 → 6,144 | both faces tangent at the ring, monotone curvature; Ø30.000 / Ø22.000 |
| Ø43.52 / 34.82 → Ø33.26 / 26.38 over 12.1, run 7.5 | | the ticket's readout line (with 19.2°, flag 2) |
| Wheel vessel (rim leaning −0.47°), Ø −6 / bore −6 over 8, run 5 | | both targets reached to 1e-9 |

### Flags — not in the ticket, or not as the ticket said

1. **Flare + Run still reads the lip's width (Ø21.03 on #253's tube).**
   "Pinned hashes for every existing Flare case must still match with Run 0"
   would allow Flare with Both and R > 0 to switch to direct faces. That would
   make Flare's bore jump by `2t(1/cos θ − 1)` between Run 0 and Run 0.1, and
   it would break `tube:neck`'s gate that the run's end ring has Run 0's lip
   bore. So Flare's Both is carried at every Run, and the reducer is the fix:
   gated on the ticket's Ø40/30 case, and on #253's tube as a reducer. The
   card ticket replaces Flare on the card with the Reducer.
2. **The readout example's bore angle.** Ø34.82 → Ø26.38 over 12.1 is
   atan(4.22 / 12.1) = **19.2°**, not 21.4°. The outside's 23.0° and the walls
   4.35 → 3.44 match the ticket. The test gates the line with 19.2°.
3. **"Faces crossing" anywhere but the end cannot happen** once od2 > id2.
   With od1 > id1, each face's distance across the axis goes linearly
   (Straight) or with (s/T)² (Trumpet) from t1 > 0 to t2 > 0. So the crossing
   refusal is od2 < id2 (gated), od2 = id2 is its own words, and the wall
   square to the faces is held to the floor everywhere.
4. **The thin-wall (stretch) rule is Flare's**, for sheet turned outward. A
   reducer's walls are given, so it is held to the floor instead. Flare's 75°
   limit stays Flare's too. A steep reducer is caught by the floor square to
   its faces.
5. **Lean**: T runs along the wall's direction at the ring, as Length always
   did, and each face's target is a radius at the transition's end. On a
   leaning rim the face given its own Ø turns very slightly back to the axis
   rather than running on along the leaning wall.

## The card: Reducer (tube-reducer-card, 2026-10-20)

`app-tube-edge.js?v=reducercard1`, `styles.css?v=reducercard1`. The card's
first verb is now **Reducer** (Flare is gone from the card; the engine keeps
it as the reducer's wrapper). Roll and Neck are unchanged.

```
Verb        [Reducer ▾ | Roll | Neck]
New Ø       [47.52] mm      New bore  [38.82] mm
Transition  [10]    mm      Run       [0]     mm
Profile     [Straight ▾ | Trumpet]
readout · Set · Cancel
```

The card is 166 px wide, so each of the paired fields has its label over
it (`.te-pair`), two to a line. **Defaults**: New Ø = the end's Ø + 4 and New
bore = its bore + 4 (a wall-held 2 mm flare), Transition 10, Run 0. The Ø
fields default again whenever the end's Ø is not the one they were typed for:
another tube, or this one after a Set. Otherwise typed values are kept, as
before.

| removed | where its job went |
|---|---|
| Way | the sign of New Ø against the tube's Ø; the readout says `Reducer` / `Expander` (Way stays on the card for Roll only) |
| Angle | derived, in the readout, per face |
| Δr | New Ø |
| Walls | New Ø and New bore set apart: Both is the same change to both, and the readout shows the wall. Walls stays for Neck |
| Length | Transition |

**Handles** (#241's rules: on top, they own the pointer, no orbit, Escape
puts a drag back):
- **OD ring**: at the transition's end, on the new outside. Drag it toward
  or away from the axis for **New Ø**. The ring follows the pointer, so
  2.5 mm in is Ø −5.
- **ID ring**: in the same plane, on the new bore. Drag it the same way for
  **New bore**.
- **T ring**: the transition's end plane, outside both the tube and the new
  outside (radius + max(2 mm, 12%)). Drag it along the axis for
  **Transition**.
- **R ring**: at the run's far end, the same radius. Drag it along the axis
  for **Run**. It is shown while Run > 0. **With Run 0, Shift + a press on
  the T ring pulls a run out of it**: an R drag from the T plane, in 0.1 mm
  steps while Shift is held. With a run already, Shift on the T ring is just
  its 0.1 mm steps.
- Steps are 0.5 mm, 0.1 with Shift. **Arrows**: ↑ / ↓ step the length ring
  touched last (T before any, R only while it is up). ← / → step the Ø ring
  touched last (OD before any). 1 mm, 0.1 with Shift. Hover names the value
  in the readout (`New Ø38.52 mm`, `New bore Ø36.82 mm`,
  `Transition 16.1 mm`, `Run 17.5 mm`) and sets which ring the arrows step.

**The measure on the piece**, while a handle is in hand. It uses MEASURE's
chip (`.measure-label`), with amber edges (`.te-callout`, `#te-callout`).
- **OD / ID**: the chip reads `Ø38.52` on the ring, where it was taken hold
  of.
- **T / R**: a dimension line along the axis between the two planes, ticked
  at both. T runs from the end to the transition's end, R from there to the
  run's end. It sits just outside the length rings, on the side the ring was
  taken hold of, with the chip (`16.1 mm`) at its middle.
- It follows the handle and goes on the release (or on Escape, or when the
  card shuts). A hover shows the value in the readout only, never on the
  piece.

Gates: `tools/nso_tube_neck_drag_check.js` sections 8, 9 and 11, in
`tube:neck`. They replace the Flare lip-ring and END-ring sections.
`tools/nso_tube_edge_drive_check.js` sections 2, 3, 5 and 7 cover the
Reducer's fields, its refusals in the card, and Set / Undo.
- the defaults, and that ghost against Flare Out +2 over 10 (Both): the same
  outside vertex for vertex (to 1e-4) and the same lip Ø47.52. Its bore is
  Ø38.82 with the end's wall 4.35 exactly, where Flare's carried lip cut is
  Ø38.65 (flag 1 above);
- from 43.52 / 34.82 / 12.1 / 7.5: the OD ring in 2.5 gives **New Ø 38.52**,
  bore unchanged. The ID ring out 1 gives **36.82**, outside unchanged. The
  T ring +4 gives **Transition 16.1**, and the R ring +10 gives **Run 17.5**.
  Each one is read back off the fields and off the ghost's own vertices;
- the chip (`Ø38.52`, `Ø36.82`, `16.1 mm`, `17.5 mm`) is up mid-drag,
  within 3 px of its anchor. The dimension line's two heights are 0 → 16.1
  and 16.1 → 33.6. Both are gone after each release, and neither shows on a
  hover;
- the arrows and Shift tenths, Escape mid-drag, and Shift + the T ring at
  Run 0;
- Set (`Tube edge done - Reducer: …`) and one Undo, bit for bit. The ID ring
  alone on the Ø40.62 / Ø30.47 pipe gives `Expander (bore only): …`, then
  Set and one Undo;
- Roll shows Way and hides the Reducer's rows, Neck shows Walls, and the
  Reducer comes back with its Run and R ring. Neck's own sections, 1–7
  and 10, are unchanged.

Flags:
1. **"drag OD ring in 5 → New Ø 38.52"** is read as New Ø −5 from 43.52, with
   the ring following the pointer: a 2.5 mm move toward the axis. "Defaults →
   ghost matches Flare Out +2/2 wall-held" holds for the outside exactly. The
   bore is the reducer's Ø38.82, not Flare's carried cut, and the gate says
   by how much.
2. **The gates start from the card mock's numbers** (43.52 / 34.82 / 12.1 /
   7.5), typed on a Ø43.52 / Ø34.82 tube. There New Ø and bore are the
   tube's own: `Straight on`, until the OD ring moves.
3. **"Pull"** in the mock is the next tool's button under the card. It is
   unchanged.

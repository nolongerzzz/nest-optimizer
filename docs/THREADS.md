# Threads - tapped holes, pipe ends, and a rod / bolt / nut generator

One helical-thread engine, `nso_thread.js` (headless, no THREE, no boolean kernel; `npm run thread:test`), and three places
that use it:

| where | what |
|---|---|
| **SUBTRACT > Punch > Thread** | the hole is cut as a *tapped* thread (M2 to M30, G, NPT), single, grid or radial, through or blind |
| **Gen+ > Fittings** | a **threaded end for the selected tube** (male or female), **nipple, coupler, adapter, plug, screw cap**, and **threaded ends on the splitter's runs** |
| **Gen+ > Fasteners** | a threaded **rod**, a **bolt** (hex or socket head), a **nut**, and a bolt + nut set |

```
node tools/nso_thread_test.js              214 checks: every piece, rays through it, mesh_validate, closed forms
node tools/nso_punch_thread_test.js        threaded holes through the shipped boolean
node tools/nso_fittings_thread_test.js     the splitter's threaded ends and the tube's threaded end, on the Manifold kernel
node tools/nso_fasteners_drive_check.js    the real Fasteners card (and 9b in nso_punch_drive_check.js, 6b in nso_fittings_drive_check.js)
```
`npm run thread:test`, `punch:thread`, `fittings:thread`, `fasteners:drive`.

## The surface

A single-start thread is one function of two numbers: its radius at angle θ and height z is `f(s)`, `s = z − hand · P · θ / 2π`,
`f` periodic with the pitch `P`. `f` is a trapezoid - a crest flat at the major radius, two flanks at the thread's half-angle, a root
flat at the minor radius - so the whole surface is a grid of four helical rows (the profile's corners), `N` columns round. Column `N`
is column 0 one pitch up, so the grid closes on itself with **no seam and no T-junction**.

The grid is built a couple of turns longer than asked and **clipped to two flat planes in one pass**: each triangle becomes its part of
the slab, and a crossing point is made once per grid edge and shared by both its triangles (same bits, so the surface stays
watertight). The cut at a plane is a closed curve `r(θ)` - star-shaped about the axis - so it is closed with a fan from the axis (a
rod's end) or an annulus walked by angle to the bore (a nut's, a pipe's). A vertex within 0.3 µm of a plane is *moved onto it*: the
app welds at 1e-4 mm (`NSO_Repair.WELD_TOL`, `mesh_validate.py`), so a crossing closer than that to a vertex would be welded into it and
leave a sliver. Nothing is unioned, subtracted or repaired: **the mesh is closed, 2-manifold and wound outward as it is made.**

A piece is a stack of **segments** between planes, each with an outer surface (a circle, a regular polygon - a hex - or a thread) and
perhaps an inner one (a bore). Where two segments meet, the faces between their outer loops (and between their bores') close the step;
two loops that *cross* are refused (a step must be nested). That is what built the bolt (hex head, thread), the nut (hex outside,
thread bore), the nipple, the coupler, the sleeve.

## The fit

An **external** thread is the profile at its nominal size: a Ø8 bolt's crests are Ø8. An **internal** thread (a nut's bore, a socket, a
tapped hole's cutter) is the same profile with a radial **fit** added at crests and roots alike - **0.2 mm**, a printed thread loose enough
to turn. So **a bolt and a nut of one size, made here, turn on each other, and a hole made by Punch takes the bolt Fasteners makes**.
Measured, not asserted: across the nut's bore and the bolt, at points all round and every screw position, the least gap is the fit
(`nso_thread_test.js` §3; `nso_punch_thread_test.js` §2, which also shows a left-hand bolt does *not* fit; the Fasteners drive measures
it again on the two pieces it dropped).

| family | angle | crest / root flat | depth | sizes |
|---|---|---|---|---|
| metric | 60° | P/8 / P/6 | 0.6134 P | M2 to M30 coarse; M8x1 to M30x2 fine |
| whitworth (G, BSP parallel) | 55° | P/6 / P/6 | 0.6403 P | G1/8 to G2 |
| npt | 60° | P/10 / P/10 | 0.6928 P | NPT1/8 to NPT2, **tapered 1:16 on the diameter** |

A typed Ø and pitch (Fasteners) or `{ family, major, pitch }` (the API) is any other thread.

## Punch > Thread

`NSO_Punch.plan(soup, hit, { thread: 'M6' })` (or `{ size, hand, fit, major, pitch }`). The hole's Ø is the thread's: **major + 2 ×
fit**, the Ø at the crests of the cut, and the wall floors (`between holes`, `to the piece's edge`, `under a blind hole`) are measured from
it - `holes 1 and 2 would leave 0.3 mm between them; the floor is 0.8` for two M6 holes 6.7 apart. The cutter is `NSO_Thread.cutter`'s
threaded rod, built once per (thread, depth) and mapped onto each hole's axis by a half-turn rotation (`P0 + x·e1 − y·e2 − z·a`; a mirror
would flip the hand - `nso_punch_thread_test.js` 4g proves the hand survives a sideways face). Blind holes are flat-bottomed at the depth
and must be at least **two pitches** deep. A tapered (NPT) hole narrows with depth by 1/32 a side per mm. The card's Thread select shows
the thread's own Ø read-only in the Ø field and takes the ring handle away; PUNCH is still one boolean, one Undo.

## Fittings

Pick a kind from the tiles - **Cap**, **Tube end: male / female**, **2-way**, **3-way**, **Nipple**, **Coupler**, **Adapter**, **Plug**, **Screw
cap** - adjust, and **Add to plate**. The tiles, sliders and live preview work as Fasteners' do (below); what is particular to this card:

- **Tiles** are drawn from the generators (`nsoStockShelf.paint`): the Cap is a *generic* slip-on cap (it needs no tube to be drawn), the tube ends
  a sleeve with an amber tube going into it, the splitters tubes laid out as the splitter lays them, the rest `nso_thread.js`'s fittings at G1/2.
  **Trunk end** and **Branch ends** are three tiles each - plain, male, female.
- **Sliders** for every number: **Fit** and **Deep** (cap, tube end), **Ø**, **Wall**, **Branch Ø**, **Angle**, **Trunk**, **Branch** (splitter),
  **T length**, **T fit** (threads); Thread, Thread 2 and End are selects. Deep (0.75 x the tube's Ø, 8 to 30), Branch Ø (3/4 or 2/3 of the trunk's)
  and T length (about six pitches) *follow* what they depend on until moved. Rows a kind does not use are put away. **Ø from tube** copies the
  selected tube's Ø and wall.
- **The preview of a Cap or a Tube end reads the selected tube** (`NSO_Fittings.readTube`, the Tube-edge reader, cached per tube and end) and
  follows a change of selection. With **no tube selected it is a generic Ø20 x 2 tube's**, labelled so in the readout, and Add to plate is off
  (forced, it says `Select a tube: the cap is made for its end.`).
- **The splitter's preview is built on the boolean kernel** (about 0.2-0.5 s): its refusals are said *at once* without the kernel, a newer change
  supersedes an older build in flight (only the latest is shown), and Add to plate is off until the preview shown is the one the card now says.
  Add bakes *that very mesh* - not a rebuild.

- **Tube end: male / female.** Reads the selected tube's end the way Cap does, then `NSO_Thread.sleeve`: a socket that takes the tube (bore = its Ø +
  Fit, default 0.25; Deep as the cap's), a ledge for the tube to stop on, a hex collar, then a threaded spigot or socket with the flow bore through.
  A new piece, tube end down; the tube is not changed.
- **Nipple, coupler, adapter, plug, screw cap.** A hex collar with a thread at either or both ends. The flow bore leaves a wall's worth of
  ledge under every male root and female crest (a bore between a female thread's crests and roots would cut across it - refused in words).
- **The splitter's ends** (`trunkEnd` / `branchEnd`: plain, male, female; `trunkThread` / `branchThread`; `threadLen`, `fit`). *Male*: a
  threaded spigot added past the run's end, its bore the run's held under the root less a wall; the thread's **root must reach 0.8 mm
  into the run's wall** or the spigot would only touch it (refused with the bore that would work), and the thread must fit inside the run's
  outside. *Female*: the run's last `threadLen` mm becomes a socket - a boss round it where the run is too thin to leave a wall, the thread
  cut with the 0.2 fit, the flow bore stopping at its floor; where the thread's crests reach within two nozzle widths of the run's outside the cut
  takes the run's wall away, so the boss starts a **2 mm shoulder below the floor** to hold on (without it the boss floated free: 31 bodies); the run
  must be long enough to stop short of the hub, and neighbouring sockets must clear each other where they begin. Built with the same Manifold
  kernel as the rest of the splitter, so the same gates hold: one body, genus = openings - 1, Euler 4 - 2 x openings. A male trunk makes the
  splitter stand on its spigot; it is lifted so its lowest point is z = 0.

## Fasteners

Pick **Rod**, **Bolt**, **Nut** or **Bolt + nut** from the tiles, adjust, and **Add to plate**. (`npm run fasteners:drive`.) The preview ghost and the tile-art helpers are `app-piece-preview.js`, shared with the Fittings card.

- **Tiles** - the four kinds and the two head types (**Hex head**, **Socket head**) are pictures drawn from the generator's own meshes at M8 with
  the Stock shelf's painter (`nsoStockShelf.paint`), the first time the card opens: no image file is in the repo. A bolt is drawn head up (it prints
  head down); in Bolt + nut the nut is amber.
- **Sliders** - every number is a box + slider + read-out bound with `nsoLiveSlider`: **Ø**, **Pitch**, **Length** (rod / bolt), **Fit** and **Nut
  thick** (nut). Size and Hand are selects. Choosing a **Size** sets Ø, Pitch and the nut's thickness to its own and the sliders adjust from there;
  Ø or Pitch moved off the table makes a thread of its own, named by its numbers (`M7x1.5`, `Ø20.96x2`); an unchanged one is exactly the table's
  (G1/2 is 20.955, not the box's 20.96). The box takes a value past its slider's end. Rows that do not apply to the chosen kind are put away.
- **Live preview** - a translucent copy of what Add to plate would drop (a set shows both) stands on the plate where the drop would put it: beside
  the selection, then the nearest free spot (`nsoFittings.spotFor`, the drop's own two steps). It is rebuilt as any control moves (paced by the live
  slider), and is a helper in the scene - **not** a piece (not in `state.placed` or `state.modelGroup`, so it is not picked, packed, exported, or
  an Undo step). It shows only while Gen+ and the Fasteners menu are open. A choice that is refused clears it, says why in red, and turns Add to plate
  off.
- **Add to plate** bakes what the preview shows: one piece each (a set is two), selected, one Undo each; the preview then stands beside the new piece.
  `nsoFasteners.rod() / bolt() / nut() / set()` bake that kind with the card's numbers (what the old buttons did).

A bolt is a hex head (6 across-flats facets) or a socket cap (a cylinder with a hex socket open on the bed); a nut is hex or round. Head and nut
dimensions are ISO 4017 / 4032 / 4762 for M2 to M30 (a table in `nso_thread.js`); a typed Ø takes formulas (`1.5 D + 1` across flats). Bolts print
**head down on the bed**; rods stand on end.

## Refusals and notes, in words

`a 0.20 mm pitch is only 0.123 mm deep - under 0.5 of a 0.4 mm nozzle; it would not form. Use a pitch of at least 0.33 mm` ·
`a nut thinner than one pitch (1.25 mm) does not engage - make it at least 2.5 mm` ·
`a 9.0 across-flats nut leaves 0.30 mm of wall round a Ø8.40 thread - under the 0.42 mm floor; make it at least 9.3` ·
`a 1.5 mm deep thread is under two pitches (2.0 mm for M6) - it would not hold` ·
`the G3/4 male thread is Ø26.44 across - wider than the trunk's Ø20.00 outside; make it at least Ø26.9 or take a smaller thread`.
A pitch under **two nozzle widths** (M2 to M4 at 0.4) is *made*, with a note - `a 0.50 mm pitch is finer than a 0.4 mm nozzle
resolves well (0.80 mm and up prints cleanly) - expect a rough thread, and try it before relying on it` - not refused: it is a size people
do want, and it prints as a rough groove, not a hole that is shut.

## Flags - not in the ticket

- **Single-start only**, and every thread is **cut flat at its ends**: no chamfer or lead-in, no run-out, no unthreaded shank (a bolt is
  threaded the whole shank), no chamfered nut or head corners. A lead-in chamfer is the obvious next step and would help mating.
- **The flats are wider than the standards'** (the table above) so a nozzle can lay them; these are *printable* threads of the standard
  pitch and Ø, not gauged ones. **G is a parallel thread and seals with tape or a washer, not by the thread; NPT is tapered 1:16 but not
  gauged either** - tape it, and try it against a real fitting before trusting a seal.
- **The 0.2 mm fit is a starting point.** It is the same number everywhere, so the parts made here mate each other; against metal hardware
  or another printer it may want 0.1 to 0.3 (Fasteners' Fit, `T fit`; Punch's thread takes `fit` in the API).
- **Overhang.** A 60° thread's lower flank is 30° off the horizontal when it stands on end - at the edge of what a printer holds without
  support. 55° (G) is gentler. A coarser pitch prints better than a fine one at any size.
- **Phase.** A thread starts at z = 0 of its piece; turning a nut onto a bolt finds the screw position, and nothing is registered between
  two pieces.
- **Left-hand** is the Hand select (Fasteners) and `hand: 'left'` (Punch, Fittings API); the Fittings card has no left-hand control yet.
- **The splitter's threaded ends are G / NPT / metric of any size that fits** - it says when one does not and what would; they are not
  checked against a plate (like the rest of Fittings).

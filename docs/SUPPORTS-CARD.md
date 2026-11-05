# Supports card: a verb with a state

`app-supports-card.js`, the column's **Supports** drop-down (make/edit group,
after Seat). One card on the main page. G-scope keeps its support row for
layer-view work (`docs/GCODE-SUPPORTS.md`); both call the same planner.

```
npm run support:workflow    tools/nso_support_workflow_drive_check.mjs, headless Chromium at 1280 x 800
npm run support:custom      tools/nso_support_custom_drive_check.mjs - Auto / Assisted / Custom (section 6)
```

`support:card` (`tools/nso_support_card_drive_check.mjs`) drives the previous
card - All / None, region badges, dots - and is superseded by `support:workflow`.
It is out of `testSteps`; the file stays until someone deletes it.

**Supports Blockers** (ghost boxes no support is made in) and **Slice and Preview** (the card's last button) are in
[SUPPORT-BLOCKERS.md](SUPPORT-BLOCKERS.md).

No dots on the mesh. Each **hanging area** - one region of the beacon grid
(`docs/SUPPORT-BEACONS.md`) - is outlined faintly on the surface: the edge of
the surface its spots hold, traced on the piece (`region.footprint`,
`docs/SUPPORT-FOOTPRINT.md`) - not the edges of the grid cells the spots were
found in, which at a rim are mostly air. An outline, not a grid.
It is drawn through the piece (an overhang's underside is rarely the face in
view) and a click is read against the outline along the ray (the ray meets the
plane of one of the area's spots, inside the loops), so an underside area can be
clicked from above. A spot the footprint does not hold (a crease, a tip, a side
spot, one placed by hand) keeps its cell.

## 0. Detect first

Opening **Supports** - or selecting a piece while it is open - runs detection
at once, on the selected piece (the only piece on the plate, when nothing is
selected). Every hanging area is outlined and the card says **"N hanging areas
at 35&deg; on &lt;piece&gt;"**. The angle is a field on the card
(`#sup-angle`, 1..89, default 35, labelled **"35&deg; &middot; Bambu 30&deg;"**);
typing re-detects once the typing pauses. It is a setting, like Style: not an
Undo step. Nothing is generated.

**What the number means.** Faces within this many degrees of horizontal get
support (`nso_support_aim.js`: a face hangs when `n.z < -cos(angle)`, its tilt
off the plate under the angle). The field's tooltip says so. Bambu Studio's
`support_threshold_angle` is measured the same way, so the label names Bambu's
default, 30, beside the card's number for comparison - it is not a conversion.
The default is 35, a hair more sensitive than Bambu's 30 (owner's call). See
0a for the correction that set it.

The areas are editable before GENERATE, on the mesh, where the effect shows:

- **a click on an outline** leaves that area out (it dims) or puts it back;
- **Shift-click on the piece** adds a spot - one beacon, outlined like the rest
  (an area of its own, or part of the nearest one).

## 0a. The angle is from horizontal: 60 was not Bambu's 30 (2026-10-21)

The card shipped defaulting to 60, labelled "60&deg; &middot; Bambu 30&deg;", on
the belief that Bambu measures its threshold from vertical (90 - 60 = 30). It
does not. Measured on `fixtures/supports/simple_overhang.3mf` (the Simple
Overhang Test: an arc whose underside steps 10, 20 ... 80&deg; off horizontal,
each step 20 mm wide), sliced by the owner in Bambu Studio 02.08.02.61, tree
slim, threshold 30: Bambu supported only the arc's underside within 30&deg; of
horizontal - **z 41.4 - 46.2, 254 mm&sup2;** (its support transition and
interface layers run z 41.4 - 46.2) - and printed the **40 - 60&deg; stretch
(175 mm&sup2;)** as overhang walls, with no support.

NSO's angle already meant "faces within N&deg; of horizontal", so Bambu's 30 is
NSO's 30, and the old 60 asked for supports Bambu leaves out. On the same
file (`support:test` section 13):

| angle | flagged faces (triangle pass) | area | z | hanging areas (spots) |
| --- | --- | --- | --- | --- |
| **35 (default)** | the 10, 20 and 30&deg; steps, 6 triangles | **259.06 mm&sup2;** (+2.0 % on Bambu's 254) | 37.74 - 46.47 | 3 (40 + 1 + 1 = 42) |
| 30 (Bambu's) | the same | 259.06 mm&sup2; | 37.74 - 46.47 | 3 (42) |
| 60 (old default) | the 10 - 40&deg; steps, 7 triangles | 301.88 mm&sup2; | 32.23 - 46.47 | 2 (70 + 1 = 71) |

At 35 the arc's area is its top only: 40 spots at z 38.0 - 46.3, every one on a
10 - 30&deg; face. The two single spots beside it are side spots on ridges at z
17.7 (27.5 and 28.8&deg;), off the arc; they are there at 30 too. At 60 the arc's
area reaches down it to z 17.7, its 40 - 60&deg; faces as `gap` and `edge` spots
(15 gap spots at 40 - 60&deg;), plus one spot at z 8.6: 71 spots against 42, the
area's plan 630 mm&sup2; against 360. The triangle pass gains only half of the
40&deg; step at 60: the rays down from the rest of the 40 - 60&deg; faces land on
the model's 2 mm base, so it counts them self-supported, and the beacon grid -
what the card plans from - flags them as `gap` spots instead. So the extra
surface at 60 shows in the grid, 1.7 times the spots, not in the triangle area.

What changes elsewhere: a 45&deg; chamfer (`support:test` section 11's band) is
steeper than 35 and is no longer detected at the default; on the standing clamp
the default finds 262 spots in 4 areas (344 at 60), on the wedge 326 in 10 (427
in 25). The top_clip_x2 coupon and top_clip_x2 detect the same at 35 as at 60.

## 1. The three states

| state | the card says | what is live |
| --- | --- | --- |
| **IDLE** (a piece is picked) | **"N hanging areas at 35&deg; on &lt;piece&gt;"** (`&middot; K left out` once any is) | **GENERATE**; Angle, Style, Size, "May rest on the part" (off); a click on an outlined area leaves it out (grey) or puts it back. Nothing builds on a click. |
| **BUILDING** (GENERATE pressed) | one **bar** under the readout, 0 to 100 % over the whole build, and the phase in words: **"Planning 142 / 344 &middot; 21 %"**, then **"Building 41 / 436 &middot; 55 %"** (section 1a) | every control is locked, **REGENERATE** and **REMOVE ALL** (shown once built) are off; **Escape** cancels |
| **BUILT** | **"Built: M supports &middot; held H &middot; unsupported K &middot; unreachable U"** | **REGENERATE** (replaces every support on the piece) and **REMOVE ALL** beside it; a click on a built support picks it and **REMOVE** takes that one; areas the plate could not reach stay outlined **red**; a row under the readout for every area that is not held |

**Every area is exactly one of the three**, so H + K + U is the number of areas:
*held* - every spot in it is held from the plate or rests on the part;
*unreachable* - the last build tried it and the plate could not reach at least
one spot (never counted held) - and an area the last build held IN PART gives
the spots it could not reach an area of their own, numbered after the rest, so
the part it held reads held and the lost spots are outlined, counted and framed
where they are (the arc of `fixtures/supports/simple_overhang.3mf`: 67 spots
held, its top among them, and "Area 3 &middot; unreachable &middot; no route to
the plate &middot; 3 spots" at its foot; docs/SUPPORT-INTERFACE.md section 7); *unsupported* - left out, or the planner gave it
nothing, or a Remove took a support off it. The rows list the areas that are not
held ("Area 3 &middot; unreachable &middot; no route to the plate &middot; 4 spots"); a click on a row **frames the area**
(the camera keeps its direction and comes in on it). A piece with no beacons at
all shows **"Nothing hangs in air. Tall-and-thin sway isn't checked yet."** and
GENERATE is off. The card's readout is the one place it speaks: the HUD's green
build tag (`#adjust-status`) is not drawn while the card is open, and
`#status` no longer repeats the line.

### 1a. The bar

While a build runs, the readout (`#sup-count`) says where it is and **one bar**
(`#sup-progress`, a `role="progressbar"`) fills under it. The bottom-right status
(`#status`) says the same words, and is cleared when the build ends. The
spinner is gone.

The build goes **phase by phase, every area through a phase before the next
begins**, so the phase word only moves forward:

| phase | the readout | the count |
| --- | --- | --- |
| detecting | **"Detecting &middot; 0 s"** | none |
| planning | **"Planning 142 / 344 &middot; 21 %"** | beacons settled / beacons, summed over every area: the bar's first half |
| building | **"Building 41 / 436 &middot; 55 %"** | the interface sheet's tips settled, then trunks swept (`NSO_SupportGridpack.buildUnits`), summed over every area: the bar's second half |

There is **no welding**: the parts come back as shells (`NSO_SupportGridpack.shells`,
section "Why the watchdog needs a worker"). The count is the phase's own; the
**percent is the whole build's** (`PHASE_SPAN`: planning fills 0-50 %, building
50-100 %, measured on the standing clamp at 3.4 s and 3.1 s), so the bar only ever
moves forward, the nearest whole number, and **100 only when the work is done**
(1999 of 2000 reads 99). **No count is ever invented**: a phase with none
(detecting) shows its word and the seconds on a bar that only sweeps. A planner
that says nothing at all (`setPlanner`'s) gets **"Building&hellip;"**, with the
seconds once past 10, on a sweeping bar, as before.

Building moves from its first second: the sheet is planned before the first trunk
is swept (on the clamp's big area, 78 % of its building time), and its tips are
counted as the level's footprint is read and its gap holds. Before, building sat
at 0 through all of it and only the trunks were counted.

The card believes only what makes sense: a phase never goes back (each area's
planner opens with its own *detecting*, which is dropped once the build is past
it), a count never goes down, and one below 0, past its total or past its area's
share is dropped, not clamped. `NSO_SUPPORTS_CARD.onProgress(fn)` hears every
message the card keeps, `{ phase, done, total, percent, line, ms, sent }`
(`sent` is when the worker posted it, `ms` when the page took it up: a frame of
the 3D view can hold the page's thread a while); `NSO_SUPPORTS_CARD.progress()`
is what the bar shows now. The planner's side of the contract is in
`docs/SUPPORT-GRIDPACK.md` ("Progress").

**REGENERATE and REMOVE ALL stay off while the bar is live** (so does REMOVE,
and every control on the card). **Escape cancels** the build
(`NSO_SUPPORTS_CARD.cancel()` does the same): the worker is terminated, the
plate is exactly as it was, Undo has nothing new, the supports already standing
stay, and the card says **"Build cancelled - nothing was added"**. A worker
message that arrives late finishes into nothing: a dead build does not touch
the plate.

### A build ends in a state

BUILDING always finishes: as BUILT, as **"Build cancelled - nothing was
added"** (Escape), or as **"Could not build: &lt;reason&gt; - nothing was
added"** - a planner refusal, an exception, or the **watchdog**, when the bar
turns into that message. **The watchdog is silence, not time**: every progress
message the planner posts starts it again, and it fires only when nothing has
come for 60 s ("the planner was still working after 60 s";
`NSO_SUPPORTS_CARD.watchdogMs(ms)` sets it). A build that is still reporting is
not hung, however long it takes - up to the **ceiling**, 10 min
(`NSO_SUPPORTS_CARD.ceilingMs(ms)`), where a runaway is stopped however it
reports ("the build was still running after 10 min"). On any failure the plate is exactly as before, **Undo has nothing
new**, the old supports (if any) still stand and the card is live again. The
plate is touched in one synchronous stretch at the very end, only if the build is
still live, and everything is put back if anything in it throws.

**Why the watchdog needs a worker.** `planTree` is one synchronous call, and a
thread that is inside it cannot repaint, count seconds or fire a timer. The
card therefore plans in a Web Worker that loads the same engine files
(`nso_thickness`, `nso_support_beacons`, `nso_support_aim`, `nso_path_sweep`,
`nso_support_tree`, `nso_support_gridpack`, and for the interface sheet
`nso_raster_lines`, `nso_crosshatch`, `nso_support_interface`); the watchdog and
Escape on the page call `terminate()` on it. The worker plans every area, then
builds each (`NSO_SupportGridpack.parts` with `PARTS_OPTS`, `{ interface: true,
foldSheets: false, footPads: 'shared' }`: every tip that meets the part widens
to a flat cap under a sheet of 2 interface layers, 0.18 mm under the part, no
transition layer - docs/SUPPORT-INTERFACE.md; every trunk on its own foot) and
hands it back as **shells** (`NSO_SupportGridpack.shells`): every part its own
closed shell, with the sheet over its tips. When the build is put on the
plate (the generate's `commit()`), the page draws the feet once over every
area (`shareFeet` in `app-supports-card.js`, calling
`NSO_SupportGridpack.shareFeet`): one first-layer pad per cluster of feet within
6 mm, and every support that stands on one pad is one plate piece, whatever
area it holds (its keys, holds and regions unioned) - two supports' first
layers never overlap, which Bambu Studio reported as a path conflict on the
2026-10-20 print. A failure there refuses the commit with its reason.
**Nothing is welded.** A slicer fills an object's overlapping shells as one
(Bambu Studio; NSO's own `nso_slicer.js` fills every section with the Positive
rule), and `support:shells` cuts both at every 0.2 mm layer and holds them to
two microns. The weld was 16 s of the clamp's 23 s; nothing on the plate needs a
support to be one shell (Crop, Join, Subtract and the other booleans merge a
piece's shells for themselves, `nsoOverlap`; Findings names overlapping shells
as such). The worker posts `{ phase, done, total }` as it goes, and is stopped
when that is done. The piece's mesh is sent to it **once** per build:
every area is planned against the same array, whose spatial index the planner
then finds again (a fresh copy per area was indexed afresh each time, about 0.4 s
of the wedge's 49k triangles, 25 times over). A page that cannot start a
worker does the same work in-thread, giving itself a turn every 250 ms
(`SLICE_MS`: repaint, the clock, Escape; a turn costs a frame of the 3D view, so
it is not made oftener), and can only be held to the clocks after the fact.
`NSO_SUPPORTS_CARD.setPlanner(fn)` replaces the planner (a test seam; its
`opts.onProgress` is the bar's).

Every state change is **one Undo**: leaving an area out or putting it back, a
manual spot, GENERATE / REGENERATE (the supports it adds and the ones it
replaces), REMOVE, REMOVE ALL. (A `supportSwap` step; its `onUndone` puts the
card's own record of the piece back: the edits, the spots a build could not
reach, whether it was built.)

### What each control did before, and what does it now

| before | now |
| --- | --- |
| **All** - built every region, replacing the piece's supports | **GENERATE**; once built, **REGENERATE** (same replace) |
| **None** - took every support off and dropped the piece's manual, painted and skipped spots | **REMOVE ALL** - takes every support off and returns the card to IDLE. The piece's edits (areas left out, manual and painted spots) are kept; each is its own Undo |
| a region's **count badge**, or one of its **dots** - built that region alone, or took its supports off | **a click on an outlined area** - leaves it out / puts it back. Builds nothing, removes nothing; the next GENERATE / REGENERATE uses it |
| **Remove** - took off the one selected support | unchanged: click a built support, **REMOVE** (shown in BUILT) |
| **Paint** + Hold / Skip - always on the card, then a collapsed "Paint spots" row | gone: a click on an outline leaves an area out, Shift-click adds a spot, both on the mesh. Not replaced: *Skip* took spots out of the middle of an area, and *Hold* added a whole row of spots in one drag |
| shift-click - a manual spot | unchanged |
| Style · Size · May rest on the part | unchanged, under GENERATE; locked while building |
| the "N held · M resting · K unreachable" readout line, and the HUD's own build messages | the state line (and the HUD with it) |
| the spot dots (white / green / amber / red) and the count badges | gone; the outlines carry the state |

## 2. What it calls

- **Detection**: `NSO_SupportAim.detectOverhangs` on the piece's world soup
  (Z up, mm), with the painted faces as `skipList` and the other pieces as
  `occluders`, exactly as G-scope's row. The card reads `det.beacons` and
  `det.beaconRegions`.
- **Planning**: `NSO_SupportTree.planTree` with `opts.beacons`, one call per
  region, then `NSO_SupportGridpack.solid`. Nothing is aimed or built in this
  file.
- **Pieces**: every solid the planner hands back lands as its own plate piece
  (`addModelFromZUpGeometry` + `placeModelMovable`), read back off the scene
  before it is kept, labelled `m.nsoSupport = { card: true, hostSourceId,
  regionId, keys, holds, landing, style, sideMm, rest }`. Supports stay
  separate pieces, so the Pieces list, the app's Remove and the export treat
  them like any other.

## 3. The two engine hooks

Nothing else in the planner changed.

1. **An explicit beacon list.** `planTree(rawTris, { beacons })` plans the
   list it is given: the detected set with the manual and painted edits
   applied. Each entry is the planner's `{ p, n }` or a detector record
   `{ x, y, z, normal }`, and may carry `regionId` and `key`; both ride
   through to `plan.beacons`. Detection still runs for the plate, without its
   beacon grid (`nso_support_gridpack.js`, `beaconsFor`).
2. **Supports carry a region id.** Every `plan.trunks[i]` carries `regionIds`,
   and every `solid(plan).solids[i]` carries `beacons` (ids), `regionIds` and
   `landing` (`'plate'`, `'rest'` or `'mixed'`). The card copies them onto the
   support's label, so "this region's supports" and "this support" are
   lookups, never a geometry test.

G-scope's row leaves card supports alone: its `supportsFor(host, region)`
skips `meta.card`, because the card numbers regions on the beacon grid and
G-scope on its triangle regions. Both see every support as a support (never a
host to scan).

`app-core.js`: a `supportSwap` Undo entry now runs its `onUndone`, as
`featureSwap` already did, so the card's record of a piece (its edits, the
spots a build could not reach) goes back with the step.

## 4. Measured (`support:workflow`)

**At the default 35&deg; (since 0a, 2026-10-21, on the cloud box):** the tilted
box reads "1 hanging area at 35&deg; on tilted" with "35&deg; &middot; Bambu 30&deg;"
beside the field; 25&deg; finds nothing, 60&deg; finds the area again (label "60&deg;
&middot; Bambu 30&deg;"), 95&deg; is refused and the angle stays 60, then back to 35.
The wedge opens with **10 hanging areas, 326 spots** (25 areas and 427 spots at
60&deg;, pinned); GENERATE over all 10 builds 7 supports, "held 10 &middot;
unsupported 0 &middot; unreachable 0", in 19.6 s. The standing clamp opens with 4
areas, 262 spots (344 at 60&deg;). The paragraphs below were measured at the
defaults of their day (45&deg;, then 60&deg;).

On support:beacons' tilted box (40 x 30 x 10, underside at 30 deg): opening the
card detects at once, "1 hanging area at 45&deg; on tilted", 120 spots in 1 area,
outlined once (44 edge segments of the 12 x 10 cells). At 25&deg; nothing hangs
(the underside is at 30&deg;); at 35&deg; the area is back; 95&deg; is refused in
words. GENERATE (Tree, 1.2 mm) builds 70 supports in about 1 s: "Built: 70
supports &middot; held 1 &middot; unsupported 0 &middot; unreachable 0".
REGENERATE: no old support survives, as many new; Undo puts the old pieces back.
REMOVE takes exactly the clicked one (69, "held 0 &middot; unsupported 1", a row for the
area). REMOVE ALL back to IDLE; Undo back to BUILT. A shift-click on the wall:
"2 hanging areas". Beside a block with a tunnel through it (the tunnel's ceiling
hangs over its own floor): 2 areas; GENERATE gives "held 1 &middot; unsupported 0 &middot;
unreachable 1", that area outlined red with one row; a click on the row frames
it; leaving it out afterwards gives "held 1 &middot; unsupported 1 &middot; unreachable 0".

**Every build ends in a state.** A planner that throws, one that throws at once,
one that refuses, and one that never answers each end as "Could not build:
&lt;why&gt; - nothing was added" with the plate and Undo as before; the one that never
answers is stopped at 60 s (59.5-64 s asserted), the readout counting from
"Building&hellip; 10 s". The real planner builds again straight after.

**The wedge, `library/v9_mirror_factory.stl`** (187 x 21 x 34 mm, 49,026
triangles): opening Supports detects in 1.6 s, 395 spots in **13 hanging areas**
(5 at 30&deg;); the biggest, the slab's underside, holds 377 of the spots.
Planning that one area takes **289 s** in the page's own thread (in Node: 22 s
for 10 spots, 46 s for 20, 95 s for 40 - a steady ~2.3 s a spot, none of it
unreachable): 60% of it is `windingAt` in `nso_support_aim.js`, the inside-the-mesh
test, which walks every triangle on every probe. Before the worker the build
simply froze the page: the spinner, the count and any timer stopped with the
thread, and nothing could end it. Now GENERATE over all 13 ends at the watchdog
("Could not build: the planner was still working after 15 s - nothing was added",
15.8 s with the watchdog set to 15), and with the big underside left out the
other 12 areas build in 18 s: "Built: 12 supports &middot; held 12 &middot; unsupported 1 &middot;
unreachable 0", one row (Area 1, left out, 377 spots).

**Progress on the wedge** (`support:workflow` sections 9 and 10, headless Chromium
with software GL): Generate over all 25 areas is **11.9 s** (20-25 s with the
weld), 36 supports, **907 updates**: *detecting* once, *planning* 0 to 427 / 427
(the bar's first half), *building* to n / n (the second half); no welding.
Planning reaches 50 % before building begins and building's n / n = 100 % is the
last message, every frame's status line equals its readout, and every frame's bar
is filled to its readout's percent or sweeping with no value. Between the
planner's own messages (by the time the worker posted them) the median gap is
0 ms and the largest about 590 ms, 3 of about 1009 over 250 ms. Escape in the
middle of planning on the real worker: terminated, nothing after it, the plate
and Undo as before.

**The clamp** (`support:workflow` section 11, `fixtures/supports/clamp_body.stl`
standing): **7.6 s** (23-27 s with the weld), planning 3.5 s over 345 counts,
building 3.0 s over 437 (436 units: 238 sheet tips, 198 trunks), the bar to
100 %. **The watchdog** (section 12): a planner that posts every 5 s for 90 s
ends with its own answer; one that says nothing is stopped at 60 s; one that
reports forever is stopped at the ceiling.

## 5. Flags

- The outline is the surface's own edge (`docs/SUPPORT-FOOTPRINT.md`), to 0.01 mm on
  a plane; it used to follow the beacon grid's cells and pass the face by up to a
  whole cell. The card asks the detector for it and for the spots to stand 1 mm
  in from it (`beaconInsetMm`), and the build for the sheet and its caps to stay
  under the part (`sheetPerimeter`). An area a build split draws the first part's
  whole outline and the rest in cells.
- An area is a region of the beacon grid. A manual spot too far from any area
  starts one of its own. A left-out area is remembered by the position of one
  of its spots, in the piece's own frame, so it follows the piece when it moves.
- Leaving an area out after a build changes the line but not the plate: its
  supports stay until REGENERATE. (It then counts as unsupported.)
- An area is "held" only when every spot in it is; one support removed by hand
  makes it unsupported until REGENERATE. An area the last build held in part
  and could not reach in part is split: its lost spots are an area of their
  own (unreachable), the rest is held - until the next build or REMOVE ALL. A detected spot is named by where it is
  (`d<x>,<y>,<z>`), not by its place in the list, so the supports already
  standing still find their spots when the angle changes the detected set.
- The whole-piece build is only as fast as the planner: a piece with a very
  large overhang (the wedge's 377-spot underside, 289 s) does not build inside
  the 60 s watchdog and says so. The fix is in the engine (a spatial index for
  the inside test in `nso_support_aim.js`), not here; leave the area out, or
  raise `NSO_SUPPORTS_CARD.watchdogMs()`, until then. No planner in this tree has
  a per-spot time-based give-up, so there is none to cap.
- **No weld.** A card support is its parts as overlapping closed shells, one
  plate piece per group of trunks that stand on one pad, across areas. Findings reads such a piece
  as overlapping shells (a slicer fills the overlap; Merge shells makes them one
  solid on the piece). The welded build was no cleaner: the clamp's area 1 was
  one shell with 6809 piercing pairs inside it.
- The bar's cadence is the planner's: it beats every 200 ms between its units,
  but not inside the first detect of a piece or the feet's raster. The kickoff asked for
  250 ms or better; on the wedge all but a handful of the planning and building
  gaps meet it.
- Each page turn costs a rendered frame of the 3D view, which is slow in software
  GL (about 100 ms in the test browser). Measured on the wedge with the trunks
  still swept on the page: a 40 ms slice took 47 s, 100 ms took 39 s, 200 ms 33 s,
  and no turns at all 25 s. That is why the slice is 250 ms, and why the sweeping
  moved to the worker.
- One plate piece per solid: a strut on the tilted box is 120 pieces, a tree
  70. That is what lets REMOVE take one; the Pieces list grows with it.
- Areas are planned one at a time, each against the piece and the other
  pieces, not against each other's supports (as G-scope's row).
- A support records the piece it holds by id. Move the piece after building
  and the supports stay where they were; the card shows the new areas.
- The app's own Remove deletes the model with the plate entry, and its Undo
  puts back the entry only (pre-existing, every piece).

## 6. Auto, Assisted, Custom (supports-custom-ui)

```
npm run support:custom    tools/nso_support_custom_drive_check.mjs (79 checks)
```

A three-way switch at the top of the card chooses what the planner is fed
(`opts.feed`, `docs/SUPPORT-GRIDPACK.md` section 7). The switch is a setting, like
the angle: not an Undo step. Everything above this section is **Auto**, unchanged -
Auto sends no feed at all (`support:custom` 1 reads the worker's message), and
`support:workflow` is its proof.

| | what shows on the piece | a click | feed sent |
| --- | --- | --- | --- |
| **Auto** | the outlined areas | an outline leaves the area out / puts it back; Shift-click adds a spot | none |
| **Assisted** | the detected spots, as points drawn over the piece | a point turns that spot off (grey) or back on; Shift-click adds a spot as in Auto | `mode: 'assisted'`, `beaconsOff`, `landingZones`, `excluded` |
| **Custom** | no spots: only the tips you place | the underside places a tip (a face that looks up is refused by name); a tip takes it away | `mode: 'custom'`, `tips`, `landingZones`, `excluded` |

Assisted and Custom have no outlined areas (the areas are Auto's): a left-out
area stays recorded on the piece and comes back in Auto. The readout counts
what the planner will be given: "120 spots at 35&deg; on box &middot; 1 off &middot; 1 circle", "3 tips
on box", "No tips yet on box". Once built, "Built: M supports &middot; held H &middot; unsupported K &middot;
unreachable U" as in every mode; a spot that is off is not a tip and is in none of
the counts.

### The tools: one holds the pointer at a time

Under the switch, in the two fed modes, a row of three: **Tips**, **Circles**,
**Erase**. Tips is on by default and is the points on the piece. The other two are
switches you start and stop (press again, or Escape): a tool's claim on the
pointer ends when it is stopped, so the view orbits again (`pick:release`'s
Supports row). That is the point of the split - **orbit to a good view first,
then start Circles and draw from it**, then stop it to orbit.

- **Markers own the pointer, like the rotate rings.** The points, the circles and
  the eraser's light draw over everything (render order 900, depth test off), are
  scene helpers that no ray can hit (`nso-helpers.js`), and are hit-tested by the
  card on the press: a press on a point is not a press on the piece (it does not
  select or move it). A press on nothing of theirs falls through to the view.
- **Circles** (landing zones, on the plate - `landingZones`): with it on, a drag on
  bare plate draws a circle (centre where the drag began, radius to where it ends;
  under 1.5 mm it is a click and draws nothing), a drag on its edge resizes it, a
  drag inside moves it, a click selects it (yellow) and Delete removes it. Each is
  one Undo step. Off the plate a drag is the view's. The ray meets the plane through
  the pieces, so a circle can be drawn under one. A circle nothing landed in after a
  build turns red (`plan.zonesEmpty`, empty in every area planned).
- **Erase** (after a build, Assisted and Custom): off until there is a build with
  members. Hovering a built tip, branch or trunk lights it and everything it holds up
  (the members whose `carries` are among its own and that sit above it: a tip, a
  branch, a trunk; the sheet and the pads are never targets - the planner does not
  erase those alone) - and **nothing is said anywhere**: no list, no readout, the
  card's text and the status line do not change. A click puts its id in `excluded` and
  the plan is made again: every support on the piece is replaced, one Undo step; a
  build that cannot finish leaves the member where it was. The member is drawn from
  its `from` / `to` ends, a straight line (a bent branch is lit straight).

### The brush and the raft (supports-footprint, section 10 of docs/SUPPORT-FOOTPRINT.md)

Two additions that work in every mode, Auto included:

- **Paint** (a row under the switch: Paint, a brush diameter in mm, Clear paint): the brush holds the pointer while it is on (press again, or Escape, to orbit),
  and a drag **over the picked piece** paints (the brush takes the first face along the pointer's ray, through the piece if need be, that the card calls hanging at its
  angle - so a stroke over the top of the piece, seen from above, paints the underside the outline shows through it); a press that meets no such face is the view's. Each stroke is one Undo step, kept as an op of the piece's edits
  (`m.nsoSupportEdits`, `{ op: 'paint', id, r, pts }`, in the piece's frame: it rides along when the piece moves). What a stroke asks for: a spot every 2 mm along it
  on the faces that do not look up (a spot joins the area of the nearest one as a manual spot does, or starts an area; in Custom they are tips), and the cells the
  brush covered that no detected footprint holds become a footprint of their own for the raft, laid to the brush's edge. A detected footprint it went over keeps
  its plate to its edge (`marginMm` 0.02 for 0.1). The painted dots draw over the piece (translucent, the brush's size). Clear paint takes all off, one Undo.
  `card.paintStroke([{ p, n }], r)`, `card.paint(on)`, `card.clearPaint()`, `card.paintCount()` are the page's own calls (tests, a script).
- **Raft interface** (a checkbox, on): the interface and the transition laid from each footprint and its height, layer by layer - the region plate. Off, the sheet is
  built from the tips alone, as it was before the region plate.

### What survives, what forgets

Tips, spots turned off, circles and erasures are the piece's own (`model.nsoSupportFeed`:
tips and off-spots in the piece's frame, circles in the plate's) and outlive a
REGENERATE - the same members come back. **REMOVE ALL (the card's reset) and CLEAR
PLATE forget them**; REMOVE ALL is one Undo step that puts them back. Spots added
with Shift-click and areas left out are `nsoSupportEdits`, as before, and stay.

### Known edges

- The eraser's ids hash the member's path in the plate's frame: move the piece and
  the ids are new ones, so earlier erasures no longer name anything.
- The interface sheet adds its own carrier trunks (built by `parts()`, not in
  `plan.trunks`); with circles drawn, a few of those can stand a pad's width or so
  outside a circle (2 of 192 trunks, 1.7 mm, on the tilted box with one 19 mm circle).
  The planner's own trunks are held to the zone (support:feed).
- Switching mode with supports standing leaves them standing; their spots read
  against the new mode's list until REGENERATE.

## 7. Tune: the planner's four knobs, in Custom (supports-custom-card)

UI only (`app-supports-card.js`, `index.html`, `styles.css`). The feed's `knobs`
(`docs/SUPPORT-GRIDPACK.md` section 7, supports-knobs-1) get a place on the card: a
collapsed **Tune** section under *May rest on the part*, **Custom only**. Auto and
Assisted are as they were (no section, no knobs in their feeds).

| field (id) | knob | default | unit |
| --- | --- | --- | --- |
| Trunk top (`sup-knob-tip`) | `trunkTipMm` | 2 | mm |
| Trunk growth (`sup-knob-growth`) | `trunkAngleDeg` | 5.5 | deg |
| Lean limit (`sup-knob-lean`) | `leanDeg` | 30 | deg |
| Node spacing (`sup-knob-node`) | `nodeMm` | 5 | mm |

They are the card's own `vp-bend-field` rows, the style of Angle and Size. The
heading counts the fields that are not at their default ("2 changed").

- **REGENERATE is the Set button.** Typing builds nothing: the field is read at once
  (`tune()`), and the card says the build is **stale** if it no longer matches what
  the standing build was made with (`mem.builtKnobs`, kept with `built` and put back
  by Undo): the readout dims and ends "out of date: Tune has changed", REGENERATE is
  outlined, the section's note says so, `#supports-card[data-stale]` is `1`.
  GENERATE/REGENERATE sends the values. Stale is "differs from the build", not "differs
  from the default": typing a value and then back, or DEFAULTS after a default build,
  is not stale.
- **Absent at default.** The feed carries `knobs` with only the fields that differ
  from the default, and no `knobs` key at all when none does (today's plan, to the
  bit, by supports-knobs-1). Only a Custom feed carries them: an Assisted build
  sends none even with fields changed, and Auto never has a feed.
- **A field that is not a number** (empty, negative; the growth may be 0, the rest
  must be above 0) is marked and named in the section's note; REGENERATE refuses
  with the same words and builds nothing. No other limit: the planner reports what
  a value breaks (`plan.knobs.problems`) and the card does not clamp.
- **DEFAULTS** puts all four back (off when they are at default). Nothing rebuilds.
- **Settings, not edits.** Like the angle and the size, the fields are the card's
  (not the piece's): not an Undo step, kept when the mode leaves Custom (the section
  is hidden, not emptied, and comes back as it was left, open or closed), kept by
  REMOVE ALL, Undo, Redo and Escape. While a build runs the fields are off.
- **The eraser** plans again with the fields as they stand, as any build does.

Check: `node tools/nso_support_custom_drive_check.mjs` section 9 (a drive, not a
`testStep`); `--only=tune` runs that section alone. Screenshots go to the
git-ignored `tools/supports-custom-card-out/`.

### Not done here

- The export's name tag (`supportKnobs`, supports-knobs-1): the card does not yet
  pass `plan.knobs.nonDefault` to it.
- `plan.knobs.problems` (a lean at 90 deg, a trunk that did not build) is not
  shown on the card.
- The standing supports are not dimmed in the 3D view when stale; the card's
  readout is.

## 9. One trunk, and the interface (supports-one-trunk)

Two controls under Style / Size / May rest on the part, both settings (not Undo steps), both disabled while a build runs:

| control | on | off |
| --- | --- | --- |
| **One trunk per cluster** (no longer shown: Tree in Auto is always the one-trunk build; the switch stays in the page, hidden and checked, for the drives that ask for the lattice tree, and the card's own retry when a one-trunk build's feet ring the piece) | **Auto, Tree** (also with "may rest on the part": the one-trunk build runs as it does without, and the spots it could not reach are planned again alone with the lattice that rests on the part): the planner is sent `opts.oneTrunk` (no feed): tips every ~5 mm, one trunk to a cluster, a canopy, the sheet between (`docs/SUPPORT-ONE-TRUNK.md`). Areas one trunk can feed are planned in one call (`NSO_SupportGridpack.oneTrunkGroups`); each keeps its outline, status and answer, the group's support is the first area's. A spot a thinned tip holds is said **held**, with that tip's landing. | the lattice planner of `SUPPORT-GRIDPACK.md` section 2, a tip on every spot of the 3 mm grid, as it was |
| **Interface** Dense (Bambu) / Open | **Dense** (default), **in the one-trunk build**: the sheet's lines 0.47 mm apart and 2 interface layers over the 2 of transition (`partsOptsOf`: `sheetPitchMm`, `interfaceLayers`) - Bambu's `support_interface_spacing` 0.1 | **Open**: 0.84 mm, 2 + 2, the first prints'. Every other build (box off, Assisted, Custom, Straight strut, Gecko-hand) is Open whatever the select says |
| **Brim round the foot** (default on, every mode) | After a piece's supports are built the card asks `NSO_Slicer.brimFor` for the piece's brim - Bambu's 5 mm ring of 10 loops round the foot of a part tall for it, 0.1 mm off the wall, off every pad and every other piece - and places it as one more plate piece, "<piece> - brim" (`nsoSupport.brim`: not counted as a support, taken off with the supports on one Undo, exported with ten wall loops, sliced as Brim). A piece on a wide foot gets none. Plate-wide: the same, piece by piece, off the supports already built. | no brim piece; the slicer's own brimType (G-scope's brim select, the project's `brim_type`) still brims a tall part at slice time |

Straight strut and Gecko-hand are one post (or hand) a spot by definition and are never one trunk. Assisted and Custom
send their feeds as before and are not one trunk; their sheets stay Open (a hand-placed row of three tips formed no sheet at 0.47 mm in `support:custom`, where it forms one at 0.84).
## 8. Generate for plate (supports-plate-wide)

UI and orchestration only (`app-supports-card.js`, `index.html`, `styles.css`); the engine is not
changed. With two or more pieces on the plate the card offers **Generate for plate** (`#sup-plate`,
under the Angle). It is an option, not a "nothing selected" trigger: with nothing selected the card
is as it was ("Click a piece to see where it needs holding").

- **On.** Every real (non-support) piece is lit as a selection is (the red tint and the white outline,
  one outline per piece, drawn by the app's own `refreshOutline` into the piece's `p.outline` slot, so
  `clearSelectionOutline`, `selectPlaced` and the undo restore already take it down), none is selected,
  and every piece is detected. The readout: **"6 pieces · 8 hanging areas at 35°"** (Assisted counts
  spots, Custom tips). The angle is the card's, editable as ever; the tools row is not shown. The
  option is not shown with one piece.
- **GENERATE** loops the piece's build (`runPiece`, `settleResults`, `placeResults`: the single build
  is these three plus `startJob` / `finishJob`) over the pieces in plate order, each with its own
  remembered state (areas left out, tips, circles, erasures - `asHost` points the card at each piece
  and calls its own `effective`, `snapshot`, ...). Style, Size, "May rest" and the angle are the card's.
  ONE bar: **"Piece 2 of 6 · Planning 142 / 344 · 21 %"** - the counts are the piece's, the percent is
  the plate's (a piece's share is its spots over the plate's; 100 only on the last piece's last unit).
- **The plate is touched once**, at the very end (`buildWide`'s `commit`): every built piece's old
  supports off, the new ones on, ONE `supportSwap` Undo step. Escape, the watchdog or an exception
  ends everything with the plate as it was and no step. **REGENERATE** replaces every piece's supports.
  A piece with nothing hanging, with every area left out, or one the planner refuses (its answer is
  "not ok" and names no spot inside the part) is reported in a row and does not stop the others;
  a piece whose areas the plate cannot reach (`inside`) is built with those spots unreachable. Pieces
  not built keep the supports they had.
- **Built:** "Built: M supports on K pieces · held H · unsupported U · unreachable R" and a row per piece
  that needs a look ("Support Oblique · unreachable 1", "Box · no hanging area", "B · refused: ...").
  A click on a row selects and frames that piece - which is a single piece picked, so the option goes off
  and the card is on that piece. REMOVE ALL / REMOVE stay per piece.
- **Off.** Switching the option off puts the card back on the piece it was on (if one was);
  a piece picked, added or removed, the plate cleared, an Undo that restores the plate, and the card
  closing all end the option and take the highlight with it (`wideHolds`: the highlight *is* the option,
  checked every frame). The Undo of a plate build also ends it.
- **Watchdog and ceiling.** The watchdog is silence, as before: 60 s with no message from the planner,
  every message starting it again, so the plate's total time does not matter. The 10 min ceiling is
  per piece: `startJob`'s `arm()` is called again as each piece begins (and the message names the
  piece: "B was still running after 10 min"); it is not a limit on the plate.
- **Pieces do not touch.** Each piece is planned with the supports the earlier pieces of the run built
  added to its occluders (`D.opts.occluders`, the option detection and the planner already take for the
  other pieces' *bodies*, shareFeet's included), so a later piece's trunks, feet and pads are routed
  round them. Order is plate order.

### Measured: the gaps

On `fixtures/supports/supp_ref.3mf` (six parts, laid out as an import lays them: a row, 4 mm apart):

| | supports vs other pieces' bodies | supports of different pieces |
| --- | --- | --- |
| six single-piece builds, one after another (no occluders) | 2.973 mm | **0.000 mm** (five neighbouring pairs touch, on the first layer) |
| Generate for plate (earlier supports as occluders) | 2.973 mm | **0.293 mm** (five pairs, 0.293 - 0.309) |

The slice's `support_object_xy_distance` is 0.35 mm. The occluder option stops the supports touching, and
holds them well clear of every body, but the pads keep only `FOOT_GAP_MM` = 0.2 mm (plus the raster's
slack) off an occluder (`nso_support_gridpack.js`): **0.293 mm is short of 0.35 mm, and getting there is
an engine change** (that constant, or the pad raster's keep-off), so it is its own ticket and was not made
here. `tools/nso_support_plate_test.js` prints it as `KNOWN-GAP`; `NSO_STRICT_GAP=1` makes it a failure.

Check: `npm run support:plate` (`tools/nso_support_plate_test.js`, Node only, ~4 min: the card file itself
run in a vm with the real engine; `tools/nso_support_plate_lib.js`). `NSO_PLATE_QUICK=1` skips the
six-part build for development. No browser step.

## Paint scope: sub-region (detection)

As G-scope's row: painted faces are the `skipList`, shifted into the world
frame when the piece is only moved, refused by name when it is turned and
painted. The piece itself is never written; supports are new pieces.

# Supports card: a verb with a state

`app-supports-card.js`, the column's **Supports** drop-down (make/edit group,
after Seat). One card on the main page. G-scope keeps its support row for
layer-view work (`docs/GCODE-SUPPORTS.md`); both call the same planner.

```
npm run support:workflow    tools/nso_support_workflow_drive_check.mjs, headless Chromium at 1280 x 800
```

`support:card` (`tools/nso_support_card_drive_check.mjs`) drives the previous
card - All / None, region badges, dots - and is superseded by `support:workflow`.
It is out of `testSteps`; the file stays until someone deletes it.

No dots on the mesh. Each **hanging area** - one region of the beacon grid
(`docs/SUPPORT-BEACONS.md`) - is outlined faintly on the surface: the edges of
its grid cells that no other cell of the area shares. An outline, not a grid.
It is drawn through the piece (an overhang's underside is rarely the face in
view) and a click is read against the outlined cells along the ray, so an
underside area can be clicked from above.

## 0. Detect first

Opening **Supports** - or selecting a piece while it is open - runs detection
at once, on the selected piece (the only piece on the plate, when nothing is
selected). Every hanging area is outlined and the card says **"N hanging areas
at 45&deg; on &lt;piece&gt;"**. The angle is a field on the card
(`#sup-angle`, 1..89, default 45 - `detectOverhangs`' own); typing re-detects
once the typing pauses. It is a setting, like Style: not an Undo step. Nothing
is generated.

The areas are editable before GENERATE, on the mesh, where the effect shows:

- **a click on an outline** leaves that area out (it dims) or puts it back;
- **Shift-click on the piece** adds a spot - one beacon, outlined like the rest
  (an area of its own, or part of the nearest one).

## 1. The three states

| state | the card says | what is live |
| --- | --- | --- |
| **IDLE** (a piece is picked) | **"N hanging areas at 45&deg; on &lt;piece&gt;"** (`&middot; K left out` once any is) | **GENERATE**; Angle, Style, Size, "May rest on the part" (off); a click on an outlined area leaves it out (grey) or puts it back. Nothing builds on a click. |
| **BUILDING** (GENERATE pressed) | **"Building&hellip;"**, with the seconds (**"Building&hellip; 14 s"**) once it has run past 10 | the button reads the same; every control is locked; a spinner turns over the piece |
| **BUILT** | **"Built: M supports &middot; held H &middot; unsupported K &middot; unreachable U"** | **REGENERATE** (replaces every support on the piece) and **REMOVE ALL** beside it; a click on a built support picks it and **REMOVE** takes that one; areas the plate could not reach stay outlined **red**; a row under the readout for every area that is not held |

**Every area is exactly one of the three**, so H + K + U is the number of areas:
*held* - every spot in it is held from the plate or rests on the part;
*unreachable* - the last build tried it and the plate could not reach at least
one spot (never counted held); *unsupported* - left out, or the planner gave it
nothing, or a Remove took a support off it. The rows list the areas that are not
held ("Area 3 &middot; unreachable &middot; no route to the plate &middot; 4 spots"); a click on a row **frames the area**
(the camera keeps its direction and comes in on it). A piece with no beacons at
all shows **"Nothing hangs in air. Tall-and-thin sway isn't checked yet."** and
GENERATE is off. The card's readout is the one place it speaks: the HUD's green
build tag (`#adjust-status`) is not drawn while the card is open, and
`#status` no longer repeats the line.

### A build ends in a state

BUILDING always finishes: as BUILT, or as **"Could not build: &lt;reason&gt; - nothing
was added"** - a planner refusal, an exception, or the **watchdog** (60 s by
default; `NSO_SUPPORTS_CARD.watchdogMs(ms)` sets it). On any failure the plate
is exactly as before, **Undo has nothing new**, the old supports (if any) still
stand and the card is live again. The plate is touched in one synchronous stretch
at the very end, only if the build is still live, and everything is put back if
anything in it throws.

**Why the watchdog needs a worker.** `planTree` is one synchronous call, and a
thread that is inside it cannot repaint, count seconds or fire a timer. The
card therefore plans in a Web Worker that loads the same engine files
(`nso_thickness`, `nso_support_beacons`, `nso_support_aim`, `nso_path_sweep`,
`nso_support_tree`, `nso_support_gridpack`); the watchdog on the page calls
`terminate()` on it. The plan comes back as plain data and `NSO_SupportGridpack.solid`
(the union, wasm) still runs on the page - it is promise-based and cannot be
interrupted mid-step, so the clock is also read between areas. A page that
cannot start a worker plans in-thread and can only be held to the clock after
the fact. `NSO_SUPPORTS_CARD.setPlanner(fn)` replaces the planner (a test seam).

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

## 5. Flags

- The outline follows the beacon grid's cells (lattice-aligned, 3 mm), not the
  face: where a straight edge falls inside the outermost cells the outline can
  pass it by up to half a pitch.
- An area is a region of the beacon grid. A manual spot too far from any area
  starts one of its own. A left-out area is remembered by the position of one
  of its spots, in the piece's own frame, so it follows the piece when it moves.
- Leaving an area out after a build changes the line but not the plate: its
  supports stay until REGENERATE. (It then counts as unsupported.)
- An area is "held" only when every spot in it is; one support removed by hand
  makes it unsupported until REGENERATE. An area partly held and partly not
  reachable counts as unreachable only. A detected spot is named by where it is
  (`d<x>,<y>,<z>`), not by its place in the list, so the supports already
  standing still find their spots when the angle changes the detected set.
- The whole-piece build is only as fast as the planner: a piece with a very
  large overhang (the wedge's 377-spot underside, 289 s) does not build inside
  the 60 s watchdog and says so. The fix is in the engine (a spatial index for
  the inside test in `nso_support_aim.js`), not here; leave the area out, or
  raise `NSO_SUPPORTS_CARD.watchdogMs()`, until then. No planner in this tree has
  a per-spot time-based give-up, so there is none to cap.
- The union (`NSO_SupportGridpack.solid`) runs on the page and cannot be
  interrupted mid-step: the clock is read between areas, so a single union that
  runs long is only caught afterwards.
- One plate piece per solid: a strut on the tilted box is 120 pieces, a tree
  70. That is what lets REMOVE take one; the Pieces list grows with it.
- Areas are planned one at a time, each against the piece and the other
  pieces, not against each other's supports (as G-scope's row).
- A support records the piece it holds by id. Move the piece after building
  and the supports stay where they were; the card shows the new areas.
- The app's own Remove deletes the model with the plate entry, and its Undo
  puts back the entry only (pre-existing, every piece).

## Paint scope: sub-region (detection)

As G-scope's row: painted faces are the `skipList`, shifted into the world
frame when the piece is only moved, refused by name when it is turned and
painted. The piece itself is never written; supports are new pieces.

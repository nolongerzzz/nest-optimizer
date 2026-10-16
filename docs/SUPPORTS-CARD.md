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

No dots on the mesh. Each **overhang area** - one region of the beacon grid
(`docs/SUPPORT-BEACONS.md`) - is outlined faintly on the surface: the edges of
its grid cells that no other cell of the area shares. An outline, not a grid.
It is drawn through the piece (an overhang's underside is rarely the face in
view) and a click is read against the outlined cells along the ray, so an
underside area can be clicked from above.

## 1. The three states

| state | the card says | what is live |
| --- | --- | --- |
| **IDLE** (a piece is picked) | **"N overhang areas"** (`· K left out` once any is) | **GENERATE**; Style, Size, "May rest on the part" (off); a click on an outlined area leaves it out (grey) or puts it back. Nothing builds on a click. |
| **BUILDING** (GENERATE pressed) | **"Building…"** | the button reads "Building…"; every control is locked; a spinner turns over the piece |
| **BUILT** | **"Built: N supports · M of K areas held · J areas not reachable from the plate"** | **REGENERATE** (replaces every support on the piece) and **REMOVE ALL** beside it; a click on a built support picks it and **REMOVE** takes that one; areas the plate could not reach stay outlined **red** |

K counts the areas not left out. An area is *held* when every spot in it is
held from the plate or rests on the part; it is *not reachable* when at least
one spot could not be reached (it is then not counted as held). A piece with no
beacons at all shows **"Nothing hangs in air. Tall-and-thin sway isn't checked
yet."** and GENERATE is off. Paint Hold / Skip is a secondary row, collapsed
("Paint spots"); shift-click on the piece still adds a manual spot (an area of
its own, or part of the nearest one). The **HUD** (`#status`) reads exactly the
state line and nothing else.

Every state change is **one Undo**: leaving an area out or putting it back, a
manual spot, a paint stroke, GENERATE / REGENERATE (the supports it adds and the
ones it replaces), REMOVE, REMOVE ALL. (A `supportSwap` step; its `onUndone`
puts the card's own record of the piece back: the edits, the spots a build could
not reach, whether it was built.)

### What each control did before, and what does it now

| before | now |
| --- | --- |
| **All** - built every region, replacing the piece's supports | **GENERATE**; once built, **REGENERATE** (same replace) |
| **None** - took every support off and dropped the piece's manual, painted and skipped spots | **REMOVE ALL** - takes every support off and returns the card to IDLE. The piece's edits (areas left out, manual and painted spots) are kept; each is its own Undo |
| a region's **count badge**, or one of its **dots** - built that region alone, or took its supports off | **a click on an outlined area** - leaves it out / puts it back. Builds nothing, removes nothing; the next GENERATE / REGENERATE uses it |
| **Remove** - took off the one selected support | unchanged: click a built support, **REMOVE** (shown in BUILT) |
| **Paint** + Hold / Skip - always on the card | the same, in the collapsed "Paint spots" row |
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

On support:beacons' tilted box (40 x 30 x 10, underside at 30 deg): 120 spots in
1 area, outlined once (44 edge segments of the 12 x 10 cells). GENERATE (Tree,
1.2 mm) builds 70 supports in about 1 s: "Built: 70 supports · 1 of 1 area held ·
0 areas not reachable from the plate". Leaving the area out: "0 overhang areas ·
1 left out", GENERATE off. REGENERATE: no old support survives, as many new;
Undo puts the old pieces back. REMOVE takes exactly the clicked one (69, "0 of
1 area held"). REMOVE ALL back to IDLE; Undo back to BUILT. A shift-click on the
wall: "2 overhang areas". Beside a block with a tunnel through it (the tunnel's
ceiling hangs over its own floor): 2 areas; GENERATE gives "1 of 2 areas held · 1
area not reachable from the plate", that area outlined red; leaving it out
afterwards gives "1 of 1 area held · 0 areas not reachable". The HUD equals the
state line at every step; every step adds exactly one Undo entry.

## 5. Flags

- The outline follows the beacon grid's cells (lattice-aligned, 3 mm), not the
  face: where a straight edge falls inside the outermost cells the outline can
  pass it by up to half a pitch.
- An area is a region of the beacon grid. A manual spot too far from any area
  starts one of its own. A left-out area is remembered by the position of one
  of its spots, in the piece's own frame, so it follows the piece when it moves.
- Leaving an area out after a build changes the line but not the plate: its
  supports stay until REGENERATE.
- An area is "held" only when every spot in it is; one support removed by hand
  makes it "not held" until REGENERATE. An area partly held and partly not
  reachable counts as not reachable only.
- One plate piece per solid: a strut on the tilted box is 120 pieces, a tree
  70. That is what lets REMOVE take one; the Pieces list grows with it.
- Areas are planned one at a time, each against the piece and the other
  pieces, not against each other's supports (as G-scope's row).
- The paint stroke is one grid row wide (radius half a pitch, 1.5 mm); Hold
  spaces its spots a pitch apart. Not a control yet.
- A support records the piece it holds by id. Move the piece after building
  and the supports stay where they were; the card shows the new areas.
- The app's own Remove deletes the model with the plate entry, and its Undo
  puts back the entry only (pre-existing, every piece).

## Paint scope: sub-region (detection)

As G-scope's row: painted faces are the `skipList`, shifted into the world
frame when the piece is only moved, refused by name when it is turned and
painted. The piece itself is never written; supports are new pieces.

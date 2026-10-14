# Supports card: where a piece needs holding, on the main page

`app-supports-card.js`, the column's **Supports** drop-down (make/edit group,
after Seat). One card on the main page. G-scope keeps its support row for
layer-view work (`docs/GCODE-SUPPORTS.md`); both call the same planner.

```
npm run support:card    tools/nso_support_card_drive_check.mjs, 80 checks, headless Chromium at 1280 x 800
```

## 1. Flow

Open Supports, click a piece. Its beacons appear on it: the spots that need
holding, from the beacon grid (`docs/SUPPORT-BEACONS.md`), grouped into its
regions, with a count badge on each. The card says
**"N spots need holding in M regions."**

| control | what it does | Undo |
| --- | --- | --- |
| **All** | builds every region; any supports already on the piece are replaced | one step |
| **None** | takes every support on the piece off, and drops its manual and painted spots | one step |
| a region's badge, or one of its beacons | builds that region alone; when it has supports, they come off. Nothing else on the piece changes | one step |
| a built support | selects it (the app's own selection); **Remove** takes that one only | one step |
| shift-click on the piece | a manual beacon there, from the clicked face: a side spot on a wall, an underside spot below. It joins the nearest region (within 1.5 grid pitches) or starts a one-beacon region; it is built on the next All or region click | one step |
| **Paint** · Hold | drag on the piece: adds a spot wherever none is within a grid pitch | one step per stroke |
| **Paint** · Skip | drag over spots: every spot within half a pitch of the stroke goes, so nothing is built there | one step per stroke |
| Style · Size · May rest on the part (off) | the same three controls as G-scope's card | – |

After any build the card reads **"N held from the plate · M resting on the
part · K unreachable"** over the piece's spots. A beacon is drawn in its state:
white planned, green held, amber resting, red unreachable.

Guards, in words: no beacons, **"Nothing on this piece needs holding."**; a
support clicked with no piece of its own picked, **"That's a support; pick the
piece it holds."**; a shift-click on a face that looks up, "That face looks up
- nothing hangs from it."

Painted and manual edits live on the piece (`m.nsoSupportEdits`), in its own
mesh frame, so they move with it. They last until None or a reload.

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

## 4. Measured (`support:card`, 80 checks)

On support:beacons' tilted box (40 × 30 × 10, underside at 30°): 120 spots in
1 region. All (Tree, 1.2 mm) builds 70 supports in about 1.5 s, every spot held
from the plate. Close-and-reopen, then a click on a support: the guard.
Click + Remove drops exactly that one; Undo puts it back. None, Undo, None.
A shift-click on the side wall: 121 spots in 2 regions, the new one a side
spot; the next All holds all 121 (the manual spot by a support labelled for
region 1). Region 1's badge takes off exactly its solids and leaves region
0's (same pieces); a second click builds exactly region 1's again. Paint Skip,
one stroke back and forth along rows 0–4 of 10: 120 → 60, exactly rows 5–9
left. A standing tube: "Nothing on this piece needs holding.", All off. Every
step adds exactly one Undo entry, and Undo after each restores it.

## 5. Flags

- One plate piece per solid: a strut on the tilted box is 120 pieces, a tree
  70. That is what lets Remove take one; the Pieces list grows with it.
- Regions are planned one at a time, each against the piece and the other
  pieces, not against each other's supports (as G-scope's row).
- The paint stroke is one grid row wide (radius half a pitch, 1.5 mm); Hold
  spaces its spots a pitch apart. Not a control yet.
- A support records the piece it holds by id. Move the piece after building
  and the supports stay where they were; the card shows the new spots planned.
- The app's own Remove deletes the model with the plate entry, and its Undo
  puts back the entry only (pre-existing, every piece): Remove works on a card
  support; Undo of that Remove does not restore it as a support.

## Paint scope: sub-region (detection)

As G-scope's row: painted faces are the `skipList`, shifted into the world
frame when the piece is only moved, refused by name when it is turned and
painted. The piece itself is never written; supports are new pieces.

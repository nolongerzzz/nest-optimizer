## Pose bake - every pose action is complete when it ends (2026-10-21)
Branch `claude/pose-bake`, off `claude/lean-after-tip` (#260 not landed yet; PR
against it). The owner's rule: the next action starts from a finished piece, so
Rotate and Tip never fight over a half-applied pose.

- **Bake on release** (`nsoBakePlacedPose`, app-core.js). When a pose verb ends -
  a Rotate ring drag's release, a run of dart clicks or Rotate arrow keys once
  it settles (`seat()`, RUN_MS), the 90 buttons and the Tilts
  (`turnSelectedAbout`), Tip on side / Stand / Flip / Tip on face (`turnBy`),
  Tip X, Roll Z, Edge 180 - the mesh's turn goes into the raw soup (turned about
  the raw origin) and the display geometry is rebuilt from it, centred. The mesh
  goes back to identity, rotY / tipX / tipZ / tiltX / tiltZ / flipX to 0, x / z
  move by exactly what the re-centring moved (no vertex moves in the world), and
  the piece re-seats on its true lowest vertex at 0.2 + liftY (#220). The
  paint's raw planes turn with the soup (`nsoTurnMaskPlanes`: axis-and-side
  kept on a quarter turn, plane only otherwise). One Undo per action, a
  geometry step (`poseBake`): the verb's own pose snapshot on top of the stack
  is folded in as `prevPose`, and Undo (`nsoUndoPoseBake`) puts back the same
  geometry object, raw soup, record and mesh height. A run of clicks keeps one
  Undo point per click, as before. Not baked: a programmatic
  `nsoRotate.turn` (scratch, as mid-drag), Optimize's nest yaw, a 3MF scene's
  pose, Seat's free quaternion - pieceFrame reads vertices through the mesh, so
  every tool is right on those too.
- **One frame: `pieceFrame(p)`** (nso-bounds.js, `window.pieceFrame`,
  `nsoBounds.pieceFrame`): the narrowest rectangle round the shadow of the
  piece's vertices (hull + rotating calipers, Akl-Toussaint pre-filter, cached
  per geometry and 3 x 3 like the box), as level `long` / `short` unit
  vectors, the plate `up`, `lengths` { long, short, height }, `centre`,
  `square` (5%). Where the rectangle square to the piece's body axes is within
  2% of the narrowest, it takes that one, sides exactly (see "CI batch 20"
  below). `holdFrame` / `releaseFrame`: a Rotate drag holds it from
  press to release.
- **`p.bakedQ` / `nsoPieceBodyQ(p)`**: the turns baked since load, and the body
  (mesh turn x bakedQ). Read by the Rotate rings' painted scale (so #229's
  detents stay absolute), the dart slot names (which side is 'fb'),
  pieceFrame's body-square choice, and the checks. Nothing places, exports or aims
  by it. `nsoPoseHome(p)` (for the checks) puts a piece back as it was before
  an unbroken run of bakes.
- **Private frames deleted** (each now asks pieceFrame):
  - app-rotate-handles.js `leanAxes(q, p)` - own-axis shadows + bounding-box
    corners (#260) - and `footprint(p)` - the world AABB `p.width x p.depth`
    the names read. Lean axes and leanMap's names are pieceFrame's sides.
  - app-cut.js `cutFrame`'s square axis, `cutLongAxis(localBox3(geometry))`:
    now `cutTravel` - the plate vertical for a piece taller than it is long,
    else the footprint's long side, through the existing mitre-turn machinery
    as a `base` turn (0, bit for bit, on a piece lying square). A leaned piece's
    square blade is plumb; Plumb's bevel is 0 there. `cutLongAxis` survives only
    for a preview with no placed mesh.
  - app-tip-orient.js Tip on side / Stand (`p.width / depth / height` and plate
    X / Z) and Flip (plate X): the footprint's long / short sides. Turn 45 then
    Tip on side lands on a face, not on an edge.
  - app-join.js `NSO_plugFrame` (Seat support / flush / washer / straddle):
    `NSO_localAABB(geometry)` as the bit's frame -> `NSO_plugBasis`, the frame
    in mesh terms, HELD per geometry (a seat's fit turns the bit step by step and
    must fit by the frame it started from). A bit lying square keeps its own box
    (null basis). app-seat-surface.js Seat here: the same.
  - app-bend.js: the raw-axis band reader -> `NSO_bendSpace`, the soup turned
    about the vertical to put the footprint's long side on raw X (ghost, marker
    and click carried by T), result turned back before the commit.
  - app-scale.js: Length / Width / Height are as the piece LIES
    (`NSO_scaleSpaceOf`, the same turn, held per soup for a live edit). A bar or
    "other" piece shows all three: Extend / Shorten where the reader finds a
    straight run on that axis, else a STRETCH along it (`NSO_scaleStretchRaw`,
    about the middle, solved and gated like a uniform scale). Rings, rods and
    the recognised shapes keep their own rows.
  - Tube edge and Punch take their frames from the geometry (an end face, a
    face normal) - nothing to delete; their "bake its pose first" gate
    (`NSO_bendFrameMatches`) now always passes.
- **Seat keeps the baked tilt** (owner's call): a tilted bit is a finished
  piece; Seat (support) lands its current underside. The tooltip says so.
- **Re-pinned** (old -> new, each named in the test): rotate:handles (H.zero ->
  nsoPoseHome, H.q -> body; sections 2 / 3 / 16 measured in hand before the
  release bakes; section 10 yaw off the body; section 22's "read fresh" against
  pieceFrame's squareness, not the box's 5%; section 26's helpers on vertices),
  tip:orient (resets and Tilt readings off the body; 15 / -15 unchanged),
  pose:drive (fields = the body's Euler; "four ⟲ back exactly" r.deg === 0 ->
  < 1e-9), wire:cut-blade / wire:cut-blade-view (axis letters 'z'/'x'/'y' ->
  the plate's, spans unchanged; the 15° turned bar's span 61.06 -> 60, along
  its own length), wire:cut-redesign section 3 (blade square to the leaned bar
  -> plumb / level, oblique section 114.762 mm²), wire:cut-tip ("pose on the
  mesh" -> "baked: body turned, mesh identity"), watch:test B1 (the yaw is
  baked; a pose written to the record carries the rest), input:mode (body),
  seat:tilted (target angle off the body; a tilted bit keeps its tilt instead
  of being straightened), to-plate (tilt off the body), stock:live (pose off
  the body; a leaned block shows L / W / H as it lies, Height 34.85 -> 40 by
  stretch).
- Checks: `pose:bake-release` (new; `pose:bake` was taken by the bake-keeps-pose
  step). No full suite run (owner's instruction).
- `?v=`: nso-bounds, app-core, app-rotate-handles, app-tip-orient, app-cut,
  app-bend, app-join, app-seat-surface, app-scale -> posebake1.

### Pose bake - CI batch 20's eleven (2026-10-22)
#261 broke eleven steps outside its gates (Tests #305): scale:inches,
scale:card, seat:surface, grab:drop, ring:drive, wire:cut-bore, wire:cut-yaw,
wire:offset, wire:scale, stock:shelf, leave:tool.

- **Common cause: pieceFrame's angle meant nothing on some footprints.** The
  narrowest rectangle is unique only for a footprint with a clear long side. A
  round or square footprint (ring, rod, tube, sphere, torus, a square block) has
  one per hull facet, and a geometry carrying a small unrecorded turn (Seat
  here) is a hair off its axes. Every tool that turns by the frame (Seat's
  basis, Scale's and Bend's frame space, the cut's base turn) turned the piece
  by that arbitrary angle and back, and the answers drifted: the "no turn
  needed" seat turned B 0.3 deg (long read [0.99998, 0, -0.0059]); a ring's Wall
  edit lost its length (40.623); a curved piece re-seated at 12.7272 (12.7 with
  the fix, same build otherwise); a Stock sphere / torus lost its tag. Not
  bake rounding, not the re-seat, not the frame read before the bake, not
  bakedQ against the geometry.
  Fix (nso-bounds.js `squareToBody`): pieceFrame takes the rectangle square to
  the piece's body axes (`nsoPieceBodyQ`, the shadows of body X / Z / Y, any
  shadow under 0.5 skipped) when its area is within 2% (`BODY_TOL`) of the
  narrowest, sides exact, canonical sense (long towards +X, or +Z when square
  to X). The 1e-5 rad snap (`exactSide` / `SNAP_RAD`) is gone.
- **Scale** (app-scale.js): the frame space turns by `R_y(-phi) x` the mesh's
  own turn, phi the long side's heading mod 90 (identity when both are nil), so
  a pose on the record reads as it lies. The stretch rows fill only where the
  piece read more of L / W / H as loaded (`NSO_scaleBodyRows`, the raw soup
  turned back by bakedQ, cached per soup) than it does now: a leaned box keeps
  all three; a cone (stock:shelf) or a blob (wire:offset) gets no stretch row.
- **Cut layout** (app-cut.js / app-join.js): a square cut across a turned
  piece's length parts the halves along the blade normal (`layoutAfterSplit`'s
  new `along`, from `getCutPlaneLocal`'s `normalWorld`), not along plate X. The
  split itself was right (probe: halves at exactly [-30, 0] / [0, 30] along
  the normal at 15 deg yaw).
- **Reported as regressions, were measurement pins** (the bake empties the
  pose fields and the mesh turn, so a check reading them sees 0):
  - grab:drop "Rotate 90 changes height (31.8968)": the height check passed;
    "it turns" compared mesh quaternions (identity after the bake) ->
    `nsoPieceBodyQ`.
  - leave:tool "piece turned 180 reads 0.000": it read rotY -> the body's turn
    relative to before, 180 deg about the vertical; "two Undos put the turn
    back" exact -> < 1e-9 deg.
- **Re-pinned** (old -> new, each named in the test):
  - scale:card section 5 (after Tip X, as it lies: Width 25.0 / Height 40.0,
    readout `100.0 L x 25.0 W x 40.0 H`). Section 10's bar is baked standing (rotY
    0, tipX 0, longUp 1; Longest 120.0 sits behind Height 120.0). Section 10's
    taper: the Longest row is shown and typed (real = true).
  - wire:cut-bore: the rolled ring's cut is named by the plate's axis, 'y' ->
    'x'; cases named X / Z / Y.
  - wire:cut-yaw: hook `cutSplitAt`, not `splitBothSides` (the cut frame's
    inner split sees the copy turned into the cut frame); the bar direction's
    sign `uz = -sin(yaw)` (hidden while the blade normal was a plate axis).
  - scale:inches, seat:surface, ring:drive, wire:scale, wire:offset,
    stock:shelf: no test change; fixed by the above.
- Checks (all green, no full suite): the 11 gates from #261, the 11 above, and
  wire:cut-blade, wire:cut-tip, wire:cut-blade-view, watch:test,
  wire:cut-redesign, to-plate, input:mode, seat:tilted.
- `?v=`: nso-bounds, app-cut, app-join, app-scale -> posebake2.

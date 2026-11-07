## Cut: a sized blade - cut between things, and notch into a face without going through (2026-11-02)

Write-up: `docs/CUT-BLADE.md`. New: `nso_notch.js` (the blade box, THREE-free), `tools/nso_notch_test.js` (`notch:test`, node, real manifold kernel),
`tools/nso_cut_notch_drive_check.js` (`notch:drive`, real Chromium, 35 gates). `app-cut.js` gains the sized-blade state, `cutBladeSpec`,
`cutBuildSizedBlade` and `cutNotchAt`; `getCutPlaneLocal` returns `upCut` and `blade`. `app-core.js`: the click records its point and face normal
(`state.cutBladeAt`) and one undo label (`notchReplace`). `app-join.js`: `cutActiveModel` branches to `cutNotchAt` when `info.blade` is set; the card
is wired next to the mitre dial. `index.html` the Blade rows and one script tag; `styles.css` a few rules.

The full blade is byte-for-byte the old path (`info.blade` is null unless "Sized blade" is pressed), and every existing Cut test passes. One test
changed on purpose: `nso_wire_cut_redesign_test` pins the exact list of controls on the Cut card, which now includes the Blade rows.

Found while testing: a bevel pivots the plane about the piece's centre line, so the plane is not where the click was; starting the blade from the
click's depth buried it (a void, "2 bodies", 24 mm^3 instead of 18). The anchor is now the clicked face's plane met at the cut plane. A mitre turns
about the vertical and could not show it - the bevel gate is what caught it.

Known gaps (also in the write-up): no wall-thickness refusal (Carve has one), position is by click only, no pocket into a face parallel to the plane.


### Second round (2026-11-02): strands, Notch mode, Adjust blade, Rotate piece

Asked for after the owner loaded `Connector (string)` (a flat spiral of 3.7 mm round cord): a sized blade that takes the one strand under the click and
not every turn of the spiral; a Notch mode (a nick in from the strand's edge, adjustable width/depth - the owner chose the nick over a groove running
along the cord); a checkbox to isolate blade adjustments from other controls (dropped in the third round - see below); and a rotate box at the top of the card so a piece can be turned while Cut
is open. `nso_notch.js` gains `sectionClusters` / `nearestCluster` / `notchBox` (node-tested on a comb). `app-cut.js`: three blade modes, the strand in
`cutBladeSpec`, the strand outlined in the helper, `cutSetRotate`. `app-core.js`: the ring grab is allowed under Cut when `state.cutRotate`. `app-rotate-handles.js`: rings drawn/grabbed under Cut, keys stay
with the Rotate menu. New `tools/nso_cut_strand_drive_check.js` (`notch:strand-drive`, a generated spiral). `nso_wire_cut_redesign_test` lists the card's
controls again.

Found on the owner's file: subtracting the strand's own piece (blade n piece) from the piece left one edge shared by four triangles (a boolean on
coincident faces; 0 non-manifold before, 1 after, at every tolerance, kernel status NoError). The blade, clipped a hair outside the strand, is subtracted
instead: same volume, 0 bad edges. Also found: a click-to-strand pick measured to the outline's corners picks a neighbour on coarse meshes; it is now
measured to the outline's segments.

Known gaps: no wall-thickness refusal; Notch is a nick across the strand, not a groove along it; position by click only.

### Third round (2026-11-03): Adjust blade dropped, sizes are sliders

The owner dropped the Adjust blade switch (it was meant to keep other controls from shifting the blade; sliders for the sizes are the answer) and asked
for a slider for width, depth and kerf on the Sized blade and the same for Notch. Adjust blade is gone from the card, `app-cut.js`, the three gates in
`app-core.js` and the tests. Each size is a slider + number box (`CUT_BLADE_FIELDS`), ranged to the piece (`cutSliderMax`), and the range always takes in
the number shown. `nso_wire_cut_redesign_test` lists the new card; `nso_cut_strand_drive_check` (47 gates) has the slider gates, including a real mouse
click on a slider and a computed-style check that the ring options are hidden until Rotate piece is ticked (the owner's screenshot showed them up).

### Fourth round (2026-11-03): the finger would not separate; a bevel sent the blade flying

Reported on `Cartoon-Hand_..._DukeDoks part 2` (and then the file, as `text_repair_test.3mf`, so it could be reproduced): a sized cut through a finger was
called a "Notch cut", left the finger as one piece, warned of 25 open edges, and Split to parts then refused ("part 2 is too small"); a bevel sent the
blade flying round the piece.

- **Wording**: `Sized cut` / `Notch cut`, by mode.
- **Separation**: a severing cut now runs Split to parts (`NSO_SPLIT_PARTS.split({ absorbDust, quiet })`: a part under 0.1 mm across is folded into the
  largest part instead of refusing the lot; quiet reports by return value). Its own Undo step. A button click is unchanged.
- **Flying blade**: `cutPivotLocal` returns the blade's own centre for a sized/notch blade, so mitre and bevel turn it in place (it was swung about the
  piece's centre line, up to 13 mm off). `nso_cut_sever_drive_check` holds the blade to its click through bevel -90..90 and mitre 0..270, and fails on the
  old code.
- **The 25 edges were not the cut's** (0 -> 20 was the app's count of the kernel's output; the kernel alone, with no blade, gives the same 20 and a
  zero-volume 12-triangle fin: it re-triangulates the flat base's fine detail on import). The warning now compares with the piece as the kernel holds
  it and says so. Not fixed: that is the shared boolean kernel (Carve, Subtract and Punch see it too).
- **Speed**: 42 s -> 19 s on the hand (the edge counts were three 7 s adjacency passes; now a quick counter, and the weld only when worse).
- A surface correction divided by a near-zero face lean at bevel 90 and sent the blade to nowhere ("does not reach the piece"); it now applies only
  where the face leans into the plane.

Four suites that already fail on the commit before this work (`nso_rotate_rings_drive_check`, `nso_rotate_rings_steady_drive_check`,
`nso_rotate_pivot_drive_check`, `nso_shell_v3_test`) are unchanged.

### Fifth round (2026-11-04): room on the sliders

A 15 mm notch could not be dialled in: the kerf and notch-width sliders stopped at 10 mm (`min(10, span/2)`). `cutSliderMax` now gives every slider room to breathe:
width 2x the piece's biggest section, depth 1.5x, kerf and notch width 3/4 of its length, each at least 20 mm. The number box still takes anything and the
range still grows to hold it. `nso_cut_strand_drive_check` (49 gates) sets a 15 mm kerf and a 15 mm notch width by slider.

### Sixth round (2026-11-07): the blade answers only to a press on it or on the piece

A press on the empty plate a grid square or two from the blade still grabbed it and the drag moved it. Cause: `cutBuildBlade` / `cutBuildSizedBlade`
(`app-cut.js`) each added an invisible hit mesh bigger than the blade (+24 mm across the full blade, +12 mm round the sized box) "for easy drag", and
`app-core.js` takes any ray hit on `state.cutHelper` as a blade grab. Both hit meshes are gone. The blade's own sheet and edge frame are already
pickable (`cutOverlay(..., true)`), so a press on the blade still drags it, and a click on the piece still drops the blade there (that branch runs first
and is unchanged). A press anywhere else on the plate falls through to the plate's orbit.

New `tools/nso_wire_cut_grab_test.js` (`wire:cut-grab`, real mouse, top-down): the click-to-jump, a plate press 8 and 14 mm past the blade (fails on the
old code: the blade moved 10.4 mm), and a press on the blade frame still dragging it. Trade-off: the full blade seen edge-on is a line, so it is grabbed
by its frame, not by a fat target.

### Seventh round (2026-11-07): Follow strand

Asked for: "make the sized blade follow this string in a square cut position across the strand as it spirals, so I can click my way from start to
finish making 1-2 mm slices of salami". Full write-up: `docs/CUT-FOLLOW.md`. New: `nso_strand.js` (THREE-free: section by any plane, direction
and centre of a strand, march along it; `strand:test`), `app-cut-follow.js` (state in the WORLD, `state.cutFollowAt`; place / Back / Forward / after-cut),
`tools/nso_cut_follow_drive_check.js` (`follow:drive`). Hooks: `app-core.js` (a click with Follow on traces the cord; a press on the blade does not drag it),
`app-cut.js` (the `slice` field, state clears, `cutNotchAt` calls `cutFollowAfterCut` and carries the move in its status line), `index.html` (the card rows).

Found while testing: a plane that grazes a surface or the cord's end cuts a tiny outline, so "smallest section" picked wrong directions (now surface normals,
voted); a plane lying on a cut face cuts part of a disc whose centre is off the axis (sections are gated on area); a march that ran out into empty space
returned a target there (now the end); Back onto a kerf found another turn of the spiral (refused). `nso_wire_cut_redesign_test` lists the new controls.

### Eighth round (2026-11-07): the Rotate piece wheel

Asked for: the rotate rings are too far out of view to work on small pieces, so a rotary dial like the mitre's inside the Cut card, the Mitre box and Square
moved under the Mitre wheel so the new wheel fits on its right. The two wheels are now a two-column row (`.cut-dials`, `index.html`, `styles.css`); each column is
wheel, - / + (directly under it, as the layout gate in `nso_wire_cut_redesign_test` has always pinned), then its name and box (Square beside the Mitre's).
`app-cut.js`: `cutWireRotateDial`, `cutRotateBy` (through `nsoRotate.turn`, with the lock check and one Undo point per run), `cutPieceHeading` (0 = as loaded,
clockwise from above); `cutWireMiterStep` takes a third kind for its buttons. The old checkbox is now labelled **Rotate rings** (it still shows the rings and the
lean options). The wheel is a jog, not a pointer-follower: a piece must not jump to wherever the rail is pressed. A turn clears the Follow strand place (it is held in
the world). New `tools/nso_cut_rotate_dial_drive_check.js` (`rotate-dial:drive`); `nso_wire_cut_redesign_test` lists the card in its new order.

### Ninth round (2026-11-07): slide along the cord; one box

Asked for: the slider and the drag to work while Follow is on, following the cord instead of pulling the blade off it; Single strand and Follow strand as one checkbox;
a drag need not go round the whole spiral - section by section, about 90 degrees at a time. Done in `app-cut-follow.js` (the window and the slide) and
`nso_strand.js` (`centreline`: the stretch either side of a point, out to 90 degrees of turning or 60 mm, as samples of centre / direction / arc length / on-strand;
node-tested). Putting the blade down keeps the stretch (`fa.win`); `setCutMm` / `getCutMm` / `syncCutUI` (`app-cut.js`) map the slider, the box and the nudges to it,
`cutTFromPointer` and the pointer up / down (`app-core.js`) take a drag against the stretch (the sample nearest the pointer's ray), and letting go - or a 0.6 s pause - puts
the blade down for real with a fresh stretch (so the next drag goes another quarter turn). The sliding step is the cheap half of placing (no trace, no march, a narrow
aim sweep): about 13 ms on the Connector string. One box: `#chk-cut-blade-strand` is gone; Follow strand implies the one-strand isolation (`cutStrandOn`), and **off is the plain
sized blade that takes everything in its box** - which also means the default is no longer "Single strand on" (`b.strand` is kept as an internal switch for the
checks that drive the isolation without the following).

Found while testing: the window's end tangents were one-sided, half a baseline early (2.3 degrees off on a tight bend, held at the end of a stretch): extrapolated now.
`follow:drive` slides with the real mouse (slider, blade, cord), types in the box, nudges, and sweeps a stretch that crosses the kerfs of three cuts: at every stop the
blade's plane cuts a whole round section of the cord and faces the way the stretch runs.

### Tenth round (2026-11-07): Follow on by default; the rotate rings are gone, the wheel has the axes

Asked for: Follow strand on by default when the Sized blade is picked; the rotate rings option removed, a tick for each rotate option on the same wheel, Horizontal
ticked by default. `cutBladeState` now starts with `follow: true` (the card resets on every open), so picking Sized is enough; the checks that drive a plain sized blade
(`notch:drive`, `notch:sever`, `notch:strand-drive`) turn it off first. The rings option is out of the card (`index.html`), `app-cut.js` (`cutSetRotate`, the state, the
ring boxes), and out of the two places that gave Cut the rings (`app-core.js`'s press claim, `app-rotate-handles.js`'s `cutRings`; the Rotate MENU's rings are untouched).
The Rotate piece wheel takes the axis from three exclusive ticks (`chk-cut-rot-h` default, `-fb`, `-ss`; `state.cutRotateAxis`), mapped to the ring `turn` or the footprint's along /
across lean (`nsoRotate.leanNames`), turned through `nsoRotate.turn(ring, ...)`. A lean reads the tilt of the piece's upright axis from the vertical about the lean's axis;
the upright is kept (`cutRotateRef`) and re-picked only when the piece lands flat on another face or the piece / axis changes, so the reading does not jump 90 degrees when
another axis becomes the more vertical past 45 (it did, on the first version: released at 51 it read -39). A drag always gets its own Undo step (it used to merge into a
button press made less than 0.7 s before).

### Eleventh round (2026-11-07): leans pivot in place; Follow strand for the Notch

**Leans pivot in place.** The wheel's Front/back and Side/side were turned through `nsoRotate.turn`, which stands the piece back on the plate after every step - so a tipping piece
rose and fell. The Rotate menu's rings HOLD the piece (`hold`: pivot on its centre, through the plate where it must, seated once at the end). New in `app-rotate-handles.js`:
`holdTurn(ring, deg, {A, keep})`, `seatNow`, `seatSoon`, `undoPoint`, `holding`; a hold taken by `holdTurn` is seated and NOT baked (Cut keeps the pose in its own frame - the blade is
held in the piece's coordinates, which a bake would move) and tells Cut it has landed (`cutRotateSeated`, `app-cut.js`). The wheel takes its Undo point from `undoPoint` (the pose as it will be
seated; it does not put the piece down for it), keeps a drag pivoting through any pause (`keep`), seats it on release, and `cutActiveModel` (`app-join.js`) seats a turn still in hand before it cuts.
`nso_cut_rotate_dial_drive_check` gates it: the centre does not move through 0 -> 20 -> 50 degrees, the low end goes through the plate, a pause lands it once, a drag held still for a second keeps
pivoting, release lands it, one Undo takes it all back seated.

**Follow strand for the Notch** (`nfollow`, off by default; its own box in the Notch rows). `cutFollowOn` knows both blades; the Slice / Back / Forward rows moved out of the Sized fields into a shared
block under both, labelled Gap for the Notch; depth / width are raised only for the Sized blade. Found while testing: a plane square to the cord next to the wall of a nick cuts a section 7-10% short
(the cord curves, the nick's walls do not), so the `ok` gate on a section's area is now 0.95..1.06 (was 0.8..1.25); on a clean faceted cord the area spread is 0.996..1.001.

### Twelfth round (2026-11-07): the wheel spins in place about one line, and reads the true turn

From a screen recording of the wheel on the Connector string, Front/back ticked: the piece jumped and tilted freely above the plate, the wheel read 0 with the disc standing on its
edge, read 30.7 after an Undo had put it flat, and a reading of -4.8 sat on a piece nearly upright. Four causes, all in `app-cut.js`:
- **Free tilting.** The lean's ring was named from the footprint afresh at every step (`nsoRotate.leanNames`), and a tipping disc's footprint changes shape (a near-square one swaps
  its long side), so successive steps turned it about different axes. `cutRotateSession` now picks the ring and its world axis once and holds them (`holdTurn` is always given `A`), re-picking
  only when the piece's turn is not the one the wheel last left (Undo, Redo, the Rotate menu, another tool).
- **Jumping.** `holdTurn` armed a 600 ms timer that stood the piece on the plate - up off it, mid-spin. The wheel's turns now arm none (`keep: true`); `cutRotateSettle` lands the piece when the
  wheel is done: another axis ticked, a press outside `#edit-card` (a capture listener), Cut (`cutActiveModel`), `closeCutter`. A drag's release no longer lands it either.
- **Re-basing.** The lean reference was re-picked when another face came within a degree of upright, so the reading fell to 0 at 90 with the piece on edge. It is now the piece's own upright
  (`k`, `sgn`, in the BODY frame - mesh turn x `nsoBakedQ` - so a bake does not move it), kept for the piece and the axis: 90 reads 90, 120 reads 120.
- **Stale after Undo / Redo.** `undoLast` / `redoLast` (`app-core.js`) now call `cutAfterPoseUndo`, which has the wheel and the blade read the pose that came back.
Found on the way: landing the piece re-syncs the card, which unticked the box just clicked (the handler now reads the tick first). Redo closes and reopens the Cut tool (nsoHelpers.teardown), as
it does for every helper, so the card starts again after a Redo - left as it was.

### Thirteenth round (2026-11-07): no plate line - a ball on the blade's top end; a 90 degree mitre button

Asked for: the strip that marks where the blade's plane meets the plate removed ("it floats around during rotate"), a ball on the blade's top end in its place as the grab handle, and a 90 degree
button under Square. `app-cut.js`: `cutBuildPlateLine` / `cutPlateLineWorld` / `cutPlaceLine` and `userData.plateLine` are deleted; `cutBuildBall` (a 2.4 mm sphere, no depth test, a cut handle) is built with the full
and the sized blade and `cutPlaceBall` puts it on the top end from the cut frame's `upCut` (less its part along the plane's normal; the first axis across the plane when the plane lies flat) on every update. `app-core.js`:
a press that reaches the ball before the piece behind it takes hold of the blade (the piece pick ignores helper objects, which made the ball a click on the piece); and a drag from the helper now starts from the point
taken hold of (the ball's centre, which is on the plane) instead of a plane through the blade's centre - the first reading used to jump the blade (13 mm from the ball on an oblique view).
`index.html` / `styles.css`: `btn-cut-miter-90` stacked under Square (`.cut-dialbtns`); `setCutMiter(90)`. Tests: `nso_wire_cut_blade_view_test` (its plate-line gates became ball gates: on the plane, on the top end,
drawn through the piece, pickable, no plate line anywhere), `nso_wire_cut_grab_test` (a real mouse press on the ball from a diagonal camera takes hold without moving the blade, and a drag slides it),
`nso_wire_cut_tip_test` / `nso_wire_cut_yaw_test` (they held the cut face to the plate line's direction and extent; that geometry is now `__planeTrace` in the tests, the app no longer draws it),
`nso_cut_rotate_dial_drive_check` (the 90 button: layout, mitre 90, the blade's normal a quarter-turn on, Square back), `nso_wire_cut_redesign_test` (control order).

### Fourteenth round (2026-11-07): the ball moves to the top corner, on a bar, in the blade's own colour

Asked for (from a sketch): the ball out past the front corner of the blade's top edge, on a small bar to that corner, not floating; then, "an extension of the blade, same colour, not yellow". `cutBuildBall` makes
a ball and a bar from the blade SHEET's material (colour, opacity 0.38, transparent, double-sided, no depth test) - transparent matters: an opaque ball is drawn before the translucent plate, which (no depth written) then
paints over it from straight above (three camera angles in `nso_wire_cut_blade_view_test` found it). `cutPlaceBall` takes the blade rectangle's corners, keeps the ones furthest along `up` (the top edge's two ends when the
blade stands square to the frame), picks the one toward the front and left of the home view (the world direction (-0.5, 0, 1): continuous in the blade's turn), runs the bar outward along the top edge from 0.6 mm
inside the corner (`CUT_BALL_INSET_MM`) for `CUT_BALL_BAR_MM` + the ball's radius, and puts the ball at its end. A press on the bar grabs like one on the ball (`app-core.js`). The blade-view test now gates: ball on the
plane at the height of the top edge, bar 0.6 into a top corner and ending at the ball, ball and bar the sheet's colour and translucency (not the frame's yellow), the front-left corner chosen, drawn through the piece.

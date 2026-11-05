## Contact skin on a face + Seat against the skin's tips (2026-09-16)
`nso_skin.js` (pure geometry, browser + Node), `app-skin.js` (the **Skin face**
button and pattern select in the Join card), `NSO_seatFlushBitToHull` gap mode
in `app-join.js` (tips reference). Samples: `fixtures/skin-samples/`
(`npm run skin:samples` regenerates, the test fails on drift). Check:
`npm run skin:test` (`tools/nso_skin_test.js`, in `npm test`).

**Audit before building.** Nest had no way to put a pattern on an existing
face. What existed: the sibling branch `claude/breakaway-coupon-*` builds
`ring` / `grid` anchor tips as their own closed shells sunk 0.2 mm into a
coupon body (`tools/breakaway_coupons.py` + `tools/meshlib.py`, volumetric
overlap, never on `claude-wip`); the app's bakes (Soften, Smooth, Repair,
Solidify, Thicken, inside corners) reshape a piece but none add relief to a
face. `nso_mesh_triangulator.js` and `skin_join_test.stl`, referred to in the
ticket, exist on no branch of this repository. So this is new, written to
the house shape: one pure module, one wiring file, one harness test.

**What Skin face does.** Picks the planar face of A whose normal best matches
a direction (toward B in a Join session, else +Z / top), outermost if several
are parallel; requires its boundary to be a rectangle. Removes that face,
builds the relief over the same rectangle with the original loop as its
perimeter, and re-fans every wall triangle that borders the face so each new
perimeter vertex is shared - one closed shell, Euler 2, 0 piercing on every
pattern, volumes match the analytic relief volume to 1e-3 (test part 1).
Patterns: `crosshatch` (ribs both ways, 0.42 wide, 1.2 pitch, 0.6 tall - the
fine mesh; the v8_FINAL printed interface is not in the repo as geometry, so
these are stated defaults, all parameters), `zigzag` (sawtooth-section
ridges, 0.42 crests, 2.0 pitch), `ring` (the coupon anchor tip, r 5, wall
0.8 -> 0.4, 1.0 tall). `mode: 'recess'` cuts the valleys down instead and
keeps a rim at the margin (needs margin > 0; ring is raise-only). Undo type
`skinReplace`. **PAINT SCOPE: sub-region** - only the face being skinned is
checked (`nsoMaskIsExcludedRaw` with the picked plane, axis and side when
axis-aligned); paint on any other face does not block, and those faces are
untouched by construction. A painted target face stands it down by name.

**The two surfaces, and which one Seat measures.** A skinned face has a base
plane (the floor between features) and a tips plane (rib tops / crests /
ring top, `height` above the base). The four corner rays Seat has always
cast land on whichever is under each corner - on the sample pairing all four
land in valleys - so a gap measured that way would seat B `height` deep in
the relief and print a solid fuse. Gap mode now probes first:
`NSO_Skin.supportExtreme` takes the hull's outermost point along the bit's
normal over the bit's FOOTPRINT (every hull triangle clipped to it, so a rib
whose end vertices lie outside the footprint still counts where it passes
under B), and compares it with the corner-ray plane. Rise > 0.01 mm
(`NSO_SEAT_TIPS_TOL`; a relief is a printed layer or more, a flat Float32
face measures ~1e-6) means a skin: B is translated along its own normal so
its mating face sits `gap` off the TIPS, untilted, and the result carries
`reference: 'tips'`, `tipRise`. A flat hull takes the corner-ray path
unchanged - `tools/nso_seat_gap_test.js`'s golden pose still holds to 1e-9 -
and reports `reference: 'plane'`. The status line appends
`- from skin tips, relief 0.60mm above the base plane`, so a seat that
measured from the wrong surface can never read the same as one that did not.
Limit: tips mode assumes B's mating face is parallel to the skinned face
(Center X/Z, upright); it does not tilt-fit a skin.

**Samples** (`fixtures/skin-samples/`, Z up, mm): A 30 x 30 x 8 on z = 0,
skinned on +Z; B 20 x 20 x 6 centred, underside on the tips (gap 0). One
`_block.stl` per pattern holds both shells (split to objects in the slicer,
or import the `_A` / `_B` singles, which share coordinates);
`skin-samples.json` carries the numbers. Measured through
`tools/mesh_validate.py --json` (test part 2): A alone Euler 2, 0 piercing,
0 coplanar; A+B 0 open, 0 non-manifold, Euler 4, volume = A + B to 1e-6,
exactly two edge-connected shells, A's highest z == B's lowest z bit for bit
(zero penetration), that plane 0.6 (ring: 1.0) above the base plane, coplanar
contact seen. Contact under B: crosshatch 234.6 mm^2, zigzag 84.0, ring 11.55
(of a 400 mm^2 footprint). Controls: gap -0.05 -> 0 piercing, 0 coplanar,
shells 0.05 apart; +0.05 -> piercing. As with the Seat-gap check, gap 0 also
reads as piercing pairs in the checker because rib walls stand edge-on in
B's plane and it has no touching-along-an-edge class; the -0.05 control and
the exact z equality are what separate touching from penetration.

**Reachability (audited 2026-09-16, second pass).** Both are wired in the
live app, not only committed: `index.html` loads `nso_skin.js?v=skin1`
before `app-core.js` and `app-skin.js?v=skin1` after `app-join.js`; the Join
card carried `#btn-skin-face` + `#skin-pattern` (crosshatch / zigzag / ring)
- **moved to the Finish tab later the same day, under the paint row, see
"Face select"** - and, from the Seat-gap commit, `#seat-gap` (now a slider
under `#btn-seat-support`, see "Seat with a gap"). The
mirror workflow run for `7ed4821` succeeded and the `nest-wip` tree carries
the same `index.html` (README source SHA matches), so the preview site at
<https://nolongerzzz.github.io/nest-wip/> serves it once Pages finishes its
deploy. Nothing needed wiring.

**Drive check** (`npm run skin:drive`, `tools/nso_skin_drive_check.js`, in
`npm test`): the whole flow through the shipped controls, on the real
fixtures box_hull_80x40x20-2 (A) + box-20mm (B): file input, Start Join,
Pick A / Pick B via the slot buttons and the list rows, Raise x11, pattern
select, Skin face, `-0.18` typed into the gap field, Seat flush, Format = STL,
Export plate - and the browser's actual download through `mesh_validate.py`:
two shells 0.18 apart, hull 20.6 tall, 0 piercing, 0 coplanar, height 40.78.
Then Undo x2, ring, gap 0, Seat, Export: hull top == bit bottom, coplanar
contact, height 41. The one step that is not a click is moving B over A
(there is no button; a viewport drag calls `selectPlaced` + `nudgeSelected`,
which the check calls directly and labels as such). `APP_URL=<site>` points
the same check at a deployment; the harness serves the three.js CDN tags
locally either way. Not run against the preview site from the sandbox - its
egress policy blocks `github.io` - so that run is the user's, or a runner's.

**Through the real app** (test part 3): plain block A + box-20mm B, Seat 0 on
the flat A -> `reference 'plane'`; Skin face -> A's raw soup replaced, 8.6
tall, undo restores 12 tris; painted +Z stands down, paint on -Z does not;
sphere refused; Seat 0 on the skinned A -> B's underside on A's world top to
2e-6, hull height 8.6 (not 8), status names the tips, core `tipRise` 0.600,
`gapAchieved` 0; Seat -0.18 -> plate export 2 shells 0.18 apart, 0 piercing,
0 coplanar, height 28.78; Seat +0.05 -> 0.05 into the relief.

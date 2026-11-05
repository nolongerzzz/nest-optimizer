## A skin pattern as its own printable object - the patch (2026-09-17)
`nso_skin.js` (two additive exports, `planeFrame` and `patternPlan`, plus the
audit written out next to them), `nso_skin_patch.js` (new: both variants),
`app-skin-patch.js` (new: the **Skin patch** button, which ADDS a piece rather
than replacing one), `index.html` (a third `.vp-row-skin` row in the Finish
tab), `fixtures/skin-patches/` (six STLs + `skin-patches.json`). Checks:
`npm run skin:patch` (`tools/nso_skin_patch_test.js`, 111 gates),
`npm run skin:patch-drive` (`tools/nso_skin_patch_drive_check.js`, 73 checks
through the shipped controls and the real export path),
`npm run skin:patch-fixtures` (byte-diff of the committed fixtures). All three
are in `npm test`.

Asked for as the standalone counterpart to Skin / Skin wrap: bake the relief
pattern alone, floating, like a washer you can test in isolation.

**Audit first (Task 1), and the answer is two-sided.** The question was
whether `nso_skin.js` builds the relief as an independent geometric structure
before fusing it onto a host face, or whether generation is inseparable from
fusion. It is independent, and measured rather than read:

- `crosshatchPlan` and `zigzagPlan` are pure functions of a frame and their
  parameters. They return a HEIGHT FIELD - `breaksU`, `breaksV`,
  `cellHeights` - not geometry. `gridRelief` and `ringRelief` turn that into
  triangles reading only the frame and its `sides`, and never the soup being
  skinned. The soup enters at exactly four places, all of them about the
  HOST: `findFace` (which face), `rectFrame` (the frame, from that face's
  boundary loop), `registerWallVertices` and `fanWalls` (the seam).
- The proof: skin the same 30 x 30 +Z face on a 30x30x8 block and on a
  30x30x2 plate, and the relief triangles come back BIT-IDENTICAL - 9402
  crosshatch, 434 zigzag, 864 ring, every one equal - while the host wall
  fans differ. Part 1 of the new test asserts it.

**But the independent structure is not a printable object, and that is what
decided the design.** Taken on its own the relief is a zero-thickness OPEN
SHEET: Euler 1, 196 / 116 / 96 open edges, bbox height exactly the skin height
with nothing below it. `gridRelief` emits the top surface and the walls
*between* cells and stops; the back, and the watertightness, come from the
host. So "export the pattern alone" cannot be keeping the relief triangles and
dropping the rest - what comes out has no thickness and no back.

The path that works was already in the file: `freeLayerShell` gives its free
second layer **a host of its own** (a `boxSoup` slab) and calls
`applySkinToFace` on it. Both variants generalise that, and the two additive
exports are what a caller outside the module needs to do it - a frame built
from numbers instead of from a boundary loop, and the height field behind it.
Nothing in `nso_skin.js` changed behaviour: `tools/nso_skin_samples.js`
regenerates all nine committed skin samples byte-identically, and the skin and
wrap suites are untouched.

**What Skin patch does.** `NSO_SkinPatch.buildPatch(opts)` returns a soup and
its numbers; `NSO_skinPatchAdd` hands that to `addModelFromZUpGeometry`, the
same ingest path an imported STL takes, so the patch arrives with `rawTris` in
file axes and every later tool - Seat, Repair, *Check piece*, both exporters -
sees an ordinary piece. It is **not** a bake on the selection: it adds a piece
and leaves every existing one alone (the drive check loads a cube, bakes all
six patches, and the cube's triangle count, size and flag are untouched). Its
paint scope is therefore NONE rather than sub-region - it reads no existing
geometry at all.

- **bordered**, the washer. A closed TRAY - a 1.2 mm rim standing on a 0.6 mm
  floor membrane - whose POCKET FLOOR carries the relief, skinned by
  `applySkinToFace` itself through `findFace`'s plane offset: the shipped
  inner-face path, the one a selected pocket floor already uses. So the seam
  work, the perimeter subdivision and the wall re-fanning are the validated
  code and none of it is copied. The rim stands 0.6 mm PROUD of the tips, so
  the rim takes the handling and the relief does not. One closed shell,
  Euler 2, 30 x 30 x 1.8 mm (2.2 for the ring).
- **loose**, the raw patch. The pattern's features as SOLID BODIES and nothing
  else: no rim, no backing plate. Built from `patternPlan`'s height field as
  the solid `{ 0 <= z <= h(u,v), h(u,v) > 0 }`, meshed as a cell complex over
  the plan's own grid. The gaps between features really are empty - the test
  measures volume against the bounding box rather than asserting it
  (crosshatch 57.7%, ring 17.3%). The ring, which has no height field, is
  built as what it is: a closed tapered annulus, 10 mm across.

**Thickness (Task 3): every figure reused, none invented.** `MIN_WALL` 0.42 mm
is `nso_skin.js`'s own crosshatch rib and the threshold `mesh_validate.py
--min-wall` carries; the 0.6 mm floor and the 0.6 mm proud are
`freeLayerShell`'s `sheet` default; the 1.2 mm rim is the crosshatch `pitch`.
The footprint is 30 x 30, `A_SIZE` in `tools/nso_skin_samples.js`, so a patch
and the skin sample it came from are the same pattern over the same area. The
one-line guard is on each pattern's BASE section, never its tip: the zigzag and
the ring taper on purpose - minimal contact is the point of them - and the
ring's shipped `wallTip` is 0.4. `buildPatch` reports `minWall` and `tipWall`
separately so the taper is visible instead of averaged away.

**Three defects found by measurement, each fixed and each now gated.** All
three were invisible to a closure check alone, which is why they are worth
recording.

1. *The tray's T-junctions.* Written out the obvious way - one bottom quad,
   four outer walls, a rim frame, four pocket walls - the rim frame's inner
   edge ran the full width while the pocket walls met only part of it. The
   bare 28-triangle tray came back with **16 open edges, 10 piercing pairs and
   Euler -2**, and every bordered patch inherited them (2590 piercing pairs on
   the crosshatch). Fixed by building the tray as a height field over the
   3 x 3 grid `[0,i0,i1,W] x [0,j0,j1,D]` and handing it to the same solid
   builder the loose variant uses, where every cell edge is shared by exactly
   two cells. 68 triangles, Euler 2, clean.
2. *The relief landing in the pocket wall's plane.* At `margin: 0` the pattern
   runs to the pocket's edge and its end walls land IN THE PLANE of the pocket
   wall - the collision `freeLayerShell` already guards its sheet against.
   **2488 piercing pairs on the bordered crosshatch, 868 on the zigzag, with
   0 open edges and Euler 2 throughout**, so only the self-intersection check
   saw it. The bordered variant's margin is now `MIN_WALL` and `margin: 0` is
   refused by name.
3. *A third height on a node.* The loose zigzag's flank is a 33-degree wedge
   whose perpendicular distance to its own underside is **0.367 mm on all 30
   flanks** - under one extrusion line, and a real feather edge at the build
   plate, not a measuring quirk. Fixed with a 0.42 mm vertical FOOT under each
   feature's own footprint (`LOOSE_BACK`, per pattern: the crosshatch's ribs
   are prismatic and read 0.42 as they are, the ring's taper is 11 degrees off
   vertical and reads 0.566, only the zigzag needs one). The foot then put a
   third height on the corner where a tie cell, a flank cell and an empty cell
   meet, and one quad per grid edge cannot subdivide for it: **180 open edges**,
   with ties alone and a foot alone each clean. Fixed by splitting each wall at
   ITS OWN end node's height set and zippering the strip between the two
   chains, the way `ringRelief` already zips its floor to the rectangle.
   (Splitting both ends at the union of the two nodes' levels is wrong in the
   same way as not splitting at all, and was measured being wrong.)
   `gridRelief` upstream emits one quad per edge and is correct only because
   the shipped patterns never put a third height on a node; the new builder
   cannot borrow that assumption, and carries a `crossings` counter so a
   future pattern that needs a mid-span vertex cannot do it silently.

**Ties.** A pattern whose features do not touch each other is several loose
sticks and not a patch you can pick up: the zigzag's ridges are parallel and
share nothing, and `ties: 0` really does come back as **15 separate closed
shells, Euler 30**. So `loose` adds two cross-ribs one extrusion line wide,
merged into the same height field rather than resting on it, and the patch is
one component (Euler -26, genus 14 = 15 ridges x 2 ties). The crosshatch needs
none - its ribs cross - and the ring is one body already.

**The non-solid flag (Task 4), and the honest answer is not the expected one.**
`loose` defaults to FLAGGED and `bordered` does not, but not for the reason the
ticket assumed, and the difference matters enough to state plainly: **every one
of the six patches is a CLOSED shell.** 0 open edges, 0 non-manifold, 0
degenerate, 0 piercing, all six. They pass `--gate` and `--gate --non-solid`
alike, and part 4 of the test runs both on all six. So the flag is *not* what
stands between these files and a pass, and section 3's "declare `--non-solid`
if intentional" is not doing any work here.

- **loose is flagged anyway, as a declaration.** It is a free-standing
  one-extrusion-line lattice, which is the printable-fabric case
  `docs/NON-SOLID.md` names, and the stages the flag stands down - Repair's
  hole fill, flap peel and orphan-component drop - are exactly the ones that
  would quietly trim it if it ever stopped being closed. That is the same kind
  of declaration Skin's free layer already makes: nothing is measured off the
  mesh, the user chose a construction, and the bake says so in its status.
- **bordered is not flagged, and the rim question is answered by measurement
  rather than assumed.** The rim does not "enclose" the pattern topologically -
  the relief is open to the air above, as any washer's mesh is - but it does
  not need to: the piece is one closed shell either way, and the rim's job is
  mechanical. Flagging it would only remove a check it passes.
- The wall/gap check the flag turns on is the interesting one and all six pass
  it: crosshatch 0.420 mm (the ribs, at threshold, as on the skin sample),
  zigzag 0.420 with the foot and 0.600 bordered, ring 0.566 both ways.

**Numbers the fixtures carry** (`fixtures/skin-patches/skin-patches.json`,
byte-diffed by `npm run skin:patch-fixtures`):

| patch | extent mm | tris | comp | walls mm | contact mm² | flag |
|---|---|---|---|---|---|---|
| crosshatch bordered | 30 x 30 x 1.80 | 8892 | 1 | 0.42 | 409.15 | - |
| crosshatch loose | 30 x 30 x 0.60 | 13100 | 1 | 0.42 | 519.75 | non-solid |
| zigzag bordered | 30 x 30 x 1.80 | 612 | 1 | 0.60 -> 0.42 | 146.11 | - |
| zigzag loose | 30 x 30 x 1.02 | 1164 | 1 | 0.42 | 208.91 | non-solid |
| ring bordered | 30 x 30 x 2.20 | 1022 | 1 | 0.60 -> 0.40 | 11.56 | - |
| ring loose | 10 x 10 x 1.00 | 768 | 1 | 0.80 -> 0.40 | 11.56 | non-solid |

**The drive check (Task 5)** presses the shipped button six times and checks
the file the browser downloaded. Per patch: a new piece appears with `rawTris`
in file axes, the status names the variant and its walls, the non-solid state
is read off the shipped checkbox (not off the model object), then Format = STL
and **Download selected STL** - and the download goes through
`mesh_validate.py` twice, `--gate` and `--gate --non-solid`, both PASS, plus a
thickness assertion. The download is compared to the committed fixture as
GEOMETRY, not bytes: the exporter writes the piece's display geometry, which
`addModel` centres and which has been through Z up -> Y up -> Z up, so the
bytes legitimately differ. Triangle count, bounding box, volume and the
translation-invariant triangle set all match. Byte identity between the
module's output and the fixture is held separately, in part 5 of the unit
test. No page errors. `APP_URL=<site>` points the same check at a deployment.

**Not done, on purpose.** The patch is a flat rectangle like everything else
below `rectFrame`; a curved one was the "OTHER wrap" ticket above, since
landed as Texture, and nothing here changes it. The patch is not offered as a Seat target - it is a
coupon you print and handle, and Seat's footprint measurement is about an
interface between two pieces. And `bordered` does not offer a round rim: the
tray is a rectangle because `rectFrame` needs one, which is the same
constraint the rest of the module has.

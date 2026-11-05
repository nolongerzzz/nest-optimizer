## Supports print 1 - flat caps, two interface layers, one foot per cluster (2026-10-20)

Branch `claude/supports-print-1` off `claude-wip`. Write-ups:
docs/SUPPORT-INTERFACE.md (caps, line width, the audit), docs/SUPPORT-GRIDPACK.md
(*Feet*), docs/SUPPORTS-CARD.md (the feet across areas at commit).

THE PRINT (top_clip_x2, now `fixtures/supports/top_clip_x2_coupon.stl`): the part came
out clean and the sheet released, but the trees wobbled as the sheet started,
the two transition layers sagged, and half the interface welded and was torn.
Bambu's tree on the same coupon (baselineV2) has no transition layer, flat
caps of 2-7 mm under its interface and 15-24 mm pads.

- **Tips** (`nso_support_interface.js` sheet(), THE CAPS): every tip under a
  sheet ends in a round flat cap following its leg, 2.5-4 mm across in the
  last 2 mm of rise (never less rise than the column's own cut needs), the
  interface's underside on it. Caps never overlap (held 0.05 mm apart) -
  overlapping or coplanar cap tops are what the union could not take - so
  tips under 2.55 mm apart get narrower caps (the coupon's leg: 1.77 mm). Every
  cap is measured against the piece with the exact distance.
- **No transition layer**: the sheet is I1 + I2.
- **Lines**: one straight box per line, at least 2 mm, 0.43 mm wide (a 0.42
  line is a zero-width wall to a slicer: NSO's slicer broke it into the short
  pieces the owner's screenshot shows; Bambu printed each as a loop round a
  sliver - two passes, 1.8 x the bead per mm of line, in ~0.2 mm pieces).
  Single pass in Bambu needs its thin-wall detection: see the open questions.
- **Feet** (`nso_support_gridpack.js` footPads / shareFeet, FEET): one 0.2 mm
  pad per cluster of feet within 6 mm, the footprints grown 4 mm, 0.2 mm off
  the piece; trees on one pad - or on pads too near to print apart - are one
  support; one raster per group of feet; a pad round a leg of the piece is
  opened by a slot that bends between the feet. The card builds each area with
  `footPads: 'shared'` and draws the pads over every area at commit
  (`app-supports-card.js` shareFeet): the coupon is ONE support now (the
  Bambu layer-1 conflict between support 1.1 and 2.2 was two supports' pads).
- **Weld** (the reference path, not the card's): the sheet's join takes the
  carriers first, the caps' top 0.02 mm stands upright (I1's underside cuts
  that band, not the flank: cut 10 um from its top, a flank came back as
  needles NSO's slicer could not close - a lost I1 line on the clamp, a lost
  cap section on the wedge), and flat triangles are split to a fixed point.
- **Audit**: `node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf [--export
  x.3mf]` - per sheet layer the segments, mean length, E/mm, its ratio to the
  file's outer wall, the passes per line and (with the export, the g-code
  registered to it) the lines printed. On the 2026-10-20 slice: 2 passes,
  1.8 x per mm of line, 1 % of the toolpath in segments of 2 mm or more, all
  52 lines printed in each layer; Bambu's own interface 1.00 x and 90 %.
- **Export**: `npm run support:print-export` writes
  `tools/supports-print-out/top_clip_x2_supports.3mf` (as the card builds it)
  and `..._thinwall.3mf` (the same, `detect_thin_wall = 1` on the support
  objects only - an A/B file, not what the card exports). Git-ignored.
- **Tags**: `nso_support_gridpack.js`, `nso_support_interface.js`,
  `app-supports-card.js` shells1 -> print1.

OPEN, the owner's call (standing rule: ask first):
1. Should the card's 3MF set `detect_thin_wall = 1` on each support object
   (Bambu then draws each 0.43 line as one centre pass, at its thin-wall
   width: about 1.14 x the outer wall's bead per mm)? Not done.
2. Caps under 2.5 mm where tips stand under 2.55 mm apart, or overlapping 2.5 mm
   caps (fine for the card's shells; the weld reference cannot take them)?
3. The line is 0.43, outside the kickoff's 0.40-0.42: a line of 0.42 is a
   zero-width wall to both slicers and a narrower one is less than none
   (measured, docs/SUPPORT-INTERFACE.md, LINE WIDTH).

### Correction: four layers on z_cap, each a loop and a serpentine (2026-10-20, same branch)

Two corrections from the owner, from the repo's own notes and their side-by-side
slice (`thinwall_sideXside.gcode.3mf`: Bambu's tree slim on the coupon, z
12.58 / 12.86 / 13.13 / 13.40). The first build of this branch was wrong: the
caps rose 0.01 mm into I1, so their walls printed in the same layers as the
lines; every line was its own box, an island; and the transition layers were
gone. Bambu's: two transition layers and two interface layers, every one
opening with a closed loop round the footprint (22.24 x 14.34 mm), then 13.6 mm
lines with 0.84 mm turns inside it. The owner printed the loops alone, by
accident, and they released cleanly - the loop is load-bearing for release.

- **Nothing but the sheet occupies the sheet's layers.** Every cap's flat top,
  and every capless tip's cut, is ONE level, z_cap; T1's underside is z_cap.
  Faces meet, no overlap; the layers above stand on each other the same way
  (T2 is T1: set 2 um into it, the walls stood in one plane and the union left
  2 piercing pairs on the clamp's area 1). For the weld only, T1's underside
  goes 0.015 mm into the caps (`SHEET_SINK_MM`): on one plane the union left a
  T-junction where a T1 wall met a cap's top (2 pairs, the clamp's area 2).
  The parts and the export keep z_cap exact.
- **T1, T2, I1, I2** (`SHEET_ROLES`), each a closed loop round each piece of
  the footprint and one serpentine inside it, its turns the loop's own sides
  between line ends: T1 = T2 = I2 along A, I1 across, all in one loop. One
  graph per layer through `extrudeFlat`: one connected thin wall, its section
  one region (the channels its holes) whose outer boundary is the loop, one
  bead wide. The coupon's slab: a 21.84 x 14.28 loop, 25 lines of 14.28 mm
  (27 with the loop's sides; Bambu's 29 in 22.24 x 14.34), I1 16 of 21.84.
- **The pieces**: the sheet lies on a grid at the pitch both ways; a cell is
  the sheet's when its edges lie in the cap field (caps dilated 1.25 mm,
  `FIELD_MM`, in the free raster); runs under 2 mm and corner-only contacts go;
  each 4-connected set carrying two caps or more is a piece with ONE loop
  round its outline (stepped, rectilinear, as Bambu's loops follow the region;
  a ring's hole joined to it by a slit) and ONE serpentine inside, its turns
  walked along the loop. A piece whose largest rectangle carries every cap it
  does is that rectangle: the coupon's slab and leg are one rectangle each.
  The clamp: area 1 one stepped piece (57 x 58 mm, its ring round the boss)
  carrying 172 tips, area 2 one (22.7 x 20.2 mm) carrying all 45 - one
  serpentine a level carried 161 and 34, one rectangle 84 and 14;
  `support:interface` holds 161 / 34 as floors.
- **Caps spread before they narrow**: z_cap is 0.4 mm lower than before, where
  the coupon's converging legs stand 2.16 mm apart; caps slide apart within
  their slack, checked where they land: the slab's are 2.50 mm again.
- **A carrying tree's own members under z_cap no longer block the footprint**
  (the deeper stack's band had caught the coupon's 1.7 mm trunks' nodes).
- **Gates** (`support:interface`, 131): caps end at z_cap and T1 lies on it,
  measured on the parts built; every piece of every layer a closed loop and
  one serpentine inside it, turns on the loop, T2 and I2 T1's; each layer's
  mid-layer section one region a piece, its outer boundary the loop one bead
  wide (a rectangle +-0.1 mm, or the stepped outline: edges on the axes, area
  the loop's polygon grown half a bead); the coupon's slab ONE rectangle; the
  clamp's coverage floors; NSO's slicer prints every layer in closed paths
  none under 2 mm; no geometry above z_cap but the sheet under its paths.
- **NSO's own slicer prints loops, not one pass** (it has no thin-wall mode:
  the outline's loop and one round each channel, two passes over each line).
  That is a slicer ticket (`nso_slicer.js`), not this one; not touched. `support:audit`'s export reader reads these
  layers (walls paired by their material side).
- **Width matrix**: `support:print-export` also writes the coupon at 0.40 /
  0.36 / 0.30 mm lines with `detect_thin_wall = 1` on the supports
  (`top_clip_x2_supports_w040_thinwall.3mf` ...), for Bambu; NSO's slicer
  prints nothing under a bead.
- **Tags**: print1 -> print2 (`nso_support_gridpack.js`,
  `nso_support_interface.js`, `app-supports-card.js`).
- **Fixture**: the coupon is `fixtures/supports/top_clip_x2_coupon.stl`
  (#252's slicer:supports owns `top_clip_x2.stl`, a different piece).
- **For this print, as the owner said**: the leg's caps stay 1.66-1.78 mm; the
  card stays at 0.43 mm lines without thin walls until the width matrix says
  otherwise.

### Correction: the serpentine stands apart from the loop (2026-10-20, same branch)

The owner's plate (`thinwall_supports_bambu.gcode.3mf`): our sheet layers
printed 610-856 mm in 1,350-2,700 segments, Bambu's 434 mm in 54 - the jail-
cell-bars bug. The serpentine's U-turns lay on the loop's centreline, so loop
and lines fused into one region with every channel closed, and the slicer
traced every channel: each line twice.

- **Two thin walls a piece, apart.** The serpentine runs on the piece's inner
  grid points only (all four cells round the point the piece's): every line
  and turn a pitch off the loop, a clear gap of 0.41 mm (a line width; Bambu's
  turns stand 0.36 mm in from its loop). The loop is one closed wall, the
  serpentine a second, connected one; each drawn once. The 0.43 line stays.
- **Pieces**: a field piece is its largest rectangle where that carries as
  many caps as its column strips do (the coupon's slab and leg: one each),
  else its strips - a column that splits round a hole, or where two meet,
  goes, a pitch between two loops: the clamp's rings are four strips each,
  each its own loop and serpentine (no slits now). The clamp carries 176 tips
  in area 1 and 45 of 45 in area 2.
- **A cap is carried** when a wall of T1, loop or serpentine, either way, lies
  across it with its whole width on it (the serpentine standing in, a cap
  near the loop's short side is on the loop, not on a line along A).
- **Direction**: T's lines 2 mm or longer where a piece allows it one way only
  (the coupon's leg, three cells across: T along it, two lines of 11.76 mm;
  I1 across, 15 lines of 0.84 mm - as Bambu's own I1 there, 55 % one way).
- **Gates** (`support:interface`, 131): every piece a closed loop and one
  serpentine a pitch inside it, never touching it; each layer's section
  exactly TWO regions a piece (loop, serpentine), no hole but the loop's own
  inside, the ring between the loop's outline and its hole the loop's
  perimeter x a bead; NSO's slicer draws each layer in those two regions,
  every path closed, none under 2 mm (the loop as its sliver's two contours,
  the serpentine as one - no thin-wall mode, a slicer ticket); a layer whose
  lines are under 2 mm on the whole is read from the plan, and says so.
- **Export**: the 0.43 thin-wall override is gone (nothing for it to detect at
  0.43); the card's 0.43 export and the 0.40 / 0.36 / 0.30 width matrix stay.

### The serpentine joins its loop at one point; why Bambu drops the narrow lines (2026-10-21, same branch)

- **The bridge.** Each serpentine starts one grid step from a loop vertex and
  that step is laid as a stub (`bridged` in `nso_support_interface.js`; a
  serpentine whose start has no loop vertex a step away runs reversed). Loop
  and serpentine are one connected thin wall with one hole: one slicer path a
  layer, as Bambu's (54 extrusions, 3 travels). Everywhere else the 0.41 mm
  gap stays. The plans are otherwise unchanged (same pieces, lines and caps).
- **Gates** (`support:interface`): each layer's section is ONE region a piece
  with ONE hole, the outline the loop grown half a bead (rectangle within
  0.1 mm, or a rectilinear outline of the right area), the hole within the
  loop shrunk half a bead, no region apart. The serpentine's first point is on
  the loop and every other point a pitch or more off it. NSO's slicer draws
  2 closed paths a layer on the coupon's slab (743.8 and 72.3 mm, about 2.1
  passes). The pitch reader now pairs a line's two edges only across that
  layer's own material. The 0.41 mm gap is all but a bead wide, and one
  serpentine's last line, a single pitch long, had left one edge unpaired, so
  the reader read a gap as a line (clamp area 2, I1: 3 off the pitch).
- **Bambu and 0.40 / 0.36 / 0.30** (read in Bambu Studio's source; the
  owner's gcode will confirm). Their process is classic walls with thin walls
  off. That shrinks each island by half the outer wall (0.21 mm): 0.43 keeps
  a 0.01 sliver, drawn round out and back (807-814 mm a layer), and anything
  under 0.42 vanishes. `min_feature_size` is Arachne's and does nothing here.
  Our `detect_thin_wall = 1` is where Bambu reads it (`model_settings.config`,
  `<object id="2">`, the support), and the importer takes it from any vendor.
  But `Plater::load_files` resets every object's config when a 3MF is loaded
  without config: **File > Import / Add**, or "Import geometry only" on a
  plate that already has objects. Likely cause: the override is wiped on
  import. To test, open the 3MF as a project, or set Detect thin wall on the
  support object by hand. The 24 sheet-layer shells of the three exports are
  each closed and manifold (0 open, non-manifold or mis-wound edges, no
  self-intersection), sections 2A/P = 0.400 / 0.360 / 0.300 mm.

### The line is 0.40, printed by the thin-wall pass (2026-10-21, same branch)

The owner's correction: with the classic wall generator and Detect thin wall
on (Strength > Walls), Bambu Studio prints a 0.40 sheet line in one pass
(filament 1.09 m, against 1.03 m without the sheet and 1.14 m for the 0.43
sheet drawn round its sliver).

- **Width**: `SHEET_UNDER` 0.95 of the bead (`NSO_Thickness.floorFor`, nozzle x
  1.05), to the 0.01 mm: 0.42 x 0.95 = 0.399 -> **0.40** at a 0.4 nozzle (the
  header says so; nozzle x 0.95 would be 0.38). The pitch stays 0.84, so the
  gap beside the bridge is 0.44 mm (0.41 was at 0.43).
- **Overrides on every support object**: `NSO_SupportInterface.SHEET.slicerSettings`
  = `wall_generator: classic`, `detect_thin_wall: 1`. `nso-3mf.js` writes an
  object's `settings` as its metadata in `Metadata/model_settings.config`; the
  Supports card sets `m.slicerSettings` on each support model, and
  `buildPlacedObjects3MF` / the selected-model export pass it on (pieces
  without it export as before). In Bambu Studio's source both are per-object
  options (`PrintObjectConfig::wall_generator`, `PrintRegionConfig::detect_thin_wall`),
  read from object metadata for any vendor's 3MF; `Plater::load_files` resets
  them when a file comes in as geometry only, so **open the export as a project**.
- **The bridge** (the previous entry) stays: one connected thin wall, one path
  a layer.
- **Gates**: `support:interface` holds the one region a piece, the loop's
  inside the only hole; NSO's slicer, with no thin-wall mode, must draw
  nothing of a sheet under a bead (no path, nothing broken off). `support:test`
  checks the 0.40 width and the two settings; the clamp carries 175 tips in
  area 1 (176 at 0.43, floor 161) and 45 of 45 in area 2. `export:roundtrip`
  checks that a model's settings go out on its object alone.
- **Export**: `npm run support:print-export` writes only
  `top_clip_x2_supports.3mf`, the card's export (0.40, both overrides). The
  width-matrix files are gone; `sheetWidthMm` still sets another width.

### NSO's slicer prints the sheet as Bambu does: the thin-wall pass (2026-10-21, slicer-thin-wall)

Bambu Studio with classic walls and Detect thin wall on prints the 0.40 sheet
line in one pass. NSO's own slicer (G-scope's Slice view) had no thin-wall
mode, so it drew nothing of a 0.40 sheet. Without interface or transition
lines, `slicer:supports` and `gscope:select` §10 lost their support rows
(#256's CI). It now has the pass (docs/SLICER.md, "Thin walls").

- **The rule** (`nso_slicer.js` `thinWalls`): a piece of a layer narrower than
  1.05 x the bead is printed as ONE pass down its medial centreline, at the
  bead's width, and comes out of the region. The 1.05 is STATED, so the 0.43
  sheet is one pass too. A corner or junction speck under half a bead doesn't
  count, and a wall under 0.13 mm is nothing. Everything wider keeps its walls
  and infill. Classic semantics, not Arachne.
- **The centreline**: rasterise at 20 px a bead, Zhang-Suen skeleton, prune
  spurs under a bead, place corners where the least-squares lines cross, then
  Euler-trail it into the fewest paths. A closed loop is one closed path. A
  serpentine joined at one point continues it: loop, then snake, no travel.
- **Who**: support objects on (every NSO support carries
  `detect_thin_wall = 1`). Parts off, as both real profiles are. An object's
  `detectThinWall` overrides either. No UI changed.
- **Typing**: unchanged. The sheet's passes are `Support interface` for the
  top 2 layers and `Support transition` for the 2 below.
- **Gates**:
  - `support:interface`: the #256 assertion is flipped. Every sheet layer of
    the coupon, the clamp, the shelf, the tab and the tall is ONE path a
    piece, the plan's centreline to 3 %, none under 2 mm, no line drawn
    twice. The coupon slab gives 408 mm in 55 moves.
  - `slicer:supports`: 26/26. The interface / transition counts are exact.
    The readout check now accepts "held by support" for the clip the 0.40
    sheet covers whole.
  - `slicer:test` §9: a strip, a ring, a loop with a serpentine, a fin on a
    block, the 1.05 threshold, and 32 repo-mesh slices pinned byte for byte
    with the flag off and on.
  - `slicer:bambu` §5: the coupon export at 0.40 and 0.43. There is one path
    per sheet layer; the slab is within 10 % of the record (Bambu: 54
    extrusions, 434 mm); the audit tool reads every line printed once, at the
    outer wall's E/mm.
- **Against Bambu's own slice**: `fixtures/supports/top_clip_x2_supports.gcode.3mf`
  is the owner's breakawayV1 slice of this export. It registers at −1.650 mm
  in x, and 100 % of the export's lines land on toolpath.
  - Per sheet layer, NSO and Bambu are both one connected drawing with every
    line printed. NSO's total is 0.5 - 3.6 % over Bambu's.
  - Bambu draws each layer in 2 runs (a seam mid-serpentine on the slab; the
    loop, then the serpentine, on the leg). NSO draws one, as the kickoff
    asked. That is recorded as a finding, not forced to match.
- **Audit tool**: `exportSheetBoxes` read 0 lines on #256's export, because
  stacked sheet layers weld into one piece taller than its 0.5 mm limit. It
  now reads such a piece band by band (129 lines on the coupon). Its
  per-layer record carries `chains` (runs of extrusion), and with `--export`
  also `runs`, `runMm` and `drawings` (runs joined where an end meets
  another).
  - `registerShift` searched ±1.5 mm, and breakawayV1 sits 1.651 mm off. A
    sheet's lines a pitch apart let a one-pitch-wrong shift (−0.815) lay all
    but one line a layer on toolpath. It now searches ±3 mm, sampling every
    6th point in the coarse pass.
  `nso_supports_print_export.js` exports `build` for `slicer:bambu`.

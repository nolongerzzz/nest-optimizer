## Supports one trunk - Auto grown the way Bambu's tree slim grows (2026-10-26)
Branch `claude-wip`. Engine: `nso_support_gridpack.js` (`planOneTrunk`, `thinTips`, `clusterTips`, `zBands`, `oneTrunkGroups`,
`insideSigned`, crown knobs `tipRiseMm` / `trunk.footClearMm` / per-zone `maxKids`, `ONE`), `nso_support_interface.js`
(`interfaceLayers`, `SHEET.densePitchMm`, the strip-length test), `nso_slicer.js` (`supportInterfaceLayers`). Card:
`app-supports-card.js` + `index.html` (the **One trunk per cluster** box, the **Interface** select, `groupAreas`). Gate:
`npm run support:onetrunk`. Docs: `docs/SUPPORT-ONE-TRUNK.md` (the whole story and the table), `docs/SUPPORTS-CARD.md` section 9.

- **Why #301 "came back further":** it laid sheets and stairs under every tip and left the tree (its own table: "trunk count
  unchanged"), so the six reference heads still stood 6 / 23 / 3 / 3 / 6 / 3 trunks of square posts where Bambu stands one.
  This ticket merges #301's interface engine in (its seven commits are in this branch's history: merge `7879274`) and does the trunk.
- **The six real heads, flat, Auto, box ticked:** one trunk each (Bambu's NegSphere2 has two); every spot held (Base: 8 tips stand, the other 12 spots
  are held through the tip beside them) or named; the trunk's axis 0.3 - 1.5 mm from the middle of its sheet (Bambu's 0.65 - 3.1); gap 0.18 mm and
  sideways 0.54 mm kept on every layer of the slice; a sheet at Bambu's interface height on Base (14.80) and Oblique
  (12.20, the stair, 19 interface layers against Bambu's 20) and on the rim of both NegSpheres (10.40).
- **A bug found on the way, worth its own line:** `NSO_Thickness` `inside()` (parity of +Z crossings, coincident hits merged) reads
  every point under a head standing on a wedge as inside the part - the six heads are two shells touching on a plane. It is
  why the first one-trunk build stood its trunk 5 - 6 mm off with long arms. Only the crown's trunk-room test uses the signed count now
  (`insideSigned`); other users of `inside()` (the lattice planner's `lineInsideAt` is a different test) are not changed.
- **The default planner is untouched:** with the box off, or in Assisted / Custom / G-scope, `plan()` and the sheet are the
  claude-wip's (`support:feed`, `support:gridpack`, `support:exposed`, `support:foot`, `tree:*`, `support:interface-*`, `support:shells-*`, `support:everywhere`, `slicer:*`, `support:curved`, `support:workflow-card/counts/builds` all green; `support:card` and `support:custom` red as on claude-wip).
  The sheet's default pitch (0.84) and layers (2 + 2) are unchanged in the engine; the card sends Dense (0.47, 2 + 3) for the one-trunk build only. `support:curved` and the workflow drives' count sections (7 - 9) run with the box off: they pin the lattice's counts.

**Second round (the owner's notes on the first push, 2026-10-26)**
- **Every trunk is a cone onto its pad, not a stick** (`FLARE_MM` 4.5 / `FLARE_ANGLE_DEG` 27, was 4 / 15; a room-limited trunk is held under the same
  cone by `taperBase`). Global: the lattice's trunks too, so `support:everywhere`'s two fixture hashes and `support:plate`'s three are re-pinned and
  `support:feed`'s two re-landing assertions no longer need the 10 mm / 4 mm lattice to re-land on the coupon (the default's does). The reland keeps the
  foot 0.3 mm over Bambu's 3.86 (`RELAND_SLACK_MM`). Written in `docs/SUPPORT-GRIDPACK.md` (the law's table) and `docs/SUPPORT-ONE-TRUNK.md` 3.11.
- **The same trunk under every head**: 9.3 mm at the plate, 3.8 mm at the flare's top on all six (`crown.trunk.uniformH`, round: `ovalMax` 1).
- **A real bug found on the way**: `growCrownTrunk` still used the parity `inside()`, so under Circular (a head on a wedge) every point on the axis read
  as inside the part and the trunk was narrowed to its 2 mm floor: a straight 2 mm stick 5 mm high under a 7 mm pad - the owner's "straight stick, even
  with the pad". It uses `insideSigned` now, as the planner's room test does.
- **Alignment**: the cluster's circle stands under the centroid of the tips AND the spots they hold or a wall took (`centreReachMm`); a flat sheet under a
  curved head stays where the part is within 0.9 mm of it (`flatGapMaxMm`, the card's Dense only). Circular's sheet 2.3 mm off the pole is 0.3, the dome 2.65 mm
  over its rim is 1.1; Sphere's 1.75 is 1.3. Base's sheet is 0.18 mm under the part over every cell (the flat head's "no gap" is the slice's
  layer, 0.2 mm, against a gap of 0.18 mm). Gated in `support:onetrunk` (taper, uniformity, curved-head gap and centring).
- **Still not Bambu's conforming shell**: a curved head's sheet is a plate with a reach (OPEN 2).

**Third round (the owner's, on the second push)**
- Pad down to a hand wider than the trunk (0.6 mm, `padGrowMm`); the trunk a curved trumpet, not a cone (`flareAt`, 21 deg, 4.5 mm); the lattice's
  trunks take the same curve (re-pinned: `support:everywhere`, `support:plate`). Oblique's thick bundle (the stair tree's joins at 4.5 - 8 mm) is a plain
  stem to 6 mm now (`rootFloorMm` 6). The speck over the stair's top is gone (`clipConvexBelow`). Items 15 - 17 in `docs/SUPPORT-ONE-TRUNK.md`.
- **The brim** (fourth round): `NSO_Slicer` `brimType` (default 'none'; G-scope select auto; planner reads the project's `auto_brim`): 10 loops x 5 mm on the first layer round a tall part's foot, cut 0.02 mm edge-to-edge off the pad. `docs/SLICER.md` "The brim", `npm run slicer:brim`. Built with the supports by the card (**Brim round the foot** box, `brimStep`, a plate piece "- brim", role `brim` in the slicer; `support:brim-card`). Not done: inner brim, brim ears, shared brims; the plate-wide build has the same step per piece but no test of its own.

**Fifth round: the branches** (the owner's: no balls, no square tubes, round branches flowing out of the trunk and into one another). `blobSoup` (surface nets of the smooth union
of capsules; eroded at a pinch until manifold, else the old balls and tubes), the crown's tips round (`crownRound`, the exact stub under the cap), the exact trunk
stopping 1 mm under its top. `docs/SUPPORT-GRIDPACK.md` "The smooth body", `docs/SUPPORT-ONE-TRUNK.md` 3.19. Not done: the lattice's branches (square) and the stair-less
lattice trunks; the body is 12 - 55 k triangles a crown (cell 0.2 mm): `crown.blobCellMm` 0.25 is 0.64 x that, at a rougher surface.

**Sixth round: the Oblique's crown** (the owner's, on the tall Oblique: "separate the mass into clear distinct branches and dial in the tips ... why is that piece wanting more
than the others?"). The Oblique is the one head with a sloped underside, so it is a stair of 18 strips, and the stair's tree asked for a tip every 5 mm of every strip: 42 tips,
a leg each, one mass. Now (`opts.stairLegMm` = the card's Dense, `SHEET.denseStairLegMm` 4.5) the stair's tips stand on the same lines on every strip, a row of them is one blade of
posts, and a blade has a leg every 4.5 mm: 7 legs and 35 round posts on their blades, a crown of 11 members (was 81) that reads as a trunk splitting in three. The Oblique's supports
50.4 k -> 42.7 k triangles (the stair's body 15.1 k -> 9.9 k; 22.7 k of the rest are the interface layers). `CROWN_BLOB_CELL_MM` 0.25 and `CROWN_BLOB_TRIS` 24 k (was 0.2 / 50 k), so
every crown is lighter: the three plate pins were re-taken (NegSphere2 16644, Circular 9520, Sphere 9760 triangles). The plain stair (Open, Assisted, Custom) is untouched.
Not printed: a blade's posts stand on their neighbours (0.5 - 0.9 mm apart, overlapping) and a post is up to 2.2 mm in plan from its leg - the same lean as the stair's own strips,
but unprinted. `STAIR_LEG_MM` is the knob (3.2 is 3 legs to a blade). `docs/SUPPORT-ONE-TRUNK.md` 3.20.

**Seventh round: the Oblique in G-scope** (the owner ran `supp_ref` through the card and read the Oblique against Bambu's: interface and transition "way too many
layers, and intermixed", the support stopping level under the stair instead of running up to the interface, supports no longer hollow, one branch off the trunk at
90 deg with its tip over the part's edge). Fixed: the slicer types a stair's posts as Support (STAIR ZONES) and slices supports hollow (`supportWalls`); legs over
75 deg are brought to 50 (`leanHardDeg`; a stair's tree holds 50); a stair's lowest cap is kept under the part; the stair crown no longer dips under the plate.
`docs/SUPPORT-ONE-TRUNK.md` 3.21, `docs/SLICER.md`. `support:everywhere`'s negsphere2 tip-15 floor is 7 (was 8): the eighth was a tip the plan names bare, counted
for the stair's lines beside it. Not done: the strips' corner past the part's rounded corner (<= 0.9 mm); legs of 60 - 70 deg on the other heads (printed as they are).
Eighth push (same round, the owner's second look): a trunk was still read as filled (a sparse island under the profile's 15 mm2 and a tapering trunk's top ring were printed
solid: now none), the sheet's layers are filled where the slicer finds them (a hollow region would otherwise have left a strip an outline), a Dense stair's strips are five
layers deep (`planWidth`), G-scope's Slice reads the sheet's interface layers off the support (`nsoSupport.interfaceLayers`). The Oblique's slice: Support 30 k -> 22.9 k moves,
interface 1.5 k, transition 1.9 k (the owner's G-scope showed 15.2 k / 1.6 k / 1.5 k for the plate before this push; the card run in Node here gives different counts for the same plate and was not reproduced to match).

**OPEN for the owner**
1. **Dense interface is unprinted.** The card defaults to Dense (Bambu's spacing 0.1: lines 0.47 mm apart, 2 interface layers over 2 of transition).
   The 0.84 mm sheet was settled by the owner's own prints; Dense is built and sliced here, not printed. Interface > Open puts it back.
2. **Curved heads** (Circular, Sphere) get a flat plate under the pole (z 8.0 - 8.8 against Bambu's conforming shell to 9.4); the
   Negative Spheres' apex surface (Bambu: z 13.0 - 15.2) is not detected. Details in `docs/SUPPORT-ONE-TRUNK.md` section 5.
3. **Over-lean arms** on a squat head (NegSphere: 6 members over the 50 deg mark, near horizontal) are marked in `plan.overLean`,
   not shown on the card.
4. **The one-trunk build can be refused at the pad** on a tall piece whose trunks ring a post (the clamp at `ovalMax` 1, 9 trunks): the card
   then builds that piece again with the lattice and says so. A fix at the root (open the pad through a trunk's flare, or place the
   feet to leave a way out) is not done.
5. **Dense is the one-trunk build's only**: Custom, Assisted, strut, gecko-hand and "may rest" builds stay Open (a hand-placed row of
   three tips formed no sheet at 0.47 mm in `support:custom`).
6. **Environment:** `support:card` and `support:custom` were already red on claude-wip in this container (a page-state difference,
   checked on a clean worktree of 7dc1d1f: the same four and one lines fail there). `node_modules` had no `three`: `npm install --no-save
   three@0.147.0` and a link of the preinstalled Playwright into `node_modules` were needed to run the browser drives at all.
7. **Re-pinned on merge with #303 (plate-wide):** `support:plate` section 6 pinned three single-piece builds to 7dc1d1f's bytes; the card's Auto is the
   one-trunk build (with #301's sheet) now, so they are the new bytes (stable over two runs), and its ceiling test's 4 s is 12 s (a one-trunk head
   takes ~5 s in-thread). A plate-wide build with the box ticked builds each piece the one-trunk way; the lattice fallback (a one-trunk build whose feet
   ring the piece) is for a single piece's Generate only.

**Ninth push (interface 2 + transition 2, perimeter twigs).** Dense is 2 interface layers (`denseInterfaceLayers`), the slicer's `NI`/`NT` 2/2. A stair's tips are twigs along the
outline of its strips (`stairOf`: `STAIR_PERIM_MM` 2.5, `STAIR_PERIM_IN_MM` 0.6, `STAIR_FILL_MM` 3.8; `stair.perimGapMm`), all legs of the stair's own tree; in `stepCrown` a
`_stairTree` tip is a cone of the smooth body cut 0.18 mm into the strip (no exact stub). The row/leg constants (`STAIR_ROW_MM`, `STAIR_ROW_GAP`) and `fillTips` posts are unused for Dense.
Gates moved: `support:onetrunk` (stair perimeter gate, depth <= 5, options 2 layers), brim check/card test (2 layers), plate pins re-taken.

**Tenth push (the stair's high edge).** `STAIR_PERIM_TOP_MM` 4.0 (perimeter tip spacing grows from 2.5 at the stair low end to 4.0 at its top: Oblique 13 tips -> 10) and `STAIR_TOP_REACH_MM` 1.1
(the top strips' room is read with a field 1.1 mm deep, so they stop where the underside curves away: 17 strips, top 12.0). See SUPPORT-ONE-TRUNK 3.24.

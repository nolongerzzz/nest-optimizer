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

**OPEN for the owner**
1. **Dense interface is unprinted.** The card defaults to Dense (Bambu's spacing 0.1: lines 0.47 mm apart, 3 interface layers).
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

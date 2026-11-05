# Support: one trunk, the way Bambu's tree slim grows (supports-one-trunk)

`opts.oneTrunk` in `nso_support_gridpack.js` (`planOneTrunk`), the Supports card's **One trunk per cluster**
box and **Interface: Dense (Bambu) / Open** select (`app-supports-card.js`), the sheet's `interfaceLayers`
(`nso_support_interface.js`). Gate: `npm run support:onetrunk` (`tools/nso_support_onetrunk_check.js`, ~1.5 min).
`node tools/nso_support_onetrunk_check.js --export` also writes `tools/supports-onetrunk-out/supp_ref_onetrunk.3mf`
(the six heads and their supports, git-ignored) for Bambu Studio.

## 1. The ticket, and what #301 did instead

The owner's reference is `fixtures/supports/tree_slimsupports.gcode.3mf` (+ the project `supp_ref.3mf`): six test
heads - Base (flat), Oblique (a 24 deg plane), Circular (a dome), Sphere (a ball), Negative Sphere and Negative
Sphere2 (a flat rim round a cavity) - sliced in Bambu Studio, A1 mini, tree slim, 0.2 mm layers, threshold 30.
The ask: make NSO's supports look and work like those - **ONE trunk where it can be one**, and the transition and
interface laid across the same surfaces the way Bambu lays them.

#301 (`supports-sheet-everywhere`) laid a sheet and a stair under every tip at any yaw and tip - the interface half
- and left the tree as it was: its own table says "Pad, trunk, tree layout, tip placement, trunk count unchanged".
So on the six heads NSO still stood 6, 23, 3, 3, 6 and 3 trunks of square posts (the lattice of section 2 of
`SUPPORT-GRIDPACK.md`) where Bambu stands one each. That is the picture that came back. This ticket keeps #301's
interface engine (merged in) and does the other half.

## 2. What Bambu does under a head (read off its G-code, `support:onetrunk` section 1)

| head | trunks on the plate | trunk foot to the middle of the interface | support toolpath |
|---|---|---|---|
| Base | 1 | 0.65 mm | 2.92 m |
| Oblique | 1 | 1.39 mm | 3.74 m |
| Circular | 1 | 1.06 mm | 2.42 m |
| Sphere | 1 | 1.12 mm | 1.32 m |
| NegSphere | 1 | 1.06 mm | 2.62 m |
| NegSphere2 | 2 | 3.09 mm | 3.00 m |

- One trunk stands **under the sheet**, within about 1.5 mm of its middle, at the part's own xy distance (its first layer
  comes to 0.3 - 0.4 mm of the part's base: the 3.86 mm of the foot rule in `SUPPORT-GRIDPACK.md` is simple_overhang's, not a law).
- **Tips are 5 mm apart** (`tree_support_branch_distance`), not 3: Bambu's Base holds a 14 x 13 mm head with 5 branch tips
  where NSO's grid put 20.
- The canopy leans up to 45 deg (`tree_support_branch_angle`; its joins measure 47.7). The sheet carries what lies between tips.
- The interface lines lie **0.46 mm apart** on every transition and interface layer (`support_interface_spacing` 0.1 at a
  0.42 line: a nearly solid plate), alternating 45 / 135 deg; 2 transition and 2 interface layers (the owner's call after the first Dense: three was one too many).
  NSO's sheet had been 0.84 mm (the clamp reference, interface spacing 0.5), two interface layers.

## 3. What is built

**Tree is the one-trunk build.** Style Tree in Auto always builds this way (the owner's: "any time tree is selected, that's what builds. the lattice is for straight strut mode"); the card's *One trunk per cluster* box is hidden. Straight strut stays the lattice; Gecko-hand is a first concept, not yet this build; Assisted and Custom keep their fed builds.

**`opts.oneTrunk` (Auto, style Tree; with "may rest on the part" the card runs it first and plans what it could not reach again with the resting lattice)** - `planOneTrunk`, then the crown planner of section 8
of `SUPPORT-GRIDPACK.md` (the custom feed's "one tree to a circle") with these changes, none of them reachable without
the option (the shipped Custom feed's bytes are the claude-wip's; `support:feed` still passes):

1. **Tips thinned to the sheet's reach** (`thinTips`): farthest first, until every spot of the area is within `coverMm`
   3.3 mm of a tip (a cap reaches 2 mm, the sheet's field 1.25), never fewer than 3 tips for an area of 3 spots or more (a
   curved underside is a stair only from three). Base 20 spots -> 8 tips. The spots left are **held through the tip beside
   them** (`plan.oneTrunk.covered`; the card marks them held with that tip's landing).
2. **Areas planned together** (`oneTrunkGroups`, used by the card): areas whose spots lie within 12 mm of their centroid
   and 4 mm of height are planned in one call - Bambu stands one trunk under a rim it finds in three pieces. Each area
   keeps its own outline, status and answer; the group's support is the first area's.
3. **A tip stands straight for its cap** (`crown.tipRiseMm` 2.6): crown legs used to lean from the contact, so
   neighbouring caps overlapped and every cap was squeezed out ("no room for a cap").
4. **A squat head has no join under a join** (`zone.maxKids`): the kids to a join rise from 3 until the head's height
   (lowest tip - root floor - tip drop) holds the levels, so Oblique (tips at 9 - 12.5 mm) is a flat umbrella 1 > 8 where
   Base (15 mm) keeps 1 > 2 > 4 > 8. The canopy's vertical room is `tipDropMm` 3.2, `nodeDropMm` 2, `rootFloorMm` 4.5
   (were 4, 3, 6), design lean 38 deg, lean limit 50 deg (marks only).
5. **The trunk stands under the tips' centroid**, the foot 0.6 mm off the part (`crown.trunk.footClearMm`).
6. **`insideSigned`** replaces the probe's parity `inside()` in the trunk's room test. Each of the six heads is two shells that
   touch on a plane (a head on a wedge); `nso_thickness.js` merges their two coincident faces into ONE crossing, so every
   point under the head read as inside the part and no trunk could stand under it (it stood 5 - 6 mm off, with arms).
   Here a crossing counts +1 entering, -1 leaving: two shells touching on a plane cancel.
7. **Spots with no way down, and spots on the plate.** A spot with no straight or leaning route to the plate at the lattice's own
   30 deg (the same word as before: unreachable - the arc's three at its foot, the tunnel's ceiling) is not covered by a tip
   beside it and is named unreachable. A spot within `lowMm` 4 mm of the plate (the low edge of a tipped part) is on the first
   layers: nothing is stood under it and it is held by the plate (`plan.oneTrunk.onPlate`).
8. **A branch with no way round the piece** (`plan.blocked`): the trunk first moves toward the high end of a slope, then the
   cluster is split (up to 3 rounds, to 0.6 of its radius); a tip still unreachable alone is **left out and said unreachable**
   (`plan.unreachable`) and the spots beside it get tips of their own.

9. **Trunks are round-ish and the pad can still be refused.** A trunk is as wide at the plate as its height asks (18 mm for the
   72 mm clamp), and `ovalMax` is 1 here - round (11 - 12 below; the custom feed's 3 made 31 mm ovals under the clamp). Nine trunks still ring the
   clamp's post at some oval settings and `shareFeet` refuses the pad ("could not be opened to the outside"); the card then builds
   that piece again with the lattice and says so (`build({ lattice: true })`). Nothing was added by the first try.
10. **Cost.** The one-trunk build of the clamp is 39 s here against the lattice's 87 s on this branch (63 s on claude-wip before
   #301's sheet code); the trunk's room search is the hot loop (`trunkGap`), and where nothing fits the circle it now looks every
   third point at every 2 mm instead of every point at every 0.5.

11. **THE TAPERED BASE, on every trunk (the owner's, after the first push: "if it's a straight stick, even with the pad, it can pop off
    during print").** A trunk is a cone onto its pad, never a post: `FLARE_MM` 4.5 and `FLARE_ANGLE_DEG` 21 (was 4 and 15), as a curve (item 15) - over its
    bottom 4.5 mm the trunk widens 1.7 mm a side more than its 5.5 deg law at the plate. This is the constant of the lattice's trunks as well as the crown's (`support:feed`, `support:foot`,
    `support:everywhere`'s two fixture hashes and `support:plate`'s three were re-pinned for it). A trunk the piece leaves no room
    for - the one that used to stand as a cylinder at whatever width the wall allowed (Oblique's stood 9.8 mm across from top to
    bottom) - is held under the same cone from its base up (`taperBase`): it narrows going up by the flare's angle over the flare,
    the law's above it, never under the trunk's own column. `support:onetrunk` gates it: every trunk's base at least 1.4 x as wide
    as it is at the flare's top, widening all the way down. The reland's foot clearance asks 0.3 mm over (`RELAND_SLACK_MM`): a
    trunk grown round the landing a hair off it came 0.15 mm short of Bambu's 3.86 at the wider flare on the arc.
12. **The same trunk under every head (the owner's: "more uniform trunk sizes").** The crown's trunk follows one law for every
    head (`crown.trunk.uniformH` 10 mm, tip 2.8 mm, round: `ovalMax` 1): 8.0 mm across at the plate, 3.9 mm at the flare's top, on
    all six heads, where it was 8.6 - 10.9 mm (a function of the head's height and the area its tips asked for) and an oval 1.5 : 1
    under the taller ones. The area rule (a trunk as wide as its tips carry) is no longer sized to the tips; the tips are 2 mm
    columns a few millimetres apart and the uniform stem (3.8 mm) is wider than every tree the six heads grow. Gated: bases within
    15 % of one another and round. Still shorter than the law where the piece is near (`narrowed`), and then a cone (11).
13. **The trunk stands under the middle of the head.** The cluster's circle is the centroid of its tips *and of the spots they hold or
    the wall took* within `centreReachMm` 5 of a tip, not of the tips alone: a dome whose far side stands against a post
    (Circular: the pole, west and south tips are reachable; east and north are not) had its trunk 1.4 mm off the pole, and
    its sheet 2.3 mm off; now 0.6 and 0.3 mm. Gated for Circular and Sphere: trunk within 1.5 mm of the sheet's middle.
14. **A flat sheet under a curved head stays where the part is near** (`flatGapMaxMm`, the card's Dense: `SHEET.denseFlatGapMaxMm` 0.9).
    A level's field - where a line's centre may lie - stops where the part's underside is more than 0.9 mm over the sheet's top.
    The flat plate under Circular's pole had been 7.3 mm across with the dome 2.65 mm over its rim ("a visible gap", the owner's
    third photo); it is now 5.4 mm across with the dome 1.1 mm over its rim at most (Sphere 1.3 mm). A level that has no piece
    under the reach is built again without it, so the Negative Spheres' rim sheets (a ring round a cavity) are what they were.
    This is a **flat plate with a reach**, not Bambu's conforming shell (section 5: still open).
    A flat head is unaffected: Base's sheet is 0.18 mm under the part over every cell.

15. **The pad is a hand wider than the trunk, and the trunk is a trumpet (the owner's, second round, off Bambu's pad round a model's stem).**
    The crown trunk's pad is grown 0.6 mm round its base (`crown.trunk.padGrowMm`; `FOOT_GROW_MM` is 4 for every other foot, as the
    owner's prints settled it): 9.4 mm across on the 8.0 mm base, where it was 16 - 17 mm. The base stands inside the pad's edge and
    narrows from there on a curve (`flareAt`, the square of the way up: steep at the plate, tangent to the stem at 4.5 mm) through
    six rings (`ringZs`), so the trunk is mostly stem and there is no visible joint. Gated (`support:onetrunk`). The model's own brim
    (Bambu's blue ring round a stem) is item 18.
16. **The stem stands to 6 mm before the tree branches** (`crown.rootFloorMm` 6, was 4.5; a head whose lowest tip is lower roots as high as
    the tip's drop allows, 5.8 mm under Oblique's and Circular's 9.0). The 42-tip tree under Oblique's stair had been a bundle of
    joins 6 - 10 mm across from 4.5 up to 8 mm (the "abnormally thick trunk" next to the other heads' 4 mm stems); it is a ball of
    branches on a plain stem now. Branch radii are capped at the uniform trunk's (`capR`): none is thicker than the stem it joins.
17. **A stair tree's posts end at the stair's top** (`clipConvexBelow`). A leaning post of the stair's own tree stood 0.4 - 0.6 mm
    over the top strip at the stair's high end: two specks of 1.4 and 0.5 mm of line in the slice at z 12.4 and 12.6, floating over
    where the supports stop (the owner's circle). Each part of a stair tree (tube, ball, post - convex) is cut at the stair's top and
    capped. Gated: no support stands over the highest sheet's top.

18. **The brim** (the owner's, on the third push: "I don't see the brim work covered here"). Bambu rings each model's stem with a `Brim` of
    10 loops, 5 mm wide, on the first layer, and the tree's pad meets it without joining; NSO had none. `NSO_Slicer` now has it
    (`brimType` 'none' | 'auto' | 'outer', `addBrims`; docs/SLICER.md "The brim"), the print planner reads the project's `brim_type` /
    `brim_width` / `brim_object_gap`, G-scope's Slice settings have a **brim** select (auto by default), the toolpath reader colours and
    lists `Brim`. Measured on the six heads against the reference: 10 loops, 0.5 mm line, centres 0.35 - 4.46 mm off the outline, 245 - 278 mm
    a head (Bambu's 195 - 248), the brim 0.02 - 0.04 mm edge to edge from the pad's lines. Gate: `npm run slicer:brim`.
    **Built with the supports (the owner's, after it: "add it into the supports generation card so it can get built with the supports"):** the card has a
    **Brim round the foot** box (ticked, in every mode); after a piece's supports are built it asks `NSO_Slicer.brimFor` for the brim - off the pads and off the
    pieces already built - and places it as one more plate piece, "<piece> - brim", labelled `nsoSupport.brim`, never counted as a support, taken off with the supports
    on one Undo, exported with them (ten wall loops, no infill: `slicerSettings`) and sliced by G-scope and the print planner as role `brim` (feature `Brim`). A piece that
    stands on a wide foot gets none; with no slicer on the page the supports build as they did. Gates: `support:brim-card`, `support:onetrunk` (a brim object, 5+ loops,
    none on the part, no conflict).

19. **The branches are one smooth body** (the owner's, on the fifth push: "get rid of the shoved sphere model ... make them round like this tube, that merge out of
    the trunk and split from themselves with smooth flowing transitions instead of visible joints"). A crown's tip is a round post (of the square's area, 0.68 mm
    radius), its leg and the crown's tubes and the top of the trunk are one body - a smooth union of capsules meshed by surface nets (`blobSoup`,
    `docs/SUPPORT-GRIDPACK.md` "The smooth body"): no ball at a join, no square tube, the legs rising out of a shoulder of the trunk and running into one
    another with a fillet of 0.25 mm. The exact post under each cap stays exact (the gap and the cap are measured on it). 12 - 55 k triangles a crown (the balls and
    tubes: 3 - 16 k), the build 1 - 3 s longer per crown. Gates: `support:onetrunk` (a body to every crown: closed, outward-wound; the sideways clearance is 0.61 mm
    least, the body carved back to keep the planner's 0.35 off the piece). The lattice's branches stay square.
20. **A stair's tips are a few legs under blades, not a leg a post** (the owner's, on the sixth push, off the tall Oblique: "separate the mass into clear
    distinct branches and dial in the tips ... first it was a fat trunk and now it's a fat crown. Why is that piece wanting more than the others?").
    *Why the Oblique wants more.* Every other head is a sheet: one level, one cap under each of 3 - 8 tips, and a crown of 3 - 8 legs. The Oblique's
    underside leans 20.7 deg, so it is a **stair** of 18 strips (the underside climbs 0.2 mm a layer, so each strip stands 0.53 mm up the slope from the one
    below), and a strip over the one below it is held at its leading part by a tip every 5 mm (docs/SUPPORT-INTERFACE.md, the stair's tree): 18 strips x 2 - 3
    tips = 42 tips, where the others have 3 - 8. The plan's own 8 tips cost nothing (7 are held by the stair); the 42 were the whole crown, and each had a
    leg, so the crown had to take 42 legs inside a footprint of 10 x 8 mm - one mass. The taller the piece, the longer that mass (the owner stretched it to
    40 mm: a crown 13 - 35 mm). *What is built now* (`opts.stairLegMm`, the card's Dense: `SHEET.denseStairLegMm` 4.5): the tips of neighbouring strips stand
    on the same three lines across the slope (the quarter-stretch stagger of the plain stair is off), a post a strip over the one below, 0.5 - 0.9 mm along,
    overlapping - each line is one ramp-topped **blade** of posts, 8 - 10 mm long. A blade is held by a leg every 4.5 mm, at the middle of equal stretches
    (`round(L / 4.5)`, 2 on a 9.6 mm blade), the post nearest each; the posts between are built as round posts of the tip's own radius on the blade (they
    stand on their neighbours as the stair's strips do: the gap and the cap are as for every tip) and have no leg. The lowest strip's tips keep theirs.
    The Oblique's stair tree: 42 tips = 7 legs + 35 posts, 81 crown members = 11, three branches off the trunk's fork reaching the three blades, each
    splitting once; the stair's crown body 15.1 k -> 9.9 k triangles (the whole Oblique supports 50.4 k -> 42.7 k; the rest is the interface layers, 22.7 k),
    the sheet's own bodies at the blob's cell 0.25 mm and budget 24 k triangles (`CROWN_BLOB_CELL_MM`, `CROWN_BLOB_TRIS`; the owner's Studio view of Bambu's
    Oblique is three columns off one trunk). The legacy plain stair (Open, Assisted, Custom: no `stairLegMm`) is byte for byte as before.
    Gate: `support:onetrunk` (a stair's legs are no more than a third of its tips and no post is further than 3.6 mm in plan from one).
21. **No branch lies flat; a cap stays under the part; a support is hollow** (the owner's, running the original `supp_ref` again: "this branch that comes off the
    trunk at a 90 definitely won't print + the tip is sticking out from beyond the model contact point ... revise any branches like that, so they stay within
    the contact points unless reaching up to another point above"). *The branch.* The crown's joins stood no lower than `rootFloorMm` (6 mm: the stem), and where the
    tips were low and spread (a 17 mm head) that floor beat the lean: the Oblique's lowest tip hung on a leg of 83 deg from vertical, its stair's tree on legs of
    75 - 80 deg. A leg over `crown.leanHardDeg` (75) is now brought down to the lean limit (`branchTiltDeg`, 50): its join stands lower, or its end meets the
    trunk lower, inside its body, where it is going (`LEAN_FLOOR_MM` 1.5 over the plate at the least). A stair's own tree (`_stairTree`) holds 50 throughout. The
    legs between (the plan's 60 - 70 deg ones on the other heads) are as they were - changing them moved Circular's sheet (its tips' tops moved, and one tip
    lost its piece). Gate: `support:onetrunk` ("no built branch lies flat": the plan's legs under 75, a stair's tree under 50). *The tip.* A stair's lowest tip
    stands on the slope's edge; its 4 mm cap hung 2 mm off the part. With `opts.perimeter` a cap whose rim is not all under the part is moved in (1.5 mm at
    most) and then narrowed (`CAP_IN_MM`); what is left over the edge is the strips' corner at the part's rounded corner (up to 0.9 mm, not trimmed).
    *The crown below the plate:* a join brought down to the flare put the trunk's shoulder under the plate (z -3.8): the body is cut at the plate (`cut.zMin`).
    *Hollow and the labels:* `docs/SLICER.md` "A support is hollow" and "A stair's posts are Support".
22. **The stair is Bambu's sheet: five layers deep, and everything under it is the tree** (the owner's, with Bambu's own toolpath of the Oblique's interface: "this is how the
    toolpath for the stepped interface on the oblique should look. everything below this should be classified as support, and be part of the tree/branch/tips").
    Bambu's interface is a sheet 3 interface and 2 transition layers deep that follows the underside; at every point under the part, five layers. A stair's strip
    was one advance and a bead wide (1.3 mm): at a point two layers stood, and the posts and legs under them were read as part of the sheet. With Dense
    (`stairLegMm`) a strip reaches from its front to the front of the strip `nInterface + 1` layers up, and a bead (2.5 mm on the Oblique, `stackReach`): five deep
    at every point, the three under the gap interface, the two under them transition (the slicer's STAIR ZONES: within `gap` + 2 layers + 0.1 mm of the part,
    and within `gap` + 4 layers + 0.1 mm), and what lies deeper - the blades' posts, the legs, the branches - Support. (A strip as wide as the advance of its
    first layer, 2.1 mm where the part's rounded low edge runs out, made the lowest strip 8.8 mm of flat plate: it is the reach, not the advance.) The owner's
    second look: "the oblique interface should be the same size layer wise as the flat interface. Just stepped in a diagonal pose. No wedge. No flat horizontal
    bleedout into the support branches": over the Oblique's plan the interface and transition stand 5 deep (p90 5, 6 by the check's own counting), a flat head's 5;
    a layer that holds a stair's strip holds every zone on it to the part's nearness (a post is one island with its strip, and a flat top read on the strip's front
    carried the whole island). One layer of the Oblique's plan, ours
    against Bambu's (z 9 - 11): a hatched interface band along the contour, a transition line along its low side, the Support beside it. `support:onetrunk`:
    "the tree runs up with the sheet" (Support to within 1.5 mm of the sheet's top, the Oblique's to its last layer) and "a trunk is hollow".
23. **Interface 2 + transition 2, and the twigs that hold its edge** (the owner's: "interface=2layers / transition=2layers / branches need to fully support perimeter of transition,
    or interface edge will sag... remove any flat branch stubends from within tree... smooth out the cylinder tops into micro branches that all flow smoothly off of one of the
    connecting branches and dies at the transition"). The Dense sheet is four layers deep, so a stair's strip reaches `nInterface + 2` layers (`stackN` 4 on the Oblique). The tips
    of a stair are no longer rows of posts: `stairOf` lays its strips' plan footprint on a 0.25 mm grid, takes a chamfer depth from its outline, and puts a tip every >= 2.5 mm
    round the outline 0.6 mm inside it (`STAIR_PERIM_MM`, `STAIR_PERIM_IN_MM`), then farthest-point tips inside wherever the footprint is more than 3.8 mm from one
    (`STAIR_FILL_MM`): 13 on the Oblique (12 round the edge, 1 inside), the farthest outline cell 2.06 mm from a tip (`stair.perimGapMm`), every tip a leg of the stair's own tree
    (no `leg: false` posts). In the crown (`stepCrown`) a stair-tree tip (`opts._stairTree`) has no exact stub: its prim in the smooth body is a cone from the leg's radius at the
    bend to 0.62 of it at the tip, cut flat 0.18 mm into the strip, so the twig leaves the branch it hangs from and dies in the transition. `support:onetrunk`: "a stair's tips
    are twigs along its perimeter" (every tip a leg, no outline cell more than 3.0 mm from a tip). The slicer's stair transition depth is `gap` + 3 layers + 0.35 mm (was 0.1): a layer's footprint ends 0.5 mm past the 0.1 mark, and its outline wall there was Support where Bambu has its transition line beside the interface ribbon; at 0.35 the layer view matches Bambu's (interface ribbon, transition line beside it, Support beyond), the stack counting up to 6 at p90 on the Oblique.
24. **The stair's high edge, pulled in** (the owner's, looking at the Oblique from its high side: "the very top edge/high side on the stair, including the supports that are carrying that edge...
    quite a bit of material that could come off that end/revise tips"). Two changes, both Dense-only (`opts.stairLegMm`). (a) A tip is a long leg from the crown the higher it stands, so
    the perimeter spacing grows with the strip a tip stands under, from `STAIR_PERIM_MM` 2.5 at the low end to `STAIR_PERIM_TOP_MM` 4.0 at the top (the Oblique: 13 tips to 10, three along the
    high edge, the stair's crown body 216 mm3 to about 170). (b) The top strips cover the part only where it is within `STAIR_TOP_REACH_MM` 1.1 over the strip's top (`roomAt`'s own field),
    not out into the fillet where the underside curves up to its wall (it ran 1.6 mm clear of the sheet there): the Oblique's stair is 17 strips, top at 12.0, was 18 at 12.2. A Dense strip is also no longer a bead wider than the stack under the part (`planWidth`): the extra bead put a Support wall line beside the interface at the top layers (z 11.8 - 12.0) where Bambu's slice (the owner's screenshot of the same edge) has the interface tapering to two lines and then one, nothing beside it.
**The interface (`interfaceLayers`, `SHEET.densePitchMm`).** `sheet()` takes `interfaceLayers` (2 unless said): 2 transition
layers and that many interface layers, the interface alternating across and along the sheet's A. The card's **Dense (Bambu)**
interface is pitch **0.47 mm** (Bambu's 0.46: the strip's joins need a segment of 0.4665, and at 0.46 the stair under
the tilted plane did not build) and **3 interface layers** over 2 of transition (`SHEET.denseInterfaceLayers`, as Bambu's reference lays every head; it was 2); **Open** is 0.84 mm, the same 2 + 2. The card's default is
Dense **in the one-trunk build only**: a hand-placed row of three tips (Custom, `support:custom`) formed no sheet at 0.47 mm where it forms one at 0.84, so every other build stays Open. The slicer's labelling takes `supportInterfaceLayers` (default 2) to read a 3-layer sheet.

## 4. Measured (`support:onetrunk`, the six real parts, flat)

`node tools/nso_support_onetrunk_check.js` - the card's Auto at its defaults (box ticked, Dense), each head flat, built, sliced
with `NSO_Slicer`, the sheet read off the labelled lines. "Before" is the box off: the lattice planner (a stair's own trunks counted).

| head | trunks: Bambu / before / now | tips (of spots) | Bambu's interface: z first T .. last I, T / I, footprint | ours now | trunk to sheet middle: Bambu / ours | toolpath ours / Bambu |
|---|---|---|---|---|---|---|
| Base | 1 / 6 / **1** | 8 of 20 | 13.70 - 14.80, 2 / 3, 13.9 x 12.9 | 14.00 - 14.80, 2 / 3, 13.8 x 12.0 | 0.65 / 1.5 mm | 1.73 x |
| Oblique | 1 / 23 / **1** | 8 of 21 | 7.69 - 12.20, 19 / 20, 13.9 x 12.4 | 8.00 - 12.20, a stair of 18 strips (2 / 20), 14.7 x 12.1 | 1.39 / 1.1 mm | 1.18 x |
| Circular | 1 / 3 / **1** | 3 of 5 | 7.69 - 9.40, 5 / 6, 6.9 x 7.1 | 8.00 - 8.80, 2 / 3, 7.3 x 7.3 | 1.06 / 1.1 mm | 0.48 x |
| Sphere | 1 / 3 / **1** | 3 of 4 | 8.49 - 10.00, 4 / 5, 5.1 x 5.2 | 8.80 - 9.60, 2 / 3, 6.9 x 6.3 | 1.12 / 0.6 mm | 0.87 x |
| NegSphere | 1 / 6 / **1** | 6 of 15 | rim 9.30 - 10.40, 2 / 3, 12.7 x 11.8; apex 13.00 - 14.20 | rim 9.60 - 10.40, 2 / 3, 16.8 x 12.0; no apex | 1.06 / 0.7 mm | 1.06 x |
| NegSphere2 | 2 / 3 / **1** | 3 of 3 | rim 9.30 - 10.40, 2 / 3, 13.5 x 10.6; apex 13.80 - 15.20 | rim 9.60 - 10.40, 2 / 3, 16.2 x 10.2; no apex | 3.09 / 0.3 mm | 0.86 x |

Every sheet and stair holds the gap (0.18 mm to the part at the nearest point; the lowest is 0.18, the stair's 0.20) and
every support line keeps 0.54 mm or more from the part's lines in every layer of the slice (the slice's `support_object_xy_distance`
is 0.35). The before / after of the trunk count is #301's picture against this one: 6, 23, 3, 3, 6, 3 trunks became 1, 1, 1, 1, 1, 1.
Bambu's own interface layers are 0.275 mm (independent support layer height); ours stay on 0.2, so the heights agree where they
are read off the top (14.80, 12.20, 10.40) and not where they are read off the bottom (the first T).

## 5. Not done, and named

- **A dense interface is a print the owner has not made.** The 0.84 mm sheet was settled by prints (docs/SUPPORT-INTERFACE.md
  section 3, supports-print-1); the 0.47 mm one is the reference slice's spacing, built and sliced here, never printed. The
  select is there to go back to Open in one click.
- **Layer heights.** Bambu's support layers here are 0.275 mm (`independent_support_layer_height`), so its 2 + 3 layers are 1.375
  mm; ours stay on the 0.2 mm grid (2 + 3 = 1.0 mm).
- **Curved heads** (Circular, Sphere): Bambu's interface is a conforming shell 7 mm across at the dome's ring (z 7.7 - 9.4 for
  Circular, 11 layers); ours is a flat plate under the pole's level (8.0 - 8.8) with two or three tips, held to where the dome is within 0.9 mm of it (3.14: 1.1 mm at the rim at most, not 2.65). A curved head with only
  a few tips is a flat sheet, not a stair (`STAIR_MIN_TIPS` 3, and its tips on levels that failed).
- **The apex of the Negative Spheres** (Bambu's second surface, z 13.0 - 15.2, 3 - 4 mm across): detection finds the rim only.
- **Branches up a dome's flank** (Bambu holds the steeper part of the Circular and Sphere flank with bare tips): not built.
- **Over-lean members** are marked (`plan.overLean`, `plan.suggested`), not refused, as in Custom; the card does not show them.
- **Support toolpath** is 1.2 - 1.7 x Bambu's on Base and Oblique, 0.5 - 1.0 x on the rest.
- The card's drives `support:card` and `support:custom` were already red on claude-wip in this environment (see the handoff note).
- **Big areas are several trunks, not one.** The tilted box of `support:beacons` (40 x 30 mm, 120 spots) is 5 trunks at the cluster
  radius 12 mm (`ONE.clusterMm`: 8 at 9 mm, 3 at 15 with more over-lean members); the 326-spot wedge (`library/v9_mirror_factory.stl`) is 20
  trunks where the lattice stood 115. One trunk to one canopy, as Bambu's.

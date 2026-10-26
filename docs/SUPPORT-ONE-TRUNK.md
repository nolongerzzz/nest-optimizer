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
  0.42 line: a nearly solid plate), alternating 45 / 135 deg; 2 transition and 3 interface layers.
  NSO's sheet had been 0.84 mm (the clamp reference, interface spacing 0.5), two interface layers.

## 3. What is built

**`opts.oneTrunk` (Auto, style Tree, not "may rest on the part")** - `planOneTrunk`, then the crown planner of section 8
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
   72 mm clamp), and `ovalMax` is 1.5 here (the custom feed's 3 made 31 mm ovals under the clamp). Nine trunks still ring the
   clamp's post at some oval settings and `shareFeet` refuses the pad ("could not be opened to the outside"); the card then builds
   that piece again with the lattice and says so (`build({ lattice: true })`). Nothing was added by the first try.
10. **Cost.** The one-trunk build of the clamp is 39 s here against the lattice's 87 s on this branch (63 s on claude-wip before
   #301's sheet code); the trunk's room search is the hot loop (`trunkGap`), and where nothing fits the circle it now looks every
   third point at every 2 mm instead of every point at every 0.5.

**The interface (`interfaceLayers`, `SHEET.densePitchMm`).** `sheet()` takes `interfaceLayers` (2 unless said): 2 transition
layers and that many interface layers, the interface alternating across and along the sheet's A. The card's **Dense (Bambu)**
interface is pitch **0.47 mm** (Bambu's 0.46: the strip's joins need a segment of 0.4665, and at 0.46 the stair under
the tilted plane did not build) and **3 interface layers**; **Open** is 0.84 mm and 2 + 2 as before. The card's default is
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
  Circular, 11 layers); ours is a flat plate under the pole's level (8.0 - 8.8) with two or three tips. A curved head with only
  a few tips is a flat sheet, not a stair (`STAIR_MIN_TIPS` 3, and its tips on levels that failed).
- **The apex of the Negative Spheres** (Bambu's second surface, z 13.0 - 15.2, 3 - 4 mm across): detection finds the rim only.
- **Branches up a dome's flank** (Bambu holds the steeper part of the Circular and Sphere flank with bare tips): not built.
- **Over-lean members** are marked (`plan.overLean`, `plan.suggested`), not refused, as in Custom; the card does not show them.
- **Support toolpath** is 1.2 - 1.7 x Bambu's on Base and Oblique, 0.5 - 1.0 x on the rest.
- The card's drives `support:card` and `support:custom` were already red on claude-wip in this environment (see the handoff note).
- **Big areas are several trunks, not one.** The tilted box of `support:beacons` (40 x 30 mm, 120 spots) is 5 trunks at the cluster
  radius 12 mm (`ONE.clusterMm`: 8 at 9 mm, 3 at 15 with more over-lean members); the 326-spot wedge (`library/v9_mirror_factory.stl`) is 20
  trunks where the lattice stood 115. One trunk to one canopy, as Bambu's.

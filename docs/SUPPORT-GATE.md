# The printability gate, and the column interface rule

`tools/nso_support_gate.js` (`npm run support:gate`), its measuring core `tools/nso_support_gate_lib.js`, and the slicer option
`supportInterfaceRule: 'column'` in `nso_slicer.js` (`columnRule`, `columnLoops`, `columnType`). G-scope's Slice settings carry it as
**interface: sheet / column** (remembered in the browser, used by Export print too).

## 1. Why

The interface is what has to print and break away. Until now the support work was scored by how closely our lines overlay Bambu's
(`support:score`, IoU per head). On the six heads of `supp_ref`, overlay is a poor guide:

- Each curved head crosses layer boundaries at a different place, so a constant tuned for one head moves the others. The
  2026-10-30 to 11-07 commits are about forty such per-head constants (`REGION_TALL_TRY_MM`, `REGION_BEAD_SHARE`, `CAVITY_EXTRA_LAYERS`, ...).
- Two owners drew the interface. The generator built a sheet mesh 0.18 mm from the mesh surface; the slicer then re-drew plates per
  layer, typed by host proximity with an exact-cut exception. Each corrected the other.
- A gap of 0.18 mm measured square to a curved or sloped surface is not a layer of air once a slicer cuts it into layers. On the
  Sphere both NSO's slicer and Bambu's slice of our meshes printed interface lines with no air under the part's next layer
  (about 6 mm2), and the existing gates passed because they measure the mesh.

## 2. The gate

Measured on G-code, every head at once, each against Bambu's own slice of the same head
(`fixtures/supports/tree_slimsupports.gcode.3mf`). Lines are drawn at their width into 0.1 mm cells; Bambu's arcs (G2/G3) count.

| check | what | rule (against the reference's own number for the head) |
|---|---|---|
| contact area | the part's underside with support within 0.6 mm under it | >= 0.9 x ref |
| touch mm2 | support lines with under 0.05 mm of air under the part's next layer: they weld | <= ref + 0.5 |
| one-layer gap | share of the contact area with one layer of air (0.15 - 0.25 mm) | >= ref - 10 points |
| two-layer gap | share with two layers of air (0.35 - 0.6 mm): the underside sags | <= ref + 15 points |
| floating islands | support islands of 0.3 mm2 or more with nothing within 0.35 mm under them | <= ref |
| empty layers | a support with no line on a layer between two it prints (Bambu's warning) | <= ref |
| sheet carried | (labelled slices) share of each sheet's lowest layer within 1 mm of support below | >= ref - 10 points |
| depth III+T | (labelled slices) share of contact columns that read interface x3 or more, then transition, top down | >= ref - 15 points |
| span p95 | (labelled slices) the stack's lowest layer: each cell's distance to the nearest support on the layer under it, 95th percentile | <= max(ref + 0.5, 1.0) mm |
| over 2.5 mm | (labelled slices) the stack's lowest layer further than 2.5 mm from support under it: printed over air | <= ref + 0.5 mm2 |

**Unreachable** (a build only): the card's own count after the build - "Built: ... unreachable U" - must be 0 (the owner's first gate before a print;
docs/SUPPORT-ONE-TRUNK.md item 25). `--merged` builds the six heads as ONE piece, as the owner's plate has them.

| tree over air mm2 | the tree's lines (Support, not the plate) further than a line's width from anything in the layers just below: a branch leaning more than a layer's step per layer, or an arm run out flat | <= max(1.5 x ref, ref + 2) |

Specks (support islands under 0.8 mm2 under a sheet: tips too thin to hold it) are printed, not gated.

**Parity** (printed, not gated): each of the reference's interface / transition layers set against ours at the same height (within 0.1 mm),
lines drawn 0.5 mm wide so a plate's lines are one area, in one frame by the parts' centres - plate IoU, the same with the type matched, and
the share of the reference's layers we have a layer at (within 0.03 mm). `--worst` lists the five layers per head that differ most and the
columns' make-up top down (I interface, T transition, S support).

    node tools/nso_support_gate.js                              build supp_ref with the card (Auto, Dense, 30 deg), slice with NSO_Slicer, gate
    node tools/nso_support_gate.js --rule column                the same with the column rule
    node tools/nso_support_gate.js --gcode a.gcode.3mf ...      gate sliced files: NSO's export, or Bambu Studio's slice of NSO's meshes
    --report (never fail)   --json out.json   --dump moves.json (a build's moves)   --ref other.gcode.3mf   --merged (a build: the six as one piece)   --worst

A file is read by its objects' names: `X` is a part, `X - support ...` its support, `X - brim` left out; inside a part, `Support*`
features are support (Bambu's own). About 40 s for a build, 3 s for files.

## 3. Measured (2026-11-08)

Printability (the gate) and parity with Bambu (`support:gate` prints both; parity is reported, not gated):

| head | sheet typing, the owner's slice: gate / plate IoU | column rule: gate / plate IoU / type IoU / layer heights met |
|---|---|---|
| Base | passes / 96 % | passes / 98 % / 98 % / 100 % |
| Circular | touch 0.5 mm2, contact 34 / 38 / 85 % | passes / 91 % / 91 % / 100 % |
| Negative Sphere | contact 49 / 57 / 66 % | 3 floating twigs of the generator's tree at z 11.9 / 91 % / 90 % / 100 % |
| Negative Sphere2 | contact 23 / 47 / 59 % | contact 41 / 47 (the apex flank ring, z 14.1 - 14.3) / 83 % / 83 % / 100 % |
| Oblique | touch 1.5 mm2, a floating island / 84 % | passes / 87 % / 87 % / 100 % |
| Sphere | touch 5.9 mm2, one-layer 43 %, depth 0 % / 68 % | passes / 85 % / 84 % / 100 % |

Under the column rule no line touches the part on any head, every sheet is carried, and the layer heights are Bambu's. The owner's Bambu
Studio slice of NSO's meshes (no labels) fails on the Negative Sphere's apex floating on nothing (empty layers 12.0 - 12.8), the Oblique
stair mesh a layer low (78 % of its contact under two layers of air) and the Sphere touching.

## 4. The column rule

The interface is read off the part's own layers, column by column, as Bambu lays it - one owner, no constant per head:

- **blocked** at support layer i: the part at the layer's own height grown by the xy distance (`supportXyMm`, 0.35, Bambu's
  `support_object_xy_distance`), and the part whose underside is less than the gap (`supportGapMm`) over the layer's top.
- **contact** at layer i: where the next layer up would be blocked.
- **footprint**: the part's overhang at the threshold angle (a layer's section past the one under it by more than a layer / tan(angle);
  a piece of a section smaller than a bead is not printed and is no overhang), grown 0.38 mm - Bambu's interface loop runs 0.17 mm past the
  face's edge, measured on the Base - each region taken whole where the generator's support serves it (meets the support within reach
  under the part). A dome's steep flank is not an overhang: the tree's to hold.
- **contact** reaches past an overhang's edge by the same 0.38 mm (not past a wall). Past the edge a column can be a contact on two
  neighbouring layers: both stand their stacks, 4 interface layers in that column, as Bambu's own do on a slope or a dome (13 - 24 %).
- **rank**: a column's layers counted down from its contact through the layers it is not blocked on: 0 - 2 interface, 3 - 4 transition.
- **base**: under the stack a column runs on down as Support until it stands on the support's own material, at most 3 mm; a column that
  lands nowhere is dropped, with what stood on it. The base gets a zig-zag at 2 mm (the transition spans no more).
- Every layer of the support is cut to it before its paths are built (the section less blocked, plus the stack and the base); the stack
  is laid as one loop half a line in and a zig-zag at a line + 0.04 mm (Bambu's 0.46), the first layer of a stack at 110 deg then
  45 / 135. A piece narrower than a line (a dome's or a cone's ring of contact) is one loop down its middle, and only where its bead stays
  out of the part and from under it.

Measured against Bambu with Bambu's own footprint given (the rule alone deciding heights and types): Base 0.95, Circular 0.82, Negative Sphere
rim 0.69 - 0.74 and apex 0.6 - 0.82, Oblique 0.70, Sphere 0.56 IoU per layer. It reproduces Bambu's hole round the Sphere's pole that widens
a layer at a time.

## 4b. One tree from the plate to the interface (the owner's gate 3, 2026-11-09)

Under the column rule the generator builds the TREE ALONE (the card's `partsOptsOf`: `interface: false` when the slicer's interface is column): no sheet,
caps or plate of its own - left under the slicer's stack they printed as a block of Support a few mm tall between the tree and the interface (Base,
Oblique, Circular, the Negative Spheres' rim slabs). Its tips run up to the part; the rule cuts them at the gap and lays the stack on them. The rule's
base (`COLUMN_LAND_MM`) is 0: the transition spans between the tips, as Bambu's does, and a stack piece with nothing under it goes. The tree keeps the
xy distance from the part just over it as well as at its height (`blockedTree`): a branch climbing past a cavity's rim stood a bead under the rim's
first layer. A spot on a step no slicer calls an overhang (a quarter of a mm at the heads' shoulders, z 15.3) stands no tip under the column rule
(`opts.columnRule`): its branch was an arm run out flat to it. Tree over air: Circular 3.4 -> 0.6 mm2, Sphere 2.5 -> 0.0, Negative Sphere2 12.7 -> 2.9
(Bambu 0.1 - 1.0). Interface parity unchanged; unreachable 0. The default (sheet) build is unchanged (support:onetrunk, support:plate pins).

Still to do: the sheet carried (Base 75 %, Negative Spheres 70 - 76 % against Bambu's 85 - 91 %: too few or too thin tips under a plate), the forks
of the Negative Spheres' trunks over air (2.7, 2.9 mm2), a twig floating on Circular and Sphere; Bambu's horns up the domes' flanks to those shoulders
(its reference was sliced with remove-small-overhangs off).

## 4c. Held from below, and the horns (the owner's, 2026-11-08: "the interfaces also supported from below, within bridge tolerances ... add the upper branches back in, to catch those little edges their horns do ... a ring tip")

**The cup** (`nso_slicer.js` columnRule, after the stack is laid). A stack's lowest layer that reaches more than `COLUMN_CUP_REACH_MM` (0.25: its edge
loop's bead would stand on less than half its width) past what is under it gets a ring wall under its edge: the first ring 0.1 mm in, under the
edge loop, then stepping in at 45 deg a layer down, two lines wide (`COLUMN_CUP_RING_MM`), until it lands on the tree. Worked top down, so a cup
under a dome's widest layer holds the narrower layers under it too; a dome's widening ring is filled with the stack under it before the cup is
drawn. Every ring keeps only what stands within 0.3 mm of the ring or tree under it, from the landing up (a horseshoe of rim narrowing from both
sides closed over the air: that much is not built). Under a plate with a hole (a rim round a cavity) there is none. Bambu's Sphere tree is the
same flared cup. `NSO_NO_CUP=1` turns it off, `NSO_CUP_DEBUG=1` lists each cup.

**The horns** (`nso_support_gridpack.js` hornColumn, the card's column-rule build). A spot on a step no slicer calls an overhang (the shoulders,
a quarter of a mm, z 15.3) stands no tip under the column rule; it is caught as Bambu catches it, measured on supp_ref's four domed heads: a horn
whose top stands under the step's edge `HORN.wallMm` (0.45) off the walls under it (kept over its first half mm, where a dome bulges under its
shoulder), a twig 0.5 mm across (one ring of line), leaning out at 30 deg (Bambu's 0.6 mm a mm) until it has a straight drop, then a 0.85 mm
column to the plate, its foot flared. No interface (it is no overhang). No horn where an overhang's own spot lies within 2.5 mm in plan and 1.5 mm
under the step's (`HORN_COVER`): that edge is the interface's, its stack reaches past it - the Oblique's step at z 9.7 over its slope's interface,
where Bambu has interface to 8.8 and nothing else, and the Negative Sphere2's step inside its cavity. A horn in an area of its own goes into the piece's main support (one
support object, one layer grid). The slicer keeps a twig (a piece of the support's section under 0.6 mm2) 0.2 mm off the part, not the tree's
0.35, as Bambu's horn rings stand. Our horn tops: z 14.80 at x +-2.6, y 4.1 on Circular and both Negative Spheres, x +-2.3, y 2.9 on the Sphere;
Bambu's: z 14.80 at x +-2.6, y 4.2 and x +-2.5, y 3.1. They also hold the Negative Sphere2 rim's two horseshoe ends (span over 2.5 mm 2.9 mm2 -> 0).

Gate after both (`support:gate-column`, 62 of 66): no touching anywhere, no floating stack, every sheet's span p95 within Bambu's + 0.5 mm, parity
unchanged (Base 97, Circular 87, Negative Sphere 86, Negative Sphere2 79, Oblique 84, Sphere 81 %). Left: Circular's twig floating at z 6.58
(0.33 mm2), the Negative Spheres' trunk forks over air (2.7, 3.1 mm2 against Bambu's 0.1, 0.5) and the Negative Sphere's sheet carried 76 %
(Bambu 88 %) - the tree's shape, not the interface.

## 4d. One tree, step 1: the crown's layout (the owner's reference, 2026-11-09)

The owner's reference is Bambu's Negative Sphere in supp_ref: one trunk on a short flare (28 mm2 on the first layer, 16 by z 0.75) to z 4.6,
splitting from 5.2 into 2, 3, then 5 branches that lean all the way to their tips under the rim (9.6), one on up through the hole to the apex,
two past the rim's corners to the shoulders as the horns. Ours split all at once at 7.4 into arms 70 deg off: a tip stood 3.2 mm straight and the
first join no lower than 6.5 mm, so a rim 9 mm over the plate left a few tenths of a mm for the lean.

Under the column rule the crown now has a short straight tip (1.6 mm, Bambu's), a 1.5 mm flare, a first join as low as 3 mm when the lean asks
for it (the trunk stops 1 mm under it, over the flare: a join under the flare's top left the flare without its rings), joins 1.2 mm apart, and
no leg past the 50 deg lean limit (`COLUMN_CROWN` in nso_support_gridpack.js; the default build keeps its own crown). The Negative Sphere's
trunk now splits at 6.3 into 3, then 6 - 7 branches leaning out to the rim by 9.0. Tree over air: Negative Sphere 2.7 -> 0.2, Negative
Sphere2 3.0 -> 0.4, Circular's floating twig and the Oblique's arm gone. Gate 63 of 66 (six pieces), 62 merged: what is left is the Negative
Sphere2 rim's tips (three under its horseshoe, Bambu five or six: span over 2.5 mm 3 mm2, carried 73 %) - step 3. Our trunk is about half
Bambu's (7 - 9 mm2 against 14 - 18).

## 4e. One tree, step 2: the horns off the trunk

A horn is now a branch of the head's tree (`hornToTree`): from its top it leans out as before, drops straight outside the overhangs' stacks (no part
within 2.2 mm over it, 0.6 mm round, below the first 2.2 mm under its top - the shoulder over its own top is no stack), then meets the tree at no more
than 45 deg - the shortest route over its knee, drop and join, to any point of the crowns' branches and trunk (and the legs to the tips, under their
straight columns). With no clear route it stands its own column on the plate as before. Under the column rule the card plans a head's areas at any
height as one group (no height window), so a shoulder's spots are planned with the tree they join. On the Negative Sphere a branch leaves the trunk at
5.2, forks at 6.8 into the two horns, which pass the rim's corners outside its interface at 9.6 (+-2.8, 4.1) and climb to the shoulders at 14.6; Circular
and the Negative Sphere2 the same. The Sphere's horns still stand on the plate (its dome bulges under the shoulder: no clear drop). Gate unchanged,
63 of 66 (62 merged).

## 4f. One tree, step 3: tips under every plate

The detector stood three spots under the Negative Sphere2's rim (a ring 1.5 - 2 mm wide round its cavity, each spot an area of its own); Bambu stands
five or six tips under it. Under the column rule the planner fills an area's spots (`fillSpots`): on a 1 mm grid out to 4 mm round them, the part's
lowest face over the point (a cast up from under the area's band), kept as a spot where it is an overhang at the threshold (flatter than tan 30 read
0.3 mm each way), in the area's height band (1 mm), more than 4 mm over the plate and 1.8 mm from every spot of the area. Its tips then stand
closer as well (`COLUMN_ONE.coverMm` 2.2 against the sheet build's 3.3: no cap spreads a tip's hold). The rim now has nine tips; carried
74 -> 99 % (Bambu 91), span over 2.5 mm 2.1 -> 0. Gate 66 of 66 on the six pieces and on the six as one piece (the merged apex's contact too);
parity unchanged.

## 4g. The support drawn as it prints (generate and slice in one motion)

Under the column rule the card builds the tree alone and the slicer lays the interface, so the generator showed a bare tree until Slice and Preview -
and plates drawn over that tree (b878ea6e) were a block with the branches showing through it, not the interface. Now, right after the build, the slicer
cuts each support (`NSO_Slicer.sliceObjects` with `columnStackOnly`: the column rule run, no paths) and the card draws the support from its sections,
layer by layer (`stackStep`): the tree cut where the part blocks it, the stack on its tips, the cups - what G-scope shows and the printer lays. The
support keeps the tree it was built as (`m.nsoSupport.built`, with the drawing's first corner `shownV0`): that is what every slice cuts
(`window.nsoSupportSliceSoup`, used by the Slice card, G-scope's Slice and support:gate), moved as far as the drawing has been moved since. Slicing the
drawing itself again grew a few layers by 1 - 2 mm2 (a support's small holes filled, its cups laid again) and over air followed. The drawn layers equal
a full slice's, layer by layer, on the Base, Negative Sphere, Oblique and Sphere (a sliver at the top of a horn too small for a line is drawn and not
printed). The preview's slice uses the gate's settings (3 interface layers, the support's own 0.28 mm grid, gap 0.2, xy 0.35). A support saved and
loaded without its built tree is sliced as drawn.

The drawing showed what the slice had laid since 4c, unseen: a wall of cup rings round the Base's plate (its plate's lowest layer was "further than
0.25 mm" from tips 2 mm apart). A cup now stands only under a stack stepping out over the layer under it (a dome's), measured against the tree closed
over gaps of 2 mm each side (`COLUMN_CUP_BRIDGE_MM`: a plate bridges between its tips), and only for 2 mm2 of overhang or more (half a mm2 walled a
whole dome's stack). A plate stands on its tips (4f). Gate 66 of 66; Base carried 89 % (Bambu 85), over air 0.1.

## 4h. One slice: the plate draws what the Slice card prints

The generator's drawing (4g) was a second slice, with settings of its own (the gate's), so the plate and G-scope disagreed. Now the card draws from
the slice the Slice card makes: its printer's profile and its Slice settings (`NSO_Print.sliceOptionsForPlate`, from the same `slicerOptions` the
Slice card's build takes them from), cut at the bed's coordinates as the Slice card cuts them (the slicer's layers can differ with where a piece
stands: the Sphere's grid over its dome moved a quarter of a layer), and only the layers that slice prints lines on. Each layer's plate is
triangulated by three.js's earcut (`prismOf`): the planner's ear clipper gave up on whole pieces (32 mm2 of the Oblique's stack) and the plate
showed a layer missing - the split the owner kept seeing. Measured on the page, after Generate and the Slice card's slice: on all six heads the drawn
layers are the G-code's support layers (54 / 55 / 56 / 57 / 50 / 55, the same heights) and every printed support line lies inside the drawing
(100 %). With no printer picked (node, support:gate) the gate's settings stand in. A setting changed after Generate leaves the drawing as it was until
the next Generate. Generate for plate is the card's default with two or more pieces on the plate.

## 4i. Horns: softer bends, always off the tree

The owner's, drawn on the slice: horns should leave the trunk and bend up to the shoulder, not stand a column of their own on the plate, and bend
softly. A horn's route (top, a lean out to its knee, a drop outside the stacks, a leg into the tree) is now built with its corners rounded
(`smoothHornPath`: at each corner the widest fillet of 2, 1.2 or 0.6 mm that stays clear), its tube thin at the top and thick where it meets the tree.
The stacks a horn keeps out from (`hornShadow`) are now only the overhangs the slicer lays a stack under - part within 2.2 mm over the point whose
underside is flatter than the threshold - not every part over it: the Sphere's horns had to pass beside its dome's steep flank and stood on the plate;
now they join its trunk at 4.6 mm. All eight horns of supp_ref join a trunk (none on the plate); a horn's route is 2 - 5 s (the knee's lean searched to
1.5 mm, the shadow read every 0.5 mm). Gate 66 of 66.

## 5. Not done, and named

- **The merged plate's small surfaces.** The six as one piece are read on a 3 mm grid where each alone is read at 1 mm, so the Negative Sphere2's apex
  has 2 spots (its cone's top) where alone it has 8: a thin column holds the top and the apex's stack is missing (parity 63 %, layer heights 42 %,
  contact 24 / 47 mm2; the owner's earlier merged slice had the same hole). Alone: 83 % / 100 %. Detection should not depend on how many bodies a
  piece holds.

- **The rule is opt-in and not printed.** Default slicing is unchanged byte for byte (`slicer:test`, `slicer:bambu`, `slicer:supports`,
  `support:onetrunk` pass). The gate in build mode fails today's default on 7 checks, so it is not in the CI list yet.
- **The generator still builds its sheet.** Under the column rule its sheet material outside the stack prints as Support (pale rings round
  the Sphere's stack at 8.3 - 9.4). The generator should hand over only the tree and the tips' tops.
- **The tree**: specks (Oblique 8, Negative Sphere 2), the Sphere's leaning twig, Bambu's flank tips. Size and shape, not the interface.
- **Exported meshes** do not carry the rule: the drawn stack (4g) is left out of every slice and export path that reads pieces for slicing. Sending it to
  Bambu Studio as support would make Bambu print the same layers - not done.
- A thin contact ring on the Sphere's flank (z 10.2 - 10.4) where Bambu's interface ends at 10.0.
- `NSO_COLUMN_DEBUG=<z>` prints the rule's per-layer areas above z.

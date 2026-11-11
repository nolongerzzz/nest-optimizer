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

The owner's slice then showed the Negative Sphere2's horns cut off (Support alone shown): they ran through its rim's stack at 9.6 - 9.9 (typed
interface / transition there). The shadow's one ring of rails at 0.9 mm slipped between the rim's corner and the horn 0.7 mm from it, and a rim's
edge (the face falling away) read as a steep flank. Now the shadow is read off a map of the part's undersides round the horns (`hornUnderMap`, a
0.2 mm grid, every face met going up, each flat or not - a face falling away at an edge is an edge, not a slope), out to 1.1 mm (the stack's 0.38
past an overhang's edge and a horn's width), built once a head. Every horn of supp_ref is Support from the shoulder down through its trunk to the
plate (traced line by line in the slice), none through a stack.

## 4j. Every branch at a printable angle; Exclude small overhangs

Each tip's path to the plate (tip, joins, the trunk's top, the plate) was read off the plan for the six heads: the outer branches of the
Negative Sphere, Negative Sphere2 and Oblique leaned 50 deg into a trunk top held at 3.3 mm, and a join beside the trunk's long axis jogged
sideways onto it just over the top (bends of 55 - 64 deg, the Circular's zig-zag). Under the column rule the lean limit is now Bambu's branch
angle, 45 (`COLUMN_ONE.tiltDeg`; a join stands lower where its branches need it), a root's leg lands across the oval as well as along it
(under its join, not on the axis's line), and it lands where the join stands after it moved round the piece (`landS`, again before the root).
Every tip's path: lean at most 45 deg, bend at most 49 (a Y where branches from two sides meet). Gate 66 of 66.

**Exclude small overhangs** (card box, `sup-small`, `opts.noHorns`): no horn to a step's edge, the part holds it; every other spot keeps its
branch and its interface (supp_ref: 8 horns gone, the same 53 tips).

## 4k. The interface square to the bridge above (Studio 02.09)

The owner's P1S slice from Bambu Studio 02.09.01.70 (`fixtures/bambu-templates/p1s-0.4/mouse1.gcode.3mf`, layers 210 - 219): the first
transition layer on the base grid (90), then 93.6 / 3.6 / 93.6 up the stack, under the part's bridge at 3.6 - the top interface square to
the bridge, the layers under it a turn each. The owner: every interface is square to the bridge above (parallel lines weld; crossed ones
release). The column rule now does the same (`columnType`, `bridgeAngleOver`): above its first layer (110, as before) a stack takes the
direction of the part's Bridge / Bottom surface lines that cross its top's region (the lowest of the part's layers within 1.5 mm, gap or
none), the top layer square to it and one turn a layer down; with no bridge over it (a slope's or a ring's top, met by walls) the part's
first layer a gap over the top gives the angle by the solid fill's turn. supp_ref: every stack with a bridge over it is square to it (Base,
Negative Sphere x 2, Negative Sphere2); gate 66 of 66.

**Interface angle, a testing ground** (supports card, `slice-set-iface-angle`; nso_slicer.js `supportInterfaceAngle`, carried with the Slice
settings so Generate slices with it and a change makes the slice stale): *Square to bridge* (`bridge`, the default, above); *3.6 (Studio
2.9)* (`studio36`: Bambu's own on the owner's P1S print, which released clean - the stack's first layer at 90, then 93.6 / 3.6 up to a top
at 93.6, and the part's bridges over supports laid at 3.6, so they cross square); *Crosshatch 45/135* (`crosshatch`, the column rule as it
was: 110, then 45 / 135, parallel to the bridge on some stacks). supp_ref: `studio36` puts every top interface at 93.6 under a bridge at 3.6.

## 4l. The 2x Oblique: welded, and a trunk off the plate

The owner printed NSO's Oblique at 2x on the A1 mini (`Support Oblique - A1 mini.gcode.3mf`): the first try spaghetti, the second welded
whole. Read off its G-code against Bambu's own slices:

- **The interface was a solid sheet**: lines 0.46 apart (the column rule's fixed line + 0.04) where the profile asks for
  `support_interface_spacing` 0.5 - Bambu lays that 0.86 apart (the owner's P1S mouse, which released clean, measures 0.860). The rule now
  lays the profile's spacing over a bead's (`supportInterfaceSpacingMm`, from the print planner's `engineOptions`): 0.5 -> 0.861 on the
  Oblique; a profile of 0.1 (supp_ref's) keeps the dense 0.46; no profile value, the sheet as before.
- **The stair's steps sit 0.2 under the overhang walls** all up the slope (the owner: "every single point is almost touching") - Bambu's
  own Oblique has as many interface points that tight under its overhang walls; at the dense sheet's pitch every one of them was a
  bead's contact.
- **The trunks were a stick on a pad**: a 6.7 mm first layer, then 5.0 -> 4.2 mm within 1 mm; Bambu's P1S trunks taper 7.0 -> 4.3 over
  7 mm on a 13.5 mm first-layer pad. The column rule's flare is 2 mm now (was 1.5); 2.5 and more float an island at the Negative
  Sphere's trunk beside its stem (gate 65 of 66) - named below, with the pad.

**The stair's treads end short of the riser.** The owner, on Bambu's 2x Oblique: each tread is filled so the support's top runs as a
slope parallel to the part's. Measured bead to bead in 3D: Bambu 02.09's 2x Oblique has no support bead closer than 0.18 mm to the part
(p5), NSO's printed one had 8 % within 0.1 (each tread's corner under the overhang wall of the next layer up). The column rule kept the
xy distance only from the part at a support layer's own height; the part's layers in the gap over it were cut straight down. They are now
kept `COLUMN_RISER_XY_MM` (0.2, the gap's own) off sideways too: NSO's 2x Oblique p5 0.20, none under 0.15. Gate: 66 of 66 against
02.08, 65 of 66 against 02.09 (the Negative Sphere's sheet carried, as before).

**One trunk to a head at any scale.** At 2x (supp_ref_2x.3mf) the heads stood two and three trunks and extra pillars, where Bambu's 2x
stands at most two a head: the one-trunk build gathered tips within a fixed 12 mm (ONE.clusterMm, fitted at 1x). Under the column rule a
band's trunk now serves as wide a canopy as its height reaches at the lean limit (0.9 x (lowest tip - root floor - tip drop) x tan 45, never
under 12 mm): supp_ref_2x, every head on one or two feet (four on one), 9 support pieces where there were 11; at 1x the reach is under
12 mm and nothing changes (gate 66 / 65 of 66, as before).

**Tree mode has no pillars.** The owner: "remove the pillars from ever coming back on tree mode, and fix the unreachable zones". Under the
column rule a spot no leg reached (a ledge no strut fits, a spot with no route to the plate) is no longer a thin column of its own: it is
caught by a branch into the tree (`treeBranch`: its top where a thin column's would stand - the spot, else moved along its face up to
1.5 mm - then the horn's route: a knee, a drop, a leg into the tree at 45 deg); else it is named unreachable. A horn that cannot join the
tree is not built (no column to the plate). supp_ref_2x: no pillar, unreachable 0 (was 1, and a pillar), every head on one or two feet;
supp_ref: six heads, six feet; gate 66 / 65 of 66 as before.

**A head's areas are one group as wide as its trunk reaches.** supp_ref_2x's Negative Sphere2 still stood four legs: its rim in three
areas (left, right, back) and its upper face were four groups, each planned alone with a trunk of its own - the card grouped areas only
within 12 mm (`oneTrunkGroups`, ONE.clusterMm). Under the column rule a group is now as wide as one trunk reaches at the lean limit from
its lowest spot (`reachByHeight`, the same reach planOneTrunk's clusters take): that head two trunks, every head of supp_ref_2x one or two,
7 support pieces (was 10); 1x unchanged (gate 66 / 65 of 66).

## 4m. Trunk diameter by Bambu's law; the Tree settings

The owner's new 2x reference (`supp_ref_2x_sep.3mf` and its 02.09.01.70 slice, each head its own object): Bambu's trunks are 9.2 - 9.6 mm
at the plate, ~8 at z 2, ~6 at z 6 - 8 - exactly its Tree settings' law, the branch diameter (2) widening tan(branch diameter angle, 5)
a side for every mm under the farthest tip (the Base: 5.85 predicted at z 8, 5.9 measured), plus a flare over its lowest ~4 mm. NSO's
trunk was capped at a 10 mm-tall law (`uniformH`): 4.4 - 4.6 mm at z 2, 60 % of Bambu's.

The column rule's crown now takes Bambu's law (`COLUMN_CROWN.bambuLaw`): every branch the branch diameter at its top, widening along the
branches (not straight down - a leaning crown is longer than its drop) from its farthest tip; a tip the tip diameter (0.8) widening to its
branch's; the trunk the same law from the crown's length (`pathAddMm`). NSO 2x at z 0.5 / 2 now: Base 9.1 / 7.8 (Bambu 9.6 / 8.3),
Negative Sphere 8.1 / 7.0 (9.4 / 8.1), Circular 6.9 / 5.9 (9.2 / 8.0), Sphere 6.9 / 5.7 (9.4 / 8.2). Bambu's wider flare (4 mm, +2.4 mm
at the plate) floats an island at the Negative Sphere's trunk beside its stem - the flare stays 2 mm, named below.

**Tree settings** (supports card, Bambu's names and defaults; `opts.treeKnobs`, `columnCrownOf`): Branch distance 5 mm (the tips' spacing:
the cover is 0.44 of it, 2.2), Branch diameter 2 mm, Branch angle 45 deg (the lean limit), Branch diameter angle 5 deg, Tip diameter 0.8 mm.
The defaults build what the column rule built before them; Branch diameter 4 widens the 1x Base's trunk 5.3 -> 7.4 mm.

## 5. Not done, and named

- **Trunk bases and pads, as Bambu's** (the law is Bambu's now, 4m; the flare is not): a flare over 2 mm floats an island at the Negative Sphere's trunk (z 1.3, beside its stem);
  Bambu's first-layer pad is about twice NSO's (13.5 against 6.7 mm across). Next, against the owner's Studio 02.09 slice of supp_ref.

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

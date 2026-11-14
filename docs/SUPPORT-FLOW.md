# The flow tree - one program grows every tree support

`nso_support_flow.js` (the planner, pure), wired in through `nso_support_gridpack.js` (`planFlow`, `flowParts`, `flowShells`).
Gates: `npm run support:flow` (the planner alone, on shapes), `npm run support:gate` (the print, against Bambu's slice).

## 1. Why

Auto's tree under the column rule had grown rule by rule: tips thinned, clustered in bands of height, each cluster handed to the
crown planner with a landing circle, joins placed by a formula, a trunk shell revolved under a smooth body, forks split off tips,
horns routed to steps, a cluster split and planned again when a branch found the part in its way. Every rule was tuned on one head
and moved the others: uneven trunks where the shell met the body, branches run through one another, two trees under one head,
gaps where a fork left a tip. Tests #432 went red on such a fix (a trunk's shell narrowed to its body broke the fed crown's law).

The tree is now grown by ONE program, top down, the way Bambu's and Cura's tree supports are. Nothing in it knows a shape.

## 2. The program

Input: the part (and occluders) as triangles, the plate's height, the tips (a spot each, some marked twig), the Tree settings.

1. **The part, read once.** Columns of solid spans on a plan grid; for every level (0.4 mm) the distance to the part, exactly
   (a distance transform of the level's slab, with what hangs just over it).
2. **The reach field.** From the plate up, a cell is *free* for a branch of a given thickness when the part is far enough from it
   there (the branch's radius at that height, a leaning tube's wider section, the xy distance) **and** a free cell lies next to it
   on the level below. A branch that keeps to free cells always has a way down, so nothing is found blocked afterwards and
   nothing is split and planned again. Thickness is binned by the height of the highest tip carried; the free sets are nested,
   one byte a cell holds them all.
3. **The tips.** Each stands straight under its spot (2.8 mm: through the interface's stack and the slicer's ring lines) at the
   branch diameter; where the room under the spot is taken it starts lower and leans to the nearest free cell. A spot with no
   free start within reach is *unreachable*, said so, and never built.
4. **The descent.** Level by level every branch
   - goes for another: the nearest two first, each branch in one pair, so a field of tips halves at every meeting; a pair holds
     while it can still meet in the height left; a share of the heading (`gather`) is toward the middle of everything in reach,
     so a canopy draws in to one trunk while its height allows;
   - moves no further than the branch angle allows a level, the heavier of two first (the lighter aims at where it lands);
   - steps only onto free cells (it walks round the part);
   - becomes one branch with its pair where their middles meet. Neither steps sideways to join.
   Nothing leans or joins in the last 2.4 mm: the flare stands straight.
5. **One law.** A branch's radius is the branch diameter at its top, plus tan(diameter angle) for every mm under the highest tip
   it carries, plus a flare over the last 2 mm. Twig, branch and trunk are the same thing at different depths. A twig starts at
   one ring of line and follows the same law from there.
6. **One body.** The branches are tapered capsules; their smooth union (the existing `blobSoup`, a tree at a time) is the
   support: kept 0.4 mm off the part, cut flat at the plate and at each tip's spot. There is no trunk shell, cap, or join ball.

Where the trunks stand, how many there are and where the forks are is what falls out.

## 3. What goes in, and what did not change

`planFlow` runs when Auto builds a tree under the column rule (the default). The spots are the same as before: the detector's,
plus the 1 mm fill on flat rims (`fillSpots`); thinned an area at a time to the branch distance (`thinTips`, cover 0.44 x, 1.0 x on
an area of 300 spots or more); a spot within 4 mm of the plate is the plate's; a step no slicer calls an overhang gets a twig
(none with *Exclude small overhangs*, none where an overhang's own spot is within 4.1 mm in plan and 1.5 mm under it). Every spot is
asked for its way down BEFORE the thinning (`candidates` / `pick`): one with none stands no tip, is not held through a tip beside it, and
is named unreachable; the spots beside it are thinned without it and stand tips of their own.

The plan is the planner's usual shape (`beacons`, `trunks`, `unreachable`, `oneTrunk`'s counts) with `plan.flow` carrying the
branches; `parts()` and `shells()` hand back one support a piece, with a foot under every trunk for the shared pads.

Unchanged: the interface (the slicer's column rule), Custom and Assisted (the fed crown), the sheet rule's build, straight struts,
"may rest on the part" (the spots the tree could not reach are planned again by the lattice, as before).

Slicer, two faults found on the way:
- the ring lines under the stack (`COLUMN_TUBE_FILL_*`) cross a ring only - a piece of 6 mm2 or less, a line of 2.6 mm or less. Across
  branches already joined into one hollow body they lay over air;
- a support's first layer was hollow under its trunks whenever part of its pad lay open (a pocket between trunks): the one-wall-on-top
  rule ran on supports and kept the fill to the exposed part, and the trunks' second layer stood on nothing. Supports are out of that rule.

The body's foot is put exactly on the plate (`blobSoup` `cut.flat`): the mesher left it a few hundredths under.

## 4. Measured (2026-11-13)

`support:gate` (six heads of supp_ref against Bambu Studio 02.09): 66 of 66.

| head | tree over air mm2: before / flow / Bambu | tree path mm: flow / Bambu |
|---|---|---|
| Base | 0.5 / 0.0 / 0.0 | 1566 / 1624 |
| Circular | 0.6 / 1.6 / 0.2 | 1130 / 1470 |
| Negative Sphere | 0.8 / 0.6 / 0.2 | 2248 / 1998 |
| Negative Sphere2 | 1.1 / 0.2 / 0.7 | 1881 / 2441 |
| Oblique | 2.1 / 1.4 / 0.5 | 1940 / 2353 |
| Sphere | 0.1 / 0.3 / 0.1 | 680 / 1074 |

The six together: 9445 mm of tree path against Bambu's 10960 (-14 %). `--merged` (the six as one piece, as the owner's plate has them):
66 of 66. The owner's 2x Oblique: one tree on one trunk (it stood two), 8 % less tree path than Bambu's slice of it, built in 2.2 s.
Unreachable 0 on every head. A block with a tunnel through it: the ceiling's spots by the mouths held, its middle named unreachable,
nothing unsupported.

## 4b. May rest on the part (2026-11-14) - the owner's Supporttest, printed twice from Bambu's slice

Reference: `fixtures/supports/supporttest.3mf` and Bambu Studio's slice of it, `supporttest_slim.gcode.3mf` (tree(auto), threshold 46, `support_on_build_plate_only = 0`,
bottom z distance 0.2): a 40 x 50 x 12 mm plate of bridges, a ring, a slot, and one corner that hangs over the part itself, where Bambu's tree stands on the part.

**The landing.** With the card's *May rest on the part* (`opts.restOnModel` -> the planner's `rest`) a cell is a *landing* on the first level that clears a top
face of the part under it, and the reach field counts a landing as it counts the plate: a way down. A branch keeps going for the plate while it has a step
down; where it has none and stands on a landing it ends there, its end run down to the face (`branch.rest`, `plan.flow.rests`). A foot on the part has no flare
and no pad; its body comes down to the bottom distance over the face (Advanced: Bottom distance, 0.2), not the 0.4 it keeps off walls and undersides. A spot a
short way over a face (a pocket's ceiling over its floor) has a tip as long as the room is (`restMinMm` 0.8 at least).

Before this, Auto planned the plate-only tree and handed what it could not reach to the lattice: the Supporttest came out as 8 supports with pillars of their
own. Now it is one tree, one support, and the lattice is not asked.

**One plan a piece, and how many supports.** The card plans a piece's areas together (`groupAreas`): the tips of every area go down in one descent and join
where they meet. The result is handed back as ONE support where areas' tips stand within 12 mm of one another (`FLOW.oneSupportMm`: side by side under one
overhang, pocket by pocket in one piece) and as supports of their own where they stand apart (six heads imported as one piece: six supports). The slicer works a
support's layer heights out from its own stacks, so heads that stand apart keep Bambu's heights, and areas side by side share one grid.

**The field is the part's.** The grid, the distances and the reach field depend on the part, the settings and the height of the highest spot - not on which tips
are grown - and the last one is kept: a second plan of the same piece reads it (400 tips: 1.4 s, then 0.06 s).

**The body's mesh.** A tree under a low part is near the part everywhere; the mesher asked the part's distance point by point (13 of the Supporttest's 25 s).
It is asked once a 0.5 mm lattice point now and read between them; the body's cell is 0.3 mm. The Supporttest builds in 13 s (was 25).

`npm run support:gate-rest` (the gate, `--fixture` and `--rest`; the slicer's footprint at the card's angle; a support standing on the part is not floating):

| | Bambu's slice | NSO |
|---|---|---|
| supports | - | 1 (was 8) |
| floating islands | 0 | 0 |
| tree over air mm2 | 30.9 | 18.0 |
| contact area mm2 | 822 | 773 |
| sheet carried | 100 % | 97 % |
| tree path mm | 18349 | 16435 |
| touching mm2 | 0 | 1.35 (fails: one spot, the interface's edge at a step - the slicer's, not the tree's) |

10 of 11. Not in `testSteps` (as `support:gate` is not): about a minute.

## 4c. Advanced, and the saved settings

The card's **Advanced** section (docs/SUPPORTS-CARD.md) is these numbers, each with its default; only one that differs is sent (`opts.flowKnobs`), held to a
range (`FLOW_KNOBS`): Tip spacing (`tipCover` 0.44 x the branch distance), Tip column (`tipDropMm` 2.8), Gather (0.25), Join reach (0.95), Straight foot
(`rootFloorMm` 2.4), Flare height / slope (2, 0.45), Foot pad (0.6), Part clearance (`xyMm` 0.45), Bottom distance (0.2). `plan.flow.advGiven` says what a
build was given. **Saved settings** keeps every lever of the card under a name.

## 5. The planner's own gates - `npm run support:flow`

Nine shapes (a free slab, a slope, a slab over the part's own pedestal, a shelf off a wall, a ceiling closed in, a floor under half
a slab, a twig beside a canopy, a field of 400 tips, a squat slab), the same questions of each:

- **structure**: every tip built runs to the plate through its branches; no branch leans past the branch angle (a forced step round
  the part may add a cell); no branch thinner going down, nor than one that runs into it;
- **clearance**: no branch point in the part or against it; no trunk on or against the part's base;
- **no welds**: two branches of no kin never run through one another without joining;
- **economy**: the tree is shorter than a column under every tip; trunks as few as the height allows (400 tips: 26 trunks);
- **same again**: the same input gives the same tree.
- **resting on the part**: a ceiling closed in over a floor is unreachable plate-only and held from the floor with `rest`; a low ceiling's tips stand on
  the floor under them while a shelf's beside it stand on the plate; no foot on the part has a flare;
- **the field is kept**: a second plan of the same piece is quicker and the same.

## 6. Knobs

The card's Tree settings (branch distance, diameter, angle, diameter angle) are the planner's. The rest are `DEFAULTS` in
`nso_support_flow.js`, each with its reason beside it; `opts.flow` overrides one for a test.

## 7. Left to do

- Custom / Assisted still build the fed crown (landing circles, Tune's knobs). The flow planner takes given tips as they are; the
  circles would be a pull on the descent. Not done here: it changes what the Custom card promises.
- The interface's edge at a step touches the part on the Supporttest (1.35 mm2, one spot): the slicer's stack, to look at with the interface.
- A plate too wide for the grid (`cellsMax`) is planned coarser, and the print gate was tuned on the fine grid: the six heads as one piece failed it
  coarse (a dome's cup dropped). The grid is read only as high as the highest spot now, which keeps that plate fine; a much larger one is still coarse.
- **The levers are in three places** - this card, the Slice section's settings (its own support threshold, 30, where the card's Angle is 35 / the owner's 46;
  the gate passes the card's angle to the slicer, the page does not), and G-scope's. One print / prep card that owns them all is the next step; Saved
  settings is the stopgap (it keeps the card's and the interface / raft rows).
- The superseded column-crown rules in `nso_support_gridpack.js` (tip forks, horn routes, cluster splits, the shell's narrowing)
  are no longer reached by Auto under the column rule; they stay while the sheet rule and the fed crown share their code.
- A squat head's trunks stand side by side where their height leaves no room to join (lobed foot, as Bambu's merged contours).

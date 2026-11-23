# Multi-colour printing (AMS, P1S)

The way in, step by step, each checked against the owner's own Studio slices of a
3-colour test pyramid (Studio 02.09.01.70, P1S with AMS, 2026-11-22):

1. **Read the paint** - done (below).
2. **Colour each layer from the paint**, where a layer is one colour - done.
3. **Write the filament changes**: Studio's own P1S change block, purge per colour pair,
   temperatures, which slot comes next - done, line for line with Studio's.
4. **Each slot's length and weight** in the header and the plate info; the change time
   in the estimate - done.
5. **The prime tower** - done, line for line with Studio's on every one of its 108 layers.

Reference files: `fixtures/multicolor/pyramid-3colors.3mf` (the project's models and
settings, slimmed). The owner's two slices of it (prime tower on, and off) are what
steps 2 - 5 are checked against.

## The pyramid

A 30 mm pyramid on its square base, painted in horizontal bands with Studio's colour
brush: grey (filament 1) to 8.44 mm, black (3) to 15.29, white (2) to 21.45, then the
pyramid's own grey (state 0, the object's filament 1) to the top. Studio's slice
changes filament three times after the first load, at layers 8.6, 15.4 and 21.6 -
the first layer whose mid-height (8.5, 15.3, 21.5) is past each band's edge - and
every layer prints whole in one filament, its infill too. With the prime tower on it
is built on 108 of the 148 layers (Studio's 150).

## The paint (`nso_paint.js`)

Studio writes `paint_color` on each painted `<triangle>` (PrusaSlicer writes the same
code as `slic3rpe:mmu_segmentation`). It is a hex string read **from its last
character to its first**, one nibble at a time:

- low two bits: how many of the triangle's sides were split (0: a leaf);
- a leaf: the high two bits are its state, 3 meaning "3 or more" - the next nibble is
  added to 3 (states up to 18);
- a split triangle: the high two bits are its special side (the corners are taken
  from that one), then its children follow, **the last child first**:
  - 1 side: the midpoint of the side opposite the special corner; two children;
  - 2 sides: the midpoints of the two sides at the special corner; three children;
  - 3 sides: all three midpoints; four children, the middle one last.

A state is a filament: 0 is the triangle's own (its part's filament, else its
object's, from `model_settings.config`), 1 the first filament, 2 the second...

Checked: the pyramid's 6 triangles decode to 8190 leaves whose bands end at exactly
8.4375, 15.293 and 21.445 mm; reading the children first-child-first instead gives
colours scattered across the faces. A code that runs out reads as the whole triangle
in its own filament (`decode` returns -1).

## Where the paint lives

- **The reader** (`nso-3mf-read.js`) keeps, per triangle of each build item's soup,
  its code (or null), whether the reader swapped two of its corners (a mirroring
  transform: the file's order is then 0, 2, 1) and its own filament (its part's, else
  its object's); with the project's `filament_colour` list. An object carries `paint`
  only when something is painted or a part prints with a filament other than the first.
- **The piece** (`model.paint`, app-core.js) holds it while its triangles are the ones
  it was read with: `NSO_Paint.fits` (the same count). A clone copies it. A tool that
  rebuilds the piece leaves it without colours.
- **The view** (`app-paint-view.js`): every frame, before the render gate, each
  displayed mesh of a painted piece gets an overlay of its leaves in the project's
  colours, drawn just over its surface (polygon offset). It is a helper owned by
  `colours` (never picked, exported or counted), rebuilt only when the mesh's
  geometry changes. The leaves are found from the displayed mesh's own triangles, so
  a posed or turned piece shows its colours where they are.
- On load the status line says which filaments a painted piece uses.

## Colours on one layer (nso_paint_segment.js; the slicer splits the piece)

A painted piece is split, layer by layer, into one region a filament, as Studio's
MultiMaterialSegmentation.cpp splits it, and each region is sliced as a part of its own -
its own walls, its own fill - while what counts as a top or a bottom is still the whole
piece (the slicer's `P.Sfull`). The regions come back as one object whose paths each
carry their slot.

1. **The sides**: each painted triangle crossing a layer's cutting plane colours the
   outline where it lies (unpainted stretches: the piece's own filament); the layer goes
   to the colours of its outline, each point to the nearest (Studio: a Voronoi diagram;
   NSO: a 0.05 mm raster of each colour's distance, the boundary interpolated where two
   are equal, cut back to the exact outline). An outline of one colour is that colour.
2. **The tops and bottoms**: a top face (painted or not) colours the layer it caps and the
   `top_color_penetration_layers` - 1 below it, each one (outer wall + spacing) further in
   from the layer's outline; a bottom face the same upwards (`bottom_color_...`). A face the
   next layer covers is no top / bottom. They win over the sides.
3. What is left, and any sliver narrower than half a wall, is the piece's own filament.

**The order of a layer's colours** (planner `orderColours`, Studio's
`reorder_filaments_for_minimum_flush_volume`): layer by layer, every order of its
filaments and the next layer's is tried from the one loaded; the cheapest purge over both
wins (a tie to fewer changes). On the owner's Gulf logo: white; white grey black; black
grey white; white grey black; black white grey; black grey; grey - Studio's, ten changes.

**Several changes a layer on the tower**: each change is its own visit, where the layer's
colours change; a layer that starts on the loaded filament goes to the tower at its
first change. The tower is as deep as the most purges on a layer (the logo: two 45 mm^3
purges, 15.5 mm); each purge has its own band, each band its gap in the wall; the wall
goes before the first change when the old filament is the wall's, or after the last
change that brings the wall's filament in (Studio makes it at each and keeps the last).
`M73 E` after each `T` counts the changes still to come (the pyramid's 2, 1, 0 looked like
slots).

Checked in `print-slice-check` 5e on the owner's logo (`fixtures/multicolor/gulf-logo.3mf`
and Studio's slice of it): each layer's colours, their order and where the tower comes
are Studio's; every tower layer is Studio's line for line (to 0.0011 mm: the way round
the tower ends at 194.022 where Studio's is 194.023); ten changes, `M73 E9` to `E0`.

A layer whose purges do not fill the tower's depth (fewer changes than a layer above)
gets the rest of its band filled - its rectangle and a sparse grid, Studio's
`finish_block` - in the visit that carries the wall, just before it; Studio may put the
same lines in another visit. Not checked against a Studio slice yet: every changing layer
of the logo has two changes, the pyramid's one.

## A layer's filament (step 2: app-print.js `layerSlots`, before colours on one layer)

Each layer of a painted piece prints with the filament its paint has at the layer's
mid-height, the plane Studio slices at: the leaves the plane crosses, weighed by the
length of their cut. A layer whose cut is 99 % one filament is that filament (a leaf's
edge just touching the plane is not a second colour); one that really crosses two
colours (a logo on a face, two parts of different filaments) is refused for now, with
the height. The slot goes on the slicer's layer (`L.slot`, 0-based) for the planner.

## The project's filaments (app-print.js `withProjectFilaments`)

The printer profile's template holds one filament. A plate whose painted pieces use
more than one slices with their Studio project's filaments: every list the template
keeps per filament (one entry a filament, or two - a filament's two extruder variants)
that the project lists for its own, and the purge table (`flush_volumes_matrix`,
`flush_volumes_vector`, `flush_multiplier`, `filament_map`); the rest stays the
template's. The file's CONFIG_BLOCK lists them once a filament (Studio:
`nozzle_temperature = 220,220,220` where the project keeps six), words joined with
`;` and numbers with `,`. A painted piece whose project is not open, or one painted
with a filament its project does not have, is refused in words.

## The change (step 3: nso-print-planner.js `multiColour`, `changeFilament`)

Written as Studio 02.09's `set_extruder` writes it with no prime tower (GCode.cpp):

- the retraction topped up to `retract_length_toolchange` (2 mm: `G1 E-1.2` after the
  wipe's 0.8);
- the old filament's end G-code;
- the template's `change_filament_gcode`, through NSO's reading of Studio's template
  language (`studioTemplate`: `[name]`, `{expression}`, `{if}{elsif}{else}{endif}`,
  numbers as C++ writes a double) with Studio's values: the purge from
  `flush_volumes_matrix` (row the old slot, column the new) times `flush_multiplier`
  less `grab_length`, as filament length (in single precision, as Studio's floats), in
  at most 4 equal parts of about 135 mm^3 (`flush_length_1..4`); the cut's
  `long_retractions_when_cut` / `retraction_distances_when_cut` (a filament's own over
  the printer's); flush speed and temperature (the filament's, else its max flow and
  the top of its range); the travel points of the second change (Studio's
  `get_path_of_change_filament`: a free strip of x past the objects);
- an F repeated from the line before dropped, as Studio's cooling buffer drops it, and
  `M73 E<slot>` after the `T`;
- the fans put back, `M104 S<t> ; set nozzle temperature`, the new filament's start
  G-code.

A layer that starts on another filament changes after the layer change's lift and
timelapse; two objects of different filaments on one layer change between them, the
loaded one first. The change's time counts towards the layer's for its cooling, as
Studio's counts it: the pyramid's change layers print at full speed. Checked in
`print-slice-check` 5c: the pyramid's three changes are Studio's line for line (but
the part fan's value, which is NSO's cooling).

## The P1S's layer change, as Studio writes it

Three things the pyramid showed that were wrong on the P1S before, single-colour too:

- the timelapse goes at the layer change, after the spiral lift and before the
  object and the travel (a core-XY's: Studio puts it after the first walls only on
  an i3 - the A1 mini);
- the P1S template's `extruder_offset` (0x2): Studio writes every move of the print
  2 mm back in Y, the bed-mesh box not;
- the aux fan at 70 % is `M106 P2 S178` (Studio truncates; NSO rounded to 179).

## Totals (step 4)

The header lists each slot's length, volume and weight (what it printed, its purges,
and the start block's purge for the first) and `; filament: 1,2,3`; the plate info's
filaments and their load / unload times, and its `layer_filament_lists` (a layer's
filaments are the ones that print on it, ranges joined with `,` as Studio's), follow
from it. Studio's per-slot totals differ from a recount of its own moves by about
16 mm a slot; NSO's are its moves.

## The prime tower (step 5: nso-print-planner.js `primeTower`, `towerVisit`)

When the project has `enable_prime_tower` on and the plate changes filament, the P1S
prints Studio 02.09's rectangular tower, written as Studio's WipeTower writes it
(single precision, its moves rewritten into plate coordinates as Studio's
post-processing rewrites them, an F the line before left in force dropped as its
cooling buffer drops it). The project's tower settings come in with its filaments
(`TOWER_KEYS` in app-print.js): the template's own tower is 35 mm with rib walls.

- **Where and how big**: the project's `wipe_tower_x / y`, `prime_tower_width` wide; deep
  enough for the biggest purge (`filament_prime_volume` as lines across the tower: 20 mm^3
  at 0.2 mm is 25 lines, 12.5 mm, and the wall makes it 13), never shallower than
  Studio's minimum for its height. When a piece covers that spot on NSO's plate the tower
  goes to the clear spot nearest it (2 mm from every piece, with its brim), and the card
  says so.
- **On which layers**: from the first up to the last change (the pyramid: 108 of 148).
  It prints first on its layer, after the layer change and the timelapse.
- **A layer without a change**: the rectangle inside the wall, its sparse grid (two lines;
  solid on the first layer), the outer wall; the first layer adds a 7-loop brim
  (`prime_tower_brim_width` 3 mm), the next five a chamfer one loop narrower each. The
  loops step out by the line spacing cut to 1e-5 mm, as Studio's `scaled()` cuts it.
- **A change**: the outer wall with a gap of 2.5 lines either way of where the purge
  starts, in the wall's filament (the one on the tower on most layers) - before the change
  when the old filament is that one or neither is, after it when the new one is; then the
  change (Studio's change block, the same as without a tower: its purge goes down the
  chute), the way round the tower's box to the purge's start (lifted on a 3 degree slope),
  and the new filament's purge: line by line across the tower, a 3 mm line ironed at the
  start, at 33 / 37.5 / 45.8 / 87.5 % of the tower speed for its first lines. Which corner
  it starts from, and which way, turns with the layer number, as Studio's does.
- **Out**: the wipe back along the last line, the rest of the retraction, a slow lift
  (`prime_tower_lift_speed`), then the object.
- The bed-mesh box takes in the tower's brim (G29 from X56.5786, Studio's); the plate
  info lists it as `wipe_tower` (id 1000), and a layer's filaments are its object's (the
  tower's wall in the old filament does not count, as in Studio's).

Not written: rib walls (refused in words), two materials Studio keeps apart on the tower,
the side scrape, interface features, a tower on the A1 mini (its plate changes filament
without one, and the card says so). A layer that prints two filaments is refused with a
tower, as without one.

Checked in `print-slice-check` 5d: every tower layer of the pyramid is Studio's line for
line (but the spiral's radius, the object's id, the part fan, the wipe's speed - the speed
of NSO's own last path - and the first layer's speed, the template's 40 mm/s where
the owner's project has 50); the bed-mesh box, the plate info and the layer filament lists
are Studio's; a rib-walled tower is refused; a tower spot under a piece moves.

Also fixed on the way: the plate info's footprints are the plate's, not the nozzle's (the
P1S's `extruder_offset` 0x2 is added back: 111.531, Studio's 111.5306).

Not yet: NSO's own 3MF export and saved plates do not write the paint back, so a
painted piece saved from NSO comes back plain. The tower is not drawn on NSO's plate
before slicing.

Checks: `npm run paint:test` (the code, the pyramid's bands, filament per part),
`npm run paint:drive` (the real app: the pyramid opened, drawn in its three colours,
never picked, kept by a clone, dropped when the triangles change; a screenshot in
`tools/paint-out/`).

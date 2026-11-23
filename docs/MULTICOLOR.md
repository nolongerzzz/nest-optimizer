# Multi-colour printing (AMS, P1S)

The way in, step by step, each checked against the owner's own Studio slices of a
3-colour test pyramid (Studio 02.09.01.70, P1S with AMS, 2026-11-22):

1. **Read the paint** - done (below).
2. **Colour each layer from the paint**, where a layer is one colour - done.
3. **Write the filament changes**: Studio's own P1S change block, purge per colour pair,
   temperatures, which slot comes next - done, line for line with Studio's.
4. **Each slot's length and weight** in the header and the plate info; the change time
   in the estimate - done.
5. The prime tower.

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
is built on 111 of the 148 layers.

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

## A layer's filament (step 2: app-print.js `layerSlots`)

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

Not yet: NSO's own 3MF export and saved plates do not write the paint back, so a
painted piece saved from NSO comes back plain.

Checks: `npm run paint:test` (the code, the pyramid's bands, filament per part),
`npm run paint:drive` (the real app: the pyramid opened, drawn in its three colours,
never picked, kept by a clone, dropped when the triangles change; a screenshot in
`tools/paint-out/`).

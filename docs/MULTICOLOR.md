# Multi-colour printing (AMS, P1S)

The way in, step by step, each checked against the owner's own Studio slices of a
3-colour test pyramid (Studio 02.09.01.70, P1S with AMS, 2026-11-22):

1. **Read the paint** - done (below).
2. Colour each layer from the paint, where a layer is one colour.
3. Write the filament changes: Studio's own P1S change block, purge per colour pair,
   temperatures, which slot comes next.
4. Each slot's length and weight in the header and the plate info; the change time
   in the estimate.
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

Not yet: NSO's own 3MF export and saved plates do not write the paint back, so a
painted piece saved from NSO comes back plain.

Checks: `npm run paint:test` (the code, the pyramid's bands, filament per part),
`npm run paint:drive` (the real app: the pyramid opened, drawn in its three colours,
never picked, kept by a clone, dropped when the triangles change; a screenshot in
`tools/paint-out/`).

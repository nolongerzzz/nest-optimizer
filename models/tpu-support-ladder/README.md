# CR-TPU support ladder

A first support test for CR-TPU (2026-11-25): the owner found the Supporttest too hard a start, and 0.33 mm too close a gap for TPU
to let go. Four small shelves - a 10 x 20 mm column, a 3 mm shelf reaching 14 mm out at 10 mm up, a flat overhang - each with its own
top gap, engraved on it: 0.4, 0.6, 0.8, 1.0 mm (2 - 5 layers of air at 0.2 mm).

One gap per shelf needs a support's own gap: the slicer takes `supportGapMm` on a support object (`gapMm` in `nso_slicer.js`), over the
slice's own; the Print card has no row for it yet.

    python3 make_shelf.py . 0.4 0.6 0.8 1.0      # the shelves (manifold3d, trimesh, matplotlib)
    node make_plate.js 0.4 0.6 0.8 1.0           # supports by the card's build, CR-TPU on the A1 mini, one .gcode.3mf

## The first print (2026-11-25) and exact gaps

0.4, 0.6, 0.8 and 1.0 all peeled off about equally - close in feel, no loose strands. At 0.2 mm layers NSO rounded every gap up to whole
part layers (0.21 - 0.40 all printed 0.4), so the 0.4 shelf is what NSO's 0.33 baseline prints. **Exact top gap** (the support rows'
checkbox, `supExactGap`; the slicer's `supportGapExact`) stands the support's top its gap to the dot under the part - its own layers end
there - so `node make_plate.js 0.36 0.37 0.38 0.39` with `SET='{"supExactGap":true}'` prints four different gaps. `npm run support:exact-gap`
checks it.

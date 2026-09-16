The owner's STLs served by the Library catalog (`app-library.js`).

## Not CSG-safe: `box_closed.stl`

`box_closed.stl` is an overlapping-shell concatenation from the early
generator: a thin-walled tray and a lid slab that overlap the wall tops by
0.1 mm. It is watertight per shell and slices correctly (a slicer union-fills
the overlap), but the overlap is 74 real piercing pairs and 34 coplanar
overlaps, so **do not run Join or Subtract on it** expecting a clean result.
It is raw hull material for chopping and reassembling, not a CSG-safe part.

It is deliberately left as is rather than regenerated as a union, because
`tools/sculpt_selftest.js` (section 10), `docs/SCULPT-TIER1.md` and the
`maxVolumeChange` note in `app-sculpt.js` record measurements against exactly
this two-shell tray-plus-lid layout. A union would turn it into one sealed
hollow box (outer skin plus cavity skin, 19353.6 mm³) and invalidate those
numbers. If you need the CSG-clean version:

    node tools/nso_fixture_union.mjs library/box_closed.stl out.stl --header bit:box_closed

## CSG-safe since 2026-09-16

`hinge_knuckle_box.stl`, `hinge_knuckle_lid.stl`, `hinge_pip.stl` and
`lid_strap.stl` were regenerated as real boolean unions of their shells and
measure 0 piercing pairs. See `fixtures/README.md` for the numbers.

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

## Deleting from here

The Library browser has a `×` on every row. It removes the row's `CATALOG`
entry from `app-library.js` **and** the file from this directory, as two
commits on the real repository, behind a confirmation dialog — it needs a
GitHub token with `contents: write`, pasted at the time. See
`docs/LIBRARY-DELETE.md` for what is and is not possible from a static page,
and for the permission gate that is architected but deliberately not built.

## Removed: the four `_bordered` washers

`patch_crosshatch_bordered.stl`, `patch_crosshatch-fine_bordered.stl`,
`patch_zigzag_bordered.stl` and `patch_ring_bordered.stl` were deleted — the
bordered construction bonds to a stacked part at 2.857x the contact of a true
flat line, which makes it unusable as a separating washer. The variant itself
is untouched: `NSO_SkinPatch` still builds it and `fixtures/skin-patches/`
still gates the three bordered fixtures. Only the shipped library samples went.

## Traced Lines: `traced_cross_23-67`, `traced_parallel_113`, `traced_hand_stroke`

Built by `tools/nso_raster_library_samples.js` (`npm run raster:library` to
byte-diff) from the real images in `fixtures/raster-real/` — pictures Chromium
drew, not this repo. The generator refuses to write any piece whose component
and junction counts disagree with what the source picture actually contains.

All three are a **one-extrusion-line lattice**: closed and watertight, but every
wall is 0.42 mm, which is this repo's own `--min-wall`. They are flagged
non-solid for the reason the loose skin patches are — do not expect a wall-
thickness check to pass them.

30 × 30 mm, the skin patches' footprint. `traced_cross_23-67` is the piece that
found the crossing-bridge bug; see `docs/RASTER-LINES.md`.

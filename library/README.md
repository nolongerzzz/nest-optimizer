Fixtures that checks in `tools/` and `cth/` load **by name** from `library/`.

This directory used to be where the Library catalog's pieces lived. They moved
to [nolongerzzz/nest-library](https://github.com/nolongerzzz/nest-library),
and the page now fetches every catalog row from there
(`app-library.js`, source `nest-library`,
`https://raw.githubusercontent.com/nolongerzzz/nest-library/main/<file>`).
What stayed is what a check here reads off disk, so the suite keeps running
with no network and no second checkout.

**Do not add catalog pieces here.** Save in the app writes new pieces to
nest-library; a file here is only worth keeping if a check loads it.

## What is here, and who reads it

Also catalog rows - so nest-library holds a byte-identical copy of each, and
`tools/nso_library_delete_test.js` fails if the two ever differ:

| file | read by (among others) |
|---|---|
| `box_bit_12x8x8.stl` | seat / carve / wire / oversized-washer checks, `csg_bench` |
| `box_hull_80x40x20.stl` | `seat:box-on-box`, `seat:tilted`, `3mf:import`, `csg_bench` |
| `box_hull_80x40x20-2.stl` | `support:test` |
| `box_closed.stl` | `sculpt_selftest`, `support:test`, the G-code entry / overlay checks |
| `pin.stl` | the Library save / delete checks, `seat:surface` |
| `USB_bit.stl` | `thicken:check` (the inward-wound STL) |
| `hinge_knuckle_box.stl` | `3mf:import` |
| `tape_on-edge-single.stl` | `wire:mirror` |
| `v9_mirror_factory.stl` | `wire:solidify`, `rawcut:seam` |

Not catalog rows - only here:

| file | read by |
|---|---|
| `CTH_fixture.stl` | the `cth:*` checks and `cth/nest-paint-soften-drive.js` |
| `soften_test_01_cube.stl` | `support:test` |
| `soften_test_03_thinwall_tube.stl` | `sculpt_selftest`, `thicken:check`, `csg_bench` |
| `soften_test_04_slotted_block.stl` | `mirror` |
| `soften_test_05_star_prism.stl` | `sculpt_selftest` |
| `tape_on-edge-single-B101_rounded_v8_FINAL.stl` | `selfint:equiv`, `mirror`, `support:*`, `sculpt_selftest`, `csg_bench` |

`selfint:equiv`, `defects:test` and `fixtures:gate` also walk every STL here,
and - when there is a nest-library checkout - the catalog-only pieces in it.

## The checks that need nest-library

The checks about the catalog itself (every row has a file; the skin-patch,
traced-line and quick-fixture generators' output is byte-identical to the
shipped piece; one real click per category loads) read a nest-library
checkout, found by `tools/nso_library_dir.js`:

1. `$NSO_LIBRARY_DIR`, if set (`NSO_LIBRARY_DIR=none` forces "no checkout");
2. else `../nest-library`, a clone beside this repo;
3. else those checks print `SKIP ... - no nest-library checkout` and do not pass.

CI checks nest-library's `main` out and sets `NSO_LIBRARY_DIR`, so there they
always run. `npm run library:live` loads every row from the real repository
through the page in Chromium (needs the network; not part of `npm test`).

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

`hinge_knuckle_box.stl` was regenerated as a real boolean union of its shells
and measures 0 piercing pairs, as were `hinge_knuckle_lid.stl`,
`hinge_pip.stl` and `lid_strap.stl` (now in nest-library and `fixtures/`). See
`fixtures/README.md` for the numbers.

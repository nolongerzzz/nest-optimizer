## Export round trip + fixture integrity - standing checks (added 2026-09-16)

Two suites added after the infrastructure health pass, both in `npm test`.

**`npm run export:roundtrip`** (`tools/nso_export_roundtrip_test.js`, ~40
checks, headless Chromium through `nso_app_harness`). The general form of the
liftY bug fixed in 1cef66a. Two pieces are posed off-centre - box-20mm yawed
0.7 rad and lifted 3.37 mm, the pocket brick tilted 15 deg and lifted 0.18 mm -
and all four export routes are pressed for real (**Export plate** and
**Download selected**, Format = STL and = 3MF, filename prompt accepted). Each
browser download is re-opened from disk with a parser that is not the app's
(a stdlib binary-STL reader; `nso-3mf-read.js` for 3MF) and compared vertex
for vertex, in order, against `p.geometry` pushed through `p.mesh.matrixWorld`
- what the viewport draws, not the `p.x / p.height / p.liftY` bookkeeping the
exporters read. Then every file goes back in through `handleFiles()` and the
new model's `rawTris` must equal the file soup, untranslated. Measured max
deviation on the plate routes: 8.4e-7 mm (STL) and 2.6e-6 mm (3MF, six-decimal
text); gate is 5e-5.

Conventions the suite pins, all read off the shipped code:
- scene `(x, y, z)` Y-up -> file `(x, -z, y)` Z-up; the scene rests a piece at
  y = 0.2 (`settlePlacedOnBed`), the file at z = 0, so `file_z = scene_y - 0.2`.
- the plate 3MF adds `(plate.w/2, plate.d/2)` for Bambu's front-left origin.
- **Download selected exports the MODEL, not the placed instance**: STL at the
  model's own centred origin, 3MF centred on the plate resting on z = 0. Yaw,
  tilt, lift and x/z are not carried on that route. This is by design (it is
  the list's selection, after Cut / Split edits) and the suite asserts it, so a
  change to the contract is a visible test change. If a user ever needs a
  posed single piece, that is **Export plate** with one piece on it.
- `addModel()` re-centres every import, so file placement survives only in
  `rawTris`. Recorded, not gated.

**`npm run fixtures:audit`** (`tools/fixture_audit.py`; `--gate --no-selfint`
in `npm test`, ~1 s). Every `.stl` under `fixtures/` and `library/`, three
checks: FORMAT (binary: declared triangle count gives exactly the file length,
count > 0, body not printable text - the Contents-API placeholder signature;
ASCII: facets present, three vertices each), CANONICAL (`mesh_validate.py`'s
own `validate()`, imported), and EULER (a surface closed by edge count with an
ODD characteristic is a vertex pinch - the 40921 bowtie that
`stl_watertight_check.py` passed - reported as PINCH). Only FORMAT gates:
`fixtures/repair/` and `fixtures/open/` are defective on purpose. Run it bare
for the full table with self-intersection, or `--root <checkout>` against
another branch. `mesh_validate.py`'s binary reader stops quietly at the end of
a short file, which is why FORMAT is a separate check and not a flag on it.

First run, 2026-09-16, `main` at 1315fc2 (51 files) and `claude-wip` at
a228ab0 (67 files): 0 FORMAT failures on either. Odd Euler on exactly the
three pinch fixtures (`synth_pinch_2sheet_safe`, `_tight`, `40921`), all
documented. Files that fail the canonical verdict and are NOT documented as
intentional: `fixtures/out-box-square-half.stl` (1 degenerate triangle) and,
in both `fixtures/` and `library/`, `hinge_knuckle_box` (234 piercing pairs),
`hinge_knuckle_lid` (124), `hinge_pip` (330, Euler 12 - several
separate shells), `lid_strap` (25, Euler 4), plus `library/box_closed` (74, Euler 4).
Those are multi-body STLs whose shells overlap; a slicer unions them, so they
print, but they are shipped in `library/` as product files and any CSG route
(Join, Subtract) will meet the overlaps. Resolved later the same day: the four
hinge / strap pairs are now real boolean unions of their shells (0 piercing,
`tools/nso_fixture_union.mjs`, numbers in `fixtures/README.md`);
`library/box_closed` is left as is and documented as not CSG-safe in
`library/README.md`, because the sculpt self-test and `docs/SCULPT-TIER1.md`
measure against its two-shell layout. The `skin_*_block` samples read
piercing pairs because their gap is exactly 0 and the checker has no
"touching along an edge" class (same as the Seat-gap 0 case). The tape files
are the documented CSG_INTEGRATION case.

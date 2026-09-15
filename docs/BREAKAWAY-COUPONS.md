# Breakaway-support test coupons

`tools/breakaway_coupons.py` builds a plate of small two-part coupons for
validating breakaway supports on the printer, exports it as a print-ready
Bambu Studio project (`.3mf`) and writes a labelled mapping so every physical
result can be read back to its parameters. It stops at "print-ready plate +
mapping": nothing here predicts release behaviour, that only happens on the
printer.

```
python3 tools/breakaway_coupons.py                       # -> out/breakaway-coupons/
python3 tools/breakaway_coupons.py --stl-dir out/breakaway-coupons/stl
npm run coupons:plate                                    # regenerate the committed plate
npm run coupons:test                                     # tools/breakaway_test
```

The committed plate is `fixtures/breakaway-coupons/` (3MF + map JSON + map
TXT). It is a generated artifact; the test suite fails if it drifts from what
the generator produces.

## What a coupon is

Two objects that are **not merged**:

| object | stands on | plays | size |
| --- | --- | --- | --- |
| anchor | the bed | the support | 16 x 16 mm, joint at 6 / 9 / 12 mm |
| breakaway | the anchor's tip, floating at its joint Z | the part | 14 x 14 x 5 mm body |

They **coincide at the interface**: the breakaway's lowest face sits at
`anchor top - gap`, so the slicer sees two toolpaths that touch (or don't) by
exactly the swept value. Same two-object overlap technique as before: separate
objects in the 3MF, each independently watertight, positioned in plate
coordinates with identity build transforms. The breakaway is 2 mm narrower
than the anchor so the ledge gives pliers or a fingernail something to work
against.

Every object is a plain concatenation of closed shells that overlap
volumetrically (body + interface features sunk 0.2 mm into it), the
"deliberate volumetric overlap" construction the app and
`tools/csg_bench/make_fixtures.py` already use. There is no boolean engine.
A slicer unions the shells per layer; `tools/mesh_validate.py` reports the
overlap as piercing pairs, as it does for every NSO part built this way, and
that is expected.

## The physics encoded

Both mechanisms come from the physical prints and are implemented, not
re-derived.

**1. Weld cross-section minimised geometrically.**

| geometry | anchor tip | breakaway underside | nominal contact |
| --- | --- | --- | --- |
| `ring` | tapered ring, r 5 mm, wall 0.8 -> 0.4 mm, 1 mm tall | flat | 0.4 mm x 2 pi 4.6 mm = 11.6 mm^2 |
| `grid` | 4 ribs along X, 0.5 mm wide, 3 mm pitch, 1 mm tall | 4 ribs along Y, same size | crossings only: 16 x 0.5 x 0.5 = 4 mm^2 |

`grid` is the "near-zero footprint" family: the two rib sets only meet at
their crossings. Rib and tip widths are one extrusion line; do not make them
thinner or the slicer drops them.

**2. Weld thermal conditions denied by a pause at the joint transition**,
~20-25 s (default 22 s, `--pause-seconds`).

**Gap / overlap sweep**: `-0.20, -0.15, -0.10, -0.05, 0.00, +0.02` mm
(`--gaps`). Negative is an air gap between anchor top and breakaway bottom,
positive means the breakaway penetrates the tip. `-0.20` is the expected easy
release, `+0.02` the expected solid fuse, `-0.10` and `-0.05` the prior
reference points. The default plate is the full factorial: 2 geometries x 6
gaps x pause no/yes = 24 coupons, 48 objects, 6 columns x 4 rows, 26 mm pitch
(16 mm coupon + 10 mm clear), centred on a 256 x 256 plate (156 x 104 mm
overall, fits an A1 mini too).

## How the pause is encoded

Nothing in this pipeline expressed print pauses before this. Two mechanisms
existed to build on: the 3MF's own per-plate metadata parts (`nso-3mf.js`) and
per-object G-code post-processing (`tools/grispr`). The pause uses the first,
because Bambu Studio has a native per-layer pause and a real Bambu file in the
repo shows its exact format:

```
Metadata/custom_gcode_per_layer.xml         (fixtures/3mf/pa_pattern.3mf)
<custom_gcodes_per_layer><plate><plate_info id="1"/>
<layer top_z="9.2" type="1" extruder="1" color="" extra="...message..."/>
<mode value="SingleExtruder"/></plate></custom_gcodes_per_layer>
```

`type="1"` is Bambu's `PausePrint`: at the change to the layer whose print_z
is `top_z`, the slicer emits the printer profile's `machine_pause_gcode`
(`M400 U1` on every Bambu machine, also visible in that fixture); the printer
parks and waits for **Resume**. `extra` is the on-screen message, which names
the tier and the seconds to wait. This is `--pause-mode native`, the default,
and matches how a layer-slider pause behaves on the printer. Timing is by
hand.

`--pause-mode dwell` writes `type="4"` (Custom) instead, with the G-code in
`extra`: `M400`, retract, lift 5 mm, `G4 S<seconds>`, return, unretract. It
needs no operator, but the nozzle stays on the printer's own clock rather than
being parked, so it is the alternative, not the default.

**A layer pause is plate-wide.** Everything on the plate stops at that Z. The
generator therefore puts pause coupons on their own Z tier(s) so the pause
fires exactly at their joint transition and hits every other coupon inside a
solid body, several millimetres away from its joint:

| tier | joint Z | pause layer | who |
| --- | --- | --- | --- |
| N | 6.0 | none | all no-pause coupons |
| P1 | 9.0 | 9.2 | pause coupons whose first breakaway layer is joint + 0.2 (gaps -0.05, 0, +0.02) |
| P2 | 12.0 | 12.4 | pause coupons whose first breakaway layer is joint + 0.4 (gaps -0.20, -0.15, -0.10) |

Tiers are assigned automatically from the layer grid; the planner checks that
no pause lands in the `(joint, touchdown]` window of any coupon other than its
own and refuses to export otherwise (`check_pause_isolation`).

## Layer quantisation - read before trusting a sub-layer gap

A slicer extrudes whole layers on the plate's grid. The breakaway's first
layer is the first one whose slice plane (`print_z - h/2`) lies inside it. With
0.2 mm layers:

| gap | breakaway bottom (joint 6.0) | first breakaway layer | sliced gap |
| --- | --- | --- | --- |
| -0.20 | 6.20 | 6.4 | one empty layer, 0.2 |
| -0.15 | 6.15 | 6.4 | one empty layer, 0.2 |
| -0.10 | 6.10 | 6.4 or 6.2, **bottom face on the slice plane** | tie-break |
| -0.05 | 6.05 | 6.2 | none |
| 0.00 | 6.00 | 6.2 | none |
| +0.02 | 5.98 | 6.2 | none |

So at 0.2 mm the sweep collapses to two sliced outcomes plus one ambiguous
case. The map records `predicted_touchdown_layer_z_mm`,
`predicted_sliced_gap_mm` and `touchdown_ambiguous` per coupon so the physical
result is read against what was extruded, and `--layer-height` moves the
boundaries (tiers must stay on the grid: 6 / 9 / 12 mm are multiples of any
of 0.1, 0.15, 0.2, 0.3). This is a property of slicing, not of the coupons.

## Reading the plate

Row 1 is at the front of the plate (low Y), column 1 at the left (low X).
Rows are ring / grid / ring+pause / grid+pause, columns are the gap values.
Pause coupons are visibly taller (9 or 12 mm anchors against 6 mm).

Every half of every coupon carries notches so it stays identifiable off the
plate: **front edge (-Y) = column count, left edge (-X) = row count**
(1.0 mm wide, 0.8 mm deep, 1.8 mm pitch). Geometry is visible; the gap is not,
which is what the map is for.

`breakaway_coupon_map.txt` has the table, the plate map and the notes;
`breakaway_coupon_map.json` has everything, including per-object `verify()`
reports, volumes and bounding boxes. The same JSON is inside the 3MF as
`Metadata/nso_coupon_map.json`, next to where `nso_profile.json` lives in app
exports, so the plate stays self-describing.

## Printing it

1. **File > Open Project** in Bambu Studio. Do not "Import": that drops
   objects to the bed and discards the pause and settings.
2. Do not Arrange, move, or drop-to-bed. The breakaway objects float at their
   joint Z on purpose; check in the layer preview that the first breakaway
   layer of, say, C01 is at 6.4 and its anchor ends at 6.0.
3. Layer height 0.2 mm, first layer 0.2 mm, print sequence "by layer".
   `project_settings.config` carries these three (plain strings, the way
   Bambu writes print-level keys) on top of the 14 cooling keys from
   `nso-cooling-profiles.js` (`--cooling-profile`, `default` unless the
   `breakaway-support` slot gets tuned).
4. Slice, confirm the two pauses show on the layer slider at 9.2 and 12.4,
   print. At each pause, wait the number of seconds on the screen, resume.
5. Snap each breakaway off its anchor, note the result against `pos` /
   `cpn` / notches in the map.

## Validation

Before anything is written, every part and every whole object goes through
`meshlib.verify()`, which is the `tools/stl_watertight_check.py --odd --degen`
test (edge parity at 5 dp, zero-area triangles) plus directed-edge winding
consistency and a positive signed volume. Any failure lists every failing
object and nothing is exported. `--stl-dir` writes one binary STL per object
for the repo's own checkers; the test suite runs
`stl_watertight_check.py --odd --degen` on all 48.

`npm run coupons:test` (Python `unittest`, stdlib) pins: primitives closed
and outward-wound, the plan (24/48, coincidence per coupon, spacing,
tiers, pause isolation both holding and enforced, ambiguity flags), the
archive (parts, XML, Bambu attribute set on the pause entries, project
settings shapes, byte-identical on a second run), the STLs against the repo
checker, the embedded cooling defaults against the JS module (needs Node),
and the committed plate against a fresh run.

## Modules

| file | what |
| --- | --- |
| `tools/meshlib.py` | stdlib mesh library: `box`, `extrude_polygon` (ear clipping), `tapered_ring`, `cylinder`, `verify`, `signed_volume`, `write_binary_stl` |
| `tools/nso_3mf.py` | Python writer for the same 3MF layout as `nso-3mf.js`, plus `custom_gcode_per_layer.xml` and per-instance `identify_id` |
| `tools/breakaway_coupons.py` | the generator and CLI |
| `tools/breakaway_test/` | the tests |

`identify_id` is written per object (1000 + object index) so the sliced
G-code's `unique label id` markers can be checked against the map and driven
with `tools/grispr`. Whether Bambu keeps a supplied `identify_id` on load is
still unverified (grispr README, limitation 4); the object *names* in
`model_settings.config` are the reliable handle.

## Out of scope

No slicer-core work, no release-behaviour prediction, no numpy (there is none
in the sandbox and the repo's Python tooling is stdlib by policy).

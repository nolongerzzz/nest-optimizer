# Build volume — does the piece fit the machine?

`nso_printer.js` holds the per-printer profiles and the fit arithmetic;
`app-fit.js` asks it, continuously, about whatever is on the plate and puts
the answer under the Plate card. Both are wired into `index.html` at the
existing `?v=inside4` tag.

```
node tools/nso_printer_fit_test.js    the table, the arithmetic, and a real thrown piece
node tools/nso_wire_wheel_test.js     the real app: the warning appearing and clearing live
```

Both are in `npm test`.

## Scope, stated first because it is the whole design

This answers exactly one question:

> Will this bounding box physically fit inside that machine?

It is **not** a printability check. It does not know or care about bridging,
overhangs, wall thickness, severed connections, supports, adhesion or warping.
Those are separate, already-existing concerns with their own modules —
`nso_thickness.js` for the nozzle floor, `tools/mesh_validate.py` for the mesh
itself — and folding any of them in here would make a warning that says "too
big for your printer" start firing for reasons that have nothing to do with
size.

**A piece that fits and is unprintable produces no warning here. That is
correct.** The self-test asserts it structurally: strip the comments from
`nso_printer.js` and no code in it mentions bridging, overhangs, nozzles,
thickness, supports or adhesion, and it references no other NSO module at all.

## Why it is a general profile and not a feature of the wheel

Every tool that changes a piece's size has the same question, so the answer
lives in a module any of them can call rather than inside the one that
happened to need it first. `nso_printer.js` has no dependencies, loads under
Node and in the page, and takes a plain `{x, y, z}`.

The profiles are keyed to match `app-core.js`'s `PLATES` ids **one for one**,
so the plate selector the app already has resolves straight into a profile
with no mapping table in between. `PLATES` carries bed X/Y only; this adds the
build height, which is the axis the plate picker has never modelled — and the
axis a thrown vessel runs out of first.

| id | machine | bed X | bed Y | build Z |
|---|---|---|---|---|
| `a1mini` | Bambu A1 Mini | 180 | 180 | 180 |
| `a1` | Bambu A1 / P1S / X1C | 256 | 256 | 256 |
| `prusa` | Prusa MK4 / MK3S | 250 | 210 | **210** |
| `ender` | Creality Ender 3 | 220 | 220 | 250 |
| `custom` | whatever the Plate card says | — | — | — |

Where one id covers several real machines the build height is the **lowest**
of them. `prusa` is the case: the MK4 is 220 mm tall and the MK3S is 210, and
the id covers both, so 210 it is. A warning that fires slightly early on the
taller machine is a warning; one that stays silent on the shorter machine is a
failed print. The figures are manufacturer-published and transcribed, not
measured here; a modified gantry is a `custom` profile.

`custom` gained a build-height field (`#custom-h`) on the Plate card, and
`getCurrentPlate()` in `app-core.js` now returns `h` alongside `w` and `d`.

## The axis convention, once

Every size the module takes or returns is in **printer axes**: `x, y` the bed
footprint, `z` the build height, millimetres. That is the raw-soup convention
(Z up) and the one manufacturers quote, so a `rawTris` bbox needs no
conversion.

The app's **display** geometry is Y up — `zUpToYUp()` runs at import and every
rebuild goes back through it — so a display size goes through
`fromDisplaySize()` first. It is one line, and it is written down in one place
rather than at each call site, because a silently swapped height is exactly
the bug this module exists to catch. The self-test asserts the conversion
rather than commenting it.

## API

```js
NSO_Printer.PROFILES                  // the frozen table
NSO_Printer.ids()                     // ['a1mini', 'a1', ...]
NSO_Printer.get(id)                   // profile | null
NSO_Printer.resolve(id, over)         // profile, with custom's live w/d/h folded in
NSO_Printer.fromDisplaySize(size)     // Y-up -> Z-up
NSO_Printer.sizeOfRaw(rawTris)        // bbox size of a raw soup
NSO_Printer.fit(size, profile, opts)  // report
NSO_Printer.describe(report)          // one status line
```

```js
{
  kind: 'build-volume',
  printer, printer_name,
  bed_x_mm, bed_y_mm, build_z_mm, margin_mm,
  size: { x, y, z },
  fits,          // true when every axis is inside, as oriented
  over,          // [{ axis, size_mm, limit_mm, over_mm }], worst first
  worst_mm,      // the largest overhang, 0 when it fits
  rotatedFits,   // would a 90 deg turn about Z put the FOOTPRINT inside
  reason         // human-readable, always set
}
```

`opts.margin` defaults to **0**, because the question here is physical fit and
nothing else; a caller who wants a skirt allowance passes it, and it comes off
both sides of the bed and never off the build height, which has no rim.
`opts.epsilon` defaults to 1e-4 mm — the weld radius this repo uses everywhere
for "the same number" — so a piece exactly as wide as the bed fits.

## The 90 degree turn, and what is deliberately not offered

`rotatedFits` reports whether a quarter turn about Z would put the footprint
inside. That one is exact in a line, and it is worth reporting because it
turns "this does not fit" into "turn it".

An **arbitrary-angle** placement is out of scope and named as such. A
260 × 20 mm bar does fit diagonally on a 256 mm bed, and this module says it
does not fit. Placement is `packModels()`'s job in `app-core.js`, and a piece
that only fits on the diagonal deserves a human looking at it rather than a
silent pass.

## Why the live check is a poll

A piece's bounding box changes from a dozen places — Cut, Join, Soften,
Thicken, Smooth, Extend, an import, a Split, and the Pottery Wheel re-revolving
a form on every frame of a drag. Hooking all of them means every future tool
has to remember to call this, and the one that forgets is the one that ships a
piece that does not fit.

So `app-fit.js` runs one `requestAnimationFrame` loop over one cheap
**signature** — the plate id, the custom fields, and each model's three sizes
— and recomputes only when that signature changes. Reading a few dozen numbers
per frame costs nothing measurable; the fit arithmetic runs only on a real
change. The effect worth having is that a tool which changes a piece's size
gets the warning updated whether or not its author ever heard of this file.

It is also why this is not an export-time gate. By export time the decision
has been made. A potter pulling a vase up finds out on the pull that takes it
past 180 mm, not twenty minutes later — and the wire test asserts exactly
that: the warning appears mid-throw with nobody pressing Export, and clears
when the plate is switched to a 256 mm machine with the piece untouched.

If the watcher ever throws it stops polling and logs once, rather than filling
the console every frame. A warning that throws is worse than no warning.

## The real case it was built against

`tools/nso_printer_fit_test.js` section 5 throws a 320 mm floor vase on the
Pottery Wheel and raises it in stages, exactly as a potter would. Nothing in
it is a hand-made bounding box.

```
ball: 119.3 mm across, 119.3 mm tall  ->  Fits Bambu A1 Mini
stage 1:  90.3 mm tall, 100.0 mm across  ->  fits
stage 2: 120.3 mm tall, 100.0 mm across  ->  fits
stage 3: 150.3 mm tall, 100.0 mm across  ->  fits
stage 4: 180.3 mm tall, 100.0 mm across  ->  TOO BIG: Z 180.278 mm is 0.278 mm
                                             over the 180 mm limit
```

That the **ball** for the vase still fits is the point: the warning is about
the piece as it is now, not about the target being ambitious. The same piece
against an A1 / P1S / X1C fits, and against a custom 50 mm-tall machine does
not, so the warning is about the pairing.

Four things are asserted about the moment it fires, all against the piece
rather than against the report itself: the right axis (`z`, and no rotation
offered, because height cannot be rotated away), the height the piece actually
has, the machine's real build height, and the overhang as arithmetic. Then the
revolved solid is written out and put through the **canonical checker**, and
the checker's own bounding box is asserted to give the same verdict to within
the float32 the STL is stored in. That last line is what caught the profile /
mesh disagreement now prevented by `NSO_wheelTidy` — see finding 6 in
`docs/POTTERY-WHEEL.md`.

The wide case is checked too: a bowl spread out to 217 mm across is caught on
**both** bed axes, by exactly the same amount on each because a solid of
revolution is as wide as it is deep — and `rotatedFits` is false, because
turning a circle does not help.

## Out of scope, named

1. **Arbitrary-angle placement.** See above.
2. **Where on the bed a piece sits.** This checks a size against a volume, not
   a position against a plate. Overlap, gaps and packing are `packModels()`.
3. **Excluded zones.** Purge towers, wipe areas, clip heights and the A1's
   limited head clearance near the front edge are real and are not modelled:
   the profile is a plain box.
4. **Multi-piece totals.** Every piece is checked on its own. A plate whose
   pieces do not *collectively* fit is a packing failure, which the packer
   already reports.

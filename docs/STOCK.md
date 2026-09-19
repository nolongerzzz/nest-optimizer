# New stock — a correctly-sized blank to start from

`nso_stock.js` (headless, THREE-free, node-testable) plus `app-stock.js` (the
app layer: read the controls, resolve the machine, add the piece). Wired into
`index.html` at a new `?v=stock1` tag — the module ahead of `app-wheel.js`,
which now calls it, and the app layer after `app-fit.js`, whose
`NSO_fitCurrentPrinter()` it uses.

```
node tools/nso_stock_test.js             headless: the extraction, the three shapes, the gates
node tools/nso_stock_canonical_check.js  canonical checker over every generated piece
node tools/nso_wire_stock_test.js        the real app, real clicks, real refusals
```

All three are in `npm test`.

## What it is

One step before Carve, Hollow, auto-aim support, Cut, Skin, or anything else
that starts from a blank block: put a blank on the plate that is actually the
right size for the piece you mean to make.

| you say | it works out |
|---|---|
| the target's **height** (and radius, and wall) | how much material that piece needs — Pappus's centroid theorem on a thin shell |
| a **waste margin** | how much more than that to start with |
| a **shape** — sphere, box or cylinder | the one measurement that shape needs to hold exactly that much |
| the **plate** you are pointed at | whether any of it can physically be printed, *before* anything is generated |

## Where it came from

The Pottery Wheel's first move is **Ball**: size a sphere of clay from the
target vessel by Pappus's theorem, add 30% for throwing waste, hand back a
sphere of exactly that volume. The arithmetic in that move was never about
spheres. It is:

```
target dimensions -> estimated shell / material volume -> + waste margin
                  -> solve for the primitive's defining measurement
```

and only the last arrow knows what shape is being made. The first two arrows
are now `NSO_Stock.shell()` and `NSO_Stock.size()`, shape-agnostic;
`NSO_wheelSizeBall` is one call into them with `shape: 'sphere'` and carries no
copy of the arithmetic. The `3.0 mm` wall, the `0.30` waste and the `0.5`
aspect are stated once, in `NSO_Stock.DEFAULTS`, instead of once per file.

**The Pottery Wheel is unchanged, and that is asserted rather than asserted in
prose.** `tools/nso_stock_test.js` §1 pins Ball against the figures
`docs/POTTERY-WHEEL.md` published *before* the move — 23.292 mm at 30%,
21.341 mm at 0%, 12,215 mm³ of headroom between them, a budget opening at
52915.383 mm³ against a true sphere of 52929.553 — and compares its status
line character for character:

```
target 60.0 x 60.0 mm, 3.00 mm wall: shell 40715.0 mm^3, +30% waste = 52929.6 mm^3, ball radius 23.292 mm
```

Both of the wheel's refusals keep their own words too, including the one that
says "nothing **thrown** at that wall could be printed" — a general module has
no business calling everything thrown, and the wheel has every business saying
it, so the verb is a parameter (`opts.what`). `tools/nso_wheel_test.js` and
`tools/nso_printer_fit_test.js` still pass unchanged, at the same assertion
counts they passed at before, and `tools/nso_wire_stock_test.js` §8 throws a
ball in the real app on the same page as a generated blank.

## Pappus, and what it does and does not estimate

The target is approximated as a **thin shell**: a wall of thickness `t` swept
along the meridian, plus a floor of the same thickness.

- wall strip: `A = H·t`, `ρ = R − t/2` → `V = 2π(R − t/2)(H·t)`
- floor rectangle, `r ∈ [0, R]`, `z ∈ [0, t]`: `ρ = R/2`, `A = R·t` →
  `V = 2π(R/2)(R·t) = πR²t`, which is the disc it should be

One theorem, both parts. The target is described as a height and a radius
*whatever shape the stock is*, because that is what the estimate takes; its
bounding box is therefore `2R × 2R × H`, and that is the box the build-volume
gate checks.

## Solving for the defining measurement

With `need` mm³ of stock to make:

| shape | closed form | defining measurement |
|---|---|---|
| sphere | `need = 4/3 π a³` | `a = ∛(3·need / 4π)` |
| box | sides in proportion `x:y:z`, scale `s`; `need = s³·x·y·z` | `s = ∛(need / xyz)` |
| cylinder | ratio `k = h/2r`, so `h = 2kr`; `need = 2πk r³` | `r = ∛(need / 2πk)` |

All three are exact: the primitive's analytic volume **is** `need`, to the last
bit the cube root allows, asserted per shape rather than trusted to the algebra.

**The second measurement, for the two shapes that have one**, comes from one of
three places, in order:

1. **explicit** — `proportions: {x, y, z}` for a box, `ratio` for a cylinder;
2. **a reference piece** — `like: rawTris`, read through
   `NSO_extendDetectAxis` (see finding 4);
3. **the target's own bounding box** — `2R × 2R × H` for a box, `H / 2R` for a
   cylinder. A default that needs no inventing, because it is the thing being
   aimed at rather than a number picked to look reasonable.

## The waste margin is a parameter

`opts.waste` is a fraction, default `0.30`, and `0` is legal. What it *means*
depends on what the stock is for — throwing waste on a wheel, the skin a carve
takes off, the allowance a support strut wants — which is why it is an argument
and not a constant. Measured on a 60 mm target:

| waste | material | sphere radius |
|---|---|---|
| 0% | 40715.0 mm³ | 21.3414 mm |
| 10% | 44786.5 mm³ | 22.0303 mm |
| 30% (default) | 52929.6 mm³ | 23.2918 mm |
| 50% | 61072.6 mm³ | 24.4298 mm |
| 100% | 81430.1 mm³ | 26.8884 mm |

`0.30` appears exactly once in the module's code, in `DEFAULTS`, and the
self-test counts the occurrences so a second copy cannot creep back.

## The build volume is checked at generation time

Not at export, and not by a watcher that notices afterwards. **Two boxes** go
to `nso_printer.js` before any geometry is built, and the distinction between
them is the point:

| box | over the machine means |
|---|---|
| the **target**, `2R × 2R × H` | a hard refusal. No waste setting, no shape and no later edit makes a piece that cannot physically exist. |
| the **stock block**, the primitive's own bbox | a refusal too, downgraded to a warning by `opts.warnOnly` — a block somebody means to split with `Cut` is a legitimate thing to want, and the refusal says so rather than just saying no. |

```
New stock refused - nothing added: that target cannot be printed on Bambu A1 Mini
at all - Z 260 mm is 80 mm over the 180 mm limit. The stock would be radius
23.496 mm x 152.727 mm tall (ratio 3.250, the target's own height over
diameter), but the finished 260.0 x 80.0 mm piece does not fit the machine.
Pick a smaller target, or a bigger plate.
```

Refusing before generating is what makes it a gate: a block that cannot be
printed never becomes a piece the user then has to delete.
`tools/nso_wire_stock_test.js` §6 drives it through the real Plate card —
refused on the A1 Mini, accepted on a 400 mm custom machine, refused again when
the custom height drops to 50, with the target never touched and nothing added
on any of the refusals.

**No printer is no guess.** Without one, `fit` is `null`,
`checked_build_volume` is `false` and a named warning says so. A build-volume
check against the wrong machine reads as a pass, which is worse than no check.

## The wall floor is not this file's to invent

`NSO_Thickness.floorFor(nozzle)` is the only place the nozzle-safety floor
comes from. `nso_stock.js` carries no `0.42`, no `nozzle * 1.05` and no default
to fall back on: loaded without `nso_thickness.js` it **throws** on the first
sizing, and that is asserted by loading it into a bare context, not asserted in
prose. The Pottery Wheel now has the same contract twice over — without
`nso_stock.js` it refuses by name rather than growing a second copy of the
Pappus arithmetic.

## API

```
NSO_Stock.SHAPES                          ['sphere', 'box', 'cylinder']
NSO_Stock.DEFAULTS                        wall 3.0, waste 0.30, aspect 0.5, segments 96, profileN 96
NSO_Stock.floor(nozzle)                   -> mm, via NSO_Thickness.floorFor
NSO_Stock.shell(opts)                     -> the Pappus thin-shell estimate alone
NSO_Stock.size(opts)                      -> the full sizing report, no geometry
NSO_Stock.make(opts)                      -> { ok, reason, soup, sizing, fit, warnings }
NSO_Stock.proportionsFrom(rawTris, opts)  -> proportions off a reference piece
NSO_Stock.revolve(loop, segments, opts)   -> a closed meridian loop, revolved
NSO_Stock.profileSphere(a, n)             -> the sphere meridian
NSO_Stock.profileCylinder(r, h)           -> the cylinder meridian
NSO_Stock.boxSoup(sx, sy, sz, opts)       -> twelve triangles, centred, on z = 0
```

`size()` reports, besides the sizing: `measure` and `measure_text` (the shape's
own defining measurement), `size` (the bbox the gate ruled on), `volume` (what
was asked for), `built_volume` and `polygon_factor` (what is actually there —
see finding 1), `encloses_target`, `fit`, `target_fit`, `checked_build_volume`
and `warnings`.

## Findings

### 1. Two deficits, not one, and only one of them is a sphere's

A revolve at `n` segments inscribes an n-gon in every circle, and every term of
a solid-of-revolution volume integral is an `r²` term, so the mesh holds
`n·sin(2π/n)/(2π)` of the solid — `0.999286…` at n = 96. That is
`polygon_factor`, and a box's is exactly `1`: six flat faces **are** the solid.

A sphere has a second, independent deficit. Its *meridian* is also an n-gon,
inscribed in a semicircle, so the solid as built is under the sphere that was
asked for by a further **0.0268%** at n = 96. A cylinder's meridian is four
straight segments and a box's is not a meridian at all, so for those two the
as-built figure *is* the analytic one.

| shape | analytic = `need` | as built | polygon factor |
|---|---|---|---|
| sphere | 52929.553 mm³ | 52915.383 mm³ (0.0268% under) | 0.999286 |
| cylinder | 52929.553 mm³ | 52929.553 mm³ (exact) | 0.999286 |
| box | 52929.553 mm³ | 52929.553 mm³ (exact) | 1 |

Keeping them apart matters because the mesh holds `built_volume ×
polygon_factor` and nothing else — to 1e-12 relative in float64, with float32
STL storage the entire residual after that. Rolling them into one number would
hide a real tessellation bug inside a fudge. It is also exactly the
distinction the Pottery Wheel already draws when it opens its material budget
at the ball **as built**: `sizing.built_volume` for a 60 mm sphere is
bit-for-bit the number `NSO_wheelVolume` returns.

`tools/nso_stock_canonical_check.js` gates `signed_volume` against
`built_volume × polygon_factor` at 1e-6 relative, and names the slack as
float32 STL storage rather than leaving it a round number.

### 2. One tessellator, and the proof is bit-identity

`NSO_Stock.revolve` is not "modelled on" the Pottery Wheel's revolve — it **is**
the wheel's revolve, moved. `NSO_wheelRevolve` now builds its meridian (up the
outside, across the rim, down the inside) and hands that loop over; the band
rule, the winding and the axis cases live in one place.

So a stock sphere and a wheel ball at the same target are not merely the same
size. At 30, 60 and 120 mm targets they are **the same 164,160 float32 values**,
compared one by one. A second tessellator that "agrees to 1e-9" is a second
tessellator; this one cannot drift because there is only one.

### 3. A box-shaped target is UNDER-estimated by about 19%, and that is the unsafe direction

The estimate is a solid of revolution's wall plus floor, whatever the stock is.
A target that is genuinely a box with six walls has perimeter `8R` where the
inscribed circle has `2πR ≈ 6.28R`, so this estimate comes out short. Measured
against an open-topped box vessel of the same bounding box, computed
independently:

| target | estimated | really needed | under by | block at 30% |
|---|---|---|---|---|
| 40 × 40, 2 mm wall | 12064 | 14752 | 18.2% | 15683 |
| 60 × 60, 3 mm wall | 40715 | 49788 | 18.2% | 52930 |
| 60 × 40, 3 mm wall | 24693 | 30108 | 18.0% | 32101 |
| 100 × 50, 3 mm wall | 50187 | 62208 | 19.3% | 65243 |
| 140 × 140, 4 mm wall | 300839 | 374336 | 19.6% | 391091 |

The default 30% margin covers it on every target measured — but that is the
margin doing a job it was not sized for, and it is stated here rather than
relied on quietly. A caller aiming at a genuinely box-shaped target should
raise the margin. A box shell estimate is one more closed form and a `target`
option to pick it; it is out of scope 4, not a defect.

### 4. Extend's "no single dominant axis" is Extend's question, not this one

`opts.like` reads a reference piece's proportions through
`NSO_extendDetectAxis` (`app-extend.js`) rather than off a bounding box, and
that is load-bearing: the detector is what decides whether the reference *has*
a shape worth copying. A curved fixture and an organic blob are both refused,
in Extend's own words, because their bounding boxes mean nothing:

```
no proportions to read off that piece - no dominant straight axis - best is x
with 100.0% of surface area oblique (limit 50%); this piece is curved or
tapered on every axis
```

One of Extend's refusals is **not** a refusal here. `ambiguous` — two or three
axes equally straight and within `tieFrac` of the same length — means Extend
cannot tell which axis to *lengthen*. A cube's proportions are `1 : 1 : 1` and
reading them off is exactly right, so the ambiguous case is taken, with the
longest of the tied axes standing in as the dominant one. Measured:

| reference | read as | ratio |
|---|---|---|
| `box_hull_80x40x20-2.stl` | 80 : 40 : 20, dominant axis x | 2.000 |
| `box-20mm.stl` (a cube) | 20 : 20 : 20, no one axis dominant | 1.000 |
| `pin.stl` | 20 : 3 : 3, dominant axis x | 6.667 |
| `fixture_sphere_curved.stl` | refused | — |
| `fixture_blob_organic.stl` | refused | — |

The reference's **own orientation is kept**. Standing a long axis up is a pose
decision, the app has pose buttons that own it, and quietly rotating somebody's
stock would be a surprise the next tool pays for. And without `app-extend.js`
loaded the match refuses by name rather than growing a second axis detector —
the same contract rim extension has on the wheel.

### 5. The stock does not necessarily enclose the target, and it says so

A sphere sized for a 60 mm vessel is **46.58 mm across**. That is right for
clay a potter pulls up and wrong for a block a carve has to fit inside, and
which of those a caller is doing is not something the module knows. So
`encloses_target` is **reported, never decided**, and the status line says it
in words when the block does not:

```
note: this block does NOT enclose the 60 x 60 mm target, so it is material for
it, not a block to carve it out of
```

A big enough margin does enclose it, and that is reported the same way. The
canonical checker cross-checks the claim against the bounding box it measured
off the mesh, so a block cannot claim to enclose a target it does not.

### 6. Three shapes, one material figure — visible on the plate

The claim of the whole extraction, measured end to end in the real app: a
sphere, a box and a cylinder generated for the same 60 mm target come off the
plate holding **52877.6 / 52929.6 / 52891.8 mm³** — a 0.098% spread, which is
entirely their own tessellation deficits from finding 1 and is exactly zero in
the profile.

## PAINT SCOPE: NONE

Per the scoping rule in `docs/HANDOFF.md`: the question is whether the feature
acts on an identifiable sub-region of a piece. It acts on **no piece at all** —
it adds one. Nothing is replaced, no geometry is read except a reference
piece's bounding box when `Match` is ticked, and no face of any piece is
written to. That is a stronger statement than "paint is respected", and it is
the same category `app-skin-patch.js` is in: `none`, which is why neither file
is in `tools/nso_paint_scope_test.js`'s roster — that roster is the
paint-**aware** features, and a row in it needs a paint test to assert.

## The UI

Its own viewport menu — **Stock**, third in the top-right stack beside Finish
and Wheel — and deliberately not a fifth button on the Pottery Wheel's card.
The wheel's Ball starts a wheel *session* and bakes a vessel onto the
selection; this puts a block on the plate. Different acts, different menus.

The card is the shape selector, `H` / `R`, `W` / `%`, one shape-specific box
whose label follows the selector (`x:y:z` for a box, `h/d` for a cylinder,
hidden for a sphere), `N`, two checkboxes and the button. Adding the third menu
was a `--vp-menu-count` bump in `styles.css` and nothing else — the offsets
were already derived from `--vp-menu-gap` and `--vp-menu-w` for exactly this,
and `npm run overlay:test` measures the rendered strip and fails if a topbar
button ends up underneath one.

The new piece arrives through `addModelFromZUpGeometry` (`app-core.js`), the
one ingest path an imported STL takes, so it has `rawTris` exactly as a loaded
file does and every later tool sees an ordinary piece. It comes off the plate
the way an import does — **Delete model**, which pushes its own undo entry —
not through a bake-style `stockReplace` step, because nothing was replaced.

## Out of scope for this first version, named

1. **Cones, tubes and rounded blocks.** Three shapes, each with one closed form
   and one tessellation, is the whole of this version. A cone is two lines in
   `profileCylinder`'s place and a tube is three; neither is here, because
   neither has been asked for and an unused shape is an untested shape. The
   revolve underneath takes any `r`-as-a-function-of-`z` meridian, so adding
   one is a profile and a closed form, not a new mechanism.
2. **Placing the stock.** Everything is generated centred on the axis and
   resting on z = 0. Where it goes on the plate is the packer's business
   (`packModels` in `app-core.js`), and a piece that only fits the machine on
   the diagonal is `nso_printer.js`'s stated non-answer.
3. **Sizing from a target mesh.** `proportionsFrom()` reads a reference piece's
   *proportions*, never its volume. "Make me stock big enough to carve this
   exact model out of" needs the model's own bounding box and a decision about
   stock allowance per face — a real ticket, and not this one.
4. **A shell estimate for a non-revolved target.** See finding 3.

# New stock — a correctly-sized blank to start from

`nso_stock.js` (headless, THREE-free, node-testable) plus `app-stock.js` (the
app layer: read the controls, resolve the machine, add the piece). Wired into
`index.html` at a new `?v=stock1` tag — the module ahead of `app-wheel.js`,
which now calls it, and the app layer after `app-fit.js`, whose
`NSO_fitCurrentPrinter()` it uses.

```
node tools/nso_stock_test.js             headless: the extraction, the eight shapes, the gates
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
| a **shape** — one of eight | the one measurement that shape needs to hold exactly that much |
| the **plate** you are pointed at | whether any of it can physically be printed, *before* anything is generated |

The eight shapes are **sphere, box, cylinder, cone, tube, torus, capsule and
ellipsoid**. Only the last arrow differs between them; the estimate, the
margin and the plate gate are one piece of arithmetic that does not know what
shape it is for. Which shapes are *eligible* to be on that list, and which are
deferred and why, is audited in "Which shapes are cheap" below.

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
| cone | `k` as above, taper `t = rTop/r ∈ [0,1)`; `need = (2πk/3)(1+t+t²) r³` | `r = ∛(3·need / 2πk(1+t+t²))` |
| tube | `k` as above, wall fraction `w ∈ (0,1)` of the outer radius; `need = 2πk(1−(1−w)²) r³` | `r = ∛(need / 2πk(1−(1−w)²))` |
| torus | tube ratio `q = a/R ∈ (0,1)`; `need = 2π²R a² = 2π²q² R³` | `R = ∛(need / 2π²q²)` |
| capsule | `k = H/2r`, strictly `> 1`; barrel `2r(k−1)` plus two caps; `need = 2π(k − ⅓) r³` | `r = ∛(need / 2π(k − ⅓))` |
| ellipsoid | `k` as above, semi-axes `r, r, c` with `c = kr`; `need = 4/3 πk r³` | `r = ∛(3·need / 4πk)` |

**Every one is exact**: the primitive's analytic volume **is** `need`, to the
last bit the cube root allows, asserted per shape rather than trusted to the
algebra. That exactness is the entry fee — see "Which shapes are cheap".

### Where the second measurement comes from

Five shapes take a **height over a diameter**, and all five read it the same
way, through one `ratioFor()`:

1. **explicit** — `ratio`;
2. **a reference piece** — `like: rawTris`, read through
   `NSO_extendDetectAxis` (see finding 4);
3. **the target's own** — `H / 2R`. A default that needs no inventing, because
   it is the thing being aimed at rather than a number picked to look
   reasonable.

A **box**'s second measurement is three numbers rather than one and keeps its
own copy of that order, ending at the target's own bounding box `2R × 2R × H`.

Three second measurements are **not** a height over a diameter and take a
stated default rather than the target's proportions, because the target has
nothing to say about them:

| option | shape | default | why not the target's |
|---|---|---|---|
| `taper` | cone | `0` — a true point | the target has a height and a radius, not a draft angle |
| `tubeWall` | tube | `0.25` of the outer radius | likewise: the target's own wall is the *finished piece's*, not the blank's |
| `tubeRatio` | torus | `0.35` | **a torus is never as tall as it is wide** — `h/d = q/(1+q) < 1` for every legal `q` — so there is no `H/2R` to read, at any size |

A **capsule** is where the two rules meet. It cannot be as short as it is wide
either (at `h/d = 1` it *is* a sphere), so it takes the target's own ratio only
when the target is taller than it is wide, and `DEFAULTS.capsuleRatio = 2` when
it is not — saying which in `ratio_from` either way. An explicitly asked-for
ratio at or under 1 is **refused** rather than rounded up: that is somebody
asking for something the shape cannot be.

### Where a range ends is another shape, and is refused as one

`taper = 1` is a cylinder. `tubeWall = 1` is a cylinder. `tubeRatio = 1` is a
torus whose hole has closed up. `capsule` at `ratio = 1` is a sphere. All four
are refused by name, because a second entry that makes the same solid as an
existing one is two definitions that drift apart the moment either is edited.

`ellipsoid` at `ratio = 1` is the exception and is **allowed**: a sphere is the
*middle* of that continuous family rather than a second name at the end of it,
and refusing the middle of a range is the worse surprise. It really is the same
mesh — `profileSphere` delegates to `profileEllipsoid`, and the self-test
compares the two soups float for float rather than taking it on trust.

## Which shapes are cheap

The audit this list came out of. The question asked of each candidate was not
"would this be nice to have" but two narrower ones, both of which have to be
yes:

1. **Does its volume solve *exactly* for one defining measurement?** Not
   "can its volume be computed" — every shape here can — but: given `need`
   mm³, is there a closed form for the measurement that makes the volume come
   out at exactly that? For everything on the list, the answer is a cube root.
2. **Is its surface one `r`-as-a-function-of-`z` meridian?** If so, the
   `revolve` that has been here since the Pottery Wheel already builds it, and
   the addition is a profile and a formula rather than a mechanism.

A shape that fails either one is deferred. Approximating the first would put a
block on the plate that quietly holds the wrong amount of material, which is
the whole thing this module exists not to do.

### Built — cheap on both counts

| shape | solves for | tessellation | notes |
|---|---|---|---|
| **cone** | cube root, and a truncated cone (a frustum) for free — the `(1+t+t²)` term is exactly 1 at `t = 0` | 4-point meridian | a true point's apex band is two coincident profile points, which the revolve already drops as degenerate |
| **tube** | cube root | 5-point meridian | the first profile here whose loop never touches the axis, so it writes its closing segment down instead of leaving the revolve to infer one |
| **torus** | cube root — Pappus again, this time on the primitive rather than the target | sampled circle | genus 1 |
| **capsule** | cube root | two half-meridians and a barrel | `k > 1` strictly |
| **ellipsoid** | cube root | sampled half-ellipse | `profileSphere` is its `c = r` case and delegates to it |

Measured, at a 60 mm target needing **52929.553 mm³** at the default 30% margin:

| shape | what you get | as built | tris | genus |
|---|---|---|---|---|
| `sphere` | radius 23.292 mm | 52915.383 (0.0268% under) | 18240 | 0 |
| `box` | 37.546 × 37.546 × 37.546 mm | 52929.553 (exact) | 12 | 0 |
| `cylinder` | radius 20.347 × 40.695 mm tall | 52929.553 (exact) | 384 | 0 |
| `cone` | base radius 29.346 × 58.692 mm tall | 52929.553 (exact) | 192 | 0 |
| `tube` | outer radius 26.803, bore 20.102, 53.606 mm tall | 52929.553 (exact) | 768 | **1** |
| `torus` | ring radius 27.973, tube radius 9.791, 75.528 mm across | 52891.772 (0.0714% under) | 18432 | **1** |
| `capsule` | radius 17.162 × 68.646 mm tall | 52923.885 (0.0107% under) | 18432 | 0 |
| `ellipsoid` | radius 23.292 × 46.584 mm tall | 52915.383 (0.0268% under) | 18240 | 0 |

The "as built" column is finding 1's second deficit and nothing else: a
straight meridian is exact, a curved one is an inscribed polygon and comes out
under. **The torus is under by exactly the polygon factor**, `0.999286206`,
which is not a coincidence — Pappus on a regular n-gon inscribed in the tube
circle puts its centroid at the circle's own centre, so the as-built torus is
`n·sin(2π/n)/(2π)` of the true one, the same expression as the cross-section's
evaluated at `profileN` instead of at `segments`. The self-test asserts that
identity rather than the measured number.

**Genus is a property of the shape, not a tolerance.** A tube and a torus have
a hole through them, so their Euler characteristic is 0 and not 2. The
canonical checker carries a per-shape `GENUS` table and asserts `2 − 2g`, so a
sphere that came out with a handle in it still fails.

### Deferred — and which of the two questions each one fails

| candidate | exact closed form? | one meridian? | verdict |
|---|---|---|---|
| **rounded block** (box ⊕ sphere) | volume is closed-form — `lwh + 2r(lw+lh+wh) + πr²(l+w+h) + 4/3 πr³` — but solving it for a *scale* with a **fixed** fillet radius is a general cubic, not a cube root | no — needs a real fillet mesher | **deferred, both counts** |
| **superellipsoid** | needs the Beta function. A closed form only if a special function counts as one; it does not here | yes, in principle | deferred |
| **swept / helical** (coil, screw, spring) | *conditionally* — a constant section swept along a polyline holds `A × centreline length` exactly, and the mitre wedges cancel, **while the sweep does not overlap itself or fold a mitre inside out**. A coil at a tight pitch does both, and then it needs real numerical estimation | no — that is `NSO_PathSweep`'s job, a different tessellator, and the path is three more inputs (radius, pitch, turns) before there is one defining measurement to solve for | deferred |
| **lattice / gyroid block** | **no** — no closed form at all; the volume fraction is *measured*, not solved | no | **deferred, both counts** |
| **Platonic solid, n-gon prism, pyramid** | **yes** — each is `c·a³` for a known `c` | no — each needs its own vertex table | deferred on tessellation alone. A prism is also very nearly `cylinder` at a low segment count, which is a reason to want it spelled that way rather than added twice |
| **stock shaped like a reference *mesh*** | not a primitive at all | n/a | out of scope 3, unchanged |

**The ones that would need genuine numerical estimation** are the lattice
block outright, and the sweep the moment its condition fails — Monte-Carlo or
voxel integration of the patterned or self-overlapping volume, then a solve by
iteration rather than by formula. That is a real ticket with a real tolerance
to argue about, and it is deliberately not folded in here as a cube root with a
fudge on it. The rounded block is the third kind: its volume is exact and its
*solve* is the problem, a general cubic rather than a cube root.

Nothing deferred is half-built: none of these names generates anything, and
asking for one by name gets the ordinary unknown-shape refusal, which the
self-test checks for each of them individually.

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
NSO_Stock.SHAPES                          sphere, box, cylinder, cone, tube,
                                          torus, capsule, ellipsoid
NSO_Stock.DEFAULTS                        wall 3.0, waste 0.30, aspect 0.5,
                                          segments 96, profileN 96, taper 0,
                                          tubeWall 0.25, torusTube 0.35,
                                          capsuleRatio 2
NSO_Stock.floor(nozzle)                   -> mm, via NSO_Thickness.floorFor
NSO_Stock.shell(opts)                     -> the Pappus thin-shell estimate alone
NSO_Stock.size(opts)                      -> the full sizing report, no geometry
NSO_Stock.make(opts)                      -> { ok, reason, soup, sizing, fit, warnings }
NSO_Stock.proportionsFrom(rawTris, opts)  -> proportions off a reference piece
NSO_Stock.revolve(loop, segments, opts)   -> a closed meridian loop, revolved
NSO_Stock.polygonFactor(segments)         -> n*sin(2pi/n)/(2pi)
NSO_Stock.profileSphere(a, n)             -> the sphere meridian
NSO_Stock.profileCylinder(r, h)           -> the cylinder meridian
NSO_Stock.profileCone(r, h, rTop)         -> the cone / frustum meridian
NSO_Stock.profileTube(rOut, rIn, h)       -> the tube meridian, closed off the axis
NSO_Stock.profileTorus(R, a, n)           -> the torus meridian, closed off the axis
NSO_Stock.profileCapsule(r, h, n)         -> the capsule meridian
NSO_Stock.profileEllipsoid(r, c, n)       -> the spheroid meridian
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

A **curved meridian** has a second, independent deficit. It is also an n-gon,
inscribed in the curve, so the solid as built is under the one that was asked
for by a further amount — 0.0268% for a sphere or an ellipsoid at n = 96,
0.0107% for a capsule (half its meridian is straight), and for a torus exactly
the polygon factor again. A **straight** meridian is exact, so the cylinder,
the cone and the tube — and the box, which is not a meridian at all — have no
second deficit.

| shape | analytic = `need` | as built | polygon factor |
|---|---|---|---|
| sphere | 52929.553 mm³ | 52915.383 mm³ (0.0268% under) | 0.999286 |
| ellipsoid | 52929.553 mm³ | 52915.383 mm³ (0.0268% under) | 0.999286 |
| capsule | 52929.553 mm³ | 52923.885 mm³ (0.0107% under — half its meridian is straight) | 0.999286 |
| torus | 52929.553 mm³ | 52891.772 mm³ (0.0714% under — exactly the polygon factor again) | 0.999286 |
| cylinder | 52929.553 mm³ | 52929.553 mm³ (exact) | 0.999286 |
| cone | 52929.553 mm³ | 52929.553 mm³ (exact) | 0.999286 |
| tube | 52929.553 mm³ | 52929.553 mm³ (exact) | 0.999286 |
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

### 6. Eight shapes, one material figure — visible on the plate

The claim of the whole extraction, measured end to end in the real app: a
sphere, a box and a cylinder generated for the same 60 mm target come off the
plate holding **52877.6 / 52929.6 / 52891.8 mm³** — a 0.098% spread, which is
entirely their own tessellation deficits from finding 1 and is exactly zero in
the profile. The five shapes added since land in the same band, for the same
reason and by the same arithmetic: the spread across all eight is their
`built_volume × polygon_factor` and nothing else.

## PAINT SCOPE: NONE for the create path, WHOLE-PIECE for the update path

Two paths, two answers to the same question, both written down. This section
is the **create** path — the New stock button. The live update is
**whole-piece**, for the reason given in "The session ends rather than
overwriting somebody else's work" above: an adjustment re-generates the whole
block, so there is no face it can hold still, and any paint anywhere stands it
down naming the count. Both rows are in the HANDOFF roster.

Per the scoping rule in `docs/HANDOFF.md`: the question is whether the feature
acts on an identifiable sub-region of a piece. The create path acts on **no
piece at all** — it adds one. Nothing is replaced, no geometry is read except a reference
piece's bounding box when `Match` is ticked, and no face of any piece is
written to. That is a stronger statement than "paint is respected", and it is
the same category `app-skin-patch.js` is in: `none`, which is why neither file
is in `tools/nso_paint_scope_test.js`'s roster — that roster is the
paint-**aware** features, and a row in it needs a paint test to assert.

## Live editing — the card adjusts the piece it made

`npm run stock:live` (`tools/nso_stock_live_test.js`), in `npm test`.

**New stock ADDS.** That is right the first time and wrong every time after.
Measured on the shipped behaviour before this change: press it, then press it
again with a different waste margin, and you have **two** blocks — two models,
two meshes, the second placed 31.96 mm to the side — with your positioning,
your pose and your selection all still on the first. Changing a card field on
its own did nothing at all, so "try 50% instead of 30%" meant pressing the
button again and then deleting the old block.

So the button now opens a **session** on the piece it made, and every control
on the card edits that piece in place. This is the Pottery Wheel's pattern,
deliberately and not by coincidence:

| | the wheel | here |
|---|---|---|
| what is held | `NSO_wheelSession` — the profile | `session` — the model id and a fingerprint of the soup this file last wrote |
| what a move does | derives a new profile, revolves it | re-sizes from the card |
| how it lands | `NSO_sculptCommitRaw` onto the same model | the same call, onto the same model |

### What survives an adjustment, and what does not

Everything below is asserted in the drive check, on the ticket's own scenario:
place a block, move it to (40, −25), yaw it 90° and tilt it one step, then
change the waste margin from 0% to 50%.

| | |
|---|---|
| the model id, and its index in the model list | **survives** |
| the placed entry and its index | **survives** |
| its x / z on the plate | **survives** — 40, −25 |
| its pose fields — `rotY`, `tipX`, `tiltX`, `flipX` | **survives** |
| the selection, both halves of it | **survives** |
| the block's size | changes, which is the point — 26.070 → 29.843 mm |
| the number of pieces on the plate | **1, before and after** |
| the `THREE.Mesh` instance | **rebuilt** |

That last row is stated rather than hidden. `NSO_sculptCommitRaw` disposes and
rebuilds the mesh, for Stock exactly as it does for Smooth, Extend, Fatten,
Hollow and the wheel. **"The same object" here means the same PIECE, not the
same Mesh**; keeping the Mesh itself would be a change to every bake in the
app and is not this ticket. The drive check asserts the uuid *changes*, so
nobody later reads a check that claims otherwise.

### One undo entry per session, not one per keystroke

`NSO_sculptCommitRaw` pushes an undo entry every time, which is right for a
bake somebody pressed a button for and wrong for a number field being nudged.
So the **first** adjustment of a session keeps its entry — the one that takes
the block back to the way it was made — and every later one drops the entry it
just pushed. Measured: seven adjustments in a row leave **one** `stockReplace`
on the stack, with the two `posePlaced` entries from the person's own yaw and
tilt still underneath it, untouched.

Done locally in `app-stock.js` rather than by teaching `NSO_sculptCommitRaw` a
mode, because this is the first tool in the app that edits on a field change
and one caller is not yet a pattern. The wheel's live drag has the same
problem and does push per frame; if a second tool wants this, it moves into
`pushUndo` as a coalesce flag and both take it.

### A `change` goes straight through; typing waits to settle

A number field fires `input` on every keystroke, and typing `45` in an empty
box goes through `4` on the way. The live update waits **160 ms** of quiet
before re-generating, so the piece is rebuilt once per value the person meant
rather than once per digit — a 96-segment sphere is 18,240 triangles, so the
difference is visible. `change` (blur, or a spinner click) is already the
settled value and goes straight through.

Deliberately not the wheel's per-frame cadence: a drag has no keystrokes to
wait for, and a number box is not a drag.

### The session ends rather than overwriting somebody else's work

This is the one that would cost a person real work. Make a block, **Hollow**
it, then nudge the waste margin: the card must not throw the hollow away. So
the fingerprint of what this file last wrote — a triangle count and a
coordinate sum — is checked before every update, and a piece that no longer
matches has been baked by another tool.

Five ways the session ends or stands down, each with its own negative control
in the drive check:

| | |
|---|---|
| the piece was baked by another tool | session ends, the work is kept, and it says so: *"…has been changed by another tool, so the card has stopped editing it — your work is kept."* |
| another piece is selected | session ends silently; the card edits nothing. The Match checkbox in particular is about the selection, so an update that fired here would resize the wrong block |
| the piece was deleted | session ends silently |
| a painted face | stands down naming the count, and ends the session — an update re-generates the whole block and cannot hold a face still |
| the new size cannot be printed | **refused, block unchanged, session stays live** — the same build-volume gate New stock applies, so the next valid value still works |

### New stock now selects the piece it made

It did not before: `editId` stayed `null` and nothing was outlined. The session
needs the piece selected to be editable from the card, and it goes through
`selectPlaced` — the app's one selection path — rather than writing `editId`
behind its back, which is the split `docs/INTEGRATION.md` finding 3 was about
in Clone.

## The UI

Its own viewport menu — **Stock**, third in the top-right stack beside Finish
and Wheel — and deliberately not a fifth button on the Pottery Wheel's card.
The wheel's Ball starts a wheel *session* and bakes a vessel onto the
selection; this puts a block on the plate. Different acts, different menus.

The card is the shape selector, `H` / `R`, `W` / `%`, one shape-specific box
whose label follows the selector, `N`, two checkboxes and the button. That one
box carries every shape's second measurement, because all but one of eight
fields would be blank at any moment:

| shape | label | means |
|---|---|---|
| sphere | *hidden* | one measurement, nothing to proportion |
| box | `x:y:z` | three proportions, any scale |
| cylinder, capsule, ellipsoid | `h/d` | height over diameter |
| cone | `h/d[:taper]` | …and optionally the top radius over the base radius |
| tube | `h/d[:wall]` | …and optionally the wall as a fraction of the outer radius |
| torus | `tube/ring` | the tube radius over the ring radius |

That mapping lives in one table in `app-stock.js` (`PROP`), read by the parse,
by the label and by the **Match selected piece** checkbox alike — Match is
offered exactly where a height over a diameter can be read off a bounding box,
so it is disabled and cleared for a sphere and for a torus. Adding a shape is
a closed form and a meridian in `nso_stock.js`, a row in that table and an
`<option>` in `index.html`; the self-test asserts the `<option>` list *is*
`NSO_Stock.SHAPES`, in order, so the two cannot drift. Adding the third menu
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

1. **The shapes that cannot solve a closed form.** Cones and tubes *were* on
   this list and are now built, along with the torus, the capsule and the
   ellipsoid — each turned out to be one exact closed form and one meridian,
   which is the bar. What is still out and why is the table in "Which shapes
   are cheap" above: the rounded block, the superellipsoid, swept and helical
   shapes, lattice and gyroid blocks, and the polyhedra. None of them is
   half-built, and asking for one by name gets the ordinary unknown-shape
   refusal.
2. **Placing the stock.** Everything is generated centred on the axis and
   resting on z = 0. Where it goes on the plate is the packer's business
   (`packModels` in `app-core.js`), and a piece that only fits the machine on
   the diagonal is `nso_printer.js`'s stated non-answer.
3. **Sizing from a target mesh.** `proportionsFrom()` reads a reference piece's
   *proportions*, never its volume. "Make me stock big enough to carve this
   exact model out of" needs the model's own bounding box and a decision about
   stock allowance per face — a real ticket, and not this one.
4. **A shell estimate for a non-revolved target.** See finding 3.

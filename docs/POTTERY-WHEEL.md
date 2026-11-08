# Pottery Wheel — throw a vessel on an axis

`app-wheel.js` (the geometry and the commit half) and `app-wheel-live.js` (the live
sliders, see [The recipe](#the-recipe-and-the-live-sliders)), wired into `index.html`,
loaded after `app-sculpt.js` (whose commit half it reuses) and after
`app-extend.js` (which it calls for rim extension), and after
`nso_thickness.js` (which owns the wall floor), `nso_printer.js` (which owns
the build volume) and `nso_stock.js` (which owns the sizing and the revolve -
see `docs/STOCK.md`).

```
node tools/nso_wheel_test.js             headless: geometry, the two gates, refusals
node tools/nso_wheel_canonical_check.js  canonical checker over every revolved piece
node tools/nso_wire_wheel_test.js        the real app, real clicks, real undo
```

All three are in `npm test`.

## What it is

A potter's wheel. A ball of clay, centred on the axis, is opened, pulled and
trimmed into a vessel — the moves, in the order a potter makes them (a plate
takes Flatten, a bowl or vase takes Open; see [Direction](#direction)):

| move | what it does |
|---|---|
| **Ball** | a smooth centred sphere **dropped on the plate as a piece of its own** — nothing to select, nothing to type. Blank gives the **standard ball** (25 mm radius, 65.4 cm³): pressed flat it is a 167 mm plate that fits the A1 Mini, opened it is a bowl, and anything bigger is built by adding clay. A target height (H, with R) still sizes it from a finished vessel by Pappus's centroid theorem |
| **Flatten** | press the ball down: the top comes down, the clay spreads, and the diameter grows by exactly what the height gives up — a **clay-conserving** squash from the ball to a flat disc with a rounded edge ([Flatten](#flatten)) |
| **Open** | one push down the middle; the single outer profile becomes **two**, outer and inner, and the piece is a shell from here on |
| **Pull** | drag-shape the profile at **any** height, not only the top edge; the drag points are spline-fitted and the form is revolved to a clean solid on every update |
| **Trim** | clean the excess off the base once the form is set |

Plus **Rim +**, which is not this file's work and is not reimplemented here:
it calls `NSO_extendRaw` (`app-extend.js`) directly.

The piece is held as its **meridian profile** and revolved fresh on every
update. That is the decision the rest of the design follows from: the two
constraints below are a scan of a hundred-odd samples instead of a mesh
query, which is what makes them affordable on every frame of a live drag.

## The two constraints

A potter cannot conjure clay and cannot pull a wall thinner than the clay will
stand. Both are enforced on **every** update, and neither is a dead end.

**Material budget.** `ceiling = the starting ball + everything explicitly
added − everything trimmed away`. The live form can never exceed it.

```
Pulling at z = 0.0-23.5 mm needs 384811.5 mm^3 more clay than is on the wheel
(437726.9 of 52915.4 mm^3) - out of material: extend the rim or add clay here
to continue
```

**Wall floor.** The canonical nozzle-safety floor, from `nso_thickness.js`.

```
Pulling at z = 11.8-23.5 mm would take the wall to 0.002 mm at z = 12.99 mm,
under the 0.420 mm nozzle floor - pull less here, or add clay at this height
first
```

Both refusals follow the house contract the sculpt tier set: `ok` is false,
`reason` is set, and `piece` is the **original** piece object, so a caller can
swap unconditionally.

### The floor is not this file's to invent

`NSO_Thickness.floorFor(nozzle)` is the only place the number comes from.
`app-wheel.js` carries no `0.42`, no `nozzle * 1.05`, and no default to fall
back on: loaded into a context without `nso_thickness.js` it **throws** on the
first move rather than guessing. That is asserted, not asserted-in-prose —
section 0 of the self-test loads the file into a bare context and checks it
refuses.

What it does **not** reuse is `measureLoop` as the live gate, and the reason
is measured. See finding 5.

## API

```
NSO_wheelFloor(nozzle)                -> mm, via NSO_Thickness.floorFor
NSO_wheelSizeBall(opts)               -> the Pappus arithmetic, no geometry
                                         (now one call into NSO_Stock.size)
NSO_wheelBall(opts)                   -> { ok, reason, piece }   (no height: the standard ball)
NSO_wheelDefaultBall(opts)            -> the standard ball's sizing record
NSO_wheelThrow(opts, head)            -> Ball in the app: drop a piece, start a session on it
NSO_wheelFlatten(piece, opts)         -> { ok, reason, piece, height, diameter, pressure }
NSO_wheelFlatSolve(V, z0, h, hMin)    -> the pressed form of volume V at height h
NSO_wheelDiscProfile(z0,h,e,c,en,fn)  -> the rounded slab as an outer profile
NSO_wheelOpen(piece, opts)            -> { ok, reason, piece }
NSO_wheelPull(piece, opts)            -> { ok, reason, piece }
NSO_wheelTrim(piece, opts)            -> { ok, reason, piece, removed }
NSO_wheelExtendRim(piece, opts)       -> { ok, reason, piece, extend, added }
NSO_wheelStraightBand(piece, opts)    -> where a rim extension could go
NSO_wheelVolume(piece)                -> mm^3, exact for the polyline meridian
NSO_wheelPappus(piece)                -> { area, centroidR, volume }
NSO_wheelBudget(piece)                -> { start, added, trimmed, ceiling, live, headroom }
NSO_wheelWall(piece, opts)            -> the wall / floor / rim report
NSO_wheelMeridian(piece)              -> the closed meridian loop
NSO_wheelRevolve(piece, opts)         -> rawTris (opts.precise for float64)
NSO_wheelRadiusAt(profile, z)         -> mm
NSO_wheelInnerAt(outer, z, wall)      -> the cavity radius at that height, or -1
NSO_wheelPchip(points)                -> the drag-point interpolant
NSO_wheelTidy(profile)                -> one axis point per end, never a run
NSO_wheelFitReport(piece, printer)    -> the build-volume check, via nso_printer.js
NSO_wheelNewRecipe(ball)              -> the live values a piece is built from
NSO_wheelBuild(recipe)                -> { ok, piece, notes, ranges, ball }: ball > press > open > pull > trim > rim +
NSO_wheelSetRecipe(recipe, head)      -> the sliders' commit: one Undo step, the recipe stays editable
NSO_wheelOpenKeep(piece, opts)        -> Open that keeps the clay (stretches the walls above the floor)
NSO_wheelStretchAbove(piece, z, V)    -> the exact stretch above z that makes volume V
NSO_wheelRecipeOn(piece)              -> a neutral recipe on a baked piece
NSO_wheelApply(move, piece, opts)     -> one entry for every strict move
NSO_wheelBaseOf(piece, history, move) -> the piece a move starts from (Open/Trim/Rim adjust their last)
NSO_wheelRanges(piece, history)       -> what each slider may say, or why it is off
NSO_wheelPullClamped(piece, opts)     -> a Pull that does as much as the wall / height allow
NSO_wheelReball(piece, opts)          -> resize an untouched ball (NSO_wheelIsPristine)
NSO_wheelRun(move, opts, head)        -> sync + paint check + move + bake + undo entry
NSO_wheelSync()                       -> is the piece still what the wheel wrote? rewinds / ends
NSO_wheelDrop(soup)                   -> a new piece on the plate, selected, one Undo entry
```

## Pappus's centroid theorem, both ways round

**The sizing half lives in `nso_stock.js` now.** It was never about spheres -
"target dimension -> shell estimate -> waste margin -> solve for the
primitive's defining measurement" is the same arithmetic for a box and a
cylinder, and New stock (`docs/STOCK.md`) is the general tool built on it.
`NSO_wheelSizeBall` is one call into `NSO_Stock.size({ shape: 'sphere', ... })`
and carries no copy; the three defaults below are stated once, in
`NSO_Stock.DEFAULTS`. Loaded without `nso_stock.js` the wheel refuses by name
rather than re-deriving it, the same contract rim extension has on
`app-extend.js` (finding 8).

The revolve moved with it, for the same reason: `NSO_wheelRevolve` builds the
meridian and hands it to `NSO_Stock.revolve`, so there is one tessellator and a
stock sphere is bit-identical to a ball, not merely the same size.

Everything below is unchanged, and pinned: `tools/nso_stock_test.js` section 1
asserts every figure on this page against the shipped code, including BALL's
status line character for character.

**Sizing.** The target vessel is approximated as a thin shell: a wall of
thickness `t` swept along the meridian, plus a floor of the same thickness.
Pappus's second theorem gives a solid of revolution's volume as `2·π·ρ·A`,
where `A` is the generating region's area in the half-plane and `ρ` its
centroid radius.

- wall strip: `A = H·t`, `ρ = R − t/2` → `V = 2π(R − t/2)(H·t)`
- floor rectangle, `r ∈ [0, R]`, `z ∈ [0, t]`: `ρ = R/2`, `A = R·t` →
  `V = 2π(R/2)(R·t) = πR²t`, which is the disc it should be

One theorem, both parts, and the floor's closed form falls out rather than
being written down separately.

**Measuring.** The live form's volume is not estimated. Green's theorem turns
`2π ∫∫ r dA` over the meridian region into `π ∮ r² dz`, which is exact for a
polyline meridian — each segment contributes `(z₂−z₁)(r₁² + r₁r₂ + r₂²)/3`.
That is the *same identity* as `2πρA`, not an approximation of it, so the
number the budget is kept in and the number the ball was sized by are the same
quantity. The self-test computes both forms independently and asserts they
agree to 1e-12 relative, on a convex ball and on an opened form whose meridian
is not convex.

### The defaults, each stated as a default

| | value | why |
|---|---|---|
| wall | 3.0 mm | a typical thrown stoneware wall, well clear of the 0.42 mm nozzle floor so the floor is a guard and not the default |
| waste | 30% | the hump left on the wheel head, the trimmings off the foot, water take-up, and the clay the potter's hands keep. The low end of what a production potter allows. |
| aspect | 0.5 | target radius = height/2 when no radius is given |

None of these is measured, and each is overridable. The waste margin is a real
margin and not decoration: on a 60 mm target it is the difference between a
21.341 mm ball and a 23.292 mm one — 12,215 mm³ of headroom, which is what a
pull spends. Without it the budget runs out mid-form on a vessel the
arithmetic said was exactly sized, which is the worst possible moment to find
out.

The budget's opening figure is the ball **as built**, not as asked for: a
96-sided meridian polygon is 0.027% under the true sphere (52915.383 vs
52929.553 mm³ at a 60 mm target), and charging the potter for clay that is not
on the wheel would make the very first pull look affordable when it is not.

## Findings

### 1. The revolve is exact, and the float32 soup is the only thing that isn't

An n-gon inscribed in a circle has cross-sectional area `(n/2)r²sin(2π/n)`
instead of `πr²`, and **every** term of the volume integral is an `r²` term,
so the whole mesh volume is the analytic volume times one factor:

```
mesh volume / analytic volume = n·sin(2π/n)/(2π)
```

Measured at n = 96, in float64: `0.999286205822906` against a predicted
`0.999286205822908` — 2.7e-15 relative, which is arithmetic, not agreement.
The same revolve stored as the `Float32Array` the app actually passes around
lands 7.1e-9 off on the ball and 1.1e-7 off on an extended vessel. So the
tessellation is exact and float32 storage is the entire residual, which is why
`NSO_wheelRevolve(piece, { precise: true })` exists: without a float64 revolve
there is no way to tell one from the other, and a real tessellation bug would
hide comfortably inside 1e-7.

The practical consequence is in `tools/nso_wheel_canonical_check.js`: the
checker's `signed_volume` is gated against `analytic × polygon_factor` at 1e-6
relative, and the slack is named as float32 STL storage rather than left as a
round number.

### 2. The cavity is not `outer(z) − wall`, and the shortfall is 52%

The obvious implementation of Open — subtract the wall from the radius —
leaves a **perpendicular** wall of `wall · cos(slope)`. On a ball that goes to
nothing exactly where a thrown pot is already weakest. Measured on the default
3 mm open of a 23.29 mm ball:

| cavity definition | thinnest perpendicular wall | where |
|---|---|---|
| `inner(z) = outer(z) − 3.0` | **1.446 mm** (51.8% under the ask) | z = 3.57 mm, near the base |
| bisected (shipped) | **3.000 mm** | everywhere |

So the inner surface is defined as the locus of points at perpendicular
distance `wall` inside the outer surface:

> `inner(z)` = the largest `r ≤ outer(z)` with `dist((r, z), outer) ≥ wall`

found by bisection. It needs no offset curve, it cannot fold, and it handles
the corner at the base for free: the same predicate that keeps the wall off
the side keeps the cavity floor exactly `wall` above the base. Where even the
axis is closer than `wall` to the outer surface there is no cavity at that
height and the piece stays solid there — which is what `NSO_wheelInnerAt`
returning −1 means, and what sets the rim when a ball is opened.

### 3. A vertical outside is not a vertical inside, and Extend can tell

A Pull carries the inner wall along by adding the **same radial
displacement** to both profiles. That holds the radial gap exactly, is one
pass over the samples, and is what a live 60 Hz drag can afford.

It is also not enough to leave a straight wall. Pulling a vessel's upper wall
to a constant radius and carrying the inside radially gives an inside that is
*not* constant, because the displacement varies with height. Extend then has
nothing to insert into:

```
no constant cross-section band along z - 79 gap(s) examined, none clean;
widest (0.4802 mm) failed because 384 of 384 straddling triangles are oblique
(worst |n.u| 6.51e-1 against a derived tolerance of 1.29e-5)
```

`opts.reshapeWall` throws the inside away and rebuilds it from the new outside
with finding 2's bisection, so the perpendicular wall is exact everywhere and
a vertical outside gives a vertical inside. Same drag, same piece:

| pull | straight band found |
|---|---|
| radial carry (default) | none — best run 0.416 mm |
| `reshapeWall` | **8.850 mm** |

It costs a bisection per sample — milliseconds, not microseconds — so it is
opt-in rather than the default. Either way the gate measures the
**perpendicular** wall, so the cheap path cannot quietly ship a thin pot; it
can only refuse a pull the expensive path would have allowed.

### 4. The drag-point fit is monotone cubic, and that is not taste

The drag is a list of points the pointer visited: sparse, unevenly spaced,
noisy. Connecting them straight leaves the vessel faceted, which is why it is
a spline fit at all. Which spline is the load-bearing part.

Catmull-Rom overshoots between unevenly spaced points, and an overshoot in `r`
is a bulge the potter did not make — near the axis it can be a **negative**
radius, which is a profile that crosses itself and revolves into an inside-out
shell. On the self-test's four-point drag (a step from r = 8 to r = 14 over
0.5 mm), a uniform Catmull-Rom leaves the interval by **0.4444 mm**.
Fritsch-Carlson monotone cubic Hermite leaves it by **0** — it cannot, by
construction, because it clamps each node's slope into the interval the
neighbouring secants allow.

The price is C¹ instead of C², and a flat spot at a local extremum. Neither is
visible at 96 meridian samples: the worst turn between consecutive meridian
segments in the dragged span comes out at 3.27° against 5.35° through the raw
drag polyline, so the fit is measurably smoother than what the user drew.

Outside the dragged range the displacement tapers to zero over `taper` mm with
a compact biweight kernel `(1 − u²)²`. Compact support is the point: a
Gaussian never reaches zero, so a base would drift by a micron on every pull,
and a base that has drifted twenty times no longer sits flat on the plate. The
self-test asserts that every sample outside the taper comes through
**bit-identical**.

### 5. The canonical 2D probe misreads a meridian, by 1.47 mm

`NSO_Thickness.measureLoop` walks a closed section, and a meridian *is* one,
so the module that owns the floor can be asked for a second opinion on the
wall. Told which loop indices are the outside and which the inside (via
`skipSeg` / `skipPt` — its default "ignore your two neighbours" window is
meant for a cut cross-section and on a 96-sample profile would answer with the
sample spacing), it reports:

- its **nearest-point** pass reconciles exactly with a point-to-point sum over
  the other wall, and sits at most 0.63 mm — half a meridian sample spacing —
  above the exact point-to-segment wall;
- its **ray** pass under-reports by up to **1.4655 mm** on a 3.00 mm wall.

The ray pass accepts a hit at `u ∈ [−0.05, 1.05]`: a 5% overshoot past the end
of the target segment. That is the right slop on a cut cross-section, whose
segments are all a similar length. A meridian's cavity-floor segments are
millimetres long next to a wall that is tens of millimetres, so 5% of a short
segment is a long way, and the ray is admitted against a segment it actually
misses.

So: the **floor** comes from `nso_thickness.js` and nowhere else, and the
**measurement** the live gate runs is this file's own exact point-to-segment
scan. The canonical probe is kept as a cross-check in the self-test, with the
disagreement pinned at > 1.0 mm so that a future fix to `loopWallAt` shows up
as a test failure here rather than as silence. It never says PASS on a piece
that is actually thin — it under-reports, which is the safe direction — so
this is a precision finding, not a safety one.

### 6. The profile and the mesh can part company silently, and the canonical checker is what notices

A Pull clamps radii at zero, so a displacement that reaches the base can drive
several consecutive samples at the bottom of the form to `r = 0`. The revolve
quite correctly emits nothing for a band whose two ends are both on the axis —
so the **solid** starts higher than the profile says it does, while the
analytic volume, which also gets zero out of those segments, still agrees.

Nothing inside the wheel could see it. `tools/nso_wheel_canonical_check.js`
compares the checker's bounding box against the profile's own span, and caught
a pulled bowl claiming a base at z = 0 while the mesh started at z = 0.112.

That matters beyond tidiness: the build-volume warning is built on the
profile's span, so a piece could have been warned about a height it did not
have. `NSO_wheelTidy` now runs on every profile going into a piece — one axis
point at each end, never a run of them — and the bbox check is a permanent
gate.

### 7. Trimmings do not go back on the wheel

Trimmed clay is gone, not banked. The ceiling drops by exactly the volume
removed at the same moment the live volume drops by the same amount, so **a
trim buys the potter no headroom** — measured at a delta of 0.000e+0 mm³
across a trim, and asserted as an invariant. That is the real behaviour:
trimmings go in the slops bucket.

The mirror image holds for a rim extension. Clay added at the rim raises the
ceiling by exactly what the form gained, so an extension is affordable by
construction and the headroom before and after is identical. What the gate is
checking on an extension is therefore the **wall**, not the budget.

### 8. Rim extension really is Extend

Not "modelled on", not "the same approach as". `NSO_wheelExtendRim` revolves
the current profile, hands the soup to `NSO_extendRaw` with `axis: 'z'`, and
takes Extend's answer — including its refusals. The self-test wraps
`NSO_extendRaw` in the vm context and counts the calls, so "it delegates" is
proved rather than asserted: exactly one call, on Z. Loaded without
`app-extend.js` the move refuses by name instead of growing its own copy of an
axis-preserving stretch.

The profile side is exact, and the reason is Extend's own clean-band
condition: Extend only cuts where every straddling triangle is perpendicular
to the axis, which on a solid of revolution means the outer *and* inner radius
are constant across the cut. Inserting `delta` of a constant-radius band into
a profile is therefore literally "shift every sample above the cut and add two
at the seam" — no spline, no resampling, no approximation. And the delta
followed is the one **Extend measured**, never the one asked for, because
`fround(oldMax + delta)` is a step function of `delta` (docs/EXTEND.md finding
3); following the ask would part the profile from the mesh by a ULP per
extension.

`NSO_wheelStraightBand` finds the band in profile terms *first*, so the
refusal a potter sees names the rim rather than a triangle census — and then
Extend finds it again, independently, in the mesh. A band shorter than 1 mm is
not reported: it is two samples that happened to land on the same radius, and
offering it would hand the potter a "there is a band" that Extend then refuses.

## PAINT SCOPE: WHOLE-PIECE

Per the scoping rule in `docs/HANDOFF.md`: the question is whether the feature
acts on an identifiable sub-region. It does not — and it is the strongest
whole-piece case in the roster. Every move revolves the meridian profile into
a brand new triangle soup, so **not one triangle survives an update**. There
is no face the wheel could promise to leave exactly where it was, which is
precisely the promise the paint rule demands. Any paint anywhere on the piece
stands the whole bake down, naming the count. `nsoMaskCount(m)` is the whole
test.

The check runs **before** the move, not before the bake. Standing down after
the profile had already advanced would leave the wheel holding a form the
piece on the plate does not have — the session and the model one move apart,
and the next bake applying both at once.

## Out of scope for this first version, named

1. **Non-symmetric appendages — handles, spouts, feet, lugs.** Everything here
   is a solid of revolution held as one meridian profile, and that
   representation cannot express a handle at all. Adding one means a boolean
   union against a non-revolved body, which is Join's job. Real, deferred,
   deliberately absent — and asserted absent: the self-test greps for a handle
   or spout generator and fails if one appears.
2. **Centring an arbitrary / asymmetric starting mesh.** The wheel starts from
   a ball it generates itself, which is centred by construction. Taking an
   imported piece and finding the axis it wants to spin about is a real
   problem — a covariance axis, a radial-variance minimiser, and a decision
   about what to do with the material that does not fit — and none of it is
   solved here. There is deliberately **no** entry point that takes a mesh in.
3. **Re-entrant forms.** The profile is `r` as a function of `z`, so a
   closed-in neck is fine and a torus section is not. A form that doubles back
   on itself in `z` needs a parametric meridian and a different set of gates.
4. **Shortening at the rim.** `NSO_wheelExtendRim` inherits Extend's own
   "lengthens only" refusal (docs/EXTEND.md, out of scope 4).
5. **A true offset curve for the cavity.** Finding 2's bisection gives the
   right answer per height, sampled; an exact offset curve with self-
   intersection handling would give it in closed form and would let Open
   survive a profile with a sharp concave corner without leaning on the gate
   to catch it.

## Flatten

`NSO_wheelFlatten(piece, { height | pressure })`, the **Flatten** button and its
thickness box (blank: as flat as the wall allows).

A pressed ball is a rounded slab of height `h`: a flat core of radius `c`
(top and bottom) and an edge that is a half-ellipse of horizontal semi-axis
`e` and vertical semi-axis `h/2`. Pressure `p` runs from 0 (the ball) to 1 (the
thinnest disc the wall allows, `h = wall`):

```
e(p) = h/2 + (eMax(h) - h/2) * (1 - p)^2        c solved so the volume is V
V    = pi*h/2 * (2c^2 + pi*c*e + 4e^2/3)        (the closed form the self-test checks against)
```

`eMax(h)` is the widest `c = 0` ellipsoid of that height the clay will hold, so
`e` never exceeds it and `c` is never negative — there is no clamp. The height
is the one number (a drag, later); the pressure is derived from it, so a drag
back **up** un-presses along the same curve, and the result is a function of the
clay and the height, not of the history.

**The clay is conserved.** The new form is solved so its volume equals the live
volume — by bisection on `NSO_wheelVolume`, the same polygon the revolve
tessellates, keeping the **low** side so a rounding error can never push a ball
that has exactly zero headroom over its ceiling. Measured: a relative volume
change of 1e-16 at every height. The diameter is what falls out: a 46.6 mm ball
(52 915 mm³) is 49.9 mm across at 40 mm thick, 63.7 at 20, 84.7 at 10, 150.5 at
3 mm.

It presses a **solid**: an opened piece refuses and says to flatten first. A
height above a ball of that clay refuses ("Flatten only presses down"), one under
the wall refuses, a wall under the nozzle floor refuses — each with the original
piece handed back. A lightly pressed ball can still be opened.

The canonical checker's "inside the material ceiling" gate moved from an absolute
1e-6 mm³ to the 1e-6 **relative** float32 storage bound the check before it
already asserts: a clay-conserving piece sits exactly *on* the ceiling, so the
storage residual alone decides which side of it the measured number lands.

## The recipe and the live sliders

**The piece is a recipe, not a pile of baked steps.** Every slider on the card is
one live value, and the form is **rebuilt from the ball**, in the order a potter
works, whenever any of them moves (`NSO_wheelBuild`, `app-wheel.js` "7g"):

```
ball  ->  press (Thick)  ->  open (Open) or lip (Lip)  ->  pull (Pull at, Pull, Soft)  ->  trim  ->  rim +
```

Nothing is baked into the profile, so **nothing is ever shut off**. Dragging Thick
after the bowl is open re-presses the ball and opens it again on the new shape;
dragging Scale resizes the ball under everything else; take any slider back to neutral
and the earlier piece is back, exactly. The order you move them in does not matter —
the same recipe is the same piece (tested).

**A limit is a clamp, not a refusal.** A stage that cannot be done at the current
values does the most it can and says so in the read-out: Open on a 3 mm disc, a Pull
that would take the wall under the nozzle floor, Rim + on a curved wall. The slider
stays live; the reason is on screen. Each slider's range follows what is upstream of
it (whether Open has room depends on how far Thick has pressed) and comes out of the same
build pass. An Open the shape cannot honour is remembered — drag Thick back up and it
takes effect.

| control | does |
|---|---|
| **Edit on wheel** | puts the **selected piece** back on the wheel to shape it again ([Putting a piece back on the wheel](#putting-a-piece-back-on-the-wheel)) |
| **Starter Ball** | drops the ball (standard 25 mm unless H / R say otherwise) as a piece of its own and starts a recipe on it |
| **Scale** | the size of the ball (its radius; the standard ball is 25 mm, shown as Ø50). Live at any time, under everything else. It replaced H and R: a target height (Pappus) is still `NSO_wheelBall({ height })` in the API, but the card has one size slider |
| **W** | the wall: how thin the disc may press and how thin the walls open. A thicker W opens a shorter, thicker-walled piece from the same clay |
| **Thick** | press: the top comes down, the diameter grows, the clay is conserved. All the way up is the unpressed ball |
| **Open** | from closed (0) to the widest bowl the wall allows (100%): the mouth, the depth and the size of the shell grow together, the clay conserved ([A soft Open](#a-soft-open)) |
| **Tall** | how tall the opened piece grows, the same clay and Wall: ×1 is the round bowl, ×3 a jug, ×0.5 a dish ([Tall](#tall-the-jug-and-the-vase)) |
| **Lip / Lip at / Flare** | lift the edge of a pressed plate into a rim, this high; where the lift starts (a % of the plate's radius); how long the ease into it is (a % of the lifted part). [Lip](#lip) |
| **Pulls 1–4, Pull at / Pull / Soft** | up to four pulls, one on top of another ([Several pulls](#several-pulls)); the chips pick which one the three sliders edit. Pull at: where (a % of the height, so it follows the piece); Pull: how far out or in; Soft: how widely it spreads (a % of the height: small is a ring, large is a belly) |
| **Trim, Rim +** | take off the base (the clay is gone); add height at the rim (Extend — needs a straight wall) |
| **Flatten, Open** | one-click **presets**: they send their own slider to its far end. They bake nothing |

*Interaction.* Drag a slider: the piece itself changes, live, as a **preview** (the
placed mesh's geometry is swapped for a throwaway one, `m.rawTris` untouched, the Undo
stack does not move). Let go: **Set**, one Undo step — and the *recipe* stays
editable, so the next drag on any slider starts from the ball again. Escape puts the
preview away. Undo rewinds the recipe with the piece (the history holds
`{ recipe, piece, soup }`), and the sliders follow it back.

*There is nothing to type into.* Each slider is one row — its name (for Thick and Open,
the Flatten / Open preset button), the track, and what it says — and the number is the
slider's own, through `app-live-slider.js`'s optional-box form (`bind` without `box`:
`value()` reads the slider; the read-out is the only text). The whole card is nine
sliders and three buttons, 316 px tall, so Gen+ fits the window without scrolling; it
was over 1100 px with number boxes.

*Conserving the clay.* Press, open and pull all keep the volume: press by solving the
rounded-slab family; **Open** by growing the whole shell until the volume is what it was
(the wall is never scaled; [A soft Open](#a-soft-open)); **Pull** by scaling heights about the base by `V0/V1`. A pull that moves nothing refuses. Trim takes clay away and Rim + adds
it, and both say so.

*Which shapes come out.* From the standard ball with a 3 mm wall: Open 50% is a round pot with a
thumb-dimple (Ø52), 85% a round bowl (Ø73 × 55), 100% a hemispherical bowl (Ø112 × 64); Thick 20 + Open 100%
is Ø143 × 25; a plate as thin as its wall cannot be opened. **Wall is the lever for the rest** — it is never
scaled, so a thin wall makes the same clay a bigger, thinner bowl (Wall 1.3: Ø161 × 91).

*Strict API.* `NSO_wheelRun(move, …)` and the `NSO_wheelFlatten / Open / Pull / Trim /
ExtendRim` functions are unchanged and refuse whole when a stage cannot be done; a
strict move **bakes** — what it makes becomes the recipe's `base` and the sliders go to
neutral on top of it (`NSO_wheelRecipeOn`). The sliders never come through there
(`NSO_wheelSetRecipe`).

**What this does not do yet.** No foot ring (Trim leaves a flat foot), no spout, no handle — the last two are not
round, so they are a different kind of feature. A loaded piece is not given back a Flatten / Open / Tall to play with (those are a ball's). Scale, Wall, Soft, Lip at and Flare have no ball on the piece — they have a ring
(next section).

### A soft pull

Pulls used to look like a **funnel**: two straight cones meeting at a sharp ridge, and on a
pinch a neck with hard shoulders. Measured on a Ø54 piece with Pull +24 at 40%, Soft 60%, the
outside profile turned **86 degrees** between neighbouring segments (8 with no pull). Three
things were behind it, and none of them was the falloff curve being "too sharp":

1. **Too few samples where the wall moves.** An opened piece's outside had 35 samples in all, a
   dozen on its tall wall, and a 24 mm pull moves each by a different amount — so the wall between
   two samples is a straight facet whatever curve moved them. Now `refine` cuts every segment in
   the pull's band into pieces no longer than a step **in height** (`NSO_wheelRefineBand`; the new
   samples lie on the old segments, so the shape is unchanged; a flat face is left alone). The step
   follows how hard the falloff bends — `0.07·taper² / (4.93·amplitude)`, a turn of about 4 degrees
   between neighbours, from 0.04 mm for a narrow deep pull to 1 mm for a broad shallow one, never
   more than ~260 samples across the band.
2. **The curve itself.** The strict API's falloff is `(1 − u²)²`, tangent at its edge but with a
   curvature jump there. The Wheel's pull now uses **Tube Edge's Smooth neck curve**,
   `r = r_mid + Δr·(1 − cos 2πs/L)/2` — a raised cosine with a taper of L/2 — tangent where it
   leaves the wall and rounded at the waist. Pulling a plain tube with it **reproduces Tube Edge's
   Smooth neck to 5.6 microns** (tested), so a pull and a Tube Edge neck of the same Δr and length
   are the same curve. (Funnel is Tube Edge's other profile: straight in, straight out.)
3. **A crease at the foot of every opened piece** (in the strict API's Open, which is still there; the
   Wheel's Open is now [a soft Open](#a-soft-open) and has none). Open stretched everything above the cavity floor
   by one factor — exact for the clay, but the wall just below the split kept its slope and the wall
   above had it divided by the stretch (×14 and more): a **35 degree kink** in the outside before any
   pull. The stretch now eases in, `z' = z + a·G(z)` with `G` the integral of a smoothstep from the
   floor over 60% of the height above it, so the base is untouched, the full stretch is reached
   smoothly, and volume is still linear in `a` (two evaluations still find it exactly). 34.6 → 6.4
   degrees. The cost: the ramp stretches the lower wall less, so an opened piece comes out a little
   taller for the same clay (74.9 → 80.8 mm for Thick 20, strict Open depth 5), and the stretch factors are large
   (×21 there, ×75 for a 0.8 mm opening of a 10.9 mm disc) because a thin shell really does need that
   to give back what its cavity displaced.

Result on the three pulls above: **86 / 63 / 59 degrees → 5 / 8 / 6**, and the thinnest wall on the
first goes from 0.47 mm (under the nozzle floor, because the facets cut the bulge's corners) to
1.5 mm. **Soft** now reaches 100% of the height (it stopped at 60) and defaults to **40%**. The strict
`NSO_wheelPull` is unchanged unless asked (`kernel: 'cosine'`, `refine: true` — what the recipe
passes), so its pinned behaviour stands.

### A soft Open

The strict `NSO_wheelOpen` / `NSO_wheelOpenKeep` open the piece **as wide as the wall allows** and throw
the dome away, so *any* opening — 0.1 mm of it — is the whole bowl, with the dome stood up as straight walls.
On a slider that was a cliff, and two complaints were one bug: a squished ball became "a vase bottom" in the
first pixel of Open (50 → 99 mm tall at 0.3 mm, 6 mm down to a 51 mm tube), and dragging Flatten with an Open
left over jumped from a flat disc to a 47 mm tube the moment the disc was thick enough to hold a cavity. It
also stood the walls straight up: a ball never came out *round*.

The Wheel's Open (`NSO_wheelOpenSoft`, the recipe's `open`, 0 to 1) is one family from the closed piece to the
widest bowl, and **every quantity in it goes to zero with it**:

- **mouth** — `u` of the widest mouth the shape can hold. The rim sits where the *outside* is wide enough for that
  mouth plus a wall: on the dome of a ball (a hair above the equator at 100%), on the **flat top of a plate**,
  which keeps its top instead of losing it;
- **depth** — `u^0.6` of the way from the rim down to the floor the wall allows, and below the mouth the **hollow flares out** (a slope
  of `2.2 u`) until the wall's own offset stops it: a narrow mouth over a hollow body, the bottle, not a solid lump with a pocket in it.
  The floor is an ellipsoid that squares off into the bowl's own inside as `u` grows. Both the depth and the flare go to zero with `u`,
  so a touch of Open is still a thin shallow bore;
- **the clay** — the whole shell is **scaled up** about the middle of its base until the volume is what it was
  (a log-secant on volume, 3–5 builds, ≤ 3·10⁻⁷ short and never over). The clay the cavity and the cut-off cap
  displaced does not vanish: the piece *grows*, the way a pressed disc's diameter does, so a ball opens into a
  **round bowl** and a plate into a **dish**. The wall is the one thing never scaled, so **Wall** is the
  lever for how thin it comes out.

The mouth at a given rim is found by the same wall-distance rule the cavity always used (the largest radius at the rim
height that is a wall from the *rest* of the outside — the part above the rim is cut off, so it is ignored), by bisection
on the outline's arc; the widest rim is scanned, the jump where a plate first has room is bisected, a peak is polished, and
the highest rim within 1% of the widest is taken (on a plate the widest is at the foot of the edge, with no depth to open).

The slider is `p`, not `u`: the clay a mouth needs grows with the cube of how open it is, so the last tenth of a linear
slider doubled the bowl. `u = 1 - (1 - p)^1.5` (`NSO_wheelOpenU`, and `NSO_wheelOpenP` back, which the mouth handle uses).

What it measures (ball, wall 3): Open 10/30/50/70/85/100% → Ø50 / 60 / 76 / 93 / 103 / 113 at 50–72 mm tall; no 1% step of the
slider moves the width more than 1.7 mm or the height more than 0.6 mm (it was a 49 mm jump). Dragging Flatten with Open
set, 4 mm down to 1.4 mm on a 1.3 wall: what Open adds changes by ≤ 1.1 mm per 0.05 mm step (it was 45 mm). A build with Open and a
Pull is 25 ms. The pieces are under the canonical mesh checker (watertight, wall, height, footprint).

`NSO_wheelOpenReach` says whether there is room (a mouth *and* a rim above the floor: a plate two walls thick has the first
and not the second) and how wide — that is the slider's range and its reason. A touch of Open too small to make (under a
dimple's worth) is simply not opened yet, not a refusal. The strict API is untouched, and so are its tests.

### Tall: the jug and the vase

A round bowl is wider than it is tall, and a jug is not. **Tall** (`recipe.tall`, ×0.5–×4, 1 = the plain Open) changes the *shape of the
growth*, not its size: the shell is grown by `s`, heights `× sqrt(tall)` and radii `÷ sqrt(tall)` — a volume-preserving stretch, so
`tall = 1` is exactly the plain scale and any other value asks for the **same clay** in a taller (or squatter) vessel, solved by the same
volume solve and never over. It acts inside Open, so it has nothing to do until Open is raised (the slider stays live and its tooltip
says so). Dragging the **rim** of an opened piece up or down is this slider (`tall ∝ ((H + dy) / H)²`, the height following the cursor).

Measured (ball, wall 1.6–3): Tall ×2 at Open 70% is 127 × 82 mm; ×3 at 85% is 120–170 mm tall, h/Ø 2.0; ×4 at 60% is h/Ø 3.4. The wall holds
(`wall 3.00` at every point), the clay is kept to 1e-6, no 0.05 step of Tall moves the height more than 5 mm, and the pieces are under the
canonical mesh checker. A neck is a Pull in at 80–85% of the height; a belly a Pull out at 30%. What it does **not** make yet: several
bellies and necks in one piece (the pull is one bump), a flared collar on top of a neck (that is a second pull out at the rim), a foot ring
(Trim leaves a flat foot, no ring), spouts and handles (non-axisymmetric: they are the next kind of thing, below).

### Several pulls

A vase is a belly, a neck and a flared lip, and one pull is one bump. The recipe now has **four pulls**: `recipe.pull` is the first and
`recipe.more` holds the other three, each `{ z, dr, wide }` (`NSO_wheelPullSlot` reads or makes one; the defaults for slots 2–4 are Pull at
80% / 30% / 95%, Soft 25%, 0 mm, i.e. off). They are applied **in order, each as a fraction of the piece as it then is** — the first
conserves the clay by moving the heights, and the second finds its place on the result — so they stack, and each keeps the clay and is held by
the wall on its own (a pull the wall cannot take is clamped and named: *Pull 2: ...*). Four pulls cost about 40–90 ms.

On the card, **one set of three sliders and a row of chips**: the chips (1–4) pick which pull Pull at / Pull / Soft edit; a lit chip is a pull
that is doing something (`Pull ≠ 0`). That keeps the stack the height it was. On the piece, **every active pull has a yellow ball**
(numbered in its tag: *Pull 2 −5 mm at 80 %*) plus one for the pull being edited; pressing a ball selects its pull, dragging it out/in and up/down
is that pull's Pull and Pull at. The ring and tag of the Pull rows speak for the pull being edited, and for the one under the cursor when a ball is hovered.

What it makes (Open 85% + Tall 2.5, wall 2): belly out at 30% + neck in at 75% + lip out at 97% is a vase (139 mm, no segment of the outside
turns more than 25 degrees, wall ≥ 1.05 mm); neck + collar, a gourd with two bulges, a bowl with a foot step and a flared rim all build and keep
the clay to 1e-6 (the vase is under the canonical mesh checker).

### Putting a piece back on the wheel

**Edit on wheel** (next to Starter Ball) takes the selected piece — not a new one — back onto the wheel. There are two ways in, and it says which:

1. **The wheel threw it and it still wears its memo.** Every piece the wheel writes carries its recipe and the triangles it wrote (`m.wheelMemo`,
   checked by identity: `memo.soup === m.rawTris`). Put it back after the menu was closed or another ball took the wheel and **every slider
   comes back** — Open, Tall, the four pulls, Trim. If anything else touched the piece, or Undo moved it, the memo is ignored and the piece is read
   from its mesh instead. The memo is not saved with a project.
2. **Any other piece that is a solid of revolution** (an exported and re-imported vase, a piece from another tool) is **read from its mesh**
   (`NSO_wheelRelathe`, section 7k). The wheel starts a recipe on top of what it is (`ops: ['loaded']`, `NSO_wheelRecipeOn`): **Pull (all four),
   Trim and Rim + work on it**; Flatten, Open and Tall are for a fresh ball, and their tooltips say the piece is already open.

*Reading a mesh.* The axis is the vertical through the middle of the footprint (found wherever the piece sits). The mesh is cut by a half-plane through
the axis at 8 angles, **a hair off any meridian** so the cut passes through the ring vertices rather than along their edges — the radii are the mesh's
own, not a chord's short of them (the round trip on the wheel's own pieces: outside within 0.2 µm, thinnest wall identical, volume 6.5·10⁻⁶; a
three-pull vase simplified from 569 points to 234 is within 14 µm). Each cut is a polyline from the axis at the foot to the axis at the top or the
floor; the endpoints are joined with a tolerance (every vertex is met twice, a few thousandths of a millimetre apart). A solid is one outline; a vessel
is the outside up to the rim and the inside from the floor to it (the rim is the flat across the top, or the short chord across the wall).

*What it refuses, by name, and leaves the piece as it was:*
- **not round** — the 8 cuts differ by more than the larger of 0.3 mm and 0.6% of the radius; the message gives the difference and the height ("the outside
  differs by 7.90 mm between angles 0.1 mm up"). A box, a bowl squashed 12%, a jug tipped over;
- **an overhang** — a wall that folds back under itself (a mushroom's cap, a curled lip): the wheel holds profiles that only rise;
- **a hole through the axis** (a ring, a pipe) or **more than one outline** (a second cavity, a loose part): its profiles start on the axis;
- **no wall to speak of**, or **too few triangles**.

*What it quietly fixes, and says so:* a rim rounded or sharper than the nozzle floor (the wheel needs a flat rim as wide as the floor) is **cut flat** a
fraction of a millimetre down, and the status line says how far. A wall already under the floor loads, with a warning that edits touching it will be refused.

*Nothing on the plate changes until something really moves.* Loading builds no Undo step and replaces no triangles; the first slider that actually changes
the shape is one `wheelReplace` step like any other, and Undo gives back the **original mesh exactly** (tested by identity). A slider that does not change the
shape (Pull at while Pull is 0 mm, Tall before Open) no longer makes an Undo step either: `NSO_wheelSetRecipe` compares the built profile with the current one
and only keeps the recipe. A plate loaded this way has no `press`, so Lip says to press a ball first — the wheel does not guess one.

**A race this found, and fixed.** The 300 ms background refresh (`watch`) could put the recipe's old value back on a slider between its first `input`
event and its `change`, and the drag was lost — about 1 in 12 times in a stress loop of Flatten / Open / Pull sets. A slider in someone's hand is theirs now
(`heldSlider`, which lapses after 1.5 s so a drag ended by Escape cannot freeze the card), and `watch` does not refresh while one is held.

### Lip

`NSO_wheelLip` (`app-wheel.js` "7e2"), a recipe stage after Open, with three sliders:
**Lip** (how high the rim rises above the plate), **Lip at** (where the lift starts, a % of
the plate's radius) and **Flare** (how long the ease into it is, a % of the lifted part).
The reference is a plate whose edge rises with a flared underside and a rounded rim.

*The shape.* The plate is a constant-thickness slab of the thickness it was pressed to (a
pressed plate remembers its press: `piece.press = { h, e, c }`). Out to *Lip at* it stays
flat; from there its **midline** turns up — the heading eases in as `sin²`, so the underside
leaves the flat tangent with no crease, then holds a lift angle to the rim — and the slab is
swept along it, so the thickness is the plate's own all the way up (measured: 6.000 mm along
the whole underside). The rim ends in rounded arcs of radius h/2 closed by a chord of 0.6 h,
so the wall gate has a real rim to measure.

*The clay is conserved.* Bending a slab inward shortens its reach, so the length of the bent
part is solved (bisection, low side kept) until the volume is what it was; the diameter is what
falls out — about 4–5 mm under the flat plate's for a 10 mm rim on a Ø119 plate (119.2 → 114.4),
less for a gentler one. The lift angle is solved for the height asked (the rim's highest point
above the plate's top face — measured, 10.0000 for 10), capped at 70° and said so when it bites
("Lip limited to 16.7 mm — the rim cannot lean further over this length"). A **longer Flare** is
a rounder ease and, for the same height, a steeper finish; a Flare too tight for the thickness is
lengthened so the top face (the inside of the bend) does not fold.

*What it is.* A lipped plate is an **opened** piece — outer = the underside up round the rim,
inner = the top face — and both profiles rise monotonically, so the gate, the revolve, the
guide lines, Pull and Trim take it as they take a bowl. (The earlier worry that a plate needed
the loop-profile refactor was wrong: horizontal faces are fine as runs of samples with one z.)

*When it stands down, it says so and stays live.* Lip needs a pressed plate whose flat core is at
least as wide as it is thick, and not opened: an unpressed ball ("press the ball into a plate
first"), a thick bulge ("press it flatter"), an opened piece ("an opened piece has no flat plate
to lift") each leave the piece as it is, put the reason in the read-out and the slider's tooltip,
and **remember the lip you asked for** — drag Open back to 0 or Thick back down and it takes
effect. Lip back to 0 is the flat plate exactly.

*Height.* On a lipped plate the highest point is the top face's end on the **inner** profile, a
little above where the outside stops, so every height the wheel reports (the status line, the
build-volume check, the canonical checker's bbox) reads `NSO_wheelHeightOf` (the higher of the two
profiles). The canonical mesh checker found this one.

### Dragging on the piece

Handles on the piece write to the **same draft recipe the sliders do**, through the same
preview and the same Set — so a drag is one Undo step and the sliders move while you drag.
They are balls drawn on top of the piece, round on the screen whatever the zoom:

| ball | where | drag | drives |
|---|---|---|---|
| **blue** Flatten | the top face of a ball or plate | **down** | Thick (press) |
| **cyan** Open | off to the side of the top of a ball, where a mouth would start; on the **rim** of an opened piece | **out** (and, on the rim, **up**) | Open — the mouth; and Tall |
| **yellow** Pull (one per active pull, 1–4) | the wall, at that pull's height | **out / in**, and **up / down** | that pull's Pull, and Pull at |
| **green** Lip | the rim of a pressed plate | **up** | Lip |
| **red** Trim | the foot | **up** | Trim |

A drag on a handle swallows the press (orbit off for its length, back on after); a drag on
empty space still orbits. Escape puts a drag away; a click that does not move changes nothing.
The cyan ball is never on top of the blue one (the blue goes away once the piece is open, an opened piece
being no plate), and where two would overlap on the screen the later of blue, cyan, green, yellow, red steps aside.

**Every control says where it is.** Dragging "just moving knobs" was the complaint: the sliders and the balls
did not tell you which was which. Now both ends point at each other:

- each slider row wears **the colour of its handle** on its left edge (violet for Scale and Wall, which have no handle);
- **hover a handle** — its rows light up, a **tag** beside it names it and reads its value (*Pull +10 mm at 50 %*), and a **ring**
  on the piece shows the place it acts on;
- **hover, focus or drag a slider row** — the handle it belongs to swells, the same tag follows, and the ring is drawn: at the pull height
  for Pull / Pull at, at the pull height ± the Soft width for **Soft**, at the widest part for **Scale**, at the rim (inside and out) for
  **Wall**, on the top face for **Flatten**, at the mouth for **Open**, where the lift starts for **Lip at** and at its crest for **Flare**,
  on the foot for **Trim**, at the top edge for **Rim +**. A slider with no handle still has a ring; a ring is where it works.

(`markerSpecs` in `app-wheel-live.js`, drawn as thin tori in the handles' own scene group, kept in step through the preview, so they
ride the shape being shown while you drag a slider.)

*How a mouse movement becomes millimetres.* Each handle knows its two axes on the screen —
radial (the camera's right, so a radial drag runs along the screen's x) and up — by
projecting the handle and one millimetre along each through the camera; the mouse delta is
turned into `(radial mm, up mm)` by a 2x2 solve, so it holds from any angle, and the top of a
pressed ball follows the cursor (measured: the Thick slider within 0.1 mm of what the cursor
implies). The drag edits a **fresh copy of the recipe it started from** every time, so nothing
drifts; builds are throttled to the pace they take (latest wins, a build is ~60 ms). The mouth handle works in `u`
(a radial millimetre is `1/(widest mouth)` of it) and converts back to the slider with `NSO_wheelOpenP`.

*Where they sit.* `handleSpecs` puts them from the piece's profile and the recipe: blue at the
top face centre (or the plate's floor under a lip), cyan on the top where the mouth would start or on the inner rim,
yellow on the outer wall at *Pull at*, green on a pressed plate's rim (the inner profile's highest point
once there is a lip, so it rides up with it), red on the foot. They are children of a scene group, not of the
piece's mesh, and follow the camera through OrbitControls' `change` event. They exist only while the Wheel menu is open.

*One hook in the core.* `app-core.js`'s press handler asks `window.nsoWheelTakesPointer(event)`
(beside Brush, Pull, Limb and Foam), so a press on a handle does not also start the
piece-moving drag underneath it (which left a stray "Moved model" Undo entry behind). The wheel's
own `pointerdown` runs *after* the core's on that canvas, so the hook does its own hit test.

### The white edge

The selected piece wears a white edge (`app-sel-outline.js`). It used to come and go while
the sliders moved, for two reasons:

- **A commit threw it away.** The edge is a child of the piece's mesh; every release
  rebuilt the mesh and nothing redrew it until the piece was selected again. And while
  dragging, the preview swapped the geometry but left the old shape's edge hanging.
  Now the preview redraws it for the previewed shape (and restores the original's on
  Escape or release), the commit redraws it on the new mesh, Undo keeps it, and touching a
  slider selects the wheel's own piece so it is the one wearing it.
- **A smooth piece has no edge to draw.** The house rule is "an edge where two triangles
  meet at more than 15 degrees", and a thrown ball, a pressed disc or a rounded bowl has
  none. So the edge was on for a creased shape (a cavity floor, a rim) and absent for a
  smooth one, whatever the sliders did.

A revolved piece knows its own profile, so its helper is drawn from that
(`NSO_wheelGuideLines`, section 7h): rings at every crease of the profile and at both ends
of each wall, a few evenly spaced along the smooth stretches so a curve reads as a curve,
and eight meridian lines up the outside and down the inside. It reaches the house outline
through one optional hook — a geometry may carry `userData.nsoEdges(g)` returning its own
line segments (`NSO_wheelWear`) — so the cache, selection and Undo are the house path. The
lines are cheap (a few ms), so they are rebuilt on every frame of a drag. How many rings
and meridians is three constants (`NSO_WHEEL_GUIDE_*`).

## Direction

Agreed with the owner while this tool was being shaped. Not all of it is built;
this is the record of what was decided and the order it is going in.

**Pottery is the target.** Plates, bowls, vases, pitchers: everything starts from
a ball and is pressed, opened and pulled. The interaction is the one Tube Edge and
Pull already have — drag on the piece, see it live, release to Set, one Undo.

1. **Clay is conserved by Flatten, Open and Pull.** Flatten is done. Open must
   stop discarding the top half of the ball (today the rim lands at the equator
   and the clay above it is thrown away but still counted) and instead push the
   clay up and out so the rim rises and the wall thins; Pull must conserve instead
   of displacing radially against a ceiling. **Rim extension is the one move that
   adds clay; trim and crop are the only ones that remove it.** The ball's waste
   margin becomes a trim allowance. (Done in the recipe: press, **Open**
   (`NSO_wheelOpenKeep`) and Pull all conserve — see [The recipe](#the-recipe-and-the-live-sliders).
   The strict `NSO_wheelOpen` / `NSO_wheelPull` API still refuses whole and Open
   still throws the top away there.)
2. **Lip — done** (see [Lip](#lip)). Called **Lip**, not Lift, because Lift is taken by Crop.
3. **Foot ring, handles, long spouts are separate steps,** after the body. The foot
   ring is a Trim (`toR` already cuts a foot back); handles and spouts are not
   solids of revolution — a spout is a Pull on the baked mesh, where the section
   rule keeps the wall's thickness.
4. **The profile has to become a loop.** A plate's flat faces are horizontal, and a
   horizontal face has infinite slope in `r(z)`: a flattened disc already carries
   runs of samples sharing one `z`. `NSO_wheelPchip` divides by `dz`, and
   `NSO_wheelRadiusAt`, Open, Pull and Trim all assume `r` is single-valued in
   `z`. What is already general: the gate (`NSO_wheelDistToProfile`), the volume
   and the revolve (`NSO_Stock.revolve`) all work on any closed meridian loop. The
   change is one closed `(r, z)` loop with the moves written as displacements along
   the arclength or the surface normal.
5. **The session belongs to its piece — done.** It used to be a global that
   nothing reset: Undo stepped the mesh back but not the session, and selecting
   another piece and pressing a move baked the wheel's form onto *that* piece.
   Ball now drops a piece of its own (Stock's drop), `NSO_wheelHome` holds that
   piece's id and the history of `{ piece, soup }` the wheel wrote, and every move
   acts on that piece whatever is selected (and selects it). Undo puts the
   triangles back by reference, so an identity test on the soup says whether the
   piece is still what the wheel wrote: after an Undo the session **rewinds** to
   the matching step; if anything else changed the piece it **ends** ("Wheel stood
   down") rather than overwrite that work; if the piece is gone it says so. A
   refused Ball no longer leaves a session behind.
6. **Start from one standard ball.** Nobody should have to name the vessel before
   touching the clay. With no target height, Ball is the standard 25 mm ball; H
   (and R) are optional and size it from a finished vessel as before. Bigger
   pieces are made by adding clay — Rim +, and the add-clay lever still to come —
   not by guessing a size up front. (Several refusals already say "add clay
   here"; that move does not exist yet.)

Order: loop profile and the session shell (ghost, handle, Set / Cancel, one Undo
per gesture) → Flatten as a drag → Open as a clay-conserving drag → Pull as a
silhouette drag, refusing a no-op above the rim → Lip → rim flare and roll from
Tube Edge's curve.

## The live drag

`NSO_wheelPull(piece, { points })` takes the drag path, so the live half is a
pointer handler collecting `(z, r)` samples and calling it on every move. The
gate runs per frame, the refusal shows per frame, and the form is revolved to
a clean solid per frame — which is affordable precisely because the piece is
held as a profile and not as a mesh.

The shipped UI is the four buttons plus a height/Δr pair, deliberately: the
primitive underneath is proved in isolation first, the same way
`docs/EXTEND.md` argues for Extend's length box. Everything the drag needs is
already here and already exercised by the self-test.

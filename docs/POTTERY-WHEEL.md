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
ball  ->  press (Thick)  ->  open (Deep)  ->  pull (Pull at, Pull, Soft)  ->  trim  ->  rim +
```

Nothing is baked into the profile, so **nothing is ever shut off**. Dragging Thick
after the bowl is open re-presses the ball and opens it again on the new shape;
dragging Scale resizes the ball under everything else; take any slider back to neutral
and the earlier piece is back, exactly. The order you move them in does not matter —
the same recipe is the same piece (tested).

**A limit is a clamp, not a refusal.** A stage that cannot be done at the current
values does the most it can and says so in the read-out: Deep on a 3 mm disc, a Pull
that would take the wall under the nozzle floor, Rim + on a curved wall. The slider
stays live; the reason is on screen. Each slider's range follows what is upstream of
it (Deep's maximum depends on how far Thick has pressed) and comes out of the same
build pass. A Deep the shape cannot honour is remembered — drag Thick back up and it
takes effect.

| control | does |
|---|---|
| **Starter Ball** | drops the ball (standard 25 mm unless H / R say otherwise) as a piece of its own and starts a recipe on it |
| **Scale** | the size of the ball (its radius; the standard ball is 25 mm, shown as Ø50). Live at any time, under everything else. It replaced H and R: a target height (Pappus) is still `NSO_wheelBall({ height })` in the API, but the card has one size slider |
| **W** | the wall: how thin the disc may press and how thin the walls open. A thicker W opens a shorter, thicker-walled piece from the same clay |
| **Thick** | press: the top comes down, the diameter grows, the clay is conserved. All the way up is the unpressed ball |
| **Deep** | how far the finger goes in; the clay it pushes aside rises into the walls (`NSO_wheelOpenKeep`) |
| **Pull at / Pull / Soft** | where (a % of the height, so it follows the piece), how far out or in, how widely it spreads (a % of the height: small is a ring, large is a belly) |
| **Trim, Rim +** | take off the base (the clay is gone); add height at the rim (Extend — needs a straight wall) |
| **Flatten, Open** | one-click **presets**: they send their own slider to its far end. They bake nothing |

*Interaction.* Drag a slider: the piece itself changes, live, as a **preview** (the
placed mesh's geometry is swapped for a throwaway one, `m.rawTris` untouched, the Undo
stack does not move). Let go: **Set**, one Undo step — and the *recipe* stays
editable, so the next drag on any slider starts from the ball again. Escape puts the
preview away. Undo rewinds the recipe with the piece (the history holds
`{ recipe, piece, soup }`), and the sliders follow it back.

*There is nothing to type into.* Each slider is one row — its name (for Thick and Deep,
the Flatten / Open preset button), the track, and what it says — and the number is the
slider's own, through `app-live-slider.js`'s optional-box form (`bind` without `box`:
`value()` reads the slider; the read-out is the only text). The whole card is nine
sliders and three buttons, 316 px tall, so Gen+ fits the window without scrolling; it
was over 1100 px with number boxes.

*Conserving the clay.* Press, open and pull all keep the volume: press by solving the
rounded-slab family; **Open** by stretching everything above the cavity floor until
the volume is what it was (volume is linear in that stretch, so two evaluations find it
exactly; the base under the cavity is untouched); **Pull** by scaling heights about the
base by `V0/V1`. A pull that moves nothing refuses. Trim takes clay away and Rim + adds
it, and both say so.

*Which shapes come out.* With a 3 mm wall and the clay conserved, a cavity that spans
the whole disc leaves thin walls that stand tall: from the standard ball, Thick 30 +
Deep max is a Ø61 × 96 jar, Thick 12 is Ø87 × 54, **Thick 8 is Ø104 × 40 — a bowl**,
and Thick 3 is a Ø167 plate that cannot be opened. W is the lever for the rest.

*Strict API.* `NSO_wheelRun(move, …)` and the `NSO_wheelFlatten / Open / Pull / Trim /
ExtendRim` functions are unchanged and refuse whole when a stage cannot be done; a
strict move **bakes** — what it makes becomes the recipe's `base` and the sliders go to
neutral on top of it (`NSO_wheelRecipeOn`). The sliders never come through there
(`NSO_wheelSetRecipe`).

**What this does not do yet.** Dragging *on the piece* (silhouette handles) is the next
way in. A single Pull is still one bump, not several; two belly pulls need a second
control. Open's cavity is as wide as W allows, so a narrow mouth needs a "mouth"
control. The ghost the previous version drew for Pull is gone — the piece itself now
answers every slider — and is the right shape to bring back for dragging on the piece.

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
2. **Lip.** A flat disc's perimeter is lifted into a rim with a flared transition,
   the way a plate's is: flat out to a start radius, then the underside eases up
   (tangent at the start, so the flare is smooth) and holds an angle to the rim,
   which ends in a rounded bead. The section is swept along that curve, so the
   thickness is constant and the clay is conserved; the outer diameter shrinks a
   little (prototype: 143.3 → 142.3 mm for 14° over 30 mm on a 6 mm plate). Its
   handles are the start radius, the height (dragged) and the flare length. It is
   called **Lip**, not Lift — Lift is taken by Crop. A lipped disc is an opened
   vessel (outer = the underside, inner = the top face), so no new piece shape is
   needed. The flare is Tube Edge's Trumpet curve; `NSO_teProfile` already builds
   meridian curves and should be reused rather than copied.
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

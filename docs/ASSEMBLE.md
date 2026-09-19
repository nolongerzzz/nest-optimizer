# Attach — one generated piece, seated on another, joined into one solid

`nso_assemble.js` (`window.NSO_Assemble`, and a Node module) plus
`app-assemble.js` (the app layer: arm a click, convert it into the piece's own
raw frame, commit the union). Wired into `index.html` at a new `?v=asm1` tag —
the module after `nso_support_aim.js`, whose `nearestBase` and `place` it
calls, and the app layer after `app-stock.js`, whose control reader it uses.

```
node tools/nso_csg_node.js                   the shipped union, running under node
node tools/nso_assemble_test.js              headless: the case, the finding, the contracts
node tools/nso_assemble_canonical_check.js   canonical checker over every solid produced
node tools/nso_wire_assemble_test.js         the real app, real clicks, real undo
```

All four are in `npm test`.

## What it is

The ticket asked four things: prove that composed assembly modelling works
with the tools that already exist (§1), say honestly what does **not** compose
(§2), wire up the one working case if the answer turned out to be "something
is missing" (§5), and confirm explicitly that the result flows into the finish
tools (§4). The answer to the second was that something is missing, so there
is a module here as well as a report.

| you do | it works out |
|---|---|
| pick a shape and a size in the **Stock** card | the arm, sized by `nso_stock.js` exactly as **New stock** would size it |
| press **Attach** and click a point on a piece | the outward direction, from the raycast hit's own face normal |
| — | the real foot and whether the straight line out is clear, from `NSO_SupportAim.nearestBase` |
| — | **how deep the arm has to sit** for its whole base rim to bite — the missing piece |
| — | the turn, baked into the arm's triangles by `NSO_SupportAim.place` |
| — | one solid, by `app-join.js`'s `NSO_unionSoups` |

Nothing is left on the plate to tidy up: the clicked piece comes back carrying
the assembly, and one **Undo** puts it back value for value.

---

## 1. The smallest real case, end to end

`tools/nso_assemble_test.js` §1, all figures measured:

```
body   NSO_Stock.make({ shape:'box', height:40, radius:20, wall:3, waste:0 })
       -> 26.070 x 26.070 x 26.070 mm, 12 triangles, 17718.6 mm^3
arm    NSO_Stock.make({ shape:'cylinder', height:18, radius:5, wall:3,
                        waste:0, ratio:3, segments:48 })
       -> radius 4.227 mm x 25.359 mm tall, 192 triangles, 1423.1 mm^3
point  the middle of the body's +X face
```

```
seated 0.420 mm into the body (0.000 mm rim gap + 0.420 mm margin,
NSO_Thickness.floorFor), aimed along [1.0000, 0.0000, 0.0000], 90.00 deg turn
baked in, 25.359 mm of arm proud of the surface (length restored by Extend)
```

and through the shipped `NSO_unionSoups`:

| | |
|---|---|
| parts | **1** |
| triangles | 206 (105 welded vertices, 309 edges) |
| open / non-manifold edges | 0 / 0, by the kernel's own topology **and** by an independent edge count off the soup |
| signed volume | 19137.6639 mm³ against body + arm as built = 19137.6638 mm³ (4.5 × 10⁻⁷ % apart) |
| canonical checker | **PASS**, χ = 2, 0 degenerate, 0 piercing, 0 coplanar |

χ = 2 is the assertion the whole ticket turns on. A body and an arm merely
touching are two shells and χ = 4; one shell with no handles is one solid.

---

## 2. What does NOT compose — the finding

The ticket asked for this to be reported precisely rather than assumed. Five
things, in the order a person hits them.

### Finding 1 — `aim()` cannot aim anything but its own strut

`nso_support_aim.js`'s published composite call is `aim(point, bases, opts)`.
It builds its own solid: `buildStrut()` returns `prism(side, seed)`, a square
post, and there is **no `opts.soup`**. A caller holding a piece it wants
aimed — a Stock cylinder, a Stock box, an imported bit — cannot use `aim()` at
all. It has to drop to the two halves, `nearestBase()` and `place()`, and
write the sentence between them. There is nothing wrong with that module; it
is a support generator and it says so. But "auto-aim's output feeds directly
into a joinable pose" is **false** as it stands, and this is the first reason.

### Finding 2 — the engagement control is at the wrong end

`place(soup, from, dir)` maps the solid's local origin onto the base surface.
For a support that is right: a strut is meant to touch its target, not enter
it. `aim()`'s only engagement control, `tipEngageMm`, is at the **tip**. For
an assembly the overlap has to be at the **root**, and no root-side control
exists anywhere in that module.

### Finding 3 — so zero engagement is a coin flip, and curvature decides it

Measured with the naive composition written out in full — `nearestBase`, then
`place`, then the shipped `NSO_unionSoups`, no seat — on the same 8.453 mm
cylinder arm (`tools/nso_assemble_test.js` §2):

| body face | flush (engage 0) | seated |
|---|---|---|
| box, flat face, straight on | 1 part, PASS | 1 part |
| box, flat face, 30° oblique | 1 part, PASS | 1 part |
| cylinder, flat top | 1 part, PASS | 1 part |
| cylinder, **curved flank** | **2 parts — `"the two pieces do not touch"`** | 1 part |

The last row is the ticket. The arm's base cap is flat and the flank is not,
so the disc rests on one facet of the 96-gon and the rest of its rim floats
off the surface. The kernel is right to say the pieces do not touch. What is
wrong is *where the news arrives*: three calls downstream, out of
`NSO_unionSoups`, phrased as a Join failure — which reads like a bad aim and
is not one.

### Finding 4 — there is no outward normal at a picked point

`nearestBase` answers "given a point out in space, where is the foot and which
way". It cannot answer "given this point on the body, which way is out": its
`closestOnSoup` returns `{ point, distance }` with **no triangle index and no
normal**, and nothing in that module exposes one. So the natural UI
gesture — click the spot where the arm goes — has no direction to offer, and a
caller who invents one by guessing a target point out in space gets a foot
somewhere else.

The answer is not a second nearest-triangle search. The raycast that found the
point **already carries the normal**, as `hit.face.normal` in the piece's own
object space, so `attach()` takes the direction as an input and
`app-assemble.js` supplies it from the click. Auto-aim then does what it is
good at: it finds the real foot for that aim and refuses when the line out is
blocked. The two answers are **cross-checked** — `attach()` refuses when the
foot it finds and the point that was clicked are further apart than the arm is
wide, which is exactly the case where the click and the aim mean different
places (measured: clicking the back face while pointing forward puts them
26.070 mm apart, and it is refused rather than obeyed).

### Finding 5 — the rim-gap rule seats the whole rim, which near an edge is deep

`rootGapMm` is the distance from the body's surface to the furthest-out point
of the arm's base rim, and the seat is that plus one extrusion line. On a
rim that **overhangs an edge** of the body, the furthest-out point measures to
the edge rather than to the face, so the seat comes out deep: an arm aimed
30° up and out from a box face, whose foot lands near the top edge, reads a
3.871 mm rim gap and is seated 4.291 mm. That is the rule working — the whole
rim really is that far from the solid — but it is a *deep plug*, not a flush
joint, and the alternative (mitring the arm's base to the surface) is the
contact-geometry layer `nso_seat_surface.js` and `nso_support_aim.js` have
both already deferred. `opts.engageMm` overrides the measurement for a caller
who wants a shallower seat, and `seatedProud` then says in words that part of
the rim is still off the surface.

The same rule has one more consequence worth naming: `nearestBase` measures an
**unsigned** distance, so on a concave face — where a rim point can already be
inside the material — the gap reads as the distance back out to the skin and
the seat comes out deeper than it needed to be. Deeper is the safe direction,
it is bounded by the concavity's own depth, and `opts.engageMm` overrides it.
It is named rather than fixed with a sign test, because a signed query is a
second nearest-point implementation and this file exists not to have one.

### What DOES compose, with nothing in between

Worth stating, because the list above is all friction and the rest was clean:

- **Formats.** `NSO_Stock.make()` hands back a `Float32Array`, 9 floats per
  triangle, Z up, mm — the app's raw soup convention, which is what
  `nearestBase`, `place` and `NSO_unionSoups` all already take. There is no
  conversion anywhere in this feature.
- **Local frames.** `place()` needs the arm's attach axis on +Z with its base
  on z = 0. All three Stock shapes are generated that way, and so is
  `nso_support_aim.js`'s own `prism()`. It is *checked* rather than trusted —
  `baseOf()` measures where the placed base cap actually landed and refuses an
  arm modelled around its own centre by name — but nothing had to change for
  the two to fit.
- **Growth.** Extend lengthens the arm along +Z before the turn, on the same
  grow-then-turn order and for the same reason `nso_support_aim.js` states.
- **The floor.** `NSO_Thickness.floorFor` is the margin, the same one the aim
  module, `nso_skin.js` and `tools/mesh_validate.py` use.

---

## 3. The seat depth, measured

Both halves come from code that was already here:

```
rootGapMm  every base-rim point handed BACK to nearestBase against the body
           as a piece. Exactly one nearest-point-on-a-soup implementation is
           in play and it is nso_support_aim.js's - nothing here has a second.
marginMm   NSO_Thickness.floorFor(nozzle) - 0.42 mm at a 0.4 nozzle. A joint
           shallower than one extrusion line is a joint the slicer does not
           print. No literal, no default: without nso_thickness.js this file
           refuses, exactly as buildStrut() does, and the suite asserts that
           no 0.42 appears in the code outside the comments.
engageMm   rootGapMm + marginMm, unless the caller names one.
```

On the curved flank the measurement is checked against a closed form. A rim
corner on a **true** cylinder sits `sqrt(R² + r²)` from the axis, so the gap is
that minus `R`:

| | |
|---|---|
| measured, 49 rim points | **0.626106 mm** |
| closed form, true cylinder | 0.618651 mm |
| the difference | 0.007455 mm — the 96-gon inscribed in that cylinder |

The difference is named rather than absorbed into a tolerance, because a
tolerance that swallows a tessellation also swallows a bug.

`rootGapMm` is the root-side mirror of `aim()`'s `tipPenetrationMm`, and it is
reported for the reason that one is: a rim floating 0.02 mm off a face is
nothing and one floating 2 mm off is an arm glued to air, and nothing
downstream can tell those apart without the number.

## Sinking the arm shortens it, so Extend puts the length back

A Stock arm's length is not a reach — it is the answer to a material sizing.
Sink it by `engageMm` and the part you can see is `engageMm` shorter than the
figure the Stock card printed. So by default the arm is grown by exactly
`engageMm` first, along its own local +Z, by `NSO_extendRaw`, and the order is
`nso_support_aim.js`'s order for `nso_support_aim.js`'s reason: grow on a
cardinal axis, **then** turn. Nothing here reimplements a stretch.

Extend refuses a piece with no straight axis, and a Stock **sphere** is one.
That refusal is passed through in Extend's own words rather than worked
around — the seat still happens, `keptLength` is false, and the exposed length
is short by exactly the seat, which is a statement rather than a silent
difference:

```
the arm would not grow to cover the seat: no constant cross-section band along
z - 96 gap(s) examined, none clean; widest (0.2247 mm) failed because 192 of
192 straddling triangles are oblique ...
```

---

## 4. It flows into the finish tools with zero special-casing

The claim the ticket asked to be confirmed explicitly. Every row measured in
`tools/nso_assemble_test.js` §5, and every output re-checked by
`tools/nso_assemble_canonical_check.js`.

| tool | what happens | evidence |
|---|---|---|
| **Repair** (`NSO_Repair.commit`) | no-op **by identity** — the caller's own array comes back, `applied: false`, `"nothing to repair"`, `nonSolid: false` | the strongest form available: not "repair changed little", but "repair found nothing to do" |
| **the canonical checker** (`tools/mesh_validate.py`) | PASS on all nine solids the suite writes: 0 open, 0 non-manifold, 0 odd, 0 inconsistently wound, χ = 2, 0 degenerate, 0 self-intersections of either kind | `npm run assemble:canonical`, 94 gates |
| **Extend** | `NSO_extendDetectAxis` reads the assembly and calls the axis **x** — the arm's own axis — unprompted; `NSO_extendRaw` lengthens it 5 mm with the y and z bounds unmoved and **the same 206 triangles**, and the result is PASS | no argument anywhere says "this came out of a boolean" |
| **Fatten** | `NSO_fattenCrossSectionFaces` marks 104 movable / 102 held / 0 untrusted; Thicken's offset grows the cross-section 0.5 mm a side; Fatten's own length gate holds; x extent unmoved to the bit; result PASS | same two calls the Fatten button makes, in the same order |

One limit, named rather than swept up: Extend **across** the arm's axis (z) is
refused on this assembly — `"float32 shift collapsed 1 of 28 distinct layers
onto each other"`. That is Extend's own float32 layer gate reacting to a piece
carrying a 48-gon at one end, not a property of having come out of a boolean:
the plain Stock body box takes the same z stretch and passes. The suite asserts
both halves of that sentence, so a future change that makes the assembly
special will fail rather than rot.

### What the canonical check asserts that the aim module's deliberately did not

`docs/SUPPORT-AIM.md` states that a support and its piece are **not** gated as
one mesh, because they are two solids in contact and the checker rightly counts
the contact as piercing. Here they have been **unioned**, so the contact is
gone and 0 piercing is the only right answer. That difference is the ticket's
whole result, and it is what the canonical check gates on.

---

## 5. The UI thread

One button, **Attach**, in the Stock card beside **New stock**. Not a fourth
viewport menu and not a second set of size boxes: what the blank is gets said
in exactly one place, and `app-assemble.js` reads it through
`window.nsoStockReadUI()` — app-stock.js's own reader — so there is one
interpretation of those controls, not two.

Press it and it arms a click, on the same contract app-mask, app-carve and
app-seat-surface all have: `window.nsoAttachTakesClick(event)`, asked by
app-core's `onCanvasPointerDown` before it starts a move drag, and asked ahead
of Measure because it bakes. Arming disarms the other click-owning modes by
clicking their own buttons, so a mode is never left lit and dead.

Before this, the same result took: New stock, then pose the blank by hand with
the quantised 90°/15° buttons (which cannot express a free direction at all),
then Start Join, then two slot picks, then Complete Join — and got the seat
wrong on any curved face, silently, as finding 3 shows.

### Everything below the click happens in the piece's own raw soup

The way Thicken, Extend, Fatten and Hollow all work, so the result commits
through `NSO_sculptCommitRaw` with no pose arithmetic and the scene and the
file agree by construction. The click arrives in world space and is converted
once, through **app-mask.js's own** raw ↔ local mapping, now exported as
`nsoRawFrameOf` / `nsoRawPointFromLocal` / `nsoRawDirFromLocal` rather than
copied. That export is the point: this app already carried two copies of that
eight-line mapping (app-mask.js and app-brush.js) and a third is how they start
to disagree — the exact failure the "read the list, never re-derive it" rule in
`docs/HANDOFF.md` was written about.

### Undo

`attachReplace`, one row in app-core's `UNDO_REPLACE_LABEL`. The drive check
attaches, undoes, and compares the piece's raw soup **value for value** against
what it was before.

## PAINT SCOPE: WHOLE-PIECE

Per the scoping rule in `docs/HANDOFF.md`. The question is whether the feature
acts on an identifiable sub-region. It does not: the union hands back a wholly
new soup with its own triangles in its own order, and no face of the old piece
survives as itself — the face that was clicked least of all, since the arm is
cut into it. There is no sub-region to scope the check to, which makes
whole-piece the only coherent reading, exactly as it is for Fusion, Seat here,
Smooth and Thicken. `nsoMaskCount(m) > 0` is the whole test and any paint
anywhere stands it down, naming the count. The two categories are one rule at
different scopes, not inconsistent exceptions.

`nso_assemble.js` itself is **none**: it reads two soups and writes neither,
returning a new soup for the arm. The piece is only ever modified in the app
layer, which is where the check lives.

## The boolean, under node

`tools/nso_csg_node.js` splices app-join.js's own `NSO_CSG` adapter and
`NSO_unionSoups` (plus `NSO_manifoldStats`, `NSO_weldEpsFor`, `NSO_soupLen`,
`NSO_errMsg` and app-finish.js's `weldSoupVerts`) into a vm context and runs
them against `vendor/manifold/`. **Nothing is reimplemented**: a test that
retyped the union would only ever prove the copy right, and what matters is
that the solids above went through the same welds, the same pre-checks and the
same kernel call the Complete Join button makes. Two things are changed, both
of them the loader:

1. `NSO_CSG_URL` points at `vendor/manifold/` instead of jsDelivr, so the suite
   needs no network — the same single substitution `tools/csg_bench/run.js`
   already makes;
2. the context is compiled with `importModuleDynamically` set to node's default
   loader, so the adapter's own `import(NSO_CSG_URL)` resolves. The adapter's
   source is untouched; only the host's module hook is supplied.

If a function moves or is renamed it throws rather than quietly testing a stub,
the same contract `tools/nso_inside_corners_testlib.js` has. `npm run csg:node`
is a one-box self-check of the splice itself, and it is in `npm test` ahead of
the suites that depend on it so a broken splice fails on its own line.

## API

```js
NSO_Assemble.attach(bodySoup, armSoup, opts)  // the whole sentence
NSO_Assemble.rootGap(bodySoup, rimPoints, opts)
NSO_Assemble.baseOf(placedSoup, from, dir, opts)
NSO_Assemble.armSpan(soup)      // the arm's own +Z length
NSO_Assemble.armWidth(soup)     // its widest cross-section
NSO_Assemble.margin(opts)       // NSO_Thickness.floorFor, or a refusal
NSO_Assemble.describe(result)   // one status line
```

`attach` opts, in the two shapes a caller actually has:

| | |
|---|---|
| `target: [x,y,z]` | where the arm's free end should reach. The headless shape. |
| `at: [x,y,z]` + `dir: [x,y,z]` | the attachment point and the way out of it. The app's shape — a raycast hit carries both. |
| `engageMm` | override the measured seat depth |
| `marginMm` / `nozzle` | the margin on top of the measured gap |
| `keepLength` | grow the arm by `engageMm` first, default `true` |
| `footTolMm` | how far auto-aim's foot may sit from `at`; default half the arm's width |
| `obstacles` | soups the line must not cross; the body is added |
| `aim` / `extendRaw` / `thickness` | injectable dependencies, for tests |

The union is **the caller's**. `NSO_unionSoups` is async, loads a WASM kernel
and lives in a file that needs THREE; this module is THREE-free and
synchronous so it can be node-tested without a browser, so it returns the arm
seated and stops there.

## Out of scope for this first version, named

1. **More than one arm at a time.** One click, one blank, one union. A limb
   tree, a symmetric pair, a ring of six — all of those are a *layout*
   question, which is the same thing `docs/SUPPORT-AIM.md` put out of scope
   as "support density / layout". The primitive first.
2. **Mitring the arm's base to the surface.** See finding 5. Both
   `nso_seat_surface.js` and `nso_support_aim.js` deferred this same
   contact-geometry layer; it should be solved once, for all three, and
   `rootGapMm` is the measurement of what its absence costs.
3. **Subtract as well as add.** The same seat arithmetic aims a *pocket* as
   well as a boss, and `subtractSoupBFromA` is right there. It is not here
   because a pocket wants the opposite engagement sign and a wall-thickness
   check the boss does not, and shipping the two together would have hidden
   which gates belong to which.
4. **Attaching an existing piece rather than a generated one.** `attach()`
   takes any soup whose attach axis is +Z with its base on z = 0, so the
   module is ready; the app layer generates its arm because that is the
   guided flow the ticket asked for. Wiring Join's B slot into it is a small
   change and a separate decision about what happens to B on the plate.
5. **Curving or branching arms.** Out for the reason `docs/SUPPORT-AIM.md`
   gives: one straight direction, refused when blocked, never routed around.
   `nso_path_sweep.js` is the growth mechanism when that ticket comes.

# Hollow, Fill/Densify, and the live wall gate

Three connected pieces of work, all standing on the same foundation:
`nso_thickness.js`, the canonical wall-thickness / nozzle-safety check, and
`floorFor(nozzle)` - nozzle x 1.05, 0.42 mm at a 0.4 mm nozzle - as the only
source of the safe-wall number anywhere in any of them.

---

## 1. The audit that came first

### 1a. What `NSO_Thickness` exposed before this work

Verified against `nso_thickness.js` at the head of `claude-wip`, not from memory.

| call | what it answers |
| --- | --- |
| `floorFor(nozzle)` | mm, the safe floor for that nozzle |
| `measureMesh(rawTris, opts)` | 3D probe, whole mesh -> report |
| `measureRegion(rawTris, faces, opts)` | 3D probe, a named face subset |
| `cutClearance(rawTris, cutLo, cutHi, opts)` | what a PROPOSED cut leaves standing, per axis |
| `cutWarning(rep)` | the one wording for a cut's finding |
| `loopWallAt(loop2, i, opts)` | 2D probe, one point of a section |
| `cornerWall` / `bandWall` | the fillet clamp's two loop shapes |
| `measureLoop(loop2, opts)` | 2D probe, a whole section |
| `safeRadius(r, availableMM, opts)` | the fillet clamp plus the printability floor |
| `describe(rep)` | one status line |
| constants | `LINE_RATIO`, `NOZZLE_DEFAULT`, `PROBE_DEFAULT`, `WELD_TOL`, `LEGACY_FALLBACK_MM`, `LOOP_BAND`, `LOOP_CORNER` |

### 1b. Could any of it run live, per point or per stroke?

**No, and not for a fixable reason - for a structural one.**

Every 3D entry point takes a raw soup and starts by rebuilding two things from
scratch:

* `indexSoup()` - a welded rebuild of the whole soup, with a 27-cell neighbour
  scan per vertex;
* `buildGrid()` - a uniform hash over every triangle's bounding box.

On a piece of any size that IS the cost, and it is paid again on every call.
There was no persistent structure, no way to hand one back, and - separately -
no entry point that asks about a POINT at all. The closest thing,
`measureRegion(faces)`, still re-welds and re-grids the entire soup per call,
and still measures from face centroids rather than from a place the user
pointed at. Calling `measureMesh()` per `pointermove` would re-weld a
hundred-thousand-triangle piece sixty times a second.

So Task 3 needed a new public entry point, and it is a hoist rather than a
rewrite: `prepare(rawTris, opts)` pays the weld and the grid once and returns an
object whose queries are a DDA walk. The ray code, the vertex-sharing exclusion
rule and the threshold resolution are the SAME ones `measureMesh()` uses, which
is why `tools/nso_live_gate_test.js` part 1 can compare the two face for face
and get exact agreement on all 68 faces of `fixtures/box_open.stl`.

New on the module: `prepare()` (`.nearest`, `.wallAt`, `.hitsAlong`, `.inside`,
`.strokeGate`), `strokeRefusal(gate)`, `closestOnTri()`. Nothing was removed and
nothing changed meaning.

### 1c. Pottery Wheel's "Open": what generalises, and what does not

Both halves matter, so both are written down.

**The DEFINITION generalises completely, and it is taken verbatim.**
`NSO_wheelInnerAt`'s comment is explicit that the obvious implementation -
`inner = outer - wall`, a radial subtraction - is wrong, and wrong by a lot: it
leaves a *perpendicular* wall of `wall * cos(slope)`, so a sloped surface thins
exactly where a thrown pot is already weakest. It measured **1.31 mm of real
wall where 3.00 mm was asked for** on the default 3 mm open of a 30 mm ball - a
56% shortfall, going to zero at the base. The definition that is right is

> the cavity is the set of points at perpendicular distance > `wall` from the
> outer surface

which is an **erosion of the solid by a ball of radius `wall`**, and that phrase
is dimension-free. `nso_hollow.js` implements exactly that and nothing else.

**The MECHANISM does not generalise at all, and is not borrowed.** A thrown
piece is not a mesh: `app-wheel.js`'s own header says it "does NOT speak rawTris
on the way in" - it is held as a MERIDIAN PROFILE, `r` as a function of `z`,
revolved fresh on every update, precisely because that representation is what
makes the constraints cheap enough to run live. `NSO_wheelInnerAt` bisects along
a radial line in that half-plane and needs a single-valued `r(z)` and a known
axis. Its own "out of scope" list says what it cannot express: re-entrant forms,
asymmetric appendages, and **any imported mesh at all**, because finding the
axis an arbitrary piece wants to spin about is an unsolved problem there. A box,
a bracket, a scanned blob: Open cannot be pointed at any of them.

So the level set is computed on a field, not by bisection. What IS shared is
shared by calling: the floor, the weld tolerance, the triangle hash, the ray
code and the closest-point search are all `nso_thickness.js`'s. There is no
second spatial index and no second ray-triangle test in `nso_hollow.js`.

---

## 2. Hollow and Fill - `nso_hollow.js`

### Hollow

Five steps; only the middle two are interesting.

1. **Pick a grid.** Pitch is `wall / stepsPerWall` (3 by default), capped by a
   maximum grid dimension. The origin is nudged off any round fraction of the
   pitch: parity is decided by ray casts, and every fixture in this repo is
   axis-aligned, so an un-nudged grid would line up exactly with the faces of a
   box on every column.
2. **Mark the inside.** One ray per `(i,j)` column through
   `prepare().hitsAlong()`, parity along it. `hitsAlong` already merges
   coincident hits, which is what keeps a ray through a quad's shared diagonal
   from flipping parity twice.
3. **Distance to the surface.** An exact separable Euclidean distance transform
   (Felzenszwalb-Huttenlocher) first - exact for the node metric, where a
   chamfer mask is not and whose error is anisotropic, which on a box would put
   a different wall on the diagonal than on the face. The EDT measures to the
   nearest outside NODE, so it over-states the true distance by at most one node
   diagonal. That is fine everywhere except where it decides the answer, so
   every node within a diagonal of `wall` - **the band** - has its distance
   replaced by the true point-to-mesh distance from `prepare().nearest()`. The
   level set can only fall in the band, so the level set is built entirely from
   exact distances.
4. **Extract the level set** with surface nets: one vertex per sign-changing
   cell, one quad per sign-changing node edge. Chosen over marching cubes
   deliberately - watertight and manifold by construction, no 256-entry case
   table nobody in this repo can review, and vertices at the crossings rather
   than on them. The winding is derived per axis and then **checked against the
   signed volume**, because an inner shell must be wound inward.
5. **Staple it on.** The result is the input's own triangles plus the new inner
   shell, so the outer surface is untouched, byte for byte.

**The gate is on the RESULT, not only on the request.** Refusing a target under
the floor is necessary and is not sufficient: the cavity is a sampled level set,
so the wall it actually leaves can land under the wall asked for - measured on
`fixtures/box_hull_80x40x20-2.stl` at a 1.5 mm target, **1.414 mm**. At 1.5 mm
that is irrelevant; at a target near the floor it is the whole question. So the
result is measured with `measureRegion()` over the outer faces and a pass that
comes in thin is re-run at half the pitch before it is refused, with the number
it actually got in the refusal.

### Fill / Densify

**Topological, not a remesh, on purpose.** A solid is exactly a hollow piece
with its inner surfaces gone, so Fill finds the shells that bound enclosed
cavities and drops them, touching nothing else. The outer surface comes back
byte for byte and `fill(hollow(X))` is X's own soup - same triangles, same
order, same volume to 1e-6 - which is a test the suite runs on all four
fixtures, not a hope.

A cavity wall is identified by two things together, because neither alone is
enough:

* it is **wound inward** (negative signed volume);
* it **sits in material** (stepping off its surface the way its normals do not
  point lands inside the solid, sampled at up to nine faces).

A captive separate solid - a rattle's ball, a trapped bearing - is wound outward
and survives. A mis-wound outer shell fails the second test, is left alone, and
is reported rather than silently deleted.

### Hollow to safe minimum

The **thicken -> edit -> hollow back out** workflow. Thicken In put enough wall
under a feature for a cut to bite into; the edit is done; the wall should come
back down. *Back down to what* is the whole question, and "whatever it was
before" is the wrong answer whenever the piece was not printable before - which
is exactly why somebody reached for Thicken. Restoring a 0.30 mm wall because
0.30 mm is what it used to be hands back a piece the slicer will drop.

So `safeMinWall()` takes `max(what it was, what is safe)`. Both modes use the
same number; they differ only in what they do when it is under the floor:

* plain Hollow **refuses** - a user who typed 0.2 made a mistake and is told so;
* hollow-to-safe-minimum **clamps up** and says which of the two won.

A restore target that was already printable is honoured and never raised to some
house minimum.

---

## 3. The live wall gate - Carve and the Freehand Brush

**A second, independent layer, not a restatement of what shipped.**

The brush already had the area-weighted front-facing filter (`NSO_brushFacing`
on `NSO_brushVertexNormals`): a stamp's vertices are kept to the hemisphere the
stamp faces, so a dab on the near wall cannot reach round and drag the far
wall's vertices with it. That is the *"the stroke reaches the far face"* failure
and it is fixed.

It has no opinion whatsoever about a dab that only ever touches the near face
and still leaves 0.2 mm behind it. The far face never moved, so the filter never
had anything to say. And every check in `NSO_brushGate` is a TOPOLOGY check -
self-intersections, open edges, T-junctions, slivers, a volume budget - none of
which has any notion of how thick a wall is. **A 0.2 mm wall passes all of
them.**

`tools/nso_live_gate_test.js` part 4 demonstrates this rather than asserting it:
a 2.75 mm dab into a 3 mm shell, run through the brush's own pipeline, where the
front-facing filter holds (41 far-wall vertices, none moved) **and** the result
measures 0.393 mm and fails the canonical checker. One passing while the other
fails is the argument for having two.

### Where it fires

**Carve** (`app-carve.js`): once per click, before `NSO_CSG.load()` - so the
refusal lands before the kernel is loaded and before anything is committed. The
probe is built on the piece's own world soup, the depth is the blade depth.
`cutClearance()`'s warning is unchanged and still a warning: it asks whether the
cut SEVERS a member, which Local-Carve's corner gouge does on purpose. This one
asks what the cut LEAVES, and refuses.

**Brush** (`app-brush.js`, section 6c): three times, in the shape the paint
stand-down already uses.

1. **The first dab** - the stroke is refused outright, so nobody drags a groove
   they are not going to get.
2. **Every dab after it** - the dab is dropped and the stroke carries on, so a
   drag that travels onto a thin wall is stopped *at* the wall rather than
   through it, and the user can keep dragging somewhere it can be taken.
3. **At pointerup, against the RESULT** - overlapping dabs cut deeper than any
   one dab's arithmetic predicts, so this is not a restatement of layer 2.

The probe is built once at pointerdown and walked per dab, which is what
`prepare()` exists for.

Carve and Emboss and local Smooth: Emboss adds material and cannot thin a wall;
Smooth moves vertices along no fixed direction and has no cut depth to gate.
Both report that they are not gated rather than being waved through silently.

### The wording

One function, `NSO_Thickness.strokeRefusal(gate)`, so both tools say it
identically:

> Carve refused - wall too thin here, Thicken first: a 1.8 mm carve into a 2 mm
> wall leaves 0.2 mm, under the 0.42 mm floor for a 0.4 mm nozzle - piece
> unchanged

The lead phrase is fixed because it is the instruction. A user told only "too
thin" has to guess that the way out is Thicken.

### Unmeasured is not a pass in disguise

A face with nothing behind it within the probe is an unknown, and `measureMesh`
is right to count those as `sheets` rather than failures. But an unknown is only
safe to wave through when the probe itself already proves the answer, so
`strokeGate` widens the probe to `depth + floor + 1 mm` first. Past that
distance "nothing found" genuinely means "more than enough". A 39.9 mm cut into
a 40 mm block is refused; a 3 mm cut into it is allowed, and both are
measurements.

### One behaviour change to a shipped check

`tools/nso_wire_brush_test.js` section 10 drives a 5 mm brush into a 2.4 mm lid.
That stroke was already refused - but only at pointerup, by the
self-intersection count, with a status line reading `self-intersections rose
0->N`. That was a true statement about a symptom; the cause is that a 5 mm cut
into a 2.4 mm wall leaves nothing, and "self-intersections rose" gives the user
no way to know the answer is Thicken. The wall gate now catches it before the
first dab lands. The self-intersection gate is unchanged and still runs - it is
the third layer now rather than the first, and section 6 of that same check
still drives it.

---

## 4. Validation

| suite | `npm run` | what it holds |
| --- | --- | --- |
| `tools/nso_hollow_test.js` | `hollow` | 107 checks. Canonical checker before/after on four fixtures; the cube against an answer known by construction (16^3 = 4096 mm3); `fill(hollow(X))` byte for byte; the captive-solid case; the thicken/edit/hollow-back-out workflow end to end. |
| `tools/nso_live_gate_test.js` | `live:gate` | 54 checks. Live probe vs batch checker, face for face; refuse the thin stroke / allow the safe one, and both sides of the boundary; the unmeasured case; the independence demonstration; both wirings. |
| `tools/nso_wire_hollow_test.js` | `wire:hollow` | The three buttons in the real app in Chromium: click, commit, Undo, refusals, and the canonical checker run **in the page** on each result. |

Also extended: `tools/nso_carve_test.js` (section 2i3, the carve refusal through
the real app) and `tools/nso_wire_brush_test.js` (section 10, per above).

All three new suites are in `npm test`, which is the required status check.

### Results on the four fixtures, Hollow then Fill

| fixture | target | measured after Hollow | Fill round trip |
| --- | --- | --- | --- |
| `box-20mm.stl` (cube) | 2.0 mm | 2.000 mm | 12 tris, vol 8000 - exact |
| `fixture_sphere_curved.stl` | 1.5 mm | 1.500 mm | 2208 tris - exact |
| `fixture_blob_organic.stl` | 1.5 mm | 1.482 mm | 5120 tris - exact |
| `box_hull_80x40x20-2.stl` | 1.5 mm | 1.500 mm | 28 tris - exact |

The sphere is the case that would show a radial shrink: `wall * cos(slope)`
would read well under 1.5 mm somewhere on it, and it reads 1.500.

---

## 5. Limits, stated rather than implied

1. **`hollow()` samples a field.** The cavity surface is a level set on a grid,
   so it approximates the exact offset locus. The error is bounded by the pitch,
   the level set is built from exact distances (the band), and the result is
   measured against the floor before it is returned - but validate with
   `measureMesh()` if you want the proof, which is what the suite does.
2. **`hollow()` needs a closed solid.** Parity is the inside test and parity of
   a sheet is meaningless. An open piece is refused by name, not misread.
3. **`fill()` reads winding.** A cavity wall is a shell wound inward that sits
   in material. An inward-wound shell that is NOT inside material is left alone
   and reported.
4. **Hollow is whole-piece for paint scope.** A cavity is defined by the whole
   outer surface, so there is no painted sub-region that can be promised
   untouched. Any painted face stands both operations down, the same test and
   wording Thicken and Smooth use.
5. **A near-floor Hollow is expensive.** The pitch is `wall/3`, so a 0.42 mm
   wall on a 20 mm box is a 143^3 grid and about six seconds. That is the honest
   cost of a 0.42 mm shell, not a bug, but it is worth knowing before clicking.
6. **The gate is per point, not per volume.** `strokeGate` measures the wall at
   the place the tool is pointed. A blade whose footprint reaches a thinner spot
   a few millimetres away is `cutClearance()`'s question, and that one is still
   a warning. The two are complementary and neither subsumes the other.

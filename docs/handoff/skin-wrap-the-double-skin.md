## Skin wrap + the double skin (2026-09-16)
`nso_skin.js` (`applySkinWrap`, `opts.layer2`, and the seam fix the wrap
stands on), `app-skin.js` (`Skin wrap`, the layer-2 select, `Free`),
`app-nonsolid.js` (`opts.silent`), `app-core.js` (`pushUndo` snapshots the
non-solid flag), `index.html` / `styles.css` (the second skin row). Checks:
`npm run skin:wrap` (`tools/nso_skin_wrap_test.js`, 83 gates, every mesh
through `tools/mesh_validate.py`) and `npm run skin:wrap-drive`
(`tools/nso_skin_wrap_drive_check.js`, 38 gates through the shipped
controls), both in `npm test`.

**Audit first (Task 1), and what "wrap" turned out to mean.** Skin's scope
before this was exactly one face per press: `findFace` picks one coplanar
group, `rectFrame` requires its boundary to reduce to 4 corners at right
angles, and anything else is refused (`fixture_sphere_curved.stl` ->
`face is not a rectangle (3 corners)`). Nothing in the module iterated faces
and nothing handled a curved surface. **"Wrap" is not a new word in this
app**: Soften's `Full wrap` checkbox is "one click wraps all six faces of a
box. Off: one click bakes only the face you pick" (`index.html`,
`rawWrapSolid`, `wrapPocketsInPlace`), and the paint tooltip already says
faces are excluded "from Soften, wrap, Join and Skin". The ticket's own
example named a cylinder, so the two readings were put to the user rather
than guessed. **Answer: build the multi-face wrap now, write the curved one
up as the next ticket** - it was parked below and has since landed as
Texture.

**The defect the wrap stands on, found by measurement.** Skinning two faces
by calling the existing bake twice looked free, and was not. Two OPPOSITE
faces of `box-20mm` were always fine (no shared edge). Two ADJACENT faces
left **28 open edges, 28 non-manifold edges and 28 degenerate triangles** -
a closed piece turned into a broken one, silently, with Euler still 2. Two
independent causes, both fixed and both pinned by a gate:

1. *The seam's parameter epsilon was absolute.* `sideInsert` treated two
   params within `1e-9` as the same point. That held while a face was only
   ever skinned from exact corners; on a second face the soup it reads has
   been through `Float32Array`, so a param recomputed from a stored point
   differs from the exact one that placed it by ~1e-7 of the span. The same
   seam point then registered twice and the fan over it emitted a zero-length
   edge. The epsilon is now `tol / sideLength` - the same 1e-4 mm tolerance
   the rest of the seam uses, expressed in that side's parameter - and a
   chain collapses steps shorter than `tol`.
2. *The relief perimeter was never subdivided.* Wall triangles were re-fanned
   over the side's registered points; the relief's own perimeter was not, so
   where the second face's breaks did not land on the first's, every one was
   a T-junction. Invisible on a cube skinned with the same pattern twice
   (both faces break their shared edge at the same params - the "nothing
   inserted" gate), and **82 odd edges** with crosshatch on +Z and zigzag on
   +X. `fanRelief` runs the same pass over the relief: 25 triangles re-fanned
   on that pair, 115 on the hull with crosshatch on +Z and zigzag on +Y.

`fanTri` now handles a triangle with two or three split edges by splitting it
at its centroid first, so the corner cell where two skinned faces meet stays
paired. A triangle with no split edge keeps its old emission bit for bit,
which is why the whole existing single-face suite - including the
byte-identical sample STLs - passes untouched.

**What Skin wrap does.** `NSO_Skin.applySkinWrap(soup, opts)` takes
`faces: [{dir, plane?}] | 'box'` and skins them one after another on the
growing soup. Every face's plane is resolved UP FRONT on the original soup
and handed to each pick explicitly, so a pick can never drift onto something
an earlier face added. Refusal policy: strict by default - one refusal
returns the ORIGINAL soup with the reason and the face that gave it
(`the +Z face refused: face is not a rectangle (3 corners)`), never a
half-wrap. With `skipUnskinnable` (what the button passes) a face that has no
flat pick or is not a rectangle is left alone and NAMED, because the set the
wrap acts on is "the flat rectangular faces that are not painted out".

Measured, `box-20mm` wrapped crosshatch on all six faces: 25,308 triangles,
**0 open, 0 non-manifold, Euler 2, 0 piercing, 0 coplanar, 0 degenerate**,
volume 8,655.452 = cube + 6 x the single-face relief to 1e-3, bbox 21.2 on
every axis, contact 1,092.4 mm² (6 x 182.07). The hull
`box_hull_80x40x20-2` wraps 5 of 6 with the pocket face named and skipped
(`-X: face boundary is not a single loop`): 111,380 triangles, still one
closed shell. Recess wraps all six with the bbox unchanged. **PAINT SCOPE:
SUB-REGION, per face** - an excluded face is left alone and named, it does
not stand the wrap down; the SELECT target is a single-face idea and the
wrap says so when one is set.

**The double skin (Task 3), reported before it was built.** Applying two
skins in sequence is **not** achievable with this architecture, and the
refusal is the correct one rather than a gap: a skinned face is no longer a
face. `applySkinToFace` on its own output answers
`face boundary is not a single loop` - the tips are hundreds of separate rib
tops, not one rectangle - and naming the tips plane explicitly does not help.
Both are gates now. Two ways round it were put to the user, and **both were
built**:

- **Path A, composed (the default).** Two patterns in ONE pass over one
  merged grid, layer 2 riding on layer 1's tips:
  `h = h1 + (cell is a layer-1 tip ? h2 : 0)`. Composition happens in the
  height field, where both patterns are still plans. The result is **one
  closed shell** - Euler 2, 0 piercing - so nothing about the piece's closure
  changes and **no flag is involved**. Volume checks analytically for two
  flat-prism layers (cube + layer1 x h1 + composite x h2, 1e-3). Grid
  patterns only: `ring` builds its own surface and has no height field to
  compose, which is a named refusal pointing at the free layer instead.
  Raise only.
  *Honest limit, stated as a gate rather than left to be discovered:* the
  composite contact is the INTERSECTION of the two tip sets, so how much it
  shrinks is the second pattern's business. crosshatch + zigzag: 182.07 ->
  **52.41 mm² (28.8%)**. zigzag + zigzag: 53.76 -> 16.64 (31.0%). crosshatch
  + crosshatch at the stated layer-2 default: 152.08 (83.5%) - a crosshatch
  layer 2 mostly makes the relief taller, because its tips are the union of
  two rib directions and cover most of the face. Layer 2 at layer 1's OWN
  parameters lands exactly on layer 1's features and leaves the contact
  **bit for bit where it was** (182.07 -> 182.07). So the result carries
  `layer1TipArea` next to `tipArea` and the status line prints both:
  `contact 52.4mm² (layer 1 alone: 182.1mm²)`.
- **Path B, free (behind the `Free` checkbox).** Layer 2 as its OWN shell: a
  sheet resting on layer 1's tips carrying its own relief on top, a second
  breakaway interface, built as a slab and skinned through this same engine.
  The piece then carries two shells, **so the bake sets the non-solid flag on
  it** - the ticket's hypothesis, and it holds: this is the flag's own case
  (docs/NON-SOLID.md), a deliberate declaration that the piece is not meant
  to be a closed solid, made by the user asking for a free layer rather than
  inferred from the mesh. Measured on the cube: 7,720 triangles, 0 open, 0
  non-manifold, **Euler 4**, exactly two edge-connected shells, each closed
  and 0-piercing on its own, the sheet's underside equal to layer 1's tips
  **bit for bit** (zero penetration), volume = the skinned piece + the sheet
  + the sheet's relief to 1e-3. Control: `gap 0.3` -> 0 piercing, 0 coplanar,
  shells 0.300 apart. As with the Seat-gap and skin samples, gap 0 reads as
  piercing pairs in the checker because rib walls stand edge-on in the
  sheet's plane and it has no touching-along-an-edge class; the gap control
  and the exact equality are what separate touching from penetration.
  The sheet is inset to layer 1's margin by default, which is where layer 1's
  features stop anyway - and, found the hard way, keeps its side walls out of
  the piece's own face planes: flush with them they join those faces'
  coplanar groups and the next face pick sees two loops where it needs one.
  *Stated, not measured:* the sheet bridges from tip to tip, so its first
  layer prints over air.

**Undo carries the flag.** `pushUndo` (app-core.js) already snapshotted the
paint so a mesh swap and the paint on it are one step; it now snapshots
`nonSolid` for the same reason, and the geometry-replace branch puts it back.
One Undo after a free-layer skin returns the 12-triangle cube AND clears the
flag, checkbox and list tag together - a gate in the drive check.
`nsoNonSolidSet` gained `opts.silent` so the flag does not overwrite the
status line of the bake that set it; without it the skin's own line was wiped
and only "Flagged non-solid" remained.

**Reachability (audited 2026-09-16).** `index.html` carries `#btn-skin-wrap`,
`#skin-layer2` (off / zigzag / crosshatch / ring) and `#chk-skin-free` in a
second `.vp-row-skin` row in the **Finish tab**, under the existing Skin face
row; the script tags are bumped to `?v=skin2`. The drive check asserts all
three are in `.vp-finish`, that the wrap button carries its listener, and
that `NSO_Skin.applySkinWrap` and `NSO_skinWrapModel` are loaded.

**Drive check** (`npm run skin:wrap-drive`, in `npm test`): `box-20mm`
through the file input, the piece picked by clicking its list row, then -
Skin wrap -> `Wrapped 6 faces (+Z, -Z, +X, -X, +Y, -Y) ... contact 1092.4mm²
over all of them, 25308 tris`, scene 21.2 on every axis; Export plate (STL)
-> the browser's own download through `mesh_validate.py`: one edge-connected
shell, 0 open, 0 non-manifold, Euler 2, 0 piercing, 0 coplanar, 0 degenerate,
bbox 21.2³, 25,308 triangles. Undo -> 12 triangles. A painted +Z (set with
the app's own paint primitive - there is no button for a face click, and the
step is labelled as such) -> `Wrapped 5 faces (-Z, +X, -X, +Y, -Y) ... - left
painted: +Z`, the piece 20.6 tall in z and 21.2 in x and y, export still one
closed shell. layer 2 = zigzag, Skin face -> the status carries both contact
numbers, the piece is 20.9 tall, export one shell Euler 2. Free on -> status
names the free layer and the flag, checkbox and list tag both on, export: two
shells, Euler 4, the sheet resting on the tips to 1e-6, piece 20.6 tall and
the free layer 1.2. One Undo -> geometry and flag back together. No page
errors. `APP_URL=<site>` points the same check at a deployment.

### The OTHER wrap - Texture, a conformal skin on a curved face (LANDED 2026-09-18)
Was parked here as the follow-up when "wrap" was clarified. Built. Full
write-up with every number: `docs/CURVED-SKIN.md`. Files: `nso_skin_band.js`
and `app-texture.js` (both new), `index.html` / `styles.css` (a fourth
`.vp-row-skin` row in the Finish tab plus its two numbers), `app-core.js` (one
undo label), `tools/nso_texture_fixtures.js` and three committed cylinders.
Check: `npm run texture:test` (`tools/nso_texture_test.js`), in `npm test`.
`?v=` NOT bumped - the two new script tags ride the existing `?v=skin2`.

**Audit first (Task 1), and all three blockers were real.** The parked note
named plane-exact grouping, the rectangle requirement and single-normal
lifting. Each is demonstrated in part 1 of the suite rather than asserted:

- `findFace` on the cylinder's side returns **2 triangles, 29.44 mm² of 1885**
  - one facet of 64. "The side" is not a face that finder can name.
- the rectangle rule is **worse than a refusal**, and this is the one thing
  the parked note understated: a facet IS a rectangle. At the default pattern
  `applySkinToFace` refuses the cylinder for being too NARROW (`face too small
  for the crosshatch`), not for being curved - and at a fine enough pattern it
  **succeeds**, skinning one stripe of sixty-four (15.04 mm² of 1885). Silent,
  plausible, wrong. A user would have had to count ribs to notice.
- a relief lifted along one constant `N` reaches **20.6 mm** from the axis on
  the far side of an R 10 cylinder. The built article reaches **10.600000**,
  gated.

**Scope (Task 2): one curved primitive, a cylinder.** Not an arbitrary
developable band and not free-form. The axis is FITTED (area-weighted normal
covariance, all three eigenvectors tried), so a cylinder tipped 30°/20° and
moved anywhere is the same band - gated, r and D to 2e-3. Refused and named:
a sphere and the organic blob (`not a cylinder about this axis - the rim
points are off a circle by 2.39 / 4.33 mm`), a side tessellated into more than
one ring up the axis, and anything under 12 facets around. That floor is a
real boundary, not neatness: **a 20 mm cube passes every other test** about a
face axis, because its eight corners genuinely do lie on a cylinder of radius
r√2. Below it the refusal points at the engine that does cover the shape -
`a 4-sided prism, not a cylinder - its sides are flat rectangular faces, which
Skin wrap already covers one face at a time`. `fixtures/prism_r10h30_s8.stl`
is committed as that case. Raise only, and it says why.

**What was built (Task 3).** `NSO_Skin.patternPlan` is reused **unchanged**,
on a `planeFrame` whose W is the circumference and whose D is the axial
length - the rib intervals were always a 1D problem per axis. Two adapters
sit between it and the band, and they are the only places this touches the
pattern:

1. **The seam is not a margin.** A band has no edges in u, so a margin there
   is a bald stripe - the opposite of a wrap. The plan is built with
   `margin: 0` and the pitch is SNAPPED to an exact divisor of the
   circumference (`k = round(C / pitch)`, `pitch = C / k`). `ribIntervals`
   then leaves exactly half a gap at each end, so the wrap-around gap is one
   full `pitch - rib` and the layout is periodic. The snap is reported and the
   status line says it: 1.2 → 1.208305 mm over 52 repeats.
2. **The axial margin is the band engine's own**, as two rim rows at height 0.
   That is what keeps the relief's perimeter on the ORIGINAL rim loops, which
   is what lets the caps stay where they are.

`bandRelief` is `gridRelief` with two changes and nothing else: u wraps (node
column `nu` IS column 0 - no seam column, no duplicated ring), and every lift
takes the node's OWN radial normal, with a normal at each end of a wall. The
base is the original faceted surface, not an idealised cylinder, and
`breaksU` is merged with the band's facet angles so no rim vertex is skipped.
Cap triangles that own a piece of a rim are re-fanned (`fanCapTri`, which is
`fanTri` for a closed polyline).

**Validation (Task 5), all of it on a real exported binary STL read back off
disk and judged by `tools/mesh_validate.py`:**

- `cylinder_r10h30_s64` + crosshatch: **30,912 tris, 0 open, 0 non-manifold,
  0 odd, 0 inconsistent winding, Euler 2, 0 piercing, 0 coplanar, 0
  degenerate**, one edge-connected shell. Axial extent 30.00000 unchanged,
  radial 21.200001 = 2(R + depth), cap area unchanged to 1.6e-6 mm².
- **Conformal, measured:** every one of 54,720 tip vertices stands
  **0.6000000 mm off the ORIGINAL surface** (the inscribed prism, derived by
  the test, not asked of the engine) - worst error **4.6e-7 mm**. Max radius
  anywhere 10.600000 where a single-normal lift reads 20.6; min radius on the
  side 9.987977, the prism's own apothem, so the piece under the skin is
  untouched. 3,904 tip triangles straddle a facet edge - it is one surface
  over the band, not a tile per facet.
- **The wrap closes:** 104 rib-side walls for 52 repeats, every boundary one
  pitch from its partner **including across the seam** (worst 5.1e-7 rad),
  arc pitch on the file 1.208305 mm to 2.1e-9. The repeat count comes from
  the ARC (52); a planar diameter reading would have given 17, which is the
  failure mode the parked note said to look for.
- **Contact area, the number that is easy to get wrong:** measured
  **1057.882588 mm²** against a closed form of 1057.882648. The flat
  (unrolled) reading - exactly what the existing engine's `tipArea` would
  say - is **998.40, 6.0% low**, and the status line prints both:
  `contact 1058.3mm² on the curve (998.4mm² unrolled)`.
- **Volume:** +616.4094 mm³ against the curved closed form 617.0128 (0.098%);
  the FLAT form 599.0415 is 2.90% out, thirty times further. The curvature
  term is `m2 / 2r` with `m1 = ∫h`, `m2 = ∫h²`, both by 2×2 Gauss - not
  `area·h·(1 + h/2r)`, which overstates a sawtooth threefold. The 0.098%
  residual is the inscribed prism, and it is gated by refinement rather than
  argument: crosshatch 0.161 → 0.049 → 0.015 → 0.004% and zigzag 0.951 →
  0.704 → 0.398 → 0.135% over 48/96/192/384 facets.
- zigzag and a second cylinder (r 6 × 12, 96 facets) carry the same gates.

**Paint: SUB-REGION, the curved band.** A click on a cylinder's side records
ONE facet's plane, so the check is `nsoMaskIsExcludedRaw(m, face.n, face.d)`
over the band's distinct facet planes - mask6's own answer, per facet, never a
second mapping. ANY painted facet stands the whole bake down, because the
relief is periodic around the full circumference and the engine has no
per-facet height; skipping a painted facet would leave a bald stripe, which is
a different feature. A painted CAP does **not** stand it down - the caps keep
their planes and boundary loops and only get re-fanned, the same thing
`applySkinToFace` already does to the walls beside a skinned face. All three
behaviours are gated headlessly against a stubbed `nsoMaskIsExcludedRaw`.

**The name.** The button is **Texture**, deliberately not a third "wrap".
Soften's `Full wrap` checkbox is edge treatment on a box and is untouched;
`Skin wrap` is flat rectangular faces one at a time and still refuses a
cylinder. The suite gates that `#chk-full-wrap` is still there and still says
"Full wrap", and that nothing in the UI calls Texture a wrap.

**One defect found and fixed on the way** (in the new file, not the old one):
`wallBetween`'s quad emission assumes both ends of a wall have height. A
sawtooth flank starts at zero on every ridge, so one end is a POINT, and
emitting a quad there puts a zero-area triangle in the soup and uses one of
its edges three times - **124 odd and 124 non-manifold edges** on the zigzag
band, measured, until `wallBetween2` learned to emit a triangle. The flat
`gridRelief` reaches the equivalent branch 32 times on a 20 mm cube and comes
out clean, so this is not a report against `nso_skin.js`.

**Seat against a curved contact is OUT OF SCOPE (Task 4)** and is its own
ticket, dispatched separately. Nothing here answers it and nothing here calls
into it - gated: neither new file calls `supportExtreme`, `tipContactArea` or
any Seat entry point. The `tipArea` this bake reports is the tip-surface area,
not a promise that Seat can land a part on it.

That separate ticket has since **LANDED** - see "Seat here" below and
`docs/SEAT-SURFACE.md`. It took the second of the two options the parked note
put: Seat grew a second mode rather than the geometry staying on its own. It
is a NEW module and a NEW button; `NSO_seatFlushBitToHull` is byte-identical
and nothing above changed, so the gate in this paragraph still holds as
written and still should.

**Still open after this, each its own question** (in `docs/CURVED-SKIN.md` §9):
a second layer (composed would drop in; a free layer needs `freeLayerShell`
rewritten as a cylindrical shell), a cone or a torus, and several bands on one
piece - `findBand` reads the whole soup as one cylinder by design.

**Drive check** (`npm run texture:drive`, `tools/nso_texture_drive_check.js`,
in `npm test`): the same standard as `skin:wrap-drive`. The cylinder fixture
through the browser's own file input, the piece picked by clicking its list
row, then - Texture -> `Textured the curved side - crosshatch lattice ... 52
repeats around at 1.208 mm arc pitch, tips +0.60mm (pitch snapped 1.20 →
1.208mm so the wrap closes), contact 1058.3mm² on the curve (998.4mm²
unrolled), 30912 tris - caps untouched`, the scene 21.2 across where it was 20
and still 30 long. Export plate (STL) -> the browser's download through
`mesh_validate.py`: one edge-connected shell, 0 open, 0 non-manifold, 0 odd, 0
inconsistent winding, Euler 2, 0 piercing, 0 coplanar, 0 degenerate, 30,912
triangles, bbox 21.2 x 21.2 x 30 with the axial extent bit for bit what it was
before the bake.

**The engine suite's headline numbers are then re-measured on those downloaded
bytes**, against a band fitted to the plain cylinder exported from the same
session - so they are taken in the exported frame, not the builder's. Every one
of 54,720 tips stands **0.6 mm off the ORIGINAL curved surface to 4.5e-7 mm**;
max radius 10.60000 where a single-normal lift would read 20.6; the floor
between the ribs is still 9.98798, the prism's own apothem; and the contact
measures **1057.8826 mm²**, the engine suite's number to the fourth decimal.
That is the gate that says the button bakes and exports what the engine
proves, rather than something that merely looks similar.

Also driven: Undo -> 256 triangles and `Undo: Texture reverted`. A painted
SIDE facet (set with the app's own paint primitive - there is no button for a
face click, and the step is labelled as such) -> `Texture stood down - 1
painted facet(s) ...`, piece untouched at 256 triangles. A painted CAP instead
-> it textures anyway, with the paint still on the piece, which is the
sub-region rule driven through the shipped button rather than asserted in a
unit test. zigzag -> 1,900 triangles and one closed shell on export. The prism
fixture -> `Texture refused - ... an 8-sided prism, not a cylinder ... which
Skin wrap already covers one face at a time`, 32 triangles untouched. No page
errors. `APP_URL=<site>` points the same check at a deployment.

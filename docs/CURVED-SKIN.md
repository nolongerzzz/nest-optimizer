# Texture — a conformal skin on a curved face (the "OTHER wrap", landed)

`nso_skin_band.js` (new: the band finder, the band relief, the measurement),
`app-texture.js` (new: the **Texture** button and its paint scope),
`index.html` / `styles.css` (a fourth `.vp-row-skin` row in the Finish tab plus
its numbers), `app-core.js` (one undo label),
`tools/nso_texture_fixtures.js` + `fixtures/cylinder_r10h30_s64.stl`,
`fixtures/cylinder_r6h12_s96.stl`, `fixtures/prism_r10h30_s8.stl`.
Checks: `npm run texture:test` (`tools/nso_texture_test.js`, the engine) and
`npm run texture:drive` (`tools/nso_texture_drive_check.js`, the button in real
Chromium), both in `npm test`.

This is the ticket `docs/HANDOFF.md` parked as **"the OTHER wrap: a skin on a
curved face"**, built to the shape that audit laid out. Read that section
first — this file says what was built, what it measures, and what it costs.

---

## 1. Audit first — the three blockers were all real

The parked ticket named three, and none of them turned out to be a missing
parameter or a tolerance that could be loosened. The suite demonstrates each
rather than asserting it (`npm run texture:test`, part 1):

| blocker | what it does | measured on `cylinder_r10h30_s64.stl` |
|---|---|---|
| **plane-exact grouping** | `NSO_Skin.findFace` groups triangles by exact plane (`\|g.d - off\| < 1e-4`, parallel normals) | the "face" it returns on the side is **2 triangles**, 29.44 mm² — one facet of 64, not the surface |
| **the rectangle requirement** | `rectFrame` needs a boundary that reduces to 4 corners at right angles | worse than a refusal: a facet *is* a rectangle. At the default pattern `applySkinToFace` refuses the cylinder for being too **narrow** (`face too small for the crosshatch`), and at a fine enough pattern it **succeeds** — on one stripe, 15.04 mm² of 1885. Silent, plausible and wrong. `fixture_sphere_curved.stl` is still `face is not a rectangle (3 corners)` |
| **single-normal lifting** | `gridRelief` lifts every node along one constant `N`, and `wallBetween` takes the same constant | a relief built that way reaches **20.6 mm** from the axis on the far side of an R 10 cylinder. The built article reaches **10.600000**, and part 4 gates exactly that |

Those refusals are correct and they stay. A sphere is doubly curved, has no
single axis, and is refused by the new engine too — by name, not by accident.

## 2. Scope — one curved primitive, stated up front

**A cylinder.** Not an arbitrary developable band and not a free-form surface.
Concretely, `NSO_SkinBand.findBand` accepts a soup only when:

- every facet normal is either along one axis (the caps) or across it (the
  side) — the axis is **fitted**, from the area-weighted normal covariance, so
  a cylinder lying on its side or tipped at 30°/20° and moved anywhere is the
  same band (gated);
- every side vertex is on one circle about that axis, to 1e-3 mm;
- the side is **one ring** of facets between the two rims. A side tessellated
  into several rings up the axis is refused and named — the rim bookkeeping
  below assumes the band's only vertices are its two rims;
- there are **12 or more** facets around.

That last one is a real boundary, not neatness. A 20 mm cube passes every
other test about a face axis — its eight corners genuinely do lie on a
cylinder of radius r√2 — so the facet floor is what separates the two engines.
Below it the refusal says so and points at the one that does cover the shape:

```
a 4-sided prism, not a cylinder - its sides are flat rectangular faces,
which Skin wrap already covers one face at a time
```

`fixtures/prism_r10h30_s8.stl` is committed as that case.

Also stated, and gated: **raise only**. Recess cuts valleys into a face and
needs a rim at the original surface for them to stop at; a band has no rim in
the wrap direction, and inventing one is the bald stripe §4 exists to avoid.

## 3. What was built

`NSO_Skin.patternPlan` is called **unchanged**, on a frame from
`NSO_Skin.planeFrame` whose `W` is the band's circumference and whose `D` is
its axial length. The rib intervals were always a 1D problem per axis, so a
plan built over an unrolled band is the same plan. Two adapters sit between
that plan and the band, and they are the only places this work touches the
pattern:

**(a) The seam is not a margin.** A flat face keeps the pattern off all four
edges with `margin`. A band has no edges in `u` — it closes on itself — so a
margin there would be a bald stripe down the cylinder, which is the opposite
of a wrap. The plan is therefore always built with `margin: 0`, and the
circumferential pitch is **snapped to an exact divisor of the circumference**:
`k = round(C / pitch)`, `pitch = C / k`. With margin 0, `ribIntervals` centres
`k` ribs in `C` and leaves exactly half a gap at each end, so the wrap-around
gap is one full `pitch - rib` and the layout is periodic. The snap is
reported (`pitchAsked` / `pitch`) and the status line says it — 1.2 → 1.208305
mm over 52 repeats on the shipped fixture. A pattern that does not divide the
circumference cannot close, and rounding it quietly would put a seam defect
exactly where the ticket asked for a wrap.

**(b) The axial margin is this work's own.** The plan is built on a frame of
height `D - 2·margin` and shifted up by `margin`, with two rim rows at height
0 added at `v ∈ [0, margin]` and `[D - margin, D]`. That is what keeps the
relief's perimeter **on the original rim loops**, which is what lets the caps
stay exactly where they are.

Below that, `bandRelief` is `gridRelief` with two changes and nothing else:

- **`u` wraps.** Node column `nu` *is* node column 0. There is no seam column
  and no duplicated vertex ring.
- **Per-node normals.** Every lift takes the radial direction at that node's
  own angle, and a wall takes a normal at each end. This is the whole of
  "conformal": at `h = 0` the surface is the original facets bit for bit, and
  above it every point moves straight out from the axis.

The base of the relief is the **original faceted surface**, not an idealised
cylinder: a node at angle θ sits on the chord of the facet containing θ,
interpolated between the two real mesh vertices. `breaksU` is merged with the
band's own facet angles before anything is built, so every node column lands
on or inside one facet and no original rim vertex is skipped. Every `u` break
the relief introduces is registered on both rims, and every cap triangle that
owns a piece of a rim is re-emitted as a fan over the rim's registered points
— `fanCapTri`, which is `fanTri` for a closed polyline.

**One defect found and fixed on the way.** `wallBetween`'s quad emission
assumes both ends of a wall have height. A sawtooth flank starts at zero on
every ridge, so one end of that wall is a *point*, and emitting it as a quad
anyway puts a zero-area triangle in the soup and uses one of its edges three
times: **124 odd and 124 non-manifold edges** on the zigzag band, measured,
before `wallBetween2` learned to emit a triangle there. The same shape of
call happens inside its own sign-crossing split, which always produces a wall
whose far end is a point. The flat `gridRelief` reaches the equivalent branch
32 times on a 20 mm cube and comes out clean — `npm run skin:test` and
`fixture_audit` both agree — so this is not a report against that file.

## 4. Conformal, measured — not asserted

The headline gate, on the exported STL (part 4):

> **every tip stands 0.6000000 mm off the ORIGINAL surface, all the way round**
> — worst error **4.6e-7 mm** over 54,720 tip vertices.

"The original surface" here is the inscribed prism the mesh actually has, not
the circle it approximates, and the test derives that chord radius for itself
rather than asking the engine. Alongside it:

| | measured | means |
|---|---|---|
| max radius anywhere | **10.600000** (= R + depth) | nothing stands off the surface further than the relief is tall. A single-normal lift would read 20.6 |
| min radius on the side | **9.987977** | the floor between the ribs is still the prism's apothem (9.987955), not R — the piece under the skin is untouched |
| tip triangles straddling a facet edge | **3,904** | the pattern is one surface over the band. A flat tile per facet would have none |
| cap area | unchanged to 1e-3 mm² | the caps were re-fanned, not rebuilt |
| axial extent | 30.00000, unchanged | the cap planes did not move |

## 5. The wrap closes

Read straight off the exported file, with nothing from the plan: a rib's side
is a wall at constant angle spanning base to tip, and those exist at the rib
boundaries and nowhere else (a grid line merged in from the band's own facets
has the same height either side, so no wall is emitted there).

- **104 wall angles** for 52 repeats — two per rib, and no more.
- Every rib boundary has its partner exactly one pitch round, **including
  across the seam**: worst error 5.1e-7 rad.
- The pitch measured as **arc length** on the file is 1.208305 mm, the snapped
  value, to 2.1e-9 mm — inside the 1e-3 the audit asked for.
- The repeat count comes from the **arc** circumference (52). A planar reading
  of "how wide is this thing" — the diameter — would give 17. That is the
  failure mode the audit named, and it is gated by number rather than by
  inspection.

## 6. Contact area on a curved face — the number that is easy to get wrong

A flat skin's contact is the plan area of its tip cells, because the tips are
a translate of the base. On a cylinder they are not: a tip cell `du × dv` on
the base is `du·(r + h)/r × dv` once lifted `h` clear of a radius-`r` surface.
Three numbers come back on the result:

| | shipped fixture | what it is |
|---|---|---|
| `tipArea` | **1058.31 mm²** | the real contact, on the tip surface. **This is what a caller quotes**, and what the status line prints |
| `tipAreaFaceted` | 1057.88 mm² | the same cells as the mesh really carries them, on chords rather than arcs — the closed form for what summing the exported triangles gives |
| `tipAreaUnrolled` | **998.40 mm²** | the same cells on the unrolled band. Exactly what the existing flat engine's `tipArea` would have said, and **6.0% (59.9 mm²) low** |

Measured on the exported STL: **1057.882588** against a closed form of
**1057.882648** — 5.9e-5 mm². The ratio `tipArea / tipAreaUnrolled` is
1.060000 against `(R + depth)/R = 1.06` to 1e-10.

The status line prints both, for the same reason the double skin prints both
its numbers: `contact 1058.3mm² on the curve (998.4mm² unrolled)`. "The flat
number is close enough" is exactly the assumption that makes a breakaway
interface print solid.

Volume carries the same curvature term. Integrating a radial offset `h` over
an arc gives `(r·h + h²/2) dθ dv`, so in unrolled coordinates the relief is

```
V = m1 + m2 / (2r)        m1 = ∫h du dv,  m2 = ∫h² du dv
```

and `m1` alone is what a flat engine would predict. For a flat-topped pattern
that collapses to the familiar `area · h · (1 + h/(2r))`; for the zigzag it
does **not**, because most of a sawtooth is shorter than its crest — using
`hmax` there overstates the curvature term threefold. Both moments are
integrated with 2×2 Gauss-Legendre, which is exact for a bilinear height
field.

Measured: the file grew by **616.4094 mm³** against a closed form of
**617.0128** — 0.098%. The flat form, 599.0415, is **2.90%** out, thirty times
further away.

The 0.098% residual is faceting: the mesh's base is the inscribed prism, not
the smooth cylinder the closed form integrates, so slightly less material is
there to be raised. That is gated by making the facets smaller rather than by
argument:

| facets | crosshatch | zigzag |
|---|---|---|
| 48 | 0.1611% | 0.9510% |
| 96 | 0.0494% | 0.7039% |
| 192 | 0.0149% | 0.3981% |
| 384 | 0.0041% | 0.1346% |

Both fall with every refinement. The zigzag converges more slowly because its
flanks are ramps sampled on the facet grid where the crosshatch's tops are
flat, so the suite holds it to 0.2% and says so rather than to a gate only the
easy pattern can meet.

## 7. Paint

**PAINT SCOPE: SUB-REGION** — the curved band, and only that. Standing rule
(`docs/HANDOFF.md`): a painted / excluded face stays untouched by ANY bake
mechanism. This bake acts on one identifiable sub-region, so it checks paint
there and paint elsewhere does not block it. Same rule as Smooth's whole-piece
stand-down applied at a different scope, **not** a laxer reading of it.

What stands it down:

- **any facet of the curved side.** A click on a cylinder's side records ONE
  facet's plane, exactly as a click on a box face records that face's, so the
  check is `nsoMaskIsExcludedRaw(m, face.n, face.d)` over the band's distinct
  facet planes — mask6's own answer, per facet, never a second mapping from a
  plane and a bounding box. One painted facet stops the whole bake, because
  the relief is periodic around the full circumference and the engine has no
  per-facet height. A pattern that simply skipped a painted facet would leave
  a bald stripe, which is a different feature, not this one.

What does **not** stand it down:

- **either cap.** They keep their planes and their boundary loops; only the
  cap triangles that border a rim are re-fanned over the points the relief
  adds there, which is what `applySkinToFace` already does to the walls beside
  a skinned face. Nothing moves, and the suite measures the cap area before
  and after to say so.
- **any other piece.**

Stand-down wording, in the shape the other bakes use:

```
Texture stood down - 3 painted facet(s) on the curved side; the wrap is one
surface all the way round and cannot leave one facet bare. Clear paint on the
side to texture it (paint on the caps does not block it).
```

## 8. "Texture" is not "Full wrap", and not "Skin wrap"

Three things in this app carry a covering word, and they are named apart in
the UI on purpose:

| control | what it is |
|---|---|
| **Full wrap** (checkbox, Soften) | "one click wraps all six faces of a box" — *edge treatment*, Round / Corners / Bevel. Nothing to do with relief patterns, and untouched by this work |
| **Skin wrap** (button) | the same contact relief on every flat rectangular face, one after another. Every face is still a flat rectangle; a cylinder's side is refused |
| **Texture** (button, this) | one relief covering a cylinder's curved side as a single closed surface, wrapping all the way round with no seam |

The suite gates that `#chk-full-wrap` is still there and still says "Full
wrap", and that nothing in the UI calls Texture a wrap.

## 8b. The button, driven in real Chromium

`npm run texture:drive` (`tools/nso_texture_drive_check.js`), the same standard
as `skin:wrap-drive`: every step is a click on the shipped UI and the file
judged is the one the **browser downloaded**.

The engine suite (§1–§8) proves the geometry. This one proves the wiring — and
it does it by re-measuring the engine suite's own headline numbers on the
downloaded bytes, against a band fitted to the plain cylinder exported from the
same session, so the measurements are taken in the exported frame rather than
the builder's:

| on the browser download | measured |
|---|---|
| closure | one edge-connected shell, 0 open / 0 non-manifold / 0 odd / 0 winding, Euler 2, 0 piercing, 0 coplanar, 0 degenerate |
| triangles | 30,912 — the engine suite's count |
| bbox | 21.2 × 21.2 × 30, axial extent bit for bit what it was before the bake |
| every tip off the original surface | **0.6 mm to 4.5e-7 mm**, over 54,720 tips |
| max radius | 10.60000 (a single-normal lift would read 20.6) |
| floor between the ribs | 9.98798 — still the prism's apothem |
| **contact** | **1057.8826 mm²** — the engine suite's number to the fourth decimal |

Also driven: the status line (both contact numbers, the curved one first, and
the pitch snap declared); Undo → 256 triangles and `Undo: Texture reverted`; a
painted **side facet** → stands down and names the count, piece untouched; a
painted **cap** → textures anyway with the paint still on the piece, which is
§7's sub-region rule driven through the shipped button rather than asserted;
zigzag → 1,900 triangles, one closed shell on export; the prism fixture →
refused, naming Skin wrap, 32 triangles untouched. No page errors.

The two steps that are not clicks are the paints: there is no button for a face
click, so the check calls the app's own paint primitive and is labelled as
such, the same way the Skin and Skin-wrap drive checks do it.

## 9. Out of scope, deliberately

**Seat against a curved contact is a separate ticket and nothing here answers
it.** The audit flagged it as an open question rather than a detail, and that
is still the right reading: Seat translates B along one normal and explicitly
"does not tilt-fit a skin"; a curved interface has no single contact plane, so
either that ticket stays geometry-only or Seat grows a second mode. The
decision belongs to whoever takes it.

Concretely, and gated: neither `nso_skin_band.js` nor `app-texture.js` calls
`supportExtreme`, `tipContactArea` or any Seat entry point. The `tipArea` this
bake reports is the tip-surface area, **not** a promise that Seat can land a
part on it. Do not wire Seat to this button without doing that ticket.

**That ticket has since landed** — `docs/SEAT-SURFACE.md`, the **Seat here**
button, a new module (`nso_seat_surface.js`, `app-seat-surface.js`). It took
the second option: Seat grew a second mode. It changes nothing above. Both
files here are untouched, the gate in the paragraph above still holds and
still should, and a Texture band is still **not** a Seat target — that seat
measures an interface between two pieces, and a relief's tip surface is a
third thing, listed under "Deferred: contact geometry" in that document. So
the sentence this section opens with stays true of THIS file, which is what it
was ever about.

Also not done, and each its own question:

- **a second layer** (composed or free) on a band. `composePlans` works in the
  height field, so a composed layer would drop straight in; the free layer's
  sheet would have to be a cylindrical shell rather than a flat slab, which is
  `freeLayerShell` rewritten, not reused.
- **a cone, a torus, a fillet.** A cone is developable and would want the band
  finder generalised from "one radius" to "a radius that varies linearly along
  the axis"; a sphere is doubly curved and stays refused.
- **several bands on one piece**, e.g. a stepped shaft. `findBand` reads the
  whole soup as one cylinder by design, which is the strict reading and the
  one that refuses rather than guesses.

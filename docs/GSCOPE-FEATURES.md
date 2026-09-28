# G-scope: the Handle, Bracket, Lid and Hinge rows

`nso_flange.js` (`docs/GSCOPE-FLANGE.md`) showed a pattern that works. A
feature is found by a named geometric rule. Every clause of the rule is a
refusal with a worded reason. The rule is validated against ground truth that
was declared in advance, not against opinion. `tools/nso_features.js`
(`docs/FEATURES.md`) supplies that ground truth for four more features: one
known hull carrying a handle, a bracket, a lid and a hinge. For each one it
states the root, topology, volume and area, and checks them independently of
any detector.

`nso_face_features.js` is the detector for those four. It is one module with
four rules, and every rule is held to that ground truth as strictly as the
flange was. Each one is a row in G-scope's Parts list under **Flange**, and
works the same way: click to isolate, then Export or Crop through
`setSelection()`.

Out of scope: Detach / Reattach from these detections. Detach
(`docs/DETACH.md`) understands a flange's root plane and neck wall. Doing the
same for a handle's two feet, a bracket's full plate, a lid's seat ring or a
hinge's two webs is separate design work.

## What the four share: something standing on a face

A handle, a bracket, a lid and a hinge are all fused onto a flat face of a
body. Where something is fused on, the face has a hole: the face's own
triangles stop at a loop, and the feature is on the other side of it. Every
rule starts from that.

1. **Faces.** Triangles are grown into flat regions. A neighbour joins when
   its three vertices lie within 0.2 µm (plus 2 ppm of the part's size) of
   the seed's plane and its normal is within 1°.
2. **Root loops.** Each region's boundary is chained into loops, in the
   region's own winding. The outer loop runs one way round. A loop that runs
   the other way is a hole in the face, which is a place where something
   meets it.
3. **Protrusions.** From each root loop, the surface on the far side is
   flooded without entering the face. What the flood collects is one thing
   standing on the face, and the root loops it reaches are every place that
   thing meets the face. A flood is dropped, and so is not a protrusion, if
   it reaches the face's outer edge, crosses an open edge, or takes in more
   than 60 % of the part (it has gone into the body), or if it reaches below
   the face (a pocket or a bore).
4. **Its solid.** The flood, plus one cap on each root loop, is the feature
   as a closed solid. Each cap is ear-clipped from the loop's own vertices
   and faces into the body. Nothing is cut and no vertex is moved. The root
   area is the caps' area.
5. **Shells.** The soup's closed shells, with the signed volume and χ of each:
   the host, any voids (negative volume), and any second body.

Every protrusion is a candidate for every rule. Each rule runs its clauses
in order. When a clause fails, its dependent clauses are skipped, and every
failure is kept (`candidates`, with `failed` and `measured`). So a row
reading "none" always has a reason: the nearest candidate's failures, in
words (`WHY`).

## The four rules

### Handle: a rod that closes a through-opening with its face

| clause | condition | on `feature-hull_all.stl` | failure, in words |
|---|---|---|---|
| feet | it meets the face at exactly two places | 2 | meets its face at N place(s), not on two feet |
| round | both feet are round: every vertex the same distance out (RMS ≤ 5 % of r), the loop filling its circle (≥ 90 %: an 8-gon fills 90 %, a 2:1 rectangle 51 %), and both feet the same size (10 %) | RMS 0, fill 0.989 (a 24-gon), r 4.000 / 4.000 | stands on feet that are not round - not a rod |
| closed | a ray straight out from between the feet meets the rod | yes | does not close over the space between its feet |
| opening | ...after at least the rod's own width of air (2r): room for a hand. This is the generator's own refusal, turned round | 21.000 mm clear ≥ 8 | leaves an opening narrower than itself - no room for a hand |
| rod | ...and the grip it meets is the same rod, 2r across (15 %) | 8.000 mm | is not the same rod across the opening as at its feet |

The "fill" part of **round** was added because the hinge's two rectangular
webs have corners that are all equidistant from their centre. With vertex
spread alone they read as round.

### Bracket: a plate fused flat, an arm square to it, braced

| clause | condition | on `feature-hull_all.stl` | failure, in words |
|---|---|---|---|
| root | it meets the face at exactly one place | 1 | meets its face at more than one place, not on one plate |
| plate | rays square to the face, on a grid over the root (at most ~4000, ≥ 0.25 mm): the solid is one thickness t over ≥ 50 % of the root, never under 0.9 t, and the root is ≥ 4t across both ways. So the whole root is a plate's contact, not a line | t 3.000 over 84 %, min 3.000, root 40 × 30 | does not lie flat on its face as a plate of one thickness |
| arm | where the solid runs out ≥ 3t, at its own flat-ended run: one strip ≤ 1.5t + one sample wide, ≥ 4t long, along the root's edge, whose own thickness (rayed square to it at mid-height) is t to 25 % | 20.000 out, 3.000 thick, 39.98 long, normal Z | has no arm of its own thickness standing square off its plate |
| braced | beside the arm, at least one gusset: a region whose run over the plate falls in a straight line with distance from the arm (R² ≥ 0.95, falling) | 2 gussets, 45.000°, R² 1.000000000, legs 14.000 / 14.000 | has an arm but no gusset bracing it - an angle, which the flange rule finds |

**Braced** is what separates this rule from the flange rule. The unbraced
angle (`feature-hull_angle-unbraced.stl`) passes plate and arm and fails on
"braced" alone. It is a flange by `nso_flange.js`'s rule, and that is pinned in
`features:test`. With the gussets on, the flange rule fails the same arm on
"straight".

### Lid: a cover seated on a ring round an opening, located by a plug

| clause | condition | on `feature-hull_all.stl` | failure, in words |
|---|---|---|---|
| root | it meets the face at exactly one place | 1 | meets its face at more than one place, not on one seat |
| void | under it is an enclosed void (a closed shell of negative volume) with faces on the root plane, inside the root: the pocket it closes | 24495.000 mm³ | closes no pocket - there is nothing enclosed under it |
| plug | where the void meets the face it is a ring: an opening loop, with a plug loop inside it. The void's sides and floor that hang off the plug loop are the plug's | opening 60 × 40, plug 59 × 39 | has no plug dropping into its pocket to locate it |
| seat | the opening lies inside the root with a rim all round: the lid meets the hull on a ring, and only there | rim 6.000, ring 1344.000 mm² | does not sit on a ring round its pocket |
| free | the void is one genus-0 shell. A plug down on the floor would make it a ring (χ 0) | χ 2 | has its plug fused to the pocket floor |

It also measures the clearance (the least distance between the two loops,
0.500), the plug depth (5.000), the gap under the plug to the floor (10.000)
and the plate over the seat (3.000). A lid's root is its seat ring, not its
footprint. Its solid is the plate, the plug's side of the void, the strip of
plate underside over the gap, and one ring cap on the seat.

### Hinge: fixed knuckles on two webs, a second body captive on their pin

| clause | condition | on `feature-hull_all.stl` | failure, in words |
|---|---|---|---|
| webs | the fixed part meets the face at exactly two places | 2 | meets its face at N place(s), not on two webs |
| body | a second body (a closed shell of positive volume, not the host) is tangled with it: its box overlaps the fixed part's | 8371.691 mm³ | carries no second body - nothing moves |
| bored | that body has one through-hole (χ 0, genus 1): something to turn on | χ 0 | carries a second body with no bore to turn on |
| captive | cut square to the line through the two webs, at the body's middle: a section of the fixed part (the pin) lies inside the body's hole | pin r 2.500 in bore r 3.000 | does not pass a pin through the moving part |
| axial | from inside the knuckle wall, along the axis both ways: the fixed part within one knuckle radius | 0.500 / 0.500 | does not hold the moving part between two fixed knuckles |
| free | it clears the pin all round and both fixed knuckles (> 0) | least gap 0.498 | touches its moving part - it is not free to turn |

The clearance is read at the section's corners: bore 3.000 − pin 2.500 =
0.500, which is the generator's `clear`. The least gap along 16 rays is
0.498, which is `clear · cos(π/32)`, the gap between the 32-gon's flats. The
test holds both. The solid is the fixed part (capped on both webs) plus the
moving body: two bodies, χ 2 + 0.

## Validation (`npm run face-features:test`, 122 gates, about 3 s)

### Against the ground truth, on `feature-hull_all.stl`

On the whole piece (2036 triangles, about 0.1 s) each rule finds exactly its
one feature, inside that feature's cell. Every number the generator declared
is read back from the geometry:

| | measured | truth (`features.json`) |
|---|---|---|
| handle | rod r 4.000, span 50.000, opening 42.000, clear 21.000, grip 8.000, opening centre (−70.5, 0, 20), loop normal Z | 4, 50, 42, 21, 2r, same, Z |
| bracket | t 3.000; arm 20.000 out, 3.000 thick, normal Z; 2 gussets at 45°, legs 14.000 each, each inside its declared gusset box | 3; 20, Z; 2 × leg 14 |
| lid | clear 0.500, rim 6.000, seat 1344.000 mm², plug 5.000, floor gap 10.000, void 24495.000 mm³, plate 3.000 | 0.5, 6, 1344, 5, 15 − 5, 24495, 3 |
| hinge | pin 2.500, bore 3.000, clear 0.500, knuckle 5.000, axial gaps 0.500 / 0.500, axis X through (·, 40.5, 20), moving body χ 0 | 2.5, 3.0, 0.5, 5, 0.5, same, genus 1 |

| | root area | volume | bounds | lifted-out solid |
|---|---|---|---|---|
| handle | 99.386 of 99.387 | 3891.763 (exact) | exact | PASS, χ 2 |
| bracket | 1200.000 | 6228.000 (exact) | exact | PASS, χ 2 |
| lid | 1344.000 | 22737.000 (exact) | exact | PASS, χ 2 |
| hinge | 256.000 | 11468.017 (exact) | exact | PASS, χ 2 (two bodies) |

Each lifted-out solid is also compared with what the reference `detach()`
cuts out of the same piece. That reference uses only the manifest's cells
and shares no code with the rules. The two match in volume and area to 1e-7,
in χ, and in triangle count.

### Zero false positives

- **On the same hull.** For each rule, every candidate inside another
  feature's cell fails, with the clause named. For example, the handle rule
  on the hinge fails *round*, *opening* and *rod*. The bracket rule on the lid
  fails *arm*. The lid rule on the bracket fails *void*. The hinge rule on
  the handle fails *body*. The hull itself has no candidates at all.
- **The hull alone** (the bare 120 × 70 × 40 box) has nothing standing on
  it, and all four rows say so.
- **Each feature alone.** Every single-feature fixture lights exactly its own
  rule and no other. This is recorded in `features.json` under `detectors`.
  The unbraced angle lights none of the four.
- **The whole library.** All 103 other STLs in `library/` and `fixtures/`
  were run. They have 46 things standing on a face between them, and none of
  them passes any of the four rules. Four were worth checking by hand:
  `hinge_knuckle_box.stl`, `hinge_knuckle_lid.stl` (the knuckle half of a
  hinge that takes a separate pin: one body, with its knuckle boss meeting
  the face in one place), `hinge_pip.stl` (free-standing knuckles, not on a
  face: nothing stands on a flat face) and the skin-sample rings (pads of
  uneven thickness, which fail "plate"). The slowest file took 0.3 s.

### Pose

The whole piece was turned 90° about Z, turned upside down, and turned 30°
about Z and then 20° about X, which puts every face off-axis. Each pose gives
the same four features with the same volumes (to 1e-5) and the same numbers.

### Other parameters, built fresh

This shows that nothing is fitted to the defaults. Each rule was run on a
feature built with different parameters: a handle with r 3 and R 20 on 16
sides, a bracket with t 2, arm 14 and gusset 9, a lid with clear 0.3, rim 4,
plug 4 and t 2, and a hinge with R 6, rp 3, clear 0.3, gap 0.4 on 24 sides.
In every case the measured numbers follow the new truth, and the volume,
root area and bounds are exact.

## The rows (`npm run gcode:gscope-features`, headless Chromium, the real app)

| document | a row reads | a click |
|---|---|---|
| a mesh with that feature | `Handle (8 mm rod, 21 mm clear, 1196 tri)`, `Bracket (3 mm, 20 mm arm, 2 gussets, 48 tri)`, `Lid (0.5 mm clear, 6 mm seat, 36 tri)`, `Hinge (0.5 mm clear, 2 bodies, 700 tri)`, each in its own colour | selects it and isolates it. The row stays lit while it is the selection |
| a mesh without it | `Handle - none detected`, dimmed. The tooltip gives the nearest candidate's failures in words | nothing is selected, and the info line says why |
| a slice | `Handle - not on a slice` | the same. A slice has beads, not a closed surface |

The rows come after **Flange**, in the order Handle, Bracket, Lid, Hinge, in
the same `#ms-detected` block. One analysis of each piece serves all four
rows. It runs once per document, just after it opens, and also runs when a
row is clicked before it has finished. A piece over 400,000 triangles is
skipped by name, as it is for the flange.

What a row hands over is an ordinary mesh object, so **Isolate**, **Back**
(the feature highlighted on the whole part), **Export as STL**, **Export to
plate** and **Crop** (as a new piece, the file route) all take it exactly as
they take the flange.

The drive-check covers the following:

1. Each single-feature fixture goes through G-scope's own Import. Its row is
   lit with the numbers Node measures, and the other four rows (Flange
   included) read "none detected" with their reasons. A real click isolates
   it alone, in its colour, with exactly its declared bounds. Export as STL
   writes exactly that feature: the same triangles, its declared volume and
   bounds, and a clean solid (PASS, χ as declared).
2. `feature-hull_all.stl` lights all five rows. Each click isolates its own
   feature with exactly its bounds, and only its own row lights. Back
   highlights it on the hull. Crop takes a band out of the handle as a new
   piece.
3. On a slice, each of the four rows says it cannot look.

In the page: `NSO_MICROSCOPE.feature(rule)` (status, reason, objects),
`.featureRules()`, `.detectFeatures()` and `.isolateFeature(rule)`. In Node
or the page: `NSO_FaceFeatures.detect(soup)`.

## What it does not find, on purpose

- **A feature that is not fused onto a flat face.** Every rule starts from a
  hole in a flat face, so a feature on a curved surface is not found, and
  neither is a freestanding one (`hinge_pip.stl`'s knuckles). A feature whose
  root runs off the edge of its face touches the face's outer loop, so it is
  not a protrusion either.
- **A handle that is not a round rod.** A D-section or rectangular grip fails
  "round". That is deliberate: the hinge's rectangular webs are what "round"
  keeps out.
- **A bracket without gussets.** That is an angle, and the flange rule finds
  it.
- **A lid with no plug, or with its plug fused to the floor.** The first
  fails "plug" and the second fails "free". A flat cover on a pocket does
  meet the hull on a ring, but nothing locates it.
- **A hinge whose pin is its own separate body**, such as a pin pressed
  through two knuckle halves. The rule wants the fixed part and its pin to
  be one piece, fused to the face, with the moving part captive on it.
  `hinge_knuckle_box.stl` is one half of that kind of hinge and reads "none".
- **Anything on a slice.** The rules need a closed surface.

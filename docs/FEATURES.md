# Feature fixtures: known functional features on one known hull

`tools/nso_features.js` puts real functional features on one known-clean
hull: a flange, a handle, a bracket, a lid and a hinge. Each is built from an
explicit geometric definition. For each one it states in advance where the
feature is, where it meets the hull (its **root**), what it adds to the
topology, and what the canonical checker (`tools/mesh_validate.py`) will read
off the whole piece. That is ground truth for testing feature detectors (`nso_flange.js` for
the flange, `nso_face_features.js` for the handle, bracket, lid and hinge)
and for testing a detach operation.

```sh
npm run features:test       # tools/nso_features_test.js - 113 checks, ~9 s
npm run features:fixtures   # tools/nso_features_make_fixtures.js --check - byte-diff fixtures/features/
```

```js
const FX = require('./tools/nso_features.js');
const p = await FX.build({ features: [{ type: 'flange' }, { type: 'hinge', params: { clear: 0.4 } }] });
p.soup        // Float32Array, 9 floats per triangle: the whole piece
p.expected    // what mesh_validate.py --json must report: census, signed_volume, surface_area
p.declared    // what the definitions add up to: chi, shells, bodies, volume, area
p.features    // per feature: type, face, params, root_plane, roots, cells, volume, topology, truth
await FX.detach(p.soup, p.features[0])   // { feature, host }: exact, capped soups
await FX.reattach(host, feature)         // the piece again
```

## Task 1: the audit. nso_damage.js's architecture, reused

`tools/nso_damage.js` (`docs/DAMAGE.md`) earns its trust through four
things. Each carries over directly, and its machinery is called rather than
copied. `kernel`, `toManifold`, `toSoup`, `closestPair`, `exactIndex`,
`census` and `expectation` are now exported from `nso_damage.js` and used as
they are.

| nso_damage.js | nso_features.js |
|---|---|
| a named, parameterized damage type (`hole`, `sever`, ...) | a named, parameterized feature type (`flange`, `handle`, ...) with defaults |
| **refuses** a dirty input, with the reason, rather than report the input's defects as its own | **refuses** parameters that are not the feature they name, with the clause they break ("sticks out 8 mm, under 3t"), and refuses two features whose cells overlap |
| `expected`: the exact census, from topology the tool **built**, not from the checker | `expected`: the same census (its own `exactIndex` and `census`), plus volume and area |
| `sites`: where the damage went | `features`: where each feature went, with its root, its cell and its ground truth |
| `sever` checks the kernel's output twice and refuses it if it is not exactly what was promised | every composition is checked the same way. It is refused unless: the exact census is clean; no two vertices are within 2× the weld radius; the vertex count and χ equal the kernel's and the definitions' sum; the volume is the hull plus each feature; the area is the hull plus each feature minus twice each root |
| fixture generator + `--check` byte-diff + manifest + Library copies | the same generator, with the same `--check`, the same `nest-library` handling and the same SKIP rule |
| the test holds the tool to the checker **and** to numbers known by hand | the test holds it to the checker, to measurements that share no code with it (its own ray caster and component count), to the flange detector, and to functional checks (a finger through the handle, the hinge swung) |

The prediction is stated before the output is read. Each definition
**declares** what it adds: the handle adds host genus 1, the lid adds one
enclosed void, the hinge adds host genus 1 and one extra body of genus 1. So
χ is `(2 − 2·genus) + 2·voids + Σ(2 − 2·g)` over the extra bodies. The
volume is `hull + Σ features`, because the cells are disjoint. The area is
`hull + Σ(feature − 2·root)`, because a root is exactly where two surfaces
become one. The composition is refused unless the kernel's output matches
all of this, and the checker then has to read the same numbers
independently.

## The frame, the cell and the root

- **Hull**: a box, 120 × 70 × 40 mm by default, resting on z = 0 and centred
  on x and y. Features go on its five non-bed faces (`-x +x -y +y +z`).
- **Face frame (u, v, w)**: w is the outward normal and u, v lie in the face
  (v is +Z on the side faces), with u × v = w. The face itself is w = 0. A
  feature is built in this frame and taken to the world by a signed
  permutation. That transform is exact, so no coordinate is rounded on the
  way.
- **Cell**: the box over a feature's footprint, `keep` (1 mm) beyond it on
  every side, out from the face. For the lid, the cell also includes the part
  of its pocket that sits in the air around its plug. A cell holds none of the
  hull and none of any other feature. That is checked, and overlapping cells
  are refused, so **the part of the piece inside a cell is the feature**.
- **Root**: where the feature meets the hull. It lies in the face plane, and
  its declared area is checked on every build.

### Reference detach and reattach

`detach(soup, record)` reads only the soup and the feature's manifest record.
It is the ground truth that any Detach / Reattach operation should be held
to. **It is not a kernel cut.** The root lies on the hull face, and every cut
through that plane leaves a zero-thickness sheet of hull face behind on the
feature. That was measured: an extra 258 mm² on the flange from a cell box
with a face on the plane, the same from the kernel's own `trimByPlane`, and a
non-manifold fringe around the handle's feet. So detach sorts the piece's own
triangles instead:

- **feature**: triangles beyond the plane and inside a cell; triangles on the
  plane that face into the hull (the lid's underside over its plug gap); and
  triangles inside a recess cell.
- **host**: everything else.

The two sets are open along the same loops, which are the roots. Both are
then closed with **one** triangulation of those loops, using the kernel's
`triangulate` on the loops' own vertices. Nothing is cut and no vertex is
added or moved.

Measured on `feature-hull_all.stl`, every feature comes off as a clean
solid (checker PASS) of exactly its declared volume. The contact it leaves
(`(A_feature + A_host − A_piece) / 2`) equals its declared root area: flange
150.000, handle 99.386 (declared 99.387), bracket 1200.000, lid 1344.000,
hinge 256.000 mm². Reattached, it gives the piece again, with the same volume
to 1e-9 and the same χ.

## Task 2: the definitions

Each definition is a set of refusals, not just a shape. Each one comes with
what proves the generated shape really is the thing, measured independently.

### Flange (face −Y by default): the detector's own rule, turned into a generator

A flat plate of one thickness t, standing `reach` out from a face along a
straight root `length` long, off a body thicker than it. Every clause of
`docs/GSCOPE-FLANGE.md`'s rule is a refusal. The generator refuses a reach
under 3t ("wide"), a root under 2t ("attached"), a face under 2.5t tall at
the root ("thin"), and a hull under 2.5t deep behind it ("body"). Defaults:
t 2.5, reach 15, length 60, mid-height. Ground truth: axis, thickness, band,
reach, root length, root plane, bounds.

### Handle (face −X): a rod that closes a loop with its face

A handle is a grip standing `clear` off the face, carried to the face by two
legs that meet it at two disjoint round feet. Here the loop is an **arch**: a
half torus with rod radius r on an arc of radius R. It is built as its own
mesh so that the two feet lie exactly in the face (the end sines are exact
zeros). The opening is a half disc of radius R − r. **What it adds is exactly
one through-opening: genus + 1.** The generator refuses an opening narrower
than the rod, because that is a boss with a hole in it, not something you
take hold of. Defaults: r 4, R 25 (21 mm clear, feet 50 mm apart), a 24-sided
section and 24 segments over the arc.

Proved by: the checker reads χ 0 (genus 1). A ray straight out from the face
at the middle meets air for exactly 21.000 mm, then 8.000 mm of rod. Along
the face, the gap between the legs is exactly 2 × clear. A finger-sized
probe through the opening touches nothing, and moved one clearance any way
in the loop's plane it hits: it is trapped.

### Bracket (face +X): a braced angle

A mounting plate lies flat on the face. An arm of the same thickness stands
square to it along the plate's lower edge. Two triangular **gussets** tie the
arm to the plate, making a triangulated cantilever. Its root is the whole
contact of the plate with the face (40 × 30 = 1200 mm²), not a line. Defaults:
t 3, width 40, height 30, arm 20, gusset legs 14.

**The gussets are the definition, not decoration.** An angle without them is
a thin, flat plate standing straight off a thicker body along a line, which
is exactly the flange rule, and `nso_flange.js` finds it as one (3 mm, 16.8 mm
out, 40 mm root). So `bracket` refuses `gussets: 0`, and the unbraced shape
is its own type, `angle`. Its manifest says the flange detector **must** find
its arm, and the test pins that. With the gussets on, the same arm fails the
rule on "straight": its root runs up both gussets.

Proved by rays: through the arm between the gussets there is exactly t.
Through a gusset there is the arm plus a straight 45° taper (15.6, 11.4, 7.2
and 3.7 mm at four stations, each exact). Square to the face above the
gussets, the plate's face is at t and the solid runs t + 120 mm into the hull,
so it is fused flat. The volume matches plate + arm + two gussets computed
by hand.

### Lid (top face): a cover seated on the rim of an opening

The hull gets a pocket (60 × 40 × 15). The lid is a plate over it, `rim`
(6 mm) wider all round, with a plug that drops into the pocket with `clear`
(0.5 mm) all round and stops short of the pocket's floor. **The only place it
meets the hull is the seat**, a ring of 1344 mm². So lifting it along the
seat frees it whole, and the plug is what locates it. Seated, it closes the
pocket, which adds **one enclosed void**. The generator refuses a plug that
reaches the floor (the lid would then be fused there too) and a clearance
under 0.05 mm.

Proved by: detached, the lid lifted 0.01 mm touches nothing. Slid half its
clearance any way, it is still free. Slid twice its clearance, the plug hits
the wall, so it locates. Seated, the checker reads χ 4, and the inner shell's
signed volume is exactly −(pocket − plug) = −24495 mm³. Detached, the hull
is one genus-0 shell again.

### Hinge (face +Y): a print-in-place knuckle hinge

The hinge has three coaxial knuckles of radius R and length k on an axis
parallel to the face. The two outer ones are **fixed**, each on a web to the
face (the webs are the root, 2 × 16 × 8 = 256 mm²). A pin of radius rp runs
through all three and is fused to the outer two. The middle one is
**moving**: it turns on the pin with `clear` all round, `gap` from its
neighbours, clears the face by `clear`, and carries a leaf. Over the fixed
knuckles the leaf starts clear of them. So the moving knuckle and its leaf
are a **second body, captive on the pin**. The pin loop adds host genus 1,
and the bored moving knuckle is a body of genus 1. Defaults: R 5, rp 2.5,
clear 0.5, gap 0.5, k 16, leaf 25, and a leaf half-thickness of 4. The leaf is
thinner than its knuckle ("carried by it"), so its faces cross the knuckle's
walls instead of grazing them.

Proved by: exact-vertex components find two bodies. The moving one is closed
with χ 0, and it sits exactly where the truth says, to the micron. Swung
−90, −45, 45 and 90° about its axis it touches nothing, and at ±135° the face
stops it. Slid half its axial gap along the pin it is free, and slid twice
the gap a fixed knuckle stops it. Moved half its clearance across the pin it
is free, and moved twice the clearance the pin holds it.

## Task 3: the flange detector, validated against all of it

On `feature-hull_all.stl` (2036 triangles, a 0.42 mm grid, about 0.5 s):

| | measured | truth |
|---|---|---|
| flanges | 1 | 1 |
| axis, thickness | Z, 2.500 | Z, 2.5 |
| band | 18.750 – 21.250 | 18.75 – 21.25 |
| reach / root length | 15.06 / 59.82 | 15 / 60 (within a grid cell) |
| cut | −Y at y = −35.002 | the face, plus the rule's 2 µm |
| extracted | 2249.700 mm³, clean, bounds exact | 2250 less the 2 µm slab |

**Zero false positives.** Every slab candidate inside another feature's cell
fails: 53 on the handle, 5 on the bracket, 6 on the lid, 124 on the hinge, and
43 on the hull itself. Alone on the hull, the handle, bracket, lid and hinge
each read "none". The whole piece turned 90° or upside down still gives the
one flange.

### What this found: a false positive on the handle, and the fix

The first run found **two** flanges. The second was the handle, read as a
7.7 mm plate 26 mm out. Seen along the loop's normal, a round rod's chord
changes slowly near its crest, so the columns chain into one "slab" through
the per-neighbour tolerance. The core (within 5 % of the median thickness)
is then a band about 3 mm wide, and it passed every clause: attached at the
feet, thin against the hull, "wide" measured as the arch's reach, flat
enough, and with a straight root through both feet.

The rule had no clause saying that **a plate is wider than it is thick**.
`nso_flange.js` now has one, **sheet**. The core is eroded by t/2 in its own
plane, and what is left must still reach 3t from the root. A plate loses t/2
at its tip and keeps its reach. A rod crest narrower than its own thickness
erodes to nothing. The test pins it: the handle's crest now fails exactly one
clause, "sheet". The check runs only on a candidate that has passed
everything else, so it costs nothing on the rest.

It changes nothing the rule found before. `flange:test` still passes all 48
gates, with the clamp bar's numbers unchanged, and a rescan of all 103 STLs
in `library/` and `fixtures/` gives exactly the table in
`docs/GSCOPE-FLANGE.md`: the clamp-bar family and `lid_strap`. No STL in the
repo fails on "sheet" alone.

## Task 5: the handle, bracket, lid and hinge detectors

The other four features now have detectors too: `nso_face_features.js`, one
named rule each, with every clause a worded refusal. They are validated
against this ground truth to the same standard as the flange detector
(`docs/GSCOPE-FEATURES.md`, `npm run face-features:test`). On the whole
piece, each rule finds exactly its own feature, in its cell, and reads back
every number the generator declared (the handle's clearance, the bracket's
gusset legs, the lid's seat and void, the hinge's pin and gaps). Each also
reads back its root area, its volume and its bounds. What each rule lifts
out is the same solid the reference `detach()` above cuts out, in volume,
area, χ and triangle count. Every candidate in another feature's cell fails,
and so does every candidate in the other 103 STLs in the repo. `detectors`
in each `features.json` entry now carries all five detectors' expected
counts.

## Task 4: fixtures and the Library

`fixtures/features/` holds seven files and `features.json` (see its
README). Six are Library rows under **Test Fixtures**, served from
`nest-library` like every row: the whole set, and each feature alone. The
unbraced angle is kept out of the Library, because it is a pin on a
definition, not a piece to try things on. The generator copies the six into a
nest-library checkout when there is one. `features:test` byte-compares
them there, and without a checkout it SKIPs that out loud, as the damage
fixtures do.

## Limits

- The hull is a box and features go on its faces. A feature's root is planar
  and axis-aligned. That keeps every transform exact, and the root plane
  becomes one of the hull's own faces.
- One feature of each kind per face is what the defaults give. Several fit
  on one face as long as their cells do not overlap (checked).
- The hinge is always two fixed knuckles and one moving one.
- A round flange (a pipe collar) is not generated. The detector does not
  handle one either (`docs/GSCOPE-FLANGE.md`).

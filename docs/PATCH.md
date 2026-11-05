# Patch, Cap, Bridge — the check → fix loop

*Added 2026-10-16.*

Check finds a hole; the Findings card (`docs/FINDINGS.md`) used to offer one
blind button for it, Cap open faces, which closes every open loop near one
plane. This closes the loop the other way round: **every row on the card names
the fix that fits that finding, and runs it on that finding only.**

```
nso_patch.js          the engine: loops, PATCH, CAP, BRIDGE, gaps          (node-testable)
app-patch.js          one commit path (nsoRepairRun) and ADD > Patch        (the page)
nso-findings.js       the card's rows: one ITEM per finding, with its fix
app-findings.js       the buttons, the re-scan, "Fix all"
tools/nso_repair_loop_test.js        npm run repair:loop      (headless)
tools/nso_findings_drive_check.js    npm run findings:drive   (section 9)
tools/nso_repair_loop_fixtures.js    fixtures/repair/box_lid_hole.stl
```

## The choice

The card chooses from the finding's own geometry (`NSO_Patch.plan`,
`NSO_Patch.gaps`), never from a count, and the button says it:

| finding | button | what it does | scope |
|---|---|---|---|
| open loop, rim flat | **CAP** | the flat cap over that loop | this loop |
| open loop, rim curved | **PATCH** | a surface that continues the curvature round it | this loop |
| two open loops within 2× the wall, facing each other or nested | **BRIDGE** | a strip welded to both | this pair |
| two flat end faces facing each other within 2× the wall (a severed tube) | **BRIDGE** | both faces come off, the strip joins the loops they leave | this pair |
| doubled, pinched, or open edges that are no clean loop | **REPAIR** | Seal with Repair, the Finish menu's own control | whole piece |
| thin wall | **THICKEN OUT +0.56 mm** | the Finish menu's Thicken out, the mm typed in | whole piece |

Wording stays plain: `Hole, curved rim — PATCH`, `Hole, flat rim — CAP`,
`Gap 1.2 mm between two edges — BRIDGE`, `Gap 1.0 mm between two faces —
BRIDGE`, `Doubled or pinched edges, whole piece — REPAIR`.

**Rim flat or curved.** A rim is flat when the slab between two parallel
planes that holds every rim vertex is no wider than **0.05 mm** (its
flatness: the width of the zone, not the distance from the fit). The rim of
`shape-sphere_hole` is a ring of 7 vertices on a 4.8 mm sphere and measures
0.059 mm: curved, PATCH. The lid of `box_lid_hole` measures 0: flat, CAP.

**Two openings that are one gap.** Two loops are a pair when, matched round
(Bridge's rule: the rotation that does not twist), they stay within twice the
wall of each other, their perimeters are within 2:1, the wall is no more than
0.35 of the loops' size, and either they face each other (a crack that opened)
or one lies inside the other in one plane (the two rims of a double-skinned
shell, `thin_shell_cup`: 1.2 mm apart, the strip is the annulus). The wall is
the median inward-ray distance from the triangles beside the rims. The two
ends of an open pipe face away from each other and are not a pair. A solid
ball with two holes is not a pair either: its wall is far more than 0.35 of a
hole.

**A severed tube has no open loop.** `shape-tube_severed` is a closed C: the
slot is capped, Check passes. What it has is two flat end faces looking at
each other across 1.0 mm of air in a 1.38 mm wall. `NSO_Patch.gaps` finds them:
flat regions whose whole rim is a convex crease of at least 20° (the end of
something, not the floor of a groove), within 5° of facing, the plane gap at
most twice the narrower side of the face and not under 0.42 mm (a thinner gap
is Check's thin-wall finding already), 80% overlap each way, nothing between.
This is **advisory**: a slot is a slot. A gap never changes a verdict, the
card shows it as the one row on a piece that otherwise passes (and then the
green "Nothing wrong found" row gives way to it), and **Fix all leaves it for
you**. `hinge_pip`'s 0.3 mm print-in-place clearance is under 0.42 mm and
stays Check's; every other fixture and every STL in `library/` reports no gap (`soften_test_04_slotted_block`, a slotted block, included: a groove's floor is a concave crease).

## Patch

The rule is Lift 3's repair fill (`docs/LIFT.md` 6): a smooth local fit through
the rim's neighbours, welded at the rim, no lip, no flat facet.

| step | exactly |
|---|---|
| **loops** | boundary half-edges traced by turning round each vertex through the faces, so a pinch vertex (where a loop touches itself, or two loops meet) keeps every loop a simple cycle. Ids are places in the list, longest first; valid for that soup only |
| **rim** | the loop's own vertices, the numbers the piece already has. The fill uses each rim edge the other way round to the piece's use, so it closes the loop by bit equality: no weld, no kernel. Every triangle the piece had is kept byte for byte |
| **across** | minimum-area triangulation of the loop (dynamic programming), every chord checked against the edges the mesh already has so no edge is doubled; where the loop is a graph over its plane, every chord is inside the polygon and every triangle winds its way |
| **refine** | Liepa's rule: a triangle is split at its centre while its centre is farther from its corners than the neighbours' edge length there (×0.5: a fill about half a neighbour edge fine, so even a 7-edge hole gets interior points), relaxed by flips that never cross the rim or double an edge |
| **height** | **the fitted surface**: a quadric `w = a·u² + b·uv + c·v² + d·u + e·v + f` over the best plane through the rim and the rings of the piece's own vertices round it (weights 1, .7, .4, .25), by least squares; the fill stands on it by how far the rim stands off it, harmonic inside. Taken when the rim is a simple polygon in that plane and the quadric follows the neighbours to 4% of an edge. On `shape-sphere_hole` the fit follows its 39 samples to 0.004 mm rms and the fill's points lie within 0.002 mm of the sphere it was cut from |
| **else** | the **biharmonic fair**: the new points minimise `Σ |L x|²` over themselves and the rim vertices, `L` the uniform Laplacian over the piece's own edges and the fill's, so a rim vertex's `L` reaches across the weld into its real neighbours and carries their slope in (a C¹ join). For a rim that wraps (the shredded sphere's half-sphere) or a neighbourhood no quadric follows |
| **piercing** | a fill that would pierce itself, another fill or a neighbouring sheet is eased toward the unfaired fill (1, .7, .5, .35, .25, .15, .08, 0) until it does not. Reported in the result (`filled[i].pierces`), never hidden |
| **flat rim** | within 0.05 mm: the flat cap, the triangulation across and nothing inside |

### What "the rim normals match" means

The ticket asks the fill's rim normals to match the neighbours' within 5°.
A face-to-face dihedral across the rim cannot be that measure: the undamaged
`shape-sphere` (0.5 mm edges on a 4.82 mm radius) has facets 10.9° apart there.
The measure is the **step in the smooth-shading normal at each rim vertex** —
the mean of the unit normals of the faces round it, after the fill goes in,
against the same vertex from the piece's own faces alone: how far the shading
steps at the weld.

| fill | worst step at the 7 rim vertices |
|---|---|
| Patch | **3.50°** |
| flat Cap | 6.19° |
| the undamaged sphere (its own 5 faces put back) | 5.5° |

`tools/nso_repair_loop_lib.js` `rimNormalSteps`; `repair:loop` and
`findings:drive` gate Patch at 5° and gate that Cap is over it, so the measure
has to tell them apart.

### The numbers

| piece | the finding | after | |
|---|---|---|---|
| `shape-sphere_hole` | 1 hole, 7 open edges | PATCH: 15 triangles, 0 open, manifold, canonical **PASS**, χ 2 | 66 ms |
| `shape-sphere_holes-shredded` | 2 holes (6 loops), 221 open edges | two PATCH: 221 → 70 → 0 open, 0 non-manifold, 0 mis-wound | 1.1 s |
| `shape-tube_severed` | 1 gap, 1.0 mm | BRIDGE: 8 triangles in, 4 out, one shell, **χ 2 → 0**, canonical **PASS**, +15.4 mm³ (the slot is 1.0 × 1.38 × 11.10) | 29 ms |
| `shape-tube_severed-apart` | 2 gaps, two bodies | two BRIDGE: one closed ring, χ 0 | |
| `thin_shell_cup(_thin)` | 2 holes, 96 open edges | BRIDGE: the annulus, one closed shell | 70 ms |
| `box_lid_hole` | 1 hole, 22 open edges | CAP: 20 triangles in the lid's plane, canonical **PASS**, volume 6912 = 24 × 24 × 12 | 17 ms |
| `thin_shell_cup_thin` | thin wall 0.249 mm | THICKEN OUT +0.56 mm (0.249 + 0.56 = 0.809 ≥ 0.8): 96 thin faces → 0 | |

**The shredded sphere is closed and manifold, not clean.** (`findings:drive` writes the card's before / after screenshots to the git-ignored `tools/repair-out/`.) Its fragments are
five separate shells; the big fill crosses a small neighbouring fragment, and
the canonical checker reads **10 piercing pairs** and a few thin faces where it
does. The engine tries to ease the fill off them and cannot (a 4-vertex hole in
another shell sits in the big fill's way even flat). The card says so in the
same breath as the fix: `Before: 221 open edges. Now: 70. Also: Before: 0
piercing pairs. Now: 10.` Piercing has no button yet.

## Cap is not the Finish menu's Cap

The Finish menu's **Cap open faces** is unchanged. It closes every open edge
near one *axis-aligned* plane chosen from the loop's extent — only x or z, so
a horizontal lid, which is a y plane, is invisible to it — and winds the cap
by a constant (outward = +axis), so a hole facing −axis comes out wound the
wrong way. It can't be told "this loop only".

The card's **CAP** is therefore not that function: it is `NSO_Patch.cap`, the
flat cap Patch uses for a flat rim, wound from the rim itself (so it is right
whichever way the hole faces, tested on a hole in a floor), in any plane, on
the one loop. The Finish menu's button is still there, still re-scanned by the
card, still one Undo.

## Undo, paint

Each fix is **one Undo** (`patchReplace`, `capReplace`, `bridgeReplace`, rows
in `UNDO_REPLACE_LABEL`), holding the old geometry, raw soup, centre offset and
size, exactly as every bake does. Patch, Cap and Bridge of two loops only
append triangles: **PAINT SCOPE: SUB-REGION**, every existing face untouched.
Bridge of two end faces removes them, so it stands down on any paint and names
the count.

## ADD > Patch

`#btn-patch` in the Add drop-down. Arm it on a piece; hovering outlines the
open loop under the cursor (a hole has nothing to hit, so it is the loop whose
outline the pointer is inside on screen, else the nearest rim within 14 px);
a click fills it. Escape or the button puts it away. The click is Patch's, so
it does not also start a move drag (`nsoPatchTakesClick`, asked in app-core's
pointerdown after Lift). It runs the same `nsoRepairRun` as the card.

## Fix all

`Fix all (n)` runs every item's own fix in the card's order, re-reading the
piece after each (so the second hole's item is the one that is still there),
once per item. The advisory gap is not in it. Each fix is its own Undo; a fix
that cannot run stays on the card, amber, with the tool's own reason
(`Thicken out 0.79 failed - 0.79 mm is more than the feature it grows into`).

## Flags — where this is not what the ticket said

1. **`shape-tube_severed` has no open loop.** The ticket's BRIDGE rule is two
   open loops; the fixture is a closed C (damage.json: 0 open, χ 2) and
   `findings:test` pinned it *clean*. So the gap is detected from the two end
   faces, as advisory (above), and that pin changed from "clean" to "one gap".
2. **CAP is not the Finish menu's Cap.** Above.
3. **A face-to-face dihedral could not be the 5° measure.** Above.
4. **REPAIR and THICKEN OUT are whole-piece.** `NSO_Repair` has no way to
   repair one cluster, and Thicken offsets the whole shell; the row says
   "whole piece" and the button's tooltip says it can't touch one finding only.
5. **The card's rows are per finding now.** A row per *kind* with one button
   became a row per kind with an item per hole / pair / place: the row titles
   (`2 holes, 221 open edges`) and counts are unchanged and pinned.
6. **Check now runs `NSO_Patch.plan` and `.gaps`** (a hundred ms on a few
   thousand triangles); the report carries `repair` and `gaps`. No count and
   no verdict moves.

## Not done, on purpose

- Piercing still has no button. Where a fill crosses another sheet it says so.
- A pair of loops is bridged straight (a strip that adds no point); a curved
  bridge is Bend's job afterwards, as for Bridge.
- Edge → edge sheets (`docs/BRIDGE.md`'s third mode) are not part of this: the
  pair rule above handles open rims and end faces.

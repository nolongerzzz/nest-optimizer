## Attach - Stock + auto-aim + Join's union, in one click (2026-09-19)
`nso_assemble.js` + `app-assemble.js`, loaded at `?v=asm1` - the module after
`nso_support_aim.js` (whose `nearestBase` and `place` it calls), the app layer
after `app-stock.js` (whose control reader it uses). Full write-up:
`docs/ASSEMBLE.md`.

The ticket was "prove composed assembly modelling with the tools that already
exist, and report honestly on what does not compose". It does not compose on
its own, and these are the reasons, all measured:

- **`aim()` cannot aim anything but its own strut.** `buildStrut()` returns a
  square `prism()` and there is no `opts.soup`. A caller with a piece to aim
  has to drop to `nearestBase()` + `place()` and write the sentence between
  them. That sentence is `nso_assemble.js`.
- **The engagement control is at the wrong end.** `place()` seats the solid's
  local origin ON the surface, and `aim()`'s `tipEngageMm` is at the TIP. An
  assembly needs overlap at the ROOT and no root-side control existed.
- **So flush is a coin flip, and curvature decides it.** Same arm, same calls,
  the shipped `NSO_unionSoups`: flat face straight on, flat face at 30 deg and
  a cylinder's flat top all come back 1 part; a cylinder's **curved flank**
  comes back **2 parts, "the two pieces do not touch"**. The flat base cap
  rests on one facet of the 96-gon and the rest of the rim floats. The news
  arrives three calls downstream, out of the boolean, phrased as a Join
  failure - which reads like a bad aim and is not one.
- **There is no outward normal at a picked point.** `closestOnSoup` returns
  `{point, distance}` - no triangle index, no normal - so `nearestBase` cannot
  answer "which way is out of here". The raycast that found the point already
  carries it (`hit.face.normal`), so the DIRECTION IS AN INPUT to `attach()`
  and the app supplies it from the click. Do not grow a second
  nearest-triangle search in the aim module to fix this.
- **What DOES compose, with nothing in between:** the soup format (Stock hands
  back exactly what `nearestBase`, `place` and `NSO_unionSoups` take - no
  conversion anywhere in this feature), the local frame (+Z attach axis, base
  on z = 0, which all three Stock shapes and `prism()` already have, and which
  `baseOf()` checks rather than trusts), Extend's grow-then-turn order, and
  `NSO_Thickness.floorFor`.

The seat depth is MEASURED, not guessed, and out of existing parts:
`rootGapMm` is every base-rim point handed BACK to `nearestBase` against the
body, so there is one nearest-point implementation in play; the margin is
`NSO_Thickness.floorFor` and there is no literal in the file (asserted). On a
96-gon flank the measured 0.626106 mm sits 0.007455 mm above the true
cylinder's closed form, and the difference is named as the inscription rather
than absorbed into a tolerance. `rootGapMm` is the root-side mirror of
`tipPenetrationMm` and exists for the same reason.

Two things a later ticket should read before touching this:
- **The rim-gap rule seats the WHOLE rim, so a rim overhanging an edge drives a
  deep plug** - 3.871 mm gap, 4.291 mm seat, on a 30 deg aim near a box's top
  edge. That is the rule working, not a bug; the fix is mitring the base to
  the surface, which is the contact-geometry layer `nso_seat_surface.js` and
  `nso_support_aim.js` have each already deferred. Solve it once, for all
  three. `opts.engageMm` is the escape hatch and `seatedProud` says so.
- **`tools/nso_csg_node.js` runs the SHIPPED union under node** - app-join.js's
  own `NSO_CSG` IIFE and `NSO_unionSoups`, spliced out by name, against
  `vendor/manifold/`. Only the loader changes (the URL, as
  `tools/csg_bench/run.js` already does, and node's dynamic-import hook). Any
  suite that needs a real boolean headlessly should use it rather than write a
  third adapter.

Task 4 of the ticket, confirmed explicitly: the assembly is an ORDINARY piece.
`NSO_Repair.commit` no-ops it **by identity**; the canonical checker passes all
nine solids the suite writes (chi = 2, 0 open / non-manifold / degenerate /
self-intersecting); Extend's detector picks the assembly's own dominant axis
unprompted and lengthens it with the same 206 triangles; Fatten grows its
cross-section and holds the length. No argument anywhere says "this came out of
a boolean". One named limit: Extend ACROSS the arm's axis is refused by
Extend's own float32 layer gate (`"collapsed 1 of 28 distinct layers"`) - the
plain Stock box takes the same stretch, and the suite asserts both halves so a
future change that makes the assembly special fails rather than rots.

`npm run assemble` (52 checks), `npm run assemble:canonical` (94 checks),
`npm run wire:assemble` (the real app), `npm run csg:node` (the splice itself).
All four in `npm test`.

**app-mask.js now EXPORTS its raw <-> local mapping** (`nsoRawFrameOf`,
`nsoRawPointFromLocal`, `nsoRawDirFromLocal`, and the two inverses) instead of
keeping it private. This app already carried two copies of those eight lines
(app-mask.js and app-brush.js); a third is how they start to disagree, and a
click landing on one face while the bake lands on another is the exact failure
the "read the list, never re-derive it" rule above was written about. A future
ticket needing that mapping takes these.

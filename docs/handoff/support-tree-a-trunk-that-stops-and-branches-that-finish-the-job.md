## Support tree - a trunk that stops, and branches that finish the job

`nso_support_tree.js` (`NSO_SupportTree`), loaded by `index.html` on its own
`?v=tree1` tag after BOTH `nso_support_aim.js` and `nso_path_sweep.js`, because
it calls into both by name and refuses when either is missing. Unwired, like
the two modules it sits on. Full write-up, with every number:
`docs/SUPPORT-TREE.md`.

This is the ticket the two of them named. **Trunk**: `NSO_SupportAim.aim`,
unchanged, handed a computed split point instead of the overhang. **Branches**:
one `NSO_PathSweep.sweep` per contact point, two-point paths. **Union**:
`NSO_unionSoups`, folded left so every step is a genuine merge.

**Nothing about the fan is a setting.** The contact points come out of the
region's own geometry - a square lattice at a measured span, clipped to the
region, topped up until the covering radius is achieved - and the split point
comes out of the fan.

**Both constants were measured off `fixtures/3mf/tabletop.gcode.3mf`**, a real
Bambu tree support already in the repo, and `npm run tree:reference` takes them
out of the G-code again on every run rather than trusting a note about it.
Clustering each support layer's moves into islands reads the structure straight
off the toolpath: **36 islands on every one of 14 layers** (z 0.60-4.50, the
trunk), then **36 -> 451** (the branch phase), then a `Support interface` sheet
at a ~1.09 mm line pitch - which is the 0.61 rib + 0.5 gap
`docs/SKIN-CROSSHATCH-PITCH.md` measured from Bambu's settings, reached
independently from the toolpath.

- `MAX_SPAN_MM = 3.29` = `sqrt(4892 mm^2 / 451 tips)`, the reference's own
  areal contact pitch, inside its own 2.36 mm median / 3.94 mm worst
  nearest-neighbour spacing.
- `BRANCH_TILT_DEG = 31.44` = the widest any tip leans off vertical to reach
  its nearest trunk. **Not** the 45 deg printable angle: that is kept as the
  ceiling, read from `NSO_SupportAim.ANGLE_DEFAULT_DEG`, and asking past it is
  refused by name.

**The raster tracer's sag math does not apply, and that was the audit's
question.** `nso_raster_lines.js`'s "bridge" (`collapseBridges`,
`bridge <= w / sin(t)`) is a SKELETON bridge - the one-pixel stub Zhang-Suen
thinning leaves where two drawn strokes cross, measured in pixels of a source
image. The word is shared; the mathematics is not. What IS reused is
`region.spanMm`, which support-aim's own OUT OF SCOPE 4 reports and declines to
take a view on. The reference has no max-unsupported-span either: its 67 mm
`Bridge` moves are all bridging over the interface directly beneath them.

**Three findings that cost real measurements, so the next ticket does not pay
for them again:**

1. **A contact on the trunk's axis is the trunk's, not a branch's.** A
   symmetric region with an odd lattice count puts one there every time. Built
   as a branch it is a prism coaxial with the trunk, four walls exactly
   coplanar - 2 degenerate triangles and 2 non-manifold edges no weld removes.
   The trunk grows past its split point and takes it.
2. **Branch roots must be spread across the trunk, not stacked on its axis.**
   Two branches sharing a start point meet along a curve that pinches to
   nothing there, and `manifoldToSoup` writes float32 (~2e-6 mm at plate
   coordinates), so the pinch collapses into a repeated vertex. 0.4 x side
   across - under the 0.5 half-width, so the root centre is still inside the
   trunk - takes the 28-branch fixture from 2 degenerate / 6 non-manifold to
   0 / 0 and the 8-branch one from 1 / 2 to 0 / 0. The 16-branch fixture is
   clean either way, so this needed measuring on more than one. At 0.45 a
   piercing pair appears instead.
3. **The clearance test needs the rails, not just the axis.** A branch
   threading a gap narrower than itself has a clear centre line and a body
   through the wall. The sweep already built the rails; five rays now, and the
   suite proves it with a 0.8 mm window centred on a real branch's axis. The
   rails are tested over the SHAFT - the last cross-section is left out,
   because a flat cap on an oblique branch stands proud of its target BY
   DESIGN. Before that exclusion, every branch on every fixture was "blocked
   0.4 mm short" by the overhang it was aiming at.

**The weld radius is derived, not dialled.** `mesh_validate.py` identifies
vertices inside 1e-4 mm, which is right for a part and too coarse for a
BOOLEAN's output: two 1.2 mm prisms crossing shallowly meet along a curve whose
vertices land microns apart. `tree:canonical` measures each solid's closest
distinct vertex pair, derives the weld by `NSO_weldEpsFor`'s own
`min(want, shortest/3)` rule, and validates there - then runs the default weld
as well and asserts the difference is only ever of that one kind (0 open, 0
degenerate, 0 self-intersections either way; the shelf's default weld merges 5
of 392 vertices). Same conclusion `docs/CSG_INTEGRATION.md` reached from the
other end.

`npm run tree:test` (59 checks, incl. the union through the shipped kernel),
`npm run tree:canonical` (123 checks through `tools/mesh_validate.py`),
`npm run tree:reference` (21 checks against the real slice, ~5 s). All three in
`npm test`.

**Still out of scope, named:** a FIELD of trunks (this builds one and refuses
by name - naming the count - when one is not enough; the reference used 36
where this asks for 25); branches that merge or bend; contact geometry (a
branch ends in the same flat cap, and reports the same `tipPenetrationMm`).

PAINT SCOPE: **sub-region, inherited**. Detection is `nso_support_aim.js`'s, so
`opts.skipList` is REQUIRED here for the same reasons and is passed straight
through. This file names no faces of its own - every contact sits on a triangle
`detectOverhangs` already flagged - so it takes no new row in the roster above.

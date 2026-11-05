## Curving paths - the first multi-segment path primitive
`nso_path_sweep.js`, loaded from `index.html` next to the other parked modules.
**Not wired in**: one global, `NSO_PathSweep`, and no UI, bake or undo entry.
Full write-up, including the pose-system audit that preceded it:
`docs/CURVING-PATH.md`.

The audit, in one line: **a pose is nine loose scalars** (`x`, `z`, `rotY`,
`flipX`, `tipX`, `tipZ`, `tiltX`, `tiltZ`, `liftY`) read back by
`applyMeshRotation()` as a fixed-order XYZ Euler plus a bbox-derived rest
height. It is not composable, its Y is not free, it carries no tangent or
frame, and it describes a whole placed instance rather than geometry inside a
piece. `tools/nso_pose_after_bake_test.js` reached the same root cause from the
other end and found it already biting - a COMPOSITE pose disagrees between
viewport and exporter with no bake near it, because the two compose their
rotations in opposite orders. Nine loose scalars with no composition rule is
the shape of defect that produces.

Corrected at the merge, and the correction matters both ways. The audit first
said "there is no curve object of any kind", which was true at `2a6d07a` and is
false here: the Pottery Wheel fits a monotone cubic Hermite, the toolpath
importer carries real 3D polylines, and skin bands use closed polylines. None
of them is an ORIENTED 3D PATH WITH A MOVING FRAME - the wheel's curve lives in
the (z, r) half-plane and revolves about a fixed axis, the toolpath importer
renders each move as its own closed box with no continuity between moves (by
design: it is a renderer), and a band rim is a parameter curve on a surface
that already exists. The gap is real. But `NSO_Carve.probeTarget()` IS a real
oriented frame at an arbitrary surface point (`outward`, `tangent`,
`surfacePoint`), which is exactly what a branch-attachment ticket needs for its
first station - start there, do not measure a surface again.

What it is: a mitred polyline sweep. N path points plus one convex profile ->
a watertight soup. The correctness argument is Extend's (`n.u = 0` means the
wall's plane contains `u`) carried round a corner: every wall is a planar quad
on two rails parallel to its segment, and a joint's ring is the bisector-plane
miter, which both adjacent segments reach identically - so there is no seam and
no weld tolerance in the construction at all.

Three results the next ticket should not have to rediscover:

- **A bend stretches the section by `1/cos(turn/2)`, and that cannot be
  removed.** One watertight shell and an exactly perpendicular section at a
  joint are mutually exclusive. 41% at 90 degrees.
- **Rounding a corner costs MORE segment than mitring it, never less.** An arc
  of radius R needs `R*tan(t/2)` of tangent where a miter needs `r*tan(t/2)`,
  and R has to exceed r, because you cannot bend a tube tighter than its own
  section. `arcSubdivide()` buys accuracy (quadratically), not feasibility.
  The ticket's premise assumed otherwise; the measurement corrected it.
- **A tree is a graph, not a path.** A Y-junction has no bisector plane, so the
  whole construction is undefined there. Recommendation: sweep the strands,
  and union them at the junctions with `NSO_CSG`, which is already live in
  `app-join.js`. Do not try to make the sweep grow a Y.

`npm run pathsweep:test` (63 checks: geometry, tolerances, refusals, plus two
probes that measure rather than assert) and `npm run pathsweep:canonical`
(8 stages, each written to a real STL and handed to
`tools/stl_watertight_check.py --odd --degen`, plus a negative control that
proves the checker bites). Both in `npm test`, both dependency-free node.

PAINT SCOPE: **not applicable** - it is a generator, not a bake, so it takes no
row in the roster above. The feature that eventually attaches a branch to a
piece is the paint-aware one and inherits the rule then.

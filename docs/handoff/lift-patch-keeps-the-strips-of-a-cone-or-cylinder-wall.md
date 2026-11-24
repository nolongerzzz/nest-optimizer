## Lift - the patch left where a pin stood keeps the wall's strips (cone, cylinder) (2026-11-07)

Write-up: `docs/LIFT.md` ("On a wall of long strips the patch is strips too"). Changed: `nso_lift_curved.js` only - `fill` is now a wrapper
over `fillCore`; `stripMetric(M, edges, e1, e2)` reads the long thin triangles across the root edges; `Tri.incircle` measures in that metric
(`D.st`); in strip mode there is no lattice inside, and a sag check (`stripSagMm` 0.03) sends it back to the even fill. `surfaceCut` asks for
strips only on a smooth fit (`smoothFit`); `deps.noStrips` turns it off (the tests compare). New fixture `fixtures/crop-wall/cylinder_bump.stl`
(`tools/nso_crop_wall_fixtures.js`): R15 x 30 cylinder, a Ø4 pin 4 mm proud half way up. Gates: `lift:curved-surface` section 6 (headless),
`lift:list` section 7 and 3 (real app) - cone 58 triangles all along the strips, cylinder 54 all along, 0.005 / 0.008 mm off the wall; sphere
unchanged (268). All Lift node suites and drives pass.

Things worth knowing:
- *The owner's cone was a hub of spokes because of Delaunay, not because of the positions*: the corners were already exact. The fix is the metric.
- *The first cylinder fixture was an R3 dome centred on the wall, which Lift refuses* ("wraps ... turns 85 degrees"): a hemisphere's root turns a
  quarter turn. A pin square to the wall (as on the cone) is liftable; use that for anything Lift is to be tried on.
- *One direction per hole.* A big hole on a cone, where the strips fan out, fails the agreement test (0.85) and takes the even fill - the old
  behaviour, no worse. A direction that varies across the hole (from the base fit's zero-curvature direction) is the way to extend it.
- *The ladder is as fine as the rim* (a Ø4 pin cut at 48 segments gives triangles 0.26 mm wide and 4 mm long, against 1 mm strips round
  it). Coarser would mean dropping rim corners, which the weld forbids.

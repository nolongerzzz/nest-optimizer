# Steady chuck

A three-jaw steady rest you drop over a thin, tall print mid-job (the owner's CR-TPU capsule, 2026-11-25). The jaws touch the stem
just below the layer being printed, so the nozzle stops dragging the tip around. It stands on three legs glued to the plate, so it
moves with the bed.

Print in PLA or PETG, 0.2 mm layers, no supports, every part flat as it comes:

| File | Count |
| --- | --- |
| `chuck_base.stl` | 1 |
| `chuck_cam_ring.stl` | 1 |
| `chuck_jaw_x3.stl` | 3 |
| `chuck_foot_x3.stl` | 3 |
| `chuck_leg_<L>mm_x3.stl` | 3 of one length (15 - 95 mm) |

Assembly: the jaws go into the base's channels with their pins up and their points in. Turn all three so the pins line up with the ends
of the cam ring's slots, and lay the ring on top. Turning the ring counter-clockwise (seen from above) closes the jaws, from 18 mm
open to touching. The pointer notch shows where the ring is. Press the legs into the base's hex sockets and the feet onto the legs.

Heights, legs of length L: the jaws grip at about L mm, and the head's top is at about L + 5 mm.

Use:
1. Slice with **Pause at** (the Print card, under Printer and filament) at least 3 mm above the head's top, for example legs 45 → Pause
   at 53. The printer retracts, lifts 5 mm and parks, then pauses.
2. Open the jaws. Lower the stand over the stem from the top, with a little glue stick under each foot, but don't press it down yet.
3. Turn the ring slowly until all three jaws just touch the stem. The stand centres itself on the stem. Don't squeeze: the jaws
   should touch, not push. Then press the feet down.
4. Check that the toolhead clears the head (60 mm wide, its top 3 mm or more below the nozzle), then resume.
5. For more height, pause again, swap to longer legs and repeat.

Regenerate: `python3 make_chuck.py <out dir>` (needs `pip install manifold3d trimesh numpy`).

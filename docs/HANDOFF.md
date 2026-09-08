# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`. Never merge PR #4.
After every pass: comment counts on PR #4.

## Standing ticket — Soften Corners open edges

Function: `rawEdgeRoundInPlace` wall-rewrite in `app-cut.js`
(the `wallTriIdx` loop that moves cap-plane verts by `pullbackDepth`).

Bug: Corners per-vertex R leaves 24 open edges. Wall keeps one straight
top edge; ring is a polyline. Split that edge against the loop vertices,
then pull each new vertex by its own R.

Do not touch cap-face writes. Cap stays at `capPlane`.
No `marginPlane` / `rawClipTrianglesAtPlane` / Rmax retract.
No Square cut, Join, Seat, Subtract, Extract, Thicken, Solidify, pack, UI.

Verify:
```
python3 tools/stl_watertight_check.py fixtures/box-20mm.stl --odd --degen
# Square split box-20mm, Soften Corners R=0.5
python3 tools/stl_watertight_check.py fixtures/out-box-corners-r05.stl --odd --degen
```
Pass: lid on cut plane; four corners 0.5 / wall mids 0; open=0 NM=0 degen=0.
Also check Round and Bevel on the same half stay 0 odd.

## User role
Steer + live click test only. No file upload. No snippet paste.

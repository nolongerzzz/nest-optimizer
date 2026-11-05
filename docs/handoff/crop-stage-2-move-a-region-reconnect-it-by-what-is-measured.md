## Crop, stage 2 - move a region, reconnect it by what is measured (2026-09-26)

Branch `claude/crop-stage2-move`, off `claude-wip`. Full write-up:
`docs/CROP.md`, "Stage 2".

- **What.** The Crop box now selects a region (Up / Across narrow it across
  the section). Lift shows it as a ghost; drag it (camera-facing plane) or
  type ΔX ΔY ΔZ; **Lock in** reconnects it. The branch is MEASURED at lock-in:
  overlap → trim (`NSO_unionSoups`), touch → the same union, gap ≤ 3 mm →
  bridge (a closing of the two parts on Hollow's surface nets), else refused
  by name: gap too wide, region > 90 % buried, piece left in more parts, or
  the checker gate.
- **Where the kernel runs.** A slab along the cut axis only: cut out with
  `rawCut`, reconnected, spliced back with Stage 1's `NSO_cropSeal`. Outside
  it every vertex is Cut's clipped half's.
- **The seam-cap class, again, and how it is kept out.** A union that crosses
  the Mirror-Join's sliver fans leaves sub-1e-4 vertices (v9: non-manifold
  2 → 78). The lifted region is re-meshed by `Manifold.simplify` before it
  moves, and the reconnected slab is welded at Cut's radius. `simplify` on
  the SLAB is out: it collapsed a cap-outline vertex and broke the splice.
- **Acceptance** (`crop:move` §3-4): the v9 −Y lip, X 74..86 next to the
  +seam, to the +Y side at the same X. Own height → bridged (0.897 mm gap);
  2 mm down → trimmed (11.54 mm³). The box face exactly on the +seam ring,
  and the same span at the −seam, also pass. Every result PASSes
  mesh_validate.py with self-intersection, and has 0 defects near either
  seam ring. The source has 2 nm / 5 inc there. Split through the seam ring
  and the landing stays clean. Too extreme → refused: 6.90 mm gap, 96 %
  buried, > 10 mm.
- **Reuse.** `nso_hollow.js` exports `edt3d`, `surfaceNets`, `tidyPositive`.
  `NSO_Repair.inspect` gates the headless core too, not only the app.
- Checks: new `crop:move`, `wire:crop-move`.
- **`?v=`**: bumped in the cache-tag batch above (PR #115).
- **Not yet:** a region crossing BOTH seams (the next stress test), rotation,
  a region at the very end (Stage 1's axis clamp), and mixed contact (overlap
  here, gap there) in one move.

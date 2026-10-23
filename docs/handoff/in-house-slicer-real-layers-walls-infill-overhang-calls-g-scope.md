## In-house slicer - real layers, walls, infill, overhang calls; G-scope Slice (2026-09-27)
Branch `claude/inhouse-slicer`, off `claude-wip`. Full write-up:
**`docs/SLICER.md`**. For reverse-engineering and internal iteration.

- **Geometry:** Clipper2 (BSL-1.0), which is ALREADY compiled into the vendored
  `manifold.wasm` (Apache-2.0) as `CrossSection`. No new dependency. Lockfile
  and wasm audited: no GPL / AGPL in the chain. Every slicer rule is fitted to
  real Bambu G-code OUTPUT, cited; no slicer source was ported.
- **Core (`nso_slicer.js`):** exact edge-keyed sections (= `Manifold.slice`
  to 1e-9 on six repo meshes), walls by measured offsets, top / bottom shells,
  grid / zigzag / lines infill by density, per-layer overhang regions (plate /
  model / both), per-layer object conflicts, Bambu-tagged G-code.
- **Measured constants** wired in with sources (`CONSTANTS`): 0.42 / 0.63
  walls, taper law, the 0.182 gap, interface 0.42 @ 1.2 (NSO) vs 0.61 @ 1.09
  (Bambu), 30 deg threshold.
- **Validation (`slicer:bambu`, 51 checks):** the two real slices,
  reconstructed from independent evidence. Wall-loop count matches Bambu on
  121 / 121 object layers, inner walls to 0.001 mm, support-need calls on both
  pieces. It reproduces Bambu's tape-artifact overlap at layer 91. Seven
  findings are recorded, including: detectOverhangs calls a support need over
  the piece itself "self-supported" (Bambu supported it); Bambu thins the 3rd
  shell over a bridge (not built); the tape tree's 0.42 walls vanish at 0.63
  lines.
- **G-scope Slice** (`app-gscope-slice.js`): on any mesh document. G-code text
  goes through `parseGcode` into `openToolpathResult`, the import's own entry,
  so every G-scope tool works unchanged (`gcode:gscope-slice`, 35 checks, real
  clicks). Paint scope none; reads `nsoNonSolid`.
- **Found, not fixed:** `parseGcode` stamps `layers[i].z` one layer late
  (moves' z are right).
- **`?v=`:** new files at `slice1` (`nso_slicer.js`, `app-gscope-slice.js`);
  no existing tag touched (rule 4). `index.html` gains the Slice row.

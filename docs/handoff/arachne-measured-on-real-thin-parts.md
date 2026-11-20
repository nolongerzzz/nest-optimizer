## Arachne measured on real thin parts: Studio's counts, widths and minimum, to within 1 % (2026-11-20)

The owner sent two Studio projects with their meshes and Studio's own Arachne and Classic slices:
- Erik's wall-thickness benchmark ("walls tester": tubes 0.2–1.6 mm, L legs 0.4–3.2 mm, raised digits);
- a board of thin bars (0.15–2.0 mm).

Each mesh was sliced with its project's settings and compared island by island, layer by layer.

Changed in `nso_slicer.js` `arachneWalls`:
- **Thickness:** a piece's typical one. Area and outline of a rectangle when it has no hole (exact for a strip or an L),
  of a ring when it has holes (exact for a tube), not its deepest point.
- **The count:** nominal walls from the outside in, while a middle of at least 0.75 × the inner line is left; that middle
  is one wall up to 1.65 × the line, then a pair. At most two walls a loop.
- **Distribution count 1:** only the middle varies; outer walls keep 0.42 (a 1.4 mm tube: 0.42 / 0.64 / 0.42, Studio's).
- **Minimum wall width:** 85 % of the inner wall's line (0.38), not the nozzle (0.34).
- **A dot:** a 0.8 mm decimal point is one short 0.42 bead.

Also changed, in Classic too:
- **Narrow sparse strips:** they go solid only where they border solid infill. Studio keeps a strip between walls
  sparse down to 0.52 mm. This re-pinned `hinge_knuckle_box` @0.4 and `shape-torus` @0.6 in `slicer:test`.
  `slicer:bambu` is unchanged.

**Results:**
- Every test piece's walls are within 2 % of Studio's plastic and 0.015 mm of its mean width: 74 sections, worst 1.0 % /
  0.008 mm (`slicer:test` "Arachne, measured", `fixtures/slicer-arachne-reference.json`, remade by
  `tools/nso_slicer_arachne_reference.js`; the meshes are not kept).
- Whole prints: −1.7 % and −1.1 % of Studio's plastic, in the infill and shells.
- The comparison scales NSO's widths by the project's flow ratio (PLA 0.98, PETG 0.94): Studio's G-code carries it, and
  NSO's planner applies it.

**Not done:**
- Studio's Classic **Gap infill** (7,482 and 4,113 plastic units of length × width here): NSO's Classic has none.
- Studio draws the digit 8 with pairs of thin walls, NSO with one: a local-shape decision at its junctions.

`slicer:test` 192, `slicer:bambu` 58, `print:slice` 188, support and brim suites pass. Docs: `docs/SLICER.md` "Arachne",
"Narrow sparse strips".

## Repair loop - Patch, Cap and Bridge from the Findings card (2026-10-16)

Write-up: `docs/PATCH.md`. Files: `nso_patch.js`, `app-patch.js`,
`nso-findings.js` / `app-findings.js` (items per finding, Fix all),
`nso-defects.js` (`report.repair`, `report.gaps`), `tools/nso_repair_loop_*.js`,
`fixtures/repair/box_lid_hole.stl`. `npm run repair:loop`, `findings:drive` (section 9).

PAINT SCOPE: **SUB-REGION** (`app-patch.js`): Patch, Cap and Bridge of two open
loops only append triangles, every existing face is kept byte for byte; Bridge
of two end faces removes them and stands down on any paint.

Three things to keep:

- **The card's CAP is `NSO_Patch.cap`, not the Finish menu's Cap open faces.**
  That one only sees x/z planes (a horizontal lid is a y plane) and winds its
  cap by a constant, so a hole facing -axis is wound wrong. It is untouched.
- **A severed tube has no open loop** (`shape-tube_severed` is a closed C).
  Its BRIDGE comes from `NSO_Patch.gaps`, two convex end faces facing each
  other, **advisory**: never a verdict, never in Fix all.
- **"Rim normals within 5 degrees" is the step in the smooth-shading normal at
  the rim vertices**, not a face-to-face dihedral (the undamaged faceted sphere
  has 10.9 degrees there). Patch 3.5, a flat cap 6.2.

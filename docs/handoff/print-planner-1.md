## Print planner: NSO writes Bambu's dialect (print-planner-1, #277)
`nso-print-planner.js` turns `sliceObjects()` into the G-code Bambu Studio writes
for the same plate; `toGcode3mf()` wraps it through `nso-gcode3mf-write.js`.
Engine only: no card, nothing in the page loads it, `toGcode()` is untouched.
Full write-up, decisions and the gap list: `docs/PRINT-PLANNER.md`.

- **Gate:** `npm run print:planner` (127 checks, `tools/print-planner/`). It holds
  the planner to the owner's Studio slices: `top_clip_x2_supports` (A1 mini),
  `simple_overhang_bambu` (A1 mini, copied in from the `supports-*` branches),
  `simple_overhang_p1s` (P1S).
- **Frozen start/end:** `fixtures/print-planner/<printer>/frozen.json`, made by
  `node tools/print-planner/freeze.js` from the slice Studio expanded. A new bed
  type or filament volumetric limit means a new freeze from a new Studio slice.
  The gate requires the committed JSON to be a fresh freeze.
- **Time:** `estimateLines` is within 5 % of Studio's own prediction on its own
  G-code (0.958 / 0.971 / 1.029); the planner's M73 and `slice_info` use it.
- **Touches page-loaded code:** `nso-3mf.js` exports `overlayProjectSettings`.
- **Not done (engine):** Gap infill, Floating vertical shell, the 0.5 mm first
  layer line, sparse in narrow bodies. **Not done (packager):** one-object plates
  get no `plate_1.json` footprints. The M624 mask for a third object is by the
  same law as the first two, unconfirmed.
- **Owner test:** a small coupon on the A1 mini, watched; then the two-piece plate
  with NSO supports.

## Supports export without inner filler (2026-10-23)
`NSO_SupportInterface.SHEET.slicerSettings` (`nso_support_interface.js`,
`SHEET_SLICER`) gains `sparse_infill_density = 0%` and `wall_loops = 1`, so
every support object in the Bambu project export carries four overrides:
`wall_generator classic`, `detect_thin_wall 1`, and those two. Export override
only: no support geometry, planner, interface-layer or slicer change, and top /
bottom shell layers stay at the profile's values (`bottom_shell_layers 0`
failed a print on 10-21). Check: `npm run export:bambu` reads the two keys back
from the written project on every support object and on no part object.
The print is the gate (docs/BAMBU-PROJECT-EXPORT.md): if a loop-only trunk
fails, the change comes out whole.

## Supports sheet everywhere - a sheet under every tip, at any yaw and tip (2026-10-26)
Branch `claude/supports-sheet-everywhere`. Engine only: `nso_support_interface.js` (THE STAIR,
the last resort, low room, `bare` / `notes`), `nso_support_gridpack.js` (summary fields),
`tools/nso_support_everywhere_check.js` (`support:everywhere`), `tools/nso_support_ref_pieces.js`,
`fixtures/supports/tree_slimsupports.gcode.3mf`, `docs/SUPPORT-INTERFACE.md` section 8.

- **The path that skipped the sheet:** `sheet()` -> THE STAIR. Tipped, no level forms (every tip its own
  height); the stair then failed silently (strips would not extrude; one strip's gap dropped the whole
  stair; leftover tips never asked again; join distance from the median spacing).
- **Changes:** see section 8's table. All act only where a tip would otherwise be bare, so the coupon,
  `top_clip_x2` and the library tape flat hash as before (`fb53cfefd9e4a9a6`, `02200ffddb7059c7`, `cdd2a946ee785617`).
- **Not done:** the card does not show `tp.sheet.notes`; the G-scope row builds no sheet; the flat sheet's
  dependence on where the piece stands (105 of 396 tape tips bare at yaw 45 centred, the same at 413be05).
- **Speed** untouched (supports-stair-speed): the tape at yaw 45 + tip 15 is minutes; reproduced by hand with
  `node tools/nso_support_everywhere_check.js --quick --tape`, not a step.

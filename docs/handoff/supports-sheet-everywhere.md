## Supports sheet everywhere - a sheet under every tip, at any yaw and tip (2026-10-26)
Branch `claude/supports-sheet-everywhere` (#301). Engine only: `nso_support_interface.js` (THE STAIR,
the last resort, low room, `bare` / `uncarried` / `notes`, sideways clearance), `nso_support_gridpack.js`
(summary fields), `tools/nso_support_everywhere_check.js` (`support:everywhere`),
`tools/nso_support_ref_pieces.js`, `fixtures/supports/tree_slimsupports.gcode.3mf` (Bambu's slice) and
`fixtures/supports/supp_ref.3mf` (the six real parts), `docs/SUPPORT-INTERFACE.md` section 8.

- **The path that skipped the sheet:** `sheet()` -> THE STAIR. Tipped, no level forms (every tip its own
  height); the stair then failed silently (strips would not extrude; one strip's gap dropped the whole
  stair; leftover tips never asked again; join distance from the median spacing).
- **Follow-up, real parts + sideways clearance.** The first round planned against six stand-ins fitted to
  the slice's walls (`tools/nso_support_ref_pieces.js`, heightfields). The owner's project is committed now
  (`supp_ref.3mf`) and the same file reads the six meshes from it; the stand-ins are gone (a copy of the old
  file is in the history, commit 44ac97d). Matched to the slice by name and position, per part.
  Section 8 has the per-part reference, ours, and the table.
- **Sideways clearance** (`support_object_xy_distance` 0.35): the gap is a distance to the surface, which a
  strip inside the part passes. A strip is also cut against the part's section at its layer
  (`sectionAt` / `sideShort`, `XY_CLEAR_MM`). Smallest support-to-part line distance over the 24 poses:
  0.00 mm before (oblique tip 15, negsphere yaw 45 + tip 15), 0.41 mm after.
- **Named, not silent:** `tp.sheet.bare`, `.uncarried` (now also "its sheet lies too far under it":
  `HELD_TOP_MM` / `HELD_FLAT_MM`) and `.notes`. Still bare: a tipped piece's low edge (under ~1.9 mm of the
  plate), and 3 - 6 tips on each tipped dome (Circular, the Negative Spheres).
- **Files for Studio:** `node tools/nso_support_everywhere_check.js` writes `tools/supports-everywhere-out/
  supp_ref_{flat,yaw45,tip15,yaw45_tip15}.3mf` (six parts and their supports, inside the bed; not committed).
  Slice them: zero "conflicts of gcode paths" is the check that is the owner's to run.
- All of it acts only where a tip would otherwise be bare, so the coupon, `top_clip_x2` and the library tape
  flat hash as before (`fb53cfefd9e4a9a6`, `02200ffddb7059c7`, `cdd2a946ee785617`).
- **Not done:** the card does not show `tp.sheet.notes`; the G-scope row builds no sheet; the flat sheet's
  dependence on where the piece stands (105 of 396 tape tips bare at yaw 45 centred, the same at 413be05).
- **Speed** untouched (supports-stair-speed): the tape at yaw 45 + tip 15 is minutes; reproduced by hand with
  `node tools/nso_support_everywhere_check.js --quick --tape`, not a step. The gate itself is ~5 min
  (6 real parts x 4 poses, sliced).

## Slice: the piece stays exportable while its slice is shown (2026-09-27)
Branch `claude/slicer-piece-export`, off `claude-wip`.

- **Export.** While a slice is shown, the Slice section keeps **Export piece
  to plate** and **Export piece as STL** for the piece(s) it was made from,
  with no selection needed and no Back first. Before this, the slice replaced
  G-scope's document, so the piece was only exportable after Back to the
  mesh. Same geometry, name and calls as G-scope's own export of a loaded
  piece. `gcode:gscope-slice` §8 checks it with real clicks: the downloaded
  STL and the plate copy carry the piece's exact triangles, and Undo removes
  the plate copy.
- **Standing rule recorded** above: ask before adding any restriction, warning
  or behaviour change that wasn't specified.
- **Purpose line kept:** the slicer is described as being for
  reverse-engineering and internal iteration (header, SLICER.md, README).
- **`?v=` not bumped** (rule 4): `nso_slicer.js` and `app-gscope-slice.js`
  (both `slice1`) need a bump at merge.

## Tube edge - Flare and Roll on the open end of a tube (2026-10-14)
`nso_tube_edge.js` (headless) and `app-tube-edge.js` (the card), loaded after
`app-bend.js` at `?v=tube1`. UI is a **Tube edge** button beside Bend in the
Finish menu's Shape group, opening a small card (Verb, Way, Length / Angle /
Δr / Profile or Radius / Angle, Set, Cancel) with a live ghost and an amber
ring on the end being treated. Full write-up: `docs/TUBE-EDGE.md`.

The end is a flat face bounded by two concentric circles, read with the
section reader's own circle fit. The wall is swept round the tube's axis along
a meridian curve - a cone, a parabolic "trumpet" or a circular roll - with one
face the other's offset by the wall, so the wall holds through the new section
(gated at 0.02 mm). Before a later ticket touches it:
- **Station 0 is the end loop**, every vertex carried along its own radial
  line: no weld at the join. The end face is the only thing removed.
- **The thin-wall rule is a hoop stretch**: wall × (ring radius ÷ largest
  mid-wall radius) must stay at or above 2 nozzle widths. The model itself
  keeps the wall; the rule is the user's guard on what forming would do.
- **Touch means one nozzle width**, checked as a 2D distance in each point's
  meridian (the new wall is a surface of revolution), except within 2.5
  nozzle widths of the end ring, where the new wall must meet the old.
- **Inward and non-circular ends are refused**, by name; inward is a later ticket.

**Neck** (2026-10-15) is the card's third verb: `nso_tube_neck.js`, loaded
after `nso_tube_edge.js` at `?v=neck1`. A pinch (Δr < 0) or a bulge anywhere
along the tube, a band of the given Length centred where the tube is clicked,
Smooth (cosine) or Funnel (straight in, straight out), the wall carried exactly
the same way. Before a later ticket touches it:
- **The axis is Tube edge's end reader**; the wall across the band must be two
  cylinders about it (normals square to the axis, one radius each). Anything
  else there - a neck already made, a taper, the end - refuses, naming where
  the wall stops being straight. That is how **necks may not overlap**.
- **Δr is a change of radius**, as Flare's is. The bore limit: a pinch may
  narrow the bore to no less than 2 nozzle widths across.
- **Each face's band is rebuilt between two whole rings** of its vertices; the
  lower ring is carried up (no weld) and the last station zipped to the upper
  ring by angle. Each neck is its own commit and its own Undo
  (`tubeNeckReplace`). `npm run tube:neck`; screenshots from
  `TUBE_NECK_SHOTS=dir npm run tube:neck-shots` (not a test step).
- **The neck is dragged** (2026-10-19, `app-tube-edge.js?v=neckdrag1`): its
  three rings are handles - the two END rings stretch the band (Length moves
  twice the drag, centre held), the WAIST ring is Δr (toward the axis pinches),
  the BAND between the end rings slides the neck along the axis; 0.5 mm steps,
  0.1 with Shift. Arrows while the card is open: Up / Down the band 1 mm, Left
  / Right Δr; Escape puts a drag back, then shuts the card. The handles draw
  from the read and the fields (`NSO_teNeckGeom`), not the last result, so
  they stay up through a refusal. The press is taken at the window (capture),
  so no drag reaches OrbitControls. UI only: `nso_tube_neck.js` is unchanged.
  Gates: `tools/nso_tube_neck_drag_check.js`, chained into `npm run tube:neck`.

- **Walls and the inward flare** (2026-10-20, `?v=walls1` on all three Tube
  edge files): `opts.walls` on Flare and Neck - Both (default; output
  byte-identical to before, SHA-1-pinned), Outside only, Bore only (that face
  moves by Δr, the other kept bit for bit, the wall changes; refused under
  `NSO_Thickness.floorFor` or where the faces cross). Neck with one face may
  reach an end: a counterbore / spigot, stepped square at Length in. Flare
  takes Δr < 0 or Way In: inward, the outward construction mirrored, the bore
  leading. The card's `sel-te-walls` is read when present; the UI PR draws
  it. `docs/TUBE-EDGE.md`, "Walls".
- **Flare is dragged** (2026-10-20, `app-tube-edge.js?v=enddrag1`): the Walls
  select is on the card (hidden for Roll). Flare has a LIP ring handle:
  toward or away from the axis is Δr (negative turns it in), along the axis is
  Length. Arrows, Shift and Escape work as Neck's. Handles sit on the moving
  face (the mid-line for a Flare with Both), and hover names the face. Gates:
  sections 8-10 of `tools/nso_tube_neck_drag_check.js`.
- **Run, the reducer and the expander** (2026-10-20, `?v=run1` on
  `nso_tube_edge.js` and `app-tube-edge.js`): `opts.runMm` on Flare adds a
  straight tube past the lip. Its outside and bore are exactly the lip's, it
  runs parallel to the axis Run mm from the lip's plane, and its end is square
  and open. It is one more station on each face, sharing the lip ring's edges.
  Run 0 is byte-identical (SHA-1-pinned). Roll refuses a Run in words, and a
  run's bore is held to the inward-flare bore limit. The card's `inp-te-run`
  is read when present; the UI PR draws it. `docs/TUBE-EDGE.md`, "Run".
- **Run on the card** (2026-10-20, `app-tube-edge.js?v=runcard1`): a Run field
  under Length (Flare only, 0 by default), and an END ring at the run's far
  end that drags along the axis = Run. Hover says `Run 30.0 mm`. Up / Down
  step the Run while the END ring was the last handle touched, and the Length
  otherwise. There is no END ring at Run 0. Gates: section 11 of
  `tools/nso_tube_neck_drag_check.js`.

`npm run tube:edges` (headless) and `npm run tube:edges-drive` (real app),
both in `npm test`.

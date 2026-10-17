# Connect

A column card between Crop and Join. Bridge (in Add) stays the quick gap-fill,
where the two picks decide the shape. Connect is the builder: the two picks are
only WHERE, the card decides WHAT runs between them, and the result can be a
piece of its own.

Files: `nso_connect.js` (engine, headless), `app-connect.js` (the card),
`tools/nso_connect_test.js` (`npm run connect:test`), `tools/nso_connect_drive.js`
(`npm run connect:drive`, screenshots to `tools/connect-out/`, git-ignored).

## Opening and closing: no gate

The Connect column button is the switch. One click opens the card and arms the
anchor picks (hover lights a target, the first click is A) - there is no
"Connect" button inside it to press first. The card closes, and the picks, the
ghost and the hover go with it, when you press the column button again, press
Escape with nothing picked (the first Escape drops the picks, as it always did),
press Cancel with nothing picked, open another column button, or double-click
the plate. `tools/nso_page_manifest_test.js` keeps it that way: no column card
may be a single button that only toggles another panel.

## Picking: two clicks

Click anchor A on a piece; it stays marked. Orbit, pan and zoom as much as you
like - nothing is held and nothing captures the pointer - and a line from A
follows the pointer. Click anchor B: the connector is built and previewed as a
ghost (Bridge's amber). Clicking an anchor again clears it; a click on nothing
(an orbit drag does not count) and Escape clear the picks; with both set, a click
on a new place replaces B.

A press that starts on a piece is Connect's while the card is open (otherwise it
would select the piece and begin a move drag under the click). A press that
starts anywhere else is never touched.

The pick is Bridge's own (`NSO_Bridge.pick`) and so is its overlay
(`NSO_bridgeTargetAt`, `NSO_bridgeTargetObject`); `app-connect.js` calls them,
`app-bridge.js` is untouched.

| anchor | is                                                               |
|--------|------------------------------------------------------------------|
| point  | the point, the surface normal there                              |
| face   | the face's centroid, the face's normal                           |
| edge   | its midpoint (String, Tube, Tapered), its full length (Ribbon); leaves along the bisector of the edge's two faces |

A and B may be on one piece or two.

## Shapes

| shape   | fields (defaults)             | notes |
|---------|-------------------------------|-------|
| String  | Ø (2)                         | a round rod |
| Ribbon  | width × thickness (6 × 1.2)   | the flat face is perpendicular to the average of the two anchor normals: the thickness runs along that average (what is left of it across the path). Two facing normals average to nothing; then the ribbon lies level (thin along Z) |
| Tube    | Ø × wall (4 × 0.8)            | a closed hollow rod: the bore is sealed, a wall clear of both surfaces, so it pierces neither anchor. In a weld it rides through the union as an internal void |
| Tapered | Ø at A, Ø at B (4 → 1.5)      | a true cone; in a weld it is run on into both pieces |

The path is straight. (Arc and Drape, and end treatments, are later tickets.)

## Result

- **Weld into A and B** - both ends sunk and unioned exactly as Bridge's string:
  sunk by the rim gap (`NSO_Assemble.rootGap`) plus `sinkMm` (0.5), the same leave
  angle (the line must leave each surface at least 10° off it), the boolean
  `NSO_unionSoups` through `NSO_Bridge.weld`'s own two steps and closed-solid check.
- **Keep separate** - no boolean. The connector is its own closed piece, each end
  cut flush with the plane of the surface it meets (no sink), listed in PLATE &
  PIECES, grabbable. One Undo takes it off.

## Refused, in words

An anchor is missing; the straight connector passes through a third piece (or
through A's or B's own piece); a Ribbon wider than twice the shorter anchor edge;
a Tube whose wall is half its Ø or more (no bore) or that is too short for its
bore; a line that leaves a surface along it or into it; a connector shorter than
its own width; a taper that would close to a point inside a piece.

## Notes for the next tickets

- Wall triangles are cut every 2 mm along the run (`emitRod`, `stationMm`). A
  wall triangle that spans a whole long rod is hundreds of times longer than wide,
  and the boolean cuts such a triangle into slivers ~1e-4 mm wide wherever a
  piece's facets cross it - which `mesh_validate.py` (weld 1e-4) reads as
  non-manifold. Stations fix it.
- `NSO_PathSweep.sweep` takes a convex profile with the origin inside, so the
  Tube is an outer rod plus a reversed-wound inner rod, not one annulus sweep.

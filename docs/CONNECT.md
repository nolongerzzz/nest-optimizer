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
ghost (Bridge's amber). Clicking an anchor again (within a mm of it) clears it; a
click on nothing (an orbit drag does not count) and Escape clear the picks; with
both set, a click on a new place replaces B.

A press that starts on a piece is Connect's while the card is open (otherwise it
would select the piece and begin a move drag under the click). A press that
starts anywhere else is never touched.

The pick is Bridge's own (`NSO_Bridge.pick`) and so is its overlay
(`NSO_bridgeTargetAt`, `NSO_bridgeTargetObject`); `app-connect.js` calls them,
`app-bridge.js` is untouched.

## The anchor is the point under the cursor

Exactly there, on the surface: no snapping to a face's centre or an edge's
midpoint, no deciding whether it was a corner, an edge or a face. A corner-to-
corner connector on two boxes runs corner to corner.

The connector **leaves along the surface normal** at that point. At an edge or a
corner it is the average of the normals of the faces that meet there - an edge's
two, a box corner's three (each face counted once, so a face cut into many
triangles is not over-weighted). A pointer never lands exactly on a vertex, so
within Bridge's own edge-pick distance (`BRIDGE_EDGE_PX` on screen, in mm at that
depth) of a corner it counts as at it: the faces that meet at the corner are all
averaged, while the anchor stays the point itself. A curved surface's facets are
no crease and keep their own normal; Bridge reads the flat faces of a welded piece
as plain points, so a point within the pick distance of a crease (a face meeting
another at more than 30°) gets the same average.

| pick    | anchor is        | leaves along                                      |
|---------|------------------|---------------------------------------------------|
| face    | the clicked point | the face's normal                                |
| edge / corner | the clicked point | the average of the adjoining faces' normals |
| point (curved) | the clicked point | the triangle's normal                    |

The card says where, per anchor and in the readout: `Anchor A: on box_closed at
2.1 mm from its corner · Anchor B: on box_open at its corner · String Ø2.0, …`
(the distance is to the nearest corner of the face or edge; none on a curved
surface: `on ball`).

**The leave-angle guard** (the line must leave a surface at least 10° off it) is
asked of the faces, not of the averaged normal. On a flat face or a smooth surface
it is the one normal, as always. At an edge or a corner it is asked of the
adjoining faces: where they bend away from one another (a box's corner, convex)
any line out of the solid goes - at least 10° off the face it leaves nearest - so a
level connector between two top corners is valid and welds; where they close in on
the line (a U's or an L's inside corner, concave) it must clear every one of them.
The averaged normal still orients a Ribbon, and a Foot pad or a Flat cut sits on the
face the line leaves best. A String, Tube or Tapered anchored at an edge or corner
has its section turned half a facet, so no ring vertex lies in a face plane through
the axis (a level line would otherwise meet the boolean exactly there).

**Shift** held while clicking keeps the old anchor, for the rare time it is
wanted: a face's centroid (leaving along its normal), an edge's midpoint (leaving
along the bisector of its two faces; a Ribbon is still held to twice that edge's
length). The card says `on box_closed, face centre` / `edge midpoint`.

`NSO_Connect.anchor(T, target, { centre, name, cornerPickMm })` makes a Bridge pick
into the anchor `plan()` takes (it works the corner normal out from the piece's
`NSO_Bridge.index`); a target without it - tickets 1 and 2's - is the clicked
point too, unless marked `centre`.

A and B may be on one piece or two.

## Many in a row

After Set the card stays open and is armed for the next pair: A and B clear, the
fields keep their values, and the last connector stays welded or placed. Its
result is a piece like any other (a welded one is named `… (connected)`), so the
next pair can be anchored on it. Cancel drops the picks; with none, Cancel - and
Escape - close the card.

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

## Attach shares the card

**Attach** (`app-assemble.js`, `docs/ASSEMBLE.md`) sits in its own row under
Set / Cancel, id `btn-stock-attach`. Armed, it generates a blank of the shape
last clicked on the Stock shelf and attaches it where you click on a piece.
While it is armed Connect's pointer handlers stand down, so the click is not
also an anchor; arming drops any anchors; Escape, Cancel and closing the card
turn it off. `tools/nso_connect_drive.js` §8 drives it.

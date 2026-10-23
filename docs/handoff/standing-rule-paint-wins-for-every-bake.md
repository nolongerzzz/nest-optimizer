## Standing rule — paint wins, for every bake
Owner's decision, and it binds new work as well as old: **a painted / excluded
face stays untouched by ANY bake mechanism**, not only the one the paint system
shipped with. A new bake feature reads mask6's skip list and either leaves that
face exactly as it was or stands down and says which face stopped it. It never
assumes nothing is painted — take the skip list as a required input, not an
optional one with an unpainted default, because unpainted is the value a caller
gets by forgetting.

Read the list, never re-derive it. `app-mask.js` hands back the raw axis and
side each click recorded; working out which face was meant from a plane and a
bounding box is the second mapping that put the yellow on one face and the
exclude on another. `brickSkipLists(...).pocket` and `nsoMaskFaceList` are the
supported ways in.

### Scoping — which faces a feature checks (added 2026-09-15)
The rule is one rule; **how** a feature checks paint depends on its operating
shape. Before wiring paint-awareness into a new feature, answer one question:

> Does this feature act on a specific, identifiable sub-region of the piece, or
> does it modify the whole piece with no clean sub-region?

- **Whole-piece** — stand down entirely if ANY face on the piece is painted.
  There is no sub-region to scope the check to, so this is the only coherent
  reading. The test is `nsoMaskCount(m) > 0`.
- **Sub-region** — check only the feature's own relevant faces. Paint elsewhere
  on the piece (a different pocket, the outer hull) does not block it.

Both are correct applications of the same rule at different scopes, **not**
inconsistent exceptions — do not "fix" one to match the other. Every
paint-aware feature **must state its category explicitly in its own
documentation**, so the next ticket reads it instead of re-deriving it.

Current roster, by category:

| feature | category | paint test | stated in |
|---|---|---|---|
| Smooth (`app-sculpt.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Extend (`app-extend.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/EXTEND.md` |
| Bend (`app-bend.js`; the geometry is `nso_bend.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/BEND.md` |
| Tube edge (`app-tube-edge.js`; the geometry is `nso_tube_edge.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/TUBE-EDGE.md` |
| Bridge (`app-bridge.js`; the geometry is `nso_bridge.js`) | whole-piece, on both pieces | `nsoMaskCount(m) > 0` on either | header comment + `docs/BRIDGE.md` |
| Close (`app-close.js`, ADD -> Close; the geometry is `nso_close.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/CLOSE.md` §5 |
| Mirror (`app-mirror.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/MIRROR.md` |
| Fatten (`app-fatten.js`; no UI since Scale part 3 - the card's Offset replaced it) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/FATTEN.md` |
| Pottery Wheel (`app-wheel.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/POTTERY-WHEEL.md` |
| Repair (`app-finish.js`, Seal's checkbox) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment |
| Fusion (`app-join.js`, Join Route 0) | whole-piece | `nsoMaskCount(A)+nsoMaskCount(B) > 0` | stand-down comment |
| Thicken (`app-finish.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment |
| Pocket corners (`nso_inside_corners.js`) | sub-region | this pocket's floor + 4 walls | `docs/INSIDE-CORNERS.md` §2 |
| Seat here (`app-seat-surface.js`) | whole-piece | `nsoMaskCount(modelB)`, only when the seat must turn B | `docs/SEAT-SURFACE.md` §3 |
| Skin face (`app-skin.js`) | sub-region | the one face being skinned, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | header comment |
| Delete painted (`app-paint-delete.js`) | sub-region | the one TARGET face, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | `docs/PAINT-DELETE.md` §7 |
| Stock shelf (`app-stock.js`, a tile click) | none — adds a piece, edits none | n/a | header comment + `docs/STOCK.md` |
| Extract selection (`app-extract-sel.js`) | sub-region | the one TARGET face, `nsoMaskIsExcludedRaw(m, face.n, face.d, ...)` | header comment |
| Scale (`app-scale.js`; Whole, Longest, Fit to plate, Length / Width / Height, the ring verbs Outer / Bore / Wall / Diameter, and Offset) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comments (`NSO_scaleSelectedModel`, `NSO_scaleCardApply`) |
| Skin patch (`app-skin-patch.js`) | **none** | — it reads no existing geometry at all | header comment |
| Texture (`app-texture.js`, the curved band) | sub-region | the band's own facets, `nsoMaskIsExcludedRaw(m, face.n, face.d)` per facet; the caps do not block it | `docs/CURVED-SKIN.md` §7 |
| Brush (`app-brush.js`) | sub-region | every face the stroke **and its seam band** land on, `nsoMaskPlaneList(m)` | `docs/BRUSH.md` §paint scope |
| Hollow / Fill (`app-hollow.js`) | whole-piece | `nsoMaskCount(m) > 0` | `docs/HOLLOW.md` §5 |
| Attach (`app-assemble.js`) | whole-piece | `nsoMaskCount(m) > 0` | stand-down comment + `docs/ASSEMBLE.md` |
| Detach (`app-detach.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/DETACH.md` |
| Reattach (`app-detach.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/DETACH.md` |
| G-scope supports (`app-gscope-support.js`) | sub-region | the marker scan's skipList, `nsoMaskFaceList(m)` shifted into the world frame; refused by name when the piece is painted and turned. Generating adds a piece (none); removing or changing one acts on the whole support piece | header comment + `docs/GCODE-SUPPORTS.md` |
| G-scope Slice (`app-gscope-slice.js`) | **none** — Slice reads geometry and writes nothing; Export piece to plate adds a copy of the piece and edits none, as G-scope's own Export to plate does | n/a | header comment + `docs/SLICER.md` §6 |
| Picture (`app-relief.js`, Gen+ -> Picture) | none — adds a piece, reads and edits none | n/a | header comment + `docs/RELIEF.md` |
| Lift (`app-lift-plate.js`, Subtract -> Lift: a click, a Shift group, Strip's Confirm) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/LIFT.md` §7 |
| Mold (`app-mold.js`, Gen+ -> Mold; the geometry is `nso_mold.js`) | **none** - reads the piece's geometry, writes no face of it, adds two pieces | n/a | header comment + `docs/MOLD.md` |
| G-scope Features (`app-gscope-lift.js`) | **none** - reads geometry, writes none | n/a | header comment + `docs/LIFT.md` §7 |
| Grab and drop (`app-grab-drop.js`; a drop onto a piece is `NSO_seatPieceAt`, Seat here's seat) | none of its own - a drop over the plate or into the air is a move; onto a piece it is Seat here's whole-piece, on the carried piece, only when the seat turns it | Seat here's `nsoMaskCount(modelB)` | header comment + `docs/GRAB-DROP.md` §4 |
| Foam (`app-foam.js`, Finish -> Shape) | sub-region | the faces of the one hollow it fills that the level reaches, against `nsoMaskFaceList(m)`; a null list (a painted recessed patch) stands it down | header comment + `docs/FOAM.md` §6 |
| Foam in a box (`nso_foam.js` `foamBox`; its ADD card is the next ticket) | sub-region | the faces the foam welds to, against `piece.skipList` (`nsoMaskFaceList(m)`, required); a piece whose shells must be merged first stands down for any paint, since the merge replaces every triangle | header comment + `docs/FOAM.md` §10 |
| Punch (`app-punch.js`, Subtract -> Punch; the geometry is `nso_punch.js`) | whole-piece | `nsoMaskCount(m) > 0` | header comment + `docs/PUNCH.md` |
| Pull (`app-pull.js`, Shape -> Pull; the geometry is `nso_pull.js` + `nso_densify.js`) | sub-region | the moved vertices (where they were and where they went) against `nsoMaskPlaneList(m)`, `NSO_brushPaintCheck`; operand none | header comment + `docs/PULL.md` |

### The SELECT list is an operand; the EXCLUDE list is still only a veto

Added 2026-09-17, with **Delete painted** (`docs/PAINT-DELETE.md`). Read this
before the next ticket that wants to act ON painted geometry rather than around
it, because the obvious reading is the wrong one.

A tool that removes geometry does **not** read the yellow. The standing rule
above is unchanged and unweakened: yellow means "no bake may touch this face",
in a destructive tool exactly as in a bake, and a delete aimed at a yellow face
stands down and names it. What a destructive tool reads is the **pink** — the
SELECT list, "this face is my target" — which is the same list Skin face has
always taken its target from. Delete is that list's second consumer, not a new
kind of paint and not a new reading of the old kind.

So the rule of thumb for a new feature is two questions, not one:

> What does this act ON?   -> the SELECT list, if anything.
> What must it not touch?  -> the EXCLUDE list, always.

A feature that answers the first question with "the exclude list" is asking for
the one colour that means *protected* to also mean *doomed*, and that is not a
trade this file makes.

**The Brush answers it "nothing".** It acts on the surface under the cursor,
which the user aims by dragging, so it reads no SELECT list at all - and it
still reads the EXCLUDE list, because the second question always has an answer.
A tool whose operand is a gesture rather than a face is not an exception to the
two questions; it is the first question answered honestly.

**Extract selection answers it "the SELECT list", like Delete.** Added
2026-09-18, it is the pink list's third consumer and Delete painted's
non-destructive twin: same target, same exclude veto, same stand-down wording,
but it COPIES the target's region onto the plate as a new piece and writes
nothing back to the source. "Acts on" does not have to mean "damages" - the
first question asks what the operand is, not what happens to it. A feature that
only reads is still answering it, and still owes the second question an answer.

`node tools/nso_paint_scope_test.js` asserts every entry actually carries its
label in source, so a deleted or drifted declaration fails rather than rotting.
Its ROSTER covers the features with a stand-down to keep honest; add a row
there as well as here when you add one.

### Reading the target face as geometry
`NSO_PaintDelete.select(rawTris, entries)` is the one selector that turns a
painted entry list into the triangles it covers, in raw space. Delete painted
owns the file; Extract selection reads it too, and neither has a second copy of
"which triangles did that click cover". Hand it `[nsoMaskSelected(m)]` for the
pink target - the header there notes the shape is the same for either list.

It can legitimately resolve to zero triangles on a face that IS painted: a
click on a curved top names the Y+ face, and a sphere has no triangle lying on
that plane. The overlay shows nothing there either, so a caller must handle an
empty result rather than assume a painted face implies painted triangles.

**"none" is a category, not a gap.** Skin patch ADDS a piece built from the
pattern's own parameters and never touches a face of any existing one, so there
is no region for paint to protect - a stronger statement than "paint is
respected", and the reason it is not in the paint-scope suite's roster: that
roster is the paint-*aware* features, and a row there needs a paint test to
assert. The drive check pins the substance instead, by loading a cube, baking
all six patches and showing its geometry, size and flag untouched.

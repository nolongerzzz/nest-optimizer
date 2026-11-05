## Stock shelf - the Stock card is one row of tiles, no fields (2026-10-17)

Write-up: "The shelf" in `docs/STOCK.md`. Files: `app-stock.js` (rewritten),
`index.html` (the card), `styles.css`, `app-assemble.js` (reads no card any
more), `tools/nso_stock_shelf_drive.js` (`npm run stock:shelf`),
`tools/nso_page_manifest_test.js` (gate 4: the Stock card is tiles only),
`app-connect.js` (Attach's button and its stand-down rules).
`stock`, `stock:live`, `wire:stock`, `wire:assemble`, `wire:integration`,
`paint:scope`, `shell:v3` and the scale / ring / mold drive checks were updated
for the ids that went.

PAINT SCOPE: **NONE** (`app-stock.js`): a tile adds a piece and edits none.
The old "Stock update" row (whole-piece) is gone with the live session.

Four things to keep:

- **Sizing is Scale's.** A tile drops the shape at one default size (a 40 mm
  target through `nso_stock.js`'s own defaults) and tags it with its sizing
  (`NSO_shapeTagStock`); the Scale card's per-shape rows do the rest. A cone has
  no dimension rows in Scale, so its h/d and taper have no field anywhere.
- **Tiles are painted from `NSO_Stock.make`, once, on the card's first open.**
  Nothing is an image file. The ellipsoid drops at h/d 1.5 - at the module's
  default (1) it is a sphere and the shelf would hold one piece twice.
- **Attach is in the Connect card**, a row under Set / Cancel, id
  `btn-stock-attach` unchanged. It blanks the shape **last clicked on the
  shelf** (`nsoStockShelf.lastShape()`; none yet = it refuses to arm). Escape,
  Cancel and closing the card disarm it; while armed Connect's picks stand
  down. `nsoAttachAt(placed, point, normal, blank)` still takes a stated blank.
- **The numbering is a running one across shapes** - `box 1`, `cylinder 2` -
  taken from the highest `<shape> <n>` among the model list, so Undo hands a
  number back and Clear plate (which leaves the model list) does not.

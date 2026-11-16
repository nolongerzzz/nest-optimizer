## Card regroup (2026-11-16)
Owner's layout change. Every control kept its id, handler and tooltip; only where it opens from moved.
- **Top row** ends Import, Measure, Move, Rotate, Tip, Lock position, Lock plate, **Print** (the
  supports card `#menu-supports`, out of the column). Gen+ left the row.
- **Column**: **Generate** (was Gen+, `#menu-gen`), Scale, **Cut / Crop**, **Punch**, Draw, Add,
  Subtract | Shape, Text, Paint, Surface & edges, Sculpt, **Assemble** | G-scope, **Fill & fix**,
  Check & repair | X, Eye, ◎.
- **Cut / Crop**: `#menu-cut` and `#menu-crop` are still two `<details>` (app-cut.js `cutWireCards`
  arms the tool off whichever is open). Crop's slab is hidden (styles.css), the Cut slab reads
  "Cut / Crop" and is lit while either is open, and a Cut | Crop switch (`.cutcrop-toggle`) at
  the top of each card opens the other (`app-cut-crop-toggle.js`, `NSO_CutCrop.show(mode)`). The
  slab pressed while Crop is open shuts the card.
- **Cookie-Cutter**: Crop's Piece shape (removed in b33cb77) is back as `#btn-crop-shape-piece`,
  shown as Cookie-Cutter; the engine kind is still `piece`.
- **Punch**: its own card `#menu-punch`, the Punch button and `#punch-card` as they were in Subtract.
- **Fill & fix** `#menu-fillfix`: Fill / Densify, Foam, GUN and their panels and Patch (out of
  Add), and Weave as a section `#menu-weave` (a nested `<details>`, like Surface's Wrap). Opening
  the section arms Weave; shutting the card shuts the section (app-weave.js) and disarms it.
- **Check**: `npm run cards:regroup` (tools/nso_card_regroup_drive.js, 38 gates, screenshots to
  the folder given as its argument).

## DRAW: the Connect card renamed, a flat Draw editor, and Connect as a stage with a ghost (2026-11-16)

New: `nso_sketch.js` (headless: a drawing's lines, rings and fills as closed solids), `app-draw-editor.js` (the Draw editor: a flat
millimetre sheet, Pencil / Line / Rectangle / Ellipse, Process type Drawing Line / Drawing Fill, W / H / X / Y / Rotate / Mirror,
an Objects list, its own undo), `app-draw-connect.js` (Draw > Connect: a solo mode on the Assemble editor's stage, the plate as it
stands, the drawing a ghost on any face moved freely, Weld in / Cut in / Own piece), `tools/nso_sketch_test.js` (`sketch:test`),
`tools/nso_draw_drive_check.js` (`draw:drive`), `docs/DRAW.md`.

Changed: `index.html` (the column button reads **Draw**; Connect's old card is its "Anchors on the plate" section, id for id),
`app-connect.js` (anchors armed while that section is open; `NSO_connectCommit` takes a name), `app-asm-editor.js` (`asPlaced`
modes, a mode's `key(e)`, keys stand down under the Draw editor), `app-core.js` (undo label), `styles.css` (`.dr-*`), and the old
Connect drives open the section first.

Measured: a 60 x 3 x 2 line welded across two boxes 16 mm apart is one piece of exactly the volume worked by hand, clean under
`mesh_validate.py`, one Undo. See docs/DRAW.md "Not here" for curved faces, text / SVG and node editing.

## Carve moves from Subtract to Sculpt, as its own arm (2026-11-07)

UI only; no geometry changes. `index.html` (the Carve rows left `#menu-bit`),
`styles.css` (`.vp-arm-start`, the hairline above the second arm), `app-brush.js`,
`app-carve.js`.
- **Sculpt now has two arms**, one tool live at a time (the existing arming
  hand-offs, by id, did not change). **Brush**: `#btn-brush`, `#sel-brush-mode`
  (Emboss, Smooth here), Size, Force, Hard falloff. **Carve**: `#btn-carve`,
  `#carve-blade` (ball-nose, flat shave, V-groove), Depth, the blade's size
  field(s), Roll, and the readout. Every carve id is unchanged, so `app-carve.js`
  needed no markup changes.
- **Radius:** the first blade-size slider is `#carve-a`, labelled Radius for the
  ball-nose; a flat shave shows Width + Length and a V-groove Angle + Length
  (`#carve-b`), as before - the blade needs them, so they stay.
- **Brush select** lost `carve`; the default is Emboss (`readOpts`' fallback
  too). The engine's `carve` mode is untouched and its tests still drive it
  (`wire:brush` and `watch:test` add the option to the select themselves).
- **Shutting the Sculpt card disarms both tools** (a `MutationObserver` on the
  card's `open`, in each tool's own file; a stroke in flight ends as the button
  would end it). That includes the card shutting because another panel opened -
  the one-panel rule - or the leave-tool gesture. Gate: `wire:brush` section 13.
- Tests moved with the controls: `shell:v3` (Carve ids under `menu-sculpt`),
  `subtract:card`, `ui:shell`, `carve:drag` (the card stays open while Carve is
  armed), `leave:tool`, and the QA tour. `shell:v3`'s CLEAR PLATE check fails
  on the tree before this change too.

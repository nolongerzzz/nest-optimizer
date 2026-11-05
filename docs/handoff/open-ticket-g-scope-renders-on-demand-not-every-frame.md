## Open ticket - G-scope renders on demand, not every frame (added 2026-09-26)
Open, not started. Found while fixing `gcode:solid-drive` (PR #110).

**The cost.** `animate()` in `app-microscope.js` re-queues itself with
`requestAnimationFrame` and calls `renderer.render` every frame for as long as
G-scope is open, whether or not anything changed. In headless Chromium
(software GL) the full `tabletop` slice costs ~2.5 s a frame, back to back:
measured with long-task timing, a real click on Export as solid took 23.4 s
and Read the plate 20.6 s on a quiet box, and past 30 s at 2x CPU throttle.
Real users on a weak or integrated GPU pay the same loop in fan, battery and
input lag, just at a smaller number.

**The ticket.** Draw only when something changed: a `needsRender` flag set by
the OrbitControls `change` event, `resize`, `viewChanged` / the detail and
highlight rebuilds, box drags and the layer slider, and cleared after one
render. Things that currently lean on the free-running loop and must still
work:
- `followClip()` and the corner dot's `cornerPoint()` run every frame; they
  must run on camera change instead.
- OrbitControls damping (if enabled) needs frames until it settles.
- `flushView()` and the screenshot checks assume the canvas is current; they
  must force one render.

**Done when:** G-scope sits idle with no long tasks while untouched, every
`gcode:*` G-scope check still passes, and `heavyClick()` in
`gscope-solid-drive-check.mjs` can go back to a plain `page.click` and still
pass at 2x throttle. That last one is the proof.

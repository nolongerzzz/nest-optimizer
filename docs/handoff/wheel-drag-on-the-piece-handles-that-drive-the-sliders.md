## Wheel: drag on the piece - handles that drive the sliders
`app-wheel-live.js` ("dragging on the piece": `handleSpecs`, `placeHandles`, `onDown` / `onMove` /
`dragEnd`, `applyDrag`, `axesAt`, `toMillimetres`), one hook in `app-core.js`
(`nsoWheelTakesPointer`), `NSO_wheelLip` now carries `press`. Write-up: `docs/POTTERY-WHEEL.md`
"Dragging on the piece".

What it is: balls on the piece that you drag - blue on the top (down = press, Shift = open), cyan
on the cavity floor of an opened piece (down = deeper), yellow on the wall (out/in = Pull, up/down =
Pull at), green on a plate's rim (up = Lip). They edit the same draft recipe the sliders do, through
the same preview and Set: one Undo step per drag, the sliders move with it, Escape cancels.

Things a later ticket should read before touching this:
- **The core asks a hook for a press** (`window.nsoWheelTakesPointer`, in `onCanvasPointerDown`
  beside `nsoPullTakesPointer`). `stopPropagation` in a capture listener on the canvas does NOT stop
  the core's listener on the same element - and the core's runs FIRST. Without the hook a handle drag
  also began a piece-move drag and pushed a `movePlaced` Undo entry on release. The hook does its own
  hit test, because the wheel's handler has not run yet when it is asked.
- **Mouse -> millimetres is a 2x2 solve through the camera projection at the handle** (`axesAt` +
  `toMillimetres`), not a fixed scale: it holds from any orbit angle and under perspective. The radial
  axis is the camera's right, so the handles are placed on the camera's right-hand side of the piece
  (`placeHandles` recomputes the azimuth on every camera `change`).
- **A drag edits a fresh clone of the recipe it started from** (`applyDrag`), never incrementally.
  Builds are throttled with a latest-wins `pump` (a build is ~60 ms).
- **Handles live in a scene group (`wheelHandles`), not on the piece's mesh** (a child widens every
  bounding box taken of the piece), are picked by SCREEN distance (no raycaster), have depthTest off,
  and exist only while the Wheel menu is open. The wall handle steps aside when it would sit on the
  rim or press handle (a thin plate).
- **The green rim handle needs `piece.press`** - `NSO_wheelLip` carries it through; before that fix the
  handle vanished the moment a lip was set. Colour matters: the piece is pink-red, so the rim handle is
  green (a pink one nearly disappeared).
- **The Undo stack is capped**, so "one more entry" cannot be asserted from its length late in a long
  test; the wire test marks the top entry and looks for exactly one new one above it.
- Not done: handles for Scale, Trim, Rim + or Soft; dragging the plate's start (Lip at) or Flare on
  the piece; a second pull. The sliders remain the way to those.

`npm run wheel` (238 checks), `npm run wire:wheel` (section 10e: a real mouse - hover, press, lip, Shift
to open, the cyan ball, the wall ball out and up, Undo in one step, Escape, a plain click, orbit on empty
space with the handles following, handles gone with the menu).

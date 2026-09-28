# Live watch - the eye button

One toggle in the viewport's bottom-left corner, next to Undo. Off by default.
While it is on, two independent watchers run over an ordinary session - you
drive the app exactly as you would anyway.

    nso-watch.js                the whole feature
    #btn-watch in index.html    the toggle
    node tools/nso_watch_test.js   109 checks, in npm test
    node tools/gcode-test/gscope-watch-drive-check.mjs   38 checks, in npm test
                                (the panel across the G-scope boundary)
    node tools/gcode-test/gscope-watch-actions-drive-check.mjs   36 checks, in npm test
                                (G-scope's own actions as lines of their own)

## Why

Two mismatches of one shape were found by accident: a piece's pose lost across
a bake, and paint left on screen after an undo. Both are invisible while they
happen. In both the app's **logical** state stays correct and only the
**picture** diverges, so nothing throws, nothing turns red, and the status line
says the operation succeeded - because as far as the operation is concerned, it
did. They surface later, as a wrong export or a piece that will not select,
usually when an unrelated test trips over them.

This catches the next one at the moment it happens, while the person who caused
it still remembers what they clicked.

## 1. The error and status log

Timestamped, newest last, in the panel and in the console:

| what | where it comes from |
|---|---|
| console errors and warnings | `console.error` / `console.warn` |
| uncaught errors and rejections | `error` / `unhandledrejection` |
| a script, texture or STL that did not load | the same `error` listener, capture phase |
| a failed `fetch` (non-2xx or network failure) | `fetch` |
| a failed `XMLHttpRequest` | `XMLHttpRequest.prototype.send` - three's loaders use XHR, not fetch |
| every line NSO writes to its own status bar | `setStatus` |

Status lines are split into plain status and **refusal**. A refusal is the app
declining to do what was asked - a stand-down, a gate, a "select a piece
first". That is a first-class signal here, not an error: every wired bake can
stand down (`docs/HANDOFF.md`, "paint wins"), and a stand-down nobody noticed
reads exactly like a bake that silently did nothing.

Build-volume warnings are status lines too. `app-fit.js` routes each one
through `setStatus` when it changes - a new or different warning, and
"every piece fits again" when the last one clears - never per frame. It is
APPENDED to the current status line (`<op's line> | Build volume: ...`), with
that line's class kept, because a warning is usually caused by the operation
that just ran and replacing that operation's result would hide what it did.
The log marks these `build-volume` (level `warn`) by the `Build volume:`
marker, so they are not mistaken for a plain status line or a refusal.

The status bar itself is never touched - the line the app wrote is the line you
read, error class and all. Neither is the HUD (`#adjust-status`); Grok owns
that string.

## Selection, and preview vs commit

A logged operation is only useful if you know what it was done to, and whether
it was kept.

**select** - every change of `state.selectedIndex` or `state.editId`, however
it was made: `selectPlaced()`, a click on a piece, or one of the dozens of
direct assignments in the app. The two properties are turned into accessors
while the watch is on (plain data properties again on stop), the setter notes
the change, and one line is written per change at the end of the tick. A
reselect of what is already selected is not a change. The line lands before
any operation that follows it in the same tick, and the baseline selection is
logged at start. "selection now ..." (rather than "selected ...") means the
plate changed under the same index without an assignment.

**op** - one line per operation, each carrying the selection it acted on:

| phase | what it is | where it comes from |
|---|---|---|
| `preview` | shown, not kept | `showEditPreview`, `previewModelOnPlate`, a brush stroke under the pointer |
| `discard` | a preview dropped with no commit | a brush stroke cancelled or refused |
| `commit` | the app changed something | every `pushUndo`, with the app's own type (`brushReplace`, `movePlaced`, ...) |
| `undo` | a commit reverted | `undoLast`, with the type it reverts |

Status lines written in the same tick as an operation carry its phase, so the
brush's "Carve - drag to work the surface" reads `preview` and its "Carve done
..." reads `commit`. The brush's two ends live inside its closure, so
`app-brush.js` announces them as a `nso:op` DOM event - one dispatch per
stroke, nothing listening when the watch is off.

## 2. The state-consistency watcher

After every Undo, bake and tool switch, the **rendered scene** is compared
against the app's own **logical state**:

    state.placed / state.models      what the app believes is on the plate
    state.modelGroup.children        what is actually drawn
    faceMask.exclude                 which faces are excluded

A mismatch is reported the moment it appears, as

    phantom <subject> - <what disagrees, with the numbers>   [after <operation>]

with a timestamp and the operation that preceded it, read off the app's own
`pushUndo` type (`softenReplace`, `maskReplace`, `splitReplace`, ...) rather
than guessed from a button.

### The subjects

| subject | what it means |
|---|---|
| **object** | a piece the plate counts that nothing draws, a mesh on screen no entry owns, a `placedIndex` that points at the wrong piece, a `sourceId` whose model has left the registry, or the two counts simply differing |
| **wall** | the surface on screen is not the surface the app will export - a mesh drawing a geometry the model no longer points at, or a display triangle count that does not match `rawTris` |
| **paint** | the yellow and the skip list disagree - paint drawn for a piece that has been rebuilt since, paint standing for a different number of faces than the list holds, paint sitting off the pose it marks, or paint with triangles outside the piece at all |
| **pose** | the mesh is not drawn where the entry's logical pose says it is - rotation, x/z, or not seated on the bed |
| **footprint** | the piece's drawn box is not the box the packer reserves for it (`width` / `depth` / `height`) |

### Nothing here is re-derived

Every invariant is read back off the app's own definition, which is what keeps
this from becoming a second, drifting model of the same rules:

- **pose** - `applyMeshRotation()` in `app-core.js` is the one mapping from a
  placed entry's logical pose to its mesh transform. The watcher recomputes
  exactly that expression and compares.
- **bed** - `settlePlacedOnBed()` seats a piece 0.2 mm up. The tolerance is
  0.35 mm, which covers that and the 0.3 mm a fresh bake uses, so the two
  conventions living side by side do not fire.
- **footprint** - `meshLocalBox3()`, the same box `applyMeshRotation()`
  measures `width` / `depth` / `height` from.
- **paint** - `nsoMaskCount()` and the overlay object itself. The skip list is
  read, never re-derived (`docs/HANDOFF.md`). Which piece the yellow was drawn
  from is worked out without asking the paint module anything: `repaint()`
  disposes its overlay and builds a new mesh every time it runs, so an overlay
  whose `uuid` has been seen before is one no repaint has touched since, and
  what the piece looked like then was recorded the first time it was seen.

### A finding is a state, not an event

It is logged once when it opens and once when it clears, so a mismatch that
survives twenty checks is two lines rather than forty. `NSOWatch.open()` lists
what is still wrong right now.

### When it checks

- every `pushUndo` - the app's own record that something changed. Every
  mutating operation pushes one: bake, split, join, subtract, paint, clone,
  delete, and the end of a drag.
- every `undoLast`, synchronously, the instant it returns.
- every click on a button or menu item, and every `change` on a control - this
  is what covers the tool switches whose handlers were bound by reference at
  load time and so cannot be wrapped by name.
- an idle sweep every 4 s, for anything driven from the keyboard or the
  console.

Each operation is checked at 0, 150, 700 and 2000 ms, because a bake is
synchronous but Join and Subtract resolve a promise. The same finding is only
reported once, so the extra passes cost nothing.

## It never repairs anything

No bake, no repaint, no undo of its own, and it does not nudge a mesh back into
place. A watcher that fixes what it finds destroys the evidence it exists to
capture. Switching it off restores every patched global; switching it on
patches nothing until you do.

## Using it

Click the eye. The panel lists events live, red for a phantom, green when one
clears, and the button carries a count. **Copy** puts a text report on the
clipboard and in the console.

**Report** opens the in-app history. Every event is also kept in this browser
(`localStorage`, key `nso.watch.store`), one run per start, across reloads -
there is no backend and none is needed. The view groups events by run and
filters by run, by kind (click a count in the summary row) and by text; it
follows a live session while open. **Clear history** forgets every stored run
but the live one. The newest 6000 events are kept; older ones are dropped
first, and a full quota drops the oldest half.

From the console, or a check:

    NSOWatch.start() / .stop() / .toggle() / .isOn()
    NSOWatch.check('label')   run a consistency pass now, get the findings back
    NSOWatch.open()           the mismatches that are open right now
    NSOWatch.events()         everything seen, oldest first
    NSOWatch.summary()        counts by kind
    NSOWatch.report()         the text report
    NSOWatch.stored()         the persisted history: {runs, events, dropped}
    NSOWatch.query({run, cat, q})   filtered history
    NSOWatch.showReport() / .hideReport() / .clearStored()
    NSOWatch.where()          'main' or 'gscope' - which view the panel is in
    NSOWatch.save()           download the current run as JSON (console only)

## In G-scope

G-scope (`#microscope`, `app-microscope.js`) is its own full-screen sheet -
`position: fixed`, `z-index: 2000`, its own left rail and 3D view - over the
whole app. The watcher never stopped while it was up: every patch is on
globals G-scope shares, so its status lines (the slicer's "Sliced ..."
included), its errors and the clicks on its controls were being logged and
checked all along. But the panel lived in `.viewport-section`, under that
sheet, so an armed watch vanished on entry and looked exactly like a dead one
(driver round, 2026-09-28, in Normal and Slice view alike).

Now, while it is on, the panel and the Report view follow the view: a
`MutationObserver` on the sheet's own `hidden` attribute - the one thing every
way in and out sets (the rail button, a `.gcode.3mf` import, Close, Escape,
Export to plate) - moves them into `#ms-viewport` the moment G-scope opens and
back the moment it closes. Same instance, same run, same events and counts on
both sides; no re-arm. Inside G-scope the panel sits bottom-left above the
hint badge, clear of the layer-range slider on the right edge.

Off, it stays off: the observer is installed by `start()` and removed by
`stop()`, so a watch that was never armed is not started, shown, moved or
observed on the way in. The eye button itself stays on the main view - the
panel follows the view, the toggle does not - so switching it off from inside
G-scope is `NSOWatch.stop()` or a trip back to main.

What it logs in G-scope is what it logs anywhere - errors, failed loads,
status lines, and the plate's consistency checks (a G-scope button click
schedules one, as any click does, and names it in the phantom's trail) - plus
G-scope's own actions, below. It has no G-scope-specific checks of its own:
nothing compares a slice's layers against the slicer's result (that is the
next ticket, and it will attach to this trail). `NSOWatch.where()` says which
view the panel is in.

### G-scope's actions are lines of their own

Almost nothing done in G-scope is an undoable operation, so none of it showed
up as a select / op line the way main-view work does: a legend toggle, a click
on its 3D view or a Normal / Slice switch left nothing behind unless a phantom
or an error happened to carry it in its trail. Each is now a `gscope` line
(its own colour, and its own count in the Report's summary row), in sequence
with everything else:

    G-scope Normal: entered G-scope - the plate
    G-scope Normal: legend "mushroom" off                  which row, off or on
    G-scope Normal: legend "plain" only (every other row off)
    G-scope Normal: 3D view click (select mode) - hit "mushroom" at (1.2, -0.4, 7.00)
    G-scope Normal: 3D view click (orbit mode) - nothing hit
    G-scope Normal: view Normal -> Slice
    G-scope Slice: Detected features row "Walls ..." (walls)
    G-scope Slice: view Slice -> Normal
    G-scope Normal: view Normal (already Normal - re-frame)
    G-scope Normal: click ms-btn-clear                     any other button
    G-scope Slice: set ms-layer-index = 12                 any field
    left G-scope - back on main

- **Which view** is the prefix, read at the moment of the action (Normal /
  Slice from `NSO_GSCOPE_SLICE.viewMode()`). Every event, not only these,
  carries a `view` field - `main`, `gscope-normal` or `gscope-slice` - and
  anything else that happened inside G-scope (a status line, a phantom, an
  error) is tagged with it in the panel, the Report and its Copy text.
- **Order.** Each line is written in the capture phase, before G-scope's own
  handler runs, so it precedes whatever that handler logs: `view Normal ->
  Slice` comes before `Sliced ...`. Going in and out is written at the first
  event after the sheet was shown or hidden, so `entered G-scope` precedes the
  lines G-scope writes while it opens.
- **What was hit** on a 3D-view click (a press and release within 4 px, G-scope's
  own test for a click rather than an orbit drag) is read with a raycaster of
  the watcher's own against the same targets G-scope's click handler uses - a
  piece, or a feature's lines in a slice - and given in the document's G-code
  frame. A click on a capture box's handle says so.
- **Detail**: `detail.action` is `enter`, `leave`, `legend`, `legend-only`,
  `detected`, `view`, `click3d`, `control` or `set`, with the row, on/off,
  from/to, mode, hit name and point as they apply.

Pure record: nothing judges an action, and none of these lines schedules a
check of its own. Legend rows, Detected rows and 3D clicks are added to the
trail (`ops`) so a phantom or error that follows names them; buttons and
fields were already there. Same carry rules as the panel: the listeners are
installed by `start()` and removed by `stop()`, so recording starts only when
armed, follows into G-scope with no re-arm, and a watch turned off from main -
or never armed - records nothing on either side.

`?watch=1` on the URL starts it at load, and the on/off state is remembered in
`localStorage` as `nso.watch`, so it survives the reload a bug needs to
reproduce.

## What it found on its first run

Three, all of the same shape, all reproduced in `tools/nso_watch_test.js`. None
is fixed here - this ticket is the watcher, not the repairs. Each check fails
loudly if its bug is fixed, which is the cue to retire the check with the fix.

1. **The `app-finish.js` bakes lose the placed pose.** Yaw a piece 90 deg,
   then Seal it. `applyMeshRotation` occurs nowhere in `app-finish.js`: its
   six commit sites - `sealSelectedModel`, `solidifySelectedModel`,
   `thickenSelectedModel`, `commitSoften`, `applyCapOnFace` and
   `capSelectedOpenFaces` - all rebuild the placed mesh with
   `mesh.position.set(px, m.size.y / 2 + 0.3, pz)` and no rotation, so the
   piece snaps back to 0 deg on screen while its entry still says 90. `width`
   and `depth` are then taken from the unrotated `m.size`, so the packer
   reserves the wrong footprint too. The shared bake-undo branch in
   `app-core.js` (line 419) does the same for all six undo types.

   Measured, on a yawed `box_hull_80x40x20-2`: Seal, Solidify and Thicken out
   each raise the phantom. Cap and Soften need a pick or an open face and were
   not driven; they are the same block, read rather than measured.

   This is the **other half** of the thread `tools/nso_pose_after_bake_test.js`
   already closed. That gate covers `NSO_sculptCommitRaw` - Smooth, Skin,
   Scale, Extend, Brush, Carve, Texture, Paint delete, Seat (surface) - which
   now calls `applyMeshRotation` and passes clean here. The `app-finish.js`
   commit half was never in its scope.

2. **Paint outlives the geometry it was drawn from.** Paint a face, then Seal.
   Seal replaces `m.geometry` and the placed mesh but never repaints, so the
   yellow on screen is triangles copied off a mesh that no longer exists.
   Turning a painted piece does the same thing - `applyMeshRotation()` moves
   the piece and nothing moves the overlay, so the yellow stays behind on the
   face it used to mark. `nsoMaskRepaint()` is called from exactly two
   commits, `commitSoften` and `NSO_sculptCommitRaw`; Seal, Solidify, Thicken
   and Cap call neither it nor `applyMeshRotation`.

3. **Undoing a delete brings back the piece but not its model.**
   `deleteSelectedPlaced()` removes the placed entry and, when it was the last
   instance, drops the model from `state.models` as well - but pushes only a
   `removePlaced` undo entry. Undo puts the piece back on the plate pointing at
   a `sourceId` that is no longer in the registry, so it is missing from the
   Library list and `getActiveModel()` cannot reach it: Cut, Finish and Join
   have nothing to work on. The rebuilt mesh also carries no
   `userData.sourceId` at all, so every lookup keyed on it misses.

## Removing it

Delete `nso-watch.js`, the `#btn-watch` button and the one script tag in
`index.html`, and `watch:test` and `gcode:gscope-watch` from `package.json`
(with `tools/gcode-test/gscope-watch-drive-check.mjs`). Nothing else refers to it.
Its CSS is injected from the JS rather than added to `styles.css`, because
`styles.css` is served with a `?v=` tag this branch may not bump, so a rule
added there would not reach a browser holding the cached copy.

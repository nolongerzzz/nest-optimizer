## Thicken in / out, live - a slider ghost, Set, per-face (2026-10-23)

Ticket `thicken-live`. UI only: **what Thicken computes is unchanged** - the
live ghost calls `_thickenOffsetSoup` with the slider's number, and Set calls
`thickenSelectedModel`, both in `app-finish.js` and both untouched. Branch
`claude/thicken-live`, base `claude-wip`.

### What it is now

On the Add card, **Thicken out** and **Thicken in** no longer bake. A press
arms a live control (`app-thicken-live.js`, Foam's shape):

- the piece turns to a ghost (opacity 0.2, Foam's own treatment) and the faces
  that would move are drawn where they would land, green with a pale outline -
  the wall growing out, or into the cavity;
- the **slider** (`#inp-thicken-mm`, 0.1 - 8 mm, step 0.1) is the number. Every
  move re-runs the engine at that value. The 1.5 box that sat between the two
  buttons is its **readout** (`#thicken-read`); its arrows still step the slider;
- the line under the slider says what would happen in words: `Thicken out 1.5 mm
  - 58 outer face(s) move, 10 held (whole piece)`, or why the engine refuses;
- **Set** bakes it, **Cancel** (or Escape, or the lit button again) drops the
  ghost and the piece was never touched. One Undo for a Set, `thickenReplace`,
  as before. The other Thicken button switches verb and keeps the number.

### Per-face

Click a face while the control is armed and the slider thickens **that wall
only**; with none picked it is the whole piece, as before. Click the wall
again, or press **Whole piece**, to go back. The wall is the triangle under the
click grown across creases shallower than the engine's own `THICKEN_SMOOTH_DEG`
(45 degrees): a box's face is its coplanar patch, a cylinder's side is the whole
side. Every ray layer is a candidate, so Thicken in finds the pocket wall behind
the outside skin (the first face on the asked side wins). A wall on the wrong
side for the verb reads "the wall you picked is on the inside - Thicken in moves
it" and Set stays greyed.

**No engine call was needed.** `_thickenOffsetSoup`'s `opts.mayMove` (added for
Fatten: a 0 forbids that face from moving) is the filter; Set passes the same
mask to `thickenSelectedModel`.

### Set bakes exactly the ghost

The ghost and Set make the same call with the same arguments on the same soup,
and the engine is deterministic, so the baked triangles are the ghost's, float
for float. `thicken:drive` section 9 compares all of them. Every gate Thicken
ever had is still Set's: paint (whole-piece, stood down at arm time with
Thicken's own words), inversion (the ghost shows it live), and the piercing
check. Piercing is the slow one, so it runs when the slider is **let go** (and
on arm and on a pick), not on every drag step; a ghost Set would refuse says so
in the readout and greys Set (`the moved faces would cross the piece (piercing
pairs a->b)`).

### Hollow's box

Hollow's number box did not work because it sat in the **middle column of the
Thicken row's grid, 24 px wide**: the native spin buttons filled the whole box
and a click on it stepped the number instead of focusing it (2 -> 1.92: `min`
0.42 is the step base). It is its own row now (`.vp-row-hollow`, a 72 px box),
Hollow to safe min on a row of its own, `min` 0.4. Typing, focus and the arrow
keys work; `thicken:drive` section 12 does it with real keys.

### What had to be decided (the ticket was silent)

1. **Hollow has no slider or ghost in this tree.** The ticket says Thicken
   should "work like Hollow's control"; Hollow here is a button and a number box
   (Subtract card) - the only live slider + ghost + Set + Cancel is **Foam**, so
   that is the pattern copied. Hollow got the box fix only, no ghost. A Hollow
   ghost is a different cost (each slider step is a level-set cavity run,
   `nso_hollow.js`, 0.7 - 1.7 mm pitch on the fixtures) - asked, not built.
2. **"Click a face first"** is read as a click **after arming**. There is no
   tool-less face pick to hang it on: `state.facePick` is Soften / Cap / Join's,
   axis-plane based, and refuses an inside wall outright ("that one is
   recessed"), which Thicken in needs.
3. **The slider replaces typing.** The old box was `min 0.4` but took any typed
   positive number; the checks use 0.3 (hinge, tape), so the slider goes down to
   0.1. There is no typed entry on the Thicken row now.
4. **Findings' THICKEN OUT** used to type the mm into the box and click the
   button. The button arms now, so `app-findings.js` hands the mm to
   `thickenSelectedModel('out', mm)` directly (bracketed like Cap) and its
   before/after watcher listens on `#btn-thicken-set`, so a person's own Set is
   still read back.
5. **No claim on the pointer.** A click is read on pointerup (under 5 px, 600
   ms); a drag is the orbit's or the move's. Nothing is held between press and
   release, so a pick tool's "let go" rule holds by construction
   (`pick:release`, new `Thicken` row). A press on a piece still reaches
   app-core's select / move as it always did.
6. **The old per-button wiring is gone** from `app-join.js`; `thickenOutSelectedModel` /
   `thickenInSelectedModel` in `app-finish.js` remain (they read the slider) but
   nothing calls them.

### Gates

`thicken:drive` (`thicken:check` is the step in `testSteps`; `thicken:drive` is
the script that also runs `nso_carve_test.js`): sections 1-7 are the engine's own
pins, all unchanged in what they assert, now reached through arm -> slider ->
Set, with a refusal read off the readout. Sections 8-12 are new:
8 the ghost tracks the slider (by keys, by the track, by the row's arrow:
the ghost is `_thickenOffsetSoup`'s output at that number, float for float,
and its extent is `60 + 2*mm`); 9 Set bakes exactly the ghost, one Undo, ghost
gone; 10 Cancel / Escape / same button leave the piece the same object; 11
per-face by real clicks - the +x wall alone (bbox 61.5 x 40 x 25, volume 15132,
every moved vertex on that wall), the cavity floor alone (volume 16656, against
22396.5 for the whole piece), a wrong-side wall refused in words; 12 Hollow's box.
`pick:release` gained a Thicken row. `wire:offset` and `qa:tour` press Set after
the button. Screenshots: `tools/thicken-live-out/` (made by
`node tools/nso_thicken_live_shots.js`, not a test step).

`--touching` for the files changed: `app-thicken-live.js` reaches `thicken:check`
and `pick:release`; `app-findings.js` 6 steps (`findings:drive` is the one that
presses Thicken); `app-join.js` 34; `index.html` / `styles.css` reach most of the
drive checks (172 of 267 steps name `index.html`). Per the one-full-suite rule the
batch's CI run is the full suite; this PR ran its own gates and `page:manifest`.

### Screenshots

Not committed. `node tools/nso_thicken_live_shots.js` writes seven PNGs into
`tools/thicken-live-out/` (git-ignored), with the same clicks a person makes, on
`fixtures/box_open.stl` (60 x 40 x 25, 2 mm walls):

1. `1-ghost-out-1.5.png` - Thicken out at 1.5, the wall growing out
2. `2-ghost-out-3.png` - the same at 3: the ghost follows the slider
3. `3-ghost-in-2.png` - Thicken in at 2, the cavity walls closing in
4. `4-after-set-in-2.png` - after Set: baked, ghost gone
5. `5-per-face-out-picked.png` - the +x wall clicked, Thicken out 3: that wall alone
6. `6-per-face-after-set.png` - after Set: only that wall grew
7. `7-per-face-in-floor.png` - Thicken in with the cavity floor clicked from above

## SUBTRACT card - collapsing sections, one per tool; Detach flange under Lift; Hollow live (2026-10-23)
Branch `claude/subtract-card`, off `claude-wip`. UI only: no tool's behaviour
changes. Full write-up of the preview: **`docs/HOLLOW.md` §6**.
- **The card** is six collapsing sections (`<details class="vp-sec" id="sub-sec-...">`,
  the group style `styles.css` already had for the Finish menu and the library
  browser), all shut when the card opens: **Subtract B from A** · **Extract bit**
  (with Carve) · **Punch** · **Hollow** · **Lift** (with Detach flange) ·
  **Split to parts**. They are not `.vp-menu`, so app-join's one-panel rule
  leaves them alone: several can be open at once, and the card keeps them as left.
- **Where every job landed:** Subtract B from A, Extract bit, Carve, Punch,
  Hollow, Hollow to safe min, Lift, Strip, Split to parts: each in the section of
  its own name. **Detach flange** moved from a group of its own under Split to
  parts into **Lift** (under the Lift panel; `#detach-tools` and its ids kept).
  Nothing was removed.
- **ids:** all 57 ids the card had are still on it, none moved to another card.
  New: the six section ids (`sub-sec-subtract`, `-extract`, `-punch`, `-hollow`,
  `-lift`, `-split`), `inp-hollow-slider`, `hollow-slider-read`, `hollow-readout`.
  The Hollow row's class went `vp-row-thicken` -> `vp-row-hollow` (CSS only).
- **Hollow's wall box was a 24 px square.** It sat in the Thicken row's middle
  column, which is a 24 px spinner strip, so the number could not be read, and
  "Hollow to safe min" was cut to "Hollow to safe m". Now: Hollow + a 72 px box on
  one row, the slider under it, "Hollow to safe min" on a row of its own.
- **Hollow's cavity shows live** as the slider (or the box) moves: the piece
  turns to a ghost and the cavity is drawn inside it, from a coarser pass of
  `nso_hollow.js` (1.5 samples to the wall, no re-measure); Hollow itself is
  unchanged and still reads the box. The control is `app-live-slider.js`
  (`nsoLiveSlider.bind({slider, box, read, unit, onLive})`), built here because
  thicken-live had not landed. #284 built Thicken's control on Foam's pattern
  instead, so Hollow is the only user of this one for now; a later Thicken change
  can bind to it and draw its own preview in `onLive`. The preview is an `nsoHelpers` owner (`hollow-live`).
- **Gates:** new `subtract:card` (a `driveSteps` step: it launches a browser) (`tools/nso_subtract_card_drive_check.js`:
  sections shut / open / independent, every control present and hit-testable in
  its section, the wall box, the live cavity, every way it closes, Lift / Punch /
  Detach still running); `shell:v3` gained the six-section gate and opens Lift's
  section before clicking Lift. At the rebase onto `origin/claude-wip` (without
  #284) the gate was the `testSteps` that `run-tests.mjs --touching` lists for
  each changed file, plus `page:manifest`; the full suite is CI's.
- **Screenshots** are not committed (`tools/subtract-card-out/` is git-ignored):
  collapsed, each section open, the live cavity at 3 and 5 mm, Lift and Punch
  armed, and the card before. They are on one page,
  https://claude.ai/artifact/3Nf5CJc3u83xWU3hQnQv99, and
  `node tools/nso_subtract_card_drive_check.js tools/subtract-card-out` redraws them.
- **Tags / weights:** `npm run stamp`; `subtract:card` has an estimated weight
  in `tools/test-weights.json` until CI measures it.

### Update (2026-10-31): sections removed - plain buttons like the other cards
The six collapsing `<details class="vp-sec" id="sub-sec-...">` are gone: the card is
a run of buttons (Subtract B from A, Extract bit, Carve, Punch, Hollow, Lift, Detach
flange, Split to parts), as Shape, Surface and the rest are. Every other id, row and
panel is unchanged; only the six `sub-sec-*` wrappers (and their headings) went.
`app-hollow.js` now drops the live cavity when the card shuts (it used to also watch
the Hollow section). `subtract:card` and `shell:v3` check the flat layout (no `<details>`
on the card, every control present and hit-testable, Lift / Punch / Detach / Hollow live
still working). `shell:v3`'s CLEAR PLATE check fails on the branch before this change too.

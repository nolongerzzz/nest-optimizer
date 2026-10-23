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
  thicken-live had not landed; Thicken's slider should bind to it and draw its
  own preview in `onLive`. The preview is an `nsoHelpers` owner (`hollow-live`).
- **Gates:** new `subtract:card` (`tools/nso_subtract_card_drive_check.js`:
  sections shut / open / independent, every control present and hit-testable in
  its section, the wall box, the live cavity, every way it closes, Lift / Punch /
  Detach still running); `shell:v3` gained the six-section gate and opens Lift's
  section before clicking Lift. `ui:shell`, `pick:release`, `page:manifest`
  unchanged and green. The drive tests that click SUBTRACT's controls were run
  (list in the PR).
- **Screenshots:** `tools/subtract-card-out/` (collapsed, each section open, the
  live cavity at 3 and 5 mm, Lift and Punch armed, and the card before).
- **Tags / weights:** `npm run stamp`; `subtract:card` has an estimated weight
  in `tools/test-weights.json` until CI measures it.

## Cache-tag batch (2026-09-27)
Done on the owner's explicit instruction, as one pass after nest-library#3,
PR #118 (feature fixtures) and PR #119 (Detach / Reattach) merged. An
exception to rule 4; the HUD string (`stampHud()`) is untouched and
`app-ux.js` stays at `inside8`.

**The method in the 2026-09-26 follow-up is the right one, and the stricter
rule that looks right is wrong.** A file has drifted when it differs at HEAD
from the OLDEST commit carrying its current tag
(`git log -S "file?v=tag" -- index.html | tail -1`). Narrowing that to "the
commit that set the tag, where the parent disagreed" was tried here and
under-reports: a merge that INHERITS a tag bump is indistinguishable from one
that sets it, so `nso_support_aim.js` and `app-core.js` both read clean when
they had plainly changed. The two rules fail in opposite directions and the
conservative one is correct - a needless bump costs nothing, a missed one
ships stale bytes.

Six files drifted from this batch, which is exactly the set the two PRs named
in their own "needs a bump" notes - content and intent agreeing independently:

| file | was | now |
| --- | --- | --- |
| `app-library.js` | `libsave2` | `libsave3` |
| `nso_flange.js` | `flange1` | `flange2` |
| `nso_assemble.js` | `asm1` | `asm2` |
| `app-assemble.js` | `asm1` | `asm2` |
| `nso_support_aim.js` | `support2` | `support3` |
| `app-core.js` | `gsup3` | `gsup4` |

Eight more were drifting already, so the previous batch's closing claim that
"no tagged file differs from its tag's content" was not true when written:

| file | was | now | drift |
| --- | --- | --- | --- |
| `NSO_Repair.js` | `inside4` | `repair1` | +313/-40 |
| `nso_skin_patch.js` | `skin3` | `skin4` | +188/-10 |
| `nso_skin.js` | `skin2` | `skin4` | +162/-7 |
| `app-seat-surface.js` | `seatsurf1` | `seatsurf2` | +45/-0 |
| `app-skin.js` | `skin2` | `skin4` | +35/-0 |
| `nso_carve.js` | `carve1` | `carve2` | +21/-3 |
| `app-measure.js` | `inside6` | `measure2` | +15/-0 |
| `app-nonsolid.js` | `inside4` | `nonsolid2` | +5/-1 |

Every new tag was checked never to have been used for that file before, and
each substitution asserted exactly one match in `index.html`. Re-audited
after: 0 of 76 tagged files drift. `nso_skin_band.js` and `app-texture.js`
keep `skin2` - their content genuinely matches it, and bumping a clean file
is churn. Five scripts still load untagged
(`nso-cooling-profiles.js`, `nso-3mf.js`, `nso-3mf-read.js`,
`nso-gcode-lines.js`, `nso-watch.js`), as before.

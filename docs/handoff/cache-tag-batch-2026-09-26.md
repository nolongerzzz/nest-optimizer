## Cache-tag batch (2026-09-26)
Done on the owner's explicit instruction, as one pass after Crop Stage 2
(PR #114) and the multi-run union (PR #113) merged. This is an exception to
rule 4; the HUD string (`stampHud()`) is untouched.

| file | was | now |
| --- | --- | --- |
| `app-core.js` | `gsup2` | `gsup3` |
| `app-crop.js` | `crop3` | `crop4` |
| `nso_hollow.js` | `hollow3` | `hollow4` |
| `styles.css` | `legendmin1` | `crop4` |
| `app-microscope.js` | `scope9` | `scope10` |
| `nso-gcode-solid.js` | untagged | `solid1` |

The "needs a bump at merge" notes in the Crop Stage 2 and fused-selections
entries below are covered by this pass.

**Follow-up, same day: five older drifts the batch missed.** Checked by
content: a file has drifted when it differs at HEAD from the commit that set
its current tag (`git log -S "file?v=tag" -- index.html | tail -1`, then
`git diff --quiet <that> HEAD -- file`). The batch above covered the files
named in "needs a bump" notes; these five changed after their tags with no
note:

| file | was | now | changed since by |
| --- | --- | --- | --- |
| `nso_support_aim.js` | `support1` | `support2` | `ad22e9a` |
| `nso_stock.js` | `stock2` | `stock4` | `0b3f572` (`stock3` was used once before, so skipped) |
| `nso_path_sweep.js` | `taper1` | `taper2` | `2aa07a2` |
| `nso_support_tree.js` | `tree4` | `tree5` | `548a704`, `e50eaea` |
| `app-oversize-washer.js` | `oversize1` | `oversize2` | `f1aeac3` |

After this, no tagged file differs from its tag's content. Five scripts still
load untagged (`nso-cooling-profiles.js`, `nso-3mf.js`, `nso-3mf-read.js`,
`nso-gcode-lines.js`, `nso-watch.js`); they were untagged before and are
left so.

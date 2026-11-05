## CI - GitHub Actions runs `npm test` on every push

`.github/workflows/test.yml`. Triggers: every PR into `main`, every push to
`main` or `claude-wip`, plus `workflow_dispatch`. The job is named **npm test**,
so that is the status-check name to tick in branch protection.

It runs `npm test` as one step rather than listing the suites in YAML, so CI
cannot drift from package.json. Add a suite to the `test` script and CI runs it;
nothing to change in the workflow.

**THE WORKFLOW FILE MUST EXIST ON `main`.** Learned the hard way on 2026-09-15,
and it is invisible if you do not know it. For a `pull_request` event GitHub
reads workflow definitions from the PR's MERGE REF - base merged with head - not
from wherever the file happens to live. While `test.yml` was only on
`claude-wip`, PRs into `main` queued NO run at all: not a failure, not an error,
no entry in the Actions list to find. The required check simply sat on "Expected
- waiting for status to be reported" forever and blocked every merge into main.
Searching Actions for the branch returns nothing, because nothing was ever
created. A branch may carry a newer copy, but `main` must always have one.

Corollary, and the reason a PR can fix this at all: a workflow added in a
same-repo PR IS in that PR's merge ref, so such a PR runs its own check and
bootstraps itself out of the deadlock. PR #46 did exactly that.

**The workflow deliberately does not list the suites or their check counts.**
It used to. The inventory drifted within a single day - the commit that added
`3mf:import` and `3mf:import-drive` to the `test` chain updated the comment's
total but not its table, so the file shipped claiming nine suites when
package.json ran eleven. package.json's `test` script is the one definition;
read it there. The check NAME is what branch protection pins, and that stays
`npm test` however the suite grows. The copy on `main` and the copy on
`claude-wip` are byte-identical, deliberately, so they cannot conflict on merge.

As of 2026-09-18 `nso_wire_extract_sel_test.js` is in that chain too, for
Extract selection, through the same harness as the rest of the wire-* set. It
targets through the app's own select-paint hit path, clicks the real button,
runs `NSO_edgeStats` on what lands on the plate, and hashes the source piece
either side of the extraction so "the original is untouched" is measured rather
than asserted.

One gate in it is worth keeping when that file is next edited: the shell
builder is called DIRECTLY with a patch that turns a corner, because the SELECT
list holds one face and the UI cannot aim that case. It is not padding - it is
the gate that caught the mitre reading 1227.2mm^3 where the answer is 931.2,
from area-weighting vertex normals by triangle instead of by distinct face
direction. Every UI-reachable case passed while that was wrong, because a
single flat face has one normal and cannot tell the two apart. A feature whose
UI can only reach the easy half of its own maths needs the other half called by
hand, or the bug ships green.

As of 2026-09-15 the wire-* trio is IN `npm test`, so Smooth, Seal->Repair and
Join->Fusion are gated by CI rather than only checked by hand. They run through
`tools/nso_app_harness.js`, not `cth-test/browser-lib.mjs`: that harness resolves
Chromium itself in `chromiumPath()`, which probes `/opt/pw-browsers` and returns
`undefined` on a runner, so Playwright falls through to its own pinned build.
Checked, not assumed. They also exit `fails === 0 ? 0 : 1`, which is what makes
appending them to the `&&` chain an actual gate rather than decoration.

Still NOT in CI, because still not in `npm test`: `grispr:test` (Python) and the
suites for modules that remain unwired - `nso_inside_corners_test.js`,
`nso_paint_scope_test.js`, `nso_repair_regress.js`, `nso_fuse_*_test.js`,
`sculpt_selftest.js`. Deliberate. Add to the `test` script to gate them; the
workflow needs no change.

**`npm test` needs python3, not just Node and Chromium.** `selfint:equiv` spawns
`python3` per fixture - it is the only thing keeping `tools/mesh_validate.py` and
the transcription in `NSO_Repair.js` from drifting apart again, which is how
three copies of that checker came to exist. There is no `setup-python` step:
ubuntu-latest ships Python 3 on PATH and the green runs are the evidence. If a
runner image ever drops it, this is the suite that breaks first, and the fix is a
`setup-python` step in the workflow, not a change to the test.

**No CHROME_PATH here either.** `npx playwright install` fetches the exact
revision the pinned Playwright wants (`chromium_headless_shell` v1194 for
`playwright` 1.56.1) and CI has the outbound access to do it. The web sandbox
does not, which is why the pin is matched to the build that is already on that
box - see the 3MF checks section above. Neither path sets `CHROME_PATH`.

**A runner DOES have outbound network.** Measured 2026-09-15, not assumed:
`cdn.jsdelivr.net` returns 200 for the manifold js (74762 B), the manifold wasm
(541470 B) and three.min.js (607784 B). So CI *could* use the CDN. It does not:
`browser-lib.mjs` serves `vendor/manifold/` and the `three` devDependency, and
`drive-check.mjs` asserts the substitution happened, so the hermetic path is the
tested path and a CDN outage cannot redden the build. The vendored sizes match
the CDN's byte for byte, so the copy is not a stale fork.

Cost on ubuntu-latest: see the commit that added the wire-* suites for the
current figure. Before them it was **42s green** (checkout 2s, node 1s,
`npm ci` 2s, playwright chromium 24s / 114 MiB, `npm test` 10s); the three wire
suites add roughly 14s of browser time. Red is faster, since `npm test` stops at
the first failing suite. No browser cache step - it saves ~20s and adds a
failure mode.

**Negative-controlled, not assumed.** Branch `ci-selftest-negative`, two runs
differing by exactly one line - an off-by-one in `app-mask.js` `nsoMaskCount()`:

    run 1  FAILURE  cth:unit ALL GREEN, then cth:capture 26/27,
                    "FAILED the face was painted (expected 1, got 0)", exit 1
    run 2  SUCCESS  same runner, same workflow, regression removed

`cth:unit` passing first in the red run is what makes it meaningful: a real
browser launched and a real page ran, so the red came from the app, not from a
broken setup. Branch deleted after; the pair is recorded here.

**Still to do by a human with admin rights:** making it merge-blocking needs
Settings -> Branches -> branch protection rule on `main` -> "Require status
checks to pass before merging" -> tick **npm test**. Not doable over the API
with this connector's permissions.

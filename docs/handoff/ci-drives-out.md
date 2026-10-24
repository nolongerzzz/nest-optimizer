## The steps that launch a browser leave `testSteps` for `driveSteps`; CI runs 8 shards (ci-drives-out, 2026-10-24)
Branch `claude/ci-drives-out`, on `claude-wip` with #289 (ci-shard-split-2) merged in. Files:
`package.json` (`driveSteps`, `test:drives`), `tools/run-tests.mjs`, `tools/run-tests-parallel.mjs`,
`tools/test-weights-check.cjs`, `tools/test-weights.json` (one line of prose), `.github/workflows/test.yml`,
`docs/TESTING.md`, `docs/CONTRIBUTING.md`. No product code; no test or check changed; no script deleted.

**Why.** Everyday testing (`npm test`, `npm run test:par`, the Tests workflow) was 289 steps and
~13,880 s, of which ~10,930 s was steps that start Chromium. The audit-driver session owns browser
drives now; the rest should not pay for them.

**The split.** `package.json` has a second list, `driveSteps`. `testSteps` (138 steps, ~2,949 s) and
`driveSteps` (151 steps, ~10,934 s) together are the old list exactly: no step lost, none twice, the
weights' sum unchanged (13,883 s). Each keeps the old order. `--check` and `page:manifest` gate 12
now fail on a step in both lists or in neither.

How a step was judged a drive: from its npm script, every file in the command (`a && b`), every
script it reaches through `npm run` or `sh` (globs expanded), every file named in a spawn, and every
module required from those, however far down; a step is a drive when any of them imports playwright,
calls `chromium.launch`, or names `nso_app_harness` or `browser-lib` (comments stripped). The names
are matched wherever they sit in a string, not only in a `require('./...')`: `nso_gscope_speed_test.js`
reaches the harness through `path.join(TREE, 'tools', 'nso_app_harness')`, which a plain require
match misses (so `gscope:speed-orbit`, `-drag-small`, `-drag-file`, ~840 s, were first read as Node).
160 of 289 steps reach a browser: 21 import playwright in their own script (the `.mjs` drives and
`support:workflow-*`), the rest require the harness. As a cross-check, every file reachable from a
step left in `testSteps` was searched for the name of every browser-signal file in the repo: no hit.

**Nine steps launch a browser and stay in `testSteps`** (they are mostly Node checks with a browser
section). Four were named in the ticket: `page:manifest`, `support:curved`, `export:roundtrip`,
`export:multi`. Five more met the same test, measured by running each step with the browser made
unavailable (`PLAYWRIGHT_BROWSERS_PATH`, `PW_CHROMIUM` and `CHROME_PATH` pointed at nothing; the
checks that print before the launch fails) against a normal run:

| step | checks without a browser / all |
|---|---|
| `crop:engine` | 228 / 254 |
| `skin:test` | 99 / 128 |
| `tube:neck` | 199 / 290 (`nso_tube_neck_test.js` is Node; the drag check after `&&` is the browser) |
| `split:parts` | 32 / 52 |
| `overlay:test` | 6 / 11 |

The line is a majority; `measure:test` (40 / 88) and `carve:test` (47 / 108) are under it and are
drives. `export:roundtrip` and `export:multi` are the other way: they launch the browser first and
run no check without it (0 / 36, 0 / 93), so by this measure they are drives. They stay because the
ticket says so; moving them is one line each in `package.json`.

**Running the drives.** `npm run test:drives` is `node tools/run-tests.mjs --list drives`: the same
runner on `driveSteps`, with `--shard`, `--timing-csv`, `--failures-out`, `--touching ... --drives`,
`--shard-plan`, `--merge-timing` and `--weights-from` working on that list. Two small additions
the runner needed: `--print` (a bare `--list` still prints `testSteps`, so `--list drives --print`
prints the drives) and `--only a,b` (one or more steps of the list, by name; a name not in the list
is refused, `--only` with `--shard` is refused). Weights for both lists are in
`tools/test-weights.json`. `--touching` lists from `testSteps` as before; with `--drives`, from
`driveSteps`. `npm run test:cached` is unchanged and covers `testSteps` only.

**Shards.** `SHARDS: 8` in `test.yml`'s `env:` is the one number. The strategy block cannot read
`env`, so a new `plan` job (ubuntu-latest, no test) turns it into the matrix list and checks the
dispatch input against it: a shard number outside 1..SHARDS, a blank, a space or a repeat fails
there, by name, before any shard starts (the input had no check before; its description said
"1-20"). The `shard` job `needs: plan`; `--shard=i/${{ env.SHARDS }}`, the merge step's
`--shards "$SHARDS"` and the job name read the same. `npm test` (the required check) now
`needs: [plan, shard]` and fails with its own message if the plan did. `run-tests.mjs --shard-plan`
and `run-tests-parallel.mjs` read `SHARDS:` out of `test.yml` for their default (on demand, so the
gate job's sparse checkout, which has no workflow file, still works: it passes `--shards`).
`node tools/run-tests.mjs --shard-plan` at 8: 369 s a shard, all eight equal, against 700 s. Five
shards would still be under the budget (590 s); eight is the number asked for.

Not changed: any test or check, the failure report, `CI_RUNNER`, the timing artifacts, `page:manifest`
(it is the same file; `test-weights-check.cjs`, which it shares with `--check`, now reads both lists).
Chromium is still installed in every shard, because nine steps in `testSteps` need it.

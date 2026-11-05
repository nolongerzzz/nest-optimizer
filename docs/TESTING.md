# Testing: the runner, the shards, and the times they keep

`npm test` is `tools/run-tests.mjs`: every step in package.json's
`testSteps`, in order, uncached. It is the gate before any push
([TEST-CACHE.md](TEST-CACHE.md) is the local-only runner that skips steps).
CI runs the same list in `SHARDS` packed shards (`.github/workflows/test.yml`).

## Two lists: `testSteps` and `driveSteps`

package.json has two lists of step names. Each name is a script in `scripts`;
the two lists together are every step, and a name is in one of them only.

| list | what is in it | run by |
|---|---|---|
| `testSteps` | everything that does not launch a browser, plus the nine exceptions below | `npm test`, `npm run test:par`, `npm run test:cached`, the Tests workflow |
| `driveSteps` | every step that launches a browser at run time | `npm run test:drives` (the audit-driver session) |

**A step is a drive** when anything it runs imports playwright, launches
chromium, or uses `tools/nso_app_harness.js` or `tools/cth-test/browser-lib.mjs`:
the script, any other file in its command (`a && b`), a module it requires
(however far down), or a script it reaches through `npm run`, `sh` or a spawn.
A check that runs `withApp(...)` is a drive; so is one that only calls
`chromium.launch` once at the end.

**A new browser drive goes in `driveSteps`, with a `scripts` entry and a line
in `tools/test-weights.json` like any step.** A new Node check goes in
`testSteps`. `--check` (and `page:manifest`, gate 12) fail on a step in
neither list, in both, or without a weight.

**What stays in `testSteps` although it launches a browser.** The rule is
that a step stays when most of its checks pass with no browser, or when every
ticket gates on it. Nine steps do:

| step | why it stays |
|---|---|
| `page:manifest` | every ticket gates on it; 54 of its 60 checks are Node |
| `support:curved`, `export:roundtrip`, `export:multi` | named as mostly Node checks with a browser section |
| `crop:engine` | 228 of 254 checks pass with the browser unavailable |
| `skin:test` | 99 of 128 |
| `tube:neck` | 199 of 290 (`nso_tube_neck_test.js && nso_tube_neck_drag_check.js`) |
| `split:parts` | 32 of 52 |
| `overlay:test` | 6 of 11 |

Those counts were taken by running each step with the browser made
unavailable and again with it; a step under half (`measure:test` 40 of 88,
`carve:test` 47 of 108) is a drive. A step that is mostly a browser drive but
has a Node section stays or goes by this count, not by the section's name.

```
npm run test:drives                              # every drive, in order
node tools/run-tests.mjs --list drives --shard=2/8 --timing-csv out.csv
node tools/run-tests.mjs --list drives --only lift:drive   # one drive, by name
node tools/run-tests.mjs --list drives --print   # the list, run nothing
node tools/run-tests.mjs --touching nso_lift.js --drives   # the drives that reach a file
```

`--list drives` runs `driveSteps` exactly as `npm test` runs `testSteps`:
the same flags (`--shard`, `--timing-csv`, `--failures-out`, `--touching`),
the same failure report, the same weights file. `--touching` lists from
`testSteps` unless it has `--drives`. A bare `--list` still prints the
`testSteps` and exits.

The runner also has four modes that run no test. They read package.json and
the files and answer a question about the suite:

```
node tools/run-tests.mjs --shard-plan [n]                  # the packing, n shards (default: test.yml's SHARDS)
node tools/run-tests.mjs --merge-timing <dir> --out timing.csv   # the shards' CSVs as one
node tools/run-tests.mjs --weights-from a.csv[,b.csv] [--dry-run] # tools/test-weights.json from CI
node tools/run-tests.mjs --touching nso_slicer.js[,app-core.js]   # the steps that reach a file
```

## Shards and weights

A shard is packed by cost, not by count: `tools/test-weights.json` holds what each
step takes on a **typical** GitHub runner, in milliseconds (for both lists),
and the steps are dealt longest-first onto the lightest shard. Every runner
computes the same split from the same package.json. `--shard-plan` prints it,
flags any shard over `SHARD_BUDGET_S` (700 s), and prints the heaviest shard.
That number is the one CI waits on.

The weights only steer the packing. No test reads them, and a step missing
from the table is packed at the median weight, not skipped.

**The shard count is `SHARDS` in `.github/workflows/test.yml`**, one number
in one place. The matrix, each `--shard=i/N`, the timing merge's `--shards N`,
the job names and the check on the dispatch input's shard numbers all read it;
`--shard-plan` and `npm run test:par` default to it. To change the count, change
that line. As of ci-drives-out, `testSteps` is 138 steps, ~2,950 s, and
eight shards pack to ~369 s each, against the 700 s budget. The 151
`driveSteps` are ~10,930 s; `--list drives --shard-plan 20` packs them (at
twenty shards the heaviest is the 579 s `gscope:speed-drag-file`).

## The timing CSV

Each shard writes a row per step as that step ends:

```
step,shard,seconds,result
slicer:bambu,2/10,95.112,pass
gscope:speed,3/10,700.004,fail
```

The command is `--timing-csv timing/shard-N.csv`, and the result is `pass`,
`fail` or `not-run`. A row is appended the moment its step ends, so a shard
stopped at its timeout still leaves the times of the steps it finished. The
shard's run step has its own 57-minute limit, under the job's 60, so the
upload after it still runs.

The workflow uploads each shard's file (`timing-shard-N`, even when the
shard fails). The "npm test" job then merges them with `--merge-timing`
into a single `timing` artifact, `timing.csv`. That file has every declared
step in order. A step no shard reported gets a `not-run` row under the shard
the plan gave it, so a cancelled shard reads as cancelled rather than as a
shorter suite. The per-shard totals go to the run's summary page. The merge
is reporting only: every step of it is `continue-on-error`, and only "Every
shard passed" decides the check.

This is how step times leave CI without anyone reading job logs. The agent
proxy cannot fetch logs. To get the file, open the run in Actions and
download the `timing` artifact.

## Re-measuring the weights: `--weights-from`

```
node tools/run-tests.mjs --weights-from timing-301.csv,timing-305.csv --dry-run
node tools/run-tests.mjs --weights-from timing-301.csv,timing-305.csv
node tools/run-tests.mjs --shard-plan
```

- **A weight is the mean of the step's passing rows** across the files
  given. Two runs averaged beat one.
- **A failing row is not a time.** A step that dies early is short, and one
  that hangs to its timeout is long. A not-run row has no time at all. A
  step with neither keeps its weight, and the report lists it as kept.
- **Rows naming undeclared steps are ignored**, and the report lists them.
- **Rounding** is to the millisecond under a second and to 50 ms above.

**Each shard is first scaled to the typical runner.** The fleet is not one
machine. In Tests #297–#305, about one shard in five ran the same steps in
0.6–0.7 of the time the others took. Unscaled, a step that landed on a fast
shard is weighed ~40 % light, and the next plan piles work onto it. The
scaling works in three parts:

- **A shard's speed** is the median of time ÷ current weight over its rows
  of 20 s or more.
- **The typical speed** is the median of all the shards' speeds.
- **Each row is multiplied** by typical ÷ its shard's speed.

A shard with fewer than three such rows is left as measured. The report
prints every factor.

The command writes `tools/test-weights.json` (each step's note stays) and records what it read in
its `"source"`. `--dry-run` prints the same report without writing.
The weights committed with ci-stability were derived by hand the same way,
from the SUMMARY tables of #297–#305. They also drop the times from before a step's own code
changed, which the CSV route cannot know (the file's `"about"` has the
details). Once a green run has a `timing` artifact, re-measure from it and
commit the result.

When a step's code changes a lot (support:shells went from 190 s to 1,220 s
in one PR), old rows for it are wrong. Pass only CSVs from after the change,
or edit that step's weight by hand.

## Which steps reach a file: `--touching`

```
$ node tools/run-tests.mjs --touching nso_slicer.js
--touching nso_slicer.js: 15 of 257 steps, directly or through 1 product file(s) that use it: app-gscope-slice.js
  slicer:bambu      tools/nso_slicer_bambu_check.js requires nso_slicer.js
  gscope:select     tools/nso_gscope_select_test.js names NSO_GSCOPE_SLICE (app-gscope-slice.js), which uses nso_slicer.js
  ...
```

Use it to name a kickoff's gate list. It lists from `testSteps`; add
`--drives` to list from `driveSteps` instead (a ticket that changes the page
names both). A cross-cutting change keeps missing
dependent tests: slicer:supports is obviously the slicer's, but
gscope:select is not, and it goes red the first time CI runs the slice
behind it. `--touching` reads the dependents off the files instead of
from memory. It is a grep, not a module graph, and it works one level deep
on each side:

| | what it reads |
|---|---|
| a step's files | the files its npm script runs (`node X`, `python3 X`, and for `sh X.sh` the files X.sh runs), plus the local modules each of those requires or imports |
| the target's names | its basename, and the ids it exports: `window.X =` (and `root.`, `globalThis.`, `self.`, `global.`), `module.exports.X`, `exports.X`, `export function/const/class X`, `export { X }` |
| the target's users | the product files (repo root and `cth/`) that require the target or name one of its names |

A step is listed when one of its files requires the target or a user, or
names one of their names. Every line says which link put the step there.
Comments are stripped before matching, so a comment that mentions
`nso_slicer.js` is not a use of it. String contents are ignored when
reading a file's exports, so a worker's source text exports nothing.

Its limits, so a short list is read rightly:

- **One level each side.** A test that reaches the target through a module
  that reaches a module that uses it is missed. Run `--touching` on that
  module too; it takes a comma list.
- **Top-level function declarations are not counted as exports**, although
  a classic script's are globals. There are too many of them, and too many
  are common words. A file whose whole API is such functions is found only
  by its basename.
- **The list includes, it does not prove.** A step that names
  `NSO_GSCOPE_SLICE` may never call the part of the slicer a change touched.
  Run the steps it lists; a step that is not listed is not proven safe.

## Checks that time something: `tools/nso_pace.js`

A check that says "under 5 s" measures the runner as much as the code. On
GitHub's runners the same steps swing ~1.6× between machines, more on a
shard sharing its cores. About half of the red shards of 2026-10-19 to 10-22
were gates on the clock, on steps nothing had changed. So no assertion
compares wall-clock seconds or fps against a fixed number. A time is
measured in one of these:

| measure | when | how |
|---|---|---|
| **calibration loops** | the work is CPU on one thread: a build, a detect, a pass over a mesh | `pace.time(fn)` (Node) or `pace.timeInPage(page, fn)` / `pace.inPage(page)` around the work (in the page) → `r.loops`. One loop is #262's: 40 passes over 200,000 triangles, ~250–340 ms on the 4-core cloud box, in Node and in the page alike. |
| **frames** | the thing waited on is a repaint or a reaction to input | count `requestAnimationFrame` ticks, with a long wall-clock limit as a hang guard only |
| **a state** | the wait was a fixed sleep "for it to settle" | wait for what it was waiting for: the status line, the debounce timer cleared, the camera still for three frames |
| **a ratio, or the page's own clock** | the product's behaviour is wall-clock by design (a 60 s watchdog, a 200 ms progress beat) | measure on the page's clock and allow for the page thread's own lateness (a lag probe), or gate the work in a gap, the gap less the beat |
| **main-thread ms** | the question is "did the page stay responsive" | the longest task, from the page's side (#262's gscope:speed and input:mode) |

A limit is the old budget converted on the box it was set on. For example,
"under 5 s" on a box where a loop is 300 ms becomes "under 17 loops", so the
gate keeps its headroom in units that travel. The seconds are still printed,
as a `FINDING` line (`pace.finding(label, r)`). A real slowdown therefore
shows in the log while the gate passes, and a gate that fails names both
numbers.

```js
const pace = require('./nso_pace.js');
const r = pace.time(() => buildTheThing());
console.log(pace.finding('the build', r));
check(`the build under ${BUILD_LOOPS_MAX} loops`, r.loops < BUILD_LOOPS_MAX, `${r.loops.toFixed(2)}`);
```

A new check that times something uses one of these. One that would read
`ms < N` is the pattern this replaced.
- **`?v=` tags** are checked by `page:manifest` (gate 11): a tag that is not its file's hash fails it. The fix is always `npm run stamp`.
- **Step weights** are `tools/test-weights.json`, one step per line, not package.json; `run-tests.mjs` reads it for shard packing, and `--check` (also `page:manifest` gate 12) fails on a step (in `testSteps` or `driveSteps`) with no entry, an entry with no script, or a step in both lists.
- **Handoff index:** `page:manifest` (gate 13) fails if the generated list in `docs/HANDOFF.md` is not every `docs/handoff/*.md`; the fix is `npm run handoff:index`.

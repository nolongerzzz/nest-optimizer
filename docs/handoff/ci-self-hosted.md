## CI on the owner's laptop runners, and a red shard that says what failed when it ends (ci-self-hosted, 2026-10-24)
Branch `claude/ci-self-hosted`, off `claude-wip` 274b8bd. Files: `.github/workflows/test.yml`,
`tools/run-tests.mjs`, `tools/ci-failures-check.mjs` (new), `package.json` (the `ci:failures`
script and step), `tools/test-weights.json` (its weight). No product code; no test or gate
changed.

**The switch.** Repo variable `CI_RUNNER` (Settings -> Secrets and variables -> Actions ->
Variables).

| `CI_RUNNER` | event | shard jobs run on |
|---|---|---|
| unset / empty | any | `ubuntu-latest` (today's flow, unchanged) |
| `self-hosted` | `pull_request` | `ubuntu-latest` (the repo is public) |
| `self-hosted` | full run (push, or dispatch with `all`) | `[self-hosted, nso, main]` |
| `self-hosted` | dispatch that names shards | `[self-hosted, nso]` |

The "npm test" gate job is always `ubuntu-latest`. A push to `main` is a full run, so with
`self-hosted` set it goes to the laptop; unset the variable to put it back.

**The `shard` input** is a string: `all` (default), or shard numbers, comma-separated, no
spaces: `7`, `1,2,3,4`. The matrix is built from it as before. A full run keeps concurrency
group `tests-<ref>`; a dispatch that names shards is `tests-<ref>-shards-<list>`, so a re-run no
longer cancels the batch it was dispatched for (two dispatches of the same list still cancel
each other, and so do two full runs).

**The failure report.**
- `node tools/run-tests.mjs --shard=N/20 --failures-out failures/shard-N.txt`. The moment a step
  fails the runner prints, to the log, a block:
  `=== FAILED: <step> (shard N) ===`, `command: npm run <step>`, `result:` (exit code, or "stopped
  by SIGTERM (the step's timeout, or a cancel)"), `seconds:`, every line matching `FAILED` /
  `FAIL` / `not ok` (capped at 500, line length at 400), and the last 40 lines of the step's
  output; then `=== end <step> ===`. It also prints
  `::error title=shard N: <step> failed::<first failing line>`. The same block is appended to
  the file as the step ends; the file is emptied when the run starts, so a green shard leaves it
  empty.
- A step that is cut off is reported too: the runner handles SIGINT / SIGTERM, which is what the
  workflow step's 57-minute timeout sends it, names the step it was running, and exits 130 / 143.
  The timeout cannot be told from a cancel, so the block says both.
- `--package <file>` runs the `scripts` / `testSteps` of a package.json-shaped file instead of
  package.json. Only `ci:failures` uses it.
- At shard end (`if: always()`) the workflow appends the file to `$GITHUB_STEP_SUMMARY` and
  uploads it as artifact `failures-shard-N`. Its last line is
  `Rerun this shard: Actions -> Tests -> Run workflow, branch <branch>, shard N.` A shard that
  ended red without naming a step (npm ci failed, the runner was lost) gets a two-line note
  saying so, instead of nothing.
- `npm run ci:failures` (`tools/ci-failures-check.mjs`, a step in `testSteps`): a throwaway list
  of one failing step (two failing lines early, a hundred lines of noise, a last failing line)
  and one passing step. The file must name the failing step, its command and exit code, every
  failing line (also those before the last 40), the last 40 lines and not the 41st from the end;
  must not name the passing step or hold its output; the log must carry the block before SUMMARY
  and the `::error` line; a green list leaves the file empty; and a step killed by SIGTERM is
  named with its cause. Weight 600 ms, an estimate.

**Playwright on the laptop.** `runner.environment == 'self-hosted'` runs
`npx playwright install chromium` (no `--with-deps`) with
`PLAYWRIGHT_BROWSERS_PATH=${{ runner.tool_cache }}/pw-browsers`, and writes that path to
`GITHUB_ENV` so the shard step finds the same copy. Each runner has its own tool cache, so each
of the four has its own browser and none races another to install. GitHub-hosted runs keep
`--with-deps`.

**Unchanged:** 20 shards, `fail-fast: false`, the per-shard `timing-shard-N` artifacts, the
57-minute step and 60-minute job limits.

**For the first test (A: 1,2,3,4 on the laptop, B: the same on ubuntu-latest).**
- A dispatch that names shards asks for `[self-hosted, nso]`, not `main`. If the two unlabeled
  runners also carry `nso` (the design says they do), the four jobs may land on any of the six
  idle runners, including those two, so "four heavy shards on one laptop" holds only if all six
  are on that machine. Check where each ran in the job's "Runner name".
- The step times to compare are the `timing-shard-1..4` artifacts. The merged `timing` artifact
  from the "npm test" job is probably not produced at all: see below.
- Steps that behave differently on the Mac: none known; this was written on a Linux cloud box
  and not run on one.

**Found, not fixed (out of scope).**
- The "npm test" job's `Merge them into timing.csv` step is `continue-on-error`, and has failed
  silently since deff6aa moved the weights to `tools/test-weights.json`: its sparse checkout is
  only `package.json` and `tools/run-tests.mjs`, and the runner now also imports
  `tools/migrate-test-weights.mjs` and reads `tools/test-weights.json`
  (`ERR_MODULE_NOT_FOUND`, reproduced locally with that checkout). The `timing` artifact is
  missing as a result; the per-shard `timing-shard-N` ones are fine. The fix is two more lines in
  the sparse-checkout list.
- `--shard-plan 20` puts the heaviest shard at 706 s against the 700 s budget, with or without
  this change (it was 706 s on 274b8bd before it).

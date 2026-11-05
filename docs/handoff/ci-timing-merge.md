## The merged timing artifact comes out again; a multi-shard dispatch runs on the `main` runners (ci-timing-merge, 2026-10-24)
Branch `claude/ci-timing-merge`, stacked on `claude/ci-self-hosted` (#286). Files:
`.github/workflows/test.yml`, `tools/ci-timing-merge-check.mjs` (new), `package.json` (the
`ci:timing-merge` script and step), `tools/test-weights.json` (its weight),
`docs/handoff/ci-self-hosted.md`. No product code; no test or gate changed.

**The bug.** The "npm test" job checks out `package.json` and `tools/run-tests.mjs` only.
deff6aa moved the weights to `tools/test-weights.json`, and `run-tests.mjs` then began to import
`tools/migrate-test-weights.mjs` and read that file at start. In the job's checkout
`--merge-timing` died with `ERR_MODULE_NOT_FOUND`; the step is `continue-on-error`, so the
`timing` artifact stopped coming out and nothing said so. (The per-shard `timing-shard-N`
artifacts were never affected.)

**The fix.**
- The sparse-checkout list gains `tools/migrate-test-weights.mjs` and `tools/test-weights.json`.
- The merge step no longer pipes through `tee` (a pipe hides the exit status). When
  `--merge-timing` fails it prints the output, writes one line to `$GITHUB_STEP_SUMMARY`,
  `timing merge failed - see the step's log`, and exits 1. The step stays `continue-on-error`,
  so only "Every shard passed" decides the check.

**The guard, `npm run ci:timing-merge`** (`tools/ci-timing-merge-check.mjs`, a step in
`testSteps`, weight 600 ms, an estimate). It reads the sparse-checkout list out of `test.yml`
(there must be exactly one `sparse-checkout: |` block), copies exactly those files into a temp
directory, writes a one-row shard csv, runs `run-tests.mjs --merge-timing` there, and checks it
exits 0 and writes `timing.csv` with the header and that row. With the two files taken out of
the list again it fails with the `ERR_MODULE_NOT_FOUND` above: it would have caught deff6aa. A
file that gains a new import or read means a new line in the list, and this fails until it has one.

**Runner labels** (`CI_RUNNER=self-hosted` only; the shard job's `runs-on`):

| event | `runs-on` |
|---|---|
| `pull_request` | `ubuntu-latest` |
| `CI_RUNNER` unset or empty (any event) | `ubuntu-latest` |
| full run (push, or dispatch with `all`) | `[self-hosted, nso, main]` |
| dispatch with a comma in `shard` (`1,2,3,4`) | `[self-hosted, nso, main]` |
| dispatch that names one shard (`7`) | `[self-hosted, nso]` |

Why: #286 sent every dispatch that named shards to `nso`, so the first test's four shards
(`1,2,3,4`) could be placed on the two unlabeled runners as well as the four `main` ones. Only a
single-shard re-run is meant to use the unlabeled pair while a batch holds the four. The five
cases above were run through the expression as it stands in `test.yml` (translated to JS,
`contains` included) and each gave the row shown. `docs/handoff/ci-self-hosted.md` and the
"WHERE IT RUNS" paragraph in `test.yml` say the same.

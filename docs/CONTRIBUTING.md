# Contributing

Rules that are a script, not a convention. Each one exists so two PRs stop editing the same line.

- **`?v=` tags:** run `npm run stamp` before you open the PR; it sets every tag to the first 8 hex of its file's hash (`tools/stamp-tags.mjs`). Never pick a tag by hand; after a rebase, run it again.
- **Step weights:** a new `package.json` script that joins `testSteps` (or `driveSteps`: a step that launches a browser goes there, see [TESTING.md](TESTING.md)) needs one line in `tools/test-weights.json`, `{"weight": ms, "note": "how it was measured"}`; `node tools/run-tests.mjs --check` and `page:manifest` fail without it.
- **Handoff notes:** one file per ticket, `docs/handoff/<ticket>.md` starting with a `## ` heading; then run `npm run handoff:index`. Never append to `docs/HANDOFF.md`, and after a rebase re-run the index rather than merging its list.

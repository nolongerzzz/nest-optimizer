# Contributing

Rules that are a script, not a convention. Each one exists so two PRs stop editing the same line.

- **`?v=` tags:** run `npm run stamp` before you open the PR; it sets every tag to the first 8 hex of its file's hash (`tools/stamp-tags.mjs`). Never pick a tag by hand; after a rebase, run it again.

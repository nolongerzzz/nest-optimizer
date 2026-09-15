# Live preview site for `claude-wip`

`main` is published at <https://nolongerzzz.github.io/nest-optimizer/>.
`claude-wip` is published at <https://nolongerzzz.github.io/nest-wip/>.

## Why it needs a second repository

GitHub Pages builds **one site per repository**, from a single publishing
source. There is no per-branch preview URL, and no Pages setting that serves
`main` and `claude-wip` at two URLs from one repo. The two supported ways to
get a second URL are a subdirectory of the same site (which means committing
build output to `main`, and `main` is protected and off-limits per
`HANDOFF.md`) or a second repository with its own Pages site. This uses the
second repository.

`main`, its Pages configuration, and its published site are never touched.

## How it works

1. You push to `claude-wip`.
2. `.github/workflows/mirror-wip-pages.yml` assembles the site tree from the
   tracked files on `claude-wip`, minus `.github/` and `tools/`, and adds a
   generated `.github/workflows/pages.yml` and `README.md`.
3. It force-pushes that tree to `main` of `nolongerzzz/nest-wip`.
   The preview repo is a disposable snapshot with a single commit, not history.
4. That push triggers `pages.yml` in the preview repo, which deploys the tree
   to that repo's own Pages site.

The push uses a personal access token rather than the built-in `GITHUB_TOKEN`,
both because `GITHUB_TOKEN` has no access to another repository and because
pushes made with it deliberately do not trigger workflows in the target repo.

## One-time setup

Three steps. Step 1 is done. Step 2 needs repo-admin rights, which the CI token does not
have; step 3 is automatic.

### 1. Create the preview repository -- DONE

<https://github.com/nolongerzzz/nest-wip> exists and is empty. Nothing to do.

If it is ever recreated, it must be **public** (Pages on a private repo needs a
paid plan, and the source repo is already public) and **empty** -- no README,
`.gitignore` or licence, since the first mirror run force-pushes over the
default branch. The name must match `PREVIEW_REPO` in the mirror workflow.

### 2. Create the token and store it as a secret

Create a fine-grained PAT at
<https://github.com/settings/personal-access-tokens/new>:

- **Resource owner:** `nolongerzzz`
- **Repository access:** Only select repositories -> `nest-wip`
- **Permissions:** Repository permissions -> **Contents: Read and write**
  (nothing else is needed)
- **Expiration:** your call -- the mirror job fails loudly when it lapses

Then add it to **this** repo at
<https://github.com/nolongerzzz/nest-optimizer/settings/secrets/actions/new>:

- **Name:** `WIP_PAGES_TOKEN`
- **Value:** the token

### 3. Pages turns itself on

No Settings clicks needed. The preview repo's `pages.yml` runs
`actions/configure-pages` with `enablement: true`, which creates the Pages site
on the first run with GitHub Actions as its source.

## First run

Push anything to `claude-wip`, or run the workflow manually from
<https://github.com/nolongerzzz/nest-optimizer/actions/workflows/mirror-wip-pages.yml>.

Watch both halves: the mirror run in this repo, then the deploy run in
`nest-wip`. The first deploy takes a couple of minutes because it
creates the Pages site; later ones are faster. The site is then live at
<https://nolongerzzz.github.io/nest-wip/>.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `WIP_PAGES_TOKEN is not set` | Step 2 not done, or the secret is named differently |
| Mirror push 403s | Token lacks **Contents: Read and write**, expired, or does not list `nest-wip` |
| Mirror is green, no deploy run in the preview repo | Actions disabled in the preview repo, or the token used was a `GITHUB_TOKEN` rather than a PAT |
| Deploy fails on `configure-pages` | The preview repo's Pages source was hand-set to "Deploy from a branch"; set it to **GitHub Actions** |
| Site 404s | First deploy has not finished yet; check the deploy run in the preview repo |

## Notes

- Excluded from the preview: `.github/` and `tools/` (the Node and Python test
  harness). Everything else tracked on `claude-wip` ships, including
  `library/`, `vendor/`, `cth/`, `fixtures/` and `docs/`.
- All asset paths in `index.html` are relative, so the site works correctly
  under the `/nest-wip/` path prefix.
- To rename the preview repo, change `PREVIEW_REPO` in
  `.github/workflows/mirror-wip-pages.yml` and re-scope the token.

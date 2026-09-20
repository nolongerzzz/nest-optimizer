# Deleting from the Library

Task 1 of the delete ticket was an audit: *what mechanism actually exists for a
static, client-side app to delete a file from this repository, and does it need
something that is not in place?* This is that answer, plus how the feature that
was built on it works and what is deliberately not built.

---

## 1. What a Library row is, in the repository

A row is **two** things, not one:

| # | Where | What |
|---|-------|------|
| 1 | `app-library.js`, `var CATALOG` | one authored line: `{ file: 'x.stl', category: '…', source: 'local' }` |
| 2 | `library/x.stl` | the actual mesh the row fetches |

`library/` is **not** a directory listing — GitHub Pages does not serve one, and
`app-library.js` says so at length. The catalog is the only index that exists.

That means "delete" has exactly one honest definition and two failure shapes:

- drop **only the entry** → an unreachable blob. Wasteful, harmless.
- drop **only the file** → a row that 404s on click. A **dangling catalog
  reference** — worse than not deleting at all.

So the implementation does both, and does them **catalog first, blob second**.
If a run dies between the two commits the leftover is an orphan file, which is
the harmless shape. The other order would leave the broken row.

---

## 2. The mechanism, and the part that is not in place

There is no server of ours anywhere in this stack. `index.html` and its scripts
are static files; the only moving part on the hosting side is GitHub Pages. So
there is exactly one way a page can change the repository:

**The GitHub REST Contents API, called straight from the browser.**

```
GET    /repos/{owner}/{repo}/contents/{path}?ref={branch}   -> blob sha
PUT    /repos/{owner}/{repo}/contents/{path}                 write a file
DELETE /repos/{owner}/{repo}/contents/{path}                 remove a file
```

CORS is fine — `api.github.com` allows browser origins. Both writes are
conditional on the sha the read returned, so a concurrent change is rejected
(409) rather than silently clobbered. That part is genuinely available today and
needs nothing new.

### The part that is not in place: the credential

Every write needs an `Authorization` header carrying something with
`contents: write` on this repository. **That credential cannot come from this
repository**, and the options do not include a clean one:

| Option | Verdict |
|---|---|
| Commit a token | **No.** A token in a public repo is a published token. GitHub secret scanning revokes it, usually in minutes, and until it does anyone can use it. |
| GitHub App / OAuth web flow | **The right answer, and not available.** Both need a server to hold the client secret and do the code-for-token exchange. There is no such server. |
| OAuth device flow | **Not available.** It avoids the client secret, but GitHub's token endpoint sends no CORS headers, so a browser cannot complete the exchange. |
| A Pages-side function | **Not available.** GitHub Pages serves static files only; there is no function runtime. |
| Operator pastes a PAT at the moment of the delete | **What was built.** |

**So: this feature requires a fine-grained personal access token, scoped to
`nolongerzzz/nest-optimizer`, with Contents: Read and write, pasted into the
confirmation dialog by whoever is deleting.** It is held in `sessionStorage`
so a run of deletes is not a run of pastes, and it dies with the tab. It is
never written anywhere this code can commit.

That is the thing "not currently in place": **there is no unattended,
credential-free delete, and there cannot be one without a backend.** If a
credential-free delete is ever wanted, the smallest real answer is a tiny
authenticated proxy (a Worker, a Function) holding a GitHub App installation
token — a deployment, not a code change here.

---

## 3. Rewriting the catalog: the honest cost

The blob half is a clean API call. The **catalog** half is not, because the
catalog is *source code*, not data.

`var CATALOG` is a hand-authored JS array, one entry per line, and the repo
leans on that: `tools/nso_skin_fine_test.js` greps `app-library.js` for
`'<name>'` to prove the shipped catalog has not drifted from what the sample
generator writes. Deleting an entry for real therefore means **editing a source
file from a browser**.

That is the fragile bit, and it is confined rather than spread:

- All of it lives in **one pure function**, `removeCatalogEntry(src, file)` in
  `app-library-delete.js`. No DOM, no network, no state.
- It works only inside the `var CATALOG = [ … ];` block, never the rest of the
  file, and verifies afterwards that nothing outside the block moved.
- It requires **exactly one** matching entry line and refuses on zero or two —
  so a name that only appears in a comment, or twice, aborts instead of
  guessing.
- It fixes the trailing comma when the line it removed was the last one.
- It returns a verdict, never a partially-edited string. A refusal means
  **nothing at all is sent** — the catalog write is the first request, so a
  failed edit cannot leave a half-deleted piece.
- `tools/nso_library_delete_test.js` drives it against the **real shipped
  `app-library.js`**: it removes every entry in turn, drains the whole catalog
  front-to-back and back-to-front, and after each edit *actually executes* the
  resulting file in a sandboxed VM and reads the catalog back. "It still parses
  and still lists the right files" is proven, not assumed.

### The cleaner alternative, and why it is not this ticket

Moving `CATALOG` into a data file (`library/catalog.json`) would make the
delete two ordinary API calls with no source surgery at all. It is the better
long-term shape and it is what to do if this feature ever becomes routine.

It was not done here because it is a different, larger change: the catalog
would have to be fetched, which makes `window.nsoLibrary` asynchronous, and
every test that reads it synchronously — plus the generator's grep-based
drift gate — would move with it. That is a refactor of the browser, not the
addition of a delete button.

---

## 4. What was built

### Files

| File | Role |
|---|---|
| `app-library-delete.js` | the whole feature: gate, dialog, API, catalog editor |
| `app-library.js` | one `×` per row; **one call** into the above and nothing else |
| `styles.css` | `.library-del`, `.nso-confirm*` |
| `tools/nso_library_delete_test.js` | the catalog editor, the gate, the single entry point |
| `tools/nso_library_delete_drive_check.js` | the real UI in Chromium, GitHub stubbed |

### The confirmation (Task 2)

A real modal, not `window.confirm` — it has to name the file *and* the
repository and branch it is about to write to, and carry the token field.

What makes it a block rather than a speed bump:

- **Cancel is what the keyboard lands on.** Enter on arrival cancels.
- Escape cancels; a click on the backdrop cancels.
- **Delete is disabled until a token has been typed** — so no single click on
  anything, anywhere, can start a delete.
- Clicking a row's `×` does not also load the piece.
- It stays open while the two commits run, so a refusal lands somewhere it can
  be read; correct the token and press Delete again in the same dialog.
- Cancel/Escape/backdrop are inert *while* a delete is in flight — the requests
  have gone and hiding the window would only hide the answer.

### The permission gate (Task 3 — architected, not built)

There is **no user, session, role or permission concept anywhere in this app**.
Deleting is gated today by holding a repository write token and by nothing else.
For the stated temporary testing use that is the accepted position, and no
gating logic was built.

What *was* done is make adding one a contained change. `app-library-delete.js`
has exactly one function that answers "may this be deleted":

```js
function mayDelete(entry) {
  return { allowed: true, reason: '' };
}
```

> **Updated by the Save ticket.** `Save As` needed the same gate, and two
> separately-hardened paths was exactly what to avoid, so the body above now
> delegates to a shared one — `may('delete', entry)` in
> `app-library-access.js`, which Save's `maySave` also calls. Everything this
> section says about the gate still holds; it is now one function for both
> features rather than one per feature, and the target repository and the
> `sessionStorage` token key moved there with it. See
> [docs/LIBRARY-SAVE.md](LIBRARY-SAVE.md) §4.

- It is declared once and consulted once, at the top of `requestDelete`, before
  the dialog is raised.
- It returns a **verdict object, not a boolean**, so the shape a real check
  needs — a no plus the sentence to show — is already there.
- `app-library.js` does not ask the question at all. Its `×` hands the entry to
  `nsoLibraryDelete.request()` and knows nothing about gates, dialogs, tokens or
  the API.

`tools/nso_library_delete_test.js` asserts all of that structurally: one
declaration, one call site, one mention of `nsoLibraryDelete` in
`app-library.js`, no `api.github.com` and no `confirm(` outside the module, and
`performDelete`/`runConfirm` not reachable from outside.

**Adding a real access check later is an edit to that function's body** — now
`may()`'s body in `app-library-access.js`, one edit covering Delete and Save
together. Nothing else in either feature asks who you are.

---

## 5. What is not covered by the automated tests

The drive check stubs `window.fetch` for `api.github.com`. It has to: a real
call needs a write credential, which cannot exist in CI, and a test that really
deleted files would delete them from the repository it is testing. So the tests
prove the **request sequence, its payloads and its ordering** — not that GitHub
accepts them.

The inverse operation — putting a piece **into** the library — is
[docs/LIBRARY-SAVE.md](LIBRARY-SAVE.md), which reuses this mechanism, this
credential and this dialog pattern, and writes its two commits in the opposite
order for the same fail-safe reason.

The one-time manual check, with a real token:

1. Open the app, click `×` on a throwaway library row, confirm.
2. `git fetch && git log origin/claude-wip` — two commits, "(catalog entry)" and
   "(file)".
3. `curl -I https://raw.githubusercontent.com/nolongerzzz/nest-optimizer/claude-wip/library/<file>`
   → 404.
4. Reload the app — the row is gone.

---

## 6. The first use: the four bordered washers

The `bordered` patch variant set the pattern inside a solid rim on a 0.6 mm
floor. Measured, that standing-rib construction bonds to a stacked part at
**2.857× the contact of a true flat line**, which makes it useless as a
separating washer. All four shipped bordered samples were removed — catalog
entry and `library/` file together:

- `patch_crosshatch_bordered.stl`
- `patch_crosshatch-fine_bordered.stl`
- `patch_zigzag_bordered.stl`
- `patch_ring_bordered.stl`

Done as a commit rather than through the button, because the change is not only
those six lines: `tools/nso_skin_fine_samples.js` generated and byte-gated those
files, so its `BUILDS`, `COPIES` and `CATALOG_FILES` and the
`fixtures/skin-fine/skin-fine.json` manifest moved with them. A runtime delete
edits `CATALOG` and the blob; it does not know about a generator that would put
them straight back on the next `--check`.

`Washers` stays in `CATEGORIES` with nothing in it, exactly as `Supports` does —
the taxonomy is what the list should be able to hold, not an inventory, and the
browser does not draw a category with no entries.

**Only the shipped samples went.** `NSO_SkinPatch` still builds the bordered
variant, the Finish tab still offers it, and `fixtures/skin-patches/` still holds
and gates the three bordered fixtures that `tools/nso_skin_patch_test.js`
exercises. "These four coupons are not worth printing" is not "this geometry
should stop existing".

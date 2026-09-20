# Saving to the Library ("Save As")

The inverse of [deleting from it](LIBRARY-DELETE.md): take a piece that is on
the plate right now and put it into the Library catalog, under a category, so a
generated or test piece can be kept and loaded again later.

---

## 1. The audit: the mechanism is Delete's mechanism, unchanged

Task 1 of this ticket was an audit, with an instruction not to re-derive what
the delete ticket had already established. It does not need re-deriving,
because **none of Delete's findings were about deleting**. They were about what
a static page can do to a repository. Restated, and confirmed still true:

| Question | Answer, from `docs/LIBRARY-DELETE.md` §2 | Still true for Save? |
|---|---|---|
| Is there a backend? | No. `index.html` and its scripts are static files; the only moving part on the hosting side is GitHub Pages. | Yes — same files, same host. |
| How can a page change the repo at all? | The GitHub REST Contents API, called straight from the browser. CORS on `api.github.com` allows it. | Yes. Save uses `GET` + `PUT` where Delete used `GET` + `PUT` + `DELETE`. |
| Where does the credential come from? | Nowhere in this repo. Committed token → published token. GitHub App / OAuth web flow → needs a server for the client secret. Device flow → its token endpoint sends no CORS headers. Pages functions → do not exist. | Yes. A write is a write; none of these turn on *which* write. |
| So what was built? | The operator pastes a fine-grained PAT, scoped to this one repository, `Contents: Read and write`, into the confirmation dialog. Held in `sessionStorage`, dies with the tab, never written anywhere this code can commit. | **Reused as-is.** |

**The thing that is still not in place is the same thing: there is no
unattended, credential-free write, and there cannot be one without a backend.**
If that is ever wanted, the smallest real answer is unchanged — a tiny
authenticated proxy (a Worker, a Function) holding a GitHub App installation
token. That is a deployment, not a code change here.

What Save reuses, concretely, rather than re-implementing:

- **The credential-entry UI pattern** — the same modal shell, the same
  `.nso-confirm*` styling, the same password field with the same "fine-grained,
  contents:write on this repo" hint, the same disabled-until-filled rule, the
  same "stay open on failure so the error can be read and corrected" loop.
- **The token itself.** Both features now read one `sessionStorage` key,
  `nso.library.token`, published by `app-library-access.js`. An operator doing
  a round of library housekeeping pastes once, not once per feature.
- **The target repository.** `owner`, `repo`, `branch`, `dir`, `catalog` and
  the API host are declared once, in `app-library-access.js`, and both features
  read them. Two copies of `claude-wip` is a drift nobody would think to look
  for.
- **The audit's conclusion about the catalog** — `var CATALOG` is authored
  source, not data, so the entry half is text surgery on a source file. The
  reasoning, and the "move it to `library/catalog.json` one day" note, are in
  `docs/LIBRARY-DELETE.md` §3 and still stand.

---

## 2. The order of the two writes, and why it is the reverse of Delete's

A Library row is two things in the repository:

| # | Where | What |
|---|-------|------|
| 1 | `app-library.js`, `var CATALOG` | one authored line: `{ file: 'x.stl', category: '…', source: 'local' }` |
| 2 | `library/x.stl` | the actual mesh the row fetches |

Delete writes **catalog first, blob second**. Save writes **blob first,
catalog second**. That is not an inconsistency — it is the same rule applied to
an operation running the other way.

The two half-finished states are not equally bad:

- **catalog entry, no file** → a row that 404s the moment it is clicked. A
  **dangling reference**. The bad one.
- **file, no catalog entry** → a blob nobody can reach. Wasteful, harmless,
  invisible to every user of the browser.

So the rule is: **a catalog row must never exist without its file.** Which
means the write that *creates* the reference goes last, and the write that
*removes* it goes first:

```
deleting   remove entry, then remove file   ->  a crash orphans the file
saving     write file,   then write entry   ->  a crash orphans the file
```

Both fail into the same harmless shape. Reversing either fails into the broken
one. **The failure-safety direction does flip between an add and a remove; the
invariant behind it does not.**

On top of the ordering, the catalog edit is **computed and proven before any
write is sent**: the catalog is read first and `addCatalogEntry` run against
it, so the common refusals — a name already in the catalog, a `CATEGORIES`
block this code does not recognise — cost nothing at all, not even an orphan.
The file write only starts once the catalog edit is known to be possible.

The request sequence, in full:

```
GET  /contents/app-library.js?ref=claude-wip        read + compute the edit
GET  /contents/library/<name>?ref=claude-wip        is the name free? (404 = yes)
PUT  /contents/library/<name>                       "Library: save <name> (file)"
PUT  /contents/app-library.js                       "Library: save <name> (catalog entry)"
```

The catalog `PUT` carries the `sha` the first `GET` returned, so a branch that
moved underneath is rejected with a 409 rather than silently clobbered. The
file `PUT` deliberately carries **no** `sha` — it is a creation, and a `sha`
would turn it into an overwrite.

### What it refuses, on purpose

**It will not overwrite an existing `library/` file, even one with no catalog
entry.** `library/` holds files that are *not* catalog rows —
`CTH_fixture.stl`, `soften_test_*.stl` and friends are fixtures other checks
load by name — so "no catalog entry" does not mean "spare". A taken name is
refused with the reason and nothing is written.

That also refuses a retry of a save that half-finished earlier, under the same
name: the orphan is in the way, and the operator either picks another name or
removes the orphan. That is the right trade against silently clobbering a
fixture, and the refusal message says so.

---

## 3. The confirmation

A real modal (`#nso-save-back`), not `window.confirm` — it has to carry three
fields and name the repository and branch it is about to commit to.

What makes it a block rather than a speed bump:

- **Cancel is what the keyboard lands on.** Enter on arrival cancels.
- Escape cancels; a click on the backdrop cancels. Each of the three leaves the
  library, the browser and the repository untouched with **zero requests sent**.
- **Save is disabled until a name, a category *and* a token are all present** —
  so no single click on anything, anywhere, can start a write.
- The line above the buttons names the exact file, category, repository and
  branch that are about to change, and **re-reads live as the name and category
  are typed**, so it is never describing a stale answer. A path-shaped name is
  flattened by `normaliseName` and the note shows the flat name that will
  actually be written, before the operator commits to it.
- It stays open while the writes run, so a refusal lands somewhere it can be
  read, with every field still filled in to correct and press Save again.
- Cancel/Escape/backdrop are inert *while* a save is in flight — the requests
  have gone and hiding the window would only hide the answer.

The STL is the **same bytes `Download selected STL` writes**, not a second
export path: `exportActiveModel()` in `app-join.js` was split into
`activeModelSTL()` (which model, which triangles survive, the Y-up → Z-up turn)
plus the download, and both callers now run the same function. The drive check
compares the committed base64 against the exporter's own output byte for byte.

---

## 4. The permission gate — one place, for both features

There is **no user, session, role or permission concept anywhere in this app**.
Writing is gated today by holding a repository write token and by nothing else.
For the stated temporary testing use that is the accepted position, and no
gating logic was invented to dress it up.

Task 5 was to architect for a real check **without building one now**, and
specifically so that Save and Delete do not become two separately-hardened
paths. So the gate moved out of the delete module into a new one both read:

```js
// app-library-access.js
function may(action, entry) {          // action: 'save' | 'delete'
  if (!ACTIONS[action]) return { allowed: false, reason: 'unknown library action: ' + action };
  return { allowed: true, reason: '' };
}
```

- Each feature has exactly one function that asks it — `maySave(entry)` and
  `mayDelete(entry)` — each **declared once and consulted once**, at the top of
  its request function, before the dialog is raised.
- Neither carries a verdict of its own. Both delegate.
- The verdict is an **object, not a boolean**, so the shape a real check needs —
  a no *plus* the sentence to show the operator — is already there.
- A **missing** access module is a **no**, not a yes. A gate that fails open the
  moment a script tag is dropped is not a gate.
- An **unknown action** is refused, so a third library-write feature that
  forgets to introduce itself here fails closed rather than inheriting a yes.
- `app-library.js` asks nothing. Its rows hand entries to
  `nsoLibraryDelete.request()`, and it does not know `nsoLibrarySave` exists at
  all — the Save button is bound inside the save module.

**Adding a real access check later is an edit to `may()`'s body.** One edit,
covering both features. `tools/nso_library_save_test.js` §4 asserts all of that
structurally, including that neither feature re-declares `may`, neither carries
an `allowed: true` of its own, and both report the same write target.

---

## 5. What was built

| File | Role |
|---|---|
| `app-library-access.js` | **new** — the shared gate, the target repository, the token key |
| `app-library-save.js` | **new** — the whole Save feature: gate, dialog, API, catalog editor |
| `app-library-delete.js` | now reads its gate, target and token key from the access module |
| `app-join.js` | `exportActiveModel()` split: `activeModelSTL()` + the download |
| `app-library.js` | `remember()` / `nsoLibrary.add()` — the local half of a save |
| `index.html` | one `#btn-library-save`, and the access script tag before the other two |
| `styles.css` | the category select and the "+ New category" row |
| `tools/nso_library_save_test.js` | the catalog editor, the shared gate, the single entry point |
| `tools/nso_library_save_drive_check.js` | the real UI in Chromium, GitHub stubbed |

A new category is appended to `var CATEGORIES` as well as to the entry, because
`build()` does not draw a category it does not know and a piece filed under an
unknown one would save and then be invisible.

---

## 6. What the automated tests do NOT cover

**The drive check stubs `window.fetch` for `api.github.com`.** It has to: a real
call needs a write credential, which cannot exist in CI, and a test that really
saved files would commit them to the repository it is testing.

So the tests prove **the request sequence, its payloads and its ordering** —
that the file write precedes the catalog write, that the committed STL is byte
-for-byte the shipped exporter's output, that the committed catalog source
really parses and really lists the new piece, that a refused catalog write
leaves no row and no entry, and that a duplicate name is refused before any
write at all.

**They do not prove that GitHub accepts the calls.** That is the same honest
limitation the delete report gave, for the same reason, and the manual one-time
verification with a real token stays a documented, separate step:

1. Open the app, load or generate a throwaway piece, select it in the model
   list, click **Save selected to Library**.
2. Give it a name and a category, paste a fine-grained PAT
   (`nolongerzzz/nest-optimizer`, Contents: Read and write), press Save.
3. `git fetch && git log origin/claude-wip` — two commits, `(file)` then
   `(catalog entry)`, **in that order**.
4. `curl -I https://raw.githubusercontent.com/nolongerzzz/nest-optimizer/claude-wip/library/<name>`
   → 200.
5. Reload the app — the row is there, under its category, and clicking it loads
   the piece.
6. Click its `×` and delete it again, to confirm the round trip closes.

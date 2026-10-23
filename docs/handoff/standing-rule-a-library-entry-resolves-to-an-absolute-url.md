## Standing rule — a library entry resolves to an ABSOLUTE url (added 2026-09-18)
`app-library.js` no longer concatenates `'library/' + name`. It carries a
`SOURCES` table — one entry per library, each with a `base` URL — and every
catalog row names a source. `resolve(entry)` is the only way a file name
becomes something fetchable, and what it returns is a full absolute URL:
scheme, host, path.

Today there is one source and it is this origin, so the bytes fetched are
identical to what the old concatenation fetched. That is the point: the cost
of the rule is zero now, and it is the whole difference later. With a
relative path, "the library" and "this repo" are one statement, and the
fetch, the row tooltip and anything that later wants to say where a piece
came from have all quietly assumed it. With a base per source, a library in
another repo is one new row in `SOURCES` plus entries naming it — no new
code, no fetch change, no UI change.

Two things to keep:

1. **Never write a base as a literal `https://…github.io/…`.** The built-in
   source resolves its base against `document.baseURI`, so it is absolute on
   every origin the page is served from — including the local test harness,
   where a hard-coded production host would be a different origin. A second,
   genuinely remote library is the case where a literal base is correct.
2. **Templates are not catalog entries.** A template stores generator
   parameters, not a file path; `resolve()` has nothing to say about one.
   When they arrive they get their own structure rather than a `category` in
   this taxonomy.

The taxonomy itself (`CATEGORIES`) is a rough first cut and expected to grow:
Skins, Supports, Washers, Shaped Pieces, Test Fixtures. A category with no
entries is simply not drawn, so adding a name ahead of its members is free.
`tools/nso_library_browser_test.js` pins all of it — absolute URLs on every
entry, the grouping, the categories, and that From File still drives
`#file-input` untouched.

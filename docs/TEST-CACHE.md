# Test cache: skip a suite only when nothing it touched has changed

> **Local iteration only. Not a push gate.**
> `npm test` (`tools/run-tests.mjs`) is the mandatory gate before **any** push,
> every time, in full. It never reads this cache and nothing here can make it
> skip a step. A step the cache skipped was **not run**. The cached runner
> prints the same warning at the top and bottom of every run, and refuses to
> run at all when `$CI` is set.

```
npm run test:cached                              # the suite, skipping cached-green steps
node tools/run-tests-cached.mjs crop:test 'wire:*'  # a subset, names or globs
node tools/run-tests-cached.mjs --dry-run        # what would run and why; runs nothing
node tools/run-tests-cached.mjs --no-skip        # run + record everything (warm the cache)
node tools/run-tests-cached.mjs --deps crop:test # a step's recorded dependencies
npm run test:cache-audit                         # traced graph vs the static graphs
npm run test:cache-validate                      # real edits, real shared paths - see below
```

The cache lives in `.git/nso-test-cache/`: per clone, never committed, and
shared by every worktree of the clone.

## The rule

A step is skipped only when **every path its last green run touched is
exactly what it was then**. That means the same bytes for a file, still
absent for a lookup that missed, and the same entry names for a directory
it listed. The command and environment must also match. Each green run is
stored with the commit it ran on and whether the tree was dirty. Up to six
records are kept per step, so hopping between branches keeps hitting. A red
run records nothing.

## The dependency graph is traced, not read

This is where the risk is, so it gets most of the words.

### Why an import graph is wrong for this project

This repo's code reaches its tests three ways. Only the first is visible to
anything that reads `require`/`import`:

1. `require()` of `tools/` helpers.
2. **Text-loading.** `app-cut.js`, `app-crop.js` and friends are classic
   scripts with no exports. The geometry tests `fs.readFileSync` them and run
   them in one shared `vm` context. `crop:test` loads `app-cut.js` because
   Crop calls Cut's `rawFlatCapLoop` by global name.
3. **The real page.** Drive checks start Chromium on `index.html`, whose ~90
   `<script>` tags call each other through globals. `setStatus()` is defined
   in `app-join.js` and called from about forty files. The page also fetches
   fixtures and wasm on its own.

A step can also shell out to `python3 tools/mesh_validate.py`, glob a
fixtures directory, or run `git show` (`wall:test` does).

### What is traced instead

`tools/test-cache/trace.mjs` runs each step under
`strace -f --seccomp-bpf` and records every path any process in the step's
tree opened, `stat`'d, `access`'d, `readlink`'d, `exec`'d or listed with
`getdents`. It also records what the tree wrote, renamed and deleted, and
every outbound socket.

The soundness argument is short. A deterministic process's behaviour is a
function of its inputs, and every file input reaches it through one of those
syscalls. If nothing it touched changed, it takes the same path and touches
the same files. The first divergence would have to be a read of something
changed, and that read is on the record.

The graph is **file-granular on purpose**. It never tries to know which
function in `app-cut.js` Crop uses, only that `app-cut.js` was read, so any
edit anywhere in it reruns Crop.

Details that matter for correctness:

- **Resolution.**
  - Relative paths resolve against each process's own cwd, tracked across
    `chdir` and `fork`, with shared-fs threads followed.
  - Symlinked opens record both the link and its target.
  - Only `ENOENT`/`ENOTDIR` count as "absent" (`readlink` on a plain file
    fails with `EINVAL`, and the file is there).
- **Outputs are not inputs.** A path the step wrote before it ever read it
  is the step's own output, and so is everything under a directory it
  created (every `mkdtemp`). If the output is in the repo, it is recorded as
  an *output*. A skip then requires it to still be there with the same
  bytes, so skipping leaves the tree exactly as running would.
- **A step that reads a file and then rewrites it is refused.** What it
  read is gone, so the run cannot be keyed. The same goes for any watched
  file whose ctime moved while the step ran, which covers you saving a file
  mid-run.
- **The network is refused.** Any non-loopback socket, or any loopback
  socket to the egress proxy's port, makes the step uncacheable, with two
  narrow exceptions:
  - Headless Chromium's own background services (autofill, sign-in,
    component updates, DoH lookups) are recognised by the `CONNECT` line or
    SNI they send. The harness serves the page's own requests from disk
    through `page.route`, so none of them reach the page.
  - Plain DNS on port 53 returns no content.

  Node writes sockets with `writev`, which is not traced, so a Node socket
  can't be inspected and is always refused.
- **io_uring.** File reads through a ring are not syscalls. libuv's small
  `epoll_ctl` batching ring is allowed. Any other ring (libuv's SQPOLL
  file-I/O ring, or any non-Node process) makes the step uncacheable.
- **Hashing.**
  - Repo files (including `node_modules`), the repo's parent directory (the
    optional `../nest-library` checkout) and the temp dir are content-hashed
    with sha256.
  - Toolchain files elsewhere (`/usr`, `/opt/node22`, `/opt/pw-browsers`,
    python's stdlib) are keyed on size + mtime + ctime + inode. No package
    manager or `touch` can put a ctime back.
  - Hashes are memoised on (dev, inode, size, mtime, ctime).
- **Environment.** Every variable the repo's own code names (scanned on each
  run) is keyed, plus the prefixes the toolchain reads (`NODE_`, `PYTHON`,
  `PLAYWRIGHT`, `PW_`, `NSO_`, `LD_`, `UV_`, proxies, `PATH`, `HOME`, locale
  and a few more). Values are stored hashed.

### Deliberately not keyed

Each exclusion is narrow and says why:

- `/proc`, `/sys`, `/dev`.
- `__pycache__/*.pyc`, a pure function of the `.py` beside it, which is keyed.
- Toolchain caches the toolchain rewrites itself: fontconfig caches,
  Chromium's NSS db, Playwright's `DEPENDENCIES_VALIDATED`.
- **The listing of the temp-dir root.** Chromium lists `/tmp` while tearing
  a profile down, and that listing changes with every process on the box.
  The existence of `/tmp` is still keyed. No test reads its inputs by listing
  the temp dir, and `audit.mjs` fails if one ever starts to.

### Audit: traced graph vs what reading the code finds

`npm run test:cache-audit` puts three graphs side by side for every step:

- **traced**: what the cache keys on.
- **naive**: `require`/`import` only.
- **mentions**: every string literal that names a repo file, every
  `<script src>` of `index.html` once a file mentions the page, and shell
  globs, closed transitively.

On the full suite (146 steps, 2026-09-25):

- **Naive import graphs miss 7467 of 7977 traced step→file edges, and every
  step has at least one.** Most are the ~85 app scripts behind each drive
  check, then fixtures and `package.json`.
- **The three shared-code cases that have bitten this project, each
  resolved:**

  | shared code | steps that trace it | naive graph finds | required steps included |
  | --- | ---: | ---: | --- |
  | `app-cut.js`: Cut's cap (`rawFlatCapLoop`), used by Crop | 82 | 0 | `crop:test`, `wire:crop` ✓ |
  | `app-join.js`: `setStatus()` | 89 | 0 | `measure:test`, `cth:capture` ✓ |
  | `NSO_Repair.js`: the checker | 85 | 1 | `wire:repair`, `defects:test` ✓ |

- **"Unseen" files** are mentioned statically but not touched at runtime.
  Every one was reviewed, in four kinds:
  - app scripts that name `mesh_validate.py` in comments (no browser suite
    runs python);
  - `app.js`, which `index.html` does not load (dead to every browser suite);
  - docs referenced from comments;
  - one untaken conditional: `nso-gcode-lines.js` requires
    `nso-3mf-read.js` only for `.3mf` input.

  None of them depends on an input the trace cannot see: the decision not
  to take each path was made from traced inputs.
- **No step reads a file another step writes.** The audit checks this on
  every run, because a skipped writer would otherwise starve a reader.

### Suites the graph cannot confidently resolve

Here the cache over-includes and reruns, never guesses:

| step | status | why |
| --- | --- | --- |
| `gcode:solid-drive` | **never cached; always run, untraced** | **Load-sensitive.** The "Export as solid" click (`gscope-solid-drive-check.mjs:364`) times out at 30s whenever the box is slow enough. Under strace that happens every time; it also happens in plain, untraced CI (shard 5 of the `claude-wip` runs on 495e6d9 and 5b7dad1, 2026-09-25). Untraced on a quiet box it passes (104s, 37/37). This was first written up here as "changes behaviour under ptrace"; CI shows the tracer is only one way to be slow enough. It has no record either way, and is listed in `UNTRACEABLE` (`tools/test-cache/cache.mjs`). The flake itself is the test's problem, not the cache's. **Cause, found 2026-09-26:** G-scope redraws every frame, and under headless software GL the full tabletop slice costs ~2.5 s a frame, so the real clicks made with it on screen (Export as solid, then Read the plate) queue behind several frames - 23 s on a quiet box, past the 30 s default at 2x CPU throttle. Those two clicks now take a 150 s budget (`heavyClick`); the check passes at 3x throttle. It stays untraced. |
| `wall:test` | cached, but dies with every commit | It runs `git merge-base`/`git show`, so `.git/HEAD`, refs and packed objects are on its record. Correct, just short-lived. |
| every step that runs python (~59) | cached | Python lists its script's directory to resolve imports, so **adding or removing any file directly in `tools/` reruns all of them**. A new `tools/json.py` really would shadow the stdlib, so the listing stays keyed rather than narrowed to names python "probably" wants. The first full run in a fresh clone creates `tools/*-out/` and `__pycache__/`, and costs one extra round of reruns for the same reason. |
| every step that loads `package.json` | cached | Node reads it on every module load (`"type"`). Editing `package.json`, even just adding a script, reruns nearly everything. |
| every browser suite (~80) | cached | They load the whole page, so **an edit to any `app-*.js`, `index.html` or `styles.css` reruns all of them**, even ones that never click the feature you changed. That is the price of file granularity on a page of globals, and it is the right side to err on: it is exactly how `setStatus()` reached `measure` and `cth:capture`. |

Other limits:

- **Flakiness.** A green record is a real pass on those inputs, but it is
  one sample. A flaky step that passed once can be skipped. The full
  `npm test` before a push is what re-samples everything.
- **Environment.** A variable outside the keyed set that changes a result
  is the one gap in the environment key. Add it to `ENV_PREFIXES` in
  `cache.mjs`, or name it in code as `process.env.X`, which the scan picks
  up.

## Validation: real edits, real shared paths

`npm run test:cache-validate` edits real files, asks the cache what would
run, and restores them (verified byte for byte). Add `--run` for the
end-to-end case.

1. **Cut's cap → Crop, four hops deep with no import.** The chain for
   `wire:crop` is:
   - `tools/nso_wire_crop_test.js`
   - → `require('./nso_app_harness')` (the only import)
   - → `index.html`, served to Chromium
   - → `<script src="app-cut.js">`
   - → `rawFlatCapLoop`, called from `app-crop.js` by name.

   The edit flips the cap's winding rule (`keepMin ? -1 : 1` →
   `keepMin ? 1 : -1`): a real bug. Result: `crop:test` and `wire:crop`
   rerun, **81 steps rerun and 64 still skip**, and every rerun step had
   `app-cut.js` on its record.

   **With `--run`:** the cached runner ran `crop:test`, it **went red**
   ("the sealed piece is not closed (open 8…)"), nothing was recorded, and
   with Cut restored it was cached-green again.
2. **`setStatus()` in `app-join.js` → `measure:test`, `cth:capture`.** Both
   rerun, along with 88 steps in all.
3. **`NSO_Repair.js` → `wire:repair`** and 84 steps in all.
4. **Control: a docs-only edit reruns nothing.**

## Speedup

Measured on the 4-core sandbox, sequentially, against an untraced
`npm test` of the same tree on the same box.

Baseline: `npm test`, untraced, on the same box, **2245s** (146/146 green).

| the edit (then `npm run test:cached`) | ran | skipped | wall | vs `npm test` |
| --- | ---: | ---: | ---: | ---: |
| nothing | 1 | 145 | 103s | **21.8x** |
| a test file (`tools/nso_crop_test.js`) | 2 | 144 | 126s | **17.8x** |
| a docs file | 1 | 145 | same run set as "nothing" (dry run) | ~22x |
| a feature file (`app-crop.js`) | 77 | 69 | 1604s | **1.40x** |
| the python checker (`tools/mesh_validate.py`) | 55 | 91 | 1926s | **1.17x** |

The cache check itself is about 1s. In every row, about 100s is
`gcode:solid-drive`, which always runs untraced because it is too load-sensitive to trace. That is
also why "nothing" is 103s and not 1s.

Read the table honestly:

- **Edits to a test, a fixture used by one suite, a `tools/` helper, or a
  node-only module are where this pays off.** Those are 1-10 steps instead of
  146, and minutes instead of 37.
- **An edit to anything the page loads reruns every browser suite (~80),**
  and the win drops to about 1.4x. Tracing costs something on top.
- **`tools/mesh_validate.py` and anything else python imports are shared by
  the heaviest non-browser suites** (the support-tree checks alone are about
  600s), so the win is small there too.

The dry run tells you which row you are in, in about a second, before you
spend any time: `node tools/run-tests-cached.mjs --dry-run`.

What it costs when it misses: every step the cached runner runs is traced.
Across the 106 steps rerun in the rows above, compared step by step with the
untraced baseline, tracing cost **1.28x** in total. Compute-bound suites
(`tree:*`, `fit`, `support:canonical`) pay about 1.00x. Browser-heavy ones
pay the most: `lock:test` 2.66x, `wire:integration` 2.30x, `wire:solidify`
2.06x. Every run is traced, because a trace is what makes the next skip
safe.

# Nest Optimizer — Architecture Audit

Scope: user intent → operation → validation → listener capture → driver hooks.
Basis: direct reading of `app-core.js`, `app-join.js`, `app-join-triple.js`, `app-poslock.js`,
`app-center-lock.js`, `app-seat-surface.js`, `app-oversize-washer.js`, `app-mirror.js`, the `cth/`
harness, `app-cth.js`/`app-cth-expose.js`, plus targeted grep across all ~47 `app-*.js` and ~28
`nso*.js` files. Deep-code sections (full mesh-boolean internals of `app-join.js`, the packing
algorithm) are summarized, not exhaustively traced — flagged below where a deeper pass would help.

---

## 1. Architecture Map

No build step. `index.html` loads everything as classic `<script>` tags, in a fixed order; there
is no module system for the app layer (only `cth/` is ES modules, loaded conditionally).

```
index.html            markup + full script load order (source of truth for boot sequence)
app-core.js           state object, THREE.js scene/camera, pack/nest, undo stack, export — 4026 lines
app-join.js           mesh-boolean toolkit (Join/Seat/Subtract) + ACTUAL APP BOOTSTRAP — 3813 lines
app-*.js  (~47 files) one feature per file: Mirror, Fatten, Hollow, Scale, Carve, Skin, Brush, ...
nso_*.js  (~20 files) headless geometry kernels, THREE-free, flat triangle-soup arrays, run under Node
nso-*.js  (~8 files)  format/infra globals: 3MF read/write/scene, G-code, cooling, live Watch
cth/                  optional click-test/drive harness, ES modules, loaded only via ?cth=... URL
docs/                 one .md per feature, written in the same voice as status-line messages
fixtures/, library/   STL test fixtures and the in-app STL catalog
tools/                Node-run test/probe/audit scripts (the bulk of package.json's test suite)
```

**Naming convention** (historical, not rigorously enforced except the `app-*` / `nso*` split):
- `app-X.js` — DOM layer. Reads `<input>`/`<button>` via `getElementById`, wires `addEventListener`,
  calls into geometry code, commits results into the shared `state` object and THREE scene.
- `nso_X.js` (underscore) — headless algorithm kernels operating on `Float32Array` triangle soups,
  exposed as globals (`NSO_Hollow`, `NSO_fuseFindMating`, ...), reusable from Node/tests.
- `nso-X.js` (hyphen) — skews toward file-format/infra concerns (3MF, G-code, cooling profiles,
  the live Watch self-check) rather than mesh algorithms.
- `cth/` — isolated test/QA harness; nothing else in the app imports it.

**Two things worth flagging explicitly:**

- **`app.js` (9934 lines) and `app.full.js` are dead code.** Neither is referenced by any
  `<script>` tag in `index.html`; `app.js` is a stale pre-refactor monolith (missing fields
  `app-core.js` later grew, e.g. `plateGridMode`, `plateLock`) and `app.full.js` is a 16-byte
  placeholder. They should be deleted or clearly marked archival — anyone grepping the repo for
  "the app" will land on the wrong 10,000-line file first.
- **The real entry point lives inside `app-join.js`, not `app-core.js` or `index.html`.** Its tail
  (`setupUI()` at line 3349, `// ===== Boot =====` near line 3792) is what actually calls
  `initThree(); setupUI(); updatePlateInfo();` and wires dozens of unrelated buttons (frame-view,
  xray, plate grid, cut-axis, yaw). A file named after one feature (Join) is structurally the
  bootstrapper for the whole UI — a naming trap for new contributors.

Representative per-file shape: `app-mirror.js` (375 lines) is a clean instance of the intended
pattern — a thin wrapper around a compute function, gated, then committed. Most `app-*.js` files
(Fatten, Hollow, Scale, Carve) follow it. `app-join.js` is the outlier both in size and in mixing
concerns (mesh boolean toolkit + app bootstrap).

---

## 2. Data Flow

The join path itself spans multiple internal routes (planar fuse / legacy geometry / plate route)
and is too large to trace line-by-line here — flagged for a deep dive if needed. Below is a fully
traced smaller example (**Mirror**) that follows the *same* structural pattern Join uses
(gate → compute → gate result → commit), just at readable scale, followed by Join's shape at the
same altitude.

```
USER GESTURE                 EVENT HANDLER              VALIDATION              COMPUTE            COMMIT / STATE UPDATE
─────────────                ──────────────              ──────────              ───────            ──────────────────────
click "Mirror"      ──►  app-mirror.js:330        ──►  NSO_mirrorSelectedModel  ──►  NSO_mirrorRaw ──►  NSO_mirrorCommit
  (#btn-mirror)           wireMirrorButton()             (app-mirror.js:280)         (app-mirror.js:174)   (app-mirror.js:313)
                          - blank plane? dry-read         - active piece exists?     - resolve axis/plane    │
                            NSO_mirrorResolve, fill        - m.rawTris + zup axis?    - reflect verts,        ├─ pushUndo()          (snapshot)
                            input, return                 - nsoMaskCount(m) > 0?       swap winding           ├─ mutate model record  (rawTris, size)
                          - else: mirror for real            → refuse "painted       - GATE the result:       ├─ rebuild THREE.Mesh
                                                              faces: N"                 tri count, weld       │    (state.modelGroup)
                                                                                        count, open/non-      └─ setStatus(...)  → #status
                                                                                        manifold edges,
                                                                                        volume sign preserved
                                                                                      → {ok,reason,tris,...}
```

Every step returns a status object (`{ ok, reason, ...data }`); nothing throws for an expected
refusal. `animate()`'s render loop (app-core.js:721) then just draws whatever is currently in
`state.scene` — there is no separate "redraw" call from the operation itself.

**Join, at the same altitude** (from `app-join.js` / `app-join-triple.js`):

```
click "Seat (support)"  →  seatSupportBitToHull()          →  require live Join session, A≠B,
  or "Join → Triple"        (app-join.js:2261)                 both placed  →  seatBitAtGap()
                                                                (app-join.js:2339)
                                                                  → NSO_seatFlushBitToHull()   (corner-ray fit;
                                                                     (app-join.js:991)           refuses on straddle,
                                                                                                  missed corner ray,
                                                                                                  residual > 0.25mm)
                                                                  → post-hoc: would this sink the
                                                                    bit below plate? if so ok:false
                                                                    even though geometry moved
                                                                → commit: pushUndo, mutate placed[],
                                                                  rebuild mesh, setStatus
```

`app-join-triple.js`'s `NSO_TripleJoin.run()` is pure orchestration on top of this: it calls
Center-lock + `seatBitAtGap` twice (A–B, then B–C) and, if one junction fails, explicitly reports
which seam is seated and which is untouched rather than silently unwinding both — the one place in
the audited code where a compound operation reasons about partial failure.

**Global state & piece representation** — one global `state` object (`app-core.js:13`), read/
written directly by every file (no module boundaries):

- `state.models[]` — the catalog: `{ id, name, geometry, quantity, size, rawTris, rawAxis,
  centerOffset }`
- `state.placed[]` — instances on the plate: `{ sourceId, x, z, mesh, geometry, width/depth/height,
  rotY, tipX/tiltX, flipX, liftY, posLock, ... }`
- Feature sub-state lives on `state` too, e.g. `state.joinSession`/`joinFaceA/B`, `state.cutT`/
  `cutAxis`, `state.plateLock`, `state.xray`.
- `state.undoStack`, popped by `undoLast()` (app-core.js:166), reverses whatever the matching
  commit wrote.

---

## 3. Function Signatures by Layer

### Operations layer (representative sample — the full inventory is ~47 files, one per feature)

| Function | File:line | Does | Refuses on |
|---|---|---|---|
| `NSO_seatFlushBitToHull` | app-join.js:991 | Corner-ray seat of bit onto hull, flush or at signed gap | bad gap args, empty hull, bit straddles face, corner ray misses hull, residual fit > 0.25mm |
| `seatBitAtGap` | app-join.js:2339 | UI-facing seat at a requested gap | (delegates above) + result would sink bit below plate |
| `NSO_TripleJoin.run` | app-join-triple.js | Chains two junctions (A-B, B-C) via Center-lock + seat | no live trio, gap out of range, A/B/C share XZ spot, either junction fails |
| `NSO_CenterLock.run` | app-center-lock.js | XZ-centers B onto a reference point on A | no live A/B pair, no computable centroid |
| `NSO_seatHereAt` | app-seat-surface.js | Seats B against an arbitrary clicked point on curved/irregular A | no session, wrong pick target, B not placed, B position-locked, gap out of range, B is painted and needs rotation, result below plate |
| `NSO_mirrorSelectedModel` / `NSO_mirrorRaw` | app-mirror.js:280/174 | Mirrors active piece across detected/typed plane | no rawTris/wrong axis, painted faces, post-mirror gates (tri count, manifold, volume sign) |
| `nsoPosLockBlocks(p, verb)` | app-poslock.js:121 | Gate consulted by drag/nudge/pose buttons | piece or whole-plate position-locked |

Not fully re-derived here (flag for deep dive if needed): the packing/nest algorithm in
`app-core.js` (`packModels`/`runOptimize`) and the full mesh-boolean internals of `app-join.js`
(union/subtract soup helpers) — both large enough to warrant their own pass.

### Validation layer — one converged convention, used with unusual discipline for a script-tag app

```js
// app-join.js:3332 — the one status-line sink, called defensively from every other file
function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : ' success');
}
```

- Pure/geometry functions return `{ ok: false, reason: '...' }` — **never throw** for an expected
  refusal (`NSO_seatFlushBitToHull`, `NSO_CenterLock.run`, `NSO_TripleJoin.junction`,
  `NSO_seatHereAt`, `NSO_Assemble.attach`, `NSO_extendDetectAxis`, ...).
- UI-facing wrappers both call `setStatus(msg, true)` **and** return `{ok:false, reason}` — two
  ways to detect failure, which is why chained callers (`app-join-triple.js`) capture
  `lastError()`/`lastReason` explicitly rather than scrape the status line (a comment at
  app-center-lock.js:141-146 calls scraping it "load-bearing" and rejects it).
- `throw new Error(...)` is reserved for a narrower class: missing required modules at load time
  (`app-library-*.js`, `app-wheel.js`) and CSG-kernel-level failures (`app-finish.js`) — "this
  should never happen in a working install," not an ordinary user refusal.
- Reason strings are treated as a stable contract, not throwaway text — several are pinned by
  tests (`tools/nso_seat_side_test.js`, `tools/nso_join_triple_test.js`).

### Listener layer (`cth/`) — see §5 for full detail; signature summary here

```js
// cth/harness.js:27-62 — the captured-event record
const entry = {
  testId, title, reactionMs,
  camera: host.getCameraState?.() ?? null,
  clickScreen: { xPix, yPix, xNDC, yNDC, canvasWidth, canvasHeight },
  hit: hit?.hit ? { objectId, region, point, normal, distance } : null,
  expected: acceptFor(t),
  result,   // 'pass' | 'fail' | 'miss'
};
```

`gradeHit(accept, hit)` (cth/grade.js:18) is the pure comparator that produces `result`.

---

## 4. Validation Gates Inventory

24 gates sampled across 20+ files (grep for `refuse`/`ok:false`/`throw new Error` plus close
reading of the join/lock/seat family). Roughly **two-thirds are real physics/manufacturing
preconditions**, reused consistently via shared detectors (e.g. `NSO_extendDetectAxis` powers
Extend/Fatten/Mirror/Wheel alike) rather than reimplemented per file. **The remaining third are
workflow/UX guard rails** — position-lock, paint/mask scope conflicts, "pick A and B first,"
file-name sanitizers.

| # | File:line | Fires when | Blocks | Message | Kind |
|---|---|---|---|---|---|
| 1 | app-join.js:1107 | corner ray from bit misses hull along punch axis | Seat flush/support | `"corner N missed hull along punch axis"` | **Physics** |
| 2 | app-join.js:1037 | bit straddles target face | Seat flush/support | `"bit straddles that hull face..."` | **Physics** |
| 3 | app-join.js:1069/1196 | fit residual > 0.25mm | Seat gap mode | reason string names the mm off | **Physics** |
| 4 | app-join.js:2373 | resulting lift sinks bit below plate | seatBitAtGap | `"gap NOT as requested"` | **Physics** |
| 5 | app-center-lock.js:173 | no computable centroid (open/degenerate mesh) | Center lock | `"...no centroid for A/B. Try Bounding-box centre"` | Physics-adjacent |
| 6 | app-poslock.js:121 | piece or plate position-locked | drag/nudge/pose buttons | `"Locked - {verb} refused on {name}"` | **Guard rail** |
| 7 | app-seat-surface.js:255 | B is painted and seat needs to rotate B | Seat here | `"Seat here stood down - N painted face(s)..."` | **Guard rail** |
| 8 | app-seat-surface.js:270 | planned pose puts B below plate | Seat here | `"...that pose would put B Xmm below the plate"` | **Physics** |
| 9 | app-extend.js:344 | dominant axis off-cardinal | Extend/Fatten/Mirror | `"dominant axis is off-cardinal by X deg"` | Physics (algorithm precondition) |
| 10 | app-extend.js:465 | no constant cross-section band | Extend/Fatten | `"no constant cross-section band along {axis}"` | **Physics** |
| 11 | app-extend.js:539 | Extend asked to shrink | Extend | `"Extend lengthens only..."` | **Guard rail** (capability scope) |
| 12 | app-brush.js:1588/1776 | wall-thickness gate predicts too-thin wall | Brush stroke | `"...wall too thin here, Thicken first"` | **Physics** |
| 13 | app-fatten.js:229/284 | axis detector + chamfer-width inversion | Fatten | `"Fatten refused - {reason}"` | **Physics** |
| 14 | app-assemble.js:198 | CSG union fails/non-manifold/commit rejected | Attach | `"Attach refused - nothing changed: {reason}"` | **Physics** |
| 15 | app-core.js:1827 | whole-plate lock set | Optimize (repack) | `"Plate locked - Optimize refused..."` | **Guard rail** |
| 16 | app-mirror.js:44 | oblique mirror plane (reuses Extend detector) | Mirror | delegates to Extend's reason | Hybrid |
| 17 | app-skin.js:19/235 | target face not a flat rectangle | Skin wrap | `"...is not a flat face of this piece any more"` | Physics-adjacent (algorithm scope) |
| 18 | app-texture.js:136 | target face is curved, not flat | Texture | `"...covers a cylinder's curved side..."` | Algorithm-scope |
| 19 | app-library-save/delete.js | access-gate module failed to load | Library save/delete | `throw ...'app-library-access.js is not loaded'` | **Guard rail** (fail-closed) |
| 20 | app-library-save.js:426 | file/category name fails sanitizer | Library save | `throw ...'not a plain library file name'` | **Guard rail** (path safety) |
| 21 | app-scale.js:357/371 | mask/paint data can't be honestly rescaled | Scale | `"Scale refused - piece unchanged"` | **Guard rail** (data integrity) |
| 22 | app-oversize-washer.js:241 | nothing of target under washer centre | Oversize-washer seat | `"nothing of the target lies under the washer's centre..."` | **Physics** |
| 23 | app-wheel.js:1067 | rim-extension sub-steps fail | Wheel rim extension | delegates to Extend's reason | **Physics** |
| 24 | app-finish.js:3592/3619 | CSG kernel status ≠ NoError | Finish/fill ops | `throw 'kernel refused the fill: ' + status` | **Physics** (kernel failure) |

Notable design choice: **`app-oversize-washer.js` deliberately inverts the usual physics gate** —
where a corner-ray refusal would normally stop Seat cold, this mode catches it and appends a
status-line *warning* instead ("report, don't block"), while still enforcing genuine preconditions
(both pieces placed, gap valid, centre actually over the target). It's the one place in the audited
code where a physics gate is intentionally downgraded to advisory.

---

## 5. Listener Implementation (`cth/`)

**What it is.** `cth/` is a manual/semi-automated **click-test harness with a lightweight
event-capture core** — not a general-purpose event recorder. It exists to let a human or a
Playwright script click a specific 3D piece in the live app and have the click graded against an
expected target. It is loaded only behind `?cth=...` in the URL and every file in it is annotated
"pull the plug: delete this" — it is explicitly disposable.

- **`cth/pointer-capture.js`** — intercepts `pointerdown/move/up` (plus a tail-suppression window
  on `click/dblclick/contextmenu/dragstart`) via `stopImmediatePropagation()` so a gesture reaches
  the harness instead of the app's own drag/orbit tools. Tracks `{x, y, dragged}`, classified by a
  24px Manhattan-distance threshold.
- **`cth/harness.js`** — orchestrator. `createClickTestHarness()` steps through a `tests[]` spec,
  raycasts per click (`cth/three-adapter.js`), grades the hit, and rolls results into
  `{results, summary:{pass,fail,miss}}`.
- **`cth/grade.js`** — pure `gradeHit(accept, hit)`: miss if no hit, fail on object-id/region
  mismatch or face-normal tolerance (0.95), else pass.
- **`cth/overlay.js`** — on-screen shadow-DOM status panel.
- **`app-cth-expose.js`** (2-line plain script, loaded first) bridges module-scoped app state onto
  `window` (`window.state = state`) so the ES-module harness can read it.
- **`app-cth.js`** parses `?cth=finish|drive|plate`, dynamically imports `cth/cth-live.js` + a
  test-spec file, and — notably — **patches `window.refreshOutline`** so every real outline
  refresh also renames meshes and rebuilds the raycastable list. This is the one place the app's
  real render pipeline is monkey-patched to keep the harness in sync.

**Data structure captured** (`cth/harness.js:40-48`): `{testId, reactionMs, camera, clickScreen,
hit:{objectId, region, point, normal, distance}, expected, result}` — see §3 for the literal shape.

**Capture scope — what it sees:** raw pointer coordinates (screen + NDC), which mesh/object was
hit and where, camera pose at click time, reaction time, drag-vs-click classification.

**What it misses:** it has **zero knowledge of validation gates** — a refusal from §4 is invisible
to it directly; external Playwright checks (`tools/cth-test/capture-check.mjs`) infer a stand-down
only indirectly, by checking that `#status` does *not* say the expected success text. It records
**no operation name and no before/after piece state** — that bookkeeping is done manually in the
Playwright test scripts (reading `state.placed[0].x/z`, `nsoMaskCount()`), not built into the
harness's own event object. This is the harness's single biggest structural gap relative to what a
driver would eventually need.

A separate, related but distinct passive observer exists: **`nso-watch.js`** (the eye-button "live
watch," `docs/WATCH.md`) diffs rendered scene vs. logical state after every `pushUndo` and *does*
read the operation type off the undo record (`softenReplace`, `maskReplace`, ...) — closer to what
a driver-facing listener would need, but it's a consistency checker, not an event log.

**Where a "Build vs Hypothesis" toggle would hook in:** the single choke point is
**`cth/harness.js`'s `entry` construction inside `handleClick()`** (lines 40-48) — every captured
click becomes a structured record here before being pushed to `results[]`. Adding a
`mode: 'build' | 'hypothesis'` field, sourced from a new option threaded through
`createClickTestHarness({...})` alongside the existing `pointerMode`, tags every record without
touching capture (geometry/gesture-level, mode-agnostic) or grading (only cares about hit vs.
accept spec). A secondary hook: **`app-cth.js`'s `cthMode()`** already parses `?cth=` into named
modes and dispatches to different test-spec/drive modules — a `hypothesis` value could select a
speculative, non-committing drive path the same way `drive` currently selects
`nest-paint-soften-drive.js`.

---

## 6. Driver Anchor Points

*(Synthesis — no operation in the audited code currently exposes this as a formal API; this is
where a driver/agent layer would need to attach, based on what §2–§5 established.)*

**Where a driver reads state:** the single global `state` object (already exposed on `window` via
`app-cth-expose.js`) — specifically `state.placed[]` (pose/position per piece), `state.models[]`
(catalog), `state.undoStack` (recent operation history, though only as opaque snapshots — see
below), and feature sub-state like `state.joinSession`/`joinFaceA/B` to know what's mid-flow.

**Where a driver calls operations:** the UI-facing wrapper functions already return the right
shape for programmatic use — `{ ok, reason, ...data }`, never throw for expected refusals — so a
driver can call `seatFlushBitToHull()`, `NSO_mirrorSelectedModel()`, `NSO_TripleJoin.run()`, etc.
directly, the same entry points the click handlers use, and read the result without needing to
scrape `#status`. This is a genuine strength: the operations layer was already built to be
programmatically drivable, even though nothing currently drives it that way outside the `cth/`
test scripts.

**What's missing for driver reasoning — the gap a driver layer would need to close:**

1. **No operation-name/type metadata on results.** `{ok:false, reason:'...'}` tells a driver an
   operation failed and gives it a human sentence, but not a stable machine-readable refusal code
   or which of the §4 gate categories fired. A driver reasoning about "should I retry with a
   different gap?" vs. "this is a hard physics wall" currently has to string-match `reason`.
2. **No real-physics vs. guard-rail tag on gates.** This audit had to classify all 24 gates by
   reading them; the code itself doesn't mark a refusal as "immutable geometric fact" vs. "policy
   that could be relaxed for a driver operating in a different mode." That classification (§4's
   rightmost column) is exactly the metadata a driver needs to decide whether to retry, request a
   different input, or report failure upward.
3. **No structured before/after state on commit.** `NSO_sculptCommitRaw` pushes a full snapshot to
   `state.undoStack` for undo purposes, but there's no diff/delta object a driver could inspect to
   confirm "what actually changed" without re-reading the whole piece.
4. **The `nso-watch.js` operation-type field is the closest existing precedent** (it reads
   `softenReplace`/`maskReplace` off the undo record) — extending that tagging convention to every
   commit path (not just the ones Watch currently covers) would give a driver a cheap, already-half-
   built hook rather than requiring a new instrumentation layer.

---

## 7. Intuition Layer Assessment

**Where user intent is explicitly coded (not just implied by geometry):**

- **The paint/mask-exclusion rule, repeated across many independent files** — Mirror refuses on
  any painted face (app-mirror.js), Scale refuses if mask data can't be honestly rescaled
  (app-scale.js), Seat-here stands down when a painted B would need rotating (app-seat-surface.js),
  and the dedicated Delete-painted feature treats "Paint Excluded" as "hands off, here as
  everywhere else" (per README). This is user intent — "I marked this face as special, don't touch
  or count it" — encoded independently in each feature rather than as one shared concept, which is
  both a strength (each refusal reads correctly for its context) and a maintenance risk (a new
  feature has to remember to add its own paint check; nothing enforces it structurally).
- **Position-lock's asymmetric scope** (app-poslock.js:25-29): it explicitly does *not* block
  Seat/Center/Align/Skin, only drag/nudge/pose/To-plate — a direct encoding of "a locked piece can
  still receive an operation that puts it where it belongs, just can't be manually nudged." That
  distinction is real user intent about what "locked" means, not a generic on/off switch.
- **`NSO_TripleJoin`'s partial-failure reporting** — explicitly naming which seam stayed seated and
  which didn't, rather than a generic "operation failed," is intent-aware: it assumes the user
  wants to know the plate's actual current state, not just pass/fail.
- **Oversize-washer's "report, don't block"** (§4) is the clearest single instance of intent
  overriding a physics gate on purpose for a named use case.

**Where technical language leaks into user-facing text:**

- `"corner N missed hull along punch axis"` (app-join.js:1107) — "hull," "punch axis," and a raw
  corner index are internal geometry vocabulary, not a description a non-technical user would map
  to "your piece doesn't quite reach."
- `"dominant axis is off-cardinal by X deg"` (app-extend.js:344) — same pattern: correct, precise,
  and opaque to anyone who doesn't already know what a "dominant axis" or "off-cardinal" means in
  this app's model.
- CSG/manifold vocabulary surfaces directly in refusals (`"kernel refused the fill: " + status`,
  app-finish.js; "non-manifold edge counts," app-assemble.js) — these read as debug output rather
  than product copy.
- `rawAxis === 'zup'`, "soup" (triangle array), "residual" (fit error in mm) are all internal
  algorithm terms that occasionally surface verbatim in reason strings.

**Recommendations:**

1. Give every refusal a stable **category tag** (physics / guard-rail / algorithm-scope, matching
   §4's classification) alongside its human sentence — cheap to add at the point each `{ok:false,
   reason}` is constructed, and it's the single highest-leverage change for both driver reasoning
   (§6) and future UI work (e.g. rendering guard-rail refusals differently from hard physics walls).
2. Keep the precise geometric reason string for status-line/debug purposes, but add a second,
   plain-language field for the ones that currently leak jargon (corner-ray, off-cardinal, kernel
   status, manifold counts) — the two audiences (a user deciding what to try next, and a developer
   or test pinning exact wording) don't need the same sentence.
3. Formalize the paint/mask-exclusion rule as one shared check (a `nsoRespectsMask(op, m)` helper)
   rather than seven independent reimplementations — reduces the risk that a new feature forgets it
   and silently touches a face the user marked excluded.
4. Extend `nso-watch.js`'s operation-type tagging to every commit path, not just the ones it
   currently covers — it's the existing precedent closest to what both a driver and a future audit
   would want from every mutation, and the infrastructure (reading the undo record) already exists.

---

*Compiled from: direct reads of `app-core.js`, `app-join.js`, `app-join-triple.js`,
`app-poslock.js`, `app-center-lock.js`, `app-seat-surface.js`, `app-oversize-washer.js`,
`app-mirror.js`, `cth/*.js`, `app-cth.js`, `app-cth-expose.js`, `docs/WATCH.md`; grep sampling
across ~47 `app-*.js` files for refusal/validation patterns. Areas flagged for a deeper pass:
`app-core.js`'s pack/nest algorithm, `app-join.js`'s full mesh-boolean internals, and the parallel
`app.js`/`app.full.js` dead-code question (recommend deleting or archiving explicitly).*

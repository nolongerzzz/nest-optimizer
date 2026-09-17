# Delete painted — audit, build, evidence

Paint a region and **remove that geometry**, as opposed to excluding it from
bakes, which is what mask6's paint has always done.

Three things live here: the Task 1 audit of what was already shipped, the Task 2
design and its safety gate, and the Task 3 evidence. Nothing below is asserted
from reading source. Every claim in §0–§3 is re-checked by

```sh
node tools/nso_paint_delete_audit.js      # npm run delete:audit
```

which drives the real app in real Chromium against real fixtures. Every number
in §5–§6 is re-checked by

```sh
node tools/nso_paint_delete_test.js       # npm run delete:test   (no browser)
node tools/nso_paint_delete_drive_check.js  # npm run delete:drive (real app)
```

and every mesh either of those produces and accepts goes through the canonical
checker, `tools/mesh_validate.py --gate`, as a second and independent authority.

---

## 0. Two corrections to the ticket's premises

**a) The exclude list cannot be the operand.** The ticket says "paint a region
and delete it", and the obvious reading is that the yellow — `faceMask.exclude`,
the skip list — names what goes. It cannot. `docs/HANDOFF.md` carries a standing
owner decision that binds new work as well as old:

> a painted / excluded face stays untouched by ANY bake mechanism

Reading the yellow as "delete this" inverts that rule for one feature, and the
next ticket then has two contradictory statements about what yellow means. It is
also the more dangerous reading: yellow already means "hands off" to every other
tool in the app, so a tool that deletes what is yellow would be the one place
where the protective colour is the destructive one.

It does not need to. mask6 already ships **two** lists (`app-mask.js` header):

| list | colour | meaning | consumers before this ticket |
|---|---|---|---|
| `faceMask.exclude` | yellow | "no bake may touch this face" | Smooth, Repair, Thicken, Fusion, Pocket corners, Skin face |
| `faceMask.select` | pink | "this face is my target", at most one | Skin face |

So Delete reads the **pink** as its operand and the **yellow** as its veto, which
is exactly the shape Skin face already has. The standing rule holds word for
word — an excluded face still stands the operation down and the status still
names it — and Delete becomes the select list's second consumer rather than a
new kind of paint.

**b) The shipped face infrastructure is reusable, but not the triangle
resolution.** The pick that turns a click into a face — `nsoFaceFromHit`
(`app-finish.js`) — is entirely reusable and is reused unchanged. What is not is
the step that turns a stored face into the triangles it covers. That lives in
`buildOverlay` (`app-mask.js`), it works in **display** space off
`placed.mesh.geometry`, it is not exported, and `nsoMaskRepaint` hands back a
*count*, not a set. A delete edits `m.rawTris`, so it needed the same predicate
in raw space. That transcription is the one genuinely new piece of geometry code
in this ticket, and §3 is how it is held to the original.

---

## 1. Reused unchanged

| what | where | used for |
|---|---|---|
| Paint Selected / Paint Excluded buttons, the click routing, both overlays | `app-mask.js`, `index.html` | the whole UI. No new painting mode, no new picking |
| `nsoFaceFromHit` | `app-finish.js` | resolving a click to a face. Never re-derived from a plane and a bounding box — the mistake `app-mask.js`'s own header warns about |
| `nsoMaskSelected`, `nsoMaskSelectClear` | `app-mask.js` | reading and consuming the target |
| `nsoMaskIsExcludedRaw`, `nsoMaskCount` | `app-mask.js` | the veto, scoped to the target's own raw plane |
| `nsoMaskSnapshot` / `nsoMaskRestore`, and `pushUndo`'s automatic `prevMask` | `app-mask.js`, `app-core.js` | one Undo puts geometry and paint back together |
| `NSO_sculptCommitRaw` | `app-sculpt.js` | the commit half: undo entry, display geometry rebuilt, placed instance re-seated |
| `NSO_Repair.inspect`, `_weldToIndexed` | `NSO_Repair.js` | every number the gate reads, and the vertex identity the component count uses |
| `NSO_Repair.commit` | `NSO_Repair.js` | the optional seal. There is no new hole filler — §4 |
| `tools/nso_app_harness.js`, `tools/mesh_validate.py` | `tools/` | the drive checks and the canonical verdict |

## 2. Genuinely new

| what | where | why it could not be reused |
|---|---|---|
| a raw-space selector for a painted face | `nso_paint_delete.js` `select()` | `buildOverlay` is display-space, internal, and returns a count |
| edge-connected components over a raw soup | `nso_paint_delete.js` `_edgeMap` / `_componentsOf` | `NSO_Repair.analyze` counts components but does not say which triangle is in which |
| the delete itself and its gate | `nso_paint_delete.js` `commit()` | nothing in the app removes triangles by paint |
| the app wiring and the Delete row | `app-paint-delete.js`, `index.html` | new control |
| `deleteReplace` undo label | `app-core.js` | one row in `UNDO_REPLACE_LABEL` |

One **bug fix** came out of the audit and is included because this feature's own
Undo is what exposed it. `undoLast`'s geometry branch restored the paint lists
*first* and rebuilt the placed mesh afterwards, so `nsoMaskRestore`'s repaint ran
against the post-operation mesh, found none of the faces the restored lists
name, and built an empty overlay that nothing rebuilt. The lists came back and
the colour did not — which reads as "undo lost my paint". One `nsoMaskRepaint()`
after the instance is re-seated fixes it, for Skin and Carve and every other op
in that branch as well as for Delete.

---

## 3. The contract: what is pink is what goes

For a destructive tool the only defensible promise is that the geometry removed
is the geometry highlighted. That is not a comment here, it is measured: the
audit paints a face through a real click on a real canvas, reads the triangle
count of the app's **own** pink overlay out of the scene, and compares it with
what `NSO_PaintDelete.select` picks out of the same raw soup from the same
entry.

```
fixture                       aim    the pick named                pink  picked
box-20mm.stl                  Y+     outer Z+ @ 10.000                2       2
box-20mm.stl                  X+     outer X+ @ 10.000                2       2
box-20mm.stl                  Z+     outer Y- @ 10.000                2       2
out-box-square-half.stl       Y+     outer Z+ @ 10.000                3       3
out-box-square-half.stl       X+     outer X+ @ 10.000                2       2
out-box-square-half.stl       Z+     outer Y- @ 10.000                3       3
out-box-corners-r05.stl       Y+     outer Z+ @ 10.000                5       5
out-box-corners-r05.stl       X+     outer X+ @ 10.000                2       2
out-box-corners-r05.stl       Z+     outer Y- @ 10.000                5       5
out-box-round-r05.stl         Y+     outer Z+ @ 10.000                3       3
out-box-round-r05.stl         X+     outer X+ @ 10.000                2       2
out-box-round-r05.stl         Z+     outer Y- @ 10.000                3       3
box_hull_80x40x20-2.stl       Y+     outer Z+ @ 10.000                2       2
box_hull_80x40x20-2.stl       X+     outer X+ @ 40.000                2       2
box_hull_80x40x20-2.stl       Z+     outer Y- @ 20.000                2       2
box_open.stl                  Y+     inner Y- @ -38.000               2       2
box_open.stl                  X+     outer X+ @ 60.000                6       6
box_open.stl                  Z+     outer Y- @ 0.000                 6       6
```

18 faces, 6 fixtures, outer faces and a pocket wall, flat tops and rounded ones.
`pink == picked` on every one. The "aim" column is where the click was pointed;
what the pick then **named** is the next column, because a ray stops at the first
thing it meets exactly as a user's would.

The raw-space predicate is `buildOverlay`'s, clause for clause:

- an **outer** face is "this raw axis and side, all three corners on the piece's
  own *current* extreme". Current, not the value stored at paint time, because
  that is what the overlay does too — it reads the display bounding box every
  repaint, so a face a bake moved is still the face.
- a **pocket wall** is "this raw axis and side, all three corners on its own
  stored plane". That offset is what keeps a click inside a pocket off the hull
  face behind it.
- a face with **no axis to name** — a fillet, a curved end — falls back to the
  stored raw plane through the triangle's first corner, which is the single
  corner the overlay's own fallback tests.

`N_TOL` and `D_TOL` are asserted equal to `app-mask.js`'s by the unit suite, so
the two files cannot drift apart silently.

---

## 4. The operation

`NSO_PaintDelete.commit(rawTris, entries, options)` — standalone, no DOM, no
Three.js, same file in the page and under node, the same shape `NSO_Repair.js`
has. It returns `{ rawTris, report, ok }`, and on any refusal it returns the
**caller's own array, same reference**, so "unchanged" is checkable by identity
and not just by value.

Modes, all named by the caller and none inferred from the geometry:

| mode | UI | what goes | watertightness |
|---|---|---|---|
| `face` | **Face** | the painted face's triangles, and nothing else | opens along the rim. That is the operation |
| `face` + `seal` | **Face+seal** | the same, then `NSO_Repair.commit` closes the rim | must come back closed, or the whole delete is reverted |
| `shell` | **Shell** | every triangle of the edge-connected component(s) that face is in | must not get worse — it opened nothing |

**The seal is the shipped repair, not a new hole filler.** That is deliberate
twice over. It is code that is already regression-gated, and its own rule —
"hole fill will not close a seam the repair opened", `docs/NSO_Repair.md` — is
exactly right here: the rim *is* in its input, so it is a hole it may fill, and
anything the delete did not open it still will not bridge.

On success the target is consumed, because the plane it named is not a face of
the piece any more and leaving it set would aim the next click at geometry that
is gone. It comes back with the geometry on Undo, in one step.

---

## 5. The gate

Same shape as `NSO_Repair`'s: measure, work on a trial copy, measure again, and
refuse by handing the input straight back. Every clause below has a shipped
fixture that fires it, and the unit suite asserts each one refuses *and* that
the array came back by identity *and* that `after === before` with zero deltas.

| clause | what it means | fires on |
|---|---|---|
| `nothing` | the paint covers no geometry — a stale plane after a bake | `box-20mm` with a target at a plane the cube has no face on |
| `empty` | the delete would take every triangle | `box-20mm` with all six faces; `39644` in `shell` mode, because the whole file is one edge-connected component |
| `arithmetic` | this module's own prediction of the cut's odd-edge count disagrees with `NSO_Repair`'s independent measurement of the mesh produced | a bug in the selector, not a property of any mesh — and that is the point of having it |
| `shatter` | a `face` delete split the piece into more bodies than it started with | `39644` inner Z+ @ 6 (1 → 2 bodies); `box_open`'s top face, which is the only thing holding the pocket liner to the outer shell |
| `selfInt` | the result crosses itself more than the input did | `out-box-round-r05`, sealed — see below |
| `nonManifold` | an edge gained a third face | backstop, same shape as `selfInt` |
| `shellOpened` | a `shell` delete left more odd edges behind than it found | the selection was not the shell it was taken for — a backstop, same shape as `arithmetic` |
| `watertight` | the result is open and a closed solid was required. On by default whenever a seal was asked for; off otherwise, in both modes | `box-20mm` with `requireWatertight`; `out-box-round-r05` with **Face+seal** |

### Which clauses can fire on geometry, and which are backstops

Say it plainly rather than let a green suite imply more than it proves.
**Deleting triangles is topologically monotone**: it cannot make two surviving
triangles cross, and it cannot raise an edge's use count. So on the `face` and
`shell` paths the `selfInt` and `nonManifold` clauses cannot be tripped by any
input. They are asserted because the thing that would trip them is a bug in the
selector — a stale plane matching the wrong face, a mis-welded component — and
during development they caught exactly that.

**Sealing can trip them, and does.** Fanning `out-box-round-r05`'s 5-edge rim
shut puts one piercing pair into the mesh. Normally `NSO_Repair`'s own gate sees
it first and declines the fill (`hole-fill:selfInt 0->1`), the piece would come
back neither cut nor closed, and the `watertight` clause reverts the whole
delete. To show that this module's `selfInt` clause is a real backstop rather
than decoration riding on that one, the suite hands the seal
`sealOptions: { gate: false }`, lets the self-intersecting fill through, and
watches this gate refuse it anyway at `0 -> 1` and hand back the caller's array.

### What "breaks watertightness in an unintended way" means here

The rim a `face` delete opens is **intended**, and it is not taken on trust: the
odd-edge count of the survivors is computed from the edge map *before* anything
is removed, and the mesh that comes out has to measure exactly that. Everything
else is unintended:

- a `shell` delete opening anything at all,
- a seal that leaves the piece neither cut nor closed,
- a rim the shipped repair can only close by crossing the piece.

Note what is deliberately **not** on that list: a `shell` delete leaving the
piece open when it was already open. What a shell delete owes is that it opened
nothing — whole bodies share no edge with the bodies that stay, which is what
made them separate components — not that what is left is a closed solid.
Demanding the latter would refuse every shell delete on a piece that is open on
purpose (`docs/NON-SOLID.md`), and that is exactly where "get that loose sheet
off" comes up most. A caller who does want a closed result asks for one with
`requireWatertight`, and the suite checks that it still refuses when it should.

In all three the whole delete is handed back — the caller's own array, untouched.

---

## 6. Results on real cases

Every mesh below was written out and put through
`python3 tools/mesh_validate.py --gate`. `--non-solid` is passed where the piece
is *deliberately* open, which is what that flag is for (`docs/NON-SOLID.md`).

| case | mode | tris | open edges | self-int | volume | checker |
|---|---|---|---|---|---|---|
| `box-20mm`, top face | face | 12 → 10 | 0 → 4, one loop | 0 → 0 | — | PASS `--non-solid` |
| `box-20mm`, top face | face+seal | 12 → 12 | 0 → 0 | 0 → 0 | 8000 → 8000 | PASS, euler 2 |
| `box_open`, whole pocket (floor + 4 walls) | face | 68 → 58 | 0 → 4, one loop | 0 → 0 | — | — |
| `box_open`, whole pocket | face+seal | 68 → 60 | 0 → 0 | 0 → 0 | 13632 → **60000.000000** | PASS, euler 2 |
| `40921`, one of the two shells | shell | 186 → 96 | 0 → 0 | **5 → 0** | 9551.052 → 998.707 | PASS |
| `out-box-corners-r05`, top | face+seal | 86 → 86 | 0 → 0 | 0 → 0 | 3999.843664 → 3999.843664 | PASS |
| `out-box-round-r05`, top | face | 118 → 115 | 0 → 5 | 0 → 0 | — | PASS `--non-solid` |
| `open/thin_shell_cup`, one of two shells | shell | 1056 → 528 | 96 → 48 | — | — | PASS `--non-solid` |
| `open/fabric_weave`, three coplanar strands | shell | 1600 → 1120 | 840 → 588 | — | — | — |

Two of those are the headline results.

**`box_open` + Face+seal is exactly the solid block.** The fixture is a
60 × 40 × 25 box with a 56 × 36 × 23 pocket. Deleting the pocket's floor and four
walls takes 10 triangles and leaves the pocket mouth as the only opening; the
shipped repair fans that one loop shut; and the piece that comes out measures
**60000.000000 mm³** — 60 × 40 × 25 to the last digit. The pocket was not hidden,
it was removed.

A third is worth naming because it is where the shell rule earns its wording.
`open/thin_shell_cup` is **deliberately** open — 96 open edges, two shells. A
shell delete on it applies, takes 528 triangles, and leaves the survivor with
48: it opened nothing, and the canonical checker passes the result as an open
piece with `--non-solid`. `open/fabric_weave` shows the other half: a face with
no axis to name is stored as a bare plane, a bare plane can sit on more than one
body, and three of the weave's ten strands are coplanar with the one clicked. All
three go — and `componentsRemoved` says **three**, so the delete reports what it
took rather than quietly taking more than it said.

**`40921` + Shell removes a defect.** The file is two spheres meeting at 17
bowtie vertices, with 5 piercing triangle pairs. Deleting the shell one click
lands on takes 90 triangles, both counts to 0, and leaves a single watertight
sphere. Self-intersections went **down**, which is the only direction this gate
allows. The two shells are nothing like the same size — 9551.052 mm³ goes to
998.707 — so which one the click lands on matters, and that is exactly why the
operand is a face the user pointed at rather than a heuristic.

The app half is proven separately, every step a real click on the shipped UI:
`node tools/nso_paint_delete_drive_check.js` loads the fixtures through the file
input, paints with the mouse, presses the button, exports through the app's own
STL export, and puts *that* file through the canonical checker.

---

## 7. Paint scope

**PAINT SCOPE: SUB-REGION.** Stated here, in `nso_paint_delete.js`'s header and
in `app-paint-delete.js`'s header, and asserted by
`node tools/nso_paint_scope_test.js`.

The operand is one identifiable face, or the one shell that face belongs to, so
the exclude check is scoped to **that face only**, through `nsoMaskIsExcludedRaw`
with the raw plane the pick recorded. Concretely:

- the **target face** painted excluded → stands the delete down, status names the
  face and says paint wins. The piece is byte-for-byte unchanged and the target
  is not consumed.
- **any other face** painted excluded, including a different pocket wall or any
  hull face → does not stand it down. Every other face comes out with its plane
  unmoved, so "a painted face stays untouched by any bake" holds for them by
  construction.

This is the same rule as Smooth's whole-piece stand-down applied at a different
scope, **not** a laxer reading of it — see `docs/HANDOFF.md`, "Scoping".

In `shell` mode the shell that goes may carry faces other than the target. Paint
on those does **not** currently stand the delete down; only the target's own
paint does. That is a deliberate limit and it is listed in §8 rather than
quietly left to be discovered.

---

## 8. Known limits

**One face at a time.** The select list holds at most one entry, by design
(`app-mask.js`). "Paint a region" therefore means one face per press, and a
pocket is five presses. `shell` mode is the one-click answer where the region is
a whole body. Growing the select list to several faces is a mask6 change with
its own consequences for Skin face, and it belongs in its own ticket.

**`shell` mode does not check paint on the rest of the shell.** The exclude test
is scoped to the target face, per §7, but a shell delete removes faces the target
does not name. A face painted excluded elsewhere on that shell will go with it.
The honest fix is to test every face of the doomed component against the exclude
list before committing, and it was left out of this ticket rather than half-done:
it needs a decision about what "the faces of a component" means for a curved
shell, where there are no named faces at all.

**A degenerate triangle is never deleted by paint.** It has no normal, so no face
can claim it. `NSO_Repair` is what removes those, and the gate's degenerate
count is unmoved by the delete.

**The `face`-mode rim is left open unless a seal is asked for.** That is the
operation, not an omission, and the status line says the piece is now OPEN in
as many words. If it should be a closed solid, that is what **Face+seal** is —
and if the seal cannot be done safely, the delete is reverted rather than
leaving the piece in between.

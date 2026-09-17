# Check piece — the checker's findings, on the mesh

*Added 2026-09-17.*

The canonical checker has always reported numbers: "4 piercing pairs", "96
faces under 0.42 mm". Finding those four pairs on a 20,000-triangle part meant
reading face indices out of JSON and counting triangles by hand. This is the
same check, drawn where it happened.

One button, *Check piece*, in the Finish card under the Non-solid flag. It
runs the battery on the selected piece and paints what it found onto that
piece in the viewport.

| finding | how it is drawn | colour |
|---|---|---|
| open boundary edges | line along each edge | red `#ff2d2d` |
| non-manifold edges | line along each edge | orange `#ff8c1a` |
| piercing pairs | the triangles of both faces of every pair | red `#ff2d2d` |
| wall / gap under 0.42 mm | the measured face **and** the face its ray hit | violet `#c084fc` |
| inconsistent winding, degenerate triangles | counted, named in the status line, **not** painted | — |
| coplanar contact | counted, **not** painted | — |

Two deliberate omissions. A zero-area triangle has no area to colour, and an
inconsistently wound edge is already drawn by whichever of the two classes
above it belongs to; both are in the verdict, so the status line names them
and says they are not painted rather than letting a FAIL with nothing on the
screen read as a bug. Coplanar overlap is not painted because a boolean seam
produces legitimate coplanar contact (`docs/NSO_Repair.md`) — painting it
would light up every fused piece.

## It is the canonical checker, not a second one

```
tools/mesh_validate.py     canonical definition of every check     (python)
NSO_Repair.js              the browser copy of self-intersection,
                           the weld and the edge table             (browser)
nso-defects.js             those, plus WHERE, plus the browser
                           copy of the wall/gap raycast            (browser)
app-defects.js             the button, the colours, the lifetime   (browser)
```

`nso-defects.js` adds exactly one thing to what already existed: coordinates.
The pairs it paints are the pairs `NSO_Repair`'s own `testPair` counted —
`countSelfIntersectionsDetail` gained an off-by-default `{ collect: true }`
that records them and changes no count. The edges come from the same
`buildEdges` table `analyze()` counts.

The one genuinely new piece of code is the **wall/gap raycast**, because
there was no browser copy to reuse; `docs/NON-SOLID.md` §6 said so. It is a
line-for-line transcription of `wall_thickness()` in `tools/mesh_validate.py`:
a ray from every triangle centroid along the inward normal, a uniform hash
walked cell by cell with a 3D DDA, the source triangle and anything sharing a
welded vertex with it skipped, and one weld radius of slack so a rib built at
the threshold passes.

**The equivalence, stated exactly.** `NSO_Defects.locate(raw, { minWall: 0.42,
nonSolid: f })` is `python3 tools/mesh_validate.py <file> --min-wall 0.42
[--non-solid]`. `tools/nso_defect_overlay_test.js` holds it there on every STL
in `fixtures/` and `library/` — 67 files — comparing every count, every wall
figure, the wall examples face for face, the piercing pairs pair for pair, and
the verdict under both settings of the flag.

### Two numbers that are the validator's, not `NSO_Repair.analyze()`'s

Both differences predate this work; consolidating them was not in scope, and
`locate()` is the validator's battery, so it takes the validator's definitions
and the test pins both sides.

| | `NSO_Repair.analyze()` | `mesh_validate.py` and `locate()` |
|---|---|---|
| degenerate | the **welded** mesh — the one the repair stages operate on | the **raw** soup — what is in the file |
| winding | **undirected** edges used twice the same way; an edge used more than twice is counted as non-manifold instead | **directed** edges used more than once, which also fires along a non-manifold run |

On `fixtures/tape_…FINAL.stl` the weld collapses 297 slivers to exactly zero
area: `analyze()` reads 297 degenerate, the validator reads 0. On
`synth_dup_exact.stl` the winding figures are 0 and 3. Section 2 of the test
asserts those four numbers, so a future change to either side is a test
failure rather than a silent shift.

## On demand, and a snapshot

The check is **not** live. A BVH self-traversal over every triangle plus a ray
from every centroid is ~1.5 s on the tape fixture, which is not something to
hang off a mousemove. So:

- it runs when the button is pressed, on the selected piece;
- pressing again clears it; running it on another piece replaces it (one check
  on screen at a time);
- **a bake clears it.** The marks are children of `p.mesh`, every bake swaps
  `p.mesh`, and `nsoDefectsRefresh` — called from `renderModelList` and
  `updateAdjustUI` in `app-core.js`, beside `nsoPosLockRefresh` — notices the
  swap, drops the record and says so on the HUD. Yesterday's holes are never
  drawn on today's geometry;
- **a move keeps it.** Drag, nudge, rotate, Raise/Lower and Seat all move the
  mesh, and the marks are its children, so the defects travel with the
  geometry they are on.

`nsoDefectsReport()` returns the last report, or null. Nothing re-runs the
check to answer a question.

## The drawing, and why it differs from the paint

The layers reuse the shapes the app already has — `THREE.LineSegments` and a
`THREE.Mesh` of selected triangles, parented to `p.mesh`, unlit
`MeshBasicMaterial`, `renderOrder` above every helper, `raycast` stubbed so a
mark can never take a click off the piece under it (`app-poslock.js`'s lock
outline and `app-mask.js`'s paint).

One thing is different on purpose. The paint keeps `depthTest` **on** so a
painted face on the far side stays behind the solid, because the paint answers
*which face did I click* and a click only lands on a face you can see. Defect
marks answer *where is the problem*, and a piercing pair is usually **inside**
the piece. So every layer here has `depthTest: false` and shows through — the
same call the lock outline and the plate's fence lines already make. The patch
layers are `DoubleSide` for the same reason: a thin wall's inner face points
away from you by definition.

Colours: nothing else on the plate uses red or orange. Violet is
deliberately the **same** violet as the non-solid tag and flag accent
(`#c084fc`), because the wall/gap check is that flag's own positive check
(`docs/NON-SOLID.md` §4). Piece sky blue, selection rose, paint yellow, target
pink, lock teal, armed cyan are all untouched.

## NON-SOLID SCOPE

`app-defects.js` reads `nsoNonSolid(m)` and passes it to `locate()` as
`opts.nonSolid`. It never derives intent from an edge count.

The flag changes the **verdict** and nothing else. A piece flagged non-solid
still has its open edges measured and still has them drawn in red — you still
want to see where the piece is open — they just stop being a failure, and the
status line says so. Everything else (non-manifold, winding, degenerate,
piercing, wall/gap) applies either way. `docs/NON-SOLID.md` §3.

The wall/gap check runs at 0.42 mm whether or not the flag is set, which is
`--min-wall 0.42` rather than `--non-solid`'s default. That is the one place
the overlay is deliberately more forthcoming than the validator's default
invocation: the overlay is a viewer, it refuses nothing, and a thin wall is
worth seeing on a closed part too. It is still not an app gate — nothing in
the browser refuses a piece over any of this.

## Validation

Two checks, both in `npm test`.

**`tools/nso_defect_overlay_test.js`** (`npm run defects:test`) — 767
assertions. Section 1 is the cross-language equivalence above. Sections 3–6
are the part that matters for an overlay, and they are written against the
exact coordinates the fixture generators put the defects at, because *renders
something* is not *works*:

| fixture | the known defect | what is asserted |
|---|---|---|
| `open_clip` | a sheet, open all round | every red endpoint is on the (u, v) boundary — \|y\| = 10 or z = 12 |
| `thin_shell_cup` | two open rims at the top | every red endpoint is on the plane z = 25, none at the closed bottom |
| `synth_hole` | cube20 with triangle (A, D, C) deleted | the three red segments **are** that triangle's three edges, as an exact set |
| `synth_flap` | a triangle hung off cube edge F–G | the one orange segment **is** F–G; the two red segments **are** the flap's free sides |
| `open_clip_selfint` | a fin through the floor at x 1.3–3.3, y 0.7 | every red triangle is in that corner, nothing at the far end of the clip |
| `thin_shell_cup_selfint` | a fin at 3.75°, r 12–18, z 10–14 | every red triangle is on that side of the cup, in the two rings the fin crosses |
| `fabric_weave_selfint` | one weft of ten strands woven through the warps | every red triangle is on that weft (y 5.2–6.8); none on the other nine |
| `thin_shell_cup_thin` | the inner wall dented to 0.25 mm, band 90°–150°, z 5.96–20.24 | every violet vertex is inside that band and those rings; both sides of the wall are painted (inner r = 14.75 **and** outer r = 15) |
| `thin_shell_cup` | a healthy 1.2 mm wall | **nothing** violet at a 0.42 mm floor — and the same cup **does** light up at a 2 mm floor, so the check can fire |
| `box-20mm` | nothing wrong with it | zero mark vertices of any colour |

**`tools/nso_defect_overlay_drive_check.js`** (`npm run defects:drive`) — the
same defects through the real app in Chromium, every step a click on the
shipped UI. It pins the half that only exists in a browser: each mark vertex
is read out of the three.js scene in **world** space and held against the
piece's own displayed triangles, also in world space. A wrong sign in the
raw→display rotation, or a missed centring translation, puts a mark
millimetres off the surface while still rendering perfectly; the measured
worst gap is **0.000000 mm** on every layer of every piece. It also drives the
toggle, the move-keeps-it / bake-clears-it lifetime, the flag, and that a ray
through a painted region still hits the piece and never a mark.

One thing that drive check has to get right, and got wrong once: **what it
waits on after pressing the button.** The press defers the battery by a task so
the "Checking…" line paints first, and `nsoDefectsReport()` is not per piece —
it is whatever check is currently drawn, which after the first case is the
*previous* piece's, because the overlay deliberately survives a selection
change. "Wait until the report is non-null" is therefore already true before
the press has computed anything, and a fast enough box reads the last piece's
numbers off a piece with no marks on it: on 2026-09-17 CI reported
`open_clip_selfint` as "0 piercing, 96 open" with an empty red patch layer —
the cup's report, one case earlier. The wait is on `nsoDefectsShownFor() === id`
instead, which turns over inside `nsoDefectsShow` only after the report is
stored and the marks are parented. To stress it on a slow box, widen the
button's `setTimeout(…, 0)` in `app-defects.js` to 400 ms and run
`npm run defects:drive`: it must still pass.

## Not done, on purpose

- No live re-check. See "On demand" above.
- Winding and degenerate triangles are counted, not painted.
- The overlay refuses nothing. It is a viewer; `Seal ▸ Repair` is what acts.
- The report is in memory only, like the paint and the two flags. It is not
  written to the STL or the 3MF and does not survive a round trip.
- One piece at a time. The battery is per piece and so is the button; a
  whole-plate check would be a different feature with a different cost.

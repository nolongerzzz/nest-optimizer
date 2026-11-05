# Findings — what Check found, where it is, and the button that fixes it

*Added 2026-10-13.*

*Check piece* (`docs/DEFECT-OVERLAY.md`) runs the canonical checker and paints
what it finds onto the piece as 1 px lines and patches. On a 2,000-triangle
sphere, seven open edges are seven pixels. The check found them and you
still can't. Findings is the layer on top. It changes nothing about how the
check measures or what colour it paints. It adds three things:

1. **A card.** Pressing Check opens it, docked at the right edge of the
   viewport under the top-right buttons, and it stays open until closed. It
   has one row per kind of problem, each with its numbers and one sentence on
   what it means for a print:

   | row | title, from the report | the buttons (one per finding on the row) |
   |---|---|---|
   | holes (open edges) | `2 holes, 221 open edges` | **CAP**, **PATCH** or **BRIDGE** per hole or pair of holes; **REPAIR** for open edges that are no clean loop |
   | doubled or pinched (non-manifold) | `5 places, 132 doubled or pinched edges` | **REPAIR** — Seal with Repair, whole piece: ticks `#chk-seal-repair`, clicks `#btn-seal`, puts the tick back |
   | piercing | `1 place, 7 piercing pairs - pieces passing through each other` | none. Says no tool in the app removes it yet |
  | overlapping shells (piercing pairs between whole shells) | `2 overlapping shells, 74 piercing pairs - shells passing through each other` | **MERGE SHELLS** — the shells unioned into one solid on the piece itself, whole piece (docs/WORK-AS-IS.md); **SPLIT SHELLS** beside it — each shell becomes a piece of its own, in place, the very split Split to parts makes (docs/SHELLS-AS-PIECES.md). One item line each, one Undo each; Fix all never runs SPLIT SHELLS. After it the card follows the first piece and says, per piece, that the finding is gone |
   | thin walls | `1 place, 96 faces under 0.42 mm (thinnest 0.249 mm)` | **THICKEN OUT +0.56 mm** — types the mm that reaches two nozzle widths into `#inp-thicken-mm`, clicks `#btn-thicken-out`, puts the box back |
   | gap between faces (advisory) | `1 gap between faces that look at each other` | **BRIDGE** |
   | clean | `Nothing wrong found`, green, shown exactly when the verdict is PASS and there is no gap | — |

   **Since 2026-10-16 each row holds ITEMS, and every item has the fix that
   fits it** (`docs/PATCH.md`): a flat rim is `Hole, flat rim — CAP`, a curved
   one `Hole, curved rim — PATCH`, two openings facing each other `Gap 1.2 mm
   between two edges — BRIDGE`, a severed tube `Gap 1.0 mm between two faces —
   BRIDGE`. The button runs that fix on that finding only, the card re-scans,
   and the item's line goes green with its before → after (or amber with the
   tool's own reason). **Fix all (n)** runs every item's own fix in the card's
   order, never the advisory gap. Each fix is one Undo. The row titles and
   counts are as they were.

   Winding and degenerate triangles have no place on the mesh to point at, so
   they get no row. When the report counts them, the card names them in one
   line under the rows. A FAIL never sits under an empty list.

   Clicking a row flies the camera to the nearest problem of that kind (the
   nearest to the camera) and pulses its ring.

2. **A ring and a number on every problem.** `nso-findings.js` sorts the
   report's marks into problems (below) and each one gets a ring sized to it,
   plus a number, biggest problem first. Rings use the marks' own colours.
   Like the marks, they are drawn through the piece (`depthTest` off) and can
   never be picked. The 1 px lines stay. The ring is what makes them findable.
   Pressing Check frames the camera on the piece and every ring on it.

3. **Always re-scan.** After any fix from the card, and after Cap, Seal or
   Solidify from the Finish menu, the check re-runs by itself. The rows
   update. Problems that are gone flash green and fade. The card says
   `Cap open faces: Before: 3 open edges. Now: 0.` and keeps it until the next
   action. If the action changed nothing, the card says so, with the tool's
   own reason: `Cap open faces changed nothing on the piece. It said: No open
   face to cap`. If a fix makes another kind of problem worse, that count is
   listed too. On `thin_shell_cup_cracked`, Cap reads `Before: 100 open edges.
   Now: 104. Before: 7 piercing pairs. Now: 14.`

## A problem is a place, not a mark

`NSO_Findings.group(report)` reads `report.marks` and nothing else, and every
marked edge or triangle lands in exactly one problem:

- **Edges** (open, non-manifold) belong to one problem when an endpoint of
  one is within 0.05 mm of an endpoint of the other. The marks are welded
  vertices, so a boundary loop is one hole however it winds, and two loops a
  hair apart count as one. It uses endpoints, not boxes. On a 1.2 mm cup wall
  the boxes of the inner and outer rims overlap, but the rims don't touch,
  and they are two holes.
- **Triangles**: a piercing pair's two faces cross, so their boxes overlap
  with no slack. A thin face and the face its ray hit are at most one wall
  apart, so thin faces are grown by the wall threshold (0.42 mm).

A hole is a boundary loop, with one exception. Where two loops share a pinch
vertex, the checker's loop walk counts two cycles and the card counts one
hole, because that is one hole to look at. `tools/nso_findings_test.js` pins
every fixture's count:

| fixture | the generator made | the card finds |
|---|---|---|
| `shape-sphere_nm-duplicate-flipped` | 5 duplicated patches | 5 places, 132 edges |
| `shape-torus_weld-shredded` | 32 weld collisions | 32 places, 64 edges |
| `fabric_weave` | 10 separate ribbons | 10 openings, 840 edges |
| `fabric_weave_selfint` | one weft through 5 warps | 5 piercing places, 5 thin places |
| `thin_shell_cup` | two rims, 1.2 mm apart | 2 holes |
| `shape-sphere_holes-shredded` | 12 sites grown into 2 loops (4 cycles at 2 pinch vertices) | 2 holes, 221 edges |
| `shape-cylinder_holes-light` | 2 loops, one pinched at the cap centre (3 cycles) | 2 holes, 16 edges |

## REPAIR and THICKEN OUT are the Finish menu's buttons

REPAIR and THICKEN OUT do not call a copy of the repair. They click the
existing control, so what runs is the same handler with the same Undo entry and
the same status line. `tools/nso_findings_drive_check.js` holds REPAIR bit for
bit: the card's Seal with Repair and the Finish menu's ticked Seal give the
same bytes, and one Undo after either puts back the original bytes.

CAP, PATCH and BRIDGE are `nsoRepairRun` in `app-patch.js`, one commit path with
one Undo of its own type; the card brackets each with the same before / after
the document listeners take for the Finish buttons. (The card's CAP is not the
Finish menu's Cap open faces, which is unchanged: `docs/PATCH.md`, "Cap is not
the Finish menu's Cap".)

The re-scan of a Finish button (Cap open faces, Seal, Solidify, Thicken out) is
wired at the document, around the button's own listener. A
capture-phase listener takes the "before" reading before the handler runs. If
the card is already showing this piece's check, it reuses it. If not, it runs
a scan that draws nothing (`nsoDefectsScan`). A bubble-phase listener takes
the "after" reading once the handler returns. Cap, Seal and Solidify are
synchronous, so both readings bracket exactly one action. The re-scan pushes
no Undo entry, and it does not overwrite the action's own status line.

## Stale and non-solid

- **Stale.** When the piece changes under the marks (Undo, or any bake that
  swaps the mesh), the marks and rings are dropped, and the card says *The
  piece changed. Check again*, with a Check again button. This is the
  existing rule in `app-defects.js`. The card also checks twice a second while
  it is up, because Seal and Solidify swap the mesh without rebuilding the
  model list, which is what normally triggers the rule.
- **Non-solid** (`docs/NON-SOLID.md` §3). The card reads `report.nonSolid`,
  which app-defects set from `nsoNonSolid(m)`. It never reads an edge count to
  decide intent. On a flagged piece the open-edge row is **declared**: slate,
  `1 opening, 50 open edges - declared`, with no Cap button, because Cap does
  not read the flag and would close what the user said to leave open. Its
  rings are slate too. The green row still shows when everything else
  passes. The 1 px red lines are unchanged.

## Where things are drawn

Rings and numbers are not children of the piece's mesh. The marks are, and
they can be, because they lie on the surface. A ring is bigger than what it
circles, and `Box3.setFromObject` walks children, so a ring on the piece
would make the piece measure bigger (`app-seat-grid.js` has the story of a
0.1375 mm Seat gate). Instead they sit in `state.scene` and copy the piece's
world transform every frame in `onBeforeRender`, facing the camera. The
drive check asserts that the piece measures the same with the rings up.

The card sits at `z-index` 70: below the top bar (80) and the Finish overlay
(90), so an open drop-down always covers the card rather than the other way
round. Its top is measured from the Finish button's bottom edge, not
hard-coded. When Finish's panel is open over the right edge, the card moves
to the panel's left. That is also measured. Its height leaves the bottom-right
HUD clear.

## Files

```
nso-findings.js      pure: marks -> problems, rows, before/after wording   (node-testable)
app-findings.js      the card, the rings, the camera, the re-scan wiring
app-defects.js       + nsoDefectsScan, quiet/scan options on nsoDefectsShow,
                       three optional hooks; measuring and colours unchanged
tools/nso_findings_test.js         npm run findings:test
tools/nso_findings_drive_check.js  npm run findings:drive
```

## Not done, on purpose

- Piercing has no button yet. (Open loops, gaps between faces and thin walls
  do now: `docs/PATCH.md`.)
- A row click goes to the problem nearest the camera, so clicking the same
  row twice stays on the same problem. Stepping to the next one would be a
  new control.
- One check at a time, as before.

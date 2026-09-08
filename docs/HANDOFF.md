# Handoff (Claude Code reads this. User does not paste code.)

Branch: `claude-wip` only. Never push `main`. Never merge PR #4.
After every pass: comment counts on PR #4.

## Output protocol
1. Findings, numbers, diffs and next-step proposals go ONLY as comments on PR #4.
2. Chat carries exactly one line: `Task complete: See PR` or `I need your attention`.
3. No code, tables, dumps or explanation in chat.
4. Never apply `stash@{0}` or any parked patch unless a PR comment from Grok, or
   this file, says **APPLY**.

## Standing ticket — Soften Corners open edges — CLOSED, verified

Fixed in `caf9b0c`. `rawEdgeRoundInPlace`'s wall-rewrite block now splits a wall
triangle's cap-plane edge at every loop vertex along it (`capEdgeChain`), pulls
each resulting vertex by its own local R, and fans from the off-cap apex.
`(A, B, C)` is a rotation of the original winding, so orientation is preserved.

Verified at `7b47856`, `--odd --degen`:

| file | tris | open | NM | degen |
| --- | --- | --- | --- | --- |
| `fixtures/box-20mm.stl` | 12 | 0 | 0 | 0 |
| `fixtures/out-box-corners-r05.stl` | 78 -> 86 | 24 -> 0 | 0 | 0 |
| `fixtures/out-box-round-r05.stl` | 118 | 0 | 0 | 0 |
| `fixtures/out-box-bevel-r05.stl` | 38 | 0 | 0 | 0 |
| live export `soften_test_01_cubeB112.stl` | 86 | 0 | 0 | 0 |

Lid on the cut plane in all modes. Corners pulls 0.5 at the four corners and 0
at every wall midpoint; Round and Bevel pull 0.5 everywhere. Round and Bevel
came out as the same triangle set as before the patch, winding preserved.

Invariants still held, re-checked each pass:
- cap-face write is `from3(p0, capPlane), from3(p1, capPlane), from3(capApex, capPlane)`
- 0 occurrences of `marginPlane` / `rawClipTrianglesAtPlane` / `Rmax` in the engine
- Square cut, Join, Seat, Subtract, Extract, Thicken, Solidify, pack, UI untouched

## Open, not authorised — need an explicit APPLY

1. **`rawCheckWatertightQuick` tolerance.** It passes a mesh with up to 208 odd
   edges, so the in-app gate reported "Soften ok" on the old 24-open-edge result.
   Validation gap, not geometry. Needs its own pass.
2. **`stash@{0}` — cap/wall boundary-pairing fix.** Parked, unapplied. On some
   real cut faces the cap boundary pairs against the wall on only part of its
   edges (a wall triangle with a single vertex on the cap contributes no
   cap-plane edge), so the loop walk dies with a false `branch point in cap
   boundary` and all three treatments refuse to run on a sound mesh. Reproduced
   on an earlier uploaded piece. Not applied — awaiting APPLY.

## User role
Steer + live click test only. No file upload. No snippet paste.

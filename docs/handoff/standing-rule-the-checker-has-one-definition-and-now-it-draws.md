## Standing rule — the checker has one definition, and now it draws (added 2026-09-17)
`tools/mesh_validate.py` is still the canonical definition of every check.
What changed is that the browser can now show you WHERE: the *Check piece*
button (`app-defects.js`) runs the battery on the selected piece and paints the
findings on the mesh — red on open edges and piercing pairs, orange on
non-manifold edges, violet on faces under the 0.42 mm wall/gap floor. Full
write-up: `docs/DEFECT-OVERLAY.md`.

The rule this sets for anything that comes after it: **do not write a fourth
checker.** `nso-defects.js` adds coordinates to the checks that already exist
and nothing else — the piercing pairs are the pairs `NSO_Repair`'s own
`testPair` counted (an off-by-default `{ collect: true }` that changes no
count), the edges come from the same `buildEdges` table `analyze()` counts. The
one piece of new code is the wall/gap raycast, because there was no browser
copy of it, and it is transcribed line for line and pinned:
`node tools/nso_defect_overlay_test.js` holds `locate()` to
`mesh_validate.py --min-wall 0.42 [--non-solid]` on every STL in the repo, and
`node tools/nso_defect_overlay_drive_check.js` drives the button in Chromium
and measures each painted vertex against the displayed mesh in world space
(worst gap 0.000000 mm). Both are in `npm test`.

Two numbers in `locate()` are the validator's rather than
`NSO_Repair.analyze()`'s — degenerate (raw soup, not welded) and winding
(directed reuse, not undirected). Both differences predate this work and are
pinned from both ends in section 2 of the test, so neither can drift quietly.

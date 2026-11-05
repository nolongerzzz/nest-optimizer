## G-scope supports - overhang markers, point-click generation, per-support edit (2026-09-25)
Branch `claude/overhang-point-support`, off `claude-wip` after PR #99. Full
write-up: **`docs/GCODE-SUPPORTS.md`**.

- **Markers** are auto-aim's own `detectOverhangs` regions: the region's own
  triangles tinted, and a ping at `region.point`. Red means unsupported, green
  means a support made for it still touches it where it is now.
- **Click a marker** to choose Straight strut / Tree / Gecko-hand and a size.
  Generate calls `NSO_SupportAim.plan` or `NSO_SupportTree.planTree` +
  `unionParts` with the marker's own inputs. No new geometry code.
- **Each support is its own plate piece**, placed exactly: the placement is
  read back off the scene and compared value for value. It is one `addModels`
  step.
- **Click a support** to select it through G-scope's seam. Apply (regenerate)
  or Remove is one step each, under the new `supportSwap` undo type in
  `app-core.js`, which restores both the model and its exact pose.
- **Paint scope:** detection is sub-region (`skipList`, shifted into the world
  frame, and refused by name on a piece that is painted and turned); editing a
  support is whole-piece, on the support.
- **Checks:** `gcode:gscope-support` (52). Markers are checked against the
  direct detection call; generated supports against the direct generator calls,
  value for value; strut, tree and gecko-hand through the canonical checker at
  the tree check's derived weld; Undo on add, change and remove. Plus
  `paint:scope` (new roster row). Ported onto `claude-wip` as
  `claude/overhang-point-support-port`; `?v=` tags at `scope8` / `gsup2`
  (`scope8` since PR #109: the #108 merge had loaded `app-microscope.js`
  twice - check for exactly one tag after any conflict in `index.html`).

### Driver round 3 (G-scope x Mirror) - three fixes (2026-09-25)
1. **Tree union regression (round sections).** Since the round-section /
   hollow-bore / contact-interface merges, branches are 24-gon frusta, and
   near the tips two of them cross at grazing angles. manifold returns the
   intersection as float32, which (a) collapses distinct intersection
   vertices onto one - triangles with a repeated corner, read by exact
   census as 2 degenerate + 2 non-manifold + 1 mis-wound edge on the shelf
   tree - and (b) leaves runs of vertices 1e-6 .. 6e-5 mm apart along the
   curve, which the canonical checker's default weld (1e-4, first-
   representative, not transitive) splits into open edges. The square
   section on the same plan is clean; the tree suites passed because none of
   their fixtures cross round branches that closely. Fix, in
   `nso_support_tree.js` `unionParts`, on the finished fold only
   (`_finishUnion`, exported for `tree:test`): drop the repeated-corner
   triangles, then collapse every edge shorter than 1e-4 mm onto one end
   (link condition, no flipped triangle), each step gated on the exact census
   and the signed volume (|dV| <= 1e-6 V). A weld at 1e-4 was tried first and
   is wrong: it also merges non-adjacent vertices across the crossing and
   reports non-manifold edges. Volume unchanged; gecko-hand 11050 -> 10918
   tris, PASS at the derived weld with Euler 2, and 0 open / 0 degenerate at
   the default weld.
2. **Stale green.** A marker was green whenever a support with that region
   id existed - mirror, move or turn the host and it stayed green over a
   region the support no longer touches. Now `placeSupport` records the
   support's contact vertices on the region (`meta.contacts`), and a region
   is green only if a labelled support's contacts ALL still touch its
   flagged triangles where they are now (signed distance -max(1, side) ..
   +0.02 mm along the face normal, within 0.02 mm laterally). Otherwise it is
   red, and the marker, popover and panel name the stale support.
   `gcode:gscope-support` section 6: host nudged / mirrored / yawed, support
   moved alone, each red then green on Undo. A support saved without
   `contacts` reads red.
3. **Resting height on Undo.** Ingest drops a piece at `+0.3`; every pose or
   move re-seats it on the `0.2` baseline. Undo re-derived y, so a piece came
   back 0.1 mm lower than it was. `posePlaced` / `movePlaced` entries now
   carry `meshY` and Undo restores it exactly (`restoreMeshY`). The 0.3 / 0.2
   split itself is left alone (about 20 sites); logged here.

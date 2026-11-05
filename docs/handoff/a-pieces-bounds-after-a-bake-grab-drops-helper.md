## A piece's bounds after a bake; grab-drop's helper (2026-10-17)
Branch `claude/pose-bounds-after-bake`, off `claude-wip`. Files: `nso-bounds.js`
(new), `app-core.js`, `app-finish.js`, `app-grab-drop.js`, `index.html`;
checks `pose:bounds` (new), `watch:test` section H.
- **The report** (a drop-onto-piece bakes a turn, then To plate says "Already on
  the plate", Vertical reads 0.00, Tip on face lands short, the piece is in the
  air) **was not a stale cache.** `meshLocalBox3` applied the pose matrix to
  the eight corners of the geometry's bounding box. That is the piece's world
  box only while the corners are vertices; a baked geometry's bounding box is
  the tight box of the TURNED soup, so under the piece's own pose its corners
  swing out past the vertices and the "lowest point" sits 1 - 4 mm below the
  lowest vertex. To plate, `liftY` (what Vertical reads) and Tip on face all
  read that number. The same assumption put the piece in the wrong place to
  begin with: `applyMeshRotation` and both exporters placed it by half the
  recorded height, which is right only for a posed box centred on its origin
  (a seat on a posed piece measured 1.2 - 3.8 mm of clearance for the 0.18 asked).
- **The fix:** `nsoBounds.worldBox(mesh)` measures the VERTICES through the
  matrix (the bounding box only where the matrix sends axes to axes), cached
  per geometry on the position attribute + version + the matrix's 3 x 3 (a
  translation never invalidates it, so a drag is a lookup).
  `meshLocalBox3` delegates to it. `nsoBelowOrigin(mesh)` (app-core.js) is how
  far the lowest point is below the mesh origin; `applyMeshRotation`, the
  undo-restore of a removed piece and both exporters read it instead of
  `height / 2`.
- **One invalidation:** `nsoInvalidatePieceBounds(placed | model | mesh |
  geometry)` forgets the measurement, makes the geometry re-measure its box and
  sphere, and re-reads the placed entry's width / depth / height off the posed
  box. Both endings of every geometry rewrite go through it:
  `nsoReseatPlacedPose` (the pose-keeping bakes: Lift, Cut, Scale, Soften,
  Seal, Mirror, Seat here and the drop, their Undos) and `nsoClearPlacedPose`
  (the pose-consuming ones: Join, Subtract, Connect weld); the prevPose branch
  of the replace-Undo calls it too. A new geometry object is a new cache key
  anyway; the call is for an edit in place and for the sizes.
- **Everything that placed a piece by half its height now reads the same
  figure:** `nsoPoseBelow(p)` (app-core.js, the pose's rotation applied to the
  entry's geometry) for the exporters and for the scene's `basis`
  (`NSO3MFScene.poseBasis` takes an optional `below`, falling back to
  `height / 2` for a file or a caller that has none; the reader inverts the
  stored basis, so old files read as before); `nsoBelowOrigin(mesh)` for
  `app-rotate-handles.js`' `seatedY` and the Seat (flush) `baseY` in
  `app-join.js`. `3mf:scene` gained a pyramid whose posed box is not centred.
- **"y = 0":** the scene's baseline is 0.2 (`BED`, unchanged); the lowest vertex
  lands on it, and the exported file's lowest point is 0 above the plate.
  `pose:bounds` pins both.
- **Behaviour change to know about:** every posed non-box piece (a tipped
  cylinder, a tilted L) now rests on its true lowest vertex; before, the
  corners of its box decided and it floated a little. Footprints for the fence
  lines and the neighbour magnet are exact too.
- **Grab-drop's helper:** `clearLayer()` now takes the group out of the scene
  as well as emptying it (the empty group stayed up after every drop and Watch
  named it a phantom). It was already `nsoHelpers.owner('grab-drop')` /
  `attach`ed; it now leaves on a drop (all three), Escape and leave-tool.
  `watch:test` section H drives each, plus a negative control.
- **Tags:** `app-core.js` leashb7 -> bounds1, `app-finish.js` helpers1 ->
  bounds1, `app-join.js` helpmrg1 -> bounds1, `app-rotate-handles.js` helpmrg1
  -> bounds1, `app-grab-drop.js` grabdrop1 -> grabdrop2, `nso-bounds.js` new at
  bounds1, `nso-3mf-scene.js` scene2 -> scene3.

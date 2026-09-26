# G-scope supports: overhang markers, point-click generation, one support at a time

`app-gscope-support.js`, loaded right after `app-microscope.js`. This is the
support-generation phase that G-scope's selection seam was built for
(`docs/GCODE-MICROSCOPE.md`, "The selection seam"). Goal: show where support is
actually needed, let the user click to generate exactly there, and let them
change or remove any one support afterwards. Nothing is painted and nothing is
generated wholesale.

```
npm run gcode:gscope-support    tools/gcode-test/gscope-support-drive-check.mjs, 52 checks, headless Chromium
```

## 1. Audit: what auto-aim's detection already reports

`NSO_SupportAim.detectOverhangs(rawTris, opts)` (`nso_support_aim.js`) is the
detection that both generators already use: `plan()` runs it for a straight
strut, and `NSO_SupportTree.planTree()` runs it for a tree or gecko-hand. It
returns `{ ok, regions, angleDeg, plateZ, trisTotal, trisDownward,
trisFlagged, trisSelfSupported, trisPainted, trisBelowMinArea, trisOnPlate }`,
and each region carries:

| field | what it is |
| --- | --- |
| `id` | rank by area, largest first. `plan` and `planTree` take it as `regionId` |
| `tris`, `triCount` | the flagged triangles themselves (indices into the soup) |
| `areaMm2` | area |
| `point` | **the aim point**: the area-weighted centroid pulled back onto the surface. Every support is aimed at it |
| `centroid` | the raw centroid (may be in the air under a curved region) |
| `normal` | area-weighted outward normal |
| `steepestNz` | the most downward normal z in the region. Steepness: 0° off flat is `-1` |
| `min`, `max`, `spanMm` | extent, and the footprint span the tree uses to lay contacts |
| `dropMm`, `lowest` | height of the aim point above the plate, and the lowest vertex |

A triangle is flagged when it faces down more steeply than the printable angle
(`n.z < -cos(angleDeg)`, 45° by default) **and** a ray cast straight down from
its centroid hits nothing before the plate. Flagged triangles are grouped by
shared vertices, and regions under `minAreaMm2` (1 mm²) are dropped. Painted
faces (`opts.skipList`, required) and other pieces' material underneath
(`opts.occluders`) are respected.

So the markers are built straight from this output. There is no second angle
test and no second ray cast.

## 2. Markers

**Supports → Show overhangs** runs `detectOverhangs` on every plate piece that
is not itself a support. One marker is drawn per region:

- **The region itself:** its own flagged triangles, as a tinted surface lifted
  0.02 mm off the face.
- **A ping:** a sphere at `region.point` with a ring in the plane of the face.
  It is drawn on top of everything, so it can be seen and clicked through the
  piece.

A marker is **red** while nothing holds that region up, and **green** while a
support made for it still stands under it: every vertex of the support that
touched the region when it was placed (`nsoSupport.contacts`) still touches
the region's flagged triangles where they are now. A label alone is not
enough - move, turn or mirror the host (or the support) and the marker goes
red and names the support that no longer touches it. The angle can be changed in the section's own
field, which is `angleDeg`.

The markers are a layer of their own in the scene. They are not paint and
write nothing to the piece.

**Frame.** Detection runs on each piece's world soup, in Z-up millimetres, the
way G-scope's plate document already holds it. That is the print orientation,
so a piece that has been tipped gets markers for where it overhangs now.
`occluders` are the other non-support pieces, so a piece standing over another
is not flagged where the other holds it up.

## 3. Point-click generation

Click a marker to open the popover:

- **Style:** Straight strut, Tree or Gecko-hand.
- **Size:** the strut side in mm, which is the cross-section of the strut, the
  trunk and the branches. The generator raises it to the nozzle's wall floor
  if you ask for less.

**Generate** calls the existing generator for that region. It passes the same
soup and the same options the marker's detection ran with, plus `regionId` and
`sideMm`:

| style | call |
| --- | --- |
| straight strut | `NSO_SupportAim.plan(soup, opts)` |
| tree | `NSO_SupportTree.planTree(soup, { ...opts, branchStyle: 'square' })`, then `unionParts` |
| gecko-hand | the same, with `branchStyle: 'gecko-hand'` |

No geometry is built in `app-gscope-support.js`. A refusal is the generator's
own, by name (for example "trunksNeeded"), and nothing is added to the plate.

**Where the support goes.** Each support is its own plate piece. It comes in
through the ordinary ingest (`addModelFromZUpGeometry`) and is placed by its
own bounding box (`placeModelMovable`, then the exact height). Its `liftY` is
set so the export keeps the same offset from its piece that the scene shows.
The placement is then **read back off the scene** and compared value for value
with the generator's output; if it is more than 1 µm off, the support is taken
off again and the refusal names the error. It is one `addModels` undo step.

A support is a separate piece and not unioned into its host. That is what makes
Task 4 possible: a support unioned into the piece (the way Attach works) could
never be picked out again.

## 4. Change or remove one support

Click a support to select it. G-scope's own selection seam does this
(`NSO_MICROSCOPE.selectObjects`, which is `setSelection`), and the popover
opens in edit mode:

- **Apply** regenerates it with the new style or size through the same
  generator call, and replaces the old piece. That is **one** `supportSwap`
  undo step.
- **Remove** takes that one piece off the plate. Also one `supportSwap` step.

`supportSwap` is a new undo type in `app-core.js`. It puts back the removed
piece's model **and** its placed entry (same mesh, same pose, same place in
the list), and takes off any piece the step added. The existing `removePlaced`
undo restores only the placed entry and resets its height, so it was not
reused.

**How this sits with the paint-scope paradigm** (`docs/HANDOFF.md`,
"Scoping"). The support is a whole piece, and editing it is a
**whole-piece** operation on that piece: it is selected, replaced or removed
whole. No new selection mechanism was invented: the click is G-scope's own
selection seam, and on the main plate a support is an ordinary piece, so it
can also be selected and deleted there like any other. The host piece is never
written. The only paint-aware part is **detection**, which is **sub-region**:
the host's painted faces (`nsoMaskFaceList`) go in as `skipList`, so a painted
face never gets a marker. Those planes are recorded in the file's own axes, so
they are shifted into the world frame when the piece has only been moved. When
the piece is painted **and** turned, the scan is refused by name, because a
plane cannot be carried through a rotation by a shift. The roster row is in
`docs/HANDOFF.md` and `tools/nso_paint_scope_test.js`.

## 5. Validation

`gcode:gscope-support` (52 checks) uses a post with a 12 × 10 mm shelf and a
2 × 2 mm tab, which are `nso_support_tree_test.js`'s SHELF and TINY, plus a
plain block:

- **Markers vs detection.** `detectOverhangs` is called directly in the page on
  the same soup with the same options. There is one marker per region (2 on
  the shelf piece, 0 on the block). Each marker has the same id, area, aim
  point and triangle list. Each ping is at exactly `toView(region.point)`, and
  each overlay has exactly `triCount` triangles.
- **Point-click vs direct call (exact match).** A real mouse click on the tab's
  ping, then the popover, then Generate. The strut's `rawTris` equal
  `NSO_SupportAim.plan(...)`'s soup value for value, and it stands in the
  scene within 9 × 10⁻⁸ mm of it. A real click on the shelf's ping makes a
  tree equal, value for value, to `planTree` + `unionParts` called directly
  (16 branches, 786 triangles).
- **Canonical checker.** Strut, tree and gecko-hand are validated at the weld
  `nso_support_tree_canonical_check.js` derives from the solid's own closest
  vertex pair: PASS, 0 open, 0 non-manifold, 0 inconsistent winding,
  0 piercing, Euler 2. At the default weld each is still closed and
  non-degenerate. (A boolean's output carries vertices closer than the default
  1e-4 mm, so at the default weld the shelf tree reads non-manifold. That
  holds for the generator on its own, at the origin, too; it is the known
  weld artefact that check documents, not something G-scope adds.)
- **Export.** Each support sits against its piece in `buildCombinedGeometry`
  exactly as it does on screen.
- **Edit.** A real click on the tree selects it through the seam (source
  `support`). Apply → gecko-hand equals the direct call value for value
  (76 fingers, 4,860 triangles), as one `supportSwap` step. Undo gives back the
  tree: same model, same triangles, same pose, same world soup.
- **Remove.** A real click selects the strut. Remove takes that one piece off
  and nothing else, as one step, and its marker turns red again. Undo puts it
  back identically and in the same place in the list. Undoing a generation
  takes that support away.
- **Camera.** The camera the user was working with is kept across the plate
  re-read that follows each change.

Screenshots (written to `tools/gscope-support-out/`, git-ignored), each
asserted to be a drawn frame, with red / green pixels counted:

| file | shows |
| --- | --- |
| `01` | red markers on both overhangs |
| `02` | the marker's popover |
| `03` | a strut and a tree, both markers green |
| `04` | a support selected for editing |
| `05` | the tree changed to gecko-hand |
| `06` | the strut removed, its marker red again |

## Limits

- **Plate pieces only.** Supports are placed against a plate piece, so markers
  appear on G-scope's plate document. A file opened in G-scope has no plate to
  stand on; use Read the plate. Sliced `.gcode.3mf` toolpaths are not
  scanned: their supports are already in the G-code.
- **One tree per region.** A region too big for one trunk is refused with
  `planTree`'s own `trunksNeeded` count. A field of trunks is still the tree
  module's out-of-scope 1.
- **Region ids follow detection.** If the host piece changes shape after a
  support was made, "which overhang this holds up" is only as stable as
  `detectOverhangs`' area ranking.
- **A lifted piece** gets supports standing on its own bottom. That is where
  detection's `plateZ` (the soup's minimum) puts them, and the export keeps
  them there.
- **Not unioned.** A support stays its own piece. Join can fuse it into the
  host if a single body is wanted, but then it is no longer editable here.

## Files

| file | change |
| --- | --- |
| `app-gscope-support.js` | **new** - markers, popover, generation, placement read-back, edit / remove |
| `app-microscope.js` | `addClickHook`, `onDocument`, `toView`, `selectObjects`; the canvas click goes to hooks first, in every mode |
| `app-core.js` | the `supportSwap` undo type |
| `index.html` | the Supports section, the popover, the script tag |
| `styles.css` | `.ms-pop` |
| `tools/gcode-test/gscope-support-drive-check.mjs` | **new**, `gcode:gscope-support` |
| `tools/nso_paint_scope_test.js`, `docs/HANDOFF.md` | the roster row |

`?v=` tags not bumped (HANDOFF rule 4): `app-gscope-support.js` is new at
`?v=gsup1`, and `app-microscope.js` / `app-core.js` changed under their
existing tags. **They need a bump at merge.**

# Work as is: overlapping shells

A piece that is several closed shells laid through one another (`library/box_closed.stl`: a tray and a lid slab
that overlap the wall tops by 0.1 mm, 74 piercing pairs) used to be refused by every boolean verb: "box_closed has
overlapping shells (74 piercing pairs); clean it with tools/nso_fixture_union first" (#213). No verb refuses a
piece for that any more.

Gate: `npm run overlap:drive` (the inverse of what it gated before). Check & Repair: `npm run repair:loop`
(section 9). The worker route: `npm run bool:worker`.

## What a verb does with it

The verbs whose kernel needs a solid ask `nsoOverlap.solid()` (`nso-helpers.js`) first. When the piece's shells
cross, it unions them into one solid **for that operation** - the pass `tools/nso_fixture_union.mjs` makes, in the
kernel the verbs use (`NSO_shellMergeCore`, `nso_csg.js`) - and the verb runs on that solid.

| verb | runs on | the piece on the plate |
|---|---|---|
| Crop (the card's copy; a Piece cutter too) | the merged raw soup | untouched, byte for byte |
| Extract bit | the merged soup, for its inside tests | untouched |
| Subtract B from A | both pieces merged where they need it | A is replaced by the result, as ever |
| Join | the kernel union of the merged pieces (the planar fuse and the plate weld would stack the shells, so they stand down) | replaced by the result |
| Connect (weld), Bridge (sheet, string) | the plan as picked; the weld swaps in the merged pieces | replaced by the result |
| Carve (a click or a groove) | the merged world soup | replaced by the result |
| Attach, Reattach | the merged raw soup | replaced by the union |

The readout and the status line name it: `box_closed had 2 overlapping shells - merged for this operation`.

A Bridge **band** welds two faces without the kernel and never asks.

### The one refusal left

When the union cannot make a closed solid - a shell that is itself open or non-manifold, so the kernel will not
take the mesh - the verb is refused, in words, and nothing changes:

    Crop refused - nothing changed (box_lid_open has 2 overlapping shells that cannot be merged into one closed
    solid: a shell is not closed, so there is no solid to merge (the kernel says Not manifold))

### What is "overlapping"

`NSO_Repair._overlapShells`: the checker's piercing pairs whose two triangles truly cross (each straddles the
other's plane by more than 1e-3 mm) and lie on two different shells (faces joined through a welded vertex). Shells
that only touch (a mark standing on a bar's face) are contact, and a single shell that pierces itself is not
overlapping shells: both go to the kernel as they are. Unknown (no checker loaded) is never a merge.

### The merge

`NSO_shellMergeCore(soup)`: the soup is welded as a union's input is, lifted into the kernel whole, split into its
shells, and the shells that hold volume are unioned. A shell wound inward is a cavity (a hollowed piece's inner
wall): it is turned right way out and subtracted, so a hollow piece stays hollow. (Manifold accepts an inward shell
as a negative volume, and `compose` quietly drops it, so the cavity is handled in soup space.)

### Once per piece

The measure is kept on the piece's raw soup, the merge on the soup it merged (the raw soup, or the drawn geometry's
own triangles, then posed through the mesh's world matrix), in WeakMaps: every edit replaces them and a pose
changes neither. A big piece (`NSO_BoolConfig.bigTris`, 50,000 triangles) is measured (`Checking… N s`) and merged
(`Merging shells… N s`) in the boolean worker, under the bar, Escape and the watchdog. A stopped merge is not kept.
The Crop card's plan uses a merge already made for its piece, and says so in its readout.

## Verbs that never needed a solid

Scale, Move, Rotate, Tip, Cut, Crop band, Lift, Split to parts, Export, G-scope and Detach do not ask at all.
`overlap:drive` section 5 holds it: of the scripts the page loads, only the solid verbs' files name `nsoOverlap`,
and Detach on `box_closed` runs without asking it.

## CHECK & REPAIR: MERGE SHELLS

Check lists the finding on the piercing row - `2 overlapping shells, 74 piercing pairs - shells passing through
each other` - with one **MERGE SHELLS** button, whole piece (`nso-defects.js` reports `shells` and
`overlapShells`; `nso-findings.js` makes the row). It runs `nsoMergeShellsRun` (`app-findings.js`): the same
merge, committed to the piece (`mergeShellsReplace`, one Undo puts the shells back byte for byte), bracketed by the
card's before / after re-scan like CAP and PATCH. Paint stands it down (the merge replaces every triangle). Fix all
awaits it like the other fixes.

## The big 3MF

The butterfly vase from #233 (1,460,928 + 1,440 triangles; `tools/fixtures-local/boolean-vase.3mf`, git-ignored,
or `NSO_BOOLEAN_3MF`) is section 6 of `overlap:drive` and the whole of `npm run bool:3mf`. Both skip, with a notice,
when the file is absent.

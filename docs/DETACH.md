# Detach and Reattach: take a detected feature off, put it back elsewhere

`nso_detach.js` (`window.NSO_Detach`, and a Node module) plus `app-detach.js`
(the Cut menu row). The first feature it works on is the flange that
`nso_flange.js` finds (docs/GSCOPE-FLANGE.md).

```
node tools/nso_detach_test.js        headless: the audit, the v9 acceptance test against Crop stage 2, poses, shapes, refusals (57 gates)
node tools/nso_wire_detach_test.js   the real app: the buttons, a real click, both undos, the refusals (28 gates)
```

Both are in `npm test` (`detach:test`, `wire:detach`).

## What it is, next to Crop

Crop takes a **box** out of a piece. The box is the user's and says nothing
about the part. Stage 1 slides the far part back. Stage 2 moves a region and
reconnects it to whatever it lands against: it trims an overlap, or it
bridges a gap with a filleted, sampled bridge.

Detach starts from a feature the part is **known to have**. It uses what
detection measured about it: the root plane, the neck wall it comes off, and
where that wall steps.

- **The hull** is capped on its own wall. What is left is the part as if the
  flange had never been there, with no trace of it and no gap to bridge.
- **The flange** comes off as a real, closed piece, in a frame Assemble's
  attach takes as it is.
- **Reattach** seats it somewhere else with Attach's measured seat, and
  unions it. Nothing is bridged, because nothing is left with a gap.

## 1. The audit

### Detection: enough for the flange, not for a clean hull

`detect()` already gave the root plane: its normal (−Y on the clamp bar) and
the cut, 2 µm past the outermost piece of neck wall (y = −2.0123).
`extract()` cuts there with the Cut tool's `rawCut`, which caps with
`rawFlatCapLoops`. That is the flange, validated in docs/GSCOPE-FLANGE.md.

For the **hull** the plane is not enough, because the clamp bar's neck wall
is not one plane. It is three, stepping 10 µm at each Mirror-Join seam:

| wall piece | y | along the root |
|---|---|---|
| beyond the −X seam | −2.0103 | x −93.493 … −88.565 |
| between the seams | −1.9987 | x −88.565 … 87.537 |
| beyond the +X seam | −1.9897 | x 87.537 … 93.493 |

One cut cannot cap that cleanly. Both options were measured
(`detach:test` §1):

- **On the flange's own plane:** a valid solid, but it keeps a skin of
  flange past the wall. The skin is 2.00 µm thick beyond −X, 13.52 µm
  between the seams, and 22.53 µm beyond +X.
- **On the innermost piece:** the neck wall itself is cut back. Beyond −X it
  goes from 2.0103 to 1.9897, so 20.53 µm of body is shaved off the whole
  height of the wall, below the flange as well.

So detection now also reports the wall's pieces: `flange.cut.pieces` (offset,
area, and where each runs along the root) and `flange.cut.along`.
`refineRoot` already visited exactly those faces to snap the cut; it now
groups them by offset (1 µm splits a 10 µm step from a turned pose's 12 nm
float noise). Nothing it reported before changed: the flange suite's 48 gates
hold.

The hull then needs **no new capping math**:

1. one `rawCut` per wall piece, each flush with its piece and capped by
   `rawFlatCapLoops`;
2. `rawCutOpen` at each step (the seam planes, x = −88.565 and 87.537);
3. **Crop stage 1's own seal, `NSO_cropSeal`**, splices the pieces back
   together. It remakes the step faces with `rawFlatCapLoop`, so the root cap
   is a 10 µm staircase that follows the wall exactly.

A wall that is one plane, the usual case, is one `rawCut` and no splice.

### Assemble: attach takes a real piece, with three opt-in additions

`attach(body, arm, opts)` takes any arm whose attach axis is +Z, with its base
on z = 0. Detach hands the flange over in exactly that frame: root face on
z = 0, reaching +Z, plate normal +Y. The frame is checked, not trusted:
`baseOf` passes. Three things did not fit, each measured on the v9
mirror-opposite placement (`detach:test` §1):

| what | as it was | added |
|---|---|---|
| **the foot** | attach's foot is the body point nearest the arm's TIP. The flange cantilevers 0.9 mm over v9's teeth, so the nearest point to its tip is a tooth, 15.2 mm from the picked root. The drift gate is half the arm's width, 93.5 mm for a 187 mm plate, so the attach was not refused: it **aimed 87° off the asked direction and seated the flange 58.9 mm deep**. | `opts.footAt`: `at` is the foot. Auto-aim's line test still runs, now public as `NSO_SupportAim.lineBlockedAt` (the test `nearestBase` runs, in the same words). |
| **the twist** | `place()` turns +Z onto the aim by the shortest turn, so where the plate's normal lands is whatever that turn makes of it. Aimed +X, the plate **stands on end, 186.99 mm tall**. Aimed +Y, it lands **upside down**: all 136 faces of its top face down. | `opts.up`: where local +Y should point. `place()` is asked which turn it will bake (a one-triangle probe), and the arm is pre-turned about its own +Z by the difference. `place()` stays the one bake. |
| **the length** | attach sinks the arm by the seat, then grows it back with `NSO_extendRaw`. **Extend refuses the flange**: "no constant cross-section band along z … 12 straddling triangle(s) are slivers". Its top and bottom are long root-to-tip slivers, and its ends follow the bar's rounded ends. | `NSO_Detach.extendRoot`: Extend's own contract, met at the flat root. The cap moves down by the growth and its outline is walled straight to it. It is plugged into attach's existing `extendRaw` hook, and it adds exactly root area × growth. |

With none of these passed, attach behaves as before, and the Assemble suites
(`assemble`, `assemble:canonical`, `wire:assemble`) pass unchanged.
Everything else is attach's own: the rim gap (every root rim point, measured
back through `nearestBase`), the margin (`NSO_Thickness.floorFor`), and the
bake.

## 2. Detach on the clamp bar, `library/v9_mirror_factory.stl`

| | measured |
|---|---|
| hull | `mesh_validate.py` **PASS with self-intersection**, 0 open / 0 nm / 0 inconsistent, χ 2, 0 piercing |
| trace | **0 µm**: no hull vertex stands past its own wall piece |
| the root | every face there is cap on a wall piece's plane (145), a seam step face (50), or the source's own surface (1, at the bar's rounded end) |
| away from the root | 22,414 of 22,414 source vertices in the hull, bit for bit (the seams' ±0.5 mm aside, where Cut's weld merges the sub-tolerance pair) |
| flange | the Flange tab's flange **bit for bit** (2858 triangles, 8146.24 mm³), PASS with self-intersection |
| accounting | 53758.554 = 45604.895 (hull) + 8146.242 (flange) + **7.417** mm³ |
| time | 2.1 s in Node, 3.5 s in the page (49,026 triangles) |

The 7.417 mm³ is the sliver between the flange's cut (2 µm clear of the
outermost wall piece) and each piece. It is 2.00, 13.52 or 22.53 µm thick,
and it matches its closed form from the hull's own cap areas (7.416). The flange keeps a
flat root. The hull keeps the staircase. The sliver is thinner than the
wall's own seam steps, and it belongs to neither piece.

The source itself fails the checker (2 non-manifold / 5 inconsistent edges,
all at the seams). The hull passes, because Cut's weld merges the +seam's
sub-tolerance pair.

## 3. Reattach at the mirror-opposite position, against Crop stage 2

**Where.** The flange's root, mirrored through the bar's middle (y → −y), is
in the air. At the flange's height, 7.53 – 10.47, the +Y side of the body is
the ridge's rounded shoulder, 1.86 mm further in. The teeth top out at
Z 6.64. So the root goes where a line from the mirrored root back toward the
body meets it: (0, 0.152, 9.0), aimed +Y, plate normal +Z.

| | measured |
|---|---|
| seat | 0.496 mm rim gap + 0.420 mm margin = **0.916 mm**, length kept (**14.998 mm** proud, the flange's own reach) |
| pose | flat, Z 7.531 … 10.469 (its own band, flush with the top like the original), Y −0.764 … 15.150, the whole X −93.493 … 93.493, across both seams |
| union | one part. The raw union is 2 nm / 5 inc by the checker (vertices under its 1e-4 weld); Crop stage 2's finish (Cut's weld, `rawSplitDegenerates`) closes it |
| result | **PASS with self-intersection**, χ 2, 0 piercing |
| contact | the flange meets the body **at its seat only**: 496.1 mm³ of overlap, against at most 503.1 for the seat. It clears the tooth tops by 0.892 mm, cantilevered as the original was over air |
| bridging | **0 of 48,654 triangles** lie off the two input surfaces (worst 0.2 µm): every face of the result is the hull's or the flange's |
| Stage 2's splits | through the +seam ring, x 80 and a slot wall (x 77.3): both halves pass each time |

**Against Crop stage 2's own result for the same relocation.** The −Y lip to
the mirror-opposite +Y side, at its own height, the case in Stage 2's own
acceptance test. `detach:test` §3 **runs** Stage 2's `NSO_cropMoveRaw` (merged
in PR #114; `app-crop.js` and every file it calls are byte-identical to its
branch head 3b4227a) and measures its result the same way. Its moved
region's surface is the source's, shifted by the move, and its notch lies on
the box planes. Anything off all of those is what it added.

| | Crop stage 2 | Detach + Reattach |
|---|---|---|
| what moves | a 12 mm region, X 74 … 86. Its box cannot reach the bar's ends, and it has not been tested across both seams | the whole 187 mm flange, across both seams |
| how it meets the +Y side | **bridge**: a 0.897 mm gap, filled | **seated at its root**, 0.916 mm |
| added material | **+6.25 mm³** of bridge, surface nets at 0.08 – 0.15 mm pitch | none but the seat |
| triangles on neither input surface | **3,091 (90.8 mm²)**: the bridge | **0** |
| canonical checker | PASS, self-intersection included; χ 0, because the bridge spans a slot between two teeth and closes a loop | PASS, self-intersection included; χ 2 |
| where it left | a notch, closed by the subtraction's box planes | the wall, capped flush, 0 µm proud |

Stage 2's 2 mm-down variant trims into the teeth instead (11.54 mm³). Reattach
refuses that on purpose (see Refusals): it puts a piece back, and it does not
trim one.

## 4. Poses and shapes

- **v9 turned 90° about Z** (a signed-permutation frame, exact): the hull
  passes, trace 0, and it is the same 8146.24 mm³ flange.
- **v9 turned 30° about Z** (a frame with irrational entries): the hull
  passes, trace 0, and the flange is 8146.40 mm³ (within 0.002 %). Planes and
  steps are compared on float32 values, because the soup is float32 and a
  step compared in double reads a seam vertex as 10 µm proud.
- **Lip on a block:** one wall piece, one cut. The hull is the block,
  16000.000 mm³ exactly. Reattached on the opposite face it is one solid,
  PASS, seated exactly 0.42 mm (rim gap 0 on a flat face), full reach proud.
- **T section:** one wing off, and the hull is the web plus the other wing,
  8480 mm³ exactly. The remaining wing now fails the flange rule's "body"
  test (a leg off a 4 mm web), as it should: it used to carry on across the
  web into the wing that went.
- **Hat section:** one brim off. The hull passes, and exactly 1560 mm³ came off.

## Refusals

Every refusal names its reason and makes nothing.

| refusal | why |
|---|---|
| not a detected flange | Detach works from what detection measured |
| no neck wall beside the root | no wall of the hull's own to cap flush with |
| wall pieces that do not meet end to end | a wall that steps is followed; one that interleaves is not |
| the pieces do not add up | the root plane takes body that is not the flange (a boss on the same face: 120 mm³ unaccounted for) |
| the hull is not closed / stands past its wall | the gate, on float32 values |
| nothing detached | Reattach needs the piece Detach made (and, in the app, unedited since) |
| the line out of the picked point is blocked | auto-aim's own line test |
| the piece runs into the body past its seat | Reattach puts back, it does not trim: 2 mm lower on v9 the plate runs into the teeth, 978.8 mm³ of overlap against a 664.6 mm³ seat |
| (app) a face along the plate's own normal | a flat plate cannot come straight out of the top of the bar |
| (app) painted faces | whole-piece paint scope, below |

## UI

Cut menu, below Crop.

- **Detach flange** runs on the cutter's piece. The piece keeps its place and
  its id and becomes the hull. The flange lands beside it as its own piece,
  `<name> - Flange`, which can be exported, moved and checked. The in-page
  checker gates both. **One Undo** puts the piece back value for value and
  takes the flange off the plate.
- **Reattach** arms a click, like Attach. Click the point on a piece where the
  flange's root should go. The flange keeps lying the way it lay (its plate
  normal is kept). It reaches out of the clicked face as squarely as a flat
  plate can: the face normal, with its part along the plate normal taken out.
  It is seated, unioned and gated, and the flange piece is used up. **One
  Undo** puts back both the piece and the flange piece.

Both undos are one `featureSwap` step (app-core's `undoLast`). It holds the
geometry swap `NSO_sculptCommitRaw` recorded (`detachReplace` /
`reattachReplace`) and the piece added or used up. The click is converted to
the piece's raw frame by Attach's own mapping (`nsoAttachRawPick`, exported
from `app-assemble.js`, not copied).

## PAINT SCOPE: WHOLE-PIECE

This follows the scoping rule in docs/HANDOFF.md, for both tools.

- **Detach** hands back a hull that is a new soup. Every triangle has been
  through rawCut's weld, and on a wall that steps through the seal. The
  flange is a new piece. No face of the old piece survives as itself to carry
  its paint.
- **Reattach**'s union replaces every triangle of the piece it lands on,
  exactly as Attach's does.

`nsoMaskCount(m) > 0` stands either tool down and names the count.
`nso_detach.js` itself is **none**: it reads soups and writes none.

## API

```js
NSO_Detach.detach(soup, flange, deps?)    // -> { ok, hull, piece, wall, volumes, seals, traceMm, reason }
NSO_Detach.reattach(body, piece, opts)    // -> NSO_Assemble.attach's result (opts: at, dir, up?, engageMm?, ...)
NSO_Detach.finishUnion(unionSoup)         // Cut's weld + rawSplitDegenerates + the census
NSO_Detach.unionCheck(body, seated, union, attachResult, piece)   // overlap <= the seat?
NSO_Detach.extendRoot(soup, { axis: 'z', length })               // Extend's contract, at the root
NSO_Detach.toWorld(piece, local?)          // the piece back where it came from
```

`piece`: `soup` (where it was, in the part's frame), `local` (Assemble's
frame), `frame` (`origin`, `rows`, `along`, `up`, `out`), `rootArea`,
`thickness`, `reachMm`, `volume`.

The union is the caller's, as for attach: `NSO_unionSoups` is async, and it
lives in app-join.js.

## Limits, named

- **Flanges only.** It is the one feature detection understands structurally.
  A round flange is not detected (docs/GSCOPE-FLANGE.md), so it cannot be
  detached.
- **The sliver.** 7.4 mm³ on v9, 2 – 22.5 µm thick, belongs to neither piece
  (see §2). Cutting the flange on the staircase too would make the two pieces
  add up exactly, at the price of a stepped root on the flange.
- **One contact.** Reattach's only contact is the seat. A placement that runs
  into the body anywhere else is refused, not trimmed.
- **Frames.** `up` defaults to the plate normal in the source piece's raw
  frame. Reattaching onto a different piece whose raw frame is turned against
  the source's takes that raw direction as it is.
- **The mirror-opposite is not the mirror image.** At its own height the
  mirror image touches nothing (§3). Reattach seats the root into the body
  1.86 mm further in, and it does not bridge the gap.

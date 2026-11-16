# Feature size — resize one tab, boss, slot or pocket, leave the rest of the piece

`nso_feature_size.js` (headless) · `app-scale-feature.js` (the section) · UI: the
**Feature size** button at the bottom of the **Scale** card · tests:
`npm run feature:size` (node), `npm run scale:feature` (drive)

## Why

The owner's ask (2026-11-16), on the A1 Mini tool-head lock: the risers were
scaled, their slots shrank with them (25.2 → 20.29 mm), and the lid's tongues
(25 × 5 × 4) no longer fit. Scale resizes a whole piece and Offset moves every
wall; nothing resized **one feature**. Asked for "in Scale", with a ghost and
a live stretch / shrink while working, and a mm box exactly like Scale's.

## Using it

1. Select the piece, open **Scale**, press **Feature size**. The piece turns to
   a ghost.
2. **Click a feature** on the piece: a tab, a boss, a rib, a slot, a pocket.
   It is found (lit blue) and its **Length × Width × Height** fill the boxes
   (for a recess the third box reads **Depth**).
   **Shift-click** another to size it with the first: every picked feature gets
   the typed size, each about its own middle. A click on a picked one drops it.
3. Type a size, or move a slider: the resized features are drawn green where
   they will land. The piece is not touched.
4. **Set** (or Enter) bakes it — one Undo (`featureSizeReplace`). The section
   stays on the same features for the next change. **Cancel** (or Escape)
   drops it.

**Keep ends** (the default) moves the ends of the feature and keeps their
corners, eases and a rounded tip exactly; the middle stretches to meet them.
**Stretch** scales the whole feature about its middle (Height about its foot) —
use it for a round pin or boss, which Keep ends would make a stadium.

The section follows the card's **mm | in** toggle. Touching the card's own
rows puts it away, and arming it drops the card's own preview: one ghost at a
time.

## What a feature is

A **raised** feature is every face you can walk to from the clicked one without
crossing an inside (concave) crease sharper than 20°: a tongue's top, sides and
eases are one walk; the inside corner where it meets the plate stops it. A
**recessed** one is the same walk with the crease reversed: a slot's floor and
walls, stopped at the outside corner round its mouth. The section tries raised
first; a raised walk with nothing standing proud of its edge (a slot floor) or
that takes over half the piece is not a feature, and recessed is tried.

The walk's edge is the feature's **foot**. It must be flat (0.05 mm): the foot
slides in its own plane, and the face round it stretches to follow. The foot's
plane gives the frame — **n** the way the feature goes, **u** along its length
(the long side of the smallest rectangle round it), **v** across.

## How it resizes

Only the feature's own vertices move. The faces round the foot share the
foot's vertices, so they stretch with it and the piece stays closed — same
triangles, same topology.

- **Keep ends:** the outer 30% of each half moves rigidly by half the change;
  the middle 70% stretches. Height: the top 30% moves by the change, the rest
  stretches from the foot. It goes down to 30% of a size at the least (the
  band meets the middle) — refused below that, in words, pointing to Stretch.
- **Stretch:** every coordinate scaled about the middle (u, v) and the foot (n).

**Growing past the face's own corners.** A foot that grows over a vertex of
the flat face round it would fold that face's triangles. The face is flat, so
it is laid again (NSO_CDT) inside its own unchanged edge and round the moved
foot; its rim edges are the old ones vertex for vertex, so the piece stays
closed. A foot that would reach or cross the face's edge is refused.

## Refusals, all in words, nothing changed

- not a feature (it is the piece; nothing stands proud of its edge)
- its foot is not flat
- under the Keep ends floor; a size of 0
- a fold that relaying the face cannot fix; the foot past the face's edge
- two picked features sharing a corner
- **pierce gate** (the app): a feature grown into another part of the piece —
  a slot deepened through a wall — is not a fold but one surface crossing
  another. `NSO_Repair.inspect` counts piercing pairs before and after, as
  Thicken does; more after is refused. It runs when the numbers stop moving
  and again at Set.
- a painted piece (PAINT SCOPE: WHOLE-PIECE, as Thicken)

## Measured on the owner's file

`toolhead_lock.3mf`: the Top's tongues read 25.00 × 5.00 × 4.00 (raised, 314
faces each); a riser slot reads 20.29 × 5.20 × 4.10 deep. Both tongues to
20.08 (0.1 mm a side in the scaled slots), Keep ends: closed, 20.080 × 5.000 ×
4.000 each. The slot to 25.2 long: no piercing (it does not reach the hood's
inner wall, which is at a different place along the riser); deepened to 10 mm,
the pierce gate refuses it (0 → 9 piercing pairs).

## Not done

A foot on a curved face; a feature whose foot spans two faces at an angle;
resizing a feature that is not on a flat face. Growth past the face's edge is
refused rather than carried onto the next face.

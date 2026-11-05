# Shells as pieces - a shell that pierces another is a solid of its own

*Added 2026-10-23 (ticket shells-as-pieces).*

`library/box_closed.stl` is two closed shells laid through each other (74 piercing
pairs): a tray and a lid slab. A vase's handle is a second shell sunk into its body.
Both are two solids shoved into each other, not one broken surface. Before this
ticket, Split to parts read the second shell as "a hollow inside it" whenever its
winding said so, Lift tried to carve a handle out of a surface that is already a
separate solid, and Check & Repair offered only Merge.

**The rule.** A closed shell that *crosses* another is a part. A closed shell that
stands *free* of the rest is a part. A closed shell wholly *inside* another with no
crossing is a cavity of it.

## The classifier - `nso_shells.js`

One engine file, a classic script and a Node module (`window.NSO_Shells`), loaded
before `nso_split_parts.js` and loadable by name in a worker. No DOM, no Three.js, no
other file.

```
NSO_Shells.shells(soup, opts) -> { ok, n, shells, of, tris, pairs, parts, owned, words }
  shells[i] = { id, faces, tris, closed, vol, lo, hi,
                crosses: [ids], insideOf: id|null, body,
                free, part, clear, liftable }
```

* **crosses** - any piercing pair with that shell. A pair is the reading
  `NSO_Repair._overlapShells` already makes (`pairCrosses`): each triangle straddles
  the other's plane by more than 1e-3 mm and the two truly meet, so shells that only
  touch, and near-coplanar slivers, do not count. `opts.count` tallies the pairs
  (box_closed: 10, the number `NSO_Repair` counts); otherwise the first crossing of two
  shells is enough.
* **insideOf** - the innermost closed shell that holds it, found by a ray-parity vote
  from three points on its skin; only asked of a closed shell that nothing crosses.
* **part** - closed, and it crosses another or is inside nothing. **free** - a part
  that crosses nothing. **clear** - free, and its box meets no other body's box (a
  body is a shell and the hollows inside it): two things standing on a plate, not a
  print-in-place assembly whose parts interleave. **liftable** - a part Lift can take
  out whole: it crosses, or it is clear.
* **owned** - two or more parts, and every one of them liftable. This is when Lift
  reads the piece as shells.
* Shells are cut as Split to parts always cut them (`cutShells`, moved here from
  `nso_split_parts.js` unchanged): across edges used by two faces, with the wedge
  rule for an edge two shells share. `opts.cut` hands in a cut already made.
* `NSO_Shells.overlaps(items)` is the same crossing test between *pieces*
  (`[{ name, soup }]` in plate space) - the export check below.

`NSO_Repair.js` is not edited: 213 of the suite's 262 steps reach it. The classifier
repeats its crossing reading and `tools/nso_shells_test.js` holds the two to the same
pairs on box_closed.

### Readings

| piece | reading |
|---|---|
| `library/box_closed.stl` | 2 closed shells: 68 + 12 triangles. Each `crosses` the other; neither is inside anything. 10 truly crossing pairs (of the 74 piercing). 2 parts, **owned**. |
| a hollow box (`fixtures/box_cavity_30.stl`) | 2 shells: 12 + 12. The inner one (volume -17576, wound inward) is `insideOf` the outer, crosses nothing. 1 part, not owned. |
| the generated vase (`tools/nso_shells_fixtures.js`: a lathe body and a handle shell sunk into its wall) | 2 closed shells that cross: body (23,424 tris at the test size), handle (1,476). 2 parts, **owned**. Wound inward the handle reads the same. |
| a vase with no handle | 1 shell. Not owned. |
| a body with a cube well apart from it | 2 free, `clear` shells. **Owned**. |
| the print-in-place hinge (`feature-hull_hinge.stl`) | 2 free shells whose boxes interleave: parts, neither `clear`. **Not owned** - Lift reads it as it always did. |

## Split to parts

`nso_split_parts.js` takes its cut from `nso_shells.js` and asks which shells cross.
A shell another one crosses is a part whatever `cavityShells` says about its winding;
nothing else about the engine changed (`tools/nso_shells_test.js` section 6 holds
eleven fixtures to the engine as it was, hash for hash). box_closed -> 2 pieces, each
with 0 piercings, every triangle bit for bit where the whole drew it; the vase ->
body + handle; a block with a pin through it -> 2 parts. A piece with one shell and a
true cavity is still "1 part". The readout names a crossing: *"2 shells crossed
another now a piece of its own"*.

## Lift

When `owned`, Lift reads the piece as shells and runs **no height map at all**: the
card says "N shells found", hovering a face outlines its whole shell, a click takes
that whole shell out as a piece - no cut, no face region. Every triangle of the shell
and of what is left is as it was, and **nothing moves** (the leftover is re-landed
where it stood, as Split to parts lands its pieces; Undo puts both back). What is left
is read again on the next hover, not at the lift. Single-shell pieces, and pieces
whose parts interleave, are read exactly as before (`NSO_LIFT_PLATE.shells()` is null).

## Check & Repair > Findings

The overlapping-shells row gets **SPLIT SHELLS** beside **MERGE SHELLS**, same row
layout (one item line each). It runs the very split Split to parts makes, on the piece
the card is about; the card then follows the first piece, says for every resulting
piece whether the finding is gone (one green line each), and one Undo puts the one
piece back. **Fix all** never runs it (it changes how many pieces there are).
MERGE SHELLS is as it was.

## Export

Pieces whose shells cross each other in plate space get one line in the export
status - the file is still written:

    Downloaded nest_Bambu_A1_Mini_2pcs.stl - these pieces overlap; Join before printing: box_closed part 1 + box_closed part 2

STL and 3MF both; up to three pairs are named, then "and N more". A plate with no
overlap says what it always said. (`app-export-overlap.js`; there was no export check
before - docs/OVERSIZED-WASHER.md section 1 - so the line rides the export's own
status.)

## Decisions the ticket did not make

* **The classifier lives in `nso_shells.js`, not in `NSO_Repair.js`.** The ticket said "in the engine where the
  piercing count already comes from"; `node tools/run-tests.mjs --touching NSO_Repair.js` lists 213 of 262
  steps - the full suite, which the one-full-suite rule forbids running during dev. The new file repeats
  `pairCrosses`' reading and a gate holds the two to the same pairs on box_closed.
* **"Stands free" means stands clear for Lift.** A shell with no crossing that is in nothing is a *free* part, and
  Split makes it a piece (as always). Lift takes it out whole only when it is also *clear* - its box meets no
  other body's box. Without that, the print-in-place hinge (two free shells that interleave: docs/LIFT.md section 8)
  would be hijacked: clicking its leaf would lift the whole hull. `owned` also requires *every* part to be
  liftable, so a piece with one interleaved part and one clear one is read as before.
* **`lift:assembly` section 9 changed its expectation.** It held that a plate with a cube floating clear above it
  reads "0 features found" and the cube "can't be lifted". That is two free shells, which the ticket says Lift
  takes out whole; the section now holds that ("2 shells found", a click lifts the cube, one Undo).
  `repair:loop` section 9 changed the same way: the pierce row has two items now.
* **Lift's leftover is landed where it stood**, not re-seated by the commit (which re-centres a piece on its own
  new box). The ticket asks that positions are unchanged for Split; the same holds for Lift's shell so that
  taking a lid off a box does not slide the box. Undo restores the pose it had.
* **After a shell lift, the leftover is read on the next hover**, not at the lift: reading a big piece is the
  expensive part of Lift, and the shell is already out.
* **SPLIT SHELLS is `manual`**: Fix all never runs it. It is offered where MERGE SHELLS is (whole shells, no open
  or pinched edges); on a piece with open shells the row stays the plain piercing row.
* **The export line rides the export's status**, since there was no export check to put it in. 3MF and STL both,
  from the geometry the file is made from; "overlap" is crossing, as everywhere here - a piece in another's hollow,
  or touching, is not.
* **A shell wholly inside another stays what the engine says it is.** Split keeps `cavityShells`' reading for
  shells that cross nothing (an outward-wound captive ball in a cavity is still a part, as the hinge/rattle gates
  hold); the new rule only overrides it for a shell that crosses.
* **Old Split already read box_closed (and the generated vase) as 2 parts.** The "hollow inside it" reading
  the ticket describes did not reproduce on box_closed or on any generated crossing shell, wound either way; the
  override is a guard, and the rest of Split's gain is the words ("shells cross another") and the Findings
  button.

## Gates

* `npm run shells:test` - the engine: the readings above, Split, "nothing else
  changed", the export test, timings (53 gates).
* `npm run shells:drive` - the real app: box_closed Split / Lift on the lid / SPLIT
  SHELLS / MERGE SHELLS / the export line, a hollow box, a free second shell, the
  vase handle with timings. `tools/fixtures-local/vase.stl|vase.3mf|boolean-vase.3mf`
  (or `NSO_SHELLS_VASE`) is read too when present; otherwise that section is skipped.
* `node tools/run-tests.mjs --touching <file>` for each file changed, `page:manifest`.

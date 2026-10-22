## Extend - axis-preserving stretch
`app-extend.js`, wired at the existing `?v=inside4` tag straight after
`app-sculpt.js` (it reuses `NSO_sculptCommitRaw` and the sculpt measurement
helpers). UI is an **Extend** button plus a length box in the Finish menu.
Full write-up: `docs/EXTEND.md`.

Lengthens a piece along its one dominant straight axis and holds the
cross-section perpendicular to that axis **bit for bit** - not to a tolerance.
A gate inside `NSO_extendRaw` compares every non-axis coordinate against the
input on each run and refuses if one moved. Distinct from Scale-to-size, which
moves all three axes and would change every functional dimension on the piece.

Three things a later ticket should read before touching this:
- The perpendicularity gate is a **derived, per-triangle** tolerance, not a
  fixed one. Measured: the same flat wall reads `|n.u|` 3.4e-9 at the origin
  and 2.8e-6 at a +1400 mm offset, so a fixed 1e-6 gate refuses a correct
  piece. The achieved-length gate is counted in float32 ULPs for the same
  reason. `docs/EXTEND.md` findings 1 and 3, with the numbers.
- **`pin.stl` extends correctly and should.** The ticket expected it to refuse;
  measurement says its 0.1 mm end chamfers are end features, not a taper, and
  its 19.8 mm shaft is a clean band. The gate belongs on the cut region, not on
  the whole piece. Finding 4. The real taper refusal case is a cone, built in
  the self-test.
- Built before `app-scale.js` was visible from its branch point, so the two were
  compared only at merge. They converge: both probe-measure-correct in at most
  four passes, and `NSO_scaleGate` already scales its weld quantum and area
  epsilon by the factor for the same reason Extend counts in ULPs. Scale's
  tolerances track the FACTOR, Extend's track the coordinate MAGNITUDE (its
  factor is always 1). `docs/EXTEND.md` "Against Scale-to-size".
- **Re-tiling is not this.** Stretching `hinge_knuckle_box` makes one 3.6 mm
  finger longer rather than adding a finger - exact, and it will no longer
  interleave with its lid. "Stretch the border, re-tile the interior" is a
  separate ticket.

`npm run extend` (54 checks, headless), `npm run extend:canonical` (50 checks,
`tools/mesh_validate.py` before/after, machine-compared) and
`npm run wire:extend` (28 checks, real app). All three in `npm test`, along
with `npm run paint:scope`, which was written but never wired into the suite.

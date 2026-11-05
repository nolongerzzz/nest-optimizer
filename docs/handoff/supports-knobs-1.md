## Supports knobs 1 - the supports playground: four knobs on Custom/Assisted (2026-10-25)
Engine and export name only, no UI (the card's fields are the next ticket).
`nso_support_gridpack.js` (`feed.knobs`, `knobsOf`, `knobsEcho`, `trunkLaw`),
`nso-3mf.js` (`supportKnobs` in the object's name), `docs/SUPPORT-GRIDPACK.md`
section 7 "Knobs". Check: `npm run support:feed` section 7.

`feed.knobs = { trunkTipMm (2), trunkAngleDeg (5.5), leanDeg (30), nodeMm (5) }`
on an Assisted or Custom feed; absent = today's plan, to the bit.

**Where each knob is read** (all places; the trunk law is one record per trunk,
`grow.law`, copied from `plan.knobs` by `stemOf`):

| knob | read in |
| --- | --- |
| `trunkTipMm`, `trunkAngleDeg` | `growTrunks` (the trunk builder, ~1263: per foot, `g.law`), `reland` (the landing's fit, ~2340: `g.law`), `shareFeet` (feeds `growTrunks` the same feet, so the law rides with them), `GP.trunkLaw(plan)` (the TRUNK descriptor's per-plan form; `GP.TRUNK` stays the shipped law) |
| `leanDeg` | `plan()`: `tanT`/`cosT` (every leg, merge, pickup, steer, landing zone reach); `reland`'s `sMax` through `plan.branchTiltDeg` |
| `nodeMm` | `plan()`: `g = L/2` (every merge node); `keepOutSoups` trim (was `KEEP_TRIM_MM = LATTICE_MM`) |

A stair's own trees (`trunkStepper` -> `plan(..., { _knobs })`) get the same
knobs, so a stair's trunks are built, re-landed and planned by the same four.
`plan.knobs` echoes `{ trunkTipMm, trunkAngleDeg, leanDeg, nodeMm, given,
nonDefault, problems }`; it exists only when knobs were given.

**Validation.** Finite number > 0, except `trunkAngleDeg` >= 0 (the ticket
asks both for "> 0" and for "0 gives a straight trunk"; 0 is allowed). An
unknown knob name, a non-number, or knobs on Auto are refused by name
(`plan.stage` 'feed'). Knobs on Auto are refused rather than ignored: a
misspelt knob that silently reverts to the default would spoil a
one-variable-per-print run.

**Identical plan, proved.** Against claude-wip 525e244's own files (a worktree
of HEAD, same driver, `plan` + `parts` (card options, and `footPads:
'shared'`) + `shells`): the plan JSON, the parts' feet/re-landings/trunk
records, the shells' soup and the members hash are equal for arc, tilted box
and coupon with no knobs (both part modes). And `support:feed` 7a: all four
at their defaults builds the same soup, members, feet and re-landings as no
feed at all, on the three pieces.

| piece | plan | tp | soup | members |
| --- | --- | --- | --- | --- |
| arc | f0a401cd014a8fbc | d053e00171ae64f2 | 425317e0e6b2d6d5 | 2eeb1cd905b3e1e4 |
| tilted box | 0e758ed26cf6749d | 2ca7a3f0f6461dec | 6c18f92151e54e5d | 921907468e64f599 |
| coupon | b30dffe32d8c4cbf | 43b785fdd0fd9796 | 0c9614089dd9e25a | 03a9eda70d482a26 |

**What a thin or odd value breaks** (measured on the coupon and the arc
through `plan`, `parts`, `shells`, `weld` and the slicer's `sliceMesh`):

- trunkTipMm 1e-6 .. 1000, trunkAngleDeg 1e-6 .. 89, nodeMm 0.01 .. 1000,
  leanDeg 0.01 .. 89.9: planned and built, every shell closed (`openEdges`),
  on the coupon (the arc for the wider ones). The weld and the slicer were
  run on: coupon tip 1.2, tip 0.3 + angle 0, tip 0.05 + angle 0.1, lean 15,
  lean 0.5, node 1, node 0.1, and all of 1.2 / 3 / 30; arc tip 1.2 + angle 3,
  tip 0.3 + angle 0, lean 15, node 2. Each: one welded solid, no open chain in
  any slice layer of the shells or the weld. A thin trunk (under the 1.2 mm
  column at its top) is simply inside the column there; below, the law widens
  it past the column.
- leanDeg 0.5 / 0.01: a tower to every tip (49 trunks on the coupon); 5 of
  them find no room beside the piece and are not built. Reported
  (`problems[kind 'trunk']`).
- leanDeg > 90 (95): tan() is negative, the planner lets nothing lean (44
  trunks of 49 tips on the coupon) and the arc took 59 s; reported
  (`kind 'lean'`). 90 itself plans (tan 1.6e16) but is reported; 89.9 plans.
- trunkAngleDeg 90: tan() huge, every trunk narrowed to the room the piece
  leaves; reported (`kind 'angle'`). The arc takes 50 s at 60 and 89 deg.
- The tilted box leaves 146 of 216 trunks unbuilt ("no height under its
  tips") at the defaults. That is today's, so `problems` reports a trunk only
  when the default law builds it (a trunk-law knob) - with a lean/node knob the
  default plan is not known, so all unbuilt ones are reported and the text says so.

**The export name.** `supportKnobs` (= `plan.knobs.nonDefault`) on a 3MF
object: `supports trunk1.2 angle3`; inside the card's bracket when the name
ends in one: `<piece> - support 1.1 (Tree trunk1.2 angle3)`, so
`nso_slicer_audit.js`'s `/ - support \d+\.\d+ \(/` and the slice panel's
`supportLabel` still read it. The ticket's example had `lean30`; 30 is the
default lean, so it is not named (only values that differ are). The card
passing `plan.knobs.nonDefault` is the UI ticket's.

**Cost of `support:feed` (cut after review of #294).** Section 7 reuses the
coupon (`base`) and arc builds of sections 1-4b as its "no knobs" side, builds
each piece once at all-default knobs (arc, tilted box, coupon; the tilted box
also once with no knobs: it is in no earlier section) and reuses those builds
wherever a later check needs them. Knob values run on the coupon, except
trunkTipMm 1.2 which also runs on the arc (a stair's own trunks need it); all four
at once is the coupon with lattice 4 (it doubles as the nodeMm check). The
step is ~117 s here (sections 1-6 ~50 s; section 7 ~66 s, of which the four
default-knob builds are ~37 s: the tilted box is ~12 s each, in `parts()`),
weight 250000 -> 200000.

**One-off runs, not in the step** (plan + `parts({interface: true, foldSheets:
false})` + `shells`, `feed: { mode: 'assisted', knobs }`):

- arc, leanDeg 95: 59 s, 21 trunks, 48 trunk records (plan time reported `lean`);
  arc, trunkAngleDeg 60 and 89: 53 s each; arc, trunkAngleDeg 20: 38 s; the
  default arc is ~10 s. Every shell closed throughout.
- the tilted box leaves 146 of 216 trunks unbuilt at the defaults ("no height
  under its tips"). With trunkTipMm 6 it leaves 158, and `problems` reports
  exactly the 12 the default law builds (`12 of 216 trunk(s) not built that the
  default law builds`); trunkTipMm 1.2 and trunkAngleDeg 0 report none; leanDeg 20
  reports 48 of 78 with the "not compared with the default plan's" note.
- the coupon's law sweep (trunkTipMm 8 / 16 / 30, trunkAngleDeg 30 / 45, 12 mm
  at 20 deg) builds every trunk: the piece narrows a trunk, never fails one.
- the weld and the slicer runs listed above.

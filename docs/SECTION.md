# Section reader and the Scale card

`nso_section.js` (headless) reads what shape a piece is; `app-scale.js`'s card
puts that reading in print terms on its first line and offers only the verbs
that apply. Part 1 of 3: the ring verbs (outer / bore / wall) and the bar verbs
(width / depth) are the next two tickets, and Fatten / Shrink fold in there.

```
node tools/nso_section_test.js             headless: every fixture, its truth, three quarter turns
node tools/nso_scale_card_drive_check.js   the real app: Stock tube / box / sphere, tape_on-edge-single
node tools/nso_wire_scale_test.js          Whole x, Longest, Undo, refusals, paint
```

All three are in `npm test`.

## The reading

```
NSO_sectionRead(soup, opts) -> { shape: 'round' | 'rectangular' | 'other', hollow,
                                 axis, lengthMm, outer, bore, wallMm, reason, ... }
NSO_sectionReadout(reading) -> the card's first line, minus the fit verdict
```

Nothing in it is a second copy:

| what | whose code |
|---|---|
| the straight axis | `NSO_extendDetectAxis` — same scope, same refusals. `ambiguous` (a cube, a square bar) is taken with the longest tied axis, as `nso_stock.js`'s `proportionsFrom` already does; `axisTied` lists them |
| where the section is constant | `NSO_extendBands` — Extend's clean gaps, chained into runs that break at an unclean gap or at a layer carrying a face lying in it (a step) |
| the section | `rawCutOpen` → `rawPlaneBoundaryEdges` → `rawBuildLoopsFromCutEdges`, the Cut tool's walker, at mid-length |
| the nesting | `rawNestLoops`, pulled out of `rawFlatCapLoops` so the two read "a loop inside a loop" with one piece of code |

The gates run in order; the first that fails names the answer:

1. **A straight axis** — `no straight axis: 100% of the surface is curved or tapered` / `no straight axis: 31° oblique`.
2. **A constant section over ≥ 90% of the length** — `section is constant over only 26.0 of 52.0 mm along Z (50%) - the rest is shaped` (a capsule's barrel), or `section is not constant along X at mid-length - no clean straight band anywhere along it`.
3. **The loops** — one is solid, a loop inside a loop is hollow, else `section has 3 loops` / `section has 2 loops side by side`.
4. **The fit** — outer loop round or rectangular within tolerance; a bore the same class and, if round, concentric. Else `outer loop is 0.8 mm off round (tolerance 0.10 mm)`, `outer loop is round but the bore is ...`, `bore is 1.3 mm off centre`.

### Tolerances, stated

- **Round:** the whole loop, vertices and edges measured exactly per segment,
  inside an annulus `max(0.05 mm, 1% of r)` wide about the fitted centre. The
  centre is the least-squares (Kasa) fit; `r` is the circle the vertices sit
  on, because that is the circle a tessellator put them on — a revolved 96-gon
  of radius r has every vertex at r and its chords dip inside. 1% admits any
  regular tessellation of 23+ segments; the 0.05 mm floor is under a 0.4 mm
  nozzle's resolution. An 8-gon of r 10 is 0.761 mm off (its sagitta) and reads
  as an octagon.
- **Rectangular:** every point of the loop within `max(0.05 mm, 1% of the
  shorter side)` of its own axis-aligned bounding rectangle, exactly per segment
  (distance to the boundary is the min of four linear functions along a
  segment, so its maximum is at an end or a crossing).
- **Concentric:** a round bore's centre within the bore's own round tolerance.

A bar's section is reported wider side first (`widthMm ≥ depthMm`), so the
answer does not depend on which way the piece is turned; the test turns every
fixture 90° about X, Y and Z and requires the same shape, the same reason (axis
letter aside) and the same numbers to the bit.

## The card

First line: `Ring Ø… outer · Ø… bore · wall … · length …` (round hollow),
`Rod Ø… · length …` (round solid), `Bar W × D × L` (rectangular, `· bore … ·
wall …` if hollow), or `W × D × H · reason` for `other` — then ` · fits A1 Mini`
or ` · over by 5.0 mm on W` from `NSO_fitCheckAll`, the bed's axes named W / D
/ H.

| verb | what it calls |
|---|---|
| **Length** `[ ] mm` | `NSO_extendSelectedModel({ length })` — longer extends, shorter shortens, cross-section held. Shown only when there is a straight axis; prefilled with the real length. On a tied axis (a cube) the reading's axis is passed so Extend does not refuse it as ambiguous |
| **Whole ×** `[ ]` | `NSO_scaleSelectedModel({ factor })`, unchanged |
| **Longest** `[ ] mm` | `NSO_scaleSelectedModel({ axis: 'longest', targetMm })`, unchanged |
| **Fit to plate** | `min(limit / size)` over the bed's three axes, from the same `nso_printer.js` fit the plate warning uses, applied as a uniform factor and stated. Already fits: says so, changes nothing |

Removed: the X / Height / Z axis menu and the `X x H x Z` readout — they spoke
the display frame, where "Height" is right and "Z" is the bed's depth.
`NSO_scaleSolve` still takes a display axis underneath.

Paint scope is unchanged: Length is Extend's (whole-piece), Whole / Longest /
Fit to plate are Scale's (whole-piece). Both are in the HANDOFF roster.

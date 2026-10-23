## Seat anywhere on a flat target - the axis chooser's tie-break was a direction (2026-09-20)
`app-join.js` `NSO_plugFrame` (the reach filter, plus `NSO_seatRayReaches` /
`NSO_seatFaceReaches`), and the two read-back `NSO_plugFrame` calls inside
`NSO_seatFlushBitToHull` that were made without the hull soup. Check:
`npm run seat:box-on-box` (`tools/nso_seat_box_on_box_test.js`, in `npm test`).

**The report.** "Seat (support) fails with `corner 0 missed hull along punch
axis` on a deliberately simple, confirmed-flat box target - reproduced with a
box bit and with a crosshatch washer patch, always at corner 0 regardless of
bit shape. A consistent single-corner failure across varied geometry suggests a
regression from today's placement-touching merges."

**Every part of that was observed and none of it meant what it looked like.**
- **Not the corner.** The fit returns on the FIRST corner whose ray misses and
  corner 0 is the first one tested, so "always corner 0" carries no information
  at all. When the axis is wrong all four miss; corner 0 is just the one that
  reports. The regression test's negative control shows corner 0 for two
  different bit shapes for exactly this reason.
- **Not the bit.** The axis is chosen before the bit's shape is consulted.
- **Not a regression.** Measured on the identical case against `2a6d07a`
  (2026-09-15) - five days and both named merges earlier - and against
  `e28d244`, `d3ad2a8`, `0311ae9` (the commit before
  `Merge branch 'claude/integration-stress'`) and `d79bd34` (before
  `Merge claude/stock-live-edit`): the same offsets fail at every one of them,
  identically, with the same message and the same punch axis. `NSO_plugFrame`
  is byte-identical from 2026-09-15 to HEAD. A real, previously-uncaught
  limitation, uncaught because every seat suite until now put the bit over the
  MIDDLE of its target.
- **Audit of the three named suspects, all clear.** `getActiveModel`
  (`app-cut.js`) is not on the seat path at all - `seatSupportBitToHull`,
  `seatBitAtGap` and `NSO_seatFlushBitToHull` read `state.editId` /
  `state.joinPartnerId` and find the placed entries by `sourceId` - and it was
  last touched 2026-09-16, by neither merge. The integration-stress clone work
  changed `cloneSelectedModel` (raw soup carried to the clone, selection moved
  through `selectPlaced`) and `NSO_unionSoups`' component-count gate; neither
  reads a pose or builds a frame. `NSO_sculptCommitRaw` does rebuild a placed
  mesh and put the pose back, but only on a bake commit, and the failing case
  is load -> drag -> seat with no bake in it. `app-cut.js` and `app-sculpt.js`
  are untouched by both merges.

**The actual cause - the tie-break was doing the deciding.** `NSO_plugFrame`
ranks the six candidate faces by what a step out of and into each one meets:
out of the hull and into it is a real seat axis (2), out of it only is a bit
standing clear (1), into it is the wrong way round (-1). `outward` - hull bbox
centre to bit centre - was only ever meant to break a tie within a rank, and it
is scaled by 0.01 to say so. But a bit standing CLEAR of the target puts all
six candidates on rank 1, because nothing steps into a hull the bit is nowhere
near - and that is not an exotic pose, it is the pose the seat deliberately
creates: `NSO_raiseBuriedBitClear` lifts a dragged bit `NSO_SEAT_CLEARANCE`
(5 mm) above the target's top before every seat. So the whole decision fell to
a centroid vector, which leans sideways the moment the bit is further ACROSS
the target than it is ABOVE it. On `library/box_hull_80x40x20.stl` with
`library/box_bit_12x8x8.stl` that crossover is 19 mm: staged 5 mm clear the
bit's centre sits 19 mm above the hull's, so past 19 mm off centre `outward`
leans `+X`, the chooser calls the bit's `+X` face the outer face, and the fit
punches horizontally through open air ~13 mm above the target. Measured through
the real app, 1 mm at a time: `x <= 18` seats, `x >= 19` refuses, all the way
out to the edge. **Over half of that target's top face could not be seated, by
either Seat button, with any bit.** Along Z the same target is only 20 deep, so
the offset never reaches 19 and the bug is invisible - which is why a suite
full of centred seats never saw it.

**Fix.**
- `NSO_plugFrame` keeps the three ranks exactly as they were and keeps
  `outward` as the tie-break. What changed is that when more than one candidate
  shares the top rank, each of them is first asked the question the fit is
  about to ask: can the corner rays off this face find the hull at all?
  `NSO_seatFaceReaches` builds that face's four corners and insets them through
  `NSO_seatRayOrigins`, exactly as the fit does, and casts along that
  candidate's punch. Faces whose rays all land stay in; faces whose rays fly off
  into space are dropped, and `outward` breaks whatever tie is left. Ranks are
  untouched, the reach test only ever runs on a tie, and it can only change the
  answer where the losing face is one the fit would have refused.
- `NSO_seatRayReaches(soup, o, dir)` is `NSO_nearestSkinHit`'s existence
  question with an early exit - the axis chooser needs to know whether a face
  can see the hull, not where - so the common case costs about half a soup scan
  rather than two.
- **Second defect, same root, found while fixing the first.** The residual
  read-back (`var frameF = NSO_plugFrame(bitMesh, hullCenter)`) and the tips
  path's `frR` were built WITHOUT the hull soup. With no hull to probe,
  `NSO_plugFrame` falls all the way back to the bare centroid rule - the rule
  the fit had just stopped trusting - so off centre the report measured a
  different face than the seat had worked off. All four rays missed, which
  reads as `cornerResidual` all NaN, `maxResidual` left at its initial 0 and
  `gapAchieved` NaN; `seatBitAtGap` then falls back to the gap that was ASKED
  for and prints it as the one it MEASURED, with "skin error 0.00mm". Measured
  at `x = 25` and `x = 34`: status line `Seated - air gap 0.18mm (measured
  -0.180mm, skin error 0.00mm)` on a seat where nothing was measured at all. A
  wrong seat and a right one read identically. Both calls now take `hullSoup`,
  so the read-back and the fit ask one question of one hull.

**Validation** (`tools/nso_seat_box_on_box_test.js`, the real library browser,
the real Join slots, the app's own `nudgeSelected` drag). The two simplest
library pieces, nothing staged by hand and nothing posed. Seat (support) at the
slider's untouched -0.18 default over eight offsets spanning the whole top face
(centre, the last one that used to work, the first that did not, and flush with
the `+X` edge): the same clean status line at every one, underside 0.18 mm above
the target top to 2e-6, XZ and the quaternion untouched, punch `-Y` at each,
Undo exact. Seat flush over five of them holds the golden plug relation (outer
face 0.01 proud, the 8 mm bit 7.99 below the target's top). `gapAchieved` is
held against the true world-box gap at three offsets, and all four corner
residuals are real numbers. The crosshatch washer patch - a 30 x 30 non-solid
lattice - seats over the same offsets, because the report said any bit and the
fix has to be shape-blind too. **Negative control:** with `NSO_seatFaceReaches`
stubbed to `true` in the page, the original failure comes back word for word at
corner 0 for both bits at every offset that used to fail, the refused seat moves
nothing, and switching it back on makes the very same click seat. `npm test`
unchanged otherwise - `seat:gap`, `seat:align`, `seat:overhang`, `seat:side`,
`seat:surface` and `seat:curved-audit` all hold their golden poses and counts.

**`?v=` NOT bumped** - rule 4, Grok owns those. `app-join.js` still ships at
`?v=libsave1`, so a browser holding the old copy keeps the old chooser until
the next bump; nothing in `index.html`, the CSS or the markup changed, so there
is no half-loaded state to land in.

**Known limits, stated not solved.**
- A bit that overhangs the target face still refuses, and a bit the face cuts
  through is still refused by name (`NSO_seatStraddle`). The reach filter picks
  a better face; it does not rescue a pose that has no good face.
- A bit still BURIED in the target keeps the old answer - all six ranks are not
  tied there, `+X` wins on rank, and the nearest way out really is sideways.
  Pinned as its own gate so a later "simplification" cannot quietly flatten the
  two cases together.
- The seat still samples the hull at four points; a hull feature between them is
  invisible to the fit. That is the corner-ray fit's own assumption, unchanged.
- The reach test costs up to 24 ray casts per `NSO_plugFrame` call, and only on
  a top-rank tie. On a plug straddling a face (rank 2, usually one candidate) it
  costs nothing.

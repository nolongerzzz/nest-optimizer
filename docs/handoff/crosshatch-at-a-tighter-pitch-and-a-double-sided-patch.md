## Crosshatch at a tighter pitch, and a double-sided patch (2026-09-18)
`nso_skin.js` (a `family` field on every `PATTERNS` entry, the `crosshatch-fine`
preset, `familyOf` exported, `crosshatchPlan` now publishes its rib intervals),
`nso_skin_patch.js` (the `sandwich` variant; every dispatch moved from the
pattern NAME to its family), `index.html` (the preset in two selects, the
variant in a third), `app-library.js` (ten patch rows in `CATALOG`),
`library/patch_*.stl` (ten files), `fixtures/skin-fine/skin-fine.json`,
`docs/SKIN-CROSSHATCH-PITCH.md`. Checks: `npm run skin:fine`
(`tools/nso_skin_fine_test.js`), `npm run skin:fine-fixtures`,
`npm run skin:fine-drive` (`tools/nso_skin_fine_drive_check.js`, every catalog
row through the real Library UI). All three are in `npm test`.

**The audit first (Task 1), and it has two halves.** `pitch` was ALREADY a
parameter - `PATTERNS.crosshatch.defaults.pitch`, merged by `withDefaults`,
read by `crosshatchPlan` into `ribIntervals`. Nothing was hardcoded, and
`buildPatch({ params: { pitch: 0.84 } })` has always worked. **But it could not
be reached from the app**: `#skin-pattern` is a name-only select and no caller
in `app-skin.js` or `app-skin-patch.js` has ever passed `params`, so from the
app's seat 1.2 was the only pitch there was. The gap was REACHABILITY, not
parameterisation, which is why a named preset is the whole fix.

**The canonical checker cannot answer the printability question, and that is
worth knowing before the next person trusts a green run.** `mesh_validate.py`'s
wall check rays along the INWARD normal, into the material, so on a rib's side
wall it measures the rib and stops - the open channel to the next rib is on the
other side of that face and no ray goes there. Measured: a crosshatch at 0.5 mm
pitch, whose channel is **0.08 mm**, passes `--gate --non-solid` cleanly and
reports a 0.4200 mm wall. The checker is not wrong; it measures walls, and the
walls really are 0.42. It simply does not measure this.

Reversing every triangle's winding flips each normal, so the SAME unmodified
algorithm rays outward and measures the air instead. Done that way the channel
comes back as exactly `pitch - rib` at every pitch, which is both the answer and
the proof the technique is sound. `tools/nso_skin_fine_test.js` asserts the
blind spot as a gate so nobody re-derives it.

**The answer, in the repo's own figures.** One extrusion line is
`nso_thickness.floorFor(nozzle)` = nozzle x 1.05, the figure that already turns
a 0.4 nozzle into the 0.42 mm rib. Tightest pitch with a full line of air is
`rib + line`: **0.84 mm at a 0.4 nozzle, 1.05 mm at a 0.6 nozzle**.

- The asked-for **0.5-0.6 mm pitch is past a real limit**, not merely tight: it
  leaves 0.08-0.18 mm of air, 5.3x to 2.3x narrower than one 0.4-nozzle line. A
  slicer gap-fills that and the lattice comes out a solid plate. Not forced.
- `crosshatch-fine` is **0.84 mm**, the 0.4-nozzle floor - 1.43x the ribs per
  axis, not the ~2.4x a 0.5 pitch implies.
- **0.84 is 0.4-nozzle only.** At a 0.6 nozzle one line is 0.63, so a 0.42 mm
  channel fuses; worse, the 0.42 mm rib is itself under one 0.6-nozzle line.
  **The shipped 1.2 mm default is essentially the 0.6-nozzle floor already**,
  which is why it stays the default and the tighter pitch is opt-in.
- On the Bambu measurement that started this: 0.61 mm rib at "0.5 mm spacing"
  cannot be a 0.5 mm PITCH - the rib would be wider than the pitch and the
  lines would overlap into a sheet. So 0.5 is the GAP, Bambu's pitch is 1.11 mm
  against NSO's 1.2, and the real difference is the channel (0.5 vs 0.78).
  Matching Bambu's channel at a 0.42 rib is a 0.92 mm pitch; the preset's 0.84
  goes past it. The density gap closes on the gap reading; the literal
  pitch-to-pitch target does not exist.

**A preset, not a second builder.** `PATTERNS` entries carry `family`, every
dispatch downstream switches on the family rather than the name, and the
preset's output is asserted BIT-IDENTICAL to `crosshatch` at
`params: { pitch: 0.84 }`. All seven committed skin and patch fixtures
regenerate byte-identically; the skin, wrap and patch suites are untouched.

**`sandwich`, and why `bordered` is the wrong piece for a sandwich test.**
`bordered` is a closed tray - a solid 0.6 mm floor with the relief on ONE side.
Between two cubes only the top one meets rib tips; the bottom meets a flat
30 x 30 mm plate and welds on contact area alone whatever the pattern does.
`bordered` is unchanged and stays exactly what it is; `sandwich` is the
two-sided piece, and it is two-sided BY CONSTRUCTION:

- **No floor.** Every cell is empty top-to-bottom or solid top-to-bottom, so
  the whole piece is one height field with a common base and `looseGrid` builds
  it unmodified. Asserted as volume = contact x height exactly - a membrane has
  nowhere to hide in a closed form.
- **Prismatic**, so the `z = 0` face and the `z = h` face are THE SAME SET. Both
  contacts measured off the mesh and asserted equal: 696.082 mm2 each.
- **A frame rib, not a rim.** A proud rim would hold the two cubes off the
  pattern entirely and measure itself; a flush rim would add ~138 mm2 of solid
  contact per face and swamp the lattice. The frame is one more rib at the
  pattern's own width, and it is WIDENED to meet the outermost rib because
  `ribIntervals` centres its ribs and the leftover (0.09 mm at 0.84 pitch on
  30 mm) would otherwise be an unprintable sliver channel.
- Prismatic is enforced, not assumed: `zigzag` tapers so its two faces differ,
  `ring` has no height field; both refused by name with that reason.

Measured, 30 x 30 x 0.6 mm, one closed component each: the 1.2 sandwich carries
24 ribs/axis and 578.16 mm2 per face, the 0.84 one 35 ribs/axis and
696.08 mm2. Both are in `library/`, so the A/B goes on one plate. Like `loose`,
a sandwich patch is advised **non-solid** and is closed as built, so the flag is
not what gets it through a check.

**The Library rows (Task 2 of the follow-up).** `app-library.js`'s `CATALOG` now
lists ten patches. Registering a name there is NOT the same as the tab loading
it, so `tools/nso_skin_fine_drive_check.js` CLICKS every row in the shipped list
and measures the piece that arrives - footprint, thickness and triangle count
against that file's OWN manifest, never a blanket 30 x 30 (the loose ring is
genuinely 10 x 10 and says so). The six `bordered`/`loose` files are byte-copies
of `fixtures/skin-patches/`, byte-checked on every `--check` run so the tab can
never drift from the gated fixtures.

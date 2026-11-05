## Build volume - does the piece fit the machine?
`nso_printer.js` (the per-printer profiles and the fit arithmetic, no deps,
Node and browser) + `app-fit.js` (the live watcher). Wired at `?v=wheel1`.
Full write-up: `docs/BUILD-VOLUME.md`.

Strictly "will this bounding box fit inside that machine". **Not** a
printability check: bridging, overhangs, wall thickness and severed
connections are separate, already-existing concerns, and a piece that fits and
cannot be printed produces no warning here. `tools/nso_printer_fit_test.js`
asserts that structurally - strip the comments and no code in `nso_printer.js`
mentions any of them, and it references no other NSO module at all.

Profiles are keyed to `app-core.js`'s `PLATES` ids one for one, so the plate
selector resolves straight into a profile. `PLATES` carries bed X/Y only; this
adds the **build height**, which is the axis the plate picker never modelled
and the one a thrown vessel runs out of first. Where one id covers several
machines the height is the LOWEST (`prusa` takes the MK3S's 210, not the MK4's
220): a warning that fires early on the taller machine is a warning, one that
stays silent on the shorter machine is a failed print. `custom` gained an
`#custom-h` field and `getCurrentPlate()` now returns `h`.

Two things a later ticket should read:
- **The live check is a poll, deliberately.** A bbox changes from a dozen
  places, and hooking all of them means every future tool has to remember to
  call it. `app-fit.js` runs one rAF loop over a cheap signature - plate id,
  custom fields, each model's three sizes - and recomputes only on a change.
  A tool that changes a piece's size gets the warning whether or not its
  author heard of the file. It is also why this is not an export-time gate.
- **Only the 90 degree turn is offered.** `rotatedFits` is exact in a line. An
  arbitrary-angle placement is out of scope and named: a 260 x 20 mm bar does
  fit diagonally on a 256 mm bed and this says it does not. Placement is
  `packModels()`; a piece that only fits on the diagonal deserves a human.

The real case it was built against is in `npm run fit` section 5: a 320 mm
floor vase actually thrown on the wheel, raised 30 mm at a time, whose BALL
still fits an A1 Mini and which trips the warning at stage 4 (180.278 mm, 0.278
over). The revolved solid is then put through the canonical checker and the
checker's own bbox asserted to give the same verdict. `npm run fit` (70
checks) and `npm run wire:wheel` sections 9-10 (the warning appearing
mid-throw and clearing when the plate changes, nobody pressing Export).

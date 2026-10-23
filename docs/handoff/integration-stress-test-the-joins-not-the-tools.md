## Integration stress test - the joins, not the tools (2026-09-19)
`tools/nso_integration_test.js` (73 checks, headless) and
`tools/nso_wire_integration_test.js` (40 checks, the real app). Both in
`npm test`. Full write-up: `docs/INTEGRATION.md`.

Five combinations run deliberately once the toolkit reached critical mass.
Three real bugs, all fixed with their own negative controls; two honest
refusals with poor wording, reported and left alone; one inconsistency that is
a decision rather than a defect.

**1. `NSO_unionSoups` counted shells instead of asking whether the pieces
merged.** Manifold's `decompose()` counts topologically disconnected
components, so a HOLLOWED piece is TWO of them - outer skin and cavity skin -
before anything is joined to it. Measured: the shell `nso_hollow.js` makes,
unioned with a cube 100 mm away it plainly does not touch, decomposes into 3.
The gate was `parts === 1`, so a sound union of a hollow body with an arm came
back as 2 and was rejected with "the two pieces do not touch" - false: the
volume showed the overlap subtracted correctly and the result was closed. That
gate is on Join's kernel route AND Attach, so **Hollow and Join could never be
used together**, and neither suite could see it because each tool was right.
Now `merged = parts < partsA + partsB`, with the inputs' own counts measured
on the same manifolds through the same `NSO_manifoldStats`. Negative controls:
two solids a 0.4 mm kerf apart, a hollow shell and a faraway cube, and a cube
captive inside the cavity are all still refused. A caller wanting its own
opinion gets `partsA` / `partsB` back.

**2. Clone dropped `rawTris`.** `cloneSelectedModel` handed `addModel` the
display geometry alone, so every clone arrived with `rawTris: null` and every
raw tool refused it by name. `src.rawTris` was in hand the whole time. Now
passed through, COPIED not shared - two models on one buffer is an aliasing
bug waiting for the first tool that writes in place. Negative controls: baking
the clone leaves the original byte-identical, and a clone of a piece that
legitimately has no soup still has none and is still refused by name.

**3. Clone split the selection in two.** It ended with `state.editId =
newIds[0]` written behind `selectPlaced`'s back, so `editId` /
`getActiveModel()` / the Edit card followed the CLONE while
`state.selectedIndex` and the red outline stayed on the ORIGINAL. Click-driven
tools were immune because a click goes through `selectPlaced`; button-driven
ones were not, which is why it hid. Now `selectPlaced(index)` moves both. The
ticket's question - does clone-then-immediately-use-a-tool provoke it more
reliably than the manual discovery - is answered yes: five tools out of five,
every time, no timing involved.

Three things a later ticket should read before touching this:
- **A void is a component, and chi = 4 is a correct hollow solid.** Any new
  gate that counts parts has to ask about the DROP, not the count. The Pottery
  Wheel's Open makes an open-topped pocket, which is chi = 2 and one shell,
  which is exactly why finding 1 never reached the wheel.
- **Two honest refusals have messages that do not help, and both are left
  alone on purpose** (wording gaps, not bugs). Extend across an assembly's
  cross axis says "float32 shift collapsed 1 of 28 distinct layers onto each
  other" - correct (a 48-gon arm puts layers a float32 ulp apart) but it names
  an internal concept and hides that the amount matters: +0.5 mm succeeds,
  +1 mm does not. Smooth on a hollowed piece says "volume flipped sign" -
  correct (the cavity smooths out through the skin) and silent about the
  cavity. Whoever owns those messages should know the tessellated cases make
  them common rather than rare.
- **Clone selects the clone; Extract selection selects the source.** Opposite
  choices, both defensible, neither a bug. What matters is that each tool's two
  halves of "selected" AGREE, which is now asserted for both. A new tool that
  adds a piece should pick deliberately and say which it picked.

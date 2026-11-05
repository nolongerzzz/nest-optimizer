## Fittings: a slip-on Cap for a tube, and 2- / 3-way Splitters as pieces of their own (2026-11-04)

New: `nso_fittings.js` (headless), `app-fittings.js` (the card), `tools/nso_fittings_test.js` (`fittings`, 114 checks), `tools/nso_fittings_drive_check.js` (`fittings:drive`),
`docs/FITTINGS.md`. Changed: `index.html` (Gen+ > Fittings, two script tags), `styles.css` not touched (the card borrows `vp-wheel-menu` / `vp-wheel`), `package.json`, `tools/test-weights.json`.

**What you get.** Gen+ > Fittings. **Cap for selected tube**: a cup for the tube's open end - bore = Ø + 2 x Fit (0.25), walls AND closed end = the tube's own wall, Deep 0.75 x Ø
(8 to 30), closed end down. **2-way / 3-way**: a trunk into 2 or 3 branches, built with the app's Manifold kernel as hub-and-spoke (cylinders + a sphere at the junction, minus the
bores). Both are NEW pieces - with nothing selected a splitter lands on its own. "Ø from tube" copies a tube's Ø and wall into the splitter's fields.

**Worth knowing.** The cap is laid out on the apothem (flats clear the tube by the Fit, not corners). The splitter's gates are the kernel's own: one body, genus = openings - 1.
The Euler number in the tests is 4 - 2 x openings. The cap reads the tube with Tube edge's reader and refuses a flared/tapered end. Plain ends only (no socket/spigot yet).
Test harness note: Manifold takes vector arguments only from its own JS realm, so `nso_fittings_test.js` loads the modules with `vm.runInThisContext`, not a separate vm context.

PAINT SCOPE: NONE.

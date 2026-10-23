## Shells as pieces - a shell that pierces another is a solid of its own
*2026-10-23, PR #279.* Full write-up: `docs/SHELLS-AS-PIECES.md` (readings, decisions); Lift's part is `docs/LIFT.md` section 9; the Findings row is in `docs/FINDINGS.md`.

**The rule.** A closed shell that *crosses* another, or stands *free* of the rest, is a part; a closed shell wholly *inside* another with no crossing is a cavity of it. box_closed (tray and lid, 74 piercing pairs) and a vase with its handle shell are two solids, not one broken surface.

**Where it lives.**
- `nso_shells.js` (new, `window.NSO_Shells`, also a Node module, loadable in a worker): `shells(soup)` -> per shell `crosses`, `insideOf`, `closed`, `part / free / clear / liftable`, plus `owned` for the piece; `cutShells` (moved from `nso_split_parts.js`, unchanged); `overlaps(items)` for pieces on a plate. **`NSO_Repair.js` is not edited** - 213 of 262 suite steps reach it. The classifier repeats its `pairCrosses` reading and `shells:test` holds both to 10 crossing pairs on box_closed.
- `nso_split_parts.js`: a shell another crosses is a part whatever its winding; otherwise hash-identical to before on eleven fixtures.
- `app-lift-plate.js`: when `owned` (two or more parts, every one crossing another or *clear* - its box meets no other body's), Lift runs no height map: "N shells found", hover outlines the whole shell, a click lifts it. No cut; both pieces land where they stood (the leftover is re-landed, Undo restores its pose); the leftover is read on the next hover. Interleaved parts (the hinge) and one-shell pieces lift as before.
- `nso-findings.js` / `app-findings.js`: SPLIT SHELLS beside MERGE SHELLS on the overlapping-shells row (`manual: true`, Fix all never runs it); it calls Split to parts' own split, the card follows the first piece and says per piece that the finding is gone.
- `app-export-overlap.js` (new) + two lines in `app-core.js`: the export status gains ` - these pieces overlap; Join before printing: A + B` (STL and 3MF); the file is still written.

**Things that changed under existing gates.** `lift:assembly` section 9 (a plate with a cube floating clear above it) used to say "0 features, can't be lifted"; it now reads "2 shells found" and the cube lifts whole. `repair:loop` section 9: the pierce row has two items. `tools/nso_lift_plate_drive_lib.js` `armOn` also waits for "shells found".

**Gates.** `npm run shells:test` (53, node) and `npm run shells:drive` (50, real app; screenshots to `tools/shells-out/`, git-ignored). The vase section runs on a generated stand-in (`tools/nso_shells_fixtures.js`); it also runs on the user's own file when it is at `tools/fixtures-local/vase.stl|vase.3mf|boolean-vase.3mf` or `NSO_SHELLS_VASE`, else it prints SKIPPED.

**Timings (generated 377k-triangle vase, in page).** The arm as it was 1496 ms; shells arm 287 ms + lift 450 ms = 737 ms. Classifying 1.52 M triangles takes ~1.0 s in Node.

**Not done / open.** The real vase has not been measured. SPLIT SHELLS shows only where MERGE SHELLS does (no open or pinched edges). A shell wholly inside another keeps `cavityShells`' reading for Split (an outward-wound captive ball is still a part).

## Classic: Studio's Gap infill, measured on the walls tester and the thin board (2026-11-20)

Changed:
- `nso_slicer.js`:
  - `perimeters()`:
    - an inner loop that would lie on itself is dropped (`GAP_LOOP_MIN`);
    - infill only where one infill line fits;
    - `gaps`: the strip no loop or infill covers.
  - `gapPaths()` draws each strip as variable-width centrelines, feature `Gap infill`.
  - `variableRuns` takes a floor.
  - Option `gapFill` (on), off for supports and brims.
- `tools/nso_slicer_arachne_reference.js` and `fixtures/slicer-arachne-reference.json`: the same pieces' Classic walls and
  gap, from Studio's two Classic slices.
- `tools/nso_slicer_test.js`:
  - "Classic, measured" (4 checks);
  - the two "without Detect thin wall nothing is drawn" checks now expect one Gap infill line, as Studio prints the
    thin board's 0.4 mm bar;
  - eight pinned slices re-pinned, each change gap infill (the box, cylinder and clip unchanged).
- Docs: `docs/SLICER.md` "Gap infill".

**Result:**
- Every piece Studio gap-fills now has NSO's gap infill too, within 3 % of Studio's plastic (worst 1.4 %).
- Whole-print gap infill: 7,472 against Studio's 7,482 on the tester, 4,343 against 4,113 on the board.
- Pieces within 5 %: 13 of 16 on the tester (was 8), 44 of 50 on the board (was 42).

**Not done:** Detect thin wall's own widths (Studio: a thin feature is one wall its own thickness + the bead overlap;
NSO: the bead's fixed width) and Studio's narrowed outer loop on a 0.4–0.6 mm bar with it off. Those are the remaining
off pieces.

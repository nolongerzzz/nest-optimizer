# The plate score

`tools/nso_support_score.js` generates the six pieces of `fixtures/supports/supp_ref.3mf`, slices them here, and scores each against
Bambu Studio's own slice of the same file by the diff G-scope's Compare > Measure reads (`nso-gscope-diff.js`). One table, so a change that
mends one piece shows what it did to the others.

    NSO_SCORE_REF=supp_ref.gcode.3mf npm run support:score          # against tools/support-score-baseline.json
    NSO_SCORE_REF=... node tools/nso_support_score.js --json out.json --piece Oblique

The two are put in one frame by the centre of the part's outer wall. Columns:

- **foot IoU** - the interface + transition drawn 1.6 mm wide (lines 0.46 apart are one sheet), material both have over both-or-either. 1.0 = the
  same ground. The plate is what touches the model and has to break away, so this is the one to raise.
- **line IoU** - the same with the lines at their own width: harsh, a different zig-zag in the same ribbon scores low. Watch it, do not chase it.
- **len** - our line length over theirs. **mv/mm** - our moves per mm of line over theirs (high = lines chopped into short moves).
- **z0** - the first plate layer, ours / theirs. **tree IoU / tree len** - the same for the Support tree.

Baseline (the build of 2026-10-30, Dense, 30 deg): foot IoU 0.37 - 0.51 on all six; the plate starts 0.30 mm late on all six (8.00 / 7.69,
14.00 / 13.70 ...); the Oblique's moves are 3.8 x shorter than Bambu's (its walls are cut into 2-point pieces, Overhang wall / Outer wall by turns,
where a stair's slotted section is traced); the tree matches least (IoU 0.09 - 0.15).

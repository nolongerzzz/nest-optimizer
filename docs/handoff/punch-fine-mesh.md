## Punch - a fine mesh: 10,000 holes, Stagger, Trim at edge, Fill face (2026-11-08)

Asked for: filter sheets, funnels and baskets as fine as prints; Punch stopped at 400 holes.
Write-up: `docs/PUNCH.md` (A fine mesh). Files: `nso_punch.js`, `app-punch.js`, `index.html`,
`tools/nso_punch_test.js` (part 9), `tools/nso_punch_drive_check.js` (9c).

- **The cap was the limit, not the engine.** 400 -> 10,000 holes, 100 -> 200 rows / cols / n. Measured on a
  1.2 mm sheet, Ø1 at 1.8: 2,500 holes 3.6 s of boolean, 10,000 holes 31 s (node, one thread; the watchdog is 120 s).
- **The O(N^2) wall check is gone**: sweep and prune (`nearPairs`) picks the pairs worth measuring; 10,000 holes
  plan in 67 ms (was 1.4 s). Gate 9e checks it finds every pair brute force does.
- **A wall AT the floor passes** (0.0001 mm slack): Ø1 at pitch 1.8 used to read "0.80 mm between them; the floor is 0.8".
- **`stagger`** (hex), **`edge: 'drop'`** (holes too near the edge left out, not a refusal), **`extent(soup, hit)`** (Fill).
- **Ghost merged**: one mesh for every cutter, rings batched by colour. `nsoPunchState().ghosts` / `.dropped` are
  now summed from `userData.punchHoles` / `.punchDropped` counts, not counted children.
- **Overlapping cutters** (through holes across a bore) are no longer unioned one by one (N booleans):
  `cutterGroups` colours them into overlap-free sets, subtracted in turn - usually 2-4 booleans.
- Not done: a pattern that wraps round a cylinder / cone (one punch covers the side facing the click).

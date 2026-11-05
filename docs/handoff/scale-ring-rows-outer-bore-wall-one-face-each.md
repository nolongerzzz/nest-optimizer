## Scale ring rows - Outer Ø · Bore Ø · Wall, one face each (2026-10-20)

`nso_ring.js` (Outer Ø holds the bore; the outer-onto-bore refusal; the done
line), `nso_section.js` (`verbs.bore`), `app-scale.js` (the Bore Ø field),
`index.html` (the Bore Ø row, the Outer Ø tooltip, holds). Checks:
`ring:drive` §4 and §9 (the pipe gate, on a Stock tube; it no longer needs the
Library for §7 and §9), `ring:test` §8 and §9, and the row lists in
`scale:card`, `scale:inches`, `stock:shelf`, `box:test`. `?v=ringidod1` on
`nso_section.js`, `nso_ring.js` and `app-scale.js`. Write-up: "Ring verbs" in
`docs/SECTION.md`.

PAINT SCOPE: unchanged, **WHOLE-PIECE** (the Scale card's).

- **Each row moves one face.** Outer Ø the outside (bore kept), Bore Ø the bore
  (outer kept), Wall the bore by thickness (outer kept); the length is held by
  all three. The done line reports the three numbers after the move:
  `Outer Ø done - Ø44.0 / bore Ø30.0 · wall 7.0 · height held`.
- **Outer Ø's old move** (the bore with it, wall kept) is Offset's, and the
  Outer Ø tooltip says so. Offset is still not shown on a ring: on a ring it
  moves the ends too (length 8.0 → 7.8 at −0.1), so Outer Ø then Bore Ø is the
  same move with the length held.
- **Refusals in mm**, each from the face that moved: `wall would be 0.3 mm,
  under the 0.42 mm floor`; `outer would reach the bore - Ø37 outer against a
  Ø38 bore`; `bore would reach the outer - Ø45 bore against a Ø44 outer`.
- **A shaped tube** (Flare, Run, Neck) reads as not round, so no ring row shows
  and the engine refuses in the reader's words - unchanged, now pinned.

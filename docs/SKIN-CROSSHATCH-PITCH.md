# Crosshatch pitch: how tight it can actually go

Everything here is measured with the repo's own tools on the repo's own
figures. `tools/nso_skin_fine_test.js` holds every number as a gate.

## 1. The audit (asked first, answered before anything changed)

**`pitch` was already a parameter. Nothing was hardcoded.**

`nso_skin.js` has carried it as a named default since the crosshatch shipped:

```js
crosshatch: {
  defaults: { pitch: 1.2, rib: 0.42, height: 0.6, margin: null },
  ...
}
```

`withDefaults(name, params)` merges a caller's `params` over that, and
`crosshatchPlan` reads `p.pitch` straight into `ribIntervals(L, rib, pitch,
margin)`. `NSO_SkinPatch.buildPatch({ pattern: 'crosshatch', params: { pitch:
0.84 } })` has always worked.

**But it could not be reached from the app**, and that is the real finding.
`index.html`'s `#skin-pattern` is a name-only `<select>`, and no caller —
`app-skin.js`'s face/wrap buttons, `app-skin-patch.js`'s patch button — has
ever passed `params`. From the app's seat 1.2 was the only pitch there was.

So the gap was reachability, not parameterisation, and a **named preset** is
the smallest thing that closes it: it arrives through the select every Skin
control already reads, and the validated 1.2 default is untouched.

## 2. The canonical checker cannot answer the printability question

This matters more than the preset, and it is worth stating plainly because a
green check here would otherwise be read as evidence it is not.

`mesh_validate.py`'s wall/gap check casts a ray from each triangle's centroid
**along the inward normal** — into the material. On a rib's side wall that
measures the rib's own width and stops. The open channel to the *next* rib is
on the other side of that face, and no ray goes there.

Measured, on the loose crosshatch, at rib 0.42:

| pitch | channel (pitch − rib) | `--gate --non-solid` | wall it reports |
|------:|----------------------:|----------------------|-----------------|
| 1.20  | 0.78 | PASS | 0.4200 |
| 0.84  | 0.42 | PASS | 0.4200 |
| 0.60  | 0.18 | PASS | 0.4200 |
| 0.50  | 0.08 | **PASS** | 0.4200 |

A 0.08 mm channel passes the canonical checker cleanly. The checker is not
wrong — it measures walls, and the walls really are 0.42 — it simply does not
measure this.

**The fix, without patching the checker.** Reverse every triangle's winding
and each normal flips, so the same unmodified algorithm rays outward: off a
rib's side wall, across the gap, onto the facing rib. Measured that way the
channel comes back as exactly `pitch − rib` at every pitch, which is both the
answer and the confirmation that the technique is sound.
`tools/nso_skin_fine_test.js` does this, and asserts the canonical check's
blind spot as a gate so nobody re-derives it.

## 3. What the two nozzles in use can actually print

One extrusion line is `nso_thickness.floorFor(nozzle)` = `nozzle × 1.05` —
the repo's own figure, the one that turns a 0.4 nozzle into the 0.42 mm rib
the crosshatch is already built from.

| nozzle | one line | tightest pitch with a full line of air (`rib + line`) |
|-------:|---------:|------------------------------------------------------:|
| 0.4 mm | 0.42 mm  | **0.84 mm** |
| 0.6 mm | 0.63 mm  | **1.05 mm** |

Against the target that was asked for:

| pitch | channel | vs a 0.4 line | vs a 0.6 line |
|------:|--------:|--------------:|--------------:|
| 1.20 (shipped default) | 0.78 | 1.86× | 1.24× |
| 1.05 | 0.63 | 1.50× | 1.00× |
| 0.92 | 0.50 | 1.19× | 0.79× |
| **0.84 (the preset)** | **0.42** | **1.00×** | 0.67× |
| 0.70 | 0.28 | 0.67× | 0.44× |
| 0.60 (asked) | 0.18 | **0.43×** | 0.29× |
| 0.50 (asked) | 0.08 | **0.19×** | 0.13× |

**The 0.5–0.6 mm pitch target is past a real limit, not merely tight.** At
0.5 mm pitch the channel is 0.08 mm — 5.3× narrower than one 0.4-nozzle
extrusion line. A slicer does not print that as a lattice; it gap-fills it and
the crosshatch comes out a solid plate. At 0.6 mm pitch it is 0.18 mm, still
2.3× too tight. Neither is a tuning problem.

**0.84 mm is the floor at a 0.4 nozzle**, and that is what the preset is. It
is 1.43× the rib density per axis — not the ~2.4× a 0.5 mm pitch implies.

**0.84 is a 0.4-nozzle figure only.** At a 0.6 nozzle one line is 0.63, so a
0.42 mm channel is 0.67× a line and fuses. Worse, the 0.42 mm rib is itself
under one 0.6-nozzle line, so a 0.6 nozzle cannot lay the shipped crosshatch's
rib at its nominal width either. **The shipped 1.2 mm default is essentially
the 0.6-nozzle floor already** — which is why it stays the default and the
tighter pitch is an opt-in preset.

## 4. A note on the Bambu measurement this started from

The comparison that motivated this was "Bambu's interface is 0.61 mm rib at
0.5 mm spacing, against NSO's 1.2 mm pitch". Those two numbers cannot be
compared directly, and the internal arithmetic says which one is which:

- If 0.5 mm were the **pitch**, the 0.61 mm rib would be *wider than the
  pitch*. Neighbouring lines would overlap into a solid sheet — there would be
  no lattice to look at. So 0.5 mm must be the **gap**, i.e. the spacing
  *between* lines.
- Read that way Bambu's pitch is 0.61 + 0.5 = **1.11 mm**, against NSO's
  1.2 mm. Denser, but by about 8% — not the 2.4× a pitch-to-pitch reading
  suggests.
- What is genuinely different is the **channel**: Bambu leaves 0.5 mm of air,
  NSO leaves 0.78 mm. Matching Bambu's channel at NSO's 0.42 rib would be a
  **0.92 mm** pitch.

The preset at 0.84 goes past that: a 0.42 mm channel is *tighter* than Bambu's
measured 0.5 mm. So on the gap reading the density gap is closed and then
some, while the literal 0.5–0.6 mm pitch target remains unreachable. Both
statements are in the table above; the fine-pitch preset is the first, and
nothing here forces the second.

## 5. What shipped

`crosshatch-fine` is a **preset**, not a second builder: `PATTERNS` entries
now carry a `family`, every dispatch downstream switches on the family rather
than the name, and the preset's output is asserted bit-identical to
`crosshatch` at `params: { pitch: 0.84 }`.

Pieces, all 30 × 30 mm (`SIZE`, the skin-sample face), in `library/` and
loadable from the Library tab:

| file | what it is |
|------|------------|
| `patch_crosshatch-fine_bordered.stl` | the comparison washer — the fine lattice in a solid rim |
| `patch_crosshatch-fine_loose.stl` | the fine lattice alone |
| `patch_crosshatch-fine_sandwich.stl` | double-sided, fine pitch |
| `patch_crosshatch_sandwich.stl` | double-sided at the shipped 1.2 pitch — the control |

Put the two `_sandwich` pieces, or the `_bordered` washer and a fresh slicer
auto-support sample, on one plate and the comparison is direct.

## 6. The `sandwich` variant, and why `bordered` is wrong for that test

`bordered` is a closed tray: a solid 0.6 mm floor membrane with the relief on
**one** side of it. Between two cubes only the top one meets rib tips; the
bottom meets a flat 30 × 30 mm plate, which welds on contact area alone
whatever the pattern does. The number that comes back is the floor's.

`bordered` is unchanged and stays exactly what it is. `sandwich` is the
two-sided piece, and it is two-sided by construction rather than by being
built twice:

- **No floor.** Every cell is empty top-to-bottom or solid top-to-bottom, so
  there is no membrane to weld against. Asserted as volume = contact × height
  exactly — a plate has nowhere to hide in a closed form.
- **Prismatic.** A crosshatch rib has a rectangular section, so the solid is a
  straight extrusion of the rib footprint and its `z = 0` face and `z = h`
  face are *the same set*. The two contacts are one number, measured off the
  mesh on both faces and asserted equal.
- **A frame rib, not a rim.** The perimeter closes with one more rib at the
  pattern's own width and height. A *proud* rim would hold the two cubes off
  the pattern entirely and measure itself; a rim flush with the tips would add
  ~138 mm² of solid contact per face on a 30 × 30 piece and swamp the lattice.
  A 0.42 mm frame rib adds what any other rib adds.
- **No sliver at the edge.** `ribIntervals` centres its ribs, so the leftover
  at each end is generally not zero — 0.09 mm at 0.84 pitch on 30 mm, which
  would be an unprintable channel between the frame and rib 1. The frame is
  widened to *meet* the first rib and reports the width it was actually built
  at.

Prismatic is enforced, not assumed: `zigzag` tapers from a 1.2 mm base to a
0.42 mm tip, so its underside is a wide flat base and its two faces are not
the same pattern; `ring` has no height field. Both are refused by name with
that reason rather than built lopsided.

Measured, 30 × 30 × 0.6 mm, one closed component each:

| piece | ribs/axis | contact per face | pattern / frame |
|-------|----------:|-----------------:|-----------------|
| `crosshatch` sandwich (1.2) | 24 | 578.16 mm² | 463.28 / 114.88 |
| `crosshatch-fine` sandwich (0.84) | 35 | 696.08 mm² | 635.92 / 60.16 |

Like `loose`, a sandwich patch is advised **non-solid** — it is a
free-standing one-extrusion-line lattice, the printable-fabric case
`docs/NON-SOLID.md` names, and the flag is what stands Repair's trimming
stages down. It is closed as built (0 open edges, 0 non-manifold, 0 piercing)
and passes `--gate` and `--gate --non-solid` alike, so the flag is not what
lets it through a check.

## 7. Checks

| command | what it gates |
|---------|---------------|
| `npm run skin:fine` | the whole of the above, including the channel measurement |
| `npm run skin:fine-fixtures` | the `library/` files are byte-identical to a fresh build, and to `fixtures/skin-patches/` for the six copied ones |
| `npm run skin:fine-drive` | every catalog row loads through the real Library UI, and the sandwich bakes through the real button |

All three are in `npm test`.

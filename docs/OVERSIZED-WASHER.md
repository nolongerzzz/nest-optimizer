# Oversized washer export mode

A deliberately close-contact washer or shim that is **wider than the piece it
sits on**, positioned by hand and exported as it stands. Center lock puts it in
XZ, a typed millimetre field says how far off the target it sits, and the status
line reports what was actually measured instead of refusing.

Off by default. With the checkbox clear, nothing in this feature runs and every
other seat, skin and export path is exactly what it was.

---

## 1. The audit: what actually blocked this

Written down first because two of the three things it was assumed to be turned
out not to exist.

### 1a. Nothing at export blocks. There was no export gate to relax.

Neither exporter looks at geometry.

| Route | Code | Every refusal it carries |
|---|---|---|
| Export plate STL | `exportSTLs()`, `app-core.js` | `Nothing to export - run Optimize first`; a `catch` around the STL writer |
| Export plate 3MF | `export3MF()`, `app-core.js` | the same empty-plate line; 3MF modules missing; a `catch` around the archive writer |

`buildCombinedGeometry()` merges the placed meshes and the bytes are written.
No distance check, no intersection check, no clearance check, no non-solid
check. Measured: a 30 x 30 sandwich washer hand-placed in hard contact with its
target — true minimum surface-to-surface distance `0.000` mm — exports from the
real button, and the two shells split out of the downloaded STL measure `0.0000`
apart. That is section 2 of `tools/nso_oversized_washer_test.js`.

**Piercing pairs and coplanar contact are not export checks.** Those numbers
come from `tools/mesh_validate.py` (a checker the *suites* run) and from the
Check-piece defect overlay (`app-defects.js`, `NSO_Repair`), which paints what
it finds on the mesh and changes nothing. Neither is wired to an export button.

### 1b. There is no Skin-pattern clearance warning that escalates to a block.

`NSO_Thickness.cutWarning()` ends its sentence with `- reported, not blocked`
and is documented as never a refusal. `nso_skin.js` and `nso_skin_patch.js`
report tip area, rib width and frame width as describe strings. The one refusal
in that family (`NSO_Thickness.strokeGate` / `strokeRefusal`) belongs to Carve
and the Brush and is never reached from a seat or an export.

### 1c. The one real block is the corner-ray fit's footprint limit.

`NSO_seatFlushBitToHull` (`app-join.js`) casts one ray from each corner of the
bit's outer face along the punch axis. A washer that overhangs its target has
corners standing over open air; the rays miss; the seat returns

```
Seat failed - corner 0 missed hull along punch axis
```

and moves nothing. Measured on a 30 x 30 `sandwich` skin patch over
`library/box_bit_12x8x8.stl` — 9 mm of overhang in X, 11 mm in Z — Seat (support)
refuses at **every** value the slider can express: `-0.25`, `-0.18`, `0`,
`+0.05`. Two neighbours on the same path are named for completeness, and both
are downgraded by this mode:

* `NSO_seatStraddle` — *"bit straddles that hull face"*, for a piece the target
  face cuts through;
* `NSO_SEAT_GAP_RESIDUAL_LIMIT` (0.25 mm) — *"the fit ended N mm off the M mm
  that was asked for"*.

### 1d. The positioning half of the premise was missing a control.

Center lock is exact: `app-center-lock.js` slides B in XZ until its reference
point sits on the target, and the delta lands on `placed.x` / `placed.z`
one-for-one. Nothing about it cares how big B is, so an overhanging washer is
centred as exactly as any other piece.

The **vertical** half had no numeric entry anywhere in the app. The only gap
control was the `#seat-gap` *range* input, clamped to `-0.25 .. +0.05` in 0.01
steps, and the only other vertical control was Move ▸ Vertical, which writes
`liftY` in 0.25 mm presses with no readout of the real gap. A deliberate
half-millimetre squeeze could not be **asked for**, let alone refused. This mode
adds that field.

---

## 2. What the mode does

A checkbox (`#chk-oversize-washer`) and a millimetre field (`#oversize-gap`) on
the Join card, under Seat here. With the checkbox set, **Seat (support)** stops
going through the corner-ray fit and instead:

1. takes the gap from the typed field, in the breakaway-coupon sign convention
   (`negative` = air gap, `0` = touching, `positive` = the washer overlaps into
   the target), range −5 … +5 mm;
2. aims straight down through the washer's own box centre onto the target —
   where Center lock has just put it — so no viewport click is needed;
3. places it through the shipped measured-clearance seat, `NSO_seatHereAt` →
   `NSO_SeatSurface.plan` with `center: false`. That solve has no corner rays
   and therefore no footprint limit, which is the whole reason the oversized
   case goes through it. Nothing in it is reimplemented or relaxed here, and
   `center: false` is what carries Center lock's XZ through untouched.

Seat flush, Seat here, Align, Skin, Subtract and both exporters are not routed.
With the checkbox clear the feature's only effect on the app is the single
`armed()` call `seatSupportBitToHull()` makes.

One consequence of reusing that path rather than copying it: a washer that is
not already facing the target gets **turned** onto it and baked into its own
axes, exactly as Seat here does and under Seat here's own paint guard. A washer
Center lock has just put flat on a flat top is the case this mode is for, and
there the turn is zero and nothing is baked — the suite pins the quaternion at
identity through every placement.

---

## 3. The report, and why it is a report

Modelled clause for clause on the nozzle-safety readout for a cut
(`cutClearanceFor` in `app-join.js`, `NSO_Thickness.cutWarning` in
`nso_thickness.js`):

* it is **measured before anything moves**, from the pose the user built, so it
  answers the question the placement is about to answer;
* **every failure path returns `null`** — a measurement that cannot be taken
  must not fail a placement that is otherwise sound;
* it is **appended to the status line and the placement is committed either
  way**, and it ends in the same four words: `- reported, not blocked`;
* the *finding* is printed only when there is one, exactly as `cutWarning()`
  returns `''` for a clean cut.

What is **always** printed is the measurement, because a mode whose point is
that it does not refuse has to be louder about what it measured, not quieter:

```
Oversized washer placed - air gap 0.18mm asked, true minimum 0.180mm
  - overhang 9.00mm X / 11.00mm Z
  - corner-ray fit would refuse here: 4 of 4 rays miss the target along the
    punch axis - reported, not blocked
```

`true minimum` is the real minimum surface-to-surface distance
(`NSO_SeatSurface.minDistance`, measured on the placed geometry after the move),
not a corner residual and not the number that was requested. At or past contact
it reads `0.000` and the line carries `N.NNNmm past first contact` instead,
which is the quantity that *is* the request there. The overhang is B's world box
against A's, per horizontal axis.

### What it still refuses

The mode relaxes the corner-ray fit's refusals, not the measurement's. Three
things still stop and say so, because there is no pose to place at:

* an empty or out-of-range gap field;
* nothing of the target under the washer's centre (Center lock it first);
* the measured-clearance solve failing to bracket the gap — its own wording.

---

## 4. Checks

`npm run seat:oversized` → `tools/nso_oversized_washer_test.js`, in the roster.
It drives the real app and pins, in order: the control is present and off; the
block is real and named; export never blocked; armed, the same click places at
`-1.5`, `-0.18`, `0` and `+0.30`; the reported true minimum equals
`tools/nso_soup_distance.js` computed **outside the page** to 1e-4; the overhang
and the corner-ray verdict match the scene and the shipped fit; Center lock's XZ
survives to 1e-9; the distance measured off the **downloaded STL** is the one
reported; misuse is loud and moves nothing; and with the mode off the Seat-gap
suite's golden flush pose, its status line and the golden `-0.18` gap seat all
hold byte for byte — as does Seat flush with the mode armed.

## 5. Files

| File | What it holds |
|---|---|
| `app-oversize-washer.js` | the whole mode: `armed`, `readGap`, `overhangOf`, `cornerRayVerdict`, `cornerRayWarning`, `aimPointUnderB`, `seat` |
| `app-join.js` | one guarded branch at the top of `seatSupportBitToHull()` |
| `index.html` | the checkbox, the mm field, the script tag |
| `styles.css` | `.oversize-row` |
| `tools/nso_oversized_washer_test.js` | the suite above |

# Fatten — grow or shrink the cross-section, hold the length

`app-fatten.js` · UI: a **Fatten** / mm / **Shrink** row in the Finish menu’s
Shape group, directly under the Thicken row · tests: `npm run fatten`,
`npm run wire:fatten`

---

## What it does, in one sentence

Fatten moves the walls of an axis-aligned straight piece in or out by the asked
offset and leaves the two ends exactly where they are. A 20 mm pin whose 3 mm
shaft is 0.5 mm too slim becomes a **20 mm** pin with a 4 mm shaft.

The two tools it sits between:

| | length | cross-section |
|---|---|---|
| **Scale to size** | scales | scales |
| **Extend** | changes, on purpose | held **bit for bit** |
| **Thicken out / in** | grows with everything else | grows |
| **Fatten** | held | changes, on purpose |

Fatten is Extend's mirror image, and is built from the same two pieces Extend
is built from.

---

## What it is NOT: it is a wrapper

**There is no offset arithmetic in `app-fatten.js`, and there must never be
any.** Two shipped, tested functions do all of the work and are *called*, not
copied:

```
NSO_extendDetectAxis   (app-extend.js)   which way is this piece straight?
_thickenOffsetSoup     (app-finish.js)   move this side of the skin by d
```

The whole of Fatten is the sentence that joins them:

1. Ask Extend's detector for the dominant axis `u`.
2. Mark every face whose normal is perpendicular to `u` — the walls.
3. Hand that mark to Thicken as the set it is allowed to move.
4. Grow is `d > 0`, shrink is `d < 0`.

Faces that are *not* parallel to `u` — the end caps, the end chamfers — become
**held** planes in Thicken's existing vertex solve. Holding them is the entire
mechanism by which the length stays put. Nothing else was needed.

If you arrive here chasing an offset bug, the bug is in Thicken and belongs
fixed in Thicken, where both tools get the fix.

---

## The audit that came first

The ticket's premise was that Thicken's offset could be restricted to one
dimension and that Extend's axis detection was reusable as-is. Both were
checked against the running code before a line was written. Two of the three
answers were yes; the third was a correction.

### 1. Extend's axis detection is reusable as-is — **yes**

`NSO_extendDetectAxis(rawTris, opts)` is pure, headless, DOM-free and takes the
same raw soup Thicken takes. Run over the shipped fixtures, unmodified:

| fixture | bbox (mm) | detector says |
|---|---|---|
| `cylinder_r10h30_s64.stl` | 20 × 20 × 30 | **z** — 0.00 % oblique, 75.0 % perp, 25.0 % cap |
| `prism_r10h30_s8.stl` | 20 × 20 × 30 | **z** — 0.00 % oblique |
| `pin.stl` | 20 × 3 × 3 | **x** — 1.28 % oblique (the chamfers) |
| `lid_strap.stl` | 60 × 48 × 2.4 | **x** — 0.00 % oblique |
| `box-20mm.stl` | 20 × 20 × 20 | refuses: *no single dominant axis* |
| `fixture_sphere_curved.stl` | 20 × 20 × 20 | refuses: *no dominant straight axis, 100 % oblique* |

Called verbatim. It needed no change, and got none.

### 2. Thicken can be restricted to one dimension — **not today; it is a four-line addition to Thicken, not a reason to build a second offset**

`_thickenOffsetSoup(soup, mode, offsetMm)` decided which faces move from one
thing only: `outer[f]`, the hull/crease classification. Every face on the asked
side moved, along its own normal, uniformly. There was no parameter through
which a caller could say "these faces, not those" — the arity was 3 and the
function had no `opts` at all.

Measured, to show what that costs:

```
cylinder_r10h30_s64.stl   bbox in            20 × 20 × 30
  _thickenOffsetSoup(soup, 'out', 1.0)   ->  22 × 22 × 32
```

The length grew with the diameter. That — and only that — is what Fatten has to
prevent.

The addition Thicken took, and the whole of it:

```js
_thickenOffsetSoup(soup, mode, offsetMm, opts)
//   opts.mayMove — Uint8Array, one entry per INPUT TRIANGLE. A 0 forbids that
//   face from moving; it becomes a held plane like any other. NARROWS only: a
//   face still has to be on the asked side first.
```

Note what is deliberately *not* in it: Thicken knows nothing about axes. It
offsets surfaces, and it takes a face mask. The axis is entirely the caller's
business, which is where an axis belongs — a second wrapper wanting a different
face rule (a bore, one wall of a channel) reuses the same filter without
Thicken learning anything new.

### 3. The correction: Thicken is no longer the voxel operation the ticket described

The ticket called it a "surface-offset operation", which is right today and was
not right for most of the file's life. Thicken used to be a **voxel
dilate/erode**: it re-sampled the piece into cubes, flood-filled the grid border
to decide inside from outside, and rebuilt a soup from the occupied voxels. That
version could not have been restricted to one axis in any useful way — the
6-neighbour dilation is isotropic by construction, and the resampling moved the
held side too.

The current `_thickenOffsetSoup` is a genuine planar offset: every vertex moves
to the intersection of its incident offset planes. That is what makes the
restriction meaningful and cheap, and it is why "grow only these faces, hold
those" is four lines rather than a project. The premise arrived at the right
answer through a description that is now a version out of date.

### 4. Negative offsets already worked

`thickenSelectedModel` gates `offsetMm > 0`, but `_thickenOffsetSoup` never
did, and every step in it is linear in the offset:

```
cylinder_r10h30_s64.stl
  _thickenOffsetSoup(soup, 'out', -0.5)  ->  19 × 19 × 29
```

So "shrink" needed no new code path at all — only a way for a caller to say it
means a negative number on purpose. That is `opts.signed`, and the two Thicken
buttons, which only ever mean outward, keep their gate.

---

## Scope — Extend's scope, because it is Extend's detector

Everything Extend refuses, Fatten refuses, in the same words:

1. **Axis-aligned only.** X, Y or Z. A cylinder tilted 20° off Z is refused by
   name — *"dominant axis is off-cardinal by 20.00 deg … rotate the piece onto
   an axis first"* — not quietly offset along a tilted cross-section.
2. **Straight sections only.** A cone refuses (*78.7 % of surface area
   oblique*), a sphere refuses (100 %), a blob refuses (100 %). A tapered or
   curved piece has no constant cross-section for "the cross-section" to mean.
3. **No dominant axis is a refusal too.** A 20 mm cube is a perfect extrusion
   three ways and cannot tell you which one you meant. `opts.axis` answers it.
4. **The outer side.** Fatten moves the outside of the piece, which is what
   "the cross-section grows" means. A bore or a slot is Thicken in's job and is
   not wrapped here.
5. **Raw pieces only**, as Extend requires, so the face filter and the offset
   see the same triangles in the same order.

---

## Safety: everything inherited, nothing invented

Fatten adds exactly one gate of its own — the length promise below. Every other
refusal is Thicken's, reached by calling Thicken rather than by copying it:

| gate | what it catches | proved in |
|---|---|---|
| face inversion | an offset bigger than the feature it grows into; for a shrink, the wall it eats | `fatten` §C, `wire:fatten` §5 |
| piercing self-intersection | the moved faces crossing the piece | inherited, `thickenSelectedModel` |
| `THICKEN_MIN_POCKET_AREA` | a sub-nozzle-square patch is surface noise, not a pocket | inherited |
| paint stand-down | any painted face anywhere | `paint:scope`, `wire:fatten` §6 |

Worked example of the inversion gate doing real work:

```
shrink 11 mm off a 10 mm radius  ->  refused,
  "-11 mm is more than the feature it grows into (128 faces would turn inside out)"
```

### What is deliberately absent

**Thicken does not consult `NSO_Thickness.floorFor`, so Fatten does not
either.** A shrink that leaves a wall thinner than one extrusion line (0.42 mm
at a 0.4 nozzle) is not currently refused by either tool. That is a real gap
and it is named here rather than patched here: wiring a printability floor into
an offset belongs in `_thickenOffsetSoup`, once, where Thicken out, Thicken in
and Fatten would all get it. Putting one in the wrapper would create exactly
the divergence this design exists to avoid — two offsets with two different
ideas of what is safe. **Follow-up ticket, in Thicken.**

---

## The length promise, and what it is not

Extend holds its cross-section *bit for bit*, and can, because it writes one
coordinate and copies the other two.

Fatten cannot make the mirror-image promise that cheaply. A vertex shared
between a moving wall and a held cap is placed by Thicken's plane solve, which
satisfies the cap's `n·p' = n·p` in float64 and then stores a float32 — landing
within a rounding of where it started, not on it. So the promise is stated in
the unit that is actually available:

> the axial **extent** after the bake differs from the extent before by at most
> `FATTEN_LENGTH_ULPS` (8) float32 ULPs at the coordinate magnitude in play.

Not a millimetre figure, for Extend's reason: one ULP is 1.9 × 10⁻⁶ mm at 20 mm
and 1.2 × 10⁻⁴ mm at 1500 mm, and no constant passes both. It is measured off
the output buffer *before anything is committed* — a refusal leaves the piece
untouched and pushes no undo.

**In practice it is exact** — the measured residual is `0`, not merely small, on
every fixture in the suite, and by two different routes:

- `pin.stl`'s end caps are bounded by *held* chamfers, so its extreme vertices
  touch no moving face at all and Thicken copies them through verbatim.
- a cylinder's cap rim **is** the moving wall's rim, so those vertices are
  solved — and the held cap plane pins the axial component to zero, which
  survives the float32 store on the value it started from.

The allowance is there for the case where the second route rounds rather than
lands, which no fixture has yet produced.

---

## Findings

### 1. A held end chamfer does not keep its size, and the asymmetry matters

`pin.stl` has 0.1 mm end chamfers — its X layers are exactly `0, 0.1, 19.9, 20`.
Those chamfers are oblique to X, so Fatten holds them. The ring where a chamfer
meets the shaft sits on a **held** chamfer plane and a **moving** shaft plane,
so it slides **along** the chamfer:

```
Fatten grow 0.5:   ring x = 0.1  ->  0.597       length 20 -> 20 (exact)
                   section 3.000 -> 3.997 mm
```

The chamfer keeps its 45° and its position, the end face does not move at all,
and the chamfer grows to suit. That is the only answer available while both the
end face and the chamfer plane stay put, and it is right: the piece got fatter,
the tip face did not.

The direction is not symmetric:

- **Grow** slides the ring *away* from the end, into 19.8 mm of shaft. Nothing
  to run into, so it goes through at any size the shaft can carry.
- **Shrink** slides it *toward* the end, and it has only the chamfer's own
  0.1 mm to slide along. More than that turns the chamfer inside out.

```
Fatten shrink 0.2  ->  refused, 128 faces would turn inside out
Fatten shrink 0.1  ->  ok, section 3.000 -> 2.800, length 20 -> 20 (exact)
```

So **holding a chamfer is not a way round the safety gate.** Plain Thicken
refuses `pin.stl` at −0.5 because it *eats* the chamfer; Fatten refuses at −0.2
because it *inverts* it. Different route, comparable size, same verdict. What
the holding buys is that when the offset does fit, the chamfer's angle and
position survive instead of being consumed.

### 2. A piece with no chamfer keeps its end face's outline too

On a plain cylinder the cap's rim vertices lie on the moving side wall, so the
cap disc grows with the section while both cap planes stay exactly put:

```
cylinder r10 h30, Fatten grow 1.0:
  20.0000 × 20.0000 × 30.0000  ->  21.9997 × 21.9997 × 30.0000
  cap planes:  z = 0 and z = 30, bit-for-bit unchanged
```

Compare the unrestricted call on the same piece and the same offset:

```
  Thicken out 1.0:  20 × 20 × 30  ->  21.9997 × 21.9997 × 32.0000
```

The two results differ **only** along the axis. It is one offset, restricted —
which is the clearest statement available that nothing was re-implemented.

### 3. The measured residual is 0, not "within tolerance"

Every success case in `npm run fatten` and `npm run wire:fatten` reports the
axial extent as an exact equality (`===`), not a comparison against an epsilon.
The 8-ULP allowance has not yet been needed by any fixture.

### 4. Thicken is unchanged, and that is checked rather than asserted

`tools/nso_fatten_test.js` section D calls `_thickenOffsetSoup` three ways —
two arguments, three with `undefined`, four with `{}` — on eleven fixtures
through both `out` and `in`, and compares the output buffers coordinate by
coordinate along with `moved` / `held` / `approx`. The fixture list is
deliberately weighted toward geometry Fatten would never touch:

`cylinder_r10h30_s64` · `prism_r10h30_s8` · `box_open` (the pocket case Thicken
in exists for) · `box-20mm` · `fixture_sphere_curved` · `fixture_blob_organic` ·
`fixture_groove_concave` · `lid_strap` · `pin` · `hinge_pip` ·
`box_hull_80x40x20-2`

Plus three properties of the filter itself: an all-ones mask is a no-op (it
cannot *widen* the moving set), an all-zeros mask refuses by name rather than
silently returning the input as a result, and a half mask composes correctly
with `mode: 'in'` — which Fatten never uses, but the next wrapper might.

`npm run wire:fatten` section 7 then re-drives the real **Thicken out** and
**Thicken in** buttons in the browser, on a sphere and on the open box, and
checks the status wording, the bbox, the volume and undo. The sphere is the
sharp case: it has no axis at all, so if the restriction had leaked into
Thicken's default path, that is where it would show.

---

## Reading the status line

```
Fatten grow 0.5 - 64 cross-section face(s) moved, 192 held;
  open 0→0, NM 0→0, piercing 0→0, vol 140.4→245.8 mm³; X length held
```

Everything up to the last clause is Thicken's own status line, because it is
Thicken's own bake; `X length held` is Fatten's. `shrink` prints its size as a
plain magnitude (`Fatten shrink 0.2`) rather than the minus sign the user never
typed.

A blank box is not a failure. The first click reports the piece:

```
Fatten: this piece runs along X (20.00 mm, held). Cross-section Y 3.00, Z 3.00 mm.
  Set an offset and press Fatten or Shrink.
```

---

## Tests

| command | what |
|---|---|
| `npm run fatten` | 91 checks, headless. A–C the feature and its refusals, **D the Thicken regression**, E the length gate. |
| `npm run wire:fatten` | 43 checks, real app, real clicks, real undo. **§7 re-drives both Thicken buttons.** |
| `npm run paint:scope` | the roster row — Fatten declares WHOLE-PIECE in its own source, and still carries the stand-down wording |

All three are in `npm test`.

---

## Out of scope, named so the next ticket does not re-derive it

- **Tapered, curved and off-cardinal pieces.** Refused, by Extend's detector,
  with the measurement in the message.
- **Bores, slots and channels.** Fatten is the outer side. A "Fatten bore"
  would be the same wrapper over `mode: 'in'` with the same filter, and the
  filter already composes with it correctly (proved in §D) — but it is a
  different promise about a different feature and wants its own ticket.
- **One wall at a time.** The filter is per-face and could express it; deciding
  *which* wall from a click is a picker, which is orchestration, and belongs
  with the same picker Extend's write-up defers.
- **A printability floor on the shrink.** Belongs in Thicken. See *What is
  deliberately absent*, above.
- **Re-tiling.** Fattening a knuckle makes the finger fatter; it does not add a
  finger. Same boundary Extend draws, for the same reason.

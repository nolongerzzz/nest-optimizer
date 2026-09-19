# Integration stress test — tools meeting for the first time

Two suites, both in `npm test`:

```
node tools/nso_integration_test.js        73 checks, headless: the geometric joins
node tools/nso_wire_integration_test.js   40 checks, the real app: the app-state joins
```

Neither is a feature suite. Every tool they drive already has its own suite
proving it right on its own. What is asserted here is only what happens at the
**joins**, and the reason that is worth its own file is the first finding
below: Hollow was right, the union was right, and the pair was broken.

Five combinations were run deliberately, before a user found them.

---

## The findings, sorted the way the ticket asked

| # | what | verdict |
|---|---|---|
| 1 | Hollow → Join / Attach refused every time | **real bug — fixed** |
| 2 | Clone dropped `rawTris`, so every raw tool refused the clone | **real bug — fixed** |
| 3 | Clone left the plate outline on the original | **real bug — fixed** |
| 4 | Extend across an assembly's cross axis | honest refusal; the **wording** is a gap |
| 5 | Smooth on a hollowed piece | honest refusal; the **wording** is a gap |
| 6 | Clone selects the clone, Extract selects the source | not a bug — two defensible opposite choices, now written down |
| 7 | Hollow on a 1.2 mm extracted slab, Fatten/Extend on a cube | honest refusals, well worded, nothing to do |

Nothing was "fixed" that was correctly out of scope. Findings 4 and 5 are
reported and left alone on purpose — see **What was deliberately not fixed**.

---

## Finding 1 — the union counted shells instead of asking whether the pieces merged

**Real bug. Fixed in `NSO_unionSoups` (`app-join.js`).**

`nso_hollow.js` makes a solid with a cavity, which is a perfectly good solid
and χ = 4 rather than 2. Manifold's `decompose()` counts topologically
disconnected components, and a cavity skin is disconnected from the outer
skin, so **a hollowed piece is two components before anything is joined to it
at all**. Measured, by unioning the shell with a cube 100 mm away that it
plainly does not touch:

```
A 2 + B 1 -> 3
```

`NSO_unionSoups` gated on `parts === 1`. So a sound union of a hollowed body
with an arm came back as 2 and was rejected with **"the two pieces do not
touch"** — which was false. The boolean had done its job the whole time: the
volume showed the overlap correctly subtracted (23.5030 mm³ removed against
π r² × 0.42 = 23.5702), the result was closed with 0 open and 0 non-manifold
edges, and `NSO_Repair` no-ops it by identity.

That gate is on **Join's kernel route and Attach alike**, so:

> Hollow and Join were two independently-correct tools that could never be
> used together. Neither suite could see it, because each one was right.

### The fix

The question the gate means to ask is "did A and B become one thing", and the
answer is that the union has **fewer components than the two inputs had
between them**:

```js
merged = parts < partsA + partsB
```

On two solids that is the old test exactly (1 + 1 → 1). On a hollow body it is
2 + 1 → 2. A genuine miss still fails it, because nothing merged and the counts
simply add. `partsA` and `partsB` are measured on the same `manA` / `manB` the
union is built from, through the same `NSO_manifoldStats` the result goes
through — no new mechanism. When the kernel cannot tell us what an input was
worth (`exact: false`), the old `parts === 1` test is used instead: a guessed 1
is not evidence, and refusing is the safe side of a guess.

The refusal also now says why the count is what it is, when the count is not
the obvious one:

```
the two pieces do not touch (A is 2 shell(s), B is 1; the union is still 3,
so nothing merged)
```

### Negative controls

A loosened gate has to be shown still refusing what it was built to refuse, or
the fix is indistinguishable from deleting it. All four are in
`tools/nso_integration_test.js` §3:

| case | counts | still refused? |
|---|---|---|
| two solids parked a 0.4 mm kerf apart | 1 + 1 → 2 | **yes** |
| a hollow shell and a cube 100 mm away | 2 + 1 → 3 | **yes** |
| a cube captive *inside* the cavity, touching nothing | 2 + 1 → 3 | **yes** |
| a plain solid pair that really does bite 0.5 mm in | 1 + 1 → 1 | accepted |

The third is the one that matters most: it is the case a naive "the count went
down" test would wave through if the inputs' own counts were not measured.

`tools/nso_wire_fuse_test.js`, which asserts that Join does **not** claim a
fuse on pieces that do not mate, passes unchanged — its refusals are the first
row of that table.

### Known edge, named rather than fixed

An arm driven so deep that it pierces the wall *and* divides the cavity into
two would leave the count unchanged (2 + 1 → 3) and be refused. Measured, a
2.5 mm engagement through a 2 mm wall does not do this — the cavity stays one
piece — so it is a shape nobody has yet made rather than a case that is
failing. It is written down here so the next ticket recognises it instead of
re-deriving it.

---

## Findings 2 and 3 — Clone

Both **real bugs. Fixed in `cloneSelectedModel` (`app-core.js`).** The ticket
asked whether cloning and then immediately reaching for a new tool provokes the
known desync more reliably than the original manual discovery. It does:
**five tools out of five**, every time, with no timing involved.

### Finding 2 — the clone was not a raw piece

`cloneSelectedModel` cloned `src.geometry` and handed `addModel` the display
geometry alone. `addModel` only records `rawTris` when it is given them, so
every clone arrived with `rawTris: null` — and every raw tool refused it by
name:

```
Fatten needs a raw piece - unchanged
Hollow needs a raw piece - split, wrap or boolean it first
Smooth needs a raw piece - unchanged
Extend needs a raw piece - unchanged
Match needs a raw piece - "box-20mm-copy1" has no untransformed soup ...
```

Every one of those is an **honest refusal**. The bug is upstream of them:
`src.rawTris` was in hand the whole time. And the failure reads as nonsense
from the user's side, because the piece they can see highlighted — the
original, per finding 3 — *is* a raw piece.

**Fix.** Pass `rawTris`, `rawAxis` and `centerOffset` through. The three
transfer verbatim: the clone's display geometry is `src.geometry.clone()`,
`addModel` re-centres it and the source was already centred, so that is a
no-op and the same `centerOffset` maps the same soup onto it. The soup is
**copied, not shared** — two models pointing at one buffer is an aliasing bug
waiting for the first tool that writes in place, and Clone already pays the
same order of memory for `geometry.clone()`.

**Negative controls** (`tools/nso_wire_integration_test.js` §1):

- Hollowing the clone leaves the original **byte-identical** — the copy is a
  copy, not an alias.
- A clone of a piece that legitimately has **no** soup (the case `addModel`'s
  own header names, a piece rebuilt after a Split) still has none, and Fatten
  still refuses it by name. Clone must not invent data it does not have.

### Finding 3 — the selection split in two

`cloneSelectedModel` ended with `state.editId = newIds[0]`, written behind
`selectPlaced`'s back. So after a clone:

| what | pointed at |
|---|---|
| `state.editId`, `getActiveModel()`, the Edit card, the model list | the **clone** |
| `state.selectedIndex`, the red outline in the viewport | the **original** |

Every tool driven by `getActiveModel()` acted on a piece the user could not see
was selected. Tools driven by a click were immune, because a click goes through
`selectPlaced` and resyncs — which is why this hid for so long: it only bites
the button-driven tools, and only straight after a clone.

**Fix.** Select the first clone through the app's one selection path,
`selectPlaced(index)`, which moves both halves and clears the outline it is
taking the selection away from. The undo entry is still pushed *before* the
selection moves, because that entry is what Undo puts back.

**Negative control**: Undo after Clone restores the pre-clone `editId`, drops
the clones from the plate, and the piece comes back value for value.

---

## What was deliberately not fixed

### Finding 4 — Extend across an assembly's cross axis

Honest refusal, opaque wording. An assembly of a box body and a 48-gon
cylinder arm can be stretched along the arm's axis from any attachment point
(asserted at all four faces, in §1 of the headless suite), and is **refused**
on the other two:

```
float32 shift collapsed 1 of 28 distinct layers onto each other
```

That is Extend's injectivity gate, and it is correct: the arm's ring puts
dozens of coordinate layers a float32 ulp apart, a uniform shift rounds two of
them together, and Extend's whole promise is that it does not do that. It
refuses and hands the piece back by identity — asserted, so a later change that
mangles instead of refusing fails here.

Two things make the *message* a gap rather than an answer:

- it names an internal concept ("distinct layers") with no figure a person can
  act on;
- it is amount-dependent in a way it does not mention. Measured on the same
  assembly: **+0.5 mm succeeds, +1 mm through +11 mm fail, +13.7 mm fails
  worse** (2 layers instead of 1). A user who tried a smaller stretch would get
  what they wanted; nothing tells them to.

Compare the message the same tool gives for the same *kind* of problem on a
plain Stock cylinder, which is exemplary:

```
no constant cross-section band along x - 26 gap(s) examined, none clean;
widest (0.5517 mm) failed because 4 of 52 straddling triangles are oblique
(worst |n.u| 6.54e-2 against a derived tolerance of 1.38e-5)
```

This is a **wording gap on a correct refusal**, not a bug, so it is reported
and left alone. The message was written for pieces whose layers are far apart,
where it is nearly unreachable; a tessellated arm makes it the common case, and
that is the observation worth carrying to whoever owns Extend's wording.

### Finding 5 — Smooth on a hollowed piece

Honest refusal, same shape of gap:

```
Smooth refused - piece unchanged (volume flipped sign)
```

Global Laplacian smoothing on a 2 mm wall whose cavity is a 0.667 mm
marching-cubes surface drives the cavity out through the skin, and the signed
volume goes negative. Smooth's own gate catches it and returns the input
untouched — asserted by identity in §4 of the headless suite. Correct
behaviour; the message says nothing about the cavity being the cause. Reported,
not fixed.

### Finding 6 — Clone selects the clone, Extract selects the source

Not a bug. Two tools that add a piece make **opposite** choices about what is
selected afterwards, and both are defensible: you clone in order to work on the
copy, and you extract in order to keep working on the original. What matters —
and what finding 3 was breaking — is that each tool's **two halves agree with
each other**, which is now asserted for both.

Written down here and in `docs/HANDOFF.md` so the next tool that adds a piece
picks deliberately rather than by accident.

### Finding 7 — the refusals that were simply right

No action, listed so the sweep's coverage is legible:

- Hollow on the 1.2 mm slab that Extract produces: *"a 2 mm wall is thicker
  than half this piece (2 mm across its narrowest axis) — there is no interior
  left to carve. Hollow thinner, or leave it solid."* Names the measurement and
  the remedy.
- Fatten and Extend on a cube: *"no single dominant axis — 3 axes (x, y, z) are
  equally straight and within 1% of the same length; pass opts.axis to say
  which one you meant."*
- Delete painted on a vessel: *"…open 0→4 … the piece is now OPEN."* States the
  consequence rather than hiding it.
- Attach at a point that is beside a curved vessel rather than on it: refused
  with the distance (6.266 mm against the 4.227 mm allowed).

---

## The five combinations, and what each one now asserts

### 1. Assembly → Extend and Fatten, at four attachment points and all three axes

`nso_integration_test.js` §1. An arm attached at +X, −X, +Y and +Z; in each
case Extend's detector picks the **arm's own axis unprompted** (x, x, y, z),
lengthens along it to the asked length with the cross-section held bit for bit,
refuses both cross axes by identity, and Fatten grows and shrinks the
cross-section with the length untouched. Everything stays χ = 2, 0 open, 0
non-manifold. A **second arm** onto a finished assembly is included: still one
closed shell.

### 2. Stock → Hollow → Assemble

`nso_integration_test.js` §2 and §4, `nso_wire_integration_test.js` §3. This is
where finding 1 lived. Also covered: the **reverse order** (Attach then Hollow
the assembly — works, χ = 4, Repair no-ops it), Extend on a hollow shell (the
void travels with the stretch), and the end-to-end UI path.

### 3. Extract selection → Fatten, Extend, Hollow

`nso_wire_integration_test.js` §2. The extract is a first-class raw piece: 12
triangles, closed, 3840.0 mm³ for an 80 × 1.2 × 40 slab. Fatten grows it,
Extend lengthens it, Hollow refuses it for being 1.2 mm thick and changes
nothing. The source piece comes out value for value unchanged, and the two
halves of "selected" agree.

### 4. Clone, then each of the newer tools immediately

`nso_wire_integration_test.js` §1. Findings 2 and 3, their fixes, and their
negative controls.

### 5. Pottery Wheel piece → Repair, Seat, Paint, Delete

`nso_integration_test.js` §5, `nso_wire_integration_test.js` §4. Clean
throughout, with **zero special-casing**: Repair no-ops by identity, the Seal
button with Repair ticked says "Nothing to repair", Paint takes both an exclude
and a select on the revolved surface, Delete removes the target and states that
the piece is now open, Undo restores value for value, and Seat here seats a bit
against the curved wall reporting the turn it baked. An arm also attaches to the
vessel's curved flank and unions to one closed solid.

One structural note worth keeping: the wheel's **Open** makes an open-topped
pocket, which is **χ = 2 — one shell**, not a hollow two-shell solid. That is
why finding 1 never reached the Pottery Wheel, and why a suite that had only
ever exercised the wheel would not have found it.

## PAINT SCOPE: NONE

Neither file is a feature. They read pieces and drive shipped tools; the paint
behaviour under test belongs to each of those tools and is asserted in their
own suites and in `tools/nso_paint_scope_test.js`.

`app-join.js` and `app-core.js` are both edited by this ticket, and neither
edit touches a paint path: the union gate is a component count, and Clone makes
a new piece rather than baking an existing one. Clone's `faceMask` behaviour is
unchanged — a clone starts unpainted, as it always did.

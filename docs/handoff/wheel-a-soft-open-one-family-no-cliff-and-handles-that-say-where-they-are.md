## Wheel: a soft Open - one family with no cliff - and handles that say where they are
`app-wheel.js` (`NSO_wheelOpenSoft`, `NSO_wheelOpenReach`, `NSO_wheelSoft*`, `NSO_wheelOpenU/P`, Build stage 2, faster
`NSO_wheelDistToProfile`), `app-wheel-live.js` (the Open slider, the handles, rings, tag, row linking), `index.html` (the Open row),
`styles.css` (row colours, `.wh-tag`). Write-up: `docs/POTTERY-WHEEL.md` "A soft Open" and "Dragging on the piece".

The ask, in the owner's words: Flatten "jumps from this to this ... no real smooth transition on the drag"; "when we first began there was more
of a spherical bowl ... now it's a flat bottom with edges coming straight up. Open has a similar jumping effect, from a squished ball to a vase
bottom"; and "the controls (grabbing points) are much easier to work with than the balls ... what the sliders do, and where they correspond on the
model is a little confusing. I find myself just moving knobs".

ONE ROOT CAUSE for the jumps. The strict Open opens the piece as wide as the wall allows, cuts the dome off and stands it up as walls to keep
the clay, so any opening at all is the whole bowl: ball 50 -> 99 mm tall at 0.3 mm of Deep, a 3 mm plate 3 -> 47 mm the moment Flatten made it
thick enough to hold a cavity (the Deep value left on the slider became active). Measured before touching it; the sweeps are in the doc.

What replaced it: Open is `recipe.open` (0..1), a family where mouth, depth and the whole shell's size go to zero together and the clay is kept by
**growing the shell** (not by standing the walls up), so a ball opens ROUND and a plate into a dish. The strict `NSO_wheelOpen/Keep` and their tests
are untouched. `recipe.depth` (mm) is gone from recipes; `R.push` became `R.open = { max, mouth, why }`; the slider id is `rng-wheel-open`.

Things a later ticket should read before touching this:
- **The rim is found on the outline, not by height.** A plate's top is flat, so a height rule cuts its whole top skin off (a cliff again). The rim is a
  point on the outline's descending branch where the mouth that fits (a wall from the rest of the outside, the part above ignored) equals the mouth asked
  for. On a plate that is on its top face - the plate keeps its top.
- **The widest mouth on a plate is at the foot of the edge, with zero depth to open.** `NSO_wheelSoftReach` takes the highest rim within 1% of the
  widest. Before that a thin plate failed at exactly 100%.
- **A plate two walls thick has a mouth and no room**: `NSO_wheelOpenReach` checks the shape at u = 1, so the range is 0 with a reason instead of a
  slider that does nothing.
- **The slider is a curve of u** (`u = 1 - (1-p)^1.5`): the clay a mouth needs goes as the cube, so the last tenth of a linear slider doubled the bowl.
- **The volume solve** is a log-secant, tolerance 3e-7 and never over (`bud.headroom` is absolute and refuses even 1e-6 mm^3 over). The first version's
  rim search was a 260-sample scan: 1-2 s a build. Bisection + golden section + a sqrt instead of `Math.hypot` in the distance: 10-30 ms.
- **Wall is never scaled** (the cavity is re-found at every trial size). That is what keeps Wall a real lever; a thin wall makes a bigger bowl.
- The strict API's old ramp/foot-crease story (the soft-pull note) is still true of the strict Open and is still tested.

Handles: blue Flatten, cyan Open (mouth: out; on the rim also up = Rim +), yellow Pull, green Lip, red Trim (new). The Shift-opens gesture and the cavity-floor
ball are gone. Each slider row wears its handle's colour; hover either end and the other lights, a tag names and reads it, and a ring on the piece shows where
it acts (Soft: the pull height +/- its width; Scale: the widest part; Wall: the rim; Lip at: where the lift starts...). Sliders with no handle (Scale, Wall,
Soft, Lip at, Flare) still get the ring. `markerSpecs` is the one place that says where each slider acts.

Tests: `npm run wheel` 267 (section 7i: no 1% step of Open moves the width > 3 mm; Flatten drag with Open set smooth; round bowl never taller than wide;
plate -> dish; mouth/depth monotone; conserved at all 101 settings; canonical mesh check of five soft-open pieces, 191 total), `npm run wire:wheel`
(handles by name, Open/Trim drags, hover rings/tags/lit rows, row colours).

Not done, and said so: a drag handle for Scale / Wall / Soft / Lip at / Flare; a second pull; a narrow-mouthed vase is Open then Pull in (the mouth and the
depth rise together). The wire test needs `PW_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` in this container (the harness looks for a
`chrome-linux` folder).

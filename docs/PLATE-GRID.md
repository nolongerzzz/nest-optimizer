# Plate reference grid + grid-snap

A flat, world-aligned reference grid owned by the build plate, and an optional
soft snap that uses the same lattice. Landed on `claude-wip-plate-grid`.
Suite: `npm run grid:plate` (`tools/nso_plate_grid_test.js`), gated by `npm test`.

Code: `app-core.js` (the grid, visibility, snap maths), `app-join.js`
(`setupUI` wiring), `index.html` (Plate card controls), `styles.css`.

---

## 0. Audit first — what already rendered the bed, and what did not exist

**The plate rendering layer.** `buildPlateMesh()` in `app-core.js` builds four
things and adds every one of them **directly to `state.scene`, never to
`state.modelGroup`**:

| object | what it is | y |
|---|---|---|
| `state.plateMesh` | `PlaneGeometry(w, d)`, `rotation.x = -PI/2` | 0 |
| `state.plateGrid` | the grid | 0.15 |
| `state.plateBorder` | `EdgesGeometry` loop, cyan | 0.3 |
| `state.plateTicks[]` | four corner `Line`s, amber | 0.35 |

That separation from `modelGroup` is the whole convention: plate furniture is
world-space furniture, so no piece transform can reach it. `isPlateObject()`
names the membership; `hitPlateSurface()` decides what a plate-drag can pick.
The new grid reuses that layer exactly — it is built in `buildPlateMesh`, added
to the scene beside its siblings, and torn down with them on a plate change.

**A flat grid already existed.** `state.plateGrid` was a `THREE.GridHelper`,
always on, with three problems that a snap feature cannot live with:

- **square**: sized `max(w, d)`, so it overhung a Prusa 250 x 210 bed by 40 mm;
- **no spacing in mm**: 18 divisions of `max(w, d)` gave 10 mm on an A1 Mini but
  14.22 mm on an A1 256 — no round lattice to snap to, and the drawn lines
  would not have matched the snap targets;
- **pickable**: it was listed as a `hitPlateSurface` target.

So this did not build a new rendering layer. It replaced the helper with an
owned grid in the same slot, under the same name, with the same lifecycle.

**No curvature anywhere.** The bed is a plane at y = 0 — `hitPlateXZ()`
intersects exactly `Plane(normal (0,1,0), constant 0)` to turn a cursor into a
bed position, and `settlePlacedOnBed()` drops a piece to it. The grid is a
plane in that same plane, snapping is 2-D in X/Z, and nothing on this path
handles or needs curvature. The suite pins it: the grid's bounding box has
exactly zero extent in Y.

**The curved Seat grid — audited absent, landed in parallel.** The ticket asked
to match the auto-visibility pattern of a just-shipped curved Seat grid. At the
`claude-wip` tip this branched from (`2a6d07a`) there was no such thing: `Seat`
was only `NSO_seatFlushBitToHull` / `seatFlushBitToHull` (`app-join.js`), a
geometry operation with no overlay, no visibility mode and no raycast policy.
So the audit reported no pattern to copy, and the modes below were designed
from the ticket's own wording.

It landed on `claude-wip` while this was being built — `b0dc10d`, "Surface grid
on the Seat / Join target piece", now `app-seat-grid.js` + `nso-surface-grid.js`
— and the merge carries both. **They converged**, which is the useful part of
the record: `app-seat-grid.js` has `MODES = ['auto', 'on', 'off']` in
`state.seatGridMode`, and disables picking with `line.raycast = noop`. This has
the same three modes in `state.plateGridMode` and the same `raycast` no-op. Each
grid reads "auto" against its own subject — the surface grid's auto follows the
Join/Seat target (piece A), this one follows the piece being positioned — which
is the same rule applied to two different questions, not two rules.

They are two features on two surfaces and share no code. What the merge did
settle is naming, because both wanted the word "grid":

| | surface grid | plate grid |
|---|---|---|
| file | `app-seat-grid.js` | `app-core.js` |
| state | `state.seatGridMode` | `state.plateGridMode`, `state.plateGridSnap` |
| control | `#btn-seat-grid` (cycles) | `#plate-grid-show` (select), `#chk-plate-grid-snap` |
| suites | `grid:math`, `grid:wire` | `grid:plate` |
| lives in | `state.modelGroup`, pose copied from the piece | `state.scene`, world-fixed |

That last row is the real difference and worth keeping straight: the surface
grid deliberately is **not** a child of the piece, because its lines are lifted
off the face and `Box3.setFromObject` would then make the piece measure bigger
(it moved seven Seat gates by 0.1375 mm before that was found). It solves this
by copying the piece's pose. The plate grid has no such problem to solve: it is
world-fixed furniture in `state.scene` and is meant never to follow anything.

---

## 1. The grid

`buildPlateGrid(p)` returns a `THREE.Group` at y = 0.15 holding two
`LineSegments`: minor lines every `PLATE_GRID_STEP_MM` (10 mm) and a heavier major
line every `PLATE_GRID_MAJOR_EVERY` (5th, so 50 mm).

- **World-aligned and plate-fixed.** Lines are built directly in the XZ plane,
  so the group carries no rotation of its own and needs none. It is added to
  `state.scene`. A piece can be dragged and rotated under it and its bounding
  box does not move by so much as 1e-9 — the suite checks that.
- **Clipped to the real plate.** Lines sit on the world lattice (multiples of
  the step from the plate centre) and stop at ±w/2 and ±d/2, so a 250 x 210 bed
  gets a 250 x 210 grid.
- **Visible on a flat-resting piece's underside for free.** The grid is in the
  plate's own plane and a piece resting flat has its bottom face in that same
  plane, so the two coincide. Nothing projects anything.

### Visibility — on / off / auto

`state.plateGridMode`, default `'auto'`. `plateGridWantsVisible()` is the whole rule, and
`animate()` applies it every frame so nothing can go stale.

- `on` — always drawn.
- `off` — never drawn.
- `auto` — drawn while a piece is **actually being positioned**: for the whole
  of a pointer drag (`state.moveDragging`), and for `PLATE_GRID_AUTO_HOLD_MS` (900 ms)
  after a nudge, because a nudge is a positioning act too but an instantaneous
  one. `holdPlateGridAuto()` is the hook for anything else that should count.

---

## 2. Grid-snap — a pull, not a lock

`state.plateGridSnap`, default **off**, a separate control. It is the only coupling
between the grid and anything that moves; with it off, `plateGridSnapXZ` returns its
argument untouched and the drag path is bit-identical to before this landed.

Within the pull radius `R` (half the step, so the pull field has no seams and
no gaps), the cursor's offset `d` from the nearest lattice line maps to

```
f(d) = sign(d) * R * ((1 - S) * u + S * u²),   u = |d| / R,   S = 0.8
```

Three properties are what make this an assist rather than a constraint, and the
suite measures each one on a real drag sweep rather than trusting the algebra:

| property | why it matters | measured |
|---|---|---|
| `f(R) = R` | continuous with the untouched region outside the radius, so nothing jumps as the pull starts or stops | at the 5 mm cell boundary the piece is at the cursor to 1e-6 |
| `f(0) = 0` | the lattice line is exactly reachable, not merely approached | cursor at 30.000 → piece at 30.000000 |
| `f'(d) ≥ 1 - S > 0` | strictly increasing, so the piece moves whenever the cursor moves, in the same direction — a drag away from a line can never be blocked or reversed | 41 samples across a line, strictly monotonic; a 12.4 mm drag off a line moves the piece 11.4 mm (91.9%) and over the next line |

`S` is how hard the detent bites. At `S = 0.8` the piece tracks the cursor at
20% speed right on the line, and the largest offset the assist can ever apply is
`max(d - f(d)) = S·R/4 = 1 mm` on a 10 mm grid. Measured sweep across the line
at x = 30:

```
cursor    26.00   27.00   28.00   29.00   30.00   31.00   32.00   33.00   34.00
piece     26.640  27.960  28.960  29.640  30.000  30.360  31.040  32.040  33.360
pull      +0.640  +0.960  +0.960  +0.640   0.000  -0.640  -0.960  -0.960  -0.640
```

**Anchor:** the piece's own placement origin (`p.x` / `p.z`), so the pull is
toward the grid intersection under the piece's centre.

**Order against the neighbour magnet.** `resolveDragPose` applies the grid pull
to the raw cursor target and hands the result to `magnetTowardNeighbors`, so the
neighbour magnet gets the last word. That is deliberate: the magnet closes a
contact gap outright, and touching the piece next door is a stronger intent than
lining up on the bed. A piece pulled into contact stays in contact even when
that lands it off the lattice.

### During the drag, not on release — and why

Snapping runs inside `resolveDragPose`, which is the live pointer-move path, so
the pull is applied and drawn continuously. **Release-only was tried on paper
and is worse here, specifically because the pull is soft.** A soft pull applied
only at pointer-up moves the piece by up to 1 mm at the instant the person stops
moving, with nothing on screen having hinted at it — that reads as drift, not as
assistance. Release-only earns its keep when the snap is a *hard* lock, where
the jump is large, unambiguous and obviously deliberate; this one is a 1 mm
nudge and needs to be seen happening to be understood. The suite pins both
halves: the pull is present mid-drag before any pointer-up, and `endMoveDrag`
adds no second, harder snap of its own.

---

## 3. Guarantees

**The grid is purely visual.** Both line sets carry `raycast = plateGridNeverRaycast`
(a no-op), and `hitPlateSurface` deliberately does not list the grid among its
targets. `plateMesh` covers the same footprint, so plate-drag orbit is unchanged
by its absence. A ray fired straight through the crossing lines at the plate
centre returns 0 hits on the grid and still hits the bed. `isPlateObject()` does
still name the grid and its children, because it *is* plate furniture — that
function answers "what is this", not "what can be picked".

The one and only path by which the grid can move a piece is grid-snap, which is
off by default and is a separate control.

**The two controls are independent.** All six mode/snap combinations are
reachable and behave as asked; the suite walks every one.

**Snap with the grid hidden: allowed, but signposted.** Whether snap without
visible lines should be permitted at all was the open question. Forcing the grid
visible would break the independence the ticket also asked for, so it is
allowed — but it is not a state to fall into by accident, because the assist
would pull pieces toward lines nobody can see. Turning snap **on** while the
grid is **off** therefore promotes the grid to `auto`, once, and says so in the
status line. Set the grid straight back to `off` afterwards and snap keeps
working. It is a signpost, not a constraint.

---

## 4. Paint

Not applicable, and stated here so the next ticket does not have to re-derive
it. The standing paint rule binds **bake mechanisms** — anything that changes
geometry. The grid draws lines and grid-snap changes a placement coordinate;
neither reads, writes or rebuilds a single triangle, so neither has a face to
leave untouched and neither has a category under the scoping rule.

---

## 5. Controls

Plate card, left panel — the plate owns the grid, so the controls live with it.

| id | control | default |
|---|---|---|
| `#plate-grid-show` | select: Auto - while positioning / Always on / Off | `auto` |
| `#chk-plate-grid-snap` | checkbox: Snap to grid | unticked |

## 6. Constants (`app-core.js`)

| name | value | what it sets |
|---|---|---|
| `PLATE_GRID_STEP_MM` | 10 | minor spacing, and the snap lattice pitch |
| `PLATE_GRID_MAJOR_EVERY` | 5 | heavier line every 5th, so 50 mm |
| `PLATE_GRID_Y` | 0.15 | above the bed at 0, below the border at 0.3 |
| `PLATE_GRID_AUTO_HOLD_MS` | 900 | how long `auto` lingers after a nudge |
| `PLATE_GRID_SNAP_STRENGTH` | 0.8 | detent bite; must stay < 1 or the pull locks |
| `PLATE_GRID_SNAP_RADIUS_MM` | step/2 | pull radius; seamless at exactly half the step |

`PLATE_GRID_SNAP_STRENGTH` is the one that must not be touched carelessly: at `S = 1`
the mapping's slope at the line becomes 0 and the assist turns into a lock,
which is exactly what this feature is not.

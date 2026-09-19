# Surface grid on the Seat / Join target

A faint grid drawn on the top surface of the piece something is being placed
**onto**, so the piece going above it has something to be lined up against.
It is an aid to the eye and nothing else: no geometry changes, no export
changes, and the mesh picking that Seat and Join actually run is untouched.

- `nso-surface-grid.js` — the geometry. No THREE, no DOM, no app state.
- `app-seat-grid.js` — whose grid it is, which way is up, how it is drawn.
- `tools/nso_surface_grid_test.js` — the slicer, against closed-form surfaces.
- `tools/nso_wire_grid_test.js` — the whole feature, in the real app.

## 1. The audit: what already draws on a real surface

Four mechanisms in the app already had to put a mark where a surface actually
is. Each was read before writing a line of this, and each settled part of the
design.

### app-mask.js — the yellow face paint

`repaint()` is the closest existing thing to "draw something following a real
surface". What it does, and what the grid copies:

- The overlay's triangles **are the piece's own triangles**, read straight off
  the live `mesh.geometry.attributes.position` every rebuild. Nothing is
  re-derived, re-projected, or remembered from before the last bake. The grid
  takes the same rule: its points come out of the target's current display
  geometry, so a piece rebuilt by a boolean gets a grid of the piece that is
  there now.
- `overlay.raycast = function () {}`. app-core.js picks with
  `intersectObjects(state.modelGroup.children, **true**)` — recursive — so any
  child of a placed mesh is in the path of every Join, Soften, cap and paint
  pick. The paint learned this the hard way (a Soften pick landing on the paint
  instead of the face). The grid's lines are deaf for the same reason.
- It does not move the thing it marks, and it does not move itself: depth
  fighting is settled with `polygonOffset`, in the depth buffer, not by
  nudging vertices. The grid cannot borrow that literally — polygon offset is
  for polygons, and `LineSegments` are lines, so the depth buffer never hears
  about it. It gets the same effect with the smallest thing that works: each
  emitted point is lifted along **its own triangle's normal** by
  `max(0.03mm, diag x 0.0015)`, which on a 35mm piece is 0.05mm. That is the
  overlay's own vertices; the piece is not touched. It is also the reason the
  grid cannot be a child of the piece — see below.
- The overlay lives in `state.modelGroup` with `placed.mesh`'s transform
  copied onto it, not under the mesh. The grid needed the same, for a reason
  the paint's own comments do not give: see below.
- Render order in the transparent pass, above the helpers it must not be
  hidden by. The paint claims 40 and says why. The grid sits at 24: above the
  inspect cage (16) and the armed-face highlight (20), below the paint, since
  a face that is both painted out and under the grid should read as painted
  out.

### app-sel-outline.js, app-poslock.js, app-defects.js — helpers on a piece

All three hang their helper as a **child of the placed mesh** and dispose it on
every rebuild. A child follows the piece being dragged, nudged or turned with
no hook of its own and no per-frame work. They can afford it: an outline, a
lock cage and a defect mark all lie exactly on the geometry, so they add
nothing to it.

The grid cannot, and this is the one place it has to differ. Its lines are
lifted a hair off the face to stay out of the depth fight (below), and
`THREE.Box3.setFromObject` walks children — so a grid parented to the piece
makes the piece **measure** bigger by the lift. That is not hypothetical: it
moved seven Seat gates by exactly 0.1375mm, the lift on an 80x40x20 hull. The
app is immune (it asks `meshLocalBox3`, which reads the mesh's own geometry),
but "the piece's box" is a thing anything may reasonably ask for, and a
drawing that changes the answer is not purely visual.

So the grid sits in `state.modelGroup` with the piece's transform copied onto
it — which is what app-mask.js's paint does, and, it turns out, why. Nothing
under the piece has volume. The price is the one thing a child got free,
keeping up with a move, and it is paid by copying the pose rather than
rebuilding: `syncPose()` off `applyPlacedXZ`, the path every drag, nudge,
magnet and bed settle already takes. The lines are still computed in the
piece's own space and on its own axes, so what a square reads stays true as
the piece turns.

app-defects.js is also the answer to why the grid keeps `depthTest` on where
the defect marks turn it off. The marks answer "where is the problem", and a
piercing pair is usually inside the piece, so they show through. The grid
answers "where will this land", so a piece placed above it must hide the part
it covers — and with depth testing on and no polygon offset available for
lines, the small lift is what is left.

### app-join.js — `NSO_nearestSkinHit` and `NSO_plugFrame`

This is the app's existing "follow the real skin", and it is what Seat flush
runs on: one ray per plug corner at the hull's triangle soup, nearest crossing
in either direction, then a residual report of how far each corner ended up
from the skin. Exact, and the right shape for four corners.

The grid did **not** reuse it directly, and the reason is the whole design:

- A grid is thousands of points. One ray per point over the whole soup is
  `O(points x triangles)` for something rebuilt whenever a pairing changes.
- So the grid is the **dual** of that ray. Instead of asking "where does this
  vertical line meet the surface", each triangle is asked "which grid planes
  cross you, and along what chord". Plane vs triangle is closed form, it is
  one pass over the soup, and every point emitted is a point **of** a triangle
  — the same guarantee `NSO_nearestSkinHit` gives per corner, for the whole
  grid at once. Curvature comes out for free as the per-triangle break in each
  line.

`NSO_plugFrame`'s job of deciding which face is the outer one reappears in
miniature: `app-seat-grid.js` takes world up, says it in the mesh's own space
(via the inverse world quaternion), and that is the face the grid goes on — so
a piece that has been tipped still gets the grid on the face actually pointing
at the sky, which is the face the piece above will land on.

### app-finish.js / app-mask.js — the per-face frame

`nsoFaceFromHit()` and `frameOf()` / `rawPointFromLocal()` map a picked face
between display space and the piece's raw, untranslated soup, because Soften,
the wrap and Align all have to name the same face in raw terms. The grid
deliberately **does not** go near any of it. Raw space is what export, the
boolean and the wrap read; the grid has no business there and nothing to say
about it. It lives entirely in the mesh's own display space — which is the
same conclusion the paint's overlay reached for its own drawing.

## 2. How the lines are made

`NSO_surfaceGridLines(soup, opts)`:

1. Keep the triangles whose normal has `dot(n, up) >= 0.12` — the top surface.
   Steeper than about 83 degrees is a wall, not something a piece sits on.
2. Measure that surface along `u` and `v` and pick spacing off a ladder of
   numbers a person counts in (0.25, 0.5, 1, 2, 2.5, 5, 10, ...), aiming at
   about 12 squares across the wider side. 6.67mm squares are arithmetically
   fine and useless to read against.
3. Anchor line 0 of each family at the **centre of the top face** — the
   question the grid answers is "is this centred, and by how much" — and draw
   those two centre lines brighter than the rest.
4. For each kept triangle and each grid plane crossing it, emit the chord: the
   two points where the plane cuts the triangle's edges. Lift each along the
   triangle's normal.

Every output point is therefore a point of the surface, flat or curved, with
no projection and no sampling.

## 3. Whose grid it is

A pairing has a lower piece and an upper one. In this app that is Join's A and
B: A is the hull / target (`state.editId` while a join session is live, which
is also what Seat flush and Subtract take as the hull), B is the bit seated
onto it. **The grid is A's.** It is never drawn on B, and asked for B's grid
directly the answer is still A's.

The button (`#btn-seat-grid`, in the Join card) cycles three states, and says
which one it is in:

| mode | what gets a grid |
| --- | --- |
| `auto` (default) | piece A of a live Join / Seat pairing, and nothing else |
| `on` | the same, or the selected piece when no pairing is running |
| `off` | nothing |

Rebuilds hang off `paintJoinHighlights` — the app's own "the pairing changed,
restate who is who" call, which every slot change, cancel, selection and
completed boolean already goes through. The grid changes hands exactly when
the roles do, with no second list of hooks to keep in step. `selectPlaced` and
`applyMeshRotation` are wrapped too: the first for picking outside a join
session, the second because turning a piece over changes which face is up.
A drag or a nudge rebuilds nothing — the grid is a child of the mesh and rides
along.

## 4. What the tests hold down

`npm run grid:math` — the slicer, against surfaces whose exact geometry is
known in closed form rather than shipped as an STL:

- on a flat top, every point is exactly in the face and every segment lies on
  a grid plane of one family;
- on a sphere, every point is on the sphere to within the mesh's own chord
  error (0.047mm measured against a 0.096mm bound), while a flat grid hung at
  the crown would be wrong by 18mm — three orders of magnitude, so "it follows
  the curve" is not a tolerance argument;
- the lift moves points along each face's normal and nowhere else;
- nothing faces up, or nothing is there at all: no lines, no error.

`npm run grid:wire` — the feature in a real browser, on the curved fixture:

- the lines are on the skin **by the app's own raycaster**, not by the slicer
  that drew them: a ray dropped onto the piece over each sampled point agrees
  to within the lift (0.052mm), and never finds the line sunk into the piece;
- picking is untouched — every ray over the target lands on the mesh, with the
  face the pick needs, and no ray ever reaches the grid;
- with the grid up versus down: the piece **measures** the same through
  `Box3.setFromObject`, the tape four other suites use on it, and it is the
  same geometry object with the same vertices, the same `rawTris`, the same
  plate-export triangle count and an unmoved piece;
- the grid is a child of `modelGroup`, nothing with volume hangs under the
  mesh, the grid wears the piece's pose, and a move through `applyPlacedXZ`
  carries it along;
- roles: the grid appears on A, not B; follows a swap of A and B; clicking B
  does not move it; Cancel Join takes it away; `on` grids a merely selected
  piece and a pairing still outranks the selection; `off` means off.

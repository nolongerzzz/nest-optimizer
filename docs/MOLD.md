# Mold - a two-piece interlocking silicone mold from a piece

**Gen+ -> Mold.** Select a piece, open the card, slide the parting blade, press
**Generate mold**. Two new pieces land on the plate beside the original, named
`<piece> mold A` and `<piece> mold B`: print them, close them, pour silicone,
pull the cast out. The piece is read and never written.

`npm run mold:drive` photographs the open pair - a Stock sphere Ø30 and its mold, both
halves open, parting face up beside the original - into the git-ignored
`tools/mold-out/mold-open-pair.png`; nothing is committed.

Files: `nso_mold.js` (the engine: THREE-free, node-tested), `app-mold.js` (the
card, the helpers, the click, the Generate / Undo), `tools/nso_mold_test.js`
(`npm run mold:test`), `tools/nso_mold_drive_check.js` (`npm run mold:drive`,
1280 x 800), `tools/nso_mold_testlib.js` (the shipped kernels under node).

## 1. What it is made of

Nothing new is invented for the hard parts. The engine takes its booleans and
its split from what the app already ships, passed in as a `kernel`:

| step | engine | where |
|---|---|---|
| the cavity: block minus piece, minus sprue, minus vent | **Subtract B from A** (`NSO_subtractSoups`, Manifold) | `app-join.js` |
| the halves: the block cut at the parting plane | **Cut's clean split** (`cutOneSide` -> `rawCut`: nested-loop cap, so a bore or a cavity is one annulus) | `app-cut.js` |
| keys: cones joined to A | **Union** (`NSO_unionSoups`) | `app-join.js` |
| sockets: cut into B | **Subtract** again | `app-join.js` |
| the blade | the Cut card's slider, ← number →, dial (same classes, same 0.1 mm grid, same 1 mm end stop) | `app-cut.js`, `styles.css` |

## 2. The flow

1. **Select a piece, open Mold.** The piece *as it lies* is the mold orientation:
   the pose on the plate (Rotate, Tip, Tilt) is read through the piece's mesh
   transform, a mirrored pose included. Mold does not turn anything - turn the
   piece first. Opening the card arms it; shutting the card, or Gen+, takes
   every helper away.
2. **Parting plane.** A blade appears at the piece's mid-height, level. The
   **slider**, the **← number →** row (0.1 mm; Shift 1 mm) and the **dial** are
   the Cut card's. `mm` is how far the plane is above the piece's low end where
   it crosses the piece's centre line; it stays 1 mm in from each end (Cut's
   rule). The dial says which way the blade *leans* (degrees clockwise seen from
   above, 0 = toward the top of the screen) and **Tilt** how far (0 - 60°); at
   Tilt 0 the plane is exactly level whatever the dial says. (The Cut card's dial
   is a heading about the vertical, which is no tilt at all to a level plane -
   so here the dial steers the lean and Tilt sets it.)
3. **Locks.** A face of the piece locks a half when that half cannot be drawn
   off it: on A's side of the blade, a face looking away from A's pull (its
   normal · the blade's normal < 0); on B's side, a face looking away from B's
   pull (> 0). Faces within 0.02 of square to the pull (a vertical wall with no
   draft) do not count. A triangle the plane crosses is cut by it and each part
   is judged on its own side. Locking faces are tinted on the piece and counted
   on the card: **"N mm² would lock"**. A warning, never a refusal - silicone
   pulls out of small undercuts.
4. **Block.** A box around the piece: **Wall** 10 mm each side, **Top/bottom**
   15 mm above and below. The block is axis-aligned; only the plane may lean.
5. **Halves.** Block − piece (− sprue − vent), cut at the plane with Cut's clean
   split, so the two faces mate exactly: both are built from the same boundary,
   and for a leaning plane the cut is made with the plane laid level and both
   halves are turned back by the one matrix.
6. **Keys.** Four cones on half A's parting face, at the corners of the block's
   footprint inset Wall/2 from the edges, along the plane's normal. **Key Ø** 6
   at the base, **Key height** 3 proud, 45° sides - so Ø6 / 3 mm is a full cone;
   the height is held to Ø/2 (the card says so). Matching sockets in half B,
   **0.2 mm radial fit gap** (socket Ø = cone Ø + 0.4): the socket is the cone
   with its radius 0.2 larger at every depth, so the gap is the same everywhere
   along the 45° side. Each key has a 1 mm stub into A (and the socket 1 mm
   above B's face) so the union and the subtraction always have something to
   bite into.
7. **Pour and vent.** A **sprue Ø8** from the block's outer face to the
   cavity's **highest point**, and a **vent Ø3** from the highest spot on the
   *far* side of the cavity (opposite the pour, clear of the sprue, its whole
   mouth over the cavity) to the outside - both straight up, both wholly in
   half A. Each bore starts 0.3 mm inside the cavity, so its whole mouth is open
   to it, and ends 1 mm past the face. Both are placed automatically.
   **Click the piece** and the pour point moves to the clicked spot; the sprue
   re-routes **straight to the nearest outer face** it can reach - up, or out
   sideways along ±X / ±Z - from a surface that looks that way, and stays 4 mm
   (the sprue's radius, 0.3 to spare) above the plane everywhere. A spot that
   cannot be served is refused in words and the pour stays where it was.
   **Pour: top** puts it back. The card draws the pour point (and the vent) on a
   small plan view of the block; the scene draws the marker, the sprue and the
   vent as translucent bores.
8. **Generate.** Two pieces on free plate beside the original, **closed and
   manifold** (checked by the module, by the page's checker, and in
   `mold:drive` by `tools/mesh_validate.py` with self-intersection). Both halves
   lie **open, parting face up** with their flat block faces on the plate -
   half A is turned over about the X axis through the block's middle - so each
   prints without supports. **One Undo removes both.** The original stays.
   **Regenerate** (the same button once a pair exists) replaces the pair in the
   places the old one had; one Undo puts the first pair back.

## 3. Refusals, in words

Each is on the card as the blade moves (the button goes grey), and each is what
**Generate** says if it is asked anyway. Nothing is built.

- **A piece that is not closed:** "The piece is not closed (50 open edge(s)) - a
  mold needs a solid to take the shape of. Repair it first (Check & repair)."
  An inside-out piece is refused the same way (Cut offers to turn it).
- **A block larger than the plate:** "Too big for the plate: the mold block would
  be 190.0 x 190.0 x 200.0 mm (the piece 170.0 x 170.0 x 170.0 mm plus the
  walls), and the plate takes 180 x 180 x 180 mm." The block's footprint is
  tried both ways round; its height against the machine's build height (the
  taller half, for a level plane). The plate is the machine the Plate card
  points at (`NSO_fitCurrentPrinter`).
- **Keys that would not fit the parting face:** "the minimum wall for a Ø6 key
  and its socket is 8.4 mm, and Wall is 6 mm". The minimum is
  2 × (socket radius ÷ cos(tilt) + 1 mm web); for a leaning plane every cone and
  socket must also lie inside the block with that web.
- **A plane that does not pass through the piece** (a gap between two lumps, or
  past an end): refused.
- **No sprue place above the plane** (a highest point too close to the plane):
  refused, the plane to be moved down.

Softer, said on the card and not refused: a key height cut back to Ø/2; a click
that could not be served (the pour stays at the highest point); no room for a
vent (the mold is made without one).

## 4. Out of scope

Shrink / clearance offset on the cavity; more than two parts; cores; draft
angles. A piece with a pocket (a cup) works - half A grows a core standing in
the pocket - but its pocket faces count as locks, and a real multi-part mold
for it is a different tool.

## 5. Tests

`npm run mold:test` (85 gates, ~13 s, node): the shipped kernels under the
engine, independent measures throughout.
- a Stock sphere Ø30: two halves, each closed and manifold (the module's census
  and `tools/mesh_validate.py`, self-intersection included); the mating faces
  coplanar within 0.01 mm and every outline vertex of one a vertex of the other;
  cavity volume = sphere + sprue + vent within 0.5 % (the module's own account
  agrees); four cones on A and four sockets on B at the same x, z within 0.01 mm,
  at Wall/2 from the edges, socket Ø = cone Ø + 0.4; the sprue and vent by
  **point-in-solid** on the half (axis empty from the top face to the cavity,
  Ø8 / Ø3 walls where they should be); the piece untouched;
- the blade: a box tilted 20° - the plane follows the slider (centre line, lean,
  direction, slope); lock area > 0 below the widest point, 0 at the mid-plane of
  a symmetric piece, and equal to a brute-force sampling of the same rule; a box
  posed 20° on its side; a tilted-plane mold (mating faces on the tilted plane
  to 1e-6 mm, both halves through `mesh_validate`);
- a clicked pour point moves the sprue to the nearest outer face, and the mold
  built with it has a straight bore there and no hole at the pole;
- a torus and a cup (`fixtures/box_open.stl`); the refusals, in words;
- the engine loads in a bare context (no THREE, no document).

`npm run mold:drive` (~45 s, Chromium at 1280 × 800): the real page - the Stock
card makes the sphere, Gen+ -> Mold opens on it, the slider / nudge / number /
dial / Tilt move the plane the blade draws, a **real mouse click** moves the pour
point, Generate makes the pair beside the original (halves pulled back out of the
page and put through `mesh_validate`), Regenerate replaces it, one Undo each,
the pose is read (a turn swaps the block's X and Z), the three refusals, and the
card-is-the-switch. It writes `tools/mold-out/mold-open-pair.png`.

## 6. Notes for the next person

- Every soup is in the **world** frame (y up); the halves are converted to the
  raw z-up frame (`raw = (x, -z, y)`, a proper rotation) when they become pieces.
- The keys are made in the *laid* frame (plane level, exactly `y = c` on both
  halves) and turned back last. Doing the union after turning back left slivers
  on a leaning face (float noise on an almost-plane).
- The seat of a bore ignores disc samples more than 1.5 mm under the centre's
  surface: over a pocket or past an edge the mouth is over mold, not cavity, and
  must not drag the bore down into the pocket.
- `plan()` runs no boolean and costs ~10-30 ms warm on an 18 k-triangle sphere
  (the top-surface index and the vent candidates are cached per piece), so the
  card re-plans on every slider tick. `build()` is ~1.5 s there.
- Not in the roster of `tools/nso_paint_scope_test.js`: Mold reads the piece's
  geometry and writes no face of it (paint scope **none**, docs/HANDOFF.md).

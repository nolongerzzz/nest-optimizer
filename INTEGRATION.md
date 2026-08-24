# Cut-Edge Fillet — Integration Plan (for review; no code yet)

How `fillet.mjs` (pure math, already merged on this branch) will wire into the
existing "Square cut" tool in `app.js`. This is a plan only — do not implement
until reviewed.

## 1. Where Square cut produces the capped mesh and the 2D boundary loop

- `cutActiveModel()` (`app.js` ~2920) is the split entry point (the "Split at
  red plane" button). It computes the plane, splits triangles into the two
  halves, applies the kerf gap (`KERF_MM`) and the current soft bevel
  (`CHAMFER_MM`), and builds each half's flat cut face.
- `capFromEdges(edges, axis, plane, keepMin)` (`app.js` ~2415) is the cap
  builder and already contains the doc's "boundary-loop-walk":
  - welds cut-plane boundary points into a node graph (`TOL = 1e-4`),
  - walks degree-2 cycles into `loops` — each an ordered array of `[x,y,z]`
    points lying on the cut plane (multiple loops if the cut passes through a
    hollow section; `hull2D` is only a degenerate fallback),
  - projects to 2D with `to2(p)` and ear-clips (`earClip`) into the flat cap,
  - already offsets the loop for the chamfer via `offsetLoop2D(loop3, dist)`
    (a mitered inward offset — the same operation as our `vertexOffset`).
- **Hook point:** the walked `loops` inside `capFromEdges` (before/instead of
  the flat ear-clip cap) are exactly the input our fillet needs. The fillet
  replaces the flat cap for a chosen loop with the rounded band + smaller cap.

## 2. Building the cut-plane frame for `meshToPositions`

The cut plane is axis-aligned, so the frame is trivial and matches `to2`/`from2`
one-for-one (no arbitrary basis needed):

- `nAxis` = unit vector of `axis` (`x`→[1,0,0], `y`→[0,1,0], `z`→[0,0,1]) — the
  split axis — oriented so **+nAxis points from the cut face into the kept half**
  (depth increasing). `keepMin` decides the sign.
- `uAxis`, `vAxis` = the other two world axes, in the same order `to2` uses:
  `axis==='x'` → (u,v)=(y,z); `axis==='y'` → (x,z); `axis==='z'` → (x,y).
- `origin` = any point with the split coordinate set to `plane` (e.g.
  `from2(0,0)`); `capPlanePos = 0` and feed the plane offset through `origin`,
  so `alongAxis` is depth measured from the cut face into the kept half.
- Our loop's `[u,v]` = `to2(loopPoint)`; converting back is `from2(u,v)` at depth
  `plane ± alongAxis`. `meshToPositions(mesh, frame)` then yields the
  non-indexed `Float32Array` for a `THREE.BufferGeometry`.
- Pre-step: run `resampleLoop(loop2D, 0.3–0.4mm)` (doc §0) before the builder —
  `capFromEdges` welds but does not resample to uniform arc length, and the
  corner math wants clean spacing.

## 3. Trimming / stitching the wall to the rounded outer seam (the hard part)

The fillet occupies the depth band `[cutFace, cutFace + R]` of the kept half.
Its outer seam ring (at depth R) equals the original loop on straight runs but
is a **rounded arc at each corner** (the sphere's tangent line), so it will not
line up with the wall's sharp corner there.

Proposed approach (reviewable in stages):

1. **Trim:** make a second planar trim of the kept half parallel to the cut
   plane at depth R, limited to the fillet's inset footprint — i.e. remove the
   thin sliver of side wall the fillet now covers. Reuse the existing
   plane-split machinery from `cutActiveModel` (same axis, `plane ± R`).
2. **Straight runs:** the fillet outer ring coincides with the original loop
   (inset 0), so those vertices are shared directly with the trimmed wall edge —
   no gap.
3. **Corners:** bridge the small region between the wall's sharp corner (at
   depth R) and the fillet's rounded outer arc with a per-corner triangle fan
   (both are known polylines in the same plane; the gap is bounded by R and the
   turn angle). This is the only genuinely new stitching code.
4. **Weld + verify:** merge fillet + trimmed wall + existing far geometry,
   re-weld on rounded coords, and gate on `checkWatertight` (every interior edge
   used exactly twice) before replacing the mesh — reusing the fillet module's
   own watertight check as an integration guard.

Fallback if corner stitching proves fiddly: a "seam-preserving" mode where the
corner blend tapers to 0 at the outer ring (outer seam stays the sharp loop, so
it stitches trivially) at the cost of a slightly less clean corner where wall
meets fillet. Decide during review.

## 4. UI (no new buttons)

- Add a single **radius (mm)** number input to the existing "Square cut" card
  (mirroring the `cut-mm` control), default from §5 policy below. No new
  buttons — the existing "Split at red plane" action gains rounding when radius
  > 0; radius = 0 keeps today's flat/chamfer behavior.
- Surface the builder's fail-loud `warnings` in the existing status line
  (`setStatus`) / the cutter status text: `thin-wall` → "radius reduced to fit a
  N mm wall"; `self-intersection` → "corner too sharp for this radius — reduce
  radius". Non-blocking; the mesh still returns best-effort.

## 5. Default `windowSize`

- `windowSize = 12` is too small for sharp corners (a dense 90° corner needs ~24
  to close its cap cleanly; the builder otherwise fails loud).
- **Proposed default: 24**, and have the caller **bump it based on the sharpest
  detected corner**: after `detectCorners`, if any `|turningAngle|` exceeds ~60°
  (interior < 120°), raise the window (e.g. `windowSize = clamp(24 … 40)`
  scaling with turn angle), because a sharper corner spreads its sphere blend
  over a longer arc. `windowSize` is in vertex counts, so it must be read
  together with the resample spacing (window 24 @ 0.35 mm ≈ 8.4 mm of arc).
- Alternative worth prototyping: a small auto-remediation loop (widen window,
  then shrink corner radius toward `rMin`) that retries until the §4c cap-closure
  check passes, converting most `self-intersection` warnings into a clean mesh
  with a reduced local radius. Left out of the first cut deliberately.

## Scope guard

Everything above is integration-side; `fillet.mjs` stays pure and untouched
except possibly exporting a tiny frame-builder helper. No wiring lands until this
plan is approved.

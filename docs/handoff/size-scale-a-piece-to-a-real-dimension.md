## Size — scale a piece to a real dimension (landed, `app-scale.js`)

Added 2026-09-17. The audit that preceded it is the short version of why the
file exists: **there was no scale control of any kind** on `claude-wip` — not a
dimension box, not a factor box. Every occurrence of "scale" in the wired app
was camera zoom (`onViewportWheel`), a `mesh.scale.copy` in the mask overlay, or
a three.js `addScaledVector`/`multiplyScalar`. A piece's size came from its file,
and only Cut, Thicken, Solidify and the Finish bakes moved it. So "make this
exactly 50 mm tall" had no answer at all, and neither did "half size".

The Size card in the left panel now has both, and the first is the point:

- **Set size** — pick X, Height, Z or *Longest edge*, type the mm, press. The
  factor is solved for you and applied to all three axes.
- **Scale by** — the plain uniform multiplier, which is the primitive the first
  one is built on.

**Uniform only, deliberately.** "50 mm tall" on a part means the part at 50 mm,
not a part squashed on one axis. Non-uniform scale moves wall thicknesses, hole
roundness and overhang angles independently, and nothing downstream expects it —
not Cut's raw mapping, not the packer's footprint, not Soften's radius. A
per-axis stretch would be a different feature with a different name.

**Paint wins, whole-piece.** A uniform scale moves every vertex and there is no
sub-region to scope the check to, so by the scoping rule above any painted face
stands the whole operation down, naming the count — the same answer Smooth
gives. Worth recording why this is not just inherited: a mask entry is a plane
`{n, d}`, and under a uniform scale about the bbox centre `n` is unchanged while
`d` scales, so the paint *could* be carried through arithmetically. Doing so
would be a second mapping from a plane back to a face, which is exactly the
re-derivation the standing rule forbids. Until the mask stores something
scale-invariant, refusing is the honest answer.

**Exactly, and what "exactly" can mean.** The soup is a `Float32Array` and stays
one, so the span the file carries is a difference of two 24-bit mantissas. On
every fixture measured the result lands on the nearest float32 to the requested
millimetre — for 12.7 mm that is 12.699999809265137, off by 1.91e-7 mm, which is
`|float32(12.7) - 12.7|` and irreducible by any factor. `NSO_scaleSolve` keeps a
correction loop (`f *= target / measured`, always re-derived from the original
soup so error cannot compound, best result kept). It is measured, not assumed:
over 200,000 random (offset, extent, target) triples, **8,660 improved, 0
worsened, 191,340 unchanged**, best gain 2.3e-4 mm. The unchanged majority is
the easy case — a piece near the origin. The 4% that improve are meshes whose
coordinates sit far from the origin, i.e. any STL exported without recentring,
where both ends of the span round on a much coarser grid than the span itself.
`tools/nso_wire_scale_test.js` section 8b reproduces one (2.36e-4 → 8.52e-6 mm,
27.6× closer, two passes).

**Do not gate this with `NSO_edgeStats`.** That welder quantises on a FIXED 1e-4
mm grid, which is correct for a bake that leaves the piece the same size and
wrong for one that does not: scale a sound mesh up by 10 and two vertices that
shared a grid cell no longer do, so it reads as newly open; scale a torn one
down and they merge, so it reads as freshly healed. Neither is a fact about the
mesh. `NSO_scaleTopoStats(soup, q, areaEps)` takes the quantisation from the
caller, and `NSO_scaleGate` hands the after-mesh `q / factor` and
`areaEps * factor²`, so the two measurements are of the same shape at the same
relative tolerance and any difference is real. It compares triangles, distinct
vertices, distinct edges, open edges, non-manifold edges and degenerate
triangles; the gate runs before anything is committed.

**Guard rails.** Factor must land in 1e-4..1e4, and the result must be at least
0.1 mm on its shortest axis — the same floor `addModel` uses to call a loaded
mesh empty, so a scale can never produce a piece the loader would reject. Every
refusal leaves the piece byte-for-byte unchanged.

### `npm run wire:scale` — in `npm test`, so CI gates it

`tools/nso_wire_scale_test.js` drives the real app in headless Chromium, then
measures the **file**, not the app's opinion of itself: it reads the piece's soup
back out of the page, writes a binary STL with `tools/nso_stl_io.js`, and runs
the canonical checker — `python3 tools/stl_watertight_check.py <f> --odd --degen`
— on the before and after copies. Eleven sections; 80x40x20 box and
`fixture_sphere_curved.stl`, both axis targets and longest-edge targets, the
factor button, undo (bit-for-bit restore), eight refusals, and the painted
stand-down.

**Negative-controlled (section 4b), because a green checker run means nothing if
red is unreachable.** One vertex of the scaled result is nudged 1 mm and the
same checker command turns red — `open_edges 0 → 4, odd_edges 0 → 4, FAIL odd
edges` — while the untouched result stays OK. The app's own gate gets the same
treatment: `NSO_scaleGate` is handed that torn soup and refuses it
(`distinct vertices changed 16->17`), so the gate is live rather than
decorative.

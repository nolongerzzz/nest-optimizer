## Bridge - a web between two places, welded (2026-10-14)
`nso_bridge.js` (headless) and `app-bridge.js` (the card), loaded after
`app-bend.js` at `?v=bridge1`. UI is a **Bridge** button in the Shape
drop-down, under Extend and Mirror: hover lights a face, an edge or a point;
press, drag, release on another; a ghost of the web; Set / Cancel. Full
write-up: `docs/BRIDGE.md`.

Face to face is a band (a ruled loft, both caps dropped, walls split where new
points land, stitched on the same numbers - Join's planar-fuse vertex space and
seam weld, no kernel); point to point a round string and edge to edge a flat
sheet, both unioned with `NSO_unionSoups`. Before a later ticket touches it:
- **The result is a new piece** in place of its inputs; Undo is G-scope's
  `supportSwap` step, so every input comes back as the same objects.
- **What is picked is decided by the mesh**: a flat region whose whole rim is
  creased 20° is a face, 8 px from its straight rim is an edge, anything else
  a point. A face end with a point end is a string.
- **Every web is straight.** Curved bridges are Bend's job afterwards.

`npm run bridge:test` (headless) and `npm run bridge:drive` (real app), both
in `npm test`.

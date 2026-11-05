## Mirror - exact reflection across one plane (2026-09-21)
`app-mirror.js`, loaded at `?v=mirror1` straight after `app-extend.js`. It
calls that file's axis detector and band cut; it does not carry a copy. UI is
a **Mirror** button plus a plane box in the Finish menu's Shape group, directly
under Extend. Full write-up: `docs/MIRROR.md`.

Reflects a piece across a plane perpendicular to one axis. The other two
coordinates are bit for bit, and reflecting again returns the original soup.
A plane that does not round-trip in float32 is refused rather than snapped.
Winding is swapped so the solid stays outward-wound. The result is an ordinary
piece — `rawTris`, no mirror flag — so Align and Join need no Mirror branch.

The opposite-end sequence is cut at a clean band, mirror the **low** half
across that plane, align (the raw shift is 0), join the coincident caps.
Soften is not in it. On `library/soften_test_04_slotted_block.stl` the joined
ends are the same triangles after one is reflected back, and Join snaps 0
seam vertices. `fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl` has no
clean band; the midpoint mirror is exact, and Join refuses that cut on its own
tolerance rail. Details and the reason the low half is the one to mirror:
`docs/MIRROR.md`.

`npm run mirror`, `npm run mirror:canonical`, `npm run wire:mirror`. All three
in `npm test`.

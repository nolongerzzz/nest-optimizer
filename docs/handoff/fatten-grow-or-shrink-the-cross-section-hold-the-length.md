## Fatten - grow or shrink the cross-section, hold the length (2026-09-19)
**Superseded in the UI by Scale part 3 (2026-10-12):** the Fatten / mm / Shrink
row is gone from the Finish menu, folded into the Scale card's **Offset** row
(`NSO_scaleOffsetRaw`, `docs/SECTION.md`): the outside moves, the inner faces
follow, and it refuses at the floor and where a bore would close - Shrink here
had neither and un-rang a ring at 0.1 and 0.5 mm. `NSO_fattenCrossSectionFaces`
is still nso_ring.js's face filter; `NSO_fattenSelectedModel` is still callable
(the integration checks drive it) and no button reaches it. `wire:fatten` became
`wire:offset`. What follows is the original record.

`app-fatten.js`, loaded at `?v=fatten1` straight after `app-mirror.js` (Mirror
sits between it and `app-extend.js`; Fatten still calls Extend's axis detector). UI is a **Fatten** / mm /
**Shrink** row in the Finish menu's Shape group, directly under the Thicken
row - the same three-control shape, so the kinship reads off the panel. Full write-up: `docs/FATTEN.md`.

**It is a wrapper, and the thing to know about it is that it must stay one.**
There is no offset maths in `app-fatten.js`. It detects the dominant axis with
`NSO_extendDetectAxis` and hands `_thickenOffsetSoup` a face filter saying
"only the faces parallel to that axis may move"; the caps and end chamfers
become held planes, and holding them is what holds the length. Grow is
Thicken's offset with a positive d, shrink is the same call with a negative
one - its maths was always sign-agnostic and only the button's own gate was
not. If a bug sends you here looking for somewhere to write a second offset
path, the bug is in Thicken and belongs fixed there, where both tools get it.

What Thicken itself gained, and it is the whole of the addition:
`_thickenOffsetSoup(soup, mode, mm, opts)` now takes `opts.mayMove`, a
per-input-triangle `Uint8Array` that **narrows** the moving set (a face still
has to be on the asked side first), and `thickenSelectedModel(mode, mm, opts)`
takes `signed` / `gate` / `label` / `modeLabel` / `mmLabel` / `sideWord` /
`undoType` / `note`. Every field defaults to today's behaviour, and
`tools/nso_fatten_test.js` section D proves that coordinate by coordinate on
eleven fixtures - a sphere, a blob, an open box, a cube, a groove - through
both `out` and `in`. Strictly additive or it is a fork; section D is what tells
the difference.

Three things a later ticket should read before touching this:
- **Scope is Extend's scope, because it is Extend's detector.** Axis-aligned
  X/Y/Z only, straight sections only, and a piece straight three ways (a cube)
  refuses and asks for `opts.axis`. Nothing here needed its own scope rules and
  nothing here should grow any.
- **A held end chamfer does not stay the same size.** The ring where a 0.1 mm
  chamfer meets the shaft sits on a held chamfer plane and a moving shaft
  plane, so it slides ALONG the chamfer: `pin.stl` grown 0.5 mm takes that ring
  from x=0.1 to x=0.597, keeping the 45 degrees and the end face exactly where
  they were. Growing is free (19.8 mm of shaft to slide into); SHRINKING is
  bounded by the chamfer's own width, and 0.2 mm off `pin.stl` is refused by
  Thicken's inversion gate because 0.2 > 0.1. Measured both ways in the suite.
- **No nozzle floor, on purpose.** Thicken does not consult
  `NSO_Thickness.floorFor`, so Fatten does not either - it inherits the
  inversion, piercing, pocket-area and paint gates and nothing else. A
  printability floor on an offset belongs in Thicken, once. Named as a
  follow-up in `docs/FATTEN.md`, not smuggled into the wrapper.

`npm run fatten` (91 checks, headless, section D being the Thicken regression)
and `npm run wire:fatten` (43 checks, real app, section 7 re-driving both
Thicken buttons). Both in `npm test`.

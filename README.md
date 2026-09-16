# Nest Optimizer

Smart build-plate packing for 3D printing.

**Goal:** Maximize the number of models on a plate while choosing orientations that need the fewest supports.

## Features (v0.1)

- Multi-plate support from day one
  - Bambu A1 Mini (180×180)
  - Bambu A1 / P1S / X1C (256×256)
  - Prusa MK4 / MK3S
  - Creality Ender 3
  - Custom size
- Drag & drop multiple STL or 3MF files (a 3MF's objects each become a model,
  placed where the slicer had them)
- Quantity control per model
- Auto-orient for lower support needs
- Auto-nest with optional 45°/90° rotations
- Adjustable gap between models
- Live 3D preview
- Export positioned models as STL (ready to drop into Bambu Studio / Orca / PrusaSlicer)
- Or pick **Format: 3MF** in the Export card and the same two buttons write a
  Bambu Studio `.3mf` project with cooling settings baked in, chosen from a small
  table of named cooling profiles - the whole plate, or the selected piece alone
- **Lock position** on a placed piece: a locked piece refuses drag, the nudge
  arrows, Raise/Lower and the pose buttons, so a stray click cannot move it
  once Seat has put it where it belongs. Seat, Center, Align and Skin still
  work on it. Shown by a teal outline and a `locked` tag in the list.
- Breakaway supports through minimal contact: **Skin face** puts a contact
  relief (fine crosshatch, sawtooth ridges, or a tapered ring) on one flat face
  of a support block, and **Seat flush** with gap 0 rests the part on the
  relief's tips - never on its base plane. Print-ready two-shell samples in
  `fixtures/skin-samples/`; see `docs/HANDOFF.md`, "Contact skin on a face"
  - **Skin wrap** puts the same relief on every flat rectangular face at once
    (all six faces of a box), leaving painted faces alone and naming them.
    Still flat faces only: a curved face is refused, as it always was.
  - **Layer 2** adds a second pattern on the first one's tips. Composed (the
    default) it stays one closed shell and cuts the contact to the two
    patterns' overlap - a zigzag second layer takes a crosshatch from 182 to
    52 mm², a second crosshatch mostly just makes the relief taller, and the
    status line prints both numbers so you can tell which happened. With
    **Free** on, layer 2 becomes its own free-hanging sheet resting on those
    tips - a second breakaway interface - and the piece is flagged non-solid,
    because it now carries two shells. See `docs/HANDOFF.md`, "Skin wrap +
    the double skin"

## How to use

1. Open `index.html` in Safari, Chrome, or Edge (works on iPhone too).
2. Select your build plate.
3. Tap / drop one or more STL or 3MF files.
4. Set quantities if needed.
5. Tap **Optimize Plate**.
6. Download the result and open it in your slicer.

## Notes

- This tool optimizes **orientation + layout only**.  
  Support generation and actual slicing still happen in Bambu Studio (or Orca / PrusaSlicer).
- 3MF **export** ships the plate as a Bambu Studio project with cooling /
  overhang-fan settings baked in - see
  [docs/baked-cooling-settings.md](docs/baked-cooling-settings.md), including a
  known limitation around Bambu's "Use Modified Value of Filament Preset" dialog.
  3MF **import** reads geometry only: every object in the file, with its
  transforms applied, becomes a model. Print settings, materials and colours in
  the file are ignored. Tested against files Bambu Studio wrote as well as
  NSO's own exports - see `docs/baked-cooling-settings.md`, "3MF import".
- The packing algorithm is a solid bottom-left free-rectangle packer with rotation. It will improve over time.

## Future ideas

- True multi-file zip export
- Better 3D nesting heuristics
- Overhang angle estimation for smarter orientation scoring
- Save / load packing projects
- Direct “Send to Bambu Studio” style workflow

Built for the FormKeep / Etsy production workflow and anyone else who hits the same wall.

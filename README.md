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
- Drag & drop multiple STL files
- Quantity control per model
- Resize a piece to a real dimension - pick X, height, Z or the longest edge,
  type the mm you want, and the uniform factor is solved and applied (or scale
  by a plain multiplier)
- Auto-orient for lower support needs
- Auto-nest with optional 45°/90° rotations
- Adjustable gap between models
- Live 3D preview
- **Measure** — click two points on the pieces for the distance between them in mm,
  or switch to Edge and click one edge for its length. Corners and edges snap, the
  number is drawn on the piece, and it follows the piece when you move it.
  See [docs/MEASURE.md](docs/MEASURE.md).
- Export positioned models as STL (ready to drop into Bambu Studio / Orca / PrusaSlicer)
- **Carve** is a local carving tool - a handheld rotary tool, not the Cutter's
  full-plane Split. Pick a blade profile, arm it, then click a face, an **edge**
  or a **corner** of a piece: the blade is aimed along the outward bisector of
  whatever faces it can reach there and just that local volume is subtracted.
  - Three interchangeable profiles: **ball-nose** (a rounded gouge with no
    stress corner), **flat shave** (a flat-bottomed slab cut), and **V-groove**
    (a chamfer - cut deeper for a wider one, so one blade gives every size).
  - A corner gouge and an edge chamfer need no rotation: the blade lays its
    sweep axis along the edge itself. A `roll` field spins it off that if you
    want. Depth is the size control; the blade's height follows from it.
  - Unlike **Subtract**, which consumes bit B, Carve consumes nothing - the same
    blade carves the next edge too.
  - On a smoothly curved surface the tessellation is read as one feature, not as
    a field of tiny edges, so a gouge on a dome is a face carve.
  - `minWall` still measures along the cut axis only, and the status line says so
    whenever more than one face is in play, plus what it held back in mm³ when
    it held anything. See `docs/LOCAL-CARVE.md`

## How to use

1. Open `index.html` in Safari, Chrome, or Edge (works on iPhone too).
2. Select your build plate.
3. Tap / drop one or more STL files.
4. Set quantities if needed.
5. Tap **Optimize Plate**.
6. Download the result and open it in your slicer.

## Notes

- This tool optimizes **orientation + layout only**.  
  Support generation and actual slicing still happen in Bambu Studio (or Orca / PrusaSlicer).
- 3MF import/export is planned for the next iteration.
- The packing algorithm is a solid bottom-left free-rectangle packer with rotation. It will improve over time.

## Future ideas

- True multi-file zip export
- Better 3D nesting heuristics
- Overhang angle estimation for smarter orientation scoring
- Save / load packing projects
- Direct “Send to Bambu Studio” style workflow

Built for the FormKeep / Etsy production workflow and anyone else who hits the same wall.

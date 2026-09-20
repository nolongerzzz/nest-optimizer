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
- Resize a piece to a real dimension - pick X, height, Z or the longest edge,
  type the mm you want, and the uniform factor is solved and applied (or scale
  by a plain multiplier)
- **New stock**: a correctly-sized blank to start from, before Carve, Hollow,
  Cut or anything else that begins with a blank block - sphere, box or
  cylinder, sized from the target piece by a Pappus thin-shell estimate plus a
  tunable waste margin, and refused outright if the target cannot physically
  exist on the current plate ([docs/STOCK.md](docs/STOCK.md))
- Auto-orient for lower support needs
- Auto-nest with optional 45°/90° rotations
- Adjustable gap between models
- Live 3D preview
- **Measure** — click two points on the pieces for the distance between them in mm,
  or switch to Edge and click one edge for its length. Corners and edges snap, the
  number is drawn on the piece, and it follows the piece when you move it.
  See [docs/MEASURE.md](docs/MEASURE.md).
- **Pottery Wheel**: throw a vessel on an axis - a centred ball sized by
  Pappus's centroid theorem, one opening push, drag-shaped pulls at any
  height, and a base trim, with a live clay budget and the nozzle-safety wall
  floor enforced on every update ([docs/POTTERY-WHEEL.md](docs/POTTERY-WHEEL.md))
- **Build-volume warning**: a live check against the selected printer's bed
  and build height, per-printer profiles any tool can query
  ([docs/BUILD-VOLUME.md](docs/BUILD-VOLUME.md))
- Export positioned models as STL (ready to drop into Bambu Studio / Orca / PrusaSlicer)
- Or pick **Format: 3MF** in the Export card and the same two buttons write a
  Bambu Studio `.3mf` project with cooling settings baked in, chosen from a small
  table of named cooling profiles - the whole plate, or the selected piece alone
- **Save and reopen a plate.** A 3MF NSO writes also carries the working scene -
  every piece's position and pose, the position and plate locks, the gap a pair
  was seated at, the skin pattern that made a relief, the painted faces and the
  non-solid flags. Drop that file back in and the plate comes back as you left
  it, not just the shapes. Files from Bambu Studio or MakerWorld have no such
  block and import as plain geometry, exactly as before.
  See [docs/SCENE-3MF.md](docs/SCENE-3MF.md).
- **To plate** (Move menu, beside Raise and Lower) puts a piece back down on the
  bed in one press, whatever put it in the air - a Seat that stacked it 20 mm
  up, a Raise, a target since moved or deleted. It reads the piece's own box, so
  the lowest point of it lands on the bed from any pose; where Raise and Lower
  step 2 mm and rebuild the piece's rotation from the plate record, this keeps
  the rotation and only moves it down. Its place on the plate is untouched and
  one Undo puts it back.
- **Lock position** on a placed piece: a locked piece refuses drag, the nudge
  arrows, Raise/Lower and the pose buttons, so a stray click cannot move it
  once Seat has put it where it belongs. Seat, Center, Align and Skin still
  work on it. Shown by a teal outline and a `locked` tag in the list. Any
  number of pieces can be locked at once - the flag is one per piece - and the
  pieces you did not lock stay selectable, draggable and nestable around them.
  **Optimize plate** packs the free pieces around the locked ones, which keep
  the exact pose and mesh they had.
- **Lock plate** holds the whole current arrangement - every piece's position
  relative to every other - in one action. It refuses the same moves on every
  piece, plus a repack. It is a separate flag, not a shortcut for locking each
  piece: it writes no per-piece lock, so unlocking the plate gives back exactly
  the piece locks you had set.
- **Check piece** runs the canonical mesh checker on the selected piece and
  paints what it finds **on the mesh**, instead of only reporting numbers: red
  lines along open edges, orange along non-manifold edges, red patches on the
  triangles of every self-intersecting (piercing) pair, and violet on every
  face whose wall or gap measures under the 0.42 mm nozzle floor - both sides
  of the thin wall, so it reads as a wall and not as a skin. The status line
  carries the verdict and the counts, including the two it counts but cannot
  usefully paint (inconsistent winding, degenerate triangles).
  - It is the same checker the tools use (`tools/mesh_validate.py`), not a
    second opinion: the numbers are held to it on every fixture in the repo.
  - On demand, and a snapshot. Press again to clear; a bake that changes the
    piece clears it and says so. Moving, rotating or seating the piece keeps
    it - the marks travel with the geometry.
  - A piece flagged **Non-solid** still gets its open edges drawn - you still
    want to see where it is open - they just stop counting against it. See
    `docs/DEFECT-OVERLAY.md`
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
  - **Skin patch** bakes the relief as its own printable piece instead of onto
    a face - a 30 x 30 mm coupon you can test on its own. `bordered` is a
    washer: the pattern inside a solid rim that takes the handling. `loose` is
    the pattern's features alone, no rim and no backing plate. `sandwich` is
    double-sided - the pattern facing outward on BOTH faces with no floor
    between them, which is the piece to use when the coupon goes *between* two
    parts (a bordered washer would present its solid floor to one of them and
    weld on area alone). All of them are in the **Library** tab, ready to load.
  - **crosshatch-fine** is the same lattice at a 0.84 mm pitch instead of 1.2 -
    1.43x the ribs, leaving a 0.42 mm channel, which is exactly one extrusion
    line at a 0.4 nozzle. **0.4 nozzle only**: at a 0.6 nozzle one line is
    0.63 mm and that channel fuses, which is also why the 1.2 mm default stays
    the default. Tighter than 0.84 is not a tuning question - the channel goes
    under one line and the slicer fills it in. The measurements, including why
    the canonical mesh checker cannot see this and what does, are in
    `docs/SKIN-CROSSHATCH-PITCH.md`
  - **Trace a raster into flat printed lines** - **Finish -> Trace raster**, or
    the command line - for the case the reliefs above cannot do: a real printed
    line's section. Pick any picture the browser can open (PNG, JPEG, WebP) and
    the traced lines are added as a NEW piece, flagged Non-solid because every
    wall in it is one 0.42 mm extrusion line. Three traced pieces ship in the
    Library under **Traced Lines**. On the command line,
    `node tools/nso_raster_lines_cli.js pattern.png out.stl --size 30` takes a
    black-and-white picture of a toolpath, vectorises the lines and extrudes
    each one flat and thin - 0.3 mm tall and 0.42 mm wide by default, the
    measured Bambu line, both parameters - into a watertight STL you can drop
    straight back in. Why it exists, in one number: two stacked, 90°-crossed
    copies of the shipped sawtooth relief bond over 0.5040 mm² at every
    crossing, because a standing ridge meets the interface with its 1.20 mm
    base; two traced flat layers bond over 0.1764 mm², in 225 isolated dots
    with no weld anywhere. The reference raster is drawn at 45° to the canvas,
    where a slicer prints it, and the orientation is measured off the shipped
    mesh rather than assumed (`npm run raster:angle`).
    See [docs/RASTER-LINES.md](docs/RASTER-LINES.md)
  - **The crosshatch, as two one-direction layers** (a module, not a button yet).
    The relief above is a lattice that runs ribs *both* ways in one layer, which
    is right against a flat mating face and wrong when it is stacked: turn a
    copy 90° across it and the upper copy's underside is the same lattice as
    the tips beneath it, so **519.75 mm² - the entire tip area - welds in one
    patch**, and no other angle fixes it either (the best is still
    248 mm² in patches millimetres long). `nso_crosshatch.js` builds the same
    pattern the way a printer does - one direction per layer, two layers, the
    second crossing the first - at the same 1.2 mm pitch and 0.42 mm rib:
    **110.25 mm² in 625 isolated crossings**, every one exactly 0.1764 mm², none
    wider than one line's diagonal. Resizing it **re-tiles** rather than scales:
    whole repeats are added or removed and the pitch, the rib and the channel
    stay bit-identical, so every line the smaller pattern had is in the same
    place in the larger one. See [docs/CROSSHATCH.md](docs/CROSSHATCH.md)
- **Delete painted** removes the geometry under the paint, rather than only
  excluding it from bakes. **Paint Selected**, click the face, then Delete:
  **Face** cuts that face out and leaves the rim open, **Face+seal** cuts it
  out and lets Repair close the rim again, and **Shell** takes the whole body
  that face belongs to - which is how a loose blob or a second shell a boolean
  left behind goes in one click. What is pink is exactly what goes, measured
  against the app's own highlight on every fixture.
  - It refuses and leaves the piece untouched if the cut would empty the mesh,
    split it into loose bodies, leave it crossing itself, or - with Face+seal -
    if the rim cannot be closed safely. The status says which and with what
    numbers, and one Undo puts the geometry and the paint back together.
  - **Paint Excluded** still means hands off, here as everywhere else: a target
    that is also painted excluded stands the delete down. See
    `docs/PAINT-DELETE.md`
- **Photo set** checks a photogrammetry capture against the capture contract
  *before* any reconstruction time is spent on it. Drop the whole shoot in and
  it grades every clause it can: the 93-frame shot list and its six passes,
  duplicate frames, and the fixed-optics rules off EXIF - one focal length, one
  lens (it catches a phone flipping to its ultra-wide), fixed aperture, ISO,
  shutter against the hand-hold limit, no flash, no HDR / portrait / night
  mode, one frame size, one camera body, one continuous session - plus a focus
  outlier statistic and a subject-framing estimate measured off the pixels.
  - **It is explicit about what it cannot know.** Eleven clauses are ticks you
    confirm, not checks it runs, because no amount of image analysis settles
    them: diffuse static lighting above all - a shadow fixed to the object and
    one fixed to the camera look identical in any single frame - and the scale
    reference, whose *length* is knowledge you have and the photograph does
    not. An unticked box blocks "ready" exactly as hard as a failure. A missing
    EXIF tag reads `NO DATA`, never `PASS`.
  - **It reconstructs nothing.** No COLMAP, no Meshroom, no hosted API, no
    network call at all - the photos never leave the browser. The five
    post-reconstruction gates from the contract are listed unanswered rather
    than quietly omitted. It ends at "this set is worth a reconstruction's
    time". See [docs/PHOTOGRAMMETRY-ONRAMP.md](docs/PHOTOGRAMMETRY-ONRAMP.md)
    and the contract it implements,
    [docs/PHOTOGRAMMETRY-CAPTURE.md](docs/PHOTOGRAMMETRY-CAPTURE.md).
- **Microscope** (the 🔬 button in the viewport's bottom-left rail) opens a
  file in its own inspector instead of onto the plate, and hands a selection
  back out. It takes an **STL**, a **3MF** or an already-sliced **`.gcode.3mf`**,
  and which route a 3MF takes is decided by what is inside it, never by its
  name.
  - A sliced project draws as its toolpath, one colour per `; FEATURE:` group
    the slicer named, with the legend built from the groups the file actually
    has. Click a row to isolate that feature.
  - **Two ways to select.** Drop a **capture box** on the model and drag it:
    the blue centre dot moves it, a side resizes the footprint, and the small
    orange dot on top sets how *thick* it is - a separate control from the
    footprint, so you can reach across the plate without dragging in twenty
    layers you did not want. Or take a **whole layer** at one printing height,
    every feature at that height included.
  - **Two ways out, and they write the same geometry.** *Export to plate*
    closes the microscope and drops the selection into the main viewport as a
    standalone piece with Undo wired; *Export as STL* downloads just the
    selection.
  - A plain STL or 3MF is not sliced, so it has no layers and no features: it
    draws as one whole part per build object (an STL is always exactly one),
    the capture box selects whole parts, and the layer control is **disabled
    with the reason on screen** rather than inventing a layer height the file
    never stated. See [docs/GCODE-MICROSCOPE.md](docs/GCODE-MICROSCOPE.md).

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
  3MF **import** reads geometry - every object in the file, with its transforms
  applied, becomes a model - and, when the file is one NSO wrote, the scene
  block that restores the whole plate (`docs/SCENE-3MF.md`). Print settings,
  materials and colours in the file are still ignored. Tested against files
  Bambu Studio wrote as well as NSO's own exports - see
  `docs/baked-cooling-settings.md`, "3MF import".
- The eye button in the viewport's bottom-left corner turns on a live watch:
  it logs errors, failed loads and NSO's own status and refusal lines, and
  after every Undo, bake and tool switch it checks the scene you are looking at
  against the app's own idea of what is on the plate, flagging any mismatch on
  the spot. Off by default, and it never changes anything it finds - see
  [docs/WATCH.md](docs/WATCH.md).
- The packing algorithm is a solid bottom-left free-rectangle packer with rotation. It will improve over time.
- The build-volume warning answers **"does it fit the machine"** and nothing
  else. It is not a printability check - bridging, wall thickness and severed
  connections are separate concerns with their own checks.

## Future ideas

- True multi-file zip export
- Better 3D nesting heuristics
- Overhang angle estimation for smarter orientation scoring
- Save / load packing projects
- Direct “Send to Bambu Studio” style workflow

Built for the FormKeep / Etsy production workflow and anyone else who hits the same wall.

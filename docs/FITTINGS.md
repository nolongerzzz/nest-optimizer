# Fittings — a slip-on Cap and a 2- or 3-way Splitter

`nso_fittings.js` (headless, THREE-free), `app-fittings.js` (the card), in
**Gen+ > Fittings**. Both make a **new piece** on the plate, selected, beside
whatever was selected. Neither edits the selected piece, and neither is "an
addition to" it: the cap is sized *from* a tube and goes on by hand; the
splitter can be made with nothing selected at all.

```
node tools/nso_fittings_test.js          headless: 114 checks, rays through the output, mesh_validate on each
node tools/nso_fittings_drive_check.js   the real card: Cap, both splitters, Undo, refusals
```

`npm run fittings`, `npm run fittings:drive`.

## Cap — the pipe cap a plumber means

Select a tube, **Cap for selected tube**. The cap is the open-ended cup that
slips over the tube's end:

| | |
|---|---|
| **bore** | the tube's outside Ø + 2 × **Fit** (radial clearance, default **0.25 mm**, a printed slip fit) |
| **wall** | the tube's wall, read off its end |
| **closed end** | the tube's wall too |
| **Deep** | how far the tube goes in; default 0.75 × the tube's Ø, 8 to 30 mm |
| **End** | Top or Bottom of the tube (the cap reads that end) |

One solid of revolution, **closed end down on the bed, open end up**: it
prints without support. The meridian is laid out on the **apothem**: a 96-gon's
flats sit `R·cos(π/96)` inside its corners, so the bore's *flats* clear the
tube by the Fit — not its corners (measured: the clearance from the tube's
widest vertex to the bore's flats is 0.250 mm, on a Stock tube and on an
imported 48-sided one).

The tube's Ø and wall come from `NSO_tubeEdgeRead`, Tube edge's own reader, so
"a round open end" means what it means there. Refused in words, nothing added:
no tube selected; a closed end or a non-round one (the reader's words and
*"A cap fits the open, round end of a tube."*); a wall that **leans** more than
2° at the end (a flare or taper: a cap slips over a straight pipe); a wall or
end under the nozzle-safety floor; a negative Fit; a Deep of 0.

## Splitter — one trunk into 2 or 3 branches

**2-way** and **3-way** buttons. A trunk along +Z from the inlet (flat on the
bed) to the junction; the branches leave the junction **Angle** off the
trunk's axis (default 35°, allowed 10° to 80°): two in a plane (a Y, ±Angle),
three 120° apart round the axis. Outlets are square to their own axes and
open. Printing orientation is the model's: trunk down, branches up and out.

Fields (blank = the placeholder shown = the default): **Ø** trunk outside
(20), **Wall** of every run (2), **Branch Ø** (¾ of the trunk's for a 2-way,
⅔ for a 3-way), **Angle** (35), **Trunk** length (25), **Branch** length (30).
**Ø from tube** copies the selected tube's Ø and wall into the first two, so
the trunk matches a pipe — afterwards they are plain numbers.

**Hub and spoke.** Outside: the trunk's cylinder, each branch's, and a sphere
at the junction as big as the largest of them. Bore: the same, one wall
smaller. `solid = union(outside) − union(bores)` on the app's own Manifold
kernel (`nso_csg.js`, the same one Join and Carve use). Every cylinder's axis
passes through the junction, so each end disc lies inside the hub and nothing
is left between them. The wall is the wall in the straight runs and in the
hub. The bores of neighbouring branches merge into the hub's chamber and part
again where they separate, leaving a knife edge between them inside the crotch
— as in a moulded Y.

**Gates**, on the kernel's own result: `NoError`, not empty, **one body**, and
**genus = openings − 1** (a thickened sphere with 3 or 4 holes). A hub that did
not merge, a branch that did not open, or two outlets fused change that number.
In the tests the Euler characteristic is checked too: **4 − 2 × openings**
(−2 for a 2-way, −4 for a 3-way).

**Refusals**, before anything is built: a wall under the nozzle-safety floor; a
trunk or branch bore under 2 nozzle widths (the message gives the least
outside Ø); an angle outside 10° to 80°; **outlets that would touch** — they
must stand 1 mm clear — with the length that would fix it (*"Make the
branches at least 38.5 mm long…"*; that length is tested to build).

## Numbers (`tools/nso_fittings_test.js`)

Measured on the output by rays through the mesh, across each run at a height where
both its cylinders have a vertex, so the two crossings are exact: the trunk is Ø20 / bore Ø16 and each branch Ø15 /
bore Ø11 (Ø13 / Ø9 on a 3-way) to 2 µm; the axis ray from the open inlet meets
the bore's end and the outside's at the hub-or-crotch heights the geometry
gives (`max(hub r, branch r / sin angle)`); the inlet is at z = 0; the high
outlet corner is where trigonometry puts it; each outlet is open (nothing
crossed from the junction out along its axis). Six more sizes and angles
(20° to 80°, Ø12 to Ø30, walls 1.2 to 2.4) pass the same gates.

## Threaded ends

Plain ends are the default. **Threaded ends** - a male or female thread on the selected tube's sleeve, nipples, couplers, adapters, plugs and
screw caps, and male / female ends on the splitter's trunk and branches - are in [THREADS.md](THREADS.md). `npm run fittings:thread`. The
splitter's ends are checked for fit (a spigot's root must reach into the run's wall, a socket must leave the hub and its neighbours room)
and refused in words when they do not.

## Flags — not in the ticket

- **Plain ends by default.** The splitter's trunk and branches are plain pipes of the Ø
  you ask for, so a tube joins it with the Join / Connect tools or a sleeve. Threaded male
  and female ends are now an option ([THREADS.md](THREADS.md)); slip-over / slip-in (unthreaded)
  socket and spigot ends are still not here.
- **"Splitter" means one in, N out**, radially symmetric, same wall
  everywhere. A T (two outlets opposite each other at 90°) is a 2-way at 80°,
  the nearest it goes; a true cross or an asymmetric manifold is not here.
- **The inside is a hub chamber, not a smooth blend**: the dome over the
  junction is an overhang of up to the angle's complement, and the crotch
  between bores is thin (it is a knife edge, not a wall).
- **Needs the network once**: the splitter's kernel loads from the same CDN
  Join and Carve use (the tests and drive check serve it from `vendor/`).
- **No printer gate yet.** Stock refuses a block the plate cannot hold; a
  fitting only says if it sits past the edge. A 3-way at the defaults is about
  47 mm across.

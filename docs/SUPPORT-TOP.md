# Where a support stops - the top Overhang-wall layer

**The rule, read off Bambu's own slice of the six reference heads** (`fixtures/supports/tree_slimsupports.gcode.3mf`): a head's support runs up to the
top layer that has *Overhang wall* - its last line 0.2 - 0.4 mm under it - and nothing above, because what is printed above that layer has
something under it. Measured, per head (top Overhang-wall layer / last support line, mm):

| head | overhang top | support top |
|---|---|---|
| Base | 15.20 | 14.80 |
| Oblique | 12.60 | 12.20 |
| Circular | 15.20 | 14.80 |
| Sphere | 15.20 | 14.80 |
| Negative Sphere | 15.20 | 14.80 |
| Negative Sphere2 | 15.40 | 15.20 |

`npm run support:top` (`tools/nso_support_top_check.js`) builds the six heads with the card's defaults (raft off - the Raft interface is its own
support type and takes no part in this), slices them with our slicer, and sets both against Bambu's. `NSOMeasure.reach` (`nso_gscope_measure.js`)
is the number it reads: per head, the top Overhang-wall layer, the top support / interface / transition line and the gap between.

Two things are measured, and they fail for different reasons:

1. **The classifier** - our slicer's top Overhang-wall layer against Bambu's, and how much overhang wall it finds in all. A support cannot reach a layer
   our slicer never calls an overhang, and one that calls too much asks for more than Bambu's does. Held to 0.4 mm on the top layer and to 0.8 - 1.3 x
   Bambu's overhang length on all six heads.
2. **The support** - its top against the overhang's top. The *goal* is Bambu's 0.2 - 0.4 mm (a note where it is not met); the *floor*, 2.2 mm, fails.

## What was wrong, and what was changed

**The classifier** judged each wall edge at its midpoint only (`splitOverhang`, `nso_slicer.js`). The Circular, Sphere and Negative Sphere heads end
in a square head on a round post: the top layer's front edge is 5 mm long, its midpoint sits over the post, and 0.5 mm at each end hangs over air.
Bambu calls those ends Overhang wall (15.2); ours were never found (11.0 / 13.4 / 14.4). An edge is now judged along its length, at `overhangSubMm`
(0.2 mm) steps, and cut where the flag changes. A looser threshold (a share of the line's width past the layer below) was tried and rejected: it
doubles the overhang length on Oblique, whose per-layer length the midpoint rule already matches (10.2 against Bambu's 10.3 mm).

The classifier also called a wall overhang as soon as the line's *centre* hung past the layer below; Bambu does when the line's *whole width* hangs. On the
four dome heads that made ours 2 - 4 times too long (Circular 166 mm against Bambu's 44; the layers up the dome's flank where Bambu has none).
`overhangEdgeFrac` (1: the wall's inner edge is the point judged) is Bambu's: overhang length 43 / 40 / 100 / 78 mm against its 44 / 40 / 95 / 84 on Circular, Sphere,
Negative Sphere, Negative Sphere2; Base and Oblique stay within 10 % (67 against 66, 206 against 187).

**The generator** did not hold those ledges at all, for two reasons, both in `nso_support_beacons.js` and both off unless the card asks:

- `bridgeMinMm` (card: 1.3): a flat face between two walls closer than this is a ledge, not a span anything bridges. The ledges lie 0.2 - 1.2 mm from the
  flank wall and the post, so the bridged-within-5-mm exemption dropped them.
- the finer look (`seedPitchMm`, 1 mm) steps over a ledge 0.7 mm across; with `bridgeMinMm` set a second look at 0.5 mm keeps only ledges
  (`LEDGE_PITCH_MM`, capped at 400 000 cells), and a ledge's footprint is held from 0.15 mm2 (`LEDGE_MIN_AREA_MM2`; a speck is 1.5).

Circular's support went from stopping at 8.8 to 13.4 mm, Sphere's from 9.6 to 13.4. The other heads' bytes are unchanged
(`support:plate` pins Circular and Sphere anew).

## The tapered tip for a ledge, and what is still short

On the ledge heads the column was a flat-topped 1.2 mm square and the flank wall stands 0.2 mm from the ledge it holds: from 13.5 up the column touched the
part, so `settleCut` lowered it until it kept the 0.18 mm gap (Circular's two columns stopped at 13.8 and 13.6, a mm and a half under the ledge at 15.3).
Bambu's tower tapers to a point there and goes on up. `needleOf` (`nso_support_gridpack.js`) is that point: from just inside the settled column's top, a
straight frustum - 1.2 mm square down to 0.4 (0.32 if that is too wide) at the top - aimed at the contact, else straight up, the highest one whose own solid keeps
the gap. Circular and Sphere now stop at 14.8, which is Bambu's (support top 15.1 as built, 0.2 under the ledge). `npm run support:top` holds both to the goal.

| head | support top | under Bambu's overhang top |
|---|---|---|
| Negative Sphere | 13.6 (the cone is built to 14.5; the slicer drops the last of it, narrower than a line) | 1.6 |

The Negative Sphere's apex is a cone, not a ledge: its tip narrows below a bead's width at 13.6 and the slicer lays nothing there. It is the next piece of
work, and is still held only to the 2.2 mm floor.

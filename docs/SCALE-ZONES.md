# Scale zones — scale part of a piece, keep the rest

`nso_scale_zones.js` (headless) · `app-scale-zones.js` (the section) · UI: the
**Scale zones** button at the foot of the **Scale** card, under Feature size ·
tests: `npm run scale:zones` (node), `npm run scale:zones:drive` (drive)

## Why

The owner's ask (2026-11-28): "a scale blocker / enforcer of some sort, so I
can scale individual parts of a model while keeping another". Three examples,
on three of the owner's files:

- a shower head (`NUOVO_SOFFIONE_SOCCIA_.3mf`): the head bigger, the threaded
  fitting kept;
- a thumb screw (`bullone.stl`): the knurled head bigger, the thread and shaft
  kept;
- a stringing test (`Stringing_Test.3mf`): one pillar up or down, everything
  else untouched.

Scale resizes the whole piece and Feature size one flat-footed tab or slot;
nothing kept one part while another scaled.

## Using it

1. Select the piece, open **Scale**, press **Scale zones**. The piece turns to
   a ghost; zones put on it before are back.
2. **+ Keep**, then **click what must not change** — a thread, a fitting, a
   shaft. A red **Keep** zone is fitted round that part (below). Nothing inside
   a Keep zone moves, ever.
   **+ Scale**, then click the part to resize — a head, one pillar. A blue
   **Scale** zone is fitted round it; only what is inside a Scale zone changes.
   With no Scale zone at all, everything outside the Keep zones scales.
   **Shift-click** puts a plain box at the click instead of fitting one.
3. A zone can be **dragged** (press on it), **stretched** by its handles (a
   box: one per face; a cylinder: its two ends and its side), or typed: its
   row in the list picks it, and Keep | Scale, Box | Cylinder, the axis, its
   sizes and its centre are boxes under the list. **Delete** (or the ×, or the
   Delete key) takes it away.
4. Type a **Scale %** or move its slider; **Per axis** gives X, Y and Z (the
   piece's own axes, Z up as it was loaded) their own. The green ghost is the
   result; the pink dot is what stays put. The piece is not touched.
5. **Set** (or Enter) bakes it — one Undo (`scaleZonesReplace`). The section
   stays armed, back at 100%, and a Scale zone moves with its part so it still
   holds it. **Cancel** (or Escape) drops it. The zones stay on the piece
   (`m.scaleZones`) for next time.

**Anchor** — what stays put while a part scales:
- **Join** (the default): where the part meets what is kept — the middle of
  the points where its edges cross the zone's skin. The neck of the shower
  head, the underside of the screw's head, the foot of the pillar. The joint
  does not move; the part grows out of it.
- **Centre**: the middle of the part's own box.
- **Base**: the middle of the bottom of its box.

**Blend** (mm): 0 steps at the zone's skin. More eases the change in over that
distance from the skin (smoothstep), so the joint tapers.

The section follows the card's **mm | in** toggle. Touching the card's own
rows, or Feature size, puts it away, and arming it drops theirs: one ghost at
a time.

## How it scales

Every vertex gets a weight: 0 inside (or on) a Keep zone — Keep wins over
Scale; 1 inside a Scale zone, or everywhere outside the Keep zones when there
is no Scale zone; eased in between with a Blend. The vertices that move fall
into **parts**, joined by the piece's own edges — and in Scale-zone mode only
within one zone, so two pillars in two zones are two parts. Each part is
scaled about its own pivot (the Anchor): `p + w (pivot + F (p − pivot) − p)`.

**Same triangles.** Nothing is cut or added. The triangles that cross a zone's
skin stretch to join the two sizes — the screw head's flat top between the
kept thread root and the grown rim, the base round a grown pillar — so a closed
piece stays closed. Each corner moves from its own coordinates, so a kept
corner is the same bit for bit.

## Fitting a zone to a click

The cross-section through the click, square to each of the piece's axes, is
cut; the loop the click is on gives the part's middle (taken over the sections
a few mm either side, since one section of a single-start thread is off its
axis by up to the thread's depth) and its radius. The section is then walked
along the axis while it keeps that size (within 2%), and stopped where it jumps
— a shoulder, a collar, the head, the plate a pillar stands on — or ends; the
stop is found to 0.001 mm. A round section gives a **cylinder** just over the
part (+3% or 0.15 mm); any other a **box**. A round fit wins over another;
among the same kind, the more slender.

On the owner's files: the thumb screw's thread → a Keep cylinder Ø10.15 × 20.0,
from the head's top to the shaft's end; the shower head's thread → Ø21 from
its collar up (a click on the collar takes collar and thread, Ø24.6); a pillar
→ a cylinder Ø3.3 from the base's top to its own.

## Refusals, all in words, nothing changed

- no zones; the Keep zones hold everything; no part is in a Scale zone;
- a factor outside 5% – 2000%;
- **folds**: a face turned inside out (or flattened) where the scaled part
  meets the kept one — the screw's head shrunk past the shaft it joins, a
  pillar grown over the plate's next vertex. Scale less, add a Blend, or move
  the zone's edge;
- **pierce gate** (the app, at Set): a part grown INTO another part of the
  piece. `NSO_Repair.inspect` counts the piercing pairs among the triangles
  near the move, before and after; more after is refused. Above 120 000 such
  triangles (the whole 224 000-triangle shower head, for one) the check would
  take seconds, so it is not run, and the status line says so;
- a painted piece (PAINT SCOPE: WHOLE-PIECE, as Feature size).

## Measured on the owner's files

- `bullone.stl` (28 376 triangles): + Keep on the thread, 150%: the head
  20 → 30 across, 12 → 18 tall, grown down from the thread's root; the thread
  untouched; mesh still closed; no piercing (0 → 0).
- `NUOVO_SOFFIONE_SOCCIA_.3mf` (223 866 triangles): + Keep on the collar
  (collar and thread), X and Y 125%, Z 100%: the tube 30 → 37.5 across, its
  length kept; the Ø10 bore follows the tube and tapers back to Ø10 inside the
  kept fitting. Index 0.25 s, fit 0.2 s, a preview 0.1 s; Set ~4 s in the app.
- `Stringing_Test.3mf`: + Scale on one pillar, 200%: that pillar Ø3 → Ø6,
  20 → 40 tall from the base's top; the other pillar and the base untouched.

## Not done

Zones are boxes and cylinders along the piece's own axes (no tilted zone);
the Blend eases by distance, so on a long triangle (a pillar's side with no
vertex between its ends) there is nothing in the band to ease. A Scale zone
carried after Set uses its part's pivot; Undo puts the piece back but not the
zone.

# The printability gate, and the column interface rule

`tools/nso_support_gate.js` (`npm run support:gate`), its measuring core `tools/nso_support_gate_lib.js`, and the slicer option
`supportInterfaceRule: 'column'` in `nso_slicer.js` (`columnRule`, `columnLoops`, `columnType`). G-scope's Slice settings carry it as
**interface: sheet / column** (remembered in the browser, used by Export print too).

## 1. Why

The interface is what has to print and break away. Until now the support work was scored by how closely our lines overlay Bambu's
(`support:score`, IoU per head). On the six heads of `supp_ref`, overlay is a poor guide:

- Each curved head crosses layer boundaries at a different place, so a constant tuned for one head moves the others. The
  2026-10-30 to 11-07 commits are about forty such per-head constants (`REGION_TALL_TRY_MM`, `REGION_BEAD_SHARE`, `CAVITY_EXTRA_LAYERS`, ...).
- Two owners drew the interface. The generator built a sheet mesh 0.18 mm from the mesh surface; the slicer then re-drew plates per
  layer, typed by host proximity with an exact-cut exception. Each corrected the other.
- A gap of 0.18 mm measured square to a curved or sloped surface is not a layer of air once a slicer cuts it into layers. On the
  Sphere both NSO's slicer and Bambu's slice of our meshes printed interface lines with no air under the part's next layer
  (about 6 mm2), and the existing gates passed because they measure the mesh.

## 2. The gate

Measured on G-code, every head at once, each against Bambu's own slice of the same head
(`fixtures/supports/tree_slimsupports.gcode.3mf`). Lines are drawn at their width into 0.1 mm cells; Bambu's arcs (G2/G3) count.

| check | what | rule (against the reference's own number for the head) |
|---|---|---|
| contact area | the part's underside with support within 0.6 mm under it | >= 0.9 x ref |
| touch mm2 | support lines with under 0.05 mm of air under the part's next layer: they weld | <= ref + 0.5 |
| one-layer gap | share of the contact area with one layer of air (0.15 - 0.25 mm) | >= ref - 10 points |
| two-layer gap | share with two layers of air (0.35 - 0.6 mm): the underside sags | <= ref + 15 points |
| floating islands | support islands of 0.3 mm2 or more with nothing within 0.35 mm under them | <= ref |
| empty layers | a support with no line on a layer between two it prints (Bambu's warning) | <= ref |
| sheet carried | (labelled slices) share of each sheet's lowest layer within 1 mm of support below | >= ref - 10 points |
| depth III+T | (labelled slices) share of contact columns that read interface x3 or more, then transition, top down | >= ref - 15 points |

Specks (support islands under 0.8 mm2 under a sheet: tips too thin to hold it) are printed, not gated.

**Parity** (printed, not gated): each of the reference's interface / transition layers set against ours at the same height (within 0.1 mm),
lines drawn 0.5 mm wide so a plate's lines are one area, in one frame by the parts' centres - plate IoU, the same with the type matched, and
the share of the reference's layers we have a layer at (within 0.03 mm). `--worst` lists the five layers per head that differ most and the
columns' make-up top down (I interface, T transition, S support).

    node tools/nso_support_gate.js                              build supp_ref with the card (Auto, Dense, 30 deg), slice with NSO_Slicer, gate
    node tools/nso_support_gate.js --rule column                the same with the column rule
    node tools/nso_support_gate.js --gcode a.gcode.3mf ...      gate sliced files: NSO's export, or Bambu Studio's slice of NSO's meshes
    --report (never fail)   --json out.json   --dump moves.json (a build's moves)   --ref other.gcode.3mf

A file is read by its objects' names: `X` is a part, `X - support ...` its support, `X - brim` left out; inside a part, `Support*`
features are support (Bambu's own). About 40 s for a build, 3 s for files.

## 3. Measured (2026-11-08)

Printability (the gate) and parity with Bambu (`support:gate` prints both; parity is reported, not gated):

| head | sheet typing, the owner's slice: gate / plate IoU | column rule: gate / plate IoU / type IoU / layer heights met |
|---|---|---|
| Base | passes / 96 % | passes / 98 % / 98 % / 100 % |
| Circular | touch 0.5 mm2, contact 34 / 38 / 85 % | passes / 91 % / 91 % / 100 % |
| Negative Sphere | contact 49 / 57 / 66 % | 3 floating twigs of the generator's tree at z 11.9 / 91 % / 90 % / 100 % |
| Negative Sphere2 | contact 23 / 47 / 59 % | contact 41 / 47 (the apex flank ring, z 14.1 - 14.3) / 83 % / 83 % / 100 % |
| Oblique | touch 1.5 mm2, a floating island / 84 % | passes / 87 % / 87 % / 100 % |
| Sphere | touch 5.9 mm2, one-layer 43 %, depth 0 % / 68 % | passes / 85 % / 84 % / 100 % |

Under the column rule no line touches the part on any head, every sheet is carried, and the layer heights are Bambu's. The owner's Bambu
Studio slice of NSO's meshes (no labels) fails on the Negative Sphere's apex floating on nothing (empty layers 12.0 - 12.8), the Oblique
stair mesh a layer low (78 % of its contact under two layers of air) and the Sphere touching.

## 4. The column rule

The interface is read off the part's own layers, column by column, as Bambu lays it - one owner, no constant per head:

- **blocked** at support layer i: the part at the layer's own height grown by the xy distance (`supportXyMm`, 0.35, Bambu's
  `support_object_xy_distance`), and the part whose underside is less than the gap (`supportGapMm`) over the layer's top.
- **contact** at layer i: where the next layer up would be blocked.
- **footprint**: the part's overhang at the threshold angle (a layer's section past the one under it by more than a layer / tan(angle);
  a piece of a section smaller than a bead is not printed and is no overhang), grown 0.38 mm - Bambu's interface loop runs 0.17 mm past the
  face's edge, measured on the Base - each region taken whole where the generator's support serves it (meets the support within reach
  under the part). A dome's steep flank is not an overhang: the tree's to hold.
- **contact** reaches past an overhang's edge by the same 0.38 mm (not past a wall). Past the edge a column can be a contact on two
  neighbouring layers: both stand their stacks, 4 interface layers in that column, as Bambu's own do on a slope or a dome (13 - 24 %).
- **rank**: a column's layers counted down from its contact through the layers it is not blocked on: 0 - 2 interface, 3 - 4 transition.
- **base**: under the stack a column runs on down as Support until it stands on the support's own material, at most 3 mm; a column that
  lands nowhere is dropped, with what stood on it. The base gets a zig-zag at 2 mm (the transition spans no more).
- Every layer of the support is cut to it before its paths are built (the section less blocked, plus the stack and the base); the stack
  is laid as one loop half a line in and a zig-zag at a line + 0.04 mm (Bambu's 0.46), the first layer of a stack at 110 deg then
  45 / 135. A piece narrower than a line (a dome's or a cone's ring of contact) is one loop down its middle, and only where its bead stays
  out of the part and from under it.

Measured against Bambu with Bambu's own footprint given (the rule alone deciding heights and types): Base 0.95, Circular 0.82, Negative Sphere
rim 0.69 - 0.74 and apex 0.6 - 0.82, Oblique 0.70, Sphere 0.56 IoU per layer. It reproduces Bambu's hole round the Sphere's pole that widens
a layer at a time.

## 5. Not done, and named

- **The rule is opt-in and not printed.** Default slicing is unchanged byte for byte (`slicer:test`, `slicer:bambu`, `slicer:supports`,
  `support:onetrunk` pass). The gate in build mode fails today's default on 7 checks, so it is not in the CI list yet.
- **The generator still builds its sheet.** Under the column rule its sheet material outside the stack prints as Support (pale rings round
  the Sphere's stack at 8.3 - 9.4). The generator should hand over only the tree and the tips' tops.
- **The tree**: specks (Oblique 8, Negative Sphere 2), the Sphere's leaning twig, Bambu's flank tips. Size and shape, not the interface.
- **Exported meshes** do not carry the rule: Bambu Studio slicing NSO's meshes still sees the generator's sheet. The rule's stack as one-layer
  prisms in the export would make Bambu print the same layers.
- A thin contact ring on the Sphere's flank (z 10.2 - 10.4) where Bambu's interface ends at 10.0.
- `NSO_COLUMN_DEBUG=<z>` prints the rule's per-layer areas above z.

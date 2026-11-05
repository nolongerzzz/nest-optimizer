# Silent Key Hub

A pivoting key organiser. Each key hangs from its own station, and you flip
it out to 90° to use it. A printed leaf spring holds it in both positions.
This is a parametric, printable version of the "Silent Key Hub 2.0" concept
render, with changes that make it work as a real part.

| file | what |
|---|---|
| `keyhub-model.js` | the model: parameters, derived numbers, CSG build (manifold-3d), clearance sweep, print orientation |
| `index.html` | interactive viewer: animate the keys, section and explode views, change parameters, live checks |
| `build-stl.mjs` | builds, checks and writes print-oriented STLs to `stl/` |
| `make-artifact.mjs` | bundles the viewer into one self-contained HTML file (`dist/`, not committed) for publishing |
| `stl/` | STLs at default parameters |

## Build

```bash
node designs/silent-key-hub/build-stl.mjs
```

Change parameters by passing `key=value` (names are in `PARAMS` in
`keyhub-model.js`, and the viewer's **Copy changed parameters** button gives
them to you):

```bash
node designs/silent-key-hub/build-stl.mjs stations=6 keyHeadWidth=26
```

The script exits non-zero if the swing check finds a collision or a
lint rule fails.

To run the viewer from the repo, serve the repo root and open
`/designs/silent-key-hub/index.html`. It loads `vendor/manifold`.

## How it works (one station)

- **Carrier**: a rounded-square cam on a 3 mm steel dowel, with a fork below
  it. The key's ring hole sits between the fork cheeks, and an M2 screw or
  2 mm pin goes through both.
- **Detent**: a leaf spring printed into the hub roof rests on the top flat
  of the cam. Turning the key lifts the leaf 1.34 mm as a cam corner passes
  under it, then the next flat clicks in. The coloured tab on top of the hub
  is the tip of the leaf.
- **Stops**: at 0° the fork's back face meets the slot's back wall. At 90°
  its top face meets the hood over the slot mouth. The stops take the load
  when you turn the key in a lock, not the detent.
- **Assembly**: put the dowel through the carrier, slide it up the slot from
  below so the dowel ends run in the wall grooves, then fit the retainer
  plate. Its fingers fill the grooves under each dowel. The M5 eye bolt
  through the centre clamps the plate with a washer and a nyloc nut.

## Printing

PETG (or ABS/ASA). PLA works but the leaf springs will slowly take a set.

- Hub: upside down (top face on the bed). The leaf springs print first, and
  the slots and grooves open upward. No supports.
- Retainer: plate on the bed, fingers up.
- Carrier: standing on the cam's top flat with the fork pointing up, so the
  cheeks print as walls. Use a brim.

## Changed from the concept render

1. 8 stations with keys edge-on. The render shows 10 tabs from the top and
   keys facing outward. Eight 24 mm heads facing outward need about 200 mm of
   rim, and a 64 mm hub has about 170 mm.
2. A printed leaf spring replaces the coil spring and plunger.
3. Real hard stops at 0° and 90°.
4. Pivot dowels load from below and a retainer holds them. A tangential pin
   can't be fitted from outside a ring of slots.
5. A steel eye bolt replaces the printed bail ring, which would split along
   the layer lines.
6. The key is held by its ring hole instead of a clip shaped around the head.

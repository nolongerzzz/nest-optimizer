# Functional-feature fixtures

One known-clean hull (a 120 × 70 × 40 mm box resting on z = 0) with real
functional features on it. Each feature is built by `tools/nso_features.js`
from its own geometric definition (see `docs/FEATURES.md`). This follows the
convention of `fixtures/damage/`: the name is `<hull>_<what>.stl`, the STL
header starts with `NSO feature fixture:`, and every file is generated rather
than hand-made.

```sh
node tools/nso_features_make_fixtures.js           # rewrite them (and the nest-library copies, given a checkout)
node tools/nso_features_make_fixtures.js --check   # byte-diff against the tree
node tools/nso_features_test.js                    # hold every file to features.json
```

`features.json` records these for every feature in every file:

- its parameters;
- its **root** (where it meets the hull) and the root's area;
- its **cell** (the box that holds it and nothing else);
- its volume and what it adds to the topology;
- its own ground truth (thickness, band and reach for a flange; clearance
  for a handle; the axis and swing for a hinge; and so on).

It also records `expected`, the exact numbers `tools/mesh_validate.py --json`
must report, and `detectors`, what each detector must find: `flange`
(`nso_flange.js`) and `handle`, `bracket`, `lid` and `hinge`
(`nso_face_features.js`, `docs/GSCOPE-FEATURES.md`).

| file | tris | on the hull | χ | shells | detected | Library |
|---|---|---|---|---|---|---|
| `feature-hull_all.stl` | 2036 | all five: a flange on −Y, a handle on −X, a bracket on +X, a lid on top and a hinge on +Y | 0 | 3 | one of each | yes |
| `feature-hull_flange.stl` | 28 | a 2.5 mm plate, 15 mm out along a straight 60 mm root | 2 | 1 | flange | yes |
| `feature-hull_handle.stl` | 1216 | a round-rod arch (8 mm rod), 21 mm clear, with its feet 50 mm apart: genus 1 | 0 | 1 | handle | yes |
| `feature-hull_bracket.stl` | 64 | a 3 mm gusseted angle with a 20 mm arm, fused flat by its 40 × 30 plate | 2 | 1 | bracket | yes |
| `feature-hull_lid.stl` | 56 | a lid seated on a 60 × 40 × 15 pocket, its plug 0.5 mm clear all round: one enclosed void | 4 | 2 | lid | yes |
| `feature-hull_hinge.stl` | 720 | a print-in-place knuckle hinge, 0.5 mm radial and axial clearance: two bodies | 0 | 2 | hinge | yes |
| `feature-hull_angle-unbraced.stl` | 44 | the bracket without its gussets. By the flange rule its arm **is** a flange | 2 | 1 | flange (not bracket) | |

Every file passes the checker (0 open, 0 non-manifold, 0 piercing). "Shells"
counts closed surfaces. The lid's second shell is its void. The hinge's second
shell is its moving leaf, a separate body.

The six Library files are also in
[nest-library](https://github.com/nolongerzzz/nest-library), listed under
**Test Fixtures**. `features:test` byte-compares them against this directory
when there is a nest-library checkout, and SKIPs that comparison out loud when
there is none.

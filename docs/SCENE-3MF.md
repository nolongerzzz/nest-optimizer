# Saving the plate in the 3MF

A 3MF NSO exports is a Bambu Studio project: geometry, the baked cooling
settings, and nothing about the session that produced it. Reopen one and you
get the pieces back placed but unconfigured — no locks, no seat gaps, no paint,
no record of which pattern made the relief you are looking at.

This adds one more OPC part to the archive NSO already writes:

```
Metadata/nso_scene.json
```

Export writes the whole working plate into it. Import, finding it, rebuilds
that plate instead of just loading the shapes. A 3MF without it — one straight
from Bambu Studio, from MakerWorld, or an older NSO export — imports exactly as
it did before.

The point is local persistence that does not depend on Bambu Studio's project
management: save your plate, reopen it, carry on.

## Where it sits, and why there

| part | owns |
| --- | --- |
| `3D/3dmodel.model` | geometry, one object per piece, in plate coordinates |
| `Metadata/project_settings.config` | the baked cooling keys, and only those |
| `Metadata/model_settings.config` | Bambu's own object and plate naming |
| `Metadata/nso_profile.json` | NSO provenance (generator, cooling profile) |
| `Metadata/nso_scene.json` | **the scene — everything below** |

Same reasoning as `nso_profile.json`: Bambu Studio warns on keys it does not
recognise, so `project_settings.config` keeps the confirmed cooling keys and
nothing else. NSO's own bookkeeping lives in its own part, under a name nothing
else claims. A slicer that does not know the part ignores it.

`nso-3mf-scene.js` owns the schema and the transform maths. The writer
(`nso-3mf.js`) stores the bytes it is handed; the reader (`nso-3mf-read.js`)
hands them back verbatim as `result.sceneJson` and does not interpret them.

## What a piece carries

Nothing here is re-derived. Each value is read through the accessor its own
module publishes, so there is one definition of it and the file cannot drift
from the app:

| in the file | in the app | published by |
| --- | --- | --- |
| `position` — x, z, lift_y, overflow | the placed entry's own fields | app-core.js |
| `pose` — rot_y, yaw, flip_x, tip_x, tip_z, tilt_x, tilt_z, rotated | ditto | app-core.js |
| `footprint` — width, depth, height | ditto (re-derived on restore, stored as a cross-check) | app-core.js |
| `lock.piece` | `nsoPosLocked(m)` | app-poslock.js |
| `seat` — gap, kind, partner, measured, residual, reference | `p.seat` | app-join.js |
| `skin` — pattern, scope, mode, faces, layer2, params | `m.skin` | app-skin.js |
| `paint.excluded` / `paint.selected` | `nsoMaskSnapshot(m)` | app-mask.js |
| `non_solid` | `nsoNonSolid(m)` | app-nonsolid.js |
| `basis`, `center_offset` | the transform the export baked in | see below |

and the plate itself carries `id`, `name`, `w`, `d` and `locked`
(`nsoPlateLocked()`), plus the selection.

Two of those records are new, because the state did not exist to be saved:

- **`p.seat`** (`NSO_recordSeat`, app-join.js). Both Seat buttons now record
  the gap they were asked for, in the coupon sign convention, with the piece
  they seated against and the measured result. Before this the gap lived on the
  slider and the result lived in the pose, so a plate could not say what gap a
  pair was seated at. It is descriptive: the pose is still the truth, and
  nothing re-seats from it.
- **`m.skin`** (`NSO_recordSkin`, app-skin.js). A Skin bake rewrites `rawTris`
  and nothing else, so which pattern made a relief was only ever in the status
  line. It is provenance, not a replay buffer — the geometry in the file
  already carries the skin, and a later bake overwrites the record. Undo takes
  it back with the geometry (`pushUndo` snapshots it, the way it already does
  for the paint and the non-solid flag).

A module that is not loaded contributes nothing: every read is guarded, so the
block degrades to geometry and pose rather than failing the export.

## The transform, and why the file needs one

The plate export bakes each piece's pose into its geometry — that is what makes
the file open correctly in a slicer, and it is not going to change. But a baked
pose cannot be undone by guesswork, so the block records the transform that was
applied:

```
basis   12 numbers, the same row-vector layout 3MF's own <item transform> uses:
        x' = x*M[0] + y*M[3] + z*M[6] + M[9]
        y' = x*M[1] + y*M[4] + z*M[7] + M[10]
        z' = x*M[2] + y*M[5] + z*M[8] + M[11]
        piece model space (the centred, Y-up display geometry) -> plate
```

`NSO3MFScene.poseBasis()` is the one place that knows the chain — rotate X,
rotate Y, rotate Z, translate by (x, height/2 + liftY, z), then the Y-up to
Z-up swap and the shift onto Bambu's front-left origin. Restore inverts it.

`center_offset` is the model's own `centerOffset`, the translation between its
raw file axes and its centred display geometry. With it, restore rebuilds
`rawTris` **in the frame the piece had before the export**, which is what lets
the raw-space paint planes and the skin record come back verbatim rather than
re-anchored and approximately right.

The exporter still bakes through THREE, exactly as before; `poseBasis()`
describes that bake rather than replacing it. `tools/3mf-test/scene-check.js`
asserts the two agree on every vertex, so a change to one without the other
fails the suite instead of quietly shifting a restored plate.

## Restoring

`import3MF` takes one of two routes, decided by what the file carries:

- **an NSO scene block** — the plate comes back as it was left. A populated
  plate is confirmed first ("restore it? the pieces now on the plate are
  removed"), and declining falls back to the plain geometry import. The library
  models already loaded are kept either way.
- **anything else** — geometry only, exactly as before.

A block this build cannot read takes the second route with a console warning.
That covers a corrupt part, a truncated one, and one written by a newer NSO:
the parser refuses the whole block rather than half-restoring from it, and the
geometry in the file is still good.

Restore puts each value back through the same setter a user setting it would
reach (`nsoMaskRestore`, `nsoNonSolidSet`, `nsoPosLockSet`, `nsoPlateLockSet`),
so the indicators, the HUD and the undo stack all see it. The lock goes on
last, because it blocks the move surface and placing the piece is exactly what
that surface does.

### The one-model route

`Download selected 3MF` writes a block too, with `scope: "model"`. It carries
the piece's own flags and lists — paint, skin, non-solid, lock — and nothing
about placement, because there is no plate arrangement to rebuild. That route's
import is the ordinary geometry path, unchanged, so the placement contract
`tools/nso_export_roundtrip_test.js` pins for it still holds.

## Limits

- **One model per restored piece.** The file has one object per piece, so two
  placed pieces that shared a source model come back as two models, each with
  its own copy of the model-level state. Nothing in the app depends on the
  sharing.
- **A bake after a pose.** `NSO_sculptCommitRaw` rebuilds a placed mesh
  unrotated, so a Skin or Soften applied *after* a piece is posed leaves the
  drawn mesh and the pose bookkeeping disagreeing until the next pose change.
  Every exporter reads the bookkeeping, so a file written in that state already
  disagreed with the viewport before the scene block existed. Restore is
  faithful to the file. This predates the feature and is not fixed here.
- **`meshOffsetY`** (the stacking offset an overflow piece gets) is not in the
  export chain and is not restored. The `overflow` flag itself is.
- **Undo** does not span a restore: reopening a file is not one undoable step.

## Checks

| | |
| --- | --- |
| `npm run 3mf:scene` | `tools/3mf-test/scene-check.js` — the transform chain against a real THREE bake, the inverse, the archive, the schema, every field, the rejects, and the Bambu Studio fixtures |
| `npm run scene:roundtrip` | `tools/nso_scene_roundtrip_test.js` — a real plate in a real browser: a locked and painted hull, a bit seated at −0.18 mm through the slider, a skinned non-solid clip, the plate lock; exported through the Export plate 3MF button, the app wiped, the file re-opened, every value compared |

Both run in `npm test`.

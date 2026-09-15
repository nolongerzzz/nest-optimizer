# 3MF import fixtures

Real files written by Bambu Studio, not by NSO, so the reader is tested against
someone else's structure and not just its own output.

| file | source | structure |
| --- | --- | --- |
| `pa_pattern.3mf` | Bambu Studio repo, `resources/calib/pressure_advance/pa_pattern.3mf` (BambuStudio-01.07.03.04) | Production extension: one wrapper object whose `<component p:path>` points at `3D/Objects/Cube_1.model`; the build item carries a **non-uniform scale** (an 18 mm cube squashed to 5 x 5 x 0.85 mm); names in `Metadata/model_settings.config` |
| `flowrate-test-pass2.3mf` | Bambu Studio repo, `resources/calib/filament_flow/flowrate-test-pass2.3mf` | Older layout: ten objects with **inline meshes** in `3D/3dmodel.model`, material-extension colour groups interleaved, build items with **no transform attribute**, no `model_settings.config`, names on `<object name>`; the archive carries **ZIP64** end-of-central-directory markers |

Both come from <https://github.com/bambulab/BambuStudio>, licensed under the GNU
Affero General Public License v3. They are redistributed here unchanged as test
data under that licence.

A third file, a MakerWorld project saved by BambuStudio-02.07.01.62 (two
objects, 21,694 and 21,386 triangles, rotated build items, split object parts),
was used during development but is not committed because MakerWorld models
carry their own licence. `tools/3mf-test/import-check.js` runs it too when
`NSO_3MF_REAL=/path/to/file.3mf` is set.

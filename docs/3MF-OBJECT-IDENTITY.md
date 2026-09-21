# 3MF object identity — why the plate export names its objects

Module: `nso-3mf.js`, `buildModelXml()`
Suites: `node tools/3mf-test/roundtrip-check.js`, `node tools/3mf-test/export-drive-check.mjs`

Every number below was measured off real sliced G-code or a real `.3mf`.
Nothing here is inferred from slicer source.

---

## 1. The symptom

Exporting a 6-piece plate produced sliced G-code carrying **one** `; OBJECT_ID:`
value for the whole print instead of six. Bambu Studio's Objects tab had shown
six named pieces before slicing, so the loss happened at or after import — not
in the packer.

## 2. What the exporter was doing

Nothing wrong, as it turned out. `buildPlacedObjects3MF()` in `app-core.js` maps
over `state.placed` one piece at a time, and `buildModelXml()` writes one
`<object>` and one `<item>` each. A 6-piece plate really did leave NSO as six
objects, and `export-drive-check.mjs` already asserted that count.

The merging function in the tree — `buildCombinedGeometry()` — is only reachable
from `exportSTLs()`. STL has no object concept, so that is expected and is not on
the 3MF path.

## 3. What was actually missing

NSO wrote a minimal, spec-correct, *anonymous* 3MF: no name on the `<object>`
element, no production-extension UUIDs. Object names lived only in
`Metadata/model_settings.config`.

Compare `fixtures/3mf/flowrate-test-pass2.3mf`, a ten-object file written by
lib3MF:

```xml
<object id="1" name="flowrate_0" type="model" p:UUID="df250383-..." pid="2" pindex="0">
```

That file has **no** `model_settings.config`, **no** `project_settings.config`,
**no** `identify_id`, **no** `<part>` and **no** `<assemble>`. All it carries is
a name on each object and a UUID.

## 4. The discriminating experiment

Two of that file's objects were renamed to `NSO_SUPPORT_alpha` /
`NSO_SUPPORT_beta`, geometry left byte-identical, and the result sliced in real
Bambu Studio. The G-code came back with **ten distinct object ids**:

```
1297  1319  1341  1363  1385  1407  1429  1451  1473  1495
```

with 55 balanced `start`/`stop printing object` pairs and 60 `M624`/`M625` pairs,
and every layer manifest listing all ten.

That rules out `identify_id`, `<part>` and `<assemble>` as requirements: the file
had none of them. A name on the `<object>` element plus a UUID is sufficient.

## 5. The fix

`buildModelXml()` now declares the production-extension namespace, puts the
piece's name on its `<object>`, and emits a `p:UUID` on every object, on
`<build>` and on every `<item>`.

UUIDs are **derived from object identity, not generated**, because the same plate
and profile must keep producing byte-identical archives — `roundtrip-check.js`
checks that. Bambu's own files carry counter-shaped UUIDs
(`00000001-61cb-4c03-9d28-80fed5dfa1dc`), so a derived UUID is precedented.
Uniqueness only has to hold inside the one package.

## 6. Two things this does NOT establish

**Names do not reach the G-code.** `NSO_SUPPORT_` appears zero times in the
sliced output. The name survives 3MF → Bambu Studio (it is visible in the Objects
tab, and Bambu used it for the export filename), but the G-code identifies
objects by number only. Anything downstream must target numeric ids.

**The name → id mapping is unconfirmed.** In the experiment slice the ids
ascended in the same order as the objects appear in the 3MF, but every object was
1.5 mm tall and near-identical in shape, so "ordered by 3MF position" could not be
told apart from "ordered by plate geometry". **Do not build automation on that
ordering until it is confirmed** by slicing a plate of deliberately
distinguishable objects in a known order. That is separate, standalone work.

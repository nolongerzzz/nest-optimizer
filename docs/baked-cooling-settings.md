# Baked cooling settings (3MF export)

NSO can export the nested plate as a Bambu Studio project (`.3mf`) with the
cooling / overhang-fan settings already baked in, so the plate arrives in Bambu
Studio with the right fan behaviour instead of the user re-entering it per job.

- **Export plate 3MF** in the Export card writes the project.
- **Cooling profile** next to it selects which set of values gets baked in.
- The selection is remembered in `localStorage` between sessions.

This is the *baked / global settings* path. Per-object or per-material overrides
via G-code post-processing (the "advanced mode" Grispr approach) are out of scope
here and are tracked separately.

## Where the settings live

Inside the `.3mf` (a ZIP archive):

```
[Content_Types].xml
_rels/.rels
3D/3dmodel.model                    core 3MF geometry, millimetres, Z up
Metadata/project_settings.config    <- the baked cooling settings
Metadata/model_settings.config      Bambu object / plate names
Metadata/nso_profile.json           NSO provenance (which profile, tuned or not)
```

`Metadata/project_settings.config` is JSON. NSO writes **only** the confirmed
cooling keys into it — nothing invented. Bambu Studio merges those over whatever
preset is selected when the project opens. NSO's own bookkeeping deliberately
lives in a separate `nso_profile.json` part, because Bambu warns about keys it
does not recognise in `project_settings.config`.

## The format, exactly as Bambu ships it

Both rules below were confirmed against a real Bambu Studio export using the
stock **Bambu PLA Basic @BBL A1M** profile. They are reproduced verbatim and
must not be "cleaned up".

**1. Every value is a single-element array of strings.** Not a scalar, not a
number:

```json
"overhang_fan_threshold": ["50%"]
```

**2. Percent-bearing fields keep the literal `%`; plain numeric fields do not** —
even where the number semantically *is* a percentage. `overhang_fan_speed` is
`"100"` and `fan_max_speed` is `"80"`, with no `%`, while `overhang_fan_threshold`
is `"50%"`. This is Bambu's own inconsistency. Normalising either way is a bug:
Bambu Studio's parser expects each field as it ships it.

`KEY_FORMATS` in `nso-cooling-profiles.js` encodes rule 2 per key, and
`validateValues()` runs on every export, so a future tuned profile cannot
silently add or drop a `%`.

## The locked default

`nso-cooling-profiles.js` → `DEFAULT_VALUES`, frozen, in the same key order the
real file uses so a text diff against an untouched Bambu export lines up:

| key | value | format |
| --- | --- | --- |
| `enable_overhang_bridge_fan` | `1` | bool |
| `overhang_fan_threshold` | `50%` | percent |
| `overhang_threshold_participating_cooling` | `95%` | percent |
| `overhang_fan_speed` | `100` | number (no `%`) |
| `pre_start_fan_time` | `2` | number |
| `reduce_fan_stop_start_freq` | `1` | bool |
| `slow_down_for_layer_cooling` | `1` | bool |
| `fan_min_speed` | `60` | number |
| `fan_cooling_layer_time` | `80` | number |
| `fan_max_speed` | `80` | number (no `%`) |
| `slow_down_layer_time` | `6` | number |
| `slow_down_min_speed` | `20` | number |
| `no_slow_down_for_cooling_on_outwalls` | `0` | bool |
| `cooling_slowdown_logic` | `uniform_cooling` | enum |

## Adding a tuned profile

Profiles are a lookup table, not a hardcoded object. Each one is
`DEFAULT_VALUES` plus its own `overrides`, so an untuned slot exports
byte-identical to `default` until someone fills it in.

Current slots:

| id | state |
| --- | --- |
| `default` | confirmed stock values, locked |
| `breakaway-support` | reserved, untuned |
| `fine-detail` | reserved, untuned |
| `high-flow` | reserved, untuned |

To tune a slot, edit `nso-cooling-profiles.js` only:

```js
'breakaway-support': {
  id: 'breakaway-support',
  label: 'Breakaway support',
  note: 'Measured on the Sept breakaway-support test prints.',
  tuned: true,
  overrides: {
    overhang_fan_speed: '80',    // number -> no '%'
    overhang_fan_threshold: '25%' // percent -> keeps '%'
  }
}
```

Nothing else needs changing — the selector, the exporter and the validator all
read that table. Run `node tools/validate-3mf.js` afterwards; it will reject an
override that breaks the `%` contract, names a key outside the confirmed set, or
fails to survive the round trip.

## Validation

```
npm run 3mf:roundtrip   # tools/3mf-test/roundtrip-check.js   - no browser, no network
npm run 3mf:drive       # tools/3mf-test/export-drive-check.mjs - real app, headless Chromium
```

Both are part of `npm test`.

**`roundtrip-check.js`** exports a real `.3mf` through the same modules the app
uses, then reads the archive back with an **independent** ZIP reader (Node
`zlib`, walking the central directory rather than trusting the writer's own
bookkeeping) and asserts, for every profile in the table:

- the archive passes third-party `unzip -t`
- every OPC part is present
- every value is a single-element array of one string
- the exact key set and order survived
- every value is byte-exact, `%` included
- the raw file text carries each key verbatim as `"key": ["value"]`, so a
  tolerant JSON parser cannot mask a formatting slip
- `project_settings.config` holds only the confirmed cooling keys
- geometry survived into `3D/3dmodel.model`
- the same input produces byte-identical archives
- the format guard really does reject a dropped `%`, an added `%`, and an
  unknown key

That is 56 checks. It is dependency-free and needs no browser.

**`export-drive-check.mjs`** covers what the Node check cannot reach: the
`<script>` tags, the profile selector, the button wiring, and
`buildPlacedObjects3MF()` turning real packed pieces into 3MF objects. It loads
the real `index.html` in headless Chromium, imports `fixtures/box-20mm.stl`
through the app's own `handleFiles`, presses **Optimize plate**, presses
**Export plate 3MF**, captures the actual browser download, and then takes the
saved file apart off the browser entirely — every cooling value read back out of
the archive, plus the plate-coordinate assertions (nothing negative, nothing off
the 180 mm plate, the piece resting on `z = 0`). That is 38 checks.

Like the CTH browser checks, it serves three from the `three` devDependency
rather than the CDN `index.html` names, so it needs no network. On a runner
whose Chromium predates the installed Playwright, point it at the browser:

```
CHROME_PATH=/path/to/chrome npm run 3mf:drive
```

## Known limitation: "Use Modified Value of Filament Preset"

**Confirmed by testing. Documented, not solved.**

If the user swaps filament profiles in Bambu Studio *after* opening an NSO
export, Bambu shows a **"Use Modified Value of Filament Preset"** dialog. It
offers to keep or discard the values that differ from the newly selected preset.

Choosing **"Discard Modified Value" loses the baked cooling settings.** The plate
then prints with the new preset's stock cooling, silently, with no further
warning.

This is inherent to how Bambu Studio reconciles a project's settings against a
preset; a 3MF cannot opt out of it. Guidance for users:

- Pick the filament profile **before** opening the NSO export, not after.
- If the dialog does appear, choose **"Use Modified Value"** to keep NSO's
  cooling settings.
- `Metadata/nso_profile.json` inside the export records which profile was baked
  in, so a plate that came out wrong can be checked after the fact.

## Verifying in Bambu Studio

The one leg of validation that cannot run here. Everything above is checked
automatically; **whether Bambu Studio itself honours the baked values needs a
machine with Bambu Studio on it.** Until someone does this, treat the feature as
working-but-unconfirmed.

Produce a file with **Export plate 3MF**, or run `npm run 3mf:drive` and use the
`.3mf` it saves. Open it in Bambu Studio, then read
**Filament settings → Cooling** and compare against the table below.

| key in the file | Cooling tab field (wording varies by version) | should read |
| --- | --- | --- |
| `enable_overhang_bridge_fan` | Force cooling for overhangs / bridges | on |
| `overhang_fan_threshold` | Overhang cooling threshold | 50% |
| `overhang_threshold_participating_cooling` | Overhang threshold participating cooling | 95% |
| `overhang_fan_speed` | Overhang / bridge fan speed | 100% |
| `pre_start_fan_time` | Pre-start fan time | 2 s |
| `reduce_fan_stop_start_freq` | Keep fan always on | on |
| `slow_down_for_layer_cooling` | Slow printing down for better layer cooling | on |
| `fan_min_speed` | Fan speed — min | 60% |
| `fan_max_speed` | Fan speed — max | 80% |
| `fan_cooling_layer_time` | Layer time, max fan speed threshold | 80 s |
| `slow_down_layer_time` | Layer time, slow down threshold | 6 s |
| `slow_down_min_speed` | Min print speed | 20 mm/s |
| `no_slow_down_for_cooling_on_outwalls` | Don't slow down outer walls | off |
| `cooling_slowdown_logic` | Cooling slowdown logic | uniform cooling |

Field labels move between Bambu Studio versions; the key names in
`project_settings.config` are the stable identity. Match on the value.

**Do not read the speed fields as coercion.** `overhang_fan_speed`,
`fan_min_speed` and `fan_max_speed` are stored bare (`"100"`, `"60"`, `"80"`)
and Bambu's UI renders them with a `%` sign. A UI showing `100%` for a stored
`"100"` is correct and expected — that is the inconsistency described above,
not a value being rewritten.

What would count as a real failure:

- a field shows the **stock preset value** instead of the one in the table —
  the file was parsed but that key was ignored;
- **every** field shows stock values — the file was very likely not read as a
  settings source at all (see below);
- a value is **rounded, rescaled or retyped** (`50%` arriving as `50`, `6` as
  `6.0`, `uniform_cooling` falling back to another mode) — genuine coercion.

**The most likely failure mode, if there is one.** NSO writes only the 14
confirmed cooling keys. A `project_settings.config` written by Bambu Studio
carries hundreds, including preset identity (`filament_settings_id`,
`print_settings_id`, `printer_settings_id`) and a `version`. That was a
deliberate choice — inventing values for keys nobody has confirmed is worse than
omitting them — but it is untested. If Bambu ignores the whole file, that
envelope is the first thing to add, and it is an additive change: the 14 keys
and their formats stay exactly as they are.

Record the outcome here when it is done.

## Settled

**The container is JSON, with `:`.** Confirmed by the owner — the keys were
originally pulled out with `json.load()`, which only succeeds on valid JSON. The
`key = ["value"]` form the values were first transcribed in was shorthand, not
the file's syntax. `serializeProjectSettings()` is correct as written; no change
needed.

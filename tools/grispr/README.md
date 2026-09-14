# Grispr

Per-object fan control for sliced Bambu Studio G-code.

Grispr is the advanced-mode companion to the baked cooling-settings 3MF exporter.
The exporter covers the default case: one cooling profile, applied to the whole
plate, set before you slice. Grispr covers the case the exporter structurally
cannot.

## Why this exists

Bambu Studio has no per-object fan control — not in the UI, and not in the 3MF
schema. There is no field to set it in, so no exporter can produce it. That is a
permanent gap, not a missing feature in our tooling.

Grispr closes it by working **downstream of the slicer**, on the final G-code.
Two consequences follow:

* **It cannot be silently undone by the filament-preset system.** Baked settings
  live in the project's filament preset. If a user swaps filament profiles,
  Bambu Studio's "Use Modified Value of Filament Preset" dialog can discard them
  depending on which option the user picks. Grispr runs after slicing, so no
  preset state is involved.
* **It can address individual objects.** The 3MF schema has nowhere to express
  "object 7 gets 100% fan"; the sliced G-code labels every object explicitly.

## What it does not do

Bambu Studio already forces the fan on overhangs and bridges, driven by geometry
(`enable_overhang_bridge_fan`, `overhang_fan_threshold`, `overhang_fan_speed`).
That is baked in by the companion exporter and **Grispr does not duplicate,
replace, or interfere with it**. By default Grispr leaves every fan command the
slicer emitted inside an object exactly where it is.

Grispr is for what geometry-driven detection cannot reach: a support region that
is not steep or bridging enough to trip the detector, or per-object fan
behaviour that has nothing to do with overhang angle.

## The mechanism

Bambu Studio brackets every object's toolpath with explicit comment markers:

```gcode
; object ids of layer 2 start: 1,2,3
; OBJECT_ID: 2
; start printing object, unique label id: 2
...toolpath...
; stop printing object, unique label id: 2
; object ids of layer 2 end: 1,2,3
```

The `unique label id` matches the `identify_id` field in the exported 3MF's
`Metadata/model_settings.config` for that object. That is what makes the chain
addressable end to end:

```
NSO internal object  ->  3MF identify_id  ->  G-code unique label id
```

Objects **interleave within a single layer** — and an object can be left and
re-entered on the same layer. Grispr treats blocks as a flat ordered sequence
and never assumes one block per object per layer.

## Install

Python 3.8+, standard library only. No dependencies.

```bash
chmod +x tools/grispr/grispr.py
```

## Usage

Inspect a file first — this never modifies anything:

```bash
tools/grispr/grispr.py --list plate_1.gcode
```

```
9 print block(s) for 3 object(s); 9 '; OBJECT_ID:' marker(s); 3 layer manifest(s)

   #    obj   layer            lines   fan in  fan out
   0      1       1            24-27     S102     S102
   1      2       1            29-32     S102     S102
   ...
   4      2       2            48-53     S102     S255
   5      3       2            55-58     S255     S255

Layers where more than one object prints:
  layer 2: objects 1,2,3
```

Then force the fan for specific objects:

```bash
# object 3 at full, object 7 off
tools/grispr/grispr.py --object 3=255 --object 7=0 plate_1.gcode

# percentages work too
tools/grispr/grispr.py --object 3=60% plate_1.gcode

# same value for several objects
tools/grispr/grispr.py --objects 3,7,9 --fan 255 plate_1.gcode

# preview without writing
tools/grispr/grispr.py --dry-run --object 3=255 plate_1.gcode
```

### Options

| Option | Effect |
| --- | --- |
| `--object ID=VALUE` | Force the fan for one object. Repeatable. `VALUE` is `0`-`255` or a percentage. |
| `--objects ID,ID` + `--fan V` | Same value for several objects. |
| `--fan-index N` | Which fan to manage. Bambu: `1` part cooling (default), `2` aux, `3` chamber. |
| `--fan-syntax auto\|bare\|indexed` | Emit `M106 S255` or `M106 P1 S255`. `auto` matches the file. |
| `--layers N[-M]` | Only inject on blocks in this layer range — per-region rather than whole-object. |
| `--hold` | Also suppress the slicer's own fan commands inside the object. **See the warning below.** |
| `--list` | Print the block map and exit. Never writes. |
| `--dry-run` | Print planned edits without writing. |
| `--backup` | Write `<file>.grispr.bak` first. |
| `--force` | Undo a previous Grispr run and re-apply, instead of refusing. |
| `--allow-missing` | Exit 0 when a requested id has no block, instead of failing. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (or a deliberate `--allow-missing` no-op) |
| 2 | Usage error, including "this file was already processed" |
| 3 | Markers missing, unbalanced, nested, or mismatched |
| 4 | A requested object id has no print block |
| 5 | I/O error, or the file is not plain text |

Any non-zero exit leaves the input **byte-for-byte unchanged**.

## Bambu Studio integration

Bambu Studio → **Others** tab → **Post-processing Scripts**. Put your options
first; Studio appends the sliced file's absolute path as the final argument:

```
/absolute/path/to/grispr.py --object 3=255 --object 7=0
```

On Windows, name the interpreter explicitly:

```
"C:\Python311\python.exe" "C:\tools\grispr\grispr.py" --object 3=255
```

Grispr modifies the file in place at the path it is given, which is what Studio
expects. A non-zero exit surfaces in Studio as a post-processing failure — that
is deliberate. A silent no-op on a file it did not understand would be far worse
than a visible error.

## Design decisions

**Boundary injection by default.** Grispr writes a forced fan command
immediately after an object's start marker, and restores the fan immediately
after its stop marker. It does not touch fan commands inside the object, because
those include Bambu's native overhang/bridge forcing. `--hold` comments them out
so the forced value holds for the whole object — at the cost of defeating
overhang forcing for that object. Read the caveat in **Limitations** before
relying on the default.

**The restore value is computed, never hardcoded.** At each stop marker Grispr
writes the fan state the *unmodified* file would have had at that exact line. If
the object's own G-code changed the fan mid-block (an overhang, say), the
restore returns to *that* value, not to whatever was active before the block
started. This is what keeps state from leaking between objects that interleave
on one layer. When the state already matches, no command is emitted at all.

Concretely, from the test fixtures — object 2's block raises the fan to `S255`
for an overhang, then object 3 prints on the same layer:

```gcode
 ; start printing object, unique label id: 2
 ;TYPE:Overhang perimeter
 M106 S255                                        <- slicer's own overhang forcing
 ; stop printing object, unique label id: 2
 ; start printing object, unique label id: 3
+M107 ; @grispr force obj=3 prev=S255 layer=2
 ; stop printing object, unique label id: 3
+M106 S255 ; @grispr restore obj=3 to=S255        <- restores S255, not S102
```

**Fail loud, never silent.** Unbalanced, nested, mismatched, or absent markers
abort with a non-zero exit and no write. A file that does not match the expected
Bambu pattern is an error, not a zero-edit success.

**Atomic writes.** The new content goes to a temp file in the same directory,
is fsynced, then `os.replace`d over the original. An interrupted run cannot
leave a truncated G-code file on disk.

**Re-run protection.** Every inserted line carries an `@grispr` sentinel.
Running twice on the same file is refused rather than stacking injections;
`--force` reverts the previous run and re-applies, which is exactly idempotent.

## Validation

`tools/grispr/tests/` contains 65 tests over 14 synthetic fixtures (8
well-formed, 6 deliberately malformed), including an interleaved 3-object file
where two objects are each entered twice on the same layer.

```bash
cd tools/grispr && python3 -m unittest discover -s tests
```

The central assertion is stronger than "injection landed in the right place".
For every line of the original file outside a targeted object's block, the fan
state in the modified file must equal the state the original file would have had
at that same line — checked line by line, across every fixture and every target
combination, with and without `--hold`. Alignment also proves that no
non-inserted line was altered or dropped.

A randomised property test generates 60 further layouts — arbitrary interleave
orders, re-entries, slicer fan commands inside blocks, ambient fan changes at
layer boundaries, with and without `--hold` — and asserts the same invariant on
each, so the coverage is not limited to the cases we thought to write down.

Also covered: CRLF round-tripping, non-UTF-8 bytes surviving byte-identically,
files without a trailing newline, paths with spaces, aux-fan targeting leaving
part cooling alone, re-run idempotency, and every malformed fixture aborting
without touching the input.

## Limitations

These are real and worth reading before you rely on this.

1. **Not yet verified against a real sliced file.** The marker pattern was
   confirmed against genuine Bambu Studio output, and Grispr implements exactly
   that pattern — but the parser itself has so far only been run against
   synthetic fixtures. Run `--list` on a real file as the first check; it prints
   the block map without modifying anything, and a mismatch shows up immediately
   as either a parse error or an obviously wrong block count.

2. **Boundary injection is a baseline, not a guarantee.** By default the
   slicer's own fan commands inside the object still execute, so a forced value
   holds only until the next slicer-emitted `M106`. Bambu emits fan changes at
   feature and layer transitions, so on a real file the forced value's effective
   duration may be much shorter than a whole object. The `fan in`/`fan out`
   columns in `--list` show where this bites. `--hold` removes the ambiguity at
   the cost of point 3.

3. **`--hold` defeats overhang fan forcing for the targeted object.** There is
   no way to distinguish an overhang-triggered `M106` from any other `M106` by
   the command alone. (Bambu does emit `;TYPE:Overhang perimeter` /
   `;TYPE:Bridge infill` beforehand, so a selective mode is possible — it is not
   implemented, because it needs a real file to verify against.)

4. **The NSO hand-off is not wired up yet.** The `identify_id` link requires 3MF
   export; as of this commit NSO exports STL only, so nothing records an
   `identify_id`. Object ids must be supplied on the command line today, read
   off `--list`. Automating the chain depends on the 3MF exporter landing.

5. **Object ids are per-slice.** Re-slicing, or changing the plate, can renumber
   objects. Re-check with `--list` after any re-slice rather than reusing ids.

6. **"Fan off" is assumed to be the power-on default** for the managed fan. When
   a file issues no command for that fan before a targeted block, Grispr
   restores to off at the stop marker. True for Bambu part cooling; verify
   before using `--fan-index` for a chamber fan.

7. **Plain `.gcode` only.** Multi-plate `.gcode.3mf` containers are not
   unpacked. This matches what Bambu Studio hands a post-processing script.

8. **Interaction with printer-side features is untested.** Object skipping
   (`M624`/`M625`) and similar are passed through untouched but have not been
   exercised against a real print.

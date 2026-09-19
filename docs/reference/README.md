# Reference material

Working tools from outside this repo, kept so their behaviour can be compared
against ours rather than remembered. **Nothing here is loaded by the app, served
by the preview site, or read by any check.** These are documents.

| file | what it is |
| --- | --- |
| `joint_microscope_3d.html` | A standalone G-code inspector: feature-level isolation over a colour table of 14 entries — 12 extruding slicer features, `Custom`, and a synthesised `Travel` — and a box capture region with independent horizontal and vertical extents. Audited against `nso-gcode-lines.js` in `docs/GCODE-FEATURE-AUDIT.md`. |

## About `joint_microscope_3d.html`

4.8 MB, and 4.78 MB of that is one line: `const SEGMENTS = [...]`, a baked
snapshot of 25,976 extrusion and travel moves out of one real slice. The tool
itself is the ~22 KB around it — three.js, a feature legend, and the capture-box
drag handling.

It is self-contained and opens in a browser, but it loads three.js from
`cdn.jsdelivr.net`, so it needs network access to render. It is committed as
received, unmodified.

Two things in it were worth auditing, and both are written up in
`docs/GCODE-FEATURE-AUDIT.md`:

1. **Feature-level isolation.** A hard-coded colour table of 14 entries, with the
   legend built from whichever of them the loaded slice actually uses. The audit's
   finding is that our importer needs no such list — it groups on the
   `; FEATURE:` tag itself, so a category cannot be missing from it — and that
   the one thing it structurally cannot produce is `Travel`, correctly, because a
   travel extrudes nothing and so has no bead to build.
2. **The capture box.** It began as a sphere and became a box with a separate
   vertical half-extent, for the reason its own UI text gives: *"keep it thin to
   avoid grabbing unrelated layers above/below."* That is the Z window, and it is
   the shape `zWindowAround()` now uses — see **The Z filter** in
   `docs/GCODE-TOOLPATH-IMPORT.md`.

### Provenance

Staged on `nolongerzzz/nest-wip`, branch `source-files`, as
`uploads/joint_microscope_3d.html`. `nest-wip` was a drop-off only; it is also
this repo's Pages preview mirror (`docs/PREVIEW-SITE.md`), and nothing here
depends on it either way.

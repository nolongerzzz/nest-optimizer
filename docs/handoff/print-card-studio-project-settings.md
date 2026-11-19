## Print card - a Studio project slices with its own settings (2026-11-19)

The owner compares NSO's slice with Bambu Studio's before printing, to stop wasting filament. Copying Studio's settings
into the card row by row missed some, and the card had no row for others. Their feet came out with walls (Wall loops still
2) and 15 % where Studio had 0 walls and 10 % honeycomb.

Changed:
- `nso-3mf-read.js`: `projectSettings`; `objectSettings` via `parseModelSettingsOverrides`.
- `app-core.js`: `window.nsoProjects[file]`.
- `app-print.js`: `plateProject`, `checkProject`, `useProject`, `relayProject`, `projectLine`; `project` in the settings;
  `configOverlay` lays the project's changes first; `slice()` waits for the rows.
- `index.html`: `#slice-project`.
- Checks: `tools/print-slice-check.js` 3e (+9); `tools/nso_support_settings_drive_check.mjs` (its plate is a Studio
  project: three rows open at the project's, and a saved setting over them).
- Fixture: `fixtures/slicer-feet-reference.json` keeps the feet project's 8 changes (`projectChanges`).
- Docs: `docs/PRINT-CARD.md` "A Studio project's own settings".

**What you get.** Open a Studio project: the rows go to its values, every changed key goes into the slice (with or
without a row), and a line under the printer lists them. Profile values lets the project go; Project settings brings it
back. G-scope's Slice right after opening has them too.

`print:slice` 188, `support:settings-drive` 30, `print:card`, `support:settings`, `gcode:gscope-slice(-view)`,
`3mf:import(-drive)`, `3mf:roundtrip`, `slicer:test` pass.

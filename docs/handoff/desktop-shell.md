## Desktop shell and the printer link (desktop-shell)

`desktop/` is an Electron app that shows the same static site in its own window and adds what a browser
cannot do: a link to the owner's Bambu printers. Nothing in the site's own files changed. Write-up:
`docs/DESKTOP.md`.

- **Run:** `cd desktop && npm install && npm start`. Printer > Printers... adds a printer (address, serial,
  access code), checks and pins its certificate, connects, shows status, pauses / resumes / stops, sends a
  `.gcode.3mf` and starts it, and runs the service commands (re-home X/Y, clear error, nozzle, G-code).
- **Export from the page** of a `.gcode.3mf` now asks *Send to a printer / Save to disk* (the shell catches
  the download).
- **Safety:** certificate pinning instead of TLS-off; the access code in the OS keychain, never on disk in
  the clear; a guard that refuses a full home during a job and anything that moves while the service lock
  is on (`printer-link/guard.js`, each rule from a lost print).
- **Checks:** `npm test` in `desktop/` (62 link + 27 server/store, against a mock printer) and
  `npm run smoke` (19, the real app under xvfb). Not part of the root `npm test`.
- **Not verified:** nothing has touched a real printer. `docs/DESKTOP.md` lists the six tests, in order.
  The Mac build (`npm run dist:mac`) has not been run on a Mac.
- **Also in this PR:** `docs/PRINT-SETTINGS-AUDIT.md`, a read-only audit of which Bambu printer / filament /
  process settings NSO's planner and engine honour, with a ranked "bring over next" list.

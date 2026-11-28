# The desktop app: the same site in its own window, with the printer link

`desktop/` (Electron). Mac first, then Linux. The web version is unchanged and stays the live preview.
Checks: `cd desktop && npm test` (89, no display needed) and `npm run smoke` (19, the real app against a mock printer).

## Why

A browser page cannot open the connections a Bambu printer uses (MQTT over TLS, FTPS), cannot keep a
secret in the keychain, and cannot write files without a download prompt. A desktop shell can. NSO is
static files, so the shell loads the same files: one codebase, two ways to run it.

## Run it

```
cd desktop
npm install        # once
npm start          # opens Nest Optimizer; Printer > Printers... (Cmd/Ctrl+Shift+P) opens the printer window
```

It runs from the repository as it is checked out, so a `git pull` and a restart is an update.
`npm run dist:mac` / `npm run dist:linux` build an installable app (a `.dmg`, an AppImage) with
electron-builder. **Not yet run on a Mac**: the mac build is unsigned, so macOS asks once (right-click >
Open) and the keychain prompt names the app.

## What is in it

| file | does |
|---|---|
| `main.js` | the Electron main process: the windows, the menu, the checks on who may call what |
| `static-server.js` | serves the repo's site files on `127.0.0.1` only (the page fetches its fixtures, so it needs http). Refuses `..`, dotfiles, `desktop/`, `node_modules/`, any other Host name, anything but GET |
| `preload-site.js` | all the NSO page is given: `window.nsoDesktop = { desktop: true, openPrinters() }` |
| `preload-ui.js`, `ui/` | the Printers window and its bridge. Only that window may reach printers |
| `store.js` | the printers kept between runs (below) |
| `printer-link/` | the link itself: pure Node, no Electron. `cli.js` runs it from a terminal |

The page has no Node, no `require`, no file access (`contextIsolation`, `sandbox`, no `nodeIntegration`).
It cannot navigate away or open windows.

## The printer link (`printer-link/`)

The printer must be in **LAN Only + Developer Mode**. Bambu Handy does not work for it meanwhile; the
owner's test (2026-10-23) showed both can be switched on and off during a paused print.

- **Status:** MQTT over TLS, port 8883. Reports are merged (the A1 and P1 send deltas) and summarised:
  state, percent, layer, time left, nozzle and bed, the print error as the screen shows it (`0300-8008`),
  HMS codes as the wiki names them.
- **Commands:** pause, resume, stop, clear the error, G-code lines, and `project_file` to start a file.
- **Files:** FTPS (implicit TLS, port 990) to the SD card. A name is made safe first.
- **Send from the site:** when the page exports a `.gcode.3mf`, the app asks *Send to a printer / Save to
  disk*. No change to the page was needed: the shell catches the download.

### The certificate pin

A Bambu printer's certificate is signed by Bambu's own CA, which no system trusts, so the usual check
cannot pass and the usual shortcut is to turn checking off. This does neither. **Check the printer**
reads the certificate once and shows it (its name is the printer's serial number); saving pins its
SHA-256 fingerprint. Every later connection finishes the TLS handshake, compares the fingerprint, and
only then sends the access code. Another certificate is refused with nothing sent (`link-test`: an
imposter never sees a login). The FTPS port is pinned separately.

### The access code

Kept in the operating system's keychain (Electron `safeStorage`: the macOS Keychain; libsecret or KWallet
on Linux). `printers.json` holds only the ciphertext. On a Linux session with no real keychain the code
is **not written at all**: it is kept until the app closes and asked for again. It is never in the
repository, a log, or the page.

### The guard (`guard.js`): why it exists

Each rule is a print the owner lost on 2026-11-18.

1. **No full home during a job.** The touchscreen's Home re-measured Z on top of the part and the print
   resumed in mid-air. While a job is running or paused, `G28` must name its axes and must not name Z.
   An unknown state counts as a job.
2. **The service lock.** With the X and Z locks fitted, Unload moved the head and stalled the motors
   against them. With the lock on in the app, everything that moves an axis is refused, and Resume and
   starting a print with it. Heating, cooling and extruding are still allowed. Taking the lock off asks
   "Are the locks off the printer?" first. The lock is written down, so a restart does not clear it.

**The guard cannot see the touchscreen.** A press there bypasses it.

## TO VERIFY on the owner's printers

Everything about the protocol is from community documentation (OpenBambuAPI) and has only been run
against the mock in `desktop/test/`. In this order, each on a scrap print:

1. **Check the printer** shows a certificate named with the printer's serial. Connect goes online and
   the tiles show the right temperatures.
2. **Upload only** puts a file on the SD card (the touchscreen lists it). Bambu's FTP server is known to
   be fussy; a hang here is the first thing to report.
3. **Send and print** with a file already printed once. If the printer refuses, the `url` form in
   `MODELS` (`file:///sdcard/<name>`) is the first suspect.
4. Pause, **Re-home X / Y** (`G28 X` on the A1 mini, Bambu's own "re-home XY" line), Resume: does the
   layer land clean, and does Y re-home too?
5. After a hotend swap in a pause: does **Clear the error** dismiss `0300-8008`?
6. The service sequence end to end: unload > park > lock > swap > unlock > clear error > heat and
   confirm > re-home X/Y > load > resume.

## Not built yet

- A Send button on the Print card itself (today: Export, then the app asks), and the printer's state on it.
- The phone dashboard (the shell serving a status page over Tailscale).
- Park at the service position and creep to the lock (needs test 4 first); the lock checklist screen.
- The Node slicing pool for multi-core slices; reading and writing presets as files.
- Auto-update, signing and notarising the Mac build.
- A check of `desktop/` in the repository's own `npm test` (it has its own `package.json` so Electron
  is not installed for the site's checks).

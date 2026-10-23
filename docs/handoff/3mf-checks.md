## 3MF checks
`npm run 3mf:roundtrip` is the dependency-free suite (56 checks): it exports a
real `.3mf` and reads it back with an independent ZIP reader, asserting key set,
key order, array-of-string shape, byte-exact values including `%`, raw text
form, determinism, and that the format guard rejects bad values.
`npm run 3mf:drive` (63 checks) drives the real app in headless Chromium -
the Format selector (labels, cooling row, persistence across a reload), fixture
import, a clone so the plate carries two pieces, the actual **Export plate**
click with Format = 3MF, the actual **Download selected** click with Format =
3MF (filename prompt accepted), the plate click again with Format = STL - then
takes both saved 3MF files apart (14 keys, `%` rule, one object per piece / one
object for the selected model, on-plate coordinates) and sanity-checks the STL.
It deliberately does **not** press Optimize: `runOptimize()` throws on this
branch (it reads `#opt-orient` / `#opt-rotate`, neither of which is in
index.html - already true at 63c5b00). An earlier draft of the check did press
it and asserted `state.placed.length > 0`, which passed for the wrong reason,
since `handleFiles()` already places the imported piece. Both are in `npm test`. Like the CTH
browser checks, the drive serves three from devDependencies, not the CDN.

**No `CHROME_PATH` is needed, in the sandbox or anywhere else the browser is
already on the box** (2026-09-17). The devDependency is pinned to an exact
`playwright` version - `1.56.1`, not a `^` range - chosen because it is the
Playwright whose browsers.json asks for Chromium revision **1194**, which is the
revision the web sandbox ships at `/opt/pw-browsers` (Chromium 141.0.7390.37),
together with `chromium_headless_shell` 1194 and `ffmpeg` 1011. A clean
`npm install` therefore lands a Playwright that finds its browser where it
already is, and bare `npm test` exits 0.

What that pin replaced: `^1.47.0` resolved to whatever npm called latest
(1.63.0 by 2026-09-17), which wants Chromium 1243, so `npm test` died at step 2
on `browserType.launch: Executable doesn't exist at
/opt/pw-browsers/chromium_headless_shell-1243/...`. Not a code failure - the
four dependency-free cth:unit files passed first and the chain stopped at
`cth:capture` - but every thread that hit it worked around it separately
(`CHROME_PATH=/opt/pw-browsers/chromium npm test`, or a hand `--no-save`
install of a matching Playwright). The sandbox cannot fetch the missing build:
`npx playwright install` is refused by the egress proxy
(`403 ... no rule or allowlist entry allows host "cdn.playwright.dev"`), so
matching the pin to the box is the only fix that needs no per-run flag.

If you move the sandbox image to a different Chromium revision, re-pin rather
than re-introduce the env var: read the wanted revision out of a candidate's
`node_modules/playwright-core/browsers.json` (or `npx playwright install
--dry-run`, which prints the install location per browser) and pick the
`playwright` version whose number matches the box. `CHROME_PATH` still works as
an escape hatch - `cth-test/browser-lib.mjs` and the two `3mf-test` drive checks
read it - and `tools/nso_app_harness.js` resolves the binary itself in
`chromiumPath()`, so the harness suites never needed it.

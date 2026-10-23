## Photogrammetry upload onramp — validate a photo set before reconstructing it (2026-09-19)

`nso_photoset.js` + `nso_exif.js` + `app-photoset.js`, the **Photo set** card
under Library, and the report drawer over the viewport. Checks:
`npm run photoset:test` (`tools/nso_photoset_test.js`, 93 checks) and
`npm run photoset:drive` (`tools/nso_photoset_drive_check.js`, the panel in
Chromium on 93 real JPEGs built for the run). Both in `npm test`.
Written up in `docs/PHOTOGRAMMETRY-ONRAMP.md`.

**What it is.** The first thing in NSO that reads
`docs/PHOTOGRAMMETRY-CAPTURE.md` — the capture contract the feasibility spike
locked and nothing implemented. A photographer submits a batch of photos and
the tool grades them against the contract clause by clause, so a bad shoot is
caught before anyone spends reconstruction time on it. It ends at "ready" and
goes no further.

**Out of scope, by name, and all three are still open.** No reconstruction
backend (no COLMAP, no Meshroom, no hosted API, no network call at all — the
photos never leave the browser). No repair pre-stage: scale-to-mm, debris
filtering, decimation and boundary-loop classification are untouched. No live
in-progress capture guidance; this reads a finished set.

**The design is the three-way split, and it is the thing not to flatten.**
Every check declares its kind and the report is grouped by it:

- **15 decided from the photographs** — frame count, duplicate detection by
  content hash, and the section 4 optics off EXIF (focal length, lens identity,
  aperture, ISO, shutter vs the hand-hold limit, flash, HDR/portrait/night,
  frame size, camera body, timestamp continuity), plus two pixel statistics.
- **11 attestations** — things no image analysis settles at any cost. Diffuse
  static lighting is the clearest: a shadow fixed to the object and one fixed
  to the camera look identical in any single frame. Also the scale reference,
  because its *length* is knowledge the operator has and the image does not.
  An unticked box blocks "ready" exactly as hard as a FAIL.
- **5 deferred** — section 8.3's post-SfM gates, listed with thresholds and
  never blocking, so the report says what it has **not** checked.

A sixteenth check, the per-pass counts, needs the operator to say which frames
are which pass first: nothing in a photograph records the elevation it was shot
at. Filenames carrying the pass (`ringB_07.jpg`) pre-fill it.

**Two things worth not re-deriving.**

*The focus statistic is measured on a native-resolution centre crop, not a
downsample.* The spike measured that 4 px of defocus on a 4032 px frame changes
nothing (8/8 registered) and 8 px destroys the capture (4 of 8, 60 % of
keypoints gone). Downsample to 512 and those are the same picture. It still
only flags outliers against the set median and says so in its own report text —
what collapses is keypoint yield, with no warning band — which is why "sharp at
100 % zoom" stays an attestation.

*Six thresholds are ours, not the contract's* (ISO spread and ceiling, frame-gap
and session-length, sharpness floor, fill tolerance). Each is labelled
`from: 'convention'` in `CONTRACT`, each only ever warns, and the test asserts
that labelling. Failing a capture on a number we invented would be worse than
having no tool.

**`NO DATA` is a distinct status and must stay one.** A frame with EXIF
stripped makes the optics checks read `NO DATA`, never `PASS`. "We looked and
it is fine" and "we could not look" are different answers.

**Two bugs the drive check caught, noted so they are not reintroduced.** The
report drawer shipped visible because an author `display: flex` beats the UA
stylesheet's `[hidden]` rule — `.photoset-drawer[hidden] { display: none }` is
load-bearing. And ticking an attestation redraws the whole report, so both
scroll positions are saved and restored across the rebuild.

**The contract doc is now load-bearing.** `tools/nso_photoset_test.js` section 1
parses the section 5.1 table out of `docs/PHOTOGRAMMETRY-CAPTURE.md` and fails
if the six frame counts, the 93 total, the 15° step, the 3-frames-per-ring
scale rule, the 60–80 % framing window, the f/5.6–f/11 target or the hand-hold
rule disagree with the code. Editing the spec reddens the suite on purpose:
a validator grading against a contract nobody agreed to is the worst failure
this feature could have.

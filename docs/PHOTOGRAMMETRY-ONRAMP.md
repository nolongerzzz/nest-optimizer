# Photogrammetry upload onramp

**Status: shipped, and it is the first thing in NSO that reads the capture
contract.** `docs/PHOTOGRAMMETRY-CAPTURE.md` was written by the feasibility
spike as a paper specification with nothing implementing it. This is the
implementation of the part that can be implemented without a reconstruction:
a photographer submits a photo set, and the tool says whether it is in
contract, clause by clause, before anyone spends reconstruction time on it.

That is the entire value. A bad shoot is caught here or it is caught after
13 minutes of feature extraction, an hour of dense reconstruction, and a
drive back to a subject that has since been moved.

## What this is not

Named explicitly, because the boundary is the point:

- **No reconstruction backend.** No COLMAP, no Meshroom, no hosted API. No
  network call of any kind — the photographs never leave the browser.
- **No repair pre-stage.** Scale-to-mm, debris filtering, decimation and
  boundary-loop classification are all still to come, and the feasibility
  report sets out what they have to do.
- **No live capture guidance.** Nothing here helps while the shoot is in
  progress. It reads a finished set.

This ticket ends at *"a validated photo set is confirmed ready"*. "Ready"
means the capture is worth a reconstruction's time. It does not mean the
reconstruction will succeed — section 8.3 of the contract has five more gates
that only a sparse reconstruction can answer, and they are listed unanswered
in every report rather than quietly omitted.

## The files

| file | what it is |
|---|---|
| `nso_photoset.js` | the contract as data, all 31 checks, the grading. Pure — no DOM, no network, no image decoding |
| `nso_exif.js` | the smallest EXIF reader that answers section 4. Never throws; an unreadable file returns null |
| `app-photoset.js` | the UI: the file input, the two pixel statistics (which need a canvas), the report |
| `tools/nso_photoset_test.js` | 93 headless checks, including the shot list in code against the shot list in the doc |
| `tools/nso_photoset_drive_check.js` | the panel driven in Chromium on 93 real JPEGs built for the run |
| `tools/nso_photoset_fixtures.js` | the JPEG/EXIF builder both checks share |

`npm run photoset:test` and `npm run photoset:drive`; both are in `npm test`.

## The three kinds of check, which is the whole design

The contract has 12 numbered checks and a dozen more requirements in prose,
and **they are not the same kind of thing**. Flattening them into one PASS/FAIL
list would make this feature actively harmful: an operator told "all green" by
a tool that never looked at the lighting will trust a bad shoot more than they
would have trusted their own judgement. So every check declares its kind, and
the report is grouped by it.

### Decided from the photographs — 15 checks

The machine looked. A verdict here is evidence.

| check | clause | how |
|---|---|---|
| shot list complete — 93 contract frames | 5.1 | count, with detail passes in their own bucket |
| every pass has its own count | 5.1 | arithmetic, once the operator has assigned frames (see below) |
| no duplicate frames | 5.1 | content hash — a copy is not a second position |
| focal length fixed | 4 | EXIF `FocalLength` constant across the set |
| one lens, no camera switch | 4 | `LensModel` / `FocalLengthIn35mmFilm` constant — catches a phone flipping to its ultra-wide |
| aperture fixed | 4 | `FNumber` constant. A phone's fixed f/1.8 passes: *fixed* is the requirement, f/5.6–f/11 is a target |
| ISO low and steady | 4 | spread and ceiling — both convention-grade, so both only warn |
| shutter above the hand-hold limit | 4 | `ExposureTime` vs 1/(2 × 35 mm equivalent). Warns, because a tripod is legal |
| no on-camera flash | 3 | the `Flash` fired bit. Fails — a light that moves with the camera |
| no HDR / portrait / panorama / night | 4 | `CustomRendered`, `SceneCaptureType` |
| one frame size, one camera body | 4 | sorted dimensions and `Model`. A turned camera warns; a crop fails |
| files straight off the camera | 4 | EXIF present, `Software`, body count |
| one continuous session | 5.3 | `DateTimeOriginal` gaps — a long gap means the object may have been touched |
| no frame far softer than the set | 8.2 #6 | variance of Laplacian on a **native-resolution centre crop** |
| subject fill estimate | 8.2 #7 | subject extent against the backdrop, on a downsampled frame |

**One of these needs an input first.** Nothing in a photograph records the
elevation it was shot at — no EXIF tag carries it and no pixel statistic
recovers it — so the per-pass counts cannot run until the operator says which
frames are which. The panel pre-fills the assignment from filenames that
already carry it (`ringB_07.jpg`) and offers "assign in shot-list order", but
the assignment is the operator's declaration, not a measurement.

### Only the photographer can confirm — 11 attestations

These are **not decidable after the fact, at any cost, from the images.** They
are ticked by the operator, the report records that a person vouched for them,
and an unticked box blocks "ready" exactly as hard as a failure does.

| clause | why no amount of image analysis settles it |
|---|---|
| subject 30–250 mm, opaque | size is a property of the object. A photo of a 40 mm bracket and one of a 4 m girder are the same photo |
| surface not transparent / mirrored / gloss | the failure is in the *correspondence*, not in any one frame. A mirrored part photographs beautifully |
| camera moved, object still | a turntable capture and an orbit capture produce identical frames. Only the background separates them, and the contract requires the background to be blank |
| backdrop matte, non-repeating | whether a grey field repeats is a judgement about the physical cloth |
| **lighting diffuse and static** | the clearest case. A shadow fixed to the object and a shadow fixed to the camera look the same in any single frame; the difference only shows up as a failed reconstruction |
| scale reference of **known length**, 3+ frames per ring | detecting a bar needs marker detection this ticket does not build — and even detected, its *length* is knowledge the operator has and the image does not. Section 7 is why the whole NSO handover works in millimetres |
| underside covered — flip pass or spike | which of the two legal routes was taken changes what the counts should be, and nothing in the frames says which |
| object untouched between halves | the shared surface texture is the only thing tying the halves into one model. A wipe with a cloth is invisible in the files and fatal in the solve |
| every frame sharp at 100 % zoom | see below — the statistic flags outliers and cannot certify |
| subject fills 60–80 % of the short side | the estimate is coarse and wrong on a busy scene |
| stabilisation set, no beautify or post-sharpening | stabilisation is not an EXIF tag on most bodies, and a filter that re-encodes a file leaves no tag at all |

### Needs a reconstruction — 5 gates, carried unanswered

Section 8.3: every frame registered, exactly one sub-model, mean track length
≥ 4.0, no azimuth gap > 30°, and reprojection error reported (deliberately
*not* a quality gate). They are listed with their thresholds and marked
`LATER`. None of them blocks. They are in the report so that it says what it
has **not** checked, rather than implying it checked everything.

## Two findings that shaped the code

**The focus statistic is sampled at native resolution, on purpose.** The
obvious implementation downsamples each frame and measures that. It would be
wrong in the direction that matters: the feasibility report measured that
defocus out to a 4 px radius on a 4032 px frame changes *nothing* — 8/8
registered, track length within 4 % — and that at 8 px the same capture loses
60 % of its keypoints and registers 4 of 8. Downsample 4032 to 512 and those
two frames become the same picture. So the measurement is taken on a 512 px
square crop from the centre of the frame at full resolution, which is the
100 % zoom the contract's check 6 asks the operator for.

It still cannot certify the set. What collapses under defocus is **keypoint
yield**, not any smooth quality curve, and there is no warning band between
sharp and fatal. The check flags frames far below the set median and says in
its own report text that a clean result is not a certificate. Check 6 stays an
attestation for exactly that reason.

**A convention-grade threshold never fails hard.** The contract is careful to
say which of its numbers are measured and which are convention or margin. Six
thresholds in this module are ours rather than the contract's — the ISO spread
and ceiling, the frame-gap and session-length limits, the sharpness floor and
the fill tolerance. Every one is labelled `from: 'convention'`, every one only
ever warns, and the report text says so where it fires. A tool that fails a
capture on a number it made up is worse than no tool.

## Statuses

| status | meaning | blocks "ready"? |
|---|---|---|
| `PASS` | looked, in contract | — |
| `FAIL` | looked, out of contract | **yes** |
| `WARN` | a soft signal, or a convention-grade threshold | no |
| `CONFIRM` | an attestation not yet ticked | **yes** |
| `NO DATA` | could not look — no EXIF carried the tag | no |
| `LATER` | needs a reconstruction | no |

`NO DATA` is never folded into `PASS`. "We looked and it is fine" and "we could
not look" are different answers, and a report that conflates them is the same
lie as the all-green one.

## What comes next

Not in this ticket, in rough order:

1. **The repair pre-stage** — scale-to-mm from the operator's known length,
   debris filtering, decimation, boundary-loop classification. Part 3 of the
   feasibility report is the specification.
2. **The reconstruction backend**, and with it the five deferred gates, which
   become real checks the moment there is a sparse model to read.
3. **Scale-reference detection**, if coded targets are adopted — it would move
   one attestation into the automatic column, though the *length* stays the
   operator's to supply.
4. **Live capture guidance**, which is a different feature with a different
   shape: this one reads a finished set.

# Photogrammetry capture contract

**Status: read by the upload onramp (2026-09-19).** This was written as a
paper contract so that when the input layer was built, the capture side was
already decided and not rediscovered one photograph at a time. The first part
of that input layer now exists: `nso_photoset.js` carries sections 3, 4, 5.1
and 8.2 as executable checks, and `tools/nso_photoset_test.js` parses the shot
list out of *this file* and fails if the code and the table below disagree.
**Edit section 5.1 and that check goes red - which is the point.**

Sections 8.3 and 9 remain unimplemented: 8.3 needs a sparse reconstruction,
which nothing in NSO runs yet, and 9 is a decision the operator takes before
the shoot. `docs/PHOTOGRAMMETRY-ONRAMP.md` says exactly which clauses are
machine-checked, which are attestations, and why.

The companion document `PHOTOGRAMMETRY-FEASIBILITY.md` is the measurement
report this spec's numbers are calibrated against. Where a number here is
measured, it says so and points at the case; where it is a convention or a
safety margin, it says that instead. Nothing here is a guess presented as a
measurement.

## 1. What this contract is for

The roadmap decision this spec implements is: **photogrammetry capture is
deterministic and professional-grade, not single-photo trial and error.** That
phrase has a precise engineering meaning and this document is the expansion of
it:

- **Deterministic** — the operator executes a fixed, countable shot list. The
  capture is complete when the list is complete. There is no "take some more
  from over there and see if it works", because "see if it works" means
  running a reconstruction, which is minutes to hours, and by then the object,
  the light and the rig have moved.
- **The capture is accepted or rejected on the capture's own evidence** —
  frame count, coverage, focus, scale reference — before a reconstruction is
  attempted, and then on cheap sparse-reconstruction statistics before the
  expensive dense stage. See section 8.
- **Professional-grade** means the failure modes are designed out by the
  contract rather than discovered by the operator. A capture that satisfies
  sections 2 through 6 reconstructs. A subject that cannot satisfy section 2
  is refused up front instead of consuming an afternoon.

The contract is deliberately stricter than the minimum that "works". The whole
point is to remove the operator's judgement from the loop, and that costs
frames. Frames are cheap; a re-shoot is not, because it usually happens after
the object has been moved.

## 2. Subject envelope — what this contract covers

The contract is written for the class of object NSO already works on: a part
that fits a Bambu plate, **30 mm to 250 mm** on its longest axis, opaque, and
matte enough to hold a stable texture under diffuse light.

**In scope.** Printed and machined parts, tooling, jigs, brackets, moulded
housings, found objects being copied or fitted to.

**Out of scope, and no photo count fixes them.** Photogrammetry recovers
surface from *correspondence*: the same physical point must be identifiable
from several directions. Four surface classes break that premise outright, and
they fail regardless of coverage:

| surface | why correspondence fails | what to do instead |
|---|---|---|
| transparent / translucent | the imaged point is refracted background, not surface | dulling spray, or don't |
| mirror / bare polished metal | the imaged point is a reflection that moves with the camera | dulling spray |
| uniform gloss (piano black, glossy white) | specular highlight moves with the camera; the matte part carries no texture | dulling spray + cross-polarisation |
| featureless matte (a blank printed face, a sanded block) | there is nothing to match — the surface is real but textureless | projected/applied speckle, or accept that flat regions interpolate |

The last row is the one that surprises people, and it is the one most likely to
bite NSO: **a freshly printed part in a single filament colour is close to the
worst case for photogrammetry.** Layer lines give some texture on curved and
angled faces, but a large flat top face in uniform PLA can carry almost none.
This is a capture-contract problem, not a reconstruction-quality problem, and
section 9 says how the contract handles it.

## 3. The rig

Deterministic means the operator is not making judgement calls. Everything
below is fixed before the first frame.

- **Camera moves, object stays still.** A turntable with a fixed camera is the
  other common rig and it is *harder*, not easier: the background then moves
  relative to the object, so every background feature is a wrong match. If a
  turntable is used, the background must be blanked (section 3, backdrop) and
  the object must be masked.
- **Backdrop**: matte, mid-grey, non-repeating. Never a chequerboard, never a
  repeating weave, never a mirror. A repeating pattern produces confident wrong
  matches, which is worse than no matches.
- **Lighting**: diffuse and *static relative to the object*. Two softboxes or
  full overcast daylight. No on-camera flash, no single hard source, no moving
  shadow. A shadow that moves with the camera is a texture that lies.
- **Scale reference**: a printed scale bar, a coded target set, or any object
  of known length laid in the scene, visible in **at least 3 frames of every
  ring**. This is not optional and section 7 explains why: everything
  downstream of the reconstruction is in millimetres, and the reconstruction
  is not.
- **Support**: the object sits on something that lets the camera get below its
  silhouette — a small stand or spike — or the capture is done in two flips
  (section 5).

## 4. Camera settings — fixed for the whole capture

The single most damaging thing an operator can do is change the optics
mid-capture. All of these are set once, before frame 1, and not touched.

| setting | requirement | why |
|---|---|---|
| focal length | **fixed**; no zoom, no digital zoom, no "auto framing" | one camera model is solved for the whole set; changing focal length silently invalidates it |
| focus | **fixed** after the first frame (manual focus, or AF-lock) | refocusing changes effective focal length (focus breathing) |
| aperture | smallest that keeps exposure sane, target **f/5.6–f/11** on a real camera | the whole object must be inside depth of field; a phone's fixed f/1.8 is a constraint, not a choice — see below |
| ISO | lowest that holds the shutter speed | sensor noise is texture that does not correspond between frames |
| shutter | fast enough to freeze hand-shake; **1/(2 x focal length equivalent)** or faster | motion blur destroys keypoints faster than anything else |
| stabilisation | **off** on a tripod, on when hand-held | IS drifting between frames adds apparent motion |
| format | straight-out-of-camera JPEG at max quality, or RAW→linear JPEG | heavy re-compression and "beautify" filters wreck fine texture |
| processing | **no** HDR, no portrait/bokeh mode, no night mode, no beauty filter, no post sharpening | these are per-frame non-linear edits; they break correspondence |

**Phones specifically.** Phone captures are legitimate — the feasibility test
in the companion report used 4032 x 3024 iPhone photos and reconstructed the
subject cleanly. But three phone defaults must be overridden: computational
HDR / night mode off, portrait mode off, and the lens locked (do not let the
phone switch between its wide and ultra-wide cameras mid-capture — that is a
focal-length change, the first row of this table).

## 5. The shot list

This is the deterministic part. The operator executes it; the operator does not
decide it. Positions are counted, not judged.

### 5.1 The list

For an object in the section 2 envelope, with the rig of section 3:

| pass | elevation above the object's horizon | positions | frames | notes |
|---|---|---|---|---|
| **Ring A — low** | 15° ± 5° | 24, every 15° of azimuth | 24 | sees vertical walls and undercuts |
| **Ring B — mid** | 45° ± 5° | 24, every 15° of azimuth | 24 | the workhorse ring; most track length comes from here |
| **Ring C — high** | 70° ± 5° | 24, every 15° of azimuth | 24 | sees top-facing surfaces at a usable angle |
| **Top** | ~90°, near-vertical | 4, every 90° | 4 | four, not one — a single nadir frame has no baseline partner |
| **Flip pass** | object inverted; 40° ± 10° | 16, every 22.5° of azimuth | 16 | the underside; see 5.3 |
| **Flip top** | ~90° on the inverted object | 1 | 1 | the former base face |
| | | | **93** | |

Detail passes (a deep pocket, a fine boss) are **added to** this list, never
substituted into it: 8 extra frames around the feature at the ring-B radius,
recorded as a named extra pass.

### 5.2 Why 15° and why three rings

**15° of azimuth between neighbours** gives 24 positions per ring and puts
every point that is visible across a 90° sweep of the object into roughly 6
frames per ring. That is the target: the feasibility report measures mean track
length as the statistic that actually tracks reconstruction quality, and a
capture built this way is aiming at **track length 5 or better**.

The total is anchored to a measurement rather than to convention. The reference
capture reached **track length 5.08 with 41 frames spanning ~169° of azimuth**
— about **0.24 frames per degree** — while registering 41 of 41 into a single
model. Holding that density around a full 360° gives **≈87 frames**, and this
list specifies 93. So the size of the list is the measured density of a capture
that demonstrably worked, extended to the full orbit the reference capture
never made, plus a small margin.

**Three rings, not one denser ring.** Measured: the reference capture's 41
frames span 8.5° to 79.7° in elevation, and that elevation spread is doing work
that no amount of extra azimuth density would do. A surface facing up is seen
edge-on from ring A and face-on from ring C; only ring C can measure it.

**24 per ring is far above the measured failure point, on purpose.** The
feasibility report finds registration still succeeding at 10 evenly-spread
frames on this subject — and failing unpredictably below that, with 8 frames
registering only 4 while 7 frames registered all 7. The specification does not
sit near that boundary, because a capture whose success depends on which
frames happened to land is not deterministic, whatever its average behaviour.
The margin is also what absorbs the frames re-taken at check 6.

### 5.3 The flip

The object stands on something, and whatever it stands on is never
photographed. Two legal ways to satisfy the contract:

- **Flip pass (default).** Shoot rings A–C and Top, then invert the object, and
  shoot the flip pass. The two halves are reconstructed together — they share
  the ring-A/flip-pass band of surface, which is what lets the solver tie them.
  **The object must not be cleaned, re-lit or re-speckled between halves**: the
  surface texture is the only thing linking them.
- **Supported capture.** The object sits on a narrow spike or pin so the camera
  can pass below its silhouette. Ring A then drops to 0° or below and the flip
  pass is dropped. Only viable for objects that can be balanced.

**A capture with neither is out of contract.** It produces a mesh with a
boundary loop the size of the object's footprint, and part 3 of the feasibility
report shows exactly what the repair pipeline does with that.

## 6. Why the shot list is shaped the way it is

Three independent requirements set the shape, and they are not
interchangeable — satisfying one does not buy you another.

**Overlap along a ring** fixes the *baseline*. Two cameras that see the same
surface patch from nearly the same place triangulate it badly (the rays are
almost parallel); two that see it from very different places may not match it
at all (the patch looks different). The angular step between neighbouring
frames is the knob that trades these off, and the measured consequence of
opening it too far is in the feasibility report.

**Several rings at different heights** fix the *surface normal coverage*. A
single horizontal ring sees every vertical wall well and every horizontal
surface at a grazing angle, where texture is foreshortened into nothing.
Top-facing surfaces need cameras above them. This is why the list is rings,
plural, and not one orbit with more frames in it — **more frames on one ring
does not substitute for a second ring.**

**A flip** fixes the *underside*. Whatever the object stands on is never
photographed, and no amount of coverage from above recovers it. Either the
object is supported so the camera can get under it, or the capture is done
twice with the object inverted. A capture that does neither produces a mesh
with a hole where the base was — which, as part 3 of the feasibility report
shows, is the single largest problem the mesh hands to the repair stage.

**Redundancy is the fourth, unglamorous requirement.** The shot list is sized
so that losing a frame to a soft focus or a passer-by does not take the capture
below the working threshold. The measured failure point is not the
specification; the specification sits above it deliberately, and section 5 says
by how much.

## 7. Scale — the requirement that exists because of NSO, not because of photogrammetry

**A photogrammetric reconstruction has no size.** Structure-from-motion
recovers the scene and the camera path up to an arbitrary similarity
transform: the shape and all the angles are right, the *size* is a free
parameter with no physical meaning. COLMAP will happily hand back a model
whose bounding box is 2.7 "units" across. Nothing in the image set determines
whether that is 27 mm or 270 mm.

Everything on the NSO side of the handover is in millimetres, absolutely:

- `NSO_Repair.WELD_TOL = 1e-4` mm — an absolute distance, and the whole
  tolerance budget in `docs/NSO_Repair.md` is argued in millimetres against
  float32 spacing.
- `NSO_Repair.SPLIT_EPS = 5e-3` mm.
- `tools/mesh_validate.py --min-wall 0.42` mm — one extrusion line at a 0.4 mm
  nozzle.
- Plate size, nesting, and every cooling and finishing default.

So a mesh imported at the reconstruction's native scale meets a repair module
whose tolerances mean nothing at that scale. Depending on which way the
arbitrary factor falls, `WELD_TOL` is either far below the float32 noise floor
(does nothing) or a large fraction of the part (welds real features away).
Neither failure announces itself.

**Therefore the capture must carry the scale, and the only way it can is
physically, in the scene.** Hence the scale-reference requirement in section 3.
A known length visible in at least 3 frames of every ring lets the operator fix
one distance after reconstruction and pin the whole model to millimetres.

This is the clearest example of the contract being driven by what happens
*after* the photographs: no amount of extra coverage substitutes for it, and it
costs one printed scale bar.

## 8. Acceptance — checks that run before anyone waits for a reconstruction

Deterministic capture means a capture is accepted or rejected on its own
evidence, not on how the mesh happened to turn out. Three gates, in order of
cost.

### 8.1 Pre-flight (before the first frame) — operator checklist

1. Subject is in the section 2 envelope, or has been dulled/speckled.
2. Backdrop matte, non-repeating; lighting diffuse and static.
3. Scale reference in the scene.
4. Camera: focal length fixed, focus locked, HDR/portrait/night off,
   stabilisation set, ISO floor, shutter above the hand-hold limit.

### 8.2 On-capture (before leaving the rig) — countable, no computer needed

5. The shot list in section 5 is **complete**, not approximately complete. A
   ring with a missing position is a re-shoot of that position, not a
   judgement call.
6. Every frame is in focus at 100 % zoom on the subject. Re-take any frame
   that is not.

   **The usual justification for this rule is wrong, and the real behaviour is
   worse.** Measured: Gaussian defocus out to a **4 px** radius on 4032 px
   frames changed registration not at all (8/8 at every level), moved mean
   track length under 4 %, and slightly *improved* reprojection error. Soft
   frames do not "register weakly and drag the bundle" — that claim was in this
   spec's first draft and the measurement removed it.

   But at **8 px** the same capture lost 60 % of its keypoints and registered
   **4 of 8**. Defocus does not degrade a capture gradually; it does nothing at
   all and then it destroys it, with no useful warning band between. An
   operator cannot distinguish 4 px from 8 px on a camera back.

   So the rule is a **margin against a cliff**, not a defence against gradual
   decay — which is why it stays absolute here. Two things this does not cover:
   fine texture is consumed by the **dense** stage rather than by sparse
   registration, and **motion blur is directional** where defocus is isotropic.
   Neither was measured.
7. The subject fills roughly **60–80 %** of the frame's short dimension in
   every ring frame.

### 8.3 Post-SfM (cheap, before committing to the dense stage)

Sparse reconstruction is a small fraction of the total cost — **82 s against
13 minutes** of feature extraction and matching on the reference capture — so
it is the right place to gate. Run the sparse reconstruction, check these five,
and only then spend the dense stage.

| # | check | threshold | where it comes from |
|---|---|---|---|
| 8 | **every submitted frame registered** | 100 %, no exceptions | measured: partial registration is not graceful degradation. 8 frames registered 4 while 7 frames registered all 7 |
| 9 | **exactly one sub-model** | 1 | two sub-models are two unrelated coordinate frames; they cannot be combined into one part |
| 10 | **mean track length** | **≥ 4.0** | measured: 20 evenly-spread frames reach 4.12, the full 41 reach 5.08, and a disciplined 11-frame capture reached 4.77. Below ~3 the average point rests on a single baseline |
| 11 | **no azimuth gap between recovered cameras > 30°** | 30° | convention: twice the 15° design step of section 5. It is the check that catches a shot list executed incompletely, and it is the one the reference capture fails — a 166.8° gap, which is where its mesh has a hole |
| 12 | **mean reprojection error** | report it; investigate only above ~2 px | measured, and **deliberately not a quality gate** — see below |

**Check 10 and check 11 must both pass, and neither substitutes for the
other.** This is measured, not assumed: a 23-frame capture crowded into a 90°
wedge scored a mean track length of **4.57** — comfortably over the threshold,
and *higher* than 24 frames spread evenly (3.91) — while reconstructing only
the side of the object it could see. Cameras that crowd one side see the same
surface repeatedly, which is exactly what lengthens tracks. **Track length
measures how well the captured surface was measured; it says nothing about how
much of the object was captured.** Check 11 is what says that, and it is
computed from the recovered camera positions, which the sparse reconstruction
has already produced.

**On check 12.** A *low* reprojection error must never be read as success. The
feasibility report shows the relationship inverted on real data: five frames
gave 0.62 px and forty-one gave 1.29 px, because a two-view point can be placed
to sit on both of its rays and contributes almost no residual while being
almost unconstrained. The number is useful for catching gross failures — a
mis-set focal length, a mixed-focal-length set — and for nothing else.

## 9. Textureless surfaces — the one case the shot list cannot fix

Section 2 lists featureless matte surfaces as out of scope, and a single-colour
printed part is often exactly that. The contract handles it in one of three
declared ways, chosen **before** the capture, never during:

1. **Speckle it.** A fine, random, high-contrast spatter — chalk spray,
   developer spray, dry-shampoo mist, a stippled marker — applied to the
   surface. This is the professional answer and it is what makes the capture
   deterministic: the surface is *given* the texture the method requires
   instead of being hoped to have it.
2. **Accept interpolation on flat faces.** A flat, featureless face between
   well-textured edges will reconstruct as a smooth interpolation. For a face
   that really is flat that is often fine, and the resulting geometry is not
   wrong, just unmeasured. This must be a stated decision, because it means
   the face's flatness came from the reconstruction's smoothness prior, not
   from the object.
3. **Don't.** A part that is featureless *and* whose flat faces matter is not
   a photogrammetry subject. Calipers and CAD are the right tool and the
   contract should say so rather than produce a plausible mesh.

## 10. What this contract deliberately does not cover

- **Reconstruction settings.** Which SfM/MVS implementation, which matcher,
  which meshing parameters. Those belong with the implementation, not the
  capture.
- **Mesh post-processing.** Decimation, hole classification, scale
  normalisation and repair are the input layer's job, and the feasibility
  report sets out what they have to do.
- **Texture/colour.** NSO is a geometry tool. Nothing here asks for
  photometric quality beyond what geometry needs.
- **Turntable automation, coded targets, calibrated rigs.** All compatible
  with this contract and all out of its scope; they change how the shot list
  is executed, not what it contains.

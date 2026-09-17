# Photogrammetry feasibility — measured, outside NSO

**Status: research spike.** No NSO code was changed, nothing was wired into the
app, and nothing here depends on other work in flight. Everything below was run
in an isolated workspace (`/home/user/pgspike`) against real photographs, with
the repo used read-only for the downstream assessment in part 3.

This report backs `PHOTOGRAMMETRY-CAPTURE.md`. Its three parts answer:

1. **Does it work, and on what?** — real COLMAP runs on real phone photographs.
2. **What coverage is actually required?** — a controlled sweep where only the
   image selection changes.
3. **Does the output fit NSO_Repair and the non-solid flag?** — the mesh from
   part 1, pushed through the repo's own `NSO_Repair.commit()` and
   `tools/mesh_validate.py`.

## Honest limits of this spike, stated first

- **No GPU.** The container has no CUDA device, so COLMAP's own dense stage
  (`patch_match_stereo`) could not run and OpenMVS was built from source for
  the CPU dense path. This affects **speed, not the coverage conclusions**: the
  sparse stage, which is where coverage is decided, is unaffected.
- **One mesher family, and part 3 depends on which.** The mesh was produced by
  OpenMVS `ReconstructMesh`, which extracts the surface by a graph cut through
  a Delaunay tetrahedralization. Meshroom/AliceVision works the same way, so
  the finding in section 3.1 — that the raw mesh is manifold — should carry to
  it. A **screened-Poisson** mesher (Metashape and several others) reconstructs
  differently, and its output's topology was **not** measured here. Section
  3.1's conclusion is about this family, not about photogrammetry in general,
  and it is stated that way.
- **Two subjects, not a survey.** One 41-photo phone set and one 11-photo DSLR
  set. That is enough to measure how a *specific* capture degrades as coverage
  is removed, which is what the spec needs. It is not enough to publish a
  universal "N photographs" constant, and this report does not claim one.
- **The photographs were not shot to this spec.** They are someone else's
  hand-held capture. That makes the coverage findings conservative: a capture
  following the contract should do better, not worse.

## Findings at a glance

**Photogrammetry works on ordinary phone photographs.** 41 hand-held iPhone 7
frames reconstructed 41/41 into a single model, on a CPU, in about 15 minutes
end to end. Nothing about this is marginal or exotic.

**There is a floor below which the result stops being a function of frame
count.** Below 10 frames the outcome is non-monotonic: 8 frames registered 4
while 7 frames registered all 7 — reproducibly, across three random seeds. The
discriminator turned out to be the density of the verified image-pair graph,
which the operator cannot observe at capture time and which only exists after
the most expensive stage in the pipeline. So the overlap has to be *guaranteed
geometrically* by the shot list rather than checked afterwards. That is the
measured shape of the roadmap's "no single-photo trial and error" decision.

**The metrics that look like quality cannot see the failure that matters.**
Mean reprojection error is *inverted* against quality on real data, and mean
track length is *raised* by exactly the bad capture habit it ought to punish —
crowding one side of the object. A 23-frame capture confined to an 87° wedge
passed every reconstruction-quality check while never looking at
three-quarters of the part. Capture geometry has to be gated directly, and it
is free to compute.

**The mesh is not the shape of the problem people expect.** Raw photogrammetry
output is conventionally described as "noisy, non-manifold, full of holes". The
mesh measured here is **manifold, consistently wound, has zero degenerate
triangles and five holes** — because a graph cut through a Delaunay
tetrahedralization is manifold by construction. The topological rubble arrives
later, from the **decimator**, and cleaning up after a decimator is something
NSO_Repair is genuinely good at: it took non-manifold edges 13 to 0, pinch
vertices 24 to 0 and winding errors 26 to 0 on the first attempt, gate
satisfied.

**The non-solid flag must stay off, and the measured reason is stronger than
the semantic one.** Turning it on does not merely skip three stages — the
stages left running raise the odd-edge count, the final gate fires, and **the
entire repair is discarded**. The mesh comes back untouched, non-manifold edges
and all. Both components behaved exactly as documented; the interaction is the
problem.

**What actually needs building is a pre-stage, not a change to NSO_Repair** —
scale to millimetres, drop debris by real-world size, decimate to a budget, and
classify boundary loops. The last of those needs to know which way was down
during the capture, which is metadata that costs nothing to record and cannot
be recovered afterwards. That requirement flows backwards into the capture
contract.

## Part 1 — Does it work at all, on real phone photographs?

**Yes, and comfortably.**

The reference run is all 41 iPhone 7 photographs, COLMAP 3.9.1, CPU only,
`SIMPLE_RADIAL` camera shared across the set, EXIF focal-length prior.

| stage | result | wall clock |
|---|---|---|
| feature extraction, 41 images at 3200 px | mean **13,030** keypoints/image (9,555 – 16,815) | 6.7 min (contended) |
| exhaustive matching, 820 pairs | **584** geometrically verified pairs (71 % of all possible) | 6.2 min (contended) |
| incremental mapping | **41 / 41 registered, 1 sub-model** | **82 s** |
| sparse model | 32,606 points, 165,567 observations | |
| | mean track length **5.08**, mean reprojection error **1.288 px** | |

Two things in that table are worth pulling out.

**The mapping stage is not the expensive one.** 82 seconds, against 13 minutes
for extraction and matching. That matters for where an acceptance gate goes:
the sparse reconstruction is cheap enough to run as a *check*, and the spec's
section 8.3 gate is built on that.

**71 % of all image pairs verified.** On a capture of a single small object
that is a well-connected graph, and it is the underlying reason the count
sweep in part 2 degrades gracefully rather than falling off a cliff.

### What the reference capture actually is — and it is not a full orbit

Camera positions recovered from the reconstruction, expressed as azimuth about
the reconstructed object centre in the dominant plane of the camera path:

- azimuth spans **16.5° to 168.9°** — roughly **169°**, one side of the object —
  plus **two** outlying frames at 335.8° and 349.2°.
- the largest azimuth gap is **166.8°**.
- elevation spans **8.5° to 79.7°**, so the capture is a hemispherical scatter,
  not a ring. The camera-centre SVD confirms it: singular values
  21.18 / 10.30 / 9.00, and a third value that large means the cameras are
  nowhere near coplanar.
- median azimuth step between neighbours **3.3°**, mean 8.8°.

This is a real hand-held capture by someone not following any contract, and it
has a hole in its coverage roughly the size of the back of the object. It is
therefore an *honest* subject for this spike rather than a flattering one, and
it is the direct cause of the largest defect in the mesh assessed in part 3.

## Part 2 — What coverage is actually required

### How the sweep is controlled

Photo-count experiments are easy to get wrong: re-running the whole pipeline
per subset changes the features and the matches as well as the image
selection, and then a difference between two runs cannot be attributed.

This sweep does it the controlled way. Features and pairwise matches were
computed **once** over all 41 images into a single database. Each subset run
then re-uses that database unchanged and varies only which images the mapper
is permitted to register (`colmap mapper --image_list_path`), with
`--random_seed` pinned. Identical keypoints, identical descriptors, identical
two-view geometry. **The only independent variable is which photographs the
operator took.**

Subsets are chosen by the recovered camera azimuths from part 1, not by
filename order, so "12 photos" means 12 positions spread as evenly as the
capture allows — which is what an operator following a shot list would
produce — and not 12 consecutive frames.

Three families:

- **count_NN** — NN cameras spread evenly around the available azimuth range.
  This is the photo-count question.
- **arc_DDD** — every camera inside a contiguous azimuth wedge of DDD degrees.
  This is "the operator only shot the front".
- **gap_DDD** — every camera *except* a contiguous wedge of DDD degrees. This
  is "the operator orbited but skipped one side", which is the more common and
  more insidious failure, because the frame count still looks healthy.

Because the reference capture itself only spans ~169° of azimuth (part 1), the
`arc_180`, `arc_240` and `arc_300` subsets all resolve to the same 39 cameras.
They are reported as measured rather than quietly dropped.

### What "usable, clean reconstruction" is taken to mean

A reconstruction is only "usable" against a purpose, so the bar is stated
before the numbers rather than fitted to them afterwards.

For the NSO input layer, a capture is **usable** when all four hold:

1. **Every photograph registers.** A frame the mapper drops is a frame the
   operator took and paid for, and a dropped frame almost always means the
   coverage contract was not met near it. A capture that registers 4 of 8 is
   not "half good" — it has a hole where those 4 frames were looking.
2. **One model, not several.** COLMAP returns disconnected sub-models when the
   image graph splits. Two sub-models cannot be combined into one part: they
   are in unrelated coordinate frames with unrelated scales.
3. **Points are seen from many views.** **Mean track length** — how many
   cameras the average 3D point was actually seen by — is the honest coverage
   statistic. A point on 2 cameras is triangulated from a single baseline and
   is a guess; a point on 5+ is constrained by redundant geometry. Track
   length, not photo count, is what the dense stage consumes.
4. **The object is surrounded**, not merely photographed a lot. Section 2.3
   shows these are different things, measured.

### Mean reprojection error is a trap, and the measurements show why

The obvious quality metric is the bundle's mean reprojection error, and the
intuition is "lower is better". On this data that intuition is **backwards**:

| subset | photos registered | mean track length | mean reprojection error |
|---|---|---|---|
| `count_05` | 5/5 | 2.24 | **0.62 px** |
| `count_07` | 7/7 | 2.72 | 0.93 px |
| `count_12` | 12/12 | 3.39 | 1.06 px |
| `count_41` (all) | 41/41 | 5.08 | **1.29 px** |

The *worst* reconstructions have the *lowest* residuals. That is not a
paradox — it is overfitting, visible directly. With five images, almost every
surviving 3D point is seen twice, and a two-view point can be placed to sit
almost exactly on both of its rays; the residual it contributes is near zero
and it is also barely constrained. With forty-one images the average point
must satisfy five cameras at once and cannot be placed to please all of them,
so the residual rises while the point gets *more* trustworthy.

**Consequence for the acceptance gate in the spec:** reprojection error must
never be used on its own as a pass/fail number, and a low value on a sparse
capture must not be read as success. It is only meaningful read together with
mean track length, and the number that actually discriminates is track length.

### 2.1 Photo count — measured

Every row below shares one feature/match database; only the image selection
differs.

| subset | photos | registered | sub-models | sparse points | mean track len | mean obs/img | mean reproj (px) | mapper (s) |
|---|---|---|---|---|---|---|---|---|
| `count_04` | 4 | **2 / 4** | 1 | 100 | 2.00 | 100 | 0.67 | 0.2 |
| `count_05` | 5 | 5 / 5 | 1 | 1,619 | 2.24 | 725 | 0.62 | 1.2 |
| `count_06` | 6 | 6 / 6 | 1 | 1,054 | 2.47 | 434 | 0.93 | 1.2 |
| `count_07` | 7 | 7 / 7 | 1 | 1,800 | 2.72 | 700 | 0.93 | 2.2 |
| `count_08` | 8 | **4 / 8** | 1 | 1,742 | 2.29 | 997 | 0.85 | 1.6 |
| `count_10` | 10 | 10 / 10 | 1 | 3,788 | 3.17 | 1,199 | 1.01 | 4.2 |
| `count_12` | 12 | 12 / 12 | 1 | 3,797 | 3.39 | 1,073 | 1.06 | 5.9 |
| `count_14` | 14 | 14 / 14 | 1 | 5,173 | 3.55 | 1,313 | 1.24 | 9.4 |
| `count_16` | 16 | 16 / 16 | 1 | 7,378 | 3.70 | 1,705 | 1.23 | 12.8 |
| `count_20` | 20 | 20 / 20 | 1 | 11,509 | 4.12 | 2,370 | 1.20 | 25.7 |
| `count_24` | 24 | 24 / 24 | 1 | 15,215 | 3.91 | 2,479 | 1.25 | 33.9 |
| `count_28` | 28 | 28 / 28 | 1 | 19,741 | 4.38 | 3,091 | 1.29 | 46.8 |
| `count_32` | 32 | 32 / 32 | 1 | 24,201 | 4.51 | 3,410 | 1.28 | 60.4 |
| `count_36` | 36 | 36 / 36 | 1 | 27,495 | 4.76 | 3,639 | 1.29 | 82.6 |
| `count_41` | 41 | 41 / 41 | 1 | 32,606 | 5.08 | 4,038 | 1.29 | 114.2 |

**Three things this table says, and one it does not.**

**1. Below ten photographs the result is discontinuous — and it is not
randomness.** Four photographs registered two. Eight photographs registered
*four* — worse than seven, which registered all seven. The obvious suspicion is
mapper randomness, so every count subset was re-run on **three different random
seeds**:

| subset | seed 0 | seed 1 | seed 2 |
|---|---|---|---|
| `count_04` | 2 / 4 | 2 / 4 | 2 / 4 |
| `count_07` | 7 / 7 | 7 / 7 | 7 / 7 |
| `count_08` | 4 / 8 | 4 / 8 | 4 / 8 |
| every other count | identical | identical | identical |

**Registration was byte-identical across all three seeds for every one of the
15 count subsets** — not just the failures. Mean track length was identical too
on 13 of 15; on `count_06` and `count_24` it moved in the second decimal
(2.47/2.48 and 3.90/3.91/3.92), which is bundle-adjustment noise and nothing
more.

So the failures are **not a coin-flip** — they are a reproducible property of
those particular image sets.

**2. The discriminator is the pair graph, not the photo count.** Counting how
many of each subset's image pairs survived geometric verification explains
every row:

| subset | image pairs | verified | **density** | registered |
|---|---|---|---|---|
| `count_04` | 6 | 3 | **0.50** | **2 / 4** |
| `count_08` | 28 | 16 | **0.57** | **4 / 8** |
| `count_06` | 15 | 10 | 0.67 | 6 / 6 |
| `count_16` | 120 | 83 | 0.69 | 16 / 16 |
| `count_12` | 66 | 46 | 0.70 | 12 / 12 |
| `count_07` | 21 | 16 | 0.76 | 7 / 7 |
| `count_10` | 45 | 34 | 0.76 | 10 / 10 |
| `count_05` | 10 | 8 | 0.80 | 5 / 5 |

The two failures are **exactly the two lowest densities**, and every subset at
0.67 or above reconstructed completely. Eight frames failed where seven
succeeded because those particular eight positions happened to give a sparser
match graph — not because eight is a worse number than seven.

**Why this matters more than a threshold.** An operator in front of the object
cannot see pair-graph density. It exists only after feature matching, which is
the most expensive stage in the pipeline. So "take about eight photographs and
check" is not a procedure — the check costs more than the capture. The only way
to get a dependable match graph is to **guarantee it geometrically at capture
time**, by fixing the angular step so that neighbouring frames must overlap.
That is precisely what the shot list in the capture spec does, and this table is
the reason it is not negotiable.

**3. From ten photographs, registration is reliable and quality climbs
steadily.** Every subset from 10 up registered 100 % into a single model. Mean
track length rises 3.17 to 5.08 across that range and has not saturated at 41.

**4. Reprojection error saturates early and means little.** It settles around
1.2 to 1.3 px from 14 photographs up, and the *lowest* values in the table
belong to the *worst* reconstructions, for the reason given above.

**What the table does not say is "10 photographs is enough."** It says 10 is
where *registration* became reliable on this subject. Registration is the floor,
not the goal: at 10 photographs the average point is seen by 3.17 cameras and
the sparse cloud holds 3,788 points against 32,606 at 41.

### 2.2 Cross-check on a second subject — capture discipline beats frame count

`ImageDataset_SceauxCastle`: 11 DSLR frames at 2832 x 2128, a deliberate arc
across a castle facade, run through the identical CPU pipeline.

| | Monstree (phone, hand-held) | Sceaux (DSLR, planned arc) |
|---|---|---|
| frames | 41 | **11** |
| mean keypoints/frame | 13,030 | 10,882 |
| geometrically verified pairs | 584 / 820 — **71 %** | 55 / 55 — **100 %** |
| registered | 41 / 41, 1 model | 11 / 11, 1 model |
| sparse points | 32,606 | 8,055 |
| **mean track length** | **5.08** | **4.77** |
| mean reprojection error | 1.29 px | 0.61 px |
| total pipeline | ~13 min | **154 s** |

**Eleven planned frames very nearly matched forty-one hand-held ones on the
statistic that matters**, and beat Monstree's own 36-frame subset (4.76). Every
single image pair verified, against 71 % for the phone capture.

**The honest reading, including what confounds it.** Two variables changed at
once, so this is suggestive rather than conclusive:

- *Capture discipline* — a planned arc with consistent framing and a stable
  camera. This is the variable the spec can control, and it is the one the
  100 % pair-verification rate points at.
- *Subject and camera* — a stone facade is a genuinely easier subject than a
  small figurine: richly and non-repetitively textured, near-planar, almost no
  self-occlusion, and shot on a DSLR at low ISO. A facade cannot be
  photographed from behind either, so it never poses the problem a full object
  capture poses.

So this pair of runs **does not** show that 11 frames suffice for an object
capture, and this report does not claim it. What it does show is that **frame
count is not the governing variable** — a capture can carry far more
information per frame, and the pair-verification rate is where that shows up
first. It is direct support for the roadmap's deterministic-capture decision:
the gain from planning the capture is the same order as the gain from nearly
quadrupling the frames.

### 2.3 Coverage — why frame count is the wrong question

Two families here. `arc_DDD` keeps every camera inside a contiguous azimuth
wedge — "the operator only shot the front". `gap_DDD` removes a contiguous
wedge from an otherwise complete capture — "the operator orbited but skipped
one side", which is the more dangerous failure because the frame count still
looks healthy.

Because the reference capture itself spans only ~169° of azimuth (part 1), the
`arc_180`, `arc_240` and `arc_300` subsets all resolve to the same 39 cameras.
They are reported as measured rather than quietly folded together.

The sharpest single result in this report is the comparison between the full
capture and `arc_180`:

| | frames | sparse points | mean track length |
|---|---|---|---|
| `count_41` (everything) | 41 | 32,606 | **5.08** |
| `arc_180deg_n39` | 39 | 31,684 | **5.08** |

The two frames `arc_180` drops are the two outliers at azimuth 335.8° and
349.2° — **the only two frames in the entire capture that see the far side of
the object.** Removing them costs 922 sparse points (2.8 %) and moves the mean
track length by **nothing at all**.

So a quality metric computed over the reconstruction is structurally incapable
of noticing that an entire side of the object stopped being measured. It cannot
notice, because the surface that is left was measured just as well as before —
there is simply less of it. **Any acceptance gate built only on reconstruction
quality will pass a capture that missed half the part**, which is why the
spec's section 8.3 pairs the track-length check with an independent angular-gap
check computed from the recovered camera positions.

| subset | photos | azimuth span | largest camera gap | median step | registered | sub-models | sparse points | mean track len |
|---|---|---|---|---|---|---|---|---|
| `arc_90deg_n23` | 23 | 87.3° | **272.7°** | 3.1° | 23 / 23 | 1 | 17,717 | 4.57 |
| `arc_120deg_n31` | 31 | 118.4° | **241.6°** | 3.3° | 31 / 31 | 1 | 26,147 | 4.85 |
| `arc_180deg_n39` | 39 | 152.4° | **207.6°** | 3.2° | 39 / 39 | 1 | 31,684 | 5.08 |
| `arc_240deg_n39` | 39 | 152.4° | 207.6° | 3.2° | 39 / 39 | 1 | 31,684 | 5.08 |
| `arc_300deg_n39` | 39 | 152.4° | 207.6° | 3.2° | 39 / 39 | 1 | 31,684 | 5.08 |
| `gap_60deg_n25` | 25 | 266.5° | **166.8°** | 3.3° | 25 / 25 | 1 | 19,395 | 4.88 |
| `gap_90deg_n18` | 18 | 241.1° | 166.8° | 4.7° | **17 / 18** | 1 | 12,726 | 4.65 |
| `gap_120deg_n10` | 10 | 208.0° | 166.8° | 8.6° | **9 / 10** | 1 | 4,923 | 3.75 |
| `gap_150deg_n3` | 3 | 180.2° | 179.8° | 166.8° | **2 / 3** | 1 | 373 | 2.00 |

**Every arc subset reconstructed perfectly.** 23 photographs crammed into an
87° wedge registered 23 of 23 into one model at track length 4.57 — a result
that passes every reconstruction-quality check there is, on a capture that
never looked at three-quarters of the object. This is the failure the spec's
check 11 exists for, and no amount of extra frames inside that wedge would
reveal it.

**Removing a wedge costs registrations that thinning evenly does not.** The
controlled pairs are the point — same photo count, different distribution:

| | photos | distribution | registered | mean track len |
|---|---|---|---|---|
| `count_10` | 10 | even | **10 / 10** | 3.17 |
| `gap_120deg_n10` | 10 | 120° wedge removed | **9 / 10** | 3.75 |
| `count_20` | 20 | even | **20 / 20** | 4.12 |
| `gap_90deg_n18` | 18 | 90° wedge removed | **17 / 18** | 4.65 |

In both pairs the wedge-removed capture has the **higher** mean track length
and the **worse** registration. The mechanism is the same one as before:
concentrating cameras lengthens tracks on the surface they share, while the
frames stranded on the far side of the wedge lose their neighbours and drop
out. A capture that skips one side of the object therefore looks *better* on
the headline quality number while quietly failing to place some of its own
photographs.

That is the strongest argument in this report for gating on capture geometry
rather than on reconstruction statistics — and the geometry is free, because
the sparse reconstruction has already recovered where every camera was.

### 2.4 Taking it to the mesh — 12, 24 and 41 photographs

The sparse statistics stop short of the thing that actually gets used, so three
subsets were carried through the complete dense pipeline with identical
settings.

| | 12 frames | 24 frames | 41 frames |
|---|---|---|---|
| mesh triangles | 619,902 | 1,126,711 | **1,427,605** |
| **non-manifold edges** | **0** | **0** | **0** |
| **winding consistent** | yes | yes | yes |
| **degenerate triangles** | **0** | **0** | **0** |
| boundary loops | 5 | 3 | 5 |
| largest boundary loop | 180 edges | 513 edges | 495 edges |
| loops over 64 edges | 2 | 3 | 3 |
| connected components | 6 | 4 | 13 |
| dense stage wall clock | 420 s | 620 s | 1,133 s |

**The topological character of the output does not change with photo count, at
all.** Across a 3.4x range of frames every mesh is manifold, consistently wound
and free of degenerate triangles. Whatever else more photographs buy, they do
not buy a topologically cleaner mesh — the mesher's construction delivers that
at 12 frames just as at 41. This is the single most load-bearing observation in
part 3.

What more frames did buy is **2.3x the triangles for 2.7x the dense-stage
time** — sampling density, more or less linearly paid for.

**What did not trend, and is reported because it did not.** Debris components
went 6, then **4**, then 13; the largest boundary loop went 180, then **513**,
then 495. Neither is monotonic in frame count. The 41-frame run sweeping in
more background debris is easy to rationalise — more frames see more of the
room — but 24 frames producing *fewer* components than 12, and a *larger* hole
than 41, is not explained by anything measured here. With one subject and three
points these are as likely to be properties of which frames each subset drew as
of the count. **No trend is claimed for either.**

**What this comparison cannot tell you, and why.** The obvious next question is
"how much more of the object did 41 frames actually capture", and this spike
**cannot answer it from these meshes.** Each reconstruction carries its own
arbitrary scale (section 3.7) and each includes a different, unknown amount of
connected background surface — the 41-frame mesh's main component has a
bounding box 4.6x larger in its own units, most of it background. Normalising
area by bounding box does not fix this; it relocates the confound.

A real completeness measurement needs a scale reference in the capture and a
ground-truth model, and neither exists here. Rather than publish a
completeness-looking number that is really a ratio of two arbitrary units, this
report says what it measured — triangles, topology, debris, time — and leaves
completeness open. It is the right target for the next spike, and it needs a
capture shot to the contract, with a scale bar in frame.

### 2.5 Focus — the tolerance is far wider than the folklore, and then it is a cliff

The capture spec asserts a focus requirement, and its first draft justified it
the conventional way: soft frames register weakly and drag the bundle. That was
tested rather than assumed, and **the conventional justification is wrong.**

A fixed 8-frame subset was Gaussian-blurred at increasing radii and each set put
through a full independent pipeline — extraction, matching, mapping. Every set
including the control was re-encoded identically, so blur is the only variable.

| defocus sigma (at 4032 px) | mean keypoints/frame | verified pairs | registered | sparse points | mean track len | mean reproj |
|---|---|---|---|---|---|---|
| 0 (control) | 11,600 | 18 | **8 / 8** | 2,067 | 2.59 | 0.93 px |
| 1 px | 10,467 | 16 | **8 / 8** | 1,929 | 2.60 | 0.94 px |
| 2 px | 12,071 | 17 | **8 / 8** | 2,233 | 2.60 | 0.91 px |
| 4 px | 14,272 | 18 | **8 / 8** | 3,226 | 2.50 | 0.89 px |
| **8 px** | **4,671** | **13** | **4 / 8** | 836 | 2.17 | — |

**Two findings, and the second one is the useful one.**

**Defocus is harmless over a much wider range than anyone assumes.** Out to a
4 px blur radius on a 4032 px frame, *nothing* degraded: registration stayed at
8/8, track length moved under 4 %, and reprojection error slightly *improved*.
Keypoint counts went **up**, which is consistent with SIFT being a scale-space
detector — blurring removes fine noise that was producing unstable extrema.

**And then it does not degrade, it collapses.** At 8 px the keypoint count
falls by 60 % and the capture drops half its frames. There is no useful warning
band in between: 4 px looks perfect and 8 px is a failed capture.

**What this changes in the spec.** The focus rule stays, but its justification
is rewritten and its posture inverted. A slightly soft frame is *not* a reason
to abandon a capture — that claim has been removed. A *visibly* soft frame is
fatal and there is no partial credit. Since the operator cannot tell 4 px from
8 px on a camera back, the rule remains "sharp at 100 % zoom", now as a margin
against a cliff rather than as a defence against gradual decay.

**Two things this did not measure**, and the spec says so rather than implying
otherwise: **dense stereo** consumes fine texture in a way sparse registration
does not, and these runs stop at the sparse stage; and **motion blur is
directional** where defocus is isotropic, which is a different failure and was
not tested.

## Part 3 — Does the output fit NSO_Repair and the non-solid flag?

This part uses the repo read-only: the mesh from part 1 is pushed through the
actual `NSO_Repair.commit()` (loaded exactly as a browser would, via
`tools/nso_stl_io.js`) and through `tools/mesh_validate.py`. No repo file was
modified to make any of it run.

**Short answer: partly, and not in the way the question assumes.** NSO_Repair
is a good *second* stage for photogrammetry output and a poor *first* stage,
and the non-solid flag has no correct setting for it. The detail is below, and
section 3.9 says what would actually have to be built.

### 3.1 What the raw mesh actually is — the premise needs correcting

This spike was asked to assess "raw photogrammetry mesh output (typically
noisy, non-manifold, full of holes)". That description is the conventional one
and it is **substantially wrong for this pipeline**, which matters because the
wrong description points the work at the wrong place.

Measured on the mesh OpenMVS produced from all 41 frames:

| | measured |
|---|---|
| triangles | **1,427,605** |
| vertices (welded) | 714,210 |
| **non-manifold edges** | **0** |
| **winding consistency** | **consistent** |
| **degenerate triangles** | **0** |
| open edges | 801 |
| boundary loops | **5** — of 495, 145, 115, 43 and 3 edges |
| connected components | 13 |
| Euler characteristic | 7 |

**It is manifold, consistently wound, has no degenerate triangles, and has five
holes.** Not thousands of defects — five. This is not luck: the mesher extracts
the surface by a graph cut through a Delaunay tetrahedralization, and a cut
through a tetrahedralization is manifold *by construction*. Meshers of this
family (OpenMVS, and Meshroom/AliceVision, which uses the same approach) do not
emit the topological rubble the folklore describes.

**Scope of that claim.** It is about this mesher family — a graph cut through a
tetrahedralization, which is what OpenMVS and Meshroom/AliceVision both do. A
screened-Poisson mesher was not tested here, and this report does not claim the
result for one.

So the honest statement is: **the raw mesh's problems are geometric and
organisational, not topological.** They are its size, its debris, its arbitrary
scale, and the fact that three of its five holes are enormous.

### 3.2 Decimation is what actually creates the topology defects

A real input layer cannot hand 1.43 M triangles to an interactive app
(section 3.8), so it will decimate. Decimating this mesh to 50,000 triangles
with a standard quadric simplifier produces:

| | raw, 1.43 M tris | decimated, 50 k tris |
|---|---|---|
| non-manifold edges | **0** | **13** |
| inconsistent winding | **0** | **26** |
| pinch vertices | — | **24** |
| sliver triangles (aspect > 100) | — | 4 |
| open edges | 801 | 438 |

**The decimator introduces exactly the defect classes NSO_Repair exists to
fix.** That reframes the whole question. NSO_Repair is not being asked to clean
up after the photogrammetry; it is being asked to clean up after the
decimation — and that is a job it is genuinely good at, as the next section
measures.

### 3.3 What NSO_Repair does to it, measured

`NSO_Repair.commit()`, loaded exactly as a browser loads it, on the 50,000
triangle decimated mesh:

| | before | after | |
|---|---|---|---|
| triangles | 50,000 | 49,508 | −492 |
| **non-manifold edges** | 13 | **0** | fixed |
| **pinch vertices** | 24 | **0** | fixed |
| **inconsistent winding** | 26 | **0** | fixed |
| odd edges | 451 | 340 | |
| open edges | 438 | 340 | |
| boundary loops | 4 | **2** | 2 filled, 2 refused |
| components | 11 | 8 | debris dropped |
| piercing self-intersections | 32 | 32 | unchanged — gate satisfied |

`applied: true`, the gate passed, nothing was blocked. Stages that fired:
duplicate-faces, flap-peel, orphan-components, hole-fill (`skipped: 2`).

**This is a good result and it should be said plainly.** Every topology defect
class the module targets went to zero. What it left behind is precisely what it
is designed to refuse to guess at: the two large boundary loops, and the
self-intersections it will not risk making worse.

Running the repo's own acceptance check before and after says the same thing:

| `tools/mesh_validate.py --gate` | before | after |
|---|---|---|
| non-manifold edges | 13 | **0** |
| inconsistent winding | 26 | **0** |
| degenerate triangles | 0 | 0 |
| piercing self-intersections | 32 | 32 |
| open edges | 438 | 340 |
| **verdict** | FAIL (4 reasons) | FAIL (**2** reasons) |

The two surviving reasons are the self-intersections and the open edges — the
geometry problems, not the topology ones.

### 3.4 The non-solid flag — measured, and the result is worse than "wrong"

The same mesh, the same call, with `{nonSolid: true}`:

| | flag **off** | flag **on** |
|---|---|---|
| `applied` | **true** | **false** |
| `declined` | false | **true** |
| returned array | new | **the caller's own input, unchanged** |
| non-manifold edges | 13 → **0** | 13 → **13** |
| pinch vertices | 24 → **0** | 24 → **24** |
| inconsistent winding | 26 → **0** | 26 → **26** |
| gate | passed, nothing blocked | `pinch-separate: selfInt 32→34`, `final: oddEdges` |
| odd edges through the gate | 451 → 340 (accepted) | 451 → **474 (rejected)** |

(Non-manifold edges, pinch vertices and the gate figures are from
`commit()`'s own report; the winding figures are from
`tools/mesh_validate.py`. The flag-on column's "unchanged" values follow by
construction — `commit()` returned the caller's own array, verified by
identity, so the mesh on the other side is the input.)

**Setting the non-solid flag does not merely skip three stages. It causes the
entire repair to be discarded.**

The mechanism is worth stating exactly, because it is not obvious and it is not
a bug in either component. With the flag on, flap peel, orphan-component drop
and hole fill all stand aside — correctly, by the flag's own contract. Those
three were the stages *reducing* the odd-edge count. What is left running
includes the T-junction split, which on this mesh splits edges and **raises**
the odd-edge count from 451 to 474. The final gate sees odd edges go up, does
exactly what `docs/NSO_Repair.md` says it will do — *"the whole repair is
discarded and the input is returned"* — and hands back the caller's own array.

So the non-manifold edges, the pinch vertices and the winding errors, none of
which have anything to do with whether the piece is meant to be closed, **are
all left in place** because three closure stages were switched off. Both
components behaved exactly as documented. The interaction between them is the
problem.

**This is the concrete form of the argument that scan output is a third case.**
`docs/NON-SOLID.md` defines the flag as intent — *"there is no inside: no
volume, no hole to fill, no debris to peel"*. A photographed object has an
inside; its holes are the underside it stood on and the side the camera never
visited. Neither flag position serves it:

- **flag on** — measured above: everything is discarded, nothing is repaired.
- **flag off** — measured in 3.3: the right things happen, and the two large
  holes are correctly refused.

**Flag off is the correct setting**, and the input layer should never set the
flag on scan output. Doing so to quiet the open-edge complaint would be exactly
the drift `docs/NON-SOLID.md` section 3 is written to prevent, and it would
also silently throw away the repair.

### 3.5 The holes NSO_Repair refuses, and why it is right to

Of the raw mesh's five boundary loops, **three exceed `MAX_HOLE_EDGES = 64`**:
495, 145 and 115 edges, 755 edges between them. On the decimated mesh the
hole-fill stage reported `skipped: 2` for the same reason.

`docs/NSO_Repair.md` already gives the argument, and on this mesh it is simply
true: *"a loop that long is missing geometry, not a hole, and fanning it is a
guess."* The 495-edge loop is where the figurine met the surface it stood on,
plus the side of it that the capture's 166.8° azimuth gap never photographed.
There is no geometry there to recover. Fanning it shut would invent a flat lid
across the base of the part and report success.

**So the cap is not a limitation to raise — it is the module declining to
fabricate, correctly.** Closing that loop is a different operation from filling
a hole: it needs to know which way was down, which is information the mesh does
not carry and the capture must record. That requirement is why the capture spec
mandates a flip pass and a recorded up-vector.

Note the cap is also **not reachable through the options**: `commit()` accepts
`weldTol`, `splitEps`, `nudgeFrac`, `nonSolid`, `gate`,
`maxSelfIntersectionIncrease` and per-stage switches. `MAX_HOLE_EDGES`,
`MAX_PEEL_FRACTION`, `MAX_PEEL_ROUNDS`, `ORPHAN_MAX_TRIS` and
`ORPHAN_MAX_FRACTION` are module constants.

### 3.6 Debris — where the orphan rule genuinely does not reach

The raw mesh has 13 connected components. `dropOrphanComponents` removes open
components up to `max(4, 1 % of triangles)` = **14,276** triangles, provided a
closed component exists. Measured, component by component:

| faces | % of mesh | open edges | closed? | dropped? |
|---|---|---|---|---|
| 1,404,044 | 98.35 % | 538 | no | no — it is the part |
| **18,091** | 1.27 % | 115 | no | **NO — over the 1 % cap** |
| 4,683 | 0.33 % | 145 | no | yes |
| 346 | 0.02 % | 0 | **yes** | **NO — closed** |
| 120, 98, 78, 48, 32, 28, 16, 6 | — | 0 | **yes** | **NO — closed** |
| 15 | — | 3 | no | yes |

**Two of twelve debris components are removed.** The rule misses the rest for
two independent reasons, and the second one is the interesting one:

1. The largest debris chunk is **18,091 triangles, 1.27 %** — just over a cap
   set at 1 %.
2. **Nine of the debris components are watertight.** Dense-stereo noise
   produces small *closed* blobs — bubbles floating off the surface — and
   `dropOrphanComponents` only considers open components, because in its input
   class a closed component is a solid, not debris.

Neither is a defect in the rule. In triangle soup from a boolean or a cut, a
small closed component *is* a real piece. In scan output it is noise. The
discriminator that works here is **real-world size**, which needs the mesh to
be in millimetres — which brings us to the next section.

### 3.7 Scale — the defect with no symptom

The mesh arrives with **no physical size at all**. Its bounding box measures
193.05 "units" across all components and 61.16 across the part itself, and
nothing in the image set says what a unit is. Structure-from-motion recovers
geometry up to an arbitrary similarity transform; the scale is a free
parameter.

Every tolerance it will meet is an absolute length in millimetres:
`WELD_TOL = 1e-4`, `SPLIT_EPS = 5e-3`, `--min-wall 0.42`.

At the scale this mesh happens to have arrived, its **mean edge length is
0.0214 units** and `WELD_TOL` is 1e-4 — about **500× smaller than the mean
edge**, so the weld stage is a no-op. Had the mesh instead been normalised to a
unit bounding box, as many pipelines do, the same `WELD_TOL` would be ~0.3 % of
the part and would start merging real features.

**Nothing reports either case.** The repair returns `ok: true` both times.

The symptom shows up somewhere else entirely, and the repo's own validator
prints it without complaint:

```
verdict FAIL  [... wall/gap under 0.42 mm on 2515 face(s), thinnest 0.001 mm]
```

Those millimetre figures are **arbitrary**. They are model units relabelled as
millimetres. The check is sound; it is being fed a mesh that has no business
claiming a unit yet.

This is the cheapest problem in this report to fix and the one with the worst
failure mode, because it fails silently and plausibly. It is fixed at capture
time, with a scale reference in the scene — which is why the capture spec
requires one in every ring.

### 3.8 Cost — linear in triangles, and the raw mesh is far past the budget

`docs/NSO_Repair.md` records *"full `commit()` in 3.9 s"* on its 32,862-triangle
tape fixture. The spike machine is slower, so that fixture was re-timed here as
the calibration point and everything below is measured on the same machine.

| mesh | triangles | `commit()` |
|---|---|---|
| repo's tape fixture (calibration) | 32,862 | **5.49 s** (3.9 s in the repo's own note) |
| scan, decimated | 50,000 | 5.13 s |
| scan, decimated | 99,998 | 11.09 s |
| scan, decimated | 200,000 | 25.01 s |
| scan, decimated | 399,999 | 49.30 s |
| scan, decimated | 800,000 | 104.47 s |
| **scan, raw** | **1,427,605** | **199.21 s** |

The scaling is **essentially linear** — about **0.14 ms per triangle** across a
29x range — not the superlinear blow-up the AABB-tree discussion might lead one
to expect. The tree is doing its job, and it is worth recording that
`commit()` **did not fail, fall over or run out of memory on 1.4 M triangles**:
it returned `ok: true, applied: true` in 199 seconds. The problem is not
robustness.

Linear is still the problem, because the constant is large and this runs **on
the browser's main thread**, up to five self-intersection passes per
`commit()`, in an app whose other operations are interactive. At 0.13 ms per
triangle:

- **50,000 triangles — about 5 s.** Tolerable for an explicit, one-off repair
  the user asked for.
- **200,000 triangles — about 25 s.** Already past what an unannounced
  operation can take.
- **1.4 M triangles — 199 s measured**, with the tab unresponsive throughout.

**This is the argument for a triangle budget in the pre-stage**, and it is an
argument about the app staying usable, not about the repair being wrong. It
also sets the budget's order of magnitude: if a repair is to feel like an
operation rather than an outage, the mesh reaching `commit()` wants to be in
the tens of thousands of triangles, not the hundreds of thousands.

### 3.9 Verdict, and what would actually have to be built

**Is raw photogrammetry output a good match for the existing NSO_Repair
pipeline?** Measured answer: **yes as a second stage, no as a first stage, and
the non-solid flag must stay off.**

The ordering matters more than anything else here, and it is the opposite of
what the question implies. NSO_Repair should not run on the raw scan — it
should run **after** a pre-stage, because (3.2) the decimator is what creates
the non-manifold edges, winding errors and pinch vertices, and (3.3) fixing
exactly those is what NSO_Repair is good at. Run in that order it took every
topology defect to zero on the first attempt, with the gate satisfied and
nothing blocked.

What is missing is the pre-stage. Four jobs, in this order:

1. **Scale to millimetres**, from the capture's scale reference. Section 3.7:
   until this happens every absolute tolerance downstream is being applied at
   an arbitrary scale, silently, and the validator prints millimetre figures
   that are not millimetres.
2. **Remove debris by real-world size.** Section 3.6: the existing orphan rule
   reaches 2 of 12 components, because the biggest is over its 1 % cap and nine
   of the rest are *watertight* noise blobs, which it does not consider debris.
   A size threshold in millimetres — available once step 1 has run — catches
   all of them.
3. **Decimate to a triangle budget.** Section 3.8: the cost is linear in
   triangles and the raw mesh is far past what an interactive app can absorb.
4. **Classify the boundary loops.** Section 3.5: the small ones are holes and
   `fillHoles` already handles them correctly. The large ones are not holes —
   the 495-edge loop is the object's footprint plus the side the capture never
   saw — and capping them needs to know which way was down.

**Step 4 is the one piece of genuinely new thinking**, and its requirement
flows *backwards* into the capture: the footprint loop can only be identified
reliably if the input layer knows the capture's up-vector and, for a flipped
capture, which frames belong to which half. That is metadata which costs
nothing to record at capture time and cannot be recovered afterwards. It is
why the capture spec asks for a flip pass and a recorded orientation rather
than leaving the operator to shoot whatever they like.

Only then does NSO_Repair run, **with `nonSolid` off**, and the result of that
is measured in 3.3.

### 3.10 What should not be done

- **Do not set `nonSolid` on scan output.** Measured in 3.4: it discards the
  entire repair and returns the mesh untouched, including fixes that have
  nothing to do with closure. It is also a false statement about the part.
- **Do not raise `MAX_HOLE_EDGES`.** Section 3.5: the cap is the module
  declining to invent a lid across the base of the part, and on this mesh that
  refusal is correct. Capping a footprint is a different operation and belongs
  in the pre-stage, where the up-vector is known.
- **Do not disable the gate inside `commit()`.** It was not an obstacle here —
  it passed on the first attempt with nothing blocked. If a future scan case
  needs a non-gated path it should be a separately named entry point, so the
  guarantee `commit()` currently offers stays true.
- **Do not run NSO_Repair on the raw mesh.** Not because it would fail, but
  because it would spend its time on a mesh that is about to be thrown away by
  the decimator, and the decimator will then reintroduce the defects.

## Appendix — provenance

Reproducing anything here needs the tool versions, the image sets and the
machine; all three are recorded so a number that later looks wrong can be
chased rather than argued about.

### Machine
- 4 vCPU, 15 GB RAM, **no GPU** (`nvidia-smi` absent, no `/dev/dri`).
- Linux 6.18, Ubuntu 24.04 userspace.

### Tools
- **COLMAP 3.9.1** (Ubuntu `colmap` package). Banner reports
  `without CUDA` — so `patch_match_stereo` / `stereo_fusion` are unavailable
  and all SIFT work runs on CPU (`--SiftExtraction.use_gpu 0`,
  `--SiftMatching.use_gpu 0`).
- **OpenMVS** built from source at `/home/user/omvs` for the CPU dense stage
  (`DensifyPointCloud`, `ReconstructMesh`), because COLMAP's own dense stage
  is CUDA-only.
- Python 3.11 + numpy / trimesh / Pillow for mesh triage and image
  degradation.
- The repo's own `tools/mesh_validate.py` and `NSO_Repair.js`, loaded through
  `tools/nso_stl_io.js`, for the downstream assessment.

### Image data — real phone photographs, not renders
`https://github.com/alicevision/dataset_monstree` (AliceVision's own
reconstruction test set), directory `full/`: **41 JPEGs, 4032 x 3024**, EXIF
says **Apple iPhone 7**, f/1.8, ISO 40, 1/120 s, 28 mm equivalent. A small
figurine shot hand-held outdoors. This is exactly the "simple phone photos"
case, captured by someone who was not following this spec.

Second set, used only as a cross-check on a different subject and camera:
`https://github.com/openMVG/ImageDataset_SceauxCastle`, 11 JPEGs, 2832 x 2128.

### Experimental design — why subsets are comparable
Features and matches were computed **once** over all 41 images into a single
database (`work/monstree.db`). Every subset run then re-uses that database and
varies only which images the mapper is allowed to register
(`colmap mapper --image_list_path …`). So a difference between two subsets is
caused by image selection alone: identical keypoints, identical descriptors,
identical pairwise geometry. `--random_seed` is pinned.

Runtimes recorded during the sweep are **contended** — the OpenMVS compile was
running on the same 4 cores. They are upper bounds, and the one clean timing
is called out separately where it is quoted.

# Curved support branches — audit and design report

> **Historical.** Everything below measured the trunk-first planner, which the
> grid-pack planner (`nso_support_gridpack.js`, `docs/SUPPORT-GRIDPACK.md`)
> replaced. The boss fixture's 4 refused contacts are held there (28 of 28),
> by steering and by moving tips off walls, with no curved legs. The probe
> reads `plan.trunk` / `plan.branches` and no longer runs against `planTree`.

**Report only. No behaviour changes.** Nothing here is wired in and nothing in
the app calls it. The one addition to the repo apart from this file is a probe:

```
node tools/nso_curved_branch_probe.js     ~2.5 min, headless, NOT in npm test
```

It loads the shipped files with `vm` in `index.html`'s order (the way
`tools/nso_support_tree_test.js` does), plans trees the way G-scope's
`planFor()` does (`app-gscope-support.js:400`: default `section: 'round'`,
`branchStyle: 'square'`), and measures what a curved branch would have to get
past. Every number below comes from that probe on this branch unless it is
labelled as quoted from another doc. It writes STLs to
`tools/curved-branch-out/` (git-ignored) and runs `tools/mesh_validate.py` on
them.

The Bend tool (`nso_bend.js`, branch `claude/bend-flat`) is not pushed yet, so
nothing here measures or copies it. §2c says where a branch would call it and
what it would need from it.

---

## 0. The answer in six lines

1. **Today every branch is one straight two-point sweep, and a blocked branch is dropped.** The contact goes unsupported and the tree is still `ok`. On the new `boss` fixture that is **4 of 28 contacts**.
2. **A round branch cannot bend in one sweep.** `NSO_PathSweep` refuses a taper (`scales`) on any path with a joint. The round section is the shipped default.
3. **A one-waypoint, one-corner detour brings back all 4 boss contacts** if the curved branch keeps a constant 2 mm section. **With a tip-isolation gate added, it brings back 2.** The other two arrive leaning across a neighbour's tip. If the branch keeps the diameter law exactly (a chain of frusta), it brings back 2 of 4; a section held at the root diameter brings back 0.
4. **For a round section, the minimum bend radius is the section's own circumradius**, as `CURVING-PATH.md` F6 predicts, to 4 decimals.
5. **The search costs about 3–5 s and 75k–130k ray casts per contact on a 412-triangle piece**, because arbitrary-direction rays are brute force. A spatial index has to come before this reaches a real part.
6. **Smallest first slice:** an opt-in `detour` pass. It runs only on contacts the straight planner already refused and makes one constant-section sweep per contact. It is named in the plan like `sectionFallback`, and a tree with nothing refused stays byte-for-byte identical (§3).

---

## 1. What stops a branch from curving round an obstacle today, in code terms

### 1a. Where a branch is refused, and what happens next

`planSolid` in `nso_support_tree.js` builds every branch with
`branch(rootPoint, q, …)` (`:760`). That is a **two-point** `NSO_PathSweep`: a
round frustum at `:804`, or a square prism at `:810`. Its clearance is then
tested along that one straight line. `probeRails` (`:1112`) or `probeClear`
(`:1003`) casts the axis and every rail with `NSO_SupportAim._nearestHit`. If
anything is hit:

```js
blocked.push({ index: i, at: stop.at, why: stop.why });   // :1434
continue;
```

Nothing is retried. The contact is listed in `plan.blocked`, the tree is still
`ok: true` when at least one branch stands, and the reason string ends with
`N refused`. G-scope prints that string in the status bar (`:544`), closes the
popover (`:703`), and turns the marker **green**. The marker's test is "every
vertex that touched the region still touches it", so it says nothing about the
contacts that were never built.

Measured, `planTree` as G-scope calls it:

| fixture | contacts | held | refused | why |
|---|---|---|---|---|
| shelf / tall / tab / tiny | 16 / 28 / 9 / 1 | all | 0 | — (tree suite's own) |
| **boss** (new) | 28 | **24** | **4** | `the axis is blocked 14.854 mm along, 5.197 mm short of the end of its run`, and the same for the other three |
| **mushroom** (new) | 20 | **0** | **20** | tree refused: `not one of the 20 branches could leave it` |

`boss` is the tree suite's `tall` arm (20 × 10 mm at z 22) with a 3 × 3 mm boss
hanging 5 mm under it, off the fan's centre. `mushroom` is a 12 × 12 mm cap on
a 4 × 4 mm stem. Both have their undersides tessellated into 1 mm cells (see
the probe's `arm()`). `detectOverhangs` flags a triangle by one ray from its
centroid, so a single underside triangle half over the boss would be flagged
whole. Contacts would then land on the boss's own top.

### 1b. The trunk: one straight line from the plate, and a refusal that names this ticket

The trunk is `NSO_SupportAim.nearestBase(apex)` (`nso_support_tree.js:1232`),
then `aim()`. `nearestBase` tries one straight segment per base and, when none
is clear, refuses with
*"A support that has to bend around the piece to get there is a curving path,
which is out of scope here by name"* (`nso_support_aim.js:774`).

**Two things the audit turned up that are not curving cases**, so a later ticket
should not count them as wins:

- **The tape part (`fixtures/tape_on-edge-single-B101…stl`, 32,862 tris)**:
  - 5 of its 8 regions refuse at `stage=base`, all with "blocked 0.4–0.6 mm along, 0.08–0.33 mm short of the target".
  - The three checked (regions 2, 5, 6) are under 1 mm high (drop 0.78–0.81 mm) on the rounded bottom edge. The contacts' centroid (the apex) is inside the fillet, so no route exists to it.
  - `NSO_SupportAim.plan` (single strut, aimed at `region.point`) succeeds on all three. The fix is a fallback to the strut, not a curve.
  - Region 0 refuses at `stage=split` (wants about 6 trunks). That is the multi-trunk layout in `SUPPORT-TREE.md` §8.1, not a curve.
- **The mushroom's trunk is built inside the stem.**
  - The apex is `[6, 6, 20]`, the stem's own centre line. `nearestBase` reports "aimed from the plate, 20.000 mm away", and the trunk runs `[6,6,0] → [6,6,8.58]` wholly inside the 4 × 4 stem.
  - Its rays start inside the stem and never cross a face before the end is excluded by `RAY_EPS_MM`, so the line reads as clear.
  - Every branch then has to leave the stem through its wall, which is why all 20 are refused.
  - This is a pre-existing defect in the line test: a segment wholly inside material reads as clear. It is separate from curving. No branch-level search can rescue a trunk that starts inside the piece (the probe's detour gets 0 of 20 there: 5,740 candidates fail at the axis and 1,788 on rails, because every one starts inside the stem). That defect has to be fixed first, and the mushroom then refuses at `base` by name.
  - **Fixed (`claude/support-trunk-inside`).** `nearestBase` now runs `NSO_SupportAim.lineInsideAt` on every line `lineBlockedAt` clears: a generalised winding number at the quarter, half and three-quarter points, skipping any point on the surface. The mushroom now refuses at `base` with *"the straight line runs inside the piece"*, and so does a shelf on an off-centre solid block. `tools/nso_support_inside_test.js` (`support:inside`) pins both, and the four tree fixtures and `boss` plan exactly as before.

### 1c. The sweep itself: a round branch cannot have a joint

```
tapered 3-point sweep: ok=false - scales (a taper) is only exact on a straight
2-point path; this one has 3 points, and a mitre ring needs rails parallel to
their segment
```

`nso_path_sweep.js:460`. That refusal is correct, not an oversight:
`CURVING-PATH.md` F10 measured 6.1e-2 mm of wall non-planarity for a taper
through a mitre. But the shipped default section is `'round'`, tapered by the
law `d = 2 + 2·tan 5° × (height below tip)`. So a curved round branch has three
options, and §2c measures each:

- give up the taper and use a constant section;
- become several parts;
- wait for a primitive that keeps a section exact round an arc.

### 1d. The branch record is one straight line

Everything downstream of `branch()` reads one straight line:

- `{ from, tip, dir, lengthMm, tiltDeg }` and `axis { from, to, a0, a1 }`.
- **`hollowParts` / `innerOf`** (`:1813`) shrinks a part about that one axis. It already refuses anything else by name: *"the part is not a two-ended prism or frustum"* (`:1845`). A curved part would stay solid with `kind: 'other'`, which degrades gracefully. A true bore for a constant-section curved part is easy: the same path with the profile shrunk by `wall/cos(π/24)` and the ends pulled in by `wall`. Every wall plane of a mitred sweep moves in parallel, so the shrink is exact. It is not needed for slice one.
- **`nso_support_interface.finish(bulk, stations, …)`** centres each interface patch with `axisAt(st.from, st.to, zBase)` (`:250`). A curved branch's station has to be its **last leg** (arc end → contact), not root → contact.
- `tipPenetrationMm` and `clearWalls` only look at the tip, so they work unchanged for a curved branch.

---

## 2. What a path search needs, and what already exists to reuse

### 2a. The constraints, and where each one already lives

| constraint | rule | exists today | measured |
|---|---|---|---|
| **waypoints** | a polyline `[root, w₁…, contact]`, corners rounded by `arcSubdivide` | `NSO_PathSweep.arcSubdivide`, `sweep` | §2c |
| **overhang angle per segment** | every segment ≤ `BRANCH_TILT_DEG` 31.44° off vertical. The cone is convex, so **no chord of a rounded corner leans further than its two legs** — only the legs need testing | `tiltDeg` formula in `branch()` | worst chord = worst leg on every recovered branch (e.g. 30.93° on legs 15.0/30.9) |
| **clearance to the piece** | (i) axis and every rail of every segment clear (`probeRails` generalised from `rings[0]→rings[last]` to `rings[k]→rings[k+1]`). (ii) body distance ≥ local radius + 0.18 mm (the tree's own easy-release gap, `nso_support_interface` `gapMm`) | `_nearestHit`, `probeRails`, `_closestOnTri` | (ii) catches what (i) lets through: in the `tip` run it rejected 49 candidates whose axis and rails were clear (80 with the tip gate on) |
| **minimum bend radius** | `R·cos(t/2n) > r`, where `r` is the section's reach in the bend plane (`CURVING-PATH.md` F6) | `sweep` enforces it (F7 rail gate) | table below |
| **nozzle floor** | no section under `NSO_Thickness.floorFor(nozzle)` (0.42 at 0.4 mm) | `buildStrut` / `resolveFloor` | the floor section bends at R 0.21 mm |

**Minimum bend radius, measured by bisection on `arcSubdivide` + `sweep`** (60°
corner, 20 mm legs):

| section | circumradius | min R, 8 chords | F6 predicts | 16 chords | 1 chord |
|---|---|---|---|---|---|
| round d 2.0 (tip) | 1.0057 | **1.0080** | 1.0079 | 1.0065 | 0.5390 |
| round d 3.0 | 1.5086 | **1.5120** | 1.5118 | 1.5097 | 0.8085 |
| round d 4.1 (tiny's trunk base) | 2.0618 | **2.0663** | 2.0662 | 2.0631 | 1.1049 |
| square 1.2 (planning side) | 0.8485 | 0.6014 | 0.8503 | 0.6006 | 0.3216 |
| square 0.42 (nozzle floor) | 0.2970 | 0.2106 | 0.2976 | 0.2103 | 0.1126 |

- **Round sections:** the bound is exact. The minimum radius is the circumradius over `cos(t/2n)`.
- **Square sections:** the bound uses the circumradius, but the measured minimum is the half-side (0.6), because `sweep` seeds the frame with the square's flats in the bend plane. That is the right `r` for a square: its reach in the bend plane, which the frame decides.
- **Chord count:** one chord bends at about half the radius, because a mitre needs `r·tan(t/2)` rather than `r` (F5). That buys nothing usable: the elbow is then fatter by `1/cos(t/2)`.

So the **minimum bend radius is a property of the section at the corner**,
`circum / cos(t/2n)`. For the law's tapered round section that is the
diameter at the corner's height. On the boss branches (5.38 mm at the root) the
probe used 3 × that, R 8.11 mm, and the corner never failed (`corner 0` in
every row).

### 2b. What is reusable

**Reuse as is:**

- `NSO_SupportAim._nearestHit` for ray tests, `_closestOnTri` for body clearance, `detectOverhangs` and `contactPoints` (contacts don't change).
- `NSO_PathSweep.arcSubdivide` and `sweep`.
- `lawOf`, `roundProfile`, `probeRails` (generalised per segment).
- `unionParts`, the left fold.
- `NSO_Carve.probeTarget` (`CURVING-PATH.md` Q4), for a contact frame if a later slice wants the last leg normal to the surface.

**Missing:**

1. **A spatial index for arbitrary rays.**
   - `buildDownGrid` only serves straight-down rays. Its own comment says *"Arbitrary-direction rays are left brute force on purpose"*, because the aim casts one ray per base. A search casts **75k–130k per contact**.
   - Measured on the 412-tri boss: 3.0–5.0 s per contact.
   - The tape part is 32,862 tris, 80× more. Extrapolated, not measured: about 4–6 minutes per contact brute force.
   - A uniform 3D grid, or a BVH over the piece's soup, built once per plan, is the prerequisite for any real piece.
2. **A segment-to-soup distance.** `closestOnSoup` is brute force per point too. The same index serves it.
3. **The search itself.** Nothing in the repo searches for a path.

### 2c. The probe's search, and what each section choice gets

**The search.** One waypoint, one rounded corner. Candidates are
`w = root + s·(q−root) + a·lateral + b·ẑ`, with `s ∈ {0.3…0.7}`,
`a ∈ [−8, 8]` at 0.25 mm and `b ∈ {−3…2}`. They are sorted by length and run
through the gates cheapest-first: tilt, axis rays, corner, sweep, rails, body.
The first survivor is the shortest legal path.

Recovered of the 4 contacts the straight `boss` plan refuses:

| curved branch's section | recovered | parts / branch | what it costs |
|---|---|---|---|
| `root`: constant at the law's root diameter (5.38 mm) | **0 of 4** | 1 | the 5.38 mm section does not fit past the boss: 1,934 candidates fail on rails |
| `tip`: constant at the 2 mm tip | **4 of 4** | 1 (528 tris) | under the law down the shaft: 2 mm against 5.38 mm at the root, **13.8 % of the law's area** there. No tip-isolation gate (two of these tips fuse, §4c) |
| `hybrid`: law-tapered legs, arc constant at the law at its start (the Bend shape) | **0 of 4** | 3 | the arc keeps its start diameter past the boss: 1,911 candidates fail on rails, 23 on body clearance |
| `chain`: every straight piece its own 2-point frustum, the law exact | **2 of 4** | 10 (960 tris) | 10 union steps per branch, and a default-weld failure after the union (§4b) |
| `tip` **+ tip-isolation gate** (§4c) — slice one as proposed | **2 of 4** (21, 22) | 1 | 20 candidates rejected by the gate, and 18 and 27 refused outright: every path the search found for them arrives across a neighbour's tip |

The `tip` variant's paths, verbatim from the probe:

| contact | length vs straight | legs (off vertical) | turn at R 8.11 | body clearance | candidates / rays / time |
|---|---|---|---|---|---|
| 18 | 21.87 vs 20.05 (+9.1 %) | 26.5° / 30.3° | 47.8° | 0.20 mm | 826 / 77,788 / 3.1–3.8 s |
| 21 | 20.97 vs 20.30 (+3.3 %) | 23.8° / 21.9° | 29.7° | 0.20 mm | 552 / 78,764 / 3.6–3.7 s |
| 22 | 21.30 vs 20.79 (+2.4 %) | 28.9° / 19.3° | 25.3° | 0.20 mm | 435 / 75,084 / 3.0–3.7 s |
| 27 | 20.71 vs 19.48 (+6.3 %) | 15.0° / 30.9° | 42.7° | 0.28 mm | 771 / 99,524 / 4.2–4.7 s |

**One curved branch on its own** (`mesh_validate.py`, default weld): 528 tris,
0 open, 0 non-manifold, 0 inconsistent winding, 0 degenerate, 0 slivers,
0 piercing, Euler 2. Volume 67.37 mm³, equal to profile area × rounded
centreline length (67.37), so `CURVING-PATH.md` F3 holds on a real branch.

**What the table says.** Near an obstacle, the cross-section decides as
much as the route does, and the diameter law is what costs the route. That
puts the section choice at the centre of slice one.

There is already a precedent for that choice:

- A round part that would hit the piece falls back to the **constant 1.2 mm square** and is named in `plan.sectionFallback` (`SUPPORT-TREE.md` §6b).
- A constant 2 mm round section is fatter than that fallback (3.14 against 1.44 mm²), so `tip` stays inside a choice the tree already makes.
- **Section:** a curved branch is a **constant-section** sweep, named in the plan.
- **Diameter:** the probe used the tip's 2 mm. Picking the largest diameter that clears is a cheap refinement: bisect `d` between 2 mm and the root diameter, on the path the search found.

**How a branch would use Bend.** The `hybrid` row is the shape Bend would give:
straight tapered legs (`NSO_PathSweep` frusta, exact) joined by an arc of
constant section (Bend, section exact).

- **Slice one does not need it.** On `boss`, the hybrid shape held nothing (0 of 4), so Bend is a quality step for open space, not a requirement here.
- **Two things a branch needs from Bend:**
  1. its end rings exactly perpendicular to the arc's tangent;
  2. the incoming frame (or the ring itself) as input, so the arc's first ring is the frustum's last ring vertex for vertex.
- **Why that matters:** then leg + arc + leg stitch into **one shell with no boolean**. The two caps are dropped and the rings are shared, the same "one ring, reached from both sides" argument as `CURVING-PATH.md` §2.
- **The PathSweep emulation can't do this.** Its arc's first chord is not parallel to the leg, so its ring at the tangent point is a mitre, not a section. Only the single-sweep construction closes that joint.
- **Without the shared ring,** the three pieces need two union steps, overlapping where they meet at nearly the same diameter. That is the coincident-walls case `COLLINEAR_DEG` exists to avoid (`SUPPORT-TREE.md` §4 measured 2 degenerate triangles and 2 non-manifold edges from it).
- **This is a question for the Bend branch**, not something to assume. The diameter over the arc would then be above the law by at most `2·tan 5° × Δz_arc` (0.175 mm per mm of rise across the arc).

---

## 3. The smallest first slice

**One pure function and one opt-in pass. Nothing about straight trees changes.**

```js
// nso_support_tree.js (or nso_support_route.js beside it)
detour(rootPoint, contact, obstacles, opts)
  -> { ok, points, sweep, soup, turnDeg, radiusMm, lengthMm, legTiltDeg:[a,b],
       clearanceMm, sectionMm, tried, raysCast, reason }
```

- **One waypoint, one rounded corner.** No graph search and no multi-waypoint. On `boss` it reaches every refused contact. With tip isolation enforced it keeps 2 of the 4 (§4c).
- **The gates, cheapest first**, each with its own named refusal, as the probe runs them:
  1. tilt per leg (≤ 31.44°);
  2. axis rays;
  3. `arcSubdivide` at R = k × section circumradius;
  4. `sweep`;
  5. rails per segment (the last cross-section left out, as today);
  6. body clearance ≥ 0.18 mm;
  7. **tip isolation**: the last 3 mm stays ≥ (tip diameter + gap) from every neighbour's last 3 mm (§4c).
- **Section:** constant round at the tip diameter; the largest that clears is a later refinement. Named in `plan.curved[]` the way `sectionFallback` is.
- **Called only from the `blocked` branch of `planSolid`**, behind `opts.curveBranches` (default `false`). Curved parts go into `parts` **after every straight shaft and before the fingers**, so the default union is a byte-for-byte prefix. This is the same reason gecko fingers go last (`SUPPORT-TREE.md` §5): in one tested fold order the boolean rounded differently and 2 piercing pairs appeared at the branch roots.
- **No section change, no hollowing, no interface for curved parts in slice one.**
  - `innerOf` already leaves a curved part solid with `kind: 'other'`.
  - `finish()` gets the last leg as its station.
- **Prerequisite, landed first:** the 3D ray index (§2b), with equality against brute force pinned the way `buildDownGrid` is pinned (*"same answer, ray for ray"*).
- **Separate, before or alongside:** the inside-material line-test defect (§1b).

### Fixtures and gates

| fixture | expectation |
|---|---|
| shelf, tall, tab, tiny (existing) | `curveBranches: true` is **byte-identical** to `false`: nothing is blocked, so `detour` never runs. Asserted the way `tree:test` 7b compares gecko to square |
| `tree:test` §4's 0.8 mm window plate | today refused by rail; recovered round the 3 mm plate |
| **boss** (new, from the probe) | 4 refused today → **2 held (contacts 21, 22), 2 refused by name** (18, 27: tip isolation). Per held branch: legs ≤ 31.44°, R ≥ circum/cos(t/2n), rails and body clear ≥ 0.18 mm, one part, `mesh_validate.py` clean at the default weld, volume = area × rounded centreline. The union passes `tree:canonical`'s derived-weld gate. Without the gate the same search holds all 4, and contact 27's tip lands 0.92 mm from contact 17's (§4c), which is the case the gate exists for |
| **rib** (new): a wall-to-wall rib under the arm | still refused, with stage counts in the reason, because one waypoint cannot cross a full-width rib. The negative control |
| **mushroom** (new) | after the line-test fix: refused at `base` by name, never "held" |
| tape region 1 (real part) | unchanged (nothing blocked), and the timing with the index in place is recorded |

---

## 4. Risks

### 4a. Self-intersection

- **One curved branch alone:** 0 piercing and 0 coplanar pairs.
- **Local:** a single rounded corner of turn < 180° is a planar convex path. The only way it can cross itself is the inside of the bend overrunning its segment, and that is exactly what `sweep`'s F7 rail gate refuses.
- **Global:** multi-waypoint paths bring back `CURVING-PATH.md` Q3, a path that loops through itself. That needs a run-time check from the existing tools (`mesh_validate.py`'s self-intersection pass, or `NSO_Repair.countSelfIntersections` in the browser) before slice two.
- **Between parts:** curved branches do pass close to their neighbours (§4c). The union turns that into fused material rather than an intersection, so the risk there is merging, not self-intersection.

### 4b. The union cost

| | parts | input tris | union tris | union time | default weld | 1e-6 weld |
|---|---|---|---|---|---|---|
| boss today (24 branches) | 25 | 2,080 | 7,656 | 1.13–1.58 s (47–60 ms/step) | clean, Euler 2 | clean |
| + 4 curved, `tip` | 29 | 4,192 | 10,376 | 1.55–1.87 s (55–67 ms/step) | **clean, Euler 2** | clean |
| + 2 curved, `chain` | 45 | 4,000 | 11,600 | 3.06–3.55 s (70–81 ms/step) | **3 open, 31 non-manifold, 71 wind, Euler 18** | clean, Euler 2 |

- **Times:** each range is across the probe runs on this branch. The kernel time varies run to run.
- **`tip`:** a constant-section curved branch is one more union step at roughly the per-step cost already paid.
- **`chain`:** 10 steps per curved branch, and it is the variant that brings back `SUPPORT-TREE.md` §6's problem. The boolean leaves vertices closer together than the default weld, so it fails at 1e-4 and passes at 1e-6. `tree:canonical` handles that class by deriving the weld from the closest vertex pair. Whether the chain's output passes that derived gate was not run here.
- **Slivers** (aspect > 100) grow with each variant: 3,810 today, 5,273 `tip`, 5,681 `chain`. They are not a gate today, and the curved parts add them.
- **On a real piece the union is not the bottleneck: the search is** (§2b).

### 4c. Branch tips must stay isolated point contacts

`docs/SUPPORT-TREE.md` §1 reads the structure out of
`fixtures/3mf/tabletop.gcode.3mf` on every `tree:reference` run: 36 trunks fan
to **451 separate islands**, and those carry one continuous interface. A
curved branch that fuses its tip to a neighbour's turns two point contacts
into one patch. That is the opposite of what the reference does.

Measured, with the last 3 mm of each axis against every other's:

| | closest pair (axis to axis) | at a 2 mm tip |
|---|---|---|
| today's straight boss tips | 2.70 mm | apart |
| `tip` contacts 18 / 21 / 22 | 2.03 / 2.09 / 2.20 mm | apart, but with 0.02–0.2 mm of air |
| `tip` contact 27 | **0.92 mm** | **fused** with contact 17 |
| `chain` contact 21 | **1.68 mm** | **fused** with contact 20 |

The cause is that a detour arrives at its contact leaning up to 30.9°, from the
side it went round. Its last leg cuts across the neighbouring tips. Straight
branches all lean away from one collar and never cross.

The tip overshoot follows the lean too: 0.33–0.52 mm against 0.06–0.48 mm for
today's straight tips (the same `(d/2)·sin(tilt)` bracket).

**This is why slice one carries a tip-isolation gate.** The gate requires the
last 3 mm axes to stay ≥ 2 mm + 0.18 mm apart, so today's straight tips
(2.70 mm) pass it. Measured with the gate on, the contacts are searched in
order, each against the straight tips and the curved ones already accepted:

- **Recovered: 2 of 4** (contacts 21 and 22). Contact 21 takes a different path: 21.00 mm, legs 25.8°/19.6°.
- **Refused: 18 and 27.** No one-waypoint path for them keeps its tip clear.

The obvious lever for those two is a vertical last leg. It would drive both
the fusing and the overshoot toward zero, at the cost of a second waypoint.
It is not measured here, and it is the first thing slice two should measure.

### 4d. Paint scope

The tree's own label is **inherited, not re-decided**:

- **Detection:** sub-region, through `skipList`.
- **Generation:** none. It adds a piece and writes nothing to the host.

A detour changes neither. Its contacts are the same contacts, all on triangles
detection already cleared of paint. Its path reads the host soup only as an
obstacle, painted faces included, and it must: a painted face is still
material.

G-scope's refusal for a piece that is painted *and* turned
(`skipListFor`) runs upstream of all of this and is unchanged. **No new row in
the HANDOFF roster.**

### 4e. Smaller ones

- **The marker goes green on a partial tree today** (§1a). Slice one should at least put the refused count in the popover's read-out rather than only in the status bar.
- **The search is greedy per contact:** the shortest legal path for one contact can block a neighbour's. Contacts are independent today, and slice one keeps them so, with the isolation gate catching collisions. A joint search is a later problem.
- **Thin margins:** the shortest legal path hugs the gate. Every recovered branch cleared by 0.20–0.28 mm against the 0.18 mm gate. That is correct for a gate, and it means the margin is the number that decides printability. It should be a named option, like `wallClearanceMm`.

---

## 5. What the user would see in G-scope's panel

They click the red ping on the boss overhang, and the popover opens as it does
today: the title "Overhang 1 on boss", the area and drop line, Style = Tree,
Size 1.2. New, under Style, is one checkbox, **"Route branches round the
piece"**, ticked. They press Generate. The popover's read-out (`ms-sp-read`)
now says *"26 of 28 contacts held — 2 branches bend round the piece (up to
29.8° turn, longest +3.4 %), 2 refused: no clear path that keeps its tip
apart"*. With the box unticked it would say *"24 of 28 held — 4 refused:
blocked by the piece"*. Today that only flashes in the status bar. In the
viewport the new support piece stands under the arm. Twenty-four straight
round branches fan out from one collar, and two thinner, constant-width
branches swing out past the hanging boss in a single smooth elbow each, then
rise to their contacts. The marker turns green only when
every contact is held. A contact that is still refused keeps a small red dot
on the region, so a partial tree no longer looks finished.

---

## Paint scope: NOT APPLICABLE (report and probe only)

This change ships a document and a headless probe under `tools/`, not wired
into `npm test`. Neither reads, writes or touches a placed model. See §4d for
the feature this report proposes.

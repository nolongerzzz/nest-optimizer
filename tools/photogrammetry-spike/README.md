# Photogrammetry spike — research tools

**Not wired into anything.** No app file loads these, `index.html` does not
reference them, and no CI job runs them. They exist so the numbers in
`docs/PHOTOGRAMMETRY-FEASIBILITY.md` can be reproduced and challenged, in the
same spirit as `docs/NSO_Repair.md`'s regression suite: the measurements are
the contract, and a measurement nobody can re-run is an assertion.

They were executed outside the repo entirely, in a scratch workspace, against
image sets that are not vendored here (they are a few hundred megabytes of
someone else's photographs). Paths at the top of each script point at that
workspace.

| script | what it does |
|---|---|
| `poses.py` | reads a COLMAP sparse model, recovers each camera's azimuth / elevation / distance about the reconstructed object centre, and reports the angular step distribution |
| `gen_subsets.py` | builds the sweep's image subsets from those azimuths: even angular spacing for the count sweep, contiguous wedges for the arc and gap sweeps |
| `sweep.py` | runs `colmap mapper` per subset against one shared feature/match database and tabulates registration, track length and reprojection error |
| `mesh_stats.py` | photogrammetry-mesh triage — boundary-loop sizes in particular, since `NSO_Repair.fillHoles` refuses any loop over 64 edges |
| `repair_probe.js` | pushes a mesh through the repo's real `NSO_Repair.commit()`, once plain and once with `{nonSolid:true}`, and dumps both reports |
| `perf_probe.js` | times `commit()` against triangle count on one machine, so the repo's own 32,862-triangle fixture is the calibration point |
| `ply2stl.py` | dense-mesh PLY to binary STL, with an optional uniform scale |
| `make_blur.py` | Gaussian-defocus copies of an image subset, for the focus-requirement measurement |

## Reproducing

Needs COLMAP (CPU is fine for the sparse work) and, for the dense stage,
OpenMVS — COLMAP's own dense stage is CUDA-only and the spike machine had no
GPU. `docs/PHOTOGRAMMETRY-FEASIBILITY.md` records the exact versions, the
image sets and their sources.

## `results/` — the raw output the report quotes

Every number in `docs/PHOTOGRAMMETRY-FEASIBILITY.md` comes from one of these,
so a figure that later looks wrong can be chased to its source rather than
argued about.

| file | what it holds |
|---|---|
| `poses_full41.json` | recovered camera centres, azimuth / elevation / distance for all 41 frames |
| `subsets.json` | the exact image list for each of the 24 sweep subsets |
| `subset_geometry.json` | per-subset azimuth span, largest camera gap and median step |
| `sweep_results_pass1.json` | the full 24-subset sweep |
| `sweep_results_repeats.json` | the 15 count subsets re-run on 3 seeds (45 runs) |
| `probe_50k.json` | `NSO_Repair.commit()`'s own report, both with and without `nonSolid` |
| `stats_raw.json`, `stats_count24.json`, `stats_count12.json` | mesh triage for the 41-, 24- and 12-frame meshes |
| `perf_curve.jsonl` | `commit()` wall clock against triangle count |
| `blur_sweep.txt` | the defocus sweep |
| `sceaux.txt` | the second-dataset cross-check |

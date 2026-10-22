## CI shard timeout - 15 -> 25 min, weights re-measured on the runners (2026-09-27)
Branch `claude/ci-timeout-weights`, off `claude-wip`.

- **The failure:** Tests #231 and #233 were each red with every check passing.
  Shard 6 was cancelled by `timeout-minutes: 15`. Both times the base's own
  content failed the same way, and #232 passed at 14.9 min.
- **Why:** `testStepWeights` were local-box times. On the runners the suite is
  ~3,860s against the table's 2,280s (1.7x), and per step it was far worse:
  cornercam 12 -> 68s, gscope-support 20 -> 104s. Ten steps were missing from
  the table and packed as median. Under real times the old packing put shards
  5 and 6 at ~800s, 14.2-14.7 min with setup.
- **Fix:**
  - weights = mean of two green CI runs (#232, #233), read from each shard's
    SUMMARY table; method in `testStepWeightsNote`;
  - every shard now packs at 652s (~11.5 min);
  - `timeout-minutes` 25 (~2.2x);
  - `run-tests-parallel.mjs` no longer divides CI-runner seconds by a local
    wall clock (it would have claimed ~8x).
- **Next time a shard nears the limit:** re-measure, don't raise it again.

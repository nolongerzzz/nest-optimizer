#!/bin/sh
# Every CTH check. No browser, no network. Run from the repo root.
set -e
fail=0
for t in tools/cth-test/*.test.mjs; do
  echo "=== $t"
  node "$t" | tail -1
  node "$t" >/dev/null 2>&1 || fail=1
done
echo "=== module load: cth/*.js"
for f in cth/*.js; do
  node -e "import('./$f')" || { echo "  FAIL $f"; fail=1; }
done
# app-cth.js is the browser entry point (top-level document), syntax-only here
node --input-type=module --check < app-cth.js || fail=1
echo "=== app-cth.js syntax ok"
[ "$fail" = 0 ] && echo "ALL GREEN" || { echo "FAILURES"; exit 1; }

#!/bin/sh
# test/smoke.sh - launch the real desktop app against the mock printer and check it end to end.
# Needs a display: on a headless Linux box run it under xvfb-run. Screenshots land in $OUT.
set -e
cd "$(dirname "$0")/.."
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
FLAGS=""
[ "$(id -u)" = "0" ] && FLAGS="--no-sandbox"
RUN="./node_modules/.bin/electron . $FLAGS --disable-gpu"
if [ -z "$DISPLAY" ] && command -v xvfb-run >/dev/null 2>&1; then RUN="xvfb-run -a -s '-screen 0 1600x1000x24' $RUN"; fi
NSO_DESKTOP_SMOKE="$OUT" sh -c "$RUN" >"$OUT/electron.log" 2>&1 || true
cat "$OUT/result.json"
node -e "const r=require('$OUT/result.json'); console.log('smoke: '+r.pass+' passed, '+r.fail.length+' failed'); process.exit(r.fail.length?1:0)"

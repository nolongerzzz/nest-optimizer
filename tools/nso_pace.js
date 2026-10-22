/* How fast this box is running right now, for the checks that time something.

   A check that says "under 5 s" measures the runner as much as the code. The
   same suite on GitHub's runners swings ~1.6x between machines (Tests
   #297-#305: one shard in five ran at 0.6 of the others' time), more on a
   shard that shares its cores, and a gate on the clock reads that swing as a
   regression: about half of the dozen red shards of 2026-10-19 to 10-22 were
   such gates, on steps nothing had changed. So a time is gated against this box's speed at that
   moment instead - the ratio of the work to a fixed amount of plain JS run
   right before and right after it, on the same machine, in the same process
   (or the same page). A box starved by another suite slows both, and the
   ratio holds where the seconds did not. The seconds are still printed, as a
   FINDING, so a real slowdown shows in the log even while the gate passes.

   This is ci-timing-gates' (#262) calibration loop, shared: triangle normals
   from a typed array binned into a Map grid, the kind of work the geometry
   checks time. ONE LOOP is its 40 passes over 200,000 triangles - #262's unit,
   so "8 loops" in support:test and a gate here mean the same thing. One
   untimed pass first, so the timed ones run warm, as the timed work does.

     time(fn)            Node: calibrate, run fn, calibrate again ->
                         { value, ms, cal, loops }, cal the mean of the two
                         loops, loops = ms / cal (timeAsync for an async fn)
     inPage(page)        one loop in the page's main thread -> ms; for work
                         the page does (a build, a drag), which is where the
                         calibration has to run
     timeInPage(page, fn)   the same as time(), calibrated in the page, for
                         work driven from here (a click and a wait)
     calibrate()         one loop here -> ms
     finding(label, r)   the line that logs r's clock time and its loops

   A gate reads   check('... under ' + MAX + ' loops', r.loops < MAX, ...)
   with MAX set from the old budget: the same headroom over what the box
   measures, in its own units, so the gate means what it meant before on the
   box it was set on and the same thing on any other. */
'use strict';

const N = 200000, PASSES = 40;

/* Self-contained, so it can be sent to a page as source: no closures. */
function loop(n, passes) {
  const v = new Float64Array(n * 9);
  let s = 12345, acc = 0;
  for (let i = 0; i < v.length; i++) { s = (s * 1103515245 + 12345) >>> 0; v[i] = s / 4294967296 * 100; }
  const pass = (p) => {
    const grid = new Map();
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ax = v[o + 3] - v[o], ay = v[o + 4] - v[o + 1], az = v[o + 5] - v[o + 2];
      const bx = v[o + 6] - v[o], by = v[o + 7] - v[o + 1], bz = v[o + 8] - v[o + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const k = (Math.floor(v[o] / 2) + p) * 4096 + Math.floor(v[o + 1] / 2);
      grid.set(k, (grid.get(k) || 0) + nz / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1));
    }
    for (const x of grid.values()) acc += x;
  };
  pass(-1);
  const t0 = performance.now();
  for (let p = 0; p < passes; p++) pass(p);
  const ms = performance.now() - t0;
  if (!isFinite(acc)) throw new Error('calibration loop: ' + acc);    // used, so it is not optimised away
  return ms;
}

function calibrate() { return loop(N, PASSES); }

function inPage(page) { return page.evaluate(`(${loop.toString()})(${N}, ${PASSES})`); }

function result(value, ms, c0, c1) {
  const cal = (c0 + c1) / 2;
  return { value, ms, cal, loops: ms / cal };
}

function time(fn) {
  const c0 = calibrate();
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  return result(value, ms, c0, calibrate());
}

async function timeAsync(fn) {
  const c0 = calibrate();
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return result(value, ms, c0, calibrate());
}

async function timeInPage(page, fn) {
  const c0 = await inPage(page);
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return result(value, ms, c0, await inPage(page));
}

const finding = (label, r) => `  FINDING ${label}: ${Math.round(r.ms)} ms on the clock, ` +
  `${r.loops.toFixed(2)} calibration loops (one loop ${Math.round(r.cal)} ms here)`;

module.exports = { calibrate, inPage, time, timeAsync, timeInPage, finding, loop, N, PASSES };

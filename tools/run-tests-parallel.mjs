#!/usr/bin/env node
/**
 * nest-optimizer / tools / run-tests-parallel.mjs
 *
 * The same suite, the same shards, run side by side instead of end to end.
 *
 * WHY THIS EXISTS
 * The CI split took GitHub's wall clock from 24 minutes to under 5 by running
 * six shards on six runners. The local check before a push got none of that:
 * it was still one sequential chain, and at 106 suites that is ~11 minutes of
 * waiting before every single merge. This runs the shards as concurrent child
 * processes on one box, which is the same win without six machines.
 *
 * IT OWNS NO TEST LOGIC
 * Each child is `run-tests.mjs --shard=i/n`, unchanged - the runner that CI
 * uses and that has been proven sequentially. The partition is not computed
 * here and not passed in: every child derives it from package.json on its own,
 * deterministically, which is the same property that lets six CI runners agree
 * without talking to each other. So there is no second copy of the packing to
 * drift from the first, and this file cannot silently test a different set
 * than CI does.
 *
 * CONCURRENCY IS NOT THE SHARD COUNT, AND MORE IS NOT BETTER
 * Six shards do not want six workers. --jobs sets how many run at once; the
 * rest queue. Measured on this box (4 cores, 106 steps, 672.5s of work):
 *
 *     sequential   673s   1.00x
 *     --jobs=2     487s   1.38x
 *     --jobs=4     415s   1.62x   <- peak, and the default
 *     --jobs=6     476s   1.41x
 *
 * The curve peaks AT the core count and falls off both sides, so the default
 * is cpus().length. Going wider is not merely flat, it is worse: at jobs=6 the
 * shards thrash and give back a fifth of the win.
 *
 * WHY 1.6x AND NOT THE 5x CI GOT
 * CI's six shards run on six MACHINES. Here they share four cores, and the
 * suite was already using most of them: the browser suites drive Chromium with
 * --use-gl=swiftshader, and software rendering is itself multi-threaded, so a
 * single shard pulls ~2.4 cores (load 4.8 at jobs=2) and four pull ~12 (load
 * 12.5 at jobs=4). The sequential baseline was therefore ALREADY spending
 * about three of the four cores. What is left to parallelise into is roughly
 * one core plus the gaps the pure-Node steps leave, which is what 1.6x is.
 *
 * So the lever for a bigger local win is not more shards or more workers - it
 * is Chromium's own thread appetite. Capping renderer threads per instance in
 * nso_app_harness.js would free real cores; that touches every browser suite
 * and belongs in its own change, not smuggled in here.
 *
 * THE HEARTBEAT, AND WHY
 * A backgrounded run on this box has died silently more than once when the
 * container idled: the log simply stops growing, and a stalled log reads
 * exactly like a slow one. Nothing in the output distinguishes them. So the
 * coordinator writes a status file every couple of seconds with its pid and
 * the step count so far, and `--status` reports whether that file is still
 * being written AND whether the pid is still alive. A dead run is then a
 * question anyone can answer in a second, rather than something you have to
 * know to go and check with pgrep.
 *
 * Usage:
 *   node tools/run-tests-parallel.mjs                 # 6 shards, jobs = cores
 *   node tools/run-tests-parallel.mjs --shards=6 --jobs=4
 *   node tools/run-tests-parallel.mjs --status        # is a run alive?
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpus } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared = Array.isArray(pkg.testSteps) ? pkg.testSteps : [];

const RUNDIR = join(ROOT, '.test-run');
const STATUS = join(RUNDIR, 'status.json');

const numArg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return dflt;
  const v = Number(a.split('=')[1]);
  if (!Number.isInteger(v) || v < 1) {
    console.error(`run-tests-parallel: --${name} must be a positive integer`);
    process.exit(2);
  }
  return v;
};

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/* ---- --status: is a run alive, or did the box take it? ---- */
function reportStatus() {
  if (!existsSync(STATUS)) {
    console.log('no run recorded (no .test-run/status.json)');
    return 0;
  }
  const s = JSON.parse(readFileSync(STATUS, 'utf8'));
  const age = Date.now() - s.updatedAt;
  let alive = false;
  try { process.kill(s.pid, 0); alive = true; } catch { alive = false; }

  const when = new Date(s.updatedAt).toISOString();
  if (s.finished) {
    console.log(`finished: ${s.passed}/${s.total} steps, ${s.failedShards} shard(s) failed, ` +
      `${fmt(s.wallMs)} wall, ended ${when}`);
    return 0;
  }
  /* Two ways to be not-finished, and they are not the same thing. A live pid
     with a fresh beat is a run in progress; anything else is a run that died
     without saying so, which is the case the log alone cannot show. */
  if (alive && age < 30000) {
    console.log(`RUNNING: pid ${s.pid}, ${s.done}/${s.total} steps, last beat ${fmt(age)} ago`);
    return 0;
  }
  console.log(`DEAD: pid ${s.pid} ${alive ? 'alive but silent' : 'is gone'}, ` +
    `last beat ${fmt(age)} ago (${when}), ${s.done}/${s.total} steps done`);
  console.log('  the run did not finish - re-run it; the log will just stop mid-suite');
  return 1;
}

if (process.argv.includes('--status')) process.exit(reportStatus());

/* ---- the run ---- */
const shards = numArg('shards', 6);
const jobs = Math.min(numArg('jobs', Math.max(1, cpus().length)), shards);

if (!declared.length) {
  console.error('run-tests-parallel: package.json "testSteps" is empty - nothing to run');
  process.exit(2);
}

mkdirSync(RUNDIR, { recursive: true });

const started = Date.now();
const state = Array.from({ length: shards }, (_, i) => ({
  n: i + 1, done: 0, total: null, code: null, ms: 0, out: '', started: 0
}));

const doneSteps = () => state.reduce((n, s) => n + s.done, 0);

function beat(extra = {}) {
  writeFileSync(STATUS, JSON.stringify({
    pid: process.pid,
    startedAt: started,
    updatedAt: Date.now(),
    shards, jobs,
    total: declared.length,
    done: doneSteps(),
    finished: false,
    ...extra
  }, null, 2));
}

function runShard(s) {
  return new Promise((resolve) => {
    s.started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'tools', 'run-tests.mjs'), `--shard=${s.n}/${shards}`],
      { cwd: ROOT });
    const take = (chunk) => {
      const text = chunk.toString();
      s.out += text;
      /* the child prints "[k/m] name  PASS  exit=0  1.2s" per step */
      for (const m of text.matchAll(/^\[(\d+)\/(\d+)\]\s+\S+\s+(PASS|FAIL)\b/gm)) {
        s.done = Number(m[1]);
        s.total = Number(m[2]);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => {
      s.out += `\n[parallel] shard ${s.n} could not start: ${err.message}\n`;
      s.code = -1; s.ms = Date.now() - s.started; resolve(s);
    });
    child.on('close', (code) => {
      s.code = code === null ? -1 : code;
      s.ms = Date.now() - s.started;
      const tag = s.code === 0 ? 'PASS' : 'FAIL';
      console.log(`  shard ${s.n}/${shards}  ${tag}  ${s.done}${s.total ? '/' + s.total : ''} steps  ${fmt(s.ms)}`);
      resolve(s);
    });
  });
}

async function main() {
  console.log(`local suite: ${declared.length} steps in ${shards} shards, ${jobs} at a time ` +
    `(${cpus().length} cores)\n`);
  beat();
  const ticker = setInterval(beat, 2000);
  ticker.unref?.();

  /* A worker pool rather than one batch: with jobs < shards the leftovers
     start as soon as a slot frees, so the long shard is never waiting behind
     a queue that has already emptied elsewhere. */
  const queue = state.slice();
  const workers = Array.from({ length: jobs }, async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      await runShard(s);
    }
  });
  await Promise.all(workers);
  clearInterval(ticker);

  const wallMs = Date.now() - started;
  const failed = state.filter((s) => s.code !== 0);
  const ran = doneSteps();

  console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
  state.forEach((s) => console.log(`  shard ${s.n}/${shards}  ${s.code === 0 ? 'PASS' : 'FAIL'}` +
    `  ${s.done} steps  exit=${s.code}  ${fmt(s.ms)}`));
  /* The honest baseline is what the suite costs run end to end, which is the
     sum of the per-step weights - NOT the sum of the shards' wall times. Those
     are inflated by the very contention being measured: at jobs=6 on four
     cores each shard reported ~470s for ~112s of its own work, so dividing by
     them claimed 5.8x when the real figure against a sequential run was 1.4x.
     A speedup number that goes UP as contention gets worse is worse than no
     number at all.
     And since 2026-09-27 the weights are measured on GitHub's CI runners
     (package.json "testStepWeightsNote"), ~1.7x slower than a local box, so
     their sum is not this machine's sequential time either: dividing it by a
     local wall clock would claim ~8x. The sum is printed for what it is, and
     no ratio is drawn from it. */
  const weights = pkg.testStepWeights || {};
  const baselineMs = declared.reduce((n, k) => n + (Number(weights[k]) || 0), 0);
  console.log(`\n  ${ran}/${declared.length} steps  |  wall ${fmt(wallMs)}` +
    (baselineMs ? `  |  same steps on GitHub's runners, sequential: ${fmt(baselineMs)} (not comparable - no speedup drawn)` : ''));

  /* Same assertion the sequential runner makes, for the same reason: a shard
     that quietly ran fewer steps than the suite declares is the failure this
     whole arrangement exists to make impossible to miss. */
  const miscount = ran !== declared.length;
  if (miscount) console.log(`\n  RUNNER BUG: ${declared.length} steps declared but ${ran} ran across the shards`);

  if (failed.length) {
    console.log(`\n${'='.repeat(70)}\nFAILED SHARDS (${failed.length} of ${shards})\n${'='.repeat(70)}`);
    failed.forEach((s) => {
      const lines = s.out.replace(/\s+$/, '').split('\n');
      const tail = lines.slice(-40);
      console.log(`\n--- shard ${s.n}/${shards} (exit ${s.code}) ---`);
      if (lines.length > tail.length) console.log(`  ... ${lines.length - tail.length} earlier line(s) above`);
      tail.forEach((l) => console.log('  ' + l));
    });
  }

  const passed = ran - failed.reduce((n, s) => n + 0, 0);
  writeFileSync(STATUS, JSON.stringify({
    pid: process.pid, startedAt: started, updatedAt: Date.now(),
    shards, jobs, total: declared.length, done: ran, passed,
    finished: true, failedShards: failed.length, wallMs
  }, null, 2));

  console.log(failed.length || miscount
    ? `\n${failed.length} shard(s) failed\n`
    : `\nall ${shards} shards passed, ${ran}/${declared.length} steps\n`);
  process.exit(failed.length || miscount ? 1 : 0);
}

main();

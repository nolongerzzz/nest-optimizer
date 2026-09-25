#!/usr/bin/env node
/**
 * nest-optimizer / tools / run-tests.mjs
 *
 * The test chain, run so that one broken step cannot hide the rest.
 *
 * WHY THIS EXISTS
 * `test` used to be one long `&&` chain. That is fine when everything passes
 * and actively misleading when it does not: the chain stops at the first
 * non-zero exit, so a single failing step - environmental or real - takes the
 * status of every step ordered after it with it. Those steps do not fail; they
 * simply never run, and the log gives you no way to tell the two apart.
 *
 * It is not hypothetical. A stale Playwright pin resolved to a version whose
 * Chromium was not on the box, which killed step 2 of 7 on a clean install.
 * Steps 3-7 were fine the whole time and nobody could show it without running
 * them by hand, one at a time, twice over.
 *
 * So: every step runs, always. A failure is reported and the runner keeps
 * going. The exit code is still non-zero if anything failed, so CI and
 * `npm test` behave the way callers expect - what changes is that you get the
 * whole picture from one run instead of the prefix before the first failure.
 *
 * THE STEP LIST LIVES IN package.json, ONCE
 * `testSteps` is the ordered list of npm script names to run; each script's
 * command stays where it already was, in `scripts`. Nothing is duplicated
 * here, so there is no second copy to drift. Adding a suite is one entry in
 * `scripts` and one name in `testSteps`, and .github/workflows/test.yml -
 * which deliberately does not list the suites - keeps working untouched.
 *
 * COUNTING IS PART OF THE JOB
 * A runner that quietly skips a step is the bug it was written to prevent, so
 * the declared list is validated up front and the executed count is asserted
 * against it at the end. (Written after a shell `while read` loop over this
 * same list silently dropped its last entry - the file had no trailing
 * newline - and reported "6 passed, 0 failed" for a 7-step chain.)
 *
 * NO CACHE, EVER
 * This is the push gate, so it runs every declared step every time. It does
 * not read tools/run-tests-cached.mjs's content-hash cache and must never be
 * taught to: that runner exists to speed up local iteration BETWEEN full
 * runs, and skips steps on the strength of an earlier green run. A skipped
 * step is not a passing step. Before any push, this runner, uncached.
 *
 * Usage:
 *   npm test
 *   node tools/run-tests.mjs            # same thing
 *   node tools/run-tests.mjs --list     # print the steps and exit
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const allSteps = pkg.testSteps;
const weights = pkg.testStepWeights || {};

const SELF = 'run-tests.mjs';

/* SHARDING - `--shard=i/n` runs a balanced i-th slice of the same list.

   Why not slice by index: the suite is nowhere near uniform. One step
   (defects:test) is 15% of the wall clock on its own, the ten slowest are
   46%, and 27 of the steps together are under 2%. Cutting the list into n
   equal-length pieces would hand one runner the long tail and another the
   whole of defects:test, so the slowest shard - which is what CI actually
   waits for - would barely improve.

   So the split is packed by measured cost. `testStepWeights` holds the
   milliseconds each step took on a real run; anything absent from it (a suite
   added since that run) gets the median, which keeps a new step from being
   dropped or from distorting the packing. Longest-processing-time first, and
   ties broken by name, so every runner computes the SAME partition from the
   same package.json without talking to any other runner.

   The partition is asserted, not assumed: every declared step lands in exactly
   one shard, and `--shard-plan` prints the whole thing. Re-measure with
   `--shard-plan` after the suite grows and the weights drift. */
function shardPlan(n) {
  const known = allSteps.map((s) => weights[s]).filter((w) => typeof w === 'number' && w > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1000;
  const cost = (s) => (typeof weights[s] === 'number' && weights[s] > 0 ? weights[s] : median);

  const bins = Array.from({ length: n }, () => ({ steps: [], total: 0 }));
  const order = allSteps.slice().sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const step of order) {
    const bin = bins.reduce((lo, b) => (b.total < lo.total ? b : lo), bins[0]);
    bin.steps.push(step);
    bin.total += cost(step);
  }
  /* Run each shard in the declared order, so a shard's log reads the way the
     whole suite does and a step that depends on ordering within its own shard
     is not reordered under it. */
  const rank = new Map(allSteps.map((s, i) => [s, i]));
  bins.forEach((b) => b.steps.sort((x, y) => rank.get(x) - rank.get(y)));

  const seen = bins.flatMap((b) => b.steps);
  if (seen.length !== allSteps.length || new Set(seen).size !== allSteps.length) {
    console.error(`test runner: shard plan covers ${new Set(seen).size} of ${allSteps.length} steps - refusing to run a partial suite`);
    process.exit(2);
  }
  return bins;
}

function parseShard(argv) {
  const arg = argv.find((a) => a.startsWith('--shard='));
  if (!arg) return null;
  const m = /^--shard=(\d+)\/(\d+)$/.exec(arg);
  if (!m) {
    console.error(`test runner: ${arg} is not --shard=i/n`);
    process.exit(2);
  }
  const i = Number(m[1]), n = Number(m[2]);
  if (!(n >= 1) || !(i >= 1 && i <= n)) {
    console.error(`test runner: --shard=${i}/${n} is out of range`);
    process.exit(2);
  }
  return { i, n };
}

const shard = parseShard(process.argv);
const declared = shard ? shardPlan(shard.n)[shard.i - 1].steps : allSteps;

/* Refuse to start on a list that cannot be run as written. Every one of these
   would otherwise surface as a step that silently did not happen. */
function validate() {
  const bad = [];
  if (!Array.isArray(declared) || declared.length === 0) {
    bad.push('package.json "testSteps" must be a non-empty array of npm script names');
    return bad;
  }
  declared.forEach((name, i) => {
    if (typeof name !== 'string' || !name.trim()) {
      bad.push(`testSteps[${i}] is not a script name`);
      return;
    }
    if (!(name in scripts)) {
      bad.push(`testSteps[${i}] "${name}" is not in package.json "scripts"`);
      return;
    }
    // Running the runner from inside the runner never terminates.
    if (name === 'test' || String(scripts[name]).includes(SELF)) {
      bad.push(`testSteps[${i}] "${name}" runs this runner again (infinite recursion)`);
    }
  });
  const seen = new Set();
  declared.forEach((name, i) => {
    if (seen.has(name)) bad.push(`testSteps[${i}] "${name}" is listed more than once`);
    seen.add(name);
  });
  return bad;
}

function runStep(command) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd: ROOT, shell: '/bin/sh' });
    let out = '';
    /* Echoed as it arrives so a long step shows progress and nothing is lost
       from the log, and kept so the recap can repeat a failure's output
       without the reader scrolling back past six passing suites. */
    const take = (chunk) => { out += chunk; process.stdout.write(chunk); };
    child.stdout.on('data', (d) => take(d.toString()));
    child.stderr.on('data', (d) => take(d.toString()));
    child.on('error', (err) => {
      take(`\n[runner] could not start: ${err.message}\n`);
      resolve({ code: -1, signal: null, ms: Date.now() - started, out });
    });
    child.on('close', (code, signal) => {
      resolve({ code: code === null ? -1 : code, signal, ms: Date.now() - started, out });
    });
  });
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

async function main() {
  const problems = validate();
  if (problems.length) {
    console.error('test runner: the step list is not runnable as written\n');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(2);
  }

  if (process.argv.includes('--shard-plan')) {
    const n = shard ? shard.n : Number(process.argv[process.argv.indexOf('--shard-plan') + 1]) || 6;
    shardPlan(n).forEach((b, k) => {
      console.log(`shard ${k + 1}/${n}  ${(b.total / 1000).toFixed(0)}s over ${b.steps.length} steps`);
      b.steps.forEach((s) => console.log(`    ${s}`));
    });
    return;
  }

  if (process.argv.includes('--list')) {
    declared.forEach((n, i) => console.log(`${i + 1}. ${n}  ->  ${scripts[n]}`));
    return;
  }

  console.log(`test runner: ${declared.length} steps` +
    (shard ? ` (shard ${shard.i}/${shard.n} of ${allSteps.length})` : '') +
    `, every step runs even if an earlier one fails\n`);

  const results = [];
  for (const [i, name] of declared.entries()) {
    const command = scripts[name];
    const label = `[${i + 1}/${declared.length}] ${name}`;
    console.log(`\n${'='.repeat(70)}\n${label}  $ ${command}\n${'='.repeat(70)}`);
    const r = await runStep(command);
    const ok = r.code === 0;
    results.push({ name, command, ok, ...r });
    console.log(`\n${label}  ${ok ? 'PASS' : 'FAIL'}` +
      `  exit=${r.code}${r.signal ? ` signal=${r.signal}` : ''}  ${fmt(r.ms)}`);
  }

  const failed = results.filter((r) => !r.ok);

  console.log(`\n\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
  const width = Math.max(...declared.map((n) => n.length));
  results.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.ok ? 'PASS' : 'FAIL'}  ` +
      `${r.name.padEnd(width)}  exit=${String(r.code).padStart(3)}  ${fmt(r.ms).padStart(7)}`);
  });

  /* The count is a result, not a formality: a step that never ran is exactly
     the failure this runner exists to make impossible to miss. */
  const counted = results.length;
  const miscount = counted !== declared.length;
  if (miscount) {
    console.log(`\n  RUNNER BUG: ${declared.length} steps declared but ${counted} executed`);
  }

  if (failed.length) {
    console.log(`\n${'='.repeat(70)}\nFAILED STEPS (${failed.length} of ${declared.length})\n${'='.repeat(70)}`);
    failed.forEach((r) => {
      console.log(`\n--- ${r.name}  $ ${r.command}  (exit ${r.code}) ---`);
      const lines = r.out.replace(/\s+$/, '').split('\n');
      const tail = lines.slice(-30);
      if (lines.length > tail.length) console.log(`  ... ${lines.length - tail.length} earlier line(s) above`);
      tail.forEach((l) => console.log('  ' + l));
    });
  }

  const passed = results.length - failed.length;
  console.log(`\n${passed}/${declared.length} passed` +
    (failed.length ? `, ${failed.length} failed: ${failed.map((r) => r.name).join(', ')}` : '') + '\n');

  process.exit(failed.length || miscount ? 1 : 0);
}

main();

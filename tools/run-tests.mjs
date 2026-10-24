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
 *   node tools/run-tests.mjs --check    # the step list and tools/test-weights.json agree; exit
 *   node tools/run-tests.mjs --shard=3/20 --timing-csv out.csv
 *                                        # one CI shard, a CSV row per step
 *   node tools/run-tests.mjs --shard-plan [n]
 *                                        # the packing, n shards (CI's 20)
 *   node tools/run-tests.mjs --merge-timing <dir> --out timing.csv
 *                                        # the shards' CSVs as one, every step
 *   node tools/run-tests.mjs --weights-from a.csv[,b.csv] [--dry-run]
 *                                        # tools/test-weights.json from CI's times
 *   node tools/run-tests.mjs --touching nso_slicer.js[,app-core.js]
 *                                        # the steps whose tests reach a file
 *   node tools/run-tests.mjs --shard=3/20 --failures-out failures/shard-3.txt
 *                                        # each failing step as a block, the moment it ends
 *   node tools/run-tests.mjs --package list.json
 *                                        # run the scripts/testSteps of that package.json-shaped file
 *
 * The last five are tools, not runs: they read package.json and the files,
 * and run no test. docs/TESTING.md has the why of each.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { formatWeights } from './migrate-test-weights.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* `--package <file>`: a package.json-shaped file ({scripts, testSteps}) to run in
   place of package.json. Only ci:failures uses it, to run a throwaway list with
   one failing step in it; a script in that file runs from the repo root all the same. */
const pkgArg = argValue('package');
const pkg = JSON.parse(readFileSync(pkgArg ? resolve(pkgArg) : join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const allSteps = pkg.testSteps;

/* Step weights live in tools/test-weights.json, one {"weight", "note"} per step
   (not in package.json: that file was the same three lines in every batch's
   merge conflict). The runner needs only the numbers. */
const WEIGHTS_FILE = join(ROOT, 'tools', 'test-weights.json');
let weightTable = null;
try { weightTable = JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8')); } catch (e) {
  console.error(`test runner: cannot read tools/test-weights.json - ${e.message}`);
  process.exit(2);
}
const weights = Object.fromEntries(Object.entries(weightTable.steps || {}).map(([k, v]) => [k, v && v.weight]));

const SELF = 'run-tests.mjs';

/* SHARDING - `--shard=i/n` runs a balanced i-th slice of the same list.

   Why not slice by index: the suite is nowhere near uniform. One step
   (defects:test) is 15% of the wall clock on its own, the ten slowest are
   46%, and 27 of the steps together are under 2%. Cutting the list into n
   equal-length pieces would hand one runner the long tail and another the
   whole of defects:test, so the slowest shard - which is what CI actually
   waits for - would barely improve.

   So the split is packed by measured cost. tools/test-weights.json holds the
   milliseconds each step took on a real run; anything absent from it (a suite
   added since that run) gets the median, which keeps a new step from being
   dropped or from distorting the packing. Longest-processing-time first, and
   ties broken by name, so every runner computes the SAME partition from the
   same package.json without talking to any other runner.

   The partition is asserted, not assumed: every declared step lands in exactly
   one shard, and `--shard-plan` prints the whole thing. Re-measure with
   `--shard-plan` after the suite grows and the weights drift. */

/* CI's matrix size (.github/workflows/test.yml). Twenty since the three
   steps that held the heaviest shard were split (support:shells, gscope:speed,
   support:interface: ci-shard-split): the 261-step suite is ~13,484 s of
   typical-runner time, and a wall clock of one shard's worth of it needs the
   shards to be many and the steps in them small. Ten before that (eight were
   ~1,725 s each on Tests #297-#305 and two ran past the 40-minute job
   timeout), with support:shells alone ~1,229 s as the floor. */
const CI_SHARDS = 20;

/* What a shard may weigh, in the weights' typical-runner seconds: 700 s is
   ~12 min of tests plus ~1.5 min of setup, about a fifth of the job's
   60-minute timeout (about one runner in five ran #297-#305's steps in ~0.6 of
   the time, and none measurably slower than typical, so the headroom is for a
   runner sharing its cores and for drift between re-measures). `--shard-plan`
   flags any shard over it. The heaviest single step is now
   gscope:speed-drag-file (~579 s; it opens the 203k-move file and drags two
   copies of it under software GL - what render-on-demand would cut), then
   support:shells-clamp-a1 (~305 s) and lift:plate (~281 s), so the floor is
   under the budget; what holds the budget is the shard count: the suite's
   seconds divided by it (ci-shard-split-2: 13,840 s, 692 s a shard). */
const SHARD_BUDGET_S = 700;

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

/* `--name value` or `--name=value`; null when absent. */
function argValue(name) {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

/* THE TIMING CSV - one row per step: step, shard, seconds, result.

   CI's step times used to live only in each shard's log, as its SUMMARY table,
   and the logs are the one thing the agent proxy cannot fetch. So every shard
   writes them as a file too (`--timing-csv`), the workflow uploads it, and the
   "npm test" job merges the shards' files into one artifact (`--merge-timing`).
   That file is what `--weights-from` reads.

   The row is appended the moment its step ends, not at the end of the run: a
   shard cancelled at the job timeout still leaves the times of every step it
   finished, which is exactly the run whose times are most worth having. */
const CSV_HEADER = 'step,shard,seconds,result';

function csvField(s) {
  s = String(s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Rows of a timing CSV as { step, shard, seconds, result }. Tolerates a
   missing header and blank lines; a quoted field may hold a comma. */
function readTimingCsv(file) {
  const rows = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, k) => {
    if (!line.trim()) return;
    const f = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { f.push(cur); cur = ''; }
      else cur += c;
    }
    f.push(cur);
    if (k === 0 && f.join(',') === CSV_HEADER) return;
    if (f.length < 4) throw new Error(`${file}:${k + 1}: expected ${CSV_HEADER}, got "${line}"`);
    const seconds = f[2].trim() === '' ? null : Number(f[2]);
    rows.push({ step: f[0].trim(), shard: f[1].trim(), seconds, result: f[3].trim().toLowerCase(), file, line: k + 1 });
  });
  return rows;
}

function csvFilesIn(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((n) => csvFilesIn(join(path, n)))
    .filter((p) => extname(p) === '.csv');
}

/* `--merge-timing <dir> --out <file>`: every shard's CSV under <dir>, as one
   file in the declared step order, and a row for every declared step that no
   shard reported - `not-run`, under the shard the plan put it in, so a
   cancelled shard or a one-shard dispatch reads as what it was instead of as
   a shorter suite. Prints each shard's total, which is the number to watch. */
function mergeTiming() {
  const dir = argValue('merge-timing'), out = argValue('out');
  if (!dir || !out) {
    console.error('test runner: --merge-timing <dir> --out <file>');
    process.exit(2);
  }
  const rows = csvFilesIn(dir).flatMap(readTimingCsv);
  const ns = [...new Set(rows.map((r) => Number(r.shard.split('/')[1])).filter((x) => x > 0))];
  const n = Number(argValue('shards')) || (ns.length === 1 ? ns[0] : CI_SHARDS);
  const planned = new Map();
  shardPlan(n).forEach((b, k) => b.steps.forEach((s) => planned.set(s, `${k + 1}/${n}`)));

  const byStep = new Map();
  rows.forEach((r) => { if (!byStep.has(r.step)) byStep.set(r.step, []); byStep.get(r.step).push(r); });
  const merged = [];
  allSteps.forEach((s) => {
    const got = byStep.get(s);
    if (got) merged.push(...got);
    else merged.push({ step: s, shard: planned.get(s), seconds: null, result: 'not-run' });
  });
  const known = new Set(allSteps);
  rows.filter((r) => !known.has(r.step)).forEach((r) => merged.push(r));

  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, [CSV_HEADER, ...merged.map((r) =>
    [r.step, r.shard, r.seconds === null ? '' : r.seconds.toFixed(3), r.result].map(csvField).join(','))].join('\n') + '\n');

  const shards = new Map();
  merged.forEach((r) => {
    if (!shards.has(r.shard)) shards.set(r.shard, { s: 0, steps: 0, fail: 0, notRun: 0 });
    const t = shards.get(r.shard);
    t.steps++;
    t.s += r.seconds || 0;
    if (r.result === 'fail') t.fail++;
    if (r.result === 'not-run') t.notRun++;
  });
  console.log(`timing: ${rows.length} rows from ${csvFilesIn(dir).length} file(s), ${merged.length} rows -> ${out}`);
  [...shards.keys()].sort((a, b) => parseInt(a) - parseInt(b)).forEach((k) => {
    const t = shards.get(k);
    console.log(`  shard ${k.padStart(5)}  ${t.s.toFixed(0).padStart(5)} s over ${String(t.steps).padStart(2)} steps` +
      (t.fail ? `  ${t.fail} fail` : '') + (t.notRun ? `  ${t.notRun} not run` : ''));
  });
  const unknown = rows.filter((r) => !known.has(r.step));
  if (unknown.length) console.log(`  ${unknown.length} row(s) name steps this package.json does not declare, kept at the end`);
}

/* WEIGHTS FROM CI - `--weights-from a.csv[,b.csv]` rewrites tools/test-weights.json.

   A weight is the mean of that step's PASSING rows across the files given -
   two runs' CSVs averaged is the method package.json's note has always asked
   for, done by hand from SUMMARY tables until now. A failing row is not a
   time (a step that dies early is short, one that hangs to its own timeout is
   long) and a not-run row has none, so a step with neither keeps the weight
   it had, and is listed. Rows naming steps package.json does not declare are
   ignored, and listed. Rounded as the table always was: to the millisecond
   under a second, to 50 ms above.

   Each shard is first scaled to the typical runner. The fleet is not one
   machine: in Tests #297-#305 about one shard in five ran the same steps in
   0.6-0.7 of the time the rest took, so a step that happened to land on a
   fast shard would be weighed 40 % light, and the next plan would pile work
   onto it. A shard's speed is the median, over its rows whose current weight
   is 20 s or more, of time / weight; the typical speed is the median of the
   shards'; each row is multiplied by typical / its shard's. A shard with
   fewer than three such rows is left as measured. The factors are printed.

   It records what it read in the file's "source", so the table says where
   it came from without anyone remembering to edit the note. --dry-run prints
   the same report and writes nothing. */
const SCALE_MIN_MS = 20000;
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function weightsFrom() {
  const list = argValue('weights-from');
  const files = (list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!files.length) {
    console.error('test runner: --weights-from <file.csv>[,<file.csv>]');
    process.exit(2);
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`test runner: no such file: ${missing.join(', ')}`);
    process.exit(2);
  }
  const rows = files.flatMap(readTimingCsv);
  const known = new Set(allSteps);
  const old = weights;
  const good = rows.filter((r) => known.has(r.step) && r.result === 'pass' && r.seconds >= 0);

  const runner = new Map();   // file + shard -> its passing rows
  good.forEach((r) => {
    const k = `${r.file}|${r.shard}`;
    if (!runner.has(k)) runner.set(k, []);
    runner.get(k).push(r);
  });
  const speed = new Map();
  runner.forEach((rs, k) => {
    const v = rs.filter((r) => old[r.step] >= SCALE_MIN_MS).map((r) => r.seconds * 1000 / old[r.step]);
    if (v.length >= 3) speed.set(k, median(v));
  });
  const typical = speed.size ? median([...speed.values()]) : 1;
  const factor = (k) => (speed.has(k) ? typical / speed.get(k) : 1);

  const pass = new Map();
  good.forEach((r) => {
    if (!pass.has(r.step)) pass.set(r.step, []);
    pass.get(r.step).push(r.seconds * factor(`${r.file}|${r.shard}`));
  });
  if (!pass.size) {
    console.error(`test runner: ${files.join(', ')} hold no passing row for any declared step - nothing rewritten`);
    process.exit(2);
  }
  const round = (ms) => (ms >= 1000 ? Math.round(ms / 50) * 50 : Math.max(1, Math.round(ms)));
  const next = { ...old };
  const changed = [], kept = [];
  allSteps.forEach((s) => {
    const v = pass.get(s);
    if (!v) { kept.push(s); return; }
    const w = round(v.reduce((a, b) => a + b, 0) / v.length * 1000);
    if (w !== old[s]) changed.push({ s, from: old[s], to: w, n: v.length });
    next[s] = w;
  });
  const ignored = [...new Set(rows.filter((r) => !known.has(r.step)).map((r) => r.step))];

  const sum = (w) => allSteps.reduce((t, s) => t + (Number(w[s]) || 0), 0) / 1000;
  console.log(`weights from ${files.join(', ')}: ${pass.size} of ${allSteps.length} steps measured, ` +
    `${changed.length} changed; the table sums ${sum(old).toFixed(0)} s -> ${sum(next).toFixed(0)} s`);
  const many = files.length > 1;
  const label = (k) => { const [f, sh] = k.split('|'); return many ? `${basename(f)} ${sh}` : sh; };
  if (speed.size) {
    console.log(`  each shard scaled to the typical runner (time x factor): ` +
      [...runner.keys()].map((k) => `${label(k)} x${factor(k).toFixed(2)}`).join(', '));
  }
  const unscaled = [...runner.keys()].filter((k) => !speed.has(k));
  if (unscaled.length) console.log(`  left as measured, too few rows of ${SCALE_MIN_MS / 1000} s to scale by: ${unscaled.map(label).join(', ')}`);
  const width = Math.max(...allSteps.map((s) => s.length));
  changed.forEach((c) => console.log(`  ${c.s.padEnd(width)}  ${String(c.from ?? '-').padStart(8)} -> ${String(c.to).padStart(8)}` +
    (c.n > 1 ? `  (mean of ${c.n})` : '')));
  const few = (a) => (a.length <= 12 ? a.join(', ') : `${a.slice(0, 12).join(', ')} and ${a.length - 12} more`);
  if (kept.length) console.log(`  kept, no passing row (${kept.length}): ${few(kept)}`);
  if (ignored.length) console.log(`  ignored, not in testSteps: ${ignored.join(', ')}`);

  if (process.argv.includes('--dry-run')) { console.log('  --dry-run: tools/test-weights.json not written'); return; }
  /* Weights change; each step's note, the file's prose and the step set stay. */
  const steps = {};
  for (const [name, w] of Object.entries(next)) steps[name] = { weight: w, note: (weightTable.steps[name] || {}).note || '' };
  const source = `${files.map((f) => basename(f)).join(' + ')}, read ${new Date().toISOString().slice(0, 10)}` +
    ` by run-tests.mjs --weights-from: ${pass.size} steps measured (mean of passing rows, each shard scaled to the` +
    ` typical runner), ${kept.length} kept from before` + (kept.length ? ` (${few(kept)})` : '');
  writeFileSync(WEIGHTS_FILE, formatWeights({ about: weightTable.about || [], source, steps }));
  console.log(`  tools/test-weights.json written; check the packing with --shard-plan ${CI_SHARDS}`);
}

/* WHICH STEPS REACH A FILE - `--touching nso_slicer.js[,app-core.js]`.

   A kickoff names the gates its PR has to pass, and a cross-cutting change
   keeps missing the dependent ones: slicer:supports is obviously the slicer's,
   gscope:select is not, and it is red the first time CI runs the slice behind
   it. This names them from the files instead of from memory. It is a grep,
   good enough to name dependents, not a module graph:

     a step's files    the files its npm script runs (node X, python3 X, and
                       for `sh X.sh` the files X.sh runs), plus the local
                       modules each of those requires or imports - one level
     a file's names    its basename (nso_slicer.js) and the ids it exports:
                       window./root./globalThis./self. X = , module.exports.X,
                       exports.X, export function/const/class X, export {X}
     its users         the product files (repo-root and cth/ scripts) that
                       require it or name one of its names - one level

   A step is listed when one of its files requires the target or one of its
   users, or names one of their names. The users matter as much as the
   target: a check that drives the page reaches nso_slicer.js only through the
   app script that calls it (gscope:select names window.NSO_GSCOPE_SLICE,
   app-gscope-slice.js, which calls NSO_Slicer). A classic script's top-level
   function declarations are globals too but are not counted - there are too
   many of them and too many are common words - so a file whose API is only
   that reaches its users through its basename alone. */
const PRODUCT_DIRS = ['', 'cth'];

function productFiles() {
  return PRODUCT_DIRS.flatMap((d) => {
    const dir = join(ROOT, d);
    return readdirSync(dir).filter((n) => /\.(js|mjs|cjs)$/.test(n)).map((n) => join(dir, n))
      .filter((p) => statSync(p).isFile());
  });
}

/* A file's code without its comments: a comment that mentions nso_slicer.js
   is not a use of it (nso_support_gridpack.js describes the slicer in one,
   and would otherwise bring every support check in with it). Strings are
   walked over so a URL's // is not a comment. A quote or a // inside a regex
   literal can fool it; a ' or " string ends at its line, so the most that
   costs is one line read wrong, which a grep can live with. */
function stripComments(t, file, blankStrings) {
  if (/\.(sh|py)$/.test(file)) return t.replace(/^\s*#.*$/gm, '');
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i], d = t[i + 1];
    if (c === '/' && d === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; out += ' '; continue; }
    if (c === '/' && d === '/') { const e = t.indexOf('\n', i); i = e < 0 ? t.length : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < t.length && t[j] !== c && (c === '`' || t[j] !== '\n')) j += t[j] === '\\' ? 2 : 1;
      if (t[j] !== c) { out += c; i++; continue; }
      out += blankStrings ? c + c : t.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const textCache = new Map();
function textOf(file) {
  if (!textCache.has(file)) {
    let t = '';
    try { t = stripComments(readFileSync(file, 'utf8'), file); } catch (e) { /* unreadable: names nothing */ }
    textCache.set(file, t);
  }
  return textCache.get(file);
}

/* The local files a script requires or imports, resolved; bare packages
   (playwright, node:fs) are not local and are skipped. */
function localRequires(file) {
  const t = textOf(file), out = new Set();
  const re = /\brequire\(\s*['"`]([^'"`]+)['"`]\s*\)|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\bimport\s+(?:[^'"`;]*?\bfrom\s*)?['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(t))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const base = resolve(dirname(file), spec);
    const hit = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')]
      .find((p) => existsSync(p) && statSync(p).isFile());
    if (hit) out.add(hit);
  }
  return [...out];
}

/* Exports are read from code with its strings emptied too: a worker's source
   held in a string (app-supports-card.js builds one) assigns self.X there,
   and that X is no API of the file. */
function exportedIds(file) {
  let t = '';
  try { t = stripComments(readFileSync(file, 'utf8'), file, true); } catch (e) { /* unreadable: exports nothing */ }
  const ids = new Set();
  const res = [
    /\b(?:window|root|globalThis|self|global)\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g,
    /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g,
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  ];
  res.forEach((re) => { let m; while ((m = re.exec(t))) ids.add(m[1]); });
  let m;
  const list = /\bexport\s*\{([^}]*)\}/g;
  while ((m = list.exec(t))) m[1].split(',').forEach((p) => { const id = p.trim().split(/\s+as\s+/).pop(); if (id) ids.add(id); });
  /* window.onmessage = ... is a handler, not an API anyone names. */
  return [...ids].filter((id) => !/^on[a-z]+$/.test(id) && id !== 'default');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* An id or a basename, as a whole word: nso_slicer.js is not nso_slicer_audit.js. */
function nameRe(names) {
  return new RegExp(`(?<![\\w$-])(?:${names.map(escapeRe).join('|')})(?![\\w$-])`);
}

/* The files a step runs: script paths in its command, and what a .sh runs. */
function stepFiles(step) {
  const files = new Set();
  const take = (cmd, from) => {
    cmd.split(/\s+|&&|\|\||;/).forEach((tok) => {
      if (!/\.(js|mjs|cjs|py|sh)$/.test(tok)) return;
      const p = isAbsolute(tok) ? tok : resolve(from, tok);
      if (!existsSync(p) || files.has(p)) return;
      files.add(p);
      if (p.endsWith('.sh')) take(textOf(p), ROOT);
    });
  };
  take(String(scripts[step] || ''), ROOT);
  const direct = [...files];
  direct.forEach((f) => { if (!f.endsWith('.sh') && !f.endsWith('.py')) localRequires(f).forEach((r) => files.add(r)); });
  return [...files];
}

function touching() {
  const list = argValue('touching');
  const targets = (list || '').split(',').map((s) => s.trim()).filter(Boolean).map((f) => {
    const p = [resolve(f), resolve(ROOT, f)].find((x) => existsSync(x) && statSync(x).isFile());
    if (!p) { console.error(`test runner: --touching: no such file: ${f}`); process.exit(2); }
    return p;
  });
  if (!targets.length) {
    console.error('test runner: --touching <file>[,<file>]');
    process.exit(2);
  }
  const rel = (p) => relative(ROOT, p);
  const namesOf = (p) => [basename(p), ...exportedIds(p)];

  /* One level of users, among the product files. */
  const via = new Map();   // file -> the target it stands for
  targets.forEach((t) => via.set(t, null));
  targets.forEach((t) => {
    const re = nameRe(namesOf(t));
    productFiles().forEach((p) => {
      if (via.has(p)) return;
      if (localRequires(p).includes(t) || re.test(textOf(p))) via.set(p, t);
    });
  });
  const reach = [...via.keys()];
  const reachRe = reach.map((f) => ({ f, re: nameRe(namesOf(f)) }));

  const found = [];
  allSteps.forEach((step) => {
    for (const sf of stepFiles(step)) {
      const req = localRequires(sf).find((r) => via.has(r));
      let hit = req ? { f: req, how: `requires ${basename(req)}` } : null;
      if (!hit && via.has(sf)) hit = { f: sf, how: 'runs' };
      if (!hit) {
        const t = textOf(sf);
        const r = reachRe.find((x) => x.re.test(t));
        if (r) hit = { f: r.f, how: `names ${t.match(r.re)[0]}` };
      }
      if (hit) {
        const through = via.get(hit.f);
        found.push({ step, why: `${rel(sf)} ${hit.how}` +
          (hit.how.startsWith('names') && hit.how !== `names ${basename(hit.f)}` ? ` (${rel(hit.f)})` : '') +
          (hit.how === `requires ${basename(hit.f)}` && dirname(hit.f) !== ROOT ? ` (${rel(hit.f)})` : '') +
          (through ? `, which uses ${rel(through)}` : '') });
        return;
      }
    }
  });

  const users = reach.filter((f) => via.get(f));
  console.log(`--touching ${targets.map(rel).join(', ')}: ${found.length} of ${allSteps.length} steps` +
    (users.length ? `, directly or through ${users.length} product file(s) that use it: ${users.map(rel).join(', ')}` : ''));
  const width = Math.max(0, ...found.map((x) => x.step.length));
  found.forEach((x) => console.log(`  ${x.step.padEnd(width)}  ${x.why}`));
}

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

/* The step running now, so a SIGINT / SIGTERM (the job step's timeout, or a
   cancel) can report it as the step that was cut off. */
let active = null;

function runStep(command, name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd: ROOT, shell: '/bin/sh' });
    let out = '';
    active = { name, started, child, output: () => out };
    /* Echoed as it arrives so a long step shows progress and nothing is lost
       from the log, and kept so the recap can repeat a failure's output
       without the reader scrolling back past six passing suites. */
    const take = (chunk) => { out += chunk; process.stdout.write(chunk); };
    child.stdout.on('data', (d) => take(d.toString()));
    child.stderr.on('data', (d) => take(d.toString()));
    child.on('error', (err) => {
      take(`\n[runner] could not start: ${err.message}\n`);
      active = null;
      resolve({ code: -1, signal: null, ms: Date.now() - started, out });
    });
    child.on('close', (code, signal) => {
      active = null;
      resolve({ code: code === null ? -1 : code, signal, ms: Date.now() - started, out });
    });
  });
}

/* THE FAILURE REPORT - one block per failing step, printed the moment it ends.
   A shard is ~12 minutes of steps; the step that failed in its first minute
   should not be found by scrolling a 12-minute log after the other nineteen
   shards finish. So the block goes to the log, to a `::error` annotation, and
   (--failures-out) to a file the workflow puts on the run's summary page and
   uploads as an artifact. The file is emptied at the start and a block is
   appended as each failing step ends, so a shard that is cut off still leaves
   the blocks of the steps that failed before it was. */
const FAIL_LINE = /\bFAIL(?:ED)?\b(?!-SAFE)|\bnot ok\b/;
const TAIL_LINES = 40;
const MAX_FAIL_LINES = 500;

/* A workflow command's message and property escapes (the `::error` line). */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function failureBlock({ name, code, signal, interrupted, ms, out }, shardNo) {
  const lines = out.replace(/\s+$/, '').split('\n');
  const failing = lines.filter((l) => FAIL_LINE.test(l)).map((l) => l.trimEnd().slice(0, 400));
  const result = interrupted
    ? `stopped by ${interrupted} (the step's timeout, or a cancel)`
    : `exit code ${code}${signal ? ` (signal ${signal})` : ''}`;
  const block = [
    `=== FAILED: ${name} (shard ${shardNo}) ===`,
    `command: npm run ${name}`,
    `result:  ${result}`,
    `seconds: ${(ms / 1000).toFixed(1)}`,
    failing.length ? `failing lines (${failing.length}):` : 'failing lines: none matched FAILED / not ok',
    ...failing.slice(0, MAX_FAIL_LINES).map((l) => '  ' + l),
    ...(failing.length > MAX_FAIL_LINES ? [`  ... ${failing.length - MAX_FAIL_LINES} more`] : []),
    `last ${Math.min(TAIL_LINES, lines.length)} lines:`,
    ...lines.slice(-TAIL_LINES).map((l) => '  ' + l),
    `=== end ${name} ===`,
    '',
  ].join('\n');
  const first = failing[0] || lines.filter((l) => l.trim()).pop() || result;
  return { block, annotation: `::error title=${escProp(`shard ${shardNo}: ${name} failed`)}::${esc(first.trim())}` };
}

let failuresFile = null;
function reportFailure(r, shardNo) {
  const { block, annotation } = failureBlock(r, shardNo);
  console.log('\n' + block + annotation);
  if (failuresFile) appendFileSync(failuresFile, block + '\n');
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

async function main() {
  const problems = validate();
  if (problems.length) {
    console.error('test runner: the step list is not runnable as written\n');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(2);
  }

  if (process.argv.includes('--touching')) return touching();
  if (process.argv.includes('--weights-from')) return weightsFrom();
  if (process.argv.includes('--merge-timing')) return mergeTiming();

  if (process.argv.includes('--shard-plan')) {
    const n = shard ? shard.n : Number(process.argv[process.argv.indexOf('--shard-plan') + 1]) || CI_SHARDS;
    const plan = shardPlan(n);
    plan.forEach((b, k) => {
      const over = b.total / 1000 > SHARD_BUDGET_S ? `  OVER the ${SHARD_BUDGET_S} s budget` : '';
      console.log(`shard ${k + 1}/${n}  ${(b.total / 1000).toFixed(0)}s over ${b.steps.length} steps${over}`);
      b.steps.forEach((s) => console.log(`    ${s}`));
    });
    const worst = Math.max(...plan.map((b) => b.total)) / 1000;
    console.log(`\nheaviest shard ${worst.toFixed(0)} s of ${SHARD_BUDGET_S} s budget; ` +
      `${(plan.reduce((t, b) => t + b.total, 0) / 1000).toFixed(0)} s in all`);
    return;
  }

  if (process.argv.includes('--check')) {
    const bad = createRequire(import.meta.url)('./test-weights-check.cjs').problems(pkg, weightTable);
    if (bad.length) {
      console.error('test runner: tools/test-weights.json and package.json disagree\n');
      bad.forEach((p) => console.error('  - ' + p));
      process.exit(1);
    }
    console.log(`test runner: ${allSteps.length} steps, each with a weight and a script; ${Object.keys(weights).length} entries, none without one`);
    return;
  }

  if (process.argv.includes('--list')) {
    declared.forEach((n, i) => console.log(`${i + 1}. ${n}  ->  ${scripts[n]}`));
    return;
  }

  console.log(`test runner: ${declared.length} steps` +
    (shard ? ` (shard ${shard.i}/${shard.n} of ${allSteps.length})` : '') +
    `, every step runs even if an earlier one fails\n`);

  const csv = argValue('timing-csv');
  const shardLabel = shard ? `${shard.i}/${shard.n}` : '1/1';
  if (csv) {
    mkdirSync(dirname(resolve(csv)), { recursive: true });
    writeFileSync(csv, CSV_HEADER + '\n');
  }

  const shardNo = shard ? shard.i : 1;
  const failuresOut = argValue('failures-out');
  if (failuresOut) {
    mkdirSync(dirname(resolve(failuresOut)), { recursive: true });
    writeFileSync(failuresOut, '');
    failuresFile = failuresOut;
  }
  /* A timeout or cancel reaches this process as SIGINT, then SIGTERM; the step
     it cut off is the one worth naming, and there is time to write it down. */
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (active) {
        active.child.kill('SIGKILL');
        reportFailure({ name: active.name, code: -1, signal: null, interrupted: sig, ms: Date.now() - active.started, out: active.output() }, shardNo);
      }
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }

  const results = [];
  for (const [i, name] of declared.entries()) {
    const command = scripts[name];
    const label = `[${i + 1}/${declared.length}] ${name}`;
    console.log(`\n${'='.repeat(70)}\n${label}  $ ${command}\n${'='.repeat(70)}`);
    const r = await runStep(command, name);
    const ok = r.code === 0;
    results.push({ name, command, ok, ...r });
    if (!ok) reportFailure({ name, ...r }, shardNo);
    if (csv) appendFileSync(csv, [name, shardLabel, (r.ms / 1000).toFixed(3), ok ? 'pass' : 'fail'].map(csvField).join(',') + '\n');
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

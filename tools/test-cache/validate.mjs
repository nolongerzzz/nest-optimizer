#!/usr/bin/env node
/**
 * nest-optimizer / tools / test-cache / validate.mjs
 *
 * Does the cache skip anything it should not? Checked the only way that
 * means anything: make real edits to files that real suites depend on
 * through paths an import graph cannot see, and watch what the cache does.
 *
 *   node tools/test-cache/validate.mjs            # lookups only, ~seconds
 *   node tools/test-cache/validate.mjs --run      # + really run crop:test on a broken Cut
 *
 * Needs a warm cache for the suites named below (run-tests-cached.mjs
 * --no-skip), and a clean app-cut.js / app-join.js / NSO_Repair.js: every
 * edit is undone in a finally block and the restored bytes are verified.
 *
 * THE CASES - each one a shared code path that has bitten this project:
 *
 * 1. Cut's cap -> Crop. Crop seals its joint with rawFlatCapLoop, which is
 *    Cut's code in app-cut.js, called by global name. The chain for
 *    wire:crop is four hops, none of them an import:
 *        tools/nso_wire_crop_test.js
 *          -> require('./nso_app_harness')      (the only import)
 *          -> serves index.html to Chromium    (an HTTP response)
 *          -> <script src="app-cut.js">         (a script tag)
 *          -> rawFlatCapLoop, called from app-crop.js by name
 *    and for crop:test it is an fs.readFileSync of 'app-cut.js' into a vm
 *    context. The edit flips the cap's winding rule - a real bug, the one
 *    crop:test's "step face faces the right way" gate exists to catch.
 * 2. setStatus() -> measure and cth:capture. Defined once in app-join.js,
 *    reached only through the page; both suites assert on #status.
 * 3. NSO_Repair's checker -> every suite that loads it, directly or through
 *    the page.
 * 4. The control: an edit to a file NO suite reads (docs/CROP.md) must not
 *    cost a single rerun, or the cache is useless and nobody will use it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, envSalt, makeClassifier, Fingerprinter, loadRecords, lookup } from './cache.mjs';
import { staticGraphs } from './static-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CACHE = cacheDir(ROOT);
const classify = makeClassifier(ROOT, CACHE);
const salt = envSalt(ROOT);
const sha = (b) => createHash('sha256').update(b).digest('hex');

let fails = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!cond) fails++;
};

/* Which steps would run right now. A fresh Fingerprinter per call, with no
   persisted memo, so nothing from before the edit can answer for after it. */
function wouldRun() {
  const fper = new Fingerprinter(join(CACHE, 'validate-memo-unused.json'));
  fper.memo = {};
  const run = new Set(), why = {};
  for (const step of pkg.testSteps) {
    const r = lookup({ step, command: pkg.scripts[step], salt, records: loadRecords(CACHE, step), fper, classify, root: ROOT });
    if (!r.hit) { run.add(step); why[step] = r.why; }
  }
  return { run, why };
}

function withEdit(file, from, to, fn) {
  const abs = join(ROOT, file);
  const orig = readFileSync(abs);
  const src = orig.toString('utf8');
  if (!src.includes(from)) throw new Error(`${file}: the text to edit is not there any more - update validate.mjs: ${from}`);
  try {
    writeFileSync(abs, src.replace(from, to));
    return fn();
  } finally {
    writeFileSync(abs, orig);
    if (sha(readFileSync(abs)) !== sha(orig)) throw new Error(`${file} was NOT restored - check git diff`);
  }
}

const naiveHas = (step, file) => staticGraphs(ROOT, pkg.scripts[step]).imports.has(join(ROOT, file));

console.log('test cache validation - every edit below is undone before exit\n');
const base = wouldRun();
const cachedNow = pkg.testSteps.filter((s) => !base.run.has(s));
console.log(`baseline: ${cachedNow.length}/${pkg.testSteps.length} steps would skip right now\n`);

const CASES = [
  {
    title: "1. Cut's cap winding (app-cut.js rawFlatCapLoop) -> Crop",
    file: 'app-cut.js',
    from: 'const wantSign = keepMin ? -1 : 1;',
    to: 'const wantSign = keepMin ? 1 : -1;',
    must: ['crop:test', 'wire:crop'],
  },
  {
    title: '2. setStatus() in app-join.js -> measure, cth:capture',
    file: 'app-join.js',
    from: "el.className = 'status' + (isError ? ' error' : ' success');",
    to: "el.className = 'status' + (isError ? ' error' : ' success'); /* validate.mjs */",
    must: ['measure:test', 'cth:capture'],
  },
  {
    title: "3. NSO_Repair's checker -> its users",
    file: 'NSO_Repair.js',
    from: null, // appended below: any byte counts
    to: null,
    must: ['wire:repair'],
  },
];

for (const c of CASES) {
  console.log(c.title);
  const missingPre = c.must.filter((s) => base.run.has(s));
  if (missingPre.length) {
    check(`precondition: ${missingPre.join(', ')} cached-green before the edit`, false,
      'warm them first: node tools/run-tests-cached.mjs --no-skip ' + missingPre.join(' '));
    console.log();
    continue;
  }
  const src = readFileSync(join(ROOT, c.file), 'utf8');
  const from = c.from || src.slice(-200);
  const to = c.to || from + '\n// validate.mjs\n';
  const after = withEdit(c.file, from, to, wouldRun);
  const newly = [...after.run].filter((s) => !base.run.has(s));
  for (const s of c.must) {
    check(`${s} reruns`, after.run.has(s), after.why[s] ? `(${after.why[s].slice(0, 90)})` : '');
    if (!naiveHas(s, c.file)) console.log(`          a naive import graph of ${s} does not contain ${c.file}`);
  }
  /* Everything that reran must actually have touched the file on record -
     otherwise the rerun is noise from somewhere else and this proves nothing. */
  const unexplained = newly.filter((s) => !loadRecords(CACHE, s).some((r) => join(ROOT, c.file) in r.manifest));
  check(`every newly-rerun step had ${c.file} on its record`, unexplained.length === 0, unexplained.join(', '));
  const stillSkip = cachedNow.filter((s) => !after.run.has(s));
  console.log(`          ${newly.length} step(s) rerun, ${stillSkip.length} still skip (never touched ${c.file})\n`);
}

console.log('4. control: an edit to a file no suite reads (docs/CROP.md)');
{
  const after = withEdit('docs/CROP.md', '#', '# ', wouldRun);
  const newly = [...after.run].filter((s) => !base.run.has(s));
  check('no step reruns', newly.length === 0, newly.join(', '));
  console.log();
}

const back = wouldRun();
check('after restoring every file the cache is exactly as before', [...back.run].sort().join() === [...base.run].sort().join());

/* The end-to-end version of case 1: not "would it rerun" but "does the
   cached runner, given the broken Cut, actually go red". */
if (process.argv.includes('--run')) {
  console.log('\n5. end to end: run-tests-cached.mjs crop:test with the cap winding flipped');
  const c = CASES[0];
  const r = withEdit(c.file, c.from, c.to, () => spawnSync(process.execPath, [join(ROOT, 'tools', 'run-tests-cached.mjs'), 'crop:test'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }));
  const out = (r.stdout || '') + (r.stderr || '');
  check('crop:test was run, not skipped', !/crop:test\s+SKIP/.test(out) && /rerun: .*app-cut\.js/.test(out));
  check('and it FAILED on the broken cap', r.status !== 0 && /FAIL\s+crop:test/.test(out),
    (out.match(/^\s*FAIL\s+[^\n]*$/m) || [''])[0].trim().slice(0, 100));
  check('nothing was recorded for the broken tree', /failed - nothing recorded/.test(out));
  const after = wouldRun();
  check('with Cut restored, crop:test is cached-green again', !after.run.has('crop:test'));
}

console.log(`\n${fails ? `${fails} check(s) FAILED` : 'all checks passed'}`);
process.exit(fails ? 1 : 0);

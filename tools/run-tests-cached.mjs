#!/usr/bin/env node
/**
 * nest-optimizer / tools / run-tests-cached.mjs
 *
 *   ************************************************************************
 *   *  LOCAL ITERATION ONLY. THIS IS NOT THE PUSH GATE.                     *
 *   *  Before ANY push, run the full, uncached suite:  npm test             *
 *   *  `npm test` (tools/run-tests.mjs) never reads or writes this cache,   *
 *   *  and nothing here can make it skip a step.                            *
 *   ************************************************************************
 *
 * The same step list as `npm test`, but a step whose last green run on
 * byte-identical inputs is on record is skipped instead of run again.
 *
 * WHAT "INPUTS" MEANS HERE
 * Not what a step imports. What its processes actually opened, stat'd and
 * listed on its last green run, captured with strace (tools/test-cache/
 * trace.mjs) - app scripts read as text into a vm context, everything a real
 * Chromium fetched for index.html, the fixtures, python's own imports when a
 * step shells out to mesh_validate.py. A step is skipped only when every one
 * of those is unchanged right now, along with its command and environment.
 * docs/TEST-CACHE.md has the audit that says why the trace, and not an
 * import graph, is the dependency graph.
 *
 * Every step this runs is traced, and a green one is recorded under the
 * current commit (and whether the tree was dirty). A red one records
 * nothing, and never removes an older green record for other inputs.
 *
 * Usage:
 *   npm run test:cached                          # every step, skipping cached-green ones
 *   node tools/run-tests-cached.mjs crop:test wire:crop     # just these
 *   node tools/run-tests-cached.mjs 'wire:*'     # glob over step names
 *   node tools/run-tests-cached.mjs --dry-run    # what would run, and why - runs nothing
 *   node tools/run-tests-cached.mjs --no-skip    # run + record everything (warm the cache)
 *   node tools/run-tests-cached.mjs --jobs=3     # traced steps side by side
 *   node tools/run-tests-cached.mjs --deps crop:test        # print a step's recorded deps
 *   node tools/run-tests-cached.mjs --clear      # forget every record
 */
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { trace, killAll } from './test-cache/trace.mjs';
import {
  CACHE_VERSION, cacheDir, gitState, envSalt, makeClassifier, Fingerprinter,
  buildManifest, keyOf, loadRecords, saveRecord, saveTrace, lookup,
} from './test-cache/cache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const allSteps = pkg.testSteps || [];
const CACHE = cacheDir(ROOT);

export const NOT_A_GATE = [
  'LOCAL ITERATION ONLY - NOT A PUSH GATE.',
  'Skipped steps were NOT run. Before any push, run the full uncached suite: npm test',
];
const banner = () => {
  const w = Math.max(...NOT_A_GATE.map((l) => l.length)) + 4;
  return ['*'.repeat(w), ...NOT_A_GATE.map((l) => `* ${l.padEnd(w - 4)} *`), '*'.repeat(w)].join('\n');
};

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const numArg = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Math.max(1, Number(a.split('=')[1]) || dflt) : dflt;
};
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const rel = (p) => (p.startsWith(ROOT + sep) ? p.slice(ROOT.length + 1) : p);

/* A CI job that called this instead of `npm test` would pass on steps that
   never ran. Refuse outright rather than trust a flag to be remembered. */
if (process.env.CI && !flag('--allow-ci')) {
  console.error('run-tests-cached: refusing to run under CI. CI must run the full suite (`npm test`).');
  process.exit(2);
}

if (flag('--clear')) {
  rmSync(CACHE, { recursive: true, force: true });
  console.log(`cleared ${CACHE}`);
  process.exit(0);
}

/* Step selection: names or globs, in testSteps order; default all. */
const picks = argv.filter((a) => !a.startsWith('--'));
const glob = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
let steps = allSteps;
if (picks.length && !flag('--deps')) {
  const res = picks.map(glob);
  steps = allSteps.filter((s) => res.some((r) => r.test(s)));
  const unmatched = picks.filter((p) => !allSteps.some((s) => glob(p).test(s)));
  if (unmatched.length) {
    console.error(`run-tests-cached: no test step matches ${unmatched.join(', ')} (see package.json testSteps)`);
    process.exit(2);
  }
}
const missing = steps.filter((s) => !(s in scripts));
if (missing.length) {
  console.error(`run-tests-cached: testSteps names without a script: ${missing.join(', ')}`);
  process.exit(2);
}

if (flag('--deps')) {
  for (const s of picks) {
    const r = loadRecords(CACHE, s)[0];
    if (!r) { console.log(`${s}: no green record`); continue; }
    const inRepo = Object.keys(r.manifest).filter((p) => p.startsWith(ROOT + sep) && !p.includes(`${sep}node_modules${sep}`));
    console.log(`${s}: ${Object.keys(r.manifest).length} paths on record (commit ${r.commit.slice(0, 12)}${r.dirty ? '+dirty' : ''}), ${inRepo.length} in the repo outside node_modules:`);
    inRepo.sort().forEach((p) => console.log(`    ${r.manifest[p].split(':')[0].padEnd(7)} ${rel(p)}`));
    const outs = Object.keys(r.outputs || {});
    if (outs.length) { console.log('  outputs it leaves in the tree:'); outs.forEach((p) => console.log(`    ${rel(p)}`)); }
  }
  process.exit(0);
}

const classify = makeClassifier(ROOT, CACHE);
mkdirSync(CACHE, { recursive: true });
const fper = new Fingerprinter(join(CACHE, 'hash-memo.json'));
const salt = envSalt(ROOT);
const git = gitState(ROOT);
const noSkip = flag('--no-skip');
const dryRun = flag('--dry-run');
const jobs = numArg('jobs', 1);

console.log(banner());
console.log(`\ntest cache: ${steps.length} step(s), cache ${rel(CACHE)} (v${CACHE_VERSION}), ` +
  `commit ${git.commit.slice(0, 12)}${git.dirty ? ' + uncommitted changes' : ''}` +
  (noSkip ? ', --no-skip: every step runs' : '') + '\n');

/* Decide every step up front. The check for step N is made before ANY step
   runs, and re-made just before N itself runs (below) - a step earlier in
   the list may rewrite a file N reads. */
const checkStarted = performance.now();
const plan = steps.map((step) => {
  if (noSkip) return { step, hit: null, why: '--no-skip' };
  const r = lookup({ step, command: scripts[step], salt, records: loadRecords(CACHE, step), fper, classify, root: ROOT });
  return { step, ...r };
});
const checkMs = performance.now() - checkStarted;

if (dryRun) {
  const w = Math.max(...steps.map((s) => s.length));
  for (const p of plan) {
    console.log(`  ${p.hit ? 'SKIP ' : 'RUN  '} ${p.step.padEnd(w)}  ` +
      (p.hit ? `green @ ${p.hit.commit.slice(0, 12)}${p.hit.dirty ? '+dirty' : ''}, ${Object.keys(p.hit.manifest).length} deps unchanged` : p.why));
  }
  const hits = plan.filter((p) => p.hit);
  console.log(`\n${hits.length} would skip (${fmt(hits.reduce((a, p) => a + p.hit.ms, 0))} of recorded run time), ` +
    `${plan.length - hits.length} would run. Check took ${fmt(checkMs)}.`);
  console.log('\n' + banner());
  process.exit(0);
}

const results = [];
const wallStarted = Date.now();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAll('SIGKILL'); console.log(`\n${sig}: stopped; nothing further recorded`); process.exit(130); });
}

async function runOne(p, i) {
  const label = `[${i + 1}/${steps.length}] ${p.step}`;
  const command = scripts[p.step];
  /* Re-check at the last moment: an earlier step in this run may have
     changed one of this step's inputs since the plan was made. */
  const again = noSkip ? p : { ...p, ...lookup({ step: p.step, command, salt, records: loadRecords(CACHE, p.step), fper, classify, root: ROOT }) };
  if (again.hit) {
    const h = again.hit;
    console.log(`${label}  SKIP  cached green @ ${h.commit.slice(0, 12)}${h.dirty ? '+dirty' : ''} ` +
      `(${new Date(h.at).toISOString().slice(0, 16)}), ${Object.keys(h.manifest).length} deps unchanged, saves ~${fmt(h.ms)}`);
    return { step: p.step, skipped: true, ok: true, ms: 0, savedMs: h.ms };
  }
  const buffered = jobs > 1;
  let log = `\n${'='.repeat(70)}\n${label}  $ ${command}\n  rerun: ${again.why}\n${'='.repeat(70)}\n`;
  if (!buffered) process.stdout.write(log);
  const startedNs = BigInt(Date.now()) * 1_000_000n; // file ctimes are wall-clock ns
  const r = await trace(command, { cwd: ROOT, onOut: buffered ? null : (s) => process.stdout.write(s) });
  if (buffered) log += r.out;
  const ok = r.code === 0;
  let note = '';
  const m = r.access ? buildManifest(r.access, { classify, fper, startedNs, root: ROOT }) : { problems: ['no trace was captured'] };
  /* The last trace is kept whether or not it became a record, so the audit
     (tools/test-cache/audit.mjs) can see the dependencies of a step that
     failed or could not be cached, too. */
  saveTrace(CACHE, p.step, { at: Date.now(), ok, ms: r.ms, commit: git.commit, dirty: git.dirty,
    problems: m.problems, deps: m.manifest ? Object.keys(m.manifest) : [], outputs: m.outputs ? Object.keys(m.outputs) : [],
    listed: r.access ? [...r.access.listed] : [], outbound: r.access ? r.access.outbound : [] });
  if (ok) {
    if (m.problems.length) {
      note = `  NOT CACHED: ${m.problems.slice(0, 3).join('; ')}${m.problems.length > 3 ? ` (+${m.problems.length - 3} more)` : ''}`;
    } else {
      const record = {
        version: CACHE_VERSION, key: keyOf({ step: p.step, command, salt, manifest: m.manifest }),
        command, salt, commit: git.commit, dirty: git.dirty, at: Date.now(), ms: r.ms,
        manifest: m.manifest, outputs: m.outputs,
      };
      saveRecord(CACHE, p.step, record);
      note = `  recorded green: ${Object.keys(m.manifest).length} deps`;
    }
  } else {
    note = '  failed - nothing recorded';
  }
  log += `\n${label}  ${ok ? 'PASS' : 'FAIL'}  exit=${r.code}${r.signal ? ` signal=${r.signal}` : ''}  ${fmt(r.ms)}\n${note}\n`;
  process.stdout.write(buffered ? log : log.slice(log.lastIndexOf(`\n${label}  ${ok ? 'PASS' : 'FAIL'}`)));
  return { step: p.step, skipped: false, ok, ms: r.ms, code: r.code, out: r.out, notCached: note.includes('NOT CACHED') ? note.trim() : null };
}

/* A small pool. jobs=1 is the plain sequential chain, in order. */
let next = 0;
const slots = Array.from({ length: Math.min(jobs, plan.length) }, async () => {
  while (next < plan.length) {
    const i = next++;
    results[i] = await runOne(plan[i], i);
  }
});
await Promise.all(slots);
fper.save();

const wall = Date.now() - wallStarted;
const ran = results.filter((r) => !r.skipped);
const skipped = results.filter((r) => r.skipped);
const failed = ran.filter((r) => !r.ok);
const notCached = ran.filter((r) => r.notCached);
const saved = skipped.reduce((a, r) => a + r.savedMs, 0);

console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
const w = Math.max(...steps.map((s) => s.length));
results.forEach((r, i) => console.log(`  ${String(i + 1).padStart(3)}. ${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.step.padEnd(w)}  ` +
  (r.skipped ? `(cached, ~${fmt(r.savedMs)})` : fmt(r.ms))));
if (notCached.length) {
  console.log(`\nGreen but not cached (will run again next time):`);
  notCached.forEach((r) => console.log(`  ${r.step}: ${r.notCached.replace(/^NOT CACHED: /, '')}`));
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((r) => r.step).join(', ')}`);
  failed.forEach((r) => {
    const lines = (r.out || '').replace(/\s+$/, '').split('\n').slice(-20);
    console.log(`\n--- ${r.step} (exit ${r.code}) ---`);
    lines.forEach((l) => console.log('  ' + l));
  });
}
console.log(`\nran ${ran.length} (${ran.length - failed.length} passed, ${failed.length} failed), ` +
  `skipped ${skipped.length} cached-green (~${fmt(saved)} of recorded run time), wall ${fmt(wall)}, cache check ${fmt(checkMs)}`);
console.log('\n' + banner() + '\n');
process.exit(failed.length ? 1 : 0);

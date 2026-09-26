#!/usr/bin/env node
/**
 * nest-optimizer / tools / test-cache / audit.mjs
 *
 * Puts the traced dependency graph (what the cache keys on) next to the two
 * graphs a reader of the code would build (static-graph.mjs), step by step,
 * and checks the shared-code cases this project has been bitten by.
 *
 *   node tools/test-cache/audit.mjs            # table + findings
 *   node tools/test-cache/audit.mjs --md       # the same, as markdown
 *   node tools/test-cache/audit.mjs crop:test  # one step in full
 *
 * Reads the last trace of every step from the cache directory, so run
 * `node tools/run-tests-cached.mjs --no-skip` first.
 *
 * What each column means:
 *   traced    repo files (node_modules excluded) the step's processes
 *             opened, stat'd or listed on its last run - the cache's graph
 *   naive     files reachable by require()/import alone
 *   missed    traced files the naive graph does not contain. Every one of
 *             these is an edit a naive "affected tests" tool would skip over
 *   mentions  the generous static graph (every literal that names a file)
 *   unseen    mentioned statically but not touched by the run: code paths
 *             that were not taken. Safe ONLY because the choice not to take
 *             them was itself made from traced inputs - listed for review.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { cacheDir, loadTrace, loadRecords, UNTRACEABLE } from './cache.mjs';
import { staticGraphs } from './static-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CACHE = cacheDir(ROOT);
const md = process.argv.includes('--md');
const one = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rel = (p) => (p.startsWith(ROOT + sep) ? p.slice(ROOT.length + 1) : p);
const inRepo = (p) => p.startsWith(ROOT + sep) && !p.includes(`${sep}node_modules${sep}`) && !p.startsWith(join(ROOT, '.git') + sep);
const isFileDep = (p) => /\.[A-Za-z0-9]{1,6}$/.test(p);

const rows = [];
for (const step of pkg.testSteps) {
  const t = loadTrace(CACHE, step);
  const rec = loadRecords(CACHE, step)[0];
  const g = staticGraphs(ROOT, pkg.scripts[step]);
  if (!t) { rows.push({ step, missing: true, g }); continue; }
  const traced = new Set(t.deps.filter((p) => inRepo(p) && isFileDep(p)));
  const missed = [...traced].filter((p) => !g.imports.has(p));
  const unseen = [...g.mentions].filter((p) => !traced.has(p) && inRepo(p));
  rows.push({ step, t, rec, g, traced, missed, unseen });
}

const out = [];
const say = (s = '') => out.push(s);

if (one.length) {
  for (const r of rows.filter((x) => one.includes(x.step))) {
    say(`${r.step}   $ ${pkg.scripts[r.step]}`);
    if (r.missing) { say('  no trace on record - run it through tools/run-tests-cached.mjs first'); continue; }
    say(`  last run ${new Date(r.t.at).toISOString()} ${r.t.ok ? 'green' : 'RED'}, ${r.rec ? 'cached' : 'NOT cached'}`);
    r.t.problems.forEach((p) => say(`  not cacheable: ${p}`));
    say(`  traced repo files (${r.traced.size}):`);
    [...r.traced].sort().forEach((p) => say(`    ${r.g.imports.has(p) ? 'import ' : r.g.mentions.has(p) ? 'mention' : 'TRACE  '} ${rel(p)}`));
    say(`  statically mentioned, not touched on this run (${r.unseen.length}):`);
    r.unseen.sort().forEach((p) => say(`    ${rel(p)}`));
    if (r.t.outputs.length) { say('  outputs left in the tree:'); r.t.outputs.forEach((p) => say(`    ${rel(p)}`)); }
    if (r.t.listed.length) { say('  directories whose listing is an input:'); r.t.listed.filter(inRepo).forEach((p) => say(`    ${rel(p)}/`)); }
  }
  console.log(out.join('\n'));
  process.exit(0);
}

/* ---- the whole suite ---- */
const have = rows.filter((r) => !r.missing);
const w = Math.max(...rows.map((r) => r.step.length));
say(md ? '| step | traced | naive | missed by naive | mentions | unseen | cached |\n|---|---:|---:|---:|---:|---:|---|' :
  `${'step'.padEnd(w)}  traced  naive  missed  mentions  unseen  cached`);
for (const r of rows) {
  if (r.missing) { say(md ? `| ${r.step} | - | ${r.g.imports.size} | - | ${r.g.mentions.size} | - | no trace |` : `${r.step.padEnd(w)}  (no trace)`); continue; }
  const cached = r.rec ? 'yes' : UNTRACEABLE[r.step] ? 'NO: untraceable' : r.t.ok ? 'NO: ' + (r.t.problems[0] || '').slice(0, 60) : 'red';
  say(md ? `| ${r.step} | ${r.traced.size} | ${r.g.imports.size} | ${r.missed.length} | ${r.g.mentions.size} | ${r.unseen.length} | ${cached} |`
    : `${r.step.padEnd(w)}  ${String(r.traced.size).padStart(6)}  ${String(r.g.imports.size).padStart(5)}  ${String(r.missed.length).padStart(6)}  ${String(r.g.mentions.size).padStart(8)}  ${String(r.unseen.length).padStart(6)}  ${cached}`);
}

say();
const tot = (f) => have.reduce((a, r) => a + f(r), 0);
say(`${have.length}/${rows.length} steps traced. Naive import graphs miss ${tot((r) => r.missed.length)} of ${tot((r) => r.traced.size)} ` +
  `traced step->file edges (${have.filter((r) => r.missed.length).length} steps affected).`);

/* ---- the cases that have bitten this project ---- */
const readers = (f) => have.filter((r) => r.traced.has(join(ROOT, f))).map((r) => r.step);
const naiveReaders = (f) => have.filter((r) => r.g.imports.has(join(ROOT, f))).map((r) => r.step);
const CASES = [
  ['app-cut.js', 'Cut\'s cap logic (rawFlatCapLoop / rawCutOpen), which Crop calls by global name', ['crop:test', 'wire:crop', 'crop:move', 'wire:crop-move']],
  ['app-crop.js', 'Crop\'s seal (NSO_cropSeal), which Detach calls by global name to splice the hull at the wall\'s steps', ['crop:test', 'wire:crop', 'detach:test', 'wire:detach']],
  ['app-join.js', 'setStatus(), defined in app-join.js and called from ~40 app files; measure and cth:capture both assert on #status', ['measure:test', 'cth:capture']],
  ['NSO_Repair.js', 'NSO_Repair\'s checker, shared by Seal/Repair, the defect overlay and every drive check', ['wire:repair', 'defects:test']],
];
say();
say(md ? '### Known shared-code cases' : 'KNOWN SHARED-CODE CASES');
for (const [f, what, must] of CASES) {
  const rs = readers(f), nv = naiveReaders(f);
  const lost = must.filter((s) => have.some((r) => r.step === s) && !rs.includes(s));
  say(`${md ? '- ' : ''}${f} - ${what}`);
  say(`${md ? '  ' : '    '}traced by ${rs.length} steps; a naive import graph finds ${nv.length}${nv.length ? ` (${nv.join(', ')})` : ''}.`);
  say(`${md ? '  ' : '    '}must include ${must.join(', ')}: ${lost.length ? 'MISSING ' + lost.join(', ') : 'yes'}`);
}

/* ---- cross-step data flow: a step reading what another step writes ---- */
const writers = new Map();
for (const r of have) for (const o of r.t.outputs) (writers.get(o) || writers.set(o, []).get(o)).push(r.step);
const flows = [];
for (const r of have) for (const d of r.t.deps) if (writers.has(d) && !writers.get(d).includes(r.step)) flows.push(`${writers.get(d).join('/')} -> ${rel(d)} -> ${r.step}`);
say();
say(md ? '### Files one step writes and another reads' : 'FILES ONE STEP WRITES AND ANOTHER READS');
say(flows.length ? flows.map((f) => (md ? '- ' : '    ') + f).join('\n') : (md ? '- none' : '    none'));

/* ---- the one listing the cache ignores: the temp dir root ---- */
{
  const offenders = [];
  const scan = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
      if (!/\.(m?js|py|sh)$/.test(e.name)) continue;
      const s = readFileSync(p, 'utf8');
      if (/readdir(Sync)?\(\s*(os\.)?tmpdir\(\)|readdir(Sync)?\(\s*['"]\/tmp['"]|listdir\(\s*(tempfile\.gettempdir\(\)|['"]\/tmp['"])|glob\(\s*['"]\/tmp\//.test(s)) offenders.push(rel(p));
    }
  };
  scan(join(ROOT, 'tools'));
  say();
  say(md ? '### Temp-dir listing' : 'TEMP-DIR LISTING');
  say(`${md ? '- ' : '    '}${offenders.length ? 'FAIL: these list the temp dir itself, whose listing the cache ignores: ' + offenders.join(', ') : 'no test lists the temp dir itself (the one listing the cache does not key on)'}`);
  if (offenders.length) process.exitCode = 1;
}

/* ---- what could not be cached, and why ---- */
const notCached = have.filter((r) => !r.rec);
say();
say(md ? '### Not cached (always rerun)' : 'NOT CACHED (ALWAYS RERUN)');
if (!notCached.length) say(md ? '- none' : '    none');
for (const r of notCached) say(`${md ? '- ' : '    '}${r.step}: ${UNTRACEABLE[r.step] ? 'always run untraced - ' + UNTRACEABLE[r.step] : r.t.ok ? r.t.problems.join('; ').slice(0, 300) : 'last traced run was red'}`);
console.log(out.join('\n'));

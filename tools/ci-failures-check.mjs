#!/usr/bin/env node
/* The failure report (tools/run-tests.mjs --failures-out) names the step that
   failed and its failing lines, and no step that passed.
     node tools/ci-failures-check.mjs       exit 0 = every gate held

   Runs the runner on a throwaway list (--package) of two steps: one that
   fails, with two failing lines early on and a hundred lines of noise after
   them, and one that passes. Then a third list whose only step is cut off by
   SIGTERM, which is what a job step's timeout does to the runner. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-tests.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ci-failures-'));
let fails = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) fails++;
};

const js = (code) => `node -e ${JSON.stringify(code)}`;
const failing = js(
  "console.log('not ok 1 - early one'); console.log('FAILED: early two');" +
  "for (let i = 1; i <= 100; i++) console.log('noise-' + String(i).padStart(3, '0'));" +
  "console.log('not ok 2 - widget wobbles'); process.exit(1)");
const passing = js("console.log('ok 1 - all fine'); console.log('ok 2 - still fine')");

function run(list, extra = []) {
  const pkgFile = join(dir, 'list.json');
  const out = join(dir, 'failures.txt');
  writeFileSync(pkgFile, JSON.stringify(list));
  const r = spawnSync(process.execPath, [RUNNER, '--package', pkgFile, '--failures-out', out, ...extra], { encoding: 'utf8' });
  return { r, file: existsSync(out) ? readFileSync(out, 'utf8') : null };
}

console.log('a failing step and a passing one');
{
  const { r, file } = run({ scripts: { 'fail-step': failing, 'pass-step': passing }, testSteps: ['fail-step', 'pass-step'] });
  check('the runner exits non-zero', r.status === 1, `exit ${r.status}`);
  check('the file exists', file !== null);
  const f = file || '';
  check('it names the failing step in a delimited block', f.includes('=== FAILED: fail-step (shard 1) ===') && f.includes('=== end fail-step ==='), f.slice(0, 200));
  check('it gives the command and the exit code', f.includes('command: npm run fail-step') && /result:\s+exit code 1/.test(f));
  check('it has the failing line', f.includes('not ok 2 - widget wobbles'));
  check('it has every failing line, also those before the last 40', f.includes('not ok 1 - early one') && f.includes('FAILED: early two'));
  check('it has the last 40 lines and not the lines before them', f.includes('noise-100') && f.includes('noise-062') && !f.includes('noise-050'));
  check('it does not name the passing step', !f.includes('pass-step'));
  check('it does not hold the passing step\'s output', !f.includes('ok 1 - all fine'));
  check('the log has the block, printed before the summary', r.stdout.indexOf('=== FAILED: fail-step (shard 1) ===') > -1
    && r.stdout.indexOf('=== FAILED: fail-step (shard 1) ===') < r.stdout.indexOf('SUMMARY'));
  check('the log has the ::error annotation: escaped title, first failing line', r.stdout.includes('::error title=shard 1%3A fail-step failed::not ok 1 - early one'), (r.stdout.match(/::error.*/) || ['no ::error line'])[0]);
  check('the steps after the failure still ran', /pass-step\s+exit=\s*0/.test(r.stdout));
}

console.log('a passing list');
{
  const { r, file } = run({ scripts: { 'pass-step': passing }, testSteps: ['pass-step'] });
  check('exits 0 and leaves the file empty', r.status === 0 && file === '', `exit ${r.status}, file ${JSON.stringify(file)}`);
  check('prints no block and no ::error', !r.stdout.includes('=== FAILED') && !r.stdout.includes('::error'));
}

console.log('a step cut off by SIGTERM');
{
  const pkgFile = join(dir, 'slow.json');
  const out = join(dir, 'slow-failures.txt');
  writeFileSync(pkgFile, JSON.stringify({ scripts: { 'slow-step': js("console.log('not ok 1 - got this far'); setTimeout(() => {}, 60000)") }, testSteps: ['slow-step'] }));
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, '--package', pkgFile, '--failures-out', out], { stdio: ['ignore', 'pipe', 'inherit'] });
    let seen = false;
    child.stdout.on('data', (d) => { if (!seen && /^not ok 1 - got this far/m.test(d.toString())) { seen = true; child.kill('SIGTERM'); } });
    const guard = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 20000);
    child.on('close', (c) => { clearTimeout(guard); resolve(c); });
  });
  const f = existsSync(out) ? readFileSync(out, 'utf8') : '';
  check('the runner exits 143', code === 143, `exit ${code}`);
  check('the cut-off step is named, with why', f.includes('=== FAILED: slow-step (shard 1) ===') && /result:\s+stopped by SIGTERM/.test(f), f.slice(0, 200));
  check('and its failing line', f.includes('not ok 1 - got this far'));
}

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);

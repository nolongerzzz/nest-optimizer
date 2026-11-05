#!/usr/bin/env node
/* The "npm test" job can merge the shards' step times: in a directory holding
   only the files its sparse checkout takes, `run-tests.mjs --merge-timing` exits
   0 and writes timing.csv.
     node tools/ci-timing-merge-check.mjs       exit 0 = it does

   WHY. The job checks out package.json and tools/run-tests.mjs and nothing else.
   deff6aa made the runner import tools/migrate-test-weights.mjs and read
   tools/test-weights.json; in that checkout it died with ERR_MODULE_NOT_FOUND.
   The merge step is continue-on-error, so the "timing" artifact stopped coming
   out and nothing said so. This reads the list out of
   .github/workflows/test.yml, copies exactly those files into a temp
   directory, and runs the merge there. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) fails++;
};

/* The lines of the `sparse-checkout: |` block: the ones indented deeper than the key. */
function sparseList(yml) {
  const lines = yml.split('\n');
  const at = lines.map((l, i) => (/^\s*sparse-checkout:\s*\|\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) return { error: `expected one "sparse-checkout: |" block in test.yml, found ${at.length}` };
  const indent = (l) => l.length - l.trimStart().length;
  const keyIndent = indent(lines[at[0]]);
  const list = [];
  for (let i = at[0] + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indent(lines[i]) <= keyIndent) break;
    list.push(lines[i].trim());
  }
  return { list };
}

console.log('the "npm test" job\'s sparse checkout');
const { list, error } = sparseList(readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8'));
check('the list can be read out of test.yml', !error && list.length > 0, error);

if (list && list.length) {
  const missing = list.filter((f) => !existsSync(join(ROOT, f)));
  check('every file it names exists', missing.length === 0, `no such file: ${missing.join(', ')}`);

  const dir = mkdtempSync(join(tmpdir(), 'ci-timing-merge-'));
  try {
    for (const f of list.filter((x) => !missing.includes(x))) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(dir, f));
    }
    mkdirSync(join(dir, 'timing'));
    writeFileSync(join(dir, 'timing', 'shard-1.csv'), 'step,shard,seconds,result\npage:manifest,1/20,1.500,pass\n');
    const r = spawnSync(process.execPath, ['tools/run-tests.mjs', '--merge-timing', 'timing', '--out', 'timing.csv', '--shards', '20'],
      { cwd: dir, encoding: 'utf8' });
    check('--merge-timing exits 0 there', r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).split('\n').find((l) => /Error|error/.test(l)) || ''}`);
    const csv = existsSync(join(dir, 'timing.csv')) ? readFileSync(join(dir, 'timing.csv'), 'utf8') : null;
    check('it writes timing.csv', csv !== null);
    check('with the header and the shard\'s row', !!csv && csv.startsWith('step,shard,seconds,result\n') && csv.includes('page:manifest,1/20,1.500,pass'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);

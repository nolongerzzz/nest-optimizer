/* tools/test-weights-check.cjs - does tools/test-weights.json agree with package.json?
 *
 * One rule, read by `node tools/run-tests.mjs --check` and by page:manifest, so
 * the two cannot drift. "A step" is a name in package.json "testSteps" or
 * "driveSteps" (the steps that launch a browser): the table is per step, for
 * both lists, and the ~40 other scripts (helpers, one-off drives) are not
 * steps and need no entry.
 *
 *   - every step has an entry          (an absent one is packed at the median, which is
 *                                       how rotate:handles ran 60x its declared time)
 *   - every step is in ONE list        (a name in both runs twice; the two lists are a partition)
 *   - every entry names a script       (a renamed or deleted script leaves its weight behind)
 *   - every entry is in a list         (a weight for a script nothing runs)
 *   - every weight is a positive number
 *
 * problems(pkg, table) -> [string]; empty means the table and the scripts agree. */
'use strict';

function problems(pkg, table) {
  const out = [];
  const scripts = pkg.scripts || {};
  const tests = Array.isArray(pkg.testSteps) ? pkg.testSteps : [];
  const drives = Array.isArray(pkg.driveSteps) ? pkg.driveSteps : [];
  const steps = [...tests, ...drives];
  const entries = (table && table.steps) || {};
  if (!table || typeof table.steps !== 'object' || Array.isArray(table.steps)) {
    return ['tools/test-weights.json has no "steps" object'];
  }
  for (const s of steps) {
    if (!(s in entries)) out.push(`step "${s}" has no entry in tools/test-weights.json`);
  }
  for (const s of drives) {
    if (tests.includes(s)) out.push(`step "${s}" is in both testSteps and driveSteps`);
  }
  for (const [name, e] of Object.entries(entries)) {
    if (!(name in scripts)) out.push(`entry "${name}" has no script in package.json`);
    else if (!steps.includes(name)) out.push(`entry "${name}" is a script but not in testSteps or driveSteps`);
    if (!e || typeof e.weight !== 'number' || !(e.weight > 0)) out.push(`entry "${name}" has no positive "weight"`);
    if (!e || typeof e.note !== 'string') out.push(`entry "${name}" has no "note" string`);
  }
  return out;
}

module.exports = { problems };

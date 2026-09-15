#!/usr/bin/env node
/* Paint-scope declarations — are they actually there?

   docs/HANDOFF.md carries two rules about paint:

     1. a painted / excluded face stays untouched by ANY bake mechanism;
     2. HOW a feature checks paint depends on its operating shape -
        WHOLE-PIECE features stand down on any paint at all, SUB-REGION
        features check only their own relevant faces - and every paint-aware
        feature must STATE its category in its own documentation, so the next
        ticket reads it instead of re-deriving it.

   Rule 2 is the kind that rots silently: a comment gets reflowed, a file gets
   rewritten, and six weeks later someone "fixes" the sub-region feature to
   match the whole-piece ones because nothing said the difference was on
   purpose. This suite is cheap insurance against that. It does not test
   geometry and it launches no browser - it reads source and asserts each
   roster entry still carries its label, near the code that implements it.

   Run: node tools/nso_paint_scope_test.js */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const FAILS = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

/* The roster, as docs/HANDOFF.md states it. Adding a paint-aware feature means
   adding a row here as well as a label in its source - that is the point. */
const ROSTER = [
  { feature: 'Smooth',         file: 'app-sculpt.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Smooth stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Repair',         file: 'app-finish.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Repair stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Fusion',         file: 'app-join.js',            scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*modelA\s*\)/,                standDown: /painted face\(s\) - fusion has no skip list/ },
  { feature: 'Pocket corners', file: 'nso_inside_corners.js',  scope: 'SUB-REGION',
    test: /NSO_insidePaintCheck/,                           standDown: /Pocket corners stood down - ' \+ [\w.]+ \+ ' painted face\(s\)/ },
];

console.log('== every paint-aware feature declares its scope in its own source ==');
for (const r of ROSTER) {
  const src = read(r.file);
  const label = new RegExp('PAINT SCOPE:\\s*' + r.scope.replace('-', '[- ]'));
  check(r.feature + ' (' + r.file + ') declares PAINT SCOPE: ' + r.scope, label.test(src));
  check('  ...and points at the rule in HANDOFF',
        /PAINT SCOPE:[\s\S]{0,700}?docs\/HANDOFF\.md/.test(src));
  check('  ...and still runs the paint test the roster claims', r.test.test(src),
        '(' + r.test.source.slice(0, 40) + ')');
  check('  ...and still carries its stand-down wording', r.standDown.test(src));
}

console.log('\n== the rule itself is written down where the roster says ==');
{
  const h = read('docs/HANDOFF.md');
  check('HANDOFF carries the scoping rule', /###\s*Scoping — which faces a feature checks/.test(h));
  check('HANDOFF names both categories',
        /\*\*Whole-piece\*\*/.test(h) && /\*\*Sub-region\*\*/.test(h));
  check('HANDOFF says they are not exceptions to each other',
        /not\s*\n?\*\*not\*\*|\*\*not\*\*\s*\n?inconsistent exceptions|not\s+inconsistent exceptions/i.test(h));
  check('HANDOFF requires a feature to state its category',
        /state its category explicitly in its own\s*\n?documentation/i.test(h));
  for (const r of ROSTER)
    check('HANDOFF roster lists ' + r.feature,
          new RegExp('\\|\\s*' + r.feature + '[^|]*\\|\\s*' + r.scope.toLowerCase() + '\\s*\\|', 'i').test(h));
}

console.log('\n== the sub-region feature documents WHICH faces it scopes to ==');
{
  const d = read('docs/INSIDE-CORNERS.md');
  check('INSIDE-CORNERS declares the sub-region category', /PAINT SCOPE:\s*sub[- ]region/i.test(d));
  check('  ...and lists what does and does not stand it down',
        /this pocket's floor/.test(d) && /a \*different\* pocket/.test(d) && /any hull face/.test(d));
  check('  ...and says the two categories are one rule, not an exception',
        /not\*\* a laxer reading|same rule applied at a different scope/i.test(d));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);

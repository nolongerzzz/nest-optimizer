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
  { feature: 'Extend',         file: 'app-extend.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Extend stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Bend',           file: 'app-bend.js',            scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Bend stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Mirror',         file: 'app-mirror.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Mirror stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Fatten',         file: 'app-fatten.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Fatten stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Pottery Wheel',  file: 'app-wheel.js',           scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Pottery Wheel stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Repair',         file: 'app-finish.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Repair stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Thicken',        file: 'app-finish.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Thicken stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Fusion',         file: 'app-join.js',            scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*modelA\s*\)/,                standDown: /painted face\(s\) - fusion has no skip list/ },
  { feature: 'Pocket corners', file: 'nso_inside_corners.js',  scope: 'SUB-REGION',
    test: /NSO_insidePaintCheck/,                           standDown: /Pocket corners stood down - ' \+ [\w.]+ \+ ' painted face\(s\)/ },
  { feature: 'Skin face',      file: 'app-skin.js',            scope: 'SUB-REGION',
    test: /nsoMaskIsExcludedRaw\s*\(\s*m\s*,\s*face\.n\s*,\s*face\.d/, standDown: /Skin stood down - ' \+ \w+ \+ ' is painted/ },
  { feature: 'Delete painted', file: 'app-paint-delete.js',    scope: 'SUB-REGION',
    test: /nsoMaskIsExcludedRaw\s*\(\s*m\s*,\s*face\.n\s*,\s*face\.d/, standDown: /Delete stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Scale',          file: 'app-scale.js',           scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Scale stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Texture',        file: 'app-texture.js',         scope: 'SUB-REGION',
    test: /nsoMaskIsExcludedRaw\s*\(\s*m\s*,\s*face\.n\s*,\s*face\.d/, standDown: /Texture stood down - ' \+ \w+ \+ ' painted facet\(s\)/ },
  { feature: 'Seat here',      file: 'app-seat-surface.js',    scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*modelB\s*\)/,                standDown: /Seat here stood down - ' \+ \w+ \+ ' painted face\(s\) on B/ },
  { feature: 'Brush',          file: 'app-brush.js',           scope: 'SUB-REGION',
    test: /NSO_brushPaintCheck/,                            standDown: /Brush stood down - ' \+ [\w.]+ \+ ' painted face\(s\)/ },
  { feature: 'Attach',         file: 'app-assemble.js',        scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Attach stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Detach',         file: 'app-detach.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Detach stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Reattach',       file: 'app-detach.js',          scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Reattach stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Stock update',   file: 'app-stock.js',           scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Stock stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  { feature: 'Lift',           file: 'app-gscope-lift.js',     scope: 'WHOLE-PIECE',
    test: /nsoMaskCount\s*\(\s*m\s*\)/,                     standDown: /Lift stood down - ' \+ \w+ \+ ' painted face\(s\)/ },
  /* The marker scan only: generation adds a piece and edits none, and a
     support is removed or replaced whole. See docs/GCODE-SUPPORTS.md. */
  { feature: 'G-scope supports', file: 'app-gscope-support.js', scope: 'SUB-REGION',
    test: /nsoMaskFaceList\(m\)/,                             standDown: /is painted and turned: its painted faces are/ },
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

console.log('\n== the destructive tool reads the SELECT list, never the EXCLUDE list ==');
{
  const d = read('docs/PAINT-DELETE.md');
  const src = read('app-paint-delete.js');
  const h = read('docs/HANDOFF.md');
  check('PAINT-DELETE declares the sub-region category', /PAINT SCOPE:\s*SUB-REGION/i.test(d));
  check('  ...and says the operand is the SELECT list, not the exclude list',
        /faceMask\.select/.test(d) && /exclude list cannot be the operand/i.test(d));
  check('  ...and lists what does and does not stand it down',
        /the \*\*target face\*\* painted excluded/.test(d) && /\*\*any other face\*\*/.test(d));
  check('  ...and says the two categories are one rule, not an exception',
        /not\*\* a laxer reading|same rule as Smooth's whole-piece stand-down applied at a different\s*\n?scope/i.test(d));
  check('the delete reads nsoMaskSelected for its operand', /nsoMaskSelected\s*\(\s*m\s*\)/.test(src));
  check('  ...and never treats the exclude list as one',
        !/nsoMaskFaceList|faceMask\.exclude/.test(src));
  check('HANDOFF spells the operand/veto split out for the next ticket',
        /### The SELECT list is an operand; the EXCLUDE list is still only a veto/.test(h));
}

console.log('\n== the curved-band feature documents WHICH facets it scopes to ==');
{
  const d = read('docs/CURVED-SKIN.md');
  check('CURVED-SKIN declares the sub-region category', /PAINT SCOPE:\s*SUB-REGION/i.test(d));
  check('  ...and lists what does and does not stand it down',
        /any facet of the curved side/i.test(d) && /either cap/i.test(d));
  check('  ...and says the two categories are one rule, not an exception',
        /not\*\* a laxer reading/i.test(d));
  check('  ...and keeps Seat against a curved contact out of scope',
        /Seat against a curved contact is a separate ticket/.test(d));
}

console.log('\n== each sub-region feature documents WHICH faces it scopes to ==');
{
  const d = read('docs/INSIDE-CORNERS.md');
  check('INSIDE-CORNERS declares the sub-region category', /PAINT SCOPE:\s*sub[- ]region/i.test(d));
  check('  ...and lists what does and does not stand it down',
        /this pocket's floor/.test(d) && /a \*different\* pocket/.test(d) && /any hull face/.test(d));
  check('  ...and says the two categories are one rule, not an exception',
        /not\*\* a laxer reading|same rule applied at a different scope/i.test(d));
}
{
  const d = read('docs/BRUSH.md');
  check('BRUSH declares the sub-region category', /PAINT SCOPE:\s*sub[- ]region/i.test(d));
  check('  ...and lists what does and does not stand it down',
        /the faces the stroke lands on/i.test(d) && /paint on any other face/i.test(d));
  check('  ...and says the seam band counts as part of the affected set',
        /seam band/i.test(d) && /affected set/i.test(d));
  check('  ...and says the two categories are one rule, not an exception',
        /not\*\* a laxer reading|same rule applied at a different scope/i.test(d));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);

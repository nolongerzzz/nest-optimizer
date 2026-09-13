/* The CTH card's "all aims recorded" state.

   The card used to show one aim at a time and paint over the previous one, so
   at the end of a batch the only result still on screen was the last aim's.
   buildAimSummary is the pure half of the fix - it turns the aims the overlay
   was already tracking into the rows the card renders - so it can be checked
   here with no DOM.

   Run: node tools/cth-test/overlay-summary.test.mjs */
import { buildAimSummary, escapeHtml } from '../../cth/overlay.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
const count = (h, needle) => h.split(needle).length - 1;

/* The live batch: the four aims of nest-finish-first-batch.js, as the overlay
   holds them once recordResult has written each one. */
const aims = [
  { id: 'paint-hull',   title: 'Paint - outer hull face', status: 'pass',
    detail: 'got <b>CTH_fixture/hull</b> · wanted <b>box_hull,CTH_fixture/hull</b>' },
  { id: 'paint-pocket', title: 'Paint - pocket floor', status: 'pass',
    detail: 'got <b>CTH_fixture/pocket</b> · wanted <b>box_hull,CTH_fixture/pocket</b>' },
  { id: 'soften-mouth', title: 'Soften - near mouth', status: 'fail',
    detail: 'got <b>CTH_fixture/pocket</b> · wanted <b>box_hull,CTH_fixture/hull</b>' },
  { id: 'soften-pocket', title: 'Soften - pocket floor again', status: 'pass',
    detail: 'got <b>CTH_fixture/pocket</b> · wanted <b>box_hull,CTH_fixture/pocket</b>' },
];

console.log('\nfour aims recorded, one of them a fail');
const s = buildAimSummary(aims);
ok('counts every aim', s.total === 4, 's.total=' + s.total);
ok('counts the passes', s.passed === 3, 's.passed=' + s.passed);
ok('allPass is false when one failed', s.allPass === false);
ok('renders one row per aim, not just the last',
   count(s.html, 'class="sum-row"') === 4, count(s.html, 'class="sum-row"') + ' rows');
for (const a of aims) {
  ok('  lists ' + a.id, s.html.includes(escapeHtml(a.title)));
  ok('  carries its got/wanted line', s.html.includes(a.detail));
}
ok('marks the failing aim FAIL', count(s.html, '>FAIL<') === 1);
ok('marks the passing aims PASS', count(s.html, '>PASS<') === 3);
ok('aim 4 is no longer the only thing on the card',
   s.html.indexOf('Paint - outer hull face') < s.html.indexOf('Soften - pocket floor again'));

console.log('\na clean sweep');
const clean = buildAimSummary(aims.map((a) => ({ ...a, status: 'pass' })));
ok('allPass is true', clean.allPass === true);
ok('passed === total', clean.passed === 4 && clean.total === 4);
ok('no FAIL mark', count(clean.html, '>FAIL<') === 0);

console.log('\nedges');
const partial = buildAimSummary([
  { id: 'a', title: 'recorded', status: 'pass', detail: 'got <b>x</b>' },
  { id: 'b', title: 'never armed', status: 'pending', instruction: 'Click the far wall.' },
]);
ok('an unrecorded aim still gets a row', count(partial.html, 'class="sum-row"') === 2);
ok('an unrecorded aim reads NOT RECORDED, not PASS',
   partial.html.includes('>NOT RECORDED<') && count(partial.html, '>PASS<') === 1);
ok('it falls back to its instruction', partial.html.includes('Click the far wall.'));
ok('allPass is false while one is unrecorded', partial.allPass === false);

const empty = buildAimSummary([]);
ok('no aims: empty html, allPass false',
   empty.total === 0 && empty.html === '' && empty.allPass === false);
ok('undefined is tolerated', buildAimSummary().total === 0);

/* escapeHtml used to map & < > " to themselves, so only the apostrophe was
   escaped. Aim detail carries a catalog name taken from the user's own STL
   filename and goes into innerHTML. */
console.log('\nescaping');
ok('escapes &', escapeHtml('a & b') === 'a &amp; b', escapeHtml('a & b'));
ok('escapes <', escapeHtml('<img>') === '&lt;img&gt;', escapeHtml('<img>'));
ok('escapes "', escapeHtml('say "hi"') === 'say &quot;hi&quot;', escapeHtml('say "hi"'));
ok("escapes '", escapeHtml("it's") === 'it&#39;s', escapeHtml("it's"));
ok('leaves plain text alone', escapeHtml('box_hull/hull') === 'box_hull/hull');

const nasty = buildAimSummary([
  { id: 'x', title: '<script>alert(1)</script>', status: 'pass', detail: '' },
]);
ok('a title cannot open a tag in the card',
   !nasty.html.includes('<script>') && nasty.html.includes('&lt;script&gt;'));
const nastyInstr = buildAimSummary([
  { id: 'y', title: 'ok', status: 'pending', instruction: '<b>not bold</b>' },
]);
ok('an instruction cannot either',
   !nastyInstr.html.includes('<b>not bold</b>') && nastyInstr.html.includes('&lt;b&gt;'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

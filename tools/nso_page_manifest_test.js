#!/usr/bin/env node
/* The page's load list and the test list, each with nothing in it twice.
   No browser: reads two files and exits.
     node tools/nso_page_manifest_test.js       exit 0 = every gate held

   WHY. #142, #144 and #145 each bumped the ?v= tag on the same line,
   <script src="app-core.js?v=...">. Git saw three different edits to one
   line in three merges, kept all three, and index.html loaded app-core.js
   three times. The second load throws "Identifier 'PLATES' has already been
   declared", so the app never starts and every drive check in the suite
   fails without pointing at the cause. Each merge was clean, so no conflict
   flagged it.

   GATES
     1. index.html: no <script src> or <link href> target appears twice once
        its ?v= part is ignored. Tags inside <!-- --> comments don't count,
        since the browser never loads them.
     2. package.json parses as JSON.
     3. package.json "testSteps": no step listed twice.
     4. index.html: the Stock card is tiles only - a row of shape buttons,
        each carrying a data-shape and one canvas, and nothing else: no
        input, select, textarea, label, output, picture or line of text, and
        no button that is not a tile. Stock is a shelf; its sizing is the
        Scale card's.
   Each gate is run on a known-bad sample first, so a checker that has gone
   blind fails here instead of passing. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Every script src and link href in the page, with its 1-based line number.
   Comments are blanked out first, keeping their newlines, so line numbers
   still match the file. */
function loadTargets(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  const tagRe = /<(script|link)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(live))) {
    const attr = m[1].toLowerCase() === 'script' ? 'src' : 'href';
    const a = new RegExp('\\b' + attr + '\\s*=\\s*["\']([^"\']*)["\']', 'i').exec(m[0]);
    if (!a) continue;
    const raw = a[1];
    const target = raw.replace(/[?&]v=[^&#]*/, '').replace(/\?$/, '').replace(/^\.\//, '');
    const line = live.slice(0, m.index).split('\n').length;
    out.push({ line, raw, target });
  }
  return out;
}

// Each repeated target -> every line it's on.
function duplicateTargets(html) {
  const byTarget = new Map();
  for (const t of loadTargets(html)) {
    if (!byTarget.has(t.target)) byTarget.set(t.target, []);
    byTarget.get(t.target).push(t);
  }
  return [...byTarget.entries()].filter(([, ts]) => ts.length > 1);
}

function repeatedSteps(steps) {
  const first = new Map();
  const reps = [];
  steps.forEach((s, i) => {
    if (first.has(s)) reps.push({ step: s, first: first.get(s), again: i });
    else first.set(s, i);
  });
  return reps;
}

/* The Stock card's markup: the <details> that opens it, up to its own close.
   It holds no nested <details>, so the first </details> after it ends it.
   Comments are blanked first, so a comment cannot hide a field (or be one). */
function stockCard(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const a = live.search(/<details\b[^>]*\bvp-stock-menu\b[^>]*>/i);
  if (a < 0) return null;
  const b = live.indexOf('</details>', a);
  return b < 0 ? null : live.slice(a, b + '</details>'.length);
}

/* What is wrong with a Stock card, one reason each; an empty list is a card
   that is tiles only. */
function stockCardFaults(card) {
  if (card == null) return ['no Stock card found'];
  const faults = [];
  const body = card.replace(/^<details\b[^>]*>\s*<summary>[\s\S]*?<\/summary>/i, '');
  const banned = body.match(/<(input|select|textarea|label|output|img|p|span|a|option|fieldset)\b/gi) || [];
  for (const t of banned) faults.push('a ' + t.slice(1) + ' on the card');
  const buttons = body.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) || [];
  if (!buttons.length) faults.push('no tiles');
  const shapes = [];
  for (const b of buttons) {
    const open = b.match(/<button\b[^>]*>/i)[0];
    const shape = (open.match(/\bdata-shape="([a-z]+)"/) || [])[1];
    const label = (open.match(/\bid="([^"]*)"/) || [])[1] || open;
    if (!shape) faults.push(label + ' is a button with no data-shape - not a tile');
    else shapes.push(shape);
    if (!/\bclass="[^"]*\bstock-tile\b/.test(open)) faults.push(label + ' is not a .stock-tile');
    if ((b.match(/<canvas\b/gi) || []).length !== 1) faults.push(label + ' does not hold exactly one canvas');
    const inner = b.replace(/<button\b[^>]*>/i, '').replace(/<\/button>$/i, '').replace(/<canvas\b[^>]*><\/canvas>/gi, '');
    if (inner.trim()) faults.push(label + ' has more in it than its canvas: ' + inner.trim().slice(0, 30));
  }
  if (new Set(shapes).size !== shapes.length) faults.push('a shape has two tiles');
  // Anything else that is text: the card minus its tags is empty.
  const loose = body.replace(/<button\b[\s\S]*?<\/button>/gi, '').replace(/<[^>]*>/g, '').trim();
  if (loose) faults.push('loose text on the card: "' + loose.slice(0, 30) + '"');
  return faults;
}

// --- the checkers themselves, on known-bad and known-good samples ---------
console.log('checker self-test');
{
  const bad = [
    '<link rel="stylesheet" href="styles.css?v=a" />',
    '<script src="app-core.js?v=box2"></script>',
    '<!-- <script src="app-cut.js?v=old"></script> -->',
    '<script src="app-cut.js?v=new"></script>',
    '<script src="app-core.js?v=pan2"></script>',
    '<link rel="stylesheet" href="./styles.css" />',
  ].join('\n');
  const d = duplicateTargets(bad);
  const core = d.find(([t]) => t === 'app-core.js');
  const css = d.find(([t]) => t === 'styles.css');
  check('two app-core.js tags with different ?v= are caught',
    !!core && core[1].map((t) => t.line).join(',') === '2,5', core && core[1].map((t) => t.line).join(','));
  check('a ./ prefix and a missing ?v= still count as the same link',
    !!css && css[1].length === 2);
  check('a tag inside a comment is not counted', !d.some(([t]) => t === 'app-cut.js'));
  check('a clean list reports nothing',
    duplicateTargets('<script src="a.js?v=1"></script>\n<script src="b.js?v=1"></script>').length === 0);
  const reps = repeatedSteps(['a', 'b', 'a', 'c', 'b']);
  check('a repeated test step is caught', reps.length === 2 && reps[0].step === 'a' && reps[0].again === 2);

  const tile = (sh) => '<button id="btn-stock-' + sh + '" class="stock-tile" type="button" data-shape="' + sh +
    '" aria-label="x"><canvas width="56" height="56"></canvas></button>';
  const card = (inner) => '<details class="vp-menu vp-stock-menu"><summary>Stock</summary><div class="vp-menu-body">' + inner + '</div></details>';
  check('a card of tiles is clean', stockCardFaults(stockCard(card(tile('box') + tile('cone')))).length === 0);
  check('a field on the card is caught',
    stockCardFaults(stockCard(card(tile('box') + '<label>H <input type="number" id="x"></label>'))).length >= 2);
  check('a select is caught', stockCardFaults(stockCard(card('<select id="s"><option>a</option></select>' + tile('box')))).length >= 2);
  check('a plain button that is not a tile is caught',
    stockCardFaults(stockCard(card(tile('box') + '<button id="btn-stock-make" class="btn">New stock</button>'))).length >= 1);
  check('text on a tile is caught', stockCardFaults(stockCard(card('<button class="stock-tile" data-shape="box"><canvas></canvas>Box</button>'))).length >= 1);
  check('a tile with no canvas is caught', stockCardFaults(stockCard(card('<button class="stock-tile" data-shape="box"></button>'))).length >= 1);
  check('loose text is caught', stockCardFaults(stockCard(card(tile('box') + 'Pick a shape'))).length >= 1);
  check('a field hidden in a comment is not counted, a missing card is',
    stockCardFaults(stockCard(card(tile('box') + '<!-- <input> -->'))).length === 0 && stockCardFaults(stockCard('<div></div>')).length === 1);
}

// --- index.html ------------------------------------------------------------
console.log('index.html');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const targets = loadTargets(html);
  check('found the page\'s script and link tags', targets.length > 50, targets.length + ' tags');
  const dups = duplicateTargets(html);
  check('no script or link target loaded twice', dups.length === 0,
    dups.length ? dups.length + ' repeated' : '');
  for (const [target, ts] of dups) {
    console.log('       ' + target + ' is loaded ' + ts.length + ' times:');
    for (const t of ts) console.log('         index.html:' + t.line + '  ' + t.raw);
  }
}

// --- the Stock card ---------------------------------------------------------
console.log('the Stock card');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const card = stockCard(html);
  const faults = stockCardFaults(card);
  check('the Stock card is tiles only', faults.length === 0, faults.join('; ') || (card.match(/data-shape=/g) || []).length + ' tiles');
  for (const f of faults) console.log('       ' + f);
}

// --- package.json ----------------------------------------------------------
console.log('package.json');
{
  const text = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  let pkg = null, err = '';
  try { pkg = JSON.parse(text); } catch (e) { err = e.message; }
  check('parses as JSON', !!pkg, err);
  if (pkg) {
    const steps = pkg.testSteps;
    check('"testSteps" is a non-empty array', Array.isArray(steps) && steps.length > 0);
    if (Array.isArray(steps)) {
      const reps = repeatedSteps(steps);
      check('no test step listed twice', reps.length === 0, reps.length ? reps.length + ' repeated' : '');
      for (const r of reps) {
        console.log('       "' + r.step + '" is testSteps[' + r.first + '] and again testSteps[' + r.again + ']');
      }
    }
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
process.exit(fails ? 1 : 0);

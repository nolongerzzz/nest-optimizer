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
     4. index.html: every <button> inside a column <details> (class
        vp-col-menu) sits inside that column's .vp-menu-body. A button
        left between the body and </details> renders loose under the
        summary, outside the card (Patch did, under ADD).
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
}

/* Buttons that sit in a column <details> but outside its .vp-menu-body.
   Walks the page's div/details/button tags with a stack (comments and
   script bodies blanked first) and returns [{ line, id, column }]. */
function looseColumnButtons(html) {
  const live = html
    .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (c) => c.replace(/[^\n]/g, ' '));
  const tagRe = /<(\/?)(div|details|button)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const stack = [];
  const loose = [];
  let m;
  while ((m = tagRe.exec(live))) {
    const name = m[2].toLowerCase();
    const attrs = m[3];
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const cls = (/\bclass\s*=\s*"([^"]*)"/.exec(attrs) || [, ''])[1].split(/\s+/);
    const id = (/\bid\s*=\s*"([^"]*)"/.exec(attrs) || [, ''])[1];
    const line = live.slice(0, m.index).split('\n').length;
    if (name === 'button') {
      for (let i = 0; i < stack.length; i++) {
        if (stack[i].name !== 'details' || !stack[i].col) continue;
        const inBody = stack.slice(i + 1).some((e) => e.name === 'div' && e.body);
        if (!inBody) loose.push({ line, id, column: stack[i].id });
      }
    }
    stack.push({ name, id, col: name === 'details' && cls.includes('vp-col-menu'),
      body: name === 'div' && cls.includes('vp-menu-body') });
  }
  return loose;
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
  {
    const bad = [
      '<details class="vp-menu vp-col-menu" id="menu-a"><summary>A</summary>',
      '<div class="vp-menu-body"><button id="in">In</button></div>',
      '<button id="loose">Loose</button></details>',
    ].join('\n');
    const l = looseColumnButtons(bad);
    check('a button under a column summary but outside its body is caught',
      l.length === 1 && l[0].id === 'loose' && l[0].column === 'menu-a' && l[0].line === 3, JSON.stringify(l));
    check('a button inside the body, and one in a plain details, are not',
      looseColumnButtons('<details class="vp-col-menu"><div class="vp-menu-body"><button>x</button></div></details><details><button>y</button></details>').length === 0);
  }
  const loose = looseColumnButtons(html);
  check('every button in a column <details> is inside its .vp-menu-body', loose.length === 0,
    loose.length ? loose.length + ' loose' : '');
  for (const l of loose) console.log('       index.html:' + l.line + '  #' + l.id + ' is loose in #' + l.column);
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

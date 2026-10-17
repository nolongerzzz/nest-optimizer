#!/usr/bin/env node
/* The page's load list and the test list, each with nothing in it twice, and
   the page itself: no header above the shell, no #btn-clear anywhere.
   Gates 1-5 read files and need no browser; gate 6 measures the page at
   1280 x 800 in the harness's Chromium.
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
     4. index.html: no <header> element (comments don't count). The page used
        to carry a logo / name / tagline / Clear header over the shell; the
        row and the pinned Plate & pieces panel start at the window's top
        edge now, and a header would push the viewport down again.
     5. Nothing keeps the id btn-clear alive: not index.html, not a script,
        not a test or drive check. The header's Clear was the only holder; CLEAR
        PLATE (btn-clear-plate) is the Clear that stays. ms-btn-clear
        (G-scope's own) and btn-clear-plate are other ids and don't count.
     6. At 1280 x 800 the page has no <header> and no #btn-clear in its DOM,
        the viewport starts at the top of the window, and the top row and the
        pinned panel start at most 8 px below it.
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

/* Gate 4: the <header> tags in a page, comments blanked first. */
function headerTags(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  return live.match(/<header\b/gi) || [];
}

/* Gate 5: every file under these that names the bare id btn-clear - not
   btn-clear-plate, not ms-btn-clear, which are other ids. */
const BARE_ID = /(?<![\w-])btn-clear(?![\w-])/;
function bareIdLines(text) {
  return text.split('\n').reduce((n, l, i) => (BARE_ID.test(l) ? n.concat(i + 1) : n), []);
}
function filesUnder(dir, exts, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'vendor') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(f, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(f);
  }
  return out;
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
  check('a <header> is caught, one in a comment is not',
    headerTags('<div id="app"><header class="h"></header></div>').length === 1 &&
    headerTags('<!-- <header> -->\n<div></div>').length === 0 &&
    headerTags('<div class="findings-head"></div>').length === 0);
  check('the bare id btn-clear is caught; btn-clear-plate and ms-btn-clear are not',
    bareIdLines('a\ndocument.getElementById(\'btn-clear\')').join() === '2' &&
    bareIdLines('page.click("#btn-clear")').length === 1 &&
    bareIdLines('<button id="btn-clear" class="btn">').length === 1 &&
    bareIdLines('#btn-clear-plate').length === 0 && bareIdLines('ms-btn-clear\n#ms-btn-clear-view').length === 0);
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
  check('no <header> on the page', headerTags(html).length === 0, headerTags(html).length + ' found');
}

// --- nothing keeps btn-clear alive ------------------------------------------
console.log('btn-clear');
{
  const self = path.resolve(__filename);
  const files = [path.join(ROOT, 'index.html')]
    .concat(filesUnder(ROOT, ['.js', '.mjs', '.html'], []).filter((f) => !f.startsWith(path.join(ROOT, 'docs'))))
    .filter((f, i, a) => a.indexOf(f) === i && path.resolve(f) !== self);
  const holders = [];
  for (const f of files) {
    const lines = bareIdLines(fs.readFileSync(f, 'utf8'));
    if (lines.length) holders.push(path.relative(ROOT, f) + ':' + lines.join(','));
  }
  check('no file names the id btn-clear (the page, a script, a test or a drive check)', holders.length === 0,
    holders.length ? holders.join('  ') : files.length + ' files read');
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

/* --- the page at 1280 x 800 ------------------------------------------------
   The top of the top row, measured: the first slab of .vp-shell-row, the
   pinned panel and the viewport, in window coordinates. Run first on a page
   that has a 61 px header over the same markup, which must fail the gate. */
const MAX_TOP = 8;
const measureTop = () => {
  const top = (el) => (el ? el.getBoundingClientRect().top : null);
  return {
    headers: document.querySelectorAll('header').length,
    clearButtons: document.querySelectorAll('#btn-clear').length,
    viewport: top(document.getElementById('viewport')),
    row: top(document.querySelector('.vp-shell-row > *')),
    panel: top(document.getElementById('plate-panel'))
  };
};
const topGate = (m) => m.headers === 0 && m.clearButtons === 0 && m.viewport === 0 &&
  m.row !== null && m.row >= 0 && m.row <= MAX_TOP && m.panel !== null && m.panel >= 0 && m.panel <= MAX_TOP;

async function pageGate() {
  console.log('the page at 1280 x 800');
  const { withApp } = require('./nso_app_harness');
  await withApp(async (page) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForSelector('.vp-shell-row');
    await page.waitForTimeout(300);
    const m = await page.evaluate(measureTop);
    check('no <header> and nothing with id btn-clear in the DOM', m.headers === 0 && m.clearButtons === 0,
      m.headers + ' header(s), ' + m.clearButtons + ' #btn-clear');
    check('the viewport starts at the top of the window', m.viewport === 0, 'viewport top ' + m.viewport);
    check('the top row starts at most ' + MAX_TOP + ' px from the top of the viewport', m.row !== null && m.row >= 0 && m.row <= MAX_TOP,
      'row top ' + m.row);
    check('...and so does the pinned Plate & pieces panel', m.panel !== null && m.panel >= 0 && m.panel <= MAX_TOP,
      'panel top ' + m.panel);

    // The checker on a known-bad page, last: it replaces the document.
    await page.setContent('<header style="height:61px;margin:0"></header>' +
      '<div class="vp-shell-row" style="margin:0"><button>Import</button></div>' +
      '<div id="plate-panel"></div><div id="viewport"></div><button id="btn-clear"></button>');
    const bad = await page.evaluate(measureTop);
    check('...and the same gate fails a page with a 61 px header, a btn-clear and a pushed-down row', !topGate(bad), JSON.stringify(bad));
    check('...and a page measured as right passes it', topGate({ headers: 0, clearButtons: 0, viewport: 0, row: 8, panel: 8 }) &&
      !topGate({ headers: 0, clearButtons: 0, viewport: 0, row: 9, panel: 8 }));
  });
}

pageGate().then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}, (e) => {
  console.log('  FAIL the page could not be measured - ' + (e && e.stack || e));
  console.log('\n' + (fails + 1) + ' FAILED');
  process.exit(1);
});

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
   4. the Crop card (#crop-card in index.html) is exactly the Shape row (Box,
      Cylinder, Sphere, Piece, Outline), one readout line, CROP and Cancel: no
      field, checkbox, select, hint line or other button. The shape is sized by
      dragging, not by typing (docs/CROP.md); a control that finds its way back
      in fails here.
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

/* The Crop card's markup, from index.html: the contents of the element with
   id="crop-card", found by counting <div> opens and closes (comments blanked
   first, as loadTargets does). */
function cropCardOf(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const at = live.search(/<div\b[^>]*\bid\s*=\s*["']crop-card["']/i);
  if (at < 0) return null;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = at;
  let depth = 0, m, end = -1;
  while ((m = re.exec(live))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  if (end < 0) return null;
  const open = live.indexOf('>', at) + 1;
  return live.slice(open, end);
}

/* What the card holds: [] when it is exactly the five shapes, CROP, Cancel and one
   readout line; otherwise a list of what is wrong. */
const CROP_BUTTONS = ['btn-crop-shape-box', 'btn-crop-shape-cylinder', 'btn-crop-shape-sphere', 'btn-crop-shape-piece',
                      'btn-crop-shape-outline', 'btn-crop', 'btn-crop-cancel'];
const CROP_SHAPES = ['Box', 'Cylinder', 'Sphere', 'Piece', 'Outline'];
function cropCardProblems(card) {
  if (card == null) return ['there is no #crop-card'];
  const bad = [];
  const buttons = [...card.matchAll(/<button\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (buttons.join(',') !== CROP_BUTTONS.join(',')) bad.push('buttons are ' + buttons.join(',') + ', not ' + CROP_BUTTONS.join(','));
  if ((card.match(/<button\b/gi) || []).length !== buttons.length) bad.push('a button with no id');
  const row = card.match(/<div\b[^>]*\bid\s*=\s*["']crop-shape-row["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!row) bad.push('no Shape row (#crop-shape-row)');
  else {
    const names = [...row[1].matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
    if (names.join(',') !== CROP_SHAPES.join(',')) bad.push('the Shape row is ' + names.join(',') + ', not ' + CROP_SHAPES.join(','));
  }
  const ps = [...card.matchAll(/<p\b([^>]*)>/gi)];
  if (ps.length !== 1 || !/\bid\s*=\s*["']crop-readout["']/i.test(ps[0][1])) bad.push('not exactly one readout line, #crop-readout (' + ps.length + ' <p>)');
  for (const tag of ['input', 'select', 'textarea', 'label', 'details', 'a', 'span', 'img', 'svg', 'canvas']) {
    const n = (card.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;
    if (n) bad.push(n + ' <' + tag + '>');
  }
  return bad;
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
  const good = '<div id="crop-card" class="x"><div id="crop-shape-row">' + CROP_SHAPES.map((n, i) => '<button id="' + CROP_BUTTONS[i] + '">' + n + '</button>').join('') +
    '</div><p id="crop-readout">-</p><button id="btn-crop">CROP</button><button id="btn-crop-cancel">Cancel</button></div><div>after</div>';
  check('a card that is exactly the five shapes, readout, CROP, Cancel is clean', cropCardProblems(cropCardOf(good)).length === 0, cropCardProblems(cropCardOf(good)).join('; '));
  check('a number field put back in is caught', cropCardProblems(cropCardOf(good.replace('<p id', '<input type="number" id="crop-d"><p id'))).some((p) => /<input>/.test(p)));
  check('a checkbox and its label are caught', cropCardProblems(cropCardOf(good.replace('<p id', '<label><input type="checkbox"> Box</label><p id'))).length >= 2);
  check('a hint line is caught', cropCardProblems(cropCardOf(good.replace('<p id', '<p class="hint">x</p><p id'))).some((p) => /readout line/.test(p)));
  check('an extra button is caught', cropCardProblems(cropCardOf(good.replace('<button id="btn-crop">', '<button id="btn-crop-lockin">x</button><button id="btn-crop">'))).some((p) => /buttons are/.test(p)));
  check('a renamed shape is caught', cropCardProblems(cropCardOf(good.replace('>Sphere<', '>Ball<'))).some((p) => /Shape row/.test(p)));
  check('a missing card is caught', cropCardProblems(cropCardOf('<div id="other"></div>')).length > 0);
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

// --- the Crop card -----------------------------------------------------------
console.log('the Crop card');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const card = cropCardOf(html);
  const bad = cropCardProblems(card);
  check('#crop-card is exactly the Shape row, one readout, CROP and Cancel', bad.length === 0, bad.join('; '));
  check('Detach flange is in the Subtract card and Reattach in the Join card', (() => {
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    const inCard = (id, btn) => { const a = live.search(new RegExp('<details\\b[^>]*\\bid="' + id + '"')); const b = live.indexOf('</details>\n          <details', a + 10); const seg = live.slice(a, b < 0 ? undefined : b); return seg.includes('id="' + btn + '"'); };
    return inCard('menu-bit', 'btn-detach') && inCard('menu-joins', 'btn-reattach');
  })());
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

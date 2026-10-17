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
     5. index.html: no column card is a gate. A column card (.vp-col-menu) whose
        body, outside the panel its one button points at (aria-controls), holds
        nothing but that button has only a toggle in it: the column button
        should open the real card itself. Connect was one (a "Connect" button
        that opened #connect-panel); the card is the panel now.
     6. the Crop card (#crop-card in index.html) is exactly the Shape row (Box,
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

/* The column cards whose body is one button that only toggles another panel.
   A tiny tag walk, enough for this page: comments and scripts are blanked, the
   elements form a tree, and for each <details class="... vp-col-menu ..."> the
   controls in its .vp-menu-body (button, input, select, textarea, a) are
   split into those inside a panel some button names with aria-controls and
   the rest. A card is a gate when the rest is exactly one button and that
   button names a panel inside the card. Returns { cards, gates }: how many
   column cards were seen (so a walk gone blind fails) and the gate ids. */
function columnCardGates(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'wbr']);
  const root = { tag: '#root', attrs: {}, kids: [], parent: null };
  let cur = root;
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(live))) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const attrs = {};
    m[3].replace(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
      (all, k, a, b, c) => { attrs[k.toLowerCase()] = a !== undefined ? a : b !== undefined ? b : c !== undefined ? c : ''; });
    const node = { tag, attrs, kids: [], parent: cur };
    cur.kids.push(node);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) cur = node;
  }
  const all = (n, out = []) => { n.kids.forEach((k) => { out.push(k); all(k, out); }); return out; };
  const hasClass = (n, c) => (n.attrs.class || '').split(/\s+/).includes(c);
  const inside = (n, anc) => { for (let p = n; p; p = p.parent) if (p === anc) return true; return false; };
  const CONTROL = new Set(['button', 'input', 'select', 'textarea', 'a']);
  const cards = all(root).filter((n) => n.tag === 'details' && hasClass(n, 'vp-col-menu'));
  const gates = [];
  for (const card of cards) {
    const body = card.kids.find((k) => hasClass(k, 'vp-menu-body'));
    if (!body) continue;
    const els = all(body);
    const panels = els.filter((n) => n.attrs.id)
      .filter((n) => els.some((b) => b.tag === 'button' && b.attrs['aria-controls'] === n.attrs.id));
    const rest = els.filter((n) => CONTROL.has(n.tag) && !panels.some((p) => inside(n, p)));
    if (rest.length === 1 && rest[0].tag === 'button' && rest[0].attrs['aria-controls'] &&
        panels.some((p) => p.attrs.id === rest[0].attrs['aria-controls'])) gates.push(card.attrs.id || '(no id)');
  }
  return { cards: cards.length, gates };
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
  const gateCard = '<details class="vp-menu vp-col-menu" id="menu-x"><summary>X</summary>' +
    '<div class="vp-menu-body"><div class="vp-row"><button id="btn-x" aria-controls="x-panel" aria-expanded="false">X</button></div>' +
    '<div id="x-panel" hidden><input id="a"><button id="go">Set</button></div></div></details>';
  const realCard = '<details class="vp-menu vp-col-menu" id="menu-y"><summary>Y</summary>' +
    '<div class="vp-menu-body"><div id="y-panel"><input id="a"><button id="go">Set</button></div></div></details>';
  const twoButtons = gateCard.replace('id="menu-x"', 'id="menu-z"').replace('<div id="x-panel"', '<button id="other">Other</button><div id="x-panel"');
  const g = columnCardGates(gateCard + realCard + twoButtons);
  check('a column card holding one button that opens another panel is caught', g.gates.length === 1 && g.gates[0] === 'menu-x', g.gates.join(','));
  check('the gate walk sees every column card in the sample', g.cards === 3, String(g.cards));
  check('a card that is its own panel, and one with a second control, are not gates', g.gates.length === 1 && !g.gates.includes('menu-y') && !g.gates.includes('menu-z'));
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

// --- column cards ----------------------------------------------------------
console.log('column cards');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const g = columnCardGates(html);
  check('found the column cards', g.cards >= 10, g.cards + ' cards');
  check('no column card is a single button that only toggles another panel', g.gates.length === 0, g.gates.join(', '));
}

// --- the Crop card -----------------------------------------------------------
console.log('the Crop card');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const card = cropCardOf(html);
  const bad = cropCardProblems(card);
  check('#crop-card is exactly the Shape row, one readout, CROP and Cancel', bad.length === 0, bad.join('; '));
  check('Detach flange is in the Subtract card and Reattach in the Connect card', (() => {
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    const inCard = (id, btn) => { const a = live.search(new RegExp('<details\\b[^>]*\\bid="' + id + '"')); const b = live.indexOf('<details class="vp-menu vp-shell-menu', a + 10); const seg = live.slice(a, b < 0 ? undefined : b); return seg.includes('id="' + btn + '"'); };
    return inCard('menu-bit', 'btn-detach') && inCard('menu-connect', 'btn-reattach');
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

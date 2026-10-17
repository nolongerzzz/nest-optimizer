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
     7. index.html: the Stock card is tiles only - a row of shape buttons,
        each carrying a data-shape and one canvas, and nothing else: no
        input, select, textarea, label, output, picture or line of text, and
        no button that is not a tile. Stock is a shelf; its sizing is the
        Scale card's.
     8. index.html: no <header> element (comments don't count). The page used
        to carry a logo / name / tagline / Clear header over the shell; the
        row and the pinned Plate & pieces panel start at the window's top
        edge now, and a header would push the viewport down again.
     9. Nothing keeps the id btn-clear alive: not index.html, not a script,
        not a test or drive check. The header's Clear was the only holder; CLEAR
        PLATE (btn-clear-plate) is the Clear that stays. ms-btn-clear
        (G-scope's own) and btn-clear-plate are other ids and don't count.
    10. At 1280 x 800 the page has no <header> and no #btn-clear in its DOM,
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

// --- the Stock card ---------------------------------------------------------
console.log('the Stock card');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const card = stockCard(html);
  const faults = stockCardFaults(card);
  check('the Stock card is tiles only', faults.length === 0, faults.join('; ') || (card.match(/data-shape=/g) || []).length + ' tiles');
  for (const f of faults) console.log('       ' + f);
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

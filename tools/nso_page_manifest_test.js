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
     4. index.html: no column card is a gate. A column card (.vp-col-menu) whose
        body, outside the panel its one button points at (aria-controls), holds
        nothing but that button has only a toggle in it: the column button
        should open the real card itself. Connect was one (a "Connect" button
        that opened #connect-panel); the card is the panel now.
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

// --- column cards ----------------------------------------------------------
console.log('column cards');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const g = columnCardGates(html);
  check('found the column cards', g.cards >= 10, g.cards + ' cards');
  check('no column card is a single button that only toggles another panel', g.gates.length === 0, g.gates.join(', '));
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

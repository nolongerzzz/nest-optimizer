#!/usr/bin/env node
/* The Library delete: the catalog edit, the gate, and the one entry point.

   Everything here runs off the page. What it proves:

     1. removeCatalogEntry is surgical on the REAL shipped app-library.js -
        it removes exactly the line asked for, leaves a file that still
        parses and still exposes the rest of the catalog, and refuses
        everything it should refuse.
     2. A removal cannot leave the array malformed, whichever line it takes,
        including the last one and including the final entry of all.
     3. The permission gate is one named function with a verdict shape, so
        adding a real check later is an edit to its body.
     4. The delete is entered through ONE function. app-library.js calls it
        and nothing else - no second route, no inline fetch, no inline
        confirm.
     5. The four bordered washers this ticket deleted are gone from the
        catalog, gone from library/, and referenced by nothing that would
        404.

   node tools/nso_library_delete_test.js       exit 0 = every gate held  */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const del = require(path.join(ROOT, 'app-library-delete.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');

/* Comments in this repo quote the code they describe, at length. A check
   that greps for "nsoLibraryDelete" or "localStorage" and counts hits is
   counting prose as well as calls, so every structural check below runs on
   the source with comments stripped. Block comments and whole-line //
   comments only - that is all either file has, and a cleverer stripper would
   be the thing most likely to be wrong. */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Run an edited app-library.js for real, in a sandbox with just enough DOM
   for its module body, and read the catalog back off window.nsoLibrary. If
   the edit produced anything that does not parse or does not run, this is
   where it shows - not in a regex that says the line is gone. */
function catalogOf(source) {
  const el = () => ({
    _libBuilt: true, style: {}, dataset: {}, classList: { add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return true; },
    appendChild() {}, addEventListener() {}, contains() { return false; },
    querySelector() { return null; }, querySelectorAll() { return []; }
  });
  const doc = {
    baseURI: 'https://example.test/app/',
    readyState: 'complete',
    getElementById() { return el(); },
    createElement() { return el(); },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const win = { document: doc, setTimeout() {}, console: { warn() {} }, URL };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(source, ctx, { filename: 'app-library.js' });
  return ctx.nsoLibrary.entries().map(e => e.file);
}

const BASE = catalogOf(SRC);

/* ------------------------------------------------------------------ 1 */
console.log('\n=== 1. removeCatalogEntry on the real app-library.js ===');
check('the shipped catalog loads and lists files', BASE.length > 0, BASE.length + ' entries');
{
  const victim = 'patch_crosshatch_loose.stl';
  const r = del.removeCatalogEntry(SRC, victim);
  check('removing ' + victim + ' succeeds', r.ok, r.reason);
  if (r.ok) {
    const after = catalogOf(r.text);
    check('the edited file still parses and still runs', after.length === BASE.length - 1,
      after.length + ' vs ' + (BASE.length - 1));
    check('exactly that one file is gone', after.indexOf(victim) === -1 &&
      BASE.filter(f => f !== victim).every(f => after.indexOf(f) !== -1));
    check('exactly one line was removed',
      SRC.split('\n').length - r.text.split('\n').length === 1,
      (SRC.split('\n').length - r.text.split('\n').length) + ' lines');
    check('nothing outside the CATALOG block moved',
      r.text.slice(r.text.indexOf('\n  ];')) === SRC.slice(SRC.indexOf('\n  ];')));
  }
}

/* ------------------------------------------------------------------ 2 */
console.log('\n=== 2. any entry, in any order, and the array stays well formed ===');
{
  // Every single entry, one at a time.
  let bad = [];
  for (const f of BASE) {
    const r = del.removeCatalogEntry(SRC, f);
    if (!r.ok) { bad.push(f + ' (' + r.reason + ')'); continue; }
    let after;
    try { after = catalogOf(r.text); } catch (err) { bad.push(f + ' (' + err.message + ')'); continue; }
    if (after.length !== BASE.length - 1 || after.indexOf(f) !== -1) bad.push(f + ' (wrong result)');
  }
  check('all ' + BASE.length + ' entries can be removed individually', bad.length === 0, bad.join('; '));

  // And all of them in sequence, last-entry-first and first-entry-first,
  // which is where a trailing comma would bite.
  for (const order of [BASE.slice(), BASE.slice().reverse()]) {
    let src = SRC, broke = null;
    for (const f of order) {
      const r = del.removeCatalogEntry(src, f);
      if (!r.ok) { broke = f + ': ' + r.reason; break; }
      src = r.text;
      try { catalogOf(src); } catch (err) { broke = f + ': ' + err.message; break; }
    }
    const left = broke ? null : catalogOf(src);
    check('draining the catalog ' + (order[0] === BASE[0] ? 'front to back' : 'back to front') +
      ' leaves a file that still runs', !broke && left.length === 0, broke || (left && left.length + ' left'));
  }
}

console.log('\n=== 2b. what it refuses ===');
{
  const cases = [
    ['a name not in the catalog', 'not_here.stl'],
    ['a path, not a flat name', 'library/pin.stl'],
    ['a traversal', '../app-library.js'],
    ['a wildcard', '*.stl'],
    ['an empty name', ''],
    ['a non-string', null],
    ['a name that is only in a comment', 'patch_crosshatch_bordered.stl']
  ];
  for (const [what, name] of cases) {
    const r = del.removeCatalogEntry(SRC, name);
    check('refuses ' + what, r.ok === false && !!r.reason, JSON.stringify(name) + ' -> ' + r.reason);
  }
  check('refuses a source with no CATALOG block',
    del.removeCatalogEntry('var x = 1;\n', 'pin.stl').ok === false);
  check('refuses an unterminated CATALOG block',
    del.removeCatalogEntry("var CATALOG = [\n  { file: 'pin.stl' },\n", 'pin.stl').ok === false);
  const twice = SRC.replace("    { file: 'pin.stl',                            category: 'Shaped Pieces', source: 'local' },",
    "    { file: 'pin.stl',                            category: 'Shaped Pieces', source: 'local' },\n" +
    "    { file: 'pin.stl',                            category: 'Shaped Pieces', source: 'local' },");
  const dup = del.removeCatalogEntry(twice, 'pin.stl');
  check('refuses a name on two entry lines rather than guessing',
    dup.ok === false && /two|2 CATALOG/.test(dup.reason), dup.reason);
}

/* ------------------------------------------------------------------ 3 */
console.log('\n=== 3. the permission gate is one named function with a verdict ===');
{
  check('nsoLibraryDelete.mayDelete is a function', typeof del.mayDelete === 'function');
  const v = del.mayDelete({ file: 'pin.stl' });
  check('it returns a verdict object, not a bare boolean',
    v && typeof v === 'object' && typeof v.allowed === 'boolean' && typeof v.reason === 'string',
    JSON.stringify(v));
  check('today it allows - there is no user concept to check against', v.allowed === true);

  const modSrc = fs.readFileSync(path.join(ROOT, 'app-library-delete.js'), 'utf8');
  const mod = codeOnly(modSrc);
  check('mayDelete is declared exactly once',
    (mod.match(/function mayDelete\s*\(/g) || []).length === 1);
  check('and it is consulted exactly once, by requestDelete',
    (mod.match(/mayDelete\(/g) || []).length === 2,  // the declaration + the one call
    (mod.match(/mayDelete\(/g) || []).length + ' occurrences');
  check('the gate comment says what a future check replaces',
    /THE PERMISSION GATE/.test(modSrc) && /TODAY IT ALWAYS SAYS YES/.test(modSrc));
}

/* ------------------------------------------------------------------ 4 */
console.log('\n=== 4. one entry point, and the browser knows no other route ===');
{
  const lib = codeOnly(SRC);
  const modSrc = fs.readFileSync(path.join(ROOT, 'app-library-delete.js'), 'utf8');
  const mod = codeOnly(modSrc);
  check('app-library.js reaches nsoLibraryDelete exactly once, in code',
    (lib.match(/nsoLibraryDelete/g) || []).length === 1,
    (lib.match(/nsoLibraryDelete/g) || []).length + ' mentions');
  check('and that one reach is .request(', /nsoLibraryDelete;[\s\S]{0,400}del\.request\(/.test(lib));
  check('app-library.js has no GitHub API call of its own',
    !/api\.github\.com/.test(lib) && !/method:\s*'DELETE'/.test(lib));
  check('app-library.js raises no confirmation of its own',
    !/window\.confirm|[^.\w]confirm\(/.test(lib));
  /* The API host, the repository and the branch now live in ONE place -
     app-library-access.js - because Save writes to the same repository and
     two copies of owner/repo/branch is a drift nobody would think to look
     for. So the assertion is no longer "delete owns the host" but the
     stronger "nothing but the access module names it". */
  const acc = codeOnly(fs.readFileSync(path.join(ROOT, 'app-library-access.js'), 'utf8'));
  check('app-library-access.js is the only place that names api.github.com',
    /api\.github\.com/.test(acc) && !/api\.github\.com/.test(mod) && !/api\.github\.com/.test(lib));
  check('...and the only place that names the target owner/repo/branch',
    /nolongerzzz/.test(acc) && !/nolongerzzz/.test(mod),
    'delete module mentions: ' + (mod.match(/nolongerzzz/g) || []).length);
  check('requestDelete is the only exported way in - performDelete and the ' +
    'dialog are not reachable from outside',
    typeof del.request === 'function' && typeof del.performDelete !== 'function' &&
    typeof del.runConfirm !== 'function',
    Object.keys(del).join(', '));
  check('the token is never put in localStorage',
    !/localStorage/.test(mod) && /sessionStorage\./.test(mod));
}

/* ------------------------------------------------------------------ 5 */
console.log('\n=== 5. the four bordered washers are really gone ===');
{
  const GONE = ['patch_crosshatch_bordered.stl', 'patch_crosshatch-fine_bordered.stl',
                'patch_zigzag_bordered.stl', 'patch_ring_bordered.stl'];
  for (const f of GONE) {
    check(f + ': not a catalog entry', BASE.indexOf(f) === -1);
    check(f + ': not a file in library/', !fs.existsSync(path.join(ROOT, 'library', f)));
  }
  check('Washers is still in the taxonomy',
    SRC.indexOf("'Washers'") !== -1);
  check('...and no entry is tagged with it any more',
    !/\{\s*file:[^}]*category:\s*'Washers'/.test(SRC));

  /* NO DANGLING REFERENCE ANYWHERE. Every catalog entry must have a file on
     disk, and every patch file on disk must have a catalog entry - the two
     directions fail apart and both are what "no dangling reference" means. */
  const missing = BASE.filter(f => !fs.existsSync(path.join(ROOT, 'library', f)));
  check('every catalog entry has a file in library/', missing.length === 0, missing.join(', '));
  const onDisk = fs.readdirSync(path.join(ROOT, 'library')).filter(f => /^patch_.*\.stl$/.test(f));
  const orphan = onDisk.filter(f => BASE.indexOf(f) === -1);
  check('every patch file in library/ has a catalog entry', orphan.length === 0, orphan.join(', '));

  /* The generator that writes library/ must not still be asking for them. */
  const fine = require(path.join(ROOT, 'tools', 'nso_skin_fine_samples.js'));
  const asked = fine.CATALOG_FILES.concat(fine.COPIES, fine.BUILDS.map(b => 'patch_' + b.pattern + '_' + b.variant + '.stl'));
  check('the sample generator no longer writes or copies any bordered patch',
    asked.every(f => GONE.indexOf(f) === -1), asked.filter(f => GONE.indexOf(f) !== -1).join(', '));
  check('the generator\'s catalog list matches the shipped catalog',
    fine.CATALOG_FILES.slice().sort().join(',') ===
    BASE.filter(f => f.startsWith('patch_')).slice().sort().join(','),
    fine.CATALOG_FILES.join(', '));
}

console.log('\n' + (fails ? fails + ' check(s) FAILED' : 'all gates held'));
process.exit(fails ? 1 : 0);

#!/usr/bin/env node
/* The Library "Save As": the catalog edit, the shared gate, and the one entry
   point.

   Everything here runs off the page. What it proves:

     1. addCatalogEntry is surgical on the REAL shipped app-library.js - it
        appends exactly the line asked for, fixes exactly the comma that now
        needs fixing, leaves a file that still parses and still exposes the
        whole catalog INCLUDING the new piece, and refuses everything it
        should refuse.
     2. Save and Delete are inverses on the real file: save then delete is a
        no-op on the source, and a catalog can be filled and drained without
        ever becoming malformed.
     3. A new category joins CATEGORIES, because a category nothing knows
        about is a piece that saves and then cannot be seen.
     4. THE GATE IS ONE PLACE FOR BOTH FEATURES - maySave and mayDelete are
        each a single delegation to app-library-access.js's may(), so a real
        access check later is one edit, not two.
     5. The save is entered through ONE function. The dialog, the API and the
        catalog editor are not reachable from outside it, and app-library.js
        does not know the module exists.
     6. The STL bytes come from the shipped export path, not a second one.

   node tools/nso_library_save_test.js       exit 0 = every gate held  */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const save = require(path.join(ROOT, 'app-library-save.js'));
const del = require(path.join(ROOT, 'app-library-delete.js'));
const access = require(path.join(ROOT, 'app-library-access.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');

/* Comments in this repo quote the code they describe, at length. A check that
   greps for a name and counts hits is counting prose as well as calls, so
   every structural check below runs on the source with comments stripped. */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/* What an edit did to the file, honestly.

   The inserted line is not GUESSED at. When a new entry is appended, the line
   above it gains a comma, so removing either of those two lines from the
   result leaves a diff of exactly one line - the two are indistinguishable by
   shape alone, and a helper that picks "the first one that fits" will happily
   report the wrong one. addCatalogEntry already says which line it added, so
   that is what gets removed. After it is out, the two files MUST line up
   position for position, and every remaining difference is reported. */
function changedLines(before, after, insertedLine) {
  const a = before.split('\n'), b = after.split('\n');
  if (b.length !== a.length + 1) return { changed: ['line count moved by ' + (b.length - a.length)] };
  const at = b.indexOf(insertedLine);
  if (at === -1) return { changed: ['the reported new line is not in the result'] };
  if (b.indexOf(insertedLine, at + 1) !== -1) return { changed: ['the new line appears more than once'] };
  const b2 = b.slice(0, at).concat(b.slice(at + 1));
  const changed = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b2[i]) changed.push({ at: i + 1, from: a[i], to: b2[i] });
  return { insertedAt: at + 1, changed };
}

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Run an edited app-library.js for real, in a sandbox with just enough DOM for
   its module body, and read the catalog back off window.nsoLibrary. If the
   edit produced anything that does not parse or does not run, this is where it
   shows - not in a regex that says the line is there. */
function libraryOf(source) {
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
  return {
    files: ctx.nsoLibrary.entries().map(e => e.file),
    entries: ctx.nsoLibrary.entries(),
    categories: ctx.nsoLibrary.categories.slice()
  };
}

const BASE = libraryOf(SRC);

/* ------------------------------------------------------------------ 1 */
console.log('\n=== 1. addCatalogEntry on the real app-library.js ===');
check('the shipped catalog loads and lists files', BASE.files.length > 0, BASE.files.length + ' entries');
{
  const entry = { file: 'drive_check_piece.stl', category: 'Test Fixtures', source: 'local' };
  const r = save.addCatalogEntry(SRC, entry);
  check('saving ' + entry.file + ' succeeds', r.ok, r.reason);
  if (r.ok) {
    const after = libraryOf(r.text);
    check('the edited file still parses and still runs',
      after.files.length === BASE.files.length + 1,
      after.files.length + ' vs ' + (BASE.files.length + 1));
    check('the new piece is really in the catalog', after.files.indexOf(entry.file) !== -1);
    check('under the category it was given',
      (after.entries.find(e => e.file === entry.file) || {}).category === entry.category);
    check('and with the source it was given',
      (after.entries.find(e => e.file === entry.file) || {}).source === 'local');
    check('every pre-existing entry is still there',
      BASE.files.every(f => after.files.indexOf(f) !== -1));
    check('exactly one line was added',
      r.text.split('\n').length - SRC.split('\n').length === 1,
      (r.text.split('\n').length - SRC.split('\n').length) + ' lines');
    check('an existing category is NOT re-added to the taxonomy',
      r.newCategory === false && after.categories.length === BASE.categories.length,
      after.categories.join(', '));

    /* The only existing line that may move is the comma on what used to be
       the last entry. Nothing else in the file may shift by a byte. */
    const d = changedLines(SRC, r.text, r.line);
    check('exactly one existing line changed, and only by gaining a comma',
      d.changed.length === 1 && d.changed[0].from + ',' === d.changed[0].to,
      JSON.stringify(d.changed));
    check('the new line is the last entry in the block',
      /\{ file: 'drive_check_piece\.stl',\s+category: 'Test Fixtures', source: 'local' \}\n {2}\];/.test(r.text));
    check('the new line is aligned with the ones above it',
      r.line.indexOf('category:') === SRC.split('\n').filter(l => /^\s*\{ file: 'pin\.stl'/.test(l))[0].indexOf('category:'),
      JSON.stringify(r.line));
  }
}

/* ------------------------------------------------------------------ 2 */
console.log('\n=== 2. save and delete are inverses, and the array stays well formed ===');
{
  const entry = { file: 'round_trip.stl', category: 'Skins', source: 'local' };
  const added = save.addCatalogEntry(SRC, entry);
  check('a save applies', added.ok, added.reason);
  if (added.ok) {
    const back = del.removeCatalogEntry(added.text, entry.file);
    check('...and the delete side removes exactly what it added', back.ok, back.reason);
    check('save then delete leaves the file byte-for-byte as it was',
      back.ok && back.text === SRC,
      back.ok ? (back.text === SRC ? '' : 'differs') : back.reason);
  }

  /* Fill the catalog with a run of saves and then drain it with a run of
     deletes, executing the file at every step. A trailing comma mishandled in
     either direction shows up here and nowhere else. */
  let src = SRC, broke = null;
  const added10 = [];
  for (let n = 0; n < 10 && !broke; n++) {
    const f = 'bulk_' + n + '.stl';
    const r = save.addCatalogEntry(src, { file: f, category: n % 2 ? 'Skins' : 'Test Fixtures' });
    if (!r.ok) { broke = f + ': ' + r.reason; break; }
    src = r.text;
    added10.push(f);
    try { libraryOf(src); } catch (err) { broke = f + ': ' + err.message; }
  }
  check('ten saves in a row all apply and the file runs after each',
    !broke && libraryOf(src).files.length === BASE.files.length + 10, broke || '');

  for (const f of added10.slice().reverse()) {
    if (broke) break;
    const r = del.removeCatalogEntry(src, f);
    if (!r.ok) { broke = f + ': ' + r.reason; break; }
    src = r.text;
    try { libraryOf(src); } catch (err) { broke = f + ': ' + err.message; }
  }
  check('...and deleting all ten again returns the original file exactly',
    !broke && src === SRC, broke || (src === SRC ? '' : 'differs'));
}

console.log('\n=== 2b. what it refuses ===');
{
  const cases = [
    ['a name already in the catalog', { file: 'pin.stl', category: 'Skins' }],
    ['a path, not a flat name', { file: 'library/x.stl', category: 'Skins' }],
    ['a traversal', { file: '../app-library.js', category: 'Skins' }],
    ['a name with no .stl/.3mf', { file: 'piece', category: 'Skins' }],
    ['an empty name', { file: '', category: 'Skins' }],
    ['a non-string name', { file: null, category: 'Skins' }],
    ['an empty category', { file: 'ok.stl', category: '' }],
    ['a category that would close the string literal', { file: 'ok.stl', category: "x', evil: '" }],
    ['a category with a backslash', { file: 'ok.stl', category: 'a\\b' }],
    ['a category with a newline', { file: 'ok.stl', category: 'a\nb' }],
    ['a source that would close the string literal', { file: 'ok.stl', category: 'Skins', source: "l'" }],
    ['no entry at all', null]
  ];
  for (const [what, entry] of cases) {
    const r = save.addCatalogEntry(SRC, entry);
    check('refuses ' + what, r.ok === false && !!r.reason, r.reason);
  }
  check('refuses a source with no CATALOG block',
    save.addCatalogEntry('var x = 1;\n', { file: 'a.stl', category: 'Skins' }).ok === false);
  check('refuses an unterminated CATALOG block',
    save.addCatalogEntry("var CATALOG = [\n  { file: 'pin.stl' },\n", { file: 'a.stl', category: 'Skins' }).ok === false);
  check('refuses a file whose CATEGORIES is not a one-line array',
    save.addCatalogEntry(SRC.replace(/ {2}var CATEGORIES = \[.*\];/, '  var CATEGORIES = [\n    1\n  ];'),
      { file: 'a.stl', category: 'Skins' }).ok === false);

  /* A refusal must return NO text at all. The write order puts the file
     first, so a half-built catalog string that a caller used anyway would be
     the one way to get a dangling row. */
  const refused = save.addCatalogEntry(SRC, { file: 'pin.stl', category: 'Skins' });
  check('a refusal carries no partially-edited source',
    refused.text === undefined, JSON.stringify(Object.keys(refused)));
}

console.log('\n=== 2c. the name the operator types becomes a safe name ===');
{
  const cases = [
    ['My Piece', 'My_Piece.stl'],
    ['  spaced  ', 'spaced.stl'],
    ['weird!!name.stl', 'weirdname.stl'],
    ['../evil', 'evil.stl'],
    ['already.stl', 'already.stl'],
    ['keeps.3mf', 'keeps.3mf'],
    ['', ''],
    ['...', '']
  ];
  for (const [typed, want] of cases) {
    const got = save.normaliseName(typed);
    check('"' + typed + '" -> "' + want + '"', got === want, got);
  }
  /* Whatever it produces is either empty or something addCatalogEntry will
     accept - it can never hand the editor a name the editor has to catch. */
  const fuzz = ['a/b', '..', '.stl', 'x'.repeat(200), 'ünïcode', '<script>', "quote'"];
  const bad = fuzz.map(t => [t, save.normaliseName(t)])
    .filter(([, n]) => n && !save.addCatalogEntry(SRC, { file: n, category: 'Skins' }).ok);
  check('every name it produces is one the catalog editor accepts', bad.length === 0,
    JSON.stringify(bad));
}

/* ------------------------------------------------------------------ 3 */
console.log('\n=== 3. a new category joins the taxonomy ===');
{
  const r = save.addCatalogEntry(SRC, { file: 'jig_one.stl', category: 'Jigs' });
  check('saving under a category the file has never seen succeeds', r.ok, r.reason);
  if (r.ok) {
    check('it reports that the category is new', r.newCategory === true);
    const after = libraryOf(r.text);
    check('CATEGORIES really gained it', after.categories.indexOf('Jigs') !== -1,
      after.categories.join(', '));
    check('...exactly once, at the end', after.categories.filter(c => c === 'Jigs').length === 1 &&
      after.categories[after.categories.length - 1] === 'Jigs');
    check('and no existing category was disturbed',
      BASE.categories.every((c, i) => after.categories[i] === c));
    check('the piece is filed under it',
      (after.entries.find(e => e.file === 'jig_one.stl') || {}).category === 'Jigs');
    const d = changedLines(SRC, r.text, r.line);
    check('exactly two existing lines changed - the comma and CATEGORIES',
      d.changed.length === 2 &&
      d.changed.some(c => c.from + ',' === c.to) &&
      d.changed.some(c => /var CATEGORIES = \[/.test(c.from) && /'Jigs'\]/.test(c.to)),
      JSON.stringify(d.changed.map(c => c.at)));

    /* Second piece into the now-known category must NOT add it again. */
    const r2 = save.addCatalogEntry(r.text, { file: 'jig_two.stl', category: 'Jigs' });
    check('a second piece into that category does not re-add it',
      r2.ok && r2.newCategory === false, r2.reason);
  }
}

/* ------------------------------------------------------------------ 4 */
console.log('\n=== 4. ONE gate, for both features ===');
{
  check('nsoLibrarySave.maySave is a function', typeof save.maySave === 'function');
  const v = save.maySave({ file: 'x.stl', category: 'Skins' });
  check('it returns a verdict object, not a bare boolean',
    v && typeof v === 'object' && typeof v.allowed === 'boolean' && typeof v.reason === 'string',
    JSON.stringify(v));
  check('today it allows - there is no user concept to check against', v.allowed === true);

  const modSrc = fs.readFileSync(path.join(ROOT, 'app-library-save.js'), 'utf8');
  const mod = codeOnly(modSrc);
  const delMod = codeOnly(fs.readFileSync(path.join(ROOT, 'app-library-delete.js'), 'utf8'));
  const accSrc = fs.readFileSync(path.join(ROOT, 'app-library-access.js'), 'utf8');
  const acc = codeOnly(accSrc);

  check('maySave is declared exactly once',
    (mod.match(/function maySave\s*\(/g) || []).length === 1);
  check('and it is consulted exactly once, by requestSave',
    (mod.match(/maySave\(/g) || []).length === 2,   // the declaration + the one call
    (mod.match(/maySave\(/g) || []).length + ' occurrences');

  /* THE POINT OF TASK 5. Neither feature decides anything: each one asks the
     same function in the same file. A real access check is an edit to that
     one body, and it covers both. */
  check('maySave decides nothing itself - it delegates to the shared gate',
    /function maySave[\s\S]{0,400}?a\.may\('save'/.test(mod));
  check('mayDelete decides nothing itself either - same shared gate',
    /function mayDelete[\s\S]{0,400}?a\.may\('delete'/.test(delMod));
  check('may() is declared exactly once, in app-library-access.js',
    (acc.match(/function may\s*\(/g) || []).length === 1 &&
    !/function may\s*\(/.test(mod) && !/function may\s*\(/.test(delMod));
  check('neither feature carries a verdict of its own',
    !/allowed:\s*true/.test(mod.replace(/function maySave[\s\S]*?\n {2}\}/, '')) &&
    !/allowed:\s*true/.test(delMod.replace(/function mayDelete[\s\S]*?\n {2}\}/, '')));
  check('a missing access module is a NO, not a yes - the gate fails closed',
    /allowed:\s*false/.test(mod) && /allowed:\s*false/.test(delMod));
  check('the gate comment says what a future check replaces',
    /THE PERMISSION GATE/.test(accSrc) && /TODAY IT ALWAYS SAYS YES/.test(accSrc));
  check('an unknown action is refused rather than allowed',
    access.may('rename', {}).allowed === false, JSON.stringify(access.may('rename', {})));
  check('both features are known to the gate',
    access.actions().indexOf('save') !== -1 && access.actions().indexOf('delete') !== -1,
    access.actions().join(', '));

  /* One target, so a Save and a Delete in the same session cannot aim at
     different repositories. */
  check('app-library-access.js is the only place naming api.github.com',
    /api\.github\.com/.test(acc) && !/api\.github\.com/.test(mod) && !/api\.github\.com/.test(delMod));
  check('...and the only place naming the owner/repo/branch',
    /nolongerzzz/.test(acc) && !/nolongerzzz/.test(mod) && !/nolongerzzz/.test(delMod));
  check('save and delete report the same write target',
    JSON.stringify(save.target()) === JSON.stringify(del.target()),
    JSON.stringify(save.target()));
  check('one token key, shared, published by the access module',
    /TOKEN_KEY/.test(mod) && /TOKEN_KEY/.test(delMod) &&
    !/'nso\.library\.[a-z]+\.token'/.test(mod) && !/'nso\.library\.[a-z]+\.token'/.test(delMod));
  check('the token is never put in localStorage',
    !/localStorage/.test(mod) && /sessionStorage\./.test(mod));
}

/* ------------------------------------------------------------------ 5 */
console.log('\n=== 5. one entry point, and no other route in ===');
{
  const lib = codeOnly(SRC);
  const mod = codeOnly(fs.readFileSync(path.join(ROOT, 'app-library-save.js'), 'utf8'));
  check('requestSave is the only exported way in - performSave and the dialog ' +
    'are not reachable from outside',
    typeof save.request === 'function' && typeof save.performSave !== 'function' &&
    typeof save.runConfirm !== 'function' && typeof save.buildDialog !== 'function',
    Object.keys(save).join(', '));
  check('app-library.js does not know the save module exists',
    !/nsoLibrarySave/.test(lib));
  check('app-library.js has no GitHub API call of its own',
    !/api\.github\.com/.test(lib) && !/method:\s*'PUT'/.test(lib));
  check('app-library.js raises no confirmation of its own',
    !/window\.confirm|[^.\w]confirm\(/.test(lib));
  check('the save module raises no window.confirm either',
    !/window\.confirm|[^.\w]confirm\(/.test(mod));
  check('app-library.js exposes add() as the local half only - it commits nothing',
    /add:\s*remember/.test(lib) && /function remember\(/.test(lib));
  check('the save module is what calls it, once',
    (mod.match(/lib\.add\(/g) || []).length === 1);

  /* The button is the ONE UI route, and it is bound inside the module, so the
     feature is this file plus one <button>. */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('index.html carries exactly one Save-to-Library button',
    (html.match(/id="btn-library-save"/g) || []).length === 1);
  /* Script TAGS, not any mention: the button's own comment names the save
     module a few hundred lines earlier, which an indexOf on the bare name
     would happily read as "save comes first". */
  const tagAt = f => html.indexOf('src="' + f);
  check('...and all three library scripts are loaded, access first',
    tagAt('app-library-access.js') !== -1 && tagAt('app-library-delete.js') !== -1 &&
    tagAt('app-library-save.js') !== -1 && tagAt('app-library.js?') !== -1 &&
    tagAt('app-library-access.js') < tagAt('app-library-delete.js') &&
    tagAt('app-library-access.js') < tagAt('app-library-save.js'),
    [tagAt('app-library-access.js'), tagAt('app-library-delete.js'), tagAt('app-library-save.js')].join(' '));
  check('the button is bound in the save module and nowhere else',
    (mod.match(/btn-library-save/g) || []).length === 1 &&
    !/btn-library-save/.test(codeOnly(fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8'))) &&
    !/btn-library-save/.test(lib));
}

/* ------------------------------------------------------------------ 6 */
console.log('\n=== 6. the bytes are the shipped export path, not a second one ===');
{
  const join = codeOnly(fs.readFileSync(path.join(ROOT, 'app-join.js'), 'utf8'));
  const mod = codeOnly(fs.readFileSync(path.join(ROOT, 'app-library-save.js'), 'utf8'));
  check('activeModelSTL is declared once, in app-join.js',
    (join.match(/function activeModelSTL\s*\(/g) || []).length === 1);
  check('the download button now goes through it too, so neither can drift',
    /function exportActiveModel\s*\(\)\s*\{\s*const stl = activeModelSTL\(\);/.test(join));
  check('the save module calls it and builds no geometry of its own',
    /activeModelSTL\(\)/.test(mod) && !/geometryToBinarySTL/.test(mod) &&
    !/BufferGeometry/.test(mod));
  check('and the STL bytes reach the API base64-encoded in chunks, ' +
    'not through a latin1 btoa of a megabyte string',
    /function b64bytes/.test(mod) && /subarray/.test(mod));
}

console.log('\n' + (fails ? fails + ' check(s) FAILED' : 'all gates held'));
process.exit(fails ? 1 : 0);

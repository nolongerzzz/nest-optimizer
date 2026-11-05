/* Where the Library's catalog files are, for the checks that read them.

   The catalog's STLs moved out of this repo into nolongerzzz/nest-library.
   The page fetches them from there (app-library.js's 'nest-library' source,
   a raw.githubusercontent.com URL). The files the TESTS load by name -
   v9_mirror_factory, the tape pieces, box_bit_12x8x8, box_closed, pin,
   CTH_fixture, soften_test_* and friends - stayed in this repo's library/,
   so nothing that reads a fixture needs the network or a second checkout.

   What does need the other repo is a check about the CATALOG ITSELF: "every
   row has a file", "the generator's output is byte-identical to the shipped
   piece", "this row loads with this many triangles". Those read the files
   from a nest-library checkout, found here in this order:

     1. $NSO_LIBRARY_DIR, if set. Set but not a directory is an error, not a
        quiet fall-through - a typo there would otherwise turn every catalog
        check into a SKIP and look like a pass. The one exception is the
        literal NSO_LIBRARY_DIR=none, which means "act as if there were no
        checkout", so the SKIP path can be run on purpose.
     2. ../nest-library, a sibling clone beside this repo.
     3. neither: the caller SKIPs those checks, and says so, out loud, with
        skip(). It never passes them. CI checks the repo out (test.yml), so
        there the comparison really runs.

   node tools/nso_library_dir.js      prints what it resolved, and why          */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = path.join(ROOT, 'library');

/* Mirrors app-library.js's SOURCES['nest-library'].base. The harness answers
   requests under this prefix from the checkout, and nso_library_browser_test
   asserts the page's base is exactly this string, so the two cannot drift. */
const OWNER = 'nolongerzzz';
const REPO = 'nest-library';
const REF = 'main';
const RAW_BASE = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/' + REF + '/';

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

let cached;
function resolveDir() {
  if (cached !== undefined) return cached;
  const env = process.env.NSO_LIBRARY_DIR;
  if (env === 'none') {
    cached = { dir: null, how: 'NSO_LIBRARY_DIR=none' };
  } else if (env) {
    const p = path.resolve(env);
    if (!isDir(p)) throw new Error('NSO_LIBRARY_DIR=' + env + ' is not a directory');
    cached = { dir: p, how: 'NSO_LIBRARY_DIR' };
  } else {
    const sib = path.resolve(ROOT, '..', REPO);
    cached = isDir(sib) ? { dir: sib, how: 'sibling checkout' } : { dir: null, how: 'none found' };
  }
  return cached;
}

/* The nest-library checkout, or null. */
function libraryDir() { return resolveDir().dir; }

/* A catalog file's bytes on disk: the checkout's copy when there is one, else
   this repo's library/ copy when the file is one of the fixtures kept here,
   else null. The two copies are the same bytes - tools/nso_library_delete_test.js
   section 5 compares every file present in both. */
function catalogFile(name) {
  const dir = libraryDir();
  if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  if (fs.existsSync(path.join(LOCAL, name))) return path.join(LOCAL, name);
  return null;
}

const HOW_TO = 'no nest-library checkout - set NSO_LIBRARY_DIR or clone ' +
  'https://github.com/' + OWNER + '/' + REPO + ' beside this repo';

/* One line per skipped check, in the shape every check in this repo prints
   ("  ok   ...", "  FAIL ..."), so a SKIP is as visible in the log as a
   failure would be. Returns the count so a caller can total them. */
function skip(what) {
  console.log('  SKIP ' + what + ' - ' + HOW_TO);
  return 1;
}

/* The STLs in the checkout that this repo does NOT also carry in library/,
   for the checks that walk "every STL in the repo" (selfint:equiv,
   defects:test). Before the move those walks covered the catalog; this puts
   the catalog-only pieces back in front of them, once each - the fixtures
   kept here are byte-identical copies and are already walked. [] without a
   checkout. */
function extraStls() {
  const dir = libraryDir();
  if (!dir) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.stl') && !fs.existsSync(path.join(LOCAL, f)))
    .sort()
    .map(f => path.join(dir, f));
}

/* How a check names a file in its log: relative to this repo, or
   "nest-library/<name>" for one from the checkout, wherever that is. */
function labelOf(file) {
  const dir = libraryDir();
  if (dir && path.dirname(file) === dir) return REPO + '/' + path.basename(file);
  return path.relative(ROOT, file);
}

module.exports = { ROOT, LOCAL, OWNER, REPO, REF, RAW_BASE, libraryDir, catalogFile, extraStls, labelOf,
  skip, HOW_TO };

if (require.main === module) {
  const r = resolveDir();
  console.log('nest-library: ' + (r.dir || '(none)') + '  [' + r.how + ']');
  console.log('raw base:     ' + RAW_BASE);
}

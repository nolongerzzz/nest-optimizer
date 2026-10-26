#!/usr/bin/env node
/* Import > Recent's store (nso-recent.js). No browser.
     node tools/nso_recent_store_test.js     exit 0 = every gate held
     npm run recent:store

   1. add() and list() are the whole interface: an entry goes in, comes out
      newest first, with a `when` the store stamped.
   2. A piece loaded again is one entry, moved to the top - a library file by
      its library and name, a file by name, size and modified time.
   3. A bad entry (no name, an unknown source, nothing to load it from) is
      refused and changes nothing.
   4. The list is capped; the oldest fall off.
   5. list() hands out copies. The page's store can be swapped for another with
      the same two calls, and noteLoad files a library load and a file load. */

const R = require('../nso-recent.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

let t = 1000;
const mk = (opts) => R.createStore(Object.assign({ now: () => (t += 10) }, opts));
const lib = (file) => ({ name: file, source: 'library', load: { file, category: 'Skins', source: 'nest-library' } });
const fil = (name, size, lastModified) => ({ name, source: 'file', load: { blob: { size, lastModified } } });
const names = (s) => s.list().map((e) => e.name).join(',');

console.log('1. add and list');
{
  const s = mk();
  check('a new store lists nothing', s.list().length === 0);
  const a = s.add(lib('pin.stl'));
  s.add(fil('part.stl', 100, 5));
  s.add(lib('cube-6mm.stl'));
  check('newest first, whichever source', names(s) === 'cube-6mm.stl,part.stl,pin.stl', names(s));
  check('an entry is name, source, load, when', Object.keys(a).sort().join() === 'load,name,source,when');
  const w = s.list().map((e) => e.when);
  check('`when` is stamped by the store and runs newest first', w[0] > w[1] && w[1] > w[2], w.join(','));
  check('the library entry carries what is needed to fetch it again',
    s.list()[2].load.file === 'pin.stl' && s.list()[2].load.source === 'nest-library' && s.list()[2].load.category === 'Skins');
  check('the file entry carries the file', s.list()[1].load.blob.size === 100);
}

console.log('2. the same piece is one entry');
{
  const s = mk();
  s.add(lib('pin.stl')); s.add(lib('cube-6mm.stl')); s.add(lib('pin.stl'));
  check('a library file loaded again moves to the top', names(s) === 'pin.stl,cube-6mm.stl', names(s));
  s.add(fil('a.stl', 10, 1)); s.add(fil('a.stl', 10, 1));
  check('the same file loaded again is one entry', s.list().filter((e) => e.name === 'a.stl').length === 1);
  s.add(fil('a.stl', 11, 1));
  check('a file of the same name that is a different file is another', s.list().filter((e) => e.name === 'a.stl').length === 2);
  s.add({ name: 'pin.stl', source: 'file', load: { blob: { size: 5, lastModified: 1 } } });
  check('a file named like a library piece is not that piece', s.list().filter((e) => e.name === 'pin.stl').length === 2);
}

console.log('3. what is refused');
{
  const s = mk();
  check('no name', s.add({ source: 'file', load: { blob: {} } }) === null);
  check('an unknown source', s.add({ name: 'x', source: 'cloud', load: {} }) === null);
  check('a library entry with nothing to load', s.add({ name: 'x.stl', source: 'library' }) === null);
  check('a file entry with no file', s.add({ name: 'x.stl', source: 'file', load: {} }) === null);
  check('nothing at all', s.add(null) === null && s.add(undefined) === null);
  check('and the list is still empty', s.list().length === 0);
}

console.log('4. the cap');
{
  const s = mk({ limit: 3 });
  for (const n of ['a', 'b', 'c', 'd']) s.add(lib(n + '.stl'));
  check('the oldest falls off', names(s) === 'd.stl,c.stl,b.stl', names(s));
  check('the default cap is 20', R.LIMIT === 20);
  const big = mk();
  for (let i = 0; i < 30; i++) big.add(lib('p' + i + '.stl'));
  check('thirty adds keep twenty', big.list().length === 20 && big.list()[0].name === 'p29.stl');
}

console.log('5. copies, swapping, noteLoad');
{
  const s = mk();
  s.add(lib('pin.stl'));
  const l = s.list(); l[0].name = 'changed'; l.length = 0;
  check('changing what list() returned changes nothing', names(s) === 'pin.stl');

  const mine = mk();
  R.use(mine);
  R.add(lib('pin.stl'));
  check('the page store can be swapped for another with add and list', names(mine) === 'pin.stl' && R.list().length === 1);
  let threw = false;
  try { R.use({ add() {} }); } catch (e) { threw = true; }
  check('a store without list() is refused', threw);

  const f = { name: 'bracket.3mf', size: 7, lastModified: 3 };
  R.noteLoad(f);
  R.noteLoad({ name: 'pin2.stl' }, { source: 'library', load: { file: 'pin2.stl', category: 'Shaped Pieces', source: 'nest-library' } });
  const got = R.list();
  check('noteLoad of a file files a file load', got[1].source === 'file' && got[1].name === 'bracket.3mf' && got[1].load.blob === f);
  check('noteLoad with a library origin files a library load, not a file',
    got[0].source === 'library' && got[0].name === 'pin2.stl' && got[0].load.category === 'Shaped Pieces');
  check('noteLoad never throws', R.noteLoad(null) === null && R.noteLoad({}) === null);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nevery gate held');
process.exit(fails ? 1 : 0);

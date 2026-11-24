#!/usr/bin/env node
/* Painted filament colours: nso_paint.js and the 3MF reader's paint (docs/MULTICOLOR.md). npm run paint:test */
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'nso_paint.js'));
const R = require(path.join(ROOT, 'nso-3mf-read.js'));
let pass = 0, fail = 0;
function check(name, ok, info) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '\n         ' + info : '')); } }
function section(t) { console.log('\n== ' + t); }

(async function main() {
  section('The code: one leaf, the extended states, a split');
  {
    const A = [0, 0, 0], B = [1, 0, 0], C = [0, 1, 0], got = [];
    P.decode('4', A, B, C, (p, q, r, s) => got.push(s));
    P.decode('8', A, B, C, (p, q, r, s) => got.push(s));
    P.decode('0C', A, B, C, (p, q, r, s) => got.push(s));       /* read from the end: C (state 3 or more), then 0: 3 */
    P.decode('1C', A, B, C, (p, q, r, s) => got.push(s));       /* 3 + 1 */
    check('"4" is filament 1, "8" filament 2, "0C" filament 3, "1C" filament 4', JSON.stringify(got) === '[1,2,3,4]', JSON.stringify(got));
    const leaves = [];
    const n = P.decode('84483', A, B, C, (p, q, r, s) => leaves.push([p, q, r, s]));
    const area = t => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;
    check('"84483": all three sides split, four leaves of a quarter of the area each, filaments 2, 1, 1, 2',
      n === 4 && leaves.every(l => Math.abs(area(l) - 0.125) < 1e-12) && JSON.stringify(leaves.map(l => l[3])) === '[2,1,1,2]', JSON.stringify(leaves.map(l => l[3])));
    let fell = null;
    const bad = P.decode('3', A, B, C, (p, q, r, s) => { fell = s; });
    check('a code that runs out is one leaf of the triangle\'s own filament, and says so (-1)', bad === -1 && fell === 0);
  }

  section('The owner\'s 3-colour pyramid (Studio 02.09.01.70, 2026-11-22): fixtures/multicolor/pyramid-3colors.3mf');
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures/multicolor/pyramid-3colors.3mf')));
  const res = await R.parse3MF(bytes, { name: 'pyramid-3colors.3mf' });
  const ob = res.objects[0], paint = ob.paint;
  check('the reader keeps the paint: 6 triangles, all painted (the base with filament 1), each of its own filament 1; the project\'s three colours',
    res.objects.length === 1 && paint && paint.codes.length === 6 && paint.codes.filter(Boolean).length === 6 && Array.from(paint.ext).every(e => e === 1) &&
      JSON.stringify(paint.colours) === JSON.stringify(['#8E9089', '#FFFFFF', '#000000']), JSON.stringify(paint && { n: paint.codes.length, ext: Array.from(paint.ext), colours: paint.colours }));
  const pm = P.make(paint.codes, paint.flip, paint.ext, paint.colours);
  check('...as nso_paint.js holds it, for a soup of the piece\'s size', P.fits(pm, ob.positions.length) && !P.fits(pm, ob.positions.length + 9));
  check('...it uses filaments 1, 2 and 3', JSON.stringify(P.filaments(pm)) === '[1,2,3]', JSON.stringify(P.filaments(pm)));
  /* the bands: in the reader's soup Z is up (the build item stands the pyramid on its base) */
  const range = {};
  let leaves = 0;
  P.eachLeaf(ob.positions, pm, (p, q, r, f) => {
    leaves++;
    const lo = Math.min(p[2], q[2], r[2]), hi = Math.max(p[2], q[2], r[2]);
    const g = range[f] || (range[f] = [Infinity, -Infinity]);
    g[0] = Math.min(g[0], lo); g[1] = Math.max(g[1], hi);
  });
  const b = k => range[k].map(v => +v.toFixed(2)).join('-');
  check('...' + leaves + ' leaves, in bands: grey (1) up to 8.44 and from 21.45, black (3) 8.44 - 15.29, white (2) 15.29 - 21.45',
    b(1) === '0-30' && b(3) === '8.44-15.29' && b(2) === '15.29-21.45', JSON.stringify([b(1), b(2), b(3)]));
  const top = [], at = z => { let s = null; P.eachLeaf(ob.positions, pm, (p, q, r, f) => { if (Math.min(p[2], q[2], r[2]) < z && Math.max(p[2], q[2], r[2]) > z) { s = s == null ? f : s === f ? s : -1; } }); return s; };
  check('...a layer\'s mid-height in each band is one filament: 8.5 black, 15.3 white, 21.5 grey (where Studio\'s slice changed filament: 8.6, 15.4, 21.6)',
    at(8.5) === 3 && at(15.3) === 2 && at(21.5) === 1 && at(8.3) === 1 && at(15.1) === 3 && at(21.3) === 2, JSON.stringify([at(8.3), at(8.5), at(15.1), at(15.3), at(21.3), at(21.5)]));
  const ov = P.overlay(ob.positions, pm);
  check('...the overlay is every leaf, coloured by the project: ' + ov.positions.length / 9 + ' triangles, grey #8E9089 at the base',
    ov.positions.length / 9 === leaves && ov.colors.length === ov.positions.length && Math.abs(ov.colors[0] - 0x8E / 255) < 1e-6);
  const cp = P.clone(pm);
  cp.codes[0] = null;
  check('...a clone is its own copy', pm.codes[0] && cp.triangles === pm.triangles);

  section('Filament per part (model_settings.config), no paint');
  {
    const xml = '<config><object id="2"><metadata key="extruder" value="2"/><part id="1"><metadata key="extruder" value="3"/></part><part id="5"/></object><object id="7"/></config>';
    const e = R.parseModelSettingsExtruders(xml);
    check('an object\'s extruder, and a part\'s own over it', e['2'].ext === 2 && e['2'].parts['1'] === 3 && !e['2'].parts['5'] && e['7'].ext === 0, JSON.stringify(e));
    check('...an unpainted piece whose parts all print with filament 1 carries no paint', P.make([null, null], null, new Uint8Array([1, 1]), []) === null &&
      P.make([null, null], null, new Uint8Array([1, 2]), []) !== null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

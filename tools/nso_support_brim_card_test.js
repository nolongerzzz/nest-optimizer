#!/usr/bin/env node
/* ============================================================
   tools/nso_support_brim_card_test.js - the supports card builds the brim with the supports.   (npm run support:brim-card)

   The owner's note (supports-one-trunk, fourth round): the brim is the supports' own - built with them by the card, so it goes to the plate,
   the slicer and Studio with the pad it meets. The card (app-supports-card.js, run in Node with the engine and the slicer, tools/
   nso_support_plate_lib.js) on the fixture's six heads:

   1. Generate on Base and on Circular (tall stems): the supports AND one more plate piece, "<piece> - brim", labelled nsoSupport.brim, one first
      layer thick (z 0 - 0.2), settings of ten wall loops; the count line says 1 support, not 2; the brim is off every pad and the piece;
   2. the brim comes off with the supports on ONE Undo; "Brim round the foot" unticked builds none; no slicer, no brim - and a build all the same;
   3. sliced as G-scope slices the plate (role 'brim' for the brim, 'support' for the rest): Brim lines on the first layer, ten loops in all,
      no conflict, none of the part's own.
   ============================================================ */
'use strict';
const path = require('path');
const lib = require('./nso_support_plate_lib.js');
const SL = require('../nso_slicer.js');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok    ' + n + (d ? '   ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '   ' + d : '')); } };

(async () => {
  const objs = await lib.readFixture(path.join(lib.ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const by = n => objs.find(o => o.name === n);
  const WASM = await SL.loadKernel({});
  for (const name of ['Support Base.stl', 'Support Circular.stl']) {
    console.log('\n=== ' + name + ' ===');
    const app = lib.makeApp({ slicer: true });
    const ids = app.load([by(name)]);
    app.openCard(); app.card.pick(ids[0]);
    const before = app.state.models.length;
    const res = await app.card.generate();
    const sups = app.supportsOf(ids[0]), brims = sups.filter(m => m.nsoSupport.brim), tree = sups.filter(m => !m.nsoSupport.brim);
    check('built; the supports and one brim piece', res.ok && tree.length >= 1 && brims.length === 1, app.head());
    check('the count line counts supports, not the brim', new RegExp('^Built: ' + tree.length + ' support' + (tree.length === 1 ? '' : 's')).test(app.head()), app.head());
    const b = brims[0], soup = app.soupOf(b.id);
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 2; i < soup.length; i += 3) { z0 = Math.min(z0, soup[i]); z1 = Math.max(z1, soup[i]); }
    check('named "<piece> - brim", one first layer thick, ten wall loops for Studio', / - brim$/.test(b.name) && Math.abs(z1 - z0 - 0.2) < 1e-4 && b.slicerSettings && b.slicerSettings.wall_loops === '10', b.name + ' z ' + z0.toFixed(2) + ' - ' + z1.toFixed(2));
    const padLo = Math.min(...tree.map(m => { const q = app.soupOf(m.id); let lo = Infinity; for (let i = 2; i < q.length; i += 3) lo = Math.min(lo, q[i]); return lo; }));
    check('the brim stands where the pads do: its bottom on the pads\' (the plate\'s first layer)', Math.abs(z0 - padLo) < 1e-4, z0.toFixed(3) + ' / ' + padLo.toFixed(3));
    /* 3. the slice, as G-scope hands it */
    const part = app.soupOf(ids[0]);
    const objects = [{ name: 'part', soup: part, key: 1, role: 'part' }].concat(sups.map((m, i) => ({ name: m.name, soup: app.soupOf(m.id), key: 10 + i, role: m.nsoSupport.brim ? 'brim' : 'support', hostKey: 1 })));
    const r = SL.sliceObjects(objects, SL.defaultsFor(0.4, { supportInterfaceLayers: 3, brimType: 'auto' }), WASM);
    const bo = r.objects.find(o => o.role === 'brim');
    check('sliced: the brim piece is Brim lines on the first layer, the part grows none, no conflict',
      bo && bo.layers[0].paths.length >= 5 && bo.layers[0].paths.every(p => p.feature === 'Brim') && !r.objects[0].layers[0].paths.some(p => p.feature === 'Brim') && r.conflicts.length === 0,
      bo ? bo.layers[0].paths.length + ' loops, ' + r.conflicts.length + ' conflicts' : 'no brim object');
    app.undo();
    check('ONE Undo takes the brim off with the supports', app.state.models.length === before && app.supportsOf(ids[0]).length === 0, app.state.models.length + ' models');
    /* 2. unticked, and without the slicer */
    app.el('sup-brim').checked = false;
    const r2 = await app.card.generate();
    check('"Brim round the foot" unticked: the supports, no brim piece', r2.ok && app.supportsOf(ids[0]).length >= 1 && !app.supportsOf(ids[0]).some(m => m.nsoSupport.brim));
  }
  const bare = lib.makeApp();
  const ids = bare.load([by('Support Base.stl')]);
  bare.openCard(); bare.card.pick(ids[0]);
  const r3 = await bare.card.generate();
  check('no slicer on the page: the supports build all the same, with no brim', r3.ok && bare.supportsOf(ids[0]).length >= 1 && !bare.supportsOf(ids[0]).some(m => m.nsoSupport.brim));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

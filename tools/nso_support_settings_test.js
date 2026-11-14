#!/usr/bin/env node
/* ============================================================
   tools/nso_support_settings_test.js - THE CARD'S ADVANCED NUMBERS AND SAVED SETTINGS (npm run support:settings)

   The Supports card's Advanced section hands the flow tree's own numbers to the planner, and Saved settings keeps every lever of the card
   under a name. Asked here, on the card itself (tools/nso_support_plate_lib.js, no browser):
     - Advanced left alone sends nothing; a number changed is sent, alone, and reaches the planner held to its range
     - a saved setting puts every control back; a name saved twice is replaced; Delete takes it away
     - Export and Import carry them between browsers, and a file of anything else is refused
     - May rest on the part reaches the flow tree: a ceiling over the part's own floor is held from the floor, in one support
   ============================================================ */
'use strict';
const path = require('path');
const lib = require('./nso_support_plate_lib.js');
const SL = require(path.join(lib.ROOT, 'nso_slicer.js'));

let pass = 0, fail = 0; const failed = [];
function check(name, ok, note) { if (ok) pass++; else { fail++; failed.push(name); } console.log((ok ? '  ok    ' : '  FAIL  ') + name + (note ? '   ' + note : '')); }

function setup() {
  const app = lib.makeApp();
  const mem = {};
  app.ctx.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  app.ctx.nsoSupportInterfaceRule = () => 'column';
  app.ctx.NSO_Slicer = SL;
  /* the card's controls, as index.html has them */
  const vals = { 'sup-angle': '30', 'sup-style': 'tree', 'sup-size': '1.2', 'sup-tree-distance': '5', 'sup-tree-diameter': '2', 'sup-tree-angle': '45', 'sup-tree-dangle': '5', 'sup-tree-tip': '0.8',
    'sup-interface': '3', 'slice-set-iface-angle': 'studio36', 'slice-set-raft': '0', 'slice-set-raft-gap': '0.1',
    'sup-adv-cover': '0.44', 'sup-adv-tipdrop': '2.8', 'sup-adv-gather': '0.25', 'sup-adv-reach': '0.95', 'sup-adv-floor': '2.4', 'sup-adv-flare': '2', 'sup-adv-flaretan': '0.45',
    'sup-adv-pad': '0.6', 'sup-adv-xy': '0.45', 'sup-adv-bottom': '0.2' };
  Object.keys(vals).forEach(id => { app.el(id).value = vals[id]; });
  ['sup-rest', 'sup-small', 'sup-brim', 'sup-raft'].forEach(id => { app.el(id).type = 'checkbox'; });
  app.el('sup-raft').checked = true;
  return { app, mem, vals };
}

(async () => {
  console.log('=== 1. Advanced ===');
  let { app, mem } = setup();
  const SET = app.card.settings;
  check('the card has its settings', !!SET && Array.isArray(SET.fields) && SET.fields.length >= 26, SET ? SET.fields.length + ' levers' : '');
  check('Advanced left alone sends nothing', SET.advanced() === null);
  app.el('sup-adv-tipdrop').value = '1.6'; app.el('sup-adv-gather').value = '0.5';
  check('a number changed is sent, and only it', JSON.stringify(SET.advanced()) === JSON.stringify({ tipDropMm: 1.6, gather: 0.5 }), JSON.stringify(SET.advanced()));
  app.el('sup-adv-tipdrop').value = 'x';
  check('a field that is not a number is its default', JSON.stringify(SET.advanced()) === JSON.stringify({ gather: 0.5 }));

  console.log('\n=== 2. Saved settings ===');
  app.el('sup-adv-tipdrop').value = '1.6'; app.el('sup-angle').value = '46'; app.el('sup-rest').checked = true; app.el('sup-tree-distance').value = '4';
  check('Save keeps them under a name', SET.save('PLA slim') === true && JSON.stringify(SET.names()) === '["PLA slim"]');
  const saved = SET.now();
  app.el('sup-adv-tipdrop').value = '2.8'; app.el('sup-angle').value = '30'; app.el('sup-rest').checked = false; app.el('sup-tree-distance').value = '5'; app.el('sup-adv-gather').value = '0.25';
  check('...and a pick puts every control back', SET.pick('PLA slim') === true && JSON.stringify(SET.now()) === JSON.stringify(saved),
    'angle ' + app.el('sup-angle').value + ', rest ' + app.el('sup-rest').checked + ', tip column ' + app.el('sup-adv-tipdrop').value);
  app.el('sup-angle').value = '40';
  check('a name saved again is replaced, not doubled', SET.save('PLA slim') && SET.names().length === 1 && JSON.parse(mem['nso.supports.settings.v1'])['PLA slim']['sup-angle'] === '40');
  check('a name of nothing is not saved', SET.save('   ') === false && SET.names().length === 1);
  SET.save('TPU');
  const text = SET.exportText();
  check('Export is one file of every saved setting', /nso-supports-settings/.test(text) && Object.keys(JSON.parse(text).settings).length === 2);
  check('Delete takes one away', SET.remove('TPU') === true && JSON.stringify(SET.names()) === '["PLA slim"]' && SET.remove('none such') === false);
  ({ app, mem } = setup());
  check('Import reads them into another browser', app.card.settings.importText(text) === 2 && JSON.stringify(app.card.settings.names()) === '["PLA slim","TPU"]');
  check('...and a pick there sets the card as it was saved', app.card.settings.pick('PLA slim') && app.el('sup-angle').value === '40' && app.el('sup-rest').checked === true && app.el('sup-adv-tipdrop').value === '1.6');
  check('a file of anything else is refused, and nothing is lost', app.card.settings.importText('{"a":1}') === 0 && app.card.settings.importText('not json') === 0 && app.card.settings.names().length === 2);
  check('only the card\'s own controls are read from a file', (() => { app.card.settings.importText(JSON.stringify({ what: 'nso-supports-settings', settings: { X: { 'sup-angle': '33', 'btn-sup-all': 'boo', onclick: 'alert(1)', 'sup-size': { a: 1 } } } })); return JSON.stringify(JSON.parse(mem['nso.supports.settings.v1']).X) === '{"sup-angle":"33"}'; })());

  console.log('\n=== 3. They reach the planner: a ceiling over the part\'s own floor ===');
  ({ app, mem } = setup());
  /* a shelter: a floor 40 x 40 x 2, a back wall, a roof 14 - 16 over all of it, open on three sides. The middle of its ceiling is further from the floor's
     edge than a branch can lean on its way down: no way to the plate. */
  const b = lib.boxSoup, soup = [].concat(b(0, 0, 0, 40, 40, 2), b(0, 0, 2, 2, 40, 14), b(0, 0, 14, 40, 40, 16));
  const seen = [], GP = app.ctx.NSO_SupportGridpack, plan0 = GP.plan;
  GP.plan = function (tris, opts) { const p = plan0.apply(this, arguments); seen.push({ opts, p }); return p; };
  const build = async (rest, adv) => {
    seen.length = 0;
    app.el('sup-rest').checked = !!rest;
    Object.keys(adv || {}).forEach(id => { app.el(id).value = adv[id]; });
    if (!app.state.placed.length) { app.load([{ id: 1, name: 'cup', positions: Float32Array.from(soup), triangleCount: soup.length / 9 }]); app.openCard(); app.setPlateBox(true); app.card.angle(30); }
    app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
    return app.head();
  };
  let head = await build(false);
  check('plate only: the middle of the ceiling is unreachable, said so', /unreachable [1-9]/.test(head) && seen.length === 1 && seen[0].opts.flowKnobs === undefined && !!seen[0].p.flow && seen[0].p.flow.rests.length === 0, head);
  head = await build(true, { 'sup-adv-tipdrop': '2', 'sup-adv-bottom': '0.3', 'sup-adv-gather': '7' });
  const last = seen[seen.length - 1] || {}, fl = last.p && last.p.flow;
  check('May rest on the part: one plan, the flow tree\'s, with nothing unreachable', seen.length === 1 && !!fl && /unreachable 0/.test(head) && /Built: 1 support/.test(head), head);
  check('...feet on the part\'s floor (z 2) under the middle', !!fl && fl.rests.length >= 1 && fl.rests.every(r => Math.abs(r.z - (last.p.plateZ + 2)) < 1e-4), fl ? fl.rests.length + ' foot/feet on the part, ' + fl.trunks.length + ' on the plate' : '');
  check('...the Advanced numbers went with it, each held to its range (gather 7 -> 1)', !!fl && JSON.stringify(last.opts.flowKnobs) === JSON.stringify({ tipDropMm: 2, gather: 7, bottomGapMm: 0.3 }) &&
    fl.advGiven.gather === 1 && fl.advGiven.tipDropMm === 2 && fl.adv.bottomGapMm === 0.3, fl ? JSON.stringify(fl.advGiven) : '');
  check('...and the tips stand 2 mm of column, as asked', !!fl && fl.branches.filter(x => x.tip != null && !x.twig).every(x => x.pts[0][2] - x.pts[1][2] >= 1.99 && x.pts[0][2] - x.pts[1][2] < 2.45));
  const sup = app.allSupports();
  check('...one support, closed', sup.length === 1 && lib.closedAndWound(Array.from(app.soupOf(sup[0].id))).closed !== false);

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  if (fail) { failed.forEach(f => console.log('  ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

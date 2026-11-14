#!/usr/bin/env node
/* ============================================================
   tools/nso_support_advanced_test.js - BAMBU'S ADVANCED SUPPORT ROWS, FROM THE CARD TO THE FILE (npm run support:advanced)

   docs/SUPPORT-ADVANCED.md. The rows are Slice settings (app-print.js). Asked here, in Node:
     - a card left alone hands the slicer what it used before the rows existed, and writes no key into the file
     - each row, changed, reaches the slicer as its option and the file as Bambu's own key - and only that one
     - a value out of its range is held to it; a pattern nobody knows is the default
     - the rows that shape the tree reach the planner (the Supports card: tools/nso_support_plate_lib.js)
   The slicer's side of every row is tools/nso_slicer_support_levers_test.js.
   ============================================================ */
'use strict';
const path = require('path');
const L = require('./print-planner/lib.js');
const ROOT = path.join(__dirname, '..');
const PRINT = require(path.join(ROOT, 'app-print.js'));
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const lib = require('./nso_support_plate_lib.js');

let pass = 0, fail = 0; const failed = [];
function check(name, ok, note) { if (ok) pass++; else { fail++; failed.push(name); } console.log((ok ? '  ok    ' : '  FAIL  ') + name + (note ? '   ' + note : '')); }

/* row -> [settings field, a changed value, the slicer's option and its value, Bambu's key and its text] */
const ROWS = [
  ['Initial layer density', 'supDensity', 90, 'supportFirstLayerDensity', 0.9, 'raft_first_layer_density', '90%'],
  ['Initial layer expansion', 'supExpand', 1.5, null, null, 'raft_first_layer_expansion', '1.5'],
  ['Support wall loops', 'supWalls', 2, 'supportWallLoops', 2, 'tree_support_wall_count', '2'],
  ['Top Z distance', 'supTopZ', 0.2, 'supportGapMm', 0.2, 'support_top_z_distance', '0.2'],
  ['Bottom Z distance', 'supBottomZ', 0.3, 'supportBottomGapMm', 0.3, 'support_bottom_z_distance', '0.3'],
  ['Base pattern', 'supBase', 'rectilinear-grid', 'supportBasePattern', 'rectilinear-grid', 'support_base_pattern', 'rectilinear-grid'],
  ['Base pattern spacing', 'supBaseSpacing', 3.5, 'supportBaseSpacingMm', 3.5, 'support_base_pattern_spacing', '3.5'],
  ['Pattern angle', 'supAngle', 30, 'supportAngleDeg', 30, 'support_angle', '30'],
  ['Interface pattern', 'supIfacePattern', 'concentric', 'supportInterfacePattern', 'concentric', 'support_interface_pattern', 'concentric'],
  ['Top interface spacing', 'supIfaceSpacing', 0.1, 'supportInterfaceSpacingMm', 0.1, 'support_interface_spacing', '0.1'],
  ['Normal Support expansion', 'supExpansion', 0.5, 'supportExpansionMm', 0.5, 'support_expansion', '0.5'],
  ['Support/object xy distance', 'supXy', 0.5, 'supportXyMm', 0.5, 'support_object_xy_distance', '0.5'],
  ['Z overrides X/Y', 'supZOverXy', true, 'supportZOverridesXy', true, 'top_z_overrides_xy_distance', '1'],
  ['Support/object first layer gap', 'supFirstGap', 0.5, 'supportFirstLayerGapMm', 0.5, 'support_object_first_layer_gap', '0.5'],
  ['Max bridge length', 'supBridge', 0, null, null, 'max_bridge_length', '0'],
  ['Independent support layer height', 'supIndep', false, 'supportLayerMaxMm', 0, 'independent_support_layer_height', '0']
];
const KEYS = ROWS.map(r => r[5]);

(async () => {
  const tpl = await L.a1Template(), a1 = L.printer('a1mini-0.4');
  const plate = await L.plateA(tpl);
  const pieces = plate.objs.map(o => { const s = Float32Array.from(o.soup); for (let i = 0; i < s.length; i += 3) { s[i] -= a1.bed.x / 2; s[i + 1] -= a1.bed.y / 2; } return Object.assign({}, o, { soup: s, support: o.role === 'support' }); });
  const objs = PRINT.pieceObjects(pieces.map(p => p.support ? Object.assign({}, p, { interfaceLayers: 3, sheetLayerMm: 0.275 }) : p), a1.bed).slice(0, 2);
  const base = PRINT.settingsFromConfig(tpl), D = PRINT.SETTINGS_DEFAULT;
  const realRun = SL.run;
  const run = async (settings) => {
    let seen = null;
    SL.run = function (ob, o) { seen = o; return realRun.apply(this, arguments); };
    let out; try { out = await PRINT.build(objs, { config: tpl, printer: a1 }, settings ? { settings } : {}); } finally { SL.run = realRun; }
    return { o: seen, out };
  };

  console.log('=== 1. Left alone ===');
  check('the card starts every row at this slicer\'s own value; the pattern angle and the interface spacing at the profile\'s',
    ROWS.every(r => JSON.stringify(base[r[1]]) === JSON.stringify(D[r[1]])) && base.supDensity === 100 && base.supExpand === -1 && base.supWalls === -1 && base.supTopZ === 0.18 &&
    base.supBase === 'default' && base.supIfacePattern === 'default' && base.supXy === 0.35 && base.supBridge === 5 && base.supIndep === true && base.supZOverXy === false,
    JSON.stringify(ROWS.map(r => base[r[1]])));
  check('an untouched card writes none of the support keys', KEYS.every(k => !(k in PRINT.configOverlay(tpl, base))));
  const none = await run(null), same = await run(base);
  const optKeys = ROWS.map(r => r[3]).filter(Boolean);
  check('...and hands the slicer what it used with no settings at all', optKeys.every(k => JSON.stringify(none.o[k]) === JSON.stringify(same.o[k])) && same.out.ok && KEYS.every(k => same.out.changed.indexOf(k) < 0),
    optKeys.filter(k => JSON.stringify(none.o[k]) !== JSON.stringify(same.o[k])).map(k => k + ' ' + none.o[k] + ' -> ' + same.o[k]).join(', '));
  check('...the same G-code, line for line', none.out.ok && same.out.ok && none.out.gcode === same.out.gcode);

  console.log('\n=== 2. Each row, changed ===');
  for (const r of ROWS) {
    const st = Object.assign({}, base, { [r[1]]: r[2] }), over = PRINT.configOverlay(tpl, st);
    const mine = KEYS.filter(k => k in over);
    let okOpt = true, got = '';
    if (r[3]) { const res = await run(st); got = JSON.stringify(res.o[r[3]]); okOpt = res.out.ok && Math.abs(+res.o[r[3]] - +r[4]) < 1e-9 || res.o[r[3]] === r[4]; okOpt = okOpt && res.out.changed.indexOf(r[5]) >= 0; }
    check(r[0] + ': ' + r[5] + ' = ' + r[6] + (r[3] ? ', the slicer\'s ' + r[3] : ' (the Supports card\'s: the tree and the detector read it)'),
      mine.length === 1 && mine[0] === r[5] && over[r[5]] === r[6] && okOpt, 'keys ' + JSON.stringify(mine) + ' ' + over[r[5]] + (r[3] ? ', option ' + got : ''));
  }
  const all = Object.assign({}, base); ROWS.forEach(r => { all[r[1]] = r[2]; });
  const back = PRINT.settingsFromConfig(PRINT.withOverlay(tpl, PRINT.configOverlay(tpl, all)));
  check('the pattern angle and the interface spacing read back off the file', back.supAngle === 30 && back.supIfaceSpacing === 0.1);

  console.log('\n=== 3. Held to their ranges ===');
  const c = PRINT.cleanSettings(Object.assign({}, base, { supDensity: 500, supExpand: -7, supWalls: 99, supTopZ: -1, supBottomZ: 9, supBase: 'lightning', supBaseSpacing: 0, supAngle: 400,
    supIfacePattern: 'spiral', supIfaceSpacing: 50, supExpansion: -9, supXy: 99, supZOverXy: 'yes', supFirstGap: -1, supBridge: 1e9, supIndep: 'false' }));
  check('a number out of range is held to its end; a pattern nobody knows is Default; a tick is a tick',
    c.supDensity === 100 && c.supExpand === -1 && c.supWalls === 5 && c.supTopZ === 0 && c.supBottomZ === 2 && c.supBase === 'default' && c.supBaseSpacing === 0.5 && c.supAngle === 180 &&
    c.supIfacePattern === 'default' && c.supIfaceSpacing === 5 && c.supExpansion === -2 && c.supXy === 3 && c.supZOverXy === false && c.supFirstGap === 0 && c.supBridge === 100 && c.supIndep === false, JSON.stringify(ROWS.map(r => c[r[1]])));
  check('Bambu\'s own word for the default interface pattern (auto) is Default', PRINT.cleanSettings({ supIfacePattern: 'auto' }).supIfacePattern === 'default');

  console.log('\n=== 4. The rows that shape the tree reach the planner (the Supports card) ===');
  const app = lib.makeApp();
  app.ctx.nsoSupportInterfaceRule = () => 'column'; app.ctx.NSO_Slicer = SL;
  const b = lib.boxSoup, soup = [].concat(b(0, 0, 0, 40, 40, 2), b(0, 0, 2, 2, 40, 14), b(0, 0, 14, 40, 40, 16));
  const seen = [], GP = app.ctx.NSO_SupportGridpack, plan0 = GP.plan;
  GP.plan = function (tris, opts) { const p = plan0.apply(this, arguments); seen.push({ opts, p }); return p; };
  app.load([{ id: 1, name: 'shelter', positions: Float32Array.from(soup), triangleCount: soup.length / 9 }]); app.openCard(); app.setPlateBox(true); app.card.angle(30);
  app.el('sup-rest').checked = true;
  check('rows left alone send the planner nothing', app.card.settings.advanced() === null);
  app.el('slice-set-sup-expand').value = '1.5'; app.el('slice-set-sup-bottomz').value = '0.3'; app.el('slice-set-sup-xy').value = '0.5';
  check('Initial layer expansion, Bottom Z distance and the xy distance are the tree\'s pad, its gap over the part and its clearance (a tenth more than the slicer cuts)',
    JSON.stringify(app.card.settings.advanced()) === JSON.stringify({ padGrowMm: 1.5, bottomGapMm: 0.3, xyMm: 0.6 }), JSON.stringify(app.card.settings.advanced()));
  app.el('slice-set-sup-expand').value = '-1';
  check('Initial layer expansion -1 is automatic: nothing sent for it', JSON.stringify(app.card.settings.advanced()) === JSON.stringify({ bottomGapMm: 0.3, xyMm: 0.6 }));
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const fl = seen.length ? seen[seen.length - 1].p.flow : null;
  check('...and a build is given them', !!fl && fl.adv.bottomGapMm === 0.3 && fl.advGiven.xyMm === 0.6 && /unreachable 0/.test(app.head()), app.head());
  const spots = (bridge) => { app.el('slice-set-sup-bridge').value = String(bridge); app.el('slice-set-sup-bridge').fire('change'); return app.card.view(); };
  /* a bridge: two posts 12 mm apart with a beam across */
  const app2 = lib.makeApp(); app2.ctx.nsoSupportInterfaceRule = () => 'column';
  const beam = [].concat(b(0, 0, 0, 4, 6, 10), b(16, 0, 0, 20, 6, 10), b(0, 0, 10, 20, 6, 12));
  app2.load([{ id: 1, name: 'beam', positions: Float32Array.from(beam), triangleCount: beam.length / 9 }]); app2.openCard(); app2.setPlateBox(true); app2.card.angle(30);
  const count = () => (app2.card.view().areas || []).reduce((n, a) => n + (a.count || 0), 0);
  const set = (v) => { app2.el('slice-set-sup-bridge').value = String(v); app2.card.refresh ? app2.card.refresh() : app2.card.angle(30); return count(); };
  const n5 = count(), n0 = set(0), n20 = set(20);
  check('Max bridge length: a 12 mm bridge is held at 5 (and at 0), and is a bridge - nothing to hold - at 20', n5 > 0 && n0 >= n5 && n20 === 0, n5 + ' spot(s) at 5, ' + n0 + ' at 0, ' + n20 + ' at 20');
  void spots;

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  if (fail) { failed.forEach(f => console.log('  ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

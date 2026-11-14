#!/usr/bin/env node
/* ============================================================
   tools/nso_print_card_test.js - THE PRINT CARD, headless (npm run print:card; docs/PRINT-CARD.md)

   The card with its Supports tick (#sup-on) is the Print card: Slice builds for the plate and slices. Held here, on a shelter (a roof on one
   wall over a floor), with the planner watched:
     - Slice with the tick on builds the tree; pressed again with nothing changed it builds nothing; a changed setting builds again
     - Assisted and Custom, Tree type, grow the flow tree Auto does (one planner): from the spots, and from the tips given, each one stood
     - Straight strut in Custom is still the lattice planner's (its circles, eraser and Tune are its own)
     - the tick off: Slice takes the plate's supports away
   The slice itself is the real page's (npm run support:settings-drive).
   ============================================================ */
'use strict';
const path = require('path');
const lib = require(path.join(__dirname, 'nso_support_plate_lib.js'));
let pass = 0, fail = 0; const failed = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); } else { fail++; failed.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); } }

(async () => {
  const app = lib.makeApp();
  app.ctx.nsoSupportInterfaceRule = () => 'column';
  app.el('sup-on').checked = true;                                     /* the Print card's tick: the card is the Print card */
  const b = lib.boxSoup, soup = [].concat(b(0, 0, 0, 40, 40, 2), b(0, 0, 2, 2, 40, 14), b(0, 0, 14, 40, 40, 16));
  const seen = [], GP = app.ctx.NSO_SupportGridpack, plan0 = GP.plan;
  GP.plan = function (tris, opts) { const p = plan0.apply(this, arguments); seen.push({ opts, p }); return p; };
  const ids = app.load([{ id: 1, name: 'shelter', positions: Float32Array.from(soup), triangleCount: soup.length / 9 }]); app.openCard(); app.card.angle(30);
  app.el('sup-rest').checked = true;                                   /* the floor is under the roof: the tree stands on it */
  const slice = async () => { const n = seen.length; app.click('btn-sup-all'); await app.until(() => app.card.busy(), 3000).catch(() => {}); await app.until(() => !app.card.busy()); return seen.slice(n); };
  const sups = () => app.supportsOf(ids[0]).length;

  console.log('=== Slice, Supports ticked ===');
  let runs = await slice(), last = runs[runs.length - 1];
  check('Auto builds the flow tree: one plan, no feed', runs.length >= 1 && !!last.p.flow && !last.opts.feed && last.opts.oneTrunk === true && sups() >= 1, app.head());
  const autoTips = last.p.held;
  /* three of the roof's own spots, far apart, in the plate's frame: where a hand would click a tip on */
  const spots = last.p.beacons.map(q => q.p), far = (q, l) => Math.min(...l.map(o => Math.hypot(o[0] - q[0], o[1] - q[1])));
  const tips = [spots[0]]; while (tips.length < 3) tips.push(spots.slice().sort((x, y) => far(y, tips) - far(x, tips))[0]);
  runs = await slice();
  check('Slice again with nothing changed plans nothing: the supports on the plate are kept', runs.length === 0 && sups() >= 1);
  app.el('sup-tree-distance').value = '4'; app.el('sup-tree-distance').fire('change');
  runs = await slice();
  check('a changed setting, then Slice: the supports are built again', runs.length >= 1 && !!runs[runs.length - 1].p.flow, runs.length ? runs[runs.length - 1].p.held + ' tip(s), were ' + autoTips : 'no plan');
  app.el('sup-tree-distance').value = '5'; app.el('sup-tree-distance').fire('change');

  console.log('\n=== one planner: Assisted and Custom grow the Tree type as Auto does ===');
  app.card.mode('assisted');
  runs = await slice(); last = runs[runs.length - 1];
  check('Assisted: the spots go to the flow tree (a feed, and the one-trunk build)', !!last && !!last.opts.feed && last.opts.feed.mode === 'assisted' && last.opts.oneTrunk === true && !!last.p.flow && last.p.ok, last ? last.p.reason : 'no plan');
  check('...thinned to the tips Auto stands, nothing unreachable', !!last && last.p.held === autoTips && last.p.unreachable.length === 0 && /unreachable 0/.test(app.head()), last ? last.p.held + ' / ' + autoTips + '   ' + app.head() : '');
  app.card.mode('custom');
  const placed = tips.map(p => app.card.placeTip(p, [0, 0, -1]));
  runs = await slice(); last = runs[runs.length - 1];
  check('Custom: the three tips given are the three tips stood - no thinning, none added', placed.every(r => r && r.ok) && !!last && last.opts.feed.mode === 'custom' && !!last.p.flow && last.p.held === 3 && last.p.beacons.length === 3 && last.p.unreachable.length === 0,
    last ? last.p.reason : JSON.stringify(placed));
  check('...and the support is on the plate', sups() >= 1, app.head());
  check('...no landing circles, eraser or Tune under the Tree type', app.el('sup-tools').hidden === true && app.el('sup-tune').hidden === true && app.card.tool() === 'tips');
  app.el('sup-style').value = 'strut'; app.el('sup-style').fire('change');
  runs = await slice(); last = runs[runs.length - 1];
  check('Straight strut in Custom is the lattice planner\'s still: a feed, no flow tree, its tools back', !!last && !!last.opts.feed && !last.opts.oneTrunk && !last.p.flow && app.el('sup-tools').hidden === false, last ? String(last.p.reason).slice(0, 120) : 'no plan');
  app.el('sup-style').value = 'tree'; app.el('sup-style').fire('change');

  console.log('\n=== Supports unticked ===');
  app.el('sup-on').checked = false; app.el('sup-on').fire('change');
  const had = sups();
  runs = await slice();
  check('Slice plans nothing and takes the plate\'s supports off', had >= 1 && runs.length === 0 && sups() === 0, had + ' -> ' + sups());
  app.el('sup-on').checked = true; app.el('sup-on').fire('change');
  runs = await slice();
  check('ticked again, Slice builds them again', runs.length >= 1 && sups() >= 1);

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  if (fail) { failed.forEach(f => console.log('  ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

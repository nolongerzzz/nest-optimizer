#!/usr/bin/env node
/* Lift's LIST - opening Lift reads every surface of the piece and lists what is on them - driven through the REAL
   app (1280 x 800). The pieces are fixtures/crop-wall/ (tools/nso_crop_wall_fixtures.js): a block with a square bump
   on its +x wall, a sphere with a dome bump, a cone with a pin on its slope. Before the list, Lift read the top and
   nothing else until a hover or a click on the right face told it where to look: "0 features found" on all three.
     node tools/nso_lift_list_drive_check.js        exit 0 = every gate held

     1. BLOCK: pressing Lift says "1 feature found" at once - not "0" - and the list holds one row, on the +x face; the
        top was read too and has nothing on it
     2. a row's Lift lifts that feature off the wall: one new piece, the block left with the bump gone, one Undo
     3. SPHERE and CONE: the bump on a curved surface is found and listed on open, "on a curved surface"
     4. a piece with nothing to lift says so, with an empty list
     5. a plate whose top has features is as it was: they are found on the top, the list names the top */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const L = require('./nso_lift_plate_drive_lib.js');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_plate_fixtures.js');

const C = L.makeCheck(), check = C.check;
const DIR = path.join(ROOT, 'fixtures', 'crop-wall');
const count = page => page.evaluate(() => document.getElementById('lift-count').textContent);
const list = page => page.evaluate(() => NSO_LIFT_PLATE.list());
const armOn = async (page, id) => {
  await L.selectRow(page, id);
  await page.click('#btn-lift');
  await page.waitForFunction(() => /found|nothing read/.test(document.getElementById('lift-count').textContent), null, { timeout: 120000 });
};
const disarm = async page => { if (await page.evaluate(() => NSO_LIFT_PLATE.isArmed())) await page.click('#btn-lift'); };

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  console.log('\n=== 1. the block with a bump on its +x wall ===');
  const bid = await loadSTL(page, path.join(DIR, 'block_bump.stl'));
  await armOn(page, bid);
  let cnt = await count(page), li = await list(page), sc = await page.evaluate(() => NSO_LIFT_PLATE.scan());
  check('pressing Lift says "1 feature found" at once', cnt === '1 feature found', cnt);
  check('...the list has one row, on the +x face', li.length === 1 && /on the \+x face$/.test(li[0].text) && li[0].surface === 'the +x face', JSON.stringify(li));
  check('...the top was read too, and has nothing on it', sc.surfaces.some(s => s.label === 'the top' && s.ok && s.features === 0), JSON.stringify(sc.surfaces));
  check('...and the card started on the surface that has the feature', li[0].here === true);
  const dom = await page.evaluate(() => { const b = document.getElementById('lift-list'); return { shown: !b.hidden, rows: b.querySelectorAll('.lift-row-item').length, go: b.querySelectorAll('.lift-row-go').length,
    text: b.textContent, strip: !document.getElementById('btn-lift-strip').disabled }; });
  check('the panel shows the list: one row with a Lift button, and Strip is on', dom.shown && dom.rows === 1 && dom.go === 1 && dom.strip, JSON.stringify(dom));
  await page.screenshot({ path: path.join(os.tmpdir(), 'lift-list-block.png') });

  console.log('\n=== 2. a row\'s Lift ===');
  const b0 = await L.plateState(page);
  await page.click('.lift-row-go');
  await page.waitForFunction(() => /Lifted|refused|failed/.test(document.getElementById('lift-readout').textContent), null, { timeout: 120000 });
  const a0 = await L.plateState(page), ro = await page.evaluate(() => document.getElementById('lift-readout').textContent);
  check('the Lift button on the row lifts that feature', /^Lifted 1 feature off block_bump/.test(ro), ro.slice(0, 120));
  check('...one new piece, one Undo step', a0.models.length === b0.models.length + 1 && a0.undo === b0.undo + 1, a0.models.length + ' pieces');
  cnt = await count(page); li = await list(page);
  check('the block is read again: 0 features, an empty list', /^0 features found/.test(cnt) && li.length === 0, cnt + ' · ' + li.length + ' rows');
  await page.evaluate(() => document.getElementById('btn-undo').click());
  await page.waitForTimeout(500);
  li = await list(page);
  check('one Undo puts the bump back, and it is listed again', (await L.plateState(page)).models.length === b0.models.length && li.length === 1, li.length + ' rows');
  await disarm(page);

  console.log('\n=== 3. the sphere and the cone: a bump on a curved surface ===');
  for (const [label, file] of [['sphere', 'sphere_bump.stl'], ['cone', 'cone_bump.stl']]) {
    const id = await loadSTL(page, path.join(DIR, file));
    await armOn(page, id);
    cnt = await count(page); li = await list(page);
    const ss = await page.evaluate(() => NSO_LIFT_PLATE.scan());
    check(label + ': Lift finds the bump on opening - "1 feature found", not 0', cnt === '1 feature found', cnt + ' · ' + JSON.stringify(ss.surfaces));
    check(label + ': it is listed, on a curved surface', li.length === 1 && li[0].surface === 'a curved surface' && li[0].here, JSON.stringify(li));
    await disarm(page);
  }

  console.log('\n=== 4. nothing to lift ===');
  const plain = path.join(os.tmpdir(), 'lift-list-plain-' + process.pid + '.stl');
  const box = (lo, hi) => { const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]], o = []; for (const t of f) for (const i of t) o.push(...v[i]); return new Float32Array(o); };
  writeSTL(plain, box([0, 0, 0], [30, 20, 8]));
  const pid = await loadSTL(page, plain);
  await armOn(page, pid);
  cnt = await count(page); li = await list(page);
  check('a plain block: 0 features found and an empty list', /^0 features found/.test(cnt) && li.length === 0 && await page.evaluate(() => document.getElementById('lift-list').hidden), cnt + ' · ' + li.length);
  await disarm(page);

  console.log('\n=== 5. a plate whose top has features is read as before ===');
  const bar = FX.barocke(), barSTL = path.join(os.tmpdir(), 'lift-list-barocke-' + process.pid + '.stl');
  writeSTL(barSTL, bar.soup);
  const rid = await loadSTL(page, barSTL);
  await armOn(page, rid);
  cnt = await count(page); li = await list(page);
  check('the Barocke plate: "22 features found", all on the top', cnt === '22 features found' && li.length === 22 && li.every(r => r.surface === 'the top'), cnt + ' · ' + li.length + ' rows');

  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => { console.log('\n' + (C.fails ? C.fails + ' check(s) FAILED: ' + C.failed.join('; ') : 'every check held (' + C.passes + ')')); process.exit(C.fails ? 1 : 0); }).catch(e => { console.error(e); process.exit(2); });

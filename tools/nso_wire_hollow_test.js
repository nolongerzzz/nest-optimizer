/* End-to-end evidence for the Hollow / Fill / Hollow-to-safe-min buttons,
   driven through the REAL app in Chromium.

   tools/nso_hollow_test.js proves the geometry. This proves the WIRING: that
   three buttons exist, that a click on each one reaches nso_hollow.js, that
   the result is committed the way every other geometry op commits, that Undo
   puts the piece back, and that the canonical checker - loaded in the same
   page, from the same nso_thickness.js the app itself uses - passes what comes
   out. A module that is right and a button that is not connected to it is a
   feature nobody has.

   node tools/nso_wire_hollow_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const r3 = x => (x == null ? '?' : Math.round(x * 1000) / 1000);

/* The piece as the app holds it, plus the CANONICAL wall verdict, measured in
   the page by the same module the buttons gate on. */
const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
        - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
        + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]));
  }
  const rep = NSO_Thickness.measureMesh(s, { probe: 12 });
  return {
    tris: s.length / 9, volume: v / 6,
    wall: { min: rep.min_mm, pass: rep.pass, thin: rep.thin, floor: rep.threshold_mm,
            text: NSO_Thickness.describe(rep) }
  };
});

/* The Finish menu is a <details> and its rows sit in collapsible groups; a
   user opens both before reaching a button, and so does this. */
const openMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-hollow');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
});

const waitStatus = (page, re) => page.waitForFunction((src) => {
  const el = document.getElementById('status');
  return el && new RegExp(src).test(el.textContent);
}, re.source, { timeout: 120000 });

withApp(async (page, logs) => {
  console.log('\n=== 1. the three buttons exist and are wired ===');
  const btns = await page.evaluate(() => ['btn-hollow', 'btn-hollow-safe', 'btn-fill'].map(id => {
    const b = document.getElementById(id);
    return { id, present: !!b, text: b ? b.textContent.trim() : null,
             wired: !!b && b.dataset.nsoWired === '1' };
  }));
  for (const b of btns) {
    check('#' + b.id + ' present in the DOM', b.present, b.present ? 'label "' + b.text + '"' : 'missing');
    check('  ...listener attached at load', b.wired);
  }
  check('the wall-thickness box is there and defaults over the floor',
        await page.evaluate(() => {
          const i = document.getElementById('inp-hollow-mm');
          return !!i && parseFloat(i.value) >= NSO_Thickness.floorFor(0.4);
        }));
  check('nso_hollow.js loaded into the page alongside it',
        await page.evaluate(() => typeof NSO_Hollow === 'object' && typeof NSO_Hollow.hollow === 'function'));
  check('...and it sees the canonical floor, not a literal of its own',
        await page.evaluate(() => NSO_Hollow.safeMinWall(0.1).mm === NSO_Thickness.floorFor(0.4)));

  console.log('\n=== 2. Hollow, on a real STL, through a real click ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await openMenu(page);
  const before = await measure(page);
  console.log('   before  tris ' + before.tris + '  vol ' + before.volume.toFixed(2));
  console.log('   before  ' + before.wall.text);

  await page.evaluate(() => { document.getElementById('inp-hollow-mm').value = '2'; });
  await page.click('#btn-hollow');
  await waitStatus(page, /Hollowed|refused/);
  const hollowStatus = await statusOf(page);
  const after = await measure(page);
  console.log('   after   tris ' + after.tris + '  vol ' + after.volume.toFixed(2));
  console.log('   after   ' + after.wall.text);
  console.log('   status: ' + hollowStatus);

  check('the click reached nso_hollow.js and it committed', /Hollowed to a 2 mm wall/.test(hollowStatus), hollowStatus.slice(0, 90));
  check('the piece gained the cavity\'s triangles', after.tris > before.tris, before.tris + ' -> ' + after.tris);
  check('...and lost volume, because a shell is lighter than the solid',
        after.volume < before.volume, before.volume.toFixed(2) + ' -> ' + after.volume.toFixed(2));
  check('THE CANONICAL CHECKER, IN THE PAGE, PASSES THE RESULT',
        after.wall.pass === true && after.wall.thin === 0, after.wall.text);
  check('...and the wall it measures is the 2 mm asked for, over the 0.42 floor',
        Math.abs(after.wall.min - 2) < 0.06 && after.wall.min >= after.wall.floor,
        r3(after.wall.min) + ' vs floor ' + r3(after.wall.floor));
  check('the status line reports the measurement it gated on',
        /wall measured .* against a 0\.42 mm floor/.test(hollowStatus), hollowStatus.slice(-70));

  console.log('\n=== 3. Undo puts the piece back ===');
  check('undo button enabled after Hollow',
        await page.evaluate(() => !document.getElementById('btn-undo').disabled));
  await page.click('#btn-undo');
  await waitStatus(page, /Undo: Hollow reverted/);
  const undone = await measure(page);
  check('Undo names the op - "Undo: Hollow reverted"', /Undo: Hollow reverted/.test(await statusOf(page)));
  check('...and the piece is the solid again',
        undone.tris === before.tris && Math.abs(undone.volume - before.volume) < 1e-6,
        undone.tris + ' tris, vol ' + undone.volume.toFixed(2));

  console.log('\n=== 4. Hollow refuses a wall under the canonical floor ===');
  await page.evaluate(() => { document.getElementById('inp-hollow-mm').value = '0.2'; });
  await page.click('#btn-hollow');
  await waitStatus(page, /refused/);
  const refuse = await statusOf(page);
  const kept = await measure(page);
  console.log('   status: ' + refuse);
  check('a 0.2 mm wall is refused', /Hollow refused/.test(refuse), refuse.slice(0, 84));
  check('...naming the 0.42 mm floor and the nozzle it came from',
        /0\.42 mm nozzle floor/.test(refuse) && /0\.4 mm nozzle/.test(refuse));
  check('...and the piece is untouched', kept.tris === before.tris, kept.tris + ' tris');

  console.log('\n=== 5. Hollow to safe min stops at the floor, not at the number ===');
  await page.evaluate(() => { document.getElementById('inp-hollow-mm').value = '0.2'; });
  await page.click('#btn-hollow-safe');
  await waitStatus(page, /Hollowed|refused/);
  const safeStatus = await statusOf(page);
  const safe = await measure(page);
  console.log('   status: ' + safeStatus);
  console.log('   after   ' + safe.wall.text);
  check('it runs where the plain Hollow refused', /Hollowed to a 0\.42 mm wall/.test(safeStatus),
        safeStatus.slice(0, 90));
  check('...at the floor, and it says the 0.2 mm was never printable',
        /0\.42 mm floor/.test(safeStatus), safeStatus.slice(-110));
  check('THE CANONICAL CHECKER PASSES IT', safe.wall.pass === true, safe.wall.text);
  check('...at the floor, measured', safe.wall.min >= safe.wall.floor - 1e-4,
        r3(safe.wall.min) + ' vs ' + r3(safe.wall.floor));
  await page.click('#btn-undo');
  await waitStatus(page, /Undo: Hollow reverted/);

  console.log('\n=== 6. Fill / Densify puts the interior back ===');
  await page.evaluate(() => { document.getElementById('inp-hollow-mm').value = '2'; });
  await page.click('#btn-hollow');
  await waitStatus(page, /Hollowed to a 2 mm wall/);
  const shelled = await measure(page);
  await page.click('#btn-fill');
  await waitStatus(page, /Filled|refused/);
  const filledStatus = await statusOf(page);
  const filled = await measure(page);
  console.log('   status: ' + filledStatus);
  check('Fill committed', /Filled 1 cavity/.test(filledStatus), filledStatus.slice(0, 84));
  check('the cavity\'s triangles are gone', filled.tris === before.tris,
        shelled.tris + ' -> ' + filled.tris + ' (solid was ' + before.tris + ')');
  check('...and the volume is the solid\'s again',
        Math.abs(filled.volume - before.volume) < 1e-4,
        filled.volume.toFixed(4) + ' vs ' + before.volume.toFixed(4));
  check('the canonical checker passes the filled piece', filled.wall.pass === true, filled.wall.text);
  check('Undo names Fill',
        (await page.evaluate(() => !document.getElementById('btn-undo').disabled)));
  await page.click('#btn-undo');
  await waitStatus(page, /Undo: Fill reverted/);
  check('...and reverts it', /Undo: Fill reverted/.test(await statusOf(page)));

  console.log('\n=== 7. Fill on a solid refuses rather than doing nothing quietly ===');
  await page.click('#btn-undo');   // back to the plain solid
  await page.waitForTimeout(200);
  await page.click('#btn-fill');
  await waitStatus(page, /refused/);
  const noFill = await statusOf(page);
  console.log('   status: ' + noFill);
  check('a solid has no cavity and is told so', /no enclosed cavity/.test(noFill), noFill.slice(0, 88));

  console.log('\n=== 8. the page stayed clean ===');
  const errs = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
  check('no page errors during any of it', errs.length === 0,
        errs.slice(0, 3).map(e => e.text).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' : 'passed ') + fails + ' failure(s)\n');
  if (fails) process.exitCode = 1;
});

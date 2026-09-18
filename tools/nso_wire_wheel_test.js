/* End-to-end evidence for the Pottery Wheel and the build-volume warning,
   driven through the real app.
   node tools/nso_wire_wheel_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_extend_test.js: real index.html, real script
   tags, real clicks, real undo. The headless proofs live in
   tools/nso_wheel_test.js and tools/nso_printer_fit_test.js; what this file
   exists to prove is that the controls are reachable, that the commit half
   rebuilds the piece the app actually draws, that undo restores it, that
   paint stands it down - and that the build-volume warning is LIVE: it
   appears while the piece is being thrown and clears when the machine
   changes, with nobody pressing Export. */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

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
  const st = (typeof NSO_edgeStats === 'function') ? NSO_edgeStats(s) : { open: -1, nm: -1 };
  return {
    tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
    size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) }
  };
});

const warning = page => page.evaluate(() => {
  const el = document.getElementById('build-volume-warning');
  return { present: !!el, hidden: el ? el.hidden : null, text: el ? el.textContent.trim() : '' };
});

/* The warning is driven by a requestAnimationFrame watcher, so give it a
   frame or two to notice rather than reading it in the same tick. */
const settle = (page, want) => page.waitForFunction((w) => {
  const el = document.getElementById('build-volume-warning');
  if (!el) return false;
  return w ? (!el.hidden && el.textContent.trim().length > 0) : el.hidden;
}, want, { timeout: 15000 });

const openWheelMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-wheel-ball');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
});

withApp(async (page, logs) => {
  console.log('\n=== 1. the controls exist and are reachable ===');
  const ui = await page.evaluate(() => {
    const ids = ['btn-wheel-ball', 'btn-wheel-open', 'btn-wheel-pull', 'btn-wheel-trim', 'btn-wheel-rim'];
    const inputs = ['inp-wheel-height', 'inp-wheel-radius', 'inp-wheel-wall', 'inp-wheel-nozzle',
      'inp-wheel-depth', 'inp-wheel-pull-z', 'inp-wheel-pull-dr', 'inp-wheel-trim-z', 'inp-wheel-rim-mm'];
    return {
      missing: ids.filter(i => !document.getElementById(i)),
      unwired: ids.filter(i => {
        const b = document.getElementById(i);
        return !b || b.dataset.nsoWired !== '1';
      }),
      missingInputs: inputs.filter(i => !document.getElementById(i)),
      modules: {
        printer: typeof NSO_Printer !== 'undefined',
        thickness: typeof NSO_Thickness !== 'undefined',
        wheel: typeof NSO_wheelBall === 'function',
        fit: typeof NSO_fitCheckAll === 'function'
      },
      floor: (typeof NSO_wheelFloor === 'function') ? NSO_wheelFloor(0.4) : null
    };
  });
  check('every wheel button is in the DOM', ui.missing.length === 0, ui.missing.join(','));
  check('every listener attached at load', ui.unwired.length === 0, ui.unwired.join(','));
  check('every wheel input is in the DOM', ui.missingInputs.length === 0, ui.missingInputs.join(','));
  check('nso_thickness.js and nso_printer.js are both loaded by index.html',
    ui.modules.thickness && ui.modules.printer);
  check('the wheel and the fit watcher are loaded', ui.modules.wheel && ui.modules.fit);
  check('the wall floor comes back from the canonical module in the page',
    ui.floor === 0.42, String(ui.floor));

  console.log('\n=== 2. a ball, thrown onto a real piece ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await openWheelMenu(page);
  const boxBefore = await measure(page);
  console.log('   box before  tris ' + boxBefore.tris + '  vol ' + boxBefore.volume.toFixed(1) +
              '  bbox ' + JSON.stringify(boxBefore.size));

  await page.fill('#inp-wheel-height', '60');
  await page.click('#btn-wheel-ball');
  await page.waitForFunction(() => /Ball centred/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const ball = await measure(page);
  const ballStatus = await statusOf(page);
  console.log('   status: ' + ballStatus);
  console.log('   ball        tris ' + ball.tris + '  open ' + ball.open + '  nm ' + ball.nm +
              '  vol ' + ball.volume.toFixed(1) + '  bbox ' + JSON.stringify(ball.size));
  check('the piece the app draws was actually replaced', ball.tris !== boxBefore.tris);
  check('the ball is closed - 0 open, 0 non-manifold', ball.open === 0 && ball.nm === 0,
    ball.open + ' open, ' + ball.nm + ' non-manifold');
  check('it is round - all three bbox axes equal',
    ball.size.x === ball.size.y && ball.size.y === ball.size.z, JSON.stringify(ball.size));
  check('the status line carries the material budget',
    /mm\^3 clay used/.test(ballStatus), ballStatus);
  check('a 60 mm target gives a 46.58 mm ball, as the sizing says',
    Math.abs(ball.size.x - 46.5836) < 0.01, ball.size.x + ' mm');

  console.log('\n=== 3. Open turns one profile into two ===');
  await page.click('#btn-wheel-open');
  await page.waitForFunction(() => /Opened/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const bowl = await measure(page);
  const openStatus = await statusOf(page);
  console.log('   status: ' + openStatus);
  console.log('   bowl        tris ' + bowl.tris + '  open ' + bowl.open + '  nm ' + bowl.nm +
              '  vol ' + bowl.volume.toFixed(1) + '  bbox ' + JSON.stringify(bowl.size));
  check('the shell holds far less material than the ball did',
    bowl.volume < ball.volume * 0.3, bowl.volume.toFixed(1) + ' of ' + ball.volume.toFixed(1) + ' mm^3');
  check('and it is still closed', bowl.open === 0 && bowl.nm === 0);
  check('the status names the cavity it made',
    /mm cavity radius/.test(openStatus) && /mm base/.test(openStatus), openStatus);

  console.log('\n=== 4. Pull at a height that is not the rim ===');
  await page.fill('#inp-wheel-pull-z', '12');
  await page.fill('#inp-wheel-pull-dr', '1.5');
  await page.click('#btn-wheel-pull');
  await page.waitForFunction(() => /Pulled|would take/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const pulled = await measure(page);
  const pullStatus = await statusOf(page);
  console.log('   status: ' + pullStatus);
  check('a pull at mid-height lands', /Pulled/.test(pullStatus), pullStatus);
  check('the piece gained material where the wall moved out',
    pulled.volume > bowl.volume, bowl.volume.toFixed(1) + ' -> ' + pulled.volume.toFixed(1) + ' mm^3');
  /* The default taper is narrow, so a pull at z = 12 must NOT reach the rim
     at z = 23.5 where the widest point is - the bbox staying put is the
     evidence that "at any height" means at that height and nowhere else. */
  check('...without moving the widest point, which is 11 mm away up at the rim',
    pulled.size.x === bowl.size.x, bowl.size.x + ' mm, untouched');
  const atPull = await page.evaluate(() => NSO_wheelRadiusAt(NSO_wheelSession.outer, 12));
  check('...and the wall at z = 12 did move', Math.abs(atPull - 1.5 - 0) > 0,
    'r = ' + atPull.toFixed(3) + ' mm there');
  check('and stayed closed', pulled.open === 0 && pulled.nm === 0);

  console.log('\n=== 5. both refusals are loud, and both say what to do next ===');
  const budget = await page.evaluate(() => {
    const p = NSO_wheelSession;
    const s = NSO_wheelSpan(p.outer);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const z = s.lo + (s.hi - s.lo) * i / 8;
      pts.push({ z, r: NSO_wheelRadiusAt(p.outer, z) + 60 });
    }
    return NSO_wheelRun('pull', { points: pts, carryInner: false }, 'Pulled');
  });
  const budgetStatus = await statusOf(page);
  console.log('   status: ' + budgetStatus);
  check('a pull past the clay on the wheel is refused', budget.ok === false);
  check('...and the status reads as a next action, not a dead end',
    /out of material: extend the rim or add clay here to continue/.test(budgetStatus), budgetStatus);
  const afterBudget = await measure(page);
  check('...leaving the piece exactly as it was',
    JSON.stringify(afterBudget) === JSON.stringify(pulled));

  const thin = await page.evaluate(() => {
    const p = NSO_wheelSession;
    const s = NSO_wheelSpan(p.outer);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const z = s.lo + (s.hi - s.lo) * (0.5 + 0.5 * i / 8);
      pts.push({ z, r: NSO_wheelRadiusAt(p.inner, z) + 0.1 });
    }
    return NSO_wheelRun('pull', { points: pts, carryInner: false }, 'Pulled');
  });
  const thinStatus = await statusOf(page);
  console.log('   status: ' + thinStatus);
  check('a pull under the nozzle floor is refused', thin.ok === false);
  check('...naming the floor the canonical module gave it',
    /under the 0\.420 mm nozzle floor/.test(thinStatus), thinStatus);
  check('...and reading as a next action',
    /pull less here, or add clay at this height first/.test(thinStatus));
  check('...leaving the piece exactly as it was',
    JSON.stringify(await measure(page)) === JSON.stringify(pulled));

  console.log('\n=== 6. Trim, then a rim extension that IS Extend ===');
  await page.fill('#inp-wheel-trim-z', '2');
  await page.click('#btn-wheel-trim');
  await page.waitForFunction(() => /Trimmed/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const trimStatus = await statusOf(page);
  const trimmed = await measure(page);
  console.log('   status: ' + trimStatus);
  check('the base is trimmed and the clay is accounted for',
    /Trimmed [\d.]+ mm\^3 off the base/.test(trimStatus), trimStatus);
  check('the piece is shorter', trimmed.size.y < pulled.size.y,
    pulled.size.y + ' -> ' + trimmed.size.y + ' mm');

  await page.fill('#inp-wheel-rim-mm', '10');
  await page.click('#btn-wheel-rim');
  await page.waitForFunction(() => /Rim extended|Rim extension refused/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const curvedRim = await statusOf(page);
  console.log('   status: ' + curvedRim);
  check('a curved rim is refused, and says to pull the wall straight first',
    /Pull the top of the wall straight first/.test(curvedRim), curvedRim);

  const straight = await page.evaluate(() => {
    const p = NSO_wheelSession;
    const s = NSO_wheelSpan(p.outer);
    const zMid = s.lo + (s.hi - s.lo) * 0.55;
    const rt = NSO_wheelRadiusAt(p.outer, zMid);
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ z: zMid + (s.hi - zMid) * i / 10, r: rt });
    return NSO_wheelRun('pull', { points: pts, reshapeWall: true }, 'Pulled straight');
  });
  check('the wall pulls straight', straight.ok === true, straight.reason);
  const beforeRim = await measure(page);
  await page.click('#btn-wheel-rim');
  await page.waitForFunction(() => /Rim extended/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const rimStatus = await statusOf(page);
  const afterRim = await measure(page);
  console.log('   status: ' + rimStatus);
  check('the rim extends through Extend, and the status says so',
    /Rim extended [\d.]+ mm by Extend/.test(rimStatus), rimStatus);
  check('...naming the cross-section it held', /cross-section held/.test(rimStatus));
  check('the piece grew by 10 mm in height',
    Math.abs((afterRim.size.y - beforeRim.size.y) - 10) < 0.01,
    beforeRim.size.y + ' -> ' + afterRim.size.y + ' mm');
  check('...and not one millimetre wider - a rim extension is not a scale',
    afterRim.size.x === beforeRim.size.x, beforeRim.size.x + ' mm');
  check('still closed after the extension', afterRim.open === 0 && afterRim.nm === 0);

  console.log('\n=== 7. Undo names the wheel ===');
  const undoEnabled = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo button enabled', undoEnabled);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const undoStatus = await statusOf(page);
  const undone = await measure(page);
  console.log('   status: ' + undoStatus);
  check('undo names the Pottery Wheel, not another bake',
    /Undo: Pottery Wheel reverted/.test(undoStatus), undoStatus);
  check('and the piece is back, exactly',
    undone.volume === beforeRim.volume && JSON.stringify(undone.size) === JSON.stringify(beforeRim.size),
    beforeRim.volume.toFixed(4) + ' -> ' + undone.volume.toFixed(4));

  console.log('\n=== 8. paint wins ===');
  await page.evaluate(() => {
    getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintedBefore = await measure(page);
  const painted = await page.evaluate(() => NSO_wheelRun('pull', { z: 10, dr: 1 }, 'Pulled'));
  const paintStatus = await statusOf(page);
  console.log('   status: ' + paintStatus);
  check('the wheel stands down on a painted piece', painted.ok === false, painted.reason);
  check('...naming the count', /Pottery Wheel stood down - 1 painted face/.test(paintStatus), paintStatus);
  check('...and leaving the piece untouched',
    JSON.stringify(await measure(page)) === JSON.stringify(paintedBefore));
  await page.evaluate(() => { getActiveModel().faceMask = null; });

  console.log('\n=== 9. the build-volume warning is LIVE ===');
  const quiet = await warning(page);
  check('#build-volume-warning is in the DOM', quiet.present);
  check('and silent while everything fits', quiet.hidden === true, 'text: "' + quiet.text + '"');

  /* Throw a floor vase past the A1 Mini's 180 mm build height, one rim
     extension at a time, exactly as section 5 of the headless suite does -
     but here, in the app, with the warning watched between presses. */
  await page.evaluate(() => {
    const sel = document.getElementById('plate-select');
    sel.value = 'a1mini';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const grow = await page.evaluate(async () => {
    NSO_wheelRun('ball', { height: 320, radius: 55, wall: 6 }, 'Ball centred');
    NSO_wheelRun('open', {}, 'Opened');
    const seen = [];
    for (let round = 0; round < 10; round++) {
      const p = NSO_wheelSession;
      const s = NSO_wheelSpan(p.outer);
      const zMid = s.lo + (s.hi - s.lo) * 0.45;
      const rt = NSO_wheelRadiusAt(p.outer, zMid);
      const pts = [];
      for (let i = 0; i <= 10; i++) pts.push({ z: zMid + (s.hi - zMid) * i / 10, r: rt });
      if (!NSO_wheelRun('pull', { points: pts, reshapeWall: true }, 'Raised').ok) break;
      if (!NSO_wheelRun('rim', { delta: 30 }, 'Rim extended').ok) break;
      const sp = NSO_wheelSpan(NSO_wheelSession.outer);
      const f = NSO_wheelFitReport(NSO_wheelSession);
      seen.push({ height: +(sp.hi - sp.lo).toFixed(2), fits: f.fits });
      if (!f.fits) break;
    }
    return seen;
  });
  console.log('   stages: ' + grow.map(s => s.height + (s.fits ? '' : ' TOO BIG')).join(', '));
  check('the vase was raised past the A1 Mini on the wheel',
    grow.length > 1 && grow[grow.length - 1].fits === false,
    grow.length + ' stages, last ' + (grow.length ? grow[grow.length - 1].height : '?') + ' mm');

  await settle(page, true);
  const fired = await warning(page);
  console.log('   warning: ' + fired.text);
  check('the warning appeared without anyone pressing Export', !fired.hidden);
  check('...naming the machine', /Bambu A1 Mini/.test(fired.text), fired.text);
  check('...and the axis and the overhang', /Z [\d.]+ mm is [\d.]+ mm over the 180 mm limit/.test(fired.text));
  check('...and not the bed axes, which are fine',
    !/X [\d.]+ mm is/.test(fired.text) && !/Y [\d.]+ mm is/.test(fired.text));

  console.log('\n=== 10. ...and it tracks the machine, not the piece ===');
  await page.evaluate(() => {
    const sel = document.getElementById('plate-select');
    sel.value = 'a1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(page, false);
  const bigger = await warning(page);
  check('switching to a 256 mm machine clears the warning, with the piece untouched',
    bigger.hidden === true, 'text: "' + bigger.text + '"');

  await page.evaluate(() => {
    const sel = document.getElementById('plate-select');
    sel.value = 'custom';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const h = document.getElementById('custom-h');
    h.value = '50';
    h.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page, true);
  const custom = await warning(page);
  console.log('   warning: ' + custom.text);
  check('a custom machine only 50 mm tall brings it straight back',
    !custom.hidden && /50 mm limit/.test(custom.text), custom.text);
  check('...and the custom build height is a real field on the Plate card',
    await page.evaluate(() => !!document.getElementById('custom-h')));

  console.log('\n=== 11. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-soften', 'btn-seal', 'btn-solidify', 'btn-join',
    'btn-mask-paint', 'btn-smooth', 'btn-extend', 'btn-export-stl', 'btn-optimize']
    .filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

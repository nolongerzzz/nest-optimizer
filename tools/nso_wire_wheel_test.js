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
    const ids = ['btn-wheel-ball', 'btn-wheel-flatten', 'btn-wheel-open'];
    const inputs = ['rng-wheel-scale', 'rng-wheel-wall', 'rng-wheel-flat', 'rng-wheel-open', 'rng-wheel-tall', 'rng-wheel-pull-z',
      'rng-wheel-pull-dr', 'rng-wheel-soft', 'rng-wheel-trim', 'rng-wheel-rim'];
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

  console.log('\n=== 1b. the start: an empty plate, nothing typed, nothing selected ===');
  const ids = () => page.evaluate(() => state.placed.map(p => p.name));
  const startState = await page.evaluate(() => ({ placed: state.placed.length, session: !!NSO_wheelSession }));
  check('the plate starts empty and the wheel holds nothing', startState.placed === 0 && !startState.session);

  /* A slider (or preset) with no ball on the wheel must not conjure a piece:
     it just sets the recipe the next Starter Ball will start with. */
  await openWheelMenu(page);
  await page.click('#btn-wheel-open');
  check('Open with no ball starts nothing and puts nothing on the plate',
    (await ids()).length === 0 && !(await page.evaluate(() => !!NSO_wheelSession)));
  /* ...and the sliders are not shut off for having nothing to act on. */
  check('...and no slider is disabled',
    await page.evaluate(() => Array.from(document.getElementById('btn-wheel-ball').closest('.vp-menu-body').querySelectorAll('input')).every(e => !e.disabled)));
  /* put the preset back: the next Starter Ball must be the plain ball */
  await page.evaluate(() => {
    const e = document.getElementById('rng-wheel-open'); e.value = '0';
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* A refused ball must not leave a session behind. (It used to: Ball set the
     session first and only then found there was no piece to bake onto.) */
  const refused = await page.evaluate(() => {
    const r = NSO_wheelRun('ball', { wall: 0.1 }, 'Ball centred');
    return { ok: r.ok, session: !!NSO_wheelSession, placed: state.placed.length };
  });
  check('a refused ball (wall under the nozzle floor) leaves no session and no piece',
    refused.ok === false && !refused.session && refused.placed === 0,
    JSON.stringify(refused) + ' ' + await statusOf(page));

  /* The start itself: press Ball, nothing else. */
  await page.click('#btn-wheel-ball');
  await page.waitForFunction(() => /Dropped Wheel 1/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const first = await page.evaluate(() => {
    const m = getActiveModel();
    return { names: state.placed.map(p => p.name), active: m && m.name, size: m && m.size,
             session: !!NSO_wheelSession, radius: NSO_wheelSession && NSO_wheelSession.sizing.ball_radius };
  });
  const startStatus = await statusOf(page);
  console.log('   status: ' + startStatus);
  check('Ball with nothing typed and nothing selected drops a piece of its own, selected',
    first.names.length === 1 && first.active === 'Wheel 1', JSON.stringify(first.names));
  check('it is the standard ball: 25 mm radius, 50 mm across',
    first.radius === 25 && Math.abs(first.size.x - 50) < 0.01, first.size.x + ' mm');
  check('the status says what it is and what it is for',
    /standard ball/.test(startStatus) && /plate/.test(startStatus) && /bowl/.test(startStatus), startStatus);
  const firstMesh = await measure(page);
  check('and it is a closed solid', firstMesh.open === 0 && firstMesh.nm === 0);

  /* Pressed flat it is a plate that fits the smallest machine. */
  await page.click('#btn-wheel-flatten');
  await page.waitForFunction(() => getActiveModel().size.y < 3.2, null, { timeout: 30000 });
  const plate = await page.evaluate(() => {
    const f = NSO_wheelFitReport(NSO_wheelSession, NSO_Printer.resolve('a1mini'));
    return { fits: f.fits, d: 2 * Math.max.apply(null, NSO_wheelSession.outer.map(q => q.r)) };
  });
  check('the standard ball presses into a plate that fits the A1 Mini',
    plate.fits === true && plate.d > 120 && plate.d < 180, plate.d.toFixed(1) + ' mm across');

  /* Undo takes the press back - and the WHEEL goes back with it. Opening
     afterwards opens the BALL; had the session stayed on the pressed disc, a
     3 mm wall in a 3 mm disc would have refused. */
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  await page.click('#btn-wheel-open');
  await page.waitForFunction(() => NSO_wheelSession && NSO_wheelSession.inner, null, { timeout: 30000 });
  check('after Undo the recipe is back on the ball: Open opens it',
    await page.evaluate(() => !!NSO_wheelSession.inner && NSO_wheelHome.recipe.thick === null));
  const bowl1 = await measure(page);

  /* A second ball is a second piece. Moves act on the wheel's piece, wherever
     the selection is - they do not bake onto whatever is selected. */
  await page.click('#btn-wheel-ball');
  await page.waitForFunction(() => /Dropped Wheel 2/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  check('a second Ball is a second piece, not a replacement', (await ids()).length === 2, (await ids()).join(', '));
  const w1id = await page.evaluate(() => state.models.find(m => m.name === 'Wheel 1').id);
  await selectModel(page, w1id);
  check('(the bowl, Wheel 1, is selected now)', await page.evaluate(() => getActiveModel().name) === 'Wheel 1');
  await page.click('#btn-wheel-flatten');
  await page.waitForFunction(() => state.models.find(m => m.name === 'Wheel 2').size.y < 3.2, null, { timeout: 30000 });
  const after = await page.evaluate(() => ({
    active: getActiveModel().name,
    w1: state.models.find(m => m.name === 'Wheel 1').rawTris.length,
    w2h: state.models.find(m => m.name === 'Wheel 2').size.y
  }));
  check('the Flatten preset pressed the wheel\'s own piece (Wheel 2) and selected it',
    after.active === 'Wheel 2' && Math.abs(after.w2h - 3) < 1e-3, after.active + ', ' + after.w2h.toFixed(3) + ' mm thick');
  check('...and left the selected bowl exactly as it was', after.w1 === bowl1.tris * 9, after.w1 + ' floats');

  /* Something other than the wheel changing the piece ends the session
     rather than being overwritten by it. */
  const stood = await page.evaluate(() => {
    const m = state.models.find(x => x.name === 'Wheel 2');
    m.rawTris = new Float32Array(m.rawTris);
    const before = m.rawTris;
    const r = NSO_wheelRun('flatten', { height: 10 }, 'Flattened');
    return { ok: r.ok, ended: !NSO_wheelSession, same: m.rawTris === before };
  });
  check('a piece changed by something else stands the wheel down - and is not overwritten',
    stood.ok === false && stood.ended && stood.same && /Wheel stood down/.test(await statusOf(page)),
    JSON.stringify(stood) + ' ' + await statusOf(page));

  /* A piece taken off the plate leaves nothing for the wheel to act on. */
  await page.click('#btn-wheel-ball');
  await page.waitForFunction(() => /Dropped Wheel 3/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  await page.click('#btn-undo');
  await page.waitForFunction(() => !state.models.some(m => m.name === 'Wheel 3'), null, { timeout: 30000 });
  /* The live sliders notice at once (a 300 ms watch while the menu is open)
     and end the session themselves, so by the time Open is pressed the wheel
     already holds nothing: either message is the right one, and nothing starts. */
  await page.waitForFunction(() => !NSO_wheelSession, null, { timeout: 5000 });
  const placedBefore = await page.evaluate(() => state.placed.length);
  await page.click('#btn-wheel-open');
  check('with its piece gone, the session is over and a slider starts nothing',
    !(await page.evaluate(() => !!NSO_wheelSession)) && (await page.evaluate(() => state.placed.length)) === placedBefore);

  console.log('\n=== 2. a ball, dropped beside a real piece ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await openWheelMenu(page);
  const boxBefore = await measure(page);
  /* The strict API's sized ball (Pappus, from a 60 mm target): the Starter Ball
     button is tested in 1b and 10b, and sections 3-9 were written around this
     46.58 mm ball. */
  await page.evaluate(() => NSO_wheelRun('ball', { height: 60 }, 'Ball centred'));
  await page.waitForFunction(() => /Ball centred/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const ball = await measure(page);
  const ballStatus = await statusOf(page);
  console.log('   status: ' + ballStatus);
  console.log('   ball        tris ' + ball.tris + '  open ' + ball.open + '  nm ' + ball.nm +
              '  vol ' + ball.volume.toFixed(1) + '  bbox ' + JSON.stringify(ball.size));
  check('the ball is a piece of its own: the box is still there, untouched',
    await page.evaluate((n) => {
      const b = state.models.find(m => m.name === 'box-20mm');
      return !!b && b.rawTris.length / 9 === n && state.placed.some(p => p.name === 'box-20mm');
    }, boxBefore.tris), boxBefore.tris + ' triangles');
  check('...and the new piece is the selected one', ball.tris !== boxBefore.tris);
  check('the ball is closed - 0 open, 0 non-manifold', ball.open === 0 && ball.nm === 0,
    ball.open + ' open, ' + ball.nm + ' non-manifold');
  check('it is round - all three bbox axes equal',
    ball.size.x === ball.size.y && ball.size.y === ball.size.z, JSON.stringify(ball.size));
  check('the status line carries the material budget',
    /mm\^3 clay used/.test(ballStatus), ballStatus);
  check('a 60 mm target gives a 46.58 mm ball, as the sizing says',
    Math.abs(ball.size.x - 46.5836) < 0.01, ball.size.x + ' mm');

  console.log('\n=== 3. Open turns one profile into two ===');
  /* The strict move API (NSO_wheelRun) BAKES: what it makes is the new
     starting point. The sliders never come through here (section 10b). */
  await page.evaluate(() => NSO_wheelRun('open', {}, 'Opened'));
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
  await page.evaluate(() => NSO_wheelRun('pull', { z: 12, dr: 1.5, clamp: true }, 'Pulled'));
  await page.waitForFunction(() => /Pulled|would take/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const pulled = await measure(page);
  const pullStatus = await statusOf(page);
  console.log('   status: ' + pullStatus);
  check('a pull at mid-height lands', /Pulled/.test(pullStatus), pullStatus);
  /* The clay is conserved (the Pull button is the conserving, clamped Pull):
     the wall moved out, so the piece stands a little lower instead of gaining
     material. */
  check('the clay is conserved: the wall moved out and the height gave it up',
    Math.abs(pulled.volume - bowl.volume) / bowl.volume < 1e-5 && pulled.size.y < bowl.size.y,
    bowl.volume.toFixed(1) + ' -> ' + pulled.volume.toFixed(1) + ' mm^3, ' +
    bowl.size.y.toFixed(2) + ' -> ' + pulled.size.y.toFixed(2) + ' mm tall');
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
  await page.evaluate(() => NSO_wheelRun('trim', { z: 2 }, 'Trimmed'));
  await page.waitForFunction(() => /Trimmed/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const trimStatus = await statusOf(page);
  const trimmed = await measure(page);
  console.log('   status: ' + trimStatus);
  check('the base is trimmed and the clay is accounted for',
    /Trimmed [\d.]+ mm\^3 off the base/.test(trimStatus), trimStatus);
  check('the piece is shorter', trimmed.size.y < pulled.size.y,
    pulled.size.y + ' -> ' + trimmed.size.y + ' mm');

  await page.evaluate(() => NSO_wheelRun('rim', { delta: 10 }, 'Rim extended'));
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
  await page.evaluate(() => NSO_wheelRun('rim', { delta: 10 }, 'Rim extended'));
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

  console.log('\n=== 10b. the piece is a recipe: every slider is live all the time ===');
  {
  const drag = (id, v) => page.evaluate(([i, x]) => {
    const e = document.getElementById(i); e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true }));
  }, [id, v]);
  const release = id => page.evaluate(i => document.getElementById(i).dispatchEvent(new Event('change', { bubbles: true })), id);
  /* drag then let go, and wait for the piece the recipe now describes to be the one on the plate */
  const setSlider = async (id, v) => {
    await drag(id, v); await release(id);
    await page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
  };
  const readoutOf = () => page.evaluate(() => document.getElementById('wheel-readout').textContent);
  const waitReadout = re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('wheel-readout').textContent), re.source, { timeout: 15000 });
  const geoH = () => page.evaluate(() => {
    const m = getActiveModel(), e = state.placed.find(p => p.sourceId === m.id), g = e.mesh.geometry;
    g.computeBoundingBox(); return g.boundingBox.max.y - g.boundingBox.min.y;
  });
  const undoN = () => page.evaluate(() => state.undoStack.length);
  const sl = id => page.evaluate(i => { const e = document.getElementById(i); return { v: parseFloat(e.value), min: parseFloat(e.min), max: parseFloat(e.max), off: e.disabled }; }, id);
  const info = () => page.evaluate(() => {
    const m = getActiveModel(), p = NSO_wheelSession, s = NSO_wheelSpan(p.outer);
    return { ops: p.ops.join('>'), open: !!p.inner, h: s.hi - s.lo, d: 2 * Math.max.apply(null, p.outer.map(q => q.r)),
             vol: NSO_wheelVolume(p), ceil: NSO_wheelBudget(p).ceiling, y: m.size.y, recipe: JSON.parse(JSON.stringify(NSO_wheelHome.recipe, (k, v) => k === 'base' ? undefined : v)) };
  });
  const rawRef = () => page.evaluate(() => { window.__raw = getActiveModel().rawTris; });
  const rawSame = () => page.evaluate(() => getActiveModel().rawTris === window.__raw);
  const allLive = () => page.evaluate(() => Array.from(document.getElementById('btn-wheel-ball').closest('.vp-menu-body').querySelectorAll('input')).every(e => !e.disabled));

  /* the card */
  const card = await page.evaluate(() => {
    const ids = Array.from(document.getElementById('btn-wheel-ball').closest('.vp-menu-body').querySelectorAll('[id]')).map(e => e.id);
    return { ballFirst: ids.indexOf('btn-wheel-ball') < ids.indexOf('rng-wheel-scale'), label: document.getElementById('btn-wheel-ball').textContent.trim(),
             nozzle: !!document.getElementById('inp-wheel-nozzle') || !!document.getElementById('rng-wheel-nozzle'),
             gone: ['btn-wheel-pull', 'btn-wheel-trim', 'btn-wheel-rim'].filter(i => document.getElementById(i)),
             boxes: document.getElementById('btn-wheel-ball').closest('.vp-menu-body').querySelectorAll('input[type=number]').length,
             hr: ['rng-wheel-height', 'rng-wheel-radius'].filter(i => document.getElementById(i)) };
  });
  check('the Starter Ball button is first on the card, and says so', card.ballFirst && card.label === 'Starter Ball', JSON.stringify(card));
  check('there is no nozzle control, and no Pull / Trim / Rim + button to bake with',
    !card.nozzle && card.gone.length === 0, JSON.stringify(card));
  check('there is nothing to type into: no number box anywhere on the card',
    card.boxes === 0, card.boxes + ' number boxes');
  check('Scale replaced H and R (W, the wall lever, stays)', card.hr.length === 0 &&
    await page.evaluate(() => !!document.getElementById('rng-wheel-scale') && !!document.getElementById('rng-wheel-wall')), JSON.stringify(card.hr));

  /* a fresh standard ball */
  await page.evaluate(() => { document.getElementById('rng-wheel-scale').value = '25'; });
  await page.click('#btn-wheel-ball');
  await page.waitForFunction(() => /Dropped Wheel \d+/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const t0 = await sl('rng-wheel-flat');
  check('Thick runs from the wall (3) up to the ball\'s own height, sitting at the top = unpressed',
    t0.min === 3 && Math.abs(t0.max - 50) < 0.11 && Math.abs(t0.v - t0.max) < 0.11, JSON.stringify(t0));
  check('every slider and box is live', await allLive());
  const ball0 = await info();

  /* DRAG: live and uncommitted */
  const u0 = await undoN(); await rawRef();
  await drag('rng-wheel-flat', 20);
  await waitReadout(/Preview/);
  check('dragging Thick presses the piece you can see - 20 mm tall on screen', Math.abs((await geoH()) - 20) < 0.1, (await geoH()).toFixed(2));
  check('...nothing is set: the model is still 50 mm, the same triangles, no Undo step',
    Math.abs((await info()).y - 50) < 0.01 && await rawSame() && (await undoN()) === u0);
  check('...the read-out says what it would be',
    /Preview/.test(await readoutOf()) && /Ø/.test(await readoutOf()), await readoutOf());
  await release('rng-wheel-flat');
  await page.waitForFunction(() => Math.abs(getActiveModel().size.y - 20) < 0.05, null, { timeout: 30000 });
  check('letting go sets it as ONE Undo step', (await undoN()) === u0 + 1);
  check('...and the recipe says thick 20', Math.abs((await info()).recipe.thick - 20) < 0.11);

  /* THE POINT: nothing is baked, nothing is switched off */
  await setSlider('rng-wheel-open', 0.5);
  let st = await info();
  check('Open opens the pressed piece', st.open && st.ops === 'ball>flatten>open', st.ops);
  check('...every slider is still live', await allLive());
  const d20 = st.d;
  await setSlider('rng-wheel-flat', 10);
  st = await info();
  check('Thick, dragged AFTER it is open, re-presses the ball and re-opens it on the new shape',
    st.open && st.ops === 'ball>flatten>open' && st.d > d20 && Math.abs(st.recipe.thick - 10) < 0.11 && st.recipe.open > 0,
    st.ops + ', ' + d20.toFixed(1) + ' -> ' + st.d.toFixed(1) + ' mm across');
  check('...the clay is the same clay', Math.abs(st.vol - ball0.vol) / ball0.vol < 1e-6);
  await setSlider('rng-wheel-flat', parseFloat((await sl('rng-wheel-flat')).max));
  st = await info();
  check('Thick all the way back up: an opened UNPRESSED ball - the press is gone',
    st.open && st.ops === 'ball>open' && st.recipe.thick === null && st.d < 90, st.ops + ', ' + st.d.toFixed(1) + ' mm across');
  await setSlider('rng-wheel-open', 0);
  st = await info();
  check('Open back to 0: not opened, the original ball exactly',
    !st.open && st.ops === 'ball' && Math.abs(st.vol - ball0.vol) < 1e-6 && Math.abs(st.y - 50) < 0.01, st.ops + ', h ' + st.h.toFixed(2));

  /* ORDER DOES NOT MATTER: it is a recipe */
  await setSlider('rng-wheel-flat', 15); await setSlider('rng-wheel-open', 0.5);
  const a = await info();
  await setSlider('rng-wheel-flat', parseFloat((await sl('rng-wheel-flat')).max)); await setSlider('rng-wheel-open', 0);
  await setSlider('rng-wheel-open', 0.5); await setSlider('rng-wheel-flat', 15);
  const b = await info();
  check('Thick then Open, or Open then Thick: the same piece',
    Math.abs(a.h - b.h) < 1e-6 && Math.abs(a.d - b.d) < 1e-6 && a.ops === b.ops, a.h.toFixed(2) + ' vs ' + b.h.toFixed(2));

  /* A LIMIT IS NOT A REFUSAL */
  await setSlider('rng-wheel-flat', 20);
  await setSlider('rng-wheel-open', 0.5);
  check('(opened 50% on the 20 mm disc)', (await info()).open && Math.abs((await info()).recipe.open - 0.5) < 0.011);
  await drag('rng-wheel-flat', 3);
  await waitReadout(/Preview/);
  const lim = await sl('rng-wheel-open');
  check('press it down to a 3 mm disc and Open cannot be honoured - the read-out says so and the slider stays live',
    !lim.off && /Open/.test(await readoutOf()) && lim.max < 0.5, JSON.stringify(lim) + ' ' + await readoutOf());
  await release('rng-wheel-flat');
  await page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
  st = await info();
  check('...the piece is a disc, and the 50% it was asked for is remembered, not lost',
    !st.open && Math.abs(st.recipe.open - 0.5) < 0.011 && st.y < 3.2, st.ops + ' open ' + st.recipe.open.toFixed(2));
  check('...every slider is live', await allLive());
  await setSlider('rng-wheel-flat', 20);
  st = await info();
  check('drag Thick back up and the remembered Open takes effect: the disc opens again', st.open && Math.abs(st.recipe.open - 0.5) < 0.011, st.ops);

  /* UNDO takes the recipe back, and the sliders follow it */
  await page.click('#btn-undo');
  await page.waitForFunction(() => { const r = NSO_wheelHome && NSO_wheelHome.recipe; return r && Math.abs(r.thick - 3) < 0.11; }, null, { timeout: 5000 });
  await page.waitForFunction(() => Math.abs(parseFloat(document.getElementById('rng-wheel-flat').value) - 3) < 0.11, null, { timeout: 5000 });
  check('Undo puts the recipe back, and Thick with it', Math.abs((await sl('rng-wheel-flat')).v - 3) < 0.11);

  /* ESCAPE */
  await drag('rng-wheel-flat', 12); await waitReadout(/Preview/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !/Preview/.test(document.getElementById('wheel-readout').textContent), null, { timeout: 5000 });
  check('Escape puts the piece and the slider back', Math.abs((await geoH()) - 3) < 0.1 && Math.abs((await sl('rng-wheel-flat')).v - 3) < 0.11);

  /* PULL: a live value, and taking it back is exact */
  await setSlider('rng-wheel-flat', 20); await setSlider('rng-wheel-open', 0.5);
  const bowl = await info();
  await setSlider('rng-wheel-pull-z', 60); await setSlider('rng-wheel-soft', 30); await setSlider('rng-wheel-pull-dr', 6);
  const pulled = await info();
  check('Pull moves the wall at that height, the clay conserved and the height giving it up',
    Math.abs(pulled.vol - bowl.vol) / bowl.vol < 1e-9 && pulled.d > bowl.d && pulled.h !== bowl.h, bowl.d.toFixed(1) + ' -> ' + pulled.d.toFixed(1) + ' mm across');
  check('...nothing is shut off', await allLive());
  await setSlider('rng-wheel-pull-dr', 0);
  const back = await info();
  check('Pull back to 0: the bowl exactly as it was - the pull was never baked in',
    Math.abs(back.h - bowl.h) < 1e-9 && Math.abs(back.d - bowl.d) < 1e-9 && back.ops === bowl.ops, back.h.toFixed(3) + ' vs ' + bowl.h.toFixed(3));

  /* SOFT: the pull is Tube Edge's Smooth curve on a finely sampled wall - no funnel */
  const softS = await page.evaluate(() => { const e = document.getElementById('rng-wheel-soft'); return { max: parseFloat(e.max), min: parseFloat(e.min) }; });
  check('Soft reaches 100% of the height (it stopped at 60)', softS.max === 100 && softS.min === 5, JSON.stringify(softS));
  const worstTurnNow = () => page.evaluate(() => {
    const c = NSO_wheelSession.outer; let worst = 0;
    for (let i = 1; i + 1 < c.length; i++) {
      const ax = c[i].r - c[i - 1].r, az = c[i].z - c[i - 1].z, bx = c[i + 1].r - c[i].r, bz = c[i + 1].z - c[i].z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) continue;
      worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)))) * 180 / Math.PI);
    }
    return worst;
  });
  await setSlider('rng-wheel-soft', 60); await setSlider('rng-wheel-pull-dr', 12);
  const turn = await worstTurnNow();
  check('a big, broad pull (+12 mm, Soft 60%) is smooth: no segment turns more than 15 degrees from its neighbour (it was 60-86 before)', turn < 15, turn.toFixed(1) + ' degrees');
  check('...and the wall has more samples where the pull reaches (it is drawn finely enough to show the curve)',
    await page.evaluate(() => NSO_wheelSession.outer.length) > 80);
  await setSlider('rng-wheel-pull-dr', 0); await setSlider('rng-wheel-soft', 40);

  /* H resizes the ball under everything */
  const hb = await info();
  await setSlider('rng-wheel-scale', 35);
  const big = await info();
  check('Scale resizes the ball under the press and the opening - the rest is rebuilt on it',
    big.ops === hb.ops && big.vol > hb.vol * 1.5 && big.recipe.thick === hb.recipe.thick, hb.vol.toFixed(0) + ' -> ' + big.vol.toFixed(0) + ' mm^3');
  await setSlider('rng-wheel-scale', 25);

  /* Trim and Rim + are live values too */
  const preTrim = await info();
  await setSlider('rng-wheel-trim', 1.5);
  const tr = await info();
  check('Trim takes it off the base, live', tr.ops.endsWith('trim') && tr.h < preTrim.h, preTrim.h.toFixed(2) + ' -> ' + tr.h.toFixed(2));
  await setSlider('rng-wheel-trim', 0);
  const unTrim = await info();
  check('...and Trim back to 0 gives the clay back (nothing was baked)', Math.abs(unTrim.h - preTrim.h) < 1e-9 && Math.abs(unTrim.vol - preTrim.vol) < 1e-6);
  await drag('rng-wheel-rim', 8);
  await waitReadout(/Rim \+ needs a straight wall/);
  check('Rim + on a curved wall says what it needs in the read-out - and the slider carries on', await allLive());
  await release('rng-wheel-rim');
  await page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
  await setSlider('rng-wheel-rim', 0);
  }

  console.log('\n=== 10c. the white edge stays on while the sliders move, and on the shape you are seeing ===');
  {
    const drag = (id, v) => page.evaluate(([i, x]) => {
      const e = document.getElementById(i); e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, v]);
    const release = id => page.evaluate(i => document.getElementById(i).dispatchEvent(new Event('change', { bubbles: true })), id);
    const idle = () => page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
    const waitPreview = () => page.waitForFunction(() => document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
    /* what the viewport has on the wheel's piece: how many white edges, whether the edge IS this geometry's, and how tall it is */
    const edge = () => page.evaluate(() => {
      const m = NSO_wheelModel(), e = state.placed.find(p => p.sourceId === m.id), mesh = e.mesh;
      const lines = mesh.children.filter(c => c.name === 'selOutline');
      const ln = lines[0];
      let h = null, mine = false;
      if (ln) {
        ln.geometry.computeBoundingBox(); h = ln.geometry.boundingBox.max.y - ln.geometry.boundingBox.min.y;
        const k = ln.userData.nsoEdgesOf; mine = !!k && k.uuid === mesh.geometry.uuid;
      }
      mesh.geometry.computeBoundingBox();
      return { n: lines.length, visible: !!ln && ln.visible, mine, h, shown: mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y,
               selected: state.placed[state.selectedIndex] === e };
    });

    await page.evaluate(() => { document.getElementById('rng-wheel-scale').value = '25'; });
    await page.click('#btn-wheel-ball');
    await page.waitForFunction(() => /Dropped Wheel \d+/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    let e = await edge();
    check('a fresh ball wears exactly one white edge, and it is the ball\'s', e.n === 1 && e.mine && e.selected, JSON.stringify(e));

    /* DRAG: the edge follows the preview */
    await drag('rng-wheel-flat', 20); await waitPreview();
    e = await edge();
    check('dragging Thick: one white edge, on the PRESSED shape - 20 mm tall like the piece you see',
      e.n === 1 && e.mine && Math.abs(e.h - 20) < 0.1 && Math.abs(e.shown - 20) < 0.1, JSON.stringify(e));
    await drag('rng-wheel-flat', 8); await page.waitForTimeout(500);
    e = await edge();
    check('...and keeps following as the slider keeps moving (now 8 mm)', e.n === 1 && e.mine && Math.abs(e.h - 8) < 0.1, JSON.stringify(e));

    /* RELEASE: the commit rebuilds the mesh - the edge must come back with it */
    await release('rng-wheel-flat'); await idle(); await page.waitForTimeout(300);
    e = await edge();
    check('letting go: the piece is rebuilt and the white edge is still on it (it used to go off here)',
      e.n === 1 && e.mine && Math.abs(e.h - 8) < 0.1, JSON.stringify(e));

    /* the same, over and over, on different sliders */
    let always = true, detail = [];
    for (const [id, v] of [['rng-wheel-open', 0.5], ['rng-wheel-pull-dr', 4], ['rng-wheel-soft', 40], ['rng-wheel-trim', 1], ['rng-wheel-scale', 30], ['rng-wheel-flat', 12]]) {
      await drag(id, v); await waitPreview(); await page.waitForTimeout(200);
      const during = await edge();
      await release(id); await idle(); await page.waitForTimeout(250);
      const after = await edge();
      const ok = during.n === 1 && during.mine && after.n === 1 && after.mine && Math.abs(after.h - after.shown) < 0.1;
      if (!ok) always = false;
      detail.push(id.replace('rng-wheel-', '') + ':' + (ok ? 'on' : 'OFF ' + JSON.stringify([during, after])));
    }
    check('on every slider, during the drag and after the release: exactly one white edge, the piece\'s own',
      always, detail.join('  '));

    /* ESCAPE: the original shape's edge is back */
    const before = await edge();
    await drag('rng-wheel-flat', 5); await waitPreview();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !/Preview/.test(document.getElementById('wheel-readout').textContent), null, { timeout: 5000 });
    await page.waitForTimeout(250);
    e = await edge();
    check('Escape puts the piece back and its white edge with it', e.n === 1 && e.mine && Math.abs(e.h - before.h) < 0.1, JSON.stringify(e));

    /* UNDO */
    await page.click('#btn-undo');
    await page.waitForTimeout(600);
    e = await edge();
    check('Undo keeps the white edge on too', e.n === 1 && e.mine, JSON.stringify(e));

    /* ANOTHER PIECE SELECTED: touching a slider selects the wheel's piece, and it wears the edge */
    const other = await loadSTL(page, fx('box-20mm.stl'));
    await selectModel(page, other);
    await page.evaluate(i => { const idx = state.placed.findIndex(p => p.sourceId === i); selectPlaced(idx); }, other);
    check('(a box is selected now, not the wheel\'s piece)', !(await edge()).selected);
    await drag('rng-wheel-flat', 15); await waitPreview(); await page.waitForTimeout(200);
    e = await edge();
    check('moving a slider selects the wheel\'s own piece, and that piece has the white edge', e.selected && e.n === 1 && e.mine, JSON.stringify(e));
    await release('rng-wheel-flat'); await idle();
  }

  console.log('\n=== 10d. Lip: a flared rim on a pressed plate, live ===');
  {
    const drag = (id, v) => page.evaluate(([i, x]) => {
      const e = document.getElementById(i); e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, v]);
    const release = id => page.evaluate(i => document.getElementById(i).dispatchEvent(new Event('change', { bubbles: true })), id);
    const idle = () => page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview'), null, { timeout: 15000 });
    const setS = async (id, v) => { await drag(id, v); await release(id); await idle(); };
    const readoutOf = () => page.evaluate(() => document.getElementById('wheel-readout').textContent);
    const sl = id => page.evaluate(i => { const e = document.getElementById(i); return { v: parseFloat(e.value), min: parseFloat(e.min), max: parseFloat(e.max), off: e.disabled, title: e.title }; }, id);
    const info = () => page.evaluate(() => {
      const m = getActiveModel(), p = NSO_wheelSession;
      return { ops: p.ops.join('>'), open: !!p.inner, h: NSO_wheelHeightOf(p), d: 2 * Math.max.apply(null, p.outer.map(q => q.r)),
               vol: NSO_wheelVolume(p), y: m.size.y, x: m.size.x, recipe: JSON.parse(JSON.stringify(NSO_wheelHome.recipe, (k, v) => k === 'base' ? undefined : v)) };
    });
    const edge = () => page.evaluate(() => {
      const m = NSO_wheelModel(), e = state.placed.find(p => p.sourceId === m.id), mesh = e.mesh;
      const lines = mesh.children.filter(c => c.name === 'selOutline'), ln = lines[0];
      let h = null, mine = false;
      if (ln) { ln.geometry.computeBoundingBox(); h = ln.geometry.boundingBox.max.y - ln.geometry.boundingBox.min.y; mine = ln.userData.nsoEdgesOf.uuid === mesh.geometry.uuid; }
      mesh.geometry.computeBoundingBox();
      return { n: lines.length, mine: mine, h: h, shown: mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y };
    });

    await page.evaluate(() => { document.getElementById('rng-wheel-scale').value = '25'; });
    await page.click('#btn-wheel-ball');
    await page.waitForFunction(() => /Dropped Wheel \d+/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(300);

    /* on a ball Lip has no plate to lift: it says so and stays live */
    await drag('rng-wheel-lip', 5);
    await page.waitForTimeout(400);
    let lipS = await sl('rng-wheel-lip');
    check('on an unpressed ball the Lip slider says what it needs, and is not switched off',
      !lipS.off && /press the ball into a plate/.test(lipS.title), JSON.stringify(lipS));
    await release('rng-wheel-lip'); await idle();
    check('...and the piece stays a ball', !(await info()).open && (await info()).ops === 'ball');
    await setS('rng-wheel-lip', 0);

    /* press it to a plate, then lift the rim */
    await setS('rng-wheel-flat', 6);
    const plate = await info();
    lipS = await sl('rng-wheel-lip');
    check('pressed to a 6 mm plate, Lip has a real range (up to half the plate\'s radius)', !lipS.off && lipS.max > 15 && lipS.max < 60, JSON.stringify(lipS));
    await setS('rng-wheel-lip', 8);
    const lipped = await info();
    check('Lip 8 lifts the rim: the piece is 8 mm taller than the plate and built as lip, on the same clay',
      lipped.ops === 'ball>flatten>lip' && Math.abs(lipped.h - (plate.h + 8)) < 0.05 && Math.abs(lipped.vol - plate.vol) / plate.vol < 1e-9,
      plate.h.toFixed(1) + ' -> ' + lipped.h.toFixed(2) + ' mm, ' + lipped.ops);
    check('...the model on the plate is that tall too (the revolved mesh, not just the profile)', Math.abs(lipped.y - lipped.h) < 0.01, lipped.y.toFixed(3));
    check('...the diameter comes out a little under the flat plate\'s (clay conserved)', lipped.d < plate.d && lipped.d > plate.d * 0.9, plate.d.toFixed(1) + ' -> ' + lipped.d.toFixed(1));
    let e = await edge();
    check('...with its white edge on, on that shape', e.n === 1 && e.mine && Math.abs(e.h - e.shown) < 0.1, JSON.stringify(e));

    /* the other two sliders change it */
    await setS('rng-wheel-lip-at', 35);
    const wide = await info();
    check('Lip at, further in, is a wider, gentler rim: a shallower angle, so it keeps more of the plate\'s diameter',
      wide.d > lipped.d && wide.d < plate.d && wide.ops === 'ball>flatten>lip', plate.d.toFixed(1) + ' plate, ' + lipped.d.toFixed(1) + ' -> ' + wide.d.toFixed(1));
    await setS('rng-wheel-flare', 90);
    check('Flare changes the curve without changing the height', Math.abs((await info()).h - lipped.h) < 0.05 && (await info()).d !== wide.d);
    await setS('rng-wheel-lip-at', 60); await setS('rng-wheel-flare', 50);

    /* a lip past what the length allows is limited, in words */
    await drag('rng-wheel-lip', parseFloat((await sl('rng-wheel-lip')).max));
    await page.waitForFunction(() => /Lip limited to/.test(document.getElementById('wheel-readout').textContent), null, { timeout: 15000 });
    check('a lip taller than the plate\'s reach allows is capped, the read-out says so, the slider carries on',
      /Lip limited to/.test(await readoutOf()) && !(await sl('rng-wheel-lip')).off, await readoutOf());
    await release('rng-wheel-lip'); await idle();
    await setS('rng-wheel-lip', 8);

    /* Open and Lip are not both a plate (a 12 mm plate is thick enough to open) */
    await setS('rng-wheel-flat', 12);
    const preDeep = await info();
    check('(a 12 mm plate with the lip on it)', preDeep.ops === 'ball>flatten>lip');
    await setS('rng-wheel-open', 0.5);
    const both = await info();
    check('open it (Open) and Lip stands down: it is not a plate any more, and the read-out says so',
      both.open && both.ops !== 'ball>flatten>lip' && /Lip: an opened piece/.test(await readoutOf()) && !(await sl('rng-wheel-lip')).off, both.ops + ' | ' + await readoutOf());
    check('...the 8 mm lip it was asked for is remembered', Math.abs(both.recipe.lip.h - 8) < 0.1, JSON.stringify(both.recipe.lip));
    await setS('rng-wheel-open', 0);
    const back = await info();
    check('Open back to 0 and the lip is there again - nothing was lost', back.ops === 'ball>flatten>lip' && Math.abs(back.h - preDeep.h) < 1e-9 && Math.abs(back.d - preDeep.d) < 1e-9,
      back.ops + ' ' + back.h.toFixed(2) + ' (was ' + preDeep.h.toFixed(2) + ')');
    await setS('rng-wheel-flat', 6);

    /* taking it back is exact */
    await setS('rng-wheel-lip', 0);
    const flat = await info();
    check('Lip back to 0 is the flat plate exactly', !flat.open && flat.ops === 'ball>flatten' && Math.abs(flat.h - plate.h) < 1e-9 && Math.abs(flat.d - plate.d) < 1e-9);

    /* undo and the edge */
    await setS('rng-wheel-lip', 8);
    await page.click('#btn-undo');
    await page.waitForFunction(() => NSO_wheelHome && NSO_wheelHome.recipe.lip.h === 0, null, { timeout: 5000 });
    e = await edge();
    check('Undo takes the lip back and keeps the white edge', !(await info()).open && e.n === 1 && e.mine, JSON.stringify(e));
  }

  console.log('\n=== 10e. dragging on the piece: handles on the silhouette drive the same sliders ===');
  {
    const drag = (id, v) => page.evaluate(([i, x]) => {
      const e = document.getElementById(i); e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, v]);
    const release = id => page.evaluate(i => document.getElementById(i).dispatchEvent(new Event('change', { bubbles: true })), id);
    const idle = () => page.waitForFunction(() => !document.getElementById('wheel-readout').textContent.startsWith('Preview') && !document.getElementById('wheel-readout').textContent.startsWith('Drag the'), null, { timeout: 15000 });
    const setS = async (id, v) => { await drag(id, v); await release(id); await idle(); };
    const handles = () => page.evaluate(() => NSO_wheelUI.handles());
    const H = async k => (await handles()).find(h => h.kind === k);
    const undoTypes = () => page.evaluate(() => state.undoStack.map(e => e.type));
    const val = id => page.evaluate(i => parseFloat(document.getElementById(i).value), id);
    const rec = () => page.evaluate(() => JSON.parse(JSON.stringify(NSO_wheelHome.recipe, (k, v) => k === 'base' ? undefined : v)));
    const modelH = () => page.evaluate(() => getActiveModel().size.y);
    const cam = () => page.evaluate(() => state.camera.position.toArray().map(v => +v.toFixed(3)).join(','));
    const ctlOn = () => page.evaluate(() => state.controls.enabled);
    const ro = () => page.evaluate(() => document.getElementById('wheel-readout').textContent);
    /* press, move in steps, optionally hold (no release) */
    const grab = async (h, dx, dy, o) => {
      o = o || {};
      await page.mouse.move(h.x, h.y);
      if (o.shift) await page.keyboard.down('Shift');
      await page.mouse.down();
      const n = o.steps || 8;
      for (let i = 1; i <= n; i++) { await page.mouse.move(h.x + dx * i / n, h.y + dy * i / n); await page.waitForTimeout(70); }
      await page.waitForTimeout(450);
    };
    const letGo = async (o) => { await page.mouse.up(); if (o && o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(700); };

    await page.evaluate(() => { document.getElementById('rng-wheel-scale').value = '25'; });
    await page.click('#btn-wheel-ball');
    await page.waitForFunction(() => /Dropped Wheel \d+/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    /* five pieces are on the plate by now and the new one sits wherever there is room - maybe off the right of the window,
       where a plate-sized rim handle could not be reached. Put it in the middle for this section. */
    await page.evaluate(() => { const m = NSO_wheelModel(), e = state.placed.find(p => p.sourceId === m.id); applyPlacedXZ(e, 0, 0); NSO_wheelUI.place(); });
    await page.waitForTimeout(600);
    /* The Undo stack is capped, so by now "one more entry" cannot be told from its length: mark the top and look for
       exactly one new entry above it. */
    const markTop = () => page.evaluate(() => { window.__top = state.undoStack[state.undoStack.length - 1]; });
    const oneNew = () => page.evaluate(() => { const s2 = state.undoStack; return s2.length >= 2 && s2[s2.length - 2] === window.__top && s2[s2.length - 1].type === 'wheelReplace'; });

    /* the handles on a fresh ball */
    let hs = await handles();
    check('a fresh ball has a Flatten handle (blue), an Open handle (cyan), a Pull handle (yellow) and a Trim handle (red), no lip handle yet',
      ['flatten', 'open', 'pull', 'trim'].every(k => hs.some(h => h.kind === k)) && !hs.some(h => h.kind === 'lip'), hs.map(h => h.kind).join(','));
    let th = await H('flatten');
    await page.mouse.move(th.x, th.y); await page.waitForTimeout(250);
    check('hovering a handle turns the cursor to a grab hand and says what it does',
      (await page.evaluate(() => state.renderer.domElement.style.cursor)) === 'grab' && /Drag the blue ball down/.test(await ro()), await ro());
    await page.mouse.move(980, 760); await page.waitForTimeout(250);
    check('...and moving off it puts the cursor back', (await page.evaluate(() => state.renderer.domElement.style.cursor)) === '');

    /* PRESS: drag the blue ball down */
    await markTop();
    const cam0 = await cam();
    th = await H('flatten');
    await grab(th, 0, 110);
    const mid = { y: await modelH(), undoSame: await page.evaluate(() => state.undoStack[state.undoStack.length - 1] === window.__top), ro: await ro(), thick: await val('rng-wheel-flat'), ctl: await ctlOn() };
    const expect = 50 - 110 / Math.abs(th.b.y);
    check('dragging the top of the ball down presses it, live: the Thick slider follows the cursor',
      mid.thick < 45 && Math.abs(mid.thick - expect) < Math.max(1.5, 0.15 * Math.abs(expect)), 'Thick ' + mid.thick.toFixed(1) + ' mm, cursor-implied ' + expect.toFixed(1) + ' mm');
    check('...nothing is set until you let go: the model is still 50 mm, Undo has not moved, and it says Preview',
      Math.abs(mid.y - 50) < 0.01 && mid.undoSame && /^Preview/.test(mid.ro), 'model ' + mid.y.toFixed(2) + ', ' + mid.ro.slice(0, 40));
    check('...and the orbit is off for the length of the drag', mid.ctl === false);
    await letGo();
    const after = { y: await modelH(), types: await undoTypes(), ctl: await ctlOn(), cam: await cam(), recipe: await rec() };
    check('letting go sets it: ONE Undo step, the model is the pressed height, the camera has not moved',
      await oneNew() && Math.abs(after.y - mid.thick) < 0.2 && after.cam === cam0,
      after.types.slice(-2).join(',') + ', ' + after.y.toFixed(1) + ' mm');
    check('...no stray "Moved model" step from the piece-dragging code underneath', !after.types.slice(-3).includes('movePlaced'));
    check('...and the orbit is back', after.ctl === true);

    /* back up, then LIP on a plate */
    await setS('rng-wheel-flat', 6);
    hs = await handles();
    check('pressed to a plate, the rim handle (green) appears', hs.some(h => h.kind === 'lip'), hs.map(h => h.kind).join(','));
    let lp = await H('lip');
    await markTop();
    await grab(lp, 0, -70);
    const lipMid = await val('rng-wheel-lip');
    const lipExpect = 70 / Math.abs(lp.b.y);
    check('dragging the rim up lifts it: the Lip slider follows (mm of rise = pixels / the screen scale at the rim)',
      lipMid > 2 && Math.abs(lipMid - lipExpect) < Math.max(1.5, 0.25 * lipExpect), 'Lip ' + lipMid.toFixed(1) + ' mm, cursor-implied ' + lipExpect.toFixed(1));
    await letGo();
    const lipped = await page.evaluate(() => ({ ops: NSO_wheelSession.ops.join('>'), h: NSO_wheelHeightOf(NSO_wheelSession) }));
    check('letting go sets the lip: one Undo step, built as lip', lipped.ops === 'ball>flatten>lip' && await oneNew() && lipped.h > 8, lipped.ops + ' ' + lipped.h.toFixed(1));
    hs = await handles();
    lp = await H('lip');
    check('the green ball rides up with the rim (it sits on the lifted edge now)', lp && lp.y < hs.find(h => h.kind === 'flatten').y + 40);

    /* ESCAPE and a plain click change nothing */
    const rBefore = JSON.stringify(await rec());
    await markTop();
    const sameTop = () => page.evaluate(() => state.undoStack[state.undoStack.length - 1] === window.__top);
    await grab(lp, 0, -50, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.mouse.up(); await page.waitForTimeout(500);
    check('Escape mid-drag puts it all back: the recipe, the Undo stack and the orbit are as they were',
      JSON.stringify(await rec()) === rBefore && await sameTop() && await ctlOn());
    lp = await H('lip');
    await page.mouse.move(lp.x, lp.y); await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up(); await page.waitForTimeout(500);
    check('a click on a handle without moving it changes nothing', JSON.stringify(await rec()) === rBefore && await sameTop());

    /* OPEN: the cyan ball, off to the side of the top, dragged OUT widens the mouth */
    await setS('rng-wheel-lip', 0);
    await setS('rng-wheel-flat', 20);
    let op = await H('open');
    await markTop();
    await grab(op, 28, 0);
    const openMid = await val('rng-wheel-open');
    await letGo();
    let st = await rec();
    hs = await handles();
    check('dragging the cyan ball out opens the piece: the Open slider follows, one Undo step, and the Flatten handle is put away (an opened piece is not a plate)',
      st.open > 0.05 && Math.abs(openMid - st.open) < 0.06 && (await page.evaluate(() => !!NSO_wheelSession.inner)) && await oneNew() &&
      hs.some(h => h.kind === 'open') && !hs.some(h => h.kind === 'flatten'),
      'open ' + st.open.toFixed(2) + ', ' + hs.map(h => h.kind).join(','));
    const o1 = st.open;
    op = await H('open');
    await grab(op, 24, 0);
    await letGo();
    check('dragging the cyan ball (now on the rim) further out opens it wider', (await rec()).open > o1 + 0.03 || (await rec()).open >= 0.999, o1.toFixed(2) + ' -> ' + (await rec()).open.toFixed(2));
    op = await H('open');
    const hBefore = await page.evaluate(() => NSO_wheelHeightOf(NSO_wheelSession));
    await grab(op, 0, -20);
    await letGo();
    check('...and up on the rim makes the piece taller (the Tall slider follows, the piece gets taller, the clay is kept)',
      (await rec()).tall > 1.05 && (await page.evaluate(() => NSO_wheelHeightOf(NSO_wheelSession))) > hBefore + 2 &&
      Math.abs((await val('rng-wheel-tall')) - (await rec()).tall) < 0.06 &&
      await page.evaluate(() => Math.abs(NSO_wheelVolume(NSO_wheelSession) - NSO_wheelSession.budget.start) / NSO_wheelSession.budget.start < 1e-6),
      'tall ' + ((await rec()).tall || 1).toFixed(2) + ', ' + hBefore.toFixed(1) + ' -> ' + (await page.evaluate(() => NSO_wheelHeightOf(NSO_wheelSession))).toFixed(1) + ' mm');
    await setS('rng-wheel-tall', 1);

    /* WALL: out/in pulls, up/down moves where */
    const w0 = await rec();
    let wl = await H('pull');
    await grab(wl, 40, -30);
    await letGo();
    const w1 = await rec();
    check('dragging the yellow ball out pulls the wall out, and dragging it up moves where (Pull at rises)',
      w1.pull.dr > w0.pull.dr + 0.5 && w1.pull.z > w0.pull.z + 0.01, 'dr ' + w0.pull.dr.toFixed(1) + ' -> ' + w1.pull.dr.toFixed(1) + ', at ' + (w0.pull.z * 100).toFixed(0) + ' -> ' + (w1.pull.z * 100).toFixed(0) + '%');
    check('...the Pull and Pull at sliders show it', Math.abs((await val('rng-wheel-pull-dr')) - w1.pull.dr) < 0.6 && Math.abs((await val('rng-wheel-pull-z')) - w1.pull.z * 100) < 1.5);
    check('...the clay is the same clay', await page.evaluate(() => Math.abs(NSO_wheelVolume(NSO_wheelSession) - NSO_wheelSession.budget.start) / NSO_wheelSession.budget.start < 1e-6));
    await page.click('#btn-undo');
    await page.waitForFunction(() => Math.abs(NSO_wheelHome.recipe.pull.dr) < 1e-9, null, { timeout: 5000 });
    check('Undo takes the whole drag back in one step, the sliders with it', Math.abs((await val('rng-wheel-pull-dr'))) < 0.6);

    /* the orbit still works on empty space, and the handles follow the camera */
    /* SEVERAL PULLS: the chips pick which pull the three sliders edit, and every active pull has its own ball */
    const chipCls = i => page.evaluate(n => document.querySelector('#wh-row-pulls button[data-slot="' + n + '"]').className, i);
    check('the Pulls row has four chips; chip 1 is the one being edited', (await page.evaluate(() => document.querySelectorAll('#wh-row-pulls button[data-slot]').length)) === 4 && /\bsel\b/.test(await chipCls(0)));
    await setS('rng-wheel-open', 0.8); await setS('rng-wheel-tall', 2);
    await page.click('#wh-row-pulls button[data-slot="1"]'); await page.waitForTimeout(500);
    check('clicking chip 2 hands the three sliders to the second pull: Pull at 80%, Pull 0 mm',
      /\bsel\b/.test(await chipCls(1)) && !/\bsel\b/.test(await chipCls(0)) && (await val('rng-wheel-pull-z')) === 80 && (await val('rng-wheel-pull-dr')) === 0,
      (await val('rng-wheel-pull-z')) + ' ' + (await val('rng-wheel-pull-dr')));
    await setS('rng-wheel-pull-dr', -5);
    let rc2 = await rec();
    check('...Pull on chip 2 writes the second pull (recipe.more[0]) and leaves pull 1 alone, and the chip lights',
      rc2.more && rc2.more[0] && rc2.more[0].dr === -5 && Math.abs(rc2.pull.dr) < 1e-9 && /\bon\b/.test(await chipCls(1)) && !/\bon\b/.test(await chipCls(0)), JSON.stringify(rc2.more));
    hs = await handles();
    check('...and its yellow ball is on the piece (pull2); pull 1 is off, so it has none', hs.some(h => h.kind === 'pull2') && !hs.some(h => h.kind === 'pull'), hs.map(h => h.kind).join(','));
    await page.click('#wh-row-pulls button[data-slot="0"]'); await page.waitForTimeout(400);
    await setS('rng-wheel-pull-z', 40); await setS('rng-wheel-pull-dr', 4);
    rc2 = await rec();
    hs = await handles();
    check('pull 1 and pull 2 together: both balls, both chips lit, both recorded, the clay kept',
      hs.some(h => h.kind === 'pull') && hs.some(h => h.kind === 'pull2') && /\bon\b/.test(await chipCls(0)) && /\bon\b/.test(await chipCls(1)) && rc2.pull.dr === 4 && rc2.more[0].dr === -5 &&
      await page.evaluate(() => Math.abs(NSO_wheelVolume(NSO_wheelSession) - NSO_wheelSession.budget.start) / NSO_wheelSession.budget.start < 1e-6));
    const p2 = await H('pull2');
    await markTop();
    await grab(p2, 24, 0);
    const mid2 = await rec();
    await letGo();
    const aft2 = await rec();
    check('dragging the second ball out pulls the second wall (pull 2 changes, pull 1 does not), one Undo step, and the chip follows',
      aft2.more[0].dr > -5 + 0.5 && aft2.pull.dr === 4 && /\bsel\b/.test(await chipCls(1)) && await oneNew(), 'pull 2: -5 -> ' + aft2.more[0].dr.toFixed(1));
    await page.hover('#wh-row-pull-dr'); await page.waitForTimeout(350);
    const tagTxt = await page.evaluate(() => { const t = document.getElementById('wheel-tag'); return t && t.style.display !== 'none' ? t.textContent : ''; });
    check('...and the Pull row\'s tag speaks for the pull being edited', /Pull/.test(tagTxt), tagTxt);
    await page.mouse.move(980, 760);
    await page.click('#btn-undo'); await page.waitForTimeout(600);
    check('Undo takes the drag back', (await rec()).more[0].dr === -5);
    await setS('rng-wheel-pull-dr', 0); await page.click('#wh-row-pulls button[data-slot="1"]'); await setS('rng-wheel-pull-dr', 0);
    await page.click('#wh-row-pulls button[data-slot="0"]'); await page.waitForTimeout(300);
    await setS('rng-wheel-tall', 1); await setS('rng-wheel-pull-z', 50);

    await setS('rng-wheel-open', 0.3);            // a piece small enough to leave empty plate to orbit on
    const axisPx = () => page.evaluate(() => {
      const m = NSO_wheelModel(), e = state.placed.find(p => p.sourceId === m.id), mesh = e.mesh, g = mesh.geometry;
      g.computeBoundingBox();
      const c = mesh.localToWorld(new THREE.Vector3((g.boundingBox.min.x + g.boundingBox.max.x) / 2, g.boundingBox.min.y, (g.boundingBox.min.z + g.boundingBox.max.z) / 2));
      const r = state.renderer.domElement.getBoundingClientRect(), p = c.project(state.camera);
      return { x: r.left + (p.x * .5 + .5) * r.width, y: r.top + (-p.y * .5 + .5) * r.height };
    });
    /* a spot on the canvas with no piece under it (several pieces sit on the plate by now) */
    const empty = await page.evaluate(() => {
      const r = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster(), meshes = state.placed.map(p => p.mesh).filter(Boolean);
      for (let y = r.bottom - 60; y > r.top + 300; y -= 40) for (let x = r.right - 330; x > r.left + 420; x -= 40) {
        rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), state.camera);
        if (rc.intersectObjects(meshes, false).length === 0) {
          const el = document.elementFromPoint(x, y);
          if (el && el.tagName === 'CANVAS') return { x, y };
        }
      }
      return { x: 980, y: 760 };
    });
    const camA = await cam(), wallA = await H('pull'), deepA = await axisPx();
    await page.mouse.move(empty.x, empty.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(empty.x - i * 12, empty.y - i * 4); await page.waitForTimeout(50); }
    await page.mouse.up(); await page.waitForTimeout(500);
    const camB = await cam(), wallB = await H('pull'), deepB = await axisPx();
    check('a drag on empty space still orbits the camera', camA !== camB, camA + ' -> ' + camB + ' | under the pointer: ' + await page.evaluate(() => { const e = document.elementFromPoint(980, 760); return e ? e.tagName + '#' + e.id : 'none'; }) + ' | controls ' + await ctlOn());
    check('...and the handles follow it: the wall handle is still on the camera\'s right-hand side of the piece, level with it, so a radial drag stays along the screen\'s x',
      wallA && wallB && wallA.x - deepA.x > 20 && wallB.x - deepB.x > 20,
      'before ' + (wallA.x - deepA.x).toFixed(0) + ' px right of the axis, after ' + (wallB.x - deepB.x).toFixed(0));
    const opH = await H('open');
    const rimPx = await page.evaluate(() => state.renderer.domElement.getBoundingClientRect().width);
    check('...and the Open handle is still on the piece\'s rim after the orbit (over the canvas, within 400 px of the piece\'s base centre)',
      opH && opH.x > 0 && opH.x < rimPx && Math.hypot(opH.x - deepB.x, opH.y - deepB.y) < 400,
      opH ? 'handle ' + opH.x.toFixed(0) + ',' + opH.y.toFixed(0) + ' base ' + deepB.x.toFixed(0) + ',' + deepB.y.toFixed(0) : 'none');

    /* TRIM: the red ball on the foot, dragged UP takes more off the base */
    await setS('rng-wheel-open', 0); await setS('rng-wheel-flat', 20);
    let tr = await H('trim');
    const t0 = (await rec()).trim || 0;
    await grab(tr, 0, -16);
    await letGo();
    check('dragging the red ball on the foot up trims the base: the Trim slider follows', (await rec()).trim > t0 + 0.5, t0.toFixed(1) + ' -> ' + ((await rec()).trim || 0).toFixed(1));
    await setS('rng-wheel-trim', 0);

    /* EVERY CONTROL SAYS WHERE IT IS: a ring and a tag on the piece, rows that light, both ways */
    const ringCount = () => page.evaluate(() => { const g = state.scene.getObjectByName('wheelHandles'); return g ? g.children.length : 0; });
    const tagNow = () => page.evaluate(() => { const t = document.getElementById('wheel-tag'); return t && t.style.display !== 'none' ? t.textContent : ''; });
    const lit = id => page.evaluate(i => document.getElementById(i).classList.contains('wh-lit'), id);
    await page.mouse.move(980, 760); await page.waitForTimeout(300);
    const quiet = await ringCount();
    check('nothing hovered: just the handles in the scene, no ring and no tag', (await tagNow()) === '' && quiet === (await handles()).length, quiet + ' objects');
    await page.hover('#wh-row-soft'); await page.waitForTimeout(350);
    check('hovering the Soft row (a slider with no handle of its own) draws rings on the piece where it acts, names it in a tag, and lights its group',
      (await ringCount()) > quiet && /Soft/.test(await tagNow()) && await lit('wh-row-soft') && await lit('wh-row-pull-dr'), (await ringCount()) + ' objects, tag "' + await tagNow() + '"');
    await page.hover('#wh-row-scale'); await page.waitForTimeout(350);
    check('...Scale (also no handle) gets a ring too, at the widest part', (await ringCount()) > quiet && /Scale/.test(await tagNow()), await tagNow());
    await page.hover('#wh-row-trim'); await page.waitForTimeout(350);
    check('...Trim\'s tag sits on its handle and reads its value', /Trim/.test(await tagNow()) && (await ringCount()) > quiet, await tagNow());
    await page.mouse.move(980, 760); await page.waitForTimeout(350);
    check('...moving off puts the ring and the tag away', (await tagNow()) === '' && (await ringCount()) === quiet);
    const ph = await H('pull');
    await page.mouse.move(ph.x, ph.y); await page.waitForTimeout(350);
    check('hovering the yellow handle lights all its rows (Pull at, Pull, Soft), draws the ring at the pull height and tags it',
      await lit('wh-row-pull-z') && await lit('wh-row-pull-dr') && await lit('wh-row-soft') && !(await lit('wh-row-trim')) && /Pull/.test(await tagNow()) && (await ringCount()) > quiet,
      'tag "' + await tagNow() + '"');
    await page.mouse.move(980, 760); await page.waitForTimeout(300);
    const rowColors = await page.evaluate(() => ['wh-row-flat', 'wh-row-open', 'wh-row-pull-dr', 'wh-row-lip', 'wh-row-trim', 'wh-row-scale']
      .map(i => getComputedStyle(document.getElementById(i)).borderLeftColor));
    check('every row wears the colour of its handle on its left edge (all six groups, each a different colour)', new Set(rowColors).size === 6, rowColors.join(' | '));

    /* put away with the menu */
    await page.evaluate(() => { const b = document.getElementById('btn-wheel-ball'); const d = b.closest('details.vp-wheel-menu'); d.open = false; });
    await page.waitForTimeout(700);
    check('closing the Wheel menu puts the handles away: nothing left in the scene to grab',
      await page.evaluate(() => !state.scene.getObjectByName('wheelHandles') && NSO_wheelUI.handles().length === 0));
    await page.evaluate(() => { const b = document.getElementById('btn-wheel-ball'); for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.waitForTimeout(700);
    check('...and they come back when it opens', (await handles()).length >= 2);
  }

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

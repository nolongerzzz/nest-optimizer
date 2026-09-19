/* nso-watch.js, driven in the real app in headless Chromium.

   Two halves, matching the two watchers:

   A. It must not cry wolf. An ordinary session - load, clone, move, rotate,
      flip, tip, raise, optimize, open the cutter, split, close it, undo,
      delete, x-ray, clear - has to produce ZERO findings. A watcher that
      fires on normal use is worse than no watcher, because it trains the
      person to ignore it.

   B. It must catch the shapes already found by accident. Each of the three
      is reproduced here through the app's own buttons and functions, and the
      watcher has to name it, with the operation that preceded it:
        1. pose lost across a bake   - rotate a piece, then Seal it
        2. paint left on screen      - paint a face, then Seal it
        3. a piece restored without its model - Delete, then Undo
      If a case is ever fixed in the app, its assertion here fails loudly -
      which is the point. The check is then to be retired with the fix, not
      before.

   Usage: node tools/nso_watch_test.js   (npm run watch:test)              */

const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '\n       ' + extra : '')); }
}
function subjects(found) { return found.map(f => f.subject).sort(); }
function texts(found) { return found.map(f => f.subject + ': ' + f.msg).join('\n       '); }

/* Runs one step in the page and hands back what the watcher makes of it. */
async function after(page, label, fn) {
  await page.evaluate(fn);
  await page.waitForTimeout(80);
  return await page.evaluate(l => NSOWatch.check(l), label);
}

/* Paints one face through the paint module's own entry point, with a real
   raycast hit - the same object a click produces. */
const PAINT_TOP_FACE = () => {
  let m = getActiveModel();
  if (!m || !state.placed.some(q => q && q.sourceId === m.id && q.mesh)) {
    // whatever is on the plate and still in the registry
    const q = state.placed.find(x => x && x.mesh && state.models.some(mm => mm.id === x.sourceId));
    if (!q) throw new Error('nothing on the plate to paint');
    state.editId = q.sourceId;
    m = getActiveModel();
  }
  const p = state.placed.find(q => q && q.sourceId === m.id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  const rc = new THREE.Raycaster();
  rc.set(new THREE.Vector3(p.mesh.position.x, bb.max.y + 50, p.mesh.position.z),
         new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObject(p.mesh, false);
  if (!hits.length) throw new Error('no raycast hit on the top face');
  nsoMaskToggleAt(m, p.mesh, hits[0]);
};

const BOX = path.join(ROOT, 'fixtures', 'box-20mm.stl');
const SLAB = path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl');

async function partA(page) {
  console.log('\nA. an ordinary session raises nothing');
  await loadSTL(page, SLAB);
  await page.evaluate(() => NSOWatch.start());

  const steps = [
    ['a second file loaded', async () => { await loadSTL(page, BOX); }],
    ['a piece selected', () => page.evaluate(() => { state.selectedIndex = 0; state.editId = state.models[0].id; })],
    ['cloned', () => page.evaluate(() => {
      document.getElementById('clone-count').value = '2';
      document.getElementById('btn-clone').click();
    })],
    ['nudged', () => page.evaluate(() => { state.selectedIndex = 0; nudgeSelected(4, 4); })],
    ['yawed 90', () => page.evaluate(() => rotateSelected(1))],
    ['flipped', () => page.evaluate(() => flipSelected())],
    ['tipped', () => page.evaluate(() => document.getElementById('btn-tip').click())],
    ['raised', () => page.evaluate(() => document.getElementById('btn-raise').click())],
    ['cutter opened', () => page.evaluate(() => openCutter())],
    ['cut plane moved', () => page.evaluate(() => setCutMm(20))],
    ['split', () => page.evaluate(() => cutActiveModel())],
    ['cutter closed', () => page.evaluate(() => closeCutter(false))],
    ['join session started', () => page.evaluate(() => startJoinSession())],
    ['join cancelled', () => page.evaluate(() => clearJoinSlots())],
    ['paint mode on', () => page.evaluate(() => document.getElementById('btn-mask-paint').click())],
    ['a face painted', () => page.evaluate(PAINT_TOP_FACE)],
    ['paint cleared', () => page.evaluate(() => document.getElementById('btn-mask-clear').click())],
    ['paint mode off', () => page.evaluate(() => document.getElementById('btn-mask-paint').click())],
    ['x-ray on', () => page.evaluate(() => document.getElementById('btn-xray').click())],
    ['x-ray off', () => page.evaluate(() => document.getElementById('btn-xray').click())],
    ['split undone', () => page.evaluate(() => undoLast())],
    ['plate cleared', () => page.evaluate(() => document.getElementById('btn-clear-plate').click())]
  ];

  for (const [name, run] of steps) {
    await run();
    await page.waitForTimeout(80);
    const found = await page.evaluate(l => NSOWatch.check(l), name);
    ok(found.length === 0, name + ' - no finding', found.length ? texts(found) : '');
  }
  await page.evaluate(() => NSOWatch.stop());
}

async function partB1(page) {
  console.log('\nB1. a pose lost across a bake (rotate, then Seal)');
  const id = await loadSTL(page, SLAB);
  await selectModel(page, id);
  await page.evaluate(() => { NSOWatch.start(); state.selectedIndex = 0; });

  ok((await page.evaluate(() => NSOWatch.check('baseline'))).length === 0,
     'the piece starts consistent');

  let found = await after(page, 'rotate', () => rotateSelected(1));
  ok(found.length === 0, 'a plain 90 yaw stays consistent', texts(found));

  found = await after(page, 'seal', () => sealSelectedModel());
  const pose = found.filter(f => f.subject === 'pose');
  ok(pose.length === 1, 'Seal on a yawed piece raises exactly one phantom pose',
     'subjects: ' + subjects(found).join(', '));
  ok(/logical pose is \(0\.0, 90\.0, 0\.0\)deg/.test(pose.length ? pose[0].msg : ''),
     'the finding names the 90 deg the entry still claims',
     pose.length ? pose[0].msg : '(none)');

  const ev = await page.evaluate(() => NSOWatch.events().filter(e => e.kind === 'phantom'));
  ok(ev.length >= 1, 'it is logged as a phantom event');
  ok(ev.length >= 1 && /seal/i.test(ev[0].op),
     'the event carries the operation that preceded it',
     ev.length ? 'op was: ' + ev[0].op : '');
  ok(ev.length >= 1 && /^\d\d:\d\d:\d\d\.\d\d\d$/.test(ev[0].time),
     'and a timestamp', ev.length ? ev[0].time : '');

  /* One mismatch, one line: the same finding seen again is not re-reported. */
  const before = await page.evaluate(() => NSOWatch.events().length);
  await page.evaluate(() => { NSOWatch.check('again'); NSOWatch.check('again'); });
  ok(await page.evaluate(() => NSOWatch.events().length) === before,
     'checking again does not repeat a finding that is already open');

  await page.evaluate(() => NSOWatch.stop());
}

async function partB2(page) {
  console.log('\nB2. paint left over a geometry that is gone (paint, then Seal)');
  const id = await loadSTL(page, SLAB);
  await selectModel(page, id);
  await page.evaluate(() => { NSOWatch.start(); state.selectedIndex = 0; });

  let found = await after(page, 'paint a face', PAINT_TOP_FACE);
  ok(found.length === 0, 'painting a face is consistent on its own', texts(found));
  ok(await page.evaluate(() => nsoMaskCount(getActiveModel())) === 1, 'one face is excluded');

  found = await after(page, 'seal', () => sealSelectedModel());
  const paint = found.filter(f => f.subject === 'paint');
  ok(paint.length >= 1, 'Seal on a painted piece raises a phantom paint',
     'subjects: ' + subjects(found).join(', '));
  ok(paint.some(f => /rebuilt since/.test(f.msg)),
     'it says the yellow belongs to the geometry the piece had before the bake',
     texts(paint));

  /* The same shape again, the other way round: turn a painted piece and the
     yellow stays where it was. */
  found = await after(page, 'rotate a painted piece', () => rotateSelected(1));
  ok(found.filter(f => f.subject === 'paint').some(f => /off the piece it marks/.test(f.msg)),
     'turning a painted piece leaves the paint behind, and that is reported',
     texts(found));

  await page.evaluate(() => NSOWatch.stop());
}

async function partB3(page) {
  console.log('\nB3. a piece restored without its model (Delete, then Undo)');
  const id = await loadSTL(page, BOX);
  await selectModel(page, id);
  await page.evaluate(() => { NSOWatch.start(); state.selectedIndex = 0; });

  let found = await after(page, 'delete the piece', () => deleteSelectedPlaced());
  ok(found.length === 0, 'deleting a piece is consistent', texts(found));

  found = await after(page, 'undo the delete', () => undoLast());
  const obj = found.filter(f => f.subject === 'object');
  ok(obj.length >= 1, 'undoing the delete raises a phantom object',
     'subjects: ' + subjects(found).join(', '));
  ok(obj.some(f => /gone from the registry/.test(f.msg)),
     'it names the model that did not come back with the piece', texts(obj));

  await page.evaluate(() => NSOWatch.stop());
}

async function partC(page) {
  console.log('\nC. the error and status log');
  await loadSTL(page, BOX);
  await page.evaluate(() => NSOWatch.start());

  await page.evaluate(() => { console.error('deliberate console error'); });
  await page.evaluate(() => fetch('/no-such-file-for-the-watch-test.stl').catch(() => {}));
  await page.evaluate(() => { state.selectedIndex = -1; state.editId = null; sealSelectedModel(); });
  await page.evaluate(() => { setTimeout(() => { throw new Error('deliberate uncaught'); }, 0); });
  await page.waitForTimeout(300);

  const ev = await page.evaluate(() => NSOWatch.events());
  const has = (kind, re) => ev.some(e => e.kind === kind && re.test(e.msg));
  ok(has('console', /deliberate console error/), 'a console error is captured');
  ok(has('net', /404|no-such-file/), 'a failed fetch is captured',
     JSON.stringify(ev.filter(e => e.kind === 'net').map(e => e.msg)));
  ok(has('error', /deliberate uncaught/), 'an uncaught error is captured');
  ok(ev.some(e => e.kind === 'status' && e.level === 'refusal' && /select a piece/i.test(e.msg)),
     "NSO's own refusal is captured and marked as a refusal",
     JSON.stringify(ev.filter(e => e.kind === 'status').map(e => e.level + '|' + e.msg)));
  ok(ev.every(e => /^\d\d:\d\d:\d\d\.\d\d\d$/.test(e.time)), 'every event is timestamped');
  /* Observed, not intercepted: the line the app writes is the line the
     person reads, error class and all. */
  const passthrough = await page.evaluate(() => {
    setStatus('watch passthrough probe', true);
    const el = document.getElementById('status');
    return { text: el.textContent, cls: el.className,
             logged: NSOWatch.events().some(e => e.msg === 'watch passthrough probe') };
  });
  ok(passthrough.text === 'watch passthrough probe' && /error/.test(passthrough.cls),
     'the status line still reads exactly what the app set, with its own class',
     JSON.stringify(passthrough));
  ok(passthrough.logged, 'and the same line is in the log');

  /* Off means off: the patches come back out. */
  const restored = await page.evaluate(() => {
    const f = window.fetch, c = console.error, s = window.setStatus, u = window.pushUndo;
    NSOWatch.stop();
    return { fetch: window.fetch !== f, consoleErr: console.error !== c,
             setStatus: window.setStatus !== s, pushUndo: window.pushUndo !== u,
             on: NSOWatch.isOn() };
  });
  ok(restored.fetch && restored.consoleErr && restored.setStatus && restored.pushUndo,
     'stop() puts fetch, console.error, setStatus and pushUndo back',
     JSON.stringify(restored));
  ok(restored.on === false, 'and the watcher reports itself off');

  const quiet = await page.evaluate(() => {
    const n = NSOWatch.events().length;
    console.error('after stop');
    return NSOWatch.events().length === n;
  });
  ok(quiet, 'nothing is logged once it is off');
}

async function partD(page) {
  console.log('\nD. the button');
  ok(await page.evaluate(() => !!document.getElementById('btn-watch')), 'the toggle button is in the page');
  const t = await page.evaluate(() => {
    const b = document.getElementById('btn-watch');
    b.click();
    const onNow = NSOWatch.isOn() && b.classList.contains('is-on') &&
                  document.getElementById('nso-watch-panel').classList.contains('is-on');
    b.click();
    const offNow = !NSOWatch.isOn() && !b.classList.contains('is-on') &&
                   !document.getElementById('nso-watch-panel').classList.contains('is-on');
    return { onNow, offNow };
  });
  ok(t.onNow, 'one click turns it on and shows the panel');
  ok(t.offNow, 'a second click turns it off and hides the panel');
  /* Grok owns the HUD string (docs/HANDOFF.md). The app itself writes hints
     into that element, so the check is that nothing the WATCHER does writes
     to it: park a sentinel, then run the watcher's own work over it. */
  const hud = await page.evaluate(() => {
    const el = document.getElementById('adjust-status');
    el.textContent = 'sentinel-do-not-touch';
    NSOWatch.start();
    console.error('a logged error');
    NSOWatch.check('a consistency pass');
    const after = el.textContent;
    NSOWatch.stop();
    return after;
  });
  ok(hud === 'sentinel-do-not-touch', 'the watcher never writes to the HUD line', JSON.stringify(hud));
}

withApp(async (page, logs) => {
  await partA(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await partB1(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await partB2(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await partB3(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await partC(page);
  await partD(page);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\n--- page console (last 20) ---');
    console.log(logs.slice(-20).join('\n'));
    process.exitCode = 1;
  }
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});

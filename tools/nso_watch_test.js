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
        1. pose lost across an app-finish.js bake - rotate a piece, then Seal
           it. This is the half `nso_pose_after_bake_test.js` does not cover:
           that gate is on NSO_sculptCommitRaw, which now puts the pose back.
        2. paint left on screen      - paint a face, then Seal it. FIXED
                                       2026-09-24 and retired as below: now
                                       it must report nothing, and a stray
                                       overlay is the negative control
        3. a piece restored without its model - Delete, then Undo
      If a case is ever fixed in the app, its assertion here fails loudly -
      which is the point. The check is then to be retired with the fix, not
      before.

   C/D. The error and status log, and the button.

   E. What the log records AROUND the phantom checks, driven for real:
        1. every selection change is its own event - selectPlaced(), a real
           click on a piece in the viewport, a bare state.selectedIndex write -
           and lands BEFORE the operation that follows it, which carries the
           selection it acted on;
        2. a preview and a commit read differently - a real brush drag
           (preview, then commit) and one abandoned with Escape (preview, then
           discard), with their status lines tagged the same way;
        3. a build-volume warning reaches the log through setStatus, and so
           does its clearing;
        4. the history is kept in this browser across a reload, one run per
           start, and the in-app Report view shows and filters all of it.

   F. The panel sits clear of the left tool rail and collapses to its header
      bar, which frees the Scale card the expanded log covers at 1024 x 768.

   G. Seat + paint (driver-testing round 2): paint follows its piece through
      a drag, a Join and a Seat; commits are logged against the piece they
      changed; Clear paint and off-piece paint clicks name the piece.

   Every button here is pressed with element.click() inside the page rather
   than a Playwright click, so the viewport accordion (docs/HANDOFF.md, "a
   second viewport menu") cannot hide a control out from under this suite.

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
    ['raised', () => page.evaluate(() => liftSelected(1))],
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
    /* The click-owning modes and the read-only tools that came later. Each is
       switched on and straight back off, because a tool switch is exactly
       when the scene and the state have a chance to part company. */
    ...[
      'btn-measure', 'btn-check-defects', 'btn-seat-grid', 'btn-mask-select',
      'btn-brush', 'btn-carve', 'btn-lock-pos', 'btn-plate-lock', 'btn-frame-view'
    ].flatMap(id => [
      [id + ' on', () => page.evaluate(b => { const e = document.getElementById(b); if (e) e.click(); }, id)],
      [id + ' off', () => page.evaluate(b => { const e = document.getElementById(b); if (e) e.click(); }, id)]
    ]),
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

  /* FIXED in the app (2026-09-24, driver-testing round 2) and retired here
     the way this file says a fixed case is: the overlay now shares the
     piece's own transform objects and app-mask.js re-draws it whenever the
     active piece, its mesh or its geometry changes. So Seal and a turn,
     which used to leave the yellow on a surface / pose that was gone, must
     now leave nothing to report - and the paint must still be on screen,
     on the new geometry, which is the half that proves the fix is not just
     the yellow disappearing. */
  found = await after(page, 'seal', () => sealSelectedModel());
  ok(found.filter(f => f.subject === 'paint').length === 0,
     'Seal on a painted piece leaves no phantom paint (fixed: repainted on the new geometry)', texts(found));
  const afterSeal = await page.evaluate(() => {
    const ov = state.modelGroup.children.filter(o => o.isMesh && o.renderOrder === 40);
    const pm = state.placed.find(p => p && p.mesh && p.sourceId === getActiveModel().id);
    return { n: ov.length, tris: ov.length ? ov[0].geometry.attributes.position.count / 3 : 0,
             mask: nsoMaskCount(getActiveModel()) };
  });
  ok(afterSeal.mask === 1 && afterSeal.n === 1 && afterSeal.tris > 0,
     'the face is still excluded and the yellow is still drawn after the bake', JSON.stringify(afterSeal));

  found = await after(page, 'rotate a painted piece', () => rotateSelected(1));
  ok(found.filter(f => f.subject === 'paint').length === 0,
     'turning a painted piece carries the paint with it (fixed: the overlay shares the piece\'s transform)',
     texts(found));
  ok(await page.evaluate(() => {
    const ov = state.modelGroup.children.filter(o => o.isMesh && o.renderOrder === 40)[0];
    const pm = state.placed.find(p => p && p.mesh && p.sourceId === getActiveModel().id);
    return !!ov && ov.position === pm.mesh.position && ov.quaternion === pm.mesh.quaternion;
  }), 'the yellow\'s position and rotation ARE the piece\'s, not copies of them');

  /* The paint checks still fire: a second overlay the paint module does not
     own is exactly the kind of picture-vs-state mismatch they exist for. */
  found = await after(page, 'a stray second overlay', () => {
    const ov = state.modelGroup.children.filter(o => o.isMesh && o.renderOrder === 40)[0];
    const extra = ov.clone(); extra.name = 'stray-test-overlay';
    state.modelGroup.add(extra);
  });
  ok(found.some(f => f.subject === 'paint' && /paint overlays are in the scene/.test(f.msg)),
     'negative control: a stray second paint overlay is still reported', texts(found));
  await page.evaluate(() => {
    const x = state.modelGroup.getObjectByName('stray-test-overlay');
    if (x) state.modelGroup.remove(x);
  });

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

/* ---------------- E ---------------- */
const lastOf = (evs, kind) => evs.filter(e => e.kind === kind).slice(-1)[0] || null;
const evs = page => page.evaluate(() => NSOWatch.events());

/* Client pixels for a point on the piece at placed[idx], projected through
   the app's own camera. */
const pieceTopPx = (page, idx, dx, dz) => page.evaluate(([i, ox, oz]) => {
  const p = state.placed[i];
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  const v = new THREE.Vector3(p.mesh.position.x + (ox || 0), bb.max.y - 0.02, p.mesh.position.z + (oz || 0));
  v.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, [idx, dx, dz]);

async function partE1(page) {
  console.log('\nE1. selection changes are events, and ops carry what they acted on');
  await loadSTL(page, SLAB);
  await loadSTL(page, BOX);
  const nPlaced = await page.evaluate(() => state.placed.filter(p => p && p.mesh).length);
  ok(nPlaced >= 2, 'two pieces are on the plate', 'placed: ' + nPlaced);
  await page.evaluate(() => { selectPlaced(-1); state.editId = null; NSOWatch.start(); });

  let ev = await evs(page);
  const base = ev.find(e => e.kind === 'select');
  ok(!!base && /selection at start: no piece/.test(base.msg), 'the selection at start is logged',
     base ? base.msg : '(none)');

  await page.evaluate(() => selectPlaced(0));
  await page.waitForTimeout(30);
  ev = await evs(page);
  let sel = ev.filter(e => e.kind === 'select');
  ok(sel.length === 2 && /^selected placed\[0\]/.test(sel[1].msg),
     'selectPlaced(0) produces a selection event naming placed[0]', sel.map(e => e.msg).join(' | '));
  ok(sel.length === 2 && sel[1].sel && sel[1].sel.index === 0 && sel[1].sel.editId != null,
     'it records the index and the active model', JSON.stringify(sel[1] && sel[1].sel));

  await page.evaluate(() => { selectPlaced(0); });
  await page.waitForTimeout(30);
  ok((await evs(page)).filter(e => e.kind === 'select').length === 2,
     'selecting what is already selected is not a change');

  /* A real click on the other piece, through the canvas. */
  await page.evaluate(() => { if (state.controls) state.controls.update(); });
  const px = await pieceTopPx(page, 1, 0, 0);
  await page.mouse.click(px.x, px.y);
  await page.waitForTimeout(80);
  ev = await evs(page);
  const clickSel = lastOf(ev, 'select');
  const nowIdx = await page.evaluate(() => state.selectedIndex);
  ok(nowIdx === 1 && clickSel && clickSel.sel.index === 1 && /was placed\[0\]/.test(clickSel.msg),
     'a real click on placed[1] is logged as a change from placed[0]',
     'selectedIndex ' + nowIdx + '; ' + (clickSel ? clickSel.msg : '(none)'));

  await page.evaluate(() => { state.selectedIndex = -1; state.editId = null; });
  await page.waitForTimeout(30);
  ok(/^selection cleared/.test((lastOf(await evs(page), 'select') || {}).msg || ''),
     'a bare state write that clears the selection is logged too',
     (lastOf(await evs(page), 'select') || {}).msg);

  /* Select, then act, in the SAME tick: the select line must come first and
     the commit must carry it. */
  await page.evaluate(() => { selectPlaced(0); nudgeSelected(4, 4); });
  await page.waitForTimeout(50);
  ev = await evs(page);
  const s2 = lastOf(ev, 'select');
  const c2 = ev.filter(e => e.kind === 'op' && e.phase === 'commit').slice(-1)[0];
  ok(!!c2, 'the nudge is logged as a commit', c2 ? c2.msg : JSON.stringify(ev.slice(-4).map(e => e.msg)));
  ok(!!(s2 && c2 && s2.seq < c2.seq && s2.sel.index === 0),
     'the selection event lands before the operation that follows it',
     s2 && c2 ? 'select #' + s2.seq + ', commit #' + c2.seq : '');
  ok(!!(c2 && c2.sel && c2.sel.index === 0 && c2.sel.sourceId != null),
     'and the commit records what it acted on', JSON.stringify(c2 && c2.sel));
  ok((await page.evaluate(() => NSOWatch.open())).length === 0, 'none of this raises a phantom');
}

async function partE2(page) {
  console.log('\nE2. a preview and a commit read differently');
  /* The brush on the box: its drag is the app's live preview. */
  const boxIdx = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return state.placed.findIndex(p => p && p.sourceId === m.id);
  });
  await page.evaluate(i => selectPlaced(i), boxIdx);
  await page.evaluate(() => {
    const b = document.getElementById('btn-brush');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v);
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('inp-brush-size', 6); set('inp-brush-intensity', 0.6); set('sel-brush-mode', 'carve');
    if (!window.nsoBrushArmed()) document.getElementById('btn-brush').click();
  });
  const mark = (await evs(page)).length;
  const a = await pieceTopPx(page, boxIdx, -4, 0);
  const b = await pieceTopPx(page, boxIdx, 4, 0);
  async function drag(escape) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8);
      if (escape && i === 4) await page.keyboard.press('Escape');
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  await drag(false);
  let ev = (await evs(page)).slice(mark);
  const ops = ev.filter(e => e.kind === 'op');
  const pv = ops.find(e => e.phase === 'preview');
  const cm = ops.find(e => e.phase === 'commit');
  ok(!!pv && /brush carve stroke/.test(pv.msg), 'the drag is logged as a preview', JSON.stringify(ops.map(e => e.msg)));
  ok(!!cm && /brushReplace/.test(cm.msg), 'letting go is logged as a commit', JSON.stringify(ops.map(e => e.msg)));
  ok(!!(pv && cm && pv.seq < cm.seq), 'preview first, commit second');
  ok(!!(pv && cm && pv.sel && cm.sel && pv.sel.index === cm.sel.index),
     'both carry the piece they worked on', JSON.stringify([pv && pv.sel, cm && cm.sel]));
  const st = ev.filter(e => e.kind === 'status');
  const stPv = st.find(e => /drag to work the surface/.test(e.msg));
  const stCm = st.find(e => /Carve done/.test(e.msg));
  ok(!!stPv && stPv.phase === 'preview', "the brush's live status line is tagged preview",
     JSON.stringify(st.map(e => e.phase + '|' + e.msg.slice(0, 40))));
  ok(!!stCm && stCm.phase === 'commit', 'its result line is tagged commit - the two no longer read alike',
     JSON.stringify(st.map(e => e.phase + '|' + e.msg.slice(0, 40))));

  const mark2 = (await evs(page)).length;
  await drag(true);
  ev = (await evs(page)).slice(mark2);
  const ops2 = ev.filter(e => e.kind === 'op').map(e => e.phase);
  ok(JSON.stringify(ops2) === '["preview","discard"]',
     'a stroke abandoned with Escape is a preview then a discard, and never a commit', JSON.stringify(ops2));
  const cancelLine = ev.find(e => e.kind === 'status' && /cancelled/.test(e.msg));
  ok(!!cancelLine && cancelLine.phase === 'discard', 'and its status line says discard',
     cancelLine ? cancelLine.phase : '(no line)');

  await page.evaluate(() => { if (window.nsoBrushArmed()) document.getElementById('btn-brush').click(); });

  /* Undo is its own phase, not a commit. */
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(50);
  const u = lastOf(await evs(page), 'op');
  ok(!!u && u.phase === 'undo' && /brushReplace/.test(u.msg), 'Undo is logged as an undo of what it reverts',
     u ? u.msg : '(none)');
  ok((await page.evaluate(() => NSOWatch.open())).length === 0, 'none of this raises a phantom');
}

async function partE3(page) {
  console.log('\nE3. build-volume warnings reach the log');
  const setPlate = (h) => page.evaluate(v => {
    const sel = document.getElementById('plate-select');
    if (sel.value !== 'custom') { sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    const e = document.getElementById('custom-h');
    e.value = String(v);
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, h);
  const mark = (await evs(page)).length;
  await setPlate(5);
  await page.waitForFunction(() => !document.getElementById('build-volume-warning').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(50);
  let ev = (await evs(page)).slice(mark);
  const w = ev.filter(e => e.kind === 'status' && e.source === 'build-volume');
  const shown = await page.evaluate(() => document.getElementById('build-volume-warning').textContent.trim());
  ok(w.length >= 1 && w[0].level === 'warn' && w[0].category === 'build-volume',
     'a build volume too short for the pieces is logged as a build-volume warning', JSON.stringify(w.map(e => e.msg)));
  const statusNow = await page.evaluate(() => document.getElementById('status').textContent);
  ok(w.length >= 1 && w[0].msg.endsWith('Build volume: ' + shown) && w[0].msg === statusNow,
     'the logged line is the status line, carrying the warning the page shows', w.length ? w[0].msg : shown);
  const again = (await evs(page)).length;
  await page.waitForTimeout(300);
  ok((await evs(page)).length === again, 'an unchanged warning is not re-logged every frame');

  await setPlate(300);
  await page.waitForFunction(() => document.getElementById('build-volume-warning').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(50);
  ev = (await evs(page)).slice(mark);
  ok(ev.some(e => e.source === 'build-volume' && /fits again/.test(e.msg)),
     'and its clearing is logged too', JSON.stringify(ev.filter(e => e.source).map(e => e.msg)));
}

async function partE4(page) {
  console.log('\nE4. the history persists in the browser, and the Report view shows it');
  const before = await page.evaluate(() => {
    const st = NSOWatch.stored();
    const run = st.runs[st.runs.length - 1].id;
    return { runs: st.runs.length, n: st.events.length, run,
             inRun: st.events.filter(e => e.run === run).length, live: NSOWatch.events().length };
  });
  ok(before.inRun === before.live && before.live > 10, 'every live event is also in the stored history',
     'stored for this run ' + before.inRun + ', live ' + before.live);

  /* The watch stays on across a reload (nso.watch in localStorage), which
     starts a new run on top of the old one. */
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await page.waitForFunction(() => window.NSOWatch && NSOWatch.isOn());
  await page.evaluate(() => { console.warn('a warning in the second run'); });
  await page.waitForTimeout(400);
  const after = await page.evaluate(run => {
    const st = NSOWatch.stored();
    return { runs: st.runs.map(r => r.id), n: st.events.length,
             old: st.events.filter(e => e.kind === 'select').length,
             oldRun: st.events.filter(e => e.run === run).length };
  }, before.run);
  ok(after.runs.length === before.runs + 1, 'a reload with the watch on starts a second run',
     after.runs.length + ' run(s)');
  ok(after.runs.includes(before.run) && after.oldRun >= before.inRun && after.n > before.n,
     'the first run\'s events survive the reload, and the new ones are added',
     'that run: ' + before.inRun + ' -> ' + after.oldRun + '; all runs: ' + before.n + ' -> ' + after.n);

  const ui = await page.evaluate(() => {
    const noSave = !document.getElementById('nso-watch-save');
    document.getElementById('nso-watch-report-btn').click();
    const r = document.getElementById('nso-watch-report');
    const rows = r.querySelectorAll('.nso-watch-row').length;
    const runs = r.querySelectorAll('.wr-run').length;
    const opts = r.querySelectorAll('#nso-wr-run option').length;
    const sum = Array.from(r.querySelectorAll('#nso-wr-sum button')).map(b => b.textContent);
    return { noSave, open: r.classList.contains('is-on') && r.offsetHeight > 100, rows, runs, opts, sum };
  });
  ok(ui.noSave, 'the panel no longer offers a download button');
  ok(ui.open, 'the Report button opens the in-app report view');
  ok(ui.rows >= after.n - 2 && ui.runs >= 2 && ui.opts === after.runs.length + 1,
     'it lists the whole history, grouped by run', JSON.stringify(ui));
  ok(ui.sum.some(t => /\d+ select/.test(t)) && ui.sum.some(t => /\d+ commit/.test(t)) &&
     ui.sum.some(t => /\d+ preview/.test(t)) && ui.sum.some(t => /\d+ build-volume/.test(t)),
     'its summary counts selections, previews, commits and build-volume lines', ui.sum.join(', '));

  const filt = await page.evaluate(() => {
    const r = document.getElementById('nso-watch-report');
    r.querySelector('#nso-wr-sum button[data-cat="select"]').click();
    const rows = Array.from(r.querySelectorAll('.nso-watch-row'));
    const onlySel = rows.length > 0 && rows.every(d => d.classList.contains('k-select'));
    const selN = rows.length;
    r.querySelector('#nso-wr-sum button[data-cat="select"]').click();       // off again
    const runSel = r.querySelector('#nso-wr-run');
    runSel.value = runSel.options[runSel.options.length - 1].value;
    runSel.dispatchEvent(new Event('change', { bubbles: true }));
    const liveRows = r.querySelectorAll('.nso-watch-row').length;
    const liveRuns = r.querySelectorAll('.wr-run').length;
    const q = r.querySelector('#nso-wr-q');
    q.value = 'second run';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const hits = Array.from(r.querySelectorAll('.nso-watch-row')).map(d => d.textContent);
    q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
    runSel.value = 'all'; runSel.dispatchEvent(new Event('change', { bubbles: true }));
    return { onlySel, selN, liveRows, liveRuns, hits };
  });
  ok(filt.onlySel, 'filtering by kind shows only that kind', filt.selN + ' row(s)');
  ok(filt.liveRuns === 1 && filt.liveRows > 0, 'picking one run shows only that run', JSON.stringify(filt));
  ok(filt.hits.length === 1 && /a warning in the second run/.test(filt.hits[0]),
     'text search finds the one line', JSON.stringify(filt.hits));

  /* Live: an event in the running session shows up in the open report. */
  const live = await page.evaluate(async () => {
    const r = document.getElementById('nso-watch-report');
    const n0 = r.querySelectorAll('.nso-watch-row').length;
    selectPlaced(0);
    await new Promise(res => setTimeout(res, 400));
    return r.querySelectorAll('.nso-watch-row').length - n0;
  });
  ok(live >= 1, 'the open report follows the session live', '+' + live + ' row(s)');

  const wiped = await page.evaluate(() => {
    document.getElementById('nso-wr-wipe').click();
    const st = NSOWatch.stored();
    const r = document.getElementById('nso-watch-report');
    document.getElementById('nso-wr-close').click();
    return { n: st.events.length, runs: st.runs.length, closed: !r.classList.contains('is-on') };
  });
  ok(wiped.n === 0 && wiped.runs === 1, 'Clear history empties it, keeping only the live run', JSON.stringify(wiped));
  ok(wiped.closed, 'and Close hides the view');

  const restored = await page.evaluate(() => {
    NSOWatch.stop();
    const d = Object.getOwnPropertyDescriptor(state, 'selectedIndex');
    const e = Object.getOwnPropertyDescriptor(state, 'editId');
    return { plain: 'value' in d && d.writable && 'value' in e && e.writable };
  });
  ok(restored.plain, 'stop() puts state.selectedIndex and state.editId back as plain properties');
}


/* F. The panel must not take the controls under it away (driver-testing
   round 1, 2026-09-24). At the pane size it was found at, 1024 x 768, the
   expanded log covered the Scale card's "Scale by" button and the Undo
   button: a real click landed on the log. The panel now starts right of the
   left tool rail, so Undo is clear even expanded; collapsed, the Scale card
   is clear too, the phantom / error pills stay on screen, the watch keeps
   logging, and the choice survives a reload. */
async function partF(page) {
  console.log('\nF. collapsing the panel frees the controls under it');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => { try { localStorage.removeItem('nso.watch.collapsed'); } catch (e) {} });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await loadSTL(page, path.join(ROOT, 'fixtures', 'quick', 'cube-12mm.stl'));
  const hit = () => page.evaluate(() => {
    if (!NSOWatch.isOn()) NSOWatch.start();
    document.getElementById('menu-scale').open = true;
    const at = id => {
      const r = document.getElementById(id).getBoundingClientRect();
      const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!e && (e.id === id || !!e.closest('#' + id));
    };
    const pills = ['nso-watch-n-phantom', 'nso-watch-n-error'].every(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return { scale: at('btn-scale-factor'), undo: at('btn-undo'), pills,
             collapsed: NSOWatch.isCollapsed(),
             expanded: document.getElementById('nso-watch-collapse').getAttribute('aria-expanded') };
  });
  // A session's worth of lines, so the log is as tall as it gets in use.
  await page.evaluate(() => { if (!NSOWatch.isOn()) NSOWatch.start(); for (let i = 0; i < 30; i++) setStatus('status line ' + i + ' of a working session'); });
  await page.waitForTimeout(100);
  const open = await hit();
  ok(open.collapsed === false && open.expanded === 'true', 'the panel starts expanded, as it always has');
  ok(open.undo, 'expanded, the log no longer sits on the left tool rail - Undo takes the click',
     JSON.stringify(open));
  ok(!open.scale, 'expanded, it can still cover the Scale card - which is what collapsing is for',
     JSON.stringify(open));
  await page.evaluate(() => document.getElementById('nso-watch-collapse').click());
  const shut = await hit();
  ok(shut.collapsed && shut.expanded === 'false', 'the collapse button collapses it');
  ok(shut.scale && shut.undo, 'collapsed, "Scale by" and Undo take the click again', JSON.stringify(shut));
  ok(shut.pills, 'the phantom and error pills are still on screen');
  const logs = await page.evaluate(() => {
    const n = NSOWatch.events().length;
    console.error('logged while collapsed');
    return NSOWatch.events().length > n;
  });
  ok(logs, 'it keeps logging while collapsed');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await page.waitForFunction(() => window.NSOWatch && NSOWatch.isOn());
  ok(await page.evaluate(() => NSOWatch.isCollapsed()), 'the choice survives a reload');
  await page.evaluate(() => document.getElementById('nso-watch-collapse').click());
  ok(await page.evaluate(() => !NSOWatch.isCollapsed() &&
       getComputedStyle(document.getElementById('nso-watch-list')).display !== 'none'),
     'and the same button brings the log back');
  await page.evaluate(() => { try { localStorage.removeItem('nso.watch.collapsed'); } catch (e) {} });
  await page.setViewportSize({ width: 1280, height: 720 });
}


/* G. Seat + paint, driven the way a person does it (driver-testing round 2,
   2026-09-24). Four things that round found, each pinned from both sides -
   the app's own state and what Watch logged:
     1. a painted piece dragged with the mouse, or seated, takes its yellow
        with it (it used to stay on the plate where the piece had been);
     2. Join's slot picks switch the active piece and the yellow follows,
        with no phantom (it used to keep showing the previous piece's paint);
     3. a commit is logged against the piece its undo entry names, not the
        selection, and a press on the 3D view is its own operation label;
     4. Clear paint and a paint click on a piece that is not the active one
        say which piece they touched. */
async function partG(page) {
  console.log('\nG. Seat + paint');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await page.evaluate(() => { if (!NSOWatch.isOn()) NSOWatch.start(); NSOWatch.collapse(true); });
  const idA = await loadSTL(page, SLAB);
  const idB = await loadSTL(page, path.join(ROOT, 'fixtures', 'quick', 'cube-6mm.stl'));
  await page.evaluate(() => {
    window.__G = {
      placed: id => state.placed.find(q => q && q.sourceId === id && q.mesh),
      model: id => state.models.find(m => m.id === id),
      moveTo: (id, x, z) => { const i = state.placed.findIndex(p => p.sourceId === id); selectPlaced(i);
        const p = state.placed[i]; nudgeSelected(x - p.x, z - p.z); },
      top: id => { const p = __G.placed(id); p.mesh.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(p.mesh); const c = bb.getCenter(new THREE.Vector3());
        const v = new THREE.Vector3(c.x, bb.max.y, c.z).project(state.camera);
        const r = state.renderer.domElement.getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; },
      arm: on => { const b = document.getElementById('btn-mask-paint');
        if ((b.getAttribute('aria-pressed') === 'true') !== on) b.click(); },
      overlay: () => state.modelGroup.children.filter(o => o.isMesh && o.renderOrder === 40),
      paintFindings: from => NSOWatch.events().filter(e => e.seq > from && e.kind === 'phantom' && /paint/.test(e.msg)).map(e => e.msg),
      mark: () => NSOWatch.events().length
    };
  });
  await page.evaluate(([a, b]) => { __G.moveTo(b, 55, 0); selectPlaced(state.placed.findIndex(p => p.sourceId === b)); }, [idA, idB]);
  // paint B's top with a real click, B being the active piece
  await page.evaluate(() => __G.arm(true));
  let [x, y] = await page.evaluate(b => __G.top(b), idB);
  await page.mouse.click(x, y);
  await page.evaluate(() => __G.arm(false));
  const p0 = await page.evaluate(b => ({ n: nsoMaskCount(__G.model(b)), ov: __G.overlay().length,
    op: NSOWatch.events().filter(e => e.kind === 'op' && /maskReplace/.test(e.msg)).pop() }), idB);
  ok(p0.n === 1 && p0.ov === 1, 'B carries one painted face and the yellow is drawn', JSON.stringify({ n: p0.n, ov: p0.ov }));
  ok(p0.op && p0.op.op === 'press on the 3D view',
     'the paint commit carries the press on the 3D view as its operation, not the last button', p0.op && p0.op.op);

  // 1. a real mouse drag of the painted piece
  let m = await page.evaluate(() => __G.mark());
  [x, y] = await page.evaluate(b => __G.top(b), idB);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 60, y + 10, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(2300);
  const d = await page.evaluate(([b, m]) => { const ov = __G.overlay()[0], p = __G.placed(b);
    return { moved: Math.hypot(p.x - 55, p.z), same: !!ov && ov.position === p.mesh.position, ph: __G.paintFindings(m) }; }, [idB, m]);
  ok(d.moved > 3 && d.same && d.ph.length === 0,
     'dragging a painted piece takes its yellow with it - no phantom paint', JSON.stringify(d));

  // 2. Join: slot picks switch the active piece; 1b. Seat (support) moves painted B
  m = await page.evaluate(() => __G.mark());
  await page.evaluate(([a, b]) => { __G.moveTo(b, 10, 0);
    document.getElementById('btn-join-start').click();
    document.getElementById('join-slot-a').click(); document.querySelector('.model-item[data-edit-id="' + a + '"]').click();
    document.getElementById('join-slot-b').click(); document.querySelector('.model-item[data-edit-id="' + b + '"]').click(); }, [idA, idB]);
  await page.waitForTimeout(2300);
  ok(await page.evaluate(m => __G.paintFindings(m).length === 0, m),
     'Join\'s slot picks change the active piece with no phantom paint',
     JSON.stringify(await page.evaluate(m => __G.paintFindings(m), m)));
  m = await page.evaluate(() => __G.mark());
  await page.evaluate(() => { document.getElementById('status').textContent = ''; document.getElementById('btn-seat-support').click(); });
  await page.waitForTimeout(2300);
  const seat = await page.evaluate(([b, m]) => ({ status: document.getElementById('status').textContent,
    n: nsoMaskCount(__G.model(b)), ph: __G.paintFindings(m),
    commit: NSOWatch.events().filter(e => e.seq > m && e.kind === 'op' && e.phase === 'commit').map(e => e.msg) }), [idB, m]);
  ok(/^Seated - air gap 0\.18mm/.test(seat.status) && seat.n === 1 && seat.ph.length === 0,
     'Seat (support) seats painted B at the gap, keeps its paint, and leaves no phantom paint', JSON.stringify(seat));
  ok(seat.commit.some(t => /^commit posePlaced on "cube-6mm" \(model #\d+\) - not the active piece$/.test(t)),
     'the seat is logged against B, the piece its undo entry names - not the active hull', JSON.stringify(seat.commit));

  // 3. paint click on A while B is the selected piece: logged against A
  await page.evaluate(() => document.getElementById('btn-undo').click());
  await page.evaluate(b => { document.getElementById('btn-join-start').click(); __G.moveTo(b, 55, 0); }, idB);
  m = await page.evaluate(() => __G.mark());
  await page.evaluate(() => __G.arm(true));
  [x, y] = await page.evaluate(a => __G.top(a), idA);
  await page.mouse.click(x, y);
  await page.evaluate(() => __G.arm(false));
  const attr = await page.evaluate(([a, m]) => {
    const c = NSOWatch.events().filter(e => e.seq > m && e.kind === 'op' && /maskReplace/.test(e.msg)).pop();
    const st = NSOWatch.events().filter(e => e.seq > m && e.kind === 'status' && /^Excluded/.test(e.msg)).pop();
    return { msg: c && c.msg, target: c && c.detail && c.detail.target, status: st && st.msg,
             aPainted: nsoMaskCount(__G.model(a)) };
  }, [idA, m]);
  ok(attr.aPainted === 1 && attr.target && attr.target.modelId === idA && attr.target.selected === false &&
     / - not the selected piece$/.test(attr.msg),
     'a paint click on A while B is selected is logged against A, and says it is not the selected piece', JSON.stringify(attr));
  ok(/ on "box_hull_80x40x20-2" \(not drawn: the yellow shows the active piece, "cube-6mm"\)/.test(attr.status || ''),
     'the status names the piece painted and says why its yellow is not drawn - no "0 tris yellow"', attr.status);

  // 4. Clear paint inside a Join names the piece it cleared
  await page.evaluate(([a, b]) => {
    document.getElementById('btn-join-start').click();
    document.getElementById('join-slot-a').click(); document.querySelector('.model-item[data-edit-id="' + a + '"]').click();
    document.getElementById('join-slot-b').click(); document.querySelector('.model-item[data-edit-id="' + b + '"]').click();
    selectPlaced(state.placed.findIndex(p => p.sourceId === b));
    document.getElementById('btn-mask-clear').click(); }, [idA, idB]);
  const clr = await page.evaluate(([a, b]) => ({ status: document.getElementById('status').textContent,
    a: nsoMaskCount(__G.model(a)), b: nsoMaskCount(__G.model(b)) }), [idA, idB]);
  ok(clr.a === 0 && clr.b === 1 &&
     clr.status === 'Paint cleared on "box_hull_80x40x20-2" - 0 faces excluded, no target face - "cube-6mm" is selected but is not the active piece; its paint is untouched',
     'Clear paint in a Join clears the active hull, names it, and says the selected bit\'s paint is untouched', JSON.stringify(clr));
  await page.setViewportSize({ width: 1280, height: 720 });
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
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true);
  await partE1(page);
  await partE2(page);
  await partE3(page);
  await partE4(page);
  await partF(page);
  await partG(page);

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

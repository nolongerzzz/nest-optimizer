#!/usr/bin/env node
// Soften, live (app-soften-live.js): the card, the tiles, the ghost, the bake.
//
//   node tools/nso_soften_live_drive_check.js        exit 0 = every gate held
//
// Drives the real app in headless Chromium, with real clicks where a click is
// the thing being asked for.
//
//   1  the card        closed until Soften is pressed; four tiles, each painted
//                      from the engine (a cube's top face softened in that style),
//                      each a different picture, each lighting some surface;
//                      nothing on the piece before a style is picked
//   2  a box           (Full wrap: no face to click) every style previews at once,
//                      the piece is untouched while it does, R moves the preview,
//                      the bake installs the previewed soup bit for bit, ONE Undo
//                      step, and Undo gives the piece back
//   3  put away        Cancel, Escape, another tool taking the hand: the ghost goes,
//                      the piece's material is as it was, nothing was baked
//   4  a cylinder      (not a box: softened a face at a time) the style waits for a
//                      face, a real click adds it, the same click again takes it
//                      off, and the bake installs what was shown
//   5  Full wrap off   a box asks for the faces too
//   6  a click on a box with the card open names nothing and bakes nothing
//   7  a pocket piece  its preview comes back from the boolean kernel, and the
//                      bake installs that soup

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const fx = (n) => path.join(ROOT, 'fixtures', n);
const STYLES = ['fillet', 'corners', 'cornersedges', 'chamfer'];

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  const info = () => page.evaluate(() => { const i = window.nsoSoftenLive.info(); if (i) delete i.soup; return i; });
  const undoDepth = () => page.evaluate(() => state.undoStack.length);
  const rawLen = () => page.evaluate(() => state.models[0].rawTris.length);
  const ghosts = () => page.evaluate(() => { let n = 0; state.scene.traverse(o => { if (o.userData && o.userData.nsoSoftenGroup) n++; }); return n; });
  const matOf = () => page.evaluate(() => { const m = state.placed[0].mesh.material; return { t: !!m.transparent, o: m.opacity, w: !!m.depthWrite }; });
  const waitPlan = (ms) => page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return !!(i && i.ok); }, null, { timeout: ms || 20000 });
  const tile = (st) => page.click('#soften-shelf [data-style="' + st + '"]');
  const idOf = () => page.evaluate(() => state.models[0].id);
  const frames = (n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  const lookDown = async (id) => {
    await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
      state.controls.target.copy(c);
      state.camera.position.set(c.x + 8, c.y + 60, c.z + 45);
      state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    }, id);
    await frames(2);
  };
  const topOf = (id) => page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh);
    const v = b.getCenter(new THREE.Vector3()); v.y = b.max.y;
    state.camera.updateMatrixWorld(true); v.project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }, id);
  const clickAt = async (s) => {
    await page.mouse.move(s.x - 3, s.y - 3);
    await page.mouse.move(s.x, s.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(500);
  };
  const openCard = async () => {
    const open = await page.evaluate(() => document.getElementById('menu-surface').open);
    if (!open) await page.click('#menu-surface > summary');
  };
  /* The soup the preview holds, kept for comparing with what the bake leaves. */
  const keepGhost = () => page.evaluate(() => { window.__ghost = Array.from(window.nsoSoftenLive.info().soup); return window.__ghost.length; });
  const sameAsGhost = () => page.evaluate(() => {
    const g = window.__ghost, r = state.models[0].rawTris;
    if (!g || g.length !== r.length) return false;
    for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
    return true;
  });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the card ===');
  await loadSTL(page, fx('box-20mm.stl'));
  await page.waitForTimeout(400);
  await page.evaluate(() => selectPlaced(0));
  await openCard();
  check('the panel is closed until Soften is pressed',
    await page.evaluate(() => document.getElementById('soften-panel').hidden === true));
  const undo0 = await undoDepth(), raw0 = await rawLen(), mat0 = await matOf();
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  check('Soften opens the card, with no style picked', await page.evaluate(() =>
    document.getElementById('soften-panel').hidden === false && window.nsoSoftenLive.on() &&
    window.nsoSoftenLive.info().style === null));
  check('the Soften button reads as pressed', await page.evaluate(() => document.getElementById('btn-soften').getAttribute('aria-pressed') === 'true'));
  check('four tiles, in order Round / Corners / Corners+edges / Bevel, each painted', await page.evaluate((want) => {
    const t = [...document.querySelectorAll('#soften-shelf button[data-style]')];
    return t.map(b => b.dataset.style).join() === want.join() && t.every(b => b.querySelector('canvas[data-drawn="1"]'));
  }, STYLES));
  const pics = await page.evaluate(() => [...document.querySelectorAll('#soften-shelf canvas')].map(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let green = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (d[i + 1] > d[i + 2] + 20 && d[i + 1] > d[i] + 30) green++;       // the lit (changed) surface
      else if (d[i + 2] > d[i + 1] + 20 && d[i + 2] > d[i]) blue++;         // the piece's own faces
    }
    return { url: c.toDataURL(), green, blue };
  }));
  check('the four pictures are four different pictures', new Set(pics.map(p => p.url)).size === 4);
  check('each picture lights the surface its style changes and leaves the faces blue', pics.every(p => p.green > 40 && p.blue > 40),
    pics.map(p => p.green + 'g/' + p.blue + 'b').join(' '));
  check('Round lights more than Corners (the rim, against four corners alone)', pics[0].green > pics[1].green,
    pics[0].green + ' vs ' + pics[1].green);
  check('nothing is on the piece, and nothing baked, before a style is picked',
    (await ghosts()) === 1 && (await undoDepth()) === undo0 && (await rawLen()) === raw0 && (await info()).ok === false);
  const ghostMat = await matOf();
  check('the piece turns to a ghost', ghostMat.t === true && ghostMat.o < 0.5 && ghostMat.w === false, JSON.stringify(ghostMat));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. a box: preview, R, bake ===');
  for (const st of STYLES) {
    await tile(st);
    await waitPlan();
    const i = await info();
    check(st + ': previews at once, no face clicked', i.ok && i.kind === 'box' && i.changedTris > 0 && i.picks === 0,
      (i.text || i.reason) + ' [' + i.changedTris + '/' + i.totalTris + ' tris lit]');
    check(st + ': the tile is the one lit', await page.evaluate((s) =>
      document.querySelector('#soften-shelf [data-style="' + s + '"]').classList.contains('is-picked') &&
      document.querySelectorAll('#soften-shelf .is-picked').length === 1, st));
  }
  check('the piece is untouched through all four', (await undoDepth()) === undo0 && (await rawLen()) === raw0);
  await tile('fillet');
  await waitPlan();
  await page.fill('#inp-soften-r', '2.5');
  await page.waitForFunction(() => /2\.50/.test(window.nsoSoftenLive.info().text || ''), null, { timeout: 8000 });
  check('typing R moves the preview', (await info()).R === 2.5);
  await page.evaluate(() => { const s = document.getElementById('inp-soften-slider'); s.value = '1.25'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => /1\.25/.test(window.nsoSoftenLive.info().text || ''), null, { timeout: 8000 });
  check('the slider moves the preview, and writes the R box', (await info()).R === 1.25 &&
    await page.evaluate(() => document.getElementById('inp-soften-r').value === '1.25'));
  await keepGhost();
  await page.click('#btn-soften');
  await page.waitForTimeout(600);
  check('Soften again bakes the soup that was on screen, bit for bit', await sameAsGhost());
  check('ONE Undo step', (await undoDepth()) === undo0 + 1, undo0 + ' -> ' + (await undoDepth()));
  check('the card is put away, the ghost gone, the material back', await page.evaluate(() =>
    document.getElementById('soften-panel').hidden && !window.nsoSoftenLive.on() && !state.softenArmed) &&
    (await ghosts()) === 0 && JSON.stringify(await matOf()) === JSON.stringify(mat0), JSON.stringify(await matOf()));
  check('the status says what was baked', /wrap R 1\.25/.test(await page.evaluate(() => document.getElementById('status').textContent)));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(300);
  check('Undo gives the original piece back', (await rawLen()) === raw0);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. put away ===');
  const away = async (label, how) => {
    await page.click('#btn-soften'); await page.waitForTimeout(200);
    await tile('corners'); await waitPlan();
    await how();
    await page.waitForTimeout(300);
    check(label + ': off, no ghost, nothing baked, material as it was',
      !(await page.evaluate(() => window.nsoSoftenLive.on() || state.softenArmed)) && (await ghosts()) === 0 &&
      (await undoDepth()) === undo0 && (await rawLen()) === raw0 && JSON.stringify(await matOf()) === JSON.stringify(mat0));
  };
  await away('Cancel', () => page.click('#btn-soften-cancel'));
  await away('Escape', () => page.keyboard.press('Escape'));
  await away('another tool takes the hand', () => page.evaluate(() => { state.softenArmed = false; }));
  check('a second press while no style is picked does not bake or cancel', await (async () => {
    await page.click('#btn-soften'); await page.waitForTimeout(150);
    await page.click('#btn-soften'); await page.waitForTimeout(150);
    const r = await page.evaluate(() => window.nsoSoftenLive.on());
    await page.click('#btn-soften-cancel'); await page.waitForTimeout(150);
    return r && (await undoDepth()) === undo0;
  })());

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. a click on a box, card open ===');
  {
    const id = await idOf();
    await lookDown(id);
    await page.click('#btn-soften'); await page.waitForTimeout(200);
    await tile('fillet'); await waitPlan();
    const before = await info();
    await clickAt(await topOf(id));
    const after = await info();
    check('the click names no face and bakes nothing; the preview stands',
      (await undoDepth()) === undo0 && after.ok && after.picks === 0 && after.text === before.text, after.text);
    await page.click('#btn-soften-cancel'); await page.waitForTimeout(150);
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. Full wrap off asks for faces ===');
  {
    const id = await idOf();
    await lookDown(id);
    await page.click('#btn-soften'); await page.waitForTimeout(200);
    await page.evaluate(() => { const c = document.getElementById('chk-full-wrap'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await tile('fillet');
    await page.waitForFunction(() => window.nsoSoftenLive.info().needPick === true, null, { timeout: 8000 });
    check('a box with Full wrap off waits for a face', (await info()).ok === false);
    await clickAt(await topOf(id));
    await waitPlan();
    const i = await info();
    check('a click on its top face previews that one face', i.ok && i.kind === 'faces' && i.picks === 1 && /full wrap off/.test(i.text || ''), i.text);
    await keepGhost();
    await page.click('#btn-soften'); await page.waitForTimeout(600);
    check('and the bake installs it', (await sameAsGhost()) && (await undoDepth()) === undo0 + 1);
    await page.evaluate(() => { undoLast(); const c = document.getElementById('chk-full-wrap'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(300);
    check('Undo gives the box back', (await rawLen()) === raw0);
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. a cylinder: a face at a time ===');
  {
    await loadSTL(page, fx('cylinder_r10h30_s64.stl'));
    await page.waitForTimeout(500);
    await page.evaluate(() => selectPlaced(state.placed.length - 1));
    const cid = await page.evaluate(() => state.models[state.models.length - 1].id);
    const cmodel = () => page.evaluate(i => state.models.find(m => m.id === i).rawTris.length, cid);
    const c0 = await cmodel(), u0 = await undoDepth();
    await lookDown(cid);
    await openCard();
    await page.click('#btn-soften'); await page.waitForTimeout(200);
    await tile('fillet');
    await page.waitForFunction(() => window.nsoSoftenLive.info().needPick === true, null, { timeout: 8000 });
    check('the style waits for a face, and says so', /click the face/.test((await info()).readout || '') && (await info()).ok === false, (await info()).readout);
    const s = await topOf(cid);
    await clickAt(s);
    await waitPlan();
    let i = await info();
    check('a click on the top face puts it in the preview', i.ok && i.kind === 'faces' && i.picks === 1 && i.changedTris > 0, i.text);
    await clickAt(s);
    i = await info();
    check('the same click again takes it back off', !i.ok && i.picks === 0 && i.needPick, i.readout);
    check('the piece was never touched', (await undoDepth()) === u0 && (await cmodel()) === c0);
    await clickAt(s);
    await waitPlan();
    await page.fill('#inp-soften-r', '1');
    await page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return i.R === 1 && i.ok; }, null, { timeout: 8000 });
    await keepGhost();
    await page.click('#btn-soften'); await page.waitForTimeout(600);
    check('the bake installs the previewed face, bit for bit', await page.evaluate(([i]) => {
      const g = window.__ghost, r = state.models.find(m => m.id === i).rawTris;
      if (!g || g.length !== r.length) return false;
      for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
      return true;
    }, [cid]));
    check('ONE Undo step', (await undoDepth()) === u0 + 1);
    await page.evaluate(() => undoLast());
    await page.waitForTimeout(300);
    check('Undo gives the cylinder back', (await cmodel()) === c0);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. a pocket piece: the kernel\'s preview ===');
  {
    await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await page.waitForTimeout(500);
    await page.evaluate(() => selectPlaced(state.placed.length - 1));
    const pid = await page.evaluate(() => state.models[state.models.length - 1].id);
    const u0 = await undoDepth();
    await page.click('#btn-soften'); await page.waitForTimeout(200);
    await tile('fillet');
    await waitPlan(90000);
    const i = await info();
    check('previews with no face clicked', i.ok && i.kind === 'pocket' && i.changedTris > 0, (i.text || i.reason));
    check('the piece is untouched while it does', (await undoDepth()) === u0);
    await keepGhost();
    await page.click('#btn-soften');
    await page.waitForFunction(u => state.undoStack.length > u, u0, { timeout: 30000 });
    check('the bake installs the kernel\'s soup, bit for bit', await page.evaluate(([i]) => {
      const g = window.__ghost, r = state.models.find(m => m.id === i).rawTris;
      if (!g || g.length !== r.length) return false;
      for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
      return true;
    }, [pid]));
  }

  const errs = logs.filter(l => /pageerror|^error/i.test(String(l.type || l)) );
  check('no page errors', errs.length === 0, errs.slice(0, 3).map(e => JSON.stringify(e).slice(0, 200)).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

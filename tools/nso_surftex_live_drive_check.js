#!/usr/bin/env node
// Wrap, live (app-surftex-live.js): the tiles, the ghost, the preview, the bake.
//
//   node tools/nso_surftex_live_drive_check.js        exit 0 = every gate held
//
// Drives the real app in headless Chromium, with real clicks where a click is
// the thing being asked for.
//
//   1  the card      nine tiles (five features, four layouts), each painted from
//                    the engine, each a different picture, each lighting the
//                    surface its wrap made; nothing on the piece until something
//                    on the card is touched
//   2  the preview   a tile ghosts the piece and draws the patch; the piece is
//                    untouched; the tile and the hidden select agree; a number
//                    moves the preview; a skin lights its feature's tile; a
//                    layout tile and the Face list change it
//   3  a click       on the piece names the face under it, as the Face list does
//   4  the bake      WRAP installs the previewed soup bit for bit, one Undo step,
//                    the ghost is gone and the material back, the preview is off
//                    until something is touched; Undo gives the piece back
//   5  put away      Close drops the ghost and the preview, nothing baked
//   6  a refusal     a wrap that fits nowhere says so in the readout, draws
//                    nothing, and WRAP refuses in the same words

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const fx = (n) => path.join(ROOT, 'fixtures', n);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  const info = () => page.evaluate(() => { const i = window.nsoSurftexLive.info(); delete i.soup; return i; });
  const undoDepth = () => page.evaluate(() => state.undoStack.length);
  const rawLen = (i) => page.evaluate(id => state.models.find(m => m.id === id).rawTris.length, i);
  const matOf = () => page.evaluate(() => { const m = state.placed[state.selectedIndex].mesh.material; return { t: !!m.transparent, o: m.opacity, w: !!m.depthWrite }; });
  const ghosts = () => page.evaluate(() => { let n = 0; state.scene.traverse(o => { if (o.userData && o.userData.nsoSurftexGroup) n++; }); return n; });
  const waitPreview = (ms) => page.waitForFunction(() => { const i = window.nsoSurftexLive.info(); return !!(i && i.ok); }, null, { timeout: ms || 20000 });
  const waitText = (re, ms) => page.waitForFunction((src) => new RegExp(src).test(window.nsoSurftexLive.info().text || ''), re.source, { timeout: ms || 15000 });
  const tile = (pick, v) => page.click('#surftex-card [data-pick="' + pick + '"][data-value="' + v + '"]');
  const val = (id) => page.evaluate(i => document.getElementById(i).value, id);
  const lit = (pick) => page.evaluate(p => [...document.querySelectorAll('#surftex-card [data-pick="' + p + '"].is-picked')].map(b => b.dataset.value).join(), pick);
  const frames = (n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  const openCard = async () => {
    await page.evaluate(() => { for (let n = document.getElementById('menu-surftex'); n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.waitForFunction(() => document.querySelectorAll('#sel-surftex-face option').length > 0, null, { timeout: 15000 });
  };
  const shut = () => page.evaluate(() => { document.getElementById('menu-surftex').open = false; });
  const bits = (i) => page.evaluate((id) => {
    const g = window.__ghost, r = state.models.find(m => m.id === id).rawTris;
    if (!g || g.length !== r.length) return false;
    for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
    return true;
  }, i);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the card ===');
  const cid = await loadSTL(page, fx('cylinder_r10h30_s64.stl'));
  await page.click(`.model-item[data-edit-id="${cid}"]`);
  const tris0 = await rawLen(cid), undo0 = await undoDepth();
  await openCard();
  await page.waitForFunction(() => document.querySelectorAll('#surftex-card canvas[data-drawn="1"]').length === 9, null, { timeout: 30000 });
  const feat = await page.evaluate(() => [...document.querySelectorAll('#surftex-features button[data-pick="motif"]')].map(b => b.dataset.value));
  const lay = await page.evaluate(() => [...document.querySelectorAll('#surftex-layouts button[data-pick="layout"]')].map(b => b.dataset.value));
  check('five feature tiles and four layout tiles, each painted', feat.join() === 'spike,ball,bump,dent,line' && lay.join() === 'grid,stagger,hex,diamond', feat.join() + ' | ' + lay.join());
  const pics = await page.evaluate(() => [...document.querySelectorAll('#surftex-card canvas')].map(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let green = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (d[i + 1] > d[i + 2] + 20 && d[i + 1] > d[i] + 30) green++; else if (d[i + 2] > d[i + 1] + 20 && d[i + 2] > d[i]) blue++;
    }
    return { url: c.toDataURL(), green, blue };
  }));
  check('the five features are five different pictures', new Set(pics.slice(0, 5).map(p => p.url)).size === 5);
  check('the four layouts are four different pictures', new Set(pics.slice(5).map(p => p.url)).size === 4);
  check('every picture lights the surface the wrap made', pics.every(p => p.green > 100), pics.map(p => p.green).join(' '));
  check('nothing is on the piece until something on the card is touched', (await ghosts()) === 0 &&
    (await info()).previewOn === false && (await undoDepth()) === undo0 && (await rawLen(cid)) === tris0);
  const mat0 = await matOf();

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. the preview ===');
  await tile('motif', 'ball');
  await waitPreview();
  let i = await info();
  check('a tile ghosts the piece and draws the patch', i.ok && i.ghost && i.patch && i.patchTris > 0 && (await ghosts()) === 1, i.text);
  const g = await matOf();
  check('the piece is a ghost, and untouched', g.t && g.o < 0.5 && !g.w && (await undoDepth()) === undo0 && (await rawLen(cid)) === tris0, JSON.stringify(g));
  check('the tile, and the select behind it, say ball', (await lit('motif')) === 'ball' && (await val('sel-surftex-motif')) === 'ball');
  check('the readout says it is a preview', /Wrap preview:.*press WRAP to bake it/.test(i.readout || ''), i.readout);
  const before = i.tiles;
  await page.fill('#inp-surftex-size', '3'); await page.fill('#inp-surftex-spacing', '3.5');
  await waitText(/Wrapped/);
  await page.waitForFunction(b => window.nsoSurftexLive.info().tiles !== b, before, { timeout: 15000 });
  i = await info();
  check('a number moves the preview (more, smaller balls)', i.ok && i.tiles > before, before + ' -> ' + i.tiles + ' features');
  await page.selectOption('#sel-surftex-preset', 'ribbed-roller');
  await page.waitForFunction(() => /^spike$/.test(document.getElementById('sel-surftex-motif').value), null, { timeout: 5000 });
  await waitPreview();
  check('a skin lights its feature tile (Ribbed Roller is a pyramid) and the preview follows', (await lit('motif')) === 'spike' && (await info()).ok);
  await tile('layout', 'hex');
  const t1 = (await info()).tiles;
  await page.waitForFunction(() => document.getElementById('sel-surftex-layout').value === 'hex', null, { timeout: 5000 });
  check('a layout tile sets the layout and lights', (await lit('layout')) === 'hex' && (await val('sel-surftex-layout')) === 'hex');
  await page.waitForFunction(() => window.nsoSurftexLive.info().ok, null, { timeout: 15000 });
  await page.selectOption('#sel-surftex-face', { index: 1 });
  await page.waitForFunction(() => /flat|Flat|face/i.test(document.getElementById('surftex-readout').textContent) && window.nsoSurftexLive.info().ok, null, { timeout: 15000 });
  const flat = await info();
  check('another face in the Face list draws that face\'s preview', flat.ok && flat.patchTris > 0 && t1 !== undefined, flat.text);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the bake ===');
  await page.selectOption('#sel-surftex-face', { index: 0 });
  await tile('motif', 'spike');
  await page.fill('#inp-surftex-size', '3'); await page.fill('#inp-surftex-spacing', '4'); await page.fill('#inp-surftex-row', '4'); await page.fill('#inp-surftex-height', '2');
  await page.waitForFunction(() => { const i = window.nsoSurftexLive.info(); return i.ok && /\+2\.00 mm/.test(i.text || ''); }, null, { timeout: 15000 });
  const want = await page.evaluate(() => { const i = window.nsoSurftexLive.info(); window.__ghost = Array.from(i.soup); return i.tiles; });
  await page.click('#btn-surftex-go');
  await page.waitForFunction(() => /^Wrap done|Wrap refused/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  check('WRAP installs the soup that was on screen, bit for bit', await bits(cid), want + ' features');
  check('ONE Undo step', (await undoDepth()) === undo0 + 1, undo0 + ' -> ' + (await undoDepth()));
  check('the ghost is gone, the material back, and the preview is off until something is touched',
    (await ghosts()) === 0 && JSON.stringify(await matOf()) === JSON.stringify(mat0) && (await info()).previewOn === false && !(await info()).patch, JSON.stringify(await matOf()));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(400);
  check('Undo gives the cylinder back', (await rawLen(cid)) === tris0);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. put away ===');
  await page.waitForFunction(() => document.querySelectorAll('#sel-surftex-face option').length > 1, null, { timeout: 15000 });
  await tile('motif', 'dent');
  await waitPreview();
  check('a dent previews (a groove into the face: it goes down, not up)', /down to -/.test((await info()).text || ''), (await info()).text);
  await shut();
  await page.waitForTimeout(300);
  check('Close drops the ghost and the preview; nothing was baked', (await ghosts()) === 0 && JSON.stringify(await matOf()) === JSON.stringify(mat0) &&
    (await undoDepth()) === undo0 && (await rawLen(cid)) === tris0 && (await info()).previewOn === false);

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. a refusal ===');
  await openCard();
  await tile('motif', 'ball');
  await page.fill('#inp-surftex-size', '40'); await page.fill('#inp-surftex-sizev', ''); await page.fill('#inp-surftex-spacing', '60'); await page.fill('#inp-surftex-row', '60');
  await page.waitForFunction(() => /no feature fits/.test(document.getElementById('surftex-readout').textContent), null, { timeout: 15000 });
  i = await info();
  check('the readout says why, nothing is drawn', !i.ok && !i.patch && /no feature fits/.test(i.readout || ''), i.readout);
  await page.click('#btn-surftex-go');
  await page.waitForFunction(() => /Wrap refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  check('WRAP refuses in the same words and the piece is untouched', /no feature fits/.test(await page.evaluate(() => document.getElementById('status').textContent)) &&
    (await rawLen(cid)) === tris0 && (await undoDepth()) === undo0);
  await shut();

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. a click on the piece ===');
  const bid = await loadSTL(page, fx('box-20mm.stl'));
  await page.click(`.model-item[data-edit-id="${bid}"]`);
  await openCard();
  await page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    state.controls.target.copy(c); state.camera.position.set(c.x + 8, c.y + 60, c.z + 45); state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
  }, bid);
  await frames(2);
  const s = await page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh);
    const v = b.getCenter(new THREE.Vector3()); v.y = b.max.y; state.camera.updateMatrixWorld(true); v.project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }, bid);
  // start from a side face so the click has something to change
  const startFace = await page.evaluate(() => {
    const B = state.surftex, sel = document.getElementById('sel-surftex-face');
    const M = B.reg.M, o = [];
    B.reg.list.forEach(r => { let z = 0, n = 0; for (const t of r.tris) for (let k = 0; k < 3; k++) { z += M.P[3 * M.vid[3 * t + k] + 2]; n++; } o.push({ id: r.id, z: z / n }); });
    const side = o.slice().sort((a, b) => a.z - b.z)[2];
    sel.value = String(side.id); sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { side: side.id, top: o.slice().sort((a, b) => b.z - a.z)[0].id };
  });
  await page.mouse.move(s.x - 3, s.y - 3); await page.mouse.move(s.x, s.y); await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(400);
  const got = await val('sel-surftex-face');
  check('a click on the top of the piece picks that face in the Face list', got === String(startFace.top) && got !== String(startFace.side), 'was ' + startFace.side + ', top is ' + startFace.top + ', now ' + got);
  check('and the click baked nothing', (await undoDepth()) === undo0);
  await shut();

  const errs = logs.filter(l => /pageerror|^error/i.test(String(l.type || l)));
  check('no page errors', errs.length === 0, errs.slice(0, 3).map(e => JSON.stringify(e).slice(0, 200)).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

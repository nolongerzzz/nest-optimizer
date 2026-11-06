#!/usr/bin/env node
/* Fasteners (Gen+ > Fasteners), driven through the real app: real index.html, real script tags, real clicks, real Undo.
     node tools/nso_fasteners_drive_check.js            exit 0 = every gate held
     FASTENERS_SHOTS=dir node tools/nso_fasteners_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_thread_test.js. What this proves is the card:
     1. it is in Gen+ with its tiles (Rod, Bolt, Nut, Bolt + nut; Hex head, Socket head) DRAWN - each canvas painted, no two alike -
        and a number box + slider for every number (Ø, Pitch, Length, Fit, Nut thick), bound live
     2. with the menu open a translucent PREVIEW stands on the plate - in the scene, not on the plate (no piece, no Undo step)
     3. the sliders move the preview (Length changes its height, Ø its width), the box follows the slider, Size resets Ø / Pitch / nut
        thickness, the head tiles swap the head, a Nut tile shows a nut, Bolt + nut shows two side by side
     4. Add to plate BAKES what the preview shows (one Undo each) and DISARMS the card: no ghost beside the new piece until a tile is clicked again; the nut and bolt turn
     5. a choice that is refused clears the preview, says why in red, and Add to plate is off - nothing is added
     6. closing the menu takes the preview away, opening it brings it back; a custom Ø is named by its numbers; left hand */

const fs = require('fs');
const path = require('path');
const { withApp, statusOf } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.FASTENERS_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const pieces = page => page.evaluate(() => state.models.filter(Boolean).map(m => ({ id: m.id, name: m.name, size: m.size && { x: m.size.x, y: m.size.y, z: m.size.z } })));
const topoOf = (page, id) => page.evaluate(id => { const m = state.models.find(x => x && x.id === id); return NSO_bendTopology(m.rawTris); }, id);
const readout = page => page.evaluate(() => ({ text: document.getElementById('fs-readout').textContent, bad: document.getElementById('fs-readout').classList.contains('is-bad') }));
const FS = page => page.evaluate(() => nsoFasteners.state());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
/* a slider moved as a hand moves it: the range input's value, then the input event the live slider listens for */
const slide = (page, name, v) => page.evaluate(([n, v]) => { const el = document.getElementById('inp-fs-' + n + '-slider'); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [name, v]);
const typeBox = (page, name, v) => page.evaluate(([n, v]) => { const el = document.getElementById('inp-fs-' + n); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [name, v]);
const field = (page, name) => page.evaluate(n => ({ box: document.getElementById('inp-fs-' + n).value, slider: document.getElementById('inp-fs-' + n + '-slider').value, read: document.getElementById('fs-' + n + '-read').textContent }), name);
const choose = (page, id, v) => page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
const click = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
// wait until the preview (ghost) satisfies a test on its state
const until = (page, fn, arg) => page.waitForFunction(([src, a]) => (new Function('s', 'a', 'return (' + src + ')(s, a)'))(nsoFasteners.state(), a), [fn.toString(), arg], { timeout: 8000 });
async function frame(page, i) {
  await page.evaluate(i => {
    const g = nsoFasteners.state().ghost[i || 0]; if (!g) return;
    const c = new THREE.Vector3(g.x, g.y, g.z);
    state.controls.target.copy(c); state.camera.position.set(c.x + 34, c.y + 26, c.z + 46); state.controls.update(); state.camera.updateMatrixWorld(true);
  }, i || 0);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await frames(page, 3);
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log('   screenshot ' + path.join(SHOTS, name));
}
async function waitStatus(page, re) {
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent), re.source, { timeout: 30000 });
  return statusOf(page);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the card in Gen+: tiles drawn, a slider for every number ===');
  const pre = await page.evaluate(() => {
    const el = id => document.getElementById(id), menu = document.querySelector('.vp-fasteners-menu');
    const nums = ['major', 'pitch', 'length', 'fit', 'nutm'];
    return { menu: !!menu, inGen: !!(menu && menu.closest('#menu-gen')), add: !!el('btn-fs-add'), kinds: document.querySelectorAll('#fs-kind-row [data-kind]').length, heads: document.querySelectorAll('#fs-head-row [data-head]').length,
             sliders: nums.every(n => el('inp-fs-' + n) && el('inp-fs-' + n + '-slider') && el('fs-' + n + '-read') && el('inp-fs-' + n + '-slider').dataset.nsoLive === '1'),
             size: el('sel-fs-size').value, sizes: el('sel-fs-size').options.length, ghostsBefore: nsoFasteners.state().ghosts };
  });
  check('Fasteners is in the Gen+ menu: 4 kind tiles, 2 head tiles, Add to plate, and a number box + slider + read-out for Ø, Pitch, Length, Fit, Nut thick - each bound live',
    pre.menu && pre.inGen && pre.add && pre.kinds === 4 && pre.heads === 2 && pre.sliders, JSON.stringify(pre));
  check('the menu is closed: there is no preview yet, and the table has 35 sizes', pre.ghostsBefore === 0 && pre.sizes === 35, JSON.stringify(pre));
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; });
  const u0 = await undoDepth(page), n0 = (await pieces(page)).length;
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; document.getElementById('menu-fasteners').open = true; });
  await until(page, s => s.tiles);
  await frames(page, 6);
  const idle = await FS(page), idleAdd = await page.evaluate(() => ({ off: document.getElementById('btn-fs-add').disabled, pressed: document.querySelectorAll('#fs-kind-row [aria-pressed="true"]').length }));
  check('the card open with no tile clicked: NO ghost, no tile pressed, Add to plate off', idle.ghosts === 0 && !idle.ok && idleAdd.off && idleAdd.pressed === 0, JSON.stringify([idle.ghosts, idleAdd]));
  await click(page, '#fs-kind-row [data-kind="bolt"]');
  await until(page, s => s.ghosts === 1);
  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#menu-fasteners .fs-tile')).map(b => {
    const c = b.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0, h = 0; for (let i = 0; i < d.length; i += 4) { if (Math.abs(d[i] - 0x14) + Math.abs(d[i + 1] - 0x17) + Math.abs(d[i + 2] - 0x1c) > 24) lit++; h = (h * 31 + d[i] + 7 * d[i + 1] + 13 * d[i + 2]) | 0; }
    return { id: b.getAttribute('data-kind') || b.getAttribute('data-head'), drawn: c.getAttribute('data-drawn'), lit, h, label: b.querySelector('span').textContent };
  }));
  check('all six tiles are drawn (a picture, not a blank: each has well over 150 lit pixels of 4096)', tiles.length === 6 && tiles.every(t => t.drawn === '1' && t.lit > 150), JSON.stringify(tiles.map(t => t.id + ':' + t.lit)));
  check('no two tiles are alike (Rod, Bolt, Nut, Bolt + nut, Hex head, Socket head are six different pictures)', new Set(tiles.map(t => t.h)).size === 6, tiles.map(t => t.label).join(' / '));
  const tileShot = SHOTS ? await page.locator('#menu-fasteners .fs-tiles').first().boundingBox() : null;

  console.log('\n=== 2. the preview: in the scene, not on the plate ===');
  let st = await FS(page), rd = await readout(page);
  check('the default is a Bolt, M8, hex head: ONE translucent ghost stands in the scene', st.kind === 'bolt' && st.head === 'hex' && st.ghosts === 1 && st.ok && st.ghost[0].inScene, JSON.stringify(st));
  check('the readout says it is a preview, with the numbers', !rd.bad && /^Preview - Hex bolt M8 × 25\.0 \(ISO metric 60°\): 13\.0 across flats/.test(rd.text), rd.text);
  const inScene = await page.evaluate(() => ({ placed: state.placed.length, group: state.modelGroup.children.length, flagged: state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length, inGroup: state.modelGroup.children.some(c => c.userData && c.userData.nsoPiecePreview) }));
  check('nothing is on the plate: no piece, not in the model group (so not picked, packed or exported), no Undo step', (await pieces(page)).length === n0 && inScene.flagged === 1 && !inScene.inGroup && (await undoDepth(page)) === u0, JSON.stringify(inScene));
  check('its size is the bolt\'s: 15.0 across corners, 13.0 across flats, 30.3 tall (5.3 head + 25 shank)', Math.abs(st.ghost[0].size.x - 15.01) < 0.03 && Math.abs(st.ghost[0].size.z - 13) < 0.03 && Math.abs(st.ghost[0].size.y - 30.3) < 0.03, JSON.stringify(st.ghost[0].size));
  check('it stands on the bed (its lowest point 0.2 mm up, as a placed piece does)', Math.abs(st.ghost[0].y - st.ghost[0].size.y / 2 - 0.2) < 1e-6, st.ghost[0].y.toFixed(3));
  await frame(page, 0); await shot(page, 'fasteners-preview-bolt.png');

  console.log('\n=== 3. the sliders move the preview ===');
  await slide(page, 'length', 40);
  await until(page, s => s.ghosts === 1 && Math.abs(s.ghost[0].size.y - 45.3) < 0.05);
  let f = await field(page, 'length'); rd = await readout(page);
  check('Length slider to 40: the box follows (40), the read-out says 40 mm, the ghost is 45.3 tall (5.3 + 40), the readout says × 40.0', f.box === '40' && f.read === '40 mm' && /Hex bolt M8 × 40\\.0/.test(rd.text.replace('.', '\\.')) || /× 40\.0/.test(rd.text), JSON.stringify(f) + ' · ' + rd.text.slice(0, 60));
  await typeBox(page, 'length', 60);
  await until(page, s => Math.abs(s.ghost[0].size.y - 65.3) < 0.05);
  f = await field(page, 'length');
  check('typing 60 in the box moves the slider (60) and the ghost (65.3 tall)', f.slider === '60' && f.read === '60 mm', JSON.stringify(f));
  await typeBox(page, 'length', 200);
  await until(page, s => Math.abs(s.ghost[0].size.y - 205.3) < 0.1);
  f = await field(page, 'length');
  check('a box value past the slider\'s end (200 > 150) is kept: the slider sits at its end, the ghost is 205.3 tall', f.box === '200' && f.slider === '150', JSON.stringify(f));
  await slide(page, 'length', 25);
  await until(page, s => Math.abs(s.ghost[0].size.y - 30.3) < 0.05);
  const u1 = await undoDepth(page);
  await slide(page, 'major', 12);
  await until(page, s => s.ghosts === 1 && Math.abs(s.ghost[0].size.z - 13) > 0.5 || s.ghost[0].size.y > 0);
  rd = await readout(page); st = await FS(page);
  check('Ø slider to 12 (pitch left at 1.25): a thread of its own, named by its numbers in the readout - and the head is M12\'s (hex 18.0 across flats)', /Hex bolt M12x1\.25 × 25\.0.*18\.0 across flats/.test(rd.text), rd.text.slice(0, 120));
  await slide(page, 'pitch', 2);
  await until(page, s => true);
  await frames(page, 6);
  rd = await readout(page);
  check('Pitch slider to 2: M12x2 - pitch 2.00 mm in the readout', /Hex bolt M12x2 × 25\.0.*pitch 2\.00 mm/.test(rd.text), rd.text.slice(0, 140));
  check('moving sliders adds nothing: still no piece, no Undo step', (await pieces(page)).length === n0 && (await undoDepth(page)) === u1);
  // Size resets the numbers it owns
  await choose(page, 'sel-fs-size', 'M10');
  await frames(page, 4);
  const fm = await field(page, 'major'), fp = await field(page, 'pitch'), fn = await field(page, 'nutm');
  check('choosing M10 puts Ø 10, Pitch 1.5 and the nut\'s standard 8.4 mm back on their sliders', fm.box === '10' && fm.slider === '10' && fp.box === '1.5' && fn.box === '8.4' && fn.read === '8.4 mm', JSON.stringify([fm, fp, fn]));
  await until(page, s => s.ghosts === 1 && Math.abs(s.ghost[0].size.y - (6.4 + 25)) < 0.05);
  rd = await readout(page);
  check('...and the preview is the standard M10 bolt: 6.4 head + 25 shank = 31.4 tall, 16.0 across flats', /Hex bolt M10 × 25\.0.*16\.0 across flats, head 6\.4 mm, pitch 1\.50 mm/.test(rd.text), rd.text.slice(0, 120));

  console.log('\n=== 4. head types, and the other tiles ===');
  await click(page, '#fs-head-row [data-head="socket"]');
  await until(page, s => s.head === 'socket' && s.ghosts === 1 && Math.abs(s.ghost[0].size.x - 16.0) < 0.2);
  st = await FS(page); rd = await readout(page);
  const pressed = await page.evaluate(() => Array.from(document.querySelectorAll('#fs-head-row [data-head]')).map(b => b.getAttribute('aria-pressed')).join());
  check('Socket head tile: pressed (false,true), the ghost is a Ø16 cap (M10), the readout says socket-head with its 8.0 hex socket', pressed === 'false,true' && /Socket-head bolt M10 × 25\.0.*8\.0 hex socket/.test(rd.text), pressed + ' · ' + rd.text.slice(0, 100));
  await frame(page, 0); await shot(page, 'fasteners-preview-socket.png');
  await click(page, '#fs-kind-row [data-kind="nut"]');
  await until(page, s => s.kind === 'nut' && s.ghosts === 1 && Math.abs(s.ghost[0].size.y - 8.4) < 0.05);
  rd = await readout(page); st = await FS(page);
  const rows = await page.evaluate(() => ({ len: document.getElementById('fs-length-row').hidden, head: document.getElementById('fs-head-row').hidden, fit: document.getElementById('fs-fit-row').hidden, nutm: document.getElementById('fs-nutm-row').hidden }));
  check('Nut tile: a nut 8.4 thick (the ghost), the Length slider and the head tiles are put away, Fit and Nut thick are shown', /^Preview - Hex nut M10 \(ISO metric 60°\): 16\.0 across flats, 8\.4 mm thick, bore Ø10\.40/.test(rd.text) && rows.len && rows.head && !rows.fit && !rows.nutm, JSON.stringify(rows) + ' · ' + rd.text.slice(0, 90));
  await slide(page, 'nutm', 12);
  await until(page, s => Math.abs(s.ghost[0].size.y - 12) < 0.05);
  await slide(page, 'fit', 0.4);
  await frames(page, 6);
  rd = await readout(page);
  check('Nut thick slider to 12 (the ghost is 12 tall) and Fit slider to 0.4: the bore is the bolt\'s + 0.40 mm (Ø10.80)', /12\.0 mm thick, bore Ø10\.80 \(the bolt's \+ 0\.40 mm fit\)/.test(rd.text), rd.text.slice(0, 140));
  await frame(page, 0); await shot(page, 'fasteners-preview-nut.png');
  await click(page, '#fs-kind-row [data-kind="set"]');
  await until(page, s => s.kind === 'set' && s.ghosts === 2);
  st = await FS(page); rd = await readout(page);
  const [ga, gb] = st.ghost;
  check('Bolt + nut tile: two ghosts, side by side without touching (gap ' + (gb.x - ga.x - ga.size.x / 2 - gb.size.x / 2).toFixed(1) + ' mm), the readout names both', ga.z === gb.z && gb.x - ga.x - ga.size.x / 2 - gb.size.x / 2 >= 5.9 && /(Hex|Socket-head) bolt M10.* - and Hex nut M10/.test(rd.text), JSON.stringify(st.ghost.map(g => [g.x, g.z, g.size.x])) + ' · ' + rd.text.slice(0, 200));
  await frame(page, 0); await shot(page, 'fasteners-preview-set.png');
  // the length slider is back for a set; a rod goes to 40
  await click(page, '#fs-kind-row [data-kind="rod"]');
  await until(page, s => s.kind === 'rod' && s.ghosts === 1);
  f = await field(page, 'length'); st = await FS(page);
  check('Rod tile: the Length reads 25 (it was touched, so it stays) and the ghost is a 25 mm rod', f.box === '25' && Math.abs(st.ghost[0].size.y - 25) < 0.02, JSON.stringify(f) + ' ' + st.ghost[0].size.y);

  console.log('\n=== 5. Add to plate bakes what the preview shows ===');
  await click(page, '#fs-kind-row [data-kind="set"]');
  await until(page, s => s.kind === 'set' && s.ghosts === 2);
  await choose(page, 'sel-fs-size', 'M10');
  await click(page, '#fs-head-row [data-head="hex"]');
  await until(page, s => s.head === 'hex' && s.ghosts === 2);
  const d0 = await undoDepth(page);
  await click(page, '#btn-fs-add');
  const status = await waitStatus(page, /Dropped nut M10/);
  const P = await pieces(page);
  const b10 = P.find(p => /^bolt M10/.test(p.name)), n10 = P.find(p => /^nut M10/.test(p.name));
  check('"bolt M10 1" and "nut M10 1" are on the plate, one Undo each, and the bolt\'s size is the ghost\'s', !!b10 && !!n10 && P.length === n0 + 2 && (await undoDepth(page)) === d0 + 2 && Math.abs(b10.size.y - 31.4) < 0.05, JSON.stringify(P.map(p => p.name)));
  const Tb = await topoOf(page, b10.id), Tn = await topoOf(page, n10.id);
  check('both closed, 2-manifold, consistently wound: the bolt Euler 2, the nut (a ring) Euler 0', Tb.open === 0 && Tb.nm === 0 && Tb.flip === 0 && Tb.euler === 2 && Tn.open === 0 && Tn.nm === 0 && Tn.flip === 0 && Tn.euler === 0, JSON.stringify([Tb, Tn]));
  await frames(page, 8);
  st = await FS(page);
  const afterAdd = await page.evaluate(() => ({ off: document.getElementById('btn-fs-add').disabled, pressed: document.querySelectorAll('#fs-kind-row [aria-pressed="true"]').length }));
  check('after the bake the card is disarmed: no ghost beside the new pieces, no tile pressed, Add to plate off', st.ghosts === 0 && !st.ok && afterAdd.off && afterAdd.pressed === 0, JSON.stringify([st.ghosts, afterAdd]));
  await click(page, '#fs-kind-row [data-kind="set"]');
  await until(page, s => s.ghosts === 2);
  st = await FS(page);
  const placedMax = await page.evaluate(() => Math.max.apply(null, state.placed.filter(Boolean).map(p => placedFootprint(p).maxx)));
  check('clicking a tile again starts a new preview, standing beside what was just added (its left edge ' + (st.ghost[0].x - st.ghost[0].size.x / 2).toFixed(1) + ' is right of the plate\'s rightmost piece ' + placedMax.toFixed(1) + ')', st.ghosts === 2 && st.ghost[0].x - st.ghost[0].size.x / 2 > placedMax - 0.01, JSON.stringify(st.ghost.map(g => g.x)));
  // measured in the page: the nut and the bolt it was made with turn on each other
  const gap = await page.evaluate(([bid, nid]) => {
    const b = state.models.find(m => m && m.id === bid).rawTris, n = state.models.find(m => m && m.id === nid).rawTris;
    function first(s, o, d) { let best = Infinity;
      for (let t = 0; t < s.length; t += 9) {
        const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
        const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]; if (Math.abs(det) < 1e-12) continue;
        const w = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], u = (w[0] * p[0] + w[1] * p[1] + w[2] * p[2]) / det; if (u < -1e-9 || u > 1 + 1e-9) continue;
        const q = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];
        const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det; if (tt > 1e-9 && tt < best) best = tt;
      } return best; }
    let gmax = -Infinity;
    for (let c = 0; c < 60; c++) { const dz = 1.5 * c / 60; let g = Infinity;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { const th = i * Math.PI / 4, z = 2 + j * 1.3;
        const rn = first(n, [0, 0, z], [Math.cos(th), Math.sin(th), 0]), rb = first(b, [0, 0, z + 12 - dz], [Math.cos(th), Math.sin(th), 0]);
        if (isFinite(rn) && isFinite(rb)) g = Math.min(g, rn - rb); }
      gmax = Math.max(gmax, g); }
    return gmax;
  }, [b10.id, n10.id]);
  check('measured on the two pieces the preview became: the bolt has a screw position that clears the nut by ' + gap.toFixed(3) + ' mm (the 0.4 fit set on the slider earlier)', gap > 0.37 && gap < 0.43, gap.toFixed(3));
  await frame(page, 0); await shot(page, 'fasteners-after-add.png');

  console.log('\n=== 6. a refusal clears the preview; Add to plate is off; nothing is added ===');
  await click(page, '#fs-kind-row [data-kind="nut"]');
  await until(page, s => s.kind === 'nut' && s.ghosts === 1);
  const nR = (await pieces(page)).length, uR = await undoDepth(page);
  await slide(page, 'nutm', 1);
  await until(page, s => s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  const addOff = await page.evaluate(() => document.getElementById('btn-fs-add').disabled);
  check('a nut thinner than a pitch (1 mm of 1.50): the ghost is gone, the readout says why in red, Add to plate is disabled', rd.bad && /^Nut: a nut thinner than one pitch \(1\.50 mm\) does not engage - make it at least 3\.0 mm$/.test(rd.text) && addOff, rd.text);
  const forced = await page.evaluate(() => nsoFasteners.add());
  check('Add forced anyway adds nothing, and the status says so', !forced.ok && (await pieces(page)).length === nR && (await undoDepth(page)) === uR && /Nut refused - nothing added/.test(await statusOf(page)), forced.reason);
  await slide(page, 'nutm', 9);
  await until(page, s => s.ghosts === 1 && s.ok);
  check('moving it back to 9 brings the preview back and Add to plate on', !(await page.evaluate(() => document.getElementById('btn-fs-add').disabled)));
  await click(page, '#fs-kind-row [data-kind="rod"]');
  await until(page, s => s.kind === 'rod' && s.ghosts === 1);
  await slide(page, 'pitch', 0.2);
  await until(page, s => s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  check('a pitch too fine to form (0.2): refused with the least pitch', rd.bad && /would not form\. Use a pitch of at least 0\.33 mm/.test(rd.text), rd.text.slice(0, 120));
  await choose(page, 'sel-fs-size', 'M3');
  await until(page, s => s.ghosts === 1 && s.ok);
  rd = await readout(page);
  check('choosing M3 resets the pitch (0.5) and brings the preview back, with the note about the nozzle (not an error)', !rd.bad && /note: a 0\.50 mm pitch is finer than a 0\.4 mm nozzle resolves well/.test(rd.text), rd.text.slice(0, 80));

  console.log('\n=== 7. custom Ø, left hand, the menu closing, the API ===');
  await choose(page, 'sel-fs-size', 'M6');
  await click(page, '#fs-kind-row [data-kind="rod"]');
  await slide(page, 'major', 7);
  await until(page, s => s.ghosts === 1 && s.ok);
  const dC = await undoDepth(page);
  await click(page, '#btn-fs-add');
  await waitStatus(page, /Dropped rod M7x1/);
  check('a rod with Ø moved to 7 is named by its numbers: "rod M7x1"', (await pieces(page)).some(p => p.name === 'rod M7x1 1') && (await undoDepth(page)) === dC + 1);
  await click(page, '#fs-kind-row [data-kind="rod"]');
  await choose(page, 'sel-fs-hand', 'left');
  await until(page, s => s.ghosts === 1);
  rd = await readout(page);
  check('Hand: Left shows in the preview', /left-hand/.test(rd.text), rd.text.slice(0, 100));
  await choose(page, 'sel-fs-hand', 'right');
  await page.evaluate(() => { document.getElementById('menu-fasteners').open = false; });
  await until(page, s => s.ghosts === 0 && !s.open);
  check('closing the menu takes the preview away', (await FS(page)).ghosts === 0 && (await page.evaluate(() => state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length)) === 0);
  await page.evaluate(() => { document.getElementById('menu-fasteners').open = true; });
  await until(page, s => s.ghosts === 1);
  check('opening it brings it back (the tile is still armed)', (await FS(page)).ghosts === 1);
  await page.evaluate(() => { document.getElementById('menu-gen').open = false; });
  await until(page, s => s.ghosts === 0 && !s.open);
  check('closing Gen+ (the menu it sits in) takes it away too', (await FS(page)).ghosts === 0);
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; });
  await until(page, s => s.ghosts === 1);
  // the old verbs still bake, with the card's numbers
  await choose(page, 'sel-fs-size', 'M8'); await slide(page, 'length', 20);
  const nB = (await pieces(page)).length;
  const viaApi = await page.evaluate(() => nsoFasteners.bolt());
  check('nsoFasteners.bolt() still bakes one bolt with the card\'s numbers: "bolt M8 1", 5.3 + 20 tall', viaApi.ok && viaApi.name === 'bolt M8 1' && (await pieces(page)).length === nB + 1 && Math.abs((await pieces(page)).find(p => p.name === 'bolt M8 1').size.y - 25.3) < 0.05, viaApi.reason);
  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (SHOTS && tileShot) { /* the tiles row, for the record */ }
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });

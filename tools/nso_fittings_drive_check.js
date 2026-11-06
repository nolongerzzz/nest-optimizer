#!/usr/bin/env node
/* Fittings, driven through the real app: real index.html, real script tags, real clicks, real Undo.
     node tools/nso_fittings_drive_check.js            exit 0 = every gate held
     FITTINGS_SHOTS=dir node tools/nso_fittings_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_fittings_test.js, nso_fittings_thread_test.js and nso_thread_test.js. What this proves is the card:
     1. it is in Gen+ with ten kind tiles and three + three end tiles DRAWN (each canvas painted, no two alike - the Cap's a generic cap,
        needing no tube), a number box + slider for every number, bound live
     2. with no tube selected the Cap / Tube end previews are a GENERIC Ø20 x 2 tube's, labelled so, and Add to plate is off
     3. with a tube selected the preview is read off ITS end; Fit and Deep move it; Add bakes a cap of the tube's own wall, one Undo, the tube untouched
     4. the threaded Tube end (male and female) and the threaded fittings (nipple, coupler, adapter, plug, screw cap) preview and bake
     5. the splitters preview on the kernel (async, a newer change supersedes an older build), refusals are said at once and clear the preview,
        Branch Ø follows the trunk until moved, the end tiles add threaded spigots / sockets, Add bakes the very thing shown
     6. the preview is in the scene and not on the plate; closing the menu takes it away; only one card's ghost at a time */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
// as a click on the piece does: the plate's selection AND the piece being edited (the harness's selectModel sets only the latter)
const selectModel = (page, id) => page.evaluate(id => { const i = state.placed.findIndex(p => p && p.sourceId === id); state.editId = id; if (i >= 0) selectPlaced(i); window.dispatchEvent(new Event('pointerup')); }, id);
const selectNone = page => page.evaluate(() => { state.editId = null; state.selectedIndex = -1; window.dispatchEvent(new Event('pointerup')); });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.FITTINGS_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-fittings-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);

const pieces = page => page.evaluate(() => state.models.filter(Boolean).map(m => ({ id: m.id, name: m.name, size: m.size && { x: m.size.x, y: m.size.y, z: m.size.z } })));
const topoOf = (page, id) => page.evaluate(id => { const m = state.models.find(x => x && x.id === id); return NSO_bendTopology(m.rawTris); }, id);
const readout = page => page.evaluate(() => ({ text: document.getElementById('fx-readout').textContent, bad: document.getElementById('fx-readout').classList.contains('is-bad') }));
const FX = page => page.evaluate(() => nsoFittings.state());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const selName = page => page.evaluate(() => { const m = getActiveModel(); return m ? m.name : null; });
const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const slide = (page, name, v) => page.evaluate(([n, v]) => { const el = document.getElementById('inp-fx-' + n + '-slider'); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [name, v]);
const typeBox = (page, name, v) => page.evaluate(([n, v]) => { const el = document.getElementById('inp-fx-' + n); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [name, v]);
const field = (page, name) => page.evaluate(n => ({ box: document.getElementById('inp-fx-' + n).value, slider: document.getElementById('inp-fx-' + n + '-slider').value, read: document.getElementById('fx-' + n + '-read').textContent }), name);
const choose = (page, id, v) => page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
const click = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const shown = (page, id) => page.evaluate(id => { const el = document.getElementById(id); return !!el && !el.hidden; }, id);
const addOff = page => page.evaluate(() => document.getElementById('btn-fx-add').disabled);
// wait until the card's state satisfies a test (the splitter is built on the kernel, so previews land a little later)
const until = (page, fn, arg) => page.waitForFunction(([src, a]) => (new Function('s', 'a', 'return (' + src + ')(s, a)'))(nsoFittings.state(), a), [fn.toString(), arg], { timeout: 20000 }).catch(async e => { console.log('   TIMEOUT waiting for ' + fn.toString() + ' - readout: ' + JSON.stringify(await readout(page)) + ' state ' + JSON.stringify(await FX(page)).slice(0, 300)); throw e; });
const settled = (page, n) => until(page, s => !s.busy && s.ghosts === (typeof a === 'number' ? a : 1) || (!s.busy && s.ghosts === 1), n);
async function frame(page) {
  await page.evaluate(() => {
    const g = nsoFittings.state().ghost[0]; if (!g) return;
    const c = new THREE.Vector3(g.x, g.y, g.z);
    state.controls.target.copy(c); state.camera.position.set(c.x + 50, c.y + 40, c.z + 70); state.controls.update(); state.camera.updateMatrixWorld(true);
  });
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
const readyKind = async (page, kind) => { await click(page, '#fx-kind-row [data-kind="' + kind + '"]'); await until(page, (s, k) => s.kind === k && !s.busy, kind); };

withApp(async (page, logs) => {
  console.log('\n=== 1. the card in Gen+: tiles drawn, a slider for every number ===');
  const pre = await page.evaluate(() => {
    const el = id => document.getElementById(id), menu = document.querySelector('.vp-fittings-menu');
    const nums = ['gap', 'depth', 'od', 'wall', 'bod', 'angle', 'trunk', 'branch', 'tlen', 'tfit'];
    return { menu: !!menu, inGen: !!(menu && menu.closest('#menu-gen')), add: !!el('btn-fx-add'), kinds: document.querySelectorAll('#fx-kind-row [data-kind]').length,
             tends: document.querySelectorAll('#fx-trunkend-row [data-end]').length, bends: document.querySelectorAll('#fx-branchend-row [data-end]').length,
             sliders: nums.every(n => el('inp-fx-' + n) && el('inp-fx-' + n + '-slider') && el('fx-' + n + '-read') && el('inp-fx-' + n + '-slider').dataset.nsoLive === '1'),
             ghostsBefore: nsoFittings.state().ghosts, tsize: el('sel-fx-tsize').value };
  });
  check('Fittings is in Gen+: 10 kind tiles, 3 + 3 end tiles, Add to plate, and a box + slider + read-out for Fit, Deep, Ø, Wall, Branch Ø, Angle, Trunk, Branch, T length, T fit - each bound live',
    pre.menu && pre.inGen && pre.add && pre.kinds === 10 && pre.tends === 3 && pre.bends === 3 && pre.sliders && pre.tsize === 'G1/2', JSON.stringify(pre));
  check('the menu is closed: no preview yet', pre.ghostsBefore === 0);
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; });
  const u0 = await undoDepth(page), n0 = (await pieces(page)).length;
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; document.getElementById('menu-fittings').open = true; });
  await until(page, s => s.ghosts === 1 && s.tiles);
  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#menu-fittings .fs-tile')).map(b => {
    const c = b.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0, h = 0; for (let i = 0; i < d.length; i += 4) { if (Math.abs(d[i] - 0x14) + Math.abs(d[i + 1] - 0x17) + Math.abs(d[i + 2] - 0x1c) > 24) lit++; h = (h * 31 + d[i] + 7 * d[i + 1] + 13 * d[i + 2]) | 0; }
    return { id: (b.getAttribute('data-kind') || 'end-' + b.getAttribute('data-end')) + (b.closest('#fx-branchend-row') ? '-b' : ''), drawn: c.getAttribute('data-drawn'), lit, h };
  }));
  check('all 16 tiles are drawn (a picture, not a blank: well over 100 lit pixels of 4096 each)', tiles.length === 16 && tiles.every(t => t.drawn === '1' && t.lit > 100), JSON.stringify(tiles.map(t => t.id + ':' + t.lit)));
  const kindTiles = tiles.filter(t => !/^end-/.test(t.id));
  check('the ten kinds are ten different pictures (Cap, Tube end male / female, 2- / 3-way, Nipple, Coupler, Adapter, Plug, Screw cap)', new Set(kindTiles.map(t => t.h)).size === 10);
  check('the three end types (plain, male, female) are three different pictures', new Set(tiles.filter(t => /^end-/.test(t.id) && !/-b$/.test(t.id)).map(t => t.h)).size === 3);

  console.log('\n=== 2. no tube selected: a GENERIC Cap preview, labelled, Add to plate off ===');
  let st = await FX(page), rd = await readout(page);
  check('the default is the Cap: one ghost, a generic one - said in the readout, and Add to plate is off', st.kind === 'cap' && st.ghosts === 1 && st.generic && !st.ok && /^Preview for a generic Ø20 × 2 tube \(select a tube to size it\) - Cap for a Ø20\.00 tube: bore Ø20\.50/.test(rd.text) && (await addOff(page)), rd.text.slice(0, 120));
  const sc = await page.evaluate(() => ({ placed: state.placed.length, group: state.modelGroup.children.some(c => c.userData && c.userData.nsoPiecePreview), flagged: state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length }));
  check('the ghost is in the scene, not on the plate: no piece, not in the model group, no Undo step', sc.flagged === 1 && !sc.group && (await pieces(page)).length === n0 && (await undoDepth(page)) === u0, JSON.stringify(sc));
  const nR = (await pieces(page)).length;
  const forced = await page.evaluate(() => nsoFittings.add());
  rd = await readout(page);
  check('Add forced with no tube: said in words, in red, nothing added', !forced.ok && rd.bad && /^Select a tube: the cap is made for its end\.$/.test(rd.text) && (await pieces(page)).length === nR && /Cap: select the tube it fits over first/.test(await statusOf(page)), rd.text);
  await slide(page, 'gap', 0.5);
  await until(page, s => s.ghosts === 1);
  await frames(page, 4);
  rd = await readout(page);
  check('even generic, the sliders work: Fit 0.5 -> bore Ø21.00 in the readout', /bore Ø21\.00 \(0\.50 mm clear all round\)/.test(rd.text), rd.text.slice(0, 160));
  await slide(page, 'gap', 0.25);

  console.log('\n=== 3. Cap: read off the selected tube (Ø20, wall 1.6, 40 tall) ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', stockTube(10, 1.6, 40)));
  await selectModel(page, tubeId);
  await until(page, s => s.ghosts === 1 && !s.generic && s.ok);
  const tubeBefore = await page.evaluate(id => Array.from(state.models.find(m => m && m.id === id).rawTris).join(','), tubeId);
  rd = await readout(page); st = await FX(page);
  check('the preview is now the tube\'s own: "Preview - Cap for a Ø20.00 tube: ... wall 1.60 and closed end 1.60 mm, 15.0 mm of tube goes in", Add to plate on', /^Preview - Cap for a Ø20\.00 tube: bore Ø20\.50 \(0\.25 mm clear all round\), outside Ø23\.70, wall 1\.60 and closed end 1\.60 mm, 15\.0 mm of tube goes in - 16\.6 mm tall/.test(rd.text) && !(await addOff(page)), rd.text.slice(0, 160));
  check('the ghost is the cup: Ø23.7 across, 16.6 tall; Deep shows its automatic 15', Math.abs(st.ghost[0].size.x - 23.7) < 0.03 && Math.abs(st.ghost[0].size.y - 16.6) < 0.02 && (await field(page, 'depth')).box === '15', JSON.stringify(st.ghost[0].size));
  await slide(page, 'depth', 20);
  await until(page, s => s.ghosts === 1 && Math.abs(s.ghost[0].size.y - 21.6) < 0.03);
  await slide(page, 'gap', 0.4);
  await frames(page, 6);
  rd = await readout(page);
  check('Deep slider to 20 and Fit to 0.4: 21.6 tall, bore Ø20.80 - and the Deep stays where it was put', /bore Ø20\.80 \(0\.40 mm clear all round\).*20\.0 mm of tube goes in - 21\.6 mm tall/.test(rd.text), rd.text.slice(0, 160));
  await frame(page); await shot(page, 'fittings-cap-preview.png');
  await slide(page, 'gap', 0.25); await slide(page, 'depth', 15);
  await until(page, s => s.ghosts === 1 && Math.abs(s.ghost[0].size.y - 16.6) < 0.03);
  const d0 = await undoDepth(page);
  await click(page, '#btn-fx-add');
  let status = await waitStatus(page, /Dropped cap 1|Cap refused/);
  console.log('   status: ' + status);
  let P = await pieces(page);
  const cap = P.find(p => p.name === 'cap 1');
  check('Add to plate: a piece "cap 1", selected, beside the tube, one Undo step', !!cap && (await selName(page)) === 'cap 1' && (await undoDepth(page)) === d0 + 1 && /, beside tube\.$/.test(status), status);
  check('the status names the cap\'s numbers (bore Ø20.50, wall 1.60, 15 mm in), and it is the size the preview showed', /Dropped cap 1 - Cap for a Ø20\.00 tube: bore Ø20\.50 \(0\.25 mm clear all round\), outside Ø23\.70, wall 1\.60 and closed end 1\.60 mm, 15\.0 mm of tube goes in - 16\.6 mm tall, closed end down, beside tube/.test(status) && Math.abs(cap.size.y - 16.6) < 0.02 && Math.abs(cap.size.x - 23.7) < 0.03);
  const Tc = await topoOf(page, cap.id);
  check('closed, 2-manifold, consistently wound, a cup (Euler 2); the tube is untouched, bit for bit', Tc.open === 0 && Tc.nm === 0 && Tc.flip === 0 && Tc.degen === 0 && Tc.euler === 2 && (await page.evaluate(id => Array.from(state.models.find(m => m && m.id === id).rawTris).join(','), tubeId)) === tubeBefore, JSON.stringify(Tc));
  await until(page, s => s.ghosts === 1);
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  check('one Undo takes the cap off; the tube is all that is left', (await pieces(page)).length === n0 + 1 && !(await pieces(page)).some(p => p.name === 'cap 1'));
  await selectModel(page, tubeId);
  await choose(page, 'sel-fx-end', 'bottom');
  await until(page, s => s.ghosts === 1 && s.ok);
  rd = await readout(page);
  check('End: Bottom reads the tube\'s other end - the same cup', /^Preview - Cap for a Ø20\.00 tube/.test(rd.text), rd.text.slice(0, 60));
  await choose(page, 'sel-fx-end', 'top');
  const boxId = await loadSTL(page, writeSTL('box.stl', NSO_Stock.boxSoup(30, 20, 10)));
  await selectModel(page, boxId);
  await until(page, s => !s.ok && s.ghosts === 0);
  rd = await readout(page);
  check('a closed box selected: the preview is gone, the reader\'s words with the cap\'s tail in red, Add to plate off', rd.bad && /that end is closed.*A cap fits the open, round end of a tube\.$/.test(rd.text) && (await addOff(page)), rd.text.slice(0, 140));
  await selectModel(page, tubeId);
  await until(page, s => s.ghosts === 1 && s.ok);

  console.log('\n=== 4. threaded Tube end, and the threaded fittings ===');
  await readyKind(page, 'tubemale');
  await until(page, s => s.ghosts === 1 && s.ok);
  rd = await readout(page); st = await FX(page);
  const rows4 = { tsize: await shown(page, 'fx-row-threads'), tlen: await shown(page, 'fx-row-tlen'), tfit: await shown(page, 'fx-row-tfit'), od: await shown(page, 'fx-row-od'), gap: await shown(page, 'fx-row-gap') };
  check('Tube end: male: a sleeve for the Ø20 tube with a male G1/2 spigot; Thread and T length are shown, T fit (a female thing) and the splitter\'s rows are put away',
    /^Preview - Threaded end for a Ø20\.00 tube: a 15\.0 mm sleeve \(bore Ø20\.50, 0\.25 mm clear all round.*male G1\/2 thread/.test(rd.text) && rows4.tsize && rows4.tlen && !rows4.tfit && !rows4.od && rows4.gap, JSON.stringify(rows4) + ' ' + rd.text.slice(0, 80));
  check('its T length starts at the thread\'s own six pitches (11)', (await field(page, 'tlen')).box === '11');
  await frame(page); await shot(page, 'fittings-tubeend-preview.png');
  await choose(page, 'sel-fx-tsize', 'G3/4');
  await until(page, s => s.ghosts === 1);
  await frames(page, 4);
  check('Thread G3/4 changes the preview, and T length follows (a coarser pitch is the same 11 here; the box is still automatic)', /male G3\/4 thread/.test((await readout(page)).text) && !(await FX(page)).touched.tlen);
  await choose(page, 'sel-fx-tsize', 'G1/2');
  await slide(page, 'tlen', 14);
  await until(page, s => s.ghosts === 1 && s.touched.tlen);
  await frames(page, 4);
  rd = await readout(page); const hgt = (await FX(page)).ghost[0].size.y;
  check('T length slider to 14: the thread is 14 mm (the ghost is 3 mm taller: 15 + 4 + 14 = 33... the readout says 35.0 mm tall)', /35\.0 mm tall|35 mm tall/.test(rd.text) || hgt > 34, rd.text.slice(0, 20) + ' / ' + hgt.toFixed(2));
  d0 === undefined;
  const dT = await undoDepth(page);
  await click(page, '#btn-fx-add');
  status = await waitStatus(page, /Dropped tube end male G1\/2 1|Tube end \(male\) refused/);
  P = await pieces(page);
  const te = P.find(p => /^tube end male G1\/2/.test(p.name)), Tt = te && await topoOf(page, te.id);
  check('Add: "tube end male G1/2 1", selected, one Undo, closed, a ring (Euler 0), the tube untouched', !!te && (await selName(page)) === te.name && (await undoDepth(page)) === dT + 1 && Tt.open === 0 && Tt.nm === 0 && Tt.flip === 0 && Tt.euler === 0 &&
    (await page.evaluate(id => Array.from(state.models.find(m => m && m.id === id).rawTris).join(','), tubeId)) === tubeBefore, status.slice(0, 120));
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  await selectModel(page, tubeId);
  await slide(page, 'tlen', 11);
  await readyKind(page, 'tubefemale');
  await until(page, s => s.ghosts === 1 && s.ok);
  rd = await readout(page);
  check('Tube end: female: its socket thread, and T fit appears', /female G1\/2 thread/.test(rd.text) && (await shown(page, 'fx-row-tfit')), rd.text.slice(0, 100));

  await selectNone(page);
  await readyKind(page, 'nipple');
  await until(page, s => s.ghosts === 1 && s.ok);
  await choose(page, 'sel-fx-tsize', 'G3/4');
  await until(page, s => s.ghosts === 1);
  await frames(page, 4);
  rd = await readout(page);
  check('Nipple G3/4: a ring, male at both ends - the preview with nothing selected needs no tube', /^Preview - Nipple: male G3\/4 at both ends/.test(rd.text) && !(await addOff(page)), rd.text.slice(0, 80));
  await frame(page); await shot(page, 'fittings-nipple-preview.png');
  const dN = await undoDepth(page);
  await click(page, '#btn-fx-add');
  status = await waitStatus(page, /Dropped nipple G3\/4 1|Nipple refused/);
  const nip = (await pieces(page)).find(p => /^nipple G3\/4/.test(p.name)), Tn = nip && await topoOf(page, nip.id);
  check('Add: "nipple G3/4 1" - a ring (Euler 0), one Undo', !!nip && Tn.open === 0 && Tn.nm === 0 && Tn.euler === 0 && (await undoDepth(page)) === dN + 1);
  await readyKind(page, 'coupler'); await until(page, s => s.ghosts === 1 && s.ok);
  check('Coupler: female at both ends', /^Preview - Coupler: female G3\/4 at both ends/.test((await readout(page)).text));
  await readyKind(page, 'adapter'); await choose(page, 'sel-fx-tsize2', 'G1/2');
  await until(page, s => s.ghosts === 1 && s.ok); await frames(page, 4);
  rd = await readout(page);
  check('Adapter with Thread 2 G1/2: male G3/4 below, female G1/2 above (the Thread 2 select is shown)', /^Preview - Adapter: male G3\/4 below, female G1\/2 above/.test(rd.text) && (await shown(page, 'fx-row-tsize2')), rd.text.slice(0, 90));
  await choose(page, 'sel-fx-tsize2', '');
  await readyKind(page, 'plug'); await until(page, s => s.ghosts === 1 && s.ok);
  check('Plug: solid', /^Preview - Plug: male G3\/4, solid/.test((await readout(page)).text));
  await readyKind(page, 'screwcap'); await until(page, s => s.ghosts === 1 && s.ok);
  check('Screw cap: female, closed end down', /^Preview - Cap: female G3\/4, closed end down/.test((await readout(page)).text));
  await slide(page, 'tlen', 2);
  await until(page, s => s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  check('T length 2 mm: refused in words, in red; the preview is gone and Add is off', rd.bad && /^Screw cap: a thread length of 2\.0 mm is under two pitches/.test(rd.text) && (await addOff(page)), rd.text.slice(0, 100));
  await slide(page, 'tlen', 11); await choose(page, 'sel-fx-tsize', 'G1/2');

  console.log('\n=== 5. the splitters: built on the kernel, previewed live ===');
  await selectModel(page, tubeId);
  await readyKind(page, 'split2');
  await until(page, s => s.kind === 'split2' && s.ghosts === 1 && s.ok && !s.busy);
  rd = await readout(page); st = await FX(page);
  const bod0 = await field(page, 'bod');
  check('2-way: the preview is the default Y - Ø20 trunk into 2 x Ø15 at 35° - and Branch Ø shows its automatic ¾ (15)', /^Preview - 2-way splitter: Ø20\.00 trunk \(bore Ø16\.00\) into 2 × Ø15\.00 branches \(bore Ø11\.00\) at 35°, wall 2\.00 throughout/.test(rd.text) && bod0.box === '15', rd.text.slice(0, 120));
  check('the Angle read-out is in degrees, the others in mm', (await field(page, 'angle')).read === '35°' && (await field(page, 'trunk')).read === '25 mm', JSON.stringify([await field(page, 'angle'), await field(page, 'trunk')]));
  check('the cap\'s rows are put away and the splitter\'s shown; the end tiles are shown', !(await shown(page, 'fx-row-gap')) && (await shown(page, 'fx-row-od')) && (await shown(page, 'fx-ends-row')) && !(await shown(page, 'fx-row-threads')));
  check('its size: 46.7 across the branches (x), Ø20 the other way (z), 53.9 tall (y)', Math.abs(st.ghost[0].size.x - 46.7) < 0.2 && Math.abs(st.ghost[0].size.z - 20) < 0.1 && Math.abs(st.ghost[0].size.y - 53.9) < 0.2, JSON.stringify(st.ghost[0].size));
  await frame(page); await shot(page, 'fittings-split2-preview.png');
  await slide(page, 'od', 24); await slide(page, 'wall', 1.6);
  await until(page, s => !s.busy && s.ghosts === 1 && s.ok);
  await page.waitForFunction(() => /Ø24\.00 trunk \(bore Ø20\.80\)/.test(document.getElementById('fx-readout').textContent), null, { timeout: 15000 });
  const bod1 = await field(page, 'bod'); rd = await readout(page);
  check('Ø slider to 24, Wall 1.6: Branch Ø FOLLOWS (¾ of 24 = 18) because it was not moved - the readout says Ø24 trunk, 2 x Ø18', bod1.box === '18' && /into 2 × Ø18\.00 branches/.test(rd.text), JSON.stringify(bod1));
  // a burst of changes: only the last is shown
  await slide(page, 'angle', 40); await slide(page, 'angle', 45); await slide(page, 'angle', 50);
  await page.waitForFunction(() => /at 50°/.test(document.getElementById('fx-readout').textContent), null, { timeout: 20000 });
  await until(page, s => !s.busy && s.ghosts === 1);
  check('a burst of angle changes (40, 45, 50): a newer change supersedes an older build - the preview and the readout are the last (50°), and nothing was added', /at 50°/.test((await readout(page)).text) && (await pieces(page)).length === (await pieces(page)).length);
  await typeBox(page, 'angle', 5);                           // under the slider's own 10° end: the box takes it, and the engine says so
  await until(page, s => s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  check('an angle of 5°: refused AT ONCE in words (no kernel), in red - the preview is gone, Add to plate off', rd.bad && /^2-way: a branch angle of 5\.0° is outside 10° to 80°/.test(rd.text) && (await addOff(page)), rd.text.slice(0, 100));
  const nS = (await pieces(page)).length, uS = await undoDepth(page);
  const forced2 = await page.evaluate(() => nsoFittings.add());
  check('Add forced anyway adds nothing, and the status says so', !forced2.ok && (await pieces(page)).length === nS && (await undoDepth(page)) === uS && /2-way splitter refused - nothing added/.test(await statusOf(page)));
  await typeBox(page, 'angle', 35);
  await readyKind(page, 'split3');
  await slide(page, 'angle', 12); await slide(page, 'branch', 20);
  await until(page, s => s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  check('3 outlets that would run together: the mm to lengthen the branches to is named', rd.bad && /^3-way: the 3 outlets would run into each other - at 12\.0° and 20\.0 mm long.*Make the branches at least \d+\.\d mm long/.test(rd.text), rd.text.slice(0, 120));
  await slide(page, 'angle', 35); await slide(page, 'branch', 30);
  await until(page, s => s.ghosts === 1 && s.ok && !s.busy);
  await readyKind(page, 'split2');

  console.log('\n=== 5b. threaded ends on the splitter, from the end tiles ===');
  await slide(page, 'od', 20); await slide(page, 'wall', 2);
  await until(page, s => s.ghosts === 1 && s.ok && !s.busy);
  await choose(page, 'sel-fx-tsize', 'G3/4');
  await click(page, '#fx-trunkend-row [data-end="male"]');
  await until(page, s => s.trunkEnd === 'male' && s.ghosts === 0 && !s.ok);
  rd = await readout(page);
  check('Trunk end: Male with G3/4 on the Ø20 trunk: refused in words (the thread is wider than the run), the threads rows appear', rd.bad && /^2-way: the G3\/4 male thread is Ø26\.44 across - wider than the trunk's Ø20\.00 outside; make it at least Ø26\.9/.test(rd.text) && (await shown(page, 'fx-row-threads')) && (await shown(page, 'fx-row-tlen')), rd.text.slice(0, 130));
  await slide(page, 'od', 28); await slide(page, 'wall', 3);
  await until(page, s => s.ghosts === 1 && s.ok && !s.busy);
  await page.waitForFunction(() => /trunk male G3\/4 thread \(11\.0 mm, a spigot\)/.test(document.getElementById('fx-readout').textContent), null, { timeout: 20000 });
  st = await FX(page);
  check('Ø28 / wall 3: the male G3/4 spigot is in the preview (the status names it), the ghost is taller by the spigot (11 mm)', st.ghost[0].size.y > 53.9 + 8, 'y ' + st.ghost[0].size.y.toFixed(1));
  await frame(page); await shot(page, 'fittings-split2-male-preview.png');
  const dSp = await undoDepth(page);
  await click(page, '#btn-fx-add');
  status = await waitStatus(page, /Dropped splitter 2-way 1|splitter refused/);
  const sp = (await pieces(page)).find(p => p.name === 'splitter 2-way 1'), Ts = sp && await topoOf(page, sp.id);
  check('Add bakes the very thing shown: "splitter 2-way 1", one Undo, a thickened sphere with 3 openings (Euler -2), the status names the spigot, the piece as tall as the ghost was',
    !!sp && (await undoDepth(page)) === dSp + 1 && Ts.open === 0 && Ts.nm === 0 && Ts.flip === 0 && Ts.degen === 0 && Ts.euler === -2 && /trunk male G3\/4 thread \(11\.0 mm, a spigot\)/.test(status) && Math.abs(sp.size.y - st.ghost[0].size.y) < 0.05, status.slice(0, 80));
  await click(page, '#fx-trunkend-row [data-end="plain"]');
  await click(page, '#fx-branchend-row [data-end="female"]');
  await slide(page, 'branch', 60); await slide(page, 'angle', 50);
  await until(page, s => s.branchEnd === 'female' && s.ghosts === 1 && s.ok && !s.busy);
  await page.waitForFunction(() => /branch ends female G3\/4 thread/.test(document.getElementById('fx-readout').textContent), null, { timeout: 20000 });
  check('Branch ends: Female - sockets cut in, T fit appears', /branch ends female G3\/4 thread/.test((await readout(page)).text) && (await shown(page, 'fx-row-tfit')));
  await click(page, '#fx-branchend-row [data-end="plain"]');
  await until(page, s => s.branchEnd === 'plain' && s.ghosts === 1 && !s.busy);
  check('Plain again puts the threads rows away', !(await shown(page, 'fx-row-threads')));

  console.log('\n=== 5c. Ø from tube ===');
  await readyKind(page, 'split2');
  await slide(page, 'od', 30); await slide(page, 'wall', 3); await slide(page, 'angle', 35); await slide(page, 'branch', 30);
  await selectModel(page, tubeId);
  await click(page, '#btn-fx-fromtube');
  await page.waitForFunction(() => document.getElementById('inp-fx-od').value === '20', null, { timeout: 15000 });
  const fo = await field(page, 'od'), fw = await field(page, 'wall');
  await until(page, s => !s.busy && s.ghosts === 1 && s.ok);
  rd = await readout(page);
  check('Ø from tube: Ø20 and wall 1.6 from the Ø20 / 1.6 tube, and the splitter previewed from them (branches ¾ of it: Ø15.00, bore Ø11.80)', fo.box === '20' && fw.box === '1.6' && /Ø20\.00 trunk \(bore Ø16\.80\) into 2 × Ø15\.00 branches \(bore Ø11\.80\).*wall 1\.60 throughout/.test(rd.text), rd.text.slice(0, 140));

  console.log('\n=== 6. the preview is a scene helper; the menu closing; one card at a time; the API ===');
  await page.evaluate(() => { document.getElementById('menu-fittings').open = false; });
  await until(page, s => s.ghosts === 0 && !s.open);
  check('closing the menu takes the preview away', (await page.evaluate(() => state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length)) === 0);
  await page.evaluate(() => { document.getElementById('menu-fittings').open = true; });
  await until(page, s => s.ghosts === 1);
  // the page keeps one panel open: opening Fasteners shuts Fittings, and the ghost passes to Fasteners - never two on the plate
  await page.evaluate(() => { document.getElementById('menu-fasteners').open = true; nsoFasteners.select('bolt'); });   // Fasteners shows a ghost only once a tile is clicked
  await page.waitForFunction(() => nsoFasteners.state().ghosts === 1 && nsoFittings.state().ghosts === 0, null, { timeout: 8000 });
  check('opening Fasteners shuts Fittings (one panel at a time) and takes the ghost: ONE ghost on the plate, owned by Fasteners', (await page.evaluate(() => state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length)) === 1 && (await page.evaluate(() => nsoPiecePreview.state().owner)) === 'fasteners' && !(await FX(page)).open);
  await page.evaluate(() => { document.getElementById('menu-fasteners').open = false; });
  await page.waitForFunction(() => nsoFasteners.state().ghosts === 0, null, { timeout: 8000 });
  await page.evaluate(() => { document.getElementById('menu-gen').open = false; });
  await frames(page, 3);
  check('closing Gen+ leaves no ghost', (await page.evaluate(() => state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length)) === 0);
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; document.getElementById('menu-fittings').open = true; });
  await until(page, s => s.ghosts === 1);
  // the old verbs still bake, with the card's numbers
  await selectModel(page, tubeId);
  const nB = (await pieces(page)).length;
  const viaApi = await page.evaluate(() => nsoFittings.cap());
  check('nsoFittings.cap() still bakes a cap for the selected tube: "cap 1"', viaApi.ok && viaApi.name === 'cap 1' && (await pieces(page)).length === nB + 1, viaApi.reason);
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

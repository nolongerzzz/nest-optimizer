#!/usr/bin/env node
/* Custom shape, driven through the real app: real index.html, real script tags, real pointer drags, real keys, real Undo.
     node tools/nso_custom_shape_drive_check.js            exit 0 = every gate held
     CSHAPE_SHOTS=dir node tools/nso_custom_shape_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_custom_shape_test.js. What this proves is the card:
     1. it is in Gen+ with six preset tiles and three mode tiles, each DRAWN from the engine's own soup
     2. opening it puts a preview (the shared ghost) on the scene - not on the plate - and Add to plate is on
     3. dragging a point on the editor moves that point, snapped; one editor-history step; the preview follows
     4. picking a side and moving its Wall slider changes that side's wall only; dragging its curve handle bows it
     5. double-clicking a side adds a point on it; Delete removes the picked point; Ctrl+Z steps the editor back
     6. a refusal (a radius its sides have no room for) says so, clears the preview and turns Add to plate off
     7. Add to plate bakes one closed piece of the size shown, selected, as one Undo; the app's Undo takes it off
     8. Big lifts the editor over the page and Esc puts it back; closing the menu takes the preview away
     9. Lip tiles and rows change the ghost; With lid shows two ghosts, Add drops both as one Undo; a Solid's In lip and lid are off
    10. Grow / Shrink move the whole outline
    11. Copy from a piece: off with nothing selected; the cut is drawn; Copy reads the tray's outside, then its hole; Ctrl+Z
        brings back what was there; a cut with no hole says so
    12. Calipers: Width / Depth say the size; a picked side's Length applies on Enter only (stretching the box, or moving
        only its end point), Next steps on with the box ready to type, Width / Depth stretch to fit exactly, a refused
        stretch is said and moves nothing, Ctrl+Z steps it back */

const fs = require('fs');
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.CSHAPE_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: SHOTS + '/' + name + '.png' }); };

const ST = page => page.evaluate(() => nsoCustomShape.state());
const SPEC = page => page.evaluate(() => nsoCustomShape.spec());
const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const settle = async page => { await page.waitForTimeout(120); await frames(page, 2); };
/* where world (x, y) mm is on the page */
const at = (page, x, y) => page.evaluate(([x, y]) => nsoCustomShape.toClient(x, y), [x, y]);
async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 3 });
  await page.mouse.move(to[0], to[1], { steps: 3 });
  await page.mouse.up();
  await settle(page);
}
const click = (page, sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const slide = (page, id, v) => page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);

withApp(async (page, logs) => {
  await page.evaluate(() => { try { localStorage.removeItem('nso.customShape.v1'); } catch (e) { /* none */ } });

  console.log('1. the card and its tiles');
  const card = await page.evaluate(() => {
    const m = document.getElementById('menu-cshape');
    return { inGen: !!m && !!m.closest('#menu-gen'), presets: document.querySelectorAll('#cs-preset-row [data-preset]').length, modes: document.querySelectorAll('#cs-mode-row [data-mode]').length };
  });
  check('Custom shape is a card in Gen+', card.inGen);
  check('six preset tiles, three mode tiles', card.presets === 6 && card.modes === 3, JSON.stringify(card));
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; document.getElementById('menu-cshape').open = true; });
  await settle(page);
  const drawn = await page.evaluate(() => {
    const sums = [];
    document.querySelectorAll('#menu-cshape .fs-tile canvas').forEach(c => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7;
      sums.push(c.getAttribute('data-drawn') === '1' ? s : -1);
    });
    return sums;
  });
  check('every tile is painted (6 presets, 3 modes, 3 lips, 3 lids)', drawn.length === 15 && drawn.every(s => s > 0), JSON.stringify(drawn));
  check('no two preset tiles alike', new Set(drawn.slice(0, 6)).size === 6);

  console.log('2. the preview');
  let st = await ST(page);
  check('a ghost stands on the scene', st.ghosts === 1 && st.ghost[0].inScene, JSON.stringify(st.ghost));
  check('Add to plate is on', st.ok && !(await page.evaluate(() => document.getElementById('btn-cs-add').disabled)));
  check('the plate itself is empty', (await page.evaluate(() => state.placed.length)) === 0);
  check('the ghost is the rounded preset, 80 x 25 x 50 (y up)', Math.abs(st.ghost[0].size.x - 80) < 0.01 && Math.abs(st.ghost[0].size.y - 25) < 0.01 && Math.abs(st.ghost[0].size.z - 50) < 0.01, JSON.stringify(st.ghost[0].size));
  await page.locator('#cs-editor').scrollIntoViewIfNeeded();
  await shot(page, '1-open');

  console.log('3. drag a point');
  let sp = await SPEC(page);
  await drag(page, await at(page, sp.points[2].x, sp.points[2].y), await at(page, 90.2, 57.7));
  sp = await SPEC(page); st = await ST(page);
  check('point 3 moved to (90, 58), snapped to 1 mm', sp.points[2].x === 90 && sp.points[2].y === 58, JSON.stringify(sp.points[2]));
  check('it is picked', st.sel && st.sel.kind === 'point' && st.sel.i === 2, JSON.stringify(st.sel));
  check('one editor-history step', st.history === 1, st.history);
  check('the preview followed: as wide as the engine makes it now', st.last.ok && Math.abs(st.ghost[0].size.x - st.last.info.width) < 0.01 && st.last.info.width > 85, st.ghost[0].size.x + ' / ' + (st.last.info && st.last.info.width));
  await shot(page, '2-dragged');

  console.log('4. a side of its own');
  await page.evaluate(() => nsoCustomShape.preset('rounded'));
  await settle(page);
  sp = await SPEC(page);
  const mid = await at(page, 40, 0);                      // side 1: point 1 (0,0) to point 2 (80,0) - its middle is its curve handle
  await page.mouse.click(mid[0] + 18, mid[1]);            // on the line, beside the handle
  await settle(page);
  st = await ST(page);
  check('clicking side 1 picks it', st.sel && st.sel.kind === 'side' && st.sel.i === 0, JSON.stringify(st.sel));
  check('its rows are up, the point rows away', await page.evaluate(() => !document.getElementById('cs-sel-side').hidden && document.getElementById('cs-sel-point').hidden));
  await slide(page, 'inp-cs-wall-slider', 5);
  await settle(page);
  sp = await SPEC(page);
  check('Wall writes side 1 only', sp.sides[0].wall === 5 && sp.sides.slice(1).every(s => s.wall === 2), JSON.stringify(sp.sides.map(s => s.wall)));
  st = await ST(page);
  check('the thinnest wall is still 2', st.last.ok && Math.abs(st.last.info.minWall - 2) < 0.05, st.last.info && st.last.info.minWall);
  await drag(page, await at(page, 40, 0), await at(page, 40, -10.2));
  sp = await SPEC(page);
  check('dragging its curve handle out bows it 10 mm', sp.sides[0].bulge === 10, sp.sides[0].bulge);
  st = await ST(page);
  check('the piece is 10 mm deeper', st.last.ok && Math.abs(st.last.info.depth - 60) < 0.05, st.last.info && st.last.info.depth);
  await shot(page, '3-side');

  console.log('5. add and delete points, editor undo');
  await page.evaluate(() => nsoCustomShape.preset('rect'));
  await settle(page);
  const onSide = await at(page, 80, 30.3);                 // side 2: (80,0) to (80,50)
  await page.mouse.dblclick(onSide[0], onSide[1]);
  await settle(page);
  sp = await SPEC(page); st = await ST(page);
  check('double-click adds point 3 on side 2, snapped', sp.points.length === 5 && sp.points[2].x === 80 && sp.points[2].y === 30, JSON.stringify(sp.points[2]));
  check('the sides split with it, the wall kept', sp.sides.length === 5 && sp.sides[1].wall === 2 && sp.sides[2].wall === 2);
  check('the new point is picked', st.sel && st.sel.kind === 'point' && st.sel.i === 2, JSON.stringify(st.sel));
  await drag(page, await at(page, 80, 30), await at(page, 95, 30));
  sp = await SPEC(page);
  check('and drags out: an odd shape', sp.points[2].x === 95, JSON.stringify(sp.points[2]));
  await page.keyboard.press('Delete');
  await settle(page);
  sp = await SPEC(page);
  check('Delete removes it', sp.points.length === 4 && sp.sides.length === 4, sp.points.length);
  check('Delete did not touch the plate', (await page.evaluate(() => state.placed.length)) === 0);
  await page.keyboard.press('Control+z');
  await settle(page);
  sp = await SPEC(page);
  check('Ctrl+Z puts it back', sp.points.length === 5 && sp.points[2].x === 95, JSON.stringify(sp.points[2]));

  console.log('6. a refusal');
  await page.evaluate(() => nsoCustomShape.preset('rect'));
  await settle(page);
  await page.evaluate(() => nsoCustomShape.select('point', 0));
  await page.evaluate(() => { const b = document.getElementById('inp-cs-r'); b.value = '60'; b.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page);
  st = await ST(page);
  const ro = await page.evaluate(() => ({ text: document.getElementById('cs-readout').textContent, bad: document.getElementById('cs-readout').classList.contains('is-bad'), off: document.getElementById('btn-cs-add').disabled }));
  check('says why, in words, naming the corner', ro.bad && /point 1/.test(ro.text) && /room/.test(ro.text), ro.text);
  check('the preview is cleared and Add to plate is off', st.ghosts === 0 && ro.off, JSON.stringify({ g: st.ghosts, off: ro.off }));
  await shot(page, '4-refused');
  await page.evaluate(() => { const b = document.getElementById('inp-cs-r'); b.value = '10'; b.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page);
  check('a radius that fits brings it back', (await ST(page)).ghosts === 1);

  console.log('7. Add to plate');
  await page.evaluate(() => nsoCustomShape.preset('scoop'));
  await settle(page);
  const undo0 = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-cs-add');
  await settle(page);
  const made = await page.evaluate(() => {
    const m = state.models.filter(Boolean)[0], s = m.rawTris;
    const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2], E = new Map();
    for (let t = 0; t < s.length; t += 9) { const v = [key(t), key(t + 3), key(t + 6)]; for (let k = 0; k < 3; k++) { const e = v[k] + '|' + v[(k + 1) % 3]; E.set(e, (E.get(e) || 0) + 1); } }
    let open = 0; for (const [e, c] of E) { const [a, b] = e.split('|'); if ((E.get(b + '|' + a) || 0) !== c) open++; }
    const a = getActiveModel();
    return { n: state.models.filter(Boolean).length, name: m.name, size: m.size, open, selected: a && a.id === m.id, undo: state.undoStack.length };
  });
  check('one piece, named "custom tray 1"', made.n === 1 && made.name === 'custom tray 1', made.name);
  /* the app's size is y-up: x across, y the height, z the depth */
  check('70 x 160, 30 tall, closed', Math.abs(made.size.x - 70) < 0.01 && Math.abs(made.size.z - 160) < 0.01 && Math.abs(made.size.y - 30) < 0.01 && made.open === 0, JSON.stringify(made.size) + ' open ' + made.open);
  check('selected', made.selected);
  check('one Undo entry', made.undo === undo0 + 1, made.undo - undo0);
  await shot(page, '5-added');
  await page.click('#btn-undo');
  await settle(page);
  check('the app\'s Undo takes it off', (await page.evaluate(() => state.models.filter(Boolean).length)) === 0);

  console.log('8. Big, and closing');
  await page.click('#btn-cs-big');
  await settle(page);
  const big = await page.evaluate(() => { const w = document.getElementById('cs-editor-wrap'), c = document.getElementById('cs-editor'); return { body: w.parentNode === document.body, cls: w.classList.contains('is-big'), w: c.clientWidth }; });
  check('Big lifts the editor out, bigger', big.body && big.cls && big.w > 400, JSON.stringify(big));
  await shot(page, '6-big');
  await page.keyboard.press('Escape');
  await settle(page);
  const back = await page.evaluate(() => { const w = document.getElementById('cs-editor-wrap'); return { inCard: !!w.closest('#menu-cshape'), cls: w.classList.contains('is-big') }; });
  check('Esc puts it back in the card', back.inCard && !back.cls, JSON.stringify(back));
  await page.evaluate(() => { document.getElementById('menu-cshape').open = false; });
  await settle(page);
  check('closing the menu takes the preview away', (await page.evaluate(() => state.scene.children.filter(c => c.userData && c.userData.nsoPiecePreview).length)) === 0);

  console.log('9. lip and lid');
  await page.evaluate(() => { document.getElementById('menu-cshape').open = true; });
  await settle(page);
  await page.evaluate(() => nsoCustomShape.preset('rounded'));
  await settle(page);
  await click(page, '#cs-lip-row [data-lip="out"]');
  await settle(page);
  st = await ST(page);
  check('the Out tile puts a 3 mm flange round the top: the ghost is 86 wide', (await SPEC(page)).lip.type === 'out' && Math.abs(st.ghost[0].size.x - 86) < 0.01, JSON.stringify(st.ghost[0] && st.ghost[0].size));
  check('its rows are up', await page.evaluate(() => !document.getElementById('cs-row-lipw').hidden && !document.getElementById('cs-row-lipch').hidden));
  await slide(page, 'inp-cs-lipw-slider', 5);
  await settle(page);
  check('Lip width moves it: 90 wide', Math.abs((await ST(page)).ghost[0].size.x - 90) < 0.01);
  await click(page, '#cs-lid-row [data-lid="with"]');
  await settle(page);
  st = await ST(page);
  check('With lid: two ghosts, the tray and its lid', st.ghosts === 2 && st.parts.length === 2 && st.parts[1].kind === 'lid', JSON.stringify(st.parts.map(q => q.kind)));
  check('the lid covers the lip (90 wide) and stands 6 tall (2 plate + 4 plug)', Math.abs(st.ghost[1].size.x - 90) < 0.01 && Math.abs(st.ghost[1].size.y - 6) < 0.01, JSON.stringify(st.ghost[1].size));
  await shot(page, '7-lip-lid');
  const undoA = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-cs-add');
  await settle(page);
  const two = await page.evaluate(() => state.models.filter(Boolean).map(m => m.name));
  check('Add to plate drops both: "custom tray 1" and "custom lid 1"', two.length === 2 && two.includes('custom tray 1') && two.includes('custom lid 1'), JSON.stringify(two));
  check('as one Undo', (await page.evaluate(() => state.undoStack.length)) === undoA + 1);
  await page.click('#btn-undo');
  await settle(page);
  check('which takes both off', (await page.evaluate(() => state.models.filter(Boolean).length)) === 0);
  await click(page, '#cs-mode-row [data-mode="solid"]');
  await settle(page);
  const solidOff = await page.evaluate(() => ({ inLip: document.querySelector('#cs-lip-row [data-lip="in"]').disabled, lid: document.querySelector('#cs-lid-row [data-lid="with"]').disabled }));
  check('a Solid takes no inside lip and no lid (their tiles are off)', solidOff.inLip && solidOff.lid, JSON.stringify(solidOff));
  await page.evaluate(() => { nsoCustomShape.mode('tray'); nsoCustomShape.lip('none'); nsoCustomShape.lid('none'); });
  await settle(page);

  console.log('10. Grow / Shrink');
  await page.evaluate(() => nsoCustomShape.preset('rounded'));
  await page.evaluate(() => { const b = document.getElementById('inp-cs-grow'); b.value = '1'; });
  await page.click('#btn-cs-shrink');
  await settle(page);
  sp = await SPEC(page);
  check('Shrink 1: every point 1 in, every radius 1 less', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])) === '[[1,1,7],[79,1,7],[79,49,7],[1,49,7]]', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])));
  await page.click('#btn-cs-grow');
  await settle(page);
  sp = await SPEC(page);
  check('Grow 1 puts it back', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])) === '[[0,0,8],[80,0,8],[80,50,8],[0,50,8]]', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])));

  console.log('11. copy an outline from a piece');
  await page.evaluate(() => { nsoCustomShape.preset('rounded'); nsoCustomShape.add(); nsoCustomShape.preset('trapezoid'); });
  await settle(page);
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; document.getElementById('cs-copy').open = true; window.dispatchEvent(new Event('pointerup')); });
  await settle(page);
  check('with nothing selected, Copy outline is off and says why', await page.evaluate(() => document.getElementById('btn-cs-copy').disabled && /Select a piece/.test(document.getElementById('cs-copy-src').textContent)));
  await page.evaluate(() => { const m = state.models.filter(Boolean)[0], i = state.placed.findIndex(p => p && p.sourceId === m.id); state.editId = m.id; selectPlaced(i); window.dispatchEvent(new Event('pointerup')); });
  await settle(page);
  const cut = await page.evaluate(() => ({ max: +document.getElementById('inp-cs-cut-slider').max, at: +document.getElementById('inp-cs-cut').value, off: document.getElementById('btn-cs-copy').disabled, ref: nsoCustomShape.ref() }));
  check('selecting the tray: the cut starts half way up its 25 mm, and is drawn', cut.max === 25 && cut.at === 12.5 && !cut.off && cut.ref && cut.ref.length > 20, JSON.stringify({ max: cut.max, at: cut.at, off: cut.off, ref: cut.ref && cut.ref.length }));
  await page.locator('#cs-editor').scrollIntoViewIfNeeded();
  await shot(page, '8-cut');
  await page.click('#btn-cs-copy');
  await settle(page);
  sp = await SPEC(page);
  check('Copy outline: the tray\'s outside comes back as 4 points of radius 8', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])) === '[[0,0,8],[80,0,8],[80,50,8],[0,50,8]]', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])));
  await page.evaluate(() => { const el = document.getElementById('sel-cs-copy-use'); el.value = 'inside'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#btn-cs-copy');
  await settle(page);
  sp = await SPEC(page);
  check('Use: its inside - the tray\'s hole, 76 x 46 at radius 6', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])) === '[[0,0,6],[76,0,6],[76,46,6],[0,46,6]]', JSON.stringify(sp.points.map(p => [p.x, p.y, p.r])));
  await page.locator('#cs-editor').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle(page);
  sp = await SPEC(page);
  check('Ctrl+Z twice: the trapezoid that was there', sp.points.length === 4 && sp.points[2].x === 70 && sp.points[2].y === 50, JSON.stringify(sp.points.map(p => [p.x, p.y])));
  await page.evaluate(() => { const b = document.getElementById('inp-cs-cut'); b.value = '1'; b.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle(page);
  check('a cut through the floor has no hole, and says so', await page.evaluate(() => document.getElementById('btn-cs-copy').disabled && /no hole/.test(document.getElementById('cs-copy-src').textContent)), await page.evaluate(() => document.getElementById('cs-copy-src').textContent));
  await shot(page, '9-copied');

  console.log('12. calipers');
  await page.evaluate(() => { document.getElementById('cs-copy').open = false; nsoCustomShape.preset('rounded'); });
  await settle(page);
  const typeEnter = async (id, v) => { await page.fill('#' + id, String(v)); await page.press('#' + id, 'Enter'); await settle(page); };
  check('Width and Depth say the outline\'s size', JSON.stringify(await page.evaluate(() => [document.getElementById('inp-cs-w').value, document.getElementById('inp-cs-d').value])) === '["80","50"]');
  await page.evaluate(() => nsoCustomShape.select('side', 0));
  await settle(page);
  check('picking side 1: its Length box says 80, Prev / Next are up', await page.evaluate(() => document.getElementById('inp-cs-len').value === '80' && !document.getElementById('cs-sel-nav').hidden && /Side 1 of 4/.test(document.getElementById('cs-nav-what').textContent)));
  await page.fill('#inp-cs-len', '1');
  await settle(page);
  check('a half-typed number does nothing until Enter', (await SPEC(page)).points[1].x === 80);
  await typeEnter('inp-cs-len', '112.5');
  sp = await SPEC(page);
  check('Enter: side 1 is 112.5, the box stretched (the far side moved with it)', JSON.stringify(sp.points.map(p => [p.x, p.y])) === '[[0,0],[112.5,0],[112.5,50],[0,50]]', JSON.stringify(sp.points.map(p => [p.x, p.y])));
  check('and Width follows: 112.5', (await page.evaluate(() => document.getElementById('inp-cs-w').value)) === '112.5');
  await page.click('#btn-cs-next');
  await settle(page);
  check('Next: side 2, its Length (50) ready to type over', await page.evaluate(() => nsoCustomShape.state().sel.i === 1 && document.activeElement && document.activeElement.id === 'inp-cs-len' && document.getElementById('inp-cs-len').value === '50'));
  await page.keyboard.type('64.2');
  await page.keyboard.press('Enter');
  await settle(page);
  check('typed straight in: side 2 is 64.2', (await page.evaluate(() => nsoCustomShape.spec().points[2].y)) === 64.2);
  await page.selectOption('#sel-cs-len-how', 'end');
  await typeEnter('inp-cs-len', '70');
  sp = await SPEC(page);
  check('move end point: only point 3 moves, side 2 is 70', sp.points[2].y === 70 && sp.points[3].y === 64.2, JSON.stringify(sp.points.map(p => [p.x, p.y])));
  await page.selectOption('#sel-cs-len-how', 'stretch');
  await page.evaluate(() => nsoCustomShape.preset('rounded'));
  await settle(page);
  await typeEnter('inp-cs-d', '61.3');
  check('Depth 61.3: the outline measures 61.3 deep, corners and all', Math.abs((await ST(page)).last.info.depth - 61.3) < 0.005, (await ST(page)).last.info.depth);
  await page.evaluate(() => nsoCustomShape.select('side', 0));
  await settle(page);
  await typeEnter('inp-cs-len', '0.5');
  check('a stretch that cannot be: said in words, nothing moved', await page.evaluate(() => /fold over/.test(document.getElementById('cs-readout').textContent) && nsoCustomShape.spec().points[1].x === 80 && document.getElementById('inp-cs-len').value === '80'));
  await page.locator('#cs-editor').focus();
  await page.keyboard.press('Control+z');
  await settle(page);
  check('Ctrl+Z steps a measurement back', Math.abs((await ST(page)).last.info.depth - 50) < 0.005);
  await page.evaluate(() => nsoCustomShape.select('side', 0));
  await page.locator('#cs-editor').scrollIntoViewIfNeeded();
  await shot(page, '10-calipers');

  const errs = logs.filter(l => /\[pageerror\]|\[error\]/.test(l) && /custom|cs-|NSO_CustomShape/i.test(l));
  check('no page errors from the card', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

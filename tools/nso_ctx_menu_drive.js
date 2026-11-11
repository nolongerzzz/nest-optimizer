#!/usr/bin/env node
/* The right-click menu: Undo, Redo, Clone, Mirror across X, Export selected
   as..., Export plate, Clear plate, Delete piece. Driven in the real page with
   real right-clicks.
     node tools/nso_ctx_menu_drive.js [outDir]     exit 0 = every gate held

   Gates (9 Select all, 10 Split to parts are the newest):
     1  on a piece the menu opens with every item in order; on bare plate the
        piece items are grey and the plate's items are not; off the plate, in
        the background, there is still no menu
     2  Undo and Redo grey when their stack is empty, live while the menu is up
     3  Clone makes ONE copy whatever the Clone count box says
     4  Mirror across X = the Mirror card's result for the same plane, one Undo
     5  Export selected as... / Export plate open the Export card with the
        format chooser, on the button for that piece / the plate
     6  Clear plate from the menu = CLEAR PLATE
     7  Delete piece as before (one Undo puts it back)
     8  the menu closes on Escape and on a click outside it
   Screenshots go to outDir (default tools/ctx-menu-out, scratch like the other
   drives' *-out folders). */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tools', 'ctx-menu-out'));
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const fx = f => path.join(ROOT, 'fixtures', f);
const ITEMS = ['ctx-undo', 'ctx-redo', 'ctx-select-all', 'ctx-split', 'ctx-clone', 'ctx-mirror', 'ctx-support-blocker', 'ctx-export', 'ctx-export-plate', 'ctx-clear-plate', 'ctx-delete-plate', 'ctx-delete'];

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  const N = page.evaluate.bind(page);
  await N(() => {
    const H = window.__c = {};
    H.proj = (a) => {
      const r = state.renderer.domElement.getBoundingClientRect();
      state.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3().fromArray(a).project(state.camera);
      return [r.left + (p.x * 0.5 + 0.5) * r.width, r.top + (-p.y * 0.5 + 0.5) * r.height];
    };
    H.open = () => !document.getElementById('ctx-menu').classList.contains('hidden');
    H.off = () => Object.fromEntries(['ctx-undo', 'ctx-redo', 'ctx-select-all', 'ctx-split', 'ctx-clone', 'ctx-mirror', 'ctx-export', 'ctx-export-plate', 'ctx-clear-plate', 'ctx-delete-plate', 'ctx-delete']
      .map(id => [id, document.getElementById(id).disabled]));
    /* a point on bare plate: on the plate, on no piece, clear of the buttons */
    H.barePlate = () => {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (let x = -85; x <= 85; x += 10) for (let z = -85; z <= 85; z += 10) {
        const s = H.proj([x, 0, z]), e = { clientX: s[0], clientY: s[1] };
        if (s[0] < r.left + 90 || s[0] > r.right - 40 || s[1] < r.top + 120 || s[1] > r.bottom - 40) continue;
        if (hitPlateSurface(e) && pickPlacedIndexFromEvent(e) < 0) return s;
      }
      return null;
    };
    H.reset = () => {
      state.models = []; state.placed = []; state.undoStack = []; state.redoStack = [];
      clearDisplayMeshes(); state.editId = null; state.selectedIndex = -1; updateUndoBtn(); hideCtxMenu();
    };
    H.soup = (id) => { const m = state.models.find(x => x.id === id); const u = new Uint32Array(m.rawTris.buffer, m.rawTris.byteOffset, m.rawTris.length);
      let h = 2166136261 >>> 0; for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return u.length + ':' + h.toString(16); };
  });
  const frames = (n) => N(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 3);
  const rightClick = async ([x, y]) => { await page.mouse.click(x, y, { button: 'right' }); await frames(3); };
  const shot = async (n) => { try { await page.screenshot({ path: path.join(OUT, n + '.png') }); } catch (e) {} };

  console.log('\n=== 1. the menu: on a piece, on bare plate, off the plate ===');
  const boxId = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => { state.undoStack = []; updateUndoBtn(); });
  const onBox = await N(() => window.__c.proj(state.placed[0].mesh.position.toArray()));
  await rightClick(onBox);
  check('a right-click on the piece opens the menu', await N(() => window.__c.open()));
  check('the items, in order', JSON.stringify(await N(() => Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map(b => b.id)))
    === JSON.stringify(ITEMS));
  check('the labels', JSON.stringify(await N(() => Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map(b => b.firstElementChild && b.children.length ? b.firstElementChild.textContent : b.textContent)))
    === JSON.stringify(['Undo', 'Redo', 'Select all', 'Split to parts', 'Clone', 'Mirror across X', 'Add Supports Blocker...', 'Export selected as…', 'Export plate', 'Clear plate', 'Delete plate', 'Delete piece']));
  check('two separators: after Redo and after Export plate', await N(() => {
    const kids = Array.from(document.getElementById('ctx-menu').children).map(e => e.classList.contains('ctx-sep') ? '-' : e.id);
    return kids.join() === 'ctx-undo,ctx-redo,-,ctx-select-all,ctx-split,ctx-clone,ctx-mirror,ctx-support-blocker,ctx-export,ctx-export-plate,-,ctx-clear-plate,ctx-delete-plate,ctx-delete';
  }));
  check('the piece is selected', (await N(() => state.selectedIndex)) === 0);
  let off = await N(() => window.__c.off());
  check('on a piece: Clone, Mirror, Export selected, Export plate, Clear plate, Delete are live',
    ['ctx-select-all', 'ctx-split', 'ctx-clone', 'ctx-mirror', 'ctx-export', 'ctx-export-plate', 'ctx-clear-plate', 'ctx-delete'].every(k => !off[k]), JSON.stringify(off));
  check('Undo and Redo are grey (nothing done yet)', off['ctx-undo'] && off['ctx-redo']);
  check('the shortcut hints are there', await N(() => /Z/.test(document.getElementById('ctx-undo-key').textContent) && /Z|Y/.test(document.getElementById('ctx-redo-key').textContent)));
  await shot('01-menu-on-piece');

  await N(() => hideCtxMenu());
  const bare = await N(() => window.__c.barePlate());
  check('a bare-plate point was found', !!bare);
  await rightClick(bare);
  check('a right-click on bare plate opens the menu', await N(() => window.__c.open()));
  off = await N(() => window.__c.off());
  check('...the piece items are grey', ['ctx-split', 'ctx-clone', 'ctx-mirror', 'ctx-export', 'ctx-delete'].every(k => off[k]), JSON.stringify(off));
  check('...Export plate, Clear plate and Select all are not', !off['ctx-export-plate'] && !off['ctx-clear-plate'] && !off['ctx-select-all']);
  await shot('02-menu-on-bare-plate');
  await N(() => window.__c.off()); // keep the menu up for the click below
  const cloneBefore = await N(() => state.models.length);
  await page.click('#ctx-clone', { force: true, timeout: 1500 }).catch(() => {});
  check('a grey Clone does nothing', (await N(() => state.models.length)) === cloneBefore);
  await N(() => hideCtxMenu());
  await page.mouse.click(1000, 70, { button: 'right' });
  await frames(3);
  check('off the plate, in the background: no menu', !(await N(() => window.__c.open())));

  console.log('\n=== 2. Undo and Redo grey and live ===');
  await N(() => { selectPlaced(0); nudgeSelected(6, 0); });
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  off = await N(() => window.__c.off());
  check('after a move: Undo is live, Redo grey', !off['ctx-undo'] && off['ctx-redo']);
  const x1 = await N(() => state.placed[0].x);
  await page.click('#ctx-undo');
  check('Undo from the menu moved the piece back', (await N(() => state.placed[0].x)) === x1 - 6);
  check('...and closed the menu', !(await N(() => window.__c.open())));
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  off = await N(() => window.__c.off());
  check('now Redo is live, Undo grey', off['ctx-undo'] && !off['ctx-redo']);
  await page.click('#ctx-redo');
  check('Redo from the menu put it forward again', (await N(() => state.placed[0].x)) === x1);
  check('...the top-bar buttons agree', await N(() => !document.getElementById('btn-undo').disabled && document.getElementById('btn-redo').disabled));

  console.log('\n=== 3. Clone: one copy, whatever the count box says ===');
  await N(() => { document.getElementById('clone-count').value = '3'; selectPlaced(0); });
  const m0 = await N(() => [state.models.length, state.placed.length, state.undoStack.length]);
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-clone');
  const m1 = await N(() => [state.models.length, state.placed.length, state.undoStack.length]);
  check('one copy: +1 model, +1 piece, +1 Undo', m1[0] === m0[0] + 1 && m1[1] === m0[1] + 1 && m1[2] === m0[2] + 1, m0.join() + ' -> ' + m1.join());
  check('...landed 4 mm to the right of the piece it copied, in line with it (not the plate corner)', await N(() => {
    const c = state.placed[state.selectedIndex], o = state.placed[0];
    return Math.abs((c.x - c.width / 2) - (o.x + o.width / 2) - 4) < 1e-6 && Math.abs(c.z - o.z) < 1e-6;
  }));
  check('...named -copy1, and selected', await N(() => /-copy1$/.test(state.placed[state.selectedIndex] && state.placed[state.selectedIndex].name || '')));
  check('...the box still says 3 (the Clone button is unchanged)', (await N(() => document.getElementById('clone-count').value)) === '3');
  await N(() => { document.getElementById('btn-clone').click(); });
  check('the Clone button still reads the box: three more', (await N(() => state.models.length)) === m1[0] + 3);
  await N(() => { document.getElementById('clone-count').value = '1'; undoLast(); undoLast(); });

  console.log('\n=== 4. Mirror across X ===');
  await N(() => window.__c.reset());
  const id4 = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => { selectPlaced(0); state.undoStack = []; updateUndoBtn(); });
  const soup0 = await N(i => window.__c.soup(i), id4);
  // the plane the menu will use: the middle of the piece's extent along X
  const plane = await N(i => { const m = state.models.find(x => x.id === i); let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < m.rawTris.length; k += 3) { lo = Math.min(lo, m.rawTris[k]); hi = Math.max(hi, m.rawTris[k]); } return (lo + hi) / 2; }, id4);
  const u0 = await N(() => state.undoStack.length);
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-mirror');
  const status4 = await N(() => document.getElementById('status').textContent);
  const soupMenu = await N(i => window.__c.soup(i), id4);
  check('the menu mirrored the piece', soupMenu !== soup0 && /Mirror done/.test(status4), status4);
  check('...across X at the centre plane', new RegExp('X across ' + String(plane).replace('.', '\\.')).test(status4), 'plane ' + plane);
  check('...one Undo step', (await N(() => state.undoStack.length)) === u0 + 1 && (await N(() => state.undoStack[state.undoStack.length - 1].type)) === 'mirrorReplace');
  // the card, same plane, on a fresh copy of the same piece
  await N(() => window.__c.reset());
  const id4b = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(i => { selectPlaced(0); state.editId = i; }, id4b);
  await N(p => { document.getElementById('inp-mirror-plane').value = String(p); document.getElementById('btn-mirror').click(); }, plane);
  const soupCard = await N(i => window.__c.soup(i), id4b);
  check('the Mirror card at the same plane makes the same soup, bit for bit', soupCard === soupMenu);
  // and it undoes in one step
  await N(() => undoLast());
  check('one Undo puts the soup back', (await N(i => window.__c.soup(i), id4b)) === soup0);
  await N(() => redoLast());
  check('Redo mirrors it again, bit for bit', (await N(i => window.__c.soup(i), id4b)) === soupMenu);

  console.log('\n=== 5. Export selected as... / Export plate ===');
  await N(() => { document.getElementById('menu-export').open = false; hideCtxMenu(); });
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-export');
  check('Export selected as... opens the Export card', await N(() => document.getElementById('menu-export').open));
  check('...which holds the STL / 3MF chooser', await N(() => { const s = document.getElementById('export-format'); return !!s && s.offsetParent !== null && s.options.length >= 2; }));
  check('...with Download selected in front', await N(() => document.activeElement && document.activeElement.id === 'btn-export-model'));
  check('...and the menu is closed', !(await N(() => window.__c.open())));
  await shot('03-export-selected');
  await N(() => { document.getElementById('menu-export').open = false; });
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-export-plate');
  check('Export plate opens the same card on the plate button', await N(() => document.getElementById('menu-export').open && document.activeElement.id === 'btn-export-stl'));
  check('...it is the same chooser as the EXPORT button', await N(() => document.getElementById('export-format') === document.querySelector('#menu-export #export-format')));
  page.once('dialog', dlg => dlg.accept());   // the export names its file with a prompt
  const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await N(() => { document.getElementById('export-format').value = 'stl'; updateExportFormatUI(); document.getElementById('btn-export-model').click(); });
  const d = await dl;
  check('Download selected from there downloads the piece', !!d, d ? d.suggestedFilename() : 'no download');
  await N(() => { document.getElementById('menu-export').open = false; });

  console.log('\n=== 6. Clear plate = CLEAR PLATE ===');
  const setup6 = async () => { await N(() => window.__c.reset()); await loadSTL(page, fx('box_hull_80x40x20-2.stl')); await loadSTL(page, fx('box-20mm.stl'));
    await N(() => { selectPlaced(0); nudgeSelected(3, 3); }); };
  const read6 = () => N(() => ({ placed: state.placed.length, models: state.models.length, sel: state.selectedIndex, cut: state.cutterOpen,
    status: document.getElementById('status').textContent, redo: state.redoStack.length, kids: state.modelGroup.children.length }));
  await setup6();
  await N(() => document.getElementById('btn-clear-plate').click());
  const viaButton = await read6();
  await setup6();
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-clear-plate');
  const viaMenu = await read6();
  check('the same plate: none placed, none kept (Clear plate empties the model list; they are in Import > Recent)', viaMenu.placed === 0 && viaMenu.models === 0, JSON.stringify(viaMenu));
  check('menu and button leave the same state', JSON.stringify(viaMenu) === JSON.stringify(viaButton), JSON.stringify(viaButton));

  console.log('\n=== 7. Delete piece, as before ===');
  await setup6();
  const n7 = await N(() => state.placed.length);
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-delete');
  check('the piece is gone', (await N(() => state.placed.length)) === n7 - 1);
  await N(() => undoLast());
  check('one Undo puts it back', (await N(() => state.placed.length)) === n7);

  console.log('\n=== 8. closing ===');
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  check('open', await N(() => window.__c.open()));
  await page.keyboard.press('Escape');
  check('Escape closes it', !(await N(() => window.__c.open())));
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.mouse.click(1100, 600);
  await frames(2);
  check('a click outside closes it', !(await N(() => window.__c.open())));
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  const mb = await page.locator('#ctx-menu').boundingBox();
  await page.mouse.click(mb.x + 4, mb.y + mb.height / 2 + 0.01); // on the padding, not an item
  check('a click on the menu\'s own padding leaves it open', await N(() => window.__c.open()));

  console.log('\n=== 9. Select all ===');
  await N(() => window.__c.reset());
  await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await loadSTL(page, fx('box-20mm.stl'));
  await loadSTL(page, fx('box_open.stl'));
  await N(() => { state.undoStack = []; updateUndoBtn(); });
  // lit = the one selected look (app-core nsoPaintSelLook): the rose body and the white outline
  const lit = () => N(() => state.placed.map(p => p.mesh.material.color.getHex() === 0xf43f5e && !!(p.outline && p.outline.parent === p.mesh)));
  const bare9 = await N(() => window.__c.barePlate());
  await rightClick(bare9);
  check('Select all is live on bare plate', !(await N(() => window.__c.off()))['ctx-select-all']);
  await page.click('#ctx-select-all');
  check('...every piece on the plate is lit', (await lit()).every(Boolean) && (await lit()).length === 3, JSON.stringify(await lit()));
  check('...the group holds all three, no single piece is selected', await N(() => nsoSelAllPieces().length === 3 && state.selectedIndex === -1));
  check('...the menu closed and the status says so', !(await N(() => window.__c.open())) && /all 3 pieces/.test(await N(() => document.getElementById('status').textContent)));
  await shot('04-select-all');
  // right-click on a piece of the group: group kept, single-piece items grey, Delete reads "Delete 3 pieces"
  await rightClick(await N(() => window.__c.proj(state.placed[1].mesh.position.toArray())));
  off = await N(() => window.__c.off());
  check('right-click on a grouped piece keeps the group', await N(() => nsoSelAllPieces().length === 3));
  check('...single-piece items grey (Split, Clone, Mirror, Export selected)', ['ctx-split', 'ctx-clone', 'ctx-mirror', 'ctx-export'].every(k => off[k]), JSON.stringify(off));
  check('...Delete is live and counts the group', !off['ctx-delete'] && (await N(() => document.getElementById('ctx-delete').textContent)) === 'Delete 3 pieces');
  await page.click('#ctx-delete');
  check('Delete from the menu removes all three', (await N(() => state.placed.length)) === 0);
  await N(() => undoLast()); await N(() => undoLast()); await N(() => undoLast());
  check('...three Undos put them all back', (await N(() => state.placed.length)) === 3);
  // selecting one piece ends the group
  await N(() => nsoSelectAllOnPlate());
  await N(() => selectPlaced(2));
  check('selecting one piece ends the group: the others go dark, it is the selection', (await lit()).slice(0, 2).every(v => !v) && (await N(() => state.selectedIndex)) === 2 && (await N(() => nsoSelAllPieces().length)) === 0, JSON.stringify(await lit()));
  // Delete key on the group removes pieces, never the active model
  await N(() => nsoSelectAllOnPlate());
  const models9 = await N(() => state.models.length);
  await page.keyboard.press('Delete');
  check('the Delete key on a group deletes the pieces, not a model', (await N(() => state.placed.length)) === 0 && (await N(() => state.models.length)) === models9);
  await N(() => { undoLast(); undoLast(); undoLast(); });

  console.log('\n=== 10. Split to parts ===');
  await N(() => window.__c.reset());
  await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  check('Split to parts is live on a piece', !(await N(() => window.__c.off()))['ctx-split']);
  await page.click('#ctx-split');
  check('a one-part piece is refused with the reason, nothing changes', (await N(() => state.placed.length)) === 1 &&
    /one part|1 part|single|nothing/i.test(await N(() => document.getElementById('status').textContent)), await N(() => document.getElementById('status').textContent));
  await N(() => window.__c.reset());
  const hingeSoup = require('./nso_split_parts_fixtures.js').hingeLifted().soup;
  const tmp = path.join(require('os').tmpdir(), 'nso-ctx-split-hinge.stl');
  require('./nso_stl_io.js').writeSTL(tmp, hingeSoup);
  await loadSTL(page, tmp);
  await rightClick(await N(() => window.__c.proj(state.placed[0].mesh.position.toArray())));
  await page.click('#ctx-split');
  check('a two-part piece becomes two pieces', (await N(() => state.placed.length)) === 2, await N(() => document.getElementById('status').textContent));
  await N(() => undoLast());
  check('one Undo puts the one piece back', (await N(() => state.placed.length)) === 1);

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nctx:menu - all gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

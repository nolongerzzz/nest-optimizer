#!/usr/bin/env node
/* Tool helpers: one registry, one teardown (nso-helpers.js) - driven in the
   real page.
     node tools/nso_helpers_teardown_test.js      exit 0 = every gate held

   THE BUG, seen twice. (a) A Bend session on a tube, then Clear, then
   library/box_closed.stl loaded: a vertical translucent sheet stood through
   the box's middle - Bend's marker, drawn by a session nothing had closed.
   (b) An export carried a 12-triangle slab 1.5 mm thick lying on a piece's
   top face: a helper written out as a piece.

   THE RULE every helper is held to here: tagged, removed on leave-tool /
   Clear / an Undo past the step it was drawn after, never selectable, never
   exported, never counted by Watch.

   1. Each tool opened on a piece until its helper is drawn - Cut, Crop,
      Bend, Tube edge, Bridge, Measure, Check, Rotate, Move, Brush, the
      picked-face highlight, Foam, G-scope's Overhangs and Lift - and then
      left. Every helper it drew is tagged; the ones nothing drags answer no
      ray; after the leave the tool is closed and the scene holds the pieces
      and the plate and nothing else.
   2. Clear, then a piece loaded: pieces and plate only.
   3. Repro (a), as a person runs it, with real clicks on Bend and Clear.
   4. Export, with helpers live, through the real Export plate button: the
      STL holds exactly the pieces' triangles. Repro (b): a 12-triangle
      1.5 mm slab helper put on the plate list as if it had leaked - the
      STL, the 3MF objects and the scene block all leave it out.
   5. Undo past a helper's step: Bend's marker is redrawn from the piece as
      it now is, the Check's marks go, nothing older than the stack is left.
   6. Watch counts no helper as a piece and reports one left on screen after
      its tool closed. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const NSO_Stock = require('../nso_stock.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-helpers-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const circle = (cy, cz, r, n) => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [cy + r * Math.cos(a), cz + r * Math.sin(a)]; });
// A round tube along X, long enough for Bend to make a ghost of (nso_bend_drive_check.js's).
function roundTube(len, n) {
  const O = circle(20, 10, 8, n), I = circle(20, 10, 6, n), t = [];
  for (const lp of [O, I.slice().reverse()]) for (let i = 0; i < lp.length; i++) {
    const p = lp[i], q = lp[(i + 1) % lp.length];
    t.push([0, p[0], p[1]], [0, q[0], q[1]], [len, q[0], q[1]], [0, p[0], p[1]], [len, q[0], q[1]], [len, p[0], p[1]]);
  }
  for (const [x, far] of [[len, true], [0, false]]) for (let i = 0; i < n; i++) {
    const O0 = O[i], O1 = O[(i + 1) % n], I0 = I[i], I1 = I[(i + 1) % n];
    for (const tr of [[[x, O0[0], O0[1]], [x, O1[0], O1[1]], [x, I1[0], I1[1]]], [[x, O0[0], O0[1]], [x, I1[0], I1[1]], [x, I0[0], I0[1]]]])
      far ? t.push(...tr) : t.push(tr[0], tr[2], tr[1]);
  }
  return new Float32Array(t.flat());
}
const BEND_TUBE = writeSTL('bend-tube.stl', roundTube(120, 48));
const STOCK_TUBE = writeSTL('stock-tube.stl', NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 40), 96));
const BOX_CLOSED = path.join(ROOT, 'library', 'box_closed.stl');
const CAVITY = path.join(ROOT, 'fixtures', 'box_cavity_30.stl');

/* ---- in the page ---------------------------------------------------------- */

/* Everything in the scene that is neither a piece nor the plate, and every
   tagged helper anywhere under it (a piece's own children included). The
   selection outline and the lock cage are a piece's own drawing, so a piece
   mesh's untagged children are the piece. */
const audit = page => page.evaluate(() => {
  const plate = new Set([state.plateMesh, state.plateGrid, state.plateBorder].concat(state.plateTicks || []));
  const pieces = new Set(state.placed.map(p => p && p.mesh).filter(Boolean));
  const label = o => (o.name || o.type) + (o.userData && o.userData.nsoHelper ? ' [' + o.userData.nsoHelper + ']' : '');
  const extra = [];
  state.scene.children.forEach(c => {
    if (c === state.modelGroup || c.isLight || plate.has(c)) return;
    extra.push('scene: ' + label(c));
  });
  state.modelGroup.children.forEach(c => { if (!pieces.has(c)) extra.push('modelGroup: ' + label(c)); });
  state.scene.traverse(o => {
    if (o.userData && o.userData.nsoHelper && extra.every(e => e.indexOf(label(o)) < 0)) extra.push('tagged: ' + label(o));
  });
  // G-scope draws in a scene of its own.
  const v = window.NSO_MICROSCOPE && NSO_MICROSCOPE.getView && NSO_MICROSCOPE.getView();
  if (v && v.scene) v.scene.traverse(o => { if (o.userData && o.userData.nsoHelper) extra.push('gscope: ' + label(o)); });
  return extra;
});

/* The helpers a tool has drawn: every live one, with its owner, whether it is
   meant to be dragged, and whether a ray through it can land on it. */
const drawn = page => page.evaluate(() => nsoHelpers.live().map(o => {
  let deaf = true;
  if (!o.userData.nsoHelperInteractive) {
    o.updateMatrixWorld(true);
    o.traverse(n => {
      if (!n.geometry) return;
      if (!n.geometry.boundingSphere) n.geometry.computeBoundingSphere();
      if (!n.geometry.boundingSphere) return;
      const c = n.geometry.boundingSphere.center.clone().applyMatrix4(n.matrixWorld);
      const rc = new THREE.Raycaster(state.camera.position.clone(), c.clone().sub(state.camera.position).normalize());
      rc.params.Line.threshold = 5;
      rc.params.Points.threshold = 5;
      if (rc.intersectObject(n, false).length) deaf = false;
    });
  }
  return { owner: o.userData.nsoHelper, name: o.name || o.type, interactive: !!o.userData.nsoHelperInteractive, deaf };
}));

const frames = (page, n) => page.evaluate(k => new Promise(r => {
  const step = () => (k-- > 0 ? requestAnimationFrame(step) : r());
  step();
}), n || 3);

const selectPiece = (page, id) => page.evaluate(i => {
  state.editId = i;
  const idx = state.placed.findIndex(p => p && p.sourceId === i);
  if (idx >= 0) selectPlaced(idx);
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
}, id);

const screenOf = (page, p) => page.evaluate(pt => {
  const v = new THREE.Vector3(pt[0], pt[1], pt[2]).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}, p);
// A point on the top face of the selected piece, a little in from its +X +Z corner.
const topPoint = (page, inset) => page.evaluate(d => {
  const p = state.placed[state.selectedIndex];
  p.mesh.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p.mesh);
  return [(b.min.x + b.max.x) / 2 + d, b.max.y, (b.min.z + b.max.z) / 2];
}, inset || 0);

const leave = page => page.evaluate(() => leaveTool());

function stlTris(file) {
  const b = fs.readFileSync(file);
  return b.readUInt32LE(80);
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log('\n=== 0. the registry is loaded, every tool has a session in it ===');
  const reg = await page.evaluate(() => ({ ok: typeof nsoHelpers === 'object', owners: nsoHelpers.owners() }));
  check('nsoHelpers is loaded ahead of the tools', reg.ok);
  const want = ['cut', 'crop', 'bend', 'tube-edge', 'bridge', 'foam', 'measure', 'brush', 'check', 'rotate', 'move',
                'face-pick', 'seat-grid', 'fence', 'inspect', 'gscope-support', 'lift-plate'];
  const missing = want.filter(w => reg.owners.indexOf(w) < 0);
  check('every helper-drawing tool registered its session', !missing.length, missing.length ? 'missing ' + missing.join(', ') : reg.owners.length + ' owners');
  check('a fresh page holds pieces and plate only', (await audit(page)).length === 0, (await audit(page)).join('; '));

  console.log('\n=== 1. open each tool, leave it: closed, and nothing of it left in the scene ===');
  const bendId = await loadSTL(page, BEND_TUBE);
  const tubeId = await loadSTL(page, STOCK_TUBE);
  await page.waitForTimeout(300);

  /* One tool, start to finish: open, see its helpers drawn and tagged, leave,
     see it closed and the scene clean. */
  async function tool(name, owner, piece, open, isLive) {
    if (piece != null) await selectPiece(page, piece);
    await open();
    await frames(page, 4);
    const d = (await drawn(page)).filter(h => h.owner === owner);
    check(name + ': its helper is drawn and tagged "' + owner + '"', d.length > 0,
          d.map(h => h.name + (h.interactive ? ' (dragged)' : '')).join(', ') || 'nothing drawn');
    const loud = d.filter(h => !h.interactive && !h.deaf);
    check(name + ': nothing it drew for show answers a ray', !loud.length, loud.map(h => h.name).join(', '));
    const left = await leave(page);
    await frames(page, 3);
    check(name + ': leave-tool closes it', !(await page.evaluate(isLive)), 'left: ' + JSON.stringify(left));
    const a = await audit(page);
    check(name + ': after the leave, pieces and plate only', a.length === 0, a.join('; '));
  }

  await tool('Cut', 'cut', tubeId, async () => {
    await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
    await page.waitForFunction(() => state.cutterOpen && state.cutHelper && state.cutHelper.parent, null, { timeout: 10000 });
  }, () => !!state.cutterOpen);

  await tool('Crop', 'crop', tubeId, async () => {
    await page.evaluate(() => { document.getElementById('menu-crop').open = true; });
    await page.waitForFunction(() => state.cutterOpen && state.cutTool === 'crop', null, { timeout: 10000 });
    await page.evaluate(() => updateCutterUI());
    await page.click('#btn-crop-shape-box');
    await page.waitForFunction(() => { const g = NSO_CropCard.state().group; return g && g.parent; }, null, { timeout: 10000 });
  }, () => !!state.cutterOpen);

  await tool('Bend', 'bend', bendId, async () => {
    await page.click('#btn-bend');
    await page.waitForFunction(() => state.bend && state.bend.open && state.bend.marker && state.bend.ghost, null, { timeout: 30000 });
  }, () => !!state.bend.open);

  await tool('Tube edge', 'tube-edge', tubeId, async () => {
    await page.click('#btn-tube-edge');
    await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.ring && state.tubeEdge.ghost, null, { timeout: 30000 });
  }, () => !!state.tubeEdge.open);

  await tool('Bridge', 'bridge', tubeId, async () => {
    await page.click('#btn-bridge');
    await page.waitForFunction(() => state.bridge && state.bridge.open, null, { timeout: 10000 });
    // A pending web as a drag would leave it: the line and the ghost, drawn
    // through Bridge's own two drawing calls.
    await page.evaluate(() => {
      const p = state.placed[state.selectedIndex];
      const s = meshToWorldSoup(p.mesh), up = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 3) { up[i] = s[i] + 30; up[i + 1] = -s[i + 2]; up[i + 2] = s[i + 1]; }
      NSO_bridgeSetGhost(up);
      NSO_bridgeDrawLine(p.mesh.position.clone(), p.mesh.position.clone().add(new THREE.Vector3(30, 0, 0)));
    });
  }, () => !!state.bridge.open);

  await tool('Measure', 'measure', tubeId, async () => {
    await page.click('#btn-measure');
    await page.waitForFunction(() => state.measureOn, null, { timeout: 5000 });
    for (const dx of [-8, 8]) {
      const s = await screenOf(page, await topPoint(page, dx));
      await page.mouse.move(s.x, s.y);
      await page.mouse.down();
      await page.mouse.up();
      await frames(page, 2);
    }
    await page.waitForFunction(() => !!window.nsoMeasureReadout(), null, { timeout: 5000 });
  }, () => !!state.measureOn);

  await tool('Check', 'check', tubeId, async () => {
    await page.click('#btn-check-defects');
    await page.waitForFunction(() => window.nsoDefectsShownFor() != null, null, { timeout: 30000 });
  }, () => window.nsoDefectsShownFor() != null);

  await tool('Rotate', 'rotate', tubeId, async () => {
    await page.evaluate(() => { document.getElementById('menu-rotate').open = true; });
    await page.waitForFunction(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return g && g.visible && g.children.length; },
      null, { timeout: 10000 });
  }, () => { const g = state.scene.getObjectByName('nso-rotate-handles'); return !!(g && g.visible); });

  await tool('Move', 'move', tubeId, async () => {
    await page.evaluate(() => { document.getElementById('menu-move').open = true; });
    await page.waitForFunction(() => window.nsoMoveVertical.arrowCount() > 0, null, { timeout: 10000 });
  }, () => !!document.getElementById('menu-move').open);

  await tool('Brush', 'brush', tubeId, async () => {
    await page.evaluate(() => window.nsoBrushSetArmed(true));
    const s = await screenOf(page, await topPoint(page, 0));
    await page.mouse.move(s.x - 3, s.y);
    await page.mouse.move(s.x, s.y);
    await frames(page, 3);
  }, () => window.nsoBrushArmed());

  await tool('Picked-face highlight', 'face-pick', tubeId, async () => {
    const s = await screenOf(page, await topPoint(page, 0));
    await page.evaluate(pt => {
      const r = state.renderer.domElement.getBoundingClientRect();
      state.pointer.set(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const h = state.raycaster.intersectObject(state.placed[state.selectedIndex].mesh, false)[0];
      showFaceHighlight(h);
    }, s);
  }, () => !!state.faceHelper);

  const cavId = await loadSTL(page, CAVITY);
  await page.waitForTimeout(300);
  await tool('Foam', 'foam', cavId, async () => {
    const r = await page.evaluate(() => window.nsoFoam.enter());
    if (!r.ok) throw new Error('Foam would not open: ' + JSON.stringify(r));
    await page.evaluate(() => { window.nsoFoam.fillAll(); });
  }, () => window.nsoFoam.on());

  /* G-scope: its own sheet and its own scene. Overhangs' beacons (the Features
     row's outlines left G-scope with the SELECT ticket), then G-scope shut and the
     plate's leave gesture. */
  for (const [name, owner, api, ready] of [
    ['G-scope Overhangs', 'gscope-support', 'NSO_GSCOPE_SUPPORT', () => NSO_GSCOPE_SUPPORT.isOn()]
  ]) {
    await selectPiece(page, cavId);
    await page.evaluate(() => NSO_MICROSCOPE.openPlate());
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc(), null, { timeout: 30000 });
    await page.evaluate(a => window[a].setOn(true), api);
    await page.waitForFunction(ready, null, { timeout: 30000 });
    await frames(page, 3);
    const d = (await drawn(page)).filter(h => h.owner === owner);
    check(name + ': its layer is in G-scope\'s scene, tagged "' + owner + '"', d.length > 0, d.map(h => h.name).join(', ') || 'nothing');
    await page.evaluate(() => NSO_MICROSCOPE.close());
    await leave(page);
    check(name + ': leave-tool switches it off', !(await page.evaluate(a => window[a].isOn(), api)));
    const a = await audit(page);
    check(name + ': nothing of it left in either scene', a.length === 0, a.join('; '));
  }

  console.log('\n=== 2. Clear, load a piece: pieces and plate only ===');
  await page.click('#btn-clear');
  await frames(page, 3);
  check('after Clear, the plate alone', (await audit(page)).length === 0, (await audit(page)).join('; '));
  const boxId = await loadSTL(page, BOX_CLOSED);
  await selectPiece(page, boxId);
  await frames(page, 6);
  const a2 = await audit(page);
  check('box_closed.stl loaded and selected: pieces and plate only', a2.length === 0, a2.join('; '));

  console.log('\n=== 3. repro (a): a Bend session on a tube, Clear, box_closed.stl ===');
  await page.click('#btn-clear');
  const t3 = await loadSTL(page, BEND_TUBE);
  await selectPiece(page, t3);
  await page.click('#btn-bend');
  await page.waitForFunction(() => state.bend.open && state.bend.marker && state.bend.marker.parent, null, { timeout: 30000 });
  check('Bend is open on the tube, its marker drawn', true);
  await page.click('#btn-clear');
  check('Clear closes Bend', !(await page.evaluate(() => state.bend.open)));
  const b3 = await loadSTL(page, BOX_CLOSED);
  await selectPiece(page, b3);
  await frames(page, 10);   // Bend's per-frame tick is what drew the sheet on the new piece
  const r3 = await page.evaluate(() => ({
    open: state.bend.open, marker: !!state.bend.marker, ghost: !!state.bend.ghost,
    sheets: (() => { let n = 0; state.scene.traverse(o => { if (o.name === 'bendMarker' || o.name === 'bendGhost') n++; }); return n; })()
  }));
  check('no Bend marker or ghost through the box', !r3.marker && !r3.ghost && r3.sheets === 0, JSON.stringify(r3));
  const a3 = await audit(page);
  check('the scene is the box and the plate', a3.length === 0, a3.join('; '));

  console.log('\n=== 4. export: pieces only; repro (b), the slab on the top face ===');
  await page.click('#btn-clear');
  const e1 = await loadSTL(page, BOX_CLOSED);
  const e2 = await loadSTL(page, STOCK_TUBE);
  await selectPiece(page, e2);
  // Helpers live while exporting: Check's marks on the tube, the Cut blade in modelGroup.
  await page.click('#btn-check-defects');
  await page.waitForFunction(() => window.nsoDefectsShownFor() != null, null, { timeout: 30000 });
  await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
  await page.waitForFunction(() => state.cutHelper && state.cutHelper.parent, null, { timeout: 10000 });
  const pieceTris = await page.evaluate(() => state.placed.reduce((n, p) => {
    const g = p.geometry; return n + (g.index ? g.index.count : g.attributes.position.count) / 3;
  }, 0));
  await page.selectOption('#export-format', 'stl');
  const exportPlate = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }),
      page.evaluate(() => { document.getElementById('btn-export-stl').disabled = false; exportPlate(); })]);
    const f = path.join(TMP, 'export-' + Date.now() + '.stl');
    await dl.saveAs(f);
    return stlTris(f);
  };
  const n4 = await exportPlate();
  check('Export plate STL, Cut blade and Check marks live: exactly the pieces\' triangles', n4 === pieceTris, n4 + ' vs ' + pieceTris);

  // The leak itself: a 1.5 mm, 12-triangle slab on the tube's top face, a
  // tagged helper, put on the plate list the way a helper written out as a
  // piece would have been.
  const slab = await page.evaluate(() => {
    const p = state.placed[state.selectedIndex];
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh), w = b.max.x - b.min.x, d = b.max.z - b.min.z;
    const geo = new THREE.BoxGeometry(w, 1.5, d);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.3 }));
    m.position.set((b.min.x + b.max.x) / 2, b.max.y + 0.75, (b.min.z + b.max.z) / 2);
    nsoHelpers.attach(state.modelGroup, m, 'cut');
    window.__leak = { mesh: m, geometry: geo, name: 'leaked slab', x: m.position.x, z: m.position.z,
                      width: w, depth: d, height: 1.5, liftY: b.max.y, rotY: 0, sourceId: null };
    state.placed.push(window.__leak);
    return { tris: geo.index.count / 3 };
  });
  check('the slab is 12 triangles', slab.tris === 12);
  const n4b = await exportPlate();
  check('repro (b): the STL leaves the slab out - the pieces\' triangles, not 12 more', n4b === pieceTris, n4b + ' vs ' + pieceTris);
  const mf = await page.evaluate(() => ({ objects: buildPlacedObjects3MF().length,
    pieces: (b => b[Object.keys(b)[0]].objects.length)(JSON.parse(buildPlateSceneJson())),
    real: state.placed.filter(p => p !== window.__leak).length }));
  check('...the 3MF objects too', mf.objects === mf.real, mf.objects + ' objects for ' + mf.real + ' pieces');
  check('...and the 3MF scene block', mf.pieces === mf.real, mf.pieces + ' scene pieces');
  await leave(page);
  const leakGone = await page.evaluate(() => !window.__leak.mesh.parent);
  check('leave-tool takes the slab out of the scene with the blade', leakGone);
  await page.evaluate(() => { state.placed = state.placed.filter(p => p !== window.__leak); reindexPlacedMeshes(); delete window.__leak; });
  const a4 = await audit(page);
  check('after the leave, pieces and plate only', a4.length === 0, a4.join('; '));

  console.log('\n=== 5. Undo past a helper\'s step ===');
  await page.click('#btn-clear');
  const u1 = await loadSTL(page, BEND_TUBE);
  await selectPiece(page, u1);
  await page.evaluate(() => nudgeSelected(2, 0));     // one step on the stack
  await page.click('#btn-bend');
  await page.waitForFunction(() => state.bend.open && state.bend.marker, null, { timeout: 30000 });
  const u2 = await page.evaluate(() => {
    window.__oldMarker = state.bend.marker;
    return { depth: state.undoStack.length, at: state.bend.marker.userData.nsoHelperDepth };
  });
  check('Bend\'s marker is stamped with the depth it was drawn at', u2.at === u2.depth, u2.at + ' / ' + u2.depth);
  await page.evaluate(() => undoLast());
  await frames(page, 4);
  const u3 = await page.evaluate(() => ({
    oldGone: !window.__oldMarker.parent, open: state.bend.open,
    fresh: !!(state.bend.marker && state.bend.marker.parent && state.bend.marker !== window.__oldMarker),
    stale: nsoHelpers.live().filter(o => (o.userData.nsoHelperDepth || 0) > state.undoStack.length).length
  }));
  check('the marker drawn after the undone step is gone', u3.oldGone);
  check('Bend stays open and draws it again from the piece as it now is', u3.open && u3.fresh, JSON.stringify(u3));
  check('no helper is left from past the top of the stack', u3.stale === 0, u3.stale + ' left');
  await leave(page);
  // A tool that redraws in place: Rotate's rails are one group, emptied and
  // filled again, so after the Undo the same group is still there - current,
  // not swept as if it were left over.
  await page.evaluate(() => nudgeSelected(2, 0));
  await page.evaluate(() => { document.getElementById('menu-rotate').open = true; });
  await page.waitForFunction(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return g && g.visible && g.children.length; },
    null, { timeout: 10000 });
  await page.evaluate(() => undoLast());
  await frames(page, 3);
  const u4 = await page.evaluate(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles');
    return { shown: !!(g && g.visible && g.children.length), at: g ? g.userData.nsoHelperDepth : null, depth: state.undoStack.length };
  });
  check('Rotate open across an Undo: its rails are still drawn, restamped', u4.shown && u4.at <= u4.depth, JSON.stringify(u4));
  await leave(page);
  await page.evaluate(() => nudgeSelected(2, 0));
  await page.click('#btn-check-defects');
  await page.waitForFunction(() => window.nsoDefectsShownFor() != null, null, { timeout: 30000 });
  await page.evaluate(() => undoLast());
  await frames(page, 2);
  check('an Undo past the Check takes its marks away', (await page.evaluate(() => window.nsoDefectsShownFor())) == null);
  const a5 = await audit(page);
  check('after the Undo, pieces and plate only', a5.length === 0, a5.join('; '));

  console.log('\n=== 6. Watch: never counts a helper, reports a stale one ===');
  await page.evaluate(() => NSOWatch.start());
  await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
  await page.waitForFunction(() => state.cutHelper && state.cutHelper.parent, null, { timeout: 10000 });
  const w1 = await page.evaluate(() => NSOWatch.check('cut open'));
  check('the Cut blade in modelGroup is not a piece to Watch', w1.length === 0, w1.map(e => e.msg).join(' | '));
  await leave(page);
  const w2 = await page.evaluate(() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshBasicMaterial());
    nsoHelpers.attach(state.scene, m, 'bend');     // Bend is closed: this is the leak
    window.__stale = m;
    return NSOWatch.check('stale helper');
  });
  check('a Bend helper on screen with Bend closed is a phantom', w2.some(e => /stale|still on screen/.test(e.msg)),
        w2.map(e => e.msg).join(' | ') || 'nothing reported');
  await leave(page);
  const w3 = await page.evaluate(() => ({ gone: !window.__stale.parent, found: NSOWatch.check('after leave') }));
  check('leave-tool takes it out, and Watch sees it clear', w3.gone && !w3.found.some(e => /still on screen/.test(e.msg)));
  await page.evaluate(() => NSOWatch.stop());

  // Watch writes its phantoms to the console as errors; section 6 made one on purpose.
  const errs = logs.filter(l => /\[pageerror\]|\[error\]/.test(l) && !/\[watch\d* /.test(l));
  check('no page errors on the way', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});

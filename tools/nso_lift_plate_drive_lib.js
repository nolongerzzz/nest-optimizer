/* Page helpers shared by the drive checks that work Lift on the plate (the
   Subtract card's LIFT, app-lift-plate.js): lift:plate, lift:drive, lift:auto-drive and
   lift:curved-drive. Node only; every function takes the Playwright page.

   Every hover and click goes to the main canvas as a real pointer event, at
   the screen point of a raw triangle as the app drew it (the display mesh is
   the raw soup's triangles in the same order). */
'use strict';

const path = require('path');

function makeCheck() {
  const st = { fails: 0, passes: 0, failed: [] };
  st.check = (name, cond, detail) => {
    console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
    if (cond) st.passes++; else { st.fails++; st.failed.push(name); }
  };
  return st;
}

/* The top-facing triangle nearest (x, y) whose centroid is in [zMin, zMax]. */
function rawTriNear(s, x, y, zMin, zMax) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    const nz = (s[o + 3] - s[o]) * (s[o + 7] - s[o + 1]) - (s[o + 4] - s[o + 1]) * (s[o + 6] - s[o]);
    if (nz <= 0) continue;
    const cz = (s[o + 2] + s[o + 5] + s[o + 8]) / 3;
    if (zMin != null && (cz < zMin || cz > zMax)) continue;
    const d = Math.hypot((s[o] + s[o + 3] + s[o + 6]) / 3 - x, (s[o + 1] + s[o + 4] + s[o + 7]) / 3 - y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

const status = page => page.evaluate(() => document.getElementById('status').textContent);
const readout = page => page.evaluate(() => document.getElementById('lift-readout').textContent);
const card = page => page.evaluate(() => ({
  armed: document.getElementById('btn-lift').getAttribute('aria-pressed') === 'true',
  count: document.getElementById('lift-count').textContent,
  panel: !document.getElementById('lift-panel').hidden,
  strip: !document.getElementById('lift-strip').hidden,
  stripDisabled: document.getElementById('btn-lift-strip').disabled,
  rows: Array.from(document.querySelectorAll('#lift-strip-rows .lift-strip-row')).map(l => ({ group: l.querySelector('input').getAttribute('data-group'), checked: l.querySelector('input').checked, text: l.textContent.trim() })),
  sum: document.getElementById('lift-strip-sum').textContent,
  go: document.getElementById('btn-lift-strip-go').textContent,
  slider: document.getElementById('lift-height').value
}));
const raw = (page, id) => page.evaluate(id => { const m = state.models.find(q => q.id === id); return m && m.rawTris ? Array.from(m.rawTris) : null; }, id);
const plateState = page => page.evaluate(() => ({
  models: state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : 0 })),
  placed: state.placed.map(p => ({ id: p.sourceId, x: p.x, z: p.z })),
  undo: state.undoStack.length
}));
/* The app's own view of a piece: closed?, volume, footprint, on the bed? */
const pieceInfo = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), p = state.placed.find(q => q && q.sourceId === id);
  if (!m) return null;
  const c = NSO_Lift.census(m.rawTris), fp = p ? placedFootprint(p) : null, plate = getCurrentPlate();
  const bb = p && p.mesh ? new THREE.Box3().setFromObject(p.mesh) : null;
  return { id, name: m.name, tris: c.tris, closed: c.closed, degen: c.degen, chi: c.chi, volume: NSO_Lift.volume(m.rawTris), fp,
           x: p && p.x, z: p && p.z, yMin: bb ? bb.min.y : null,
           onBed: fp ? (fp.minx >= -plate.w / 2 - 1e-6 && fp.maxx <= plate.w / 2 + 1e-6 && fp.minz >= -plate.d / 2 - 1e-6 && fp.maxz <= plate.d / 2 + 1e-6) : false };
}, id);
const overlaps = (a, b) => Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) > 0.01 && Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz) > 0.01;
const added = (before, after) => after.models.filter(m => !before.models.some(b => b.id === m.id));
const sameSoup = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const volumeOf = (page, soup) => page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), soup);

/* Look down on a piece from above and in front, the whole of it in view. */
async function frameOn(page, id, up) {
  await page.evaluate(([id, up]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y);
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + span * (up || 1.05), c.z + span * 0.45);
    state.controls.update();
  }, [id, up || 0]);
  await page.waitForTimeout(250);
}
/* The screen point of raw triangle `tri` of a piece, as drawn. */
const screenOfTri = (page, id, tri) => page.evaluate(([id, t]) => {
  const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  const c = new THREE.Vector3();
  for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]));
  c.multiplyScalar(1 / 3);
  p.mesh.updateMatrixWorld(true);
  c.applyMatrix4(p.mesh.matrixWorld);
  state.camera.updateMatrixWorld(true);
  const q = c.project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}, [id, tri]);
async function hoverTri(page, id, tri) {
  const at = await screenOfTri(page, id, tri);
  await page.mouse.move(at.x - 3, at.y - 3);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(150);
  return at;
}
async function clickTri(page, id, tri) {
  const at = await screenOfTri(page, id, tri);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}
async function ctrlZ(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
}
async function waitRead(page, re, ms) {
  await page.waitForFunction(src => new RegExp(src).test(document.getElementById('lift-readout').textContent), re.source, { timeout: ms || 120000 });
}
const selectRow = (page, id) => page.click('.model-item[data-edit-id="' + id + '"]');

/* Select the piece in the Pieces list and arm Lift on it (off first if it
   was on): the card's count once detection has run. */
async function armOn(page, id) {
  if (await page.evaluate(() => NSO_LIFT_PLATE.isArmed())) await page.click('#btn-lift');
  await selectRow(page, id);
  await page.click('#btn-lift');
  await page.waitForFunction(() => /(features?|shells) found|nothing read|—/.test(document.getElementById('lift-count').textContent), null, { timeout: 120000 });
  return (await card(page)).count;
}
async function disarm(page) {
  if (await page.evaluate(() => NSO_LIFT_PLATE.isArmed())) await page.click('#btn-lift');
}
/* Which feature raw triangle `tri` of the armed piece belongs to. */
const featureOf = (page, tri) => page.evaluate(t => NSO_LIFT_PLATE.analysis().islandOf[t], tri);
/* A top-facing triangle of feature `id`, the one highest along the view. */
const topTriOf = (page, id) => page.evaluate(id => {
  const A = NSO_LIFT_PLATE.analysis(), I = A.islands[id], M = A.M, n = A.map.n;
  let best = I.tris[0], bz = -Infinity;
  I.tris.forEach(t => {
    const c = [0, 1, 2].map(a => (M.V[M.tv[t * 3]][a] + M.V[M.tv[t * 3 + 1]][a] + M.V[M.tv[t * 3 + 2]][a]) / 3);
    const z = c[0] * n[0] + c[1] * n[1] + c[2] * n[2], nn = M.n[t * 3] * n[0] + M.n[t * 3 + 1] * n[1] + M.n[t * 3 + 2] * n[2];
    if (nn > 0.5 && z > bz) { bz = z; best = t; }
  });
  return best;
}, id);
async function setSlider(page, v) {
  await page.evaluate(v => { const s = document.getElementById('lift-height'); s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await page.waitForTimeout(100);
}
/* Strip with the given groups unticked, then Confirm. */
async function strip(page, untick) {
  await page.click('#btn-lift-strip');
  for (const g of untick || []) await page.click('#lift-strip-rows input[data-group="' + g + '"]');
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
}

/* G-scope on the plate. (Its Features row left G-scope with the SELECT ticket, docs/GSCOPE-SELECT.md.) */
async function openScopeOnPlate(page) {
  await page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
  await page.click('#btn-microscope');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
  if (await page.evaluate(() => !(NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate'))) await page.click('#ms-btn-plate');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate', null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
/* The screen point of a triangle as G-scope draws it, and a real click there. */
async function clickScopeTri(page, sourceId, tri) {
  const at = await page.evaluate(([sid, t]) => {
    const MS = NSO_MICROSCOPE, o = MS.getDoc().objects.find(x => x.sourceId === sid);
    const P = o.positions, c = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let q = 0; q < 3; q++) c[q] += P[t * 9 + k * 3 + q] / 3;
    const v = MS.getView();
    v.camera.updateMatrixWorld(true);
    const p = MS.toView(c[0], c[1], c[2]).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  }, [sourceId, tri]);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(200);
}
async function frameScope(page, sourceId, dist) {
  await page.evaluate(([sid, dist]) => {
    const MS = NSO_MICROSCOPE, o = MS.getDoc().objects.find(x => x.sourceId === sid);
    const b = o.bounds, v = MS.getView();
    const c = MS.toView((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ);
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    v.controls.target.copy(c);
    v.camera.position.set(c.x, c.y + span * (dist || 0.8), c.z + span * 0.75);
    v.controls.update();
  }, [sourceId, dist]);
  await page.waitForTimeout(250);
}

function shooter(OUT, KEEP, ROOT) {
  return {
    async plate(page, name) {
      await page.waitForTimeout(300);
      const file = path.join(OUT, name + '.png');
      await page.screenshot({ path: file });
      console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
    },
    async scope(page, name) {
      await page.evaluate(() => { NSO_MICROSCOPE.flushView(); });
      await page.waitForTimeout(400);
      const file = path.join(OUT, name + '.png');
      await page.screenshot({ path: file });
      console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
    }
  };
}

/* Take pieces off the plate and out of the list (between sections). */
const dropPieces = (page, ids) => page.evaluate(ids => {
  ids.forEach(id => { const i = state.placed.findIndex(p => p.sourceId === id); if (i >= 0) { state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1); } });
  state.models = state.models.filter(m => ids.indexOf(m.id) < 0);
  state.placed.forEach((p, k) => { p.mesh.userData.placedIndex = k; });
  state.selectedIndex = -1;
  renderModelList();
}, ids);

module.exports = {
  makeCheck, rawTriNear, status, readout, card, raw, plateState, pieceInfo, overlaps, added, sameSoup, volumeOf,
  frameOn, screenOfTri, hoverTri, clickTri, ctrlZ, waitRead, selectRow, armOn, disarm, featureOf, topTriOf, setSlider, strip,
  openScopeOnPlate, clickScopeTri, frameScope, shooter, dropPieces
};

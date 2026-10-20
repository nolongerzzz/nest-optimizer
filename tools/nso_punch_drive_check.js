#!/usr/bin/env node
/* Punch's card (app-punch.js), driven in the real page. docs/PUNCH.md.
     node tools/nso_punch_drive_check.js        exit 0 = every gate held

   A 60 x 60 x 6 slab, looked down on. Every press is a real mouse event on
   the canvas, every field a real fill, every button a real click.

     1. Punch arms; a click on the top face puts ONE ghost hole there, its axis
        the face's normal, through (6.4 mm)
     2. Grid 3 x 4, Centre -> 12 ghosts, none grey
     3. PUNCH -> one step on the Undo stack, the card still armed, and the piece
        has 12 through-holes: a ray down each hole's axis meets nothing, where
        before it met the top and the bottom
     4. one Undo puts the slab back: every ray meets the top and the bottom again
     5. a corner-anchored grid running off the slab: the overhanging holes drawn
        grey and counted in the readout
     6. the first hole's ring dragged out 1 mm -> Ø 3.0 becomes 5.0
     7. the far-corner hole dragged (3, 2) mm -> the pitch 8 becomes 9
     8. an arrow nudges the anchor 1 mm
     9. two holes 0.5 mm apart: the refusal in the readout with its numbers,
        PUNCH off, and PUNCH forced anyway cuts nothing
    10. Escape disarms; Carve armed over Punch puts Punch away; no page errors */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-punch-drive-'));

function boxSTL(name, lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const file = path.join(TMP, name), b = Buffer.alloc(84 + f.length * 50);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((x, c) => b.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + c * 4))));
  fs.writeFileSync(file, b);
  return file;
}

const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const S = page => page.evaluate(() => nsoPunchState());
const undoDepth = page => page.evaluate(() => state.undoStack.length);

/* Look down on the piece, a little tilted, its centre right of the open card. */
async function lookDown(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q && q.sourceId === m.id);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    state.controls.target.copy(c);
    state.camera.position.set(c.x + 4, c.y + 95, c.z + 45);
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    // pan the view sideways until the piece is clear of the open card
    const card = document.getElementById('punch-card'), menu = card && card.closest('.vp-menu-body');
    const r = menu && menu.getBoundingClientRect(), cv = state.renderer.domElement.getBoundingClientRect();
    if (r && r.width) {
      const at = () => { const v = new THREE.Vector3(b.min.x, c.y, c.z).project(state.camera); return cv.left + (v.x + 1) / 2 * cv.width; };
      for (let k = 0; k < 40 && at() < r.right + 40; k++) {
        const d = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-3);
        state.controls.target.add(d); state.camera.position.add(d); state.controls.update(); state.camera.updateMatrixWorld(true);
      }
    }
  });
  await frames(page, 2);
}
/* The screen point of a raw point on the selected piece. */
const screenOf = (page, raw) => page.evaluate(r => { const p = NSO_punchScreen(getActiveModel(), r); return { x: p.x, y: p.y }; }, raw);
const click = async (page, s) => {
  await page.mouse.move(s.x - 3, s.y - 3);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(150);
};
const drag = async (page, a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12);
  await page.mouse.up();
  await page.waitForTimeout(150);
};
const setField = async (page, sel, v) => {
  await page.fill(sel, String(v));
  await page.evaluate(s => document.querySelector(s).dispatchEvent(new Event('change', { bubbles: true })), sel);
};

/* A ray down each hole's axis, through the piece's raw soup: how many faces it meets. */
const raysThrough = (page, holes) => page.evaluate(hs => {
  const s = getActiveModel().rawTris;
  return hs.map(H => {
    const a = H.axis, o = [H.centre[0] + a[0] * 2, H.centre[1] + a[1] * 2, H.centre[2] + a[2] * 2], d = [-a[0], -a[1], -a[2]];
    let n = 0;
    for (let t = 0; t < s.length; t += 9) {
      const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const w = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], u = (w[0] * p[0] + w[1] * p[1] + w[2] * p[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (tt > 0 && tt < H.depth + 4) n++;
    }
    return n;
  });
}, holes);
const fingerprint = page => page.evaluate(() => { const s = getActiveModel().rawTris; let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a.toFixed(3); });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 880 });
  const id = await loadSTL(page, boxSTL('slab.stl', [0, 0, 0], [60, 60, 6]));
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p && p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  // the slab's raw frame: its top is z = 6 at the middle (30, 30)
  const top = await page.evaluate(() => { const s = getActiveModel().rawTris; let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < s.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], s[i + c]); hi[c] = Math.max(hi[c], s[i + c]); }
    return { lo, hi }; });
  const mid = [(top.lo[0] + top.hi[0]) / 2, (top.lo[1] + top.hi[1]) / 2, top.hi[2]];

  console.log('\n=== 1. arm, click a face -> one ghost ===');
  await page.click('#btn-punch');
  await page.waitForFunction(() => nsoPunchState().open, null, { timeout: 5000 });
  await lookDown(page);
  await click(page, await screenOf(page, mid));
  await page.waitForFunction(() => nsoPunchState().ghosts > 0, null, { timeout: 5000 }).catch(() => {});
  let st = await S(page);
  const ax = st.holes[0] ? st.holes[0].axis : [0, 0, 0];
  check('one ghost hole at the click', st.ghosts === 1 && st.holes.length === 1, 'ghosts ' + st.ghosts + ' · ' + st.readout);
  check('...normal to the face (+Z), through: 6.4 mm', Math.abs(ax[2] - 1) < 1e-6 && st.holes[0] && Math.abs(st.holes[0].depth - 6.4) < 1e-6 &&
    Math.abs(st.holes[0].centre[0] - mid[0]) < 0.6 && Math.abs(st.holes[0].centre[1] - mid[1]) < 0.6,
    'axis ' + ax.map(x => x.toFixed(3)) + ', centre ' + (st.holes[0] ? st.holes[0].centre.map(x => x.toFixed(2)) : '-'));

  console.log('\n=== 2. Grid 3 x 4 -> 12 ghosts ===');
  await page.click('#punch-pattern-row [data-pattern="grid"]');
  await setField(page, '#inp-punch-rows', 3);
  await setField(page, '#inp-punch-cols', 4);
  await setField(page, '#inp-punch-pitch', 8);
  await page.click('#punch-anchor-row [data-anchor="centre"]');
  await frames(page, 2);
  st = await S(page);
  check('12 ghosts, none grey', st.ghosts === 12 && st.dropped === 0 && st.ok, 'ghosts ' + st.ghosts + ', grey ' + st.dropped + ' · ' + st.readout);
  const holes12 = st.holes;
  const before = await raysThrough(page, holes12);
  check('before PUNCH a ray down each axis meets the top and the bottom', before.every(n => n === 2), before.join(','));

  console.log('\n=== 3. PUNCH ===');
  const d0 = await undoDepth(page), fp0 = await fingerprint(page);
  const go = await page.evaluate(() => !document.getElementById('btn-punch-go').disabled);
  await page.click('#btn-punch-go');
  await page.waitForFunction(d => state.undoStack.length > d && !nsoPunchState().busy, d0, { timeout: 60000 }).catch(() => {});
  st = await S(page);
  const after = await raysThrough(page, holes12);
  check('PUNCH was on, and made one step on the Undo stack', go && (await undoDepth(page)) === d0 + 1, await page.evaluate(() => document.getElementById('status').textContent));
  check('the piece has 12 through-holes (a ray down each axis meets nothing)', after.length === 12 && after.every(n => n === 0), after.join(','));
  check('the card stays armed for the next face', st.open && !st.hit && /Punched 12 holes/.test(st.readout), st.readout);
  const undoLabel = await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type);

  console.log('\n=== 4. one Undo ===');
  await page.click('#btn-undo');
  await frames(page, 3);
  const back = await raysThrough(page, holes12);
  check('one Undo restores the slab', (await undoDepth(page)) === d0 && back.every(n => n === 2) && (await fingerprint(page)) === fp0 && undoLabel === 'punchReplace',
    'rays ' + back.join(',') + ', undo type ' + undoLabel);

  console.log('\n=== 5. the overhang drawn grey and counted ===');
  await page.click('#punch-anchor-row [data-anchor="corner"]');
  await setField(page, '#inp-punch-cols', 5);
  await lookDown(page);
  await click(page, await screenOf(page, mid));
  await frames(page, 2);
  st = await S(page);
  check('5 columns from the middle at 8: the fifth (x + 32) is off - 3 grey, 12 kept, counted',
    st.ok && st.ghosts === 12 && st.dropped === 3 && /3 holes of 15 fall off the face/.test(st.readout), 'ghosts ' + st.ghosts + ', grey ' + st.dropped + ' · ' + st.readout);

  console.log('\n=== 6. the Ø handle ===');
  await page.click('#punch-pattern-row [data-pattern="none"]');
  await frames(page, 2);
  const a6 = await page.evaluate(() => nsoPunchHandleScreen('dia', 0)), b6 = await page.evaluate(() => nsoPunchHandleScreen('dia', 1));
  await drag(page, a6, b6);
  const dia = await page.evaluate(() => document.getElementById('inp-punch-dia').value);
  st = await S(page);
  check('dragging the first ring out 1 mm: Ø 3.0 -> 5.0, the ghost with it', dia === '5.0' && st.holes[0] && Math.abs(st.holes[0].dia - 5) < 1e-9,
    'field ' + dia + ', ghost Ø ' + (st.holes[0] && st.holes[0].dia));

  console.log('\n=== 7. the pitch handle ===');
  await setField(page, '#inp-punch-dia', '3.0');
  await page.click('#punch-pattern-row [data-pattern="grid"]');
  await setField(page, '#inp-punch-cols', 4);
  await frames(page, 2);
  const far = await page.evaluate(() => { const s = nsoPunchState(); return s.holes.find(h => h.n === 12); });
  const fr = await page.evaluate(() => state.punch.plan.frame);
  const a7 = await screenOf(page, far.centre);
  const b7 = await screenOf(page, [0, 1, 2].map(c => far.centre[c] + 3 * fr.u[c] + 2 * fr.v[c]));
  await drag(page, a7, b7);
  const pitch = await page.evaluate(() => document.getElementById('inp-punch-pitch').value);
  check('dragging the far corner (3, 2) mm: pitch 8.0 -> 9.0 ((3 x 3 + 2 x 2) / (9 + 4) more)', pitch === '9.0', 'pitch ' + pitch);

  console.log('\n=== 7b. the radius handle, the anchor handle ===');
  await page.click('#punch-pattern-row [data-pattern="radial"]');
  await setField(page, '#inp-punch-radius', 10);
  await frames(page, 2);
  const r1 = await page.evaluate(() => nsoPunchState().holes[0]);
  const fr2 = await page.evaluate(() => state.punch.plan.frame);
  await drag(page, await screenOf(page, r1.centre), await screenOf(page, [0, 1, 2].map(c => r1.centre[c] + 2 * fr2.u[c])));
  const rad = await page.evaluate(() => document.getElementById('inp-punch-radius').value);
  check('dragging a radial hole out 2 mm: radius 10.0 -> 12.0', rad === '12.0', 'radius ' + rad);
  const o7 = fr2.o;
  await drag(page, await screenOf(page, o7), await screenOf(page, [0, 1, 2].map(c => o7[c] + 4 * fr2.u[c] - 2 * fr2.v[c])));
  const o8 = await page.evaluate(() => state.punch.plan.frame.o);
  check('dragging the anchor (4, -2) mm moves the pattern there, on the face',
    Math.abs(o8[0] - o7[0] - 4 * fr2.u[0] + 2 * fr2.v[0]) < 1e-6 && Math.abs(o8[1] - o7[1] - 4 * fr2.u[1] + 2 * fr2.v[1]) < 1e-6 && Math.abs(o8[2] - o7[2]) < 1e-6,
    'from ' + o7.map(x => x.toFixed(2)) + ' to ' + o8.map(x => x.toFixed(2)));
  await page.click('#punch-pattern-row [data-pattern="grid"]');
  await frames(page, 2);

  console.log('\n=== 8. an arrow nudges the anchor ===');
  const h0 = (await S(page)).hit.point;
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('ArrowRight');
  await frames(page, 2);
  const h1 = (await S(page)).hit.point, moved = Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]);
  await page.keyboard.press('Shift+ArrowRight');
  await frames(page, 2);
  const h2 = (await S(page)).hit.point, fine = Math.hypot(h2[0] - h1[0], h2[1] - h1[1], h2[2] - h1[2]);
  check('ArrowRight moves the anchor 1 mm along the face, Shift 0.1', Math.abs(moved - 1) < 1e-6 && Math.abs(fine - 0.1) < 1e-6 && Math.abs(h1[2] - h0[2]) < 1e-6,
    moved.toFixed(4) + ' mm, ' + fine.toFixed(4) + ' mm');

  console.log('\n=== 9. a refusal, in words, and nothing cut ===');
  await setField(page, '#inp-punch-rows', 1);
  await setField(page, '#inp-punch-cols', 2);
  await setField(page, '#inp-punch-pitch', 3.5);
  await frames(page, 2);
  st = await S(page);
  const off = await page.evaluate(() => document.getElementById('btn-punch-go').disabled);
  check('the readout says it, with the numbers, in red; PUNCH is off',
    !st.ok && st.bad && /holes 1 and 2 would leave 0\.5 mm between them; the floor is 0\.8/.test(st.readout) && off, st.readout);
  const d9 = await undoDepth(page), fp9 = await fingerprint(page);
  const forced = await page.evaluate(() => NSO_punchGo());
  check('PUNCH forced anyway cuts nothing', !forced.ok && (await undoDepth(page)) === d9 && (await fingerprint(page)) === fp9, forced.reason);

  console.log('\n=== 10. Escape disarms ===');
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('Escape');
  await frames(page, 2);
  st = await S(page);
  const pressed = await page.evaluate(() => document.getElementById('btn-punch').getAttribute('aria-pressed'));
  check('Escape puts Punch away: no card, no ghost', !st.open && st.ghosts === 0 && pressed === 'false' &&
    await page.evaluate(() => document.getElementById('punch-card').hidden));
  await page.click('#btn-punch');
  await page.waitForFunction(() => nsoPunchState().open, null, { timeout: 5000 });
  await page.click('#btn-carve');
  await frames(page, 3);
  const carveOver = await page.evaluate(() => ({ punch: nsoPunchState().open, carve: !!state.carveArmed }));
  check('Carve armed over Punch puts Punch away (one click-owning tool at a time)', !carveOver.punch && carveOver.carve, JSON.stringify(carveOver));
  await page.click('#btn-carve');
  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});

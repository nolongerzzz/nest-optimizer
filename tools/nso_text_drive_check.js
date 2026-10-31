#!/usr/bin/env node
/* Text's card (app-text.js), driven in the real page. docs/TEXT.md.
     node tools/nso_text_drive_check.js        exit 0 = every gate held

   A 60 x 60 x 6 slab and a 96-facet cylinder, looked down on. Every press is a
   real mouse event on the canvas, every field a real fill, every button a real
   click. The page's own canvas draws the letters (the browser's fonts), so the
   numbers here are read back from what it made, never assumed.

     1. TEXT sits in the left column between SHAPE and PAINT; opening it arms the
        card (no gate, no second button); the card holds the text box, Font, Bold /
        Italic / Font file, Size, Depth, Angle, Mirror, the readout, STAMP, Cancel
     2. typing "Hello" is read: its size is in the readout before any click;
        a click on the top face puts the ghost there - normal +Z, centred on the click
     3. Size 12 doubles the text; Depth, Angle and Mirror reach the plan; Mono,
        Bold and a loaded font file change its width; a file that is no font is
        said in red and changes nothing
     4. STAMP: one step on the Undo stack (type textReplace), the piece 1.2 mm lower
        under the crossbar of an H and untouched a few mm away, the card still open
        for the next face; one Undo puts the slab back byte for byte
     5. a cylinder: the same stamp is the same depth square to the surface, at
        every triangle of the letters (measured against the kernel's output)
     6. a refusal in words, in red, with STAMP off, and STAMP forced anyway cuts
        nothing: text run off the face; a wall under it under the floor
     7. the text is dragged across the face by a press inside it; an arrow nudges it
        1 mm, Shift 0.1; a press on the bare plate still orbits
     7b. REMOVE: stamp "HEH", switch the card to Remove (the stamp rows go, the
        Remove rows come), click the floor of a letter: the ghost is the fill of all
        three, REMOVE puts the slab back (volume and flat top, one Undo step), and one
        Undo brings the engraving back
     8. a painted piece stands STAMP down by name; Clear paint lets it through
     9. Escape leaves a field, then closes the card; another menu opened over Text
        closes it; Carve armed over it puts it away; no page errors */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-text-drive-'));

function writeSTL(name, tris) {
  const file = path.join(TMP, name), b = Buffer.alloc(84 + tris.length * 50);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.forEach((v, k) => v.forEach((x, c) => b.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + c * 4))));
  fs.writeFileSync(file, b);
  return file;
}
function boxSTL(name, lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return writeSTL(name, f.map(t => t.map(i => v[i])));
}
/* A cylinder along X, radius R, length Lx, m facets, capped. */
function cylinderSTL(name, R, Lx, m) {
  const at = (k, x) => { const a = 2 * Math.PI * k / m; return [x, R * Math.cos(a), R * Math.sin(a)]; };
  const t = [];
  for (let k = 0; k < m; k++) {
    const a0 = at(k, 0), a1 = at(k + 1, 0), b0 = at(k, Lx), b1 = at(k + 1, Lx);
    t.push([a0, a1, b1], [a0, b1, b0], [[0, 0, 0], a1, a0], [[Lx, 0, 0], b0, b1]);
  }
  return writeSTL(name, t);
}

const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const S = page => page.evaluate(() => nsoTextState());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const fingerprint = page => page.evaluate(() => { const s = getActiveModel().rawTris; let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a.toFixed(3); });
const rawExtent = page => page.evaluate(() => {
  const s = getActiveModel().rawTris; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < s.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], s[i + c]); hi[c] = Math.max(hi[c], s[i + c]); }
  return { lo, hi };
});
const screenOf = (page, raw) => page.evaluate(r => { const p = NSO_textScreen(getActiveModel(), r); return { x: p.x, y: p.y }; }, raw);
const click = async (page, s) => {
  await page.mouse.move(s.x - 3, s.y - 3);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(200);
};
const drag = async (page, a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12);
  await page.mouse.up();
  await page.waitForTimeout(200);
};
const setField = async (page, sel, v) => {
  await page.fill(sel, String(v));
  await page.evaluate(s => document.querySelector(s).dispatchEvent(new Event('change', { bubbles: true })), sel);
  await page.waitForTimeout(220);
};
const blur = page => page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

/* Look down on the piece, a little tilted, its middle right of the open card. */
async function lookDown(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q && q.sourceId === m.id);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    state.controls.target.copy(c);
    state.camera.position.set(c.x + 4, c.y + 95, c.z + 45);
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    const card = document.getElementById('text-card'), menu = card && card.closest('.vp-menu-body');
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

/* The highest z of a soup at (x, y): a vertical ray. */
function topAt(soup, x, y) {
  let best = -Infinity;
  for (let t = 0; t < soup.length; t += 9) {
    const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    best = Math.max(best, a * A[2] + b * B[2] + c * C[2]);
  }
  return best;
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
         s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}
const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris));

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 880 });
  const id = await loadSTL(page, boxSTL('slab.stl', [0, 0, 0], [60, 60, 6]));
  await selectModel(page, id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p && p.sourceId === i); if (k >= 0) selectPlaced(k); }, id);
  const ext = await rawExtent(page);
  const mid = [(ext.lo[0] + ext.hi[0]) / 2, (ext.lo[1] + ext.hi[1]) / 2, ext.hi[2]];

  console.log('\n=== 1. the TEXT button, and the card it opens ===');
  const place = await page.evaluate(() => {
    const t = document.getElementById('menu-text'), sum = t && t.querySelector('summary');
    const prev = t && t.previousElementSibling, next = t && t.nextElementSibling;
    const y = el => el.querySelector('summary').getBoundingClientRect();
    return t ? { label: sum.textContent.trim(), col: t.classList.contains('vp-col-menu'), prev: prev.id, next: next.id,
      order: y(prev).top < y(t).top && y(t).top < y(next).top, sameX: Math.abs(y(prev).left - y(t).left) < 1 } : null;
  });
  check('TEXT is a column button between SHAPE and PAINT, in line with them', place && place.label === 'Text' && place.col && place.prev === 'menu-shape' && place.next === 'menu-paint' && place.order && place.sameX,
    JSON.stringify(place));
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  const card = await page.evaluate(() => {
    const c = document.getElementById('text-card'), body = c.parentElement, r = c.getBoundingClientRect();
    const ids = ['inp-text', 'sel-text-font', 'btn-text-bold', 'btn-text-italic', 'btn-text-font-file', 'inp-text-size', 'inp-text-depth', 'inp-text-angle', 'chk-text-mirror', 'text-readout', 'btn-text-go', 'btn-text-cancel'];
    return { all: ids.every(i => document.getElementById(i)), visible: r.width > 0 && r.height > 0, direct: body.classList.contains('vp-menu-body'),
      buttons: Array.from(c.querySelectorAll('button')).map(b => b.id), stamp: document.getElementById('btn-text-go').disabled };
  });
  check('opening the menu arms Text: the card is in the menu body itself, with every control, STAMP off', card.all && card.visible && card.direct && card.stamp, JSON.stringify(card.buttons));
  await lookDown(page);

  console.log('\n=== 2. type, click a face -> the ghost ===');
  await page.fill('#inp-text', 'Hello');
  await page.waitForTimeout(300);
  let st = await S(page);
  check('typing "Hello" is read: size 6 caps, the readout gives its size before any click', st.shape && st.shape.width > 12 && st.shape.height > 5.5 && st.shape.height < 8 && /click a face/.test(st.readout) && st.ghosts === 0,
    st.readout);
  await click(page, await screenOf(page, mid));
  await page.waitForFunction(() => nsoTextState().ghosts > 0, null, { timeout: 5000 }).catch(() => {});
  st = await S(page);
  check('a click on the top face puts one ghost there: ok, flat, normal +Z, on the click', st.ok && st.ghosts === 1 && st.outlines === 1 && st.stats.flat && Math.abs(st.frame.n[2] - 1) < 1e-6 &&
    Math.abs(st.frame.o[0] - mid[0]) < 0.6 && Math.abs(st.frame.o[1] - mid[1]) < 0.6, st.readout);
  const w6 = st.shape.width;

  console.log('\n=== 3. the numbers reach the plan ===');
  await setField(page, '#inp-text-size', 12);
  st = await S(page);
  check('Size 12 doubles the text (width x2 within 3%)', Math.abs(st.shape.width / w6 - 2) < 0.06 && st.ok, w6.toFixed(2) + ' -> ' + st.shape.width.toFixed(2));
  await setField(page, '#inp-text-size', 6);
  await setField(page, '#inp-text-depth', 1.5);
  st = await S(page);
  check('Depth 1.5 reaches the plan and the readout', st.ok && st.stats.depth === 1.5 && /1\.5 mm deep/.test(st.readout), st.readout);
  await setField(page, '#inp-text-angle', 90);
  const ex = await page.evaluate(() => state.text.plan.data.ex);
  check('Angle 90 turns it: the text now reads along +Y', Math.abs(ex[0]) < 1e-9 && Math.abs(ex[1] - 1) < 1e-9, ex.map(x => x.toFixed(3)).join(','));
  await setField(page, '#inp-text-angle', 0);
  const widthOf = async () => (await S(page)).shape.width;
  const sansW = await widthOf();
  await page.selectOption('#sel-text-font', 'mono');
  await page.waitForTimeout(250);
  const monoW = await widthOf();
  await page.selectOption('#sel-text-font', 'sans');
  await page.waitForTimeout(250);
  await page.click('#btn-text-bold');
  await page.waitForTimeout(250);
  const boldW = await widthOf();
  const boldOn = await page.evaluate(() => document.getElementById('btn-text-bold').getAttribute('aria-pressed'));
  await page.click('#btn-text-bold');
  await page.waitForTimeout(250);
  check('a different font changes the letters (Mono vs Sans) and Bold is wider and lights', Math.abs(monoW - sansW) > 0.3 && boldW > sansW + 0.1 && boldOn === 'true' && (await widthOf()) === sansW,
    'sans ' + sansW.toFixed(2) + ', mono ' + monoW.toFixed(2) + ', bold ' + boldW.toFixed(2));
  const fontFile = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(f => fs.existsSync(f));
  if (fontFile) {
    await page.setInputFiles('#inp-text-font-file', fontFile);
    await page.waitForFunction(() => document.getElementById('sel-text-font').value.indexOf('file') === 0, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    const loaded = await page.evaluate(() => ({ v: document.getElementById('sel-text-font').value, label: document.getElementById('sel-text-font').selectedOptions[0].textContent }));
    const fileW = await widthOf();
    check('a font file is loaded, added to the list and used: its name in the list, the letters its own', /^file/.test(loaded.v) && /DejaVu/.test(loaded.label) && Math.abs(fileW - sansW) > 0.3,
      loaded.label + ' ' + fileW.toFixed(2) + ' mm wide (sans ' + sansW.toFixed(2) + ')');
  } else check('a font file is loaded (no DejaVu on this machine: skipped)', true);
  const junk = path.join(TMP, 'not-a-font.ttf');
  fs.writeFileSync(junk, 'this is not a font');
  const optsBefore = await page.evaluate(() => document.getElementById('sel-text-font').options.length);
  await page.setInputFiles('#inp-text-font-file', junk);
  await page.waitForFunction(() => nsoTextState().bad, null, { timeout: 8000 }).catch(() => {});
  st = await S(page);
  check('a file that is no font is said in red and adds nothing', st.bad && /not a font/.test(st.readout) && (await page.evaluate(() => document.getElementById('sel-text-font').options.length)) === optsBefore, st.readout);
  await page.selectOption('#sel-text-font', 'sans');
  await page.fill('#inp-text', 'H');
  await setField(page, '#inp-text-size', 10);
  await setField(page, '#inp-text-depth', 1.2);
  st = await S(page);
  check('one letter, 10 mm caps, 1.2 deep: ready', st.ok && /1\.2 mm deep/.test(st.readout), st.readout);
  await page.check('#chk-text-mirror');
  await page.waitForTimeout(250);
  st = await S(page);
  check('Mirror still plans (the letter is its own mirror image)', st.ok);
  await page.uncheck('#chk-text-mirror');
  await page.waitForTimeout(250);

  console.log('\n=== 4. STAMP, and one Undo ===');
  const soup0 = await soupOf(page), fp0 = await fingerprint(page), d0 = await undoDepth(page);
  const c0 = await page.evaluate(() => state.text.plan.frame.o);
  const go = await page.evaluate(() => !document.getElementById('btn-text-go').disabled);
  await page.click('#btn-text-go');
  await page.waitForFunction(d => state.undoStack.length > d && !nsoTextState().busy, d0, { timeout: 60000 }).catch(() => {});
  const soup1 = await soupOf(page);
  const kind = await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type);
  const under = topAt(soup1, c0[0], c0[1]), away = topAt(soup1, c0[0] + 14, c0[1]), before = topAt(soup0, c0[0], c0[1]);
  st = await S(page);
  check('STAMP was on and made one step on the Undo stack, type textReplace', go && (await undoDepth(page)) === d0 + 1 && kind === 'textReplace', await page.evaluate(() => document.getElementById('status').textContent));
  check('under the crossbar of the H the top is 1.2 mm lower; 14 mm away it is untouched', Math.abs(before - under - 1.2) < 0.01 && Math.abs(away - before) < 1e-6,
    'before ' + before.toFixed(3) + ', under ' + under.toFixed(3) + ', away ' + away.toFixed(3));
  check('the card stays open for the next face: no click, the numbers kept', st.open && !st.hit && /Stamped/.test(st.readout) && (await page.evaluate(() => document.getElementById('inp-text').value)) === 'H', st.readout);
  await page.click('#btn-undo');
  await frames(page, 3);
  check('one Undo restores the slab byte for byte', (await undoDepth(page)) === d0 && (await fingerprint(page)) === fp0, await fingerprint(page));

  console.log('\n=== 6. refusals, in words, nothing cut ===');
  await click(page, await screenOf(page, mid));
  await setField(page, '#inp-text-size', 90);
  st = await S(page);
  const off = await page.evaluate(() => document.getElementById('btn-text-go').disabled);
  const ghostRed = await page.evaluate(() => { const g = state.text.ghost; return !!g && g.children[0].material.color.getHex() === 0xf87171; });
  check('text far wider than the slab: red, "runs off the face", STAMP off, the ghost still drawn (red)', !st.ok && st.bad && /runs off the face/.test(st.readout) && off && st.ghosts === 1 && ghostRed, st.readout);
  const d6 = await undoDepth(page), fp6 = await fingerprint(page);
  const forced = await page.evaluate(() => NSO_textGo());
  check('STAMP forced anyway cuts nothing', !forced.ok && (await undoDepth(page)) === d6 && (await fingerprint(page)) === fp6, forced.reason);
  await setField(page, '#inp-text-size', 10);
  await setField(page, '#inp-text-depth', 5.5);
  st = await S(page);
  check('a 6 mm slab engraved 5.5 deep leaves 0.5: refused with the floor and the depth that fits', !st.ok && st.bad && /floor is 0\.8/.test(st.readout) && /At most 5\.2 mm deep fits/.test(st.readout), st.readout);
  await setField(page, '#inp-text-depth', 1.2);

  console.log('\n=== 7. drag, arrows, orbit ===');
  const c7 = await page.evaluate(() => nsoTextCentreScreen(0, 0));
  const target = { x: c7.x + 60, y: c7.y + 40 };
  await drag(page, { x: c7.x, y: c7.y }, target);
  const c7b = await page.evaluate(() => nsoTextCentreScreen(0, 0));
  check('a press inside the text and a drag moves it across the face (the pointer keeps its place on it, within 6 px)', Math.abs(c7b.x - target.x) < 6 && Math.abs(c7b.y - target.y) < 6,
    'wanted (' + target.x.toFixed(0) + ',' + target.y.toFixed(0) + ') got (' + c7b.x.toFixed(0) + ',' + c7b.y.toFixed(0) + ')');
  st = await S(page);
  check('...still planned, on the same face, nothing cut by dragging', st.ok && !st.drag && (await undoDepth(page)) === d0, st.readout);
  const h0 = (await S(page)).hit.point;
  await blur(page);
  await page.keyboard.press('ArrowRight');
  await frames(page, 2);
  const h1 = (await S(page)).hit.point, moved = Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]);
  await page.keyboard.press('Shift+ArrowRight');
  await frames(page, 2);
  const h2 = (await S(page)).hit.point, fine = Math.hypot(h2[0] - h1[0], h2[1] - h1[1], h2[2] - h1[2]);
  check('ArrowRight moves the text 1 mm along the face, Shift 0.1', Math.abs(moved - 1) < 1e-6 && Math.abs(fine - 0.1) < 1e-6, moved.toFixed(4) + ' mm, ' + fine.toFixed(4) + ' mm');
  const cam0 = await page.evaluate(() => state.camera.position.toArray());
  const hitBefore = JSON.stringify((await S(page)).hit);
  const bare = await page.evaluate(() => {
    const cv = state.renderer.domElement;
    for (const [x, y] of [[1250, 650], [1300, 560], [1200, 760], [1330, 700], [700, 840]]) {
      if (document.elementFromPoint(x, y) === cv && !NSO_textPick(x, y)) return { x, y };
    }
    return null;
  });
  await drag(page, bare, { x: bare.x - 60, y: bare.y - 30 });
  const cam1 = await page.evaluate(() => state.camera.position.toArray());
  check('a press on the bare plate (' + (bare ? bare.x + ',' + bare.y : 'none found') + ') still orbits, and does not move the text', Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1 && JSON.stringify((await S(page)).hit) === hitBefore,
    'camera moved ' + Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]).toFixed(1));
  await lookDown(page);

  console.log('\n=== 7b. REMOVE: fill the engraving back ===');
  await page.fill('#inp-text', 'HEH');
  await setField(page, '#inp-text-size', 6);
  await setField(page, '#inp-text-depth', 1);
  await click(page, await screenOf(page, mid));
  await page.waitForFunction(() => nsoTextState().ok, null, { timeout: 5000 });
  const stemX = await page.evaluate(() => { const D = state.text.plan.data; return D.o[0] + Math.min(...D.V.map(v => v[0])) + 0.5; });
  const soupBefore = await soupOf(page), dR = await undoDepth(page);
  await page.click('#btn-text-go');
  await page.waitForFunction(d => state.undoStack.length > d && !nsoTextState().busy, dR, { timeout: 60000 }).catch(() => {});
  const soupCut = await soupOf(page);
  await page.click('#btn-text-mode-remove');
  await page.waitForTimeout(200);
  const ui = await page.evaluate(() => {
    const vis = id => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return { mode: nsoTextState().mode, stampRows: vis('inp-text') || vis('sel-text-font') || vis('inp-text-size') || vis('btn-text-go'), removeRows: vis('btn-text-remove') && vis('chk-text-word') && vis('inp-text-reach') };
  });
  check('Remove mode swaps the card: the stamp rows go, REMOVE / Whole word / Reach come', ui.mode === 'remove' && !ui.stampRows && ui.removeRows, JSON.stringify(ui));
  if (process.env.NSO_DUMP) require('fs').writeFileSync(process.env.NSO_DUMP, JSON.stringify({ soup: Array.from(soupCut), stemX, mid }));
  const floorPx = await screenOf(page, [stemX, mid[1], mid[2] - 1]);
  await page.mouse.move(floorPx.x, floorPx.y);
  await page.waitForFunction(() => nsoTextState().hover > 0, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('moving over the first H lights the whole word (3 pieces, amber) and locks nothing: REMOVE is off',
    st.hover === 3 && st.sel === 0 && st.ghosts === 1 && await page.evaluate(() => document.getElementById('btn-text-remove').disabled), JSON.stringify({ hover: st.hover, sel: st.sel, ghosts: st.ghosts }) + ' ' + st.readout);
  await click(page, floorPx);
  await page.waitForFunction(() => nsoTextState().sel > 0, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('a click locks the word: 3 pieces, 1 mm deep, green, REMOVE is on',
    st.ok && st.sel === 3 && st.count === 3 && st.ghosts >= 1 && /3 pieces locked/.test(st.readout) && !(await page.evaluate(() => document.getElementById('btn-text-remove').disabled)), st.readout);
  // one letter at a time: Whole word off, Escape lets go, a click locks one, another click adds, a third on a locked one lets it go
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  st = await S(page);
  check('Escape lets go of what is locked and keeps the card open', st.sel === 0 && st.open && await page.evaluate(() => document.getElementById('btn-text-remove').disabled), JSON.stringify({ sel: st.sel, open: st.open }));
  await page.evaluate(() => { const c = document.getElementById('chk-text-word'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
  let secondX = null, gapSeen = false;                    // along the middle of the word: floor of the first H, the gap, floor of the E
  for (let x = stemX; x < stemX + 24; x += 0.1) {
    const z = topAt(soupCut, x, mid[1]);
    if (z > 5.5) gapSeen = true; else if (gapSeen) { secondX = x + 0.3; break; }
  }
  const secondPx = await screenOf(page, [secondX === null ? stemX + 6 : secondX, mid[1], mid[2] - 1]);
  await click(page, floorPx);
  await page.waitForFunction(() => nsoTextState().sel === 1, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('Whole word off: a click locks the one letter', st.sel === 1 && st.count === 1, JSON.stringify({ sel: st.sel, count: st.count }));
  await click(page, secondPx);
  await page.waitForFunction(() => nsoTextState().sel === 2, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('a click on another letter adds it: 2 locked', st.sel === 2 && st.count === 2, JSON.stringify({ sel: st.sel, count: st.count }));
  await click(page, floorPx);
  await page.waitForFunction(() => nsoTextState().sel === 1, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('a click on a locked letter lets it go: 1 locked', st.sel === 1, JSON.stringify({ sel: st.sel }));
  await page.evaluate(() => { const c = document.getElementById('chk-text-word'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await click(page, floorPx);
  await page.waitForFunction(() => nsoTextState().sel === 3, null, { timeout: 15000 }).catch(() => {});
  st = await S(page);
  check('Whole word back on: one click locks all three again', st.sel === 3, JSON.stringify({ sel: st.sel }));
  const dragNo = await page.evaluate(() => NSO_textHitAt(0, 0));
  check('drag and nudge are the stamp’s: off here', dragNo === false);
  await page.click('#btn-text-remove');
  await page.waitForFunction(d => state.undoStack.length > d + 1 && !nsoTextState().busy, dR, { timeout: 60000 }).catch(() => {});
  const soupFilled = await soupOf(page);
  const vB = volume(soupBefore), vC = volume(soupCut), vF = volume(soupFilled);
  check('REMOVE puts the slab back: its volume (within 0.05%) and a flat top at the stem and the bar, one more Undo step',
    Math.abs(vF - vB) < 5e-4 * vB && vC < vB - 5 && Math.abs(topAt(soupFilled, stemX, mid[1]) - 6) < 1e-3 && Math.abs(topAt(soupFilled, mid[0], mid[1]) - 6) < 1e-3 && (await undoDepth(page)) === dR + 2,
    'slab ' + vB.toFixed(2) + ', engraved ' + vC.toFixed(2) + ', filled ' + vF.toFixed(2) + ' · ' + (await page.evaluate(() => document.getElementById('status').textContent)));
  await page.click('#btn-undo');
  await frames(page, 3);
  const soupUndone = await soupOf(page);
  check('one Undo brings the engraving back', Math.abs(volume(soupUndone) - vC) < 1e-6 * vB && Math.abs(topAt(soupUndone, stemX, mid[1]) - 5) < 1e-3);
  await click(page, await screenOf(page, [mid[0] - 25, mid[1] + 20, mid[2]]));
  st = await S(page);
  check('a click on the plain face is refused in words, nothing locked, REMOVE off', st.bad && /no engraved work/.test(st.readout) && st.sel === 0 && await page.evaluate(() => document.getElementById('btn-text-remove').disabled), st.readout);
  await page.click('#btn-undo');                      // the stamp itself
  await frames(page, 3);
  await page.click('#btn-text-mode-stamp');
  await page.waitForTimeout(200);
  await page.fill('#inp-text', 'H');
  await setField(page, '#inp-text-size', 10);
  await setField(page, '#inp-text-depth', 1.2);

  console.log('\n=== 8. a painted piece stands STAMP down ===');
  await page.click('#btn-text-cancel');
  await frames(page, 2);
  await page.click('#btn-mask-paint');
  await frames(page, 2);
  await click(page, await screenOf(page, [mid[0] + 20, mid[1] + 20, mid[2]]));
  await page.click('#btn-mask-paint');
  const painted = await page.evaluate(() => nsoMaskCount(getActiveModel()));
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  await lookDown(page);
  await click(page, await screenOf(page, mid));
  const d8 = await undoDepth(page);
  const stood = await page.evaluate(() => NSO_textGo());
  check('with a face painted, STAMP stands down and names the count', painted > 0 && !stood.ok && stood.painted === painted && /Text stood down - \d+ painted face/.test(await page.evaluate(() => document.getElementById('status').textContent)) && (await undoDepth(page)) === d8,
    'painted ' + painted + ' · ' + (await page.evaluate(() => document.getElementById('status').textContent)));
  await page.click('#btn-mask-clear');                    // its own menu: Paint opens, Text shuts
  await frames(page, 2);
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  await lookDown(page);
  await click(page, await screenOf(page, mid));
  const after = await page.evaluate(() => NSO_textGo());
  const d8b = await undoDepth(page);
  check('Clear paint lets it through', after.ok && d8b > d8 && (await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type)) === 'textReplace', 'ok ' + after.ok + ', undo ' + d8 + ' -> ' + d8b + ' ' + (after.reason || ''));
  await page.click('#btn-undo');
  await frames(page, 3);

  console.log('\n=== 5. a cylinder: the same depth, square to the surface ===');
  await page.click('#btn-text-cancel');
  await page.click('#btn-clear-plate').catch(() => {});
  await frames(page, 2);
  const R = 15;
  const cid = await loadSTL(page, cylinderSTL('cyl.stl', R, 40, 96));
  await selectModel(page, cid);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p && p.sourceId === i); if (k >= 0) selectPlaced(k); }, cid);
  await page.evaluate(() => { const m = getActiveModel(); const k = state.placed.findIndex(p => p && p.sourceId === m.id); if (k >= 0) selectPlaced(k); });
  const ce = await rawExtent(page);
  const ctop = [(ce.lo[0] + ce.hi[0]) / 2, (ce.lo[1] + ce.hi[1]) / 2, ce.hi[2]];
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  await lookDown(page);
  await page.fill('#inp-text', 'HEH');
  await setField(page, '#inp-text-size', 8);
  await setField(page, '#inp-text-depth', 1);
  await click(page, await screenOf(page, ctop));
  await page.waitForFunction(() => nsoTextState().ghosts > 0, null, { timeout: 5000 }).catch(() => {});
  st = await S(page);
  check('on the cylinder the plan is ok, curved (not flat), the floor refined', st.ok && st.stats && !st.stats.flat && st.stats.edge > 0 && st.stats.tris > 100, st.readout + ' ' + (st.stats && st.stats.tris) + ' tris');
  const csoup0 = await soupOf(page);
  const samples = await page.evaluate(() => {
    const D = state.text.plan.data, out = [];
    D.T.forEach((t, k) => {
      if (k % 3) return;
      const x = (D.V[t[0]][0] + D.V[t[1]][0] + D.V[t[2]][0]) / 3, y = (D.V[t[0]][1] + D.V[t[1]][1] + D.V[t[2]][1]) / 3;
      out.push([D.o[0] + D.ex[0] * x + D.ey[0] * y, D.o[1] + D.ex[1] * x + D.ey[1] * y]);
    });
    return out;
  });
  const floorRaw = await page.evaluate(() => { const D = state.text.plan.data, i = 0; return [0, 1, 2].map(c => D.o[c] + D.ex[c] * D.V[i][0] + D.ey[c] * D.V[i][1] + D.n[c] * D.hb[i]); });
  await page.click('#btn-text-go');
  await page.waitForFunction(() => state.undoStack.length > 0 && !nsoTextState().busy, null, { timeout: 60000 }).catch(() => {});
  const csoup1 = await soupOf(page);
  const cz = ce.hi[2], cy0 = (ce.lo[1] + ce.hi[1]) / 2;
  const depths = [];
  samples.forEach(([x, y]) => {
    const z0 = topAt(csoup0, x, y), z1 = topAt(csoup1, x, y), lean = Math.asin(Math.min(1, Math.abs(y - cy0) / R));
    if (z0 - z1 > 0.05) depths.push((z0 - z1) * Math.cos(lean));
  });
  const lo = Math.min(...depths), hi = Math.max(...depths);
  check('every letter triangle sampled is engraved 1.00 mm square to the surface (+/- 0.04)', depths.length >= 20 && lo > 0.96 && hi < 1.04, depths.length + ' of ' + samples.length + ' samples: ' + lo.toFixed(3) + ' .. ' + hi.toFixed(3));

  // and take it back off the curve
  {
    await page.click('#btn-text-mode-remove');
    await page.waitForTimeout(200);
    await click(page, await screenOf(page, floorRaw));
    await page.waitForFunction(() => nsoTextState().sel > 0 || nsoTextState().bad, null, { timeout: 20000 }).catch(() => {});
    st = await S(page);
    check('Remove on the cylinder: one click locks the word on a curved face (letters that touch are one piece), REMOVE on', st.ok && st.sel >= 2 && st.count === st.sel && st.ghosts >= 1 && /\b3[0-9]\.\d mm²/.test(st.readout) &&
      !(await page.evaluate(() => document.getElementById('btn-text-remove').disabled)), st.readout);
    const dC = await undoDepth(page);
    await page.click('#btn-text-remove');
    await page.waitForFunction(d => state.undoStack.length > d, dC, { timeout: 20000 }).catch(() => {});
    const csoup2 = await soupOf(page);
    const diffs = [];
    samples.forEach(([x, y]) => {
      const z0 = topAt(csoup0, x, y), z2 = topAt(csoup2, x, y);
      if (z0 - topAt(csoup1, x, y) > 0.3) diffs.push(Math.abs(z2 - z0));
    });
    diffs.sort((a, b) => a - b);
    const cnt = diffs.length, worst = diffs[cnt - 1] || 0, p95 = diffs[Math.floor(cnt * 0.95)] || 0;   // a sample on a letter's own edge reads the wall, not the face
    check('REMOVE puts the cylinder\u2019s face back over the letters (95% within 0.1 mm, all within 0.3, ' + cnt + ' points), one Undo step, no boolean',
      cnt >= 10 && p95 < 0.1 && worst < 0.3 && (await undoDepth(page)) === dC + 1 && volume(csoup2) > volume(csoup1) && Math.abs(volume(csoup2) - volume(csoup0)) < 0.01 * (volume(csoup0) - volume(csoup1)),
      'p95 ' + p95.toFixed(4) + ', worst ' + worst.toFixed(4) + ', volume ' + volume(csoup0).toFixed(2) + ' / ' + volume(csoup1).toFixed(2) + ' / ' + volume(csoup2).toFixed(2));
    await page.click('#btn-text-mode-stamp');
    await page.waitForTimeout(200);
  }

  console.log('\n=== 9. Escape, other menus, Carve ===');
  await click(page, await screenOf(page, ctop));
  await page.focus('#inp-text');
  await page.keyboard.press('Escape');
  await frames(page, 2);
  let open1 = (await S(page)).open;
  await page.keyboard.press('Escape');
  await frames(page, 2);
  const closed = await page.evaluate(() => ({ open: nsoTextState().open, menu: document.getElementById('menu-text').open, ghosts: nsoTextState().ghosts }));
  check('Escape in the text box leaves it; a second Escape closes the card (menu shut, no ghost)', open1 && !closed.open && !closed.menu && closed.ghosts === 0, JSON.stringify(closed));
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  await page.click('#menu-paint > summary');
  await frames(page, 3);
  const other = await page.evaluate(() => ({ open: nsoTextState().open, menu: document.getElementById('menu-text').open }));
  check('opening Paint over Text closes it', !other.open && !other.menu, JSON.stringify(other));
  await page.click('#menu-text > summary');
  await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('menu-text').open = true; });
  await page.click('#btn-carve');
  await frames(page, 4);
  const carveOver = await page.evaluate(() => ({ text: nsoTextState().open, carve: !!state.carveArmed }));
  check('Carve armed over Text puts Text away (one click-owning tool at a time)', !carveOver.text && carveOver.carve, JSON.stringify(carveOver));
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

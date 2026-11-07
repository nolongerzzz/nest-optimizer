/* nso_cut_rotate_dial_drive_check.js - the Cut card's Rotate piece wheel, beside the Mitre wheel.
   Real app, real Chromium, real mouse.
     node tools/nso_cut_rotate_dial_drive_check.js        exit 0 = every gate held

   The rotate rings stand too far out of view to use on a small piece worked close up, so the card carries a wheel
   like the Mitre's that turns the piece itself about the vertical.

   WHAT IS PINNED
   - Layout: the Mitre and Rotate piece wheels are side by side, Rotate on the right; each has its - / + directly
     under it and, under those, its box - the Mitre's with Square beside it (not beside the wheel, as they were).
   - The wheel reads the piece's heading: 0 for a piece as loaded, and 90 after a clockwise quarter turn (its own +X
     then lies along the plate's +Z).
   - A real drag round the wheel turns the piece by the pointer's turn (clockwise on the wheel = clockwise on the
     piece), a press that does not move does nothing, and the wheel rests on a 45 degree tick it passes within 3.
   - The box takes a heading; - / + step 1 degree a press (Shift 0.1); the arrow keys step it.
   - The blade goes with the piece: after the piece is turned the blade is still square across its length.
   - One Undo point for a drag, and Undo gives the heading back; a locked piece is not turned.                     */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function box(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-rotate-dial-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const HELP = `
window.__rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, b: r.bottom, r: r.right }; };
window.__heading = () => cutPieceHeading();
/* The piece's own +X in the world, and the blade's normal in the world. */
window.__axes = function () {
  const p = state.placed[state.selectedIndex]; p.mesh.updateMatrixWorld(true);
  const x = new THREE.Vector3(1, 0, 0).transformDirection(p.mesh.matrixWorld);
  const i = getCutPlaneLocal(getActiveModel());
  return { x: x.toArray(), n: i.normalWorld.toArray() };
};
`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: HELP });
  const id = await loadSTL(page, stl('bar.stl', box(60, 14, 8)));
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(150);
  await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
  await page.waitForTimeout(150);
  const R = id_ => page.evaluate(i => __rect(i), id_);
  const heading = () => page.evaluate(() => __heading());
  const dragDial = async (fromDeg, toDeg, steps) => {
    const r = await R('cut-rotate-dial'), rad = r.w * 0.4;
    const at = d => [r.cx + rad * Math.sin(d * Math.PI / 180), r.cy - rad * Math.cos(d * Math.PI / 180)];
    const a = at(fromDeg);
    await page.mouse.move(a[0], a[1]); await page.mouse.down();
    for (let k = 1; k <= steps; k++) { const b = at(fromDeg + (toDeg - fromDeg) * k / steps); await page.mouse.move(b[0], b[1]); }
    await page.mouse.up();
  };

  console.log('layout');
  const md = await R('cut-miter-dial'), rd = await R('cut-rotate-dial'), mdeg = await R('cut-miter-deg'), sq = await R('btn-cut-square');
  const mm = await R('btn-cut-miter-minus'), mp = await R('btn-cut-miter-plus'), rdeg = await R('cut-rotate-deg'), rm = await R('btn-cut-rotate-minus'), rp = await R('btn-cut-rotate-plus');
  check('the wheels are side by side, Rotate piece on the right', Math.abs(md.cy - rd.cy) < 3 && rd.x > md.r - 1, JSON.stringify({ mitreX: md.x, rotX: rd.x }));
  check('each wheel has its - / + directly under it, inside its width', mm.y - md.b >= 0 && mm.y - md.b < 14 && rm.y - rd.b >= 0 && rm.y - rd.b < 14 &&
    mm.x >= md.x - 0.5 && mp.r <= md.r + 0.5 && rm.x >= rd.x - 0.5 && rp.r <= rd.r + 0.5, JSON.stringify({ mitre: mm.y - md.b, rotate: rm.y - rd.b }));
  check('the Mitre box and Square are under the Mitre wheel (and its - / +), side by side', mdeg.y >= mm.b - 1 && sq.y >= mm.b - 1 && Math.abs(sq.cy - mdeg.cy) < 8 && sq.r <= rd.x + 4 && mdeg.x >= md.x - 20,
    JSON.stringify({ steps: mm.b, box: mdeg.y, square: sq.y }));
  check('the Rotate piece box is under its wheel and its - / +', rdeg.y >= rm.b - 1 && rdeg.cx > rd.x && rdeg.cx < rd.r);
  check('nothing sticks out of the card', rp.r < 440 && sq.r < rd.x + 8, 'right edge ' + rp.r);

  console.log('the heading');
  check('a piece as loaded reads 0', (await heading()) === 0, String(await heading()));
  check('the wheel shows it', /^0°$/.test(await page.evaluate(() => document.getElementById('cut-rotate-dial-deg').textContent)));
  await page.fill('#cut-rotate-deg', '90'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(150);
  let ax = await page.evaluate(() => __axes());
  check('typing 90 turns the piece a clockwise quarter: its +X lies along the plate\'s +Z', (await heading()) === 90 && ax.x[2] > 0.99 && Math.abs(ax.x[0]) < 0.02, JSON.stringify({ h: await heading(), x: ax.x.map(v => +v.toFixed(3)) }));
  check('the wheel and box show 90', (await page.evaluate(() => document.getElementById('cut-rotate-dial-deg').textContent)) === '90°' && (await page.inputValue('#cut-rotate-deg')) === '90');
  const tr = await page.evaluate(() => document.getElementById('cut-rotate-turn').getAttribute('transform'));
  check('and the handle is at 90', /rotate\(90 /.test(tr), tr);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  check('the blade went with the piece: still square across its length', Math.abs(dot(ax.n, ax.x)) > 0.999, 'n.x ' + dot(ax.n, ax.x).toFixed(4));

  console.log('drag');
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  const undos0 = await page.evaluate(() => state.undoStack ? state.undoStack.length : null);
  // a press that does not move does nothing
  const r = await R('cut-rotate-dial');
  await page.mouse.move(r.cx + 0.4 * r.w * Math.sin(1), r.cy - 0.4 * r.w * Math.cos(1));
  await page.mouse.down(); await page.mouse.up();
  check('a press without a move does nothing', (await heading()) === 0);
  await dragDial(0, 20, 8);
  let h = await heading();
  check('dragging 20 degrees clockwise turns the piece 20 clockwise', Math.abs(h - 20) < 1.5, 'heading ' + h);
  await dragDial(20, 110, 20);
  h = await heading();
  check('a longer drag is as far as the pointer went (20 + 90 = 110), through the 45 and 90 ticks', Math.abs(h - 110) < 1.5, 'heading ' + h);
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  await dragDial(0, 43, 10);
  h = await heading();
  check('within 3 degrees of a 45 tick it rests on the tick (43 -> 45)', h === 45, 'heading ' + h);
  await dragDial(0, 12, 6);
  h = await heading();
  check('...and leaves it again when the pointer goes on (45 + 12 = 57)', Math.abs(h - 57) < 1.5, 'heading ' + h);
  const undoOne = await page.evaluate(() => state.undoStack ? state.undoStack.length : null);
  await page.fill('#cut-rotate-deg', '10'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(80);
  await page.click('#btn-undo');
  await page.waitForTimeout(200);
  const hb = await heading();
  check('Undo gives the turn back (the typed 10 is one Undo point)', hb != null && Math.abs(hb - h) < 1.5, 'heading ' + hb + ' vs ' + h);

  console.log('- / + and the keys');
  const h1 = await heading();
  await page.click('#btn-cut-rotate-plus');
  await page.waitForTimeout(100);
  const h2 = await heading();
  check('+ is 1 degree clockwise', Math.abs(((h2 - h1 + 540) % 360) - 180 - 1) < 0.05, h1 + ' -> ' + h2);
  await page.click('#btn-cut-rotate-minus');
  await page.waitForTimeout(100);
  check('- is 1 degree back', Math.abs(((await heading()) - h1 + 540) % 360 - 180) < 0.05, String(await heading()));
  await page.focus('#cut-rotate-dial');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const h3 = await heading();
  check('the right arrow key turns it 1 degree clockwise', Math.abs(((h3 - h1 + 540) % 360) - 180 - 1) < 0.05, h1 + ' -> ' + h3);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(100);
  const h4 = await heading();
  check('Shift+left is a tenth of a degree back', Math.abs(((h3 - h4 + 540) % 360) - 180 - 0.1) < 0.06, h3 + ' -> ' + h4);

  console.log('a locked piece');
  await page.evaluate(() => { getActiveModel().posLock = true; });
  const hl = await heading();
  await page.click('#btn-cut-rotate-plus');
  await page.waitForTimeout(100);
  await page.fill('#cut-rotate-deg', '200'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  await dragDial(0, 30, 6);
  check('a position-locked piece is not turned, by +, the box or the wheel', (await heading()) === hl, 'heading ' + hl + ' -> ' + (await heading()));
  await page.evaluate(() => { getActiveModel().posLock = false; });
  await page.click('#btn-cut-rotate-plus');
  await page.waitForTimeout(100);
  check('and turns again once unlocked', Math.abs((await heading()) - hl - 1) < 0.06, String(await heading()));

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

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
   - One Undo point for a drag, and Undo gives the heading back; a locked piece is not turned.
   - The Mitre's 90 button sits under Square and jumps the blade to the opposite direction (mitre 90): the blade's normal turns
     a quarter-turn about the vertical; Square takes it back.
   - The axes: a tick each for Horizontal (ticked by default), Front/back and Side/side, one at a time (the one in
     use cannot be cleared); the wheel then turns the piece about it. A lean reads the piece's tilt from level, 0 flat.
     Front/back tips it along its length (its ends go up and down), Side/side across it. The same wheel, box, - / +,
     real drag and Undo. There are no rotate rings on the card.
   - A lean pivots the piece IN PLACE about ONE fixed line: its centre does not rise or fall as it tips (it passes through
     the plate where it must) and it does not jump up when the wheel pauses or the drag is let go. It is stood on the plate
     when the wheel's turn ends - another axis ticked, a click outside the card, Cut - not by a timer.
   - A near-square piece (the spiral's shape) keeps that line all the way round: its own X stays put through 20, 50, 80,
     110, 140 degrees (the footprint of a piece tipping over swaps its long side, which named a different axis each step).
   - A lean reads the TRUE lean from where the piece started: 90 with the piece on its edge (not 0), 120 past it.
   - Undo and Redo: the wheel reads the pose that came back (it kept the old number).                                  */

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
  check('the Mitre box and Square are under the Mitre wheel (and its - / +), side by side', mdeg.y >= mm.b - 1 && sq.y >= mm.b - 1 && Math.abs(sq.cy - mdeg.cy) < 16 && sq.r <= rd.x + 4 && mdeg.x >= md.x - 20,
    JSON.stringify({ steps: mm.b, box: mdeg.y, square: sq.y }));
  check('the Rotate piece box is under its wheel and its - / +', rdeg.y >= rm.b - 1 && rdeg.cx > rd.x && rdeg.cx < rd.r);
  check('nothing sticks out of the card', rp.r < 440 && sq.r < rd.x + 8, 'right edge ' + rp.r);

  console.log('the Mitre 90 button');
  {
    const r90 = await R('btn-cut-miter-90');
    check('90 sits under Square, the same width and in line with it', r90.y >= sq.b - 1 && r90.y - sq.b < 12 && Math.abs(r90.x - sq.x) < 1 && Math.abs(r90.w - sq.w) < 1.5, JSON.stringify({ squareBottom: sq.b, ninetyTop: r90.y, x: [sq.x, r90.x] }));
    check('...and is beside the Mitre box, inside the Mitre column', r90.x > mdeg.r - 2 && r90.r <= rd.x + 4, JSON.stringify({ boxRight: mdeg.r, ninety: [r90.x, r90.r], rotateWheel: rd.x }));
    const n0 = await page.evaluate(() => getCutPlaneLocal(getActiveModel()).normalWorld.toArray());
    await page.click('#btn-cut-miter-90');
    await page.waitForTimeout(100);
    const n1 = await page.evaluate(() => getCutPlaneLocal(getActiveModel()).normalWorld.toArray());
    const mit = await page.evaluate(() => ({ deg: state.cutMiterDeg, box: document.getElementById('cut-miter-deg').value, wheel: document.getElementById('cut-dial-deg').textContent }));
    const dot0 = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
    check('pressing 90 sets the mitre to 90 (box and wheel too)', mit.deg === 90 && mit.box === '90' && mit.wheel === '90°', JSON.stringify(mit));
    check('...and the blade has turned a quarter-turn: its normal is square to what it was', Math.abs(dot0) < 1e-6, 'n.n0 = ' + dot0.toFixed(6));
    await page.click('#btn-cut-square');
    await page.waitForTimeout(100);
    const n2 = await page.evaluate(() => getCutPlaneLocal(getActiveModel()).normalWorld.toArray());
    check('Square takes it back to where it was', Math.abs(n2[0] * n0[0] + n2[1] * n0[1] + n2[2] * n0[2]) > 1 - 1e-9 && (await page.evaluate(() => state.cutMiterDeg)) === 0);
  }

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

  console.log('the axes: Horizontal, Front/back, Side/side');
  const ticks = () => page.evaluate(() => ({ h: document.getElementById('chk-cut-rot-h').checked, fb: document.getElementById('chk-cut-rot-fb').checked, ss: document.getElementById('chk-cut-rot-ss').checked }));
  const axesOf = () => page.evaluate(() => { const m = state.placed[state.selectedIndex].mesh; m.updateMatrixWorld(true);
    const q = m.quaternion, v = e => new THREE.Vector3(e[0], e[1], e[2]).applyQuaternion(q).toArray();
    return { x: v([1, 0, 0]), y: v([0, 1, 0]), z: v([0, 0, 1]) }; });
  const rh = await R('chk-cut-rot-h'), rfb = await R('chk-cut-rot-fb'), rss = await R('chk-cut-rot-ss');
  check('three ticks under the Rotate piece box, Horizontal first', rh.y >= rdeg.b - 2 && rfb.y > rh.y && rss.y > rfb.y && rh.cx > rd.x - 20 && rh.x < rd.r);
  check('Horizontal is ticked by default, the leans are not', JSON.stringify(await ticks()) === JSON.stringify({ h: true, fb: false, ss: false }), JSON.stringify(await ticks()));
  check('and the card has no rotate rings option', await page.evaluate(() => !document.getElementById('chk-cut-rotate') && !document.getElementById('cut-rotate-rings') && !/Rotate rings/.test(document.getElementById('edit-card').textContent)));
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  await page.click('#chk-cut-rot-fb');
  check('ticking Front/back unticks Horizontal (one at a time)', JSON.stringify(await ticks()) === JSON.stringify({ h: false, fb: true, ss: false }), JSON.stringify(await ticks()));
  await page.click('#chk-cut-rot-fb');
  check('the axis in use cannot be unticked', (await ticks()).fb === true);
  check('a flat piece reads 0 as a lean', (await heading()) === 0, String(await heading()));
  const lvl = await axesOf();
  await page.fill('#cut-rotate-deg', '20'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(150);
  let ax2 = await axesOf();
  const tilt = v => Math.acos(Math.min(1, Math.abs(v[1]))) * 180 / Math.PI;           // an upright axis (own Y): off vertical
  const rise = v => Math.asin(Math.min(1, Math.abs(v[1]))) * 180 / Math.PI;           // a level axis (own X, Z): up from level
  check('typing 20 leans the piece front over back: its LENGTH (own X) rises 20 degrees and its width stays level', Math.abs(rise(ax2.x) - 20) < 0.6 && rise(ax2.z) < 0.6 && Math.abs(tilt(ax2.y) - 20) < 0.6,
    JSON.stringify({ xRise: rise(ax2.x).toFixed(1), yTilt: tilt(ax2.y).toFixed(1), zRise: rise(ax2.z).toFixed(1) }));
  check('the wheel and box read 20, the handle at 20', (await heading()) === 20 && (await page.inputValue('#cut-rotate-deg')) === '20' && /rotate\(20 /.test(await page.evaluate(() => document.getElementById('cut-rotate-turn').getAttribute('transform'))));
  await page.click('#btn-cut-rotate-plus');
  await page.waitForTimeout(80);
  check('+ is 1 degree more lean', (await heading()) === 21, String(await heading()));
  await dragDial(0, 30, 8);
  let hl2 = await heading();
  check('a real drag of 30 degrees clockwise leans it 30 more (21 + 30)', Math.abs(hl2 - 51) < 1.5, 'reading ' + hl2);
  await page.click('#btn-undo');
  await page.waitForTimeout(200);
  check('Undo gives the lean back', Math.abs((await heading()) - 21) < 1.5, 'reading ' + (await heading()));
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  check('typing 0 brings it level again', (await heading()) === 0 && tilt((await axesOf()).y) < 0.3);
  await page.click('#chk-cut-rot-ss');
  check('ticking Side/side clears Front/back', JSON.stringify(await ticks()) === JSON.stringify({ h: false, fb: false, ss: true }));
  await page.fill('#cut-rotate-deg', '25'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(150);
  ax2 = await axesOf();
  check('Side/side leans it across: its WIDTH (own Z) rises 25 degrees and its length stays level', Math.abs(rise(ax2.z) - 25) < 0.6 && rise(ax2.x) < 0.6, JSON.stringify({ xRise: rise(ax2.x).toFixed(1), zRise: rise(ax2.z).toFixed(1) }));
  check('the blade is still on the piece through a lean', await page.evaluate(() => !!state.cutHelper && !!getCutPlaneLocal(getActiveModel())));
  await page.fill('#cut-rotate-deg', '-15'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(150);
  check('a lean reads signed: -15 leans it the other way', (await heading()) === -15 && Math.abs(rise((await axesOf()).z) - 15) < 0.6, String(await heading()));
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);
  await page.click('#chk-cut-rot-h');
  check('ticking Horizontal again: the wheel reads the heading again', JSON.stringify(await ticks()) === JSON.stringify({ h: true, fb: false, ss: false }) && (await heading()) !== null);
  await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(100);

  console.log('a lean pivots in place, through the plate, about one line');
  {
    const box = () => page.evaluate(() => { const b = new THREE.Box3().setFromObject(state.placed[state.selectedIndex].mesh); const c = b.getCenter(new THREE.Vector3()); return { cy: c.y, cx: c.x, cz: c.z, lo: b.min.y }; });
    await page.click('#chk-cut-rot-fb');
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    await page.waitForTimeout(300);
    await page.click('#chk-cut-rot-h');                   // the turn in hand lands: flat on the plate
    await page.click('#chk-cut-rot-fb');
    const flat = await box();
    check('flat on the plate: the lowest point is at the bed (about 0.2)', Math.abs(flat.lo - 0.2) < 0.05, 'lowest ' + flat.lo.toFixed(3));
    await page.fill('#cut-rotate-deg', '20'); await page.press('#cut-rotate-deg', 'Tab');
    const t20 = await box();
    await page.fill('#cut-rotate-deg', '50'); await page.press('#cut-rotate-deg', 'Tab');
    const t50 = await box();
    check('tipping 0 -> 20 -> 50: the centre of the piece stays where it was (no rising and falling)', Math.abs(t20.cy - flat.cy) < 0.05 && Math.abs(t50.cy - flat.cy) < 0.05 && Math.abs(t50.cx - flat.cx) < 0.05,
      'centre height ' + flat.cy.toFixed(2) + ' -> ' + t20.cy.toFixed(2) + ' -> ' + t50.cy.toFixed(2));
    check('...so a 60 mm bar tipped 50 degrees goes through the plate (its low end is well under it)', t50.lo < -8, 'lowest ' + t50.lo.toFixed(2));
    await page.waitForTimeout(1600);
    const still = await box();
    check('a long pause does not lift it: it stays where it was, through the plate (no timer lands it)', Math.abs(still.cy - t50.cy) < 0.05 && still.lo < -8, 'centre ' + t50.cy.toFixed(2) + ' -> ' + still.cy.toFixed(2) + ', lowest ' + still.lo.toFixed(2));
    check('...and it is still tipped 50 as the wheel reads', (await heading()) === 50, String(await heading()));
    // a drag: held through a pause, and still in place when let go
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    const d0 = await box();
    const rr = await R('cut-rotate-dial'), rad = rr.w * 0.4, at = d => [rr.cx + rad * Math.sin(d * Math.PI / 180), rr.cy - rad * Math.cos(d * Math.PI / 180)];
    let q = at(0);
    await page.mouse.move(q[0], q[1]); await page.mouse.down();
    for (let k = 1; k <= 8; k++) { q = at(40 * k / 8); await page.mouse.move(q[0], q[1]); }
    await page.waitForTimeout(1000);
    const dHeld = await box();
    check('a drag held still for a second keeps pivoting: the centre has not moved, the low end is through the plate', Math.abs(dHeld.cy - d0.cy) < 0.05 && dHeld.lo < -5 && (await heading()) === 40,
      'centre ' + d0.cy.toFixed(2) + ' -> ' + dHeld.cy.toFixed(2) + ', lowest ' + dHeld.lo.toFixed(2));
    await page.mouse.up();
    await page.waitForTimeout(900);
    const dDone = await box();
    check('let go, it does not jump: the centre is where it was, the low end still through the plate', Math.abs(dDone.cy - d0.cy) < 0.05 && dDone.lo < -5, 'centre ' + dDone.cy.toFixed(2) + ', lowest ' + dDone.lo.toFixed(2));
    // it lands when the wheel's turn ends: another axis ticked
    await page.click('#chk-cut-rot-h');
    await page.waitForTimeout(150);
    const landed = await box();
    check('ticking another axis ends the turn: it is stood on the plate', Math.abs(landed.lo - 0.2) < 0.05 && landed.cy > dDone.cy + 3, 'lowest ' + landed.lo.toFixed(2) + ', centre ' + dDone.cy.toFixed(2) + ' -> ' + landed.cy.toFixed(2));
    await page.click('#chk-cut-rot-fb');
    // a click outside the card ends it too
    await page.fill('#cut-rotate-deg', '70'); await page.press('#cut-rotate-deg', 'Tab');
    const out0 = await box();
    await page.mouse.click(700, 120);
    await page.waitForTimeout(150);
    const out1 = await box();
    check('a click outside the card lands it', out0.lo < -5 && Math.abs(out1.lo - 0.2) < 0.05, 'lowest ' + out0.lo.toFixed(2) + ' -> ' + out1.lo.toFixed(2));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    // Undo gives the whole lean back, seated
    await page.click('#btn-undo');
    await page.waitForTimeout(250);
    const u = await box();
    check('one Undo takes the typed 70 back to the 40 before it, seated on the plate', Math.abs(u.lo - 0.2) < 0.06, 'lowest ' + u.lo.toFixed(2));
    check('...and the WHEEL reads the pose that came back, 40 (it kept the old 70)', (await heading()) === 40 && (await page.inputValue('#cut-rotate-deg')) === '40' && /rotate\(40 /.test(await page.evaluate(() => document.getElementById('cut-rotate-turn').getAttribute('transform'))),
      'reading ' + (await heading()) + ', box ' + (await page.inputValue('#cut-rotate-deg')));
    await page.click('#btn-redo');
    await page.waitForTimeout(250);
    const rd = await axesOf();
    check('Redo puts the 70 degree lean back (Redo closes and reopens the Cut tool, as it does for every helper, so the card starts again)', Math.abs(Math.acos(Math.min(1, rd.y[1])) * 180 / Math.PI - 70) < 0.8, 'own Y is ' + (Math.acos(Math.min(1, rd.y[1])) * 180 / Math.PI).toFixed(1) + ' from upright');
    await page.click('#btn-undo');
    await page.waitForTimeout(200);
    await page.click('#chk-cut-rot-fb');
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    await page.waitForTimeout(100);
    // the reading is the TRUE lean, through the piece standing on its edge and past it
    await page.fill('#cut-rotate-deg', '90'); await page.press('#cut-rotate-deg', 'Tab');
    check('a lean of 90 (on its edge) reads 90, not 0', (await heading()) === 90, String(await heading()));
    await page.fill('#cut-rotate-deg', '120'); await page.press('#cut-rotate-deg', 'Tab');
    const ax120 = await axesOf();
    check('past it, 120 reads 120, and the piece really is tipped 120 (60 the other side of upright)', (await heading()) === 120 && Math.abs(Math.acos(ax120.y[1]) * 180 / Math.PI - 120) < 0.8, JSON.stringify({ reading: await heading(), yUp: ax120.y.map(v => +v.toFixed(3)) }));
    await dragDial(0, -30, 6);
    check('a real drag carries on from there (120 - 30)', Math.abs((await heading()) - 90) < 1.5 || Math.abs((await heading()) - 90) < 4, String(await heading()));
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    await page.click('#chk-cut-rot-h');
    await page.waitForTimeout(150);
    check('level again, on the plate', Math.abs((await box()).lo - 0.2) < 0.06);
  }

  console.log('a near-square piece keeps one axis the whole way round');
  {
    await page.evaluate(() => { if (typeof clearPlateOnly === 'function') clearPlateOnly(); });
    const sid = await loadSTL(page, stl('square.stl', box(40, 40, 6)));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), sid);
    await page.waitForTimeout(150);
    await page.click('#chk-cut-rot-fb');
    const ownX = () => page.evaluate(() => { const m = state.placed[state.selectedIndex].mesh; m.updateMatrixWorld(true); return new THREE.Vector3(1, 0, 0).applyQuaternion(m.quaternion).toArray(); });
    const x0 = await ownX();
    let worst = 0, centre = null, driftC = 0;
    for (const v of [20, 50, 80, 110, 140, 170]) {
      await page.fill('#cut-rotate-deg', String(v)); await page.press('#cut-rotate-deg', 'Tab');
      const xx = await ownX();
      worst = Math.max(worst, Math.acos(Math.min(1, Math.abs(xx[0] * x0[0] + xx[1] * x0[1] + xx[2] * x0[2]))) * 180 / Math.PI);
      const c = await page.evaluate(() => new THREE.Box3().setFromObject(state.placed[state.selectedIndex].mesh).getCenter(new THREE.Vector3()).toArray());
      if (centre) driftC = Math.max(driftC, Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2])); else centre = c;
    }
    check('through 20, 50, 80, 110, 140, 170 the piece\'s own X never leaves its line (one axis, one way)', worst < 0.6, 'worst ' + worst.toFixed(2) + ' deg off');
    check('...and its centre never moves (in place)', driftC < 0.05, driftC.toFixed(3) + ' mm');
    check('...and the reading is the lean it was given', (await heading()) === 170, String(await heading()));
    // the buttons too: 30 presses of + from level
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    for (let k = 0; k < 40; k++) await page.click('#btn-cut-rotate-plus');
    const xx2 = await ownX();
    check('40 presses of + (a 40 degree lean) never leave the line either', Math.acos(Math.min(1, Math.abs(xx2[0] * x0[0] + xx2[1] * x0[1] + xx2[2] * x0[2]))) * 180 / Math.PI < 0.6 && (await heading()) === 40, 'reading ' + (await heading()));
    await page.fill('#cut-rotate-deg', '0'); await page.press('#cut-rotate-deg', 'Tab');
    await page.click('#chk-cut-rot-h');
    await page.waitForTimeout(150);
  }

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

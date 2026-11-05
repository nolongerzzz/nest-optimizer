/* The Cut card's Bevel dial, driven through the real app with a real mouse.
     node tools/nso_cut_bevel_test.js    exit 0 = every gate held

   THE ASK. The Cut card had one dial, Mitre (the blade turned in plan). A
   blade can also come up leaning off vertical - on a piece whose own frame is
   not the plate's (a bent-and-cut tube, a tipped piece) Mitre 0 draws a blade
   off plumb - and nothing on the card stood it up. Bevel is the mitre saw's
   second dial: the blade's lean off plumb, about its own horizontal line,
   -90..90, positive tipping the top of the blade toward the piece's far end.
   PLUMB sets the bevel that stands the blade vertical.

   GATES
     1. Bevel 0 is today's cut, byte for byte: square, and at a 30 degree
        mitre (against the mitre's own frame built the old way).
     2. Bevel 30 on a plain tube: Cut makes two closed halves whose cut faces
        are both 30 degrees off vertical, the mitre unchanged (the faces'
        heading is still along the tube), the top leaning toward the far
        end; and with Mitre 30 as well the heading is still 30.
     3. Bend 40 -> Cut -> Cut: PLUMB stands the blade vertical within 0.5
        degrees - on a quarter whose longest axis stands up (the blade lay
        flat: Plumb applies 90) and on a half tipped 20 degrees on the rings
        (the leaning blade of the shots) - and the readout shows the bevel it
        applied. The cut it makes is vertical too.
     4. The dial: a real drag rides the darts and sits on a painted tick
        inside 3 degrees of one; a click on a dart is 1 degree (Shift 0.1)
        and leaves the darts on their tick; the arrow keys, the box and the
        - / + buttons; clamped at 90; the readout says ", bevel N" after the
        mitre.
     5. The blade drag at a bevel still moves the blade along its own travel
        axis (#221), and the readout's two lengths add to that span.  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-bevel-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}
const circle = (cy, cz, r, n) => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [cy + r * Math.cos(a), cz + r * Math.sin(a)]; });
/* A round tube along raw X, outer radius 8, bore 6 (nso_bend_drive_check's). */
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
  return t.flat();
}

const PAGE = `
window.__idx = id => state.placed.findIndex(p => p && p.sourceId === id);
window.__pick = id => { selectPlaced(__idx(id)); return getActiveModel() && getActiveModel().id === id; };
/* The blade as it stands, world space: normal, centre, and its lean off
   plumb (0 = a vertical plane). */
window.__blade = function () {
  if (!state.cutHelper) return null;
  const b = state.cutHelper.children.find(c => c.userData.cutBlade);
  b.updateMatrixWorld(true);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(b.matrixWorld);
  return { n: n.toArray(), p: new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray(),
           offPlumb: Math.asin(Math.min(1, Math.abs(n.y))) * 180 / Math.PI, M: b.matrixWorld.toArray() };
};
/* A piece's triangles (display frame), as a flat array. */
window.__soup = function (m) {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  return Array.from(g.attributes.position.array);
};
/* The cut face of a half: its triangles whose normal lies within 2 degrees
   of the plane's normal n (either sense), in the piece frame turned by R
   (the pose the piece had). Their area-weighted normal, turned by R, and
   the area. */
window.__cutFace = function (m, nLocal, R) {
  const s = __soup(m), n = new THREE.Vector3().fromArray(nLocal);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), sum = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < s.length; i += 9) {
    a.set(s[i], s[i + 1], s[i + 2]); b.set(s[i + 3], s[i + 4], s[i + 5]); c.set(s[i + 6], s[i + 7], s[i + 8]);
    const f = b.clone().sub(a).cross(c.clone().sub(a)), A = f.length() / 2;
    if (!(A > 1e-9)) continue;
    f.normalize();
    if (Math.abs(f.dot(n)) < Math.cos(2 * Math.PI / 180)) continue;
    sum.addScaledVector(f, A);
    area += A;
  }
  const w = sum.normalize();
  if (R) w.applyQuaternion(new THREE.Quaternion().fromArray(R));
  return { n: w.toArray(), area: area };
};
window.__proj = function (p) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
};
/* Cut the active piece with the card's own button; the two new ids. */
window.__cut = function () {
  const before = state.models.map(m => m.id);
  document.getElementById('btn-cut').click();
  return state.models.filter(m => before.indexOf(m.id) < 0).map(m => m.id);
};
window.__dartsAt = () => Number(document.getElementById('cut-bevel-darts').dataset.at);
window.__readout = () => document.getElementById('cut-readout').textContent;
`;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const elev = n => Math.asin(Math.min(1, Math.abs(n[1]) / len(n))) * 180 / Math.PI;   // a normal's angle off horizontal
const heading = n => Math.atan2(-n[2], n[0]) * 180 / Math.PI;                           // in plan, from +X, anticlockwise from above

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const setField = async (id, v) => {
    await page.$eval('#' + id, (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change')); }, v);
    await page.waitForTimeout(20);
  };

  const tubeId = await loadSTL(page, stl('tube.stl', roundTube(120, 48)));
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(50);
  check('the card has the Bevel dial, its box, - / + and Plumb',
    await page.evaluate(() => ['cut-bevel-dial', 'cut-bevel-deg', 'btn-cut-bevel-minus', 'btn-cut-bevel-plus', 'btn-cut-plumb']
      .every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0; })));
  check('the tooltip states the sign', await page.evaluate(() =>
    /positive tips the top of the blade toward the piece's far end/i.test(document.getElementById('cut-bevel-deg').title)));

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. Bevel 0 is today\'s cut, byte for byte ===');
  const same = await page.evaluate(id => {
    __pick(id);
    const m = getActiveModel(), out = {};
    // Square: no frame at all, the old path.
    state.cutT = 0.4; setCutMiter(0); setCutBevel(0);
    let info = getCutPlaneForSplit(m);
    out.squareNoFrame = info.turn === null && info.frame === null;
    const a = cutSplitAt(m, info), b = splitBothSides(m, info.axis, info.plane, info.plane);
    out.square = __soup({ geometry: a.left }).join() === __soup({ geometry: b.left }).join() &&
                 __soup({ geometry: a.right }).join() === __soup({ geometry: b.right }).join();
    // Mitre 30, bevel 0, after a trip to bevel 30 and back: the mitre's own
    // matrices, built as they were before the bevel, and the same halves.
    setCutMiter(30); setCutBevel(30); setCutBevel(0);
    info = getCutPlaneForSplit(m);
    const mesh = cutMeshOf(m);
    mesh.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    const T = cutTurnMatrix(up, 30), Bk = cutTurnMatrix(up, -30);
    out.mitreFrame = info.turn.elements.join() === T.elements.join() && info.frame.elements.join() === Bk.elements.join();
    const old = Object.assign({}, info, { turn: T, frame: Bk });
    const c = cutSplitAt(m, info), d = cutSplitAt(m, old);
    out.mitre = (c.rawA ? Array.from(c.rawA).join() === Array.from(d.rawA).join() && Array.from(c.rawB).join() === Array.from(d.rawB).join()
                        : __soup({ geometry: c.left }).join() === __soup({ geometry: d.left }).join());
    setCutMiter(0);
    return out;
  }, tubeId);
  check('square, Bevel 0: no frame, the plain split', same.squareNoFrame && same.square);
  check('Mitre 30, Bevel 0 (after 30 and back): the mitre\'s own frame, bit for bit', same.mitreFrame);
  check('...and the same halves, byte for byte', same.mitre);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. Bevel 30 on a plain tube ===');
  for (const mitre of [0, 30]) {
    const r = await page.evaluate(([id, mitre]) => {
      __pick(id);
      state.cutT = 0.5; setCutMiter(mitre); setCutBevel(0);
      document.getElementById('cut-bevel-deg').value = '30';
      document.getElementById('cut-bevel-deg').dispatchEvent(new Event('change'));
      const info = getCutPlaneForSplit(getActiveModel());
      const n = new THREE.Vector3(info.axis === 'x' ? 1 : 0, info.axis === 'y' ? 1 : 0, info.axis === 'z' ? 1 : 0).applyMatrix4(info.frame);
      const bl = __blade(), m = getActiveModel(), mesh = cutMeshOf(m);
      // The blade's top and bottom, on the piece's centre line's vertical.
      const R = mesh.quaternion.toArray();
      const ids = __cut();
      const halves = ids.map(i => state.models.find(x => x.id === i));
      return { blade: bl, readout: __readout(), n: n.toArray(), ids: ids,
               faces: halves.map(h => __cutFace(h, n.toArray(), R)),
               topo: halves.map(h => NSO_bendTopology(h.rawTris || new Float32Array(__soup(h)))) };
    }, [tubeId, mitre]);
    const tag = 'Mitre ' + mitre + ', Bevel 30: ';
    check(tag + 'the blade is 30 off plumb (' + r.blade.offPlumb.toFixed(2) + ')', Math.abs(r.blade.offPlumb - 30) < 0.05);
    check(tag + 'readout says ", bevel 30°" after the mitre', (mitre ? /, mitre 30°, bevel 30°$/ : /\(X\), bevel 30°$/).test(r.readout), r.readout);
    check(tag + 'Cut made two closed halves', r.ids.length === 2 && r.topo.every(T => T.open === 0 && T.nm === 0 && T.flip === 0),
      r.topo.map(T => T.tris + ' tris, open ' + T.open).join(' | '));
    r.faces.forEach((f, i) => {
      check(tag + 'half ' + (i + 1) + '\'s cut face is 30 off vertical (' + elev(f.n).toFixed(2) + ' off horizontal, ' + f.area.toFixed(1) + ' mm²)',
        f.area > 50 && Math.abs(elev(f.n) - 30) < 0.1);
      // In plan the face still points along the tube turned by the mitre
      // (clockwise from above): the bevel did not turn it.
      const off = ((heading(f.n) + mitre) % 180 + 270) % 180 - 90;
      check(tag + 'half ' + (i + 1) + '\'s heading in plan is the mitre\'s (' + off.toFixed(3) + '° off)', Math.abs(off) < 0.1);
    });
    // Positive: the top toward the far end. The plane's normal points to the
    // far end; leaning the top that way tips the normal DOWN.
    check(tag + 'the top of the blade leans toward the far end (normal tips down: ' + r.n[1].toFixed(3) + ')', r.n[1] < -0.49);
    // Undo of a cut puts the tube back and puts the cutter away with it.
    await page.click('#btn-undo');
    await page.waitForTimeout(150);
    if (!(await page.evaluate(() => cutterArmed('cut')))) await page.click('#menu-cut > summary');
    await page.waitForTimeout(50);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Bend 40 -> Cut -> Cut: PLUMB ===');
  await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
  const bentId = await loadSTL(page, stl('tube2.stl', roundTube(120, 48)));
  const bend = await page.evaluate(id => { state.editId = id; return NSO_bendSelectedModel({ where: 60, angle: 40, toward: '+Z' }); }, bentId);
  check('Bend 40', bend.ok, bend.reason || '');
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(50);
  const halves = await page.evaluate(id => { __pick(id); state.cutT = 0.25; setCutMiter(0); setCutBevel(0); return __cut(); }, bentId);
  check('Cut: two halves', halves.length === 2);
  // The half that holds the bend: cut again; of its quarters, the one that
  // stands up has its longest axis vertical - the square blade lies flat.
  const pick = await page.evaluate(ids => {
    const tall = ids.map(i => state.models.find(m => m.id === i)).sort((a, b) => b.size.y - a.size.y)[0];
    // 0.7: clear of the bend's arc (a plane through the arc at 0.5 is
    // refused as inside-out, before this change as after it).
    __pick(tall.id); state.cutT = 0.7; syncCutUI(); updateCutHelper();
    const q = __cut();
    if (q.length !== 2) return { quarters: q, status: document.getElementById('status').textContent, armed: cutterArmed('cut'), helper: !!state.cutHelper, sel: getActiveModel() && getActiveModel().id, tall: tall.id };
    const all = q.map(i => { __pick(i); return { id: i, off: __blade().offPlumb, size: getActiveModel().size }; });
    const flat = all.slice().sort((a, b) => b.off - a.off)[0];
    return { tall: tall.id, short: ids.find(i => i !== tall.id), quarters: q, flat: flat, all: all };
  }, halves);
  check('Cut again: two quarters', pick.quarters.length === 2, pick.status ? JSON.stringify(pick) : '');
  check('a quarter\'s blade comes up off plumb (' + pick.flat.off.toFixed(1) + '°)', pick.flat.off > 30, JSON.stringify(pick.all));
  for (const which of ['flat', 'tipped']) {
    const r = await page.evaluate(async ([which, flatId, shortId]) => {
      const id = which === 'flat' ? flatId : shortId;
      __pick(id);
      setCutMiter(which === 'flat' ? 0 : 20);
      setCutBevel(0);
      if (which === 'tipped') {             // the shots: a piece on the rings, 20 degrees off its frame
        nsoRotate.turn('ss', 20);
        updateCutHelper();
      }
      const before = __blade().offPlumb;
      document.getElementById('btn-cut-plumb').click();
      const after = __blade();
      const m = getActiveModel(), mesh = cutMeshOf(m);
      mesh.updateMatrixWorld(true);
      const R = new THREE.Quaternion().setFromRotationMatrix(mesh.matrixWorld).toArray();
      const info = getCutPlaneForSplit(m);
      const n = new THREE.Vector3(info.axis === 'x' ? 1 : 0, info.axis === 'y' ? 1 : 0, info.axis === 'z' ? 1 : 0).applyMatrix4(info.frame);
      const out = { before: before, after: after.offPlumb, bevel: cutBevelDeg(), mitre: cutMiterDeg(), readout: __readout(),
                    status: document.getElementById('status').textContent, field: document.getElementById('cut-bevel-deg').value,
                    label: document.getElementById('btn-cut-plumb').textContent.trim() };
      const ids = __cut();
      out.faces = ids.map(i => __cutFace(state.models.find(x => x.id === i), n.toArray(), R));
      return out;
    }, [which, pick.flat.id, pick.short]);
    const tag = which === 'flat' ? 'the standing quarter: ' : 'the half tipped 20° on the rings, Mitre 20: ';
    check(tag + 'the blade came up ' + r.before.toFixed(2) + '° off plumb', r.before > 15);
    check(tag + 'PLUMB stands it vertical (' + r.after.toFixed(3) + '° off) with bevel ' + r.bevel + '°', r.after <= 0.5 && r.bevel !== 0);
    check(tag + 'the mitre is untouched (' + r.mitre + ')', r.mitre === (which === 'flat' ? 0 : 20));
    check(tag + 'the readout shows the bevel it applied', r.readout.indexOf(', bevel ' + r.bevel + '° (plumb)') >= 0 && r.field === String(r.bevel), r.readout);
    check(tag + 'the button reads Plumb, the status names the bevel', r.label === 'Plumb' && r.status.indexOf('bevel ' + r.bevel + '°') >= 0, r.status);
    check(tag + 'the cut faces it makes are vertical (' + r.faces.map(f => elev(f.n).toFixed(2)).join(', ') + '° off horizontal)',
      r.faces.length === 2 && r.faces.every(f => f.area > 10 && elev(f.n) < 0.5));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the dial ===');
  await page.evaluate(id => { __pick(id); state.cutT = 0.5; setCutMiter(0); setCutBevel(0); }, tubeId);
  await page.waitForTimeout(30);
  const dialBox = await page.evaluate(() => { const r = document.getElementById('cut-bevel-dial').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = dialBox.x + dialBox.w / 2, cy = dialBox.y + dialBox.h / 2, rr = dialBox.w * 0.4;
  const onRail = deg => ({ x: cx + rr * Math.sin(deg * Math.PI / 180), y: cy - rr * Math.cos(deg * Math.PI / 180) });
  const dragTo = async (from, to, steps) => {
    let p = onRail(from);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const seen = [];
    for (let i = 1; i <= steps; i++) {
      p = onRail(from + (to - from) * i / steps);
      await page.mouse.move(p.x, p.y);
      seen.push(await page.evaluate(() => ({ b: cutBevelDeg(), at: __dartsAt() })));
    }
    await page.mouse.up();
    return seen;
  };
  let seen = await dragTo(-20, 0, 20);
  check('a drag rides the darts with the bevel', seen.every(s => s.at === s.b) && seen[seen.length - 1].b > 15, JSON.stringify(seen.slice(-3)));
  const b20 = await page.evaluate(() => cutBevelDeg());
  check('a drag of 20° round the rail leans the blade 20 (' + b20 + ')', Math.abs(b20 - 20) <= 1);
  check('released, the darts seat on the nearest tick (0)', (await page.evaluate(() => __dartsAt())) === 0);
  await dragTo(-20, 22, 20);               // 20 + 42 = 62: no tick near
  const b62 = await page.evaluate(() => cutBevelDeg());
  check('away from a tick the bevel is where the pointer says (' + b62 + ')', Math.abs(b62 - 62) <= 1.5 && b62 !== 45);
  await dragTo(0, 43 - b62, 20);           // back to 43: inside 3 of 45
  const b45 = await page.evaluate(() => cutBevelDeg());
  check('inside 3° of a painted tick the bevel sits on it (45: ' + b45 + ')', b45 === 45);
  check('...and the darts seat there', (await page.evaluate(() => __dartsAt())) === 45);
  await dragTo(0, 80, 30);
  check('clamped at 90', (await page.evaluate(() => cutBevelDeg())) === 90);
  await page.evaluate(() => setCutBevel(40));
  const dart = async (dir, shift) => {
    const pt = await page.evaluate(dir => {
      const d = document.querySelector('#cut-bevel-darts [data-dir="' + dir + '"]').getBoundingClientRect();
      return { x: d.left + d.width / 2, y: d.top + d.height / 2 };
    }, dir);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(pt.x, pt.y);
    if (shift) await page.keyboard.up('Shift');
    return page.evaluate(() => ({ b: cutBevelDeg(), at: __dartsAt() }));
  };
  let s = await dart(1, false);
  check('a click on the + dart: 41, darts stay on 45', s.b === 41 && s.at === 45, JSON.stringify(s));
  s = await dart(-1, false);
  check('a click on the - dart: 40', s.b === 40, JSON.stringify(s));
  s = await dart(1, true);
  check('Shift-click: 40.1', s.b === 40.1, JSON.stringify(s));
  await page.focus('#cut-bevel-dial');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft: 39.1', (await page.evaluate(() => cutBevelDeg())) === 39.1);
  await page.keyboard.press('Shift+ArrowRight');
  check('Shift+ArrowRight: 39.2', (await page.evaluate(() => cutBevelDeg())) === 39.2);
  await page.click('#btn-cut-bevel-minus');
  check('the - button: 38.2', (await page.evaluate(() => cutBevelDeg())) === 38.2);
  await page.click('#btn-cut-bevel-plus', { modifiers: ['Shift'] });
  check('Shift on the + button: 38.3', (await page.evaluate(() => cutBevelDeg())) === 38.3);
  await setField('cut-bevel-deg', -125);
  check('typed -125: clamped to -90', (await page.evaluate(() => cutBevelDeg())) === -90);
  await setField('cut-bevel-deg', -12.5);
  await page.evaluate(() => setCutMiter(15));
  const ro = await page.evaluate(() => __readout());
  check('the readout: ", mitre 15°, bevel -12.5°"', /, mitre 15°, bevel -12\.5°$/.test(ro), ro);
  await setField('cut-bevel-deg', 0);
  check('Bevel 0: no bevel in the readout', !/bevel/.test(await page.evaluate(() => __readout())));

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the blade drag at a bevel ===');
  await page.evaluate(() => {
    setCutMiter(0); setCutBevel(30); state.cutT = 0.5; syncCutUI(); updateCutHelper();
    const c = state.camera, t = state.controls.target;
    c.position.set(t.x + 30, t.y + 60, t.z + 170); c.lookAt(t); state.controls.update();
  });
  await page.waitForTimeout(100);
  const b0 = await page.evaluate(() => __blade());
  const s0 = await page.evaluate(p => __proj(p), b0.p);
  const s1 = await page.evaluate(b => __proj([b.p[0] + b.n[0] * 10, b.p[1] + b.n[1] * 10, b.p[2] + b.n[2] * 10]), b0);
  const l = Math.hypot(s1.x - s0.x, s1.y - s0.y);
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(s0.x + (s1.x - s0.x) / l * 4 * i, s0.y + (s1.y - s0.y) / l * 4 * i);
  await page.mouse.up();
  const after = await page.evaluate(() => ({ b: __blade(), mm: getCutMm(), span: getCutSpan(getActiveModel()), readout: __readout() }));
  const d = sub(after.b.p, b0.p);
  check('the drag moved the blade along its own normal (' + dot(d, b0.n).toFixed(2) + ' of ' + len(d).toFixed(2) + ' mm)',
    len(d) > 1 && Math.abs(Math.abs(dot(d, b0.n)) - len(d)) < 0.02 * len(d));
  check('the bevel held (30)', (await page.evaluate(() => cutBevelDeg())) === 30);
  check('the readout\'s lengths add to the span along the leaned axis (' + after.span.toFixed(1) + ')',
    after.readout.indexOf(after.mm.toFixed(1) + ' mm | ' + (after.span - after.mm).toFixed(1) + ' mm') >= 0, after.readout);

  const errs = logs.filter(x => x.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

#!/usr/bin/env node
/* Bake on release: every pose action is COMPLETE when it ends.
     node tools/nso_pose_bake_release_test.js      exit 0 = every gate held

   The owner's rule (2026-10-21): the next action starts from a finished
   piece, so Rotate and Tip never fight over a half-applied pose. When a pose
   verb ends, app-core.js nsoBakePlacedPose writes the turn into the geometry
   (raw soup and display geometry together), puts the mesh back at identity
   and the pose fields at 0, re-seats the piece on its true lowest vertex and
   lets the frame every tool reads - pieceFrame (nso-bounds.js) - be measured
   again off the new vertices. One Undo per action, a geometry step.

   GATES, on a 40 x 20 x 10 box, for every verb - a Turn ring drag, the 90
   button, a lean dart click and a lean dart drag, a Rotate arrow key once
   its run settles, a Tilt button, Tip on side, Stand, Flip, Tip on face
   (through the function its armed click calls, on a real raycast hit), Tip X,
   Roll Z, Edge 180:
     1. released: the fields are 0 / 0 / 0, the mesh is at identity, the
        geometry was rewritten (a new geometry, its vertices moved in its own
        frame), its lowest vertex is at 0.2 + liftY;
     2. the bake moved no vertex in the world: what the verb showed is what
        is left (to Float32);
     3. the frame was measured again: pieceFrame says what the narrowest
        rectangle round the new vertices' shadow says, worked out here from
        every pair of vertices, not from the module;
     4. one Undo puts the previous mesh back BIT FOR BIT - the same geometry
        object and position array, the same raw soup, the same record and
        mesh position.
   Then a DIFFERENT verb after it acts about the level axes of the finished
   piece:
     5. Tip on side, then a lean dart: the lean is about a level line, no
        part of it about the vertical;
     6. Turn 45 (a drag, released), then Tip on side: it tips about the
        footprint's long side at 45 degrees and lands on a face;
     7. a lean, then Cut: the square blade is plumb - its normal level, along
        the footprint's long side - and Plumb has nothing to stand up.     */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function writeBoxSTL(file, x, y, z) {
  const V = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const F = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 50 * F.length);
  buf.writeUInt32LE(F.length, 80);
  F.forEach((t, i) => {
    const o = 84 + 50 * i, a = V[t[0]], b = V[t[1]], c = V[t[2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    [n[0] / l, n[1] / l, n[2] / l, ...a, ...b, ...c].forEach((v, k) => buf.writeFloatLE(v, o + 4 * k));
  });
  fs.writeFileSync(file, buf);
  return file;
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-pose-bake-release-'));
  await loadSTL(page, writeBoxSTL(path.join(DIR, 'box40x20x10.stl'), 40, 20, 10));
  await page.waitForTimeout(300);
  await page.evaluate(() => selectPlaced(0));

  await page.evaluate(() => {
    const H = window.__pb = {};
    H.p = () => state.placed[0];
    H.m = () => state.models.find(m => m.id === H.p().sourceId);
    H.home = () => {
      if (window.nsoRotate && nsoRotate.seat) nsoRotate.seat();
      nsoPoseHome(H.p());
      const c = H.p().mesh.position;
      state.controls.target.copy(c);
      state.camera.position.set(c.x + 140, c.y + 160, c.z + 200);
      state.controls.update(); state.camera.updateMatrixWorld(true);
      if (window.nsoRotate) nsoRotate.refresh();
    };
    H.world = () => {
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, out = [];
      for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld));
      return out;
    };
    /* the footprint, from every pair of vertices: the narrowest rectangle
       round their shadow has a side along one of those pairs */
    H.foot = () => {
      const w = H.world(), pts = w.map(v => [v.x, v.z]);
      let best = null;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j][0] - pts[i][0], dz = pts[j][1] - pts[i][1], l = Math.hypot(dx, dz);
        if (l < 1e-6) continue;
        const d = [dx / l, dz / l], n = [-d[1], d[0]];
        const ext = v => { const t = pts.map(q => q[0] * v[0] + q[1] * v[1]); return Math.max(...t) - Math.min(...t); };
        const ed = ext(d), en = ext(n);
        if (!best || ed * en < best.area - 1e-9) best = { area: ed * en, long: ed >= en ? d : n, L: Math.max(ed, en), S: Math.min(ed, en) };
      }
      return best;
    };
    H.state = () => {
      const p = H.p(), m = H.m(), pos = p.mesh.geometry.attributes.position;
      p.mesh.updateMatrixWorld(true);
      return { geo: p.mesh.geometry, arr: pos.array, raw: m.rawTris, meshPos: p.mesh.position.toArray(),
               fields: [p.rotY || 0, p.tipX || 0, p.tipZ || 0, p.tiltX || 0, p.tiltZ || 0, !!p.flipX, p.liftY || 0, p.x, p.z],
               q: p.mesh.quaternion.toArray() };
    };
    /* a dial drag through the module's own entry points; opts.atEnd is
       measured with the drag in hand, the turn still on the mesh */
    H.trace = (ring, screenDeg, atEnd) => {
      const a = nsoRotate, c = a.centreScreen(), R = 160;
      const at = d => ({ x: c.x + Math.cos(d * Math.PI / 180) * R, y: c.y + Math.sin(d * Math.PI / 180) * R });
      const p0 = at(0);
      if (!a.beginDrag({ ring: ring, dir: 1 }, p0.x, p0.y, c.x, c.y)) return null;
      const n = Math.round(Math.abs(screenDeg));
      for (let i = 1; i <= n; i++) { const q = at(Math.sign(screenDeg) * i); a.moveDrag(q.x, q.y); }
      const st = a.dragState(), mid = atEnd ? atEnd() : null;
      a.endDrag();
      return { applied: st.applied, atEnd: mid };
    };
    H.rel = (a, b) => {
      const d = b.clone().multiply(a.clone().invert());
      const s = Math.hypot(d.x, d.y, d.z);
      return { deg: 2 * Math.atan2(s, Math.abs(d.w)) * 180 / Math.PI, axis: s > 1e-12 ? [d.x / s, d.y / s, d.z / s] : [0, 0, 0] };
    };
  });
  const N = page.evaluate.bind(page);
  const openMenu = async id => {
    if (!(await N(i => document.getElementById(i).open, id))) { await page.click('#' + id + ' > summary'); await page.waitForTimeout(120); }
  };

  /* ------------------------------------------------------------ 1 - 4 */
  console.log('\n=== 1-4. every verb: released, baked, seated, framed, and one Undo back bit for bit ===');
  const VERBS = [
    ['Turn ring drag', async () => { await openMenu('menu-rotate');
      await N(() => __pb.trace('turn', nsoRotate.dialSign('turn') * 30, () => __pb.world())); }],
    ['90 button', async () => { await openMenu('menu-rotate'); await page.click('#btn-rot-right'); }],
    ['lean dart click', async () => { await openMenu('menu-rotate'); await N(() => nsoRotate.setRing('fb', true));
      const h = await N(() => nsoRotate.handleScreen('fb', 1)); await page.mouse.click(h.x, h.y);
      await page.waitForTimeout(nsoConstRun + 150); }],
    ['lean dart drag', async () => { await openMenu('menu-rotate'); await N(() => nsoRotate.setRing('ss', true));
      await N(() => __pb.trace('ss', nsoRotate.dialSign('ss') * 20)); }],
    ['Rotate arrow key, run settled', async () => { await openMenu('menu-rotate');
      await page.keyboard.press('ArrowRight');                // one press: one Undo point, as ever
      await page.waitForTimeout(nsoConstRun + 150); }],
    ['Tilt button', async () => { await openMenu('menu-tip'); await page.click('#btn-tilt-up'); }],
    ['Tip on side', async () => { await openMenu('menu-tip'); await page.click('#btn-flip'); }],
    ['Stand', async () => { await openMenu('menu-tip'); await page.click('#btn-tip'); }],
    ['Flip', async () => { await openMenu('menu-tip'); await page.click('#btn-flip-over'); }],
    ['Tip on face', async () => { await N(() => {
      const p = __pb.p(); p.mesh.updateMatrixWorld(true);
      const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
      const o = c.clone().add(new THREE.Vector3(60, 0, 0));
      const hit = new THREE.Raycaster(o, new THREE.Vector3(-1, 0, 0)).intersectObject(p.mesh, false)[0];
      return nsoTipOrient.tipOnFaceFromHit(hit);
    }); }],
    ['Tip X', async () => { await N(() => tipSelected()); }],
    ['Roll Z', async () => { await N(() => rollSelected()); }],
    ['Edge 180', async () => { await N(() => flipSelected()); }]
  ];
  const nsoConstRun = await N(() => nsoRotate.constants.RUN_MS);
  for (const [name, act] of VERBS) {
    await N(() => { __pb.home(); state.undoStack.length = 0; updateUndoBtn(); });
    const before = await N(() => { const s = __pb.state(); window.__before = s; return { fields: s.fields }; });
    await N(() => { window.__w0 = __pb.world(); });
    await act();
    await page.waitForTimeout(60);
    const r = await N(() => {
      const p = __pb.p(), b = window.__before, s = __pb.state();
      const w = __pb.world(), lowest = Math.min(...w.map(v => v.y));
      const f = pieceFrame(p), mine = __pb.foot();
      const frameOff = Math.min(Math.hypot(f.long.x - mine.long[0], f.long.z - mine.long[1]),
                                Math.hypot(f.long.x + mine.long[0], f.long.z + mine.long[1]));
      const local0 = Array.from(b.arr), local1 = Array.from(s.arr);
      const rewritten = s.geo !== b.geo && s.raw !== b.raw && local1.some((v, i) => Math.abs(v - local0[i]) > 1e-3);
      return { fields: s.fields.slice(0, 6), identity: s.q.join() === '0,0,0,1', rewritten,
               lowest, lift: p.liftY || 0, frameOff, lengths: [f.lengths.long - mine.L, f.lengths.short - mine.S],
               undoTop: state.undoStack.length ? state.undoStack[state.undoStack.length - 1].type : null,
               undoN: state.undoStack.length };
    });
    check(name + ': released - fields 0 / 0 / 0, mesh at identity', r.fields.every(v => v === 0 || v === false) && r.identity,
      JSON.stringify(r.fields));
    check(name + ': the turn is in the geometry - rewritten, its vertices moved in its own frame', r.rewritten);
    check(name + ': lowest vertex at 0.2 + liftY', Math.abs(r.lowest - 0.2 - r.lift) < 1e-6, r.lowest.toFixed(9));
    check(name + ': the frame is measured again off the new vertices', r.frameOff < 1e-6 &&
      r.lengths.every(d => Math.abs(d) < 1e-4), 'long off ' + r.frameOff.toExponential(1) + ', lengths ' + r.lengths.map(d => d.toExponential(1)).join(' '));
    check(name + ': one Undo step, a geometry step', r.undoTop === 'poseBake', r.undoN + ' step(s), top ' + r.undoTop);
    await page.click('#btn-undo');
    await page.waitForTimeout(60);
    const u = await N(() => {
      const b = window.__before, s = __pb.state();
      return { sameGeo: s.geo === b.geo, sameArr: s.arr === b.arr, sameRaw: s.raw === b.raw,
               meshPos: s.meshPos.every((v, i) => v === b.meshPos[i]), fields: JSON.stringify(s.fields) === JSON.stringify(b.fields),
               q: s.q.join() === '0,0,0,1' };
    });
    check(name + ': Undo restores the previous mesh bit for bit', u.sameGeo && u.sameArr && u.sameRaw && u.meshPos && u.fields && u.q,
      JSON.stringify(u));
  }

  /* the bake moves no vertex in the world: a drag measured in hand and after */
  {
    await N(() => { __pb.home(); });
    await openMenu('menu-rotate');
    const d = await N(() => {
      const tr = __pb.trace('turn', nsoRotate.dialSign('turn') * 37, () => __pb.world().map(v => v.clone()));
      const after = __pb.world();
      const dy = tr.atEnd.map((v, i) => after[i].y - v.y);
      const xz = Math.max(...tr.atEnd.map((v, i) => Math.hypot(after[i].x - v.x, after[i].z - v.z)));
      const spread = Math.max(...dy) - Math.min(...dy);
      return { xz, spread };
    });
    check('2. the bake moved no vertex: the released piece is what the drag showed (seated, one height for all)',
      d.xz < 1e-4 && d.spread < 1e-4, 'xz ' + d.xz.toExponential(1) + ' mm, height spread ' + d.spread.toExponential(1) + ' mm');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. Tip on side, then a lean dart: about a level line ===');
  for (const ring of ['fb', 'ss']) {
    await N(() => __pb.home());
    await openMenu('menu-tip'); await page.click('#btn-flip');
    await openMenu('menu-rotate');
    const r = await N(ring => {
      nsoRotate.setRing(ring, true); nsoRotate.refresh();
      const q0 = nsoPieceBodyQ(__pb.p());
      const tr = __pb.trace(ring, nsoRotate.dialSign(ring) * 10);
      const d = __pb.rel(q0, nsoPieceBodyQ(__pb.p()));
      return { applied: tr.applied, deg: d.deg, up: Math.abs(d.axis[1]) };
    }, ring);
    check('Tip on side, then the ' + ring + ' dart 10°: a lean about a level line, nothing about the vertical',
      Math.abs(Math.abs(r.applied) - 10) < 1e-6 && Math.abs(r.deg - 10) < 1e-6 && r.up < 1e-6,
      r.deg.toFixed(6) + '°, axis.up ' + r.up.toExponential(1));
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. Turn 45 (released), then Tip on side: about the footprint\'s 45° long side, onto a face ===');
  {
    await N(() => __pb.home());
    await openMenu('menu-rotate');
    await N(() => { nsoRotate.turn('turn', 45); nsoBakePlacedPose(__pb.p()); });
    const f0 = await N(() => { const f = pieceFrame(__pb.p()); return { long: f.long.toArray(), q: nsoPieceBodyQ(__pb.p()).toArray() }; });
    await openMenu('menu-tip'); await page.click('#btn-flip');
    const r = await N(f0 => {
      const p = __pb.p(), d = __pb.rel(new THREE.Quaternion().fromArray(f0.q), nsoPieceBodyQ(p));
      const L = new THREE.Vector3().fromArray(f0.long);
      return { deg: d.deg, along: Math.abs(new THREE.Vector3().fromArray(d.axis).dot(L)), h: p.height,
               heading: Math.atan2(-f0.long[2], f0.long[0]) * 180 / Math.PI };
    }, f0);
    check('the footprint\'s long side was at 45° after the released Turn', Math.abs(Math.abs(r.heading) - 45) < 1e-4, r.heading.toFixed(6) + '°');
    check('Tip on side turned it 90° about that side', Math.abs(r.deg - 90) < 1e-6 && Math.abs(r.along - 1) < 1e-6,
      r.deg.toFixed(6) + '°, |axis . long| ' + r.along.toFixed(9));
    check('...and it lies on a face, 20 tall - not balanced on an edge', Math.abs(r.h - 20) < 1e-4, r.h.toFixed(6));
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. a lean, then Cut: the square blade is plumb ===');
  {
    await N(() => __pb.home());
    await openMenu('menu-rotate');
    await N(() => { nsoRotate.setRing('ss', true); nsoRotate.refresh(); __pb.trace('ss', nsoRotate.dialSign('ss') * 12); });
    const leaned = await N(() => { const b = nsoPieceBodyQ(__pb.p()); return 2 * Math.acos(Math.min(1, Math.abs(b.w))) * 180 / Math.PI; });
    await N(() => { openCutter('cut'); selectPlaced(0); });
    const r = await N(() => {
      const m = __pb.m(), f = cutFrame(m), p = __pb.p();
      const n = f.normal.clone().transformDirection(p.mesh.matrixWorld);
      const L = pieceFrame(p).long;
      cutPlumb();
      return { up: Math.abs(n.y), along: Math.abs(n.dot(L)), bevel: cutBevelDeg(), mitre: cutMiterDeg() };
    });
    check('the piece is leaned (' + leaned.toFixed(3) + '°)', Math.abs(leaned - 12) < 1e-6);
    check('the square blade is plumb: its normal level, along the footprint\'s long side',
      r.up < 1e-9 && Math.abs(r.along - 1) < 1e-9, 'normal.up ' + r.up.toExponential(1) + ', |n . long| ' + r.along.toFixed(12));
    check('...and Plumb has nothing to stand up: bevel 0, mitre 0', r.bevel === 0 && r.mitre === 0, 'bevel ' + r.bevel + ', mitre ' + r.mitre);
    await N(() => closeCutter(true));
  }

  /* Seat (support) takes B as it lies - its baked tilt stays, its current
     underside lands - and its tooltip says so (tools/nso_seat_tilted_face_test.js
     measures the seat itself) */
  {
    const t = await N(() => document.getElementById('btn-seat-support').title);
    check('Seat (support)\'s tooltip says B is seated as it lies, its current underside landing',
      /seated as it lies/.test(t) && /current underside/.test(t) && /tilt or lean already on it stays/.test(t), t.slice(0, 160));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

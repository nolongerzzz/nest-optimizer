#!/usr/bin/env node
/* Rotate rings, driven in the real page.

   node tools/nso_rotate_handles_test.js        exit 0 = every gate held

   What is claimed, and so what is measured:

   1. HONEST MATH. A turn on a ring is a rotation about the PLATE's axis,
      whatever the piece is already doing: the mesh's quaternion after it is
      R(axis, d) * q0 to float precision, from any starting pose, and the
      quarter-turn counters (tipX, tipZ, flipX) are left the whole numbers
      they were. A flat piece yawed through 90 reads rotY 100, not the
      (180, 80, 180) THREE's own decomposition would give.
   2. LEAN, THEN TURN. A piece leaned 90 and then turned keeps every point at
      its height above the plate - the turn is about the vertical - where the
      old write to rotY moved them, because it turned about the leaned axis.
   3. DIRECTION FROM BOTH SIDES. For each ring, with the camera on one side
      and then the other: a clockwise circle traced on screen moves a point
      of the piece clockwise ON SCREEN by the same amount. Measured by
      projecting a point fixed to the piece, not by trusting the sign rule.
   4. CLICK = exactly 1 degree, never snapped. A real mouse click.
   5. A FULL LAP of a real mouse drag puts the piece back where it was, and
      the readout goes past 360.
   6. THE SNAP is hard and only hard: on a quarter turn inside 3 degrees of
      it, exactly where the pointer says everywhere else, one flash on
      landing.
   7. KEYS nudge 1 degree on the last-touched ring, only while Rotate owns the
      input.
   8. WHICH RINGS: Turn only on opening, boxes add rings, all three only with
      all three boxes, and closing Rotate puts it back to Turn only. Leaving
      the menu mid-drag ends the drag and empties the scene group.
   9. UNDO steps back one press at a time.
  10. THE 90 BUTTONS are untouched; the locks and the trackball are gone.
  11. THE RING BODY is the track, not a handle.
  12. EXPORT writes what the screen shows, leaned and turned.
  13. THE RADIUS is the bounding sphere's, so it holds through any turn on
      any shape, and is measured once per geometry.
  14. DRAGGING quiets the rails; release restores them.
  15. DEGREE MARKERS are fixed in the ring's frame; the snap lands on one.  */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => selectPlaced(0));
  await page.waitForTimeout(200);

  /* Page-side helpers, installed once. */
  await page.evaluate(() => {
    const H = window.__rot = {};
    H.p = () => state.placed[state.selectedIndex];
    H.zero = () => {
      const p = H.p();
      p.tipX = 0; p.tipZ = 0; p.flipX = false; p.tiltX = 0; p.tiltZ = 0; p.rotY = 0;
      applyMeshRotation(p);
      window.nsoRotate.refresh();
    };
    H.q = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.clone(); };
    /* The angle between two orientations, as 2 atan2(|v|, |w|) of b * a^-1 -
       acos of a dot product near 1 cannot see below ~3e-6 degrees. */
    H.angleDeg = (a, b) => {
      const d = b.clone().multiply(a.clone().invert());
      return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180 / Math.PI;
    };
    H.axisVec = ring => new THREE.Vector3().fromArray(window.nsoRotate.constants.AXES[ring]);
    H.camera = (offset) => {
      const c = H.p().mesh.position.clone();
      state.controls.target.copy(c);
      state.camera.position.copy(c).add(offset);
      state.camera.lookAt(c);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
      window.nsoRotate.refresh();
    };
    H.home = () => H.camera(new THREE.Vector3(140, 160, 200));
    H.screen = (w) => {
      const v = w.clone().project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height };
    };
    /* A dial traced through the module's own entry points, as app-core calls
       them: `screenDeg` degrees of screen angle about the projected centre,
       positive = clockwise on screen (y runs down). */
    H.trace = (ring, screenDeg, opts) => {
      opts = opts || {};
      const a = window.nsoRotate, c = a.centreScreen(), R = 160;
      const at = d => ({ x: c.x + Math.cos(d * Math.PI / 180) * R, y: c.y + Math.sin(d * Math.PI / 180) * R });
      const s0 = opts.start || 0;
      const p0 = at(s0);
      if (!a.beginDrag({ ring: ring, dir: 1 }, p0.x, p0.y, c.x, c.y)) return null;
      const seen = [];
      const n = Math.round(Math.abs(screenDeg) / (opts.step || 1));
      for (let i = 1; i <= n; i++) {
        const q = at(s0 + Math.sign(screenDeg) * i * (opts.step || 1));
        a.moveDrag(q.x, q.y);
        if (opts.each) seen.push(opts.each());
      }
      const st = a.dragState();
      a.endDrag();
      return { state: st, seen: seen };
    };
  });

  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the math: every turn is about the plate\'s axis, from any pose ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      let seed = 12345;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      let worst = 0, countsKept = true, n = 0;
      const rings = ['turn', 'fb', 'ss'];
      const poses = [];
      for (let i = 0; i < 240; i++) {
        poses.push({ tipX: Math.floor(rnd() * 4), tipZ: Math.floor(rnd() * 4), flipX: rnd() < 0.5,
                     tiltX: (rnd() - 0.5) * 360, tiltZ: (rnd() - 0.5) * 360,
                     rotY: (rnd() - 0.5) * 2 * Math.PI });
      }
      // The gimbal cases by hand: yaw exactly +/-90 is XYZ's singular pose.
      poses.push({ rotY: Math.PI / 2 }, { rotY: -Math.PI / 2 }, { rotY: Math.PI / 2, tiltX: 30 },
                 { rotY: -Math.PI / 2, tiltZ: 45, tipX: 1 }, { flipX: true, rotY: Math.PI / 2 });
      for (const f of poses) {
        for (const ring of rings) {
          Object.assign(p, { tipX: 0, tipZ: 0, flipX: false, tiltX: 0, tiltZ: 0, rotY: 0 }, f);
          applyMeshRotation(p);
          const q0 = H.q();
          const counts = [p.tipX, p.tipZ, p.flipX];
          const d = rnd() < 0.2 ? 1 : (rnd() - 0.5) * 400;
          a.turn(ring, d);
          const want = new THREE.Quaternion().setFromAxisAngle(H.axisVec(ring), d * Math.PI / 180).multiply(q0);
          worst = Math.max(worst, H.angleDeg(want, H.q()));
          if (p.tipX !== counts[0] || p.tipZ !== counts[1] || p.flipX !== counts[2]) countsKept = false;
          n++;
        }
      }
      /* Continuity: a flat piece walked round a whole turn a degree at a time. */
      H.zero();
      let off = 0, tiltsStill = true;
      for (let k = 1; k <= 400; k++) {
        a.turn('turn', 1);
        const want = ((k + 180) % 360 + 360) % 360 - 180;
        const got = p.rotY * 180 / Math.PI;
        off = Math.max(off, Math.abs(((got - want + 540) % 360) - 180));
        if (p.tiltX !== 0 || p.tiltZ !== 0) tiltsStill = false;
      }
      H.zero();
      a.turn('turn', 100);
      const at100 = { tiltX: p.tiltX, rotY: +(p.rotY * 180 / Math.PI).toFixed(9), tiltZ: p.tiltZ };
      H.zero();
      return { n, worst, countsKept, off, tiltsStill, at100 };
    });
    check(r.n + ' turns from random poses land on R(axis, d) * q0',
      r.worst < 1e-6, 'worst ' + r.worst.toExponential(2) + '°');
    check('...and tipX / tipZ / flipX are never touched - they stay whole quarter-turn counts',
      r.countsKept);
    check('a flat piece walked round 400° a degree at a time: rotY tracks it, tilts stay 0',
      r.off < 1e-6 && r.tiltsStill, 'max off ' + r.off.toExponential(2) + '°');
    check('yawed to 100°, the record reads (0, 100, 0), not THREE\'s (180, 80, 180)',
      r.at100.tiltX === 0 && near(r.at100.rotY, 100, 1e-9) && r.at100.tiltZ === 0,
      JSON.stringify(r.at100));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. lean 90, then Turn: about the plate\'s vertical, not the piece\'s tilted axis ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      H.zero(); H.home();
      a.setRing('fb', true);
      a.turn('fb', 90);
      p.mesh.updateMatrixWorld(true);
      const corners = [];
      const bb = p.mesh.geometry.boundingBox || (p.mesh.geometry.computeBoundingBox(), p.mesh.geometry.boundingBox);
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y])
        for (const z of [bb.min.z, bb.max.z]) corners.push(new THREE.Vector3(x, y, z));
      corners.push(new THREE.Vector3(bb.max.x, 0.3 * bb.max.y, 0.7 * bb.min.z));   // an off-centre point
      const world = () => corners.map(c => p.mesh.localToWorld(c.clone()).sub(p.mesh.position));
      const before = world();
      const fields0 = { tiltX: p.tiltX, rotY: p.rotY, tiltZ: p.tiltZ };
      const tr = H.trace('turn', 30);
      const after = world();
      const dy = Math.max(...before.map((b, i) => Math.abs(b.y - after[i].y)));
      const dxz = Math.max(...before.map((b, i) => Math.hypot(b.x - after[i].x, b.z - after[i].z)));
      // The turn's own axis, read off the motion: q1 * q0^-1.
      // The old behaviour, for contrast: the same 30 written to rotY.
      const q1 = H.q();
      Object.assign(p, fields0); applyMeshRotation(p);
      const keep = world();
      p.rotY = fields0.rotY + tr.state.applied * Math.PI / 180; applyMeshRotation(p);
      const old = world();
      const oldDy = Math.max(...keep.map((b, i) => Math.abs(b.y - old[i].y)));
      Object.assign(p, fields0); applyMeshRotation(p);
      a.setRing('fb', false);
      H.zero();
      return { turned: tr.state.applied, dy, dxz, oldDy };
    });
    check('the drag turned the leaned piece', Math.abs(r.turned) > 20, r.turned.toFixed(2) + '°');
    check('every point keeps its height: the turn is about the plate\'s vertical',
      r.dy < 1e-6, 'max height change ' + r.dy.toExponential(2) + ' mm');
    check('...and it really moved round', r.dxz > 1, r.dxz.toFixed(2) + ' mm');
    check('the old write to rotY would have turned it about the LEANED axis - heights change',
      r.oldDy > 1, r.oldDy.toFixed(2) + ' mm');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. direction: clockwise on screen is clockwise on the piece, from BOTH sides of every ring ===');
  {
    const rows = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      const out = [];
      const sides = {
        turn: [new THREE.Vector3(70, 210, 110), new THREE.Vector3(70, -210, 110)],
        fb:   [new THREE.Vector3(210, 90, 70), new THREE.Vector3(-210, 90, 70)],
        ss:   [new THREE.Vector3(80, 90, 210), new THREE.Vector3(80, 90, -210)]
      };
      ['turn', 'fb', 'ss'].forEach(ring => {
        a.setRing('turn', ring === 'turn'); a.setRing('fb', ring === 'fb'); a.setRing('ss', ring === 'ss');
        sides[ring].forEach((off, si) => {
          [30, -30].forEach(screenDeg => {
            H.zero();
            a.turn(ring, 37);              // well clear of every snap
            H.camera(off);
            const A = H.axisVec(ring);
            // a point FIXED TO THE PIECE, off the axis
            const e = Math.abs(A.y) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
            const local = p.mesh.worldToLocal(p.mesh.position.clone().add(e.multiplyScalar(12)));
            const ang = () => {
              p.mesh.updateMatrixWorld(true);
              const s = H.screen(p.mesh.localToWorld(local.clone())), c = H.screen(p.mesh.position);
              return Math.atan2(s.y - c.y, s.x - c.x) * 180 / Math.PI;
            };
            const look = new THREE.Vector3(); state.camera.getWorldDirection(look);
            const q0 = H.q(), phi0 = ang();
            const tr = H.trace(ring, screenDeg);
            const phi1 = ang();
            const dphi = ((phi1 - phi0 + 540) % 360) - 180;
            const turnedBy = H.angleDeg(q0, H.q());
            out.push({ ring, side: si === 0 ? '+' : '-', lookDotAxis: +look.dot(A).toFixed(3),
                       sign: tr.state.sign, traced: screenDeg, pieceOnScreen: +dphi.toFixed(2),
                       turned: +turnedBy.toFixed(4), worldDeg: +tr.state.applied.toFixed(4) });
          });
        });
      });
      a.setRing('turn', true); a.setRing('fb', false); a.setRing('ss', false);
      H.zero(); H.home();
      return out;
    });
    console.log('   ring  side  look.axis  sign  traced  piece-on-screen  turned  (world-signed)');
    for (const r of rows) {
      console.log('   ' + r.ring.padEnd(5) + ' ' + r.side.padEnd(5) + ' ' + String(r.lookDotAxis).padStart(8) +
        '  ' + String(r.sign).padStart(4) + '  ' + String(r.traced).padStart(6) +
        '  ' + String(r.pieceOnScreen).padStart(15) + '  ' + String(r.turned).padStart(6) +
        '  (' + r.worldDeg + ')');
    }
    for (const ring of ['turn', 'fb', 'ss']) {
      const mine = rows.filter(r => r.ring === ring);
      check(ring + ': the camera really is on both sides of the ring',
        mine.some(r => r.lookDotAxis > 0.3) && mine.some(r => r.lookDotAxis < -0.3));
      check(ring + ': clockwise traced -> the piece goes clockwise on screen, from both sides',
        mine.filter(r => r.traced > 0).every(r => r.pieceOnScreen > 5),
        mine.filter(r => r.traced > 0).map(r => r.side + ':' + r.pieceOnScreen + '°').join(' '));
      check(ring + ': anticlockwise traced -> anticlockwise on screen, from both sides',
        mine.filter(r => r.traced < 0).every(r => r.pieceOnScreen < -5),
        mine.filter(r => r.traced < 0).map(r => r.side + ':' + r.pieceOnScreen + '°').join(' '));
      check(ring + ': the piece turns the 30° traced, 1:1',
        mine.every(r => near(r.turned, 30, 1e-3)), mine.map(r => r.turned).join(' '));
      check(ring + ': the world-signed turn flips with the side - that is the view term at work',
        mine.filter(r => r.traced > 0 && r.side === '+')[0].worldDeg ===
        -mine.filter(r => r.traced > 0 && r.side === '-')[0].worldDeg);
    }
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. opening Rotate, and a real click on an arrowhead: exactly 1°, never snapped ===');
  {
    await page.click('#menu-rotate > summary');       // shut
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.__rot.zero(); window.__rot.home(); });
    await page.click('#menu-rotate > summary');       // open again
    await page.waitForTimeout(150);
    const open = await page.evaluate(() => ({
      rings: window.nsoRotate.rings(), ringCount: window.nsoRotate.ringCount(),
      arrows: window.nsoRotate.handleCount(),
      boxes: ['turn', 'fb', 'ss'].map(k => document.getElementById('chk-rot-ring-' + k).checked)
    }));
    check('opening Rotate shows one ring, Turn, with Turn checked and the others not',
      open.ringCount === 1 && open.rings.join() === 'turn' &&
      open.boxes.join() === 'true,false,false', JSON.stringify(open));
    check('...carrying two arrowheads, one each way', open.arrows === 2, open.arrows + ' arrowheads');

    for (const dir of [1, -1]) {
      const before = await page.evaluate(() => ({ q: window.__rot.q().toArray(),
        abs: window.nsoRotate.ringAngle('turn') }));
      const h = await page.evaluate(d => window.nsoRotate.handleScreen('turn', d), dir);
      await page.mouse.click(h.x, h.y);
      await page.waitForTimeout(80);
      const after = await page.evaluate((b) => {
        const H = window.__rot;
        const q0 = new THREE.Quaternion().fromArray(b.q), q1 = H.q();
        const d = q1.clone().multiply(q0.clone().invert());
        const ax = new THREE.Vector3(d.x, d.y, d.z).normalize();
        return { turned: H.angleDeg(q0, q1), axisY: Math.abs(ax.y), abs: window.nsoRotate.ringAngle('turn'),
                 readout: window.nsoRotate.readout(), shown: window.nsoRotate.readoutShown(),
                 dragging: window.nsoRotate.dragging() };
      }, before);
      check((dir > 0 ? '+' : '-') + ' arrowhead: one click turns exactly 1°',
        near(after.turned, 1, 1e-6), after.turned.toFixed(9) + '°');
      check('...about the vertical, the way the arrowhead points',
        near(after.axisY, 1, 1e-9) && near(after.abs - before.abs, dir, 1e-6),
        'ring angle ' + before.abs.toFixed(4) + ' -> ' + after.abs.toFixed(4));
      check('...even from a quarter turn, where a drag would snap', near(before.abs % 90, 0, 1e-6) || dir < 0);
      check('...and the readout says 1°', /^Turn 1° [⟳⟲]$/.test(after.readout) && after.shown,
        JSON.stringify(after.readout));
      check('...and no drag is left running', after.dragging === false);
    }
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. a full lap, real mouse: back where it started, readout past 360 ===');
  {
    for (const startDeg of [0, 37]) {
      const s = await page.evaluate((d) => {
        const H = window.__rot;
        H.zero(); H.home();
        if (d) window.nsoRotate.turn('turn', d);
        return { q: H.q().toArray(), c: window.nsoRotate.centreScreen(),
                 h: window.nsoRotate.handleScreen('turn', 1) };
      }, startDeg);
      const a0 = Math.atan2(s.h.y - s.c.y, s.h.x - s.c.x);
      const R = Math.hypot(s.h.x - s.c.x, s.h.y - s.c.y);
      await page.mouse.move(s.h.x, s.h.y);
      await page.mouse.down();
      let maxSeen = 0, readouts = [];
      /* 366, not 362: from 0 the piece starts square, and 360 itself is then
         a quarter turn the snap holds for 3° either side. */
      for (let i = 1; i <= 366; i++) {
        const a = a0 + i * Math.PI / 180;
        await page.mouse.move(s.c.x + Math.cos(a) * R, s.c.y + Math.sin(a) * R);
        if (i % 30 === 0 || i >= 362) {
          const t = await page.evaluate(() => window.nsoRotate.readout());
          const m = /(\d+(?:\.\d)?)°/.exec(t);
          if (m) maxSeen = Math.max(maxSeen, +m[1]);
          if (i >= 362) readouts.push(t);
        }
      }
      // ...and back to exactly one lap
      for (let i = 365; i >= 360; i--) {
        const a = a0 + i * Math.PI / 180;
        await page.mouse.move(s.c.x + Math.cos(a) * R, s.c.y + Math.sin(a) * R);
      }
      const last = await page.evaluate(() => window.nsoRotate.readout());
      await page.mouse.up();
      await page.waitForTimeout(80);
      const r = await page.evaluate((q) => {
        const H = window.__rot;
        return { off: H.angleDeg(new THREE.Quaternion().fromArray(q), H.q()),
                 controls: state.controls.enabled, dragging: window.nsoRotate.dragging() };
      }, s.q);
      check('from ' + startDeg + '°: a lap puts the piece back where it started',
        r.off < 1e-6, 'off by ' + r.off.toExponential(2) + '°');
      check('...the readout went past 360 on the way', maxSeen > 360,
        'max ' + maxSeen + '°; ' + readouts.join(' | '));
      check('...and reads 360 at exactly one lap', /^Turn 360° [⟳⟲]/.test(last), JSON.stringify(last));
      check('...and the camera is given back', r.controls && !r.dragging);
    }
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the snap: hard, inside 3° of a quarter turn only, one flash ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate;
      H.zero(); H.home();
      a.turn('turn', 37);
      const abs0 = a.ringAngle('turn');
      const target = Math.ceil(abs0 / 90) * 90;            // the next quarter turn up
      const flash0 = a.flashes();
      const sign = a.dialSign('turn');
      /* trace so the ring angle RISES through the quarter turn and on past it */
      const steps = [];
      const tr = H.trace('turn', sign * (target - abs0 + 12), { step: 0.5, each: () => {
        const st = a.dragState();
        return { raw: st.raw, applied: st.applied, abs: a.ringAngle('turn'), snapped: st.snapped, moved: st.moved,
                 readout: a.readout() };
      } });
      const flashes = a.flashes() - flash0;
      H.zero();
      return { abs0, target, seen: tr.seen, flashes };
    });
    const rows = r.seen.filter(s => s.moved);
    const sameAngle = (x, y) => near(((x - y) % 360 + 540) % 360 - 180, 0, 1e-6);
    const inWin = rows.filter(s => Math.abs(r.abs0 + s.raw - r.target) <= 3);
    const outWin = rows.filter(s => Math.abs(r.abs0 + s.raw - r.target) > 3);
    check('the drag passed through the snap window and out the other side',
      inWin.length > 4 && outWin.some(s => s.raw > r.target - r.abs0 + 3));
    check('inside 3° the piece is ON the quarter turn, exactly',
      inWin.every(s => sameAngle(s.abs, r.target)),
      inWin.map(s => (r.abs0 + s.raw).toFixed(1) + '->' + s.abs.toFixed(3)).slice(0, 4).join(' ') + ' ...');
    check('outside it the piece is exactly where the pointer says - no pull anywhere',
      outWin.every(s => near(s.applied, s.raw, 1e-9)),
      'max |applied-raw| ' + Math.max(...outWin.map(s => Math.abs(s.applied - s.raw))).toExponential(1));
    check('the jump at the edge is the whole snap and no more than 3°',
      rows.every(s => Math.abs(s.applied - s.raw) <= 3 + 1e-9));
    check('the ring flashed exactly once, on landing', r.flashes === 1, r.flashes + ' flash(es)');
    check('the readout says it is square while it is', inWin.every(s => / · square$/.test(s.readout)),
      inWin[0] && inWin[0].readout);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. arrow keys: 1° on the ring last touched, only while Rotate owns the input ===');
  {
    await page.evaluate(() => { window.__rot.zero(); window.__rot.home(); document.body.focus(); });
    const shut = await page.evaluate(() => {
      const H = window.__rot;
      document.getElementById('menu-rotate').open = false;
      const q0 = H.q();
      ['ArrowRight', 'ArrowUp'].forEach(k => document.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
      const off = H.angleDeg(q0, H.q());
      document.getElementById('menu-rotate').open = true;
      return off;
    });
    await page.waitForTimeout(80);
    check('with Rotate SHUT the arrows are not ours', shut === 0, shut + '°');

    const k = async key => {
      const q = await page.evaluate(() => window.__rot.q().toArray());
      await page.keyboard.press(key);
      return page.evaluate((q0) => {
        const H = window.__rot, q1 = H.q(), qq = new THREE.Quaternion().fromArray(q0);
        const d = q1.clone().multiply(qq.clone().invert());
        const ax = new THREE.Vector3(d.x, d.y, d.z).normalize();
        return { deg: H.angleDeg(qq, q1), ax: [ax.x, ax.y, ax.z].map(v => +Math.abs(v).toFixed(6)),
                 readout: window.nsoRotate.readout() };
      }, q);
    };
    let r = await k('ArrowRight');
    check('Turn only: ArrowRight turns 1° about the vertical', near(r.deg, 1, 1e-6) && r.ax[1] === 1,
      r.deg.toFixed(6) + '° ' + JSON.stringify(r.ax) + ' ' + r.readout);
    check('...clockwise as seen from here', / ⟳$/.test(r.readout), r.readout);
    r = await k('ArrowLeft');
    check('ArrowLeft turns it back, anticlockwise', near(r.deg, 1, 1e-6) && / ⟲$/.test(r.readout), r.readout);

    await page.click('#chk-rot-ring-fb');
    await page.waitForTimeout(80);
    r = await k('ArrowUp');
    check('two rings shown, none touched: the keys stay on Turn', r.ax[1] === 1, JSON.stringify(r.ax));
    const h = await page.evaluate(() => window.nsoRotate.handleScreen('fb', 1));
    await page.mouse.click(h.x, h.y);
    await page.waitForTimeout(60);
    r = await k('ArrowUp');
    check('after touching Lean front/back the keys follow it: 1° about the plate X',
      near(r.deg, 1, 1e-6) && r.ax[0] === 1, r.deg.toFixed(6) + '° ' + JSON.stringify(r.ax));
    await page.click('#chk-rot-ring-turn');            // Turn off: Lean front/back is the only ring
    await page.waitForTimeout(60);
    r = await k('ArrowDown');
    check('the only ring shown takes the keys', r.ax[0] === 1, JSON.stringify(r.ax));
    await page.click('#chk-rot-ring-turn');
    await page.click('#chk-rot-ring-fb');
    await page.waitForTimeout(60);

    const rep = await page.evaluate(() => {
      const H = window.__rot, q0 = H.q();
      for (let i = 0; i < 12; i++) document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
      return H.angleDeg(q0, H.q());
    });
    check('held down: 12 repeats turn 12°', near(rep, 12, 1e-6), rep.toFixed(6) + '°');
    const typing = await page.evaluate(() => {
      const H = window.__rot, q0 = H.q();
      const inp = document.querySelector('input[type="number"]');
      if (!inp) return null;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      return H.angleDeg(q0, H.q());
    });
    check('arrows inside a text field still belong to the field', typing === null || typing === 0, typing);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. which rings show, and closing Rotate puts it back to Turn only ===');
  {
    const probe = () => page.evaluate(() => ({ rings: window.nsoRotate.rings().join(),
      count: window.nsoRotate.ringCount(), arrows: window.nsoRotate.handleCount(),
      boxes: ['turn', 'fb', 'ss'].map(k => +document.getElementById('chk-rot-ring-' + k).checked).join('') }));
    let s = await probe();
    check('Turn only to start', s.rings === 'turn' && s.count === 1 && s.boxes === '100', JSON.stringify(s));
    await page.click('#chk-rot-ring-fb'); await page.waitForTimeout(50);
    s = await probe();
    check('checking Lean front/back adds that ring', s.rings === 'turn,fb' && s.count === 2 && s.arrows === 4,
      JSON.stringify(s));
    await page.click('#chk-rot-ring-ss'); await page.waitForTimeout(50);
    s = await probe();
    check('all three checked: three rings, six arrowheads', s.count === 3 && s.arrows === 6 && s.boxes === '111',
      JSON.stringify(s));
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'nso-rot-three.png') });
    const colours = await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return g.children.filter(c => c.userData.nsoRotateRing).map(c => ({
        ring: c.userData.nsoRotateRing, colour: c.material.color.getHexString(),
        depthTest: c.material.depthTest }));
    });
    check('each ring its own colour, drawn on top of everything (no depth test)',
      new Set(colours.map(c => c.colour)).size === 3 && colours.every(c => c.depthTest === false),
      JSON.stringify(colours));
    check('every ring is centred on the piece', await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return g.position.distanceTo(window.__rot.p().mesh.position) < 1e-9;
    }));

    await page.click('#menu-tip > summary'); await page.waitForTimeout(120);
    const gone = await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return { kids: g ? g.children.length : 0, visible: !!(g && g.visible) };
    });
    check('leaving Rotate empties the scene group - no ring left to hit',
      gone.kids === 0 && !gone.visible, JSON.stringify(gone));
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(120);
    s = await probe();
    check('reopening Rotate: Turn only again, boxes reset', s.rings === 'turn' && s.count === 1 &&
      s.boxes === '100', JSON.stringify(s));

    /* Leaving mid-drag: the menu goes from under a held arrowhead. */
    const h = await page.evaluate(() => window.nsoRotate.handleScreen('turn', 1));
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + 30, h.y + 25, { steps: 5 });
    const mid = await page.evaluate(() => ({ dragging: window.nsoRotate.dragging(),
      controls: state.controls.enabled }));
    await page.evaluate(() => { document.getElementById('menu-tip').open = true; });
    await page.waitForTimeout(60);
    const after = await page.evaluate(() => ({ dragging: window.nsoRotate.dragging(),
      controls: state.controls.enabled,
      kids: state.scene.getObjectByName('nso-rotate-handles').children.length }));
    await page.mouse.up();
    check('a drag was under way', mid.dragging && !mid.controls, JSON.stringify(mid));
    check('...leaving the menu ends it, gives the camera back and removes every ring',
      !after.dragging && after.controls && after.kids === 0, JSON.stringify(after));
    await page.evaluate(() => { document.getElementById('menu-tip').open = false; });
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(120);
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. Undo steps back one press at a time ===');
  {
    await page.evaluate(() => { window.__rot.zero(); window.__rot.home(); });
    const qs = [await page.evaluate(() => window.__rot.q().toArray())];
    // a drag, a click, a drag
    for (const kind of ['drag', 'click', 'drag']) {
      const h = await page.evaluate(() => window.nsoRotate.handleScreen('turn', 1));
      const c = await page.evaluate(() => window.nsoRotate.centreScreen());
      if (kind === 'click') await page.mouse.click(h.x, h.y);
      else {
        await page.mouse.move(h.x, h.y); await page.mouse.down();
        const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
        for (let i = 1; i <= 25; i++) {
          const a = a0 + i * Math.PI / 180;
          await page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R);
        }
        await page.mouse.up();
      }
      await page.waitForTimeout(60);
      qs.push(await page.evaluate(() => window.__rot.q().toArray()));
    }
    const offs = [];
    for (let i = qs.length - 2; i >= 0; i--) {
      await page.click('#btn-undo');
      await page.waitForTimeout(80);
      offs.push(await page.evaluate((q) => window.__rot.angleDeg(new THREE.Quaternion().fromArray(q),
        window.__rot.q()), qs[i]));
    }
    check('three presses, three Undos, each back exactly one press',
      offs.length === 3 && offs.every(o => o < 1e-6), offs.map(o => o.toExponential(1)).join(' '));
  }

  /* ----------------------------------------------------------------- 10 */
  console.log('\n=== 10. the 90° buttons are untouched; the locks and the trackball are gone ===');
  {
    const b = await page.evaluate(() => {
      const H = window.__rot; H.zero();
      const yaw = () => +((H.p().rotY || 0) * 180 / Math.PI).toFixed(6);
      const out = { before: yaw() };
      document.getElementById('btn-rot-right').click(); out.right = yaw();
      document.getElementById('btn-rot-left').click(); out.left = yaw();
      out.locks = !!(document.getElementById('chk-rot-lock-x') || document.getElementById('chk-rot-lock-y'));
      out.api = Object.keys(window.nsoRotate).filter(k => /lock|trackball|mode/i.test(k));
      H.zero();
      return out;
    });
    check('90° right still turns exactly 90°', near(b.right - b.before, 90, 1e-6), b.before + ' -> ' + b.right);
    check('90° left turns it exactly back', near(b.left, b.before, 1e-6), b.right + ' -> ' + b.left);
    const src = require('fs').readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    check('rotateSelected still moves rotY by exactly a quarter turn in the source',
      /p\.rotY = \(p\.rotY \|\| 0\) \+ dir \* \(Math\.PI \/ 2\);/.test(src));
    check('the X/Y lock checkboxes are gone from the page', b.locks === false);
    check('no lock, trackball or mode left in the API', b.api.length === 0, JSON.stringify(b.api));
  }

  /* ----------------------------------------------------------------- 11 */
  console.log('\n=== 11. the ring body is the track, not a handle ===');
  {
    const at = await page.evaluate(() => {
      const H = window.__rot, p = H.p();
      H.zero(); H.home();
      const g = state.scene.getObjectByName('nso-rotate-handles');
      const ring = g.children.find(c => c.userData.nsoRotateRing === 'turn');
      // the far side of the ring from the arrowheads, which sit nearest the camera
      const r = ring.geometry.parameters.radius;
      const away = p.mesh.position.clone().sub(state.camera.position).setY(0).normalize().multiplyScalar(r);
      return { s: H.screen(p.mesh.position.clone().add(away)), q: H.q().toArray() };
    });
    await page.mouse.move(at.s.x, at.s.y);
    await page.mouse.down();
    await page.mouse.move(at.s.x + 40, at.s.y + 20, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(60);
    const off = await page.evaluate((q) => window.__rot.angleDeg(new THREE.Quaternion().fromArray(q),
      window.__rot.q()), at.q);
    check('a drag on the ring body does not turn the piece', off < 1e-9, off + '°');
  }

  /* ----------------------------------------------------------------- 12 */
  console.log('\n=== 12. export writes what the screen shows - leaned and turned ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      H.zero();
      a.turn('fb', 90); a.turn('turn', 30); a.turn('ss', 20);
      p.mesh.updateMatrixWorld(true);
      // screen: each vertex's world offset from the piece's centre, in Bambu axes
      const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3();
      const screen = [];
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v); v.sub(p.mesh.position);
        screen.push([v.x, -v.z, v.y]);
      }
      const plate = getCurrentPlate();
      const objs = buildPlacedObjects3MF();
      // the indexed mesh back to a soup, triangle by triangle, in the order it was baked
      const o = objs[state.selectedIndex], flat = [];
      o.triangles.forEach(t => flat.push(o.vertices[t * 3], o.vertices[t * 3 + 1], o.vertices[t * 3 + 2]));
      if (flat.length !== screen.length * 3) return { worst: null, minZ: null, why: 'count ' + flat.length / 3 + ' vs ' + screen.length };
      const cx = p.x + plate.w / 2, cy = -p.z + plate.d / 2, cz = p.height / 2 + (p.liftY || 0);
      let worst = 0;
      for (let i = 0; i < screen.length; i++) {
        const e = [flat[i * 3] - cx, flat[i * 3 + 1] - cy, flat[i * 3 + 2] - cz];
        worst = Math.max(worst, Math.hypot(e[0] - screen[i][0], e[1] - screen[i][1], e[2] - screen[i][2]));
      }
      let minZ = Infinity;
      for (let i = 2; i < flat.length; i += 3) minZ = Math.min(minZ, flat[i]);
      const out = { worst, minZ,
                    pose: { tiltX: p.tiltX, rotY: p.rotY * 180 / Math.PI, tiltZ: p.tiltZ } };
      H.zero();
      return out;
    });
    check('every exported vertex sits where the screen draws it (leaned 90, turned 30, leaned 20)',
      r.worst < 1e-3, 'worst ' + (r.worst != null ? r.worst.toExponential(2) : r.worst) + ' mm; pose ' +
      JSON.stringify(r.pose));
    check('...and the exported piece rests on the plate', near(r.minZ, 0, 1e-3), 'min z ' + r.minZ);
  }

  /* ----------------------------------------------------------------- 13 */
  console.log('\n=== 13. the radius holds: bounding sphere, not box, measured once per geometry ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
    await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot, out = [];
      const n = state.placed.length;
      [n - 2, n - 1].forEach(idx => {
        selectPlaced(idx);
        const p = state.placed[idx];
        H.zero();
        a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
        /* the expected number, from the geometry, independently of the module */
        const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3();
        let m = 0;
        for (let i = 0; i < pos.count; i++) m = Math.max(m, v.fromBufferAttribute(pos, i).length());
        const want = Math.max(8, 1.45 * m);
        const torus = () => {
          const g = state.scene.getObjectByName('nso-rotate-handles');
          return g.children.filter(c => c.userData.nsoRotateRing).map(c => c.geometry.parameters.radius);
        };
        const oldBox = () => Math.max(8, Math.max(p.width, p.depth, p.height) / 2 * 1.45);
        a.refresh();
        const before = { r: a.ringRadius(), torus: torus(), box: oldBox() };
        const computes0 = a.sphereComputes();
        const after = {};
        ['turn', 'fb', 'ss'].forEach(ring => {
          H.zero(); a.refresh();
          a.turn(ring, 37);
          for (let k = 0; k < 20; k++) a.refresh();          // frames
          after[ring] = { r: a.ringRadius(), torus: torus(), box: oldBox() };
        });
        const computes1 = a.sphereComputes();
        /* a geometry change is a new measurement: a Scale-like bake */
        const g0 = p.mesh.geometry;
        p.mesh.geometry = g0.clone().scale(1.5, 1.5, 1.5);
        const scaled = a.ringRadius();
        const computes2 = a.sphereComputes();
        p.mesh.geometry.dispose(); p.mesh.geometry = g0;
        H.zero();
        out.push({ name: (state.models.find(mm => mm.id === p.sourceId) || {}).name || ('#' + idx),
                   want, before, after, computes: [computes0, computes1, computes2], scaled });
      });
      a.setRing('fb', false); a.setRing('ss', false);
      selectPlaced(0); H.zero();
      return out;
    });
    for (const r of rows) {
      console.log('   ' + r.name + ': ring radius ' + r.before.r.toFixed(6) + ' mm (1.45 x ' +
        (r.want / 1.45).toFixed(6) + ' mm sphere); after 37° on each ring: ' +
        ['turn', 'fb', 'ss'].map(k => k + ' ' + r.after[k].r.toFixed(6)).join(', ') +
        '  | the old box rule would have drawn ' + r.before.box.toFixed(3) + ' -> ' +
        ['turn', 'fb', 'ss'].map(k => r.after[k].box.toFixed(3)).join(' / '));
      check(r.name + ': the radius is 1.45 x the bounding sphere about the turning centre',
        near(r.before.r, r.want, 1e-9), r.before.r + ' vs ' + r.want);
      check(r.name + ': identical before and after a 37° turn, on every ring',
        ['turn', 'fb', 'ss'].every(k => r.after[k].r === r.before.r),
        ['turn', 'fb', 'ss'].map(k => (r.after[k].r - r.before.r).toExponential(1)).join(' '));
      check(r.name + ': ...and so is every drawn ring',
        ['turn', 'fb', 'ss'].every(k => r.after[k].torus.length === 3 &&
          r.after[k].torus.every(x => x === r.before.r)), JSON.stringify(r.after.turn.torus));
      check(r.name + ': the old box rule would have breathed - the fix is not vacuous',
        ['turn', 'fb', 'ss'].some(k => Math.abs(r.after[k].box - r.before.box) > 0.5));
      check(r.name + ': measured once - none of 60 turns-and-frames measured it again',
        r.computes[1] === r.computes[0], r.computes.join(' -> '));
      check(r.name + ': a new geometry is measured afresh, and only once',
        r.computes[2] === r.computes[1] + 1 && near(r.scaled, 1.5 * r.before.r, 1e-4),   // Float32 vertices
        r.scaled.toFixed(4) + ' mm');
    }
  }

  /* ----------------------------------------------------------------- 14 */
  console.log('\n=== 14. quieter rails while dragging; rest weight on release ===');
  {
    const w = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      H.zero(); H.home();
      a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
      const look = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles'), out = {};
        g.children.forEach(c => {
          const u = c.userData;
          if (u.nsoRotateRing) out['ring:' + u.nsoRotateRing] = { o: c.material.opacity,
            tube: c.geometry.parameters.tube, colour: c.material.color.getHexString() };
          if (u.nsoRotateTicks) out['ticks:' + u.nsoRotateTicks] = { o: c.material.opacity };
          if (u.nsoRotateLabel) out['label:' + u.nsoRotateLabel.ring + ':' + u.nsoRotateLabel.deg] = { o: c.material.opacity };
          if (u.nsoRotateHandle && c.material.visible)
            out['arrow:' + u.nsoRotateHandle.ring + ':' + u.nsoRotateHandle.dir] = { o: c.material.opacity };
        });
        return out;
      };
      const rest = look();
      const c = a.centreScreen(), R = 160;
      a.beginDrag({ ring: 'turn', dir: 1 }, c.x + R, c.y, c.x, c.y);
      const pressed = look();                                 // pressed, not yet moved
      for (let i = 1; i <= 20; i++) a.moveDrag(c.x + Math.cos(i * Math.PI / 180) * R, c.y + Math.sin(i * Math.PI / 180) * R);
      const mid = look();
      a.endDrag();
      const after = look();
      a.setRing('fb', false); a.setRing('ss', false);
      H.zero();
      return { rest, pressed, mid, after };
    });
    const R = w.rest, M = w.mid;
    check('at rest all three rings are drawn alike', ['turn', 'fb', 'ss'].every(k =>
      R['ring:' + k].o === R['ring:turn'].o && R['ring:' + k].tube === R['ring:turn'].tube));
    check('a press that has not moved yet leaves everything at rest weight',
      JSON.stringify(w.pressed) === JSON.stringify(R));
    check('dragging: the active ring goes THINNER, about 0.6 of its rest width',
      near(M['ring:turn'].tube / R['ring:turn'].tube, 0.6, 1e-9),
      R['ring:turn'].tube.toFixed(3) + ' -> ' + M['ring:turn'].tube.toFixed(3) + ' mm');
    check('...and see-through, so the piece reads through it', M['ring:turn'].o < R['ring:turn'].o * 0.6,
      R['ring:turn'].o + ' -> ' + M['ring:turn'].o);
    check('the two inactive rings fade to a faint trace',
      ['fb', 'ss'].every(k => M['ring:' + k].o <= 0.15 && M['ring:' + k].o < M['ring:turn'].o),
      ['fb', 'ss'].map(k => k + ' ' + M['ring:' + k].o).join(', '));
    check('the arrowhead being dragged keeps full weight', M['arrow:turn:1'].o === 1,
      'held ' + M['arrow:turn:1'].o + ', its partner ' + M['arrow:turn:-1'].o);
    check('every ring keeps its colour', ['turn', 'fb', 'ss'].every(k => M['ring:' + k].colour === R['ring:' + k].colour));
    check('ticks and labels fade with their ring',
      ['turn', 'fb', 'ss'].every(k => M['ticks:' + k].o < R['ticks:' + k].o && M['label:' + k + ':0'].o < R['label:' + k + ':0'].o));
    check('on release everything is back at rest weight', JSON.stringify(w.after) === JSON.stringify(R));
  }

  /* ----------------------------------------------------------------- 15 */
  console.log('\n=== 15. degree markers: fixed in the ring\'s frame, and the snap lands on a labelled tick ===');
  {
    const t = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot, K = a.constants;
      H.zero(); H.home();
      a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
      const grab = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles'), out = {};
        ['turn', 'fb', 'ss'].forEach(k => {
          const ticks = g.children.filter(c => c.userData.nsoRotateTicks === k);
          const labels = g.children.filter(c => c.userData.nsoRotateLabel && c.userData.nsoRotateLabel.ring === k);
          const ring = g.children.find(c => c.userData.nsoRotateRing === k);
          const pts = ticks[0] ? Array.from(ticks[0].geometry.attributes.position.array) : [];
          out[k] = { tickSets: ticks.length, isSegments: !!(ticks[0] && ticks[0].isLineSegments),
                     pts, r: ring.geometry.parameters.radius, tube: ring.geometry.parameters.tube,
                     ringO: ring.material.opacity, tickO: ticks[0] && ticks[0].material.opacity,
                     labels: labels.map(l => ({ deg: l.userData.nsoRotateLabel.deg, sprite: !!l.isSprite,
                       atten: l.material.sizeAttenuation, depth: l.material.depthTest,
                       d: l.position.length(), p: l.position.toArray() })) };
        });
        return out;
      };
      const before = grab();
      a.turn('turn', 37); a.turn('fb', 21);
      const after = grab();
      /* snap: drag Turn up into the quarter turn above, and stop there */
      H.zero(); a.turn('turn', 30);
      const abs0 = a.ringAngle('turn'), target = Math.ceil(abs0 / 90) * 90;
      const sign = a.dialSign('turn');
      const tr = H.trace('turn', sign * (target - abs0 - 1), { step: 0.5 });   // 1° short: inside the snap
      const at = a.ringAngle('turn');
      /* the piece's measured axis, projected into the ring's plane, against the tick */
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const A = new THREE.Vector3(0, 1, 0);
      const best = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(b => new THREE.Vector3().fromArray(b).applyQuaternion(p.mesh.quaternion))
        .sort((u, v) => Math.abs(u.dot(A)) - Math.abs(v.dot(A)))[0].projectOnPlane(A).normalize();
      const q = ((Math.round(at / 90) * 90) % 360 + 360) % 360;
      const ticks = grab().turn.pts;
      const tick = ((q / 15) | 0) * 6;                               // two points per tick, every 15°
      const tickDir = new THREE.Vector3(ticks[tick], ticks[tick + 1], ticks[tick + 2]).normalize();
      const onTick = Math.abs(best.dot(tickDir));
      a.setRing('fb', false); a.setRing('ss', false);
      H.zero();
      return { before, after, K, snap: { abs0, target, at, q, onTick, applied: tr.state.applied } };
    });
    const K = t.K;
    for (const k of ['turn', 'fb', 'ss']) {
      const b = t.before[k];
      check(k + ': ticks are ONE line-segment set (one draw call)', b.tickSets === 1 && b.isSegments);
      check(k + ': a tick every 15° - 24 of them', b.pts.length === 24 * 2 * 3, b.pts.length / 6 + ' ticks');
      const lens = [];
      for (let i = 0; i < 24; i++) {
        const o = i * 6, r0 = Math.hypot(b.pts[o], b.pts[o + 1], b.pts[o + 2]),
              r1 = Math.hypot(b.pts[o + 3], b.pts[o + 4], b.pts[o + 5]);
        lens.push({ deg: i * 15, r0, len: r1 - r0 });
      }
      const cls = d => d % 90 === 0 ? 90 : d % 45 === 0 ? 45 : 15;
      check(k + ': short every 15°, longer every 45°, longest on the quarters',
        lens.every(l => near(l.len, K.TICK_LEN[cls(l.deg)] * b.r, 1e-4)) &&   // Float32 points
        K.TICK_LEN[15] < K.TICK_LEN[45] && K.TICK_LEN[45] < K.TICK_LEN[90],
        [0, 15, 45, 90].map(d => d + '°:' + lens[d / 15].len.toFixed(2) + 'mm').join(' '));
      check(k + ': on the ring\'s outer edge', lens.every(l => near(l.r0, b.r + b.tube, 1e-4)));
      check(k + ': fixed in the ring\'s frame - a turn moves the piece, not the scale',
        JSON.stringify(t.after[k].pts) === JSON.stringify(b.pts));
      check(k + ': lighter than the ring at rest', b.tickO < b.ringO, b.tickO + ' vs ' + b.ringO);
      const L = b.labels.slice().sort((x, y) => x.deg - y.deg);
      check(k + ': labels 0 / 90 / 180 / 270', L.map(l => l.deg).join() === '0,90,180,270');
      check(k + ': sprites - they always face the camera - sized on screen, drawn on top',
        L.every(l => l.sprite && l.atten === false && l.depth === false));
      check(k + ': outside the ring and its longest tick, so never on the rail',
        L.every(l => l.d > b.r + b.tube + K.TICK_LEN[90] * b.r), L.map(l => l.d.toFixed(1)).join(' '));
      check(k + ': fixed, like the ticks', JSON.stringify(t.after[k].labels) === JSON.stringify(b.labels));
    }
    const s = t.snap;
    check('dragging into the quarter turn snapped it there', near(s.at - s.target, 0, 1e-6) ||
      near(Math.abs(s.at - s.target), 360, 1e-6), s.abs0.toFixed(2) + '° -> ' + s.at.toFixed(6) + '°');
    check('...and the piece\'s measured axis points exactly along the ' + s.q + ' tick',
      near(s.onTick, 1, 1e-9), 'cos = ' + s.onTick);
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

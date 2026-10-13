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
  13. THE RADIUS is 45% of the bed's shorter side - one size for every
      piece, bigger on a bigger bed.
  14. DRAGGING quiets the rails; release restores them.
  15. DEGREE MARKERS are fixed in the ring's frame; the snap lands on one.
  16. THE LEANS are the piece's own axes: turned 45 and leaned side/side
      30, a bar rises end-over-end with no twist, in the drawn ring's plane;
      front/back from there is a roll about its length.
  17. A FIXED PIVOT: a drag turns the piece about one held point - it may
      pass through the plate - with the rings standing on it; a run of
      clicks the same; one seat at the end; Undo seated; nso-watch told.
  18. A BIGGER BED, bigger rings.                                          */

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
    /* a ring's axis in the world NOW: the plate's vertical for Turn, the
       piece's own X (front/back) or Z (side/side) as it lies for the leans */
    H.axisVec = ring => new THREE.Vector3().fromArray(window.nsoRotate.ringAxis(ring));
    /* what a ring's turn should be: Turn on the plate's side, a lean on the
       piece's side about its own axis */
    H.want = (ring, q0, d) => ring === 'turn'
      ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d * Math.PI / 180).multiply(q0)
      : q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3().fromArray(window.nsoRotate.constants.LOCAL[ring]), d * Math.PI / 180));
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
          const want = H.want(ring, q0, d);
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
    check(r.n + ' turns from random poses: Turn lands on R(vertical, d) * q0, a lean on q0 * R(own axis, d)',
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
      /* front/back: a roll about its own X, so the record says tiltX 90 -
         the case where the old write to rotY turned about a leaned axis */
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
        /* at rest a lean ring's axis is the piece's own X (fb) or Z (ss) -
           which a turn about that same axis leaves where it is */
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
        const on = ring => +Math.abs(ax.dot(H.axisVec(ring))).toFixed(9);
        return { deg: H.angleDeg(qq, q1), ax: [ax.x, ax.y, ax.z].map(v => +Math.abs(v).toFixed(6)),
                 turn: on('turn'), fb: on('fb'), readout: window.nsoRotate.readout() };
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
    check('after touching Lean front/back the keys follow it: 1° about the piece\'s own X',
      near(r.deg, 1, 1e-6) && r.fb === 1, r.deg.toFixed(6) + '° ' + JSON.stringify(r.ax));
    await page.click('#chk-rot-ring-turn');            // Turn off: Lean front/back is the only ring
    await page.waitForTimeout(60);
    r = await k('ArrowDown');
    check('the only ring shown takes the keys', r.fb === 1, JSON.stringify(r.ax));
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
  console.log('\n=== 10. the 90° buttons turn about the plate\'s vertical; the locks and the trackball are gone ===');
  {
    /* The 90° buttons go through nsoRotate.turn('turn', ...) now, with the
       hard snap: from flat, 90° ⟳ is -90 on rotY (clockwise seen from above
       - it used to be +90, anticlockwise, under a ⟳), ⟲ the way back. That
       they turn about the PLATE's vertical on a leaned piece is
       tools/nso_pose_buttons_drive_check.js's. */
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
    check('90° ⟳ turns exactly 90°, clockwise from above', near(b.right - b.before, -90, 1e-6), b.before + ' -> ' + b.right);
    check('⟲ 90° turns it exactly back', near(b.left, b.before, 1e-6), b.right + ' -> ' + b.left);
    const lean = await page.evaluate(() => {
      const H = window.__rot, p = H.p(); H.zero();
      window.nsoRotate.turn('fb', 45);
      const a = H.q();
      document.getElementById('btn-rot-left').click();
      const d = H.q().multiply(a.clone().invert());
      const s = Math.hypot(d.x, d.y, d.z);
      H.zero();
      return { deg: 2 * Math.atan2(s, Math.abs(d.w)) * 180 / Math.PI, y: s ? d.y * Math.sign(d.w) / s : 0 };
    });
    check('on a piece leaned 45°, ⟲ 90° turns it about the plate\'s vertical, anticlockwise from above',
      near(lean.deg, 90, 1e-6) && near(lean.y, 1, 1e-9), lean.deg.toFixed(6) + '° about y ' + lean.y.toFixed(9));
    const src = require('fs').readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    check('rotateSelected goes through the Turn ring\'s plate-axis turn, snapped, in the source',
      /turnSelectedAbout\('yaw', 'turn', -dir \* 90, \{ snap: true \}\)/.test(src) &&
      !/p\.rotY = \(p\.rotY \|\| 0\) \+ dir/.test(src));
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
  console.log('\n=== 13. one ring size: 45% of the bed\'s shorter side, whatever the piece ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
    await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot, out = { pieces: [] };
      const n = state.placed.length;
      const torus = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        return g.children.filter(c => c.userData.nsoRotateRing).map(c => c.geometry.parameters.radius);
      };
      const arrowH = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        const c = g.children.find(k => k.userData.nsoRotateHandle && k.material.visible);
        return c.geometry.parameters.height;
      };
      [0, n - 2, n - 1].forEach(idx => {
        selectPlaced(idx);
        const p = state.placed[idx];
        H.zero();
        a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
        a.refresh();
        const before = { r: a.ringRadius(), torus: torus(), arrow: arrowH(),
                         size: [p.width, p.depth, p.height].map(v => +v.toFixed(1)) };
        const after = {};
        ['turn', 'fb', 'ss'].forEach(ring => { H.zero(); a.turn(ring, 37); a.refresh(); after[ring] = torus(); });
        out.pieces.push({ name: (state.models.find(m => m.id === p.sourceId) || {}).name || ('#' + idx), before, after });
        H.zero();
      });
      out.bed = getCurrentPlate();
      a.setRing('fb', false); a.setRing('ss', false);
      selectPlaced(0); H.zero();
      return out;
    });
    const want = 0.45 * Math.min(r.bed.w, r.bed.d);
    for (const pc of r.pieces) {
      console.log('   ' + pc.name.padEnd(42) + ' ' + pc.before.size.join(' x ') + ' mm -> ring ' +
        pc.before.r.toFixed(3) + ' mm, drawn ' + pc.before.torus.map(x => x.toFixed(3)).join(' / ') +
        ', arrowhead ' + pc.before.arrow.toFixed(2) + ' mm');
      check(pc.name + ': the ring radius is 45% of the A1 Mini bed\'s shorter side', near(pc.before.r, want, 1e-9) &&
        pc.before.torus.every(x => near(x, want, 1e-9)), pc.before.r + ' vs ' + want);
      check(pc.name + ': ...and does not change with a 37° turn on any ring',
        ['turn', 'fb', 'ss'].every(k => pc.after[k].every(x => x === pc.before.r)));
    }
    check('every piece, large or small, gets the same rings',
      r.pieces.every(pc => pc.before.r === r.pieces[0].before.r && pc.before.arrow === r.pieces[0].before.arrow),
      r.pieces.map(pc => pc.before.r.toFixed(1)).join(' / '));
    check('the arrowheads are a fixed fraction of the radius', near(r.pieces[0].before.arrow, 0.18 * want, 1e-9),
      r.pieces[0].before.arrow.toFixed(3) + ' mm');
    check('A1 Mini (180 mm): 81 mm', near(want, 81, 1e-9) && r.bed.w === 180, want + ' mm on ' + r.bed.name);
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
      /* a turn about a ring's OWN axis moves the piece and leaves that
         ring's scale where it was */
      const own = {};
      ['turn', 'fb', 'ss'].forEach(k => { H.zero(); a.turn(k, 37); own[k] = grab()[k]; });
      /* ...and a Turn carries the two lean rings round with the piece's
         heading - they are drawn in its frame - while Turn's own stays put */
      H.zero(); a.turn('turn', 37);
      const turned = grab();
      const Ry = new THREE.Matrix4().makeRotationY(37 * Math.PI / 180);
      const rotPts = pts => { const o = []; for (let i = 0; i < pts.length; i += 3) {
        const v = new THREE.Vector3(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(Ry); o.push(v.x, v.y, v.z); } return o; };
      const after = { turnByTurn: turned.turn, riding: {} };
      ['fb', 'ss'].forEach(k => { after.riding[k] = { want: rotPts(before[k].pts), got: turned[k].pts }; });
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
      return { before, own, after, K, snap: { abs0, target, at, q, onTick, applied: tr.state.applied } };
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
      const diff = (x, y) => x.length === y.length ? Math.max(...x.map((v, i) => Math.abs(v - y[i]))) : Infinity;
      check(k + ': fixed in the ring\'s frame - a 37° turn on it moves the piece, not its scale',
        diff(t.own[k].pts, b.pts) < 1e-4, 'max move ' + diff(t.own[k].pts, b.pts).toExponential(1) + ' mm');
      if (k === 'turn') check('turn: a Turn leaves the Turn scale level and where it was',
        diff(t.after.turnByTurn.pts, b.pts) < 1e-4);
      else check(k + ': a Turn of 37° carries this lean ring\'s scale round with the piece',
        diff(t.after.riding[k].got, t.after.riding[k].want) < 1e-4,
        'max off ' + diff(t.after.riding[k].got, t.after.riding[k].want).toExponential(1) + ' mm');
      check(k + ': lighter than the ring at rest', b.tickO < b.ringO, b.tickO + ' vs ' + b.ringO);
      const L = b.labels.slice().sort((x, y) => x.deg - y.deg);
      check(k + ': labels 0 / 90 / 180 / 270', L.map(l => l.deg).join() === '0,90,180,270');
      check(k + ': sprites - they always face the camera - sized on screen, drawn on top',
        L.every(l => l.sprite && l.atten === false && l.depth === false));
      check(k + ': outside the ring and its longest tick, so never on the rail',
        L.every(l => l.d > b.r + b.tube + K.TICK_LEN[90] * b.r), L.map(l => l.d.toFixed(1)).join(' '));
      check(k + ': the labels ride with their ticks',
        Math.max(...t.own[k].labels.map((l, i) => Math.hypot(...l.p.map((v, j) => v - b.labels[i].p[j])))) < 1e-4);
    }
    const s = t.snap;
    check('dragging into the quarter turn snapped it there', near(s.at - s.target, 0, 1e-6) ||
      near(Math.abs(s.at - s.target), 360, 1e-6), s.abs0.toFixed(2) + '° -> ' + s.at.toFixed(6) + '°');
    check('...and the piece\'s measured axis points exactly along the ' + s.q + ' tick',
      near(s.onTick, 1, 1e-9), 'cos = ' + s.onTick);
  }

  /* ----------------------------------------------------------------- 16 */
  console.log('\n=== 16. the leans are the piece\'s own axes: turn 45°, then side/side end-over-end, front/back a roll ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate;
      const n = state.placed.length;
      selectPlaced(n - 2);                                      // the 80 x 40 x 20 box
      const p = H.p();
      a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
      const D = 180 / Math.PI, up = new THREE.Vector3(0, 1, 0);
      const len = () => new THREE.Vector3(1, 0, 0).applyQuaternion(H.q());      // its own X: the 80
      const wid = () => new THREE.Vector3(0, 0, 1).applyQuaternion(H.q());      // its own Z: the 40
      const heading = v => Math.atan2(-v.z, v.x) * D;
      const elev = v => Math.asin(Math.max(-1, Math.min(1, v.dot(up)))) * D;
      /* the drawn rings, read off their own geometry: every vertex of a ring
         lies within a tube's width of the plane through the centre square to
         its axis - so this is the axis the screen shows */
      const plane = ring => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        const m = g.children.find(c => c.userData.nsoRotateRing === ring);
        const A = new THREE.Vector3().fromArray(a.ringAxis(ring));
        const pos = m.geometry.attributes.position, v = new THREE.Vector3();
        let off = 0;
        for (let i = 0; i < pos.count; i++) off = Math.max(off, Math.abs(v.fromBufferAttribute(pos, i).dot(A)));
        return { off, tube: m.geometry.parameters.tube };
      };
      /* at rest: #135's rings exactly - front/back about the plate X, side/side the plate Z */
      H.zero(); H.home();
      const rest = { fb: a.ringAxis('fb'), ss: a.ringAxis('ss') };
      a.turn('turn', 45);
      a.refresh();
      const L0 = len(), W0 = wid();
      const fbAxis0 = new THREE.Vector3().fromArray(a.ringAxis('fb'));
      const ssAxis0 = new THREE.Vector3().fromArray(a.ringAxis('ss'));
      const drawnFb = plane('fb'), drawnSs = plane('ss');
      /* a real dial drag on side/side, 30° of it, watching one corner: it
         must move square to the ring's axis - in the ring's plane */
      const tip = new THREE.Vector3(40, 10, 20);
      const w0 = p.mesh.localToWorld(tip.clone()).sub(p.mesh.position);
      const tr = H.trace('ss', a.dialSign('ss') * 30);
      const w1 = p.mesh.localToWorld(tip.clone()).sub(p.mesh.position);
      const L1 = len(), W1 = wid();
      /* for contrast: the same 30° about the PLATE's Z, the old ring */
      const qOld = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tr.state.applied * Math.PI / 180)
        .multiply(new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 4));
      const Lold = new THREE.Vector3(1, 0, 0).applyQuaternion(qOld);
      /* and front/back from the same 45° heading: a roll - the length stays level and put */
      H.zero(); a.turn('turn', 45);
      const Lr0 = len(), Wr0 = wid();
      const tf = H.trace('fb', a.dialSign('fb') * 30);
      const Lr1 = len(), Wr1 = wid();
      const out = {
        rest, fbIsOwnX: Math.abs(fbAxis0.dot(L0)), ssIsOwnZ: Math.abs(ssAxis0.dot(W0)),
        drawnFb, drawnSs, applied: tr.state.applied,
        headingBefore: heading(L0), headingAfter: heading(L1), elevBefore: elev(L0), elevAfter: elev(L1),
        widthStill: W1.angleTo(W0) * D,
        vertexSquare: Math.abs(w1.clone().sub(w0).normalize().dot(ssAxis0)),
        oldHeading: heading(Lold), oldElev: elev(Lold),
        roll: { applied: tf.state.applied, lengthMoved: Lr1.angleTo(Lr0) * D, widthRose: elev(Wr1) - elev(Wr0) },
        turnAxis: a.ringAxis('turn')
      };
      a.setRing('fb', false); a.setRing('ss', false);
      H.zero(); selectPlaced(0); H.zero();
      return out;
    });
    console.log('   side/side 30°, long axis: heading ' + r.headingBefore.toFixed(4) + '° -> ' + r.headingAfter.toFixed(4) +
      '°, elevation ' + r.elevBefore.toFixed(4) + '° -> ' + r.elevAfter.toFixed(4) + '°  | the old plate-Z ring: heading ' +
      r.oldHeading.toFixed(2) + '°, elevation ' + r.oldElev.toFixed(2) + '°');
    console.log('   front/back 30°: the length moved ' + r.roll.lengthMoved.toExponential(1) + '°, the width line rose ' +
      r.roll.widthRose.toFixed(4) + '°');
    check('at rest the leans are #135\'s rings: front/back the plate X, side/side the plate Z',
      JSON.stringify(r.rest.fb) === '[1,0,0]' && JSON.stringify(r.rest.ss) === '[0,0,1]', JSON.stringify(r.rest));
    check('after a 45° turn, Lean front/back is the piece\'s own length (its X)', near(r.fbIsOwnX, 1, 1e-12));
    check('...and Lean side/side its own width line (its Z)', near(r.ssIsOwnZ, 1, 1e-12));
    check('each drawn lean ring lies square to its axis - the ring you grab',
      r.drawnFb.off <= r.drawnFb.tube + 1e-4 && r.drawnSs.off <= r.drawnSs.tube + 1e-4,
      'fb ' + r.drawnFb.off.toFixed(4) + ' / ss ' + r.drawnSs.off.toFixed(4) + ' mm off plane, tube ' + r.drawnFb.tube.toFixed(3));
    check('a 30° side/side drag: the long axis rises 30°, end-over-end',
      near(Math.abs(r.elevAfter - r.elevBefore), 30, 1e-3) && near(Math.abs(r.applied), 30, 1e-6),
      r.elevBefore.toFixed(4) + '° -> ' + r.elevAfter.toFixed(4) + '°');
    check('...with no twist: its heading is still 45°', near(r.headingAfter, r.headingBefore, 1e-6) && near(r.headingBefore, 45, 1e-6),
      r.headingAfter.toFixed(6) + '°');
    check('...about the width line, which does not move', r.widthStill < 1e-6, r.widthStill.toExponential(1) + '°');
    check('...every point moves in the drawn ring\'s plane - the motion you get', r.vertexSquare < 1e-6,
      'cos to the axis ' + r.vertexSquare.toExponential(1));
    check('the old plate-Z lean would have twisted it: the heading swings as it rises',
      Math.abs(r.oldHeading - 45) > 1, 'heading 45° -> ' + r.oldHeading.toFixed(2) + '°');
    check('a 30° front/back drag from the same heading is a roll: no end lifts, the front edge does',
      near(Math.abs(r.roll.applied), 30, 1e-6) && r.roll.lengthMoved < 1e-6 && near(Math.abs(r.roll.widthRose), 30, 1e-3),
      'length moved ' + r.roll.lengthMoved.toExponential(1) + '°, width line ' + r.roll.widthRose.toFixed(4) + '°');
    check('Turn\'s ring stays level - the plate\'s vertical', JSON.stringify(r.turnAxis) === '[0,1,0]');
  }

  /* ----------------------------------------------------------------- 17 */
  console.log('\n=== 17. a fixed pivot while turning: the rings stand still, the piece seats once ===');
  {
    const K = await page.evaluate(() => window.nsoRotate.constants);
    /* a drag on side/side, the tape, 0 -> 180, the camera still */
    const d = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate;
      const n = state.placed.length;
      selectPlaced(n - 1);                                      // the tape
      const p = H.p();
      H.zero(); H.home();
      a.setRing('turn', true); a.setRing('ss', true);
      p.mesh.updateMatrixWorld(true);
      const lowest = () => { p.mesh.updateMatrixWorld(true); return new THREE.Box3().setFromObject(p.mesh).min.y; };
      const g = () => state.scene.getObjectByName('nso-rotate-handles').position.toArray();
      const centreW = () => { p.mesh.updateMatrixWorld(true);
        const gg = p.mesh.geometry; if (!gg.boundingSphere) gg.computeBoundingSphere();
        return gg.boundingSphere.center.clone().applyMatrix4(p.mesh.matrixWorld).toArray(); };
      const start = { group: g(), centre: centreW(), lowest: lowest() };
      const frames = [];
      const sign = a.dialSign('ss');
      const tr = H.trace('ss', sign * 180, { step: 1, each: () => {
        const st = a.dragState();
        return { applied: st.applied, group: g(), centre: centreW(), pivot: a.pivot(), lowest: lowest(),
                 held: a.holding() === p, screen: a.centreScreen() };
      } });
      const after = { group: g(), centre: centreW(), lowest: lowest(), held: a.holding(), y: p.mesh.position.y,
                      seatedY: p.height / 2 + 0.2 + (p.liftY || 0) };
      a.setRing('ss', false);
      return { start, frames: tr.seen.filter(f => f.applied !== 0), after, liftY: p.liftY || 0 };
    });
    const F = d.frames, same = (u, v) => u && v && Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]) < 1e-9;
    const at = deg => F.find(f => Math.abs(Math.abs(f.applied) - deg) < 0.51) || F[F.length - 1];
    console.log('   ring centre on screen: ' + [0, 45, 90, 135, 180].map(k => {
      const f = k === 0 ? F[0] : at(k);
      return k + '°(' + f.screen.x.toFixed(2) + ', ' + f.screen.y.toFixed(2) + ')';
    }).join(' '));
    check('mid-drag the rings never move: the group sits on one pivot through all ' + F.length + ' frames',
      F.every(f => same(f.group, F[0].group) && same(f.pivot, F[0].group)));
    check('...the pivot is the bounding-sphere centre the drag started on',
      same(F[0].pivot, d.start.centre), JSON.stringify(F[0].pivot));
    check('...and the piece turns about it: its sphere centre stays on the pivot in every frame',
      F.every(f => same(f.centre, f.pivot)));
    check('...the ring centre\'s screen position is the same in every frame',
      F.every(f => Math.abs(f.screen.x - F[0].screen.x) < 1e-6 && Math.abs(f.screen.y - F[0].screen.y) < 1e-6));
    check('mid-drag the tape passes through the plate - not prevented, not clamped',
      Math.min(...F.map(f => f.lowest)) < -5, 'lowest ' + Math.min(...F.map(f => f.lowest)).toFixed(2) + ' mm');
    check('...and nso-watch is told it is held, all the way', F.every(f => f.held));
    check('on release it is seated on the plate, once', d.after.held === null &&
      near(d.after.lowest, 0.2 + d.liftY, 1e-3) && near(d.after.y, d.after.seatedY, 1e-9),
      'lowest ' + d.after.lowest.toFixed(4) + ' mm');
    /* At 180° end-over-end the tape's box is the one it started with, so its
       seated centre IS the pivot: the step on release is zero here. The
       click run below, from a 40° lean, is where the step shows. */
    check('...and the rings are on the seated centre', same(d.after.group, d.after.centre),
      F[F.length - 1].group.map(v => v.toFixed(2)) + ' -> ' + d.after.group.map(v => v.toFixed(2)));

    /* a run of 15 one-degree clicks on one arrowhead: one pivot, one seat */
    const c = await page.evaluate(async (RUN) => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      H.zero(); a.setRing('ss', true);
      a.turn('ss', 40);                                         // leaned: a click moves its box
      a.refresh();
      const seated0 = { y: p.mesh.position.y, q: H.q().toArray() };
      const pivots = [], ys = [];
      const cS = a.centreScreen();
      for (let i = 0; i < 15; i++) {
        a.beginDrag({ ring: 'ss', dir: 1 }, cS.x + 100, cS.y, cS.x, cS.y);
        a.endDrag();
        pivots.push(a.pivot()); ys.push(p.mesh.position.y);
        await new Promise(r => setTimeout(r, 40));
      }
      const midHeld = a.holding() === p;
      const turned = H.angleDeg(new THREE.Quaternion().fromArray(seated0.q), H.q());
      const gHeld = state.scene.getObjectByName('nso-rotate-handles').position.toArray();
      await new Promise(r => setTimeout(r, RUN + 150));
      const seatedY = p.height / 2 + 0.2 + (p.liftY || 0);
      const gSeated = state.scene.getObjectByName('nso-rotate-handles').position.toArray();
      const end = { held: a.holding(), y: p.mesh.position.y, seatedY, gHeld, gSeated };
      /* Undo: one click back, seated */
      document.getElementById('btn-undo').click();
      const undo1 = { y: p.mesh.position.y, seatedY: p.height / 2 + 0.2 + (p.liftY || 0),
                      turned: H.angleDeg(new THREE.Quaternion().fromArray(seated0.q), H.q()) };
      a.setRing('ss', false);
      H.zero();
      return { pivots, ys, midHeld, turned, end, undo1, y0: seated0.y };
    }, K.RUN_MS);
    check('15 clicks of 1°: one pivot, unchanged until the last release',
      c.pivots.every(v => v && JSON.stringify(v) === JSON.stringify(c.pivots[0])), JSON.stringify(c.pivots[0]));
    check('...the piece held off its seat through the run, turned exactly 15°', c.midHeld && near(c.turned, 15, 1e-6),
      c.turned.toFixed(6) + '°');
    check('...seated once, ' + K.RUN_MS + ' ms after the last click', c.end.held === null && near(c.end.y, c.end.seatedY, 1e-9),
      'y ' + c.end.y.toFixed(4) + ' (seats at ' + c.end.seatedY.toFixed(4) + ')');
    check('...and the rings stepped once, from the pivot to the seated centre',
      c.end.gHeld[1] !== c.end.gSeated[1] && near(c.end.gSeated[1], c.end.seatedY, 1e-6),
      'centre y ' + c.end.gHeld[1].toFixed(3) + ' -> ' + c.end.gSeated[1].toFixed(3) + ' mm');
    check('Undo inside the run gives back a SEATED pose, one click back',
      near(c.undo1.y, c.undo1.seatedY, 1e-9) && near(c.undo1.turned, 14, 1e-6),
      'y ' + c.undo1.y.toFixed(4) + ', ' + c.undo1.turned.toFixed(4) + '° from the start');

    /* nso-watch: a held turn is not a piece off its bed - but an unheld one still is */
    const w = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      H.zero(); a.setRing('ss', true); a.refresh();
      NSOWatch.start();
      const cS = a.centreScreen();
      a.beginDrag({ ring: 'ss', dir: 1 }, cS.x + 120, cS.y, cS.x, cS.y);
      for (let i = 1; i <= 60; i++) a.moveDrag(cS.x + Math.cos(i * Math.PI / 180) * 120, cS.y + Math.sin(i * Math.PI / 180) * 120);
      const bedHeld = NSOWatch.check('mid-drag').filter(f => /-bed/.test(f.fp || '') || /seated on the bed/.test(f.msg || ''));
      a.endDrag();
      const bedAfter = NSOWatch.check('released').filter(f => /seated on the bed/.test(f.msg || ''));
      /* the control: lift the piece by hand, nothing holding it */
      p.mesh.position.y += 7; p.mesh.updateMatrixWorld(true);
      const bedControl = NSOWatch.check('control').filter(f => /seated on the bed/.test(f.msg || ''));
      applyMeshRotation(p);
      NSOWatch.stop();
      a.setRing('ss', false); H.zero();
      return { held: bedHeld.length, after: bedAfter.length, control: bedControl.length };
    });
    check('nso-watch armed: no "off its bed" finding for a piece held mid-drag', w.held === 0, w.held + ' finding(s)');
    check('...none once it is seated either', w.after === 0);
    check('...while a piece lifted by hand, with nothing holding it, is still caught', w.control > 0,
      w.control + ' finding(s)');
  }

  /* ----------------------------------------------------------------- 18 */
  console.log('\n=== 18. a bigger bed, bigger rings: P1S selected ===');
  {
    /* Switching the plate clears the plate's pieces (updatePlateInfo ->
       clearPlaced, as it always has), so a piece is dropped on afterwards. */
    await page.selectOption('#plate-select', 'a1');
    await page.waitForTimeout(200);
    await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
    await page.waitForTimeout(200);
    /* The plate picker is in the Plate drop-down now, and opening it shut
       Rotate (one panel on the page) - so Rotate is opened again, as a
       user would, before its rings are measured. */
    await page.click('#menu-rotate > summary');
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      selectPlaced(state.placed.length - 1);
      window.nsoRotate.refresh();
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return { bed: getCurrentPlate(), r: window.nsoRotate.ringRadius(),
               torus: g.children.filter(c => c.userData.nsoRotateRing).map(c => c.geometry.parameters.radius) };
    });
    check('P1S / A1 / X1C (256 mm bed): the rings scale up with it - 115.2 mm',
      near(r.r, 115.2, 1e-9) && r.torus.length > 0 && r.torus.every(x => near(x, 115.2, 1e-9)),
      r.r + ' mm on ' + r.bed.name + ', drawn ' + r.torus.map(x => x.toFixed(2)).join(' / '));
    await page.selectOption('#plate-select', 'a1mini');
    await page.waitForTimeout(200);
    const back = await page.evaluate(() => window.nsoRotate.ringRadius());
    check('...and back to 81 on the A1 Mini', near(back, 81, 1e-9), back + ' mm');
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

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
  13. THE RADIUS is one fixed size for every piece and every bed - just
      enough to enclose library/box_closed.stl - with slim 7.5 mm
      arrowheads.
  14. DRAGGING quiets the rails; release restores them.
  15. DEGREE MARKERS - a solid bar every 5, longer every 15, longest on
      the quarters, no numbers, as solid as the rail - are fixed in the
      ring's frame; the snap lands on one.
  16. THE LEANS are the piece's own axes while it lies flat (the level sides
      of its footprint - section 26 for a tipped piece): turned 45 and leaned side/side
      30, a bar rises end-over-end with no twist, in the drawn ring's plane;
      front/back from there is a roll about its length.
  17. A FIXED PIVOT: a drag turns the piece about one held point - it may
      pass through the plate - with the rings standing on it; a run of
      clicks the same; one seat at the end; Undo seated; nso-watch told.
  18. A BIGGER BED, the same rings.
  19. THE DARTS sit on a major (45°) tick, the one nearest the camera, for 8
      camera azimuths on every ring, never between two.
  20. ...and re-seat only when the camera has orbited 10° past the half-way
      point (hysteresis), so a camera hovering there does not flicker them.
      A drag carries them; releasing seats them again. A click on a dart or
      an arrow key turns the PIECE 1° (Shift 0.1°) and leaves them on their tick.
  21. THE LEANS ARE NAMED BY THE FOOTPRINT: a 60x20 piece lying along X, and
      the same piece turned 90°, both call the lean that tips it ALONG its
      length "front/back"; a square piece keeps the old mapping. Measured by
      what each ring does to the piece, not by trusting the name.
  22. ...re-evaluated after Turn, Tip (Roll), Scale and a bake, and held for
      the length of a drag.
  23. THE CARD: the row follows the ring, the tooltip says which way it tips.
  24. UNDO of a lean is what it was.
  25. THE DETENTS are the ring's own ticks, every 45°, in the ring's frame -
      not the drag's start: from 7°, 23° and 61° the first detent met is the
      next painted tick, whichever way the drag goes and wherever the darts
      sit. The window is 3° either side. The tick the piece is within it of
      is lit - a painted tick, in 12 seeded random drags - and the readout
      says the angle it sits on.
  26. AFTER TIP, FLIP, TURN the leans still lean: a 40x20x10 box after Tip
      on side, Tip X, Flip, Tip then Flip, and Turn 45 then Tip - a 10° drag
      and a real click on each lean dart tip its upright axis by exactly that,
      one side of the top up and the other down, with the footprint's heading
      unchanged within 0.1° and no part of the motion about the vertical. The
      names still follow the long side. An untipped piece is exactly as
      before: pose fields and quaternions pinned.                        */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

/* A closed box, x by y by z (z up, as an STL is), as a binary STL. */
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
    /* Every pose action is baked when it ends (app-core.js nsoBakePlacedPose):
       a released drag or a settled run leaves the turn in the geometry and the
       fields at 0. So home is nsoPoseHome - the geometry before the bakes,
       the fields 0 - and a pose is read off the piece's BODY, the turn on the
       mesh after the turns baked into it (nsoPieceBodyQ). A programmatic
       a.turn is not an action: it leaves its turn on the mesh, as before. */
    H.zero = () => {
      const p = H.p();
      if (window.nsoRotate.seat) window.nsoRotate.seat();
      nsoPoseHome(p);
      window.nsoRotate.refresh();
    };
    H.q = () => nsoPieceBodyQ(H.p());
    /* The angle between two orientations, as 2 atan2(|v|, |w|) of b * a^-1 -
       acos of a dot product near 1 cannot see below ~3e-6 degrees. */
    H.angleDeg = (a, b) => {
      const d = b.clone().multiply(a.clone().invert());
      return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180 / Math.PI;
    };
    /* a ring's axis in the world NOW: the plate's vertical for Turn, a level
       side of the piece's footprint as it lies for the leans - on a piece
       lying as loaded, its own X (fb) or Z (ss) */
    H.axisVec = ring => new THREE.Vector3().fromArray(window.nsoRotate.ringAxis(ring));
    /* what a ring's turn should be: about the WORLD axis the ring had before
       it - the vertical for Turn, `A0` (default: the ring's axis now) for a
       lean - premultiplied. On a piece lying as loaded a lean's A0 is its own
       axis, and this is q0 * R(own axis, d), the lean it always was. */
    H.want = (ring, q0, d, A0) => new THREE.Quaternion().setFromAxisAngle(
      ring === 'turn' ? new THREE.Vector3(0, 1, 0) : (A0 || H.axisVec(ring)), d * Math.PI / 180).multiply(q0);
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
      /* opts.atEnd: measured with the drag still in hand, the turn on the mesh
         - the release bakes it into the geometry, which re-centres the mesh's
         own frame (it moves no vertex), so a point picked in mesh-local terms
         before the drag is only that point until the release */
      const atEnd = opts.atEnd ? opts.atEnd() : undefined;
      a.endDrag();
      return { state: st, seen: seen, atEnd: atEnd };
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
      let worst = 0, countsKept = true, n = 0, steepest = 0;
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
          const A0 = H.axisVec(ring);
          if (ring !== 'turn') steepest = Math.max(steepest, Math.abs(A0.y));
          const d = rnd() < 0.2 ? 1 : (rnd() - 0.5) * 400;
          a.turn(ring, d);
          const want = H.want(ring, q0, d, A0);
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
      return { n, worst, countsKept, off, tiltsStill, at100, steepest };
    });
    check(r.n + ' turns from random poses: Turn lands on R(vertical, d) * q0, a lean on R(footprint side, d) * q0',
      r.worst < 1e-6, 'worst ' + r.worst.toExponential(2) + '°');
    check('...and in every one of those poses each lean axis lay level - never within 45° of vertical, never a yaw',
      r.steepest < 1e-9, 'steepest |A.up| ' + r.steepest.toExponential(2));
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
      /* The old behaviour, for contrast: the same 30 written to rotY - worked
         out before the drag, while the lean is still on the mesh (the release
         bakes it into the geometry) */
      p.rotY = fields0.rotY + 30 * Math.PI / 180; applyMeshRotation(p);
      const old = world();
      const oldDy = Math.max(...before.map((b, i) => Math.abs(b.y - old[i].y)));
      Object.assign(p, fields0); applyMeshRotation(p);
      const tr = H.trace('turn', 30, { atEnd: world });
      const after = tr.atEnd;
      const dy = Math.max(...before.map((b, i) => Math.abs(b.y - after[i].y)));
      const dxz = Math.max(...before.map((b, i) => Math.hypot(b.x - after[i].x, b.z - after[i].z)));
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
            const tr = H.trace(ring, screenDeg, { atEnd: ang });
            const phi1 = tr.atEnd;
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
  console.log('\n=== 6. the snap: hard, inside 3° of a detent only, one flash ===');
  {
    const r = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate;
      H.zero(); H.home();
      a.turn('turn', 37);
      const abs0 = a.ringAngle('turn');
      const target = Math.ceil(abs0 / 45) * 45;            // the next detent up
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
    check('the readout says the angle it sits on while it does', inWin.every(s => new RegExp(' · on ' + (r.target % 360) + '°$').test(s.readout)),
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
      /* the 90s are baked when they end: the yaw is read off the body */
      const yaw = () => +(new THREE.Euler().setFromQuaternion(H.q(), 'XYZ').y * 180 / Math.PI).toFixed(6);
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
  console.log('\n=== 13. one ring size, whatever the piece: just enough to enclose box_closed.stl ===');
  {
    await loadSTL(page, path.join(ROOT, 'library', 'box_closed.stl'));
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
      const tube = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        return g.children.find(c => c.userData.nsoRotateRing).geometry.parameters.tube;
      };
      const arrowH = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        const c = g.children.find(k => k.userData.nsoRotateHandle && k.material.visible);
        return c.geometry.parameters.height;
      };
      const arrowBase = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        const c = g.children.find(k => k.userData.nsoRotateHandle && k.material.visible);
        const h = g.children.find(k => k.userData.nsoRotateHandle && !k.material.visible);
        return { base: c.geometry.parameters.radius, hit: h.geometry.parameters.radius };
      };
      [0, n - 3, n - 2, n - 1].forEach(idx => {
        selectPlaced(idx);
        const p = state.placed[idx];
        H.zero();
        a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
        a.refresh();
        const geo = p.mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const before = { r: a.ringRadius(), torus: torus(), tube: tube(), arrow: arrowH(), dart: arrowBase(),
                         sphere: geo.boundingSphere.radius,
                         size: [p.width, p.depth, p.height].map(v => +v.toFixed(1)) };
        const after = {};
        ['turn', 'fb', 'ss'].forEach(ring => { H.zero(); a.turn(ring, 37); a.refresh(); after[ring] = torus(); });
        out.pieces.push({ name: (state.models.find(m => m.id === p.sourceId) || {}).name || ('#' + idx), before, after });
        H.zero();
      });
      out.bed = getCurrentPlate();
      out.K = a.constants;
      a.setRing('fb', false); a.setRing('ss', false);
      selectPlaced(0); H.zero();
      return out;
    });
    const want = r.K.RING_RADIUS_MM;
    for (const pc of r.pieces) {
      console.log('   ' + pc.name.padEnd(42) + ' ' + pc.before.size.join(' x ') + ' mm -> ring ' +
        pc.before.r.toFixed(3) + ' mm, drawn ' + pc.before.torus.map(x => x.toFixed(3)).join(' / ') +
        ', arrowhead ' + pc.before.arrow.toFixed(2) + ' mm');
      check(pc.name + ': the ring radius is the one fixed size', near(pc.before.r, want, 1e-9) &&
        pc.before.torus.every(x => near(x, want, 1e-9)), pc.before.r + ' vs ' + want);
      check(pc.name + ': ...and does not change with a 37° turn on any ring',
        ['turn', 'fb', 'ss'].every(k => pc.after[k].every(x => x === pc.before.r)));
    }
    check('every piece, large or small, gets the same rings',
      r.pieces.every(pc => pc.before.r === r.pieces[0].before.r && pc.before.arrow === r.pieces[0].before.arrow),
      r.pieces.map(pc => pc.before.r.toFixed(1)).join(' / '));
    const d0 = r.pieces[0].before;
    check('the arrowheads are slim darts: 7.5 mm long, under 4 mm across the base',
      near(d0.arrow, 7.5, 1e-9) && 2 * d0.dart.base < 4,
      d0.arrow.toFixed(2) + ' x ' + (2 * d0.dart.base).toFixed(2) + ' mm (were 14.58 x 13.12)');
    check('...with a grab target wider than the dart', d0.dart.hit > 2 * d0.dart.base,
      'grab sphere ' + d0.dart.hit.toFixed(2) + ' mm in radius');
    const bc = r.pieces.find(pc => /box_closed/.test(pc.name));
    check('box_closed.stl fits inside: its bounding sphere clears the tube\'s inner edge',
      !!bc && bc.before.sphere < want - bc.before.tube,
      bc && ('sphere ' + bc.before.sphere.toFixed(3) + ' mm < ' + (want - bc.before.tube).toFixed(3) + ' mm'));
    check('...and only just: within 2 mm of it', !!bc && want - bc.before.tube - bc.before.sphere < 2,
      bc && ((want - bc.before.tube - bc.before.sphere).toFixed(3) + ' mm to spare'));
    check('40 mm, on the A1 Mini as anywhere', near(want, 40, 1e-9), want + ' mm on ' + r.bed.name);
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
    check('ticks fade with their ring',
      ['turn', 'fb', 'ss'].every(k => M['ticks:' + k].o < R['ticks:' + k].o));
    check('on release everything is back at rest weight', JSON.stringify(w.after) === JSON.stringify(R));
  }

  /* ----------------------------------------------------------------- 15 */
  console.log('\n=== 15. degree markers: fixed in the ring\'s frame, and the snap lands on a long tick ===');
  {
    const t = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot, K = a.constants;
      H.zero(); H.home();
      a.setRing('turn', true); a.setRing('fb', true); a.setRing('ss', true);
      const grab = () => {
        const g = state.scene.getObjectByName('nso-rotate-handles'), out = {};
        ['turn', 'fb', 'ss'].forEach(k => {
          const ticks = g.children.filter(c => c.userData.nsoRotateTicks === k);
          const ring = g.children.find(c => c.userData.nsoRotateRing === k);
          const pts = ticks[0] ? ticks[0].userData.nsoTickEnds.slice() : [];
          const gp = ticks[0] && ticks[0].geometry.attributes.position;
          let span = 0;                                 // farthest bar vertex from the centre
          if (gp) for (let i = 0; i < gp.count; i++) span = Math.max(span, Math.hypot(gp.getX(i), gp.getY(i), gp.getZ(i)));
          out[k] = { tickSets: ticks.length, isMesh: !!(ticks[0] && ticks[0].isMesh),
                     verts: gp ? gp.count : 0, span,
                     pts, r: ring.geometry.parameters.radius, tube: ring.geometry.parameters.tube,
                     ringO: ring.material.opacity, tickO: ticks[0] && ticks[0].material.opacity,
                     sprites: g.children.filter(c => c.isSprite).length };
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
      const best = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(b => new THREE.Vector3().fromArray(b).applyQuaternion(H.q()))
        .sort((u, v) => Math.abs(u.dot(A)) - Math.abs(v.dot(A)))[0].projectOnPlane(A).normalize();
      const q = ((Math.round(at / 90) * 90) % 360 + 360) % 360;
      const ticks = grab().turn.pts;
      const tick = ((q / 5) | 0) * 6;                                // two points per tick, every 5°
      const tickDir = new THREE.Vector3(ticks[tick], ticks[tick + 1], ticks[tick + 2]).normalize();
      const onTick = Math.abs(best.dot(tickDir));
      a.setRing('fb', false); a.setRing('ss', false);
      H.zero();
      return { before, own, after, K, snap: { abs0, target, at, q, onTick, applied: tr.state.applied } };
    });
    const K = t.K;
    for (const k of ['turn', 'fb', 'ss']) {
      const b = t.before[k];
      check(k + ': ticks are ONE mesh of solid bars (one draw call)', b.tickSets === 1 && b.isMesh &&
        b.verts === 72 * 36, b.verts + ' vertices = ' + b.verts / 36 + ' boxes');
      check(k + ': a tick every 5° - 72 of them', b.pts.length === 72 * 2 * 3, b.pts.length / 6 + ' ticks');
      const lens = [];
      for (let i = 0; i < 72; i++) {
        const o = i * 6, r0 = Math.hypot(b.pts[o], b.pts[o + 1], b.pts[o + 2]),
              r1 = Math.hypot(b.pts[o + 3], b.pts[o + 4], b.pts[o + 5]);
        lens.push({ deg: i * 5, r0, len: r1 - r0 });
      }
      const cls = d => d % 90 === 0 ? 90 : d % 15 === 0 ? 15 : 5;
      check(k + ': short every 5°, longer every 15°, longest on the quarters',
        lens.every(l => near(l.len, K.TICK_LEN[cls(l.deg)] * b.r, 1e-4)) &&   // Float32 points
        K.TICK_LEN[5] < K.TICK_LEN[15] && K.TICK_LEN[15] < K.TICK_LEN[90],
        [0, 5, 15, 45, 90].map(d => d + '°:' + lens[d / 5].len.toFixed(2) + 'mm').join(' '));
      check(k + ': on the ring\'s outer edge', lens.every(l => near(l.r0, b.r + b.tube, 1e-4)));
      check(k + ': the bars reach out to the longest tick\'s end - the mesh is the scale it says',
        b.span > b.r + b.tube + K.TICK_LEN[90] * b.r - 1e-3 &&
        b.span < Math.hypot(b.r + b.tube + K.TICK_LEN[90] * b.r, K.TICK_WIDTH[90]) + 1e-3, b.span.toFixed(3) + ' mm');
      check(k + ': solid bars, thicker on the longer ticks', K.TICK_WIDTH[5] >= 0.4 &&
        K.TICK_WIDTH[5] < K.TICK_WIDTH[15] && K.TICK_WIDTH[15] < K.TICK_WIDTH[90],
        [5, 15, 90].map(c => c + '°: ' + K.TICK_WIDTH[c] + ' mm').join(', '));
      const diff = (x, y) => x.length === y.length ? Math.max(...x.map((v, i) => Math.abs(v - y[i]))) : Infinity;
      check(k + ': fixed in the ring\'s frame - a 37° turn on it moves the piece, not its scale',
        diff(t.own[k].pts, b.pts) < 1e-4, 'max move ' + diff(t.own[k].pts, b.pts).toExponential(1) + ' mm');
      if (k === 'turn') check('turn: a Turn leaves the Turn scale level and where it was',
        diff(t.after.turnByTurn.pts, b.pts) < 1e-4);
      else check(k + ': a Turn of 37° carries this lean ring\'s scale round with the piece',
        diff(t.after.riding[k].got, t.after.riding[k].want) < 1e-4,
        'max off ' + diff(t.after.riding[k].got, t.after.riding[k].want).toExponential(1) + ' mm');
      check(k + ': at least as solid as the ring at rest', b.tickO >= b.ringO, b.tickO + ' vs ' + b.ringO);
      check(k + ': no 0 / 90 / 180 / 270 labels - the readout follows the cursor', b.sprites === 0,
        b.sprites + ' sprite(s) in the group');
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
      const tr = H.trace('ss', a.dialSign('ss') * 30, { atEnd: () => p.mesh.localToWorld(tip.clone()).sub(p.mesh.position) });
      const w1 = tr.atEnd;
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
                      seatedY: nsoBelowOrigin(p.mesh, p.height) + 0.2 + (p.liftY || 0) };
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
      const seatedY = nsoBelowOrigin(p.mesh, p.height) + 0.2 + (p.liftY || 0);
      const gSeated = state.scene.getObjectByName('nso-rotate-handles').position.toArray();
      const end = { held: a.holding(), y: p.mesh.position.y, seatedY, gHeld, gSeated };
      /* Undo: one click back, seated */
      document.getElementById('btn-undo').click();
      const undo1 = { y: p.mesh.position.y, seatedY: nsoBelowOrigin(p.mesh, p.height) + 0.2 + (p.liftY || 0),
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
  console.log('\n=== 18. a bigger bed, the same rings: P1S selected ===');
  {
    /* Switching the plate clears the plate's pieces (updatePlateInfo ->
       clearPlaced, as it always has), so a piece is dropped on afterwards. */
    await page.selectOption('#plate-select', 'a1');
    await page.waitForTimeout(200);
    await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
    await page.waitForTimeout(200);
    /* Rotate open before its rings are measured. Until shell v3 the plate
       picker sat in a drop-down whose opening shut Rotate; it is pinned open
       now and leaves Rotate as it was, so Rotate is opened only if shut. */
    if (!(await page.evaluate(() => document.getElementById('menu-rotate').open))) await page.click('#menu-rotate > summary');
    await page.waitForTimeout(120);
    const r = await page.evaluate(() => {
      selectPlaced(state.placed.length - 1);
      window.nsoRotate.refresh();
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return { bed: getCurrentPlate(), r: window.nsoRotate.ringRadius(),
               torus: g.children.filter(c => c.userData.nsoRotateRing).map(c => c.geometry.parameters.radius) };
    });
    check('P1S / A1 / X1C (256 mm bed): the same 40 mm rings - the bed no longer sizes them',
      near(r.r, 40, 1e-9) && r.torus.length > 0 && r.torus.every(x => near(x, 40, 1e-9)),
      r.r + ' mm on ' + r.bed.name + ', drawn ' + r.torus.map(x => x.toFixed(2)).join(' / '));
    await page.selectOption('#plate-select', 'a1mini');
    await page.waitForTimeout(200);
    const back = await page.evaluate(() => window.nsoRotate.ringRadius());
    check('...and still 40 back on the A1 Mini', near(back, 40, 1e-9), back + ' mm');
  }


  /* ----------------------------------------------------------------- 19 */
  console.log('\n=== 19. the darts sit on a major tick, the one nearest the camera ===');
  {
    {
      await page.evaluate(() => {
        const H = window.__rot;
        /* the camera, round the vertical: azimuth 0 is straight in front (+Z).
           No refresh() - the controls' own 'change' has to do that. */
        H.cam = (az, el, R) => {
          const c = new THREE.Vector3().fromArray(window.nsoRotate.ringCentre());
          const a = az * Math.PI / 180, e = (el == null ? 25 : el) * Math.PI / 180, r = R || 220;
          state.controls.target.copy(c);
          state.camera.position.set(c.x + Math.sin(a) * Math.cos(e) * r, c.y + Math.sin(e) * r,
                                    c.z + Math.cos(a) * Math.cos(e) * r);
          state.camera.lookAt(c);
          state.controls.update();
          state.camera.updateMatrixWorld(true);
        };
        /* what the darts of a ring are doing, measured from the scene: the
           angle of the camera about the ring in the ring's own frame, the tick
           (if any) the pair's midpoint lies on, and where it is. */
        H.darts = (ring) => {
          const a = window.nsoRotate, F = a.ringFrame(ring);
          const e1 = new THREE.Vector3().fromArray(F.e1), e2 = new THREE.Vector3().fromArray(F.e2);
          const v = state.camera.position.clone().sub(new THREE.Vector3().fromArray(a.ringCentre()));
          const cam = Math.atan2(v.dot(e2), v.dot(e1)) * 180 / Math.PI;
          const g = state.scene.getObjectByName('nso-rotate-handles');
          const cones = g.children.filter(c => c.userData.nsoRotateHandle &&
            c.userData.nsoRotateHandle.ring === ring && c.material.visible);
          const mid = new THREE.Vector3();
          cones.forEach(c => mid.add(c.position));
          mid.normalize();
          const ticks = g.children.find(c => c.userData.nsoRotateTicks === ring).userData.nsoTickEnds;
          let onTick = null;
          for (let i = 0; i < ticks.length / 6; i++) {
            const t = new THREE.Vector3(ticks[i * 6], ticks[i * 6 + 1], ticks[i * 6 + 2]).normalize();
            if (t.dot(mid) > 1 - 1e-9) onTick = i * 5;       // the scale is a bar every 5°
          }
          const t = a.dartTick(ring);
          const world = cones.reduce((m, c) => m.add(c.position), new THREE.Vector3()).multiplyScalar(1 / (cones.length || 1));
          return { cones: cones.length, cam: cam, onTick: onTick, idx: t && t.index, deg: t && t.deg, at: t && t.at,
                   world: world.toArray() };
        };
      });
    }
    const nearest = c => (((Math.round(c / 45) % 8) + 8) % 8) * 45;
    const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(250);
    await page.evaluate(() => { selectPlaced(state.placed.length - 1); window.__rot.zero(); });
    if (!(await page.evaluate(() => document.getElementById('menu-rotate').open))) await page.click('#menu-rotate > summary');
    await page.waitForTimeout(120);

    const rows = [];
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      /* a fresh session each time, so the answer is the nearest tick and not
         the hysteresis's memory of the last one */
      await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);
      await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
      const r = await page.evaluate(az => {
        const a = window.nsoRotate, H = window.__rot;
        a.setRing('fb', true); a.setRing('ss', true);
        H.cam(az, 25);
        a.refresh();
        return ['turn', 'fb', 'ss'].map(k => Object.assign({ ring: k }, H.darts(k)));
      }, az);
      r.forEach(d => rows.push(Object.assign({ az: az }, d)));
    }
    for (const ring of ['turn', 'fb', 'ss']) {
      const mine = rows.filter(r => r.ring === ring);
      check(ring + ': 8 camera azimuths - the darts are on a 45° tick every time, two arrowheads',
        mine.length === 8 && mine.every(r => r.cones === 2 && r.onTick != null && r.onTick % 45 === 0),
        mine.map(r => r.az + '→' + r.onTick).join(' '));
      check(ring + ': ...and it is the tick nearest the camera',
        mine.every(r => r.deg === nearest(r.cam) && r.onTick === r.deg),
        mine.map(r => Math.round(r.cam) + '→' + r.deg).join(' '));
    }

    /* The three places the ticket names, literally: where the pair sits in the
       world, relative to the ring's centre (the ring is 40 mm, the pair's midpoint
       a hair inside it). */
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
    const lit = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      a.setRing('fb', true); a.setRing('ss', true);
      const out = {};
      const place = (name, ring, az, el) => { H.cam(az, el); a.refresh(); out[name] = H.darts(ring).world; };
      place('turn', 'turn', 0, 30);          // straight in front, from above
      place('fb', 'fb', 0, 85);              // from almost overhead
      place('ss', 'ss', 90, 10);             // from the side, low
      const c = H.p().mesh.position.clone();
      H.cam(0, 30); a.refresh();
      const h1 = a.handleScreen('turn', 1), h2 = a.handleScreen('turn', -1), cs = a.centreScreen();
      out.screen = { x: (h1.x + h2.x) / 2 - cs.x, y: (h1.y + h2.y) / 2 - cs.y };
      return out;
    });
    const R = 39;
    check('Turn, camera in front: the darts are at 6 o\'clock - toward the viewer on the plate, straight below the centre on screen',
      lit.turn[2] > R && Math.abs(lit.turn[0]) < 0.5 && Math.abs(lit.turn[1]) < 0.5 && Math.abs(lit.screen.x) < 0.5 && lit.screen.y > 20,
      JSON.stringify(lit.turn.map(v => +v.toFixed(1))) + ' screen ' + lit.screen.y.toFixed(0));
    check('front/back, camera overhead: the darts are at the top of their ring', lit.fb[1] > R && Math.abs(lit.fb[0]) < 0.5 && Math.abs(lit.fb[2]) < 0.5,
      JSON.stringify(lit.fb.map(v => +v.toFixed(1))));
    check('side/side, camera at the side: the darts are on the side nearest the camera', lit.ss[0] > R && Math.abs(lit.ss[1]) < 0.5 && Math.abs(lit.ss[2]) < 0.5,
      JSON.stringify(lit.ss.map(v => +v.toFixed(1))));
  }

  /* ----------------------------------------------------------------- 20 */
  console.log('\n=== 20. the darts re-seat 10° past the half-way point, and a drag carries them ===');
  {
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
    const sweep = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      /* On Turn the camera's angle about the ring IS its azimuth. */
      const seq = az => { H.cam(az, 25); return a.dartTick('turn').deg; };
      H.cam(0, 25); a.refresh();
      const start = a.dartTick('turn').deg;
      const fwd = [], back = [];
      let last = start;
      for (let az = 1; az <= 90; az++) { const d = seq(az); if (d !== last) { fwd.push(az + '→' + d); last = d; } }
      for (let az = 89; az >= 0; az--) { const d = seq(az); if (d !== last) { back.push(az + '→' + d); last = d; } }
      /* Hover at the half-way point: back and forth across 22.5 ten times. */
      H.cam(0, 25); a.refresh();
      let flips = 0; last = a.dartTick('turn').deg;
      for (let i = 0; i < 10; i++) for (const az of [21, 24]) { const d = seq(az); if (d !== last) { flips++; last = d; } }
      return { start: start, fwd: fwd, back: back, flips: flips,
               drawn: a.dartTick('turn').at };
    });
    check('orbiting 0 → 90: seated on 0, moves to 45 only once past 32.5°, then to 90 past 77.5°',
      sweep.start === 0 && sweep.fwd.join() === '33→45,78→90', sweep.fwd.join(', '));
    check('...and back 90 → 0 it moves at different angles (57.5°, 12.5°): that gap is the hysteresis',
      sweep.back.join() === '57→45,12→0', sweep.back.join(', '));
    check('a camera hovering across the half-way point 20 times does not move them at all',
      sweep.flips === 0, sweep.flips + ' moves');
    check('...and the drawn pair is on the tick the memory says', near(sweep.drawn, 0, 1e-9), sweep.drawn + '°');

    /* A drag carries the darts; releasing seats them. */
    const dr = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      H.zero(); H.cam(0, 25); a.refresh();
      const c = a.centreScreen(), h = a.handleScreen('turn', 1);
      const before = a.dartTick('turn');
      a.beginDrag({ ring: 'turn', dir: 1 }, h.x, h.y, c.x, c.y);
      const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
      for (let i = 1; i <= 17; i++) a.moveDrag(c.x + Math.cos(a0 + i * Math.PI / 180) * R, c.y + Math.sin(a0 + i * Math.PI / 180) * R);
      const mid = a.dartTick('turn'), applied = a.dragState().applied;
      a.endDrag();
      const after = a.dartTick('turn');
      return { before: before, mid: mid, after: after, applied: applied };
    });
    check('mid-drag the darts ride the piece off the tick (as they always have)',
      Math.abs(dr.mid.at - (dr.before.at + dr.applied)) < 1e-6 && dr.mid.at % 45 !== 0 && Math.abs(dr.applied) > 10,
      'tick ' + dr.before.at + '° → ' + dr.mid.at.toFixed(2) + '° (piece turned ' + dr.applied.toFixed(2) + '°)');
    check('...released, they are back on a major tick - the one nearest the camera',
      dr.after.at % 45 === 0 && dr.after.at === dr.before.at, dr.after.at + '°');

    /* A click is a step of one degree and no more: the darts stay put. */
    const ck = await page.evaluate(() => {
      const a = window.nsoRotate, before = a.dartTick('turn').at;
      a.step('turn', 1);
      const after = a.dartTick('turn').at;
      return { before: before, after: after };
    });
    check('a click steps the piece a degree but leaves the darts on their tick',
      ck.before === ck.after && ck.after % 45 === 0, ck.before + '° → ' + ck.after + '°');
    await page.evaluate(() => window.nsoRotate.seat());

    /* Nudge the piece, not the darts: a real click on a dart, a real arrow key,
       a degree each - a tenth with Shift - and the pair never leaves its tick. */
    await page.evaluate(() => { window.__rot.zero(); window.__rot.cam(0, 25); window.nsoRotate.refresh(); });
    await page.waitForTimeout(80);
    const nudged = async (how) => {
      const before = await page.evaluate(() => ({ q: window.__rot.q().toArray(), d: window.nsoRotate.dartTick('turn') }));
      const h = await page.evaluate(() => window.nsoRotate.handleScreen('turn', 1));
      if (how.click) {
        if (how.shift) await page.keyboard.down('Shift');
        await page.mouse.click(h.x, h.y);
        if (how.shift) await page.keyboard.up('Shift');
      } else await page.keyboard.press((how.shift ? 'Shift+' : '') + how.key);
      const after = await page.evaluate(() => ({ q: window.__rot.q().toArray(), d: window.nsoRotate.dartTick('turn'),
        readout: window.nsoRotate.readout() }));
      const deg = await page.evaluate(([x, y]) => window.__rot.angleDeg(new THREE.Quaternion().fromArray(x),
        new THREE.Quaternion().fromArray(y)), [before.q, after.q]);
      await page.evaluate(() => window.nsoRotate.seat());
      return { deg: deg, still: before.d.at === after.d.at && after.d.at % 45 === 0, at: after.d.at, readout: after.readout };
    };
    for (const how of [{ name: 'click', click: true, want: 1 }, { name: 'Shift+click', click: true, shift: true, want: 0.1 },
                       { name: 'ArrowRight', key: 'ArrowRight', want: 1 }, { name: 'Shift+ArrowRight', key: 'ArrowRight', shift: true, want: 0.1 },
                       { name: 'Shift+ArrowLeft', key: 'ArrowLeft', shift: true, want: 0.1 }]) {
      const r = await nudged(how);
      check(how.name + ': the piece turns ' + how.want + '°, the darts stay on their tick',
        near(r.deg, how.want, 1e-6) && r.still, r.deg.toFixed(6) + '°, darts at ' + r.at + '°, "' + r.readout + '"');
    }
    const fineRead = await page.evaluate(() => window.nsoRotate.readout());
    check('...and the readout says a tenth, not a degree', /^Turn 0\.1°/.test(fineRead), fineRead);
    const fineDrag = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      H.zero(); H.cam(0, 25); a.refresh();
      const c = a.centreScreen(), h = a.handleScreen('turn', 1);
      a.beginDrag({ ring: 'turn', dir: 1 }, h.x, h.y, c.x, c.y, true);       // Shift held on the press
      const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
      for (let i = 1; i <= 17; i++) a.moveDrag(c.x + Math.cos(a0 + i * Math.PI / 180) * R, c.y + Math.sin(a0 + i * Math.PI / 180) * R);
      const applied = a.dragState().applied;
      a.endDrag();
      return applied;
    });
    check('Shift does nothing to a drag: 17° of pointer is 17° of piece', near(Math.abs(fineDrag), 17, 1e-6), fineDrag.toFixed(4) + '°');
  }

  /* ----------------------------------------------------------------- 21 */
  console.log('\n=== 21. the leans are named by the footprint: front/back tips the piece ALONG its length ===');
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rails-pieces-'));
  const files = {
    bar:    writeBoxSTL(path.join(DIR, 'bar60x20x10.stl'), 60, 20, 10),
    near:   writeBoxSTL(path.join(DIR, 'box60x58x10.stl'), 60, 58, 10),
    wide:   writeBoxSTL(path.join(DIR, 'box60x55x10.stl'), 60, 55, 10),
    column: writeBoxSTL(path.join(DIR, 'column20x20x60.stl'), 20, 20, 60)
  };
  await page.evaluate(() => {
    const H = window.__rot;
    /* what leaning `ring` 20° does to the piece's LONG axis (its longest
       local extent): how far the axis's height changes. A lean that tips the
       piece along its length moves it; a roll about the length cannot. */
    H.endsRise = (ring) => {
      /* the longest extent in the piece's BODY frame: a bake turns the
         geometry itself, so its own box is not the body's */
      const p = H.p(), g = p.mesh.geometry, pos = g.attributes.position;
      const toBody = H.q().invert().multiply(p.mesh.quaternion), v = new THREE.Vector3(), bb = new THREE.Box3();
      for (let i = 0; i < pos.count; i++) bb.expandByPoint(v.fromBufferAttribute(pos, i).applyQuaternion(toBody));
      const sz = bb.getSize(new THREE.Vector3());
      const k = sz.x >= sz.y && sz.x >= sz.z ? 0 : sz.y >= sz.z ? 1 : 2;
      const axis = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
      const q0 = H.q(), q1 = H.want(ring, q0, 20);
      return Math.abs(axis.clone().applyQuaternion(q1).y - axis.clone().applyQuaternion(q0).y);
    };
    H.names = () => {
      const a = window.nsoRotate, n = a.leanNames();
      const fbRing = ['fb', 'ss'].find(r => a.ringLabel(r) === 'Lean front/back');
      const ssRing = ['fb', 'ss'].find(r => a.ringLabel(r) === 'Lean side/side');
      return { names: n, fbRing: fbRing, ssRing: ssRing,
               fbRise: fbRing ? H.endsRise(fbRing) : null, ssRise: ssRing ? H.endsRise(ssRing) : null,
               fbColour: fbRing ? a.ringColor(fbRing) : null, ssColour: ssRing ? a.ringColor(ssRing) : null,
               w: H.p().width, d: H.p().depth };
    };
    /* select the piece just dropped and stand it on the middle of the plate:
       pieces dropped one after another walk out toward the edge, where the
       orbit leash would turn the camera off them */
    H.drop = idx => {
      const p = state.placed[idx];
      p.x = 0; p.z = 0; applyMeshRotation(p);
      selectPlaced(idx); window.nsoRotate.refresh();
    };
  });
  const drop = async (file) => {
    await loadSTL(page, file);
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); window.__rot.zero(); });
    if (!(await page.evaluate(() => document.getElementById('menu-rotate').open))) await page.click('#menu-rotate > summary');
    await page.waitForTimeout(100);
  };
  /* the ring named front/back lifts the piece's ends, the other cannot lift them
     more: exactly nothing in a clean pose, a little once it is leaned about both */
  const alongOK = (r) => r.fbRing && r.ssRing && r.fbRing !== r.ssRing && r.fbRise > 0.2 && r.fbRise > r.ssRise + 0.05;
  {
    await drop(files.bar);
    const lying = await page.evaluate(() => window.__rot.names());
    check('a 60x20 piece lying along X: the lean named front/back is the one that tips it along its length',
      alongOK(lying) && lying.w > lying.d, 'footprint ' + lying.w.toFixed(1) + ' x ' + lying.d.toFixed(1) +
      ', front/back = ring ' + lying.fbRing + ' (rise ' + lying.fbRise.toFixed(3) + '), side/side rise ' + lying.ssRise.toExponential(1));
    check('...which is own Z (id "ss"): the ring stayed on the piece\'s own axis, only its name moved',
      lying.fbRing === 'ss' && lying.names.along === 'ss' && lying.names.square === false);
    check('...and the colours went with the names: the along-length ring is pink, the other amber',
      lying.fbColour === 0xf472b6 && lying.ssColour === 0xfbbf24, lying.fbColour.toString(16) + ' / ' + lying.ssColour.toString(16));
    const axes = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, q = H.q();
      const want = k => new THREE.Vector3().fromArray(k === 'fb' ? [1, 0, 0] : [0, 0, 1]).applyQuaternion(q);
      return ['fb', 'ss'].map(k => H.axisVec(k).distanceTo(want(k)));
    });
    check('the rings did not move: "fb" is still the piece\'s own X, "ss" its own Z', axes.every(d => d < 1e-9),
      axes.map(d => d.toExponential(1)).join(' '));

    const turned = await page.evaluate(() => {
      rotateSelected(1);                         // the 90° button
      window.nsoRotate.refresh();
      return window.__rot.names();
    });
    check('the same piece turned 90° (now along Z): front/back is still the lean along its length',
      alongOK(turned) && turned.d > turned.w, 'footprint ' + turned.w.toFixed(1) + ' x ' + turned.d.toFixed(1) +
      ', front/back = ring ' + turned.fbRing + ' (rise ' + turned.fbRise.toFixed(3) + ')');
    const at30 = await page.evaluate(() => {
      window.__rot.zero(); window.nsoRotate.turn('turn', 30); return window.__rot.names();
    });
    check('...and turned 30° (its box on the plate is 62 x 47): the same', alongOK(at30), 'footprint ' +
      at30.w.toFixed(1) + ' x ' + at30.d.toFixed(1));
    const leaned = await page.evaluate(() => {
      window.__rot.zero(); window.nsoRotate.turn('ss', 15); window.nsoRotate.turn('fb', 10); return window.__rot.names();
    });
    check('...and leaned a little about both of its own axes: the same', alongOK(leaned), 'footprint ' +
      leaned.w.toFixed(1) + ' x ' + leaned.d.toFixed(1));

    await drop(files.near);
    const near58 = await page.evaluate(() => window.__rot.names());
    check('a 60x58 piece (3.3% off square) is square: the old mapping stands - front/back is own X',
      near58.names.square === true && near58.fbRing === 'fb' && near58.ssRing === 'ss', JSON.stringify(near58.names));
    await drop(files.wide);
    const wide55 = await page.evaluate(() => window.__rot.names());
    check('a 60x55 piece (8.3% off) is not: it follows the footprint',
      wide55.names.square === false && alongOK(wide55), 'front/back = ' + wide55.fbRing);

    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); window.__rot.zero(); });
    const sq = await page.evaluate(() => window.__rot.names());
    check('a square piece keeps today\'s mapping: Lean front/back is own X, Lean side/side own Z, pink and amber',
      sq.names.square === true && sq.fbRing === 'fb' && sq.ssRing === 'ss' &&
      sq.fbColour === 0xf472b6 && sq.ssColour === 0xfbbf24, JSON.stringify(sq.names.roles));
    const sqT = await page.evaluate(() => { rotateSelected(1); window.nsoRotate.refresh(); const r = window.__rot.names(); window.__rot.zero(); return r; });
    check('...turned 90°, still square, still the same mapping', sqT.names.square === true && sqT.fbRing === 'fb');
  }

  /* ----------------------------------------------------------------- 22 */
  console.log('\n=== 22. re-evaluated after Turn, Tip (Roll), Scale and a bake - and held through a drag ===');
  {
    /* Roll: a 20x20x60 column stands (square footprint - old mapping); Roll Z
       lays it along X, and now the lean along its length is own Z. */
    await drop(files.column);
    const stand = await page.evaluate(() => window.__rot.names());
    check('a 20x20x60 column standing: square footprint, the old mapping', stand.names.square === true && stand.fbRing === 'fb',
      'footprint ' + stand.w.toFixed(1) + ' x ' + stand.d.toFixed(1));
    const rolled = await page.evaluate(() => { rollSelected(); window.nsoRotate.refresh(); return window.__rot.names(); });
    check('Roll Z lays it along X: front/back is now the lean along it - own Z', alongOK(rolled) && rolled.fbRing === 'ss',
      'footprint ' + rolled.w.toFixed(1) + ' x ' + rolled.d.toFixed(1) + ', front/back = ' + rolled.fbRing);
    const tipped = await page.evaluate(() => { window.__rot.zero(); tipSelected(); window.nsoRotate.refresh(); return window.__rot.names(); });
    check('Tip X lays it along Z instead: front/back is own X, about the plate\'s X, end over end along it',
      alongOK(tipped) && tipped.fbRing === 'fb', 'footprint ' + tipped.w.toFixed(1) + ' x ' + tipped.d.toFixed(1));
    const tilt = await page.evaluate(() => { tiltSelected(1); bankSelected(1); window.nsoRotate.refresh(); const r = window.__rot.names(); return r; });
    check('...and the Tilt buttons (15° about each of its own axes) keep it consistent', alongOK(tilt),
      'footprint ' + tilt.w.toFixed(1) + ' x ' + tilt.d.toFixed(1));

    /* Scale and a bake, on a bar, with the names read cold - no refresh. */
    await drop(files.bar);
    const scaled = await page.evaluate(() => {
      const before = window.__rot.names();
      const r = NSO_scaleSelectedModel({ axis: 'x', targetMm: 120 });
      return { ok: !!(r && r.ok), before: before, after: window.__rot.names() };
    });
    check('Scale (60 → 120 mm): names re-read on the new piece, still along-length = front/back',
      scaled.ok && scaled.after.w > 100 && alongOK(scaled.after),
      'footprint ' + scaled.before.w.toFixed(1) + ' → ' + scaled.after.w.toFixed(1));

    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(250);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); window.__rot.zero(); });
    const baked = await page.evaluate(() => {
      const m = getActiveModel(), before = window.__rot.names();
      const t = Array.from(m.rawTris);
      for (let i = 0; i < t.length; i += 3) t[i] *= 3;              // raw X: 20 → 60 mm, a bake of the geometry
      const ok = NSO_sculptCommitRaw(m, new Float32Array(t), 'scaleReplace', 'test bake');
      return { ok: ok, before: before, after: window.__rot.names() };
    });
    check('a bake that stretches a square piece to 60x20: the names follow with no event to forget',
      baked.ok && baked.before.names.square === true && baked.after.names.square === false && alongOK(baked.after) &&
      baked.after.fbRing === 'ss', 'footprint ' + baked.before.w.toFixed(1) + ' x ' + baked.before.d.toFixed(1) +
      ' → ' + baked.after.w.toFixed(1) + ' x ' + baked.after.d.toFixed(1));
    const undone = await page.evaluate(() => { document.getElementById('btn-undo').click(); return window.__rot.names(); });
    check('...and Undo of the bake puts the old mapping back', undone.names.square === true && undone.fbRing === 'fb',
      JSON.stringify(undone.names.roles));

    /* A drag holds the names. A 60x20 bar at 40° has the along lean on own Z;
       dragged Turn through 45° its box goes square for a few degrees. */
    await drop(files.bar);
    const held = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot;
      a.turn('turn', 40);
      a.setRing('ss', true);
      H.cam(0, 35); a.refresh();
      const start = a.leanNames().along;
      const c = a.centreScreen(), h = a.handleScreen('turn', 1);
      const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
      const yaw = () => { const e = new THREE.Euler().setFromQuaternion(H.q(), 'XYZ'); return e.y * 180 / Math.PI; };
      const y0 = yaw();
      /* try the pointer's two ways round for the one that carries the yaw toward 45 */
      const tryWay = way => {
        a.beginDrag({ ring: 'turn', dir: 1 }, h.x, h.y, c.x, c.y);
        a.moveDrag(c.x + Math.cos(a0 + way * 6 * Math.PI / 180) * R, c.y + Math.sin(a0 + way * 6 * Math.PI / 180) * R);
        const moved = Math.abs(yaw()) > Math.abs(y0);
        return moved;
      };
      let way = 1;
      if (!tryWay(1)) { a.endDrag(true); window.nsoRotate.turn('turn', 0); way = -1; tryWay(-1); }
      const seen = [], squareNow = [];
      for (let d = 6; d <= 9; d += 0.5) {
        a.moveDrag(c.x + Math.cos(a0 + way * d * Math.PI / 180) * R, c.y + Math.sin(a0 + way * d * Math.PI / 180) * R);
        seen.push(a.leanNames().along);
        const p = H.p(), big = Math.max(p.width, p.depth);
        squareNow.push(Math.abs(p.width - p.depth) <= 0.05 * big);
      }
      const mid = { yaw: yaw(), w: H.p().width, d: H.p().depth };
      a.endDrag();
      /* the names read the footprint itself now (pieceFrame), not the box on
         the plate: a 60 x 20 bar is 60 x 20 at every heading, square never */
      return { start: start, seen: seen, squareNow: squareNow, mid: mid, after: a.leanNames(),
               frameSquare: pieceFrame(H.p()).square };
    });
    check('mid-drag the names do not change, though the box passed through square',
      held.seen.every(x => x === held.start) && held.squareNow.some(x => x),
      'along = ' + held.start + ' throughout; box went square at ' + held.squareNow.filter(Boolean).length +
      ' of ' + held.squareNow.length + ' steps (yaw ' + held.mid.yaw.toFixed(1) + '°, ' + held.mid.w.toFixed(1) + ' x ' + held.mid.d.toFixed(1) + ')');
    check('...and on release they are read fresh from the footprint it landed on',
      /* re-pinned (pose-bake): was === the box's 5% squareness at the last
         step; the names follow pieceFrame's footprint, so it is that frame's */
      held.after.square === held.frameSquare && held.frameSquare === false,
      JSON.stringify({ square: held.after.square, along: held.after.along }));
  }

  /* ----------------------------------------------------------------- 23 */
  console.log('\n=== 23. the card: a row follows its ring, the tooltip says which way it tips ===');
  {
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); });
    const titleOf = id => page.evaluate(i => document.getElementById(i).parentNode.title, id);
    const boxes = () => page.evaluate(() => ['turn', 'fb', 'ss'].map(k => +document.getElementById('chk-rot-ring-' + k).checked).join(''));

    /* the bar (60x20, along X): the front/back ROW ticks the ring that tips it along its length */
    await page.evaluate(() => { window.__rot.zero(); window.nsoRotate.refresh(); });
    await page.click('#chk-rot-ring-fb'); await page.waitForTimeout(60);
    const onBar = await page.evaluate(() => ({ rings: window.nsoRotate.rings(), names: window.nsoRotate.leanNames(),
      readoutLabel: window.nsoRotate.ringLabel('ss') }));
    check('on the 60x20 bar the "Lean front/back" row ticks own Z (the ring along its length)',
      onBar.rings.join() === 'turn,ss' && onBar.names.along === 'ss' && onBar.readoutLabel === 'Lean front/back', onBar.rings.join());
    const tFb = await titleOf('chk-rot-ring-fb'), tSs = await titleOf('chk-rot-ring-ss');
    check('...its tooltip says it tips the piece along its length, the ends going up and down',
      /along its length/.test(tFb) && /ends go up and down/.test(tFb), tFb.slice(0, 70));
    check('...and the side/side tooltip says across its width, one long edge up', /across its width/.test(tSs) && /long edge/.test(tSs), tSs.slice(0, 70));
    const pressed = await page.evaluate(() => {
      const a = window.nsoRotate, h = a.handleScreen('ss', 1), c = a.centreScreen();
      a.beginDrag({ ring: 'ss', dir: 1 }, h.x, h.y, c.x, c.y);
      const d = { readout: a.dragState() && a.readout(), };
      a.moveDrag(h.x + 3, h.y + 30);
      d.readout = a.readout();
      a.endDrag();
      return d;
    });
    check('...the readout beside the pointer carries the same name', /^Lean front\/back/.test(pressed.readout), pressed.readout);

    /* a square piece: the old mapping, and a tooltip that admits it */
    await page.evaluate(() => { document.getElementById('btn-undo').click(); });
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(250);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);      // a fresh session: Turn only
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); window.__rot.zero(); window.nsoRotate.refresh(); });
    const sFb = await titleOf('chk-rot-ring-fb');
    check('on a square piece the tooltip says front over back, and that there is no long side',
      /front over back/.test(sFb) && /square/.test(sFb), sFb.slice(0, 90));

    /* the ring carries its row: tick front/back on the cube, bake it long, and the TICK moves to the other row */
    await page.evaluate(() => { window.nsoRotate.setRing('turn', false); window.nsoRotate.setRing('fb', true); });
    const before = await boxes();
    await page.evaluate(() => {
      const m = getActiveModel(), t = Array.from(m.rawTris);
      for (let i = 0; i < t.length; i += 3) t[i] *= 3;
      NSO_sculptCommitRaw(m, new Float32Array(t), 'scaleReplace', 'test bake');
      window.nsoRotate.refresh();
    });
    const after = await boxes();
    const ring = await page.evaluate(() => window.nsoRotate.rings().join());
    check('a bake that makes the cube long: the same ring (own X) stays drawn, and its tick moves to the "side/side" row',
      before === '010' && after === '001' && ring === 'fb', before + ' → ' + after + ', drawn ' + ring);
    await page.click('#chk-rot-ring-ss'); await page.waitForTimeout(50);
    check('...and unticking that row hides that ring', (await page.evaluate(() => window.nsoRotate.rings().length)) === 0);
    await page.evaluate(() => { document.getElementById('btn-undo').click(); });
  }

  /* ----------------------------------------------------------------- 24 */
  console.log('\n=== 24. Undo of a lean is unchanged, on a piece whose names are swapped ===');
  {
    await drop(files.bar);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(60);
    await page.click('#menu-rotate > summary'); await page.waitForTimeout(100);
    await page.evaluate(() => { window.__rot.drop(state.placed.length - 1); window.__rot.zero(); window.__rot.home(); });
    await page.click('#chk-rot-ring-fb'); await page.waitForTimeout(60);       // the row named front/back
    const pose = () => page.evaluate(() => { const p = window.__rot.p();
      return { q: window.__rot.q().toArray(), f: [p.tipX, p.tipZ, p.flipX, p.tiltX, p.tiltZ, p.rotY, p.liftY || 0] }; });
    const p0 = await pose();
    const drags = [];
    for (const kind of ['drag', 'click']) {
      const ring = await page.evaluate(() => window.nsoRotate.rings().find(r => r !== 'turn'));
      const h = await page.evaluate(r => window.nsoRotate.handleScreen(r, 1), ring);
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
      await page.waitForTimeout(700);                                          // let the run seat
      drags.push({ ring: ring, pose: await pose() });
    }
    const ang = (a, b) => page.evaluate(([x, y]) => window.__rot.angleDeg(new THREE.Quaternion().fromArray(x), new THREE.Quaternion().fromArray(y)), [a, b]);
    check('a drag and a click on the ring named front/back (own Z here) each move the piece',
      drags[0].ring === 'ss' && (await ang(p0.q, drags[0].pose.q)) > 20 && (await ang(drags[0].pose.q, drags[1].pose.q)) > 0.9,
      'ring ' + drags[0].ring);
    await page.click('#btn-undo'); await page.waitForTimeout(80);
    const u1 = await pose();
    await page.click('#btn-undo'); await page.waitForTimeout(80);
    const u2 = await pose();
    check('Undo, Undo: each press stepped back exactly, pose fields and all',
      (await ang(drags[0].pose.q, u1.q)) < 1e-6 && (await ang(p0.q, u2.q)) < 1e-6 &&
      JSON.stringify(u2.f) === JSON.stringify(p0.f), 'fields ' + p0.f.join(',') + ' → ' + u2.f.join(','));
  }

  /* ----------------------------------------------------------------- 25 */
  console.log('\n=== 25. detents: absolute, on the ring\'s own ticks, every 45°; lit; named in the readout ===');
  {
    const r = await page.evaluate(() => {
      const a = window.nsoRotate, H = window.__rot, K = a.constants;
      const grp = () => state.scene.getObjectByName('nso-rotate-handles');
      const near45 = d => Math.round(d / 45) * 45;
      const sameAng = (x, y) => Math.abs(((x - y) % 360 + 540) % 360 - 180) < 1e-6;
      /* the painted tick at `deg` on a ring: its outer-edge direction from the scale mesh */
      const paintedDir = (ring, deg) => {
        const t = grp().children.find(c => c.userData.nsoRotateTicks === ring);
        const i = (((deg % 360) + 360) % 360) / 5 * 6, e = t.userData.nsoTickEnds;
        return new THREE.Vector3(e[i + 3], e[i + 4], e[i + 5]).normalize();
      };
      const litMeshes = ring => grp().children.filter(c => c.userData.nsoRotateLit && c.userData.nsoRotateLit.ring === ring);
      const litOnPainted = ring => {
        const m = litMeshes(ring), want = a.litTick(ring);
        if (want == null) return m.length === 0;
        if (m.length !== 1 || !sameAng(m[0].userData.nsoRotateLit.deg, want)) return false;
        const e = m[0].userData.nsoTickEnds, d = new THREE.Vector3(e[3], e[4], e[5]).normalize();
        return d.dot(paintedDir(ring, want)) > 1 - 1e-9;
      };
      const setup = (ring, start, cam) => {
        H.zero();
        if (cam) H.camera(new THREE.Vector3(cam[0], cam[1], cam[2])); else H.home();
        ['turn', 'fb', 'ss'].forEach(k => a.setRing(k, k === ring));
        a.turn(ring, start - a.ringAngle(ring));
        return a.ringAngle(ring);
      };
      /* drag the ring's angle `dirn` (+1 up, -1 down) until the first detent is met */
      const firstHit = (ring, start, dirn, cam) => {
        const abs0 = setup(ring, start, cam), sign = a.dialSign(ring);
        const c = a.centreScreen(), R = 160;
        const at = d => ({ x: c.x + Math.cos(d * Math.PI / 180) * R, y: c.y + Math.sin(d * Math.PI / 180) * R });
        const p0 = at(0);
        a.beginDrag({ ring: ring, dir: 1 }, p0.x, p0.y, c.x, c.y);
        let hit = null;
        for (let i = 1; i <= 240 && !hit; i++) {
          const q = at(sign * dirn * i * 0.5); a.moveDrag(q.x, q.y);
          if (a.dragState().snapped) hit = { pointer: abs0 + a.dragState().raw, piece: a.ringAngle(ring), lit: a.litTick(ring),
                                             litOK: litOnPainted(ring), readout: a.readout(), darts: a.dartTick(ring) };
        }
        a.endDrag();
        return { abs0, hit };
      };
      const out = { first: [], K: { DETENT_DEG: K.DETENT_DEG, SNAP_WITHIN_DEG: K.SNAP_WITHIN_DEG } };
      for (const ring of ['turn', 'fb', 'ss'])
        for (const start of [7, 23, 61])
          for (const dirn of [1, -1]) {
            const f = firstHit(ring, start, dirn);
            const want = dirn > 0 ? Math.floor(f.abs0 / 45) * 45 + 45 : Math.ceil(f.abs0 / 45) * 45 - 45;
            out.first.push({ ring, start, dirn, abs0: f.abs0, want, hit: f.hit });
          }
      /* the darts' seat and the drag's start are nothing to the detent: three cameras, three seats */
      out.seats = [[140, 160, 200], [-200, 90, 40], [30, 120, -220]].map(cam => {
        const f = firstHit('turn', 23, 1, cam);
        return { cam, want: 45, hit: f.hit, seat: f.hit && f.hit.darts && f.hit.darts.index };
      });
      /* the window: 3° either side catches, a quarter degree beyond does not */
      out.window = [];
      for (const [off, wantSnap] of [[-2.75, true], [-3.25, false], [2.75, true], [3.25, false]]) {
        const abs0 = setup('turn', 20), sign = a.dialSign('turn');
        const tr = H.trace('turn', sign * (45 + off - abs0), { step: 0.25 });
        out.window.push({ off, wantSnap, snapped: tr.state.snapped, applied: tr.state.applied, raw: tr.state.raw,
                          at: a.ringAngle('turn') });
      }
      /* 12 seeded random drags: whenever a tick is lit it is a painted one the piece is within 3° of,
         and one is lit exactly when the piece is within 3° of a multiple of 45 */
      let seed = 4242;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      out.random = [];
      for (let n = 0; n < 12; n++) {
        const ring = ['turn', 'fb', 'ss'][Math.floor(rnd() * 3)];
        const start = rnd() * 360, span = (rnd() < 0.5 ? -1 : 1) * (30 + rnd() * 250);
        const abs0 = setup(ring, start), sign = a.dialSign(ring);
        const c = a.centreScreen(), R = 160;
        const at = d => ({ x: c.x + Math.cos(d * Math.PI / 180) * R, y: c.y + Math.sin(d * Math.PI / 180) * R });
        const p0 = at(0);
        a.beginDrag({ ring: ring, dir: 1 }, p0.x, p0.y, c.x, c.y);
        let steps = 0, lit = 0, bad = 0, wrongSet = 0, unnamed = 0;
        const N = Math.round(Math.abs(span) / 0.5);
        for (let i = 1; i <= N; i++) {
          const q = at(sign * Math.sign(span) * i * 0.5); a.moveDrag(q.x, q.y);
          const ang = a.ringAngle(ring), L = a.litTick(ring), inWin = Math.abs(ang - near45(ang)) <= 3 + 1e-9;
          steps++;
          if (L != null) {
            lit++;
            if (!litOnPainted(ring) || !sameAng(L, near45(ang)) || L % 45 !== 0) bad++;
            /* the readout is written once the press has become a drag (past the click slop) */
            if (a.dragState().moved && !new RegExp(' · on ' + L + '°$').test(a.readout())) unnamed++;
          }
          if ((L != null) !== inWin) wrongSet++;
        }
        a.endDrag();
        out.random.push({ ring, start: +abs0.toFixed(1), span: +span.toFixed(1), steps, lit, bad, wrongSet, unnamed });
      }
      H.zero(); H.home(); a.setRing('fb', false); a.setRing('ss', false);
      return out;
    });
    const sameAng = (x, y) => near(((x - y) % 360 + 540) % 360 - 180, 0, 1e-6);
    check('the detent is every 45° and the window 3°', r.K.DETENT_DEG === 45 && r.K.SNAP_WITHIN_DEG === 3, JSON.stringify(r.K));
    const f = r.first;
    check('from 7°, 23° and 61°, both ways, on every ring: the first detent met is the NEXT painted tick, not start±45',
      f.every(x => x.hit && sameAng(x.hit.piece, x.want)),
      f.filter(x => !(x.hit && sameAng(x.hit.piece, x.want))).map(x => x.ring + ' ' + x.start + (x.dirn > 0 ? '↑' : '↓') + ' wanted ' + x.want +
        ' got ' + (x.hit && x.hit.piece.toFixed(2))).join('; ') || f.length + ' drags');
    check('...and not start±45 for any of them (7→45, 23→45, 61→90 going up)',
      f.filter(x => x.dirn > 0).every(x => ({ 7: 45, 23: 45, 61: 90 })[x.start] === Math.round(x.hit.piece)),
      f.filter(x => x.dirn > 0 && x.ring === 'turn').map(x => x.start + '→' + x.hit.piece.toFixed(1)).join(' '));
    check('the pointer met it within 3° of the tick (the window, not a pull)',
      f.every(x => Math.abs(x.hit.pointer - x.want) <= 3 + 1e-9), '');
    check('the tick that snapped is the one that is lit, and it is a painted tick of the ring',
      f.every(x => x.hit.litOK && x.hit.lit !== null && sameAng(x.hit.lit, x.want)), '');
    check('...and the readout says the angle it sits on',
      f.every(x => new RegExp(' · on ' + (((x.want % 360) + 360) % 360) + '°$').test(x.hit.readout)),
      f[0].hit.readout + ' | ' + f[5].hit.readout);
    check('the darts\' seat is nothing to it: three cameras, three seats, the same first detent',
      r.seats.every(x => x.hit && sameAng(x.hit.piece, x.want)) && new Set(r.seats.map(x => x.seat)).size > 1,
      r.seats.map(x => 'seat ' + x.seat + ' → ' + (x.hit && x.hit.piece.toFixed(1))).join(', '));
    check('the window is ±3°: 2.75° off snaps, 3.25° off does not, either side',
      r.window.every(w => w.snapped === w.wantSnap), r.window.map(w => w.off + ':' + w.snapped).join(' '));
    check('...and outside it the piece is exactly where the pointer says',
      r.window.filter(w => !w.wantSnap).every(w => near(w.applied, w.raw, 1e-9)), '');
    check('12 seeded random drags: a tick is lit exactly when the piece is within 3° of a multiple of 45',
      r.random.every(d => d.wrongSet === 0), r.random.map(d => d.wrongSet).join(','));
    check('...and the lit tick is always a painted tick of that ring, the one nearest the piece',
      r.random.every(d => d.bad === 0) && r.random.reduce((n, d) => n + d.lit, 0) > 12,
      r.random.reduce((n, d) => n + d.lit, 0) + ' lit steps of ' + r.random.reduce((n, d) => n + d.steps, 0));
    check('...and the readout names it every time it is lit', r.random.every(d => d.unnamed === 0), '');
  }

  /* ----------------------------------------------------------------- 26 */
  console.log('\n=== 26. after Tip, Flip, Turn: the leans lean - about the footprint\'s level sides, never a yaw ===');
  {
    files.box = writeBoxSTL(path.join(DIR, 'box40x20x10.stl'), 40, 20, 10);
    await drop(files.box);
    await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate;
      a.setRing('fb', true); a.setRing('ss', true);
      /* The footprint's long side as a heading in [0, 180): the narrowest
         rectangle round the shadow of the box's eight corners, tried along
         every pair of them - measured here from the corners alone, not from
         anything the module computes. */
      /* the box's own vertices, in the world (less the mesh's position): a
         bake turns and re-centres the geometry but keeps its vertex order, so
         vertex i is the same corner of the piece before and after */
      H.corners = () => {
        const p = H.p(), pos = p.mesh.geometry.attributes.position, out = [];
        p.mesh.updateMatrixWorld(true);
        for (let i = 0; i < pos.count; i++)
          out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld).sub(p.mesh.position));
        return out;
      };
      H.footYaw = () => {
        const pts = H.corners();
        let best = null;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j].x - pts[i].x, dz = pts[j].z - pts[i].z, l = Math.hypot(dx, dz);
          if (l < 1e-6) continue;
          const d = [dx / l, dz / l], n = [-d[1], d[0]];
          const ext = v => { const t = pts.map(c => c.x * v[0] + c.z * v[1]); return Math.max(...t) - Math.min(...t); };
          const ed = ext(d), en = ext(n);
          if (!best || ed * en < best.area - 1e-9) best = { area: ed * en, long: ed >= en ? d : n, ed, en };
        }
        return { yaw: ((Math.atan2(-best.long[1], best.long[0]) * 180 / Math.PI) % 180 + 180) % 180,
                 long: new THREE.Vector3(best.long[0], 0, best.long[1]),
                 size: [Math.max(best.ed, best.en), Math.min(best.ed, best.en)] };
      };
      H.yawDiff = (a, b) => Math.abs((((b - a) + 90) % 180 + 180) % 180 - 90);
      H.setups = {
        'Tip on side': () => window.nsoTipOrient.tipOnSide(),
        'Tip X 90': () => tipSelected(),
        'Flip': () => window.nsoTipOrient.flipOver(),
        'Tip on side, then Flip': () => { window.nsoTipOrient.tipOnSide(); window.nsoTipOrient.flipOver(); },
        'Turn 45, then Tip on side': () => { window.nsoRotate.turn('turn', 45); window.nsoTipOrient.tipOnSide(); }
      };
      /* what one piece pose looks like to the gate: its own axis that is
         most nearly upright, the footprint's heading, the corners */
      H.look = () => {
        const q = H.q(), own = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(b => new THREE.Vector3().fromArray(b).applyQuaternion(q));
        return { q, own, foot: H.footYaw(), corners: H.corners() };
      };
      /* Yaw is the part of the motion about the vertical: the twist of
         q1 * q0^-1 about it (swing-twist). A lean about a level line has none.
         The footprint's heading is the same thing seen on the plate, for a
         piece resting on a face; one balanced on an edge (Turn 45, then Tip:
         its box stands on a corner edge, 45 degrees each way) has a shadow
         whose narrowest rectangle swings as it tips even about a level line,
         so there the twist is the yaw and the heading is only reported. */
      H.gate = (before, after) => {
        const k = before.own.map(v => Math.abs(v.y)).reduce((m, y, i, all) => y > all[m] ? i : m, 0);
        const onFace = Math.abs(before.own[k].y) > 1 - 1e-9;
        const tilt = Math.acos(Math.min(1, Math.abs(after.own[k].y))) * 180 / Math.PI;
        const d = after.q.clone().multiply(before.q.clone().invert());
        const ax = new THREE.Vector3(d.x, d.y, d.z), s = ax.length();
        const turnedBy = 2 * Math.atan2(s, Math.abs(d.w)) * 180 / Math.PI;
        const twist = Math.abs(2 * Math.atan2(d.y, d.w) * 180 / Math.PI);
        const yaw = Math.min(twist, 360 - twist);
        /* every corner's height change, about the pivot: one side up, the other down */
        const dys = before.corners.map((c, i) => after.corners[i].y - c.y);
        return { turnedBy, onFace, tilt, axisUp: s > 1e-12 ? Math.abs(ax.y / s) : 0, yaw,
                 heading: H.yawDiff(before.foot.yaw, after.foot.yaw), up: Math.max(...dys), down: Math.min(...dys),
                 foot: after.foot.size.map(v => +v.toFixed(2)) };
      };
    });

    const rows = [];
    const names = await page.evaluate(() => Object.keys(window.__rot.setups));
    for (const setup of names) {
      for (const ring of ['fb', 'ss']) {
        /* a dial drag of 10° on the ring, through the entry points app-core calls */
        const r = await page.evaluate(([setup, ring]) => {
          const H = window.__rot, a = window.nsoRotate;
          H.zero(); H.setups[setup](); a.refresh(); H.home();
          const b0 = H.look(), A0 = H.axisVec(ring);
          const old = (() => {           // what the dart did before: q0 * R(own X | own Z, 10)
            const q1 = b0.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(ring === 'fb' ? 1 : 0, 0, ring === 'ss' ? 1 : 0), 10 * Math.PI / 180));
            /* q1 is the body it would have had; the mesh carries what the
               geometry does not: q1 * body^-1 on top of the mesh's own */
            const p = H.p(), q = p.mesh.quaternion.clone();
            p.mesh.quaternion.copy(q1.clone().multiply(b0.q.clone().invert()).multiply(q)); p.mesh.updateMatrixWorld(true);
            const y = H.footYaw().yaw;
            p.mesh.quaternion.copy(q); p.mesh.updateMatrixWorld(true);
            return H.yawDiff(b0.foot.yaw, y);
          })();
          const role = a.ringLabel(ring), along = a.leanNames().along;
          const tr = H.trace(ring, a.dialSign(ring) * 10);
          const b1 = H.look();
          const g = H.gate(b0, b1);
          return Object.assign(g, { setup, ring, role, along, applied: tr.state.applied, oldYaw: old,
                                    A0: A0.toArray().map(v => +v.toFixed(6)),
                                    wantErr: H.angleDeg(H.want(ring, b0.q, tr.state.applied, A0), b1.q) });
        }, [setup, ring]);
        /* ...and a real click on the dart: one more degree, the same way */
        const h = await page.evaluate(r => { window.__rot.look0 = window.__rot.look(); return window.nsoRotate.handleScreen(r, 1); }, ring);
        await page.mouse.click(h.x, h.y);
        await page.waitForTimeout(700);                                        // let the run seat
        r.click = await page.evaluate(() => window.__rot.gate(window.__rot.look0, window.__rot.look()));
        rows.push(r);
      }
    }
    console.log('   setup                       ring  role             axis               drag   tilt     yaw      heading  axis.up  corners       click  yaw     | old dart yaw');
    for (const r of rows) {
      console.log('   ' + r.setup.padEnd(27) + ' ' + r.ring.padEnd(4) + '  ' + r.role.padEnd(16) + ' ' +
        JSON.stringify(r.A0.map(v => Math.abs(v) < 1e-6 ? 0 : v)).padEnd(17) + ' ' + r.applied.toFixed(2).padStart(6) + ' ' +
        (r.onFace ? r.tilt.toFixed(3) : 'edge').padStart(6) + ' ' + r.yaw.toExponential(1).padStart(8) + ' ' +
        r.heading.toExponential(1).padStart(8) + ' ' + r.axisUp.toExponential(1).padStart(8) + '  ' +
        ('+' + r.up.toFixed(2) + '/' + r.down.toFixed(2)).padEnd(13) + ' ' + r.click.turnedBy.toFixed(3).padStart(6) + ' ' +
        r.click.yaw.toExponential(1).padStart(8) + ' | ' + r.oldYaw.toFixed(2) + '°');
    }
    for (const setup of names) {
      const mine = rows.filter(r => r.setup === setup);
      check(setup + ': a 10° drag on each lean dart tips the piece 10° about a level line' +
        (mine[0].onFace ? ' - its upright axis leans 10°' : ' (it stands on an edge: no upright axis to read)'),
        mine.every(r => near(Math.abs(r.applied), 10, 1e-6) && near(r.turnedBy, 10, 1e-6) && r.axisUp < 1e-9 &&
          (!r.onFace || near(r.tilt, 10, 1e-6))),
        mine.map(r => r.ring + ' ' + r.turnedBy.toFixed(6) + '°' + (r.onFace ? ', upright axis ' + r.tilt.toFixed(6) + '°' : '') +
          ', axis.up ' + r.axisUp.toExponential(1)).join('; '));
      check(setup + ': ...one side of it rises and the other drops',
        mine.every(r => r.up > 0.5 && r.down < -0.5), mine.map(r => r.ring + ' +' + r.up.toFixed(2) + '/' + r.down.toFixed(2) + ' mm').join(', '));
      check(setup + ': ...and its yaw is unchanged within 0.1°' + (mine[0].onFace ? ' - the footprint keeps its heading too' : ''),
        mine.every(r => r.yaw <= 0.1 && (!r.onFace || r.heading <= 0.1)),
        mine.map(r => r.ring + ' yaw ' + r.yaw.toExponential(1) + '°, heading ' + r.heading.toExponential(1) + '°').join('; '));
      check(setup + ': ...the turn is R(the axis the ring had at the press, 10°) * q0',
        mine.every(r => r.wantErr < 1e-6), mine.map(r => r.wantErr.toExponential(1)).join(' '));
      check(setup + ': a real click on each dart: 1° more, still a lean, still no yaw',
        mine.every(r => near(r.click.turnedBy, 1, 1e-6) && r.click.yaw <= 0.1 && r.click.axisUp < 1e-9 &&
          (!r.click.onFace || r.click.heading <= 0.1)),
        mine.map(r => r.ring + ' ' + r.click.turnedBy.toFixed(6) + '°, yaw ' + r.click.yaw.toExponential(1)).join('; '));
    }
    const tipped = rows.filter(r => r.setup === 'Tip on side' || r.setup === 'Tip X 90');
    check('the bug, for the record: before, one dart on a tipped piece turned it about the vertical (yaw 10°)',
      tipped.some(r => near(r.oldYaw, 10, 1e-3)), tipped.map(r => r.ring + ' ' + r.oldYaw.toFixed(3) + '°').join(', '));

    /* the names still follow the long side (#219) once the piece is tipped */
    const nm = await page.evaluate(() => {
      const H = window.__rot, out = {};
      for (const k of ['Tip on side', 'Turn 45, then Tip on side']) {
        H.zero(); H.setups[k](); window.nsoRotate.refresh();
        const f = H.footYaw(), A = ring => H.axisVec(ring);
        out[k] = Object.assign(H.names(), { foot: f.size });
        out[k].fbAcross = out[k].fbRing ? Math.abs(A(out[k].fbRing).dot(f.long)) : 1;
        out[k].ssAlong = out[k].ssRing ? Math.abs(A(out[k].ssRing).dot(f.long)) : 0;
      }
      H.zero();
      return out;
    });
    for (const k in nm) {
      /* about the line ACROSS the long side, so its ends rise; side/side about the long side itself */
      check(k + ': the lean named front/back tips the piece along the long side of its new footprint',
        nm[k].fbRing && nm[k].ssRing && nm[k].fbRing !== nm[k].ssRing && nm[k].fbAcross < 1e-6 && near(nm[k].ssAlong, 1, 1e-6),
        'footprint ' + nm[k].foot.map(v => v.toFixed(1)).join(' x ') + ', front/back = ring ' + nm[k].fbRing +
        ' (axis . long side ' + nm[k].fbAcross.toExponential(1) + '), side/side = ring ' + nm[k].ssRing +
        ' (' + nm[k].ssAlong.toFixed(6) + ')');
    }

    /* an untipped piece: exactly as before - the numbers pinned from the code
       this replaced (q0 * R(own X | own Z, d)) */
    const pin = await page.evaluate(() => {
      const H = window.__rot, a = window.nsoRotate, p = H.p();
      const rec = () => { const q = H.q(); return { f: [p.tipX, p.tipZ, p.flipX, p.tiltX, +(p.rotY * 180 / Math.PI).toFixed(9), p.tiltZ], q: [q.x, q.y, q.z, q.w] }; };
      const out = {};
      H.zero(); a.turn('fb', 10); out.fb10 = rec();
      H.zero(); a.turn('ss', 10); out.ss10 = rec();
      H.zero(); a.turn('turn', 45); a.turn('fb', 10); out.t45fb10 = rec();
      H.zero(); a.turn('turn', 45); a.turn('ss', 10); out.t45ss10 = rec();
      /* and the dart itself, dragged 10° on a fresh piece: own X / own Z, postmultiplied */
      out.drag = ['fb', 'ss'].map(ring => {
        H.zero(); H.home(); const q0 = H.q();
        const tr = H.trace(ring, a.dialSign(ring) * 10);
        const want = q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(ring === 'fb' ? 1 : 0, 0, ring === 'ss' ? 1 : 0), tr.state.applied * Math.PI / 180));
        return H.angleDeg(want, H.q());
      });
      H.zero();
      return out;
    });
    const PIN = {
      fb10:    { f: [0, 0, false, 10, 0, 0], q: [0.087155742748, 0, 0, 0.996194698092] },
      ss10:    { f: [0, 0, false, 0, 0, 10], q: [0, 0, 0.087155742748, 0.996194698092] },
      t45fb10: { f: [0, 0, false, 14.001942166, 44.136029464, -9.851076117], q: [0.080521406868, 0.38122720637, -0.033353058787, 0.920363891963] },
      t45ss10: { f: [0, 0, false, 0, 45, 10], q: [0.033353058785, 0.381227206369, 0.080521406865, 0.920363891963] }
    };
    for (const k in PIN) {
      const got = pin[k], want = PIN[k];
      const fOk = got.f.every((v, i) => typeof v === 'boolean' ? v === want.f[i] : near(v, want.f[i], 1e-8));
      const qOk = got.q.every((v, i) => near(v, want.q[i], 1e-11));
      check('untipped, ' + k + ': pose fields and quaternion exactly as before', fOk && qOk,
        'fields ' + got.f.map(v => typeof v === 'number' ? +v.toFixed(9) : v).join(',') + ' q ' + got.q.map(v => v.toFixed(12)).join(','));
    }
    check('untipped, a 10° drag on each dart: q0 * R(own X | own Z, 10), as before', pin.drag.every(d => d < 1e-9),
      pin.drag.map(d => d.toExponential(1)).join(' '));
    await page.evaluate(() => { window.nsoRotate.setRing('fb', false); window.nsoRotate.setRing('ss', false); });
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

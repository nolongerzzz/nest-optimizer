#!/usr/bin/env node
/* Viewport input: the wheel zooms toward the cursor, and a click that moves
   nothing does not say "Moved model #N". The ticket's drive-check, in the
   real app.

   node tools/nso_viewport_zoom_drive_check.js     exit 0 = every step held

   Real Chromium, real mouse wheel and real clicks (Playwright). Measured, not
   eyeballed: the world point under the cursor is found HERE, by this check's
   own raycast (first visible piece, else the plate's plane y = 0), and
   projected back to the screen after every wheel step. It must stay within
   1 px of the cursor - at three cursor positions, three zoom levels, in and
   out - and at the 15 and 1200 mm distance limits. Off the plate (more than
   10 mm past its edge) the plane point is not the anchor: the app clamps it
   to the nearest point of the plate rectangle + 10 mm (#201, the camera
   leash), so there it is THAT point which must hold its pixel, while the far
   ground point under the cursor must not. A wheel over nothing at all (above
   the horizon) keeps the old zoom about the orbit target.

   No screenshots. The pieces are the 80 x 40 x 20 box fixture and
   tape_on-edge-single, the pair the right-pan check uses. */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const px = (a) => '(' + a[0].toFixed(2) + ', ' + a[1].toFixed(2) + ')';
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TOL_PX = 1;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
  /* Both pieces placed and the view at rest - waited for, in frames, not slept for: a fixed 400 ms is a
     different amount of the app's work on every runner, and a read before the second piece is placed or the
     camera has come to rest measures the wrong spot. "At rest" is three frames with the camera and its target
     where they were (300 frames at most, so a view that never settles is still measured, and fails there). */
  await page.waitForFunction(() => state.placed.length === 2 && state.placed.every(p => p && p.mesh), null, { timeout: 60000 });
  await page.evaluate(() => new Promise(r => {
    let last = null, still = 0, n = 0;
    const f = () => {
      const k = state.camera.position.toArray().concat(state.controls.target.toArray()).map(v => v.toFixed(5)).join();
      still = k === last ? still + 1 : 0;
      last = k;
      if (still >= 3 || ++n >= 300) r(); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }));
  await page.evaluate(() => {
    const H = window.__z = {};
    const cv = state.renderer.domElement;
    H.rect = () => { const r = cv.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    H.proj = (a) => {
      const r = H.rect();
      state.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3().fromArray(a).project(state.camera);
      return [r[0] + (p.x * 0.5 + 0.5) * r[2], r[1] + (-p.y * 0.5 + 0.5) * r[3]];
    };
    H.cam = () => ({
      pos: state.camera.position.toArray(), tgt: state.controls.target.toArray(),
      quat: state.camera.quaternion.toArray(),
      d: state.camera.position.distanceTo(state.controls.target),
      minD: state.controls.minDistance, maxD: state.controls.maxDistance
    });
    /* The point under a pixel, by this check's own raycast - not the app's. */
    H.under = (x, y) => {
      const r = H.rect();
      const rc = new THREE.Raycaster();
      state.camera.updateMatrixWorld(true);
      rc.setFromCamera(new THREE.Vector2(((x - r[0]) / r[2]) * 2 - 1, -((y - r[1]) / r[3]) * 2 + 1), state.camera);
      const vis = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
      const hits = rc.intersectObjects(state.modelGroup.children, true)
        .filter(h => h.object.isMesh && vis(h.object) && h.distance >= state.camera.near && h.distance <= state.camera.far);
      if (hits.length) return { kind: 'piece', p: rc.ray.at(hits[0].distance, new THREE.Vector3()).toArray() };
      const g = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (!g || g.distanceTo(rc.ray.origin) > state.camera.far) return null;
      const onPlate = state.plateMesh && rc.intersectObject(state.plateMesh, false).length > 0;
      /* the app's anchor off the plate: the nearest point of plate + 10 mm */
      const pl = getCurrentPlate(), hw = pl.w / 2 + 10, hd = pl.d / 2 + 10;
      const a = [Math.min(hw, Math.max(-hw, g.x)), 0, Math.min(hd, Math.max(-hd, g.z))];
      const clamped = a[0] !== g.x || a[2] !== g.z;
      return { kind: onPlate ? 'plate' : 'ground', p: g.toArray(), a: clamped ? a : null };
    };
    H.onCanvas = (x, y) => document.elementFromPoint(x, y) === cv;
    /* A view at distance d from `tgt`, along the app's default direction. */
    H.view = (tgt, d, dir) => {
      const v = new THREE.Vector3().fromArray(dir || [160, 180, 200]).normalize().multiplyScalar(d);
      state.controls.target.fromArray(tgt);
      state.camera.position.fromArray(tgt).add(v);
      const c = state.controls; c.enableDamping = false; c.update(); c.enableDamping = true;
    };
    H.boxTop = () => { const p = state.placed[0]; return [p.mesh.position.x, p.height + 0.2, p.mesh.position.z]; };
  });
  const N = page.evaluate.bind(page);
  const frames = (n) => N(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  /* With damping on, OrbitControls keeps adding a decaying remainder of any
     orbit or pan; one undamped update() spends it, so a reading is final. */
  const settle = async () => {
    await frames(2);
    await N(() => { const c = state.controls; c.enableDamping = false; c.update(); c.enableDamping = true; });
    return N(() => window.__z.cam());
  };
  const wheelAt = async (x, y, dy, mods) => {
    await page.mouse.move(x, y);
    for (const k of mods || []) await page.keyboard.down(k);
    await page.mouse.wheel(0, dy);
    for (const k of mods || []) await page.keyboard.up(k);
    await frames(2);
    return settle();
  };
  const C0 = await N(() => window.__z.cam());

  console.log('\n=== 1. the point under the cursor stays under it (off the plate: its plate-edge anchor holds): 3 positions x 3 zoom levels, in and out ===');
  const box0 = await N(() => window.__z.boxTop());
  const boxBed = [box0[0], 0, box0[2]];
  const LEVELS = [60, 300, 900];
  const kinds = new Set();
  let worst = 0, steps = 0;
  for (const D of LEVELS) {
    await N(([t, d]) => window.__z.view(t, d), [boxBed, D]);
    await settle();
    const r = await N(() => window.__z.rect());
    /* on the box (a little off its centre, so it is not the target's pixel),
       and two fixed spots in the lower half of the canvas */
    const bt = await N(b => window.__z.proj(b), box0);
    const spots = [
      ['on the box', [bt[0] + 12, bt[1] + 6]],
      ['lower left', [r[0] + r[2] * 0.22, r[1] + r[3] * 0.78]],
      // 0.70 down, not 0.62: with the header gone (#224) the canvas is 60 px taller and 0.62 fell in the
      // gap between two pieces at d 300, where a zoom step crosses from the clamped plate edge onto a piece
      ['lower right', [r[0] + r[2] * 0.80, r[1] + r[3] * 0.70]]
    ];
    for (const [name, at] of spots) {
      for (const dir of ['in', 'out']) {
        await N(([t, d]) => window.__z.view(t, d), [boxBed, D]);
        const c0 = await settle();
        const label = 'd ' + D + ', ' + name + ', ' + dir + ' then back';
        const onCv = await N(a => window.__z.onCanvas(a[0], a[1]), at);
        const u = await N(a => window.__z.under(a[0], a[1]), at);
        if (!onCv || !u) { check(label + ': cursor on the canvas, over a piece or the plane', false, px(at)); continue; }
        kinds.add(u.kind);
        /* Clamped (ground off the plate): the plate-edge anchor holds the pixel
           it starts on, and the far ground point under the cursor drifts. */
        const anchorP = u.a || u.p;
        const s0 = await N(p => window.__z.proj(p), anchorP);
        const home = u.a ? s0 : at;
        const sign = dir === 'in' ? -1 : 1;
        let drift = dist2(s0, home), farDrift = 0, ok = true, dOk = true, prevD = c0.d;
        // three steps one way, three back
        for (let i = 0; i < 6; i++) {
          const way = i < 3 ? sign : -sign;
          const c = await wheelAt(at[0], at[1], 100 * way);
          const s = await N(p => window.__z.proj(p), anchorP);
          drift = Math.max(drift, dist2(s, home));
          if (u.a) farDrift = Math.max(farDrift, dist2(await N(p => window.__z.proj(p), u.p), at));
          if (way < 0 ? !(c.d < prevD) : !(c.d > prevD)) dOk = false;
          prevD = c.d;
          steps++;
        }
        const c1 = await N(() => window.__z.cam());
        ok = drift <= TOL_PX;
        worst = Math.max(worst, drift);
        if (u.a) {
          check(label + ' (' + u.kind + ', clamped to ' + px([u.a[0], u.a[2]]) + '): the plate-edge anchor holds its pixel within ' + TOL_PX + ' px at every step', ok,
            'worst ' + drift.toFixed(3) + ' px');
          check(label + ': the far ground point under the cursor is not the anchor (it drifts)', farDrift > TOL_PX,
            'far point ' + px([u.p[0], u.p[2]]) + ' drifted ' + farDrift.toFixed(3) + ' px');
        } else {
          check(label + ' (' + u.kind + '): within ' + TOL_PX + ' px of the cursor at every step', ok,
            'worst ' + drift.toFixed(3) + ' px');
        }
        check(label + ': each step went the way of the wheel (in = closer)', dOk);
        const back = Math.hypot(...c1.pos.map((x, i) => x - c0.pos[i])) + Math.hypot(...c1.tgt.map((x, i) => x - c0.tgt[i]));
        check(label + ': three back undo three forward (camera and target home to 1e-6 mm)', back < 1e-6, back.toExponential(2));
      }
    }
  }
  console.log('   ' + steps + ' wheel steps, worst ' + worst.toFixed(3) + ' px; under the cursor: ' + [...kinds].join(', '));
  check('the positions covered a piece and the bare plane', kinds.has('piece') && (kinds.has('plate') || kinds.has('ground')), [...kinds].join(', '));

  console.log('\n=== 2. a trackpad pinch (ctrl + wheel) takes the same path ===');
  await N(([t]) => window.__z.view(t, 300), [boxBed]);
  const cp0 = await settle();
  const pinchAt = await N(b => { const s = window.__z.proj(b); return [s[0] - 20, s[1] + 4]; }, box0);
  const up = await N(a => window.__z.under(a[0], a[1]), pinchAt);
  check('pinch spot is over the box', up && up.kind === 'piece');
  const cp1 = await wheelAt(pinchAt[0], pinchAt[1], -60, ['Control']);
  const sp = await N(p => window.__z.proj(p), up.p);
  check('pinch zoomed in', cp1.d < cp0.d, cp0.d.toFixed(2) + ' -> ' + cp1.d.toFixed(2));
  check('pinch kept the point under the cursor', dist2(sp, pinchAt) <= TOL_PX, dist2(sp, pinchAt).toFixed(3) + ' px');

  console.log('\n=== 3. the distance limits: 15 mm in, 1200 mm out ===');
  for (const lim of [{ name: 'in to 15', d: 24, dy: -300, want: 15 }, { name: 'out to 1200', d: 700, dy: 300, want: 1200 }]) {
    // aimed at the box's top face, so the camera is outside the box even at 15 mm
    await N(([t, d]) => window.__z.view(t, d), [box0, lim.d]);
    await settle();
    const at = await N(b => { const s = window.__z.proj(b); return [s[0] + 8, s[1] + 3]; }, box0);
    const u = await N(a => window.__z.under(a[0], a[1]), at);
    check(lim.name + ': cursor over the box', u && u.kind === 'piece');
    if (!u) continue;
    let drift = 0, finite = true, c = null, held = true, prev = null;
    for (let i = 0; i < 10; i++) {
      c = await wheelAt(at[0], at[1], lim.dy);
      const s = await N(p => window.__z.proj(p), u.p);
      drift = Math.max(drift, dist2(s, at));
      if (![...c.pos, ...c.tgt, c.d].every(Number.isFinite)) finite = false;
      if (prev && Math.abs(prev.d - lim.want) < 1e-9) {
        // already at the limit: the next step moves nothing at all
        if (c.pos.some((x, k) => x !== prev.pos[k]) || c.tgt.some((x, k) => x !== prev.tgt[k])) held = false;
      }
      prev = c;
    }
    check(lim.name + ': camera and target stay finite', finite);
    check(lim.name + ': distance ends on the limit', Math.abs(c.d - lim.want) < 1e-6, c.d.toFixed(6));
    check(lim.name + ': at the limit a further step moves nothing', held);
    check(lim.name + ': the point stayed under the cursor all the way', drift <= TOL_PX, drift.toFixed(3) + ' px');
  }
  const Cend = await N(() => window.__z.cam());
  check('OrbitControls min / max distance untouched', Cend.minD === C0.minD && Cend.maxD === C0.maxD, C0.minD + ' / ' + C0.maxD);

  console.log('\n=== 4. nothing under the cursor: zoom about the orbit target, as before ===');
  // eye level: the plane above the horizon is past the far plane
  await N(() => window.__z.view([0, 0, 0], 600, [0, 0.02, 1]));
  await settle();
  const r4 = await N(() => window.__z.rect());
  let sky = null;
  for (let y = r4[1] + 140; y < r4[1] + r4[3] / 2 && !sky; y += 10) {
    const at = [r4[0] + r4[2] * 0.6, y];
    if (await N(a => window.__z.onCanvas(a[0], a[1]) && !window.__z.under(a[0], a[1]), at)) sky = at;
  }
  check('found a canvas spot with nothing under it', !!sky, sky && px(sky));
  if (sky) {
    const c0 = await settle();
    const c1 = await wheelAt(sky[0], sky[1], -100);
    check('target unchanged (zoom about the target)', c1.tgt.every((x, i) => Math.abs(x - c0.tgt[i]) < 1e-9));
    check('distance scaled by 0.95', Math.abs(c1.d / c0.d - 0.95) < 1e-9, (c1.d / c0.d).toFixed(6));
  }

  console.log('\n=== 5. a click that moves nothing does not say "Moved model #N" ===');
  await N(() => {
    window.__z.view([0, 0, 0], Math.hypot(160, 180, 200));
    window.__st = [];
    const orig = window.setStatus;
    window.setStatus = function (m) { window.__st.push(String(m)); return orig.apply(this, arguments); };
  });
  await settle();
  const SENT = '--- status before the click ---';
  const snap = await N(() => (window.__snap = freezeCamera(), true));
  const gesture = async (label, opts) => {
    await N(() => { restoreCamera(window.__snap); selectPlaced(1); });
    const st0 = await N((s) => { window.__st = []; document.getElementById('status').textContent = s; return s; }, SENT);
    await settle();
    const before = await N(() => ({ x: state.placed[0].x, z: state.placed[0].z, undo: state.undoStack.length }));
    const at = await N(b => window.__z.proj(b), box0);
    if (opts.measure) await N(() => document.getElementById('btn-measure').click());
    await N(() => { window.__st = []; });
    if (opts.measure) await N(s => { document.getElementById('status').textContent = s; }, st0);
    await page.mouse.move(at[0], at[1]);
    if (opts.alt) await page.keyboard.down('Alt');
    await page.mouse.down();
    if (opts.drag) await page.mouse.move(at[0] + opts.drag, at[1], { steps: 8 });
    await page.mouse.up();
    if (opts.alt) await page.keyboard.up('Alt');
    await frames(3);
    const r = await N(() => ({
      status: document.getElementById('status').textContent, calls: window.__st.slice(),
      x: state.placed[0].x, z: state.placed[0].z, undo: state.undoStack.length, sel: state.selectedIndex,
      tgt: state.controls.target.toArray()
    }));
    if (opts.measure) await N(() => { document.getElementById('btn-measure').click(); if (window.nsoMeasureClear) window.nsoMeasureClear(); });
    r.moved = Math.hypot(r.x - before.x, r.z - before.z);
    r.undoDelta = r.undo - before.undo;
    r.saidMoved = r.calls.some(m => /^Moved model #/.test(m));
    console.log('   ' + label.padEnd(30) + ' moved ' + r.moved.toFixed(3) + ' mm, status "' + r.status + '", calls ' + JSON.stringify(r.calls));
    // put the box back where it started for the next gesture
    await N(b => { applyPlacedXZ(state.placed[0], b.x, b.z); }, before);
    return r;
  };
  const click = await gesture('click, no tool', {});
  check('click, no tool: piece did not move', click.moved === 0);
  check('click, no tool: no "Moved model" status', !click.saidMoved, JSON.stringify(click.calls));
  check('click, no tool: status left as it was', click.status === SENT, click.status);
  check('click, no tool: still selects the box (as before)', click.sel === 0, click.sel);
  check('click, no tool: no undo entry (as before)', click.undoDelta === 0);

  const alt = await gesture('Alt-click, no tool', { alt: true });
  check('Alt-click: piece did not move', alt.moved === 0);
  check('Alt-click: no "Moved model" status', !alt.saidMoved, JSON.stringify(alt.calls));
  check('Alt-click: the status is the look-at\'s own line, left standing', /^Look locked/.test(alt.status), alt.status);
  check('Alt-click: still re-aims the orbit target at the piece (as before)', Math.hypot(...alt.tgt) > 1, JSON.stringify(alt.tgt.map(v => +v.toFixed(2))));
  check('Alt-click: still selects the box (as before)', alt.sel === 0, alt.sel);
  check('Alt-click: no undo entry (as before)', alt.undoDelta === 0);

  const drag = await gesture('drag 60 px, no tool', { drag: 60 });
  check('drag: the piece moved', drag.moved > 1, drag.moved.toFixed(2) + ' mm');
  check('drag: status says "Moved model #1"', drag.status === 'Moved model #1', drag.status);
  check('drag: one undo entry', drag.undoDelta === 1);

  const altDrag = await gesture('Alt-drag 60 px, no tool', { alt: true, drag: 60 });
  check('Alt-drag: the piece moved (as before)', altDrag.moved > 1, altDrag.moved.toFixed(2) + ' mm');
  check('Alt-drag: status says "Moved model #1"', altDrag.status === 'Moved model #1', altDrag.status);

  const mClick = await gesture('click, Measure armed', { measure: true });
  check('Measure armed, click: no "Moved model" status (as before)', !mClick.saidMoved && mClick.moved === 0, mClick.status);
  const mAlt = await gesture('Alt-click, Measure armed', { measure: true, alt: true });
  check('Measure armed, Alt-click: no "Moved model" status (as before)', !mAlt.saidMoved && mAlt.moved === 0, mAlt.status);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' FAILED' : 'all checks passed'));
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });

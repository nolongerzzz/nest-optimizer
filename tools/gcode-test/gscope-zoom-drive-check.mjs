#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-zoom-drive-check.mjs
 *
 * G-scope's wheel zooms toward the cursor - the main viewport's behaviour
 * (#154, nso_viewport_zoom_drive_check.js) on G-scope's own OrbitControls.
 * Real Chromium, real mouse wheel, real drags and a real two-finger touch.
 *
 * Measured, not eyeballed: the world point under the cursor is found HERE, by
 * this check's own raycast - the first DRAWN thing of the document (a visible
 * object with a visible material, at a point its clipping planes keep; a line
 * within the reach a line pick uses), else the bed plane y = 0 where the bed
 * grid is drawn - and projected back to the screen after every wheel step.
 *
 *   1  THE POINT HOLDS. 3 cursor positions (two on the part, one on the bed)
 *      x 3 zoom levels, 3 steps in then 3 back and 3 out then 3 back: the
 *      point stays within 1 px of the cursor at every step; the camera-to-
 *      point distance scales by exactly the wheel step (so the zoom is ABOUT
 *      that point, not about another one on the same ray); the view never
 *      turns; three steps back return camera and target to where they began
 *      (whenever the point under the cursor stayed the same one - on a line
 *      the nearest line can change on the way, and then each step is checked
 *      about the point under the cursor at that step).
 *   2  WHAT COUNTS AS UNDER THE CURSOR. The solid view (the line meshes stay
 *      in the scene with their material off - not drawn, not an anchor), and
 *      a mesh document clipped by the layer range (what the clip removed is
 *      not drawn, not an anchor). Over nothing - past the bed grid - the zoom
 *      is the old one about the target, to the bit.
 *   3  LIMITS. Still no floor and no ceiling (a hundredth of a millimetre to
 *      past a kilometre, off-centre), the frustum holding everything drawn
 *      and the point holding at both ends. OrbitControls' own minDistance /
 *      maxDistance still bound the wheel, exactly, with the point held.
 *   4  NOTHING ELSE CHANGES. One step is OrbitControls' 0.95 whatever the
 *      deltaY; deltaY 0 moves nothing; middle-drag and two-finger touch still
 *      dolly about the target; a wheel over the feature list does not zoom;
 *      with the controls off (a box-handle drag) the wheel moves nothing; the
 *      controls are as G-scope set them.
 *
 * No screenshots.
 *
 * Usage:
 *   node tools/gcode-test/gscope-zoom-drive-check.mjs
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const TOL_PX = 1;
const STEP = 0.95;                       // OrbitControls' wheel step, zoomSpeed 1

const px = (a) => '(' + a[0].toFixed(1) + ', ' + a[1].toFixed(1) + ')';
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a, b, tol) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/* Installed once per document: the check's own measuring tools. */
function install() {
  const M = window.NSO_MICROSCOPE, v = M.getView(), cv = v.renderer.domElement;
  const H = window.__gz = {};
  H.rect = () => { const r = cv.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  H.proj = (a) => {
    const r = H.rect();
    v.camera.updateMatrixWorld(true);
    const p = new THREE.Vector3().fromArray(a).project(v.camera);
    return [r[0] + (p.x * 0.5 + 0.5) * r[2], r[1] + (-p.y * 0.5 + 0.5) * r[3]];
  };
  H.cam = () => {
    const c = v.camera, o = v.controls, t = o.target;
    const sph = v.worldSphere;
    return {
      pos: c.position.toArray(), tgt: t.toArray(), quat: c.quaternion.toArray(),
      d: c.position.distanceTo(t), near: c.near, far: c.far,
      minD: o.minDistance, maxD: o.maxDistance, zoom: o.enableZoom, zoomSpeed: o.zoomSpeed,
      enabled: o.enabled, pan: o.enablePan, rotate: o.enableRotate,
      holdsWorld: !!sph && c.far >= c.position.distanceTo(sph.center) + sph.radius &&
                  c.near <= c.position.distanceTo(t) / 100 + 1e-12,
      finite: [...c.position.toArray(), ...t.toArray()].every(Number.isFinite),
    };
  };
  /* The point under a pixel, by this check's own raycast - not the app's. */
  H.under = (x, y) => {
    const r = H.rect(), c = v.camera, rc = new THREE.Raycaster();
    c.updateMatrixWorld(true);
    rc.setFromCamera(new THREE.Vector2(((x - r[0]) / r[2]) * 2 - 1, -((y - r[1]) / r[3]) * 2 + 1), c);
    rc.near = c.near; rc.far = c.far;
    rc.params.Line.threshold = Math.max(0.05, c.position.distanceTo(v.controls.target) * 0.006);
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const drawn = (h) => {
      const o = h.object, m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!(o.isMesh || o.isLine) || !shown(o) || !m || !m.visible) return false;
      return (m.clippingPlanes || []).every((pl) => pl.distanceToPoint(h.point) >= -1e-6);
    };
    const hits = rc.intersectObjects([v.overviewGroup, v.detailGroup, v.highlightGroup], true).filter(drawn);
    if (hits.length) {
      return { kind: 'part', p: rc.ray.at(hits[0].distance, new THREE.Vector3()).toArray(),
               what: hits[0].object.type + ' ' + (hits[0].object.userData.feature || '') };
    }
    const g = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (g && g.distanceTo(rc.ray.origin) <= c.far && Math.abs(g.x) <= 60 && Math.abs(g.z) <= 60) {
      return { kind: 'bed', p: g.toArray(), what: 'bed' };
    }
    return null;
  };
  H.onCanvas = (x, y) => document.elementFromPoint(x, y) === cv;
  /* Damping's remainder spent, so a reading is final. */
  H.spend = () => { const o = v.controls; o.enableDamping = false; o.update(); o.enableDamping = true; };
  /* A view at distance d from `tgt`, along `dir` (camera minus target). */
  H.view = (tgt, d, dir) => {
    H.spend();
    const w = new THREE.Vector3().fromArray(dir).normalize().multiplyScalar(d);
    v.controls.target.fromArray(tgt);
    v.camera.position.fromArray(tgt).add(w);
    H.spend();
  };
  /* Canvas pixels, a 24 px grid inside a 30 px margin, with what is under each. */
  H.scan = () => {
    const r = H.rect(), out = [];
    for (let y = r[1] + 30; y < r[1] + r[3] - 30; y += 24) {
      for (let x = r[0] + 30; x < r[0] + r[2] - 30; x += 24) {
        if (!H.onCanvas(x, y)) continue;
        const u = H.under(x, y);
        out.push({ at: [x, y], kind: u ? u.kind : null });
      }
    }
    return out;
  };
  /* N synthetic wheel events at (x, y): OrbitControls' and G-scope's listeners
     both see a dispatched event exactly as a real one. Speed only. */
  H.wheelN = (x, y, dy, n) => {
    for (let i = 0; i < n; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }
  };
}

async function main() {
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  gscopeCards.install(page);
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE, null, { timeout: 30000 });
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  await page.click('#ms-mode-piece');
  await page.evaluate(install);

  const N = page.evaluate.bind(page);
  const frames = (n = 2) => N((k) => new Promise((r) => {
    let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f);
  }), n);
  // A reading: damping's remainder spent, then the camera. No frame needed -
  // the wheel moves the camera inside its own handler.
  const settle = () => N(() => { window.__gz.spend(); return window.__gz.cam(); });
  const wheelAt = async (at, dy) => {
    await page.mouse.move(at[0], at[1]);
    await page.mouse.wheel(0, dy);
    return settle();
  };

  let T_LAP = Date.now();
  const lap = () => { console.log(`       (${((Date.now() - T_LAP) / 1000).toFixed(0)} s)`); T_LAP = Date.now(); };
  const C0 = await settle();
  // G-scope opens framed on both plates (docs/GSCOPE.md). The levels below are
  // about the part, so they start from the view that frames the part alone -
  // frameBox's own target and distance for it - looking the way G-scope opens.
  const PART = await N(() => {
    const v = window.NSO_MICROSCOPE.getView(), box = new THREE.Box3();
    v.overviewGroup.children.forEach((m) => { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); });
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    return { t: box.getCenter(new THREE.Vector3()).toArray(), d: (r / Math.sin((v.camera.fov * Math.PI / 180) / 2)) * 1.1 };
  });
  const T0 = PART.t, D0 = PART.d;
  const DIR0 = C0.pos.map((x, i) => x - C0.tgt[i]);
  console.log(`       opening view: distance ${C0.d.toFixed(2)} mm (both plates); the part framed: distance ${D0.toFixed(2)} mm, target ${px(T0)}...`);

  /**
   * One run: from the view (tgt, d), wheel `steps` times one way at `at` and
   * the same number back, measuring after every step.
   */
  async function run(label, at0, tgt, d, dir, sign, steps = 3) {
    // A mouse event's clientX / clientY are whole pixels: measure at the one
    // the wheel event will carry.
    const at = at0.map(Math.round);
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [tgt, d, dir]);
    const c0 = await settle();
    const u = await N((a) => window.__gz.under(a[0], a[1]), at);
    if (!u) { check(`${label}: something under the cursor at ${px(at)}`, false, true); return null; }
    const s0 = await N((p) => window.__gz.proj(p), u.p);
    let drift = dist2(s0, at), ratioErr = 0, dErr = 0, turned = false, moved = 0;
    let prev = c0, ui = u;
    for (let i = 0; i < steps * 2; i++) {
      const way = i < steps ? sign : -sign;
      // What is under the cursor NOW is what this step must zoom about. On a
      // line it can change between steps: a line is "under" within a reach
      // that tracks the zoom, so the nearest one can fall out of it.
      // (Nothing under it any more - only when the zoom has not held - keeps
      // the last point, so the ratio below fails rather than the check dying.)
      if (i) ui = (await N((a) => window.__gz.under(a[0], a[1]), at)) || ui;
      if (Math.hypot(...ui.p.map((x, k) => x - u.p[k])) > 1e-9 * Math.max(1, d)) moved++;
      const c = await wheelAt(at, 100 * way);
      for (const q of [u.p, ui.p]) drift = Math.max(drift, dist2(await N((p) => window.__gz.proj(p), q), at));
      const want = way < 0 ? STEP : 1 / STEP;
      const camTo = (cc) => Math.hypot(...cc.pos.map((x, k) => x - ui.p[k]));
      ratioErr = Math.max(ratioErr, rel(camTo(c) / camTo(prev), want));
      dErr = Math.max(dErr, rel(c.d / prev.d, want));
      if (!near(c.quat, c0.quat, 1e-9)) turned = true;
      prev = c;
    }
    const back = near(prev.pos, c0.pos, 1e-9 * Math.max(1, d)) && near(prev.tgt, c0.tgt, 1e-9 * Math.max(1, d));
    return { u, drift, ratioErr, dErr, turned, back, moved, c0, last: prev };
  }

  // =======================================================================
  console.log('\n--- 1. the point under the cursor holds: 3 positions x 3 zoom levels, in and out ---');
  // =======================================================================
  const LEVELS = [['close', D0 * 0.6], ['framed', D0], ['far', D0 * 3]];
  const r = await N(() => window.__gz.rect());
  const pref = [
    ['part, upper left', 'part', [r[0] + r[2] * 0.40, r[1] + r[3] * 0.38]],
    ['part, lower right', 'part', [r[0] + r[2] * 0.62, r[1] + r[3] * 0.64]],
    ['bed', 'bed', [r[0] + r[2] * 0.5, r[1] + r[3] * 0.95]],
  ];
  const centre = [r[0] + r[2] / 2, r[1] + r[3] / 2];
  let worst = 0, worstRatio = 0, steps = 0;
  const kinds = new Set();
  for (const [lvName, D] of LEVELS) {
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D, DIR0]);
    await settle();
    const grid = await N(() => window.__gz.scan());
    for (const [name, kind, want] of pref) {
      // The nearest pixel of that kind to the preferred spot, and not the
      // centre (the target's own pixel, where any dolly holds the point).
      const cand = grid.filter((g) => g.kind === kind && dist2(g.at, centre) > 80)
        .sort((a, b) => dist2(a.at, want) - dist2(b.at, want))[0];
      if (!cand) { check(`${lvName}: a ${kind} pixel in view for "${name}"`, false, true); continue; }
      for (const [dirName, sign] of [['in', -1], ['out', 1]]) {
        const label = `${lvName} (${D.toFixed(1)} mm), ${name} ${px(cand.at)}, ${dirName} then back`;
        const o = await run(label, cand.at, T0, D, DIR0, sign);
        if (!o) continue;
        kinds.add(o.u.kind);
        steps += 6;
        worst = Math.max(worst, o.drift);
        worstRatio = Math.max(worstRatio, o.ratioErr);
        check(`${label} [${o.u.what}]: within ${TOL_PX} px at every step (worst ${o.drift.toFixed(3)} px)`,
          o.drift <= TOL_PX, true);
        check(`${label}: zoomed ABOUT that point (camera-to-point x${STEP} per step, off by ${o.ratioErr.toExponential(1)})`,
          o.ratioErr < 1e-6, true);
        // Three back undo three in only about the same point: on the bed and on
        // a solid it always is; on a line the nearest one can change on the way.
        check(`${label}: the step is OrbitControls' ${STEP}, the view never turns` +
          (o.moved ? ` (what is under the cursor changed on the way - a line came into or left reach - ${o.moved} of 6 steps about another point)` : ', and 3 back return it'),
          [o.dErr < 1e-9, o.turned, o.moved ? true : o.back], [true, false, true]);
      }
    }
  }
  console.log(`       ${steps} real wheel steps; worst drift ${worst.toFixed(3)} px; worst ratio error ${worstRatio.toExponential(2)}`);
  check('the positions covered the part and the bed', [...kinds].sort(), ['bed', 'part']);

  lap();
  // =======================================================================
  console.log('\n--- 2. what counts as under the cursor ---');
  // =======================================================================
  // Over nothing: high on the canvas the ray meets the bed plane past the grid.
  await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
  const sky = (await N(() => window.__gz.scan())).filter((g) => g.kind === null)
    .sort((a, b) => a.at[1] - b.at[1] || dist2(a.at, centre) - dist2(b.at, centre))[0];
  {
    const b0 = await settle();
    const c1 = await wheelAt(sky.at, -100);
    const c2 = await wheelAt(sky.at, 100);
    // the old zoom: OrbitControls' dolly about the target
    check(`over nothing ${px(sky.at)}: the target does not move, distance x${STEP} then back (the old zoom)`,
      [near(c1.tgt, b0.tgt, 0), rel(c1.d, b0.d * STEP) < 1e-12, near(c1.quat, b0.quat, 1e-12),
        near(c2.tgt, b0.tgt, 0), rel(c2.d, b0.d) < 1e-12], [true, true, true, true, true]);
  }

  // The solid view: the swept beads are drawn; the line meshes are still in
  // the scene with their material off.
  await N(() => { window.NSO_MICROSCOPE.setRenderMode('solid'); window.NSO_MICROSCOPE.flushView(); });
  await frames(3);
  {
    const solid = await N(() => {
      const v = window.NSO_MICROSCOPE.getView();
      return { lines: v.overviewGroup.children.filter((c) => c.isLine && !c.material.visible).length,
               meshes: v.overviewGroup.children.filter((c) => c.isMesh).length };
    });
    check('solid view: line meshes present but not drawn, solid meshes drawn', [solid.lines > 0, solid.meshes > 0], [true, true]);
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const at = (await N(() => window.__gz.scan())).filter((g) => g.kind === 'part' && dist2(g.at, centre) > 80)
      .sort((a, b) => dist2(a.at, pref[0][2]) - dist2(b.at, pref[0][2]))[0].at;
    const o = await run('solid', at, T0, D0, DIR0, -1);
    check(`solid view ${px(at)} [${o.u.what}]: held (${o.drift.toFixed(3)} px) and zoomed about the bead, not a hidden line`,
      [o.u.what.startsWith('Mesh'), o.drift <= TOL_PX, o.ratioErr < 1e-6, o.back], [true, true, true, true]);
  }
  await N(() => { window.NSO_MICROSCOPE.setRenderMode('toolpath'); window.NSO_MICROSCOPE.flushView(); });
  await frames(3);

  lap();
  // =======================================================================
  console.log('\n--- 3. limits ---');
  // =======================================================================
  {
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const at = (await N(() => window.__gz.scan())).filter((g) => g.kind === 'part' && dist2(g.at, centre) > 80)
      .sort((a, b) => dist2(a.at, pref[1][2]) - dist2(b.at, pref[1][2]))[0].at;
    const u = await N((a) => window.__gz.under(a[0], a[1]), at);
    let holds = true, n = 0, c = await settle();
    while (c.d >= 0.01 && n < 2000) {
      await N(([x, y]) => window.__gz.wheelN(x, y, -100, 10), at);
      await frames(1);                     // followClip re-fits the frustum per frame
      n += 10; c = await settle(); holds = holds && c.holdsWorld && c.finite;
    }
    await wheelAt(at, -100);
    await frames(1);
    c = await settle();
    let s = await N((p) => window.__gz.proj(p), u.p);
    console.log(`       in to ${c.d.toExponential(3)} mm in ${n + 1} steps at ${px(at)}`);
    check(`no floor: under a hundredth of a millimetre, the frustum holding all the way, the point at ${dist2(s, at).toFixed(3)} px`,
      [c.d < 0.01, holds && c.holdsWorld, dist2(s, at) <= TOL_PX], [true, true, true]);
    n = 0;
    while (c.d <= 1.5e6 && n < 3000) {
      await N(([x, y]) => window.__gz.wheelN(x, y, 100, 10), at);
      await frames(1);
      n += 10; c = await settle(); holds = holds && c.holdsWorld && c.finite;
    }
    await wheelAt(at, 100);
    await frames(1);
    c = await settle();
    s = await N((p) => window.__gz.proj(p), u.p);
    console.log(`       out to ${(c.d / 1e6).toFixed(2)} km in ${n + 1} steps`);
    check(`no ceiling: past a kilometre, the frustum holding all the way, the point at ${dist2(s, at).toFixed(3)} px`,
      [c.d > 1e6, holds && c.holdsWorld, dist2(s, at) <= TOL_PX], [true, true, true]);

    // OrbitControls' own limits still bound the wheel.
    await N(() => { const o = window.NSO_MICROSCOPE.getView().controls; o.minDistance = 20; o.maxDistance = 200; });
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const u2 = await N((a) => window.__gz.under(a[0], a[1]), at);
    let worstL = 0;
    for (const [lim, dy] of [[20, -100], [200, 100]]) {
      c = await settle();
      for (let i = 0; i < 80 && Math.abs(c.d - lim) > 1e-9; i++) {
        await N(([x, y, d]) => window.__gz.wheelN(x, y, d, 1), [at[0], at[1], dy]);
        c = await settle();
        worstL = Math.max(worstL, dist2(await N((p) => window.__gz.proj(p), u2.p), at));
      }
      const atLim = c;
      const more = await wheelAt(at, dy);
      worstL = Math.max(worstL, dist2(await N((p) => window.__gz.proj(p), u2.p), at));
      check(`minDistance 20 / maxDistance 200: the wheel stops exactly at ${lim}, and a further step moves nothing`,
        [Math.abs(atLim.d - lim) < 1e-9, near(more.pos, atLim.pos, 0), near(more.tgt, atLim.tgt, 0), more.finite],
        [true, true, true, true]);
    }
    check(`... with the point held all the way (worst ${worstL.toFixed(3)} px)`, worstL <= TOL_PX, true);
    await N(() => { const o = window.NSO_MICROSCOPE.getView().controls; o.minDistance = 0; o.maxDistance = Infinity; });
  }

  lap();
  // =======================================================================
  console.log('\n--- 4. nothing else changes ---');
  // =======================================================================
  const c4 = await settle();
  check('the controls as G-scope sets them: zoom on, speed 1, unclamped, pan and rotate on',
    [c4.zoom, c4.zoomSpeed, c4.minD, c4.maxD, c4.pan, c4.rotate, c4.enabled], [true, 1, 0, Infinity, true, true, true]);
  {
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const at = pref[0][2];
    const b0 = await settle();
    // one step is 0.95 whatever the deltaY - OrbitControls' own step
    const big = await wheelAt(at, -400);
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const small = await wheelAt(at, -3);
    check('one wheel event is one 0.95 step, at deltaY -400 and at -3 alike',
      [rel(big.d, b0.d * STEP) < 1e-12, rel(small.d, b0.d * STEP) < 1e-12], [true, true]);
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    await page.mouse.move(at[0], at[1]);
    await page.mouse.wheel(40, 0);
    await frames(2);
    const sideways = await settle();
    check('a sideways scroll (deltaY 0) moves nothing', [near(sideways.pos, b0.pos, 1e-12), near(sideways.tgt, b0.tgt, 1e-12)], [true, true]);
  }
  {
    // Middle-drag: OrbitControls' dolly, about the target, as before.
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const b0 = await settle();
    const at = [centre[0] + 150, centre[1] + 100];
    await page.mouse.move(at[0], at[1]);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(at[0], at[1] - 120, { steps: 12 });
    await page.mouse.up({ button: 'middle' });
    const m1 = await settle();
    check(`middle-drag still zooms, about the target (distance ${b0.d.toFixed(1)} -> ${m1.d.toFixed(1)} mm, target fixed, no turn)`,
      [Math.abs(m1.d - b0.d) > 1, near(m1.tgt, b0.tgt, 1e-9), near(m1.quat, b0.quat, 1e-9)], [true, true, true]);
  }
  {
    // Two-finger touch: a real pinch (CDP touch events), OrbitControls' dolly.
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const b0 = await settle();
    const cdp = await context.newCDPSession(page);
    // A finger is the orbit's even over the part (the pull is the mouse's): the pinch starts on the part.
    const pinchY = centre[1];
    const pts = (s) => [{ x: centre[0] - s, y: pinchY, id: 1 }, { x: centre[0] + s, y: pinchY, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(60) });
    for (let s = 70; s <= 200; s += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(s) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const t1 = await settle();
    check(`a two-finger pinch still zooms (distance ${b0.d.toFixed(1)} -> ${t1.d.toFixed(1)} mm, no turn)`,
      [t1.d < b0.d * 0.8, near(t1.quat, b0.quat, 1e-9)], [true, true]);
  }
  {
    // A wheel over the feature list is the list's, not the camera's.
    await N(([t, dd, w]) => window.__gz.view(t, dd, w), [T0, D0, DIR0]);
    const b0 = await settle();
    const lg = await N(() => {
      const el = document.getElementById('ms-legend'), q = el && el.getBoundingClientRect();
      return q && q.width ? [q.left + q.width / 2, q.top + Math.min(q.height / 2, 40)] : null;
    });
    if (!lg) check('the feature list is on screen', false, true);
    else {
      await page.mouse.move(lg[0], lg[1]);
      await page.mouse.wheel(0, -100);
      const l1 = await settle();
      check(`a wheel over the feature list ${px(lg)} does not zoom`, [near(l1.pos, b0.pos, 0), near(l1.tgt, b0.tgt, 0)], [true, true]);
    }
    // Controls off (a box-handle drag sets that): the wheel moves nothing.
    await N(() => { window.NSO_MICROSCOPE.getView().controls.enabled = false; });
    const off = await wheelAt(pref[0][2], -100);
    await N(() => { window.NSO_MICROSCOPE.getView().controls.enabled = true; });
    check('with the controls off, the wheel moves nothing', [near(off.pos, b0.pos, 0), near(off.tgt, b0.tgt, 0)], [true, true]);
  }

  lap();
  // =======================================================================
  console.log('\n--- 5. a mesh document cut by the layer range ---');
  // =======================================================================
  // A 30 x 30 x 20 box, Z up, as a mesh document. The layer range keeps its
  // lower half: what the clip removes is not drawn, so it is not under the cursor.
  await N(() => {
    const q = [[0, 0, 0], [30, 0, 0], [30, 30, 0], [0, 30, 0], [0, 0, 20], [30, 0, 20], [30, 30, 20], [0, 30, 20]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const p = [];
    f.forEach((t) => t.forEach((i) => p.push(...q[i])));
    window.NSO_MICROSCOPE.openObjects('zoom box', [{ name: 'box', positions: new Float32Array(p) }]);
  });
  await page.waitForFunction(() => (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'mesh');
  await page.click('#ms-mode-piece');
  await page.evaluate(install);
  await frames(3);
  {
    const m0 = await settle();
    const T1 = m0.tgt, D1 = m0.d, DIR1 = m0.pos.map((x, i) => x - T1[i]);
    // the top face's centre, before the cut
    const topPx = (await N(() => window.__gz.proj([0, 20, 0]))).map(Math.round);
    const before = await N((a) => window.__gz.under(a[0], a[1]), topPx);
    await N(() => { window.NSO_MICROSCOPE.setZRangeMm(0, 10); window.NSO_MICROSCOPE.flushView(); });
    await frames(3);
    const o = await run('clipped box', topPx, T1, D1, DIR1, -1);
    console.log(`       over the top face ${px(topPx)}: ${before.what} at y ${before.p[1].toFixed(2)} before the cut; ${o.u.what} at y ${o.u.p[1].toFixed(2)} after`);
    check('mesh document: the top face is under the cursor before the cut', [before.kind, Math.abs(before.p[1] - 20) < 1e-3], ['part', true]);
    check(`cut to its lower half: the zoom is about what is still drawn there, not the clipped-away top (${o.drift.toFixed(3)} px)`,
      [o.u.p[1] < 10, o.drift <= TOL_PX, o.ratioErr < 1e-6, o.back], [true, true, true, true]);
    const side = (await N(() => window.__gz.proj([15, 5, 0]))).map(Math.round);
    const o2 = await run('box side', side, T1, D1, DIR1, 1);
    check(`... and over the box's side that is still drawn ${px(side)} [${o2.u.what}]: held (${o2.drift.toFixed(3)} px), about it`,
      [o2.u.kind, o2.drift <= TOL_PX, o2.ratioErr < 1e-6, o2.back], ['part', true, true, true]);
  }

  // =======================================================================
  lap();
  console.log('\n--- the build ---');
  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-normal-camera-drive-check.mjs
 *
 * G-scope's Normal camera is unrestricted; Close inspection is unchanged.
 * Real wheel scrolls, real drags, real button clicks, in headless Chromium.
 *
 *   1  NORMAL - ZOOM. No distance floor and no ceiling: the wheel takes the
 *      camera to a hundredth of a millimetre from the target and out past a
 *      kilometre. Past the old limit (frameBox's far plane, 100x the framed
 *      distance - about 4.5 m on this slice, where the part used to vanish)
 *      the part is still drawn, and at every distance the frustum still holds
 *      everything drawn.
 *   2  NORMAL - ORBIT AND PAN. A full 360 degrees round, straight down onto
 *      the top and straight up from under the bed; a right-drag pans; a
 *      filter redraw and a panel reopen do not re-lock the camera.
 *   3  CLOSE INSPECTION, UNCHANGED. Its framing is the frameBox() formula on
 *      the selection's extent, recomputed here value for value; pan stays
 *      locked; its near / far stay the ones frameBox set, whatever the wheel
 *      does - Normal's clip-following never runs in it.
 *   4  SCREENSHOTS of both modes, each asserted to be a drawn view.
 *
 * Usage:
 *   node tools/gcode-test/gscope-normal-camera-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const SHOTS = join(ROOT, 'tools', 'gscope-out');

async function frames(page, n = 2) {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
}

/** Lit pixels in the G-scope canvas, read in the same task as a render. */
const litPixels = (page) => page.evaluate(() => {
  const v = window.NSO_MICROSCOPE.getView();
  v.renderer.render(v.scene, v.camera);
  const gl = v.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const seen = new Set();
  let lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (i % (4 * 97) === 0) seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
    if (buf[i] > 0x28 || buf[i + 1] > 0x28 || buf[i + 2] > 0x28) lit++;
  }
  return { lit, distinct: seen.size, w, h };
});

async function shot(page, file, label) {
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  await frames(page);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, file) });
  const px = await litPixels(page);
  check(`${label}: screenshot is a drawn view, not a blank panel`,
    px.distinct > 6 && px.lit > 20 && px.w > 300 && px.h > 300, true);
  console.log(`       ${file}  ${px.w}x${px.h}, ${px.distinct} colours, ${px.lit} lit`);
}

const cam = (page) => page.evaluate(() => {
  const M = window.NSO_MICROSCOPE, v = M.getView(), c = v.camera, o = v.controls, t = o.target;
  // The farthest and nearest any drawn thing can be: the document plus the bed grid.
  const box = new THREE.Box3();
  v.overviewGroup.children.forEach((m) => {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
  });
  box.union(new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 0, 60)));
  const sph = box.getBoundingSphere(new THREE.Sphere());
  return {
    mode: M.cameraMode(),
    d: c.position.distanceTo(t),
    pos: [c.position.x, c.position.y, c.position.z],
    target: [t.x, t.y, t.z],
    near: c.near, far: c.far, fov: c.fov,
    polar: o.getPolarAngle(), azimuth: o.getAzimuthalAngle(),
    minD: o.minDistance, maxD: o.maxDistance,
    minPolar: o.minPolarAngle, maxPolar: o.maxPolarAngle,
    minAz: o.minAzimuthAngle, maxAz: o.maxAzimuthAngle,
    pan: o.enablePan, zoom: o.enableZoom, rotate: o.enableRotate,
    // The frustum holds everything drawn: the far side of the world sphere
    // inside far, and near no further out than a hundredth of the target distance.
    holdsWorld: c.far >= c.position.distanceTo(sph.center) + sph.radius &&
                c.near <= c.position.distanceTo(t) / 100 + 1e-12,
  };
});

const near = (a, b, tol) => a.every((x, i) => Math.abs(x - b[i]) <= tol);

async function wheel(page, at, dy, n) {
  await page.mouse.move(at[0], at[1]);
  for (let i = 0; i < n; i++) await page.mouse.wheel(0, dy);
  await frames(page, 3);
}

async function drag(page, from, to, button = 'left') {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button });
  await page.mouse.move(to[0], to[1], { steps: 20 });
  await page.mouse.up({ button });
  await frames(page, 3);
}

/** Wait out OrbitControls' damping, so a reading is where the drag landed. */
async function settle(page) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    await frames(page, 2);
    const c = await cam(page);
    const k = [...c.pos, ...c.target].map((x) => x.toFixed(9)).join();
    if (k === last) return c;
    last = k;
  }
  return cam(page);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
  await frames(page, 3);

  const rect = await page.evaluate(() => {
    const r = window.NSO_MICROSCOPE.getView().renderer.domElement.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });
  const centre = [rect[0] + rect[2] * 0.5, rect[1] + rect[3] * 0.5];

  // =======================================================================
  console.log('\n--- 1. Normal: zoom has no floor and no ceiling ---');
  // =======================================================================
  const c0 = await cam(page);
  check('G-scope opens in Normal', c0.mode, 'normal');
  check('Normal: the controls are unclamped - minDistance 0, maxDistance Infinity',
    [c0.minD, c0.maxD], [0, Infinity]);
  check('Normal: rotate, zoom and pan all on', [c0.rotate, c0.zoom, c0.pan], [true, true, true]);
  check('Normal: orbit unclamped - polar 0..pi, azimuth unbounded',
    [c0.minPolar, c0.maxPolar, c0.minAz, c0.maxAz], [0, Math.PI, -Infinity, Infinity]);
  check('Normal: the frustum holds everything drawn at the opening view', c0.holdsWorld, true);
  const openDist = c0.d;
  // The old limit: frameBox() sets far to max(span, distance) x 100 for the
  // box it frames, and Normal used to keep that far plane whatever the wheel
  // did. The whole part's span is under its framing distance, so it is 100x
  // the opening distance.
  const oldFar = openDist * 100;
  console.log(`       opening distance ${openDist.toFixed(2)} mm; frameBox's far plane ${oldFar.toFixed(0)} mm`);

  // Orbit mode: the wheel and drags go to the camera, never to a capture box.
  await page.click('#ms-mode-orbit');

  // In, a step at a time, checking the frustum all the way.
  let holdsAll = true, minD = Infinity;
  for (let k = 0; k < 12; k++) {
    await wheel(page, centre, -300, 20);
    const c = await cam(page);
    holdsAll = holdsAll && c.holdsWorld;
    minD = Math.min(minD, c.d);
  }
  let c1 = await settle(page);
  console.log(`       zoomed in to ${c1.d.toExponential(3)} mm (near ${c1.near.toExponential(3)})`);
  check('Normal zoom-in: well under a hundredth of a millimetre from the target - no floor',
    c1.d < 0.01, true);
  check('Normal zoom-in: still the same target (zoom is a dolly, not a pan)', near(c1.target, c0.target, 1e-6), true);
  check('Normal zoom-in: the frustum held everything drawn at every step', holdsAll && c1.holdsWorld, true);

  // Out, past the old limit, to where the part is still drawn...
  await wheel(page, centre, 300, 1);
  let steps = 0;
  while ((await cam(page)).d < oldFar * 1.05 && steps < 600) { await page.mouse.wheel(0, 300); steps++; }
  await frames(page, 3);
  const c2 = await settle(page);
  const px2 = await litPixels(page);
  console.log(`       zoomed out to ${(c2.d / 1000).toFixed(2)} m, ${px2.lit} lit pixels`);
  check('Normal zoom-out: past the old far-plane limit', c2.d > oldFar, true);
  check('Normal zoom-out: and the part is STILL DRAWN there (it used to vanish)', px2.lit > 0, true);
  check('Normal zoom-out: the frustum holds everything drawn', c2.holdsWorld, true);
  // At this distance the part is a few pixels, so this one is asserted
  // drawn (lit pixels, above) rather than detailed.
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'nc-01-normal-zoomed-far-out.png') });

  // ...and on, past a kilometre.
  holdsAll = true;
  for (let k = 0; k < 12; k++) {
    await wheel(page, centre, 300, 20);
    holdsAll = holdsAll && (await cam(page)).holdsWorld;
  }
  const c3 = await settle(page);
  console.log(`       zoomed out to ${(c3.d / 1e6).toFixed(2)} km`);
  check('Normal zoom-out: past a kilometre - no ceiling', c3.d > 1e6, true);
  check('Normal zoom-out: the frustum held everything drawn at every step', holdsAll && c3.holdsWorld, true);

  // Back to a working distance: Normal button frames the whole part once.
  await page.click('#ms-cam-normal');
  await frames(page, 3);
  const c4 = await cam(page);
  check('the Normal button frames the whole part once', Math.abs(c4.d - openDist) < 1e-6, true);

  // A close zoom with something to look at: the wheel, from the whole-part view.
  await wheel(page, centre, -300, 45);
  const c5 = await settle(page);
  console.log(`       close zoom at ${c5.d.toFixed(2)} mm`);
  check('Normal: zoom in closer than Close inspection\'s tightest framing needs, freely', c5.d < openDist / 5, true);
  await shot(page, 'nc-02-normal-zoomed-close.png', 'Normal, wheel-zoomed in close');
  await page.click('#ms-cam-normal');
  await frames(page, 3);

  // =======================================================================
  console.log('\n--- 2. Normal: orbit and pan are free, nothing re-locks ---');
  // =======================================================================
  // OrbitControls turns 2*pi per canvas HEIGHT of horizontal drag.
  const a0 = (await settle(page)).azimuth;
  const H = rect[3];
  const y = rect[1] + H * 0.5, x0 = rect[0] + rect[2] * 0.1;
  await drag(page, [x0, y], [x0 + H / 2, y]);
  const half = (await settle(page)).azimuth;
  const dHalf = Math.abs(Math.atan2(Math.sin(half - a0), Math.cos(half - a0)));
  console.log(`       half drag: azimuth moved ${(dHalf * 180 / Math.PI).toFixed(1)} deg`);
  check('Normal orbit: half a turn goes round to the far side (~180 deg)', Math.abs(dHalf - Math.PI) < 0.1, true);
  await drag(page, [x0, y], [x0 + H / 2, y]);
  const full = (await settle(page)).azimuth;
  const dFull = Math.abs(Math.atan2(Math.sin(full - a0), Math.cos(full - a0)));
  check('Normal orbit: a second half turn comes all the way round (360 deg)', dFull < 0.1, true);

  // Straight down onto the top...
  const xm = rect[0] + rect[2] * 0.5;
  await drag(page, [xm, rect[1] + H * 0.05], [xm, rect[1] + H * 0.95]);
  const top = await settle(page);
  console.log(`       polar after dragging down: ${(top.polar * 180 / Math.PI).toFixed(2)} deg`);
  check('Normal orbit: all the way over the top (polar ~0, a view straight down)', top.polar < 0.01, true);
  await shot(page, 'nc-03-normal-orbit-top.png', 'Normal, orbited to straight down');
  // ...and straight up from under the bed.
  await drag(page, [xm, rect[1] + H * 0.95], [xm, rect[1] + H * 0.05]);
  await drag(page, [xm, rect[1] + H * 0.95], [xm, rect[1] + H * 0.05]);
  const bottom = await settle(page);
  console.log(`       polar after dragging up: ${(bottom.polar * 180 / Math.PI).toFixed(2)} deg`);
  check('Normal orbit: all the way under (polar ~180, a view straight up)', bottom.polar > Math.PI - 0.01, true);
  await shot(page, 'nc-04-normal-orbit-under.png', 'Normal, orbited to straight up from underneath');

  // Pan: a right-drag moves the target.
  const beforePan = await settle(page);
  await drag(page, [xm, y], [xm + 150, y + 80], 'right');
  const afterPan = await settle(page);
  check('Normal: a right-drag pans (the target moves)', !near(afterPan.target, beforePan.target, 1e-3), true);

  // Nothing re-locks it: a slider redraw, then closing and reopening the panel.
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE, z = M.zRange(); M.setZRange(z.lo, z.hi - 3); M.flushView(); });
  await frames(page, 3);
  const afterFilter = await settle(page);
  check('Normal: a slider redraw does not move the camera',
    near(afterFilter.pos, afterPan.pos, 1e-6) && near(afterFilter.target, afterPan.target, 1e-6), true);
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE, z = M.zRange(); M.setZRange(0, z.n - 1); M.flushView(); });
  await page.click('#ms-close');
  await page.click('#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen());
  const afterReopen = await settle(page);
  check('Normal: closing and reopening the panel leaves the camera where it was',
    near(afterReopen.pos, afterPan.pos, 1e-6) && near(afterReopen.target, afterPan.target, 1e-6), true);

  // =======================================================================
  console.log('\n--- 3. Close inspection: unchanged ---');
  // =======================================================================
  await page.click('#ms-mode-select');
  const at = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    const m = d.parsed.moves[Math.floor(d.parsed.moves.length / 2)];
    return [(m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, m.z];
  });
  await page.evaluate(([x, y, z]) => window.NSO_MICROSCOPE.addBoxAt(x, y, z, 4, 1, 2), at);
  const keep = await page.evaluate(() => JSON.stringify(window.NSO_MICROSCOPE.selection().map((s) => s.id)));
  // What frameBox() puts the camera at for the selection's extent - its
  // formula, recomputed here, so any change to Close inspection shows up.
  const expected = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    const box = new THREE.Box3();
    const P = (x, y, z) => new THREE.Vector3(x - d.cx, z, -(y - d.cy));
    M.selection().forEach((s) => {
      const w = (s.w || 0) / 2;
      box.expandByPoint(P(s.x0 - w, s.y0 - w, s.z - w)); box.expandByPoint(P(s.x0 + w, s.y0 + w, s.z + w));
      box.expandByPoint(P(s.x1 - w, s.y1 - w, s.z - w)); box.expandByPoint(P(s.x1 + w, s.y1 + w, s.z + w));
    });
    const size = new THREE.Vector3(), c = new THREE.Vector3();
    box.getSize(size); box.getCenter(c);
    const span = Math.max(size.x, size.y, size.z) || 20;
    const radius = (size.length() / 2) || 10;
    const dist = (radius / Math.sin((v.camera.fov * Math.PI / 180) / 2)) * 1.1;
    const step = dist / Math.sqrt(3);
    return { target: [c.x, c.y, c.z], pos: [c.x + step, c.y + step, c.z + step],
      near: Math.max(0.01, span / 1000), far: Math.max(span, dist) * 100 };
  });
  await page.click('#ms-cam-close');
  await frames(page, 3);
  const k0 = await cam(page);
  check('Close inspection: mode, pan locked, rotate and zoom on',
    [k0.mode, k0.pan, k0.rotate, k0.zoom], ['close', false, true, true]);
  check('Close inspection: target = frameBox() on the selection', near(k0.target, expected.target, 1e-6), true);
  check('Close inspection: camera position = frameBox() on the selection', near(k0.pos, expected.pos, 1e-6), true);
  check('Close inspection: near / far = frameBox()\'s, not the clip-following Normal uses',
    [Math.abs(k0.near - expected.near) < 1e-9, Math.abs(k0.far - expected.far) < 1e-6], [true, true]);
  check('Close inspection: the selection is untouched', await page.evaluate(() =>
    JSON.stringify(window.NSO_MICROSCOPE.selection().map((s) => s.id))), keep);
  await shot(page, 'nc-05-close-inspection.png', 'Close inspection on a capture box');

  // Its pan lock and static clip planes hold under real input. In Orbit mode:
  // in select mode any button's drag on the capture box resizes the box.
  await page.click('#ms-mode-orbit');
  await drag(page, [xm, y], [xm + 150, y + 80], 'right');
  const k1 = await settle(page);
  check('Close inspection: a right-drag does not move the locked target', near(k1.target, expected.target, 1e-6), true);
  await wheel(page, centre, -300, 10);
  const k2 = await settle(page);
  check('Close inspection: the wheel still zooms about the locked target',
    [k2.d < k1.d, near(k2.target, expected.target, 1e-6)], [true, true]);
  check('Close inspection: and its near / far stay frameBox()\'s while it does',
    [Math.abs(k2.near - expected.near) < 1e-9, Math.abs(k2.far - expected.far) < 1e-6], [true, true]);

  check('Close inspection: none of that touched the selection', await page.evaluate(() =>
    JSON.stringify(window.NSO_MICROSCOPE.selection().map((s) => s.id))), keep);

  // Isolate still lands in it, framed the same way.
  await page.click('#ms-mode-select');
  await page.click('#ms-cam-normal');
  await frames(page, 3);
  await page.click('#ms-btn-isolate');
  await frames(page, 3);
  const k3 = await cam(page);
  check('Isolate enters Close inspection, framed exactly as before',
    [k3.mode, k3.pan, near(k3.target, expected.target, 1e-6), near(k3.pos, expected.pos, 1e-6)],
    ['close', false, true, true]);
  await shot(page, 'nc-06-close-isolated.png', 'Close inspection, isolated');
  // And Normal from inside the isolation is just as free.
  await page.click('#ms-cam-normal');
  await frames(page, 3);
  await page.click('#ms-mode-orbit');
  await wheel(page, centre, -300, 240);
  const k4 = await settle(page);
  check('isolated, Normal: still isolated, pan on, zoom with no floor',
    [await page.evaluate(() => window.NSO_MICROSCOPE.getView().detailGroup.visible), k4.pan, k4.d < 0.01, k4.holdsWorld],
    [true, true, true, true]);

  // =======================================================================
  console.log('\n--- the build ---');
  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

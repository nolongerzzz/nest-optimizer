#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-corner-camera-drive-check.mjs
 *
 * G-scope's capture-box corner handle, driven through the real app in
 * headless Chromium with real mouse drags and clicks. (Normal and Isolate
 * are gscope-normal-camera-drive-check.mjs.)
 *
 *   1  CORNER DRAG. The green corner dot, dragged with the mouse, sizes the
 *      box's footprint along G-code X and Y INDEPENDENTLY - one axis grows
 *      while the other shrinks, then the other way round. The centre and the
 *      thickness do not move, and what the box catches is exactly the
 *      rectangle predicate recomputed here from the parsed moves. A face drag
 *      afterwards scales the rectangle and keeps its shape.
 *   2  SCREENSHOTS of each drag, each asserted to be a drawn view.
 *
 * Usage:
 *   node tools/gcode-test/gscope-corner-camera-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const SHOTS = join(ROOT, 'tools', 'gscope-out');

async function frames(page, n = 2) {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
}

/** Screenshot G-scope and prove the canvas is a drawn view (as gscope-drive-check does). */
async function shot(page, file, label) {
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator('#microscope').screenshot({ path });
  const px = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    v.renderer.render(v.scene, v.camera);
    const gl = v.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < buf.length; i += 4 * 97) {
      seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      if (buf[i] > 0x20 || buf[i + 1] > 0x20 || buf[i + 2] > 0x20) lit++;
    }
    return { distinct: seen.size, lit, w, h };
  });
  check(`${label}: screenshot is a drawn view, not a blank panel`,
    px.distinct > 6 && px.lit > 20 && px.w > 300 && px.h > 300, true);
  console.log(`       ${file}  ${px.w}x${px.h}, ${px.distinct} colours, ${px.lit} lit`);
}

/** Screen pixel of a VIEW-space point in the G-scope canvas. */
const projectView = (page, p) => page.evaluate(([x, y, z]) => {
  const v = window.NSO_MICROSCOPE.getView();
  const q = new THREE.Vector3(x, y, z).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
}, p);

/** Screen pixel of a G-code-space point. */
const projectG = (page, p) => page.evaluate(([x, y, z]) => {
  const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
  const q = new THREE.Vector3(x - d.cx, z, -(y - d.cy)).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
}, p);

/** The box, and the moves the rectangle predicate takes, recomputed here from the parsed file. */
const boxState = (page) => page.evaluate(() => {
  const M = window.NSO_MICROSCOPE, b = M.boxes()[0], d = M.getDoc();
  const shownIds = new Set(M.selection().map((s) => s.id));
  const hidden = new Set(M.hidden());
  const expect = d.segments.filter((s) => !hidden.has(s.feature) &&
    Math.abs((s.x0 + s.x1) / 2 - b.gx) <= b.rx &&
    Math.abs((s.y0 + s.y1) / 2 - b.gy) <= b.ry &&
    Math.abs(s.z - b.gz) <= b.h).map((s) => s.id);
  return {
    box: b,
    n: shownIds.size,
    exact: expect.length === shownIds.size && expect.every((id) => shownIds.has(id)),
    source: M.selectionSource(),
  };
});

const camera = (page) => page.evaluate(() => {
  const M = window.NSO_MICROSCOPE, v = M.getView();
  const t = v.controls.target, c = v.camera.position;
  return {
    mode: window.NSO_GSCOPE_SLICE.viewMode(),
    pan: v.controls.enablePan,
    target: [t.x, t.y, t.z],
    dist: c.distanceTo(t),
    normalOn: document.getElementById('ms-cam-normal').classList.contains('active'),
    sliceOn: document.getElementById('ms-cam-slice').classList.contains('active'),
  };
});

const near = (a, b, tol) => a.every((x, i) => Math.abs(x - b[i]) <= tol);

async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 12 });
  await page.mouse.up();
  await frames(page);
}

/**
 * A pixel of BARE plate in the G-scope canvas: nothing drawn under it that a press would take
 * (the engine's own answer, pressTargetAt) and the canvas itself on top (no card, no readout).
 * A left press on the part or the selection is the click-isolates / drag-pulls gesture now;
 * an orbit starts on bare plate.
 */
async function bareAt(page, x0, x1, y0, y1) {
  const at = await page.evaluate(([a, b, c, d]) => {
    const M = window.NSO_MICROSCOPE, cv = M.getView().renderer.domElement, r = cv.getBoundingClientRect();
    const n = 24, sy = (d - c) / n, sx = (b - a) / n;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = r.left + (a + sx * j) * r.width, y = r.top + (c + sy * i) * r.height;
      if (document.elementFromPoint(x, y) === cv && !M.pressTargetAt(x, y)) return [x, y];
    }
    return null;
  }, [x0, x1, y0, y1]);
  if (!at) throw new Error(`no bare plate in x ${x0}-${x1}, y ${y0}-${y1} of the canvas`);
  return at;
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  gscopeCards.install(page);
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e) + ' ' + (e.stack || '').split('\n').slice(0, 4).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE, null, { timeout: 30000 });
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  await frames(page, 3);

  // =======================================================================
  console.log('\n--- 1. corner drag: X and Y independently ---');
  // =======================================================================
  const opened = await camera(page);
  check('G-scope opens in Normal: its button lit, pan free', [opened.mode, opened.normalOn, opened.sliceOn, opened.pan],
    ['normal', true, false, true]);

  // One box at a move in the middle of the print, 3 x 3 mm, 1 mm thick.
  const at = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    const m = d.parsed.moves[Math.floor(d.parsed.moves.length / 2)];
    return [(m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, m.z];
  });
  // A box and its dots are Click to select region's, and G-scope opens in
  // orbit: arm it, as a user does before dropping one.
  await page.click('#ms-mode-select');
  await page.evaluate(([x, y, z]) => window.NSO_MICROSCOPE.addBoxAt(x, y, z, 3, 1), at);
  await frames(page);
  const b0 = await boxState(page);
  check('a new box is square: rx = ry = r = 3', [b0.box.rx, b0.box.ry, b0.box.r], [3, 3, 3]);

  const corner = await page.evaluate(() => {
    const b = window.NSO_MICROSCOPE.getView().scene.children.filter((o) => o.material &&
      o.material.color && o.material.color.getHex() === 0x4cd97b);
    return b.length ? [b[0].position.x, b[0].position.y, b[0].position.z, b[0].visible] : null;
  });
  check('the box has a green corner dot, drawn', !!corner && corner[3], true);
  const b0v = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc(), b = window.NSO_MICROSCOPE.boxes()[0];
    return [b.gx - d.cx, b.gz, -(b.gy - d.cy)];
  });
  // On the top face, at the footprint corner on the camera's side of the box.
  const side = await page.evaluate((c) => {
    const p = window.NSO_MICROSCOPE.getView().camera.position;
    return [Math.sign(p.x - c[0]) || 1, Math.sign(p.z - c[2]) || 1];
  }, b0v);
  check('it sits on the top face, at the footprint corner nearest the camera',
    near(corner.slice(0, 3), [b0v[0] + side[0] * 3, b0v[1] + 1, b0v[2] + side[1] * 3], 1e-6), true);
  // G-code offsets toward that corner: view x is G-code x, view z is -G-code y.
  const gx = (d) => at[0] + side[0] * d, gy = (d) => at[1] - side[1] * d;
  await shot(page, 'cc-01-square-box.png', 'a fresh square box, three dots');

  // Drag the corner to where the (+6, +1.5) corner would be: X grows, Y shrinks.
  const top = at[2] + 1;
  await drag(page, await projectView(page, corner.slice(0, 3)), await projectG(page, [gx(6), gy(1.5), top]));
  const b1 = await boxState(page);
  console.log(`       after drag 1: rx ${b1.box.rx.toFixed(3)}, ry ${b1.box.ry.toFixed(3)}, ${b1.n} moves`);
  check('corner drag 1: X grows to ~6 mm', Math.abs(b1.box.rx - 6) < 0.2, true);
  check('corner drag 1: Y shrinks to ~1.5 mm, in the SAME drag', Math.abs(b1.box.ry - 1.5) < 0.2, true);
  check('corner drag 1: centre and thickness untouched',
    near([b1.box.gx, b1.box.gy, b1.box.gz, b1.box.h], [b0.box.gx, b0.box.gy, b0.box.gz, 1], 1e-6), true);
  check('corner drag 1: the selection is exactly the rectangle\'s moves', [b1.exact, b1.source, b1.n > 0], [true, 'box', true]);
  check('the old `r` reads as the larger half-extent', b1.box.r, Math.max(b1.box.rx, b1.box.ry));
  await shot(page, 'cc-02-corner-drag-wide-x.png', 'corner drag: wide in X, narrow in Y');

  // And the other way: X shrinks, Y grows.
  const c1 = await page.evaluate(() => {
    const o = window.NSO_MICROSCOPE.getView().scene.children.find((o) => o.material &&
      o.material.color && o.material.color.getHex() === 0x4cd97b);
    return [o.position.x, o.position.y, o.position.z];
  });
  check('the corner dot followed the corner',
    near(c1, [b0v[0] + side[0] * b1.box.rx, b0v[1] + 1, b0v[2] + side[1] * b1.box.ry], 1e-6), true);
  await drag(page, await projectView(page, c1), await projectG(page, [gx(1.5), gy(7), top]));
  const b2 = await boxState(page);
  console.log(`       after drag 2: rx ${b2.box.rx.toFixed(3)}, ry ${b2.box.ry.toFixed(3)}, ${b2.n} moves`);
  check('corner drag 2: X shrinks to ~1.5 mm', Math.abs(b2.box.rx - 1.5) < 0.2, true);
  check('corner drag 2: Y grows to ~7 mm', Math.abs(b2.box.ry - 7) < 0.2, true);
  check('corner drag 2: the selection is exactly the rectangle\'s moves', b2.exact, true);
  check('the two rectangles catch different moves', b1.n !== b2.n, true);
  await shot(page, 'cc-03-corner-drag-tall-y.png', 'corner drag: narrow in X, long in Y');

  // Orbit half way round (a real left-drag from BARE plate - Piece mode, no region armed): the dot
  // moves to the corner that is now in front, and the box itself does not change.
  await page.click('#ms-mode-piece');
  // An orbit turns by the pixels dragged (2*pi per canvas height). The canvas was 1110 wide beside the
  // sidebar and is the whole panel now, so a drag of 0.7 of its width went further round than this
  // check means: keep the same 777 px of travel, from clear of the left wall's boxes.
  // G-scope opens framed on both plates now (docs/GSCOPE.md), from the front, its target between
  // them, so an orbit turns about that point. Turn about the box instead, from the corner the opening
  // view used to look from (the camera stays on the box's same side): the target on the box.
  await page.evaluate((c) => {
    const v = window.NSO_MICROSCOPE.getView();
    v.controls.target.set(c[0], c[1], c[2]);
    v.camera.position.copy(v.controls.target).add(new THREE.Vector3(1, 1, 1).setLength(90));
    v.controls.update();
  }, b0v);
  await frames(page, 3);
  const [x1, oy] = await bareAt(page, 0.12, 0.4, 0.3, 0.9);
  await drag(page, [x1, oy], [x1 + 0.7 * 1110, oy]);
  await frames(page, 30);                                     // let the damping settle
  const orbited = await page.evaluate((c) => {
    const M = window.NSO_MICROSCOPE, v = M.getView(), p = v.camera.position;
    const o = v.scene.children.find((x) => x.material && x.material.color && x.material.color.getHex() === 0x4cd97b);
    return { side: [Math.sign(p.x - c[0]) || 1, Math.sign(p.z - c[2]) || 1], dot: [o.position.x, o.position.y, o.position.z], box: M.boxes()[0] };
  }, b0v);
  check('orbiting round: the camera is now on another side of the box', orbited.side.join() !== side.join(), true);
  check('and the corner dot moved to the corner now nearest it',
    near(orbited.dot, [b0v[0] + orbited.side[0] * b2.box.rx, b0v[1] + 1, b0v[2] + orbited.side[1] * b2.box.ry], 1e-6), true);
  check('orbiting changed nothing about the box', JSON.stringify(orbited.box), JSON.stringify(b2.box));
  await page.click('#ms-mode-select');

  // A face drag after it scales the rectangle and keeps its proportion.
  const facePt = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), b = M.boxes()[0];
    return [b.gx - d.cx + b.rx, b.gz, -(b.gy - d.cy) + b.ry * 0.5];   // on the +X face, off the dots
  });
  const faceTo = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), b = M.boxes()[0];
    return [b.gx - d.cx, b.gz, -(b.gy - d.cy)];
  });
  // Drag outward along view -Z (G-code +Y) to ~10 mm from the centre.
  await drag(page, await projectView(page, facePt), await projectView(page, [faceTo[0], faceTo[1], faceTo[2] - 10]));
  const b3 = await boxState(page);
  console.log(`       after face drag: rx ${b3.box.rx.toFixed(3)}, ry ${b3.box.ry.toFixed(3)}`);
  check('a face drag after it keeps the rectangle\'s shape (rx : ry)',
    Math.abs(b3.box.rx / b3.box.ry - b2.box.rx / b2.box.ry) < 1e-6, true);
  check('and the drag outward grew it', b3.box.ry > b2.box.ry, true);
  check('and the selection is still exactly the rectangle\'s moves', b3.exact, true);

  // Put it back to the drag-2 rectangle for the camera half.
  await page.evaluate(([x, y, z, rx, ry]) => {
    const M = window.NSO_MICROSCOPE; M.clearBoxes(); M.addBoxAt(x, y, z, rx, 1, ry);
  }, [...at, b2.box.rx, b2.box.ry]);
  const b4 = await boxState(page);
  check('addBoxAt takes a rectangle too, and catches the same moves as the drag', b4.n, b2.n);

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

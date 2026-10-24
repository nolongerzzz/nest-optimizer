#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_custom_drive_check.mjs   (npm run support:custom)
 *
 * The SUPPORTS card's three-way switch - Auto, Assisted, Custom - on the real page
 * (app-supports-card.js), headless Chromium at 1280 x 800, real mouse and keys.
 * The piece is support:beacons' tilted box (40 x 30 x 10, underside at 30 deg, 120
 * spots). The planner's inputs are read off what the card posts to its worker
 * (opts.feed, docs/SUPPORT-GRIDPACK.md section 7), so the card is held to what the
 * ticket says it drives: mode, tips, beaconsOff, landingZones, excluded.
 *
 *   1  THE SWITCH. Auto is the card as it was: the outlined areas, no points, no
 *      tools row, the old hint, and GENERATE posts no feed at all. Assisted and
 *      Custom show the tools row (Tips, Circles, Erase); the switch is a setting,
 *      not an Undo step; going back to Auto takes the markers away.
 *   2  BEACON TOGGLES (Assisted). The detected spots are points drawn over the
 *      piece; a click turns one off (grey, "1 off") and a second turns it back on,
 *      each one Undo. GENERATE posts mode assisted with that spot in beaconsOff and
 *      builds nothing at it.
 *   3  CIRCLES. Circles is a switch you start and stop: with it on, a drag on bare
 *      plate draws a circle (the view does not orbit), a drag on its edge resizes
 *      it, a drag inside moves it, a click selects it and Delete removes it - each
 *      one Undo; Escape and the button both stop it, and the view orbits again.
 *      GENERATE posts them as landingZones and every foot stands inside one.
 *   4  TIPS (Custom). No spots show. A click on the underside places a tip, a click
 *      on a tip takes it away (each one Undo); a click on a face that looks up is
 *      refused by name. GENERATE posts mode custom with the tips and builds from
 *      them alone. Shift-click: adds a spot in Assisted (as in Auto), does nothing
 *      more than a click in Custom.
 *   5  THE ERASER. ERASE is off in Auto and before a build, on after one. Hovering
 *      a built member lights it and everything it holds up (members[].carries) and
 *      nothing is said anywhere - no readout, no list. A click removes it: the plan
 *      is made again with the member's id in `excluded`, the member is not in the
 *      new build, one Undo puts the old build back.
 *   6  SURVIVE, FORGET. Tips, toggles, circles and erasures outlive a second
 *      GENERATE (the same members come back); REMOVE ALL forgets them (one Undo
 *      puts them back); CLEAR PLATE forgets them.
 *   7  THE MARKERS own the pointer: they draw over everything, a press on one does
 *      not select or move the piece, and a press on bare plate with no tool on
 *      orbits.
 *   8  Screenshots of all three modes and an erase-hover in tools/supports-custom-out/.
 *      No page errors.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'supports-custom-out');
const W = 1280, H = 800;

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return o;
}
function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return Array.from(b);
}
/* support:beacons' tilted box: turned 30 deg about y, lowest edge on the plate. */
const TILT = 30 * Math.PI / 180;
const TILTED = stl(box([0, 0, 0], [40, 30, 10]).map((v, i, a) => {
  const k = i % 3, p = a.slice(i - k, i - k + 3);
  return k === 0 ? p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT)
    : k === 1 ? p[1] : p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT);
}));
const AUTO_HINT = 'Click an outlined area to leave it out, or put it back. Shift-click the piece to add a spot. Click a support to pick it.';

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  let cdn = [];

  async function freshPage() {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    cdn = cdn.concat(routeCdn(page));
    /* what the card posts to its planner worker: the feed, as sent, per area */
    await page.addInitScript(() => {
      const Real = window.Worker;
      window.__sent = [];
      window.Worker = function (url, o) {
        const w = new Real(url, o), pm = w.postMessage.bind(w);
        w.postMessage = (m, t) => {
          if (m && m.opts && !m.plan) {
            window.__sent.push({ feed: m.opts.feed === undefined ? null : JSON.parse(JSON.stringify(m.opts.feed)), beacons: (m.opts.beacons || []).length });
          }
          return pm(m, t);
        };
        return w;
      };
      window.Worker.prototype = Real.prototype;
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
    await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [['box.stl', TILTED]]);
    await page.waitForFunction(() => state.models.length === 1 && state.placed.length === 1, null, { timeout: 30000 });
    return page;
  }

  const page = await freshPage();
  const card = () => page.evaluate(() => window.NSO_SUPPORTS_CARD);   // (never serialised; for readability below)
  void card;
  const V = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.view());
  const M = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.markers());
  const sent = () => page.evaluate(() => window.__sent.slice());
  const idle = () => page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
  const depth = () => page.evaluate(() => state.undoStack.length);
  const members = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.members());
  const sups = () => page.evaluate(() => state.models.filter((m) => m.nsoSupport && state.placed.some((p) => p.sourceId === m.id)).map((m) => m.id).sort((a, b) => a - b));
  const NONE = { tips: 0, off: 0, zones: 0, erased: 0 };
  const feedOf = () => page.evaluate(() => { const f = state.models.find((m) => !m.nsoSupport).nsoSupportFeed; return f ? { tips: f.tips.length, off: f.off.length, zones: f.zones.length, erased: f.erased.length } : { tips: 0, off: 0, zones: 0, erased: 0 }; });
  const line = () => page.evaluate(() => document.getElementById('sup-count').textContent);
  const shot = async (file) => { await frames(page); await page.screenshot({ path: join(SHOTS, file) }); console.log('       ' + file); };
  const click = async (sel) => { await page.click(sel); await frames(page); };
  const clickAt = async (p) => { await page.mouse.move(p.x - 2, p.y - 2); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await frames(page); };
  const drag = async (a, b, steps = 6) => {
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up(); await frames(page);
  };
  const oneStep = async (label, fn) => {
    const d0 = await depth();
    const r = await fn();
    await idle(); await frames(page);
    check(label + ' is one Undo step', await depth(), d0 + 1);
    return r;
  };
  const undo = async () => { await click('#btn-undo'); await frames(page); };

  /** Look at world point `at` (Z up) from direction `d`, then slide the view so `at` sits at screen x `sx`. */
  async function look(at, d, dist, sx = 820) {
    await page.evaluate(([at, d, dist, sx]) => {
      const L = Math.hypot(d[0], d[1], d[2]), c = new THREE.Vector3(at[0], at[2], -at[1]);
      state.controls.target.copy(c);
      state.camera.position.set(c.x + d[0] / L * dist, c.y + d[2] / L * dist, c.z - d[1] / L * dist);
      state.camera.updateProjectionMatrix(); state.controls.update(); state.camera.updateMatrixWorld();
      for (let k = 0; k < 4; k++) {
        const r = state.renderer.domElement.getBoundingClientRect(), v = c.clone().project(state.camera);
        const px = r.left + (v.x + 1) / 2 * r.width, right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0);
        const mmPerPx = state.camera.position.distanceTo(c) * 2 * Math.tan(state.camera.fov * Math.PI / 360) / r.height;
        const s = right.multiplyScalar((px - sx) * mmPerPx);
        state.controls.target.add(s); state.camera.position.add(s); state.controls.update(); state.camera.updateMatrixWorld();
      }
    }, [at, d, dist, sx]);
    await frames(page);
  }
  const bounds = await page.evaluate(() => { const b = new THREE.Box3().setFromObject(state.placed[0].mesh); return { lo: [b.min.x, -b.max.z, b.min.y], hi: [b.max.x, -b.min.z, b.max.y] }; });
  const cx = (bounds.lo[0] + bounds.hi[0]) / 2, cy = (bounds.lo[1] + bounds.hi[1]) / 2;
  const sideView = () => look([cx, cy, 6], [1, 0, 0.3], 90);          // the underside faces +x and down: seen from the +x side, low
  const plateView = () => look([cx, cy, 0], [0.4, -1, 1.3], 150);     // from above and in front: the plate is drawn on
  const plateXY = (x, y) => page.evaluate(([x, y]) => {
    const v = new THREE.Vector3(x, 0, -y).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, [x, y]);
  /** n client points on the underside (rays from the camera that hit the piece on a face looking down), spread apart. */
  const undersidePoints = (n) => page.evaluate((n) => {
    const r = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster(), out = [], mesh = state.placed[0].mesh;
    for (let iy = 0; iy < 60; iy++) for (let ix = 0; ix < 80; ix++) {
      const x = r.left + 460 + ix * ((r.width - 520) / 80), y = r.top + 60 + iy * ((r.height - 120) / 60);
      rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), state.camera);
      const h = rc.intersectObject(mesh, false)[0];
      if (!h) continue;
      const nrm = h.face.normal.clone().transformDirection(mesh.matrixWorld);
      if (nrm.y < -0.8) out.push({ x, y, p: h.point.toArray() });
    }
    const pick = [], far = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > 4.5;
    for (let k = 0; k < n; k++) {
      const q = out[Math.floor((k + 0.5) * out.length / n)];
      if (q && pick.every((s) => far(s, q))) pick.push(q);
    }
    return pick;
  }, n);
  /** a screen point on a face of the piece that looks up */
  const topPoint = () => page.evaluate(() => {
    const r = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster(), mesh = state.placed[0].mesh;
    for (let iy = 0; iy < 60; iy++) for (let ix = 0; ix < 80; ix++) {
      const x = r.left + 460 + ix * ((r.width - 520) / 80), y = r.top + 60 + iy * ((r.height - 120) / 60);
      rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), state.camera);
      const h = rc.intersectObject(mesh, false)[0];
      if (h && h.face.normal.clone().transformDirection(mesh.matrixWorld).y > 0.8) return { x, y };
    }
    return null;
  });
  const orbitTest = async (label, expectOrbit) => {
    const start = await plateXY(cx - 40, cy + 60);
    const before = await page.evaluate(() => ({ q: state.camera.quaternion.toArray(), t: state.controls.target.toArray() }));
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(start.x + i * 7, start.y + i * 2);
    await page.mouse.up(); await frames(page);
    const after = await page.evaluate(() => ({ q: state.camera.quaternion.toArray(), t: state.controls.target.toArray() }));
    const turned = Math.max(...after.q.map((v, i) => Math.abs(v - before.q[i])));
    check(label, turned > 1e-3, expectOrbit);
    return turned;
  };

  await page.evaluate(() => { document.getElementById('menu-supports').open = true; });
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().beacons.length > 0, null, { timeout: 30000 });
  await frames(page);

  // =======================================================================
  console.log('\n--- 1. the switch ---');
  // =======================================================================
  const ui = () => page.evaluate(() => {
    const $ = (id) => document.getElementById(id), shown = (e) => !!e && !e.hidden && e.getBoundingClientRect().width > 0;
    return {
      mode: ['auto', 'assisted', 'custom'].find((k) => $('sup-mode-' + k).getAttribute('aria-pressed') === 'true'),
      modesShown: ['auto', 'assisted', 'custom'].map((k) => shown($('sup-mode-' + k))), toolsShown: shown($('sup-tools')),
      tool: ['tips', 'circles', 'erase'].find((k) => $('sup-tool-' + k).getAttribute('aria-pressed') === 'true'),
      erase: !$('sup-tool-erase').disabled, hint: $('sup-hint').textContent,
      outline: !!state.scene.getObjectByName('supportsCardOverlay'), points: !!state.scene.getObjectByName('supportsCardPoints'),
      zones: !!state.scene.getObjectByName('supportsCardZones')
    };
  });
  const d0 = await depth();
  const u0 = await ui();
  check('the card opens on Auto: the three-way switch is there, no tools row', [u0.mode, u0.modesShown, u0.toolsShown], ['auto', [true, true, true], false]);
  check('...Auto is the card as it was: the areas outlined, no points, the old hint, the old readout',
    [u0.outline, u0.points, u0.hint, await line()], [true, false, AUTO_HINT, '1 hanging area at 35° on box']);
  await click('#btn-sup-all'); await idle();
  const autoBuilt = await sent();
  check('...GENERATE in Auto posts no feed at all (today\'s planner call)', [autoBuilt.length > 0, autoBuilt.every((s) => s.feed === null)], [true, true]);
  check('...the Erase tool does not exist to use in Auto: the tools row is hidden', (await ui()).toolsShown, false);
  await click('#btn-sup-none'); await frames(page);
  const dAuto = await depth();
  await click('#sup-mode-assisted');
  const ua = await ui();
  check('Assisted: the tools row shows - Tips on, Circles off, Erase off (nothing built)', [ua.mode, ua.toolsShown, ua.tool, ua.erase], ['assisted', true, 'tips', false]);
  check('...the areas are no longer outlined: the points are drawn, one per spot', [ua.outline, ua.points, (await M()).points], [false, true, 120]);
  check('...the switch is a setting, not an Undo step', await depth(), dAuto);
  await shot('assisted.png');
  await click('#sup-mode-custom');
  const uc = await ui();
  check('Custom: no spots show - the card says "No tips yet", no points are drawn', [uc.mode, uc.points, (await M()).points, await line()], ['custom', false, 0, 'No tips yet on box']);
  check('...GENERATE is off with no tip', await page.evaluate(() => document.getElementById('btn-sup-all').disabled), true);
  await shot('custom.png');
  await click('#sup-mode-auto');
  const ub = await ui();
  check('back to Auto: the markers are gone, the areas outlined again, the old hint, the tools row hidden', [ub.points, ub.zones, ub.outline, ub.hint, ub.toolsShown], [false, false, true, AUTO_HINT, false]);
  await shot('auto.png');
  void d0;

  // =======================================================================
  console.log('\n--- 2. beacon toggles (Assisted) ---');
  // =======================================================================
  await click('#sup-mode-assisted');
  const v2 = await V();
  const spot = v2.beacons[Math.floor(v2.beacons.length / 2)];
  const at2 = await page.evaluate((k) => window.NSO_SUPPORTS_CARD.screenOf('spot', k), spot.key);
  await oneStep('a click on a point turns that spot off', async () => clickAt(at2));
  const v2b = await V();
  check('...it is off (grey), the readout counts it, and the others are still on', [v2b.beacons.find((b) => b.key === spot.key).off, v2b.beacons.filter((b) => b.off).length, await line()],
    [true, 1, '119 spots at 35° on box · 1 off']);
  await oneStep('a second click turns it back on', async () => clickAt(at2));
  check('...nothing is off any more', [(await V()).beacons.filter((b) => b.off).length, await line()], [0, '120 spots at 35° on box']);
  await undo();
  check('Undo takes the last toggle back (off again)', (await V()).beacons.filter((b) => b.off).length, 1);
  await undo(); await undo();
  check('...and the one before it: nothing off', (await V()).beacons.filter((b) => b.off).length, 0);
  check('...a point under the pointer is lit and the cursor says so',
    await (async () => { await page.mouse.move(at2.x, at2.y); await frames(page); await frames(page); return [(await M()).hot, await page.evaluate(() => state.renderer.domElement.style.cursor)]; })(), [spot.key, 'pointer']);
  await clickAt(at2);                                                  // off, for the build
  const offKey = spot.key;
  await page.evaluate(() => { window.__sent.length = 0; });
  await click('#btn-sup-all'); await idle();
  const s2 = await sent();
  const offId = await page.evaluate((k) => { const b = window.NSO_SUPPORTS_CARD.view().beacons.find((x) => x.key === k); return window.NSO_SupportGridpack.tipId(b.p, false); }, offKey);
  check('GENERATE posts mode assisted, the spot in beaconsOff, no tips, no zones', [s2[0].feed.mode, s2[0].feed.beaconsOff, s2[0].feed.tips, s2[0].feed.landingZones, s2[0].feed.excluded],
    ['assisted', [offId], undefined, [], []]);
  check('...and builds nothing at the spot that is off (no support holds it)', await page.evaluate((k) => state.models.filter((m) => m.nsoSupport && (m.nsoSupport.keys || []).includes(k)).length, offKey), 0);
  check('...and the build line reads as before: no unreachable area', await line(), 'Built: 1 support \u00b7 held 1 \u00b7 unsupported 0 \u00b7 unreachable 0');
  await shot('assisted-built.png');

  // =======================================================================
  console.log('\n--- 3. circles ---');
  // =======================================================================
  await click('#btn-sup-none');                                         // REMOVE ALL forgets the toggle too (section 6 holds it)
  await plateView();
  await orbitTest('with no tool on, a left-drag on bare plate orbits', true);
  await plateView();
  await click('#sup-tool-circles');
  check('Circles starts: the button is on, the hint says how to draw and how to stop, the cursor is a crosshair',
    [(await ui()).tool, (await ui()).hint.startsWith('Drawing circles'), await page.evaluate(() => state.renderer.domElement.style.cursor)], ['circles', true, 'crosshair']);
  const dz = await depth();
  for (let i = 0; i < 40; i++) {                                         // let the view's own easing (damping) come to rest first
    const c0 = await page.evaluate(() => state.camera.position.toArray()); await frames(page);
    const c1 = await page.evaluate(() => state.camera.position.toArray());
    if (c0.every((v, k) => Math.abs(v - c1[k]) < 1e-9)) break;
  }
  const camBefore = await page.evaluate(() => state.camera.position.toArray());
  const a3 = await plateXY(cx + 4, cy), b3 = await plateXY(cx + 4 + 14, cy);
  await drag(a3, b3);
  const camAfter = await page.evaluate(() => state.camera.position.toArray());
  const z1 = (await M()).zones;
  check('a drag on bare plate draws a circle (centre where it began, radius to where it ended) and the view did not orbit',
    [z1.length, Math.abs(z1[0].x - (cx + 4)) < 0.5, Math.abs(z1[0].r - 14) < 0.7, camBefore.every((v, i) => Math.abs(v - camAfter[i]) < 1e-3)], [1, true, true, true]);
  check('...one Undo step', await depth(), dz + 1);
  const tiny = await plateXY(cx - 30, cy + 20);
  await drag(tiny, { x: tiny.x + 1, y: tiny.y + 1 }, 1);
  check('...a click (a drag under 1.5 mm) draws nothing', [(await M()).zones.length, await depth()], [1, dz + 1]);
  const edge = await plateXY(cx + 4 + 14, cy), edge2 = await plateXY(cx + 4 + 19, cy);
  await oneStep('a drag on the circle\'s edge resizes it', async () => drag(edge, edge2));
  const z2 = (await M()).zones[0];
  check('...the radius follows the pointer (19 mm), the centre stays', [Math.abs(z2.r - 19) < 0.8, Math.abs(z2.x - (cx + 4)) < 0.3], [true, true]);
  const inside = await plateXY(cx + 4, cy), moved = await plateXY(cx + 4 - 3, cy + 2);
  await oneStep('a drag inside it moves it', async () => drag(inside, moved));
  const z3 = (await M()).zones[0];
  check('...the centre moved by the drag (about 3 mm in x), the radius stayed', [Math.abs(z3.x - (cx + 1)) < 0.8, Math.abs(z3.r - z2.r) < 0.01], [true, true]);
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  const ctr = await plateXY(z3.x, z3.y);
  const dq = await depth();
  await clickAt(ctr);
  check('a click on it selects it (lit, no Undo step)', [(await M()).selected, await depth()], [0, dq]);
  await shot('circle-selected.png');
  await page.keyboard.press('Delete'); await frames(page);
  check('Delete removes the selected circle - one Undo step', [(await M()).zones.length, await depth()], [0, dq + 1]);
  await undo();
  check('...Undo puts it back where it was', [(await M()).zones.length, Math.abs((await M()).zones[0].x - z3.x) < 1e-6], [1, true]);
  await page.keyboard.press('Escape'); await frames(page);
  check('Escape stops the tool: Tips is on again, the crosshair is gone', [(await ui()).tool, await page.evaluate(() => state.renderer.domElement.style.cursor)], ['tips', '']);
  await orbitTest('...and a left-drag on bare plate orbits', true);
  await plateView();
  await click('#sup-tool-circles'); await click('#sup-tool-circles');
  check('the button stops it too (pressed again)', (await ui()).tool, 'tips');
  await orbitTest('...and the drag orbits', true);
  await plateView();
  await click('#sup-tool-circles');
  await page.evaluate(() => { window.__sent.length = 0; });
  await click('#sup-tool-circles');
  await click('#btn-sup-all'); await idle();
  const s3 = await sent();
  check('GENERATE posts the circle as landingZones',
    [s3[0].feed.landingZones.length, Math.abs(s3[0].feed.landingZones[0].x - z3.x) < 1e-6, Math.abs(s3[0].feed.landingZones[0].r - z3.r) < 1e-6], [1, true, true]);
  check('...and the build shows it: the zone is used, not empty; the spots no zone can take are named unreachable (3 of 120, out of its reach)',
    [(await M()).zonesEmpty, await line()], [[], 'Built: 1 support \u00b7 held 1 \u00b7 unsupported 0 \u00b7 unreachable 1']);
  await shot('circles-built.png');

  // =======================================================================
  console.log('\n--- 4. tips (Custom) ---');
  // =======================================================================
  await click('#btn-sup-none');
  await click('#sup-mode-custom');
  await sideView();
  const pts = await undersidePoints(3);
  check('three spread points on the underside to click', pts.length, 3);
  const ids = [];
  for (const q of pts) {
    await oneStep('a click on the underside places a tip', async () => clickAt(q));
  }
  const vc = await V();
  check('...three tips, drawn as three points, each its own area or joined to a near one; the readout says so',
    [vc.beacons.length, vc.beacons.every((b) => b.tip), (await M()).tips, (await M()).points, await line()], [3, true, 3, 3, '3 tips on box']);
  vc.beacons.forEach((b) => ids.push(b.key));
  const tipXY = await page.evaluate((k) => window.NSO_SUPPORTS_CARD.screenOf('tip', k), ids[1]);
  await oneStep('a click on a tip takes it away', async () => clickAt(tipXY));
  check('...two tips are left', [(await M()).tips, await line()], [2, '2 tips on box']);
  await undo();
  check('Undo puts the tip back', (await M()).tips, 3);
  const top = await (async () => { await look([cx, cy, 14], [-1, 0, 1.5], 90); return topPoint(); })();
  const dt = await depth();
  await clickAt(top);
  check('a click on a face that looks up is refused by name: no tip, no Undo step',
    [(await M()).tips, await depth(), await line()], [3, dt, 'That face looks up - nothing hangs from it. Click a side or the underside.']);
  await sideView();
  await page.evaluate(() => { window.__sent.length = 0; });
  await click('#sup-tool-circles'); await click('#sup-tool-circles');
  await click('#btn-sup-all'); await idle();
  const s4 = await sent();
  check('GENERATE posts mode custom with the three tips (as x, y, z), no beaconsOff, and no detected beacons planned',
    [s4.length, s4[0].feed.mode, s4.reduce((n, s) => n + s.feed.tips.length, 0), s4[0].feed.beaconsOff, s4[0].beacons], [s4.length, 'custom', 3, undefined, 0]);
  const built4 = await page.evaluate(() => state.models.filter((m) => m.nsoSupport && state.placed.some((p) => p.sourceId === m.id)).flatMap((m) => m.nsoSupport.keys).sort());
  check('...the supports hold those three tips and nothing else', built4, [...ids].sort());
  check('...Built: 1 support', (await line()).startsWith('Built: 1 support'), true);
  await shot('custom-built.png');
  await click('#btn-sup-none');
  await click('#sup-mode-assisted');
  await sideView();
  const sh = await undersidePoints(1);
  const nBefore = (await V()).beacons.length;
  await page.keyboard.down('Shift'); await clickAt(sh[0]); await page.keyboard.up('Shift'); await frames(page);
  check('Shift-click in Assisted adds a spot, as it does in Auto (one more point)', [(await V()).beacons.length, (await V()).beacons.filter((b) => b.manual).length], [nBefore + 1, 1]);
  await undo();
  await click('#sup-mode-custom');
  await sideView();
  const sc2 = await undersidePoints(1);
  await page.keyboard.down('Shift'); await clickAt(sc2[0]); await page.keyboard.up('Shift'); await frames(page);
  check('Shift-click in Custom is a click: one tip, and the hint does not mention Shift', [(await M()).tips, (await ui()).hint.includes('Shift')], [1, false]);
  await undo();

  // =======================================================================
  console.log('\n--- 5. the eraser ---');
  // =======================================================================
  await click('#sup-mode-auto');
  check('ERASE does not exist in Auto (the tools row is hidden)', (await ui()).toolsShown, false);
  await click('#sup-mode-custom');
  check('...and in Custom it is off before a build', (await ui()).erase, false);
  await sideView();
  for (const q of await undersidePoints(3)) await clickAt(q);
  await plateView();
  await click('#sup-tool-circles');
  await drag(await plateXY(cx + 4, cy), await plateXY(cx + 4 + 14, cy));
  await click('#sup-tool-circles');
  await click('#btn-sup-all'); await idle();
  check('...and on after a build', (await ui()).erase, true);
  const built = await members();
  const trunk = built.find((x) => x.kind === 'trunk');
  check('the build named its members: a trunk and the three tips', [!!trunk, built.filter((x) => x.kind === 'tip').length], [true, 3]);
  const zc = (await M()).zones[0];
  check('...every trunk stands inside the circle (its end within the radius of the centre)', built.filter((x) => x.kind === 'trunk').every((x) => Math.hypot(x.to[0] - zc.x, x.to[1] - zc.y) <= zc.r), true);
  await sideView();
  await click('#sup-tool-erase');
  check('Erase starts: the hint says what a hover and a click do', [(await ui()).tool, (await ui()).hint.startsWith('Erasing')], ['erase', true]);
  const cardText = await page.evaluate(() => document.getElementById('supports-card').innerText);
  const statusText = await page.evaluate(() => document.getElementById('status').textContent);
  const mp = await page.evaluate((id) => window.NSO_SUPPORTS_CARD.screenOf('member', id), trunk.id);
  await page.mouse.move(mp.x - 40, mp.y - 40); await page.mouse.move(mp.x, mp.y, { steps: 4 }); await frames(page); await frames(page);
  const mk = await M();
  const RANK = { tip: 0, sheet: 1, branch: 2, trunk: 3, pad: 4 };
  const expectLit = built.filter((x) => x.id === trunk.id || (RANK[x.kind] < RANK.trunk && x.carries.every((t) => trunk.carries.includes(t)))).map((x) => x.id).sort();
  check('hovering the trunk lights it and everything it holds up - itself and the members whose carries are among its own - as many marks as members', [mk.hover, [...mk.lit].sort(), mk.eraseLayer], [trunk.id, expectLit, expectLit.length]);
  check('...and nothing is said: the card\'s text, the status line and the rows are as they were',
    [await page.evaluate(() => document.getElementById('supports-card').innerText), await page.evaluate(() => document.getElementById('status').textContent), await page.evaluate(() => document.getElementById('sup-rows').hidden)],
    [cardText, statusText, true]);
  await shot('erase-hover.png');
  await page.mouse.move(mp.x + 300, mp.y + 200); await frames(page); await frames(page);
  check('moving off it puts the light out', [(await M()).hover, (await M()).eraseLayer], [null, 0]);
  const before = { ids: await sups(), members: built.map((x) => x.id).sort() };
  await page.mouse.move(mp.x, mp.y, { steps: 3 }); await frames(page); await frames(page);
  const dE = await depth();
  await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 5000 }).catch(() => {});
  await idle(); await frames(page);
  const after = await members();
  const sE = await sent();
  check('a click removes it: the plan is made again with its id in excluded', [sE[sE.length - 1].feed.excluded, sE[sE.length - 1].feed.mode], [[trunk.id], 'custom']);
  check('...the member is not in the new build, and the tips are still held (3 tips)', [after.some((x) => x.id === trunk.id), after.filter((x) => x.kind === 'tip').length], [false, 3]);
  check('...one Undo step', await depth(), dE + 1);
  check('...the card says Built again, and Erase is still the tool', [(await line()).startsWith('Built: '), (await ui()).tool], [true, 'erase']);
  await undo();
  check('Undo puts the old build back: the same members, and the erasure forgotten', [(await members()).map((x) => x.id).sort(), (await feedOf()).erased], [before.members, 0]);
  check('...and as many supports are on the plate as before', (await sups()).length, before.ids.length);
  await page.keyboard.press('Escape'); await frames(page);
  check('Escape stops Erase', (await ui()).tool, 'tips');

  // =======================================================================
  console.log('\n--- 6. survive a second GENERATE, and forget ---');
  // =======================================================================
  await click('#sup-tool-erase');
  const mp2 = await page.evaluate((id) => window.NSO_SUPPORTS_CARD.screenOf('member', id), trunk.id);
  await page.mouse.move(mp2.x, mp2.y, { steps: 3 }); await frames(page); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await idle(); await frames(page);
  await click('#sup-tool-erase');
  const f1 = await feedOf();
  const m1 = (await members()).map((x) => x.id).sort();
  await click('#btn-sup-all'); await idle(); await frames(page);
  check('the tips, the circle and the erasure are still there after a second GENERATE', [await feedOf(), f1.tips, f1.zones, f1.erased], [f1, 3, 1, 1]);
  check('...and the same members come back', (await members()).map((x) => x.id).sort(), m1);
  await click('#sup-mode-assisted'); await click('#sup-mode-custom');
  check('...a trip to another mode and back keeps them', await feedOf(), f1);
  const dr = await depth();
  await click('#btn-sup-none');
  check('REMOVE ALL (the card\'s reset) forgets them, in one Undo step', [await feedOf(), await depth()], [NONE, dr + 1]);
  await undo();
  check('...and Undo puts them back', await feedOf(), f1);
  await click('#btn-clear-plate'); await frames(page);
  check('CLEAR PLATE forgets them (the piece stays in the list)', [await feedOf(), await page.evaluate(() => state.models.filter((m) => !m.nsoSupport).length), await page.evaluate(() => state.placed.length)], [NONE, 1, 0]);

  // =======================================================================
  console.log('\n--- 7. the markers own the pointer ---');
  // =======================================================================
  const page2 = await freshPage();
  await page2.evaluate(() => { document.getElementById('menu-supports').open = true; });
  await page2.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().beacons.length > 0, null, { timeout: 30000 });
  await page2.click('#sup-mode-assisted');
  await page2.waitForFunction(() => window.NSO_SUPPORTS_CARD.markers().points === 120);
  const mats = await page2.evaluate(() => {
    const pts = state.scene.getObjectByName('supportsCardPoints');
    return { order: pts.renderOrder, depthTest: pts.material.depthTest, helper: pts.userData.nsoHelper, raycast: pts.raycast === (new THREE.Object3D()).raycast };
  });
  check('the points draw over everything (render order 900, depth test off) and are scene helpers no ray can hit', [mats.order, mats.depthTest, mats.helper], [900, false, 'supports-card']);
  const pos0 = await page2.evaluate(() => state.placed[0].mesh.position.toArray());
  const sel0 = await page2.evaluate(() => state.selectedIndex);
  const spot0 = await page2.evaluate(() => window.NSO_SUPPORTS_CARD.screenOf('spot', window.NSO_SUPPORTS_CARD.view().beacons[5].key));
  await page2.mouse.move(spot0.x, spot0.y); await page2.mouse.down();
  for (let i = 1; i <= 8; i++) await page2.mouse.move(spot0.x + i * 6, spot0.y + i * 3);
  await page2.mouse.up(); await frames(page2);
  check('a press on a point, dragged, does not move the piece or change the selection (the point took the press)',
    [await page2.evaluate(() => state.placed[0].mesh.position.toArray()), await page2.evaluate(() => state.selectedIndex)], [pos0, sel0]);
  check('...it toggled the spot', await page2.evaluate(() => window.NSO_SUPPORTS_CARD.markers().off), 1);
  check('nothing hit the CDN unrouted', cdn.filter((x) => x.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);
  await browser.close();
  served.srv.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_workflow_drive_check.mjs   (npm run support:workflow)
 *
 * The SUPPORTS card as a verb with a state (app-supports-card.js), driven in
 * headless Chromium at 1280 x 800 with real clicks on the page. Piece A is
 * support:beacons' tilted box (40 x 30 x 10, underside at 30 deg, 120 beacons
 * in one area); piece B is that box beside a block with a tunnel through it
 * (the tunnel's ceiling hangs over its own floor, so with "May rest on the
 * part" off the plate cannot reach it).
 *
 *   1  PICK. Open the card: it asks for a piece, GENERATE is off. Click the
 *      box: IDLE - "1 overhang area", the area outlined faintly on the surface
 *      (one outline of 44 edges, not a grid; no dots, no badges), GENERATE on,
 *      Remove / Remove all out of sight, the Paint row collapsed.
 *   2  EXCLUDE. A click on the outlined area leaves it out: "0 overhang areas
 *      · 1 left out", outline grey, GENERATE off, nothing built. A second click
 *      puts it back. Each is one Undo.
 *   3  BUILDING. GENERATE: the button reads "Building…", every control is
 *      locked, a spinner turns over the piece, the card and the HUD say
 *      "Building…". (The planner's solid step is held for the screenshot.)
 *   4  BUILT. "Built: N supports · 1 of 1 area held · 0 areas not reachable
 *      from the plate"; GENERATE reads REGENERATE; REMOVE ALL beside it. One Undo.
 *   5  REGENERATE replaces: none of the old supports is left, as many new;
 *      one Undo puts the old ones back, same pieces.
 *   6  REMOVE. A click on a built support picks it; Remove takes that one only
 *      (the line drops to N-1 and 0 of 1 areas held); one Undo.
 *   7  REMOVE ALL. Every support off, the card back in IDLE, the area still
 *      outlined; one Undo puts the same pieces back and the card reads BUILT.
 *   8  SECONDARY ROW. Shift-click a spot on the wall makes a second area
 *      (one Undo); a Paint Skip stroke is one Undo; the second area can be left
 *      out by a click.
 *   9  NOT REACHABLE. Piece B: two areas; GENERATE: "1 of 2 areas held · 1 area
 *      not reachable from the plate", that area outlined in red; leaving it out
 *      after the build drops it from the line (one Undo, Undo puts it back).
 *  10  The HUD (#status) reads exactly the state line at every step; the card
 *      stays inside the window; no page errors. Screenshots of each state in
 *      tools/supports-workflow-out/.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'supports-workflow-out');
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
/* A block with a square tunnel through it along y: the x-z section is a 3 x 3
   grid of cells with the middle one open, extruded 40 mm. Every cell edge is
   shared, so the soup is watertight with no T-junctions. */
function tunnelBlock(x0, x1, z1) {
  const xs = [x0, x0 + 12, x1 - 12, x1], zs = [0, 8, 20, z1], cells = [];
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) if (!(i === 1 && k === 1)) cells.push([i, k]);
  const has = (i, k) => cells.some((c) => c[0] === i && c[1] === k);
  const out = [];
  const quad = (a, b, c, d, want) => {
    const u = b.map((x, i) => x - a[i]), w = c.map((x, i) => x - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
    for (const tri of flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]]) for (const p of tri) out.push(...p);
  };
  for (const [i, k] of cells) {
    const xa = xs[i], xb = xs[i + 1], za = zs[k], zb = zs[k + 1];
    quad([xa, 0, za], [xb, 0, za], [xb, 0, zb], [xa, 0, zb], [0, -1, 0]);
    quad([xa, 40, za], [xb, 40, za], [xb, 40, zb], [xa, 40, zb], [0, 1, 0]);
    for (const [ni, nk, d, e] of [[i - 1, k, [-1, 0], [xa, za, xa, zb]], [i + 1, k, [1, 0], [xb, za, xb, zb]],
                                  [i, k - 1, [0, -1], [xa, za, xb, za]], [i, k + 1, [0, 1], [xa, zb, xb, zb]]]) {
      if (!has(ni, nk)) quad([e[0], 0, e[1]], [e[2], 0, e[3]], [e[2], 40, e[3]], [e[0], 40, e[1]], [d[0], 0, d[1]]);
    }
  }
  return out;
}
function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return Array.from(b);
}
/* support:beacons' tilted box: turned 30 deg about y, lowest edge on the plate. */
const TILT = 30 * Math.PI / 180;
const tilted = box([0, 0, 0], [40, 30, 10]).map((v, i, a) => {
  const k = i % 3, p = a.slice(i - k, i - k + 3);
  return k === 0 ? p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT)
    : k === 1 ? p[1] : p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT);
});
const TILTED = stl(tilted);
const WITH_TUNNEL = stl([...tilted, ...tunnelBlock(60, 100, 30)]);

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  let cdn = [];

  async function freshPage(file, bytes) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    cdn = cdn.concat(routeCdn(page));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
    await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [[file, bytes]]);
    await page.waitForFunction(() => state.models.length === 1 && state.placed.length === 1, null, { timeout: 30000 });
    return page;
  }

  /** Everything a step needs from a page, bound to it. */
  function tools(page) {
    const t = {};
    t.shot = async (file) => { await frames(page); await page.screenshot({ path: join(SHOTS, file) }); console.log('       ' + file); };
    t.view = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.view());
    t.idle = () => page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
    t.undoDepth = () => page.evaluate(() => state.undoStack.length);
    t.sups = () => page.evaluate(() => state.models.filter((m) => m.nsoSupport && state.placed.some((p) => p.sourceId === m.id))
      .map((m) => ({ id: m.id, area: m.nsoSupport.regionId })));
    t.ids = (list) => list.map((s) => s.id).sort((a, b) => a - b);
    /** The card as a person sees it: words, buttons, locks, the HUD. */
    t.card = () => page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      const shown = (e) => { const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0; };
      const sp = $('sup-spinner'), spr = sp && sp.getBoundingClientRect();
      return {
        state: $('supports-card').dataset.state, line: $('sup-count').textContent, hud: $('status').textContent,
        go: { text: $('btn-sup-all').textContent, on: !$('btn-sup-all').disabled },
        removeAll: { shown: shown($('btn-sup-none')), on: !$('btn-sup-none').disabled },
        remove: { shown: shown($('btn-sup-remove')), on: !$('btn-sup-remove').disabled },
        controls: ['sup-style', 'sup-size', 'sup-rest', 'btn-sup-paint', 'sel-sup-paint'].map((id) => !$(id).disabled),
        locked: $('supports-card').classList.contains('is-locked'),
        paintRowOpen: $('sup-more').open,
        spinner: sp ? { shown: shown(sp), anim: getComputedStyle(sp).animationName, at: spr && [spr.left + spr.width / 2, spr.top + spr.height / 2] } : null,
        inside: (() => { const c = $('supports-card').getBoundingClientRect(); return c.width > 0 && c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight; })()
      };
    });
    /** The outlines in the scene: one mesh per area. */
    t.outlines = () => page.evaluate(() => {
      const g = state.scene.getObjectByName('supportsCardOverlay');
      if (!g) return null;
      return {
        kids: g.children.length, allMeshes: g.children.every((o) => o.isMesh && !o.isSprite),
        areas: g.children.map((o) => ({ area: o.userData.area, kind: o.userData.outline, colour: o.material.color.getHex(),
          opacity: o.material.opacity, verts: o.geometry.attributes.position.count }))
      };
    });
    t.screenOf = (p) => page.evaluate((q) => {
      const v = new THREE.Vector3(q[0], q[2], -q[1]).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    }, p);
    /** Look at world point `at` (Z up) from direction `d`, `dist` mm away. */
    t.look = (at, d, dist) => page.evaluate(([at, d, dist]) => {
      const L = Math.hypot(d[0], d[1], d[2]), c = new THREE.Vector3(at[0], at[2], -at[1]);
      state.controls.target.copy(c);
      state.camera.position.set(c.x + d[0] / L * dist, c.y + d[2] / L * dist, c.z - d[1] / L * dist);
      state.camera.updateProjectionMatrix(); state.controls.update(); state.camera.updateMatrixWorld();
    }, [at, d, dist]);
    /** The screen point of the beacon nearest the middle of area `area`: inside its outline,
        whether or not the face in front is the one it is on. */
    t.areaXY = (area) => page.evaluate((area) => {
      const cand = window.NSO_SUPPORTS_CARD.view().beacons.filter((b) => b.region === area);
      const c = [0, 1, 2].map((k) => cand.reduce((s, b) => s + b.p[k], 0) / cand.length);
      const b = cand.reduce((m, x) => Math.hypot(x.p[0] - c[0], x.p[1] - c[1], x.p[2] - c[2]) < Math.hypot(m.p[0] - c[0], m.p[1] - c[1], m.p[2] - c[2]) ? x : m);
      const ndc = new THREE.Vector3(b.p[0], b.p[2], -b.p[1]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (ndc.x + 1) / 2 * r.width, r.top + (1 - ndc.y) / 2 * r.height];
    }, area);
    /** A built support the camera sees first, and where. */
    t.supportXY = () => page.evaluate(() => {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (const p of state.placed) {
        const m = state.models.find((x) => x.id === p.sourceId);
        if (!m || !m.nsoSupport) continue;
        const ndc = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
        const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), state.camera);
        const h = rc.intersectObjects(state.placed.map((q) => q.mesh), false)[0];
        if (h && h.object === p.mesh) return { id: p.sourceId, xy: [r.left + (ndc.x + 1) / 2 * r.width, r.top + (1 - ndc.y) / 2 * r.height] };
      }
      return null;
    });
    t.clickUndo = async () => { await page.click('#btn-undo'); await frames(page); await frames(page); };
    /** One step: it must add exactly one Undo entry. */
    t.oneStep = async (label, fn) => {
      const d0 = await t.undoDepth();
      const r = await fn();
      await t.idle();
      await frames(page);
      check(label + ' is one Undo step', await t.undoDepth(), d0 + 1);
      return r;
    };
    /** The HUD says the state line and nothing else. */
    t.hudIsLine = async (label) => { const c = await t.card(); check(label + ': the HUD reads the state line', c.hud, c.line); return c; };
    /** Hold the planner's solid step until released, so BUILDING can be looked at. */
    t.holdBuild = () => page.evaluate(() => {
      const orig = NSO_SupportGridpack.solid;
      window.__held = false; window.__release = null;
      const gate = new Promise((r) => { window.__release = r; });
      NSO_SupportGridpack.solid = function (plan) {
        const p = orig.call(this, plan);
        window.__held = true;
        NSO_SupportGridpack.solid = orig;
        return gate.then(() => p);
      };
    });
    return t;
  }

  // =======================================================================
  console.log('\n--- 1. pick: IDLE ---');
  // =======================================================================
  let page = await freshPage('tilted.stl', TILTED);
  let T = tools(page);
  const boxId = await page.evaluate(() => state.placed[0].sourceId);
  await page.click('#menu-supports > summary');
  await frames(page);
  let c = await T.card();
  check('the column\'s Supports opens the card, which asks for a piece', [c.state, c.line], ['pick', 'Click a piece to see where it needs holding.']);
  check('...GENERATE is off, Remove all and Remove are out of sight, the Paint row is collapsed',
    [c.go, c.removeAll.shown, c.remove.shown, c.paintRowOpen], [{ text: 'Generate', on: false }, false, false, false]);
  check('...the card sits wholly inside the 1280 x 800 window', c.inside, true);
  await T.hudIsLine('pick');

  const DIR = [1, -0.45, -0.02];
  await T.look(await page.evaluate((id) => {
    const bb = new THREE.Box3().setFromObject(state.placed.find((q) => q.sourceId === id).mesh), m = bb.getCenter(new THREE.Vector3());
    return [m.x, -m.z, m.y];
  }, boxId), DIR, 105);
  const d1 = await T.undoDepth();
  const at1 = await page.evaluate((id) => { window.NSO_SUPPORTS_CARD.pick(id); return true; }, boxId);
  await frames(page);
  c = await T.card();
  let v = await T.view();
  check('picking the box: IDLE, "1 overhang area"', [c.state, c.line], ['idle', '1 overhang area']);
  check('...GENERATE is the one live button; Style, Size, May-rest and Paint are live; Remove all and Remove are out of sight',
    [c.go, c.removeAll.shown, c.remove.shown, c.controls, c.locked], [{ text: 'Generate', on: true }, false, false, [true, true, true, true, true], false]);
  check('...nothing is built and nothing was added to Undo', [(await T.sups()).length, await T.undoDepth()], [0, d1]);
  await T.hudIsLine('idle');
  let ol = await T.outlines();
  const rows = new Set(v.beacons.map((b) => b.p[1].toFixed(3))).size, cols = v.beacons.length / rows;
  check('the face is 12 x 10 spots', [cols, rows], [12, 10]);
  check('the area is outlined once, faint white, on the surface: one outline of its 44 edge segments (not a grid), no dots, no badges',
    [ol.kids, ol.allMeshes, ol.areas.map((a) => [a.area, a.kind, a.colour, a.opacity < 0.6, a.verts])], [1, true, [[0, 'on', 0xffffff, true, 2 * (cols + rows) * 6]]]);
  await T.shot('01-idle.png');

  // =======================================================================
  console.log('\n--- 2. a click on the area leaves it out, and puts it back ---');
  // =======================================================================
  let xy = await T.areaXY(0);
    await T.oneStep('Leaving the area out', async () => { await page.mouse.click(xy[0], xy[1]); });
  c = await T.card();
  v = await T.view();
  check('the count drops: "0 overhang areas · 1 left out", still IDLE', [c.state, c.line], ['idle', '0 overhang areas · 1 left out']);
  check('...the outline goes grey', (await T.outlines()).areas.map((a) => [a.kind, a.colour]), [['off', 0x7b8494]]);
  check('...GENERATE is off (nothing to build), and nothing was built', [c.go.on, (await T.sups()).length], [false, 0]);
  await T.hudIsLine('left out');
  await T.shot('02-area-left-out.png');
  await T.clickUndo();
  c = await T.card();
  check('Undo puts it back: "1 overhang area", white', [c.line, (await T.outlines()).areas[0].kind], ['1 overhang area', 'on']);
  await T.oneStep('Leaving the area out again', async () => { await page.mouse.click(xy[0], xy[1]); });
  check('...left out again', (await T.card()).line, '0 overhang areas · 1 left out');
  await T.oneStep('Including the area again', async () => { await page.mouse.click(xy[0], xy[1]); });
  c = await T.card();
  check('a click on the grey outline includes it again: "1 overhang area", white, GENERATE on',
    [c.line, (await T.outlines()).areas[0].kind, c.go.on], ['1 overhang area', 'on', true]);
  check('nothing has been built by any of those clicks', (await T.sups()).length, 0);

  // =======================================================================
  console.log('\n--- 3. GENERATE: BUILDING ---');
  // =======================================================================
  await T.holdBuild();
  const d3 = await T.undoDepth();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.__held === true, null, { timeout: 120000 });
  await frames(page);
  c = await T.card();
  check('BUILDING: the button reads "Building…", off', c.go, { text: 'Building…', on: false });
  check('...the card says "Building…" and is locked: Style, Size, May-rest, Paint all off',
    [c.state, c.line, c.locked, c.controls], ['building', 'Building…', true, [false, false, false, false, false]]);
  await T.hudIsLine('building');
  const centre = await page.evaluate(() => {
    const p = state.placed.find((q) => !state.models.find((m) => m.id === q.sourceId).nsoSupport);
    const n = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (n.x + 1) / 2 * r.width, r.top + (1 - n.y) / 2 * r.height];
  });
  check('...a spinner is turning on the piece',
    [c.spinner.shown, c.spinner.anim, c.spinner.at && Math.hypot(c.spinner.at[0] - centre[0], c.spinner.at[1] - centre[1]) < 3], [true, 'sup-spin', true]);
  check('...nothing is on the plate yet, and no Undo step yet', [(await T.sups()).length, await T.undoDepth()], [0, d3]);
  await T.shot('03-building.png');
  await page.evaluate(() => window.__release());
  await T.idle();
  await frames(page);
  check('Generate is one Undo step', await T.undoDepth(), d3 + 1);

  // =======================================================================
  console.log('\n--- 4. BUILT ---');
  // =======================================================================
  c = await T.card();
  let s = await T.sups();
  const N = s.length;
  check('BUILT: "Built: N supports · 1 of 1 area held · 0 areas not reachable from the plate", N the supports on the plate',
    [c.state, c.line, N > 0], ['built', 'Built: ' + N + ' supports · 1 of 1 area held · 0 areas not reachable from the plate', true]);
  check('...GENERATE reads REGENERATE and REMOVE ALL sits beside it; Remove (one) is shown, off until a support is picked',
    [c.go, c.removeAll, c.remove, c.spinner.shown, c.locked], [{ text: 'Regenerate', on: true }, { shown: true, on: true }, { shown: true, on: false }, false, false]);
  await T.hudIsLine('built');
  check('...every spot is held, the area is still outlined in white', [(await T.view()).beacons.every((b) => b.state === 'held'), (await T.outlines()).areas.map((a) => a.kind)], [true, ['on']]);
  check('...the supports are card supports of area 0', s.length > 0 && (await page.evaluate(() => state.models.filter((m) => m.nsoSupport).every((m) => m.nsoSupport.card && m.nsoSupport.regionId === 0))), true);
  await T.shot('04-built.png');
  const built1 = T.ids(s);

  // =======================================================================
  console.log('\n--- 5. REGENERATE replaces ---');
  // =======================================================================
  await T.oneStep('Regenerate', () => page.click('#btn-sup-all'));
  s = await T.sups();
  check('none of the old supports is left, and as many new ones stand', [s.length, T.ids(s).some((id) => built1.includes(id))], [N, false]);
  c = await T.card();
  check('...the card reads BUILT again with the same numbers', [c.state, c.line], ['built', 'Built: ' + N + ' supports · 1 of 1 area held · 0 areas not reachable from the plate']);
  await T.clickUndo();
  check('Undo puts the old ones back, the same pieces', T.ids(await T.sups()), built1);
  check('...and the card reads BUILT', (await T.card()).state, 'built');

  // =======================================================================
  console.log('\n--- 6. click a built support; REMOVE takes that one ---');
  // =======================================================================
  const sup = await T.supportXY();
  check('found a support the camera sees', !!sup, true);
  await page.mouse.click(sup.xy[0], sup.xy[1]);
  await frames(page);
  c = await T.card();
  check('a click on a built support picks it (the app\'s own selection); Remove is live',
    [await page.evaluate(() => window.NSO_SUPPORTS_CARD.selected()), c.remove.on, c.state],
    [sup.id, true, 'built']);
  await T.hudIsLine('support picked');
  await T.shot('05-support-picked.png');
  await T.oneStep('Remove', () => page.click('#btn-sup-remove'));
  s = await T.sups();
  c = await T.card();
  check('Remove took exactly that one', T.ids(s), built1.filter((id) => id !== sup.id));
  check('...the line follows: one fewer support, the area no longer fully held',
    c.line, 'Built: ' + (N - 1) + ' supports · 0 of 1 area held · 0 areas not reachable from the plate');
  await T.hudIsLine('after Remove');
  await T.clickUndo();
  check('Undo puts it back', T.ids(await T.sups()), built1);
  check('...the line reads N supports, 1 of 1 area held', (await T.card()).line, 'Built: ' + N + ' supports · 1 of 1 area held · 0 areas not reachable from the plate');

  // =======================================================================
  console.log('\n--- 7. REMOVE ALL ---');
  // =======================================================================
  await T.oneStep('Remove all', () => page.click('#btn-sup-none'));
  c = await T.card();
  check('every support is off the plate and the card is back in IDLE, the area still outlined',
    [(await T.sups()).length, c.state, c.line, c.go, c.removeAll.shown, (await T.outlines()).areas.map((a) => a.kind)],
    [0, 'idle', '1 overhang area', { text: 'Generate', on: true }, false, ['on']]);
  await T.hudIsLine('removed all');
  await T.shot('06-removed-all.png');
  await T.clickUndo();
  check('Undo puts the same pieces back and the card reads BUILT', [T.ids(await T.sups()), (await T.card()).state], [built1, 'built']);

  // =======================================================================
  console.log('\n--- 8. the secondary row: shift-click a spot, Paint Skip ---');
  // =======================================================================
  await T.oneStep('Remove all (clearing the way)', () => page.click('#btn-sup-none'));
  const wall = await page.evaluate(() => {
    const p = state.placed.find((q) => q.mesh && !state.models.find((m) => m.id === q.sourceId).nsoSupport);
    const sp = meshToWorldSoup(p.mesh), B = window.NSO_SUPPORTS_CARD.view().beacons;
    let best = null;
    for (let t = 0; t < sp.length; t += 9) {
      const tri = [0, 1, 2].map((k) => [sp[t + k * 3], -sp[t + k * 3 + 2], sp[t + k * 3 + 1]]);
      const u = tri[1].map((x, i) => x - tri[0][i]), w = tri[2].map((x, i) => x - tri[0][i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
      if (n[1] / L > -0.99) continue;
      const cc = [0, 1, 2].map((i) => (tri[0][i] + tri[1][i] + tri[2][i]) / 3);
      const d = Math.min(...B.map((b) => Math.hypot(b.p[0] - cc[0], b.p[1] - cc[1], b.p[2] - cc[2])));
      if (!best || d > best.d) best = { p: cc, d };
    }
    return best;
  });
  const wallXY = await T.screenOf(wall.p);
  const d8 = await T.undoDepth();
  await page.keyboard.down('Shift');
  await page.mouse.click(wallXY[0], wallXY[1]);
  await page.keyboard.up('Shift');
  await frames(page);
  c = await T.card();
  v = await T.view();
  check('shift-click on the wall adds a manual spot: an area of its own, one Undo step',
    [c.line, v.areas.length, v.beacons.filter((b) => b.manual).length, await T.undoDepth()], ['2 overhang areas', 2, 1, d8 + 1]);
  check('...both areas outlined', (await T.outlines()).areas.map((a) => [a.area, a.kind]), [[0, 'on'], [1, 'on']]);
  await T.hudIsLine('manual spot');
  await T.shot('07-manual-spot.png');
  xy = await T.screenOf(wall.p);
  await T.oneStep('Leaving the new area out', async () => { await page.mouse.click(xy[0], xy[1]); });
  c = await T.card();
  check('a click on its outline leaves just that area out: "1 overhang area · 1 left out"',
    [c.line, (await T.outlines()).areas.map((a) => [a.area, a.kind])], ['1 overhang area · 1 left out', [[0, 'on'], [1, 'off']]]);
  await T.clickUndo();
  check('Undo: both areas again', (await T.card()).line, '2 overhang areas');
  await T.clickUndo();
  check('Undo again takes the manual spot away', [(await T.card()).line, (await T.view()).beacons.length], ['1 overhang area', 120]);

  await page.click('#sup-more > summary');
  check('the Paint row opens', (await T.card()).paintRowOpen, true);
  await page.selectOption('#sel-sup-paint', 'skip');
  await page.click('#btn-sup-paint');
  check('Paint is on, in Skip', await page.evaluate(() => window.NSO_SUPPORTS_CARD.paint()), 'skip');
  v = await T.view();
  const rowsY = [...new Set(v.beacons.map((b) => b.p[1].toFixed(3)))].map(Number).sort((a, b) => a - b);
  const row0 = v.beacons.filter((b) => Math.abs(b.p[1] - rowsY[0]) < 1e-3).sort((a, b) => a.p[0] - b.p[0]);
  const a0 = await T.screenOf(row0[0].p), a1 = await T.screenOf(row0[row0.length - 1].p);
  const d8b = await T.undoDepth();
  await page.mouse.move(a0[0], a0[1]);
  await page.mouse.down();
  await page.mouse.move(a1[0], a1[1], { steps: 12 });
  await page.mouse.up();
  await frames(page);
  v = await T.view();
  check('a Skip stroke along one row takes that row of 12 away: one Undo step', [v.beacons.length, await T.undoDepth()], [108, d8b + 1]);
  check('...the line still counts the one area', (await T.card()).line, '1 overhang area');
  await T.clickUndo();
  check('Undo: 120 spots again', (await T.view()).beacons.length, 120);
  await page.click('#btn-sup-paint');
  check('Paint off', await page.evaluate(() => window.NSO_SUPPORTS_CARD.paint()), null);
  await page.close();

  // =======================================================================
  console.log('\n--- 9. an area the plate cannot reach ---');
  // =======================================================================
  page = await freshPage('with-tunnel.stl', WITH_TUNNEL);
  T = tools(page);
  /* The tunnel's ceiling hangs over the tunnel's own floor. A beacon is
     geometry only (supports-followups): the air under that ceiling runs out of
     both ends, so it is an area like any other, and the planner - not the
     detector - finds that the plate cannot reach most of it. Default settings. */
  const bId = await page.evaluate(() => state.placed[0].sourceId);
  await page.click('#menu-supports > summary');
  await frames(page);
  await page.evaluate((id) => window.NSO_SUPPORTS_CARD.pick(id), bId);
  await frames(page);
  /* Into the tunnel from the front, a little above and to the side. */
  await T.look([80, 20, 15], [0.12, -1, 0.3], 150);
  c = await T.card();
  v = await T.view();
  check('the box and the tunnel block: IDLE, "2 overhang areas", each outlined in white',
    [c.state, c.line, (await T.outlines()).areas.map((a) => [a.area, a.kind])], ['idle', '2 overhang areas', [[0, 'on'], [1, 'on']]]);
  await T.shot('08-two-areas.png');
  await T.oneStep('Generate', () => page.click('#btn-sup-all'));
  c = await T.card();
  v = await T.view();
  const NB = (await T.sups()).length, un = v.stats;
  check('BUILT: "Built: N supports · 1 of 2 areas held · 1 area not reachable from the plate"',
    [c.state, c.line, NB > 0], ['built', 'Built: ' + NB + ' supports · 1 of 2 areas held · 1 area not reachable from the plate', true]);
  check('...the stats behind the line', un && [un.areas, un.held, un.unreachable, un.left], [2, 1, 1, 0]);
  check('...the area the plate could not reach stays outlined in red; the held one is white',
    (await T.outlines()).areas.map((a) => [a.area, a.kind, a.colour]), [[0, 'on', 0xffffff], [1, 'red', 0xff2d2d]]);
  await T.hudIsLine('built, not reachable');
  await T.shot('09-built-not-reachable.png');
  const dX = await T.undoDepth();
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.toggleArea(1));
  await frames(page);
  c = await T.card();
  check('leaving the unreachable area out after the build drops it from the line: "1 of 1 area held · 0 areas not reachable"',
    [c.line, (await T.outlines()).areas.map((a) => [a.area, a.kind]), await T.undoDepth()],
    ['Built: ' + NB + ' supports · 1 of 1 area held · 0 areas not reachable from the plate', [[0, 'on'], [1, 'off']], dX + 1]);
  await T.hudIsLine('left out after the build');
  await T.clickUndo();
  check('Undo puts the red outline back', [(await T.card()).line, (await T.outlines()).areas[1].kind],
    ['Built: ' + NB + ' supports · 1 of 2 areas held · 1 area not reachable from the plate', 'red']);

  // =======================================================================
  console.log('\n--- the build ---');
  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((x) => x.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);
  await browser.close();
  served.srv.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

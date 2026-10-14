#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_card_drive_check.mjs   (npm run support:card)
 *
 * The column's SUPPORTS card (app-supports-card.js), driven in headless
 * Chromium at 1280 x 800 with real clicks on the page, on support:beacons'
 * tilted box (40 x 30 x 10, underside at 30 deg, 120 beacons in one region).
 *
 *   1  OPEN, CLICK. The card opens from the column; clicking the box shows
 *      its beacons - one disc each, one count badge - and the card says
 *      "120 spots need holding in 1 region."
 *   2  ALL builds: supports land as their own pieces, every one labelled for
 *      region 0, every beacon held; the readout is the plain line. Undo takes
 *      them all off (one step); ALL again builds the same.
 *   3  A SUPPORT IS NOT A PIECE TO PICK: reopened with nothing picked, a click
 *      on a support says "That's a support; pick the piece it holds."
 *   4  CLICK + REMOVE drops exactly the support clicked; Undo puts it back.
 *   5  NONE takes every support off; Undo puts every one back.
 *   6  SHIFT-CLICK on the side wall adds a manual beacon there: a side spot,
 *      a region of its own (121 in 2); Undo takes it away. The next ALL
 *      includes it: every one of the 121 is held, rests or is unreachable.
 *   7  REGION TOGGLE: a click on a region's badge takes off exactly that
 *      region's solids - the other region's stay, same ids - and a second
 *      click builds exactly that region's again. Undo after each. The app's
 *      own Remove takes a card support off too (a support is a plate piece).
 *   8  PAINT SKIP over half the face (rows 0-4 of 10, one stroke) halves the
 *      beacon count, 120 -> 60; Undo puts them back.
 *   9  A STANDING TUBE: "Nothing on this piece needs holding."; All disabled.
 *  10  Every step is one Undo; the card stays inside the window; no page
 *      errors. Screenshots in tools/support-card-out/.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'support-card-out');
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
/* A tube standing on its end: r 8 / 5, 20 tall, 48 sides. Nothing hangs. */
function tube(ro, ri, h, n) {
  const o = [];
  const P = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
    const O0b = P(ro, a0, 0), O1b = P(ro, a1, 0), O0t = P(ro, a0, h), O1t = P(ro, a1, h);
    const I0b = P(ri, a0, 0), I1b = P(ri, a1, 0), I0t = P(ri, a0, h), I1t = P(ri, a1, h);
    o.push(...O0b, ...O1b, ...O1t, ...O0b, ...O1t, ...O0t);          // outer wall
    o.push(...I0b, ...I1t, ...I1b, ...I0b, ...I0t, ...I1t);          // inner wall
    o.push(...O0t, ...O1t, ...I1t, ...O0t, ...I1t, ...I0t);          // top ring
    o.push(...O0b, ...I1b, ...O1b, ...O0b, ...I0b, ...I1b);          // bottom ring
  }
  return o;
}
const TUBE = stl(tube(8, 5, 20, 48));

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });

  async function shot(file) {
    await frames(page);
    await page.screenshot({ path: join(SHOTS, file) });
    console.log('       ' + file);
  }
  const view = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.view());
  const idle = () => page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
  const undoDepth = () => page.evaluate(() => state.undoStack.length);
  const sups = () => page.evaluate(() => state.models.filter((m) => m.nsoSupport)
    .map((m) => ({ id: m.id, region: m.nsoSupport.regionId, card: !!m.nsoSupport.card, onPlate: state.placed.some((p) => p.sourceId === m.id) })));
  const ids = (list) => list.map((s) => s.id).sort((a, b) => a - b);
  const overlay = () => page.evaluate(() => {
    const g = state.scene.getObjectByName('supportsCardOverlay');
    if (!g) return { discs: 0, badges: [] };
    return {
      discs: g.children.filter((o) => o.userData.beacon && !o.userData.backing).length,
      backings: g.children.filter((o) => o.userData.backing).length,
      colours: [...new Set(g.children.filter((o) => o.userData.beacon && !o.userData.backing).map((o) => o.material.color.getHex()))],
      badges: g.children.filter((o) => o.isSprite).map((o) => ({ region: o.userData.region, count: o.userData.count, built: o.userData.built })),
    };
  });
  /** Screen point of a Z-up world point. */
  const screenOf = (p) => page.evaluate((q) => {
    const v = new THREE.Vector3(q[0], q[2], -q[1]).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }, p);
  /** Look at a piece from direction `d` (Z-up), `dist` mm away. */
  const aim = (id, d, dist) => page.evaluate(([id, d, dist]) => {
    const p = state.placed.find((q) => q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const L = Math.hypot(d[0], d[1], d[2]);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + d[0] / L * dist, c.y + d[2] / L * dist, c.z - d[1] / L * dist);
    state.camera.updateProjectionMatrix(); state.controls.update(); state.camera.updateMatrixWorld();
  }, [id, d, dist]);
  /** A screen point where the piece is the first thing a click lands on:
      its box centre if nothing is in front, else the nearest such point on
      a grid over its screen box. */
  const pieceAt = (id) => page.evaluate((id) => {
    const p = state.placed.find((q) => q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), r = state.renderer.domElement.getBoundingClientRect();
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).project(state.camera));
    const c = bb.getCenter(new THREE.Vector3()).project(state.camera);
    const lo = [Math.min(...corners.map((q) => q.x)), Math.min(...corners.map((q) => q.y))];
    const hi = [Math.max(...corners.map((q) => q.x)), Math.max(...corners.map((q) => q.y))];
    const rc = new THREE.Raycaster(), meshes = state.placed.map((q) => q.mesh);
    let best = null;
    for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
      const x = lo[0] + (hi[0] - lo[0]) * i / 24, y = lo[1] + (hi[1] - lo[1]) * j / 24;
      rc.setFromCamera(new THREE.Vector2(x, y), state.camera);
      const h = rc.intersectObjects(meshes, false)[0];
      if (!h || h.object !== p.mesh) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (!best || d < best.d) best = { d, x, y };
    }
    return best ? [r.left + (best.x + 1) / 2 * r.width, r.top + (1 - best.y) / 2 * r.height] : null;
  }, id);
  const cardInside = () => page.evaluate(() => {
    const c = document.getElementById('supports-card').getBoundingClientRect();
    return c.width > 0 && c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight;
  });
  async function clickUndo() {
    await page.click('#btn-undo');
    await frames(page);
    await frames(page);
  }
  /** One step: it must add exactly one Undo entry. */
  async function oneStep(label, fn) {
    const d0 = await undoDepth();
    const r = await fn();
    await idle();
    await frames(page);
    check(label + ' is one Undo step', await undoDepth(), d0 + 1);
    return r;
  }

  // =======================================================================
  console.log('\n--- 1. open the card, click the piece ---');
  // =======================================================================
  await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [['tilted.stl', TILTED]]);
  await page.waitForFunction(() => state.models.length === 1 && state.placed.length === 1, null, { timeout: 30000 });
  const boxId = await page.evaluate(() => state.placed[0].sourceId);
  await page.click('#menu-supports > summary');
  await frames(page);
  check('the column\'s Supports opens the card', await page.evaluate(() => document.getElementById('menu-supports').open &&
    window.NSO_SUPPORTS_CARD.isOpen()), true);
  check('...which asks for a piece', (await view()).count, 'Click a piece to see where it needs holding.');
  check('...and sits wholly inside the 1280 x 800 window', await cardInside(), true);
  const DIR = [1, -0.5, 0.12];
  await aim(boxId, DIR, 140);
  let at = await pieceAt(boxId);
  await page.mouse.click(at[0], at[1]);
  await frames(page);
  let v = await view();
  check('a click on the box picks it', v.host, boxId);
  check('the card says how many spots need holding, in how many regions', v.count, '120 spots need holding in 1 region.');
  let ov = await overlay();
  check('every beacon is drawn (one disc each, over its backing), all planned (white)',
    [v.beacons.length, ov.discs, ov.backings, ov.colours], [120, 120, 120, [0xffffff]]);
  check('one count badge, on the one region', ov.badges, [{ region: 0, count: 120, built: false }]);
  await shot('01-picked.png');

  // =======================================================================
  console.log('\n--- 2. ALL builds every region; Undo; ALL again ---');
  // =======================================================================
  const nPieces0 = await page.evaluate(() => state.models.length);
  const t0 = Date.now();
  await oneStep('All', () => page.click('#btn-sup-all'));
  const tAll = Date.now() - t0;
  let s = await sups();
  v = await view();
  console.log('       All took ' + tAll + ' ms, ' + s.length + ' supports');
  check('All built supports, each its own piece on the plate, every one a card support labelled for region 0',
    [s.length > 0, s.every((x) => x.card && x.onPlate && x.region === 0)], [true, true]);
  check('...and they are pieces in the model list', await page.evaluate(() => state.models.length), nPieces0 + s.length);
  check('every beacon is held from the plate (green)', [v.beacons.every((b) => b.state === 'held'), (await overlay()).colours], [true, [0x22c55e]]);
  check('the readout is the plain line', v.read, '120 held from the plate · 0 resting on the part · 0 unreachable');
  check('the badge shows the region built', (await overlay()).badges.map((b) => b.built), [true]);
  const allIds = ids(s);
  await shot('02-all.png');
  await clickUndo();
  v = await view();
  check('Undo after All: no supports, every beacon planned again', [(await sups()).length, v.beacons.every((b) => b.state === 'planned')], [0, true]);
  await oneStep('All again', () => page.click('#btn-sup-all'));
  s = await sups();
  check('All again builds the same number of supports', s.length, allIds.length);

  // =======================================================================
  console.log('\n--- 3. a support is not a piece to pick ---');
  // =======================================================================
  await page.click('#menu-supports > summary');
  await frames(page);
  await page.click('#menu-supports > summary');
  await frames(page);
  check('closed and opened again, nothing is picked', (await view()).host, null);
  const supPick = await page.evaluate(() => {
    /* a support's own surface point the camera sees first */
    const r = state.renderer.domElement.getBoundingClientRect();
    const sups = state.placed.filter((p) => { const m = state.models.find((x) => x.id === p.sourceId); return m && m.nsoSupport; });
    for (const p of sups) {
      const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
      const ndc = c.clone().project(state.camera);
      const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), state.camera);
      const h = rc.intersectObjects(state.placed.map((q) => q.mesh), false)[0];
      if (h && h.object === p.mesh) return { id: p.sourceId, xy: [r.left + (ndc.x + 1) / 2 * r.width, r.top + (1 - ndc.y) / 2 * r.height] };
    }
    return null;
  });
  check('found a support the camera sees', !!supPick, true);
  await page.mouse.click(supPick.xy[0], supPick.xy[1]);
  await frames(page);
  check('a click on it says what it is', (await view()).count, 'That\'s a support; pick the piece it holds.');
  at = await pieceAt(boxId);
  await page.mouse.click(at[0], at[1]);
  await frames(page);
  v = await view();
  check('the box picked again: its supports\' states come back with it', [v.host, v.beacons.every((b) => b.state === 'held')], [boxId, true]);

  // =======================================================================
  console.log('\n--- 4. click a support, REMOVE takes that one ---');
  // =======================================================================
  await page.mouse.click(supPick.xy[0], supPick.xy[1]);
  await frames(page);
  const picked = await page.evaluate(() => window.NSO_SUPPORTS_CARD.selected());
  check('a click on a support selects it (the app\'s own selection)', [picked, await page.evaluate(() => state.placed[state.selectedIndex].sourceId)],
    [supPick.id, supPick.id]);
  check('...and Remove is live', await page.isEnabled('#btn-sup-remove'), true);
  await shot('03-support-selected.png');
  const before4 = ids(await sups());
  await oneStep('Remove', () => page.click('#btn-sup-remove'));
  s = await sups();
  check('Remove dropped exactly the one clicked', ids(s), before4.filter((x) => x !== supPick.id));
  v = await view();
  check('...the spots it held are planned again, the rest still held',
    [v.beacons.filter((b) => b.state === 'planned').length > 0, v.beacons.filter((b) => b.state === 'held').length > 0], [true, true]);
  await clickUndo();
  check('Undo puts that one back', ids(await sups()), before4);
  check('...and every beacon is held again', (await view()).beacons.every((b) => b.state === 'held'), true);

  // =======================================================================
  console.log('\n--- 5. NONE ---');
  // =======================================================================
  await oneStep('None', () => page.click('#btn-sup-none'));
  check('None took every support off the piece', (await sups()).length, 0);
  check('...every beacon planned', (await view()).beacons.every((b) => b.state === 'planned'), true);
  await clickUndo();
  check('Undo puts every one back, same pieces', ids(await sups()), before4);
  await oneStep('None again', () => page.click('#btn-sup-none'));
  check('None again: none left', (await sups()).length, 0);

  // =======================================================================
  console.log('\n--- 6. shift-click adds a beacon; the next ALL includes it ---');
  // =======================================================================
  /* The -y wall's point farthest from every beacon: a spot of its own. */
  const wall = await page.evaluate(() => {
    const p = state.placed.find((q) => q.mesh && !state.models.find((m) => m.id === q.sourceId).nsoSupport);
    const s = meshToWorldSoup(p.mesh), B = window.NSO_SUPPORTS_CARD.view().beacons;
    let best = null;
    for (let t = 0; t < s.length; t += 9) {
      const tri = [0, 1, 2].map((k) => [s[t + k * 3], -s[t + k * 3 + 2], s[t + k * 3 + 1]]);
      const u = tri[1].map((x, i) => x - tri[0][i]), w = tri[2].map((x, i) => x - tri[0][i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
      if (n[1] / L > -0.99) continue;
      const c = [0, 1, 2].map((i) => (tri[0][i] + tri[1][i] + tri[2][i]) / 3);
      const d = Math.min(...B.map((b) => Math.hypot(b.p[0] - c[0], b.p[1] - c[1], b.p[2] - c[2])));
      if (!best || d > best.d) best = { p: c, d };
    }
    return best;
  });
  check('the -y wall has a point more than 1.5 pitches (4.5 mm) from every beacon', wall.d > 4.5, true);
  const wallXY = await screenOf(wall.p);
  const d6 = await undoDepth();
  await page.keyboard.down('Shift');
  await page.mouse.click(wallXY[0], wallXY[1]);
  await page.keyboard.up('Shift');
  await frames(page);
  check('shift-click is one Undo step', await undoDepth(), d6 + 1);
  v = await view();
  const man = v.beacons.filter((b) => b.manual);
  check('shift-click on the wall adds one manual beacon, a side spot, in a region of its own',
    [v.beacons.length, man.length, man[0] && man[0].kind, man[0] && man[0].region, v.regions.length], [121, 1, 'side', 1, 2]);
  check('...where it was clicked (within 0.5 mm), its normal the wall\'s',
    man[0] && [Math.hypot(man[0].p[0] - wall.p[0], man[0].p[1] - wall.p[1], man[0].p[2] - wall.p[2]) < 0.5, man[0].normal[1] < -0.99], [true, true]);
  check('the card counts it', v.count, '121 spots need holding in 2 regions.');
  check('two badges: 120 and 1', (await overlay()).badges.map((b) => [b.region, b.count]), [[0, 120], [1, 1]]);
  await shot('04-shift-click.png');
  await clickUndo();
  v = await view();
  check('Undo takes the manual beacon away', [v.beacons.length, v.regions.length], [120, 1]);
  await page.keyboard.down('Shift');
  await page.mouse.click(wallXY[0], wallXY[1]);
  await page.keyboard.up('Shift');
  await frames(page);
  check('shift-click again: 121', (await view()).beacons.length, 121);
  await oneStep('All with the manual beacon', () => page.click('#btn-sup-all'));
  s = await sups();
  v = await view();
  const manKey = v.beacons.find((b) => b.manual).key;
  check('the next All includes it: every one of the 121 spots is held, resting or unreachable - none left planned',
    [v.beacons.length, v.beacons.filter((b) => b.state === 'planned').length], [121, 0]);
  check('...the manual spot is held by a support labelled for its region (1)', await page.evaluate((k) =>
    state.models.filter((m) => m.nsoSupport && m.nsoSupport.holds && m.nsoSupport.holds[k]).map((m) => m.nsoSupport.regionId), manKey), [1]);
  check('...supports for both regions', [...new Set(s.map((x) => x.region))].sort(), [0, 1]);
  check('readout', v.read, '121 held from the plate · 0 resting on the part · 0 unreachable');
  await shot('05-all-with-manual.png');

  // =======================================================================
  console.log('\n--- 7. region toggle: exactly that region\'s solids ---');
  // =======================================================================
  const r0 = ids(s.filter((x) => x.region === 0)), r1 = ids(s.filter((x) => x.region === 1));
  check('region 1 has its own solid(s), region 0 its own', [r1.length > 0, r0.length > 0], [true, true]);
  const badgeXY = async (rid) => {
    const r = (await view()).regions.find((x) => x.id === rid);
    const pos = await page.evaluate((rid) => {
      const g = state.scene.getObjectByName('supportsCardOverlay');
      const sp = g.children.find((o) => o.isSprite && o.userData.region === rid);
      return [sp.position.x, -sp.position.z, sp.position.y];
    }, rid);
    return r ? screenOf(pos) : null;
  };
  let bxy = await badgeXY(1);
  await oneStep('Region 1 off', () => page.mouse.click(bxy[0], bxy[1]));
  s = await sups();
  check('a click on region 1\'s badge takes off exactly its solids; region 0\'s stay, same pieces',
    [ids(s.filter((x) => x.region === 1)), ids(s.filter((x) => x.region === 0))], [[], r0]);
  check('...its spot planned again, region 0\'s still held', (await view()).beacons.map((b) => b.region === 1 ? b.state === 'planned' : b.state === 'held').every(Boolean), true);
  await clickUndo();
  check('Undo puts region 1\'s back', ids(await sups()), ids(r0.concat(r1).map((id) => ({ id }))));
  bxy = await badgeXY(1);
  await oneStep('Region 1 off again', () => page.mouse.click(bxy[0], bxy[1]));
  bxy = await badgeXY(1);
  await oneStep('Region 1 on', () => page.mouse.click(bxy[0], bxy[1]));
  s = await sups();
  const r1b = ids(s.filter((x) => x.region === 1));
  check('a second click builds exactly region 1\'s solids again; region 0\'s untouched',
    [r1b.length, r1b.every((id) => !r1.includes(id)), ids(s.filter((x) => x.region === 0))], [r1.length, true, r0]);
  await clickUndo();
  s = await sups();
  check('Undo takes exactly those off again', [ids(s.filter((x) => x.region === 1)), ids(s.filter((x) => x.region === 0))], [[], r0]);
  bxy = await badgeXY(0);
  await oneStep('Region 0 off', () => page.mouse.click(bxy[0], bxy[1]));
  check('region 0\'s badge takes off region 0\'s solids only (region 1 has none now)', (await sups()).length, 0);
  await clickUndo();
  check('Undo: region 0\'s back', ids(await sups()), r0);
  await shot('06-region-toggle.png');
  /* The app's own Remove works on a card support too: it is a plate piece.
     (Not undone here: the app's removePlaced Undo restores the plate entry
     without its model - a separate, pre-existing app-core matter.) */
  const supPick2 = await page.evaluate(() => {
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
  await page.mouse.click(supPick2.xy[0], supPick2.xy[1]);
  await frames(page);
  check('a click selects that support', await page.evaluate(() => window.NSO_SUPPORTS_CARD.selected()), supPick2.id);
  await page.click('#btn-delete-placed');
  await frames(page);
  await frames(page);
  check('the app\'s Remove takes the selected support off the plate', (await sups()).filter((x) => x.onPlate).map((x) => x.id).includes(supPick2.id), false);
  check('...and the card counts the spots it held planned again', (await view()).beacons.filter((b) => b.state === 'planned').length > 0, true);

  // =======================================================================
  console.log('\n--- 8. NONE clears the edits too; PAINT Skip over half the face ---');
  // =======================================================================
  const r0b = ids((await sups()).filter((x) => x.onPlate));
  await oneStep('None (with the manual spot)', () => page.click('#btn-sup-none'));
  v = await view();
  check('None takes the supports AND the manual spot away', [(await sups()).length, v.beacons.length, v.regions.length], [0, 120, 1]);
  await clickUndo();
  check('Undo puts back the supports and the manual spot', [ids(await sups()), (await view()).beacons.length], [r0b, 121]);
  await oneStep('None again', () => page.click('#btn-sup-none'));
  v = await view();
  check('None again: 120 detected spots, no supports', [v.beacons.length, (await sups()).length], [120, 0]);

  /* The face's rows, by y: ten of twelve beacons each. Rows 0-4 are half. */
  const rowsY = [...new Set(v.beacons.map((b) => b.p[1].toFixed(3)))].map(Number).sort((a, b) => a - b);
  const rows = rowsY.map((y) => v.beacons.filter((b) => Math.abs(b.p[1] - y) < 1e-3).sort((a, b) => a.p[0] - b.p[0]));
  check('the face holds 10 rows of 12', [rows.length, rows.every((r) => r.length === 12)], [10, true]);
  await page.selectOption('#sel-sup-paint', 'skip');
  await page.click('#btn-sup-paint');
  check('Paint is on, in Skip', await page.evaluate(() => window.NSO_SUPPORTS_CARD.paint()), 'skip');
  /* One stroke, back and forth along rows 0..4. */
  const path = [];
  for (let j = 0; j < 5; j++) {
    const r = j % 2 ? rows[j].slice().reverse() : rows[j];
    path.push(r[0].p, r[r.length - 1].p);
  }
  const pxy = [];
  for (const p of path) pxy.push(await screenOf(p));
  const d8 = await undoDepth();
  await page.mouse.move(pxy[0][0], pxy[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pxy.length; i++) await page.mouse.move(pxy[i][0], pxy[i][1], { steps: 12 });
  await shot('07-painting-skip.png');
  await page.mouse.up();
  await frames(page);
  check('the stroke is one Undo step', await undoDepth(), d8 + 1);
  v = await view();
  const keptY = v.beacons.map((b) => b.p[1]);
  check('Skip over half the face halves the beacon count: 120 -> 60', v.beacons.length, 60);
  check('...exactly rows 5-9 are left', keptY.every((y) => y > rowsY[4] + 1), true);
  check('the card says so', v.count, '60 spots need holding in 1 region.');
  await shot('08-skip-half.png');
  await clickUndo();
  check('Undo puts all 120 back', (await view()).beacons.length, 120);
  await page.click('#btn-sup-paint');
  check('Paint off', await page.evaluate(() => window.NSO_SUPPORTS_CARD.paint()), null);

  // =======================================================================
  console.log('\n--- 9. a standing tube: nothing needs holding ---');
  // =======================================================================
  await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), [['tube.stl', TUBE]]);
  await page.waitForFunction(() => state.models.some((m) => m.name === 'tube') && state.placed.length === 2, null, { timeout: 30000 });
  const tubeId = await page.evaluate(() => state.models.find((m) => m.name === 'tube').id);
  await aim(tubeId, [1, -1, 0.6], 90);
  at = await pieceAt(tubeId);
  /* the box centre of a tube is its hole: click on its wall instead */
  const wallAt = await page.evaluate((id) => {
    const p = state.placed.find((q) => q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const q = new THREE.Vector3(c.x + 6.5 * Math.SQRT1_2, c.y, c.z + 6.5 * Math.SQRT1_2).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  }, tubeId);
  await page.mouse.click(wallAt[0], wallAt[1]);
  await frames(page);
  v = await view();
  check('the tube is picked', v.host, tubeId);
  check('"Nothing on this piece needs holding."', v.count, 'Nothing on this piece needs holding.');
  check('...no beacons drawn, All is off', [(await overlay()).discs, await page.isEnabled('#btn-sup-all')], [0, false]);
  check('the card is still inside the window', await cardInside(), true);
  await shot('09-standing-tube.png');

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

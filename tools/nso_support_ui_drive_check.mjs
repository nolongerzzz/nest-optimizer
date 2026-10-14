#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_ui_drive_check.mjs   (npm run support:ui)
 *
 * The G-scope support card and its markers, driven in headless Chromium at
 * 1280 x 800 - the window the clipped-card report came from. UI only: what
 * the planner plans is gcode:gscope-support's business; this holds the card
 * to what it shows and says.
 *
 *   1  THE CARD STAYS ON SCREEN. A region at the bottom of the view, clicked
 *      for real: the card opens wholly inside the window and the viewport
 *      (flipped above the marker), and stays inside after it grows with a
 *      refusal, and when the window is made short.
 *   2  BEACONS ON PICK. Picking a region draws exactly its region.beacons
 *      (nso_support_beacons.js, through detectOverhangs) - a disc for face /
 *      gap / edge / tip, a tick for ridge - and its centroid ping goes; the
 *      region's tint stays. On support:beacons' tilted box the drawn count
 *      is region.beacons.length.
 *   3  STATES AFTER GENERATE, from the plan's own counts:
 *        a tree on an open shelf      every contact held from the plate
 *        a tree over a stub           every contact unreachable (the trunk
 *                                     from the plate runs into the stub),
 *                                     nothing added
 *        a strut there, "May rest   the spot it stands under resting on the
 *        on the part" ticked         part (the stub's top); the rest planned
 *      and each beacon is drawn in its state's colour. A region too wide for
 *      one tree is refused in plain words, its contacts left planned.
 *   4  "May rest on the part" is a checkbox, off by default on every new card.
 *   5  PLAIN WORDS. Every message the card (and the status line) shows on the
 *      way has no "deg" in it and no number with more than one decimal place;
 *      the readout reads "N contacts held from the plate · M resting on the
 *      part · K unreachable".
 *   6  SCREENSHOTS of each state, in tools/support-ui-out/.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'support-ui-out');
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
/* gscope-support's post with a 12 x 10 shelf at z 16: open plate below it. */
const SHELF = stl([...box([0, 0, 0], [10, 10, 20]), ...box([10, 0, 16], [22, 10, 20])]);
/* The same shelf with a 2 x 2 mm stub, 4 mm tall, standing under its middle.
   Detection still flags the shelf (it tests straight down from each
   triangle's centre, and the stub is under neither), but a tree's trunk
   from the plate runs into the stub - and can stand on the stub's top. */
const STUB = stl([...box([0, 0, 0], [10, 10, 20]), ...box([10, 0, 16], [22, 10, 20]), ...box([15, 4, 0], [17, 6, 4])]);

/* A 30 x 30 mm shelf only 3 mm off the plate: far too wide for one tree to
   fan out from so low. The planner's refusal there is the one the report
   quoted ("past the 31.44 deg limit ... about 144 trunks"). */
const LOW = stl([...box([0, 0, 0], [4, 30, 6]), ...box([4, 0, 3], [34, 30, 6])]);
/* support:beacons' tilted box: 40 x 30 x 10, turned 30 deg about y, its
   underside rising towards +x at 30 deg off the plate, lowest edge on it. */
const TILT = 30 * Math.PI / 180;
const TILTED = stl(box([0, 0, 0], [40, 30, 10]).map((v, i, a) => {
  const k = i % 3, p = a.slice(i - k, i - k + 3);
  return k === 0 ? p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT)
    : k === 1 ? p[1] : p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT);
}));

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Every number with more than one decimal place, and any "deg". */
function wordsProblems(text) {
  const out = [];
  if (/deg/i.test(text)) out.push('"deg"');
  const long = text.match(/\d+\.\d{2,}/g);
  if (long) out.push('decimals ' + long.join(', '));
  return out;
}

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
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SUPPORT, null, { timeout: 30000 });

  /* Every message seen on the way, for section 5. */
  const said = [];
  async function collect(label) {
    const t = await page.evaluate(() => ({
      title: document.getElementById('ms-sp-title').textContent,
      sub: document.getElementById('ms-sp-sub').textContent,
      read: document.getElementById('ms-sp-read').textContent,
      check: document.querySelector('label[for="ms-sp-rest"]').textContent.trim(),
      status: (document.getElementById('status') || {}).textContent || '',
    }));
    said.push({ label, t });
    return t;
  }

  async function shot(file) {
    await frames(page);
    await page.screenshot({ path: join(SHOTS, file) });
    console.log('       ' + file);
  }

  /** The card's box against the window and the viewport. */
  const cardBox = () => page.evaluate(() => {
    const el = document.getElementById('ms-support-pop'), vp = document.getElementById('ms-viewport');
    const c = el.getBoundingClientRect(), v = vp.getBoundingClientRect();
    return { open: !el.hidden && c.width > 0, place: el.dataset.place, card: [c.left, c.top, c.right, c.bottom],
      vp: [v.left, v.top, v.right, v.bottom], win: [innerWidth, innerHeight],
      scrolls: el.scrollHeight > el.clientHeight + 1 };
  });
  const inside = (b) => b.open && b.card[0] >= Math.max(0, b.vp[0]) - 0.5 && b.card[1] >= Math.max(0, b.vp[1]) - 0.5 &&
    b.card[2] <= Math.min(b.win[0], b.vp[2]) + 0.5 && b.card[3] <= Math.min(b.win[1], b.vp[3]) + 0.5;

  /** Look from low down, then slide the view so `p` (view space) sits at
      screen height `fy` (0 top .. 1 bottom) of the viewport. */
  async function aimAt(p, fy, side = 1, low = 0.35) {
    await page.evaluate(([q, fy, sd, lo]) => {
      const v = window.NSO_MICROSCOPE.getView();
      const bb = new THREE.Box3();
      v.overviewGroup.children.forEach((c) => { c.geometry.computeBoundingBox(); bb.union(c.geometry.boundingBox); });
      const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()).length();
      v.controls.target.copy(c);
      v.camera.position.set(c.x + sd * s * 0.5, c.y - s * lo, c.z + s * 0.9);
      v.camera.updateProjectionMatrix(); v.controls.update(); v.camera.updateMatrixWorld();
      const P = new THREE.Vector3(q[0], q[1], q[2]);
      const up = new THREE.Vector3().setFromMatrixColumn(v.camera.matrixWorld, 1);
      for (let i = 0; i < 30; i++) {
        const ny = P.clone().project(v.camera).y;            // +1 top, -1 bottom
        const want = 1 - 2 * fy;
        if (Math.abs(ny - want) < 0.005) break;
        const shift = up.clone().multiplyScalar((ny - want) * s * 0.3);
        v.camera.position.add(shift); v.controls.target.add(shift);
        v.camera.updateMatrixWorld();
      }
      v.controls.update(); v.camera.updateMatrixWorld();
    }, [p, fy, side, low]);
    await frames(page);
  }

  const screenOf = (p) => page.evaluate((q) => {
    const v = window.NSO_MICROSCOPE.getView();
    const r = v.renderer.domElement.getBoundingClientRect();
    const s = new THREE.Vector3(q[0], q[1], q[2]).project(v.camera);
    return [r.left + (s.x + 1) / 2 * r.width, r.top + (1 - s.y) / 2 * r.height];
  }, p);

  const marks = () => page.evaluate(() => window.NSO_GSCOPE_SUPPORT.markers().map((m) => ({
    host: m.host.name, id: m.region.id, ping: [m.ping.position.x, m.ping.position.y, m.ping.position.z],
    pingShown: m.ping.visible, overlayShown: m.overlay.visible && !!m.overlay.parent,
    beacons: m.beacons ? m.beacons.map((b) => ({ kind: b.need && b.need.kind, state: b.state })) : null,
    regionBeacons: (m.region.beacons || []).length,
    meshes: m.beaconMeshes.length,
    drawnAs: m.beaconMeshes.filter((x) => x.material.color.getHex() !== 0x0b0f17)
      .map((x) => [x.userData.beacon.need.kind, x.geometry.type]),
    colours: [...new Set(m.beaconMeshes.filter((x) => x.material.color.getHex() !== 0x0b0f17)
      .map((x) => x.material.color.getHex()))],
  })));

  /** How many screen pixels are drawn in a beacon colour. */
  const colourCount = (hex) => page.evaluate((h) => {
    const v = window.NSO_MICROSCOPE.getView();
    v.renderer.render(v.scene, v.camera);
    const gl = v.renderer.getContext(), w = gl.drawingBufferWidth, hh = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * hh * 4);
    gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const R = (h >> 16) & 255, G = (h >> 8) & 255, B = h & 255;
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (Math.abs(buf[i] - R) < 28 && Math.abs(buf[i + 1] - G) < 28 && Math.abs(buf[i + 2] - B) < 28) n++;
    }
    return n;
  }, hex);

  async function openPlate(files) {
    await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), files);
    await page.waitForFunction((n) => state.models.length === n, files.length, { timeout: 30000 });
    await page.click('#btn-microscope');
    await page.click('#ms-btn-overhangs');
    await page.waitForFunction(() => window.NSO_GSCOPE_SUPPORT.markers().length > 0, null, { timeout: 30000 });
  }

  // =======================================================================
  console.log('\n--- 1. the card stays on screen at 1280 x 800 ---');
  // =======================================================================
  await openPlate([['shelf.stl', SHELF]]);
  let m = (await marks()).find((x) => x.host === 'shelf' && x.id === 0);
  check('the shelf has its overhang marker, ping shown, no beacons yet', [!!m, m && m.pingShown, m && m.beacons], [true, true, null]);
  const m0ping = m.ping;
  await aimAt(m.ping, 0.93);
  let px = await screenOf(m.ping);
  const vpBox = await page.evaluate(() => { const r = document.getElementById('ms-viewport').getBoundingClientRect(); return [r.top, r.bottom]; });
  check('the marker sits at the bottom of the view (within the last tenth)', px[1] > vpBox[0] + (vpBox[1] - vpBox[0]) * 0.9 && px[1] < H, true);
  await page.mouse.click(px[0], px[1]);
  let b = await cardBox();
  check('a real click on it opens the card', b.open, true);
  check('the card is wholly inside the window and the viewport', inside(b), true);
  check('...flipped above the marker, since there is no room below', [b.place, b.card[3] <= px[1]], ['above', true]);
  let t = await collect('picked, bottom of view');
  check('the card names the overhang', t.title, 'Overhang 1 on shelf');
  await shot('01-card-at-bottom.png');

  // =======================================================================
  console.log('\n--- 2. beacons on pick ---');
  // =======================================================================
  check('the checkbox reads "May rest on the part"', t.check, 'May rest on the part');
  check('...and is off on a new card', await page.isChecked('#ms-sp-rest'), false);
  await page.selectOption('#ms-sp-style', 'strut');
  m = (await marks()).find((x) => x.id === 0);
  const wantContacts = m.regionBeacons;
  check('picking draws exactly the region\'s beacons (region.beacons, ' + wantContacts + '), the ping gone, the tint kept',
    [wantContacts > 0, m.beacons && m.beacons.length, m.pingShown, m.overlayShown], [true, wantContacts, false, true]);
  await page.selectOption('#ms-sp-style', 'tree');
  m = (await marks()).find((x) => x.id === 0);
  check('...the same beacons whatever the style: they are where the part needs holding',
    m.beacons && m.beacons.length, wantContacts);
  check('...each drawn as its kind says: a disc for face / gap / edge / tip, a tick for ridge',
    m.drawnAs.filter(([k, g]) => g !== (k === 'ridge' ? 'CylinderGeometry' : 'CircleGeometry')), []);
  check('...each drawn (beacon over its dark backing: two meshes each)', m.meshes, m.beacons.length * 2);
  check('...all in the planned colour', m.colours, [0xffffff]);
  t = await collect('tree beacons planned');
  check('the card says how many spots need holding', t.read, wantContacts + ' spots need holding, shown on the part.');
  b = await cardBox();
  check('the card is still inside after it changed', inside(b), true);
  /* Look up at the underside to see them; the card stays where it was. */
  await aimAt(m0ping, 0.4, 1, 0.9);
  check('...and they are on screen, looking up at the underside', (await colourCount(0xffffff)) > 30, true);
  await shot('02-beacons-on-pick.png');

  // =======================================================================
  console.log('\n--- 3a. Generate: every contact held from the plate ---');
  // =======================================================================
  await page.fill('#ms-sp-size', '1.2');
  const n0 = await page.evaluate(() => state.models.length);
  await page.click('#ms-sp-generate');
  await page.waitForFunction((n) => state.models.length === n, n0 + 1, { timeout: 90000 });
  await page.waitForFunction(() => /held from the plate/.test(document.getElementById('ms-sp-read').textContent), null, { timeout: 30000 });
  m = (await marks()).find((x) => x.id === 0);
  check('after Generate the region shows its beacons in their states, no ping',
    [m.beacons && m.beacons.length, m.pingShown], [wantContacts, false]);
  check('...every one held from the plate (green)', [m.beacons.every((x) => x.state === 'held'), m.colours], [true, [0x22c55e]]);
  t = await collect('tree generated on shelf');
  check('the readout line is the plain one', t.read,
    wantContacts + ' contacts held from the plate · 0 resting on the part · 0 unreachable');
  const plan = await page.evaluate(() => {
    const s = window.NSO_GSCOPE_SUPPORT.supports()[0].nsoSupport;
    return s.beacons.length;
  });
  check('the support carries its beacons with it', plan, wantContacts);
  b = await cardBox();
  check('the card stays open on the new support, still inside the window', [b.open, inside(b)], [true, true]);
  check('no ring is drawn anywhere', await page.evaluate(() =>
    window.NSO_MICROSCOPE.getView().scene.getObjectByName('gscopeSupportMarkers').children
      .filter((c) => c.geometry && c.geometry.type === 'RingGeometry').length), 0);
  await shot('03-held-from-plate.png');
  await page.click('#ms-sp-cancel');
  await page.click('#ms-close');

  // =======================================================================
  console.log('\n--- 3b. a stub under the shelf: unreachable from the plate, then resting on the part ---');
  // =======================================================================
  /* A fresh page for a plate with only the stubbed shelf on it. */
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SUPPORT, null, { timeout: 30000 });
  await openPlate([['stub.stl', STUB]]);
  const cm = await marks();
  check('the stubbed shelf has one overhang: the shelf', cm.map((x) => x.host + ':' + x.id), ['stub:0']);
  await aimAt(cm[0].ping, 0.4, 1, 0.9);
  px = await screenOf(cm[0].ping);
  await page.mouse.click(px[0], px[1]);
  check('the checkbox is off on this new card too', await page.isChecked('#ms-sp-rest'), false);
  await page.selectOption('#ms-sp-style', 'tree');
  await page.fill('#ms-sp-size', '1.2');
  const nC = (await marks())[0].regionBeacons;
  check('the shelf shows its beacons before Generate', [nC > 1, (await marks())[0].beacons.length], [true, nC]);
  const mBefore = await page.evaluate(() => state.models.length);
  await page.click('#ms-sp-generate');
  await page.waitForFunction(() => /Not added/.test(document.getElementById('ms-sp-read').textContent), null, { timeout: 90000 });
  m = (await marks())[0];
  check('nothing was added', await page.evaluate(() => state.models.length), mBefore);
  check('every contact unreachable from the plate (red)', [m.beacons.length, m.beacons.every((x) => x.state === 'unreachable'), m.colours],
    [nC, true, [0xff2d2d]]);
  t = await collect('stub refused');
  check('the readout counts them, and says what to do in plain words',
    t.read.startsWith('0 contacts held from the plate · 0 resting on the part · ' + nC + ' unreachable. Not added: ') &&
    /May rest on the part/.test(t.read), true);
  b = await cardBox();
  check('the card grew with the message and is still wholly inside the window', inside(b), true);
  await shot('04-unreachable.png');

  await page.check('#ms-sp-rest');
  m = (await marks())[0];
  check('ticking the box drops the refused states back to planned', m.beacons.every((x) => x.state === 'planned'), true);
  /* A strut: it stands on the stub's top. (A tree from the stub has its
     branches refused by the planner - they clip the stub - which is the
     planner's business, not the card's.) */
  await page.selectOption('#ms-sp-style', 'strut');
  check('the box stays ticked when the style changes', await page.isChecked('#ms-sp-rest'), true);
  await page.click('#ms-sp-generate');
  await page.waitForFunction((n) => state.models.length === n, mBefore + 1, { timeout: 90000 });
  await page.waitForFunction(() => /resting on the part/.test(document.getElementById('ms-sp-read').textContent) &&
    !/Generating/.test(document.getElementById('ms-sp-read').textContent), null, { timeout: 30000 });
  m = (await marks())[0];
  const nR = m.beacons.filter((x) => x.state === 'rest').length;
  check('with "May rest on the part": the spot the strut stands under rests on the part (amber); a strut holds one spot, the rest stay planned',
    [nR >= 1, m.beacons.every((x) => x.state === 'rest' || x.state === 'planned'), m.colours.includes(0xf59e0b)], [true, true, true]);
  t = await collect('stub resting on part');
  check('readout', t.read, '0 contacts held from the plate · ' + nR + ' resting on the part · 0 unreachable');
  check('the support remembers it may rest on the part', await page.evaluate(() =>
    window.NSO_GSCOPE_SUPPORT.supports()[0].nsoSupport.rest), true);
  b = await cardBox();
  check('the card is inside the window', inside(b), true);
  await shot('05-resting-on-part.png');

  // =======================================================================
  console.log('\n--- 1b. a short window: the card still fits ---');
  // =======================================================================
  await page.setViewportSize({ width: W, height: 420 });
  await frames(page);
  b = await cardBox();
  check('at 1280 x 420 the open card is re-placed wholly inside the window', inside(b), true);
  await shot('06-short-window.png');
  await page.setViewportSize({ width: W, height: H });
  await frames(page);
  b = await cardBox();
  check('and back at 1280 x 800, inside again', inside(b), true);

  // =======================================================================
  console.log('\n--- 3c. too wide for one tree: refused in plain words ---');
  // =======================================================================
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SUPPORT, null, { timeout: 30000 });
  await openPlate([['low.stl', LOW]]);
  const lm = (await marks())[0];
  await aimAt(lm.ping, 0.4, 1, 0.9);
  px = await screenOf(lm.ping);
  await page.mouse.click(px[0], px[1]);
  await page.selectOption('#ms-sp-style', 'tree');
  const raw = await page.evaluate(async () => (await window.NSO_GSCOPE_SUPPORT.planFor('low', 0, 'tree', 1.2)).reason);
  check('the planner\'s own refusal here is the one from the report (deg limit, trunks)',
    /deg limit/.test(raw) && /about \d+ trunks/.test(raw), true);
  await page.click('#ms-sp-generate');
  await page.waitForFunction(() => /Not added/.test(document.getElementById('ms-sp-read').textContent), null, { timeout: 90000 });
  t = await collect('too wide');
  check('the card says it in plain words instead: no "deg", no "trunks", no "about N"',
    [/deg/i.test(t.read), /trunk/i.test(t.read), /about \d/.test(t.read), /too wide for one support/.test(t.read)],
    [false, false, false, true]);
  m = (await marks())[0];
  check('nothing was learnt about reaching the contacts, so they stay planned',
    m.beacons.length > 0 && m.beacons.every((x) => x.state === 'planned'), true);
  check('the card is inside the window', inside(await cardBox()), true);
  await shot('07-too-wide.png');

  // =======================================================================
  console.log('\n--- 2b. the tilted box: every beacon detection reports is drawn ---');
  // =======================================================================
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SUPPORT, null, { timeout: 30000 });
  await openPlate([['tilted.stl', TILTED]]);
  const tm = (await marks())[0];
  await aimAt(tm.ping, 0.4, 1, 0.9);
  px = await screenOf(tm.ping);
  await page.mouse.click(px[0], px[1]);
  m = (await marks())[0];
  check('the tilted box: drawn beacon count equals region.beacons.length (' + m.regionBeacons + ')',
    [m.regionBeacons > 0, m.meshes / 2], [true, m.regionBeacons]);
  await shot('08-tilted-box.png');

  // =======================================================================
  console.log('\n--- 5. plain words ---');
  // =======================================================================
  const bad = [];
  said.forEach((s) => Object.entries(s.t).forEach(([k, v]) => {
    const p = wordsProblems(v);
    if (p.length) bad.push(s.label + ' / ' + k + ': ' + p.join('; ') + ' in "' + v + '"');
  }));
  check('no message on the way says "deg" or shows more than one decimal place (' + said.length + ' snapshots)', bad, []);
  said.forEach((s) => console.log('       [' + s.label + '] ' + s.t.read + (s.t.status ? '  |  status: ' + s.t.status : '')));

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

#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-support-drive-check.mjs
 *
 * G-scope supports, driven through the real app in headless Chromium:
 *
 *   1  MARKERS ARE THE DETECTION. One marker per region auto-aim's own
 *      detectOverhangs returns - called here directly, on the same soup with
 *      the same options - at the region's own aim point, over the region's own
 *      triangles. A piece with no overhang gets none.
 *   2  POINT-CLICK GENERATION IS THE GENERATOR. A real click on a marker, the
 *      popover, Generate: the piece that lands is the generator's output
 *      value for value - NSO_SupportAim.plan for a strut,
 *      NSO_SupportTree.planTree + unionParts for a tree - called directly with
 *      the same inputs, and it stands in the scene exactly where it was built.
 *   3  EDIT / REMOVE ONE SUPPORT. A real click on a support selects it through
 *      G-scope's selection seam; Apply regenerates it (gecko-hand here, again
 *      matched against the direct call), Remove takes it off; each is one
 *      Undo, and Undo puts back the same model, the same triangles, the same
 *      pose.
 *   4  THE EXPORT agrees with the scene: a support sits against its piece in
 *      the combined export exactly as it does on screen.
 *   5  SCREENSHOTS of the markers, the popover, the supports and the edit.
 *   6  GREEN MEANS IT STILL STANDS THERE. A marker is green only while a
 *      support labelled for its region still touches the region where it is
 *      NOW: the host moved, mirrored or turned (or the support moved alone)
 *      turns it red and names the stale support; Undo brings it back green,
 *      with the host at exactly its old position and resting height.
 *
 * Usage: node tools/gcode-test/gscope-support-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'gscope-support-out');

/* A post with a 12 x 10 mm shelf at z 16 (nso_support_tree_test.js's SHELF)
   and a 2 x 2 mm tab at z 12 on the other side (its TINY): two overhangs, a
   fan and a single contact. */
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
const SHELF = stl([...box([0, 0, 0], [10, 10, 20]), ...box([10, 0, 16], [22, 10, 20]), ...box([-2, 4, 12], [0, 6, 16])]);
const PLAIN = stl(box([0, 0, 0], [8, 8, 8]));          // no overhang at all

/* The canonical checker, held to the standard nso_support_tree_canonical_check.js
   holds a unioned tree to: a boolean's output carries distinct vertices closer
   than mesh_validate.py's 1e-4 mm default weld, so it is validated at a weld
   derived from its own closest distinct pair (a third of it, never looser than
   the default), and at the default weld it must still be closed and
   non-degenerate. closestPair is that file's, verbatim. */
function closestPair(soup) {
  const seen = new Map(), V = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
    if (seen.has(k)) continue;
    seen.set(k, 1);
    V.push([soup[i], soup[i + 1], soup[i + 2]]);
  }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of V) for (let k = 0; k < 3; k++) {
    if (p[k] < mn[k]) mn[k] = p[k];
    if (p[k] > mx[k]) mx[k] = p[k];
  }
  const side = Math.max(1, Math.round(Math.cbrt(V.length)));
  const cell = Math.max(1e-9, Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / side);
  const grid = new Map();
  const key = (a, b, c) => a + '|' + b + '|' + c;
  const idx = p => [Math.floor((p[0] - mn[0]) / cell), Math.floor((p[1] - mn[1]) / cell),
                    Math.floor((p[2] - mn[2]) / cell)];
  for (let i = 0; i < V.length; i++) {
    const c = idx(V[i]), k = key(c[0], c[1], c[2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  let best = Infinity;
  for (let i = 0; i < V.length; i++) {
    const c = idx(V[i]);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = grid.get(key(c[0] + a, c[1] + b, c[2] + d));
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const dd = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
        if (dd < best) best = dd;
      }
    }
  }
  return best;
}
async function canonical(soup, name) {
  const file = join(SHOTS, name + '.stl');
  await writeFile(file, Buffer.from(stl(soup)));
  const run = (weld) => JSON.parse(execFileSync('python3',
    [join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(weld ? ['--weld', String(weld)] : []),
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const weld = Math.min(1e-4, closestPair(soup) / 3);
  return { weld, at: run(weld), dflt: run() };
}
function canonicalChecks(label, c) {
  const v = c.at;
  check(`${label}: the canonical checker passes it (weld ${c.weld.toExponential(2)} mm, derived as the tree check derives it)`,
    [v.verdict, v.open_edges, v.nonmanifold_edges, v.inconsistent_winding_edges, v.degenerate_tris,
      v.self_intersection.pierce, v.euler_characteristic], ['PASS', 0, 0, 0, 0, 0, 2]);
  check(`${label}: and at the default weld it is still closed and non-degenerate`,
    [c.dflt.open_edges, c.dflt.degenerate_tris], [0, 0]);
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function shot(page, file, label) {
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
    let lit = 0, red = 0, green = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      seen.add((r << 16) | (g << 8) | b);
      if (r > 0x20 || g > 0x20 || b > 0x20) lit++;
      if (r > 180 && g < 90 && b < 90) red++;
      if (g > 150 && r < 90 && b < 140) green++;
    }
    return { distinct: seen.size, lit, red, green, w, h };
  });
  const size = (await stat(path)).size;
  check(`${label}: screenshot is a drawn view`, px.distinct > 6 && px.lit > 20 && size > 5000, true);
  console.log(`       ${file}  ${px.w}x${px.h}, ${px.distinct} colours, ${px.red} red / ${px.green} green samples`);
  return px;
}

/** Look at the pieces from low and to one side, so the undersides show. */
async function lookUnder(page, side = 1) {
  await page.evaluate((sd) => {
    const v = window.NSO_MICROSCOPE.getView();
    const box = new THREE.Box3();
    v.overviewGroup.children.forEach((c) => { c.geometry.computeBoundingBox(); box.union(c.geometry.boundingBox); });
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
    v.controls.target.copy(c);
    v.camera.position.set(c.x + sd * s * 0.55, c.y - s * 0.12, c.z + s * 0.95);
    v.camera.updateProjectionMatrix(); v.controls.update(); v.camera.updateMatrixWorld();
  }, side);
}

/** Screen pixel of a view-space point. */
const screenOf = (page, p) => page.evaluate((q) => {
  const v = window.NSO_MICROSCOPE.getView();
  const r = v.renderer.domElement.getBoundingClientRect();
  const s = new THREE.Vector3(q[0], q[1], q[2]).project(v.camera);
  return [r.left + (s.x + 1) / 2 * r.width, r.top + (1 - s.y) / 2 * r.height];
}, p);

/** A point on a piece that the camera really sees: a triangle centroid whose
    ray from the camera hits that piece first. */
const visiblePointOf = (page, sourceId) => page.evaluate((sid) => {
  const M = window.NSO_MICROSCOPE, v = M.getView();
  const o = M.getDoc().objects.find((x) => x.sourceId === sid);
  const mesh = v.overviewMeshes[o.name];
  const all = Object.values(v.overviewMeshes).filter((m) => m.visible);
  const a = mesh.geometry.attributes.position, rc = new THREE.Raycaster();
  let best = null;
  for (let t = 0; t < a.count / 3; t++) {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(a.getX(t * 3 + k), a.getY(t * 3 + k), a.getZ(t * 3 + k)));
    c.multiplyScalar(1 / 3);
    const dir = c.clone().sub(v.camera.position).normalize();
    rc.set(v.camera.position, dir);
    const hits = rc.intersectObjects(all, false);
    if (!hits.length || hits[0].object !== mesh) continue;
    const s = hits[0].point.clone().project(v.camera);
    if (Math.abs(s.x) > 0.85 || Math.abs(s.y) > 0.85) continue;
    // Prefer the point furthest from any other piece's silhouette: the
    // biggest-area visible triangle is a fine proxy and deterministic.
    const e1 = new THREE.Vector3(a.getX(t * 3 + 1) - a.getX(t * 3), a.getY(t * 3 + 1) - a.getY(t * 3), a.getZ(t * 3 + 1) - a.getZ(t * 3));
    const e2 = new THREE.Vector3(a.getX(t * 3 + 2) - a.getX(t * 3), a.getY(t * 3 + 2) - a.getY(t * 3), a.getZ(t * 3 + 2) - a.getZ(t * 3));
    const area = e1.cross(e2).length();
    if (!best || area > best.area) best = { area, p: [hits[0].point.x, hits[0].point.y, hits[0].point.z] };
  }
  return best ? best.p : null;
}, sourceId);

/** Every number a model carries that Undo must give back. */
const modelState = (page, id) => page.evaluate((mid) => {
  const m = state.models.find((x) => x.id === mid);
  const p = state.placed.find((x) => x && x.sourceId === mid);
  if (!m || !p) return null;
  p.mesh.updateMatrixWorld(true);
  return { name: m.name, raw: Array.from(m.rawTris), meta: m.nsoSupport,
    pos: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z], lift: p.liftY || 0,
    world: Array.from(meshToWorldSoup(p.mesh)) };
}, id);

function sameArray(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SUPPORT, null, { timeout: 30000 });

  await page.evaluate(([a, b]) => handleFiles([new File([new Uint8Array(a)], 'shelf.stl'),
    new File([new Uint8Array(b)], 'plain.stl')]), [SHELF, PLAIN]);
  await page.waitForFunction(() => state.models.length === 2, null, { timeout: 30000 });
  await page.click('#btn-microscope');

  // =======================================================================
  console.log('\n--- 1. markers are auto-aim\'s own detection ---');
  // =======================================================================
  check('the Supports section is there on a plate document', await page.isVisible('#ms-support-row'), true);
  check('markers start off', await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.isOn()), false);
  await page.click('#ms-btn-overhangs');
  const det = await page.evaluate(() => {
    const S = window.NSO_GSCOPE_SUPPORT, M = window.NSO_MICROSCOPE, d = M.getDoc();
    const out = { hosts: {} };
    d.objects.forEach((o) => {
      const opts = S.optsFor(o.name).opts;
      const direct = window.NSO_SupportAim.detectOverhangs(o.positions, opts);
      out.hosts[o.name] = direct.regions.map((r) => ({ id: r.id, area: r.areaMm2, point: r.point,
        tris: r.tris.slice(), normal: r.normal }));
    });
    out.markers = S.markers().map((m) => {
      const want = M.toView(m.region.point[0], m.region.point[1], m.region.point[2]);
      const og = m.overlay.geometry.attributes.position;
      return { host: m.host.name, id: m.region.id, area: m.region.areaMm2, point: m.region.point,
        tris: m.region.tris.slice(), overlayTris: og.count / 3,
        pingAt: [m.ping.position.x, m.ping.position.y, m.ping.position.z], want: [want.x, want.y, want.z],
        colour: m.ping.material.color.getHex() };
    });
    out.read = document.getElementById('ms-support-read').textContent;
    return out;
  });
  const directCount = Object.values(det.hosts).reduce((a, r) => a + r.length, 0);
  check('one marker per detected region, no more and no fewer', det.markers.length, directCount);
  check('the shelf has two (the 120 mm^2 shelf, the 4 mm^2 tab); the plain block none',
    [det.hosts.shelf.map((r) => +r.area.toFixed(3)), det.hosts.plain.length], [[120, 4], 0]);
  check('each marker IS its region: same id, same area, same aim point, same triangles',
    det.markers.every((m) => {
      const r = det.hosts[m.host].find((x) => x.id === m.id);
      return r && r.area === m.area && sameArray(r.point, m.point) && sameArray(r.tris, m.tris);
    }), true);
  check('each ping sits exactly on its region\'s aim point',
    det.markers.every((m) => m.pingAt.every((v, i) => Math.abs(v - m.want[i]) < 1e-9)), true);
  check('each overlay draws exactly the region\'s own triangles',
    det.markers.every((m) => m.overlayTris === m.tris.length), true);
  check('unsupported regions are red', det.markers.every((m) => m.colour === 0xff2d2d), true);
  check('and the panel counts them', /^2 overhang\(s\) found at 45° - 2 unsupported/.test(det.read), true);
  await lookUnder(page);
  const s1 = await shot(page, '01-overhang-markers.png', 'red markers on the two overhangs');
  check('red markers are actually on screen', s1.red > 20, true);

  // =======================================================================
  console.log('\n--- 2. point-click generation: a strut on the tab ---');
  // =======================================================================
  const tab = det.markers.find((m) => m.id === 1);
  // What the generator makes with these exact inputs, called directly first.
  const wantStrut = await page.evaluate(() => {
    const S = window.NSO_GSCOPE_SUPPORT, d = window.NSO_MICROSCOPE.getDoc();
    const host = d.objects.find((o) => o.name === 'shelf');
    const o = Object.assign({}, S.optsFor('shelf').opts, { regionId: 1, sideMm: 1.2 });
    const p = window.NSO_SupportAim.plan(host.positions, o);
    return { ok: p.ok, soup: Array.from(p.soup) };
  });
  check('the direct call plans a strut', wantStrut.ok, true);
  let px = await screenOf(page, tab.pingAt);
  await page.mouse.click(px[0], px[1]);
  const popNew = await page.evaluate(() => ({
    open: !document.getElementById('ms-support-pop').hidden,
    title: document.getElementById('ms-sp-title').textContent,
    gen: getComputedStyle(document.getElementById('ms-sp-generate')).display !== 'none',
    remove: getComputedStyle(document.getElementById('ms-sp-remove')).display !== 'none',
  }));
  check('a real click on the tab\'s marker opens the popover for that overhang',
    [popNew.open, popNew.title, popNew.gen, popNew.remove], [true, 'Overhang 2 on shelf', true, false]);
  await page.selectOption('#ms-sp-style', 'strut');
  await page.fill('#ms-sp-size', '1.2');
  await shot(page, '02-marker-popover.png', 'the popover on a marker');
  const before = await page.evaluate(() => ({ models: state.models.length, undo: state.undoStack.length }));
  await page.click('#ms-sp-generate');
  await page.waitForFunction((n) => state.models.length === n, before.models + 1, { timeout: 30000 });
  const strutId = await page.evaluate(() => state.models[state.models.length - 1].id);
  const strut = await modelState(page, strutId);
  check('the strut the click made is the generator\'s, value for value', sameArray(strut.raw, wantStrut.soup), true);
  let placedErr = 0;
  for (let i = 0; i < strut.world.length; i += 3) {
    // meshToWorldSoup is the view's Y-up; the soup is Z-up: (x, y, z) <- (X, -Z, Y)
    placedErr = Math.max(placedErr, Math.abs(strut.world[i] - wantStrut.soup[i]),
      Math.abs(-strut.world[i + 2] - wantStrut.soup[i + 1]), Math.abs(strut.world[i + 1] - wantStrut.soup[i + 2]));
  }
  check('and it stands in the scene exactly where it was built', placedErr < 1e-4, true);
  console.log(`       strut: ${strut.raw.length / 9} triangles, placed within ${placedErr.toExponential(2)} mm`);
  check('one undo step, of the ordinary add kind',
    await page.evaluate((n) => [state.undoStack.length - n, state.undoStack[state.undoStack.length - 1].type], before.undo),
    [1, 'addModels']);
  check('it carries what it is: host, region, style, size',
    [strut.meta.hostName, strut.meta.regionId, strut.meta.style, strut.meta.sideMm], ['shelf', 1, 'strut', 1.2]);
  check('the popover closed and the tab\'s marker is green now',
    await page.evaluate(() => [document.getElementById('ms-support-pop').hidden,
      window.NSO_GSCOPE_SUPPORT.markers().find((m) => m.region.id === 1).ping.material.color.getHex()]),
    [true, 0x22c55e]);

  // =======================================================================
  console.log('\n--- 2b. a tree on the shelf ---');
  // =======================================================================
  const wantTree = await page.evaluate(async () => {
    const S = window.NSO_GSCOPE_SUPPORT, d = window.NSO_MICROSCOPE.getDoc();
    const host = d.objects.find((o) => o.name === 'shelf');
    const o = Object.assign({}, S.optsFor('shelf').opts, { regionId: 0, sideMm: 1.2, branchStyle: 'square' });
    const t = window.NSO_SupportTree.planTree(host.positions, o);
    const u = await window.NSO_SupportTree.unionParts(t.parts);
    return { ok: t.ok && u.ok, branches: t.branches.length, soup: Array.from(u.soup) };
  });
  check('the direct call plans and unions a tree', wantTree.ok, true);
  await lookUnder(page);
  const shelfPing = await page.evaluate(() => {
    const m = window.NSO_GSCOPE_SUPPORT.markers().find((x) => x.region.id === 0);
    return [m.ping.position.x, m.ping.position.y, m.ping.position.z];
  });
  px = await screenOf(page, shelfPing);
  await page.mouse.click(px[0], px[1]);
  await page.selectOption('#ms-sp-style', 'tree');
  await page.fill('#ms-sp-size', '1.2');
  const nBefore = await page.evaluate(() => state.models.length);
  await page.click('#ms-sp-generate');
  await page.waitForFunction((n) => state.models.length === n, nBefore + 1, { timeout: 60000 });
  const treeId = await page.evaluate(() => state.models[state.models.length - 1].id);
  const tree = await modelState(page, treeId);
  check('the tree the click made is the generator\'s union, value for value', sameArray(tree.raw, wantTree.soup), true);
  canonicalChecks('the strut', await canonical(strut.raw, 'strut'));
  canonicalChecks('the tree', await canonical(tree.raw, 'tree'));
  console.log(`       tree: ${wantTree.branches} branches, ${tree.raw.length / 9} triangles`);
  const camKept = await page.evaluate(() => window.NSO_MICROSCOPE.getView().camera.position.y);
  check('the view the user was working in is kept across the re-read (camera still below the part)',
    camKept < 10, true);
  const s3 = await shot(page, '03-strut-and-tree.png', 'a strut and a tree, both markers green');
  check('both markers green now', await page.evaluate(() =>
    window.NSO_GSCOPE_SUPPORT.markers().every((m) => m.supported)), true);
  check('green is on screen', s3.green > 20, true);

  // =======================================================================
  console.log('\n--- 4. the export agrees with the scene ---');
  // =======================================================================
  const exp = await page.evaluate((ids) => {
    // Each piece's exported triangles, by building the export one piece at a time.
    const keep = state.placed.slice();
    const bounds = {};
    for (const p of keep) {
      state.placed = [p];
      const a = buildCombinedGeometry().attributes.position.array;
      let lo = [Infinity, Infinity, Infinity];
      for (let i = 0; i < a.length; i++) lo[i % 3] = Math.min(lo[i % 3], a[i]);
      bounds[p.sourceId] = lo;
    }
    state.placed = keep;
    const d = window.NSO_MICROSCOPE.getDoc();
    const world = {};
    d.objects.forEach((o) => { world[o.sourceId] = [o.bounds.minX, o.bounds.minY, o.bounds.minZ]; });
    const host = state.models.find((m) => m.name === 'shelf').id;
    return ids.map((id) => ({
      exportDelta: [0, 1, 2].map((k) => bounds[id][k] - bounds[host][k]),
      sceneDelta: [0, 1, 2].map((k) => world[id][k] - world[host][k]),
    }));
  }, [strutId, treeId]);
  check('each support sits against its piece in the export exactly as on screen',
    exp.every((e) => e.exportDelta.every((v, k) => Math.abs(v - e.sceneDelta[k]) < 1e-3)), true);

  // =======================================================================
  console.log('\n--- 3. select one support, change it, undo ---');
  // =======================================================================
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(false));      // pings out of the way
  const treeSpot = await visiblePointOf(page, treeId);
  check('the tree is in view to click on', !!treeSpot, true);
  px = await screenOf(page, treeSpot);
  await page.mouse.click(px[0], px[1]);
  const sel = await page.evaluate(() => ({
    by: window.NSO_MICROSCOPE.selectionSource(),
    names: window.NSO_MICROSCOPE.selection().map((o) => o.name),
    open: !document.getElementById('ms-support-pop').hidden,
    apply: getComputedStyle(document.getElementById('ms-sp-apply')).display !== 'none',
    style: document.getElementById('ms-sp-style').value,
  }));
  check('a real click on the tree selects it, through G-scope\'s selection seam',
    [sel.by, sel.names, sel.open, sel.apply, sel.style], ['support', [tree.name], true, true, 'tree']);
  await shot(page, '04-support-selected.png', 'one support selected for editing');

  const wantGecko = await page.evaluate(async () => {
    const S = window.NSO_GSCOPE_SUPPORT, d = window.NSO_MICROSCOPE.getDoc();
    const host = d.objects.find((o) => o.name === 'shelf');
    const o = Object.assign({}, S.optsFor('shelf').opts, { regionId: 0, sideMm: 1.2, branchStyle: 'gecko-hand' });
    const t = window.NSO_SupportTree.planTree(host.positions, o);
    const u = await window.NSO_SupportTree.unionParts(t.parts);
    return { ok: t.ok && u.ok, fingers: t.fingers, soup: Array.from(u.soup) };
  });
  check('the direct call plans a gecko-hand tree', wantGecko.ok, true);
  await page.selectOption('#ms-sp-style', 'gecko-hand');
  const undoBefore = await page.evaluate(() => state.undoStack.length);
  await page.click('#ms-sp-apply');
  await page.waitForFunction((id) => !state.models.some((m) => m.id === id), treeId, { timeout: 60000 });
  const geckoId = await page.evaluate(() => state.models[state.models.length - 1].id);
  const gecko = await modelState(page, geckoId);
  check('Apply replaced the tree with the generator\'s gecko-hand, value for value',
    [gecko.meta.style, sameArray(gecko.raw, wantGecko.soup)], ['gecko-hand', true]);
  check('as ONE undo step', await page.evaluate((n) =>
    [state.undoStack.length - n, state.undoStack[state.undoStack.length - 1].type], undoBefore), [1, 'supportSwap']);
  console.log(`       gecko-hand: ${wantGecko.fingers} fingers, ${gecko.raw.length / 9} triangles`);
  canonicalChecks('the gecko-hand', await canonical(gecko.raw, 'gecko-hand'));
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
  await shot(page, '05-changed-to-gecko-hand.png', 'the tree changed to a gecko-hand');
  check('the gecko-hand stands where the tree stood: both markers still green, each held by a support that touches it',
    await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.markers().map((m) =>
      [m.supported, window.NSO_GSCOPE_SUPPORT.standing('shelf', m.region.id).standing.length])), [[true, 1], [true, 1]]);

  await page.click('#ms-close');
  await page.click('#btn-undo');
  const treeBack = await modelState(page, treeId);
  check('Undo: the gecko-hand is gone', await page.evaluate((id) => state.models.some((m) => m.id === id), geckoId), false);
  check('and the tree is back - same model, same triangles, same pose',
    [sameArray(treeBack.raw, tree.raw), sameArray(treeBack.pos, tree.pos), treeBack.lift, sameArray(treeBack.world, tree.world)],
    [true, true, tree.lift, true]);

  // =======================================================================
  console.log('\n--- 3b. remove one support, undo ---');
  // =======================================================================
  await page.click('#btn-microscope');
  await lookUnder(page, -1);             // the tab is on the post's far side
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(false));
  const strutFoot = await visiblePointOf(page, strutId);
  check('the strut is in view to click on', !!strutFoot, true);
  px = await screenOf(page, strutFoot);
  await page.mouse.click(px[0], px[1]);
  check('a real click on the strut selects the strut',
    await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((o) => o.name)), [strut.name]);
  const beforeRemove = await page.evaluate(() => ({ names: state.models.map((m) => m.name), undo: state.undoStack.length }));
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
  await page.click('#ms-sp-remove');
  const afterRemove = await page.evaluate(() => ({ names: state.models.map((m) => m.name), undo: state.undoStack.length,
    placed: state.placed.length, top: state.undoStack[state.undoStack.length - 1].type,
    marker: window.NSO_GSCOPE_SUPPORT.markers().find((m) => m.region.id === 1).supported }));
  check('Remove takes that one support off, and nothing else',
    afterRemove.names, beforeRemove.names.filter((n) => n !== strut.name));
  check('as one undo step', [afterRemove.undo - beforeRemove.undo, afterRemove.top], [1, 'supportSwap']);
  check('and the tab\'s marker is red again', afterRemove.marker, false);
  await shot(page, '06-strut-removed.png', 'the strut removed, its marker red again');
  await page.click('#ms-close');
  await page.click('#btn-undo');
  const strutBack = await modelState(page, strutId);
  check('Undo restores the strut - same model, triangles, pose, and place in the list',
    [sameArray(strutBack.raw, strut.raw), sameArray(strutBack.world, strut.world),
      await page.evaluate(() => state.models.map((m) => m.name))],
    [true, true, beforeRemove.names]);

  // Undo of a generation, too.
  const nNow = await page.evaluate(() => state.models.length);
  check('the step on top is now the tree\'s own generation',
    await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type), 'addModels');
  await page.click('#btn-undo');
  check('Undo of a generation takes that support away',
    [await page.evaluate(() => state.models.length), await page.evaluate((id) => state.models.some((m) => m.id === id), treeId)],
    [nNow - 1, false]);

  // =======================================================================
  console.log('\n--- 6. green means it still stands there: host moved, mirrored, turned ---');
  // =======================================================================
  /* A marker is green only when a support labelled for the region ALSO
     touches the region where it is now. Every host op below leaves both
     supports where they were, so both regions must go red, name the stale
     support, and come back green - with the host exactly where it was - on
     Undo. */
  await page.click('#btn-microscope');
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
  const tree6 = await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.generateAt('shelf', 0, 'tree', 1.2));
  check('a tree on the shelf again, for the host ops', tree6.ok, true);
  const readMarks = () => page.evaluate(() => window.NSO_GSCOPE_SUPPORT.markers().map((m) => ({
    id: m.region.id, supported: m.supported, stale: m.stale,
    colour: m.ping.material.color.getHex(),
    standing: window.NSO_GSCOPE_SUPPORT.standing('shelf', m.region.id).standing.map((x) => x.name) })));
  const hostWorld = () => page.evaluate(() => {
    const p = state.placed.find((q) => q.name === 'shelf' || (state.models.find((m) => m.id === q.sourceId) || {}).name === 'shelf');
    p.mesh.updateMatrixWorld(true);
    return { world: Array.from(meshToWorldSoup(p.mesh)), y: p.mesh.position.y };
  });
  const supNames = await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.supports().map((m) => m.name));
  const fresh = await readMarks();
  check('freshly generated: both regions green, each held by the support that touches it',
    fresh.map((m) => [m.id, m.supported, m.colour, m.standing.length]).sort(), [[0, true, 0x22c55e, 1], [1, true, 0x22c55e, 1]]);
  const hostBefore = await hostWorld();
  await page.click('#ms-close');

  const selectShelf = () => page.evaluate(() => {
    selectPlaced(state.placed.findIndex((q) => (state.models.find((m) => m.id === q.sourceId) || {}).name === 'shelf'));
  });
  const HOST_OPS = [
    ['moved 15 mm (nudge)', () => page.evaluate(() => nudgeSelected(-15, 0))],
    ['mirrored', async () => {
      await page.evaluate(() => { document.getElementById('inp-mirror-plane').value = ''; document.getElementById('btn-mirror').click(); });
      await page.evaluate(() => document.getElementById('btn-mirror').click());
    }],
    ['turned 90° (yaw)', () => page.evaluate(() => rotateSelected(1))],
  ];
  for (const [label, op] of HOST_OPS) {
    await selectShelf();
    const u0 = await page.evaluate(() => state.undoStack.length);
    await op();
    await page.waitForFunction((n) => state.undoStack.length > n, u0, { timeout: 30000 });
    await page.click('#btn-microscope');
    await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
    const after = await readMarks();
    const read = await page.evaluate(() => document.getElementById('ms-support-read').textContent);
    check(`host ${label}: both regions red - the supports are labelled for them but no longer touch them`,
      after.map((m) => [m.supported, m.colour, m.standing.length]), [[false, 0xff2d2d, 0], [false, 0xff2d2d, 0]]);
    check(`host ${label}: each red marker names the support that no longer touches it, and so does the panel`,
      [after.every((m) => m.stale.length === 1), supNames.every((n) => read.includes(n)),
        /2 unsupported/.test(read), /No longer touching/.test(read)], [true, true, true, true]);
    await page.click('#ms-close');
    await page.click('#btn-undo');
    const hostNow = await hostWorld();
    check(`host ${label}, then Undo: the host is back exactly - every world coordinate, and its resting height`,
      [sameArray(hostNow.world, hostBefore.world), hostNow.y], [true, hostBefore.y]);
    await page.click('#btn-microscope');
    await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
    check(`host ${label}, then Undo: both green again`,
      (await readMarks()).map((m) => [m.supported, m.colour, m.stale.length]), [[true, 0x22c55e, 0], [true, 0x22c55e, 0]]);
    await page.click('#ms-close');
  }

  // The support moved alone: its own region red, the other untouched.
  await page.evaluate((id) => selectPlaced(state.placed.findIndex((q) => q.sourceId === id)), tree6.id);
  await page.evaluate(() => nudgeSelected(0, 8));
  await page.click('#btn-microscope');
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
  check('the tree moved away on its own: the shelf red, the tab (its strut untouched) still green',
    (await readMarks()).map((m) => [m.id, m.supported]).sort(), [[0, false], [1, true]]);
  await shot(page, '07-stale-support-red.png', 'a support moved off its overhang: that marker red');
  await page.click('#ms-close');
  await page.click('#btn-undo');
  await page.click('#btn-microscope');
  await page.evaluate(() => window.NSO_GSCOPE_SUPPORT.setOn(true));
  check('and Undo of that move: green again', (await readMarks()).every((m) => m.supported), true);
  await page.click('#ms-close');

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

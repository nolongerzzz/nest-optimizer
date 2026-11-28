#!/usr/bin/env node
// Soften on a slanted face: a tube cut off at 45 degrees (docs/SOFTEN-SLANT.md).
//
//   node tools/nso_soften_slant_drive_check.js        exit 0 = every gate held
//
// Drives the real app in headless Chromium with real clicks. The piece is a
// tube Ø20 / bore Ø16, its top end cut off at 45 degrees - the face a click
// used to refuse with "Click a flat face - that spot is on a curve".
//
//   1  the pick       the live card takes a click on the slanted face and
//                     previews it (it is named by its normal, not an axis)
//   2  the round      Round R 0.5 and Bevel R 0.5 preview and bake sound
//                     (closed, manifold), every vertex inside the uncut piece
//                     (no lip where the wall leans), the bake is the preview
//                     bit for bit, ONE Undo step, Undo gives the piece back
//   3  untouched      the flat bottom end's vertices are where they were
//   4  Corners        refused in words: the walls lean
//   5  headless       the engine at 15 / 30 / 45 / 60 degrees, R 0.05 - 0.5,
//                     Round / Bevel / Corners+edges: closed and manifold, no
//                     vertex outside the uncut piece, through mesh_validate

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const RO = 10, RI = 8, H = 30, N = 96;
/* A tube, bottom at z 0, top cut by the plane z = H + x tan(ang). */
function cutTube(ang) {
  const o = [], k = Math.tan(ang * Math.PI / 180);
  const P = (r, a, top) => { const x = r * Math.cos(a), y = r * Math.sin(a); return [x, y, top ? H + x * k : 0]; };
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  for (let i = 0; i < N; i++) {
    const a = 2 * Math.PI * i / N, b = 2 * Math.PI * (i + 1) / N;
    tri(P(RO, a, 0), P(RO, b, 0), P(RO, b, 1)); tri(P(RO, a, 0), P(RO, b, 1), P(RO, a, 1));
    tri(P(RI, a, 0), P(RI, b, 1), P(RI, b, 0)); tri(P(RI, a, 0), P(RI, a, 1), P(RI, b, 1));
    tri(P(RO, a, 1), P(RO, b, 1), P(RI, b, 1)); tri(P(RO, a, 1), P(RI, b, 1), P(RI, a, 1));
    tri(P(RO, a, 0), P(RI, b, 0), P(RO, b, 0)); tri(P(RO, a, 0), P(RI, a, 0), P(RI, b, 0));
  }
  return new Float32Array(o);
}
/* Worst distance any vertex stands outside the uncut piece, in its own frame
   (cx, cy, z0: where the tube's axis and bottom are in that soup). */
function outside(soup, ang, cx, cy, z0) {
  const k = Math.tan(ang * Math.PI / 180), c = Math.cos(Math.atan(k));
  let worst = 0;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i] - cx, y = soup[i + 1] - cy, z = soup[i + 2] - z0, r = Math.hypot(x, y);
    worst = Math.max(worst, r - RO, RI - r, (z - (H + x * k)) * c, -z);
  }
  return worst;
}
function seal(s) {
  const q = 1e4, vk = (i) => Math.round(s[i] * q) + '|' + Math.round(s[i + 1] * q) + '|' + Math.round(s[i + 2] * q);
  const use = new Map();
  for (let t = 0; t + 8 < s.length; t += 9) {
    const K = [vk(t), vk(t + 3), vk(t + 6)];
    for (let e = 0; e < 3; e++) {
      const a = K[e], b = K[(e + 1) % 3];
      if (a === b) continue;
      const kk = a < b ? a + '~' + b : b + '~' + a;
      use.set(kk, (use.get(kk) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  use.forEach(c => { if (c % 2) open++; if (c > 2) nm++; });
  return { open, nm };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-soften-slant-'));

/* ------------------------------------------------------------------ 5 */
function headless() {
  console.log('\n=== 5. headless: the engine at four angles ===');
  const ctx = {
    Math, Map, Set, console: { log() {}, warn() {}, error() {} }, Array, Object, Number, String, JSON,
    isFinite, isNaN, parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array,
    Uint16Array, Int8Array, ArrayBuffer, Error, Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol,
    setTimeout, clearTimeout
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext('var state = {}; var THREE = {};', ctx);
  for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-finish.js',
                   'app-extend.js', 'app-fatten.js', 'nso_section.js', 'nso_ring.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  for (const ang of [15, 30, 45, 60]) {
    const t = cutTube(ang), a = ang * Math.PI / 180;
    const n = [-Math.sin(a), 0, Math.cos(a)];
    let plane = -Infinity;
    for (let i = 0; i < t.length; i += 3) plane = Math.max(plane, n[0] * t[i] + n[1] * t[i + 1] + n[2] * t[i + 2]);
    const bad = [];
    let worst = 0;
    for (const mode of ['fillet', 'chamfer', 'cornersedges']) {
      for (const R of [0.05, 0.2, 0.5]) {
        try {
          const o = ctx.softenObliqueFace(t, n, plane, R, mode);
          const s = seal(o), w = outside(o, ang, 0, 0, 0);
          worst = Math.max(worst, w);
          if (s.open || s.nm || w > 1e-3) bad.push(mode + ' R ' + R + ': ' + JSON.stringify(s) + ' out ' + w.toFixed(4));
        } catch (e) { bad.push(mode + ' R ' + R + ': ' + e.message); }
      }
    }
    check(ang + ' degrees: Round / Bevel / Corners+edges R 0.05 - 0.5 sound, nothing outside the piece',
          bad.length === 0, bad.length ? bad.join(' | ') : 'worst outside ' + worst.toFixed(5));
    const f = path.join(TMP, 'a' + ang + '.stl');
    writeSTL(f, ctx.softenObliqueFace(t, n, plane, 0.5, 'fillet'), 'slant');
    const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
               j.degenerate_tris === 0 && j.self_intersection.pierce === 0;
    check('  ...Round R 0.5 through mesh_validate', ok, 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges +
          ' inc ' + j.inconsistent_winding_edges + ' deg ' + j.degenerate_tris + ' pierce ' + j.self_intersection.pierce);
  }
  let corners = null;
  try { const t = cutTube(45), a = Math.PI / 4; ctx.softenObliqueFace(t, [-Math.sin(a), 0, Math.cos(a)], 30 * Math.cos(a), 0.5, 'corners'); }
  catch (e) { corners = e.message; }
  check('Corners refused in words: the walls lean', !!corners && /walls lean/.test(corners), corners);
}

headless();

const stl = path.join(TMP, 'tube-cut45.stl');
writeSTL(stl, cutTube(45), 'tube cut 45');

withApp(async (page) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const info = () => page.evaluate(() => { const i = window.nsoSoftenLive.info(); if (i) delete i.soup; return i; });
  const undoDepth = () => page.evaluate(() => state.undoStack.length);
  const frames = (n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  const tile = (st) => page.click('#soften-shelf [data-style="' + st + '"]');
  const clickAt = async (s) => {
    await page.mouse.move(s.x - 3, s.y - 3);
    await page.mouse.move(s.x, s.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(500);
  };

  console.log('\n=== 1. the pick ===');
  const id = await loadSTL(page, stl);
  await page.waitForTimeout(500);
  await page.evaluate(() => selectPlaced(state.placed.length - 1));
  // Look square at the slanted face, and find a spot on it: a display triangle
  // facing that way, its centroid on the screen.
  const spot = await page.evaluate((i) => {
    const p = state.placed.find(q => q && q.sourceId === i), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry, pos = geo.attributes.position;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    let best = null, bestUp = -1;
    for (let k = 0; k < pos.count; k += 3) {
      a.fromBufferAttribute(pos, k); b.fromBufferAttribute(pos, k + 1); c.fromBufferAttribute(pos, k + 2);
      mesh.localToWorld(a); mesh.localToWorld(b); mesh.localToWorld(c);
      n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      // the slanted face: tilted 45 degrees off every axis it touches
      const flatish = Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z));
      if (flatish > 0.9 || flatish < 0.6) continue;
      const up = n.y;
      if (up > bestUp) { bestUp = up; best = { n: n.clone(), c: a.clone().add(b).add(c).multiplyScalar(1 / 3) }; }
    }
    const box = new THREE.Box3().setFromObject(mesh), mid = box.getCenter(new THREE.Vector3());
    state.controls.target.copy(best.c);
    state.camera.position.copy(best.c.clone().add(best.n.clone().multiplyScalar(70)));
    state.camera.lookAt(best.c); state.controls.update(); state.camera.updateMatrixWorld(true);
    const v = best.c.clone().project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, n: best.n.toArray(), mid: mid.toArray() };
  }, id);
  await frames(2);
  const model = () => page.evaluate(i => Array.from(state.models.find(m => m.id === i).rawTris), id);
  const raw0 = await model(), u0 = await undoDepth();
  // where the tube's axis and bottom are in the app's raw frame
  let cx = 0, cy = 0, z0 = Infinity;
  for (let k = 0; k < raw0.length; k += 3) z0 = Math.min(z0, raw0[k + 2]);
  { let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (let k = 0; k < raw0.length; k += 3) { lo[0] = Math.min(lo[0], raw0[k]); hi[0] = Math.max(hi[0], raw0[k]); lo[1] = Math.min(lo[1], raw0[k + 1]); hi[1] = Math.max(hi[1], raw0[k + 1]); }
    cx = (lo[0] + hi[0]) / 2; cy = (lo[1] + hi[1]) / 2; }
  check('the piece loads as the uncut-tube frame expects', outside(raw0, 45, cx, cy, z0) < 1e-3);

  const open = await page.evaluate(() => document.getElementById('menu-surface').open);
  if (!open) await page.click('#menu-surface > summary');
  await page.click('#btn-soften'); await page.waitForTimeout(200);
  await tile('fillet');
  await page.waitForFunction(() => window.nsoSoftenLive.info().needPick === true, null, { timeout: 8000 });
  await page.fill('#inp-soften-r', '0.5');
  await page.waitForTimeout(300);
  await clickAt(spot);
  await page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return !!(i && (i.ok || i.refused)); }, null, { timeout: 20000 }).catch(() => {});
  let i = await info();
  const status = await page.evaluate(() => (document.getElementById('status') || {}).textContent || '');
  check('a click on the slanted face puts it in the preview', !!(i && i.ok && i.kind === 'faces' && i.picks === 1),
        (i && (i.text || i.readout || i.refused)) + ' | status: ' + status);
  check('the piece was not touched by the preview', (await undoDepth()) === u0);

  console.log('\n=== 2. the round ===');
  await page.evaluate(() => { window.__ghost = Array.from(window.nsoSoftenLive.info().soup || []); });
  await page.click('#btn-soften'); await page.waitForTimeout(800);
  const baked = await model();
  check('the bake installs the preview, bit for bit', await page.evaluate((i) => {
    const g = window.__ghost, r = state.models.find(m => m.id === i).rawTris;
    if (!g || g.length !== r.length) return false;
    for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
    return true;
  }, id));
  const sb = seal(baked);
  check('Round R 0.5: closed and manifold', sb.open === 0 && sb.nm === 0, JSON.stringify(sb));
  const out = outside(baked, 45, cx, cy, z0);
  check('  ...no vertex outside the uncut piece (no lip on the leaning wall)', out < 1e-3, 'worst ' + out.toFixed(5));
  check('  ...and the face did change', baked.length !== raw0.length);
  check('ONE Undo step', (await undoDepth()) === u0 + 1);

  console.log('\n=== 3. untouched ===');
  {
    const bottom = (s) => { const k = new Set(); for (let q = 0; q < s.length; q += 3) if (Math.abs(s[q + 2] - z0) < 1e-6) k.add(s[q] + ',' + s[q + 1] + ',' + s[q + 2]); return k; };
    const b0 = bottom(raw0), b1 = bottom(baked);
    check('the flat bottom end is bit for bit where it was', b0.size === b1.size && [...b0].every(x => b1.has(x)), b0.size + ' / ' + b1.size);
  }
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(300);
  const back = await model();
  check('Undo gives the piece back', back.length === raw0.length && back.every((v, k) => v === raw0[k]));

  console.log('\n=== 4. Bevel, and Corners ===');
  {
    const on = await page.evaluate(() => window.nsoSoftenLive.on());
    if (!on) { await page.click('#btn-soften'); await page.waitForTimeout(200); }
    await tile('chamfer');
    await page.waitForTimeout(300);
    const needs = await page.evaluate(() => window.nsoSoftenLive.info().needPick);
    if (needs) await clickAt(spot);
    await page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return !!(i && (i.ok || i.refused)); }, null, { timeout: 20000 }).catch(() => {});
    i = await info();
    check('Bevel R 0.5 previews on the slanted face', !!(i && i.ok), i && (i.text || i.refused));
    await tile('corners');
    await page.waitForTimeout(800);
    i = await info();
    check('Corners refused in words: the walls lean', !!(i && !i.ok && /walls lean/.test(i.refused || i.readout || '')),
          i && (i.refused || i.readout));
  }
}).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});

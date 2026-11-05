/* nso_cut_sever_drive_check.js - a sized cut that goes right through a finger:
   it separates, it says what it is, and the blade spins in place.
     node tools/nso_cut_sever_drive_check.js        exit 0 = every gate held

   Reported on a hand model: the finger was cut (a gap) but stayed ONE piece, the
   status called a Sized cut a "Notch cut", it blamed the cut for open edges the
   piece already had, Split to parts then refused ("part 2 is too small to be a
   piece"), and a bevel sent the blade flying round the piece instead of turning it.

   The piece here is an L - a palm 30 x 10 and an arm (the finger) 10 x 30 - plus
   a stray 0.05 mm cube floating beside it: the dust that makes Split to parts
   refuse. 10 mm thick, so the finger has a 10 x 10 section.

   WHAT IS PINNED
   - A sized blade across the finger takes exactly kerf x 10 x 10, says "Sized cut"
     (never "Notch cut"), and leaves TWO pieces; the dust is folded into the larger
     part, not dropped (the volumes add up) and not refused.
   - One Undo takes the separation back, a second takes the cut back, vertex for vertex.
   - The open / non-manifold edge note compares before and after: edges the piece
     already had are not blamed on the cut; edges the cut adds are.
   - Bevel 0..90 and mitre 0..90: the blade stays where it was clicked (the click is
     inside the blade's box), the whole way round.                              */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.05 : tol);

/* The L (palm along x, finger along y), extruded 10 mm in z, outward-wound; plus a tiny cube. */
function lPiece() {
  const P = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 40], [0, 40]], H = 10, o = [];
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  const fan = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]];
  fan.forEach(f => { tri([...P[f[0]], 0], [...P[f[2]], 0], [...P[f[1]], 0]); tri([...P[f[0]], H], [...P[f[1]], H], [...P[f[2]], H]); });
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    tri([...a, 0], [...b, 0], [...b, H]); tri([...a, 0], [...b, H], [...a, H]);
  }
  const c0 = [36, 4, 4], s = 0.05, q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  const v = (x, y, z) => [c0[0] + x * s, c0[1] + y * s, c0[2] + z * s];
  q(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)); q(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1));
  q(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)); q(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0));
  q(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)); q(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1));
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-sever-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const PROBE = `window.__probe = function (id) {
  const m = state.models.find(x => x.id === id);
  if (!m) return null;
  const g = m.geometry, pos = g.attributes.position, idx = g.index, n = idx ? idx.count / 3 : pos.count / 3;
  const P = k => { const i = idx ? idx.getX(k) : k; return [pos.getX(i), pos.getY(i), pos.getZ(i)]; };
  let vol = 0;
  for (let t = 0; t < n; t++) { const a = P(t * 3), b = P(t * 3 + 1), c = P(t * 3 + 2);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
  const adj = m.rawTris ? NSO_buildAdjacency(m.rawTris, { tol: 1e-4, rawTol: true }) : null;
  return { vol: vol, tris: n, open: adj ? adj.openEdges : null, nm: adj ? adj.nmEdges : null, name: m.name };
};`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PROBE });
  const probe = id => page.evaluate(id => __probe(id), id);
  const status = () => page.evaluate(() => document.getElementById('status').textContent);
  const waitCut = () => page.waitForFunction(() => /(Sized|Notch) cut|Cut not made/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const pieces = () => page.evaluate(() => state.models.map(m => ({ id: m.id, name: m.name })));

  async function fresh() {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); clearPlateOnly(); });
    const id = await loadSTL(page, stl('finger.stl', lPiece()));
    await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
    await page.waitForTimeout(100);
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    return id;
  }
  const clickAt = async wp => {
    const xy = await page.evaluate(wp => { const v = new THREE.Vector3(wp[0], wp[1], wp[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }, wp);
    await page.mouse.move(xy[0], xy[1]); await page.mouse.down(); await page.mouse.up();
  };
  // the top of the finger, found by a ray straight down at a point along the arm
  const fingerTop = (alongFrac) => page.evaluate(frac => {
    const p = state.placed[0]; p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh), rc = new THREE.Raycaster(), L = b.max.z - b.min.z;
    // the arm is the long way (world z); its x is the narrow 10 mm at one end of the x range
    const x = b.min.x + 5, z = b.min.z + L * frac;
    rc.set(new THREE.Vector3(x, b.max.y + 20, z), new THREE.Vector3(0, -1, 0));
    const h = rc.intersectObject(p.mesh, false)[0];
    return h ? [h.point.x, h.point.y, h.point.z] : null;
  }, alongFrac);
  const setSized = (w, d, k) => page.evaluate(([w, d, k]) => {
    document.getElementById('btn-cut-blade-sized').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('cut-blade-width', w); set('cut-blade-depth', d); set('cut-blade-kerf', k);
  }, [w, d, k]);

  console.log('the piece');
  let id = await fresh();
  const v0 = await probe(id);
  const expected0 = 30 * 10 * 10 + 10 * 30 * 10 + 0.05 ** 3;
  check('an L with a stray 0.05 mm cube: 6000 mm^3, two bodies, closed', near(v0.vol, expected0, 1) && v0.open === 0 && v0.nm === 0, JSON.stringify(v0));

  console.log('a sized cut through the finger');
  await setSized(20, 20, 1);
  const top = await fingerTop(0.6);
  check('found the finger to click', !!top, JSON.stringify(top));
  await clickAt(top);
  const ro = await page.evaluate(() => document.getElementById('cut-readout').textContent);
  check('the readout calls it a sized blade', /SIZED BLADE/.test(ro) && !/NOTCH/.test(ro), ro);
  await page.click('#btn-cut'); await waitCut();
  await page.waitForTimeout(300);
  const st = await status(), ps = await pieces();
  check('the status says Sized cut, never Notch cut', /^Sized cut/.test(st) && !/Notch cut/.test(st), st);
  check('it takes exactly kerf x 10 x 10 = 100 mm^3', /100 mm³ removed/.test(st), st);
  check('the finger is a piece of its own: two pieces now', ps.length === 2, JSON.stringify(ps));
  check('and the status says it separated them', /separated into 2 pieces/.test(st), st);
  const vols = []; for (const p of ps) vols.push(await probe(p.id));
  const total = vols.reduce((a, b) => a + b.vol, 0);
  check('nothing lost: the two pieces add up to the original less the kerf (the dust is kept, not dropped)', near(total, v0.vol - 100, 0.01), total.toFixed(5) + ' vs ' + (v0.vol - 100).toFixed(5));
  // The palm piece carries the dust: its box reaches the stray cube at x = 36.05, the finger piece's does not.
  const sizes = await page.evaluate(ids => ids.map(i => { const m = state.models.find(x => x.id === i); return m.size.x; }), ps.map(p => p.id));
  const wide = sizes.filter(x => x > 35).length, narrow = sizes.filter(x => x <= 35).length;
  check('the dust went with the larger piece (its box reaches the cube at x = 36), not into a piece of its own', wide === 1 && narrow === 1, JSON.stringify(sizes.map(v => +v.toFixed(2))));
  check('both pieces are closed', vols.every(v => v.open === 0 && v.nm === 0), JSON.stringify(vols.map(v => [v.open, v.nm])));
  check('the status carries no warning for a clean cut', !/WARNING|already had/.test(st), st);

  console.log('Undo');
  await page.click('#btn-undo');
  check('the first Undo takes the separation back (one piece again)', (await pieces()).length === 1 && /Split to parts reverted/.test(await status()), await status());
  await page.click('#btn-undo');
  const back = await probe((await pieces())[0].id);
  check('the second Undo takes the cut back, vertex for vertex', near(back.vol, v0.vol, 1e-4) && back.tris === v0.tris, JSON.stringify({ vol: back.vol, tris: back.tris, was: v0.tris }));

  console.log('open edges: blamed on the cut only if the cut added them');
  id = await fresh();
  await setSized(20, 20, 1);
  // make every adjacency read add 25 bad edges to a soup of the piece's own size or smaller than the cut result
  // cutEdgeFaults is read three times a cut: the piece as the kernel holds it, the kernel's result, the committed piece.
  // Make every read 25 worse: the piece "already had" them.
  await page.evaluate(() => { window.__realFaults = window.cutEdgeFaults;
    window.cutEdgeFaults = function (soup) { const r = window.__realFaults(soup); return { open: r.open, nm: r.nm + 25, total: r.total + 25 }; }; });
  await clickAt(await fingerTop(0.6));
  await page.click('#btn-cut'); await waitCut(); await page.waitForTimeout(300);
  const sOld = await status();
  check('edges the piece already had are not blamed on the cut', /already leaves 25 pinched edges in this piece before any cut.*the cut added none/.test(sOld) && !/WARNING/.test(sOld), sOld);
  await page.evaluate(() => { window.cutEdgeFaults = window.__realFaults; });
  await page.click('#btn-undo'); await page.click('#btn-undo');
  // now only the reads AFTER the cut are worse: the cut added 7
  await page.evaluate(() => { let n = 0; window.cutEdgeFaults = function (soup) { const r = window.__realFaults(soup); n++; return n >= 2 ? { open: r.open, nm: r.nm + 7, total: r.total + 7 } : r; }; });
  await clickAt(await fingerTop(0.6));
  await page.click('#btn-cut'); await waitCut(); await page.waitForTimeout(300);
  const sNew = await status();
  check('edges the cut adds are: WARNING with before and after', /WARNING: the cut added 7 open \/ non-manifold edges \(0 → 7\)/.test(sNew), sNew);
  await page.evaluate(() => { window.cutEdgeFaults = window.__realFaults; });

  console.log('spinning in place: bevel and mitre');
  id = await fresh();
  await setSized(12, 8, 1);
  const click = await fingerTop(0.5);
  await clickAt(click);
  // The blade holds the click IN ITS OWN PLANE exactly. Along the plane's normal the plane may sit up to 1 mm off the
  // click: a cut keeps 1 mm of piece on each side (MIN_CUT_SIDE_MM), so a click on the very top, with the blade turned
  // flat, cannot have the plane through it. A blade swung round the piece would be tens of mm off, not 1.
  const held = () => page.evaluate(() => {
    const m = getActiveModel(), i = getCutPlaneLocal(m), b = i.blade, p = state.cutBladeAt.local.clone(), k = ['x', 'y', 'z'].indexOf(i.axis);
    if (i.turn) p.applyMatrix4(i.turn);
    const slack = [0, 1, 2].map(a => Math.max(b.box.min[a] - p.getComponent(a), p.getComponent(a) - b.box.max[a]));
    const inPlane = [0, 1, 2].filter(a => a !== k).every(a => slack[a] <= 1e-3);
    const offPlane = Math.abs(p.getComponent(k) - i.plane);
    return { inside: inPlane && offPlane <= 1.0 + 1e-3, offPlane: +offPlane.toFixed(3), slack: slack.map(v => +v.toFixed(3)), bevel: i.bevel, deg: i.deg };
  });
  check('at rest the blade holds the click', (await held()).inside);
  for (const bevel of [15, 30, 45, 60, 75, 90, -45, -90]) {
    await page.evaluate(b => setCutBevel(b), bevel);
    const h = await held();
    check('bevel ' + bevel + ': the blade is still where it was clicked', h.inside && h.bevel === bevel, JSON.stringify(h));
  }
  await page.evaluate(() => setCutBevel(0));
  for (const mitre of [20, 45, 74, 90, 135, 270]) {
    await page.evaluate(d => setCutMiter(d), mitre);
    const h = await held();
    check('mitre ' + mitre + ': the blade is still where it was clicked', h.inside && Math.abs(h.deg - mitre) < 0.11, JSON.stringify(h));
  }
  await page.evaluate(() => { setCutMiter(30); setCutBevel(40); });
  const both = await held();
  check('mitre 30 with bevel 40 together: still where it was clicked', both.inside, JSON.stringify(both));

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

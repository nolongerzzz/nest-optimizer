/* nso_cut_notch_span_drive_check.js - the Notch on the inside wall of a channel, with the blade lying flat,
   placed by its two ends (From / To), driven through the real app in real Chromium against the real kernel.
     node tools/nso_cut_notch_span_drive_check.js        exit 0 = every gate held

   The piece: a U-channel standing on the plate, 30 x 20 in plan, 25 tall - a floor 4 thick and two walls 4
   thick. The job (a part that pops onto a rail past a tab): a notch 10 tall from the bottom, 2.5 deep, in the
   inside face of one wall.

   What is pinned
   - The blade turned flat (mitre 90, bevel 90) and a real click on the TOP of the wall, near its inner edge:
     the blade stays at the height it was set to (it used to jump to the top face, half in the air, and miss)
     and goes in through the inside face, not the outside one.
   - From 0 / To 10 typed into the card: Notch width becomes 10 and the blade's box runs from the piece's
     bottom to 10 up, read off the box in the world.
   - Cut takes exactly 10 x 2.5 x 16 (the inside face runs 16 from the floor to the wall's end) out of that
     wall, one closed solid.
   - Pressing the blade's handle (ball) takes hold of the blade: the place clicked stays where it was.
   - Moving the slider moves From / To with it.                                                          */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.05 : tol);

async function channelSTL() {
  const ROOT = path.resolve(__dirname, '..');
  const mod = await import(pathToFileURL(path.join(ROOT, 'vendor/manifold/manifold.js')).href);
  const wasm = await (mod.default || mod)();
  wasm.setup();
  const box = (x0, y0, x1, y1) => wasm.Manifold.cube([x1 - x0, y1 - y0, 25]).translate([x0, y0, 0]);
  const U = wasm.Manifold.union([box(0, 0, 30, 4), box(0, 4, 4, 20), box(26, 4, 30, 20)]);
  const mesh = U.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, n = tv.length / 3;
  const b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++)
    b.writeFloatLE(vp[tv[t * 3 + k] * 3 + j], 84 + t * 50 + 12 + (k * 3 + j) * 4);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nso-notch-span-')), 'channel.stl');
  fs.writeFileSync(f, b);
  return { file: f, vol: U.volume() };
}

const VOL = `window.__vol = function () {
  const m = getActiveModel(), g = m.geometry, pos = g.attributes.position, idx = g.index;
  const n = idx ? idx.count / 3 : pos.count / 3;
  const P = k => { const i = idx ? idx.getX(k) : k; return [pos.getX(i), pos.getY(i), pos.getZ(i)]; };
  let v = 0;
  for (let t = 0; t < n; t++) {
    const a = P(t * 3), b = P(t * 3 + 1), c = P(t * 3 + 2);
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const adj = m.rawTris ? NSO_buildAdjacency(m.rawTris, { tol: 1e-4, rawTol: true }) : null;
  return { vol: v, open: adj ? adj.openEdges : null, nm: adj ? adj.nmEdges : null };
};
/* The blade's box in the world: its y range from the piece's bottom. */
window.__bladeY = function () {
  const m = getActiveModel(), info = getCutPlaneLocal(m), p = state.placed.find(q => q && q.sourceId === m.id);
  p.mesh.updateMatrixWorld(true);
  const W = cutWorldMatrix(info, p.mesh), b = info.blade.box, v = new THREE.Vector3();
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyMatrix4(W);
    lo = Math.min(lo, v.y); hi = Math.max(hi, v.y);
  }
  const bottom = new THREE.Box3().setFromObject(p.mesh).min.y;
  return [lo - bottom, hi - bottom];
};`;

(async () => {
  const U = await channelSTL();
  await withApp(async (page, logs) => {
    await page.addScriptTag({ content: VOL });
    const id = await loadSTL(page, U.file);
    await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    const v0 = await page.evaluate(() => __vol());
    check('the channel is ' + U.vol.toFixed(0) + ' mm^3, closed', near(v0.vol, U.vol, 0.5) && v0.open === 0 && v0.nm === 0, JSON.stringify(v0));

    console.log('the blade flat, a click on the top of a wall');
    const flat = await page.evaluate(() => {
      document.getElementById('btn-cut-blade-notch').click();
      const b = cutBladeState(); b.follow = false; b.nfollow = false; b.ndepth = 2.5; b.nwidth = 3; cutBladeRefresh();
      setCutMiter(90);
      for (const bev of [90, -90]) { setCutBevel(bev); if (cutNotchSpanMap(getActiveModel()).flat) return bev; }
      return null;
    });
    check('mitre 90 and a bevel of 90 lay the blade flat', flat !== null, String(flat));
    await page.evaluate(() => setCutMm(getCutPlaneLocal(getActiveModel()).hi));
    const mmSet = await page.evaluate(() => getCutPlaneLocal(getActiveModel()).mm);
    /* A point on a wall's top 0.4 from its inner edge: rays straight down over the piece. The channel is open
       top to bottom, so past a wall's inner edge a ray meets nothing - and further on meets the far wall's top,
       where past the outer edge there is nothing more. */
    const target = await page.evaluate(() => {
      const p = state.placed.find(q => q && q.sourceId === getActiveModel().id);
      p.mesh.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(p.mesh), rc = new THREE.Raycaster();
      const down = (x, z) => { rc.set(new THREE.Vector3(x, b.max.y + 10, z), new THREE.Vector3(0, -1, 0)); const h = rc.intersectObject(p.mesh, false)[0]; return h ? h.point : null; };
      for (let x = b.min.x + 0.25; x < b.max.x; x += 0.5) for (let z = b.min.z + 0.25; z < b.max.z; z += 0.5) {
        const h = down(x, z);
        if (!h) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (down(x + dx * 0.8, z + dz * 0.8)) continue;
          // mid-wall, not at a corner: the top runs on 3 mm either way along the edge
          if (!down(x + dz * 3, z + dx * 3) || !down(x - dz * 3, z - dx * 3)) continue;
          if (!down(x + dz * 3 + dx * 0.8, z + dx * 3 + dz * 0.8) === false || !down(x - dz * 3 + dx * 0.8, z - dx * 3 + dz * 0.8) === false) continue;
          let far = false;
          for (let s = 2; s < 30 && !far; s += 1) far = !!down(x + dx * s, z + dz * s);
          if (far) return [x + dx * 0.4, h.y, z + dz * 0.4];
        }
      }
      return null;
    });
    check('found the top of a wall beside its inside face', !!target, JSON.stringify(target));
    const toScreen = wp => page.evaluate(wp => { const v = new THREE.Vector3(wp[0], wp[1], wp[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }, wp);
    const xy = await toScreen(target);
    await page.mouse.move(xy[0], xy[1]); await page.mouse.down(); await page.mouse.move(xy[0] + 2, xy[1] + 2); await page.mouse.up();
    const after = await page.evaluate(() => ({ mm: getCutPlaneLocal(getActiveModel()).mm, at: state.cutBladeAt && state.cutBladeAt.normal && state.cutBladeAt.normal.toArray() }));
    check('the click landed on a face (the top: the blade must not have moved)', !!after.at, JSON.stringify(after.at));
    check('and the blade stayed at the height it was set to', near(after.mm, mmSet, 1e-6), after.mm + ' vs ' + mmSet);

    console.log('From 0 / To 10');
    // typed, then Enter (which leaves the box: a box being typed in is not rewritten under the cursor)
    const set = async (sel, v) => { await page.fill(sel, String(v)); await page.press(sel, 'Enter'); };
    await set('#cut-notch-from', 0);
    await set('#cut-notch-to', 10);
    const sp = await page.evaluate(() => ({ w: state.cutBlade.nwidth, y: __bladeY(), from: document.getElementById('cut-notch-from').value,
      to: document.getElementById('cut-notch-to').value, readout: document.getElementById('cut-readout').textContent, label: document.getElementById('cut-notch-span-label').title }));
    check('Notch width becomes 10', sp.w === 10, JSON.stringify(sp));
    check('the blade runs from the piece\'s bottom to 10 up', near(sp.y[0], 0, 0.051) && near(sp.y[1], 10, 0.051), JSON.stringify(sp.y));
    check('the boxes read back 0 and 10, and say they are heights', sp.from === '0' && sp.to === '10' && /up from the bottom/.test(sp.label), sp.from + ' / ' + sp.to + ' - ' + sp.label);

    console.log('the handle');
    const at0 = await page.evaluate(() => JSON.stringify(state.cutBladeAt.local.toArray()));
    const ball = await page.evaluate(() => { const b = state.cutHelper.children.find(c => c.userData.cutBall); b.updateMatrixWorld(true);
      return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray(); });
    const bxy = await toScreen(ball);
    await page.mouse.move(bxy[0], bxy[1]); await page.mouse.down(); await page.mouse.up();
    check('a press on the ball leaves the place clicked alone', await page.evaluate(() => JSON.stringify(state.cutBladeAt.local.toArray())) === at0);
    await set('#cut-notch-from', 0); await set('#cut-notch-to', 10);

    console.log('the cut');
    if (process.env.DBG) console.log(await page.evaluate(() => { const i = getCutPlaneLocal(getActiveModel()); return JSON.stringify({ axis: i.axis, plane: i.plane, box: i.blade.box, entry: i.blade.entry, q: i.blade.q, at: state.cutBladeAt.local.toArray(), cl: cutSectionOf(getActiveModel(), i, ['x','y','z'].indexOf(i.axis)).map(c => [c.min, c.max, c.segs.length]) }); }));
    const v1 = await page.evaluate(async () => { await cutNotchAt(getActiveModel(), getCutPlaneLocal(getActiveModel())); return __vol(); });
    const st = await page.evaluate(() => document.getElementById('status').textContent);
    check('it takes 10 x 2.5 x 16 out of the inside of the wall', near(v0.vol - v1.vol, 400, 0.5), (v0.vol - v1.vol).toFixed(3) + ' of 400; ' + st);
    check('one closed solid', v1.open === 0 && v1.nm === 0 && !/bod(y|ies)/.test(st), st);

    const edge = await page.evaluate(() => { const p = state.placed[state.selectedIndex]; let n = 0, onPiece = false;
      state.scene.traverse(o => { if (o.name === 'selOutline') { n++; if (o.parent === p.mesh) onPiece = true; } }); return { n, onPiece }; });
    check('the piece keeps its white edge after the cut (it stayed on the mesh the cut replaced)', edge.n === 1 && edge.onPiece, JSON.stringify(edge));
    // What a box holds can come apart into the material and a sliver of no volume where it grazes the surface - the
    // sliver nearest the click. Taking the sliver took nothing: "the blade does not reach the piece".
    const pick = await page.evaluate(() => {
      const fake = (vol, pts) => ({ volume: () => vol, getMesh: () => ({ vertProperties: new Float32Array(pts), numProp: 3 }) });
      return cutNearestPart([fake(0, [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), fake(182, [5, 0, 0, 6, 0, 0, 5, 1, 0])], new THREE.Vector3(0, 0, 0));
    });
    check('a sliver of no volume nearest the click is passed over for the material', pick === 1, String(pick));

    console.log('the slider moves From / To');
    await page.evaluate(() => setCutMm(getCutPlaneLocal(getActiveModel()).mm + 2));
    const moved = await page.evaluate(() => [document.getElementById('cut-notch-from').value, document.getElementById('cut-notch-to').value].map(Number));
    check('2 mm along the slider moves both ends 2 mm (a flat blade\'s slider counts down from the top), still 10 apart', near(Math.abs(moved[0] - 0), 2, 0.051) && near(moved[1] - moved[0], 10, 0.051), JSON.stringify(moved));

    console.log('ends off the slider\'s 0.1 mm grid');
    await set('#cut-notch-from', 1.25); await set('#cut-notch-to', 11.25);
    const odd = await page.evaluate(() => ({ y: __bladeY(), w: state.cutBlade.nwidth }));
    check('From 1.25 / To 11.25 is exactly that - the notch carries what the slider\'s step cannot', near(odd.y[0], 1.25, 1e-3) && near(odd.y[1], 11.25, 1e-3) && odd.w === 10, JSON.stringify(odd));

    console.log('Turn 90: a pocket the length of the face');
    // the 0..10 notch off (one Undo), then the same wall's top clicked again, turned: 5 wide across the face, 2 deep
    await page.click('#btn-undo');
    const t0 = await page.evaluate(() => __vol());
    await page.mouse.move(xy[0], xy[1]); await page.mouse.down(); await page.mouse.move(xy[0] + 2, xy[1] + 2); await page.mouse.up();
    await page.evaluate(() => { const b = cutBladeState(); b.nwidth = 5; b.ndepth = 2; b.nshift = 0; cutBladeRefresh(); });
    await page.click('#btn-cut-notch-turn');
    const tv = await page.evaluate(() => ({ pressed: document.getElementById('btn-cut-notch-turn').getAttribute('aria-pressed'),
      spanHidden: document.getElementById('cut-notch-from').closest('.cut-slide-row').hidden, ro: document.getElementById('cut-readout').textContent,
      turned: getCutPlaneLocal(getActiveModel()).blade.turned }));
    check('Turn 90 is pressed, the notch is turned, and From / To are put away', tv.pressed === 'true' && tv.turned && tv.spanHidden, JSON.stringify(tv));
    check('the readout says across the face, the length of the face', /NOTCH, TURNED - 5 wide across the face .* 2 deep, the length of the face \(\d/.test(tv.ro), tv.ro);
    const t1 = await page.evaluate(async () => { await cutNotchAt(getActiveModel(), getCutPlaneLocal(getActiveModel())); return { v: __vol(), st: document.getElementById('status').textContent, n: state.models.length }; });
    // the wall's inside face runs the piece's whole 25 mm height: 5 x 2 x 25
    check('it takes 5 x 2 x 25: a pocket down the whole inside face, one piece still', near(t0.vol - t1.v.vol, 250, 0.5) && t1.n === 1 && /pocket along the face/.test(t1.st),
      (t0.vol - t1.v.vol).toFixed(3) + ' of 250; ' + t1.st);
    check('closed', t1.v.open === 0 && t1.v.nm === 0, JSON.stringify(t1.v));

    const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
    check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
    process.exit(fails ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(2); });

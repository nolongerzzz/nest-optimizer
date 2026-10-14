/* The cutter's blade can be seen whole, through the piece, and the plate line
   marks the same cut on the plate - on a tall piece, a wide piece, a turned
   piece and a piece already cut once.
     node tools/nso_wire_cut_blade_view_test.js     exit 0 = every gate held

   WHAT WAS WRONG (reproduced on this tree before the change)
   The blade was an opaque 0.7 mm black slab, depth-tested like a piece, with
   a depth-tested black frame and crosshair. Wherever it sat inside a solid
   piece the piece's own faces hid it, so only the parts outside showed: on a
   140 mm tall piece the blade read as a strip down the near face, on a
   140 mm wide one as a line across the top. Its size was right all along -
   with depth testing switched off the whole blade appeared.

   NOW (app-cut.js buildCutHelper / updateCutHelper)
   - The blade is a thin translucent sheet with a solid edge frame, neither
     depth-tested, drawn after the pieces: visible through the piece.
   - A plate line, flat on the plate, one kerf wide, where the cut plane meets
     the plate, spanning the piece's footprint. It is the plane Split cuts and
     the box the blade is sized from, carried into world space.
   - The x-ray view leaves all of it alone (it rewrites depth settings on
     whatever it walks, which would bring the opaque slab back).

   Real app. Each case checks, in the piece's own frame: the blade's corners
   stand on the plane and cover the piece's bounds across the cut. At the
   slider's low end, middle and high end (and a typed mm): the plate line's
   drawn vertices lie in the cut plane at the slider's number, on the plate,
   and span the piece. Then pixels, from four cameras: the plate line and the
   blade's frame show where the piece covers them, and the sheet tints the
   piece where it is buried in it.                                          */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function bar(L, W, Ht) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]); q([0, 0, Ht], [L, 0, Ht], [L, W, Ht], [0, W, Ht]);
  q([0, 0, 0], [L, 0, 0], [L, 0, Ht], [0, 0, Ht]); q([0, W, 0], [0, W, Ht], [L, W, Ht], [L, W, 0]);
  q([0, 0, 0], [0, 0, Ht], [0, W, Ht], [0, W, 0]); q([L, 0, 0], [L, W, 0], [L, W, Ht], [L, 0, Ht]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-blade-view-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

/* What the blade and plate line draw, read off their geometry, against the
   cut frame and the slider - computed here, not taken from the helper. */
const STATE = `window.__bladeView = function (id) {
  const m = state.models.find(x => x.id === id);
  const f = cutFrame(m);
  const mesh = f.mesh;
  state.scene.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const H = state.cutHelper;
  const blade = H.children.find(c => c.userData.cutBlade);
  const frame = H.children.find(c => c.userData.cutFrame);
  const verts = (o) => { const p = o.geometry.attributes.position, out = [];
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)); return out; };
  const k = f.axis, AX = ['x', 'y', 'z'], across = AX.filter(a => a !== k);
  const slider = Number(document.getElementById('cut-slider').value);
  const plane = f.origin + slider;                 // where the slider says the cut is
  const bladeLocal = verts(blade).concat(verts(frame)).map(v => v.applyMatrix4(toLocal));
  const offPlane = Math.max(...bladeLocal.map(v => Math.abs(v[k] - plane)));
  const margin = Math.min(...across.map(a => Math.min(f.bbox.min[a] - Math.min(...bladeLocal.map(v => v[a])),
                                                     Math.max(...bladeLocal.map(v => v[a])) - f.bbox.max[a])));
  // The plate line as drawn: every vertex of its strip and centre line.
  const pl = H.getObjectByName('cutPlateLine');
  const lineW = pl.children.map(verts).flat();
  const P = f.bbox.getCenter(new THREE.Vector3()); P[k] = plane; P.applyMatrix4(mesh.matrixWorld);
  const n = new THREE.Vector3(k === 'x' ? 1 : 0, k === 'y' ? 1 : 0, k === 'z' ? 1 : 0)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
  const centre = verts(pl.children.find(c => !c.isMesh));
  // In the plate: is each centre-line end where the plane meets y = 0?
  const onTrace = Math.max(...centre.map(v => Math.abs(new THREE.Vector3(v.x, 0, v.z).sub(P).dot(n))));
  const halfWidth = Math.max(...lineW.map(v => Math.abs(new THREE.Vector3(v.x, 0, v.z).sub(P).dot(n)))) /
                    Math.hypot(n.x, n.z);
  const yMax = Math.max(...lineW.map(v => Math.abs(v.y)));
  // Span: the piece's own vertices, in world space, along the line.
  const dir = new THREE.Vector3().subVectors(centre[1], centre[0]); dir.y = 0; dir.normalize();
  const gp = m.geometry.attributes.position; let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < gp.count; i++) {
    const s = new THREE.Vector3().fromBufferAttribute(gp, i).applyMatrix4(mesh.matrixWorld).sub(centre[0]).dot(dir);
    lo = Math.min(lo, s); hi = Math.max(hi, s);
  }
  const L = centre[1].clone().sub(centre[0]); L.y = 0;
  const depth = [blade, frame].concat(pl.children).every(o => o.material.depthTest === false && o.material.depthWrite === false);
  return { axis: k, span: f.span, slider: slider, box: Number(document.getElementById('cut-mm').value),
           offPlane: offPlane, margin: margin, onTrace: onTrace, halfWidth: halfWidth, yMax: yMax,
           spanLo: lo, spanHi: hi - L.length(), depth: depth,
           bladeTransparent: blade.material.transparent && blade.material.opacity < 0.6 };
};
/* The canvas as rendered round a world point (a 7 x 7 patch, so a 1 px line
   is not missed by rounding), with or without the cut helper drawn. */
window.__pixelAt = function (world, withHelper) {
  const r = state.renderer, size = r.getSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y);
  const was = state.cutHelper.visible;
  state.cutHelper.visible = withHelper;
  r.setRenderTarget(rt); r.render(state.scene, state.camera); r.setRenderTarget(null);
  state.cutHelper.visible = was;
  const v = new THREE.Vector3().fromArray(world).project(state.camera);
  const px = Math.round((v.x + 1) / 2 * size.x), py = Math.round((v.y + 1) / 2 * size.y);
  const N = 7, buf = new Uint8Array(4 * N * N);
  r.readRenderTargetPixels(rt, px - 3, py - 3, N, N, buf);
  rt.dispose();
  const patch = [];
  for (let i = 0; i < N * N; i++) patch.push([buf[4 * i], buf[4 * i + 1], buf[4 * i + 2]]);
  return { rgb: patch[(N * N - 1) / 2], patch: patch, inView: Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z < 1 };
};
/* Is a world point behind the piece from the camera (a ray to it hits the
   piece first)? */
window.__hidden = function (id, world) {
  const m = state.models.find(x => x.id === id), mesh = cutMeshOf(m);
  const p = new THREE.Vector3().fromArray(world), o = state.camera.position.clone();
  const rc = new THREE.Raycaster(o, p.clone().sub(o).normalize());
  const hits = rc.intersectObject(mesh, false);
  return hits.length > 0 && hits[0].distance < o.distanceTo(p) - 0.5;
};`;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addScriptTag({ content: STATE });

  const load = async (name, soup) => {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
    return loadSTL(page, stl(name, soup));
  };
  const open = async id => {
    await page.evaluate(() => {
      const e = document.getElementById('cutter-tools');
      for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    });
    if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    // Only this piece on the plate is drawn, so pixels are its own.
    await page.evaluate(id => state.placed.forEach(p => { if (p && p.mesh) p.mesh.visible = p.sourceId === id; }), id);
  };
  const slide = v => page.evaluate(v => {
    const s = document.getElementById('cut-slider'); s.value = String(v); s.dispatchEvent(new Event('input'));
  }, v);
  const typeMm = v => page.evaluate(v => {
    const s = document.getElementById('cut-mm'); s.value = String(v); s.dispatchEvent(new Event('change'));
  }, v);
  const view = id => page.evaluate(id => __bladeView(id), id);

  function blade(label, s) {
    check(label + ': the blade stands on the plane the slider shows', s.offPlane < 1e-4, 'off by ' + s.offPlane.toExponential(1) + ' mm');
    check(label + ': the blade covers the piece\'s bounds across the cut, 1 mm over', s.margin > 1 - 1e-4, 'margin ' + s.margin.toFixed(4) + ' mm');
    check(label + ': sheet and frame are drawn through the piece (no depth test), the sheet translucent',
      s.depth && s.bladeTransparent);
  }
  function plateLine(label, s, wantMm) {
    check(label + ': slider and number box at ' + wantMm.toFixed(1) + ' mm', Math.abs(s.slider - wantMm) < 1e-9 && Math.abs(s.box - wantMm) < 1e-9,
      'slider ' + s.slider + ', box ' + s.box);
    check(label + ': the plate line lies where that plane meets the plate', s.onTrace < 1e-3 && s.yMax < 0.5,
      'centre line ' + s.onTrace.toExponential(1) + ' mm off the plane, highest vertex y ' + s.yMax.toFixed(2));
    check(label + ': it is one kerf wide and spans the piece, 1 mm over each end',
      Math.abs(s.halfWidth - 0.5) < 1e-3 && s.spanLo > 1 - 1e-3 && -s.spanHi > 1 - 1e-3,
      'half width ' + s.halfWidth.toFixed(4) + ', ends ' + s.spanLo.toFixed(3) + ' / ' + (-s.spanHi).toFixed(3) + ' mm past the piece');
  }
  async function ends(label, id) {
    let s = await view(id);
    blade(label, s);
    const span = s.span;
    const lo = 1, hi = Math.floor((span - 1) * 10 + 1e-9) / 10, mid = Math.round(span * 5) / 10;
    await slide(-1e6); s = await view(id); plateLine(label + ', slider at the low end', s, lo); blade(label + ', low end', s);
    await slide(mid); s = await view(id); plateLine(label + ', slider in the middle', s, mid); blade(label + ', middle', s);
    await slide(1e6); s = await view(id); plateLine(label + ', slider at the high end', s, hi); blade(label + ', high end', s);
    const typed = Math.round(span * 3) / 10;
    await typeMm(typed); s = await view(id); plateLine(label + ', ' + typed + ' typed in the mm box', s, typed);
    await slide(mid);
  }

  // Pixels from four cameras round the piece: the plate line's middle and
  // the blade frame's top-edge middle are drawn where the piece covers them,
  // and the sheet changes the piece's colour where it is buried in it.
  async function pixels(label, id) {
    const pts = await page.evaluate(() => {
      const H = state.cutHelper; state.scene.updateMatrixWorld(true);
      const c = H.getObjectByName('cutPlateLine').children.find(o => !o.isMesh);
      const p = c.geometry.attributes.position;
      const a = new THREE.Vector3().fromBufferAttribute(p, 0).applyMatrix4(c.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(p, 1).applyMatrix4(c.matrixWorld);
      const fr = H.children.find(o => o.userData.cutFrame), fp = fr.geometry.attributes.position;
      const f0 = new THREE.Vector3().fromBufferAttribute(fp, 4).applyMatrix4(fr.matrixWorld);
      const f1 = new THREE.Vector3().fromBufferAttribute(fp, 5).applyMatrix4(fr.matrixWorld);
      const sheet = H.children.find(o => o.userData.cutBlade);
      // a point on the sheet a third of the way in from a corner: inside the piece
      const sp = sheet.geometry.attributes.position;
      const s0 = new THREE.Vector3().fromBufferAttribute(sp, 0), s3 = new THREE.Vector3().fromBufferAttribute(sp, 3);
      const sIn = s0.lerp(s3, 0.35).applyMatrix4(sheet.matrixWorld);
      const sn = new THREE.Vector3(0, 0, 1).transformDirection(sheet.matrixWorld);
      return { line: a.lerp(b, 0.5).toArray(), frame: f0.lerp(f1, 0.5).toArray(), sheet: sIn.toArray(), sheetNormal: sn.toArray() };
    });
    const amber = c => c[0] > 180 && c[1] > 130 && c[2] < 120;
    const cams = { 'front, above': [0.55, 0.45, 0.75], 'low, near the plate': [0.8, 0.08, 0.55],
                   'straight down': [0.02, 1.0, 0.02], 'behind, above': [-0.6, 0.5, -0.7] };
    let lineHidden = 0, sheetSeen = 0;
    for (const [cn, c] of Object.entries(cams)) {
      const r = await page.evaluate(([id, c, pts]) => {
        const m = state.models.find(x => x.id === id), mesh = cutMeshOf(m);
        const b = new THREE.Box3().setFromObject(mesh), ctr = b.getCenter(new THREE.Vector3());
        const R = b.getSize(new THREE.Vector3()).length() * 1.3;
        state.controls.target.copy(ctr);
        state.camera.position.set(ctr.x + c[0] * R, ctr.y + c[1] * R, ctr.z + c[2] * R);
        state.controls.update(); state.camera.updateMatrixWorld(true);
        const out = {};
        for (const k of ['line', 'frame', 'sheet']) {
          out[k] = { on: __pixelAt(pts[k], true), off: __pixelAt(pts[k], false), hidden: __hidden(id, pts[k]) };
        }
        // how squarely the camera faces the sheet (0 = edge-on)
        out.facing = Math.abs(new THREE.Vector3().fromArray(pts.sheetNormal)
          .dot(new THREE.Vector3().fromArray(pts.sheet).sub(state.camera.position).normalize()));
        return out;
      }, [id, c, pts]);
      const seen = px => px.inView && px.patch.some(amber);
      check(label + ', ' + cn + ': the plate line is drawn' + (r.line.hidden ? ' through the piece' : ''),
        seen(r.line.on) && !r.line.off.patch.some(amber), 'centre rgb ' + r.line.on.rgb);
      check(label + ', ' + cn + ': the blade\'s frame is drawn' + (r.frame.hidden ? ' through the piece' : ''),
        seen(r.frame.on) && !r.frame.off.patch.some(amber), 'centre rgb ' + r.frame.on.rgb);
      if (r.line.hidden || r.frame.hidden) lineHidden++;
      if (r.sheet.hidden && r.sheet.on.inView && r.facing > 0.25) {
        sheetSeen++;
        const d = r.sheet.off.rgb.map((v, i) => Math.abs(v - r.sheet.on.rgb[i])).reduce((a, b) => a + b, 0);
        check(label + ', ' + cn + ': the sheet tints the piece where it is buried in it', d > 30,
          'piece ' + r.sheet.off.rgb + ' -> with blade ' + r.sheet.on.rgb);
      }
    }
    check(label + ': at least one camera had the line or frame behind the piece (so the pixels prove "through")', lineHidden > 0);
    check(label + ': at least one camera had the sheet buried in the piece', sheetSeen > 0);
  }

  console.log('\n=== 1. a tall piece: 40 x 30 x 140 ===');
  const tall = await load('tall.stl', bar(40, 30, 140));
  await open(tall);
  // Square across the longest dimension, the Cut card's default cut on this
  // piece is horizontal (to length; wire:cut-redesign section 2), and a
  // horizontal plane never meets the plate. This section is about a blade
  // standing up through a tall piece, so it locks the cut to plate X.
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });
  await ends('tall', tall);
  await pixels('tall', tall);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  console.log('\n=== 2. a wide piece: 160 x 140 x 15 ===');
  const wide = await load('wide.stl', bar(160, 140, 15));
  await open(wide);
  await ends('wide', wide);
  await pixels('wide', wide);

  console.log('\n=== 3. a turned piece: 60 x 12 x 30, turned 15 deg by the cutter\'s own yaw ===');
  // The yaw turns the geometry itself (the piece is shown as the cutter's
  // preview), so the cut runs along the plate's X across a turned section.
  const turned = await load('turned.stl', bar(60, 12, 30));
  await open(turned);
  await page.evaluate(() => rotateActiveModelY(-15));   // the yaw the Cut card's ⟲ 15 made
  let s = await view(turned);
  const want15 = 60 * Math.cos(Math.PI / 12) + 12 * Math.sin(Math.PI / 12);
  check('turned 15 deg: the cut runs along X over the turned bar, span ' + want15.toFixed(2),
    s.axis === 'x' && Math.abs(s.span - want15) < 1e-3, s.axis + ' ' + s.span);
  await ends('turned 15 deg', turned);
  await pixels('turned 15 deg', turned);

  console.log('\n=== 3b. a quarter-turned piece: 60 x 12 x 30, Rotate 90 (the plate axis lands on its own Z) ===');
  const quarter = await load('quarter.stl', bar(60, 12, 30));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rotateSelected(1); }, quarter);
  await open(quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  s = await view(quarter);
  check('turned 90 deg, Cut X: the cut runs along the bar\'s own Z, span 12', s.axis === 'z' && Math.abs(s.span - 12) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned 90 deg, Cut X', quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'z'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut Z is gone)
  s = await view(quarter);
  check('turned 90 deg, Cut Z: the cut runs along the bar\'s own X, span 60', s.axis === 'x' && Math.abs(s.span - 60) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned 90 deg, Cut Z', quarter);
  await pixels('turned 90 deg', quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  console.log('\n=== 3c. a rolled piece: 60 x 12 x 30 on its side, Cut X (the cut runs along its own Y) ===');
  const rolled = await load('rolled.stl', bar(60, 12, 30));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rollSelected(); }, rolled);
  await open(rolled);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  s = await view(rolled);
  check('rolled, Cut X: the cut runs along the bar\'s own Y', s.axis === 'y', s.axis + ' ' + s.span);
  await ends('rolled, Cut X', rolled);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  console.log('\n=== 4. a piece cut once: 300 x 20 x 40 bar, split at 100 mm, then the long piece ===');
  const long = await load('long.stl', bar(300, 20, 40));
  await open(long);
  await typeMm(100);
  const made = await page.evaluate(() => {
    const before = state.models.map(m => m.id);
    document.getElementById('btn-cut').click();
    return state.models.filter(m => !before.includes(m.id)).map(m => ({ id: m.id, x: m.size.x }));
  });
  check('Split made two pieces', made.length === 2, JSON.stringify(made));
  const big = made.sort((p, q) => q.x - p.x)[0].id;
  await open(big);
  s = await view(big);
  check('the long piece left by the cut is about 200 mm', Math.abs(s.span - 200) < 1.5, String(s.span));
  await ends('cut once', big);
  await pixels('cut once', big);

  console.log('\n=== 5. x-ray on and off leaves the blade and plate line as they are ===');
  const xray = () => page.evaluate(() => document.getElementById('btn-xray').click());
  await xray(); await xray();
  s = await view(big);
  check('after x-ray on and off: still drawn through the piece, the sheet still translucent', s.depth && s.bladeTransparent);
  await xray();
  s = await view(big);
  check('with x-ray on: likewise', s.depth && s.bladeTransparent && await page.evaluate(() => state.xray === true));
  await xray();

  console.log('\n=== 6. the plate line is never picked: a click on it, off the blade, does not start a drag ===');
  const picked = await page.evaluate(() => {
    const H = state.cutHelper, rc = new THREE.Raycaster();
    const pl = H.getObjectByName('cutPlateLine');
    state.scene.updateMatrixWorld(true);
    // aim straight down at the middle of the line, from above the plate
    const c = pl.children.find(o => !o.isMesh), p = c.geometry.attributes.position;
    const mid = new THREE.Vector3().fromBufferAttribute(p, 0).lerp(new THREE.Vector3().fromBufferAttribute(p, 1), 0.5).applyMatrix4(c.matrixWorld);
    rc.set(mid.clone().add(new THREE.Vector3(0.2, 50, 0.2)), new THREE.Vector3(0, -1, 0));
    return rc.intersectObject(pl, true).length;
  });
  check('the plate line answers no ray', picked === 0, picked + ' hits');

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

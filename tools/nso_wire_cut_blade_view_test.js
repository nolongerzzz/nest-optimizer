/* The cutter's blade can be seen whole, through the piece, and carries a ball
   on its top end to take hold of - on a tall piece, a wide piece, a turned
   piece and a piece already cut once. (The plate line that used to mark the cut
   on the plate is gone: it floated off wherever the blade lay near-flat.)
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
   - A TAB at the blade's front-left top corner (cutPlaceBall): a flat bar in the
     blade's plane running straight out along the top edge (its upper edge in line
     with the blade's), a ball on its centreline at the end, and ONE yellow outline -
     the frame's - on from the blade's top edge along the bar, round the ball and back
     along the bar's lower edge to the blade. The fill is the blade's own stuff (the
     sheet's colour and translucency); all of it is drawn through the piece like the
     rest, and pickable - the place to take hold of a thin blade. No plate line.
   - The x-ray view leaves all of it alone (it rewrites depth settings on
     whatever it walks, which would bring the opaque slab back).

   Real app. Each case checks, in the piece's own frame: the blade's corners
   stand on the plane and cover the piece's bounds across the cut. At the
   slider's low end, middle and high end (and a typed mm): the slider and the
   box say the same number, and the ball stands on that plane, on the blade's
   top end. Then pixels, from four cameras: the ball and the blade's frame show
   where the piece covers them, and the sheet tints the piece where it is
   buried in it.                                                            */

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

/* What the blade and its ball draw, read off their geometry, against the
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
  /* In the CUT frame: the piece's own turned by f.turn (a mitre, a bevel, or
     the base turn that squares the blade to a turned piece's length - every
     pose is baked into the geometry now, so a turned piece is turned in its
     own frame). Square on a piece lying square, f.turn is null and the cut
     frame is the piece's own, as before. */
  const T = f.turn || new THREE.Matrix4(), B = f.back || new THREE.Matrix4();
  const cb = getCutPlaneLocal(m).bbox;
  const bladeLocal = verts(blade).concat(verts(frame)).map(v => v.applyMatrix4(toLocal).applyMatrix4(T));
  const offPlane = Math.max(...bladeLocal.map(v => Math.abs(v[k] - plane)));
  const margin = Math.min(...across.map(a => Math.min(cb.min[a] - Math.min(...bladeLocal.map(v => v[a])),
                                                     Math.max(...bladeLocal.map(v => v[a])) - cb.max[a])));
  // The ball on the blade's top end: on the blade's plane, and above the highest of the blade's corners.
  const ball = H.children.find(c => c.userData.cutBall);
  const bp = new THREE.Vector3().setFromMatrixPosition(ball.matrixWorld);
  const ballLocal = bp.clone().applyMatrix4(toLocal).applyMatrix4(T);
  const ballOffPlane = Math.abs(ballLocal[k] - plane);
  const bladeTopY = Math.max(...verts(blade).concat(verts(frame)).map(v => v.y));
  // The tab: a flat bar and a ball with ONE outline (the frame's yellow) that begins on the blade's top corner, runs out along the top edge,
  // round the ball and back along the bar's lower edge to the blade's side edge. The corner is the front-left one (the home view's
  // toward-the-viewer and left), the better of the two ends of the top edge by that measure.
  const bar = H.children.find(c => c.userData.cutBar), ol = H.children.find(c => c.userData.cutBallOutline);
  bar.updateMatrixWorld(true); ol.updateMatrixWorld(true);
  const op = ol.geometry.attributes.position, opts = [];
  for (let i = 0; i < op.count; i++) opts.push(new THREE.Vector3().fromBufferAttribute(op, i).applyMatrix4(ol.matrixWorld));
  const fv = verts(frame), maxY = Math.max(...fv.map(v => v.y)), topC = [];
  fv.forEach(v => { if (v.y >= maxY - 1e-6 && !topC.some(t => t.distanceTo(v) < 1e-6)) topC.push(v); });
  const nearC = p => Math.min(...topC.map(t => t.distanceTo(p)));
  const p0 = opts[0], p1 = opts[1], pEnd = opts[opts.length - 1];
  const chosen = topC.slice().sort((p, q) => p.distanceTo(p0) - q.distanceTo(p0))[0];
  const other = topC.find(t => t !== chosen);
  const bc = new THREE.Box3().setFromObject(blade).getCenter(new THREE.Vector3()), ref = new THREE.Vector3(-0.5, 0, 1).normalize();
  const frontLeftOk = topC.length < 2 || chosen.clone().sub(bc).dot(ref) >= Math.max(...topC.map(t => t.clone().sub(bc).dot(ref))) - 1e-6;
  // the outline starts on the blade's corner, its first run is the blade's own top edge carried on outward (collinear, same sense), and
  // it comes back to the blade's edge 3 mm below the top
  const edgeDir = other ? chosen.clone().sub(other).normalize() : null;
  const runDir = p1.clone().sub(p0).normalize();
  const flush = other ? { straight: new THREE.Vector3().crossVectors(edgeDir, runDir).length(), same: edgeDir.dot(runDir), level: Math.abs(p1.y - p0.y) } : null;
  const drop = p0.y - pEnd.y;
  const arc = opts.slice(2, opts.length - 2), bp0 = new THREE.Vector3().setFromMatrixPosition(ball.matrixWorld);
  const arcOnBall = Math.max(...arc.map(p => Math.abs(p.distanceTo(bp0) - ball.geometry.parameters.radius)));
  // the bar is a flat box in the plane: thin across it, as wide as the outline's drop, its upper edge at the blade's top edge
  const bs = new THREE.Vector3().setFromMatrixScale(bar.matrixWorld);
  const barTop = Math.max(...[-0.5, 0.5].map(sx => new THREE.Vector3(sx, 0.5, 0).applyMatrix4(bar.matrixWorld).y));
  const barFlat = bar.geometry.type === 'BoxGeometry' && bar.scale.z <= 1.2 && Math.abs(bar.scale.y - 3) < 1e-9 && Math.abs(barTop - bladeTopY) < 1e-3;
  const ballOut = Math.max(...topC.map(t => t.distanceTo(bp0)));        // the ball stands out past the corner, not on the blade
  const outlineAtCorner = nearC(p0), outlineIsFrame = ol.material.color.getHex() === frame.material.color.getHex();
  const sameStuff = [ball, bar].every(o => o.material.color.getHex() === blade.material.color.getHex() && o.material.opacity === blade.material.opacity && o.material.transparent === true) && ball.material.color.getHex() !== frame.material.color.getHex();
  const depth = [blade, frame, ball, bar, ol].every(o => o.material.depthTest === false && o.material.depthWrite === false);
  return { axis: k, span: f.span, slider: slider, box: Number(document.getElementById('cut-mm').value),
           offPlane: offPlane, margin: margin, depth: depth,
           ballOffPlane: ballOffPlane, ballAbove: bp.y - bladeTopY, ballPickable: ball.userData.cutHandle === true,
           ballRadius: ball.geometry.parameters.radius, sameStuff: sameStuff, outlineAtCorner: outlineAtCorner, outlineIsFrame: outlineIsFrame, flush: flush, drop: drop, arcOnBall: arcOnBall, barFlat: barFlat, frontLeftOk: frontLeftOk, topCorners: topC.length, ballOut: ballOut, noPlateLine: !H.getObjectByName('cutPlateLine') && H.userData.plateLine === undefined,
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
    check(label + ': sheet, frame and ball are drawn through the piece (no depth test), the sheet translucent',
      s.depth && s.bladeTransparent);
    check(label + ': the ball stands on the blade\'s plane, on the flat bar\'s centreline (1.5 mm under the top edge), and can be picked',
      s.ballOffPlane < 1e-4 && Math.abs(s.ballAbove + 1.5) < 1e-3 && s.ballPickable && Math.abs(s.ballRadius - 2.4) < 1e-9,
      'off plane ' + s.ballOffPlane.toExponential(1) + ', ' + s.ballAbove.toFixed(4) + ' mm from the top edge');
    check(label + ': the bar is FLAT (a thin box in the blade\'s plane, 3 mm wide), its upper edge at the blade\'s top edge',
      s.barFlat, 'flat ' + s.barFlat);
    check(label + ': one outline starts on the blade\'s top corner and its first run is the blade\'s own top edge carried straight on outward',
      s.outlineAtCorner < 1e-3 && (!s.flush || (s.flush.straight < 1e-4 && s.flush.same > 0.9999 && s.flush.level < 1e-4)),
      'start ' + s.outlineAtCorner.toExponential(1) + ' from the corner' + (s.flush ? ', off the edge line ' + s.flush.straight.toExponential(1) + ', level ' + s.flush.level.toExponential(1) : ''));
    check(label + ': it goes round the ball (every point of the arc on the ball\'s circle), comes back along the bar\'s lower edge and ends on the blade\'s edge 3 mm down',
      s.arcOnBall < 1e-3 && Math.abs(s.drop - 3) < 1e-3 && s.ballOut > 6, 'arc off the ball ' + s.arcOnBall.toExponential(1) + ', drop ' + s.drop.toFixed(3) + ', ball ' + s.ballOut.toFixed(1) + ' mm out');
    check(label + ': the outline is the frame\'s yellow; ball and bar are the blade\'s own stuff - the sheet\'s colour and translucency', s.outlineIsFrame && s.sameStuff);
    check(label + ': it is the front-left top corner (toward the home view\'s viewer and left)', s.frontLeftOk, s.topCorners + ' top corners');
    check(label + ': there is no plate line', s.noPlateLine);
  }
  function sliderAt(label, s, wantMm) {
    check(label + ': slider and number box at ' + wantMm.toFixed(1) + ' mm', Math.abs(s.slider - wantMm) < 1e-9 && Math.abs(s.box - wantMm) < 1e-9,
      'slider ' + s.slider + ', box ' + s.box);
  }
  async function ends(label, id) {
    let s = await view(id);
    blade(label, s);
    const span = s.span;
    const lo = 1, hi = Math.floor((span - 1) * 10 + 1e-9) / 10, mid = Math.round(span * 5) / 10;
    await slide(-1e6); s = await view(id); sliderAt(label + ', slider at the low end', s, lo); blade(label + ', low end', s);
    await slide(mid); s = await view(id); sliderAt(label + ', slider in the middle', s, mid); blade(label + ', middle', s);
    await slide(1e6); s = await view(id); sliderAt(label + ', slider at the high end', s, hi); blade(label + ', high end', s);
    const typed = Math.round(span * 3) / 10;
    await typeMm(typed); s = await view(id); sliderAt(label + ', ' + typed + ' typed in the mm box', s, typed);
    await slide(mid);
  }

  // Pixels from four cameras round the piece: the ball's middle and
  // the blade frame's top-edge middle are drawn where the piece covers them,
  // and the sheet changes the piece's colour where it is buried in it.
  async function pixels(label, id) {
    const pts = await page.evaluate(() => {
      const H = state.cutHelper; state.scene.updateMatrixWorld(true);
      const ballPos = new THREE.Vector3().setFromMatrixPosition(H.children.find(o => o.userData.cutBall).matrixWorld);
      const fr = H.children.find(o => o.userData.cutFrame), fp = fr.geometry.attributes.position;
      const f0 = new THREE.Vector3().fromBufferAttribute(fp, 4).applyMatrix4(fr.matrixWorld);
      const f1 = new THREE.Vector3().fromBufferAttribute(fp, 5).applyMatrix4(fr.matrixWorld);
      const sheet = H.children.find(o => o.userData.cutBlade);
      // a point on the sheet a third of the way in from a corner: inside the piece
      const sp = sheet.geometry.attributes.position;
      const s0 = new THREE.Vector3().fromBufferAttribute(sp, 0), s3 = new THREE.Vector3().fromBufferAttribute(sp, 3);
      const sIn = s0.lerp(s3, 0.35).applyMatrix4(sheet.matrixWorld);
      const sn = new THREE.Vector3(0, 0, 1).transformDirection(sheet.matrixWorld);
      return { line: ballPos.toArray(), frame: f0.lerp(f1, 0.5).toArray(), sheet: sIn.toArray(), sheetNormal: sn.toArray() };
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
      // The ball is the sheet's dark translucent stuff, so it is judged by what it does to the pixel at its centre: the pixel is not what it
      // is without the helper (over a pink piece a lot, over the dark plate a little); a ball off the top of the picture - the top of a
      // 140 mm piece from a low camera - is not judged.
      const dBall = r.line.off.rgb.map((v, i) => Math.abs(v - r.line.on.rgb[i])).reduce((a, b) => a + b, 0);
      check(label + ', ' + cn + ': the ball is drawn' + (r.line.hidden ? ' through the piece' : ''),
        !r.line.on.inView || dBall > 6, 'centre rgb ' + r.line.on.rgb + ' (without the helper ' + r.line.off.rgb + ')');
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
    check(label + ': drawn through the piece - a camera had the ball or frame behind it, or the sheet buried in it', lineHidden > 0 || sheetSeen > 0);
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
  /* re-pinned (pose-bake): was span 60 cos 15 + 12 sin 15 = 61.06 along the
     plate's X, across the turned section. The square blade now stands across
     the piece's length AS IT LIES (pieceFrame): it travels the bar's own 60,
     the local x turned 15 degrees by the cut frame's base */
  const want15 = 60;
  check('turned 15 deg: the cut runs along the turned bar\'s own length, span ' + want15.toFixed(2),
    s.axis === 'x' && Math.abs(s.span - want15) < 1e-3, s.axis + ' ' + s.span);
  await ends('turned 15 deg', turned);
  await pixels('turned 15 deg', turned);

  console.log('\n=== 3b. a quarter-turned piece: 60 x 12 x 30, Rotate 90 (the plate axis lands on its own Z) ===');
  const quarter = await load('quarter.stl', bar(60, 12, 30));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rotateSelected(1); }, quarter);
  await open(quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  s = await view(quarter);
  /* re-pinned (pose-bake): the axis letter was the bar's own 'z' / 'x' / 'y'
     (the pose on its mesh); the quarter turn is baked into the geometry now,
     so the mesh's own axes are the plate's and the same plane is named by the
     plate axis - the spans are the same 12 / 60 / 30 */
  check('turned 90 deg, Cut X: the cut runs across the bar, span 12', s.axis === 'x' && Math.abs(s.span - 12) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned 90 deg, Cut X', quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'z'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut Z is gone)
  s = await view(quarter);
  check('turned 90 deg, Cut Z: the cut runs along the bar\'s length, span 60', s.axis === 'z' && Math.abs(s.span - 60) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned 90 deg, Cut Z', quarter);
  await pixels('turned 90 deg', quarter);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  console.log('\n=== 3c. a rolled piece: 60 x 12 x 30 on its side, Cut X (the cut runs along its own Y) ===');
  const rolled = await load('rolled.stl', bar(60, 12, 30));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rollSelected(); }, rolled);
  await open(rolled);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  s = await view(rolled);
  check('rolled, Cut X: the cut runs along the plate\'s X - the bar\'s own Y, baked - span 30', s.axis === 'x' && Math.abs(s.span - 30) < 1e-4, s.axis + ' ' + s.span);
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

  console.log('\n=== 5. x-ray on and off leaves the blade and its ball as they are ===');
  const xray = () => page.evaluate(() => document.getElementById('btn-xray').click());
  await xray(); await xray();
  s = await view(big);
  check('after x-ray on and off: still drawn through the piece, the sheet still translucent', s.depth && s.bladeTransparent);
  await xray();
  s = await view(big);
  check('with x-ray on: likewise', s.depth && s.bladeTransparent && await page.evaluate(() => state.xray === true));
  await xray();

  console.log('\n=== 6. the tab is the place to grab: a ray at the ball or the bar hits it, and both are drag handles ===');
  const grabbed = await page.evaluate(() => {
    const H = state.cutHelper, ball = H.children.find(c => c.userData.cutBall), bar = H.children.find(c => c.userData.cutBar), rc = new THREE.Raycaster();
    state.scene.updateMatrixWorld(true);
    const aimDown = o => { const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); rc.set(p.clone().add(new THREE.Vector3(0.3, 50, 0.3)), new THREE.Vector3(0, -1, 0)); return rc.intersectObject(H, true); };
    const isTab = h => h && h.object.userData && (h.object.userData.cutBall || h.object.userData.cutBar || h.object.userData.cutBallOutline);
    const hb = aimDown(ball), hr = aimDown(bar);
    return { ball: { n: hb.length, tab: !!isTab(hb[0]), handle: !!(hb[0] && hb[0].object.userData.cutHandle), ballAmong: hb.some(h => h.object.userData.cutBall) },
             bar: { n: hr.length, tab: !!isTab(hr[0]), handle: !!(hr[0] && hr[0].object.userData.cutHandle) } };
  });
  check('a ray straight down at the ball hits the tab first (the ball or its outline), the ball is among the hits, and it is a cut handle', grabbed.ball.n > 0 && grabbed.ball.tab && grabbed.ball.ballAmong && grabbed.ball.handle, JSON.stringify(grabbed.ball));
  check('a ray straight down at the bar hits the tab and it is a cut handle', grabbed.bar.n > 0 && grabbed.bar.tab && grabbed.bar.handle, JSON.stringify(grabbed.bar));
  check('there is no plate line object anywhere in the helper', await page.evaluate(() => { let n = 0; state.cutHelper.traverse(o => { if (o.name === 'cutPlateLine' || (o.userData && (o.userData.cutPlateLine || o.userData.plateLine))) n++; }); return n === 0; }));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

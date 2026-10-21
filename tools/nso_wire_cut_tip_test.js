/* A piece posed on the plate (Tip on side, Stand, Flip, Tip on face, the
   four Tilts) is cut where the blade and the plate line show it, and each
   half lands turned as it was cut - on a round tube and on a square bar,
   both loaded from STL, at quarter turns and at 15 / 30 degree tilts.
     node tools/nso_wire_cut_tip_test.js        exit 0 = every gate held

   THE REPORT. "Tip and Flip turn the preview, not the piece Split cuts": a
   tipped tube cut on X came out slanted while Cut Z was clean, and a square
   bar cut normal. The suspicion was the one #161 fixed for the Cut panel's
   yaw buttons - the pose turning the display geometry and not the raw
   triangles Split cuts.

   POSE-BAKE (2026-10-21). Every pose action is now baked into the geometry
   when it ends (app-core.js nsoBakePlacedPose): m.rawTris and m.geometry are
   turned together, the mesh goes back to identity and the fields to 0. So
   "the pose is on the mesh" below is history; what this check holds is
   unchanged and measured the same way - the raw triple still maps onto the
   display geometry exactly, and the blade, the plate line, the cut and the
   halves still agree in world space.

   WHAT THIS TREE DID (measured here, not assumed). The pose buttons did not
   touch the piece's geometry at all. Tip on side, Stand, Flip and Tip on
   face write the placed record's pose (app-tip-orient.js setOrientFromQuat),
   the Tilts turn it through nsoRotate.turn, and applyMeshRotation puts that
   pose on the placed MESH. m.geometry and m.rawTris are never rewritten, so
   the raw triple still maps onto the display geometry exactly. The cutter
   reads the pose off that mesh (cutFrame): the blade is the plane across
   the piece's OWN axis nearest the plate axis, drawn through the mesh's
   world transform, and Split cuts that same plane in the piece's own frame
   (mapPlaneToRaw). So on a tilted piece the blade tilts with it: Cut X on a
   tube tilted about Z stands 15 degrees off vertical and cuts the tube
   square to its own length; Cut Z, across the tilt axis, stays upright.
   That is "Cut X slanted, Cut Z clean" - the blade, the plate line and the
   cut all agree on it.

   This check pins that down so a later change to the pose path cannot split
   them apart. It was run against two deliberately broken trees, each a
   change to app-tip-orient.js turnBy (Tip on side, Stand, Flip, Tip on
   face), and fails on both, on both pieces, with every un-posed case still
   passing:
     - the turn put into m.geometry and not m.rawTris (#161's yaw defect,
       moved onto Tip): 94 failures, 57 on the bar and 37 on the tube;
     - the pose kept on the mesh AND the same turn put into m.rawTris (a
       #161-style raw turn where no display turn happens): 92 failures, 55
       on the bar and 37 on the tube. A pose is not in the display geometry,
       so turning the raw triangles by it applies it twice.

   GATES, through the real pose buttons (Tip on face through the function
   its click calls, on a real raycast hit) and the real Split, for each
   piece, each pose (un-posed included) and Cut X and Cut Z, with the red
   line put 37 % of the way along, off-centre, so a sign error cannot hide
   behind symmetry:
     - the pose is on the mesh, and the raw triple mapped onto the display
       frame is the display geometry (what Split cuts is what is shown);
     - the plate line runs across the blade's normal;
     - each half's cut face, in world space, lies on the blade's plane (a
       clean split since #166: no kerf, the faces meet), the two halves
       running to opposite ends and meeting there, within the plate line's
       length;
     - each cut face is the whole section of the piece on that plane
       (measured independently, by slicing the display geometry there), so
       a mitred or partial face fails;
     - each half runs out to its own end of the piece;
     - on the plate, each half is the cut half turned exactly as the piece
       was (same mesh rotation, same world size), moved only along the plate
       axis by half the split view gap, away from the other half.        */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

// 60 mm long along file X: a round tube (20 OD, 14 ID, 48 facets) and a
// 12 x 8 bar. Both closed, faces outward.
function tube(L, R, r, n) {
  const o = [];
  const P = (x, a, rad) => [x, rad * Math.cos(a), rad * Math.sin(a)];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < n; i++) {
    const a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n;
    q(P(0, a0, R), P(0, a1, R), P(L, a1, R), P(L, a0, R));
    q(P(0, a0, r), P(L, a0, r), P(L, a1, r), P(0, a1, r));
    q(P(0, a0, r), P(0, a1, r), P(0, a1, R), P(0, a0, R));
    q(P(L, a0, r), P(L, a0, R), P(L, a1, R), P(L, a1, r));
  }
  return o;
}
function bar(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-tip-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const PAGE = `
/* The raw triple mapped onto the display frame ((x, z, -y) less
   centerOffset), against the display geometry, vertex by vertex. */
window.__rawVsDisplay = function (id) {
  const m = state.models.find(x => x.id === id);
  if (!m.rawTris) return null;
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  const p = g.attributes.position.array, r = m.rawTris, o = m.centerOffset;
  if (p.length !== r.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < r.length; i += 3) {
    worst = Math.max(worst, Math.abs(r[i] - o.x - p[i]), Math.abs(r[i + 2] - o.y - p[i + 1]),
                     Math.abs(-r[i + 1] - o.z - p[i + 2]));
  }
  return worst;
};
window.__placedOf = id => state.placed.find(p => p && p.sourceId === id);
/* The pose is read off the piece's BODY (nsoPieceBodyQ): every pose action is
   baked into the geometry when it ends (pose-bake), so the mesh is back at
   identity and the turn is in m.geometry and m.rawTris together. */
window.__pose = function (id) {
  const p = __placedOf(id);
  p.mesh.updateMatrixWorld(true);
  return { q: nsoPieceBodyQ(p).toArray(), meshQ: p.mesh.quaternion.toArray(),
           status: document.getElementById('status').textContent };
};
/* Tip on face, through the function its armed click calls, on a real hit:
   a ray at the piece's world centre from above, leaned 'lean' degrees
   toward +X, so on the tube it lands on a facet off the top. */
window.__tipOnFace = function (id, lean) {
  const p = __placedOf(id);
  p.mesh.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
  const a = lean * Math.PI / 180;
  const d = new THREE.Vector3(-Math.sin(a), -Math.cos(a), 0);
  const ray = new THREE.Raycaster(c.clone().addScaledVector(d, -200), d);
  const hit = ray.intersectObject(p.mesh, false)[0];
  if (!hit) return false;
  selectPlaced(state.placed.indexOf(p));
  return nsoTipOrient.tipOnFaceFromHit(hit);
};
/* The net area of the section of geometry 'geo' (its own frame) by the
   plane coord[axis] = v: each triangle crossing it gives one segment,
   directed by the triangle's winding, and the shoelace of all of them is
   the section's area - independent of what Split made. */
window.__sectionArea = function (geo, axis, v) {
  const k = { x: 0, y: 1, z: 2 }[axis], u = (k + 1) % 3, w = (k + 2) % 3;
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  let area = 0;
  for (let t = 0; t < p.length; t += 9) {
    const V = [0, 1, 2].map(i => [p[t + 3 * i], p[t + 3 * i + 1], p[t + 3 * i + 2]]);
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const A = V[e], B = V[(e + 1) % 3], da = A[k] - v, db = B[k] - v;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const s = da / (da - db);
        pts.push([A[u] + s * (B[u] - A[u]), A[w] + s * (B[w] - A[w])]);
      }
    }
    if (pts.length !== 2) continue;
    // orient: (b - a) along normal x plane-normal
    const e1 = [0, 1, 2].map(i => V[1][i] - V[0][i]), e2 = [0, 1, 2].map(i => V[2][i] - V[0][i]);
    const N = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dir = [N[w], -N[u]];        // (N x e_k) in the (u, w) plane, up to sign
    let [a, b] = pts;
    if ((b[0] - a[0]) * dir[0] + (b[1] - a[1]) * dir[1] < 0) [a, b] = [b, a];
    area += (a[0] * b[1] - b[0] * a[1]) / 2;
  }
  return Math.abs(area);
};
/* Split through the real button; the two halves as Split made them (before
   they are centred and laid out) and as they then sit on the plate, with the
   blade and the plate line as they stood. Everything in world space. */
window.__splitAndMeasure = function (id) {
  const m = state.models.find(x => x.id === id);
  const mesh = cutMeshOf(m);
  state.scene.updateMatrixWorld(true);
  const Mw = mesh.matrixWorld.clone();
  const qSrc = mesh.quaternion.clone();
  const info = getCutPlaneLocal(m);
  const blade = state.cutHelper.children.find(c => c.userData.cutBlade);
  const P = new THREE.Vector3().setFromMatrixPosition(blade.matrixWorld);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(blade.matrixWorld);
  const pl = state.cutHelper.userData.plateLine;
  const la = new THREE.Vector3().fromArray(pl.a), lb = new THREE.Vector3().fromArray(pl.b);
  const across = new THREE.Vector3().fromArray(pl.across);
  const ldir = lb.clone().sub(la); ldir.y = 0; const llen = ldir.length(); ldir.normalize();
  // the blade's normal, carried back into the piece's own frame: which of its
  // axes it is, and with which sign, so a face's world offset maps to a plane
  const nLocal = n.clone().transformDirection(new THREE.Matrix4().copy(Mw).invert());
  const sign = nLocal[info.axis] >= 0 ? 1 : -1;
  const section = s => __sectionArea(m.geometry, info.axis, info.plane + sign * s);
  const gp = m.geometry.attributes.position, v = new THREE.Vector3();
  let pLo = Infinity, pHi = -Infinity;
  for (let i = 0; i < gp.count; i++) {
    const s = v.fromBufferAttribute(gp, i).applyMatrix4(Mw).sub(P).dot(n);
    pLo = Math.min(pLo, s); pHi = Math.max(pHi, s);
  }
  let got = null;
  const orig = window.splitBothSides;
  window.splitBothSides = function () {
    const r = orig.apply(this, arguments);
    got = { left: r.left.clone(), right: r.right.clone(), engine: r.engine };
    return r;
  };
  const before = state.models.map(x => x.id);
  try { document.getElementById('btn-cut').click(); } finally { window.splitBothSides = orig; }
  const status = document.getElementById('status').textContent;
  if (!got) return { status: status };
  const half = (geo, Mx) => {
    const p = geo.attributes.position, w = [];
    for (let i = 0; i < p.count; i++) w.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(Mx));
    let lo = Infinity, hi = -Infinity;
    w.forEach(q => { const s = q.clone().sub(P).dot(n); lo = Math.min(lo, s); hi = Math.max(hi, s); });
    // The cut face: the triangles flat on a plane parallel to the blade,
    // nearest the blade. Its offset, area and reach along the plate line.
    const faces = new Map();
    for (let t = 0; t < w.length; t += 3) {
      const s = [0, 1, 2].map(k => w[t + k].clone().sub(P).dot(n));
      if (Math.max(...s) - Math.min(...s) > 1e-3) continue;
      const key = (Math.round(s[0] * 100) / 100).toFixed(2);
      const f = faces.get(key) || { s: 0, area: 0, n: 0, lineLo: Infinity, lineHi: -Infinity };
      f.s = (f.s * f.n + s[0]) / (f.n + 1); f.n++;
      f.area += new THREE.Vector3().subVectors(w[t + 1], w[t]).cross(new THREE.Vector3().subVectors(w[t + 2], w[t])).length() / 2;
      for (let k = 0; k < 3; k++) {
        const d = w[t + k].clone().sub(la); d.y = 0;
        const u = d.dot(ldir);
        f.lineLo = Math.min(f.lineLo, u); f.lineHi = Math.max(f.lineHi, u);
      }
      faces.set(key, f);
    }
    const face = [...faces.values()].sort((a, b) => Math.abs(a.s) - Math.abs(b.s))[0] || null;
    if (face) face.want = section(face.s);
    const box = new THREE.Box3().setFromPoints(w);
    return { lo: lo, hi: hi, face: face, size: box.getSize(new THREE.Vector3()).toArray(),
             centre: box.getCenter(new THREE.Vector3()).toArray() };
  };
  const fresh = state.models.filter(x => !before.includes(x.id));
  const onPlate = name => {
    const mm = fresh.find(x => new RegExp('-' + name + '\\\\d+$').test(x.name));
    const e = mm && state.placed.find(p => p && p.sourceId === mm.id);
    if (!e) return null;
    e.mesh.updateMatrixWorld(true);
    const r = half(e.mesh.geometry, e.mesh.matrixWorld);
    r.turn = 2 * Math.acos(Math.min(1, Math.abs(e.mesh.quaternion.dot(qSrc)))) * 180 / Math.PI;
    return r;
  };
  return { status: status, engine: got.engine, kerf: KERF_MM, gap: SPLIT_VIEW_GAP_MM,
           axis: info.axis, plateAxis: info.plateAxis,
           n: n.toArray(), across: across.toArray(), lineLen: llen, pLo: pLo, pHi: pHi,
           left: half(got.left, Mw), right: half(got.right, Mw), plateA: onPlate('A'), plateB: onPlate('B') };
};`;

// Each pose: the buttons pressed in order; 'face:<lean>' is Tip on face.
const POSES = [
  ['un-posed', []],
  ['Tip on side', ['#btn-flip']],
  ['Tip on side, Tilt ↑ 15', ['#btn-flip', '#btn-tilt-up']],
  ['Tip on side, Tilt → 30', ['#btn-flip', '#btn-bank-up', '#btn-bank-up']],
  ['Stand, Tilt ← 15', ['#btn-tip', '#btn-bank-dn']],
  ['Flip, Tilt ↓ 15', ['#btn-flip-over', '#btn-tilt-dn']],
  ['Tilt → 15, Tip on face', ['#btn-bank-up', 'face:35']]
];

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const PIECES = [['tube', stl('tube.stl', tube(60, 10, 7, 48))], ['bar', stl('bar.stl', bar(60, 12, 8))]];

  const select = id => page.evaluate(id => selectPlaced(state.placed.indexOf(__placedOf(id))), id);
  const openCutter = async id => {
    if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
    await select(id);
  };

  async function run(piece, file, poseName, presses, cut) {
    const label = piece + ', ' + poseName + ', Cut ' + cut.toUpperCase();
    console.log('\n=== ' + label + ' ===');
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
    const id = await loadSTL(page, file);
    await select(id);
    const q0 = (await page.evaluate(id => __pose(id), id)).q;
    for (const b of presses) {
      if (b.startsWith('face:')) {
        const ok = await page.evaluate(([id, lean]) => __tipOnFace(id, lean), [id, +b.slice(5)]);
        check(label + ': Tip on face took the face clicked', ok);
      } else {
        await page.click(b);
      }
    }
    const pose = await page.evaluate(id => __pose(id), id);
    const turned = 2 * Math.acos(Math.min(1, Math.abs(q0.reduce((s, v, i) => s + v * pose.q[i], 0)))) * 180 / Math.PI;
    /* re-pinned (pose-bake): was "the pose is on the piece" read off the MESH;
       the pose is baked now - the body turned, the mesh back at identity */
    check(label + ': ' + (presses.length ? 'the pose is baked into the piece - its body turned, its mesh at identity' : 'the piece is un-posed'),
      (presses.length ? turned > 1 : turned < 1e-6) && Math.abs(Math.abs(pose.meshQ[3]) - 1) < 1e-12,
      'turned ' + turned.toFixed(2) + ' deg, mesh w ' + pose.meshQ[3] + '; ' + pose.status);
    const d = await page.evaluate(id => __rawVsDisplay(id), id);
    check(label + ': the raw triangles Split cuts are the piece shown', d < 1e-4,
      'worst vertex ' + (d === Infinity ? 'count differs' : d.toExponential(1) + ' mm'));

    await openCutter(id);
    await page.evaluate(ax => { const a = document.getElementById('edit-axis'); a.value = ax; a.dispatchEvent(new Event('change')); }, cut);   // the axis lock (Cut X / Cut Z are gone, #166)
    const at = await page.evaluate(id => {
      const f = cutFrame(state.models.find(x => x.id === id));
      return Math.round(f.span * 0.37 * 10) / 10;
    }, id);
    await page.evaluate(v => {
      const s = document.getElementById('cut-slider'); s.value = String(v); s.dispatchEvent(new Event('input'));
    }, at);
    const r = await page.evaluate(id => __splitAndMeasure(id), id);
    check(label + ': Split is made on the raw triangles',
      new RegExp('^Cut @ ' + at.toFixed(1).replace('.', '\\.') + ' mm').test(r.status) && !!r.left && r.engine === 'raw',
      r.status);
    if (!r.left) return;
    const nh = Math.hypot(r.n[0], r.n[2]);
    check(label + ': the plate line runs across the blade\'s normal',
      Math.abs(Math.abs(r.n[0] * r.across[0] + r.n[2] * r.across[2]) - nh) < 1e-6,
      'blade normal [' + r.n.map(v => v.toFixed(3)).join(', ') + '], local ' + r.axis);
    const halves = [['left', r.left], ['right', r.right]];
    const reach = [];
    for (const [nm, h] of halves) {
      const f = h.face;
      const toLo = Math.abs(h.lo - r.pLo) < 2e-3, toHi = Math.abs(h.hi - r.pHi) < 2e-3;
      reach.push(toLo === toHi ? 0 : toHi ? 1 : -1);
      check(label + ', ' + nm + ' half: its cut face lies on the blade (a clean split, no kerf)',
        !!f && Math.abs(f.s) < 2e-3,
        f ? 'face at ' + f.s.toFixed(4) + ' mm from the blade' : 'no face parallel to the blade');
      check(label + ', ' + nm + ' half: it runs out to one end of the piece and stops at the blade', toLo !== toHi,
        'piece ' + r.pLo.toFixed(3) + ' .. ' + r.pHi.toFixed(3) + ', half ' + h.lo.toFixed(3) + ' .. ' + h.hi.toFixed(3));
      if (!f) continue;
      check(label + ', ' + nm + ' half: the cut face is the whole section on that plane',
        f.want > 1 && Math.abs(f.area - f.want) < 1e-3 * f.want,
        f.area.toFixed(3) + ' mm² for a section of ' + f.want.toFixed(3) + ' mm²');
      check(label + ', ' + nm + ' half: the cut face sits within the plate line\'s length',
        f.lineLo >= -1e-3 && f.lineHi <= r.lineLen + 1e-3,
        f.lineLo.toFixed(3) + ' .. ' + f.lineHi.toFixed(3) + ' of 0 .. ' + r.lineLen.toFixed(3));
    }
    // The halves at opposite ends, meeting at the blade: the low half's top
    // is the high half's bottom (no kerf, no gap, no overlap).
    const lowH = reach[0] === -1 ? r.left : r.right, highH = reach[0] === -1 ? r.right : r.left;
    check(label + ': the two halves meet at the blade, at opposite ends',
      reach[0] * reach[1] === -1 && Math.abs(lowH.hi - highH.lo) < 2e-3,
      'ends ' + reach.join(' / ') + ', low half to ' + lowH.hi.toFixed(4) + ', high half from ' + highH.lo.toFixed(4));
    // On the plate: the same half, turned as the piece was, moved along the
    // plate axis only (and set down on the plate, a vertical move), away
    // from the blade on its own side.
    const pa = r.plateAxis === 'z' ? 2 : 0, other = 2 - pa;
    [['A', r.left, r.plateA, reach[0]], ['B', r.right, r.plateB, reach[1]]].forEach(([nm, h, p, side]) => {
      if (!p) { check(label + ', half ' + nm + ' is on the plate', false); return; }
      const dSize = Math.max(...p.size.map((v, i) => Math.abs(v - h.size[i])));
      const move = p.centre.map((v, i) => v - h.centre[i]);
      const want = Math.sign(side * r.n[pa]) * r.gap / 2;
      check(label + ', half ' + nm + ' on the plate: turned as cut, moved ' + (r.gap / 2) + ' mm along ' +
        r.plateAxis.toUpperCase() + ' away from the blade only',
        p.turn < 1e-3 && dSize < 1e-3 && Math.abs(move[pa] - want) < 1e-3 && Math.abs(move[other]) < 1e-3,
        'turned ' + p.turn.toExponential(1) + ' deg from the piece, size off by ' + dSize.toExponential(1) +
        ' mm, move [' + move.map(v => v.toFixed(3)).join(', ') + ']');
    });
  }

  for (const [piece, file] of PIECES) {
    for (const [poseName, presses] of POSES) {
      for (const cut of ['x', 'z']) await run(piece, file, poseName, presses, cut);
    }
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

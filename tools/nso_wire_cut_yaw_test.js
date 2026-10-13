/* The Cut panel's yaw buttons (⟲ 90, ⟲ 15, 15 ⟳, 90 ⟳) turn the piece Split
   cuts, not only the piece on screen: the cut faces land where the blade and
   the plate line show them, at every yaw and after turning back.
     node tools/nso_wire_cut_yaw_test.js        exit 0 = every gate held

   WHAT WAS WRONG (reproduced on this tree before the fix)
   rotateActiveModelY turned the display geometry (m.geometry, which the
   preview, the readout, the blade and the plate line all read) and nothing
   else. A piece loaded from a file is cut from its raw triangles (m.rawTris,
   mapped through m.centerOffset), and those never turned. On a 60 x 12 x 8
   bar, after 90 ⟳ the blade stood across the turned bar's 60 mm length and
   Split sliced the unturned bar along its length: "6.5 mm + 6.5 mm ... !
   loss 47.0 mm". After 15 ⟳ the blade lay on the slant and Split cut the
   bar square. A piece with no raw triangles (cut on its display mesh) was
   turned correctly all along.

   NOW (app-cut.js rotateActiveModelY): the raw triangles turn with the
   display geometry, about the same centre, and centerOffset follows the
   re-centring; both are replaced, not written in place.

   GATES, through the real buttons and the real Split, on a raw piece and a
   display-route piece, at yaw 0, 15 ⟳, 90 ⟳, ⟲ 15, ⟲ 90, and turned back
   (15 ⟳ ⟲ 15, 90 ⟳ ⟲ 90, six 15 ⟳ then ⟲ 90). The red line is put at
   21.3 mm, off-centre, so a sign error cannot hide behind symmetry.
     - the raw triple, mapped onto the display frame, is the display geometry
       (what Split cuts is what the preview shows);
     - each half's cut face, in world space, lies on one edge of the plate
       line (the blade's plane +- half a kerf), the two halves on opposite
       edges, across the full plate-line strip direction, and covers the
       section the blade crosses (W x H / |cos| of the bar's angle to it);
     - each half runs out to its own end of the piece;
     - on the plate, each half is the cut half, turned as it was, moved only
       along the cut by the split view gap;
     - turned back: the raw triangles and the display geometry are the ones
       loaded.                                                               */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const L = 60, W = 12, H = 8;
function bar(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-yaw-'));
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
window.__soups = function (id) {
  const m = state.models.find(x => x.id === id);
  return { raw: m.rawTris ? Array.from(m.rawTris) : null, geo: Array.from(m.geometry.attributes.position.array) };
};
/* A piece with no raw triangles: Split cuts its display mesh. */
window.__addDisplayPiece = function (soup) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(soup), 3));
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  const id = addModel('bar-display', g, { keepSelection: true, silent: true });
  const m = state.models.find(x => x.id === id);
  const maxX = Math.max(0, ...state.placed.map(p => p.x + (p.width || 0) / 2));
  placeModelMovable(m, maxX + m.size.x / 2 + 10, 0);
  return id;
};
/* Split through the real button; the two halves as Split made them (before
   they are centred and laid out) and as they then sit on the plate, with the
   blade and the plate line as they stood. Everything in world space. */
window.__splitAndMeasure = function (id) {
  const m = state.models.find(x => x.id === id);
  const mesh = cutMeshOf(m);
  state.scene.updateMatrixWorld(true);
  const Mw = mesh.matrixWorld.clone();
  const blade = state.cutHelper.children.find(c => c.userData.cutBlade);
  const P = new THREE.Vector3().setFromMatrixPosition(blade.matrixWorld);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(blade.matrixWorld);
  const pl = state.cutHelper.userData.plateLine;
  const la = new THREE.Vector3().fromArray(pl.a), lb = new THREE.Vector3().fromArray(pl.b);
  const across = new THREE.Vector3().fromArray(pl.across);
  const ldir = lb.clone().sub(la); ldir.y = 0; const llen = ldir.length(); ldir.normalize();
  // the piece's own reach along the blade normal
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
    return half(e.mesh.geometry, e.mesh.matrixWorld);
  };
  return { status: status, engine: got.engine, kerf: KERF_MM, gap: SPLIT_VIEW_GAP_MM,
           n: n.toArray(), across: across.toArray(), lineLen: llen, pLo: pLo, pHi: pHi,
           left: half(got.left, Mw), right: half(got.right, Mw), plateA: onPlate('A'), plateB: onPlate('B') };
};`;

const YAWS = {
  '15 ⟳': ['#btn-yaw-right', 15], '⟲ 15': ['#btn-yaw-left', -15],
  '90 ⟳': ['#btn-yaw-right-90', 90], '⟲ 90': ['#btn-yaw-left-90', -90]
};

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const barFile = stl('bar.stl', bar(L, W, H));

  const open = async id => {
    await page.evaluate(() => {
      const e = document.getElementById('btn-cutter-open');
      for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    });
    if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
  };
  const slide = v => page.evaluate(v => {
    const s = document.getElementById('cut-slider'); s.value = String(v); s.dispatchEvent(new Event('input'));
  }, v);

  async function run(route, presses) {
    const label = route + ', ' + (presses.length ? presses.join(' then ') : 'yaw 0');
    console.log('\n=== ' + label + ' ===');
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
    const id = route === 'raw'
      ? await loadSTL(page, barFile)
      : await page.evaluate(soup => __addDisplayPiece(soup), bar(L, W, H));
    const loaded = await page.evaluate(id => __soups(id), id);
    await open(id);
    let yaw = 0;
    for (const p of presses) {
      await page.evaluate(sel => {
        const e = document.querySelector(sel);
        for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
      }, YAWS[p][0]);
      await page.click(YAWS[p][0]);
      yaw += YAWS[p][1];
    }
    if (route === 'raw') {
      const d = await page.evaluate(id => __rawVsDisplay(id), id);
      check(label + ': the raw triangles Split cuts are the turned piece on screen', d < 1e-4,
        'worst vertex ' + (d === Infinity ? 'count differs' : d.toExponential(1) + ' mm'));
    }
    if (presses.length && yaw % 360 === 0) {
      const now = await page.evaluate(id => __soups(id), id);
      const diff = (a, b) => a.length === b.length ? Math.max(...a.map((x, i) => Math.abs(x - b[i]))) : Infinity;
      const dRaw = route === 'raw' ? diff(now.raw, loaded.raw) : 0;
      const dGeo = diff(now.geo, loaded.geo);
      check(label + ': turned back, the piece is the one loaded (raw and display)', dRaw < 1e-4 && dGeo < 1e-4,
        'raw ' + dRaw.toExponential(1) + ' mm, display ' + dGeo.toExponential(1) + ' mm');
    }
    await slide(21.3);
    const r = await page.evaluate(id => __splitAndMeasure(id), id);
    check(label + ': Split is made', /^Cut @ 21\.3 mm/.test(r.status) && !!r.left, r.status);
    if (!r.left) return;
    const k2 = r.kerf / 2;
    // the blade's plane and the plate line are one plane; the line spans the cut
    const nh = Math.hypot(r.n[0], r.n[2]);
    check(label + ': the plate line runs across the blade\'s normal', Math.abs(Math.abs(r.n[0] * r.across[0] + r.n[2] * r.across[2]) - nh) < 1e-6);
    // Which end of the piece each half runs out to. Which plate-line edge
    // each half's face is on is left as each route has it (the raw route
    // keeps the kerf band on both halves, so its faces sit on the far edge):
    // only that the two faces are on opposite edges.
    const halves = [['left', r.left], ['right', r.right]];
    const faceSides = [], reach = [];
    for (const [nm, h] of halves) {
      const f = h.face;
      faceSides.push(f ? Math.sign(f.s) : 0);
      const toLo = Math.abs(h.lo - r.pLo) < 2e-3, toHi = Math.abs(h.hi - r.pHi) < 2e-3;
      reach.push(toLo === toHi ? 0 : toHi ? 1 : -1);
      check(label + ', ' + nm + ' half: its cut face lies on an edge of the plate line (blade +- ' + k2 + ' mm)',
        !!f && Math.abs(Math.abs(f.s) - k2) < 2e-3,
        f ? 'face at ' + f.s.toFixed(4) + ' mm from the blade' : 'no face parallel to the blade');
      check(label + ', ' + nm + ' half: it runs out to one end of the piece and stops at the blade', toLo !== toHi,
        'piece ' + r.pLo.toFixed(3) + ' .. ' + r.pHi.toFixed(3) + ', half ' + h.lo.toFixed(3) + ' .. ' + h.hi.toFixed(3));
      if (!f) continue;
      // The bar's long direction makes angle yaw with world X; the blade's
      // normal is world X or Z, so the section is W x H over |cos| of the
      // angle between them.
      const ux = Math.cos(yaw * Math.PI / 180), uz = Math.sin(yaw * Math.PI / 180);
      const want = W * H / Math.abs(ux * r.n[0] + uz * r.n[2]);
      check(label + ', ' + nm + ' half: the cut face is the whole section the blade crosses',
        Math.abs(f.area - want) < 1e-3 * want, f.area.toFixed(3) + ' mm² for ' + want.toFixed(3) + ' mm²');
      check(label + ', ' + nm + ' half: the cut face sits within the plate line\'s length',
        f.lineLo >= -1e-3 && f.lineHi <= r.lineLen + 1e-3,
        f.lineLo.toFixed(3) + ' .. ' + f.lineHi.toFixed(3) + ' of 0 .. ' + r.lineLen.toFixed(3));
    }
    check(label + ': the two cut faces are on opposite edges of the plate line, the halves at opposite ends',
      faceSides[0] * faceSides[1] === -1 && reach[0] * reach[1] === -1,
      'faces ' + faceSides.join(' / ') + ', ends ' + reach.join(' / '));
    // On the plate: the same half, turned as it was, moved across the plate
    // along the cut only (it is also set down on the plate, a vertical move).
    [['A', r.left, r.plateA, reach[0]], ['B', r.right, r.plateB, reach[1]]].forEach(([nm, h, p, side]) => {
      if (!p) { check(label + ', half ' + nm + ' is on the plate', false); return; }
      const dSize = Math.max(...p.size.map((v, i) => Math.abs(v - h.size[i])));
      const move = p.centre.map((v, i) => v - h.centre[i]);
      const want = r.n.map(v => v * side * r.gap / 2);
      const dMove = Math.max(Math.abs(move[0] - want[0]), Math.abs(move[2] - want[2]));
      check(label + ', half ' + nm + ' on the plate: turned as cut, moved ' + (r.gap / 2) + ' mm away from the blade only',
        dSize < 1e-3 && dMove < 1e-3,
        'size off by ' + dSize.toExponential(1) + ' mm, move [' + move.map(v => v.toFixed(3)).join(', ') + ']');
    });
  }

  const SEQS = [[], ['15 ⟳'], ['90 ⟳'], ['⟲ 15'], ['⟲ 90'], ['15 ⟳', '⟲ 15'], ['90 ⟳', '⟲ 90'],
                ['15 ⟳', '15 ⟳', '15 ⟳', '15 ⟳', '15 ⟳', '15 ⟳', '⟲ 90']];
  for (const route of ['raw', 'display']) {
    for (const seq of SEQS) await run(route, seq);
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

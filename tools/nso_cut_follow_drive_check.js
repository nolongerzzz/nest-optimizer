/* nso_cut_follow_drive_check.js - Follow strand: the sized blade put square across a cord and walked along it,
   slicing a spiral like salami. Real app, real Chromium, real manifold kernel, real mouse.
     node tools/nso_cut_follow_drive_check.js        exit 0 = every gate held

   The spiral is generated here (a 3.6 mm round cord, 6.5 mm between turns, 3 turns): the shape of a connector string.

   WHAT IS PINNED
   - A click on the cord with Follow strand on stands the blade square across it: the blade's normal is the cord's
     direction there (read from the cord's own sections, nso_strand.js), and its section is the cord's own round one.
     The blade is made deep and wide enough to go through (the card says so).
   - Forward / Back walk it one step (slice + kerf = 2.5 mm) along the cord, staying square round the bend; Back
     comes home.
   - Cut cuts and moves on to the next slice by itself, three times running: each cut severs one more piece, the
     blade is on the cord 2.5 mm further on, and the pieces between the cuts are slices of the slice's thickness.
   - Every piece is a closed solid (0 open / 0 non-manifold edges); what came out is the kerf and no more.
   - At the cord's end the next Cut is the last: the card says so and nothing is left to move on to.
   - Back onto a place already cut is refused, not jumped to another turn of the spiral.                   */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* A cord of radius R swept along an Archimedean spiral, flat on z = 0..2R, ends capped. */
function spiral(opts) {
  const R = opts.R, turns = opts.turns, r0 = opts.r0, pitch = opts.pitch, ringSeg = opts.ringSeg, perTurn = opts.perTurn;
  const N = Math.round(turns * perTurn), rings = [];
  for (let i = 0; i <= N; i++) {
    const th = 2 * Math.PI * turns * i / N, rad = r0 + pitch * th / (2 * Math.PI), dr = pitch / (2 * Math.PI);
    const c = [rad * Math.cos(th), rad * Math.sin(th), R];
    let T = [dr * Math.cos(th) - rad * Math.sin(th), dr * Math.sin(th) + rad * Math.cos(th), 0];
    const tl = Math.hypot(T[0], T[1]); T = [T[0] / tl, T[1] / tl, 0];
    const Nn = [-T[1], T[0], 0];
    const ring = [];
    for (let j = 0; j < ringSeg; j++) {
      const f = 2 * Math.PI * j / ringSeg, cf = Math.cos(f) * R, sf = Math.sin(f) * R;
      ring.push([c[0] + cf * Nn[0], c[1] + cf * Nn[1], c[2] + sf]);
    }
    rings.push({ c, ring });
  }
  const o = [], tri = (a, b, c) => o.push(...a, ...b, ...c);
  for (let i = 0; i < N; i++) for (let j = 0; j < ringSeg; j++) {
    const j1 = (j + 1) % ringSeg, a = rings[i].ring[j], b = rings[i].ring[j1], c = rings[i + 1].ring[j1], d = rings[i + 1].ring[j];
    tri(a, b, c); tri(a, c, d);
  }
  for (let j = 0; j < ringSeg; j++) {
    const j1 = (j + 1) % ringSeg;
    tri(rings[0].c, rings[0].ring[j1], rings[0].ring[j]);
    tri(rings[N].c, rings[N].ring[j], rings[N].ring[j1]);
  }
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-strand-'));
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
  return { vol: vol, tris: n, open: adj ? adj.openEdges : null, nm: adj ? adj.nmEdges : null };
};
window.__probeAll = function () {
  // everything on the plate: a cut that goes right through separates the piece, so the original id is gone
  let vol = 0, open = 0, nm = 0, n = 0;
  state.models.forEach(m => { const r = window.__probe(m.id); if (r) { vol += r.vol; open += r.open || 0; nm += r.nm || 0; n++; } });
  return { vol: vol, open: open, nm: nm, n: n };
};`;


const HELP = `
/* Where the blade is and which way it faces, in the world, read the way the card holds them. */
window.__blade = function () {
  const m = getActiveModel(), i = getCutPlaneLocal(m), p = state.placed.find(q => q && q.sourceId === m.id);
  p.mesh.updateMatrixWorld(true);
  const W = cutWorldMatrix(i, p.mesh), c = i.bbox.getCenter(new THREE.Vector3());
  c[i.axis] = i.plane;
  const b = i.blade && i.blade.box, mid = b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2) : null;
  const k = ['x', 'y', 'z'].indexOf(i.axis); if (mid) mid.setComponent(k, i.plane);
  return { centre: (mid || c).clone().applyMatrix4(W).toArray(), normal: i.normalWorld.toArray(), mm: i.mm };
};
window.__soupAll = function () {
  const parts = []; let n = 0;
  state.placed.forEach(p => { if (p && p.sourceId != null && p.mesh) { const s = meshToWorldSoup(p.mesh); parts.push(s); n += s.length; } });
  const out = new Float32Array(n); let o = 0; parts.forEach(s => { out.set(s, o); o += s.length; });
  return out;
};
/* The cord's own direction and section where the blade stands: from the piece's sections, not from the blade. */
window.__cordAt = function (c) {
  const t = NSO_Strand.traceAt(__soupAll(), c, { within: 1.5 });
  return t ? { t: t.t, w: t.w, h: t.h } : null;
};
window.__sectionArea = function (c, n) {
  const tris = NSO_Strand.near(__soupAll(), c, 6), L = NSO_Strand.sections(tris, n, n[0] * c[0] + n[1] * c[1] + n[2] * c[2]);
  let best = null, bd = Infinity;
  L.forEach(l => { const d = Math.hypot(l.c[0] - c[0], l.c[1] - c[1], l.c[2] - c[2]); if (d < bd) { bd = d; best = l; } });
  return best ? { area: best.area, off: bd } : null;
};
window.__pieceVolumes = function () {
  return state.models.map(m => ({ id: m.id, vol: window.__probe(m.id).vol }));
};
`;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const angle = (a, b) => Math.acos(Math.min(1, Math.abs(dot(a, b)) / (len(a) * len(b)))) * 180 / Math.PI;
const POLY_AREA = 0.5 * 14 * 1.8 * 1.8 * Math.sin(2 * Math.PI / 14);      // the 14-sided cord's section


withApp(async (page, logs) => {
  await page.addScriptTag({ content: PROBE });
  await page.addScriptTag({ content: HELP });
  const status = () => page.evaluate(() => document.getElementById('status').textContent);
  const SPIRAL = spiral({ R: 1.8, turns: 3, r0: 4, pitch: 6.5, ringSeg: 14, perTurn: 36 });
  const xyOf = wp => page.evaluate(wp => {
    const v = new THREE.Vector3(wp[0], wp[1], wp[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }, wp);
  const clickAt = async wp => { const xy = await xyOf(wp); await page.mouse.move(xy[0], xy[1]); await page.mouse.down(); await page.mouse.up(); };
  const waitStatus = re => page.waitForFunction(s => new RegExp(s).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });
  const blade = () => page.evaluate(() => __blade());
  const follow = () => page.evaluate(() => state.cutFollowAt && { c: state.cutFollowAt.c, t: state.cutFollowAt.t, next: !!state.cutFollowAt.next, prev: !!state.cutFollowAt.prev });
  const models = () => page.evaluate(() => state.models.length);

  async function fresh() {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); clearPlateOnly(); });
    const id = await loadSTL(page, stl('spiral.stl', SPIRAL));
    await page.evaluate(() => { const c = state.camera, t = state.controls.target; c.position.set(t.x, 190, t.z + 0.001); c.lookAt(t); state.controls.update(); });
    await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    await page.click('#btn-cut-blade-sized');
    await page.check('#chk-cut-follow');
    return id;
  }
  // the crown of the strand a ray straight down meets nearest a given world xz
  const crownAt = (x, z) => page.evaluate(([x, z]) => {
    const rc = new THREE.Raycaster(); let best = null;
    state.placed.forEach(p => { if (!p || !p.mesh) return; p.mesh.updateMatrixWorld(true);
      rc.set(new THREE.Vector3(x, 60, z), new THREE.Vector3(0, -1, 0));
      const h = rc.intersectObject(p.mesh, false)[0]; if (h && (!best || h.point.y > best[1])) best = [h.point.x, h.point.y, h.point.z]; });
    return best;
  }, [x, z]);
  // a world point on the cord near the middle of the spiral: scan a line for the first crown
  const someCrown = async () => {
    const bb = await page.evaluate(() => { const p = state.placed[0]; const b = new THREE.Box3().setFromObject(p.mesh); return [b.min.x, b.max.x, b.min.z, b.max.z]; });
    const cx = (bb[0] + bb[1]) / 2, cz = (bb[2] + bb[3]) / 2;
    for (let d = 8; d < 30; d += 0.25) { const c = await crownAt(cx + d, cz); if (c && c[1] > 3.2) return c; }
    return null;
  };

  console.log('click the cord: the blade stands square across it');
  let id = await fresh();
  const v0 = (await page.evaluate(() => __pieceVolumes())).reduce((a, b) => a + b.vol, 0);
  const crown = await someCrown();
  check('found a strand to click', !!crown, JSON.stringify(crown));
  await clickAt(crown);
  await waitStatus(/Follow: strand found/);
  const st1 = await status();
  check('the status line says what it did', /3\.\d mm cord, step 2\.5 mm/.test(st1), st1);
  let fa = await follow(), b = await blade();
  check('the strand is traced and the blade placed', !!fa && !!b);
  const cord = await page.evaluate(c => __cordAt(c), b.centre);
  check('the blade stands on the cord\'s centre', cord && len(sub(fa.c, b.centre)) < 0.3, len(sub(fa.c, b.centre)).toFixed(3) + ' mm');
  check('the blade faces along the cord (< 1 degree)', cord && angle(b.normal, cord.t) < 1, cord ? angle(b.normal, cord.t).toFixed(2) + ' deg' : 'no cord');
  let sec = await page.evaluate(([c, n]) => __sectionArea(c, n), [b.centre, b.normal]);
  check('its section is the cord\'s own round one', sec && Math.abs(sec.area / POLY_AREA - 1) < 0.02, sec ? (sec.area / POLY_AREA).toFixed(4) + ' x the round section' : 'none');
  const dims = await page.evaluate(() => ({ d: state.cutBlade.depth, w: state.cutBlade.width }));
  check('the blade goes through the cord (deeper than it is thick, wider than it is across)', dims.d >= 4.1 && dims.w >= 4.6, JSON.stringify(dims));

  console.log('Forward and Back');
  const c0 = fa.c;
  await page.click('#btn-cut-follow-fwd');
  await page.waitForTimeout(400);
  fa = await follow(); b = await blade();
  const step = len(sub(fa.c, c0));
  check('Forward moves one step (2.5 mm along a gentle bend)', step > 2.35 && step < 2.55, step.toFixed(3) + ' mm');
  const cord2 = await page.evaluate(c => __cordAt(c), b.centre);
  check('and the blade is square across the cord there too', cord2 && angle(b.normal, cord2.t) < 1, cord2 ? angle(b.normal, cord2.t).toFixed(2) + ' deg' : 'no cord');
  check('the cord turned a little between the two', cord && cord2 && angle(cord.t, cord2.t) > 1 && angle(cord.t, cord2.t) < 25, cord && cord2 ? angle(cord.t, cord2.t).toFixed(1) + ' deg' : '');
  await page.click('#btn-cut-follow-back');
  await page.waitForTimeout(400);
  fa = await follow();
  check('Back comes home', len(sub(fa.c, c0)) < 0.1, len(sub(fa.c, c0)).toFixed(3) + ' mm');
  await page.click('#btn-cut-follow-fwd');
  await page.waitForTimeout(300);
  fa = await follow();

  console.log('Cut, three times');
  const centres = [];
  let prev = fa.c;
  for (let i = 1; i <= 3; i++) {
    centres.push(prev);
    await page.click('#btn-cut');
    await waitStatus(/Sized cut/);
    await page.waitForTimeout(300);
    const s = await status(), now = await follow(), bb = await blade();
    const moved = now ? len(sub(now.c, prev)) : -1;
    const cd = now && await page.evaluate(c => __cordAt(c), bb.centre);
    check('cut ' + i + ': another piece, the blade on to the next slice 2.5 mm on, square',
      (await models()) === 1 + i && moved > 2.35 && moved < 2.55 && cd && angle(bb.normal, cd.t) < 1,
      'pieces ' + (await models()) + ', moved ' + moved.toFixed(3) + ' mm' + (cd ? ', ' + angle(bb.normal, cd.t).toFixed(2) + ' deg off square' : ''));
    check('cut ' + i + ': the status line reports the cut and the move', /Sized cut/.test(s) && /Follow: on to the next slice/.test(s), s.slice(0, 200));
    prev = now ? now.c : prev;
  }
  const all = await page.evaluate(() => ({ vols: __pieceVolumes(), pa: __probeAll() }));
  const total = all.vols.reduce((a, b) => a + b.vol, 0), removed = v0 - total;
  check('what came out is the kerf: 3 x 1 mm of the cord\'s section', Math.abs(removed - 3 * POLY_AREA) < 0.2 * 3 * POLY_AREA, removed.toFixed(2) + ' mm3 vs ' + (3 * POLY_AREA).toFixed(2));
  const sorted = all.vols.map(v => v.vol).sort((a, b) => a - b);
  const slices = sorted.slice(0, 2);                       // the two pieces between cuts are the smallest
  check('the two slices are about 1.5 mm thick', slices.every(v => v > 1.5 * POLY_AREA * 0.85 && v < 1.5 * POLY_AREA * 1.15), slices.map(v => v.toFixed(2)).join(', ') + ' mm3 vs ' + (1.5 * POLY_AREA).toFixed(2));
  check('every piece is a closed solid', all.pa.open === 0 && all.pa.nm === 0, 'open ' + all.pa.open + ', nm ' + all.pa.nm);

  console.log('Back onto a place already cut');
  const backOff = await page.$eval('#btn-cut-follow-back', e => e.disabled);
  check('Back is off: the step back is a cut already, not a strand', backOff === true);
  // asked anyway (a stale click, a keystroke), the card refuses and the blade stays put - it does not jump to another turn
  await page.evaluate(() => cutFollowMove(-1));
  const sb = await status(), fb = await follow();
  check('and asked anyway it says so and does not move', /end of the strand/.test(sb) && fb && len(sub(fb.c, prev)) < 0.1, sb + (fb ? ' | moved ' + len(sub(fb.c, prev)).toFixed(3) : ''));
  // placing there directly (as an old click would) is refused too
  const refusedPlace = await page.evaluate(c => cutFollowPlace(c, state.cutFollowAt.t, 'test', true), centres[centres.length - 1]);
  check('placing the blade in a kerf already cut is refused', refusedPlace && refusedPlace.ok === false, JSON.stringify(refusedPlace));

  console.log('the end of the cord');
  id = await fresh();
  // the outer end of the spiral: the world vertex furthest from the middle, then 3.5 mm in along the cord
  const tip = await page.evaluate(() => {
    const s = __soupAll(), n = s.length / 3; let cx = 0, cz = 0;
    for (let i = 0; i < s.length; i += 3) { cx += s[i]; cz += s[i + 2]; }
    cx /= n; cz /= n; let best = null, bd = 0;
    for (let i = 0; i < s.length; i += 3) { const d = Math.hypot(s[i] - cx, s[i + 2] - cz); if (d > bd) { bd = d; best = [s[i], s[i + 1], s[i + 2]]; } }
    return best;
  });
  // the very end face has no section of its own to read: a click there is refused, not read as another turn
  const refused = await page.evaluate(p => NSO_Strand.traceAt(__soupAll(), p, {}), tip);
  check('a point on the cord\'s flat end is refused rather than read as another turn', refused === null, JSON.stringify(refused));
  // a point on the cord about 2.5 mm in from that end (further than the 3.6 mm ring of the cap is wide), then its centre and direction there
  const near = await page.evaluate(tp => {
    const s = __soupAll();
    for (let i = 0; i < s.length; i += 3) { const d = Math.hypot(s[i] - tp[0], s[i + 1] - tp[1], s[i + 2] - tp[2]); if (d > 4.2 && d < 5 && s[i + 1] > tp[1] - 0.05) return [s[i], s[i + 1], s[i + 2]]; }
    return null;
  }, tip);
  const tr = await page.evaluate(p => { const q = NSO_Strand.traceAt(__soupAll(), p, {}); return q && { c: q.c, t: q.t }; }, near);
  check('a point on the cord near its end is read as the cord', !!tr);
  // walk 3.5 mm further in, away from the end (the sense that does not run out)
  const inward = await page.evaluate(([c, t]) => {
    const soup = __soupAll(); let best = null;
    for (const sg of [1, -1]) { const a = NSO_Strand.advance(soup, c, [t[0] * sg, t[1] * sg, t[2] * sg], 3.5, {}); if (a && !a.end) best = a; }
    return best && { c: best.c };
  }, [tr.c, tr.t]);
  check('and 3.5 mm further in there is cord to stand on', !!inward);
  const crown2 = await crownAt(inward.c[0], inward.c[2]);
  await clickAt(crown2);
  await waitStatus(/Follow: strand found/);
  fa = await follow();
  // Cut goes the way the tip lies
  await page.evaluate(([tipc]) => {
    const fa = state.cutFollowAt, d = p => p ? Math.hypot(p.c[0] - tipc[0], p.c[1] - tipc[1], p.c[2] - tipc[2]) : Infinity;
    state.cutBlade.followDir = d(fa.next) < d(fa.prev) ? 1 : -1;
  }, [tip]);
  let last = null, cuts = 0;
  for (let i = 0; i < 4 && !last; i++) {
    await page.click('#btn-cut');
    await page.waitForFunction(() => /Sized cut|Cut not made/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    await page.waitForTimeout(300);
    const s = await status(); cuts++;
    if (/Cut not made/.test(s)) { last = 'refused: ' + s; break; }
    if (/last slice/.test(s)) last = s;
  }
  check('cutting toward the tip ends with "the last slice" within a few cuts', last && /last slice/.test(last), cuts + ' cuts; ' + (last || 'never said so'));
  check('and the card is left with nothing to move on to', (await follow()) === null);

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

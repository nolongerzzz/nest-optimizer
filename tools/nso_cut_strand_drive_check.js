/* nso_cut_strand_drive_check.js - the Cut card on a SPIRAL OF CORD: the sized
   blade taking one strand and not the whole spiral, Notch mode, and the two
   Rotate piece switch. Real app, real Chromium, real
   manifold kernel, real mouse.
     node tools/nso_cut_strand_drive_check.js        exit 0 = every gate held

   The spiral is generated here (a 3.6 mm round cord, 2.9 mm between turns, 3
   turns): the same shape as a connector string, so a plane through its middle
   crosses six strands.

   WHAT IS PINNED
   - Single strand: a sized blade over several turns takes ONE. Checked against
     an independent derivation, not against itself: the same blade, strand
     detection off, made just wide enough for that strand alone, must take the
     same volume.
   - The cut is clean: 0 open, 0 non-manifold edges. (A cut that subtracts the
     strand's own piece leaves a pinched edge; one that subtracts a blade does not.)
   - Notch: fitted to the strand, from its edge; its volume grows in step with
     the notch width and depth, and the strand is not severed.
   - Sliders: width, depth and kerf for the Sized blade, width and depth for Notch -
     each a slider beside its number box, ranged to the piece, and the same number.
   - Rotate piece: the rings appear and a real drag on one turns the piece, the
     blade follows, and a cut still works afterwards. Arrow keys are not
     answered twice.                                                          */

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

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PROBE });
  const probe = id => page.evaluate(id => __probe(id), id);
  const probeAll = () => page.evaluate(() => __probeAll());
  const status = () => page.evaluate(() => document.getElementById('status').textContent);
  const waitCut = () => page.waitForFunction(() => /(Sized|Notch) cut|Cut not made/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const SPIRAL = spiral({ R: 1.8, turns: 3, r0: 4, pitch: 6.5, ringSeg: 14, perTurn: 36 });

  async function fresh() {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); clearPlateOnly(); });
    const id = await loadSTL(page, stl('spiral.stl', SPIRAL));
    await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    return id;
  }
  const xyOf = wp => page.evaluate(wp => {
    const v = new THREE.Vector3(wp[0], wp[1], wp[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
  }, wp);
  const clickAt = async wp => { const xy = await xyOf(wp); await page.mouse.move(xy[0], xy[1]); await page.mouse.down(); await page.mouse.up(); };
  // The crown of the strand nearest the middle of the plane the blade is on (a ray straight down).
  const crownNear = (id, dz) => page.evaluate(([id, dz]) => {
    const p = state.placed.find(q => q && q.sourceId === id); p.mesh.updateMatrixWorld(true);
    const info = getCutPlaneLocal(getActiveModel());
    const W = cutWorldMatrix(info, p.mesh), c = info.bbox.getCenter(new THREE.Vector3()); c[info.axis] = info.plane; c.applyMatrix4(W);
    const rc = new THREE.Raycaster(), hits = [];
    for (let z = -26; z <= 26; z += 0.25) {
      rc.set(new THREE.Vector3(c.x, 40, c.z + z), new THREE.Vector3(0, -1, 0));
      const h = rc.intersectObject(p.mesh, false)[0];
      if (h && h.face.normal.y > 0.97) hits.push([h.point.x, h.point.y, h.point.z]);
    }
    return hits.length ? hits[Math.min(hits.length - 1, Math.max(0, Math.floor(hits.length / 2) + dz))] : null;
  }, [id, dz]);
  const setSized = (w, d, k, strand) => page.evaluate(([w, d, k, strand]) => {
    document.getElementById('btn-cut-blade-sized').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('cut-blade-width', w); set('cut-blade-depth', d); set('cut-blade-kerf', k);
    const c = document.getElementById('chk-cut-blade-strand'); c.checked = !!strand; c.dispatchEvent(new Event('change'));
  }, [w, d, k, strand]);
  const setNotch = (w, d) => page.evaluate(([w, d]) => {
    document.getElementById('btn-cut-blade-notch').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('cut-notch-width', w); set('cut-notch-depth', d);
  }, [w, d]);
  const spec = () => page.evaluate(() => {
    const i = getCutPlaneLocal(getActiveModel()), b = i && i.blade;
    return b ? { strands: b.strands, isolate: b.isolate, miss: b.miss, notch: b.notch, wAxis: b.entry.wAxis, wCentre: b.wCentre,
      strand: b.strand ? { lo: b.strand.min, hi: b.strand.max } : null, sizes: b.sizes, ro: document.getElementById('cut-readout').textContent } : null;
  });
  const cutOnce = async () => { await page.click('#btn-cut'); await waitCut(); const r = { st: await status() }; return r; };
  // a cut that severs is two Undo steps now (the separation, then the cut)
  const undo = async () => { await page.click('#btn-undo'); if (/Split to parts reverted/.test(await status())) await page.click('#btn-undo'); };

  console.log('the spiral');
  let id = await fresh();
  const v0 = await probe(id);
  const Lcord = 2 * Math.PI * ((4 + 6.5 * 3) + 4) / 2 * 3;    // mean radius x 2pi x turns
  check('a closed solid of about the cord\'s volume', v0.open === 0 && v0.nm === 0 && Math.abs(v0.vol / (Math.PI * 1.8 * 1.8 * Lcord) - 1) < 0.05,
    'vol ' + v0.vol.toFixed(1) + ', open ' + v0.open + ', nm ' + v0.nm);

  console.log('sized blade: one strand, not the spiral');
  await setSized(60, 8, 1, true);
  const crown = await crownNear(id, 0);
  check('found a strand to click', !!crown, JSON.stringify(crown));
  await clickAt(crown);
  const sp = await spec();
  check('the plane crosses several strands and one is picked', sp && sp.isolate && sp.strands >= 5, JSON.stringify({ isolate: sp && sp.isolate, strands: sp && sp.strands }));
  check('the readout says single strand', /single strand \(1 of \d+\)/.test(sp.ro), sp.ro);
  check('the strand is outlined in the helper', await page.evaluate(() => !!state.cutHelper.children.find(c => c.userData.cutStrand)));

  await setSized(60, 8, 1, false);
  let r = await cutOnce(); let vOff = await probeAll();
  const removedAll = v0.vol - vOff.vol, bodiesAll = /(?:separated into|severs the piece into) (\d+) (?:pieces|bodies)/.exec(r.st);
  check('with Single strand off the blade takes every turn it holds', removedAll > 40 && bodiesAll && Number(bodiesAll[1]) >= 4, removedAll.toFixed(2) + ' mm3; ' + r.st);
  await undo();

  await setSized(60, 8, 1, true);
  await clickAt(crown);
  r = await cutOnce(); const vOn = await probeAll();
  const removedOne = v0.vol - vOn.vol;
  check('with it on, the same blade takes less than half of that', removedOne > 0 && removedOne < 0.5 * removedAll, removedOne.toFixed(3) + ' vs ' + removedAll.toFixed(3));
  check('and says it took one strand of several', /one strand of \d+ in the blade/.test(r.st), r.st);
  check('the cut is clean: 0 open, 0 non-manifold edges', vOn.open === 0 && vOn.nm === 0, 'open ' + vOn.open + ', nm ' + vOn.nm);
  check('no warning on the status line', !/WARNING/.test(r.st), r.st);
  await undo();

  // Independent derivation: the same blade, detection OFF, narrowed to just that strand's own width.
  await setSized(60, 8, 1, true);
  await clickAt(crown);
  const s2 = await spec();
  const half = Math.max(s2.strand.hi[s2.wAxis] - s2.wCentre, s2.wCentre - s2.strand.lo[s2.wAxis]) + 0.3;
  await setSized(2 * half, 8, 1, false);
  r = await cutOnce(); const vNarrow = await probeAll();
  const removedNarrow = v0.vol - vNarrow.vol;
  check('same volume as a plain blade made just wide enough for that strand (independent of the detection)',
    Math.abs(removedNarrow - removedOne) <= 0.01 * removedOne + 0.01, removedNarrow.toFixed(4) + ' vs ' + removedOne.toFixed(4) + ' (half-width ' + half.toFixed(2) + ')');
  await undo();

  console.log('notch mode');
  await setNotch(1, 1);
  await clickAt(crown);
  const sn = await spec();
  check('the notch is fitted to the strand: its width is the strand\'s plus the margins', sn.notch && !sn.miss &&
    near(sn.sizes.width, sn.strand.hi[sn.wAxis] - sn.strand.lo[sn.wAxis] + 2 * 0.5, 1e-3), JSON.stringify(sn.sizes));
  check('the readout says nick, depth and which strand', /NOTCH .* 1 wide x 1 deep into the strand's edge, down from the top \(1 of \d+ strands\)/.test(sn.ro), sn.ro);
  r = await cutOnce(); const n1 = await probe(id); const V11 = v0.vol - n1.vol;
  check('a 1 x 1 nick comes out', /^Notch cut - 1 mm wide x 1 mm deep nick/.test(r.st) && V11 > 0.5 && V11 < 12, V11.toFixed(3) + ' mm3; ' + r.st);
  check('it takes far less than the strand-through cut', V11 < 0.4 * removedOne, V11.toFixed(3) + ' vs ' + removedOne.toFixed(3));
  check('clean: 0 open, 0 non-manifold edges', n1.open === 0 && n1.nm === 0, 'open ' + n1.open + ', nm ' + n1.nm);
  check('still one body: a nick does not sever the cord', !/severs/.test(r.st), r.st);
  await undo();
  await setNotch(2, 1); await clickAt(crown);
  await cutOnce(); const V21 = v0.vol - (await probe(id)).vol; await undo();
  check('twice the notch width takes twice the volume (within 12%)', Math.abs(V21 / V11 - 2) < 0.24, 'ratio ' + (V21 / V11).toFixed(3));
  await setNotch(1, 2); await clickAt(crown);
  await cutOnce(); const V12 = v0.vol - (await probe(id)).vol; await undo();
  check('twice the depth takes well over 1.8 times the volume (a round cord widens as it goes in)', V12 / V11 > 1.8, 'ratio ' + (V12 / V11).toFixed(3));
  check('Undo said what it undid', /Notch reverted/.test(await status()), await status());
  check('and the piece is back', near((await probe(id)).vol, v0.vol, 1e-3));

  console.log('sliders: width, depth, kerf; notch width and depth');
  await setSized(60, 8, 1, true);
  await clickAt(crown);
  const rng = id => page.evaluate(id => { const e = document.getElementById(id); return e ? { v: Number(e.value), min: Number(e.min), max: Number(e.max), shown: !!e.offsetParent } : null; }, id);
  const ext = await page.evaluate(() => { const i = getCutPlaneLocal(getActiveModel()), k = ['x', 'y', 'z'].indexOf(i.axis), z = i.bbox.getSize(new THREE.Vector3()); return Math.max(...[0, 1, 2].filter(q => q !== k).map(q => z.getComponent(q))); });
  const wS = await rng('cut-blade-width-s'), dS = await rng('cut-blade-depth-s'), kS = await rng('cut-blade-kerf-s');
  check('Sized shows a slider for each of width, depth and kerf', wS.shown && dS.shown && kS.shown, JSON.stringify({ wS, dS, kS }));
  check('the sliders sit at the numbers in the boxes (60, 8, 1), never pegged short of them', wS.v === 60 && dS.v === 8 && kS.v === 1 && wS.max >= 60, JSON.stringify({ w: wS, d: dS, k: kS }));
  check('their ranges have room to breathe: width to twice the piece\'s biggest section, depth to 1.5x, kerf to 3/4 of its length (or the number given)',
    wS.max >= Math.max(60, Math.ceil(2 * ext)) && dS.max >= Math.ceil(1.5 * ext) && kS.max >= Math.ceil(0.75 * 40), JSON.stringify({ ext: +ext.toFixed(2), wMax: wS.max, dMax: dS.max, kMax: kS.max }));
  // The box's own three sizes (the cut frame can be turned, so its world-axis extent is not its size).
  const bladeBox = () => page.evaluate(() => { const p = state.cutHelper.children.find(c => c.userData.cutBlade).geometry.parameters;
    return [p.width, p.height, p.depth].map(v => +v.toFixed(3)).sort((a, b) => a - b); });
  // a real mouse press on the width slider, a third of the way along its track
  const wRect = await page.evaluate(() => { const r = document.getElementById('cut-blade-width-s').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  await page.mouse.click(wRect.x + wRect.w * 0.3, wRect.y);
  const wAfter = await page.evaluate(() => ({ s: Number(document.getElementById('cut-blade-width-s').value), n: Number(document.getElementById('cut-blade-width').value), st: state.cutBlade.width }));
  check('a real click on the width slider sets the width, the box beside it and the blade setting together', wAfter.s === wAfter.n && wAfter.n === wAfter.st && wAfter.st > wS.min + 3 && wAfter.st < wS.max, JSON.stringify(wAfter));
  const drawn = await bladeBox();
  check('and the blade drawn in the viewport is that wide: kerf x (depth + 1 clear) x width', near(drawn[0], 1, 0.01) && near(drawn[1], 9, 0.01) && near(drawn[2], wAfter.st, 0.01), JSON.stringify({ drawn, width: wAfter.st }));
  await page.evaluate(() => { const e = document.getElementById('cut-blade-depth-s'); e.value = '5.5'; e.dispatchEvent(new Event('input')); });
  const dAfter = await page.evaluate(() => ({ n: Number(document.getElementById('cut-blade-depth').value), st: state.cutBlade.depth, ro: document.getElementById('cut-readout').textContent }));
  check('the depth slider moves the depth, its box and the readout', dAfter.n === 5.5 && dAfter.st === 5.5 && /5\.5 deep/.test(dAfter.ro), JSON.stringify(dAfter));
  await page.evaluate(() => { const e = document.getElementById('cut-blade-kerf-s'); e.value = '2.5'; e.dispatchEvent(new Event('input')); });
  check('the kerf slider moves the kerf', await page.evaluate(() => state.cutBlade.kerf === 2.5 && Number(document.getElementById('cut-blade-kerf').value) === 2.5 && /kerf 2\.5/.test(document.getElementById('cut-readout').textContent)));
  await page.focus('#cut-blade-width');          // typing into the box, as a user does (the slider the mouse used loses focus)
  await page.evaluate(() => { const e = document.getElementById('cut-blade-width'); e.value = '500'; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); });
  check('typing past the slider\'s end still works: the box takes 500, and the slider\'s range grows to hold it', await page.evaluate(() => state.cutBlade.width === 500 && Number(document.getElementById('cut-blade-width-s').max) >= 500 && Number(document.getElementById('cut-blade-width-s').value) === 500));
  // Reported: a 15 mm notch could not be dialled in - the notch width and kerf sliders stopped at 10.
  await page.evaluate(() => { const e = document.getElementById('cut-blade-kerf-s'); e.value = '15'; e.dispatchEvent(new Event('input')); });
  check('the kerf slider can be set to 15 mm', await page.evaluate(() => state.cutBlade.kerf === 15 && Number(document.getElementById('cut-blade-kerf').value) === 15 && Number(document.getElementById('cut-blade-kerf-s').max) >= 20));
  await setNotch(1, 1); await clickAt(crown);
  const nW = await rng('cut-notch-width-s'), nD = await rng('cut-notch-depth-s');
  check('Notch shows a slider for its width and its depth, and not the sized ones', nW.shown && nD.shown && !(await rng('cut-blade-width-s')).shown, JSON.stringify({ nW, nD }));
  await page.evaluate(() => { const e = document.getElementById('cut-notch-width-s'); e.value = '15'; e.dispatchEvent(new Event('input')); });
  check('the notch width slider can be set to 15 mm, and the readout says so', await page.evaluate(() => state.cutBlade.nwidth === 15 && Number(document.getElementById('cut-notch-width').value) === 15 && Number(document.getElementById('cut-notch-width-s').max) >= 20 && /15 wide/.test(document.getElementById('cut-readout').textContent)), await page.evaluate(() => document.getElementById('cut-readout').textContent));
  await page.evaluate(() => { const e = document.getElementById('cut-notch-width-s'); e.value = '2'; e.dispatchEvent(new Event('input')); });
  await cutOnce(); const VS2 = v0.vol - (await probe(id)).vol; await undo();
  check('the notch-width slider is the notch width: 2 takes twice the volume of 1 (within 12%)', Math.abs(VS2 / V11 - 2) < 0.24, 'ratio ' + (VS2 / V11).toFixed(3));
  await page.evaluate(() => { const e = document.getElementById('cut-notch-depth-s'); e.value = '2'; e.dispatchEvent(new Event('input')); const w = document.getElementById('cut-notch-width-s'); w.value = '1'; w.dispatchEvent(new Event('input')); });
  await cutOnce(); const VD2 = v0.vol - (await probe(id)).vol; await undo();
  check('the notch-depth slider is the notch depth: 2 takes over 1.8 times the volume of 1', VD2 / V11 > 1.8, 'ratio ' + (VD2 / V11).toFixed(3));
  check('there is no Adjust blade switch any more', await page.evaluate(() => !document.getElementById('chk-cut-adjust') && !document.getElementById('cut-adjust-wrap') && !/Adjust blade/.test(document.getElementById('edit-card').textContent)));

  console.log('Rotate piece');
  id = await fresh();
  await setSized(60, 8, 1, true);
  await clickAt(await crownNear(id, 0));
  const rowShown = () => page.evaluate(() => { const e = document.getElementById('cut-rotate-rings'); return getComputedStyle(e).display !== 'none' && !!e.offsetParent; });
  check('the ring options are not on the card until Rotate piece is ticked (computed style, not the attribute)', (await rowShown()) === false);
  check('rings are not drawn until asked', await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return !g || !g.visible || !g.children.length; }));
  await page.evaluate(() => { const c = document.getElementById('chk-cut-rotate'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(200);
  const ringInfo = await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return { rings: nsoRotate.rings(), visible: !!(g && g.visible), kids: g ? g.children.length : 0, cutOpen: state.cutterOpen, row: !document.getElementById('cut-rotate-rings').hidden }; });
  check('ticked: the ring options appear on the card', (await rowShown()) === true);
  check('ticked: the Turn ring is drawn on the piece, Cut still open, the ring options shown', ringInfo.rings.includes('turn') && ringInfo.visible && ringInfo.kids > 0 && ringInfo.cutOpen && ringInfo.row, JSON.stringify(ringInfo));
  // The pose is baked into the geometry when a turn ends (the mesh's own quaternion goes back to identity), so
  // "did it turn" is read off a real vertex in the world, not off the quaternion.
  const vtx = () => page.evaluate(() => { const m = state.placed[0].mesh; m.updateMatrixWorld(true);
    return new THREE.Vector3().fromBufferAttribute(m.geometry.attributes.position, 100).applyMatrix4(m.matrixWorld).toArray().map(v => +v.toFixed(4)); });
  const pose0 = await vtx();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const poseKey = await vtx();
  check('arrow keys do not turn the piece (the keys stay with the Rotate menu alone)', JSON.stringify(poseKey) === JSON.stringify(pose0));
  // a real drag on a ring handle
  const handle = await page.evaluate(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles'); g.updateMatrixWorld(true); let best = null;
    g.traverse(o => { if (o.userData && o.userData.nsoRotateHandle && !best) best = o; });
    if (!best) return null;
    const p = new THREE.Vector3(); best.getWorldPosition(p);
    const v = p.clone().project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return { xy: [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height], axis: best.userData.nsoRotateHandle };
  });
  check('found a ring handle to grab', !!handle, JSON.stringify(handle));
  await page.mouse.move(handle.xy[0], handle.xy[1]);
  await page.mouse.down();
  const grabbed = await page.evaluate(() => nsoRotate.dragging());
  await page.mouse.move(handle.xy[0] + 70, handle.xy[1] + 40, { steps: 8 });
  const mid = await page.evaluate(() => { const i = getCutPlaneLocal(getActiveModel()); const b = state.cutHelper && state.cutHelper.children.find(c => c.userData.cutBlade);
    return { ok: !!i && !!b }; });
  await page.mouse.up();
  const pose1 = await vtx();
  check('a real mouse press on the ring starts a rotation, not a blade drag', grabbed === true);
  check('and the piece turns (a vertex of it has moved in the world)', Math.hypot(pose1[0] - pose0[0], pose1[1] - pose0[1], pose1[2] - pose0[2]) > 0.5, JSON.stringify({ before: pose0, after: pose1 }));
  check('the blade is still there, following it', mid.ok && await page.evaluate(() => !!state.cutHelper && !!getCutPlaneLocal(getActiveModel())));
  // the blade stands on the plane in the turned piece's frame
  const onPlane = await page.evaluate(() => {
    const m = getActiveModel(), info = getCutPlaneForSplit(m), mesh = cutMeshOf(m); state.scene.updateMatrixWorld(true);
    const blade = state.cutHelper.children.find(c => c.userData.cutBlade); const bc = new THREE.Box3().setFromObject(blade).getCenter(new THREE.Vector3());
    const W = cutWorldMatrix(info, mesh); const inv = W.clone().invert(); const local = bc.applyMatrix4(inv);
    return Math.abs(local[info.axis] - info.plane);
  });
  check('the blade sits on the cut plane of the piece as it now lies', onPlane < 1e-3, onPlane.toExponential(2));
  await clickAt(await crownNear(id, 0));
  const vr0 = await probe(id);
  const rc = await cutOnce(); const vr1 = await probeAll();
  check('and a cut after turning it works', /^Sized cut/.test(rc.st) && vr1.vol < vr0.vol && vr1.open === 0 && vr1.nm === 0, rc.st);
  await page.evaluate(() => { const c = document.getElementById('chk-cut-rotate'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(150);
  check('unticked: the rings are gone and Cut is still open', await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return (!g || !g.visible || !g.children.length) && state.cutterOpen && document.getElementById('cut-rotate-rings').hidden; }));

  console.log('closing Cut takes its rings with it');
  await page.evaluate(() => { const c = document.getElementById('chk-cut-rotate'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(150);
  const ringsOn = await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return !!(g && g.visible && g.children.length); });
  await page.evaluate(() => closeCutter(true));
  await page.waitForTimeout(150);
  const ringsOff = await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return { gone: !g || !g.visible || !g.children.length, flag: state.cutRotate, box: document.getElementById('chk-cut-rotate').checked }; });
  check('rings were up, then Cut closed: they are gone and the box is clear', ringsOn && ringsOff.gone && ringsOff.flag === false && ringsOff.box === false, JSON.stringify({ ringsOn, ringsOff }));

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

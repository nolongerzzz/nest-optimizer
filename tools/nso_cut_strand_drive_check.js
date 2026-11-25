/* nso_cut_strand_drive_check.js - the Cut card on a SPIRAL OF CORD: Dice
   cutting one strand and not the whole spiral, Notch mode, and the two
   Rotate piece switch. Real app, real Chromium, real
   manifold kernel, real mouse.
     node tools/nso_cut_strand_drive_check.js        exit 0 = every gate held

   The spiral is generated here (a 3.6 mm round cord, 2.9 mm between turns, 3
   turns): the same shape as a connector string, so a plane through its middle
   crosses six strands.

   WHAT IS PINNED
   - Dice, the knife: on a plane that crosses six turns it cuts the ONE clicked,
     through, with no kerf - two pieces that add back to the spiral; one Undo
     puts it back. (Chop at the same plane cuts every turn.)
   - The cut is clean: 0 open, 0 non-manifold edges.
   - Notch: fitted to the strand, from its edge; its volume grows in step with
     the notch width and depth, and the strand is not severed.
   - Sliders: width and depth for Notch, each a slider beside its number box,
     ranged to the piece, and the same number. Dice has none.
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
  const ef = adj ? null : cutEdgeFaults(displaySoupOf(g));         // a piece Chop's commit made has no raw soup
  return { vol: vol, tris: n, open: adj ? adj.openEdges : ef.open, nm: adj ? adj.nmEdges : ef.nm };
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
  const waitCut = () => page.waitForFunction(() => /(Sized|Notch|Dice) cut|Cut not made/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
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

  console.log('Dice: one strand, not the spiral');
  // Dice is a knife: nothing to set; it fits the strand clicked and cuts it through, no kerf
  const setDice = () => page.evaluate(() => { document.getElementById('btn-cut-blade-sized').click(); cutBladeState().follow = false; cutBladeRefresh(); });
  await setDice();
  const crown = await crownNear(id, 0);
  check('found a strand to click', !!crown, JSON.stringify(crown));
  await clickAt(crown);
  const sp = await spec();
  check('the plane crosses several strands and one is picked', sp && sp.isolate && sp.strands >= 5, JSON.stringify({ isolate: sp && sp.isolate, strands: sp && sp.strands }));
  check('the readout says Dice, through the strand clicked, 1 of several', /DICE .*through the strand you clicked \(1 of \d+ in the plane/.test(sp.ro), sp.ro);
  check('the strand is outlined in the helper', await page.evaluate(() => !!state.cutHelper.children.find(c => c.userData.cutStrand)));
  let r = await cutOnce();
  const after = await probeAll();
  check('it cuts that one turn: two pieces, not one per turn the plane crosses', after.n === 2, after.n + ' pieces; ' + r.st);
  check('no kerf: the pieces add up to the spiral exactly', near(after.vol, v0.vol, 1e-3), after.vol.toFixed(4) + ' vs ' + v0.vol.toFixed(4));
  check('the status says Dice, one of several, the others left whole', /^Dice cut - through the strand \(one of \d+ in the plane; the other \d+ are left whole\), no kerf/.test(r.st), r.st);
  check('the cut is clean: 0 open, 0 non-manifold edges', after.open === 0 && after.nm === 0, 'open ' + after.open + ', nm ' + after.nm);
  check('no warning on the status line', !/WARNING/.test(r.st), r.st);
  await page.click('#btn-undo');
  const back = await probeAll();
  check('one Undo puts the spiral back whole', back.n === 1 && near(back.vol, v0.vol, 1e-3), back.n + ' pieces, ' + back.vol.toFixed(3));
  // Chop at the same plane, for contrast: every turn it crosses
  await page.evaluate(() => { document.getElementById('btn-cut-blade-full').click(); });
  await clickAt(crown);
  await page.click('#btn-cut');
  await page.waitForFunction(() => /Cut @|Cut not made|Split failed/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const chop = await page.evaluate(() => { let bodies = 0; state.models.forEach(m => { bodies += 1; }); return bodies; });
  const chopVol = await probeAll();
  check('(Chop at the same plane cuts the whole spiral: more pieces\' worth of turns, all of it)', chopVol.n === 2 && near(chopVol.vol, v0.vol, 1e-2), chop + ' pieces (each half holds the several cut turns)');
  await page.click('#btn-undo');
  // a cut that severs is two Undo steps for the box cuts (the separation, then the cut); Notch never severs

  console.log('notch mode');
  await setNotch(1, 1);
  await clickAt(crown);
  const sn = await spec();
  check('the notch is fitted to the strand: its width is the strand\'s plus the margins', sn.notch && !sn.miss &&
    near(sn.sizes.width, sn.strand.hi[sn.wAxis] - sn.strand.lo[sn.wAxis] + 2 * 0.5, 1e-3), JSON.stringify(sn.sizes));
  check('the readout says nick, depth and which strand', /NOTCH .* 1 wide x 1 deep into the strand's edge, down from the top \(1 of \d+ strands\)/.test(sn.ro), sn.ro);
  r = await cutOnce(); const n1 = await probe(id); const V11 = v0.vol - n1.vol;
  check('a 1 x 1 nick comes out', /^Notch cut - 1 mm wide x 1 mm deep nick/.test(r.st) && V11 > 0.5 && V11 < 12, V11.toFixed(3) + ' mm3; ' + r.st);
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

  console.log('sliders: notch width and depth; Dice has none');
  const rng = id => page.evaluate(id => { const e = document.getElementById(id); return e ? { v: Number(e.value), min: Number(e.min), max: Number(e.max), shown: !!e.offsetParent } : null; }, id);
  await setDice(); await clickAt(crown);
  check('Dice shows no sizes: Width, Depth and Kerf are gone', await page.evaluate(() => !document.getElementById('cut-blade-width') && !document.getElementById('cut-blade-depth') && !document.getElementById('cut-blade-kerf')));
  await setNotch(1, 1); await clickAt(crown);
  const nW = await rng('cut-notch-width-s'), nD = await rng('cut-notch-depth-s');
  check('Notch shows a slider for its width and its depth', nW.shown && nD.shown, JSON.stringify({ nW, nD }));
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
  await setDice();
  await clickAt(await crownNear(id, 0));
  check('the rotate rings are not an option on the card any more', await page.evaluate(() => !document.getElementById('chk-cut-rotate') && !document.getElementById('cut-rotate-rings') && !document.getElementById('chk-cut-ring-fb') && !/Rotate rings/.test(document.getElementById('edit-card').textContent)));
  check('and none are drawn while Cut is open', await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return !g || !g.visible || !g.children.length; }));
  // The pose is baked into the geometry when a turn ends, so "did it turn" is read off a real vertex in the world.
  const vtx = () => page.evaluate(() => { const m = state.placed[0].mesh; m.updateMatrixWorld(true);
    return new THREE.Vector3().fromBufferAttribute(m.geometry.attributes.position, 100).applyMatrix4(m.matrixWorld).toArray().map(v => +v.toFixed(4)); });
  const pose0 = await vtx();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  check('arrow keys do not turn the piece (they are Cut\'s dials\')', JSON.stringify(await vtx()) === JSON.stringify(pose0));
  // the Rotate piece wheel turns it, the blade follows, and a cut after turning works
  await page.click('#btn-cut-rotate-plus');
  await page.fill('#cut-rotate-deg', '40'); await page.press('#cut-rotate-deg', 'Tab');
  await page.waitForTimeout(150);
  const pose1 = await vtx();
  check('the Rotate piece wheel turns the piece (a vertex of it has moved in the world)', Math.hypot(pose1[0] - pose0[0], pose1[1] - pose0[1], pose1[2] - pose0[2]) > 0.5, JSON.stringify({ before: pose0, after: pose1 }));
  check('the blade is still there, following it', await page.evaluate(() => !!state.cutHelper && !!getCutPlaneLocal(getActiveModel())));
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
  check('and a cut after turning it works: Dice through the strand, two pieces, nothing lost, clean', /^Dice cut/.test(rc.st) && vr1.n === 2 && near(vr1.vol, vr0.vol, 1e-2) && vr1.open === 0 && vr1.nm === 0, rc.st + ' | ' + JSON.stringify(vr1));
  await page.evaluate(() => closeCutter(true));
  await page.waitForTimeout(150);
  check('closing Cut leaves no ring group behind', await page.evaluate(() => { const g = state.scene.getObjectByName('nso-rotate-handles'); return !g || !g.visible || !g.children.length; }));

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

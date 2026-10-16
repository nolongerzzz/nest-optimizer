/* Drive check: the Findings card through the REAL app.
 *
 *   node tools/nso_findings_drive_check.js
 *
 * tools/nso_findings_test.js holds the grouping and the rows to NSO_Defects in
 * node. This drives the half that exists only in a browser, every action a
 * click on the shipped UI:
 *
 *   1. The card's rows and counts are the check's own: for the damage, open
 *      and repair fixtures, every number on the card is the number in
 *      nsoDefectsReport(), AND the number NSO_Defects.locate() gives in node
 *      on the same file - so the browser path and the engine agree, and the
 *      card adds nothing and drops nothing.
 *   2. Rings: one per problem, depth-test off, never picked, not children of
 *      the piece (the piece measures the same with them up), on the piece.
 *   3. Where the card sits: at the right edge, under the top-right buttons,
 *      clear of the plate's middle and of the open Check & repair panel.
 *   4. Check frames the camera on the piece; a row click flies it to the
 *      nearest problem of that kind and pulses that ring.
 *   5. Each fix button runs its fix on its own finding, and one Undo puts the
 *      piece back bit for bit. REPAIR is the Finish menu's Seal with Repair
 *      bit for bit; the Finish menu's Cap open faces still re-scans.
 *   6. The re-scan after every Cap, Seal and Solidify, from the card or the
 *      Finish menu: the before/after line, the rows, the green flash, and the
 *      words when nothing changed.
 *   9. THE FIX THAT FITS. Every finding names its own fix on its own button and
 *      runs it on that finding only (CAP, PATCH, BRIDGE, REPAIR, THICKEN OUT),
 *      the card re-scans, the row shows before -> after and turns green, Fix all
 *      runs every row's own fix in order, each fix is one Undo - on the damage
 *      fixtures, held to damage.json's counts before and 0 after. And ADD >
 *      Patch: hover outlines the hole under the cursor, a click fills it.
 *   7. Stale: the piece changing under the marks (Undo, or any bake) turns
 *      the card to "The piece changed. Check again", and Check again works.
 *   8. Non-solid: the open edges are declared, not a fault.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withApp, loadSTL, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');
const { readSTL } = require('./nso_stl_io.js');
const RL = require('./nso_repair_loop_lib.js');
const SHOTS = path.join(__dirname, 'repair-out');      // git-ignored; the card on the shredded sphere, before and after Fix all

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The engine in node, for the independent side of section 1. */
const NODE = (() => {
  const sb = { window: {} };
  vm.createContext(sb);
  for (const f of ['NSO_Repair.js', 'nso_patch.js', 'nso-defects.js', 'nso-findings.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  return sb.window;
})();
function nodeReport(rel, nonSolid) {
  const s = readSTL(fx(rel));
  const t = s.tris || s.soup || s;
  const r = NODE.NSO_Defects.locate(t instanceof Float32Array ? t : new Float32Array(t), { nonSolid: !!nonSolid });
  return { r, P: NODE.NSO_Findings.group(r) };
}

async function selectPiece(page, id) {
  await selectModel(page, id);
  await page.evaluate(i => {
    const idx = state.placed.findIndex(p => p && p.sourceId === i);
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
  }, id);
}
async function load(page, rel, opts) {
  const id = await loadSTL(page, fx(rel));
  await selectPiece(page, id);
  if (opts && opts.nonSolid) {
    await page.evaluate(i => window.nsoNonSolidSet(state.models.find(x => x.id === i), true), id);
  }
  return id;
}
/* Press Check through the real button and wait for THIS piece's check (see
   tools/nso_defect_overlay_drive_check.js on why the wait is on whose check
   is up, never on "a report exists"), and for the framing flight to land. */
async function pressCheck(page, id) {
  await openFinishMenu(page);
  await page.click('#btn-check-defects');
  await page.waitForFunction(i => window.nsoDefectsShownFor() === i && nsoFindingsState().modelId === i, id, { timeout: 60000 });
  await page.waitForFunction(() => !nsoFindingsState().flying, null, { timeout: 5000 });
}
const card = page => page.evaluate(() => nsoFindingsState());
const rawBytes = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  const raw = getModelRawSoup(m);
  return Array.from(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)).join(',');
}, id);
const geoBytes = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  const a = m.geometry.attributes.position.array;
  return Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).join(',');
}, id);
async function hideCheck(page) {
  await page.evaluate(() => { if (window.nsoDefectsShownFor() != null) window.nsoDefectsHide(); });
}
const num = (s, re) => { const m = re.exec(s); return m ? +m[1] : null; };

withApp(async (page, logs) => {
  console.log('findings drive check\n');

  /* ---------------------------------------------------------------- *
   * 1-2. the rows and the rings, on the damage, open and repair fixtures
   * ---------------------------------------------------------------- */
  console.log('1. the card says what the check found, and nothing else');
  const CASES = [
    'damage/shape-sphere_holes-shredded.stl',
    'damage/shape-sphere_nm-duplicate-flipped.stl',
    'damage/shape-torus_weld-shredded.stl',
    'damage/shape-sphere_winding-flip.stl',
    'open/open_clip_selfint.stl',
    'open/thin_shell_cup_thin.stl',
    'open/thin_shell_cup_cracked.stl',
    'repair/synth_flap.stl',
    'repair/synth_hole.stl',
    'box-20mm.stl'
  ];
  for (const rel of CASES) {
    const id = await load(page, rel);
    await pressCheck(page, id);
    const st = await card(page);
    const rep = await page.evaluate(() => {
      const r = nsoDefectsReport();
      return { verdict: r.verdict, openEdges: r.openEdges, nonManifoldEdges: r.nonManifoldEdges,
               pierce: r.pierce, thinFaces: r.wall.thinFaces, minWallMm: r.wall.minWallMm,
               flippedEdges: r.flippedEdges, degenerateTris: r.degenerateTris };
    });
    const { r: nr, P: nP } = nodeReport(rel);
    const tag = path.basename(rel, '.stl') + ': ';
    check(tag + 'the card is open', st.open && !st.stale);
    check(tag + 'browser report = node report',
          rep.openEdges === nr.openEdges && rep.nonManifoldEdges === nr.nonManifoldEdges &&
          rep.pierce === nr.pierce && rep.thinFaces === nr.wall.thinFaces && rep.verdict === nr.verdict,
          JSON.stringify(rep));
    const row = k => st.rows.find(x => x.kind === k);
    const o = row('open'), n = row('nonManifold'), pc = row('pierce'), th = row('thin'), cl = row('clean');
    check(tag + 'open row', rep.openEdges
      ? !!o && num(o.title, /, (\d+) open edge/) === rep.openEdges && num(o.title, /^(\d+) hole/) === nP.open.length
      : !o, o && o.title);
    check(tag + 'doubled/pinched row', rep.nonManifoldEdges
      ? !!n && num(n.title, /(\d+) doubled or pinched/) === rep.nonManifoldEdges && num(n.title, /^(\d+) place/) === nP.nonManifold.length
      : !n, n && n.title);
    check(tag + 'piercing row', rep.pierce
      ? !!pc && num(pc.title, /(\d+) piercing pair/) === rep.pierce && num(pc.title, /^(\d+) place/) === nP.pierce.length
      : !pc, pc && pc.title);
    check(tag + 'thin row', rep.thinFaces
      ? !!th && num(th.title, /(\d+) faces? under/) === rep.thinFaces && th.title.indexOf(rep.minWallMm.toFixed(3)) >= 0
      : !th, th && th.title);
    check(tag + 'green row exactly when it passes', !!cl === (rep.verdict === 'PASS'), rep.verdict);
    const nodeRows = NODE.NSO_Findings.rows(nr, nP);
    const fixesOf = rs => [].concat(...rs.map(x => (x.items || []).map(i => i.fix + ':' + i.fixLabel.replace(/ \+.*$/, ''))));
    check(tag + 'the card offers the same fix for each finding as the engine in node',
          JSON.stringify(fixesOf(st.rows)) === JSON.stringify(fixesOf(nodeRows)), JSON.stringify(fixesOf(st.rows)));
    check(tag + 'REPAIR on doubled edges, a button on every hole, none on piercing or clean',
          (!n || n.items.some(i => i.fix === 'sealRepair' && /whole piece/.test(i.text))) &&
          (!o || o.items.length > 0) && (!pc || (!pc.items.length && pc.handledBy)) && (!cl || !cl.items.length));
    if (rep.verdict === 'FAIL' && !o && !n && !pc && !th) {
      check(tag + 'a FAIL with nothing to ring says what it counted', /wound|degenerate/.test(st.unplaced || ''), st.unplaced);
    }

    // rings: one per problem, in the scene, never on the piece
    const rings = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      const grp = state.scene.children.find(c => c.name === 'nso-findings-rings');
      const out = { n: 0, labels: 0, depthOff: true, stubbed: true, onPiece: 0, inScene: !!grp };
      if (grp) {
        for (const c of grp.children) {
          if (c.isSprite) out.labels++; else out.n++;
          if (c.material.depthTest !== false) out.depthOff = false;
          if (c.raycast === THREE.Mesh.prototype.raycast || c.raycast === THREE.Sprite.prototype.raycast) out.stubbed = false;
        }
      }
      p.mesh.traverse(c => { if (/^nso-findings/.test(c.name)) out.onPiece++; });
      // a ray through every ring centre hits the piece or nothing - never a ring
      const st = nsoFindingsState();
      let ringHits = 0;
      for (const pb of st.problems) {
        const w = new THREE.Vector3(pb.world[0], pb.world[1], pb.world[2]);
        const dir = w.clone().sub(state.camera.position).normalize();
        const rc = new THREE.Raycaster(state.camera.position.clone(), dir);
        ringHits += rc.intersectObjects(state.scene.children, true).filter(h => /^nso-findings/.test(h.object.name)).length;
      }
      out.ringHits = ringHits;
      // on the piece: every ring centre inside the piece's own box (grown by a hair)
      p.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.attributes.position).applyMatrix4(p.mesh.matrixWorld).expandByScalar(0.01);
      out.outside = st.problems.filter(pb => !box.containsPoint(new THREE.Vector3(pb.world[0], pb.world[1], pb.world[2]))).length;
      return out;
    }, id);
    const places = nP.open.length + nP.nonManifold.length + nP.pierce.length + nP.thin.length + nP.gap.length;
    check(tag + 'one ring and one number per problem', rings.n === places && rings.labels === places && st.problems.length === places,
          rings.n + ' rings, ' + rings.labels + ' numbers, ' + places + ' problems');
    check(tag + 'rings drawn through the piece and never picked', rings.depthOff && rings.stubbed && rings.ringHits === 0);
    check(tag + 'rings live in the scene, not on the piece', rings.inScene || places === 0);
    check(tag + 'no ring is a child of the piece', rings.onPiece === 0, rings.onPiece);
    check(tag + 'every ring centre is on the piece', rings.outside === 0, rings.outside + ' outside');
    await hideCheck(page);
  }

  /* The piece measures the same with the rings up as down. */
  {
    const id = await load(page, 'damage/shape-sphere_holes-shredded.stl');
    const size = () => page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      return new THREE.Box3().setFromObject(p.mesh).getSize(new THREE.Vector3()).toArray();
    }, id);
    const before = await size();
    await pressCheck(page, id);
    const during = await size();
    check('Box3.setFromObject(piece) is the same with the rings up',
          before.every((v, k) => Math.abs(v - during[k]) < 1e-9), JSON.stringify(before) + ' / ' + JSON.stringify(during));

    /* ------------------------------------------------------------ *
     * 3. where the card sits
     * ------------------------------------------------------------ */
    console.log('\n3. the card is docked at the right edge, under the top-right corner\'s panel');
    const geo = await page.evaluate(() => {
      const r = el => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const vp = r(document.querySelector('.viewport-section'));
      const c = r(document.getElementById('findings-card'));
      /* Shell v3: Check lives in the column's Check & repair menu, and the
         top-right corner holds the pinned Plate & pieces panel. */
      const fm = document.getElementById('menu-repair');
      const sum = r(document.getElementById('plate-panel'));
      const body = r(fm.querySelector('.vp-menu-body'));
      return { vp, c, sum, body, finishOpen: fm.open };
    });
    const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    check('below the top-right panel', geo.c.t >= geo.sum.b, 'card top ' + geo.c.t + ', Plate & pieces bottom ' + geo.sum.b);
    const mid = { l: (geo.vp.l + geo.vp.r) / 2 - 1, r: (geo.vp.l + geo.vp.r) / 2 + 1, t: (geo.vp.t + geo.vp.b) / 2 - 1, b: (geo.vp.t + geo.vp.b) / 2 + 1 };
    check('away from the plate: clear of the viewport centre', !overlap(geo.c, mid));
    check('with Check & repair open, beside its panel and not under it', geo.finishOpen && !overlap(geo.c, geo.body),
          JSON.stringify(geo.c) + ' vs ' + JSON.stringify(geo.body));
    await page.click('#menu-repair > summary');   // shut Check & repair
    await page.waitForFunction(() => !document.getElementById('menu-repair').open);
    await page.waitForTimeout(50);
    const docked = await page.evaluate(() => {
      const vp = document.querySelector('.viewport-section').getBoundingClientRect();
      const c = document.getElementById('findings-card').getBoundingClientRect();
      return { gap: vp.right - c.right, left: c.left, mid: (vp.left + vp.right) / 2, top: c.top,
               sumBottom: document.getElementById('plate-panel').getBoundingClientRect().bottom };
    });
    check('with Check & repair shut, flush to the right edge', docked.gap <= 12, docked.gap + ' px from the edge');
    check('in the right half of the viewport', docked.left > docked.mid, 'card left ' + docked.left + ', middle ' + docked.mid);
    check('still under the top-right panel', docked.top >= docked.sumBottom);
    check('it stays open until closed', (await card(page)).open);

    /* ------------------------------------------------------------ *
     * 4. the camera
     * ------------------------------------------------------------ */
    console.log('\n4. Check frames the piece; a row click flies to the nearest problem');
    await page.evaluate(() => { framePlateHome(); });
    await hideCheck(page);
    const home = await page.evaluate(() => state.controls.target.toArray());
    await pressCheck(page, id);
    const framed = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      const box = new THREE.Box3().setFromBufferAttribute(p.mesh.geometry.attributes.position).applyMatrix4(p.mesh.matrixWorld);
      const t = state.controls.target;
      const r = box.getBoundingSphere(new THREE.Sphere()).radius;
      return { inBox: box.clone().expandByScalar(r).containsPoint(t), dist: state.camera.position.distanceTo(t), r,
               moved: t.toArray() };
    }, id);
    check('pressing Check moved the camera onto the piece', framed.inBox &&
          Math.hypot(framed.moved[0] - home[0], framed.moved[1] - home[1], framed.moved[2] - home[2]) > 1e-3,
          JSON.stringify(home) + ' -> ' + JSON.stringify(framed.moved));
    check('and close enough to see it', framed.dist < framed.r * 8, 'distance ' + framed.dist.toFixed(1) + ' for a ' + framed.r.toFixed(1) + ' mm piece');

    // put the camera beside problem 2, so "nearest" has to be computed
    const st0 = await card(page);
    const p2 = st0.problems.find(p => p.kind === 'open' && p.number === 2);
    await page.evaluate(w => {
      const t = new THREE.Vector3(w[0], w[1], w[2]);
      state.controls.target.set(0, 0, 0);
      state.camera.position.copy(t.clone().multiplyScalar(6).add(new THREE.Vector3(0, 0.01, 0)));
      state.controls.update();
    }, p2.world);
    const nearest = await page.evaluate(() => {
      const st = nsoFindingsState(), c = state.camera.position;
      let best = null, bd = Infinity;
      for (const p of st.problems) if (p.kind === 'open') {
        const d = Math.hypot(p.world[0] - c.x, p.world[1] - c.y, p.world[2] - c.z);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    });
    const t0 = await page.evaluate(() => state.controls.target.toArray());
    await page.click('#findings-rows .findings-row[data-kind=open] .findings-go');
    await page.waitForFunction(() => !nsoFindingsState().flying, null, { timeout: 5000 });
    const after = await page.evaluate(() => ({ t: state.controls.target.toArray(), st: nsoFindingsState() }));
    const d = Math.hypot(after.t[0] - nearest.world[0], after.t[1] - nearest.world[1], after.t[2] - nearest.world[2]);
    check('a row click moves the camera', Math.hypot(after.t[0] - t0[0], after.t[1] - t0[1], after.t[2] - t0[2]) > 0.1);
    check('onto the nearest problem of that kind', d < 1e-6 && after.st.focus.number === nearest.number,
          'problem ' + after.st.focus.number + ' (nearest ' + nearest.number + '), off by ' + d.toExponential(2));
    check('and flashes it', after.st.problems.find(p => p.kind === 'open' && p.number === nearest.number).pulsing);
    await hideCheck(page);
  }

  /* ---------------------------------------------------------------- *
   * 5-6. the fix buttons are the Finish menu's, and the re-scan
   * ---------------------------------------------------------------- */
  console.log('\n5. CAP from the card closes that hole; the Finish menu\'s Cap open faces still re-scans; Undo bit for bit');
  {
    const id = await load(page, 'repair/synth_tjunction.stl');
    const raw0 = await rawBytes(page, id), geo0 = await geoBytes(page, id);
    await pressCheck(page, id);
    let st = await card(page);
    check('the hole row offers CAP', st.rows.some(r => r.items.some(i => i.fix === 'cap' && i.fixLabel === 'CAP')));
    await page.click('#findings-rows .findings-fix[data-fix=cap]');
    st = await card(page);
    const rawA = await rawBytes(page, id);
    check('the card\'s Cap changed the piece', rawA !== raw0);
    check('the re-scan ran by itself: Before / Now', st.result && st.result.text === 'Cap: Before: 3 open edges. Now: 0.',
          st.result && st.result.text);
    const rep = await page.evaluate(() => nsoDefectsReport().openEdges);
    check('the rows are the new check\'s', rep === 0 && !st.rows.some(r => r.kind === 'open') && st.modelId === id && !st.stale);
    check('the fixed hole flashes green', st.result.fixed === 1 && st.fixedFlashes === 1, st.fixedFlashes);
    check('and the row says so, before -> after, in green',
          st.done.length === 1 && st.done[0].ok && /3 open edges\. Now: 0/.test(st.done[0].line) &&
          await page.evaluate(() => !!document.querySelector('#findings-done .findings-done-row.is-fixed')), JSON.stringify(st.done));
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the fix\'s own status line is left standing', /^Cap closed 1 opening - open edges 3\u21920/.test(status), JSON.stringify(status));
    await page.waitForFunction(() => nsoFindingsState().fixedFlashes === 0, null, { timeout: 5000 });
    check('and the flash fades away', true);

    await page.click('#btn-undo');
    await page.waitForFunction(() => nsoFindingsState().stale, null, { timeout: 5000 });
    check('one Undo: the piece is back bit for bit', (await rawBytes(page, id)) === raw0 && (await geoBytes(page, id)) === geo0);
    st = await card(page);
    check('and the card says the piece changed', st.stale && st.rows.length === 0 &&
          await page.isVisible('#findings-stale') && /The piece changed\. Check again/.test(await page.textContent('#findings-stale')));
    check('it keeps the last action\'s before/after until the next one', st.result && /Before: 3 open edges/.test(st.result.text));

    // the Finish menu's own Cap open faces: unchanged, and re-scanned the same way
    await openFinishMenu(page);
    await page.click('#btn-cap-open');
    st = await card(page);
    check('Cap open faces from the Finish menu re-scans', st.result && /^Cap open faces: Before: 3 open edges\. Now: \d+\./.test(st.result.text) && !st.stale,
          st.result && st.result.text);
    await page.click('#btn-undo');
    await page.waitForFunction(() => nsoFindingsState().stale, null, { timeout: 5000 });
    check('Undo after the Finish-menu Cap: back bit for bit', (await rawBytes(page, id)) === raw0);

    console.log('\n   Check again');
    await page.click('#btn-findings-recheck');
    await page.waitForFunction(i => nsoFindingsState().modelId === i && !nsoFindingsState().stale, id, { timeout: 60000 });
    st = await card(page);
    check('Check again: a fresh check, the hole back on the card', st.rows.some(r => r.kind === 'open' && /3 open edges/.test(r.title)));
    await hideCheck(page);
  }

  console.log('\n5b. Seal with Repair from the card = Seal with Repair ticked in the Finish menu');
  {
    const id = await load(page, 'damage/shape-sphere_nm-duplicate.stl');
    const raw0 = await rawBytes(page, id);
    await pressCheck(page, id);
    const tick0 = await page.evaluate(() => document.getElementById('chk-seal-repair').checked);
    await page.click('#findings-rows .findings-fix[data-fix=sealRepair]');
    const rawA = await rawBytes(page, id);
    let st = await card(page);
    check('the card\'s Seal with Repair changed the piece', rawA !== raw0);
    check('the Repair tick is put back as it was', (await page.evaluate(() => document.getElementById('chk-seal-repair').checked)) === tick0);
    check('re-scan: Before / Now on the doubled edges',
          st.result && st.result.text === 'Seal with Repair: Before: 3 doubled or pinched edges. Now: 0.', st.result && st.result.text);
    check('rows updated: nothing wrong found', st.rows.length === 1 && st.rows[0].kind === 'clean');
    check('fixed place flashes green', st.result.fixed === 1);
    await page.click('#btn-undo');
    await page.waitForFunction(() => nsoFindingsState().stale, null, { timeout: 5000 });
    check('one Undo: back bit for bit', (await rawBytes(page, id)) === raw0);

    await openFinishMenu(page);
    await page.evaluate(() => { document.getElementById('chk-seal-repair').checked = true; });
    await page.click('#btn-seal');
    await page.evaluate(t => { document.getElementById('chk-seal-repair').checked = t; }, tick0);
    check('Seal with Repair from the Finish menu gives the same bytes', (await rawBytes(page, id)) === rawA);
    st = await card(page);
    check('and re-scans the same way', st.result && st.result.text === 'Seal with Repair: Before: 3 doubled or pinched edges. Now: 0.');
    await hideCheck(page);
  }

  console.log('\n6. Solidify from the Finish menu re-scans; so does a press that changes nothing');
  {
    const id = await load(page, 'damage/shape-cylinder_holes-light.stl');
    await openFinishMenu(page);
    // no Check pressed first: the "before" is taken by the re-scan itself
    await page.click('#btn-solidify');
    const st = await card(page);
    const rep = await page.evaluate(() => { const r = nsoDefectsReport(); return r && { open: r.openEdges, nm: r.nonManifoldEdges }; });
    const said = await page.evaluate(() => document.getElementById('status').textContent);
    check('Solidify opened the card with a fresh check', st.open && !st.stale && st.modelId === id && !!rep);
    const m = /^Solidify(?: changed nothing on the piece\.|: Before: (\d+) open edges?\. Now: (\d+)\.)/.exec(st.result && st.result.text || '');
    check('the card has Solidify\'s before/after', !!m, st.result && st.result.text);
    if (m && m[1] !== undefined) {
      check('Before is the piece as loaded (16 open edges), Now is the report', +m[1] === 16 && +m[2] === rep.open, m[0] + ' / ' + rep.open);
      const s = /open (\d+)→(\d+)/.exec(said);
      check('and agrees with Solidify\'s own status line', s && +s[1] === 16 && +s[2] === rep.open, said);
    }
    await hideCheck(page);
  }
  {
    const id = await load(page, 'repair/synth_hole.stl');
    await pressCheck(page, id);
    const raw0 = await rawBytes(page, id);
    await page.click('#btn-cap-open');      // the Finish menu's whole-piece Cap: it cannot see this 3-edge hole
    const st = await card(page);
    check('a fix that changes nothing leaves the piece alone', (await rawBytes(page, id)) === raw0);
    check('and says so in words, with the tool\'s own reason',
          st.result && st.result.changed === false &&
          st.result.text === 'Cap open faces changed nothing on the piece. It said: No open face to cap', st.result && st.result.text);
    check('the rows stay up', st.rows.some(r => r.kind === 'open') && !st.stale);
    await hideCheck(page);
  }

  /* ---------------------------------------------------------------- *
   * 7. stale: any bake under the marks
   * ---------------------------------------------------------------- */
  console.log('\n7. a bake under the marks turns the card stale');
  {
    const id = await load(page, 'open/open_clip.stl');
    await pressCheck(page, id);
    const stale = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      const mesh = new THREE.Mesh(p.mesh.geometry.clone(), p.mesh.material);
      mesh.position.copy(p.mesh.position);
      mesh.userData.placedIndex = p.mesh.userData.placedIndex;
      state.modelGroup.remove(p.mesh);
      state.modelGroup.add(mesh);
      p.mesh = mesh;
      // no refresh call: the card notices on its own
      return true;
    }, id);
    await page.waitForFunction(() => nsoFindingsState().stale, null, { timeout: 3000 }).catch(() => {});
    const st = await card(page);
    check('the card notices the swap by itself', stale && st.stale && st.rows.length === 0);
    check('and drops the rings with the marks', await page.evaluate(() =>
      !state.scene.children.some(c => c.name === 'nso-findings-rings') && window.nsoDefectsReport() === null));
    check('the stale line and its button are on the card',
          /The piece changed\. Check again/.test(await page.textContent('#findings-stale')) && await page.isVisible('#btn-findings-recheck'));
    await page.click('#btn-findings-close');
    check('closing the card shuts it', !(await card(page)).open && !(await page.isVisible('#findings-card')));
  }

  /* ---------------------------------------------------------------- *
   * 8. non-solid
   * ---------------------------------------------------------------- */
  console.log('\n8. non-solid: open edges declared, not a fault');
  {
    const id = await load(page, 'open/open_clip.stl', { nonSolid: true });
    await pressCheck(page, id);
    const st = await card(page);
    const o = st.rows.find(r => r.kind === 'open');
    check('the open row is declared', o && o.declared && /declared/.test(o.title) && /50 open edges/.test(o.title), o && o.title);
    check('with no fix button', o && !o.items.length);
    check('and the green row still shows', st.rows.some(r => r.kind === 'clean'));
    const color = await page.evaluate(() => {
      const g = state.scene.children.find(c => c.name === 'nso-findings-rings');
      const r = g && g.children.find(c => !c.isSprite);
      return r ? r.material.color.getHex() : null;
    });
    check('its ring is slate, not red', color === 0x94a3b8, color && color.toString(16));
    check('the 1 px red lines stay as they were', await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      const g = p.mesh.children.find(c => c.name === 'nso-defect-marks');
      const l = g && g.children.find(c => c.name === 'nso-defect-open');
      return !!l && l.material.color.getHex() === 0xff2d2d;
    }, id));

    // the toggle still closes everything
    await openFinishMenu(page);
    await page.click('#btn-check-defects');
    const shut = await card(page);
    check('Hide check closes the card too', !shut.open && await page.evaluate(() => !state.scene.children.some(c => c.name === 'nso-findings-rings')));
  }

  /* ---------------------------------------------------------------- *
   * 9. the fix that fits
   * ---------------------------------------------------------------- */
  console.log('\n9. every finding names its own fix, runs it on that finding only, and re-scans');
  const rawSoup = (page, id) => page.evaluate(i => Array.from(getModelRawSoup(state.models.find(x => x.id === i))), id).then(a => new Float32Array(a));
  const undoDepth = page => page.evaluate(() => state.undoStack.length);
  const undoTypes = (page, n) => page.evaluate(k => state.undoStack.slice(-k).map(u => u.type), n);
  const dmg = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'damage', 'damage.json'), 'utf8')).entries;
  const reportNow = page => page.evaluate(() => {
    const r = nsoDefectsReport();
    return r && { verdict: r.verdict, open: r.openEdges, nm: r.nonManifoldEdges, wind: r.flippedEdges, degenerate: r.degenerateTris,
                  pierce: r.pierce, thin: r.wall.thinFaces, gaps: r.gaps.length, tris: r.soupTris };
  });
  const promised = (stl) => { const e = dmg.find(x => x.stl === stl).expected; return { open: e.open_edges, nm: e.nonmanifold_edges, wind: e.inconsistent_winding_edges, tris: e.triangles }; };
  const undoToStale = async () => { await page.click('#btn-undo'); await page.waitForFunction(() => nsoFindingsState().stale, null, { timeout: 5000 }); };

  console.log('\n9a. shape-sphere_hole: one row, PATCH');
  {
    const rel = 'damage/shape-sphere_hole.stl', id = await load(page, rel);
    const raw0 = await rawBytes(page, id), soup0 = await rawSoup(page, id), d0 = await undoDepth(page);
    await pressCheck(page, id);
    let st = await card(page), rep = await reportNow(page);
    const want = promised('shape-sphere_hole.stl');
    check('before: the counts damage.json promises', rep.open === want.open && rep.nm === want.nm && rep.wind === want.wind && rep.tris === want.tris, JSON.stringify(rep));
    check('one row, one button, and it reads PATCH', st.rows.length === 1 && st.rows[0].items.length === 1 && st.rows[0].items[0].fixLabel === 'PATCH' &&
          await page.textContent('#findings-rows .findings-fix') === 'PATCH', JSON.stringify(st.rows.map(r => r.items.map(i => i.fixLabel))));
    check('in plain words: Hole, curved rim', st.rows[0].items[0].text === 'Hole, curved rim', st.rows[0].items[0].text);
    await page.click('#findings-rows .findings-fix[data-fix=patch]');
    st = await card(page); rep = await reportNow(page);
    check('after: 0 open edges, 0 non-manifold, 0 mis-wound, and Check passes', rep.open === 0 && rep.nm === 0 && rep.wind === 0 && rep.verdict === 'PASS', JSON.stringify(rep));
    const soup1 = await rawSoup(page, id), topo = NODE.NSO_Patch.topology(soup1);
    check('one closed manifold shell', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === 1 && topo.euler === 2, JSON.stringify(topo));
    check('the piece\'s own triangles are kept byte for byte', RL.sameBytes(soup1, soup0, soup0.length));
    const steps = RL.rimNormalSteps(NODE.NSO_Patch, soup1, soup0.length / 9);
    check('the fill\'s rim normals match the neighbours within 5 degrees', steps.length === 7 && steps[steps.length - 1] <= 5, 'worst ' + steps[steps.length - 1].toFixed(2));
    check('the row shows before -> after and turns green', st.done.length === 1 && st.done[0].ok && /^Before: 7 open edges\. Now: 0\.$/.test(st.done[0].line) &&
          await page.evaluate(() => !!document.querySelector('#findings-done .findings-done-row.is-fixed')), JSON.stringify(st.done));
    check('the card says what it did', st.result.text === 'Patch: Before: 7 open edges. Now: 0.', st.result.text);
    check('it is one Undo, of its own type', (await undoDepth(page)) === d0 + 1 && (await undoTypes(page, 1))[0] === 'patchReplace');
    await undoToStale();
    check('one Undo puts the piece back bit for bit', (await rawBytes(page, id)) === raw0 && (await undoDepth(page)) === d0);
    await hideCheck(page);
  }

  console.log('\n9b. shape-sphere_holes-shredded: a row per cluster, each fix on its own cluster, Fix all');
  {
    const rel = 'damage/shape-sphere_holes-shredded.stl', id = await load(page, rel);
    const raw0 = await rawBytes(page, id), d0 = await undoDepth(page);
    await pressCheck(page, id);
    let st = await card(page), rep = await reportNow(page);
    const want = promised('shape-sphere_holes-shredded.stl');
    check('before: the counts damage.json promises (221 open edges)', rep.open === want.open && rep.nm === want.nm && rep.wind === want.wind && rep.tris === want.tris, JSON.stringify(rep));
    const items = st.rows.find(r => r.kind === 'open').items;
    check('one item per cluster, each PATCH, numbered like the rings', items.length === 2 && items.every(i => i.fixLabel === 'PATCH') &&
          JSON.stringify(items.map(i => i.numbers)) === '[[1],[2]]', JSON.stringify(items.map(i => [i.fixLabel, i.numbers])));
    check('Fix all offers both', st.fixAll === 'Fix all (2)', st.fixAll);
    // first one alone: it takes its own cluster and leaves the other
    await page.click('#findings-rows .findings-fix[data-fix=patch]');
    const raw1 = await rawBytes(page, id);
    st = await card(page); rep = await reportNow(page);
    check('the first PATCH took its own cluster only', rep.open > 0 && rep.open < 221 && st.rows.find(r => r.kind === 'open').items.length === 1,
          'open ' + rep.open + ', ' + st.rows.find(r => r.kind === 'open').items.length + ' item left');
    check('and one Undo of its own', (await undoDepth(page)) === d0 + 1);
    await undoToStale();
    check('which puts the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    await page.click('#btn-findings-recheck');
    await page.waitForFunction(i => nsoFindingsState().modelId === i && !nsoFindingsState().stale, id, { timeout: 60000 });
    // Fix all (screenshots of the card before and after, to the git-ignored tools/repair-out/)
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => document.querySelectorAll('details.vp-menu').forEach(x => { x.open = false; }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'shredded-before-fix-all.png') });
    await page.click('#btn-findings-fixall');
    st = await card(page); rep = await reportNow(page);
    await page.evaluate(() => document.querySelectorAll('details.vp-menu').forEach(x => { x.open = false; }));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOTS, 'shredded-after-fix-all.png') });
    check('Fix all: 0 open edges, 0 non-manifold, 0 mis-wound', rep.open === 0 && rep.nm === 0 && rep.wind === 0, JSON.stringify(rep));
    const patches = st.done.filter(d => d.fix === 'patch');
    check('both PATCH rows ran and turned green, one line each', patches.length === 2 && patches.every(d => d.ok), JSON.stringify(st.done.map(d => [d.fix, d.ok])));
    check('the first said 221 open edges before, the last 0 after', /^Before: 221 open edges\. Now: \d+\./.test(patches[0].line) && /Now: 0\./.test(patches[1].line), patches.map(p => p.line).join(' | '));
    const nPatch = (await undoTypes(page, 3)).filter(t => t === 'patchReplace').length;
    check('each fix is its own Undo', nPatch === 2 && (await undoDepth(page)) >= d0 + 2, (await undoTypes(page, 3)).join(','));
    const soup = await rawSoup(page, id), topo = NODE.NSO_Patch.topology(soup);
    check('closed, manifold, wound one way, by the engine in node', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(topo));
    const can = RL.canonical(soup, 'drive_shred');
    check('and by tools/mesh_validate.py', can.open === 0 && can.nm === 0 && can.winding === 0, JSON.stringify(can));
    check('Fix all says how it went', /^Fix all: \d+ of \d+ fixes? cleared what it was for\./.test(st.result.text), st.result.text);
    for (let k = 0; k < nPatch; k++) await page.click('#btn-undo');
    check('two Undos put the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    await hideCheck(page);
  }

  console.log('\n9c. shape-tube_severed: one row, BRIDGE, one closed tube');
  {
    const rel = 'damage/shape-tube_severed.stl', id = await load(page, rel);
    const raw0 = await rawBytes(page, id), d0 = await undoDepth(page);
    await pressCheck(page, id);
    let st = await card(page), rep = await reportNow(page);
    const want = promised('shape-tube_severed.stl');
    check('before: the counts damage.json promises (a closed solid, 0 open)', rep.open === want.open && rep.nm === want.nm && rep.wind === want.wind && rep.tris === want.tris && rep.verdict === 'PASS', JSON.stringify(rep));
    check('one row, and it reads BRIDGE', st.rows.length === 1 && st.rows[0].kind === 'gap' && st.rows[0].advisory && st.rows[0].items.length === 1 &&
          st.rows[0].items[0].fixLabel === 'BRIDGE' && await page.textContent('#findings-rows .findings-fix') === 'BRIDGE', JSON.stringify(st.rows.map(r => [r.kind, r.items.map(i => i.fixLabel)])));
    check('in plain words', st.rows[0].items[0].text === 'Gap 1.0 mm between two faces', st.rows[0].items[0].text);
    check('a gap is advisory: Fix all does not offer it', st.fixAll === null, st.fixAll);
    check('it has a ring in the slot', st.problems.length === 1 && st.problems[0].kind === 'gap');
    await page.click('#findings-rows .findings-fix[data-fix=bridge]');
    st = await card(page); rep = await reportNow(page);
    const soup = await rawSoup(page, id), topo = NODE.NSO_Patch.topology(soup);
    check('after: one closed tube (one shell, Euler 0), 0 open, 0 non-manifold', topo.shells === 1 && topo.euler === 0 && topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(topo));
    check('Check passes with no gap left', rep.verdict === 'PASS' && rep.gaps === 0, JSON.stringify(rep));
    check('the row turned green', st.done.length === 1 && st.done[0].ok && /Before: 1 gap between faces\. Now: 0\./.test(st.done[0].line), JSON.stringify(st.done));
    check('one Undo, of its own type', (await undoDepth(page)) === d0 + 1 && (await undoTypes(page, 1))[0] === 'bridgeReplace');
    await undoToStale();
    check('which puts the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    await hideCheck(page);
  }

  console.log('\n9d. a flat-topped box with a hole in the lid: CAP');
  {
    const id = await load(page, 'repair/box_lid_hole.stl');
    const raw0 = await rawBytes(page, id), d0 = await undoDepth(page);
    await pressCheck(page, id);
    let st = await card(page);
    check('one row, and it reads CAP', st.rows.length === 1 && st.rows[0].items.length === 1 && st.rows[0].items[0].fixLabel === 'CAP' &&
          st.rows[0].items[0].text === 'Hole, flat rim', JSON.stringify(st.rows.map(r => r.items.map(i => i.fixLabel + ':' + i.text))));
    await page.click('#findings-rows .findings-fix[data-fix=cap]');
    st = await card(page);
    const rep = await reportNow(page), soup = await rawSoup(page, id);
    check('after: 0 open edges, Check passes', rep.open === 0 && rep.nm === 0 && rep.verdict === 'PASS', JSON.stringify(rep));
    check('the cap is in the lid\'s plane', (() => { let off = 0; for (let t = 3006; t < soup.length / 9; t++) for (let k = 0; k < 3; k++) off = Math.max(off, Math.abs(soup[t * 9 + k * 3 + 2] - 12)); return soup.length / 9 > 3006 && off === 0; })());
    check('one Undo, of its own type', (await undoDepth(page)) === d0 + 1 && (await undoTypes(page, 1))[0] === 'capReplace');
    await undoToStale();
    check('which puts the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    await hideCheck(page);
  }

  console.log('\n9e. thin_shell_cup_thin: THICKEN OUT, with the mm filled in');
  {
    const id = await load(page, 'open/thin_shell_cup_thin.stl');
    const raw0 = await rawBytes(page, id), d0 = await undoDepth(page);
    await pressCheck(page, id);
    let st = await card(page);
    const thin = st.rows.find(r => r.kind === 'thin'), open = st.rows.find(r => r.kind === 'open');
    check('the thin row reads THICKEN OUT with the mm that reaches two nozzle widths', thin && thin.items.length === 1 && thin.items[0].fix === 'thickenOut' &&
          thin.items[0].mm === 0.56 && thin.items[0].fixLabel === 'THICKEN OUT +0.56 mm' && thin.items[0].scope === 'whole piece', JSON.stringify(thin && thin.items));
    check('and the two rims are one BRIDGE', open.items.length === 1 && open.items[0].fixLabel === 'BRIDGE' && open.items[0].text === 'Gap 1.2 mm between two edges', JSON.stringify(open.items));
    const box0 = await page.inputValue('#inp-thicken-mm');
    await page.click('#findings-rows .findings-fix[data-fix=thickenOut]');
    st = await card(page);
    const rep = await reportNow(page);
    check('THICKEN OUT ran the Finish menu\'s Thicken out with that mm', /^Thicken out 0\.56 /.test(await page.evaluate(() => document.getElementById('status').textContent)),
          await page.evaluate(() => document.getElementById('status').textContent));
    check('the wall is no longer thin', rep.thin === 0 && /Before: 96 thin faces\. Now: 0\./.test(st.result.text), JSON.stringify(rep) + ' ' + st.result.text);
    check('the Finish box is put back as it was', (await page.inputValue('#inp-thicken-mm')) === box0, box0);
    check('the row turned green', st.done.length === 1 && st.done[0].ok && st.done[0].fix === 'thickenOut');
    check('one Undo', (await undoDepth(page)) === d0 + 1 && (await undoTypes(page, 1))[0] === 'thickenReplace');
    await undoToStale();
    check('which puts the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    // BRIDGE from the card on the same piece
    await page.click('#btn-findings-recheck');
    await page.waitForFunction(i => nsoFindingsState().modelId === i && !nsoFindingsState().stale, id, { timeout: 60000 });
    await page.click('#findings-rows .findings-fix[data-fix=bridge]');
    const rep2 = await reportNow(page), topo = NODE.NSO_Patch.topology(await rawSoup(page, id));
    check('BRIDGE closes the two rims into one shell', rep2.open === 0 && topo.shells === 1 && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(rep2));
    await hideCheck(page);
  }

  console.log('\n9f. REPAIR says whole piece; a row that cannot be fixed says why');
  {
    const id = await load(page, 'damage/shape-sphere_nm-duplicate.stl');
    await pressCheck(page, id);
    const st = await card(page), it = st.rows.find(r => r.kind === 'nonManifold').items[0];
    check('the doubled-edge row is REPAIR and says whole piece', it.fixLabel === 'REPAIR' && /whole piece/.test(it.text) && it.scope === 'whole piece', JSON.stringify(it));
    check('and its button says so on hover', /whole piece/.test(await page.getAttribute('#findings-rows .findings-fix[data-fix=sealRepair]', 'title')));
    await hideCheck(page);
    // a fix whose finding is gone: said in words, nothing changed
    const id2 = await load(page, 'damage/shape-sphere_hole.stl');
    await pressCheck(page, id2);
    const raw0 = await rawBytes(page, id2);
    const res = await page.evaluate(() => nsoRepairRun({ fix: 'patch', anchors: [[99, 99, 99]] }));
    check('a PATCH aimed at a hole that is not there is refused in words and changes nothing',
          !res.ok && /not on the piece any more/.test(res.reason) && (await rawBytes(page, id2)) === raw0, JSON.stringify(res));
    await hideCheck(page);
  }

  console.log('\n9g. ADD > Patch: hover outlines the hole under the pointer, a click fills it');
  {
    const id = await load(page, 'damage/shape-sphere_hole.stl');
    const raw0 = await rawBytes(page, id), d0 = await undoDepth(page);
    await page.click('#btn-patch');
    let ps = await page.evaluate(() => nsoPatchState());
    check('Patch is armed and has found the hole', ps.armed && ps.loops.length === 1 && ps.hover === -1, JSON.stringify(ps.loops.map(l => l.n)));
    check('the button shows it is on', (await page.getAttribute('#btn-patch', 'aria-pressed')) === 'true');
    // frame the hole: camera straight at it, so the pointer can be put on it
    const pos = await page.evaluate(() => {
      const p = state.placed.find(q => q && q.sourceId === getActiveModel().id);
      const st = nsoPatchState(), a = st.loops[0].anchor;
      p.mesh.updateMatrixWorld(true);
      const m = getActiveModel(), raw = getModelRawSoup(m);
      // the anchor in raw space -> world
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < raw.length; i += 3) { const d = [raw[i], raw[i + 2], -raw[i + 1]]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[k]); hi[k] = Math.max(hi[k], d[k]); } }
      p.mesh.geometry.computeBoundingBox();
      const bb = p.mesh.geometry.boundingBox, off = [0, 1, 2].map(k => (bb.min.getComponent(k) + bb.max.getComponent(k)) / 2 - (lo[k] + hi[k]) / 2);
      const w = new THREE.Vector3(a[0] + off[0], a[2] + off[1], -a[1] + off[2]).applyMatrix4(p.mesh.matrixWorld);
      const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
      const dir = w.clone().sub(c).normalize();
      state.controls.target.copy(w);
      state.camera.position.copy(w.clone().add(dir.multiplyScalar(12)));
      state.camera.lookAt(w); state.controls.update();
      state.camera.updateMatrixWorld(true);
      const v = w.clone().project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    });
    await page.mouse.move(pos.x - 300, pos.y - 200);
    await page.mouse.move(pos.x, pos.y, { steps: 4 });
    await page.waitForFunction(() => nsoPatchState().hover >= 0, null, { timeout: 5000 });
    ps = await page.evaluate(() => nsoPatchState());
    check('hovering the hole lights its loop', ps.hover === 0, 'hover ' + ps.hover);
    const lit = await page.evaluate(() => {
      const p = state.placed.find(q => q && q.sourceId === getActiveModel().id);
      const g = p.mesh.children.find(c => c.name === 'nso-patch-outline');
      return g ? g.children.map(c => c.material.color.getHex()) : [];
    });
    check('and outlines it, bright', lit.includes(0xfacc15), JSON.stringify(lit));
    await page.mouse.move(pos.x + 400, pos.y + 250);
    await page.waitForFunction(() => nsoPatchState().hover === -1, null, { timeout: 5000 });
    check('moving off it puts the outline out', true);
    await page.mouse.move(pos.x, pos.y, { steps: 3 });
    await page.waitForFunction(() => nsoPatchState().hover >= 0, null, { timeout: 5000 });
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(i => getModelRawSoup(state.models.find(x => x.id === i)).length > 1979 * 9, id, { timeout: 15000 });
    const soup = await rawSoup(page, id), topo = NODE.NSO_Patch.topology(soup);
    check('a click on the hole fills it: closed, manifold', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === 1, JSON.stringify(topo));
    check('one Undo, of its own type', (await undoDepth(page)) === d0 + 1 && (await undoTypes(page, 1))[0] === 'patchReplace');
    check('the click did not move the piece (it was Patch\'s)', !/Moved model/.test(await page.evaluate(() => document.getElementById('status').textContent)));
    await page.evaluate(() => nsoPatchSetArmed(false));
    await page.click('#btn-undo');
    check('Undo puts the piece back bit for bit', (await rawBytes(page, id)) === raw0);
    check('Patch is put away', !(await page.evaluate(() => nsoPatchState().armed)) &&
          await page.evaluate(() => !state.scene.children.some(c => c.name === 'nso-patch-outline')));
    await page.click('#btn-patch');
    await page.keyboard.press('Escape');
    check('and Escape puts it away too', !(await page.evaluate(() => nsoPatchState().armed)));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails += errs.length; }

  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });

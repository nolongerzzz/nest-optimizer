/* Integration stress test, the half that is app state rather than geometry.
   node tools/nso_wire_integration_test.js      exit 0 = every gate held

   The geometric joins are tools/nso_integration_test.js. What is here is what
   only the real page can show: which piece is selected after a tool adds one,
   whether a clone is a first-class piece, and whether the tools that arm a
   click behave the same on a generated piece as on an imported one.

   It carries the NEGATIVE CONTROLS for the two Clone fixes. Both fixes make
   Clone do MORE, so each needs a matching check that it does not do too much:
   a clone must not share the original's soup, and Clone must not invent a soup
   for a piece that never had one.

   Full write-up: docs/INTEGRATION.md */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const lib = f => path.join(ROOT, 'library', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* A piece as the APP holds it, plus a checksum so "unchanged" is a value
   comparison and not a triangle count. */
const info = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x && x.id === i);
  if (!m) return null;
  const s = m.rawTris;
  if (!s) return { raw: false, name: m.name, gtris: m.geometry ? m.geometry.attributes.position.count / 3 : null };
  let v = 0, sum = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7])
        - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6])
        + s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  for (let k = 0; k < s.length; k++) sum += s[k];
  const st = NSO_edgeStats(s);
  return { raw: true, name: m.name, axis: m.rawAxis, tris: s.length / 9,
           gtris: m.geometry ? m.geometry.attributes.position.count / 3 : null,
           open: st.open, nm: st.nm, vol: +v.toFixed(3), sum: sum };
}, id);

/* Which piece does the app think is selected - all three answers at once.
   The bug this suite was written for is these three disagreeing. */
const selection = page => page.evaluate(() => ({
  editId: state.editId,
  active: (typeof getActiveModel === 'function' && getActiveModel()) ? getActiveModel().id : null,
  selectedIndex: state.selectedIndex,
  outlinedSourceId: (state.selectedIndex >= 0 && state.placed[state.selectedIndex])
    ? state.placed[state.selectedIndex].sourceId : null,
  models: state.models.length
}));

const setF = (page, v) => page.evaluate(o => {
  for (const id of Object.keys(o)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!o[id];
    else el.value = o[id] === null ? '' : String(o[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, v);

const openMenuOf = (page, btnId) => page.evaluate(b => {
  for (let n = document.getElementById(b); n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
}, btnId);

const status = page => page.evaluate(() => document.getElementById('status').textContent);

/* Select a piece the way a click does - both halves, through selectPlaced. */
const selectPiece = (page, id) => page.evaluate(i => {
  const k = state.placed.findIndex(p => p && p.sourceId === i);
  if (k >= 0) selectPlaced(k); else state.editId = i;
}, id);

/* Paint a face the way a click does, via app-mask's own hit path. */
const paintFace = (page, id, dir, mode) => page.evaluate(([i, d, mo]) => {
  const m = state.models.find(x => x.id === i);
  const placed = state.placed.find(p => p && p.sourceId === i && p.mesh);
  if (!placed) return { ok: false, why: 'not on the plate' };
  placed.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(placed.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  const span = bb.getSize(new THREE.Vector3()).length() + 50;
  const dv = new THREE.Vector3(d[0], d[1], d[2]).normalize();
  const hits = new THREE.Raycaster(c.clone().sub(dv.clone().multiplyScalar(span)), dv)
    .intersectObject(placed.mesh, true);
  if (!hits.length) return { ok: false, why: 'no hit' };
  if (mo === 'exclude') nsoMaskToggleAt(m, placed.mesh, hits[0]);
  else nsoMaskSelectAt(m, placed.mesh, hits[0]);
  const sel = nsoMaskSelected(m);
  return { ok: true, target: sel ? nsoMaskFaceName(sel) : null,
           sel: nsoMaskSelectCount(m), exc: nsoMaskCount(m) };
}, [id, dir, mode || 'select']);

/* Run one tool against a named piece and report only what changed. */
const runTool = (page, id, fnSrc) => page.evaluate(async ([i, f]) => {
  state.editId = i;
  let out;
  try { out = await eval('(' + f + ')()'); } catch (e) { out = { threw: (e && e.message) || String(e) }; }
  return { ok: !!(out && out.ok), threw: out && out.threw,
           reason: ((out && out.reason) || '').slice(0, 150),
           status: document.getElementById('status').textContent.slice(0, 170) };
}, [id, fnSrc]);

withApp(async (page, logs) => {
  /* app-ux.js re-stamps the HUD into the status line at 0 and 200 ms. */
  await page.waitForTimeout(400);

  console.log('\n=== 1. Clone, and the five newer tools used straight after it ===');
  console.log('    The probe the ticket asked for. Before the fixes this provoked the');
  console.log('    desync every time: five tools in a row acted on a piece the viewport');
  console.log('    did not show as selected, and all five refused it for lacking a soup');
  console.log('    the clone had thrown away.');
  let idSrc = null, idClone = null;
  {
    idSrc = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await selectPiece(page, idSrc);
    const src0 = await info(page, idSrc);
    const before = await selection(page);
    check('the source is selected, and both halves agree',
      before.editId === idSrc && before.outlinedSourceId === idSrc,
      JSON.stringify(before));

    await page.evaluate(() => { document.getElementById('clone-count').value = '1'; });
    await page.click('#btn-clone');
    const after = await selection(page);
    idClone = await page.evaluate(() => state.models[state.models.length - 1].id);

    /* FIX 1 - the selection. editId, getActiveModel() and the red outline in
       the viewport must all name the SAME piece. They used to name two. */
    check('after Clone all three halves of "what is selected" name one piece',
      after.editId === idClone && after.active === idClone &&
      after.outlinedSourceId === idClone,
      'editId ' + after.editId + ', active ' + after.active +
      ', outlined ' + after.outlinedSourceId + ' (clone is ' + idClone + ')');

    /* FIX 2 - the clone is a raw piece. */
    const c0 = await info(page, idClone);
    check('the clone carries rawTris, in the same axes, with the same triangles',
      c0.raw && c0.axis === 'zup' && c0.tris === src0.tris && c0.sum === src0.sum,
      c0.raw ? (c0.tris + ' tris, checksum ' + (c0.sum === src0.sum ? 'identical' : 'DRIFTED')) : 'no rawTris');
    check('  ...and its display geometry matches its soup, so scene and file agree',
      c0.gtris === c0.tris, c0.gtris + ' display vs ' + c0.tris + ' raw');

    /* NEGATIVE CONTROL for fix 2: the two pieces must be independent. A shared
       buffer would pass every check above and corrupt the original the first
       time anything wrote in place. */
    await openMenuOf(page, 'btn-hollow');
    await setF(page, { 'inp-hollow-wall': 3 });
    const hol = await runTool(page, idClone, "function(){ return window.nsoHollowRun('hollow'); }");
    check('Hollow now RUNS on the clone (it used to refuse for want of a soup)',
      hol.ok, hol.reason || hol.status);
    const srcAfter = await info(page, idSrc);
    check('NEGATIVE CONTROL: baking the clone left the ORIGINAL byte-identical',
      srcAfter.tris === src0.tris && srcAfter.sum === src0.sum,
      srcAfter.tris + ' tris, checksum ' + (srcAfter.sum === src0.sum ? 'identical' : 'DRIFTED'));

    /* The rest of the five, on a fresh clone so the hollow above is not in the
       way. Each one is asserted to reach its OWN answer rather than the
       "needs a raw piece" wall. */
    await selectPiece(page, idSrc);
    await page.click('#btn-clone');
    const id2 = await page.evaluate(() => state.models[state.models.length - 1].id);
    const TOOLS = [
      ['Fatten', "function(){ return NSO_fattenSelectedModel('grow',0.4,{}); }"],
      ['Extend', "function(){ return NSO_extendSelectedModel({ delta: 3 }); }"],
      ['Smooth', "function(){ return NSO_smoothSelectedModel(); }"],
      ['Stock Match', "function(){ document.getElementById('sel-stock-shape').value='box';" +
        " document.getElementById('sel-stock-shape').dispatchEvent(new Event('change',{bubbles:true}));" +
        " document.getElementById('inp-stock-height').value='20';" +
        " document.getElementById('chk-stock-match').checked=true;" +
        " return window.nsoStockRun(null); }"]
    ];
    for (const [label, fn] of TOOLS) {
      const r = await runTool(page, id2, fn);
      check(label + ' on a fresh clone gets past "needs a raw piece"',
        !/needs a raw piece|no rawTris/.test(r.reason + ' ' + r.status),
        (r.ok ? 'ok' : 'refused') + ': ' + (r.reason || r.status).slice(0, 110));
    }
    await page.evaluate(() => { document.getElementById('chk-stock-match').checked = false; });

    /* NEGATIVE CONTROL for fix 2, the other way: Clone must not INVENT a soup.
       A piece that legitimately has none - the header of addModel names Split
       as the case - must clone into a piece that also has none, and the tools
       must still refuse it by name. */
    const stripped = await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      m.rawTris = null; m.rawAxis = null; m.centerOffset = null;
      return !!m.rawTris;
    }, idSrc);
    await selectPiece(page, idSrc);
    await page.click('#btn-clone');
    const id3 = await page.evaluate(() => state.models[state.models.length - 1].id);
    const c3 = await info(page, id3);
    check('NEGATIVE CONTROL: a clone of a piece with NO soup still has none',
      stripped === false && c3.raw === false, 'raw ' + c3.raw);
    const r3 = await runTool(page, id3, "function(){ return NSO_fattenSelectedModel('grow',0.4,{}); }");
    check('  ...and Fatten still refuses it by name rather than on invented data',
      !r3.ok && /needs a raw piece/.test(r3.status), r3.status.slice(0, 90));
  }

  console.log('\n=== 2. Extract selection, then Fatten / Extend / Hollow on the extract ===');
  console.log('    The claim under test: an extracted copy behaves exactly as an');
  console.log('    originally-placed piece of the same shape does. Both are driven here.');
  {
    const idHost = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await selectPiece(page, idHost);
    const p = await paintFace(page, idHost, [0, -1, 0], 'select');
    check('a target face can be painted on the host', p.ok && p.sel === 1, JSON.stringify(p));
    const host0 = await info(page, idHost);

    const ex = await page.evaluate(() => {
      const r = window.nsoExtractSelection();
      return { ok: r.ok, reason: (r.reason || '').slice(0, 130),
               status: document.getElementById('status').textContent.slice(0, 170) };
    });
    check('Extract selection makes a piece', ex.ok, ex.reason || ex.status);
    const idEx = await page.evaluate(() => state.models[state.models.length - 1].id);
    const exInfo = await info(page, idEx);
    check('  ...a raw, closed one', exInfo.raw && exInfo.open === 0 && exInfo.nm === 0,
      exInfo.tris + ' tris, ' + exInfo.open + ' open, vol ' + exInfo.vol);

    const hostAfter = await info(page, idHost);
    check('  ...and the source piece is untouched, value for value',
      hostAfter.sum === host0.sum && hostAfter.tris === host0.tris,
      hostAfter.sum === host0.sum ? 'identical' : 'DRIFTED');

    /* Extract leaves the selection on the SOURCE - the opposite choice from
       Clone, and a defensible one (you extracted a copy, you keep working on
       the original). What matters for this suite is that its two halves
       AGREE, which is the property Clone was breaking. */
    const sel = await selection(page);
    check('  ...and its two halves of "selected" agree with each other',
      sel.editId === sel.outlinedSourceId, JSON.stringify(sel));

    /* An independently-loaded slab of the same shape, to compare against. The
       extract is an 80 x 1.2 x 40 solid; box_open.stl is a different shape, so
       the honest comparison is the extract against ITSELF re-imported, which
       is what the export round-trip suite covers. Here the claim is narrower
       and checkable: each of the three tools reaches its own answer on the
       extract, and the answer is the one the geometry deserves. */
    const T = [
      ['Fatten grow 0.4', "function(){ return NSO_fattenSelectedModel('grow',0.4,{}); }", true],
      ['Extend +3 mm', "function(){ return NSO_extendSelectedModel({ delta: 3 }); }", true],
      ['Hollow to 2 mm', "function(){ return window.nsoHollowRun('hollow'); }", false]
    ];
    await setF(page, { 'inp-hollow-wall': 2 });
    for (const [label, fn, wantOk] of T) {
      const b = await info(page, idEx);
      const r = await runTool(page, idEx, fn);
      const a = await info(page, idEx);
      if (wantOk) {
        check(label + ' runs on the extract', r.ok, r.reason || r.status.slice(0, 110));
        check('  ...and the piece is still closed afterwards',
          a.open === 0 && a.nm === 0, a.tris + ' tris, ' + a.open + ' open, ' + a.nm + ' nm');
      } else {
        /* A 1.2 mm slab has no interior to carve at a 2 mm wall. The refusal
           is the right answer and it must change nothing. */
        check(label + ' is REFUSED on a 1.2 mm slab, and changes nothing',
          !r.ok && a.sum === b.sum, r.status.slice(0, 120));
      }
    }
  }

  console.log('\n=== 3. Stock -> Hollow -> Attach, in the page ===');
  console.log('    The section-2 bug of the headless suite, end to end through the UI.');
  console.log('    Before the union fix this refused with "the two pieces do not touch".');
  {
    await openMenuOf(page, 'btn-stock-make');
    await setF(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 40, 'inp-stock-radius': 20,
      'inp-stock-wall': 3, 'inp-stock-waste': 0, 'chk-stock-match': false, 'chk-stock-oversize': false });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    const idBody = await page.evaluate(() => state.models[state.models.length - 1].id);
    await selectPiece(page, idBody);
    const s0 = await info(page, idBody);
    check('New stock puts a 12-triangle box on the plate', s0.raw && s0.tris === 12,
      s0.tris + ' tris, vol ' + s0.vol);

    await openMenuOf(page, 'btn-hollow');
    await setF(page, { 'inp-hollow-wall': 2 });
    const h = await runTool(page, idBody, "function(){ return window.nsoHollowRun('hollow'); }");
    check('Hollow carves it to a 2 mm wall', h.ok, h.status.slice(0, 120));
    const s1 = await info(page, idBody);
    check('  ...and the shell is closed', s1.open === 0 && s1.nm === 0,
      s1.tris + ' tris, vol ' + s1.vol);

    await openMenuOf(page, 'btn-stock-attach');
    await setF(page, { 'sel-stock-shape': 'cylinder', 'inp-stock-height': 18, 'inp-stock-radius': 5,
      'inp-stock-wall': 3, 'inp-stock-waste': 0, 'inp-stock-prop': 3 });
    const att = await page.evaluate(async i => {
      const p = state.placed.find(x => x && x.sourceId === i);
      p.mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(p.mesh);
      const c = bb.getCenter(new THREE.Vector3());
      const rr = bb.getSize(new THREE.Vector3()).length();
      const v = new THREE.Vector3(1, 0, 0);
      const hits = new THREE.Raycaster(c.clone().addScaledVector(v, rr * 2), v.clone().negate())
        .intersectObject(p.mesh, true).filter(x => x.face);
      if (!hits.length) return { ok: false, reason: 'no hit' };
      const r = await window.nsoAttachAt(p, hits[0].point.toArray(), hits[0].face.normal.toArray(), null);
      return { ok: r.ok, reason: (r.reason || '').slice(0, 170),
               parts: r.union ? r.union.parts : null,
               status: document.getElementById('status').textContent.slice(0, 170) };
    }, idBody);
    check('Attach seats an arm on the HOLLOWED piece and the union is accepted',
      att.ok, att.reason || att.status);
    check('  ...and it is accepted at parts 2, because a void is a component',
      att.parts === 2, 'parts ' + att.parts);
    const s2 = await info(page, idBody);
    check('  ...the committed piece is closed and bigger than the shell',
      s2.open === 0 && s2.nm === 0 && s2.tris > s1.tris && s2.vol > s1.vol,
      s1.tris + ' -> ' + s2.tris + ' tris, ' + s1.vol + ' -> ' + s2.vol + ' mm^3');
    await page.click('#btn-undo');
    const s3 = await info(page, idBody);
    check('  ...and Undo puts the shell back value for value',
      s3.sum === s1.sum, s3.sum === s1.sum ? 'identical' : 'DRIFTED');
  }

  console.log('\n=== 4. a Pottery Wheel vessel through Repair, Paint, Delete and Seat ===');
  console.log('    The same "flows through cleanly, zero special-casing" claim Attach\'s');
  console.log('    output carries, asked of the wheel\'s output instead.');
  {
    const seed = await loadSTL(page, fx('box-20mm.stl'));
    await selectPiece(page, seed);
    await openMenuOf(page, 'btn-wheel-ball');
    await setF(page, { 'inp-wheel-height': 60, 'inp-wheel-radius': 30, 'inp-wheel-wall': 3 });
    // btn-wheel-ball moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-wheel-ball'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-wheel-ball');
    await setF(page, { 'inp-wheel-depth': 20 });
    await page.evaluate(() => { const e = document.getElementById('btn-wheel-open'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-wheel-open');
    const idV = await page.evaluate(() => state.editId);
    const v0 = await info(page, idV);
    check('the wheel throws and opens a vessel, closed',
      v0.raw && v0.open === 0 && v0.nm === 0, v0.tris + ' tris, vol ' + v0.vol);

    const rep = await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      const r = window.NSO_Repair.commit(m.rawTris, {});
      return { applied: r.report.applied, identity: r.rawTris === m.rawTris,
               reason: r.report.reason, nonSolid: r.report.nonSolid };
    }, idV);
    check('Repair no-ops the vessel BY IDENTITY',
      rep.applied === false && rep.identity && rep.nonSolid === false,
      '"' + rep.reason + '"');

    await openMenuOf(page, 'btn-seal');
    await page.evaluate(() => { const c = document.getElementById('chk-seal-repair'); if (c) c.checked = true; });
    await page.click('#btn-seal');
    check('  ...and so does the Seal button with Repair ticked',
      /Nothing to repair/i.test(await status(page)), (await status(page)).slice(0, 110));

    const pe = await paintFace(page, idV, [0, -1, 0], 'exclude');
    check('Paint excludes a face on the revolved surface', pe.ok && pe.exc === 1, JSON.stringify(pe));
    const ps = await paintFace(page, idV, [1, 0, 0], 'select');
    check('Paint selects a target on it too', ps.ok && ps.sel === 1, JSON.stringify(ps));

    const vBefore = await info(page, idV);
    const del = await page.evaluate(i => {
      state.editId = i;
      const r = window.NSO_deletePaintedFace();
      return { reason: (r && r.reason) || '', status: document.getElementById('status').textContent.slice(0, 190) };
    }, idV);
    const vAfter = await info(page, idV);
    check('Delete painted removes the target from the vessel',
      vAfter.tris < vBefore.tris, vBefore.tris + ' -> ' + vAfter.tris + ' tris');
    check('  ...and says plainly that the piece is now open, rather than hiding it',
      /now OPEN/.test(del.status) && vAfter.open > 0,
      del.status.slice(0, 130));
    await page.click('#btn-undo');
    const vBack = await info(page, idV);
    check('  ...and Undo restores it value for value',
      vBack.sum === vBefore.sum, vBack.sum === vBefore.sum ? 'identical' : 'DRIFTED');

    const idBit = await loadSTL(page, lib('box_bit_12x8x8.stl'));
    const seat = await page.evaluate(([hid, bid]) => {
      state.joinSession = true; state.joinHullId = hid; state.joinPartnerId = bid;
      const hp = state.placed.find(p => p && p.sourceId === hid);
      hp.mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(hp.mesh);
      const c = bb.getCenter(new THREE.Vector3());
      const rr = bb.getSize(new THREE.Vector3()).length();
      const v = new THREE.Vector3(1, 0, 0);
      const hits = new THREE.Raycaster(c.clone().addScaledVector(v, rr * 2), v.clone().negate())
        .intersectObject(hp.mesh, true).filter(x => x.face);
      if (!hits.length) return { ok: false, reason: 'no hit' };
      const r = window.NSO_seatHereAt(hp, hits[0].point.toArray(), {});
      return { ok: r.ok, reason: (r.reason || '').slice(0, 150),
               status: document.getElementById('status').textContent.slice(0, 190) };
    }, [idV, idBit]);
    check('Seat here seats a bit against the vessel\'s curved wall',
      seat.ok, seat.reason || seat.status);
    check('  ...and reports the turn it baked, in millimetres and degrees',
      /air gap/.test(seat.status) && /degrees/.test(seat.status), seat.status.slice(0, 140));
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors across the whole sweep', errs.length === 0,
    errs.slice(0, 3).map(e => e.text.slice(0, 120)).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_wire_integration_test.js)');
  if (fails) process.exit(1);
});

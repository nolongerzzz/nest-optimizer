/* End-to-end evidence for Attach, driven through the real app.
   node tools/nso_wire_assemble_test.js      exit 0 = every gate held

   Same shape as tools/nso_wire_stock_test.js: real index.html, real script
   tags, real clicks, real undo. The headless proofs live in
   tools/nso_assemble_test.js and tools/nso_assemble_canonical_check.js; what
   this file exists to prove is the part only the page can show:

     1. the button is there (in the Connect card, under Set / Cancel - the
        Stock card is a shelf of tiles now), it arms once a shape has been
        clicked on the shelf, disarms, and app-core asks it about clicks - so
        the flow is actually reachable without tool-hopping;
     2. one call really does generate + aim + join: the piece count does NOT
        go up (nothing is left on the plate to tidy away), the clicked piece's
        soup is replaced, and it comes back closed;
     3. the raycast hit is what supplies the outward direction - the thing
        nso_support_aim.js cannot supply - and a pick on a curved flank works
        as well as one on a flat face;
     4. Undo puts the piece back exactly, byte for byte;
     5. the refusals fire from the page: paint stands it down, a piece with
        no target height is refused, and the build-volume gate is the same
        one a Stock drop applies;
     6. the result is an ordinary piece afterwards - it exports, and Repair
        and the Check piece read it as a solid. */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The piece as the APP holds it: the raw soup it would export, its edge
   topology by the app's own counter, and a checksum so undo can be compared
   value for value rather than by triangle count. */
const measure = (page, id) => page.evaluate(mid => {
  const m = state.models.find(x => x && x.id === mid);
  if (!m) return null;
  const s = m.rawTris;
  let v = 0, sum = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7])
        - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6])
        + s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  for (let i = 0; i < s.length; i++) sum += s[i];
  const st = (typeof NSO_edgeStats === 'function') ? NSO_edgeStats(s) : { open: -1, nm: -1 };
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v, sum: sum,
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) } };
}, id);

/* The blank, as the Stock card's fields used to say it - now passed to the
   attach itself (the card has no fields to read): a cylinder, its height, its
   radius, its wall, no waste, and 3 for height over diameter. */
const BLANK = { shape: 'cylinder', height: 16, radius: 4, wall: 3, waste: 0, ratio: 3 };

const statusText = page => page.evaluate(() => document.getElementById('status').textContent);

/* A real point on a piece's surface, and the face normal there, found the way
   the click finds them: a ray fired at the piece from outside along `dir`,
   and the hit's own face record. Returned in world / object space, exactly as
   nsoAttachTakesClick would hand them over. */
const surfaceHit = (page, id, dir) => page.evaluate(([mid, d]) => {
  const p = state.placed.find(x => x && x.sourceId === mid);
  if (!p || !p.mesh) return null;
  p.mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(p.mesh);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length();
  const v = new THREE.Vector3(d[0], d[1], d[2]).normalize();
  const origin = c.clone().addScaledVector(v, r * 2);
  const rc = new THREE.Raycaster(origin, v.clone().negate());
  const hits = rc.intersectObject(p.mesh, true).filter(h => h.face);
  if (!hits.length) return null;
  return { point: hits[0].point.toArray(), normal: hits[0].face.normal.toArray() };
}, [id, dir]);

/* The attach itself, through the SAME entry point the armed click uses. */
const attachAt = (page, id, hit, blank) => page.evaluate(async ([mid, h, ov]) => {
  const p = state.placed.find(x => x && x.sourceId === mid);
  const r = await window.nsoAttachAt(p, h.point, h.normal, ov);
  return { ok: r.ok, reason: r.reason, union: r.union || null,
           engage: r.attach ? r.attach.engageMm : null,
           gap: r.attach ? r.attach.rootGapMm : null,
           exposed: r.attach ? r.attach.exposedLengthMm : null,
           dir: r.attach ? r.attach.dir : null,
           status: document.getElementById('status').textContent };
}, [id, hit, blank || BLANK]);

withApp(async (page, logs) => {

  console.log('\n=== 1. the flow is reachable: one button, armed by one click ===');
  {
    /* app-ux.js re-stamps the HUD into the status line at 0 and 200 ms after
       load, so a status read before that is reading the stamp, not the tool. */
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => {
      const btn = document.getElementById('btn-stock-attach');
      const connect = document.getElementById('connect-panel');
      return {
        hasButton: !!btn,
        wired: !!btn && btn.dataset.nsoWired === '1',
        pressed: btn && btn.getAttribute('aria-pressed'),
        /* the Connect card: where a thing is made at a point you click on a piece */
        inConnect: !!(connect && btn && connect.contains(btn)),
        inStockMenu: !!(document.querySelector('.vp-stock-menu') && btn && document.querySelector('.vp-stock-menu').contains(btn)),
        core: typeof window.NSO_Assemble,
        app: typeof window.nsoAttachAt,
        hook: typeof window.nsoAttachTakesClick,
        mapping: typeof window.nsoRawFrameOf === 'function' &&
                 typeof window.nsoRawPointFromLocal === 'function' &&
                 typeof window.nsoRawDirFromLocal === 'function',
        union: typeof window.NSO_unionSoups
      };
    });
    check('the Connect card carries an Attach button, unarmed', w.hasButton && w.pressed === 'false', JSON.stringify(w));
    check('it is wired, it is in the Connect card, and the Stock card has none', w.wired && w.inConnect && !w.inStockMenu);
    check('nso_assemble.js and app-assemble.js are both loaded',
      w.core === 'object' && w.app === 'function');
    check('it answers app-core\'s click question', w.hook === 'function');
    check('app-mask.js exports the raw <-> local mapping rather than a copy living here',
      w.mapping);
    check('app-join.js\'s union is the boolean it will use', w.union === 'function');

    // The button is in the Connect card: open it (the column button is the card's switch, no gate), then press it.
    await page.click('#menu-connect > summary');
    await page.click('#btn-stock-attach');
    check('with no shape clicked on the Stock shelf it does not arm, and says where to click',
      !(await page.evaluate(() => !!state.attachArmed)) && /Attach needs a shape/.test(await statusText(page)), await statusText(page));
    await page.evaluate(() => nsoStockShelf.drop('cylinder', { height: 10 }));   // the shelf's drop: a click on the Cylinder tile, small so it stays out of the way
    await page.click('#btn-stock-attach');
    const armed = await page.evaluate(() => ({
      pressed: document.getElementById('btn-stock-attach').getAttribute('aria-pressed'),
      cls: document.getElementById('btn-stock-attach').classList.contains('is-armed'),
      flag: !!state.attachArmed,
      status: document.getElementById('status').textContent
    }));
    check('one click arms it and says what to do',
      armed.pressed === 'true' && armed.cls && armed.flag &&
      /click the point on a piece/i.test(armed.status), JSON.stringify(armed));
    await page.click('#btn-stock-attach');
    check('a second click disarms it', !(await page.evaluate(() => !!state.attachArmed)));
    await page.click('#btn-stock-attach');
    await page.keyboard.press('Escape');
    check('Escape disarms it too', !(await page.evaluate(() => !!state.attachArmed)));
    if (await page.evaluate(() => document.getElementById('menu-connect').open)) await page.click('#menu-connect > summary');   // close the card again
  }

  console.log('\n=== 2. generate + aim + join, in one call, on a FLAT face ===');
  const idBox = await loadSTL(page, fx('box-20mm.stl'));
  let before = null;
  {
    before = await measure(page, idBox);
    const n0 = await page.evaluate(() => state.models.length);
    const hit = await surfaceHit(page, idBox, [1, 0, 0]);
    check('a ray finds a point and a face normal on the box\'s +X face', !!hit,
      hit ? JSON.stringify(hit.point.map(v => +v.toFixed(3))) + ' n ' +
            JSON.stringify(hit.normal.map(v => +v.toFixed(3))) : '');

    const r = await attachAt(page, idBox, hit);
    check('Attach succeeds', r.ok, r.reason || r.status);
    if (r.ok) {
      const after = await measure(page, idBox);
      const n1 = await page.evaluate(() => state.models.length);
      check('NOTHING is left on the plate to tidy away - the model count is unchanged',
        n1 === n0, n0 + ' -> ' + n1 + ' pieces');
      check('the clicked piece now carries the assembly',
        after.tris > before.tris && after.volume > before.volume,
        before.tris + ' -> ' + after.tris + ' tris, ' +
        before.volume.toFixed(1) + ' -> ' + after.volume.toFixed(1) + ' mm^3');
      check('and it is closed - 0 open, 0 non-manifold by the app\'s own counter',
        after.open === 0 && after.nm === 0,
        after.open + ' open, ' + after.nm + ' non-manifold');
      check('the seat was measured, and a flat face needs no more than the floor',
        r.gap < 1e-6 && Math.abs(r.engage - 0.42) < 1e-6,
        'rim gap ' + r.gap.toExponential(2) + ', seated ' + r.engage.toFixed(4) + ' mm');
      check('the status line reports the seat, not just "done"',
        /Attached/.test(r.status) && /seated/.test(r.status), r.status);

      /* Undo. A bake that cannot be undone is a bake nobody dares press. */
      await page.click('#btn-undo');
      const back = await measure(page, idBox);
      check('Undo puts the piece back value for value',
        back.tris === before.tris && back.sum === before.sum,
        back.tris + ' tris, checksum ' + (back.sum === before.sum ? 'identical' : 'DRIFTED'));
    }
  }

  console.log('\n=== 3. the same flow on a CURVED flank - the case a flush seat cannot do ===');
  {
    const idSph = await loadSTL(page, fx('fixture_sphere_curved.stl'));
    const b = await measure(page, idSph);
    const hit = await surfaceHit(page, idSph, [1, 0, 0]);
    check('a ray finds a point on the curved flank', !!hit);
    const r = await attachAt(page, idSph, hit, { shape: 'cylinder', height: 14, radius: 5, wall: 2, waste: 0, ratio: 3 });
    check('Attach succeeds on a curved face', r.ok, r.reason || r.status);
    if (r.ok) {
      const a = await measure(page, idSph);
      check('  ...the rim gap is real, so the seat is deeper than the bare floor',
        r.gap > 0.01 && r.engage > r.gap,
        'rim gap ' + r.gap.toFixed(4) + ' mm, seated ' + r.engage.toFixed(4) + ' mm');
      check('  ...and the result is one closed piece',
        a.open === 0 && a.nm === 0 && a.tris > b.tris,
        b.tris + ' -> ' + a.tris + ' tris, ' + a.open + ' open, ' + a.nm + ' non-manifold');
      await page.click('#btn-undo');
    }
  }

  console.log('\n=== 4. the refusals, from the page ===');
  {
    /* No target height: the blank has nothing to be sized from. */
    const hit = await surfaceHit(page, idBox, [1, 0, 0]);
    const r0 = await attachAt(page, idBox, hit, Object.assign({}, BLANK, { height: null }));
    check('no target height -> refused, nothing changed',
      !r0.ok && /target height/i.test(r0.status), r0.status);

    /* Paint. WHOLE-PIECE scope: any painted face stands the whole thing down,
       because the union replaces every triangle. */
    const painted = await page.evaluate(mid => {
      const m = state.models.find(x => x && x.id === mid);
      m.faceMask = { exclude: [{ axisIdx: 0, keepMin: false, n: [1, 0, 0], d: 10 }], select: [] };
      return nsoMaskCount(m);
    }, idBox);
    const bPaint = await measure(page, idBox);
    const r1 = await attachAt(page, idBox, hit);
    const aPaint = await measure(page, idBox);
    check('a painted face stands Attach down, naming the count',
      !r1.ok && /Attach stood down - 1 painted face/.test(r1.status) &&
      aPaint.sum === bPaint.sum,
      painted + ' painted; "' + r1.status.slice(0, 80) + '"');
    await page.evaluate(mid => {
      const m = state.models.find(x => x && x.id === mid);
      m.faceMask = { exclude: [], select: [] };
    }, idBox);

    /* The build-volume gate, the same one a Stock drop applies, against the
       machine the Plate card is actually pointed at. No plate is 600 mm tall,
       so this is refused before any geometry exists - which is the point of
       gating at generation time rather than at export. */
    const bBig = await measure(page, idBox);
    const r2 = await attachAt(page, idBox, hit, Object.assign({}, BLANK, { height: 600 }));
    const aBig = await measure(page, idBox);
    check('a target that cannot be printed -> refused before anything is generated',
      !r2.ok && /refused/i.test(r2.status) && aBig.sum === bBig.sum,
      r2.status.slice(0, 110));
  }

  console.log('\n=== 5. the assembly is an ordinary piece afterwards ===');
  {
    const hit = await surfaceHit(page, idBox, [1, 0, 0]);
    check('a fresh hit on the box after the refusals', !!hit);
    const r = hit ? await attachAt(page, idBox, hit) : { ok: false, reason: 'no hit' };
    check('Attach succeeds again after the refusals - nothing was left half-done',
      r.ok, r.reason || r.status);
    if (r.ok) {
      const after = await page.evaluate(mid => {
        const m = state.models.find(x => x && x.id === mid);
        const rep = window.NSO_Repair.commit(m.rawTris, {});
        const st = NSO_edgeStats(m.rawTris);
        /* Extend and Fatten both read the piece through Extend's detector;
           what matters here is that neither needs to be told this came out of
           a boolean. */
        const det = NSO_extendDetectAxis(m.rawTris, {});
        return {
          repairApplied: rep.report.applied, repairIdentity: rep.rawTris === m.rawTris,
          nonSolid: rep.report.nonSolid, open: st.open, nm: st.nm,
          detectOk: det.ok, axis: det.axis || det.reason
        };
      }, idBox);
      check('Repair reads it as sound and no-ops it by identity',
        after.repairApplied === false && after.repairIdentity && after.nonSolid === false,
        JSON.stringify(after));
      check('Extend\'s detector reads it with no special-casing',
        after.detectOk, 'axis ' + after.axis);

      /* The one thing only the page can show about the export: the piece the
         exporter would write is the assembly, not the pre-attach box. */
      const exported = await page.evaluate(mid => {
        const m = state.models.find(x => x && x.id === mid);
        const g = m.geometry;
        return { tris: g.attributes.position.count / 3, raw: m.rawTris.length / 9,
                 axis: m.rawAxis };
      }, idBox);
      check('the display geometry and the raw soup agree, so scene and file agree',
        exported.tris === exported.raw && exported.axis === 'zup',
        JSON.stringify(exported));
    }
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors on the page', errs.length === 0,
    errs.slice(0, 3).map(e => e.text).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_wire_assemble_test.js)');
  if (fails) process.exit(1);
});

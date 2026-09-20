/* End-to-end evidence for New stock, driven through the real app.
   node tools/nso_wire_stock_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_wheel_test.js: real index.html, real script
   tags, real clicks, real undo. The headless proofs live in
   tools/nso_stock_test.js and tools/nso_stock_canonical_check.js; what this
   file exists to prove is that the controls are reachable, that the tool is
   its OWN menu rather than a fifth button on the Pottery Wheel's card, that a
   click really puts an ordinary piece on the plate, that the plate-size
   refusal fires from the machine the Plate card is actually pointed at, and
   that the Pottery Wheel still throws a ball on the same page. */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The active piece as the APP holds it - the raw soup it would export, not a
   number the tool reported about itself. */
const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
        - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
        + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]));
  }
  const st = (typeof NSO_edgeStats === 'function') ? NSO_edgeStats(s) : { open: -1, nm: -1 };
  return {
    id: m.id, name: m.name,
    tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
    size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) }
  };
});

const openStockMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-stock-make');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
});

/* Fill the tool's boxes in one evaluate and fire the events the app listens
   for, so a select's change handler runs exactly as it would under a pointer. */
const setFields = (page, vals) => page.evaluate(v => {
  for (const id of Object.keys(v)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v[id];
    else el.value = v[id] === null ? '' : String(v[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, vals);

const modelCount = page => page.evaluate(() => state.models.length);

withApp(async (page, logs) => {
  console.log('\n=== 1. the controls exist, are reachable, and are NOT the wheel\'s ===');
  const ui = await page.evaluate(() => {
    const inputs = ['sel-stock-shape', 'inp-stock-height', 'inp-stock-radius', 'inp-stock-wall',
      'inp-stock-waste', 'inp-stock-nozzle', 'inp-stock-prop', 'chk-stock-match', 'chk-stock-oversize'];
    const btn = document.getElementById('btn-stock-make');
    const stockMenu = document.querySelector('.vp-stock-menu');
    const wheelMenu = document.querySelector('.vp-wheel-menu');
    return {
      hasButton: !!btn,
      wired: !!btn && btn.dataset.nsoWired === '1',
      missingInputs: inputs.filter(i => !document.getElementById(i)),
      ownMenu: !!stockMenu && !!wheelMenu && stockMenu !== wheelMenu,
      /* The whole point of "independent of Pottery Wheel's own menu": the
         button must not be inside the wheel's card. */
      insideWheelMenu: !!(wheelMenu && btn && wheelMenu.contains(btn)),
      shapes: [...document.querySelectorAll('#sel-stock-shape option')].map(o => o.value),
      modules: {
        stock: typeof NSO_Stock !== 'undefined',
        printer: typeof NSO_Printer !== 'undefined',
        thickness: typeof NSO_Thickness !== 'undefined',
        fit: typeof NSO_fitCurrentPrinter === 'function',
        detect: typeof NSO_extendDetectAxis === 'function',
        run: typeof window.nsoStockRun === 'function'
      },
      floor: (typeof NSO_Stock !== 'undefined') ? NSO_Stock.floor(0.4) : null,
      waste: (typeof NSO_Stock !== 'undefined') ? NSO_Stock.DEFAULTS.waste : null
    };
  });
  check('the New stock button is in the DOM', ui.hasButton);
  check('its listener attached at load', ui.wired);
  check('every stock control is in the DOM', ui.missingInputs.length === 0, ui.missingInputs.join(','));
  check('it has its own menu, separate from the Pottery Wheel\'s', ui.ownMenu);
  check('...and the button is NOT inside the wheel\'s menu', !ui.insideWheelMenu);
  check('all three shapes are offered', ui.shapes.join(',') === 'sphere,box,cylinder', ui.shapes.join(','));
  check('nso_stock.js, nso_printer.js and nso_thickness.js are all loaded by index.html',
    ui.modules.stock && ui.modules.printer && ui.modules.thickness);
  check('the build-volume resolver and the axis detector are reachable from the page',
    ui.modules.fit && ui.modules.detect);
  check('the wall floor comes back from the canonical module in the page',
    ui.floor === 0.42, String(ui.floor));
  check('the waste margin default is the stated 30%', ui.waste === 0.30, String(ui.waste));

  await openStockMenu(page);

  /* The shape-specific box follows the selector, and "follows" has to mean it
     is really off the screen for a sphere. `.vp-clone` sets `display: flex`,
     which beats the UA's `[hidden] { display: none }` on specificity, so the
     attribute alone was not enough and a field with nothing to type in it sat
     there until styles.css got a rule of its own. Measured, not assumed. */
  const propRow = shape => page.evaluate(s => {
    const sel = document.getElementById('sel-stock-shape');
    sel.value = s; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const el = document.getElementById('row-stock-prop');
    return {
      shown: getComputedStyle(el).display !== 'none',
      label: document.getElementById('lab-stock-prop').textContent,
      matchDisabled: document.getElementById('chk-stock-match').disabled
    };
  }, shape);
  const pSphere = await propRow('sphere');
  const pBox = await propRow('box');
  const pCyl = await propRow('cylinder');
  check('a sphere really hides the proportions box - computed display, not just [hidden]',
    !pSphere.shown, 'shown: ' + pSphere.shown);
  check('...and disables Match, which a sphere has nothing to do with', pSphere.matchDisabled);
  check('a box shows it, labelled x:y:z', pBox.shown && pBox.label === 'x:y:z', pBox.label);
  check('a cylinder shows it, labelled h/d', pCyl.shown && pCyl.label === 'h/d', pCyl.label);
  check('...and both re-enable Match', !pBox.matchDisabled && !pCyl.matchDisabled);

  console.log('\n=== 2. a click really puts a sphere on the plate ===');
  const before = await modelCount(page);
  await setFields(page, { 'sel-stock-shape': 'sphere', 'inp-stock-height': 60,
    'inp-stock-radius': null, 'inp-stock-wall': null, 'inp-stock-waste': null });
  // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.click('#btn-stock-make');
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
  const sphereId = await page.evaluate(() => state.models[state.models.length - 1].id);
  await selectModel(page, sphereId);
  const sph = await measure(page);
  console.log('   status: ' + (await statusOf(page)));
  console.log('   sphere      tris ' + sph.tris + '  open ' + sph.open + '  nm ' + sph.nm +
    '  vol ' + sph.volume.toFixed(1) + '  bbox ' + JSON.stringify(sph.size));
  check('one piece was added', (await modelCount(page)) === before + 1);
  check('it is closed - 0 open, 0 non-manifold', sph.open === 0 && sph.nm === 0,
    sph.open + ' open, ' + sph.nm + ' non-manifold');
  check('it is round - all three bbox axes equal',
    sph.size.x === sph.size.y && sph.size.y === sph.size.z, JSON.stringify(sph.size));
  check('a 60 mm target gives a 46.58 mm sphere, exactly as the Pottery Wheel\'s ball does',
    Math.abs(sph.size.x - 46.5836) < 0.01, sph.size.x + ' mm');
  check('the status names the material and the margin it was sized with',
    /shell/.test(await statusOf(page)) && /waste/.test(await statusOf(page)), await statusOf(page));
  check('the piece is named for what it is', /^stock_sphere_60mm/.test(sph.name), sph.name);

  console.log('\n=== 3. box and cylinder, same target, same material ===');
  const made = {};
  for (const shape of ['box', 'cylinder']) {
    const n = await modelCount(page);
    await setFields(page, { 'sel-stock-shape': shape, 'inp-stock-height': 60,
      'inp-stock-radius': null, 'inp-stock-prop': null });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
    const id = await page.evaluate(() => state.models[state.models.length - 1].id);
    await selectModel(page, id);
    made[shape] = await measure(page);
    console.log('   ' + shape.padEnd(10) + ' tris ' + made[shape].tris + '  open ' + made[shape].open +
      '  nm ' + made[shape].nm + '  vol ' + made[shape].volume.toFixed(1) +
      '  bbox ' + JSON.stringify(made[shape].size));
    check(shape + ' is closed', made[shape].open === 0 && made[shape].nm === 0);
    check(shape + ' is named for what it is', /^stock_/.test(made[shape].name), made[shape].name);
  }
  check('a box for a 60 mm target is 12 triangles and nothing more',
    made.box.tris === 12, made.box.tris + ' triangles');
  /* The whole claim of the extraction, visible on the plate: three different
     shapes, one material figure. The meshes differ by their own inscribed
     polygon deficits and nothing else, so 0.1% is generous slack on a
     statement that is exact in the profile. */
  const vols = [sph.volume, made.box.volume, made.cylinder.volume];
  const spread = (Math.max(...vols) - Math.min(...vols)) / Math.max(...vols);
  check('all three hold the same material for the same target, to within their tessellation',
    spread < 1e-3, vols.map(v => v.toFixed(1)).join(' / ') + ' mm^3 (' +
    (spread * 100).toFixed(3) + '% spread)');

  console.log('\n=== 4. the waste margin is a real control, not a constant ===');
  {
    const n = await modelCount(page);
    await setFields(page, { 'sel-stock-shape': 'sphere', 'inp-stock-height': 60, 'inp-stock-waste': 0 });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
    await selectModel(page, await page.evaluate(() => state.models[state.models.length - 1].id));
    const lean = await measure(page);
    console.log('   0% waste    bbox ' + JSON.stringify(lean.size) + '  vol ' + lean.volume.toFixed(1));
    check('0% in the box really means no margin - a 42.68 mm sphere, not 46.58',
      Math.abs(lean.size.x - 42.6827) < 0.01, lean.size.x + ' mm');
    check('...and that is the 21.341 mm radius the Pottery Wheel\'s docs published',
      Math.abs(lean.size.x / 2 - 21.341) < 0.005, (lean.size.x / 2).toFixed(4) + ' mm');
    check('...so the margin bought real material', sph.volume > lean.volume * 1.29,
      lean.volume.toFixed(1) + ' -> ' + sph.volume.toFixed(1) + ' mm^3');
  }

  console.log('\n=== 5. proportions: typed, and read off a piece ===');
  {
    const n = await modelCount(page);
    await setFields(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 60,
      'inp-stock-waste': null, 'inp-stock-prop': '4:2:1' });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
    await selectModel(page, await page.evaluate(() => state.models[state.models.length - 1].id));
    const b = await measure(page);
    /* Display geometry is Y up (zUpToYUp at import), so the box's printer-Z
       side is m.size.y. 4 : 2 : 1 in printer axes is x : z : y on screen. */
    console.log('   4:2:1 box   bbox ' + JSON.stringify(b.size));
    check('a typed 4:2:1 comes out 4 : 2 : 1',
      Math.abs(b.size.x / b.size.y - 4) < 1e-3 && Math.abs(b.size.z / b.size.y - 2) < 1e-3,
      JSON.stringify(b.size));

    /* And off a real piece, through the same NSO_extendDetectAxis Extend uses. */
    const hull = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await selectModel(page, hull);
    const n2 = await modelCount(page);
    await setFields(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 40,
      'inp-stock-radius': 12, 'inp-stock-wall': 2, 'inp-stock-prop': null, 'chk-stock-match': true });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n2, { timeout: 30000 });
    const matchStatus = await statusOf(page);
    await selectModel(page, await page.evaluate(() => state.models[state.models.length - 1].id));
    const m = await measure(page);
    console.log('   status: ' + matchStatus);
    console.log('   matched box bbox ' + JSON.stringify(m.size));
    check('Match takes the 80 x 40 x 20 hull\'s own 4 : 2 : 1',
      Math.abs(m.size.x / m.size.y - 4) < 1e-3 && Math.abs(m.size.z / m.size.y - 2) < 1e-3,
      JSON.stringify(m.size));
    check('...and the status says which piece it matched',
      /matched to/.test(matchStatus), matchStatus);
    check('...and the piece it read is untouched - Match writes to no face of it',
      await page.evaluate(h => {
        const src = state.models.find(x => x.id === h);
        return src && src.rawTris.length / 9 === 28;
      }, hull));

    /* A curved reference has no proportions to read, and the refusal is
       Extend's own - not a bounding box taken anyway. */
    const curved = await loadSTL(page, fx('fixture_sphere_curved.stl'));
    await selectModel(page, curved);
    const n3 = await modelCount(page);
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    check('matching a curved piece is refused, and nothing is added',
      (await modelCount(page)) === n3, await statusOf(page));
    await setFields(page, { 'chk-stock-match': false });
  }

  console.log('\n=== 6. the plate refusal fires, from the plate the user picked ===');
  {
    /* The default plate is the A1 Mini, 180 mm tall. A 260 mm target cannot
       physically exist on it, so the refusal must come BEFORE anything lands
       on the plate - which is the whole point of gating at generation time. */
    const plate = await page.evaluate(() => document.getElementById('plate-select').value);
    check('the app starts on the A1 Mini', plate === 'a1mini', plate);
    const n = await modelCount(page);
    await setFields(page, { 'sel-stock-shape': 'cylinder', 'inp-stock-height': 260,
      'inp-stock-radius': 40, 'inp-stock-wall': 3, 'inp-stock-prop': null });
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    const refusal = await statusOf(page);
    console.log('   status: ' + refusal);
    check('a 260 mm target on a 180 mm machine is refused', /refused/i.test(refusal));
    check('...naming the machine and the axis that does not fit',
      /Bambu A1 Mini/.test(refusal) && /Z 260/.test(refusal), refusal);
    check('...and NOTHING was added to the plate', (await modelCount(page)) === n,
      (await modelCount(page)) + ' pieces, was ' + n);

    /* Change the machine, not the target, and the same click works. That is
       the check that the gate reads the Plate card rather than a table of its
       own: a 256 mm machine takes the same 260 mm... no, it does not - so use
       a custom plate tall enough, set through the real fields. */
    await page.selectOption('#plate-select', 'custom');
    await setFields(page, { 'custom-w': 400, 'custom-d': 400, 'custom-h': 400 });
    const n2 = await modelCount(page);
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n2, { timeout: 30000 });
    check('...while a 400 mm custom machine takes the same target, target untouched',
      (await modelCount(page)) === n2 + 1, await statusOf(page));

    /* And back the other way: a plate too short refuses again, so the gate is
       live against the Plate card and not read once at load. */
    await setFields(page, { 'custom-h': 50 });
    const n3 = await modelCount(page);
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    check('...and a 50 mm-tall custom machine refuses it again, nothing added',
      (await modelCount(page)) === n3, await statusOf(page));

    /* The oversize checkbox is about the BLOCK, never the target: a target
       that cannot be printed stays refused whatever is ticked. */
    await setFields(page, { 'chk-stock-oversize': true });
    const n4 = await modelCount(page);
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(() => /refused/i.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    check('"Allow oversize block" does NOT let an impossible target through',
      (await modelCount(page)) === n4, await statusOf(page));
    await setFields(page, { 'chk-stock-oversize': false });
    await page.selectOption('#plate-select', 'a1');
  }

  console.log('\n=== 7. undo, and an ordinary piece afterwards ===');
  {
    await setFields(page, { 'sel-stock-shape': 'sphere', 'inp-stock-height': 40,
      'inp-stock-radius': null, 'inp-stock-wall': null });
    const n = await modelCount(page);
    // btn-stock-make moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-stock-make'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-make');
    await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
    const id = await page.evaluate(() => state.models[state.models.length - 1].id);
    await selectModel(page, id);
    const piece = await measure(page);
    check('the new piece carries a raw Z-up soup, like any imported STL',
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return !!(m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9);
      }, id), piece.tris + ' triangles');
    check('...so the tools that start from a blank can see it',
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return typeof NSO_Carve !== 'undefined' && typeof NSO_Hollow !== 'undefined' &&
               !!NSO_Printer.sizeOfRaw(m.rawTris);
      }, id));
    /* A generated blank is an ADDED piece, not a bake, so it takes the same
       route off the plate an imported STL takes: Delete model, which pushes
       its own undo entry, and then Undo puts it back. There is deliberately
       no wheel-style `stockReplace` undo step - nothing was replaced. */
    await page.evaluate(() => deleteActiveModel());
    check('Delete model takes the added blank off the plate, as it would an import',
      (await modelCount(page)) === n, (await modelCount(page)) + ' pieces, was ' + n);
    await page.evaluate(() => undoLast());
    check('...and undo puts it back, with its raw soup intact',
      (await modelCount(page)) === n + 1 &&
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return !!(m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length / 9 === 18240);
      }, id), (await modelCount(page)) + ' pieces');
  }

  console.log('\n=== 8. the Pottery Wheel still throws a ball on the same page ===');
  {
    const id = await loadSTL(page, fx('box-20mm.stl'));
    await selectModel(page, id);
    await page.evaluate(() => {
      const b = document.getElementById('btn-wheel-ball');
      for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    });
    // inp-wheel-height moved into the top bar's Gen dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('inp-wheel-height'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.fill('#inp-wheel-height', '60');
    await page.evaluate(() => { const e = document.getElementById('btn-wheel-ball'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-wheel-ball');
    await page.waitForFunction(() => /Ball centred/.test(document.getElementById('status').textContent),
      null, { timeout: 30000 });
    const ball = await measure(page);
    const line = await statusOf(page);
    console.log('   status: ' + line);
    check('Ball still bakes onto the SELECTED piece, the way it always has',
      ball.id === id && ball.open === 0 && ball.nm === 0, ball.tris + ' triangles');
    check('...still 46.58 mm across for a 60 mm target',
      Math.abs(ball.size.x - 46.5836) < 0.01, ball.size.x + ' mm');
    check('...and still says exactly what it said before the sizing moved out',
      /target 60\.0 x 60\.0 mm, 3\.00 mm wall: shell 40715\.0 mm\^3, \+30% waste = 52929\.6 mm\^3, ball radius 23\.292 mm/.test(line),
      line);
    check('...with the material budget still opening at 52915 mm^3',
      /52915 \/ 52915 mm\^3 clay used/.test(line), line);
  }

  console.log('\n=== 9. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-wheel-ball', 'btn-cut', 'btn-optimize',
    'btn-export-stl', 'btn-hollow', 'btn-carve'].filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  if (fails) process.exit(1);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });

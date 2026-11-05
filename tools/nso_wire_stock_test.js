/* End-to-end evidence for the Stock shelf, driven through the real app.
   node tools/nso_wire_stock_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_wheel_test.js: real index.html, real script
   tags, real clicks, real undo. The headless proofs live in
   tools/nso_stock_test.js and tools/nso_stock_canonical_check.js, and the
   shelf's own drive check (tools/nso_stock_shelf_drive.js) proves the tiles,
   the drop, where it lands and what Scale offers it; what this file exists to
   prove is that the shelf is its OWN menu rather than a fifth button on the
   Pottery Wheel's card, that every tile puts an ordinary, closed piece on the
   plate that the tools which start from a blank can see, that the plate-size
   refusal fires from the machine the Plate card is actually pointed at, and
   that the Pottery Wheel still throws a ball on the same page.

   The old card's fields (target height / radius, wall, nozzle, waste, the
   proportions box, Match, Oversize) are gone, and so are their sections here:
   a piece is sized in the Scale card now, which tools/nso_stock_live_test.js
   and the scale suites drive. */

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


const SHAPES = ['box', 'cylinder', 'sphere', 'capsule', 'ellipsoid', 'torus', 'tube', 'cone'];

const modelCount = page => page.evaluate(() => state.models.length);

withApp(async (page, logs) => {
  console.log('\n=== 1. the shelf exists, is reachable, and is NOT the wheel\'s ===');
  const ui = await page.evaluate(() => {
    const stockMenu = document.querySelector('.vp-stock-menu');
    const wheelMenu = document.querySelector('.vp-wheel-menu');
    const tiles = [...document.querySelectorAll('#stock-shelf button[data-shape]')];
    return {
      tiles: tiles.map(b => b.dataset.shape),
      wired: tiles.every(b => b.dataset.nsoWired === '1'),
      ownMenu: !!stockMenu && !!wheelMenu && stockMenu !== wheelMenu,
      /* The whole point of "independent of Pottery Wheel's own menu": no tile
         may be inside the wheel's card. */
      insideWheelMenu: tiles.some(b => wheelMenu && wheelMenu.contains(b)),
      inStockMenu: tiles.every(b => stockMenu && stockMenu.contains(b)),
      generator: NSO_Stock.SHAPES.slice(),
      fields: stockMenu ? stockMenu.querySelectorAll('input, select, textarea').length : -1
    };
  });
  check('one tile per shape the module makes, each wired', [...ui.tiles].sort().join() === [...ui.generator].sort().join() && ui.wired,
    ui.tiles.join(','));
  check('the shelf is its own menu, apart from the wheel\'s', ui.ownMenu && ui.inStockMenu && !ui.insideWheelMenu);
  check('...with no field on it', ui.fields === 0, ui.fields + ' field(s)');

  console.log('\n=== 2. every tile puts an ordinary, closed piece on the plate ===');
  const made = {};
  for (const shape of SHAPES) {
    const before = await modelCount(page);
    await page.evaluate(() => { const e = document.getElementById('btn-stock-box'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-stock-' + shape);
    await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
    const piece = await measure(page);
    const gen = await page.evaluate(sh => {
      const r = NSO_Stock.size(Object.assign(nsoStockShelf.defaultOptions(sh), { printer: NSO_fitCurrentPrinter() }));
      return { built: r.built_volume * r.polygon_factor, need: r.need_volume };
    }, shape);
    made[shape] = piece;
    console.log('   ' + shape.padEnd(10) + piece.name.padEnd(12) + 'tris ' + String(piece.tris).padEnd(6) + ' open ' + piece.open + '  nm ' + piece.nm +
      '  vol ' + piece.volume.toFixed(1) + ' (generator ' + gen.built.toFixed(1) + ')  bbox ' + JSON.stringify(piece.size));
    check(shape + ': one piece added, selected, closed (0 open, 0 non-manifold)',
      (await modelCount(page)) === before + 1 && piece.id === (await page.evaluate(() => state.editId)) && piece.open === 0 && piece.nm === 0,
      piece.open + ' open, ' + piece.nm + ' non-manifold');
    check('  ...holding the volume the generator says the mesh holds, to 0.1%',
      Math.abs(piece.volume - gen.built) / gen.built < 1e-3, piece.volume.toFixed(2) + ' vs ' + gen.built.toFixed(2));
  }
  check('a sphere is round - all three bbox axes equal', made.sphere.size.x === made.sphere.size.y && made.sphere.size.y === made.sphere.size.z,
    JSON.stringify(made.sphere.size));
  check('the shapes are different sizes (each is sized for its own volume)',
    new Set(SHAPES.map(sh => made[sh].volume.toFixed(0))).size >= 5, SHAPES.map(sh => made[sh].volume.toFixed(0)).join(' '));
  check('the status names what was dropped and how to size it', /^Dropped cone 8 /.test(await statusOf(page)) && /Scale/.test(await statusOf(page)), await statusOf(page));

  console.log('\n=== 3. the plate refusal fires, from the plate the user picked ===');
  {
    const n = await modelCount(page);
    await page.evaluate(() => {
      const sel = document.getElementById('plate-select');
      sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      for (const id of ['custom-w', 'custom-d', 'custom-h']) {
        const el = document.getElementById(id);
        el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.click('#btn-stock-cylinder');
    const line = await statusOf(page);
    console.log('   status: ' + line);
    check('a default block the Custom 30 mm plate cannot hold is refused, in words, and nothing is added',
      (await modelCount(page)) === n && /refused/i.test(line) && /Custom/.test(line), line.slice(0, 100));
    await page.evaluate(() => {
      const sel = document.getElementById('plate-select');
      sel.value = 'a1mini'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#btn-stock-cylinder');
    check('...and back on the real plate the same tile drops', (await modelCount(page)) === n + 1);
  }

  console.log('\n=== 4. an ordinary piece afterwards ===');
  {
    const id = await page.evaluate(() => state.models[state.models.length - 1].id);
    const n = await modelCount(page);
    check('the new piece carries a raw Z-up soup, like any imported STL',
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return !!(m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9);
      }, id));
    check('...so the tools that start from a blank can see it',
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return typeof NSO_Carve !== 'undefined' && typeof NSO_Hollow !== 'undefined' &&
               !!NSO_Printer.sizeOfRaw(m.rawTris);
      }, id));
    /* A dropped blank is an ADDED piece, not a bake, so it takes the same
       route off the plate an imported STL takes: Delete model, which pushes
       its own undo entry, and then Undo puts it back. */
    await page.evaluate(() => deleteActiveModel());
    check('Delete model takes the dropped blank off the plate, as it would an import',
      (await modelCount(page)) === n - 1, (await modelCount(page)) + ' pieces, was ' + n);
    await page.evaluate(() => undoLast());
    check('...and undo puts it back, with its raw soup intact',
      (await modelCount(page)) === n &&
      await page.evaluate(i => {
        const m = state.models.find(x => x.id === i);
        return !!(m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length / 9 === 384);
      }, id), (await modelCount(page)) + ' pieces');
  }

  console.log('\n=== 5. the Pottery Wheel still throws a ball on the same page ===');
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

  console.log('\n=== 6. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-wheel-ball', 'btn-cut', 'btn-optimize',
    'btn-export-stl', 'btn-hollow', 'btn-carve'].filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  if (fails) process.exit(1);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });

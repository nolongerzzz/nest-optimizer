/* The Stock shelf, driven through the real app: Gen+ > Stock is one row of
   shape tiles, and a click drops that shape on the plate.
   node tools/nso_stock_shelf_drive.js               exit 0 = every gate held
   node tools/nso_stock_shelf_drive.js --shots DIR   also write DIR/*.png
                                                     (a scratch directory - no
                                                     screenshot is committed)

   What the ticket asked for, and the section that proves it:

     1  one tile per shape nso_stock.js makes, in the ticket's order (Box,
        Cylinder, Sphere, Capsule, Ellipsoid, Torus, Tube, Cone), each a 56 px
        canvas with no text on it, painted once from the generator and each a
        different picture; no field of any kind on the card, and none of the
        old card's ids on the page
     2  a click puts the shape on the plate at once: one piece, at the size
        the generator gives for the default target (read from the generator in
        the page, and printed), selected (both halves of "selected"),
        named "<shape> <n>", centred on an empty plate; and it is tagged, so
        Scale reads the shape's own parameters
     3  a second click on the same tile drops another - a second piece, on
        free plate, clear of the first and not on top of it - and the piece
        that was selected is left exactly as it was (NEGATIVE CONTROL)
     4  a drop lands beside the selected piece when one is selected, and on
        free space at the middle when nothing is
     5  the Scale card opens on that shape's rows: per shape, the rows it
        shows and the readout it leads with
     6  Undo removes the last drop and only that one, and hands its number back
     7  a default block the plate cannot hold is refused, and nothing is added

   Every number is printed; the PR quotes them. */

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, openMenuFor, ROOT } = require('./nso_app_harness');

const SHOTS = (() => {
  const i = process.argv.indexOf('--shots');
  if (i < 0) return null;
  const dir = process.argv[i + 1];
  if (!dir || dir.startsWith('--')) { console.error('--shots needs a directory (a scratch one: no PNG goes in the repo)'); process.exit(2); }
  return path.resolve(dir);
})();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

/* The ticket's order. nso_stock.js offers no wedge, so there is no Wedge tile:
   the shelf is whatever the module offers, in this order. */
const ORDER = ['box', 'cylinder', 'sphere', 'capsule', 'ellipsoid', 'torus', 'tube', 'cone'];

/* Every row the Scale card can show (the ids are 'scale-<row>-row'). */
const ROWS = ['length', 'width', 'height', 'ring-outer', 'ring-bore', 'ring-wall', 'rod-diameter', 'offset',
              'cap-length', 'cap-diameter', 'ell-a', 'ell-b', 'ell-c', 'torus-ring', 'torus-tube', 'factor', 'longest'];

/* What Scale offers a freshly dropped piece of each shape, and what its
   readout starts with. A cone has no per-dimension rows: Scale reads it as
   curved or tapered all over, so only an even offset and whole-piece scaling
   apply - printed, and said in the PR, rather than assumed. */
const SCALE = {
  box:       { rows: ['length', 'width', 'height', 'offset', 'factor'], lead: /^Bar / },
  cylinder:  { rows: ['height', 'rod-diameter', 'factor'], lead: /^Rod Ø/ },
  sphere:    { rows: ['ell-a', 'ell-b', 'ell-c', 'factor'], lead: /^Sphere Ø.*\(Stock\)/ },
  capsule:   { rows: ['cap-length', 'cap-diameter', 'factor'], lead: /^Capsule Ø.*\(Stock\)/ },
  ellipsoid: { rows: ['ell-a', 'ell-b', 'ell-c', 'factor'], lead: /^Ellipsoid .*\(Stock\)/ },
  torus:     { rows: ['torus-ring', 'torus-tube', 'factor', 'longest'], lead: /^Torus ring Ø.*\(Stock\)/ },
  tube:      { rows: ['height', 'ring-outer', 'ring-bore', 'ring-wall', 'factor'], lead: /^Ring Ø/ },
  cone:      { rows: ['offset', 'factor', 'longest'], lead: /curved or tapered all over/ }
};

/* Everything about the plate that a drop should change, and what it should
   not, in one read. */
const look = page => page.evaluate(() => {
  const sel = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
  const fp = p => { const f = placedFootprint(p); return { minx: f.minx, maxx: f.maxx, minz: f.minz, maxz: f.maxz }; };
  const sum = m => { let s = 0; for (let i = 0; i < m.rawTris.length; i++) s += m.rawTris[i]; return +s.toFixed(4); };
  return {
    models: state.models.map(m => ({ id: m.id, name: m.name, size: [m.size.x, m.size.y, m.size.z], tris: m.rawTris.length / 9, sum: sum(m) })),
    placed: state.placed.map(p => ({ id: p.sourceId, x: p.x, z: p.z, fp: fp(p) })),
    scene: state.modelGroup.children.length,
    selectedIndex: state.selectedIndex, editId: state.editId,
    selectedId: sel ? sel.sourceId : null,
    outlinedId: (state.selectedIndex >= 0 && state.placed[state.selectedIndex]) ? state.placed[state.selectedIndex].sourceId : null,
    undo: state.undoStack.length,
    status: document.getElementById('status').textContent
  };
});

/* What the generator says a default drop of `shape` is - asked of the module
   in the page, with the machine the Plate card is pointed at, exactly as the
   click asks it. */
const generated = (page, shape) => page.evaluate(sh => {
  const o = nsoStockShelf.defaultOptions(sh);
  o.printer = NSO_fitCurrentPrinter();
  const r = NSO_Stock.make(o);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < r.soup.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], r.soup[i + k]); hi[k] = Math.max(hi[k], r.soup[i + k]); }
  return { ok: r.ok, tris: r.soup.length / 9, span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], text: r.sizing && r.sizing.measure_text };
}, shape);

const openShelf = async page => {
  const open = await page.evaluate(() => {
    const g = document.getElementById('menu-gen'), s = g.querySelector('.vp-stock-menu');
    return { gen: g.open, stock: s.open };
  });
  if (!open.gen) await page.click('#menu-gen > summary');
  if (!open.stock) await page.click('#menu-gen .vp-stock-menu > summary');
  await page.waitForFunction(() => nsoStockShelf.drawn(), null, { timeout: 15000 });
};
const clickTile = async (page, shape) => { await openShelf(page); await page.click('#btn-stock-' + shape); };
/* A fresh plate: the pieces off it AND out of the model list (the Clear plate
   button leaves the list, so its numbering carries on - this starts over). */
const clearPlate = page => page.evaluate(() => {
  clearPlateOnly();
  state.models.length = 0; state.editId = null; state.selectedIndex = -1; state.undoStack.length = 0;
  renderModelList(); updateUndoBtn();
});

const scaleCard = async page => {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(rows => ({
    readout: document.getElementById('scale-readout').textContent,
    rows: rows.filter(r => { const e = document.getElementById('scale-' + r + '-row'); return e && getComputedStyle(e).display !== 'none'; })
  }), ROWS);
};

const overlaps = (a, b) => Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) > 0.02 &&
                           Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz) > 0.02;

withApp(async (page, logs) => {
  await page.waitForTimeout(400);

  console.log('\n=== 1. the shelf: one tile per shape, drawn from the generator, no fields ===');
  {
    await openShelf(page);
    const card = await page.evaluate(() => {
      const menu = document.querySelector('#menu-gen .vp-stock-menu');
      const tiles = [...menu.querySelectorAll('button')];
      const px = c => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 2166136261 >>> 0, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          h = Math.imul(h ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
          if (Math.abs(d[i] - 20) + Math.abs(d[i + 1] - 23) + Math.abs(d[i + 2] - 28) > 40) lit++;
        }
        return { h, lit };
      };
      return {
        order: tiles.map(b => b.dataset.shape),
        generator: NSO_Stock.SHAPES.slice(),
        tiles: tiles.map(b => {
          const c = b.querySelector('canvas'), bb = b.getBoundingClientRect();
          return { shape: b.dataset.shape, id: b.id, text: b.textContent.trim(), canvases: b.querySelectorAll('canvas').length,
                   img: b.querySelectorAll('img').length, w: c.width, h: c.height, box: [Math.round(bb.width), Math.round(bb.height)],
                   name: b.getAttribute('aria-label'), drawn: c.dataset.drawn, lit: px(c).lit, hash: px(c).h };
        }),
        other: [...menu.querySelectorAll('input, select, textarea, label, img, output, p')].map(e => e.tagName + (e.id ? '#' + e.id : '')),
        oneRow: new Set(tiles.map(b => Math.round(b.getBoundingClientRect().top))).size === 1,
        inside: tiles.every(b => { const r = b.getBoundingClientRect(); return r.right <= window.innerWidth && r.left >= 0; }),
        oldIds: ['sel-stock-shape', 'inp-stock-height', 'inp-stock-radius', 'inp-stock-wall', 'inp-stock-nozzle', 'inp-stock-waste',
                 'inp-stock-prop', 'chk-stock-match', 'chk-stock-oversize', 'btn-stock-make',
                 'row-stock-prop', 'lab-stock-prop'].filter(id => document.getElementById(id)),
        /* Attach moved to the Connect card, keeping its id: it is on the page, but not on this card. */
        attachElsewhere: !!document.getElementById('btn-stock-attach') && !menu.contains(document.getElementById('btn-stock-attach')) &&
                         !!document.getElementById('connect-panel').contains(document.getElementById('btn-stock-attach')),
        redraw: nsoStockShelf.draw()
      };
    });
    await shot(page, '1-shelf');
    console.log('   tiles: ' + card.order.join(', '));
    check('one tile per shape, in the ticket\'s order', card.order.join() === ORDER.join(), card.order.join());
    check('...and that is every shape nso_stock.js makes, no more, no fewer',
      [...card.order].sort().join() === [...card.generator].sort().join(), card.generator.join());
    check('each tile is a button with a name and a 56 x 56 canvas, and no text on it',
      card.tiles.every(t => t.canvases === 1 && t.w === 56 && t.h === 56 && t.text === '' && t.img === 0 && t.name && t.id === 'btn-stock-' + t.shape),
      card.tiles.map(t => t.shape + ':' + t.w + 'x' + t.h).join(' '));
    check('...and each is on screen, 56 px a side, all in one row',
      card.oneRow && card.inside && card.tiles.every(t => t.box[0] === 56 && t.box[1] === 56), JSON.stringify(card.tiles.map(t => t.box[0])));
    check('every tile is painted - something other than the ground is on it',
      card.tiles.every(t => t.drawn === '1' && t.lit > 150), card.tiles.map(t => t.shape + ':' + t.lit).join(' '));
    check('...and every tile is a different picture',
      new Set(card.tiles.map(t => t.hash)).size === ORDER.length, card.tiles.map(t => t.hash.toString(16)).join(' '));
    check('...painted once: asking again draws nothing', card.redraw === 0, 'redraw: ' + card.redraw);
    check('the Stock card has no field, label, select, picture or line of text - tiles only',
      card.other.length === 0, card.other.join(', ') || 'none');
    check('none of the old card\'s ids is on the page', card.oldIds.length === 0, card.oldIds.map(e => e.id).join(', ') || 'none');
    check('...and Attach, which was on it, is in the Connect card now (same id), not on this one', card.attachElsewhere);
  }

  console.log('\n=== 2. one click: the piece is on the plate, at its default size, selected ===');
  const SIZES = {};
  {
    for (const sh of ORDER) {
      await clearPlate(page);
      const gen = await generated(page, sh);
      const before = await look(page);
      await clickTile(page, sh);
      const a = await look(page);
      const made = a.models[a.models.length - 1];
      SIZES[sh] = made.size.map(v => +v.toFixed(3));
      const span = made.size;
      // the display frame is Y-up: the generator's Z is the piece's height
      const want = [gen.span[0], gen.span[2], gen.span[1]];
      const tag = await page.evaluate(i => { const m = state.models.find(x => x.id === i); return NSO_shapeTagOf(m.rawTris) ? 'tagged' : 'untagged'; }, made.id);
      console.log('   ' + sh.padEnd(10) + made.name.padEnd(11) + span.map(v => v.toFixed(3)).join(' x ') + '   ' + gen.tris + ' tris, ' + tag);
      check(sh + ': one piece on the plate at once, nothing else added',
        before.models.length === 0 && a.models.length === 1 && a.placed.length === 1 && a.scene === 1, a.models.length + ' model(s), ' + a.scene + ' in the scene');
      check('  ...the generator\'s own size for the default target',
        gen.ok && span.every((v, k) => Math.abs(v - want[k]) < 1e-3) && made.tris === gen.tris,
        span.map(v => v.toFixed(3)).join(' x ') + ' vs ' + want.map(v => v.toFixed(3)).join(' x '));
      check('  ...selected, and both halves of selected agree',
        a.selectedIndex === 0 && a.editId === made.id && a.outlinedId === made.id, 'editId ' + a.editId + ', outlined ' + a.outlinedId);
      check('  ...centred on the empty plate', Math.abs(a.placed[0].x) < 1e-6 && Math.abs(a.placed[0].z) < 1e-6, a.placed[0].x + ', ' + a.placed[0].z);
      check('  ...named "' + sh + ' 1"', made.name === sh + ' 1', made.name);
      check('  ...one undo step, and the status says what happened',
        a.undo === before.undo + 1 && /^Dropped /.test(a.status), 'undo ' + a.undo + ', ' + a.status.slice(0, 90));
    }
    check('a capsule and a sphere and a box are three different sizes (the defaults are the shapes\', not one figure)',
      SIZES.capsule.join() !== SIZES.sphere.join() && SIZES.sphere.join() !== SIZES.box.join());
    check('an ellipsoid is not a sphere: its default is stretched', SIZES.ellipsoid.join() !== SIZES.sphere.join(), SIZES.ellipsoid.join(' x '));
  }

  console.log('\n=== 3. a second click on the same tile drops another ===');
  {
    await clearPlate(page);
    await clickTile(page, 'box');
    const a = await look(page);
    await clickTile(page, 'box');
    const b = await look(page);
    const [p1, p2] = b.placed;
    console.log('   box 1 at ' + p1.x.toFixed(1) + ', ' + p1.z.toFixed(1) + '   box 2 at ' + p2.x.toFixed(1) + ', ' + p2.z.toFixed(1));
    check('two clicks, two pieces, two in the scene', b.models.length === 2 && b.placed.length === 2 && b.scene === 2, b.models.length + ' model(s)');
    check('...named box 1 and box 2', b.models.map(m => m.name).join() === 'box 1,box 2', b.models.map(m => m.name).join());
    check('...the second is selected, not the first', b.selectedId === b.models[1].id && b.editId === b.models[1].id && b.outlinedId === b.models[1].id);
    check('...on free plate: clear of the first, and on the bed',
      !overlaps(p1.fp, p2.fp) && Math.abs(p2.x) < 90 && Math.abs(p2.z) < 90, JSON.stringify([p1.fp, p2.fp].map(f => [f.minx, f.maxx].map(v => +v.toFixed(1)))));
    check('NEGATIVE CONTROL: the first box is untouched - same geometry, same place',
      a.models[0].sum === b.models[0].sum && a.models[0].tris === b.models[0].tris && a.placed[0].x === b.placed[0].x && a.placed[0].z === b.placed[0].z,
      'sum ' + a.models[0].sum + ' -> ' + b.models[0].sum);
    await clickTile(page, 'cylinder');
    const c = await look(page);
    check('a different tile carries the running number on: "cylinder 3", not "cylinder 1"',
      c.models.map(m => m.name).join() === 'box 1,box 2,cylinder 3', c.models.map(m => m.name).join());
    await shot(page, '3-three-pieces');
  }

  console.log('\n=== 4. where it lands: beside the selected piece, or the middle of free plate ===');
  {
    await clearPlate(page);
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(200);
    await page.evaluate(() => { selectPlaced(0); applyPlacedXZ(state.placed[0], -50, 20); });
    const a = await look(page);
    await clickTile(page, 'sphere');
    const b = await look(page);
    const f0 = a.placed[0].fp, f1 = b.placed[1].fp;
    console.log('   selected box at x ' + a.placed[0].x + ', z ' + a.placed[0].z + '; the sphere at x ' + b.placed[1].x.toFixed(1) + ', z ' + b.placed[1].z.toFixed(1));
    check('with a piece selected, the drop is beside it: to its right, on its row, not touching',
      f1.minx > f0.maxx && Math.abs(b.placed[1].z - a.placed[0].z) < 1 && !overlaps(f0, f1),
      'sphere minx ' + f1.minx.toFixed(1) + ' > box maxx ' + f0.maxx.toFixed(1));
    check('...and says which piece it is beside', /beside /.test(b.status), b.status.slice(0, 120));
    check('...and the status line names the way to size it', /Scale/.test(b.status));

    // Nothing selected: the middle, if it is free; else the nearest free place to it.
    await page.evaluate(() => { state.selectedIndex = -1; clearSelectionOutline(); applyPlacedXZ(state.placed[0], 0, 0); });
    await clickTile(page, 'cylinder');
    const c = await look(page);
    const cyl = c.placed[c.placed.length - 1], boxFp = c.placed[0].fp;
    console.log('   nothing selected, a box in the middle: the cylinder at x ' + cyl.x.toFixed(1) + ', z ' + cyl.z.toFixed(1));
    check('with nothing selected and the middle taken, it takes the nearest free plate: clear of every piece, on the bed',
      c.placed.slice(0, -1).every(p => !overlaps(p.fp, cyl.fp)) && Math.abs(cyl.x) < 90 && Math.abs(cyl.z) < 90 &&
      Math.hypot(cyl.x, cyl.z) < 45, 'at ' + cyl.x.toFixed(1) + ', ' + cyl.z.toFixed(1));
    check('...and it is selected, as every drop is', c.selectedId === c.models[c.models.length - 1].id);
  }

  console.log('\n=== 5. the Scale card opens on that shape\'s rows ===');
  {
    for (const sh of ORDER) {
      await clearPlate(page);
      await clickTile(page, sh);
      const c = await scaleCard(page);
      console.log('   ' + sh.padEnd(10) + c.rows.join(', ') + '   |   ' + c.readout.slice(0, 80));
      check(sh + ': Scale shows ' + SCALE[sh].rows.join(', '),
        c.rows.join() === SCALE[sh].rows.join(), c.rows.join());
      check('  ...and leads with the shape: ' + SCALE[sh].lead, SCALE[sh].lead.test(c.readout), c.readout.slice(0, 90));
    }
    await shot(page, '5-scale-on-a-cone');
  }

  console.log('\n=== 6. Undo removes the last drop ===');
  {
    await clearPlate(page);
    await clickTile(page, 'box');
    await clickTile(page, 'torus');
    await clickTile(page, 'capsule');
    const a = await look(page);
    await page.click('#btn-undo');
    const b = await look(page);
    console.log('   ' + a.models.map(m => m.name).join(', ') + '  ->  Undo  ->  ' + b.models.map(m => m.name).join(', '));
    check('Undo takes the capsule off, and only the capsule',
      a.models.length === 3 && b.models.length === 2 && b.models.map(m => m.name).join() === 'box 1,torus 2' && b.scene === 2 && b.placed.length === 2,
      b.models.map(m => m.name).join());
    check('...the other two are as they were',
      b.models.every((m, i) => m.sum === a.models[i].sum) && b.placed.every((p, i) => p.x === a.placed[i].x && p.z === a.placed[i].z));
    await clickTile(page, 'cone');
    const c = await look(page);
    check('...and hands its number back: the next drop is "cone 3"', c.models.map(m => m.name).join() === 'box 1,torus 2,cone 3', c.models.map(m => m.name).join());
    await page.click('#btn-undo');
    await page.click('#btn-undo');
    await page.click('#btn-undo');
    const d = await look(page);
    check('...Undo to the start: an empty plate, nothing left in the scene', d.models.length === 0 && d.placed.length === 0 && d.scene === 0,
      d.models.length + ' model(s), ' + d.scene + ' in the scene');
  }

  console.log('\n=== 7. a block the plate cannot hold is refused, and nothing is added ===');
  {
    await clearPlate(page);
    await page.evaluate(() => {
      const sel = document.getElementById('plate-select');
      sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      for (const [id, v] of [['custom-w', 30], ['custom-d', 30], ['custom-h', 30]]) {
        const el = document.getElementById(id);
        el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const a = await look(page);
    await clickTile(page, 'cylinder');
    const b = await look(page);
    console.log('   30 x 30 x 30 plate: ' + b.status.slice(0, 130));
    check('a 40 mm default on a 30 mm plate: refused in words, nothing on the plate, nothing on the undo stack',
      /refused/i.test(b.status) && b.models.length === 0 && b.placed.length === 0 && b.scene === 0 && b.undo === a.undo, b.status.slice(0, 100));
    await page.evaluate(() => {
      const sel = document.getElementById('plate-select');
      sel.value = 'a1mini'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await clickTile(page, 'cylinder');
    const c = await look(page);
    check('...and back on a real plate the same tile drops', c.models.length === 1 && c.models[0].name === 'cylinder 1', c.models.map(m => m.name).join());
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  check('no console errors across the whole run', errs.length === 0, errs.slice(0, 3).map(e => e.slice(0, 120)).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_stock_shelf_drive.js)');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });

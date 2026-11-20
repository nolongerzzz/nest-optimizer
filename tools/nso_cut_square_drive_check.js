/* nso_cut_square_drive_check.js - the Cut blade's default angle, and what Undo of a cut leaves.
     node tools/nso_cut_square_drive_check.js        exit 0 = every gate held

   WHAT IS PINNED
   - A bracket whose legs differ in length (a chunky footprint whose narrowest rectangle lies on a diagonal, 4% smaller than the box
     along its own axes) loads with the blade SQUARE to its walls - base 0, the blade's normal along a plate axis - not on the
     diagonal (nso-bounds.js "WALLS ALONG THE BODY"; it loaded at 29.7 degrees on the owner's Desk Side Hanger).
   - A bar modelled on a 30 degree slant still reads off its hull: the blade is square to the BAR (base about 30), so the wall rule does
     not take the body axes where the walls are not along them.
   - Undo of a cut made with the card open leaves the card open, the piece back and selected, and the blade where it stood: the same
     blade (Chop or Plane), place, mitre and bevel. A cut made with the card shut still closes it. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-square-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

/* A simple polygon (counter-clockwise, x/y in mm) extruded up by h, as a triangle soup, by ear clipping. */
function extrude(poly, h) {
  const n = poly.length, idx = poly.map((_, i) => i), tris = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i + idx.length - 1) % idx.length]], b = poly[idx[i]], c = poly[idx[(i + 1) % idx.length]];
      if (cross(a, b, c) <= 1e-9) continue;
      if (idx.some(j => { const p = poly[j]; return p !== a && p !== b && p !== c && inside(p, a, b, c); })) continue;
      tris.push([a, b, c]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  tris.push([poly[idx[0]], poly[idx[1]], poly[idx[2]]]);
  const o = [];
  tris.forEach(([a, b, c]) => { o.push(a[0], a[1], h, b[0], b[1], h, c[0], c[1], h); o.push(a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0); });
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    o.push(p[0], p[1], 0, q[0], q[1], 0, q[0], q[1], h, p[0], p[1], 0, q[0], q[1], h, p[0], p[1], h);
  }
  return o;
}

const BRACKET = [[0, 0], [59, 0], [59, 59], [92, 59], [92, 28], [107, 28], [107, 106], [92, 106], [92, 71], [41, 71], [41, 12], [11, 12], [11, 49], [0, 49]];
const rot = (poly, deg) => poly.map(([x, y]) => [x * Math.cos(deg * Math.PI / 180) - y * Math.sin(deg * Math.PI / 180), x * Math.sin(deg * Math.PI / 180) + y * Math.cos(deg * Math.PI / 180)]);
const BAR30 = rot([[0, 0], [90, 0], [90, 14], [0, 14]], 30);

withApp(async (page, logs) => {
  const pickByName = name => page.evaluate(n => { const m = state.models.find(x => x.name === n); selectPlaced(state.placed.findIndex(p => p && p.sourceId === m.id)); return m.id; }, name);
  const frame = () => page.evaluate(() => { const i = getCutPlaneLocal(getActiveModel()); const w = i.normalWorld.toArray();
    return { base: +i.base.toFixed(2), axis: i.axis, span: +i.span.toFixed(1), mm: i.mm, nx: +w[0].toFixed(3), nz: +w[2].toFixed(3), status: document.getElementById('status').textContent }; });

  console.log('the square blade');
  await loadSTL(page, stl('bracket.stl', extrude(BRACKET, 12)));
  await loadSTL(page, stl('bar30.stl', extrude(BAR30, 8)));
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(300);
  await pickByName('bracket');
  await page.waitForTimeout(400);
  let f = await frame();
  check('the bracket loads with the blade square to its walls (base 0)', f.base === 0, JSON.stringify(f));
  check('...the blade\'s normal along a plate axis', (Math.abs(f.nx) > 0.999 && Math.abs(f.nz) < 0.02) || (Math.abs(f.nz) > 0.999 && Math.abs(f.nx) < 0.02), JSON.stringify({ nx: f.nx, nz: f.nz }));
  await pickByName('bar30');
  await page.waitForTimeout(400);
  f = await frame();
  check('a bar modelled on a 30 degree slant still reads off its hull: the blade is square to the BAR (base about 30)', Math.abs(Math.abs(f.base) - 30) < 1.5, JSON.stringify(f));
  check('...its span is the bar\'s length (90 mm)', Math.abs(f.span - 90) < 0.5, 'span ' + f.span);

  console.log('Undo of a cut');
  await pickByName('bracket');
  await page.waitForTimeout(300);
  await page.evaluate(() => { setCutMiter(20); setCutBevel(10); const i = getCutPlaneLocal(getActiveModel()); state.cutT = 31 / i.span; syncCutUI(); updateCutHelper(); });
  const before = await page.evaluate(() => { const i = getCutPlaneLocal(getActiveModel()); return { mm: i.mm, miter: state.cutMiterDeg, bevel: state.cutBevelDeg, mode: state.cutBlade && state.cutBlade.mode || 'full' }; });
  await page.click('#btn-cut');
  await page.waitForTimeout(1800);
  const cut = await page.evaluate(() => ({ models: state.models.length, open: state.cutterOpen }));
  check('the Cut made two pieces from the bracket', cut.models === 3, JSON.stringify(cut));
  await page.click('#btn-undo');
  await page.waitForTimeout(1200);
  const u = await page.evaluate(() => { const m = getActiveModel(), i = m ? getCutPlaneLocal(m) : null;
    return { models: state.models.length, open: state.cutterOpen, card: document.getElementById('menu-cut').open, helper: !!state.cutHelper, name: m && m.name, selected: state.selectedIndex,
             mm: i && i.mm, miter: state.cutMiterDeg, bevel: state.cutBevelDeg, mode: state.cutBlade && state.cutBlade.mode || 'full' }; });
  check('Undo leaves the Cut card open', u.open === true && u.card === true, JSON.stringify(u));
  check('...the bracket is back (one piece again) and selected, with the blade on it', u.models === 3 - 1 && u.name === 'bracket' && u.selected >= 0 && u.helper === true, JSON.stringify(u));
  check('...the blade stands where it stood: the same place, mitre, bevel and blade', u.mm === before.mm && u.miter === before.miter && u.bevel === before.bevel && u.mode === before.mode, JSON.stringify({ before: before, after: { mm: u.mm, miter: u.miter, bevel: u.bevel, mode: u.mode } }));

  await page.evaluate(() => { cutSetBladeMode('plane'); cutBladeRefresh(); setCutMiter(0); setCutBevel(0); const i = getCutPlaneLocal(getActiveModel()); state.cutT = 5 / i.span; syncCutUI(); updateCutHelper(); });
  const pb = await page.evaluate(() => ({ mm: getCutPlaneLocal(getActiveModel()).mm, mode: state.cutBlade.mode }));
  await page.click('#btn-cut');
  await page.waitForTimeout(1800);
  await page.click('#btn-undo');
  await page.waitForTimeout(1200);
  const pu = await page.evaluate(() => { const m = getActiveModel(); return { open: state.cutterOpen, helper: !!state.cutHelper, mm: m && getCutPlaneLocal(m).mm, mode: state.cutBlade && state.cutBlade.mode, plane: document.getElementById('btn-cut-blade-plane').getAttribute('aria-pressed') }; });
  check('the same after a Plane: the card stays open, Plane is still the blade, and it stands at the same place', pu.open && pu.helper && pu.mm === pb.mm && pu.mode === 'plane' && pu.plane === 'true', JSON.stringify({ before: pb, after: pu }));

  console.log('a cut made with the card shut');
  await page.evaluate(() => { state.cutterOpen = false; updateCutterUI(); });
  const shut = await page.evaluate(() => { pushUndo({ type: 'splitReplace', source: null, newIds: [], siblings: state.models.slice(), editId: null, cutT: 0.5 }); undoLast(); return { open: state.cutterOpen, card: document.getElementById('menu-cut').open }; });
  check('an Undo of a cut made with the card shut leaves it shut, as before', shut.open === false && shut.card === false, JSON.stringify(shut));

  check('no page errors', logs.filter(l => /pageerror|Uncaught/i.test(String(l))).length === 0, JSON.stringify(logs.slice(0, 3)));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
});

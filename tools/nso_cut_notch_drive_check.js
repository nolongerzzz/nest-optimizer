/* nso_cut_notch_drive_check.js - the Cut card's DICE (the knife) and NOTCH on a
   bar, driven through the real app (index.html + every app-*.js) in real
   Chromium, against the real manifold kernel.
     node tools/nso_cut_notch_drive_check.js        exit 0 = every gate held

   What is pinned
   - The card: Chop is the default; Dice shows nothing to set; Notch shows its own.
   - Dice, clicked on the bar's top: it goes clean through - two pieces that add
     back to the bar exactly (no kerf), both closed - in ONE Undo, which gives the
     bar back vertex for vertex. Mitred, bevelled and on a turned piece the same.
   - Notch clicked on a side face goes in from the side, takes exactly
     nwidth x ndepth x the face's height, and the bar stays one piece.
   - A notch width under the floor is refused and the piece is left alone.
   - The FULL blade is untouched: it still splits one piece into two that add
     back to the original.

   The bar is 60 (x) x 20 x 20, 24000 mm^3, lying on the plate.            */

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

function bar(L, W, Ht) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]); q([0, 0, Ht], [L, 0, Ht], [L, W, Ht], [0, W, Ht]);
  q([0, 0, 0], [L, 0, 0], [L, 0, Ht], [0, 0, Ht]); q([0, W, 0], [0, W, Ht], [L, W, Ht], [L, W, 0]);
  q([0, 0, 0], [0, 0, Ht], [0, W, Ht], [0, W, 0]); q([L, 0, 0], [L, W, 0], [L, W, Ht], [L, 0, Ht]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-notch-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

/* In the page: the piece's volume (signed, from its geometry), its edge counts
   from the app's own adjacency, and its triangle count. */
const PROBE = `window.__probe = function (id) {
  const m = state.models.find(x => x.id === id);
  if (!m) return null;
  const g = m.geometry, pos = g.attributes.position, idx = g.index;
  const n = idx ? idx.count / 3 : pos.count / 3;
  const P = k => { const i = idx ? idx.getX(k) : k; return [pos.getX(i), pos.getY(i), pos.getZ(i)]; };
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const a = P(t * 3), b = P(t * 3 + 1), c = P(t * 3 + 2);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const adj = m.rawTris ? NSO_buildAdjacency(m.rawTris, { tol: 1e-4, rawTol: true }) : null;
  const ef = adj ? null : cutEdgeFaults(displaySoupOf(g));        // a piece Chop's commit made has no raw soup
  return { vol: vol, tris: n, open: adj ? adj.openEdges : ef.open, nm: adj ? adj.nmEdges : ef.nm,
           size: [m.size.x, m.size.y, m.size.z], posHash: Array.from(pos.array.slice(0, 600)).map(v => Math.round(v * 1e4)).join(',') };
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
  const waitStatus = re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('status').textContent),
    re.source, { timeout: 30000 });

  // The bar, on the plate, the cutter armed on it.
  async function fresh(soup, name) {
    // An empty plate each time: a bar left in front of this one would take the click meant for it.
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); clearPlateOnly(); });
    const id = await loadSTL(page, stl(name, soup));
    await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    return id;
  }
  // A real mouse click on the piece at a world point.
  async function clickAt(wp) {
    const xy = await page.evaluate(wp => {
      const v = new THREE.Vector3(wp[0], wp[1], wp[2]).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    }, wp);
    await page.mouse.move(xy[0], xy[1]);
    await page.mouse.down();
    await page.mouse.up();
  }
  const topPoint = (id, frac) => page.evaluate(([id, frac]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh);
    return [b.min.x + (b.max.x - b.min.x) * frac, b.max.y, (b.min.z + b.max.z) / 2];
  }, [id, frac]);
  const setDice = () => page.evaluate(() => {
    document.getElementById('btn-cut-blade-sized').click();
    cutBladeState().follow = false; cutBladeRefresh();        // Follow strand is on by default; these drive the plain knife
  });
  const setNotch = (w, d) => page.evaluate(([w, d]) => {
    document.getElementById('btn-cut-blade-notch').click();
    const b = cutBladeState(); b.nfollow = false; b.nturn = false;
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('cut-notch-width', w); set('cut-notch-depth', d);
  }, [w, d]);
  const cutAndWait = async re => { await page.click('#btn-cut'); await waitStatus(re); await page.waitForTimeout(300); };
  const DICE_DONE = /Dice cut|Cut not made/;

  console.log('card');
  let id = await fresh(bar(60, 20, 20), 'bar.stl');
  const v0 = await probe(id);
  check('the bar is 24000 mm^3, closed', near(v0.vol, 24000, 1) && v0.open === 0 && v0.nm === 0, JSON.stringify({ vol: v0.vol, open: v0.open, nm: v0.nm }));
  check('Chop is the default and no blade fields show',
    await page.evaluate(() => document.getElementById('btn-cut-blade-full').getAttribute('aria-pressed') === 'true' &&
      document.getElementById('cut-blade-fields').hidden === true && document.getElementById('cut-notch-fields').hidden === true));
  await setDice();
  check('Dice shows nothing to set (Width / Depth / Kerf are gone)', await page.evaluate(() =>
    !document.getElementById('cut-blade-width') && !document.getElementById('cut-blade-depth') && !document.getElementById('cut-blade-kerf')));

  console.log('Dice through the bar (real click)');
  await clickAt(await topPoint(id, 0.4));
  const at = await page.evaluate(() => state.cutBladeAt ? { n: state.cutBladeAt.normal && state.cutBladeAt.normal.toArray() } : null);
  check('the click anchored the blade on the top face', !!at && !!at.n && at.n[1] > 0.99, JSON.stringify(at));
  const ro = await page.evaluate(() => document.getElementById('cut-readout').textContent);
  check('the readout names it Dice, through the strand', /^DICE @ .* through the strand you clicked/.test(ro), ro);
  await cutAndWait(DICE_DONE);
  const st1 = await status(), d1 = await probeAll();
  check('status: a Dice cut, no kerf', /^Dice cut - through the strand, no kerf/.test(st1), st1);
  check('two pieces now', d1.n === 2, d1.n + ' pieces');
  check('they add back to the bar exactly: no kerf', near(d1.vol, 24000, 0.01), d1.vol.toFixed(4));
  check('both closed', d1.open === 0 && d1.nm === 0, 'open ' + d1.open + ', nm ' + d1.nm);

  console.log('Undo');
  await page.click('#btn-undo');
  const u1 = await probeAll();
  const back = await page.evaluate(() => state.models.length === 1 ? __probe(state.models[0].id) : null);
  check('one Undo gives the bar back, vertex for vertex', u1.n === 1 && back && near(back.vol, v0.vol, 1e-3) && back.tris === v0.tris && back.posHash === v0.posHash,
    JSON.stringify({ n: u1.n, vol: back && back.vol, tris: back && back.tris, was: v0.tris }));

  console.log('mitred, bevelled, on a turned piece');
  for (const [name, turn] of [['a mitre of 30', () => page.evaluate(() => setCutMiter(30))],
                              ['a bevel of 20', () => page.evaluate(() => setCutBevel(20))],
                              ['a piece turned on the plate', () => page.evaluate(() => { rotateSelected(1); const i = state.selectedIndex; if (i < 0) selectPlaced(state.placed.findIndex(p => p && p.sourceId === state.editId)); })]]) {
    id = await fresh(bar(60, 20, 20), 'bar-' + name.replace(/\W+/g, '') + '.stl');
    await setDice();
    if (name === 'a piece turned on the plate') await turn();
    await clickAt(await topPoint(id, 0.5));
    if (name !== 'a piece turned on the plate') await turn();
    await cutAndWait(DICE_DONE);
    const r = await probeAll(), st = await status();
    check('Dice with ' + name + ': two pieces, nothing lost, closed', /^Dice cut/.test(st) && r.n === 2 && near(r.vol, 24000, 0.05) && r.open === 0 && r.nm === 0,
      JSON.stringify({ n: r.n, vol: r.vol, open: r.open, nm: r.nm }) + ' ' + st);
  }

  console.log('Notch from the side');
  id = await fresh(bar(60, 20, 20), 'bar-notch.stl');
  const n0 = await probe(id);
  await setNotch(1, 3);
  const side = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh);
    return [b.min.x + (b.max.x - b.min.x) * 0.2, (b.min.y + b.max.y) / 2, b.max.z];
  }, id);
  await clickAt(side);
  const sat = await page.evaluate(() => state.cutBladeAt && state.cutBladeAt.normal ? state.cutBladeAt.normal.toArray() : null);
  check('the click on the side face captured that face\'s normal (+z)', !!sat && sat[2] > 0.99, JSON.stringify(sat));
  const sro = await page.evaluate(() => document.getElementById('cut-readout').textContent);
  check('the readout says the notch comes in from the side', /in from the side/.test(sro), sro);
  await cutAndWait(/Notch cut|Cut not made/);
  const n1 = await probe(id);
  check('it takes 1 x 3 x 20 (the face\'s height) and the bar stays one piece', near(n0.vol - n1.vol, 60, 0.1) && await page.evaluate(() => state.models.length) === 1,
    (n0.vol - n1.vol).toFixed(4) + ' of 60; ' + await status());
  check('and stays closed', n1.open === 0 && n1.nm === 0);
  await page.click('#btn-undo');

  console.log('refusals');
  const r0 = await probe(id);
  await page.evaluate(() => { state.cutBlade.nwidth = 0.05; });
  await page.click('#btn-cut');
  await page.waitForTimeout(400);
  const rs = await status();
  check('a notch width under the floor is refused in words', /Cut not made: the notch width is under/.test(rs), rs);
  check('and the piece is untouched', near((await probe(id)).vol, r0.vol, 1e-6));

  console.log('the full blade is untouched');
  id = await fresh(bar(60, 20, 20), 'bar5.stl');
  await page.evaluate(() => document.getElementById('btn-cut-blade-full').click());
  await clickAt(await topPoint(id, 0.5));
  await page.click('#btn-cut');
  // The plate still holds the earlier bars: follow THIS piece - gone, replaced by its two halves.
  await page.waitForFunction(id => !state.models.some(m => m.id === id), id, { timeout: 30000 });
  const vols = await page.evaluate(() => state.models.filter(m => /^bar5-[AB]/.test(m.name)).map(m => __probe(m.id).vol));
  check('it made exactly two halves', vols.length === 2, String(vols.length));
  check('the full blade still splits into two pieces that add back to 24000', near(vols[0] + vols[1], 24000, 1), JSON.stringify(vols));

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

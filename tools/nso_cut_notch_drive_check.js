/* nso_cut_notch_drive_check.js - the Cut card's SIZED blade, driven through the
   real app (index.html + every app-*.js) in real Chromium, against the real
   manifold kernel.
     node tools/nso_cut_notch_drive_check.js        exit 0 = every gate held

   What is pinned
   - A real mouse click on a piece's top face anchors the blade there and it
     goes in DOWN against that face.
   - The Cut button takes out exactly kerf x width x depth - read off the
     piece's own volume before and after, not off the status line - and leaves
     the piece one closed solid (0 open, 0 non-manifold edges).
   - It is one Undo step, and Undo gives the piece back vertex for vertex.
   - A blade that covers the section severs it, and says so; the kerf is what is lost.
   - A MITRED sized blade (the cut plane turned) removes the same volume: the
     blade rides the same cut frame the full blade does.
   - The FULL blade is untouched: it still splits one piece into two that add
     back to the original.
   - A kerf under the floor is refused and the piece is left alone.

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
  const sorted = g.index ? null : Float32Array.from({ length: pos.count * 3 }, (_, i) => pos.array[i]);
  return { vol: vol, tris: n, open: adj ? adj.openEdges : null, nm: adj ? adj.nmEdges : null,
           size: [m.size.x, m.size.y, m.size.z], posHash: Array.from(pos.array.slice(0, 600)).map(v => Math.round(v * 1e4)).join(',') };
};`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PROBE });
  const probe = id => page.evaluate(id => __probe(id), id);
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
  const setBlade = (w, d, k) => page.evaluate(([w, d, k]) => {
    document.getElementById('btn-cut-blade-sized').click();
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    set('cut-blade-width', w); set('cut-blade-depth', d); set('cut-blade-kerf', k);
  }, [w, d, k]);
  const cutNow = async () => {
    await page.evaluate(() => { window.__cutRes = null; });
    await page.click('#btn-cut');
  };

  console.log('card');
  let id = await fresh(bar(60, 20, 20), 'bar.stl');
  const v0 = await probe(id);
  check('the bar is 24000 mm^3, closed', near(v0.vol, 24000, 1) && v0.open === 0 && v0.nm === 0, JSON.stringify({ vol: v0.vol, open: v0.open, nm: v0.nm }));
  check('Full blade is the default and the size fields are hidden',
    await page.evaluate(() => document.getElementById('btn-cut-blade-full').getAttribute('aria-pressed') === 'true' &&
      document.getElementById('cut-blade-fields').hidden === true));
  await setBlade(10, 3, 1);
  check('Sized blade shows its three fields', await page.evaluate(() => !document.getElementById('cut-blade-fields').hidden));

  console.log('notch from the top face (real click)');
  const tp = await topPoint(id, 0.4);
  await clickAt(tp);
  const at = await page.evaluate(() => state.cutBladeAt ? { n: state.cutBladeAt.normal && state.cutBladeAt.normal.toArray(), l: state.cutBladeAt.local.toArray() } : null);
  check('the click anchored the blade on the top face', !!at && !!at.n && at.n[1] > 0.99, JSON.stringify(at));
  const sheet = await page.evaluate(() => {
    const b = state.cutHelper && state.cutHelper.children.find(c => c.userData.cutBlade);
    if (!b) return null;
    const bb = new THREE.Box3().setFromObject(b), s = bb.getSize(new THREE.Vector3());
    return s.toArray();
  });
  const dims = sheet && sheet.slice().sort((a, b) => a - b);
  check('the blade drawn is the box, not the section: 1 x 4 x 10 (kerf, depth + 1 clear, width)',
    !!dims && near(dims[0], 1, 0.05) && near(dims[1], 4, 0.05) && near(dims[2], 10, 0.05), JSON.stringify(dims));
  check('the readout names it', /SIZED BLADE/.test(await page.evaluate(() => document.getElementById('cut-readout').textContent)),
    await page.evaluate(() => document.getElementById('cut-readout').textContent));
  await cutNow();
  await waitStatus(/Notch cut|Cut not made/);
  const st1 = await status();
  const v1 = await probe(id);
  check('status reports a notch', /^Notch cut/.test(st1), st1);
  check('exactly kerf x width x depth came out (read off the piece)', near(v0.vol - v1.vol, 30, 0.05), (v0.vol - v1.vol).toFixed(4) + ' of 30');
  check('still one closed solid', v1.open === 0 && v1.nm === 0, 'open ' + v1.open + ', nm ' + v1.nm);
  check('the outline is unchanged (a notch, not a trim)', v1.size.every((s, i) => near(s, v0.size[i], 0.01)), JSON.stringify(v1.size));
  check('it is still one piece', await page.evaluate(() => state.models.length) === 1);
  check('the cutter is still live on it, blade back at its default', await page.evaluate(() => !!state.cutHelper && state.cutterOpen));

  console.log('Undo');
  await page.click('#btn-undo');
  const v2 = await probe(id);
  check('one Undo gives the piece back vertex for vertex', near(v2.vol, v0.vol, 1e-3) && v2.tris === v0.tris && v2.posHash === v0.posHash,
    'vol ' + v2.vol + ', tris ' + v2.tris + ' vs ' + v0.tris);
  check('Undo says what it undid', /Notch reverted/.test(await status()), await status());

  console.log('between things: a narrow blade leaves the rest of the path alone');
  // On a plain bar: a narrow blade takes only its own volume; a blade as wide as the piece takes the whole width.
  id = await fresh(bar(60, 20, 20), 'bar2.stl');
  const w0 = await probe(id);
  await setBlade(4, 2, 1);
  await clickAt(await topPoint(id, 0.5));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const w1 = await probe(id);
  check('a 4 wide blade takes 4 x 2 x 1 and nothing more', near(w0.vol - w1.vol, 8, 0.05), (w0.vol - w1.vol).toFixed(4) + ' of 8');
  await page.click('#btn-undo');
  await setBlade(20, 2, 1);
  await clickAt(await topPoint(id, 0.5));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const w2 = await probe(id);
  check('a blade as wide as the piece takes 20 x 2 x 1', near(w0.vol - w2.vol, 40, 0.05), (w0.vol - w2.vol).toFixed(4) + ' of 40');

  console.log('severing');
  await page.click('#btn-undo');
  await setBlade(30, 30, 2);
  await clickAt(await topPoint(id, 0.5));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const sv = await probe(id);
  const sst = await status();
  check('a blade over the whole section takes kerf x 20 x 20', near(w0.vol - sv.vol, 800, 0.1), (w0.vol - sv.vol).toFixed(3) + ' of 800');
  check('and says it severed the piece into 2 bodies', /2 bodies/.test(sst), sst);
  check('both bodies are closed', sv.open === 0 && sv.nm === 0, 'open ' + sv.open + ', nm ' + sv.nm);

  console.log('mitred sized blade');
  id = await fresh(bar(60, 20, 20), 'bar3.stl');
  const m0 = await probe(id);
  await setBlade(6, 3, 1);
  await clickAt(await topPoint(id, 0.5));
  await page.evaluate(() => setCutMiter(30));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const m1 = await probe(id);
  check('a blade at 30 degrees removes the same kerf x width x depth', near(m0.vol - m1.vol, 18, 0.1), (m0.vol - m1.vol).toFixed(4) + ' of 18; ' + await status());
  check('and the result is closed', m1.open === 0 && m1.nm === 0);

  console.log('bevelled sized blade');
  id = await fresh(bar(60, 20, 20), 'bar3b.stl');
  const b0 = await probe(id);
  await setBlade(6, 3, 1);
  await clickAt(await topPoint(id, 0.5));
  await page.evaluate(() => setCutBevel(20));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const b1 = await probe(id), bst = await status();
  // Leaned 20 degrees the blade meets the top face at a slant, but the slant averages out across the
  // kerf: it still takes exactly kerf x width x depth = 18 mm^3, and it must open to the outside - a
  // blade that ended up buried would take the whole 24 mm^3 box and leave a void ("2 bodies").
  const took = b0.vol - b1.vol;
  check('a blade leaned 20 degrees takes exactly 6 x 3 x 1', near(took, 18, 0.1), took.toFixed(3) + ' of 18; ' + bst);
  check('it opens to the outside: no void, one body', !/bod(y|ies)/.test(bst) && b1.open === 0 && b1.nm === 0, bst);

  console.log('a turned piece, and a click on its side');
  id = await fresh(bar(60, 20, 20), 'bar6.stl');
  const t0 = await probe(id);
  await page.evaluate(() => rotateSelected(1));          // a quarter turn on the plate
  await page.evaluate(() => { const i = state.selectedIndex; if (i < 0) selectPlaced(state.placed.findIndex(p => p && p.sourceId === state.editId)); });
  await setBlade(6, 3, 1);
  await clickAt(await topPoint(id, 0.5));
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const t1 = await probe(id);
  check('a piece turned on the plate takes the same 6 x 3 x 1', near(t0.vol - t1.vol, 18, 0.1), (t0.vol - t1.vol).toFixed(4) + ' of 18; ' + await status());
  check('and stays closed', t1.open === 0 && t1.nm === 0);
  await page.click('#btn-undo');
  // The +z side face of an unturned bar, clear of the blade (which stands at mid-length): the blade
  // must go in horizontally. Asserted on the captured face normal and the readout, not on volume
  // alone - a 10 x 3 x 1 notch is 30 mm^3 from the top as well.
  id = await fresh(bar(60, 20, 20), 'bar7.stl');
  const s0 = await probe(id);
  await setBlade(10, 3, 1);
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
  check('the readout says the blade comes in from the side', /in from the side/.test(sro), sro);
  await cutNow(); await waitStatus(/Notch cut|Cut not made/);
  const s1 = await probe(id);
  check('and it takes 10 x 3 x 1', near(s0.vol - s1.vol, 30, 0.1), (s0.vol - s1.vol).toFixed(4) + ' of 30; ' + await status());
  check('and stays closed', s1.open === 0 && s1.nm === 0);

  console.log('refusals');
  id = await fresh(bar(60, 20, 20), 'bar4.stl');
  const r0 = await probe(id);
  await setBlade(6, 3, 1);
  await clickAt(await topPoint(id, 0.5));
  await page.evaluate(() => { state.cutBlade.kerf = 0.05; });
  await cutNow();
  await page.waitForTimeout(400);
  const rs = await status();
  check('a kerf under the floor is refused in words', /Cut not made: the kerf is under/.test(rs), rs);
  check('and the piece is untouched', near((await probe(id)).vol, r0.vol, 1e-6));

  console.log('the full blade is untouched');
  id = await fresh(bar(60, 20, 20), 'bar5.stl');
  await page.evaluate(() => document.getElementById('btn-cut-blade-full').click());
  await clickAt(await topPoint(id, 0.5));
  await cutNow();
  // The plate still holds the earlier bars: follow THIS piece - gone, replaced by its two halves.
  await page.waitForFunction(id => !state.models.some(m => m.id === id), id, { timeout: 30000 });
  const vols = await page.evaluate(() => state.models.filter(m => /^bar5-[AB]/.test(m.name)).map(m => __probe(m.id).vol));
  check('it made exactly two halves', vols.length === 2, String(vols.length));
  check('the full blade still splits into two pieces that add back to 24000', near(vols[0] + vols[1], 24000, 1), JSON.stringify(vols));
  check('...with no kerf', !/Notch/.test(await status()), await status());

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });

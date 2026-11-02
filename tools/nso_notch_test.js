/* nso_notch_test.js - the Cut tool's sized blade, geometry core (nso_notch.js)
   against the real manifold kernel (vendor/manifold), no browser.
     node tools/nso_notch_test.js        exit 0 = every gate held

   Every volume is checked against a closed form, and every result goes through
   the kernel's own status, so "removed X" is measured, not assumed. */
const path = require('path');
const { pathToFileURL } = require('url');
const N = require(path.join(__dirname, '..', 'nso_notch.js'));
const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-3 : tol);

function bar(L, W, H) {          // box [0,L]x[0,W]x[0,H], outward-wound
  return N.boxSoup({ min: [0, 0, 0], max: [L, W, H] });
}
function soupToManifold(wasm, soup) {
  const n = soup.length / 9, tri = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) tri[i] = i;
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: soup.slice(), triVerts: tri });
  mesh.merge();
  return new wasm.Manifold(mesh);
}

function soupOfManifold(m) {
  const mesh = m.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3, o = new Float32Array(tv.length * 3);
  let w = 0;
  for (let t = 0; t < tv.length; t++) { const v = tv[t] * np; o[w++] = vp[v]; o[w++] = vp[v + 1]; o[w++] = vp[v + 2]; }
  return o;
}
(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'vendor/manifold/manifold.js')).href);
  const wasm = await (mod.default || mod)();
  wasm.setup();

  console.log('blade box');
  // A bar 40 long (x) x 20 (y) x 20 (z); plane normal = x at x=15; blade enters from the top (+y face, down).
  const e = N.entryFor(0, [0, 1, 0], [0, 1, 0]);
  check('click on the top face enters downward along y', e.dAxis === 1 && e.sign === -1 && e.wAxis === 2, JSON.stringify(e));
  const eFront = N.entryFor(0, [0, 0, 1], [0, 1, 0]);
  check('click on the +z face enters toward -z', eFront.dAxis === 2 && eFront.sign === -1 && eFront.wAxis === 1, JSON.stringify(eFront));
  const eEnd = N.entryFor(0, [1, 0, 0], [0, 1, 0]);
  check('a face lying in the plane (normal = plane normal) comes down from above',
    eEnd.dAxis === 1 && eEnd.sign === -1, JSON.stringify(eEnd));
  const eNeg = N.entryFor(0, [0, -1, 0], [0, 1, 0]);
  check('click on the underside enters upward', eNeg.dAxis === 1 && eNeg.sign === 1);

  const box = N.bladeBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 15, wCentre: 10, dStart: 20, width: 8, depth: 3, kerf: 1 });
  check('box spans kerf x depth(+overshoot) x width',
    near(box.max[0] - box.min[0], 1) && near(box.max[2] - box.min[2], 8) && near(box.max[1] - box.min[1], 3 + N.OVERSHOOT_MM) &&
    near(box.min[0], 14.5) && near(box.min[1], 17) && near(box.max[1], 21), JSON.stringify(box));

  console.log('subtract');
  const piece = soupToManifold(wasm, bar(40, 20, 20));
  const blade = soupToManifold(wasm, N.boxSoup(box));
  check('blade is a valid closed solid', blade.status() === 'NoError' && near(blade.volume(), 1 * 4 * 8, 1e-3), 'vol ' + blade.volume());
  const cut = piece.subtract(blade);
  const removed = piece.volume() - cut.volume();
  check('notch removes exactly kerf x width x depth (the overshoot is air)', near(removed, 1 * 8 * 3), removed.toFixed(4) + ' of 24');
  check('result is a valid manifold, one body', cut.status() === 'NoError' && cut.decompose().length === 1);
  check('a notch adds surface but keeps genus 0', cut.genus() === 0);

  console.log('through and severing');
  const wide = N.bladeBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 15, wCentre: 10, dStart: 20, width: 20, depth: 20, kerf: 2 });
  const sev = piece.subtract(soupToManifold(wasm, N.boxSoup(wide)));
  const bodies = sev.decompose();
  check('a blade covering the whole section severs it into two bodies', bodies.length === 2, bodies.length + ' bodies');
  check('...and the kerf is what is lost', near(piece.volume() - sev.volume(), 2 * 20 * 20), (piece.volume() - sev.volume()).toFixed(3) + ' of 800');

  console.log('blade between things');
  // two posts 6 apart on a base; a narrow blade between them leaves both alone
  const base = soupToManifold(wasm, N.boxSoup({ min: [0, 0, 0], max: [40, 4, 20] }));
  const post1 = soupToManifold(wasm, N.boxSoup({ min: [0, 4, 0], max: [40, 10, 6] }));
  const post2 = soupToManifold(wasm, N.boxSoup({ min: [0, 4, 14], max: [40, 10, 20] }));
  const two = wasm.Manifold.union([base, post1, post2]);
  const gap = N.bladeBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 20, wCentre: 10, dStart: 4, width: 6, depth: 2, kerf: 1 });
  const g = two.subtract(soupToManifold(wasm, N.boxSoup(gap)));
  check('a 6 mm blade in the 8 mm gap touches neither post', near(two.volume() - g.volume(), 1 * 6 * 2), (two.volume() - g.volume()).toFixed(3) + ' of 12');
  const full = N.bladeBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 20, wCentre: 10, dStart: 10, width: 20, depth: 6, kerf: 1 });
  const f = two.subtract(soupToManifold(wasm, N.boxSoup(full)));
  check('a full-width blade at the same place also cuts both posts', two.volume() - f.volume() > 1 * 6 * 2 + 1, (two.volume() - f.volume()).toFixed(3));

  console.log('transform');
  // 90 degrees about y: x -> -z, z -> x (column-major)
  const rot = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 0, 1];
  const moved = soupToManifold(wasm, N.transformSoup(N.boxSoup(box), rot));
  check('a rotated blade is still a valid solid of the same volume', moved.status() === 'NoError' && near(moved.volume(), 32));
  const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const mir = soupToManifold(wasm, N.transformSoup(N.boxSoup(box), mirror));
  check('a mirroring matrix keeps the blade outward-wound (positive volume)', mir.status() === 'NoError' && near(mir.volume(), 32), 'vol ' + mir.volume());

  console.log('strands: the separate blobs a plane crosses');
  // A comb: a spine along z holding three bars 3 wide, 6 apart (centres z = 3, 9, 15), all along x.
  // One body. A plane x = 20 crosses the three bars (three blobs); the spine is at x = 0..4, off the plane.
  const comb = wasm.Manifold.union([
    soupToManifold(wasm, N.boxSoup({ min: [0, 0, 0], max: [4, 4, 18] })),
    soupToManifold(wasm, N.boxSoup({ min: [0, 0, 1.5], max: [40, 4, 4.5] })),
    soupToManifold(wasm, N.boxSoup({ min: [0, 0, 7.5], max: [40, 4, 10.5] })),
    soupToManifold(wasm, N.boxSoup({ min: [0, 0, 13.5], max: [40, 4, 16.5] }))]);
  check('the comb is one body', comb.decompose().length === 1 && comb.status() === 'NoError');
  const cs = soupOfManifold(comb);
  const cl = N.sectionClusters(cs, 0, 20);
  check('a plane through the bars finds three strands', cl.length === 3, cl.length + ' blobs');
  check('each blob is that bar\'s section (3 wide in z, 4 tall in y)', cl.every(c => near(c.max[2] - c.min[2], 3) && near(c.max[1] - c.min[1], 4)),
    cl.map(c => (c.max[2] - c.min[2]).toFixed(2) + 'x' + (c.max[1] - c.min[1]).toFixed(2)).join(' '));
  check('a plane through the spine finds one blob (the spine joins the bars)', N.sectionClusters(cs, 0, 2).length === 1);
  check('a plane through nothing finds none', N.sectionClusters(cs, 0, 50).length === 0);
  const hit = N.nearestCluster(cl, [20, 4, 9.2]);      // on the top of the middle bar
  check('the click on the middle bar picks the middle bar', hit && near((cl[hit.index].min[2] + cl[hit.index].max[2]) / 2, 9), JSON.stringify(hit));
  const hit2 = N.nearestCluster(cl, [20, 4, 15.3]);
  check('...and one on the far bar picks the far bar', hit2 && near((cl[hit2.index].min[2] + cl[hit2.index].max[2]) / 2, 15));

  // Two separate bodies: a long bar, and a small block floating just over its middle. A click on the
  // long bar's top-middle is 50 mm from its own corners and under 3 mm from the block's: measured to
  // corners it picks the block; measured to the outline it picks the bar.
  const duo = wasm.Manifold.union([
    soupToManifold(wasm, N.boxSoup({ min: [0, 0, 0], max: [40, 4, 100] })),
    soupToManifold(wasm, N.boxSoup({ min: [0, 6, 48], max: [40, 8, 52] }))]);
  const dcl = N.sectionClusters(soupOfManifold(duo), 0, 20);
  const dh = N.nearestCluster(dcl, [20, 4, 50]);
  check('a click mid-way along a long face picks that face\'s strand, not a near neighbour\'s corner',
    dcl.length === 2 && dh && dh.dist < 1e-6 && near(dcl[dh.index].max[2] - dcl[dh.index].min[2], 100), JSON.stringify({ n: dcl.length, dh }));

  console.log('notch box: fitted to the strand, in from its edge');
  const mid = cl[hit.index];
  const nb = N.notchBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 20, depth: 1, kerf: 1.2 }, mid);
  check('as wide across as the strand plus the margins', near(nb.box.max[2] - nb.box.min[2], 3 + 2 * N.NOTCH_MARGIN_MM) && near((nb.box.min[2] + nb.box.max[2]) / 2, 9),
    JSON.stringify(nb.box));
  check('starts at the strand\'s edge (the top, y = 4), clear by the overshoot, 1 in', near(nb.box.max[1], 4 + N.OVERSHOOT_MM) && near(nb.box.min[1], 3), JSON.stringify(nb.box));
  const nickBlade = soupToManifold(wasm, N.boxSoup(nb.box));
  const nicked = comb.subtract(nickBlade);
  check('the nick takes 1.2 x 3 x 1 from the middle bar and nothing else', near(comb.volume() - nicked.volume(), 1.2 * 3 * 1, 1e-3), (comb.volume() - nicked.volume()).toFixed(4) + ' of 3.6');
  const wideBox = N.bladeBox({ axis: 0, dAxis: 1, wAxis: 2, sign: -1, plane: 20, wCentre: 9, dStart: 4, width: 30, depth: 1, kerf: 1.2 });
  const wideBlade = soupToManifold(wasm, N.boxSoup(wideBox));
  check('a plain 30-wide blade at the same place takes all three bars', near(comb.volume() - comb.subtract(wideBlade).volume(), 3 * 3.6, 1e-3));
  const parts = comb.intersect(wideBlade).decompose();
  check('and what it holds falls into three solids - one per strand', parts.length === 3, parts.length + ' solids');
  const flank = N.notchBox({ axis: 0, dAxis: 2, wAxis: 1, sign: -1, plane: 20, depth: 1, kerf: 1 }, mid);
  check('from the side: enters in from the strand\'s +z edge, the full height across', near(flank.box.max[2], 10.5 + N.OVERSHOOT_MM) && near(flank.box.min[2], 9.5) && near(flank.box.max[1] - flank.box.min[1], 4 + 2 * N.NOTCH_MARGIN_MM),
    JSON.stringify(flank.box));

  console.log('notch sizes');
  const ns = N.sizes({ mode: 'notch', nwidth: 2.5, ndepth: 0.7 });
  check('notch mode reads its own width (kerf) and depth', ns.kerf === 2.5 && ns.depth === 0.7, JSON.stringify(ns));
  check('notch width under the floor is refused in words', /notch width/.test(N.refusal({ mode: 'notch', nwidth: 0.05, ndepth: 1 })));
  check('notch depth under the floor is refused in words', /notch reaches/.test(N.refusal({ mode: 'notch', nwidth: 1, ndepth: 0.05 })));
  check('a sane notch is accepted', N.refusal({ mode: 'notch', nwidth: 1, ndepth: 1 }) === '');
  check('the notch report says nick and the strand count', /nick/.test(N.report({ notch: true, kerf: 1, depth: 1, removed: 3, shells: 1, strands: 5 })) &&
    /one strand of 5/.test(N.report({ notch: true, kerf: 1, depth: 1, removed: 3, shells: 1, strands: 5 })));

  console.log('refusals');
  check('kerf under the floor is refused', /kerf/.test(N.refusal({ width: 5, depth: 3, kerf: 0.05 })));
  check('width under the floor is refused', /wide/.test(N.refusal({ width: 0.05, depth: 3, kerf: 1 })));
  check('a sane blade is accepted', N.refusal({ width: 5, depth: 3, kerf: 1 }) === '');
  const s = N.sizes({ width: 'x', depth: -4, kerf: 1e9 });
  check('sizes() clamps junk to something buildable', s.width === N.DEFAULTS.width && s.depth === N.MIN_DEPTH_MM && s.kerf === 1000, JSON.stringify(s));
  check('report names the bodies when severed', /2 bodies/.test(N.report({ width: 5, depth: 3, kerf: 1, removed: 15, shells: 2 })));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

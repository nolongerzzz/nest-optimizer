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

#!/usr/bin/env node
/* nso_edges.js held to THREE.EdgesGeometry, array for array. No browser.
     node tools/nso_edges_test.js        exit 0 = every gate held
     npm run edges:test
   The selection outline of a big piece is made by nso_edges.js in a worker
   (three's own takes 5.4 s of the page's thread at 947,000 triangles); the
   outline a person sees must be the one three would have drawn. */
const THREE = require('three');
const E = require('../nso_edges.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
let seed = 777;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function sphere(nu, nv, r, noise) {
  const P = (i, j) => { const th = Math.PI * j / nv, ph = 2 * Math.PI * (i % nu) / nu; const k = noise ? 1 + noise * Math.sin(5 * th) * Math.cos(7 * ph) : 1;
    return [r * k * Math.sin(th) * Math.cos(ph), r * k * Math.sin(th) * Math.sin(ph), r * k * Math.cos(th)]; };
  const out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (j > 0) out.push(...a, ...b, ...c);
    if (j < nv - 1) out.push(...a, ...c, ...d);
  }
  return new Float32Array(out);
}
function boxes(n) {     // cubes on a lattice, some touching, some overlapping, with a few extra loose triangles
  const out = [];
  const cube = (x, y, z, s) => {
    const v = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].map(p => [x + p[0] * s, y + p[1] * s, z + p[2] * s]);
    [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].forEach(f => f.forEach(i => out.push(...v[i])));
  };
  for (let i = 0; i < n; i++) cube(Math.floor(rnd() * 4) * 5, Math.floor(rnd() * 4) * 5, Math.floor(rnd() * 3) * 5, 5 + (i % 3));
  for (let i = 0; i < 20; i++) out.push(rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20, rnd() * 20);
  out.push(1, 1, 1, 1, 1, 1, 2, 2, 2);                // a triangle of no area
  out.push(3, 3, 3, 3.00001, 3, 3, 3, 3.00001, 3);    // a triangle that welds to a point
  return new Float32Array(out);
}

const cases = [['sphere', sphere(70, 35, 40, 0)], ['noisy sphere', sphere(60, 30, 40, 0.2)], ['cubes, loose triangles, degenerates', boxes(40)]];
for (const [name, soup] of cases) {
  for (const angle of [1, 15, 40]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    const want = new THREE.EdgesGeometry(g, angle).attributes.position.array;
    const got = E.edgesOf(soup, angle);
    const same = want.length === got.length && want.every((v, i) => v === got[i]);
    check(name + ' at ' + angle + ' deg: the same ' + (want.length / 6) + ' segments, same order', same, same ? '' : want.length + ' vs ' + got.length);
  }
}
check('an empty position array is no segments', E.edgesOf(new Float32Array(0), 15).length === 0);
console.log('\n' + (fails ? 'FAILED: ' + fails : 'all held'));
process.exit(fails ? 1 : 0);

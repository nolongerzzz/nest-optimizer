#!/usr/bin/env node
/* The three bump fixtures for Crop's Wall (and for trying Lift on): a block, a sphere and a cone, each with one
   bump on its +x side, as closed binary STLs in fixtures/crop-wall/.
     node tools/nso_crop_wall_fixtures.js            writes them
   Built with the app's own kernel, so every one is a closed manifold; each bump is sunk into its body so the
   union has no seam on the surface. Required by tools/nso_crop_card_drive.js (blockWithBump) and
   tools/nso_crop_wall_shapes_test.js.

     block   40 x 20 x 10 mm, a 4 x 4 mm square bump 2 mm proud of the +x wall (flat top)
     sphere  R15, a dome bump (R3 sphere centred on the surface) 3 mm proud at +x
     cone    R15 base, 25 tall, a pin (Ø4 cylinder, square to the slope) 4 mm proud on the +x side, 8 mm up */
'use strict';

const fs = require('fs');
const path = require('path');
const { csgContext } = require('./nso_csg_node.js');
const { writeSTL } = require('./nso_stl_io.js');

const OUT = path.resolve(__dirname, '..', 'fixtures', 'crop-wall');

function boxSoup(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}

async function build() {
  const ctx = csgContext(), kern = ctx.NSO_CSG, wasm = await kern.load(), M = wasm.Manifold;
  const soupOf = m => kern.manifoldToSoup(m);
  const fromSoup = s => kern.soupToManifold(wasm, s);
  const out = {};

  // block: a square bump
  {
    const a = fromSoup(boxSoup([0, 0, 0], [40, 20, 10])), b = fromSoup(boxSoup([39, 8, 3], [42, 12, 7]));
    const u = a.add(b);
    out.block = soupOf(u);
  }
  // sphere: a dome bump
  {
    const s = M.sphere(15, 96).translate(0, 0, 15), d = M.sphere(3, 48).translate(15, 0, 15);
    out.sphere = soupOf(s.add(d));
  }
  // cone: a pin square to the slope
  {
    const c = M.cylinder(25, 15, 0, 96, false);                 // base z 0, apex z 25
    const nz = 15, nx = 25, nl = Math.hypot(nx, nz), n = [nx / nl, nz / nl];       // outward normal of the slope, in x-z
    const at = [15 * (1 - 8 / 25), 8];                                              // the slope's point 8 mm up, at +x
    const ang = Math.atan2(n[0], n[1]) * 180 / Math.PI;                             // z axis turned toward x
    const pin = M.cylinder(6, 2, 2, 48, true).rotate(0, ang, 0).translate(at[0] + n[0] * 1, 0, at[1] + n[1] * 1);
    out.cone = soupOf(c.add(pin));
  }
  return out;
}

module.exports = { build, boxSoup };

if (require.main === module) {
  build().then(fx => {
    fs.mkdirSync(OUT, { recursive: true });
    for (const k of Object.keys(fx)) {
      const f = path.join(OUT, k + '_bump.stl');
      writeSTL(f, fx[k]);
      console.log(f + '  ' + fx[k].length / 9 + ' triangles');
    }
  }).catch(e => { console.error(e); process.exit(1); });
}

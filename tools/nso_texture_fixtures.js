#!/usr/bin/env node
/* The cylinder fixtures the curved-skin (Texture) suite needs.

     node tools/nso_texture_fixtures.js            write them
     node tools/nso_texture_fixtures.js --check    fail if the committed bytes
                                                   are not what this writes

   Why generated and committed rather than one or the other: the suite needs a
   real file on disk so the app can load it through its own file input and so
   `tools/mesh_validate.py` has something to point at, and CI needs to know the
   committed bytes still match the generator. Same arrangement as
   tools/nso_skin_patch_samples.js --check.

   The geometry is the plainest cylinder there is, and deliberately so - one
   ring of side facets between two flat caps, every side vertex on the circle,
   every cap a triangle fan. That is exactly the shape nso_skin_band.js says it
   is scoped to, so the fixture is the scope written out rather than a lucky
   mesh. Z up, sitting on z = 0, millimetres, in the app's raw axes.

     cylinder_r10h30_s64.stl   r 10, h 30, 64 facets   the working fixture
     cylinder_r6h12_s96.stl    r 6,  h 12, 96 facets   a second size and
                                                       tessellation, so a gate
                                                       cannot be tuned to one
     prism_r10h30_s8.stl       r 10, h 30, 8 facets    NOT a cylinder: the
                                                       refusal fixture, an
                                                       8-sided prism whose
                                                       sides are flat
                                                       rectangles Skin wrap
                                                       already covers        */

'use strict';
const fs = require('fs');
const path = require('path');
const { writeSTL, readSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'fixtures');

/* One ring of side quads, two fan caps. Vertices are placed at exact float64
   angles and then rounded once by the Float32Array, so the file on disk and
   the soup in the browser are the same numbers. */
function cylinder(r, h, seg) {
  const out = [];
  const P = [];
  for (let i = 0; i < seg; i++) {
    const t = (i * 2 * Math.PI) / seg;
    P.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  const push = (...pts) => { for (const p of pts) out.push(p[0], p[1], p[2]); };
  for (let i = 0; i < seg; i++) {
    const a = P[i], b = P[(i + 1) % seg];
    /* side: outward normal */
    push([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h]);
    push([a[0], a[1], 0], [b[0], b[1], h], [a[0], a[1], h]);
    /* bottom cap: normal -Z */
    push([0, 0, 0], [b[0], b[1], 0], [a[0], a[1], 0]);
    /* top cap: normal +Z */
    push([0, 0, h], [a[0], a[1], h], [b[0], b[1], h]);
  }
  return new Float32Array(out);
}

const FIXTURES = [
  { file: 'cylinder_r10h30_s64.stl', soup: () => cylinder(10, 30, 64), header: 'NSO cylinder r10 h30 s64' },
  { file: 'cylinder_r6h12_s96.stl', soup: () => cylinder(6, 12, 96), header: 'NSO cylinder r6 h12 s96' },
  { file: 'prism_r10h30_s8.stl', soup: () => cylinder(10, 30, 8), header: 'NSO 8-sided prism r10 h30' }
];

function main() {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const f of FIXTURES) {
    const target = path.join(DIR, f.file);
    const soup = f.soup();
    if (check) {
      if (!fs.existsSync(target)) { console.log('  MISSING ' + f.file); bad++; continue; }
      const onDisk = readSTL(target);
      let same = onDisk.length === soup.length;
      if (same) for (let i = 0; i < soup.length; i++) if (onDisk[i] !== soup[i]) { same = false; break; }
      console.log('  ' + (same ? 'ok   ' : 'FAIL ') + f.file + ' - ' + (soup.length / 9) + ' tris');
      if (!same) bad++;
    } else {
      const n = writeSTL(target, soup, f.header);
      console.log('  wrote ' + f.file + ' - ' + n + ' tris');
    }
  }
  if (check) {
    console.log(bad ? '\n' + bad + ' fixture(s) differ from the generator' : '\nfixtures match the generator');
    process.exit(bad ? 1 : 0);
  }
}

if (require.main === module) main();
module.exports = { cylinder, FIXTURES };

/* ============================================================
   tools/nso_support_ref_pieces.js - the six REAL parts of Bambu's tree-slim
   support test (fixtures/supports/supp_ref.3mf, the owner's Studio project;
   20,572 triangles, each ~13.7 x 16.9 x 17 mm) and the pose (yaw, tip) the
   app puts any piece in.

   The first version of this file (supports-sheet-everywhere, #301) held
   stand-ins: heads fitted to the walls in the G-code, because only the slice
   had been attached. They are gone; this reads the project.

     part (project name)         key          surface under it
     --------------------------  -----------  -----------------------------------
     Support Base                base         flat
     Support Oblique             oblique      a tilted plane
     Support Circular            circular     a dome
     Support Sphere              sphere       a ball
     Support Negative Sphere     negsphere    a flat rim round a dome-shaped cavity
     Support Negative Sphere2    negsphere2   the same, deeper

   Each part is returned where the project puts it on the plate (Z up, mm, the
   plate at z = 0). The slice they were sliced in
   (fixtures/supports/tree_slimsupports.gcode.3mf, and the owner's second
   copy of it) is in the same frame: a part's walls in the G-code lie 0.24 mm
   inside its mesh at the same x, y - registration is the identity.

   API (require): NAMES, PROJECT_NAME, load() -> Promise { key: Float32Array },
   build(key) -> Promise<Float32Array>, pose(soup, yawDeg, tipDeg),
   centre(soup) -> [x, y]
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..', 'fixtures', 'supports', 'supp_ref.3mf');
const PROJECT_NAME = {
  base: 'Support Base.stl', oblique: 'Support Oblique.stl', circular: 'Support Circular.stl',
  sphere: 'Support Sphere.stl', negsphere: 'Support Negative Sphere.stl', negsphere2: 'Support Negative Sphere2.stl'
};
const NAMES = Object.keys(PROJECT_NAME);

let CACHE = null;
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
  }
  return v;
}
async function load() {
  if (CACHE) return CACHE;
  const R = require('../nso-3mf-read.js');
  const r = await R.parse3MF(new Uint8Array(fs.readFileSync(PROJECT)));
  const out = {};
  for (const key of NAMES) {
    const o = r.objects.find(x => x.name === PROJECT_NAME[key]);
    if (!o) throw new Error(PROJECT + ' has no object named ' + PROJECT_NAME[key]);
    out[key] = new Float32Array(o.positions);
    if (volume(out[key]) < 0) throw new Error(key + ': the mesh is inside out');
  }
  return (CACHE = out);
}
async function build(key) {
  const all = await load();
  if (!all[key]) throw new Error('no such piece: ' + key + ' (' + NAMES.join(', ') + ')');
  return all[key];
}
function centre(soup) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    if (soup[i] < lo[0]) lo[0] = soup[i]; if (soup[i] > hi[0]) hi[0] = soup[i];
    if (soup[i + 1] < lo[1]) lo[1] = soup[i + 1]; if (soup[i + 1] > hi[1]) hi[1] = soup[i + 1];
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
}

/* the piece as the app would place it after yaw (about the vertical) and tip (about the plate's x axis, after the yaw),
   turned about its own footprint's centre, dropped so its lowest point stands on the plate, and left on that centre in x and y */
function pose(soup, yawDeg, tipDeg) {
  const [cx, cy] = centre(soup);
  const cyaw = Math.cos(yawDeg * Math.PI / 180), syaw = Math.sin(yawDeg * Math.PI / 180);
  const ct = Math.cos(tipDeg * Math.PI / 180), st = Math.sin(tipDeg * Math.PI / 180);
  const o = new Float32Array(soup.length);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i] - cx, y = soup[i + 1] - cy, z = soup[i + 2];
    const x1 = cyaw * x - syaw * y, y1 = syaw * x + cyaw * y;
    const y2 = ct * y1 - st * z, z2 = st * y1 + ct * z;
    o[i] = x1; o[i + 1] = y2; o[i + 2] = z2;
    if (x1 < lo[0]) lo[0] = x1; if (y2 < lo[1]) lo[1] = y2; if (z2 < lo[2]) lo[2] = z2;
    if (x1 > hi[0]) hi[0] = x1; if (y2 > hi[1]) hi[1] = y2;
  }
  const mx = (lo[0] + hi[0]) / 2, my = (lo[1] + hi[1]) / 2;
  for (let i = 0; i < o.length; i += 3) { o[i] += cx - mx; o[i + 1] += cy - my; o[i + 2] -= lo[2]; }
  return o;
}

module.exports = { NAMES, PROJECT_NAME, PROJECT, load, build, pose, centre };

if (require.main === module) {
  (async () => {
    const all = await load();
    for (const n of NAMES) {
      const s = all[n];
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
      console.log(n.padEnd(11), (s.length / 9) + ' triangles, volume ' + volume(s).toFixed(1) + ' mm3, x ' + lo[0].toFixed(2) + '-' + hi[0].toFixed(2) + ' y ' + lo[1].toFixed(2) + '-' + hi[1].toFixed(2) + ' z ' + lo[2].toFixed(2) + '-' + hi[2].toFixed(2));
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

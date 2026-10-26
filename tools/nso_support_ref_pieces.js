/* ============================================================
   tools/nso_support_ref_pieces.js - the six surfaces of Bambu's tree-slim
   support set (fixtures/supports/tree_slimsupports.gcode.3mf), rebuilt from
   our side as plate pieces, and the pose (yaw, tip) the app puts any piece in.

   The reference 3MF holds the G-code only: its six parts are not in it. So
   each part is read back off the G-code (the outer walls and first solid
   layer over every cell of the head, tools/nso_support_everywhere_check.js
   section 1 prints the readings) and rebuilt here, the head's underside the
   measured surface and nothing else matched:

     piece         the head's underside (measured off the G-code)        Bambu's supports
     ------------  ----------------------------------------------------  -------------------
     base          flat, z 15.0                                          T 13.70-13.97, I 14.25-14.80
     oblique       a plane, 24 deg, falling toward -x -y                 T 7.69-11.60, I 8.25-12.20
     circular      a dome, 9.0 at its foot rising 0.09 r^2               T 7.69-8.80, I 8.25-9.40
     sphere        a ball, R 5.26, its foot at 9.8                       T 8.49-9.32, I 9.05-10.00
     negsphere     a flat rim at 10.6 round a dome-shaped cavity         T 9.30-9.57 + 13.00-13.53
                   (R 3.8, apex 14.4)                                    I 9.85-10.40 + 13.53-14.20
     negsphere2    the same rim, a deeper cavity (R 4.6, apex 15.2)      T 9.30-9.57 + 13.80-14.60
                                                                         I 9.85-10.40 + 14.33-15.20

   Every head is a 9.55 mm square turned 45 deg (13.5 mm across the points)
   or, for the ball, a disc (R 5.2 where the ball is cut), topped at z 17, held
   by a 4.5 x 4.6 mm stem standing on the plate at its +y point - the
   reference's own layout (the ball's stem starts at its equator).

   API (require): NAMES, pose(soup, yawDeg, tipDeg), build(name) -> Promise<Float32Array>
   (Z up, mm, the stem on z = 0).  `node tools/nso_support_ref_pieces.js --stl DIR`
   writes the six as STL.
   ============================================================ */
'use strict';

const path = require('path');

const TOP = 17;
const HALF_DIAG = 6.75;          /* the square head's half-diagonal */
const STEM = { x: 2.25, y0: -1.5, y1: 3.1 };   /* the stem: x +-2.25, y from the head's +y point -1.5 to +3.1 */

/* each piece's underside: z over (x, y) in the head's own frame */
const PROFILES = {
  base: { domain: 'diamond', z: () => 15.0 },
  oblique: { domain: 'diamond', z: (x, y) => 10.9 - 0.31 * x - 0.32 * y },
  circular: { domain: 'diamond', z: (x, y) => 9.0 + 0.09 * (x * x + y * y) },
  sphere: { domain: 'disc', radius: 5.2, stem: [-0.6, 4.0], z: (x, y) => 15.06 - Math.sqrt(Math.max(0, 5.26 * 5.26 - x * x - y * y)) },
  negsphere: { domain: 'diamond', z: (x, y) => { const r = Math.hypot(x, y); return r >= 3.8 ? 10.6 : 10.6 + Math.sqrt(3.8 * 3.8 - r * r); } },
  negsphere2: { domain: 'diamond', z: (x, y) => { const r = Math.hypot(x, y); return r >= 4.6 ? 10.6 : 10.6 + Math.sqrt(4.6 * 4.6 - r * r); } }
};
const NAMES = Object.keys(PROFILES);

/* a head as a closed mesh: flat top at TOP, the underside z(x, y) over its domain, vertical walls between */
function headSoup(prof) {
  const out = [];
  const tri = (a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };       /* a, b, c, d counter-clockwise seen from outside */
  if (prof.domain === 'diamond') {
    const N = 24, a = HALF_DIAG / Math.SQRT2, st = 2 * a / N, k = Math.SQRT1_2;
    const P = (i, j) => { const s = -a + i * st, t = -a + j * st, x = (s - t) * k, y = (s + t) * k; return [x, y]; };
    const B = (i, j) => { const q = P(i, j); return [q[0], q[1], prof.z(q[0], q[1])]; };
    const T = (i, j) => { const q = P(i, j); return [q[0], q[1], TOP]; };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      quad(B(i, j), B(i, j + 1), B(i + 1, j + 1), B(i + 1, j));       /* underside, normal down: (s, t) is counter-clockwise from above, so reverse */
      quad(T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j + 1));
    }
    for (let m = 0; m < N; m++) {
      quad(B(m, 0), B(m + 1, 0), T(m + 1, 0), T(m, 0));
      quad(B(N, m), B(N, m + 1), T(N, m + 1), T(N, m));
      quad(B(m + 1, N), B(m, N), T(m, N), T(m + 1, N));
      quad(B(0, m + 1), B(0, m), T(0, m), T(0, m + 1));
    }
    return { soup: out, reach: HALF_DIAG };
  }
  const K = 16, M = 48, R = prof.radius;
  const Bp = (r, m) => { const th = 2 * Math.PI * m / M, x = r * Math.cos(th), y = r * Math.sin(th); return [x, y, prof.z(x, y)]; };
  const Tp = (r, m) => { const th = 2 * Math.PI * m / M; return [r * Math.cos(th), r * Math.sin(th), TOP]; };
  for (let m = 0; m < M; m++) {
    const m1 = (m + 1) % M;
    tri(Bp(0, 0), Bp(R / K, m1), Bp(R / K, m));
    tri(Tp(0, 0), Tp(R / K, m), Tp(R / K, m1));
    for (let k = 1; k < K; k++) {
      const r0 = R * k / K, r1 = R * (k + 1) / K;
      quad(Bp(r0, m), Bp(r0, m1), Bp(r1, m1), Bp(r1, m));
      quad(Tp(r0, m), Tp(r1, m), Tp(r1, m1), Tp(r0, m1));
    }
    quad(Bp(R, m), Bp(R, m1), Tp(R, m1), Tp(R, m));
  }
  return { soup: out, reach: R };
}

function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
  }
  return v;
}
function flip(s) {
  const o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 9) {
    for (let k = 0; k < 3; k++) { o[i + k] = s[i + k]; o[i + 3 + k] = s[i + 6 + k]; o[i + 6 + k] = s[i + 3 + k]; }
  }
  return o;
}
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return new Float32Array(out);
}

/* the piece as the app would place it after yaw (about the vertical) and tip (about the plate's x axis, after the yaw),
   dropped so its lowest point stands on the plate and centred on the plate's origin in x and y */
function pose(soup, yawDeg, tipDeg) {
  const cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180);
  const ct = Math.cos(tipDeg * Math.PI / 180), st = Math.sin(tipDeg * Math.PI / 180);
  const o = new Float32Array(soup.length);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    const x1 = cy * x - sy * y, y1 = sy * x + cy * y;
    const y2 = ct * y1 - st * z, z2 = st * y1 + ct * z;
    o[i] = x1; o[i + 1] = y2; o[i + 2] = z2;
    if (x1 < lo[0]) lo[0] = x1; if (y2 < lo[1]) lo[1] = y2; if (z2 < lo[2]) lo[2] = z2;
    if (x1 > hi[0]) hi[0] = x1; if (y2 > hi[1]) hi[1] = y2;
  }
  const cx = (lo[0] + hi[0]) / 2, cyy = (lo[1] + hi[1]) / 2;
  for (let i = 0; i < o.length; i += 3) { o[i] -= cx; o[i + 1] -= cyy; o[i + 2] -= lo[2]; }
  return o;
}

let CSG = null;
async function build(name) {
  const prof = PROFILES[name];
  if (!prof) throw new Error('no such piece: ' + name + ' (' + NAMES.join(', ') + ')');
  if (!CSG) CSG = require('./nso_csg_node.js').csgContext();
  const h = headSoup(prof);
  let head = new Float32Array(h.soup);
  if (volume(head) < 0) head = flip(head);
  const so = prof.stem || [STEM.y0, STEM.y1];
  const stem = box([-STEM.x, h.reach + so[0], 0], [STEM.x, h.reach + so[1], TOP]);
  const u = await CSG.NSO_unionSoups(head, stem);
  if (!u.ok) throw new Error('the stem would not join the head: ' + u.reason);
  return new Float32Array(u.soup);
}

module.exports = { NAMES, PROFILES, pose, build, TOP };

if (require.main === module) {
  const fs = require('fs');
  const { writeSTL } = require('./nso_stl_io.js');
  const di = process.argv.indexOf('--stl');
  (async () => {
    for (const n of NAMES) {
      const s = await build(n);
      console.log(n.padEnd(11), (s.length / 9) + ' triangles, volume ' + volume(s).toFixed(1) + ' mm3');
      if (di > 0) { fs.mkdirSync(process.argv[di + 1], { recursive: true }); writeSTL(path.join(process.argv[di + 1], 'ref_' + n + '.stl'), s, 'NSO tree-slim reference ' + n); }
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

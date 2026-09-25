#!/usr/bin/env node
// How a real Bambu tree support is SHAPED - taper and forks - measured off the
// toolpath of fixtures/3mf/tabletop.gcode.3mf, before any more tree geometry
// is built on assumptions about it.
//
//   node tools/nso_support_tree_shape_check.js     exit 0 = every finding held
//
// tools/nso_support_tree_reference_check.js reads the same file at the level
// of ISLANDS (moves within 1.5 line widths of each other) and takes the trunk
// / branch phase transition and the two constants out of it. This check goes
// one level finer, to the level the slicer actually prints: the EXTRUSION
// PATH, a run of moves consecutive in the file and continuous end to start,
// broken by a travel. Island level is too coarse for forks - measured, 351 of
// the 407 island "forks" were already two separate paths on the layer below,
// merely closer than the 0.91 mm clustering radius.
//
// Every path is rasterised at 0.04 mm with each move drawn at its own width,
// and flood-filled from outside, so its ENVELOPE is the printed outline with
// the bore counted inside it. From that: equivalent diameter, bore, wall
// thickness along 32 rays, convexity (area / convex hull), roundness, and the
// second-moment axis ratio and orientation.
//
// THE FINDINGS, each re-derived and asserted below:
//
//   0. The file is Bambu's ORGANIC tree: support_style tree_organic, branch
//      diameter 2 mm, branch diameter angle 5 deg, 0.6 mm nozzle, 0.62 mm
//      support lines. The only real tree reference in the repo -
//      supportwithinsupport.gcode.3mf has no Support feature at all.
//   1. TAPER. One law for trunk and branch alike: equivalent diameter =
//      ~2 mm + 2 tan(5 deg) = 0.175 mm per mm below the interface, linear,
//      r2 ~0.99. There is no separate trunk profile. Below z ~1.8 a separate
//      BASE FLARE adds up to +1.5 mm (6.58 mm at z 0.6, every trunk), on top
//      of a solid first-layer pad.
//   2. WALLS. Every slice 2.2 mm and wider is a one-line tube: wall = one
//      support line, with a bore. Only the ~2 mm tips close up.
//   3. SLICES OF SLANTED TUBES. A leaning branch's slice is an ellipse
//      stretched by 1/cos(lean) along its own direction of travel - a round
//      tube cut by a horizontal plane. The branch is a swept 3D solid.
//   4. FORKS. Contours on one layer NEVER overlap: where branches touch, the
//      layer prints ONE contour. Going up, one contour splits into two
//      (hundreds of times); two never join into one (once). Before a split
//      the single contour is two-lobed for several layers, its lobes circular
//      arcs, its waist wider than two circles' intersection - the union of
//      two slanted tubes' slices. So the fork is a UNION of swept tubes,
//      sliced; not one cross-section deforming, and not a separate
//      transition piece.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const f2 = v => v.toFixed(2), f3 = v => v.toFixed(3);
const RES = 0.04;

/* ---- geometry helpers ---------------------------------------------------- */

function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const polyArea = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], r = P[(i + 1) % P.length]; a += p[0] * r[1] - r[0] * p[1]; } return Math.abs(a / 2); };
function fitLine(X, Y) {
  const n = X.length, mx = X.reduce((a, b) => a + b) / n, my = Y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx; let ss = 0, st = 0;
  for (let i = 0; i < n; i++) { ss += (Y[i] - a - b * X[i]) ** 2; st += (Y[i] - my) ** 2; }
  return { a, b, r2: 1 - ss / st, rms: Math.sqrt(ss / n) };
}
function circleFit(pts) {             /* Kasa algebraic fit */
  let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) { const u = p[0] - mx, v = p[1] - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const e = 0.5 * (suuu + suvv), f = 0.5 * (svvv + svuu), det = suu * svv - suv * suv;
  const uc = (e * svv - suv * f) / det, vc = (suu * f - suv * e) / det;
  return { x: uc + mx, y: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length) };
}

/* A path: moves consecutive in file order, continuous to 0.01 mm. Bambu's
   arcs end within ~1.4e-3 mm of the next move's start after rounding, so a
   1e-3 tolerance splits real loops - measured. */
function splitPaths(ms) {
  ms = ms.slice().sort((a, b) => a.index - b.index);
  const out = []; let cur = null, last = null;
  for (const m of ms) {
    if (last && m.index === last.index + 1 && Math.hypot(m.x0 - last.x1, m.y0 - last.y1) < 0.01) cur.push(m);
    else { cur = [m]; out.push(cur); }
    last = m;
  }
  return out;
}

function measure(ms) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of ms) { x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1); }
  const pad = 1; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const nx = Math.ceil((x1 - x0) / RES) + 1, ny = Math.ceil((y1 - y0) / RES) + 1;
  const mat = new Uint8Array(nx * ny);
  for (const m of ms) {
    const r = m.width / 2, dx = m.x1 - m.x0, dy = m.y1 - m.y0, L2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor((Math.min(m.x0, m.x1) - r - x0) / RES)), i1 = Math.min(nx - 1, Math.ceil((Math.max(m.x0, m.x1) + r - x0) / RES));
    const j0 = Math.max(0, Math.floor((Math.min(m.y0, m.y1) - r - y0) / RES)), j1 = Math.min(ny - 1, Math.ceil((Math.max(m.y0, m.y1) + r - y0) / RES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = x0 + i * RES, py = y0 + j * RES;
      let t = L2 > 0 ? ((px - m.x0) * dx + (py - m.y0) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(px - m.x0 - t * dx, py - m.y0 - t * dy) <= r) mat[j * nx + i] = 1;
    }
  }
  const out = new Uint8Array(nx * ny), st = [0]; out[0] = 1;
  while (st.length) {
    const k = st.pop(), i = k % nx, j = (k / nx) | 0;
    if (i > 0 && !out[k - 1] && !mat[k - 1]) { out[k - 1] = 1; st.push(k - 1); }
    if (i < nx - 1 && !out[k + 1] && !mat[k + 1]) { out[k + 1] = 1; st.push(k + 1); }
    if (j > 0 && !out[k - nx] && !mat[k - nx]) { out[k - nx] = 1; st.push(k - nx); }
    if (j < ny - 1 && !out[k + nx] && !mat[k + nx]) { out[k + nx] = 1; st.push(k + nx); }
  }
  const env = new Uint8Array(nx * ny);
  let envA = 0, bore = 0, sx = 0, sy = 0;
  for (let k = 0; k < nx * ny; k++) if (!out[k]) { env[k] = 1; envA++; sx += k % nx; sy += (k / nx) | 0; if (!mat[k]) bore++; }
  const cx = sx / envA, cy = sy / envA;
  /* bore components: 4-connected runs of envelope that is not material */
  let bores = 0; const seenB = new Uint8Array(nx * ny);
  for (let k0 = 0; k0 < nx * ny; k0++) {
    if (!env[k0] || mat[k0] || seenB[k0]) continue;
    let size = 0; const stk = [k0]; seenB[k0] = 1;
    while (stk.length) { const k = stk.pop(); size++;
      for (const n of [k - 1, k + 1, k - nx, k + nx]) if (n >= 0 && n < nx * ny && env[n] && !mat[n] && !seenB[n]) { seenB[n] = 1; stk.push(n); } }
    if (size * RES * RES > 0.03) bores++;         /* ignore seam specks */
  }
  let sxx = 0, syy = 0, sxy = 0, rmin = Infinity, rmax = 0; const B = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i; if (!env[k]) continue;
    const u = i - cx, v = j - cy; sxx += u * u; syy += v * v; sxy += u * v;
    if (!env[k - 1] || !env[k + 1] || !env[k - nx] || !env[k + nx]) {
      const r = Math.hypot(u, v) * RES; rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); B.push([i * RES, j * RES]);
    }
  }
  const tr = sxx + syy, dt = sxx * syy - sxy * sxy, dsc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
  const wt = [];
  for (let a = 0; a < 32; a++) {
    const th = a * Math.PI / 16; let s, i, j;
    for (s = Math.max(nx, ny); s > 0; s -= 0.25) { i = Math.round(cx + Math.cos(th) * s); j = Math.round(cy + Math.sin(th) * s); if (i >= 0 && j >= 0 && i < nx && j < ny && mat[j * nx + i]) break; }
    let run = 0; for (; s > 0; s -= 0.25) { i = Math.round(cx + Math.cos(th) * s); j = Math.round(cy + Math.sin(th) * s); if (!mat[j * nx + i]) break; run += 0.25; }
    wt.push(run * RES);
  }
  return {
    x0, y0, nx, ny, env, B, bores,
    c: [x0 + cx * RES, y0 + cy * RES],
    bbox: [x0, y0, x1, y1],
    eqD: 2 * Math.sqrt(envA * RES * RES / Math.PI),
    boreD: 2 * Math.sqrt(bore * RES * RES / Math.PI),
    wallT: q(wt, 0.5),
    solidity: envA * RES * RES / polyArea(hull(B)),
    roundness: rmin / rmax,
    axisRatio: Math.sqrt((tr / 2 + dsc) / Math.max(1e-9, tr / 2 - dsc)),
    axisAng: 0.5 * Math.atan2(2 * sxy, sxx - syy)
  };
}
const inEnv = (P, x, y) => { const i = Math.round((x - P.x0) / RES), j = Math.round((y - P.y0) / RES);
  return i >= 0 && j >= 0 && i < P.nx && j < P.ny && P.env[j * P.nx + i] === 1; };
const boxesMeet = (A, B) => !(A.bbox[2] < B.bbox[0] || B.bbox[2] < A.bbox[0] || A.bbox[3] < B.bbox[1] || B.bbox[3] < A.bbox[1]);
function overlapArea(A, B) {
  const x0 = Math.max(A.bbox[0], B.bbox[0]), x1 = Math.min(A.bbox[2], B.bbox[2]);
  const y0 = Math.max(A.bbox[1], B.bbox[1]), y1 = Math.min(A.bbox[3], B.bbox[3]);
  let n = 0; for (let y = y0; y <= y1; y += RES) for (let x = x0; x <= x1; x += RES) if (inEnv(A, x, y) && inEnv(B, x, y)) n++;
  return n * RES * RES;
}

(async () => {
  const file = path.join(ROOT, 'fixtures/3mf/tabletop.gcode.3mf');
  const bytes = new Uint8Array(fs.readFileSync(file));

  console.log('\n=== 0. THE REFERENCE, AND WHAT IT WAS TOLD TO BUILD ===');
  const slice = await G.readSlicedGcode3MF(bytes);
  const text = gcodeText(file);
  const cfg = k => { const m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(text); return m ? m[1].trim() : null; };
  const settings = {
    support_style: cfg('support_style'), support_type: cfg('support_type'),
    tree_support_branch_diameter: +cfg('tree_support_branch_diameter'),
    tree_support_branch_diameter_angle: +cfg('tree_support_branch_diameter_angle'),
    tree_support_wall_count: +cfg('tree_support_wall_count'),
    nozzle_diameter: +cfg('nozzle_diameter'), support_line_width: +cfg('support_line_width'),
    layer_height: +cfg('layer_height')
  };
  check('the reference is Bambu\'s ORGANIC tree support, and its shape settings are on record',
    settings.support_style === 'tree_organic' && settings.tree_support_branch_diameter === 2 &&
    settings.tree_support_branch_diameter_angle === 5,
    JSON.stringify(settings));
  const perMm = 2 * Math.tan(settings.tree_support_branch_diameter_angle * Math.PI / 180);

  const sup = slice.parsed.moves.filter(m => m.length > 0 && m.e > 0 && m.feature === 'Support');
  const lineW = q(sup.map(m => m.width), 0.5);
  const byZ = new Map();
  for (const m of sup) { const k = m.z.toFixed(3); if (!byZ.has(k)) byZ.set(k, []); byZ.get(k).push(m); }
  const zs = [...byZ.keys()].map(Number).sort((a, b) => a - b);
  const L = zs.map(z => ({ z, P: splitPaths(byZ.get(z.toFixed(3))).map(measure) }));
  const ifaceZ = Math.min(...slice.parsed.moves.filter(m => m.feature === 'Support interface' && m.e > 0).map(m => m.z));
  console.log(`  ${sup.length} Support moves, ${L.length} layers, ${L.reduce((a, l) => a + l.P.length, 0)} extrusion paths; ` +
    `line width ${f3(lineW)} mm; interface at z ${ifaceZ}`);

  /* path lineage: a path's parents are the paths below whose outline it overlaps */
  for (let k = 0; k < L.length; k++) for (const P of L[k].P) { P.parents = []; P.kids = []; }
  for (let k = 1; k < L.length; k++) L[k].P.forEach((U, ui) => {
    const pts = []; for (let j = 0; j < U.ny; j += 3) for (let i = 0; i < U.nx; i += 3) if (U.env[j * U.nx + i]) pts.push([U.x0 + i * RES, U.y0 + j * RES]);
    L[k - 1].P.forEach((D, di) => {
      if (!boxesMeet(U, D)) return;
      let h = 0; for (const [x, y] of pts) if (inEnv(D, x, y)) h++;
      if (h / pts.length > 0.02) { U.parents.push(di); D.kids.push(ui); }
    });
  });

  /* =====================================================================
     1. TAPER
     ===================================================================== */
  console.log('\n=== 1. TAPER: diameter against height, trunk and branch ===');
  const trunkLayers = L.filter(l => l.z > 0.4 && l.z <= 4.5);
  check('the trunk phase is 36 contours per layer, one extrusion path per trunk',
    trunkLayers.every(l => l.P.length === 36), trunkLayers.map(l => l.P.length).join(' '));

  const lone = [];
  for (let k = 1; k < L.length; k++) for (const P of L[k].P) {
    if (P.solidity > 0.97 && P.roundness > 0.85 && L[k].z >= 2.4) lone.push({ z: L[k].z, d: P.eqD, depth: ifaceZ - L[k].z });
  }
  const law = fitLine(lone.map(r => r.depth), lone.map(r => r.d));
  console.log(`  ${lone.length} lone, round, convex slices above z 2.4: eqD = ${f3(law.a)} + ${f3(law.b)} x (z_interface - z)` +
    `, r2 ${f3(law.r2)}, rms ${f3(law.rms)} mm`);
  console.log('  depth below interface  n     eqD p10   med   p90   law');
  for (let d = 0; d < 18; d += 2) {
    const g = lone.filter(r => r.depth >= d && r.depth < d + 2); if (g.length < 5) continue;
    console.log(`  ${String(d).padStart(2)}-${String(d + 2).padEnd(19)} ${String(g.length).padStart(4)}   ${f2(q(g.map(r => r.d), .1))}  ${f2(q(g.map(r => r.d), .5))}  ${f2(q(g.map(r => r.d), .9))}   ${f2(law.a + law.b * (d + 1))}`);
  }
  check('ONE linear law covers trunk and branch: diameter grows 2 tan(5 deg) per mm below the tips',
    law.r2 > 0.98 && Math.abs(law.b - perMm) / perMm < 0.05,
    `slope ${f3(law.b)} mm/mm vs 2 tan(${settings.tree_support_branch_diameter_angle}) = ${f3(perMm)}, r2 ${f3(law.r2)}`);
  check('...starting from the branch-diameter setting at the tips',
    Math.abs(law.a - settings.tree_support_branch_diameter) < 0.1,
    `${f3(law.a)} mm at the interface vs ${settings.tree_support_branch_diameter} mm`);

  /* the base: every trunk's own lineage, before it merges or splits */
  const trunks = L[1].P.map((P, i) => { const out = [{ z: L[1].z, d: P.eqD, bore: P.boreD }]; let k = 1, cur = P;
    while (k + 1 < L.length && cur.kids.length === 1 && L[k + 1].P[cur.kids[0]].parents.length === 1) {
      cur = L[k + 1].P[cur.kids[0]]; k++; if (!(cur.roundness > 0.85)) break; out.push({ z: L[k].z, d: cur.eqD, bore: cur.boreD }); }
    return out; });
  const at = z => trunks.map(t => t.find(p => Math.abs(p.z - z) < 1e-6)).filter(Boolean);
  const flare = [0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4].map(z => { const g = at(z); const d = q(g.map(p => p.d), 0.1);
    return { z, n: g.length, d, excess: d - (law.a + law.b * (ifaceZ - z)) }; });
  console.log('  base flare (p10 over un-merged trunks):  ' + flare.map(r => `z ${r.z}: ${f2(r.d)} (+${f2(r.excess)})`).join('  '));
  const z06 = at(0.6).map(p => p.d);
  check('every trunk stands on the same flared foot, and the flare is gone by z ~1.8',
    z06.length === 36 && Math.max(...z06) - Math.min(...z06) < 0.05 &&
    flare[0].excess > 1.2 && flare.filter(r => r.z >= 1.8).every(r => Math.abs(r.excess) < 0.15),
    `36 trunks ${f2(Math.min(...z06))}..${f2(Math.max(...z06))} mm at z 0.6, +${f2(flare[0].excess)} over the law; ` +
    `+${f2(flare[4].excess)} at z 1.8`);
  const pad = L[0].P;
  console.log(`  first layer (z ${L[0].z}): ${pad.length} paths, eqD med ${f2(q(pad.map(p => p.eqD), .5))} mm, ` +
    `bore med ${f2(q(pad.map(p => p.boreD), .5))} mm - a solid pad under the flare`);

  /* =====================================================================
     2. WALLS
     ===================================================================== */
  console.log('\n=== 2. WALLS: one line, around a bore ===');
  const slices = []; for (let k = 1; k < L.length; k++) for (const P of L[k].P) if (P.solidity > 0.97 && P.roundness > 0.85 && L[k].z >= 2.4) slices.push(P);
  console.log('  eqD band      n   wall med   bore med   bore/eqD   with a bore');
  for (let a = 1.8; a < 5; a += 0.4) {
    const g = slices.filter(p => p.eqD >= a && p.eqD < a + 0.4); if (g.length < 5) continue;
    console.log(`  ${f2(a)}-${f2(a + 0.4)}  ${String(g.length).padStart(5)}    ${f2(q(g.map(p => p.wallT), .5))}      ${f2(q(g.map(p => p.boreD), .5))}      ${f2(q(g.map(p => p.boreD / p.eqD), .5))}      ${(100 * g.filter(p => p.boreD > 0.2).length / g.length).toFixed(0)}%`);
  }
  const tubes = slices.filter(p => p.eqD >= 2.2);
  check('every slice 2.2 mm and wider is a tube with ONE support line of wall',
    tubes.every(p => p.boreD > 0.2) && Math.abs(q(tubes.map(p => p.wallT), .5) - lineW) < 0.05,
    `${tubes.length} slices, wall med ${f3(q(tubes.map(p => p.wallT), .5))} mm vs line ${f3(lineW)} mm, all with a bore`);

  /* =====================================================================
     3. SLICES OF SLANTED TUBES
     ===================================================================== */
  console.log('\n=== 3. A leaning branch is a slanted round tube, sliced ===');
  const lean = [];
  for (let k = 1; k < L.length - 1; k++) for (const P of L[k].P) {
    if (P.parents.length !== 1 || P.kids.length !== 1 || P.eqD > 3.2 || !(P.solidity > 0.97)) continue;
    const D = L[k - 1].P[P.parents[0]], U = L[k + 1].P[P.kids[0]];
    if (D.kids.length !== 1 || U.parents.length !== 1) continue;
    const dz = L[k + 1].z - L[k - 1].z, vx = (U.c[0] - D.c[0]) / dz, vy = (U.c[1] - D.c[1]) / dz;
    const t = Math.atan(Math.hypot(vx, vy));
    let da = Math.abs(((P.axisAng - Math.atan2(vy, vx)) % Math.PI + Math.PI) % Math.PI); if (da > Math.PI / 2) da = Math.PI - da;
    lean.push({ deg: t * 180 / Math.PI, ratio: P.axisRatio, pred: 1 / Math.cos(t), off: da * 180 / Math.PI });
  }
  const steep = lean.filter(r => r.deg >= 20);
  for (const [a, b] of [[20, 30], [30, 45]]) {
    const g = lean.filter(r => r.deg >= a && r.deg < b); if (!g.length) continue;
    console.log(`  lean ${a}-${b} deg: n ${g.length}, axis ratio med ${f3(q(g.map(r => r.ratio), .5))} vs 1/cos(lean) ${f3(q(g.map(r => r.pred), .5))}, ` +
      `long axis ${f2(q(g.map(r => r.off), .5))} deg off the direction of travel`);
  }
  check('slices of branches leaning 20 deg+ stretch by 1/cos(lean), ALONG their direction of travel',
    steep.length > 100 && Math.abs(q(steep.map(r => r.ratio / r.pred), .5) - 1) < 0.05 && q(steep.map(r => r.off), .5) < 10,
    `${steep.length} slices; measured / predicted med ${f3(q(steep.map(r => r.ratio / r.pred), .5))}, ` +
    `axis ${f2(q(steep.map(r => r.off), .5))} deg off travel`);

  /* =====================================================================
     4. FORKS
     ===================================================================== */
  console.log('\n=== 4. FORKS: how a branch leaves ===');
  let near = 0, overlapping = 0;
  for (const l of L.slice(1)) for (let a = 0; a < l.P.length; a++) for (let b = a + 1; b < l.P.length; b++) {
    if (!boxesMeet(l.P[a], l.P[b])) continue;
    near++; if (overlapArea(l.P[a], l.P[b]) > 0.05) overlapping++;
  }
  check('contours on one layer NEVER overlap - where branches touch, the layer prints ONE contour',
    near > 1000 && overlapping === 0, `${overlapping} overlapping of ${near} neighbouring pairs`);
  const splits = [], joins = [];
  for (let k = 1; k < L.length - 1; k++) L[k].P.forEach(D => { if (D.kids.length >= 2) splits.push({ k, D }); });
  for (let k = 2; k < L.length; k++) L[k].P.forEach(U => { if (U.parents.length >= 2) joins.push(U); });
  check('going up, one contour splits into two; two contours essentially never join',
    splits.length > 300 && joins.length <= 5, `${splits.length} splits, ${joins.length} joins`);

  /* the contour before each two-way split: lobes, waist, and how long it was two-lobed */
  const lobes = [], lobedFor = [];
  const seen = new Set();
  for (const s of splits.filter(s => s.D.kids.length === 2)) {
    let k = s.k, cur = s.D, n = 0;
    while (k >= 1 && cur.roundness < 0.8 && !seen.has(cur)) {
      seen.add(cur);
      const lf = lobeFit(cur); if (lf) lobes.push(lf);
      n++;
      if (cur.parents.length !== 1) break;
      const P = L[k - 1].P[cur.parents[0]]; if (P.kids.length !== 1) break;
      cur = P; k--;
    }
    lobedFor.push(n);
  }
  const good = lobes.filter(r => r.chord !== null);
  /* The bore of a merged contour: ONE bore, or one per lobe? Counted as
     connected components of (envelope minus material) - a merged bore is one. */
  const twoLobed = [...seen];
  const boreParts = twoLobed.map(P => P.bores);
  const oneBore = boreParts.filter(n => n === 1).length, twoBores = boreParts.filter(n => n >= 2).length;
  console.log(`  ${lobedFor.length} two-way splits; the one contour before each was two-lobed for a median ${q(lobedFor, .5)} ` +
    `layers (${f2(q(lobedFor, .5) * settings.layer_height)} mm), p90 ${q(lobedFor, .9)}`);
  console.log(`  ${good.length} two-lobed contours: lobes fit two circles to rms ${f3(q(good.map(r => r.rms), .5))} mm; ` +
    `lobe radius ${f2(q(good.map(r => r.r1), .5))} mm`);
  for (const [a, b] of [[0.5, 1], [1, 1.5], [1.5, 2], [2, 3]]) {
    const g = good.filter(r => r.sep >= a && r.sep < b); if (g.length < 5) continue;
    console.log(`  lobe centres ${a}-${b} mm apart: n ${g.length}, waist is ${f2(q(g.map(r => r.waist - r.chord), .5))} mm ` +
      `wider than the two circles' intersection`);
  }
  check('before it splits, the one contour is two-lobed for several layers, its lobes circular arcs',
    q(lobedFor, .5) >= 5 && q(good.map(r => r.rms), .5) < 0.1,
    `${q(lobedFor, .5)} layers median, lobe fit rms ${f3(q(good.map(r => r.rms), .5))} mm`);
  check('a merged contour is ONE wall around ONE merged bore - the lobes do not keep separate bores',
    oneBore > 0.9 * twoLobed.length,
    `${oneBore} of ${twoLobed.length} two-lobed contours have one bore, ${twoBores} have two or more, ` +
    `${twoLobed.length - oneBore - twoBores} none`);
  const wide = good.filter(r => r.sep >= 1.5);
  check('...and its waist is FILLED past a union of circles - consistent with slanted tubes\' elliptical slices',
    wide.length > 100 && q(wide.map(r => r.waist - r.chord), .5) > 0.3,
    `${wide.length} contours with lobes 1.5 mm+ apart: waist ${f2(q(wide.map(r => r.waist - r.chord), .5))} mm wider ` +
    'than the circles\' chord (section 3: a slice of a tube leaning t is 1/cos(t) long along its lean)');

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

  /* Two circles fitted to a two-lobed outline, one each side of its waist. */
  function lobeFit(P) {
    let mx = 0, my = 0, n = 0;
    for (let k = 0; k < P.nx * P.ny; k++) if (P.env[k]) { mx += k % P.nx; my += (k / P.nx) | 0; n++; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < P.nx * P.ny; k++) if (P.env[k]) { const u = k % P.nx - mx, v = ((k / P.nx) | 0) - my; sxx += u * u; syy += v * v; sxy += u * v; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = [Math.cos(th), Math.sin(th)], ay = [-ax[1], ax[0]];
    const cx = mx * RES, cy = my * RES;
    const pr = P.B.map(p => [(p[0] - cx) * ax[0] + (p[1] - cy) * ax[1], (p[0] - cx) * ay[0] + (p[1] - cy) * ay[1]]);
    const tmin = Math.min(...pr.map(p => p[0])), tmax = Math.max(...pr.map(p => p[0]));
    const bins = new Map();
    for (const p of pr) { const b = Math.round(p[0] / 0.08); const w = bins.get(b) || [Infinity, -Infinity]; w[0] = Math.min(w[0], p[1]); w[1] = Math.max(w[1], p[1]); bins.set(b, w); }
    let wt = null, ww = Infinity;
    for (const [b, w] of bins) { const t = b * 0.08; if (t < tmin + 0.2 * (tmax - tmin) || t > tmax - 0.2 * (tmax - tmin)) continue; if (w[1] - w[0] < ww) { ww = w[1] - w[0]; wt = t; } }
    if (wt === null) return null;
    const left = P.B.filter((p, i) => pr[i][0] < wt - 0.3), right = P.B.filter((p, i) => pr[i][0] > wt + 0.3);
    if (left.length < 15 || right.length < 15) return null;
    const c1 = circleFit(left), c2 = circleFit(right), sep = Math.hypot(c1.x - c2.x, c1.y - c2.y);
    let chord = null;
    if (sep < c1.r + c2.r && sep > Math.abs(c1.r - c2.r)) { const a = (sep * sep + c1.r * c1.r - c2.r * c2.r) / (2 * sep); chord = 2 * Math.sqrt(Math.max(0, c1.r * c1.r - a * a)); }
    const res = P.B.map(p => Math.min(Math.abs(Math.hypot(p[0] - c1.x, p[1] - c1.y) - c1.r), Math.abs(Math.hypot(p[0] - c2.x, p[1] - c2.y) - c2.r)));
    return { sep, r1: c1.r, r2: c2.r, waist: ww, chord, rms: Math.sqrt(res.reduce((a, b) => a + b * b, 0) / res.length) };
  }
})().catch(err => { console.error(err); process.exit(1); });

/* The plate G-code's own text, for its settings block. Same central-directory
   walk the slice-artifact tool uses; the importer does not keep the text. */
function gcodeText(file) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const n = buf.toString('utf8', at + 46, at + 46 + nlen);
    if (/plate_\d+\.gcode$/.test(n)) {
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nlen + xlen + clen;
  }
  throw new Error('no plate G-code in ' + file);
}

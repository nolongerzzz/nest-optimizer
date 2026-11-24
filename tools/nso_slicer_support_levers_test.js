#!/usr/bin/env node
/* ============================================================
   tools/nso_slicer_support_levers_test.js - BAMBU'S ADVANCED SUPPORT ROWS, IN THE SLICER (npm run slicer:support-levers)

   docs/SUPPORT-ADVANCED.md. A T - a post with a slab on it, a low block of the part under one wing - and a plain support under each wing,
   sliced with the column rule. Every row is turned and the slice asked what changed: the row does what its name says, and left alone the
   slice is the one it was.
   ============================================================ */
'use strict';
const path = require('path');
const SL = require(path.join(__dirname, '..', 'nso_slicer.js'));

let pass = 0, fail = 0; const failed = [];
function check(name, ok, note) { if (ok) pass++; else { fail++; failed.push(name); } console.log((ok ? '  ok    ' : '  FAIL  ') + name + (note ? '   ' + note : '')); }
function quad(a, b, c, d) { return [].concat(a, b, c, a, c, d); }
function box(x0, y0, z0, x1, y1, z1) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return [].concat(quad(p[0], p[3], p[2], p[1]), quad(p[4], p[5], p[6], p[7]), quad(p[0], p[1], p[5], p[4]), quad(p[1], p[2], p[6], p[5]), quad(p[2], p[3], p[7], p[6]), quad(p[3], p[0], p[4], p[7]));
}
/* the part: a post 6 x 20 (x -3..3), a slab 34 x 20 on it at z 10..12, and a block under the right wing's far end, 4 mm tall */
const PART = Float32Array.from([].concat(box(-3, -10, 0, 3, 10, 10), box(-17, -10, 10, 17, 10, 12), box(11, -10, 0, 17, 10, 4)));
/* the supports: a body under the left wing on the plate (hard against the post), one under the right wing between post and block, one on the block */
const SUP = Float32Array.from([].concat(box(-16, -9, 0, -3.05, 9, 9.98), box(3.05, -9, 0, 10.95, 9, 9.98), box(11.2, -9, 4.02, 16.8, 9, 9.98)));

(async () => {
  const WASM = await SL.loadKernel({});
  const slice = (so) => {
    const o = SL.defaultsFor(0.4, Object.assign({ supportInterfaceLayers: 3, supportLayerMaxMm: 0.28, supportInterfaceRule: 'column', supportInterfaceAngle: 'profile' }, so || {}));
    const res = SL.sliceObjects([{ name: 'part', soup: PART, key: 1, role: 'part' }, { name: 'sup', soup: SUP, key: 2, role: 'support', hostKey: 1 }], o, WASM);
    const sup = res.objects.find(ob => ob.role === 'support'), part = res.objects.find(ob => ob.role !== 'support');
    return { sup, part, res };
  };
  const len = (p) => { let l = 0; const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return l; };
  const sum = (ps) => ps.reduce((a, p) => a + len(p), 0);
  const of = (L, feat, pred) => (L.paths || []).filter(p => p.feature === feat && (!pred || pred(p)));
  const key = (s) => JSON.stringify(s.sup.layers.map(L => [L.printZ, L.paths.map(p => [p.feature, p.closed, p.pts.length, +len(p).toFixed(3)])]));
  /* the direction of a layer's open lines, in degrees 0..180, each weighted by its length -> { deg: mm } */
  const dirs = (ps) => { const d = {}; ps.forEach(p => { if (p.closed) return; for (let i = 1; i < p.pts.length; i++) { const dx = p.pts[i][0] - p.pts[i - 1][0], dy = p.pts[i][1] - p.pts[i - 1][1], l = Math.hypot(dx, dy); if (l < 1) continue; const a = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI) % 180) + 180) % 180; d[a] = (d[a] || 0) + l; } }); return d; };
  const main = (d) => Object.keys(d).map(Number).sort((a, b) => d[b] - d[a]);
  const layerAt = (s, z) => s.sup.layers.reduce((b, L) => (L.paths.length && Math.abs(L.printZ - z) < Math.abs(b.printZ - z) ? L : b), s.sup.layers.find(L => L.paths.length));
  const iface = (s) => s.sup.layers.filter(L => of(L, 'Support interface').length);
  const minDistX = (L, x, side) => { let m = Infinity; L.paths.forEach(p => p.pts.forEach(q => { const d = side > 0 ? q[0] - x : x - q[0]; if (d >= -1e-6 && d < m) m = d; })); return m; };

  const base = slice();
  console.log('=== 0. left alone ===');
  check('the slice with every row at its default is the slice with none given', key(base) === key(slice({ supportBottomGapMm: null, supportZOverridesXy: false, supportInterfacePattern: 'default', supportBasePattern: 'default',
    supportBaseSpacingMm: 2.5, supportWallLoops: -1, supportFirstLayerDensity: 1, supportFirstLayerGapMm: null, supportExpansionMm: 0 })));
  const I0 = iface(base);
  check('the support has a stack: interface layers under the slab, tree under them', I0.length >= 3 && base.sup.layers.filter(L => of(L, 'Support').length).length > 20, I0.length + ' interface layer(s)');

  console.log('\n=== 1. Support wall loops ===');
  const mid = (s) => layerAt(s, 5), walls = (L) => of(L, 'Support', p => p.closed);
  const w1 = walls(mid(base)).length, w2 = walls(mid(slice({ supportWallLoops: 2 }))).length, w3 = walls(mid(slice({ supportWallLoops: 3 }))).length;
  check('-1 is one loop round each piece; 2 and 3 are that many', w1 >= 2 && w2 === 2 * w1 && w3 === 3 * w1, w1 + ' / ' + w2 + ' / ' + w3 + ' loops at z 5');
  check('0 is automatic too', walls(mid(slice({ supportWallLoops: 0 }))).length === w1);

  console.log('\n=== 2. Base pattern, its spacing and the pattern angle ===');
  const fillOf = (L) => of(L, 'Support', p => !p.closed);
  const hol = slice({ supportBasePattern: 'hollow' });
  check('Hollow: walls alone on every layer of the tree but a foot\'s first (on the plate, and on the block)', hol.sup.layers.filter(L => !of(L, 'Support interface').length && !of(L, 'Support transition').length && fillOf(L).length > 0).length === 2 && fillOf(mid(hol)).length === 0);
  const r25 = slice({ supportBasePattern: 'rectilinear' }), r5 = slice({ supportBasePattern: 'rectilinear', supportBaseSpacingMm: 5 }), gr = slice({ supportBasePattern: 'rectilinear-grid' });
  const n25 = fillOf(mid(r25)).length, n5 = fillOf(mid(r5)).length;
  check('Rectilinear: lines through the tree on a layer in its middle, 2.5 mm apart', n25 >= 18 && n25 <= 24, n25 + ' lines, ' + sum(fillOf(mid(r25))).toFixed(0) + ' mm');
  check('...one way, the pattern angle (0: along x)', main(dirs(fillOf(mid(r25))))[0] === 0, JSON.stringify(dirs(fillOf(mid(r25)))));
  check('...each layer\'s lines on the last\'s', JSON.stringify(fillOf(layerAt(r25, 5)).map(p => +p.pts[0][1].toFixed(2)).sort()) === JSON.stringify(fillOf(layerAt(r25, 5.4)).map(p => +p.pts[0][1].toFixed(2)).sort()));
  check('Base pattern spacing 5: about half the lines', n5 > 0 && n5 <= n25 * 0.62 && n5 >= n25 * 0.38, n25 + ' -> ' + n5);
  const r90 = slice({ supportBasePattern: 'rectilinear', supportAngleDeg: 90 });
  check('Pattern angle 90: the lines run along y', main(dirs(fillOf(mid(r90))))[0] === 90, JSON.stringify(dirs(fillOf(mid(r90)))));
  const dg = dirs(fillOf(mid(gr)));
  check('Rectilinear grid: both ways on the layer', dg[0] > 20 && dg[90] > 20, JSON.stringify(dg));

  console.log('\n=== 3. Interface pattern and its spacing ===');
  const ilines = (L) => of(L, 'Support interface', p => !p.closed);
  const rec = slice({ supportInterfacePattern: 'rectilinear' }), itl = slice({ supportInterfacePattern: 'rectilinear_interlaced' }), grd = slice({ supportInterfacePattern: 'grid' }), con = slice({ supportInterfacePattern: 'concentric' });
  const dOf = (s) => iface(s).map(L => main(dirs(ilines(L)))[0]);
  check('Rectilinear: every interface layer the same way', new Set(dOf(rec)).size === 1 && iface(rec).length >= 3, dOf(rec).join(', '));
  check('Rectilinear interlaced: a quarter turn from one layer to the next', dOf(itl).length >= 3 && dOf(itl).every((d, i, a) => i === 0 || Math.abs(Math.abs(d - a[i - 1]) - 90) < 2), dOf(itl).join(', '));
  check('Grid: both ways on each layer', iface(grd).every(L => { const d = dirs(ilines(L)), m = main(d); return m.length >= 2 && Math.abs(Math.abs(m[0] - m[1]) - 90) < 2 && d[m[1]] > 0.5 * d[m[0]]; }));
  check('Concentric: rings, no lines', iface(con).every(L => ilines(L).length === 0 && of(L, 'Support interface', p => p.closed).length >= 3));
  const top = (s) => iface(s)[iface(s).length - 1];
  const a01 = sum(of(top(slice({ supportInterfaceSpacingMm: 0.1 })), 'Support interface')), a05 = sum(of(top(slice({ supportInterfaceSpacingMm: 0.5 })), 'Support interface')), a15 = sum(of(top(slice({ supportInterfaceSpacingMm: 1.5 })), 'Support interface'));
  check('Top interface spacing: wider apart is less line (0.1 / 0.5 / 1.5 mm)', a01 > a05 * 1.4 && a05 > a15 * 1.4, a01.toFixed(0) + ' / ' + a05.toFixed(0) + ' / ' + a15.toFixed(0) + ' mm on the top layer');

  console.log('\n=== 4. Top and bottom Z distance ===');
  const topZ = (s) => Math.max.apply(null, s.sup.layers.filter(L => L.paths.length).map(L => L.printZ));
  const t2 = topZ(slice({ supportGapMm: 0.2 })), t4 = topZ(slice({ supportGapMm: 0.4 })), t6 = topZ(slice({ supportGapMm: 0.6 }));
  check('Top Z distance: the support\'s top stands that far under the slab (z 10)', Math.abs((10 - t2) - 0.2) < 0.11 && Math.abs((10 - t4) - 0.4) < 0.11 && Math.abs((10 - t6) - 0.6) < 0.11 && t2 > t4 && t4 > t6, [t2, t4, t6].map(v => (10 - v).toFixed(2)).join(' / ') + ' mm under it');
  /* the support over the block (x 11.2 .. 16.8): its lowest layer's underside over the block's top at z 4 */
  const lowOver = (s) => { let m = Infinity; s.sup.layers.forEach(L => { if (L.paths.some(p => p.pts.some(q => q[0] > 11.5))) m = Math.min(m, L.printZ - L.h); }); return m; };
  const b0 = lowOver(base), b5 = lowOver(slice({ supportBottomGapMm: 0.5 })), b9 = lowOver(slice({ supportBottomGapMm: 0.9 }));
  check('Bottom Z distance: a support over the part starts that far over its face (the block\'s top, z 4)', b5 - 4 >= 0.5 - 1e-6 && b5 - 4 < 0.5 + 0.3 && b9 - 4 >= 0.9 - 1e-6 && b9 > b5 && b0 <= b5, [b0, b5, b9].map(v => (v - 4).toFixed(2)).join(' / ') + ' mm over it (as built / 0.5 / 0.9)');

  console.log('\n=== 5. Support/object xy distance, and Z overrides X/Y ===');
  const dPost = (s, z) => minDistX(layerAt(s, z), 3, 1);
  const x35 = dPost(base, 5), x10 = dPost(slice({ supportXyMm: 1 }), 5);
  check('xy distance: the tree stands that far from the post beside it', x35 >= 0.35 - 0.03 && x35 < 0.75 && x10 >= 1 - 0.03 && x10 < 1.4, x35.toFixed(2) + ' mm at 0.35, ' + x10.toFixed(2) + ' at 1');
  const zo = slice({ supportXyMm: 1, supportZOverridesXy: true });
  check('Z overrides X/Y: under the slab the support comes in to the wall (0.2), the top distance held', dPost(zo, 5) < 0.45 && dPost(zo, 5) >= 0.2 - 0.03 && Math.abs(topZ(zo) - topZ(slice({ supportXyMm: 1 }))) < 1e-6, dPost(zo, 5).toFixed(2) + ' mm from the post');

  console.log('\n=== 6. The first layer: density, gap ===');
  const first = (s) => s.sup.layers.find(L => L.paths.length);
  const f100 = sum(fillOf(first(base))), f50 = sum(fillOf(first(slice({ supportFirstLayerDensity: 0.5 }))));
  check('Initial layer density 50 %: about half the fill of the first layer', f100 > 100 && f50 > f100 * 0.4 && f50 < f100 * 0.62, f100.toFixed(0) + ' -> ' + f50.toFixed(0) + ' mm');
  check('...and no other layer is touched', key({ sup: { layers: base.sup.layers.slice(1) } }) === key({ sup: { layers: slice({ supportFirstLayerDensity: 0.5 }).sup.layers.slice(1) } }));
  const g0 = minDistX(first(base), 3, 1), g1 = minDistX(first(slice({ supportFirstLayerGapMm: 1 })), 3, 1);
  check('First layer gap 1: the first layer stands 1 mm from the part\'s', g1 >= 1 + 0.2 - 0.05 && g1 < 1.6 && g0 < g1, g0.toFixed(2) + ' -> ' + g1.toFixed(2) + ' mm (the line\'s middle: the gap and half a line)');

  console.log('\n=== 7. Normal support expansion, independent support layer height ===');
  const ext = (s) => { let lo = Infinity, hi = -Infinity; top(s).paths.forEach(p => p.pts.forEach(q => { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); })); return hi - lo; };
  const e0 = ext(base), e1 = ext(slice({ supportExpansionMm: 1 })), em = ext(slice({ supportExpansionMm: -0.3 }));
  check('Expansion +1: the stack reaches further past the overhang\'s edge; -0.3 less far', e1 > e0 + 0.05 && em < e0 - 0.3, e0.toFixed(2) + ' -> ' + e1.toFixed(2) + ' (+1), ' + em.toFixed(2) + ' (-0.3) mm across');
  const zs = (ob) => ob.layers.filter(L => L.paths.length).map(L => +L.printZ.toFixed(3));
  const on = slice({ supportLayerMaxMm: 0.28 }), off = slice({ supportLayerMaxMm: 0 }), pz = new Set(zs(off.part));
  check('Independent support layer height off: every support layer is one of the part\'s', zs(off.sup).every(z => pz.has(z)));
  check('...on: the support has layers of its own, thicker than the part\'s', zs(on.sup).some(z => !pz.has(z)) && Math.max.apply(null, on.sup.layers.map(L => L.h || 0)) > 0.21);

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  if (fail) { failed.forEach(f => console.log('  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

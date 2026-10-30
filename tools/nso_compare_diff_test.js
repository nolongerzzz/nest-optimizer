#!/usr/bin/env node
/* NSOCompareDiff (nso-gscope-diff.js): the numbers Compare reads off two overlaid pieces. Synthetic moves with known answers.
     node tools/nso_compare_diff_test.js        exit 0 = every gate held */
'use strict';
const D = require('../nso-gscope-diff.js');
let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };

const mv = (feature, z, x0, y0, x1, y1, w) => ({ feature, z, x0, y0, x1, y1, width: w || 0.45, height: 0.2, length: Math.hypot(x1 - x0, y1 - y0) });
/* a filled square of lines, 0.4 apart */
const sq = (feature, z, cx, cy, half) => { const out = []; for (let y = cy - half; y <= cy + half + 1e-9; y += 0.4) out.push(mv(feature, z, cx - half, y, cx + half, y)); return out; };
const lay = (i) => +(0.2 * i).toFixed(2);

/* A: a tree (a 2 mm square column) z 0.2 - 2.0, then a plate (transition 2.2, interface 2.4) 6 mm square, the tree's column inside it.
   B: the same, and a tip 1.6 mm square (x 3.4 - 5.0) standing out of the plate's side (x = 3) on layer 2.0. */
const A = [], B = [];
for (let i = 1; i <= 10; i++) { A.push(...sq('Support', lay(i), 0, 0, 1)); B.push(...sq('Support', lay(i), 0, 0, 1)); }
A.push(...sq('Support transition', lay(11), 0, 0, 3), ...sq('Support interface', lay(12), 0, 0, 3));
B.push(...sq('Support transition', lay(11), 0, 0, 3), ...sq('Support interface', lay(12), 0, 0, 3));
B.push(...sq('Support', lay(10), 4.2, 0, 0.8));                                  // a tip past the plate's edge, on the layer under it
const part = sq('Outer wall', lay(5), 0, 0, 5);
A.push(...part); B.push(...part);

const R = D.compute(A, B, { cellMm: 0.1 });
const C = R.classes;
check('line types: A\'s tree runs 0.2 - 2.0, B\'s the same plus its tip (to 2.0); the plate 2.2 / 2.4 in both', C.support.A.firstZ === 0.2 && C.support.A.lastZ === 2 && C.transition.A.firstZ === 2.2 && C.interface.B.lastZ === 2.4 && C.transition.B.firstZ === 2.2, JSON.stringify([C.support.A, C.transition.A].map(q => [q.firstZ, q.lastZ])));
check('the part is the same in both: nothing only A\'s or only B\'s', C.part.onlyAMm2 === 0 && C.part.onlyBMm2 === 0 && C.part.bothMm2 > 90, JSON.stringify(C.part));
check('the tree on the layers both have is the same (the tip alone is B\'s)', C.support.onlyAMm2 === 0 && C.support.onlyBMm2 > 3 && C.support.onlyBMm2 < 6, String(C.support.onlyBMm2));
check('layers: 12 of them, paired by Z', R.layers.length === 12 && R.layers.every(l => l.zA != null && l.zB != null), String(R.layers.length));
const pa = R.plate.A, pb = R.plate.B;
check('each side has one plate, its first layer at 2.2 (the transition)', pa.length === 1 && pb.length === 1 && pa[0].z === 2.2 && pb[0].z === 2.2, JSON.stringify([pa, pb]));
check('A: the tree runs up to the plate - no gap, nothing past its outline', pa[0].gap === false && pa[0].supportBelowMm2 > 3 && pa[0].overshootMm2 === 0, JSON.stringify(pa[0]));
check('B: the tip past the plate\'s outline is found: about 4 mm2 of it, reaching 2 mm out', pb[0].overshootMm2 > 3 && pb[0].overshootMm2 < 4.5 && pb[0].overshootMaxMm > 1.8 && pb[0].overshootMaxMm < 2.2, JSON.stringify(pb[0]));

/* B without the tip, its tree short by two layers: the plate's first layer has no tree on the layer under it */
const B2 = B.filter(m => !(m.feature === 'Support' && m.x0 > 2)).filter(m => !(m.feature === 'Support' && m.z > 1.6));      // the tip gone and the tree short by two layers
const R2 = D.compute(A, B2);
check('a tree that stops short of its plate is a GAP', R2.plate.B[0].gap === true && R2.plate.A[0].gap === false, JSON.stringify(R2.plate.B[0]));
check('...and the layers it misses are the worst ones, 1.8 and 2.0, only A\'s', R2.worst.length >= 2 && R2.worst.slice(0, 2).map(w => w.z).sort().join() === '1.8,2' && R2.worst[0].cls.support.onlyA > 3, JSON.stringify(R2.worst.slice(0, 3).map(w => [w.z, w.supportDiffMm2])));
check('the same pieces against themselves: no difference anywhere', (() => { const r = D.compute(A, A); return D.CLASSES.every(c => r.classes[c].onlyAMm2 === 0 && r.classes[c].onlyBMm2 === 0) && r.worst.length === 0; })());

/* a nudge: B 0.4 mm over in X: the part is no longer on itself */
const Bn = B.map(m => Object.assign({}, m, { x0: m.x0 + 0.4, x1: m.x1 + 0.4 }));
const R3 = D.compute(A, Bn);
check('a 0.4 mm shift shows as an edge of material only in each, on the part', R3.classes.part.onlyAMm2 > 3 && R3.classes.part.onlyBMm2 > 3, JSON.stringify([R3.classes.part.onlyAMm2, R3.classes.part.onlyBMm2]));
check('the text report names the gap and the overshoot', /GAP/.test(D.text(R2)) && /past its outline 3\./.test(D.text(R)), D.text(R2).split('\n').filter(l => /GAP|worst|differ/.test(l)).join(' | ').slice(0, 200));
/* Bambu-like layers: the part's layers at 0.2 steps, the support's at their own Z between them; two separate plates, one with tree under it
   and one without; the plate grows over three layers (its later layers are not 'first') */
const P = [], Q = [];
for (let i = 1; i <= 6; i++) { P.push(...sq('Outer wall', lay(i), 0, 0, 12)); Q.push(...sq('Outer wall', lay(i), 0, 0, 12)); }
for (const z of [0.31, 0.62, 0.93]) { P.push(...sq('Support', z, -6, 0, 1), ...sq('Support', z, 6, 0, 1)); Q.push(...sq('Support', z, -6, 0, 1)); }
for (const [z, h] of [[1.24, 1.5], [1.55, 2.5], [1.86, 3]]) {
  P.push(...sq('Support transition', z, -6, 0, h), ...sq('Support transition', z, 6, 0, h));
  Q.push(...sq('Support transition', z, -6, 0, h), ...sq('Support transition', z, 6, 0, h));
}
const R4 = D.compute(P, Q);
check('two plate regions, first layer 1.24 only (the grown layers 1.55 / 1.86 are not first)', R4.plate.A.length === 1 && R4.plate.A[0].z === 1.24 && R4.plate.A[0].regions === 2, JSON.stringify(R4.plate.A));
check('A: both plates have tree under them - the support layer under is the last support layer (0.93), not the part layer 1.0', R4.plate.A[0].gap === false && R4.plate.A[0].gapRegions === 0, JSON.stringify(R4.plate.A[0]));
check('B: the plate at x = 6 has no tree under it: 1 of 2 regions is a gap', R4.plate.B[0].gap === true && R4.plate.B[0].gapRegions === 1, JSON.stringify(R4.plate.B[0]));
check('empty input is answered', D.text(D.compute([], [])) === 'Nothing to compare.');
console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
process.exit(fails ? 1 : 0);

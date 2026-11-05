/* Lift on the plate - its fixture, generated in code (never anyone's model).
   Node only.

   barocke()   the Barocke plate: a 70 x 50 height-field slab like Picture's
               (tools/nso_lift_auto_fixtures.js's slab), paper at z = 3, every
               feature rising out of it through one sample's slope:
                 a line      a straight bar 50 mm long, 1.2 wide, 0.6 high,
                             along the front
                 a plant     a stem curving across the middle, eleven leaves
                             along it and a bud at its end, one body, 0.8 high - Strip's "large
                             shape"; the engine's necks divide it into its 12
                             parts (data only - nothing splits it)
                 20 dots     discs 2.2 mm across, 0.6 high, a border round the
                             back and the two sides

   hinge()     the hinge plate (grab:drop): a 64 x 40 slab, paper at z = 3,
               carrying two hinge halves laid out flat, side by side, 6 mm
               apart. Each half is one body: a leaf 18 x 24, 1.2 high, and
               two knuckles along its inner edge, 4 wide and 7 long, 2.4
               high. Lifted, a half stays where it stood - 3 mm up, on the
               leftover slab, in the air above the bed.

   `truth` lists what the generator put where: kind, centre, height. */
'use strict';

const FX = require('./nso_lift_auto_fixtures.js');

const W = 70, D = 50, S = 0.3, PAPER = 3;

function inDisc(cx, cy, r) { return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r; }
function inBand(pts, w) {
  return (x, y) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
      const px = a[0] + t * vx - x, py = a[1] + t * vy - y;
      if (px * px + py * py <= w * w / 4) return true;
    }
    return false;
  };
}
function inEllipse(cx, cy, a, b, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return (x, y) => { const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c; return (u * u) / (a * a) + (v * v) / (b * b) <= 1; };
}

/* The stem: a gentle S from (13, 26) across to (55, 26). */
function stemAt(t) { return [13 + 42 * t, 26 + 1.6 * Math.sin(Math.PI * 2 * t)]; }

function barocke() {
  const details = [], truth = [];
  // the line
  details.push({ inside: inBand([[10, 5], [60, 5]], 1.2), h: 0.6 });
  truth.push({ kind: 'line', center: [35, 5], heightMm: 0.6, lengthMm: 50 });
  // the plant: the stem, and eleven leaves along it, alternating sides
  const stem = [];
  for (let i = 0; i <= 40; i++) stem.push(stemAt(i / 40));
  details.push({ inside: inBand(stem, 1.4), h: 0.8 });
  const leaves = [];
  for (let k = 0; k < 11; k++) {
    const t = 0.04 + 0.8 * k / 10, p = stemAt(t), side = k % 2 ? 1 : -1;
    const ang = side * (Math.PI / 2 - 0.35);              // out from the stem, leaning along it
    const cx = p[0] + 3.1 * Math.cos(ang), cy = p[1] + 3.1 * Math.sin(ang);
    details.push({ inside: inEllipse(cx, cy, 3.1, 1.25, ang), h: 0.8 });
    leaves.push([cx, cy]);
  }
  // and a bud at the top of the stem
  const top = stemAt(1);
  details.push({ inside: inDisc(top[0] + 1.2, top[1], 1.8), h: 0.8 });
  truth.push({ kind: 'plant', center: [34, 26], heightMm: 0.8, parts: 12, leaves, bud: [top[0] + 1.2, top[1]] });
  // twenty dots: ten along the back, five up each side
  const dots = [];
  for (let i = 0; i < 10; i++) dots.push([8 + 6 * i, 46.5]);
  for (let j = 0; j < 5; j++) { dots.push([5, 14 + 6 * j]); dots.push([65, 14 + 6 * j]); }
  dots.forEach(c => {
    details.push({ inside: inDisc(c[0], c[1], 1.1), h: 0.6 });
    truth.push({ kind: 'dot', center: c, heightMm: 0.6 });
  });
  const field = (x, y) => {
    let h = 0;
    for (const d of details) if (d.inside(x, y)) h = Math.max(h, d.h);
    return PAPER + h;
  };
  const sl = FX.slab(W, D, S, field);
  return Object.assign(sl, { truth, paper: PAPER, W, D });
}

/* A hinge half: the leaf from x0 to x1 (the knuckles on the side `kx`). */
function hingeHalf(x0, x1, kx, y0) {
  const leaf = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y0 + 24;
  const k1 = (x, y) => Math.abs(x - kx) <= 2 && y >= y0 + 2 && y <= y0 + 9;
  const k2 = (x, y) => Math.abs(x - kx) <= 2 && y >= y0 + 15 && y <= y0 + 22;
  return (x, y) => (k1(x, y) || k2(x, y)) ? 2.4 : leaf(x, y) ? 1.2 : 0;
}

function hinge() {
  const HW = 64, HD = 40;
  const A = hingeHalf(6, 24, 22, 8), B = hingeHalf(40, 58, 42, 8);
  const field = (x, y) => PAPER + Math.max(A(x, y), B(x, y));
  const sl = FX.slab(HW, HD, S, field);
  const truth = [
    { kind: 'hinge', half: 'A', center: [15, 20], heightMm: 2.4, box: [6, 8, 24, 32] },
    { kind: 'hinge', half: 'B', center: [49, 20], heightMm: 2.4, box: [40, 8, 58, 32] }
  ];
  return Object.assign(sl, { truth, paper: PAPER, W: HW, D: HD });
}

module.exports = { barocke, hinge };

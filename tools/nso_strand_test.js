/* nso_strand_test.js - Follow strand, geometry core (nso_strand.js)
     node tools/nso_strand_test.js        exit 0 = every gate held

   A generated cord (a round tube swept along a spiral, end caps on) stands in for the Connector string, so the
   answer is known: the centre line is the curve the tube was swept along, its direction the curve's own tangent.

   GATES
     1. traceAt from a point on the cord's top finds the centre line (< 0.05 mm) and its direction (< 1 degree), and
        the section's height and width are the cord's diameter - on a flat spiral and on one that climbs.
     2. advance marches the centre along the cord: the new centre is on the centre line (< 0.1 mm), `dist` further
        along it (arc length, < 0.1 mm), the direction is right (< 1.5 degrees) - round a tight bend too.
     3. advance carries on across a gap the cord does not fill (a kerf an earlier cut left), lands on the far side
        where it should, and says `end` when the cord stops for good.
     4. the sense of the direction is the same wherever it is found (canonical), and a hint keeps its own sense.
     5. centreline: the section either side of a point, out to 90 degrees of turning - every sample on the centre line
        (< 0.05 mm), its direction right (< 1.5 degrees), arc length right, ending 90 degrees round; across a gap the
        samples inside are not `ok` and the section never ends in one; it stops at the cord's end and at `maxLen`.  */

const path = require('path');
const S = require(path.join(__dirname, '..', 'nso_strand.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const angle = (a, b) => Math.acos(Math.min(1, Math.abs(dot(a, b)) / (len(a) * len(b)))) * 180 / Math.PI;

/* A spiral in the x-z plane, y up: radius R0 + K * theta, rising RISE mm a turn. Parametrised by arc length. */
function makeSpiral(opt) {
  const R0 = opt.r0, K = opt.k, RISE = opt.rise || 0, TURNS = opt.turns, RAD = opt.rad;
  const pts = [], th = [];
  let theta = 0, arc = 0, prev = null;
  const P = th_ => [(R0 + K * th_) * Math.cos(th_), RISE * th_ / (2 * Math.PI), (R0 + K * th_) * Math.sin(th_)];
  const end = TURNS * 2 * Math.PI;
  while (theta <= end) {
    const p = P(theta);
    if (prev) arc += len(sub(p, prev));
    pts.push({ p, arc, theta }); prev = p;
    theta += 0.02;
  }
  return { pts, P, at(s) {                            // the curve's point and unit tangent at arc length s
    let i = 1; while (i < pts.length - 1 && pts[i].arc < s) i++;
    const a = pts[i - 1], b = pts[i], f = (s - a.arc) / (b.arc - a.arc || 1);
    const p = [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f];
    const q = sub(b.p, a.p), l = len(q);
    return { p, t: [q[0] / l, q[1] / l, q[2] / l] };
  }, total: pts[pts.length - 1].arc, RAD };
}

/* The tube round arc lengths [s0, s1] of the spiral (a gap is two tubes), rings every 0.25 mm, 16 round, capped. */
function tube(sp, s0, s1) {
  const SIDES = 16, rings = [];
  for (let s = s0; s <= s1 + 1e-9; s += 0.25) {
    const { p, t } = sp.at(Math.min(s, s1));
    let u = [t[2], 0, -t[0]];                           // horizontal, across the cord
    const ul = len(u); u = [u[0] / ul, 0, u[2] / ul];
    const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const ring = [];
    for (let k = 0; k < SIDES; k++) {
      const a = k * 2 * Math.PI / SIDES, ca = Math.cos(a) * sp.RAD, sa = Math.sin(a) * sp.RAD;
      ring.push([p[0] + u[0] * ca + v[0] * sa, p[1] + u[1] * ca + v[1] * sa, p[2] + u[2] * ca + v[2] * sa]);
    }
    rings.push({ ring, p });
  }
  const out = [];
  const tri = (a, b, c) => out.push(...a, ...b, ...c);
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < SIDES; k++) {
    const a = rings[i].ring[k], b = rings[i].ring[(k + 1) % SIDES], c = rings[i + 1].ring[(k + 1) % SIDES], d = rings[i + 1].ring[k];
    tri(a, b, c); tri(a, c, d);
  }
  [[0, 0], [rings.length - 1, 1]].forEach(([i, flip]) => {
    for (let k = 0; k < SIDES; k++) {
      const a = rings[i].ring[k], b = rings[i].ring[(k + 1) % SIDES];
      if (flip) tri(rings[i].p, b, a); else tri(rings[i].p, a, b);
    }
  });
  return out;
}
const soupOf = parts => new Float32Array([].concat(...parts));

// ---- 1 + 2 + 4: a flat spiral and a climbing one -------------------------------------------------------------
[['flat spiral', { r0: 8, k: 1.6, rise: 0, turns: 3, rad: 1.85 }], ['climbing spiral', { r0: 8, k: 1.6, rise: 3, turns: 3, rad: 1.85 }]].forEach(([name, opt]) => {
  console.log('\n=== ' + name + ' ===');
  const sp = makeSpiral(opt), soup = soupOf([tube(sp, 0, sp.total)]);
  const s0 = sp.total * 0.45, truth = sp.at(s0);
  // a point on the cord's surface, off the axis: the centre line's point lifted by the radius (up)
  const click = [truth.p[0], truth.p[1] + opt.rad * 0.98, truth.p[2]];
  const r = S.traceAt(soup, click, {});
  check(name + ': traceAt finds the cord', !!r);
  if (!r) return;
  check(name + ': the centre is on the centre line', len(sub(r.c, truth.p)) < 0.05, len(sub(r.c, truth.p)).toFixed(3) + ' mm off');
  check(name + ': the direction is the cord\'s', angle(r.t, truth.t) < 1, angle(r.t, truth.t).toFixed(2) + ' deg off');
  check(name + ': the section is the cord\'s diameter', Math.abs(r.w - 3.7) < 0.15 && Math.abs(r.h - 3.7) < 0.2, 'w ' + r.w.toFixed(2) + ', h ' + r.h.toFixed(2));
  // the sense does not depend on the point: the same spot found from the other side gives the same sense
  const r2 = S.traceAt(soup, [truth.p[0], truth.p[1] - opt.rad * 0.98, truth.p[2]], {});
  check(name + ': the sense is the same from another point on the cord', r2 && dot(r.t, r2.t) > 0.99);
  const hint = S.traceAt(soup, click, { hint: [-r.t[0], -r.t[1], -r.t[2]] });
  check(name + ': a hint keeps its own sense', hint && dot(hint.t, r.t) < -0.99);

  // march: forward along the sense found, 2.5 mm at a time, and compare with the curve
  let c = r.c, t = r.t, s = s0, worstC = 0, worstT = 0, worstArc = 0, steps = 0;
  const dirSign = dot(t, truth.t) > 0 ? 1 : -1;
  for (let i = 0; i < 12; i++) {
    const a = S.advance(soup, c, t, 2.5, {});
    if (!a || a.end) break;
    s += dirSign * 2.5; if (s < 0 || s > sp.total) break;
    const tr = sp.at(s);
    worstC = Math.max(worstC, len(sub(a.c, tr.p)));
    worstT = Math.max(worstT, angle(a.t, tr.t));
    c = a.c; t = a.t; steps++;
  }
  check(name + ': ' + steps + ' steps of 2.5 mm keep the centre on the centre line', steps >= 8 && worstC < 0.1, 'worst ' + worstC.toFixed(3) + ' mm');
  check(name + ': ...and the direction right', worstT < 1.5, 'worst ' + worstT.toFixed(2) + ' deg');
});

// ---- 3: across a gap, and the end ----------------------------------------------------------------------------
console.log('\n=== a gap and an end ===');
{
  const sp = makeSpiral({ r0: 8, k: 1.6, rise: 0, turns: 3, rad: 1.85 });
  const gapAt = sp.total * 0.5, GAP = 1.0;
  const soup = soupOf([tube(sp, 0, gapAt - GAP / 2), tube(sp, gapAt + GAP / 2, sp.total)]);
  const from = sp.at(gapAt - 3), tr = S.traceAt(soup, [from.p[0], from.p[1] + 1.8, from.p[2]], {});
  const sense = dot(tr.t, from.t) > 0 ? 1 : -1;
  const ot = [tr.t[0] * sense, tr.t[1] * sense, tr.t[2] * sense];
  const a = S.advance(soup, tr.c, ot, 6, { gap: 1.5 });
  const want = sp.at(gapAt - 3 + sense * 6);
  check('advance 6 mm over a 1 mm gap lands on the far side', a && !a.end && len(sub(a.c, want.p)) < 0.15, a ? len(sub(a.c, want.p)).toFixed(3) + ' mm off' : 'null');
  check('...with the cord\'s direction there', a && angle(a.t, want.t) < 1.5, a ? angle(a.t, want.t).toFixed(2) + ' deg off' : '');
  const wide = S.advance(soup, tr.c, ot, 6, { gap: 0.3 });
  check('a gap wider than `gap` ends the march', wide && wide.end === true);
  const tail = sp.at(sp.total - 2), tt = S.traceAt(soup, [tail.p[0], tail.p[1] + 1.8, tail.p[2]], {});
  const sense2 = dot(tt.t, tail.t) > 0 ? 1 : -1;
  const e = S.advance(soup, tt.c, [tt.t[0] * sense2, tt.t[1] * sense2, tt.t[2] * sense2], 8, {});
  check('marching off the end of the cord says `end`, with how far it got', e && e.end === true && e.moved > 1 && e.moved < 3.5, e ? 'moved ' + e.moved.toFixed(2) : 'null');
}

// ---- 5: the centre line, section by section --------------------------------------------------------------------
console.log('\n=== the centre line either side of a point ===');
{
  const sp = makeSpiral({ r0: 8, k: 1.6, rise: 0, turns: 3, rad: 1.85 }), soup = soupOf([tube(sp, 0, sp.total)]);
  const s0 = sp.total * 0.5, truth = sp.at(s0);
  const tr = S.traceAt(soup, [truth.p[0], truth.p[1] + 1.8, truth.p[2]], {});
  const sense = dot(tr.t, truth.t) > 0 ? 1 : -1;
  const cl = S.centreline(soup, tr.c, tr.t, {});
  check('a section is found', !!cl && cl.samples.length > 40, cl ? cl.samples.length + ' samples, ' + cl.sMin.toFixed(1) + ' to ' + cl.sMax.toFixed(1) + ' mm' : 'null');
  if (cl) {
    let worstC = 0, worstT = 0, worstS = 0;
    cl.samples.forEach(q => {
      const w = sp.at(s0 + sense * q.s);
      worstC = Math.max(worstC, len(sub(q.c, w.p)));
      worstT = Math.max(worstT, angle(q.t, w.t));
      // along +s the direction runs the way s runs: forward on the curve when sense is +1
      if (dot(q.t, [w.t[0] * sense, w.t[1] * sense, w.t[2] * sense]) < 0.99) worstT = 99;
    });
    check('every sample is on the centre line', worstC < 0.05, 'worst ' + worstC.toFixed(3) + ' mm');
    check('...and its direction is right, along +s', worstT < 1.5, 'worst ' + worstT.toFixed(2) + ' deg');
    const a = cl.samples[0], b = cl.samples[cl.samples.length - 1], turn = x => angle(x.t, cl.samples.find(q => q.s === 0).t);
    check('it ends 90 degrees round, both ways', Math.abs(turn(a) - 90) < 4 && Math.abs(turn(b) - 90) < 4, turn(a).toFixed(1) + ' and ' + turn(b).toFixed(1) + ' deg');
    const gaps = cl.samples.slice(1).map((q, i) => q.s - cl.samples[i].s);
    check('the samples run along +s in steps of about 0.5 mm', gaps.every(g => g > 0.4 && g < 0.6), 'steps ' + Math.min(...gaps).toFixed(3) + ' to ' + Math.max(...gaps).toFixed(3));
    check('s = 0 is the point itself', len(sub(cl.samples.find(q => q.s === 0).c, tr.c)) < 1e-9);
  }
  const capped = S.centreline(soup, tr.c, tr.t, { maxLen: 10 });
  check('maxLen caps each way', capped && capped.sMax <= 10.6 && capped.sMin >= -10.6 && capped.sMax > 9, capped ? capped.sMin.toFixed(1) + ' to ' + capped.sMax.toFixed(1) : 'null');
  // a gap in the middle of the section
  const gapAt = s0 + sense * 6, GAP = 1.0;
  const soupG = soupOf(sense > 0 ? [tube(sp, 0, gapAt - GAP / 2), tube(sp, gapAt + GAP / 2, sp.total)] : [tube(sp, 0, gapAt + GAP / 2 - GAP), tube(sp, gapAt + GAP / 2, sp.total)]);
  const clg = S.centreline(soupG, tr.c, tr.t, { gap: 2 });
  const holes = clg ? clg.samples.filter(q => !q.ok) : [];
  check('across a kerf the samples inside are not ok, and the section does not end in one', clg && holes.length >= 1 && clg.samples[0].ok && clg.samples[clg.samples.length - 1].ok, holes.length + ' samples in the gap');
  check('...and beyond it the strand goes on', clg && clg.sMax > 6 + 3, clg ? 'sMax ' + clg.sMax.toFixed(1) : 'null');
  // the end of the cord
  const tail = sp.at(sp.total - 4), tt = S.traceAt(soup, [tail.p[0], tail.p[1] + 1.8, tail.p[2]], {});
  const cle = S.centreline(soup, tt.c, tt.t, {});
  const dirEnd = dot(tt.t, tail.t) > 0 ? cle.sMax : -cle.sMin, dirIn = dot(tt.t, tail.t) > 0 ? -cle.sMin : cle.sMax;
  check('it stops at the cord\'s end (about 4 mm on, not 90 degrees)', dirEnd > 2.5 && dirEnd < 4.6 && dirIn > 10, 'toward the end ' + dirEnd.toFixed(1) + ', the other way ' + dirIn.toFixed(1));
}

console.log('\n----------------------------------------------------------');
console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);

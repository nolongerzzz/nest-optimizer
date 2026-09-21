#!/usr/bin/env node
/* Curving-path sweep - geometry, tolerances and refusals.
 *
 * No browser, no dependencies. Everything here reads the emitted triangle
 * buffer; nothing trusts the construction that produced it.
 *
 * Run: node tools/nso_path_sweep_test.js
 */
'use strict';

const T = require('./nso_path_sweep_testlib.js');
const S = T.loadSweep();
const V = S._v;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function head(s) { console.log('\n== ' + s + ' =='); }

const DEG = Math.PI / 180;

/** Two-segment path: up 20 mm, then turn `deg` in the XY plane and run `out` mm. */
function bendPath(deg, up, out) {
  const t = deg * DEG;
  return [[0, 0, 0], [0, up, 0], [out * Math.sin(t), up + out * Math.cos(t), 0]];
}

function solidCheck(label, tris) {
  const topo = T.topology(tris);
  const bad = T.solidFailures(topo);
  check(label + ' is a closed, outward-wound solid', bad.length === 0, bad.join('; ') ||
        (topo.tris + ' tris, V-E+F=' + topo.euler + ', vol ' + topo.volume.toFixed(4)));
  return topo;
}

// ===========================================================================
head('the profile gate says which rule was broken, by name');
{
  const bad = [
    ['two points', [[0, 0], [1, 1]], /at least 3 points/],
    ['clockwise', S.profileRegular(8, 2).slice().reverse(), /not counter-clockwise/],
    ['non-convex', [[2, 0], [0.4, 0.4], [0, 2], [-2, -2], [2, -2]], /not strictly convex/],
    ['origin outside', [[5, 0], [7, 0], [7, 2], [5, 2]], /does not strictly contain its own origin/]
  ];
  for (const [what, prof, re] of bad) {
    const r = S.sweep({ points: [[0, 0, 0], [0, 10, 0]], profile: prof });
    check('refuses a ' + what + ' profile', !r.ok && re.test(r.reason), r.reason);
  }
  check('accepts a regular 16-gon', S.profileCheck(S.profileRegular(16, 2)).ok);
}

// ===========================================================================
head('the path gate says which rule was broken, by name');
{
  const prof = S.profileRegular(12, 1.5);
  const cases = [
    ['one point', [[0, 0, 0]], /at least 2 points/],
    ['a duplicated point', [[0, 0, 0], [0, 0, 0], [0, 10, 0]], /float32 floor/],
    ['a 180 degree reversal', [[0, 0, 0], [0, 10, 0], [0, 0, 0]], /doubles back/],
    ['a non-finite point', [[0, 0, 0], [0, NaN, 0]], /not finite/]
  ];
  for (const [what, pts, re] of cases) {
    const r = S.sweep({ points: pts, profile: prof });
    check('refuses ' + what, !r.ok && re.test(r.reason), r.reason);
  }
}

// ===========================================================================
head('the frame seed is a knob, not a constraint');
{
  const prof = S.profileRegular(4, 2);          // a square, so a roll is visible
  const pts = [[0, 0, 0], [0, 20, 0]];
  const a = S.sweep({ points: pts, profile: prof, up: [1, 0, 0] });
  const b = S.sweep({ points: pts, profile: prof, up: [0, 0, 1] });
  check('opts.up seeds the frame on segment 0', a.ok && b.ok, (a.reason || '') + (b.reason || ''));
  if (a.ok && b.ok) {
    const roll = Math.acos(Math.min(1, Math.abs(V.dot(a.frames[0].r, b.frames[0].r))));
    check('  ...and two different seeds give two different rolls',
          roll > 1e-3, (roll / DEG).toFixed(3) + ' degrees apart');
    const va = T.topology(a.tris).volume, vb = T.topology(b.tris).volume;
    check('  ...of the same solid', Math.abs(va - vb) / va < 1e-6, va.toFixed(6) + ' vs ' + vb.toFixed(6));
  }
  const bad = S.sweep({ points: pts, profile: prof, up: [0, 1, 0] });
  check('refuses an up-vector parallel to the first segment',
        !bad.ok && /parallel to the first segment/.test(bad.reason), bad.reason);
}

// ===========================================================================
head('a segment too short to survive float32 - caught by whichever gate owns it');
{
  const prof = S.profileRegular(12, 2);
  // Case 1: short relative to the PATH's own magnitude. buildFrames owns this:
  // a direction recovered from a difference that small is pure rounding.
  const r1 = S.sweep({ points: [[0, 0, 0], [0, 20, 0], [0, 20 + 1e-9, 1e-9]], profile: prof });
  check('a 1.4e-9 mm segment at 20 mm is refused where the direction is read',
        !r1.ok && /float32 floor/.test(r1.reason), r1.reason);

  // Case 2: long enough at the path's magnitude, too short at the RING's. The
  // path sits at ~1e-3 mm where one ULP is 1e-10, so the first gate passes it;
  // the rings are 50 mm out where one ULP is 3.8e-6, and that is the magnitude
  // the triangles are actually stored at. The per-rail gate measures there, so
  // it catches what the first one cannot see.
  const big = S.profileRegular(12, 50);
  const r2 = S.sweep({ points: [[0, 0, 0], [0, 1e-3, 0], [0, 1e-3 + 1e-8, 1e-8]], profile: big });
  check('a segment long enough at the path but not at the ring is still refused',
        !r2.ok, r2.reason);
  check('  ...by the per-rail gate, which names the rail',
        !r2.ok && /rail \d+/.test(r2.reason));
}

// ===========================================================================
head('a 2-point path is a plain prism - the straight-line case still works');
{
  const prof = S.profileRegular(16, 2);
  const r = S.sweep({ points: [[0, 0, 0], [0, 30, 0]], profile: prof });
  check('builds', r.ok, r.reason);
  const topo = solidCheck('straight sweep', r.tris);
  const want = r.stats.profileArea * 30;
  check('volume is exactly profile area x length',
        Math.abs(topo.volume - want) / want < 1e-6,
        topo.volume.toFixed(6) + ' vs ' + want.toFixed(6));
  check('no joints, so miter factor is 1', r.stats.maxMiter === 1);
  const wp = S.wallPlanarity(r.rings);
  check('every wall quad is planar', wp.worst < 1e-12, wp.worst.toExponential(3) + ' mm');
  // Sections at five heights, all identical to the profile.
  let worst = 0;
  for (let i = 1; i <= 5; i++) {
    const L = S.sectionLoop(r.tris, [0, i * 5, 0], [0, 1, 0]);
    if (!L) { worst = Infinity; break; }
    worst = Math.max(worst, Math.abs(S.loopArea(L, [0, 1, 0]) - r.stats.profileArea));
  }
  check('cross-section is the profile at every height',
        worst / r.stats.profileArea < 1e-6, 'worst area error ' + worst.toExponential(3) + ' mm2');
}

// ===========================================================================
head('THE CONTROLLED CASE: one 45 degree bend');
{
  const prof = S.profileRegular(16, 2);
  const r = S.sweep({ points: bendPath(45, 20, 20), profile: prof });
  check('builds', r.ok, r.reason);
  const topo = solidCheck('single bend', r.tris);
  check('triangle count is 2*M*(segments+1)', topo.tris === 2 * 16 * 3, String(topo.tris));
  check('vertex count is M*rings + 2 cap apexes', topo.verts === 16 * 3 + 2, String(topo.verts));

  // 1. the joint ring closes from both sides
  check('joint ring closes from both rails',
        r.stats.worstSeamUlps < 1e-3,
        r.stats.worstSeamMm.toExponential(3) + ' mm = ' + r.stats.worstSeamUlps.toExponential(3) + ' float32 ULPs');

  // 2. every wall is exactly planar - Extend's argument, round a corner
  const wp = S.wallPlanarity(r.rings);
  check('every wall quad is planar to float64 noise',
        wp.worst < 1e-12, wp.worst.toExponential(3) + ' mm');

  // 3. the perpendicular section inside each segment IS the profile
  const mids = [[0, 10, 0], V.add(bendPath(45, 20, 20)[1], V.mul(r.segs[1].u, 10))];
  for (let k = 0; k < 2; k++) {
    const L = S.sectionLoop(r.tris, mids[k], r.segs[k].u);
    const a = L ? S.loopArea(L, r.segs[k].u) : NaN;
    check('segment ' + k + ' mid-section is the profile', L && Math.abs(a - r.stats.profileArea) / r.stats.profileArea < 1e-6,
          L ? (L.length + ' pts, area ' + a.toFixed(6) + ' vs ' + r.stats.profileArea.toFixed(6)) : 'no closed section');
  }

  // 4. the section in the bisector plane is stretched, by exactly the miter factor
  const j = r.joints[0];
  const Lm = S.sectionLoop(r.tris, bendPath(45, 20, 20)[1], j.m);
  const am = Lm ? S.loopArea(Lm, j.m) : NaN;
  const wantm = r.stats.profileArea * j.miter;
  check('bisector-plane section is the profile x 1/cos(turn/2)',
        Lm && Math.abs(am - wantm) / wantm < 1e-6,
        'measured ' + am.toFixed(6) + ' mm2, predicted ' + wantm.toFixed(6) + ' mm2, factor ' + j.miter.toFixed(6));

  // 5. volume is untouched by the bend
  const want = r.stats.profileArea * r.stats.pathLength;
  check('volume is still profile area x centreline length',
        Math.abs(topo.volume - want) / want < 1e-6,
        topo.volume.toFixed(6) + ' vs ' + want.toFixed(6));
}

// ===========================================================================
head('the same three claims, swept over bend angle');
{
  const prof = S.profileRegular(24, 2);
  console.log('    turn    miter    section/profile   vol err     seam (ULPs)   wall planarity');
  let allOK = true;
  for (const deg of [5, 15, 30, 45, 60, 90, 120, 150, 170]) {
    const pts = bendPath(deg, 40, 40);
    const r = S.sweep({ points: pts, profile: prof });
    if (!r.ok) { allOK = false; console.log('    ' + deg + '  REFUSED  ' + r.reason); continue; }
    const topo = T.topology(r.tris);
    if (T.solidFailures(topo).length) allOK = false;
    const j = r.joints[0];
    const L = S.sectionLoop(r.tris, pts[1], j.m);
    const ratio = L ? S.loopArea(L, j.m) / r.stats.profileArea : NaN;
    const want = r.stats.profileArea * r.stats.pathLength;
    const volErr = Math.abs(topo.volume - want) / want;
    const wp = S.wallPlanarity(r.rings);
    if (!(Math.abs(ratio - j.miter) / j.miter < 1e-5)) allOK = false;
    if (!(volErr < 1e-6)) allOK = false;
    if (!(wp.worst < 1e-11)) allOK = false;
    console.log('    ' + String(deg).padStart(4) + '  ' + j.miter.toFixed(6).padStart(9) +
                '   ' + ratio.toFixed(6).padStart(9) +
                '   ' + volErr.toExponential(2).padStart(9) +
                '   ' + r.stats.worstSeamUlps.toExponential(2).padStart(10) +
                '   ' + wp.worst.toExponential(2).padStart(10));
  }
  check('every angle from 5 to 170 degrees is solid, stretched by exactly 1/cos(turn/2), and volume-exact', allOK);
}

// ===========================================================================
head('the one gate that is not a proof: a miter can eat its segment');
{
  const prof = S.profileRegular(16, 3);
  // 150 degree turn with only 2 mm of segment: the inside rail runs backwards.
  const tight = S.sweep({ points: bendPath(150, 2, 2), profile: prof });
  check('refuses when the miter eats the segment',
        !tight.ok && /miter has eaten segment/.test(tight.reason), tight.reason);
  check('  ...and names the segment and the rail',
        !tight.ok && /segment \d+ on rail \d+/.test(tight.reason));
  check('  ...and says what to do about it',
        !tight.ok && /arcSubdivide/.test(tight.reason));

  // Same turn, long enough segments: fine. The gate is about the RATIO, not
  // about the angle - which is why it cannot be a fixed angle limit.
  const roomy = S.sweep({ points: bendPath(150, 60, 60), profile: prof });
  check('accepts the same 150 degree turn on long enough segments', roomy.ok, roomy.reason);
  if (roomy.ok) solidCheck('150 degree turn, 60 mm legs', roomy.tris);

  // Walk the segment length down and find where it flips. The prediction is
  // len = r_max * tan(turn/2) for the outermost rail on the inside of the bend.
  const turn = 150 * DEG;
  const predicted = 3 * Math.tan(turn / 2);
  let lastOK = null, firstBad = null;
  for (let L = 40; L > 0.05; L -= 0.01) {
    const rr = S.sweep({ points: bendPath(150, L, L), profile: prof });
    if (rr.ok) lastOK = L; else { firstBad = L; break; }
  }
  check('the flip point is the predicted r*tan(turn/2)',
        lastOK !== null && Math.abs(lastOK - predicted) < 0.05,
        'flips between ' + firstBad.toFixed(3) + ' and ' + lastOK.toFixed(3) +
        ' mm, predicted ' + predicted.toFixed(3) + ' mm');
}

// ===========================================================================
head('arcSubdivide buys the miter stretch down quadratically');
{
  const prof = S.profileRegular(24, 2);
  const turnDeg = 90, turn = turnDeg * DEG;
  const pts = bendPath(turnDeg, 40, 40);
  console.log('    chords   worst section/profile   predicted 1/cos(t/2n)   excess');
  let allOK = true;
  const rows = [];
  for (const n of [1, 2, 4, 8, 16]) {
    let sweepPts = pts;
    if (n > 1) {
      const sub = S.arcSubdivide(pts, { radius: 10, segments: n });
      if (!sub.ok) { allOK = false; console.log('    ' + n + ' REFUSED ' + sub.reason); continue; }
      sweepPts = sub.pts;
    }
    const r = S.sweep({ points: sweepPts, profile: prof });
    if (!r.ok) { allOK = false; console.log('    ' + n + ' REFUSED ' + r.reason); continue; }
    if (T.solidFailures(T.topology(r.tris)).length) allOK = false;
    let worst = 0;
    for (const j of r.joints) {
      const L = S.sectionLoop(r.tris, r.pts[j.at], j.m);
      if (!L) { worst = NaN; break; }
      worst = Math.max(worst, S.loopArea(L, j.m) / r.stats.profileArea);
    }
    const predicted = 1 / Math.cos(turn / (2 * n));
    rows.push({ n, worst, predicted });
    if (!(Math.abs(worst - predicted) / predicted < 1e-4)) allOK = false;
    console.log('    ' + String(n).padStart(6) + '   ' + worst.toFixed(8).padStart(19) +
                '   ' + predicted.toFixed(8).padStart(21) +
                '   ' + ((worst - 1) * 100).toFixed(5).padStart(7) + '%');
  }
  check('each arc joint stretches by exactly 1/cos(turn/2n)', allOK);
  // The quadratic law is the SMALL-ANGLE form, so it is checked where it
  // applies. A single 90 degree miter is nowhere near small: doubling 1 -> 2
  // chords divides the excess by 5.03, not by 4, and reading that as a broken
  // law would be reading the asymptote outside its own range.
  const excess = n => rows.find(x => x.n === n).worst - 1;
  const ratios = [[1, 2], [2, 4], [4, 8], [8, 16]].map(([a, b]) => excess(a) / excess(b));
  console.log('    excess halves as: ' + ratios.map(x => x.toFixed(3)).join('  ->  ') + '   (limit 4)');
  check('the excess falls by 4x per doubling once the small-angle form holds',
        ratios[2] > 3.9 && ratios[2] < 4.2 && ratios[3] > 3.9 && ratios[3] < 4.2,
        '4->8 gives ' + ratios[2].toFixed(3) + ', 8->16 gives ' + ratios[3].toFixed(3));
  check('  ...and is NOT yet 4x at the coarse end, where the asymptote does not apply',
        ratios[0] > 4.5, '1->2 gives ' + ratios[0].toFixed(3));

  const tooBig = S.arcSubdivide(pts, { radius: 500, segments: 4 });
  check('arcSubdivide refuses a radius that does not fit, naming the segment',
        !tooBig.ok && /does not fit: segment \d+/.test(tooBig.reason), tooBig.reason);
}

// ===========================================================================
head('you cannot bend a tube tighter than its own section');
{
  // The per-rail gate turns out to reproduce the physical constraint on bending
  // a real tube: an arc of radius R through a section of reach r is buildable
  // only while R*cos(turn/2n) > r. Swept here, with the profile fixed at r = 3.
  const prof = S.profileRegular(20, 3);
  const turnDeg = 90;
  console.log('    arc R    R*cos(t/2n)   vs r=3     built?');
  let allOK = true;
  for (const R of [2, 2.9, 3.1, 4, 8]) {
    const pts = bendPath(turnDeg, 80, 80);
    const sub = S.arcSubdivide(pts, { radius: R, segments: 8 });
    const built = sub.ok ? S.sweep({ points: sub.pts, profile: prof }) : { ok: false, reason: sub.reason };
    const bound = R * Math.cos((turnDeg * DEG) / 16);
    const expect = bound > 3;
    if (built.ok !== expect) allOK = false;
    if (built.ok && T.solidFailures(T.topology(built.tris)).length) allOK = false;
    console.log('    ' + String(R).padStart(5) + '   ' + bound.toFixed(4).padStart(11) +
                '   ' + (bound > 3 ? ' >  3' : ' <= 3') + '     ' + (built.ok ? 'yes' : 'no'));
  }
  check('R*cos(turn/2n) > r predicts buildability exactly', allOK);

  // The consequence, stated as a negative result: rounding a corner cannot
  // rescue one the single miter refused, because it needs MORE segment.
  const legs = 10, sharpDeg = 150;
  const sharp = bendPath(sharpDeg, legs, legs);
  const flat = S.sweep({ points: sharp, profile: prof });
  check('a 150 degree corner on 10 mm legs is refused by the single miter',
        !flat.ok && /miter has eaten/.test(flat.reason));
  let anyArcRescued = false;
  const tried = [];
  for (const R of [1, 2, 3, 3.1, 4, 6, 10, 20]) {
    const sub = S.arcSubdivide(sharp, { radius: R, segments: 8 });
    const built = sub.ok ? S.sweep({ points: sub.pts, profile: prof }) : { ok: false };
    tried.push(R + (built.ok ? ':built' : ':no'));
    if (built.ok) anyArcRescued = true;
  }
  check('and NO arc radius rescues it - rounding costs more segment, not less',
        !anyArcRescued, 'tried R = ' + tried.join(' '));
  check('  ...and the refusal says so instead of sending the caller to arcSubdivide',
        /will NOT help/.test(flat.reason));
}

// ===========================================================================
head('placement invariance - the Extend lesson, carried over');
{
  const prof = S.profileRegular(16, 2);
  console.log('    offset     seam (mm)    seam (ULPs)    solid?');
  let allOK = true;
  for (const off of [0, 100, 1400]) {
    const pts = bendPath(45, 20, 20).map(p => [p[0] + off, p[1] + off, p[2]]);
    const r = S.sweep({ points: pts, profile: prof });
    if (!r.ok) { allOK = false; console.log('    ' + off + ' REFUSED ' + r.reason); continue; }
    const bad = T.solidFailures(T.topology(r.tris));
    if (bad.length) allOK = false;
    console.log('    ' + String(off).padStart(6) + '   ' + r.stats.worstSeamMm.toExponential(3).padStart(10) +
                '   ' + r.stats.worstSeamUlps.toExponential(3).padStart(11) +
                '    ' + (bad.length ? bad.join('; ') : 'yes'));
  }
  check('the same bend is solid at the origin, at 100 mm and at 1400 mm', allOK);

  // The seam gate is not the one a fixed millimetre tolerance breaks - it reads
  // as float64 noise at every magnitude here, and claiming otherwise would be
  // inventing a failure. The gate that DOES break is the one that reads a
  // section back out of the float32 soup, and the hard case is the section that
  // matters most: the one taken EXACTLY in a joint's bisector plane, where a
  // whole ring of vertices lies in the cutting plane scattered a few ULPs
  // either side of it.
  //
  // The failure is quiet, which is the point. A fixed tolerance does not return
  // nothing; it returns a loop enclosing the right AREA with the wrong number
  // of corners, because the duplicates it fails to merge are collinear. Any
  // caller checking area sees nothing wrong. Any caller comparing the section's
  // vertices to the profile gets a 38-gon where the section is a 16-gon.
  console.log('\n    reading the bisector-plane section back out of the float32 soup');
  console.log('    (the section IS a 16-gon - the profile, stretched):');
  console.log('    offset   1e-7 mm, both    strict plane test    float32-derived');
  let derivedRight = true, fixedWrong = false;
  for (const off of [0, 100, 1400]) {
    const pts = bendPath(45, 20, 20).map(p => [p[0] + off, p[1] + off, p[2]]);
    const r = S.sweep({ points: pts, profile: prof });
    const j = r.joints[0], P = pts[1];
    const scale = S.ulp32(Math.max(Math.abs(P[0]), Math.abs(P[1]), Math.abs(P[2])));
    const asUlps = 1e-7 / scale;               // what 1e-7 mm IS, in ULPs, here
    const fx = S.sectionLoop(r.tris, P, j.m, { weldUlps: asUlps, planeUlps: asUlps });
    const st = S.sectionLoop(r.tris, P, j.m, { planeUlps: 0 });
    const dv = S.sectionLoop(r.tris, P, j.m);
    const n = L => (L ? String(L.length) + ' pts' : 'no loop');
    if (!dv || dv.length !== 16) derivedRight = false;
    if (!fx || fx.length !== 16) fixedWrong = true;
    console.log('    ' + String(off).padStart(6) + '   ' + n(fx).padEnd(16) + ' ' +
                n(st).padEnd(20) + ' ' + n(dv));
  }
  check('a fixed 1e-7 mm tolerance reports the wrong number of section corners', fixedWrong);
  check('the float32-derived pair reads the 16-gon back at every magnitude', derivedRight);
}

// ===========================================================================
head('the frame does not twist - parallel transport, not a world up-vector');
{
  const prof = S.profileRegular(16, 2);
  // A path that turns out of its own plane: a fixed up-vector frame would roll.
  const pts = [[0, 0, 0], [0, 20, 0], [15, 35, 0], [15, 50, 18], [0, 60, 30]];
  const r = S.sweep({ points: pts, profile: prof });
  check('a 4-segment out-of-plane path builds', r.ok, r.reason);
  if (r.ok) {
    solidCheck('4-segment 3D path', r.tris);
    let worstOrtho = 0, worstRoll = 0;
    for (let k = 0; k < r.frames.length; k++) {
      const f = r.frames[k], u = r.segs[k].u;
      worstOrtho = Math.max(worstOrtho,
        Math.abs(V.dot(f.r, u)), Math.abs(V.dot(f.s, u)), Math.abs(V.dot(f.r, f.s)),
        Math.abs(V.len(f.r) - 1), Math.abs(V.len(f.s) - 1));
      if (k > 0) {
        // The frame carried forward by the minimal rotation is the frame we
        // used. Roll is the angle between them, and it must be zero - that is
        // what "rotation-minimizing" means, measured rather than asserted.
        const carried = (function rot(v, from, to) {
          const ax = V.cross(from, to), s = V.len(ax), c = V.dot(from, to);
          if (s <= 1e-14) return v.slice();
          const a = V.mul(ax, 1 / s), ang = Math.atan2(s, c), ca = Math.cos(ang), sa = Math.sin(ang);
          return V.add(V.add(V.mul(v, ca), V.mul(V.cross(a, v), sa)), V.mul(a, V.dot(a, v) * (1 - ca)));
        })(r.frames[k - 1].r, r.segs[k - 1].u, u);
        worstRoll = Math.max(worstRoll, Math.acos(Math.min(1, Math.abs(V.dot(carried, f.r)))));
      }
    }
    check('frames stay orthonormal across every joint', worstOrtho < 1e-12, worstOrtho.toExponential(3));
    check('frames carry no roll - zero twist about the tangent',
          worstRoll < 1e-9, (worstRoll / DEG).toExponential(3) + ' degrees');

    // What a fixed world up-vector would have done on the same path. Two
    // separate failures, and the first one is the one that matters here.
    const up = [0, 1, 0];
    const mk = u => {
      const p = V.sub(up, V.mul(u, V.dot(up, u)));
      return V.len(p) < 1e-9 ? null : V.norm(p);
    };
    const singular = r.segs.filter(sg => mk(sg.u) === null).length;
    check('a world up-vector has NO frame at all on a vertical segment',
          singular > 0,
          singular + ' of ' + r.segs.length + ' segments are parallel to +Y - and a support ' +
          'branch leaving the plate is exactly that segment, every time');

    // And on a path that avoids the singularity, it still rolls.
    const tilted = [[0, 0, 0], [12, 20, 0], [26, 34, 14], [26, 50, 30]];
    const rt = S.sweep({ points: tilted, profile: prof });
    let naiveRoll = 0;
    for (let k = 1; k < rt.segs.length; k++) {
      const a = mk(rt.segs[k - 1].u), b = mk(rt.segs[k].u);
      const carried = (function rot(v, from, to) {
        const ax = V.cross(from, to), sl = V.len(ax), c = V.dot(from, to);
        if (sl <= 1e-14) return v.slice();
        const q = V.mul(ax, 1 / sl), ang = Math.atan2(sl, c), ca = Math.cos(ang), sa = Math.sin(ang);
        return V.add(V.add(V.mul(v, ca), V.mul(V.cross(q, v), sa)), V.mul(q, V.dot(q, v) * (1 - ca)));
      })(a, rt.segs[k - 1].u, rt.segs[k].u);
      naiveRoll += Math.acos(Math.min(1, Math.abs(V.dot(carried, b))));
    }
    check('and where it is defined at all, it still twists',
          naiveRoll > 1e-3, 'rolls ' + (naiveRoll / DEG).toFixed(3) + ' degrees over 2 joints, ' +
          'against 0 for parallel transport');
  }
}

// ===========================================================================
head('many joints: a 9-point space path stays one solid');
{
  const prof = S.profileRegular(12, 1.5);
  const pts = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    pts.push([14 * Math.sin(t * 2.2), 46 * t, 10 * Math.sin(t * 3.4) - 4 * t]);
  }
  const r = S.sweep({ points: pts, profile: prof });
  check('builds', r.ok, r.reason);
  if (r.ok) {
    const topo = solidCheck('9-point space path', r.tris);
    check('7 joints, all mitred', r.joints.length === 7, 'max turn ' + r.stats.maxTurnDeg.toFixed(2) + ' deg');
    const want = r.stats.profileArea * r.stats.pathLength;
    check('volume identity survives 7 joints',
          Math.abs(topo.volume - want) / want < 1e-6,
          topo.volume.toFixed(6) + ' vs ' + want.toFixed(6));
    const wp = S.wallPlanarity(r.rings);
    check('all 84 wall quads still planar', wp.worst < 1e-11, wp.worst.toExponential(3) + ' mm');
  }
}

// ===========================================================================
head('PROBE, not a feature: what a flaring (tapered) branch would cost');
{
  // This is the Bambu tree-support shape the ticket points at - a branch that
  // widens into a mesh interface instead of necking to a point. It is NOT
  // implemented. The probe builds the rings a tapered sweep would need and
  // measures the one property that breaks, so the next ticket starts from a
  // number instead of an opinion.
  const prof = S.profileRegular(16, 2);
  const straight = S.sweep({ points: [[0, 0, 0], [0, 20, 0], [0, 40, 0]], profile: prof });
  const bent = S.sweep({ points: bendPath(45, 20, 20), profile: prof });

  // Scale each ring about its own path point - the rings a tapered sweep needs.
  function taper(res, scales) {
    return res.rings.map((ring, i) =>
      ring.map(p => V.add(res.pts[i], V.mul(V.sub(p, res.pts[i]), scales[i]))));
  }
  const sc = [1, 1.6, 2.4];

  const wS = S.wallPlanarity(taper(straight, sc));
  check('a taper along a STRAIGHT run keeps every wall planar',
        wS.worst < 1e-12, wS.worst.toExponential(3) + ' mm  (a cone frustum face is a flat trapezoid)');

  const wB = S.wallPlanarity(taper(bent, sc));
  check('a taper THROUGH A MITRED BEND does not - and here is how far off',
        wB.worst > 1e-6, wB.worst.toExponential(3) + ' mm out of plane, on a 2 mm section over a 45 degree turn');
  console.log('    Straight taper: planar. Mitred taper: ' + wB.worst.toExponential(3) +
              ' mm. See docs/CURVING-PATH.md, "What a flare costs".');
}

// ===========================================================================
console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failed: ' + FAILS.join(' | ')); process.exit(1); }

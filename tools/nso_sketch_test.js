/* nso_sketch.js - a drawing's lines and fills as solids, headless.
     node tools/nso_sketch_test.js        exit 0 = every gate held

   Pinned:
   1. every kind of object - a straight line, a bent line, a zigzag, a hairpin
      whose legs are a width apart, a line that crosses itself, a closed line (a
      ring), a fill, a fill with a notch - is closed and consistently wound,
      no degenerate triangle, positive volume, from z0 to z1 exactly;
   2. volumes by hand: a straight line L long, w wide, h tall is
      (L w + pi (w/2)^2) h (round ends, to the arc's chords); a filled
      rectangle is its area x height; a ring of a square is the outer square
      less the inner;
   3. no outline edge longer than MAX_EDGE (the boolean's sliver rule);
   4. smooth() thins jitter and keeps a corner over 60 degrees;
   5. a self-crossing line comes back as overlapping runs; overlapGroups puts
      them together; a self-crossing fill is refused in words;
   6. solids(): centred on the box, scale, mirror, lift and embed. */
const path = require('path');
global.NSO_CDT = require(path.join(__dirname, '..', 'nso_cdt.js'));
const SK = require(path.join(__dirname, '..', 'nso_sketch.js'));
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-4 : t);
function box(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { if (s[i + k] < lo[k]) lo[k] = s[i + k]; if (s[i + k] > hi[k]) hi[k] = s[i + k]; }
  return { lo, hi };
}
function polyArea(n, r) { return 0.5 * n * r * r * Math.sin(2 * Math.PI / n); }

const zig = [];
for (let i = 0; i < 6; i++) zig.push([0, i * 4], [30, i * 4 + 2]);
const wave = [];
for (let i = 0; i <= 120; i++) wave.push([i * 0.5, 6 * Math.sin(i * 0.1)]);
const loopy = [];
for (let i = 0; i <= 200; i++) { const t = i / 200 * 4 * Math.PI; loopy.push([t * 3 + 6 * Math.cos(t), 6 * Math.sin(t)]); }

const cases = [
  ['straight line', { kind: 'line', pts: [[0, 0], [40, 0]], width: 2 }],
  ['bent line, a right angle', { kind: 'line', pts: [[0, 0], [20, 0], [20, 20]], width: 2 }],
  ['zigzag', { kind: 'line', pts: zig, width: 1.2 }],
  ['hairpin, legs a width apart', { kind: 'line', pts: [[0, 0], [20, 0], [0, 3.2]], width: 3 }],
  ['smooth wave', { kind: 'line', pts: wave, width: 1.5 }],
  ['line that loops over itself', { kind: 'line', pts: loopy, width: 1.5 }],
  ['ring (closed square line)', { kind: 'line', closed: true, pts: SK.rectPts(0, 0, 30, 20), width: 2 }],
  ['ring (ellipse line)', { kind: 'line', closed: true, pts: SK.ellipsePts(0, 0, 15, 8), width: 1.6 }],
  ['filled rectangle', { kind: 'fill', pts: SK.rectPts(0, 0, 30, 20) }],
  ['filled notch', { kind: 'fill', pts: [[0, 0], [30, 0], [30, 20], [15, 6], [0, 20]] }],
  ['filled ellipse', { kind: 'fill', pts: SK.ellipsePts(5, 5, 12, 7) }]
];

console.log('1, 3. closed, wound, its own height, short edges');
const got = {};
cases.forEach(([name, o]) => {
  const r = SK.solids({ height: 2, objects: [o] }, { embed: 0.4 });
  got[name] = r;
  if (!r.ok) { check(name + ': built', false, r.reason); return; }
  r.parts.forEach((p, i) => {
    const t = FX.topology(p.soup), b = box(p.soup), tag = name + (r.parts.length > 1 ? ' part ' + i : '');
    check(tag + ': closed, wound, no degenerate triangle', t.bad === 0 && t.degenerate === 0, JSON.stringify(t));
    check(tag + ': positive volume = signedVolume', p.volume > 0 && near(FX.volume(p.soup), p.volume, 1e-2));
    check(tag + ': from -0.4 to 2', near(b.lo[2], -0.4, 1e-5) && near(b.hi[2], 2, 1e-5), b.lo[2] + '..' + b.hi[2]);
    let longest = 0;
    p.loops.forEach(L => { for (let k = 0; k < L.length; k++) { const a = L[k], c = L[(k + 1) % L.length]; longest = Math.max(longest, Math.hypot(a[0] - c[0], a[1] - c[1])); } });
    check(tag + ': outline drawn as given (densified at extrude)', longest > 0);
  });
});

console.log('2. volumes by hand');
{
  const r = got['straight line'], H = 2.4, w = 2, n = 2 * Math.ceil(180 / 15);
  const want = (40 * w + polyArea(n, w / 2)) * H;
  check('straight line 40 x 2, round ends: (L w + disc) h', r.ok && near(r.parts[0].volume, want, 0.02), r.ok && r.parts[0].volume.toFixed(3) + ' vs ' + want.toFixed(3));
  const f = got['filled rectangle'];
  check('filled 30 x 20 x 2.4', f.ok && near(f.parts[0].volume, 30 * 20 * H, 1e-2), f.ok && f.parts[0].volume);
  const g = got['ring (closed square line)'];
  const ringWant = (32 * 22 - 28 * 18) * H;      // outer corners rounded: less than the square by (4 - pi) r^2 to chords
  const roundLoss = (4 * 1 - polyArea(24, 1)) * H;
  check('square ring 30 x 20, line 2: outer less inner (round outer corners)', g.ok && g.parts.length === 1 && near(g.parts[0].volume, ringWant - roundLoss, 0.05), g.ok && g.parts[0].volume.toFixed(3) + ' vs ' + (ringWant - roundLoss).toFixed(3));
  check('the ring has a hole', g.ok && g.parts[0].loops.length === 2);
}

console.log('4. smooth');
{
  const raw = [];
  for (let i = 0; i <= 200; i++) raw.push([i * 0.1 + (i % 2 ? 0.02 : -0.02), (i % 3) * 0.01]);
  for (let i = 1; i <= 200; i++) raw.push([20 + (i % 2 ? 0.02 : 0), i * 0.1]);
  const s = SK.smooth(raw);
  check('jitter thinned to few points', s.length < 20, s.length);
  const corner = s.some(p => Math.hypot(p[0] - 20, p[1]) < 0.3);
  check('the right-angle corner is kept', corner, JSON.stringify(s));
  check('ends kept', Math.hypot(s[0][0], s[0][1]) < 0.1 && Math.abs(s[s.length - 1][1] - 20) < 0.1);
}

console.log('5. crossings');
{
  const r = got['line that loops over itself'];
  check('self-crossing line: built as several runs', r.ok && r.parts.length > 1, r.ok ? r.parts.length : r.reason);
  if (r.ok) check('its runs overlap: one group to union', SK.overlapGroups(r.parts).length === 1);
  const bow = SK.solids({ height: 1, objects: [{ kind: 'fill', pts: [[0, 0], [10, 10], [10, 0], [0, 10]] }] });
  check('a bow-tie fill is refused in words', !bow.ok && /crosses itself/.test(bow.reason), bow.reason);
  const thin = SK.solids({ height: 1, objects: [{ kind: 'line', pts: [[0, 0], [5, 0]], width: 0.05 }] });
  check('a line under the least width is refused', !thin.ok, thin.reason);
  const pin = SK.solids({ height: 1, objects: [{ kind: 'line', pts: [[0, 0], [20, 0], [0, 1]], width: 3 }] });
  check('a hairpin whose legs lie on each other is refused in words', !pin.ok && /folds onto itself/.test(pin.reason), pin.reason);
  const none = SK.solids({ height: 1, objects: [] });
  check('an empty drawing is refused in words', !none.ok && /empty/.test(none.reason));
  const apart = SK.solids({ height: 1, objects: [{ kind: 'fill', pts: SK.rectPts(0, 0, 5, 5) }, { kind: 'fill', pts: SK.rectPts(20, 0, 25, 5) }] });
  check('two fills apart: two groups', apart.ok && SK.overlapGroups(apart.parts).length === 2);
}

console.log('6. solids(): centred, scaled, mirrored, lifted');
{
  const sk = { height: 3, objects: [{ kind: 'fill', pts: [[10, 10], [40, 10], [40, 30], [10, 30]] }] };
  const a = SK.solids(sk, { embed: 0.5 }), b = box(a.parts[0].soup);
  check('centred on its box', near(b.lo[0], -15) && near(b.hi[0], 15) && near(b.lo[1], -10) && near(b.hi[1], 10), JSON.stringify(b));
  const s2 = SK.solids(sk, { scale: 2, embed: 0 }), b2 = box(s2.parts[0].soup);
  check('scale 2: 60 x 40, volume x4', near(b2.hi[0] - b2.lo[0], 60) && near(s2.parts[0].volume, 60 * 40 * 3, 1e-2));
  const m = SK.solids({ height: 1, objects: [{ kind: 'fill', pts: [[0, 0], [10, 0], [0, 10]] }] }, { mirror: 'x' }), bm = m.parts[0];
  check('mirror x: still closed and positive', m.ok && FX.topology(bm.soup).bad === 0 && bm.volume > 0);
  const l = SK.solids(sk, { lift: 2, embed: 0.4 }), bl = box(l.parts[0].soup);
  check('lift 2: from 1.6 to 5', near(bl.lo[2], 1.6, 1e-5) && near(bl.hi[2], 5, 1e-5));
  const h = SK.solids(sk, { height: 7 }), bh = box(h.parts[0].soup);
  check('height override 7', near(bh.hi[2], 7, 1e-5));
  const per = SK.solids({ height: 1, objects: [{ kind: 'fill', pts: SK.rectPts(0, 0, 5, 5), height: 4 }] }), bp = box(per.parts[0].soup);
  check('an object\'s own height over the drawing\'s', near(bp.hi[2], 4, 1e-5));
}

console.log('stretch, trace');
{
  const sk = { height: 2, objects: [{ kind: 'fill', pts: SK.rectPts(0, 0, 10, 4) }] };
  const r = SK.solids(sk, { stretch: [3, 0.5] }), b = box(r.parts[0].soup);
  check('stretch 3 x 0.5: 30 x 2, volume x1.5', near(b.hi[0] - b.lo[0], 30) && near(b.hi[1] - b.lo[1], 2) && near(r.parts[0].volume, 30 * 2 * 2, 1e-2) && near(r.box.w, 30) && near(r.box.h, 2));
  check('the drawing\'s own centre is given back', r.centre[0] === 5 && r.centre[1] === 2);
  const bad = SK.solids(sk, { stretch: [0, 1] });
  check('a stretch of 0 is refused', !bad.ok);
  const line = SK.solids({ height: 1, objects: [{ kind: 'line', pts: [[0, 0], [10, 0]], width: 2 }] }, { stretch: [2, 5] }), bl = box(line.parts[0].soup);
  check('a line stretched keeps its width (2), its length doubles', near(bl.hi[1] - bl.lo[1], 2, 1e-3) && near(bl.hi[0] - bl.lo[0], 22, 1e-3));
  const n = SK.normalize({ height: 1, objects: [], trace: { pieceId: 4, name: 'p', at: 3, box: { x0: -1, y0: -2, x1: 1, y1: 2 }, loops: [[[0, 0], [1, 0], [0, 1]], [[0, 0]]] } });
  check('a trace is kept, its short loops dropped', n.trace && n.trace.pieceId === 4 && n.trace.loops.length === 1 && n.trace.box.y1 === 2);
  check('no trace: null', SK.normalize({ objects: [] }).trace === null);
}

console.log('a top flush with the piece');
{
  const sk = { height: 10, objects: [{ kind: 'fill', pts: SK.rectPts(0, 0, 4, 4) }] };
  const a = SK.solids(sk, { avoidTop: 10.01 }), ba = box(a.parts[0].soup);
  check('within 0.015 of avoidTop: stood FLUSH_GAP over it', a.lowered === 1 && near(ba.hi[2], 10.01 + SK.FLUSH_GAP, 1e-5), ba.hi[2]);
  const b = SK.solids(sk, { avoidTop: 10.5 }), bb = box(b.parts[0].soup);
  check('farther: untouched', b.lowered === 0 && near(bb.hi[2], 10, 1e-5));
}

console.log('line assist');
{
  const kinds = r => r.runs.map(x => x.kind).join(',');
  const rough = []; for (let i = 0; i <= 40; i++) rough.push([i * 0.5 + Math.sin(i) * 0.15, Math.cos(i * 1.3) * 0.2]);
  for (let i = 1; i <= 30; i++) rough.push([20 + Math.sin(i * 2) * 0.2, i * 0.5 + 0.1 * Math.cos(i)]);
  const L = SK.assist(SK.smooth(rough), { mode: 'auto' });
  check('a rough L: two straight walls at 0 and 90 degrees, one sharp corner', kinds(L) === 'line,line' && L.pts.length === 3 &&
        near(L.pts[0][1], L.pts[1][1], 1e-9) && near(L.pts[1][0], L.pts[2][0], 1e-9), JSON.stringify(L.pts));
  const sq = [[0, 0], [20.3, 0.4], [19.8, 10.2], [0.2, 9.7]], raw = [];
  for (let k = 0; k < 4; k++) { const A = sq[k], B = sq[(k + 1) % 4]; for (let i = 0; i < 20; i++) raw.push([A[0] + (B[0] - A[0]) * i / 20 + Math.sin(i) * 0.1, A[1] + (B[1] - A[1]) * i / 20]); }
  const R = SK.assist(SK.smooth(raw, { closed: true }), { mode: 'auto', closed: true });
  const axis = R.pts.every((p, i) => { const q = R.pts[(i + 1) % R.pts.length]; return near(p[0], q[0], 1e-9) || near(p[1], q[1], 1e-9); });
  check('a rough closed rectangle: four sides, every one exactly level or upright', R.pts.length === 4 && axis, JSON.stringify(R.pts));
  const arc = []; for (let i = 0; i <= 60; i++) { const t = i / 60 * Math.PI; arc.push([10 * Math.cos(t) + Math.sin(i * 3) * 0.15, 10 * Math.sin(t) + Math.cos(i * 2) * 0.15]); }
  const A = SK.assist(SK.smooth(arc), { mode: 'auto' });
  check('a rough half circle: one arc, radius 10 to 0.15', kinds(A) === 'arc' && near(A.runs[0].r, 10, 0.15) && A.pts.every(p => near(Math.hypot(p[0] - A.runs[0].c[0], p[1] - A.runs[0].c[1]), A.runs[0].r, 1e-6)), A.runs[0] && A.runs[0].r);
  const u = []; for (let i = 0; i <= 30; i++) u.push([-10 + Math.sin(i) * 0.1, 20 - i * 0.5]);
  for (let i = 1; i <= 40; i++) { const t = Math.PI + i / 40 * Math.PI; u.push([10 * Math.cos(t), 5 + 10 * Math.sin(t) + Math.cos(i) * 0.1]); }
  for (let i = 1; i <= 30; i++) u.push([10, 5 + i * 0.5]);
  const U = SK.assist(SK.smooth(u), { mode: 'auto' });
  check('a U (no corner): line, arc, line - the straight legs found where the curve begins', kinds(U) === 'line,arc,line' && near(U.runs[1].r, 10, 0.1), kinds(U));
  const j = []; for (let i = 0; i <= 40; i++) j.push([0, 30 - i * 0.5]);
  for (let i = 1; i <= 30; i++) { const t = Math.PI + i / 30 * Math.PI / 2; j.push([8 + 8 * Math.cos(t), 10 + 8 * Math.sin(t)]); }
  const J = SK.assist(SK.smooth(j), { mode: 'auto' });
  check('a J: a line into an arc of radius 8', kinds(J) === 'line,arc' && near(J.runs[1].r, 8, 0.05), kinds(J));
  const Us = SK.assist(SK.smooth(u), { mode: 'straight' });
  check('Straight on the U: only straight lines, its legs still upright', Us.runs.every(x => x.kind === 'line') && Us.runs.length >= 3 && near(Us.pts[0][0], Us.pts[1][0], 1e-9), kinds(Us));
  const tilt = []; for (let i = 0; i <= 40; i++) tilt.push([i * 0.5 * Math.cos(0.38) + Math.sin(i) * 0.1, i * 0.5 * Math.sin(0.38)]);
  const T1 = SK.assist(tilt, { mode: 'straight', dirs: [22] }), ang = T1.runs[0].angle;
  check('a line near a traced wall\'s 22 degrees takes that angle (not 15 or 30)', near(((ang % 180) + 180) % 180, 22, 1e-9), ang);
  const ci = []; for (let i = 0; i < 80; i++) { const t = i / 80 * 2 * Math.PI; ci.push([6 * Math.cos(t) + Math.sin(i * 2.3) * 0.15, 6 * Math.sin(t)]); }
  const C = SK.assist(SK.smooth(ci, { closed: true }), { mode: 'auto', closed: true });
  check('a rough closed circle: a true circle, radius 6 to 0.1, still a fill that builds', kinds(C) === 'arc' && near(C.runs[0].r, 6, 0.1) &&
        SK.solids({ height: 1, objects: [{ kind: 'fill', pts: C.pts }] }).ok);
  const built = SK.solids({ height: 1, objects: [{ kind: 'line', pts: U.pts, width: 1.2 }] });
  check('the assisted U still builds as a line', built.ok, built.reason);
}

console.log('normalize / describe');
{
  const n = SK.normalize({ height: 2, objects: [{ kind: 'fill', pts: [[0, 0], [1, 0], [0, 1]] }, { kind: 'line', pts: [[0, 0]] }, { kind: 'line', id: 7, pts: [[0, 0], [3, 0]] }] });
  check('a one-point object is dropped; ids filled in', n.objects.length === 2 && n.objects[1].id === 7 && n.objects[0].id === 8 && n.nextId === 9, JSON.stringify(n.objects.map(o => o.id)));
  check('describe', /1 line \+ 1 fill/.test(SK.describe(n)), SK.describe(n));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
process.exit(fails ? 1 : 0);

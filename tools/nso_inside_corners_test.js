#!/usr/bin/env node
/* Regression suite for nso_inside_corners.js — the corners8 setback taken
   into a pocket interior.

   Three parts, matching the ticket:
     1. what the outer setback engine assumes about convexity, proved by
        running it against concave input and recording what it does;
     2. the bake itself on a synthetic pocket — vertex radii round, wall
        edges stay square, the lid rim stays sharp, nothing self-intersects;
     3. no regression on the shipped inside3 path.

   Run: node tools/nso_inside_corners_test.js
   Writes result STLs under tools/out/inside-corners/ so
   tools/mesh_validate.py can be pointed at any of them. */

const path = require('path');
const T = require('./nso_inside_corners_testlib.js');
const IC = require('../nso_inside_corners.js');

const OUT = path.join(__dirname, 'out', 'inside-corners');
const R = 2.0;
const E = T.loadEngines();

/* ---------------------------------------------------------------- fixtures */

/* A simple pocket: hull 40x30x20, one rectangular cavity 20x12 x 10 deep,
   opening through +Z. Built with the kernel so it is the same shape a real
   Subtract leaves, not a hand-wound special case. */
const HULL_LO = [0, 0, 0], HULL_HI = [40, 30, 20];
const POCK_LO = [10, 9, 10], POCK_HI = [30, 21, 20];
async function simplePocket() {
  const cut = await T.ops.subtract(E.rawBoxSoup(HULL_LO, HULL_HI), E.rawBoxSoup([10, 9, 10], [30, 21, 25]));
  if (!cut.ok) throw new Error('fixture build failed: ' + cut.reason);
  return cut.soup;
}

/* A prism whose top face has five convex corners and one REFLEX one. The
   smallest shape that asks the outer engine a concave question. */
function lPrism(z0, z1) {
  const poly = [[0, 0], [40, 0], [40, 12], [16, 12], [16, 30], [0, 30]];
  const t = [], push = (a, b, c) => t.push(...a, ...b, ...c);
  for (const tri of E.rawEarClip2D(poly.map(p => [p[0], p[1]]))) {
    const A = poly[tri[0]], B = poly[tri[1]], C = poly[tri[2]];
    push([A[0], A[1], z1], [B[0], B[1], z1], [C[0], C[1], z1]);
    push([A[0], A[1], z0], [C[0], C[1], z0], [B[0], B[1], z0]);
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    push([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]);
    push([a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  }
  return { soup: new Float32Array(t), poly };
}

/* ------------------------------------------------------------ probe points */

const [px0, py0, pz0] = POCK_LO, [px1, py1, pz1] = POCK_HI;
const floorCorners = [[px0, py0], [px1, py0], [px1, py1], [px0, py1]];
const toVoid = (x, y) => [x === px0 ? 1 : -1, y === py0 ? 1 : -1];

const probePocket = s => ({
  /* concave: floor meets two walls */
  floorVertex: floorCorners.map(([x, y]) => {
    const [sx, sy] = toVoid(x, y);
    return T.fillDepth(s, [x, y, pz0], T.norm([sx, sy, 1]));
  }),
  /* concave: floor meets one wall, at the middle of that edge */
  floorEdge: [[[(px0 + px1) / 2, py0], [0, 1, 1]], [[(px0 + px1) / 2, py1], [0, -1, 1]],
              [[px0, (py0 + py1) / 2], [1, 0, 1]], [[px1, (py0 + py1) / 2], [-1, 0, 1]]]
    .map(([p, d]) => T.fillDepth(s, [p[0], p[1], pz0], T.norm(d))),
  /* concave: wall meets wall, halfway up - corners8 leaves this sharp */
  wallEdge: floorCorners.map(([x, y]) => {
    const [sx, sy] = toVoid(x, y);
    return T.fillDepth(s, [x, y, (pz0 + pz1) / 2], T.norm([sx, sy, 0]));
  }),
  /* CONVEX: the lid rim, where the painted top face meets the pocket wall */
  rim: [[[(px0 + px1) / 2, py0], [0, -1, -1]], [[(px0 + px1) / 2, py1], [0, 1, -1]],
        [[px0, (py0 + py1) / 2], [-1, 0, -1]], [[px1, (py0 + py1) / 2], [1, 0, -1]]]
    .map(([p, d]) => T.biteDepth(s, [p[0], p[1], pz1], T.norm(d))),
  /* CONVEX: the hull's own top corners - this bake must not touch them */
  hullTop: [[0, 0], [40, 0], [40, 30], [0, 30]].map(([x, y]) =>
    T.biteDepth(s, [x, y, 20], T.norm([x === 0 ? 1 : -1, y === 0 ? 1 : -1, -1])))
});
const fmt = a => a.map(x => (x === Infinity ? '   inf' : x.toFixed(4))).join('  ');
const all0 = a => a.every(x => x === 0);
const allNear = (a, want, tol) => a.every(x => Math.abs(x - want) <= tol);

/* -------------------------------------------------------------------- main */

(async function main() {
  const base = await simplePocket();
  const brick = E.rawPocketBrick(base);

  console.log('== probe calibration (a broken probe must fail here, not pass everything) ==');
  {
    const box = E.rawBoxSoup([0, 0, 0], [10, 10, 10]);
    T.near('unit box volume', IC.NSO_insideVolume(box), 1000, 1e-6, 'mm3');
    T.check('centre reads inside', T.inside(box, [5, 5, 5]));
    T.check('outside reads outside', !T.inside(box, [5, 5, 15]));
    T.near('bite at an untouched convex corner', T.biteDepth(box, [0, 0, 0], [1, 1, 1]), 0, 1e-9);
    T.near('bite at an untouched convex edge', T.biteDepth(box, [0, 0, 5], [1, 1, 0]), 0, 1e-9);
    /* A sphere-cut corner: centre Rc in from all three planes, radius Rc*sqrt(2),
       so the apex-to-surface distance along the diagonal is Rc*(sqrt3 - sqrt2). */
    const ball = E.rawVertexBallOnly(E.rawBoxSoup([0, 0, 0], [20, 20, 20]), 2, false, 2.0, { minTurnDeg: 25 });
    T.near('bite at a corners5 vertex matches Rc(sqrt3-sqrt2)',
           T.biteDepth(ball, [0, 0, 20], T.norm([1, 1, -1])), 2 * (Math.sqrt(3) - Math.sqrt(2)), 2e-3);
  }

  console.log('\n== 1. what the outer setback assumes about convexity ==');
  {
    /* 1a. It cannot even be pointed at a pocket face: softenSelectedFace
       asserts the picked plane is the outer plane on that axis. */
    for (const [what, a, keepMin, plane] of [
      ['pocket floor z=10', 2, true, 10], ['pocket floor z=10 (max side)', 2, false, 10],
      ['pocket wall x=10', 0, true, 10], ['pocket wall x=30', 0, false, 30]]) {
      let msg = 'ACCEPTED';
      try { E.softenSelectedFace(base, a, keepMin, R, 'cornersedges', plane); }
      catch (e) { msg = e.message; }
      T.check('setback refuses ' + what, msg === 'clicked face is not the outer plane on that axis', '(' + msg + ')');
    }
    /* 1b. Handed a concave corner directly, it drops it and then refuses the
       whole face - so the treatment is all-or-nothing on convexity. */
    const L = lPrism(0, 20);
    let msg = 'ACCEPTED';
    try { E.rawVertexBallCorners(L.soup, 2, false, R, { minTurnDeg: 25 }); }
    catch (e) { msg = e.message; }
    T.check('setback refuses a face with one reflex corner',
            /needs all 6 corners of this face free - 1 /.test(msg), '(' + msg + ')');
    /* 1c. Its two-edge nature, stated as a number: on a convex vertex the
       blend closes to a point on the depth edge, which stays sharp. */
    const cube = E.rawBoxSoup([0, 0, 0], [20, 20, 20]);
    const sb = E.rawVertexBallCorners(cube, 2, false, R, { minTurnDeg: 25 });
    const topEdgeBite = T.biteDepth(sb, [0, 10, 20], T.norm([1, 0, -1]));   /* a treated face edge */
    const depthEdgeBite = T.biteDepth(sb, [0, 0, 10], T.norm([1, 1, 0]));   /* the depth edge, untreated */
    T.check('setback rounds the clicked face\'s own perimeter edge', topEdgeBite > 0.1,
            '(bite ' + topEdgeBite.toFixed(4) + 'mm)');
    T.near('setback leaves the depth edge sharp', depthEdgeBite, 0, 1e-9);
  }

  console.log('\n== 2. the bake on a synthetic pocket ==');
  const deps = { engine: E.rawVertexBallCorners, boxSoup: E.rawBoxSoup };
  let baked = null;
  {
    const b0 = probePocket(base);
    console.log('  before: tris ' + (base.length / 9) + '  vol ' + IC.NSO_insideVolume(base).toFixed(3));
    console.log('          floor vertices ' + fmt(b0.floorVertex) + ' | floor edges ' + fmt(b0.floorEdge));
    console.log('          wall edges     ' + fmt(b0.wallEdge) + ' | rim ' + fmt(b0.rim));
    T.check('fixture starts with every pocket feature sharp',
            all0(b0.floorVertex) && all0(b0.floorEdge) && all0(b0.wallEdge) && all0(b0.rim));

    const res = await IC.NSO_insideCornersBake(base, brick, R, deps, T.ops);
    T.check('bake succeeds', res.ok, res.ok ? '' : '(' + res.reason + ')');
    if (!res.ok) { process.exit(T.summary() ? 0 : 1); }
    baked = res.soup;
    const st = res.stats, p = probePocket(baked);
    console.log('  after:  tris ' + st.trisBefore + ' -> ' + st.trisAfter + ' (plug ' + st.plugTris + ')' +
                '  vol ' + st.volumeBefore.toFixed(3) + ' -> ' + st.volumeAfter.toFixed(3) +
                ' (+' + st.volumeAdded.toFixed(3) + ' mm3)');
    console.log('          floor vertices ' + fmt(p.floorVertex) + ' | floor edges ' + fmt(p.floorEdge));
    console.log('          wall edges     ' + fmt(p.wallEdge) + ' | rim ' + fmt(p.rim));
    console.log('  status: ' + IC.NSO_insideCornersStatus(st));

    /* The four numbers the ticket turns on. */
    T.check('all 4 pocket-floor vertices genuinely round',
            p.floorVertex.every(x => x > 0.5) && allNear(p.floorVertex, p.floorVertex[0], 5e-3),
            '(fill ' + fmt(p.floorVertex) + ')');
    /* The floor edges carry the band: a radius-R cylinder tangent to floor and
       wall, so the apex-to-surface distance along the 45 degree bisector is
       exactly R*(sqrt2 - 1). */
    for (let i = 0; i < 4; i++)
      T.near('floor edge ' + i + ' carries the R=' + R + ' band', p.floorEdge[i], R * (Math.SQRT2 - 1), 5e-3);
    T.check('all 4 vertical wall edges stay square', all0(p.wallEdge), '(fill ' + fmt(p.wallEdge) + ')');
    T.check('THE LID RIM STAYS SHARP', all0(p.rim), '(bite ' + fmt(p.rim) + ')');
    T.check('the hull is untouched', all0(p.hullTop), '(bite ' + fmt(p.hullTop) + ')');
    T.check('rounding a concave corner added material', st.volumeAdded > 0,
            '(' + st.volumeAdded.toFixed(3) + ' mm3)');

    /* Topology, on directed edges so a backwards-wound face cannot hide. */
    const eb = st.edgesBefore, ea = st.edgesAfter;
    T.check('watertight: open edges', ea.open === 0 && eb.open === 0, '(' + eb.open + ' -> ' + ea.open + ')');
    T.check('watertight: non-manifold edges', ea.nm === 0 && eb.nm === 0, '(' + eb.nm + ' -> ' + ea.nm + ')');
    T.check('winding: no backwards-wound faces', ea.stacked === 0, '(' + eb.stacked + ' -> ' + ea.stacked + ')');

    T.writeSTL(base, path.join(OUT, 'pocket-before.stl'));
    T.writeSTL(baked, path.join(OUT, 'pocket-inside-corners8.stl'));
    console.log('  wrote ' + path.relative(T.REPO, OUT) + '/pocket-inside-corners8.stl' +
                '  (self-intersection: python3 tools/mesh_validate.py on it)');
  }

  console.log('\n== 2b. refusals are refusals, and leave the piece alone ==');
  {
    const tooBig = await IC.NSO_insideCornersBake(base, brick, 40, deps, T.ops);
    T.check('an R larger than the pocket is clamped or refused, never silently wrong',
            !tooBig.ok || tooBig.stats.clamped,
            tooBig.ok ? '(clamped to ' + tooBig.stats.radius.toFixed(2) + ')' : '(' + tooBig.reason + ')');
    const notAPocket = await IC.NSO_insideCornersBake(base, { nope: true }, R, deps, T.ops);
    T.check('a shape this cannot read is refused', !notAPocket.ok, '(' + notAPocket.reason + ')');
    const noKernel = await IC.NSO_insideCornersBake(base, brick, R, deps, null);
    T.check('no kernel is refused, not crashed', !noKernel.ok, '(' + noKernel.reason + ')');
  }

  console.log('\n== 2d. other pocket shapes ==');
  {
    /* A pocket is only "simple" in one orientation. These vary the mouth axis
       and side, the cross-section, and the count, because the plug is pushed
       along whichever axis the pocket opens on and the floor is whichever end
       is still inside the hull - a sign slip there would pass the +Z case and
       round the rim on every other one. */
    const cases = [
      /* pocket [0,9,5]-[16,21,15], floor at x=16, mouth on the hull's x=0 face.
         vert: the floor vertex at (16,9,5), stepping into the cavity.
         wall: the middle of a wall-meets-wall edge, which must stay square.
         rim:  the middle of the hull-face-meets-wall line, stepping into the
               material - it must stay sharp. */
      { name: 'opens through -X', hull: [[0,0,0],[40,30,20]], cut: [[-5,9,5],[16,21,15]],
        axis: 0, side: 0, R: 2.0,
        vert: [[16, 9, 5], [-1, 1, 1]], wall: [[8, 9, 5], [0, 1, 1]],
        rim: [[0, 9, 10], [1, -1, 0]] },
      /* pocket [12,14,4]-[28,30,16], floor at y=14, mouth on the hull's y=30 face. */
      { name: 'opens through +Y', hull: [[0,0,0],[40,30,20]], cut: [[12,14,4],[28,35,16]],
        axis: 1, side: 1, R: 1.5,
        vert: [[12, 14, 4], [1, 1, 1]], wall: [[12, 20, 4], [1, 0, 1]],
        rim: [[12, 30, 10], [-1, -1, 0]] }
    ];
    for (const c of cases) {
      const made = await T.ops.subtract(E.rawBoxSoup(c.hull[0], c.hull[1]), E.rawBoxSoup(c.cut[0], c.cut[1]));
      if (!made.ok) { T.check(c.name + ': fixture builds', false, '(' + made.reason + ')'); continue; }
      const bk = E.rawPocketBrick(made.soup);
      T.check(c.name + ': read as a pocket brick on the right axis/side',
              !!bk && bk.mouthAxis === c.axis && bk.mouthSide === c.side,
              bk ? '(axis ' + bk.mouthAxis + ', side ' + bk.mouthSide + ')' : '(not a brick)');
      if (!bk) continue;
      const res = await IC.NSO_insideCornersBake(made.soup, bk, c.R, deps, T.ops);
      T.check(c.name + ': bake succeeds', res.ok, res.ok ? '' : '(' + res.reason + ')');
      if (!res.ok) continue;
      const s = res.soup;
      /* floor vertex rounds, wall edge stays square, rim stays sharp - the same
         three numbers as the +Z case, read on this pocket's own geometry. */
      const vFill = T.fillDepth(s, c.vert[0], T.norm(c.vert[1]));
      const wFill = T.fillDepth(s, c.wall[0], T.norm(c.wall[1]));
      const rBite = T.biteDepth(s, c.rim[0], T.norm(c.rim[1]));
      console.log('  ' + c.name + ' (R=' + c.R + '): floor vertex fill ' + vFill.toFixed(4) +
                  ', wall edge fill ' + wFill.toFixed(4) + ', rim bite ' + rBite.toFixed(4) +
                  ', +' + res.stats.volumeAdded.toFixed(3) + ' mm3');
      T.check(c.name + ': floor vertex rounds', vFill > 0.3, '(fill ' + vFill.toFixed(4) + ')');
      T.check(c.name + ': wall edge stays square', wFill === 0, '(fill ' + wFill.toFixed(4) + ')');
      T.check(c.name + ': LID RIM STAYS SHARP', rBite === 0, '(bite ' + rBite.toFixed(4) + ')');
      T.check(c.name + ': material added, not removed', res.stats.volumeAdded > 0);
      T.check(c.name + ': still watertight and consistently wound',
              res.stats.edgesAfter.open === 0 && res.stats.edgesAfter.nm === 0 &&
              res.stats.edgesAfter.stacked === 0, JSON.stringify(res.stats.edgesAfter));
      T.writeSTL(s, path.join(OUT, 'pocket-' + c.name.replace(/[^a-zA-Z0-9]+/g, '-') + '.stl'));
    }

    /* A pocket narrower than twice the asked radius: the clamp has to bite and
       say so, rather than produce a blend wider than the cavity. */
    const narrow = await T.ops.subtract(E.rawBoxSoup([0,0,0],[40,30,20]), E.rawBoxSoup([16,13,12],[24,17,25]));
    const nb = narrow.ok ? E.rawPocketBrick(narrow.soup) : null;
    T.check('a 8x4mm pocket is still read as a brick', !!nb);
    if (nb) {
      const res = await IC.NSO_insideCornersBake(narrow.soup, nb, 5.0, deps, T.ops);
      T.check('R=5 in a 4mm-wide pocket is clamped, not forced',
              !res.ok || (res.stats.clamped && res.stats.radius <= 0.45 * 4 + 1e-9),
              res.ok ? '(clamped ' + res.stats.requested + ' -> ' + res.stats.radius.toFixed(2) + 'mm)'
                     : '(' + res.reason + ')');
      if (res.ok) {
        T.check('the clamped bake is still watertight and wound right',
                res.stats.edgesAfter.open === 0 && res.stats.edgesAfter.nm === 0 &&
                res.stats.edgesAfter.stacked === 0, JSON.stringify(res.stats.edgesAfter));
        T.writeSTL(res.soup, path.join(OUT, 'pocket-narrow-clamped.stl'));
      }
    }

    /* Two pockets on one piece. rawPocketBrick is a one-pocket shape check, so
       this goes through rawBoxPockets - the router the shipped
       wrapPocketsInPlace uses - and each pocket is baked in turn.

       Recorded here rather than asserted away: rawBoxPockets groups faces by
       PLANE (axis, sign, offset), not by connectivity, so two pockets that
       share any face plane merge into one cluster that is not a box and BOTH
       are dropped. Measured on a 60x30x20 plate with two 18x12x10 pockets:
       floors and walls coplanar -> 0 found; floors 2mm apart but walls still
       coplanar -> 0 found; every face plane distinct -> 2 found. Two identical
       bays side by side at one depth is the common case and it finds neither.
       That is shipped inside1 code, not this module, and it wants its own
       scoped pass - this suite pins the behaviour so a fix trips it. */
    const twoPocket = async (cuts) => {
      let s = E.rawBoxSoup([0, 0, 0], [60, 30, 20]);
      for (const c of cuts) {
        const r = await T.ops.subtract(s, E.rawBoxSoup(c[0], c[1]));
        if (!r.ok) return null;
        s = r.soup;
      }
      return s;
    };
    const shared = await twoPocket([[[6,9,10],[24,21,25]], [[36,9,10],[54,21,25]]]);
    const distinct = await twoPocket([[[6,9,10],[24,21,25]], [[36,6,12],[54,24,25]]]);
    T.check('two-pocket fixtures build', !!shared && !!distinct);
    if (shared && distinct) {
      const nShared = E.rawBoxPockets(shared).length, pk = E.rawBoxPockets(distinct);
      console.log('  rawBoxPockets: coplanar-faced pair -> ' + nShared +
                  ' found; all-planes-distinct pair -> ' + pk.length + ' found');
      T.check('KNOWN (shipped inside1): coplanar pocket faces make rawBoxPockets find neither',
              nShared === 0, '(found ' + nShared + ' - if this is now 2, the router was fixed)');
      T.check('rawBoxPockets finds both when no face plane is shared', pk.length === 2);
      T.check('rawPocketBrick correctly refuses a two-pocket piece', !E.rawPocketBrick(distinct));
      let soup = distinct, okAll = pk.length === 2, added = 0;
      for (const p of pk) {
        const res = await IC.NSO_insideCornersBake(soup, p, 2.0, deps, T.ops);
        if (!res.ok) { okAll = false; console.log('    pocket bake refused: ' + res.reason); break; }
        soup = res.soup; added += res.stats.volumeAdded;
      }
      T.check('both pockets bake in turn', okAll, '(+' + added.toFixed(3) + ' mm3 total)');
      if (okAll) {
        const sc = IC.NSO_insideEdgeScore(soup);
        T.check('two-pocket result is watertight and consistently wound',
                sc.open === 0 && sc.nm === 0 && sc.stacked === 0, JSON.stringify(sc));
        for (const [x, y, sx, sy] of [[6, 9, 1, 1], [54, 24, -1, -1]])
          T.check('pocket vertex at (' + x + ',' + y + ') rounds',
                  T.fillDepth(soup, [x, y, x < 30 ? 10 : 12], T.norm([sx, sy, 1])) > 0.5);
        T.writeSTL(soup, path.join(OUT, 'pocket-two.stl'));
      }
    }
  }

  console.log('\n== 2c. the directed-edge gate sees what nsoSealScore cannot ==');
  {
    /* The corners-only engine's plug bake is 0 open / 0 non-manifold by the
       app's own counter and is still rejected by the kernel. Recording the
       real defect here so a future change to either engine trips this. */
    const plo = brick.plo.slice(), phi = brick.phi.slice(), over = IC.NSO_insideOverreach(R);
    if (brick.mouthSide) phi[brick.mouthAxis] += over; else plo[brick.mouthAxis] -= over;
    const plugBox = E.rawBoxSoup(plo, phi);
    const c5 = E.rawVertexBallOnly(plugBox, brick.mouthAxis, !!brick.mouthSide, R, { minTurnDeg: 25 });
    const c8 = E.rawVertexBallCorners(plugBox, brick.mouthAxis, !!brick.mouthSide, R, { minTurnDeg: 25 });
    const s5 = E.nsoSealScore(c5), d5 = IC.NSO_insideEdgeScore(c5);
    const d8 = IC.NSO_insideEdgeScore(c8);
    console.log('  rawVertexBallOnly plug:    nsoSealScore ' + JSON.stringify(s5) +
                '   directed ' + JSON.stringify(d5));
    console.log('  rawVertexBallCorners plug: directed ' + JSON.stringify(d8));
    T.check('nsoSealScore calls the corners5 plug clean', s5.open === 0 && s5.nm === 0);
    T.check('the directed-edge score does not', d5.stacked > 0, '(backwards-wound ' + d5.stacked + ')');
    T.check('the corners8 plug is clean on both', d8.open === 0 && d8.nm === 0 && d8.stacked === 0);
    const viaC5 = await IC.NSO_insideCornersBake(base, brick, R,
                    { engine: E.rawVertexBallOnly, boxSoup: E.rawBoxSoup }, T.ops);
    T.check('so a corners5 plug is refused with a real reason, not "Not manifold"',
            !viaC5.ok && /backwards-wound/.test(viaC5.reason), '(' + (viaC5.reason || 'accepted') + ')');
  }

  console.log('\n== 3. no regression on the shipped inside3 bake path ==');
  {
    /* 3a. Pocket detection still reads the same piece the same way. */
    T.check('rawPocketBrick still finds the pocket', !!brick &&
            brick.plo.join() === POCK_LO.join() && brick.phi.join() === POCK_HI.join() &&
            brick.mouthAxis === 2 && brick.mouthSide === 1);
    const pockets = E.rawBoxPockets(base);
    T.check('rawBoxPockets still finds 1 pocket with its 5 faces',
            pockets.length === 1 && pockets[0].faces.length === 5);

    /* 3b. The face-selection report - which of the 11 faces bake, which stay
       square - is unchanged by this module existing. brickSkipLists is the
       shipped router; it is called here exactly as wrapPocketBrickRun calls it. */
    const skipLists = (faceList) => {
      const span = Math.max(brick.ext[0], brick.ext[1], brick.ext[2]);
      const tol = Math.max(0.05, 0.005 * span);
      const hull = [[false,false],[false,false],[false,false]];
      const pocket = [[false,false],[false,false],[false,false]];
      let nHull = 0, nPocket = 0;
      for (const e of faceList) {
        const a = e.axisIdx, k = !!e.keepMin, at = k ? -e.d : e.d;
        const dHull = Math.abs(at - (k ? brick.lo[a] : brick.hi[a]));
        const dPocket = Math.abs(at - (k ? brick.phi[a] : brick.plo[a]));
        if (dHull <= dPocket && dHull < tol) { hull[a][k ? 0 : 1] = true; nHull++; continue; }
        if (E.rawHasPlane(base, a, k, at)) { pocket[a][k ? 1 : 0] = true; nPocket++; continue; }
        return { bad: e, at };
      }
      return { hull, pocket, nHull, nPocket };
    };
    const CASES = [
      ['nothing painted', [], 6, 5],
      ['hull top painted', [{ axisIdx: 2, keepMin: false, d: 20 }], 5, 5],
      ['pocket wall x=10 painted', [{ axisIdx: 0, keepMin: false, d: 10, inner: true }], 6, 4],
      ['both painted', [{ axisIdx: 2, keepMin: false, d: 20 },
                        { axisIdx: 0, keepMin: false, d: 10, inner: true }], 5, 4],
      ['pocket floor painted', [{ axisIdx: 2, keepMin: false, d: 10, inner: true }], 6, 4]
    ];
    for (const [label, list, wantHull, wantPocket] of CASES) {
      const s = skipLists(list);
      T.check('inside3 reports ' + label,
              !s.bad && 6 - s.nHull === wantHull && 5 - s.nPocket === wantPocket,
              '(hull ' + (6 - s.nHull) + '/6, pocket ' + (5 - s.nPocket) + '/5, ' +
              (11 - s.nHull - s.nPocket) + ' of 11 baked)');
    }
    const gone = skipLists([{ axisIdx: 2, keepMin: false, d: 13.7, inner: true }]);
    T.check('inside3 still refuses a plane the soup does not carry', !!gone.bad);

    /* 3c. The shipped whole-piece wrap still produces what it produced, and
       this bake is a different shape from either of its modes - an additional
       pass, not a competing one. */
    const wrap = async (mode, skip) => {
      skip = skip || { hull: [[false,false],[false,false],[false,false]],
                       pocket: [[false,false],[false,false],[false,false]] };
      const hull = E.rawWrapSolid(E.rawBoxSoup(brick.lo, brick.hi), R, mode, skip.hull);
      const plo = brick.plo.slice(), phi = brick.phi.slice(), over = 2 * R + 1;
      if (brick.mouthSide) phi[brick.mouthAxis] += over; else plo[brick.mouthAxis] -= over;
      const pSkip = [skip.pocket[0].slice(), skip.pocket[1].slice(), skip.pocket[2].slice()];
      pSkip[brick.mouthAxis][brick.mouthSide ? 1 : 0] = true;
      const plug = E.rawWrapSolid(E.rawBoxSoup(plo, phi), R, mode, pSkip);
      return T.ops.subtract(hull, plug);
    };
    const wc = await wrap('corners'), wf = await wrap('fillet');
    T.check('shipped wrap mode=corners still bakes', wc.ok);
    T.check('shipped wrap mode=fillet still bakes', wf.ok);
    if (wc.ok && wf.ok) {
      const pc = probePocket(wc.soup), pf = probePocket(wf.soup), pi = probePocket(baked);
      console.log('  pocket floor vertices  corners ' + fmt(pc.floorVertex).slice(0, 6) +
                  ' | fillet ' + fmt(pf.floorVertex).slice(0, 6) +
                  ' | this module ' + fmt(pi.floorVertex).slice(0, 6));
      console.log('  pocket wall edges      corners ' + fmt(pc.wallEdge).slice(0, 6) +
                  ' | fillet ' + fmt(pf.wallEdge).slice(0, 6) +
                  ' | this module ' + fmt(pi.wallEdge).slice(0, 6));
      T.check('mode=corners still rounds pocket vertices and leaves every pocket edge square',
              pc.floorVertex.every(x => x > 0.5) && all0(pc.floorEdge) && all0(pc.wallEdge));
      T.check('mode=fillet still rounds every pocket edge',
              pf.floorEdge.every(x => x > 0.5) && pf.wallEdge.every(x => x > 0.5));
      T.check('this module is a third shape, not a duplicate of either',
              pi.floorEdge.every(x => x > 0.5) && all0(pi.wallEdge));
      T.check('all three leave the lid rim sharp', all0(pc.rim) && all0(pf.rim) && all0(pi.rim));
      T.writeSTL(wc.soup, path.join(OUT, 'pocket-wrap-corners.stl'));
      T.writeSTL(wf.soup, path.join(OUT, 'pocket-wrap-fillet.stl'));
    }

    /* 3c-ii. The paint drives the GEOMETRY, not just the status line. Painting
       the pocket wall at x=10 must take exactly the two floor vertices on that
       wall back to sharp and leave the other two rounded - the both-faces rule
       as a number rather than a claim. */
    {
      const painted = await wrap('corners', {
        hull: [[false,false],[false,false],[false,false]],
        pocket: [[true,false],[false,false],[false,false]]   /* plug's low-X face */
      });
      T.check('shipped wrap still bakes with a pocket wall painted out', painted.ok,
              painted.ok ? '' : '(' + painted.reason + ')');
      if (painted.ok) {
        const p = probePocket(painted.soup);
        /* floorCorners order: (x0,y0) (x1,y0) (x1,y1) (x0,y1) - index 0 and 3
           are the two on the x=10 wall. */
        console.log('  pocket wall x=10 painted -> floor vertices ' + fmt(p.floorVertex));
        T.check('painting a pocket wall leaves ITS two floor vertices sharp',
                p.floorVertex[0] === 0 && p.floorVertex[3] === 0);
        T.check('and leaves the other two rounded',
                p.floorVertex[1] > 0.5 && p.floorVertex[2] > 0.5);
        T.check('with the lid rim still sharp', all0(p.rim));
      }
    }

    /* 3d. Recorded, not asserted-away: rawWrapSolid has no setback branch, so
       'cornersedges' and 'fillet' are the same geometry in the wrap path even
       though they are different engines in the per-face path. */
    const wce = await wrap('cornersedges');
    T.check("rawWrapSolid still maps 'cornersedges' onto the same geometry as 'fillet'",
            wce.ok && wf.ok && wce.soup.length === wf.soup.length &&
            Math.abs(IC.NSO_insideVolume(wce.soup) - IC.NSO_insideVolume(wf.soup)) < 1e-6,
            '(tris ' + (wce.ok ? wce.soup.length / 9 : '-') + ' vs ' + (wf.ok ? wf.soup.length / 9 : '-') + ')');
  }

  process.exit(T.summary() ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });

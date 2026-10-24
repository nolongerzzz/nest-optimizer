#!/usr/bin/env node
// SHELLS, NOT A WELD (npm run support:shells). The Supports card no longer
// unions a support: NSO_SupportGridpack.shells() hands back every part - each
// column, foot, stub and each layer of the interface sheet - as its own closed
// shell, one support object holding the trunks whose feet touch and the sheet
// over their tips. A slicer fills an object's overlapping shells as one, so
// the printed layers must be the welded support's. This holds it, piece by
// piece, area by area, at the card's defaults (angle 35, Tree, 1.2 mm, rest
// off, the sheet on):
//
//   1. THE SAME SUPPORTS. shells() groups the parts into the solids weld()
//      would have made: as many, each holding the same spots and landing the
//      same way, each sheet with the same trunks.
//   2. THE SAME LAYERS. Both are cut by NSO's own slicer (nso_slicer.js) at
//      every 0.2 mm layer of a 0.4 mm nozzle: sliceMesh's exact sections,
//      filled with the Positive rule (the SECTION), and that with the
//      slicer's own closing (0.049 mm) and resolution (0.012 mm) after (the
//      REGION it prints). Every section has the same islands and holes, and
//      section and region each differ, layer by layer, by no more than
//      XOR_MM2 + XOR_WIDTH_MM x the layer's perimeter - two microns' width, a
//      sixth of the slicer's own resolution. The difference is the WELD's:
//      every union pre-welds its inputs (weldSoupVerts at NSO_weldEpsFor, a
//      third of the shortest edge), so the welded solid sits a micron or so
//      off the parts it was made of - measured, 1.42 um on average over the
//      outline of the wedge's foot layer, under 0.7 um everywhere else; the
//      shells are the parts as built. A VOID SMALLER THAN ONE BEAD'S
//      CROSS-SECTION (VOID_MM2, 0.08 mm2: 0.42 x 0.2) is not counted as a
//      hole: the weld closes such slivers where two parts only graze (a
//      stair's own tree merges through a crowd - docs/SUPPORT-INTERFACE.md
//      section 7 - and on the tilted box one leg grazes a member it does not
//      join: z 6.10, 0.009 mm2), and no slicer lays a line round one; its
//      area still counts in the difference. A region whose islands
//      differ is named: the closing joins two islands less than 0.098 mm
//      apart, and where the gap is within that micron of 0.098 the weld's
//      copy and the exact one fall either side of it.
//   3. THE SAME PRINT. The whole slice of each support object (walls,
//      infill, solid layers: sliceObjects): every layer the same wall count,
//      and the whole support's extruded length within EXTRUDE_TOTAL_REL. Not
//      layer by layer: the slicer's offsets and its narrow-strip and
//      small-island rules are thresholds, and a region a micron off moves a
//      wall or a strip of solid infill across one. The CONTROL says how much:
//      the weld against itself with its parts unioned in another order. The
//      layers that differ by over EXTRUDE_REL are counted for both, side by
//      side. The sheet's lines are the most of it: each is one bead wide
//      (0.42 mm, the wall's own width), so its wall is the region offset in by
//      exactly half its width - zero width - and Clipper keeps or drops that
//      sliver on the polygon's vertices, not on its shape (on tall: the same
//      region, the same 23 / 24 parts at -0.2095 and none at -0.2105, both
//      ways; 38 mm of wall one way at the top layer). The control welds the
//      same sheet both times, so it does not see it. On every support of at most FULL_SLICE_TRIS welded triangles: NSO's
//      slicer takes about 4 min a mesh on the clamp's 41-trunk area 2 in node,
//      and longer on its 126-trunk area 1, which 2. holds layer by layer.
//   4. Every shell is closed (no open or non-manifold edge on its own).
//   5. THE FEET ACROSS AREAS, as the card builds them (footPads 'shared',
//      shells, shareFeet) on every piece of more than one area: every cluster
//      of feet on one pad whatever area it holds, and no two supports' first
//      layers within 0.1 mm of each other - the slicer's sections at the
//      first layer, grown by half that, do not meet (the layer-1 path
//      conflict Bambu Studio reported between two supports of the coupon).
//
// The timing line is the card's build without the weld beside it with one.
//
// FIVE STEPS, ONE FILE. `--only=` runs one slice of the checks below and no
// flag runs them all. CI runs five: support:shells-coupon, -fixtures, and the
// clamp in three - the clamp's slices alone were most of the old support:shells'
// ~1,229 s, and a step is the smallest thing a shard can be packed with.
// The clamp has four areas (measured locally, 279 s: area 1 132 s, area 2 ~99 s,
// areas 3-4 ~6 s, the feet across areas 42 s), so `clamp-a1` is its area 1,
// `clamp-a234` its other three, and `clamp-feet` the one check (5.) that needs
// every area's plan and none of their welds or slices; `clamp` is the three
// together, by hand. The steps are a partition of the checks (asserted below:
// STEPS), so the five hold exactly the checks of the one.
//
// THE CONTROL (3.) - the weld again with its parts unioned in another order,
// sliced - only feeds a count in the detail text; nothing asserts it. It runs
// on the `fixtures` pieces, where it is cheap, or anywhere with `--control`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const SL = require('../nso_slicer.js');
const slicePool = require('./nso_slice_pool.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
/* the card's build worker's own list (app-supports-card.js ENGINE) */
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, GP = ctx.NSO_SupportGridpack;
const CARD = { skipList: [], angleDeg: 35, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
/* app-supports-card.js PARTS_OPTS, but for the feet: the card builds every
   trunk on its foot with no pad (footPads 'shared') and draws the pads over
   every area at once (shareFeet); here each area draws its own pads, so its
   shells and its weld hold the same parts. The shared pads are held below
   (5. THE FEET ACROSS AREAS). */
const PARTS = { interface: true, foldSheets: false };
const VOID_MM2 = 0.08;   /* one bead's cross-section (0.42 x 0.2 mm): a smaller void is no hole a slicer prints round (see 2) */
const XOR_MM2 = 1e-3, XOR_WIDTH_MM = 2e-3, EXTRUDE_REL = 1e-3, EXTRUDE_TOTAL_REL = 1e-2, FULL_SLICE_TRIS = 30000;

const GROUPS = ['coupon', 'clamp', 'fixtures'];
/* what each --only= runs: the group's pieces, which of a piece's areas (by index) get the checks of 1.-4., and whether 5. runs.
   5. needs every area's plan, so a step with it plans them all and builds only its own; a step without it plans only its own. */
const ALL = () => true, NONE = () => false;
const STEPS = {
  coupon: { group: 'coupon', areas: ALL, feet: true },
  clamp: { group: 'clamp', areas: ALL, feet: true },
  'clamp-a1': { group: 'clamp', areas: (i) => i === 0, feet: false },
  'clamp-a234': { group: 'clamp', areas: (i) => i > 0, feet: false },
  'clamp-feet': { group: 'clamp', areas: NONE, feet: true },
  fixtures: { group: 'fixtures', areas: ALL, feet: true }
};
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;
if (ONLY !== null && !STEPS[ONLY]) {
  console.error('nso_support_shells_check: --only=' + ONLY + ' is not one of ' + Object.keys(STEPS).join(', '));
  process.exit(2);
}
const STEP = ONLY ? STEPS[ONLY] : { group: null, areas: ALL, feet: true };
const CONTROL = process.argv.includes('--control') || !ONLY || STEP.group === 'fixtures';
/* the clamp's three steps hold every area once and the feet once (up to 64 areas) */
{
  const parts = ['clamp-a1', 'clamp-a234', 'clamp-feet'].map((k) => STEPS[k]);
  let ok = parts.filter((x) => x.feet).length === 1 && STEPS.clamp.feet;
  for (let i = 0; i < 64; i++) ok = ok && parts.filter((x) => x.areas(i)).length === 1;
  if (!ok) { console.error('nso_support_shells_check: clamp-a1, clamp-a234 and clamp-feet must hold each area and the feet exactly once'); process.exit(2); }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));
/* clamp_body standing on its 94 mm axis, as the reference was sliced (support:interface's pose) */
function standing(soup) {
  const r = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { r[i] = soup[i]; r[i + 1] = -soup[i + 2]; r[i + 2] = soup[i + 1]; }
  let mz = Infinity;
  for (let i = 2; i < r.length; i += 3) mz = Math.min(mz, r[i]);
  for (let i = 2; i < r.length; i += 3) r[i] -= mz;
  return r;
}
/* support:beacons' tilted box (support:workflow's piece A): turned 30 deg about y, lowest edge on the plate */
function tilted() {
  const T = 30 * Math.PI / 180, b = box([0, 0, 0], [40, 30, 10]), r = new Float32Array(b.length);
  for (let i = 0; i < b.length; i += 3) { r[i] = b[i] * Math.cos(T) - b[i + 2] * Math.sin(T); r[i + 1] = b[i + 1]; r[i + 2] = b[i] * Math.sin(T) + b[i + 2] * Math.cos(T); }
  let mz = Infinity;
  for (let i = 2; i < r.length; i += 3) mz = Math.min(mz, r[i]);
  for (let i = 2; i < r.length; i += 3) r[i] -= mz;
  return r;
}
const PIECES = [
  ['top_clip_x2 (the coupon)', readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl')), 'coupon'],
  ['clamp_body (standing)', standing(readSTL(path.join(ROOT, 'fixtures', 'supports', 'clamp_body.stl'))), 'clamp'],
  /* support:workflow's: many trunks on feet that touch, and 10 areas at 35 deg (25 at 60) */
  ['tilted box', tilted(), 'fixtures'],
  ['wedge (v9_mirror_factory)', readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl')), 'fixtures'],
  ['shelf', soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20])), 'fixtures'],
  ['tab', soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16])), 'fixtures'],
  ['tall', soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26])), 'fixtures']
];
if (PIECES.some((x) => !GROUPS.includes(x[2])) || GROUPS.some((g) => !PIECES.some((x) => x[2] === g))) {
  console.error('nso_support_shells_check: every piece belongs to one group and every group has a piece');
  process.exit(2);
}

/* each part's own edges: every one shared by exactly two of its triangles (exact float32 corners) */
function closedShell(soup) {
  const E = new Map(), key = (i) => soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
  for (let t = 0; t < soup.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
      E.set(ek, (E.get(ek) || 0) + 1);
    }
  }
  let bad = 0;
  E.forEach((c) => { if (c !== 2) bad++; });
  return bad;
}

/* the regions a slicer prints, layer by layer: sliceMesh's sections, Positive fill, the slicer's closing and resolution */
function regions(g, soup, planes, o) {
  const sm = SL.sliceMesh(soup, planes, o);
  const closeR = o.sliceClosingRadiusMm;
  return sm.sections.map((sec) => {
    let cs = g.of(sec.loops, 'Positive');
    const raw = cs;
    if (closeR > 0 && !g.isEmpty(cs)) cs = g.offset(g.offset(cs, closeR, 'Miter'), -closeR, 'Miter');
    return { raw: raw, cs: g.simplify(cs, o.resolutionMm), open: sec.openChains ? sec.openChains.length : 0 };
  });
}
function perimeter(g, cs) {
  let L = 0;
  for (const poly of g.polys(cs)) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}
/* islands and holes */
/* islands / holes: a hole smaller than VOID_MM2 is not counted (see 2) */
function topology(g, cs) {
  const polys = g.polys(cs);
  let outer = 0, holes = 0;
  for (const p of polys) { const a = SL.signedArea(p); if (a > 0) outer++; else if (-a >= VOID_MM2) holes++; }
  return outer + '/' + holes;
}
(async () => {
  const csg = csgContext();
  ctx.NSO_unionSoups = csg.NSO_unionSoups;
  const wasm = await SL.loadKernel({});
  const o = SL.defaultsFor(0.4);
  const T = { plan: 0, parts: 0, shells: 0, weld: 0 };
  let worstRel = 0, worstAt = '';

  const shared = [];
  for (const [name, piece, group] of PIECES) {
    if (STEP.group && group !== STEP.group) continue;
    console.log('\n=== ' + name + ' ===');
    const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: CARD.angleDeg, occluders: [] });
    if (!det.ok || !det.beaconRegions) { check(name + ': detects', false, det.reason); continue; }
    const plans = [];
    if (det.beaconRegions.length > 1) shared.push({ name, piece, plans });
    for (const rg of det.beaconRegions) {
      const areaIx = det.beaconRegions.indexOf(rg);
      const label = name + ' area ' + (rg.id + 1);
      if (!STEP.areas(areaIx) && !STEP.feet) continue;      // neither built here nor needed for 5.: not even planned
      const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
      let t = Date.now();
      const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }));
      T.plan += Date.now() - t;
      if (!p.ok) { console.log('  --    ' + label + ': the planner holds nothing here (' + p.reason + ')'); continue; }
      plans.push(p);
      if (!STEP.areas(areaIx)) continue;      // planned for 5., not built here
      t = Date.now();
      const tp = await GP.parts(p, PARTS);
      T.parts += Date.now() - t;
      if (!tp.ok) { check(label + ': builds', false, tp.reason); continue; }
      t = Date.now();
      const sh = GP.shells(p, tp);
      T.shells += Date.now() - t;
      /* weld() takes the parts as they are (it folds a sheet's layers itself) */
      t = Date.now();
      const w = await GP.weld(p, tp, {});
      T.weld += Date.now() - t;
      if (!sh.ok || !w.ok) { check(label + ': shells and weld both answer', false, (sh.reason || '') + ' / ' + (w.reason || '')); continue; }

      /* 1. the same supports */
      const sig = (x) => [x.beacons.slice().sort((a, b) => a - b).join(','), x.landing, x.sheets.slice().sort().join(',')].join('|');
      const A = sh.solids.map(sig).sort(), B = w.solids.map(sig).sort();
      check(label + ': the same supports as the weld - as many, each holding the same spots, landing the same way, with the same sheets',
        JSON.stringify(A) === JSON.stringify(B) && sh.sheetsAlone === w.sheetsAlone,
        sh.solids.length + ' object(s) of ' + sh.shells + ' shells (' + sh.soup.length / 9 + ' tris) against ' + w.solids.length +
        ' welded solid(s) (' + w.soup.length / 9 + ' tris); sheets alone ' + sh.sheetsAlone + ' / ' + w.sheetsAlone);

      /* 4. every shell closed */
      let open = 0, nShell = 0;
      tp.trunks.forEach((x) => x.parts.forEach((q) => { nShell++; if (closedShell(q.soup)) open++; }));
      check(label + ': every shell is closed on its own', open === 0, nShell + ' shells, ' + open + ' with an open or shared-by-more-than-two edge');

      /* 2. the same layers, object by object */
      const zTop = Math.max(...w.solids.map((x) => x.box.hi[2]), ...sh.solids.map((x) => x.box.hi[2]));
      const zLo = Math.min(...w.solids.map((x) => x.box.lo[2]), ...sh.solids.map((x) => x.box.lo[2]));
      const planes = SL.slicePlanes(zLo, zTop, o);
      let layers = 0, worst = { xor: 0, allow: 0, at: null }, topoBad = 0, rawBad = 0, openChains = 0, maxW = 0;
      const offending = [], flips = [];
      const g = SL.geometry(wasm);
      try {
        const bySig = new Map(w.solids.map((x) => [sig(x), x]));
        for (const s of sh.solids) {
          const ws = bySig.get(sig(s));
          if (!ws) continue;
          const RA = regions(g, s.soup, planes, o), RB = regions(g, ws.soup, planes, o);
          for (let i = 0; i < planes.length; i++) {
            openChains += RA[i].open;
            if (g.isEmpty(RA[i].cs) && g.isEmpty(RB[i].cs)) continue;
            layers++;
            const xor = g.area(g.diff(RA[i].cs, RB[i].cs)) + g.area(g.diff(RB[i].cs, RA[i].cs));
            const xr = g.area(g.diff(RA[i].raw, RB[i].raw)) + g.area(g.diff(RB[i].raw, RA[i].raw));
            const per = perimeter(g, RB[i].cs), allow = XOR_MM2 + XOR_WIDTH_MM * per;
            const ta = topology(g, RA[i].raw), tb = topology(g, RB[i].raw);
            if (xor > allow || xr > allow) rawBad++;
            if (ta !== tb) topoBad++;
            if (per > 0) maxW = Math.max(maxW, Math.max(xor, xr) / per);
            const pa = topology(g, RA[i].cs), pb = topology(g, RB[i].cs);
            if (pa !== pb && flips.length < 6) flips.push('z ' + planes[i].sliceZ.toFixed(2) + ' (' + pa + ' shells, ' + pb + ' welded)');
            if ((xor > allow || xr > allow || ta !== tb) && offending.length < 6) {
              const d = g.union(g.diff(RA[i].cs, RB[i].cs), g.diff(RB[i].cs, RA[i].cs)), pts = [].concat(...g.polys(d));
              const bx = pts.length ? [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))] : null;
              offending.push('z ' + planes[i].sliceZ.toFixed(2) + ': ' + Math.max(xor, xr).toExponential(2) + ' mm2 (allowed ' + allow.toExponential(2) +
                '), islands/holes ' + ta + ' shells, ' + tb + ' welded' + (bx ? ', at x ' + bx[0].toFixed(2) + '..' + bx[2].toFixed(2) + ' y ' + bx[1].toFixed(2) + '..' + bx[3].toFixed(2) : ''));
            }
            const area = g.area(RB[i].cs);
            if (Math.max(xor, xr) / Math.max(allow, 1e-12) > worst.xor / Math.max(worst.allow, 1e-12)) worst = { xor: Math.max(xor, xr), allow, at: planes[i].sliceZ, area };
            if (area > 0 && Math.max(xor, xr) / area > worstRel) { worstRel = Math.max(xor, xr) / area; worstAt = label + ' z ' + planes[i].sliceZ.toFixed(2); }
          }
        }
      } finally { g.free(); }
      check(label + ': every 0.2 mm layer the slicer cuts is the welded support\'s - the same section, islands and holes, and the same region to two microns',
        rawBad === 0 && topoBad === 0 && layers > 0,
        layers + ' layers; worst difference ' + worst.xor.toExponential(2) + ' mm2 against ' + worst.allow.toExponential(2) +
        ' allowed' + (worst.at != null ? ' (z ' + worst.at.toFixed(2) + ', of ' + worst.area.toFixed(2) + ' mm2)' : '') +
        ', at most ' + (maxW * 1000).toFixed(2) + ' um wide on average over a layer\'s outline; ' + rawBad + ' over, ' + topoBad +
        ' sections with other islands / holes; open chains in the shells\' sections ' + openChains +
        '; regions whose islands the closing joins differently: ' + (flips.length ? flips.join(', ') : 'none') +
        (offending.length ? '\n          ' + offending.join('\n          ') : ''));

      /* 3. the same print: the whole slice of each object */
      if (w.solids.some((x) => x.soup.length / 9 > FULL_SLICE_TRIS)) {
        console.log('  --    ' + label + ': not sliced whole (a welded support over ' + FULL_SLICE_TRIS + ' triangles: ' +
          w.solids.map((x) => x.soup.length / 9).join(', ') + ') - its layers are held above');
        continue;
      }
      /* the CONTROL: the weld again with every trunk's parts unioned in another order (the first part first,
         the rest reversed) - two welds of the same parts, a micron apart where their unions cut */
      const tpR = Object.assign({}, tp, { trunks: tp.trunks.map((x) => x.sheet != null ? x : Object.assign({}, x, { parts: [x.parts[0]].concat(x.parts.slice(1).reverse()) })) });
      const wR = CONTROL ? await GP.weld(p, tpR, {}) : null;
      /* the slices of every object - the shells, the weld, the control - side by side on workers (nso_slice_pool.js) */
      const flipsOf = (LA, LB) => { let n = 0; for (let i = 0; i < LA.length; i++) { const eb = LB[i].extruded; if (Math.abs(LA[i].extruded - eb) > EXTRUDE_REL * Math.max(eb, 1e-9)) n++; } return n; };
      let wallBad = 0, nl = 0, eA = 0, eB = 0, flipS = 0, flipC = 0, worstE = 0, sliced = true;
      const tS = Date.now();
      const jobs = [];
      for (const s of sh.solids) {
        const ws = w.solids.find((x) => sig(x) === sig(s)), wr = wR && wR.ok ? wR.solids.find((x) => sig(x) === sig(s)) : null;
        if (!ws || (CONTROL && !wr)) { sliced = false; continue; }
        jobs.push(Promise.all([slicePool.slice(s.soup), slicePool.slice(ws.soup), CONTROL ? slicePool.slice(wr.soup) : null]));
      }
      for (const [LA, LB, LC] of await Promise.all(jobs)) {
        if (!LA || !LB || (CONTROL && !LC) || LA.length !== LB.length || (CONTROL && LC.length !== LB.length)) { sliced = false; continue; }
        for (let i = 0; i < LA.length; i++) {
          if (!LA[i].areaMm2 && !LB[i].areaMm2) continue;
          nl++;
          if (LA[i].wallCount !== LB[i].wallCount) wallBad++;
          const ea = LA[i].extruded, eb = LB[i].extruded;
          eA += ea; eB += eb;
          worstE = Math.max(worstE, Math.abs(ea - eb) / Math.max(eb, 1e-9));
        }
        flipS += flipsOf(LA, LB); if (CONTROL) flipC += flipsOf(LC, LB);
      }
      const dTot = Math.abs(eA - eB) / Math.max(eB, 1e-9);
      check(label + ': sliced whole (walls, infill, solid layers), shells and weld print the same - every layer the same walls, the whole support\'s extrusion within ' + EXTRUDE_TOTAL_REL * 100 + ' %',
        sliced && nl > 0 && wallBad === 0 && dTot <= EXTRUDE_TOTAL_REL,
        nl + ' layers, ' + wallBad + ' with other walls; extruded ' + eA.toFixed(1) + ' mm against ' + eB.toFixed(1) + ' (' + (dTot * 100).toFixed(4) + ' %); ' +
        flipS + ' layers differ by over ' + EXTRUDE_REL * 100 + ' % (worst ' + (worstE * 100).toFixed(2) + ' %) - ' + (CONTROL ? flipC +
        ' between the weld and itself with its parts unioned in another order' : 'control not run (--control)') + ' (' + (Date.now() - tS) + ' ms)');
    }
  }
  /* 5. the feet across areas, as the card builds them */
  for (const S of STEP.feet ? shared : []) {
    console.log('\n=== ' + S.name + ': the feet across its ' + S.plans.length + ' areas ===');
    const builds = [];
    for (const p of S.plans) {
      const tp = await GP.parts(p, Object.assign({}, PARTS, { footPads: 'shared' }));
      if (!tp.ok) { check(S.name + ': builds with shared feet', false, tp.reason); continue; }
      builds.push({ solids: GP.shells(p, tp).solids });
    }
    const sf = GP.shareFeet(builds, S.piece, { plateZ: S.plans[0].plateZ });
    if (!sf.ok) { check(S.name + ': the shared feet', false, sf.reason); continue; }
    const g = SL.geometry(wasm);
    let touching = 0, pairs = 0;
    try {
      const plane = SL.slicePlanes(0, 0.4, o).slice(0, 1);
      const firsts = sf.objects.map((ob) => {
        const sm = SL.sliceMesh(ob.soup, plane, o);
        return g.offset(g.of(sm.sections[0].loops, 'Positive'), 0.05, 'Miter');
      });
      for (let a = 0; a < firsts.length; a++) for (let b = a + 1; b < firsts.length; b++) {
        pairs++;
        if (g.area(g.inter(firsts[a], firsts[b])) > 1e-9) touching++;
      }
    } finally { g.free(); }
    /* recounted here, not read off shareFeet's counters: the clusters from
       every area's feet (6 mm), and each in one support object - but for a
       foot the piece hems in, measured here (no point on rings just outside
       its end square stands 0.2 mm clear of the piece through the slab) */
    const objOf = {};
    sf.objects.forEach((ob, k) => ob.from.forEach((f) => { objOf[f[0] + ':' + f[1]] = k; }));
    const feet = [];
    builds.forEach((b, bi) => b.solids.forEach((sd, si) => (sd.feet || []).forEach((f) => feet.push({ obj: objOf[bi + ':' + si], c: f.c, r: f.r }))));
    const par = feet.map((f, i) => i), find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (let a = 0; a < feet.length; a++) for (let b = a + 1; b < feet.length; b++) if (Math.hypot(feet[a].c[0] - feet[b].c[0], feet[a].c[1] - feet[b].c[1]) <= 6 + 1e-9) par[find(a)] = find(b);
    const PR = ctx.NSO_Thickness.prepare(S.piece, {}), pz = S.plans[0].plateZ || 0;
    const hemmedHere = (f) => {
      const rIn = f.r * Math.SQRT1_2;
      for (let dr = 0.05; dr <= 0.2 + 1e-9; dr += 0.05) for (let k = 0; k < 36; k++) {
        const an = 2 * Math.PI * k / 36, x = f.c[0] + (rIn + dr) * Math.cos(an), y = f.c[1] + (rIn + dr) * Math.sin(an);
        let clear = true;
        for (let z = 0.02; z <= 0.4 + 1e-9 && clear; z += 0.06) {
          const q = [x, y, pz + z];
          if (PR.inside(q)) { clear = false; break; }
          const hit = PR.nearest(q, 0.2); if (hit && hit.dist < 0.2) clear = false;
        }
        if (clear) return false;
      }
      return true;
    };
    const groups = {};
    feet.forEach((f, i) => (groups[find(i)] || (groups[find(i)] = [])).push(f));
    let split = 0, hemmedN = 0;
    Object.values(groups).forEach((fs) => {
      const byObj = {};
      fs.forEach((f) => (byObj[f.obj] || (byObj[f.obj] = [])).push(f));
      const parts = Object.values(byObj).sort((u, v) => v.length - u.length);
      if (parts.length < 2) return;
      if (parts.slice(1).every((pt) => pt.every(hemmedHere))) hemmedN++; else split++;
    });
    check(S.name + ': every cluster of feet in one support, whatever area it holds (counted here); the supports on one pad are one support; no two supports\' first layers within 0.1 mm',
      split === 0 && touching === 0,
      sf.reason + '; ' + Object.keys(groups).length + ' cluster(s), ' + split + ' split, ' + hemmedN + ' with a foot the piece hems in (engine: ' + sf.clustersSplit + ' split, ' + (sf.clustersHemmed || 0) + ' hemmed); ' +
      sf.objects.map((ob) => ob.from.length + ' part(s) of ' + new Set(ob.from.map((f) => f[0])).size + ' area(s)').join(', ') +
      '; first layers within 0.1 mm: ' + touching + ' of ' + pairs + ' pair(s)');
  }
  console.log('\n  time  the card\'s build: plan ' + T.plan + ' ms, parts ' + T.parts + ' ms, then shells ' + T.shells + ' ms - where the weld was ' + T.weld + ' ms');
  console.log('  worst layer difference over its area: ' + worstRel.toExponential(2) + ' (' + worstAt + ')');
  console.log(`\n${fail ? 'FAILED' : 'PASSED'}  ${pass} of ${pass + fail}`);
  await slicePool.close();
  process.exit(fail ? 1 : 0);
})();

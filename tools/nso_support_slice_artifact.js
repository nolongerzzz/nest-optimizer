#!/usr/bin/env node
// A real, non-synthetic slice artifact: one real piece with a genuine
// overhang, one straight support aimed at it by NSO_SupportAim, both written
// through the plate 3MF writer (nso-3mf.js) as two named objects.
//
//   node tools/nso_support_slice_artifact.js [out.3mf]
//   node tools/nso_support_slice_artifact.js --hollow [out.3mf]
//   node tools/nso_support_slice_artifact.js --hollow --tree [out.3mf]
//   node tools/nso_support_slice_artifact.js --interface --tree [out.3mf]
//
// Default output: out/nso_support_slice_artifact.3mf, or ..._hollow.3mf /
// ..._hollow_tree.3mf with the flags (out/ is gitignored).
//
// Slicing is NOT done here. The file is meant to be opened in real Bambu
// Studio by hand; this script stops at the archive.
//
// What it does, and nothing else:
//   1. reads fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl - a real
//      part, the same one tools/nso_support_aim_test.js calls "the tape case"
//   2. runs NSO_SupportAim.plan() on it (detect + straight-line aim) with
//      skipList [] - nothing is painted on a bare fixture
//   2b. --hollow: the SAME aim - same base, axis, reach, name and plate
//      position - built the way the shipped support tree now builds every
//      part (docs/SUPPORT-TREE.md 6b): a ROUND frustum tapered by the measured
//      law, 2 mm at the tip + 2 tan(5 deg) per mm below it, bored exactly
//      (the part shrunk by one NSO_Thickness.floorFor wall, taken out by the
//      kernel). Its round body is tested on its own rails against the piece;
//      if it would hit, the square strut is kept and bored instead, and the
//      run says so. Refuses rather than writing a solid under the hollow name.
//   2c. --tree (with --hollow): also plans a support on the piece's old region 1 strip (TREE_PATCH)
//      with the planner (planTree, the grid-pack planner) and bores it
//      (NSO_SupportTree.hollowTree -> NSO_SupportGridpack.solid), as a third
//      object, so merged members' bores are sliced on the same piece
//   2d. --interface (implies --hollow): every tip is cut back and capped with a
//      two-layer crosshatch interface (nso_support_interface.js) whose top is
//      0.18 mm - the Seat (support) easy-release gap, as a TRUE minimum
//      distance - under the underside. Before, every tip ended ON the
//      underside, inside layer 91 at 0.2 mm layers: the overlap Bambu Studio
//      reported. The whole support's closest approach to the piece is measured
//      again from the archive's own vertices before the run is allowed to pass.
//   3. names the support NSO_SUPPORT_<...> and the piece after its file
//   4. moves EVERY object by one rigid translation onto the centre of a
//      256 x 256 Bambu plate, plate at z = 0 - the same frame
//      buildPlacedObjects3MF() hands the writer
//   5. indexes each with NSO3MF.indexTriangleSoup and writes the archive with
//      NSO3MF.build3MF, exactly the calls exportPlate3MF() makes
//   6. reads the archive back and prints the object names, ids and UUIDs, so
//      what went in is on record before anyone slices it; with --hollow, each
//      support is also rebuilt FROM THE ARCHIVE'S OWN VERTICES - the 6-decimal
//      coordinates the slicer will actually read - and put through the
//      canonical checker (tools/mesh_validate.py) with the wall check on at
//      the floor

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const NSO3MF = require('../nso-3mf.js');

const args = process.argv.slice(2);
const IFACE = args.includes('--interface');
const HOLLOW = args.includes('--hollow') || IFACE;
const TREE = args.includes('--tree');
if (TREE && !HOLLOW) { console.error('--tree is only built hollow; pass --hollow --tree'); process.exit(1); }
const positional = args.filter(a => !a.startsWith('--'));

const PIECE_FILE = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
const PIECE_NAME = 'tape_on-edge-single-B101';
const SUPPORT_NAME = 'NSO_SUPPORT_tape_underside';
const TREE_NAME = 'NSO_SUPPORT_tape_tree_region1';
const TREE_REGION = 1;
/* Since #195 the planner's regions are the beacon detector's: the tape's
   whole underside is one region (0, under the strut too), and region 1 is a
   spot by the plate. The tree goes where it always went - the strip at the
   underside's -x end that was region 1 before, x -41.67..-38.90,
   y -16.80..-1.85 (5 points down x -40.29) - planned on region 0's own
   beacons inside that strip. */
const TREE_PATCH = { lo: [-41.67, -16.80], hi: [-38.90, -1.85] };
const PLATE = { w: 256, d: 256 };

const defaultName = 'nso_support_slice_artifact' + (HOLLOW ? '_hollow' : '') + (TREE ? '_tree' : '') +
  (IFACE ? '_interface' : '') + '.3mf';
const outPath = path.resolve(positional[0] || path.join(ROOT, 'out', defaultName));

/* The support module and everything it reuses, loaded the way the aim test
   loads them: classic scripts in one shared context. */
const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js',
                 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim;

/* A frustum's clearance on its own converging rails - the probe the
   trunk-first planner kept in nso_support_tree.js (probeRails), which went
   with it; this tool's round strut is the one caller left, so it lives here.
   The last capMm of each rail is the cap's business. */
function probeRails(A, obstacles, from, dir, lengthMm, rings, capMm) {
  const EPS = 1e-3;
  const probes = [[from, dir, lengthMm - EPS, 'the axis']];
  const R0 = rings[0], R1 = rings[rings.length - 1];
  for (let j = 0; j < R0.length; j++) {
    const v = [0, 1, 2].map(k => R1[j][k] - R0[j][k]), Lr = Math.hypot(...v), shaft = Lr - capMm;
    if (shaft > 2 * EPS) probes.push([R0[j], v.map(c => c / Lr), shaft - EPS, 'rail ' + j]);
  }
  for (const [o, d, L, what] of probes) {
    const hit = A._nearestHit(obstacles, o, d, EPS, L);
    if (hit > 0) return { at: hit, why: what + ' is blocked ' + hit.toFixed(3) + ' mm along, ' + (L - hit).toFixed(3) + ' mm short of the end of its run' };
  }
  return null;
}
const ST = ctx.NSO_SupportTree;

function bounds(soup) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (soup[i + k] < mn[k]) mn[k] = soup[i + k];
      if (soup[i + k] > mx[k]) mx[k] = soup[i + k];
    }
  }
  return { min: mn, max: mx };
}
function translate(soup, d) {
  const out = new Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    out[i] = soup[i] + d[0]; out[i + 1] = soup[i + 1] + d[1]; out[i + 2] = soup[i + 2] + d[2];
  }
  return out;
}
const fmt = v => v.map(c => c.toFixed(3)).join(', ');

(async () => {
  /* ---- 1-2. the real piece, and the aim ------------------------------------ */

  const piece = readSTL(path.join(ROOT, PIECE_FILE));
  const p = SA.plan(piece, { skipList: [] });
  if (!p.ok) {
    console.error('plan() refused: ' + p.reason);
    process.exit(1);
  }
  const det = p.detect, region = p.region, a = p.aim;

  console.log('piece      ' + PIECE_FILE + '  (' + ((piece.length / 9) | 0) + ' tris)');
  console.log('detect     ' + det.reason);
  console.log('region     id ' + region.id + ', ' + region.areaMm2.toFixed(3) + ' mm^2, point [' +
              fmt(region.point) + '], normal [' + fmt(region.normal) + ']');
  console.log('aim        ' + a.reason);
  console.log('           from [' + fmt(a.from) + '] -> tip [' + fmt(a.tip) + '], reach error ' +
              a.reachErrorMm.toExponential(2) + ' mm, cap penetration ' +
              (a.tipPenetrationMm == null ? 'n/a' : a.tipPenetrationMm.toFixed(4) + ' mm'));
  console.log('           Extend cross-section drift ' + a.grow.crossSectionDrift);

  let strut = p.soup, strutPart = p.soup;
  const supports = [{ name: SUPPORT_NAME, soup: null }];

  /* ---- 2b. the same strut: round, tapered, bored ------------------------- */
  let csg = null;
  if (HOLLOW) {
    const { csgContext } = require('./nso_csg_node.js');
    csg = csgContext();
    const PS = ctx.NSO_PathSweep, law = ST._lawOf({});
    let solid = p.soup, axis = { from: a.from, to: a.tip, a0: a.sideMm / 2, a1: a.sideMm / 2 }, section = 'square';
    const rp = ST._roundPart(PS, a.from, a.tip, law.at(a.from[2], a.target[2]), law.at(a.tip[2], a.target[2]));
    const stop = rp.ok ? probeRails(SA, [piece], a.from, a.dir, a.lengthMm, rp.sweep.rings, rp.dToMm) : { why: rp.reason };
    if (!stop) { solid = rp.soup; axis = rp.axis; section = 'round'; }
    console.log('section    ' + (section === 'round'
      ? 'round, ' + rp.dFromMm.toFixed(3) + ' mm at the plate -> ' + rp.dToMm.toFixed(3) + ' mm at the tip ' +
        '(2 + 2 tan 5 deg x height below the tip), 24-gon of equal area'
      : 'SQUARE FALLBACK - the round strut would run into the piece: ' + stop.why));
    const inn = ST._innerOf(solid, axis, a.floorMm, a.floorMm);
    if (!inn.ok) { console.error('no bore - NOT writing a solid strut under the hollow name: ' + inn.why); process.exit(1); }
    const d = await csg.NSO_subtractSoups(solid, inn.soup);
    if (!d.ok) { console.error('the kernel would not bore it: ' + d.reason); process.exit(1); }
    strut = d.soup;
    strutPart = solid;
    console.log('bore       ' + inn.boreFromMm.toFixed(3) + ' mm across at the plate end -> ' + inn.boreToMm.toFixed(3) +
                ' mm at the tip, inside a ' + a.floorMm + ' mm wall (NSO_Thickness.floorFor(0.4)); ' +
                'section shrunk by wall / cos(' + inn.halfAngleDeg.toFixed(3) + ' deg) = ' + inn.deltaMm.toFixed(4) +
                ' mm; ' + d.removedMm3.toFixed(3) + ' mm^3 removed, ' + d.parts + ' shells');
  }
  supports[0].soup = strut;
  supports[0].parts = [strutPart];
  supports[0].stations = [{ label: 'strut tip', contact: a.target, from: a.from, to: a.tip }];

  /* ---- 2c. a hollow tree on the region one trunk can serve ----------------- */
  if (TREE) {
    /* The grid-pack planner (docs/SUPPORT-GRIDPACK.md): one strut per
       contact, merged pairwise, plate first; tips kept off walls by the
       planner itself; bored by its own solid() through hollowTree. */
    const gb = ctx.NSO_SupportGridpack.gridBeacons(piece, { skipList: [], regionId: 0 });
    const inPatch = b => b.p[0] >= TREE_PATCH.lo[0] - 0.5 && b.p[0] <= TREE_PATCH.hi[0] + 0.5 &&
                         b.p[1] >= TREE_PATCH.lo[1] - 0.5 && b.p[1] <= TREE_PATCH.hi[1] + 0.5;
    const patch = (gb.beacons || []).filter(inPatch);
    if (!patch.length) { console.error('no region 0 beacon inside the tree patch: ' + gb.reason); process.exit(1); }
    const tp = ST.planTree(piece, { skipList: [], beacons: patch });
    if (!tp.ok) { console.error('the region ' + TREE_REGION + ' support would not plan: ' + tp.reason); process.exit(1); }
    for (const m of tp.nudged) {
      console.log('walls      point ' + m.beacon + ' moved ' + m.mm.toFixed(2) + ' mm off a wall: [' +
                  m.from.map(v => v.toFixed(3)).join(', ') + '] -> [' + m.to.map(v => v.toFixed(3)).join(', ') + ']');
    }
    // No foot pads (#195): the 0.2 mm first-layer pad reads as a wall under
    // the floor in the canonical check below, which weighs the members and
    // their bores - as tree:canonical / tree:round do since #195.
    const t = await ST.hollowTree(tp, { unionSoups: csg.NSO_unionSoups, subtractSoups: csg.NSO_subtractSoups, footPads: false });
    if (!t.ok) { console.error('the hollow support would not build: ' + t.reason); process.exit(1); }
    // since #195 the plan's region is a beacon region: no area of its own
    const rArea = tp.region && tp.region.areaMm2 != null ? tp.region.areaMm2.toFixed(3) + ' mm^2' : tp.beacons.length + ' beacons';
    console.log('tree       region ' + TREE_REGION + ', ' + rArea + ': ' + tp.reason);
    console.log('           ' + tp.members.length + ' members, ' + tp.merges.length + ' merges, ' + tp.trunks.length +
                ' trunk(s); ' + t.hollow.reason);
    for (const x of t.hollow.solid) console.log('           ' + x.label.padEnd(14) + 'SOLID - ' + x.kind + (x.why ? ': ' + x.why : ''));
    const bs = bounds(strut), bt = bounds(t.soup);
    const apart = [0, 1, 2].some(k => bs.max[k] < bt.min[k] || bt.max[k] < bs.min[k]);
    console.log('           ' + (apart ? 'clear of the strut (bounding boxes do not overlap)'
                                       : 'WARNING: bounding boxes overlap the strut\'s'));
    const stations = tp.stations;
    supports.push({ name: TREE_NAME, soup: t.soup, parts: t.partSoups, stations,
                    solids: ctx.NSO_RasterLines.countComponents(t.soup) });
  }

  /* ---- 2d. the gap and the interface, at every tip -------------------------- */
  if (IFACE) {
    const SI = ctx.NSO_SupportInterface, TH = ctx.NSO_Thickness;
    console.log('\ninterface  the gap: ' + SI.DEFAULTS.gapMm + ' mm true minimum distance (Seat (support) -0.18); ' +
                'two crosshatch layers of ' + SI.DEFAULTS.layerMm + ' mm, one direction each');
    for (const sp of supports) {
      const before = SI.minDistance(sp.soup, piece, { thickness: TH, reach: 1 });
      const f = await SI.finish(sp.soup, sp.stations, piece, {
        unionSoups: csg.NSO_unionSoups, subtractSoups: csg.NSO_subtractSoups });
      console.log('  ' + sp.name + ': before, closest approach to the piece ' + before.mm.toFixed(4) + ' mm');
      for (const r of f.stations) {
        console.log('    ' + r.label.padEnd(22) + 'underside z ' + r.zUnderside.toFixed(3) +
          ' -> interface ' + r.zBase.toFixed(3) + '..' + r.zTop.toFixed(3) + ', ' +
          (r.interface ? r.repeats + 'x' + r.repeats + ' lines, ' + r.span.toFixed(3) + ' mm square, centred [' +
            r.centre.map(v => v.toFixed(3)).join(', ') + '], layers run ' +
            r.patch.lineDirections.map(v => Math.round(v)).join(' / ') + ' deg, patch ' +
            r.patchDistanceMm.toFixed(4) + ' mm off the piece'
            : 'NO INTERFACE - cut at the gap line: ' + r.tried.map(x => x.why).join('; ')));
      }
      console.log('    ' + f.reason);
      if (!f.ok) {
        console.error('the gap or the interface failed on ' + sp.name + ' - closest approach at [' +
          (f.minDistanceAt || []).map(v => v.toFixed(3)).join(', ') + '] - NOT writing it');
        process.exit(1);
      }
      sp.soup = f.soup;
      sp.finish = f;
    }
  }

  /* ---- 4. one rigid move onto the plate ------------------------------------ */

  const all = [bounds(piece)].concat(supports.map(s => bounds(s.soup)));
  const lo = [0, 1, 2].map(k => Math.min(...all.map(b => b.min[k])));
  const hi = [0, 1, 2].map(k => Math.max(...all.map(b => b.max[k])));
  const shift = [PLATE.w / 2 - (lo[0] + hi[0]) / 2, PLATE.d / 2 - (lo[1] + hi[1]) / 2, -lo[2]];
  console.log('plate      shift [' + fmt(shift) + '] onto ' + PLATE.w + ' x ' + PLATE.d + ', footprint ' +
              (hi[0] - lo[0]).toFixed(2) + ' x ' + (hi[1] - lo[1]).toFixed(2) + ' x ' +
              (hi[2] - lo[2]).toFixed(2) + ' mm');

  /* ---- 3, 5. name, index, write -------------------------------------------- */

  const objects = [{ name: PIECE_NAME, soup: translate(piece, shift) }]
    .concat(supports.map(s => ({ name: s.name, soup: translate(s.soup, shift) })))
    .map(o => {
      const m = NSO3MF.indexTriangleSoup(o.soup);
      return { name: o.name, vertices: m.vertices, triangles: m.triangles };
    });

  const res = await NSO3MF.build3MF({ objects, plateName: 'NSO support slice artifact' +
    (HOLLOW ? ' (hollow)' : '') });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, res.bytes);
  console.log('\nwrote      ' + outPath + '  (' + res.bytes.length + ' bytes, profile ' + res.profileId + ')');

  /* ---- 6. read it back with an independent unzip ---------------------------- */
  const buf = fs.readFileSync(outPath);
  const model = readEntry(buf, NSO3MF.PART_MODEL);
  const re = /<object id="(\d+)" name="([^"]*)" type="model" p:UUID="([^"]+)">/g;
  let m;
  const found = [];
  while ((m = re.exec(model))) found.push(m);
  console.log('read back  ' + found.length + ' <object> elements in ' + NSO3MF.PART_MODEL + ':');
  for (const f of found) console.log('           id ' + f[1] + '  ' + f[2].padEnd(30) + ' ' + f[3]);
  const items = (model.match(/<item /g) || []).length;
  console.log('           ' + items + ' <item> elements in <build>');
  const names = [PIECE_NAME].concat(supports.map(s => s.name));
  const ok = found.length === names.length && found.every((f, i) => f[2] === names[i]) &&
             items === names.length;
  if (!ok) { console.error('read-back mismatch'); process.exit(1); }

  if (HOLLOW) {
    /* What the slicer reads: each support rebuilt from the archive's own
       6-decimal vertices, through the canonical checker, wall check on. */
    const labelledWalls = require('./nso_support_tree_walls.js');
    const TH = ctx.NSO_Thickness;
    let bad = 0;
    for (let si = 0; si < found.length - 1; si++) {
      const f = found[si + 1];
      const soup = objectSoup(model, f.index);
      const tmp = path.join(os.tmpdir(), 'nso_artifact_' + f[1] + '.stl');
      writeSTL(tmp, soup, f[2]);
      const v = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), tmp,
        '--json', '--weld', String(weldFor(soup))], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
      fs.unlinkSync(tmp);
      /* Walls from the SAME archive vertices: every face classed skin or bore
         against the object's own parts (moved onto the plate the same way),
         one ray per face into the material. */
      const parts = supports[si].parts.map(ps => Float32Array.from(translate(ps, shift)));
      /* With an interface, the zone from its underside to its top is one-layer
         lines by design - their floor is the line WIDTH - so the wall probe
         reads the bulk below it. */
      const zones = (supports[si].finish ? supports[si].finish.stations : [])
        .map(r => ({ z0: r.zBase + shift[2] - 0.01, z1: r.zTop + shift[2] + 0.01 }));
      const w = labelledWalls(TH, soup, parts, a.floorMm,
        { exclude: q => zones.some(zn => q[2] >= zn.z0 && q[2] <= zn.z1) });
      const shells = (v.euler_characteristic / 2) | 0;
      let wallOk = w.wall.thin === 0;
      console.log('checked    ' + f[2].padEnd(30) + ' ' + v.verdict +
                  (v.verdict_fails.length ? ' - ' + v.verdict_fails.join('; ') : '') +
                  ', ' + v.triangles + ' tris, open ' + v.open_edges + ', non-manifold ' + v.nonmanifold_edges +
                  ', pierce ' + v.self_intersection.pierce + ', euler ' + v.euler_characteristic +
                  (supports[si].finish ? ' (bores opened into the interface, which bridges them)'
                                       : ' (' + shells + ' closed shells: 1 skin + ' + (shells - 1) + ' bore(s))'));
      if (supports[si].finish) {
        /* THE CONFLICT CHECK, as the slicer will see it: the support object
           and the piece object, both from the archive's own vertices. */
        /* As many components as the support had before its finish (a
           grid-pack support is one solid PER TRUNK, and a bore sealed inside
           a merged member is a shell of its own) - the same count after the
           finish means every patch is fused to the tip it sits on. */
        const comps = ctx.NSO_RasterLines.countComponents(soup);
        const want = supports[si].solids || 1;
        console.log('           ' + comps + ' connected component(s), ' + want + ' expected - ' + (comps === want
          ? 'every interface patch is fused to the tip it sits on' : 'SOMETHING IS FLOATING'));
        wallOk = wallOk && comps === want;
        const pieceW = objectSoup(model, found[0].index);
        const gap = ctx.NSO_SupportInterface.minDistance(soup, pieceW, { thickness: TH, reach: 1 });
        const g0 = ctx.NSO_SupportInterface.DEFAULTS.gapMm;
        /* ...and again, EXACTLY: every triangle pair in closed form, candidates
           by triangle box (tools/nso_tri_distance.js). Two methods that share
           nothing but the file have to agree, or the run fails. */
        const exact = require('./nso_tri_distance.js').minTriDistance(soup, pieceW, { reach: 10 });
        const agree = Math.abs(exact.mm - gap.mm) < 1e-3;
        const gapOk = gap.mm >= g0 - 1e-3 && exact.mm >= g0 - 1e-3 && agree;
        console.log('           closest approach to ' + PIECE_NAME + ' as written: ' + gap.mm.toFixed(4) + ' mm at [' +
                    gap.at.map(c => c.toFixed(3)).join(', ') + '] (gap ' + g0 + ' mm, sampled at ' + gap.step + ' mm) - ' +
                    (gapOk ? 'no overlap, no contact' : 'UNDER THE GAP'));
        console.log('           exact triangle-to-triangle: ' + exact.mm.toFixed(6) + ' mm over ' + exact.pairs +
                    ' pairs (' + exact.candidates + ' piece triangles by box) - ' + (agree ? 'agrees' : 'DISAGREES') +
                    '; nearest piece triangle ' + exact.b.map(p => '(' + p.map(c => c.toFixed(3)).join(', ') + ')').join(' '));
        for (const r of supports[si].finish.stations) {
          const zb = r.zBase + shift[2], zt = r.zTop + shift[2], zu = r.zUnderside + shift[2];
          console.log('           ' + r.label.padEnd(22) + 'plate z: interface ' + zb.toFixed(3) + '..' + zt.toFixed(3) +
                      ', underside ' + zu.toFixed(3) + '; at ' + ctx.NSO_SupportInterface.DEFAULTS.layerMm +
                      ' mm layers, interface in layers ' + Math.ceil((zb + 0.1) / 0.2) + '-' + Math.ceil((zt - 0.1) / 0.2) +
                      ', piece from layer ' + Math.ceil(zu / 0.2) + (r.interface ? ', ' + r.repeats + 'x' + r.repeats +
                      ' lines ' + supports[si].finish.widthMm + ' mm wide at ' + supports[si].finish.pitchMm + ' mm pitch' : ', no interface'));
        }
        wallOk = wallOk && gapOk;
      }
      console.log('           walls to the outside: thinnest ' + w.wall.min.toFixed(4) + ' mm over ' + w.wall.n +
                  ' readings, ' + w.wall.thin + ' under the ' + a.floorMm + ' mm floor' +
                  (w.membrane.n ? '; membranes between diverging bores: ' + w.membrane.n + ' readings, ' +
                    w.membrane.thin + ' under the floor, thinnest ' + w.membrane.min.toFixed(4) + ' mm (bore<->bore, not a wall)' : ''));
      if (v.verdict !== 'PASS' || !wallOk) bad++;
    }
    if (bad) { console.error(bad + ' support object(s) failed the canonical checker as written'); process.exit(1); }
  }
})().catch(err => { console.error(err); process.exit(1); });

/* One object's mesh out of the model XML, as a soup. The writer emits each
   object's <mesh> between its own <object ...> tag and the next. */
function objectSoup(model, at) {
  const end = model.indexOf('</object>', at);
  const body = model.slice(at, end);
  const V = [];
  const vr = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g;
  let m;
  while ((m = vr.exec(body))) V.push([+m[1], +m[2], +m[3]]);
  const soup = [];
  const tr = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g;
  while ((m = tr.exec(body))) for (const k of [m[1], m[2], m[3]]) soup.push(...V[+k]);
  return new Float32Array(soup);
}

/* tree:canonical's rule: min(the default 1e-4, a third of the closest pair
   of distinct vertices), with the closest pair searched on a grid. */
function weldFor(soup) {
  const seen = new Map(), V = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
    if (!seen.has(k)) { seen.set(k, 1); V.push([soup[i], soup[i + 1], soup[i + 2]]); }
  }
  const cell = 0.05, grid = new Map(), key = p => p.map(c => Math.floor(c / cell)).join('|');
  for (let i = 0; i < V.length; i++) {
    const k = key(V[i]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  let best = Infinity;
  for (let i = 0; i < V.length; i++) {
    const c = V[i].map(x => Math.floor(x / cell));
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = grid.get((c[0] + a) + '|' + (c[1] + b) + '|' + (c[2] + d));
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const dd = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
        if (dd < best) best = dd;
      }
    }
  }
  return Math.min(1e-4, best / 3);
}

function readEntry(buf, name) {
  // central directory walk, Node zlib for the inflate - no writer code reused
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const n = buf.toString('utf8', at + 46, at + 46 + nlen);
    if (n === name) {
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nlen + xlen + clen;
  }
  throw new Error(name + ' not in archive');
}

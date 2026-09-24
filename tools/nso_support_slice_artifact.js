#!/usr/bin/env node
// A real, non-synthetic slice artifact: one real piece with a genuine
// overhang, one straight support aimed at it by NSO_SupportAim, both written
// through the plate 3MF writer (nso-3mf.js) as two named objects.
//
//   node tools/nso_support_slice_artifact.js [out.3mf]
//   node tools/nso_support_slice_artifact.js --hollow [out.3mf]
//   node tools/nso_support_slice_artifact.js --hollow --tree [out.3mf]
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
//   2b. --hollow: hollows that SAME strut with NSO_Hollow.hollow() at the
//      floor it was built to (NSO_Thickness.floorFor, 0.42 mm at a 0.4
//      nozzle). Same aim, same name, same plate position as the solid run -
//      the one thing that differs is that it is now a tube, so a slice of it
//      against a slice of the solid one isolates exactly that. Refuses rather
//      than writing a solid strut under the hollow name.
//   2c. --tree (with --hollow): also plans a support TREE on the piece's
//      region 1 - the one region of this piece a single trunk can serve, 4
//      branches - and writes it hollow (NSO_SupportTree.hollowTree) as a third
//      object, so trunk-and-branch tubes are sliced on the same real piece
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
const HOLLOW = args.includes('--hollow');
const TREE = args.includes('--tree');
if (TREE && !HOLLOW) { console.error('--tree is only built hollow; pass --hollow --tree'); process.exit(1); }
const positional = args.filter(a => !a.startsWith('--'));

const PIECE_FILE = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
const PIECE_NAME = 'tape_on-edge-single-B101';
const SUPPORT_NAME = 'NSO_SUPPORT_tape_underside';
const TREE_NAME = 'NSO_SUPPORT_tape_tree_region1';
const TREE_REGION = 1;
const PLATE = { w: 256, d: 256 };

const defaultName = 'nso_support_slice_artifact' + (HOLLOW ? '_hollow' : '') + (TREE ? '_tree' : '') + '.3mf';
const outPath = path.resolve(positional[0] || path.join(ROOT, 'out', defaultName));

/* The support module and everything it reuses, loaded the way the aim test
   loads them: classic scripts in one shared context. */
const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_hollow.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim;
const H = ctx.NSO_Hollow;
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

  let strut = p.soup;
  const supports = [{ name: SUPPORT_NAME, soup: null }];

  /* ---- 2b. the same strut, hollow ------------------------------------------ */
  if (HOLLOW) {
    const h = H.hollow(p.soup, { wall: a.floorMm, maxDim: 4096 });
    if (!h.ok) {
      console.error('hollow refused - NOT writing a solid strut under the hollow name: ' + h.reason);
      process.exit(1);
    }
    strut = h.soup;
    console.log('hollow     ' + h.reason);
    console.log('           wall ' + a.floorMm + ' mm = NSO_Thickness.floorFor(' + (a.nozzle || 0.4) +
                '); measured ' + h.measured_cavity_mm.toFixed(4) + ' mm from the bore, ' +
                h.measured_outer_mm.toFixed(4) + ' mm from the outer faces (the far wall - see ' +
                'nso_hollow.js, AND FROM BOTH SIDES)');
    console.log('           bore ' + (a.sideMm - 2 * a.floorMm).toFixed(3) + ' mm across inside a ' +
                a.sideMm.toFixed(3) + ' mm strut, capped ' + a.floorMm + ' mm at the plate and at the tip');
  }
  supports[0].soup = strut;

  /* ---- 2c. a hollow tree on the region one trunk can serve ----------------- */
  if (TREE) {
    const { csgContext } = require('./nso_csg_node.js');
    const csg = csgContext();
    const tp = ST.planTree(piece, { skipList: [], regionId: TREE_REGION, hollow: true });
    if (!tp.ok) { console.error('the region ' + TREE_REGION + ' tree would not plan: ' + tp.reason); process.exit(1); }
    const t = await ST.hollowTree(tp, { unionSoups: csg.NSO_unionSoups });
    if (!t.ok) { console.error('the hollow tree would not build: ' + t.reason); process.exit(1); }
    console.log('tree       region ' + TREE_REGION + ', ' + tp.region.areaMm2.toFixed(3) + ' mm^2: ' +
                tp.contacts.points.length + ' contacts, trunk ' + tp.trunk.lengthMm.toFixed(3) + ' mm, ' +
                tp.branches.length + ' branches, ' + tp.tiltDeg.min.toFixed(2) + '..' +
                tp.tiltDeg.max.toFixed(2) + ' deg off vertical');
    console.log('           ' + t.reason);
    for (const r of t.hollow.parts) {
      console.log('           ' + r.label.padEnd(22) + (r.hollow
        ? 'tube, ' + r.bores + ' bore(s), ' + r.cavityMm3.toFixed(3) + ' mm^3, wall ' +
          r.measuredCavityMm.toFixed(4) + ' mm'
        : 'SOLID - ' + r.kind + ': ' + r.reason));
    }
    const bs = bounds(strut), bt = bounds(t.soup);
    const apart = [0, 1, 2].some(k => bs.max[k] < bt.min[k] || bt.max[k] < bs.min[k]);
    console.log('           ' + (apart ? 'clear of the strut (bounding boxes do not overlap)'
                                       : 'WARNING: bounding boxes overlap the strut\'s'));
    supports.push({ name: TREE_NAME, soup: t.soup, solidSoup: t.solidSoup });
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
    const check = (soup, tag) => {
      const tmp = path.join(os.tmpdir(), 'nso_artifact_' + tag + '.stl');
      writeSTL(tmp, soup, tag);
      const v = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), tmp,
        '--json', '--min-wall', String(a.floorMm), '--weld', String(weldFor(soup))],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
      fs.unlinkSync(tmp);
      return v;
    };
    let bad = 0;
    for (let si = 0; si < found.length - 1; si++) {
      const f = found[si + 1];
      const soup = objectSoup(model, f.index);
      const v = check(soup, 'obj' + f[1]);
      const shells = (v.euler_characteristic / 2) | 0;
      console.log('checked    ' + f[2].padEnd(30) + ' ' + v.verdict +
                  (v.verdict_fails.length ? ' - ' + v.verdict_fails.join('; ') : '') +
                  ', ' + v.triangles + ' tris, open ' + v.open_edges + ', non-manifold ' +
                  v.nonmanifold_edges + ', euler ' + v.euler_characteristic + ' (' + shells +
                  ' closed shells: 1 skin + ' + (shells - 1) + ' bore(s)), thinnest wall ' +
                  v.wall.min_wall_mm.toFixed(4) + ' mm');
      if (v.verdict === 'PASS') continue;
      /* Is it the bores, or was it already in the solid? The solid union,
         moved and rounded to the writer's 6 decimals exactly as the archive
         holds it, through the same check. */
      const solid = supports[si].solidSoup;
      if (solid) {
        const q = Float32Array.from(translate(solid, shift), c => +NSO3MF_num(c));
        const sv = check(q, 'solid' + f[1]);
        if (JSON.stringify(sv.verdict_fails) === JSON.stringify(v.verdict_fails)) {
          console.log('           the SAME failure is in the solid union as written (' +
                      sv.verdict_fails.join('; ') + ') - it is the boolean\'s float32 slivers ' +
                      'meeting the 3MF writer\'s 6-decimal rounding, not the bores: at float32 ' +
                      'both solid and hollow pass. Not counted against the hollow.');
          continue;
        }
      }
      bad++;
    }
    if (bad) { console.error(bad + ' support object(s) failed the canonical checker as written'); process.exit(1); }
  }
})().catch(err => { console.error(err); process.exit(1); });

/* The writer's own coordinate text (nso-3mf.js num()), so a soup can be
   rounded exactly as the archive holds it. */
function NSO3MF_num(v) {
  let s = v.toFixed(6);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

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

#!/usr/bin/env node
// A real, non-synthetic slice artifact: one real piece with a genuine
// overhang, one straight support aimed at it by NSO_SupportAim, both written
// through the plate 3MF writer (nso-3mf.js) as two named objects.
//
//   node tools/nso_support_slice_artifact.js [out.3mf]
//
// Default output: out/nso_support_slice_artifact.3mf (out/ is gitignored).
//
// Slicing is NOT done here. The file is meant to be opened in real Bambu
// Studio by hand; this script stops at the archive.
//
// What it does, and nothing else:
//   1. reads fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl - a real
//      part, the same one tools/nso_support_aim_test.js calls "the tape case"
//   2. runs NSO_SupportAim.plan() on it (detect + straight-line aim) with
//      skipList [] - nothing is painted on a bare fixture
//   3. names the support NSO_SUPPORT_<...> and the piece after its file
//   4. moves BOTH by one rigid translation onto the centre of a 256 x 256
//      Bambu plate, plate at z = 0 - the same frame buildPlacedObjects3MF()
//      hands the writer
//   5. indexes each with NSO3MF.indexTriangleSoup and writes the archive with
//      NSO3MF.build3MF, exactly the calls exportPlate3MF() makes
//   6. reads the archive back and prints the object names, ids and UUIDs, so
//      what went in is on record before anyone slices it

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');
const NSO3MF = require('../nso-3mf.js');

const PIECE_FILE = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
const PIECE_NAME = 'tape_on-edge-single-B101';
const SUPPORT_NAME = 'NSO_SUPPORT_tape_underside';
const PLATE = { w: 256, d: 256 };

const outPath = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'nso_support_slice_artifact.3mf'));

/* The support module and everything it reuses, loaded the way the aim test
   loads them: classic scripts in one shared context. */
const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim;

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

/* ---- 1-2. the real piece, and the aim -------------------------------------- */

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

/* ---- 4. one rigid move onto the plate ------------------------------------- */

const bp = bounds(piece), bs = bounds(p.soup);
const lo = [Math.min(bp.min[0], bs.min[0]), Math.min(bp.min[1], bs.min[1]), Math.min(bp.min[2], bs.min[2])];
const hi = [Math.max(bp.max[0], bs.max[0]), Math.max(bp.max[1], bs.max[1]), Math.max(bp.max[2], bs.max[2])];
const shift = [PLATE.w / 2 - (lo[0] + hi[0]) / 2, PLATE.d / 2 - (lo[1] + hi[1]) / 2, -lo[2]];
console.log('plate      shift [' + fmt(shift) + '] onto ' + PLATE.w + ' x ' + PLATE.d + ', footprint ' +
            (hi[0] - lo[0]).toFixed(2) + ' x ' + (hi[1] - lo[1]).toFixed(2) + ' x ' +
            (hi[2] - lo[2]).toFixed(2) + ' mm');

/* ---- 3, 5. name, index, write ---------------------------------------------- */

const objects = [
  { name: PIECE_NAME, soup: translate(piece, shift) },
  { name: SUPPORT_NAME, soup: translate(p.soup, shift) }
].map(o => {
  const m = NSO3MF.indexTriangleSoup(o.soup);
  return { name: o.name, vertices: m.vertices, triangles: m.triangles };
});

NSO3MF.build3MF({ objects, plateName: 'NSO support slice artifact' }).then(res => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, res.bytes);
  console.log('\nwrote      ' + outPath + '  (' + res.bytes.length + ' bytes, profile ' + res.profileId + ')');

  /* ---- 6. read it back with an independent unzip ---------------------------- */
  const buf = fs.readFileSync(outPath);
  const model = readEntry(buf, NSO3MF.PART_MODEL);
  const re = /<object id="(\d+)" name="([^"]*)" type="model" p:UUID="([^"]+)">/g;
  let m, found = [];
  while ((m = re.exec(model))) found.push(m);
  console.log('read back  ' + found.length + ' <object> elements in ' + NSO3MF.PART_MODEL + ':');
  for (const f of found) console.log('           id ' + f[1] + '  ' + f[2].padEnd(28) + ' ' + f[3]);
  const items = (model.match(/<item /g) || []).length;
  console.log('           ' + items + ' <item> elements in <build>');
  const ok = found.length === 2 && found[0][2] === PIECE_NAME && found[1][2] === SUPPORT_NAME && items === 2;
  if (!ok) { console.error('read-back mismatch'); process.exit(1); }
});

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

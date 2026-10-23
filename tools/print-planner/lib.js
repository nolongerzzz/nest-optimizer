/* tools/print-planner/lib.js - what the print:planner gate and its tools share.
   The plates are built here once and cached for the process: the Supports
   card's build is a few seconds and the slice a few more. Node only. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const R = require(path.join(ROOT, 'nso-3mf-read.js'));
const { readSTL } = require(path.join(ROOT, 'tools', 'nso_stl_io.js'));

const dec = new TextDecoder();

/** A zip's parts by name, as bytes. */
async function readParts(file, names) {
  const zip = R.openZip(new Uint8Array(fs.readFileSync(file)));
  const out = {};
  for (const n of names || zip.names()) out[n] = await zip.read(n);
  return { zip, parts: out };
}
const text = bytes => dec.decode(bytes);

/** The A1 mini 0.4 template's project settings (the owner's project_test.3mf). */
async function a1Template() {
  const file = path.join(ROOT, 'fixtures', 'bambu-templates', 'a1mini-0.4', 'project_test.3mf');
  const { parts } = await readParts(file, ['Metadata/project_settings.config']);
  return JSON.parse(text(parts['Metadata/project_settings.config']));
}

/** A Bambu slice: its G-code and its parts. */
async function bambuSlice(rel) {
  const file = path.join(ROOT, rel);
  const { zip, parts } = await readParts(file);
  return { file, zip, parts, gcode: text(parts['Metadata/plate_1.gcode']),
           config: JSON.parse(text(parts['Metadata/project_settings.config'])) };
}

let kernel = null;
async function wasm() { return kernel || (kernel = await SL.loadKernel()); }

const cache = {};

/** Plate A: top_clip_x2 coupon with the Supports card's tree supports, as the
 *  owner's A1 mini slice (top_clip_x2_supports.gcode.3mf) has them. */
async function plateA() {
  if (cache.A) return cache.A;
  const PX = require(path.join(ROOT, 'tools', 'nso_supports_print_export.js'));
  const piece = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
  const b = await PX.build(piece);
  const objs = b.objects.map((o, i) => i === 0 ? { name: o.name, soup: o.soup, key: 1, role: 'part' }
                                                : { name: o.name, soup: o.soup, role: 'support', hostKey: 1 });
  const res = SL.sliceObjects(objs, SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2, emitGcode: false }), await wasm());
  return (cache.A = { res, objs });
}

/** Plate B: the Simple Overhang Test arc, moved to (cx, cy) on the bed, with
 *  NSO's supports when `supports`. */
async function plateB(cx, cy, supports) {
  const key = 'B' + cx + ',' + cy + (supports ? 's' : '');
  if (cache[key]) return cache[key];
  const model = await R.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf'))));
  const soup = Array.from(model.objects[0].positions);
  const dx = cx - 90, dy = cy - 90;                 // the fixture is centred on the A1 mini's bed
  const move = s => { const o = s.slice(); for (let i = 0; i < o.length; i += 3) { o[i] += dx; o[i + 1] += dy; } return o; };
  const objs = [{ name: 'Simple Overhang Test', soup: move(soup), key: 1, role: 'part' }];
  if (supports) {
    const PX = require(path.join(ROOT, 'tools', 'nso_supports_print_export.js'));
    const b = await PX.build(new Float64Array(soup));
    b.objects.slice(1).forEach(o => objs.push({ name: o.name, soup: move(Array.from(o.soup)), role: 'support', hostKey: 1 }));
  }
  const res = SL.sliceObjects(objs, SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2, emitGcode: false }), await wasm());
  return (cache[key] = { res, objs });
}

module.exports = { ROOT, SL, R, dec, text, readParts, a1Template, bambuSlice, plateA, plateB, wasm };

/** A line-by-line scan of a G-code text: what the nozzle did, with the state a
 *  line carries (speed, acceleration, feature, layer, fan). Works on Bambu's
 *  files and on the planner's alike. */
function scan(gcode) {
  const lines = gcode.split('\n');
  const st = { x: 0, y: 0, z: 0, F: 0, A: 0, feature: null, layer: -1, layerZ: 0, fan: 0, retracted: false, label: null, lw: 0, lh: 0 };
  const out = { moves: [], retracts: [], hops: [], fans: [], accels: new Set(), temps: [], layerStarts: [], tags: {} };
  let inWipe = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    let m;
    if (s.charCodeAt(0) === 59) {                       // ';'
      if ((m = /^; FEATURE: (.*)$/.exec(s))) st.feature = m[1];
      else if (s === '; CHANGE_LAYER') { st.layer++; out.layerStarts.push(i); }
      else if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(s))) st.layerZ = +m[1];
      else if ((m = /^; LINE_WIDTH: ([\d.]+)/.exec(s))) st.lw = +m[1];
      else if ((m = /^; LAYER_HEIGHT: ([\d.]+)/.exec(s))) st.lh = +m[1];
      else if (s === '; WIPE_START') inWipe = true;
      else if (s === '; WIPE_END') inWipe = false;
      continue;
    }
    if ((m = /^M204 S(\d+)/.exec(s))) { st.A = +m[1]; if (st.layer >= 0) out.accels.add(st.A); continue; }
    if ((m = /^M106 S([\d.]+)/.exec(s))) { st.fan = +m[1]; out.fans.push({ layer: st.layer, s: st.fan, line: i }); continue; }
    if ((m = /^M(104|109|140|190) S(\d+)/.exec(s))) { out.temps.push({ code: +m[1], s: +m[2], layer: st.layer, line: i }); continue; }
    if (!/^G[0123] /.test(s) && !/^G1 /.test(s)) continue;
    const w = {};
    s.replace(/([XYZEFIJ])(-?[\d.]+)/g, (a, k, v) => { w[k] = +v; return a; });
    if (w.F !== undefined) st.F = w.F;
    const nx = w.X !== undefined ? w.X : st.x, ny = w.Y !== undefined ? w.Y : st.y, nz = w.Z !== undefined ? w.Z : st.z;
    if (w.E !== undefined && w.E < 0) {
      out.retracts.push({ e: w.E, line: i, layer: st.layer, wipe: inWipe, x: nx, y: ny, z: nz, F: st.F });
    } else if (w.E !== undefined && w.E > 0 && w.X === undefined && w.Y === undefined) {
      out.retracts.push({ e: w.E, line: i, layer: st.layer, deretract: true, F: st.F });
    } else if (w.E !== undefined && w.E > 0 && st.layer >= 0 && /^G[123]/.test(s)) {
      out.moves.push({ line: i, layer: st.layer, feature: st.feature, F: st.F, A: st.A, e: w.E, x0: st.x, y0: st.y, x1: nx, y1: ny,
                       z: nz, len: Math.hypot(nx - st.x, ny - st.y), lw: st.lw, lh: st.lh, layerZ: st.layerZ });
    } else if (w.Z !== undefined && w.Z > st.z + 1e-9 && st.layer >= 0) {
      out.hops.push({ line: i, layer: st.layer, z: w.Z, from: st.z, layerZ: st.layerZ });
    }
    st.x = nx; st.y = ny; st.z = nz;
  }
  return out;
}
module.exports.scan = scan;

/* tools/print-planner/lib.js - what the print:planner gate and its tools share.
   The plates are built here once and cached for the process: the Supports
   card's build is a few seconds and the slice a few more. Node only. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const PLN = require(path.join(ROOT, 'nso-print-planner.js'));

/** The engine's options for a template: what Studio's process profile says. */
function engineFor(config) {
  const e = PLN.engineOptions(config);
  return SL.defaultsFor(e.nozzleMm, Object.assign({ emitGcode: false }, e.over));
}
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

/** A printer's frozen start / end (tools/print-planner/freeze.js wrote it). */
function printer(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'print-planner', id, 'frozen.json'), 'utf8'));
}

/** The P1S 0.4 settings: the owner's P1S slice carries the project it was sliced with. */
async function p1sTemplate() {
  const s = await bambuSlice('fixtures/supports/simple_overhang_p1s.gcode.3mf');
  return s.config;
}

let kernel = null;
async function wasm() { return kernel || (kernel = await SL.loadKernel()); }

const cache = {};

/** Plate A: top_clip_x2 coupon with the Supports card's tree supports, as the
 *  owner's A1 mini slice (top_clip_x2_supports.gcode.3mf) has them. */
async function plateA(config) {
  const ck = 'A' + (config ? 't' : '');
  if (cache[ck]) return cache[ck];
  const PX = require(path.join(ROOT, 'tools', 'nso_supports_print_export.js'));
  const piece = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
  const b = await PX.build(piece);
  const objs = b.objects.map((o, i) => i === 0 ? { name: o.name, soup: o.soup, key: 1, role: 'part' }
                                                : { name: o.name, soup: o.soup, role: 'support', hostKey: 1 });
  const res = SL.sliceObjects(objs, config ? engineFor(config) : SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2, emitGcode: false }), await wasm());
  return (cache[ck] = { res, objs });
}

/** Plate B: the Simple Overhang Test arc, moved to (cx, cy) on the bed, with
 *  NSO's supports when `supports`. */
async function plateB(cx, cy, supports, config) {
  const key = 'B' + cx + ',' + cy + (supports ? 's' : '') + (config ? 't' : '');
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
  const res = SL.sliceObjects(objs, config ? engineFor(config) : SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2, emitGcode: false }), await wasm());
  return (cache[key] = { res, objs });
}

module.exports = { ROOT, SL, engineFor, R, dec, text, readParts, a1Template, p1sTemplate, bambuSlice, printer, plateA, plateB, wasm };

/** A line-by-line scan of a G-code text: what the nozzle did, with the state a
 *  line carries (speed, acceleration, feature, layer, fan). Works on Bambu's
 *  files and on the planner's alike. */
function scan(gcode) {
  const lines = gcode.split('\n');
  const st = { x: 0, y: 0, z: 0, F: 0, A: 0, feature: null, layer: -1, layerZ: 0, fan: 0, retracted: false, label: null, lw: 0, lh: 0 };
  const out = { moves: [], retracts: [], hops: [], fans: [], accels: new Set(), temps: [], layerStarts: [], tags: {} };
  let inWipe = false, done = false;
  for (let i = 0; i < lines.length && !done; i++) {
    const s = lines[i];
    let m;
    if (s === '; MACHINE_END_GCODE_START' || (st.layer >= 0 && (s === '; FEATURE: Custom' || /^M981 S0 /.test(s)))) { done = true; break; }
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
    if (st.layer < 0 && s.charCodeAt(0) !== 59) { if ((m = /^M(104|109|140|190) S(\d+)/.exec(s))) out.temps.push({ code: +m[1], s: +m[2], layer: -1, line: i }); continue; }
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

/** The print time a G-code text asks for, from its own F, M204 and moves: the
 *  planner's own estimator (NSOPrintPlanner.estimateLines), so Studio's files
 *  and the planner's are timed by one model. Seconds from the first
 *  CHANGE_LAYER to the end block, and per layer. */
function estimateGcode(gcode, opts) {
  const PL = require(path.join(ROOT, 'nso-print-planner.js'));
  opts = opts || {};
  const all = gcode.split('\n');
  const from = all.indexOf('; CHANGE_LAYER');
  let to = all.indexOf('; MACHINE_END_GCODE_START');
  if (to < 0) to = all.length;
  const body = all.slice(from, to);
  const e = PL.estimateLines(body, { jerk: opts.jerk || 9, accel: opts.accel || 6000 });
  const starts = [];
  body.forEach((l, i) => { if (l === '; CHANGE_LAYER') starts.push(i); });
  const perLayer = starts.map((st, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : body.length;
    const t0 = st > 0 ? e.times[st - 1] : 0;
    return e.times[end - 1] - t0;
  });
  return { seconds: e.seconds, perLayer };
}
module.exports.estimateGcode = estimateGcode;

/** A G-code text by layer: for each layer its Z, and per object the features it
 *  printed with their path length and extruded mm of filament. Bambu's and the
 *  planner's files read the same way (OBJECT_ID, start printing object). */
function layersOf(gcode) {
  const lines = gcode.split('\n');
  const out = [];
  let cur = null, obj = null, feat = null, x = 0, y = 0, started = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    let m;
    if (s === '; CHANGE_LAYER') { cur = { z: 0, objects: {} }; out.push(cur); started = true; obj = null; continue; }
    if (s === '; MACHINE_END_GCODE_START') break;
    if (!started) continue;
    if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(s))) { cur.z = +m[1]; continue; }
    if ((m = /^; OBJECT_ID: (\d+)/.exec(s))) { obj = m[1]; continue; }
    if ((m = /^; start printing object, unique label id: (\d+)/.exec(s))) { obj = m[1]; continue; }
    if ((m = /^; FEATURE: (.*)$/.exec(s))) { feat = m[1]; continue; }
    if ((m = /^G[123] X(-?[\d.]+) Y(-?[\d.]+)(?: I\S+ J\S+)?(?: Z\S+)?(?: F\S+)?( E[\d.]+)?$/.exec(s))) {
      const nx = +m[1], ny = +m[2];
      if (m[2 + 1] && cur && feat && /E[\d.]+/.test(m[3])) {
        const o = cur.objects[obj] || (cur.objects[obj] = {});
        const f = o[feat] || (o[feat] = { len: 0, e: 0, n: 0 });
        f.len += Math.hypot(nx - x, ny - y); f.e += +m[3].slice(2); f.n++;
      }
      x = nx; y = ny; continue;
    }
    if ((m = /^G[01] X(-?[\d.]+) Y(-?[\d.]+)/.exec(s))) { x = +m[1]; y = +m[2]; }
  }
  return out;
}
module.exports.layersOf = layersOf;

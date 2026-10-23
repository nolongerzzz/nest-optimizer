#!/usr/bin/env node
/*
 * print:planner - NSO writes Bambu's dialect (nso-print-planner.js).
 *
 *   node tools/print-planner/planner-check.js
 *
 * The planner turns the in-house slicer's toolpath into the G-code Bambu
 * Studio would write for the same plate. This gate holds it to the owner's own
 * Bambu slices of the same plates - not to itself:
 *
 *   A. fixtures/supports/top_clip_x2_supports.gcode.3mf   A1 mini 0.4, the
 *      coupon and its NSO supports, sliced by Studio 02.08.02.61
 *   B. fixtures/supports/simple_overhang_bambu.gcode.3mf  A1 mini 0.4, the arc
 *   C. fixtures/supports/simple_overhang_p1s.gcode.3mf    P1S 0.4, the arc
 *
 * and to the printer template (fixtures/bambu-templates/a1mini-0.4/).
 *
 * G-scope's own checks, gcode3mf:test and page:manifest are not touched by it:
 * no G-scope file loads the planner.
 */
'use strict';

const path = require('path');
const L = require('./lib.js');
const { ROOT } = L;
const PL = require(path.join(ROOT, 'nso-print-planner.js'));
const Lines = require(path.join(ROOT, 'nso-gcode-lines.js'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'ok    ' : 'FAIL  ') + label + (detail !== undefined && (!ok || process.env.VERBOSE) ? '\n          ' + detail : ''));
}
function section(t) { console.log('\n== ' + t); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f3 = v => (+v).toFixed(3);
const SUPPORT_FEATURES = ['Support', 'Support interface', 'Support transition'];

/** Bambu's CONFIG_BLOCK as a key -> string map. */
function configBlock(gcode) {
  const out = {};
  const s = gcode.indexOf('; CONFIG_BLOCK_START'), e = gcode.indexOf('; CONFIG_BLOCK_END');
  gcode.slice(s, e).split('\n').forEach(l => { const m = /^; ([^ =]+) = ?(.*)$/.exec(l); if (m) out[m[1]] = m[2]; });
  return out;
}

async function main() {
  const tpl = await L.a1Template();
  const A = await L.bambuSlice('fixtures/supports/top_clip_x2_supports.gcode.3mf');
  const cfgA = configBlock(A.gcode);

  // ===========================================================================
  section('1. Settings: the planner reads the template, and the template is what Studio sliced with');
  // ===========================================================================
  const S = PL.settingsFrom(tpl);
  const same = (name, mine, key, scale) => {
    const theirs = parseFloat(String(cfgA[key]).split(',')[0]);
    check(name + ' = Bambu\'s ' + key + ' (' + theirs + ')', near(mine, theirs * (scale || 1), 1e-9), mine + ' vs ' + theirs);
  };
  same('outer wall speed', S.speed.outer, 'outer_wall_speed');
  same('inner wall speed', S.speed.inner, 'inner_wall_speed');
  same('sparse infill speed', S.speed.sparse, 'sparse_infill_speed');
  same('solid infill speed', S.speed.solid, 'internal_solid_infill_speed');
  same('top surface speed', S.speed.top, 'top_surface_speed');
  same('first layer speed', S.speed.first, 'initial_layer_speed');
  same('first layer infill speed', S.speed.firstInfill, 'initial_layer_infill_speed');
  same('travel speed', S.speed.travel, 'travel_speed');
  same('support speed', S.speed.support, 'support_speed');
  same('support interface speed', S.speed.interface, 'support_interface_speed');
  same('bridge speed', S.speed.bridge, 'bridge_speed');
  same('gap infill speed', S.speed.gap, 'gap_infill_speed');
  same('default acceleration', S.accel.def, 'default_acceleration');
  same('outer wall acceleration', S.accel.outer, 'outer_wall_acceleration');
  same('top surface acceleration', S.accel.top, 'top_surface_acceleration');
  same('first layer acceleration', S.accel.first, 'initial_layer_acceleration');
  same('travel acceleration', S.accel.travel, 'travel_acceleration');
  same('short-travel acceleration', S.accel.short, 'travel_short_distance_acceleration');
  same('retraction length', S.retract.length, 'retraction_length');
  same('retraction speed', S.retract.speed, 'retraction_speed');
  same('z-hop', S.retract.hop, 'z_hop');
  same('wipe distance', S.retract.wipeDistance, 'wipe_distance');
  same('nozzle temperature', S.temp.nozzle, 'nozzle_temperature');
  same('first layer nozzle temperature', S.temp.nozzleInitial, 'nozzle_temperature_initial_layer');
  same('bed temperature (Textured PEI)', S.temp.bed, 'textured_plate_temp');
  same('flow ratio', S.filament.flow, 'filament_flow_ratio');
  same('volumetric limit', S.filament.maxVolumetric, 'filament_max_volumetric_speed');
  check('retract 0.8 @ 30, z-hop 0.4, wipe on, retract on layer change (the ticket\'s figures)',
    S.retract.length === 0.8 && S.retract.speed === 30 && S.retract.hop === 0.4 && S.retract.wipe && S.retract.onLayerChange,
    JSON.stringify(S.retract));
  check('the cooling keys are NSO\'s, not the template\'s (slow_down_layer_time 6, the profile\'s; the template has 8)',
    S.cooling.slow_down_layer_time === 6 && PL.settingsFrom(tpl, 'default').cooling.slow_down_layer_time === 6 &&
      parseFloat(cfgA.slow_down_layer_time) === 8, JSON.stringify(S.cooling));

  // ===========================================================================
  section('2. Plate A (the coupon and its NSO supports): the plan');
  // ===========================================================================
  const pa = await L.plateA();
  const res = pa.res;
  const PR = L.printer('a1mini-0.4');
  const P = PL.plan(res, { config: tpl, printer: PR });
  check('the plan is made', P.ok && P.gcode.length > 1e6, P.reason);
  const parsed = Lines.parseGcode(P.gcode);
  check('the file parses with NSOGcodeLines.parseGcode: every move\'s height and the E mode from the file, nothing assumed',
    parsed.moves.length > 20000 && !parsed.meta.assumed, parsed.warnings.join('; '));
  const names = parsed.features.map(g => g.name).sort();
  const isBambuName = n => /^(Outer wall|Inner wall|Overhang wall|Sparse infill|Internal solid infill|Top surface|Bottom surface|Bridge|Gap infill|Floating vertical shell|Support|Support interface|Support transition)$/.test(n);
  check('every feature is a name Bambu writes', names.every(isBambuName), names.join(', '));
  const sup = res.objects.filter(o => o.role === 'support');
  const supFeatures = new Set();
  sup.forEach(o => o.layers.forEach(l => l.paths.forEach(p => supFeatures.add(p.feature))));
  check('our support paths are typed Support / Support interface / Support transition by the engine - and never Overhang wall',
    [...supFeatures].every(f => SUPPORT_FEATURES.includes(f)) && supFeatures.has('Support') && !supFeatures.has('Overhang wall'),
    [...supFeatures].join(', '));
  check('...and they come out of the planner under those names',
    SUPPORT_FEATURES.every(f => names.includes(f)), names.join(', '));
  const sc = L.scan(P.gcode);
  check('the layer count is the engine\'s: one CHANGE_LAYER per layer', sc.layerStarts.length === P.layers.length && P.layers.length === res.planes.length,
    sc.layerStarts.length + ' tags, ' + P.layers.length + ' planned, ' + res.planes.length + ' planes');

  // ===========================================================================
  section('3. Speeds: min(feature speed, volumetric limit / bead area), the first layer\'s own, the layer-time slowdown on top');
  // ===========================================================================
  const stadium = (w, h) => PL.beadArea(w, h);
  const expectV = (feature, w, h, first) => {
    const fs = PL.featureSpeed(S, feature, first);
    return Math.min(fs.v, S.filament.maxVolumetric / stadium(w, h));
  };
  // every extruding move: its F against its feature's expected speed on that layer
  let over = 0, under = 0, nMoves = 0, slowed = 0;
  const topSpeed = {};
  sc.moves.forEach(mv => {
    const first = mv.layer === 0;
    const w = mv.feature === 'Bridge' ? S.nozzleMm : mv.lw, h = mv.feature === 'Bridge' ? S.nozzleMm : mv.lh;
    const want = expectV(mv.feature, w, h, first) * 60;
    nMoves++;
    if (mv.F > want + 0.01) over++;
    else if (mv.F < want - 0.01) { slowed++; if (mv.F < S.cooling.slow_down_min_speed * 60 - 0.01 && mv.F < want - 0.01) under++; }
    const k = mv.feature + (first ? ' L1' : '');
    topSpeed[k] = Math.max(topSpeed[k] || 0, mv.F);
  });
  check('no extruding move is faster than its feature allows (' + nMoves + ' moves)', over === 0, over + ' too fast');
  check('...and none is slower than slow_down_min_speed (' + S.cooling.slow_down_min_speed + ' mm/s) unless its feature is', under === 0, under + ' under');
  const topWant = (feature, first) => {
    // the widest/narrowest beads differ; compare against the speed at the bead the layer printed
    const mv = sc.moves.filter(m => m.feature === feature && (m.layer === 0) === first).sort((a, b) => b.F - a.F)[0];
    return mv ? { got: mv.F, want: expectV(feature, feature === 'Bridge' ? S.nozzleMm : mv.lw, feature === 'Bridge' ? S.nozzleMm : mv.lh, first) * 60 } : null;
  };
  const exact = [];
  ['Outer wall', 'Inner wall', 'Top surface', 'Support'].forEach(f => {
    const t = topWant(f, false);
    if (t) exact.push(f + ' ' + t.got.toFixed(1) + ' (template ' + t.want.toFixed(1) + ')');
    check('the unslowed ' + f + ' prints at the template\'s speed', t && near(t.got, t.want, 0.01), t && (t.got + ' vs ' + t.want));
  });
  const l1 = (f) => { const t = topWant(f, true); return t; };
  const l1w = l1('Outer wall');
  check('layer 1: the outer wall at initial_layer_speed (' + S.speed.first + ' mm/s = F' + S.speed.first * 60 + ')', l1w && l1w.got === S.speed.first * 60, l1w && l1w.got);
  const l1b = l1('Bottom surface');
  check('layer 1: the bottom surface at initial_layer_infill_speed (' + S.speed.firstInfill + ' mm/s = F' + S.speed.firstInfill * 60 + ')', l1b && l1b.got === S.speed.firstInfill * 60, l1b && l1b.got);
  const br = sc.moves.filter(m => m.feature === 'Bridge');
  check('a bridge prints at bridge_speed (F' + S.speed.bridge * 60 + ') as a round bead of the nozzle\'s diameter',
    br.length > 0 && br.every(m => near(m.F, S.speed.bridge * 60, 0.01) && near(m.lw, S.nozzleMm, 1e-9) && near(m.lh, S.nozzleMm, 1e-9)), br.length + ' bridge moves');
  const accels = [...sc.accels].sort((a, b) => a - b);
  const okA = new Set([S.accel.first, S.accel.def, S.accel.outer, S.accel.top, S.accel.travel, S.accel.short, S.accel.firstTravel, S.accel.inner, S.accel.sparse, S.accel.solid, S.accel.support, S.accel.interface, S.accel.bridge]);
  check('every M204 is one the template names (' + accels.join(', ') + ')', accels.every(a => okA.has(a)), accels.join(', '));
  check('layer-time slowdown happens on the small layers (' + slowed + ' moves below their feature\'s speed), and the first layer is never slowed',
    slowed > 0 && sc.moves.filter(m => m.layer === 0).every(m => m.F <= S.speed.firstInfill * 60 + 0.01), slowed + ' slowed');

  // ===========================================================================
  section('4. Retraction, wipe, z-hop');
  // ===========================================================================
  // state machine over the retract/deretract events
  let retr = 0, deretr = 0, bad = 0, wipes = 0, state = 0;
  const lines = P.gcode.split('\n');
  let cur = 0;
  const cycles = [];
  let acc = 0;
  sc.retracts.forEach(r => {
    if (r.deretract) {
      if (state === 0) bad++;
      cycles.push(acc); acc = 0; state = 0; deretr++;
      if (!near(r.e, S.retract.length, 1e-6)) bad++;
    } else {
      if (state === 1 && acc === 0) bad++;
      state = 1; acc += -r.e; retr++;
      if (r.wipe) wipes++;
    }
  });
  check('every retraction is undone by one deretraction of ' + S.retract.length + ' mm (' + retr + ' retract moves, ' + deretr + ' deretractions)', bad === 0 && retr >= deretr, 'bad ' + bad);
  check('...and each retract cycle sums to exactly ' + S.retract.length + ' mm of backed-off filament (wipe + the last bit)',
    cycles.length > 100 && cycles.every(c => near(c, S.retract.length, 2e-5)), 'min ' + Math.min(...cycles) + ' max ' + Math.max(...cycles));
  check('the wipe is on: retraction happens along the path just printed (' + wipes + ' wipe moves)', wipes > cycles.length, wipes + '');
  const hops = sc.hops.filter(h => h.z > h.layerZ + 1e-6);
  check('z-hop is ' + S.retract.hop + ' mm above the layer it lifts from, every time',
    hops.length > 100 && hops.every(h => near(h.z, h.layerZ + S.retract.hop, 1e-3) || near(h.z, h.from + S.retract.hop, 1e-3)),
    hops.filter(h => !(near(h.z, h.layerZ + S.retract.hop, 1e-3) || near(h.z, h.from + S.retract.hop, 1e-3))).slice(0, 3).map(h => JSON.stringify(h)).join(' '));

  // ===========================================================================
  section('5. Temperatures, bed, fans');
  // ===========================================================================
  const noz = sc.temps.filter(t => t.code === 104 || t.code === 109), bed = sc.temps.filter(t => t.code === 140 || t.code === 190);
  check('nozzle and bed from the template filament (' + S.temp.nozzleInitial + ' / ' + S.temp.bedInitial + ')',
    noz.some(t => t.s === S.temp.nozzleInitial) && bed.some(t => t.s === S.temp.bedInitial), JSON.stringify(sc.temps.slice(0, 4)));
  const fanByLayer = {};
  const fansBody = sc.fans.slice(0, sc.fans.length && sc.fans[sc.fans.length - 1].s === 0 && sc.fans[sc.fans.length - 1].layer === sc.layerStarts.length - 1 ? -1 : undefined);   // the tail's M106 S0 is the end block's
  fansBody.forEach(f => { (fanByLayer[f.layer] = fanByLayer[f.layer] || []).push(f.s); });
  const C = S.cooling;
  check('layer 1: fan off (close_fan_the_first_x_layers = ' + S.fan.closeFirst + ')', fanByLayer[0] && fanByLayer[0][0] === 0, JSON.stringify(fanByLayer[0]));
  const ovS = Math.round(C.overhang_fan_speed * 255) / 100;
  const layerFans = Object.keys(fanByLayer).filter(k => +k >= S.fan.closeFirst).flatMap(k => fanByLayer[k]).filter(v => v !== ovS);
  check('later layers: the fan is between fan_min_speed ' + C.fan_min_speed + ' % and fan_max_speed ' + C.fan_max_speed + ' % (NSO\'s keys)',
    layerFans.length > 10 && layerFans.every(v => v >= C.fan_min_speed * 2.55 - 0.01 && v <= C.fan_max_speed * 2.55 + 0.01),
    'min ' + Math.min(...layerFans) + ' max ' + Math.max(...layerFans));
  const overhangFan = sc.fans.filter(f => f.s === Math.round(C.overhang_fan_speed * 255) / 100);
  check('bridges and overhang walls get overhang_fan_speed (' + C.overhang_fan_speed + ' % = S255), and the layer\'s fan is restored after',
    overhangFan.length > 0 && sc.fans.every((f, i) => i === 0 || f.s !== sc.fans[i - 1].s), overhangFan.length + ' switches');

  // ===========================================================================
  section('6. E: the stadium bead x the template\'s flow ratio, recovered by the importer');
  // ===========================================================================
  let worst = 0;
  parsed.moves.filter(m => m.layer < 3 && m.length > 1).forEach(m => {
    const want = m.feature === 'Bridge' ? S.nozzleMm : null;
    const sl = res.objects.flatMap(o => o.layers[m.layer] ? o.layers[m.layer].paths : []);
    const ws = sl.filter(p => p.feature === m.feature).map(p => p.width);
    const w = want || (ws.length ? ws.reduce((a, b) => a + b) / ws.length : m.width);
    worst = Math.max(worst, Math.abs(m.width * S.filament.flow - w * S.filament.flow) / 1);
  });
  const e0 = sc.moves.find(m => m.feature === 'Outer wall' && m.layer > 3);
  const ePerMm = e0.e / e0.len;
  const wantE = stadium(e0.lw, e0.lh) / (Math.PI * 1.75 * 1.75 / 4) * S.filament.flow;
  check('an outer-wall move\'s E/mm is the stadium x 0.98 (' + ePerMm.toFixed(5) + ' against Bambu\'s own 0.03073)', near(ePerMm, wantE, 2e-4) && near(ePerMm, 0.03073, 3e-4), ePerMm + ' vs ' + wantE);

  // ===========================================================================
  section('7. Start and end: Studio\'s own expanded blocks, the plate\'s numbers put in');
  // ===========================================================================
  const FZ = require('./freeze.js');
  const fresh = JSON.stringify((await FZ.build('a1mini-0.4')).frozen, null, 1) + '\n';
  check('the frozen blocks are a fresh freeze of the owner\'s slice (node tools/print-planner/freeze.js)',
    fresh === require('fs').readFileSync(path.join(ROOT, 'fixtures', 'print-planner', 'a1mini-0.4', 'frozen.json'), 'utf8'));
  const plines = P.gcode.split('\n'), blines = A.gcode.split('\n');
  const slab = (ls, a, b) => { const i = ls.indexOf(a), j = ls.indexOf(b); return ls.slice(i, j + 1); };
  const noM73 = ls => ls.filter(l => !/^M73 P\d+ R\d+$/.test(l));
  const pStart = noM73(slab(plines, 'M201 X20000 Y20000 Z1500 E5000', '; MACHINE_START_GCODE_END'));
  const bStart = noM73(slab(blines, 'M201 X20000 Y20000 Z1500 E5000', '; MACHINE_START_GCODE_END'));
  const diffs = (x, y) => { const d = []; x.forEach((l, i) => { if (l !== y[i]) d.push([l, y[i]]); }); return x.length === y.length ? d : null; };
  const dStart = diffs(pStart, bStart);
  check('the machine start block is Studio\'s for the plate, line for line (' + pStart.length + ' lines)', dStart && dStart.length <= 1 && dStart.every(d => /^\s*G29 A1 X/.test(d[0])),
    dStart ? JSON.stringify(dStart.slice(0, 4)) : pStart.length + ' vs ' + bStart.length);
  check('...the one line that differs is the bed-leveling box: this plate\'s first layer, within 2 mm of Studio\'s (the owner\'s slice has an older support pad) (' + (dStart && dStart[0] ? dStart[0][0].trim() + ' against ' + dStart[0][1].trim() : 'none') + ')',
    !dStart || !dStart[0] || (() => { const a = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(dStart[0][0]), b = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(dStart[0][1]);
      return [1, 2, 3, 4].every(k => near(+a[k], +b[k], 2)); })());
  const pEnd = slab(plines, '; MACHINE_END_GCODE_START', 'M17 R ; restore z current');
  const bEnd = slab(blines, '; MACHINE_END_GCODE_START', 'M17 R ; restore z current');
  const dEnd = diffs(pEnd, bEnd);
  check('the end block is Studio\'s, line for line; only the head-lift heights and the safe-position Y differ (' + pEnd.length + ' lines)',
    dEnd && dEnd.every(d => /^\s*G1 (Z|X0 Y)/.test(d[0])) && dEnd.length === 4, dEnd ? JSON.stringify(dEnd.slice(0, 4)) : pEnd.length + ' vs ' + bEnd.length);
  const maxZ = res.planes[res.planes.length - 1].printZ;
  check('...the lift is max_layer_z + 0.4 / + 100 / + 98 of THIS plate (' + maxZ.toFixed(1) + ')',
    pEnd.includes('G1 Z' + String(+(maxZ + 0.4).toFixed(4)) + ' F900 ; lower z a little') && pEnd.includes('    G1 Z' + String(+(maxZ + 100).toFixed(4)) + ' F600') && pEnd.includes('    G1 Z' + String(+(maxZ + 98).toFixed(4))));
  // temperatures: only the template's own expressions move
  const hot = JSON.parse(JSON.stringify(tpl));
  hot.nozzle_temperature_initial_layer = ['230', '230']; hot.nozzle_temperature = ['225', '225'];
  hot.textured_plate_temp_initial_layer = ['70', '70'];
  const H = PL.plan(res, { config: hot, printer: PR });
  const hs = noM73(slab(H.gcode.split('\n'), 'M201 X20000 Y20000 Z1500 E5000', '; MACHINE_START_GCODE_END'));
  const dHot = diffs(hs, pStart);
  const changed = dHot ? dHot.map(d => d[1].trim() + ' -> ' + d[0].trim()) : [];
  check('a hotter filament and bed change exactly the template\'s temperature lines (' + changed.length + ') and nothing else',
    dHot && changed.length === 8 && dHot.every(d => /^\s*(M140 S|M190 S|M109 S|M104 S)/.test(d[0])) &&
      hs.includes('M140 S70') && hs.includes('M190 S70;set bed temp') && hs.includes('    M109 S230') && hs.includes('    M109 S210 ; drop nozzle temp, make filament shink a bit') &&
      hs.includes('    M104 S190') && hs.includes('M109 S225') && hs.includes('M104 S230') &&
      hs.includes('    M104 S220') && hs.includes('M104 S170'),
    changed.join(' | '));
  check('...the literals stay (flush at 220, 170 / 140 for the bed wait): they are the template\'s, not the filament\'s',
    hs.includes('    M620.1 E F299.339 T220') && hs.includes('M109 S170') && hs.includes('M104 S140'));
  const off = PL.plan(res, { config: tpl, printer: Object.assign({}, PR, { bed: { x: 60, y: 60, z: 180 } }) });
  check("a plate that is not on the bed is refused, not clipped", !off.ok && /not on the Bambu Lab A1 mini/.test(off.reason), off.reason);

  // ---- the P1S, from the owner's P1S slice of the bare arc
  const PS = L.printer('p1s-0.4'), p1sCfg = await L.p1sTemplate();
  const BP = await L.bambuSlice('fixtures/supports/simple_overhang_p1s.gcode.3mf');
  check('the P1S blocks are a fresh freeze of the owner\'s P1S slice',
    JSON.stringify((await FZ.build('p1s-0.4')).frozen, null, 1) + '\n' === require('fs').readFileSync(path.join(ROOT, 'fixtures', 'print-planner', 'p1s-0.4', 'frozen.json'), 'utf8'));
  const pb = await L.plateB(128, 128, false);
  const PP = PL.plan(pb.res, { config: p1sCfg, printer: PS });
  check('the arc plans for the P1S', PP.ok, PP.reason);
  const ppl = PP.gcode.split('\n'), bpl = BP.gcode.split('\n');
  const psS = noM73(slab(ppl, 'M203 X500 Y500 Z20 E30', '; MACHINE_START_GCODE_END')), bsS = noM73(slab(bpl, 'M203 X500 Y500 Z20 E30', '; MACHINE_START_GCODE_END'));
  const dS = diffs(psS, bsS);
  check('the P1S start block is Studio\'s, line for line (' + psS.length + ' lines); the bed-leveling box is the one line that differs',
    dS && dS.length === 1 && /^\s*G29 A X/.test(dS[0][0]), dS ? JSON.stringify(dS) : psS.length + ' vs ' + bsS.length);
  const pe = slab(ppl, '; MACHINE_END_GCODE_START', 'M17 R ; restore z current'), be = slab(bpl, '; MACHINE_END_GCODE_START', 'M17 R ; restore z current');
  const dE = diffs(pe, be);
  const topP = Math.max(...pb.res.objects[0].layers.filter(l => l.paths.length).map(l => l.printZ));
  check('...and its end block, but for the lift heights - which are this plate\'s (its last layer is ' + topP.toFixed(1) + ' mm: Studio\'s 48.8 as well, so none differ)',
    dE && dE.every(d => /^\s*G1 Z/.test(d[0])) && (near(topP, 48.8, 1e-6) ? dE.length === 0 : dE.length === 3), dE ? JSON.stringify(dE) : pe.length + ' vs ' + be.length);

  // ===========================================================================
  section('8. Markers, as Bambu writes them');
  // ===========================================================================
  const g = P.gcode.split('\n');
  const at = (re, from) => { for (let i = from || 0; i < g.length; i++) if (typeof re === 'string' ? g[i] === re : re.test(g[i])) return i; return -1; };
  const idx = {
    h0: at('; HEADER_BLOCK_START'), h1: at('; HEADER_BLOCK_END'), c0: at('; CONFIG_BLOCK_START'), c1: at('; CONFIG_BLOCK_END'),
    x0: at('; EXECUTABLE_BLOCK_START'), ms: at('; MACHINE_START_GCODE_END'), l0: at('; CHANGE_LAYER'), me: at('; MACHINE_END_GCODE_START'),
    x1: at('; EXECUTABLE_BLOCK_END')
  };
  const lastLayer = g.lastIndexOf('; CHANGE_LAYER');
  const ordered = [idx.h0, idx.h1, idx.c0, idx.c1, idx.x0, idx.ms, idx.l0, lastLayer, idx.me, idx.x1];
  check('HEADER, CONFIG and EXECUTABLE blocks in Bambu\'s order: MACHINE_START_GCODE_END before layer 1, MACHINE_END_GCODE_START after the last layer',
    ordered.every((v, i) => v >= 0 && (i === 0 || v > ordered[i - 1])), JSON.stringify(idx));
  check('EXECUTABLE_BLOCK_END is the last thing in the file, after M73 P100 R0', g.filter(l => l).pop() === '; EXECUTABLE_BLOCK_END' && g[idx.x1 - 1] === 'M73 P100 R0');
  const bg = A.gcode.split('\n');
  const bIdx = n => bg.indexOf(n);
  check('...the same order as the owner\'s own slice', ['; HEADER_BLOCK_START', '; HEADER_BLOCK_END', '; CONFIG_BLOCK_START', '; CONFIG_BLOCK_END', '; EXECUTABLE_BLOCK_START', '; MACHINE_START_GCODE_END', '; MACHINE_END_GCODE_START', '; EXECUTABLE_BLOCK_END']
    .map(bIdx).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])));
  // header
  const hdr = {};
  g.slice(idx.h0, idx.h1).forEach(l => { const m = /^; ([^:]+?)\s*:\s*(.*)$/.exec(l); if (m) hdr[m[1]] = m[2]; });
  const bh = {};
  bg.slice(bIdx('; HEADER_BLOCK_START'), bIdx('; HEADER_BLOCK_END')).forEach(l => { const m = /^; ([^:]+?)\s*:\s*(.*)$/.exec(l); if (m) bh[m[1]] = m[2]; });
  check('the header has every field Studio\'s has, in its order', JSON.stringify(Object.keys(hdr)) === JSON.stringify(Object.keys(bh)), Object.keys(hdr).join(' | ') + '\n          ' + Object.keys(bh).join(' | '));
  check('...with this plate\'s numbers: layers ' + hdr['total layer number'] + ', labels ' + hdr['model label id'] + ', max z ' + hdr.max_z_height,
    +hdr['total layer number'] === res.planes.length && hdr['model label id'] === P.labels.map(l => l.id).join(',') && +hdr.max_z_height === +P.stats.maxZ.toFixed(2) &&
      hdr.filament_density === bh.filament_density && hdr.filament_diameter === bh.filament_diameter);
  const dur = s => { let t = 0; s.replace(/(\d+)([dhms])/g, (a, n, u) => { t += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u]; return a; }); return t; };
  const mt = /^(.*?); total estimated time: (.*)$/.exec(hdr['model printing time']);
  check('...times written as "Xm Ys"; total = model + start + end (' + hdr['model printing time'] + ')', !!mt && /^(\d+h )?\d+m \d+s$/.test(mt[1].trim()) &&
    Math.abs(dur(mt[1]) + 365 - dur(mt[2])) <= 2, hdr['model printing time']);
  // config
  const cfgOut = configBlock(P.gcode);
  check('the CONFIG_BLOCK is Studio\'s, with NSO\'s cooling keys put in (slow_down_layer_time ' + cfgOut.slow_down_layer_time + ' against Studio\'s ' + cfgA.slow_down_layer_time + ')',
    Object.keys(cfgOut).length === Object.keys(cfgA).length && cfgOut.slow_down_layer_time === '6,6' && cfgOut.fan_max_speed === '80,80' && cfgOut.outer_wall_speed === cfgA.outer_wall_speed &&
      Object.keys(cfgA).filter(k => cfgOut[k] !== cfgA[k]).every(k => Object.prototype.hasOwnProperty.call(require(path.join(ROOT, 'nso-cooling-profiles.js')).DEFAULT_VALUES, k)),
    Object.keys(cfgA).filter(k => cfgOut[k] !== cfgA[k]).join(', '));
  // layers
  const layerErrs = [];
  let nl = 0;
  g.forEach((l, i) => {
    if (l !== '; CHANGE_LAYER') return;
    nl++;
    const z = res.planes[P.layers[nl - 1].index].printZ;
    const win = g.slice(i, i + 40);
    if (g[i + 1] !== '; Z_HEIGHT: ' + String(+z.toFixed(4))) layerErrs.push(nl + ' Z_HEIGHT ' + g[i + 1]);
    if (!/^; LAYER_HEIGHT: 0\.2$/.test(g[i + 2])) layerErrs.push(nl + ' LAYER_HEIGHT ' + g[i + 2]);
    if (!win.includes('; layer num/total_layer_count: ' + nl + '/' + P.layers.length)) layerErrs.push(nl + ' layer num');
    if (!win.includes('M73 L' + nl)) layerErrs.push(nl + ' M73 L');
    if (!win.includes('M991 S0 P' + (nl - 1) + ' ;notify layer change')) layerErrs.push(nl + ' M991');
    if (!win.includes('; update layer progress')) layerErrs.push(nl + ' update');
  });
  check('every layer: CHANGE_LAYER, Z_HEIGHT, LAYER_HEIGHT, "layer num/total_layer_count: n/N", M73 L n, M991 S0 P n-1 (' + nl + ' layers)', nl === P.layers.length && layerErrs.length === 0, layerErrs.slice(0, 4).join('; '));
  // M73 P/R
  const m73 = []; g.forEach((l, i) => { const m = /^M73 P(\d+) R(\d+)$/.exec(l); if (m) m73.push([+m[1], +m[2], i]); });
  check('M73 P/R is monotonic (P never down, R never up), starts at P0 and ends at P100 R0 (' + m73.length + ' markers)',
    m73.length > 50 && m73[0][0] === 0 && m73[m73.length - 1][0] === 100 && m73[m73.length - 1][1] === 0 && m73.every((v, i) => i === 0 || (v[0] >= m73[i - 1][0] && v[1] <= m73[i - 1][1])),
    JSON.stringify(m73.slice(0, 3)));
  check('...R at the start is the total in whole minutes (' + m73[0][1] + ' min of ' + mt[2].trim() + ')', m73[0][1] === Math.floor(dur(mt[2]) / 60));
  // objects: labels, masks, balance
  const ids = P.labels.map(l => l.id);
  let open = -1, bal = 0, outside = 0, wrongMask = 0, masks = {}, objStarts = 0;
  const maskOf = i => PL.objectMask([i]);
  const allM = PL.objectMask(ids.map((v, i) => i));
  g.forEach((l, i) => {
    let m;
    if ((m = /^; start printing object, unique label id: (\d+)$/.exec(l))) {
      if (open !== -1) bal = 99; open = +m[1]; objStarts++;
      const mk = /^M624 (\S+)$/.exec(g[i + 1]);
      if (!mk || mk[1] !== maskOf(ids.indexOf(open))) wrongMask++;
      masks[g[i + 1]] = (masks[g[i + 1]] || 0) + 1;
    } else if ((m = /^; stop printing object, unique label id: (\d+)$/.exec(l))) {
      if (open !== +m[1] || g[i + 1] !== 'M625') bal = 99; open = -1;
    } else if (/^G1 X\S+ Y\S+ E[\d.]+$/.test(l) && i > idx.l0 && i < idx.me && open === -1) {
      outside++;
    }
  });
  check('object blocks balanced: every "start printing object" has its stop + M625, none nested, none left open (' + objStarts + ' blocks)', objStarts > 100 && bal === 0 && open === -1, 'bal ' + bal);
  check('...M624 carries the object\'s bit: ' + ids[0] + ' = ' + maskOf(0) + ', ' + ids[1] + ' = ' + maskOf(1) + ' (Studio\'s own: AQAAAAAAAAA= and AgAAAAAAAAA=)', wrongMask === 0 && maskOf(0) === 'AQAAAAAAAAA=' && maskOf(1) === 'AgAAAAAAAAA=' && allM === 'AwAAAAAAAAA=', JSON.stringify(masks));
  check('...no extrusion outside an open block', outside === 0, outside + ' moves');
  const hooksN = g.filter(l => l === '; SKIPTYPE: timelapse').length, ends = g.filter(l => /^; object ids of this layer\d+ end: /.test(l)).length, starts = g.filter(l => /^; object ids of layer \d+ start: /.test(l)).length;
  check('the layer hook (timelapse + nozzle-clog) is in every layer, wrapped in the union mask ' + allM + ' (' + hooksN + ' hooks, ' + starts + ' / ' + ends + ' id lines)', hooksN === nl && starts === nl && ends === nl && g.filter(l => l === 'M624 ' + allM).length === nl);
  const cnt = re => g.filter(l => re.test(l)).length;
  check('WIPE_START / WIPE_END and SKIPPABLE_START / SKIPPABLE_END are balanced', cnt(/^; WIPE_START$/) === cnt(/^; WIPE_END$/) && cnt(/^; SKIPPABLE_START$/) === cnt(/^; SKIPPABLE_END$/) && cnt(/^; WIPE_START$/) > 1000);
  // features: exact names, supports typed
  const fset = new Set(g.filter(l => /^; FEATURE: /.test(l)).map(l => l.slice(11)));
  const bset = new Set(bg.filter(l => /^; FEATURE: /.test(l)).map(l => l.slice(11)));
  check('; FEATURE names are Bambu\'s, exactly: ' + [...fset].join(', '), [...fset].every(f => f === 'Custom' || bset.has(f) || SUPPORT_FEATURES.includes(f) || f === 'Gap infill'), [...fset].filter(f => !bset.has(f)).join(', '));
  const role = ids.map((id, i) => res.objects[i].role);
  const featuresBy = {};
  let curObj = null;
  g.forEach(l => {
    let m;
    if ((m = /^; OBJECT_ID: (\d+)$/.exec(l))) curObj = +m[1];
    else if ((m = /^; FEATURE: (.*)$/.exec(l))) featuresBy[curObj + '|' + m[1]] = 1;
  });
  const supFeat = Object.keys(featuresBy).filter(k => role[ids.indexOf(+k.split('|')[0])] === 'support').map(k => k.split('|')[1]);
  const partFeat = Object.keys(featuresBy).filter(k => role[ids.indexOf(+k.split('|')[0])] === 'part').map(k => k.split('|')[1]);
  check('the support object\'s paths are Support / Support interface / Support transition and nothing else (never Overhang wall): ' + [...new Set(supFeat)].join(', '),
    supFeat.length > 0 && supFeat.every(f => SUPPORT_FEATURES.includes(f)) && !partFeat.some(f => SUPPORT_FEATURES.includes(f)));
  // hooks per profile
  const bare = PL.plan(res, { config: tpl, printer: PR, hooks: { timelapse: false, clog: false, spaghetti: false } });
  const og = bare.gcode.split('\n');
  check('hooks per profile: with timelapse, clog and spaghetti off the file has no SKIPPABLE block, no M981, no per-layer union mask',
    bare.ok && !og.includes('; SKIPPABLE_START') && !og.some(l => /^M981 /.test(l)) && !og.includes('M624 ' + allM));
  const tlOnly = PL.plan(res, { config: tpl, printer: PR, hooks: { clog: false } }).gcode.split('\n');
  check('...timelapse alone has the photo and no head_wrap_detect; the default has both and the spaghetti detector (' + g.filter(l => /^M981 /.test(l)).join(' / ') + ')',
    tlOnly.includes('; SKIPTYPE: timelapse') && !tlOnly.includes('; SKIPTYPE: head_wrap_detect') && g.includes('; SKIPTYPE: head_wrap_detect') && g.filter(l => /^M981 /.test(l)).length === 2);
  // single object: labels off, as Studio does
  const pb1 = await L.plateB(90, 90, false);
  const one = PL.plan(pb1.res, { config: tpl, printer: PR });
  const og1 = one.gcode.split('\n');
  check('one object on the plate: OBJECT_ID per layer, but no labelling - no M624 / M625, no "start printing object", no label id in the header (Studio\'s own arc slice has none either)',
    one.ok && !one.labelled && !og1.some(l => /^M62[45]/.test(l) || /printing object|model label id/.test(l)) && og1.filter(l => /^; OBJECT_ID: /.test(l)).length === one.stats.layers);
  // three objects: the arc with two NSO trees
  const pb3 = await L.plateB(90, 90, true);
  const tri = PL.plan(pb3.res, { config: tpl, printer: PR });
  const tg = tri.ok ? tri.gcode.split('\n') : [];
  const tmask = tg.filter(l => /^M624 /.test(l)).reduce((a, l) => { a[l] = (a[l] || 0) + 1; return a; }, {});
  check('three objects (the arc and two trees): masks are bits 0, 1, 2 - ' + Object.keys(tmask).join(' ') + '; the hook\'s union is BwAAAAAAAAA=',
    tri.ok && pb3.res.objects.length === 3 && tri.labelled && 'M624 AQAAAAAAAAA=' in tmask && 'M624 AgAAAAAAAAA=' in tmask && 'M624 BAAAAAAAAAA=' in tmask && 'M624 BwAAAAAAAAA=' in tmask && PL.objectMask([0, 1, 2]) === 'BwAAAAAAAAA=',
    tri.ok ? JSON.stringify(tmask) : tri.reason);

  // ===========================================================================
  section('9. Structural: the .gcode.3mf, and G-scope\'s import of it');
  // ===========================================================================
  const G3 = require(path.join(ROOT, 'nso-gcode3mf-write.js'));
  const W3 = require(path.join(ROOT, 'nso-3mf.js'));
  const built = await PL.toGcode3mf(res, { config: tpl, printer: PR });
  const back = await G3.read(built.bytes);
  const refParts = A.zip.names();
  const myZip = L.R.openZip(built.bytes);
  check('the .gcode.3mf has the reference\'s parts, in its order (' + myZip.names().length + ')',
    JSON.stringify(myZip.names().filter(n => !/^Auxiliaries/.test(n))) === JSON.stringify(refParts.filter(n => !/^Auxiliaries/.test(n))), myZip.names().join(', '));
  check('plate_1.gcode.md5 is the G-code\'s MD5 and the G-code is the plan\'s, byte for byte', back && built.fields && require('crypto').createHash('md5').update(Buffer.from(P.gcode)).digest('hex').toUpperCase() === L.text(await myZip.read('Metadata/plate_1.gcode.md5')).trim() &&
    L.text(await myZip.read('Metadata/plate_1.gcode')) === built.plan.gcode);
  const ps = JSON.parse(L.text(await myZip.read('Metadata/project_settings.config')));
  check('project_settings.config is the template with NSO\'s cooling keys on every slot (slow_down_layer_time ' + ps.slow_down_layer_time + ', fan_max_speed ' + ps.fan_max_speed + ')',
    JSON.stringify(ps.slow_down_layer_time) === '["6","6"]' && JSON.stringify(ps.fan_max_speed) === '["80","80"]' && ps.outer_wall_speed[0] === '200' && ps.printer_model === 'Bambu Lab A1 mini');
  const si = L.text(await myZip.read('Metadata/slice_info.config'));
  check('slice_info: the printer (N1), the plan\'s prediction (' + built.plan.stats.seconds.total.toFixed(0) + ' s), the plate\'s objects by label',
    /key="printer_model_id" value="N1"/.test(si) && new RegExp('key="prediction" value="' + Math.round(built.plan.stats.seconds.total) + '"').test(si) &&
      built.plan.labels.every(l => si.includes('identify_id="' + l.id + '"')), si.slice(0, 300));
  const imp = await Lines.readSlicedGcode3MF(built.bytes, { name: 'planned.gcode.3mf' });
  const direct = Lines.parseGcode(built.plan.gcode);
  check('G-scope\'s import route reads it: ' + imp.parsed.moves.length + ' moves in ' + imp.parsed.features.length + ' features, the same as parseGcode on the text, nothing assumed',
    imp.parsed.moves.length === direct.moves.length && imp.parsed.features.length === direct.features.length && !imp.parsed.meta.assumed);
  const ppy = await PL.toGcode3mf(pb.res, { config: p1sCfg, printer: PS });
  const ppyBack = L.R.openZip(ppy.bytes);
  check('the P1S file: model id C12 from the owner\'s slice_info, and it imports (' + ppy.plan.stats.layers + ' layers)',
    /key="printer_model_id" value="C12"/.test(L.text(await ppyBack.read('Metadata/slice_info.config'))) && (await Lines.readSlicedGcode3MF(ppy.bytes, { name: 'p1s.gcode.3mf' })).parsed.moves.length > 10000);

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.log('  FAIL  the gate threw: ' + ((err && err.stack) || err)); process.exit(1); });

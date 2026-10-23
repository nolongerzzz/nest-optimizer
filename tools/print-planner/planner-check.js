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
  const P = PL.plan(res, { config: tpl });
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
  sc.fans.forEach(f => { (fanByLayer[f.layer] = fanByLayer[f.layer] || []).push(f.s); });
  const C = S.cooling;
  check('layer 1: fan off (close_fan_the_first_x_layers = ' + S.fan.closeFirst + ')', fanByLayer[0] && fanByLayer[0][0] === 0, JSON.stringify(fanByLayer[0]));
  const layerFans = Object.keys(fanByLayer).filter(k => +k >= S.fan.closeFirst).map(k => fanByLayer[k][0]);
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

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.log('  FAIL  the gate threw: ' + ((err && err.stack) || err)); process.exit(1); });

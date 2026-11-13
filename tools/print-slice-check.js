#!/usr/bin/env node
/*
 * print:slice - the Slice card's non-UI logic (app-print.js): the plate's
 * pieces -> the engine's input -> the planner -> a .gcode.3mf.
 *
 *   node tools/print-slice-check.js
 *
 * The card (left bar, SLICE) is driven in a browser by the audit driver session,
 * not here. This holds what it stands on:
 *
 *   - the plate's printer profile (A1 mini; the P1S plate takes the P1S - the owner's mouse1 project; A1 / X1C none)
 *   - the viewport's plate (centred on 0,0) put on the printer's bed, and
 *     round-tripped against the plate the planner gate slices
 *   - a plate with supports through build(): the FEATURE lines carry Support,
 *     Support interface and Support transition, and the file passes the same
 *     packager checks print:planner holds the planner to
 *   - what the card shows (layers, time, grams) is the planner's own figures
 *   - a plate the planner refuses comes back with the planner's words
 *   - the markup and the load order: Slice, G-scope, Check & repair in that order
 *     in the left bar, G-scope's button untouched, and no G-scope file loads the
 *     planner or the packager or reads this card's file
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./print-planner/lib.js');
const { ROOT } = L;
const PRINT = require(path.join(ROOT, 'app-print.js'));
const PL = require(path.join(ROOT, 'nso-print-planner.js'));
const G3 = require(path.join(ROOT, 'nso-gcode3mf-write.js'));
const Lines = require(path.join(ROOT, 'nso-gcode-lines.js'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'ok    ' : 'FAIL  ') + label + (detail !== undefined && (!ok || process.env.VERBOSE) ? '\n          ' + detail : ''));
}
function section(t) { console.log('\n== ' + t); }
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SUPPORT_FEATURES = ['Support', 'Support interface', 'Support transition'];

/** A fixture plate (bed coordinates, as the planner gate builds it) as the plate hands it to the card:
 *  Z-up millimetres about the plate's centre, a support carrying its host. */
function asViewportPieces(objs, bed, shift) {
  return objs.map((o, i) => {
    const soup = new Float32Array(o.soup.length);
    for (let k = 0; k < soup.length; k += 3) {
      soup[k] = o.soup[k] - bed.x / 2 + (shift || 0);
      soup[k + 1] = o.soup[k + 1] - bed.y / 2;
      soup[k + 2] = o.soup[k + 2];
    }
    const support = o.role === 'support';
    return { name: o.name, soup, sourceId: i + 1, support, hostSourceId: support ? 1 : undefined, nonSolid: false };
  });
}

async function main() {
  const tpl = await L.a1Template();
  const a1 = L.printer('a1mini-0.4');

  // ===========================================================================
  section('1. The plate\'s printer profile');
  // ===========================================================================
  const pa = PRINT.profileFor('a1mini'), pp = PRINT.profileFor('p1s');
  check('the A1 mini plate has the A1 mini 0.4 profile, the P1S plate the P1S 0.4 one (the owner\'s mouse1 project)',
    pa && pa.id === 'a1mini-0.4' && pp && pp.id === 'p1s-0.4' && /bambu-templates\/p1s-0\.4\/project_test\.3mf$/.test(pp.template), JSON.stringify([pa, pp]));
  check('a plate with no profile (A1 / X1C - an A1 is not sent P1S G-code -, Prusa, Ender, Custom, nothing) has none, and the prototype chain is not one',
    ['a1', 'prusa', 'ender', 'custom', '', null, undefined, 'toString', 'constructor'].every(id => PRINT.profileFor(id) === null));
  check('every profile points at files that exist: the frozen blocks and the template',
    Object.values(PRINT.PROFILES).every(p => fs.existsSync(path.join(ROOT, p.frozen)) && fs.existsSync(path.join(ROOT, p.template))));
  check('...and the frozen blocks are for the printer the profile names (model id N1 / C12)',
    JSON.parse(read(pa.frozen)).id === pa.id && JSON.parse(read(pp.frozen)).id === pp.id &&
      JSON.parse(read(pa.frozen)).modelId === 'N1' && JSON.parse(read(pp.frozen)).modelId === 'C12');
  for (const p of Object.values(PRINT.PROFILES)) {
    const cfg = await PRINT.readTemplate(new Uint8Array(fs.readFileSync(path.join(ROOT, p.template))));
    check(p.short + ': the template\'s project settings read out of the file the page fetches (printer_model "' + cfg.printer_model + '", nozzle ' + cfg.nozzle_diameter + ')',
      cfg.printer_model === JSON.parse(read(p.frozen)).printer && String(cfg.nozzle_diameter).includes('0.4'), JSON.stringify([cfg.printer_model, cfg.nozzle_diameter]));
  }
  check('...and the A1 mini\'s is exactly the one the planner gate uses', JSON.stringify(await PRINT.readTemplate(new Uint8Array(fs.readFileSync(path.join(ROOT, pa.template))))) === JSON.stringify(tpl));

  // ===========================================================================
  section('2. The plate -> the engine\'s input');
  // ===========================================================================
  const plate = await L.plateA(tpl);                               // the coupon and its NSO supports, A1 mini
  const pieces = asViewportPieces(plate.objs, a1.bed);
  const objs = PRINT.pieceObjects(pieces, a1.bed);
  check('every piece becomes an engine object, in order and by name', objs.length === plate.objs.length && objs.every((o, i) => o.name === plate.objs[i].name),
    objs.map(o => o.name).join(', '));
  check('the viewport\'s centre is the bed\'s: the plate the planner gate slices comes back, to the float',
    objs.every((o, i) => o.soup.length === plate.objs[i].soup.length && o.soup.every((v, k) => Math.abs(v - plate.objs[i].soup[k]) < 2e-3)),
    'first object off by ' + Math.max(...Array.from(objs[0].soup, (v, k) => Math.abs(v - plate.objs[0].soup[k]))));
  const sup = objs.filter(o => o.role === 'support');
  check('a support is typed as a support, with its host (the engine types its paths; nothing is retyped here), the part as a part',
    sup.length === plate.objs.length - 1 && sup.every(o => o.hostKey === objs[0].key) && objs[0].role === 'part' && objs[0].hostKey === undefined,
    objs.map(o => o.role + ':' + o.key + '>' + o.hostKey).join(' '));
  check('the pieces\' own arrays are not touched (the card keeps them to name the file and to see a changed plate)',
    pieces.every((p, i) => p.soup !== objs[i].soup) && pieces[0].soup[0] === plate.objs[0].soup[0] - a1.bed.x / 2);
  const ns = PRINT.pieceObjects([Object.assign({}, pieces[0], { nonSolid: true })], a1.bed)[0];
  check('a piece flagged non-solid is sliced with its open edges open (gapCloseMm 0), as G-scope\'s Slice does', ns.gapCloseMm === 0 && objs[0].gapCloseMm === undefined);
  check('the file is named after the one piece and the printer', PRINT.fileName(pieces, pa) === plate.objs[0].name.replace(/[\/\\?%*:|"<>]/g, '') + ' - A1 mini.gcode.3mf',
    PRINT.fileName(pieces, pa));
  check('...and after the count when there are several pieces; supports are not counted; the extension and bad characters go',
    PRINT.fileName([{ name: 'a.stl' }, { name: 'b' }, { name: 's', support: true }], pp) === '2 pieces - P1S.gcode.3mf' &&
      PRINT.fileName([{ name: 'my: "part".STL' }], pp) === 'my part - P1S.gcode.3mf', PRINT.fileName([{ name: 'my: "part".STL' }], pp));
  check('seconds read as a person reads them', PRINT.fmtTime(30) === '30 s' && PRINT.fmtTime(125) === '2 min' && PRINT.fmtTime(3725) === '1 h 02 min' && PRINT.fmtTime(7200) === '2 h 00 min');

  // ===========================================================================
  // a sheet of three interface layers (the card's Dense) is told to the slicer, as G-scope's Slice tells it
  const dense = PRINT.pieceObjects(pieces.map(p => p.support ? Object.assign({}, p, { interfaceLayers: 3 }) : p), a1.bed);
  check('a support piece\'s interfaceLayers rides on its engine object; a part\'s does not',
    dense.filter(o => o.role === 'support').every(o => o.interfaceLayers === 3) && dense.filter(o => o.role !== 'support').every(o => o.interfaceLayers === undefined));
  {
    const SLm = require(path.join(ROOT, 'nso_slicer.js')), realRun = SLm.run, seen = [];
    const opts = [];
    SLm.run = function (ob, o) { seen.push(o.supportInterfaceLayers); opts.push(o); return realRun.apply(this, arguments); };
    let dOut = null, pOut = null;
    try {
      dOut = await PRINT.build(dense.slice(0, 2), { config: tpl, printer: a1 }, {});
      pOut = await PRINT.build(objs.slice(0, 2), { config: tpl, printer: a1 }, {});
    } finally { SLm.run = realRun; }
    check('build() gives the slicer supportInterfaceLayers 3 for a Dense sheet, and leaves the default alone otherwise', seen.length === 2 && seen[0] === 3 && seen[1] == null, String(seen));
    /* a Dense support prints with the profile's own support settings (the owner's P1S, 2x supp_ref: the reference's interface spacing 0.1,
       3 top layers and 20 / 45 angles welded five heads of six; the profile's 0.5 and 3.6 released clean): nothing written over them */
    const o0 = opts[0] || {};
    check('...a Dense support slices at the profile\'s interface spacing (0.5) with the card\'s 3.6 angles, and the file carries no override of them',
      o0.supportInterfaceSpacingMm === 0.5 && o0.supportAngleDeg === 0 && o0.bridgeAngleDeg === 0 && o0.supportInterfaceAngle === 'studio36' &&
      dOut && dOut.ok && ['support_interface_spacing', 'support_interface_top_layers', 'support_angle', 'bridge_angle'].every(k => dOut.changed.indexOf(k) < 0),
      JSON.stringify([o0.supportInterfaceSpacingMm, o0.supportAngleDeg, o0.bridgeAngleDeg, o0.supportInterfaceAngle, dOut && dOut.changed]));
  }

  section('3. A plate with supports through build(): the file');
  // ===========================================================================
  const stages = [];
  const out = await PRINT.build(objs, { config: tpl, printer: a1 }, { onStage: (s, info) => stages.push(s + ':' + JSON.stringify(info)) });
  check('the plate is sliced, planned and packed', out.ok && out.bytes && out.bytes.length > 1e5, out.reason);
  if (!out.ok) { console.log('\nFAILED  ' + (fail + 1)); process.exit(1); }
  check('the card is told the stages, in order: slicing ' + objs.length + ' objects, then writing the layers',
    stages.length === 2 && stages[0] === 'slicing:{"objects":' + objs.length + '}' && /^writing:\{"layers":\d+\}$/.test(stages[1]), stages.join(' | '));

  const zip = L.R.openZip(out.bytes);
  const gcode = L.text(await zip.read('Metadata/plate_1.gcode'));
  // the layers' body: the start and end blocks are Studio's own (FEATURE: Custom), not a path of the plate
  const body = gcode.slice(gcode.indexOf('; CHANGE_LAYER'), gcode.indexOf('; MACHINE_END_GCODE_START')).split('\n');
  const featureLines = [...new Set(body.filter(l => /^; FEATURE: /.test(l)).map(l => l.slice(11)))].filter(f => f !== 'Custom');
  check('the FEATURE lines include Support, Support interface and Support transition: ' + featureLines.join(', '),
    SUPPORT_FEATURES.every(f => featureLines.includes(f)));
  check('...and build() reports the same features', JSON.stringify([...out.features].sort()) === JSON.stringify(featureLines.slice().sort()), out.features.join(', '));
  check('...the supports are the support objects\' paths, never an Overhang wall, and the part has none of the three',
    (() => {
      const by = {}; let cur = null;
      body.forEach(l => { let m; if ((m = /^; OBJECT_ID: (\d+)$/.exec(l))) cur = m[1]; else if ((m = /^; FEATURE: (.*)$/.exec(l))) (by[cur] = by[cur] || new Set()).add(m[1]); });
      const ids = Object.keys(by);
      const partId = ids.find(id => !by[id].has('Support') && !by[id].has('Support interface') && !by[id].has('Support transition'));
      const supIds = ids.filter(id => id !== partId);
      return ids.length === objs.length && partId === ids[0] && supIds.length === objs.length - 1 &&
        supIds.every(id => [...by[id]].every(f => SUPPORT_FEATURES.includes(f)));
    })());

  // ---- the packager's checks (the ones print:planner holds the planner to)
  const names = zip.names();
  const ref = await L.bambuSlice('fixtures/supports/top_clip_x2_supports.gcode.3mf');
  check('the .gcode.3mf has the reference\'s parts, in its order',
    JSON.stringify(names.filter(n => !/^Auxiliaries/.test(n))) === JSON.stringify(ref.zip.names().filter(n => !/^Auxiliaries/.test(n))), names.join(', '));
  check('plate_1.gcode.md5 is the G-code\'s MD5',
    crypto.createHash('md5').update(Buffer.from(gcode)).digest('hex').toUpperCase() === L.text(await zip.read('Metadata/plate_1.gcode.md5')).trim());
  const back = await G3.read(out.bytes);
  check('the packager reads its own file back', !!back);
  const si = L.text(await zip.read('Metadata/slice_info.config'));
  check('slice_info: the printer (N1), the plan\'s prediction (' + Math.round(out.stats.seconds) + ' s) and every object by its label',
    /key="printer_model_id" value="N1"/.test(si) && new RegExp('key="prediction" value="' + Math.round(out.stats.seconds) + '"').test(si) &&
      [...gcode.matchAll(/^; model label id: (.*)$/gm)].every(m => m[1].split(',').every(id => si.includes('identify_id="' + id + '"'))));
  const ps = JSON.parse(L.text(await zip.read('Metadata/project_settings.config')));
  check('project_settings.config is the template\'s with NSO\'s cooling keys', ps.printer_model === 'Bambu Lab A1 mini' && JSON.stringify(ps.slow_down_layer_time) === '["6","6"]');
  const imp = await Lines.readSlicedGcode3MF(out.bytes, { name: 'plate.gcode.3mf' });
  const direct = Lines.parseGcode(gcode);
  check('G-scope\'s import reads it (what Preview in G-scope opens): ' + imp.parsed.moves.length + ' moves in ' + imp.parsed.features.length + ' features, nothing assumed',
    imp.parsed.moves.length === direct.moves.length && imp.parsed.moves.length > 20000 && !imp.parsed.meta.assumed);
  const seen = new Set(imp.parsed.features.map(g => g.name));
  check('...and its features include the three support names, so Preview shows supports as supports', SUPPORT_FEATURES.every(f => seen.has(f)), [...seen].join(', '));

  // ---- the same file as the planner gate's own pipeline makes
  const ref3 = await PL.toGcode3mf(plate.res, { config: tpl, printer: a1 });
  check('the card\'s file is the planner gate\'s: the same G-code, byte for byte, from the plate as the card reads it',
    L.text(await zip.read('Metadata/plate_1.gcode')) === ref3.plan.gcode);
  check('what the card shows is the planner\'s: ' + PRINT.describe(out) + ' - layers ' + ref3.plan.stats.layers + ', ' + Math.round(ref3.plan.stats.seconds.total) + ' s, ' + ref3.plan.stats.grams.toFixed(2) + ' g',
    out.stats.layers === ref3.plan.stats.layers && out.stats.seconds === ref3.plan.stats.seconds.total && out.stats.grams === ref3.plan.stats.grams &&
      out.objects === ref3.plan.labels.length);
  check('...the readout line has layers, time and grams', /^\d+ layers - .+ - \d+\.\d g filament$/.test(PRINT.describe(out)), PRINT.describe(out));

  // ===========================================================================
  section('3b. The card\'s Slice settings: the profile\'s values, and a changed one in every reader of the file');
  // ===========================================================================
  {
    const base = PRINT.settingsFromConfig(tpl);
    check('the settings start at the A1 mini template\'s values: 0.4 nozzle, 0.2 mm layers, 2 walls, 15 % grid, support below 30°, auto brim, no raft (0.1 contact)',
      JSON.stringify(base) === JSON.stringify({ nozzle: 0.4, layer: 0.2, walls: 2, density: 15, pattern: 'grid', angle: 30, brim: 'auto', raft: 0, raftGap: 0.1, ifaceAngle: 'studio36', interfaceRule: null,
        filament: 'profile', nozzleTemp: null, firstTemp: null, bedTemp: null, maxFlow: null, tempStep: 0, tempBand: 10 }), JSON.stringify(base));
    const rov = PRINT.configOverlay(tpl, Object.assign({}, base, { raft: 10 }));
    check('a raft of 10 on the card is the file\'s raft_layers = 10, and nothing else changes', JSON.stringify(rov) === JSON.stringify({ raft_layers: '10' }), JSON.stringify(rov));
    check('...which are the card\'s markup defaults too (shown before the template is fetched)', JSON.stringify(PRINT.SETTINGS_DEFAULT) === JSON.stringify(base));
    check('an untouched card changes nothing in the template', Object.keys(PRINT.configOverlay(tpl, base)).length === 0 && PRINT.withOverlay(tpl, {}) === tpl);
    let threw = '';
    try { PRINT.configOverlay(tpl, Object.assign({}, base, { nozzle: 0.6 })); } catch (e) { threw = e.message; }
    check('a nozzle the profile is not is refused, not sliced with the 0.4 blocks', /0\.6 mm nozzle needs its own profile/.test(threw), threw);
    const cl = PRINT.cleanSettings({ layer: '9', walls: '0', density: '150', pattern: 'gyroid', angle: '0', brim: 'x', interfaceRule: 'column' });
    check('each row is clamped to what it takes, and an unknown pattern / brim is the default', cl.layer === 0.3 && cl.walls === 1 && cl.density === 100 && cl.pattern === 'grid' && cl.angle === 1 && cl.brim === 'auto' && cl.interfaceRule === 'column', JSON.stringify(cl));

    const two = objs.slice(0, 2);
    const same = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
    const plain = await PRINT.build(two, { config: tpl, printer: a1 }, {});
    check('the profile\'s values slice to the same file as no settings at all (the G-code, byte for byte)', same.ok && plain.ok &&
      L.text(await L.R.openZip(same.bytes).read('Metadata/plate_1.gcode')) === L.text(await L.R.openZip(plain.bytes).read('Metadata/plate_1.gcode')));

    const want = { nozzle: 0.4, layer: 0.1, walls: 3, density: 25, pattern: 'lines', angle: 40, brim: 'none', interfaceRule: null };
    const SLm = require(path.join(ROOT, 'nso_slicer.js')), realRun = SLm.run;
    let seenOpts = null;
    SLm.run = function (ob, o) { seenOpts = o; return realRun.apply(this, arguments); };
    let changed;
    try { changed = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: want }); } finally { SLm.run = realRun; }
    check('changed settings slice', changed.ok, changed.reason);
    if (changed.ok) {
      check('...the slicer is given them: 0.1 mm layers (first layer the profile\'s 0.2), 3 walls, 25 % lines, support below 40°, no brim',
        seenOpts.layerMm === 0.1 && seenOpts.firstLayerMm === 0.2 && seenOpts.wallLoops === 3 && Math.abs(seenOpts.sparseDensity - 0.25) < 1e-9 &&
          seenOpts.sparsePattern === 'lines' && seenOpts.supportThresholdDeg === 40 && seenOpts.brimType === 'none',
        JSON.stringify({ l: seenOpts.layerMm, f: seenOpts.firstLayerMm, w: seenOpts.wallLoops, d: seenOpts.sparseDensity, p: seenOpts.sparsePattern, a: seenOpts.supportThresholdDeg, b: seenOpts.brimType }));
      check('...half the layer height is about twice the layers (' + plain.stats.layers + ' -> ' + changed.stats.layers + ')',
        changed.stats.layers > plain.stats.layers * 1.8 && changed.stats.layers < plain.stats.layers * 2.2);
      check('...build() says what it sliced with and which template keys changed',
        JSON.stringify(changed.changed.sort()) === JSON.stringify(['brim_type', 'layer_height', 'sparse_infill_density', 'sparse_infill_pattern', 'support_threshold_angle', 'wall_loops']), changed.changed.join(', '));
      const cz = L.R.openZip(changed.bytes);
      const cg = L.text(await cz.read('Metadata/plate_1.gcode'));
      const cb = k => (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(cg) || [])[1];
      check('...the G-code\'s CONFIG_BLOCK records them (layer_height 0.1, wall_loops 3, 25%, line, 40, no_brim), the first layer stays 0.2',
        cb('layer_height') === '0.1' && cb('wall_loops') === '3' && cb('sparse_infill_density') === '25%' && cb('sparse_infill_pattern') === 'line' &&
          cb('support_threshold_angle') === '40' && cb('brim_type') === 'no_brim' && cb('initial_layer_print_height') === '0.2',
        ['layer_height', 'wall_loops', 'sparse_infill_density', 'sparse_infill_pattern', 'support_threshold_angle', 'brim_type'].map(cb).join(' '));
      const cps = JSON.parse(L.text(await cz.read('Metadata/project_settings.config')));
      check('...and so does project_settings.config, each listed as a change to the process preset',
        cps.layer_height === '0.1' && cps.wall_loops === '3' && cps.sparse_infill_density === '25%' && cps.sparse_infill_pattern === 'line' &&
          cps.support_threshold_angle === '40' && cps.brim_type === 'no_brim' &&
          ['layer_height', 'wall_loops', 'brim_type'].every(k => cps.different_settings_to_system[0].split(';').includes(k)),
        JSON.stringify([cps.layer_height, cps.wall_loops, cps.different_settings_to_system[0]]));
      check('...the template the card holds is not changed by it', tpl.layer_height === '0.2' && tpl.wall_loops === '2');
      check('...the packager still reads its own file, and the G-code md5 holds',
        !!(await G3.read(changed.bytes)) && crypto.createHash('md5').update(Buffer.from(cg)).digest('hex').toUpperCase() === L.text(await cz.read('Metadata/plate_1.gcode.md5')).trim());
    }
    const ruleSeen = [];
    SLm.run = function (ob, o) { ruleSeen.push(o.supportInterfaceRule || null); return realRun.apply(this, arguments); };
    try {
      await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { interfaceRule: 'column' }) });
      await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
    } finally { SLm.run = realRun; }
    check('the interface rule is handed in with the settings (a worker has no window to read it from)', ruleSeen[0] === 'column' && ruleSeen[1] === null, JSON.stringify(ruleSeen));
  }

  // ===========================================================================
  section('3c. The filament: another filament than the template\'s PLA, its rows, and temperature steps (docs/FILAMENTS.md)');
  // ===========================================================================
  {
    const base = PRINT.settingsFromConfig(tpl);
    const fb = PRINT.filamentBase(tpl, 'profile'), tb = PRINT.filamentBase(tpl, 'cr-tpu');
    check('the profile\'s filament is the template\'s PLA: 220 / 220 C, bed 65, 12 mm^3/s; CR-TPU is 235 / 235 C, bed 30 (Studio: the A1 mini TPU bed), 3.2 mm^3/s, printable 200 - 250 C',
      fb.nozzleTemp === 220 && fb.firstTemp === 220 && fb.bedTemp === 65 && fb.maxFlow === 12 &&
        tb.nozzleTemp === 235 && tb.firstTemp === 235 && tb.bedTemp === 30 && tb.maxFlow === 3.2 && tb.rangeLow === 200 && tb.rangeHigh === 250, JSON.stringify([fb, tb]));
    check('the four rows at the filament\'s own values change nothing (the card shows them filled in)',
      Object.keys(PRINT.configOverlay(tpl, Object.assign({}, base, { nozzleTemp: 220, firstTemp: 220, bedTemp: 65, maxFlow: 12 }))).length === 0);
    const rows = PRINT.configOverlay(tpl, Object.assign({}, base, { nozzleTemp: 210, bedTemp: 60, maxFlow: 8 }));
    check('a changed row is its config key: nozzle_temperature, the plate\'s bed temperature (both layers), filament_max_volumetric_speed',
      JSON.stringify(rows) === JSON.stringify({ nozzle_temperature: '210', textured_plate_temp: '60', textured_plate_temp_initial_layer: '60', filament_max_volumetric_speed: '8' }), JSON.stringify(rows));
    const cl = PRINT.cleanSettings({ filament: 'nylon', nozzleTemp: '999', firstTemp: '', bedTemp: '-5', maxFlow: '0.01', tempStep: '-99', tempBand: '0' });
    check('the rows are clamped; an empty one is null (the filament\'s own); an unknown filament is the profile\'s',
      cl.filament === 'profile' && cl.nozzleTemp === 300 && cl.firstTemp === null && cl.bedTemp === 0 && cl.maxFlow === 0.5 && cl.tempStep === -25 && cl.tempBand === 1, JSON.stringify(cl));

    const one = objs.slice(0, 1);
    const pla = await PRINT.build(one, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
    const tpu = await PRINT.build(one, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu' }) });
    check('CR-TPU slices', pla.ok && tpu.ok, tpu.reason);
    if (pla.ok && tpu.ok) {
      const tz = L.R.openZip(tpu.bytes);
      const tg = L.text(await tz.read('Metadata/plate_1.gcode')), pg = L.text(await L.R.openZip(pla.bytes).read('Metadata/plate_1.gcode'));
      const cb = k => (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(tg) || [])[1];
      check('...the CONFIG_BLOCK names it on both filament slots: TPU, GFU99, Generic TPU @BBL A1M, 235 C, bed 30, 3.2 mm^3/s, fan 100 (retraction_length stays 0.8 there, as in the Studio TPU slice)',
        cb('filament_type') === 'TPU;TPU' && cb('filament_ids') === 'GFU99;GFU99' && cb('filament_settings_id') === '"Generic TPU @BBL A1M";"Generic TPU @BBL A1M"' &&
          cb('nozzle_temperature') === '235,235' && cb('textured_plate_temp') === '30,30' && cb('filament_max_volumetric_speed') === '3.2,3.2' &&
          cb('retraction_length') === '0.8' && cb('fan_min_speed') === '100,100',
        ['filament_type', 'filament_ids', 'filament_settings_id', 'nozzle_temperature', 'textured_plate_temp', 'filament_max_volumetric_speed', 'retraction_length', 'fan_min_speed'].map(cb).join(' | '));
      const tsi = L.text(await tz.read('Metadata/slice_info.config'));
      check('...slice_info tells the printer the filament is TPU (GFU99)', /tray_info_idx="GFU99" type="TPU"/.test(tsi));
      const tps = JSON.parse(L.text(await tz.read('Metadata/project_settings.config')));
      check('...project_settings.config holds it, listed as the filament\'s changes (not the process\'s)',
        tps.filament_type[0] === 'TPU' && tps.nozzle_temperature[0] === '235' && tps.filament_max_volumetric_speed[0] === '3.2' && tps.fan_min_speed[0] === '100' &&
          !/nozzle_temperature|filament_/.test(tps.different_settings_to_system[0]) && tps.different_settings_to_system[1].split(';').includes('filament_max_volumetric_speed'),
        JSON.stringify(tps.different_settings_to_system));
      const startOf = g => g.slice(g.indexOf('; EXECUTABLE_BLOCK_START'), g.indexOf('; CHANGE_LAYER')).split('\n');
      const ts = startOf(tg), psl = startOf(pg);
      check('...the start block is the filament\'s, not PLA\'s: set_filament_type:TPU, flush at 3.2 mm^3/s (F79.8237) and 250 C, the purge line at F192 / F320 / F1280',
        ts.filter(l => /set_filament_type:TPU$/.test(l)).length === 3 && !ts.some(l => /set_filament_type:PLA/.test(l)) &&
          ts.includes('    M620.1 E F79.8237 T250') && ts.includes('    G1 E50 F79.8237') &&
          ts.includes('G0 X88 E10  F192') && ts.includes('G0 X93 E.3742  F320') && ts.includes('G0 X98 E.3742  F1280') &&
          !ts.some(l => /F(720|4800|299\.339)$/.test(l)) && psl.includes('G0 X88 E10  F720') && psl.includes('    M620.1 E F299.339 T220'));
      check('...its temperatures are in the start block (bed 30, nozzle 235) and its own filament start G-code replaces PLA\'s',
        ts.includes('M140 S30') && ts.includes('M190 S30;set bed temp') && ts.includes('M109 S235') && !ts.includes(';Prevent PLA from jamming') && psl.includes(';Prevent PLA from jamming'));
      // every extruding move's volumetric rate, from the lines
      const peak = g => {
        const A = Math.PI * 1.75 * 1.75 / 4; let x = null, y = null, f = 0, mx = 0, on = false;
        g.split('\n').forEach(l => {
          if (l === '; MACHINE_START_GCODE_END') on = true; else if (l === '; MACHINE_END_GCODE_START') on = false;
          if (!/^G[0-3] /.test(l)) return;
          const d = {}; l.split(';')[0].replace(/([XYEF])(-?[\d.]+)/g, (a, k, v) => { d[k] = +v; return a; });
          if (d.F != null) f = d.F;
          const nx = d.X != null ? d.X : x, ny = d.Y != null ? d.Y : y;
          if (on && d.E > 0 && x != null && (d.X != null || d.Y != null)) { const len = Math.hypot(nx - x, ny - y); if (len > 1e-6) mx = Math.max(mx, d.E * A / (len / (f / 60))); }
          x = nx; y = ny;
        });
        return mx;
      };
      const pk = peak(tg), pkPla = peak(pg);
      check('...no move asks the hotend for more than its 3.2 mm^3/s (peak ' + pk.toFixed(3) + '; PLA\'s plate peaks at ' + pkPla.toFixed(2) + ')', pk > 2.5 && pk < 3.2 * 1.005 && pkPla > 3.2 * 1.5);
      check('...it retracts the filament\'s 0.4 mm, and the fan is full from the second layer', /^G1 E-0?\.4 F1800$/m.test(tg) && !/^G1 E-0?\.8 F1800$/m.test(tg) && /^M106 S255$/m.test(tg));
      check('...the readout names it', tpu.filament === 'Creality CR-TPU 95A, 235 \u00b0C, bed 30 \u00b0C, 3.2 mm\u00b3/s', tpu.filament);
    }

    // STUDIO'S OWN TPU SLICE (the owner's temperature tower, Generic TPU @BBL A1M, Studio 02.09.01.70): the start block NSO writes for
    // that filament with that slice's numbers is Studio's, line for line - the non-PLA side of every {if filament_type == "PLA"}
    {
      const st = await L.bambuSlice('fixtures/print-planner/a1mini-0.4/studio-generic-tpu-tower.gcode.3mf');
      const sl = st.gcode.split('\n'), noM73 = a => a.filter(l => !/^@?M73 /.test(l));
      const iE = sl.indexOf('; EXECUTABLE_BLOCK_START'), iM = sl.indexOf('; MACHINE_START_GCODE_END'), iL = sl.indexOf('; CHANGE_LAYER');
      const cfg = k => (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(st.gcode) || [])[1];
      const gm = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(sl.find(l => /^\s*G29 A1 X/.test(l)));
      const S = PL.settingsFrom({ filament_type: cfg('filament_type'), filament_max_volumetric_speed: cfg('filament_max_volumetric_speed'), nozzle_temperature_range_high: cfg('nozzle_temperature_range_high'),
        filament_flush_temp: cfg('filament_flush_temp'), filament_flush_volumetric_speed: cfg('filament_flush_volumetric_speed'), outer_wall_speed: cfg('outer_wall_speed'),
        outer_wall_line_width: cfg('outer_wall_line_width'), layer_height: cfg('layer_height'), nozzle_temperature: cfg('nozzle_temperature'),
        nozzle_temperature_initial_layer: cfg('nozzle_temperature_initial_layer'), textured_plate_temp: cfg('textured_plate_temp'), textured_plate_temp_initial_layer: cfg('textured_plate_temp_initial_layer'), curr_bed_type: cfg('curr_bed_type') });
      const v = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, bedMax: Math.max(S.temp.bed, S.temp.bedInitial), box: { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] }, cy: 0, maxZ: 0,
        filamentType: S.filament.type, flushV: S.filament.flushVolumetric, flushT: S.filament.flushTemp, ow: S.filament.outerWallVolumetric };
      const want = noM73(sl.slice(iE + 2, iM + 1)), got = noM73(PL.thaw(a1.start, v, {}));
      const off = want.findIndex((l, i) => l !== got[i]);
      check('Studio\'s own Generic TPU slice for the A1 mini: NSO\'s start block with that slice\'s numbers is Studio\'s, all ' + want.length + ' lines (TPU, 3.2 mm^3/s, 240 C, bed 30)',
        S.filament.type === 'TPU' && want.length === got.length && off < 0, off >= 0 ? 'line ' + off + ': ' + JSON.stringify([want[off], got[off]]) : want.length + ' / ' + got.length);
      const wantAfter = noM73(sl.slice(iM + 1, iL)), fs0 = PRINT.FILAMENTS['cr-tpu'].start(30, tpl);
      const vt = a1.afterStart.findIndex(l => typeof l === 'string' && /^;VT\d/.test(l));
      const gotAfter = noM73(PL.thaw(fs0.concat(a1.afterStart.slice(vt)), v, {}));
      check('...and so is the filament\'s own start G-code after it (no fan line at a 30 C bed)', JSON.stringify(wantAfter) === JSON.stringify(gotAfter), JSON.stringify([wantAfter, gotAfter]));
      const rs = {}; sl.forEach(l => { const m = /^G1 E-(\.?[\d.]+) F1800$/.exec(l); if (m) rs[m[1]] = (rs[m[1]] || 0) + 1; });
      check('...Studio retracts that filament 0.4 mm (0.38 in the wipe + .02), though its CONFIG_BLOCK keeps retraction_length = 0.8: the planner reads filament_retraction_length',
        rs['.02'] > 2000 && !rs['.8'] && !rs['.04'] && cfg('retraction_length') === '0.8', JSON.stringify(rs));
    }

    // temperature steps: a box 31 mm tall, 240 C down 5 every 10 mm
    const bx = (w, d, h) => { const x = w / 2, y = d / 2, v = [[-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0], [-x, -y, h], [x, -y, h], [x, y, h], [-x, y, h]];
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]], s = [];
      f.forEach(t => t.forEach(i => s.push(v[i][0], v[i][1], v[i][2]))); return new Float32Array(s); };
    const tower = PRINT.pieceObjects([{ name: 'tower', soup: bx(12, 12, 31), sourceId: 1 }], a1.bed);
    const stepped = await PRINT.build(tower, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 240, tempStep: -5, tempBand: 10 }) });
    check('temperature steps slice', stepped.ok, stepped.reason);
    if (stepped.ok) {
      const sg = L.text(await L.R.openZip(stepped.bytes).read('Metadata/plate_1.gcode')).split('\n');
      const at = [];
      let z = 0;
      sg.forEach(l => { const m = /^; Z_HEIGHT: ([\d.]+)$/.exec(l); if (m) z = +m[1]; const t = /^M104 S(\d+) ; NSO temperature step$/.exec(l); if (t) at.push([+t[1], z]); });
      check('...240 from the second layer, 235 at the first layer standing on 10 mm, 230 on 20 mm, 225 on 30 mm - each an M104 at its layer change, never an M109',
        JSON.stringify(at) === JSON.stringify([[240, 0.4], [235, 10.2], [230, 20.2], [225, 30.2]]) && !sg.some(l => /^M109 .*NSO/.test(l)), JSON.stringify(at));
      check('...build() reports the bands as written', JSON.stringify(stepped.stats.tempBands.map(b => b.temp)) === '[240,235,230,225]' &&
        PRINT.bandWords(stepped.stats.tempBands, 10) === 'temperature steps 240, 235, 230, 225 \u00b0C in 10 mm bands', JSON.stringify(stepped.stats.tempBands));
    }
    const cold = await PRINT.build(tower, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 210, tempStep: -10, tempBand: 10 }) });
    check('steps that leave the filament\'s range are refused in words, not clamped', !cold.ok && /temperature steps reach 190 .C at 20 mm; this filament prints between 200 and 250/.test(cold.reason), cold.reason);
    const plain3 = await PRINT.build(tower, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
    const plain0 = await PRINT.build(tower, { config: tpl, printer: a1 }, {});
    check('no steps and the profile\'s filament: no M104 beyond the template\'s, the same file as no settings',
      plain3.ok && plain0.ok && L.text(await L.R.openZip(plain3.bytes).read('Metadata/plate_1.gcode')) === L.text(await L.R.openZip(plain0.bytes).read('Metadata/plate_1.gcode')) && plain3.stats.tempBands === null);
  }

  // ===========================================================================
  section('4. A plate the planner refuses shows the planner\'s reason');
  // ===========================================================================
  const off = await PRINT.build(PRINT.pieceObjects(asViewportPieces(plate.objs.slice(0, 1), a1.bed, 110), a1.bed), { config: tpl, printer: a1 });
  check('a plate whose first layer is pushed off the bed is refused, not clipped, in the planner\'s words (the coupon\'s first layer is its 4 mm foot, so it takes 110 mm)', !off.ok && !off.bytes && /not on the Bambu Lab A1 mini's 180 x 180 mm bed/.test(off.reason), off.reason);
  const none = await PRINT.build([], { config: tpl, printer: a1 });
  check('an empty plate is refused by the engine\'s words, not a crash', !none.ok && /nothing to slice/.test(none.reason), none.reason);
  const tall = await PRINT.build(objs.slice(0, 1), { config: tpl, printer: Object.assign({}, a1, { bed: Object.assign({}, a1.bed, { z: 5 }) }) });
  check('a plate taller than the printer is refused with the height', !tall.ok && /mm tall; the Bambu Lab A1 mini prints 5 mm/.test(tall.reason), tall.reason);

  // ===========================================================================
  section('5. The P1S profile: its template, its frozen blocks, its bed (the coupon)');
  // ===========================================================================
  const p1sPrinter = L.printer('p1s-0.4');
  const p1sCfg = await PRINT.readTemplate(new Uint8Array(fs.readFileSync(path.join(ROOT, pp.template))));
  // the coupon alone (no trees: they are the A1 mini run's), centred on the P1S's 256 mm bed; the arc with trees on the P1S is a one-off in the handoff note
  const p1sOut = await PRINT.build(PRINT.pieceObjects(asViewportPieces(plate.objs.slice(0, 1), a1.bed), p1sPrinter.bed), { config: p1sCfg, printer: p1sPrinter });
  check('the coupon plans for the P1S from the P1S template and blocks', p1sOut.ok && p1sOut.objects === 1 && p1sOut.stats.layers > 50, p1sOut.reason);
  if (p1sOut.ok) {
    const z2 = L.R.openZip(p1sOut.bytes);
    check('...the file is the P1S\'s (model id C12) and Studio-shaped (md5 of its G-code)',
      /key="printer_model_id" value="C12"/.test(L.text(await z2.read('Metadata/slice_info.config'))) &&
        crypto.createHash('md5').update(Buffer.from(L.text(await z2.read('Metadata/plate_1.gcode')))).digest('hex').toUpperCase() === L.text(await z2.read('Metadata/plate_1.gcode.md5')).trim());
  }

  {
    // STUDIO'S OWN TPU SLICE FOR THE P1S (the owner's temperature tower, Generic TPU, Studio 02.09.01.70): the same check as the A1 mini's (3c)
    const st = await L.bambuSlice('fixtures/print-planner/p1s-0.4/studio-generic-tpu-tower.gcode.3mf');
    const sl = st.gcode.split('\n'), noM73 = a => a.filter(l => !/^@?M73 /.test(l));
    const iE = sl.indexOf('; EXECUTABLE_BLOCK_START'), iM = sl.indexOf('; MACHINE_START_GCODE_END'), iL = sl.indexOf('; CHANGE_LAYER');
    const cfg = k => ((new RegExp('^; ' + k + ' = (.*)$', 'm').exec(st.gcode) || [])[1] || '').split(',')[0];
    const gm = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(sl.find(l => /^\s*G29 A X/.test(l)));
    const c = {};
    ['filament_type', 'filament_max_volumetric_speed', 'nozzle_temperature_range_high', 'filament_flush_temp', 'filament_flush_volumetric_speed', 'outer_wall_speed', 'outer_wall_line_width',
     'layer_height', 'nozzle_temperature', 'nozzle_temperature_initial_layer', 'textured_plate_temp', 'textured_plate_temp_initial_layer', 'curr_bed_type'].forEach(k => { c[k] = cfg(k); });
    const S = PL.settingsFrom(c);
    const v = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, bedMax: Math.max(S.temp.bed, S.temp.bedInitial), box: { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] }, cy: 0, maxZ: 0,
      filamentType: S.filament.type, flushV: S.filament.flushVolumetric, flushT: S.filament.flushTemp, ow: S.filament.outerWallVolumetric };
    const want = noM73(sl.slice(iE + 2, iM + 1)), got = noM73(PL.thaw(p1sPrinter.start, v, {}));
    const off = want.findIndex((l, i) => l !== got[i]);
    check('Studio\'s own Generic TPU slice for the P1S: NSO\'s start block with that slice\'s numbers is Studio\'s, all ' + want.length + ' lines (TPU, 3.2 mm^3/s, 240 C, bed 35; no PLA fan block)',
      S.filament.type === 'TPU' && S.temp.bedInitial === 35 && want.length === got.length && off < 0, off >= 0 ? 'line ' + off + ': ' + JSON.stringify([want[off], got[off]]) : want.length + ' / ' + got.length);
    const vt = p1sPrinter.afterStart.findIndex(l => typeof l === 'string' && /^;VT\d/.test(l));
    const wantAfter = noM73(sl.slice(iM + 1, iL)), gotAfter = noM73(PL.thaw(PRINT.FILAMENTS['cr-tpu'].start(35, p1sCfg).concat(p1sPrinter.afterStart.slice(vt)), v, {}));
    check('...and so is the filament\'s own start G-code after it (M106 P3 S180 at a 35 C bed)', JSON.stringify(wantAfter) === JSON.stringify(gotAfter), JSON.stringify([wantAfter, gotAfter]));
    check('...the card\'s CR-TPU on the P1S has that bed: 235 C, bed 35, 3.2 mm^3/s', JSON.stringify(PRINT.filamentBase(p1sCfg, 'cr-tpu')) === JSON.stringify({ nozzleTemp: 235, firstTemp: 235, bedTemp: 35, maxFlow: 3.2, rangeLow: 200, rangeHigh: 250 }));
  }

  // ===========================================================================
  section('5b. The slice worker\'s load: the files in a global with no DOM and no module');
  // ===========================================================================
  {
    const vm = require('vm');
    const ctx = { console, Promise, Math, Date, JSON, Object, Array, Number, String, Map, Set, RegExp, Error, isFinite, parseFloat, parseInt, TextEncoder, TextDecoder,
                  Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array, ArrayBuffer, DataView, setTimeout, clearTimeout };
    vm.createContext(ctx);
    ctx.self = ctx.globalThis = ctx;
    let loaded = null;
    try {
      PRINT.ENGINE.filter(f => f !== 'nso_csg.js').forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
      loaded = ctx.NSO_Print;
    } catch (err) { loaded = String(err && err.stack || err); }
    check('app-print.js and the files the worker loads (but the boolean kernel\'s) run in a global with no document and no module, as importScripts runs them',
      loaded && typeof loaded === 'object' && typeof loaded.buildForWorker === 'function' && typeof loaded.build === 'function' && !loaded.card, String(loaded).slice(0, 200));
    check('...and the planner and the packager are where build() looks for them (NSOPrintPlanner, NSO_Gcode3mf, NSO_Slicer)',
      !!(ctx.NSOPrintPlanner && ctx.NSO_Gcode3mf && ctx.NSO_Slicer && ctx.NSO3MF && ctx.NSO3MFRead && ctx.NSOCoolingProfiles));
  }

  // ===========================================================================
  section('6. The page: the left bar, the load order, G-scope left alone');
  // ===========================================================================
  const html = read('index.html');
  const at = s => html.indexOf(s);
  const col = html.slice(at('<div class="vp-shell-col">'));
  const order = ['id="menu-sculpt"', 'id="btn-microscope"', 'id="menu-repair"', 'class="vp-shell-view'].map(s => col.indexOf(s));
  check('the left bar, top to bottom: ... Sculpt, G-SCOPE, CHECK & REPAIR, then the view row - no Slice button of its own (it is the supports card\'s)',
    order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])) && !html.includes('id="menu-slice"'), order.join(' '));
  check('...and G-scope is not first in the column (Scale is)', col.indexOf('id="menu-scale"') < col.indexOf('id="btn-microscope"') && col.indexOf('id="menu-scale"') > 0);
  check('G-scope\'s button is the same button: its id, class, label and its file input beside it',
    /<button id="btn-microscope" class="vp-bar-btn btn-gscope" type="button"\s+aria-label="G-scope"\s+title="G-scope: put the plate under the lens[^"]*">G-scope<\/button>\s*<input type="file" id="ms-input" accept="\.stl,\.3mf" class="hidden-quiet" \/>/.test(html));
  check('the Slice card is the supports card\'s last section (Generate slices; Preview, under Generate, opens it): every button and row it has, the raft in the supports\' own rows',
    (() => { const m = /<details class="vp-menu vp-shell-menu vp-col-menu" id="menu-supports">[\s\S]*?<\/details>\s*<!-- ADD/.exec(html);
      if (!m) return false;
      const sec = /<details class="vp-sec sup-slice-sec" id="sup-slice-sec"[\s\S]*$/.exec(m[0]), settings = /<div id="slice-settings"[\s\S]*?<\/div>/.exec(m[0]);
      return !!sec && /<summary class="vp-sec-head"[^>]*>Slice<\/summary>/.test(sec[0]) && ['btn-slice-go', 'btn-slice-cancel', 'btn-slice-export', 'slice-profile', 'slice-readout', 'slice-progress',
        'slice-settings-toggle', 'slice-settings', 'slice-set-nozzle', 'slice-set-layer', 'slice-set-walls', 'slice-set-density', 'slice-set-pattern',
        'slice-set-angle', 'slice-set-brim', 'slice-set-iface', 'slice-settings-reset',
        'slice-set-filament', 'slice-set-nozzle-temp', 'slice-set-first-temp', 'slice-set-bed-temp', 'slice-set-max-flow', 'slice-set-temp-step', 'slice-set-temp-band', 'slice-filament-note']
        .every(id => sec[0].includes('id="' + id + '"')) && /Export \.gcode\.3mf/.test(sec[0]) && !sec[0].includes('btn-slice-preview') &&
        m[0].indexOf('id="btn-sup-all"') < m[0].indexOf('id="btn-sup-slice"') && m[0].indexOf('id="btn-sup-slice"') < m[0].indexOf('id="sup-style"') &&
        m[0].includes('id="slice-set-raft"') && m[0].includes('id="slice-set-raft-gap"') && !!settings && !settings[0].includes('slice-set-raft'); })());
  const css = read('styles.css');
  check('while a build runs the supports card is locked (no clicks), all but its Cancel: the build and its slice can be stopped',
    /\.sup-card\.is-locked \{ pointer-events: none; \}/.test(css) && /\.sup-card\.is-locked #btn-sup-slice-cancel \{ pointer-events: auto;/.test(css));
  const tags = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script src="([^"?]+)(?:\?v=\w+)?"/g)].map(m => m[1]);
  const idx = f => tags.indexOf(f);
  check('the planner, the packager and app-print.js are loaded by the page, after the files they read at load and after G-scope',
    ['nso-cooling-profiles.js', 'nso-3mf.js', 'nso-3mf-read.js', 'nso_slicer.js', 'app-microscope.js'].every(f => idx(f) >= 0 && idx(f) < idx('nso-print-planner.js')) &&
      idx('nso-print-planner.js') < idx('nso-gcode3mf-write.js') && idx('nso-gcode3mf-write.js') < idx('app-print.js'), tags.filter(t => /print|3mf|gcode3/.test(t)).join(' '));
  check('every file the slice worker loads is one of the page\'s script tags (it finds them there), once', PRINT.ENGINE.every(f => tags.filter(t => t === f).length === 1), PRINT.ENGINE.join(', '));
  const gscopeFiles = fs.readdirSync(ROOT).filter(f => /^app-(microscope|gscope-.*)\.js$/.test(f));
  const touchers = gscopeFiles.filter(f => /nso-print-planner|nso-gcode3mf-write|NSOPrintPlanner|NSO_Gcode3mf|app-print/.test(read(f)));
  check('no G-scope file (' + gscopeFiles.join(', ') + ') loads or calls the planner or the packager', gscopeFiles.length >= 3 && touchers.length === 0, touchers.join(', '));
  /* ONE SLICE (the owner: "It needs to be one slice"): G-scope's Slice switch on the plate shows this card's slice - it reaches the card
     for that, and for nothing else */
  const cardUsers = gscopeFiles.filter(f => /NSO_Print\b/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '')));
  const gs = read('app-gscope-slice.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const cardCalls = [...new Set([...gs.matchAll(/\bP\.(\w+)/g)].map(m => m[1]))].sort();
  check('...only G-scope\'s Slice reaches this card, for the plate\'s one slice: is there one for the plate as it stands, make it, its report, open it',
    JSON.stringify(cardUsers) === '["app-gscope-slice.js"]' && JSON.stringify(cardCalls) === '["canSlice","fresh","previewInGscope","report","slice"]', JSON.stringify([cardUsers, cardCalls]));
  const src = read('app-print.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the card never reads or writes G-scope\'s Slice settings (ms-slice-*), and does not use toGcode()', !/ms-slice|toGcode\(/.test(src));
  check('...it calls only G-scope\'s plate reader, its file import (and the plate\'s slice opened as no import), and - for the Export card\'s rows of a slice it opened - the open document, the selection\'s object ids and a re-read of the rows',
    JSON.stringify([...new Set([...src.matchAll(/\bMS\.(\w+)/g)].map(m => m[1]))].sort()) === '["getDoc","openFile","openSlice","plateObjects","refreshExport","selectedObjectIds"]');

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.log('  FAIL  the check threw: ' + ((err && err.stack) || err)); process.exit(1); });

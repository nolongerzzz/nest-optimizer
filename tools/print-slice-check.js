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
  check('...a piece out of a 3MF is named after the file, not the object inside it; pieces of one file share its name, of two files are counted',
    PRINT.fileName([{ name: 'Ingenious+Leelo-Habbi.stl', file: 'String_test.3mf' }], pa) === 'String_test - A1 mini.gcode.3mf' &&
      PRINT.fileName([{ name: 'a', file: 'kit.3mf' }, { name: 'b', file: 'kit.3mf' }, { name: 's', support: true }], pa) === 'kit - A1 mini.gcode.3mf' &&
      PRINT.fileName([{ name: 'cone.stl' }, { name: 'cone.stl' }], pa) === 'cone - A1 mini.gcode.3mf' &&
      PRINT.fileName([{ name: 'a', file: 'kit.3mf' }, { name: 'b.stl' }], pa) === '2 pieces - A1 mini.gcode.3mf' &&
      PRINT.fileName([{ name: 'x', file: 'tower - A1 mini.gcode.3mf' }], pp) === 'tower - A1 mini - P1S.gcode.3mf');
  check('...a name typed for Save as keeps its ending, or gets it back, and loses what a file name cannot hold',
    PRINT.gcodeName('  cones  210 ') === 'cones 210.gcode.3mf' && PRINT.gcodeName('a/b:c.gcode.3mf') === 'abc.gcode.3mf' && PRINT.gcodeName('x.3mf') === 'x.gcode.3mf' &&
      PRINT.gcodeName('') === '' && PRINT.gcodeName(null) === '' && PRINT.gcodeName('.gcode.3mf') === '');
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
  /* the gate's plate is sliced at the engine's own support numbers (first layer solid, 0.18 under the part); the card starts at the profile's
     (90 %, 0.2 - docs/PRINT-CARD.md "Starting values"), so it is asked for the engine's two to be the same slice */
  const outEng = await PRINT.build(objs, { config: tpl, printer: a1 }, { settings: Object.assign(PRINT.settingsFromConfig(tpl), { supDensity: 100, supTopZ: 0.18 }) });
  const gEng = outEng.ok ? L.text(await L.R.openZip(outEng.bytes).read('Metadata/plate_1.gcode')) : '';
  const lessKeys = t => t.split('\n').filter(l => !/^; (raft_first_layer_density|support_top_z_distance) = /.test(l)).join('\n');
  check('the card\'s file, at the engine\'s own two support numbers, is the planner gate\'s: the same G-code (but the two keys it records), from the plate as the card reads it',
    outEng.ok && lessKeys(gEng) === lessKeys(ref3.plan.gcode), outEng.ok ? gEng.length + ' / ' + ref3.plan.gcode.length : outEng.reason);
  check('...and at the profile\'s own (what the rows start at) only the supports differ: the same layers, the part\'s walls untouched',
    out.stats.layers === ref3.plan.stats.layers && out.objects === ref3.plan.labels.length);
  check('what the card shows is the planner\'s: ' + PRINT.describe(outEng) + ' - layers ' + ref3.plan.stats.layers + ', ' + Math.round(ref3.plan.stats.seconds.total) + ' s, ' + ref3.plan.stats.grams.toFixed(2) + ' g',
    outEng.stats.layers === ref3.plan.stats.layers && outEng.stats.seconds === ref3.plan.stats.seconds.total && outEng.stats.grams === ref3.plan.stats.grams &&
      outEng.objects === ref3.plan.labels.length);
  check('...the readout line has layers, time and grams', /^\d+ layers - .+ - \d+\.\d g filament$/.test(PRINT.describe(out)), PRINT.describe(out));

  // ===========================================================================
  section('3b. The card\'s Slice settings: the profile\'s values, and a changed one in every reader of the file');
  // ===========================================================================
  {
    const base = PRINT.settingsFromConfig(tpl);
    check('the settings start at the A1 mini template\'s values: 0.4 nozzle, 0.2 mm layers, 2 walls, 15 % grid, support below 30°, auto brim, no raft (0.1 contact)',
      JSON.stringify(base) === JSON.stringify({ nozzle: 0.4, quality: '0.20mm Standard @BBL A1M', layer: 0.2, walls: 2, density: 15, pattern: 'grid', surface: 'zigzag', angle: 30, brim: 'auto', raft: 0, raftGap: 0.1, ifaceAngle: 'studio36', interfaceRule: null,
        filament: 'profile', nozzleTemp: null, firstTemp: null, bedTemp: null, maxFlow: null, tempStep: 0, tempBand: 10,
        bridgeSpeed: null, bridgeFlow: null, hangSpeed: null, bridgeFirst: null, flowRatio: null, retractLen: null, retractSpeed: null, retractBefore: null, zHop: null, bridgeTemp: null, bridgeTempFrom: null, coolWait: null, coolPillar: null, pauseAt: [], braceEvery: 0, flowTest: null, supExactGap: false, ifaceWait: 0,   /* the filament's own */
        /* Bambu's Advanced support rows start at the template's own values (docs/PRINT-CARD.md "Starting values"): first layer 90 %, top Z 0.2, every bridge held */
        supDensity: 90, supExpand: -1, supWalls: -1, supTopZ: 0.2, supBottomZ: 0.2, supBase: 'default', supBaseSpacing: 2.5, supAngle: 0, supIfacePattern: 'default', supIfaceSpacing: 0.5,
        supExpansion: 0, supXy: 0.35, supZOverXy: false, supFirstGap: 0.2, supBridge: 0, supIndep: true,
        /* the wall generator: the template's classic, and Studio's Arachne defaults (docs/SLICER.md "Arachne") */
        wallGen: 'classic', wallAngle: 10, wallFilter: 25, wallTransLen: 100, wallDist: 1, minWall: 85, minFeature: 25,
        /* the shells: the template's 5 top (1 mm) and 3 bottom */
        topLayers: 5, topThick: 1, botLayers: 3, botThick: 0, project: null,
        /* Studio's Strength and Line width rows (2026-11-24): the top in monotonic lines, the bottom monotonic, the solid infill rectilinear, both
           surfaces 100 %, paint 5 down and 3 up; the lines 0.42, the first layer 0.5, the inner wall and the sparse infill 0.45 */
        topSurf: 'monotonicline', topDens: 100, topPen: 5, botSurf: 'monotonic', botDens: 100, botPen: 3, solidSurf: 'zigzag',
        lwDefault: 0.42, lwFirst: 0.5, lwFirstInfill: 0.5, lwOuter: 0.42, lwInner: 0.45, lwTop: 0.42, lwSparse: 0.45, lwSolid: 0.42, lwSupport: 0.42 }), JSON.stringify(base));
    const rov = PRINT.configOverlay(tpl, Object.assign({}, base, { raft: 10 }));
    check('a raft of 10 on the card is the file\'s raft_layers = 10, and nothing else changes', JSON.stringify(rov) === JSON.stringify({ raft_layers: '10' }), JSON.stringify(rov));
    check('...which are the card\'s markup defaults too (shown before the template is fetched)', JSON.stringify(PRINT.SETTINGS_DEFAULT) === JSON.stringify(base));
    check('an untouched card changes nothing in the template', Object.keys(PRINT.configOverlay(tpl, base)).length === 0 && PRINT.withOverlay(tpl, {}) === tpl);
    /* NSO'S BASELINE: the template as the app fetches it carries NSO's own 0.33 support gap (the owner's PLA and PETG tests), listed as a
       process change; a template with its own number keeps it */
    {
      const nb = PRINT.nsoBaseline(tpl), nbs = PRINT.settingsFromConfig(nb), own = PRINT.nsoBaseline(PRINT.withOverlay(tpl, { support_top_z_distance: '0.25' }));
      check('NSO\'s baseline: the fetched template\'s support gap is 0.33 (Bambu\'s 0.2), listed among the process\'s changes; the card starts there and an untouched card changes nothing more; a template\'s own 0.25 stays',
        String(nb.support_top_z_distance) === '0.33' && nbs.supTopZ === 0.33 && Object.keys(PRINT.configOverlay(nb, nbs)).length === 0 &&
          String(nb.different_settings_to_system[0]).split(';').includes('support_top_z_distance') && String(own.support_top_z_distance) === '0.25',
        JSON.stringify([nb.support_top_z_distance, nbs.supTopZ, nb.different_settings_to_system && nb.different_settings_to_system[0], own.support_top_z_distance]));
      const nbP = PRINT.nsoBaseline(await L.p1sTemplate());
      check('...and on the P1S, Bambu PLA Basic\'s max flow is 30 (Bambu\'s 21; the owner\'s flow bars held to 36), a filament change of its own; the A1 mini\'s PLA keeps its own',
        String(nbP.filament_max_volumetric_speed[0]) === '30' && PRINT.filamentBase(nbP, 'profile').maxFlow === 30 && String(nbP.different_settings_to_system[1]).split(';').includes('filament_max_volumetric_speed') &&
          String([].concat(nb.filament_max_volumetric_speed)[0]) === String([].concat(tpl.filament_max_volumetric_speed)[0]),
        JSON.stringify([nbP.filament_max_volumetric_speed, nb.filament_max_volumetric_speed]));
      const fine = PRINT.qualityOverlay(nb, '0.4', '0.08mm Extra Fine @BBL A1M'), fineRaw = PRINT.qualityOverlay(tpl, '0.4', '0.08mm Extra Fine @BBL A1M');
      check('...and it stays over a fine preset\'s own gap (0.08 Extra Fine: Bambu\'s 0.08 on the stock template, NSO\'s 0.33 kept)',
        fine.support_top_z_distance === undefined && fineRaw.support_top_z_distance === '0.08' && fine.layer_height === '0.08', JSON.stringify([fine.support_top_z_distance, fineRaw.support_top_z_distance, fine.layer_height]));
    }
    let threw = '';
    try { PRINT.configOverlay(tpl, Object.assign({}, base, { nozzle: 1.0 })); } catch (e) { threw = e.message; }
    check('a nozzle the printer has no profile for is refused (a 1.0 on the A1 mini; its 0.2 / 0.6 / 0.8 are Bambu\'s presets, section 5f)', /no 1 mm nozzle profile/.test(threw), threw);
    const cl = PRINT.cleanSettings({ layer: '9', walls: '0', density: '150', pattern: 'no-such-pattern', angle: '0', brim: 'x', interfaceRule: 'column' });
    check('each row is clamped to what it takes, and an unknown pattern / brim is the default', cl.layer === 0.3 && cl.walls === 0 && cl.density === 100 && cl.pattern === 'grid' && cl.angle === 1 && cl.brim === 'auto' && cl.interfaceRule === 'column', JSON.stringify(cl));
    {
      /* THE WALL GENERATOR (Quality): Arachne and its six levers, by Studio's own keys - the percentages of the nozzle as Studio writes them */
      const wov = PRINT.configOverlay(tpl, Object.assign({}, base, { wallGen: 'arachne', wallAngle: 20, wallFilter: 30, wallTransLen: 150, wallDist: 2, minWall: 70, minFeature: 40 }));
      check('Arachne on the card is the file\'s wall_generator = arachne, and each lever its own key',
        JSON.stringify(wov) === JSON.stringify({ wall_generator: 'arachne', wall_transition_angle: '20', wall_transition_filter_deviation: '30%', wall_transition_length: '150%',
          wall_distribution_count: '2', min_bead_width: '70%', min_feature_size: '40%' }), JSON.stringify(wov));
      const eo = PL.engineOptions(PRINT.withOverlay(tpl, wov)).over;
      check('...the planner hands the engine each of them (a percentage as a fraction of the nozzle)',
        eo.wallGenerator === 'arachne' && eo.wallTransitionAngleDeg === 20 && Math.abs(eo.wallTransitionFilterMargin - 0.3) < 1e-9 && Math.abs(eo.wallTransitionLength - 1.5) < 1e-9 &&
          eo.wallDistributionCount === 2 && Math.abs(eo.minBeadWidth - 0.7) < 1e-9 && Math.abs(eo.minFeatureSize - 0.4) < 1e-9, JSON.stringify(eo));
      const back = PRINT.settingsFromConfig(PRINT.withOverlay(tpl, wov));
      check('...and a template that says Arachne shows it, levers and all, on the card\'s rows',
        back.wallGen === 'arachne' && back.wallAngle === 20 && back.wallFilter === 30 && back.wallTransLen === 150 && back.wallDist === 2 && back.minWall === 70 && back.minFeature === 40, JSON.stringify(back));
      check('...while the template\'s own (classic) hands the engine classic', PL.engineOptions(tpl).over.wallGenerator === 'classic');
      const wc = PRINT.cleanSettings({ wallGen: 'spider', wallAngle: '90', wallFilter: '-5', wallTransLen: '0', wallDist: '0', minWall: '1', minFeature: '200' });
      check('...each lever clamped to what Studio takes, an unknown generator is Classic',
        wc.wallGen === 'classic' && wc.wallAngle === 59 && wc.wallFilter === 0 && wc.wallTransLen === 1 && wc.wallDist === 1 && wc.minWall === 5 && wc.minFeature === 100, JSON.stringify(wc));
    }
    {
      /* THE SHELLS (Strength) and the feet as the owner prints them (bambu_arachne.gcode.3mf): no walls, no shells, 3D honeycomb 10 % */
      const sov = PRINT.configOverlay(tpl, Object.assign({}, base, { walls: 0, topLayers: 0, botLayers: 0, density: 10, pattern: '3dhoneycomb' }));
      check('no walls, no top, no bottom, 3D honeycomb 10 % on the card: the file\'s wall_loops 0, top / bottom_shell_layers 0, and nothing else',
        JSON.stringify(sov) === JSON.stringify({ wall_loops: '0', sparse_infill_density: '10%', sparse_infill_pattern: '3dhoneycomb', top_shell_layers: '0', bottom_shell_layers: '0' }), JSON.stringify(sov));
      const eo = PL.engineOptions(PRINT.withOverlay(tpl, sov)).over;
      check('...the planner hands the engine each of them', eo.wallLoops === 0 && eo.topShellLayers === 0 && eo.bottomShellLayers === 0 && eo.sparsePattern === '3dhoneycomb' &&
        Math.abs(eo.sparseDensity - 0.1) < 1e-9, JSON.stringify([eo.wallLoops, eo.topShellLayers, eo.bottomShellLayers, eo.sparsePattern, eo.sparseDensity]));
      const tov = PRINT.configOverlay(tpl, Object.assign({}, base, { topThick: 1.6, botThick: 0.8 }));
      check('...and the two thicknesses by Studio\'s keys', JSON.stringify(tov) === JSON.stringify({ top_shell_thickness: '1.6', bottom_shell_thickness: '0.8' }), JSON.stringify(tov));
      const sc = PRINT.cleanSettings({ topLayers: '-2', topThick: '99', botLayers: '7.4', botThick: 'x' });
      check('...each clamped to what it takes', sc.topLayers === 0 && sc.topThick === 20 && sc.botLayers === 7 && sc.botThick === 0, JSON.stringify([sc.topLayers, sc.topThick, sc.botLayers, sc.botThick]));
      const foot = await PRINT.build(objs.slice(0, 1), { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { walls: 0, topLayers: 0, botLayers: 0, density: 10, pattern: '3dhoneycomb' }) });
      check('...and a part sliced so is Sparse infill alone, as the owner\'s Studio slice of the feet: no wall, no top, no bottom, no solid (the coupon\'s auto brim aside)',
        foot.ok && JSON.stringify(foot.features.filter((f) => !/^Support|^Custom$|^Brim$/.test(f))) === JSON.stringify(['Sparse infill']), foot.ok ? 'features: ' + JSON.stringify(foot.features) : 'refused: ' + foot.reason);
    }
    const SURF = ['internal_solid_infill_pattern', 'top_surface_pattern', 'bottom_surface_pattern'];
    const ringOver = PRINT.configOverlay(tpl, Object.assign({}, base, { pattern: 'concentric' }));
    check('the infill row is the sparse infill\'s alone: concentric changes sparse_infill_pattern and nothing else', ringOver.sparse_infill_pattern === 'concentric' && Object.keys(ringOver).length === 1, JSON.stringify(ringOver));
    const all3 = v => ({ topSurf: v, botSurf: v, solidSurf: v });
    const surfOver = PRINT.configOverlay(tpl, Object.assign({}, base, all3('hilbertcurve')));
    check('the three surface rows (top, bottom, solid infill) are their three keys: hilbertcurve in all three, the sparse infill untouched',
      SURF.every(k => surfOver[k] === 'hilbertcurve') && Object.keys(surfOver).length === 3, JSON.stringify(surfOver));
    const oneOver = PRINT.configOverlay(tpl, Object.assign({}, base, { topSurf: 'zigzag' }));
    check('...each on its own: the top alone in rectilinear is top_surface_pattern = zig-zag and nothing else', JSON.stringify(oneOver) === JSON.stringify({ top_surface_pattern: 'zig-zag' }), JSON.stringify(oneOver));
    const legacy = PRINT.cleanSettings({ surface: 'concentric' });
    check('...and a setting saved before them (one surface for all three) is all three', legacy.topSurf === 'concentric' && legacy.botSurf === 'concentric' && legacy.solidSurf === 'concentric', JSON.stringify([legacy.topSurf, legacy.botSurf, legacy.solidSurf]));
    const lwOver = PRINT.configOverlay(tpl, Object.assign({}, base, { lwTop: 0.38, lwFirst: 0.55, topDens: 90, topPen: 3 }));
    check('the line width, density and paint rows are Studio\'s keys: top_surface_line_width 0.38, initial_layer_line_width 0.55, top_surface_density 90%, top_color_penetration_layers 3',
      JSON.stringify(lwOver) === JSON.stringify({ top_surface_density: '90%', top_color_penetration_layers: '3', initial_layer_line_width: '0.55', top_surface_line_width: '0.38' }), JSON.stringify(lwOver));
    {
      const eo2 = PL.engineOptions(PRINT.withOverlay(tpl, lwOver)).over;
      check('...and the planner hands them to the engine (the top 0.38, the first layer 0.55, 90 %, 3 layers of paint)', eo2.topWidthMm === 0.38 && eo2.firstLayerWidthMm === 0.55 && Math.abs(eo2.topDensity - 0.9) < 1e-9 && eo2.topColorPenetrationLayers === 3,
        JSON.stringify([eo2.topWidthMm, eo2.firstLayerWidthMm, eo2.topDensity, eo2.topColorPenetrationLayers]));
    }
    const bothOver = PRINT.configOverlay(tpl, Object.assign({}, base, { pattern: '3dhoneycomb' }, all3('archimedeanchords')));
    check('the two rows together, by Bambu\'s own names: 3dhoneycomb inside, archimedeanchords on the surfaces',
      bothOver.sparse_infill_pattern === '3dhoneycomb' && SURF.every(k => bothOver[k] === 'archimedeanchords') && Object.keys(bothOver).length === 4, JSON.stringify(bothOver));
    {
      const eo = PL.engineOptions(PRINT.withOverlay(tpl, bothOver)).over;
      check('...and the planner hands the engine each of them', eo.sparsePattern === '3dhoneycomb' && eo.solidPattern === 'archimedeanchords' && eo.topPattern === 'archimedeanchords' && eo.bottomPattern === 'archimedeanchords',
        [eo.sparsePattern, eo.solidPattern, eo.topPattern, eo.bottomPattern].join(' '));
      const plainO = PL.engineOptions(tpl).over;
      check('...and the template\'s own surfaces are Studio\'s: the top in monotonic lines, the bottom monotonic, the solid infill the engine\'s lines (zig-zag) (docs/SLICER.md "Monotonic")',
        plainO.solidPattern === undefined && plainO.topPattern === 'monotonicline' && plainO.bottomPattern === 'monotonic', [plainO.sparsePattern, plainO.solidPattern, plainO.topPattern, plainO.bottomPattern].join(' '));
      const back = PRINT.settingsFromConfig ? PRINT.settingsFromConfig(PRINT.withOverlay(tpl, bothOver)) : null;
      check('...and a template that names them shows them on the card\'s rows', !back || (back.pattern === '3dhoneycomb' && back.topSurf === 'archimedeanchords' && back.solidSurf === 'archimedeanchords'), back && back.pattern + ' / ' + back.topSurf);
      const cl2 = PRINT.cleanSettings({ pattern: 'rectilinear', topSurf: 'gyroid', botSurf: 'rectilinear' });
      check('...rectilinear is taken for zigzag, an unknown surface is the default (the top\'s monotonic line)', cl2.pattern === 'zigzag' && cl2.topSurf === 'monotonicline' && cl2.botSurf === 'zigzag', cl2.pattern + ' / ' + cl2.topSurf + ' / ' + cl2.botSurf);
    }

    const two = objs.slice(0, 2);
    const same = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
    const plain = await PRINT.build(two, { config: tpl, printer: a1 }, {});
    check('the profile\'s values slice to the same file as no settings at all (the G-code, byte for byte)', same.ok && plain.ok &&
      L.text(await L.R.openZip(same.bytes).read('Metadata/plate_1.gcode')) === L.text(await L.R.openZip(plain.bytes).read('Metadata/plate_1.gcode')));

    {
      let ringOpts = null;
      const SLr = require(path.join(ROOT, 'nso_slicer.js')), runR = SLr.run;
      SLr.run = function (ob, o) { ringOpts = o; return runR.apply(this, arguments); };
      let rings;
      try { rings = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { pattern: 'concentric' }, all3('concentric')) }); } finally { SLr.run = runR; }
      check('concentric on both rows slices to a file, the slicer told rings for the sparse infill, the solid infill and both surfaces', rings.ok && ringOpts &&
        ringOpts.sparsePattern === 'concentric' && ringOpts.solidPattern === 'concentric' && ringOpts.topPattern === 'concentric' && ringOpts.bottomPattern === 'concentric', rings.reason);
      if (rings.ok) {
        const rg = L.text(await L.R.openZip(rings.bytes).read('Metadata/plate_1.gcode'));
        check('...its CONFIG_BLOCK says concentric for all four', ['sparse_infill_pattern', 'internal_solid_infill_pattern', 'top_surface_pattern', 'bottom_surface_pattern']
          .every(k => (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(rg) || [])[1] === 'concentric'));
        check('...and the print is the same plastic as the lines\' within 5 % (' + plain.stats.grams + ' -> ' + rings.stats.grams + ' g)',
          Math.abs(rings.stats.grams / plain.stats.grams - 1) < 0.05);
      }
    }

    {
      /* Arachne through the whole build: the slicer told so, the file says so, and these two parts (no feature thinner than their walls) print the
         same plastic as Classic's within 1 % */
      let wOpts = null;
      const SLw = require(path.join(ROOT, 'nso_slicer.js')), runW = SLw.run;
      SLw.run = function (ob, o) { wOpts = o; return runW.apply(this, arguments); };
      let ar;
      try { ar = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { wallGen: 'arachne' }) }); } finally { SLw.run = runW; }
      check('Arachne slices to a file, the slicer told wallGenerator arachne with Studio\'s levers', ar.ok && wOpts && wOpts.wallGenerator === 'arachne' &&
        wOpts.wallTransitionAngleDeg === 10 && Math.abs(wOpts.minBeadWidth - 0.85) < 1e-9 && Math.abs(wOpts.minFeatureSize - 0.25) < 1e-9 && wOpts.wallDistributionCount === 1, ar.reason);
      if (ar.ok) {
        const ag = L.text(await L.R.openZip(ar.bytes).read('Metadata/plate_1.gcode'));
        check('...its CONFIG_BLOCK says wall_generator = arachne', /^; wall_generator = arachne$/m.test(ag));
        check('...the same plastic as Classic\'s within 1 % (' + plain.stats.grams.toFixed(2) + ' -> ' + ar.stats.grams.toFixed(2) + ' g)', Math.abs(ar.stats.grams / plain.stats.grams - 1) < 0.01);
      }
    }

    {
      /* every other pattern through the whole build: the planner takes its lines as it takes any */
      for (const [pat, surf] of [['3dhoneycomb', 'hilbertcurve'], ['archimedeanchords', 'archimedeanchords'], ['gyroid', 'octagramspiral'], ['honeycomb', 'zigzag'], ['cubic', 'zigzag'], ['adaptivecubic', 'zigzag']]) {
        const r = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { pattern: pat, surface: surf }) });
        check(pat + ' inside, ' + surf + ' surfaces: slices to a file, the plastic within 15 % of the lines\' (' + (r.ok ? r.stats.grams.toFixed(2) : '-') + ' g against ' + plain.stats.grams.toFixed(2) + ')',
          r.ok && Math.abs(r.stats.grams / plain.stats.grams - 1) < 0.15, r.reason);
      }
    }

    {
      const r = await PRINT.build(two, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { pattern: 'lightning' }) });
      check('lightning inside: slices to a file, with less plastic than the lines\' (' + (r.ok ? r.stats.grams.toFixed(2) : '-') + ' g against ' + plain.stats.grams.toFixed(2) + ')', r.ok && r.stats.grams < plain.stats.grams, r.reason);
    }

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
    check('the profile\'s filament is the template\'s PLA: 220 / 220 C, bed 65, 12 mm^3/s; CR-TPU is 215 / 235 C (first layer), bed 30 (Studio: the A1 mini TPU bed), 3.2 mm^3/s, printable 200 - 250 C',
      fb.nozzleTemp === 220 && fb.firstTemp === 220 && fb.bedTemp === 65 && fb.maxFlow === 12 &&
        tb.nozzleTemp === 215 && tb.firstTemp === 235 && tb.bedTemp === 30 && tb.maxFlow === 3.2 && tb.rangeLow === 200 && tb.rangeHigh === 250, JSON.stringify([fb, tb]));
    const pb = PRINT.filamentBase(tpl, 'elegoo-petg');
    check('PETG brings its own support top gap, 0.33 mm (two layers of air: the owner\'s Supporttest, support:gate-petg); PLA and CR-TPU keep the profile\'s',
      pb.supTopZ === 0.33 && fb.supTopZ === base.supTopZ && tb.supTopZ === base.supTopZ &&
        PRINT.configOverlay(tpl, Object.assign({}, base, { filament: 'elegoo-petg', supTopZ: pb.supTopZ })).support_top_z_distance === '0.33', JSON.stringify([pb.supTopZ, fb.supTopZ, base.supTopZ]));
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
      check('...the CONFIG_BLOCK names it on both filament slots: TPU, GFU99, Generic TPU @BBL A1M, 215 C, bed 30, 3.2 mm^3/s, fan 100 (retraction_length stays 0.8 there, as in the Studio TPU slice)',
        cb('filament_type') === 'TPU;TPU' && cb('filament_ids') === 'GFU99;GFU99' && cb('filament_settings_id') === '"Generic TPU @BBL A1M";"Generic TPU @BBL A1M"' &&
          cb('nozzle_temperature') === '215,215' && cb('textured_plate_temp') === '30,30' && cb('filament_max_volumetric_speed') === '3.2,3.2' &&
          cb('retraction_length') === '0.8' && cb('fan_min_speed') === '100,100',
        ['filament_type', 'filament_ids', 'filament_settings_id', 'nozzle_temperature', 'textured_plate_temp', 'filament_max_volumetric_speed', 'retraction_length', 'fan_min_speed'].map(cb).join(' | '));
      const tsi = L.text(await tz.read('Metadata/slice_info.config'));
      check('...slice_info tells the printer the filament is TPU (GFU99)', /tray_info_idx="GFU99" type="TPU"/.test(tsi));
      const tps = JSON.parse(L.text(await tz.read('Metadata/project_settings.config')));
      check('...project_settings.config holds it, listed as the filament\'s changes (not the process\'s)',
        tps.filament_type[0] === 'TPU' && tps.nozzle_temperature[0] === '215' && tps.filament_max_volumetric_speed[0] === '3.2' && tps.fan_min_speed[0] === '100' &&
          !/nozzle_temperature|filament_/.test(tps.different_settings_to_system[0]) && tps.different_settings_to_system[1].split(';').includes('filament_max_volumetric_speed'),
        JSON.stringify(tps.different_settings_to_system));
      const startOf = g => g.slice(g.indexOf('; EXECUTABLE_BLOCK_START'), g.indexOf('; CHANGE_LAYER')).split('\n');
      const ts = startOf(tg), psl = startOf(pg);
      check('...the start block is the filament\'s, not PLA\'s: set_filament_type:TPU, flush at 3.2 mm^3/s (F79.8237) and 250 C, the purge line at F192 / F320 / F1280',
        ts.filter(l => /set_filament_type:TPU$/.test(l)).length === 3 && !ts.some(l => /set_filament_type:PLA/.test(l)) &&
          ts.includes('    M620.1 E F79.8237 T250') && ts.includes('    G1 E50 F79.8237') &&
          ts.includes('G0 X88 E10  F192') && ts.includes('G0 X93 E.3742  F320') && ts.includes('G0 X98 E.3742  F1280') &&
          !ts.some(l => /F(720|4800|299\.339)$/.test(l)) && psl.includes('G0 X88 E10  F720') && psl.includes('    M620.1 E F299.339 T220'));
      check('...its temperatures are in the start block (bed 30, the first layer\'s 235 and the print\'s 215 where Bambu\'s template puts each) and its own filament start G-code replaces PLA\'s',
        ts.includes('M140 S30') && ts.includes('M190 S30;set bed temp') && ts.includes('    M109 S235') && ts.includes('M109 S215') && !ts.includes(';Prevent PLA from jamming') && psl.includes(';Prevent PLA from jamming'));
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
      check('...its start routine is timed with its own purges: the frozen 340 s for PLA, about a minute more for TPU\'s 3.2 mm^3/s flushes (Studio counted 6 m 54 s on the owner\'s TPU file)',
        pla.stats.startSeconds === 340 && tpu.stats.startSeconds > 340 + 40 && tpu.stats.startSeconds < 340 + 120, JSON.stringify([pla.stats.startSeconds, tpu.stats.startSeconds]));
      check('...the readout names it', tpu.filament === 'Creality CR-TPU 95A, 215 \u00b0C (first layer 235), bed 30 \u00b0C, 3.2 mm\u00b3/s', tpu.filament);
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

    // BRIDGES AND STRINGING (docs/FILAMENTS.md): the bridge's speed and flow (Quality), the filament's flow ratio, retraction and z-hop
    {
      const tb2 = PRINT.filamentBase(tpl, 'cr-tpu'), pb2 = PRINT.filamentBase(tpl, 'profile');
      check('the filament\'s own tuning: PLA flow ratio 0.98, retract 0.8 mm at 30 mm/s, z-hop 0.4; CR-TPU flow ratio 1, retract 0.4 mm at 30 mm/s, no z-hop (it prints straight up, the capsule of 2026-11-25), a cool wait of 8 s',
        pb2.flowRatio === 0.98 && pb2.retractLen === 0.8 && pb2.retractSpeed === 30 && pb2.zHop === 0.4 && pb2.coolWait == null && tb2.flowRatio === 1 && tb2.retractLen === 0.4 && tb2.retractSpeed === 30 && tb2.zHop === 0 && tb2.coolWait === 8, JSON.stringify([pb2, tb2]));
      check('...those rows at the filament\'s own values, and the bridge rows at the profile\'s 50 mm/s and 1, change nothing',
        Object.keys(PRINT.configOverlay(tpl, Object.assign({}, base, { bridgeSpeed: 50, bridgeFlow: 1, flowRatio: 0.98, retractLen: 0.8, retractSpeed: 30, zHop: 0.4 }))).length === 0);
      const ov = PRINT.configOverlay(tpl, Object.assign({}, base, { bridgeSpeed: 12, bridgeFlow: 0.9, flowRatio: 0.95, retractLen: 1.2, retractSpeed: 20, zHop: 0 }));
      check('a changed row is its Bambu key: bridge_speed, bridge_flow (the process\'s), filament_flow_ratio, filament_retraction_length, filament_(de)retraction_speed, filament_z_hop (the filament\'s own, the printer\'s keys left alone)',
        JSON.stringify(ov) === JSON.stringify({ filament_flow_ratio: '0.95', filament_retraction_length: '1.2', filament_retraction_speed: '20', filament_deretraction_speed: '20', filament_z_hop: '0', bridge_speed: '12', bridge_flow: '0.9' }), JSON.stringify(ov));
      check('CR-TPU lays no fill piece under 1 mm (the slicer\'s shortFillMm, docs/SLICER.md "No crumbs"); the profile\'s PLA lays them all, as Studio does',
        JSON.stringify(PRINT.FILAMENTS['cr-tpu'].slicer) === JSON.stringify({ shortFillMm: 1 }) && !PRINT.FILAMENTS.profile.slicer);
      {
        /* Retract before wipe: Bambu's retract_before_wipe, the filament's own key */
        const ovB = PRINT.configOverlay(tpl, Object.assign({}, base, { retractBefore: 100 }));
        check('Retract before wipe is filament_retract_before_wipe, a per cent; the profile\'s 0 changes nothing',
          JSON.stringify(ovB) === JSON.stringify({ filament_retract_before_wipe: '100%' }) && Object.keys(PRINT.configOverlay(tpl, Object.assign({}, base, { retractBefore: 0 }))).length === 0, JSON.stringify(ovB));
        const bodyOf = async st => { const r = await PRINT.build(objs.slice(0, 1), { config: tpl, printer: a1 }, { settings: Object.assign({}, base, st) }); const g = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n'); return g.slice(g.indexOf('; MACHINE_START_GCODE_END'), g.indexOf('; MACHINE_END_GCODE_START')); };
        const b0 = await bodyOf({}), b100 = await bodyOf({ retractBefore: 100 }), b50 = await bodyOf({ retractBefore: 50 });
        const wipes = b => { const out = []; b.forEach((l, i) => { if (l === '; WIPE_START') { const e = b.indexOf('; WIPE_END', i); out.push({ pre: b[i - 1], mid: b.slice(i + 2, e), post: b[e + 1] }); } }); return out; };
        const w0 = wipes(b0), w100 = wipes(b100), w50 = wipes(b50);
        check('...at 100 the whole 0.8 mm is pulled standing still, then the wipe is bare moves and nothing is pulled after it (' + w100.length + ' wipes, ' + w0.length + ' at 0)',
          w100.length === w0.length && w100.length > 5 && w100.every(w => w.pre === 'G1 E-.8 F1800' && w.mid.every(l => /^(G1 X[\d.]+ Y[\d.]+|M204 S\d+|M73 .*)$/.test(l)) && !/^G1 E-/.test(w.post)), JSON.stringify(w100.find(w => !(w.pre === 'G1 E-.8 F1800' && w.mid.every(l => /^(G1 X[\d.]+ Y[\d.]+|M204 S\d+|M73 .*)$/.test(l)) && !/^G1 E-/.test(w.post)))));
        check('...at 50 half of it first, the rest along the wipe and after, summing to the retraction',
          w50.every(w => w.pre === 'G1 E-.4 F1800' && Math.abs(w.mid.concat([w.post]).reduce((a, l) => a + (+((/E-([\d.]+)/.exec(l) || [0, 0])[1])), 0) - 0.4) < 2e-5), JSON.stringify(w50[1]));
        check('...and at 0 the file is as it was: no retraction before a wipe', w0.every(w => !/^G1 E-/.test(w.pre)));
      }
      const read = async r => {
        const g = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n');
        const body = g.slice(g.indexOf('; MACHINE_START_GCODE_END'), g.indexOf('; MACHINE_END_GCODE_START'));
        let feat = '', e = 0; const bridgeF = new Set(), bridgeW = new Set(), retr = {};
        body.forEach((l, i) => {
          let m;
          if ((m = /^; FEATURE: (.*)$/.exec(l))) feat = m[1];
          else if (feat === 'Bridge' && (m = /^G1 F([\d.]+)$/.exec(l))) bridgeF.add(+m[1]);
          else if (feat === 'Bridge' && (m = /^; LINE_WIDTH: ([\d.]+)$/.exec(l))) bridgeW.add(+m[1]);
          if ((m = /^G1 E-(\.?[\d.]+) F(\d+)$/.exec(l))) retr[m[1] + '@' + m[2]] = (retr[m[1] + '@' + m[2]] || 0) + 1;
          if ((m = /^G1 X[-\d.]+ Y[-\d.]+ E(\.?[\d.]+)$/.exec(l))) e += +m[1];
        });
        return { bridgeF: [...bridgeF], bridgeW: [...bridgeW], retr, hops: body.filter(l => /^G3 Z/.test(l)).length, wipes: body.filter(l => l === '; WIPE_START').length, e, cfg: k => (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(g.join('\n')) || [])[1] };
      };
      const one2 = objs.slice(0, 1);
      const t0 = await PRINT.build(one2, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu' }) });
      const t1 = await PRINT.build(one2, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', bridgeSpeed: 12, bridgeFlow: 0.9, flowRatio: 0.97, retractLen: 0.8, retractSpeed: 20, zHop: 0.4 }) });
      check('CR-TPU slices with the tuning rows changed', t0.ok && t1.ok, t1.reason);
      if (t0.ok && t1.ok) {
        const a = await read(t0), b = await read(t1);
        /* a bridge by its kind: over open air a line of the layer's height, 0.45 wide (39.3 mm/s at 3.2 mm^3/s); over sparse infill the 0.4 mm round strand (25.5 mm/s) */
        check('...untouched, a CR-TPU bridge is held by the 3.2 mm^3/s max flow, though the profile says 50: 39.3 mm/s (F2358.261) over open air, 25.5 mm/s (F1527.887) over sparse infill',
          a.bridgeF.every(f => f === 2358.261 || f === 1527.887) && a.bridgeF.includes(2358.261) && a.bridgeW.every(w => w === 0.45 || w === 0.4), JSON.stringify([a.bridgeF, a.bridgeW]));
        check('...Bridge speed 12 and Bridge flow 0.9: every bridge at F720, its strand 0.9 of what it was (0.405 or 0.379 mm); bridge_speed = 12 and bridge_flow = 0.9 in the file',
          JSON.stringify(b.bridgeF) === '[720]' && b.bridgeW.every(w => Math.abs(w - 0.45 * 0.9) < 1e-5 || Math.abs(w - 0.4 * Math.sqrt(0.9)) < 1e-5) && b.cfg('bridge_speed') === '12' && b.cfg('bridge_flow') === '0.9', JSON.stringify([b.bridgeF, b.bridgeW]));
        check('...Retraction 0.8 mm at 20 mm/s: all of it at F1200, where it was 0.4 at F1800 - in one pull, as CR-TPU does not wipe (filament_wipe = 0)',
          a.retr['.4@1800'] > 100 && !a.retr['.8@1200'] && b.retr['.8@1200'] > 100 && !b.retr['.4@1800'] && a.wipes === 0 && b.wipes === 0, JSON.stringify([a.retr, b.retr, a.wipes]));
        check('...CR-TPU lifts on no travel or layer change (filament_z_hop = 0); Z hop 0.4 typed in brings the layer change\'s lift back (' + a.hops + ' before, ' + b.hops + ' after)', a.hops === 0 && b.hops > 50);
        check('...Flow ratio 0.97: filament_flow_ratio = 0.97 on both slots, and less filament for the same plate', b.cfg('filament_flow_ratio') === '0.97,0.97' && b.e < a.e, a.e.toFixed(1) + ' -> ' + b.e.toFixed(1));
        check('...the readout has the numbers as printed', t0.tune === 'bridges 39.3 mm/s (flow 1), flow ratio 1, retract 0.4 mm at 30 mm/s, z-hop 0 mm' &&
          t1.tune === 'bridges 12 mm/s (flow 0.9), flow ratio 0.97, retract 0.8 mm at 20 mm/s, z-hop 0.4 mm', JSON.stringify([t0.tune, t1.tune]));
      }
    }

    // COOL WAIT (docs/FILAMENTS.md "Cool wait"): a layer still faster than the filament's time at the slowest speed waits the rest out off the part
    {
      /* a 3 mm square pillar 12 mm tall in the bed's middle: its layers print in about a second at 10 mm/s */
      const pillar = (s, h) => { const c = [[-s, -s], [s, -s], [s, s], [-s, s]], t = []; const q = (a, b, cc, d) => t.push(...a, ...b, ...cc, ...a, ...cc, ...d);
        const P = (i, z) => [c[i][0], c[i][1], z];
        q(P(0, 0), P(3, 0), P(2, 0), P(1, 0)); q(P(0, h), P(1, h), P(2, h), P(3, h));
        for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; q(P(i, 0), P(j, 0), P(j, h), P(i, h)); }
        return Float32Array.from(t); };
      const pObjs = PRINT.pieceObjects([{ name: 'pillar', file: 'pillar.stl', soup: pillar(1.5, 12), sourceId: 9 }], a1.bed);
      const w0 = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', coolPillar: false }) });
      const wPil = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu' }) });
      const w1 = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', coolWait: 0 }) });
      const wP = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
      check('a thin CR-TPU pillar slices with its cool wait, without it, and in the profile\'s PLA', w0.ok && w1.ok && wP.ok && wPil.ok, w0.reason || w1.reason || wP.reason || wPil.reason);
      if (w0.ok && w1.ok && wP.ok && wPil.ok) {
        const g = async r => L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n');
        const g0 = await g(w0), g1 = await g(w1), gP = await g(wP);
        const waits = gl => gl.map((l, i) => l.startsWith('; NSO cool wait:') ? i : -1).filter(i => i >= 0);
        const i0 = waits(g0), k = i0[3];
        const zOf = l => +(/Z([\d.]+)/.exec(l) || [0, NaN])[1];
        const zBefore = (() => { for (let i = k; i > 0; i--) { const m = /^; Z_HEIGHT: ([\d.]+)/.exec(g0[i]); if (m) { for (let j = i - 1; j > 0; j--) { const m2 = /^; Z_HEIGHT: ([\d.]+)/.exec(g0[j]); if (m2) return +m2[1]; } } } return NaN; })();
        check('CR-TPU: every layer of it but the first and the last is followed by a wait (' + i0.length + ' of ' + w0.stats.layers + ' layers), and the readout says so',
          i0.length === w0.stats.layers - 2 && w0.stats.coolWait && w0.stats.coolWait.layers === i0.length && w0.stats.coolWait.seconds === 8, JSON.stringify(w0.stats.coolWait));
        check('...each one retracted, 1 mm up, 10 mm off the pillar in X, then G4 for what the layer lacks of 8 s - no filament spent',
          /^G1 E-/.test(g0[k - 1]) && /^M204/.test(g0[k + 1]) && Math.abs(zOf(g0[k + 2]) - (zBefore + 1)) < 1e-6 && /^G1 X[\d.]+ Y[\d.]+ F/.test(g0[k + 3]) && /^G4 P\d+$/.test(g0[k + 4]) &&
          +/P(\d+)/.exec(g0[k + 4])[1] > 3000 && +/P(\d+)/.exec(g0[k + 4])[1] < 8000 && Math.abs(w0.stats.grams - w1.stats.grams) < 1e-6, g0.slice(k - 1, k + 6).join(' | '));
        check('...the print\'s time counts the waits (' + Math.round(w1.stats.seconds) + ' s -> ' + Math.round(w0.stats.seconds) + ' s)', w0.stats.seconds - w1.stats.seconds > w0.stats.coolWait.total * 0.95);
        check('...Cool wait 0 turns it off, and the profile\'s PLA has none', waits(g1).length === 0 && waits(gP).length === 0 && !w1.stats.coolWait && !wP.stats.coolWait && !w1.stats.coolPillar && !wP.stats.coolPillar);
        /* THE COOL PILLAR (CR-TPU's own): beside the part, printed first on each layer, the wait spent over it */
        const gq = await g(wPil), pi = wPil.stats.coolPillar;
        const opened = []; gq.forEach(l => { const m = /^; start printing object, unique label id: (\d+)/.exec(l); if (m) opened.push(m[1]); });
        const wq = waits(gq);
        const nextOpen = i => { for (let j = i; j < gq.length; j++) { const m = /^; start printing object, unique label id: (\d+)/.exec(gq[j]); if (m) return m[1]; } return null; };
        check('CR-TPU puts a 6 mm cool pillar 12 mm beside the part, as tall as the part\'s last fast layer (' + JSON.stringify(pi) + '), and the owner\'s pieces are still one object',
          pi && pi.size === 6 && Math.abs(pi.x - (a1.bed.x / 2 + 1.5 + 12 + 3)) < 0.01 && pi.height > 11 && pi.height <= 12.01 && wPil.objects === 1 && wPil.labels.length === 1, JSON.stringify([pi, wPil.labels]));
        check('...every wait is over the pillar and the pillar is what prints next (' + wq.length + ' waits), its layers first, then the part\'s',
          wq.length > 0 && wq.every(i => / over the cool pillar$/.test(gq[i]) && nextOpen(i) === '1002'), gq.slice(wq[0], wq[0] + 12).join(' | '));
        check('...the waits are shorter for it (' + w0.stats.coolWait.total.toFixed(0) + ' s off the part -> ' + wPil.stats.coolWait.total.toFixed(0) + ' s over the pillar), for ' + (wPil.stats.grams - w0.stats.grams).toFixed(2) + ' g of pillar',
          wPil.stats.coolWait.total < w0.stats.coolWait.total / 2 && wPil.stats.grams > w0.stats.grams);
        /* PAUSE AT: the steady chuck's pauses */
        const wz = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { pauseAt: '8, 5,abc' }) });
        const gz = wz.ok ? await g(wz) : [];
        const pz = gz.map((l, i) => l === '; PAUSE_PRINT' ? i : -1).filter(i => i >= 0);
        const zh = i => { for (let j = i; j > 0; j--) { const m = /^; Z_HEIGHT: ([\d.]+)/.exec(gz[j]); if (m) return +m[1]; } return NaN; };
        check('Pause at "8, 5,abc": two pauses, before the layers at 5 and 8 mm - retracted, 5 mm up, the A1 mini\'s park, M400 U1 - and the readout says so (' + JSON.stringify(wz.stats && wz.stats.pauses) + ')',
          wz.ok && pz.length === 2 && zh(pz[0]) === 5 && zh(pz[1]) === 8 && JSON.stringify(wz.stats.pauses) === '[5,8]' &&
          pz.every(i => /^G1 Z[\d.]+ F/.test(gz[i + 3]) && gz[i + 4] === 'G1 X0 Y90 F18000' && gz[i + 5] === 'G1 X-13.5 F3000' && gz[i + 6] === 'M400 U1') &&
          Math.abs(+/Z([\d.]+)/.exec(gz[pz[0] + 3])[1] - (5 - 0.2 + 5)) < 1e-6, gz.slice(pz[0] - 2, pz[0] + 10).join(' | '));
        /* THE BRACE: an 8 mm pillar 4 mm off, a link every 4 mm into the part's wall */
        const wb = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { braceEvery: 4 }) });
        const gb = wb.ok ? await g(wb) : [];
        const reach = zz => { let z = null, ob = null, x = 0, y = 0; const o = {};
          gb.forEach(l => { let m; if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(l))) z = +m[1]; if ((m = /^; start printing object, unique label id: (\d+)/.exec(l))) ob = m[1];
            if ((m = /^G1 (.*)/.exec(l))) { const d = {}; m[1].replace(/([XYE])(-?[\d.]+)/g, (q, k, v) => { d[k] = +v; return q; }); const nx = d.X != null ? d.X : x, ny = d.Y != null ? d.Y : y;
              /* where each extruding line crosses y = 90, the pillar's line */
              if (Math.abs(z - zz) < 1e-6 && d.E > 0 && (y - 90) * (ny - 90) <= 0 && ny !== y) (o[ob] = o[ob] || []).push(x + (nx - x) * (90 - y) / (ny - y));
              x = nx; y = ny; } });
          return o; };
        const r8 = reach(7.8), r6 = reach(6.6);
        check('Brace every 4: an 8 mm pillar 4 mm off the part, PLA as well as TPU, with a link at 4 and 8 mm (' + JSON.stringify(wb.stats && wb.stats.coolPillar) + '), the owner\'s piece still one object',
          wb.ok && wb.stats.coolPillar.size === 8 && wb.stats.coolPillar.links === 2 && wb.stats.coolPillar.brace === 4 && wb.objects === 1 && Math.abs(wb.stats.coolPillar.x - (a1.bed.x / 2 + 1.5 + 4 + 4)) < 0.01, JSON.stringify(wb.stats && wb.stats.coolPillar));
        check('...on a link\'s layer the pillar\'s lines run into the part\'s outer wall (the link\'s end within a line of the wall\'s); between links they stop at the pillar\'s face',
          r8['1002'] && r8['1001'] && Math.min(...r8['1002']) - Math.max(...r8['1001']) < 0.42 && r6['1002'] && Math.min(...r6['1002']) > 95, JSON.stringify([r8, r6].map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [Math.min(...v), Math.max(...v)]])))));
        /* FLOW TEST: every line of a band at exactly its flow, the filament through the hotend (flow ratio in) */
        const wf = await PRINT.build(pObjs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { flowTest: '4, 1, 4' }) });
        const gf = wf.ok ? await g(wf) : [];
        const Af = Math.PI * 1.75 * 1.75 / 4, rate = {}; let fz = 0, fx = 0, fy = 0, fF = 0, fon = false;
        gf.forEach(l => { let m; if (l === '; MACHINE_START_GCODE_END') fon = true; if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(l))) fz = +m[1];
          if ((m = /^G1 (.*)/.exec(l))) { const d = {}; m[1].replace(/([XYEF])(-?[\d.]+)/g, (q, k, v) => { d[k] = +v; return q; }); if (d.F != null) fF = d.F;
            const nx = d.X != null ? d.X : fx, ny = d.Y != null ? d.Y : fy, len = Math.hypot(nx - fx, ny - fy);
            if (fon && d.E > 0 && len > 0.3 && fz > 0.2) { const b = Math.floor((fz - 1e-6) / 4); (rate[b] = rate[b] || []).push(d.E * Af / (len / (fF / 60))); }
            fx = nx; fy = ny; } });
        const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
        check('Flow test "4, 1, 4": the bands 4, 5, 6 mm^3/s up the pillar (from the second layer), each line\'s filament at its band\'s rate, marked in the file and the readout',
          wf.ok && JSON.stringify(wf.stats.flowTest.map(b => b.flow)) === '[4,5,6]' && wf.stats.flowTest[1].fromZ === 4 &&
            [0, 1, 2].every(b => rate[b] && Math.abs(med(rate[b]) - (4 + b)) < 0.05) && gf.filter(l => /^; NSO flow test: /.test(l)).length === 3,
          JSON.stringify([wf.stats && wf.stats.flowTest, [0, 1, 2].map(b => rate[b] && med(rate[b]))]));
        /* A G-CODE THAT DEFLATES PAST 20 : 1 IS STORED (nso-3mf.js ZIP_MAX_RATIO): Bambu's cloud refused the 44 : 1 flow tube with a bare HTTP 400 */
        {
          const zi = b => { const v = new DataView(b.buffer, b.byteOffset, b.byteLength); const out = {}; let at = 0;
            while (at + 30 <= b.length && v.getUint32(at, true) === 0x04034b50) { const m = v.getUint16(at + 8, true), cs = v.getUint32(at + 18, true), us = v.getUint32(at + 22, true), nl = v.getUint16(at + 26, true), xl = v.getUint16(at + 28, true);
              out[Buffer.from(b.subarray(at + 30, at + 30 + nl)).toString()] = { m, cs, us }; at += 30 + nl + xl + cs; } return out; };
          const zf = zi(wf.bytes), zp = zi(w1.bytes), gq = zf['Metadata/plate_1.gcode'], gp = zp['Metadata/plate_1.gcode'];
          const ok8 = e => e.m === 0 || e.us <= 65536 || e.us < 8 * e.cs;
          check('the 3MF\'s G-code is deflated as Studio\'s is, but stored when deflating would squeeze it past 8 : 1 - Bambu\'s cloud refuses that (HTTP 400): the pillar plates (about 10 : 1) are stored, and no entry is deflated past 8 : 1',
            gp && gp.m === 0 && gq && gq.m === 0 && Object.values(zf).every(ok8) && Object.values(zp).every(ok8), JSON.stringify([gp, gq]));
        }
        check('...Cool pillar off keeps the wait off the part, as above', w0.stats.coolPillar == null && waits(g0).every(i => !/pillar/.test(g0[i])));
      }
    }

    // BRIDGE TEMPERATURE: the bridges at their own nozzle temperature, changed at the printer's park (docs/FILAMENTS.md)
    {
      const cp = objs.slice(0, 1);
      /* THE FILAMENT HOLDS ITS DIALS: CR-TPU brings a bridge temperature of its own on the A1 mini (215); the row at 0 turns it off, a number in the row wins */
      const own = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu' }) });
      const plaB = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base) });
      check('picking CR-TPU is enough: it prints at its own 215 C, its bridges too (the owner\'s 2026-11-15 roof), so it asks for no bridge temperature and makes no stop at the park; nor does the profile\'s PLA',
        own.ok && plaB.ok && own.stats.bridgeTemp === null && plaB.stats.bridgeTemp === null &&
          PRINT.filamentBase(tpl, 'cr-tpu').bridgeTemp === null && PRINT.filamentBase(tpl, 'profile').bridgeTemp === null && PRINT.cleanSettings({ bridgeTemp: '0' }).bridgeTemp === 0 && PRINT.cleanSettings({ bridgeTemp: '' }).bridgeTemp === null,
        JSON.stringify([own.stats && own.stats.bridgeTemp, plaB.stats && plaB.stats.bridgeTemp]));
      const off = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 0 }) });
      const on = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 212 }) });
      check('CR-TPU slices with a bridge temperature of 212', off.ok && on.ok, on.reason);
      {
        /* FROM A LAYER ON: every layer from the row's to the top at the bridge temperature - one change in, none out */
        const fr = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 212, bridgeTempFrom: 5 }) });
        const gf = fr.ok ? L.text(await L.R.openZip(fr.bytes).read('Metadata/plate_1.gcode')).split('\n') : [];
        const pk = gf.map((l, i) => /^; NSO bridge temperature/.test(l) ? i : -1).filter(i => i >= 0);
        const zOf = i => { for (let j = i; j >= 0; j--) if (/^; Z_HEIGHT: /.test(gf[j])) return +gf[j].slice(11); return null; };
        check('Bridge temp from layer 5: one change at the park, to 212, before layer 5 (z 1.0), and none after it; the readout says so',
          fr.ok && pk.length === 1 && gf[pk[0]] === '; NSO bridge temperature: 212 for the bridges' && Math.abs(zOf(pk[0]) - 1.0) < 1e-6 &&
            fr.stats.bridgeTemp.fromLayer === 5 && /^212 \u00b0C from layer 5 to the top/.test(PRINT.bridgeTempWords(fr.stats.bridgeTemp)) &&
            PRINT.cleanSettings({ bridgeTempFrom: '1' }).bridgeTempFrom === null && PRINT.cleanSettings({ bridgeTempFrom: '36' }).bridgeTempFrom === 36,
          JSON.stringify([fr.reason, pk.map(i => gf[i] + ' @' + zOf(i)), fr.stats && fr.stats.bridgeTemp]));
      }
      if (off.ok && on.ok) {
        const g = L.text(await L.R.openZip(on.bytes).read('Metadata/plate_1.gcode')).split('\n'), g0 = L.text(await L.R.openZip(off.bytes).read('Metadata/plate_1.gcode')).split('\n');
        const body = g.slice(g.indexOf('; MACHINE_START_GCODE_END'), g.indexOf('; MACHINE_END_GCODE_START')).filter(l => !/^M73 /.test(l));   /* (the progress marks fall where they fall) */
        const parks = []; body.forEach((l, i) => { if (/^; NSO bridge temperature: /.test(l)) parks.push(i); });
        const bt = on.stats.bridgeTemp;
        check('...the coupon has bridges over open air on ' + bt.layers + ' layers, in stretches: ' + bt.changes + ' changes, 212 going in and the layer\'s 235 coming out, in turn',
          bt.layers >= 1 && bt.changes >= 2 && bt.changes % 2 === 0 && bt.changes <= 2 * bt.layers && parks.length === bt.changes &&
            parks.every((i, n) => body[i] === (n % 2 === 0 ? '; NSO bridge temperature: 212 for the bridges' : '; NSO bridge temperature: 235 after the bridges')), JSON.stringify(bt));
        const blockOk = parks.every((i, n) => {
          const b = body.slice(i + 1, i + 14), t = n % 2 === 0 ? 212 : 235;
          return /^M204 S\d+$/.test(b[0]) ? /^G1 Z[\d.]+$/.test(b[1]) && b[2] === 'G1 X0 Y90 F18000' && b[3] === 'G1 X-13.5 F3000' && b[4] === 'M109 S' + t && b[5] === 'G1 E1.4 F79.8237' &&
            b[6] === 'G1 E-.4 F1800' && b[7] === 'G1 X0 F30000 ;wipe and shake' && b[8] === 'G1 X-13.5 F3000' && b[9] === 'G1 X0 F30000 ;wipe and shake' && b[10] === 'G1 X-13.5 F3000' && b[11] === 'G1 X0 F12000 ;wipe and shake'
            : /^G1 Z[\d.]+$/.test(b[0]) && b[1] === 'G1 X0 Y90 F18000' && b[2] === 'G1 X-13.5 F3000' && b[3] === 'M109 S' + t && b[4] === 'G1 E1.4 F79.8237' &&
            b[5] === 'G1 E-.4 F1800' && b[6] === 'G1 X0 F30000 ;wipe and shake' && b[7] === 'G1 X-13.5 F3000' && b[8] === 'G1 X0 F30000 ;wipe and shake' && b[9] === 'G1 X-13.5 F3000' && b[10] === 'G1 X0 F12000 ;wipe and shake';
        });
        check('...each is the A1 mini\'s own park: lift, X0 Y90, X-13.5, M109, prime the retraction and 1 mm at the flush speed, retract, wipe and shake three times', blockOk, body.slice(parks[0], parks[0] + 14).join(' / '));
        // what is extruded between a park in and the park out is a bridge; the nozzle is retracted when it leaves and primed when it is back
        let feat = '', cold = false, coldOther = 0, coldBridge = 0, lifted = true, lastE = 0, leftRetracted = true;
        body.forEach((l, i) => {
          let m;
          if ((m = /^; FEATURE: (.*)$/.exec(l))) feat = m[1];
          if (/^; NSO bridge temperature: 212/.test(l)) { cold = true; if (lastE >= 0) leftRetracted = false; }
          else if (/^; NSO bridge temperature: 235/.test(l)) { cold = false; if (lastE >= 0) leftRetracted = false; }
          if ((m = /^G1 (?:X[-\d.]+ Y[-\d.]+ )?E(-?\.?[\d.]+)/.exec(l))) { lastE = +m[1]; if (cold && +m[1] > 0 && /^G1 X/.test(l)) { if (feat === 'Bridge') coldBridge++; else coldOther++; } }
        });
        const bridgesAll = body.filter((l, i) => l === '; FEATURE: Bridge').length;
        check('...the open-air bridges are laid at 212 (' + coldBridge + ' bridge moves in the cold stretches) and the nozzle is retracted whenever it leaves for the park', coldBridge > 20 && leftRetracted, JSON.stringify({ coldBridge, coldOther, leftRetracted, bridgesAll }));
        check('...the only M109 in the body are the parks\', and the file without a bridge temperature has none', body.filter(l => /^M109 /.test(l)).length === bt.changes &&
          !g0.slice(g0.indexOf('; MACHINE_START_GCODE_END'), g0.indexOf('; MACHINE_END_GCODE_START')).some(l => /^M109 |NSO bridge/.test(l)));
        check('...the time counts 15 s a change, and the readout says so', Math.abs((on.stats.seconds - off.stats.seconds) - 15 * bt.changes) < 20 &&
          PRINT.bridgeTempWords(bt) === 'bridges at 212 \u00b0C on ' + bt.layers + ' layers: ' + bt.changes + ' nozzle temperature changes at the park, about ' + PRINT.fmtTime(15 * bt.changes),
          PRINT.bridgeTempWords(bt) + ' / +' + Math.round(on.stats.seconds - off.stats.seconds) + ' s');
      }
      // a plate of labelled objects: the park is no object's
      const lab = await PRINT.build(objs, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 212 }) });
      check('a plate of several objects slices with it', lab.ok, lab.reason);
      if (lab.ok) {
        const gl = L.text(await L.R.openZip(lab.bytes).read('Metadata/plate_1.gcode')).split('\n');
        let open = false, inside = 0, n = 0;
        gl.forEach(l => { if (/^M624 /.test(l)) open = true; else if (l === 'M625') open = false; else if (/^; NSO bridge temperature/.test(l)) { n++; if (open) inside++; } });
        check('...no park is inside an object\'s M624 / M625 (a skipped object does not take the temperature change with it): ' + n + ' parks', n > 0 && inside === 0, inside + ' inside');
      }
      const hot = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 190 }) });
      check('a bridge temperature outside the filament\'s range is refused in words', !hot.ok && /bridge temperature is 190 .C; this filament prints between 200 and 250/.test(hot.reason), hot.reason);
      const same = await PRINT.build(cp, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 235 }) });
      check('a bridge temperature that is the layer\'s own changes nothing: no park', same.ok && same.stats.bridgeTemp.changes === 0 &&
        L.text(await L.R.openZip(same.bytes).read('Metadata/plate_1.gcode')) === L.text(await L.R.openZip(off.bytes).read('Metadata/plate_1.gcode')));
    }

    // A FREE BRIDGE IS LAID ACROSS ITS GAP, AND ITS STRETCH PRINTS AT THE BRIDGE TEMPERATURE (the owner's tower level, 2026-11-14)
    {
      // a doorway: two pillars 5 mm wide, 30 mm apart, a roof 3 mm thick over them from 9 mm up, 8 mm deep and open on both faces
      const P2 = [[0, 0], [5, 0], [5, 9], [35, 9], [35, 0], [40, 0], [40, 12], [0, 12]], TR = [[0, 1, 2], [0, 2, 7], [7, 2, 6], [2, 3, 6], [3, 4, 5], [3, 5, 6]];
      const sp = [], D = 8, V = (i, y) => [P2[i][0] - 20, y - D / 2, P2[i][1]];
      TR.forEach(t => { [t[0], t[1], t[2]].forEach(i => sp.push(...V(i, 0))); [t[0], t[2], t[1]].forEach(i => sp.push(...V(i, D))); });       // the two faces
      P2.forEach((q, i) => { const j = (i + 1) % P2.length; [[i, 0], [i, D], [j, D]].forEach(a => sp.push(...V(a[0], a[1]))); [[i, 0], [j, D], [j, 0]].forEach(a => sp.push(...V(a[0], a[1]))); });
      const door = PRINT.pieceObjects([{ name: 'doorway', soup: new Float32Array(sp), sourceId: 1 }], a1.bed);
      const dr = await PRINT.build(door, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, { filament: 'cr-tpu', nozzleTemp: 235, bridgeTemp: 215, hangSpeed: 300 }) });   /* hanging walls at the bridge's speed, as Studio prints them (CR-TPU's own 10 is checked after) */
      check('a doorway (a 30 x 8 mm roof between two pillars, open on both faces) slices as CR-TPU with a bridge temperature', dr.ok, dr.reason);
      if (dr.ok) {
        const g = L.text(await L.R.openZip(dr.bytes).read('Metadata/plate_1.gcode')).split('\n');
        const body = g.slice(g.indexOf('; MACHINE_START_GCODE_END'), g.indexOf('; MACHINE_END_GCODE_START'));
        let feat = '', z = 0, x = null, y = null, cold = false, fNow = 0; const br = [], ow = [], coldZ = new Set(), hotFeat = {}, ev = [];
        body.forEach(l => {
          let m;
          if ((m = /^; Z_HEIGHT: ([\d.]+)$/.exec(l))) z = +m[1];
          else if ((m = /^; FEATURE: (.*)$/.exec(l))) feat = m[1];
          else if ((m = /^; NSO bridge temperature: (\d+)/.exec(l))) { cold = +m[1] === 215; ev.push([+m[1], z]); }
          if (!/^G[0-3] /.test(l)) return;
          const d = {}; l.split(';')[0].replace(/([XYEF])(-?\.?[\d.]+)/g, (a, k, v) => { d[k] = +v; return a; });
          const nx = d.X != null ? d.X : x, ny = d.Y != null ? d.Y : y;
          if (d.F != null) fNow = d.F;
          if (d.E > 0 && x != null && (d.X != null || d.Y != null)) {
            const len = Math.hypot(nx - x, ny - y);
            if (feat === 'Bridge' && z > 8.9) br.push({ len, along: Math.abs(nx - x) / (len || 1), z, f: fNow });
            if (feat === 'Overhang wall' && z > 8.9) ow.push({ len, f: fNow });
            if (cold) coldZ.add(z); else if (z >= 9.1 && z <= 9.5) hotFeat[feat] = 1;
          }
          x = nx; y = ny;
        });
        const z0 = Math.min(...br.map(b => b.z)), roof = br.filter(b => b.z === z0);                        /* the roof's underside (higher up there is a bridge over the roof's own sparse infill) */
        const total = roof.reduce((a, b) => a + b.len, 0), alongX = roof.filter(b => b.along > 0.99).reduce((a, b) => a + b.len, 0), longest = Math.max(...roof.map(b => b.len));
        check('...the roof\'s bridge runs from pillar to pillar: ' + Math.round(100 * alongX / total) + ' % of its ' + Math.round(total) + ' mm along the 30 mm gap, the longest line ' + longest.toFixed(1) + ' mm (at 45 degrees none is over 11.4)',
          total > 300 && alongX / total > 0.85 && longest > 27, JSON.stringify({ total, alongX, longest }));
        const lhOf = {}; let lhNow = null, ftNow = '';
        body.forEach(l => { let m; if ((m = /^; FEATURE: (.*)$/.exec(l))) ftNow = m[1]; else if ((m = /^; LAYER_HEIGHT: ([\d.]+)$/.exec(l))) { lhNow = +m[1]; } if (ftNow === 'Bridge' && lhNow != null && /^G1 F/.test(l)) lhOf[lhNow] = (lhOf[lhNow] || 0) + 1; });
        check('...it is Studio\'s strand for a bridge over open air: the layer\'s own height, at the max flow\'s 39.3 mm/s (F2358.261), not the 0.4 mm round one at 25.5',
          roof.every(b => b.f === 2358.261) && lhOf[0.2] >= 1, JSON.stringify([[...new Set(roof.map(b => b.f))], lhOf]));
        const spans = ow.filter(b => b.len > 20), slow = ow.filter(b => b.f === 600);
        check('...the walls over the gap are printed as bridges: ' + spans.length + ' moves of ' + (spans[0] ? spans[0].len.toFixed(1) : '-') + ' mm, each one move at the max flow\'s speed (F2358 / F2545), and only the ends beside the pillars at overhang_4_4_speed (' + slow.length + ' short moves at F600)',
          spans.length === 4 && spans.every(b => b.f > 2300) && ow.filter(b => b.f === 600).every(b => b.len < 1.5), JSON.stringify(ow.filter(b => b.len > 1).map(b => [+b.len.toFixed(1), b.f])));
        /* HANGING WALL SPEED: a row typed in slows those four walls - and nothing else; empty, CR-TPU and the profile's PLA keep the bridge's speed
           (CR-TPU carried its own 10 for one print, 2026-11-15: the lip no better, the bridges worse) */
        const wallsOf = async st => { const r = await PRINT.build(door, { config: tpl, printer: a1 }, { settings: Object.assign({}, base, st) }); const gg = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n');
          let ft = '', zz = 0, px = null, py = null, f = 0; const out = [], other = [];
          gg.forEach(l => { let m; if ((m = /^; Z_HEIGHT: ([\d.]+)$/.exec(l))) zz = +m[1]; else if ((m = /^; FEATURE: (.*)$/.exec(l))) ft = m[1]; if (!/^G1 /.test(l)) return;
            const d = {}; l.split(';')[0].replace(/([XYEF])(-?\.?[\d.]+)/g, (a, k, v) => { d[k] = +v; return a; }); const nx = d.X != null ? d.X : px, ny = d.Y != null ? d.Y : py; if (d.F != null) f = d.F;
            if (d.E > 0 && px != null) { const len = Math.hypot(nx - px, ny - py); if (ft === 'Overhang wall' && len > 20) out.push(f); else if (ft === 'Bridge' && len > 20) other.push(f); }
            px = nx; py = ny; });
          return { walls: out, bridges: [...new Set(other)], tune: r.tune }; };
        const tw = await wallsOf({ filament: 'cr-tpu', hangSpeed: 10 }), pw = await wallsOf({}), own = await wallsOf({ filament: 'cr-tpu' }), typed = await wallsOf({ filament: 'cr-tpu', hangSpeed: 20 });
        check('Hanging wall speed: 10 typed in prints the four walls over the gap at F600, the bridge lines still at F2358 (20: F1200); empty, CR-TPU and the profile\'s PLA keep them at the bridge\'s speed',
          tw.walls.length === 4 && tw.walls.every(f => f === 600) && tw.bridges.length === 1 && tw.bridges[0] === 2358.261 && pw.walls.length === 4 && pw.walls.every(f => f > 2300) && own.walls.length === 4 && own.walls.every(f => f > 2300) &&
            typed.walls.every(f => f === 1200) && PRINT.hangSpeedOf(tpl, { filament: 'profile', hangSpeed: null }) === null && PRINT.hangSpeedOf(tpl, { filament: 'cr-tpu', hangSpeed: null }) === null && PRINT.hangSpeedOf(tpl, { filament: 'cr-tpu', hangSpeed: 10 }) === 10,
          JSON.stringify({ tpu: tw, pla: pw, typed: typed.walls }));
        const zs = [...coldZ].sort((a, b) => a - b);
        check('...one change in and one out: 215 at the bridge layer\'s layer change, 235 two layers on - the bridge layer and the one over it print whole at 215, walls and fill too',
          ev.length === 2 && ev[0][0] === 215 && ev[1][0] === 235 && zs.length === 2 && Math.abs(zs[1] - zs[0] - 0.2) < 1e-6 && Math.abs(ev[1][1] - zs[1] - 0.2) < 1e-6 && Object.keys(hotFeat).length === 0 &&
            dr.stats.bridgeTemp.changes === 2 && dr.stats.bridgeTemp.layers === 1, JSON.stringify({ ev, zs, hot: Object.keys(hotFeat), bt: dr.stats.bridgeTemp }));
      }
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
  section('3e. A Studio project\'s own settings: the plate slices with what Studio sliced it with (the owner\'s TPU feet, fixtures/slicer-feet-reference.json)');
  // ===========================================================================
  {
    const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
    const base = PRINT.settingsFromConfig(tpl);
    /* the reader keeps a Studio project's settings and its objects' own overrides */
    const sr = await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'))), { name: 'supp_ref.3mf' });
    check('a Studio project read in keeps its project_settings.config: its process, and the keys it changed from the system preset',
      !!sr.projectSettings && sr.projectSettings.print_settings_id === '0.20mm Standard @BBL A1M' && /sparse_infill_density/.test(sr.projectSettings.different_settings_to_system[0]) && Array.isArray(sr.objectSettings),
      sr.projectSettings ? sr.projectSettings.print_settings_id + ' / ' + String(sr.projectSettings.different_settings_to_system[0]).slice(0, 80) : 'none');
    const ov = R3.parseModelSettingsOverrides('<config><object id="2"><metadata key="name" value="foot"/><metadata key="extruder" value="1"/><metadata key="wall_loops" value="0"/>' +
      '<part id="1"><metadata key="name" value="p"/><metadata key="matrix" value="1 0 0"/></part></object><object id="3"><metadata key="name" value="plain"/></object></config>');
    check('...and an object\'s own overrides (its Objects tab), not its name, extruder or parts', JSON.stringify(ov) === JSON.stringify([{ id: '2', name: 'foot', keys: { wall_loops: '0' } }]), JSON.stringify(ov));

    /* which project the plate is: every part one project's file */
    const FEET = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'slicer-feet-reference.json'), 'utf8')).noWalls;
    const projCfg = Object.assign({}, tpl, FEET.projectChanges, { print_settings_id: FEET.printSettingsId, filament_settings_id: ['Bambu TPU for AMS @BBL A1M'],
      different_settings_to_system: [Object.keys(FEET.projectChanges).concat(['print_settings_id', 'printer_settings_id']).join(';'), '', ''] });
    const G0 = globalThis, keep = { state: G0.state, nsoProjects: G0.nsoProjects };
    G0.nsoProjects = { 'feet.3mf': { config: projCfg, objects: [] } };
    G0.state = { models: [1, 2, 3, 4].map((i) => ({ id: i, sourceFile: 'feet.3mf' })).concat([{ id: 9, sourceFile: null, nsoSupport: {} }]), placed: [1, 2, 3, 4, 9].map((i) => ({ sourceId: i })) };
    let pj, mixed;
    try {
      pj = PRINT.plateProject();
      G0.state.models.push({ id: 5, sourceFile: 'other.stl' }); G0.state.placed.push({ sourceId: 5 });
      mixed = PRINT.plateProject();
    } finally { G0.state = keep.state; G0.nsoProjects = keep.nsoProjects; }
    check('a plate of one Studio project\'s parts (a support beside them aside) is that project: the 8 process settings the owner changed, no preset or printer key',
      !!pj && pj.file === 'feet.3mf' && JSON.stringify(pj.keys) === JSON.stringify(FEET.projectChanges) && pj.preset === FEET.printSettingsId && /TPU/.test(pj.filament),
      pj ? JSON.stringify(pj.keys) : 'none');
    check('...a part from another file on the plate: no project (the profile\'s)', mixed === null);

    /* the card with the project: rows at its values, the slice's config its changes, a row moved off one wins */
    const proj = { file: 'feet.3mf', keys: FEET.projectChanges };
    const rows = PRINT.settingsFromConfig(PRINT.withOverlay(tpl, FEET.projectChanges));
    check('the rows show the project\'s values: no walls, no top, no bottom, 3D honeycomb 10 %, Arachne',
      rows.walls === 0 && rows.topLayers === 0 && rows.botLayers === 0 && rows.pattern === '3dhoneycomb' && rows.density === 10 && rows.wallGen === 'arachne',
      JSON.stringify([rows.walls, rows.topLayers, rows.botLayers, rows.pattern, rows.density, rows.wallGen]));
    const want = {}; Object.keys(FEET.projectChanges).forEach((k) => { if (String(Array.isArray(tpl[k]) ? tpl[k][0] : tpl[k]).trim() !== FEET.projectChanges[k]) want[k] = FEET.projectChanges[k]; });
    const pov = PRINT.configOverlay(tpl, Object.assign({}, rows, { project: proj }));
    check('...and the slice\'s config is the project\'s changes, every one (rows without a row of their own too: skeleton / skin infill density), nothing else',
      JSON.stringify(Object.keys(pov).sort()) === JSON.stringify(Object.keys(want).sort()) && Object.keys(want).every((k) => pov[k] === want[k]) && Object.keys(want).length >= 7,
      JSON.stringify(pov));
    const off = PRINT.configOverlay(tpl, Object.assign({}, rows, { walls: 2, project: proj }));
    check('...a row moved off the project writes its own: Wall loops 2 over the project\'s 0', off.wall_loops === '2' && off.sparse_infill_pattern === '3dhoneycomb', JSON.stringify(off));
    check('...and without the project the same rows are the profile\'s plus what they change (no project key rides along)',
      !('skeleton_infill_density' in PRINT.configOverlay(tpl, Object.assign({}, rows, { project: null }))));

    /* one foot sliced through the card with the project: what Studio laid, line for line in kind and within 1.5 % in length */
    const bx = FEET.box, cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2, hw = (bx[2] - bx[0]) / 2;
    const footSoup = []; {
      const lo = [-hw, -hw, 0], hi = [hw, hw, 24];
      const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
      [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].forEach((t) => t.forEach((i) => footSoup.push(...v[i])));
    }
    /* the piece about the plate's centre, as the plate hands it over: shifted so it lands on the foot's own place on the bed */
    const fp = PRINT.pieceObjects([{ name: 'foot', soup: Float32Array.from(footSoup.map((q, i) => i % 3 === 0 ? q + cx - a1.bed.x / 2 : i % 3 === 1 ? q + cy - a1.bed.y / 2 : q)), sourceId: 1 }], a1.bed);
    const fr = await PRINT.build(fp, { config: tpl, printer: a1 }, { settings: Object.assign({}, rows, { project: proj, brim: 'none' }) });
    let fl = null;
    if (fr.ok) {
      const gc = L.text(await L.R.openZip(fr.bytes).read('Metadata/plate_1.gcode'));
      const mv = Lines.parseGcode(gc).moves.filter((m) => m.width > 0 && m.feature !== 'Custom');
      fl = { feats: [...new Set(mv.map((m) => m.feature))], mm: mv.reduce((t, m) => t + m.length, 0), cfg: /^; wall_loops = 0$/m.test(gc) && /^; skeleton_infill_density = 10%$/m.test(gc) };
    }
    const studio = FEET.sparseMm.reduce((x, y) => x + y, 0);
    check('a foot sliced with the project through the card: Sparse infill alone, the length of Studio\'s within 1.5 % (' + studio.toFixed(0) + ' mm), its config the project\'s',
      !!fl && JSON.stringify(fl.feats) === '["Sparse infill"]' && Math.abs(fl.mm / studio - 1) < 0.015 && fl.cfg,
      fl ? fl.feats.join(', ') + ' - ' + fl.mm.toFixed(0) + ' mm (' + ((fl.mm / studio - 1) * 100).toFixed(2) + ' %), config ' + fl.cfg : fr.reason);
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
    const p1sBt = await PRINT.build(PRINT.pieceObjects(asViewportPieces(plate.objs.slice(0, 1), a1.bed), p1sPrinter.bed), { config: p1sCfg, printer: p1sPrinter },
      { settings: Object.assign({}, PRINT.settingsFromConfig(p1sCfg), { filament: 'cr-tpu', bridgeTemp: 212 }) });
    check('a bridge temperature on the P1S is refused: its park and wipe moves are not written yet', !p1sBt.ok && /written for the A1 mini only so far/.test(p1sBt.reason), p1sBt.reason);
    check('...the card\'s CR-TPU on the P1S is the owner\'s own P1S preset (fixtures/print-planner/p1s-0.4/studio-owner-cr-tpu-squishy): 220 C, first layer too, bed 30, 3 mm^3/s', JSON.stringify(PRINT.filamentBase(p1sCfg, 'cr-tpu')) === JSON.stringify({ nozzleTemp: 220, firstTemp: 220, bedTemp: 30, maxFlow: 3, rangeLow: 200, rangeHigh: 250,
      flowRatio: 1, retractLen: 0.4, retractSpeed: 30, retractBefore: 0, zHop: 0, bridgeSpeed: 50, bridgeFlow: 1, hangSpeed: null, bridgeTemp: null, coolWait: 8, coolPillar: true, supTopZ: 0.2 }), JSON.stringify(PRINT.filamentBase(p1sCfg, 'cr-tpu')));
    const p1sOwn = await PRINT.build(PRINT.pieceObjects(asViewportPieces(plate.objs.slice(0, 1), a1.bed), p1sPrinter.bed), { config: p1sCfg, printer: p1sPrinter },
      { settings: Object.assign({}, PRINT.settingsFromConfig(p1sCfg), { filament: 'cr-tpu' }) });
    check('...and CR-TPU with every row empty slices for the P1S: the filament asks for no bridge temperature where the printer has no park (only a number typed in the row is refused)', p1sOwn.ok && p1sOwn.stats.bridgeTemp === null, p1sOwn.reason);
  }

  // ===========================================================================
  section('5a. The owner\'s own Studio filaments: CR-TPU on the P1S, ELEGOO PETG on both (docs/FILAMENTS.md "The owner\'s presets")');
  // ===========================================================================
  {
    /* Each slim fixture is the owner's own Studio 02.09.01.70 slice (2026-11-18), cut after its first layer: its start, its first layer,
       its end and its settings. NSO's filament on that printer's template must write what Studio wrote. */
    const CK = ['overhang_fan_threshold', 'overhang_fan_speed', 'fan_min_speed', 'fan_cooling_layer_time', 'fan_max_speed', 'slow_down_layer_time', 'slow_down_min_speed'];
    const CP = require(path.join(ROOT, 'nso-cooling-profiles.js'));
    for (const [label, rel, fid, cfgT, prn] of [
      ['CR-TPU on the P1S', 'fixtures/print-planner/p1s-0.4/studio-owner-cr-tpu-squishy.slim.gcode.3mf', 'cr-tpu', p1sCfg, p1sPrinter],
      ['ELEGOO PETG on the A1 mini', 'fixtures/print-planner/a1mini-0.4/studio-owner-elegoo-petg.slim.gcode.3mf', 'elegoo-petg', tpl, a1],
      ['ELEGOO PETG on the P1S (Generic PETG as it is: it printed better than the owner\'s ELEGOO-PETG preset)', 'fixtures/print-planner/p1s-0.4/studio-owner-generic-petg.slim.gcode.3mf', 'elegoo-petg', p1sCfg, p1sPrinter]]) {
      const st = await L.bambuSlice(rel), sc = st.config, one = k => Array.isArray(sc[k]) ? sc[k][0] : sc[k];
      const f = PRINT.FILAMENTS[fid], keys = PRINT.filamentKeys(cfgT, fid);
      /* NSO's own departures from the preset, each written down where the filament is: CR-TPU prints straight up (no wipe, no z hop) */
      const OWN = ({ 'cr-tpu': ['filament_wipe', 'filament_z_hop'], 'elegoo-petg': cfgT === p1sCfg ? ['filament_max_volumetric_speed'] : [] })[fid] || [];   /* PETG's P1S flow 18: the flow rings */
      const badK = Object.keys(keys).filter(k => k !== 'filament_settings_id' && OWN.indexOf(k) < 0 && String(one(k)) !== String(keys[k]));
      check(label + ': every Studio key NSO writes is the owner\'s preset\'s value (' + Object.keys(keys).length + ' keys), and the file names that preset (' + keys.filament_settings_id + ')',
        badK.length === 0 && keys.filament_settings_id === one('filament_settings_id'), JSON.stringify(badK.map(k => [k, keys[k], one(k)])));
      const cool = Object.assign({}, CP.resolveValues(CP.DEFAULT_PROFILE_ID), typeof f.cooling === 'function' ? f.cooling(cfgT) : f.cooling);
      const badC = CK.filter(k => String(cool[k]) !== String(one(k)));
      check('...its fans and layer-time slowdown are the preset\'s (' + CK.map(k => one(k)).join(', ') + ')', badC.length === 0, JSON.stringify(badC.map(k => [k, cool[k], one(k)])));
      const sl = st.gcode.split('\n'), noM73 = a => a.filter(l => !/^@?M73 /.test(l));
      const iE = sl.indexOf('; EXECUTABLE_BLOCK_START'), iM = sl.indexOf('; MACHINE_START_GCODE_END'), iL = sl.indexOf('; CHANGE_LAYER');
      const cfg = k => ((new RegExp('^; ' + k + ' = (.*)$', 'm').exec(st.gcode) || [])[1] || '').split(',')[0];
      const gm = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(sl.find(l => /^\s*G29 A1? ?X/.test(l)));
      const c = {};
      ['filament_type', 'filament_max_volumetric_speed', 'nozzle_temperature_range_high', 'filament_flush_temp', 'filament_flush_volumetric_speed', 'outer_wall_speed', 'outer_wall_line_width',
       'layer_height', 'nozzle_temperature', 'nozzle_temperature_initial_layer', 'textured_plate_temp', 'textured_plate_temp_initial_layer', 'curr_bed_type'].forEach(k => { c[k] = cfg(k); });
      const S = PL.settingsFrom(c);
      const v = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, bedMax: Math.max(S.temp.bed, S.temp.bedInitial), box: { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] }, cy: 0, maxZ: 0,
        filamentType: S.filament.type, flushV: S.filament.flushVolumetric, flushT: S.filament.flushTemp, ow: S.filament.outerWallVolumetric };
      const want = noM73(sl.slice(iE + 2, iM + 1)), got = noM73(PL.thaw(prn.start, v, {}));
      const off = want.findIndex((l, i) => l !== got[i]);
      check('...NSO\'s start block with that slice\'s numbers is Studio\'s, all ' + want.length + ' lines (' + S.filament.type + ', ' + S.filament.maxVolumetric + ' mm^3/s, ' + S.temp.nozzle + ' C, bed ' + S.temp.bedInitial + '/' + S.temp.bed + ')',
        want.length === got.length && off < 0, off >= 0 ? 'line ' + off + ': ' + JSON.stringify([want[off], got[off]]) : want.length + ' / ' + got.length);
      const vt = prn.afterStart.findIndex(l => typeof l === 'string' && /^;VT\d/.test(l));
      /* (a plate of several objects: Studio's list of the objects still to print comes first - checked below, 5a's last checks) */
      const wantAfter = noM73(sl.slice(iM + 1, iL)).filter(l => !/^; remaining object ids:|^M639 /.test(l)), gotAfter = noM73(PL.thaw(f.start(Math.max(S.temp.bed, S.temp.bedInitial), cfgT).concat(prn.afterStart.slice(vt)), v, {}));
      check('...and so is the filament\'s own start G-code after it', JSON.stringify(wantAfter) === JSON.stringify(gotAfter), JSON.stringify([wantAfter, gotAfter]));
      const fb = PRINT.filamentBase(cfgT, fid);
      check('...the card\'s rows start at the preset: ' + fb.nozzleTemp + ' C (first layer ' + fb.firstTemp + '), bed ' + fb.bedTemp + ', ' + fb.maxFlow + ' mm^3/s, flow ratio ' + fb.flowRatio,
        fb.nozzleTemp === +one('nozzle_temperature') && fb.firstTemp === +one('nozzle_temperature_initial_layer') && fb.bedTemp === +one('textured_plate_temp_initial_layer') &&
          fb.maxFlow === (OWN.indexOf('filament_max_volumetric_speed') >= 0 ? +keys.filament_max_volumetric_speed : +one('filament_max_volumetric_speed')) && fb.flowRatio === +one('filament_flow_ratio'), JSON.stringify(fb));
      const out = await PRINT.build(PRINT.pieceObjects(asViewportPieces(plate.objs.slice(0, 1), a1.bed), prn.bed), { config: cfgT, printer: prn },
        { settings: Object.assign({}, PRINT.settingsFromConfig(cfgT), { filament: fid }) });
      const g = out.ok ? L.text(await L.R.openZip(out.bytes).read('Metadata/plate_1.gcode')) : '';
      const gc = k => ((new RegExp('^; ' + k + ' = (.*)$', 'm').exec(g) || [])[1] || '').split(/[,;]/)[0];
      check('...and the plate slices with it: the file says ' + gc('filament_type') + ', ' + gc('filament_settings_id') + ', ' + gc('nozzle_temperature') + ' C',
        out.ok && gc('filament_type') === one('filament_type') && gc('filament_settings_id').replace(/"/g, '') === one('filament_settings_id') && gc('nozzle_temperature') === one('nozzle_temperature') &&
          gc('textured_plate_temp') === one('textured_plate_temp') && g.indexOf('; filament start gcode\n' + f.start(Math.max(S.temp.bed, S.temp.bedInitial), cfgT).slice(1).join('\n')) >= 0, out.reason);
    }
  }

  {
    /* THE OBJECTS STILL TO PRINT (M639): Studio 02.09.01.70 on the P1S, the owner's eight-part desk hanger (2026-11-20, its first lines
       in fixtures/print-planner/p1s-0.4/studio-owner-generic-petg.slim.gcode.3mf): after the start block, the objects still to print as
       M624's mask; again at the layer change where some have printed their last layer; empty after the last. */
    const st = await L.bambuSlice('fixtures/print-planner/p1s-0.4/studio-owner-generic-petg.slim.gcode.3mf');
    const sl = st.gcode.split('\n'), iM = sl.indexOf('; MACHINE_START_GCODE_END');
    const firstLayer = sl.find(l => /^M624 /.test(l));
    check('Studio\'s slice of a plate of several objects: "; remaining object ids: <the ids>" and M639 with the mask its first layer\'s M624 has, right after the start block',
      /^; remaining object ids: 5152,5207,5259,5293$/.test(sl[iM + 1]) && sl[iM + 2] === 'M639 DwAAAAAAAAA=' && firstLayer === 'M624 DwAAAAAAAAA=', JSON.stringify(sl.slice(iM, iM + 3)));
    /* NSO: two pieces of different heights on the P1S */
    const vp = asViewportPieces(plate.objs.slice(0, 1), a1.bed)[0].soup;     /* the coupon, centred on the bed's middle */
    let zMin = Infinity, zMax = -Infinity, xMin = Infinity, xMax = -Infinity;
    for (let i = 0; i < vp.length; i += 3) { xMin = Math.min(xMin, vp[i]); xMax = Math.max(xMax, vp[i]); zMin = Math.min(zMin, vp[i + 2]); zMax = Math.max(zMax, vp[i + 2]); }
    const shift = (xMax - xMin) / 2 + 3, tallSoup = Float32Array.from(vp), lowSoup = Float32Array.from(vp);
    for (let i = 0; i < vp.length; i += 3) { tallSoup[i] -= shift; lowSoup[i] += shift; lowSoup[i + 2] = zMin + (vp[i + 2] - zMin) * 0.5; }   /* side by side; the right one half as tall */
    const two = PRINT.pieceObjects([{ name: 'tall', soup: tallSoup }, { name: 'low', soup: lowSoup }], p1sPrinter.bed);
    const rb = await PRINT.build(two, { config: p1sCfg, printer: p1sPrinter }, { settings: Object.assign({}, PRINT.settingsFromConfig(p1sCfg)) });
    const g = rb.ok ? L.text(await L.R.openZip(rb.bytes).read('Metadata/plate_1.gcode')).split('\n') : [];
    const at = g.map((l, i) => /^; remaining object ids:/.test(l) ? i : -1).filter(i => i >= 0);
    const zOf = i => { for (let j = i; j >= 0; j--) if (/^; Z_HEIGHT: /.test(g[j])) return +g[j].slice(11); return 0; };
    const ids = rb.ok ? (/^; remaining object ids: (.*)$/.exec(g[at[0]]) || [])[1].split(',') : [];
    check('NSO, two pieces on the P1S, one half as tall: the list after the start block (both), at the layer change after the low one\'s last layer (the tall one, its M625 just before), and empty after the last; each with its mask',
      rb.ok && at.length === 3 && g[at[0] - 1] === '; MACHINE_START_GCODE_END' && g[at[0] + 1] === 'M639 AwAAAAAAAAA=' && ids.length === 2 &&
        g[at[1]] === '; remaining object ids: ' + ids[0] && g[at[1] + 1] === 'M639 AQAAAAAAAAA=' && g[at[1] - 1] === 'M625' && /^; layer num\//.test(g[at[1] + 2]) &&
        Math.abs(zOf(at[1]) - (zMax - zMin) * 0.5) < 0.6 &&
        g[at[2]] === '; remaining object ids: ' && g[at[2] + 1] === 'M639 AAAAAAAAAAA=' && g.indexOf('; MACHINE_END_GCODE_START') > at[2],
      JSON.stringify([rb.reason, at.map(i => [zOf(i), g[i - 1], g[i], g[i + 1]])]));
    const ra = await PRINT.build(PRINT.pieceObjects([{ name: 'tall', soup: tallSoup }, { name: 'low', soup: lowSoup }], a1.bed), { config: tpl, printer: a1 }, { settings: Object.assign({}, PRINT.settingsFromConfig(tpl)) });
    const ga = ra.ok ? L.text(await L.R.openZip(ra.bytes).read('Metadata/plate_1.gcode')) : '';
    check('...not on the A1 mini: no Studio slice of it has shown the list yet', ra.ok && !/M639|remaining object ids/.test(ga), ra.reason);
  }

  // ===========================================================================
  section('5c. Multi-colour: the owner\'s 3-colour pyramid on the P1S with the AMS, against Studio\'s slice of it (docs/MULTICOLOR.md)');
  // ===========================================================================
  {
    const R3 = require(path.join(ROOT, 'nso-3mf-read.js')), PP = require(path.join(ROOT, 'nso_paint.js'));
    const file = 'Test_Pyramid_3_Colors_P1S_AMS.3mf';
    const st = await L.bambuSlice('fixtures/multicolor/pyramid-3colors-notower.slim.gcode.3mf');      /* Studio's, prime tower off: its moves dropped */
    const rd = await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures/multicolor/pyramid-3colors.3mf'))), { name: file });
    const o = rd.objects[0], soup = Float32Array.from(o.positions);
    for (let i = 0; i < soup.length; i += 3) { soup[i] -= p1sPrinter.bed.x / 2; soup[i + 1] -= p1sPrinter.bed.y / 2; }   /* where Studio has it */
    const pieces = [{ name: 'Test Pyramid.stl', file, soup, sourceId: 1, paint: PP.make(o.paint.codes, o.paint.flip, o.paint.ext, o.paint.colours) }];
    const was = global.nsoProjects;
    global.nsoProjects = { [file]: { config: st.config, objects: [] } };
    const assets = PRINT.withProjectFilaments({ config: p1sCfg, printer: p1sPrinter }, pieces);
    check('the painted pyramid slices with its project\'s three filaments over the P1S template: colours, types, the purge table',
      !assets.error && JSON.stringify(assets.config.filament_colour) === JSON.stringify(['#8E9089', '#FFFFFF', '#000000']) &&
        assets.config.flush_volumes_matrix.join(',') === '0,381,123,123,0,143,439,623,0' && p1sCfg.filament_colour.length === 1, JSON.stringify(assets.error || assets.config.filament_colour));
    const objsMC = PRINT.pieceObjects(pieces, p1sPrinter.bed);
    const r = await PRINT.build(objsMC, assets, { settings: PRINT.settingsFromConfig(p1sCfg) });
    check('...and slices', r.ok, r.reason);
    if (r.ok) {
      const z = L.R.openZip(r.bytes), g = L.text(await z.read('Metadata/plate_1.gcode')), gl = g.split('\n'), sl = st.gcode.split('\n');
      const changesOf = lines => { const out = []; let zz = null; lines.forEach(l => { const m = /^; Z_HEIGHT: (.*)$/.exec(l); if (m) zz = +m[1]; const c = /^M620 S(\d)A$/.exec(l); if (c) out.push(zz + ':' + c[1]); }); return out.join(' '); };
      check('three changes where Studio\'s are: black (slot 3) at 8.6, white (2) at 15.4, grey (1) at 21.6', changesOf(gl) === '8.6:2 15.4:1 21.6:0' && changesOf(sl) === changesOf(gl), changesOf(gl));
      /* each change, from the timelapse before it to the object after it, line for line */
      const regions = lines => {
        const out = [];
        lines.forEach((l, i) => {
          if (!/^M620 S\dA$/.test(l)) return;
          let a = i; while (a > i - 60 && !lines[a].startsWith('; SKIPPABLE_END')) a--;
          let b = i; while (b < i + 400 && !lines[b].startsWith('; OBJECT_ID')) b++;
          out.push(lines.slice(a, b).filter(x => !/^M73 [PR]/.test(x)));
        });
        return out;
      };
      const A = regions(sl), B = regions(gl);
      const offs = A.map((x, k) => { const y = B[k] || []; const at = x.findIndex((l, j) => l !== y[j] && !(/^M106 S/.test(l) && /^M106 S/.test(y[j]))); return at < 0 && x.length === y.length ? -1 : at; });
      check('...each written as Studio wrote it, line for line (' + A.map(x => x.length).join(', ') + ' lines): the retraction to 2 mm, the filament end, the P1S change block with its purge (51 mm, then 4 x 65 mm for black to white), the travel path on the second, the fans, the nozzle, the filament start (the part fan\'s value is the layer\'s)',
        A.length === 3 && offs.every(x => x === -1), JSON.stringify(offs.map((at, k) => at < 0 ? null : [A[k][at], (B[k] || [])[at]])));
      const head = k => ((new RegExp('^; ' + k + ': ?(.*)$', 'm').exec(g) || [])[1] || '');
      check('the header lists each filament: "filament: 1,2,3", a length, volume and weight each', head('filament') === '1,2,3' && head('total filament length \\[mm\\] ').split(',').length === 3 &&
        head('filament_density') === '1.26,1.26,1.26', JSON.stringify([head('filament'), head('total filament length \\[mm\\] ')]));
      const si = L.text(await z.read('Metadata/slice_info.config'));
      const fil = [...si.matchAll(/<filament id="(\d)" tray_info_idx="([^"]*)" type="([^"]*)" color="([^"]*)"[^>]*total_load_time="([\d.]+)" total_unload_time="([\d.]+)"/g)].map(m => m.slice(1).join(' '));
      check('...and the plate info: three filaments, their trays, colours and load / unload times as Studio\'s', JSON.stringify(fil) === JSON.stringify(['1 GFA00 PLA #8E9089 58.00 28.00', '2 GFA00 PLA #FFFFFF 29.00 28.00', '3 GFA00 PLA #000000 29.00 28.00']), JSON.stringify(fil));
      const lfl = t => [...t.matchAll(/<layer_filament_list filament_list="([^"]*)" layer_ranges="([^"]*)"/g)].map(m => m[1] + ':' + m[2]).filter(x => !/^:/.test(x)).sort().join(' | ');
      check('...its layer filament lists are Studio\'s: grey 0-41 and 107-147, black 42-75, white 76-106', lfl(si) === lfl(L.text(await L.R.openZip(fs.readFileSync(path.join(ROOT, 'fixtures/multicolor/pyramid-3colors-notower.slim.gcode.3mf'))).read('Metadata/slice_info.config'))), lfl(si));
      const ps = JSON.parse(L.text(await z.read('Metadata/project_settings.config')));
      check('...and its project settings carry the three filaments (colours, presets, each filament\'s changes)', ps.filament_colour.length === 3 && ps.filament_settings_id.length === 3 && ps.different_settings_to_system.length === 5,
        JSON.stringify([ps.filament_colour, ps.different_settings_to_system.length]));
      const cfgLine = k => ((new RegExp('^; ' + k + ' = (.*)$', 'm').exec(g) || [])[1]);
      check('...and its CONFIG_BLOCK too, as Studio writes them (filament_colour, filament_type, the purge table, nozzle_temperature once a filament)',
        ['filament_colour', 'filament_type', 'flush_volumes_matrix', 'nozzle_temperature', 'filament_ids', 'filament_map'].every(k => cfgLine(k) === (new RegExp('^; ' + k + ' = (.*)$', 'm').exec(st.gcode) || [])[1]),
        JSON.stringify(['filament_colour', 'nozzle_temperature'].map(cfgLine)));
      /* the change layers print at the layer's own speed: their change counts towards the layer's time, as Studio's cooling counts it */
      const wallF = zz => { const i = gl.indexOf('; Z_HEIGHT: ' + zz); const j = gl.indexOf('; FEATURE: Inner wall', i); return +((/^G1 F([\d.]+)/.exec(gl.slice(j, j + 4).find(l => /^G1 F/.test(l)) || '') || [])[1]); };
      check('a change layer\'s walls are not slowed for the layer\'s time (8.6: F' + wallF('8.6') + ', the layer under it F' + wallF('8.4') + ')', wallF('8.6') > 2 * wallF('8.4'));
    }
    const bad = PRINT.withProjectFilaments({ config: p1sCfg, printer: p1sPrinter }, [{ name: 'x', file: 'not-open.3mf', soup, paint: pieces[0].paint }]);
    check('a piece painted in three filaments whose project is not open is refused in words', !!bad.error && /not open/.test(bad.error), bad.error);

    // -------------------------------------------------------------------------
    // 5d. The prime tower: the same pyramid with the project's tower on, against Studio's slice of it (its tower's moves kept)
    // -------------------------------------------------------------------------
    const stT = await L.bambuSlice('fixtures/multicolor/pyramid-3colors-tower.slim.gcode.3mf');
    global.nsoProjects = { [file]: { config: stT.config, objects: [] } };
    const assetsT = PRINT.withProjectFilaments({ config: p1sCfg, printer: p1sPrinter }, pieces);
    check('5d. with the project\'s prime tower on, its tower settings come with its filaments (10 mm wide at 59.78, 211; rib walls off)',
      !assetsT.error && assetsT.config.enable_prime_tower === '1' && assetsT.config.prime_tower_width === '10' && assetsT.config.prime_tower_rib_wall === '0' &&
        String(assetsT.config.wipe_tower_x) === '59.7781' && p1sCfg.prime_tower_width === '35', JSON.stringify([assetsT.error, assetsT.config.prime_tower_width, assetsT.config.wipe_tower_x]));
    const rT = await PRINT.build(PRINT.pieceObjects(pieces, p1sPrinter.bed), assetsT, { settings: PRINT.settingsFromConfig(p1sCfg) });
    check('...and slices', rT.ok, rT.reason);
    if (rT.ok) {
      const gT = L.text(await L.R.openZip(rT.bytes).read('Metadata/plate_1.gcode'));
      const byLayer = t => { const out = {}; let zz = null; t.split('\n').forEach(l => { const m = /^; Z_HEIGHT: (.*)$/.exec(l); if (m) { zz = m[1]; out[zz] = []; } else if (zz != null && !/^M73 [PR]/.test(l)) out[zz].push(l); }); return out; };
      /* a layer's tower: from the end of its timelapse to its object, less the lines that are NSO's own - the spiral's radius, the object's
         id, the part fan, the wipe's speed (the speed of the last path before it, NSO's), the first layer's speed (the template's 40 mm/s,
         Studio's project 50) */
      const towerOf = (ls, zz) => {
        let a = -1; ls.forEach((l, i) => { if (l.startsWith('; SKIPPABLE_END')) a = i; });
        let b = ls.findIndex((l, i) => i > a && l.startsWith('; OBJECT_ID'));
        return ls.slice(a + 1, b < 0 ? ls.length : b).filter(l => !/^(G3 |; OBJECT_ID|M106 S|G1 F[\d.]+$|G1 X[\d.]+ Y[\d.]+ E)/.test(l))     /* (the fixture's object moves, and the wipe's, are dropped) */
          .map(l => zz === '0.2' ? l.replace(/ F(2400|3000)$/, ' F<first>') : l);
      };
      const A = byLayer(stT.gcode), B = byLayer(gT);
      const towerLayers = o => Object.keys(o).filter(zz => o[zz].includes('; FEATURE: Prime tower'));
      check('the tower stands on the layers Studio\'s does: 108, from the first to the last change (21.6)',
        towerLayers(A).join(' ') === towerLayers(B).join(' ') && towerLayers(B).length === 108 && towerLayers(B).pop() === '21.6', towerLayers(B).length + ' ' + towerLayers(B).slice(-2));
      const diffs = towerLayers(A).map(zz => {
        const x = towerOf(A[zz], zz), y = towerOf(B[zz] || [], zz), at = x.findIndex((l, j) => l !== y[j]);
        return at < 0 && x.length === y.length ? null : [zz, at, x[at], y[at]];
      }).filter(Boolean);
      const lens = ['0.2', '0.4', '8.6', '8.8', '15.4', '21.6'].map(zz => towerOf(A[zz], zz).length);
      check('...every one of them written as Studio wrote it, line for line (' + lens.join(', ') + ' lines on 0.2, 0.4, 8.6, 8.8, 15.4, 21.6): the rectangle, ' +
        'the grid (solid on the first layer), the wall, the brim and the chamfer; on a change the wall with its gap, the change, the way round the tower, ' +
        'the purge line by line with its ironing and its speeds, the wall after it when the new filament is the wall\'s; the wipe and the slow lift',
        diffs.length === 0, JSON.stringify(diffs.slice(0, 3)));
      const zT = L.R.openZip(rT.bytes), pj = JSON.parse(L.text(await zT.read('Metadata/plate_1.json')));
      const sj = JSON.parse(L.text(stT.parts['Metadata/plate_1.json'] || new Uint8Array(0)) || 'null');
      const wt = pj.bbox_objects.find(o => o.name === 'wipe_tower'), swt = sj && sj.bbox_objects.find(o => o.name === 'wipe_tower');
      check('the plate info lists the tower as Studio\'s does (wipe_tower, id 1000, its box with the brim: ' + (wt ? wt.bbox.map(v => v.toFixed(3)).join(', ') : '-') + '), the object\'s footprint in plate coordinates',
        !!wt && wt.id === 1000 && (!swt || wt.bbox.every((v, k) => Math.abs(v - swt.bbox[k]) < 0.001)) && Math.abs(pj.bbox_objects[0].bbox[1] - 111.531) < 0.01, JSON.stringify([wt, swt && swt.bbox]));
      const siT = L.text(await zT.read('Metadata/slice_info.config'));
      const lflT = t => [...t.matchAll(/<layer_filament_list filament_list="([^"]*)" layer_ranges="([^"]*)"/g)].map(m => m[1] + ':' + m[2]).filter(x => !/^:/.test(x)).sort().join(' | ');
      check('...and each layer\'s filaments are the object\'s, as Studio\'s: the tower\'s wall in the old filament does not count', lflT(siT) === lflT(L.text(stT.parts['Metadata/slice_info.config'])), lflT(siT));
      const g29 = (/^\s*G29 A X([\d.]+)/m.exec(gT) || [])[1];
      check('the bed-mesh box takes in the tower\'s brim, as Studio\'s: G29 from X' + g29, g29 === '56.5786');
      const headT = k => ((new RegExp('^; ' + k + ': ?(.*)$', 'm').exec(gT) || [])[1] || '').split(',').map(Number);
      const plain = headT('total filament length \\[mm\\] '), stud = ((new RegExp('^; total filament length \\[mm\\] : ?(.*)$', 'm').exec(stT.gcode) || [])[1] || '').split(',').map(Number);
      check('each slot\'s length counts its tower (' + plain.join(', ') + ' mm; Studio\'s ' + stud.join(', ') + ')', plain.length === 3 && plain.every((v, k) => Math.abs(v - stud[k]) < 40), JSON.stringify([plain, stud]));
    }
    const ribbed = Object.assign({}, assetsT, { config: Object.assign({}, assetsT.config, { prime_tower_rib_wall: '1' }) });
    const rR = await PRINT.build(PRINT.pieceObjects(pieces, p1sPrinter.bed), ribbed, { settings: PRINT.settingsFromConfig(p1sCfg) });
    check('...a project whose tower has rib walls is refused in words (NSO writes the plain tower so far)', !rR.ok && /rib wall/i.test(rR.reason), rR.reason);
    const moved = Object.assign({}, assetsT, { config: Object.assign({}, assetsT.config, { wipe_tower_x: ['130'], wipe_tower_y: ['110'] }) });
    const rM = await PRINT.build(PRINT.pieceObjects(pieces, p1sPrinter.bed), moved, { settings: PRINT.settingsFromConfig(p1sCfg) });
    const gM = rM.ok ? L.text(await L.R.openZip(rM.bytes).read('Metadata/plate_1.gcode')) : '';
    const towerXs = gM.split('\n').filter(l => /^G1  X/.test(l)).map(l => +/X([\d.]+)/.exec(l)[1]), tb = rM.ok && rM.stats.tower ? rM.stats.tower.box : null;
    check('...a tower spot the pieces cover is not used: the tower goes to the clear spot nearest it (its box with the brim ' + (tb ? tb.map(v => v.toFixed(1)).join(', ') : '-') + ', the pyramid 125.8-155.7 x 111.5-141.4)',
      rM.ok && towerXs.length > 100 && rM.stats.tower.moved && (tb[2] < 125.7 || tb[0] > 155.8 || tb[3] < 111.4 || tb[1] > 141.5) && Math.hypot(tb[0] - 130, tb[1] - 110) < 40, rM.reason);
    global.nsoProjects = was;
  }

  // ===========================================================================
  section('5e. Colours on one layer: the owner\'s Gulf logo (painted, three filaments on a layer, a tower), against Studio\'s slice of it');
  // ===========================================================================
  {
    const R3 = require(path.join(ROOT, 'nso-3mf-read.js')), PP = require(path.join(ROOT, 'nso_paint.js'));
    const file = 'Gulf_Logo.3mf';
    const st = await L.bambuSlice('fixtures/multicolor/gulf-logo.slim.gcode.3mf');      /* Studio's: its object moves dropped, its tower's kept */
    const rd = await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures/multicolor/gulf-logo.3mf'))), { name: file });
    const o = rd.objects[0], soup = Float32Array.from(o.positions);
    /* where Studio has it: its first layer's box, 52.48 - 209.50 x 53.15 - 195.80 */
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < soup.length; i += 3) { x0 = Math.min(x0, soup[i]); x1 = Math.max(x1, soup[i]); y0 = Math.min(y0, soup[i + 1]); y1 = Math.max(y1, soup[i + 1]); }
    for (let i = 0; i < soup.length; i += 3) { soup[i] += (52.48265 + 209.49997) / 2 - (x0 + x1) / 2 - p1sPrinter.bed.x / 2; soup[i + 1] += (53.15256 + 195.80158) / 2 - (y0 + y1) / 2 - p1sPrinter.bed.y / 2; }
    const pieces = [{ name: 'Gulf Logo.stl', file, soup, sourceId: 1, paint: PP.make(o.paint.codes, o.paint.flip, o.paint.ext, o.paint.colours) }];
    const was = global.nsoProjects;
    global.nsoProjects = { [file]: { config: st.config, objects: [] } };
    const assets = PRINT.withProjectFilaments({ config: p1sCfg, printer: p1sPrinter }, pieces);
    const r = await PRINT.build(PRINT.pieceObjects(pieces, p1sPrinter.bed), assets, { settings: PRINT.settingsFromConfig(p1sCfg) });
    check('the painted logo slices, its layers split by colour (it was refused before: three colours on a layer)', r.ok, r.reason);
    if (r.ok) {
      const g = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode'));
      /* each layer: its colours in order, where the tower comes, where each change goes */
      const plan = t => {
        const out = []; let cur = null, row = null;
        t.split('\n').forEach(l => {
          let m = /^M620 S(\d+)A/.exec(l); if (m && cur == null) cur = +m[1];
          if (/^; Z_HEIGHT: /.test(l)) { row = [l.slice(12)]; out.push(row); return; }
          if (!row) return;
          m = /^T(\d+)$/.exec(l); if (m && +m[1] < 255) { cur = +m[1]; row.push('>' + cur); return; }
          const tag = /^; FEATURE: Prime tower/.test(l) ? 'tower' : /^; FEATURE: /.test(l) ? String(cur) : null;
          if (tag && row[row.length - 1] !== tag) row.push(tag);
        });
        return out.map(rw => rw.join(' ')).join(' | ');
      };
      check('each layer prints its colours in Studio\'s order, at the tower where Studio\'s changes are (white; white grey black; black grey white; ' +
        'white grey black; black white grey; black grey; grey) - the order that purges least over the layer and the next', plan(g) === plan(st.gcode), plan(g));
      const head = k => ((new RegExp('^; ' + k + ': ?(.*)$', 'm').exec(g) || [])[1] || '');
      check('ten changes, the tower 35 x 15.5 mm (two purges a layer), and each change marked with how many are still to come (M73 E9 ... E0)',
        r.stats.changes === 10 && r.stats.tower && Math.abs(r.stats.tower.depth - 15.5) < 1e-3 &&
          (g.match(/^M73 E\d+$/mg) || []).join(' ') === 'M73 E9 M73 E8 M73 E7 M73 E6 M73 E5 M73 E4 M73 E3 M73 E2 M73 E1 M73 E0', JSON.stringify([r.stats.changes, r.stats.tower]));
      /* no walled crumbs: where a letter's top skin met the side split, slivers of 0.2 - 3 mm2 each got walls of their own (stops and dashes on the print) */
      const crumbs = (() => {
        const out = []; let z = '', box = null, x = 0, y = 0;
        const close = () => { if (box && box[2] - box[0] < 2.5 && box[3] - box[1] < 2.5) out.push(z); box = null; };
        g.split('\n').forEach(l => {
          if (/^; Z_HEIGHT: /.test(l)) { close(); z = l.slice(12); return; }
          if (/^; FEATURE: /.test(l)) { close(); if (/Outer wall/.test(l)) box = [Infinity, Infinity, -Infinity, -Infinity]; return; }
          const m = /^G1 .*?(?:X(-?[\d.]+))?\s*(?:Y(-?[\d.]+))?\s*E[\d.]/.exec(l);
          if (/^G[01] /.test(l)) { const mx = / X(-?[\d.]+)/.exec(l), my = / Y(-?[\d.]+)/.exec(l); if (mx) x = +mx[1]; if (my) y = +my[1]; }
          if (m && box && / E[\d.]/.test(l) && !/ E-/.test(l)) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
        });
        close(); return out;
      })();
      /* no fill over the G's open counter above the base (0.8 up): an 18 mm sparse connector jumped it, its midpoint inside the letter, and stayed bare on top */
      const overCounter = (() => {
        let z = 0, f = '', x = 0, y = 0; const hit = [];
        g.split('\n').forEach(l => {
          if (/^; Z_HEIGHT: /.test(l)) { z = +l.slice(12); return; }
          if (/^; FEATURE: /.test(l)) { f = l.slice(11); return; }
          if (!/^G1 /.test(l)) return;
          const mx = / X(-?[\d.]+)/.exec(l), my = / Y(-?[\d.]+)/.exec(l), nx = mx ? +mx[1] : x, ny = my ? +my[1] : y;
          if (z >= 0.8 && /infill/i.test(f) && / E[\d.]/.test(l)) {
            const dx = nx - x, dy = ny - y, L2 = dx * dx + dy * dy, u = L2 ? Math.max(0, Math.min(1, ((81.5 - x) * dx + (116.5 - y) * dy) / L2)) : 0;
            if (Math.hypot(x + u * dx - 81.5, y + u * dy - 116.5) < 1) hit.push(z + ' ' + f);
          }
          x = nx; y = ny;
        });
        return hit;
      })();
      check('no infill crosses the G\'s open counter above the base: a connector that would cut across the fill\'s outline is a travel', overCounter.length === 0, overCounter.join('; '));
      /* seams: no loop and no gap ring begins on the smooth right side of the rim (it did half way down it: a break with a grey fleck in the white, the
         owner's half-size print) */
      const seamCheck = (() => {
        let z = 0, f = '', x = 0, y = 0, prevE = false; const bad = [];
        g.split('\n').forEach(l => {
          if (/^; Z_HEIGHT: /.test(l)) { z = +l.slice(12); return; }
          if (/^; FEATURE: /.test(l)) { f = l.slice(11); return; }
          if (!/^G1 /.test(l)) return;
          const mx = / X(-?[\d.]+)/.exec(l), my = / Y(-?[\d.]+)/.exec(l), nx = mx ? +mx[1] : x, ny = my ? +my[1] : y;
          const ext = (mx || my) && / E[\d.]/.test(l);
          if (ext && !prevE && /wall|Gap infill/.test(f) && nx > 206 && ny > 112 && ny < 135) bad.push(f + ' starts ' + z + ' ' + nx + ',' + ny);
          prevE = !!ext; x = nx; y = ny;
        });
        return bad;
      })();
      check('seams: nothing begins on the rim\'s smooth right side (loops and gap rings start at a corner, in line)', seamCheck.length === 0, seamCheck.slice(0, 5).join('; '));
      /* every stop on a top face is a mark (retract, wipe, lift, prime): each piece of the top is filled on its own from an end, and a concave one goes
         run to run inside itself without a stop - 14 stops on the top layer where the layer's top filled as one lot stopped 40 (Studio's: 28) */
      const topStops = (() => { let z = '', f = '', n = 0; g.split('\n').forEach(l => { if (/^; Z_HEIGHT: /.test(l)) z = l.slice(12); else if (/^; FEATURE: /.test(l)) f = l.slice(11); else if (z === '1.8' && f === 'Top surface' && /^; WIPE_START/.test(l)) n++; }); return n; })();
      /* (the top in monotonic lines, Studio's: its stops are Studio's kind - 43 on the top surface and 33 in its gap fill where Studio's are 28 and 74) */
      const gapStops = (() => { let z = '', f = '', n = 0; g.split('\n').forEach(l => { if (/^; Z_HEIGHT: /.test(l)) z = l.slice(12); else if (/^; FEATURE: /.test(l)) f = l.slice(11); else if (z === '1.8' && f === 'Gap infill' && /^; WIPE_START/.test(l)) n++; }); return n; })();
      check('the top layer, in Studio\'s monotonic lines, stops no more than Studio\'s does (its top and its gap fill: 102): a line steps to the next, the gaps woven in', topStops + gapStops <= 102 && topStops <= 50, topStops + ' + ' + gapStops);
      const topLen = (() => { let z = '', f = '', x = 0, y = 0, n = 0; g.split('\n').forEach(l => { if (/^; Z_HEIGHT: /.test(l)) { z = l.slice(12); return; } if (/^; FEATURE: /.test(l)) { f = l.slice(11); return; } if (!/^G1 /.test(l)) return;
        const mx = / X(-?[\d.]+)/.exec(l), my = / Y(-?[\d.]+)/.exec(l), nx = mx ? +mx[1] : x, ny = my ? +my[1] : y; if (z === '1.8' && f === 'Top surface' && / E[\d.]/.test(l)) n += Math.hypot(nx - x, ny - y); x = nx; y = ny; }); return n; })();
      check('...and lays what Studio\'s does: the top layer\'s top surface 8366 mm in Studio\'s slice, NSO\'s within 1 %', Math.abs(topLen - 8366) < 84, topLen.toFixed(0));
      check('no walled crumbs: no outer wall smaller than 2.5 mm across on any layer (the colour split hands its slivers to the region beside them)', crumbs.length === 0, crumbs.join(' '));
      /* the tower's part of each layer, line for line: the numbers to 0.0011 (the way round the tower: 194.022 where Studio has 194.023);
         not the object's own wipes (NSO's paths), the spiral, the fans, the first layer's speed */
      const byLayer = t => { const out = {}; let zz = null; t.split('\n').forEach(l => { const m = /^; Z_HEIGHT: (.*)$/.exec(l); if (m) { zz = m[1]; out[zz] = []; } else if (zz != null && !/^M73 [PR]/.test(l)) out[zz].push(l); }); return out; };
      const towerOf = (ls, zz) => {
        const out = []; let on = false;
        ls.forEach(l => {
          if (l.startsWith('; LAYER_HEIGHT: 0.200000')) on = true;
          if (l.startsWith('; OBJECT_ID')) on = false;
          if (on && !/^(G3 |M106 S|G1 F[\d.]+$|G1 X[\d.]+ Y[\d.]+ E-|G1 X[\d.]+ Y[\d.]+ E[\d.])/.test(l) && !/^G1 E-\.\d+ F1800$/.test(l) && !/^M204 S10000$/.test(l))
            out.push(zz === '0.2' ? l.replace(/ F(2400|3000)$/, ' F<first>') : l);
        });
        return out;
      };
      const same = (a, b) => {
        if (a === b) return true;
        const na = a.split(/(-?\d*\.?\d+)/), nb = b.split(/(-?\d*\.?\d+)/);
        return na.length === nb.length && na.every((x, i) => i % 2 ? Math.abs(+x - +nb[i]) <= 0.0011 : x === nb[i]);
      };
      const A = byLayer(st.gcode), B = byLayer(g);
      const diffs = ['0.2', '0.4', '0.6', '0.8', '1', '1.2'].map(zz => {
        const x = towerOf(A[zz], zz), y = towerOf(B[zz] || [], zz), at = x.findIndex((l, j) => !same(l, y[j] || ''));
        return at < 0 && x.length === y.length ? null : [zz, at, x[at], y[at], x.length, y.length];
      }).filter(Boolean);
      check('...and the tower\'s part of every layer is Studio\'s, line for line: two visits a layer, the wall with a gap for each purge, before ' +
        'the first change or after the one that brings the wall\'s filament in, each purge in its own band', diffs.length === 0, JSON.stringify(diffs.slice(0, 2)));
    }
    global.nsoProjects = was;
  }

  // ===========================================================================
  section('5f. Nozzles and quality presets: the A1 mini 0.2 / 0.4 / 0.6 / 0.8, the P1S 0.2 / 0.4 / 0.6, Bambu\'s presets (docs/PRINT-CARD.md "Nozzle and quality")');
  // ===========================================================================
  {
    const { readSTL } = require('./nso_stl_io.js');
    const box = readSTL(path.join(ROOT, 'fixtures/box-20mm.stl'));
    const WANT = { '0.2': { w: 0.22, retr: '0.4', std: '0.10mm Standard' }, '0.4': { w: 0.42, retr: '0.8', std: '0.20mm Standard' }, '0.6': { w: 0.62, retr: '1.4', std: '0.30mm Standard' }, '0.8': { w: 0.82, retr: '3', std: '0.40mm Standard' } };
    check('the nozzles: the A1 mini 0.2 / 0.4 / 0.6 / 0.8, the P1S 0.2 / 0.4 / 0.6 - and each has Bambu\'s qualities (the A1 mini at 0.4: 10, Extra Fine 0.08 to Extra Draft 0.28)',
      PRINT.nozzlesOf(tpl).join() === '0.2,0.4,0.6,0.8' && PRINT.nozzlesOf(p1sCfg).join() === '0.2,0.4,0.6' &&
        PRINT.qualitiesOf(tpl, '0.4').length === 10 && PRINT.qualitiesOf(tpl, '0.4')[0].layer === 0.08 && PRINT.qualitiesOf(tpl, '0.4').slice(-1)[0].layer === 0.28,
      PRINT.qualitiesOf(tpl, '0.4').map(q => q.name).join(', '));
    check('...an untouched card writes no preset (the template is 0.4 at its own 0.20mm Standard)', Object.keys(PRINT.qualityOverlay(tpl, '0.4', '0.20mm Standard @BBL A1M')).length === 0);
    for (const [cfg, pr, name] of [[tpl, a1, 'A1 mini'], [p1sCfg, p1sPrinter, 'P1S']]) {
      for (const nz of PRINT.nozzlesOf(cfg)) {
        const st = Object.assign({}, PRINT.settingsFromConfig(PRINT.presetConfig(cfg, nz, null)), { nozzle: +nz });
        const r = await PRINT.build(PRINT.pieceObjects([{ name: 'box', soup: Float32Array.from(box) }], pr.bed), { config: cfg, printer: pr }, { settings: st });
        if (!r.ok) { check(name + ' ' + nz + ' slices', false, r.reason); continue; }
        const z = L.R.openZip(r.bytes), g = L.text(await z.read('Metadata/plate_1.gcode')), si = L.text(await z.read('Metadata/slice_info.config'));
        const cb = k => ((new RegExp('^; ' + k + ' = (.*)$', 'm').exec(g)) || [])[1] || '';
        const w = WANT[nz], widths = new Set((g.match(/^; LINE_WIDTH: .*/mg) || []).map(l => +l.slice(14)));
        const exe = g.slice(g.indexOf('EXECUTABLE_BLOCK_START'));
        let ok = cb('nozzle_diameter').split(',')[0] === nz && cb('print_settings_id').startsWith(w.std) && cb('retraction_length').split(',')[0] === w.retr &&
          widths.has(w.w) && new RegExp('key="nozzle_diameters" value="' + nz + '"').test(si) && cb('printer_settings_id').endsWith(nz + ' nozzle');
        let note = '';
        if (nz === '0.2') { ok = ok && +cb('filament_max_volumetric_speed').split(',')[0] <= 2; note = ', max flow ' + cb('filament_max_volumetric_speed'); }
        if (name === 'P1S') { ok = ok && exe.includes(';===== machine: P1S-' + nz + ' ') && /^G0 X240 E(\d+)/m.exec(exe)[1] === (nz === '0.6' ? '25' : '15'); note += ', purge ' + /^G0 X240 E(\d+)/m.exec(exe)[1]; }
        check(name + ' ' + nz + ' nozzle: Bambu\'s ' + w.std + ', the ' + w.w + ' line, retraction ' + w.retr + ' (' + PRINT.describe(r) + note + ')', ok,
          [cb('nozzle_diameter'), cb('print_settings_id'), cb('retraction_length'), [...widths].join('/'), cb('printer_settings_id')].join(' | '));
      }
    }
    const xd = PRINT.configOverlay(p1sCfg, Object.assign({}, PRINT.settingsFromConfig(PRINT.presetConfig(p1sCfg, '0.4', '0.28mm Extra Draft @BBL X1C')), { quality: '0.28mm Extra Draft @BBL X1C' }));
    check('a quality preset is Bambu\'s: Extra Draft on the P1S writes layer_height 0.28 and print_settings_id "0.28mm Extra Draft @BBL X1C"', xd.layer_height === '0.28' && xd.print_settings_id === '0.28mm Extra Draft @BBL X1C', JSON.stringify(xd).slice(0, 300));
    let threw = ''; try { PRINT.configOverlay(p1sCfg, Object.assign({}, PRINT.settingsFromConfig(p1sCfg), { nozzle: 0.8 })); } catch (e) { threw = e.message; }
    check('...and a nozzle the printer has no profile for is refused (the P1S 0.8)', /no 0\.8 mm nozzle profile/.test(threw), threw);
  }

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
  check('the Print card (docs/PRINT-CARD.md) is the one card: Printer, Filament and the Supports tick first, Slice, Preview and Export its only buttons, and every other slice row in its own sections - printer, quality, strength, supports, adhesion',
    (() => { const m = /<details class="vp-menu vp-shell-menu vp-col-menu" id="menu-supports">[\s\S]*?<\/details>\s*<!-- ADD/.exec(html);
      if (!m) return false;
      const c = m[0], has = id => c.includes('id="' + id + '"'), from = id => { const i = c.indexOf('id="' + id + '"'); return i < 0 ? '' : c.slice(i); };
      const sec = id => { const t = from(id), n = t.slice(1).search(/<details class="vp-sec print-sec"/); return n < 0 ? t : t.slice(0, n + 1); };
      return /<summary class="vp-bar-btn"[^>]*>Print<\/summary>/.test(c) &&
        ['btn-sup-all', 'btn-sup-slice', 'btn-slice-export', 'btn-slice-saveas', 'btn-slice-cancel', 'slice-profile', 'slice-readout', 'slice-progress', 'print-printer', 'sup-on', 'print-sup-body', 'sup-style',
         'slice-set-nozzle', 'slice-set-layer', 'slice-set-walls', 'slice-set-density', 'slice-set-pattern', 'slice-set-brim', 'slice-set-raft', 'slice-set-raft-gap', 'slice-settings-reset',
         'slice-set-filament', 'slice-set-nozzle-temp', 'slice-set-first-temp', 'slice-set-bed-temp', 'slice-set-max-flow', 'slice-set-temp-step', 'slice-set-temp-band', 'slice-filament-note',
         'slice-set-bridge-speed', 'slice-set-bridge-flow', 'slice-set-bridge-temp', 'slice-bridge-note', 'slice-set-flow-ratio', 'slice-set-retract-len', 'slice-set-retract-speed', 'slice-set-retract-before', 'slice-set-zhop',
         'slice-set-top-layers', 'slice-set-top-thick', 'slice-set-bot-layers', 'slice-set-bot-thick',
         'slice-set-wall-gen', 'slice-arachne-rows', 'slice-set-wall-angle', 'slice-set-wall-filter', 'slice-set-wall-translen', 'slice-set-wall-dist', 'slice-set-min-wall', 'slice-set-min-feature'].every(has) &&
        /* the wall generator and its levers are Quality's, Arachne's six hidden until it is picked */
        ['slice-set-wall-gen', 'slice-set-wall-angle', 'slice-set-min-feature'].every(id => sec('print-sec-quality').includes('id="' + id + '"')) && /^id="slice-arachne-rows" hidden>/.test(from('slice-arachne-rows')) &&
        /* ...and nothing of the cards it took the place of: no second Slice button, no None, no Remove, no second angle, no interface rule */
        ['btn-slice-go', 'btn-sup-none', 'btn-sup-remove', 'slice-set-angle', 'slice-set-iface', 'slice-settings-toggle', 'btn-slice-preview', 'sup-plate'].every(id => !html.includes('id="' + id + '"')) &&
        c.indexOf('id="btn-sup-all"') < c.indexOf('id="btn-sup-slice"') && c.indexOf('id="btn-sup-slice"') < c.indexOf('id="btn-slice-export"') && c.indexOf('id="btn-slice-export"') < c.indexOf('id="sup-style"') &&
        /* the first choices, at the top: Printer, Filament, the Supports tick, then Slice - the rest is in the sections (the owner, 2026-11-23) */
        c.indexOf('id="print-printer"') < c.indexOf('id="slice-set-filament"') && c.indexOf('id="slice-set-filament"') < c.indexOf('id="sup-on"') &&
        c.indexOf('id="sup-on"') < c.indexOf('id="btn-sup-all"') && !sec('print-sec-printer').includes('id="slice-set-filament"') && sec('print-sec-quality').includes('id="slice-set-layer"') && sec('print-sec-strength').includes('id="slice-set-walls"') &&
        /* the raft is adhesion's: reached with Supports unticked (it is outside the body the tick greys) */
        sec('print-sec-adhesion').includes('id="slice-set-raft"') && sec('print-sec-adhesion').includes('id="slice-set-brim"') && !sec('print-sec-supports').includes('id="slice-set-raft"') &&
        c.indexOf('id="print-sup-body"') < c.indexOf('id="sup-style"') &&
        /* the types: Straight strut, Tree, Gecko Hands - None is the tick, not a type */
        /^id="sup-style"[^>]*>\s*<option value="strut">Straight strut<\/option>\s*<option value="tree" selected>Tree<\/option>\s*<option value="gecko-hand">Gecko Hands<\/option>\s*<\/select>/.test(from('sup-style')) &&
        /* G-scope sets nothing: its Slice switch is a view */
        !/id="ms-slice-set-/.test(html) && html.includes('id="ms-slice-settings-note"'); })());
  check('the Print card\'s markup closes what it opens (a stray </div></details> ends the left column early: the buttons under Print fall out of the bar)',
    (() => { const m = /<details class="vp-menu vp-shell-menu vp-col-menu" id="menu-supports">[\s\S]*?<\/details>\s*<!-- ADD/.exec(html);
      if (!m) return false;
      const c = m[0].replace(/<!--[\s\S]*?-->/g, '');
      return ['div', 'details', 'label', 'span', 'select', 'button', 'summary', 'p'].every(t => (c.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length === (c.match(new RegExp('</' + t + '>', 'g')) || []).length); })());
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

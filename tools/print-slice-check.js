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
 *   - the plate's printer profile (A1 mini; the A1 / P1S / X1C plate takes the P1S)
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
  const pa = PRINT.profileFor('a1mini'), pp = PRINT.profileFor('a1');
  check('the A1 mini plate has the A1 mini 0.4 profile, the A1 / P1S / X1C plate the P1S 0.4 one',
    pa && pa.id === 'a1mini-0.4' && pp && pp.id === 'p1s-0.4', JSON.stringify([pa, pp]));
  check('a plate with no profile (Prusa, Ender, Custom, nothing) has none, and the prototype chain is not one',
    ['prusa', 'ender', 'custom', '', null, undefined, 'toString', 'constructor'].every(id => PRINT.profileFor(id) === null));
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
  const order = ['id="menu-sculpt"', 'id="menu-slice"', 'id="btn-microscope"', 'id="menu-repair"', 'class="vp-shell-view'].map(s => col.indexOf(s));
  check('the left bar, top to bottom: ... Sculpt, SLICE, G-SCOPE, CHECK & REPAIR, then the view row', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), order.join(' '));
  check('...and G-scope is no longer first in the column (Scale is)', col.indexOf('id="menu-scale"') < col.indexOf('id="btn-microscope"') && col.indexOf('id="menu-scale"') > 0 &&
    col.indexOf('id="menu-scale"') < col.indexOf('id="menu-slice"'));
  check('G-scope\'s button is the same button: its id, class, label and its file input beside it',
    /<button id="btn-microscope" class="vp-bar-btn btn-gscope" type="button"\s+aria-label="G-scope"\s+title="G-scope: put the plate under the lens[^"]*">G-scope<\/button>\s*<input type="file" id="ms-input" accept="\.stl,\.3mf" class="hidden-quiet" \/>/.test(html));
  check('the card is a column card like the others: a details.vp-menu with a summary and a .vp-menu-body holding every button it has',
    (() => { const m = /<details class="vp-menu vp-shell-menu vp-col-menu[^"]*" id="menu-slice"[\s\S]*?<\/details>/.exec(html);
      return !!m && /<summary class="vp-bar-btn"[^>]*>Slice<\/summary>/.test(m[0]) && ['btn-slice-go', 'btn-slice-cancel', 'btn-slice-export', 'btn-slice-preview', 'slice-profile', 'slice-readout', 'slice-progress']
        .every(id => m[0].includes('id="' + id + '"')) && /Export \.gcode\.3mf/.test(m[0]) && /Preview in G-scope/.test(m[0]); })());
  const tags = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script src="([^"?]+)(?:\?v=\w+)?"/g)].map(m => m[1]);
  const idx = f => tags.indexOf(f);
  check('the planner, the packager and app-print.js are loaded by the page, after the files they read at load and after G-scope',
    ['nso-cooling-profiles.js', 'nso-3mf.js', 'nso-3mf-read.js', 'nso_slicer.js', 'app-microscope.js'].every(f => idx(f) >= 0 && idx(f) < idx('nso-print-planner.js')) &&
      idx('nso-print-planner.js') < idx('nso-gcode3mf-write.js') && idx('nso-gcode3mf-write.js') < idx('app-print.js'), tags.filter(t => /print|3mf|gcode3/.test(t)).join(' '));
  check('every file the slice worker loads is one of the page\'s script tags (it finds them there), once', PRINT.ENGINE.every(f => tags.filter(t => t === f).length === 1), PRINT.ENGINE.join(', '));
  const gscopeFiles = fs.readdirSync(ROOT).filter(f => /^app-(microscope|gscope-.*)\.js$/.test(f));
  const touchers = gscopeFiles.filter(f => /nso-print-planner|nso-gcode3mf-write|NSOPrintPlanner|NSO_Gcode3mf|NSO_Print\b|app-print/.test(read(f)));
  check('no G-scope file (' + gscopeFiles.join(', ') + ') loads or calls the planner, the packager or this card', gscopeFiles.length >= 3 && touchers.length === 0, touchers.join(', '));
  const src = read('app-print.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the card never reads or writes G-scope\'s Slice settings (ms-slice-*), and does not use toGcode()', !/ms-slice|toGcode\(/.test(src));
  check('...it calls only G-scope\'s plate reader and its file import, and - for the Export card\'s rows of a slice it opened - the open document, the selection\'s object ids and a re-read of the rows',
    JSON.stringify([...new Set([...src.matchAll(/\bMS\.(\w+)/g)].map(m => m[1]))].sort()) === '["getDoc","openFile","plateObjects","refreshExport","selectedObjectIds"]');

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.log('  FAIL  the check threw: ' + ((err && err.stack) || err)); process.exit(1); });

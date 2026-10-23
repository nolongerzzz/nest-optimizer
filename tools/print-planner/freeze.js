#!/usr/bin/env node
/*
 * tools/print-planner/freeze.js - freeze a printer's start and end G-code from
 * the owner's own Bambu slice.
 *
 *   node tools/print-planner/freeze.js            write both printers
 *   node tools/print-planner/freeze.js --check    rebuild and compare to what is committed
 *
 * WHY FROZEN. machine_start_gcode and machine_end_gcode are Bambu's template
 * language ({if ...}, [bed_temperature_initial_layer_single], {first_layer_
 * print_min[0]}). NSO has no template evaluator and does not want one. The
 * block Studio expanded for the owner's slice of the template plate is the
 * ground truth for what that printer needs; this tool cuts it out of the slice
 * and keeps it as lines of text. Only what the template computes from the
 * plate is a token:
 *
 *   {N} {N-20} {N-40}   nozzle_temperature_initial_layer (and the template's -20 / -40)
 *   {T}                 nozzle_temperature
 *   {B}                 the bed temperature, first layer
 *   {BX} {BY} {BW} {BH} the first-layer box (first_layer_print_min / _size)
 *   {CY}                the first layer's centre, Y
 *   {Z+0.4} {Z+100} {Z+98}   max_layer_z plus a stated amount (the end block; the
 *                       P1S adds 0.5, not 0.4: the token carries the amount)
 *   M73 lines           "@M73 <seconds>": where in the print Studio put its
 *                       progress marker (the planner writes P and R from its
 *                       own time model)
 *
 * Every token rule states how many lines it must change; one that changes
 * another number fails here, not in a print. The tool then puts the slice's own
 * values back and requires the result to equal the slice's lines, M73 lines
 * aside. print:planner repeats that.
 *
 * Output: fixtures/print-planner/<printer>/frozen.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib.js');
const { ROOT } = L;
const PL = require(path.join(ROOT, 'nso-print-planner.js'));

const OUT = path.join(ROOT, 'fixtures', 'print-planner');

/* Each printer: the slice its blocks come from and the rules that make the
   template's computed numbers into tokens. A rule is [regex, replacement,
   count]: the lines the regex matches (whole line) become the replacement. */
const PRINTERS = {
  'a1mini-0.4': {
    printer: 'Bambu Lab A1 mini', nozzle: '0.4', modelId: 'N1',
    slice: 'fixtures/supports/top_clip_x2_supports.gcode.3mf',
    bed: { x: 180, y: 180, z: 180 },
    values: { nozzle: 220, nozzleT: 220, bed: 65 },
    endZ: { hop: 0.4, cap: 180, capLines: ['G1 Z180 F600', 'G1 Z180'] },
    start: [
      [/^M140 S65$/, 'M140 S{B}', 1],
      [/^M190 S65;set bed temp$/, 'M190 S{B};set bed temp', 1],
      [/^ {4}M109 S220$/, '    M109 S{N}', 1],
      [/^ {4}M109 S200 ; drop nozzle temp, make filament shink a bit$/, '    M109 S{N-20} ; drop nozzle temp, make filament shink a bit', 1],
      [/^ {4}M104 S180$/, '    M104 S{N-40}', 1],
      [/^ {4}M109 S180$/, '    M109 S{N-40}', 1],
      [/^M109 S220$/, 'M109 S{T}', 1],
      [/^M104 S220$/, 'M104 S{N}', 1],
      [/^( *)G29 A1 X[\d.]+ Y[\d.]+ I[\d.]+ J[\d.]+$/, '$1G29 A1 X{BX} Y{BY} I{BW} J{BH}', 1]
    ],
    end: [
      [/^G1 Z[\d.]+ F900 ; lower z a little$/, 'G1 Z{Z+0.4} F900 ; lower z a little', 1],
      [/^G1 X0 Y[\d.]+ F18000 ; move to safe pos$/, 'G1 X0 Y{CY} F18000 ; move to safe pos', 1]
    ]
  },
  'p1s-0.4': {
    printer: 'Bambu Lab P1S', nozzle: '0.4', modelId: null,
    slice: 'fixtures/supports/simple_overhang_p1s.gcode.3mf',
    bed: { x: 256, y: 256, z: 256 },
    values: { nozzle: 220, nozzleT: 220, bed: 55 },
    endZ: { hop: 0.5, cap: 250, capLines: ['G1 Z250 F600', 'G1 Z248'] },
    start: [
      [/^M140 S55 ;set bed temp$/, 'M140 S{B} ;set bed temp', 1],
      [/^M190 S55 ;wait for bed temp$/, 'M190 S{B} ;wait for bed temp', 1],
      [/^M104 S220 ;set extruder temp$/, 'M104 S{N} ;set extruder temp', 1],
      [/^ {4}M109 S220$/, '    M109 S{N}', 1],
      [/^M104 S220$/, 'M104 S{N}', 1],
      [/^M109 S200 ; drop nozzle temp, make filament shink a bit$/, 'M109 S{N-20} ; drop nozzle temp, make filament shink a bit', 1],
      [/^M109 S200$/, 'M109 S{N-20}', 1],
      [/^M104 S220 ; set extrude temp earlier, to reduce wait time$/, 'M104 S{N} ; set extrude temp earlier, to reduce wait time', 1],
      [/^M109 S220$/, 'M109 S{N}', 1],
      [/^( *)G29 A X[\d.]+ Y[\d.]+ I[\d.]+ J[\d.]+$/, '$1G29 A X{BX} Y{BY} I{BW} J{BH}', 1]
    ],
    end: [
      [/^G1 Z[\d.]+ F900 ; lower z a little$/, 'G1 Z{Z+0.5} F900 ; lower z a little', 1]
    ]
  }
};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
const num = v => String(+(+v).toFixed(4));

/** Apply rules, each exactly `count` times. Returns new lines. */
function applyRules(lines, rules, where) {
  const out = lines.slice();
  for (const [re, rep, count] of rules) {
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      if (typeof out[i] === 'string' && re.test(out[i])) { out[i] = out[i].replace(re, rep); n++; }
    }
    if (n !== count) throw new Error(where + ': ' + re + ' changed ' + n + ' line(s), expected ' + count);
  }
  return out;
}

/** The slice's M73 P/R lines inside a block -> "@M73 <seconds>"; returns the new lines. */
function freezeM73(lines, totalSeconds) {
  return lines.map(s => {
    const m = /^M73 P(\d+) R(\d+)$/.exec(s);
    return m ? '@M73 ' + Math.round(totalSeconds * (+m[1]) / 100) : s;
  });
}

/** Studio's "Xm Ys" or "Xh Ym Zs" as seconds. */
function seconds(s) {
  let t = 0;
  s.replace(/(\d+)([dhms])/g, (a, n, u) => { t += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u]; return a; });
  return t;
}

/** The first layer's box the way Studio's G29 line has it: first-layer beads, each end widened by half its width. */
async function build(id) {
  const P = PRINTERS[id];
  const slice = await L.bambuSlice(P.slice);
  const lines = slice.gcode.split('\n');
  const find = (re, from) => { for (let i = from || 0; i < lines.length; i++) if (typeof re === 'string' ? lines[i] === re : re.test(lines[i])) return i; return -1; };
  const iExec = find('; EXECUTABLE_BLOCK_START'), iMEnd = find('; MACHINE_START_GCODE_END');
  const iLayer = find('; CHANGE_LAYER'), iEndStart = find('; MACHINE_END_GCODE_START'), iExecEnd = find('; EXECUTABLE_BLOCK_END');
  if ([iExec, iMEnd, iLayer, iEndStart, iExecEnd].some(i => i < 0)) throw new Error(id + ': the slice lacks a block marker');
  const header = {};
  lines.slice(0, find('; HEADER_BLOCK_END')).forEach(l => { const m = /^; ([^:]+): ?(.*)$/.exec(l); if (m) header[m[1].trim()] = m[2]; });
  const times = /model printing time: (.*?); total estimated time: (.*)$/.exec(lines[2]);
  const modelSeconds = seconds(times[1]), totalSeconds = seconds(times[2]);

  // the numbers the slice's blocks were expanded with
  const g29 = lines.find(l => /^\s*G29 A1? ?X/.test(l));
  const gm = /X([\d.]+) Y([\d.]+) I([\d.]+) J([\d.]+)/.exec(g29);
  const box = { x: +gm[1], y: +gm[2], w: +gm[3], h: +gm[4] };
  const layerZs = lines.filter(l => /^; Z_HEIGHT: /.test(l)).map(l => +l.slice(12));
  const maxZ = layerZs[layerZs.length - 1];
  const values = Object.assign({ box: box, cy: box.y + box.h / 2, maxZ: maxZ }, P.values);

  // ---- start: from after "M73 P0 R.." to MACHINE_START_GCODE_END; afterStart: the filament start and the rest to layer 1
  if (!/^M73 P0 R\d+$/.test(lines[iExec + 1])) throw new Error(id + ': no M73 P0 after EXECUTABLE_BLOCK_START');
  const startRaw = lines.slice(iExec + 2, iMEnd + 1);
  const afterRaw = lines.slice(iMEnd + 1, iLayer);
  let start = applyRules(freezeM73(startRaw, totalSeconds), P.start, id + ' start');
  const spaghettiOpen = afterRaw.filter(l => /^M981 S1 /.test(l));
  let after = freezeM73(afterRaw, totalSeconds);
  after = after.map(l => /^M981 S1 /.test(l) ? { hook: 'spaghetti', line: l } : l);
  // the first-layer M73 (Studio's, right after the first Z_HEIGHT) is where the start ends
  const iFirstM73 = find(/^M73 P\d+ R\d+$/, iLayer);
  const startSeconds = Math.round(totalSeconds * +/P(\d+)/.exec(lines[iFirstM73])[1] / 100);

  // ---- end: from after MACHINE_END_GCODE_START to M73 P100 R0
  const lastM73 = iExecEnd - 1;
  if (lines[lastM73] !== 'M73 P100 R0') throw new Error(id + ': the slice does not end with M73 P100 R0');
  const endRaw = lines.slice(iEndStart + 1, lastM73);
  let end = applyRules(freezeM73(endRaw, totalSeconds), P.end, id + ' end');
  // the "{if (max_layer_z + 100.0) < cap}" pair
  const hi = P.endZ;
  const iHigh = end.findIndex(l => typeof l === 'string' && l.trim() === 'G1 Z' + num(maxZ + 100) + ' F600');
  if (iHigh < 0 || end[iHigh + 1].trim() !== 'G1 Z' + num(maxZ + 98)) throw new Error(id + ': the end block\'s Z+100 / Z+98 pair is not where expected');
  const indent = /^ */.exec(end[iHigh])[0];
  end.splice(iHigh, 2, { zTop: [indent + 'G1 Z{Z+100} F600', indent + 'G1 Z{Z+98}'], zTopElse: hi.capLines.map(l => indent + l), cap: hi.cap });
  // the line before MACHINE_END_GCODE_START that Studio writes, outside the template
  let eb = iEndStart;
  while (eb > 0 && /^(M106 |M981 S0 |; FEATURE: Custom$)/.test(lines[eb - 1])) eb--;
  const beforeEnd = lines.slice(eb, iEndStart + 1).map(l => /^M981 S0 /.test(l) ? { hook: 'spaghetti', line: l } : l);

  // ---- the per-layer hooks (time_lapse_gcode, expanded): layers 1, 2, 3 and 4 (4 stands for 4 and after)
  const hooks = { wrap: !!lines.find(l => /^; object ids of layer 2 start/.test(l)), variants: {} };
  let layerNo = 0;
  const bodies = {};
  for (let i = iLayer; i < iEndStart; i++) {
    if (lines[i] === '; CHANGE_LAYER') layerNo++;
    if (/^; SKIPPABLE_START/.test(lines[i]) && !bodies[layerNo]) {
      let a = i;
      while (a > iLayer && !/^;=+ ?[dD]ate/.test(lines[a]) && i - a < 6) a--;
      let b = i; while (lines[b] !== '; SKIPPABLE_END') b++;
      // trailing lines up to the object-ids end line (A1) or just SKIPPABLE_END (P1S)
      let c = b + 1;
      if (hooks.wrap) { while (!/^; object ids of this layer\d+ end/.test(lines[c])) c++; }
      bodies[layerNo] = lines.slice(a, c);
    }
  }
  for (const n of [1, 2, 3, 4]) {
    if (!bodies[n]) throw new Error(id + ': no hook in layer ' + n);
    const z = layerZs[n - 1];
    const zh = num(z + 0.4);
    let body = bodies[n].filter(l => !/^M73 P\d+ R\d+$/.test(l));
    body = body.map(l => l
      .replace(new RegExp('^(G[01] Z)' + zh.replace('.', '\\.') + '( |$)'), '$1{ZH}$2')
      .replace(/^(G1 Z)(\d+\.\d{3})$/, (a, p, v) => Math.abs(+v - (z + 0.4)) < 1e-6 ? p + '{ZH:3}' : a)
      .replace(/^(G1 X0 Y)[\d.]+( F18000 ; move to safe pos)$/, '$1{CY}$2')
      .replace(new RegExp('^( +G0 Z)' + zh.replace('.', '\\.') + '( F4000)$'), '$1{ZH}$2'));
    // split into pre / timelapse / clog / post so a profile can switch each off
    const iTl = body.findIndex(l => l === '; SKIPTYPE: timelapse');
    const iClog = body.findIndex(l => l === '; SKIPTYPE: head_wrap_detect');
    const iEnd = body.findIndex(l => l === '; SKIPPABLE_END');
    hooks.variants[n] = {
      pre: body.slice(0, iTl),
      timelapse: body.slice(iTl, iClog >= 0 ? iClog : iEnd),
      clog: iClog >= 0 ? body.slice(iClog, iEnd) : [],
      post: body.slice(iEnd)
    };
  }
  if (hooks.wrap) {
    // the object-ids lines belong to the planner; the hook keeps only the template's own text
    for (const n of [1, 2, 3, 4]) {
      const v = hooks.variants[n];
      v.post = v.post.filter(l => !/^; object ids of this layer\d+ end/.test(l));
    }
  }

  // ---- the CONFIG_BLOCK, as Studio wrote it
  const cs = find('; CONFIG_BLOCK_START'), ce = find('; CONFIG_BLOCK_END');
  const configBlock = lines.slice(cs + 1, ce);

  // ---- filament the header counts that the body does not (the start's purge)
  let bodySum = 0;
  for (let i = iMEnd; i < iEndStart; i++) {
    const m = /^G[0-3] .*E(-?[\d.]+)/.exec(lines[i]) || /^G1 E(-?[\d.]+)/.exec(lines[i]);
    if (m && +m[1] > 0 && !/F1800$|F300$/.test(lines[i])) bodySum += +m[1];
  }
  const purgeMm = +(+header['total filament length [mm] '.trim()] - bodySum).toFixed(2);

  const frozen = {
    id: id, printer: P.printer, nozzle: P.nozzle, modelId: P.modelId,
    studio: header.BambuStudio || /^; BambuStudio ([\d.]+)/.exec(lines[1])[1],
    source: { file: P.slice, sha256: sha256(fs.readFileSync(path.join(ROOT, P.slice))) },
    bed: P.bed,
    values: values,
    timing: { totalSeconds: totalSeconds, modelSeconds: modelSeconds, startSeconds: startSeconds,
              endSeconds: totalSeconds - modelSeconds - startSeconds },
    purgeMm: purgeMm,
    endZ: { hop: hi.hop, cap: hi.cap },
    start: start, afterStart: after, beforeEnd: beforeEnd, end: end,
    hooks: hooks,
    configBlock: configBlock
  };
  // sanity
  if (!spaghettiOpen.length) throw new Error(id + ': no spaghetti line found');
  return { frozen, lines, iExec, iMEnd, iLayer, iEndStart, iExecEnd, startRaw, afterRaw, endRaw, bodies };
}

/** Put the slice's own values back (the planner's own thaw); M73 lines come back as a marker only. */
function thaw(frozen, v) {
  return { start: PL.thaw(frozen.start, v), afterStart: PL.thaw(frozen.afterStart, v),
           beforeEnd: PL.thaw(frozen.beforeEnd, v), end: PL.thaw(frozen.end, v) };
}

async function main() {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const id of Object.keys(PRINTERS)) {
    const b = await build(id);
    const f = b.frozen;
    // the round trip: thaw with the slice's own numbers; equals the slice, M73 lines aside
    const t = thaw(f, f.values);
    const noM73 = a => a.filter(l => !/^(@M73 \d+|M73 P\d+ R\d+)$/.test(l));
    const cmp = (name, got, want) => {
      const A = noM73(got), B = noM73(want);
      const ok = A.length === B.length && A.every((l, i) => l === B[i]);
      if (!ok) { bad++; const i = A.findIndex((l, k) => l !== B[k]); console.log('  FAIL ' + id + ' ' + name + ': line ' + i + '\n    got  ' + A[i] + '\n    want ' + B[i]); }
      else console.log('  ok   ' + id + ' ' + name + ' thaws to the slice (' + A.length + ' lines)');
    };
    cmp('start', t.start, b.startRaw);
    cmp('afterStart', t.afterStart, b.afterRaw);
    cmp('end', t.end, b.endRaw);
    const file = path.join(OUT, id, 'frozen.json');
    const text = JSON.stringify(f, null, 1) + '\n';
    if (check) {
      const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (have !== text) { bad++; console.log('  FAIL ' + id + ': frozen.json differs from a fresh freeze'); } else console.log('  ok   ' + id + ': frozen.json is a fresh freeze');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      console.log('  wrote ' + path.relative(ROOT, file) + ' (' + text.length + ' bytes)');
    }
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { PRINTERS, build, thaw };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/*
 * gcode3mf:test - NSO writes a Bambu-shaped .gcode.3mf (nso-gcode3mf-write.js).
 *
 *   node tools/3mf-test/gcode3mf-check.js [--keep <dir>]
 *
 * The reference is fixtures/supports/top_clip_x2_supports.gcode.3mf (Bambu
 * Studio 02.08.02.61, A1 mini 0.4). This re-packages it: it unzips the
 * reference with Node's zlib (none of the writer's code), takes its
 * plate_1.gcode, project_settings.config and object list, writes a new file
 * through the module, and holds the result to the reference part by part:
 *
 *   1. MD5: RFC 1321's vectors, node:crypto on every length 0-200 and around
 *      the block edges, and the reference's own plate_1.gcode.md5
 *   2. the part list: the reference's parts, in its order
 *   3. byte-identical to the reference: [Content_Types].xml, _rels/.rels,
 *      plate_1.gcode, plate_1.gcode.md5, project_settings.config,
 *      model_settings.config and its rels, cut_information.xml,
 *      filament_sequence.json
 *   4. 3dmodel.model and slice_info.config: identical but for the stated
 *      placeholders (DesignerUserId; first_layer_time; no <warning> lines)
 *   5. plate_1.json: every field the reference has; the layer-1 footprints
 *      within 0.15 mm of Studio's; the stated placeholders (id, area,
 *      first_layer_time)
 *   6. thumbnails: blank PNGs at the reference's sizes when none are passed,
 *      the caller's bytes verbatim when they are
 *   7. read from the G-code first: wrong passed values do not override what
 *      the G-code carries; with the header stripped, the passed values fill
 *   8. round trip: NSO_Gcode3mf.read() gives the fields back; the G-scope
 *      import route (NSOGcodeLines.readSlicedGcode3MF) reads the same
 *      toolpath out of the written file as out of the reference
 *   9. determinism and refusals
 *  10. a one-object plate (fixtures/supports/simple_overhang_bambu.gcode.3mf,
 *      no "start printing object" labels): plate_1.json's footprint from the
 *      layer-1 extrusion, held to Studio's file part by part
 *
 * Exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'nso-gcode3mf-write.js'));
const W = require(path.join(ROOT, 'nso-3mf.js'));
const Lines = require(path.join(ROOT, 'nso-gcode-lines.js'));
const REF = path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_supports.gcode.3mf');
const REF1 = path.join(ROOT, 'fixtures', 'supports', 'simple_overhang_bambu.gcode.3mf');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'ok    ' : 'FAIL  ') + label + (!ok && detail !== undefined ? '\n          ' + detail : ''));
}

/* Independent ZIP reader: Node's zlib over the central directory, CRCs
   checked. Returns the entries in the archive's own order. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014B50) throw new Error('bad central directory entry ' + n);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? Buffer.from(body) : null;
    if (!data || zlib.crc32 && zlib.crc32(data) !== crc) throw new Error('bad entry ' + name);
    files.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function pngInfo(buf) {
  if (!buf || buf.length < 33 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  const info = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], type: buf[25] };
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('ascii', at + 4, at + 8);
    const crcOk = zlib.crc32 ? zlib.crc32(buf.subarray(at + 4, at + 8 + len)) === buf.readUInt32BE(at + 8 + len) : true;
    if (!crcOk) return null;
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  info.pixels = zlib.inflateSync(Buffer.concat(idat));
  return info;
}

const keep = process.argv.indexOf('--keep') >= 0 ? process.argv[process.argv.indexOf('--keep') + 1] : null;

(async () => {
  const refBytes = fs.readFileSync(REF);
  const ref = readZip(refBytes);
  const refText = (p) => ref.get(p).toString('utf8');
  const gcode = refText(G.PART.gcode);
  const config = refText(G.PART.projectSettings);
  const refObjects = [...refText(G.PART.sliceInfo).matchAll(/<object identify_id="([^"]*)" name="([^"]*)" skipped="([^"]*)"/g)]
    .map((m) => ({ identify_id: m[1], name: m[2], skipped: m[3] === 'true' }));
  const DATE = refText(G.PART.model).match(/name="CreationDate">([^<]*)</)[1];
  const base = { gcode, config, objects: refObjects, printer: { model_id: 'N1' }, date: DATE };

  /* ---------- 1. MD5 ---------- */
  console.log('--- 1. MD5 ---');
  const vectors = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a']
  ];
  check('RFC 1321 test suite (7 vectors), uppercase hex', vectors.every(([s, h]) => G.md5(s) === h.toUpperCase()),
    vectors.map(([s]) => G.md5(s)).join(' '));
  const rnd = crypto.randomBytes(70003);
  let worstLen = null;
  for (const n of [...Array(201).keys(), 447, 448, 449, 511, 512, 513, 4095, 4096, 4097, 65535, 65536, 70000]) {
    const sub = new Uint8Array(rnd.buffer, rnd.byteOffset + 3, n); // an unaligned view, as a subarray
    if (G.md5(sub) !== crypto.createHash('md5').update(sub).digest('hex').toUpperCase()) { worstLen = n; break; }
  }
  check('node:crypto agrees on every length 0-200, the block edges and 64K, from an unaligned view', worstLen === null, 'first wrong length ' + worstLen);
  check('the reference plate_1.gcode hashes to its own plate_1.gcode.md5 (' + refText(G.PART.md5) + ')',
    G.md5(new Uint8Array(ref.get(G.PART.gcode))) === refText(G.PART.md5));
  check('a string is hashed as its UTF-8 bytes', G.md5('ø→✓') === crypto.createHash('md5').update('ø→✓', 'utf8').digest('hex').toUpperCase());

  /* ---------- 2. re-package the reference ---------- */
  console.log('\n--- 2. the part list ---');
  const t0 = Date.now();
  const built = await G.writeDetailed(base);
  const ms = Date.now() - t0;
  if (keep) { fs.mkdirSync(keep, { recursive: true }); fs.writeFileSync(path.join(keep, 'repackaged.gcode.3mf'), built.bytes); }
  const out = readZip(Buffer.from(built.bytes));
  const outText = (p) => out.get(p).toString('utf8');
  check('the reference\'s ' + ref.size + ' parts, in its order (' + ms + ' ms for a 1.6 MB G-code)',
    JSON.stringify([...out.keys()]) === JSON.stringify([...ref.keys()]),
    [...out.keys()].join(', '));
  check('PART_ORDER is that order', JSON.stringify(G.PART_ORDER) === JSON.stringify([...ref.keys()]));

  /* ---------- 3. byte-identical parts ---------- */
  console.log('\n--- 3. byte-identical to the reference ---');
  for (const p of ['[Content_Types].xml', '_rels/.rels', G.PART.gcode, G.PART.md5, G.PART.projectSettings,
    G.PART.modelSettings, G.PART.modelSettingsRels, G.PART.cutInfo, G.PART.filamentSequence]) {
    check(p, Buffer.compare(out.get(p), ref.get(p)) === 0, JSON.stringify(outText(p).slice(0, 300)));
  }
  const asObject = readZip(Buffer.from(await G.write(Object.assign({}, base, { config: JSON.parse(config) }))));
  check('project_settings.config passed as an object is written the way Studio formats it (4-space JSON)',
    Buffer.compare(asObject.get(G.PART.projectSettings), ref.get(G.PART.projectSettings)) === 0);

  /* ---------- 4. 3dmodel.model and slice_info.config ---------- */
  console.log('\n--- 4. the placeholders in 3dmodel.model and slice_info.config ---');
  const model = outText(G.PART.model), refModel = refText(G.PART.model);
  check('3dmodel.model: the reference\'s header, no meshes; only DesignerUserId differs (empty: not NSO\'s to write)',
    model === refModel.replace(/(name="DesignerUserId">)[^<]*/, '$1') && !/<mesh|<object/.test(model));
  check('3dmodel.model: Application BambuStudio-' + G.DEFAULT_STUDIO_VERSION + ', the G-code\'s own slicer',
    model.includes('<metadata name="Application">BambuStudio-02.08.02.61</metadata>'));
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, W.TEMPLATE_DIR, W.DEFAULT_TEMPLATE, 'template.json'), 'utf8'));
  check('DEFAULT_STUDIO_VERSION is the pinned Bambu template\'s (' + tpl.studio_version + ')', G.DEFAULT_STUDIO_VERSION === tpl.studio_version);
  const si = outText(G.PART.sliceInfo), refSi = refText(G.PART.sliceInfo);
  const refSiPlaceheld = refSi.replace(/(key="first_layer_time" value=")[^"]*/, '$10.000000').replace(/^ *<warning [^\n]*\n/gm, '');
  check('slice_info.config: the reference\'s, line for line, but first_layer_time 0.000000 and no <warning> lines',
    si === refSiPlaceheld, si.split('\n').filter((l, i) => l !== refSiPlaceheld.split('\n')[i]).join(' | '));
  for (const [k, v] of [['printer_model_id', 'N1'], ['nozzle_diameters', '0.4'], ['prediction', '1479'], ['weight', '3.22'],
    ['label_object_enabled', 'true']]) {
    check('slice_info ' + k + ' = ' + v, si.includes('key="' + k + '" value="' + v + '"'));
  }
  check('slice_info: one <object identify_id name skipped> per G-code label, named',
    (si.match(/<object identify_id="4044" name="top_clip_x2" skipped="false" \/>/g) || []).length === 1 &&
    (si.match(/<object identify_id="4066" name="top_clip_x2 - support 1.1 \(Tree\)" skipped="false" \/>/g) || []).length === 1);
  check('slice_info: the filament line and layer_filament_lists "0" over "0 82"',
    si.includes('<filament id="1" tray_info_idx="GFL99" type="PLA" color="#FFFFFF" used_m="1.08" used_g="3.22"') &&
    si.includes('<layer_filament_list filament_list="0" layer_ranges="0 82" />'));

  /* ---------- 5. plate_1.json ---------- */
  console.log('\n--- 5. plate_1.json ---');
  const pj = JSON.parse(outText(G.PART.plateJson)), rpj = JSON.parse(refText(G.PART.plateJson));
  check('the reference\'s keys, in its order', JSON.stringify(Object.keys(pj)) === JSON.stringify(Object.keys(rpj)) &&
    pj.bbox_objects.every((o, i) => JSON.stringify(Object.keys(o)) === JSON.stringify(Object.keys(rpj.bbox_objects[i]))));
  for (const k of ['bed_type', 'filament_colors', 'filament_ids', 'first_extruder', 'is_seq_print', 'nozzle_diameter', 'version']) {
    check(k + ' = ' + JSON.stringify(rpj[k]), JSON.stringify(pj[k]) === JSON.stringify(rpj[k]), JSON.stringify(pj[k]));
  }
  const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const dev = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  check('bbox_all within 0.15 mm of Studio\'s (worst ' + dev(pj.bbox_all, rpj.bbox_all).toFixed(3) + ' mm: NSO reads layer 1\'s extrusion, Studio its slice)',
    near(pj.bbox_all, rpj.bbox_all, 0.15), JSON.stringify(pj.bbox_all));
  check('each object\'s bbox within 0.15 mm, in the reference\'s order, named, layer_height float32 0.2',
    pj.bbox_objects.length === rpj.bbox_objects.length && pj.bbox_objects.every((o, i) =>
      near(o.bbox, rpj.bbox_objects[i].bbox, 0.15) && o.name === rpj.bbox_objects[i].name && o.layer_height === rpj.bbox_objects[i].layer_height),
    pj.bbox_objects.map((o, i) => dev(o.bbox, rpj.bbox_objects[i].bbox).toFixed(3)).join(', '));
  check('placeholder: id is the G-code label id (Studio writes its runtime id)', pj.bbox_objects.map((o) => o.id).join() === '4044,4066');
  check('placeholder: area is the footprint\'s bbox area (top_clip_x2 56, as Studio)',
    pj.bbox_objects.every((o) => Math.abs(o.area - (o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1])) < 1e-9) &&
    Math.abs(pj.bbox_objects[0].area - rpj.bbox_objects[0].area) < 0.01);
  check('placeholder: first_layer_time 0', pj.first_layer_time === 0);
  const fl = readZip(Buffer.from(await G.write(Object.assign({}, base, { estimate: { firstLayerSeconds: 45.030609130859375 } }))));
  check('estimate.firstLayerSeconds fills it, in both parts (45.030609, as Studio)',
    JSON.parse(fl.get(G.PART.plateJson).toString()).first_layer_time === rpj.first_layer_time &&
    fl.get(G.PART.sliceInfo).toString().includes('key="first_layer_time" value="45.030609"'));

  /* ---------- 6. thumbnails ---------- */
  console.log('\n--- 6. thumbnails ---');
  const thumbParts = { plate: G.PART.plate, plate_small: G.PART.plateSmall, no_light: G.PART.noLight, top: G.PART.top, pick: G.PART.pick };
  for (const [k, p] of Object.entries(thumbParts)) {
    const a = pngInfo(out.get(p)), r = pngInfo(ref.get(p));
    check('placeholder ' + p + ': a valid PNG, ' + r.w + 'x' + r.h + ' RGBA like the reference, fully transparent',
      a && a.w === r.w && a.h === r.h && a.depth === 8 && a.type === 6 && a.pixels.length === a.h * (a.w * 4 + 1) && a.pixels.every((b) => b === 0) &&
      a.w === G.THUMB_SIZES[k], a && JSON.stringify({ w: a.w, h: a.h }));
  }
  const thumbnails = {};
  for (const [k, p] of Object.entries(thumbParts)) thumbnails[k] = new Uint8Array(ref.get(p));
  const withThumbs = readZip(Buffer.from(await G.write(Object.assign({}, base, { thumbnails }))));
  check('passed thumbnails are written verbatim', Object.values(thumbParts).every((p) => Buffer.compare(withThumbs.get(p), ref.get(p)) === 0));

  /* ---------- 7. the G-code first ---------- */
  console.log('\n--- 7. read from the G-code, passed values only fill ---');
  const wrong = await G.writeDetailed(Object.assign({}, base, {
    estimate: { seconds: 1, grams: 99 }, printer: { model_id: 'N1', nozzle: 0.6 },
    filaments: [{ type: 'PETG', color: '#000000', tray_info_idx: 'X' }],
    objects: [{ identify_id: 1, name: 'top_clip_x2' }, { identify_id: 2, name: 'top_clip_x2 - support 1.1 (Tree)' }]
  }));
  const f = wrong.fields;
  check('time, weight, nozzle, filament and layer count come from the G-code, not the passed values',
    f.seconds === 1479 && f.grams === 3.22 && f.nozzle === '0.4' && f.layers === 83 && f.filaments[0].type === 'PLA' &&
    f.sources.seconds === 'gcode' && f.sources.grams === 'gcode' && f.sources.nozzle === 'gcode', JSON.stringify(f.sources));
  check('identify_id is the G-code\'s label id; passed objects whose ids it lacks are named in order',
    f.objects.map((o) => o.identify_id + '=' + o.name).join() === '4044=top_clip_x2,4066=top_clip_x2 - support 1.1 (Tree)');
  check('max_z and the label ids are the header\'s', f.maxZ === 16.6 && f.sources.labelIds === 'gcode');
  const swapped = G.describe(Object.assign({}, base, { objects: [refObjects[1], refObjects[0]] }));
  check('objects that carry the G-code\'s ids are paired by id, in the G-code\'s order',
    swapped.objects.map((o) => o.name).join() === refObjects.map((o) => o.name).join());
  const noHeader = gcode.replace(/; HEADER_BLOCK_START[\s\S]*?; HEADER_BLOCK_END\n/, '');
  const bare = G.describe(Object.assign({}, base, { gcode: noHeader, estimate: { seconds: 1500, grams: 3.5 } }));
  check('with the HEADER_BLOCK gone, the passed estimate fills time and weight',
    bare.seconds === 1500 && bare.grams === 3.5 && bare.sources.seconds === 'passed' && bare.sources.grams === 'passed');
  check('and the body still gives the layers (83), the label ids in order, max_z and the filament',
    bare.layers === 83 && bare.objects.map((o) => o.identify_id).join() === '4066,4044' &&
    Math.abs(bare.maxZ - 16.6) < 1e-9 && bare.filaments.length === 1 && bare.filaments[0].id === 1,
    JSON.stringify([bare.layers, bare.objects.map((o) => o.identify_id), bare.maxZ]));
  check('one filament load (28 s), no unloads, no pauses, no Support feature: as Studio counted',
    f.filaments[0].total_load_time === 28 && f.filaments[0].total_unload_time === 0 && f.pauseCount === 0 && f.filaments[0].used_for_support === false);
  check('nothing on layer 1 leaves the A1 mini\'s 180 x 180 bed: outside false', f.outside === false);

  /* ---------- 8. round trip ---------- */
  console.log('\n--- 8. round trip ---');
  const back = await G.read(built.bytes);
  check('read(): the parts, in order', JSON.stringify(back.parts) === JSON.stringify(G.PART_ORDER));
  check('read(): the G-code as given, its MD5 matching', back.gcode === gcode && back.md5Ok && back.md5 === refText(G.PART.md5));
  const d = built.fields;
  check('read(): slice_info gives the fields back',
    back.sliceInfo.clientVersion === d.studioVersion && back.sliceInfo.meta.prediction === String(d.seconds) &&
    Number(back.sliceInfo.meta.weight) === d.grams && back.sliceInfo.meta.printer_model_id === d.modelId &&
    back.sliceInfo.meta.nozzle_diameters === d.nozzle &&
    JSON.stringify(back.sliceInfo.objects.map((o) => [o.identify_id, o.name, o.skipped === 'true'])) ===
      JSON.stringify(d.objects.map((o) => [o.identify_id, o.name, o.skipped])) &&
    back.sliceInfo.filaments.length === 1 && back.sliceInfo.filaments[0].type === 'PLA' &&
    back.sliceInfo.layerFilamentLists[0].layer_ranges === '0 82');
  check('read(): the reference reads back the same way (the same fields, but its placeholders)', await (async () => {
    const r = await G.read(new Uint8Array(refBytes));
    return r.md5Ok && JSON.stringify(r.sliceInfo.objects) === JSON.stringify(back.sliceInfo.objects) &&
      JSON.stringify(r.sliceInfo.filaments) === JSON.stringify(back.sliceInfo.filaments) &&
      JSON.stringify(r.modelSettings) === JSON.stringify(back.modelSettings) &&
      Object.keys(r.sliceInfo.meta).every((k) => k === 'first_layer_time' || r.sliceInfo.meta[k] === back.sliceInfo.meta[k]);
  })());
  check('read(): plate_1.json, model_settings and filament_sequence', back.plate.version === 2 &&
    back.modelSettings.gcode_file === G.PART.gcode && back.modelSettings.pattern_bbox_file === G.PART.plateJson &&
    JSON.stringify(back.filamentSequence) === refText(G.PART.filamentSequence));
  const [gOut, gRef] = await Promise.all([Lines.readSlicedGcode3MF(built.bytes, { name: 'repackaged' }),
    Lines.readSlicedGcode3MF(new Uint8Array(refBytes), { name: 'reference' })]);
  const sig = (r) => JSON.stringify({ plate: r.plate, part: r.part, moves: r.parsed.moves.length,
    groups: r.groups.map((g) => [g.name, g.moves.length]), warnings: r.warnings });
  check('the G-scope import route reads the same toolpath (' + gOut.parsed.moves.length + ' moves, ' + gOut.groups.length + ' features) as from the reference',
    sig(gOut) === sig(gRef) && gOut.parsed.moves.length > 1000, sig(gOut).slice(0, 300));

  /* ---------- 9. determinism, refusals ---------- */
  console.log('\n--- 9. determinism and refusals ---');
  const again = await G.write(base);
  check('two writes of the same input are byte-identical', Buffer.compare(Buffer.from(again), Buffer.from(built.bytes)) === 0);
  const refused = async (o) => { try { await G.write(o); return null; } catch (e) { return e.message; } };
  const noCfg = await refused(Object.assign({}, base, { config: undefined }));
  check('no config: refused, saying so', /config/.test(noCfg || ''), noCfg);
  const oneObj = await refused(Object.assign({}, base, { objects: [{ name: 'x' }] }));
  check('one object for the G-code\'s two labels: refused, naming them', /4044,4066/.test(oneObj || ''), oneObj);
  const noModel = await refused(Object.assign({}, base, { printer: {}, gcode: gcode.replace('; printer_model = Bambu Lab A1 mini', '; printer_model = Bambu Lab P1S'),
    config: config.replace('"printer_model": "Bambu Lab A1 mini"', '"printer_model": "Bambu Lab P1S"') }));
  check('a printer with no model id on record and none passed: refused', /model_id/.test(noModel || ''), noModel);
  check('the A1 mini needs none passed (N1, from the fixture)', G.describe(Object.assign({}, base, { printer: {} })).modelId === 'N1');

  /* ---------- 10. a one-object plate ---------- */
  console.log('\n--- 10. one object: no labels in the G-code ---');
  const ref1 = readZip(fs.readFileSync(REF1));
  const t1 = (p) => ref1.get(p).toString('utf8');
  const gcode1 = t1(G.PART.gcode);
  check('the fixture has no "start printing object" labels and no model label id (Studio writes the footprint anyway)',
    !/start printing object/.test(gcode1) && !/model label id/.test(gcode1));
  const base1 = { gcode: gcode1, config: t1(G.PART.projectSettings), date: t1(G.PART.model).match(/name="CreationDate">([^<]*)</)[1],
    objects: [...t1(G.PART.sliceInfo).matchAll(/<object identify_id="([^"]*)" name="([^"]*)" skipped="([^"]*)"/g)]
      .map((m) => ({ identify_id: m[1], name: m[2], skipped: m[3] === 'true' })), estimate: { firstLayerSeconds: 48.512542724609375 } };
  const one = readZip(Buffer.from(await G.write(base1)));
  const oneText = (p) => one.get(p).toString('utf8');
  check('the reference\'s parts, in Studio\'s order, less its Auxiliaries (the model\'s own pictures)',
    JSON.stringify([...one.keys()]) === JSON.stringify([...ref1.keys()].filter((k) => !/^Auxiliaries\//.test(k))));
  for (const p of ['[Content_Types].xml', '_rels/.rels', G.PART.gcode, G.PART.md5, G.PART.projectSettings,
    G.PART.modelSettings, G.PART.modelSettingsRels, G.PART.cutInfo, G.PART.filamentSequence]) {
    check(p + ' byte-identical to Studio\'s', Buffer.compare(one.get(p), ref1.get(p)) === 0, JSON.stringify(oneText(p).slice(0, 200)));
  }
  const pj1 = JSON.parse(oneText(G.PART.plateJson)), rpj1 = JSON.parse(t1(G.PART.plateJson));
  const o1 = pj1.bbox_objects[0], r1 = rpj1.bbox_objects[0];
  check('plate_1.json: the reference\'s keys, in its order; one object, named',
    JSON.stringify(Object.keys(pj1)) === JSON.stringify(Object.keys(rpj1)) && pj1.bbox_objects.length === 1 &&
    JSON.stringify(Object.keys(o1)) === JSON.stringify(Object.keys(r1)) && o1.name === r1.name);
  for (const k of ['bed_type', 'filament_colors', 'filament_ids', 'first_extruder', 'first_layer_time', 'is_seq_print', 'nozzle_diameter', 'version']) {
    check('plate_1.json ' + k + ' = ' + JSON.stringify(rpj1[k]) + '', JSON.stringify(pj1[k]) === JSON.stringify(rpj1[k]), JSON.stringify(pj1[k]));
  }
  check('plate_1.json layer_height ' + r1.layer_height + ' (float32 0.2)', o1.layer_height === r1.layer_height, String(o1.layer_height));
  check('plate_1.json bbox_all and the object\'s bbox are the layer-1 footprint, within 0.15 mm of Studio\'s (worst ' +
    dev(o1.bbox, r1.bbox).toFixed(3) + ' mm), the support included as Studio has it',
    near(o1.bbox, r1.bbox, 0.15) && JSON.stringify(pj1.bbox_all) === JSON.stringify(o1.bbox) && near(pj1.bbox_all, rpj1.bbox_all, 0.15),
    JSON.stringify(o1.bbox));
  check('plate_1.json placeholder: id is the passed identify_id (225; Studio writes its runtime id ' + r1.id + ')', o1.id === 225 && r1.id === 243);
  check('plate_1.json placeholder: area is the footprint\'s bbox area (Studio writes the slice polygon\'s ' + r1.area.toFixed(2) + ')',
    Math.abs(o1.area - (o1.bbox[2] - o1.bbox[0]) * (o1.bbox[3] - o1.bbox[1])) < 1e-9);
  const si1 = oneText(G.PART.sliceInfo);
  const refSi1 = t1(G.PART.sliceInfo).replace(/^ *<warning [^\n]*\n/gm, '').replace(/ *<layer_filament_list filament_list="" layer_ranges="360 360" \/>\n/, '');
  check('slice_info.config: the reference\'s but for its <warning> lines and its empty-list layer 360 (Studio counts the lift after the last layer)',
    si1 === refSi1, si1.split('\n').filter((l, i) => l !== refSi1.split('\n')[i]).join(' | '));
  const m1 = oneText(G.PART.model), rm1 = t1(G.PART.model);
  check('3dmodel.model: the header only, no meshes (Studio carries the downloaded model\'s title, designer and pictures)',
    /BambuStudio-02\.08\.02\.61/.test(m1) && !/<mesh|<object/.test(m1) && /<build\/>/.test(rm1));
  const two = G.describe(Object.assign({}, base, { gcode: gcode.replace(/^; start printing object, unique label id: \d+$/gm, '') }));
  check('two objects without labels: no footprint is guessed (the lone-object rule is for one object only)', two.bboxObjects.length === 0);


  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\ngcode3mf:test crashed: ' + (err && err.stack || err));
  process.exit(1);
});

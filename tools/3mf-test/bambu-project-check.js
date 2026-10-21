#!/usr/bin/env node
/*
 * export:bambu - NSO's 3MF is Bambu Studio's project envelope, part for part.
 *
 *   node tools/3mf-test/bambu-project-check.js [--keep <dir>]
 *
 * nso-3mf.js writes the envelope of a project the owner's Bambu Studio saved
 * (fixtures/bambu-templates/a1mini-0.4/, docs/BAMBU-PROJECT-EXPORT.md) and
 * overlays only what NSO owns. This exports a plate through the module the app
 * uses, reads the archive back with Node's zlib (none of the writer's code),
 * and holds it to the template:
 *
 *   1. the record: template.json's version is the template's own, in its
 *      Application tag, project settings and slice_info; its sha256 is the file
 *   2. the part list: the template's parts, in its order, one object part per
 *      piece, plus NSO's own two; the parts NSO does not write are the
 *      template's bytes
 *   3. 3dmodel.model and the object parts: the template's skeleton (elements,
 *      attributes, metadata order), no mesh in the root model, Studio's UUID
 *      counters and suffixes, each mesh centred on its own origin and placed
 *      by its build item
 *   4. model_settings.config: the template's skeleton; names, extruder,
 *      face_count, one normal_part each; the support object's overrides on it
 *      alone; the template's plate block; <assemble> matching the build
 *   5. project_settings.config: the template's keys in its order, its version
 *      and presets, NSO's 14 cooling values on every filament slot
 *   6. identify_id: on every instance, unique, the same across two exports of
 *      the same plate, an object's own id honoured
 *   7. the version guard: the written Application tag is "BambuStudio-" + the
 *      fixture's recorded version; a template whose tag and record differ is
 *      refused (a known-bad copy, made and removed here) and the export falls
 *      back to the geometry-only envelope, saying why
 *   8. the geometry: nso-3mf-read.js reads every piece back where it was, and
 *      a piece without overrides is the same geometry as before
 *
 * Exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const Profiles = require(path.join(ROOT, 'nso-cooling-profiles.js'));
const W = require(path.join(ROOT, 'nso-3mf.js'));
const R = require(path.join(ROOT, 'nso-3mf-read.js'));
const SI = require(path.join(ROOT, 'nso_support_interface.js'));

const TPL_KEY = W.DEFAULT_TEMPLATE;
const TPL_DIR = path.join(ROOT, W.TEMPLATE_DIR, TPL_KEY);

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'ok    ' : 'FAIL  ') + label + (!ok && detail !== undefined ? '\n          ' + detail : ''));
}

/* Independent ZIP reader: Node's zlib over the central directory. Returns the
   entries in the archive's own order. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const body = buf.slice(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(body) : method === 0 ? body : null);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* An XML part's skeleton: its elements and attribute names in order, with
   every value and text blanked, and runs of identical lines folded to one -
   so two parts of the same shape compare equal whatever their numbers. */
function skeleton(xml) {
  const lines = xml.replace(/="[^"]*"/g, '=""').replace(/>([^<]*)</g, (m, t) => (t.trim() ? '><' : m))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.filter((l, i) => l !== lines[i - 1]).join('\n');
}

function jsonShape(v) {
  if (Array.isArray(v)) return v.length ? [jsonShape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map((k) => [k, jsonShape(v[k])]));
  return typeof v;
}

function box(name, ox, oy, w, d, h) {
  const c = [[ox, oy, 0], [ox + w, oy, 0], [ox + w, oy + d, 0], [ox, oy + d, 0],
             [ox, oy, h], [ox + w, oy, h], [ox + w, oy + d, h], [ox, oy + d, h]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const flat = [];
  faces.forEach((f) => f.forEach((vi) => flat.push(...c[vi])));
  const m = W.indexTriangleSoup(flat);
  return { name, vertices: m.vertices, triangles: m.triangles, flat };
}

/* A plate like the one the owner opens: a piece and its support (the
   Supports card's overrides on the support), and a second piece. */
function plate() {
  const piece = box('top_clip_x2', 70.25, 80.5, 20, 13.3, 14.65);
  const support = box('top_clip_x2 - support 1.1 (Tree)', 78, 81.3, 24.2, 17.4, 13.06);
  support.settings = Object.assign({}, SI.SHEET.slicerSettings);
  const other = box('lid', 20.123457, 30.987654, 31.5, 12.25, 3.2);
  return [piece, support, other];
}

const hex8 = (n) => ('0000000' + (n >>> 0).toString(16)).slice(-8);

(async function main() {
  const keepIdx = process.argv.indexOf('--keep');
  const outDir = keepIdx !== -1 && process.argv[keepIdx + 1]
    ? process.argv[keepIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bambu-'));
  fs.mkdirSync(outDir, { recursive: true });
  console.log('export:bambu - the Bambu Studio project envelope\noutput: ' + outDir);

  /* ---------- 1. the record ---------- */
  console.log('\n--- 1. the template and its record ---');
  const record = JSON.parse(fs.readFileSync(path.join(TPL_DIR, 'template.json'), 'utf8'));
  const tplBytes = fs.readFileSync(path.join(TPL_DIR, record.file));
  const T = readZip(tplBytes);
  const TAG = 'BambuStudio-' + record.studio_version;
  check('template.json records the printer, nozzle, Studio version and file',
    !!(record.printer && record.nozzle && /^\d+\.\d+\.\d+\.\d+$/.test(record.studio_version) && record.file),
    JSON.stringify(record));
  check('its sha256 is the template file\'s', crypto.createHash('sha256').update(tplBytes).digest('hex') === record.sha256);
  const tModel = T.get('3D/3dmodel.model').toString('utf8');
  const tSettings = JSON.parse(T.get('Metadata/project_settings.config').toString('utf8'));
  check('the template\'s own Application tag is the recorded version (' + TAG + ')',
    tModel.includes('<metadata name="Application">' + TAG + '</metadata>'));
  check('its project settings say the same version', tSettings.version === record.studio_version, tSettings.version);
  const tSlice = T.get('Metadata/slice_info.config').toString('utf8');
  check('its slice_info says the same version', tSlice.includes('value="' + record.studio_version + '"'));
  check('its printer is the recorded one', tSettings.printer_model === record.printer &&
    String(tSettings.printer_settings_id).includes(record.nozzle + ' nozzle'), tSettings.printer_model + ' / ' + tSettings.printer_settings_id);

  /* ---------- export ---------- */
  const objects = plate();
  const profileId = 'default';
  const values = Profiles.resolveValues(profileId);
  const opts = { objects, profileId, plateName: 'Bambu A1 Mini', date: '2026-10-21' };
  const built = await W.build3MF(opts);
  const again = await W.build3MF(Object.assign({}, opts, { objects: plate() }));
  const file = path.join(outDir, 'nso_bambu_project.3mf');
  fs.writeFileSync(file, Buffer.from(built.bytes));
  const E = readZip(Buffer.from(built.bytes));
  check('the export is the project envelope, from the template', built.envelope === 'project' && built.template === TPL_KEY,
    built.envelope + ' ' + (built.templateError || ''));
  check('two exports of the same plate are byte-identical', Buffer.from(built.bytes).equals(Buffer.from(again.bytes)));

  /* ---------- 2. the part list ---------- */
  console.log('\n--- 2. the part list ---');
  const objPart = (n) => '3D/Objects/object_' + n + '.model';
  const want = [];
  [...T.keys()].forEach((n) => {
    if (n.startsWith('3D/Objects/')) { if (!want.includes(objPart(1))) objects.forEach((o, i) => want.push(objPart(i + 1))); }
    else want.push(n);
  });
  want.push(W.PART_NSO_PROFILE);
  check('the template\'s parts in its order, an object part per piece, then NSO\'s provenance',
    JSON.stringify([...E.keys()]) === JSON.stringify(want), [...E.keys()].join(', '));
  const withScene = readZip(Buffer.from((await W.build3MF(Object.assign({}, opts, { sceneJson: '{"nso":1}' }))).bytes));
  check('a scene adds Metadata/nso_scene.json and nothing else',
    JSON.stringify([...withScene.keys()]) === JSON.stringify(want.concat([W.PART_NSO_SCENE])));
  const GENERATED = [W.PART_MODEL, W.PART_ROOT_RELS, W.PART_PROJECT_SETTINGS, W.PART_MODEL_SETTINGS,
                     W.PART_CUT_INFO, W.PART_PLATE_JSON];
  const verbatim = [...T.keys()].filter((n) => !n.startsWith('3D/Objects/') && !GENERATED.includes(n));
  check('the parts NSO does not write are the template\'s bytes (' + verbatim.join(', ') + ')',
    verbatim.length > 0 && verbatim.every((n) => E.get(n).equals(T.get(n))),
    verbatim.filter((n) => !E.get(n).equals(T.get(n))).join(', '));
  check('the thumbnails the plate block names are in the archive',
    [...T.get('Metadata/model_settings.config').toString('utf8').split('<plate>')[1].matchAll(/key="\w+_file" value="([^"]*)"/g)]
      .every((m) => E.has(m[1])));

  /* ---------- 3. 3dmodel.model and the object parts ---------- */
  console.log('\n--- 3. 3dmodel.model and the object parts ---');
  const model = E.get(W.PART_MODEL).toString('utf8');
  // The template has two objects; so does an export of two.
  const two = readZip(Buffer.from((await W.build3MF(Object.assign({}, opts, { objects: plate().slice(0, 2) }))).bytes));
  check('3dmodel.model has the template\'s skeleton (elements, attributes, metadata order)',
    skeleton(two.get(W.PART_MODEL).toString('utf8')) === skeleton(tModel),
    skeleton(two.get(W.PART_MODEL).toString('utf8')));
  check('3D/_rels/3dmodel.model.rels has the template\'s skeleton',
    skeleton(two.get(W.PART_ROOT_RELS).toString('utf8')) === skeleton(T.get(W.PART_ROOT_RELS).toString('utf8')));
  check('an object part has the template\'s skeleton',
    skeleton(two.get(objPart(2)).toString('utf8')) === skeleton(T.get(objPart(2)).toString('utf8')));
  check('the root element is the template\'s, xmlns:BambuStudio and requiredextensions="p" with it',
    model.split('\n')[1] === tModel.split('\n')[1], model.split('\n')[1]);
  check('Application is "' + TAG + '", 3mfVersion 1',
    model.includes('<metadata name="Application">' + TAG + '</metadata>') &&
    model.includes('<metadata name="BambuStudio:3mfVersion">1</metadata>'));
  check('the root model carries no mesh', !/<mesh|<vertex/.test(model));
  const rels = E.get(W.PART_ROOT_RELS).toString('utf8');
  check('one relationship per object part',
    JSON.stringify([...rels.matchAll(/Target="\/([^"]*)"/g)].map((m) => m[1])) === JSON.stringify(objects.map((o, i) => objPart(i + 1))));
  const S = W.UUID_SUFFIX;
  check('Studio\'s UUID suffixes are the template\'s',
    [S.object, S.component, S.buildItem].every((x) => tModel.includes(x)) &&
    T.get(objPart(1)).toString('utf8').includes(S.subObject));

  const items = [...model.matchAll(/<item objectid="(\d+)" p:UUID="([^"]*)" transform="([^"]*)" printable="1"\/>/g)];
  let shapeOk = true, centredOk = true, placedOk = true, uuidOk = true;
  const detail = [];
  objects.forEach((o, i) => {
    const n = i + 1;
    const objRe = new RegExp('<object id="' + 2 * n + '" p:UUID="' + hex8(n) + S.object + '" type="model">\\s*<components>\\s*' +
      '<component p:path="/' + objPart(n) + '" objectid="' + (2 * n - 1) + '" p:UUID="' + hex8(n << 16) + S.component +
      '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\\s*</components>\\s*</object>');
    if (!objRe.test(model)) { shapeOk = false; detail.push('object ' + n); }
    const it = items[i];
    if (!it || it[1] !== String(2 * n) || it[2] !== hex8(2 * n) + S.buildItem) { uuidOk = false; detail.push('item ' + n); return; }
    const part = E.get(objPart(n)).toString('utf8');
    if (!part.includes('<object id="' + (2 * n - 1) + '" p:UUID="' + hex8(n << 16) + S.subObject + '" type="model">')) { uuidOk = false; detail.push('sub-object ' + n); }
    const t = it[3].split(' ').map(Number);
    const vs = [...part.matchAll(/<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"\/>/g)].map((m) => m.slice(1).map(Number));
    for (let a = 0; a < 3; a++) {
      const lo = Math.min(...vs.map((v) => v[a])), hi = Math.max(...vs.map((v) => v[a]));
      if (Math.abs((lo + hi) / 2) > 1e-6) centredOk = false;
    }
    if (t.slice(0, 9).join(' ') !== '1 0 0 0 1 0 0 0 1') placedOk = false;
    vs.forEach((v, k) => { for (let a = 0; a < 3; a++) if (Math.abs(v[a] + t[9 + a] - o.vertices[3 * k + a]) > 1.5e-6) placedOk = false; });
    const tris = [...part.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap((m) => m.slice(1).map(Number));
    if (JSON.stringify(tris) !== JSON.stringify(o.triangles)) placedOk = false;
  });
  check('each piece is a wrapper object 2N whose one component is object 2N-1 in 3D/Objects/object_N.model', shapeOk, detail.join(', '));
  check('UUIDs: object N, component and sub-object N << 16, build item 2N, eight hex digits, Studio\'s suffixes', uuidOk, detail.join(', '));
  check('each mesh is centred on its own origin', centredOk);
  check('the build item places it: translation + vertex = the piece, triangles as given, printable="1"',
    placedOk && items.length === objects.length);

  /* ---------- 4. model_settings.config ---------- */
  console.log('\n--- 4. model_settings.config ---');
  const ms = E.get(W.PART_MODEL_SETTINGS).toString('utf8');
  const tMs = T.get(W.PART_MODEL_SETTINGS).toString('utf8');
  // The skeleton of an export without overrides (the template has none).
  const plain = plate().slice(0, 2);
  delete plain[1].settings;
  const twoPlain = readZip(Buffer.from((await W.build3MF(Object.assign({}, opts, { objects: plain }))).bytes));
  check('without overrides it has the template\'s skeleton: object, part, mesh_stat, plate, model_instance, assemble',
    skeleton(twoPlain.get(W.PART_MODEL_SETTINGS).toString('utf8')) === skeleton(tMs),
    skeleton(twoPlain.get(W.PART_MODEL_SETTINGS).toString('utf8')));
  const objBlock = (id) => (ms.match(new RegExp('<object id="' + id + '">([\\s\\S]*?)</object>')) || [])[1] || '';
  const own = (id) => [...objBlock(id).split('<part')[0].matchAll(/<metadata key="([^"]*)" value="([^"]*)"\/>/g)]
    .filter((m) => m[1] !== 'name').map((m) => m[1] + '=' + m[2]);
  let msOk = true;
  objects.forEach((o, i) => {
    const b = objBlock(2 * (i + 1)), faces = o.triangles.length / 3, t = items[i][3].split(' ').slice(9);
    const ok = b.includes('<metadata key="name" value="' + o.name.replace(/&/g, '&amp;') + '"/>') &&
      b.includes('<metadata face_count="' + faces + '"/>') &&
      (b.match(/<part /g) || []).length === 1 &&
      b.includes('<part id="' + (2 * i + 1) + '" subtype="normal_part"') &&
      b.includes('<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>') &&
      b.includes('<metadata key="source_object_id" value="' + i + '"/>') &&
      ['x', 'y', 'z'].every((a, k) => b.includes('<metadata key="source_offset_' + a + '" value="' + t[k] + '"/>')) &&
      b.includes('<mesh_stat face_count="' + faces + '" edges_fixed="0"');
    if (!ok) msOk = false;
  });
  check('each object: its name, face_count, one normal_part with matrix, source_* and mesh_stat', msOk);
  const supportKeys = Object.keys(Object.assign({ extruder: '1' }, SI.SHEET.slicerSettings)).sort()
    .map((k) => k + '=' + (k === 'extruder' ? '1' : SI.SHEET.slicerSettings[k]));
  check('the support object carries the support set on itself, in key order with its extruder (' +
        Object.keys(SI.SHEET.slicerSettings).join(', ') + ')',
    JSON.stringify(own(4)) === JSON.stringify(supportKeys), JSON.stringify(own(4)));
  check('the support set is wall_generator classic, detect_thin_wall 1, top and bottom shells 0',
    JSON.stringify(SI.SHEET.slicerSettings) === JSON.stringify({ wall_generator: 'classic', detect_thin_wall: '1', top_shell_layers: '0', bottom_shell_layers: '0' }));
  check('the pieces without overrides carry only their extruder',
    JSON.stringify(own(2)) === '["extruder=1"]' && JSON.stringify(own(6)) === '["extruder=1"]', JSON.stringify([own(2), own(6)]));
  const plateHead = (x) => (x.match(/<plate>([\s\S]*?)<model_instance>/) || [])[1];
  check('the plate block\'s metadata is the template\'s', plateHead(ms) === plateHead(tMs), plateHead(ms));
  const asm = [...ms.matchAll(/<assemble_item object_id="(\d+)" instance_id="0" transform="([^"]*)" offset="0 0 0" \/>/g)];
  check('<assemble> places each object where its build item does',
    asm.length === objects.length && asm.every((m, i) => m[1] === String(2 * (i + 1)) && m[2] === items[i][3]));
  check('cut_information.xml has one object per piece, in the template\'s shape',
    (E.get(W.PART_CUT_INFO).toString('utf8').match(/<cut_id id="0" check_sum="1" connectors_cnt="0"\/>/g) || []).length === objects.length &&
    skeleton(two.get(W.PART_CUT_INFO).toString('utf8')) === skeleton(T.get(W.PART_CUT_INFO).toString('utf8')));
  const pj = JSON.parse(E.get(W.PART_PLATE_JSON).toString('utf8'));
  const tPj = JSON.parse(T.get(W.PART_PLATE_JSON).toString('utf8'));
  check('plate_1.json has the template\'s fields, one bbox_objects entry per piece',
    JSON.stringify(Object.keys(pj)) === JSON.stringify(Object.keys(tPj)) &&
    JSON.stringify(jsonShape(pj.bbox_objects[0])) === JSON.stringify(jsonShape(tPj.bbox_objects[0])) &&
    pj.bbox_objects.length === objects.length && pj.bbox_objects.every((b, i) => b.name === objects[i].name && b.id === built.identifyIds[i]));
  check('its first-layer areas are the pieces\' footprints', pj.bbox_objects.map((b) => b.area).join() ===
    objects.map((o) => { const v = o.vertices, b = [0, 1].map((a) => { const xs = v.filter((x, k) => k % 3 === a); return Math.max(...xs) - Math.min(...xs); }); return +(b[0] * b[1]).toFixed(6); }).join(),
    pj.bbox_objects.map((b) => b.area).join());

  /* ---------- 5. project_settings.config ---------- */
  console.log('\n--- 5. project_settings.config ---');
  const psText = E.get(W.PART_PROJECT_SETTINGS).toString('utf8');
  const ps = JSON.parse(psText);
  check('the template\'s ' + Object.keys(tSettings).length + ' keys in its order',
    JSON.stringify(Object.keys(ps)) === JSON.stringify(Object.keys(tSettings)));
  const cool = Object.keys(values);
  check('14 cooling keys overlaid', cool.length === 14 && cool.every((k) => k in tSettings), cool.length);
  const others = Object.keys(tSettings).filter((k) => !cool.includes(k) && JSON.stringify(ps[k]) !== JSON.stringify(tSettings[k]));
  check('every other key is the template\'s value', others.length === 0, others.join(', '));
  check('version, printer_model and preset ids are the template\'s',
    ['version', 'printer_model', 'printer_settings_id', 'print_settings_id', 'filament_settings_id']
      .every((k) => JSON.stringify(ps[k]) === JSON.stringify(tSettings[k])));
  const badCool = cool.filter((k) => !(Array.isArray(ps[k]) && ps[k].length === tSettings[k].length && ps[k].every((v) => v === values[k])));
  check('NSO\'s value on every filament slot of each cooling key', badCool.length === 0, badCool.join(', '));
  const changed = cool.filter((k) => tSettings[k][0] !== values[k]);
  check('the overlay shows: ' + changed.map((k) => k + ' ' + tSettings[k][0] + ' -> ' + values[k]).join(', '),
    changed.length > 0);
  check('laid out as Studio writes it', psText === JSON.stringify(ps, null, 4) + '\n');

  /* ---------- 6. identify_id ---------- */
  console.log('\n--- 6. identify_id ---');
  const ids = (x) => [...x.matchAll(/<metadata key="identify_id" value="(\d+)"\/>/g)].map((m) => +m[1]);
  const idsA = ids(ms), idsB = ids(readZip(Buffer.from(again.bytes)).get(W.PART_MODEL_SETTINGS).toString('utf8'));
  check('every instance has an identify_id, after its object_id and instance_id',
    idsA.length === objects.length &&
    (ms.match(/<metadata key="object_id" value="\d+"\/>\s*<metadata key="instance_id" value="0"\/>\s*<metadata key="identify_id" value="\d+"\/>/g) || []).length === objects.length);
  check('positive, unique', idsA.every((x) => x > 0) && new Set(idsA).size === idsA.length, idsA.join());
  check('the same across two exports of the same plate (' + idsA.join(', ') + ')', JSON.stringify(idsA) === JSON.stringify(idsB));
  check('build3MF reports them', JSON.stringify(built.identifyIds) === JSON.stringify(idsA));
  const moved = plate(); moved.forEach((o) => { o.vertices = o.vertices.map((v, k) => (k % 3 === 0 ? v + 5 : v)); });
  check('a piece moved on the plate keeps its id', JSON.stringify(W.identifyIds(moved)) === JSON.stringify(idsA));
  const given = plate(); given[0].identifyId = 4242; given[2].identifyId = 4242;
  const gIds = W.identifyIds(given);
  check('an object\'s own identifyId is used; a collision steps to the next free id', gIds[0] === 4242 && gIds[2] === 4243, gIds.join());
  const twins = W.identifyIds([plate()[0], plate()[0]]);
  check('two copies of one piece get two ids', twins[0] !== twins[1], twins.join());

  /* ---------- 7. the version guard ---------- */
  console.log('\n--- 7. the version guard ---');
  check('the written Application tag is "BambuStudio-" + the fixture\'s recorded version (' + record.studio_version + ')',
    (model.match(/<metadata name="Application">([^<]*)<\/metadata>/) || [])[1] === TAG,
    (model.match(/<metadata name="Application">([^<]*)<\/metadata>/) || [])[1]);
  check('build3MF reports the version it wrote', built.studioVersion === record.studio_version);
  // A known-bad copy: the template file with a record one version on.
  const badKey = 'guard-check-' + process.pid;
  const badDir = path.join(ROOT, W.TEMPLATE_DIR, badKey);
  fs.mkdirSync(badDir, { recursive: true });
  try {
    fs.copyFileSync(path.join(TPL_DIR, record.file), path.join(badDir, record.file));
    fs.writeFileSync(path.join(badDir, 'template.json'), JSON.stringify(Object.assign({}, record, { studio_version: '02.09.00.01' })));
    let refused = null;
    try { await W.loadTemplate(badKey); } catch (e) { refused = e.message; }
    check('a template whose tag differs from its record is refused', !!refused && /02\.08\.02\.61/.test(refused) && /02\.09\.00\.01/.test(refused), refused);
    const fell = await W.build3MF(Object.assign({}, opts, { objects: plate(), template: badKey }));
    check('and the export falls back to the geometry-only envelope, saying why',
      fell.envelope === 'nso' && /unavailable/.test(fell.templateError || '') &&
      !readZip(Buffer.from(fell.bytes)).get(W.PART_MODEL).toString('utf8').includes('BambuStudio'), fell.templateError);
  } finally {
    fs.rmSync(badDir, { recursive: true, force: true });
  }
  check('the known-bad copy is gone', !fs.existsSync(badDir));

  /* ---------- 8. the geometry ---------- */
  console.log('\n--- 8. the geometry, read back ---');
  const back = await R.parse3MF(new Uint8Array(built.bytes), { name: 'nso_bambu_project.3mf' });
  check('nso-3mf-read.js reads one object per piece, named', back.objects.length === objects.length &&
    back.objects.every((o, i) => o.name === objects[i].name), back.objects.map((o) => o.name).join(', '));
  let worst = 0;
  back.objects.forEach((o, i) => { for (let k = 0; k < o.positions.length; k++) worst = Math.max(worst, Math.abs(o.positions[k] - objects[i].flat[k])); });
  check('every corner where it was, in order (within float32 of the input: ' + worst.toExponential(2) + ' mm)', worst < 2e-5);
  const legacy = readZip(Buffer.from((await W.build3MF(Object.assign({}, opts, { objects: plate(), envelope: 'nso' }))).bytes));
  const lv = [...legacy.get(W.PART_MODEL).toString('utf8').matchAll(/<object id="1"[\s\S]*?<\/object>/g)][0][0];
  const lvs = [...lv.matchAll(/<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"\/>/g)].map((m) => m.slice(1).map(Number));
  const t0 = items[0][3].split(' ').slice(9).map(Number);
  const pv = [...E.get(objPart(1)).toString('utf8').matchAll(/<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"\/>/g)].map((m) => m.slice(1).map(Number));
  check('a piece without overrides is the same geometry the geometry-only envelope writes (to the 6 dp written)',
    lvs.length === pv.length && lvs.every((v, k) => v.every((x, a) => Math.abs(x - (pv[k][a] + t0[a])) < 1.5e-6)));

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass) + '  (' + file + ')');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nexport:bambu crashed: ' + (err && err.stack || err));
  process.exit(1);
});

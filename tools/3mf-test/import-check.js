#!/usr/bin/env node
/*
 * 3MF import check - nso-3mf-read.js against real files and its own output.
 *
 *   node tools/3mf-test/import-check.js
 *   NSO_3MF_REAL=/path/to/some.3mf node tools/3mf-test/import-check.js
 *
 * Four legs, no browser, no network:
 *
 *   1. Round trip through NSO's own writer: STL fixture -> nso-3mf.js ->
 *      nso-3mf-read.js. Triangle-for-triangle equality with the source, same
 *      bounding box, and the canonical watertight checker
 *      (tools/stl_watertight_check.py --odd --degen) gives the same verdict
 *      before and after.
 *   2. Files Bambu Studio wrote (fixtures/3mf/, see its README): object count,
 *      names, triangle counts and sizes are asserted against numbers pulled
 *      out of the raw XML with third-party `unzip`, not against the reader.
 *   3. NSO_3MF_REAL, when set: any Bambu project. Names and face counts are
 *      checked against Metadata/model_settings.config, again via `unzip`.
 *   4. Synthetic archives built with nso-3mf.js's own ZIP writer for the cases
 *      no fixture covers: inch units, a mirroring transform, nested components
 *      across parts, no rels, no build, type="other", and rejects.
 *
 * Exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'nso-3mf-read.js'));
const W = require(path.join(ROOT, 'nso-3mf.js'));
const { readSTL, writeSTL } = require(path.join(ROOT, 'tools', 'nso_stl_io.js'));

const checks = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, ok });
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${name}` +
    (ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
}
function section(t) { console.log(`\n--- ${t} ---`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-3mf-import-'));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bbox(p) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k] < mn[k]) mn[k] = p[i + k];
    if (p[i + k] > mx[k]) mx[k] = p[i + k];
  }
  return { min: mn, max: mx, size: mx.map((v, i) => v - mn[i]) };
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const r3a = (a) => a.map(r3);

/** Signed volume of a closed soup: positive when wound outward. */
function signedVolume(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** The canonical checker. Returns 'clean' or its failure text. */
function watertight(soup, label) {
  const f = path.join(tmp, label.replace(/[^\w.-]+/g, '_') + '.stl');
  writeSTL(f, soup instanceof Float32Array ? soup : Float32Array.from(soup), 'nso import-check');
  const r = spawnSync('python3', [path.join(ROOT, 'tools', 'stl_watertight_check.py'), f, '--odd', '--degen'],
    { encoding: 'utf8' });
  if (r.error) return 'checker did not run: ' + r.error.message;
  return r.status === 0 ? 'clean' : (r.stdout + r.stderr).trim().split('\n').slice(-1)[0];
}

function unzipText(file, part) {
  return execFileSync('unzip', ['-p', file, part], { encoding: 'utf8', maxBuffer: 1 << 28 });
}
function countTag(xml, tag) { return (xml.match(new RegExp('<' + tag + '[\\s/>]', 'g')) || []).length; }

function parseFile(file) {
  return R.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: path.basename(file) });
}

const utf8 = (s) => new TextEncoder().encode(s);
const MODEL_HEAD = (unit) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="' + unit + '" xml:lang="en-US" ' +
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
  'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n';
const CUBE_MESH = (s) => {
  // unit cube [0,s]^3, outward wound
  const V = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const T = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return '<mesh><vertices>' + V.map(v => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('') +
    '</vertices><triangles>' + T.map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('') +
    '</triangles></mesh>';
};
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

function archive(entries) {
  return W.buildZip(Object.keys(entries).map(name => ({ name, data: utf8(entries[name]) })));
}

// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  section('1. round trip through NSO\'s own writer');
  const RT = [
    ['fixtures/box-20mm.stl', 'box-20mm'],
    ['library/box_hull_80x40x20.stl', 'box_hull_80x40x20'],
    ['library/hinge_knuckle_box.stl', 'hinge_knuckle_box'],
    ['fixtures/fixture_sphere_curved.stl', 'fixture_sphere_curved'],
  ];
  for (const [rel, name] of RT) {
    const src = readSTL(path.join(ROOT, rel));
    const before = watertight(src, name + '-before');
    const idx = W.indexTriangleSoup(Array.from(src));
    const built = await W.build3MF({ objects: [{ name, vertices: idx.vertices, triangles: idx.triangles }] });
    const got = await R.parse3MF(built.bytes, { name: name + '.3mf' });
    const obj = got.objects[0];
    check(`${name}: one object back, named from the file`, [got.objects.length, obj.name], [1, name]);
    check(`${name}: triangle count survives (${idx.triangles.length / 3})`,
      obj.triangleCount, idx.triangles.length / 3);
    // Exporter writes 6 dp; the reader gives float32 back. Compare per corner.
    let maxErr = 0;
    const flatSrc = [];
    for (let t = 0; t < idx.triangles.length; t++) {
      const vi = idx.triangles[t] * 3;
      flatSrc.push(idx.vertices[vi], idx.vertices[vi + 1], idx.vertices[vi + 2]);
    }
    for (let i = 0; i < flatSrc.length; i++) maxErr = Math.max(maxErr, Math.abs(flatSrc[i] - obj.positions[i]));
    check(`${name}: every corner within 1e-4 mm of the source, same order`, maxErr < 1e-4, true);
    check(`${name}: bounding box unchanged`, r3a(bbox(obj.positions).size), r3a(bbox(src).size));
    const after = watertight(obj.positions, name + '-after');
    check(`${name}: canonical watertight verdict unchanged (${before})`, after, before);
    check(`${name}: still wound outward (positive volume)`, signedVolume(obj.positions) > 0, true);
  }

  // =========================================================================
  section('2. files Bambu Studio wrote (fixtures/3mf)');
  {
    const f = path.join(ROOT, 'fixtures/3mf/pa_pattern.3mf');
    const got = await parseFile(f);
    const partXml = unzipText(f, '3D/Objects/Cube_1.model');
    const settings = unzipText(f, 'Metadata/model_settings.config');
    check('pa_pattern: warnings', got.warnings, []);
    check('pa_pattern: one build item -> one object', got.objects.length, 1);
    check('pa_pattern: named from model_settings.config',
      got.objects[0].name, /key="name" value="([^"]*)"/.exec(settings)[1]);
    check('pa_pattern: triangle count matches the raw object part',
      got.objects[0].triangleCount, countTag(partXml, 'triangle'));
    // Item transform is a non-uniform scale of an 18 mm cube: 0.2777.. x 0.2777.. x 0.04722..
    check('pa_pattern: non-uniform item scale applied (18 mm cube -> 5 x 5 x 0.85)',
      r3a(bbox(got.objects[0].positions).size), [5, 5, 0.85]);
    check('pa_pattern: sits on the bed', Math.abs(bbox(got.objects[0].positions).min[2]) < 1e-6, true);
    check('pa_pattern: canonical watertight', watertight(got.objects[0].positions, 'pa_pattern'), 'clean');
    check('pa_pattern: wound outward', signedVolume(got.objects[0].positions) > 0, true);
  }
  {
    const f = path.join(ROOT, 'fixtures/3mf/flowrate-test-pass2.3mf');
    const got = await parseFile(f);
    const xml = unzipText(f, '3D/3dmodel.model');
    const rawNames = [...xml.matchAll(/<object [^>]*name="([^"]*)"/g)].map(m => m[1]);
    check('flowrate: warnings', got.warnings, []);
    check('flowrate: ZIP64 markers handled, ten inline objects', got.objects.length, 10);
    check('flowrate: names from <object name>', got.objects.map(o => o.name), rawNames);
    check('flowrate: total triangles match the raw XML',
      got.objects.reduce((n, o) => n + o.triangleCount, 0), countTag(xml, 'triangle'));
    check('flowrate: every object is 40 x 30 x 1.4 mm',
      got.objects.map(o => r3a(bbox(o.positions).size)), got.objects.map(() => [40, 30, 1.4]));
    check('flowrate: items without a transform attribute stay put (distinct placements)',
      new Set(got.objects.map(o => bbox(o.positions).min.slice(0, 2).join(','))).size, 10);
    const verdicts = got.objects.map(o => watertight(o.positions, 'flowrate-' + o.name));
    check('flowrate: canonical watertight, all ten', verdicts, got.objects.map(() => 'clean'));
  }

  // =========================================================================
  if (process.env.NSO_3MF_REAL) {
    const f = process.env.NSO_3MF_REAL;
    section('3. NSO_3MF_REAL: ' + path.basename(f));
    const got = await parseFile(f);
    const settings = unzipText(f, 'Metadata/model_settings.config');
    const expected = [...settings.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"\/>(?:[^]*?)<metadata face_count="(\d+)"/g)]
      .map(m => ({ id: m[1], name: m[2], faces: +m[3] }));
    check('real: application recorded', /BambuStudio|OrcaSlicer|PrusaSlicer/.test(got.application), true);
    check('real: one object per model_settings object', got.objects.length, expected.length);
    check('real: names match model_settings.config', got.objects.map(o => o.name), expected.map(e => e.name));
    check('real: triangle counts match face_count', got.objects.map(o => o.triangleCount), expected.map(e => e.faces));
    check('real: every object rests on the bed (min z ~ 0)',
      got.objects.map(o => Math.abs(bbox(o.positions).min[2]) < 0.01), expected.map(() => true));
    check('real: every object inside a 256 mm plate',
      got.objects.map(o => { const b = bbox(o.positions); return b.min[0] >= 0 && b.min[1] >= 0 && b.max[0] <= 256 && b.max[1] <= 256; }),
      expected.map(() => true));
    check('real: canonical watertight', got.objects.map(o => watertight(o.positions, 'real-' + o.name)), expected.map(() => 'clean'));
    check('real: wound outward after the item rotations', got.objects.map(o => signedVolume(o.positions) > 0), expected.map(() => true));
    for (const o of got.objects) {
      const b = bbox(o.positions);
      console.log(`       ${o.name}: ${o.triangleCount} tris, ${r3a(b.size).join(' x ')} mm at (${r3(b.min[0])}, ${r3(b.min[1])})`);
    }
  } else {
    section('3. NSO_3MF_REAL not set - skipped');
  }

  // =========================================================================
  section('4. synthetic archives');
  {
    const bytes = await archive({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': MODEL_HEAD('inch') + '<resources><object id="1" type="model">' + CUBE_MESH(1) +
        '</object></resources><build><item objectid="1"/></build></model>',
    });
    const got = await R.parse3MF(bytes, { name: 'inch.3mf' });
    check('inch unit: 1 in cube arrives as 25.4 mm', r3a(bbox(got.objects[0].positions).size), [25.4, 25.4, 25.4]);
    check('inch unit: no name anywhere -> file name', got.objects[0].name, 'inch');
  }
  {
    const bytes = await archive({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': MODEL_HEAD('millimeter') + '<resources><object id="1" type="model">' + CUBE_MESH(10) +
        '</object></resources><build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 30 0 0"/></build></model>',
    });
    const got = await R.parse3MF(bytes, { name: 'mirror.3mf' });
    check('mirror: reflected cube lands at x = 20..30', r3a([bbox(got.objects[0].positions).min[0], bbox(got.objects[0].positions).max[0]]), [20, 30]);
    check('mirror: winding flipped back outward (positive volume)', r3(signedVolume(got.objects[0].positions)), 1000);
    check('mirror: still watertight', watertight(got.objects[0].positions, 'mirror'), 'clean');
  }
  {
    // item T1 (translate 100,0,0) applied after component T2 (rotate 90 about Z, translate 0,5,0)
    // v=(x,y,z) -> C: (x*0 + y*(-1) + 0, x*1 + y*0 + 5, z) -> I: (+100)
    const bytes = await archive({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': MODEL_HEAD('millimeter') +
        '<resources><object id="2" type="model"><components>' +
        '<component p:path="/3D/Objects/part.model" objectid="7" transform="0 1 0 -1 0 0 0 0 1 0 5 0"/>' +
        '</components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build></model>',
      '3D/Objects/part.model': MODEL_HEAD('millimeter') + '<resources><object id="7" name="inner" type="model">' + CUBE_MESH(10) +
        '</object></resources><build/></model>',
    });
    const got = await R.parse3MF(bytes, { name: 'nested.3mf' });
    const b = bbox(got.objects[0].positions);
    check('nested p:path: mesh found in the other part, named from it', [got.objects.length, got.objects[0].name], [1, 'inner']);
    check('nested p:path: component then item transform compose (x 90..100, y 5..15)',
      [r3a([b.min[0], b.max[0]]), r3a([b.min[1], b.max[1]])], [[90, 100], [5, 15]]);
    check('nested p:path: rotation keeps it outward', signedVolume(got.objects[0].positions) > 0, true);
  }
  {
    const bytes = await archive({
      '3D/3dmodel.model': MODEL_HEAD('millimeter') + '<resources><object id="1" type="model">' + CUBE_MESH(2) +
        '</object><object id="2" type="other">' + CUBE_MESH(3) + '</object></resources></model>',
    });
    const got = await R.parse3MF(bytes, { name: 'norels.3mf' });
    check('no rels, no build: falls back to 3D/3dmodel.model and imports the model-type object',
      [got.objects.length, r3a(bbox(got.objects[0].positions).size)], [1, [2, 2, 2]]);
    check('no build: says so', got.warnings.some(w => /No <build>/.test(w)), true);
  }
  {
    const bytes = await archive({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': MODEL_HEAD('millimeter') + '<resources><object id="1" type="model">' + CUBE_MESH(2) +
        '</object><object id="2" type="other">' + CUBE_MESH(3) + '</object>' +
        '<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object>' +
        '</resources><build><item objectid="3"/></build></model>',
    });
    const got = await R.parse3MF(bytes, { name: 'other.3mf' });
    check('type="other" component (Bambu modifier) is skipped with a warning',
      [got.objects[0].triangleCount, got.warnings], [12, ['Object 2 is type "other"; skipped']]);
  }
  // stored vs deflated: buildZip stores tiny entries and deflates larger ones,
  // so the synthetic files above exercise method 0 and the fixtures method 8.
  {
    const rejects = async (label, bytes, re) => {
      let msg = 'no error';
      try { await R.parse3MF(bytes, { name: label }); } catch (e) { msg = e.message; }
      check(`rejects ${label}: ${re}`, re.test(msg), true);
    };
    await rejects('random bytes', utf8('solid not a zip at all\n'), /Not a ZIP/);
    await rejects('a ZIP with no model part', await archive({ 'hello.txt': 'hi' }), /Missing part/);
    await rejects('a triangle index past the vertex list',
      await archive({ '3D/3dmodel.model': MODEL_HEAD('millimeter') +
        '<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices>' +
        '<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>' }),
      /out of range/);
    await rejects('an unknown unit',
      await archive({ '3D/3dmodel.model': MODEL_HEAD('furlong') + '<resources/><build/></model>' }), /Unknown 3MF unit/);
    await rejects('a build item pointing at a missing object',
      await archive({ '3D/3dmodel.model': MODEL_HEAD('millimeter') + '<resources/><build><item objectid="9"/></build></model>' }),
      /not found/);
  }

  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed;
}

main().then(f => process.exit(f ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });

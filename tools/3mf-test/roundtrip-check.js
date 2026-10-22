#!/usr/bin/env node
/*
 * Round-trip validation for the baked cooling settings.
 *
 *   node tools/validate-3mf.js [--keep <dir>]
 *
 * Exports a .3mf through the exact same modules the browser app uses, then
 * reads the archive back with an independent ZIP reader (Node zlib, no reuse of
 * the writer's own bookkeeping) and asserts that every cooling key survived:
 *
 *   - the template's key set and order, NSO's keys on every filament slot
 *   - a string per slot, laid out as Bambu Studio writes the file
 *   - byte-exact value, including presence / absence of '%'
 *
 * Also shells out to `unzip -t` when available, so a third-party reader
 * confirms the archive is structurally sound, and re-checks the raw file text
 * so a JSON parser cannot mask a formatting slip.
 *
 * Exits non-zero on any mismatch.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const Profiles = require('../../nso-cooling-profiles.js');
const NSO3MF = require('../../nso-3mf.js');

// ---------------------------------------------------------------------------
// Independent ZIP reader: walk the end-of-central-directory, not the writer's
// in-memory entry list.
// ---------------------------------------------------------------------------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record: not a ZIP');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('bad central directory header at entry ' + n);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const crc = buf.readUInt32LE(ptr + 16);
    const compSize = buf.readUInt32LE(ptr + 20);
    const rawSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(name + ': bad local file header');
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = body;
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(name + ': unsupported compression method ' + method);

    if (data.length !== rawSize) {
      throw new Error(name + ': uncompressed size ' + data.length + ' != declared ' + rawSize);
    }
    const actualCrc = NSO3MF.crc32(new Uint8Array(data));
    if (actualCrc !== crc) {
      throw new Error(name + ': CRC mismatch (stored ' + crc + ', actual ' + actualCrc + ')');
    }

    files.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------
// A small test plate: two boxes, so the model part has real geometry.
// ---------------------------------------------------------------------------
function box(name, ox, oy, w, d, h) {
  const c = [
    [ox, oy, 0], [ox + w, oy, 0], [ox + w, oy + d, 0], [ox, oy + d, 0],
    [ox, oy, h], [ox + w, oy, h], [ox + w, oy + d, h], [ox, oy + d, h]
  ];
  const faces = [
    [0,1,2],[0,2,3], [4,6,5],[4,7,6], [0,4,5],[0,5,1],
    [1,5,6],[1,6,2], [2,6,7],[2,7,3], [3,7,4],[3,4,0]
  ];
  const flat = [];
  faces.forEach(f => f.forEach(vi => flat.push(c[vi][0], c[vi][1], c[vi][2])));
  const mesh = NSO3MF.indexTriangleSoup(flat);
  return { name, vertices: mesh.vertices, triangles: mesh.triangles };
}

// ---------------------------------------------------------------------------
const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log('  [' + mark + '] ' + label + (detail && !ok ? '\n         ' + detail : ''));
}

async function validateProfile(profileId, outDir) {
  console.log('\nProfile: ' + profileId);

  const objects = [box('cube_a', 10, 10, 20, 20, 15), box('cube_b', 40, 10, 20, 20, 15)];
  const built = await NSO3MF.build3MF({ objects, profileId, plateName: 'Bambu A1 Mini' });

  const file = path.join(outDir, 'nso_roundtrip_' + profileId + '.3mf');
  fs.writeFileSync(file, Buffer.from(built.bytes));

  // --- third-party structural check ------------------------------------
  try {
    execFileSync('unzip', ['-tqq', file], { stdio: 'pipe' });
    check('archive passes `unzip -t`', true);
  } catch (err) {
    if (err.code === 'ENOENT') console.log('  [SKIP] `unzip` not installed');
    else check('archive passes `unzip -t`', false, String(err.stderr || err.message).trim());
  }

  // --- re-open and read the parts back ---------------------------------
  const files = readZip(fs.readFileSync(file));

  for (const part of ['[Content_Types].xml', '_rels/.rels', NSO3MF.PART_MODEL, NSO3MF.PART_ROOT_RELS,
                      NSO3MF.PART_PROJECT_SETTINGS, NSO3MF.PART_MODEL_SETTINGS]) {
    check('part present: ' + part, files.has(part));
  }

  const text = files.get(NSO3MF.PART_PROJECT_SETTINGS).toString('utf8');
  const expected = Profiles.resolveValues(profileId);
  const tpl = await NSO3MF.loadTemplate();
  check('written as the Bambu project envelope', built.envelope === 'project', built.envelope + ' ' + (built.templateError || ''));

  // --- shape: the template's file, each cooling key on every filament slot -
  // Studio's project_settings.config holds one string per filament slot for
  // filament keys (the template has two); NSO's value goes on every slot.
  let raw = null, parsed = null;
  try {
    raw = JSON.parse(text);
    parsed = {};
    for (const key of Object.keys(expected)) {
      const v = raw[key];
      if (!Array.isArray(v) || !v.length) throw new Error(key + ': expected a per-slot array, got ' + JSON.stringify(v));
      if (v.length !== tpl.settings[key].length) throw new Error(key + ': ' + v.length + ' slots, template has ' + tpl.settings[key].length);
      if (v.some((x) => typeof x !== 'string' || x !== v[0])) throw new Error(key + ': slots differ or are not strings: ' + JSON.stringify(v));
      parsed[key] = v[0];
    }
    check('every cooling key is a string on each of the template\'s filament slots', true);
  } catch (err) {
    check('every cooling key is a string on each of the template\'s filament slots', false, err.message);
    return;
  }

  // --- key set and order: the template's, nothing added, nothing lost ----
  const gotKeys = Object.keys(raw);
  const wantKeys = Object.keys(tpl.settings);
  check('the template\'s key set and order preserved (' + wantKeys.length + ' keys)',
    gotKeys.length === wantKeys.length && gotKeys.every((k, i) => k === wantKeys[i]),
    gotKeys.length + ' keys read');
  const coolKeys = Object.keys(expected);
  // different_settings_to_system names the keys NSO changed; export:bambu gates it.
  const otherDiff = wantKeys.filter((k) => !coolKeys.includes(k) && k !== 'different_settings_to_system' &&
    JSON.stringify(raw[k]) !== JSON.stringify(tpl.settings[k]));
  check('every key NSO does not own is the template\'s value', otherDiff.length === 0, otherDiff.join(', '));

  // --- value-by-value, byte exact --------------------------------------
  let allValuesOk = true;
  for (const key of coolKeys) {
    if (parsed[key] !== expected[key]) {
      allValuesOk = false;
      check('value ' + key, false,
        'wrote "' + expected[key] + '", read back "' + parsed[key] + '"');
    }
  }
  if (allValuesOk) check('all ' + coolKeys.length + ' cooling values byte-exact after round trip', true);

  // --- the '%' rule, checked against the format contract ---------------
  let pctOk = true;
  const pctDetail = [];
  for (const key of coolKeys) {
    const fmt = Profiles.KEY_FORMATS[key];
    const hasPct = parsed[key].indexOf('%') !== -1;
    const shouldHavePct = fmt.type === 'percent';
    if (hasPct !== shouldHavePct) {
      pctOk = false;
      pctDetail.push(key + ': ' + (hasPct ? 'has an unexpected "%"' : 'is missing its "%"'));
    }
  }
  check('"%" present on percent fields, absent on numeric fields', pctOk, pctDetail.join('\n         '));

  // --- raw text check: a JSON parser can normalise, plain text cannot ---
  let rawOk = true;
  const rawDetail = [];
  for (const key of coolKeys) {
    const slot = '        ' + JSON.stringify(expected[key]);
    const want = '    ' + JSON.stringify(key) + ': [\n' + raw[key].map(() => slot).join(',\n') + '\n    ]';
    if (text.indexOf(want) === -1) {
      rawOk = false;
      rawDetail.push('not found verbatim: ' + JSON.stringify(key));
    }
  }
  check('raw file text carries each cooling key verbatim, one line per slot, as Studio writes it', rawOk, rawDetail.join('\n         '));
  check('the file is laid out exactly as Studio writes it (4-space JSON)',
    text === JSON.stringify(raw, null, 4) + '\n');

  // --- geometry survived ------------------------------------------------
  const model = files.get(NSO3MF.PART_MODEL).toString('utf8');
  const objParts = [...files.keys()].filter((n) => n.startsWith('3D/Objects/'));
  const objXml = objParts.map((n) => files.get(n).toString('utf8')).join('\n');
  const vCount = (objXml.match(/<vertex /g) || []).length;
  const tCount = (objXml.match(/<triangle /g) || []).length;
  const iCount = (model.match(/<item /g) || []).length;
  check('object parts carry the geometry (' + vCount + ' vertices, ' + tCount +
        ' triangles in ' + objParts.length + ' parts, ' + iCount + ' build items)',
    vCount === 16 && tCount === 24 && iCount === 2 && objParts.length === 2);
  check('the root model carries no mesh', !/<mesh>/.test(model));

  // --- per-object identity ---------------------------------------------
  // A project names its objects in model_settings.config and keeps them apart
  // by Studio's own counter UUIDs. See docs/BAMBU-PROJECT-EXPORT.md.
  const settingsXml = files.get(NSO3MF.PART_MODEL_SETTINGS).toString('utf8');
  check('the production extension is declared',
    model.includes('xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'));
  check('each object carries its own name in model_settings.config',
    [...settingsXml.matchAll(/<object id="\d+">\s*<metadata key="name" value="([^"]*)"/g)].map((m) => m[1]).join(),
    objects.map((o) => o.name).join());
  const uuids = [...(model + objXml).matchAll(/p:UUID="([^"]*)"/g)].map((m) => m[1]);
  check('object, component, sub-object, build and item all carry a UUID (' + uuids.length + ' of them)',
    uuids.length === objects.length * 4 + 1, uuids.length);
  const SUFFIXES = Object.values(NSO3MF.UUID_SUFFIX);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check('every UUID is Studio\'s counter form or (the build) a well-formed v4',
    uuids.every((u) => SUFFIXES.some((x) => u.endsWith(x) && /^[0-9a-f]{8}$/.test(u.slice(0, 8))) || UUID_RE.test(u)),
    uuids.join(' '));
  check('no two UUIDs collide', new Set(uuids).size === uuids.length);

  console.log('  wrote ' + file + ' (' + built.bytes.length + ' bytes)');
}

(async function main() {
  const keepIdx = process.argv.indexOf('--keep');
  const outDir = keepIdx !== -1 && process.argv[keepIdx + 1]
    ? process.argv[keepIdx + 1]
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nso-3mf-'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log('NSO baked cooling settings - round-trip validation');
  console.log('output: ' + outDir);

  for (const p of Profiles.listProfiles()) {
    await validateProfile(p.id, outDir);
  }

  // Determinism: the same plate + profile must produce identical bytes.
  const objs = [box('cube_a', 10, 10, 20, 20, 15)];
  const a = await NSO3MF.build3MF({ objects: objs, profileId: 'default' });
  const b = await NSO3MF.build3MF({ objects: objs, profileId: 'default' });
  console.log('\nDeterminism:');
  check('same input produces byte-identical archives',
    Buffer.from(a.bytes).equals(Buffer.from(b.bytes)));

  // The format contract must actually reject bad values.
  console.log('\nFormat guard:');
  check('rejects a percent field that lost its "%"',
    Profiles.validateValues(
      Object.assign({}, Profiles.DEFAULT_VALUES, { overhang_fan_threshold: '50' })).length > 0);
  check('rejects a numeric field that gained a "%"',
    Profiles.validateValues(
      Object.assign({}, Profiles.DEFAULT_VALUES, { fan_max_speed: '80%' })).length > 0);
  check('rejects an unknown cooling key',
    Profiles.validateValues(
      Object.assign({}, Profiles.DEFAULT_VALUES, { made_up_key: '1' })).length > 0);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) {
    console.error('FAILED:\n  - ' + failed.map(f => f.label).join('\n  - '));
    process.exit(1);
  }
  console.log('Round trip clean.');
})().catch(err => {
  console.error('\nvalidation crashed: ' + (err && err.stack || err));
  process.exit(1);
});

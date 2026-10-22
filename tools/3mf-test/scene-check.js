#!/usr/bin/env node
/*
 * NSO scene block check - nso-3mf-scene.js, the writer and the reader together.
 *
 *   node tools/3mf-test/scene-check.js
 *
 * No browser: this is the module-level half of the scene round trip, and it
 * pins the parts the app cannot be trusted to prove about itself.
 *
 *   1. THE CHAIN. NSO3MFScene.poseBasis() claims to describe the transform
 *      buildPlacedObjects3MF() bakes. Here the SAME pose is baked through
 *      THREE, exactly the way app-core.js does it, and every vertex is
 *      compared against the matrix. If either side drifts this fails rather
 *      than silently shifting a restored plate.
 *   2. THE INVERSE. Pushing the baked geometry back through invert12() has to
 *      land on the model-space geometry it came from, to float tolerance.
 *   3. THE ARCHIVE. The block lands at Metadata/nso_scene.json, is found by a
 *      third-party ZIP reader (Node zlib, not the writer's bookkeeping), and
 *      the archive stays byte-identical across two builds of the same plate.
 *   4. NO SCENE, NO PART. An export without a scene has exactly the six parts
 *      it had before this feature existed - nothing new appears in a file the
 *      caller did not ask for.
 *   5. EVERY FIELD. Capture -> serialize -> archive -> read -> parse, then
 *      value by value: pose, lock, seat gap, skin, both paint lists, the
 *      non-solid flag, the plate and its lock.
 *   6. REJECTS. Malformed, truncated, foreign and future-schema blocks each
 *      raise rather than half-restore.
 *   7. FOREIGN FILES. The Bambu Studio fixtures still import as geometry with
 *      sceneJson === null - no block, no error, no assumption one exists.
 *
 * Exits non-zero on any failure.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
// three r147, located the way tools/nso_fuse_three.js does it - the browser
// app gets it from a CDN, so node needs to be pointed at a build.
const THREE = require(path.join(__dirname, '..', 'nso_fuse_three.js'));
const W = require(path.join(ROOT, 'nso-3mf.js'));
const R = require(path.join(ROOT, 'nso-3mf-read.js'));
const S = require(path.join(ROOT, 'nso-3mf-scene.js'));

let fails = 0;
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function section(t) { console.log('\n--- ' + t + ' ---'); }
function raises(name, fn, re) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  check(name, msg !== null && (!re || re.test(msg)), msg === null ? 'did not throw' : msg);
}

/* Float32 coordinates up to |128| have a ULP of 1.5e-5, and the geometry makes
   a round trip through Float32BufferAttribute on the way out. 5e-5 is the same
   tolerance tools/nso_export_roundtrip_test.js uses, well above that noise and
   far below anything a slicer can act on. */
const TOL = 5e-5;

// ---------------------------------------------------------------------------
// Independent ZIP reader - Node zlib, not the writer's entry list
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
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory entry ' + n);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const rawSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + compSize);
    const data = method === 0 ? body : zlib.inflateRawSync(body);
    if (data.length !== rawSize) throw new Error(name + ': size ' + data.length + ' != ' + rawSize);
    files.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------
// A model-space box, and the export chain as app-core.js writes it
// ---------------------------------------------------------------------------
function boxGeometry(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  return g.index ? g.toNonIndexed() : g;
}

/* buildPlacedObjects3MF()'s body, verbatim in its transform order. This is the
   comparison target: if app-core.js changes the order, this stops matching
   poseBasis() and the suite says so. */
function posedGeometry(geometry, p) {
  const geo = geometry.clone();
  const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
  const flip = p.flipX ? Math.PI : 0;
  const rotY = p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0);
  const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
  if (roll) geo.rotateZ(roll);
  if (rotY) geo.rotateY(rotY);
  if (tip || flip) geo.rotateX(tip + flip);
  geo.computeBoundingBox();
  return geo;
}

/* How far the posed geometry's lowest point is under its origin: what the
   exporter lifts by (nsoPoseBelow in app-core.js) and poseBasis() takes as
   `below`. Half the height only when the posed box is centred on the origin. */
function belowOf(geometry, p) { return -posedGeometry(geometry, p).boundingBox.min.y; }

function bakeLikeExport(geometry, p, plate) {
  const geo = posedGeometry(geometry, p);
  geo.translate(p.x, -geo.boundingBox.min.y + (p.liftY || 0), p.z);
  const pos = geo.attributes.position;
  const flat = [];
  for (let v = 0; v < pos.count; v++) {
    flat.push(pos.getX(v) + plate.w / 2, -pos.getZ(v) + plate.d / 2, pos.getY(v));
  }
  return flat;
}

/* The re-anchoring app-core.js's pieceBasis3MF() does: express the basis
   against the geometry's own centre, so inverting it lands on what addModel
   hands back rather than on an off-centre copy of it. */
function centredBasis(geometry, p, plate) {
  const M = S.poseBasis(p, plate);
  const bb = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const c = new THREE.Vector3();
  bb.getCenter(c);
  const t = S.apply12(M, c.x, c.y, c.z);
  return M.slice(0, 9).concat([t[0], t[1], t[2]]);
}

function centredCopy(geometry) {
  const g = geometry.clone();
  g.center();
  return g.attributes.position.array;
}

function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let w = 0;
  for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i]));
  return w;
}

const PLATE = { id: 'a1mini', name: 'Bambu A1 Mini', w: 180, d: 180, locked: true };

/* Four poses, nothing at the origin and nothing axis-aligned by accident: a
   plain yaw, a tip with a bank, a flip with a roll, and the legacy `rotated`
   flag with rotY absent - the one case where poseBasis has to fall back. */
const PIECES = [
  { name: 'hull', geo: boxGeometry(24, 18, 16),
    pose: { x: 23.5, z: -17.25, rotY: 0.7, liftY: 3.37, height: 18 } },
  { name: 'bit', geo: boxGeometry(12, 9, 30),
    pose: { x: -31, z: 12.5, tiltX: 15, tiltZ: -42.5, liftY: 0.18, height: 9 } },
  { name: 'clip', geo: boxGeometry(8, 22, 8),
    pose: { x: 4.25, z: 44, flipX: true, tipZ: 1, tipX: 3, liftY: 0, height: 22 } },
  { name: 'legacy', geo: boxGeometry(30, 6, 14),
    pose: { x: -12, z: -40.5, rotY: null, rotated: true, liftY: 1.5, height: 6 } },
];
/* A piece whose posed box is NOT centred on its origin - a baked turn, a
   pyramid banked over: half the height is not how far its lowest point is
   under the origin, and the exporter lifts by the lowest point. Kept out of
   PIECES, whose order and count the later sections index by. */
const PYRAMID = { name: 'pyramid', geo: (() => { const g = new THREE.ConeGeometry(10, 16, 4); return g.index ? g.toNonIndexed() : g; })(),
  pose: { x: 9.5, z: 21, tiltX: 27, tiltZ: -19, rotY: 0.4, liftY: 2.5, height: 21 } };
// the figure the app records (pieceBasis3MF -> nsoPoseBelow); a box's posed along an axis agrees with height / 2
PIECES.concat([PYRAMID]).forEach(pc => { pc.pose.below = belowOf(pc.geo, pc.pose); });

// ---------------------------------------------------------------------------
section('the chain: poseBasis vs the THREE bake app-core.js runs');
// ---------------------------------------------------------------------------
PIECES.concat([PYRAMID]).forEach(pc => {
  const baked = bakeLikeExport(pc.geo, pc.pose, PLATE);
  const M = S.poseBasis(pc.pose, PLATE);
  const src = pc.geo.attributes.position.array;
  const viaMatrix = [];
  for (let i = 0; i < src.length; i += 3) {
    const q = S.apply12(M, src[i], src[i + 1], src[i + 2]);
    viaMatrix.push(q[0], q[1], q[2]);
  }
  const d = maxDiff(baked, viaMatrix);
  check(pc.name + ': poseBasis reproduces the baked geometry', d <= TOL, 'max ' + d.toExponential(2) + ' mm');
});
{
  const pc = PYRAMID, box = PIECES.find(q => q.name === 'hull');
  const noBelow = Object.assign({}, pc.pose); delete noBelow.below;
  check('pyramid: its posed box is not centred (below is not height / 2)', Math.abs(pc.pose.below - pc.pose.height / 2) > 0.5,
        pc.pose.below.toFixed(3) + ' vs ' + (pc.pose.height / 2));
  check('pyramid: without `below` poseBasis falls back to height / 2 and is out by the difference',
        Math.abs(S.poseBasis(noBelow, PLATE)[11] - S.poseBasis(pc.pose, PLATE)[11]) > 0.5);
  const noBelowBox = Object.assign({}, box.pose); delete noBelowBox.below;
  check('hull: a box turned about its own up axis - the legacy basis (no `below`) is unchanged', Math.abs(S.poseBasis(noBelowBox, PLATE)[11] - S.poseBasis(box.pose, PLATE)[11]) <= TOL);
}

// ---------------------------------------------------------------------------
section('the inverse: baked geometry back to model space');
// ---------------------------------------------------------------------------
PIECES.concat([PYRAMID]).forEach(pc => {
  const baked = Float32Array.from(bakeLikeExport(pc.geo, pc.pose, PLATE));
  const basis = centredBasis(pc.geo, pc.pose, PLATE);
  const back = S.transformSoup(S.invert12(basis), baked);
  const d = maxDiff(centredCopy(pc.geo), back);
  check(pc.name + ': inverse basis recovers the centred model geometry',
        d <= TOL, 'max ' + d.toExponential(2) + ' mm');
});

raises('a singular basis is refused, not inverted',
       () => S.invert12([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]), /not invertible/);

// ---------------------------------------------------------------------------
section('capture -> archive -> read -> parse');
// ---------------------------------------------------------------------------

/* Every state type the scene block claims to carry, on four pieces: a locked
   one, a seated pair at a named gap, a skinned one, and painted faces in both
   lists. Nothing here is a default. */
const SEAT = {
  gap: -0.18, kind: 'support', partnerName: 'hull', partnerIndex: 0,
  measured: -0.179, residual: 0.04, reference: 'tips'
};
const SKIN = {
  pattern: 'crosshatch', scope: 'wrap', mode: 'relief',
  faces: ['+Z', '-Z'], layer2: { pattern: 'zigzag', free: true },
  params: { pitch: 1.2, rib: 0.42, tall: 0.6 }
};
const PAINT_EXCLUDE = [
  { n: [0, 0, 1], d: 9, axisIdx: 2, keepMin: false, dispAxis: 1, dispSign: 1, dispPlane: 9, inner: false },
  { n: [-1, 0, 0], d: -12, axisIdx: 0, keepMin: true, dispAxis: 0, dispSign: -1, dispPlane: -12, inner: false }
];
const PAINT_SELECT = [
  { n: [0, 1, 0], d: 3.25, axisIdx: 1, keepMin: false, dispAxis: 2, dispSign: -1, dispPlane: 3.25, inner: true }
];
const CENTER_OFFSET = { x: 1.5, y: -2.25, z: 0.75 };

const captured = S.capture({
  scope: 'plate',
  plate: PLATE,
  selection: { placedIndex: 2, editId: 7 },
  pieces: PIECES.map((pc, i) => ({
    name: pc.name,
    sourceId: i + 5,
    basis: centredBasis(pc.geo, pc.pose, PLATE),
    centerOffset: i === 1 ? CENTER_OFFSET : null,
    pose: Object.assign({
      yaw: 0, flipX: false, tipX: 0, tipZ: 0, tiltX: 0, tiltZ: 0,
      rotated: false, overflow: false, liftY: 0,
      width: 10, depth: 10
    }, pc.pose, { rotY: pc.pose.rotY == null ? (pc.pose.rotated ? Math.PI / 2 : 0) : pc.pose.rotY }),
    locked: i === 0,
    seat: i === 1 ? SEAT : null,
    skin: i === 2 ? SKIN : null,
    paint: i === 3 ? { exclude: PAINT_EXCLUDE, select: PAINT_SELECT } : null,
    nonSolid: i === 2
  }))
});
const sceneJson = S.serialize(captured);

const objects = PIECES.map((pc, i) => {
  const flat = bakeLikeExport(pc.geo, pc.pose, PLATE);
  const mesh = W.indexTriangleSoup(flat);
  return { name: pc.name, vertices: mesh.vertices, triangles: mesh.triangles };
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scene-'));

(async function run() {
  const withScene = await W.build3MF({ objects, profileId: 'default', plateName: PLATE.name, sceneJson });
  const bare = await W.build3MF({ objects, profileId: 'default', plateName: PLATE.name });
  const again = await W.build3MF({ objects, profileId: 'default', plateName: PLATE.name, sceneJson });

  const file = path.join(tmp, 'scene.3mf');
  fs.writeFileSync(file, Buffer.from(withScene.bytes));

  // ---- the archive ----
  const parts = readZip(Buffer.from(withScene.bytes));
  check('Metadata/nso_scene.json is in the archive', parts.has(W.PART_NSO_SCENE),
        Array.from(parts.keys()).join(', '));
  eq('the part holds exactly what was serialized',
     parts.get(W.PART_NSO_SCENE).toString('utf8'), sceneJson);
  check('build3MF reports it wrote a scene', withScene.scene === true);
  check('two builds of the same plate are byte-identical',
        Buffer.from(withScene.bytes).equals(Buffer.from(again.bytes)));

  const bareParts = Array.from(readZip(Buffer.from(bare.bytes)).keys()).sort();
  // The project envelope's parts are export:bambu's to gate; here, the scene
  // block is the only part a scene adds.
  eq('no scene given, no part added', bareParts,
     Array.from(parts.keys()).filter((n) => n !== W.PART_NSO_SCENE).sort());
  check('the bare export is the project envelope', bare.envelope === 'project', bare.envelope);
  check('build3MF reports no scene on a bare export', bare.scene === false);
  check('the cooling settings are untouched by the scene block',
        withScene.settingsText === bare.settingsText);

  // ---- read it back ----
  const read = await R.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: 'scene.3mf' });
  check('the reader surfaces the raw block', typeof read.sceneJson === 'string');
  eq('verbatim, byte for byte', read.sceneJson, sceneJson);
  eq('geometry still imports as one object per piece', read.objects.length, PIECES.length);

  const scene = S.parse(read.sceneJson);

  section('every field, value by value');
  eq('schema', scene.schema, S.SCHEMA);
  eq('scope', scene.scope, 'plate');
  eq('plate id', scene.plate.id, PLATE.id);
  eq('plate name', scene.plate.name, PLATE.name);
  eq('plate size', [scene.plate.w, scene.plate.d], [PLATE.w, PLATE.d]);
  eq('plate lock', scene.plate.locked, true);
  eq('selection', [scene.selection.placedIndex, scene.selection.editId], [2, 7]);
  eq('object count', scene.objects.length, PIECES.length);

  PIECES.forEach((pc, i) => {
    const o = scene.objects[i];
    const want = captured[S.ROOT_KEY].objects[i];
    eq(pc.name + ': name', o.name, pc.name);
    eq(pc.name + ': object_id', o.objectId, String(i + 1));
    eq(pc.name + ': source id', o.sourceId, i + 5);
    eq(pc.name + ': basis survives exactly', o.basis, want.basis);
    eq(pc.name + ': position', [o.pose.x, o.pose.z, o.pose.liftY],
       [want.position.x, want.position.z, want.position.lift_y]);
    eq(pc.name + ': pose', [o.pose.rotY, o.pose.flipX, o.pose.tipX, o.pose.tipZ,
                            o.pose.tiltX, o.pose.tiltZ, o.pose.rotated],
       [want.pose.rot_y, want.pose.flip_x, want.pose.tip_x, want.pose.tip_z,
        want.pose.tilt_x, want.pose.tilt_z, want.pose.rotated]);

    // and the basis still inverts to the model after the archive round trip
    const baked = Float32Array.from(bakeLikeExport(pc.geo, pc.pose, PLATE));
    const back = S.transformSoup(o.inverse, baked);
    const d = maxDiff(centredCopy(pc.geo), back);
    check(pc.name + ': parsed basis still recovers the model', d <= TOL, 'max ' + d.toExponential(2));
  });

  eq('locked piece is the locked one, and only it',
     scene.objects.map(o => o.locked), [true, false, false, false]);
  eq('seat: only the seated piece has one',
     scene.objects.map(o => !!o.seat), [false, true, false, false]);
  eq('seat: the gap comes back exactly, sign and all', scene.objects[1].seat.gap, SEAT.gap);
  eq('seat: partner, kind, reference and measurements',
     [scene.objects[1].seat.kind, scene.objects[1].seat.partnerName,
      scene.objects[1].seat.partnerIndex, scene.objects[1].seat.measured,
      scene.objects[1].seat.residual, scene.objects[1].seat.reference],
     [SEAT.kind, SEAT.partnerName, SEAT.partnerIndex, SEAT.measured, SEAT.residual, SEAT.reference]);
  eq('center offset rides with the piece that had one',
     scene.objects.map(o => o.centerOffset), [null, CENTER_OFFSET, null, null]);

  eq('skin: only the skinned piece has one',
     scene.objects.map(o => !!o.skin), [false, false, true, false]);
  eq('skin: pattern, scope, mode and faces',
     [scene.objects[2].skin.pattern, scene.objects[2].skin.scope,
      scene.objects[2].skin.mode, scene.objects[2].skin.faces],
     [SKIN.pattern, SKIN.scope, SKIN.mode, SKIN.faces]);
  eq('skin: layer 2 and its free flag', scene.objects[2].skin.layer2, SKIN.layer2);
  eq('skin: parameters', scene.objects[2].skin.params, SKIN.params);

  eq('non-solid flag', scene.objects.map(o => o.nonSolid), [false, false, true, false]);

  eq('paint: excluded list, field for field', scene.objects[3].paint.exclude, PAINT_EXCLUDE);
  eq('paint: selected list, field for field', scene.objects[3].paint.select, PAINT_SELECT);
  eq('paint: the unpainted pieces have empty lists, not missing ones',
     scene.objects.slice(0, 3).map(o => [o.paint.exclude.length, o.paint.select.length]),
     [[0, 0], [0, 0], [0, 0]]);

  // ---------------------------------------------------------------------
  section('rejects - a block that cannot be trusted is refused whole');
  // ---------------------------------------------------------------------
  raises('not JSON', () => S.parse('{ nope'), /not valid JSON/);
  raises('no nso_scene section', () => S.parse('{"something_else":{}}'), /no "nso_scene"/);
  raises('unknown schema', () => S.parse('{"nso_scene":{"schema":"other/1","objects":[]}}'), /unknown schema/);
  raises('a newer schema is refused, not guessed at',
         () => S.parse('{"nso_scene":{"schema":"nso.scene/99","objects":[]}}'), /newer NSO/);
  raises('objects must be an array',
         () => S.parse('{"nso_scene":{"schema":"nso.scene/1","objects":{}}}'), /objects is not an array/);
  raises('a short basis',
         () => S.parse(JSON.stringify({ nso_scene: { schema: 'nso.scene/1', objects: [{ basis: [1, 0, 0] }] } })),
         /must be 12 numbers/);
  raises('a non-numeric basis',
         () => S.parse(JSON.stringify({ nso_scene: { schema: 'nso.scene/1', objects: [{ basis: ['a', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }] } })),
         /not a finite number/);
  raises('a paint entry with no normal',
         () => S.parse(JSON.stringify({ nso_scene: { schema: 'nso.scene/1', objects: [{
           basis: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
           position: { x: 0, z: 0 },
           paint: { excluded: [{ d: 3 }] } }] } })),
         /must be 3 numbers/);
  raises('an object with no position at all',
         () => S.parse(JSON.stringify({ nso_scene: { schema: 'nso.scene/1', objects: [{
           basis: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }] } })),
         /position\.x is not a finite number/);
  // truncation is the realistic corruption: a file cut short mid-write
  raises('a truncated block', () => S.parse(sceneJson.slice(0, sceneJson.length >> 1)), /not valid JSON/);

  // ---------------------------------------------------------------------
  section('foreign files - no block, no error, no assumption');
  // ---------------------------------------------------------------------
  const fixtures = ['pa_pattern.3mf', 'flowrate-test-pass2.3mf'];
  for (const f of fixtures) {
    const p = path.join(ROOT, 'fixtures', '3mf', f);
    const res = await R.parse3MF(new Uint8Array(fs.readFileSync(p)), { name: f });
    check(f + ': imports', res.objects.length > 0, res.objects.length + ' object(s)');
    eq(f + ': sceneJson is null, not undefined and not {}', res.sceneJson, null);
    eq(f + ': no warning invented about a part it does not have',
       res.warnings.filter(w => /nso_scene/.test(w)), []);
  }

  // A file that HAS the part but with rubbish in it: the reader must still
  // hand back geometry, and the block must be the parser's problem, not the
  // import's.
  const poisoned = await W.build3MF({
    objects, profileId: 'default', plateName: PLATE.name, sceneJson: 'not json at all\n'
  });
  const pres = await R.parse3MF(poisoned.bytes, { name: 'poisoned.3mf' });
  eq('a corrupt block does not stop the geometry', pres.objects.length, PIECES.length);
  raises('and the parser is the one that refuses it', () => S.parse(pres.sceneJson), /not valid JSON/);

  console.log('\n' + (fails ? fails + ' FAILED' : 'all scene checks passed'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('scene-check crashed:', e); process.exit(1); });

#!/usr/bin/env node
// The canonical checker (tools/mesh_validate.py) on Mirror's outputs, plus the
// exact end-identity comparison on the meshes that checker just read.
//
//   node tools/nso_mirror_canonical_check.js      exit 0 = every gate held
//
// tools/nso_mirror_test.js writes tools/mirror-out/ and is run first, so the
// files under test are always produced by the shipped code.
//
// WHAT IS ASSERTED
//
//   slotted_joined.stl     the cut-band → Mirror → Align → Join solid.
//                          --gate must pass: watertight, consistent winding,
//                          no piercing. Then every triangle on one side of the
//                          cut, reflected back by Mirror, is bit-identical to
//                          the triangles on the other side. Same count, no
//                          straddle, nothing left on the plane.
//   v8_half.stl            the low half of the v8_FINAL tape, cut at the
//   v8_mirror.stl          detected-axis midpoint. There is no clean band, so
//                          the cut is not a gate-clean solid and Join refuses
//                          it (see the unit test). The checker is asked to
//                          show the twin is that half with X negated: same
//                          verdict list, same triangle count, same volume,
//                          Y and Z unchanged. Defects the cut already had are
//                          not charged to the mirror.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'mirror-out');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/mirror-out/ from the shipped code ==');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_mirror_test.js')], { stdio: 'inherit' });

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['app-sculpt.js', 'app-extend.js', 'app-mirror.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { readSTL } = require('./nso_stl_io.js');

function validate(file, gate) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), path.join(OUT, file), '--json'];
  if (gate) args.push('--gate');
  try {
    const out = execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { report: JSON.parse(out), code: 0 };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    let report = null;
    try { report = JSON.parse(stdout); } catch (e) { report = { parseError: stdout.slice(0, 400) }; }
    return { report, code: err.status == null ? 1 : err.status };
  }
}

function endIdentity(soup, axisIdx, plane) {
  const minTris = [], maxTris = [];
  let on = 0, straddle = 0;
  const n = soup.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    let mn = Infinity, mx = -Infinity;
    for (let v = 0; v < 3; v++) {
      const c = soup[o + v * 3 + axisIdx];
      if (c < mn) mn = c;
      if (c > mx) mx = c;
    }
    const tri = soup.slice(o, o + 9);
    if (mn === plane && mx === plane) { on++; continue; }
    if (mn < plane && mx > plane) { straddle++; continue; }
    if (mx <= plane) minTris.push(tri);
    else maxTris.push(tri);
  }
  function soupFrom(tris) {
    const out = new Float32Array(tris.length * 9);
    for (let i = 0; i < tris.length; i++) out.set(tris[i], i * 9);
    return out;
  }
  const back = ctx.NSO_mirrorRaw(soupFrom(maxTris), { axis: axisIdx, plane: plane });
  function bag(s) {
    const m = new Map();
    for (let t = 0; t < s.length / 9; t++) {
      const key = Array.from(s.subarray(t * 9, t * 9 + 9)).join(',');
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  }
  const a = bag(soupFrom(minTris));
  const b = back.ok ? bag(back.tris) : new Map();
  let same = back.ok && a.size === b.size;
  if (same) for (const [k, v] of a) if (b.get(k) !== v) { same = false; break; }
  return { same, on, straddle, min: minTris.length, max: maxTris.length };
}

console.log('\n== slotted block: joined solid, canonical gate, then exact ends ==');
{
  const g = validate('slotted_joined.stl', true);
  const r = g.report;
  console.log('   verdict ' + (r && r.verdict) +
    (r && r.verdict_fails && r.verdict_fails.length ? '  [' + r.verdict_fails.join('; ') + ']' : '') +
    (r ? '   tris ' + r.triangles + '  vol ' + r.signed_volume : ''));
  check('canonical checker --gate passes the joined piece', g.code === 0 && r && r.verdict === 'PASS',
    r && r.verdict_fails ? r.verdict_fails.join('; ') : '');
  check('signed volume is positive', r && r.signed_volume > 0, r && String(r.signed_volume));
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'slotted_joined.json'), 'utf8'));
  const soup = readSTL(path.join(OUT, 'slotted_joined.stl'));
  const ends = endIdentity(soup, meta.axisIdx, meta.plane);
  check('the two ends, re-read from the STL the checker scored, are exact mirrors',
    ends.same && ends.on === 0 && ends.straddle === 0 && ends.min === ends.max && ends.min > 0,
    'min ' + ends.min + ' max ' + ends.max + ' on ' + ends.on + ' straddle ' + ends.straddle);
}

console.log('\n== v8_FINAL: the twin against the half, in the checker\'s own numbers ==');
{
  const half = validate('v8_half.stl', true);
  const twin = validate('v8_mirror.stl', true);
  const h = half.report, t = twin.report;
  console.log('   half  ' + (h && h.verdict) + '  tris ' + (h && h.triangles) +
    '  bbox ' + (h && h.bbox_size.map(x => x.toFixed(3)).join(' x ')));
  console.log('   twin  ' + (t && t.verdict) + '  tris ' + (t && t.triangles) +
    '  bbox ' + (t && t.bbox_size.map(x => x.toFixed(3)).join(' x ')));
  if (h && h.verdict_fails && h.verdict_fails.length) console.log('   half fails: ' + h.verdict_fails.join('; '));
  if (t && t.verdict_fails && t.verdict_fails.length) console.log('   twin fails: ' + t.verdict_fails.join('; '));
  /* The midpoint cut goes through features — there is no clean band — so the
     half is not a gate-clean solid. What the mirror must do is copy that
     verdict exactly, not improve it and not make it worse. */
  const sameVerdict = h && t && JSON.stringify(h.verdict_fails) === JSON.stringify(t.verdict_fails);
  check('the mirror\'s canonical verdict matches the half\'s, defect for defect',
    sameVerdict,
    (h && h.verdict_fails ? h.verdict_fails.join('; ') : '') +
    '  ||  ' + (t && t.verdict_fails ? t.verdict_fails.join('; ') : ''));
  check('triangle count matches', h && t && h.triangles === t.triangles, (h && h.triangles) + ' vs ' + (t && t.triangles));
  check('checker bbox X is exactly negated',
    h && t && t.bbox_min[0] === -h.bbox_max[0] && t.bbox_max[0] === -h.bbox_min[0],
    (h && (h.bbox_min[0] + '..' + h.bbox_max[0])) + '  →  ' + (t && (t.bbox_min[0] + '..' + t.bbox_max[0])));
  check('checker bbox Y is unchanged', h && t && t.bbox_min[1] === h.bbox_min[1] && t.bbox_max[1] === h.bbox_max[1]);
  check('checker bbox Z is unchanged', h && t && t.bbox_min[2] === h.bbox_min[2] && t.bbox_max[2] === h.bbox_max[2]);
  check('checker signed volume matches and stays positive',
    h && t && h.signed_volume > 0 && t.signed_volume === h.signed_volume,
    (h && h.signed_volume) + ' vs ' + (t && t.signed_volume));
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'v8_joined.json'), 'utf8'));
  check('the unit test recorded an exact round-trip and a refused join',
    meta.exactMirror === true && meta.cleanBand === false && /too coarse/.test(meta.joinRefused || ''));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/* tools/nso_damage.js has to be as trustworthy as anything it is used to test.
 * This holds it to the canonical checker, tools/mesh_validate.py, and to
 * numbers known by hand:
 *
 *   1. REFUSES   a dirty input is refused, not damaged further and reported as
 *                the tool's own work.
 *   2. LITERAL   on the 12-triangle cube, each damage type's signature is
 *                small enough to state by hand - and the checker agrees.
 *   3. EXACT     every type x every severity x two sources: the checker
 *                reports EXACTLY the prediction - triangles, welded vertices,
 *                open / non-manifold / odd / winding edges, Euler, degenerate,
 *                piercing - and the damage is the class it says it is and
 *                no other.
 *   4. WELD      a distance sweep across the weld radius: the collision reads
 *                non-manifold at or under 1e-4 and clean over it, flipping
 *                exactly where the checker's own comparison says.
 *   5. SEVER     the ring severed is the cutClearance() case: the finished
 *                mesh passes the checker AND the wall-thickness check; only
 *                genus and body count move, and cutClearance() on the clean
 *                piece refuses the same slot.
 *   6. SEVERITY  more severity is more damage, and the same call is the same
 *                bytes.
 *   7. FIXTURES  every committed file in fixtures/damage/ still reads as its
 *                manifest says, and the Library rows (served from
 *                nest-library) are those files.
 *
 * Run: node tools/nso_damage_test.js */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('./nso_damage.js');
const G = require('./nso_damage_make_fixtures.js');
const T = require('../nso_thickness.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ROOT = path.resolve(__dirname, '..');
const MV = path.join(__dirname, 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-damage-test-'));
const quick = f => readSTL(path.join(ROOT, 'fixtures', 'quick', f));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}

let nTmp = 0;
function measure(soup) {
  const f = path.join(TMP, 'm' + (nTmp++) + '.stl');
  writeSTL(f, soup, 'nso_damage_test');
  const r = JSON.parse(execFileSync('python3', [MV, f, '--json'], { maxBuffer: 1 << 28 }).toString());
  fs.unlinkSync(f);
  return r;
}
function measureFile(f) {
  return JSON.parse(execFileSync('python3', [MV, f, '--json'], { maxBuffer: 1 << 28 }).toString());
}
function diffs(expected, got) {
  return Object.keys(expected).filter(k => expected[k] !== got[k])
    .map(k => k + ' predicted ' + expected[k] + ', checker ' + got[k]);
}
function throws(fn) { try { fn(); return null; } catch (e) { return e.message; } }

(async function main() {
  const CUBE = quick('cube-12mm.stl');
  const SPHERE = quick('shape-sphere.stl');
  const TORUS = quick('shape-torus.stl');
  const TUBE = quick('shape-tube.stl');

  /* ================================================================ 1 */
  console.log('\n== 1. a dirty input is refused, with the reason ==');
  {
    for (const [name, soup] of [['cube-12mm', CUBE], ['shape-sphere', SPHERE], ['shape-torus', TORUS], ['shape-tube', TUBE]]) {
      const m = measure(soup);
      check(name + ' is clean by the checker and accepted as a source',
            m.verdict === 'PASS' && !throws(() => D.base(soup)), m.verdict);
    }
    const holed = D.hole(CUBE, { region: { faces: [0] } }).soup;
    const e1 = throws(() => D.hole(holed, { region: { faces: [5] } }));
    check('damage on damage is refused - the second defect would be reported on top of the first',
          e1 && /3 open edges/.test(e1), e1);
    const e2 = throws(() => D.base(readSTL(path.join(ROOT, 'fixtures', 'repair', 'synth_near_dup_vertex.stl'))));
    check('a mesh whose exact identity and the 1e-4 weld disagree is refused',
          e2 && /open edges|inside 2x the weld radius/.test(e2), e2);
    const e3 = throws(() => D.base(readSTL(path.join(ROOT, 'fixtures', 'open', 'open_clip.stl'))));
    check('an open-by-design sheet is not "known clean" for this tool', e3 && /50 open edges/.test(e3), e3);
    check('an unknown severity name is an error, not a default',
          /unknown severity/.test(throws(() => D.hole(SPHERE, { severity: 'mild' })) || ''));
    check('a region that selects every face is an error',
          /every face/.test(throws(() => D.hole(CUBE, { region: { range: [0, 12] } })) || ''));
  }

  /* ================================================================ 2 */
  console.log('\n== 2. on the 12-triangle cube the signature is stated by hand ==');
  {
    const cases = [
      // name, result, hand-stated signature
      ['one face removed: its 3 edges open, 8 vertices kept, chi 2 -> 1',
       D.hole(CUBE, { region: { faces: [0] } }),
       { triangles: 11, welded_vertices: 8, open_edges: 3, nonmanifold_edges: 0, inconsistent_winding_edges: 0, euler_characteristic: 1 }],
      ['faces 0..1 removed by index range: their 4 outer edges open, the diagonal gone',
       D.hole(CUBE, { region: { range: [0, 2] } }),
       null],
      ['one face duplicated in place: its 3 edges each walked 3 times, 3 directed edges twice',
       D.nonManifold(CUBE, { mode: 'duplicate', region: { faces: [0] } }),
       { triangles: 13, welded_vertices: 8, open_edges: 0, nonmanifold_edges: 3, inconsistent_winding_edges: 3 }],
      ['one face duplicated reversed: 3 non-manifold edges, 3 winding clashes (synth_dup_reversed)',
       D.nonManifold(CUBE, { mode: 'duplicate-flipped', region: { faces: [0] } }),
       { triangles: 13, welded_vertices: 8, open_edges: 0, nonmanifold_edges: 3, inconsistent_winding_edges: 3 }],
      ['one face flipped: still closed and manifold, its 3 edges now wound against their neighbours',
       D.nonManifold(CUBE, { mode: 'flip', region: { faces: [0] } }),
       { triangles: 12, welded_vertices: 8, open_edges: 0, nonmanifold_edges: 0, inconsistent_winding_edges: 3, euler_characteristic: 2 }],
      ['one weld collision: 2 faces split to 4, the collapsed vertex makes 2 edges 4-way',
       D.weld(CUBE, { sites: 1, distance: 5e-5 }),
       { triangles: 14, welded_vertices: 8, open_edges: 0, nonmanifold_edges: 2 }],
    ];
    for (const [name, r, hand] of cases) {
      const m = measure(r.soup);
      const got = D.measuredFrom(m);
      const dd = diffs(r.expected, got);
      const handBad = hand ? Object.keys(hand).filter(k => hand[k] !== got[k]).map(k => k + ' by hand ' + hand[k] + ', checker ' + got[k]) : [];
      check(name, dd.length === 0 && handBad.length === 0, dd.concat(handBad).join('; ') ||
            'open ' + got.open_edges + ', nm ' + got.nonmanifold_edges + ', winding ' + got.inconsistent_winding_edges);
    }
    // the range case, by hand: a cube side is two triangles sharing a diagonal
    const r = D.hole(CUBE, { region: { range: [0, 2] } });
    const m = measure(r.soup);
    const sameSide = m.open_edges === 4;
    check('...faces 0 and 1 of cube-12mm are one side, so the range leaves a 4-edge square hole',
          sameSide, m.open_edges + ' open edges');
  }

  /* ================================================================ 3 */
  console.log('\n== 3. every type, every severity: the checker reads exactly the prediction ==');
  const perLevel = {};
  {
    const LEVELS = Object.keys(D.LEVELS);
    const runs = [];
    for (const lv of LEVELS) {
      runs.push(['hole', 'shape-sphere', SPHERE, { severity: lv, seed: 7 }]);
      runs.push(['hole', 'shape-torus', TORUS, { severity: lv, seed: 7 }]);
      for (const mode of D.NM_MODES) runs.push(['nonManifold', 'shape-sphere', SPHERE, { mode, severity: lv, seed: 7 }]);
      runs.push(['weld', 'shape-torus', TORUS, { severity: lv, seed: 7 }]);
      runs.push(['weld', 'shape-sphere', SPHERE, { severity: lv, seed: 7 }]);
      runs.push(['sever', 'shape-tube', TUBE, { severity: lv }]);
    }
    // the region forms, beyond severity-driven spheres
    runs.push(['hole', 'shape-sphere', SPHERE, { region: { sphere: { center: [0, 0, 9.644155], radius: 2 } } }]);
    runs.push(['hole', 'shape-torus', TORUS, { region: { range: [500, 620] } }]);
    runs.push(['hole', 'shape-torus', TORUS, { region: [{ faces: [3, 4, 5] }, { range: [1000, 1010] }] }]);
    runs.push(['nonManifold', 'shape-torus', TORUS, { mode: 'duplicate', region: { range: [0, 64] } }]);
    runs.push(['sever', 'shape-torus', TORUS, { slots: 3, width: 2, phase: 7 }]);
    runs.push(['sever', 'shape-sphere', SPHERE, { slots: 2, width: 0.5, axis: 'x' }]);

    for (const [type, src, soup, opts] of runs) {
      const r = await D.apply(type, soup, opts);
      const m = measure(r.soup);
      const got = D.measuredFrom(m);
      const dd = diffs(r.expected, got);
      const label = type + (r.mode ? '/' + r.mode : '') + ' on ' + src + ' ' + JSON.stringify(opts);
      check(label, dd.length === 0, dd.join('; ') ||
            'open ' + got.open_edges + ' nm ' + got.nonmanifold_edges + ' wind ' + got.inconsistent_winding_edges +
            ' chi ' + got.euler_characteristic);

      // ...and it is the class of damage asked for, and nothing else
      const clean = got.degenerate_tris === 0 && got.piercing === 0;
      let klass;
      if (type === 'hole') klass = got.open_edges > 0 && got.nonmanifold_edges === 0 && got.inconsistent_winding_edges === 0 && clean;
      else if (type === 'nonManifold' && r.mode === 'flip') klass = got.open_edges === 0 && got.nonmanifold_edges === 0 && got.inconsistent_winding_edges > 0 && clean;
      else if (type === 'nonManifold') klass = got.open_edges === 0 && got.nonmanifold_edges > 0 && clean &&
                                                got.welded_vertices === r.expected.welded_vertices && got.triangles > soup.length / 9;
      else if (type === 'weld') klass = got.open_edges === 0 && got.nonmanifold_edges === 2 * r.sites.length && clean &&
                                        r.sites.every(s => s.merges);
      else if (type === 'sever') klass = m.verdict === 'PASS' && got.euler_characteristic !== measure(soup).euler_characteristic;
      check('  ...and it is ' + type + ' damage only', klass,
            type === 'weld' ? r.sites.length + ' sites, nm ' + got.nonmanifold_edges : null);
      if (opts.severity != null && src === (type === 'sever' ? 'shape-tube' : type === 'weld' ? 'shape-torus' : 'shape-sphere')) {
        const key = type + (r.mode ? '/' + r.mode : '');
        (perLevel[key] = perLevel[key] || []).push({ lv: opts.severity, r, got });
      }
    }
  }

  /* ================================================================ 4 */
  console.log('\n== 4. the weld collision flips exactly at the weld radius ==');
  {
    const tol = D.WELD_TOL;
    for (const f of [0.01, 0.5, 0.9, 0.999, 1.0, 1.001, 1.1, 2, 10]) {
      const r = D.weld(TORUS, { sites: 4, distance: f * tol, seed: 3 });
      const m = measure(r.soup);
      const got = D.measuredFrom(m);
      const dd = diffs(r.expected, got);
      const merges = r.sites.filter(s => s.merges).length;
      const agree = r.sites.every(s => s.merges === (s.realized_distance <= tol));
      // float32 can move the point, but only by rounding: under a ulp at the coordinate's size
      const drift = Math.max(...r.sites.map(s => Math.abs(s.realized_distance - f * tol)));
      check('distance ' + f + ' x 1e-4: prediction = checker, ' + merges + '/4 collide',
            dd.length === 0 && agree && drift < 2e-6, dd.join('; ') ||
            'nm ' + got.nonmanifold_edges + ', welded ' + got.welded_vertices + ', worst float32 drift ' + drift.toExponential(2));
      if (f <= 0.9) check('  ...well under the radius every site collides: nm = 2 per site, open 0',
                          merges === 4 && got.nonmanifold_edges === 8 && got.open_edges === 0);
      if (f >= 1.1) check('  ...well over it the mesh is CLEAN - the control: every split vertex its own',
                          merges === 0 && m.verdict === 'PASS' && got.welded_vertices === 1024 + 4);
    }
  }

  /* ================================================================ 5 */
  console.log('\n== 5. sever: the cutClearance case, severed and otherwise valid ==');
  {
    const cleanWall = T.measureMesh(TUBE, { nozzle: 0.4 });
    for (let slots = 1; slots <= 4; slots++) {
      const r = await D.sever(TUBE, { slots, width: 1.0 });
      const m = measure(r.soup);
      const bodies = slots === 1 ? 1 : slots;
      const chi = 2 * bodies;               // every body a genus-0 wedge of the ring
      const wall = T.measureMesh(r.soup, { nozzle: 0.4 });
      check(slots + ' slot(s) through the ring: ' + bodies + ' body/bodies, genus 1 -> 0, chi 0 -> ' + chi,
            r.bodies === bodies && r.genus_per_body.every(g => g === 0) && r.before.genus === 1 &&
            m.euler_characteristic === chi,
            'kernel bodies ' + r.bodies + ', genus per body ' + r.genus_per_body.join('/') + ', checker chi ' + m.euler_characteristic);
      check('  ...and the finished mesh passes the checker and the wall check - nothing there to find',
            m.verdict === 'PASS' && wall.pass === true && cleanWall.pass === true,
            'wall min ' + (wall.min_mm && wall.min_mm.toFixed(3)) + ' mm');
    }
    const e = await D.sever(TORUS, { slots: 3, width: 2 }).then(() => null, x => x.message);
    check('a slot that leaves sub-weld slivers is REFUSED, not reported as a clean sever',
          e && /more than a severed wall/.test(e), e);
    const e2 = await D.sever(SPHERE, { slots: 1 }).then(() => null, x => x.message);
    check('one slot into a solid ball only notches it - refused as severing nothing', e2 && /sever nothing/.test(e2), e2);
    // cutClearance, asked BEFORE the cut about the first slot's box, refuses it
    const b = D.base(TUBE);
    const c = [0, 1, 2].map(i => (b.lo[i] + b.hi[i]) / 2);
    const rep = T.cutClearance(TUBE, [c[0], c[1] - 0.5, b.lo[2] - 1], [b.hi[0] + 1, c[1] + 0.5, b.hi[2] + 1],
                               { nozzle: 0.4, through: 'x' });
    check('cutClearance() on the clean tube refuses slot 0 as severing the wall',
          rep.pass === false && rep.severed_fatal.length > 0, rep.reason);
  }

  /* ================================================================ 6 */
  console.log('\n== 6. severity is monotone, and the same call is the same bytes ==');
  {
    const size = {
      hole: x => x.r.removed_faces,
      'nonManifold/duplicate': x => x.r.patch_faces,
      'nonManifold/duplicate-flipped': x => x.r.patch_faces,
      'nonManifold/flip': x => x.r.patch_faces,
      weld: x => x.r.sites.length,
      sever: x => x.r.sites.length
    };
    for (const key of Object.keys(size)) {
      const seq = (perLevel[key] || []).map(size[key]);
      const up = seq.length === 5 && seq.every((v, i) => i === 0 || v > seq[i - 1]);
      check(key + ': one -> shredded strictly grows', up, seq.join(' < '));
    }
    const holeOne = perLevel.hole[0].got, holeShred = perLevel.hole[4].got;
    const one = perLevel.hole[0].r;
    check('"one" is ONE small defect: a single boundary loop, under 2% of the faces',
          one.boundary_loops === 1 && one.removed_faces < 0.02 * SPHERE.length / 9,
          one.boundary_loops + ' loop, ' + one.removed_faces + ' faces, ' + holeOne.open_edges + ' open edges');
    check('...and "shredded" is many', perLevel.hole[4].r.boundary_loops > 1, perLevel.hole[4].r.boundary_loops + ' loops');
    check('"shredded" removes a large share of the surface', perLevel.hole[4].r.removed_faces > SPHERE.length / 9 / 4,
          perLevel.hole[4].r.removed_faces + ' of ' + SPHERE.length / 9 + ' faces, ' + holeShred.open_edges + ' open edges');

    const a = D.hole(SPHERE, { severity: 'moderate', seed: 11 }).soup;
    const a2 = D.hole(SPHERE, { severity: 'moderate', seed: 11 }).soup;
    const bb = D.hole(SPHERE, { severity: 'moderate', seed: 12 }).soup;
    const eq = (x, y) => x.length === y.length && Buffer.from(x.buffer).equals(Buffer.from(y.buffer));
    check('same parameters, same seed: byte-identical', eq(a, a2));
    check('another seed: another placement', !eq(a, bb));
    const s1 = (await D.sever(TUBE, { slots: 3 })).soup, s2 = (await D.sever(TUBE, { slots: 3 })).soup;
    check('the kernel path is deterministic too', eq(s1, s2));
  }

  /* ================================================================ 7 */
  console.log('\n== 7. fixtures/damage/ reads as its manifest says, and the Library lists it ==');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(G.OUT, 'damage.json'), 'utf8'));
    const onDisk = fs.readdirSync(G.OUT).filter(f => f.endsWith('.stl')).sort();
    const listed = manifest.entries.map(e => e.stl).sort();
    check('every file on disk is in damage.json and every entry is on disk',
          JSON.stringify(onDisk) === JSON.stringify(listed), onDisk.length + ' files');
    for (const e of manifest.entries) {
      const f = path.join(G.OUT, e.stl);
      const got = D.measuredFrom(measureFile(f));
      const dd = diffs(e.expected, got);
      const head = fs.readFileSync(f).slice(0, 80).toString('latin1');
      check(e.stl + ': the checker reads the manifest\'s signature', dd.length === 0,
            dd.join('; ') || 'open ' + got.open_edges + ' nm ' + got.nonmanifold_edges + ' wind ' +
            got.inconsistent_winding_edges + ' chi ' + got.euler_characteristic);
      check('  ...and its header says what it is', /^NSO damage fixture: /.test(head) && head.includes(e.type));
    }

    const cat = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');
    const rows = (cat.match(/\{\s*file:\s*'([^']+)'[^}]*category:\s*'([^']+)'/g) || [])
      .map(row => ({ file: row.match(/file:\s*'([^']+)'/)[1], category: row.match(/category:\s*'([^']+)'/)[1] }));
    const want = manifest.entries.filter(e => e.library).map(e => e.stl);
    const inLib = rows.filter(r => want.includes(r.file));
    check('every library-flagged fixture has a Library row, under Test Fixtures',
          inLib.length === want.length && inLib.every(r => r.category === 'Test Fixtures'),
          inLib.length + ' of ' + want.length);
    const unflagged = rows.filter(r => manifest.entries.some(e => e.stl === r.file && !e.library));
    check('...and nothing the manifest keeps out of the Library is in it', unflagged.length === 0,
          unflagged.map(r => r.file).join(', '));
    const src = f => ((cat.match(new RegExp("\\{\\s*file:\\s*'" + f.replace(/[.]/g, '\\.') + "'[^}]*source:\\s*'([^']+)'")) || [])[1]);
    check('...each served from nest-library, where the catalog fetches from',
          want.every(f => src(f) === 'nest-library'), want.map(src).join(', '));
    const NL = LIBDIR.libraryDir();
    if (NL) {
      const drift = want.filter(f => !fs.existsSync(path.join(NL, f)) ||
        !fs.readFileSync(path.join(NL, f)).equals(fs.readFileSync(path.join(G.OUT, f))));
      check('...and nest-library holds each one byte-identical to fixtures/damage/', drift.length === 0, drift.join(', '));
    } else {
      LIBDIR.skip('...nest-library holds each one byte-identical to fixtures/damage/');
    }
    const stray = want.filter(f => fs.existsSync(path.join(ROOT, 'library', f)));
    check('...and none of them is copied into this repo\'s library/ (no check loads them from there)',
          stray.length === 0, stray.join(', '));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

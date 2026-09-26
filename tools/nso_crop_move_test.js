/* Crop, stage 2 (app-crop.js section 4b): move a boxed region and reconnect it.
   node tools/nso_crop_move_test.js        exit 0 = every gate held

   A box selects a region. Cut's clip takes it out, it is moved by an offset,
   and at lock-in it is reconnected to the rest - trimmed where it overlaps,
   unioned where it touches, bridged where it was pulled clear - by what is
   MEASURED after the move, not by what was asked. Every result below goes
   through tools/mesh_validate.py, the canonical checker.

   1. a tabbed bar, the tab moved to the far side: touch, trim and bridge at
      exact, hand-computable volumes; the branch is the measured one.
   2. refusals: too far to bridge, buried, box with no material, box with
      everything, no move, a move that leaves two parts. Each names its reason
      and hands the input object back.
   3. the acceptance test: library/v9_mirror_factory.stl, a span of the -Y lip
      next to the +seam (X = 87.537) moved to the mirror-opposite +Y side at
      the same X. At the lip's own height it lands clear of the teeth and is
      BRIDGED; pushed 2 mm down it lands in them and is TRIMMED. Both pass the
      checker with self-intersection included. Also a box whose far face is
      exactly on the seam ring, and the same span at the -seam.
   4. the seam-cap defect class, explicitly: the source's own seam defect is
      gone from the result, nothing new appears near either seam ring, every
      source vertex outside the slab is where it was, and Split through the
      seam ring and through the landing still gives two clean halves.
   5. why the reconnected slab is welded: the acceptance bridge without
      Cut's 1e-4 weld is refused by the gate (the checker would read it
      non-manifold), and with it passes.
   6. a move too extreme to reconcile refuses cleanly on v9. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { csgContext } = require('./nso_csg_node.js');

const ROOT = path.resolve(__dirname, '..');
// The shipped kernel adapter (app-join.js, spliced by nso_csg_node.js) plus
// the shipped files this stage calls, all in one context.
const ctx = csgContext();
ctx.window = ctx;
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_hollow.js', 'app-cut.js', 'app-crop.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_cropMoveRaw, NSO_cropRegionRaw, NSO_unionSoups, rawCut } = ctx;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

function readSTL(f) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-crop-move-'));
let seq = 0;
function stl(soup) {
  const f = path.join(TMP, 'p' + (seq++) + '.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}
function validate(soup, opts) {
  opts = opts || {};
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), stl(soup), '--json'];
  if (!opts.selfint) args.push('--no-selfint');
  const j = JSON.parse(execFileSync('python3', args, { maxBuffer: 1 << 30 }).toString());
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic +
    (j.self_intersection ? ' pierce ' + j.self_intersection.pierce + ' coplanar ' + j.self_intersection.coplanar : '');
  return j;
}
// Where the checker's defects are: the X of every non-manifold, open or
// flipped edge, after the checker's own weld (mesh_validate.weld).
function defectXs(soup) {
  const py = [
    'import sys, json',
    'sys.path.insert(0, ' + JSON.stringify(path.join(ROOT, 'tools')) + ')',
    'import mesh_validate as M',
    'from collections import defaultdict',
    'from pathlib import Path',
    'v, idx = M.weld(M.parse_stl(Path(sys.argv[1])), 1e-4)',
    'u = defaultdict(int); d = defaultdict(int)',
    'for a, b, c in idx:',
    '    for p, q in ((a, b), (b, c), (c, a)):',
    '        u[(min(p, q), max(p, q))] += 1; d[(p, q)] += 1',
    'bad = [e for e, n in u.items() if n != 2] + [e for e, n in d.items() if n > 1]',
    'print(json.dumps([v[e[0]][0] for e in bad]))'
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', py, stl(soup)], { maxBuffer: 1 << 30 }).toString());
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6])
       + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]);
  }
  return v / 6;
}
function boxSoup(lo, hi) { return ctx.NSO_cropBoxSoup(lo, hi); }
const fmt = x => (x === undefined || x === null) ? '-' : (+x).toFixed(3);
const said = r => r.ok ? r.branch + ', overlap ' + fmt(r.overlapMm3) + ' mm3, gap ' + fmt(r.gapMm) + ' mm' +
  (r.bridgeMm3 !== undefined ? ', bridge +' + fmt(r.bridgeMm3) + ' mm3' : '') : 'refused: ' + r.reason;

(async () => {
  try {
    console.log('\n=== 1. a tabbed bar: the tab moved to the far side ===');
    // Bar 60 x 12 x 8, a 10 x 6 x 4 tab on its -Y face at X 20..30, Z 2..6.
    const u = await NSO_unionSoups(boxSoup([0, 0, 0], [60, 12, 8]), boxSoup([20, -6, 2], [30, 0.5, 6]));
    const bar = u.soup, V = volume(bar), TAB = 10 * 6 * 4;
    const s0 = validate(bar, { selfint: true });
    check('the tabbed bar passes the checker, ' + V.toFixed(3) + ' mm3', s0.verdict === 'PASS' && Math.abs(V - (5760 + TAB)) < 1e-3,
      s0.summary);
    const box = { min: [19, -7, 1], max: [31, 0, 7] };      // the tab, and only the tab
    const reg = NSO_cropRegionRaw(bar, box, 0);
    check('the region is the tab: closed, 240 mm3', reg.ok && Math.abs(volume(reg.tris) - TAB) < 1e-3,
      reg.ok ? volume(reg.tris).toFixed(4) : reg.reason);
    const T = [
      // [name, offset, branch, volume it must enclose (null = more than V)]
      ['face to face on the +Y face', [0, 18, 0], 'touch', V],
      ['pushed 1 mm into the bar', [0, 17, 0], 'trim', V - 40],
      ['pushed 3 mm in, and 2 mm along X', [2, 15, 0], 'trim', V - 120],
      ['held 1 mm clear of the +Y face', [0, 19, 0], 'bridge', null],
      ['held 0.3 mm clear, on top of the bar instead', [0, 9, 6.3], 'bridge', null]
    ];
    for (const [name, off, want, vol] of T) {
      const r = await NSO_cropMoveRaw(bar, { box, offset: off });
      check(name + ': ' + want, r.ok && r.branch === want, said(r));
      if (!r.ok) continue;
      const v = validate(r.tris, { selfint: true });
      check(name + ': PASS, self-intersection included, one shell', v.verdict === 'PASS' && r.shellsAfter === 1, v.summary);
      if (vol !== null) {
        check(name + ': encloses exactly ' + vol + ' mm3', Math.abs(volume(r.tris) - vol) < 1e-3, volume(r.tris).toFixed(4));
      } else {
        const gap = off[1] === 19 ? 1 : 0.3;
        check(name + ': gap measured ' + gap + ' mm, and the bridge adds material', Math.abs(r.gapMm - gap) < 1e-4 && r.bridgeMm3 > 0 &&
          volume(r.tris) > V, 'gap ' + fmt(r.gapMm) + ', bridge ' + fmt(r.bridgeMm3) + ' mm3');
      }
    }

    console.log('\n=== 2. refusals name the reason and hand back the input untouched ===');
    const REF = [
      ['gap too wide to bridge', { box, offset: [0, 24, 0] }, /gap of 6\.00 mm.*reaches 3 mm/],
      ['region buried in the bar', { box, offset: [0, 12, 0] }, /buries the region: 100%/],
      ['box with no material', { box: { min: [70, 0, 0], max: [80, 5, 5] }, offset: [0, 1, 0] }, /no material/],
      ['box with the whole piece', { box: { min: [-1, -7, -1], max: [61, 13, 9] }, offset: [0, 1, 0] }, /whole piece/],
      ['no move', { box, offset: [0, 0, 0] }, /not moved/],
      ['a move that leaves two parts (a full slab, pushed into one side only)',
        { box: { min: [25, -7, -1], max: [35, 13, 9] }, offset: [-5, 0, 0] }, /2 separate part/]
    ];
    for (const [name, opts, re] of REF) {
      const r = await NSO_cropMoveRaw(bar, opts);
      check(name + ': refused', !r.ok && re.test(r.reason), r.reason || said(r));
      check(name + ': input object handed back', r.tris === bar);
    }

    console.log('\n=== 3. acceptance: v9_mirror_factory.stl, the -Y lip next to the +seam, to the +Y side ===');
    const v9 = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
    const SEAM_P = 87.53694152832031, SEAM_M = -88.56546020507812;
    const src = validate(v9);
    const srcDefects = defectXs(v9);
    console.log('   source: ' + src.summary + '; its defects sit at X ' + Array.from(new Set(srcDefects.map(x => x.toFixed(3)))).join(', '));
    check('baseline: the source fails the checker only at the seams (the +seam\'s sub-tolerance pair)',
      src.verdict === 'FAIL' && srcDefects.length > 0 && srcDefects.every(x => Math.abs(x - SEAM_P) < 6.1 || Math.abs(x - SEAM_M) < 0.1),
      src.summary);
    // The lip is Y -17..-2 at Z 7.5..10.5; the body is Y -2..17. The box takes
    // the lip out to Y -3 (clear of the fillet into the body) over X 74..86,
    // 1.5 mm short of the +seam ring. +31 in Y puts it on the +Y side, where
    // the body tops out at the teeth, Z ~6.3.
    const LIP = (x0, x1) => ({ min: [x0, -20, 5], max: [x1, -3, 12] });
    const ACC = [
      ['lip X 74..86 at its own height (lands clear of the teeth)', LIP(74, 86), [0, 31, 0], 'bridge'],
      ['lip X 74..86 pushed 2 mm down (lands in the teeth)', LIP(74, 86), [0, 31, -2], 'trim'],
      ['box far face exactly on the +seam ring, own height', LIP(SEAM_P - 12, SEAM_P), [0, 31, 0], 'bridge'],
      ['box far face exactly on the +seam ring, pushed down', LIP(SEAM_P - 12, SEAM_P), [0, 31, -2], 'trim'],
      ['the same span at the -seam, pushed down', LIP(SEAM_M + 2, SEAM_M + 14), [0, 31, -2], 'trim']
    ];
    const results = [];
    for (const [name, bx, off, want] of ACC) {
      const t0 = Date.now();
      const r = await NSO_cropMoveRaw(v9, { box: bx, offset: off });
      check(name + ': ' + want, r.ok && r.branch === want, said(r) + '  (' + (Date.now() - t0) + ' ms)');
      if (!r.ok) continue;
      results.push([name, bx, r]);
      const v = validate(r.tris, { selfint: true });
      check(name + ': PASS mesh_validate.py, self-intersection included', v.verdict === 'PASS', v.summary);
      check(name + ': one piece, in-page checker clean', r.shellsAfter === 1 && r.canonAfter.open === 0 && r.canonAfter.nm === 0 &&
        r.canonAfter.flipped === 0, JSON.stringify(r.canonAfter));
      console.log('        region ' + fmt(r.regionMm3) + ' mm3, slab X ' + fmt(r.slab.lo) + '..' + fmt(r.slab.hi) +
        ', the weld moved ' + fmt(r.cleanMm3) + ' mm3, volume ' + fmt(volume(v9)) + ' -> ' + fmt(volume(r.tris)));
      // Every mm3 accounted for: the source, less the notch the kernel took
      // out, plus the region it was (as re-meshed), less the overlap trimmed
      // or plus the bridge grown, plus what the 1e-4 weld moved. The notch
      // and the region differ by ~0.03 mm3 because Cut's clip snaps vertices
      // within 1e-4 of a box face onto it.
      const acct = volume(v9) - r.notchMm3 + r.regionMm3 - (r.overlapMm3 || 0) + (r.bridgeMm3 || 0) + r.cleanMm3;
      check(name + ': volume accounted for: source - notch + region - overlap + bridge',
        Math.abs(volume(r.tris) - acct) < 1e-3, fmt(volume(r.tris)) + ' vs ' + fmt(acct) +
        ' (notch ' + fmt(r.notchMm3) + ', region ' + fmt(r.regionMm3) + ')');
      if (want === 'bridge') {
        check(name + ': gap measured under a millimetre, bridge adds material', r.gapMm > 0.5 && r.gapMm < 1 && r.bridgeMm3 > 1,
          'gap ' + fmt(r.gapMm) + ' mm, +' + fmt(r.bridgeMm3) + ' mm3');
      }
    }

    console.log('\n=== 4. the seam-cap defect class, explicitly ===');
    for (const [name, bx, r] of results) {
      const xs = defectXs(r.tris);
      check(name + ': no checker defect anywhere, so none at either seam ring', xs.length === 0,
        xs.length ? 'at X ' + xs.slice(0, 6).map(x => x.toFixed(3)).join(', ') : '');
      // Outside the slab nothing moved: every source vertex there is in the
      // result, bit for bit, except where Cut's own 1e-4 weld merged the
      // +seam's sub-tolerance pair (rawCutOpen welds its input).
      const lo = r.slab.lo === null ? -Infinity : r.slab.lo - 0.01, hi = r.slab.hi === null ? Infinity : r.slab.hi + 0.01;
      const have = new Set();
      for (let i = 0; i < r.tris.length; i += 3) have.add(r.tris[i] + ',' + r.tris[i+1] + ',' + r.tris[i+2]);
      let outside = 0, kept = 0;
      for (let i = 0; i < v9.length; i += 3) {
        if (v9[i] > lo && v9[i] < hi) continue;
        outside++;
        if (have.has(v9[i] + ',' + v9[i+1] + ',' + v9[i+2])) kept++;
      }
      check(name + ': outside the slab, the source vertices are where they were', outside > 100000 && outside - kept <= 6,
        kept + ' of ' + outside + ' kept exactly');
    }
    // Sequential work after a Move: Split through the +seam ring and through
    // the landing. The halves are what rawcut:seam holds rawCut to.
    const moved = results.find(x => /^lip X 74\.\.86 pushed/.test(x[0]));
    if (moved) {
      for (const plane of [SEAM_P, 80, 77.3]) {
        const halves = [rawCut(moved[2].tris, 0, plane, false), rawCut(moved[2].tris, 0, plane, true)];
        const vv = halves.map(h => validate(h));
        check('Split the trimmed result at X ' + plane + ': both halves PASS', vv.every(v => v.verdict === 'PASS'),
          vv.map(v => v.summary).join(' | '));
      }
    }

    console.log('\n=== 5. why the kernel\'s output is welded at Cut\'s radius ===');
    {
      // The acceptance bridge: surface nets put some vertices closer than 1e-4.
      const raw = await NSO_cropMoveRaw(v9, { box: LIP(74, 86), offset: [0, 31, 0], skipClean: true });
      check('without the weld: the gate refuses the bridged lip (non-manifold under the checker\'s weld)',
        !raw.ok && /checker: .*non-manifold 2→\d+/.test(raw.reason) && raw.tris === v9, raw.reason);
      const cleaned = await NSO_cropMoveRaw(v9, { box: LIP(74, 86), offset: [0, 31, 0] });
      const v = cleaned.ok ? validate(cleaned.tris) : null;
      check('with it: the same landing bridges and PASSES', cleaned.ok && cleaned.branch === 'bridge' && v.verdict === 'PASS',
        cleaned.ok ? v.summary : cleaned.reason);
    }

    console.log('\n=== 6. too extreme to reconcile, on v9 ===');
    {
      const X = [
        ['lifted 6 mm above the teeth', { box: LIP(74, 86), offset: [0, 31, 6] }, /gap of 6\.\d+ mm/],
        ['driven into the body core', { box: LIP(74, 86), offset: [-10, 15, -14] }, /buries the region: 9\d%/],
        ['thrown clear of the piece', { box: LIP(74, 86), offset: [0, 80, 0] }, /gap of more than 10 mm/]
      ];
      for (const [name, opts, re] of X) {
        const r = await NSO_cropMoveRaw(v9, opts);
        check(name + ': refused by name, input handed back', !r.ok && re.test(r.reason) && r.tris === v9, r.reason || said(r));
      }
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n' + (fail === 0 ? 'PASS' : fail + ' FAILED') + ' (' + pass + ' ok)');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

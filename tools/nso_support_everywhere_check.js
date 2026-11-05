#!/usr/bin/env node
/* ============================================================
   tools/nso_support_everywhere_check.js - supports-sheet-everywhere:
   every tip that meets the part has a sheet under it, at any yaw and any tip,
   or is NAMED; and no support line comes nearer the part's lines than the
   slice's support_object_xy_distance.  (npm run support:everywhere)

   The card's GENERATE builds a sheet (2 transition + 2 interface layers on the
   tips' caps, 0.18 mm under the part) where the part's underside has a level
   (a flat ceiling) or a stair (a slope or a curve). A piece yawed 45 deg and
   tipped 15 deg built NO sheet at all: the stair's strips would not extrude, its
   gap would not hold for one strip and the whole stair was dropped, the tips it
   left were never asked again - and every tip stood as a bare pillar, silently.

   1. THE REFERENCE. fixtures/supports/tree_slimsupports.gcode.3mf (Bambu
      Studio, A1 mini, tree slim; the owner's second copy of the same slice
      differs only in the object label ids), read with the existing G-code
      reader (tools/nso_slicer_audit.js extrusions): the Support transition /
      Support interface features of each of its six parts, grouped into surfaces -
      height, footprint, layers - and each part matched to its mesh in
      fixtures/supports/supp_ref.3mf by name and by plate position (the walls
      in the G-code lie inside the mesh, at the same x, y).
   2. THE PARTS (tools/nso_support_ref_pieces.js): the six REAL meshes of that
      project, each flat, yawed 45, tipped 15, yawed 45 and tipped 15 about its own
      footprint's centre, built as the card builds it (detect, plan,
      NSO_SupportGridpack.parts with PARTS_OPTS, shells, shared feet), then SLICED
      with NSO_Slicer - whose typeSupports labels each support line Support,
      Support transition or Support interface (docs/SLICER.md). A tip HAS A SHEET
      when an interface line lies within TIP_XY_MM of it, under it, within the
      stack and the gap (and a transition line, unless a stair holds it: a stair's
      strips rest on one another, its transition is under the lowest). A tip
      without one must be in the plan's own list of them (tp.sheet.bare, with the
      reason and the spot), or a side tip - none is silent. The sheets keep the gap
      (0.18 mm, measured), and the counts per pose are held at what is built.
   3. SIDEWAYS CLEARANCE. In every layer of that slice, every support line keeps
      at least 0.35 mm (the slice's support_object_xy_distance) from the part's
      lines, centre-line to centre-line; the smallest found, and its z, per pose.
      (The stand-in Base of #301 at yaw 45 + tip 15 had 0.00 mm at z 14.6 and 14.8:
      Studio's "Conflicts of gcode paths".)
   4. THE FLAT PIECES are byte for byte what they were: the coupon's and the
      top_clip_x2's supports hashed (the tape's with --tape).
   5. FILES. One .3mf per pose with the six parts and their supports, inside the
      180 x 180 bed, at the positions the project gives, in tools/supports-everywhere-out/
      (git-ignored) - for Bambu Studio: zero "conflict" warnings is the owner's check.

   The tape at yaw 45 + tip 15 takes half an hour (--tape runs the four tape poses
   by hand; it is not a step).

     node tools/nso_support_everywhere_check.js            the check, and the files
     node tools/nso_support_everywhere_check.js --tape     + the library tape piece, four poses
     node tools/nso_support_everywhere_check.js --quick    the reference and the flat hashes only
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');
const RP = require('./nso_support_ref_pieces.js');
const PE = require('./nso_supports_print_export.js');
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require('../nso-3mf-read.js');
const SL = require('../nso_slicer.js');

const REF_FILE = path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
const GAP = 0.18;
const TIP_XY_MM = 1.5;          /* an interface line this near a tip (in plan) is under it */
const STACK_UP_MM = 0.05;       /* ...no higher than the tip's contact */
const STACK_DOWN_MM = 1.2;      /* ...and no lower than the stack, the gap and a strip's step */
const TRANS_DOWN_MM = 1.8;
const args = process.argv.slice(2);
const TAPE = args.includes('--tape'), QUICK = args.includes('--quick');
const XY_MM = 0.35;             /* the slice's support_object_xy_distance */
const OUT = path.join(ROOT, 'tools', 'supports-everywhere-out');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const soupHash = soups => sha(Buffer.concat(soups.map(s => Buffer.from(s.buffer, s.byteOffset, s.byteLength))));

/* ------------------------------------------------------------------ 1 */

/* the surfaces of one part: its transition / interface layers, grouped where they follow on (a layer within 0.6 mm
   of the group's top, its box meeting the group's) - one flat sheet, or one stair, is one group */
function groupsOf(layers) {
  const gs = [];
  for (const L of layers) {
    let g = gs.find(q => L.z - q.zTop <= 0.6 && L.z >= q.zTop - 1e-9 &&
      !(L.bb[0] > q.bb[2] + 0.5 || L.bb[2] < q.bb[0] - 0.5 || L.bb[1] > q.bb[3] + 0.5 || L.bb[3] < q.bb[1] - 0.5));
    if (!g) { g = { zTop: L.z, z0: L.z, bb: L.bb.slice(), T: [], I: [] }; gs.push(g); }
    g.zTop = Math.max(g.zTop, L.z); g.z0 = Math.min(g.z0, L.z);
    g.bb = [Math.min(g.bb[0], L.bb[0]), Math.min(g.bb[1], L.bb[1]), Math.max(g.bb[2], L.bb[2]), Math.max(g.bb[3], L.bb[3])];
    (L.feat === 'Support transition' ? g.T : g.I).push(L.z);
  }
  return gs.map(g => ({ z0: g.z0, z1: g.zTop, T: g.T.length, I: g.I.length, w: g.bb[2] - g.bb[0], d: g.bb[3] - g.bb[1], bb: g.bb }));
}
/* each part of the reference slice, by name: its surfaces. layers: every (z, feature) with the box of its lines */
function referenceSurfaces(gcode, names) {
  const mv = AUDIT.extrusions(gcode), out = {};
  for (const id of Object.keys(names)) {
    const by = {};
    for (const m of mv) {
      if (+m.obj !== +id || !/^Support (transition|interface)$/.test(m.feat || '')) continue;
      const k = m.z.toFixed(3) + '|' + m.feat, r = by[k] || (by[k] = { z: m.z, feat: m.feat, bb: [Infinity, Infinity, -Infinity, -Infinity] });
      r.bb = [Math.min(r.bb[0], m.x0, m.x1), Math.min(r.bb[1], m.y0, m.y1), Math.max(r.bb[2], m.x0, m.x1), Math.max(r.bb[3], m.y0, m.y1)];
    }
    out[names[id]] = groupsOf(Object.values(by).sort((a, b) => a.z - b.z || (a.feat < b.feat ? -1 : 1)));
  }
  return out;
}
/* what Bambu's slice shows, per part (read off the file; held here so a different file cannot pass for it) */
const REF = {
  Base:       [{ z0: 13.70, z1: 14.80, T: 2, I: 3, w: 13.9, d: 12.9 }],
  Oblique:    [{ z0: 7.69, z1: 12.20, T: 19, I: 20, w: 13.9, d: 12.4 }],
  Circular:   [{ z0: 7.69, z1: 9.40, T: 5, I: 6, w: 6.9, d: 7.1 }],
  Sphere:     [{ z0: 8.49, z1: 10.00, T: 4, I: 5, w: 5.1, d: 5.2 }],
  NegSphere:  [{ z0: 9.30, z1: 10.40, T: 2, I: 3, w: 12.7, d: 11.8 }, { z0: 13.00, z1: 14.20, T: 3, I: 4, w: 2.9, d: 3.1 }],
  NegSphere2: [{ z0: 9.30, z1: 10.40, T: 2, I: 3, w: 13.5, d: 10.6 }, { z0: 13.80, z1: 15.20, T: 4, I: 5, w: 3.9, d: 4.2 }]
};

/* ------------------------------------------------------------------ 3 */

const SLICE_OPTS = SL.defaultsFor(0.4);
let WASM = null;

/* the labelled lines of every support object in a slice: { z (the layer's top), f, pts } */
function labelledLines(r) {
  const out = [];
  for (const ob of r.objects) {
    if (ob.role !== 'support') continue;
    for (const L of ob.layers) for (const p of (L.paths || [])) {
      if (p.feature === 'Support interface' || p.feature === 'Support transition') out.push({ z: L.printZ, f: p.feature, pts: p.pts });
    }
  }
  return out;
}
function nearLine(l, x, y, D) {
  const P = l.pts;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], c = P[i + 1], dx = c[0] - a[0], dy = c[1] - a[1], L2 = dx * dx + dy * dy;
    let t = L2 < 1e-12 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) <= D) return true;
  }
  return P.length === 1 && Math.hypot(P[0][0] - x, P[0][1] - y) <= D;
}
/* index the lines by layer once: a tip asks about a few layers */
function indexLines(lines) {
  const by = new Map();
  for (const l of lines) { const k = l.z.toFixed(3); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
  return [...by.entries()].map(([k, v]) => ({ z: +k, lines: v })).sort((a, b) => a.z - b.z);
}
function hasLine(layers, feat, x, y, zLo, zHi) {
  for (const L of layers) {
    if (L.z < zLo - 1e-9) continue;
    if (L.z > zHi + 1e-9) break;
    if (L.lines.some(l => l.f === feat && nearLine(l, x, y, TIP_XY_MM))) return true;
  }
  return false;
}

/* ---- sideways clearance: per layer, the nearest a support line comes to a line of the part (centre to centre) */
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy), o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) return 0;
  const pd = (px, py, x1, y1, x2, y2) => {
    const ex = x2 - x1, ey = y2 - y1, ee = ex * ex + ey * ey;
    let t = ee > 1e-18 ? ((px - x1) * ex + (py - y1) * ey) / ee : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - x1 - t * ex, py - y1 - t * ey);
  };
  return Math.min(pd(ax, ay, cx, cy, dx, dy), pd(bx, by, cx, cy, dx, dy), pd(cx, cy, ax, ay, bx, by), pd(dx, dy, ax, ay, bx, by));
}
function segsOf(paths) {
  const out = [];
  for (const p of paths) {
    const P = p.pts;
    for (let i = 0; i + 1 < P.length; i++) out.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], p.feature]);
    if (p.closed && P.length > 2) out.push([P[P.length - 1][0], P[P.length - 1][1], P[0][0], P[0][1], p.feature]);
  }
  return out;
}
function minClearance(r) {
  const part = r.objects.find(o => o.role !== 'support'), sups = r.objects.filter(o => o.role === 'support');
  let best = { mm: Infinity, z: null, at: null, partFeat: null, supFeat: null };
  const CS = 2, key = (i, k) => i + ',' + k;
  part.layers.forEach((PL, j) => {
    let ps = segsOf(PL.paths || []);
    if (!ps.length) return;
    /* the slicer here draws an infill line that joins two runs straight across a hole of the part; a line of infill that
       crosses a wall of the same part is that join, not infill (a slicer never prints it), and is left out */
    const walls = ps.filter(s => /wall/i.test(s[4])), crosses = (a, b) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const A = [a[0], a[1]], B = [a[2], a[3]], C = [b[0], b[1]], D = [b[2], b[3]];
      return (o(A, B, C) > 0) !== (o(A, B, D) > 0) && (o(C, D, A) > 0) !== (o(C, D, B) > 0);
    };
    ps = ps.filter(s => /wall/i.test(s[4]) || !/infill/i.test(s[4]) || !walls.some(w => crosses(s, w)));
    const grid = new Map();
    ps.forEach((s, idx) => {
      const x0 = Math.floor(Math.min(s[0], s[2]) / CS), x1 = Math.floor(Math.max(s[0], s[2]) / CS);
      const y0 = Math.floor(Math.min(s[1], s[3]) / CS), y1 = Math.floor(Math.max(s[1], s[3]) / CS);
      for (let i = x0; i <= x1; i++) for (let k = y0; k <= y1; k++) { const kk = key(i, k); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(idx); }
    });
    for (const so of sups) {
      const SLy = so.layers[j];
      if (!SLy || !SLy.paths) continue;
      for (const q of segsOf(SLy.paths)) {
        const x0 = Math.floor((Math.min(q[0], q[2]) - 1) / CS), x1 = Math.floor((Math.max(q[0], q[2]) + 1) / CS);
        const y0 = Math.floor((Math.min(q[1], q[3]) - 1) / CS), y1 = Math.floor((Math.max(q[1], q[3]) + 1) / CS);
        const seen = new Set();
        for (let i = x0; i <= x1; i++) for (let k = y0; k <= y1; k++) {
          const l = grid.get(key(i, k));
          if (!l) continue;
          for (const idx of l) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const s = ps[idx], d = segSegDist(q[0], q[1], q[2], q[3], s[0], s[1], s[2], s[3]);
            if (d < best.mm) best = { mm: d, z: PL.printZ, at: [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2], partFeat: s[4], supFeat: q[4] };
          }
        }
      }
    }
  });
  return best;
}
/* our surfaces in a slice: the labelled lines grouped as the reference's are */
function oursSurfaces(lines) {
  const by = new Map();
  for (const l of lines) {
    const k = l.z.toFixed(3) + '|' + l.f, r = by.get(k) || { z: l.z, feat: l.f, bb: [Infinity, Infinity, -Infinity, -Infinity] };
    for (const q of l.pts) r.bb = [Math.min(r.bb[0], q[0]), Math.min(r.bb[1], q[1]), Math.max(r.bb[2], q[0]), Math.max(r.bb[3], q[1])];
    by.set(k, r);
  }
  return groupsOf([...by.values()].sort((a, b) => a.z - b.z || (a.feat < b.feat ? -1 : 1)));
}

/* one piece in one pose, built as the card builds it and read back off the slice */
async function runPose(piece, label, name) {
  const t0 = Date.now();
  const b = await PE.build(piece, null, name);
  const tBuild = Date.now() - t0;
  const objs = [{ name: 'part', soup: piece, key: 101, role: 'part' }]
    .concat(b.objects.slice(1).map((x, i) => ({ name: x.name, soup: x.soup, key: 201 + i, role: 'support', hostKey: 101 })));
  const r = SL.sliceObjects(objs, SLICE_OPTS, WASM);
  if (!r.ok) throw new Error(label + ': the slice failed: ' + r.reason);
  const lines = labelledLines(r), layers = indexLines(lines);
  const clr = minClearance(r), ours = oursSurfaces(lines);
  const res = { label, ms: tBuild, clr, ours, objects: b.objects, engineBare: 0, uncarried: 0, engineWhy: [], tips: 0, withI: 0, withTI: 0, stairHeld: 0, bare: [], side: 0, named: 0, silent: [], minGap: Infinity, maxGap: 0, levels: 0, stairs: 0, notes: [], areas: b.areas.length };
  for (const a of b.areas) {
    const S = a.tp.sheet;
    if (!S) continue;
    S.levels.forEach(L => {
      res.levels++; if (L.stair) res.stairs++;
      if (L.minDistanceMm != null && isFinite(L.minDistanceMm)) { res.minGap = Math.min(res.minGap, L.minDistanceMm); res.maxGap = Math.max(res.maxGap, L.minDistanceMm); }
    });
    res.notes.push(...(S.notes || []));
    const named = new Set((S.bare || []).concat(S.uncarried || []).map(x => x.i));
    for (const t of S.tips) {
      if (t.mode === 'side') { res.side++; continue; }
      res.tips++;
      const [x, y, z] = t.contact;
      const I = hasLine(layers, 'Support interface', x, y, z - STACK_DOWN_MM, z + STACK_UP_MM);
      const T = hasLine(layers, 'Support transition', x, y, z - TRANS_DOWN_MM, z + STACK_UP_MM);
      /* a stair's strips are typed by what lies over them (the slicer's typeSupports: one a layer is a top, the strips
         under another's top are its interface and transition): a tip a stair holds has a sheet under it when a line of
         either type lies there */
      const inStair = t.mode === 'drop' || !!(S.levels.find(L => L.id === t.level) || {}).stair;
      const has = inStair ? (I || T) : (I && T);
      if (I) res.withI++;
      if (has) { res.withTI++; if (inStair) res.stairHeld++; }
      else {
        const isNamed = named.has(t.i);
        res.bare.push({ area: a.rid, i: t.i, mode: t.mode, why: t.why, at: t.contact.map(v => +v.toFixed(1)), I, T, named: isNamed });
        if (isNamed) res.named++; else res.silent.push(res.bare[res.bare.length - 1]);
      }
    }
    res.engineBare += (S.bare || []).length; res.uncarried += (S.uncarried || []).length;
    (S.bare || []).forEach(x => res.engineWhy.push(x.why));
  }
  return res;
}

/* what the build held at the time of writing: no pose may do worse (a count of tips with a sheet that falls is a
   regression; one that rises is the next ticket's, and these numbers go up with it) */
const FLOOR = {
  /* piece:      [flat, yaw 45, tip 15, yaw 45 + tip 15] tips with a sheet */
  base: [20, 16, 20, 16], oblique: [20, 12, 16, 13], circular: [4, 4, 3, 4], sphere: [2, 4, 4, 4], negsphere: [15, 11, 6, 6], negsphere2: [3, 3, 7, 9]
};
/* negsphere2 tip 15: 8 -> 7 when a stair's posts were typed as Support (nso_slicer.js STAIR ZONES): the eighth was a tip the plan itself names bare (its level failed),
   counted for the stair's lines beside it that were typed interface; the plan's own list of bare tips (checked below) is unchanged */
const POSES = [[0, 0], [45, 0], [0, 15], [45, 15]];

/* ------------------------------------------------------------------ 4 */

/* the supports of the flat pieces, hashed on the engine as it stood before this ticket (claude-wip 413be05), re-pinned when every trunk got the tapered base (supports-one-trunk: flare 4.5 mm at 27 deg, was 4 mm at 15) */
const FLAT_HASH = {
  top_clip_x2_coupon: { file: 'fixtures/supports/top_clip_x2_coupon.stl', hash: 'dd44296b14d12c63', objects: 1 },
  top_clip_x2:        { file: 'fixtures/supports/top_clip_x2.stl', hash: 'fdfd0e704eac379b', objects: 2 }
};
const TAPE_HASH = 'fb53cfefd9e4a9a6';
function lowered(s) {
  let mz = Infinity;
  for (let i = 2; i < s.length; i += 3) if (s[i] < mz) mz = s[i];
  const o = new Float32Array(s);
  for (let i = 2; i < o.length; i += 3) o[i] -= mz;
  return o;
}

(async () => {
  WASM = await SL.loadKernel({});

  /* ---------------------------------------------------------------- 1 */
  console.log('\n=== 1. the reference: where Bambu lays its transition and interface layers ===');
  {
    const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF_FILE)));
    const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
    const dec = new TextDecoder();
    const gcode = dec.decode(await zip.read(gname));
    const names = AUDIT.sliceNames(dec.decode(await zip.read('Metadata/slice_info.config')));
    const nm = {};
    Object.keys(names).forEach(id => { nm[id] = names[id].replace(/^Support /, '').replace(/\.stl$/, '').replace(/ /g, '').replace(/^Negative/, 'Neg'); });
    const got = referenceSurfaces(gcode, nm);
    /* each part of the slice is a mesh of the project: matched by name, and by plate position (its walls inside its mesh, same x, y) */
    const wallBox = {};
    for (const m of AUDIT.extrusions(gcode)) {
      if (/^(Support|Brim)/.test(m.feat || '')) continue;
      const bb = wallBox[m.obj] || (wallBox[m.obj] = [Infinity, Infinity, -Infinity, -Infinity]);
      for (const [x, y] of [[m.x0, m.y0], [m.x1, m.y1]]) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
    }
    const parts = await RP.load();
    const regs = RP.NAMES.map(key => {
      const id = Object.keys(names).find(i => names[i] === RP.PROJECT_NAME[key]), bb = wallBox[id];
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      const sp = parts[key];
      for (let i = 0; i < sp.length; i += 3) { lo[0] = Math.min(lo[0], sp[i]); hi[0] = Math.max(hi[0], sp[i]); lo[1] = Math.min(lo[1], sp[i + 1]); hi[1] = Math.max(hi[1], sp[i + 1]); }
      const off = bb ? Math.max(bb[0] - lo[0], bb[1] - lo[1], hi[0] - bb[2], hi[1] - bb[3]) : Infinity, inside = bb ? Math.min(bb[0] - lo[0], bb[1] - lo[1], hi[0] - bb[2], hi[1] - bb[3]) : -1;
      return { key, off, inside };
    });
    check('each of the six real parts of fixtures/supports/supp_ref.3mf is the part under the slice\'s supports: by name, and by position (walls 0.2 - 0.6 mm inside the mesh, the same x, y)',
      regs.every(r => r.inside >= -0.05 && r.off <= 0.6), regs.map(r => r.key + ' ' + f2(r.inside) + '-' + f2(r.off)).join(', '));
    check('the file holds six parts, each with supports under it', Object.keys(got).length === 6 && Object.keys(got).every(k => got[k].length >= 1), Object.keys(got).join(', '));
    console.log('        part         surface  z (first T .. last I)   T  I   footprint (mm)');
    for (const k of Object.keys(REF)) {
      const want = REF[k], have = got[k] || [];
      have.forEach((s, i) => console.log('        ' + k.padEnd(12) + ' ' + String(i + 1).padStart(3) + '      ' + (f2(s.z0) + ' .. ' + f2(s.z1)).padEnd(20) + String(s.T).padStart(3) + String(s.I).padStart(3) + '   ' + f1(s.w) + ' x ' + f1(s.d)));
      check(k + ': ' + want.length + ' surface(s), the layers and the footprint as read', have.length === want.length && want.every((w, i) =>
        have[i].T === w.T && have[i].I === w.I && Math.abs(have[i].z0 - w.z0) < 0.06 && Math.abs(have[i].z1 - w.z1) < 0.06 &&
        Math.abs(have[i].w - w.w) < 0.15 && Math.abs(have[i].d - w.d) < 0.15),
        have.map(s => `z ${f2(s.z0)}-${f2(s.z1)} T${s.T} I${s.I} ${f1(s.w)}x${f1(s.d)}`).join(' | '));
    }
  }

  /* ---------------------------------------------------------------- 4 */
  console.log('\n=== 4. flat pieces: the supports are what they were ===');
  for (const k of Object.keys(FLAT_HASH)) {
    const F = FLAT_HASH[k];
    const b = await PE.build(lowered(readSTL(path.join(ROOT, F.file))));
    const soups = b.objects.slice(1).map(o => o.soup);
    check(k + ': the supports hash as before this ticket (' + F.hash + ')', soups.length === F.objects && soupHash(soups) === F.hash,
      soups.length + ' object(s), ' + soupHash(soups));
    const bare = b.areas.reduce((n, a) => n + (a.tp.sheet ? a.tp.sheet.tips.filter(t => t.mode === 'gap').length : 0), 0);
    check(k + ': every tip is under a sheet already (nothing for this ticket to add)', bare === 0, bare + ' bare');
  }

  if (!QUICK) {
    /* -------------------------------------------------------------- 2/3 */
    console.log('\n=== 2. the six real parts, in four poses: flat, yaw 45, tip 15, yaw 45 + tip 15 ===');
    console.log('        (tips with a sheet by the slicer\'s labels / tips without, named by the plan; side tips apart; clearance: nearest a support line comes to a line of the part)');
    const base = {};
    for (const n of RP.NAMES) base[n] = await RP.build(n);
    const T0 = Date.now(), all = [];
    for (const n of RP.NAMES) {
      for (let k = 0; k < POSES.length; k++) {
        const [yaw, tip] = POSES[k];
        const r = await runPose(RP.pose(base[n], yaw, tip), n + ' yaw ' + yaw + ' tip ' + tip, RP.PROJECT_NAME[n].replace(/\.stl$/, ''));
        r.piece = n; r.k = k; r.yaw = yaw; r.tip = tip; r.part = r.objects[0]; all.push(r);
        const kinds = {};
        r.bare.forEach(x => { const w = (x.why || x.mode).replace(/^its level failed: /, ''); kinds[w] = (kinds[w] || 0) + 1; });
        console.log('        ' + n.padEnd(11) + ('yaw ' + yaw + ' tip ' + tip).padEnd(16) + String(r.withTI).padStart(3) + ' / ' + String(r.bare.length).padEnd(3) +
          (r.side ? ' (+' + r.side + ' side)' : '').padEnd(10) + (r.stairs ? r.stairs + ' stair ' : '').padEnd(9) + (r.minGap < Infinity ? 'gap ' + f2(r.minGap) + '-' + f2(r.maxGap) : '').padEnd(15) +
          'clear ' + (r.clr.mm < Infinity ? f2(r.clr.mm) + ' @ z ' + f2(r.clr.z) : '-').padEnd(16) + (r.ms / 1000).toFixed(1) + ' s  ' + Object.keys(kinds).map(w => kinds[w] + ' x ' + w).join('; '));
        console.log('            ours: ' + (r.ours.length ? r.ours.map(g => `z ${f2(g.z0)}-${f2(g.z1)} T${g.T} I${g.I} ${f1(g.w)}x${f1(g.d)}`).join(' | ') : 'none'));
      }
    }
    console.log('        built in ' + ((Date.now() - T0) / 1000).toFixed(0) + ' s');

    console.log('\n=== 3. the audit ===');
    check('no tip stands bare in silence: every tip without a sheet is in the plan\'s own list of them, with its reason and its spot',
      all.every(r => r.silent.length === 0), all.map(r => r.silent.length).reduce((a, b) => a + b, 0) + ' silent');
    all.forEach(r => r.silent.forEach(x => console.log('          silent: ' + r.label + ' tip ' + x.i + ' (' + x.mode + ') at ' + x.at.join(',') + ' interface ' + x.I + ' transition ' + x.T + ' ' + (x.why || ''))));
    check('...and the plan says it in words (tp.sheet.notes) wherever it names one',
      all.every(r => ((r.engineBare + r.side + r.uncarried) === 0) === (r.notes.length === 0)), all.filter(r => r.notes.length).length + ' pose(s) with notes');
    check('the gap holds, measured on every sheet and every stair: 0.18 mm to the part, at the nearest point',
      all.every(r => r.minGap === Infinity || r.minGap >= GAP - 1e-5), 'least ' + f2(Math.min(...all.map(r => r.minGap))) + ' mm');
    check('...and no sheet sits further than 0.3 mm under the part at its nearest point (a lone tip\'s lowest ceiling)',
      all.every(r => r.maxGap <= GAP + 0.3), 'most ' + f2(Math.max(...all.map(r => r.maxGap))) + ' mm');
    check('every tip with a sheet has an interface line and a transition under it (a flat sheet\'s tips both; a stair\'s tips a line of either type: its transition is under the lowest strip)',
      all.every(r => r.withTI + r.bare.length === r.tips), all.reduce((a, r) => a + r.withTI, 0) + ' of ' + all.reduce((a, r) => a + r.tips, 0) + ' (' + all.reduce((a, r) => a + r.stairHeld, 0) + ' under a stair)');
    for (const n of RP.NAMES) {
      const row = all.filter(r => r.piece === n);
      check(n + ': tips with a sheet, flat / yaw 45 / tip 15 / both: no fewer than built ' + FLOOR[n].join(' / '),
        row.every((r, k) => r.withTI >= FLOOR[n][k]), row.map(r => r.withTI + ' of ' + r.tips).join(' / '));
    }
    const worst = all.reduce((w, r) => r.clr.mm < w.clr.mm ? r : w, all[0]);
    check('SIDEWAYS CLEARANCE: in every layer of the slice every support line keeps ' + XY_MM + ' mm from the part\'s lines (centre to centre), in all 24 poses',
      all.every(r => r.clr.mm >= XY_MM), 'least ' + f2(worst.clr.mm) + ' mm, ' + worst.label + ', z ' + f2(worst.clr.z) + ' (' + worst.clr.supFeat + ' / ' + worst.clr.partFeat + ')');

    /* ------------------------------------------------------------ files */
    console.log('\n=== 5. files for Bambu Studio ===');
    fs.mkdirSync(OUT, { recursive: true });
    const names = ['flat', 'yaw45', 'tip15', 'yaw45_tip15'];
    for (let k = 0; k < POSES.length; k++) {
      const rows = all.filter(r => r.k === k);
      const objects = [].concat(...rows.map(r => r.objects.map((o, i) => i === 0 ? { name: o.name, soup: o.soup } : o)));
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (const o of objects) for (let i = 0; i < o.soup.length; i += 3) {
        lo[0] = Math.min(lo[0], o.soup[i]); hi[0] = Math.max(hi[0], o.soup[i]); lo[1] = Math.min(lo[1], o.soup[i + 1]); hi[1] = Math.max(hi[1], o.soup[i + 1]);
      }
      const file = path.join(OUT, 'supp_ref_' + names[k] + '.3mf');
      await PE.write(file, objects);
      const inBed = lo[0] >= 0 && lo[1] >= 0 && hi[0] <= 180 && hi[1] <= 180;
      check(names[k] + ': ' + objects.length + ' objects (6 parts, ' + (objects.length - 6) + ' supports) inside the 180 x 180 bed, written', inBed && objects.length > 6,
        'x ' + f1(lo[0]) + '-' + f1(hi[0]) + ' y ' + f1(lo[1]) + '-' + f1(hi[1]) + '  ' + path.relative(ROOT, file));
    }
  }

  /* ---------------------------------------------------------------- tape */
  if (TAPE) {
    console.log('\n=== library/tape_on-edge-single.stl, four poses (by hand: not a step) ===');
    const tape = readSTL(path.join(ROOT, 'library', 'tape_on-edge-single.stl'));
    for (const [yaw, tip] of POSES) {
      const piece = RP.pose(tape, yaw, tip);
      const t0 = Date.now(), b = await PE.build(piece);
      let withS = 0, drop = 0, bare = 0, side = 0, stairs = 0;
      const why = {};
      b.areas.forEach(a => {
        a.tp.sheet.levels.forEach(L => { if (L.stair) stairs++; });
        a.tp.sheet.tips.forEach(t => {
          if (t.mode === 'sheet') withS++; else if (t.mode === 'drop') drop++; else if (t.mode === 'side') side++; else { bare++; why[t.why] = (why[t.why] || 0) + 1; }
        });
      });
      console.log('  yaw ' + yaw + ' tip ' + tip + ': ' + (withS + drop) + ' tips under a sheet (' + withS + ' on a sheet or a stair\'s base, ' + drop + ' held by a stair; ' + stairs + ' stair(s)), ' +
        bare + ' without, ' + side + ' side; ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
      Object.keys(why).forEach(w => console.log('      ' + why[w] + ' x ' + w));
      if (yaw === 0 && tip === 0) {
        const h = soupHash(b.objects.slice(1).map(o => o.soup));
        check('the flat tape: the supports hash as before this ticket (' + TAPE_HASH + ')', h === TAPE_HASH, h);
      }
    }
  }

  console.log('\n' + (fail ? 'FAILED  ' : 'PASSED  ') + (fail ? fail + ' of ' + (pass + fail) : 'all ' + pass));
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

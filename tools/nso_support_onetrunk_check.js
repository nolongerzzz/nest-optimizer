#!/usr/bin/env node
/* ============================================================
   tools/nso_support_onetrunk_check.js - supports-one-trunk: Auto supports grown the way
   Bambu's tree slim grows them, measured on Bambu's own six test heads.   (npm run support:onetrunk)

   The ticket (the owner's, after #301): make the supports look and work as Bambu's do - ONE trunk
   where it can be one, the transition and the interface laid across a number of surfaces as Bambu
   lays them. #301 laid a sheet under every surface and left the tree as it was: six trunks and a
   lattice of square posts under a head Bambu holds up with one. This file is that comparison, run:

   1. THE REFERENCE (fixtures/supports/tree_slimsupports.gcode.3mf, Bambu Studio, A1 mini, tree slim,
      read with tools/nso_slicer_audit.js): per part, how many trunks stand on the plate, where the
      trunk stands against the middle of its interface, and the support toolpath.
   2. OURS, the six real parts (tools/nso_support_ref_pieces.js, flat) built as the card builds in
      Auto with its ONE TRUNK box ticked (opts.oneTrunk, areas grouped by
      NSO_SupportGridpack.oneTrunkGroups), and as it built before (box off), then SLICED with NSO_Slicer
      (whose typeSupports labels each line Support / transition / interface).
   3. THE GATES: one trunk to a part (Bambu's own count); no more trunks than before anywhere; every spot
      of every area held (a thinned spot through the tip beside it) or named; the trunk stands under the
      sheet (within 3 mm in plan: Bambu's stands within 1.5); the gap 0.18 mm and the sideways 0.35 mm
      keep; a sheet or a stair under each surface Bambu has one under, that ours reaches.
   Findings, not gates, are printed: the surfaces ours does not lay a sheet on, and the toolpath against
   Bambu's.

     node tools/nso_support_onetrunk_check.js             all six parts
     node tools/nso_support_onetrunk_check.js base,oblique    some
     node tools/nso_support_onetrunk_check.js --export    + tools/supports-onetrunk-out/supp_ref_onetrunk.3mf for Studio
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RP = require('./nso_support_ref_pieces.js');
const PE = require('./nso_supports_print_export.js');
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require('../nso-3mf-read.js');
const SL = require('../nso_slicer.js');
const GP = require('../nso_support_gridpack.js');
const SI = require('../nso_support_interface.js');

const REF_FILE = path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
const GAP = 0.18, XY_MM = 0.35;
const args = process.argv.slice(2);
const EXPORT = args.includes('--export');
/* the card's own build: the spots kept 1 mm in from the edge of the surface and the sheet and its caps kept to the part (docs/SUPPORT-FOOTPRINT.md); --as-it-was builds it without */
const OUTLINE = !args.includes('--as-it-was');
const ONLY = (args.find(a => !a.startsWith('--')) || '').split(',').filter(Boolean);
const OUT = path.join(ROOT, 'tools', 'supports-onetrunk-out');
const SLICE_OPTS = SL.defaultsFor(0.4, { supportInterfaceLayers: 3 });   /* the dense sheet's three interface layers */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);

/* ---------------------------------------------------------------- helpers shared with support:everywhere's reading of a slice */
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
function surfacesOf(rows) {            /* rows: { z, feat, pts: [[x, y]] } */
  const by = new Map();
  for (const l of rows) {
    const k = l.z.toFixed(3) + '|' + l.feat, r = by.get(k) || { z: l.z, feat: l.feat, bb: [Infinity, Infinity, -Infinity, -Infinity] };
    for (const q of l.pts) r.bb = [Math.min(r.bb[0], q[0]), Math.min(r.bb[1], q[1]), Math.max(r.bb[2], q[0]), Math.max(r.bb[3], q[1])];
    by.set(k, r);
  }
  return groupsOf([...by.values()].sort((a, b) => a.z - b.z || (a.feat < b.feat ? -1 : 1)));
}
function labelledLines(r) {
  const out = [];
  for (const ob of r.objects) {
    if (ob.role !== 'support') continue;
    for (const L of ob.layers) for (const p of (L.paths || [])) {
      out.push({ z: L.printZ, feat: p.feature, pts: p.pts, closed: !!p.closed });
    }
  }
  return out;
}
function pathLen(l) {
  let n = 0;
  for (let i = 0; i + 1 < l.pts.length; i++) n += Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
  if (l.closed && l.pts.length > 2) n += Math.hypot(l.pts[0][0] - l.pts[l.pts.length - 1][0], l.pts[0][1] - l.pts[l.pts.length - 1][1]);
  return n;
}
/* the sideways clearance of support lines to the part's, as support:everywhere reads it */
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
  let best = { mm: Infinity, z: null };
  const CS = 2, key = (i, k) => i + ',' + k;
  part.layers.forEach((PL, j) => {
    let ps = segsOf(PL.paths || []);
    if (!ps.length) return;
    const walls = ps.filter(s => /wall/i.test(s[4])), crosses = (a, b) => {
      const o = (p, q, rr) => (q[0] - p[0]) * (rr[1] - p[1]) - (q[1] - p[1]) * (rr[0] - p[0]);
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
            if (d < best.mm) best = { mm: d, z: PL.printZ };
          }
        }
      }
    }
  });
  return best;
}


/* how far under the part a sheet's top is, over every cell of it: a vertical ray from each top face of the support's soup (the
   faces at z) up to the part's first face above - the worst of them, mm */
function sheetGapMax(piece, supSoup, z) {
  const T = [];
  for (let i = 0; i + 8 < piece.length; i += 9) if (Math.max(piece[i + 2], piece[i + 5], piece[i + 8]) > z) T.push(i);
  let worst = null;
  for (let i = 0; i + 8 < supSoup.length; i += 9) {
    if (Math.abs(supSoup[i + 2] - z) > 0.02 || Math.abs(supSoup[i + 5] - z) > 0.02 || Math.abs(supSoup[i + 8] - z) > 0.02) continue;
    const x = (supSoup[i] + supSoup[i + 3] + supSoup[i + 6]) / 3, y = (supSoup[i + 1] + supSoup[i + 4] + supSoup[i + 7]) / 3;
    let best = Infinity;
    for (const k of T) {
      const ax = piece[k], ay = piece[k + 1], bx = piece[k + 3], by = piece[k + 4], cx = piece[k + 6], cy = piece[k + 7];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const zz = l1 * piece[k + 2] + l2 * piece[k + 5] + l3 * piece[k + 8];
      if (zz > z + 0.001 && zz - z < best) best = zz - z;
    }
    if (isFinite(best) && (worst == null || best > worst)) worst = best;
  }
  return worst;
}

/* ---------------------------------------------------------------- 1. the reference */
/* connected pieces of the Support lines on one layer: segments whose ends lie within `r` of one another */
function islands(segs, r) {
  const n = segs.length, par = segs.map((_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const A = segs[a], B = segs[b];
    if (segSegDist(A.x0, A.y0, A.x1, A.y1, B.x0, B.y0, B.x1, B.y1) <= r) par[find(a)] = find(b);
  }
  const g = new Map();
  segs.forEach((s, i) => { const k = find(i); if (!g.has(k)) g.set(k, []); g.get(k).push(s); });
  return [...g.values()];
}
const segLen = s => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);

(async () => {
  const WASM = await SL.loadKernel({});
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF_FILE)));
  const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
  const dec = new TextDecoder();
  const gcode = dec.decode(await zip.read(gname));
  const names = AUDIT.sliceNames(dec.decode(await zip.read('Metadata/slice_info.config')));
  const nm = {};
  Object.keys(names).forEach(id => { nm[id] = names[id].replace(/^Support /, '').replace(/\.stl$/, '').replace(/ /g, '').replace(/^Negative/, 'Neg'); });
  const keyOf = { Base: 'base', Oblique: 'oblique', Circular: 'circular', Sphere: 'sphere', NegSphere: 'negsphere', NegSphere2: 'negsphere2' };

  console.log('\n=== 1. the reference: what Bambu stands under each head ===');
  const mv = AUDIT.extrusions(gcode), ref = {};
  for (const id of Object.keys(nm)) {
    const key = keyOf[nm[id]];
    const mine = mv.filter(m => +m.obj === +id && /^Support/.test(m.feat || ''));
    /* the trunks: the islands of Support line on the layers just above the first (a stray dot of one line is not one) */
    const low = mine.filter(m => m.feat === 'Support' && m.z > 0.35 && m.z < 1.3 && segLen(m) > 0.3);
    const byZ = new Map();
    low.forEach(m => { const k = m.z.toFixed(2); if (!byZ.has(k)) byZ.set(k, []); byZ.get(k).push(m); });
    let trunks = 0, foot = null;
    for (const segs of byZ.values()) {
      const isl = islands(segs, 0.9).filter(g => g.reduce((a, s) => a + segLen(s), 0) > 5);
      if (isl.length > trunks) trunks = isl.length;
      if (!foot && isl.length) { const pts = [].concat(...isl.map(g => g.map(s => [s.x0, s.y0]))); foot = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]; }
    }
    const sheetL = mine.filter(m => m.feat !== 'Support');
    const cen = sheetL.length ? [sheetL.reduce((a, m) => a + (m.x0 + m.x1) / 2, 0) / sheetL.length, sheetL.reduce((a, m) => a + (m.y0 + m.y1) / 2, 0) / sheetL.length] : null;
    const toolpath = mine.reduce((a, m) => a + segLen(m), 0);
    ref[key] = { name: nm[id], trunks, foot, cen, off: foot && cen ? Math.hypot(foot[0] - cen[0], foot[1] - cen[1]) : null, toolpath };
    console.log('        ' + nm[id].padEnd(11) + ' trunks ' + trunks + '   foot-to-interface-centre ' + (ref[key].off == null ? '-' : f2(ref[key].off)) + ' mm   support toolpath ' + (toolpath / 1000).toFixed(2) + ' m');
  }
  check('Bambu stands one trunk under a head, two under NegSphere2 (its rim is two pieces apart)', Object.keys(ref).length === 6 && Object.values(ref).every(r => r.trunks === 1 || (r.name === 'NegSphere2' && r.trunks === 2)),
    Object.values(ref).map(r => r.name + ' ' + r.trunks).join(', '));

  /* ---------------------------------------------------------------- 2. ours */
  console.log('\n=== 2. ours: the card\'s Auto, the six real parts, flat ===');
  console.log('        part         trunks (before)  tips  held  surfaces ours (z first T .. last I, T, I, footprint)            gap     sideways   toolpath');
  const parts = {};
  for (const k of RP.NAMES) if (!ONLY.length || ONLY.includes(k)) parts[k] = await RP.build(k);
  const rows = [];
  for (const k of Object.keys(parts)) {
    const piece = parts[k];
    const oldB = await PE.build(piece, null, RP.PROJECT_NAME[k].replace(/\.stl$/, ''), false);
    const b = await PE.build(piece, null, RP.PROJECT_NAME[k].replace(/\.stl$/, ''), true, true, OUTLINE);
    const objs = [{ name: 'part', soup: piece, key: 101, role: 'part' }]
      .concat(b.objects.slice(1).map((x, i) => ({ name: x.name, soup: x.soup, key: 201 + i, role: x.brim ? 'brim' : 'support', hostKey: 101 })));
    const r = SL.sliceObjects(objs, SLICE_OPTS, WASM);
    if (!r.ok) throw new Error(k + ': the slice failed: ' + r.reason);
    const lines = labelledLines(r);
    const trunksOf = B => B.areas.reduce((n, a) => n + (a.sh.members || []).filter(m => m.kind === 'trunk').length, 0);
    const row = { key: k, b, oldB, trunks: trunksOf(b), trunksBefore: trunksOf(oldB), clr: minClearance(r), ms: b.ms };
    /* tips: every beacon of every area is a tip that is built, a spot a tip beside it holds, or named */
    let tips = 0, spots = 0, covered = 0, unsupported = 0, notes = 0;
    for (const a of b.areas) {
      const p = a.p, S = a.tp.sheet;
      tips += p.oneTrunk ? p.oneTrunk.tips : p.beacons.length;
      spots += p.oneTrunk ? p.oneTrunk.beacons : p.beacons.length;
      covered += p.oneTrunk ? p.oneTrunk.thinned : 0;
      unsupported += (a.sh.unsupported || []).length + (p.unreachable || []).length + (p.inside || []).length;
      if (S) notes += (S.notes || []).length;
    }
    row.tips = tips; row.spots = spots; row.covered = covered; row.unsupported = unsupported;
    row.surfaces = surfacesOf(lines.filter(l => l.feat === 'Support interface' || l.feat === 'Support transition'));
    row.toolpath = lines.reduce((a, l) => a + pathLen(l), 0);
    /* what the slice makes of the tree: Support runs up beside the sheet (as Bambu's does, to within a layer or two of the sheet's top), and a trunk is one wall (hollow) */
    const supL = lines.filter(l => l.feat === 'Support'), tiL = lines.filter(l => l.feat !== 'Support');
    row.supTop = supL.length ? Math.max(...supL.map(l => l.z)) : 0; row.tiTop = tiL.length ? Math.max(...tiL.map(l => l.z)) : 0;
    /* how many layers of interface and transition lie over each 0.2 mm cell of the plan: a flat sheet is 5 (3 + 2); a stair, stepped on the slope, no deeper */
    {
      const cell = new Map(), CS = 0.2;
      const byZ = new Map();
      tiL.forEach(l => { const k = l.z.toFixed(2); (byZ.get(k) || byZ.set(k, []).get(k)).push(l); });
      byZ.forEach(ls => {
        const seen = new Set();
        ls.forEach(l => {
          const P = l.pts, n = l.closed ? P.length : P.length - 1;
          for (let e = 0; e < n; e++) {
            const a = P[e], b = P[(e + 1) % P.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), ns = Math.max(1, Math.ceil(len / 0.1));
            for (let q = 0; q <= ns; q++) {
              const x = Math.round((a[0] + (b[0] - a[0]) * q / ns) / CS), y = Math.round((a[1] + (b[1] - a[1]) * q / ns) / CS);
              for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) seen.add((x + dx) + ',' + (y + dy));
            }
          }
        });
        seen.forEach(k => cell.set(k, (cell.get(k) || 0) + 1));
      });
      const vs = [...cell.values()].sort((u, v) => u - v);
      row.stackP90 = vs.length ? vs[Math.floor(0.9 * (vs.length - 1))] : 0; row.stackMax = vs.length ? vs[vs.length - 1] : 0;
    }
    const at3 = supL.filter(l => Math.abs(l.z - 3.0) < 0.11);
    if (at3.length) {
      const xs = [].concat(...at3.map(l => l.pts.map(q => q[0]))), ys = [].concat(...at3.map(l => l.pts.map(q => q[1])));
      row.wallRatio = at3.reduce((a, l) => a + pathLen(l), 0) / (Math.PI * ((Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys))) / 2);
    }
    const gaps = [];
    b.areas.forEach(a => ((a.tp.sheet && a.tp.sheet.levels) || []).forEach(L => { if (L.minDistanceMm != null && isFinite(L.minDistanceMm)) gaps.push(L.minDistanceMm); }));
    row.gap = gaps.length ? Math.min(...gaps) : null;
    /* the trunk against the middle of its sheet, in plan */
    const trunkAxes = [].concat(...b.areas.map(a => (a.p.crowns || []).map(c => c.axis)));
    const sl = lines.filter(l => l.feat === 'Support interface' || l.feat === 'Support transition');
    const cen = sl.length ? [sl.reduce((a, l) => a + l.pts.reduce((s, q) => s + q[0], 0) / l.pts.length, 0) / sl.length, sl.reduce((a, l) => a + l.pts.reduce((s, q) => s + q[1], 0) / l.pts.length, 0) / sl.length] : null;
    row.off = trunkAxes.length && cen ? Math.min(...trunkAxes.map(t => Math.hypot(t[0] - cen[0], t[1] - cen[1]))) : null;
    row.notes = notes;
    /* the brim built with the supports: its own object, sliced as the brim, on the first layer only, off the pads and the part */
    const bo = r.objects.find(x => x.role === 'brim');
    row.brim = bo ? { loops: bo.layers[0].paths.filter(p => p.feature === 'Brim').length, other: bo.layers.slice(1).reduce((n, L) => n + L.paths.length, 0) + bo.layers[0].paths.filter(p => p.feature !== 'Brim').length,
      conflicts: r.conflicts.length, partBrim: r.objects.find(x => x.role === 'part').layers[0].paths.filter(p => p.feature === 'Brim').length } : null;
    const lv0 = [].concat(...b.areas.map(a => (a.tp.sheet && a.tp.sheet.levels) || []))[0];
    /* nothing stands over the sheet's top: no speck of support in the air above where the supports stop */
    const topZ = Math.max(...[].concat(...b.areas.map(a => (a.tp.sheet && a.tp.sheet.levels) || [])).map(L => L.zTop || 0));
    let maxZ = -Infinity;
    for (let i = 2; i < b.objects[1].soup.length; i += 3) if (b.objects[1].soup[i] > maxZ) maxZ = b.objects[1].soup[i];
    row.over = maxZ - topZ;
    row.maxGap = lv0 && lv0.zTop != null ? sheetGapMax(piece, b.objects[1].soup, lv0.zTop) : null;
    rows.push(row);
    console.log('        ' + k.padEnd(12) + String(row.trunks).padStart(3) + ' (' + row.trunksBefore + ')' + String(row.tips).padStart(9) + String(row.spots - row.unsupported).padStart(4) + '/' + String(row.spots).padEnd(4) +
      (row.surfaces.length ? row.surfaces.map(g => `z ${f2(g.z0)}-${f2(g.z1)} T${g.T} I${g.I} ${f1(g.w)}x${f1(g.d)}`).join(' | ') : 'none').padEnd(60) +
      (row.gap == null ? '-' : f2(row.gap)).padEnd(8) + (row.clr.mm < Infinity ? f2(row.clr.mm) : '-').padEnd(10) + (row.toolpath / 1000).toFixed(2) + ' m (Bambu ' + (ref[k].toolpath / 1000).toFixed(2) + ')   ' + (row.ms / 1000).toFixed(1) + ' s');
  }

  /* ---------------------------------------------------------------- 3. gates */
  console.log('\n=== 3. the gates ===');
  check('no more trunks under a head than Bambu stands (ONE, where the box is ticked)', rows.every(r => r.trunks <= ref[r.key].trunks), rows.map(r => r.key + ' ' + r.trunks + ' (Bambu ' + ref[r.key].trunks + ')').join(', '));
  check('...and never more trunks than the box off builds', rows.every(r => r.trunks <= r.trunksBefore), rows.map(r => r.key + ' ' + r.trunks + '/' + r.trunksBefore).join(', '));
  check('every spot of every area is held - by a tip of its own, or by the tip it lies beside (within the sheet\'s reach) - or named', rows.every(r => r.unsupported === 0),
    rows.map(r => r.key + ' ' + (r.spots - r.unsupported) + '/' + r.spots + ' (' + r.covered + ' by a neighbouring tip)').join(', '));
  check('the trunk stands under its sheet: its axis within 3 mm of the middle of the transition and interface lines in plan (Bambu\'s: ' +
    Object.values(ref).map(x => f1(x.off)).join(' / ') + ')', rows.every(r => r.off != null && r.off <= 3), rows.map(r => r.key + ' ' + (r.off == null ? '-' : f1(r.off))).join(', '));
  /* THE TAPERED BASE, and the same trunk under every head: no straight stick (it can pop off the plate in the print) */
  const trunkRings = [].concat(...rows.map(r => (r.b.sf.trunks || []).map(t => ({ key: r.key, rings: t.rings || [] }))));
  const rad = ring => Math.max(ring[1], ring[2] == null ? 0 : ring[2]);
  const base = trunkRings.map(t => t.rings.length ? rad(t.rings[0]) : 0);
  /* the ring at the flare's top (the flare is a curve now: rings between the plate and it) */
  const tops = trunkRings.map(t => { const q = t.rings.find(r => Math.abs(r[0] - GP.TRUNK.flareMm) < 0.15); return q ? rad(q) : (t.rings.length > 1 ? rad(t.rings[t.rings.length - 1]) : Infinity); });
  check('every trunk is tapered: its base at least 1.4 x as wide as it is at the flare\'s top (' + GP.TRUNK.flareMm + ' mm), widening all the way down',
    trunkRings.length > 0 && trunkRings.every((t, i) => t.rings.length > 1 && base[i] >= 1.4 * tops[i] && t.rings.every((q, j) => j === 0 || rad(q) <= rad(t.rings[j - 1]) + 1e-9)),
    trunkRings.map((t, i) => t.key + ' ' + f1(2 * base[i]) + ' -> ' + f1(2 * tops[i]) + ' mm').join(', '));
  /* the pad: a hand wider than the trunk's base (Bambu's is round the model's stem), not a plate; the base stands inside its edge */
  /* a pad may hold several trunks (a head with a second surface, e.g. a Negative Sphere's apex): it is judged against the
     bases of the trunks it holds, together (their bounding box), not against the first alone */
  const padSpread = rows.map(r => {
    const po = (r.b.sf.padOutlines || [])[0];
    const held = (r.b.sf.trunks || []).filter(t => po && (po.from || []).some(f => f[0] === t.from[0] && f[1] === t.from[1]));
    if (!held.length || !po) return null;
    const xs = po.poly.map(q => q[0]), ys = po.poly.map(q => q[1]);
    const bx = held.map(t => [t.c[0] - t.padR, t.c[0] + t.padR]), by = held.map(t => [t.c[1] - t.padR, t.c[1] + t.padR]);
    const baseW = Math.max(Math.max(...bx.map(q => q[1])) - Math.min(...bx.map(q => q[0])), Math.max(...by.map(q => q[1])) - Math.min(...by.map(q => q[0])));
    return { key: r.key, pad: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), base: held.length === 1 ? 2 * held[0].padR : baseW, n: held.length };
  }).filter(Boolean);
  check('the pad is a hand wider than the trunk\'s base: no more than 1.6 mm wider across (0.6 round it), the base inside its edge',
    padSpread.length > 0 && padSpread.every(x => x.pad >= x.base - 1e-6 && x.pad - x.base <= 1.6 + 1e-6),
    padSpread.map(x => x.key + ' pad ' + f1(x.pad) + ' base ' + f1(x.base) + (x.n > 1 ? ' (' + x.n + ' trunks)' : '')).join(', '));
  check('the same trunk under every head: bases within 15 % of one another, and round', base.length > 0 && Math.max(...base) <= 1.15 * Math.min(...base) &&
    trunkRings.every(t => t.rings.length && Math.abs(t.rings[0][1] - t.rings[0][2]) < 0.2), 'bases ' + base.map(v => f1(2 * v)).join(' / ') + ' mm');
  check('a brim is built with every head\'s supports (its own object, role brim): 5 loops or more of Brim on the first layer and nothing else, none on the part, no conflict with the pads or the part',
    rows.every(r => r.brim && r.brim.loops >= 5 && r.brim.other === 0 && r.brim.partBrim === 0 && r.brim.conflicts === 0),
    rows.map(r => r.key + ' ' + (r.brim ? r.brim.loops + ' loops' : 'none')).join(', '));
  /* THE BRANCHES: one smooth body to a crown (no ball at a join, no square tube): closed, outward-wound, and every crown has one */
  function bodyOf(soup) {
    const m = new Map(), key = (x, y, z) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let vol = 0;
    for (let i = 0; i < soup.length; i += 9) {
      const P = [0, 1, 2].map(k => key(soup[i + 3 * k], soup[i + 3 * k + 1], soup[i + 3 * k + 2]));
      for (let k = 0; k < 3; k++) { const a = P[k], b = P[(k + 1) % 3], e = a < b ? a + '|' + b : b + '|' + a, d = a < b ? 1 : -1, r = m.get(e) || { n: 0, d: 0 }; r.n++; r.d += d; m.set(e, r); }
      vol += (soup[i] * (soup[i + 4] * soup[i + 8] - soup[i + 5] * soup[i + 7]) - soup[i + 1] * (soup[i + 3] * soup[i + 8] - soup[i + 5] * soup[i + 6]) + soup[i + 2] * (soup[i + 3] * soup[i + 7] - soup[i + 4] * soup[i + 6])) / 6;
    }
    let open = 0, bad = 0;
    m.forEach(r => { if (r.n !== 2) open++; else if (r.d !== 0) bad++; });
    return { open, bad, vol, tris: soup.length / 9 };
  }
  const bodies = rows.map(r => {
    const out = { key: r.key, crowns: 0, smooth: [] };
    r.b.areas.forEach(a => (a.tp.trunks || []).forEach(t => { out.crowns++; (t.parts || []).forEach(q => { if (q.smooth) out.smooth.push(bodyOf(q.soup)); }); }));
    return out;
  });
  check('every crown\'s branches are one smooth body (no ball at a join): closed, outward-wound, a body to each crown', bodies.every(b => b.crowns > 0 && b.smooth.length >= 1 && b.smooth.length <= b.crowns + 1 && b.smooth.every(x => x.open === 0 && x.bad === 0 && x.vol > 0)),
    bodies.map(b => b.key + ' ' + b.crowns + ' crown(s), ' + b.smooth.length + ' body(ies) open ' + b.smooth.map(x => x.open + '/' + x.bad + '/' + x.vol.toFixed(0)).join(',') + ', ' + b.smooth.map(x => x.tris + ' triangles').join(' + ')).join('; '));
  /* THE STAIR'S LEGS: a stair's tips are rows of posts that climb the slope, one blade to a row, held by a leg every
     SHEET.denseStairLegMm along it - not a leg to every post (42 tips of the Oblique were 42 legs and one fat crown) */
  const stairRows = rows.map(r => {
    const out = { key: r.key, tips: 0, legs: 0, far: 0, members: 0, ok: true };
    r.b.areas.forEach(a => {
      ((a.tp.sheet && a.tp.sheet.levels) || []).filter(L => L.stair && L.stair.tips).forEach(L => {
        const legs = L.stair.tips.filter(w => w.leg !== false), posts = L.stair.tips.filter(w => w.leg === false);
        out.tips += L.stair.tips.length; out.legs += legs.length;
        posts.forEach(w => { const d = Math.min(...legs.map(q => Math.hypot(q.p[0] - w.p[0], q.p[1] - w.p[1]))); out.far = Math.max(out.far, d); });
        /* ...and none of them floats: every group of posts that overlap one another has a leg among them */
        const T = L.stair.tips, par = T.map((_, i) => i), fnd = i => par[i] === i ? i : (par[i] = fnd(par[i])), held = {};
        for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (Math.hypot(T[i].p[0] - T[j].p[0], T[i].p[1] - T[j].p[1]) <= 1.3 && Math.abs(T[i].p[2] - T[j].p[2]) < 2.4) par[fnd(i)] = fnd(j);
        T.forEach((w, i) => { if (w.leg !== false) held[fnd(i)] = true; });
        out.floating = (out.floating || 0) + T.filter((w, i) => !held[fnd(i)]).length;
        const tr = ((a.tp.sheet && a.tp.sheet.stairTrees) || (a.tp.stairTrees) || []).find(t => t.level === L.id);
        if (tr) out.members += tr.members;
        if (legs.length > Math.max(3, Math.ceil(L.stair.tips.length / 3)) || out.far > 0.65 * SI.SHEET.denseStairLegMm + 0.7 || (tr && tr.unreachable) || out.floating) out.ok = false;
      });
    });
    return out;
  }).filter(x => x.tips);
  check('a stair\'s tips are a few legs under rows of posts: no more than a third of its tips are legs, every other post is within ' + f2(0.65 * SI.SHEET.denseStairLegMm + 0.7) + ' mm of one, and no post floats (each group of overlapping posts has a leg)',
    stairRows.length >= 1 && stairRows.every(x => x.ok), stairRows.map(x => x.key + ' ' + x.legs + ' legs of ' + x.tips + ' tips (farthest post ' + f2(x.far) + ' mm), ' + x.members + ' crown members, ' + (x.floating || 0) + ' floating').join(', '));
  /* THE LEAN: no branch that is built lies nearly flat (the owner's, off the Oblique: "comes off the trunk at a 90 ... won't print"): a leg of the plan's
     that a stair does not hold is under CROWN_LEAN_HARD_DEG, and a stair's own tree holds the lean limit (50 deg) */
  const leans = rows.map(r => {
    let hostMax = 0, stairMax = 0;
    r.b.areas.forEach(a => {
      const held = {};
      ((a.tp.sheet && a.tp.sheet.tips) || []).forEach(t => { if (t.mode === 'drop') held[t.beacon] = true; });
      (a.p.members || []).forEach(m => {
        if (m.dead || m.kind === 'trunk' || !m.path || (m.beacons && m.beacons.length && m.beacons.every(bk => held[bk]))) return;
        for (let i = 0; i + 1 < m.path.length; i++) {
          const dz = Math.abs(m.path[i + 1][2] - m.path[i][2]), dh = Math.hypot(m.path[i + 1][0] - m.path[i][0], m.path[i + 1][1] - m.path[i][1]);
          if (dz + dh > 1e-6) hostMax = Math.max(hostMax, Math.atan2(dh, dz) * 180 / Math.PI);
        }
      });
      ((a.tp.sheet && a.tp.sheet.stairTrees) || []).forEach(t => { stairMax = Math.max(stairMax, t.maxLeanDeg || 0); });
    });
    return { key: r.key, hostMax, stairMax };
  });
  check('no built branch lies flat: the plan\'s legs under 75 deg from vertical, a stair\'s own tree under 50',
    leans.every(x => x.hostMax <= 75 + 0.5 && x.stairMax <= 50 + 0.5), leans.map(x => x.key + ' ' + f1(x.hostMax) + (x.stairMax ? ' / stair ' + f1(x.stairMax) : '')).join(', '));
  check('the tree runs up with the sheet: a line of Support within 1.5 mm of the top of the interface and transition (under a stair, Support beside every strip; the oblique\'s stair stands 4.2 mm)',
    rows.every(r => r.tiTop - r.supTop <= 1.5 + 1e-9), rows.map(r => r.key + ' Support to ' + f2(r.supTop) + ', sheet to ' + f2(r.tiTop)).join(', '));
  check('the sheet is as deep as a flat one wherever it lies: over 90 % of the plan, no more than 6 layers of interface and transition (a flat sheet is 5), the stair as much as the flat heads',
    rows.every(r => r.stackP90 <= 6), rows.map(r => r.key + ' p90 ' + r.stackP90 + ' max ' + r.stackMax).join(', '));
  check('a trunk is hollow: at 3 mm its lines are one wall round it (their length no more than 1.5 x the circle of its width), no infill inside',
    rows.every(r => r.wallRatio == null || r.wallRatio <= 1.5), rows.map(r => r.key + ' ' + (r.wallRatio == null ? '-' : r.wallRatio.toFixed(2))).join(', '));
  check('no support stands over the sheet\'s top (no speck in the air where the supports stop)', rows.every(r => r.over <= 0.05),
    rows.map(r => r.key + ' ' + f2(r.over)).join(', '));
  check('a sheet under a curved head stays where the part is near it: no more than 1.5 mm under the part over any cell of the plate, and its middle within 1.5 mm of the trunk\'s',
    rows.filter(r => r.key === 'circular' || r.key === 'sphere').every(r => r.maxGap != null && r.maxGap <= 1.5 && r.off <= 1.5),
    rows.filter(r => r.key === 'circular' || r.key === 'sphere').map(r => r.key + ' gap ' + (r.maxGap == null ? '-' : f2(r.maxGap)) + ' off ' + (r.off == null ? '-' : f1(r.off))).join(', '));
  check('the gap holds on every sheet and stair: 0.18 mm to the part, at the nearest point', rows.every(r => r.gap == null || r.gap >= GAP - 1e-5),
    'least ' + f2(Math.min(...rows.map(r => r.gap == null ? Infinity : r.gap))) + ' mm');
  check('SIDEWAYS: every support line keeps ' + XY_MM + ' mm from the part\'s lines in every layer of the slice (the slice\'s support_object_xy_distance)',
    rows.every(r => r.clr.mm >= XY_MM), 'least ' + f2(Math.min(...rows.map(r => r.clr.mm))) + ' mm');
  check('every part has a transition and an interface under it (a sheet, or a stair)', rows.every(r => r.surfaces.length >= 1 && r.surfaces.every(s => s.T >= 1 && s.I >= 1)),
    rows.map(r => r.key + ' ' + r.surfaces.length).join(', '));
  /* the surfaces Bambu lays a sheet on at the same height as ours: its top within 0.6 mm */
  const REFTOP = { base: [14.80], oblique: [12.20], circular: [9.40], sphere: [10.00], negsphere: [10.40, 14.20], negsphere2: [10.40, 15.20] };
  for (const r of rows) {
    const mine = r.surfaces.map(s => s.z1), want = REFTOP[r.key];
    const hit = want.map(w => mine.some(m => Math.abs(m - w) <= 0.8));
    check(r.key + ': a sheet at the height Bambu has its interface top (' + want.join(' / ') + ')', hit[0], 'ours ' + (mine.map(f2).join(' / ') || 'none') +
      (hit.every(Boolean) ? '' : '   - not laid: ' + want.filter((w, i) => !hit[i]).join(', ') + ' (finding)'));
  }
  console.log('\n        findings: toolpath ours / Bambu: ' + rows.map(r => r.key + ' ' + (r.toolpath / ref[r.key].toolpath).toFixed(2) + 'x').join(', '));

  if (EXPORT) {
    fs.mkdirSync(OUT, { recursive: true });
    const objects = [];
    let n = 0;
    for (const r of rows) {
      objects.push({ name: RP.PROJECT_NAME[r.key].replace(/\.stl$/, ''), soup: r.b.objects[0].soup });
      r.b.objects.slice(1).forEach(o => objects.push(o));
      n++;
    }
    const file = path.join(OUT, 'supp_ref_onetrunk.3mf');
    await PE.write(file, objects);
    console.log('  wrote ' + path.relative(ROOT, file) + ' (' + n + ' parts)');
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

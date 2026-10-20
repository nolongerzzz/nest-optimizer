#!/usr/bin/env node
/* ============================================================
   tools/nso_slicer_audit.js - would a slicer add support to NSO's supports?

   A slicer reads NSO's trees as model geometry and applies its own overhang
   rule to them. Bambu Studio, supports on, threshold 30 deg: a face leaning
   more than 30 deg off vertical with nothing under it gets support - and the
   "supports recommended" prompt - whether it belongs to the part or to a tree
   NSO built to hold the part. This tool asks Bambu's question of the trees
   before the slicer does.

   THE RULE, per downward-facing triangle of a support mesh:
     (a) it leans more than maxFromVerticalDeg (30) off vertical:
         n.z < -sin(30 deg) = -0.5 (a vertical wall is 0 deg, a flat
         underside 90 deg), with LEAN_TOL so float32 noise on a face built
         at exactly 30 deg does not decide;
     (b) straight down from it there is nothing within one layer (0.2 mm):
         not the support itself, not another support, not the part, not the
         plate.
   The down ray is asked at SAMPLES points of the triangle (its centroid and
   the points halfway to each corner), so a triangle half over a column is
   half flagged, and the flagged area does not depend on how the face was cut.
   The rays go through nso_support_aim.js's own footprint index
   (_buildDownGrid / _nearestHitDown) - the index every detection ray in the
   planner already goes through - not a second one.

   A spot inside another solid (two parts that overlap without being
   unioned) stands on material and is not flagged.

   Flagged triangles are grouped into regions by shared (welded) vertices.
   Each region reports its area, its box and its centroid, per object.

   CALIBRATION (--gcode). Bambu's own answer for the same plate: every
   `; FEATURE: Support interface` path in Metadata/plate_1.gcode, sampled
   every 0.2 mm, put in the export's frame (--shift: the slice's XY minus the
   export's - Bambu re-centres a plate it arranges), and classed by what it
   holds up: its nearest point on a support mesh lying within one interface
   stack plus the gap (0.65 mm: two 0.2 mm interface layers and the 0.2 mm
   top distance, and a hair) and ABOVE it is TOP interface under that tree;
   on the part, top interface under the part; something that close but not
   above (Bambu's support standing on it, or passing beside it), BOTTOM
   interface. A ray straight up is not the test: on a slope or a leaning
   bar the face a line holds is beside it as well as above. The
   top-under-a-tree points
   are clustered (adjacent layers, 1 mm in XY) into Bambu's regions. A Bambu
   region MATCHES when an audit sample that was flagged lies within MATCH_XY
   of one of its points, and between 0 and MATCH_DZ above it. An audit region
   Bambu LEFT ALONE is one none of whose flagged samples has a Bambu top
   interface point that close.

   THE SHADOW (also --gcode): straight up from every interface line, what is
   met first - the part; a tree, with the part above it; a tree and nothing
   above it (and of those, the ones with the tree within 1 mm, which is
   interface holding up a tree alone); or nothing. Bambu projects its support
   down from the overhangs it found, so the column says whose overhang a line
   belongs to even where a tree crosses the column on the way down.

   USAGE
     node tools/nso_slicer_audit.js export.3mf
     node tools/nso_slicer_audit.js export.3mf --gcode sliced.gcode.3mf --shift -2.25,0
     node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf [--export export.3mf] [--shift dx,dy]
                                    the interface sheet as printed (THE SHEET, AS PRINTED, below)
     options: --supports 2-12   object ids that are supports (default: every
                                object named "... - support N.M (...)")
              --json            the full result as JSON

   API (require('./tools/nso_slicer_audit.js'))
     audit(supports, occluders, opts) -> { ok, flaggedAreaMm2, objects:[...], regions:[...] }
       supports  [{ id, name, soup }]    occluders [soup] (the part)
       opts: maxFromVerticalDeg (30), layerMm (0.2), plateZ (lowest z of all),
             samples (4), minRegionMm2 (0)
     bambuInterface(gcodeText, objects, opts) -> { points, regions, counts }
     calibrate(auditResult, bambu, opts) -> { regions, matched, matchRate, ... }
   ============================================================ */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const SA = require(path.join(ROOT, 'nso_support_aim.js'));

const MAX_FROM_VERTICAL_DEG = 30;   /* Bambu Studio's default support threshold */
const LAYER_MM = 0.2;               /* one slicer layer: the reach of "nothing under it" */
const LEAN_TOL = 1e-4;              /* nso_support_gridpack.js's: a face at exactly the limit is not over it */
const RAY_EPS_MM = 1e-3;            /* nso_support_aim.js's: start just under the face */
const WELD_MM = 1e-3;
const IFACE_REACH_MM = 0.65;        /* two interface layers + the top z distance + a hair */
const MATCH_XY_MM = 1.5;            /* a Bambu interface line within this of a flagged spot holds it */
const MATCH_DZ_MM = 1.0;            /* ...and at most this far under it */
const LINK_XY_MM = 1.0;             /* Bambu points this close in XY, adjacent layers, are one region */

function triNormal(s, o) {
  const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
  const vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const L = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return L > 1e-15 ? { n: [nx / L, ny / L, nz / L], area: L / 2 } : null;
}

function boundsOf(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
  return { lo, hi };
}

/* A spot just under a face that is inside a solid - another part, or a part
   of the same object that overlaps it without being unioned - stands on
   material, however far the down ray has to go to leave it. */
function insideAny(boxes, q) {
  for (const { soup, b } of boxes) {
    if (q[0] < b.lo[0] || q[0] > b.hi[0] || q[1] < b.lo[1] || q[1] > b.hi[1] || q[2] < b.lo[2] || q[2] > b.hi[2]) continue;
    if (SA._windingInside(soup, q)) return true;
  }
  return false;
}

function lowestZ(soups) {
  let z = Infinity;
  for (const s of soups) for (let i = 2; i < s.length; i += 3) if (s[i] < z) z = s[i];
  return z;
}

/* The sample points of one triangle: centroid, then halfway to each corner. */
function samplesOf(s, o, k) {
  const a = [s[o], s[o + 1], s[o + 2]], b = [s[o + 3], s[o + 4], s[o + 5]], c = [s[o + 6], s[o + 7], s[o + 8]];
  const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const out = [g];
  for (const v of [a, b, c]) {
    if (out.length >= k) break;
    out.push([(g[0] + v[0]) / 2, (g[1] + v[1]) / 2, (g[2] + v[2]) / 2]);
  }
  return out;
}

function clusterByWeld(s, tris) {
  const parent = tris.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const seen = new Map();
  tris.forEach((t, i) => {
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      const key = Math.round(s[o] / WELD_MM) + '|' + Math.round(s[o + 1] / WELD_MM) + '|' + Math.round(s[o + 2] / WELD_MM);
      const p = seen.get(key);
      if (p === undefined) seen.set(key, i); else { const a = find(p), b = find(i); if (a !== b) parent[b] = a; }
    }
  });
  const groups = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return Array.from(groups.values());
}

function audit(supports, occluders, opts) {
  opts = opts || {};
  const maxDeg = opts.maxFromVerticalDeg == null ? MAX_FROM_VERTICAL_DEG : +opts.maxFromVerticalDeg;
  const layer = opts.layerMm == null ? LAYER_MM : +opts.layerMm;
  const k = opts.samples == null ? 4 : Math.max(1, Math.min(4, opts.samples | 0));
  const minRegion = opts.minRegionMm2 == null ? 0 : +opts.minRegionMm2;
  const nzMax = -Math.sin(maxDeg * Math.PI / 180) - LEAN_TOL;
  const soups = supports.map(o => o.soup).filter(s => s && s.length >= 9);
  const occ = (occluders || []).filter(s => s && s.length >= 9);
  const plateZ = opts.plateZ == null ? lowestZ(soups.concat(occ)) : +opts.plateZ;
  const grid = SA._buildDownGrid(soups.concat(occ));
  const boxes = soups.concat(occ).map(soup => ({ soup, b: boundsOf(soup) }));
  const out = { ok: true, maxFromVerticalDeg: maxDeg, layerMm: layer, plateZ, samples: k,
                flaggedAreaMm2: 0, downAreaMm2: 0, objects: [], regions: [] };

  for (const obj of supports) {
    const s = obj.soup, n = (s.length / 9) | 0;
    const rec = { id: obj.id, name: obj.name, tris: n, trisSteep: 0, steepAreaMm2: 0,
                  flaggedTris: 0, flaggedAreaMm2: 0, regions: [] };
    const flagged = [], frac = new Map(), spots = new Map();
    for (let t = 0; t < n; t++) {
      const tn = triNormal(s, t * 9);
      if (!tn || !(tn.n[2] < nzMax)) continue;
      rec.trisSteep++; rec.steepAreaMm2 += tn.area;
      const pts = samplesOf(s, t * 9, k), air = [];
      for (const p of pts) {
        if (p[2] - plateZ <= layer) continue;                         /* on the plate */
        const q = [p[0], p[1], p[2] - RAY_EPS_MM];
        if (SA._nearestHitDown(grid, q, 0, layer) >= 0) continue;
        if (insideAny(boxes, q)) continue;                            /* in another solid (parts that overlap) */
        air.push(p);
      }
      if (!air.length) continue;
      flagged.push(t); frac.set(t, tn.area * air.length / pts.length); spots.set(t, air);
    }
    if (flagged.length) {
      for (const g of clusterByWeld(s, flagged)) {
        let area = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], c = [0, 0, 0], pts = [];
        for (const i of g) {
          const t = flagged[i], a = frac.get(t);
          area += a;
          for (const p of spots.get(t)) {
            pts.push(p);
            for (let q = 0; q < 3; q++) { if (p[q] < lo[q]) lo[q] = p[q]; if (p[q] > hi[q]) hi[q] = p[q]; c[q] += p[q] * a / spots.get(t).length; }
          }
        }
        if (!(area > minRegion)) continue;
        const r = { object: obj.id, areaMm2: area, tris: g.length, lo, hi,
                    centroid: c.map(v => v / area), spots: pts };
        rec.regions.push(r);
        rec.flaggedTris += g.length; rec.flaggedAreaMm2 += area;
      }
      rec.regions.sort((a, b) => b.areaMm2 - a.areaMm2);
    }
    out.flaggedAreaMm2 += rec.flaggedAreaMm2; out.downAreaMm2 += rec.steepAreaMm2;
    out.objects.push(rec);
    out.regions.push(...rec.regions);
  }
  out.regions.sort((a, b) => b.areaMm2 - a.areaMm2);
  return out;
}

/* ------------------------------------------------------------ Bambu's side */

/* Every Support-interface extrusion of the g-code, sampled every `step` mm,
   in the export's frame. */
function interfacePoints(gcode, opts) {
  const shift = opts.shift || [0, 0], step = opts.stepMm || 0.2;
  const pts = [];
  let x = 0, y = 0, z = null, feat = null, rel = false;
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; Z_HEIGHT:')) { z = parseFloat(line.slice(11)); continue; }
    if (line.startsWith('; FEATURE:')) { feat = line.slice(10).trim(); continue; }
    const s = line.split(';')[0].trim();
    if (s.startsWith('G90')) { rel = false; continue; }
    if (s.startsWith('G91')) { rel = true; continue; }
    if (!(s.startsWith('G1 ') || s.startsWith('G0 '))) continue;
    let nx = x, ny = y, e = null, bad = false;
    for (const w of s.split(/\s+/).slice(1)) {
      const v = parseFloat(w.slice(1));
      if (!isFinite(v)) { bad = true; break; }
      if (w[0] === 'X') nx = (rel ? x : 0) + v; else if (w[0] === 'Y') ny = (rel ? y : 0) + v; else if (w[0] === 'E') e = v;
    }
    if (bad) continue;
    if (!rel && z != null && feat === 'Support interface' && e > 0 && (nx !== x || ny !== y)) {
      const L = Math.hypot(nx - x, ny - y), m = Math.max(1, Math.ceil(L / step));
      for (let i = 0; i <= m; i++) {
        const t = i / m;
        pts.push([x + (nx - x) * t - shift[0], y + (ny - y) * t - shift[1], z]);
      }
    }
    x = nx; y = ny;
  }
  return pts;
}

function clusterPoints(pts) {
  const parent = pts.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const cell = new Map(), key = (i, j, l) => i + '|' + j + '|' + l;
  pts.forEach((p, i) => {
    const ci = Math.floor(p[0] / LINK_XY_MM), cj = Math.floor(p[1] / LINK_XY_MM), cl = Math.round(p[2] / LAYER_MM);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let l = -1; l <= 1; l++) {
      const list = cell.get(key(ci + a, cj + b, cl + l));
      if (!list) continue;
      for (const q of list) {
        const P = pts[q];
        if (Math.hypot(P[0] - p[0], P[1] - p[1]) <= LINK_XY_MM && Math.abs(P[2] - p[2]) <= LAYER_MM * 1.5) {
          const r1 = find(q), r2 = find(i); if (r1 !== r2) parent[r2] = r1;
        }
      }
    }
    const k0 = key(ci, cj, cl);
    if (!cell.has(k0)) cell.set(k0, []);
    cell.get(k0).push(i);
  });
  const groups = new Map();
  pts.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  return Array.from(groups.values());
}

/* objects: [{ id, name, soup, support: bool }]. A point is TOP interface under
   whichever object's nearest point lies within IFACE_REACH_MM of it and
   above it (by more than half a layer: the line is under that surface, not
   beside it); the part wins a tie. Otherwise it is BOTTOM interface when
   something lies that close below it (Bambu's support standing on it), or
   neither. */
function bambuInterface(gcode, objects, opts) {
  opts = opts || {};
  const pts = interfacePoints(gcode, opts);
  const counts = { points: pts.length, topTree: 0, topPart: 0, bottom: 0, none: 0,
                   shadow: { partFirst: 0, treeThenPart: 0, treeOnly: 0, treeOnlyNear: 0, nothing: 0 } };
  const top = [], alone = [];
  const upPart = objects.filter(o => !o.support).map(o => o.soup), upSup = objects.filter(o => o.support).map(o => o.soup);
  for (const p of pts) {
    /* the column straight up: what this line is ultimately under */
    const hp = SA._nearestHit(upPart, p, [0, 0, 1], 0, Infinity), ht = SA._nearestHit(upSup, p, [0, 0, 1], 0, Infinity);
    const sh = counts.shadow;
    if (hp < 0 && ht < 0) sh.nothing++;
    else if (ht < 0 || (hp >= 0 && hp < ht)) sh.partFirst++;
    else if (hp >= 0) sh.treeThenPart++;
    else { sh.treeOnly++; if (ht <= 1.0) sh.treeOnlyNear++; }
    let best = null;
    for (const o of objects) {
      const c = SA._closestOnSoup(p, o.soup);
      if (!c || !(c.distance <= IFACE_REACH_MM)) continue;
      const above = c.point[2] - p[2] > LAYER_MM / 2;
      if (!best || (above && !best.above) || (above === best.above && (c.distance < best.d - 1e-9 ||
          (Math.abs(c.distance - best.d) <= 1e-9 && !o.support)))) best = { o, d: c.distance, above };
    }
    if (best && best.above) {
      if (best.o.support) { counts.topTree++; top.push(p); if (hp < 0) alone.push(p); } else counts.topPart++;
    } else if (best) counts.bottom++; else counts.none++;
  }
  const boxed = groups => groups.map(g => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of g) for (let q = 0; q < 3; q++) { if (p[q] < lo[q]) lo[q] = p[q]; if (p[q] > hi[q]) hi[q] = p[q]; }
    return { points: g, lo, hi };
  }).sort((a, b) => b.points.length - a.points.length);
  /* regions: every line under a tree; aloneRegions: those with no part
     anywhere above them - a tree's own overhang, not the part's support
     passing under a branch */
  return { points: pts, top, regions: boxed(clusterPoints(top)), alone, aloneRegions: boxed(clusterPoints(alone)), counts };
}

/* Does a Bambu point hold an audit spot: within MATCH_XY in plan, and
   0..MATCH_DZ under it. */
function holds(b, s) {
  const dz = s[2] - b[2];
  return dz >= -1e-6 && dz <= MATCH_DZ_MM && Math.hypot(s[0] - b[0], s[1] - b[1]) <= MATCH_XY_MM;
}

function calibrate(res, bambu) {
  const spots = [];
  res.regions.forEach((r, ri) => r.spots.forEach(s => spots.push({ s, ri })));
  /* plan-grid the spots for the lookup */
  const G = new Map(), key = (i, j) => i + '|' + j;
  spots.forEach((e, k) => {
    const kk = key(Math.floor(e.s[0] / MATCH_XY_MM), Math.floor(e.s[1] / MATCH_XY_MM));
    if (!G.has(kk)) G.set(kk, []);
    G.get(kk).push(k);
  });
  function near(b, fn) {
    const ci = Math.floor(b[0] / MATCH_XY_MM), cj = Math.floor(b[1] / MATCH_XY_MM);
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const list = G.get(key(ci + a, cj + c));
      if (list) for (const k of list) if (holds(b, spots[k].s)) fn(k);
    }
  }
  const auditHit = new Set();
  function rate(list) {
    let m = 0;
    list.forEach(r => { if (r.points.some(b => { let h = false; near(b, () => { h = true; }); return h; })) m++; });
    return { regions: list.length, matched: m, matchRate: list.length ? m / list.length : 1 };
  }
  let matched = 0, matchedPts = 0;
  const regions = bambu.regions.map(r => {
    let ok = false;
    for (const b of r.points) {
      let hitHere = false;
      near(b, k => { hitHere = true; auditHit.add(spots[k].ri); });
      if (hitHere) { ok = true; matchedPts++; }
    }
    if (ok) matched++;
    return { points: r.points.length, lo: r.lo, hi: r.hi, matched: ok };
  });
  let alone = 0, aloneArea = 0, area = 0;
  res.regions.forEach((r, ri) => { area += r.areaMm2; if (!auditHit.has(ri)) { alone++; aloneArea += r.areaMm2; } });
  return {
    bambuRegions: regions.length, matched, matchRate: regions.length ? matched / regions.length : 1,
    bambuPoints: bambu.top.length, matchedPoints: matchedPts,
    pointRate: bambu.top.length ? matchedPts / bambu.top.length : 1,
    auditRegions: res.regions.length, auditAlone: alone, auditAreaMm2: area, auditAloneAreaMm2: aloneArea,
    aloneAreaRate: area ? aloneArea / area : 0,
    treeAlone: rate(bambu.aloneRegions || []),
    unmatched: regions.filter(r => !r.matched)
  };
}

/* ---------------------------------------------------------- the sheet (--sheet) */

/* THE SHEET, AS PRINTED (--sheet). Given a slicer's g-code of an NSO export:
   how each interface-sheet line was printed. Bambu Studio reads NSO's sheet
   as model geometry, so a line becomes walls - and, with classic walls and
   thin walls off, a 0.42 mm line is a loop round a sliver (out and back, two
   passes) cut into 0.02 - 0.35 mm pieces wherever its overhang speed grade
   changes, and a line of 7.14 mm^2 or more is not printed at all
   (docs/SUPPORT-INTERFACE.md). Per sheet layer of every support object:
     segments     extrusion moves in the layer's sheet lines
     mean / median segment length, and the share of the extruded length in
                  segments under SEGMENT_MIN_MM
     E/mm         filament per mm of toolpath, and its ratio to the file's own
                  outer wall's E/mm
     passes       how many times each line was drawn: the toolpath of the
                  layer's thin chains over their length along themselves - a
                  line drawn once reads 1, a loop round a sliver (out and
                  back) 2
     E per mm of LINE: the ratio times the passes - what the bead amounts to
   A layer is OK when the E per mm of line is RATIO_TARGET +- RATIO_TOL of the
   outer wall's and at least SEGMENT_SHARE of its toolpath is in segments of
   SEGMENT_MIN_MM or more.
   A SHEET LAYER is one whose toolpath is mostly THIN CHAINS: unbroken runs
   of extrusion no wider across than THIN_MM - a sheet line printed in one
   pass, or as a loop round a sliver - where a column's loop, a cap's or a
   pad's are as wide as the column, cap or pad. With --export (the NSO 3MF
   that was sliced) the sheet's own lines are read off the export instead:
   only the moves on them are counted (a trunk or cap of the same object at
   that z is not), and each line is counted printed (its centreline covered
   by toolpath for COVER_SHARE of its length) or missing.
   sheetAudit(gcode, { names, boxes, shift }) -> { outerWallEmm, layers, ok } */
const SEGMENT_MIN_MM = 2, SEGMENT_SHARE = 0.9, RATIO_TARGET = 1, RATIO_TOL = 0.15;
const THIN_MM = 0.6, PASS_NEAR_MM = 0.3, COVER_SHARE = 0.8, THIN_SHARE = 0.75, MIN_SHEET_MM = 10;   /* PASS_NEAR_MM: a line is printed where toolpath runs this close to its centreline */

/* Every extrusion move: { z, h, feat, obj, x0, y0, x1, y1, e, len, chain }.
   G2/G3 arcs with E count as one move of their arc length, and carry pts:
   points along the arc (a round loop printed as two arcs is as wide as the
   loop, not its chord). G91 moves count from where the head is; E is the
   move's own filament whether the file is M83 (relative, Bambu's) or M82
   (absolute, from the last E or G92 E). */
function extrusions(gcode) {
  const out = [];
  let x = 0, y = 0, z = null, h = null, feat = null, obj = null, rel = false, chain = 0, prevZ = 0, absE = false, lastE = 0;
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; Z_HEIGHT:')) { prevZ = z == null ? 0 : z; z = parseFloat(line.slice(11)); chain++; continue; }
    if (line.startsWith('; LAYER_HEIGHT:')) { h = parseFloat(line.slice(15)); continue; }
    if (line.startsWith('; FEATURE:')) { feat = line.slice(10).trim(); continue; }
    let m = /^; start printing object, unique label id: (\d+)/.exec(line);
    if (m) { obj = +m[1]; chain++; continue; }
    if (line.startsWith('; stop printing object')) { obj = null; chain++; continue; }
    const s = line.split(';')[0].trim();
    if (!s) continue;
    if (s.startsWith('G90')) { rel = false; continue; }
    if (s.startsWith('G91')) { rel = true; continue; }
    if (/^M82\b/.test(s)) { absE = true; continue; }
    if (/^M83\b/.test(s)) { absE = false; continue; }
    if (/^G92\b/.test(s)) { const me = /\bE(-?[\d.]+)/.exec(s); if (me) lastE = parseFloat(me[1]); continue; }
    const g = /^G([0-3])\s/.exec(s + ' ');
    if (!g) continue;
    let nx = x, ny = y, e = null, I = 0, J = 0;
    for (const w of s.split(/\s+/).slice(1)) {
      const v = parseFloat(w.slice(1));
      if (!isFinite(v)) continue;
      if (w[0] === 'X') nx = (rel ? x : 0) + v; else if (w[0] === 'Y') ny = (rel ? y : 0) + v;
      else if (w[0] === 'E') e = v; else if (w[0] === 'I') I = v; else if (w[0] === 'J') J = v;
    }
    if (e != null && absE) { const de = e - lastE; lastE = e; e = de; }
    const moved = nx !== x || ny !== y;
    if (moved && e > 0 && z != null) {
      let len = Math.hypot(nx - x, ny - y), pts = null;
      if (g[1] === '2' || g[1] === '3') {
        const cx = x + I, cy = y + J, r = Math.hypot(I, J);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx), da = a1 - a0;
        if (g[1] === '3') { while (da <= 0) da += 2 * Math.PI; } else { while (da >= 0) da -= 2 * Math.PI; }
        len = r * Math.abs(da);
        const n = Math.max(2, Math.ceil(len / 0.2));
        pts = [];
        for (let q = 0; q <= n; q++) { const a = a0 + da * q / n; pts.push(q === n ? [nx, ny] : [cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      }
      const mv = { z, h: h || (z - prevZ), feat, obj, x0: x, y0: y, x1: nx, y1: ny, e, len, chain };
      if (pts) mv.pts = pts;
      out.push(mv);
    } else if (moved) chain++;
    x = nx; y = ny;
  }
  return out;
}

/* label id -> object name, off a .gcode.3mf's Metadata/slice_info.config */
function sliceNames(xml) {
  const names = {}, ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = t => t.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (w, k) =>
    k[0] === '#' ? String.fromCodePoint(k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : +k.slice(1)) : ent[k.toLowerCase()]);
  for (const m of String(xml || '').matchAll(/<object\s+identify_id="(\d+)"\s+name="([^"]*)"/g)) names[+m[1]] = decode(m[2]);
  return names;
}
/* the lowest z of a list of moves, without spreading it into one call (a
   print has hundreds of thousands) */
function lowestMoveZ(moves) { let z = Infinity; for (const m of moves) if (m.z < z) z = m.z; return z; }
/* a move's points: its two ends, or along its arc */
function movePts(m) { return m.pts || [[m.x0, m.y0], [m.x1, m.y1]]; }

/* The file's own outer wall: filament per mm over its non-support objects'
   outer walls above the first layer (every object's, when there is no part). */
function outerWallEmm(moves, isSupport) {
  const first = lowestMoveZ(moves);
  let E = 0, L = 0;
  const take = m => m.feat === 'Outer wall' && m.z > first + 1e-6;
  for (const m of moves) if (take(m) && !isSupport(m.obj)) { E += m.e; L += m.len; }
  if (!(L > 0)) for (const m of moves) if (take(m)) { E += m.e; L += m.len; }
  return L > 0 ? E / L : NaN;
}

/* a chain of moves: its run along its own direction, and how wide it is across */
function chainShape(ms) {
  let cx = 0, cy = 0, tot = 0;
  for (const m of ms) {
    const P = movePts(m);
    for (let q = 0; q + 1 < P.length; q++) {
      const l = Math.hypot(P[q + 1][0] - P[q][0], P[q + 1][1] - P[q][1]), a = Math.atan2(P[q + 1][1] - P[q][1], P[q + 1][0] - P[q][0]);
      cx += l * Math.cos(2 * a); cy += l * Math.sin(2 * a);
    }
    tot += m.len;
  }
  const th = Math.atan2(cy, cx) / 2, d = [Math.cos(th), Math.sin(th)], n = [-d[1], d[0]];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const m of ms) for (const p of movePts(m)) {
    const u = p[0] * d[0] + p[1] * d[1], v = p[0] * n[0] + p[1] * n[1];
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return { along: u1 - u0, across: v1 - v0, len: tot };
}

/* the distance from p to the segment ab */
function segDist(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ee = ex * ex + ey * ey;
  const f = ee > 1e-18 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / ee)) : 0;
  return Math.hypot(p[0] - a[0] - f * ex, p[1] - a[1] - f * ey);
}

/* boxes: [{ obj (name), z0, z1, a: [x, y], b: [x, y], widthMm }] - the export's sheet lines */
function sheetAudit(gcode, opts) {
  opts = opts || {};
  const names = opts.names || {}, shift = opts.shift || [0, 0];
  const isSupport = id => / - support \d+\.\d+ \(/.test(names[id] || '');
  const all = extrusions(gcode);
  const ow = outerWallEmm(all, isSupport);
  const byLayer = new Map();
  for (const m of all) {
    if (!isSupport(m.obj)) continue;
    const k = m.obj + '|' + m.z.toFixed(3);
    if (!byLayer.has(k)) byLayer.set(k, []);
    byLayer.get(k).push(m);
  }
  const layers = [];
  const first = all.length ? lowestMoveZ(all) : 0;
  for (const [k, ms] of byLayer) {
    const z = ms[0].z, obj = ms[0].obj, h = ms[0].h || 0.2, zs = z - h / 2;
    if (z <= first + 1e-6) continue;                                               /* the first layer is the pads */
    const chains = new Map();
    ms.forEach(m => { if (!chains.has(m.chain)) chains.set(m.chain, []); chains.get(m.chain).push(m); });
    let thinLen = 0, allLen = 0, thinAlong = 0;
    const sheetMoves = [];
    for (const c of chains.values()) {
      const sh = chainShape(c);
      allLen += sh.len;
      if (sh.across <= THIN_MM && sh.along >= SEGMENT_MIN_MM / 2) { thinLen += sh.len; thinAlong += sh.along; sheetMoves.push(...c); }
    }
    let lines = null;
    if (opts.boxes) {
      lines = opts.boxes.filter(b => b.obj === names[obj] && b.z0 < zs && b.z1 > zs);
      if (!lines.length) continue;
    } else if (!(allLen >= MIN_SHEET_MM && thinLen / allLen >= THIN_SHARE)) continue;
    /* with the export's lines, the moves ON them - not the columns, caps or
       trunks of the same object that pass this z */
    const onLine = m => { const mx = (m.x0 + m.x1) / 2 - shift[0], my = (m.y0 + m.y1) / 2 - shift[1];
      return lines.some(b => segDist([mx, my], b.a, b.b) <= (b.widthMm || 0.43) / 2 + PASS_NEAR_MM); };
    const use = lines ? ms.filter(onLine) : sheetMoves;
    const segs = use.map(m => m.len).sort((a, b) => a - b), L = segs.reduce((s, v) => s + v, 0), E = use.reduce((s, m) => s + m.e, 0);
    const shortLen = segs.filter(v => v < SEGMENT_MIN_MM).reduce((s, v) => s + v, 0);
    const passes = thinAlong > 0 ? thinLen / thinAlong : NaN;
    const rec = { object: obj, name: names[obj] || String(obj), z, sliceZ: zs, segments: segs.length, meanSegMm: L / Math.max(1, segs.length),
                  medianSegMm: segs.length ? segs[segs.length >> 1] : 0, shortSegments: segs.filter(v => v < SEGMENT_MIN_MM).length,
                  longShare: L > 0 ? 1 - shortLen / L : 0, toolpathMm: L, eMm: L > 0 ? E / L : NaN, ratio: L > 0 ? E / L / ow : NaN, passes };
    rec.lineRatio = rec.ratio * passes;
    if (lines) {
      /* each export line: printed when toolpath covers COVER_SHARE of its centreline */
      const pts = [];
      ms.forEach(m => { const P = movePts(m); for (let q = 0; q + 1 < P.length; q++) {
        const a = P[q], b = P[q + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05));
        for (let r = 0; r <= n; r++) pts.push([a[0] + (b[0] - a[0]) * r / n - shift[0], a[1] + (b[1] - a[1]) * r / n - shift[1]]);
      } });
      const g = new Map(), gk = (i, j) => i + ',' + j;
      pts.forEach(p => { const kk = gk(Math.floor(p[0] / 0.5), Math.floor(p[1] / 0.5)); if (!g.has(kk)) g.set(kk, []); g.get(kk).push(p); });
      const covered = p => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = g.get(gk(Math.floor(p[0] / 0.5) + a, Math.floor(p[1] / 0.5) + b)); if (l && l.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= PASS_NEAR_MM)) return true; } return false; };
      let printed = 0, missing = [];
      lines.forEach(b => {
        const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]), n = Math.max(2, Math.ceil(len / 0.1));
        let c = 0;
        for (let q = 1; q < n; q++) if (covered([b.a[0] + (b.b[0] - b.a[0]) * q / n, b.a[1] + (b.b[1] - b.a[1]) * q / n])) c++;
        if (c / (n - 1) >= COVER_SHARE) printed++; else missing.push(+len.toFixed(2));
      });
      rec.exportLines = lines.length; rec.printed = printed; rec.missingMm = missing.sort((a, b) => b - a);
    }
    rec.ok = Math.abs(rec.lineRatio - RATIO_TARGET) <= RATIO_TOL && rec.longShare >= SEGMENT_SHARE && (!lines || rec.printed === lines.length);
    layers.push(rec);
  }
  layers.sort((a, b) => (a.object - b.object) || (a.z - b.z));
  /* the slicer's OWN interface, where it printed one (a reference: Bambu's
     tree on the same coupon), layer by layer */
  const ref = new Map();
  for (const m of all) if (m.feat === 'Support interface') { const k = m.z.toFixed(3); if (!ref.has(k)) ref.set(k, []); ref.get(k).push(m); }
  const reference = [...ref.values()].map(ms => {
    const segs = ms.map(m => m.len).sort((a, b) => a - b), L = segs.reduce((s, v) => s + v, 0), E = ms.reduce((s, m) => s + m.e, 0);
    const shortLen = segs.filter(v => v < SEGMENT_MIN_MM).reduce((s, v) => s + v, 0);
    return { z: ms[0].z, segments: segs.length, meanSegMm: L / segs.length, medianSegMm: segs[segs.length >> 1], longShare: 1 - shortLen / L,
             toolpathMm: L, eMm: E / L, ratio: E / L / ow };
  }).sort((a, b) => a.z - b.z);
  return { outerWallEmm: ow, layers, reference, ok: layers.length > 0 && layers.every(l => l.ok),
           target: { ratio: RATIO_TARGET, tol: RATIO_TOL, segmentMinMm: SEGMENT_MIN_MM, segmentShare: SEGMENT_SHARE } };
}

/* The export's sheet lines: every 8-vertex box of a support object (welded
   at 1e-5) lying wholly above `zMin` - one box per line, the sheet's own
   construction - as its centreline and its height span. */
function exportSheetBoxes(objects) {
  const out = [];
  for (const o of objects) {
    if (!/ - support \d+\.\d+ \(/.test(o.name || '')) continue;
    const s = o.soup, key = i => Math.round(s[i] / 1e-5) + ',' + Math.round(s[i + 1] / 1e-5) + ',' + Math.round(s[i + 2] / 1e-5);
    const par = new Map(), find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const pos = new Map();
    for (let t = 0; t < s.length; t += 9) {
      const ks = [key(t), key(t + 3), key(t + 6)];
      ks.forEach((k, c) => { if (!par.has(k)) { par.set(k, k); pos.set(k, [s[t + c * 3], s[t + c * 3 + 1], s[t + c * 3 + 2]]); } });
      const a = find(ks[0]); [ks[1], ks[2]].forEach(k => { const b = find(k); if (a !== b) par.set(b, a); });
    }
    const comps = new Map();
    for (const k of par.keys()) { const r = find(k); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(pos.get(k)); }
    for (const P of comps.values()) {
      if (P.length !== 8) continue;
      const z0 = Math.min(...P.map(p => p[2])), z1 = Math.max(...P.map(p => p[2]));
      const bot = P.filter(p => Math.abs(p[2] - z0) < 1e-4);
      if (bot.length !== 4 || z1 - z0 > 0.5) continue;
      let best = null;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const d = Math.hypot(bot[i][0] - bot[j][0], bot[i][1] - bot[j][1]); if (!best || d > best.d) best = { d, i, j }; }
      const A = bot[best.i], B = bot[best.j], rest = [0, 1, 2, 3].filter(k => k !== best.i && k !== best.j).map(k => bot[k]);
      const nA = Math.hypot(rest[0][0] - A[0], rest[0][1] - A[1]) < Math.hypot(rest[1][0] - A[0], rest[1][1] - A[1]) ? rest[0] : rest[1];
      const nB = nA === rest[0] ? rest[1] : rest[0], width = Math.hypot(A[0] - nA[0], A[1] - nA[1]);
      const a = [(A[0] + nA[0]) / 2, (A[1] + nA[1]) / 2], b = [(B[0] + nB[0]) / 2, (B[1] + nB[1]) / 2];
      if (!(Math.hypot(b[0] - a[0], b[1] - a[1]) > 4 * width)) continue;           /* a line, not a block */
      out.push({ obj: o.name, z0, z1, a, b, widthMm: width });
    }
  }
  return out;
}

module.exports = { audit, bambuInterface, calibrate, interfacePoints, sheetAudit, extrusions, sliceNames, exportSheetBoxes,
                   MAX_FROM_VERTICAL_DEG, LAYER_MM, MATCH_XY_MM, MATCH_DZ_MM, IFACE_REACH_MM,
                   SHEET: { SEGMENT_MIN_MM, SEGMENT_SHARE, RATIO_TARGET, RATIO_TOL, THIN_MM, PASS_NEAR_MM, COVER_SHARE } };

/* ------------------------------------------------------------------ CLI */
async function main(argv) {
  const fs = require('fs');
  const R = require(path.join(ROOT, 'nso-3mf-read.js'));
  if (argv.includes('--sheet')) return sheetMain(argv, fs, R);
  const file = argv.find(a => !a.startsWith('--') && /\.3mf$/i.test(a) && argv[argv.indexOf(a) - 1] !== '--gcode');
  if (!file) {
    console.log('usage: node tools/nso_slicer_audit.js export.3mf [--gcode sliced.gcode.3mf --shift dx,dy] [--supports a-b] [--json]\n' +
                '       node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf [--export export.3mf] [--shift dx,dy] [--json]');
    return 2;
  }
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const parsed = await R.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: path.basename(file) });
  const objs = parsed.objects.map(o => {
    const soup = new Float32Array(o.positions);
    return { id: +o.id || o.id, name: o.name || '', soup };
  });
  let isSup = o => / - support \d+\.\d+ \(/.test(o.name);
  if (opt('--supports')) {
    const ids = new Set();
    opt('--supports').split(',').forEach(r => { const [a, b] = r.split('-').map(Number); for (let i = a; i <= (b || a); i++) ids.add(i); });
    isSup = o => ids.has(+o.id);
  }
  objs.forEach(o => { o.support = isSup(o); });
  const res = audit(objs.filter(o => o.support), objs.filter(o => !o.support).map(o => o.soup));
  const out = { file: path.basename(file), plateZ: res.plateZ, flaggedAreaMm2: res.flaggedAreaMm2,
                objects: res.objects.map(o => ({ id: o.id, name: o.name, flaggedAreaMm2: +o.flaggedAreaMm2.toFixed(3),
                  regions: o.regions.length, steepAreaMm2: +o.steepAreaMm2.toFixed(2) })) };
  if (opt('--gcode')) {
    const zip = R.openZip(new Uint8Array(fs.readFileSync(opt('--gcode'))));
    const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
    const gcode = new TextDecoder().decode(await zip.read(gname));
    const shift = (opt('--shift') || '0,0').split(',').map(Number);
    const bambu = bambuInterface(gcode, objs, { shift });
    out.bambu = bambu.counts;
    out.bambu.treeShare = bambu.counts.topTree / Math.max(1, bambu.counts.topTree + bambu.counts.topPart + bambu.counts.bottom + bambu.counts.none);
    out.calibration = calibrate(res, bambu);
    delete out.calibration.unmatched;
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); return 0; }
  console.log(`${out.file}: flagged ${res.flaggedAreaMm2.toFixed(2)} mm^2 in ${res.regions.length} region(s) ` +
              `(faces > ${res.maxFromVerticalDeg} deg off vertical, nothing within ${res.layerMm} mm below)`);
  for (const o of res.objects) {
    console.log(`  ${String(o.id).padStart(3)} ${o.name.padEnd(36)} ${o.flaggedAreaMm2.toFixed(2).padStart(9)} mm^2  ${o.regions.length} region(s)`);
    for (const r of o.regions.slice(0, 3)) {
      console.log(`        ${r.areaMm2.toFixed(2).padStart(7)} mm^2  x ${r.lo[0].toFixed(1)}-${r.hi[0].toFixed(1)}  y ${r.lo[1].toFixed(1)}-${r.hi[1].toFixed(1)}  z ${r.lo[2].toFixed(1)}-${r.hi[2].toFixed(1)}`);
    }
  }
  if (out.calibration) {
    const b = out.bambu, c = out.calibration;
    console.log(`Bambu support interface: ${b.points} samples - under a tree ${b.topTree} (${(100 * b.treeShare).toFixed(1)}%), ` +
                `under the part ${b.topPart}, resting only ${b.bottom}, neither ${b.none}`);
    const sh = b.shadow, n = Math.max(1, b.points);
    console.log(`  straight up from each line: the part first ${(100 * sh.partFirst / n).toFixed(1)}%, a tree then the part ` +
                `${(100 * sh.treeThenPart / n).toFixed(1)}%, a tree only ${(100 * sh.treeOnly / n).toFixed(1)}% ` +
                `(within 1 mm: ${(100 * sh.treeOnlyNear / n).toFixed(2)}%), nothing ${(100 * sh.nothing / n).toFixed(1)}%`);
    console.log(`  Bambu regions under a tree: ${c.bambuRegions}, matched by an audit region: ${c.matched} (${(100 * c.matchRate).toFixed(1)}%); ` +
                `samples matched ${(100 * c.pointRate).toFixed(1)}%`);
    console.log(`  of those, under a tree with no part above: ${c.treeAlone.regions}, matched ${c.treeAlone.matched} ` +
                `(${(100 * c.treeAlone.matchRate).toFixed(1)}%)`);
    console.log(`  audit regions Bambu left alone: ${c.auditAlone} of ${c.auditRegions}, ` +
                `${c.auditAloneAreaMm2.toFixed(2)} of ${c.auditAreaMm2.toFixed(2)} mm^2 (${(100 * c.aloneAreaRate).toFixed(1)}%)`);
  }
  return 0;
}

/* --sheet: how the sheet's lines printed, layer by layer (sheetAudit) */
async function sheetMain(argv, fs, R) {
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const gfile = opt('--sheet');
  if (!gfile || !/\.3mf$/i.test(gfile)) { console.log('usage: node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf [--export export.3mf] [--shift dx,dy] [--json]'); return 2; }
  const dec = new TextDecoder();
  const zip = R.openZip(new Uint8Array(fs.readFileSync(gfile)));
  const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
  if (!gname) { console.log(path.basename(gfile) + ': no Metadata/plate_N.gcode in it - slice the plate and save the .gcode.3mf'); return 2; }
  const gcode = dec.decode(await zip.read(gname));
  const info = zip.names().includes('Metadata/slice_info.config') ? dec.decode(await zip.read('Metadata/slice_info.config')) : '';
  const names = sliceNames(info);
  let boxes = null;
  if (opt('--export')) {
    const parsed = await R.parse3MF(new Uint8Array(fs.readFileSync(opt('--export'))), { name: path.basename(opt('--export')) });
    boxes = exportSheetBoxes(parsed.objects.map(o => ({ name: o.name || '', soup: new Float32Array(o.positions) })));
  }
  const shift = (opt('--shift') || '0,0').split(',').map(Number);
  const r = sheetAudit(gcode, { names, boxes, shift });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return 0; }
  const T = r.target, f2 = v => (+v).toFixed(2), f4 = v => (+v).toFixed(4);
  console.log(`${path.basename(gfile)}: the sheet as printed - outer wall ${f4(r.outerWallEmm)} E/mm; target: E per mm of line ` +
              `${f2(T.ratio)} +- ${f2(T.tol)} x the outer wall's, ${Math.round(100 * T.segmentShare)} % of the toolpath in segments of ${T.segmentMinMm} mm or more`);
  if (!r.layers.length) console.log('  no NSO sheet layer found' + (boxes ? ' (the export has ' + boxes.length + ' sheet lines)' : ''));
  let last = null;
  for (const L of r.layers) {
    if (L.name !== last) { console.log('  ' + L.name); last = L.name; }
    console.log(`    z ${L.z.toFixed(2)}: ${L.segments} segments, mean ${f2(L.meanSegMm)} mm (median ${f2(L.medianSegMm)}), ` +
                `${Math.round(100 * L.longShare)} % of ${L.toolpathMm.toFixed(0)} mm in segments >= ${T.segmentMinMm} mm; ` +
                `E/mm ${f4(L.eMm)} = ${f2(L.ratio)} x outer wall; ${f2(L.passes)} passes -> ${f2(L.lineRatio)} x per mm of line` +
                (L.exportLines != null ? `; ${L.printed} of ${L.exportLines} lines printed` + (L.missingMm.length ? ' (missing: ' + L.missingMm.join(', ') + ' mm)' : '') : '') +
                `   ${L.ok ? 'OK' : 'NOT OK'}`);
  }
  if (r.reference.length) {
    console.log('  the slicer\'s own support interface (reference):');
    r.reference.forEach(L => console.log(`    z ${L.z.toFixed(2)}: ${L.segments} segments, mean ${f2(L.meanSegMm)} mm (median ${f2(L.medianSegMm)}), ` +
      `${Math.round(100 * L.longShare)} % of ${L.toolpathMm.toFixed(0)} mm in segments >= ${T.segmentMinMm} mm; E/mm ${f4(L.eMm)} = ${f2(L.ratio)} x outer wall`));
  }
  console.log(!r.layers.length ? 'sheet: no NSO sheet layer in this file' :
    r.ok ? 'sheet: every layer OK' : 'sheet: ' + r.layers.filter(l => !l.ok).length + ' of ' + r.layers.length + ' layer(s) NOT OK');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err && err.stack || err); process.exit(1); });
}

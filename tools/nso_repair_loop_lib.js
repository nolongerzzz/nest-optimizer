/* Shared by tools/nso_repair_loop_test.js (repair:loop, headless) and the Findings drive check:
   the shipped engine files in a vm context in index.html's order, fixture loading, the canonical
   checker, and the one measure of "the fill's rim normals match the neighbours". Node only. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');

function engine() {
  const sb = { window: {} };
  vm.createContext(sb);
  for (const f of ['NSO_Repair.js', 'nso_patch.js', 'nso-defects.js', 'nso-findings.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  }
  return sb.window;
}
const soupOf = rel => new Float32Array(readSTL(path.join(ROOT, 'fixtures', rel)));

/* tools/mesh_validate.py --json on a soup, written to disk first. */
function canonical(soup, name) {
  const file = path.join(os.tmpdir(), 'nso-repair-loop-' + process.pid + '-' + name + '.stl');
  writeSTL(file, soup, 'nso repair-loop check');
  try {
    const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 256 << 20 });
    const j = JSON.parse(out);
    return {
      open: j.open_edges, nm: j.nonmanifold_edges, winding: j.inconsistent_winding_edges, degenerate: j.degenerate_tris,
      euler: j.euler_characteristic, pierce: (j.self_intersection || {}).pierce || 0, coplanar: (j.self_intersection || {}).coplanar || 0,
      volume: j.signed_volume, verdict: j.verdict, triangles: j.triangles
    };
  } finally { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
}

function triNormal(s, t) {
  const o = t * 9, u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]], v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], L = Math.hypot(n[0], n[1], n[2]);
  return L > 0 ? n.map(x => x / L) : [0, 0, 0];
}

/* THE RIM-NORMAL MEASURE. At each vertex on the rim of a fill, the smooth-shading normal (the mean
   of the unit normals of the faces round it) of the piece AFTER the fill goes in, against the same
   vertex's normal from the piece's own faces alone: how far the shading steps at the weld. A
   faceted sphere (edge 0.5 mm on a 4.8 mm radius) has facets 6-10 degrees apart, so a face-to-face
   dihedral across the rim cannot be the measure: the undamaged sphere itself reads 10.9 degrees
   there. The step in the smooth normal is what a fill that continues the surface keeps small and a
   flat cap does not (the cap reads 6.2 on shape-sphere_hole; the patch 3.5). `n0` is how many
   triangles the piece had; the rest are the fill. Returns the angles, degrees, sorted. */
function rimNormalSteps(P, soupAfter, n0) {
  const M = P._weld(soupAfter), all = new Map(), own = new Map();
  for (let t = 0; t < M.nt; t++) {
    const n = triNormal(soupAfter, t);
    for (let k = 0; k < 3; k++) {
      const id = M.f[t * 3 + k];
      const add = m => { const c = m.get(id) || [0, 0, 0]; m.set(id, [c[0] + n[0], c[1] + n[1], c[2] + n[2]]); };
      add(all);
      if (t < n0) add(own);
    }
  }
  const out = [];
  own.forEach((b, id) => {
    const a = all.get(id);
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return;          // not on the rim
    const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
    const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    out.push(Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI);
  });
  return out.sort((x, y) => x - y);
}

const sameBytes = (a, b, n) => {
  const len = n == null ? a.length : n;
  if (a.length < len || b.length < len) return false;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return false;
  return true;
};

module.exports = { ROOT, engine, soupOf, canonical, rimNormalSteps, triNormal, sameBytes };

/* One Findings item's own fix, headless: what app-patch.js nsoRepairRun does with the same
   anchors, on a soup. Returns { ok, soup, reason }. */
function applyItem(W, soup, item) {
  const P = W.NSO_Patch;
  if (item.fix === 'bridge' && item.kind === 'gap') {
    const g = P.gaps(soup).find(x =>
      Math.hypot(...x.a.centroid.map((v, i) => v - item.anchors[0][i])) < 0.2 && Math.hypot(...x.b.centroid.map((v, i) => v - item.anchors[1][i])) < 0.2);
    return g ? P.bridgeFaces(soup, g) : { ok: false, reason: 'that gap is not on the piece any more' };
  }
  const ids = P.loopsAt(soup, item.anchors);
  if (ids.some(i => i < 0)) return { ok: false, reason: 'that opening is not on the piece any more' };
  if (item.fix === 'bridge') return P.bridgeLoops(soup, ids[0], ids[1]);
  const uniq = ids.filter((v, i) => ids.indexOf(v) === i);
  return item.fix === 'cap' ? P.cap(soup, uniq) : P.patch(soup, uniq);
}
/* The card's "Fix all", headless (opts.advisory also takes the advisory gaps, which the card's Fix all
   leaves for the person): every non-advisory item that CAP, PATCH or BRIDGE can take, in the
   card's order, re-reading the piece after each. Returns { soup, steps: [{ item, before, after }] }. */
function fixAllLoops(W, soup0, opts) {
  const withAdvisory = !!(opts && opts.advisory);
  const D = W.NSO_Defects, F = W.NSO_Findings;
  let soup = soup0;
  const steps = [], tried = new Set();
  for (let guard = 0; guard < 60; guard++) {
    const r = D.locate(soup, {}), rows = F.rows(r, F.group(r));
    let next = null;
    for (const row of rows) {
      if (row.advisory && !withAdvisory) continue;
      for (const it of row.items || []) {
        if (!['cap', 'patch', 'bridge'].includes(it.fix)) continue;
        const sig = it.fix + '|' + it.anchors.map(a => a.map(x => x.toFixed(3)).join(',')).join(';');
        if (!tried.has(sig)) { next = { it, sig }; break; }
      }
      if (next) break;
    }
    if (!next) break;
    tried.add(next.sig);
    const out = applyItem(W, soup, next.it);
    steps.push({ item: next.it, ok: out.ok, reason: out.reason, before: r, soup: out.ok ? out.soup : null });
    if (out.ok) soup = out.soup;
  }
  return { soup, steps };
}
module.exports.applyItem = applyItem;
module.exports.fixAllLoops = fixAllLoops;

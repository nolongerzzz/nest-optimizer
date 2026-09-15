/* Shared helpers for the fuse tests: box pieces, STL out, reporting. */
const fs = require('fs');
const path = require('path');

/* Axis-aligned box as a 12-triangle soup, outward normals.
   Every quad splits on its p0-p2 diagonal, and the -X and +X caps are
   given the same corner order, so two boxes stacked along X share a face
   with the same vertices AND the same triangulation - which is what a
   Square Cut produces and what fusion requires. */
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const t = [];
  const quad = (a, b, c, d) => { t.push(...a, ...b, ...c); t.push(...a, ...c, ...d); };
  // +X cap
  quad([x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]);
  // -X cap (same p0-p2 diagonal, reversed winding)
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]);
  // +Y / -Y
  quad([x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]);
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]);
  // +Z / -Z
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]);
  quad([x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]);
  return new Float32Array(t);
}

/* binary STL - float32 native, so a float32 soup round-trips losslessly */
function writeSTL(soup, file) {
  const n = (soup.length / 9) | 0;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('NSO fuse test', 0);
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = t * 9, b = 84 + t * 50;
    const ux = soup[o+3]-soup[o], uy = soup[o+4]-soup[o+1], uz = soup[o+5]-soup[o+2];
    const vx = soup[o+6]-soup[o], vy = soup[o+7]-soup[o+1], vz = soup[o+8]-soup[o+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx/=L; ny/=L; nz/=L;
    buf.writeFloatLE(nx, b); buf.writeFloatLE(ny, b+4); buf.writeFloatLE(nz, b+8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[o+k], b+12+k*4);
    buf.writeUInt16LE(0, b+48);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/* Bit-exact edge audit. The repo checker is the pass/fail authority, but it
   keys edges on coordinates rounded to 5 decimals, so it cannot tell a true
   weld from a hairline seam under 1e-5. This one uses raw bits, so a seam
   that only "looks" closed shows up as open edges here. */
function exactEdgeAudit(soup) {
  const n = (soup.length / 9) | 0, m = new Map();
  const key = (o) => soup[o] + ',' + soup[o+1] + ',' + soup[o+2];
  for (let t = 0; t < n; t++) {
    const o = t * 9, k = [key(o), key(o+3), key(o+6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e+1)%3];
      const ek = a < b ? a+'|'+b : b+'|'+a;
      m.set(ek, (m.get(ek) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  m.forEach(c => { if (c === 1) open++; else if (c > 2) nm++; });
  return { uniqueEdges: m.size, openEdges: open, nonManifoldEdges: nm };
}

/* Self-intersection count. RETIRED as a local implementation.

   This file used to carry its own Moller + 2D-SAT copy, marked in-file as a
   reconciliation candidate. It has been deleted in favour of the canonical
   checker: tools/mesh_validate.py defines the policy, NSO_Repair.js carries the
   transcription this delegates to, and tools/nso_selfint_equiv_test.js holds
   the two together. Delegating rather than re-implementing is the whole point
   of the consolidation, so do not inline a copy here again.

   The deleted copy disagreed with both survivors, and not marginally: it
   skipped a pair only when the two triangles shared at least TWO vertices (an
   edge), where the canonical skips on one, and it compared coordinates at 1e-6
   instead of welding. On fixtures/repair/thingi10k/40921.stl it reported 180
   where the canonical reports 5 piercing; on synth_tjunction.stl and
   out-box-square-half.stl it reported 2 where the canonical reports 0. It
   agreed on this suite's own output only because that output is clean.

   Returns the piercing count, which is what the old function's return value
   was compared against. Coplanar contact is reported separately by the
   canonical checker and is legitimate at a fused seam; selfIntersectionsDetail
   exposes both. */
const { loadRepairModule } = require('./nso_stl_io.js');
let _repair = null;
function _canonical() {
  if (!_repair) _repair = loadRepairModule(require('path').join(__dirname, '..', 'NSO_Repair.js'));
  return _repair;
}

function selfIntersectionsDetail(soup) {
  const r = _canonical().inspect(soup);
  return { pierce: r.selfIntersections, coplanar: r.selfIntersectionsCoplanar };
}

function selfIntersections(soup) {
  return selfIntersectionsDetail(soup).pierce;
}

module.exports = { boxSoup, writeSTL, exactEdgeAudit, selfIntersections, selfIntersectionsDetail };

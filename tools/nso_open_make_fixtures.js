#!/usr/bin/env node
/* Deterministic generator for the intentionally-non-solid fixture set.
 *
 *   node tools/nso_open_make_fixtures.js            # write fixtures/open/*.stl
 *   node tools/nso_open_make_fixtures.js --check    # regenerate to a temp dir and
 *                                                   # diff against what is committed
 *
 * Three shapes that are open BY DESIGN, each in a clean form and with one real
 * defect injected. They exist to prove two things about the nonSolid flag
 * (docs/NON-SOLID.md): the clean form passes with the flag set, and the
 * defective form still fails with the flag set. Every coordinate is a literal
 * or a closed-form function of literals; nothing is random.
 *
 *   open_clip            a U-channel clip as a single sheet: three panels, one
 *                        boundary loop, consistently wound. The vase-mode
 *                        bracket case.
 *   thin_shell_cup       a hollow cup with an open top: outer wall, inner wall,
 *                        closed bottom, 1.2 mm between the two sheets
 *                        everywhere. Two boundary loops. The squishy-toy case.
 *   fabric_weave         a 5 x 5 plain weave of zero-thickness ribbons. Every
 *                        strand is its own component with two open ends and
 *                        no strand touches another. The printable-fabric case.
 *
 * Defects, each a genuine geometry error the flag must NOT hide:
 *
 *   open_clip_selfint       a fin pushed through the clip's floor
 *   thin_shell_cup_selfint  a fin pushed through both walls of the cup
 *   thin_shell_cup_thin     one patch of the inner wall dented out until the
 *                           wall is 0.25 mm - under a 0.4 mm nozzle. This is
 *                           not a topology defect at all; it is what the
 *                           wall-thickness check (Task 4) is for.
 *   fabric_weave_selfint    one weft woven at the wrong height so it passes
 *                           through the warps instead of over and under them
 *   thin_shell_cup_cracked  the cup, still open at the rim on purpose, plus
 *                           the defects a real scan arrives with: 12 zero-area
 *                           sliver stitches over T-junctions, 3 reversed
 *                           duplicate faces, and one fin through both walls.
 *                           Unlike the three above, most of this IS fixable,
 *                           and the flag must let it be fixed
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeSTL, readSTL } = require('./nso_stl_io.js');

const OUT = path.join(__dirname, '..', 'fixtures', 'open');

function tri(out, a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
function quad(out, a, b, c, d) { tri(out, a, b, c); tri(out, a, c, d); }

/* A parametric sheet: f(u, v) -> [x, y, z] sampled on an nu x nv grid, wound
 * so that every shared edge is walked once each way. Winding is consistent by
 * construction, which is exactly the property the winding check must still
 * see on an open sheet. */
function sheet(f, nu, nv) {
  const t = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
      quad(t, f(u0, v0), f(u1, v0), f(u1, v1), f(u0, v1));
    }
  }
  return t;
}

/* Fan a flat disk at height z, radius r, n segments. `up` picks the normal. */
function disk(z, r, n, up) {
  const t = [];
  for (let k = 0; k < n; k++) {
    const a0 = (2 * Math.PI * k) / n, a1 = (2 * Math.PI * (k + 1)) / n;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0), z];
    const p1 = [r * Math.cos(a1), r * Math.sin(a1), z];
    if (up) tri(t, [0, 0, z], p0, p1); else tri(t, [0, 0, z], p1, p0);
  }
  return t;
}

/* A small rectangular fin, two triangles, in the vertical plane through the
 * origin at angle `ang`, spanning radius r0..r1 and height z0..z1. Its four
 * corners are on no other vertex, so any contact it makes is a pierce. */
function fin(ang, r0, r1, z0, z1) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const t = [];
  quad(t, [r0 * c, r0 * s, z0], [r1 * c, r1 * s, z0], [r1 * c, r1 * s, z1], [r0 * c, r0 * s, z1]);
  return t;
}

/* ---------------- open_clip ---------------- */

// Profile in (x, z): down the left wall, along the floor, up the right wall.
const CLIP = { halfW: 8, wallH: 12, halfL: 10 };
function clipProfile(u) {
  // u in [0,1] over three equal-length legs: 12 + 16 + 12 = 40 mm
  const L = 2 * CLIP.wallH + 2 * CLIP.halfW;
  const s = u * L;
  if (s <= CLIP.wallH) return [-CLIP.halfW, CLIP.wallH - s];
  if (s <= CLIP.wallH + 2 * CLIP.halfW) return [-CLIP.halfW + (s - CLIP.wallH), 0];
  return [CLIP.halfW, s - CLIP.wallH - 2 * CLIP.halfW];
}
function fxClip() {
  // 20 steps along the 40 mm profile lands a grid line on both corners.
  return sheet((u, v) => {
    const p = clipProfile(u);
    return [p[0], -CLIP.halfL + 2 * CLIP.halfL * v, p[1]];
  }, 20, 5);
}
function fxClipSelfint() {
  const t = fxClip();
  // A fin standing through the floor (z = 0) at x ~ 1.3, y ~ 0.7, off every
  // grid line, so it pierces two floor triangles and touches no vertex.
  quad(t, [1.3, 0.7, -3], [3.3, 0.7, -3], [3.3, 0.7, 3], [1.3, 0.7, 3]);
  return t;
}

/* ---------------- thin_shell_cup ---------------- */

const CUP = { R: 15, H: 25, t: 1.2, n: 48, rings: 5 };
function cupWall(r, inward) {
  // Outer wall wound outward; inner wall wound toward the axis. Together with
  // the two bottoms that is the orientation of a solid shell, which is what a
  // winding check expects even though the top rim is left open.
  return sheet((u, v) => {
    const a = 2 * Math.PI * (inward ? 1 - u : u);
    const z0 = inward ? CUP.t : 0;
    return [r * Math.cos(a), r * Math.sin(a), z0 + (CUP.H - z0) * v];
  }, CUP.n, CUP.rings);
}
function fxCup() {
  const t = [];
  t.push(...cupWall(CUP.R, false));
  t.push(...cupWall(CUP.R - CUP.t, true));
  t.push(...disk(0, CUP.R, CUP.n, false));          // outer bottom, faces -Z
  t.push(...disk(CUP.t, CUP.R - CUP.t, CUP.n, true)); // inner bottom, faces +Z
  return t;
}
function fxCupSelfint() {
  const t = fxCup();
  // Half a segment off a seam, so it crosses both walls mid-face.
  t.push(...fin(Math.PI / CUP.n, CUP.R - 3, CUP.R + 3, 10, 14));
  return t;
}
function fxCupThin() {
  // Rebuild the inner wall with one patch dented outward to 0.25 mm from the
  // outer face: angular band 90..150 deg, the middle three rings.
  const t = [];
  t.push(...cupWall(CUP.R, false));
  t.push(...sheet((u, v) => {
    const a = 2 * Math.PI * (1 - u);
    const deg = ((1 - u) * 360) % 360;
    const inBand = deg >= 90 - 1e-9 && deg <= 150 + 1e-9 && v >= 0.2 - 1e-9 && v <= 0.8 + 1e-9;
    const r = inBand ? CUP.R - 0.25 : CUP.R - CUP.t;
    return [r * Math.cos(a), r * Math.sin(a), CUP.t + (CUP.H - CUP.t) * v];
  }, CUP.n, CUP.rings));
  t.push(...disk(0, CUP.R, CUP.n, false));
  t.push(...disk(CUP.t, CUP.R - CUP.t, CUP.n, true));
  return t;
}

/* ---------------- fabric_weave ---------------- */

const WEAVE = { count: 5, pitch: 3, width: 1.2, amp: 0.8, seg: 8 };
/* Warp i runs along Y at x = i*pitch and rides z = amp * (-1)^i * cos(pi y / pitch);
 * weft j runs along X at y = j*pitch and rides the opposite sign. At every
 * crossing the two are 2*amp apart and their edges are wider apart still, so
 * no strand touches another. `weftSign` flips one weft for the defect. */
function strand(along, at, sign, len, weftSign) {
  const w = WEAVE.width, a = WEAVE.amp, p = WEAVE.pitch;
  const n = WEAVE.seg * WEAVE.count;
  return sheet((u, v) => {
    const s = -p * 0.5 + (len + p) * u;   // half a pitch past the last crossing each end
    const z = a * sign * Math.cos(Math.PI * s / p) * (weftSign == null ? 1 : weftSign);
    const across = at - w / 2 + w * v;
    return along === 'y' ? [across, s, z] : [s, across, z];
  }, n, 2);
}
function fxWeave(badWeft) {
  const t = [];
  const len = (WEAVE.count - 1) * WEAVE.pitch;
  for (let i = 0; i < WEAVE.count; i++) {
    t.push(...strand('y', i * WEAVE.pitch, (i % 2 === 0) ? 1 : -1, len));
  }
  for (let j = 0; j < WEAVE.count; j++) {
    const s = (j % 2 === 0) ? -1 : 1;
    t.push(...strand('x', j * WEAVE.pitch, s, len, badWeft === j ? -1 : 1));
  }
  return t;
}

/* ---------------- thin_shell_cup_cracked ---------------- */

/* The defect class a photogrammetry or scan-derived shell actually arrives
 * with, dropped onto a piece that is ALSO open on purpose. Both at once is the
 * point: every other fixture here is open-and-clean or open-and-unfixable.
 *
 * SLIVER STITCH. One triangle's edge A-B is subdivided at its midpoint M while
 * the triangle on the other side of A-B keeps using the whole edge, and the
 * resulting T-junction is closed by the zero-area triangle (A, B, M). The
 * surface is watertight over that patch and stays consistently wound, and the
 * stitch holding it together is a degenerate triangle - which is exactly how
 * fixtures/tape_welded_clustered.stl is built, 295 times over.
 *
 * A-B is always the triangle's AXIS-PARALLEL edge, because the stitch has to
 * be degenerate after a float32 round trip and not merely thin. Two endpoints
 * that agree exactly in two coordinates have a midpoint that agrees in those
 * two as well, whatever rounding does to the third, so the cross product is
 * exactly zero and NSO_Repair's `triArea <= 1e-12` test sees it. Halving an
 * edge that slants in all three would leave a sliver of area ~1e-6 at this
 * mesh's scale: visually identical, and not what is being tested.
 *
 * It is the configuration that produced this fixture's reason for existing:
 * the degenerate strip deletes the stitch, which unpairs A-B, A-M and M-B, and
 * the T-junction split then re-stitches the same patch properly. Between those
 * two stages the surface is legitimately more open than it arrived, and on a
 * piece flagged non-solid there used to be nothing left to close the residue,
 * so the final odd-edge gate threw the whole repair away.
 *
 * REVERSED DUPLICATE. A copy of a face with the winding flipped: three edges
 * used three times each (non-manifold) with the directed counts disagreeing
 * (inconsistent winding). The duplicate strip fixes it outright.
 *
 * PIERCE. The same fin thin_shell_cup_selfint uses. NSO_Repair cannot fix a
 * self-intersection and must not appear to: it stays in the report. */
function sliverStitch(t, f, frac) {
  const v = [t.slice(f * 9, f * 9 + 3), t.slice(f * 9 + 3, f * 9 + 6), t.slice(f * 9 + 6, f * 9 + 9)];
  let e = -1;
  for (let i = 0; i < 3 && e < 0; i++) {
    const p = v[i], q = v[(i + 1) % 3];
    let same = 0;
    for (let k = 0; k < 3; k++) if (p[k] === q[k]) same++;
    if (same === 2) e = i;
  }
  if (e < 0) throw new Error('triangle ' + f + ' has no axis-parallel edge to stitch');
  const A = v[e], B = v[(e + 1) % 3], C = v[(e + 2) % 3];
  const s = (frac == null) ? 0.5 : frac;
  const M = [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, A[2] + (B[2] - A[2]) * s];
  // A-B becomes A-M and M-B on this side only, keeping the winding A..B..C...
  t.splice(f * 9, 9, ...A, ...M, ...C, ...M, ...B, ...C);
  // ...and (A, B, M) is the zero-area triangle that pairs all three again,
  // wound A->B so the directed counts stay balanced too.
  tri(t, A, B, M);
}
function fxCupCracked() {
  const t = fxCup();
  // 3 reversed duplicates first, on the inner wall, clear of every stitch.
  // They only append, so the outer-wall indices the stitches use stay put.
  for (const f of [600, 640, 680]) {
    const a = t.slice(f * 9, f * 9 + 3), b = t.slice(f * 9 + 3, f * 9 + 6), c = t.slice(f * 9 + 6, f * 9 + 9);
    tri(t, a, c, b);
  }
  /* 12 stitches on the outer wall, all on ring 2 of 5 - clear of the bottom
   * disk below and of the rim above - four columns apart so no two share an
   * edge. The outer wall is the first CUP.n * CUP.rings * 2 = 480 triangles and
   * `sheet` emits column-major, so the first triangle of column i, ring j is
   * (i * CUP.rings + j) * 2. Taken high-to-low so an earlier splice cannot move
   * a later target.
   *
   * Half of them are cut at the middle of the edge and half at 4e-4 of it, and
   * the difference is the point of the fixture. NSO_Repair's T-junction split
   * refuses a stray vertex closer to an endpoint than SPLIT_EPS - the margin is
   * `max(SPLIT_EPS, WELD_TOL) / edgeLength`, here 5e-3 / 5 mm = 1e-3 - so the
   * six cut at 4e-4 are cracks it CANNOT re-stitch, however right it was to
   * delete the sliver. That is not a contrived limit: it is the whole residue
   * left on fixtures/tape_welded_clustered.stl, whose leftover loops span
   * 0.01 mm, every interior point of them inside the margin. Six cracks of
   * three edges each is +18 odd edges with nothing downstream to close them -
   * the exact shape of the bug this fixture exists to pin. */
  const targets = [];
  for (let k = 0; k < 12; k++) {
    const col = 2 + k * 4;
    targets.push([(col * CUP.rings + 2) * 2, (k % 2) ? 4e-4 : 0.5]);
  }
  for (const [f, frac] of targets.reverse()) sliverStitch(t, f, frac);
  t.push(...fin(Math.PI / CUP.n, CUP.R - 3, CUP.R + 3, 10, 14));
  return t;
}

/* ---------------- manifest ---------------- */

const FIXTURES = [
  ['open_clip.stl',              fxClip,                'U-channel clip, single sheet, open by design'],
  ['open_clip_selfint.stl',      fxClipSelfint,         'open_clip with a fin through the floor'],
  ['thin_shell_cup.stl',         fxCup,                 'hollow cup, open top, 1.2 mm wall'],
  ['thin_shell_cup_selfint.stl', fxCupSelfint,          'thin_shell_cup with a fin through both walls'],
  ['thin_shell_cup_thin.stl',    fxCupThin,             'thin_shell_cup with one patch dented to 0.25 mm'],
  ['fabric_weave.stl',           () => fxWeave(-1),     '5x5 plain weave of open ribbons, no contact'],
  ['fabric_weave_selfint.stl',   () => fxWeave(2),      'fabric_weave with weft 2 woven through the warps'],
  ['thin_shell_cup_cracked.stl', fxCupCracked,          'thin_shell_cup with sliver stitches, reversed duplicates and a fin'],
];

function build(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, make, header] of FIXTURES) {
    const raw = new Float32Array(make());
    const n = writeSTL(path.join(dir, name), raw, 'NSO open fixture: ' + header);
    written.push([name, n]);
  }
  return written;
}

function main() {
  if (process.argv.includes('--check')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-open-fx-'));
    build(tmp);
    let bad = 0;
    for (const [name] of FIXTURES) {
      const a = fs.readFileSync(path.join(tmp, name));
      let b = null;
      try { b = fs.readFileSync(path.join(OUT, name)); } catch (e) { /* absent */ }
      const same = b && a.equals(b);
      console.log((same ? '  ok    ' : '  DRIFT ') + name + (b ? '' : ' (missing)'));
      if (!same) bad++;
    }
    process.exit(bad ? 1 : 0);
  }
  for (const [name, n] of build(OUT)) console.log('  wrote ' + name + '  ' + n + ' tris');
}

if (require.main === module) main();
module.exports = { FIXTURES, build };

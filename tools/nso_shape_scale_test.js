#!/usr/bin/env node
// Headless self-test for nso_shapes.js (Scale's shape rows: a capsule's
// Length / Diameter, a sphere's or ellipsoid's A · B · C, a torus's Ring Ø /
// Tube Ø).
//
//   node tools/nso_shape_scale_test.js        exit 0 = every gate held
//
// Every number is held against the GENERATOR's parameters - nso_stock.js's own
// profiles, revolved by its own revolve - never against what this file said
// last time. Each row is held to what it says it changes and what it says it
// keeps, bit for bit where the row never writes the coordinate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, WeakMap, console, Array, Object, Number, String, JSON, isFinite, isNaN, parseFloat,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_section.js', 'nso_shapes.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_shapeRead, NSO_shapeRecognise, NSO_shapeApplyRaw, NSO_shapeTagStock, NSO_shapeTagOf,
        NSO_shapeReadout, NSO_sectionRead, NSO_sectionFitCircle, NSO_Stock: S } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f32 = Math.fround;
const SEG = 96, PN = 96;

function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi, span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
/* Closed, manifold, no degenerate triangles: every welded edge used twice. */
function manifold(s) {
  const key = (o) => s[o] + ',' + s[o + 1] + ',' + s[o + 2];
  const edges = new Map();
  let degen = 0;
  for (let t = 0; t < s.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    const ux = s[t + 3] - s[t], uy = s[t + 4] - s[t + 1], uz = s[t + 5] - s[t + 2];
    const vx = s[t + 6] - s[t], vy = s[t + 7] - s[t + 1], vz = s[t + 8] - s[t + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-12) degen++;
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      edges.set(ek, (edges.get(ek) || 0) + 1);
    }
  }
  let bad = 0;
  edges.forEach((c) => { if (c !== 2) bad++; });
  return { ok: bad === 0 && degen === 0, bad, degen };
}
function signedVolume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
         s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6]);
  }
  return v / 6;
}

const capsule = (r, L) => S.revolve(S.profileCapsule(r, L, PN), SEG);
const sphere = (r) => S.revolve(S.profileSphere(r, PN), SEG);
const torus = (R, r) => S.revolve(S.profileTorus(R, r, PN), SEG);
/* A hollow torus: the tube's outer surface facing out and a concentric inner
   one facing in - the inner meridian walked the other way round, and lifted by
   the wall so both tubes share a centreline (profileTorus rests on z = 0). */
function hollowTorus(R, r, wall) {
  const o = S.revolve(S.profileTorus(R, r, PN), SEG, { precise: true });
  const inner = S.profileTorus(R, r - wall, PN).map((q) => ({ z: q.z + wall, r: q.r })).reverse();
  const i = S.revolve(inner, SEG, { precise: true });
  return new Float32Array(o.concat(i));
}

/* ------------------------------------------------------------------ */
console.log('1. Stock capsule Ø20 L60 -> Length 90');
{
  const soup = capsule(10, 60);
  NSO_shapeTagStock(soup, { shape: 'capsule', measure: { radius: 10, height: 60 } });
  const p = NSO_shapeRead(soup, null);
  check('a Stock capsule carries its shape', p && p.shape === 'capsule' && p.source === 'stock' && p.radius === 10 && p.length === 60,
        p ? NSO_shapeReadout(p) : 'no tag');
  const rec = NSO_shapeRecognise(soup, NSO_sectionRead(soup));
  check('the same capsule untagged is recognised', rec.ok && rec.p.shape === 'capsule' && rec.p.axisIdx === 2 &&
        near(rec.p.radius, 10, 1e-5) && near(rec.p.length, 60, 1e-5), rec.ok ? NSO_shapeReadout(rec.p) : rec.why);

  const r = NSO_shapeApplyRaw(soup, p, 'capLength', 90);
  check('Length 90 applies', r.ok, r.reason);
  const out = r.tris, d = r.extend ? r.extend.delta : NaN;
  const b0 = bounds(soup), b1 = bounds(out);
  check('length is 90', near(b1.span[2], 90, 2e-5), b1.span[2].toFixed(7));
  check('diameter kept, bit for bit', b1.span[0] === b0.span[0] && b1.span[1] === b0.span[1], b1.span[0] + ' x ' + b1.span[1]);

  // Each hemisphere's triangles: every vertex at or below the lower equator
  // (z <= r), or at or above the upper one (z >= L - r).
  let lowSame = 0, lowTris = 0, upSame = 0, upTris = 0, bandTris = 0;
  let lowEq = -Infinity, upEq = Infinity;
  for (let t = 0; t < soup.length; t += 9) {
    const zs = [soup[t + 2], soup[t + 5], soup[t + 8]];
    if (zs.every((z) => z <= 10)) {
      lowTris++;
      let same = true;
      for (let j = 0; j < 9; j++) if (out[t + j] !== soup[t + j]) same = false;
      if (same) lowSame++;
      for (const j of [2, 5, 8]) lowEq = Math.max(lowEq, out[t + j]);
    } else if (zs.every((z) => z >= 50)) {
      upTris++;
      // x and y bit for bit; z the old z shifted by the one delta and stored
      // as a float32 once - the bytes a rigid move of the dome writes.
      let same = true;
      for (let j = 0; j < 9; j++) {
        const want = (j % 3 === 2) ? f32(soup[t + j] + d) : soup[t + j];
        if (out[t + j] !== want) same = false;
      }
      if (same) upSame++;
      for (const j of [2, 5, 8]) upEq = Math.min(upEq, out[t + j]);
    } else bandTris++;
  }
  check('lower hemisphere byte-identical', lowTris > 0 && lowSame === lowTris, lowSame + ' / ' + lowTris + ' triangles');
  check('upper hemisphere byte-identical to itself moved by Δ', upTris > 0 && upSame === upTris,
        upSame + ' / ' + upTris + ' triangles, Δ ' + d);
  check('band +30 (40 -> 70)', near(upEq - lowEq, 70, 2e-5) && near(d, 30, 1e-5), (upEq - lowEq).toFixed(6) + ' mm, ' + bandTris + ' band triangles');
  const mf = manifold(out);
  check('manifold', mf.ok, 'bad edges ' + mf.bad + ', degenerate ' + mf.degen);
  check('volume grew by the band', near(signedVolume(out) - signedVolume(soup), Math.PI * 100 * 30 * S.polygonFactor(SEG), 0.05),
        (signedVolume(out) - signedVolume(soup)).toFixed(3) + ' mm^3');
  check('the result is tagged L90', r.shape && r.shape.shape === 'capsule' && near(r.shape.length, 90, 2e-5) && NSO_shapeTagOf(out) === r.shape);
  check('the original soup keeps its own tag (Undo finds it)', NSO_shapeTagOf(soup) === p);

  const sh = NSO_shapeApplyRaw(soup, p, 'capLength', 40);
  check('Length 40 shortens inside the band', sh.ok && near(bounds(sh.tris).span[2], 40, 2e-5), sh.reason || bounds(sh.tris).span[2].toFixed(6));
}

console.log('\n2. capsule Diameter - the cross-section, length kept');
{
  const soup = capsule(10, 60);
  const p = NSO_shapeRead(soup, null);
  const r = NSO_shapeApplyRaw(soup, p, 'capDiameter', 30);
  check('Diameter 30 applies', r.ok, r.reason);
  const b = bounds(r.tris);
  check('Ø30, length 60 kept', near(b.span[0], 30, 2e-5) && near(b.span[1], 30, 2e-5) && b.span[2] === 60, b.span.map((x) => x.toFixed(5)).join(' x '));
  // Every vertex on the capsule of r 15: on a hemisphere about (0,0,15) or
  // (0,0,45), or on the band at radius 15.
  let worst = 0;
  for (let i = 0; i < r.tris.length; i += 3) {
    const x = r.tris[i], y = r.tris[i + 1], z = r.tris[i + 2], q = Math.hypot(x, y);
    const dd = z < 15 ? Math.hypot(q, z - 15) : (z > 45 ? Math.hypot(q, z - 45) : q);
    worst = Math.max(worst, Math.abs(dd - 15));
  }
  check('the ends are still hemispheres, now r 15', worst < 1e-4, 'worst vertex ' + worst.toExponential(2) + ' mm off');
  check('manifold', manifold(r.tris).ok);
  const rec = NSO_shapeRecognise(r.tris, null);
  check('read back as a capsule Ø30 L60', rec.ok && near(rec.p.radius, 15, 1e-4) && near(rec.p.length, 60, 1e-5), rec.ok ? NSO_shapeReadout(rec.p) : rec.why);
}

console.log('\n3. Sphere R10 -> A 30');
{
  const soup = sphere(10);
  NSO_shapeTagStock(soup, { shape: 'sphere', measure: { radius: 10 } });
  const p = NSO_shapeRead(soup, null);
  check('a Stock sphere carries its shape', p && p.shape === 'sphere', p && NSO_shapeReadout(p));
  const r = NSO_shapeApplyRaw(soup, p, 'ellA', 30);
  check('A 30 applies', r.ok, r.reason);
  const b = bounds(r.tris);
  check('x extent 30', near(b.span[0], 30, 1e-6), b.span[0].toFixed(7));
  check('y and z still 20', b.span[1] === 20 && b.span[2] === 20, b.span[1] + ' / ' + b.span[2]);
  let untouched = true;
  for (let i = 0; i < soup.length; i += 3) if (r.tris[i + 1] !== soup[i + 1] || r.tris[i + 2] !== soup[i + 2]) untouched = false;
  check('y and z of every vertex not written', untouched);
  check('manifold', manifold(r.tris).ok);
  check('now an ellipsoid 30 A × 20 B × 20 C', r.shape.shape === 'ellipsoid' && near(2 * r.shape.semi[0], 30, 1e-6), NSO_shapeReadout(r.shape));
  const rec = NSO_shapeRecognise(r.tris, null);
  check('read back as that ellipsoid', rec.ok && rec.p.shape === 'ellipsoid' && near(rec.p.semi[0], 15, 1e-5) && near(rec.p.semi[1], 10, 1e-5),
        rec.ok ? NSO_shapeReadout(rec.p) : rec.why);
  const c = NSO_shapeApplyRaw(r.tris, r.shape, 'ellC', 12);
  const bc = bounds(c.tris);
  check('then C 12: z 12, x 30 and y 20 kept', c.ok && near(bc.span[2], 12, 1e-6) && bc.span[0] === b.span[0] && bc.span[1] === 20, c.reason || bc.span.join(' x '));
  // Stock's own ellipsoid (a spheroid r, r, c) reads as the same thing.
  const mk = S.make({ shape: 'ellipsoid', height: 30, radius: 10, ratio: 1.5, waste: 0 });
  const ell = new Float32Array(mk.soup);
  NSO_shapeTagStock(ell, mk.sizing);
  const pe = NSO_shapeRead(ell, null), re = NSO_shapeRecognise(ell, null);
  check('Stock ellipsoid tag and reading agree', pe.shape === 'ellipsoid' && re.ok &&
        [0, 1, 2].every((k) => near(pe.semi[k], re.p.semi[k], 1e-4)), NSO_shapeReadout(pe) + ' / ' + (re.ok ? NSO_shapeReadout(re.p) : re.why));
}

console.log('\n4. Torus R20 r4 -> Ring Ø 60, Tube Ø 10');
/* Every meridian of the revolve is one angle: its vertices' (rho, z) must be
   a circle of the tube's radius about (ring radius, centre height). */
function meridians(s, R, r, wc) {
  const groups = new Map();
  for (let i = 0; i < s.length; i += 3) {
    const a = Math.round(Math.atan2(s[i + 1], s[i]) / (2 * Math.PI) * SEG * 1000) / 1000;
    const key = ((a % SEG) + SEG) % SEG;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([Math.hypot(s[i], s[i + 1]), s[i + 2]]);
  }
  let worstR = 0, worstC = 0;
  for (const pts of groups.values()) {
    const uniq = [...new Map(pts.map((p) => [p.join(','), p])).values()];
    const fit = NSO_sectionFitCircle(uniq);
    worstR = Math.max(worstR, Math.abs(fit.rMax - r), Math.abs(fit.rMin - r) * 0);
    worstC = Math.max(worstC, Math.abs(fit.center[0] - R), Math.abs(fit.center[1] - wc));
    for (const q of uniq) worstR = Math.max(worstR, Math.abs(Math.hypot(q[0] - R, q[1] - wc) - r));
  }
  return { n: groups.size, worstR, worstC };
}
{
  const soup = torus(20, 4);
  NSO_shapeTagStock(soup, { shape: 'torus', measure: { ring_radius: 20, tube_radius: 4 } });
  const p = NSO_shapeRead(soup, null);
  check('a Stock torus carries its shape', p && p.shape === 'torus' && p.ringR === 20 && p.tubeR === 4, p && NSO_shapeReadout(p));
  const rec = NSO_shapeRecognise(soup, null);
  check('the same torus untagged is recognised', rec.ok && rec.p.shape === 'torus' && near(rec.p.ringR, 20, 1e-5) && near(rec.p.tubeR, 4, 1e-5) && rec.p.wall == null,
        rec.ok ? NSO_shapeReadout(rec.p) : rec.why);

  const r = NSO_shapeApplyRaw(soup, p, 'ringDia', 60);
  check('Ring Ø 60 applies', r.ok, r.reason);
  const m = meridians(r.tris, 30, 4, 4);
  check('every section still a Ø8 circle, centred at r 30', m.n === SEG && m.worstR < 1e-5 && m.worstC < 1e-5,
        m.n + ' meridians, radius off ' + m.worstR.toExponential(2) + ', centre off ' + m.worstC.toExponential(2));
  let zSame = true;
  for (let i = 2; i < soup.length; i += 3) if (r.tris[i] !== soup[i]) zSame = false;
  check('height of every vertex not written', zSame);
  const b = bounds(r.tris);
  check('outside Ø68, height 8', near(b.span[0], 68, 2e-5) && near(b.span[1], 68, 2e-5) && b.span[2] === 8, b.span.map((x) => x.toFixed(5)).join(' x '));
  check('manifold', manifold(r.tris).ok);

  const t = NSO_shapeApplyRaw(soup, p, 'tubeDia', 10);
  check('Tube Ø 10 applies', t.ok, t.reason);
  const mt = meridians(t.tris, 20, 5, 4);
  check('ring Ø kept: every section a Ø10 circle centred at r 20', mt.worstR < 1e-5 && mt.worstC < 1e-5,
        'radius off ' + mt.worstR.toExponential(2) + ', centre off ' + mt.worstC.toExponential(2));
  check('read back ring Ø40 tube Ø10', near(t.shape.ringR, 20, 1e-9) && near(2 * t.shape.tubeR, 10, 1e-9), NSO_shapeReadout(t.shape));
  check('manifold', manifold(t.tris).ok);

  const h = hollowTorus(20, 4, 1);
  const ph = NSO_shapeRead(h, null);
  check('a hollow torus is recognised with its wall', ph && ph.shape === 'torus' && near(ph.wall, 1, 1e-4), ph ? NSO_shapeReadout(ph) : 'not read');
  const th = NSO_shapeApplyRaw(h, ph, 'tubeDia', 12);
  check('hollow Tube Ø 12 applies', th.ok, th.reason);
  const rh = NSO_shapeRecognise(th.tris, null);
  check('wall preserved, ring Ø kept', rh.ok && near(rh.p.wall, 1, 1e-4) && near(rh.p.tubeR, 6, 1e-4) && near(rh.p.ringR, 20, 1e-4),
        rh.ok ? NSO_shapeReadout(rh.p) : rh.why);
  check('manifold', manifold(th.tris).ok);
}

console.log('\n5. refusals - in words, piece unchanged');
{
  const cap = capsule(10, 60), pc = NSO_shapeRead(cap, null);
  const sph = sphere(10), ps = NSO_shapeRead(sph, null);
  const tor = torus(20, 4), pt = NSO_shapeRead(tor, null);
  const hol = hollowTorus(20, 4, 1), ph = NSO_shapeRead(hol, null);
  const cases = [
    ['capsule Length 15 (under 2× its radius)', cap, pc, 'capLength', 15, /under 2× its radius/],
    ['capsule Length 20 (exactly 2× its radius)', cap, pc, 'capLength', 20, /under 2× its radius.*sphere/],
    ['capsule Diameter 70 (over its length)', cap, pc, 'capDiameter', 70, /under 2× its radius/],
    ['capsule Diameter 0.6 (thinner than 2 nozzles)', cap, pc, 'capDiameter', 0.6, /2 nozzle widths/],
    ['sphere A 0.5 (thinner than 2 nozzles)', sph, ps, 'ellA', 0.5, /thinner than 2 nozzle widths/],
    ['torus Tube Ø 40 (reaches the axis)', tor, pt, 'tubeDia', 40, /reach the axis/],
    ['torus Ring Ø 8 (reaches the axis)', tor, pt, 'ringDia', 8, /reach the axis/],
    ['torus Tube Ø 0.6 (thinner than 2 nozzles)', tor, pt, 'tubeDia', 0.6, /2 nozzle widths/],
    ['hollow torus Tube Ø 1.5 (bore closes)', hol, ph, 'tubeDia', 1.5, /bore would close/],
    ['a row the shape does not have', sph, ps, 'ringDia', 30, /not a row/]
  ];
  for (const [name, soup, p, row, mm, re] of cases) {
    const r = NSO_shapeApplyRaw(soup, p, row, mm);
    check(name, !r.ok && re.test(r.reason) && r.tris === soup, r.reason);
  }
  const ok = NSO_shapeApplyRaw(sph, ps, 'ellA', 0.9);
  check('sphere A 0.9 is allowed (over 2 nozzles)', ok.ok, ok.reason);
}

console.log('\n6. an imported capsule - no tag, through the section reader');
{
  // A different tessellation, lying along X, far off the origin, through an
  // STL file and back: nothing about it says Stock.
  const base = S.revolve(S.profileCapsule(6, 40, 48), 64, { precise: true });
  const moved = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 3) { moved[i] = base[i + 2] + 100; moved[i + 1] = base[i] - 30; moved[i + 2] = base[i + 1] + 5; }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nso-shapes-')), 'capsule_x.stl');
  writeSTL(file, moved);
  const soup = readSTL(file);
  check('no tag on the imported piece', NSO_shapeTagOf(soup) === null);
  const sec = NSO_sectionRead(soup);
  check('the section reader names its axis X and reads it as other', sec.axisIdx === 0 && sec.shape === 'other', sec.reason);
  const p = NSO_shapeRead(soup, sec);
  check('recognised as a capsule Ø12 L40 along X', p && p.shape === 'capsule' && p.source === 'read' && p.axisIdx === 0 &&
        near(2 * p.radius, 12, 1e-4) && near(p.length, 40, 1e-4), p ? NSO_shapeReadout(p) : 'not recognised');
  const r = NSO_shapeApplyRaw(soup, p, 'capLength', 55);
  const b0 = bounds(soup), b1 = bounds(r.tris);
  check('Length 55 along X, its far end moved, its near end and section kept', r.ok && near(b1.span[0], 55, 5e-5) &&
        b1.lo[0] === b0.lo[0] && b1.span[1] === b0.span[1] && b1.span[2] === b0.span[2], r.reason || b1.span.map((x) => x.toFixed(5)).join(' x '));
  check('manifold', manifold(r.tris).ok);
}

console.log('\n7. not these shapes - the existing rows stay');
{
  const cyl = S.revolve(S.profileCylinder(10, 40), SEG);
  const tube = S.revolve(S.profileTube(10, 8, 40), SEG);
  const cone = S.revolve(S.profileCone(10, 30, 0), SEG);
  const box = S.boxSoup(20, 20, 20);
  for (const [name, s] of [['cylinder', cyl], ['tube', tube], ['cone', cone], ['cube', box]]) {
    const r = NSO_shapeRecognise(s, NSO_sectionRead(s));
    check(name + ' is none of them', !r.ok, r.why);
  }
  const mk = S.make({ shape: 'cylinder', height: 40, radius: 10, waste: 0 });
  check('a Stock cylinder carries no shape-row tag', NSO_shapeTagStock(new Float32Array(mk.soup), mk.sizing) === null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join('; ')); process.exit(1); }

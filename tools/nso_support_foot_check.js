#!/usr/bin/env node
/* ============================================================
   tools/nso_support_foot_check.js - THE TREE'S FOOT AND TRUNK (npm run
   support:foot; docs/SUPPORT-GRIDPACK.md, *The trunk*).

   The round-2 print of simple_overhang (NSO's export, Bambu's supports off)
   failed at the floor: a ~37 mm tree on a 2.4 mm column and a small round
   pad peeled off the plate when the nozzle caught the stair; the tree held.
   Bambu's own tree slim on the same part (fixtures/supports/
   simple_overhang_bambu.gcode.3mf) printed fine. Now every trunk the card
   builds (parts with interface on) gets a round trunk round its foot's axis,
   2 mm at the top of what it holds up and wider going down at
   TRUNK.angleDeg, a flare over the bottom TRUNK.flareMm onto its pad, and
   its pad drawn round the flared base.

     node tools/nso_support_foot_check.js      exit 0 = every gate held
     (writes tools/supports-foot-out/simple_overhang_supports.3mf, the arc
      with its supports as the card exports them, through the Bambu project
      envelope: open it in Bambu Studio as a project, its own supports off)

   1. BAMBU'S TRUNK, measured from the fixture's G-code: the Support loops of
      each layer grouped by touching boxes; the trunk is the one round group
      (aspect 1.05 or less) over the second layer's largest, followed up
      while it stays one round group; its diameter the loop's centreline
      extent plus the support line; its first layer the ring under it, its
      area the outer ring's grown by half the first layer's line.
   2. NSO'S TRUNKS on the arc, measured on the parts built (each trunk's
      shell cut at every one of Bambu's trunk layers, its inscribed diameter
      about the axis): at every z of Bambu's trunk, every NSO trunk standing
      there at least Bambu's diameter, and one of them standing that high.
   3. THE FLARE: over the bottom TRUNK.flareMm the section widens going down
      faster than the trunk above it, layer on layer, onto the pad; the base
      lies inside the pad (no step from trunk to pad).
   4. THE PAD: sized to the trunk - in every direction the piece does not
      cut it short, out to the flared base plus FEET.trunkGrowMm (1.85 mm,
      Bambu's measured: its first-layer ring 16.04 mm across a 12.35 mm
      trunk; it was 4 mm until the foot held a print); its area at least
      Bambu's first layer under its trunk; the pads of trunks that touch one
      pad (one support).
   5. THE GAP: every trunk's exact triangle distance to the piece, at least
      FEET.gapMm.
   6. NOTHING ABOVE THE TRUNK CHANGES, on the arc and the 2026-10-20 coupon:
      built with trunkGrowth off the support is the build pinned (the
      coupon's #265's; the arc's supports-thinning's: the landing
      members and the body on them) byte for byte, and
      with it on the support is that build's every part, byte for byte, then
      the trunks, then the pads; the coupon's pads are #274's drawn with the
      smaller margin and nothing else (the new outline inside the old, each
      trunk's base grown by the margin inside the new).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'supports-foot-out');
const FIXTURE = path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf');
const BAMBU = path.join(ROOT, 'fixtures', 'supports', 'simple_overhang_bambu.gcode.3mf');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const AUD = require('./nso_slicer_audit.js');
const EXP = require('./nso_supports_print_export.js');
const { readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date, WeakMap,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface, TH = ctx.NSO_Thickness;
const TRUNK = GP.TRUNK, FEET = GP.FEET;
/* the builds with trunkGrowth off, sha-256 (first 16 hex) of each support object's Float32 soup and its
   triangles: the coupon's #265's (claude-wip b7076af + supports-curved-sheet a08bc6f; support:curved 7's);
   the arc's supports-thinning's - the plan's two landing members, a trunk of its own, the body's 30 deg cones off
   three trunks' tops (50572 tris at supports-stair-body, 379c759080d3c132, two trunks and 45 deg cones); the
   layers from the body's underside up are #275's byte for byte, support:curved 4 */
const BEFORE = { coupon: ['6ac271882b107552', 27348], arc: ['4f598080541234fb', 67728] };

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f2 = v => (+v).toFixed(2), f3 = v => (+v).toFixed(3);
const sha = soup => crypto.createHash('sha256').update(Buffer.from(new Float32Array(soup).buffer)).digest('hex').slice(0, 16);

/* ---------------------------------------------------------------- Bambu's trunk */
function bambuTrunk(gcode) {
  const lw = +(/; support_line_width = ([\d.]+)/.exec(gcode) || [0, 0.42])[1];
  const lw0 = +(/; initial_layer_line_width = ([\d.]+)/.exec(gcode) || [0, 0.5])[1];
  const byZ = new Map();
  AUD.extrusions(gcode).filter(m => /^Support/.test(m.feat || '')).forEach(m => {
    if (!byZ.has(m.z)) byZ.set(m.z, new Map());
    const L = byZ.get(m.z);
    if (!L.has(m.chain)) L.set(m.chain, []);
    L.get(m.chain).push(...(m.pts || [[m.x0, m.y0], [m.x1, m.y1]]));
  });
  const zs = [...byZ.keys()].sort((a, b) => a - b);
  const boxOf = pts => [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[1]))];
  /* a layer's loops grouped by boxes within half a millimetre */
  const groups = z => {
    const cs = [...byZ.get(z).values()].map(pts => ({ b: boxOf(pts), chains: [pts] }));
    for (let again = true; again;) {
      again = false;
      for (let i = 0; i < cs.length && !again; i++) for (let j = i + 1; j < cs.length && !again; j++) {
        const a = cs[i].b, b = cs[j].b;
        if (a[0] <= b[1] + 0.5 && b[0] <= a[1] + 0.5 && a[2] <= b[3] + 0.5 && b[2] <= a[3] + 0.5) {
          cs[i] = { b: [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])], chains: cs[i].chains.concat(cs[j].chains) };
          cs.splice(j, 1); again = true;
        }
      }
    }
    return cs;
  };
  const holds = (k, c) => k.b[0] <= c[0] && c[0] <= k.b[1] && k.b[2] <= c[1] && c[1] <= k.b[3];
  const seed = groups(zs[1]).sort((a, b) => (b.b[1] - b.b[0]) - (a.b[1] - a.b[0]))[0];
  let c = [(seed.b[0] + seed.b[1]) / 2, (seed.b[2] + seed.b[3]) / 2];
  const rows = [];
  let ended = null;
  for (const z of zs.slice(1)) {
    const hit = groups(z).filter(k => holds(k, c));
    if (hit.length !== 1) { ended = `${hit.length} groups at z ${f2(z)}`; break; }
    const k = hit[0], w = k.b[1] - k.b[0], h = k.b[3] - k.b[2];
    if (Math.max(w, h) / Math.min(w, h) > 1.05) { ended = `${f2(w)} x ${f2(h)} at z ${f2(z)}`; break; }
    c = [(k.b[0] + k.b[1]) / 2, (k.b[2] + k.b[3]) / 2];
    rows.push({ z, d: (w + h) / 2 + lw, c });
  }
  const g0 = groups(zs[0]).find(k => holds(k, rows[0].c));
  const ext = pts => { const b = boxOf(pts); return b[1] - b[0] + b[3] - b[2]; };
  const outer = g0.chains.slice().sort((a, b) => ext(b) - ext(a))[0];
  let A = 0, P = 0;
  for (let i = 0; i < outer.length; i++) { const p = outer[i], q = outer[(i + 1) % outer.length]; A += p[0] * q[1] - q[0] * p[1]; P += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  return { rows, ended, firstZ: zs[0], padAreaMm2: Math.abs(A) / 2 + P * lw0 / 2 + Math.PI * lw0 * lw0 / 4,
           padD: (g0.b[1] - g0.b[0] + g0.b[3] - g0.b[2]) / 2 + lw0, lw, lw0 };
}

/* ---------------------------------------------------------------- sections */
function sliceAt(soup, z) {
  const segs = [];
  for (let i = 0; i < soup.length; i += 9) {
    const P = [[soup[i], soup[i + 1], soup[i + 2]], [soup[i + 3], soup[i + 4], soup[i + 5]], [soup[i + 6], soup[i + 7], soup[i + 8]]];
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = P[k], b = P[(k + 1) % 3];
      if ((a[2] - z) * (b[2] - z) < 0) { const t = (z - a[2]) / (b[2] - a[2]); pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const inPoly = (p, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j];
  if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
/* a trunk's diameter at z: twice the least distance from its axis to its section's edge (null: no section
   there) - the narrower of the sections a micron either side, so a z on a ring's own plane is read too */
function diameterAt(soup, c, z) {
  const ds = [z - 1e-3, z + 1e-3].map(zz => { const segs = sliceAt(soup, zz); return segs.length ? 2 * Math.min(...segs.map(s => segDist(c, s[0], s[1]))) : null; });
  return ds[0] == null || ds[1] == null ? null : Math.min(ds[0], ds[1]);
}
/* how far along the ray from c at angle a the polygon P reaches (its last crossing) */
function reach(P, c, a) {
  const d = [Math.cos(a), Math.sin(a)];
  let best = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], e = [q[0] - p[0], q[1] - p[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const w = [p[0] - c[0], p[1] - c[1]], t = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * d[1] - w[1] * d[0]) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
  }
  return best;
}

async function loadArc() {
  const r = await R3.parse3MF(new Uint8Array(fs.readFileSync(FIXTURE)), { name: 'simple_overhang.3mf' });
  return new Float32Array(r.objects[0].positions);
}
/* the support object's soup as parts: its solids', then its trunks', then its pads' */
function splitObject(b, oi) {
  const o = b.sf.objects[oi];
  const solids = o.from.map(([bi, si]) => b.areas[bi].sh.solids[si].soup);
  const n = solids.reduce((a, s) => a + s.length, 0);
  const trunks = b.sf.trunks.filter(t => t.soup && o.from.some(f => f[0] === t.from[0] && f[1] === t.from[1])).map(t => t.soup);
  const nt = trunks.reduce((a, s) => a + s.length, 0);
  return { solids: o.soup.slice(0, n), trunks: o.soup.slice(n, n + nt), pads: o.soup.slice(n + nt), trunkSoups: trunks };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const arc = await loadArc();
  const coupon = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
  const t0 = Date.now();
  const b = await EXP.build(arc), b0 = await EXP.build(arc, { trunkGrowth: false });
  const c1 = await EXP.build(coupon), c0 = await EXP.build(coupon, { trunkGrowth: false });
  console.log(`built the arc and the coupon with and without trunks in ${Date.now() - t0} ms; ` +
    `trunk law: ${TRUNK.tipMm} mm at the top, ${TRUNK.angleDeg} deg; flare ${TRUNK.flareAngleDeg} deg more over ${TRUNK.flareMm} mm; pad = base + ${FEET.trunkGrowMm} mm (was ${FEET.growMm} at supports-foot)`);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. Bambu\'s trunk (tree slim, the fixture\'s G-code) ===');
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(BAMBU)));
  const gcode = new TextDecoder().decode(await zip.read('Metadata/plate_1.gcode'));
  const B = bambuTrunk(gcode), top = B.rows[B.rows.length - 1];
  check('Bambu\'s trunk found: one round column from its second layer up, over one first-layer ring',
    B.rows.length >= 20 && top.z > 10,
    `axis ${B.rows[0].c.map(f2).join(', ')}, z ${f2(B.rows[0].z)} - ${f2(top.z)} (${B.rows.length} layers; above: ${B.ended}), ` +
    `${f2(B.rows[0].d)} mm at the bottom, ${f2(top.d)} at the top; first layer ${f2(B.padD)} mm across, ${B.padAreaMm2.toFixed(1)} mm2`);
  const at = z => B.rows.reduce((a, r) => Math.abs(r.z - z) < Math.abs(a.z - z) ? r : a, B.rows[0]);
  console.log('        Bambu, mm across by z:  ' + [0.5, 1, 2, 3, 4, 5, 10, 15, 20, 25].map(z => `${f2(at(z).z)}: ${f2(at(z).d)}`).join(' | '));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. NSO\'s trunks on the arc, against Bambu\'s ===');
  const T = b.sf.trunks.filter(t => t.soup);
  check('every trunk on the arc is built: a round trunk on each foot', T.length >= 1 && T.length === b.sf.trunks.length,
    T.map(t => `[${t.c.map(f2).join(', ')}] H ${f2(t.H)}, to z ${f2(t.top)}${t.narrowed ? ' (narrowed)' : ''}`).join('; '));
  const short = [], rows = [];
  let margin = Infinity;
  B.rows.forEach(r => {
    const ds = T.map(t => r.z < t.top - 1e-6 ? diameterAt(t.soup, t.c, r.z) : null);
    ds.forEach((d, i) => { if (d != null) { margin = Math.min(margin, d - r.d); if (d < r.d) short.push(`trunk ${i + 1} at z ${f2(r.z)}: ${f2(d)} < ${f2(r.d)}`); } });
    if (!ds.some(d => d != null)) short.push(`z ${f2(r.z)}: no trunk of ours`);
    rows.push({ z: r.z, bambu: r.d, ours: ds });
  });
  check('at every z of Bambu\'s trunk, every NSO trunk standing there is at least as wide as Bambu\'s, and one stands there',
    !short.length, short.length ? short.slice(0, 6).join('; ') : `${B.rows.length} layers, z ${f2(B.rows[0].z)} - ${f2(top.z)}; least margin ${f3(margin)} mm`);
  console.log('        mm across by z (Bambu | ours, trunk by trunk):\n          ' +
    rows.filter((r, i) => i % 8 === 0 || i === rows.length - 1).map(r => `${f2(r.z)}: ${f2(r.bambu)} | ${r.ours.map(d => d == null ? '-' : f2(d)).join(' ')}`).join('\n          '));
  const ta = Math.tan(TRUNK.angleDeg * Math.PI / 180);
  const need = Math.max(...B.rows.filter(r => r.z >= TRUNK.flareMm).map(r => Math.atan((r.d - TRUNK.tipMm) / 2 / (T[0].H - r.z)) * 180 / Math.PI));
  console.log(`        the angle: ${TRUNK.angleDeg} deg (tan ${f3(ta)}, ${f3(2 * ta)} mm across per mm); Bambu's trunk above ${TRUNK.flareMm} mm, ` +
    `read against a ${TRUNK.tipMm} mm top at H ${f2(T[0].H)}, needs ${f2(need)} deg (its own setting: 5)`);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the flare ===');
  {
    const bad = [];
    T.forEach((t, i) => {
      const zs = []; for (let z = 0.3; z <= TRUNK.flareMm + 2; z += 0.2) zs.push(z);
      const d = zs.map(z => diameterAt(t.soup, t.c, z));
      for (let k = 1; k < zs.length; k++) {
        const below = zs[k] <= TRUNK.flareMm, rate = (d[k - 1] - d[k]) / (zs[k] - zs[k - 1]) / 2;
        if (!(d[k] < d[k - 1] - 1e-6)) bad.push(`trunk ${i + 1} not narrower at ${f2(zs[k])}`);
        else if (below && !(rate > ta + 1e-6)) bad.push(`trunk ${i + 1} at ${f2(zs[k])}: ${f3(rate)} mm a mm`);
      }
    });
    check(`over the bottom ${TRUNK.flareMm} mm every trunk widens going down, faster than above it: a cone onto its pad`, !bad.length,
      bad.length ? bad.slice(0, 4).join('; ') : T.map(t => `${f2(diameterAt(t.soup, t.c, 0.3))} at z 0.3, ${f2(diameterAt(t.soup, t.c, TRUNK.flareMm + 0.2))} at ${f2(TRUNK.flareMm + 0.2)}`).join('; '));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the pad ===');
  const P = TH.prepare(arc, {});
  {
    const pads = b.sf.padOutlines;
    check('one pad under the arc\'s trunks (their pads touch), and one support', pads.length === 1 && b.sf.objects.length === 1, b.sf.reason);
    const outs = [], cut = [], less = [];
    let worst = Infinity;
    T.forEach((t, i) => {
      const pd = pads.find(q => q.from.some(f => f[0] === t.from[0] && f[1] === t.from[1]));
      if (!pd) { outs.push(`trunk ${i + 1} on no pad`); return; }
      const rb = t.rings[0][1];
      for (let k = 0; k < 72; k++) {
        const a = 2 * Math.PI * k / 72, r = reach(pd.poly, t.c, a);
        if (r < rb) outs.push(`trunk ${i + 1} at ${k * 5} deg: base ${f2(rb)}, pad ${f2(r)}`);
        const h = P.hitsAlong([t.c[0], t.c[1], 0.1], [Math.cos(a), Math.sin(a), 0], 40), piece = h.length ? h[0] : Infinity;
        if (piece - FEET.gapMm - 0.4 < rb + FEET.trunkGrowMm) { cut.push(k); continue; }
        worst = Math.min(worst, r - rb);
        if (r < rb + FEET.trunkGrowMm - 0.15) less.push(`trunk ${i + 1} at ${k * 5} deg: ${f2(r - rb)} past the base`);
      }
      if (!(pd.areaMm2 >= B.padAreaMm2)) less.push(`trunk ${i + 1}'s pad ${pd.areaMm2.toFixed(1)} mm2`);
    });
    check('every trunk\'s flared base lies inside its pad (no step from trunk to pad)', !outs.length, outs.length ? outs.slice(0, 4).join('; ') : `${T.length} bases, 72 directions each`);
    check(`each pad reaches its trunk's base plus ${FEET.trunkGrowMm} mm wherever the piece does not cut it short, and covers at least Bambu's first layer`,
      !less.length, (less.length ? less.slice(0, 4).join('; ') + '; ' : '') +
      `least ${f2(worst)} mm past the base (${cut.length} of ${72 * T.length} directions cut short by the piece); pad ${pads.map(q => q.areaMm2.toFixed(1)).join(', ')} mm2 against Bambu's ${B.padAreaMm2.toFixed(1)} mm2 (${f2(B.padD)} mm across)`);
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the gap ===');
  {
    let dmin = Infinity, where = null;
    for (const t of T.concat(c1.sf.trunks.filter(x => x.soup))) {
      const piece = T.includes(t) ? arc : coupon, d = SI.exactDistance(t.soup, piece, { reach: 1 });
      if (d.mm < dmin) { dmin = d.mm; where = d.at; }
    }
    check(`every trunk keeps at least ${FEET.gapMm} mm off the piece (exact triangle distance), on the arc and the coupon`, dmin >= FEET.gapMm - 1e-6,
      `${f3(dmin)} mm${where ? ' at ' + where.map(f2).join(', ') : ''} (built to keep ${TRUNK.keepMm})`);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. nothing above the trunk changes ===');
  for (const [name, on, off] of [['arc', b, b0], ['coupon', c1, c0]]) {
    const o0 = off.objects[1];
    check(`${name}: built with trunkGrowth off, the support is ${name === 'arc' ? 'supports-thinning\'s' : '#265\'s'} byte for byte`,
      off.objects.length === 2 && sha(o0.soup) === BEFORE[name][0] && o0.soup.length / 9 === BEFORE[name][1], `${sha(o0.soup)} (${o0.soup.length / 9} tris)`);
    const s1 = splitObject(on, 0), s0 = splitObject(off, 0);
    if (name === 'coupon') {
      check(`${name}: with trunks, every part before is there byte for byte, then the trunks, then the pads - and nothing else`,
        on.sf.objects.length === off.sf.objects.length && sha(s1.solids) === sha(s0.solids) && s1.solids.length === s0.solids.length && s1.trunks.length > 0 &&
        s1.trunkSoups.length === on.sf.trunks.filter(t => t.soup).length,
        `${s1.solids.length / 9} tris as before (${sha(s1.solids)}), ${s1.trunkSoups.length} trunk(s) ${s1.trunks.length / 9} tris, pads ${s0.pads.length / 9} -> ${s1.pads.length / 9} tris`);
    } else {
      /* the arc: a stair's trunk is a closed shell that stands by itself, so with trunks on, the landing member
         under it (a square column inside it, a second shell) is not built: what is left of the parts before is
         theirs byte for byte - the build's tail - and what is gone is nothing but those columns */
      const cut = s0.solids.length - s1.solids.length, tail = s0.solids.slice(cut);
      check(`${name}: with trunks, the parts before are there byte for byte but for the landing members inside the trunks (no second shell in a trunk), then the trunks, then the pads`,
        on.sf.objects.length === off.sf.objects.length && cut > 0 && sha(tail) === sha(s1.solids) && s1.trunks.length > 0 &&
        s1.trunkSoups.length === on.sf.trunks.filter(t => t.soup).length,
        `${s1.solids.length / 9} tris as before (${sha(s1.solids)}), ${cut / 9} tris of landing member left out, ${s1.trunkSoups.length} trunk(s) ${s1.trunks.length / 9} tris, pads ${s0.pads.length / 9} -> ${s1.pads.length / 9} tris`);
    }
  }
  {
    /* #274's pads (its 4 mm margin) drawn beside the new: the same trunks and the same raster, the margin alone differs */
    const old274 = GP.shareFeet(c1.areas.map(a => ({ solids: a.sh.solids })), coupon, { plateZ: c1.areas[0].p.plateZ, trunkPadMm: FEET.growMm });
    const n = c1.sf.padOutlines, o = old274.padOutlines, bad = [];
    check('the coupon with #274\'s margin is #274\'s build: its pad 578.3 -> 695.7 mm2 over the same trunks',
      old274.ok && o.length === 1 && Math.abs(o[0].areaMm2 - 695.71) < 0.05 && old274.trunks.length === c1.sf.trunks.length &&
      old274.trunks.every((t, i) => !t.soup === !c1.sf.trunks[i].soup && (!t.soup || sha(t.soup) === sha(c1.sf.trunks[i].soup))), o.map(q => q.areaMm2.toFixed(1)).join(', '));
    /* pads smaller by the margin change only: every corner of the new outline inside the old (a cell's slack), and
       each trunk's base grown by the new margin inside the new outline wherever the piece does not cut it short */
    const cellTol = 0.11;
    n.forEach((pd, i) => {
      const old = o.find(q => q.from.some(f => pd.from.some(g => g[0] === f[0] && g[1] === f[1])));
      if (!old) { bad.push(`pad ${i + 1}: no old pad`); return; }
      const outside = pd.poly.filter(q => !inPoly(q, old.poly) && Math.min(...old.poly.map((a, k) => segDist(q, a, old.poly[(k + 1) % old.poly.length]))) > cellTol);
      if (outside.length) bad.push(`pad ${i + 1}: ${outside.length} corners outside #274's`);
    });
    const Pc = TH.prepare(coupon, {});
    let short = 0, tried = 0;
    c1.sf.trunks.filter(t => t.soup).forEach(t => {
      const pd = n.find(q => q.from.some(f => f[0] === t.from[0] && f[1] === t.from[1]));
      const rb = t.rings[0][1];
      for (let k = 0; k < 36; k++) {
        const a = 2 * Math.PI * k / 36, h = Pc.hitsAlong([t.c[0], t.c[1], 0.1], [Math.cos(a), Math.sin(a), 0], 40), piece = h.length ? h[0] : Infinity;
        if (piece - FEET.gapMm - 0.4 < rb + FEET.trunkGrowMm) continue;
        tried++;
        if (!pd || reach(pd.poly, t.c, a) < rb + FEET.trunkGrowMm - 0.15) short++;
      }
    });
    check(`the coupon's pads are smaller by the margin change only: inside #274's, and each trunk's base plus ${FEET.trunkGrowMm} mm inside them where the piece does not cut it`,
      !bad.length && !short && n.length === o.length && n[0].areaMm2 < o[0].areaMm2, (bad.length ? bad.join('; ') + '; ' : '') +
      `${o.map(q => q.areaMm2.toFixed(1)).join(', ')} -> ${n.map(q => q.areaMm2.toFixed(1)).join(', ')} mm2, ${short} of ${tried} directions short of the margin`);
    const ct = c1.sf.trunks;
    console.log('        the coupon\'s trunks: ' + ct.map(t => `[${t.c.map(v => v.toFixed(1)).join(',')}] ${t.rings ? f2(2 * t.rings[0][1]) + ' mm to z ' + f2(t.top) : t.why}`).join('; '));
  }

  /* ---------------------------------------------------------------- export */
  const file = path.join(OUT, 'simple_overhang_supports.3mf');
  const objects = b.objects.map((o, i) => i === 0 ? Object.assign({}, o, { name: 'simple_overhang' })
    : Object.assign({}, o, { name: o.name.replace(/^top_clip_x2/, 'simple_overhang') }));
  await EXP.write(file, objects);
  {
    const z2 = R3.openZip(new Uint8Array(fs.readFileSync(file))), dec = new TextDecoder();
    const model = dec.decode(await z2.read('3D/3dmodel.model'));
    const ms = z2.names().includes('Metadata/model_settings.config') ? dec.decode(await z2.read('Metadata/model_settings.config')) : '';
    const keys = { wall_generator: 'classic', detect_thin_wall: '1', sparse_infill_density: '0%', wall_loops: '1' };
    const tw = Object.keys(keys).map(k => (ms.match(new RegExp('key="' + k + '" value="' + keys[k] + '"', 'g')) || []).length);
    check('the export is a Bambu project: Studio\'s envelope, each support with its four overrides (classic walls, thin walls, no sparse infill, one wall loop)',
      /<metadata name="Application">BambuStudio-[\d.]+<\/metadata>/.test(model) && tw.every(c => c === objects.length - 1),
      `${(model.match(/BambuStudio-[\d.]+/) || ['no Studio tag'])[0]}; ${Object.keys(keys).map((k, i) => k + ' on ' + tw[i]).join(', ')} of ${objects.length - 1} support(s)`);
  }
  console.log('\n  wrote ' + path.relative(ROOT, file) + ' (open it in Bambu Studio as a PROJECT, its own supports off)');

  console.log('\n' + (fail ? 'FAILED  ' : 'PASSED  ') + pass + ' of ' + (pass + fail) + (fail ? '\n  ' + FAILS.join('\n  ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

#!/usr/bin/env node
// Headless self-test for nso_surftex.js / nso_surftex_presets.js (Wrap: one feature - ball, spike, pyramid, bump, dent, line - laid over a
// plane, cylinder, tube, sphere or contoured face). docs/SURFTEX.md.
//
//   node tools/nso_surftex_test.js        exit 0 = every gate held
//
// The pieces are tools/nso_surftex_fixtures.js (closed, known in closed form). Every result is judged by the app's own checker
// (NSO_Repair.js + nso-defects.js in a vm): as closed as the piece was, nothing turned, nothing degenerate - and then by what it should BE:
// the volume a pyramid / ball / dent adds or takes, the reach of a spike from the axis, the number of features a lattice puts on a face.
//
//   1. a flat face, all six features, grid and hex: closed, and the volume is the features' own
//   2. a cylinder: it wraps (a whole number of columns, the seam closed), spikes reach R + height exactly
//   3. a tube: the OUTSIDE wraps outward, the BORE wraps inward (a spike in a bore points at the axis, a dent goes into the wall)
//   4. a sphere: closed, spikes reach R + height, the far pole is left plain
//   5. a contoured face (a free-form heightfield): closed, features stand off it by their height along its own normal
//   6. every preset (the designs of the two plates) wraps its own kind of face; Soft Spikes and the Ribbed Roller reproduce the designs'
//      feature counts and reach on a bare roller
//   7. spacing, density, height, depth, size, rotation and layout do what they say; features never overlap (shrunk to touch, and said)
//   8. the rim is held: every corner of the face's outline is the mesh's own coordinate bit for bit; the soup handed in is not touched;
//      several faces at once
//   9. refusals in words
'use strict';

const ST = require('../nso_surftex.js');
require('../nso_surftex_presets.js');
const fx = require('./nso_surftex_fixtures.js');
const vm = require('vm'), fs = require('fs'), path = require('path');

let fails = 0;
function gate(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const sb = { window: {} };
vm.createContext(sb);
for (const f of ['NSO_Repair.js', 'nso-defects.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f });
const check = (soup) => { const r = sb.window.NSO_Defects.locate(soup, {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris }; };
const clean = (c) => c.open === 0 && c.nm === 0 && c.odd === 0 && c.flip === 0 && c.degen === 0;
const fingerprint = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a; };
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  return v / 6;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1), f3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
function run(soup, pickFn, params, label) {
  const reg = ST.regions(soup, {});
  const pk = reg.list.filter(pickFn);
  if (!pk.length) return { ok: false, reason: 'no such face (' + reg.list.map((r) => r.fit.kind).join(',') + ')' };
  return ST.apply(soup, reg, [pk[0]], params);
}
const isTop = (r) => r.fit.kind === 'plane' && r.fit.n[2] > 0.9;
const isCylOut = (r) => r.fit.kind === 'cylinder' && !r.fit.concave;
const isBore = (r) => r.fit.kind === 'cylinder' && r.fit.concave;
const isSphere = (r) => r.fit.kind === 'sphere';
const isFree = (r) => r.fit.kind === 'free';
const MOTIFS = {
  pyramid: { motif: 'spike', sides: 4, size: 5, spacing: 5, height: 3 },
  cone: { motif: 'spike', sides: 0, size: 4, spacing: 6, height: 4 },
  ball: { motif: 'ball', size: 4, spacing: 5, height: 2 },
  bump: { motif: 'bump', size: 4, spacing: 5, height: 1.2 },
  dent: { motif: 'dent', size: 4, spacing: 5, depth: 1.2 },
  line: { motif: 'line', size: 1.6, sizeV: 5, spacing: 3, spacingV: 6, height: 1 }
};
const capVol = (a, h) => Math.PI * h * (3 * a * a + h * h) / 6;

// ---- 0. the fixtures are what they say
{
  const ok = [['box', fx.box(80, 60, 10)], ['cyl', fx.cyl(20, 60, 64)], ['tube', fx.tube(20, 12, 40, 64)], ['sphere', fx.uvsphere(22, 64, 32)], ['hills', fx.hills(80, 60, 80, 2.5)]].every(([n, s]) => clean(check(s)));
  gate('0   the fixtures are closed and clean', ok);
  const reg = ST.regions(fx.tube(20, 12, 40, 64), {});
  const kinds = reg.list.map((r) => r.fit.kind + (r.fit.concave ? '(bore)' : '')).sort().join(' ');
  gate('0b  a tube is cut into its outside, its bore and two flat ends, each fitted', /cylinder\(bore\)/.test(kinds) && /cylinder /.test(kinds + ' ') && (kinds.match(/plane/g) || []).length === 2, kinds);
  const hr = ST.regions(fx.hills(80, 60, 80, 2.5), {});
  gate('0c  a heightfield top is a contoured face, the sphere a sphere of R 22', hr.list.some(isFree) && ST.regions(fx.uvsphere(22, 64, 32), {}).list.some((r) => isSphere(r) && near(r.fit.R, 22, 0.05)));
}

// ---- 1. a flat face
{
  const soup = fx.box(80, 60, 10), v0 = volume(soup);
  for (const [name, p] of Object.entries(MOTIFS)) {
    for (const layout of ['grid', 'hex']) {
      const r = run(soup, isTop, Object.assign({ layout }, p));
      if (!r.ok) { gate('1   flat / ' + name + ' / ' + layout, false, r.reason); continue; }
      const c = check(r.soup), dv = volume(r.soup) - v0, n = r.stats.tiles, sc = r.perFace[0].stats.scale;
      let want;
      if (name === 'pyramid') want = n * Math.pow(5 * sc, 2) * 3 / 3;
      else if (name === 'cone') want = n * Math.PI * Math.pow(2 * sc, 2) * 4 / 3;
      else if (name === 'ball') want = n * capVol(2 * sc, 2);
      else if (name === 'dent') want = -n * capVol(2 * sc, 1.2);
      else if (name === 'bump') want = n * Math.PI * 4 * sc * sc * 1.2 * (0.5 - 2 / (3 * Math.PI) * 0 ) * 0 + 0;     // judged below by sign and size
      else want = null;
      let ok = clean(c);
      let detail = n + ' features, volume ' + (dv >= 0 ? '+' : '') + f1(dv);
      if (name === 'pyramid' || name === 'cone') { ok = ok && near(dv, want, (name === 'cone' ? 0.08 : 0.03) * Math.abs(want) + 0.5); detail += ' (pyramids / cones say ' + f1(want) + '; a round foot is a 16-gon here)'; }
      else if (name === 'ball') { ok = ok && near(dv, want, 0.09 * want); detail += ' (caps say ' + f1(want) + ')'; }
      else if (name === 'dent') { ok = ok && near(dv, want, 0.09 * Math.abs(want)); detail += ' (caps say ' + f1(want) + ')'; }
      else if (name === 'bump') { ok = ok && dv > 0 && dv < n * Math.PI * 4 * 1.2; }
      else { ok = ok && dv > 0; }
      ok = ok && n > 100;
      gate('1   flat / ' + name + ' / ' + layout + ': closed, the volume is the features’', ok, detail);
    }
  }
}

// ---- 2. a cylinder
{
  const R = 20, H = 60, soup = fx.cyl(R, H, 64), v0 = volume(soup);
  const r = run(soup, isCylOut, { motif: 'spike', sides: 4, size: 8, spacing: 8, spacingV: 9, height: 4 });
  if (!r.ok) gate('2   cylinder wraps', false, r.reason);
  else {
    const c = check(r.soup), st = r.perFace[0].stats;
    let rmax = 0;
    for (let i = 0; i < r.soup.length; i += 3) rmax = Math.max(rmax, Math.hypot(r.soup[i], r.soup[i + 1]));
    gate('2a  closed and clean; the seam is not a seam', clean(c) && st.periodic, JSON.stringify(c));
    gate('2b  spikes reach R + height from the axis (' + f3(rmax) + ' against ' + (R + 4) + ')', near(rmax, R + 4, 1e-3));
    gate('2c  a whole number of columns: pitch snapped 8 -> ' + f3(st.px) + ' (2πR / ' + Math.round(2 * Math.PI * R / st.px) + ')', near(Math.round(2 * Math.PI * R / st.px) * st.px, 2 * Math.PI * R, 1e-6) && st.px <= 8.0001);
    gate('2d  the ends keep their planes: the caps are the mesh’s own (' + st.rimCorners + ' rim corners held)', st.rimCorners === 128);
    // the cylinder, every motif
    for (const [name, p] of Object.entries(MOTIFS)) {
      const q = run(soup, isCylOut, Object.assign({ layout: 'hex' }, p));
      gate('2e  cylinder / ' + name + ' / hex: closed', q.ok && clean(check(q.soup)), q.ok ? q.stats.tiles + ' features' : q.reason);
    }
    // a lying cylinder wraps the same
    const lying = new Float32Array(soup.length);
    for (let i = 0; i < soup.length; i += 3) { lying[i] = soup[i + 2] - 30; lying[i + 1] = soup[i + 1]; lying[i + 2] = -soup[i] + 20; }
    const q2 = run(lying, isCylOut, { motif: 'spike', sides: 4, size: 8, spacing: 8, spacingV: 9, height: 4 });
    gate('2f  a cylinder lying on its side wraps just the same', q2.ok && clean(check(q2.soup)) && q2.stats.tiles === r.stats.tiles, q2.ok ? q2.stats.tiles + ' features' : q2.reason);
  }
}

// ---- 3. a tube: outside and bore
{
  const Ro = 20, Ri = 12, soup = fx.tube(Ro, Ri, 40, 64);
  const out = run(soup, isCylOut, { motif: 'ball', size: 4, spacing: 5, height: 2, layout: 'hex' });
  const bore = run(soup, isBore, { motif: 'spike', sides: 4, size: 4, spacing: 4.4, spacingV: 4.4, height: 3 });
  if (!out.ok || !bore.ok) gate('3   tube', false, (out.reason || '') + (bore.reason || ''));
  else {
    let rmaxO = 0, rminB = Infinity;
    for (let i = 0; i < out.soup.length; i += 3) rmaxO = Math.max(rmaxO, Math.hypot(out.soup[i], out.soup[i + 1]));
    for (let i = 0; i < bore.soup.length; i += 3) rminB = Math.min(rminB, Math.hypot(bore.soup[i], bore.soup[i + 1]));
    gate('3a  the outside wraps outward: balls stand ' + f3(rmaxO - Ro) + ' proud', clean(check(out.soup)) && near(rmaxO, Ro + 2, 5e-3));
    gate('3b  the bore wraps INWARD: spikes point at the axis (' + f3(rminB) + ' against ' + (Ri - 3) + '), closed', clean(check(bore.soup)) && near(rminB, Ri - 3, 5e-3));
    const dent = run(soup, isBore, { motif: 'dent', size: 4, spacing: 5, depth: 1.2, layout: 'hex' });
    let rmaxD = 0;
    for (let i = 0; i < dent.soup.length; i += 3) { const rr = Math.hypot(dent.soup[i], dent.soup[i + 1]); if (rr > 12.5 && rr < 15) rmaxD = Math.max(rmaxD, rr); }
    gate('3c  a dent in the bore goes into the wall (radius ' + f3(rmaxD) + ' = bore ' + Ri + ' + depth)', dent.ok && clean(check(dent.soup)) && near(rmaxD, Ri + 1.2, 5e-3));
    gate('3d  the wraps of the outside and the bore together, one call: closed', (() => { const reg = ST.regions(soup, {}); const r = ST.apply(soup, reg, reg.list.filter((x) => x.fit.kind === 'cylinder'), { motif: 'bump', size: 4, spacing: 5, height: 1 }); return r.ok && clean(check(r.soup)) && r.perFace.length === 2; })());
  }
}

// ---- 4. a sphere
{
  const R = 22, soup = fx.uvsphere(R, 64, 32);
  const r = run(soup, isSphere, { motif: 'spike', sides: 0, size: 4, spacing: 5, height: 3.5, layout: 'hex' });
  if (!r.ok) gate('4   sphere', false, r.reason);
  else {
    let rmax = 0, zlo = Infinity;
    for (let i = 0; i < r.soup.length; i += 3) rmax = Math.max(rmax, Math.hypot(r.soup[i], r.soup[i + 1], r.soup[i + 2]));
    gate('4a  closed and clean', clean(check(r.soup)), r.stats.tiles + ' spikes');
    gate('4b  spikes reach R + height (' + f3(rmax) + ' against ' + (R + 3.5) + ')', near(rmax, R + 3.5, 5e-3));
    // the far pole: no vertex stands off the sphere within 166 degrees of the pole's own axis
    let high = 0;
    for (let i = 0; i < r.soup.length; i += 3) { const x = r.soup[i], y = r.soup[i + 1], z = r.soup[i + 2], rr = Math.hypot(x, y, z); if (rr > R + 0.05 && Math.acos(z / rr) > 166 * Math.PI / 180) high++; }
    gate('4c  the far pole is left plain (the outline the wrap is held at)', high === 0 && /14/.test((r.perFace[0].stats.notes || []).join(' ')), high + ' vertices off the sphere in the cap');
    for (const [name, p] of Object.entries(MOTIFS)) {
      const q = run(soup, isSphere, Object.assign({ layout: 'hex' }, p));
      gate('4d  sphere / ' + name + ': closed', q.ok && clean(check(q.soup)), q.ok ? q.stats.tiles + ' features' : q.reason);
    }
    // a dome (a cap): wraps from its own pole
    const cap = ST.regions(soup, {});
    const dome = (() => { // keep z >= 0 of the sphere + flat base is not a closed fixture here; use a sphere cut by the mask instead
      return true;
    })();
    gate('4e  a sphere’s dent goes in by its depth', (() => { const q = run(soup, isSphere, { motif: 'dent', size: 4, spacing: 5, depth: 1.2, layout: 'hex' }); let rmin = Infinity; for (let i = 0; i < q.soup.length; i += 3) rmin = Math.min(rmin, Math.hypot(q.soup[i], q.soup[i + 1], q.soup[i + 2])); return q.ok && clean(check(q.soup)) && near(rmin, R - 1.2, 5e-3); })());
  }
}

// ---- 5. a contoured face
{
  const soup = fx.hills(80, 60, 80, 2.5), v0 = volume(soup);
  const reg = ST.regions(soup, {}), face = reg.list.filter(isFree)[0];
  for (const [name, p] of Object.entries(MOTIFS)) {
    const r = ST.apply(soup, reg, [face], Object.assign({ layout: 'hex' }, p));
    const dv = r.ok ? volume(r.soup) - v0 : 0;
    const sign = name === 'dent' ? dv < 0 : dv > 0;
    gate('5   contoured / ' + name + ': closed, the volume goes the right way', r.ok && clean(check(r.soup)) && sign, r.ok ? r.stats.tiles + ' features, ' + (dv >= 0 ? '+' : '') + f1(dv) : r.reason);
  }
  // spikes stand off the face by their height along the face's own normal
  const r = ST.apply(soup, reg, [face], { motif: 'spike', sides: 4, size: 4, spacing: 5, height: 3 });
  let worst = 0, tips = 0;
  const Z = (x, y) => 6 + 2.5 * Math.sin(x / 9) * Math.cos(y / 11) + 2.5 * 0.4 * Math.sin((x + y) / 5);
  for (let i = 0; i < r.soup.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const x = r.soup[i + 3 * k], y = r.soup[i + 3 * k + 1], z = r.soup[i + 3 * k + 2];
      if (z < 1) continue;
      worst = Math.max(worst, z - Z(x, y));
    }
  }
  gate('5b  the tips stand about their height (3 mm) over the face (highest ' + f3(worst) + ' mm over it, the face leaning 20° at most)', worst > 2.9 && worst < 3.4);
}

// ---- 6. the presets
{
  const P = ST.PRESETS;
  gate('6   every design of the two plates has a skin, and the single features are there', ['soft-spikes', 'ribbed-roller', 'medium-point-roller', 'spiked-dome', 'massage-balls', 'pad-dimples', 'pad-slashes', 'pad-dashes', 'pad-ribs', 'pad-waves', 'spikefoot', 'spikefoot-tall', 'one-ball', 'one-spike', 'one-pyramid', 'one-bump', 'one-dent', 'one-line'].every((id) => ST.preset(id)), P.length + ' presets');
  const roller = () => fx.tube(20, 7.5, 95, 72);
  for (const [id, wantTiles, wantReach] of [['soft-spikes', 70, 29.0], ['ribbed-roller', 140, 25.35]]) {
    const r = run(roller(), isCylOut, ST.preset(id).params);
    let rmax = 0;
    if (r.ok) for (let i = 0; i < r.soup.length; i += 3) rmax = Math.max(rmax, Math.hypot(r.soup[i], r.soup[i + 1]));
    gate('6a  ' + id + ' on a bare roller: ' + (r.ok ? r.stats.tiles : '-') + ' features (the design has ' + wantTiles + '), reach ' + f3(rmax) + ' (the design: ' + wantReach + ')', r.ok && clean(check(r.soup)) && r.stats.tiles === wantTiles && near(rmax, wantReach, 0.01));
  }
  const faces = {
    cylinder: [fx.tube(20, 7.5, 95, 72), isCylOut], tube: [fx.tube(20, 12, 60, 72), isBore], sphere: [fx.uvsphere(22.5, 72, 36), isSphere],
    plane: [fx.box(120, 90, 10), isTop], contoured: [fx.hills(120, 90, 90, 2.5), isFree]
  };
  const kindsFor = (p) => /cylinder/.test(p.faces) ? ['cylinder', 'tube'] : /sphere/.test(p.faces) ? ['sphere'] : /contoured/.test(p.faces) ? ['plane', 'contoured'] : ['plane'];
  for (const p of P) {
    for (const kind of kindsFor(p)) {
      const [soup, pick] = faces[kind];
      const r = run(soup, pick, p.params);
      gate('6b  preset ' + p.id + ' on a ' + kind + ' face: closed', r.ok && clean(check(r.soup)), r.ok ? r.stats.tiles + ' features' : r.reason);
    }
  }
  // any skin goes on any kind of face: the cylinder designs on a sphere and a contoured face, the dome's on a cylinder
  for (const [id, kind] of [['soft-spikes', 'sphere'], ['soft-spikes', 'contoured'], ['spikefoot', 'cylinder'], ['massage-balls', 'cylinder'], ['pad-dimples', 'sphere'], ['pad-slashes', 'contoured']]) {
    const [soup, pick] = faces[kind], r = run(soup, pick, ST.preset(id).params);
    gate('6c  ' + id + ' on a ' + kind + ' face (not its own kind): closed', r.ok && clean(check(r.soup)), r.ok ? r.stats.tiles + ' features' : r.reason);
  }
}

// ---- 7. the numbers do what they say
{
  const soup = fx.box(100, 100, 10), v0 = volume(soup), base = { motif: 'spike', sides: 4, size: 3, spacing: 6, height: 2 };
  const n = (p) => { const r = run(soup, isTop, Object.assign({}, base, p)); return r.ok ? r.stats.tiles : -1; };
  const a = n({ spacing: 6 }), b = n({ spacing: 12 });
  gate('7a  twice the spacing = a quarter of the features (' + a + ' -> ' + b + ')', near(a / b, 4, 0.9));
  const d1 = n({ density: 4, spacing: 99 }), d2 = n({ density: 16, spacing: 99 });
  gate('7b  density sets the spacing: 4 -> 16 per cm² gives four times the features (' + d1 + ' -> ' + d2 + ')', near(d2 / d1, 4, 0.6) && near(d1, 4 * 0.97 * 0.97 * 100, 60));
  const vh = (h) => { const r = run(soup, isTop, Object.assign({}, base, { height: h })); return volume(r.soup) - v0; };
  gate('7c  height scales the volume: 1 mm -> 3 mm is three times as much', near(vh(3) / vh(1), 3, 0.03));
  const vd = (d) => { const r = run(soup, isTop, { motif: 'dent', size: 3, spacing: 6, depth: d }); return v0 - volume(r.soup); };
  gate('7d  depth: a deeper dent takes more (0.5 -> 1.2 mm)', vd(1.2) > vd(0.5) * 1.5 && vd(0.5) > 0);
  const big = run(soup, isTop, { motif: 'ball', size: 9, spacing: 5, height: 2 });
  gate('7e  features that would overlap are shrunk together until they touch, and it says so', big.ok && clean(check(big.soup)) && big.perFace[0].stats.scale < 0.6 && /scaled to/.test(big.perFace[0].stats.notes.join(' ')), big.ok ? 'scale ' + f3(big.perFace[0].stats.scale) : big.reason);
  const rot0 = run(soup, isTop, Object.assign({}, base, { rot: 0 })), rot45 = run(soup, isTop, Object.assign({}, base, { rot: 45, size: 2.5 }));
  gate('7f  rotation turns the features (closed)', rot45.ok && clean(check(rot45.soup)) && rot0.ok);
  const ang = run(soup, isTop, Object.assign({}, base, { angle: 30 }));
  gate('7g  the lattice turns (angle 30): closed', ang.ok && clean(check(ang.soup)), ang.ok ? ang.stats.tiles + ' features' : ang.reason);
  const dia = run(soup, isTop, { motif: 'spike', sides: 4, size: 5, spacing: 6, spacingV: 6, rot: 45, layout: 'diamond', height: 2 });
  gate('7h  diamond layout (a rotated square on a centred lattice): closed', dia.ok && clean(check(dia.soup)), dia.ok ? dia.stats.tiles + ' features' : dia.reason);
  const groove = run(soup, isTop, { motif: 'line', ridge: false, profile: 'round', size: 2, depth: 1, spacing: 5, spacingV: 10 }), ridge = run(soup, isTop, { motif: 'line', ridge: true, profile: 'flat', size: 2, height: 1, spacing: 5 });
  gate('7i  a line: a groove takes volume, a ridge adds it; they run end to end when the length is the row pitch', groove.ok && ridge.ok && volume(groove.soup) < v0 && volume(ridge.soup) > v0 && clean(check(groove.soup)) && clean(check(ridge.soup)));
  const tri = run(soup, isTop, { motif: 'spike', sides: 3, size: 4, spacing: 6, height: 2 }), hexp = run(soup, isTop, { motif: 'spike', sides: 6, size: 3, spacing: 6, height: 2 });
  gate('7j  three- and six-sided pyramids: closed', tri.ok && hexp.ok && clean(check(tri.soup)) && clean(check(hexp.soup)));
}

// ---- 8. the rim is held
{
  const soup = fx.cyl(20, 60, 64), before = fingerprint(soup);
  const reg = ST.regions(soup, {}), side = reg.list.filter(isCylOut)[0];
  const r = ST.apply(soup, reg, [side], { motif: 'ball', size: 4, spacing: 6, height: 2 });
  gate('8a  the soup handed in is not touched', fingerprint(soup) === before);
  // every corner of the two rims is still a corner of the result, to the bit
  const have = new Set();
  for (let i = 0; i < r.soup.length; i += 3) have.add(r.soup[i] + ',' + r.soup[i + 1] + ',' + r.soup[i + 2]);
  let held = 0, rim = 0;
  for (let i = 0; i < soup.length; i += 9) for (let k = 0; k < 3; k++) {
    const x = soup[i + 3 * k], y = soup[i + 3 * k + 1], z = soup[i + 3 * k + 2];
    if (Math.abs(Math.hypot(x, y) - 20) < 1e-4 && (z === 0 || Math.abs(z - 60) < 1e-4)) { rim++; if (have.has(x + ',' + y + ',' + z)) held++; }
  }
  gate('8b  every rim corner is the mesh’s own coordinate, bit for bit (' + held + ' of ' + rim + ' triangle corners)', rim > 0 && held === rim);
  const box = fx.box(60, 60, 20), br = ST.regions(box, {});
  const all = ST.apply(box, br, br.list, { motif: 'pyramid' === 'x' ? 'x' : 'spike', sides: 4, size: 4, spacing: 5, height: 2 });
  gate('8c  all six faces of a box in one call: closed, the volume is the box’s and the pyramids’', all.ok && clean(check(all.soup)) && all.perFace.length === 6 && volume(all.soup) > volume(box), all.ok ? all.stats.tiles + ' pyramids' : all.reason);
}

// ---- 9. refusals
{
  const soup = fx.box(20, 20, 10);
  const big = run(soup, isTop, { motif: 'ball', size: 30, spacing: 40, height: 5 });
  gate('9a  a feature that fits nowhere is refused in words', !big.ok && /fits whole inside/.test(big.reason), big.reason);
  const many = run(fx.box(400, 400, 10), isTop, { motif: 'spike', sides: 4, size: 0.5, spacing: 0.5, height: 0.3, maxTiles: 1000 });
  gate('9b  more features than the tool will lay is refused, naming the spacing', !many.ok && /spacing|density/.test(many.reason), many.reason);
  const none = ST.apply(soup, ST.regions(soup, {}), [], {});
  gate('9c  no face picked is refused', !none.ok && /no face/.test(none.reason), none.reason);
  const tiny = run(fx.cyl(3, 40, 48), isCylOut, { motif: 'spike', sides: 4, size: 12, spacing: 12, height: 3 });
  gate('9d  a roller too small for the feature is refused or shrunk, never broken', tiny.ok ? clean(check(tiny.soup)) : /fit|small|spacing/.test(tiny.reason), tiny.ok ? 'wrapped, scale ' + tiny.perFace[0].stats.scale : tiny.reason);
}

console.log(fails ? '\n' + fails + ' gate(s) failed' : '\nall gates held');
process.exit(fails ? 1 : 0);

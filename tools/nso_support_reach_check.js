#!/usr/bin/env node
/* THE REACH, AGAINST BAMBU'S OWN SLICE (docs/SUPPORT-FOOTPRINT.md section 11).
     node tools/nso_support_reach_check.js              the six reference heads built as a plate at 35 deg
     ANG=30 node tools/nso_support_reach_check.js       at 30
     npm run support:reach

   The question: where Bambu Studio lays its support interface and transition under a head (fixtures/supports/tree_slimsupports.gcode.3mf: its slice of the six
   reference heads), does the card's build hold the same surface? Read the same way for both. The part's down-facing surface is sampled every 0.25 mm (the first
   face from below at each cell, open to the plate), binned by its tilt from flat; a cell is HELD by Bambu when one of its interface or transition lines (dilated 0.5 mm in plan,
   on a layer 0.05 - 1.8 mm under the cell) stands there - Bambu's slice is put on the part by the translation that holds the most of the flat (under 35 deg) cells - and by the card
   when a face of its support lies 0.02 - 1.5 mm under the cell or one within 0.5 mm of it does (the same dilation: a line pitch of 0.5 mm leaves 0.1 mm between lines, and a
   cell centre sampled in one is not bare).

   Gates (the card at 35 deg): on the flat bands (0 - 20 and 20 - 35 deg) the card holds at least what Bambu holds less 12 points, on every head; and where the detector
   (nso_support_beacons.js, footprint on) reports no footprint, the flat surface that Bambu has a line under and the card has none within 0.5 mm of is under 1.5 mm2 on every head - what
   detection leaves out is held by the build or is nothing Bambu holds.
   FINDINGS: the steeper bands, where the two differ in kind (Bambu holds the Negative Spheres' cavity walls in part, the domes' flanks not at all). */
'use strict';
const fs = require('fs');
const path = require('path');
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require('../nso-3mf-read.js');
const lib = require('./nso_support_plate_lib.js');
const SB = require('../nso_support_beacons.js');

const ROOT = lib.ROOT;
const REF = path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
const ANG = +(process.env.ANG || 35), RES = 0.25, DIL = 0.5;
const BINS = [[0, 20], [20, 35], [35, 50], [50, 65], [65, 80]];
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : '')); };
const finding = (name, detail) => console.log('  FINDING ' + name + (detail ? '   ' + detail : ''));

/* the faces a vertical line at (x, y) crosses, low to high: { z, nz } */
function hitsN(soup, x, y) {
  const out = [];
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2], bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5], cx = soup[i + 6], cy = soup[i + 7], cz = soup[i + 8];
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const den = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / den, v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / den;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), L = Math.hypot(nx, ny, nz) || 1;
    out.push({ z: az + u * (bz - az) + v * (cz - az), nz: nz / L });
  }
  return out.sort((a, b) => a.z - b.z);
}
const boundsOf = (soup) => {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let k = 0; k < soup.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], soup[k + a]); hi[a] = Math.max(hi[a], soup[k + a]); }
  return { lo, hi };
};
/* the part's down-facing cells: the first face from below with a normal looking down, a tenth of a mm or more over the plate */
function cellsOf(soup) {
  const { lo, hi } = boundsOf(soup), cells = [];
  for (let x = lo[0] + RES / 2; x < hi[0]; x += RES) for (let y = lo[1] + RES / 2; y < hi[1]; y += RES) {
    const h = hitsN(soup, x, y);
    if (!h.length) continue;
    const f = h[0];
    if (f.nz < -0.05 && f.z > 0.4) cells.push({ x, y, z: f.z, tilt: Math.acos(Math.min(1, -f.nz)) * 180 / Math.PI });
  }
  return { cells, lo, hi };
}
const key = (i, j) => i + ',' + j;
const share = (cs, pred) => cs.length ? 100 * cs.filter(pred).length / cs.length : null;
const fmt = (v) => v === null ? '  -' : v.toFixed(0).padStart(3) + '%';

(async () => {
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF)));
  const gcode = new TextDecoder().decode(await zip.read(zip.names().find(n => /plate_\d+\.gcode$/.test(n))));
  const names = AUDIT.sliceNames(new TextDecoder().decode(await zip.read('Metadata/slice_info.config')));
  const moves = AUDIT.extrusions(gcode);
  const objs = await lib.readFixture(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const app = lib.makeApp();
  const ids = app.load(objs);
  app.openCard();
  app.card.angle(ANG);
  app.setPlateBox(true);
  app.click('btn-sup-all');
  await app.until(() => app.card.busy());
  await app.until(() => !app.card.busy());
  console.log('\n' + app.head() + ' at ' + ANG + ' deg\n');
  console.log('        tilt band (deg)'.padEnd(36) + BINS.map(b => (b[0] + '-' + b[1]).padStart(8)).join(''));

  const rows = {};
  for (let oi = 0; oi < objs.length; oi++) {
    const o = objs[oi], id = Object.keys(names).find(i => names[i] === o.name);
    const lines = moves.filter(m => +m.obj === +id && /^Support (interface|transition)/.test(m.feat || ''));
    const body = Float32Array.from(o.positions);
    const { cells, lo } = cellsOf(body);
    const flat = cells.filter(c => c.tilt <= ANG);
    /* Bambu's lines on the part: the translation that puts most lines' dilation under the flat cells */
    const mid = (a) => { let sx = 0, sy = 0; a.forEach(p => { sx += p[0]; sy += p[1]; }); return [sx / a.length, sy / a.length]; };
    const cb = mid(lines.map(m => [(m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2])), cf = mid(flat.map(c => [c.x, c.y]));
    const r = Math.ceil(DIL / RES);
    let best = null;
    for (let dx = -3; dx <= 3; dx += 0.25) for (let dy = -3; dy <= 3; dy += 0.25) {
      const ox = cf[0] - cb[0] + dx, oy = cf[1] - cb[1] + dy, S = new Map();
      lines.forEach(m => {
        const L = Math.hypot(m.x1 - m.x0, m.y1 - m.y0), n = Math.max(1, Math.ceil(L / (RES / 2)));
        for (let q = 0; q <= n; q++) {
          const ci = Math.round((m.x0 + (m.x1 - m.x0) * q / n + ox) / RES), cj = Math.round((m.y0 + (m.y1 - m.y0) * q / n + oy) / RES);
          for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (Math.hypot(a, b) * RES <= DIL) { const k = key(ci + a, cj + b); if (!S.has(k)) S.set(k, []); S.get(k).push(m.z); }
        }
      });
      const hit = flat.filter(c => (S.get(key(Math.round(c.x / RES), Math.round(c.y / RES))) || []).length).length;
      if (!best || hit > best.hit) best = { hit, S };
    }
    const bam = (c) => (best.S.get(key(Math.round(c.x / RES), Math.round(c.y / RES))) || []).some(z => z < c.z - 0.05 && z > c.z - 1.8);

    /* the card's support, on the part as the card holds it (its own frame: the plate's) */
    const pbody = Float32Array.from(app.soupOf(ids[oi]));
    const sup = Float32Array.from([].concat(...app.supportsOf(ids[oi]).map(m => Array.from(app.soupOf(m.id)))));
    const pc = cellsOf(pbody).cells, heldSet = new Set();
    pc.forEach(c => { if (hitsN(sup, c.x, c.y).some(f => f.z < c.z - 0.02 && f.z > c.z - 1.5)) heldSet.add(key(Math.round(c.x / RES), Math.round(c.y / RES))); });
    const near = (c) => { const ci = Math.round(c.x / RES), cj = Math.round(c.y / RES); for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (Math.hypot(a, b) * RES <= DIL && heldSet.has(key(ci + a, cj + b))) return true; return false; };

    const bandOf = (cs, b) => cs.filter(c => c.tilt >= b[0] && c.tilt < b[1]);
    const bamRow = BINS.map(b => share(bandOf(cells, b), bam)), ourRow = BINS.map(b => share(bandOf(pc, b), near));
    rows[o.name] = { bam: bamRow, our: ourRow };
    console.log('  ' + o.name.replace(/^Support |\.stl$/g, '').padEnd(18) + 'Bambu'.padEnd(16) + bamRow.map(v => fmt(v).padStart(8)).join(''));
    console.log('  ' + ''.padEnd(18) + 'the card'.padEnd(16) + ourRow.map(v => fmt(v).padStart(8)).join(''));

    /* what the detector leaves out that Bambu holds */
    const det = SB.detect(body, { pitch: 3, angleDeg: ANG, skipList: [], footprint: true, seedPitchMm: SB.SEED_PITCH_PRODUCT_MM || 1, insetMm: SB.INSET_PRODUCT_MM || 1 });
    const regs = det.regions.filter(R => R.footprint && R.footprint.loops);
    const inFp = (x, y) => regs.some(R => { let inn = false; for (const L of R.footprint.loops) for (let q = 0, w = L.length - 1; q < L.length; w = q++) if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn; return inn; });
    const pl = boundsOf(pbody).lo, fl = boundsOf(body).lo, off = [pl[0] - fl[0], pl[1] - fl[1]];
    const missed = cells.filter(c => c.tilt < ANG && !inFp(c.x, c.y) && bam(c) && !near({ x: c.x + off[0], y: c.y + off[1] }));
    rows[o.name].missedMm2 = missed.length * RES * RES;
    rows[o.name].flatBam = share(flat, bam);
    void lo;
  }

  console.log('');
  for (const o of objs) {
    const R = rows[o.name], n = o.name.replace(/^Support |\.stl$/g, '');
    [0, 1].forEach(k => {
      if (R.bam[k] === null) return;
      check(n + ', ' + BINS[k][0] + ' - ' + BINS[k][1] + ' deg: the card holds what Bambu holds less 12 points', R.our[k] >= R.bam[k] - 12, 'the card ' + R.our[k].toFixed(0) + ' %, Bambu ' + R.bam[k].toFixed(0) + ' %');
    });
    check(n + ': flat surface outside every footprint that Bambu holds and the card does not: under 1.5 mm2', R.missedMm2 < 1.5, R.missedMm2.toFixed(1) + ' mm2');
  }
  for (const o of objs) {
    const R = rows[o.name];
    finding(o.name.replace(/^Support |\.stl$/g, '') + ', over 35 deg', BINS.slice(2).map((b, k) => b[0] + '-' + b[1] + ': the card ' + fmt(R.our[k + 2]).trim() + ' / Bambu ' + fmt(R.bam[k + 2]).trim()).join(';  '));
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
